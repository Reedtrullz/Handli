import { describe, expect, it } from "vitest";

import {
  BASKET_COUNT_QUANTITY_MAX,
  BASKET_MEASURE_QUANTITY_MAX,
  basketQuantityAmountAfterUnitChange,
  basketQuantityCopy,
  basketQuantityDraft,
  isValidBasketQuantity,
  parseBasketQuantityInput,
} from "./basket-quantity";

describe("browser basket quantity contract", () => {
  it.each([
    ["1", "kg", { quantity: 1_000, quantityUnit: "g" }],
    ["1,5", "l", { quantity: 1_500, quantityUnit: "ml" }],
    ["1.025", "kg", { quantity: 1_025, quantityUnit: "g" }],
    ["750", "g", { quantity: 750, quantityUnit: "g" }],
    ["2", "piece", { quantity: 2, quantityUnit: "piece" }],
    ["3", "package", { quantity: 3, quantityUnit: "package" }],
  ] as const)("converts %s %s exactly into canonical base units", (amount, unit, expected) => {
    expect(parseBasketQuantityInput(amount, unit)).toEqual(expected);
  });

  it.each([
    ["1,5", "g"],
    ["1.000,5", "kg"],
    ["1,0005", "l"],
    ["0", "package"],
    [String(BASKET_COUNT_QUANTITY_MAX + 1), "piece"],
    [String(BASKET_MEASURE_QUANTITY_MAX + 1), "ml"],
  ] as const)("rejects ambiguous, fractional-base, zero, or oversized input %s %s", (amount, unit) => {
    expect(parseBasketQuantityInput(amount, unit)).toBeUndefined();
  });

  it("round-trips exact metric displays and labels legacy each truthfully", () => {
    expect(basketQuantityDraft(1_500, "ml")).toEqual({
      amount: "1,5",
      inputUnit: "l",
      legacyEach: false,
    });
    expect(parseBasketQuantityInput("1,5", "l")).toEqual({
      quantity: 1_500,
      quantityUnit: "ml",
    });
    expect(basketQuantityDraft(2, "each")).toEqual({
      amount: "2",
      inputUnit: "package",
      legacyEach: true,
    });
    expect(basketQuantityCopy(1_000, "g")).toBe("1 kg");
  });

  it.each([
    ["1", "kg", "g", "1000"],
    ["500", "g", "kg", "0,5"],
    ["1,5", "l", "ml", "1500"],
    ["750", "ml", "l", "0,75"],
  ] as const)(
    "preserves the physical amount when changing %s %s to %s",
    (amount, currentUnit, nextUnit, expectedAmount) => {
      expect(basketQuantityAmountAfterUnitChange(amount, currentUnit, nextUnit))
        .toBe(expectedAmount);
      expect(parseBasketQuantityInput(expectedAmount, nextUnit))
        .toEqual(parseBasketQuantityInput(amount, currentUnit));
    },
  );

  it("keeps the whole count when deliberately changing packages to pieces", () => {
    expect(basketQuantityAmountAfterUnitChange("3", "package", "piece")).toBe("3");
    expect(parseBasketQuantityInput("3", "package")).toEqual({
      quantity: 3,
      quantityUnit: "package",
    });
    expect(parseBasketQuantityInput("3", "piece")).toEqual({
      quantity: 3,
      quantityUnit: "piece",
    });
  });

  it("keeps count and metric bounds distinct", () => {
    expect(isValidBasketQuantity(BASKET_COUNT_QUANTITY_MAX, "package")).toBe(true);
    expect(isValidBasketQuantity(BASKET_COUNT_QUANTITY_MAX + 1, "package")).toBe(false);
    expect(isValidBasketQuantity(1_500, "ml")).toBe(true);
    expect(isValidBasketQuantity(BASKET_MEASURE_QUANTITY_MAX + 1, "g")).toBe(false);
  });
});
