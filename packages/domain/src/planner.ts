import {
  planRequestSchema,
  type MatchRule,
  type MoneyOre,
  type Need,
  type PlanRequest,
  type PlanResult,
  type PriceObservation,
} from "./contracts";
import { matchProducts } from "./matching";
import { classifyFreshness } from "./price-eligibility";

type Chain = PriceObservation["chain"];
type Assignment = PlanResult["assignments"][number];

interface AssignmentCandidate {
  assignment: Assignment;
}

const CHAIN_ORDER: readonly Chain[] = ["bunnpris", "extra", "rema-1000"];
const chainRank = new Map(CHAIN_ORDER.map((chain, index) => [chain, index]));

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareChains(left: Chain, right: Chain): number {
  return (chainRank.get(left) ?? 0) - (chainRank.get(right) ?? 0);
}

function hasUniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map(({ id }) => id)).size === values.length;
}

function combinations(chains: readonly Chain[], maximum: number): Chain[][] {
  const result: Chain[][] = [];

  function visit(start: number, current: Chain[]): void {
    if (current.length > 0) {
      result.push([...current]);
    }
    if (current.length === maximum) {
      return;
    }

    for (let index = start; index < chains.length; index += 1) {
      current.push(chains[index]!);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return result;
}

function compareCandidates(left: AssignmentCandidate, right: AssignmentCandidate): number {
  return (
    left.assignment.costOre - right.assignment.costOre ||
    compareText(left.assignment.ean, right.assignment.ean) ||
    compareChains(left.assignment.chain, right.assignment.chain) ||
    compareText(right.assignment.observedAt, left.assignment.observedAt)
  );
}

function assignmentKey(assignment: Assignment): string {
  return [
    assignment.needId,
    assignment.ean,
    assignment.chain,
    assignment.quantity,
    assignment.costOre,
    assignment.observedAt,
    assignment.source,
  ].join(":");
}

function planIdentity(assignments: readonly Assignment[]): string {
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
  requiredNeeds: readonly Need[],
  rulesById: ReadonlyMap<string, MatchRule>,
  request: PlanRequest,
  eligiblePrices: readonly PriceObservation[],
  subset: readonly Chain[],
): PlanResult | undefined {
  const subsetSet = new Set(subset);
  const assignments: Assignment[] = [];
  const substitutions: string[] = [];
  const freshness: Record<string, string> = {};

  for (const need of requiredNeeds) {
    const rule = rulesById.get(need.matchRuleId);
    if (rule === undefined) {
      return undefined;
    }

    const matchingEans = new Set(
      matchProducts(need, rule, request.products).map(({ ean }) => ean),
    );
    const candidates: AssignmentCandidate[] = [];

    for (const observation of eligiblePrices) {
      if (!subsetSet.has(observation.chain) || !matchingEans.has(observation.ean)) {
        continue;
      }

      const cost = observation.amountOre * need.quantity;
      if (!Number.isSafeInteger(cost) || cost < 0) {
        continue;
      }

      candidates.push({
        assignment: {
          needId: need.id,
          ean: observation.ean,
          chain: observation.chain,
          quantity: need.quantity,
          costOre: cost as MoneyOre,
          observedAt: observation.observedAt,
          source: observation.source,
        },
      });
    }

    const selected = candidates.sort(compareCandidates)[0];
    if (selected === undefined) {
      return undefined;
    }

    assignments.push(selected.assignment);
    freshness[need.id] = "eligible";
    if (rule.mode !== "exact") {
      substitutions.push(need.id);
    }
  }

  assignments.sort((left, right) => compareText(left.needId, right.needId));
  substitutions.sort(compareText);

  const total = assignments.reduce((sum, assignment) => sum + assignment.costOre, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    return undefined;
  }

  const chains = [...new Set(assignments.map(({ chain }) => chain))].sort(compareChains);
  if (chains.length === 0 || chains.length > request.maxStores || chains.length > 3) {
    return undefined;
  }

  const identity = planIdentity(assignments);
  return {
    id: `plan-${stableHash(identity)}`,
    assignments,
    totalOre: total as MoneyOre,
    chains,
    substitutions,
    coverage: 1,
    freshness,
  };
}

function dominates(left: PlanResult, right: PlanResult): boolean {
  const noWorse =
    left.totalOre <= right.totalOre &&
    left.chains.length <= right.chains.length &&
    left.substitutions.length <= right.substitutions.length;
  const strictlyBetter =
    left.totalOre < right.totalOre ||
    left.chains.length < right.chains.length ||
    left.substitutions.length < right.substitutions.length;

  return noWorse && strictlyBetter;
}

function comparePlans(left: PlanResult, right: PlanResult): number {
  return (
    left.chains.length - right.chains.length ||
    left.substitutions.length - right.substitutions.length ||
    left.totalOre - right.totalOre ||
    compareText(planIdentity(left.assignments), planIdentity(right.assignments))
  );
}

export function calculatePlans(request: PlanRequest, now: Date): PlanResult[] {
  if (!Number.isFinite(now.getTime())) {
    return [];
  }

  const parsed = planRequestSchema.safeParse(request);
  if (!parsed.success) {
    return [];
  }
  const validated = parsed.data;

  if (
    !hasUniqueIds(validated.needs) ||
    !hasUniqueIds(validated.matchingRules) ||
    validated.needs.some(({ quantity, quantityUnit, required }) => !Number.isSafeInteger(quantity) || (required && quantityUnit !== "each"))
  ) {
    return [];
  }

  const requiredNeeds = validated.needs
    .filter(({ required }) => required)
    .sort((left, right) => compareText(left.id, right.id));
  if (requiredNeeds.length === 0) {
    return [];
  }

  const rulesById = new Map(validated.matchingRules.map((rule) => [rule.id, rule]));
  const eligiblePrices = validated.prices.filter((observation) =>
    classifyFreshness(now, new Date(observation.observedAt)) === "eligible",
  );
  const availableChains = CHAIN_ORDER.filter((chain) =>
    eligiblePrices.some((observation) => observation.chain === chain),
  );

  const plans = combinations(availableChains, Math.min(validated.maxStores, 3))
    .map((subset) =>
      planForSubset(requiredNeeds, rulesById, validated, eligiblePrices, subset),
    )
    .filter((plan): plan is PlanResult => plan !== undefined);

  const uniqueAssignments = new Map<string, PlanResult>();
  for (const plan of plans.sort(comparePlans)) {
    uniqueAssignments.set(planIdentity(plan.assignments), plan);
  }

  const candidates = [...uniqueAssignments.values()];
  return candidates
    .filter((candidate) => !candidates.some((other) => other !== candidate && dominates(other, candidate)))
    .sort(comparePlans);
}
