import {
  sourceNeutralPlanResultSchema,
  type PlanResult,
} from "./contracts";
import { identifierSchema } from "./contract-primitives";
import {
  planExplanationSchema,
  travelResultSchema,
  type PlanExplanation,
  type TravelResult,
} from "./plan-contracts";

export type CalculatedTravelResult = Extract<TravelResult, { kind: "calculated" }>;

export type FrontierPlan<SourceId extends string = string> = PlanResult<SourceId> & {
  travel?: CalculatedTravelResult;
};

export interface PlanTravelEvidence {
  planId: string;
  travel: TravelResult;
}

export interface PlanClaimEvidence {
  planId: string;
  priceEvidenceIds: readonly string[];
}

export interface ExplainedPlan {
  planId: string;
  explanations: PlanExplanation[];
}

const CHAIN_ORDER: Readonly<Record<PlanResult<string>["chains"][number], number>> = {
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

function isExactIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = identifierSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function planIsInternallyComplete<SourceId extends string>(
  plan: PlanResult<SourceId>,
): boolean {
  if (!isExactIdentifier(plan.id) || plan.assignments.length === 0) return false;
  if (plan.chains.length === 0 || plan.chains.length > 3) return false;

  const needIds = plan.assignments.map(({ needId }) => needId);
  const chainSet = new Set(plan.chains);
  if (new Set(needIds).size !== needIds.length) return false;
  if (plan.assignments.some(({ chain }) => !chainSet.has(chain))) return false;
  if (plan.chains.some((chain) => !plan.assignments.some((item) => item.chain === chain))) {
    return false;
  }

  let total = 0;
  for (const assignment of plan.assignments) {
    total += assignment.costOre;
    if (!Number.isSafeInteger(total)) return false;
    if (!isExactIdentifier(assignment.needId)) return false;
    if (!isExactIdentifier(assignment.source)) return false;
    const freshness = plan.freshness[assignment.needId];
    if (typeof freshness !== "string" || freshness.trim().length === 0) return false;
  }
  if (total !== plan.totalOre) return false;

  if (new Set(plan.substitutions).size !== plan.substitutions.length) return false;
  if (
    plan.substitutions.some(
      (needId) => !isExactIdentifier(needId) || !needIds.includes(needId),
    )
  ) {
    return false;
  }
  return true;
}

function compareAssignments<SourceId extends string>(
  left: PlanResult<SourceId>["assignments"][number],
  right: PlanResult<SourceId>["assignments"][number],
): number {
  return (
    compareText(left.needId, right.needId) ||
    compareText(left.ean, right.ean) ||
    CHAIN_ORDER[left.chain] - CHAIN_ORDER[right.chain] ||
    compareNumber(left.quantity, right.quantity) ||
    compareNumber(left.costOre, right.costOre) ||
    compareText(left.observedAt, right.observedAt) ||
    compareText(left.source, right.source)
  );
}

function canonicalTravel(travel: CalculatedTravelResult): CalculatedTravelResult {
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

function canonicalPlan<SourceId extends string>(
  plan: PlanResult<SourceId>,
  travel?: CalculatedTravelResult,
): FrontierPlan<SourceId> {
  const freshness = Object.fromEntries(
    Object.entries(plan.freshness).sort(([left], [right]) => compareText(left, right)),
  );
  const canonical: FrontierPlan<SourceId> = {
    id: plan.id,
    assignments: plan.assignments
      .map((assignment) => ({ ...assignment }))
      .sort(compareAssignments),
    totalOre: plan.totalOre,
    chains: [...plan.chains].sort(
      (left, right) => CHAIN_ORDER[left] - CHAIN_ORDER[right],
    ),
    substitutions: [...plan.substitutions].sort(compareText),
    coverage: 1,
    freshness,
  };
  if (travel !== undefined) canonical.travel = canonicalTravel(travel);
  return canonical;
}

function parseCandidate<SourceId extends string>(
  candidate: unknown,
): FrontierPlan<SourceId> | undefined {
  if (!isRecord(candidate)) return undefined;
  const parsed = sourceNeutralPlanResultSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const plan = parsed.data as PlanResult<SourceId>;
  if (!planIsInternallyComplete(plan)) return undefined;

  if (candidate.travel === undefined) return canonicalPlan(plan);
  const parsedTravel = travelResultSchema.safeParse(candidate.travel);
  if (!parsedTravel.success || parsedTravel.data.kind !== "calculated") {
    return undefined;
  }
  return canonicalPlan(plan, parsedTravel.data);
}

function canonicalCandidates<SourceId extends string>(
  candidates: readonly unknown[],
): FrontierPlan<SourceId>[] {
  if (!Array.isArray(candidates)) return [];

  const rawIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isExactIdentifier(candidate.id)) continue;
    rawIdCounts.set(candidate.id, (rawIdCounts.get(candidate.id) ?? 0) + 1);
  }

  return candidates
    .map((candidate) => parseCandidate<SourceId>(candidate))
    .filter(
      (candidate): candidate is FrontierPlan<SourceId> =>
        candidate !== undefined && rawIdCounts.get(candidate.id) === 1,
    );
}

function withoutTravel<SourceId extends string>(
  candidate: FrontierPlan<SourceId>,
): FrontierPlan<SourceId> {
  return canonicalPlan(candidate);
}

function hasTravel<SourceId extends string>(
  candidate: FrontierPlan<SourceId>,
): candidate is FrontierPlan<SourceId> & { travel: CalculatedTravelResult } {
  return candidate.travel !== undefined;
}

function dominates<SourceId extends string>(
  left: FrontierPlan<SourceId>,
  right: FrontierPlan<SourceId>,
): boolean {
  const leftHasTravel = hasTravel(left);
  const rightHasTravel = hasTravel(right);
  if (leftHasTravel !== rightHasTravel) return false;

  const noWorse =
    left.totalOre <= right.totalOre &&
    left.chains.length <= right.chains.length &&
    left.substitutions.length <= right.substitutions.length &&
    (!leftHasTravel ||
      !rightHasTravel ||
      left.travel.durationSeconds <= right.travel.durationSeconds);
  const strictlyBetter =
    left.totalOre < right.totalOre ||
    left.chains.length < right.chains.length ||
    left.substitutions.length < right.substitutions.length ||
    (leftHasTravel &&
      rightHasTravel &&
      left.travel.durationSeconds < right.travel.durationSeconds);
  return noWorse && strictlyBetter;
}

function compareConvenience<SourceId extends string>(
  left: FrontierPlan<SourceId>,
  right: FrontierPlan<SourceId>,
): number {
  return (
    compareNumber(left.chains.length, right.chains.length) ||
    (hasTravel(left) && hasTravel(right)
      ? compareNumber(left.travel.durationSeconds, right.travel.durationSeconds)
      : 0) ||
    compareNumber(left.totalOre, right.totalOre) ||
    compareNumber(left.substitutions.length, right.substitutions.length) ||
    compareText(left.id, right.id)
  );
}

function compareSavings<SourceId extends string>(
  left: FrontierPlan<SourceId>,
  right: FrontierPlan<SourceId>,
): number {
  return (
    compareNumber(left.totalOre, right.totalOre) ||
    (hasTravel(left) && hasTravel(right)
      ? compareNumber(left.travel.durationSeconds, right.travel.durationSeconds)
      : 0) ||
    compareNumber(left.substitutions.length, right.substitutions.length) ||
    compareNumber(left.chains.length, right.chains.length) ||
    compareText(left.id, right.id)
  );
}

function compareMiddle<SourceId extends string>(
  left: FrontierPlan<SourceId>,
  right: FrontierPlan<SourceId>,
): number {
  return (
    compareNumber(left.chains.length, right.chains.length) ||
    (hasTravel(left) && hasTravel(right)
      ? compareNumber(left.travel.durationSeconds, right.travel.durationSeconds)
      : 0) ||
    compareNumber(right.totalOre, left.totalOre) ||
    compareNumber(left.substitutions.length, right.substitutions.length) ||
    compareText(left.id, right.id)
  );
}

function orderCohort<SourceId extends string>(
  candidates: readonly FrontierPlan<SourceId>[],
): FrontierPlan<SourceId>[] {
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

function orderCandidates<SourceId extends string>(
  candidates: readonly FrontierPlan<SourceId>[],
): FrontierPlan<SourceId>[] {
  const priceOnly = candidates.filter((candidate) => !hasTravel(candidate));
  const travelBacked = candidates.filter(hasTravel);
  return [...orderCohort(priceOnly), ...orderCohort(travelBacked)];
}

export function attachOptionalTravelEvidence<SourceId extends string>(
  plans: readonly PlanResult<SourceId>[],
  travelEvidence?: readonly PlanTravelEvidence[],
): FrontierPlan<SourceId>[] {
  const validPlans = canonicalCandidates<SourceId>(plans).map(withoutTravel);
  const priceOnly = orderCandidates(validPlans);
  if (travelEvidence === undefined) return priceOnly;
  if (!Array.isArray(travelEvidence) || travelEvidence.length !== validPlans.length) {
    return priceOnly;
  }

  const planIds = new Set(validPlans.map(({ id }) => id));
  const travelByPlanId = new Map<string, CalculatedTravelResult>();
  for (const entry of travelEvidence) {
    if (!isRecord(entry) || !isExactIdentifier(entry.planId)) return priceOnly;
    if (!planIds.has(entry.planId) || travelByPlanId.has(entry.planId)) return priceOnly;
    const parsed = travelResultSchema.safeParse(entry.travel);
    if (!parsed.success || parsed.data.kind !== "calculated") return priceOnly;
    travelByPlanId.set(entry.planId, parsed.data);
  }
  if (travelByPlanId.size !== validPlans.length) return priceOnly;

  return orderCandidates(
    validPlans.map((plan) => canonicalPlan(plan, travelByPlanId.get(plan.id)!)),
  );
}

export function paretoFrontier<SourceId extends string>(
  candidates: readonly FrontierPlan<SourceId>[],
): FrontierPlan<SourceId>[] {
  const valid = canonicalCandidates<SourceId>(candidates);
  const frontier = valid.filter(
    (candidate) =>
      !valid.some((other) => other.id !== candidate.id && dominates(other, candidate)),
  );
  return orderCandidates(frontier);
}

function distanceFromSelected(index: number, selected: ReadonlySet<number>): number {
  return Math.min(...[...selected].map((chosen) => Math.abs(chosen - index)));
}

export function projectRepresentatives<SourceId extends string>(
  candidates: readonly FrontierPlan<SourceId>[],
  maximum: number,
): FrontierPlan<SourceId>[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 7) return [];
  const ordered = paretoFrontier(candidates);
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
          distanceFromSelected(right, selected) - distanceFromSelected(left, selected) ||
          left - right,
      )[0];
    if (representative !== undefined) selected.add(representative);
  }

  while (selected.size < maximum) {
    const next = ordered
      .map((_candidate, index) => index)
      .filter((index) => !selected.has(index))
      .sort(
        (left, right) =>
          distanceFromSelected(right, selected) - distanceFromSelected(left, selected) ||
          left - right,
      )[0];
    if (next === undefined) break;
    selected.add(next);
  }

  return [...selected]
    .sort(compareNumber)
    .map((index) => ordered[index]!);
}

function claimEvidenceByPlanId(
  evidence: readonly PlanClaimEvidence[],
): ReadonlyMap<string, readonly string[]> {
  if (!Array.isArray(evidence)) return new Map();
  const idCounts = new Map<string, number>();
  for (const entry of evidence) {
    if (!isRecord(entry) || !isExactIdentifier(entry.planId)) continue;
    idCounts.set(entry.planId, (idCounts.get(entry.planId) ?? 0) + 1);
  }

  const result = new Map<string, readonly string[]>();
  for (const entry of evidence) {
    if (
      !isRecord(entry) ||
      !isExactIdentifier(entry.planId) ||
      idCounts.get(entry.planId) !== 1 ||
      !Array.isArray(entry.priceEvidenceIds)
    ) {
      continue;
    }
    const ids = [...entry.priceEvidenceIds];
    if (
      ids.length === 0 ||
      ids.some((id) => !isExactIdentifier(id)) ||
      new Set(ids).size !== ids.length
    ) {
      continue;
    }
    result.set(entry.planId, ids.sort(compareText));
  }
  return result;
}

function explanation(input: PlanExplanation): PlanExplanation | undefined {
  const parsed = planExplanationSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function combinedEvidenceIds(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  if (first === undefined || second === undefined) return undefined;
  return [...new Set([...first, ...second])].sort(compareText);
}

export function explainPlanDeltas<SourceId extends string>(
  candidates: readonly FrontierPlan<SourceId>[],
  claimEvidence: readonly PlanClaimEvidence[],
): ExplainedPlan[] {
  const ordered = paretoFrontier(candidates);
  const evidenceByPlanId = claimEvidenceByPlanId(claimEvidence);

  return ordered.map((candidate, index) => {
    const previous = ordered[index - 1];
    if (previous === undefined) {
      return {
        planId: candidate.id,
        explanations: [
          explanation({
            contractVersion: 1,
            kind: "convenience",
            message: `Bruker ${candidate.chains.length} ${candidate.chains.length === 1 ? "butikk" : "butikker"}.`,
            evidenceIds: [],
          })!,
        ],
      };
    }

    const explanations: PlanExplanation[] = [];
    if (candidate.totalOre < previous.totalOre) {
      const evidenceIds = combinedEvidenceIds(
        evidenceByPlanId.get(previous.id),
        evidenceByPlanId.get(candidate.id),
      );
      if (evidenceIds !== undefined && evidenceIds.length > 0) {
        const parsed = explanation({
          contractVersion: 1,
          kind: "savings",
          message: `Sparer ${previous.totalOre - candidate.totalOre} øre sammenlignet med forrige plan.`,
          evidenceIds,
        });
        if (parsed !== undefined) explanations.push(parsed);
      }
    }

    if (candidate.chains.length !== previous.chains.length) {
      const parsed = explanation({
        contractVersion: 1,
        kind: "convenience",
        message: `Butikkantallet endres fra ${previous.chains.length} til ${candidate.chains.length}.`,
        evidenceIds: [],
      });
      if (parsed !== undefined) explanations.push(parsed);
    }

    if (candidate.substitutions.length !== previous.substitutions.length) {
      const parsed = explanation({
        contractVersion: 1,
        kind: "substitution",
        message: `Antall godkjente bytter endres fra ${previous.substitutions.length} til ${candidate.substitutions.length}.`,
        evidenceIds: [],
      });
      if (parsed !== undefined) explanations.push(parsed);
    }

    if (
      hasTravel(previous) &&
      hasTravel(candidate) &&
      previous.travel.durationSeconds !== candidate.travel.durationSeconds
    ) {
      const evidenceIds = [
        previous.travel.routeFingerprint,
        candidate.travel.routeFingerprint,
      ].filter((id, position, ids) => ids.indexOf(id) === position).sort(compareText);
      const parsed = explanation({
        contractVersion: 1,
        kind: "travel",
        message: `Beregnet reisetid endres fra ${previous.travel.durationSeconds} til ${candidate.travel.durationSeconds} sekunder.`,
        evidenceIds,
      });
      if (parsed !== undefined) explanations.push(parsed);
    }

    if (explanations.length === 0) {
      explanations.push(
        explanation({
          contractVersion: 1,
          kind: "convenience",
          message: "Alternativ uten dokumentert deltaforklaring.",
          evidenceIds: [],
        })!,
      );
    }
    return { planId: candidate.id, explanations };
  });
}
