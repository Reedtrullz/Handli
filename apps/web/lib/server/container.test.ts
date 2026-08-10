import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PostgresActiveCatalogReader } from "@handleplan/db/catalog-reader";
import { PostgresBranchDirectory } from "@handleplan/db/branch-directory";
import { PostgresPlanningEvidenceReader } from "@handleplan/db/planning-evidence-reader";
import { PostgresPublicOfficialOfferReader } from "@handleplan/db/public-official-offer-reader";
import { PostgresPublicCatalogIndexReader } from "@handleplan/db/public-catalog-index-reader";
import { PostgresReviewedFamilyReader } from "@handleplan/db/reviewed-family-reader";
import { PostgresPublicSourceStatusReader } from "@handleplan/db/source-status-reader";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer, FAKE_EVALUATION_TIME } from "./container";
import { DiscoveryImpactService } from "./discovery-impact-service";
import { readServerEnv } from "./env";
import { FamilyCandidateService } from "./family-candidate-service";
import { PriceService } from "./price-service";
import { SourceStatusService } from "./source-status-service";

const browserEvidenceRuntimeProofKey = Symbol.for(
  "handleplan.e2e.loopback-production-browser-fake-runtime.v1",
);

const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, browserEvidenceRuntimeProofKey);
});

describe("fake server container", () => {
  it("rejects direct fake composition in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createServerContainer({ mode: "fake" })).toThrow(/production/i);
  });

  it("allows direct fake composition only inside the bound loopback browser harness", () => {
    const sentinel = `handleplan-e2e-${"a".repeat(48)}`;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HANDLEPLAN_MODE", "fake");
    vi.stubEnv("HANDLEPLAN_E2E_SENTINEL", sentinel);
    vi.stubEnv("HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN", sentinel);
    vi.stubEnv("HANDLEPLAN_E2E_PUBLIC_ORIGIN", "https://127.0.0.1:3109");
    vi.stubEnv("HOSTNAME", "127.0.0.1");
    vi.stubEnv("KASSAL_API_KEY", sentinel);
    vi.stubEnv("PORT", "3108");
    Reflect.set(globalThis, browserEvidenceRuntimeProofKey, sentinel);

    expect(createServerContainer({ mode: "fake" }).planService).toBeDefined();
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
    const result = await container.discoveryService.search("lettmelk", MARKET_CONTEXT);

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

  it("keeps fake source status empty instead of implying a live public source", async () => {
    const result = await createServerContainer({ mode: "fake" }).sourceStatusService.read();

    expect(result).toMatchObject({
      entries: [],
      generatedAt: FAKE_EVALUATION_TIME,
      overall: "no-approved-sources",
    });
  });

  it("rehydrates exact GTIN requests from the server-owned active catalog", async () => {
    const container = createServerContainer({ mode: "fake" });
    const result = await container.planService.calculateExact({
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      marketContext: MARKET_CONTEXT,
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

  it("serves deterministic reviewed-family candidates without network access", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const container = createServerContainer({ mode: "fake" });

    const result = await container.familyCandidateService.inspect({
      contractVersion: 2,
      families: [
        { familyId: "family:kaffe" },
        { allowedBrands: [" TINE "], familyId: "family:melk" },
      ],
    });

    expect(result.generatedAt).toBe(FAKE_EVALUATION_TIME);
    expect(result.candidateSets).toEqual([
      expect.objectContaining({
        candidateProductIds: ["product:7038010000027"],
        family: expect.objectContaining({ id: "family:kaffe", labelNo: "Kaffe" }),
      }),
      expect.objectContaining({
        allowedBrands: ["tine"],
        candidateProductIds: ["product:7038010000010"],
        family: expect.objectContaining({ id: "family:melk", labelNo: "Melk" }),
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("plans a deterministic mixed reviewed-family basket without network access", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const container = createServerContainer({ mode: "fake" });
    const inspection = await container.familyCandidateService.inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    });
    const confirmed = inspection.candidateSets[0]!;

    const result = await container.planService.calculateReviewed({
      contractVersion: 2,
      enabledMembershipProgramIds: [],
      marketContext: MARKET_CONTEXT,
      maxStores: 2,
      needs: [
        {
          id: "need:coffee",
          match: {
            kind: "exact-product",
            product: { kind: "gtin", value: "7038010000027" },
            userApproved: true,
          },
          quantity: 1,
          quantityUnit: "package",
          required: true,
        },
        {
          id: "need:milk",
          match: {
            confirmation: {
              candidateSetId: confirmed.candidateSetId,
              taxonomyVersionId: confirmed.taxonomyVersionId,
              userApproved: true,
            },
            familyId: "family:melk",
            kind: "reviewed-family",
          },
          quantity: 1,
          quantityUnit: "package",
          required: true,
        },
      ],
    });

    expect(result.generatedAt).toBe(FAKE_EVALUATION_TIME);
    expect(result.needMatches.map(({ kind }) => kind)).toEqual([
      "exact-product",
      "reviewed-family",
    ]);
    expect(result.plans).toHaveLength(2);
    expect(result.plans.every(({ chains }) => chains.length <= 2)).toBe(true);
    expect(result.evidence.memberships).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps the intentionally stale price fixture ineligible", async () => {
    const container = createServerContainer({ mode: "fake" });
    const result = await container.planService.calculateExact({
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      marketContext: MARKET_CONTEXT,
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
  it("keeps the public web package independent of the upstream provider client", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies).not.toHaveProperty("@handleplan/kassalapp");
  });

  it("composes only read-only persisted catalog and evidence readers", () => {
    const container = createServerContainer({
      mode: "real",
      DATABASE_URL: "postgresql://handleplan_web:password@127.0.0.1:5432/handleplan",
    });
    const planDependencies = (container.planService as unknown as {
      dependencies: {
        catalog?: unknown;
        familyCandidateService?: unknown;
        priceService?: unknown;
      };
    }).dependencies;
    const discoveryDependencies = (container.discoveryService as unknown as {
      dependencies: { catalog: unknown; priceService: unknown };
    }).dependencies;
    const impactDependencies = (container.discoveryImpactService as unknown as {
      dependencies: { resolver: unknown };
    }).dependencies;

    expect(container.publicCatalogIndex).toBeInstanceOf(PostgresPublicCatalogIndexReader);
    expect(container.branchDirectory).toBeInstanceOf(PostgresBranchDirectory);
    expect(container.familyCandidateService).toBeInstanceOf(FamilyCandidateService);
    expect(container.discoveryImpactService).toBeInstanceOf(DiscoveryImpactService);
    expect(container.sourceStatusService).toBeInstanceOf(SourceStatusService);
    expect(impactDependencies.resolver).toBe(container.planService);
    expect("calculate" in container.planService).toBe(false);
    expect(planDependencies.catalog).toBeInstanceOf(PostgresActiveCatalogReader);
    expect(planDependencies.familyCandidateService).toBe(container.familyCandidateService);
    expect(planDependencies.priceService).toBeInstanceOf(PriceService);
    expect(discoveryDependencies.catalog).toBe(container.publicCatalogIndex);
    expect(discoveryDependencies.priceService).toBe(planDependencies.priceService);
    const priceDependencies = (planDependencies.priceService as unknown as {
      dependencies: { officialOfferReader: unknown; reader: unknown };
    }).dependencies;
    expect(priceDependencies.reader).toBeInstanceOf(PostgresPlanningEvidenceReader);
    expect(priceDependencies.officialOfferReader).toBeInstanceOf(
      PostgresPublicOfficialOfferReader,
    );
    const candidateDependencies = (container.familyCandidateService as unknown as {
      dependencies: { reader: unknown };
    }).dependencies;
    expect(candidateDependencies.reader).toBeInstanceOf(PostgresReviewedFamilyReader);
    const sourceStatusDependencies = (container.sourceStatusService as unknown as {
      reader: unknown;
    });
    expect(sourceStatusDependencies.reader).toBeInstanceOf(PostgresPublicSourceStatusReader);
  });
});
