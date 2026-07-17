import {
  deriveExactProductPlanDeltaExplanationsV1,
  deriveReviewedFamilyPlanDeltaExplanationsV1,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiProductSummarySchema,
  exactProductPlanApiRequestSchema,
  exactProductPlanApiResponseSchemaFor,
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyPlanApiEvidenceEnvelopeV2Schema,
  reviewedFamilyPlanApiResponseV2SchemaFor,
  planResultV2Schema,
  type ExactProductPlanApiRequest,
  type ExactProductPlanApiResponse,
  type GeographicDirectoryRegionAttestationV1,
  type GeographicScope,
  type MarketContextV1,
  type PlanResultV2,
  type ReviewedFamilyPlanApiRequestV2,
  type ReviewedFamilyPlanApiResponseV2,
} from "@handleplan/domain";

const GTIN = "7038010000010";
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const satisfies MarketContextV1;

export interface StrictResultTripFixture {
  exactRequest: ExactProductPlanApiRequest;
  exactResponse: ExactProductPlanApiResponse;
  plan: PlanResultV2;
}

export interface StrictResultTripFixtureOptions {
  catalogObservedAt?: string;
  enabledMembershipProgramIds?: string[];
  generatedAt?: string;
  geographicDirectoryAttestation?: GeographicDirectoryRegionAttestationV1;
  geographicScope?: GeographicScope;
  marketContext?: MarketContextV1;
  membershipProgramId?: string;
  offer?: boolean;
  offerCapturedAt?: string;
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
  const offerCapturedAt = options.offerCapturedAt ?? ordinaryObservedAt;
  const offerEndsAt = options.offerEndsAt ?? "2026-07-17T12:00:00.000Z";
  const caveats = ["Pris dokumenterer ikke lagerstatus."];
  const request = exactProductPlanApiRequestSchema.parse({
    contractVersion: 1,
    enabledMembershipProgramIds: options.enabledMembershipProgramIds ?? [],
    marketContext: options.marketContext ?? MARKET_CONTEXT,
    maxStores: 3,
    needs: [{
      id: "need:milk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: GTIN },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    }],
  });

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
          capturedAt: offerCapturedAt,
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
    geographicScope: options.geographicScope
      ?? { countryCode: "NO", kind: "national" as const },
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
      geographicScope: options.geographicScope
        ?? { countryCode: "NO", kind: "national" as const },
      startsAt: "2026-07-15T12:00:00.000Z",
    },
    beforePriceOre: 2_490,
    capturedAt: offerCapturedAt,
    chainId: "extra",
    conditions: options.membershipProgramId === undefined
      ? [{ kind: "public" as const }]
      : [{ kind: "member" as const, programId: options.membershipProgramId }],
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

  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
    evidence,
    generatedAt,
    marketContext: request.marketContext,
    plans: [plan],
  });
  if (planDeltaExplanations === undefined) {
    throw new Error("strict result fixture explanations are invalid");
  }
  const response = exactProductPlanApiResponseSchemaFor(request).parse({
    caveats,
    contractVersion: 1,
    enabledMembershipProgramIds: request.enabledMembershipProgramIds,
    evidence,
    generatedAt,
    ...(options.geographicDirectoryAttestation === undefined
      ? {}
      : {
          geographicDirectoryAttestation:
            options.geographicDirectoryAttestation,
        }),
    marketContext: request.marketContext,
    planDeltaExplanations,
    plans: [plan],
    priceDataSource: "cache",
    products: [product],
  });

  return {
    exactRequest: request,
    exactResponse: response,
    plan,
  };
}

const REVIEWED_GTIN = "7038010000027";
const REVIEWED_CANDIDATE_SET_ID = `candidate-set:${"a".repeat(64)}`;

export interface ReviewedStrictResultTripFixture {
  kind: "reviewed-family";
  plan: PlanResultV2;
  reviewedRequest: ReviewedFamilyPlanApiRequestV2;
  reviewedResponse: ReviewedFamilyPlanApiResponseV2;
}

export interface ReviewedStrictResultTripFixtureOptions {
  generatedAt?: string;
  observedAt?: string;
  publishedAt?: string;
  reviewedAt?: string;
}

/** A fully validated mixed exact + reviewed-family result with no browser-owned copy. */
export function reviewedStrictResultTripFixture(
  options: ReviewedStrictResultTripFixtureOptions = {},
): ReviewedStrictResultTripFixture {
  const generatedAt = options.generatedAt ?? "2026-07-16T12:00:00.000Z";
  const observedAt = options.observedAt ?? "2026-07-16T11:00:00.000Z";
  const caveats = ["Kjedepris dokumenterer ikke lagerstatus."];
  const request = reviewedFamilyPlanApiRequestV2Schema.parse({
    contractVersion: 2,
    enabledMembershipProgramIds: [],
    marketContext: MARKET_CONTEXT,
    maxStores: 3,
    needs: [
      {
        id: "need:coffee",
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: REVIEWED_GTIN },
          userApproved: true,
        },
        quantity: 1,
        quantityUnit: "each",
        required: true,
      },
      {
        id: "need:milk",
        match: {
          confirmation: {
            candidateSetId: REVIEWED_CANDIDATE_SET_ID,
            taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
            userApproved: true,
          },
          familyId: "family:melk",
          kind: "reviewed-family",
        },
        quantity: 1,
        quantityUnit: "each",
        required: true,
      },
    ],
  });
  const catalogSource = {
    contractVersion: 1 as const,
    displayName: "Kontrollert produktkatalog",
    id: "catalog-source",
    sourceClass: "catalog" as const,
    state: "approved" as const,
  };
  const priceSource = {
    contractVersion: 1 as const,
    displayName: "Kontrollerte kjedepriser",
    id: "price-source",
    sourceClass: "ordinary-price" as const,
    state: "approved" as const,
  };
  const taxonomy = {
    contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
    contractVersion: 1 as const,
    publishedAt: options.publishedAt ?? "2026-07-16T00:00:00.000Z",
    taxonomyId: "handleplan-reviewed-families" as const,
    taxonomyVersion: "1.0.0",
    versionId: "handleplan-reviewed-families@1.0.0",
  };
  const claims = [
    {
      canonicalProductId: "product:coffee",
      product: {
        brand: "Evergood",
        catalogEvidence: {
          observedAt,
          source: catalogSource,
          sourceRecordId: `source-record:${"b".repeat(64)}`,
        },
        displayName: "Evergood Kaffe 500 g",
        gtin: REVIEWED_GTIN,
        packageMeasure: { amount: 500, unit: "g" as const },
        unitsPerPack: 1,
      },
    },
    {
      canonicalProductId: "product:milk",
      product: {
        brand: "TINE",
        catalogEvidence: {
          observedAt,
          source: catalogSource,
          sourceRecordId: `source-record:${"c".repeat(64)}`,
        },
        displayName: "TINE Lettmelk 1 l",
        gtin: GTIN,
        packageMeasure: { amount: 1_000, unit: "ml" as const },
        unitsPerPack: 1,
      },
    },
  ];
  const prices = [
    {
      amountOre: 5_000,
      chainId: "extra" as const,
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      geographicScope: { countryCode: "NO" as const, kind: "national" as const },
      id: "price:coffee",
      kind: "price-evidence" as const,
      observedAt,
      priceKind: "ordinary" as const,
      productMatch: { canonicalProductId: "product:coffee", kind: "exact" as const },
      sourceId: priceSource.id,
      sourceRecordId: "source-record:price:coffee",
    },
    {
      amountOre: 2_500,
      chainId: "extra" as const,
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      geographicScope: { countryCode: "NO" as const, kind: "national" as const },
      id: "price:milk",
      kind: "price-evidence" as const,
      observedAt,
      priceKind: "ordinary" as const,
      productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
      sourceId: priceSource.id,
      sourceRecordId: "source-record:price:milk",
    },
  ];
  const assignments = [
    {
      canonicalProductId: "product:coffee",
      chain: "extra" as const,
      checkout: { ordinaryTotalOre: 5_000, savingOre: 0, totalOre: 5_000 },
      costOre: 5_000,
      ean: REVIEWED_GTIN,
      fulfilment: {
        canonicalProductId: "product:coffee",
        complete: true as const,
        contractVersion: 2 as const,
        needId: "need:coffee",
        packageCount: 1,
        packageMeasure: { amount: 500, unit: "g" as const },
        purchased: { amount: 1, unit: "package" as const },
        requested: { amount: 1, unit: "package" as const },
        surplus: { amount: 0, unit: "package" as const },
      },
      needId: "need:coffee",
      observedAt,
      source: priceSource.id,
    },
    {
      canonicalProductId: "product:milk",
      chain: "extra" as const,
      checkout: { ordinaryTotalOre: 2_500, savingOre: 0, totalOre: 2_500 },
      costOre: 2_500,
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
      observedAt,
      source: priceSource.id,
    },
  ];
  const plan = planResultV2Schema.parse({
    assignments,
    chains: ["extra"],
    coverage: 1,
    freshness: { "need:coffee": "eligible", "need:milk": "eligible" },
    id: "plan-v2:mixed-trip-fixture",
    substitutions: ["need:milk"],
    totalOre: 7_500,
  });
  const coverage = (needId: string, canonicalProductId: string, evidenceId: string) => ({
    canonicalProductId,
    comparisonScope: {
      completeness: "partial" as const,
      contractVersion: 1 as const,
      entries: [
        { chainId: "bunnpris" as const, status: { kind: "unknown" as const, reason: "not-checked" as const } },
        { chainId: "extra" as const, status: { evidenceId, kind: "priced" as const } },
        { chainId: "rema-1000" as const, status: { kind: "unknown" as const, reason: "not-checked" as const } },
      ],
      evaluatedAt: generatedAt,
      expectedChainIds: ["bunnpris", "extra", "rema-1000"] as const,
    },
    needId,
  });
  const evidence = reviewedFamilyPlanApiEvidenceEnvelopeV2Schema.parse({
    assignmentEvidence: assignments.map((assignment) => ({
      chainId: assignment.chain,
      conditions: { kind: "ordinary-price" as const },
      evidenceId: assignment.needId === "need:coffee" ? "price:coffee" : "price:milk",
      needId: assignment.needId,
      planId: plan.id,
    })),
    candidateCoverage: [
      coverage("need:coffee", "product:coffee", "price:coffee"),
      coverage("need:milk", "product:milk", "price:milk"),
    ],
    excludedPriceEvidence: [],
    memberships: [{
      canonicalProductId: "product:milk",
      confidence: 100,
      decision: "approved" as const,
      decisionId: "family-membership:11",
      familyId: "family:melk",
      method: "human-review" as const,
      reviewedAt: options.reviewedAt ?? "2026-07-16T10:00:00.000Z",
      reviewerAttested: true as const,
    }],
    officialOffers: [],
    ordinaryPrices: prices,
    sources: [catalogSource, priceSource],
  });
  const planDeltaExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
    evidence,
    generatedAt,
    marketContext: request.marketContext,
    plans: [plan],
  });
  if (planDeltaExplanations === undefined) {
    throw new Error("reviewed trip fixture explanations are invalid");
  }
  const response = reviewedFamilyPlanApiResponseV2SchemaFor(request).parse({
    caveats,
    contractVersion: 2,
    enabledMembershipProgramIds: request.enabledMembershipProgramIds,
    evidence,
    generatedAt,
    marketContext: request.marketContext,
    needMatches: [
      {
        candidateProductIds: ["product:coffee"],
        kind: "exact-product",
        needId: "need:coffee",
      },
      {
        candidateProductIds: ["product:milk"],
        candidateSetId: REVIEWED_CANDIDATE_SET_ID,
        family: {
          aliases: ["mjølk"],
          id: "family:melk",
          labelNo: "Melk",
          slug: "melk",
          status: "active",
        },
        familyId: "family:melk",
        kind: "reviewed-family",
        needId: "need:milk",
        taxonomyVersionId: taxonomy.versionId,
      },
    ],
    planDeltaExplanations,
    plans: [plan],
    priceDataSource: "cache",
    productClaims: claims,
    taxonomy,
  });

  return {
    kind: "reviewed-family",
    plan,
    reviewedRequest: request,
    reviewedResponse: response,
  };
}
