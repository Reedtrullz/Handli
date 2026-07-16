import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  DOMAIN_CONTRACT_VERSION,
  hasUniqueStrings,
  identifierSchema,
  isFiniteDate,
  sourceIdSchema,
} from "./contract-primitives";
import {
  geographicContextSchema,
  geographicScopeIncludes,
  geographicScopeSchema,
} from "./geography";
import {
  parseEligiblePriceEvidence,
  priceEvidenceSchema,
  type PriceEvidence,
  type PriceEvidenceEligibilityContext,
} from "./evidence";

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

export const coverageCheckSchema = z
  .object({
    contractVersion: contractVersionSchema,
    id: identifierSchema,
    sourceId: sourceIdSchema,
    canonicalProductId: identifierSchema,
    chainId: identifierSchema,
    state: z.enum(["known-not-carried", "source-unavailable"]),
    checkedAt: canonicalTimestampSchema,
    geographicScope: geographicScopeSchema,
  })
  .strict();

export type CoverageCheck = z.infer<typeof coverageCheckSchema>;

export interface ComparisonScopeDerivationInput {
  canonicalProductId: string;
  expectedChainIds: readonly string[];
  priceEvidence: readonly unknown[];
  coverageChecks: readonly unknown[];
  context: PriceEvidenceEligibilityContext;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableFingerprint(input: unknown): string {
  return JSON.stringify(input);
}

function dedupeStrictById<T extends { id: string }>(
  values: readonly T[],
): T[] | undefined {
  const unique = new Map<string, { fingerprint: string; value: T }>();
  for (const value of values) {
    const fingerprint = stableFingerprint(value);
    const previous = unique.get(value.id);
    if (previous !== undefined && previous.fingerprint !== fingerprint) return undefined;
    if (previous === undefined) unique.set(value.id, { fingerprint, value });
  }
  return [...unique.values()].map(({ value }) => value);
}

function evidenceConcernsProduct(evidence: PriceEvidence, canonicalProductId: string): boolean {
  return evidence.productMatch.kind === "exact"
    ? evidence.productMatch.canonicalProductId === canonicalProductId
    : evidence.productMatch.candidateProductIds.includes(canonicalProductId);
}

type IneligibleReason = Extract<CoverageStatus, { kind: "ineligible" }>["reason"];

function mapIneligibleReason(
  reason: Exclude<ReturnType<typeof parseEligiblePriceEvidence>, { eligible: true }>["reason"],
): IneligibleReason {
  switch (reason) {
    case "source-disabled": return "source-disabled";
    case "ambiguous": return "ambiguous-product";
    case "wrong-scope": return "wrong-scope";
    case "not-yet-valid": return "not-yet-valid";
    case "expired": return "expired";
    case "future":
    case "invalid":
    case "stale":
      return "invalid-evidence";
  }
}

function evidenceStatus(
  evidence: PriceEvidence,
  context: PriceEvidenceEligibilityContext,
): CoverageStatus {
  const evaluated = parseEligiblePriceEvidence(evidence, context);
  if (evaluated.eligible) return { kind: "priced", evidenceId: evidence.id };
  if (evaluated.reason === "stale") {
    const staleAtMs = Date.parse(evidence.observedAt) + context.maxAgeMs;
    if (Number.isFinite(staleAtMs)) {
      return {
        kind: "stale",
        evidenceId: evidence.id,
        observedAt: evidence.observedAt,
        staleAt: new Date(staleAtMs).toISOString(),
      };
    }
  }
  return {
    kind: "ineligible",
    evidenceId: evidence.id,
    reason: mapIneligibleReason(evaluated.reason),
    evaluatedAt: context.now.toISOString(),
  };
}

function compareEligibleEvidence(left: PriceEvidence, right: PriceEvidence): number {
  return compareText(right.observedAt, left.observedAt)
    || left.amountOre - right.amountOre
    || compareText(left.id, right.id);
}

function compareCoverageChecks(left: CoverageCheck, right: CoverageCheck): number {
  return compareText(right.checkedAt, left.checkedAt)
    || (left.state === right.state ? 0 : left.state === "source-unavailable" ? -1 : 1)
    || compareText(left.id, right.id);
}

function compareUnresolvedEvidence(left: PriceEvidence, right: PriceEvidence): number {
  return compareText(right.observedAt, left.observedAt)
    || compareText(left.id, right.id);
}

function checkIsCurrentAndApplicable(
  check: CoverageCheck,
  input: ComparisonScopeDerivationInput,
): boolean {
  const checkedAtMs = Date.parse(check.checkedAt);
  const nowMs = input.context.now.getTime();
  return check.canonicalProductId === input.canonicalProductId
    && input.context.enabledSourceIds.includes(check.sourceId)
    && checkedAtMs <= nowMs
    && nowMs - checkedAtMs <= input.context.maxAgeMs
    && geographicScopeIncludes(check.geographicScope, input.context.location);
}

export function deriveComparisonScope(
  input: ComparisonScopeDerivationInput,
): ComparisonScope | null {
  const product = identifierSchema.safeParse(input.canonicalProductId);
  const location = geographicContextSchema.safeParse(input.context?.location);
  const expectedChainIds = Array.isArray(input.expectedChainIds)
    ? [...input.expectedChainIds].sort(compareText)
    : [];
  if (
    !product.success
    || !location.success
    || !Array.isArray(input.priceEvidence)
    || !Array.isArray(input.coverageChecks)
    || !isFiniteDate(input.context?.now)
    || !Number.isSafeInteger(input.context?.maxAgeMs)
    || input.context.maxAgeMs < 0
    || expectedChainIds.length < 1
    || expectedChainIds.length > 3
    || !expectedChainIds.every((chainId) => identifierSchema.safeParse(chainId).success)
    || !hasUniqueStrings(expectedChainIds)
  ) {
    return null;
  }

  const parsedEvidence = input.priceEvidence.flatMap((candidate) => {
    const parsed = priceEvidenceSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  const evidence = dedupeStrictById(parsedEvidence);
  const parsedChecks = input.coverageChecks.flatMap((candidate) => {
    const parsed = coverageCheckSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  const checks = dedupeStrictById(parsedChecks);
  if (evidence === undefined || checks === undefined) return null;

  const entries = expectedChainIds.map((chainId) => {
    const candidates = evidence.filter((candidate) =>
      candidate.chainId === chainId
      && candidate.priceKind === "ordinary"
      && evidenceConcernsProduct(candidate, product.data));
    const eligibleCandidates = candidates
      .filter((candidate) => parseEligiblePriceEvidence(candidate, input.context).eligible)
      .sort(compareEligibleEvidence);
    const latestObservedAt = eligibleCandidates[0]?.observedAt;
    const equallyCurrent = latestObservedAt === undefined
      ? []
      : eligibleCandidates.filter(({ observedAt }) => observedAt === latestObservedAt);
    if (new Set(equallyCurrent.map(({ amountOre }) => amountOre)).size > 1) {
      const evidenceId = [...equallyCurrent].sort((left, right) =>
        compareText(left.id, right.id))[0]?.id;
      return {
        chainId,
        status: {
          kind: "ineligible" as const,
          ...(evidenceId === undefined ? {} : { evidenceId }),
          reason: "invalid-evidence" as const,
          evaluatedAt: input.context.now.toISOString(),
        },
      };
    }
    const eligible = eligibleCandidates[0];
    if (eligible !== undefined) {
      return { chainId, status: { kind: "priced" as const, evidenceId: eligible.id } };
    }

    const applicableChecks = checks
      .filter((check) => check.chainId === chainId && checkIsCurrentAndApplicable(check, input))
      .sort(compareCoverageChecks);
    const selectedCheck = applicableChecks[0];
    if (selectedCheck?.state === "known-not-carried") {
      return {
        chainId,
        status: {
          kind: "known-not-carried" as const,
          sourceId: selectedCheck.sourceId,
          checkedAt: selectedCheck.checkedAt,
        },
      };
    }
    if (selectedCheck?.state === "source-unavailable") {
      return {
        chainId,
        status: {
          kind: "unknown" as const,
          reason: "source-unavailable" as const,
          checkedAt: selectedCheck.checkedAt,
        },
      };
    }

    const unresolved = candidates.sort((left, right) => {
      const leftRank = evidenceStatus(left, input.context).kind === "stale" ? 0 : 1;
      const rightRank = evidenceStatus(right, input.context).kind === "stale" ? 0 : 1;
      return leftRank - rightRank || compareUnresolvedEvidence(left, right);
    })[0];
    return unresolved === undefined
      ? { chainId, status: { kind: "unknown" as const, reason: "not-checked" as const } }
      : { chainId, status: evidenceStatus(unresolved, input.context) };
  });

  const completeness = entries.every(({ status }) =>
    status.kind === "priced" || status.kind === "known-not-carried")
    ? "complete"
    : "partial";
  const parsed = comparisonScopeSchema.safeParse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    completeness,
    evaluatedAt: input.context.now.toISOString(),
    expectedChainIds,
    entries,
  });
  return parsed.success ? parsed.data : null;
}
