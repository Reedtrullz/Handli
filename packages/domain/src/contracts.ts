import { z } from "zod";

import { sourceIdSchema } from "./contract-primitives";
import { fulfilmentSchema, type Fulfilment } from "./fulfilment-contract";

export type MoneyOre = number & { readonly __moneyOre: unique symbol };
export const MAX_PERSISTED_MONEY_ORE = 2_147_483_647;

export type MatchMode = "exact" | "constrained" | "flexible";

export interface Need {
  id: string;
  query: string;
  quantity: number;
  quantityUnit: "each" | "g" | "ml";
  matchRuleId: string;
  required: boolean;
}

export interface MatchRule {
  id: string;
  mode: MatchMode;
  exactEan?: string;
  productFamily?: string;
  allowedBrands?: string[];
  sizeRange?: { min: number; max: number; unit: "g" | "ml" };
  userApproved: boolean;
  explanation: string;
}

export interface Product {
  ean: string;
  name: string;
  brand?: string;
  packageQuantity?: number;
  packageUnit?: "g" | "ml" | "each";
  productFamily?: string;
}

export interface PriceObservation<SourceId extends string = "kassalapp"> {
  ean: string;
  chain: "bunnpris" | "rema-1000" | "extra";
  amountOre: MoneyOre;
  observedAt: string;
  source: SourceId;
}

export interface PlanRequest<SourceId extends string = "kassalapp"> {
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
  prices: PriceObservation<SourceId>[];
  maxStores: 1 | 2 | 3;
}

export interface PlanResult<SourceId extends string = "kassalapp"> {
  id: string;
  assignments: Array<{
    needId: string;
    ean: string;
    chain: PriceObservation["chain"];
    quantity: number;
    costOre: MoneyOre;
    observedAt: string;
    source: SourceId;
    fulfilment?: Fulfilment;
  }>;
  totalOre: MoneyOre;
  chains: PriceObservation["chain"][];
  substitutions: string[];
  coverage: 1;
  freshness: Record<string, string>;
}

const nonEmptyStringSchema = z.string().min(1);
const eanSchema = z.string().regex(/^(?:\d{8}|\d{13})$/);
export const moneyOreSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_PERSISTED_MONEY_ORE)
  .transform((amount) => amount as MoneyOre);
const chainSchema = z.enum(["bunnpris", "rema-1000", "extra"]);
const sizeRangeSchema = z
  .object({
    min: z.number().positive(),
    max: z.number().positive(),
    unit: z.enum(["g", "ml"]),
  })
  .refine(({ min, max }) => min <= max);
const matchRuleBaseShape = {
  id: nonEmptyStringSchema,
  userApproved: z.literal(true),
  explanation: nonEmptyStringSchema,
};

export const needSchema: z.ZodType<Need> = z.object({
  id: nonEmptyStringSchema,
  query: nonEmptyStringSchema,
  quantity: z.number().positive(),
  quantityUnit: z.enum(["each", "g", "ml"]),
  matchRuleId: nonEmptyStringSchema,
  required: z.boolean(),
});

const exactMatchRuleSchema = z
  .object({
    ...matchRuleBaseShape,
    mode: z.literal("exact"),
    exactEan: eanSchema,
  })
  .strict();

const constrainedMatchRuleSchema = z
  .object({
    ...matchRuleBaseShape,
    mode: z.literal("constrained"),
    productFamily: nonEmptyStringSchema.optional(),
    allowedBrands: z.array(nonEmptyStringSchema).min(1).optional(),
    sizeRange: sizeRangeSchema.optional(),
  })
  .strict()
  .refine(
    ({ productFamily, allowedBrands, sizeRange }) =>
      productFamily !== undefined || allowedBrands !== undefined || sizeRange !== undefined,
    { message: "Constrained matching rules require at least one constraint" },
  );

const flexibleMatchRuleSchema = z
  .object({
    ...matchRuleBaseShape,
    mode: z.literal("flexible"),
    productFamily: nonEmptyStringSchema,
  })
  .strict();

export const matchRuleSchema: z.ZodType<MatchRule> = z.discriminatedUnion("mode", [
  exactMatchRuleSchema,
  constrainedMatchRuleSchema,
  flexibleMatchRuleSchema,
]);

export const productSchema: z.ZodType<Product> = z.object({
  ean: eanSchema,
  name: nonEmptyStringSchema,
  brand: nonEmptyStringSchema.optional(),
  packageQuantity: z.number().positive().optional(),
  packageUnit: z.enum(["g", "ml", "each"]).optional(),
  productFamily: nonEmptyStringSchema.optional(),
});

const priceObservationBaseShape = {
  ean: eanSchema,
  chain: chainSchema,
  amountOre: moneyOreSchema,
  observedAt: z.iso.datetime({ offset: false, precision: 3 }),
};

export const sourceNeutralPriceObservationSchema: z.ZodType<PriceObservation<string>> = z.object({
  ...priceObservationBaseShape,
  source: sourceIdSchema,
});

// Compatibility schemas deliberately preserve the Kassalapp-only runtime
// boundary used by existing clients. New callers opt into the explicitly named
// source-neutral schemas instead of receiving a wider value through a narrow type.
export const priceObservationSchema: z.ZodType<PriceObservation> = z.object({
  ...priceObservationBaseShape,
  source: z.literal("kassalapp"),
});

export const sourceNeutralPlanRequestSchema: z.ZodType<PlanRequest<string>> = z.object({
  needs: z.array(needSchema),
  matchingRules: z.array(matchRuleSchema),
  products: z.array(productSchema),
  prices: z.array(sourceNeutralPriceObservationSchema),
  maxStores: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const planRequestSchema: z.ZodType<PlanRequest> = z.object({
  needs: z.array(needSchema),
  matchingRules: z.array(matchRuleSchema),
  products: z.array(productSchema),
  prices: z.array(priceObservationSchema),
  maxStores: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const sourceNeutralPlanResultSchema: z.ZodType<PlanResult<string>> = z.object({
  id: nonEmptyStringSchema,
  assignments: z.array(
    z.object({
      needId: nonEmptyStringSchema,
      ean: eanSchema,
      chain: chainSchema,
      quantity: z.number().positive(),
      costOre: moneyOreSchema,
      observedAt: z.iso.datetime({ offset: false, precision: 3 }),
      source: sourceIdSchema,
      fulfilment: fulfilmentSchema.optional(),
    }),
  ),
  totalOre: moneyOreSchema,
  chains: z
    .array(chainSchema)
    .max(3)
    .refine((chains) => new Set(chains).size === chains.length, {
      message: "Plan result chains must be unique",
    }),
  substitutions: z.array(z.string()),
  coverage: z.literal(1),
  freshness: z.record(z.string(), z.string()),
});

export const planResultSchema: z.ZodType<PlanResult> = z.object({
  id: nonEmptyStringSchema,
  assignments: z.array(
    z.object({
      needId: nonEmptyStringSchema,
      ean: eanSchema,
      chain: chainSchema,
      quantity: z.number().positive(),
      costOre: moneyOreSchema,
      observedAt: z.iso.datetime({ offset: false, precision: 3 }),
      source: z.literal("kassalapp"),
      fulfilment: fulfilmentSchema.optional(),
    }),
  ),
  totalOre: moneyOreSchema,
  chains: z
    .array(chainSchema)
    .max(3)
    .refine((chains) => new Set(chains).size === chains.length, {
      message: "Plan result chains must be unique",
    }),
  substitutions: z.array(z.string()),
  coverage: z.literal(1),
  freshness: z.record(z.string(), z.string()),
});
