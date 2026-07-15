import { describe, expect, it } from "vitest";

import type { MatchRule, Need, Product } from "./contracts";
import { matchProducts } from "./index";

const need: Need = {
  id: "need-milk",
  query: "melk",
  quantity: 2,
  quantityUnit: "each",
  matchRuleId: "rule-milk",
  required: true,
};

const products: Product[] = [
  {
    ean: "7038010000010",
    name: "Tine lettmelk 1 l",
    brand: "Tine",
    packageQuantity: 1_000,
    packageUnit: "ml",
    productFamily: "milk",
  },
  {
    ean: "7038010000027",
    name: "Q lettmelk 1 l",
    brand: "Q",
    packageQuantity: 1_000,
    packageUnit: "ml",
    productFamily: "milk",
  },
  {
    ean: "7038010000034",
    name: "Tine lettmelk 500 ml",
    brand: "Tine",
    packageQuantity: 500,
    packageUnit: "ml",
    productFamily: "milk",
  },
  {
    ean: "7038010000041",
    name: "Tine yoghurt 1 l",
    brand: "Tine",
    packageQuantity: 1_000,
    packageUnit: "ml",
    productFamily: "yoghurt",
  },
];

const baseRule = {
  id: "rule-milk",
  userApproved: true,
  explanation: "Godkjent av brukeren.",
} as const;

describe("matchProducts", () => {
  it("matches an exact rule by EAN only and removes duplicate products", () => {
    const rule: MatchRule = {
      ...baseRule,
      mode: "exact",
      exactEan: "7038010000027",
    };

    expect(matchProducts(need, rule, [...products, products[1]!]).map(({ ean }) => ean)).toEqual([
      rule.exactEan,
    ]);
  });

  it("requires every constrained brand, family, size, and unit condition", () => {
    const rule: MatchRule = {
      ...baseRule,
      mode: "constrained",
      productFamily: "MILK",
      allowedBrands: ["tine"],
      sizeRange: { min: 750, max: 1_250, unit: "ml" },
    };

    expect(matchProducts(need, rule, products).map(({ ean }) => ean)).toEqual([
      "7038010000010",
    ]);
  });

  it("matches a flexible rule only within its approved product family", () => {
    const rule: MatchRule = {
      ...baseRule,
      mode: "flexible",
      productFamily: "milk",
    };

    expect(matchProducts(need, rule, products).map(({ ean }) => ean)).toEqual([
      "7038010000010",
      "7038010000027",
      "7038010000034",
    ]);
  });

  it.each(["exact", "constrained", "flexible"] as const)(
    "fails closed for an unapproved %s rule",
    (mode) => {
      const rule = {
        ...baseRule,
        mode,
        exactEan: mode === "exact" ? "7038010000010" : undefined,
        productFamily: mode === "exact" ? undefined : "milk",
        userApproved: false,
      } as MatchRule;

      expect(matchProducts(need, rule, products)).toEqual([]);
    },
  );

  it("fails closed for a constrained rule without a constraint", () => {
    const malformedRule = {
      ...baseRule,
      mode: "constrained",
    } as MatchRule;

    expect(matchProducts(need, malformedRule, products)).toEqual([]);
  });

  it("returns matches in stable EAN order independent of product input order", () => {
    const rule: MatchRule = {
      ...baseRule,
      mode: "flexible",
      productFamily: "milk",
    };

    expect(matchProducts(need, rule, [...products].reverse())).toEqual(
      matchProducts(need, rule, products),
    );
  });
});
