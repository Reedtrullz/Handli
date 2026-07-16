import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  sourceIdSchema,
} from "./contract-primitives";

const pricedCoverageSchema = z
  .object({
    kind: z.literal("priced"),
    evidenceId: identifierSchema,
  })
  .strict();

const knownNotCarriedCoverageSchema = z
  .object({
    kind: z.literal("known-not-carried"),
    sourceId: sourceIdSchema,
    checkedAt: canonicalTimestampSchema,
  })
  .strict();

const staleCoverageSchema = z
  .object({
    kind: z.literal("stale"),
    evidenceId: identifierSchema,
    observedAt: canonicalTimestampSchema,
    staleAt: canonicalTimestampSchema,
  })
  .strict()
  .refine(({ observedAt, staleAt }) => Date.parse(staleAt) > Date.parse(observedAt), {
    message: "Evidence can become stale only after it was observed",
    path: ["staleAt"],
  });

const ineligibleCoverageSchema = z
  .object({
    kind: z.literal("ineligible"),
    evidenceId: identifierSchema.optional(),
    reason: z.enum([
      "source-disabled",
      "ambiguous-product",
      "wrong-scope",
      "not-yet-valid",
      "expired",
      "membership-disabled",
      "invalid-evidence",
    ]),
    evaluatedAt: canonicalTimestampSchema,
  })
  .strict();

const unknownCoverageSchema = z
  .object({
    kind: z.literal("unknown"),
    reason: z.enum([
      "not-checked",
      "source-unavailable",
    ]),
    checkedAt: canonicalTimestampSchema.optional(),
  })
  .strict();

export const coverageStatusSchema = z.discriminatedUnion("kind", [
  pricedCoverageSchema,
  knownNotCarriedCoverageSchema,
  staleCoverageSchema,
  ineligibleCoverageSchema,
  unknownCoverageSchema,
]);

export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

export function isKnownAbsent(status: CoverageStatus): boolean {
  return status.kind === "known-not-carried";
}

export const comparisonScopeSchema = z
  .object({
    contractVersion: contractVersionSchema,
    completeness: z.enum(["complete", "partial"]),
    evaluatedAt: canonicalTimestampSchema,
    expectedChainIds: z.array(identifierSchema).min(1),
    entries: z
      .array(
        z
          .object({
            chainId: identifierSchema,
            status: coverageStatusSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine(({ completeness, entries, expectedChainIds }, context) => {
    if (!hasUniqueStrings(expectedChainIds)) {
      context.addIssue({
        code: "custom",
        message: "Expected comparison chains must be unique",
        path: ["expectedChainIds"],
      });
    }
    if (!hasUniqueStrings(entries.map(({ chainId }) => chainId))) {
      context.addIssue({
        code: "custom",
        message: "Comparison scope chains must be unique",
        path: ["entries"],
      });
    }
    const actualChainIds = new Set(entries.map(({ chainId }) => chainId));
    if (
      actualChainIds.size !== expectedChainIds.length ||
      expectedChainIds.some((chainId) => !actualChainIds.has(chainId))
    ) {
      context.addIssue({
        code: "custom",
        message: "Comparison entries must match the declared expected chains",
        path: ["entries"],
      });
    }
    if (
      completeness === "complete" &&
      entries.some(({ status }) => !["priced", "known-not-carried"].includes(status.kind))
    ) {
      context.addIssue({
        code: "custom",
        message: "A complete comparison scope cannot contain unresolved coverage",
        path: ["completeness"],
      });
    }
  });

export type ComparisonScope = z.infer<typeof comparisonScopeSchema>;
