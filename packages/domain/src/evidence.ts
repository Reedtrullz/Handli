import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  isFiniteDate,
  nonEmptyStringSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";
import {
  geographicContextSchema,
  geographicScopeIncludes,
  geographicScopeSchema,
  type GeographicContext,
} from "./geography";

export const evidenceLevelSchema = z.enum(["authoritative", "reviewed", "observed", "ambiguous"]);

export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

export const evidenceSourceSchema = z
  .object({
    contractVersion: contractVersionSchema,
    id: sourceIdSchema,
    displayName: nonEmptyStringSchema,
    kind: z.enum(["retailer", "licensed-aggregator", "catalog-api", "manual", "legacy-import"]),
    state: z.enum(["approved", "conditional", "blocked", "revoked"]),
    defaultEvidenceLevel: evidenceLevelSchema,
  })
  .strict();

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

const exactProductMatchSchema = z
  .object({
    kind: z.literal("exact"),
    canonicalProductId: identifierSchema,
  })
  .strict();

const ambiguousProductMatchSchema = z
  .object({
    kind: z.literal("ambiguous"),
    candidateProductIds: z.array(identifierSchema).min(2),
  })
  .strict()
  .refine(({ candidateProductIds }) => hasUniqueStrings(candidateProductIds), {
    message: "Ambiguous candidate product IDs must be unique",
    path: ["candidateProductIds"],
  });

export const evidenceProductMatchSchema = z.discriminatedUnion("kind", [
  exactProductMatchSchema,
  ambiguousProductMatchSchema,
]);

export type EvidenceProductMatch = z.infer<typeof evidenceProductMatchSchema>;

export const priceEvidenceSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("price-evidence"),
    id: identifierSchema,
    sourceId: sourceIdSchema,
    sourceRecordId: identifierSchema,
    chainId: identifierSchema,
    productMatch: evidenceProductMatchSchema,
    amountOre: moneyOreSchema,
    priceKind: z.enum(["ordinary", "checkout"]),
    evidenceLevel: evidenceLevelSchema,
    observedAt: canonicalTimestampSchema,
    validFrom: canonicalTimestampSchema.optional(),
    validUntil: canonicalTimestampSchema.optional(),
    geographicScope: geographicScopeSchema,
  })
  .strict()
  .superRefine(({ validFrom, validUntil }, context) => {
    if (
      validFrom !== undefined &&
      validUntil !== undefined &&
      Date.parse(validFrom) >= Date.parse(validUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "Price evidence cannot expire before it becomes valid",
        path: ["validUntil"],
      });
    }
  });

export type PriceEvidence = z.infer<typeof priceEvidenceSchema>;

export interface PriceEvidenceEligibilityContext {
  now: Date;
  maxAgeMs: number;
  location: GeographicContext;
  enabledSourceIds: readonly string[];
}

export type PriceEvidenceEligibilityResult =
  | { eligible: true; evidence: PriceEvidence }
  | {
      eligible: false;
      reason:
        | "invalid"
        | "source-disabled"
        | "ambiguous"
        | "future"
        | "stale"
        | "not-yet-valid"
        | "expired"
        | "wrong-scope";
    };

export function parseEligiblePriceEvidence(
  input: unknown,
  context: PriceEvidenceEligibilityContext,
): PriceEvidenceEligibilityResult {
  const parsed = priceEvidenceSchema.safeParse(input);
  const parsedLocation = geographicContextSchema.safeParse(context.location);
  if (
    !parsed.success ||
    !parsedLocation.success ||
    !isFiniteDate(context.now) ||
    !Number.isSafeInteger(context.maxAgeMs) ||
    context.maxAgeMs < 0
  ) {
    return { eligible: false, reason: "invalid" };
  }

  const evidence = parsed.data;
  if (!context.enabledSourceIds.includes(evidence.sourceId)) {
    return { eligible: false, reason: "source-disabled" };
  }
  if (evidence.productMatch.kind === "ambiguous" || evidence.evidenceLevel === "ambiguous") {
    return { eligible: false, reason: "ambiguous" };
  }

  const nowMs = context.now.getTime();
  const observedAtMs = Date.parse(evidence.observedAt);
  if (observedAtMs > nowMs) {
    return { eligible: false, reason: "future" };
  }
  if (nowMs - observedAtMs > context.maxAgeMs) {
    return { eligible: false, reason: "stale" };
  }
  if (evidence.validFrom !== undefined && nowMs < Date.parse(evidence.validFrom)) {
    return { eligible: false, reason: "not-yet-valid" };
  }
  if (evidence.validUntil !== undefined && nowMs > Date.parse(evidence.validUntil)) {
    return { eligible: false, reason: "expired" };
  }
  if (!geographicScopeIncludes(evidence.geographicScope, parsedLocation.data)) {
    return { eligible: false, reason: "wrong-scope" };
  }

  return { eligible: true, evidence };
}
