import {
  canonicalReviewedFamilyAllowedBrandsSchema,
  exactProductPlanApiRequestSchema,
  matchProducts,
  matchRuleSchema,
  reviewedFamilyCandidateConfirmationSchema,
  reviewedFamilyDescriptorSchema,
  reviewedFamilyPlanApiRequestV2Schema,
  type ExactProductPlanApiRequest,
  type MatchRule,
  type Need,
  type Product,
  type ReviewedFamilyDescriptor,
  type ReviewedFamilyPlanApiRequestV2,
} from "@handleplan/domain";
import { z } from "zod";

export const LEGACY_BASKET_STORAGE_KEY = "handleplan:basket:v1";
export const LEGACY_BASKET_V2_STORAGE_KEY = "handleplan:basket:v2";
export const BASKET_STORAGE_KEY = "handleplan:basket:v3";
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

const browserFamilyConfirmationSchema = z
  .object({
    allowedBrands: canonicalReviewedFamilyAllowedBrandsSchema.optional(),
    candidateCount: z.number().int().min(1).max(50).safe(),
    confirmation: reviewedFamilyCandidateConfirmationSchema,
    family: reviewedFamilyDescriptorSchema,
    matchRuleId: z.string().trim().min(1).max(200),
  })
  .strict();

export type BrowserFamilyConfirmation = z.infer<
  typeof browserFamilyConfirmationSchema
>;

type BasketContents = {
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
};

function validateBasketRelationships(
  { needs, matchingRules, products }: BasketContents,
  context: z.RefinementCtx,
  requireGenericCandidates = true,
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

    if (requireGenericCandidates) {
      const rulesById = new Map(matchingRules.map((rule) => [rule.id, rule]));
      for (const need of needs) {
        const rule = rulesById.get(need.matchRuleId);
        if (
          rule !== undefined
          && rule.mode !== "exact"
          && matchProducts(need, rule, products).length === 0
        ) {
          context.addIssue({
            code: "custom",
            message: "Generic rules must retain at least one matching catalog candidate",
          });
        }
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

function validateFamilyConfirmations(
  input: BasketContents & { familyConfirmations: BrowserFamilyConfirmation[] },
  context: z.RefinementCtx,
): void {
  const rulesById = new Map(input.matchingRules.map((rule) => [rule.id, rule]));
  const confirmationRuleIds = new Set<string>();

  for (const [index, familyConfirmation] of input.familyConfirmations.entries()) {
    if (confirmationRuleIds.has(familyConfirmation.matchRuleId)) {
      context.addIssue({
        code: "custom",
        message: "A matching rule can have only one reviewed-family confirmation",
        path: ["familyConfirmations", index, "matchRuleId"],
      });
    }
    confirmationRuleIds.add(familyConfirmation.matchRuleId);

    const rule = rulesById.get(familyConfirmation.matchRuleId);
    if (
      rule === undefined
      || rule.mode === "exact"
      || rule.productFamily !== familyConfirmation.family.id
      || familyConfirmation.family.status !== "active"
      || (
        rule.mode === "flexible"
        && familyConfirmation.allowedBrands !== undefined
      )
      || (
        rule.mode === "constrained"
        && JSON.stringify(rule.allowedBrands ?? [])
          !== JSON.stringify(familyConfirmation.allowedBrands ?? [])
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Reviewed-family confirmations must bind one active local matching rule",
        path: ["familyConfirmations", index],
      });
    }
  }
}

const legacyBrowserBasketV1Schema = z
  .object({
    version: z.literal(1),
    ...basketContentsShape,
    selectedPlanId: z.string().min(1).max(SELECTED_PLAN_ID_MAX).optional(),
  })
  .strict()
  .superRefine(validateBasketRelationships);

const legacyBrowserBasketV2Schema = z
  .object({
    version: z.literal(2),
    ...basketContentsShape,
    convenienceWeightBasisPoints: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine(validateBasketRelationships);

export const browserBasketSchema = z
  .object({
    version: z.literal(3),
    ...basketContentsShape,
    convenienceWeightBasisPoints: z.number().int().min(0).max(10_000),
    familyConfirmations: z.array(browserFamilyConfirmationSchema).max(BASKET_NEEDS_MAX),
  })
  .strict()
  .superRefine((basket, context) => {
    validateBasketRelationships(basket, context, false);
    validateFamilyConfirmations(basket, context);
  });

export interface BrowserBasket {
  version: 3;
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
  convenienceWeightBasisPoints: number;
  familyConfirmations: BrowserFamilyConfirmation[];
  travel: { enabled: boolean; mode: "car" | "bike" };
}

export type StrictPlanRequestReadiness =
  | { state: "empty" }
  | { state: "requires-reviewed-approval" }
  | {
      state: "ready";
      request: ExactProductPlanApiRequest | ReviewedFamilyPlanApiRequestV2;
    };

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
  const confirmationsByRuleId = new Map(
    basket.familyConfirmations.map((confirmation) => [
      confirmation.matchRuleId,
      confirmation,
    ]),
  );
  const exactNeeds: ExactProductPlanApiRequest["needs"] = [];
  const mixedNeeds: ReviewedFamilyPlanApiRequestV2["needs"] = [];
  let hasReviewedFamily = false;
  for (const need of basket.needs) {
    const rule = rulesById.get(need.matchRuleId);
    if (!need.required || rule?.userApproved !== true) {
      return { state: "requires-reviewed-approval" };
    }
    if (rule.mode === "exact") {
      if (rule.exactEan === undefined) {
        return { state: "requires-reviewed-approval" };
      }
      const exactNeed = {
        id: need.id,
        match: {
          kind: "exact-product" as const,
          product: { kind: "gtin" as const, value: rule.exactEan },
          userApproved: true as const,
        },
        quantity: need.quantity,
        quantityUnit: need.quantityUnit,
        required: true as const,
      };
      exactNeeds.push(exactNeed);
      mixedNeeds.push(exactNeed);
      continue;
    }

    const familyConfirmation = confirmationsByRuleId.get(rule.id);
    if (
      familyConfirmation === undefined
      || rule.productFamily !== familyConfirmation.family.id
    ) {
      return { state: "requires-reviewed-approval" };
    }
    hasReviewedFamily = true;
    mixedNeeds.push({
      id: need.id,
      match: {
        ...(familyConfirmation.allowedBrands === undefined
          ? {}
          : { allowedBrands: familyConfirmation.allowedBrands }),
        confirmation: familyConfirmation.confirmation,
        familyId: familyConfirmation.family.id,
        kind: "reviewed-family",
      },
      quantity: need.quantity,
      quantityUnit: need.quantityUnit,
      required: true,
    });
  }

  const parsed = hasReviewedFamily
    ? reviewedFamilyPlanApiRequestV2Schema.safeParse({
        contractVersion: 2,
        maxStores: 3,
        needs: mixedNeeds,
      })
    : exactProductPlanApiRequestSchema.safeParse({
        contractVersion: 1,
        maxStores: 3,
        needs: exactNeeds,
      });
  return parsed.success
    ? { state: "ready", request: parsed.data }
    : { state: "requires-reviewed-approval" };
}

export const emptyBasketV3: BrowserBasket = {
  version: 3,
  needs: [],
  matchingRules: [],
  products: [],
  convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
  familyConfirmations: [],
  travel: { enabled: false, mode: "car" },
};

function freshEmptyBasket(): BrowserBasket {
  return {
    version: 3,
    needs: [],
    matchingRules: [],
    products: [],
    convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
    familyConfirmations: [],
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

    const legacyV2Stored = storage.getItem(LEGACY_BASKET_V2_STORAGE_KEY);
    if (legacyV2Stored) {
      if (legacyV2Stored.length > BASKET_STORAGE_MAX_CODE_UNITS) {
        storage.removeItem(LEGACY_BASKET_V2_STORAGE_KEY);
        return freshEmptyBasket();
      }
      const legacyV2 = legacyBrowserBasketV2Schema.safeParse(JSON.parse(legacyV2Stored));
      if (!legacyV2.success) return freshEmptyBasket();
      const migrated: BrowserBasket = {
        version: 3,
        needs: legacyV2.data.needs,
        matchingRules: legacyV2.data.matchingRules,
        products: legacyV2.data.products,
        convenienceWeightBasisPoints: legacyV2.data.convenienceWeightBasisPoints,
        familyConfirmations: [],
        travel: legacyV2.data.travel,
      };
      saveBasket(migrated, storage);
      return migrated;
    }

    const legacyStored = storage.getItem(LEGACY_BASKET_STORAGE_KEY);
    if (!legacyStored) return freshEmptyBasket();
    if (legacyStored.length > BASKET_STORAGE_MAX_CODE_UNITS) {
      storage.removeItem(LEGACY_BASKET_STORAGE_KEY);
      return freshEmptyBasket();
    }
    const legacy = legacyBrowserBasketV1Schema.safeParse(JSON.parse(legacyStored));
    if (!legacy.success) return freshEmptyBasket();
    const migrated: BrowserBasket = {
      version: 3,
      needs: legacy.data.needs,
      matchingRules: legacy.data.matchingRules,
      products: legacy.data.products,
      convenienceWeightBasisPoints: DEFAULT_CONVENIENCE_WEIGHT_BASIS_POINTS,
      familyConfirmations: [],
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
    storage.removeItem(LEGACY_BASKET_V2_STORAGE_KEY);
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

export interface AddReviewedFamilyInput {
  allowedBrands?: readonly string[];
  candidateCount: number;
  confirmation: BrowserFamilyConfirmation["confirmation"];
  family: ReviewedFamilyDescriptor;
  quantity: number;
}

export function addReviewedFamilyToBasket(
  basket: BrowserBasket,
  input: AddReviewedFamilyInput,
  createId: () => string = () => globalThis.crypto.randomUUID(),
): BrowserBasket {
  if (
    basket.needs.length >= BASKET_NEEDS_MAX
    || basket.matchingRules.some((rule) =>
      rule.mode !== "exact" && rule.productFamily === input.family.id
    )
  ) {
    return basket;
  }
  const family = reviewedFamilyDescriptorSchema.parse(input.family);
  const allowedBrands = input.allowedBrands === undefined
    ? undefined
    : canonicalReviewedFamilyAllowedBrandsSchema.parse(input.allowedBrands);
  const confirmation = reviewedFamilyCandidateConfirmationSchema.parse(input.confirmation);
  const candidateCount = z.number().int().min(1).max(50).safe().parse(input.candidateCount);
  const quantity = z.number().int().min(BASKET_QUANTITY_MIN).max(BASKET_QUANTITY_MAX)
    .safe().parse(input.quantity);
  const needId = createId();
  const ruleId = createId();
  const rule: MatchRule = allowedBrands === undefined
    ? {
        explanation: "Gjennomgått varetype, valgfritt merke",
        id: ruleId,
        mode: "flexible",
        productFamily: family.id,
        userApproved: true,
      }
    : {
        allowedBrands: [...allowedBrands],
        explanation: `Gjennomgått varetype: ${allowedBrands.join(" eller ")}`,
        id: ruleId,
        mode: "constrained",
        productFamily: family.id,
        userApproved: true,
      };

  return browserBasketSchema.parse({
    ...basket,
    familyConfirmations: [...basket.familyConfirmations, {
      ...(allowedBrands === undefined ? {} : { allowedBrands }),
      candidateCount,
      confirmation,
      family,
      matchRuleId: ruleId,
    }],
    matchingRules: [...basket.matchingRules, rule],
    needs: [...basket.needs, {
      id: needId,
      matchRuleId: ruleId,
      quantity,
      quantityUnit: "each",
      query: family.labelNo,
      required: true,
    }],
  });
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
    familyConfirmations: basket.familyConfirmations.filter(({ matchRuleId }) =>
      referencedRuleIds.has(matchRuleId)
    ),
    needs,
    matchingRules,
    products: basket.products.filter(({ ean }) => referencedEans.has(ean)),
  };
}
