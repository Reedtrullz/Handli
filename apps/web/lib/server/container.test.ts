import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer, FAKE_EVALUATION_TIME } from "./container";

describe("fake server container", () => {
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
