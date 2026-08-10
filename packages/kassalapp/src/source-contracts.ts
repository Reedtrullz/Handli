import { isValidGtin } from "@handleplan/domain";
import { z } from "zod";

export { isValidGtin };

export const KASSALAPP_SOURCE_CONTRACT_VERSION = 1 as const;
export const KASSALAPP_SOURCE_ID = "kassalapp" as const;

const MAX_LIST_RECORDS = 1_000;
const MAX_PRICE_PRODUCTS = 100;
const MAX_STORES_PER_PRODUCT = 100;
const MAX_PERSISTED_PRICE_ORE = 2_147_483_647;
const sourceStringSchema = z.string().trim().min(1).max(500);
const sourceIdentifierSchema = z
  .union([z.string().trim().min(1).max(200), z.number().int().safe().nonnegative()])
  .transform(String);
const sourceTimestampSchema = z.iso.datetime({ offset: true });
const canonicalTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });

export type KassalappChainId = "bunnpris" | "rema-1000" | "extra";
export type NormalizedPackageUnit = "g" | "ml" | "piece" | "package";

export interface NormalizedPackageMeasure {
  amount: number;
  unit: NormalizedPackageUnit;
}

export type PackageMeasureResult =
  | { state: "normalized"; measure: NormalizedPackageMeasure }
  | { state: "unknown"; reason: "MISSING_MEASURE" | "UNKNOWN_UNIT" }
  | { state: "quarantined"; reason: "INVALID_MEASURE" };

export type SourceQuarantineReason =
  | "DUPLICATE_IDENTITY"
  | "FUTURE_TIMESTAMP"
  | "IDENTIFIER_MISMATCH"
  | "INVALID_GTIN"
  | "INVALID_MEASURE"
  | "MALFORMED_RECORD"
  | "UNKNOWN_CHAIN";

export type SourceUnknownReason =
  | "BATCH_FAILED"
  | "MISSING_PRICE"
  | "MISSING_REQUESTED_EAN"
  | "MISSING_SUPPORTED_CHAIN"
  | "MISSING_TIMESTAMP"
  | "NOT_FOUND";

export type SourceRecordOutcome<T> =
  | { state: "accepted"; record: T }
  | {
      state: "quarantined";
      sourceRecordId: string;
      reason: SourceQuarantineReason;
      chainCode?: string;
      chainId?: KassalappChainId;
      ean?: string;
    }
  | {
      state: "unknown";
      sourceRecordId: string;
      reason: SourceUnknownReason;
      chainCode?: string;
      chainId?: KassalappChainId;
      ean?: string;
    };

interface SourceRecordBase {
  contractVersion: typeof KASSALAPP_SOURCE_CONTRACT_VERSION;
  sourceId: typeof KASSALAPP_SOURCE_ID;
  sourceRecordId: string;
  retrievedAt: string;
}

export interface KassalappProductSourceRecordV1 extends SourceRecordBase {
  kind: "product";
  ean: string;
  name: string;
  brand?: string;
  categoryPath?: KassalappProductCategoryV1[];
  chainCodes?: string[];
  packageMeasure?: NormalizedPackageMeasure;
  packageMeasureState?: "missing" | "unknown-unit";
  sourceUpdatedAt?: string;
}

export interface KassalappProductCategoryV1 {
  sourceCategoryId: string;
  depth: number;
  name: string;
}

export interface KassalappPriceSourceRecordV1 extends SourceRecordBase {
  kind: "price";
  ean: string;
  chainId: KassalappChainId;
  chainCode: string;
  amountOre: number;
  observationKind: "current" | "historical";
  observedAt: string;
}

export interface KassalappCategorySourceRecordV1 extends SourceRecordBase {
  kind: "category";
  name: string;
}

export type KassalappCategoryCoverageV1 = {
  recordCount: number;
} & (
  | { state: "complete" }
  | { state: "unknown"; reason: "INVALID_RECORDS" | "POSSIBLY_TRUNCATED" }
);

export interface KassalappCategorySyncResultV1 {
  outcomes: Array<SourceRecordOutcome<KassalappCategorySourceRecordV1>>;
  coverage: KassalappCategoryCoverageV1[];
}

export interface KassalappLabelSourceRecordV1 extends SourceRecordBase {
  kind: "label";
  name: string;
  sourceName: string;
}

export interface KassalappPhysicalStoreSourceRecordV1 extends SourceRecordBase {
  kind: "physical-store";
  name: string;
  chainId: KassalappChainId;
  chainCode: string;
  address?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  sourceUpdatedAt?: string;
}

const CHAIN_BY_CODE: Readonly<Record<string, KassalappChainId>> = {
  BUNNPRIS: "bunnpris",
  COOP_EXTRA: "extra",
  REMA_1000: "rema-1000",
};

function safeSourceRecordId(value: unknown, fallback: string): string {
  const parsed = sourceIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function contextTimestamp(now: Date, retrievedAt: string): { nowMs: number; retrievedAt: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid normalization clock");
  return {
    nowMs: now.getTime(),
    retrievedAt: canonicalTimestampSchema.parse(retrievedAt),
  };
}

function canonicalSourceTimestamp(value: string): string {
  return new Date(sourceTimestampSchema.parse(value)).toISOString();
}

function timestampIsFuture(value: string, nowMs: number): boolean {
  return Date.parse(value) > nowMs;
}

function sourceBase(sourceRecordId: string, retrievedAt: string): SourceRecordBase {
  return {
    contractVersion: KASSALAPP_SOURCE_CONTRACT_VERSION,
    sourceId: KASSALAPP_SOURCE_ID,
    sourceRecordId,
    retrievedAt,
  };
}

function outcomeSourceRecordId<T extends SourceRecordBase>(outcome: SourceRecordOutcome<T>): string {
  return outcome.state === "accepted" ? outcome.record.sourceRecordId : outcome.sourceRecordId;
}

function commonOutcomeSubject<T extends SourceRecordBase>(
  outcomes: readonly SourceRecordOutcome<T>[],
): { chainCode?: string; chainId?: KassalappChainId; ean?: string } {
  const values = outcomes.map((outcome) =>
    (outcome.state === "accepted" ? outcome.record : outcome) as unknown as Record<string, unknown>);
  const common = <Value extends string>(key: "chainCode" | "chainId" | "ean"): Value | undefined => {
    const candidates = new Set(values.map((value) => value[key]).filter(
      (value): value is string => typeof value === "string",
    ));
    return candidates.size === 1 ? [...candidates][0] as Value : undefined;
  };
  const chainCode = common<string>("chainCode");
  const chainId = common<KassalappChainId>("chainId");
  const ean = common<string>("ean");
  return {
    ...(chainCode === undefined ? {} : { chainCode }),
    ...(chainId === undefined ? {} : { chainId }),
    ...(ean === undefined ? {} : { ean }),
  };
}

export function canonicalizeSourceRecordOutcomes<T extends SourceRecordBase>(
  outcomes: readonly SourceRecordOutcome<T>[],
): SourceRecordOutcome<T>[] {
  const byIdentity = new Map<string, SourceRecordOutcome<T>[]>();
  for (const outcome of outcomes) {
    const sourceRecordId = outcomeSourceRecordId(outcome);
    const group = byIdentity.get(sourceRecordId) ?? [];
    group.push(outcome);
    byIdentity.set(sourceRecordId, group);
  }

  return [...byIdentity.entries()].sort(([left], [right]) => left.localeCompare(right)).flatMap(
    ([sourceRecordId, group]) => {
      const accepted = group.filter((outcome): outcome is Extract<SourceRecordOutcome<T>, { state: "accepted" }> =>
        outcome.state === "accepted");
      const acceptedShapes = new Set(accepted.map(({ record }) => JSON.stringify(record)));
      if (acceptedShapes.size > 1 || (accepted.length > 0 && group.some((outcome) => outcome.state !== "accepted"))) {
        return [{
          ...commonOutcomeSubject(group),
          state: "quarantined" as const,
          sourceRecordId,
          reason: "DUPLICATE_IDENTITY" as const,
        }];
      }
      const unique = new Map<string, SourceRecordOutcome<T>>();
      for (const outcome of group) unique.set(JSON.stringify(outcome), outcome);
      return [...unique.values()].sort((left, right) => {
        const order = { accepted: 0, quarantined: 1, unknown: 2 } as const;
        return order[left.state] - order[right.state] || JSON.stringify(left).localeCompare(JSON.stringify(right));
      });
    },
  );
}

export function normalizePackageMeasure(
  amount: number | null | undefined,
  rawUnit: string | null | undefined,
): PackageMeasureResult {
  if (amount === null || amount === undefined || rawUnit === null || rawUnit === undefined) {
    return { state: "unknown", reason: "MISSING_MEASURE" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { state: "quarantined", reason: "INVALID_MEASURE" };
  }

  const unit = rawUnit.trim().toLocaleLowerCase("nb-NO");
  const normalized = (() => {
    switch (unit) {
      case "g": return { amount, unit: "g" as const };
      case "kg": return { amount: amount * 1_000, unit: "g" as const };
      case "ml": return { amount, unit: "ml" as const };
      case "cl": return { amount: amount * 10, unit: "ml" as const };
      case "dl": return { amount: amount * 100, unit: "ml" as const };
      case "l": return { amount: amount * 1_000, unit: "ml" as const };
      case "each":
      case "piece":
      case "stk":
        return { amount, unit: "piece" as const };
      case "package":
      case "pakke":
        return { amount, unit: "package" as const };
      default:
        return undefined;
    }
  })();

  if (normalized === undefined) return { state: "unknown", reason: "UNKNOWN_UNIT" };
  if (!Number.isSafeInteger(normalized.amount) || normalized.amount <= 0) {
    return { state: "quarantined", reason: "INVALID_MEASURE" };
  }
  return { state: "normalized", measure: normalized };
}

const comparisonStoreSchema = z.object({
  name: sourceStringSchema,
  code: z.string().trim().min(1).max(100),
  url: sourceStringSchema,
  logo: sourceStringSchema,
});

const comparisonCategorySchema = z.object({
  id: z.number().int().safe().nonnegative(),
  depth: z.number().int().safe().nonnegative().max(100),
  name: sourceStringSchema,
});

const comparisonPriceSchema = z.object({
  price: z.number().finite(),
  unit_price: z.number().finite(),
  date: sourceTimestampSchema,
});

const comparisonHistorySchema = z.object({
  price: z.number().finite(),
  date: sourceTimestampSchema,
});

const upstreamComparisonProductSchema = z.object({
  id: sourceIdentifierSchema,
  name: sourceStringSchema,
  vendor: z.string().max(500),
  brand: z.string().max(500),
  description: z.string().max(20_000),
  ingredients: z.string().max(20_000),
  url: sourceStringSchema,
  image: sourceStringSchema,
  category: z.array(comparisonCategorySchema).max(100).nullable(),
  store: z.array(comparisonStoreSchema).max(100).nullable(),
  current_price: z.array(comparisonPriceSchema).max(1_000).nullable(),
  weight: z.number().finite(),
  weight_unit: z.string().trim().min(1).max(32),
  price_history: z.array(comparisonHistorySchema).max(10_000),
  kassalapp: z.object({ url: sourceStringSchema, opengraph: sourceStringSchema }),
  created_at: sourceTimestampSchema,
  updated_at: sourceTimestampSchema,
});

const comparisonProductEnvelopeSchema = z.object({
  data: z.object({
    ean: z.string().trim().min(1).max(64),
    products: z.array(z.unknown()).max(MAX_LIST_RECORDS),
    allergens: z.array(z.unknown()).max(MAX_LIST_RECORDS),
    nutrition: z.array(z.unknown()).max(MAX_LIST_RECORDS),
    labels: z.array(z.unknown()).max(MAX_LIST_RECORDS),
  }).nullable(),
});

const upstreamProductResourceSchema = z.object({
  id: z.number().int().safe().positive(),
  name: sourceStringSchema,
  brand: sourceStringSchema.nullable(),
  vendor: sourceStringSchema.nullable(),
  ean: z.string().trim().min(1).max(64).nullable(),
  url: sourceStringSchema,
  image: sourceStringSchema.nullable(),
  category: z.array(comparisonCategorySchema).max(100).nullable(),
  description: z.string().max(20_000).nullable(),
  ingredients: z.string().max(20_000).nullable(),
  current_price: z.number().finite().nullable(),
  current_unit_price: z.number().finite().nullable(),
  weight: z.number().finite(),
  weight_unit: z.string().trim().min(1).max(32),
  store: z.array(comparisonStoreSchema).max(100),
  price_history: z.array(comparisonHistorySchema).max(10_000),
  allergens: z.array(z.unknown()).max(MAX_LIST_RECORDS),
  nutrition: z.array(z.unknown()).max(MAX_LIST_RECORDS),
  labels: z.array(z.unknown()).max(MAX_LIST_RECORDS),
  created_at: z.union([z.object({}).passthrough(), z.null()]),
  updated_at: z.union([z.object({}).passthrough(), z.null()]),
});

const productResourceEnvelopeSchema = z.object({ data: z.unknown().nullable() });
const productPageEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(100),
});

export interface ProductNormalizationContext {
  expectedEan?: string;
  expectedProductId?: number;
  now: Date;
  retrievedAt: string;
}

type ProductCategoryPathResult =
  | { state: "normalized"; categoryPath: KassalappProductCategoryV1[] | undefined }
  | { state: "conflict" };

function normalizeProductCategoryPath(
  categories: readonly z.infer<typeof comparisonCategorySchema>[] | null,
): ProductCategoryPathResult {
  if (categories === null) return { state: "normalized", categoryPath: undefined };
  const byId = new Map<string, KassalappProductCategoryV1>();
  for (const category of categories) {
    const normalized = {
      depth: category.depth,
      name: category.name,
      sourceCategoryId: String(category.id),
    };
    const previous = byId.get(normalized.sourceCategoryId);
    if (
      previous !== undefined
      && (previous.depth !== normalized.depth || previous.name !== normalized.name)
    ) {
      return { state: "conflict" };
    }
    byId.set(normalized.sourceCategoryId, normalized);
  }
  return {
    state: "normalized",
    categoryPath: [...byId.values()].sort((left, right) =>
      left.depth - right.depth
      || Number(left.sourceCategoryId) - Number(right.sourceCategoryId)
      || left.name.localeCompare(right.name, "nb-NO")),
  };
}

function normalizedProductRecord(
  parsed: z.infer<typeof upstreamComparisonProductSchema> | z.infer<typeof upstreamProductResourceSchema>,
  ean: string,
  retrievedAt: string,
  categoryPath: KassalappProductCategoryV1[] | undefined,
  sourceUpdatedAt?: string,
): KassalappProductSourceRecordV1 {
  const sourceRecordId = String(parsed.id);
  const packageResult = normalizePackageMeasure(parsed.weight, parsed.weight_unit);
  if (packageResult.state === "quarantined") throw new Error("invalid package measure");
  const chainCodes = [...new Set(parsed.store?.map(({ code }) => code) ?? [])].sort();
  return {
    ...sourceBase(sourceRecordId, retrievedAt),
    kind: "product",
    ean,
    name: parsed.name,
    ...(parsed.brand === "" || parsed.brand === null ? {} : { brand: parsed.brand }),
    ...(categoryPath === undefined ? {} : { categoryPath }),
    ...(chainCodes.length === 0 ? {} : { chainCodes }),
    ...(packageResult.state === "normalized" ? { packageMeasure: packageResult.measure } : {}),
    ...(packageResult.state === "unknown" ? {
      packageMeasureState: packageResult.reason === "MISSING_MEASURE" ? "missing" as const : "unknown-unit" as const,
    } : {}),
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
  };
}

export function normalizeProductComparisonSourceResponse(
  input: unknown,
  context: ProductNormalizationContext,
): SourceRecordOutcome<KassalappProductSourceRecordV1>[] {
  const { nowMs, retrievedAt } = contextTimestamp(context.now, context.retrievedAt);
  const envelope = comparisonProductEnvelopeSchema.parse(input);
  if (envelope.data === null) {
    return [{
      ...(context.expectedEan !== undefined && isValidGtin(context.expectedEan)
        ? { ean: context.expectedEan }
        : {}),
      state: "unknown",
      sourceRecordId: context.expectedEan ?? "not-found",
      reason: "NOT_FOUND",
    }];
  }
  const ean = envelope.data.ean;
  if (!isValidGtin(ean)) return [{ state: "quarantined", sourceRecordId: ean, reason: "INVALID_GTIN" }];
  if (context.expectedEan !== undefined && ean !== context.expectedEan) {
    return [{ ean, state: "quarantined", sourceRecordId: ean, reason: "IDENTIFIER_MISMATCH" }];
  }
  if (envelope.data.products.length === 0) {
    return [{ ean, state: "unknown", sourceRecordId: ean, reason: "NOT_FOUND" }];
  }

  return canonicalizeSourceRecordOutcomes(envelope.data.products.map((candidate, index) => {
    const parsed = upstreamComparisonProductSchema.safeParse(candidate);
    const sourceRecordId = safeSourceRecordId((candidate as { id?: unknown })?.id, `${ean}:product-${index}`);
    if (!parsed.success) {
      return { ean, state: "quarantined" as const, sourceRecordId, reason: "MALFORMED_RECORD" as const };
    }
    const sourceUpdatedAt = canonicalSourceTimestamp(parsed.data.updated_at);
    if (timestampIsFuture(sourceUpdatedAt, nowMs)) {
      return { ean, state: "quarantined" as const, sourceRecordId, reason: "FUTURE_TIMESTAMP" as const };
    }
    const packageResult = normalizePackageMeasure(parsed.data.weight, parsed.data.weight_unit);
    if (packageResult.state === "quarantined") {
      return { ean, state: "quarantined" as const, sourceRecordId, reason: "INVALID_MEASURE" as const };
    }
    const categoryPath = normalizeProductCategoryPath(parsed.data.category);
    if (categoryPath.state === "conflict") {
      return { ean, state: "quarantined" as const, sourceRecordId, reason: "DUPLICATE_IDENTITY" as const };
    }
    return {
      state: "accepted" as const,
      record: normalizedProductRecord(
        parsed.data,
        ean,
        retrievedAt,
        categoryPath.categoryPath,
        sourceUpdatedAt,
      ),
    };
  }));
}

export function normalizeProductSourceResponse(
  input: unknown,
  context: ProductNormalizationContext,
): SourceRecordOutcome<KassalappProductSourceRecordV1> {
  const { retrievedAt } = contextTimestamp(context.now, context.retrievedAt);
  const envelope = productResourceEnvelopeSchema.parse(input);
  if (envelope.data === null) {
    return {
      state: "unknown",
      sourceRecordId: context.expectedEan ?? "not-found",
      reason: "NOT_FOUND",
    };
  }

  const parsed = upstreamProductResourceSchema.safeParse(envelope.data);
  const sourceRecordId = safeSourceRecordId(
    parsed.success ? parsed.data.id : (envelope.data as { id?: unknown })?.id,
    context.expectedEan ?? "malformed-product",
  );
  if (!parsed.success) return { state: "quarantined", sourceRecordId, reason: "MALFORMED_RECORD" };

  if (context.expectedProductId !== undefined && parsed.data.id !== context.expectedProductId) {
    return { state: "quarantined", sourceRecordId, reason: "IDENTIFIER_MISMATCH" };
  }

  const ean = parsed.data.ean ?? "";
  if (!isValidGtin(ean)) return { state: "quarantined", sourceRecordId, reason: "INVALID_GTIN" };
  if (context.expectedEan !== undefined && ean !== context.expectedEan) {
    return { state: "quarantined", sourceRecordId, reason: "IDENTIFIER_MISMATCH" };
  }

  const packageResult = normalizePackageMeasure(parsed.data.weight, parsed.data.weight_unit);
  if (packageResult.state === "quarantined") {
    return { state: "quarantined", sourceRecordId, reason: "INVALID_MEASURE" };
  }
  const categoryPath = normalizeProductCategoryPath(parsed.data.category);
  if (categoryPath.state === "conflict") {
    return { state: "quarantined", sourceRecordId, reason: "DUPLICATE_IDENTITY" };
  }

  return {
    state: "accepted",
    record: normalizedProductRecord(parsed.data, ean, retrievedAt, categoryPath.categoryPath),
  };
}

export function normalizeProductPageSourceResponse(
  input: unknown,
  context: ProductNormalizationContext & { limit: number },
): SourceRecordOutcome<KassalappProductSourceRecordV1>[] {
  if (!Number.isSafeInteger(context.limit) || context.limit < 1 || context.limit > 100) {
    throw new TypeError("Product discovery limit must be an integer from 1 through 100");
  }
  const envelope = productPageEnvelopeSchema.parse(input);
  if (envelope.data.length > context.limit) {
    throw new TypeError("Product discovery response exceeded its requested bound");
  }
  return canonicalizeSourceRecordOutcomes(envelope.data.map((candidate) =>
    normalizeProductSourceResponse({ data: candidate }, context)));
}

const upstreamPriceAmountSchema = z
  .number().finite().nonnegative()
  .refine((amount) => Number.isSafeInteger(Math.round(amount * 100)) &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6 &&
    Math.round(amount * 100) <= MAX_PERSISTED_PRICE_ORE, {
    message: "Price must be representable as integer øre",
  });

const upstreamPriceStoreSchema = z.object({
  store: z.string().trim().min(1).max(100),
  name: sourceStringSchema,
  current_price: upstreamPriceAmountSchema.nullable(),
  current_unit_price: z.number().finite().nullable(),
  current_unit_price_unit: z.string().trim().max(100).nullable(),
  last_checked: sourceTimestampSchema.nullable(),
});

const upstreamPriceProductSchema = z.object({
  ean: z.string().trim().min(1).max(64),
  name: sourceStringSchema,
  weight: z.number().finite().nullable(),
  weight_unit: z.string().trim().max(32).nullable(),
  stores: z.array(z.unknown()).max(MAX_STORES_PER_PRODUCT),
  price_history: z.array(z.object({
    price: z.number().finite(),
    date: z.iso.date(),
    store: z.string().trim().min(1).max(100),
  })).max(10_000),
});

const priceEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(MAX_PRICE_PRODUCTS),
  meta: z.object({
    requested_eans: z.number().int().nonnegative(),
    found_products: z.number().int().nonnegative(),
    days_included: z.number().int().nonnegative(),
    is_premium: z.boolean(),
  }),
});

export interface PriceNormalizationContext {
  expectedEans?: readonly string[];
  now: Date;
  retrievedAt: string;
}

function priceSourceRecordId(
  ean: string,
  chainCode: string,
  observationKind: "current" | "historical",
  observedAt: string,
  amountOre: number | undefined,
): string {
  const identity = [
    ean,
    chainCode,
    observationKind,
    observedAt,
  ];
  if (observationKind === "historical") {
    identity.push(amountOre === undefined ? "missing" : amountOre.toString());
  }
  return identity.join(":");
}

export function normalizePriceSourceResponse(
  input: unknown,
  context: PriceNormalizationContext,
): SourceRecordOutcome<KassalappPriceSourceRecordV1>[] {
  const { nowMs, retrievedAt } = contextTimestamp(context.now, context.retrievedAt);
  const envelope = priceEnvelopeSchema.parse(input);
  const expectedEans = context.expectedEans === undefined ? undefined : new Set(context.expectedEans);
  const outcomes: SourceRecordOutcome<KassalappPriceSourceRecordV1>[] = [];
  const returnedEans = new Set<string>();
  const returnedSupportedChainsByEan = new Map<string, Set<string>>();

  for (const [productIndex, candidateProduct] of envelope.data.entries()) {
    const product = upstreamPriceProductSchema.safeParse(candidateProduct);
    if (!product.success) {
      const candidateEan = (candidateProduct as { ean?: unknown })?.ean;
      outcomes.push({
        ...(typeof candidateEan === "string" && isValidGtin(candidateEan)
          ? { ean: candidateEan }
          : {}),
        state: "quarantined",
        sourceRecordId: `price-product-${productIndex}`,
        reason: "MALFORMED_RECORD",
      });
      continue;
    }

    const ean = product.data.ean;
    if (!isValidGtin(ean)) {
      outcomes.push({ state: "quarantined", sourceRecordId: ean, reason: "INVALID_GTIN" });
      continue;
    }
    if (expectedEans !== undefined && !expectedEans.has(ean)) {
      outcomes.push({ state: "quarantined", sourceRecordId: ean, reason: "IDENTIFIER_MISMATCH" });
      continue;
    }
    returnedEans.add(ean);
    const returnedSupportedChains = returnedSupportedChainsByEan.get(ean) ?? new Set<string>();
    returnedSupportedChainsByEan.set(ean, returnedSupportedChains);

    for (const [storeIndex, candidateStore] of product.data.stores.entries()) {
      const store = upstreamPriceStoreSchema.safeParse(candidateStore);
      const fallbackRecordId = `${ean}:store-${storeIndex}`;
      if (!store.success) {
        const candidateChainCode = (candidateStore as { store?: unknown })?.store;
        const chainCode = typeof candidateChainCode === "string"
          ? candidateChainCode.trim()
          : undefined;
        const chainId = chainCode === undefined ? undefined : CHAIN_BY_CODE[chainCode];
        outcomes.push({
          ean,
          ...(chainCode === undefined || chainCode === "" ? {} : { chainCode }),
          ...(chainId === undefined ? {} : { chainId }),
          state: "quarantined",
          sourceRecordId: fallbackRecordId,
          reason: "MALFORMED_RECORD",
        });
        continue;
      }

      const chainCode = store.data.store;
      const chainId = CHAIN_BY_CODE[chainCode];
      const observedAt = store.data.last_checked === null
        ? "unknown-time"
        : canonicalSourceTimestamp(store.data.last_checked);
      const amountOre = store.data.current_price === null
        ? undefined
        : Math.round(store.data.current_price * 100);
      const sourceRecordId = priceSourceRecordId(
        ean,
        chainCode,
        "current",
        observedAt,
        amountOre,
      );
      if (chainId === undefined) {
        outcomes.push({
          chainCode,
          ean,
          state: "quarantined",
          sourceRecordId,
          reason: "UNKNOWN_CHAIN",
        });
        continue;
      }
      returnedSupportedChains.add(chainCode);
      if (store.data.last_checked === null) {
        outcomes.push({
          chainId,
          ean,
          state: "unknown",
          sourceRecordId,
          reason: "MISSING_TIMESTAMP",
          chainCode,
        });
        continue;
      }
      if (timestampIsFuture(observedAt, nowMs)) {
        outcomes.push({
          chainCode,
          chainId,
          ean,
          state: "quarantined",
          sourceRecordId,
          reason: "FUTURE_TIMESTAMP",
        });
        continue;
      }
      if (store.data.current_price === null) {
        outcomes.push({
          chainCode,
          chainId,
          ean,
          state: "unknown",
          sourceRecordId,
          reason: "MISSING_PRICE",
        });
        continue;
      }

      outcomes.push({
        state: "accepted",
        record: {
          ...sourceBase(sourceRecordId, retrievedAt),
          kind: "price",
          ean,
          chainId,
          chainCode,
          amountOre: amountOre!,
          observationKind: "current",
          observedAt,
        },
      });
    }

  }

  for (const ean of [...returnedEans].sort()) {
    const returnedSupportedChains = returnedSupportedChainsByEan.get(ean) ?? new Set<string>();
    for (const [chainCode] of Object.entries(CHAIN_BY_CODE)) {
      if (returnedSupportedChains.has(chainCode)) continue;
      outcomes.push({
        chainId: CHAIN_BY_CODE[chainCode]!,
        ean,
        state: "unknown",
        sourceRecordId: `${ean}:${chainCode}:current:coverage`,
        reason: "MISSING_SUPPORTED_CHAIN",
        chainCode,
      });
    }
  }

  if (expectedEans !== undefined) {
    for (const ean of expectedEans) {
      if (!returnedEans.has(ean)) {
        outcomes.push({
          ean,
          state: "unknown",
          sourceRecordId: ean,
          reason: "MISSING_REQUESTED_EAN",
        });
      }
    }
  }

  return canonicalizeSourceRecordOutcomes(outcomes);
}

export function normalizeHistoricalPriceSourceResponse(
  input: unknown,
  context: PriceNormalizationContext,
): SourceRecordOutcome<KassalappPriceSourceRecordV1>[] {
  const { nowMs, retrievedAt } = contextTimestamp(context.now, context.retrievedAt);
  const envelope = priceEnvelopeSchema.parse(input);
  const expectedEans = context.expectedEans === undefined ? undefined : new Set(context.expectedEans);
  const outcomes: SourceRecordOutcome<KassalappPriceSourceRecordV1>[] = [];
  const returnedEans = new Set<string>();

  for (const [productIndex, candidateProduct] of envelope.data.entries()) {
    const product = upstreamPriceProductSchema.safeParse(candidateProduct);
    if (!product.success) {
      const candidateEan = (candidateProduct as { ean?: unknown })?.ean;
      outcomes.push({
        ...(typeof candidateEan === "string" && isValidGtin(candidateEan)
          ? { ean: candidateEan }
          : {}),
        state: "quarantined",
        sourceRecordId: `historical-price-product-${productIndex}`,
        reason: "MALFORMED_RECORD",
      });
      continue;
    }

    const ean = product.data.ean;
    if (!isValidGtin(ean)) {
      outcomes.push({ state: "quarantined", sourceRecordId: ean, reason: "INVALID_GTIN" });
      continue;
    }
    if (expectedEans !== undefined && !expectedEans.has(ean)) {
      outcomes.push({
        ean,
        state: "quarantined",
        sourceRecordId: ean,
        reason: "IDENTIFIER_MISMATCH",
      });
      continue;
    }
    returnedEans.add(ean);

    for (const history of product.data.price_history) {
      const chainCode = history.store;
      const chainId = CHAIN_BY_CODE[chainCode];
      const observedAt = `${history.date}T00:00:00.000Z`;
      const parsedAmount = upstreamPriceAmountSchema.safeParse(history.price);
      const amountOre = parsedAmount.success
        ? Math.round(parsedAmount.data * 100)
        : undefined;
      const sourceRecordId = priceSourceRecordId(
        ean,
        chainCode,
        "historical",
        observedAt,
        amountOre,
      );

      if (chainId === undefined) {
        outcomes.push({
          chainCode,
          ean,
          state: "quarantined",
          sourceRecordId,
          reason: "UNKNOWN_CHAIN",
        });
        continue;
      }
      if (!parsedAmount.success) {
        outcomes.push({
          chainCode,
          chainId,
          ean,
          state: "quarantined",
          sourceRecordId,
          reason: "MALFORMED_RECORD",
        });
        continue;
      }
      if (timestampIsFuture(observedAt, nowMs)) {
        outcomes.push({
          chainCode,
          chainId,
          ean,
          state: "quarantined",
          sourceRecordId,
          reason: "FUTURE_TIMESTAMP",
        });
        continue;
      }
      outcomes.push({
        state: "accepted",
        record: {
          ...sourceBase(sourceRecordId, retrievedAt),
          amountOre: amountOre!,
          chainCode,
          chainId,
          ean,
          kind: "price",
          observationKind: "historical",
          observedAt,
        },
      });
    }
  }

  if (expectedEans !== undefined) {
    for (const ean of expectedEans) {
      if (!returnedEans.has(ean)) {
        outcomes.push({
          ean,
          state: "unknown",
          sourceRecordId: ean,
          reason: "MISSING_REQUESTED_EAN",
        });
      }
    }
  }

  return canonicalizeSourceRecordOutcomes(outcomes);
}

const categoryRecordSchema = z.object({
  id: sourceIdentifierSchema,
  parent_id: sourceIdentifierSchema,
  name: sourceStringSchema,
  updated_at: sourceTimestampSchema,
  created_at: sourceTimestampSchema,
});

const labelRecordSchema = z.object({
  name: z.string().trim().min(1).max(200),
  display_name: sourceStringSchema,
  description: z.string().max(20_000),
  organization: z.string().max(500),
  alternative_names: z.string().max(5_000),
  type: z.string().max(200),
  year_established: z.string().max(100),
  about: z.string().max(20_000),
  note: z.string().max(20_000),
  icon: z.object({ svg: z.string().max(5_000), png: z.string().max(5_000) }),
});

const namedListEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(MAX_LIST_RECORDS),
});

export function normalizeCategorySourceResponse(
  input: unknown,
  retrievedAtInput: string,
): SourceRecordOutcome<KassalappCategorySourceRecordV1>[] {
  const retrievedAt = canonicalTimestampSchema.parse(retrievedAtInput);
  const envelope = namedListEnvelopeSchema.parse(input);
  return canonicalizeSourceRecordOutcomes(envelope.data.map((candidate, index) => {
    const parsed = categoryRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        state: "quarantined" as const,
        sourceRecordId: safeSourceRecordId((candidate as { id?: unknown })?.id, `category-${index}`),
        reason: "MALFORMED_RECORD" as const,
      };
    }
    return {
      state: "accepted" as const,
      record: {
        ...sourceBase(parsed.data.id, retrievedAt),
        kind: "category" as const,
        name: parsed.data.name,
      },
    };
  }));
}

const categoryPageEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(100),
});

export function normalizeCategoryPageSourceResponse(
  input: unknown,
  retrievedAtInput: string,
): KassalappCategorySyncResultV1 {
  const envelope = categoryPageEnvelopeSchema.parse(input);
  const recordCount = envelope.data.length;
  const outcomes = normalizeCategorySourceResponse(envelope, retrievedAtInput);
  return {
    coverage: recordCount === 100
      ? [{ recordCount, reason: "POSSIBLY_TRUNCATED", state: "unknown" }]
      : outcomes.some((outcome) => outcome.state !== "accepted")
        ? [{ recordCount, reason: "INVALID_RECORDS", state: "unknown" }]
        : [{ recordCount, state: "complete" }],
    outcomes,
  };
}

export function normalizeLabelSourceResponse(
  input: unknown,
  retrievedAtInput: string,
): SourceRecordOutcome<KassalappLabelSourceRecordV1>[] {
  const retrievedAt = canonicalTimestampSchema.parse(retrievedAtInput);
  const envelope = namedListEnvelopeSchema.parse(input);
  return canonicalizeSourceRecordOutcomes(envelope.data.map((candidate, index) => {
    const parsed = labelRecordSchema.safeParse(candidate);
    const sourceName = parsed.success ? parsed.data.name : undefined;
    const sourceRecordId = sourceName === undefined ? `label-${index}` : `label:${sourceName}`;
    if (!parsed.success) return { state: "quarantined" as const, sourceRecordId, reason: "MALFORMED_RECORD" as const };
    return {
      state: "accepted" as const,
      record: {
        ...sourceBase(sourceRecordId, retrievedAt),
        kind: "label" as const,
        name: parsed.data.display_name,
        sourceName: parsed.data.name,
      },
    };
  }));
}

const openingHoursSchema = z.object({
  monday: z.string().max(100).nullable(),
  tuesday: z.string().max(100).nullable(),
  wednesday: z.string().max(100).nullable(),
  thursday: z.string().max(100).nullable(),
  friday: z.string().max(100).nullable(),
  saturday: z.string().max(100).nullable(),
  sunday: z.string().max(100).nullable(),
});

const upstreamPhysicalStoreSchema = z.object({
  id: z.number().int().safe().positive().transform(String),
  group: z.string().trim().min(1).max(100).nullable(),
  name: sourceStringSchema,
  address: sourceStringSchema,
  phone: z.string().max(500).nullable(),
  email: z.string().max(500).nullable(),
  fax: z.string().max(500).nullable(),
  logo: z.string().max(5_000),
  website: z.string().max(5_000).nullable(),
  detailUrl: z.string().max(5_000),
  position: z.object({
    lat: z.number().finite().min(-90).max(90).nullable(),
    lng: z.number().finite().min(-180).max(180).nullable(),
  }),
  openingHours: openingHoursSchema,
}).superRefine(({ position }, issue) => {
  if ((position.lat === null) !== (position.lng === null)) {
    issue.addIssue({ code: "custom", message: "Coordinates must be a complete pair", path: ["position"] });
  }
});

function postalCodeFromAddress(address: string): string | undefined {
  const matches = [...address.matchAll(/(?:^|,)\s*([0-9]{4})(?=\s|$)/gu)]
    .map((match) => match[1]!)
    .filter((postalCode, index, values) => values.indexOf(postalCode) === index);
  return matches.length === 1 ? matches[0] : undefined;
}

export interface PhysicalStoreNormalizationContext {
  now: Date;
  retrievedAt: string;
}

export type PhysicalStoreCoverageReason =
  | "DUPLICATE_IDENTITY"
  | "INVALID_RECORDS"
  | "MISSING_SUPPORTED_CHAIN"
  | "POSSIBLY_TRUNCATED"
  | "REQUEST_FAILED";

export type KassalappPhysicalStoreCoverageV1 = {
  chainId: KassalappChainId;
  chainCode: string;
  recordCount: number;
} & (
  | { state: "complete" }
  | { state: "unknown"; reason: PhysicalStoreCoverageReason }
);

export interface KassalappPhysicalStoreSyncResultV1 {
  outcomes: Array<SourceRecordOutcome<KassalappPhysicalStoreSourceRecordV1>>;
  coverage: KassalappPhysicalStoreCoverageV1[];
}

export function normalizePhysicalStoreSourceResponse(
  input: unknown,
  context: PhysicalStoreNormalizationContext,
): SourceRecordOutcome<KassalappPhysicalStoreSourceRecordV1>[] {
  const { retrievedAt } = contextTimestamp(context.now, context.retrievedAt);
  const envelope = namedListEnvelopeSchema.parse(input);
  return canonicalizeSourceRecordOutcomes(envelope.data.map((candidate, index) => {
    const parsed = upstreamPhysicalStoreSchema.safeParse(candidate);
    const sourceRecordId = safeSourceRecordId((candidate as { id?: unknown })?.id, `physical-store-${index}`);
    if (!parsed.success) {
      const candidateChainCode = (candidate as { group?: unknown })?.group;
      const chainCode = typeof candidateChainCode === "string"
        ? candidateChainCode.trim()
        : undefined;
      const chainId = chainCode === undefined ? undefined : CHAIN_BY_CODE[chainCode];
      return {
        ...(chainCode === undefined || chainCode === "" ? {} : { chainCode }),
        ...(chainId === undefined ? {} : { chainId }),
        state: "quarantined",
        sourceRecordId,
        reason: "MALFORMED_RECORD",
      };
    }

    const chainCode = parsed.data.group;
    if (chainCode === null) {
      return { state: "quarantined", sourceRecordId, reason: "UNKNOWN_CHAIN" };
    }
    const chainId = CHAIN_BY_CODE[chainCode];
    if (chainId === undefined) {
      return { state: "quarantined", sourceRecordId, reason: "UNKNOWN_CHAIN", chainCode };
    }
    const postalCode = postalCodeFromAddress(parsed.data.address);
    return {
      state: "accepted",
      record: {
        ...sourceBase(sourceRecordId, retrievedAt),
        kind: "physical-store",
        name: parsed.data.name,
        chainId,
        chainCode,
        address: parsed.data.address,
        ...(postalCode === undefined ? {} : { postalCode }),
        ...(parsed.data.position.lat === null ? {} : {
          latitude: parsed.data.position.lat,
          longitude: parsed.data.position.lng!,
        }),
      },
    };
  }));
}

const physicalStorePageEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(100),
});

export function normalizePhysicalStorePageSourceResponse(
  input: unknown,
  context: PhysicalStoreNormalizationContext & { expectedChainCode: string },
): KassalappPhysicalStoreSyncResultV1 {
  const envelope = physicalStorePageEnvelopeSchema.parse(input);
  const expectedChainId = CHAIN_BY_CODE[context.expectedChainCode];
  if (expectedChainId === undefined) throw new Error("Unsupported physical-store chain");
  const normalized = normalizePhysicalStoreSourceResponse(envelope, context).map((outcome) => {
    if (outcome.state !== "accepted" || outcome.record.chainCode === context.expectedChainCode) return outcome;
    return {
      state: "quarantined" as const,
      sourceRecordId: outcome.record.sourceRecordId,
      reason: "IDENTIFIER_MISMATCH" as const,
      chainCode: outcome.record.chainCode,
      chainId: outcome.record.chainId,
    };
  });
  const recordCount = envelope.data.length;
  const acceptedExpectedChainCount = normalized.filter((outcome) =>
    outcome.state === "accepted" && outcome.record.chainCode === context.expectedChainCode).length;
  const coverage: KassalappPhysicalStoreCoverageV1 = recordCount === 0
    ? {
        chainCode: context.expectedChainCode,
        chainId: expectedChainId,
        recordCount,
        reason: "MISSING_SUPPORTED_CHAIN",
        state: "unknown",
      }
    : recordCount === 100
      ? {
          chainCode: context.expectedChainCode,
          chainId: expectedChainId,
          recordCount,
          reason: "POSSIBLY_TRUNCATED",
          state: "unknown",
        }
      : acceptedExpectedChainCount === 0
        ? {
            chainCode: context.expectedChainCode,
            chainId: expectedChainId,
            recordCount,
            reason: "MISSING_SUPPORTED_CHAIN",
            state: "unknown",
          }
        : normalized.some((outcome) => outcome.state !== "accepted")
          ? {
              chainCode: context.expectedChainCode,
              chainId: expectedChainId,
              recordCount,
              reason: "INVALID_RECORDS",
              state: "unknown",
            }
          : {
              chainCode: context.expectedChainCode,
              chainId: expectedChainId,
              recordCount,
              state: "complete",
            };
  return { coverage: [coverage], outcomes: canonicalizeSourceRecordOutcomes(normalized) };
}
