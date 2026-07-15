import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import type { MoneyOre, PlanRequest, PriceObservation } from "./contracts";
import { calculatePlans } from "./index";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const CHAINS = ["bunnpris", "extra", "rema-1000"] as const;

const scenario = fc.record({
  seed: fc.integer({ min: 0, max: 10_000 }),
  needCount: fc.integer({ min: 1, max: 5 }),
  maxStores: fc.integer({ min: 1, max: 3 }),
});

function buildRequest(seed: number, needCount: number, maxStores: number): PlanRequest {
  const needs = Array.from({ length: needCount }, (_, index) => ({
    id: `need-${index}`,
    query: `vare ${index}`,
    quantity: 1 + ((seed + index) % 4),
    quantityUnit: "each" as const,
    matchRuleId: `rule-${index}`,
    required: true,
  }));
  const matchingRules = needs.map((need, index) => ({
    id: need.matchRuleId,
    mode: "exact" as const,
    exactEan: `7038010${String(index).padStart(6, "0")}`,
    userApproved: true as const,
    explanation: "Fast valgt vare.",
  }));
  const products = matchingRules.map((rule, index) => ({
    ean: rule.exactEan,
    name: `Vare ${index}`,
  }));
  const prices: PriceObservation[] = products.flatMap((product, productIndex) =>
    CHAINS.map((chain, chainIndex) => ({
      ean: product.ean,
      chain,
      amountOre: (100 + ((seed * 17 + productIndex * 31 + chainIndex * 47) % 5_000)) as MoneyOre,
      observedAt: new Date(NOW.getTime() - (productIndex + 1) * 60_000).toISOString(),
      source: "kassalapp" as const,
    })),
  );

  return {
    needs,
    matchingRules,
    products,
    prices,
    maxStores: maxStores as 1 | 2 | 3,
  };
}

describe("planner properties", () => {
  test.prop([scenario])("is deterministic, complete, bounded, and non-dominated", ({ seed, needCount, maxStores }) => {
    const request = buildRequest(seed, needCount, maxStores);
    const plans = calculatePlans(request, NOW);
    const reversed = calculatePlans(
      {
        ...request,
        needs: [...request.needs].reverse(),
        matchingRules: [...request.matchingRules].reverse(),
        products: [...request.products].reverse(),
        prices: [...request.prices].reverse(),
      },
      NOW,
    );

    expect(reversed).toEqual(plans);
    expect(new Set(plans.map(({ id }) => id)).size).toBe(plans.length);

    for (const plan of plans) {
      expect(plan.coverage).toBe(1);
      expect(plan.assignments).toHaveLength(needCount);
      expect(new Set(plan.assignments.map(({ needId }) => needId)).size).toBe(needCount);
      expect(plan.chains.length).toBeLessThanOrEqual(maxStores);
      expect(plan.chains.length).toBeLessThanOrEqual(3);
      expect(plan.totalOre).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(plan.totalOre)).toBe(true);
    }

    for (const candidate of plans) {
      for (const other of plans) {
        if (candidate.id === other.id) continue;

        const otherDominates =
          other.totalOre <= candidate.totalOre &&
          other.chains.length <= candidate.chains.length &&
          other.substitutions.length <= candidate.substitutions.length &&
          (other.totalOre < candidate.totalOre ||
            other.chains.length < candidate.chains.length ||
            other.substitutions.length < candidate.substitutions.length);
        expect(otherDominates).toBe(false);
      }
    }
  });
});
