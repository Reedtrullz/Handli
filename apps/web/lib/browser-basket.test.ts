import { describe, expect, it } from "vitest";

import {
  BASKET_STORAGE_KEY,
  BASKET_STORAGE_MAX_CODE_UNITS,
  BASKET_MEASURE_QUANTITY_MAX,
  DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
  LEGACY_BASKET_STORAGE_KEY,
  LEGACY_BASKET_V2_STORAGE_KEY,
  LEGACY_BASKET_V3_STORAGE_KEY,
  BASKET_QUANTITY_MAX,
  BASKET_QUANTITY_MIN,
  addExactProductToBasket,
  addReviewedFamilyToBasket,
  browserBasketSchema,
  emptyBasketV3,
  loadBasket,
  removeBasketNeed,
  saveBasket,
  setBasketEnabledMembershipProgramIds,
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
  version: 4 as const,
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
  enabledMembershipProgramIds: [],
  familyConfirmations: [],
  marketContext: {
    contractVersion: 1 as const,
    countryCode: "NO" as const,
    kind: "national" as const,
  },
  travel: { enabled: false, mode: "car" as const },
};

describe("browser basket persistence", () => {
  it("projects an approved exact basket onto only the strict public planning contract", () => {
    expect(strictPlanRequestReadiness(populatedBasket)).toEqual({
      state: "ready",
      request: {
        contractVersion: 1,
        enabledMembershipProgramIds: [],
        marketContext: populatedBasket.marketContext,
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

  it("round-trips and projects canonical piece, package, gram, and millilitre needs", () => {
    for (const [quantity, quantityUnit] of [
      [2, "piece"],
      [3, "package"],
      [1_000, "g"],
      [1_500, "ml"],
    ] as const) {
      const candidate = {
        ...populatedBasket,
        needs: [{ ...populatedBasket.needs[0], quantity, quantityUnit }],
      };
      const storage = memoryStorage();

      saveBasket(candidate, storage);

      expect(loadBasket(storage)).toEqual(candidate);
      expect(strictPlanRequestReadiness(candidate)).toMatchObject({
        state: "ready",
        request: { needs: [{ quantity, quantityUnit }] },
      });
    }
  });

  it("keeps count and metric overflow bounds separate in local state", () => {
    expect(browserBasketSchema.safeParse({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], quantity: 1_500, quantityUnit: "ml" }],
    }).success).toBe(true);
    expect(browserBasketSchema.safeParse({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], quantity: BASKET_QUANTITY_MAX + 1, quantityUnit: "package" }],
    }).success).toBe(false);
    expect(browserBasketSchema.safeParse({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], quantity: BASKET_MEASURE_QUANTITY_MAX + 1, quantityUnit: "g" }],
    }).success).toBe(false);
  });

  it.each(["flexible", "constrained"] as const)(
    "requires reviewed approval for a legacy %s rule instead of creating a request",
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

      expect(strictPlanRequestReadiness(generic)).toEqual({ state: "requires-reviewed-approval" });
    },
  );

  it("projects a confirmed reviewed family and exact product onto contract v2 only", () => {
    const ids = ["need-family", "rule-family"];
    const basket = addReviewedFamilyToBasket(populatedBasket, {
      candidateCount: 2,
      confirmation: {
        candidateSetId: `candidate-set:${"a".repeat(64)}`,
        taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
        userApproved: true,
      },
      family: {
        aliases: ["brød"],
        id: "family:brod",
        labelNo: "Brød",
        slug: "brod",
        status: "active",
      },
      quantity: 1_000,
      quantityUnit: "g",
    }, () => ids.shift()!);

    expect(strictPlanRequestReadiness(basket)).toEqual({
      state: "ready",
      request: {
        contractVersion: 2,
        enabledMembershipProgramIds: [],
        marketContext: populatedBasket.marketContext,
        maxStores: 3,
        needs: [
          {
            id: "need-1",
            match: {
              kind: "exact-product",
              product: { kind: "gtin", value: "7038010000010" },
              userApproved: true,
            },
            quantity: 2,
            quantityUnit: "each",
            required: true,
          },
          {
            id: "need-family",
            match: {
              confirmation: {
                candidateSetId: `candidate-set:${"a".repeat(64)}`,
                taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
                userApproved: true,
              },
              familyId: "family:brod",
              kind: "reviewed-family",
            },
            quantity: 1_000,
            quantityUnit: "g",
            required: true,
          },
        ],
      },
    });
    const serialized = JSON.stringify(strictPlanRequestReadiness(basket));
    expect(serialized).not.toMatch(/Brød|brød|query|matchingRules|products|explanation|travel|origin|TINE/);
  });

  it("fails closed when a reviewed-family confirmation is missing or does not bind its rule", () => {
    const ids = ["need-family", "rule-family"];
    const basket = addReviewedFamilyToBasket(emptyBasketV3, {
      candidateCount: 1,
      confirmation: {
        candidateSetId: `candidate-set:${"b".repeat(64)}`,
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
      quantity: 1,
    }, () => ids.shift()!);

    expect(strictPlanRequestReadiness({ ...basket, familyConfirmations: [] }))
      .toEqual({ state: "requires-reviewed-approval" });
    expect(loadBasket(memoryStorage(JSON.stringify({
      ...basket,
      familyConfirmations: [{
        ...basket.familyConfirmations[0],
        matchRuleId: "forged-rule",
      }],
    })))).toEqual(emptyBasketV3);
  });

  it("returns a fresh empty version 4 basket when storage is empty", () => {
    const storage = memoryStorage();

    expect(loadBasket(storage)).toEqual(emptyBasketV3);
    expect(loadBasket(storage)).not.toBe(emptyBasketV3);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 4, needs: [], matchingRules: [], products: [], travel: {} }),
    JSON.stringify({ ...populatedBasket, origin: "Storgata 1" }),
    JSON.stringify({ ...populatedBasket, needs: [{ ...populatedBasket.needs[0], quantity: 0 }] }),
  ])("recovers from corrupt, incompatible, or unsafe state", (value) => {
    expect(loadBasket(memoryStorage(value))).toEqual(emptyBasketV3);
  });

  it("rejects overlong user-facing fields before they can reach rendering", () => {
    const stored = JSON.stringify({
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], query: "x".repeat(501) }],
    });

    expect(loadBasket(memoryStorage(stored))).toEqual(emptyBasketV3);
  });

  it("drops an oversized stored payload before parsing it", () => {
    const storage = memoryStorage("x".repeat(BASKET_STORAGE_MAX_CODE_UNITS + 1));

    expect(loadBasket(storage)).toEqual(emptyBasketV3);
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
      : emptyBasketV3);
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
    expect(loadBasket(memoryStorage(JSON.stringify(basket)))).toEqual(emptyBasketV3);
  });

  it("round-trips only the strict safe basket shape and never an origin", () => {
    const storage = memoryStorage();

    saveBasket(populatedBasket, storage);

    expect(loadBasket(storage)).toEqual(populatedBasket);
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toContain("origin");
  });

  it("defaults an older same-key v4 basket to no enabled memberships", () => {
    const {
      enabledMembershipProgramIds: _memberships,
      ...olderV4
    } = populatedBasket;
    void _memberships;

    expect(loadBasket(memoryStorage(JSON.stringify(olderV4)))).toEqual(populatedBasket);
  });

  it("persists only canonical membership IDs and projects them into planning", () => {
    const selected = setBasketEnabledMembershipProgramIds(
      populatedBasket,
      ["coop-medlem", "trumf"],
    );

    expect(selected.enabledMembershipProgramIds).toEqual(["coop-medlem", "trumf"]);
    expect(setBasketEnabledMembershipProgramIds(selected, ["coop-medlem", "trumf"]))
      .toBe(selected);
    expect(setBasketEnabledMembershipProgramIds(selected, ["trumf", "coop-medlem"]))
      .toBe(selected);
    expect(setBasketEnabledMembershipProgramIds(selected, ["trumf", "trumf"]))
      .toBe(selected);
    expect(setBasketEnabledMembershipProgramIds(selected, [" trumf"]))
      .toBe(selected);
    expect(strictPlanRequestReadiness(selected)).toMatchObject({
      state: "ready",
      request: { enabledMembershipProgramIds: ["coop-medlem", "trumf"] },
    });

    const storage = memoryStorage();
    saveBasket(selected, storage);
    expect(loadBasket(storage).enabledMembershipProgramIds)
      .toEqual(["coop-medlem", "trumf"]);
  });

  it("retains an old flexible or constrained choice but never plans without reviewed confirmation", () => {
    const generic = {
      ...populatedBasket,
      needs: [{ ...populatedBasket.needs[0], query: "havregryn", matchRuleId: "rule-generic" }],
      matchingRules: [{ id: "rule-generic", mode: "flexible" as const, productFamily: "havregryn", userApproved: true as const, explanation: "Samme type" }],
    };
    const constrained = {
      ...generic,
      matchingRules: [{ id: "rule-generic", mode: "constrained" as const, productFamily: "lettmelk", allowedBrands: ["Q"], userApproved: true as const, explanation: "Bare Q" }],
    };

    expect(strictPlanRequestReadiness(loadBasket(memoryStorage(JSON.stringify(generic)))))
      .toEqual({ state: "requires-reviewed-approval" });
    expect(strictPlanRequestReadiness(loadBasket(memoryStorage(JSON.stringify(constrained)))))
      .toEqual({ state: "requires-reviewed-approval" });
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
    expect(basket.needs.at(-1)).toMatchObject({
      id: "need-discovered",
      query: "Ny vare",
      matchRuleId: "rule-discovered",
      quantity: 1,
      quantityUnit: "package",
    });
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

    expect(loadBasket(unavailable)).toEqual(emptyBasketV3);
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
    const {
      convenienceWeightBasisPoints: _preference,
      enabledMembershipProgramIds: _memberships,
      familyConfirmations: _confirmations,
      marketContext: _marketContext,
      ...withoutV2Preference
    } = legacy;
    void _preference;
    void _memberships;
    void _confirmations;
    void _marketContext;
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

  it("migrates a valid exact v2 basket losslessly and removes the old key", () => {
    const {
      familyConfirmations: _confirmations,
      enabledMembershipProgramIds: _memberships,
      marketContext: _marketContext,
      ...legacyV2
    } = { ...populatedBasket, version: 2 as const };
    void _confirmations;
    void _memberships;
    void _marketContext;
    const storage = memoryStorage(
      JSON.stringify(legacyV2),
      LEGACY_BASKET_V2_STORAGE_KEY,
    );

    expect(loadBasket(storage)).toEqual(populatedBasket);
    expect(storage.getItem(LEGACY_BASKET_V2_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toBeNull();
  });

  it("migrates a valid v3 basket to the explicit national market", () => {
    const {
      enabledMembershipProgramIds: _memberships,
      marketContext: _marketContext,
      ...legacyV3
    } = {
      ...populatedBasket,
      version: 3 as const,
    };
    void _marketContext;
    void _memberships;
    const storage = memoryStorage(
      JSON.stringify(legacyV3),
      LEGACY_BASKET_V3_STORAGE_KEY,
    );

    expect(loadBasket(storage)).toEqual(populatedBasket);
    expect(storage.getItem(LEGACY_BASKET_V3_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(BASKET_STORAGE_KEY)).not.toBeNull();
  });

  it("preserves v4 basket contents but blocks planning when a stored market is stale", () => {
    const stale = {
      ...populatedBasket,
      marketContext: {
        contractVersion: 1,
        countryCode: "NO",
        kind: "launch-region",
        regionId: "no-9999-no-longer-launched",
      },
    };

    const loaded = loadBasket(memoryStorage(JSON.stringify(stale)));
    expect(loaded).toEqual({ ...populatedBasket, marketContext: null });
    expect(loaded.needs).toEqual(populatedBasket.needs);
    expect(loaded.products).toEqual(populatedBasket.products);
    expect(strictPlanRequestReadiness(loaded)).toEqual({
      state: "requires-market-selection",
    });
  });
});
