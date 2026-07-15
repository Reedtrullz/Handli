import { describe, expect, it } from "vitest";

import {
  matchRuleSchema,
  needSchema,
  planRequestSchema,
  priceObservationSchema,
} from "./index";

const validNeed = {
  id: "need-milk",
  query: "melk",
  quantity: 1,
  quantityUnit: "each" as const,
  matchRuleId: "rule-milk",
  required: true,
};

const validRule = {
  id: "rule-milk",
  mode: "exact" as const,
  exactEan: "7038010000010",
  userApproved: true,
  explanation: "Bruk varen brukeren valgte.",
};

const validProduct = {
  ean: "7038010000010",
  name: "Helmelk",
  packageQuantity: 1_000,
  packageUnit: "ml" as const,
};

const validPrice = {
  ean: "7038010000010",
  chain: "rema-1000" as const,
  amountOre: 2_490,
  observedAt: "2026-07-15T10:00:00.000Z",
  source: "kassalapp" as const,
};

const validRequest = {
  needs: [validNeed],
  matchingRules: [validRule],
  products: [validProduct],
  prices: [validPrice],
  maxStores: 2,
};

describe("domain schemas", () => {
  it("rejects a need with zero quantity", () => {
    expect(needSchema.safeParse({ ...validNeed, quantity: 0 }).success).toBe(false);
  });

  it("rejects a request allowing more than three stores", () => {
    expect(planRequestSchema.safeParse({ ...validRequest, maxStores: 4 }).success).toBe(false);
  });

  it("rejects an unapproved flexible matching rule", () => {
    expect(
      matchRuleSchema.safeParse({
        ...validRule,
        mode: "flexible",
        exactEan: undefined,
        productFamily: "milk",
        userApproved: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a negative observed price", () => {
    expect(
      priceObservationSchema.safeParse({ ...validPrice, amountOre: -1 }).success,
    ).toBe(false);
  });

  it("rejects an invalid EAN", () => {
    expect(
      priceObservationSchema.safeParse({ ...validPrice, ean: "not-an-ean" }).success,
    ).toBe(false);
  });
});
