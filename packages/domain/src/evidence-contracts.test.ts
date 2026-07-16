import { describe, expect, it } from "vitest";

import {
  comparisonScopeSchema,
  coverageStatusSchema,
  isKnownAbsent,
  parseEligiblePriceEvidence,
  priceEvidenceSchema,
  priceObservationSchema,
  sourceNeutralPriceObservationSchema,
  type PriceObservation,
} from "./index";

const now = new Date("2026-07-16T12:00:00.000Z");
const location = { countryCode: "NO", regionCode: "NO-03", storeId: "store:oslo" };

const validEvidence = {
  contractVersion: 1,
  kind: "price-evidence" as const,
  id: "price:1",
  sourceId: "kassalapp",
  sourceRecordId: "upstream:1",
  chainId: "rema-1000",
  productMatch: { kind: "exact" as const, canonicalProductId: "product:milk" },
  amountOre: 2_490,
  priceKind: "ordinary" as const,
  evidenceLevel: "observed" as const,
  observedAt: "2026-07-16T10:00:00.000Z",
  geographicScope: { kind: "national" as const, countryCode: "NO" },
};

const context = {
  now,
  maxAgeMs: 72 * 60 * 60 * 1_000,
  location,
  enabledSourceIds: ["kassalapp"],
};

describe("price evidence and coverage contracts", () => {
  it("accepts source-neutral evidence and keeps legacy Kassalapp observations compatible", () => {
    const retailerObservation: PriceObservation<"licensed-retailer-feed"> = {
      ean: "7038010000010",
      chain: "extra",
      amountOre: 2_490 as PriceObservation["amountOre"],
      observedAt: "2026-07-16T10:00:00.000Z",
      source: "licensed-retailer-feed",
    };

    expect(priceEvidenceSchema.safeParse(validEvidence).success).toBe(true);
    expect(parseEligiblePriceEvidence(validEvidence, context)).toEqual({
      eligible: true,
      evidence: validEvidence,
    });
    expect(sourceNeutralPriceObservationSchema.safeParse(retailerObservation).success).toBe(true);
    expect(priceObservationSchema.safeParse(retailerObservation).success).toBe(false);
    expect(
      priceObservationSchema.safeParse({ ...retailerObservation, source: "kassalapp" }).success,
    ).toBe(true);
  });

  it("fails closed on stale, future, expired, wrong-scope, ambiguous, and disabled-source evidence", () => {
    const cases = [
      {
        expected: "stale",
        evidence: { ...validEvidence, observedAt: "2026-07-13T11:59:59.999Z" },
        context,
      },
      {
        expected: "future",
        evidence: { ...validEvidence, observedAt: "2026-07-16T12:00:00.001Z" },
        context,
      },
      {
        expected: "expired",
        evidence: { ...validEvidence, validUntil: "2026-07-16T11:59:59.999Z" },
        context,
      },
      {
        expected: "wrong-scope",
        evidence: {
          ...validEvidence,
          geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-46"] },
        },
        context,
      },
      {
        expected: "ambiguous",
        evidence: {
          ...validEvidence,
          productMatch: {
            kind: "ambiguous",
            candidateProductIds: ["product:milk-a", "product:milk-b"],
          },
        },
        context,
      },
      {
        expected: "source-disabled",
        evidence: validEvidence,
        context: { ...context, enabledSourceIds: [] },
      },
    ];

    for (const testCase of cases) {
      expect(parseEligiblePriceEvidence(testCase.evidence, testCase.context)).toEqual({
        eligible: false,
        reason: testCase.expected,
      });
    }
  });

  it("rejects unsafe money and invalid validity intervals", () => {
    expect(
      priceEvidenceSchema.safeParse({ ...validEvidence, amountOre: 2_147_483_648 }).success,
    ).toBe(false);
    expect(
      priceEvidenceSchema.safeParse({ ...validEvidence, amountOre: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(
      priceEvidenceSchema.safeParse({
        ...validEvidence,
        validFrom: "2026-07-17T00:00:00.000Z",
        validUntil: "2026-07-16T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      priceEvidenceSchema.safeParse({
        ...validEvidence,
        validFrom: "2026-07-16T00:00:00.000Z",
        validUntil: "2026-07-16T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("never treats unknown coverage as known absence", () => {
    const unknown = coverageStatusSchema.parse({
      kind: "unknown",
      reason: "source-unavailable",
      checkedAt: "2026-07-16T10:00:00.000Z",
    });
    const absent = coverageStatusSchema.parse({
      kind: "known-not-carried",
      sourceId: "retailer-feed",
      checkedAt: "2026-07-16T10:00:00.000Z",
    });

    expect(isKnownAbsent(unknown)).toBe(false);
    expect(isKnownAbsent(absent)).toBe(true);
    expect(
      coverageStatusSchema.safeParse({
        kind: "known-not-carried",
        reason: "source-unavailable",
        checkedAt: "2026-07-16T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("keeps stale and ineligible coverage distinct from unknown and known absence", () => {
    const stale = coverageStatusSchema.parse({
      kind: "stale",
      evidenceId: "price:stale",
      observedAt: "2026-07-10T10:00:00.000Z",
      staleAt: "2026-07-13T10:00:00.000Z",
    });
    const ineligible = coverageStatusSchema.parse({
      kind: "ineligible",
      evidenceId: "price:wrong-scope",
      reason: "wrong-scope",
      evaluatedAt: "2026-07-16T10:00:00.000Z",
    });

    expect(stale.kind).toBe("stale");
    expect(ineligible.kind).toBe("ineligible");
    expect(isKnownAbsent(stale)).toBe(false);
    expect(isKnownAbsent(ineligible)).toBe(false);
  });

  it("requires partial comparison scope when any declared chain is unknown", () => {
    const entries = [
      { chainId: "rema-1000", status: { kind: "priced", evidenceId: "price:1" } },
      {
        chainId: "extra",
        status: {
          kind: "unknown",
          reason: "not-checked",
          checkedAt: "2026-07-16T10:00:00.000Z",
        },
      },
    ];

    expect(
      comparisonScopeSchema.safeParse({
        contractVersion: 1,
        completeness: "partial",
        evaluatedAt: "2026-07-16T12:00:00.000Z",
        expectedChainIds: ["rema-1000", "extra"],
        entries,
      }).success,
    ).toBe(true);
    expect(
      comparisonScopeSchema.safeParse({
        contractVersion: 1,
        completeness: "complete",
        evaluatedAt: "2026-07-16T12:00:00.000Z",
        expectedChainIds: ["rema-1000", "extra"],
        entries,
      }).success,
    ).toBe(false);
  });

  it("cannot declare complete coverage for only a subset of the expected chains", () => {
    expect(
      comparisonScopeSchema.safeParse({
        contractVersion: 1,
        completeness: "complete",
        evaluatedAt: "2026-07-16T12:00:00.000Z",
        expectedChainIds: ["bunnpris", "rema-1000", "extra"],
        entries: [
          { chainId: "rema-1000", status: { kind: "priced", evidenceId: "price:1" } },
        ],
      }).success,
    ).toBe(false);
  });
});
