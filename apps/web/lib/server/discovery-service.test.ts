import type { PublicCatalogDiscoveryIndexReader } from "@handleplan/db/public-catalog-index-reader";
import {
  PublicCatalogIndexReaderError,
} from "@handleplan/db/public-catalog-index-reader";
import type {
  ExactProductPlanApiProductSummary,
  MoneyOre,
  PriceEvidence,
  PriceObservation,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import {
  DiscoveryRequestCancelledError,
  DiscoveryService,
  DiscoveryUnavailableError,
} from "./discovery-service";
import {
  PriceServiceError,
  type ExactPriceServiceResult,
  type PriceService,
} from "./price-service";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const GTINS = ["7038010000010", "7038010000027"] as const;
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;
const money = (value: number) => value as MoneyOre;
const source = {
  contractVersion: 1 as const,
  displayName: "Kassalapp",
  id: "kassalapp",
  sourceClass: "ordinary-price" as const,
  state: "approved" as const,
};

function summary(gtin: string, index: number): ExactProductPlanApiProductSummary {
  return {
    brand: "Fixture",
    catalogEvidence: {
      observedAt: "2026-07-16T11:00:00.000Z",
      source,
      sourceRecordId: `source-record:${String(index + 1).repeat(64)}`,
    },
    displayName: `Fixture product ${index + 1}`,
    gtin,
    packageMeasure: { amount: 1_000, unit: "ml" },
    unitsPerPack: 1,
  };
}

const products = GTINS.map(summary);

function priceResultFor(catalog: readonly ExactProductPlanApiProductSummary[]): ExactPriceServiceResult {
  const observations: PriceObservation<string>[] = [];
  const needs = catalog.map((product, index) => {
    const canonicalProductId = `product:${index + 1}`;
    const price = {
      amountOre: money(2_000 + index * 100),
      chainId: "extra",
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      geographicScope: { countryCode: "NO", kind: "national" as const },
      id: `price:${index + 1}`,
      kind: "price-evidence" as const,
      observedAt: "2026-07-16T11:00:00.000Z",
      priceKind: "ordinary" as const,
      productMatch: { canonicalProductId, kind: "exact" as const },
      sourceId: "kassalapp",
      sourceRecordId: `source-record:price:${index + 1}`,
    };
    observations.push({
      amountOre: price.amountOre,
      chain: "extra",
      ean: product.gtin,
      observedAt: price.observedAt,
      source: "kassalapp",
    });
    return {
      comparisonScope: {
        completeness: "partial" as const,
        contractVersion: 1 as const,
        entries: [
          { chainId: "bunnpris", status: { kind: "unknown" as const, reason: "not-checked" as const } },
          { chainId: "extra", status: { evidenceId: price.id, kind: "priced" as const } },
          { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
        ],
        evaluatedAt: NOW.toISOString(),
        expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      },
      excludedPriceEvidence: [],
      historicalComparisons: [],
      historicalPriceEvidence: [],
      needId: `discovery:${product.gtin}`,
      officialOffers: [],
      ordinaryPrices: [price],
    };
  });
  return {
    evidence: { assignmentEvidence: [], needs, sources: [source] },
    prices: observations,
    products: catalog.map((product, index) => ({
      canonicalProductId: `product:${index + 1}`,
      gtin: product.gtin,
    })),
  };
}

const category = {
  depth: 1,
  id: `category:${"c".repeat(64)}`,
  name: "Meieri",
  sourceId: source.id,
} as const;

function catalogReader(rows = products): PublicCatalogDiscoveryIndexReader & {
  categoryFacets: ReturnType<typeof vi.fn>;
  readDiscoveryPage: ReturnType<typeof vi.fn>;
} {
  return {
    categoryFacets: vi.fn(async () => ({
      facets: rows.length === 0 ? [] : [{ ...category, productCount: rows.length }],
      hasMore: false,
    })),
    readDiscoveryPage: vi.fn(async () => ({
      entries: rows.map((product) => ({
        catalogPosition: {
          gtin: product.gtin,
          rank: 0,
          sortName: product.displayName.toLocaleLowerCase("nb-NO"),
        },
        categoryPath: [{ ...category, sourceId: product.catalogEvidence.source.id }],
        product,
      })),
      hasMore: false,
      scannedCount: rows.length,
    })),
  };
}

describe("DiscoveryService persisted composition", () => {
  it("builds one bounded exact persisted snapshot for browse results", async () => {
    const catalog = catalogReader();
    const readExact = vi.fn<PriceService["readExact"]>().mockResolvedValue(priceResultFor(products));
    const signal = new AbortController().signal;
    const result = await new DiscoveryService({
      catalog,
      now: () => NOW,
      priceService: { readExact },
    }).browse(MARKET_CONTEXT, signal);

    expect(catalog.readDiscoveryPage).toHaveBeenCalledWith({ limit: 50 }, NOW, signal);
    expect(catalog.categoryFacets).toHaveBeenCalledWith(100, NOW, signal);
    expect(readExact).toHaveBeenCalledOnce();
    expect(readExact.mock.calls[0]![0]).toEqual({
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      marketContext: MARKET_CONTEXT,
      maxStores: 3,
      needs: products.map(({ gtin }) => ({
        id: `discovery:${gtin}`,
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: gtin },
          userApproved: true,
        },
        quantity: 1,
        quantityUnit: "each",
        required: true,
      })),
    });
    expect(result).toMatchObject({
      contractVersion: 1,
      generatedAt: NOW.toISOString(),
      marketContext: MARKET_CONTEXT,
      observedCategories: {
        completeness: "partial",
        facets: [{ id: category.id, productCount: products.length }],
        hasMore: false,
        kind: "observed-category-directory",
      },
      priceDataSource: "cache",
      products: [
        { catalog: { gtin: GTINS[0] }, ordinaryPrices: [{ chainId: "extra" }] },
        { catalog: { gtin: GTINS[1] }, ordinaryPrices: [{ chainId: "extra" }] },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/query|gateway|apiKey|raw_record_hash/i);
  });

  it("uses bounded persisted search without gateway or write dependencies", async () => {
    const catalog = catalogReader([products[0]!]);
    const readExact = vi.fn(async () => priceResultFor([products[0]!]));
    const result = await new DiscoveryService({
      catalog,
      now: () => NOW,
      priceService: { readExact },
    }).search("melk", MARKET_CONTEXT);

    expect(catalog.readDiscoveryPage).toHaveBeenCalledWith(
      { limit: 50, query: "melk" },
      NOW,
      undefined,
    );
    expect(result.products).toHaveLength(1);
  });

  it("fails closed before reading prices when a reader exceeds one bounded evidence batch", async () => {
    const catalog = catalogReader();
    catalog.readDiscoveryPage.mockResolvedValue({
      entries: Array.from({ length: 51 }, (_, index) => ({
        catalogPosition: {
          gtin: products[0]!.gtin,
          rank: 0,
          sortName: `fixture-${index}`,
        },
        categoryPath: [category],
        product: products[0]!,
      })),
      hasMore: false,
      scannedCount: 51,
    });
    const readExact = vi.fn<PriceService["readExact"]>();

    await expect(new DiscoveryService({
      catalog,
      now: () => NOW,
      priceService: { readExact },
    }).search("melk", MARKET_CONTEXT)).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(readExact).not.toHaveBeenCalled();
  });

  it("filters one opaque observed category at the persisted read boundary", async () => {
    const catalog = catalogReader([products[0]!]);
    const result = await new DiscoveryService({
      catalog,
      now: () => NOW,
      priceService: { readExact: async () => priceResultFor([products[0]!]) },
    }).browseCategory(category.id, MARKET_CONTEXT);

    expect(catalog.readDiscoveryPage).toHaveBeenCalledWith(
      { categoryId: category.id, limit: 50 },
      NOW,
      undefined,
    );
    expect(catalog.categoryFacets).toHaveBeenCalledWith(100, NOW, undefined);
    expect(result.products[0]?.categoryPath).toEqual([category]);
    expect(JSON.stringify(result)).not.toContain("sourceCategoryId");
    expect(result.observedCategories).toMatchObject({
      completeness: "partial",
      kind: "observed-category-directory",
    });
  });

  it("deduplicates canonical aliases while preserving an exact-GTIN search", async () => {
    const alias: ExactProductPlanApiProductSummary = {
      ...products[0]!,
      catalogEvidence: {
        ...products[0]!.catalogEvidence,
        source: {
          contractVersion: 1,
          displayName: "Alias catalog",
          id: "alias-catalog",
          sourceClass: "catalog",
          state: "approved",
        },
        sourceRecordId: `source-record:${"b".repeat(64)}`,
      },
      gtin: "96385074",
    };
    const aliases = [products[0]!, alias];
    const aliasPriceResult = priceResultFor(aliases);
    aliasPriceResult.products = aliasPriceResult.products.map(({ gtin }) => ({
      canonicalProductId: "product:shared",
      gtin,
    }));
    aliasPriceResult.evidence.needs = aliasPriceResult.evidence.needs.map((need) => ({
      ...need,
      ordinaryPrices: need.ordinaryPrices.map((price) => ({
        ...price,
        productMatch: { canonicalProductId: "product:shared", kind: "exact" },
      })),
    }));

    const browse = await new DiscoveryService({
      catalog: catalogReader(aliases),
      now: () => NOW,
      priceService: { readExact: async () => aliasPriceResult },
    }).browse(MARKET_CONTEXT);
    expect(browse.products).toHaveLength(1);
    expect(browse.products[0]!.catalog.gtin).toBe(GTINS[0]);
    expect(browse.sources.map(({ id }) => id)).toEqual(["kassalapp"]);

    const exactSearch = await new DiscoveryService({
      catalog: catalogReader(aliases),
      now: () => NOW,
      priceService: { readExact: async () => aliasPriceResult },
    }).search(alias.gtin, MARKET_CONTEXT);
    expect(exactSearch.products).toHaveLength(1);
    expect(exactSearch.products[0]!.catalog.gtin).toBe(alias.gtin);
    expect(exactSearch.products[0]!.canonicalProductId).toBe("product:shared");
    expect(exactSearch.sources.map(({ id }) => id)).toEqual(["alias-catalog", "kassalapp"]);
  });

  it("omits an oversized independent history claim without breaking ordinary-price browse", async () => {
    const mature = priceResultFor([products[0]!]);
    const current = mature.evidence.needs[0]!.ordinaryPrices[0]!;
    const canonicalProductId = mature.products[0]!.canonicalProductId;
    const history: PriceEvidence[] = Array.from({ length: 300 }, (_, index) => {
      const day = Math.floor(index / 10);
      const observedAt = new Date(Date.UTC(2026, 5, 17 + day, 10)).toISOString();
      return {
        amountOre: money(3_000),
        chainId: current.chainId,
        contractVersion: 1,
        evidenceLevel: "observed",
        geographicScope: { countryCode: "NO", kind: "national" },
        id: `history:${index}`,
        kind: "price-evidence",
        observedAt,
        priceKind: "ordinary",
        productMatch: { canonicalProductId, kind: "exact" },
        sourceId: source.id,
        sourceRecordId: `history:${index}:${"x".repeat(170)}`,
      };
    });
    mature.evidence.needs = [{
      ...mature.evidence.needs[0]!,
      historicalComparisons: [{
        baselineMethod: "median-30d",
        baselineOre: 3_000,
        canonicalProductId,
        chainId: current.chainId,
        contractVersion: 1,
        currentEvidenceId: current.id,
        currentOre: current.amountOre,
        derivedAt: NOW.toISOString(),
        distinctObservationDays: 30,
        id: "comparison:mature",
        kind: "historical-comparison",
        savingsBasisPoints: 3_333,
        savingsOre: money(1_000),
        sourceEvidenceIds: history.map(({ id }) => id),
        windowEndsAt: current.observedAt,
        windowStartsAt: "2026-06-16T11:00:00.000Z",
      }],
      historicalPriceEvidence: history,
    }];
    expect(new TextEncoder().encode(JSON.stringify(history)).byteLength).toBeGreaterThan(128 * 1_024);

    const result = await new DiscoveryService({
      catalog: catalogReader([products[0]!]),
      now: () => NOW,
      priceService: { readExact: async () => mature },
    }).browse(MARKET_CONTEXT);

    expect(result.products[0]!.ordinaryPrices).toHaveLength(1);
    expect(result.products[0]!.historicalComparisons).toEqual([]);
    expect(result.products[0]!.historicalPriceEvidence).toEqual([]);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(128 * 1_024);
  });

  it("returns a validated cache-only empty snapshot without reading prices", async () => {
    const catalog = catalogReader([]);
    const readExact = vi.fn();
    await expect(new DiscoveryService({
      catalog,
      now: () => NOW,
      priceService: { readExact },
    }).browse(MARKET_CONTEXT)).resolves.toEqual({
      contractVersion: 1,
      generatedAt: NOW.toISOString(),
      marketContext: MARKET_CONTEXT,
      observedCategories: {
        completeness: "partial",
        facets: [],
        hasMore: false,
        kind: "observed-category-directory",
      },
      page: {
        hasMore: false,
        kind: "bounded-catalog-slice",
        pageSize: 8,
        scannedCatalogProducts: 0,
      },
      priceDataSource: "cache",
      products: [],
      selection: { chain: "all", resultType: "all" },
      sources: [],
    });
    expect(readExact).not.toHaveBeenCalled();
  });

  it("fails closed when catalog and price provenance disagree", async () => {
    const conflicting = [{
      ...products[0]!,
      catalogEvidence: {
        ...products[0]!.catalogEvidence,
        source: { ...source, sourceClass: "catalog" as const },
      },
    }];
    await expect(new DiscoveryService({
      catalog: catalogReader(conflicting),
      now: () => NOW,
      priceService: { readExact: async () => priceResultFor(conflicting) },
    }).browse(MARKET_CONTEXT)).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it("maps catalog and price cancellation without leaking provider details", async () => {
    const cancelledCatalog = catalogReader();
    cancelledCatalog.readDiscoveryPage.mockRejectedValue(new PublicCatalogIndexReaderError("CANCELLED"));
    await expect(new DiscoveryService({
      catalog: cancelledCatalog,
      priceService: { readExact: async () => priceResultFor(products) },
    }).browse(MARKET_CONTEXT)).rejects.toBeInstanceOf(DiscoveryRequestCancelledError);

    await expect(new DiscoveryService({
      catalog: catalogReader(),
      priceService: { readExact: async () => { throw new PriceServiceError("CANCELLED"); } },
    }).browse(MARKET_CONTEXT)).rejects.toBeInstanceOf(DiscoveryRequestCancelledError);
  });

  it("sanitizes malformed reader output", async () => {
    await expect(new DiscoveryService({
      catalog: catalogReader(),
      now: () => NOW,
      priceService: { readExact: async () => ({
        ...priceResultFor(products),
        evidence: { assignmentEvidence: [], needs: [], sources: [source] },
      }) },
    }).browse(MARKET_CONTEXT)).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});
