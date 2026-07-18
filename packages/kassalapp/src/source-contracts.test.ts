import { describe, expect, it } from "vitest";

import categoriesFixture from "../test/fixtures/v1/categories.json";
import labelsFixture from "../test/fixtures/v1/labels.json";
import physicalStoresFixture from "../test/fixtures/v1/physical-stores.json";
import pricesFixture from "../test/fixtures/v1/prices-bulk.json";
import productComparisonFixture from "../test/fixtures/v1/product-by-ean.json";
import productResourceFixture from "../test/fixtures/v1/product-by-id.json";
import {
  isValidGtin,
  normalizeCategorySourceResponse,
  normalizeHistoricalPriceSourceResponse,
  normalizeLabelSourceResponse,
  normalizePackageMeasure,
  normalizePhysicalStorePageSourceResponse,
  normalizePhysicalStoreSourceResponse,
  normalizePriceSourceResponse,
  normalizeProductComparisonSourceResponse,
  normalizeProductPageSourceResponse,
  normalizeProductSourceResponse,
} from "./source-contracts";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

describe("Kassalapp v1 source contracts", () => {
  it.each([
    [1, "kg", { amount: 1000, unit: "g" }],
    [0.75, "kg", { amount: 750, unit: "g" }],
    [2, "l", { amount: 2000, unit: "ml" }],
    [33, "cl", { amount: 330, unit: "ml" }],
    [5, "dl", { amount: 500, unit: "ml" }],
    [6, "piece", { amount: 6, unit: "piece" }],
    [1, "stk", { amount: 1, unit: "piece" }],
  ] as const)("normalizes %s %s exactly", (amount, unit, expected) => {
    expect(normalizePackageMeasure(amount, unit)).toEqual({ state: "normalized", measure: expected });
  });

  it("rejects lossy, negative, oversized, and unknown package measures", () => {
    expect(normalizePackageMeasure(0.0001, "kg")).toMatchObject({ state: "quarantined" });
    expect(normalizePackageMeasure(-1, "kg")).toMatchObject({ state: "quarantined" });
    expect(normalizePackageMeasure(Number.MAX_SAFE_INTEGER, "kg")).toMatchObject({ state: "quarantined" });
    expect(normalizePackageMeasure(1, "stone")).toEqual({ state: "unknown", reason: "UNKNOWN_UNIT" });
    expect(normalizePackageMeasure(null, null)).toEqual({ state: "unknown", reason: "MISSING_MEASURE" });
  });

  it("validates GTIN checksum independently from the legacy search compatibility view", () => {
    expect(isValidGtin("7038010000010")).toBe(true);
    expect(isValidGtin("7038010000013")).toBe(false);
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("96385075")).toBe(false);
    expect(isValidGtin("not-an-ean")).toBe(false);
  });

  it("returns every versioned retailer product from an official comparison resource", () => {
    expect(normalizeProductComparisonSourceResponse(productComparisonFixture, {
      expectedEan: "7038010000010",
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })).toEqual([
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({
          categoryPath: [{ depth: 1, name: "Meieri", sourceCategoryId: "10" }],
          chainCodes: ["BUNNPRIS"],
          ean: "7038010000010",
          packageMeasure: { amount: 1000, unit: "ml" },
          sourceRecordId: "117",
          sourceUpdatedAt: "2026-07-15T08:30:00.000Z",
        }),
      }),
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({ chainCodes: ["REMA_1000"], sourceRecordId: "118" }),
      }),
    ]);
  });

  it("quarantines invalid, mismatched, or future-dated product records", () => {
    const invalid = structuredClone(productComparisonFixture);
    invalid.data.ean = "7038010000013";
    expect(normalizeProductComparisonSourceResponse(invalid, { now: NOW, retrievedAt: RETRIEVED_AT })[0])
      .toMatchObject({ state: "quarantined", reason: "INVALID_GTIN" });
    expect(normalizeProductComparisonSourceResponse(productComparisonFixture, {
      expectedEan: "7040000000009",
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })[0]).toMatchObject({
      ean: "7038010000010",
      state: "quarantined",
      reason: "IDENTIFIER_MISMATCH",
    });

    const future = structuredClone(productComparisonFixture);
    future.data.products[0]!.updated_at = "2026-07-17T08:30:00Z";
    expect(normalizeProductComparisonSourceResponse(future, { now: NOW, retrievedAt: RETRIEVED_AT })[0])
      .toMatchObject({ ean: "7038010000010", state: "quarantined", reason: "FUTURE_TIMESTAMP" });
  });

  it("fails closed when a malformed comparison item conflicts with an accepted source identity", () => {
    const conflict = structuredClone(productComparisonFixture);
    conflict.data.products.push({
      ...structuredClone(conflict.data.products[0]!),
      name: null as unknown as string,
    });

    const outcomes = normalizeProductComparisonSourceResponse(conflict, { now: NOW, retrievedAt: RETRIEVED_AT });
    expect(outcomes.filter((outcome) => outcome.state === "accepted" && outcome.record.sourceRecordId === "117"))
      .toHaveLength(0);
    expect(outcomes).toContainEqual(expect.objectContaining({
      ean: "7038010000010",
      state: "quarantined",
      sourceRecordId: "117",
      reason: "DUPLICATE_IDENTITY",
    }));
  });

  it("preserves missing and unknown package states without inventing a unit", () => {
    const missing = {
      data: { ...productResourceFixture.data, weight: 1, weight_unit: "stone" },
    };
    expect(normalizeProductSourceResponse(missing, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toMatchObject({ state: "accepted", record: { packageMeasureState: "unknown-unit" } });
  });

  it("preserves unknown versus explicitly empty product category paths", () => {
    const unknown = structuredClone(productResourceFixture);
    unknown.data.category = null as unknown as typeof unknown.data.category;
    const empty = structuredClone(productResourceFixture);
    empty.data.category = [];

    const unknownOutcome = normalizeProductSourceResponse(unknown, {
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    });
    const emptyOutcome = normalizeProductSourceResponse(empty, {
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    });

    expect(unknownOutcome).toMatchObject({ state: "accepted" });
    expect(unknownOutcome.state === "accepted" && unknownOutcome.record).not.toHaveProperty(
      "categoryPath",
    );
    expect(emptyOutcome).toMatchObject({
      state: "accepted",
      record: { categoryPath: [] },
    });
  });

  it("deduplicates and sorts embedded category paths but quarantines conflicting identities", () => {
    const canonical = structuredClone(productResourceFixture);
    canonical.data.category = [
      { depth: 2, id: 20, name: "Melk" },
      { depth: 1, id: 10, name: "Meieri" },
      { depth: 1, id: 10, name: "Meieri" },
    ];
    expect(normalizeProductSourceResponse(canonical, {
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })).toMatchObject({
      state: "accepted",
      record: {
        categoryPath: [
          { depth: 1, name: "Meieri", sourceCategoryId: "10" },
          { depth: 2, name: "Melk", sourceCategoryId: "20" },
        ],
      },
    });

    const conflict = structuredClone(canonical);
    conflict.data.category![2]!.name = "Konflikt";
    expect(normalizeProductSourceResponse(conflict, {
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })).toMatchObject({
      reason: "DUPLICATE_IDENTITY",
      sourceRecordId: "117",
      state: "quarantined",
    });
  });

  it("normalizes a bounded product discovery page without public Product DTO loss", () => {
    const malformed = { ...structuredClone(productResourceFixture.data), ean: "invalid", id: 118 };
    expect(normalizeProductPageSourceResponse({
      data: [productResourceFixture.data, malformed],
    }, {
      limit: 2,
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })).toEqual([
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({
          chainCodes: ["BUNNPRIS"],
          ean: "7038010000010",
          packageMeasure: { amount: 1000, unit: "ml" },
          sourceRecordId: "117",
        }),
      }),
      expect.objectContaining({
        reason: "INVALID_GTIN",
        sourceRecordId: "118",
        state: "quarantined",
      }),
    ]);
    expect(() => normalizeProductPageSourceResponse({
      data: [productResourceFixture.data, productResourceFixture.data],
    }, {
      limit: 1,
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })).toThrow();
  });

  it("keeps accepted, unknown-price, and unknown-chain price states explicit", () => {
    expect(normalizePriceSourceResponse(pricesFixture, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: "accepted",
          record: expect.objectContaining({
            amountOre: 2190,
            chainId: "extra",
            ean: "7038010000010",
            observationKind: "current",
          }),
        }),
        expect.objectContaining({
          chainCode: "BUNNPRIS",
          chainId: "bunnpris",
          ean: "7038010000010",
          reason: "MISSING_SUPPORTED_CHAIN",
          state: "unknown",
        }),
        expect.objectContaining({
          chainCode: "FUTURE_CHAIN",
          ean: "7038010000010",
          reason: "UNKNOWN_CHAIN",
          state: "quarantined",
        }),
        expect.objectContaining({
          chainCode: "REMA_1000",
          chainId: "rema-1000",
          ean: "7038010000010",
          reason: "MISSING_PRICE",
          state: "unknown",
        }),
      ]));
  });

  it("keeps current and historical observation identities collision-proof", () => {
    const history = structuredClone(pricesFixture);
    history.data[0]!.price_history.push({
      date: "2026-07-15",
      price: 20.9,
      store: "COOP_EXTRA",
    });

    const current = normalizePriceSourceResponse(history, {
      expectedEans: ["7038010000010"],
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    }).filter((outcome) => outcome.state === "accepted");
    const historical = normalizeHistoricalPriceSourceResponse(history, {
      expectedEans: ["7038010000010"],
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    }).filter((outcome) => outcome.state === "accepted");

    expect(current[0]?.record).toMatchObject({ observationKind: "current" });
    expect(historical.map(({ record }) => record)).toEqual([
      expect.objectContaining({
        amountOre: 2090,
        chainId: "extra",
        ean: "7038010000010",
        observationKind: "historical",
        observedAt: "2026-07-15T00:00:00.000Z",
      }),
      expect.objectContaining({
        amountOre: 2190,
        chainId: "extra",
        ean: "7038010000010",
        observationKind: "historical",
        observedAt: "2026-07-15T00:00:00.000Z",
      }),
    ]);
    const identities = [...current, ...historical].map(({ record }) => record.sourceRecordId);
    expect(new Set(identities).size).toBe(identities.length);
    for (const outcome of historical) {
      expect(outcome.record.sourceRecordId).toContain(outcome.record.ean);
      expect(outcome.record.sourceRecordId).toContain(outcome.record.chainCode);
      expect(outcome.record.sourceRecordId).toContain(outcome.record.observationKind);
      expect(outcome.record.sourceRecordId).toContain(outcome.record.observedAt);
      expect(outcome.record.sourceRecordId).toContain(String(outcome.record.amountOre));
    }
  });

  it("quarantines malformed and future price records instead of coercing them", () => {
    const malformed = structuredClone(pricesFixture);
    malformed.data[0]!.stores[0]!.current_price = "21.90" as unknown as number;
    expect(normalizePriceSourceResponse(malformed, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toContainEqual(expect.objectContaining({ state: "quarantined", reason: "MALFORMED_RECORD" }));

    const future = structuredClone(pricesFixture);
    future.data[0]!.stores[0]!.last_checked = "2026-07-17T08:30:00Z";
    expect(normalizePriceSourceResponse(future, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toContainEqual(expect.objectContaining({ state: "quarantined", reason: "FUTURE_TIMESTAMP" }));
  });

  it("reports missing requested EANs and missing supported chains as explicit unknown coverage", () => {
    const outcomes = normalizePriceSourceResponse(pricesFixture, {
      expectedEans: ["7038010000010", "96385074"],
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    });

    expect(outcomes).toContainEqual(expect.objectContaining({
      state: "unknown",
      sourceRecordId: "96385074",
      reason: "MISSING_REQUESTED_EAN",
    }));
    expect(outcomes).toContainEqual(expect.objectContaining({
      state: "unknown",
      chainCode: "BUNNPRIS",
      reason: "MISSING_SUPPORTED_CHAIN",
    }));
  });

  it("groups duplicate product rows by EAN before deriving supported-chain coverage", () => {
    const duplicateProducts = structuredClone(pricesFixture);
    const product = duplicateProducts.data[0]!;
    duplicateProducts.data = [
      { ...structuredClone(product), stores: [structuredClone(product.stores[0]!)] },
      {
        ...structuredClone(product),
        stores: [{
          ...structuredClone(product.stores[0]!),
          store: "BUNNPRIS",
          name: "Bunnpris",
        }],
      },
    ];
    duplicateProducts.meta.found_products = 2;

    const outcomes = normalizePriceSourceResponse(duplicateProducts, {
      expectedEans: ["7038010000010"],
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    });
    const acceptedChains = outcomes.flatMap((outcome) =>
      outcome.state === "accepted" ? [outcome.record.chainCode] : []);
    const missingChains = outcomes.flatMap((outcome) =>
      outcome.state === "unknown" && outcome.reason === "MISSING_SUPPORTED_CHAIN"
        ? [outcome.chainCode]
        : []);
    expect(acceptedChains).toEqual(["BUNNPRIS", "COOP_EXTRA"]);
    expect(missingChains).toEqual(["REMA_1000"]);
  });

  it("does not invent an observation time and never lets a future timestamp bypass validation", () => {
    const missingTimestamp = structuredClone(pricesFixture);
    missingTimestamp.data[0]!.stores[0]!.last_checked = null as unknown as string;
    expect(normalizePriceSourceResponse(missingTimestamp, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toContainEqual(expect.objectContaining({ state: "unknown", reason: "MISSING_TIMESTAMP" }));

    const futureMissingPrice = structuredClone(pricesFixture);
    futureMissingPrice.data[0]!.stores[2]!.last_checked = "2026-07-17T08:30:00Z";
    expect(normalizePriceSourceResponse(futureMissingPrice, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toContainEqual(expect.objectContaining({
        state: "quarantined",
        chainCode: "REMA_1000",
        reason: "FUTURE_TIMESTAMP",
      }));
  });

  it("classifies an unknown chain before considering its nullable timestamp", () => {
    const unknownChain = structuredClone(pricesFixture);
    unknownChain.data[0]!.stores[1]!.last_checked = null as unknown as string;

    expect(normalizePriceSourceResponse(unknownChain, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toContainEqual(expect.objectContaining({
        state: "quarantined",
        chainCode: "FUTURE_CHAIN",
        reason: "UNKNOWN_CHAIN",
      }));
  });

  it("quarantines a source price above the signed 32-bit øre boundary", () => {
    const oversized = structuredClone(pricesFixture);
    oversized.data[0]!.stores[0]!.current_price = 21_474_836.48;

    const outcomes = normalizePriceSourceResponse(oversized, { now: NOW, retrievedAt: RETRIEVED_AT });
    expect(outcomes).toContainEqual(expect.objectContaining({
      state: "quarantined",
      reason: "MALFORMED_RECORD",
    }));
    expect(outcomes.some((outcome) =>
      outcome.state === "accepted" && outcome.record.amountOre > 2_147_483_647)).toBe(false);
  });

  it("deduplicates identical price identities and quarantines conflicting duplicates", () => {
    const duplicate = structuredClone(pricesFixture);
    duplicate.data[0]!.stores.unshift(structuredClone(duplicate.data[0]!.stores[0]!));
    const outcomes = normalizePriceSourceResponse(duplicate, { now: NOW, retrievedAt: RETRIEVED_AT });
    expect(outcomes.filter((outcome) => outcome.state === "accepted" && outcome.record.chainCode === "COOP_EXTRA"))
      .toHaveLength(1);
    expect(normalizePriceSourceResponse(duplicate, { now: NOW, retrievedAt: RETRIEVED_AT })).toEqual(outcomes);

    const conflict = structuredClone(pricesFixture);
    conflict.data[0]!.stores.unshift({
      ...structuredClone(conflict.data[0]!.stores[0]!),
      current_price: 22.1,
      current_unit_price: 22.1,
      current_unit_price_unit: "l",
    });
    const conflictingOutcomes = normalizePriceSourceResponse(conflict, { now: NOW, retrievedAt: RETRIEVED_AT });
    expect(conflictingOutcomes).toContainEqual(expect.objectContaining({
      state: "quarantined",
      reason: "DUPLICATE_IDENTITY",
    }));
    expect(conflictingOutcomes.filter((outcome) =>
      outcome.state === "accepted" && outcome.record.chainCode === "COOP_EXTRA")).toHaveLength(0);
  });

  it("canonicalizes equivalent timestamp offsets before price identity deduplication", () => {
    const equivalent = structuredClone(pricesFixture);
    equivalent.data[0]!.stores.unshift({
      ...structuredClone(equivalent.data[0]!.stores[0]!),
      last_checked: "2026-07-15T10:30:00+02:00",
    });

    const acceptedExtra = normalizePriceSourceResponse(equivalent, { now: NOW, retrievedAt: RETRIEVED_AT })
      .filter((outcome) => outcome.state === "accepted" && outcome.record.chainCode === "COOP_EXTRA");
    expect(acceptedExtra).toHaveLength(1);
  });

  it("normalizes category and label fixture contracts", () => {
    expect(normalizeCategorySourceResponse(categoriesFixture, RETRIEVED_AT)).toEqual([
      expect.objectContaining({ state: "accepted", record: expect.objectContaining({ sourceRecordId: "10", name: "Meieri" }) }),
      expect.objectContaining({ state: "accepted", record: expect.objectContaining({ sourceRecordId: "20", name: "Frukt og grønt" }) }),
    ]);
    expect(normalizeLabelSourceResponse(labelsFixture, RETRIEVED_AT)).toEqual([
      expect.objectContaining({ state: "accepted", record: expect.objectContaining({ sourceRecordId: "label:keyhole", name: "Nøkkelhullet" }) }),
      expect.objectContaining({ state: "accepted", record: expect.objectContaining({ sourceRecordId: "label:organic", name: "Økologisk" }) }),
    ]);
  });

  it("normalizes known physical stores and quarantines unknown chains", () => {
    expect(normalizePhysicalStoreSourceResponse(physicalStoresFixture, { now: NOW, retrievedAt: RETRIEVED_AT }))
      .toEqual([
        expect.objectContaining({
          state: "accepted",
          record: expect.objectContaining({
            chainId: "bunnpris",
            latitude: 59.9271,
            longitude: 10.7342,
            postalCode: "0452",
            sourceRecordId: "501",
          }),
        }),
        expect.objectContaining({ state: "quarantined", reason: "UNKNOWN_CHAIN", chainCode: "FUTURE_CHAIN" }),
      ]);
  });

  it("keeps required-chain coverage unknown when a filtered store page returns only another chain", () => {
    const wrongChain = {
      data: [{ ...physicalStoresFixture.data[0]!, group: "COOP_EXTRA" }],
    };

    expect(normalizePhysicalStorePageSourceResponse(wrongChain, {
      expectedChainCode: "BUNNPRIS",
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    })).toMatchObject({
      coverage: [{
        chainCode: "BUNNPRIS",
        chainId: "bunnpris",
        recordCount: 1,
        reason: "MISSING_SUPPORTED_CHAIN",
        state: "unknown",
      }],
      outcomes: [{ state: "quarantined", reason: "IDENTIFIER_MISMATCH", sourceRecordId: "501" }],
    });
    expect(normalizePhysicalStorePageSourceResponse(wrongChain, {
      expectedChainCode: "BUNNPRIS",
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    }).outcomes[0]).toMatchObject({
      chainCode: "COOP_EXTRA",
      chainId: "extra",
      state: "quarantined",
    });
  });

  it("does not call a partially malformed required-chain store page complete", () => {
    const partial = {
      data: [
        physicalStoresFixture.data[0]!,
        {
          ...physicalStoresFixture.data[0]!,
          id: 503,
          position: { lat: 59.9, lng: null },
        },
      ],
    };

    expect(normalizePhysicalStorePageSourceResponse(partial, {
      expectedChainCode: "BUNNPRIS",
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    }).coverage).toEqual([{
      chainCode: "BUNNPRIS",
      chainId: "bunnpris",
      recordCount: 2,
      reason: "INVALID_RECORDS",
      state: "unknown",
    }]);
    expect(normalizePhysicalStorePageSourceResponse(partial, {
      expectedChainCode: "BUNNPRIS",
      now: NOW,
      retrievedAt: RETRIEVED_AT,
    }).outcomes).toContainEqual(expect.objectContaining({
      chainCode: "BUNNPRIS",
      chainId: "bunnpris",
      reason: "MALFORMED_RECORD",
      state: "quarantined",
    }));
  });

  it("deduplicates and sorts category, label, and store identities deterministically", () => {
    const reversedCategories = { data: [...categoriesFixture.data, categoriesFixture.data[0]!].reverse() };
    const reversedLabels = { data: [...labelsFixture.data, labelsFixture.data[0]!].reverse() };
    const reversedStores = { data: [...physicalStoresFixture.data, physicalStoresFixture.data[0]!].reverse() };

    expect(normalizeCategorySourceResponse(reversedCategories, RETRIEVED_AT).map((outcome) =>
      outcome.state === "accepted" ? outcome.record.sourceRecordId : outcome.sourceRecordId))
      .toEqual(["10", "20"]);
    expect(normalizeLabelSourceResponse(reversedLabels, RETRIEVED_AT).map((outcome) =>
      outcome.state === "accepted" ? outcome.record.sourceRecordId : outcome.sourceRecordId))
      .toEqual(["label:keyhole", "label:organic"]);
    expect(normalizePhysicalStoreSourceResponse(reversedStores, { now: NOW, retrievedAt: RETRIEVED_AT }).map((outcome) =>
      outcome.state === "accepted" ? outcome.record.sourceRecordId : outcome.sourceRecordId))
      .toEqual(["501", "502"]);
  });

  it("bounds list envelopes before inspecting records", () => {
    expect(() => normalizeCategorySourceResponse({
      data: Array.from({ length: 1001 }, (_, id) => ({ id, name: "category" })),
    }, RETRIEVED_AT)).toThrow();
  });
});
