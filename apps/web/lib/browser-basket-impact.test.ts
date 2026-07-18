import { describe, expect, it } from "vitest";

import {
  addReviewedFamilyToBasket,
  browserBasketSchema,
  emptyBasketV3,
  setBasketNeedToExactProduct,
} from "./browser-basket";

const targetProduct = {
  brand: "TINE",
  ean: "7038010000010",
  name: "TINE Lettmelk",
  packageQuantity: 1_000,
  packageUnit: "ml" as const,
  productFamily: "family:melk",
};

function reviewedBasket() {
  const ids = ["need:milk", "rule:milk"];
  const basket = addReviewedFamilyToBasket(emptyBasketV3, {
    candidateCount: 2,
    confirmation: {
      candidateSetId: `candidate-set:${"a".repeat(64)}`,
      taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
      userApproved: true,
    },
    family: {
      aliases: ["mjølk"],
      id: "family:melk",
      labelNo: "Melk",
      slug: "melk",
      status: "active",
    },
    quantity: 3,
  }, () => ids.shift()!);
  return browserBasketSchema.parse({
    ...basket,
    needs: basket.needs.map((need) => ({ ...need, quantityUnit: "ml" as const })),
    products: [targetProduct],
  });
}

describe("Oppdag targeted basket actions", () => {
  it("changes only the target match to exact and preserves need quantity and unit", () => {
    const basket = reviewedBasket();
    const result = setBasketNeedToExactProduct(basket, "need:milk", targetProduct);

    expect(result).not.toBe(basket);
    expect(result.needs).toEqual(basket.needs);
    expect(result.needs[0]).toMatchObject({
      id: "need:milk",
      quantity: 3,
      quantityUnit: "ml",
      required: true,
    });
    expect(result.matchingRules).toEqual([{
      exactEan: targetProduct.ean,
      explanation: "Eksakt produkt valgt i Oppdag",
      id: "rule:milk",
      mode: "exact",
      userApproved: true,
    }]);
    expect(result.familyConfirmations).toEqual([]);
    expect(result.products).toContainEqual(targetProduct);
    expect(browserBasketSchema.safeParse(result).success).toBe(true);
  });

  it("fails closed for an unknown target, an identical exact target, or invalid product", () => {
    const basket = reviewedBasket();
    expect(setBasketNeedToExactProduct(basket, "need:missing", targetProduct)).toBe(basket);
    const exact = setBasketNeedToExactProduct(basket, "need:milk", targetProduct);
    expect(setBasketNeedToExactProduct(exact, "need:milk", targetProduct)).toBe(exact);
    expect(setBasketNeedToExactProduct(
      basket,
      "need:milk",
      { ...targetProduct, ean: "not-a-gtin" },
    )).toBe(basket);
  });

  it("removes an orphaned old exact product while retaining the new exact selection", () => {
    const basket = {
      ...emptyBasketV3,
      matchingRules: [{
        exactEan: "7038010000027",
        explanation: "Eksakt kaffe",
        id: "rule:coffee",
        mode: "exact" as const,
        userApproved: true as const,
      }],
      needs: [{
        id: "need:coffee",
        matchRuleId: "rule:coffee",
        quantity: 2,
        quantityUnit: "each" as const,
        query: "Kaffe",
        required: true as const,
      }],
      products: [{ ean: "7038010000027", name: "Kaffe" }],
    };
    const result = setBasketNeedToExactProduct(basket, "need:coffee", targetProduct);

    expect(result.products.map(({ ean }) => ean)).toEqual([targetProduct.ean]);
    expect(result.needs).toEqual(basket.needs);
  });
});
