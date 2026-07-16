import type {
  PlanningEvidenceReader,
  PlanningEvidenceSnapshot,
} from "@handleplan/db/planning-evidence-reader";
import {
  exactProductPlanApiEvidenceEnvelopeSchema,
  type ExactProductPlanApiRequest,
  type PriceEvidence,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import { PriceService, PriceServiceError } from "./price-service";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const GTIN = "7038010000010";
const GTIN_ALIAS = "7038010000027";
const REQUEST: ExactProductPlanApiRequest = {
  contractVersion: 1,
  maxStores: 3,
  needs: [{
    id: "need:milk",
    match: {
      kind: "exact-product",
      product: { kind: "gtin", value: GTIN },
      userApproved: true,
    },
    quantity: 2,
    quantityUnit: "package",
    required: true,
  }],
};

function evidence(
  id: string,
  chainId: "bunnpris" | "extra" | "rema-1000",
  observedAt: string,
  amountOre: number,
  sourceId = "licensed-price",
): PriceEvidence {
  return {
    amountOre: amountOre as PriceEvidence["amountOre"],
    chainId,
    contractVersion: 1,
    evidenceLevel: "observed",
    geographicScope: { countryCode: "NO", kind: "national" },
    id,
    kind: "price-evidence",
    observedAt,
    priceKind: "ordinary",
    productMatch: { canonicalProductId: "product:42", kind: "exact" },
    sourceId,
    sourceRecordId: `record:${id}`,
  };
}

function snapshot(): PlanningEvidenceSnapshot {
  const history = Array.from({ length: 7 }, (_, index) => evidence(
    `price:history:${index + 1}`,
    "extra",
    `2026-07-${String(15 - index).padStart(2, "0")}T10:00:00.000Z`,
    3_000,
  ));
  return {
    coverageChecks: [{
      canonicalProductId: "product:42",
      chainId: "bunnpris",
      checkedAt: "2026-07-16T11:30:00.000Z",
      contractVersion: 1,
      geographicScope: { countryCode: "NO", kind: "national" },
      id: "coverage:bunnpris",
      sourceId: "coverage-feed",
      state: "known-not-carried",
    }],
    historicalEligibleEvidenceIds: history.map(({ id }) => id),
    priceEvidence: [
      evidence("price:current", "extra", "2026-07-16T11:00:00.000Z", 2_490),
      evidence("price:older-current", "extra", "2026-07-16T10:00:00.000Z", 4_000),
      ...history,
      evidence("price:stale", "bunnpris", "2026-07-12T11:59:59.999Z", 1_000),
    ],
    products: [{ canonicalProductId: "product:42", gtin: GTIN }],
    sources: [
      {
        contractVersion: 1,
        displayName: "Coverage feed",
        id: "coverage-feed",
        sourceClass: "ordinary-price",
        state: "approved",
      },
      {
        contractVersion: 1,
        displayName: "Licensed price",
        id: "licensed-price",
        sourceClass: "ordinary-price",
        state: "approved",
      },
      {
        contractVersion: 1,
        displayName: "Unused approved source",
        id: "unused-source",
        sourceClass: "ordinary-price",
        state: "approved",
      },
    ],
  };
}

function readerWith(value: PlanningEvidenceSnapshot): PlanningEvidenceReader & {
  getMany: ReturnType<typeof vi.fn<PlanningEvidenceReader["getMany"]>>;
} {
  return {
    getMany: vi.fn(async () => value),
  };
}

describe("PriceService", () => {
  it("reads one canonical product union for flexible server planning", async () => {
    const second = snapshot();
    second.products = [
      { canonicalProductId: "product:42", gtin: GTIN },
      { canonicalProductId: "product:42", gtin: GTIN_ALIAS },
    ];
    const reader = readerWith(second);
    const result = await new PriceService({ reader }).readProducts(
      [GTIN_ALIAS, GTIN],
      NOW,
    );

    expect(reader.getMany).toHaveBeenCalledTimes(1);
    expect(reader.getMany).toHaveBeenCalledWith([GTIN, GTIN_ALIAS], NOW, undefined);
    expect(result.productEvidence.map(({ gtin }) => gtin)).toEqual([GTIN, GTIN_ALIAS]);
    expect(result.productEvidence.every(({ canonicalProductId }) =>
      canonicalProductId === "product:42")).toBe(true);
    expect(result.productEvidence[0]).toMatchObject({
      comparisonScope: { completeness: "partial" },
      officialOffers: [],
      ordinaryPrices: [{ id: "price:current" }],
    });
    expect(result.prices.map(({ ean }) => ean)).toEqual([GTIN, GTIN_ALIAS]);
  });

  it("separates one selected current price per chain from its traceable historical baseline", async () => {
    const reader = readerWith(snapshot());
    const signal = new AbortController().signal;
    const result = await new PriceService({ reader }).readExact(REQUEST, NOW, signal);

    expect(reader.getMany).toHaveBeenCalledWith([GTIN], NOW, signal);
    expect(result.prices).toEqual([{
      amountOre: 2_490,
      chain: "extra",
      ean: GTIN,
      observedAt: "2026-07-16T11:00:00.000Z",
      source: "licensed-price",
    }]);
    const need = result.evidence.needs[0]!;
    expect(need.ordinaryPrices.map(({ id }) => id)).toEqual(["price:current"]);
    expect(need.historicalComparisons).toHaveLength(1);
    expect(need.historicalComparisons[0]).toMatchObject({
      currentEvidenceId: "price:current",
      baselineOre: 3_000,
      currentOre: 2_490,
      chainId: "extra",
    });
    expect(need.historicalPriceEvidence.map(({ id }) => id)).toEqual(
      need.historicalComparisons[0]!.sourceEvidenceIds,
    );
    expect(need.historicalPriceEvidence.map(({ id }) => id)).not.toContain("price:current");
    expect(need.comparisonScope).toMatchObject({
      completeness: "partial",
      entries: [
        { chainId: "bunnpris", status: { kind: "known-not-carried" } },
        { chainId: "extra", status: { kind: "priced", evidenceId: "price:current" } },
        { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
      ],
    });
  });

  it("declares every referenced evidence source exactly once and drops unused approvals", async () => {
    const result = await new PriceService({ reader: readerWith(snapshot()) })
      .readExact(REQUEST, NOW);
    const referencedSourceIds = new Set<string>();
    for (const need of result.evidence.needs) {
      need.ordinaryPrices.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.historicalPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.excludedPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.officialOffers.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.comparisonScope.entries.forEach(({ status }) => {
        if (status.kind === "known-not-carried") referencedSourceIds.add(status.sourceId);
      });
    }
    expect(result.evidence.sources.map(({ id }) => id)).toEqual(
      [...referencedSourceIds].sort(),
    );
    expect(result.evidence.sources.map(({ id }) => id)).toEqual([
      "coverage-feed",
      "licensed-price",
    ]);
    expect(
      exactProductPlanApiEvidenceEnvelopeSchema.safeParse(result.evidence).success,
    ).toBe(true);
  });

  it("returns explicit unknown coverage when approved persisted evidence is absent", async () => {
    const result = await new PriceService({
      reader: readerWith({
        coverageChecks: [],
        historicalEligibleEvidenceIds: [],
        priceEvidence: [],
        products: [{ canonicalProductId: "product:42", gtin: GTIN }],
        sources: [],
      }),
    }).readExact(REQUEST, NOW);

    expect(result.prices).toEqual([]);
    expect(result.evidence).toMatchObject({
      assignmentEvidence: [],
      sources: [],
      needs: [{
        needId: "need:milk",
        ordinaryPrices: [],
        historicalPriceEvidence: [],
        excludedPriceEvidence: [],
        officialOffers: [],
        historicalComparisons: [],
        comparisonScope: { completeness: "partial" },
      }],
    });
    expect(
      result.evidence.needs[0]!.comparisonScope.entries.every(
        ({ status }) => status.kind === "unknown",
      ),
    ).toBe(true);
  });

  it("plans distinct requested GTIN aliases that resolve to one canonical product", async () => {
    const aliasedRequest: ExactProductPlanApiRequest = {
      ...REQUEST,
      needs: [
        REQUEST.needs[0]!,
        {
          ...REQUEST.needs[0]!,
          id: "need:milk:alias",
          match: {
            ...REQUEST.needs[0]!.match,
            product: { kind: "gtin", value: GTIN_ALIAS },
          },
        },
      ],
    };
    const aliasedSnapshot = snapshot();
    aliasedSnapshot.products.push({
      canonicalProductId: "product:42",
      gtin: GTIN_ALIAS,
    });

    const result = await new PriceService({ reader: readerWith(aliasedSnapshot) })
      .readExact(aliasedRequest, NOW);

    expect(result.products).toEqual([
      { canonicalProductId: "product:42", gtin: GTIN },
      { canonicalProductId: "product:42", gtin: GTIN_ALIAS },
    ]);
    expect(result.prices.map(({ ean }) => ean)).toEqual([GTIN, GTIN_ALIAS]);
    expect(result.evidence.needs.map(({ needId }) => needId)).toEqual([
      "need:milk",
      "need:milk:alias",
    ]);
  });

  it("keeps stale evidence visible only as bounded excluded provenance", async () => {
    const stale = evidence(
      "price:stale-only",
      "bunnpris",
      "2026-07-12T11:59:59.999Z",
      1_000,
    );
    const result = await new PriceService({
      reader: readerWith({
        coverageChecks: [],
        historicalEligibleEvidenceIds: [],
        priceEvidence: [stale],
        products: [{ canonicalProductId: "product:42", gtin: GTIN }],
        sources: [{
          contractVersion: 1,
          displayName: "Licensed price",
          id: "licensed-price",
          sourceClass: "ordinary-price",
          state: "approved",
        }],
      }),
    }).readExact(REQUEST, NOW);

    expect(result.prices).toEqual([]);
    expect(result.evidence.needs[0]).toMatchObject({
      ordinaryPrices: [],
      historicalPriceEvidence: [],
      excludedPriceEvidence: [{ id: "price:stale-only", sourceId: "licensed-price" }],
      comparisonScope: {
        completeness: "partial",
      },
    });
    expect(
      result.evidence.needs[0]!.comparisonScope.entries.find(
        ({ chainId }) => chainId === "bunnpris",
      ),
    ).toMatchObject({
      chainId: "bunnpris",
      status: { kind: "stale", evidenceId: "price:stale-only" },
    });
    expect(result.evidence.sources.map(({ id }) => id)).toEqual(["licensed-price"]);
  });

  it("does not plan from conflicting prices observed at the same instant", async () => {
    const conflicting = snapshot();
    conflicting.priceEvidence.push(
      evidence("price:current:conflict", "extra", "2026-07-16T11:00:00.000Z", 2_590),
    );

    const result = await new PriceService({ reader: readerWith(conflicting) })
      .readExact(REQUEST, NOW);

    expect(result.prices).toEqual([]);
    expect(result.evidence.needs[0]).toMatchObject({
      ordinaryPrices: [],
      comparisonScope: { completeness: "partial" },
    });
    expect(result.evidence.needs[0]!.comparisonScope.entries.find(
      ({ chainId }) => chainId === "extra",
    )).toMatchObject({
      chainId: "extra",
      status: { kind: "ineligible", reason: "invalid-evidence" },
    });
  });

  it("never uses ordinary-only observations as a historical baseline", async () => {
    const ordinaryOnly = snapshot();
    ordinaryOnly.historicalEligibleEvidenceIds = [];

    const result = await new PriceService({ reader: readerWith(ordinaryOnly) })
      .readExact(REQUEST, NOW);

    expect(result.evidence.needs[0]).toMatchObject({
      historicalComparisons: [],
      historicalPriceEvidence: [],
      ordinaryPrices: [{ id: "price:current" }],
    });
  });

  it("fails closed for inconsistent product/source snapshots and preserves cancellation", async () => {
    const missingProduct = snapshot();
    missingProduct.products = [];
    await expect(new PriceService({ reader: readerWith(missingProduct) }).readExact(REQUEST, NOW))
      .rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const missingSource = snapshot();
    missingSource.sources = missingSource.sources.filter(({ id }) => id !== "licensed-price");
    await expect(new PriceService({ reader: readerWith(missingSource) }).readExact(REQUEST, NOW))
      .rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const unknownHistoricalIdentity = snapshot();
    unknownHistoricalIdentity.historicalEligibleEvidenceIds.push("price:missing");
    await expect(
      new PriceService({ reader: readerWith(unknownHistoricalIdentity) }).readExact(REQUEST, NOW),
    ).rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const duplicateHistoricalIdentity = snapshot();
    duplicateHistoricalIdentity.historicalEligibleEvidenceIds.push(
      duplicateHistoricalIdentity.historicalEligibleEvidenceIds[0]!,
    );
    await expect(
      new PriceService({ reader: readerWith(duplicateHistoricalIdentity) }).readExact(REQUEST, NOW),
    ).rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const controller = new AbortController();
    controller.abort();
    const reader: PlanningEvidenceReader = { getMany: vi.fn() };
    await expect(new PriceService({ reader }).readExact(REQUEST, NOW, controller.signal))
      .rejects.toEqual(new PriceServiceError("CANCELLED"));
    expect(reader.getMany).not.toHaveBeenCalled();
  });
});
