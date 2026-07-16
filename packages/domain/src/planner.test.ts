import { describe, expect, it } from "vitest";

import type {
  MatchRule,
  MoneyOre,
  Need,
  PlanRequest,
  PriceObservation,
  Product,
} from "./contracts";
import { calculatePlans } from "./index";

const NOW = new Date("2026-07-15T12:00:00.000Z");

const ore = (amount: number) => amount as MoneyOre;
const observedAt = (hoursAgo = 1) =>
  new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1_000).toISOString();

const products: Product[] = [
  { ean: "7038010000010", name: "Fast melk", productFamily: "milk" },
  { ean: "7038010000027", name: "Annen melk", productFamily: "milk" },
  { ean: "7038010000034", name: "Brød", productFamily: "bread" },
];

const needs: Need[] = [
  {
    id: "milk",
    query: "melk",
    quantity: 2,
    quantityUnit: "each",
    matchRuleId: "milk-rule",
    required: true,
  },
  {
    id: "bread",
    query: "brød",
    quantity: 1,
    quantityUnit: "each",
    matchRuleId: "bread-rule",
    required: true,
  },
];

const rules: MatchRule[] = [
  {
    id: "milk-rule",
    mode: "exact",
    exactEan: "7038010000010",
    userApproved: true,
    explanation: "Fast vare.",
  },
  {
    id: "bread-rule",
    mode: "flexible",
    productFamily: "bread",
    userApproved: true,
    explanation: "Godkjent brødfamilie.",
  },
];

const price = (
  ean: string,
  chain: PriceObservation["chain"],
  amountOre: number,
  hoursAgo = 1,
): PriceObservation => ({
  ean,
  chain,
  amountOre: ore(amountOre),
  observedAt: observedAt(hoursAgo),
  source: "kassalapp",
});

const request = (overrides: Partial<PlanRequest> = {}): PlanRequest => ({
  needs,
  matchingRules: rules,
  products,
  prices: [
    price("7038010000010", "extra", 2_000),
    price("7038010000034", "extra", 4_000),
    price("7038010000010", "rema-1000", 1_000),
    price("7038010000034", "bunnpris", 1_000),
  ],
  maxStores: 3,
  ...overrides,
});

describe("calculatePlans", () => {
  it("returns only complete required-item plans and rejects a missing required item", () => {
    const result = calculatePlans(
      request({ prices: [price("7038010000010", "extra", 2_000)] }),
      NOW,
    );

    expect(result).toEqual([]);
  });

  it("multiplies integer øre by quantity without floating-point money", () => {
    const [plan] = calculatePlans(
      request({
        needs: [needs[0]!],
        matchingRules: [rules[0]!],
        prices: [price("7038010000010", "extra", 1_299)],
        maxStores: 1,
      }),
      NOW,
    );

    expect(plan?.assignments).toEqual([
      {
        needId: "milk",
        ean: "7038010000010",
        chain: "extra",
        quantity: 2,
        costOre: 2_598,
        observedAt: "2026-07-15T11:00:00.000Z",
        source: "kassalapp",
      },
    ]);
    expect(plan?.totalOre).toBe(2_598);
  });

  it.each([
    {
      quantity: 1_500,
      quantityUnit: "ml" as const,
      packageQuantity: 1_000,
      packageCount: 2,
      fulfilledAmount: 2_000,
      surplusAmount: 500,
    },
    {
      quantity: 1_000,
      quantityUnit: "g" as const,
      packageQuantity: 500,
      packageCount: 2,
      fulfilledAmount: 1_000,
      surplusAmount: 0,
    },
  ])("fulfils $quantity $quantityUnit using enough real packages", ({
    quantity,
    quantityUnit,
    packageQuantity,
    packageCount,
    fulfilledAmount,
    surplusAmount,
  }) => {
    const [plan] = calculatePlans(request({
      needs: [{ ...needs[0]!, quantity, quantityUnit }],
      matchingRules: [rules[0]!],
      products: [{
        ...products[0]!,
        packageQuantity,
        packageUnit: quantityUnit,
      }],
      prices: [price("7038010000010", "extra", 1_299)],
      maxStores: 1,
    }), NOW);

    expect(plan?.totalOre).toBe(2_598);
    expect(plan?.assignments[0]?.fulfilment).toEqual({
      contractVersion: 1,
      needId: "milk",
      canonicalProductId: "7038010000010",
      requested: { amount: quantity, unit: quantityUnit },
      packageMeasure: { amount: packageQuantity, unit: quantityUnit },
      packageCount,
      fulfilledAmount,
      surplusAmount,
      complete: true,
    });
  });

  it("fails closed for missing, incompatible, fractional, or overflowing package fulfilment", () => {
    const baseNeed = { ...needs[0]!, quantity: 1_000, quantityUnit: "g" as const };
    const base = {
      needs: [baseNeed],
      matchingRules: [rules[0]!],
      prices: [price("7038010000010", "extra", 1_299)],
      maxStores: 1 as const,
    };

    expect(calculatePlans(request({ ...base, products: [products[0]!] }), NOW)).toEqual([]);
    expect(calculatePlans(request({
      ...base,
      products: [{ ...products[0]!, packageQuantity: 500, packageUnit: "ml" }],
    }), NOW)).toEqual([]);
    expect(calculatePlans(request({
      ...base,
      products: [{ ...products[0]!, packageQuantity: 1.5, packageUnit: "g" }],
    }), NOW)).toEqual([]);
    expect(calculatePlans(request({
      ...base,
      needs: [{ ...baseNeed, quantity: Number.MAX_SAFE_INTEGER }],
      products: [{ ...products[0]!, packageQuantity: Number.MAX_SAFE_INTEGER - 1, packageUnit: "g" }],
    }), NOW)).toEqual([]);
  });

  it("returns the non-dominated convenience and savings plans", () => {
    const result = calculatePlans(request(), NOW);

    expect(result.map(({ totalOre, chains, substitutions, coverage }) => ({
      totalOre,
      chains,
      substitutions,
      coverage,
    }))).toEqual([
      {
        totalOre: 8_000,
        chains: ["extra"],
        substitutions: ["bread"],
        coverage: 1,
      },
      {
        totalOre: 3_000,
        chains: ["bunnpris", "rema-1000"],
        substitutions: ["bread"],
        coverage: 1,
      },
    ]);
    expect(result.every(({ chains }) => chains.length <= 3)).toBe(true);
  });

  it("obeys maxStores below three", () => {
    const result = calculatePlans(request({ maxStores: 1 }), NOW);

    expect(result).toHaveLength(1);
    expect(result[0]?.chains).toEqual(["extra"]);
  });

  it("excludes stale, historical, and future observations", () => {
    const result = calculatePlans(
      request({
        needs: [needs[0]!],
        matchingRules: [rules[0]!],
        prices: [
          price("7038010000010", "extra", 5_000, 72),
          price("7038010000010", "rema-1000", 100, 73),
          price("7038010000010", "bunnpris", 50, 15 * 24),
          {
            ...price("7038010000010", "bunnpris", 1),
            observedAt: new Date(NOW.getTime() + 1).toISOString(),
          },
        ],
      }),
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.chains).toEqual(["extra"]);
    expect(result[0]?.totalOre).toBe(10_000);
  });

  it("chooses the cheapest candidate and observation with deterministic tie-breaks", () => {
    const flexibleMilk: MatchRule = {
      id: "milk-rule",
      mode: "flexible",
      productFamily: "milk",
      userApproved: true,
      explanation: "Godkjent melkefamilie.",
    };
    const result = calculatePlans(
      request({
        needs: [needs[0]!],
        matchingRules: [flexibleMilk],
        prices: [
          price("7038010000027", "extra", 900, 2),
          price("7038010000027", "extra", 800, 1),
          price("7038010000010", "extra", 800, 1),
        ],
        maxStores: 1,
      }),
      NOW,
    );

    expect(result[0]?.assignments[0]).toMatchObject({
      ean: "7038010000010",
      chain: "extra",
      costOre: 1_600,
      observedAt: "2026-07-15T11:00:00.000Z",
      source: "kassalapp",
    });
    expect(result[0]?.substitutions).toEqual(["milk"]);
  });

  it("does not count an exact assignment as a substitution", () => {
    const result = calculatePlans(
      request({
        needs: [needs[0]!],
        matchingRules: [rules[0]!],
        prices: [price("7038010000010", "extra", 1_000)],
      }),
      NOW,
    );

    expect(result[0]?.substitutions).toEqual([]);
  });

  it("ignores optional needs while completing required coverage", () => {
    const optional: Need = {
      ...needs[1]!,
      id: "optional-bread",
      required: false,
    };
    const result = calculatePlans(
      request({
        needs: [needs[0]!, optional],
        matchingRules: rules,
        prices: [price("7038010000010", "extra", 1_000)],
      }),
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.assignments.map(({ needId }) => needId)).toEqual(["milk"]);
  });

  it("returns no plan for an empty or optional-only basket", () => {
    expect(calculatePlans(request({ needs: [] }), NOW)).toEqual([]);
    expect(calculatePlans(request({ needs: [{ ...needs[0]!, required: false }] }), NOW)).toEqual([]);
  });

  it("fails closed for invalid dates, fractional quantities, and ambiguous IDs", () => {
    const malformedDate = request({
      prices: [{ ...price("7038010000010", "extra", 1_000), observedAt: "invalid" }],
    });
    const fractionalQuantity = request({
      needs: [{ ...needs[0]!, quantity: 1.5 }],
      matchingRules: [rules[0]!],
    });
    const duplicateNeedId = request({ needs: [needs[0]!, { ...needs[1]!, id: needs[0]!.id }] });
    const duplicateRuleId = request({
      matchingRules: [rules[0]!, { ...rules[1]!, id: rules[0]!.id }],
    });

    expect(calculatePlans(malformedDate, NOW)).toEqual([]);
    expect(calculatePlans(fractionalQuantity, NOW)).toEqual([]);
    expect(calculatePlans(duplicateNeedId, NOW)).toEqual([]);
    expect(calculatePlans(duplicateRuleId, NOW)).toEqual([]);
    expect(calculatePlans(request(), new Date("invalid"))).toEqual([]);
  });

  it("retains distinct equal-objective plans, deduplicates identities, and is stable", () => {
    const baseline = request({
      needs: [needs[0]!],
      matchingRules: [rules[0]!],
      prices: [
        price("7038010000010", "extra", 1_000),
        price("7038010000010", "extra", 1_000),
        price("7038010000010", "rema-1000", 1_000),
      ],
    });
    const reordered: PlanRequest = {
      ...baseline,
      needs: [...baseline.needs].reverse(),
      matchingRules: [...baseline.matchingRules].reverse(),
      products: [...baseline.products].reverse(),
      prices: [...baseline.prices].reverse(),
    };

    const first = calculatePlans(baseline, NOW);
    const second = calculatePlans(reordered, NOW);

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(first.map(({ chains }) => chains)).toEqual([["extra"], ["rema-1000"]]);
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
    expect(first.every(({ totalOre, substitutions }) => totalOre === 2_000 && substitutions.length === 0)).toBe(true);
  });

  it("keeps semantic plan IDs stable while refreshing selected provenance", () => {
    const initial = request({
      needs: [needs[0]!], matchingRules: [rules[0]!], maxStores: 1,
      prices: [price("7038010000010", "extra", 1_000, 2)],
    });
    const refreshed = {
      ...initial,
      prices: [price("7038010000010", "extra", 1_000, 1)],
    };

    const [before] = calculatePlans(initial, NOW);
    const [after] = calculatePlans(refreshed, NOW);

    expect(after?.id).toBe(before?.id);
    expect(after?.assignments[0]?.observedAt).toBe("2026-07-15T11:00:00.000Z");
    expect(before?.assignments[0]?.observedAt).toBe("2026-07-15T10:00:00.000Z");
  });
});
