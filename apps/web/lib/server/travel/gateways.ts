import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  internalGeocodedCandidateSchema,
  internalTravelBranchSchema,
  marketContextV1Schema,
  nonEmptyStringSchema,
  sourceIdSchema,
  travelChainIdSchema,
  travelCoordinateSchema,
  travelModeSchema,
  type InternalGeocodedCandidate,
  type InternalTravelBranch,
  type MarketContextV1,
  type RouteMatrix,
  type TravelChainId,
  type TravelCoordinate,
  type TravelMode,
} from "@handleplan/domain";
import { z } from "zod";

export const MAX_GEOCODER_CANDIDATES = 5;
export const MAX_BRANCH_DIRECTORY_BRANCHES = 5_000;
export const MAX_ROUTE_MATRIX_POINTS = 10;
export const MAX_TRAVEL_RADIUS_METERS = 50_000;

export const geocoderGatewayResultSchema = z
  .object({
    candidates: z.array(internalGeocodedCandidateSchema).max(MAX_GEOCODER_CANDIDATES),
    contractVersion: contractVersionSchema,
    providerSourceId: sourceIdSchema,
  })
  .strict()
  .superRefine(({ candidates }, context) => {
    if (!hasUniqueStrings(candidates.map(({ selectionId }) => selectionId))) {
      context.addIssue({
        code: "custom",
        message: "Geocoder selection identifiers must be unique",
        path: ["candidates"],
      });
    }
  });

export type GeocoderGatewayResult = z.infer<typeof geocoderGatewayResultSchema>;

export interface GeocoderGateway {
  search(query: string, signal?: AbortSignal): Promise<GeocoderGatewayResult>;
}

export const branchDirectorySnapshotSchema = z
  .object({
    branches: z.array(internalTravelBranchSchema).max(MAX_BRANCH_DIRECTORY_BRANCHES),
    complete: z.boolean(),
    contractVersion: contractVersionSchema,
    eligibleChainIds: z.array(travelChainIdSchema).min(1).max(3),
    marketContext: marketContextV1Schema,
    regionEvidence: z.object({
      contractVersion: z.literal(1),
      countryCode: z.literal("NO"),
      directoryEvidenceReference: nonEmptyStringSchema,
      directoryVersionId: nonEmptyStringSchema,
      regionEvidenceReference: nonEmptyStringSchema,
      regionId: nonEmptyStringSchema,
      reviewedAt: canonicalTimestampSchema,
    }).strict().optional(),
  })
  .strict()
  .superRefine(({ branches, eligibleChainIds, marketContext, regionEvidence }, context) => {
    if (!hasUniqueStrings(eligibleChainIds)) {
      context.addIssue({
        code: "custom",
        message: "Eligible chain identifiers must be unique",
        path: ["eligibleChainIds"],
      });
    }
    if (!hasUniqueStrings(branches.map(({ branchId }) => branchId))) {
      context.addIssue({
        code: "custom",
        message: "Branch identifiers must be unique",
        path: ["branches"],
      });
    }
    branches.forEach(({ chainId }, index) => {
      if (!eligibleChainIds.includes(chainId)) {
        context.addIssue({
          code: "custom",
          message: "Every branch must belong to a declared eligible chain",
          path: ["branches", index, "chainId"],
        });
      }
    });
    if (marketContext.kind === "national" && regionEvidence !== undefined) {
      context.addIssue({
        code: "custom",
        message: "National branch snapshots cannot claim regional evidence",
        path: ["regionEvidence"],
      });
    }
    if (
      marketContext.kind === "launch-region"
      && (
        regionEvidence === undefined
        || regionEvidence.countryCode !== marketContext.countryCode
        || regionEvidence.regionId !== marketContext.regionId
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Launch-region branch snapshots require matching directory evidence",
        path: ["regionEvidence"],
      });
    }
  });

export type BranchDirectorySnapshot = z.infer<typeof branchDirectorySnapshotSchema>;

export interface BranchDirectoryQuery {
  eligibleChainIds: readonly TravelChainId[];
  evaluatedAt: Date;
  marketContext: MarketContextV1;
}

export interface BranchDirectory {
  loadEligibleBranches(
    query: BranchDirectoryQuery,
    signal?: AbortSignal,
  ): Promise<BranchDirectorySnapshot>;
}

export const routeMatrixGatewayRequestSchema = z
  .object({
    mode: travelModeSchema,
    points: z.array(travelCoordinateSchema).min(2).max(MAX_ROUTE_MATRIX_POINTS),
  })
  .strict();

export type RouteMatrixGatewayRequest = z.infer<typeof routeMatrixGatewayRequestSchema>;

export interface RouteMatrixGateway {
  /** Fixed adapter identity. Provider URLs and credentials never enter a request. */
  readonly providerSourceId: string;
  calculateMatrix(
    request: RouteMatrixGatewayRequest,
    signal?: AbortSignal,
  ): Promise<RouteMatrix>;
}

export class BranchDirectoryUnavailableError extends Error {
  constructor(message = "Branch directory is unavailable") {
    super(message);
    this.name = "BranchDirectoryUnavailableError";
  }
}

export class TravelGatewayTimeoutError extends Error {
  constructor(message = "Travel gateway timed out") {
    super(message);
    this.name = "TravelGatewayTimeoutError";
  }
}

// Explicit exports make the provider boundary inspectable without allowing
// adapter implementations to add caller-controlled URLs or other transport data.
export type {
  InternalGeocodedCandidate,
  InternalTravelBranch,
  TravelChainId,
  TravelCoordinate,
  TravelMode,
};

export const gatewayBoundarySchemas = {
  branchDirectorySnapshot: branchDirectorySnapshotSchema,
  capturedAt: canonicalTimestampSchema,
  geocoderResult: geocoderGatewayResultSchema,
  geocoderSearchQuery: nonEmptyStringSchema,
  routeMatrixRequest: routeMatrixGatewayRequestSchema,
} as const;
