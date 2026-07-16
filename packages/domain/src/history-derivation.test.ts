import { describe, expect, it } from "vitest";

import { deriveHistoricalComparison, historicalComparisonSchema } from "./history";

const CURRENT_AT = "2026-07-16T12:00:00.000Z";
const DERIVED_AT = new Date("2026-07-16T12:05:00.000Z");
const ELIGIBILITY = {
  currentMaxAgeMs: 72 * 60 * 60 * 1_000,
  enabledSourceIds: ["licensed-history-source"],
  location: { countryCode: "NO", regionCode: "NO-03" },
} as const;

function evidence(
  id: string,
  observedAt: string,
  amountOre: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    contractVersion: 1,
    kind: "price-evidence",
    id,
    sourceId: "licensed-history-source",
    sourceRecordId: `source:${id}`,
    chainId: "extra",
    productMatch: { kind: "exact", canonicalProductId: "product:coffee" },
    amountOre,
    priceKind: "ordinary",
    evidenceLevel: "observed",
    observedAt,
    geographicScope: { kind: "national", countryCode: "NO" },
    ...overrides,
  };
}

function history(amounts = [1_200, 1_000, 1_100, 1_400, 1_300, 1_500, 1_600]) {
  return amounts.map((amountOre, index) =>
    evidence(
      `price:history:${index + 1}`,
      `2026-07-${String(15 - index).padStart(2, "0")}T12:00:00.000Z`,
      amountOre,
    ),
  );
}

function derive(
  historicalEvidence: readonly unknown[] = history(),
  currentEvidence: unknown = evidence("price:current", CURRENT_AT, 900),
  derivedAt = DERIVED_AT,
) {
  return deriveHistoricalComparison({
    comparisonId: "history:coffee:extra:current",
    currentEvidence,
    historicalEvidence,
    derivedAt,
    eligibility: ELIGIBILITY,
  });
}

describe("deriveHistoricalComparison", () => {
  it("derives a source-neutral 30-day median claim from seven UTC observation days", () => {
    expect(derive()).toEqual({
      contractVersion: 1,
      kind: "historical-comparison",
      id: "history:coffee:extra:current",
      canonicalProductId: "product:coffee",
      chainId: "extra",
      currentEvidenceId: "price:current",
      baselineMethod: "median-30d",
      baselineOre: 1_300,
      currentOre: 900,
      savingsOre: 400,
      savingsBasisPoints: 3_076,
      distinctObservationDays: 7,
      windowStartsAt: "2026-06-16T12:00:00.000Z",
      windowEndsAt: CURRENT_AT,
      derivedAt: DERIVED_AT.toISOString(),
      sourceEvidenceIds: [
        "price:history:7",
        "price:history:6",
        "price:history:5",
        "price:history:4",
        "price:history:3",
        "price:history:2",
        "price:history:1",
      ],
    });
  });

  it("uses the floor of the two middle ore values for an even-count median", () => {
    const lowerCurrent = evidence("price:current", CURRENT_AT, 200);
    expect(
      derive(history([100, 101, 200, 201, 300, 301, 1_000, 1_001]), lowerCurrent),
    ).toMatchObject({
      baselineOre: 250,
      savingsOre: 50,
      savingsBasisPoints: 2_000,
    });
  });

  it("includes the exact lower boundary and excludes malformed or incomparable records", () => {
    const valid = history();
    const comparison = derive([
      ...valid,
      evidence("price:window-start", "2026-06-16T12:00:00.000Z", 1_300),
      evidence("price:too-old", "2026-06-16T11:59:59.999Z", 10),
      evidence("price:at-current", CURRENT_AT, 10),
      evidence("price:future", "2026-07-16T12:00:00.001Z", 10),
      evidence("price:wrong-product", "2026-07-08T12:00:00.000Z", 10, {
        productMatch: { kind: "exact", canonicalProductId: "product:tea" },
      }),
      evidence("price:wrong-chain", "2026-07-08T12:00:00.000Z", 10, {
        chainId: "rema-1000",
      }),
      evidence("price:checkout", "2026-07-08T12:00:00.000Z", 10, {
        priceKind: "checkout",
      }),
      evidence("price:ambiguous", "2026-07-08T12:00:00.000Z", 10, {
        evidenceLevel: "ambiguous",
      }),
      { id: "price:malformed", observedAt: "not-a-date", amountOre: 1 },
    ]);

    expect(comparison).not.toBeNull();
    expect(comparison?.distinctObservationDays).toBe(8);
    expect(comparison?.sourceEvidenceIds).toEqual([
      "price:window-start",
      "price:history:7",
      "price:history:6",
      "price:history:5",
      "price:history:4",
      "price:history:3",
      "price:history:2",
      "price:history:1",
    ]);
  });

  it("deduplicates identical evidence IDs and remains stable for shuffled input", () => {
    const records = history();
    const duplicateWithDifferentKeyOrder = {
      geographicScope: records[2]!.geographicScope,
      observedAt: records[2]!.observedAt,
      evidenceLevel: records[2]!.evidenceLevel,
      priceKind: records[2]!.priceKind,
      amountOre: records[2]!.amountOre,
      productMatch: records[2]!.productMatch,
      chainId: records[2]!.chainId,
      sourceRecordId: records[2]!.sourceRecordId,
      sourceId: records[2]!.sourceId,
      id: records[2]!.id,
      kind: records[2]!.kind,
      contractVersion: records[2]!.contractVersion,
    };

    const forward = derive([...records, duplicateWithDifferentKeyOrder]);
    const reverse = derive([duplicateWithDifferentKeyOrder, ...[...records].reverse()]);

    expect(forward).toEqual(reverse);
    expect(forward?.sourceEvidenceIds).toHaveLength(7);
  });

  it("fails closed when one valid evidence ID has conflicting contents", () => {
    const records = history();
    expect(
      derive([
        ...records,
        { ...records[0], amountOre: (records[0]?.amountOre as number) + 1 },
      ]),
    ).toBeNull();
  });

  it("requires seven distinct baseline evidence IDs and excludes the current identity", () => {
    const valid = derive();
    expect(valid).not.toBeNull();
    expect(historicalComparisonSchema.safeParse({
      ...valid,
      sourceEvidenceIds: valid!.sourceEvidenceIds.slice(0, 6),
    }).success).toBe(false);
    expect(historicalComparisonSchema.safeParse({
      ...valid,
      sourceEvidenceIds: [valid!.currentEvidenceId, ...valid!.sourceEvidenceIds.slice(1)],
    }).success).toBe(false);
    expect(historicalComparisonSchema.safeParse({
      ...valid,
      distinctObservationDays: 8,
    }).success).toBe(false);
  });

  it("rejects a persisted comparison derived more than 72 hours after its current price", () => {
    const valid = derive();
    expect(valid).not.toBeNull();
    expect(historicalComparisonSchema.safeParse({
      ...valid,
      derivedAt: "2026-07-19T12:00:00.000Z",
    }).success).toBe(true);
    expect(historicalComparisonSchema.safeParse({
      ...valid,
      derivedAt: "2026-07-19T12:00:00.001Z",
    }).success).toBe(false);
  });

  it("never admits the current observation as a baseline", () => {
    const current = evidence("price:current", CURRENT_AT, 900);

    expect(derive([...history(), current], current)?.sourceEvidenceIds).not.toContain("price:current");
    expect(
      derive([...history(), { ...current, amountOre: 901 }], current),
    ).toBeNull();
  });

  it("returns no claim below seven distinct days or without positive savings", () => {
    expect(derive(history().slice(0, 6))).toBeNull();
    expect(derive(history(), evidence("price:current", CURRENT_AT, 1_300))).toBeNull();
    expect(derive(history(), evidence("price:current", CURRENT_AT, 1_301))).toBeNull();
  });

  it("returns no claim for malformed or future current evidence and invalid comparison metadata", () => {
    expect(derive(history(), { id: "price:current" })).toBeNull();
    expect(derive(history(), evidence("price:current", CURRENT_AT, 900, { priceKind: "checkout" }))).toBeNull();
    expect(derive(history(), evidence("price:current", CURRENT_AT, 900), new Date("invalid"))).toBeNull();
    expect(
      derive(history(), evidence("price:current", CURRENT_AT, 900), new Date("2026-07-16T11:59:59.999Z")),
    ).toBeNull();
    expect(
      deriveHistoricalComparison({
        comparisonId: " ",
        currentEvidence: evidence("price:current", CURRENT_AT, 900),
        historicalEvidence: history(),
        derivedAt: DERIVED_AT,
        eligibility: ELIGIBILITY,
      }),
    ).toBeNull();
  });

  it("requires an eligible fresh current source and eligible historical scope", () => {
    expect(deriveHistoricalComparison({
      comparisonId: "history:coffee:extra:current",
      currentEvidence: evidence("price:current", "2026-07-13T12:04:59.999Z", 900),
      historicalEvidence: history(),
      derivedAt: DERIVED_AT,
      eligibility: ELIGIBILITY,
    })).toBeNull();
    expect(deriveHistoricalComparison({
      comparisonId: "history:coffee:extra:current",
      currentEvidence: evidence("price:current", CURRENT_AT, 900),
      historicalEvidence: history(),
      derivedAt: DERIVED_AT,
      eligibility: { ...ELIGIBILITY, enabledSourceIds: [] },
    })).toBeNull();
    expect(deriveHistoricalComparison({
      comparisonId: "history:coffee:extra:current",
      currentEvidence: evidence("price:current", CURRENT_AT, 900),
      historicalEvidence: history(),
      derivedAt: DERIVED_AT,
      eligibility: { ...ELIGIBILITY, currentMaxAgeMs: 72 * 60 * 60 * 1_000 + 1 },
    })).toBeNull();
    expect(deriveHistoricalComparison({
      comparisonId: "history:coffee:extra:current",
      currentEvidence: evidence("price:current", CURRENT_AT, 900, {
        geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-46"] },
      }),
      historicalEvidence: history(),
      derivedAt: DERIVED_AT,
      eligibility: ELIGIBILITY,
    })).toBeNull();

    const wrongScopeBaseline = history().map((row, index) => index === 0
      ? {
          ...row,
          geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-46"] },
        }
      : row);
    expect(derive(wrongScopeBaseline)).toBeNull();
  });

  it("keeps worst-case savings and basis-point arithmetic within safe integer contracts", () => {
    const largestPersistedOre = 2_147_483_647;
    const records = history(Array(7).fill(largestPersistedOre));
    const comparison = derive(records, evidence("price:current", CURRENT_AT, 0));

    expect(comparison).toMatchObject({
      baselineOre: largestPersistedOre,
      currentOre: 0,
      savingsOre: largestPersistedOre,
      savingsBasisPoints: 10_000,
    });
    expect(Number.isSafeInteger(comparison?.savingsBasisPoints)).toBe(true);
  });

  it("counts UTC dates correctly when the rolling window touches 31 calendar days", () => {
    const records = [
      evidence("price:day:0", "2026-06-16T12:00:00.000Z", 1_000),
      ...Array.from({ length: 29 }, (_, index) => {
        const observedAt = new Date(Date.UTC(2026, 5, 17 + index, 12)).toISOString();
        return evidence(`price:day:${index + 1}`, observedAt, 1_000);
      }),
      evidence("price:day:30", "2026-07-16T11:59:59.999Z", 1_000),
    ];

    expect(derive(records)).toMatchObject({ distinctObservationDays: 31, baselineOre: 1_000 });
  });

  it("fails closed instead of throwing for a non-Date derivation time", () => {
    expect(() =>
      deriveHistoricalComparison({
        comparisonId: "history:coffee:extra:current",
        currentEvidence: evidence("price:current", CURRENT_AT, 900),
        historicalEvidence: history(),
        derivedAt: "2026-07-16T12:05:00.000Z" as unknown as Date,
        eligibility: ELIGIBILITY,
      }),
    ).not.toThrow();
    expect(
      deriveHistoricalComparison({
        comparisonId: "history:coffee:extra:current",
        currentEvidence: evidence("price:current", CURRENT_AT, 900),
        historicalEvidence: history(),
        derivedAt: "2026-07-16T12:05:00.000Z" as unknown as Date,
        eligibility: ELIGIBILITY,
      }),
    ).toBeNull();
  });
});
