import { describe, expect, it } from "vitest";

import {
  BASKET_STORAGE_KEY,
  emptyBasketV1,
  loadBasket,
  saveBasket,
} from "./browser-basket";

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(BASKET_STORAGE_KEY, initial);

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
  version: 1 as const,
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
      exactEan: "7038010000013",
      userApproved: true as const,
      explanation: "Eksakt produkt",
    },
  ],
  products: [
    {
      ean: "7038010000013",
      name: "TINE Lettmelk 1 % 1 l",
      brand: "TINE",
      packageQuantity: 1000,
      packageUnit: "ml" as const,
      productFamily: "lettmelk",
    },
  ],
  travel: { enabled: false, mode: "car" as const },
};

describe("browser basket persistence", () => {
  it("returns a fresh empty version 1 basket when storage is empty", () => {
    const storage = memoryStorage();

    expect(loadBasket(storage)).toEqual(emptyBasketV1);
    expect(loadBasket(storage)).not.toBe(emptyBasketV1);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, needs: [], matchingRules: [], products: [], travel: {} }),
    JSON.stringify({ ...populatedBasket, origin: "Storgata 1" }),
    JSON.stringify({ ...populatedBasket, needs: [{ ...populatedBasket.needs[0], quantity: 0 }] }),
  ])("recovers from corrupt, incompatible, or unsafe state", (value) => {
    expect(loadBasket(memoryStorage(value))).toEqual(emptyBasketV1);
  });

  it("round-trips only the strict safe basket shape and never an origin", () => {
    const storage = memoryStorage();

    saveBasket(populatedBasket, storage);

    expect(loadBasket(storage)).toEqual(populatedBasket);
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toContain("origin");
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

    expect(loadBasket(unavailable)).toEqual(emptyBasketV1);
    expect(() => saveBasket(populatedBasket, unavailable)).not.toThrow();
  });
});
