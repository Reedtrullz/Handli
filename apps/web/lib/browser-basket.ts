import {
  matchRuleSchema,
  type MatchRule,
  type Need,
  type Product,
} from "@handleplan/domain";
import { z } from "zod";

export const BASKET_STORAGE_KEY = "handleplan:basket:v1";

const browserNeedSchema = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    quantity: z.number().int().positive(),
    quantityUnit: z.enum(["each", "g", "ml"]),
    matchRuleId: z.string().min(1),
    required: z.boolean(),
  })
  .strict();

const browserProductSchema = z
  .object({
    ean: z.string().regex(/^(?:\d{8}|\d{13})$/),
    name: z.string().min(1),
    brand: z.string().min(1).optional(),
    packageQuantity: z.number().positive().optional(),
    packageUnit: z.enum(["g", "ml", "each"]).optional(),
    productFamily: z.string().min(1).optional(),
  })
  .strict();

export const browserBasketSchema = z
  .object({
    version: z.literal(1),
    needs: z.array(browserNeedSchema),
    matchingRules: z.array(matchRuleSchema),
    products: z.array(browserProductSchema),
    travel: z
      .object({
        enabled: z.boolean(),
        mode: z.enum(["car", "bike"]),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ needs, matchingRules, products }, context) => {
    const ruleIds = new Set(matchingRules.map(({ id }) => id));
    const productEans = new Set(products.map(({ ean }) => ean));
    const ids = new Set<string>();

    for (const need of needs) {
      if (ids.has(need.id)) {
        context.addIssue({ code: "custom", message: "Need IDs must be unique" });
      }
      ids.add(need.id);
      if (!ruleIds.has(need.matchRuleId)) {
        context.addIssue({ code: "custom", message: "Need must reference an approved rule" });
      }
    }

    for (const rule of matchingRules) {
      if (rule.mode === "exact" && (!rule.exactEan || !productEans.has(rule.exactEan))) {
        context.addIssue({ code: "custom", message: "Exact rules must reference a stored product" });
      }
    }
  });

export interface BrowserBasket {
  version: 1;
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
  travel: { enabled: boolean; mode: "car" | "bike" };
}

export const emptyBasketV1: BrowserBasket = {
  version: 1,
  needs: [],
  matchingRules: [],
  products: [],
  travel: { enabled: false, mode: "car" },
};

function freshEmptyBasket(): BrowserBasket {
  return {
    version: 1,
    needs: [],
    matchingRules: [],
    products: [],
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
    if (!stored) return freshEmptyBasket();
    const parsed = browserBasketSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : freshEmptyBasket();
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
    storage.setItem(BASKET_STORAGE_KEY, JSON.stringify(safeBasket));
  } catch {
    // Private mode, blocked storage, quota errors, and invalid state stay non-fatal.
  }
}
