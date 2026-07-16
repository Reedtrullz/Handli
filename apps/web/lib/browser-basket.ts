import {
  exactProductPlanApiRequestSchema,
  matchProducts,
  matchRuleSchema,
  type ExactProductPlanApiRequest,
  type MatchRule,
  type Need,
  type Product,
} from "@handleplan/domain";
import { z } from "zod";

export const LEGACY_BASKET_STORAGE_KEY = "handleplan:basket:v1";
export const BASKET_STORAGE_KEY = "handleplan:basket:v2";
export const BASKET_QUANTITY_MIN = 1;
export const BASKET_QUANTITY_MAX = 999;
export const BASKET_NEEDS_MAX = 50;
export const SELECTED_PLAN_ID_MAX = 200;
export const BASKET_STORAGE_MAX_CODE_UNITS = 256 * 1024;
export const DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS = 5_000;

const browserNeedSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    query: z.string().trim().min(1).max(500),
    quantity: z.number().int().min(BASKET_QUANTITY_MIN).max(BASKET_QUANTITY_MAX).safe(),
    quantityUnit: z.enum(["each", "g", "ml"]),
    matchRuleId: z.string().trim().min(1).max(200),
    required: z.boolean(),
  })
  .strict();

const browserProductSchema = z
  .object({
    ean: z.string().regex(/^(?:\d{8}|\d{13})$/),
    name: z.string().trim().min(1).max(500),
    brand: z.string().trim().min(1).max(200).optional(),
    packageQuantity: z.number().positive().optional(),
    packageUnit: z.enum(["g", "ml", "each"]).optional(),
    productFamily: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const browserMatchRuleSchema = matchRuleSchema.superRefine((rule, context) => {
  if (rule.id.length > 200 || rule.explanation.length > 500) {
    context.addIssue({ code: "custom", message: "Matching-rule text is too long" });
  }
  if (
    rule.mode !== "exact"
    && rule.productFamily !== undefined
    && rule.productFamily.length > 200
  ) {
    context.addIssue({ code: "custom", message: "Product family is too long" });
  }
  if (
    rule.mode === "constrained"
    && (rule.allowedBrands ?? []).some((brand) => brand.length > 200)
  ) {
    context.addIssue({ code: "custom", message: "Allowed brand is too long" });
  }
  if (rule.mode === "constrained" && (rule.allowedBrands?.length ?? 0) > 20) {
    context.addIssue({ code: "custom", message: "Too many allowed brands" });
  }
});

const basketContentsShape = {
  needs: z.array(browserNeedSchema).max(BASKET_NEEDS_MAX),
  matchingRules: z.array(browserMatchRuleSchema).max(BASKET_NEEDS_MAX),
  products: z.array(browserProductSchema).max(200),
  travel: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(["car", "bike"]),
    })
    .strict(),
};

type BasketContents = {
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
};

function validateBasketRelationships(
  { needs, matchingRules, products }: BasketContents,
  context: z.RefinementCtx,
): void {
    const ruleIds = new Set<string>();
    const ruleUsage = new Map<string, number>();
    const productEans = new Set(products.map(({ ean }) => ean));
    const ids = new Set<string>();

    for (const rule of matchingRules) {
      if (ruleIds.has(rule.id)) {
        context.addIssue({ code: "custom", message: "Matching rule IDs must be unique" });
      }
      ruleIds.add(rule.id);
      ruleUsage.set(rule.id, 0);
    }

    for (const need of needs) {
      if (ids.has(need.id)) {
        context.addIssue({ code: "custom", message: "Need IDs must be unique" });
      }
      ids.add(need.id);
      if (!ruleIds.has(need.matchRuleId)) {
        context.addIssue({ code: "custom", message: "Need must reference an approved rule" });
      } else {
        ruleUsage.set(need.matchRuleId, (ruleUsage.get(need.matchRuleId) ?? 0) + 1);
      }
    }

    const rulesById = new Map(matchingRules.map((rule) => [rule.id, rule]));
    for (const need of needs) {
      const rule = rulesById.get(need.matchRuleId);
      if (
        rule !== undefined &&
        rule.mode !== "exact" &&
        matchProducts(need, rule, products).length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Generic rules must retain at least one matching catalog candidate",
        });
      }
    }

    for (const rule of matchingRules) {
      if (ruleUsage.get(rule.id) !== 1) {
        context.addIssue({
          code: "custom",
          message: "Every matching rule must be referenced by exactly one need",
        });
      }
      if (rule.mode === "exact" && (!rule.exactEan || !productEans.has(rule.exactEan))) {
        context.addIssue({ code: "custom", message: "Exact rules must reference a stored product" });
      }
    }
}

const legacyBrowserBasketSchema = z
  .object({
    version: z.literal(1),
    ...basketContentsShape,
    selectedPlanId: z.string().min(1).max(SELECTED_PLAN_ID_MAX).optional(),
  })
  .strict()
  .superRefine(validateBasketRelationships);

export const browserBasketSchema = z
  .object({
    version: z.literal(2),
    ...basketContentsShape,
    convenienceWeightBasisPoints: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine(validateBasketRelationships);

export interface BrowserBasket {
  version: 2;
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
  convenienceWeightBasisPoints: number;
  travel: { enabled: boolean; mode: "car" | "bike" };
}

export type StrictPlanRequestReadiness =
  | { state: "empty" }
  | { state: "requires-exact-approval" }
  | { state: "ready"; request: ExactProductPlanApiRequest };

/**
 * Projects the local editing model onto the deliberately narrow public
 * planning contract. Browser-owned names, queries, product metadata and
 * matching-rule explanations must never cross this boundary.
 */
export function strictPlanRequestReadiness(
  basket: BrowserBasket,
): StrictPlanRequestReadiness {
  if (basket.needs.length === 0) return { state: "empty" };

  const rulesById = new Map(basket.matchingRules.map((rule) => [rule.id, rule]));
  const needs: ExactProductPlanApiRequest["needs"] = [];
  for (const need of basket.needs) {
    const rule = rulesById.get(need.matchRuleId);
    if (
      !need.required
      || rule?.mode !== "exact"
      || rule.userApproved !== true
      || rule.exactEan === undefined
    ) {
      return { state: "requires-exact-approval" };
    }
    needs.push({
      id: need.id,
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: rule.exactEan },
        userApproved: true,
      },
      quantity: need.quantity,
      quantityUnit: need.quantityUnit,
      required: true,
    });
  }

  const parsed = exactProductPlanApiRequestSchema.safeParse({
    contractVersion: 1,
    maxStores: 3,
    needs,
  });
  return parsed.success
    ? { state: "ready", request: parsed.data }
    : { state: "requires-exact-approval" };
}

export const emptyBasketV2: BrowserBasket = {
  version: 2,
  needs: [],
  matchingRules: [],
  products: [],
  convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
  travel: { enabled: false, mode: "car" },
};

function freshEmptyBasket(): BrowserBasket {
  return {
    version: 2,
    needs: [],
    matchingRules: [],
    products: [],
    convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
    travel: { enabled: false, mode: "car" },
  };
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadBasket(storage: Storage | undefined = defaultStorage()): BrowserBasket {
  if (!storage) return freshEmptyBasket();

  try {
    const stored = storage.getItem(BASKET_STORAGE_KEY);
    if (stored) {
      if (stored.length > BASKET_STORAGE_MAX_CODE_UNITS) {
        storage.removeItem(BASKET_STORAGE_KEY);
        return freshEmptyBasket();
      }
      const parsed = browserBasketSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : freshEmptyBasket();
    }

    const legacyStored = storage.getItem(LEGACY_BASKET_STORAGE_KEY);
    if (!legacyStored) return freshEmptyBasket();
    if (legacyStored.length > BASKET_STORAGE_MAX_CODE_UNITS) {
      storage.removeItem(LEGACY_BASKET_STORAGE_KEY);
      return freshEmptyBasket();
    }
    const legacy = legacyBrowserBasketSchema.safeParse(JSON.parse(legacyStored));
    if (!legacy.success) return freshEmptyBasket();
    const migrated: BrowserBasket = {
      version: 2,
      needs: legacy.data.needs,
      matchingRules: legacy.data.matchingRules,
      products: legacy.data.products,
      convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
      travel: legacy.data.travel,
    };
    saveBasket(migrated, storage);
    return migrated;
  } catch {
    return freshEmptyBasket();
  }
}

export function saveBasket(
  basket: BrowserBasket,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;

  try {
    const safeBasket = browserBasketSchema.parse(basket);
    const serialized = JSON.stringify(safeBasket);
    if (serialized.length > BASKET_STORAGE_MAX_CODE_UNITS) return;
    storage.setItem(BASKET_STORAGE_KEY, serialized);
    storage.removeItem(LEGACY_BASKET_STORAGE_KEY);
  } catch {
    // Private mode, blocked storage, quota errors, and invalid state stay non-fatal.
  }
}

export function addExactProductToBasket(
  basket: BrowserBasket,
  product: Product,
  createId: () => string = () => globalThis.crypto.randomUUID(),
): BrowserBasket {
  if (
    basket.needs.length >= BASKET_NEEDS_MAX ||
    basket.matchingRules.some((rule) => rule.mode === "exact" && rule.exactEan === product.ean)
  ) {
    return basket;
  }
  const safeProduct = browserProductSchema.parse(product);
  const needId = createId();
  const ruleId = createId();
  return {
    ...basket,
    needs: [...basket.needs, {
      id: needId,
      matchRuleId: ruleId,
      query: safeProduct.name,
      quantity: 1,
      quantityUnit: "each",
      required: true,
    }],
    matchingRules: [...basket.matchingRules, {
      exactEan: safeProduct.ean,
      explanation: "Eksakt produkt fra Oppdag",
      id: ruleId,
      mode: "exact",
      userApproved: true,
    }],
    products: [...new Map([...basket.products, safeProduct].map((candidate) => [candidate.ean, candidate])).values()],
  };
}

export function removeBasketNeed(basket: BrowserBasket, needId: string): BrowserBasket {
  const needs = basket.needs.filter(({ id }) => id !== needId);
  const referencedRuleIds = new Set(needs.map(({ matchRuleId }) => matchRuleId));
  const matchingRules = basket.matchingRules.filter(({ id }) => referencedRuleIds.has(id));
  const rulesById = new Map(matchingRules.map((rule) => [rule.id, rule]));
  const referencedEans = new Set(needs.flatMap((need) => {
    const rule = rulesById.get(need.matchRuleId);
    return rule ? matchProducts(need, rule, basket.products).map(({ ean }) => ean) : [];
  }));

  return {
    ...basket,
    needs,
    matchingRules,
    products: basket.products.filter(({ ean }) => referencedEans.has(ean)),
  };
}
