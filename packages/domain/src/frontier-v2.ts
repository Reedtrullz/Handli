import { identifierSchema } from "./contract-primitives";
import {
  planResultV2Schema,
  type PlanAssignmentV2,
  type PlanResultV2,
} from "./planner-v2-contracts";
import {
  travelResultSchema,
  type TravelResult,
} from "./plan-contracts";
import type { PlanTravelEvidence } from "./frontier";

export type CalculatedTravelResultV2 = Extract<TravelResult, { kind: "calculated" }>;

export type FrontierPlanV2 = PlanResultV2 & {
  travel?: CalculatedTravelResultV2;
};

const CHAIN_ORDER: Readonly<Record<PlanResultV2["chains"][number], number>> = {
  bunnpris: 0,
  extra: 1,
  "rema-1000": 2,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
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

function isExactIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = identifierSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function compareAssignments(
  left: PlanAssignmentV2,
  right: PlanAssignmentV2,
): number {
  return (
    compareText(left.needId, right.needId)
    || compareText(left.canonicalProductId, right.canonicalProductId)
    || compareText(left.ean, right.ean)
    || CHAIN_ORDER[left.chain] - CHAIN_ORDER[right.chain]
    || compareNumber(left.costOre, right.costOre)
    || compareNumber(
      left.fulfilment.requested.amount,
      right.fulfilment.requested.amount,
    )
    || compareText(
      left.fulfilment.requested.unit,
      right.fulfilment.requested.unit,
    )
    || compareNumber(left.fulfilment.packageCount, right.fulfilment.packageCount)
    || compareText(
      left.checkout.appliedOfferId ?? "",
      right.checkout.appliedOfferId ?? "",
    )
    || compareText(left.observedAt, right.observedAt)
    || compareText(left.source, right.source)
  );
}

function canonicalTravel(
  travel: CalculatedTravelResultV2,
): CalculatedTravelResultV2 {
  return {
    contractVersion: travel.contractVersion,
    kind: "calculated",
    durationSeconds: travel.durationSeconds,
    distanceMeters: travel.distanceMeters,
    providerSourceId: travel.providerSourceId,
    calculatedAt: travel.calculatedAt,
    routeFingerprint: travel.routeFingerprint,
  };
}

function canonicalPlan(
  plan: PlanResultV2,
  travel?: CalculatedTravelResultV2,
): FrontierPlanV2 {
  const canonical: FrontierPlanV2 = {
    id: plan.id,
    assignments: [...plan.assignments].sort(compareAssignments),
    totalOre: plan.totalOre,
    chains: [...plan.chains].sort(
      (left, right) => CHAIN_ORDER[left] - CHAIN_ORDER[right],
    ),
    substitutions: [...plan.substitutions].sort(compareText),
    coverage: 1,
    freshness: Object.fromEntries(
      Object.entries(plan.freshness).sort(([left], [right]) => compareText(left, right)),
    ),
  };
  if (travel !== undefined) canonical.travel = canonicalTravel(travel);
  return canonical;
}

function parseCandidate(candidate: unknown): FrontierPlanV2 | undefined {
  if (!isRecord(candidate)) return undefined;
  const { travel, ...planCandidate } = candidate;
  const parsedPlan = planResultV2Schema.safeParse(planCandidate);
  if (!parsedPlan.success || !sameJsonValue(planCandidate, parsedPlan.data)) {
    return undefined;
  }
  if (travel === undefined) return canonicalPlan(parsedPlan.data);

  const parsedTravel = travelResultSchema.safeParse(travel);
  if (
    !parsedTravel.success
    || parsedTravel.data.kind !== "calculated"
    || !sameJsonValue(travel, parsedTravel.data)
  ) {
    return undefined;
  }
  return canonicalPlan(parsedPlan.data, parsedTravel.data);
}

function canonicalCandidates(candidates: readonly unknown[]): FrontierPlanV2[] {
  if (!Array.isArray(candidates)) return [];
  const rawIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isExactIdentifier(candidate.id)) continue;
    rawIdCounts.set(candidate.id, (rawIdCounts.get(candidate.id) ?? 0) + 1);
  }

  return candidates
    .map(parseCandidate)
    .filter(
      (candidate): candidate is FrontierPlanV2 =>
        candidate !== undefined && rawIdCounts.get(candidate.id) === 1,
    );
}

function withoutTravel(candidate: FrontierPlanV2): FrontierPlanV2 {
  return canonicalPlan(candidate);
}

function hasTravel(
  candidate: FrontierPlanV2,
): candidate is FrontierPlanV2 & { travel: CalculatedTravelResultV2 } {
  return candidate.travel !== undefined;
}

function dominates(left: FrontierPlanV2, right: FrontierPlanV2): boolean {
  const leftHasTravel = hasTravel(left);
  const rightHasTravel = hasTravel(right);
  if (leftHasTravel !== rightHasTravel) return false;

  const noWorse =
    left.totalOre <= right.totalOre
    && left.chains.length <= right.chains.length
    && left.substitutions.length <= right.substitutions.length
    && (
      !leftHasTravel
      || !rightHasTravel
      || left.travel.durationSeconds <= right.travel.durationSeconds
    );
  const strictlyBetter =
    left.totalOre < right.totalOre
    || left.chains.length < right.chains.length
    || left.substitutions.length < right.substitutions.length
    || (
      leftHasTravel
      && rightHasTravel
      && left.travel.durationSeconds < right.travel.durationSeconds
    );
  return noWorse && strictlyBetter;
}

function compareConvenience(left: FrontierPlanV2, right: FrontierPlanV2): number {
  return (
    compareNumber(left.chains.length, right.chains.length)
    || (hasTravel(left) && hasTravel(right)
      ? compareNumber(left.travel.durationSeconds, right.travel.durationSeconds)
      : 0)
    || compareNumber(left.totalOre, right.totalOre)
    || compareNumber(left.substitutions.length, right.substitutions.length)
    || compareText(left.id, right.id)
  );
}

function compareSavings(left: FrontierPlanV2, right: FrontierPlanV2): number {
  return (
    compareNumber(left.totalOre, right.totalOre)
    || (hasTravel(left) && hasTravel(right)
      ? compareNumber(left.travel.durationSeconds, right.travel.durationSeconds)
      : 0)
    || compareNumber(left.substitutions.length, right.substitutions.length)
    || compareNumber(left.chains.length, right.chains.length)
    || compareText(left.id, right.id)
  );
}

function compareMiddle(left: FrontierPlanV2, right: FrontierPlanV2): number {
  return (
    compareNumber(left.chains.length, right.chains.length)
    || (hasTravel(left) && hasTravel(right)
      ? compareNumber(left.travel.durationSeconds, right.travel.durationSeconds)
      : 0)
    || compareNumber(right.totalOre, left.totalOre)
    || compareNumber(left.substitutions.length, right.substitutions.length)
    || compareText(left.id, right.id)
  );
}

function orderCohort(candidates: readonly FrontierPlanV2[]): FrontierPlanV2[] {
  if (candidates.length < 2) return [...candidates];
  const convenience = [...candidates].sort(compareConvenience)[0]!;
  const savings = [...candidates].sort(compareSavings)[0]!;
  const middle = candidates
    .filter(({ id }) => id !== convenience.id && id !== savings.id)
    .sort(compareMiddle);
  if (convenience.id === savings.id) {
    return [
      convenience,
      ...candidates
        .filter(({ id }) => id !== convenience.id)
        .sort(compareMiddle),
    ];
  }
  return [convenience, ...middle, savings];
}

function orderCandidates(candidates: readonly FrontierPlanV2[]): FrontierPlanV2[] {
  const priceOnly = candidates.filter((candidate) => !hasTravel(candidate));
  const travelBacked = candidates.filter(hasTravel);
  return [...orderCohort(priceOnly), ...orderCohort(travelBacked)];
}

export function attachOptionalTravelEvidenceV2(
  plans: readonly PlanResultV2[],
  travelEvidence?: readonly PlanTravelEvidence[],
): FrontierPlanV2[] {
  const validPlans = canonicalCandidates(plans).map(withoutTravel);
  const priceOnly = orderCandidates(validPlans);
  if (travelEvidence === undefined) return priceOnly;
  if (!Array.isArray(travelEvidence) || travelEvidence.length !== validPlans.length) {
    return priceOnly;
  }

  const planIds = new Set(validPlans.map(({ id }) => id));
  const travelByPlanId = new Map<string, CalculatedTravelResultV2>();
  for (const entry of travelEvidence) {
    if (!isRecord(entry) || !isExactIdentifier(entry.planId)) return priceOnly;
    if (!planIds.has(entry.planId) || travelByPlanId.has(entry.planId)) return priceOnly;
    const parsed = travelResultSchema.safeParse(entry.travel);
    if (
      !parsed.success
      || parsed.data.kind !== "calculated"
      || !sameJsonValue(entry.travel, parsed.data)
    ) {
      return priceOnly;
    }
    travelByPlanId.set(entry.planId, parsed.data);
  }
  if (travelByPlanId.size !== validPlans.length) return priceOnly;

  return orderCandidates(
    validPlans.map((plan) => canonicalPlan(plan, travelByPlanId.get(plan.id)!)),
  );
}

export function paretoFrontierV2(
  candidates: readonly FrontierPlanV2[],
): FrontierPlanV2[] {
  const valid = canonicalCandidates(candidates);
  const frontier = valid.filter(
    (candidate) =>
      !valid.some((other) => other.id !== candidate.id && dominates(other, candidate)),
  );
  return orderCandidates(frontier);
}

function distanceFromSelected(index: number, selected: ReadonlySet<number>): number {
  return Math.min(...[...selected].map((chosen) => Math.abs(chosen - index)));
}

export function projectRepresentativesV2(
  candidates: readonly FrontierPlanV2[],
  maximum: number,
): FrontierPlanV2[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 7) return [];
  const ordered = paretoFrontierV2(candidates);
  if (ordered.length <= maximum) return ordered;
  if (maximum === 1) return [ordered[0]!];

  const selected = new Set<number>([0, ordered.length - 1]);
  const storeCounts = [...new Set(ordered.map(({ chains }) => chains.length))].sort(
    compareNumber,
  );
  for (const storeCount of storeCounts) {
    if (selected.size >= maximum) break;
    if ([...selected].some((index) => ordered[index]?.chains.length === storeCount)) {
      continue;
    }
    const representative = ordered
      .map((_candidate, index) => index)
      .filter((index) => ordered[index]!.chains.length === storeCount)
      .sort(
        (left, right) =>
          distanceFromSelected(right, selected) - distanceFromSelected(left, selected)
          || left - right,
      )[0];
    if (representative !== undefined) selected.add(representative);
  }

  while (selected.size < maximum) {
    const next = ordered
      .map((_candidate, index) => index)
      .filter((index) => !selected.has(index))
      .sort(
        (left, right) =>
          distanceFromSelected(right, selected) - distanceFromSelected(left, selected)
          || left - right,
      )[0];
    if (next === undefined) break;
    selected.add(next);
  }

  return [...selected]
    .sort(compareNumber)
    .map((index) => ordered[index]!);
}
