import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";

export const travelModeSchema = z.enum(["car", "bike"]);
export type TravelMode = z.infer<typeof travelModeSchema>;

export const travelChainIdSchema = z.enum(["bunnpris", "extra", "rema-1000"]);
export type TravelChainId = z.infer<typeof travelChainIdSchema>;

export const travelCoordinateSchema = z
  .object({
    latitudeE6: z.number().int().min(-90_000_000).max(90_000_000),
    longitudeE6: z.number().int().min(-180_000_000).max(180_000_000),
  })
  .strict();
export type TravelCoordinate = z.infer<typeof travelCoordinateSchema>;

export const internalTravelBranchSchema = z
  .object({
    branchId: identifierSchema,
    chainId: travelChainIdSchema,
    coordinate: travelCoordinateSchema,
    name: nonEmptyStringSchema,
  })
  .strict();
export type InternalTravelBranch = z.infer<typeof internalTravelBranchSchema>;

export const internalGeocodedCandidateSchema = z
  .object({
    coordinate: travelCoordinateSchema,
    label: nonEmptyStringSchema,
    selectionId: identifierSchema,
  })
  .strict();
export type InternalGeocodedCandidate = z.infer<typeof internalGeocodedCandidateSchema>;

export const locationSearchRequestSchema = z
  .object({
    contractVersion: contractVersionSchema,
    query: z.string().trim().min(2).max(160),
  })
  .strict();
export type LocationSearchRequest = z.infer<typeof locationSearchRequestSchema>;

export const publicLocationCandidateSchema = z
  .object({
    matchQuality: z.enum(["exact", "approximate"]),
    selectionToken: z.string().regex(/^location-choice:[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type PublicLocationCandidate = z.infer<typeof publicLocationCandidateSchema>;

export const locationSearchResponseSchema = z
  .object({
    candidates: z.array(publicLocationCandidateSchema).max(5),
    contractVersion: contractVersionSchema,
    expiresAt: canonicalTimestampSchema,
    generatedAt: canonicalTimestampSchema,
    source: z
      .object({
        displayName: nonEmptyStringSchema,
        id: sourceIdSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine(({ candidates, expiresAt, generatedAt }, context) => {
    if (!hasUniqueStrings(candidates.map(({ selectionToken }) => selectionToken))) {
      context.addIssue({
        code: "custom",
        message: "Location choice tokens must be unique",
        path: ["candidates"],
      });
    }
    const lifetimeMs = Date.parse(expiresAt) - Date.parse(generatedAt);
    if (lifetimeMs <= 0 || lifetimeMs > 5 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        message: "Location choice tokens must expire within five minutes",
        path: ["expiresAt"],
      });
    }
  });
export type LocationSearchResponse = z.infer<typeof locationSearchResponseSchema>;

export const routeMatrixCellSchema = z
  .object({
    distanceMeters: nonNegativeSafeIntegerSchema,
    durationSeconds: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const routeMatrixSchema = z
  .object({
    cells: z.array(z.array(routeMatrixCellSchema.nullable()).min(2).max(10)).min(2).max(10),
    contractVersion: contractVersionSchema,
  })
  .strict()
  .superRefine(({ cells }, context) => {
    if (cells.some((row) => row.length !== cells.length)) {
      context.addIssue({
        code: "custom",
        message: "Route matrices must be square",
        path: ["cells"],
      });
    }
  });
export type RouteMatrix = z.infer<typeof routeMatrixSchema>;

export const travelPublicBranchStopSchema = z
  .object({
    branchId: identifierSchema,
    chainId: travelChainIdSchema,
    name: nonEmptyStringSchema,
    sequence: positiveSafeIntegerSchema.max(3),
  })
  .strict();
export type TravelPublicBranchStop = z.infer<typeof travelPublicBranchStopSchema>;

export const travelRouteAggregateSchema = z
  .object({
    calculatedAt: canonicalTimestampSchema,
    distanceMeters: nonNegativeSafeIntegerSchema,
    durationSeconds: nonNegativeSafeIntegerSchema,
    providerSourceId: sourceIdSchema,
    routeFingerprint: identifierSchema,
  })
  .strict();
export type TravelRouteAggregate = z.infer<typeof travelRouteAggregateSchema>;

export const travelRouteEvidenceSchema = z
  .object({
    aggregate: travelRouteAggregateSchema,
    planId: identifierSchema,
    stops: z.array(travelPublicBranchStopSchema).min(1).max(3),
  })
  .strict()
  .superRefine(({ stops }, context) => {
    const branchIds = stops.map(({ branchId }) => branchId);
    const chainIds = stops.map(({ chainId }) => chainId);
    if (!hasUniqueStrings(branchIds) || !hasUniqueStrings(chainIds)) {
      context.addIssue({
        code: "custom",
        message: "A public route must use one unique branch per chain",
        path: ["stops"],
      });
    }
    if (stops.some(({ sequence }, index) => sequence !== index + 1)) {
      context.addIssue({
        code: "custom",
        message: "Public route sequences must be contiguous",
        path: ["stops"],
      });
    }
  });
export type TravelRouteEvidence = z.infer<typeof travelRouteEvidenceSchema>;

const travelUnavailableReasonSchema = z.enum([
  "branch-data-unavailable",
  "invalid-location",
  "no-route",
  "provider-unavailable",
  "timeout",
]);

export const travelCalculationStateSchema = z.discriminatedUnion("kind", [
  z.object({ contractVersion: contractVersionSchema, kind: z.literal("not-requested") }).strict(),
  z.object({
    contractVersion: contractVersionSchema,
    kind: z.literal("unavailable"),
    reason: travelUnavailableReasonSchema,
  }).strict(),
  z.object({
    contractVersion: contractVersionSchema,
    kind: z.literal("calculated"),
    routes: z.array(travelRouteEvidenceSchema).min(1).max(7),
  }).strict().superRefine(({ routes }, context) => {
    if (
      !hasUniqueStrings(routes.map(({ planId }) => planId))
      || !hasUniqueStrings(routes.map(({ aggregate }) => aggregate.routeFingerprint))
    ) {
      context.addIssue({
        code: "custom",
        message: "Travel routes must be unique by plan and opaque route fingerprint",
        path: ["routes"],
      });
    }
  }),
]);
export type TravelCalculationState = z.infer<typeof travelCalculationStateSchema>;
