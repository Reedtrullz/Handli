import "server-only";

import {
  calculateDiscoveryImpactBatchV1,
  discoveryImpactRequestV1Schema,
  discoveryImpactResponseV1SchemaFor,
  matchProducts,
  type DiscoveryImpactOutcomeV1,
  type DiscoveryImpactPlanSummaryV1,
  type DiscoveryImpactRequestV1,
  type DiscoveryImpactResponseV1,
  type Need,
  type PlanResultV2,
  type Product,
  type ServerPlanningInputV2,
} from "@handleplan/domain";

import {
  PlanRequestCancelledError,
  type DiscoveryImpactPlanningResolver,
} from "./plan-service";

export interface DiscoveryImpactServiceContract {
  calculate(
    request: DiscoveryImpactRequestV1,
    signal?: AbortSignal,
  ): Promise<DiscoveryImpactResponseV1>;
}

export interface DiscoveryImpactServiceDependencies {
  resolver: DiscoveryImpactPlanningResolver;
}

export class DiscoveryImpactEvaluationError extends Error {
  constructor() {
    super("Discovery impact could not be evaluated from one evidence snapshot");
    this.name = "DiscoveryImpactEvaluationError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function difference<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function summarizePlan(
  plan: PlanResultV2,
  planning: ServerPlanningInputV2,
  comparisonCoverageByCanonicalProductId: ReadonlyMap<
    string,
    "complete" | "partial"
  >,
): DiscoveryImpactPlanSummaryV1 {
  const offersById = new Map(planning.officialOffers.map((offer) => [offer.id, offer]));
  const productByGtin = new Map(
    planning.products.map((product) => [product.ean, product]),
  );
  const canonicalIds = new Set<string>();
  const legacyProducts: Product[] = planning.products.map((product) => ({
    ...(product.brand === undefined ? {} : { brand: product.brand }),
    ean: product.ean,
    name: product.name,
    packageQuantity: product.packageMeasure.amount,
    packageUnit:
      product.packageMeasure.unit === "g" || product.packageMeasure.unit === "ml"
        ? product.packageMeasure.unit
        : "each",
    ...(product.productFamily === undefined
      ? {}
      : { productFamily: product.productFamily }),
  }));
  const ruleById = new Map(planning.matchingRules.map((rule) => [rule.id, rule]));
  for (const need of planning.needs) {
    const rule = ruleById.get(need.matchRuleId);
    if (rule === undefined) throw new DiscoveryImpactEvaluationError();
    const legacyNeed: Need = {
      id: need.id,
      matchRuleId: need.matchRuleId,
      query: need.query,
      quantity: need.requested.amount,
      quantityUnit:
        need.requested.unit === "g" || need.requested.unit === "ml"
          ? need.requested.unit
          : "each",
      required: true,
    };
    for (const candidate of matchProducts(
      legacyNeed,
      rule,
      legacyProducts,
    )) {
      const canonicalProductId = productByGtin.get(candidate.ean)
        ?.canonicalProductId;
      if (canonicalProductId === undefined) {
        throw new DiscoveryImpactEvaluationError();
      }
      canonicalIds.add(canonicalProductId);
    }
  }
  if (canonicalIds.size === 0) throw new DiscoveryImpactEvaluationError();
  const coverage = [...canonicalIds].map((canonicalProductId) =>
    comparisonCoverageByCanonicalProductId.get(canonicalProductId));
  if (coverage.some((value) => value === undefined)) {
    throw new DiscoveryImpactEvaluationError();
  }
  const appliedOfficialOfferIds = [...new Set(plan.assignments.flatMap(
      ({ checkout }) => checkout.appliedOfferId === undefined
        ? []
        : [checkout.appliedOfferId],
    ))].sort(compareText);
  const requiredMembershipProgramIds = [...new Set(
    appliedOfficialOfferIds.flatMap((offerId) => {
      const offer = offersById.get(offerId);
      if (offer === undefined) throw new DiscoveryImpactEvaluationError();
      return offer.conditions.flatMap((condition) =>
        condition.kind === "member" ? [condition.programId] : []);
    }),
  )].sort(compareText);
  return {
    appliedOfficialOfferIds,
    chains: [...plan.chains],
    comparisonCoverage: coverage.every((value) => value === "complete")
      ? "complete"
      : "partial",
    requiredMembershipProgramIds,
    storeCount: plan.chains.length as 1 | 2 | 3,
    substitutionCount: plan.substitutions.length,
    totalOre: plan.totalOre,
  };
}

export class DiscoveryImpactService implements DiscoveryImpactServiceContract {
  constructor(private readonly dependencies: DiscoveryImpactServiceDependencies) {}

  async calculate(
    request: DiscoveryImpactRequestV1,
    signal?: AbortSignal,
  ): Promise<DiscoveryImpactResponseV1> {
    if (signal?.aborted) throw new PlanRequestCancelledError();
    const parsed = discoveryImpactRequestV1Schema.safeParse(request);
    if (!parsed.success) throw new DiscoveryImpactEvaluationError();
    const input = parsed.data;
    const resolution = await this.dependencies.resolver
      .resolveDiscoveryImpactPlanning(input, signal);
    if (signal?.aborted) throw new PlanRequestCancelledError();

    const batch = calculateDiscoveryImpactBatchV1({
      actions: input.actions,
      baselineCandidateSets: resolution.baselineCandidateSets,
      convenienceWeightBasisPoints: input.convenienceWeightBasisPoints,
      evaluatedAt: resolution.evaluatedAt,
      planning: resolution.planning,
    });
    if (batch === undefined) throw new DiscoveryImpactEvaluationError();

    const baseline = batch.baseline.selectedPlan === undefined
      ? { kind: "incomplete" as const, reason: "no-complete-plan" as const }
      : {
          kind: "complete" as const,
          plan: summarizePlan(
            batch.baseline.selectedPlan,
            resolution.planning,
            resolution.comparisonCoverageByCanonicalProductId,
          ),
        };
    const outcomes: DiscoveryImpactOutcomeV1[] = batch.outcomes.map((outcome, index) => {
      const action = input.actions[index];
      if (
        action === undefined
        || action.actionId !== outcome.actionId
        || action.kind !== outcome.actionKind
      ) throw new DiscoveryImpactEvaluationError();
      if (outcome.state === "ineligible") return { ...outcome, action };
      if (outcome.selectedPlan === undefined) {
        return {
          action,
          actionId: outcome.actionId,
          actionKind: outcome.actionKind,
          reason: "no-complete-plan" as const,
          state: "incomplete" as const,
        };
      }
      const plan = summarizePlan(
        outcome.selectedPlan,
        outcome.planning,
        resolution.comparisonCoverageByCanonicalProductId,
      );
      if (baseline.kind === "incomplete") {
        return {
          action,
          actionId: outcome.actionId,
          actionKind: outcome.actionKind,
          comparison: {
            kind: "unavailable" as const,
            reason: "baseline-incomplete" as const,
          },
          plan,
          state: "complete" as const,
        };
      }
      return {
        action,
        actionId: outcome.actionId,
        actionKind: outcome.actionKind,
        comparison: {
          basis: outcome.actionKind === "add"
            ? "different-basket" as const
            : "same-need" as const,
          chainsAdded: difference(plan.chains, baseline.plan.chains),
          chainsRemoved: difference(baseline.plan.chains, plan.chains),
          checkoutTotalDeltaOre: plan.totalOre - baseline.plan.totalOre,
          claimScope:
            plan.comparisonCoverage === "complete"
              && baseline.plan.comparisonCoverage === "complete"
              ? "declared-complete-coverage" as const
              : "among-verified-prices" as const,
          kind: "comparable" as const,
          storeCountDelta: plan.storeCount - baseline.plan.storeCount,
          substitutionCountDelta:
            plan.substitutionCount - baseline.plan.substitutionCount,
        },
        plan,
        state: "complete" as const,
      };
    });

    const response = discoveryImpactResponseV1SchemaFor(input).safeParse({
      baseline,
      contractVersion: 1,
      evaluatedAt: resolution.evaluatedAt.toISOString(),
      evaluatedProductCount: batch.evaluatedProductCount,
      marketContext: input.planning.marketContext,
      outcomes,
      travelImpact: {
        kind: "omitted",
        reason: "origin-not-retained",
      },
    });
    if (!response.success) throw new DiscoveryImpactEvaluationError();
    return response.data;
  }
}
