import {
  deriveComparisonScope,
  type ComparisonScope,
  type PriceEvidenceEligibilityContext,
} from "@handleplan/domain";

export const V1_EXPECTED_PRICE_CHAINS = [
  "bunnpris",
  "extra",
  "rema-1000",
] as const;

export class CoverageUnavailableError extends Error {
  constructor() {
    super("Comparison coverage is unavailable");
    this.name = "CoverageUnavailableError";
  }
}

export interface CoverageServiceInput {
  canonicalProductId: string;
  priceEvidence: readonly unknown[];
  coverageChecks: readonly unknown[];
  context: PriceEvidenceEligibilityContext;
}

export class CoverageService {
  derive(input: CoverageServiceInput): ComparisonScope {
    const result = deriveComparisonScope({
      canonicalProductId: input.canonicalProductId,
      coverageChecks: input.coverageChecks,
      context: input.context,
      expectedChainIds: V1_EXPECTED_PRICE_CHAINS,
      priceEvidence: input.priceEvidence,
    });
    if (result === null) throw new CoverageUnavailableError();
    return result;
  }
}
