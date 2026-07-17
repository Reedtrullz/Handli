import { describe, expect, it } from "vitest";

import {
  publicDiscoveryRequestV1Schema,
  publicDiscoveryResponseSchema,
  publicProductSearchResponseSchema,
} from "./discovery-contracts";

const source = {
  contractVersion: 1 as const,
  displayName: "Kassalapp",
  id: "kassalapp",
  sourceClass: "catalog" as const,
  state: "approved" as const,
};

const catalog = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-16T11:00:00.000Z",
    source,
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "TINE Lettmelk",
  gtin: "7038010000010",
  packageMeasure: { amount: 1_000, unit: "ml" as const },
  unitsPerPack: 1,
};

const response = {
  contractVersion: 1,
  generatedAt: "2026-07-16T12:00:00.000Z",
  marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
  observedCategories: {
    completeness: "partial",
    facets: [{
      depth: 1,
      id: `category:${"c".repeat(64)}`,
      name: "Meieri",
      productCount: 1,
      sourceId: source.id,
    }],
    hasMore: false,
    kind: "observed-category-directory",
  },
  page: {
    hasMore: false,
    kind: "bounded-catalog-slice",
    pageSize: 8,
    scannedCatalogProducts: 1,
  },
  priceDataSource: "cache",
  products: [{
    canonicalProductId: "product:milk",
    catalog,
    categoryPath: [{
      depth: 1,
      id: `category:${"c".repeat(64)}`,
      name: "Meieri",
      sourceId: source.id,
    }],
    comparisonScope: {
      completeness: "partial",
      contractVersion: 1,
      entries: ["bunnpris", "extra", "rema-1000"].map((chainId) => ({
        chainId,
        status: { kind: "unknown", reason: "not-checked" },
      })),
      evaluatedAt: "2026-07-16T12:00:00.000Z",
      expectedChainIds: ["bunnpris", "extra", "rema-1000"],
    },
    excludedPriceEvidence: [],
    historicalComparisons: [],
    historicalPriceEvidence: [],
    officialOffers: [],
    ordinaryPrices: [],
  }],
  selection: { chain: "all", resultType: "all" },
  sources: [source],
} as const;

describe("public discovery contracts", () => {
  it("requires bounded server filters and an opaque continuation cursor", () => {
    const request = {
      chain: "extra",
      contractVersion: 1,
      marketContext: response.marketContext,
      pageSize: 8,
      resultType: "official-offer",
    } as const;
    expect(publicDiscoveryRequestV1Schema.safeParse(request).success).toBe(true);
    expect(publicDiscoveryRequestV1Schema.safeParse({ ...request, pageSize: 9 }).success)
      .toBe(false);
    expect(publicDiscoveryRequestV1Schema.safeParse({
      ...request,
      cursor: "raw-product-id",
    }).success).toBe(false);
    expect(publicDiscoveryRequestV1Schema.safeParse({
      ...request,
      categoryId: `category:${"a".repeat(64)}`,
      query: "melk",
    }).success).toBe(false);
  });

  it("accepts only persisted, source-complete discovery responses", () => {
    expect(publicDiscoveryResponseSchema.safeParse(response).success).toBe(true);
    expect(publicDiscoveryResponseSchema.safeParse({ ...response, priceDataSource: "upstream" }).success).toBe(false);
    expect(publicDiscoveryResponseSchema.safeParse({ ...response, sources: [] }).success).toBe(false);
    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [{
        ...response.products[0],
        catalog: {
          ...catalog,
          catalogEvidence: {
            ...catalog.catalogEvidence,
            observedAt: "2026-07-14T11:59:59.999Z",
          },
        },
      }],
    }).success).toBe(false);
    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [{
        ...response.products[0],
        comparisonScope: {
          ...response.products[0].comparisonScope,
          evaluatedAt: "2026-07-16T11:59:59.999Z",
        },
      }],
    }).success).toBe(false);
  });

  it("re-derives history from the same source and exact market scope", () => {
    const current = {
      amountOre: 2_490,
      chainId: "extra",
      contractVersion: 1,
      evidenceLevel: "observed",
      geographicScope: { countryCode: "NO", kind: "national" },
      id: "price:milk:current",
      kind: "price-evidence",
      observedAt: "2026-07-16T11:00:00.000Z",
      priceKind: "ordinary",
      productMatch: { canonicalProductId: "product:milk", kind: "exact" },
      sourceId: source.id,
      sourceRecordId: "source-record:price:milk:current",
    } as const;
    const history = Array.from({ length: 7 }, (_, index) => ({
      ...current,
      amountOre: 3_000,
      id: `price:milk:history:${index}`,
      observedAt: new Date(Date.UTC(2026, 6, 9 + index, 11)).toISOString(),
      sourceRecordId: `source-record:price:milk:history:${index}`,
    }));
    const comparison = {
      baselineMethod: "median-30d",
      baselineOre: 3_000,
      canonicalProductId: "product:milk",
      chainId: "extra",
      contractVersion: 1,
      currentEvidenceId: current.id,
      currentOre: 2_490,
      derivedAt: response.generatedAt,
      distinctObservationDays: 7,
      id: "history:milk",
      kind: "historical-comparison",
      savingsBasisPoints: 1_700,
      savingsOre: 510,
      sourceEvidenceIds: history.map(({ id }) => id),
      windowEndsAt: current.observedAt,
      windowStartsAt: "2026-06-16T11:00:00.000Z",
    } as const;
    const product = {
      ...response.products[0],
      comparisonScope: {
        ...response.products[0].comparisonScope,
        entries: response.products[0].comparisonScope.entries.map((entry) =>
          entry.chainId === "extra"
            ? { chainId: "extra", status: { evidenceId: current.id, kind: "priced" } }
            : entry
        ),
      },
      historicalComparisons: [comparison],
      historicalPriceEvidence: history,
      ordinaryPrices: [current],
    };
    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [product],
    }).success).toBe(true);

    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [{
        ...product,
        historicalPriceEvidence: history.map((evidence) => ({
          ...evidence,
          geographicScope: {
            countryCode: "NO",
            kind: "regions",
            regionCodes: ["NO-03"],
          },
        })),
      }],
    }).success).toBe(false);

    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [{
        ...product,
        historicalPriceEvidence: history.map((evidence) => ({
          ...evidence,
          sourceId: "other-history-source",
        })),
      }],
      sources: [source, {
        contractVersion: 1,
        displayName: "Other history source",
        id: "other-history-source",
        sourceClass: "ordinary-price",
        state: "approved",
      }],
    }).success).toBe(false);
  });

  it("rejects duplicate discovery cards for verified aliases of one canonical product", () => {
    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [
        response.products[0],
        {
          ...response.products[0],
          catalog: {
            ...catalog,
            catalogEvidence: {
              ...catalog.catalogEvidence,
              sourceRecordId: `source-record:${"b".repeat(64)}`,
            },
            gtin: "96385074",
          },
        },
      ],
    }).success).toBe(false);
  });

  it("rejects otherwise-valid claims for unsupported chains", () => {
    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      products: [{
        ...response.products[0],
        officialOffers: [{
          applicability: {
            channels: ["in-store"],
            contractVersion: 1,
            endsAt: "2026-07-20T00:00:00.000Z",
            geographicScope: { countryCode: "NO", kind: "national" },
            startsAt: "2026-07-15T00:00:00.000Z",
          },
          capturedAt: "2026-07-16T11:00:00.000Z",
          chainId: "unsupported-chain",
          conditions: [{ kind: "public" }],
          contractVersion: 1,
          evidenceLevel: "authoritative",
          id: "offer:unsupported",
          kind: "official-offer",
          pricing: { kind: "unit", unitPriceOre: 1_990 },
          productMatch: { canonicalProductId: "product:milk", kind: "exact" },
          sourceId: source.id,
          sourceRecordId: "offer-record:unsupported",
        }],
      }],
    }).success).toBe(false);
  });

  it("preserves unknown and explicitly empty category paths without exposing raw source IDs", () => {
    const unknown = {
      ...response,
      products: [{ ...response.products[0], categoryPath: null }],
    };
    const empty = {
      ...response,
      products: [{ ...response.products[0], categoryPath: [] }],
    };
    expect(publicDiscoveryResponseSchema.safeParse(unknown).success).toBe(true);
    expect(publicDiscoveryResponseSchema.safeParse(empty).success).toBe(true);
    expect(JSON.stringify(response)).not.toContain("sourceCategoryId");
    expect(publicDiscoveryResponseSchema.safeParse({
      ...response,
      observedCategories: {
        ...response.observedCategories,
        completeness: "complete",
      },
    }).success).toBe(false);
  });

  it("keeps product-search metadata strict and browser-safe", () => {
    expect(publicProductSearchResponseSchema.safeParse({
      contractVersion: 1,
      products: [{
        contractVersion: 1,
        brand: catalog.brand,
        displayName: catalog.displayName,
        gtin: catalog.gtin,
        packageMeasure: catalog.packageMeasure,
        unitsPerPack: catalog.unitsPerPack,
      }],
    }).success).toBe(true);
    expect(publicProductSearchResponseSchema.safeParse({
      contractVersion: 1,
      products: [{ ...catalog, privateRawRecord: "no" }],
    }).success).toBe(false);
    expect(publicProductSearchResponseSchema.safeParse({
      contractVersion: 1,
      products: [{
        contractVersion: 1,
        brand: catalog.brand,
        displayName: catalog.displayName,
        gtin: catalog.gtin,
        packageMeasure: catalog.packageMeasure,
        unitsPerPack: catalog.unitsPerPack,
      }, {
        contractVersion: 1,
        brand: catalog.brand,
        displayName: catalog.displayName,
        gtin: catalog.gtin,
        packageMeasure: catalog.packageMeasure,
        unitsPerPack: catalog.unitsPerPack,
      }],
    }).success).toBe(false);
  });
});
