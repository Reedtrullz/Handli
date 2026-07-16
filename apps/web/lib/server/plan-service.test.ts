import type { PriceCache } from "@handleplan/db";
import type { PlanningEvidenceSnapshot } from "@handleplan/db/planning-evidence-reader";
import {
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type MatchRule,
  type Need,
  type PriceObservation,
  type Product,
} from "@handleplan/domain";
import {
  FakeKassalappGateway,
  KassalappGatewayError,
} from "@handleplan/kassalapp";
import { describe, expect, it } from "vitest";

import {
  type ActiveCatalogReader,
  CatalogUnavailableError,
  PlanService,
  PriceDataUnavailableError,
  planApiRequestSchema,
  UnknownExactProductError,
} from "./plan-service";
import { PriceService } from "./price-service";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const product = {
  ean: "7038010000010",
  name: "Tine Lettmelk 1 %",
} satisfies Product;
const need = {
  id: "melk",
  matchRuleId: "melk-exact",
  query: "melk",
  quantity: 1,
  quantityUnit: "each",
  required: true,
} satisfies Need;
const rule = {
  exactEan: product.ean,
  explanation: "Nøyaktig produkt",
  id: need.matchRuleId,
  mode: "exact",
  userApproved: true,
} satisfies MatchRule;

function price(observedAt = "2026-07-15T10:00:00.000Z"): PriceObservation {
  return {
    amountOre: 2190 as PriceObservation["amountOre"],
    chain: "extra",
    ean: product.ean,
    observedAt,
    source: "kassalapp",
  };
}

class MemoryCache implements PriceCache {
  writes: PriceObservation[][] = [];
  writeTimes: Date[] = [];
  private readonly rows: PriceObservation[];

  constructor(rows: PriceObservation[] = []) {
    this.rows = [...rows];
  }

  async getMany(eans: string[]): Promise<PriceObservation[]> {
    const selected = new Set(eans);
    return this.rows.filter((row) => selected.has(row.ean));
  }

  async putMany(rows: PriceObservation[], now?: Date): Promise<void> {
    this.writes.push(rows);
    if (now !== undefined) this.writeTimes.push(now);
    for (const row of rows) {
      const existingIndex = this.rows.findIndex(
        (existing) => existing.ean === row.ean && existing.chain === row.chain,
      );
      if (existingIndex === -1) {
        this.rows.push(row);
      } else if (this.rows[existingIndex]!.observedAt < row.observedAt) {
        this.rows[existingIndex] = row;
      }
    }
  }
}

const request = {
  matchingRules: [rule],
  maxStores: 3 as const,
  needs: [need],
  products: [product],
};

const exactRequest: ExactProductPlanApiRequest = {
  contractVersion: 1,
  maxStores: 3,
  needs: [
    {
      id: "melk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: product.ean },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    },
  ],
};

const canonicalSummary: ExactProductPlanApiProductSummary = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-15T10:00:00.000Z",
    source: {
      contractVersion: 1,
      displayName: "Kassalapp test fixture",
      id: "kassalapp",
      sourceClass: "ordinary-price",
      state: "approved",
    },
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "Canonical TINE Lettmelk",
  gtin: product.ean,
  packageMeasure: { amount: 1_000, unit: "ml" },
  unitsPerPack: 1,
};

function catalogReader(
  rows: ExactProductPlanApiProductSummary[],
): ActiveCatalogReader & { calls: Array<{ at: Date; gtins: string[]; signal?: AbortSignal }> } {
  const calls: Array<{ at: Date; gtins: string[]; signal?: AbortSignal }> = [];
  return {
    calls,
    getMany: async (gtins, at, signal) => {
      calls.push({ at, gtins: [...gtins], signal });
      return rows;
    },
  };
}

function exactPriceService(rows: PriceObservation[]): PriceService {
  const snapshot: PlanningEvidenceSnapshot = {
    coverageChecks: [],
    historicalEligibleEvidenceIds: [],
    priceEvidence: rows.map((row, index) => ({
      amountOre: row.amountOre,
      chainId: row.chain,
      contractVersion: 1,
      evidenceLevel: "observed",
      geographicScope: { countryCode: "NO", kind: "national" },
      id: `price:test:${index + 1}`,
      kind: "price-evidence",
      observedAt: row.observedAt,
      priceKind: "ordinary",
      productMatch: { canonicalProductId: "product:milk", kind: "exact" },
      sourceId: row.source,
      sourceRecordId: `record:test:${index + 1}`,
    })),
    products: [{ canonicalProductId: "product:milk", gtin: product.ean }],
    sources: rows.length === 0 ? [] : [{
      contractVersion: 1,
      displayName: "Kassalapp test fixture",
      id: "kassalapp",
      sourceClass: "ordinary-price",
      state: "approved",
    }],
  };
  return new PriceService({ reader: { getMany: async () => snapshot } });
}

describe("PlanService", () => {
  it("uses fresh upstream prices, writes normalized cache rows, and forwards cancellation", async () => {
    const cache = new MemoryCache();
    const gateway = new FakeKassalappGateway([product], [price()]);
    const signal = new AbortController().signal;
    let seenSignal: AbortSignal | undefined;
    const original = gateway.getBulkPrices.bind(gateway);
    gateway.getBulkPrices = async (eans, callerSignal) => {
      seenSignal = callerSignal;
      return original(eans, callerSignal);
    };

    const result = await new PlanService({ cache, gateway, now: () => NOW }).calculate(
      request,
      signal,
    );

    expect(result.priceDataSource).toBe("upstream");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ coverage: 1, chains: ["extra"] });
    expect(cache.writes).toEqual([[price()]]);
    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(seenSignal).toBe(signal);
  });

  it("never plans from upstream rows that the configured read model rejects", async () => {
    const rejectingReadModel: PriceCache = {
      getMany: async () => [],
      putMany: async () => undefined,
    };

    const result = await new PlanService({
      cache: rejectingReadModel,
      gateway: new FakeKassalappGateway([product], [price()]),
      now: () => NOW,
    }).calculate(request);

    expect(result).toMatchObject({ plans: [], priceDataSource: "upstream" });
  });

  it("does not use raw upstream rows when evidence persistence fails", async () => {
    const failingPersistence: PriceCache = {
      getMany: async () => [],
      putMany: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      new PlanService({
        cache: failingPersistence,
        gateway: new FakeKassalappGateway([product], [price()]),
        now: () => NOW,
      }).calculate(request),
    ).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("uses previously admitted evidence when a refresh cannot be persisted", async () => {
    const admitted = price("2026-07-15T09:00:00.000Z");
    const failingRefresh: PriceCache = {
      getMany: async () => [admitted],
      putMany: async () => {
        throw new Error("database unavailable");
      },
    };

    const result = await new PlanService({
      cache: failingRefresh,
      gateway: new FakeKassalappGateway([product], [price()]),
      now: () => NOW,
    }).calculate(request);

    expect(result).toMatchObject({ priceDataSource: "cache", plans: [{ totalOre: 2_190 }] });
  });

  it("evaluates successful upstream rows after the awaited response", async () => {
    const requestStartedAt = new Date("2026-07-15T10:00:00.000Z");
    const observationAt = "2026-07-15T10:00:01.000Z";
    const responseCompletedAt = new Date("2026-07-15T10:00:02.000Z");
    let clock = requestStartedAt;
    const cache = new MemoryCache();
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      clock = responseCompletedAt;
      return [price(observationAt)];
    };

    const result = await new PlanService({ cache, gateway, now: () => clock }).calculate(request);

    expect(result.plans).toHaveLength(1);
    expect(result.generatedAt).toBe(responseCompletedAt.toISOString());
    expect(cache.writes).toEqual([[price(observationAt)]]);
    expect(cache.writeTimes).toEqual([responseCompletedAt]);
  });

  it("fetches only unique candidates for required approved matches", async () => {
    const constrainedProduct = {
      brand: "Tine",
      ean: "7038010000027",
      name: "Tine Helmelk",
      productFamily: "melk",
    } satisfies Product;
    const flexibleProduct = {
      ean: "7038010000034",
      name: "Havregryn",
      productFamily: "havregryn",
    } satisfies Product;
    const unrelatedProduct = {
      ean: "7038010000041",
      name: "Taco",
      productFamily: "taco",
    } satisfies Product;
    const optionalProduct = {
      ean: "7038010000058",
      name: "Kaffe",
    } satisfies Product;
    const candidateRequest = planApiRequestSchema.parse({
      matchingRules: [
        {
          allowedBrands: ["Tine"],
          explanation: "Tine melk",
          id: "milk-rule",
          mode: "constrained",
          productFamily: "melk",
          userApproved: true,
        },
        {
          explanation: "Alle havregryn",
          id: "oats-rule",
          mode: "flexible",
          productFamily: "havregryn",
          userApproved: true,
        },
        {
          exactEan: optionalProduct.ean,
          explanation: "Nøyaktig kaffe",
          id: "coffee-rule",
          mode: "exact",
          userApproved: true,
        },
      ],
      maxStores: 3,
      needs: [
        { ...need, id: "milk", matchRuleId: "milk-rule" },
        { ...need, id: "oats", matchRuleId: "oats-rule", query: "havregryn" },
        {
          ...need,
          id: "coffee",
          matchRuleId: "coffee-rule",
          query: "kaffe",
          required: false,
        },
      ],
      products: [constrainedProduct, flexibleProduct, unrelatedProduct, optionalProduct],
    });
    let requestedEans: string[] = [];
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async (eans) => {
      requestedEans = eans;
      return [];
    };

    const result = await new PlanService({
      cache: new MemoryCache(),
      gateway,
      now: () => NOW,
    }).calculate(candidateRequest);

    expect(requestedEans).toEqual([constrainedProduct.ean, flexibleProduct.ean]);
    expect(result).toMatchObject({ plans: [], priceDataSource: "upstream" });
  });

  it("drops future-invalid rows before planning and cache persistence", async () => {
    const cache = new MemoryCache();
    const current = price();
    const future = { ...price("2026-07-15T12:00:00.001Z"), amountOre: 1000 as PriceObservation["amountOre"] };

    const result = await new PlanService({
      cache,
      gateway: new FakeKassalappGateway([product], [current, future]),
      now: () => NOW,
    }).calculate(request);

    expect(result.plans).toHaveLength(1);
    expect(cache.writes).toEqual([[current]]);
  });

  it("uses eligible cache only when it forms a complete required-item plan", async () => {
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    };

    const result = await new PlanService({
      cache: new MemoryCache([price()]),
      gateway,
      now: () => NOW,
    }).calculate(request);

    expect(result.priceDataSource).toBe("cache");
    expect(result.plans).toHaveLength(1);
  });

  it("evaluates fallback freshness after the failed upstream wait", async () => {
    const requestStartedAt = new Date("2026-07-15T12:00:00.000Z");
    const afterFailure = new Date("2026-07-15T12:00:00.001Z");
    let clock = requestStartedAt;
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      clock = afterFailure;
      throw new KassalappGatewayError("TIMEOUT");
    };

    await expect(
      new PlanService({
        cache: new MemoryCache([price("2026-07-12T12:00:00.000Z")]),
        gateway,
        now: () => clock,
      }).calculate(request),
    ).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it.each([
    ["stale", "2026-07-12T11:59:59.999Z"],
    ["historical", "2026-06-30T11:59:59.999Z"],
    ["future-invalid", "2026-07-15T12:00:00.001Z"],
  ])("rejects %s cache after an upstream failure", async (_label, observedAt) => {
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new KassalappGatewayError("TIMEOUT");
    };

    await expect(
      new PlanService({
        cache: new MemoryCache([price(observedAt)]),
        gateway,
        now: () => NOW,
      }).calculate(request),
    ).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("rejects fresh cache that cannot cover every required need", async () => {
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new KassalappGatewayError("INVALID_RESPONSE");
    };

    await expect(
      new PlanService({ cache: new MemoryCache(), gateway, now: () => NOW }).calculate(request),
    ).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("does not turn caller cancellation into a cache-backed result", async () => {
    const cache = new MemoryCache([price()]);
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new KassalappGatewayError("CANCELLED");
    };

    await expect(
      new PlanService({ cache, gateway, now: () => NOW }).calculate(request),
    ).rejects.toMatchObject({ name: "PlanRequestCancelledError" });
  });

  it("returns a legitimate empty result when a successful upstream response has no plan", async () => {
    const result = await new PlanService({
      cache: new MemoryCache(),
      gateway: new FakeKassalappGateway([product], []),
      now: () => NOW,
    }).calculate(request);

    expect(result).toMatchObject({ plans: [], priceDataSource: "upstream" });
  });

  it("rehydrates exact identities and plans only from persisted admitted evidence", async () => {
    const catalog = catalogReader([canonicalSummary]);
    const gateway = new FakeKassalappGateway([], []);
    let gatewayCalls = 0;
    gateway.getBulkPrices = async () => {
      gatewayCalls += 1;
      throw new Error("versioned planning must not fetch upstream on a user request");
    };
    const signal = new AbortController().signal;

    const result = await new PlanService({
      cache: new MemoryCache([price()]),
      catalog,
      gateway,
      now: () => NOW,
      priceService: exactPriceService([price()]),
    }).calculateExact(exactRequest, signal);

    expect(catalog.calls).toEqual([{ at: NOW, gtins: [product.ean], signal }]);
    expect(result.products).toEqual([canonicalSummary]);
    expect(result.plans).toHaveLength(1);
    expect(result.priceDataSource).toBe("cache");
    expect(result.plans[0]?.assignments[0]).toMatchObject({
      canonicalProductId: "product:milk",
      checkout: { ordinaryTotalOre: 2_190, savingOre: 0, totalOre: 2_190 },
      fulfilment: { complete: true, contractVersion: 2 },
    });
    expect(result.evidence.assignmentEvidence).toHaveLength(1);
    expect(result.evidence.sources).toEqual([canonicalSummary.catalogEvidence.source]);
    expect(gatewayCalls).toBe(0);
  });

  it("fails closed when catalog and price evidence disagree about one source descriptor", async () => {
    const mismatchedCatalog = {
      ...canonicalSummary,
      catalogEvidence: {
        ...canonicalSummary.catalogEvidence,
        source: {
          ...canonicalSummary.catalogEvidence.source,
          displayName: "Conflicting catalog source name",
        },
      },
    } satisfies ExactProductPlanApiProductSummary;

    await expect(new PlanService({
      cache: new MemoryCache([price()]),
      catalog: catalogReader([mismatchedCatalog]),
      gateway: new FakeKassalappGateway([], []),
      now: () => NOW,
      priceService: exactPriceService([price()]),
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("uses only the server-owned package measure for exact measured fulfilment", async () => {
    const measuredRequest: ExactProductPlanApiRequest = {
      ...exactRequest,
      needs: [{ ...exactRequest.needs[0]!, quantity: 1_500, quantityUnit: "ml" }],
    };
    const result = await new PlanService({
      cache: new MemoryCache([price()]),
      catalog: catalogReader([canonicalSummary]),
      gateway: new FakeKassalappGateway([], []),
      now: () => NOW,
      priceService: exactPriceService([price()]),
    }).calculateExact(measuredRequest);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      totalOre: 4_380,
      assignments: [{
        costOre: 4_380,
        fulfilment: {
          canonicalProductId: "product:milk",
          complete: true,
          contractVersion: 2,
          needId: "melk",
          packageCount: 2,
          packageMeasure: { amount: 1_000, unit: "ml" },
          requested: { amount: 1_500, unit: "ml" },
          purchased: { amount: 2_000, unit: "ml" },
          surplus: { amount: 500, unit: "ml" },
        },
      }],
    });
  });

  it("rejects forged browser package metadata on the exact request boundary", async () => {
    const forged = {
      ...exactRequest,
      needs: [{
        ...exactRequest.needs[0]!,
        packageMeasure: { amount: 10_000, unit: "ml" },
      }],
    } as unknown as ExactProductPlanApiRequest;

    await expect(new PlanService({
      cache: new MemoryCache([price()]),
      catalog: catalogReader([canonicalSummary]),
      gateway: new FakeKassalappGateway([], []),
      now: () => NOW,
    }).calculateExact(forged)).rejects.toBeInstanceOf(UnknownExactProductError);
  });

  it("returns explicit empty coverage without an upstream request when admitted evidence is absent", async () => {
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new Error("versioned planning must not fetch upstream on a user request");
    };

    const result = await new PlanService({
      cache: new MemoryCache(),
      catalog: catalogReader([canonicalSummary]),
      gateway,
      now: () => NOW,
      priceService: exactPriceService([]),
    }).calculateExact(exactRequest);

    expect(result).toMatchObject({ plans: [], priceDataSource: "cache" });
  });

  it("fails closed when persisted exact-product evidence cannot be read", async () => {
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new Error("versioned planning must not fetch upstream on a user request");
    };
    const cache: PriceCache = {
      getMany: async () => { throw new Error("private storage detail"); },
      putMany: async () => { throw new Error("must not write"); },
    };

    await expect(new PlanService({
      cache,
      catalog: catalogReader([canonicalSummary]),
      gateway,
      now: () => NOW,
      priceService: {
        readExact: async () => { throw new Error("private storage detail"); },
      },
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("does not call the price gateway for an unknown exact product", async () => {
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      throw new Error("price gateway must not be called");
    };

    await expect(new PlanService({
      cache: new MemoryCache(),
      catalog: catalogReader([]),
      gateway,
      now: () => NOW,
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(UnknownExactProductError);
  });

  it("collapses catalog storage errors before any price-provider call", async () => {
    let gatewayCalls = 0;
    const gateway = new FakeKassalappGateway([], []);
    gateway.getBulkPrices = async () => {
      gatewayCalls += 1;
      return [];
    };
    const catalog: ActiveCatalogReader = {
      getMany: async () => {
        throw new Error("private database detail");
      },
    };

    await expect(new PlanService({
      cache: new MemoryCache(),
      catalog,
      gateway,
      now: () => NOW,
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(gatewayCalls).toBe(0);
  });

  it("rejects catalog rows carrying undeclared private metadata before price planning", async () => {
    let priceCalls = 0;
    const privateCatalogRow = {
      ...canonicalSummary,
      catalogEvidence: {
        ...canonicalSummary.catalogEvidence,
        privateReferenceKey: "must-not-leak",
      },
    } as unknown as ExactProductPlanApiProductSummary;

    await expect(new PlanService({
      cache: new MemoryCache(),
      catalog: catalogReader([privateCatalogRow]),
      gateway: new FakeKassalappGateway([], []),
      now: () => NOW,
      priceService: {
        readExact: async () => {
          priceCalls += 1;
          throw new Error("must not be called");
        },
      },
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(priceCalls).toBe(0);
  });

  it("rejects stale or future catalog provenance before price planning", async () => {
    for (const observedAt of [
      "2026-07-13T11:59:59.999Z",
      "2026-07-15T12:00:00.001Z",
    ]) {
      const invalid = {
        ...canonicalSummary,
        catalogEvidence: { ...canonicalSummary.catalogEvidence, observedAt },
      } satisfies ExactProductPlanApiProductSummary;
      await expect(new PlanService({
        cache: new MemoryCache(),
        catalog: catalogReader([invalid]),
        gateway: new FakeKassalappGateway([], []),
        now: () => NOW,
      }).calculateExact(exactRequest)).rejects.toBeInstanceOf(CatalogUnavailableError);
    }
  });
});

describe("planApiRequestSchema", () => {
  it("enforces public collection, string, and three-store bounds", () => {
    expect(planApiRequestSchema.safeParse({ ...request, maxStores: 4 }).success).toBe(false);
    expect(
      planApiRequestSchema.safeParse({ ...request, needs: Array.from({ length: 51 }, () => need) })
        .success,
    ).toBe(false);
    expect(
      planApiRequestSchema.safeParse({
        ...request,
        products: Array.from({ length: 201 }, () => product),
      }).success,
    ).toBe(false);
    expect(
      planApiRequestSchema.safeParse({
        ...request,
        needs: [{ ...need, query: "m".repeat(201) }],
      }).success,
    ).toBe(false);
    expect(planApiRequestSchema.safeParse({ ...request, prices: [price()] }).success).toBe(false);
  });

  it("rejects exact, constrained, and flexible required rules with no catalog candidate", () => {
    const missingExact = {
      ...request,
      matchingRules: [{ ...rule, exactEan: "7038010000997" }],
    };
    const missingConstrained = {
      ...request,
      matchingRules: [
        {
          allowedBrands: ["Q"],
          explanation: "Bare Q",
          id: rule.id,
          mode: "constrained",
          userApproved: true,
        },
      ],
    };
    const missingFlexible = {
      ...request,
      matchingRules: [
        {
          explanation: "Havregryn",
          id: rule.id,
          mode: "flexible",
          productFamily: "havregryn",
          userApproved: true,
        },
      ],
    };

    expect(planApiRequestSchema.safeParse(missingExact).success).toBe(false);
    expect(planApiRequestSchema.safeParse(missingConstrained).success).toBe(false);
    expect(planApiRequestSchema.safeParse(missingFlexible).success).toBe(false);
  });
});
