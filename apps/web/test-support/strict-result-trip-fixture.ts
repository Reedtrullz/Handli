import {
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiProductSummarySchema,
  planResultV2Schema,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiProductSummary,
  type PlanResultV2,
} from "@handleplan/domain";

const GTIN = "7038010000010";

export interface StrictResultTripFixture {
  caveats: string[];
  evidence: ExactProductPlanApiEvidenceEnvelope;
  generatedAt: string;
  plan: PlanResultV2;
  products: ExactProductPlanApiProductSummary[];
}

export interface StrictResultTripFixtureOptions {
  catalogObservedAt?: string;
  generatedAt?: string;
  offer?: boolean;
  offerEndsAt?: string;
  ordinaryObservedAt?: string;
  ordinaryValidUntil?: string;
}

export function strictResultTripFixture(
  options: StrictResultTripFixtureOptions = {},
): StrictResultTripFixture {
  const generatedAt = options.generatedAt ?? "2026-07-16T12:00:00.000Z";
  const ordinaryObservedAt = options.ordinaryObservedAt ?? "2026-07-16T11:00:00.000Z";
  const catalogObservedAt = options.catalogObservedAt ?? "2026-07-16T10:00:00.000Z";
  const usesOffer = options.offer ?? false;
  const offerId = "offer:milk";
  const offerEndsAt = options.offerEndsAt ?? "2026-07-17T12:00:00.000Z";

  const product = exactProductPlanApiProductSummarySchema.parse({
    brand: "TINE",
    catalogEvidence: {
      observedAt: catalogObservedAt,
      source: {
        contractVersion: 1,
        displayName: "Catalog fixture",
        id: "catalog-source",
        sourceClass: "catalog",
        state: "approved",
      },
      sourceRecordId: `source-record:${"a".repeat(64)}`,
    },
    displayName: "TINE Lettmelk 1 l",
    gtin: GTIN,
    packageMeasure: { amount: 1_000, unit: "ml" },
    unitsPerPack: 1,
  });

  const assignment = {
    canonicalProductId: "product:milk",
    chain: "extra" as const,
    checkout: usesOffer
      ? { appliedOfferId: offerId, ordinaryTotalOre: 2_490, savingOre: 500, totalOre: 1_990 }
      : { ordinaryTotalOre: 2_490, savingOre: 0, totalOre: 2_490 },
    costOre: usesOffer ? 1_990 : 2_490,
    ean: GTIN,
    fulfilment: {
      canonicalProductId: "product:milk",
      complete: true as const,
      contractVersion: 2 as const,
      needId: "need:milk",
      packageCount: 1,
      packageMeasure: { amount: 1_000, unit: "ml" as const },
      purchased: { amount: 1, unit: "package" as const },
      requested: { amount: 1, unit: "package" as const },
      surplus: { amount: 0, unit: "package" as const },
    },
    needId: "need:milk",
    observedAt: ordinaryObservedAt,
    officialOffer: usesOffer
      ? {
          capturedAt: ordinaryObservedAt,
          id: offerId,
          sourceId: "price-source",
          sourceRecordId: "source-record:offer:milk",
        }
      : undefined,
    source: "price-source",
  };
  const plan = planResultV2Schema.parse({
    assignments: [assignment],
    chains: ["extra"],
    coverage: 1,
    freshness: { "need:milk": "eligible" },
    id: "plan:strict-result-fixture",
    substitutions: [],
    totalOre: assignment.costOre,
  });

  const ordinaryPrice = {
    amountOre: 2_490,
    chainId: "extra",
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    geographicScope: { countryCode: "NO", kind: "national" as const },
    id: "price:extra:milk",
    kind: "price-evidence" as const,
    observedAt: ordinaryObservedAt,
    priceKind: "ordinary" as const,
    productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
    sourceId: "price-source",
    sourceRecordId: "source-record:price:extra:milk",
    ...(options.ordinaryValidUntil === undefined
      ? {}
      : { validUntil: options.ordinaryValidUntil }),
  };
  const offer = {
    applicability: {
      channels: ["in-store" as const],
      contractVersion: 1 as const,
      endsAt: offerEndsAt,
      geographicScope: { countryCode: "NO", kind: "national" as const },
      startsAt: "2026-07-15T12:00:00.000Z",
    },
    beforePriceOre: 2_490,
    capturedAt: ordinaryObservedAt,
    chainId: "extra",
    conditions: [{ kind: "public" as const }],
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    id: offerId,
    kind: "official-offer" as const,
    pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
    productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
    sourceId: "price-source",
    sourceRecordId: "source-record:offer:milk",
  };

  const evidence = exactProductPlanApiEvidenceEnvelopeSchema.parse({
    assignmentEvidence: [{
      chainId: "extra",
      conditions: usesOffer
        ? { kind: "official-offer", offerId }
        : { kind: "ordinary-price" },
      evidenceId: ordinaryPrice.id,
      needId: "need:milk",
      planId: plan.id,
    }],
    needs: [{
      comparisonScope: {
        completeness: "partial",
        contractVersion: 1,
        entries: [
          { chainId: "bunnpris", status: { kind: "unknown", reason: "not-checked" } },
          { chainId: "extra", status: { evidenceId: ordinaryPrice.id, kind: "priced" } },
          { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
        ],
        evaluatedAt: generatedAt,
        expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      },
      excludedPriceEvidence: [],
      historicalComparisons: [],
      historicalPriceEvidence: [],
      needId: "need:milk",
      officialOffers: usesOffer ? [offer] : [],
      ordinaryPrices: [ordinaryPrice],
    }],
    sources: [
      {
        contractVersion: 1,
        displayName: "Catalog fixture",
        id: "catalog-source",
        sourceClass: "catalog",
        state: "approved",
      },
      {
        contractVersion: 1,
        displayName: "Price fixture",
        id: "price-source",
        sourceClass: "ordinary-price",
        state: "approved",
      },
    ],
  });

  return {
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    evidence,
    generatedAt,
    plan,
    products: [product],
  };
}
