import { describe, expect, it } from "vitest";

import {
  historicalComparisonSchema,
  officialOfferSchema,
  parseApplicableOfficialOffer,
} from "./index";

const offer = {
  contractVersion: 1,
  kind: "official-offer" as const,
  id: "offer:1",
  sourceId: "retailer-feed",
  sourceRecordId: "campaign:42",
  chainId: "extra",
  productMatch: { kind: "exact" as const, canonicalProductId: "product:coffee" },
  pricing: { kind: "multibuy" as const, quantity: 2, totalOre: 10_000 },
  beforePriceOre: 6_990,
  conditions: [{ kind: "member" as const, programId: "coop-medlem" }],
  applicability: {
    contractVersion: 1,
    startsAt: "2026-07-14T00:00:00.000Z",
    endsAt: "2026-07-19T23:59:59.999Z",
    geographicScope: { kind: "regions" as const, countryCode: "NO", regionCodes: ["NO-03"] },
    channels: ["in-store" as const],
  },
  evidenceLevel: "reviewed" as const,
  capturedAt: "2026-07-15T10:00:00.000Z",
};

const context = {
  now: new Date("2026-07-16T12:00:00.000Z"),
  maxEvidenceAgeMs: 14 * 24 * 60 * 60 * 1_000,
  location: { countryCode: "NO", regionCode: "NO-03", storeId: "store:oslo" },
  channel: "in-store" as const,
  enabledSourceIds: ["retailer-feed"],
  enabledMembershipProgramIds: ["coop-medlem"],
};

describe("official offer and historical comparison contracts", () => {
  it("keeps official offers and historical comparisons runtime-distinct", () => {
    expect(officialOfferSchema.safeParse(offer).success).toBe(true);
    expect(parseApplicableOfficialOffer(offer, context)).toEqual({
      applicable: true,
      offer,
    });
    expect(historicalComparisonSchema.safeParse(offer).success).toBe(false);

    const history = {
      contractVersion: 1,
      kind: "historical-comparison",
      id: "history:1",
      canonicalProductId: "product:coffee",
      chainId: "extra",
      currentEvidenceId: "price:current",
      baselineMethod: "median-30d",
      baselineOre: 6_990,
      currentOre: 4_990,
      savingsOre: 2_000,
      savingsBasisPoints: 2_861,
      distinctObservationDays: 7,
      windowStartsAt: "2026-06-16T12:00:00.000Z",
      windowEndsAt: "2026-07-16T12:00:00.000Z",
      derivedAt: "2026-07-16T12:00:00.000Z",
      sourceEvidenceIds: ["price:1", "price:2"],
    };

    expect(historicalComparisonSchema.safeParse(history).success).toBe(true);
    expect(officialOfferSchema.safeParse(history).success).toBe(false);
  });

  it("fails closed for expired, wrong-scope, stale, ambiguous, and disabled-member offers", () => {
    const cases = [
      {
        expected: "expired",
        value: {
          ...offer,
          applicability: { ...offer.applicability, endsAt: "2026-07-16T11:59:59.999Z" },
        },
        context,
      },
      {
        expected: "wrong-scope",
        value: {
          ...offer,
          applicability: {
            ...offer.applicability,
            geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-46"] },
          },
        },
        context,
      },
      {
        expected: "stale",
        value: { ...offer, capturedAt: "2026-07-01T00:00:00.000Z" },
        context,
      },
      {
        expected: "ambiguous",
        value: {
          ...offer,
          productMatch: {
            kind: "ambiguous",
            candidateProductIds: ["product:coffee-a", "product:coffee-b"],
          },
        },
        context,
      },
      {
        expected: "membership-disabled",
        value: offer,
        context: { ...context, enabledMembershipProgramIds: [] },
      },
    ];

    for (const testCase of cases) {
      expect(parseApplicableOfficialOffer(testCase.value, testCase.context)).toEqual({
        applicable: false,
        reason: testCase.expected,
      });
    }
  });

  it("rejects unsafe offer arithmetic and contradictory history arithmetic", () => {
    expect(
      officialOfferSchema.safeParse({
        ...offer,
        pricing: { kind: "multibuy", quantity: 1, totalOre: 5_000 },
      }).success,
    ).toBe(false);
    expect(
      officialOfferSchema.safeParse({
        ...offer,
        pricing: { kind: "multibuy", quantity: Number.MAX_SAFE_INTEGER, totalOre: 10_000 },
      }).success,
    ).toBe(false);
    expect(
      officialOfferSchema.safeParse({
        ...offer,
        pricing: { kind: "unit", unitPriceOre: 7_000 },
        beforePriceOre: 6_990,
      }).success,
    ).toBe(false);
    expect(
      officialOfferSchema.safeParse({
        ...offer,
        pricing: { kind: "multibuy", quantity: 2, totalOre: 14_000 },
        beforePriceOre: 6_990,
      }).success,
    ).toBe(false);
    expect(
      historicalComparisonSchema.safeParse({
        contractVersion: 1,
        kind: "historical-comparison",
        id: "history:bad",
        canonicalProductId: "product:coffee",
        chainId: "extra",
        currentEvidenceId: "price:current",
        baselineMethod: "median-30d",
        baselineOre: 6_990,
        currentOre: 4_990,
        savingsOre: 1,
        savingsBasisPoints: 2_861,
        distinctObservationDays: 7,
        windowStartsAt: "2026-06-16T12:00:00.000Z",
        windowEndsAt: "2026-07-16T12:00:00.000Z",
        derivedAt: "2026-07-16T12:00:00.000Z",
        sourceEvidenceIds: ["price:1", "price:2"],
      }).success,
    ).toBe(false);
  });

  it("rejects zero-duration offer validity", () => {
    expect(
      officialOfferSchema.safeParse({
        ...offer,
        applicability: {
          ...offer.applicability,
          endsAt: offer.applicability.startsAt,
        },
      }).success,
    ).toBe(false);
  });
});
