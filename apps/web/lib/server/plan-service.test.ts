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

  constructor(private readonly rows: PriceObservation[] = []) {}

  async getMany(eans: string[]): Promise<PriceObservation[]> {
    const selected = new Set(eans);
    return this.rows.filter((row) => selected.has(row.ean));
  }

  async putMany(rows: PriceObservation[]): Promise<void> {
    this.writes.push(rows);
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

    expect(result.status).toBe("upstream");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ coverage: 1, chains: ["extra"] });
    expect(cache.writes).toEqual([[price()]]);
    expect(seenSignal).toBe(signal);
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

    expect(result.status).toBe("cache");
    expect(result.plans).toHaveLength(1);
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

    expect(result).toMatchObject({ plans: [], status: "upstream" });
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
});
