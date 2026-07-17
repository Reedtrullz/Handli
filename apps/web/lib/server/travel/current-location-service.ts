import "server-only";

import {
  currentLocationRequestSchema,
  currentLocationResponseSchema,
  type CurrentLocationRequest,
  type CurrentLocationResponse,
} from "@handleplan/domain";

import {
  getProductionLocationChoiceIssuer,
  LOCATION_CHOICE_TTL_MS,
  type LocationChoiceIssuer,
} from "./location-search-service";
import { isValhallaTravelRuntimeEnabled } from "./travel-runtime-gate";

export type CurrentLocationServiceErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_CANCELLED"
  | "UNAVAILABLE";

export class CurrentLocationServiceError extends Error {
  constructor(readonly code: CurrentLocationServiceErrorCode) {
    super(`Current location failed: ${code}`);
    this.name = "CurrentLocationServiceError";
  }
}

export interface CurrentLocationServiceContract {
  issue(
    input: CurrentLocationRequest,
    signal?: AbortSignal,
  ): Promise<CurrentLocationResponse>;
}

export interface CurrentLocationServiceDependencies {
  choices: LocationChoiceIssuer;
  now?: () => Date;
}

function finiteDate(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("A finite date is required");
  return milliseconds;
}

/**
 * Converts an explicitly volunteered browser coordinate into a short-lived
 * opaque choice. The coordinate remains only in the bounded process-memory
 * store shared with the route calculator; it is never returned or persisted.
 */
export class CurrentLocationService implements CurrentLocationServiceContract {
  private readonly now: () => Date;

  constructor(private readonly dependencies: CurrentLocationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async issue(
    input: CurrentLocationRequest,
    signal?: AbortSignal,
  ): Promise<CurrentLocationResponse> {
    const request = currentLocationRequestSchema.safeParse(input);
    if (!request.success) throw new CurrentLocationServiceError("INVALID_REQUEST");
    if (signal?.aborted) throw new CurrentLocationServiceError("REQUEST_CANCELLED");

    try {
      const generatedAt = this.now();
      const generatedAtMs = finiteDate(generatedAt);
      if (signal?.aborted) throw new CurrentLocationServiceError("REQUEST_CANCELLED");
      const [selectionToken] = this.dependencies.choices.issueMany(
        [request.data.coordinate],
        generatedAt,
      );
      if (selectionToken === undefined) throw new Error("Location token issuance failed");

      return currentLocationResponseSchema.parse({
        contractVersion: 1,
        expiresAt: new Date(generatedAtMs + LOCATION_CHOICE_TTL_MS).toISOString(),
        generatedAt: generatedAt.toISOString(),
        selectionToken,
      });
    } catch (error) {
      if (error instanceof CurrentLocationServiceError) throw error;
      if (signal?.aborted) throw new CurrentLocationServiceError("REQUEST_CANCELLED");
      throw new CurrentLocationServiceError("UNAVAILABLE");
    }
  }
}

let productionService: CurrentLocationService | undefined;

export function getProductionCurrentLocationService(
  values: Record<string, string | undefined> = process.env,
): CurrentLocationServiceContract {
  if (!isValhallaTravelRuntimeEnabled(values)) {
    throw new CurrentLocationServiceError("UNAVAILABLE");
  }
  productionService ??= new CurrentLocationService({
    choices: getProductionLocationChoiceIssuer(),
  });
  return productionService;
}
