import { randomUUID } from "node:crypto";

import { PostgresActiveCatalogReader } from "@handleplan/db/catalog-reader";
import { PostgresPlanningEvidenceReader } from "@handleplan/db/planning-evidence-reader";
import { PostgresPublicCatalogIndexReader } from "@handleplan/db/public-catalog-index-reader";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer, FAKE_EVALUATION_TIME } from "./container";
import { readServerEnv } from "./env";
import { PriceService } from "./price-service";

afterEach(() => vi.unstubAllEnvs());

describe("fake server container", () => {
  it("rejects direct fake composition in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createServerContainer({ mode: "fake" })).toThrow(/production/i);
  });

  it("does not read a credential-shaped value or call upstream in fake mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = readServerEnv({
      HANDLEPLAN_MODE: "fake",
      KASSAL_API_KEY: `runtime-${randomUUID()}`,
      NODE_ENV: "test",
    });

    const container = createServerContainer(env);
    const products = await container.publicCatalogIndex.search(
      "lettmelk",
      20,
      new Date(FAKE_EVALUATION_TIME),
    );

    expect(env).toEqual({ mode: "fake" });
    expect(products).toEqual([
      expect.objectContaining({
        displayName: "TINE Lettmelk 1 % 1 l",
        gtin: "7038010000010",
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("serves deterministic persisted-style discovery without an upstream gateway", async () => {
    const container = createServerContainer({ mode: "fake" });
    const result = await container.discoveryService.search("lettmelk");

    expect(result.generatedAt).toBe(FAKE_EVALUATION_TIME);
    expect(result.priceDataSource).toBe("cache");
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      catalog: { gtin: "7038010000010" },
      ordinaryPrices: expect.arrayContaining([
        expect.objectContaining({ chainId: "bunnpris", amountOre: 2_000 }),
        expect.objectContaining({ chainId: "extra", amountOre: 2_600 }),
        expect.objectContaining({ chainId: "rema-1000", amountOre: 2_500 }),
      ]),
    });
  });

  it("rehydrates exact GTIN requests from the server-owned active catalog", async () => {
    const container = createServerContainer({ mode: "fake" });
    const result = await container.planService.calculateExact!({
      contractVersion: 1,
      maxStores: 1,
      needs: [{
        id: "need:milk",
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: "7038010000010" },
          userApproved: true,
        },
        quantity: 2,
        quantityUnit: "each",
        required: true,
      }],
    });

    expect(result.products).toEqual([expect.objectContaining({
      displayName: "TINE Lettmelk 1 % 1 l",
      gtin: "7038010000010",
      packageMeasure: { amount: 1_000, unit: "ml" },
    })]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      chains: ["bunnpris"],
      totalOre: 4_000,
      assignments: [{
        checkout: { ordinaryTotalOre: 4_000, savingOre: 0, totalOre: 4_000 },
        fulfilment: {
          complete: true,
          packageCount: 2,
          requested: { amount: 2, unit: "package" },
        },
      }],
    });
  });

  it("keeps the intentionally stale price fixture ineligible", async () => {
    const container = createServerContainer({ mode: "fake" });
    const result = await container.planService.calculateExact!({
      contractVersion: 1,
      maxStores: 3,
      needs: [{
        id: "need:stale",
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: "7038010000041" },
          userApproved: true,
        },
        quantity: 1,
        quantityUnit: "each",
        required: true,
      }],
    });

    expect(result.plans).toEqual([]);
    expect(result.evidence.needs[0]?.ordinaryPrices).toEqual([]);
  });
});

describe("real server container", () => {
  it("composes only read-only persisted catalog and evidence readers", () => {
    const container = createServerContainer({
      mode: "real",
      DATABASE_URL: "postgresql://handleplan_web:password@127.0.0.1:5432/handleplan",
    });
    const planDependencies = (container.planService as unknown as {
      dependencies: {
        cache?: unknown;
        catalog?: unknown;
        gateway?: unknown;
        priceService?: unknown;
      };
    }).dependencies;
    const discoveryDependencies = (container.discoveryService as unknown as {
      dependencies: { catalog: unknown; priceService: unknown };
    }).dependencies;

    expect(container.publicCatalogIndex).toBeInstanceOf(PostgresPublicCatalogIndexReader);
    expect(planDependencies.catalog).toBeInstanceOf(PostgresActiveCatalogReader);
    expect(planDependencies.priceService).toBeInstanceOf(PriceService);
    expect(planDependencies.cache).toBeUndefined();
    expect(planDependencies.gateway).toBeUndefined();
    expect(discoveryDependencies.catalog).toBe(container.publicCatalogIndex);
    expect(discoveryDependencies.priceService).toBe(planDependencies.priceService);
    const priceDependencies = (planDependencies.priceService as unknown as {
      dependencies: { reader: unknown };
    }).dependencies;
    expect(priceDependencies.reader).toBeInstanceOf(PostgresPlanningEvidenceReader);
  });
});
