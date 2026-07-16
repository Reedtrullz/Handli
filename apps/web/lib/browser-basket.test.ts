import { describe, expect, it } from "vitest";

import {
  BASKET_STORAGE_KEY,
  BASKET_STORAGE_MAX_CODE_UNITS,
  DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
  LEGACY_BASKET_STORAGE_KEY,
  BASKET_QUANTITY_MAX,
  BASKET_QUANTITY_MIN,
  addExactProductToBasket,
  emptyBasketV2,
  loadBasket,
  removeBasketNeed,
  saveBasket,
  strictPlanRequestReadiness,
} from "./browser-basket";

function memoryStorage(initial?: string, key = BASKET_STORAGE_KEY): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(key, initial);

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const populatedBasket = {
  version: 2 as const,
  needs: [
    {
      id: "need-1",
      query: "TINE Lettmelk 1 % 1 l",
      quantity: 2,
      quantityUnit: "each" as const,
      matchRuleId: "rule-1",
      required: true,
    },
  ],
  matchingRules: [
    {
      id: "rule-1",
      mode: "exact" as const,
      exactEan: "7038010000010",
      userApproved: true as const,
      explanation: "Eksakt produkt",
    },
  ],
  products: [
    {
      ean: "7038010000010",
      name: "TINE Lettmelk 1 % 1 l",
      brand: "TINE",
      packageQuantity: 1000,
      packageUnit: "ml" as const,
      productFamily: "lettmelk",
    },
  ],
  convenienceWeightBasisPoints: 5_000,
  travel: { enabled: false, mode: "car" as const },
};

describe("browser basket persistence", () => {
  it("projects an approved exact basket onto only the strict public planning contract", () => {
    expect(strictPlanRequestReadiness(populatedBasket)).toEqual({
      state: "ready",
      request: {
        contractVersion: 1,
        maxStores: 3,
        needs: [{
          id: "need-1",
          match: {
            kind: "exact-product",
            product: { kind: "gtin", value: "7038010000010" },
            userApproved: true,
          },
          quantity: 2,
          quantityUnit: "each",
          required: true,
        }],
      },
    });
    const serialized = JSON.stringify(strictPlanRequestReadiness(populatedBasket));
    expect(serialized).not.toMatch(/query|matchingRule|products|productFamily|explanation|travel|origin|TINE/i);
  });

  it.each(["flexible", "constrained"] as const)(
    "requires new exact approval for a %s rule instead of creating a legacy request",
    (mode) => {
      const generic = {
        ...populatedBasket,
        matchingRules: [mode === "flexible"
          ? {
              explanation: "Samme type",
              id: "rule-1",
              mode,
              productFamily: "lettmelk",
              userApproved: true as const,
            }
          : {
              allowedBrands: ["TINE"],
              explanation: "Valgt merke",
              id: "rule-1",
              mode,
              productFamily: "lettmelk",
              userApproved: true as const,
            }],
      };

      expect(strictPlanRequestReadiness(generic)).toEqual({ state: "requires-exact-approval" });
    },
  );

  it("returns a fresh empty version 2 basket when storage is empty", () => {
    const storage = memoryStorage();

    expect(loadBasket(storage)).toEqual(emptyBasketV2);
    expect(loadBasket(storage)).not.toBe(emptyBasketV2);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 3, needs: [], matchingRules: [], products: [], travel: {} }),
    JSON.stringify({ ...populatedBasket, origin: "Storgata 1" }),
    JSON.stringify({ ...populatedBasket, needs: [{ ...populatedBasket.needs[0], quantity: 0 }] }),
  ])("recovers from corrupt, incompatible, or unsafe state", (value) => {
    expect(loadBasket(memoryStorage(value))).toEqual(emptyBasketV2);
  });

  it("rejects overlong user-facing fields before they can reach rendering", () => {
    const stored = JSON.stringify({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], query: "x".repeat(501) }],
    });

    expect(loadBasket(memoryStorage(stored))).toEqual(emptyBasketV2);
  });

  it("drops an oversized stored payload before parsing it", () => {
    const storage = memoryStorage("x".repeat(BASKET_STORAGE_MAX_CODE_UNITS + 1));

    expect(loadBasket(storage)).toEqual(emptyBasketV2);
    expect(storage.getItem(BASKET_STORAGE_KEY)).toBeNull();
  });

  it.each([
    [BASKET_QUANTITY_MIN, true],
    [BASKET_QUANTITY_MAX, true],
    [BASKET_QUANTITY_MIN - 1, false],
    [BASKET_QUANTITY_MAX + 1, false],
  ])("enforces the shared quantity boundary for %s", (quantity, valid) => {
    const stored = JSON.stringify({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], quantity }],
    });

    expect(loadBasket(memoryStorage(stored))).toEqual(valid
      ? { ...populatedBasket, needs: [{ ...populatedBasket.needs[0], quantity }] }
      : emptyBasketV2);
  });

  it.each([
    [
      "duplicate rule IDs",
      {
        ...populatedBasket,
        matchingRules: [
          populatedBasket.matchingRules[0],
          { ...populatedBasket.matchingRules[0] },
        ],
      },
    ],
    [
      "an orphan rule",
      {
        ...populatedBasket,
        matchingRules: [
          populatedBasket.matchingRules[0],
          {
            id: "rule-orphan",
            mode: "flexible",
            productFamily: "ost",
            userApproved: true,
            explanation: "Samme type, valgfritt merke",
          },
        ],
      },
    ],
    [
      "a rule shared by two needs",
      {
        ...populatedBasket,
        needs: [
          populatedBasket.needs[0],
          { ...populatedBasket.needs[0], id: "need-2" },
        ],
      },
    ],
  ])("resets stored state with %s", (_label, basket) => {
    expect(loadBasket(memoryStorage(JSON.stringify(basket)))).toEqual(emptyBasketV2);
  });

  it("round-trips only the strict safe basket shape and never an origin", () => {
    const storage = memoryStorage();

    saveBasket(populatedBasket, storage);

    expect(loadBasket(storage)).toEqual(populatedBasket);
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toContain("origin");
  });

  it("resets a flexible or constrained basket without a stored matching candidate", () => {
    const generic = {
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], query: "havregryn", matchRuleId: "rule-generic" }],
      matchingRules: [{ id: "rule-generic", mode: "flexible" as const, productFamily: "havregryn", userApproved: true as const, explanation: "Samme type" }],
    };
    const constrained = {
      ...generic,
      matchingRules: [{ id: "rule-generic", mode: "constrained" as const, productFamily: "lettmelk", allowedBrands: ["Q"], userApproved: true as const, explanation: "Bare Q" }],
    };

    expect(loadBasket(memoryStorage(JSON.stringify(generic)))).toEqual(emptyBasketV2);
    expect(loadBasket(memoryStorage(JSON.stringify(constrained)))).toEqual(emptyBasketV2);
  });

  it("round-trips only a normalized preference rather than a brittle plan ID", () => {
    const storage = memoryStorage();

    saveBasket({ ...populatedBasket, convenienceWeightBasisPoints: 2_500 }, storage);

    expect(loadBasket(storage)).toEqual({
      ...populatedBasket,
      convenienceWeightBasisPoints: 2_500,
    });
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toContain("selectedPlanId");
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toContain("origin");
  });

  it("adds a discovered product as an exact need, deduplicates it, and retains preference", () => {
    const ids = ["need-discovered", "rule-discovered"];
    const discovered = { ean: "7038010000027", name: "Ny vare", brand: "Test" };
    const basket = addExactProductToBasket(
      { ...populatedBasket, convenienceWeightBasisPoints: 2_500 },
      discovered,
      () => ids.shift()!,
    );

    expect(basket.convenienceWeightBasisPoints).toBe(2_500);
    expect(basket.needs.at(-1)).toMatchObject({ id: "need-discovered", query: "Ny vare", matchRuleId: "rule-discovered" });
    expect(basket.matchingRules.at(-1)).toMatchObject({ mode: "exact", exactEan: discovered.ean });
    expect(basket.products.at(-1)).toEqual(discovered);
    expect(addExactProductToBasket(basket, discovered, () => "unused")).toBe(basket);
  });

  it("fails closed without throwing when browser storage is unavailable or full", () => {
    const unavailable = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    } as unknown as Storage;

    expect(loadBasket(unavailable)).toEqual(emptyBasketV2);
    expect(() => saveBasket(populatedBasket, unavailable)).not.toThrow();
  });

  it("preserves a rule and exact product still referenced by another need during defensive deletion", () => {
    const sharedRuleBasket = {
      ...populatedBasket,
      needs: [
        populatedBasket.needs[0],
        { ...populatedBasket.needs[0], id: "need-2" },
      ],
    };

    expect(removeBasketNeed(sharedRuleBasket, "need-1")).toEqual({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], id: "need-2" }],
    });
  });

  it("retains a product matched by a remaining flexible need after its exact need is removed", () => {
    const basket = {
      ...populatedBasket,
      needs: [
        populatedBasket.needs[0],
        { ...populatedBasket.needs[0], id: "need-generic", query: "lettmelk", matchRuleId: "rule-generic" },
      ],
      matchingRules: [
        populatedBasket.matchingRules[0],
        { id: "rule-generic", mode: "flexible" as const, productFamily: "lettmelk", userApproved: true as const, explanation: "Samme type" },
      ],
    };

    expect(removeBasketNeed(basket, "need-1").products).toEqual(populatedBasket.products);
  });

  it("migrates a valid v1 basket once, drops its plan ID, and preserves local-only settings", () => {
    const legacy = {
      ...populatedBasket,
      version: 1,
      selectedPlanId: "plan-from-old-price-snapshot",
    };
    const { convenienceWeightBasisPoints: _preference, ...withoutV2Preference } = legacy;
    void _preference;
    const storage = memoryStorage(
      JSON.stringify(withoutV2Preference),
      LEGACY_BASKET_STORAGE_KEY,
    );

    expect(loadBasket(storage)).toEqual({
      ...populatedBasket,
      convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
    });
    expect(storage.getItem(LEGACY_BASKET_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toContain("selectedPlanId");
  });
});
