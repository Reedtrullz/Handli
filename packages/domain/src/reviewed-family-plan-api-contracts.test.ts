import { describe, expect, it } from "vitest";

import {
  canonicalizeReviewedFamilyCandidateSetFingerprintInput,
  exactProductPlanApiRequestSchema,
  deriveReviewedFamilyPlanDeltaExplanationsV1,
  normalizeReviewedFamilyAllowedBrand,
  planResultV2Schema,
  priceEvidenceSchema,
  reviewedFamilyCandidateInspectionRequestSchema,
  reviewedFamilyCandidateInspectionResponseSchemaFor,
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyPlanApiResponseV2SchemaFor,
  type ReviewedFamilyPlanApiRequestV2,
} from "./index";

const GTIN_MILK = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const CANDIDATE_SET_ID = `candidate-set:${"a".repeat(64)}`;
const GENERATED_AT = "2026-07-17T12:00:00.000Z";

const taxonomy = {
  contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
  contractVersion: 1 as const,
  publishedAt: "2026-07-16T00:00:00.000Z",
  taxonomyId: "handleplan-reviewed-families",
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
};

const catalogSource = {
  contractVersion: 1 as const,
  displayName: "Fixture catalog",
  id: "catalog-source",
  sourceClass: "catalog" as const,
  state: "approved" as const,
};

const priceSource = {
  contractVersion: 1 as const,
  displayName: "Fixture prices",
  id: "price-source",
  sourceClass: "ordinary-price" as const,
  state: "approved" as const,
};

function productClaim(
  canonicalProductId: string,
  gtin: string,
  displayName: string,
  brand: string,
) {
  return {
    canonicalProductId,
    product: {
      brand,
      catalogEvidence: {
        observedAt: "2026-07-17T10:00:00.000Z",
        source: catalogSource,
        sourceRecordId: `source-record:${gtin === GTIN_MILK ? "b" : "c"}`.padEnd(78, gtin === GTIN_MILK ? "b" : "c"),
      },
      displayName,
      gtin,
      packageMeasure: gtin === GTIN_MILK
        ? { amount: 1_000, unit: "ml" as const }
        : { amount: 500, unit: "g" as const },
      unitsPerPack: 1,
    },
  };
}

const coffeeClaim = productClaim(
  "product:coffee",
  GTIN_COFFEE,
  "Evergood Kaffe",
  "Evergood",
);
const milkClaim = productClaim(
  "product:milk",
  GTIN_MILK,
  "TINE Lettmelk 1 %",
  "TINE",
);

const membership = {
  canonicalProductId: "product:milk",
  confidence: 100 as const,
  decision: "approved" as const,
  decisionId: "family-membership:11",
  familyId: "family:melk",
  method: "human-review" as const,
  reviewedAt: "2026-07-16T12:00:00.000Z",
  reviewerAttested: true as const,
};

const milkFamily = {
  aliases: ["mjølk"],
  id: "family:melk",
  labelNo: "Melk",
  slug: "melk",
  status: "active" as const,
};

const rawCandidateRequest = {
  contractVersion: 2,
  families: [{
    allowedBrands: [" TINE ", "tine", "TiNe"],
    familyId: "family:melk",
  }],
};

const candidateResponse = {
  candidateSets: [{
    allowedBrands: ["tine"],
    candidateProductIds: ["product:milk"],
    candidateSetId: CANDIDATE_SET_ID,
    complete: true as const,
    family: milkFamily,
    familyId: "family:melk",
    taxonomyVersionId: taxonomy.versionId,
  }],
  contractVersion: 2 as const,
  generatedAt: GENERATED_AT,
  memberships: [membership],
  productClaims: [milkClaim],
  sources: [catalogSource],
  taxonomy,
};

const rawPlanRequest = {
  contractVersion: 2,
  enabledMembershipProgramIds: [],
  marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
  maxStores: 2,
  needs: [
    {
      id: "need:coffee",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: GTIN_COFFEE },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "package",
      required: true,
    },
    {
      id: "need:milk",
      match: {
        allowedBrands: [" TINE ", "tine"],
        confirmation: {
          candidateSetId: CANDIDATE_SET_ID,
          taxonomyVersionId: taxonomy.versionId,
          userApproved: true,
        },
        familyId: "family:melk",
        kind: "reviewed-family",
      },
      quantity: 1,
      quantityUnit: "package",
      required: true,
    },
  ],
};

const parsedPlanRequest = reviewedFamilyPlanApiRequestV2Schema.parse(
  rawPlanRequest,
) as ReviewedFamilyPlanApiRequestV2;

function priceEvidence(
  id: string,
  canonicalProductId: string,
  amountOre: number,
) {
  return priceEvidenceSchema.parse({
    amountOre,
    chainId: "extra" as const,
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    geographicScope: { countryCode: "NO", kind: "national" as const },
    id,
    kind: "price-evidence" as const,
    observedAt: "2026-07-17T11:00:00.000Z",
    priceKind: "ordinary" as const,
    productMatch: { canonicalProductId, kind: "exact" as const },
    sourceId: priceSource.id,
    sourceRecordId: `source-record:${id}`,
  });
}

const coffeePrice = priceEvidence("price:coffee", "product:coffee", 5_000);
const milkPrice = priceEvidence("price:milk", "product:milk", 2_500);

function coverage(evidenceId: string) {
  return {
    completeness: "partial" as const,
    contractVersion: 1 as const,
    entries: [
      { chainId: "bunnpris", status: { kind: "unknown" as const, reason: "not-checked" as const } },
      { chainId: "extra", status: { evidenceId, kind: "priced" as const } },
      { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
    ],
    evaluatedAt: GENERATED_AT,
    expectedChainIds: ["bunnpris", "extra", "rema-1000"],
  };
}

function assignment(
  needId: string,
  canonicalProductId: string,
  ean: string,
  costOre: number,
) {
  const packageMeasure = ean === GTIN_MILK
    ? { amount: 1_000, unit: "ml" as const }
    : { amount: 500, unit: "g" as const };
  return {
    canonicalProductId,
    chain: "extra" as const,
    checkout: {
      ordinaryTotalOre: costOre,
      savingOre: 0,
      totalOre: costOre,
    },
    costOre,
    ean,
    fulfilment: {
      canonicalProductId,
      complete: true as const,
      contractVersion: 2 as const,
      needId,
      packageCount: 1,
      packageMeasure,
      purchased: { amount: 1, unit: "package" as const },
      requested: { amount: 1, unit: "package" as const },
      surplus: { amount: 0, unit: "package" as const },
    },
    needId,
    observedAt: "2026-07-17T11:00:00.000Z",
    source: priceSource.id,
  };
}

const coffeeAssignment = assignment("need:coffee", "product:coffee", GTIN_COFFEE, 5_000);
const milkAssignment = assignment("need:milk", "product:milk", GTIN_MILK, 2_500);

const mixedPlan = planResultV2Schema.parse({
  assignments: [coffeeAssignment, milkAssignment],
  chains: ["extra"],
  coverage: 1,
  freshness: { "need:coffee": "eligible", "need:milk": "eligible" },
  id: "plan-v2:mixed",
  substitutions: ["need:milk"],
  totalOre: 7_500,
});

const planResponseBase = {
  caveats: ["Kjedepris dokumenterer ikke lagerstatus."],
  contractVersion: 2 as const,
  enabledMembershipProgramIds: [],
  evidence: {
    assignmentEvidence: [
      {
        chainId: "extra" as const,
        conditions: { kind: "ordinary-price" as const },
        evidenceId: coffeePrice.id,
        needId: "need:coffee",
        planId: "plan-v2:mixed",
      },
      {
        chainId: "extra" as const,
        conditions: { kind: "ordinary-price" as const },
        evidenceId: milkPrice.id,
        needId: "need:milk",
        planId: "plan-v2:mixed",
      },
    ],
    candidateCoverage: [
      {
        canonicalProductId: "product:coffee",
        comparisonScope: coverage(coffeePrice.id),
        needId: "need:coffee",
      },
      {
        canonicalProductId: "product:milk",
        comparisonScope: coverage(milkPrice.id),
        needId: "need:milk",
      },
    ],
    excludedPriceEvidence: [],
    memberships: [membership],
    officialOffers: [],
    ordinaryPrices: [coffeePrice, milkPrice],
    sources: [catalogSource, priceSource],
  },
  generatedAt: GENERATED_AT,
  marketContext: parsedPlanRequest.marketContext,
  needMatches: [
    {
      candidateProductIds: ["product:coffee"],
      kind: "exact-product" as const,
      needId: "need:coffee",
    },
    {
      allowedBrands: ["tine"],
      candidateProductIds: ["product:milk"],
      candidateSetId: CANDIDATE_SET_ID,
      family: milkFamily,
      familyId: "family:melk",
      kind: "reviewed-family" as const,
      needId: "need:milk",
      taxonomyVersionId: taxonomy.versionId,
    },
  ],
  plans: [mixedPlan],
  priceDataSource: "cache" as const,
  productClaims: [coffeeClaim, milkClaim],
  taxonomy,
};

const planDeltaExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1(planResponseBase);
if (planDeltaExplanations === undefined) throw new Error("invalid reviewed explanation fixture");
const planResponse = { ...planResponseBase, planDeltaExplanations };

function completeCandidateCoverage(checkedAt: string) {
  return planResponseBase.evidence.candidateCoverage.map((candidate) => ({
    ...candidate,
    comparisonScope: {
      ...candidate.comparisonScope,
      completeness: "complete" as const,
      entries: candidate.comparisonScope.entries.map((entry) => entry.chainId === "extra"
        ? entry
        : {
            chainId: entry.chainId,
            status: {
              checkedAt,
              kind: "known-not-carried" as const,
              sourceId: priceSource.id,
            },
          }),
    },
  }));
}

describe("reviewed-family candidate inspection contract v2", () => {
  it("normalizes, deduplicates, and canonically orders browser-provided brand filters", () => {
    expect(normalizeReviewedFamilyAllowedBrand("  TINE   Melk  ")).toBe("tine melk");
    expect(reviewedFamilyCandidateInspectionRequestSchema.parse({
      ...rawCandidateRequest,
      families: [{
        allowedBrands: ["Zeta", " TINE ", "tine", "Æra"],
        familyId: "family:melk",
      }],
    })).toEqual({
      contractVersion: 2,
      families: [{
        allowedBrands: ["tine", "zeta", "æra"],
        familyId: "family:melk",
      }],
    });
  });

  it("rejects unknown versions and browser injection of candidate or product authority", () => {
    expect(reviewedFamilyCandidateInspectionRequestSchema.safeParse({
      ...rawCandidateRequest,
      contractVersion: 3,
    }).success).toBe(false);
    for (const injected of [
      { query: "melk" },
      { label: "Melk" },
      { products: [milkClaim] },
      { candidates: ["product:milk"] },
      { reviewerId: "private-user" },
      { packageMeasure: { amount: 1_000, unit: "ml" } },
    ]) {
      expect(reviewedFamilyCandidateInspectionRequestSchema.safeParse({
        ...rawCandidateRequest,
        families: [{ ...rawCandidateRequest.families[0], ...injected }],
      }).success).toBe(false);
    }
  });

  it("accepts only a request-bound, complete, redacted, source-backed candidate set", () => {
    const schema = reviewedFamilyCandidateInspectionResponseSchemaFor(rawCandidateRequest);
    expect(schema.safeParse(candidateResponse).success).toBe(true);
    expect(schema.safeParse({
      ...candidateResponse,
      candidateSets: [{ ...candidateResponse.candidateSets[0], allowedBrands: ["TINE"] }],
    }).success).toBe(false);
    expect(schema.safeParse({ ...candidateResponse, memberships: [] }).success).toBe(false);
    expect(schema.safeParse({
      ...candidateResponse,
      memberships: [{ ...membership, reviewerId: "must-never-be-public" }],
    }).success).toBe(false);
    expect(schema.safeParse({ ...candidateResponse, sources: [] }).success).toBe(false);
  });

  it("bounds the candidate union to 50 canonical products", () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `product:${index}`);
    expect(reviewedFamilyCandidateInspectionResponseSchemaFor(rawCandidateRequest).safeParse({
      ...candidateResponse,
      candidateSets: [{ ...candidateResponse.candidateSets[0], candidateProductIds: tooMany }],
    }).success).toBe(false);
  });

  it("rejects different canonical products that claim the same GTIN", () => {
    const duplicateId = "product:milk-copy";
    const duplicateClaim = {
      ...milkClaim,
      canonicalProductId: duplicateId,
    };
    const duplicateMembership = {
      ...membership,
      canonicalProductId: duplicateId,
      decisionId: "family-membership:12",
    };
    const parsed = reviewedFamilyCandidateInspectionResponseSchemaFor(rawCandidateRequest)
      .safeParse({
        ...candidateResponse,
        candidateSets: [{
          ...candidateResponse.candidateSets[0],
          candidateProductIds: ["product:milk", duplicateId],
        }],
        memberships: [membership, duplicateMembership],
        productClaims: [milkClaim, duplicateClaim],
      });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "One GTIN cannot ambiguously identify different canonical products",
        path: ["productClaims"],
      }));
    }
  });

  it("fingerprints only stable taxonomy, selection, product, package, and membership facts", () => {
    const input = {
      allowedBrands: ["tine"],
      candidates: [{
        canonicalProductId: milkClaim.canonicalProductId,
        membership,
        product: milkClaim.product,
      }],
      familyId: "family:melk",
      taxonomy,
    };
    const canonical = canonicalizeReviewedFamilyCandidateSetFingerprintInput(input);
    expect(canonical).toContain('"representativeGtin":"7038010000010"');
    expect(canonical).toContain('"contentSha256"');
    expect(canonical).not.toContain("Fixture catalog");
    expect(canonical).not.toContain("2026-07-17T10:00:00.000Z");
    expect(canonicalizeReviewedFamilyCandidateSetFingerprintInput({
      ...input,
      candidates: [{
        ...input.candidates[0],
        product: {
          ...milkClaim.product,
          catalogEvidence: {
            ...milkClaim.product.catalogEvidence,
            observedAt: "2026-07-17T11:00:00.000Z",
          },
          displayName: "A newer display label",
        },
      }],
    })).toBe(canonical);
  });
});

describe("reviewed-family planning contract v2", () => {
  it("requires a bounded canonical membership selection and binds the response echo", () => {
    expect(reviewedFamilyPlanApiRequestV2Schema.safeParse({
      ...rawPlanRequest,
      enabledMembershipProgramIds: ["coop-medlem", "trumf"],
    }).success).toBe(true);
    const { enabledMembershipProgramIds: _omitted, ...missingSelection } = rawPlanRequest;
    expect(reviewedFamilyPlanApiRequestV2Schema.safeParse(missingSelection).success).toBe(false);
    for (const enabledMembershipProgramIds of [
      ["trumf", "coop-medlem"],
      ["trumf", "trumf"],
      ["trumf "],
      ["trumf\u0000"],
      ["e\u0301"],
      Array.from({ length: 101 }, (_, index) => `program:${String(index).padStart(3, "0")}`),
    ]) {
      expect(reviewedFamilyPlanApiRequestV2Schema.safeParse({
        ...rawPlanRequest,
        enabledMembershipProgramIds,
      }).success).toBe(false);
    }

    expect(reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest).safeParse({
      ...planResponse,
      enabledMembershipProgramIds: ["trumf"],
    }).success).toBe(false);
  });

  it("accepts mixed exact and reviewed-family needs with at most three stores", () => {
    expect(parsedPlanRequest.needs[1]?.match).toMatchObject({ allowedBrands: ["tine"] });
    expect(reviewedFamilyPlanApiRequestV2Schema.safeParse({
      ...rawPlanRequest,
      maxStores: 3,
    }).success).toBe(true);
    expect(reviewedFamilyPlanApiRequestV2Schema.safeParse({
      ...rawPlanRequest,
      maxStores: 4,
    }).success).toBe(false);
    expect(reviewedFamilyPlanApiRequestV2Schema.safeParse({
      ...rawPlanRequest,
      contractVersion: 1,
    }).success).toBe(false);
  });

  it("rejects browser product, query, label, package, reviewer, and candidate-list injection", () => {
    for (const injected of [
      { query: "lettmelk" },
      { label: "Melk" },
      { product: milkClaim },
      { packageMeasure: { amount: 1_000, unit: "ml" } },
      { reviewerId: "private-user" },
      { candidateProductIds: ["product:milk"] },
    ]) {
      const familyNeed = rawPlanRequest.needs[1]!;
      expect(reviewedFamilyPlanApiRequestV2Schema.safeParse({
        ...rawPlanRequest,
        needs: [
          rawPlanRequest.needs[0],
          { ...familyNeed, match: { ...familyNeed.match, ...injected } },
        ],
      }).success).toBe(false);
    }
  });

  it("accepts a request-bound complete-basket, non-dominated, source-backed response", () => {
    const parsed = reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest)
      .safeParse(planResponse);
    expect(parsed.success ? undefined : parsed.error.issues).toBeUndefined();
  });

  it("revalidates reviewed postal evidence from one bound regional directory attestation", () => {
    const marketContext = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const request = { ...parsedPlanRequest, marketContext };
    const geographicDirectoryAttestation = {
      contractVersion: 1 as const,
      countryCode: "NO",
      directoryVersionId: "postal-directory-2026-07",
      evaluatedAt: GENERATED_AT,
      evidenceReference: "manifest:postal-directory-2026-07",
      publishedAt: "2026-07-17T10:00:00.000Z",
      region: {
        coverageState: "complete" as const,
        evidenceReference: "manifest:oslo-postal-set",
        postalCodes: ["0152", "0452"],
        regionCode: marketContext.regionId,
      },
      reviewedAt: "2026-07-17T09:00:00.000Z",
      status: "approved" as const,
      validFrom: "2026-07-17T00:00:00.000Z",
    };
    const responseBase = {
      ...planResponseBase,
      evidence: {
        ...planResponseBase.evidence,
        ordinaryPrices: planResponseBase.evidence.ordinaryPrices.map((price) => ({
          ...price,
          geographicScope: {
            countryCode: "NO" as const,
            kind: "postal-set" as const,
            postalCodes: ["0152", "0452"],
          },
        })),
      },
      geographicDirectoryAttestation,
      marketContext,
    };
    const explanations = deriveReviewedFamilyPlanDeltaExplanationsV1(responseBase);
    if (explanations === undefined) throw new Error("invalid regional explanation fixture");
    const response = { ...responseBase, planDeltaExplanations: explanations };
    const schema = reviewedFamilyPlanApiResponseV2SchemaFor(request);

    expect(schema.safeParse(response).success).toBe(true);
    const { geographicDirectoryAttestation: _missing, ...withoutAttestation } = response;
    expect(schema.safeParse(withoutAttestation).success).toBe(false);
    expect(schema.safeParse({
      ...response,
      geographicDirectoryAttestation: {
        ...geographicDirectoryAttestation,
        region: {
          ...geographicDirectoryAttestation.region,
          regionCode: "no-4601-bergen",
        },
      },
    }).success).toBe(false);
  });

  it("requires exact canonical reviewed plan bytes when travel participates in projection", () => {
    const route = {
      aggregate: {
        calculatedAt: GENERATED_AT,
        distanceMeters: 2_000,
        durationSeconds: 300,
        mode: "car" as const,
        providerSourceId: "fixture-router",
        routeFingerprint: "route:reviewed-canonical",
      },
      planId: mixedPlan.id,
      stops: [{
        branchId: "branch:extra:reviewed-canonical",
        chainId: "extra" as const,
        name: "Extra testbutikk",
        sequence: 1,
      }],
    };
    const explanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
      ...planResponseBase,
      travelRoutes: [route],
    });
    if (explanations === undefined) throw new Error("invalid reviewed travel fixture");
    const response = { ...planResponseBase, planDeltaExplanations: explanations };
    const schema = reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest, {
      travelRoutes: [route],
    });
    expect(schema.safeParse(response).success).toBe(true);
    expect(schema.safeParse({
      ...response,
      plans: [{ ...mixedPlan, assignments: [...mixedPlan.assignments].reverse() }],
    }).success).toBe(false);
  });

  it("rejects reviewed-family explanation copy detached from the exact response evidence", () => {
    const entry = planResponse.planDeltaExplanations.entries[0]!;
    const forged = {
      ...planResponse,
      planDeltaExplanations: {
        ...planResponse.planDeltaExplanations,
        entries: [{ ...entry, summary: "Forged client-authoritative difference." }],
      },
    };

    expect(reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest).safeParse(forged).success)
      .toBe(false);
  });

  it("rejects stale or future known-not-carried proof after a complete reviewed response is signed", () => {
    const completeBase = {
      ...planResponseBase,
      evidence: {
        ...planResponseBase.evidence,
        candidateCoverage: completeCandidateCoverage("2026-07-14T12:00:00.000Z"),
      },
    };
    const completeExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1(completeBase);
    if (completeExplanations === undefined) throw new Error("invalid complete coverage fixture");
    const complete = { ...completeBase, planDeltaExplanations: completeExplanations };
    const schema = reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest);
    expect(schema.safeParse(complete).success).toBe(true);

    for (const checkedAt of [
      "2026-07-14T11:59:59.999Z",
      "2026-07-17T12:00:00.001Z",
    ]) {
      expect(schema.safeParse({
        ...complete,
        evidence: {
          ...complete.evidence,
          candidateCoverage: completeCandidateCoverage(checkedAt),
        },
      }).success).toBe(false);
    }
  });

  it("binds response family details to the exact confirmation and taxonomy", () => {
    const schema = reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest);
    const familyMatch = planResponse.needMatches[1]!;
    for (const replacement of [
      { candidateSetId: `candidate-set:${"d".repeat(64)}` },
      { taxonomyVersionId: "handleplan-reviewed-families@1.1.0" },
      { allowedBrands: ["q-meieriene"] },
      { family: { ...milkFamily, id: "family:kaffe" } },
    ]) {
      expect(schema.safeParse({
        ...planResponse,
        needMatches: [
          planResponse.needMatches[0],
          { ...familyMatch, ...replacement },
        ],
      }).success).toBe(false);
    }
  });

  it("rejects assignments outside the confirmed candidate set", () => {
    const forged = assignment("need:milk", "product:outside", GTIN_MILK, 2_500);
    const response = {
      ...planResponse,
      plans: [{
        ...planResponse.plans[0],
        assignments: [coffeeAssignment, forged],
      }],
    };
    expect(reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest).safeParse(response).success)
      .toBe(false);
  });

  it("rejects missing assignment, membership, coverage, and source evidence", () => {
    const schema = reviewedFamilyPlanApiResponseV2SchemaFor(parsedPlanRequest);
    for (const evidence of [
      { ...planResponse.evidence, assignmentEvidence: [] },
      { ...planResponse.evidence, memberships: [] },
      { ...planResponse.evidence, candidateCoverage: planResponse.evidence.candidateCoverage.slice(0, 1) },
      { ...planResponse.evidence, sources: [catalogSource] },
    ]) {
      expect(schema.safeParse({ ...planResponse, evidence }).success).toBe(false);
    }
  });

  it("keeps the exact-product v1 request narrow and explicitly market-bound", () => {
    const v1 = {
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
      maxStores: 2,
      needs: [{
        id: "need:milk",
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: GTIN_MILK },
          userApproved: true,
        },
        quantity: 2,
        quantityUnit: "each",
        required: true,
      }],
    };
    expect(exactProductPlanApiRequestSchema.parse(v1)).toEqual(v1);
    expect(exactProductPlanApiRequestSchema.safeParse({ ...v1, contractVersion: 2 }).success)
      .toBe(false);
  });
});
