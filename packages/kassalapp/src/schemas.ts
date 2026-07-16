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

const upstreamBrowseResponseSchema = z.object({
  data: z.array(upstreamProductSchema.extend({
    current_price: upstreamPriceAmountSchema.nullable(),
    price_history: z.array(z.object({
      price: upstreamPriceAmountSchema,
      date: z.iso.datetime({ offset: true }),
    })).max(366).optional().default([]),
    store: z.object({ code: z.string() }),
    updated_at: z.iso.datetime({ offset: true }),
  })).max(100),
});

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

  return response.data.flatMap((product) => {
    const normalized = productSchema.safeParse({
      ean: product.ean,
      name: product.name,
      ...(product.brand === undefined || product.brand === null || product.brand.trim() === ""
        ? {}
        : { brand: product.brand }),
      ...normalizedPackage(product.weight, product.weight_unit),
    });

    // Kassalapp's search endpoint can return otherwise usable rows whose `ean`
    // is a vendor identifier rather than an EAN-8/EAN-13. Such rows cannot be
    // used by the bulk-price contract, so omit them without discarding the
    // valid search results in the same response.
    return normalized.success ? [normalized.data] : [];
  });
}

export function normalizeBrowseResponse(input: unknown): Array<{
  product: Product;
  price: PriceObservation;
  previousPrice?: PriceObservation;
}> {
  const response = upstreamBrowseResponseSchema.parse(input);
  return response.data.flatMap((row) => {
    const [product] = normalizeSearchResponse({ data: [row] });
    const chain = chainByStoreCode[row.store.code];
    if (!product || !chain || row.current_price === null) return [];
    const currentAmountOre = Math.round(row.current_price * 100);
    const currentObservedAt = new Date(row.updated_at).toISOString();
    const previous = [...row.price_history]
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
      .find((candidate) => {
        const amountOre = Math.round(candidate.price * 100);
        return Date.parse(candidate.date) < Date.parse(row.updated_at) && amountOre !== currentAmountOre;
      });
    const previousAmountOre = previous === undefined ? undefined : Math.round(previous.price * 100);
    return [{
      product,
      price: priceObservationSchema.parse({
        ean: product.ean,
        chain,
        amountOre: currentAmountOre,
        observedAt: currentObservedAt,
        source: "kassalapp",
      }),
      ...(previous !== undefined && previousAmountOre !== undefined && previousAmountOre > currentAmountOre
        ? {
            previousPrice: priceObservationSchema.parse({
              ean: product.ean,
              chain,
              amountOre: previousAmountOre,
              observedAt: new Date(previous.date).toISOString(),
              source: "kassalapp",
            }),
          }
        : {}),
    }];
  });
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
