import type { PriceCache } from "@handleplan/db";
import {
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
  PlanService,
  PriceDataUnavailableError,
  planApiRequestSchema,
} from "./plan-service";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const product = {
  ean: "7038010000013",
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
      ean: "7038010000020",
      name: "Tine Helmelk",
      productFamily: "melk",
    } satisfies Product;
    const flexibleProduct = {
      ean: "7038010000037",
      name: "Havregryn",
      productFamily: "havregryn",
    } satisfies Product;
    const unrelatedProduct = {
      ean: "7038010000044",
      name: "Taco",
      productFamily: "taco",
    } satisfies Product;
    const optionalProduct = {
      ean: "7038010000051",
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
      matchingRules: [{ ...rule, exactEan: "7038010000990" }],
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
