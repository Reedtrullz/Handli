import { z } from "zod";

import {
  basisPointsSchema,
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
} from "./contract-primitives";

export const planObjectivesSchema = z
  .object({
    contractVersion: contractVersionSchema,
    savingsWeightBasisPoints: basisPointsSchema,
    convenienceWeightBasisPoints: basisPointsSchema,
    maxStores: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    includeTravel: z.boolean(),
  })
  .strict()
  .refine(
    ({ savingsWeightBasisPoints, convenienceWeightBasisPoints }) =>
      savingsWeightBasisPoints + convenienceWeightBasisPoints === 10_000,
    {
      message: "Savings and convenience weights must total exactly 10,000 basis points",
      path: ["convenienceWeightBasisPoints"],
    },
  );

export type PlanObjectives = z.infer<typeof planObjectivesSchema>;

const travelNotRequestedSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("not-requested"),
  })
  .strict();

const travelUnavailableSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("unavailable"),
    reason: z.enum(["provider-unavailable", "no-route", "invalid-location", "timeout"]),
  })
  .strict();

const travelCalculatedSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("calculated"),
    durationSeconds: nonNegativeSafeIntegerSchema,
    distanceMeters: nonNegativeSafeIntegerSchema,
    providerSourceId: identifierSchema,
    calculatedAt: canonicalTimestampSchema,
    routeFingerprint: identifierSchema,
  })
  .strict();

export const travelResultSchema = z.discriminatedUnion("kind", [
  travelNotRequestedSchema,
  travelUnavailableSchema,
  travelCalculatedSchema,
]);

export type TravelResult = z.infer<typeof travelResultSchema>;

const evidenceBackedExplanationKinds = new Set(["savings", "coverage", "travel"]);

export const planExplanationSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.enum(["savings", "convenience", "coverage", "substitution", "surplus", "travel"]),
    message: nonEmptyStringSchema,
    evidenceIds: z.array(identifierSchema),
  })
  .strict()
  .superRefine(({ kind, evidenceIds }, context) => {
    if (!hasUniqueStrings(evidenceIds)) {
      context.addIssue({
        code: "custom",
        message: "Explanation evidence IDs must be unique",
        path: ["evidenceIds"],
      });
    }
    if (evidenceBackedExplanationKinds.has(kind) && evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Evidence-backed explanations require at least one evidence ID",
        path: ["evidenceIds"],
      });
    }
  });

export type PlanExplanation = z.infer<typeof planExplanationSchema>;
