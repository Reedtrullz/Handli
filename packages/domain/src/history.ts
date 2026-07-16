import { z } from "zod";

import {
  DOMAIN_CONTRACT_VERSION,
  basisPointsSchema,
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  isFiniteDate,
  positiveSafeIntegerSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";
import {
  parseEligiblePriceEvidence,
  priceEvidenceSchema,
  type PriceEvidence,
  type PriceEvidenceEligibilityContext,
} from "./evidence";
import type { GeographicContext } from "./geography";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CURRENT_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1_000;

function calculateBasisPoints(savingsOre: number, baselineOre: number): number {
  return Number((BigInt(savingsOre) * 10_000n) / BigInt(baselineOre));
}

export const historicalComparisonSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("historical-comparison"),
    id: identifierSchema,
    canonicalProductId: identifierSchema,
    chainId: identifierSchema,
    currentEvidenceId: identifierSchema,
    baselineMethod: z.literal("median-30d"),
    baselineOre: positiveSafeIntegerSchema,
    currentOre: moneyOreSchema,
    savingsOre: moneyOreSchema,
    savingsBasisPoints: basisPointsSchema,
    // A rolling 30 * 24 hour window can touch 31 UTC calendar dates when its
    // endpoints are not midnight. The derivation still enforces the exact
    // millisecond window below.
    distinctObservationDays: z.number().int().min(7).max(31),
    windowStartsAt: canonicalTimestampSchema,
    windowEndsAt: canonicalTimestampSchema,
    derivedAt: canonicalTimestampSchema,
    sourceEvidenceIds: z.array(identifierSchema).min(7),
  })
  .strict()
  .superRefine((comparison, context) => {
    const windowStartsAt = Date.parse(comparison.windowStartsAt);
    const windowEndsAt = Date.parse(comparison.windowEndsAt);
    if (windowEndsAt - windowStartsAt !== THIRTY_DAYS_MS) {
      context.addIssue({
        code: "custom",
        message: "A median-30d comparison requires an exact 30-day window",
        path: ["windowStartsAt"],
      });
    }
    const derivedAt = Date.parse(comparison.derivedAt);
    if (derivedAt < windowEndsAt) {
      context.addIssue({
        code: "custom",
        message: "Historical comparison cannot be derived before its window closes",
        path: ["derivedAt"],
      });
    }
    if (derivedAt - windowEndsAt > MAX_CURRENT_EVIDENCE_AGE_MS) {
      context.addIssue({
        code: "custom",
        message: "Historical comparison cannot outlive its current price evidence",
        path: ["derivedAt"],
      });
    }
    if (comparison.currentOre >= comparison.baselineOre) {
      context.addIssue({
        code: "custom",
        message: "Historical savings require the current price to be below the baseline",
        path: ["currentOre"],
      });
      return;
    }
    const expectedSavings = comparison.baselineOre - comparison.currentOre;
    if (comparison.savingsOre !== expectedSavings) {
      context.addIssue({
        code: "custom",
        message: "Historical savings must equal baseline minus current price",
        path: ["savingsOre"],
      });
    }
    if (comparison.savingsBasisPoints !== calculateBasisPoints(expectedSavings, comparison.baselineOre)) {
      context.addIssue({
        code: "custom",
        message: "Historical savings basis points do not match the price difference",
        path: ["savingsBasisPoints"],
      });
    }
    if (!hasUniqueStrings(comparison.sourceEvidenceIds)) {
      context.addIssue({
        code: "custom",
        message: "Historical source evidence IDs must be unique",
        path: ["sourceEvidenceIds"],
      });
    }
    if (comparison.sourceEvidenceIds.length < comparison.distinctObservationDays) {
      context.addIssue({
        code: "custom",
        message: "Each distinct observation day requires supporting baseline evidence",
        path: ["sourceEvidenceIds"],
      });
    }
    if (comparison.sourceEvidenceIds.includes(comparison.currentEvidenceId)) {
      context.addIssue({
        code: "custom",
        message: "The current evidence cannot be part of its own historical baseline",
        path: ["sourceEvidenceIds"],
      });
    }
  });

export type HistoricalComparison = z.infer<typeof historicalComparisonSchema>;

export interface HistoricalComparisonDerivationInput {
  comparisonId: string;
  currentEvidence: unknown;
  historicalEvidence: readonly unknown[];
  derivedAt: Date;
  eligibility: {
    currentMaxAgeMs: number;
    enabledSourceIds: readonly string[];
    location: GeographicContext;
  };
}

function evidenceFingerprint(evidence: PriceEvidence): string {
  // priceEvidenceSchema reconstructs strict objects in schema-key order, so
  // this is stable even when equivalent input objects use a different key order.
  return JSON.stringify(evidence);
}

function calculateMedianOre(evidence: readonly PriceEvidence[]): number {
  const amounts = evidence.map(({ amountOre }) => amountOre).sort((left, right) => left - right);
  const upperIndex = Math.floor(amounts.length / 2);
  if (amounts.length % 2 === 1) {
    return amounts[upperIndex]!;
  }

  const lower = BigInt(amounts[upperIndex - 1]!);
  const upper = BigInt(amounts[upperIndex]!);
  return Number((lower + upper) / 2n);
}

function compareEvidenceOrder(left: PriceEvidence, right: PriceEvidence): number {
  const observedAtOrder = left.observedAt.localeCompare(right.observedAt);
  return observedAtOrder !== 0 ? observedAtOrder : left.id.localeCompare(right.id);
}

/**
 * Derives an analytical comparison from an already-eligible current ordinary
 * price and schema-valid historical ordinary observations. The trailing
 * window is [current observedAt - 30 days, current observedAt), so the current
 * observation can never influence its own baseline. An even-sized median is
 * the floor of the two middle ore values.
 */
export function deriveHistoricalComparison(
  input: HistoricalComparisonDerivationInput,
): HistoricalComparison | null {
  const eligibility = input.eligibility as
    | HistoricalComparisonDerivationInput["eligibility"]
    | undefined;
  const parsedComparisonId = identifierSchema.safeParse(input.comparisonId);
  const parsedCurrent = priceEvidenceSchema.safeParse(input.currentEvidence);
  if (
    !parsedComparisonId.success ||
    !parsedCurrent.success ||
    !Array.isArray(input.historicalEvidence) ||
    !(input.derivedAt instanceof Date) ||
    !isFiniteDate(input.derivedAt) ||
    eligibility === undefined ||
    !Number.isSafeInteger(eligibility.currentMaxAgeMs) ||
    eligibility.currentMaxAgeMs < 0 ||
    eligibility.currentMaxAgeMs > MAX_CURRENT_EVIDENCE_AGE_MS ||
    !Array.isArray(eligibility.enabledSourceIds)
  ) {
    return null;
  }

  const current = parsedCurrent.data;
  const currentEligibilityContext: PriceEvidenceEligibilityContext = {
    now: input.derivedAt,
    maxAgeMs: eligibility.currentMaxAgeMs,
    location: eligibility.location,
    enabledSourceIds: eligibility.enabledSourceIds,
  };
  if (!parseEligiblePriceEvidence(current, currentEligibilityContext).eligible) {
    return null;
  }
  if (
    current.productMatch.kind !== "exact" ||
    current.priceKind !== "ordinary" ||
    current.evidenceLevel === "ambiguous"
  ) {
    return null;
  }
  const canonicalProductId = current.productMatch.canonicalProductId;

  const windowEndsAtMs = Date.parse(current.observedAt);
  if (windowEndsAtMs > input.derivedAt.getTime()) {
    return null;
  }
  const windowStartsAtMs = windowEndsAtMs - THIRTY_DAYS_MS;

  const uniqueEvidence = new Map<string, { evidence: PriceEvidence; fingerprint: string }>();
  const currentFingerprint = evidenceFingerprint(current);
  uniqueEvidence.set(current.id, { evidence: current, fingerprint: currentFingerprint });

  for (const candidate of input.historicalEvidence) {
    const parsed = priceEvidenceSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }

    const fingerprint = evidenceFingerprint(parsed.data);
    const previous = uniqueEvidence.get(parsed.data.id);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        return null;
      }
      continue;
    }
    uniqueEvidence.set(parsed.data.id, { evidence: parsed.data, fingerprint });
  }

  const baselineEvidence = [...uniqueEvidence.values()]
    .map(({ evidence }) => evidence)
    .filter((evidence) => {
      if (
        evidence.id === current.id ||
        evidence.productMatch.kind !== "exact" ||
        evidence.productMatch.canonicalProductId !== canonicalProductId ||
        evidence.chainId !== current.chainId ||
        evidence.priceKind !== "ordinary" ||
        evidence.evidenceLevel === "ambiguous"
      ) {
        return false;
      }

      const observedAtMs = Date.parse(evidence.observedAt);
      const eligibleAtObservation = parseEligiblePriceEvidence(evidence, {
        now: new Date(observedAtMs),
        maxAgeMs: 0,
        location: eligibility.location,
        enabledSourceIds: eligibility.enabledSourceIds,
      }).eligible;
      return eligibleAtObservation
        && observedAtMs >= windowStartsAtMs
        && observedAtMs < windowEndsAtMs;
    })
    .sort(compareEvidenceOrder);

  const distinctObservationDays = new Set(
    baselineEvidence.map(({ observedAt }) => observedAt.slice(0, 10)),
  ).size;
  if (distinctObservationDays < 7) {
    return null;
  }

  const baselineOre = calculateMedianOre(baselineEvidence);
  if (baselineOre <= 0 || current.amountOre >= baselineOre) {
    return null;
  }

  const savingsOre = baselineOre - current.amountOre;
  const comparison = historicalComparisonSchema.safeParse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    kind: "historical-comparison",
    id: parsedComparisonId.data,
    canonicalProductId,
    chainId: current.chainId,
    currentEvidenceId: current.id,
    baselineMethod: "median-30d",
    baselineOre,
    currentOre: current.amountOre,
    savingsOre,
    savingsBasisPoints: calculateBasisPoints(savingsOre, baselineOre),
    distinctObservationDays,
    windowStartsAt: new Date(windowStartsAtMs).toISOString(),
    windowEndsAt: current.observedAt,
    derivedAt: input.derivedAt.toISOString(),
    sourceEvidenceIds: baselineEvidence.map(({ id }) => id),
  });

  return comparison.success ? comparison.data : null;
}
