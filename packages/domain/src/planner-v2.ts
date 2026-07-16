import {
  MAX_PERSISTED_MONEY_ORE,
  type MatchRule,
  type MoneyOre,
  type Need,
  type PriceObservation,
  type Product,
} from "./contracts";
import {
  calculateCheckoutCost,
  calculatePackageFulfilmentV2,
  type CheckoutCost,
} from "./fulfilment";
import { matchProducts } from "./matching";
import type { OfficialOffer, OfficialOfferEvaluationContext } from "./offers";
import {
  planResultV2Schema,
  serverPlanningInputV2Schema,
  type CheckoutCostV2,
  type PlanAssignmentV2,
  type PlanningNeedV2,
  type PlanningProductV2,
  type PlanResultV2,
  type ServerPlanningInputV2,
} from "./planner-v2-contracts";
import { classifyFreshness } from "./price-eligibility";

type Chain = PriceObservation<string>["chain"];

interface Candidate {
  assignment: PlanAssignmentV2;
}

type OffersByProductChain = ReadonlyMap<string, readonly OfficialOffer[]>;

const CHAIN_ORDER: readonly Chain[] = ["bunnpris", "extra", "rema-1000"];
const chainRank = new Map(CHAIN_ORDER.map((chain, index) => [chain, index]));

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonValue(left[key], right[key]),
    );
}

function compareChains(left: Chain, right: Chain): number {
  return (chainRank.get(left) ?? 0) - (chainRank.get(right) ?? 0);
}

function combinations(chains: readonly Chain[], maximum: number): Chain[][] {
  const result: Chain[][] = [];

  function visit(start: number, current: Chain[]): void {
    if (current.length > 0) result.push([...current]);
    if (current.length === maximum) return;

    for (let index = start; index < chains.length; index += 1) {
      current.push(chains[index]!);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return result;
}

function productChainKey(canonicalProductId: string, chain: string): string {
  return `${canonicalProductId}\u0000${chain}`;
}

function indexOfficialOffers(
  offers: readonly OfficialOffer[],
): OffersByProductChain {
  const indexed = new Map<string, OfficialOffer[]>();
  for (const offer of offers) {
    if (offer.productMatch.kind !== "exact") continue;
    const key = productChainKey(
      offer.productMatch.canonicalProductId,
      offer.chainId,
    );
    const current = indexed.get(key) ?? [];
    current.push(offer);
    indexed.set(key, current);
  }
  for (const values of indexed.values()) {
    values.sort((left, right) => compareText(left.id, right.id));
  }
  return indexed;
}

function toLegacyNeed(need: PlanningNeedV2): Need {
  return {
    id: need.id,
    query: need.query,
    quantity: need.requested.amount,
    quantityUnit:
      need.requested.unit === "g" || need.requested.unit === "ml"
        ? need.requested.unit
        : "each",
    matchRuleId: need.matchRuleId,
    required: true,
  };
}

function toLegacyProduct(product: PlanningProductV2): Product {
  return {
    ean: product.ean,
    name: product.name,
    ...(product.brand === undefined ? {} : { brand: product.brand }),
    packageQuantity: product.packageMeasure.amount,
    packageUnit:
      product.packageMeasure.unit === "g" || product.packageMeasure.unit === "ml"
        ? product.packageMeasure.unit
        : "each",
    ...(product.productFamily === undefined
      ? {}
      : { productFamily: product.productFamily }),
  };
}

function officialOfferReference(offer: OfficialOffer) {
  return {
    id: offer.id,
    sourceId: offer.sourceId,
    sourceRecordId: offer.sourceRecordId,
    capturedAt: offer.capturedAt,
  };
}

function compareCheckoutChoices(
  left: { checkout: CheckoutCost; offer?: OfficialOffer },
  right: { checkout: CheckoutCost; offer?: OfficialOffer },
): number {
  return (
    left.checkout.totalOre - right.checkout.totalOre
    || left.checkout.ordinaryTotalOre - right.checkout.ordinaryTotalOre
    || compareText(left.checkout.appliedOfferId ?? "", right.checkout.appliedOfferId ?? "")
  );
}

function bestCheckout(
  product: PlanningProductV2,
  observation: PriceObservation<string>,
  packageCount: number,
  officialOffers: readonly OfficialOffer[],
  offerContext: OfficialOfferEvaluationContext,
): { checkout: CheckoutCostV2; offer?: OfficialOffer } | undefined {
  const ordinary = calculateCheckoutCost({
    canonicalProductId: product.canonicalProductId,
    chainId: observation.chain,
    packageCount,
    ordinaryUnitPriceOre: observation.amountOre,
    offerContext,
  });
  if ("state" in ordinary) return undefined;

  const choices: Array<{ checkout: CheckoutCost; offer?: OfficialOffer }> = [
    { checkout: ordinary },
  ];
  for (const offer of officialOffers) {
    const checkout = calculateCheckoutCost({
      canonicalProductId: product.canonicalProductId,
      chainId: observation.chain,
      packageCount,
      ordinaryUnitPriceOre: observation.amountOre,
      offer,
      offerContext,
    });
    if (!("state" in checkout) && checkout.appliedOfferId === offer.id) {
      choices.push({ checkout, offer });
    }
  }

  const selected = choices.sort(compareCheckoutChoices)[0];
  if (selected === undefined) return undefined;
  return {
    checkout: selected.checkout,
    ...(selected.offer === undefined ? {} : { offer: selected.offer }),
  };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    left.assignment.costOre - right.assignment.costOre
    || left.assignment.checkout.ordinaryTotalOre - right.assignment.checkout.ordinaryTotalOre
    || compareText(left.assignment.ean, right.assignment.ean)
    || compareChains(left.assignment.chain, right.assignment.chain)
    || compareText(
      left.assignment.checkout.appliedOfferId ?? "",
      right.assignment.checkout.appliedOfferId ?? "",
    )
    || compareText(right.assignment.observedAt, left.assignment.observedAt)
    || compareText(left.assignment.source, right.assignment.source)
  );
}

function assignmentKey(assignment: PlanAssignmentV2): string {
  return [
    assignment.needId,
    assignment.canonicalProductId,
    assignment.ean,
    assignment.chain,
    assignment.costOre,
    assignment.fulfilment.requested.amount,
    assignment.fulfilment.requested.unit,
    assignment.fulfilment.packageMeasure.amount,
    assignment.fulfilment.packageMeasure.unit,
    assignment.fulfilment.packageCount,
    assignment.fulfilment.purchased.amount,
    assignment.fulfilment.purchased.unit,
    assignment.fulfilment.surplus.amount,
    assignment.fulfilment.surplus.unit,
    assignment.checkout.appliedOfferId ?? "ordinary",
  ].join(":");
}

function planIdentity(assignments: readonly PlanAssignmentV2[]): string {
  return assignments.map(assignmentKey).join("|");
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function planForSubset(
  input: ServerPlanningInputV2,
  rulesById: ReadonlyMap<string, MatchRule>,
  eligiblePrices: readonly PriceObservation<string>[],
  offersByProductChain: OffersByProductChain,
  subset: readonly Chain[],
  now: Date,
): PlanResultV2 | undefined {
  const subsetSet = new Set(subset);
  const legacyProducts = input.products.map(toLegacyProduct);
  const productByEan = new Map(input.products.map((product) => [product.ean, product]));
  const assignments: PlanAssignmentV2[] = [];
  const substitutions: string[] = [];
  const freshness: Record<string, "eligible"> = {};
  const offerContext: OfficialOfferEvaluationContext = {
    now,
    maxEvidenceAgeMs: input.offerEligibility.maxEvidenceAgeMs,
    location: input.offerEligibility.location,
    channel: input.offerEligibility.channel,
    enabledSourceIds: input.offerEligibility.enabledSourceIds,
    enabledMembershipProgramIds: input.offerEligibility.enabledMembershipProgramIds,
  };

  for (const need of input.needs) {
    const rule = rulesById.get(need.matchRuleId);
    if (rule === undefined) return undefined;
    const matchingEans = new Set(
      matchProducts(toLegacyNeed(need), rule, legacyProducts).map(({ ean }) => ean),
    );
    const candidates: Candidate[] = [];

    for (const observation of eligiblePrices) {
      if (!subsetSet.has(observation.chain) || !matchingEans.has(observation.ean)) {
        continue;
      }
      const product = productByEan.get(observation.ean);
      if (product === undefined) continue;
      const fulfilment = calculatePackageFulfilmentV2({
        canonicalProductId: product.canonicalProductId,
        needId: need.id,
        requested: need.requested,
        packageMeasure: product.packageMeasure,
      });
      if (fulfilment.state !== "complete") continue;
      const selectedCheckout = bestCheckout(
        product,
        observation,
        fulfilment.fulfilment.packageCount,
        offersByProductChain.get(productChainKey(
          product.canonicalProductId,
          observation.chain,
        )) ?? [],
        offerContext,
      );
      if (selectedCheckout === undefined) continue;

      candidates.push({
        assignment: {
          needId: need.id,
          canonicalProductId: product.canonicalProductId,
          ean: observation.ean,
          chain: observation.chain,
          costOre: selectedCheckout.checkout.totalOre,
          observedAt: observation.observedAt,
          source: observation.source,
          fulfilment: fulfilment.fulfilment,
          checkout: selectedCheckout.checkout,
          ...(selectedCheckout.offer === undefined
            ? {}
            : { officialOffer: officialOfferReference(selectedCheckout.offer) }),
        },
      });
    }

    const selected = candidates.sort(compareCandidates)[0];
    if (selected === undefined) return undefined;
    assignments.push(selected.assignment);
    freshness[need.id] = "eligible";
    if (rule.mode !== "exact") substitutions.push(need.id);
  }

  assignments.sort((left, right) => compareText(left.needId, right.needId));
  substitutions.sort(compareText);
  const total = assignments.reduce(
    (sum, assignment) => sum + BigInt(assignment.costOre),
    0n,
  );
  if (total > BigInt(MAX_PERSISTED_MONEY_ORE)) return undefined;

  const chains = [...new Set(assignments.map(({ chain }) => chain))].sort(compareChains);
  if (chains.length === 0 || chains.length > input.maxStores || chains.length > 3) {
    return undefined;
  }

  const result: PlanResultV2 = {
    id: `plan-v2-${stableHash(planIdentity(assignments))}`,
    assignments,
    totalOre: Number(total) as MoneyOre,
    chains,
    substitutions,
    coverage: 1,
    freshness,
  };
  const parsed = planResultV2Schema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

function dominates(left: PlanResultV2, right: PlanResultV2): boolean {
  const noWorse =
    left.totalOre <= right.totalOre
    && left.chains.length <= right.chains.length
    && left.substitutions.length <= right.substitutions.length;
  const strictlyBetter =
    left.totalOre < right.totalOre
    || left.chains.length < right.chains.length
    || left.substitutions.length < right.substitutions.length;
  return noWorse && strictlyBetter;
}

function comparePlans(left: PlanResultV2, right: PlanResultV2): number {
  return (
    left.chains.length - right.chains.length
    || left.substitutions.length - right.substitutions.length
    || left.totalOre - right.totalOre
    || compareText(planIdentity(left.assignments), planIdentity(right.assignments))
  );
}

export function enumerateCompletePlanCandidatesV2(
  input: ServerPlanningInputV2,
  now: Date,
): PlanResultV2[] {
  if (!Number.isFinite(now.getTime())) return [];
  const parsed = serverPlanningInputV2Schema.safeParse(input);
  if (!parsed.success || !sameJsonValue(input, parsed.data)) return [];
  const validated = parsed.data;
  const rulesById = new Map(validated.matchingRules.map((rule) => [rule.id, rule]));
  const eligiblePrices = validated.ordinaryPrices.filter((observation) =>
    classifyFreshness(now, new Date(observation.observedAt)) === "eligible",
  );
  const availableChains = CHAIN_ORDER.filter((chain) =>
    eligiblePrices.some((observation) => observation.chain === chain),
  );
  const offersByProductChain = indexOfficialOffers(validated.officialOffers);

  const plans = combinations(availableChains, Math.min(validated.maxStores, 3))
    .map((subset) => planForSubset(
      validated,
      rulesById,
      eligiblePrices,
      offersByProductChain,
      subset,
      now,
    ))
    .filter((plan): plan is PlanResultV2 => plan !== undefined);

  const uniqueAssignments = new Map<string, PlanResultV2>();
  for (const plan of plans.sort(comparePlans)) {
    uniqueAssignments.set(planIdentity(plan.assignments), plan);
  }
  return [...uniqueAssignments.values()].sort(comparePlans);
}

/**
 * Compatibility price-only planner. Travel-aware callers must enumerate all
 * complete candidates first, attach travel atomically, and only then run the
 * v2 Pareto frontier.
 */
export function calculatePlansV2(
  input: ServerPlanningInputV2,
  now: Date,
): PlanResultV2[] {
  const candidates = enumerateCompletePlanCandidatesV2(input, now);
  return candidates
    .filter((candidate) =>
      !candidates.some((other) => other !== candidate && dominates(other, candidate)))
    .sort(comparePlans);
}
