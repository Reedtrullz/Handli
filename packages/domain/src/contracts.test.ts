import { describe, expect, it } from "vitest";

import {
  matchRuleSchema,
  needSchema,
  planRequestSchema,
  planResultSchema,
  priceObservationSchema,
  sourceNeutralPlanRequestSchema,
  sourceNeutralPlanResultSchema,
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

const validPlanResult = {
  id: "plan-one",
  assignments: [],
  totalOre: 0,
  chains: ["rema-1000"] as const,
  substitutions: [],
  coverage: 1 as const,
  freshness: {},
};

describe("domain schemas", () => {
  it("rejects a need with zero quantity", () => {
    expect(needSchema.safeParse({ ...validNeed, quantity: 0 }).success).toBe(false);
  });

  it("rejects a request allowing more than three stores", () => {
    expect(planRequestSchema.safeParse({ ...validRequest, maxStores: 4 }).success).toBe(false);
  });

  it("keeps legacy plan schemas Kassalapp-only while neutral schemas accept registered sources", () => {
    const neutralPrice = { ...validPrice, source: "licensed-retailer-feed" };
    const neutralRequest = { ...validRequest, prices: [neutralPrice] };
    const neutralResult = {
      ...validPlanResult,
      assignments: [
        {
          needId: validNeed.id,
          ean: validProduct.ean,
          chain: validPrice.chain,
          quantity: 1,
          costOre: validPrice.amountOre,
          observedAt: validPrice.observedAt,
          source: neutralPrice.source,
        },
      ],
    };

    expect(sourceNeutralPlanRequestSchema.safeParse(neutralRequest).success).toBe(true);
    expect(planRequestSchema.safeParse(neutralRequest).success).toBe(false);
    expect(sourceNeutralPlanResultSchema.safeParse(neutralResult).success).toBe(true);
    expect(planResultSchema.safeParse(neutralResult).success).toBe(false);
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

  it.each(["exact", "constrained"] as const)(
    "rejects an unapproved %s matching rule",
    (mode) => {
      const modeFields =
        mode === "exact"
          ? { exactEan: validRule.exactEan }
          : { productFamily: "milk" };

      expect(
        matchRuleSchema.safeParse({
          id: `rule-${mode}`,
          mode,
          ...modeFields,
          userApproved: false,
          explanation: "Ikke godkjent.",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects an exact rule without an EAN", () => {
    expect(
      matchRuleSchema.safeParse({
        id: "rule-exact",
        mode: "exact",
        userApproved: true,
        explanation: "Mangler EAN.",
      }).success,
    ).toBe(false);
  });

  it("rejects an exact rule with constrained-only fields", () => {
    expect(
      matchRuleSchema.safeParse({
        ...validRule,
        productFamily: "milk",
      }).success,
    ).toBe(false);
  });

  it("rejects a constrained rule without a meaningful constraint", () => {
    expect(
      matchRuleSchema.safeParse({
        id: "rule-constrained",
        mode: "constrained",
        userApproved: true,
        explanation: "Mangler begrensning.",
      }).success,
    ).toBe(false);
  });

  it("does not treat an empty brand list as a meaningful constraint", () => {
    expect(
      matchRuleSchema.safeParse({
        id: "rule-constrained",
        mode: "constrained",
        allowedBrands: [],
        userApproved: true,
        explanation: "Tom merkeliste.",
      }).success,
    ).toBe(false);
  });

  it("rejects a constrained rule with an exact EAN", () => {
    expect(
      matchRuleSchema.safeParse({
        ...validRule,
        mode: "constrained",
        productFamily: "milk",
      }).success,
    ).toBe(false);
  });

  it("requires a product family for flexible matching", () => {
    expect(
      matchRuleSchema.safeParse({
        id: "rule-flexible",
        mode: "flexible",
        userApproved: true,
        explanation: "Mangler varefamilie.",
      }).success,
    ).toBe(false);
  });

  it("rejects constrained-only fields on a flexible rule", () => {
    expect(
      matchRuleSchema.safeParse({
        id: "rule-flexible",
        mode: "flexible",
        productFamily: "milk",
        allowedBrands: ["Tine"],
        userApproved: true,
        explanation: "For vid struktur.",
      }).success,
    ).toBe(false);
  });

  it("accepts explicit approved exact, constrained, and flexible rules", () => {
    const rules = [
      validRule,
      {
        id: "rule-constrained",
        mode: "constrained",
        allowedBrands: ["Tine"],
        userApproved: true,
        explanation: "Godkjent merke.",
      },
      {
        id: "rule-flexible",
        mode: "flexible",
        productFamily: "milk",
        userApproved: true,
        explanation: "Godkjent varefamilie.",
      },
    ];

    expect(rules.every((rule) => matchRuleSchema.safeParse(rule).success)).toBe(true);
  });

  it("rejects a plan result with more than three chain entries", () => {
    expect(
      planResultSchema.safeParse({
        ...validPlanResult,
        chains: ["bunnpris", "rema-1000", "extra", "bunnpris"],
      }).success,
    ).toBe(false);
  });

  it("rejects a plan result with duplicate chains", () => {
    expect(
      planResultSchema.safeParse({
        ...validPlanResult,
        chains: ["extra", "extra"],
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

  it("accepts only canonical millisecond UTC observation timestamps", () => {
    expect(priceObservationSchema.safeParse(validPrice).success).toBe(true);

    for (const observedAt of [
      "2026-07-15T10:00:00Z",
      "2026-07-15T10:00:00.0Z",
      "2026-07-15T10:00:00.000000Z",
      "2026-07-15T12:00:00.000+02:00",
      "2026-07-15T10:00:00.000z",
    ]) {
      expect(
        priceObservationSchema.safeParse({ ...validPrice, observedAt }).success,
        observedAt,
      ).toBe(false);
    }
  });
});
