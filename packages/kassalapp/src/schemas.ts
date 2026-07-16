import {
  priceObservationSchema,
  productSchema,
  type PriceObservation,
  type Product,
} from "@handleplan/domain";
import { z } from "zod";

const upstreamProductSchema = z.object({
  ean: z.string(),
  name: z.string(),
  brand: z.string().nullable().optional(),
  weight: z.number().finite().positive().nullable().optional(),
  weight_unit: z.string().nullable().optional(),
});

const upstreamSearchResponseSchema = z.object({
  data: z.array(upstreamProductSchema).max(100),
});

const upstreamPriceAmountSchema = z
  .union([
    z.number().finite(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/).transform(Number),
  ])
  .pipe(
    z.number().finite().nonnegative().refine(
      (amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6,
      { message: "Price must contain at most two decimal places" },
    ),
  );

const upstreamBulkStoreSchema = z.object({
  store: z.string(),
  current_price: upstreamPriceAmountSchema.nullable(),
  last_checked: z.iso.datetime({ offset: true }),
});

const upstreamBulkPriceResponseSchema = z.object({
  data: z
    .array(
      z.object({
        ean: z.string(),
        stores: z.array(upstreamBulkStoreSchema).max(100),
      }),
    )
    .max(100),
});

const chainByStoreCode: Readonly<Record<string, PriceObservation["chain"]>> = {
  BUNNPRIS: "bunnpris",
  COOP_EXTRA: "extra",
  REMA_1000: "rema-1000",
};

function normalizedPackage(
  weight: number | null | undefined,
  unit: string | null | undefined,
): Pick<Product, "packageQuantity" | "packageUnit"> {
  if (weight === undefined || weight === null || unit === undefined || unit === null) return {};
  switch (unit.toLowerCase()) {
    case "g": return { packageQuantity: weight, packageUnit: "g" };
    case "kg": return { packageQuantity: weight * 1000, packageUnit: "g" };
    case "ml": return { packageQuantity: weight, packageUnit: "ml" };
    case "cl": return { packageQuantity: weight * 10, packageUnit: "ml" };
    case "dl": return { packageQuantity: weight * 100, packageUnit: "ml" };
    case "l": return { packageQuantity: weight * 1000, packageUnit: "ml" };
    case "each":
    case "piece":
    case "stk":
      return { packageQuantity: weight, packageUnit: "each" };
    default:
      return {};
  }
}

export function normalizeSearchResponse(input: unknown): Product[] {
  const response = upstreamSearchResponseSchema.parse(input);

  return response.data.map((product) =>
    productSchema.parse({
      ean: product.ean,
      name: product.name,
      ...(product.brand === undefined || product.brand === null || product.brand.trim() === ""
        ? {}
        : { brand: product.brand }),
      ...normalizedPackage(product.weight, product.weight_unit),
    }),
  );
}

export function normalizeBulkPriceResponse(input: unknown): PriceObservation[] {
  const response = upstreamBulkPriceResponseSchema.parse(input);

  return response.data.flatMap((product) =>
    product.stores.flatMap((store) => {
      const chain = chainByStoreCode[store.store];
      if (chain === undefined || store.current_price === null) return [];
      return [
        priceObservationSchema.parse({
          ean: product.ean,
          chain,
          amountOre: Math.round(store.current_price * 100),
          observedAt: new Date(store.last_checked).toISOString(),
          source: "kassalapp",
        }),
      ];
    }),
  );
}
