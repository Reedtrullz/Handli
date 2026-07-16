import { describe, expect, it } from "vitest";

import {
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
  priceDataSource: "cache",
  products: [{
    canonicalProductId: "product:milk",
    catalog,
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
  sources: [source],
} as const;

describe("public discovery contracts", () => {
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
