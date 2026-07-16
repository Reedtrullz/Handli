import { describe, expect, it } from "vitest";

import {
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiNeedEvidenceSchema,
  exactProductPlanApiRequestSchema,
  exactProductPlanApiResponseSchema,
  exactProductPlanApiResponseSchemaFor,
  priceEvidenceSchema,
  type ExactProductPlanApiRequest,
} from "./index";

const GTIN_MILK = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const GTIN_BREAD = "7038010000034";

function exactNeed(
  id: string,
  gtin = GTIN_MILK,
): ExactProductPlanApiRequest["needs"][number] {
  return {
    id,
    match: {
      kind: "exact-product",
      product: { kind: "gtin", value: gtin },
      userApproved: true,
    },
    quantity: 2,
    quantityUnit: "each",
    required: true,
  };
}

const validRequest: ExactProductPlanApiRequest = {
  contractVersion: 1,
  maxStores: 2,
  needs: [exactNeed("need:milk")],
};

function productSummary(
  gtin: string,
  displayName: string,
  packageMeasure: { amount: number; unit: "g" | "ml" | "piece" | "package" },
) {
  const recordHash = gtin === GTIN_MILK
    ? "a".repeat(64)
    : gtin === GTIN_COFFEE
      ? "b".repeat(64)
      : "c".repeat(64);
  return {
    brand: "Fixture",
    catalogEvidence: {
      observedAt: "2026-07-16T12:00:00.000Z",
      source: {
        contractVersion: 1 as const,
        displayName: "Fixture source",
        id: "fixture-source",
        sourceClass: "ordinary-price" as const,
        state: "approved" as const,
      },
      sourceRecordId: `source-record:${recordHash}`,
    },
    displayName,
    gtin,
    packageMeasure,
    unitsPerPack: 1,
  };
}

const milkSummary = productSummary(
  GTIN_MILK,
  "TINE Lettmelk 1 %",
  { amount: 1_000, unit: "ml" },
);
const coffeeSummary = productSummary(
  GTIN_COFFEE,
  "Evergood Kaffe",
  { amount: 500, unit: "g" },
);
const breadSummary = productSummary(
  GTIN_BREAD,
  "Norsk grovbrød",
  { amount: 1, unit: "piece" },
);

const validPlan = {
  assignments: [
    {
      canonicalProductId: "product:fixture:milk",
      chain: "extra",
      checkout: {
        ordinaryTotalOre: 4_980,
        savingOre: 0,
        totalOre: 4_980,
      },
      costOre: 4_980,
      ean: GTIN_MILK,
      fulfilment: {
        canonicalProductId: "product:fixture:milk",
        complete: true,
        contractVersion: 2,
        needId: "need:milk",
        packageCount: 2,
        packageMeasure: { amount: 1_000, unit: "ml" },
        purchased: { amount: 2, unit: "package" },
        requested: { amount: 2, unit: "package" },
        surplus: { amount: 0, unit: "package" },
      },
      needId: "need:milk",
      observedAt: "2026-07-16T12:00:00.000Z",
      source: "fixture-source",
    },
  ],
  chains: ["extra"],
  coverage: 1,
  freshness: { "need:milk": "eligible" },
  id: "plan-v2:fixture",
  substitutions: [],
  totalOre: 4_980,
};

const EXPECTED_CHAINS = ["bunnpris", "extra", "rema-1000"] as const;

function emptyNeedEvidence(needId: string) {
  return {
    comparisonScope: {
      contractVersion: 1,
      completeness: "partial",
      evaluatedAt: "2026-07-16T12:00:00.000Z",
      expectedChainIds: [...EXPECTED_CHAINS],
      entries: EXPECTED_CHAINS.map((chainId) => ({
        chainId,
        status: { kind: "unknown" as const, reason: "not-checked" as const },
      })),
    },
    historicalComparisons: [],
    historicalPriceEvidence: [],
    excludedPriceEvidence: [],
    needId,
    officialOffers: [],
    ordinaryPrices: [],
  };
}

const milkPriceEvidence = {
  amountOre: 2_490,
  chainId: "extra",
  contractVersion: 1,
  evidenceLevel: "observed",
  geographicScope: { countryCode: "NO", kind: "national" },
  id: "price:fixture:1",
  kind: "price-evidence",
  observedAt: "2026-07-16T12:00:00.000Z",
  priceKind: "ordinary",
  productMatch: { canonicalProductId: "product:fixture:milk", kind: "exact" },
  sourceId: "fixture-source",
  sourceRecordId: "source-record:fixture:1",
} as const;

function responseEvidence(
  request: ExactProductPlanApiRequest,
  plans: Array<{
    id: string;
    assignments: Array<{
      chain: string;
      needId: string;
    }>;
  }> = [],
) {
  const needs = request.needs
    .map(({ id }) => id === "need:milk" && plans.length > 0
      ? {
          ...emptyNeedEvidence(id),
          comparisonScope: {
            ...emptyNeedEvidence(id).comparisonScope,
            entries: [
              { chainId: "bunnpris", status: { kind: "unknown" as const, reason: "not-checked" as const } },
              { chainId: "extra", status: { kind: "priced" as const, evidenceId: milkPriceEvidence.id } },
              { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
            ],
          },
          ordinaryPrices: [milkPriceEvidence],
        }
      : emptyNeedEvidence(id))
    .sort((left, right) => left.needId.localeCompare(right.needId));
  return {
    assignmentEvidence: plans.flatMap((plan) => plan.assignments.map((assignment) => ({
      chainId: assignment.chain,
      conditions: { kind: "ordinary-price" as const },
      evidenceId: milkPriceEvidence.id,
      needId: assignment.needId,
      planId: plan.id,
    }))),
    needs,
    sources: [{
      contractVersion: 1,
      displayName: "Fixture source",
      id: "fixture-source",
      sourceClass: "ordinary-price",
      state: "approved",
    }],
  };
}

const validResponse = {
  caveats: ["Kjedepris dokumenterer ikke lagerstatus."],
  contractVersion: 1,
  evidence: responseEvidence(validRequest, [validPlan]),
  generatedAt: "2026-07-16T12:00:00.000Z",
  plans: [validPlan],
  priceDataSource: "cache",
  products: [milkSummary],
};

function requestParses(input: unknown): boolean {
  return exactProductPlanApiRequestSchema.safeParse(input).success;
}

function responseParses(request: ExactProductPlanApiRequest, response: unknown): boolean {
  return exactProductPlanApiResponseSchemaFor(request).safeParse(response).success;
}

describe("V1 exact-product plan API contracts", () => {
  it("accepts only versioned, required exact-product package or compatible measure needs", () => {
    expect(requestParses(validRequest)).toBe(true);
    expect(requestParses({ ...validRequest, contractVersion: 2 })).toBe(false);
    expect(requestParses({ ...validRequest, maxStores: 4 })).toBe(false);
    expect(requestParses({
      ...validRequest,
      needs: [{ ...exactNeed("need:milk"), quantity: 1.5 }],
    })).toBe(false);
    expect(requestParses({
      ...validRequest,
      needs: [{ ...exactNeed("need:milk"), quantity: 1_500, quantityUnit: "ml" }],
    })).toBe(true);
    expect(requestParses({
      ...validRequest,
      needs: [{ ...exactNeed("need:milk"), quantityUnit: "piece" }],
    })).toBe(true);
    expect(requestParses({
      ...validRequest,
      needs: [{ ...exactNeed("need:milk"), quantityUnit: "package" }],
    })).toBe(true);
    expect(requestParses({
      ...validRequest,
      needs: [{ ...exactNeed("need:milk"), required: false }],
    })).toBe(false);
  });

  it("rejects a checksum-invalid exact product identity", () => {
    expect(requestParses({
      ...validRequest,
      needs: [exactNeed("need:milk", "7038010000013")],
    })).toBe(false);
  });

  it("rejects duplicate need identities while allowing distinct needs for one GTIN", () => {
    expect(requestParses({
      ...validRequest,
      needs: [exactNeed("need:milk"), exactNeed("need:milk", GTIN_COFFEE)],
    })).toBe(false);
    expect(requestParses({
      ...validRequest,
      needs: [exactNeed("need:milk"), exactNeed("need:milk-again")],
    })).toBe(true);
  });

  it("rejects more than 50 required needs", () => {
    expect(requestParses({
      ...validRequest,
      needs: Array.from({ length: 51 }, (_, index) => exactNeed(`need:${index}`)),
    })).toBe(false);
  });

  it("rejects browser query, family, product metadata, and top-level context injection", () => {
    expect(requestParses({
      ...validRequest,
      needs: [{ ...exactNeed("need:milk"), query: "lettmelk" }],
    })).toBe(false);
    expect(requestParses({
      ...validRequest,
      needs: [{
        ...exactNeed("need:milk"),
        match: { ...exactNeed("need:milk").match, productFamily: "melk" },
      }],
    })).toBe(false);
    expect(requestParses({
      ...validRequest,
      needs: [{
        ...exactNeed("need:milk"),
        match: {
          ...exactNeed("need:milk").match,
          product: {
            ...exactNeed("need:milk").match.product,
            displayName: "Forged browser name",
          },
        },
      }],
    })).toBe(false);
    expect(requestParses({ ...validRequest, origin: { latitude: 59.9, longitude: 10.7 } }))
      .toBe(false);
    expect(requestParses({
      ...validRequest,
      needs: [{
        ...exactNeed("need:milk"),
        packageMeasure: { amount: 10_000, unit: "ml" },
      }],
    })).toBe(false);
  });

  it("accepts a strict response with source-neutral typed plans", () => {
    const parsed = exactProductPlanApiResponseSchemaFor(validRequest).safeParse(validResponse);
    expect(parsed.success ? undefined : parsed.error.issues).toBeUndefined();
    expect(responseParses(validRequest, { ...validResponse, browserSessionId: "private" }))
      .toBe(false);
    expect(responseParses(validRequest, { ...validResponse, plans: [{ opaque: true }] }))
      .toBe(false);
    expect(exactProductPlanApiResponseSchema.safeParse({
      ...validResponse,
      priceDataSource: "upstream",
    }).success).toBe(false);
  });

  it("requires fresh immutable catalog provenance and its exact declared public source", () => {
    expect(responseParses(validRequest, validResponse)).toBe(true);
    expect(responseParses(validRequest, {
      ...validResponse,
      products: [{ ...milkSummary, catalogEvidence: undefined }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      products: [{
        ...milkSummary,
        catalogEvidence: {
          ...milkSummary.catalogEvidence,
          privateReferenceKey: "must-not-leak",
        },
      }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      products: [{
        ...milkSummary,
        catalogEvidence: {
          ...milkSummary.catalogEvidence,
          sourceRecordId: "mutable-upstream-id",
        },
      }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      products: [{
        ...milkSummary,
        catalogEvidence: {
          ...milkSummary.catalogEvidence,
          observedAt: "2026-07-14T11:59:59.999Z",
        },
      }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      products: [{
        ...milkSummary,
        catalogEvidence: {
          ...milkSummary.catalogEvidence,
          observedAt: "2026-07-16T12:00:00.001Z",
        },
      }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: { ...validResponse.evidence, sources: [] },
      plans: [],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: {
        ...validResponse.evidence,
        sources: [{
          ...validResponse.evidence.sources[0]!,
          displayName: "Mismatched descriptor",
        }],
      },
    })).toBe(false);
  });

  it("requires explicit need-by-chain coverage and one immutable evidence reference per assignment", () => {
    expect(responseParses(validRequest, validResponse)).toBe(true);
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: {
        ...validResponse.evidence,
        assignmentEvidence: [],
      },
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: {
        ...validResponse.evidence,
        needs: validResponse.evidence.needs.map((entry) => ({
          ...entry,
          comparisonScope: {
            ...entry.comparisonScope,
            completeness: "complete",
          },
        })),
      },
    })).toBe(false);
  });

  it("cross-checks ordinary observation time and package-count checkout arithmetic", () => {
    expect(responseParses(validRequest, {
      ...validResponse,
      plans: [{
        ...validPlan,
        assignments: [{
          ...validPlan.assignments[0]!,
          observedAt: "2026-07-16T11:59:59.000Z",
        }],
      }],
    })).toBe(false);

    expect(responseParses(validRequest, {
      ...validResponse,
      plans: [{
        ...validPlan,
        assignments: [{
          ...validPlan.assignments[0]!,
          checkout: {
            ordinaryTotalOre: 4_979,
            savingOre: 0,
            totalOre: 4_979,
          },
          costOre: 4_979,
        }],
        totalOre: 4_979,
      }],
    })).toBe(false);
  });

  it("recomputes applied offers from immutable offer provenance", () => {
    const offer = {
      applicability: {
        channels: ["in-store" as const],
        contractVersion: 1 as const,
        endsAt: "2026-07-17T12:00:00.000Z",
        geographicScope: { countryCode: "NO", kind: "national" as const },
        startsAt: "2026-07-15T12:00:00.000Z",
      },
      capturedAt: "2026-07-16T11:00:00.000Z",
      chainId: "extra",
      conditions: [{ kind: "public" as const }],
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      id: "offer:fixture:milk",
      kind: "official-offer" as const,
      pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
      productMatch: { canonicalProductId: "product:fixture:milk", kind: "exact" as const },
      sourceId: "fixture-source",
      sourceRecordId: "source-record:offer:milk",
    };
    const offerPlan = {
      ...validPlan,
      assignments: [{
        ...validPlan.assignments[0]!,
        checkout: {
          appliedOfferId: offer.id,
          ordinaryTotalOre: 4_980,
          savingOre: 1_000,
          totalOre: 3_980,
        },
        costOre: 3_980,
        officialOffer: {
          capturedAt: offer.capturedAt,
          id: offer.id,
          sourceId: offer.sourceId,
          sourceRecordId: offer.sourceRecordId,
        },
      }],
      id: "plan-v2:fixture:offer",
      totalOre: 3_980,
    };
    const offerResponse = {
      ...validResponse,
      evidence: {
        ...responseEvidence(validRequest, [offerPlan]),
        assignmentEvidence: [{
          chainId: "extra",
          conditions: { kind: "official-offer" as const, offerId: offer.id },
          evidenceId: milkPriceEvidence.id,
          needId: "need:milk",
          planId: offerPlan.id,
        }],
        needs: responseEvidence(validRequest, [offerPlan]).needs.map((entry) => ({
          ...entry,
          officialOffers: [offer],
        })),
      },
      plans: [offerPlan],
    };
    expect(responseParses(validRequest, offerResponse)).toBe(true);

    expect(responseParses(validRequest, {
      ...offerResponse,
      evidence: {
        ...offerResponse.evidence,
        needs: offerResponse.evidence.needs.map((entry) => ({
          ...entry,
          officialOffers: [{
            ...offer,
            productMatch: { canonicalProductId: "product:fixture:other", kind: "exact" as const },
          }],
        })),
      },
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...offerResponse,
      plans: [{
        ...offerPlan,
        assignments: offerPlan.assignments.map((assignment) => ({
          ...assignment,
          officialOffer: {
            ...assignment.officialOffer,
            sourceRecordId: "source-record:offer:forged",
          },
        })),
      }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...offerResponse,
      plans: [{
        ...offerPlan,
        assignments: offerPlan.assignments.map((assignment) => ({
          ...assignment,
          checkout: {
            ...assignment.checkout,
            savingOre: 1_080,
            totalOre: 3_900,
          },
          costOre: 3_900,
        })),
        totalOre: 3_900,
      }],
    })).toBe(false);
    expect(responseParses(validRequest, {
      ...offerResponse,
      evidence: {
        ...offerResponse.evidence,
        needs: offerResponse.evidence.needs.map((entry) => ({
          ...entry,
          officialOffers: [{
            ...offer,
            applicability: {
              ...offer.applicability,
              endsAt: "2026-07-16T11:59:59.000Z",
            },
          }],
        })),
      },
    })).toBe(false);
  });

  it("binds every returned plan to the request need set and requested quantity", () => {
    const mismatchedQuantityPlan = {
      ...validPlan,
      assignments: [{
        ...validPlan.assignments[0]!,
        checkout: {
          ordinaryTotalOre: 2_490,
          savingOre: 0,
          totalOre: 2_490,
        },
        costOre: 2_490,
        fulfilment: {
          ...validPlan.assignments[0]!.fulfilment,
          packageCount: 1,
          purchased: { amount: 1, unit: "package" as const },
          requested: { amount: 1, unit: "package" as const },
        },
      }],
      totalOre: 2_490,
    };
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: responseEvidence(validRequest, [mismatchedQuantityPlan]),
      plans: [mismatchedQuantityPlan],
    })).toBe(false);

    const unknownNeedPlan = {
      ...validPlan,
      assignments: [{
        ...validPlan.assignments[0]!,
        fulfilment: {
          ...validPlan.assignments[0]!.fulfilment,
          needId: "need:unknown",
        },
        needId: "need:unknown",
      }],
      freshness: { "need:unknown": "eligible" as const },
    };
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: responseEvidence(validRequest, [unknownNeedPlan]),
      plans: [unknownNeedPlan],
    })).toBe(false);
  });

  it("enforces the request-specific maximum store count", () => {
    const request = {
      ...validRequest,
      maxStores: 1 as const,
      needs: [exactNeed("need:milk"), exactNeed("need:milk-again")],
    };
    const secondEvidence = {
      ...milkPriceEvidence,
      chainId: "bunnpris" as const,
      id: "price:fixture:2",
      sourceRecordId: "source-record:fixture:2",
    };
    const secondAssignment = {
      ...validPlan.assignments[0]!,
      chain: "bunnpris" as const,
      fulfilment: {
        ...validPlan.assignments[0]!.fulfilment,
        needId: "need:milk-again",
      },
      needId: "need:milk-again",
    };
    const twoStorePlan = {
      ...validPlan,
      assignments: [validPlan.assignments[0]!, secondAssignment],
      chains: ["bunnpris", "extra"] as const,
      freshness: {
        "need:milk": "eligible" as const,
        "need:milk-again": "eligible" as const,
      },
      id: "plan-v2:two-stores",
      totalOre: 9_960,
    };
    const secondNeedEvidence = {
      ...emptyNeedEvidence("need:milk-again"),
      comparisonScope: {
        ...emptyNeedEvidence("need:milk-again").comparisonScope,
        entries: [
          { chainId: "bunnpris", status: { kind: "priced" as const, evidenceId: secondEvidence.id } },
          { chainId: "extra", status: { kind: "unknown" as const, reason: "not-checked" as const } },
          { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
        ],
      },
      ordinaryPrices: [secondEvidence],
    };
    const baseEvidence = responseEvidence(request, [twoStorePlan]);
    const evidence = {
      ...baseEvidence,
      needs: [baseEvidence.needs[0]!, secondNeedEvidence]
        .sort((left, right) => left.needId.localeCompare(right.needId)),
      assignmentEvidence: [
        {
          chainId: "extra",
          conditions: { kind: "ordinary-price" as const },
          evidenceId: milkPriceEvidence.id,
          needId: "need:milk",
          planId: twoStorePlan.id,
        },
        {
          chainId: "bunnpris",
          conditions: { kind: "ordinary-price" as const },
          evidenceId: secondEvidence.id,
          needId: "need:milk-again",
          planId: twoStorePlan.id,
        },
      ],
    };

    expect(responseParses(request, {
      ...validResponse,
      evidence,
      plans: [twoStorePlan],
    })).toBe(false);
  });

  it("rejects duplicate plan IDs and bounds the public representative set to seven", () => {
    const duplicatePlans = [validPlan, validPlan];
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: responseEvidence(validRequest, duplicatePlans),
      plans: duplicatePlans,
    })).toBe(false);

    const duplicateAssignments = [
      validPlan,
      { ...validPlan, id: "plan-v2:fixture:same-assignments" },
    ];
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: responseEvidence(validRequest, duplicateAssignments),
      plans: duplicateAssignments,
    })).toBe(false);

    const eightPlans = Array.from({ length: 8 }, (_, index) => ({
      ...validPlan,
      id: `plan-v2:fixture:${index}`,
    }));
    expect(exactProductPlanApiResponseSchema.safeParse({
      ...validResponse,
      evidence: responseEvidence(validRequest, eightPlans),
      plans: eightPlans,
    }).success).toBe(false);
  });

  it("rejects dominated plans even when every assignment has valid evidence", () => {
    const expensiveEvidence = priceEvidenceSchema.parse({
      ...milkPriceEvidence,
      amountOre: 3_000,
      chainId: "bunnpris",
      id: "price:fixture:expensive",
      sourceRecordId: "source-record:fixture:expensive",
    });
    const expensivePlan = {
      ...validPlan,
      assignments: [{
        ...validPlan.assignments[0]!,
        chain: "bunnpris" as const,
        checkout: {
          ordinaryTotalOre: 6_000,
          savingOre: 0,
          totalOre: 6_000,
        },
        costOre: 6_000,
      }],
      chains: ["bunnpris"] as const,
      id: "plan-v2:fixture:dominated",
      totalOre: 6_000,
    };
    const evidence = exactProductPlanApiEvidenceEnvelopeSchema.parse(
      responseEvidence(validRequest, [validPlan, expensivePlan]),
    );
    evidence.assignmentEvidence[1]!.evidenceId = expensiveEvidence.id;
    evidence.needs[0] = {
      ...evidence.needs[0]!,
      comparisonScope: {
        ...evidence.needs[0]!.comparisonScope,
        entries: [
          {
            chainId: "bunnpris",
            status: { evidenceId: expensiveEvidence.id, kind: "priced" as const },
          },
          {
            chainId: "extra",
            status: { evidenceId: milkPriceEvidence.id, kind: "priced" as const },
          },
          {
            chainId: "rema-1000",
            status: { kind: "unknown" as const, reason: "not-checked" as const },
          },
        ],
      },
      ordinaryPrices: [expensiveEvidence, priceEvidenceSchema.parse(milkPriceEvidence)],
    };

    expect(responseParses(validRequest, {
      ...validResponse,
      evidence,
      plans: [validPlan, expensivePlan],
    })).toBe(false);
  });

  it("keeps ordinary price, official offer, and historical comparison fields distinct", () => {
    const needEvidence = validResponse.evidence.needs[0]!;
    expect(needEvidence).toMatchObject({
      ordinaryPrices: [{ kind: "price-evidence", priceKind: "ordinary" }],
      historicalPriceEvidence: [],
      excludedPriceEvidence: [],
      officialOffers: [],
      historicalComparisons: [],
    });
    expect(responseParses(validRequest, {
      ...validResponse,
      evidence: {
        ...validResponse.evidence,
        needs: [{
          ...needEvidence,
          historicalComparisons: [milkPriceEvidence],
        }],
      },
    })).toBe(false);
  });

  it("recomputes historical comparison provenance from the referenced observations", () => {
    const historicalPriceEvidence = Array.from({ length: 7 }, (_, index) => ({
      ...milkPriceEvidence,
      amountOre: 3_000,
      id: `price:history:${index}`,
      observedAt: new Date(Date.UTC(2026, 6, 9 + index, 12)).toISOString(),
      sourceRecordId: `source-record:history:${index}`,
    }));
    const comparison = {
      baselineMethod: "median-30d" as const,
      baselineOre: 3_000,
      canonicalProductId: "product:fixture:milk",
      chainId: "extra",
      contractVersion: 1 as const,
      currentEvidenceId: milkPriceEvidence.id,
      currentOre: 2_490,
      derivedAt: milkPriceEvidence.observedAt,
      distinctObservationDays: 7,
      id: "history:fixture:milk",
      kind: "historical-comparison" as const,
      savingsBasisPoints: 1_700,
      savingsOre: 510,
      sourceEvidenceIds: historicalPriceEvidence.map(({ id }) => id),
      windowEndsAt: milkPriceEvidence.observedAt,
      windowStartsAt: "2026-06-16T12:00:00.000Z",
    };
    const evidence = {
      ...validResponse.evidence.needs[0]!,
      historicalComparisons: [comparison],
      historicalPriceEvidence,
    };
    expect(exactProductPlanApiNeedEvidenceSchema.safeParse(evidence).success).toBe(true);

    expect(exactProductPlanApiNeedEvidenceSchema.safeParse({
      ...evidence,
      historicalComparisons: [{
        ...comparison,
        currentOre: 2_480,
        savingsBasisPoints: 1_733,
        savingsOre: 520,
      }],
    }).success).toBe(false);
    expect(exactProductPlanApiNeedEvidenceSchema.safeParse({
      ...evidence,
      historicalComparisons: [{
        ...comparison,
        baselineOre: 3_100,
        savingsBasisPoints: 1_967,
        savingsOre: 610,
      }],
    }).success).toBe(false);
    expect(exactProductPlanApiNeedEvidenceSchema.safeParse({
      ...evidence,
      historicalPriceEvidence: historicalPriceEvidence.map((row) => ({
        ...row,
        observedAt: "2026-07-15T12:00:00.000Z",
      })),
    }).success).toBe(false);
    expect(exactProductPlanApiNeedEvidenceSchema.safeParse({
      ...evidence,
      historicalComparisons: [{
        ...comparison,
        canonicalProductId: "product:fixture:other",
      }],
    }).success).toBe(false);
  });

  it("requires exactly one product summary for each distinct requested GTIN", () => {
    const request = {
      ...validRequest,
      needs: [exactNeed("need:milk"), exactNeed("need:coffee", GTIN_COFFEE)],
    };
    const response = {
      ...validResponse,
      evidence: responseEvidence(request),
      plans: [],
      products: [milkSummary, coffeeSummary],
    };

    expect(responseParses(request, response)).toBe(true);
    expect(responseParses(request, { ...response, products: [milkSummary] })).toBe(false);
    expect(responseParses(request, {
      ...response,
      products: [milkSummary, coffeeSummary, breadSummary],
    })).toBe(false);
    expect(responseParses(request, {
      ...response,
      products: [milkSummary, milkSummary],
    })).toBe(false);

    const repeatedProductRequest = {
      ...validRequest,
      needs: [exactNeed("need:milk"), exactNeed("need:milk-again")],
    };
    expect(responseParses(repeatedProductRequest, {
      ...validResponse,
      evidence: responseEvidence(repeatedProductRequest),
      plans: [],
      products: [milkSummary],
    })).toBe(true);
  });

  it("requires product summaries in canonical GTIN order", () => {
    const request = {
      ...validRequest,
      needs: [exactNeed("need:coffee", GTIN_COFFEE), exactNeed("need:milk")],
    };
    const response = {
      ...validResponse,
      evidence: responseEvidence(request),
      plans: [],
      products: [milkSummary, coffeeSummary],
    };

    expect(responseParses(request, response)).toBe(true);
    expect(responseParses(request, { ...response, products: [coffeeSummary, milkSummary] }))
      .toBe(false);
  });

  it("bounds every public evidence collection without weakening seven-day history", () => {
    const source = validResponse.evidence.sources[0]!;
    const envelope = {
      assignmentEvidence: [],
      needs: [emptyNeedEvidence("need:milk")],
      sources: [],
    };
    expect(exactProductPlanApiEvidenceEnvelopeSchema.safeParse({
      ...envelope,
      sources: Array.from({ length: 100 }, (_, index) => ({
        ...source,
        id: `source:${index}`,
      })),
    }).success).toBe(true);
    expect(exactProductPlanApiEvidenceEnvelopeSchema.safeParse({
      ...envelope,
      sources: Array.from({ length: 101 }, (_, index) => ({
        ...source,
        id: `source:${index}`,
      })),
    }).success).toBe(false);

    const assignmentReference = validResponse.evidence.assignmentEvidence[0]!;
    expect(exactProductPlanApiEvidenceEnvelopeSchema.safeParse({
      ...envelope,
      assignmentEvidence: Array.from({ length: 350 }, (_, index) => ({
        ...assignmentReference,
        planId: `plan:${index}`,
      })),
    }).success).toBe(true);
    expect(exactProductPlanApiEvidenceEnvelopeSchema.safeParse({
      ...envelope,
      assignmentEvidence: Array.from({ length: 351 }, (_, index) => ({
        ...assignmentReference,
        planId: `plan:${index}`,
      })),
    }).success).toBe(false);

    const offer = (index: number) => ({
      applicability: {
        channels: ["in-store" as const],
        contractVersion: 1 as const,
        endsAt: "2026-07-17T12:00:00.000Z",
        geographicScope: { countryCode: "NO", kind: "national" as const },
        startsAt: "2026-07-15T12:00:00.000Z",
      },
      capturedAt: "2026-07-16T11:00:00.000Z",
      chainId: "extra",
      conditions: [{ kind: "public" as const }],
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      id: `offer:${index}`,
      kind: "official-offer" as const,
      pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
      productMatch: { canonicalProductId: "product:fixture:milk", kind: "exact" as const },
      sourceId: "fixture-source",
      sourceRecordId: `source-record:offer:${index}`,
    });
    expect(exactProductPlanApiNeedEvidenceSchema.safeParse({
      ...emptyNeedEvidence("need:milk"),
      officialOffers: Array.from({ length: 50 }, (_, index) => offer(index)),
    }).success).toBe(true);
    expect(exactProductPlanApiNeedEvidenceSchema.safeParse({
      ...emptyNeedEvidence("need:milk"),
      officialOffers: Array.from({ length: 51 }, (_, index) => offer(index)),
    }).success).toBe(false);

    const oversizedCollections = [
      ["ordinaryPrices", 4],
      ["excludedPriceEvidence", 4],
      ["historicalComparisons", 4],
      ["historicalPriceEvidence", 301],
    ] as const;
    for (const [field, length] of oversizedCollections) {
      const parsed = exactProductPlanApiNeedEvidenceSchema.safeParse({
        ...emptyNeedEvidence("need:milk"),
        [field]: Array.from({ length }, () => ({})),
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) =>
          issue.code === "too_big" && issue.path[0] === field)).toBe(true);
      }
    }

    expect(exactProductPlanApiResponseSchema.safeParse({
      ...validResponse,
      caveats: Array.from({ length: 10 }, (_, index) => `Caveat ${index}`),
    }).success).toBe(true);
    expect(exactProductPlanApiResponseSchema.safeParse({
      ...validResponse,
      caveats: Array.from({ length: 11 }, (_, index) => `Caveat ${index}`),
    }).success).toBe(false);
  });
});
