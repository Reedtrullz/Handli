import "server-only";

import { randomBytes } from "node:crypto";

import {
  deriveExactProductPlanDeltaExplanationsV1,
  deriveReviewedFamilyPlanDeltaExplanationsV1,
  exactProductPlanApiResponseSchemaFor,
  paretoFrontierV2,
  planResultV2Schema,
  projectRepresentativesV2,
  reviewedFamilyPlanApiResponseV2SchemaFor,
  travelPlanApiRequestSchema,
  travelPlanApiResponseSchemaFor,
  type ExactProductPlanApiResponse,
  type ExactProductPlanApiEvidenceEnvelope,
  type FrontierPlanV2,
  type PlanResultV2,
  type ReviewedFamilyPlanApiResponseV2,
  type ReviewedFamilyPlanApiEvidenceEnvelopeV2,
  type TravelCalculationState,
  type TravelRouteEvidence,
  type TravelPlanApiRequest,
  type TravelPlanApiResponse,
} from "@handleplan/domain";

import {
  PlanRequestCancelledError,
  type ExactProductPlanServiceResult,
  type PlanServiceContract,
  type ReviewedFamilyPlanServiceResult,
} from "../plan-service";
import type { LocationChoiceResolver } from "./location-search-service";
import { getProductionLocationChoiceResolver } from "./location-search-service";
import { isValhallaTravelRuntimeEnabled } from "./travel-runtime-gate";
import { TravelService, type TravelServiceResult } from "./travel-service";
import { ValhallaRouteMatrixGateway } from "./valhalla-route-matrix-gateway";

export const TRAVEL_PLAN_CAVEATS = [
  "Resultatet gjelder prisene Handleplan kunne verifisere; ukjent kjededekning kan påvirke sammenligningen.",
  "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
  "Verifiserte kundeavistilbud kan være med; medlemspriser brukes bare for medlemsprogrammer du selv har slått på.",
] as const;

type TravelCalculator = Pick<TravelService, "calculate">;

export interface TravelPlanCoordinatorContract {
  calculate(
    request: TravelPlanApiRequest,
    signal?: AbortSignal,
  ): Promise<TravelPlanApiResponse>;
}

export interface TravelPlanCoordinatorDependencies {
  locationChoices?: LocationChoiceResolver;
  now?: () => Date;
  planService: PlanServiceContract;
  travelEnabled: boolean;
  travelService?: TravelCalculator;
}

export type TravelPlanCoordinatorErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_SERVICE_RESPONSE";

export class TravelPlanCoordinatorError extends Error {
  constructor(readonly code: TravelPlanCoordinatorErrorCode) {
    super(`Travel-plan coordination failed: ${code}`);
    this.name = "TravelPlanCoordinatorError";
  }
}

function unavailable(reason: Extract<
  TravelCalculationState,
  { kind: "unavailable" }
>["reason"]): Extract<TravelCalculationState, { kind: "unavailable" }> {
  return { contractVersion: 1, kind: "unavailable", reason };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || (typeof error === "object"
      && error !== null
      && "name" in error
      && error.name === "AbortError");
}

function throwIfCancelled(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw new PlanRequestCancelledError();
  if (error instanceof PlanRequestCancelledError || isAbortError(error)) {
    throw new PlanRequestCancelledError();
  }
}

function exactPlanningResponse(
  request: Extract<TravelPlanApiRequest["planning"], { contractVersion: 1 }>,
  result: ExactProductPlanServiceResult,
): ExactProductPlanApiResponse {
  const response = exactProductPlanApiResponseSchemaFor(request).safeParse({
    caveats: TRAVEL_PLAN_CAVEATS,
    contractVersion: 1,
    evidence: result.evidence,
    enabledMembershipProgramIds: request.enabledMembershipProgramIds,
    generatedAt: result.generatedAt,
    ...(result.geographicDirectoryAttestation === undefined
      ? {}
      : { geographicDirectoryAttestation: result.geographicDirectoryAttestation }),
    marketContext: request.marketContext,
    planDeltaExplanations: result.planDeltaExplanations,
    plans: result.plans,
    priceDataSource: result.priceDataSource,
    products: result.products,
  });
  if (!response.success) throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
  return response.data;
}

function reviewedPlanningResponse(
  request: Extract<TravelPlanApiRequest["planning"], { contractVersion: 2 }>,
  result: ReviewedFamilyPlanServiceResult,
): ReviewedFamilyPlanApiResponseV2 {
  const response = reviewedFamilyPlanApiResponseV2SchemaFor(request).safeParse({
    caveats: TRAVEL_PLAN_CAVEATS,
    contractVersion: 2,
    evidence: result.evidence,
    enabledMembershipProgramIds: request.enabledMembershipProgramIds,
    generatedAt: result.generatedAt,
    ...(result.geographicDirectoryAttestation === undefined
      ? {}
      : { geographicDirectoryAttestation: result.geographicDirectoryAttestation }),
    marketContext: request.marketContext,
    needMatches: result.needMatches,
    planDeltaExplanations: result.planDeltaExplanations,
    plans: result.plans,
    priceDataSource: result.priceDataSource,
    productClaims: result.productClaims,
    taxonomy: result.taxonomy,
  });
  if (!response.success) throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
  return response.data;
}

function stripTravel(plan: FrontierPlanV2) {
  const pricePlan: Record<string, unknown> = { ...plan };
  delete pricePlan.travel;
  const parsed = planResultV2Schema.safeParse(pricePlan);
  if (!parsed.success) throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
  return parsed.data;
}

function filterExactPlanning(
  planning: ExactProductPlanApiResponse,
  candidateEvidence: ExactProductPlanApiEvidenceEnvelope,
  plans: readonly FrontierPlanV2[],
  travelRoutes: readonly TravelRouteEvidence[],
): ExactProductPlanApiResponse {
  const visiblePlanIds = new Set(plans.map(({ id }) => id));
  const filtered = {
    ...planning,
    evidence: {
      ...candidateEvidence,
      assignmentEvidence: candidateEvidence.assignmentEvidence.filter(({ planId }) =>
        visiblePlanIds.has(planId)),
    },
    plans: plans.map(stripTravel),
  };
  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
    evidence: filtered.evidence,
    generatedAt: filtered.generatedAt,
    marketContext: filtered.marketContext,
    plans: filtered.plans,
    travelRoutes,
  });
  if (planDeltaExplanations === undefined) {
    throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
  }
  return { ...filtered, planDeltaExplanations };
}

function filterReviewedPlanning(
  planning: ReviewedFamilyPlanApiResponseV2,
  candidateEvidence: ReviewedFamilyPlanApiEvidenceEnvelopeV2,
  plans: readonly FrontierPlanV2[],
  travelRoutes: readonly TravelRouteEvidence[],
): ReviewedFamilyPlanApiResponseV2 {
  const visiblePlanIds = new Set(plans.map(({ id }) => id));
  const assignmentEvidence = candidateEvidence.assignmentEvidence.filter(({ planId }) =>
    visiblePlanIds.has(planId));
  const filtered = pruneReviewedPlanningSources({
    ...planning,
    evidence: {
      ...candidateEvidence,
      assignmentEvidence,
    },
    plans: plans.map(stripTravel),
  });
  const planDeltaExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
    evidence: filtered.evidence,
    generatedAt: filtered.generatedAt,
    marketContext: filtered.marketContext,
    plans: filtered.plans,
    travelRoutes,
  });
  if (planDeltaExplanations === undefined) {
    throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
  }
  return { ...filtered, planDeltaExplanations };
}

/**
 * Rebuilds the reviewed response source set after a travel frontier removes
 * plans. Current in-market candidate offers remain visible even when they are
 * disabled or not applied by the surviving plans, so their sources remain too.
 */
export function pruneReviewedPlanningSources(
  planning: ReviewedFamilyPlanApiResponseV2,
): ReviewedFamilyPlanApiResponseV2 {
  const referencedSourceIds = new Set<string>();
  planning.productClaims.forEach(({ product }) => {
    referencedSourceIds.add(product.catalogEvidence.source.id);
  });
  planning.evidence.ordinaryPrices.forEach(({ sourceId }) => {
    referencedSourceIds.add(sourceId);
  });
  planning.evidence.excludedPriceEvidence.forEach(({ sourceId }) => {
    referencedSourceIds.add(sourceId);
  });
  planning.evidence.officialOffers.forEach(({ sourceId }) => {
    referencedSourceIds.add(sourceId);
  });
  planning.evidence.candidateCoverage.forEach(({ comparisonScope }) => {
    comparisonScope.entries.forEach(({ status }) => {
      if (status.kind === "known-not-carried") {
        referencedSourceIds.add(status.sourceId);
      }
    });
  });
  return {
    ...planning,
    evidence: {
      ...planning.evidence,
      sources: planning.evidence.sources.filter(({ id }) =>
        referencedSourceIds.has(id)),
    },
  };
}

function calculatedTravelOutputIsCoherent(
  calculated: TravelServiceResult,
  planningPlans: TravelPlanApiResponse["planning"]["plans"],
): boolean {
  if (
    calculated.travel.kind !== "calculated"
    || calculated.evaluatedCandidates === undefined
    || calculated.evaluatedCandidates.length !== planningPlans.length
    || calculated.plans.length !== calculated.travel.routes.length
  ) return false;

  try {
    const planningById = new Map(planningPlans.map((plan) => [plan.id, plan]));
    if (planningById.size !== planningPlans.length) return false;
    for (const evaluated of calculated.evaluatedCandidates) {
      if (evaluated.travel === undefined) return false;
      const original = planningById.get(evaluated.id);
      if (original === undefined) return false;
      const canonicalOriginal = projectRepresentativesV2([original], 1)[0];
      const canonicalEvaluated = projectRepresentativesV2([stripTravel(evaluated)], 1)[0];
      if (
        canonicalOriginal === undefined
        || canonicalEvaluated === undefined
        || JSON.stringify(canonicalEvaluated) !== JSON.stringify(canonicalOriginal)
      ) return false;
    }

    const expectedFrontier = projectRepresentativesV2(
      paretoFrontierV2(calculated.evaluatedCandidates),
      7,
    );
    if (JSON.stringify(expectedFrontier) !== JSON.stringify(calculated.plans)) {
      return false;
    }

    return calculated.plans.every((plan, index) => {
      const route = calculated.travel.kind === "calculated"
        ? calculated.travel.routes[index]
        : undefined;
      const travel = plan.travel;
      return route !== undefined
        && travel !== undefined
        && route.planId === plan.id
        && route.aggregate.calculatedAt === travel.calculatedAt
        && route.aggregate.distanceMeters === travel.distanceMeters
        && route.aggregate.durationSeconds === travel.durationSeconds
        && route.aggregate.providerSourceId === travel.providerSourceId
        && route.aggregate.routeFingerprint === travel.routeFingerprint;
    });
  } catch {
    return false;
  }
}

function finalResponse(
  request: TravelPlanApiRequest,
  planning: TravelPlanApiResponse["planning"],
  travel: TravelCalculationState,
): TravelPlanApiResponse {
  const response = travelPlanApiResponseSchemaFor(request).safeParse({
    contractVersion: 1,
    planning,
    travel,
  });
  if (!response.success) throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
  return response.data;
}

export class TravelPlanCoordinator implements TravelPlanCoordinatorContract {
  private readonly now: () => Date;

  constructor(private readonly dependencies: TravelPlanCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async calculate(
    request: TravelPlanApiRequest,
    signal?: AbortSignal,
  ): Promise<TravelPlanApiResponse> {
    if (signal?.aborted) throw new PlanRequestCancelledError();
    const parsed = travelPlanApiRequestSchema.safeParse(request);
    if (!parsed.success) throw new TravelPlanCoordinatorError("INVALID_REQUEST");
    const input = parsed.data;

    let planning: TravelPlanApiResponse["planning"];
    let completeCandidateSet:
      | { contractVersion: 1; evidence: ExactProductPlanApiEvidenceEnvelope; plans: PlanResultV2[] }
      | { contractVersion: 2; evidence: ReviewedFamilyPlanApiEvidenceEnvelopeV2; plans: PlanResultV2[] };
    if (input.planning.contractVersion === 1) {
      const result = await this.dependencies.planService.calculateExact(
        input.planning,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
      planning = exactPlanningResponse(input.planning, result);
      completeCandidateSet = { contractVersion: 1, ...result.completeCandidateSet };
    } else {
      const result = await this.dependencies.planService.calculateReviewed(
        input.planning,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
      planning = reviewedPlanningResponse(input.planning, result);
      completeCandidateSet = { contractVersion: 2, ...result.completeCandidateSet };
    }

    // The default-off source switch is checked before touching the ephemeral
    // location store or the routing dependencies.
    if (
      !this.dependencies.travelEnabled
      || this.dependencies.locationChoices === undefined
      || this.dependencies.travelService === undefined
    ) {
      return finalResponse(input, planning, unavailable("provider-unavailable"));
    }
    if (planning.plans.length === 0) {
      return finalResponse(input, planning, unavailable("no-route"));
    }

    const evaluatedAt = new Date(planning.generatedAt);
    // Check expiry against fresh server wall time after price planning, rather
    // than a possibly backdated evidence snapshot or the request start time.
    const requestTime = this.now();
    if (!(requestTime instanceof Date) || !Number.isFinite(requestTime.getTime())) {
      throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
    }
    let origin;
    try {
      signal?.throwIfAborted();
      origin = this.dependencies.locationChoices.resolve(
        input.locationSelectionToken,
        requestTime,
      );
      signal?.throwIfAborted();
    } catch (error) {
      throwIfCancelled(error, signal);
      return finalResponse(input, planning, unavailable("provider-unavailable"));
    }
    if (origin === undefined) {
      return finalResponse(input, planning, unavailable("invalid-location"));
    }

    let calculated: TravelServiceResult;
    try {
      calculated = await this.dependencies.travelService.calculate({
        candidates: completeCandidateSet.plans,
        capturedEvaluationTime: evaluatedAt,
        marketContext: { ...input.planning.marketContext },
        mode: input.travelMode,
        origin,
      }, signal);
      if (signal?.aborted) throw new PlanRequestCancelledError();
    } catch (error) {
      throwIfCancelled(error, signal);
      return finalResponse(input, planning, unavailable("provider-unavailable"));
    }

    if (calculated.travel.kind !== "calculated") {
      return calculated.travel.kind === "unavailable"
        ? finalResponse(input, planning, calculated.travel)
        : finalResponse(input, planning, unavailable("provider-unavailable"));
    }
    if (!calculatedTravelOutputIsCoherent(calculated, completeCandidateSet.plans)) {
      return finalResponse(input, planning, unavailable("provider-unavailable"));
    }

    try {
      const filtered = planning.contractVersion === 1
        ? completeCandidateSet.contractVersion === 1
          ? filterExactPlanning(
              planning,
              completeCandidateSet.evidence,
              calculated.plans,
              calculated.travel.routes,
            )
          : undefined
        : completeCandidateSet.contractVersion === 2
          ? filterReviewedPlanning(
              planning,
              completeCandidateSet.evidence,
              calculated.plans,
              calculated.travel.routes,
            )
          : undefined;
      if (filtered === undefined) {
        throw new TravelPlanCoordinatorError("INVALID_SERVICE_RESPONSE");
      }
      return finalResponse(input, filtered, calculated.travel);
    } catch (error) {
      throwIfCancelled(error, signal);
      return finalResponse(input, planning, unavailable("provider-unavailable"));
    }
  }
}

let productionCoordinator: {
  coordinator: TravelPlanCoordinator;
  killSwitchEnabled: boolean;
} | undefined;

export function createCryptographicRouteFingerprint(): string {
  return `route:${randomBytes(32).toString("base64url")}`;
}

export async function getProductionTravelPlanCoordinator(
  values: Record<string, string | undefined> = process.env,
): Promise<TravelPlanCoordinatorContract> {
  // Evaluate the kill switch before consulting the cached runtime. A source
  // disabled after an enabled request must fail closed immediately rather than
  // inheriting the previously constructed routing coordinator.
  const enabled = isValhallaTravelRuntimeEnabled(values);
  if (productionCoordinator?.killSwitchEnabled === enabled) {
    return productionCoordinator.coordinator;
  }
  const { getServerContainer } = await import("../container");
  const container = getServerContainer();
  let coordinator: TravelPlanCoordinator;
  if (!enabled || container.branchDirectory === undefined) {
    coordinator = new TravelPlanCoordinator({
      planService: container.planService,
      travelEnabled: false,
    });
  } else {
    coordinator = new TravelPlanCoordinator({
      locationChoices: getProductionLocationChoiceResolver(),
      planService: container.planService,
      travelEnabled: true,
      travelService: new TravelService({
        branchDirectory: container.branchDirectory,
        createRouteFingerprint: createCryptographicRouteFingerprint,
        routeMatrixGateway: new ValhallaRouteMatrixGateway({ fetch }),
      }),
    });
  }
  productionCoordinator = { coordinator, killSwitchEnabled: enabled };
  return coordinator;
}
