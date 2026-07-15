import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer, FAKE_EVALUATION_TIME, InMemoryPriceCache } from "./container";
import { readServerEnv } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("fake server container", () => {
  it("rejects direct fake composition in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createServerContainer({ mode: "fake" })).toThrow(/production/i);
    const attemptedOverride = createServerContainer as unknown as (
      env: { mode: "fake" },
      nodeEnv: string,
    ) => unknown;
    expect(() => attemptedOverride({ mode: "fake" }, "development")).toThrow(/production/i);
  });

  it("does not read a credential-shaped value in fake mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = readServerEnv({
      NODE_ENV: "test",
      KASSAL_MODE: "fake",
      KASSAL_API_KEY: `runtime-${randomUUID()}`,
    });

    const container = createServerContainer(env);
    await container.gateway.searchProducts("lettmelk", 20);

    expect(env.mode).toBe("fake");
    expect(Object.keys(env)).toEqual(["mode"]);
    expect(fetchSpy.mock.calls.length).toBe(0);
    fetchSpy.mockRestore();
  });

  it("serves deterministic products and a one-to-three-chain complete frontier", async () => {
    const container = createServerContainer({ mode: "fake" });
    const products = await container.gateway.searchProducts("lettmelk", 20);

    expect(products).toEqual([
      expect.objectContaining({ ean: "7038010000013", name: "TINE Lettmelk 1 % 1 l" }),
    ]);

    const milk = products[0]!;
    const coffee = (await container.gateway.searchProducts("kaffe", 20))[0]!;
    const bread = (await container.gateway.searchProducts("brød", 20))[0]!;
    const result = await container.planService.calculate({
      needs: [milk, coffee, bread].map((product) => ({
        id: product.ean,
        query: product.name,
        quantity: 1,
        quantityUnit: "each" as const,
        matchRuleId: `rule-${product.ean}`,
        required: true,
      })),
      matchingRules: [milk, coffee, bread].map((product) => ({
        id: `rule-${product.ean}`,
        mode: "exact" as const,
        exactEan: product.ean,
        userApproved: true as const,
        explanation: "Eksakt produkt",
      })),
      products: [milk, coffee, bread],
      maxStores: 3,
    });

    expect(result.generatedAt).toBe(FAKE_EVALUATION_TIME);
    expect(new Set(result.plans.map(({ chains }) => chains.length))).toEqual(new Set([1, 2, 3]));
    expect(new Set(result.plans.flatMap(({ chains }) => chains))).toEqual(
      new Set(["bunnpris", "rema-1000", "extra"]),
    );
  });

  it("keeps the intentionally stale fixture ineligible", async () => {
    const container = createServerContainer({ mode: "fake" });
    const product = (await container.gateway.searchProducts("stale", 20))[0]!;
    const result = await container.planService.calculate({
      needs: [{ id: "stale", query: product.name, quantity: 1, quantityUnit: "each", matchRuleId: "stale-rule", required: true }],
      matchingRules: [{ id: "stale-rule", mode: "exact", exactEan: product.ean, userApproved: true, explanation: "Eksakt produkt" }],
      products: [product],
      maxStores: 3,
    });

    expect(result.plans).toEqual([]);
  });
});

describe("InMemoryPriceCache", () => {
  const older = "2026-07-15T09:00:00.000Z";
  const current = "2026-07-15T10:00:00.000Z";
  const newer = "2026-07-15T11:00:00.000Z";
  const row = (ean: string, chain: "bunnpris" | "rema-1000" | "extra", amountOre: number, observedAt: string) => ({
    ean,
    chain,
    amountOre: amountOre as never,
    observedAt,
    source: "kassalapp" as const,
  });

  it("merges keys and returns deterministic EAN/chain order", async () => {
    const cache = new InMemoryPriceCache();
    await cache.putMany([
      row("7038010000020", "extra", 2000, current),
      row("7038010000013", "rema-1000", 1000, current),
    ]);
    await cache.putMany([row("7038010000013", "bunnpris", 900, current)]);

    expect(await cache.getMany(["7038010000020", "7038010000013"])).toEqual([
      row("7038010000013", "bunnpris", 900, current),
      row("7038010000013", "rema-1000", 1000, current),
      row("7038010000020", "extra", 2000, current),
    ]);
  });

  it("uses the latest equal-time input within one batch", async () => {
    const cache = new InMemoryPriceCache();
    await cache.putMany([
      row("7038010000013", "extra", 1200, current),
      row("7038010000013", "extra", 1100, current),
    ]);

    expect(await cache.getMany(["7038010000013"])).toEqual([
      row("7038010000013", "extra", 1100, current),
    ]);
  });

  it("replaces persisted rows only with a strictly newer observation", async () => {
    const cache = new InMemoryPriceCache();
    await cache.putMany([row("7038010000013", "extra", 1200, current)]);
    await cache.putMany([row("7038010000013", "extra", 900, older)]);
    await cache.putMany([row("7038010000013", "extra", 800, current)]);
    expect(await cache.getMany(["7038010000013"])).toEqual([
      row("7038010000013", "extra", 1200, current),
    ]);

    await cache.putMany([row("7038010000013", "extra", 700, newer)]);
    expect(await cache.getMany(["7038010000013"])).toEqual([
      row("7038010000013", "extra", 700, newer),
    ]);
  });
});
