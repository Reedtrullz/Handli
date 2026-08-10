import {
  attachOptionalTravelEvidenceV2,
  chooseBestRoundTrip,
  identifierSchema,
  isFiniteDate,
  marketContextV1Schema,
  marketContextsEqual,
  paretoFrontierV2,
  planResultV2Schema,
  projectRepresentativesV2,
  routeMatrixSchema,
  sourceIdSchema,
  travelCalculationStateSchema,
  travelCoordinateSchema,
  travelModeSchema,
  type FrontierPlanV2,
  type MatrixBranchCandidate,
  type MarketContextV1,
  type PlanResultV2,
  type PlanTravelEvidence,
  type TravelCalculationState,
  type TravelChainId,
  type TravelCoordinate,
  type TravelMode,
  type TravelRouteEvidence,
} from "@handleplan/domain";

import {
  MAX_TRAVEL_RADIUS_METERS,
  TravelGatewayTimeoutError,
  branchDirectorySnapshotSchema,
  routeMatrixGatewayRequestSchema,
  type BranchDirectory,
  type RouteMatrixGateway,
} from "./gateways";

const DEFAULT_TRAVEL_RADIUS_METERS = MAX_TRAVEL_RADIUS_METERS;
const EARTH_RADIUS_METERS = 6_371_008.8;
const CHAIN_ORDER: Readonly<Record<TravelChainId, number>> = {
  bunnpris: 0,
  extra: 1,
  "rema-1000": 2,
};

type TravelUnavailableReason = Extract<
  TravelCalculationState,
  { kind: "unavailable" }
>["reason"];

export interface TravelServiceInput {
  /** Ephemeral server-side value. It is never included in the result. */
  origin: TravelCoordinate;
  mode: TravelMode;
  capturedEvaluationTime: Date;
  candidates: readonly PlanResultV2[];
  marketContext: MarketContextV1;
}

export interface TravelServiceResult {
  /**
   * Internal-only full candidate cohort with the exact travel evidence used
   * for ranking. Present only for a calculated result and never serialized by
   * a public route.
   */
  evaluatedCandidates?: FrontierPlanV2[];
  plans: FrontierPlanV2[];
  travel: TravelCalculationState;
}

export interface TravelServiceDependencies {
  branchDirectory: BranchDirectory;
  routeMatrixGateway: RouteMatrixGateway;
  /** Must return an opaque identifier sourced exclusively from injected randomness. */
  createRouteFingerprint: () => string;
  branchRadiusMeters?: number;
}

export class TravelServiceInputError extends Error {
  constructor(message = "Travel calculation input is invalid") {
    super(message);
    this.name = "TravelServiceInputError";
  }
}

interface RouteSelection {
  distanceMeters: number;
  durationSeconds: number;
  stops: TravelRouteEvidence["stops"];
}

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
      (key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]),
    );
}

function parseCandidates(candidates: readonly PlanResultV2[]): PlanResultV2[] {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 7) {
    throw new TravelServiceInputError();
  }
  const parsed = candidates.map((candidate) => {
    const result = planResultV2Schema.safeParse(candidate);
    if (!result.success || !sameJsonValue(candidate, result.data)) {
      throw new TravelServiceInputError();
    }
    return result.data;
  });
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new TravelServiceInputError("Travel candidates must have unique plan IDs");
  }
  return parsed.sort((left, right) => compareText(left.id, right.id));
}

function requiredChains(candidates: readonly PlanResultV2[]): TravelChainId[] {
  return [...new Set(candidates.flatMap(({ chains }) => chains))].sort(
    (left, right) => CHAIN_ORDER[left] - CHAIN_ORDER[right],
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function distanceMeters(left: TravelCoordinate, right: TravelCoordinate): number {
  const leftLatitude = degreesToRadians(left.latitudeE6 / 1_000_000);
  const rightLatitude = degreesToRadians(right.latitudeE6 / 1_000_000);
  const latitudeDelta = rightLatitude - leftLatitude;
  const longitudeDelta = degreesToRadians(
    (right.longitudeE6 - left.longitudeE6) / 1_000_000,
  );
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function unavailable(
  plans: readonly PlanResultV2[],
  reason: TravelUnavailableReason,
): TravelServiceResult {
  return {
    plans: projectRepresentativesV2(plans, 7),
    travel: { contractVersion: 1, kind: "unavailable", reason },
  };
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted();
  if (isAbortError(error)) throw error;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof TravelGatewayTimeoutError
    || (isRecord(error) && error.name === "TimeoutError");
}

function exactIdentifier(value: unknown): value is string {
  const parsed = identifierSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

export class TravelService {
  private readonly branchRadiusMeters: number;

  constructor(private readonly dependencies: TravelServiceDependencies) {
    const radius = dependencies.branchRadiusMeters ?? DEFAULT_TRAVEL_RADIUS_METERS;
    if (!Number.isSafeInteger(radius) || radius < 1 || radius > MAX_TRAVEL_RADIUS_METERS) {
      throw new TravelServiceInputError("Travel radius must be a server-owned 1..50000 metre bound");
    }
    this.branchRadiusMeters = radius;
  }

  async calculate(
    input: TravelServiceInput,
    signal?: AbortSignal,
  ): Promise<TravelServiceResult> {
    signal?.throwIfAborted();
    const candidates = parseCandidates(input.candidates);
    const parsedMode = travelModeSchema.safeParse(input.mode);
    const parsedMarket = marketContextV1Schema.safeParse(input.marketContext);
    if (
      !parsedMode.success
      || !parsedMarket.success
      || !(input.capturedEvaluationTime instanceof Date)
      || !isFiniteDate(input.capturedEvaluationTime)
    ) {
      throw new TravelServiceInputError();
    }
    const parsedOrigin = travelCoordinateSchema.safeParse(input.origin);
    if (!parsedOrigin.success || !sameJsonValue(input.origin, parsedOrigin.data)) {
      return unavailable(candidates, "invalid-location");
    }
    const providerSource = sourceIdSchema.safeParse(
      this.dependencies.routeMatrixGateway.providerSourceId,
    );
    if (!providerSource.success || providerSource.data
      !== this.dependencies.routeMatrixGateway.providerSourceId) {
      return unavailable(candidates, "provider-unavailable");
    }

    const chains = requiredChains(candidates);
    let rawSnapshot: unknown;
    try {
      rawSnapshot = await this.dependencies.branchDirectory.loadEligibleBranches({
        eligibleChainIds: chains,
        evaluatedAt: new Date(input.capturedEvaluationTime),
        marketContext: { ...parsedMarket.data },
      }, signal);
      signal?.throwIfAborted();
    } catch (error) {
      rethrowCancellation(error, signal);
      return unavailable(
        candidates,
        isTimeoutError(error) ? "timeout" : "branch-data-unavailable",
      );
    }

    const snapshot = branchDirectorySnapshotSchema.safeParse(rawSnapshot);
    if (
      !snapshot.success
      || !snapshot.data.complete
      || !sameStringSet(snapshot.data.eligibleChainIds, chains)
      || !marketContextsEqual(snapshot.data.marketContext, parsedMarket.data)
    ) {
      return unavailable(candidates, "branch-data-unavailable");
    }

    const selectedBranches = chains.flatMap((chainId) => snapshot.data.branches
      .filter((branch) => branch.chainId === chainId)
      .map((branch) => ({
        branch,
        distanceMeters: distanceMeters(parsedOrigin.data, branch.coordinate),
      }))
      .filter(({ distanceMeters: distance }) =>
        Number.isFinite(distance) && distance <= this.branchRadiusMeters)
      .sort((left, right) => left.distanceMeters - right.distanceMeters
        || compareText(left.branch.branchId, right.branch.branchId))
      .slice(0, 3)
      .map(({ branch }) => branch));
    if (chains.some((chainId) =>
      !selectedBranches.some((branch) => branch.chainId === chainId))) {
      return unavailable(candidates, "branch-data-unavailable");
    }

    const points = [
      parsedOrigin.data,
      ...selectedBranches.map(({ coordinate }) => coordinate),
    ];
    const matrixRequest = routeMatrixGatewayRequestSchema.safeParse({
      mode: parsedMode.data,
      points,
    });
    if (!matrixRequest.success) return unavailable(candidates, "no-route");

    let rawMatrix: unknown;
    try {
      signal?.throwIfAborted();
      rawMatrix = await this.dependencies.routeMatrixGateway.calculateMatrix(
        matrixRequest.data,
        signal,
      );
      signal?.throwIfAborted();
    } catch (error) {
      rethrowCancellation(error, signal);
      return unavailable(
        candidates,
        isTimeoutError(error) ? "timeout" : "provider-unavailable",
      );
    }

    const matrix = routeMatrixSchema.safeParse(rawMatrix);
    if (
      !matrix.success
      || matrix.data.cells.length !== points.length
      || matrix.data.cells.some((row) =>
        row.length !== points.length || row.some((cell) => cell === null))
    ) {
      return unavailable(candidates, "no-route");
    }

    const matrixBranches: MatrixBranchCandidate[] = selectedBranches.map((branch, index) => ({
      ...branch,
      matrixIndex: index + 1,
    }));
    const selections = new Map<string, RouteSelection>();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const selection = chooseBestRoundTrip({
        branches: matrixBranches.filter(({ chainId }) => candidate.chains.includes(chainId)),
        matrix: matrix.data,
        requiredChains: candidate.chains,
      });
      if (selection === undefined) return unavailable(candidates, "no-route");
      selections.set(candidate.id, selection);
    }

    const calculatedAt = input.capturedEvaluationTime.toISOString();
    const publicRoutes = new Map<string, TravelRouteEvidence>();
    const travelEvidence: PlanTravelEvidence[] = [];
    const fingerprints = new Set<string>();
    try {
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        const selection = selections.get(candidate.id);
        if (selection === undefined) return unavailable(candidates, "no-route");
        const routeFingerprint = this.dependencies.createRouteFingerprint();
        if (!exactIdentifier(routeFingerprint) || fingerprints.has(routeFingerprint)) {
          return unavailable(candidates, "provider-unavailable");
        }
        fingerprints.add(routeFingerprint);
        const aggregate = {
          calculatedAt,
          distanceMeters: selection.distanceMeters,
          durationSeconds: selection.durationSeconds,
          mode: parsedMode.data,
          providerSourceId: providerSource.data,
          routeFingerprint,
        };
        publicRoutes.set(candidate.id, {
          aggregate,
          planId: candidate.id,
          stops: selection.stops,
        });
        travelEvidence.push({
          planId: candidate.id,
          travel: {
            calculatedAt: aggregate.calculatedAt,
            contractVersion: 1,
            distanceMeters: aggregate.distanceMeters,
            durationSeconds: aggregate.durationSeconds,
            kind: "calculated",
            providerSourceId: aggregate.providerSourceId,
            routeFingerprint: aggregate.routeFingerprint,
          },
        });
      }
    } catch (error) {
      rethrowCancellation(error, signal);
      return unavailable(candidates, "provider-unavailable");
    }

    // Travel is attached to the entire complete-candidate set before either
    // Pareto filtering or representative projection. No partial cohort escapes.
    const attached = attachOptionalTravelEvidenceV2(candidates, travelEvidence);
    if (
      attached.length !== candidates.length
      || attached.some(({ travel }) => travel?.kind !== "calculated")
    ) {
      return unavailable(candidates, "provider-unavailable");
    }
    const plans = projectRepresentativesV2(paretoFrontierV2(attached), 7);
    if (plans.length < 1 || plans.some(({ travel }) => travel === undefined)) {
      return unavailable(candidates, "provider-unavailable");
    }
    const routes = plans.map(({ id }) => publicRoutes.get(id));
    if (routes.some((route) => route === undefined)) {
      return unavailable(candidates, "provider-unavailable");
    }
    const state = travelCalculationStateSchema.safeParse({
      contractVersion: 1,
      kind: "calculated",
      routes,
    });
    if (!state.success || state.data.kind !== "calculated") {
      return unavailable(candidates, "provider-unavailable");
    }
    return { evaluatedCandidates: attached, plans, travel: state.data };
  }
}
