import {
  priceObservationSchema,
  productSchema,
  type PriceObservation,
  type Product,
} from "@handleplan/domain";
import { z } from "zod";

// Provisional fixture-backed upstream boundary. No live Kassalapp response capture
// exists in this repository yet, so live mode must verify this shape before release.
const upstreamProductSchema = z
  .object({
    ean: z.string(),
    name: z.string(),
    brand: z.string().optional(),
    package_quantity: z.number().optional(),
    package_unit: z.enum(["g", "ml", "each"]).optional(),
    product_family: z.string().optional(),
  })
  .strict();

const upstreamSearchResponseSchema = z
  .object({
    data: z.array(upstreamProductSchema),
  })
  .strict();

const upstreamPriceSchema = z
  .object({
    ean: z.string(),
    chain: z.enum(["bunnpris", "rema-1000", "extra"]),
    price_nok: z
      .number()
      .finite()
      .nonnegative()
      .refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6, {
        message: "Price must contain at most two decimal places",
      }),
    observed_at: z.iso.datetime({ offset: true }),
  })
  .strict();

const upstreamBulkPriceResponseSchema = z
  .object({
    data: z.array(upstreamPriceSchema),
  })
  .strict();

export function normalizeSearchResponse(input: unknown): Product[] {
  const response = upstreamSearchResponseSchema.parse(input);

  return response.data.map((product) =>
    productSchema.parse({
      ean: product.ean,
      name: product.name,
      ...(product.brand === undefined ? {} : { brand: product.brand }),
      ...(product.package_quantity === undefined
        ? {}
        : { packageQuantity: product.package_quantity }),
      ...(product.package_unit === undefined ? {} : { packageUnit: product.package_unit }),
      ...(product.product_family === undefined
        ? {}
        : { productFamily: product.product_family }),
    }),
  );
}

export function normalizeBulkPriceResponse(input: unknown): PriceObservation[] {
  const response = upstreamBulkPriceResponseSchema.parse(input);

  return response.data.map((price) =>
    priceObservationSchema.parse({
      ean: price.ean,
      chain: price.chain,
      amountOre: Math.round(price.price_nok * 100),
      observedAt: new Date(price.observed_at).toISOString(),
      source: "kassalapp",
    }),
  );
}
