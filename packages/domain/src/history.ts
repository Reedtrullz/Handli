import { z } from "zod";

import {
  basisPointsSchema,
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  positiveSafeIntegerSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

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
    distinctObservationDays: z.number().int().min(7).max(30),
    windowStartsAt: canonicalTimestampSchema,
    windowEndsAt: canonicalTimestampSchema,
    derivedAt: canonicalTimestampSchema,
    sourceEvidenceIds: z.array(identifierSchema).min(2),
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
    if (Date.parse(comparison.derivedAt) < windowEndsAt) {
      context.addIssue({
        code: "custom",
        message: "Historical comparison cannot be derived before its window closes",
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
  });

export type HistoricalComparison = z.infer<typeof historicalComparisonSchema>;
