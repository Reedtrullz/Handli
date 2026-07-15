import { z } from "zod";

export type MoneyOre = number & { readonly __moneyOre: unique symbol };

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

export interface PriceObservation {
  ean: string;
  chain: "bunnpris" | "rema-1000" | "extra";
  amountOre: MoneyOre;
  observedAt: string;
  source: "kassalapp";
}

export interface PlanRequest {
  needs: Need[];
  matchingRules: MatchRule[];
  products: Product[];
  prices: PriceObservation[];
  maxStores: 1 | 2 | 3;
}

export interface PlanResult {
  id: string;
  assignments: Array<{
    needId: string;
    ean: string;
    chain: PriceObservation["chain"];
    quantity: number;
    costOre: MoneyOre;
  }>;
  totalOre: MoneyOre;
  chains: PriceObservation["chain"][];
  substitutions: string[];
  coverage: 1;
  freshness: Record<string, string>;
}

const nonEmptyStringSchema = z.string().min(1);
const eanSchema = z.string().regex(/^(?:\d{8}|\d{13})$/);
const moneyOreSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((amount) => amount as MoneyOre);

export const needSchema: z.ZodType<Need> = z.object({
  id: nonEmptyStringSchema,
  query: nonEmptyStringSchema,
  quantity: z.number().positive(),
  quantityUnit: z.enum(["each", "g", "ml"]),
  matchRuleId: nonEmptyStringSchema,
  required: z.boolean(),
});

export const matchRuleSchema: z.ZodType<MatchRule> = z
  .object({
    id: nonEmptyStringSchema,
    mode: z.enum(["exact", "constrained", "flexible"]),
    exactEan: eanSchema.optional(),
    productFamily: nonEmptyStringSchema.optional(),
    allowedBrands: z.array(nonEmptyStringSchema).optional(),
    sizeRange: z
      .object({
        min: z.number().positive(),
        max: z.number().positive(),
        unit: z.enum(["g", "ml"]),
      })
      .refine(({ min, max }) => min <= max)
      .optional(),
    userApproved: z.boolean(),
    explanation: nonEmptyStringSchema,
  })
  .refine(({ mode, userApproved }) => mode !== "flexible" || userApproved, {
    message: "Flexible matching rules require user approval",
    path: ["userApproved"],
  });

export const productSchema: z.ZodType<Product> = z.object({
  ean: eanSchema,
  name: nonEmptyStringSchema,
  brand: nonEmptyStringSchema.optional(),
  packageQuantity: z.number().positive().optional(),
  packageUnit: z.enum(["g", "ml", "each"]).optional(),
  productFamily: nonEmptyStringSchema.optional(),
});

export const priceObservationSchema: z.ZodType<PriceObservation> = z.object({
  ean: eanSchema,
  chain: z.enum(["bunnpris", "rema-1000", "extra"]),
  amountOre: moneyOreSchema,
  observedAt: z.iso.datetime(),
  source: z.literal("kassalapp"),
});

export const planRequestSchema: z.ZodType<PlanRequest> = z.object({
  needs: z.array(needSchema),
  matchingRules: z.array(matchRuleSchema),
  products: z.array(productSchema),
  prices: z.array(priceObservationSchema),
  maxStores: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const planResultSchema: z.ZodType<PlanResult> = z.object({
  id: nonEmptyStringSchema,
  assignments: z.array(
    z.object({
      needId: nonEmptyStringSchema,
      ean: eanSchema,
      chain: z.enum(["bunnpris", "rema-1000", "extra"]),
      quantity: z.number().positive(),
      costOre: moneyOreSchema,
    }),
  ),
  totalOre: moneyOreSchema,
  chains: z.array(z.enum(["bunnpris", "rema-1000", "extra"])),
  substitutions: z.array(z.string()),
  coverage: z.literal(1),
  freshness: z.record(z.string(), z.string()),
});
