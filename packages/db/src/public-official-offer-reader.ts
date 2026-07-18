import {
  exactProductPlanApiEvidenceSourceSchema,
  geographicScopeSchema,
  isFiniteDate,
  officialOfferSchema,
  type ExactProductPlanApiEvidenceSource,
  type GeographicScope,
  type MoneyOre,
  type OfficialOffer,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

const MAX_PRODUCTS = 50;
const MAX_OFFERS_PER_PRODUCT = 50;
const MAX_TOTAL_OFFERS = 500;
const MAX_SOURCES = 100;
const MAX_RAW_ROWS = MAX_TOTAL_OFFERS + 1;
const MAX_SAFE_DATABASE_ID = 9_007_199_254_740_991n;

export type PublicOfficialOfferReaderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

const errorMessages: Readonly<Record<PublicOfficialOfferReaderErrorCode, string>> = {
  CANCELLED: "Public official-offer request cancelled",
  INVALID_REQUEST: "Public official-offer request is invalid",
  UNAVAILABLE: "Public official-offer evidence is unavailable",
};

export class PublicOfficialOfferReaderError extends Error {
  constructor(readonly code: PublicOfficialOfferReaderErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicOfficialOfferReaderError";
  }
}

export interface PublicOfficialOfferSnapshot {
  offers: OfficialOffer[];
  sources: ExactProductPlanApiEvidenceSource[];
}

export interface PublicOfficialOfferReader {
  getMany(
    canonicalProductIds: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicOfficialOfferSnapshot>;
}

export interface PublicOfficialOfferRow {
  amount_ore: unknown;
  before_amount_ore: unknown;
  captured_at: unknown;
  chain: unknown;
  channels: unknown;
  geographic_scope: unknown;
  member_program_id: unknown;
  membership_requirement: unknown;
  multibuy_group_amount_ore: unknown;
  multibuy_quantity: unknown;
  offer_id: unknown;
  product_id: unknown;
  product_offer_count: unknown;
  source_display_name: unknown;
  source_id: unknown;
  source_record_id: unknown;
  total_offer_count: unknown;
  valid_from: unknown;
  valid_until: unknown;
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readerError(code: PublicOfficialOfferReaderErrorCode): PublicOfficialOfferReaderError {
  return new PublicOfficialOfferReaderError(code);
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw readerError("CANCELLED");
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw readerError("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function databaseId(value: unknown): string | undefined {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : undefined;
  if (text === undefined || !/^[1-9][0-9]{0,15}$/u.test(text)) return undefined;
  const parsed = BigInt(text);
  return parsed <= MAX_SAFE_DATABASE_ID ? text : undefined;
}

function canonicalProductDatabaseId(value: string): string | undefined {
  const match = /^product:([1-9][0-9]{0,15})$/u.exec(value);
  if (match === null) return undefined;
  return BigInt(match[1]!) <= MAX_SAFE_DATABASE_ID ? match[1] : undefined;
}

function validatedDatabaseProductIds(
  canonicalProductIds: readonly string[],
  at: Date,
): string[] | undefined {
  if (
    !Array.isArray(canonicalProductIds)
    || canonicalProductIds.length < 1
    || canonicalProductIds.length > MAX_PRODUCTS
    || new Set(canonicalProductIds).size !== canonicalProductIds.length
    || !(at instanceof Date)
    || !isFiniteDate(at)
  ) {
    return undefined;
  }
  const databaseProductIds = canonicalProductIds.map(canonicalProductDatabaseId);
  return databaseProductIds.some((id) => id === undefined)
    ? undefined
    : databaseProductIds as string[];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function positiveCount(value: unknown): number | undefined {
  const id = databaseId(value);
  if (id === undefined) return undefined;
  const count = Number(id);
  return Number.isSafeInteger(count) ? count : undefined;
}

function databaseDate(value: unknown): Date | undefined {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : undefined;
  return date !== undefined && isFiniteDate(date) ? date : undefined;
}

function canonicalChannels(value: unknown): ("in-store" | "online")[] | undefined {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 2
    || new Set(value).size !== value.length
    || value.some((entry) => entry !== "in-store" && entry !== "online")
  ) {
    return undefined;
  }
  return [...value].sort((left, right) =>
    (left === "in-store" ? 0 : 1) - (right === "in-store" ? 0 : 1),
  ) as ("in-store" | "online")[];
}

function canonicalGeographicScope(value: unknown): GeographicScope | undefined {
  let candidate = value;
  if (isRecord(value) && value.kind === "stores") {
    if (!Array.isArray(value.storeIds)) return undefined;
    const storeIds = value.storeIds.map(databaseId);
    if (storeIds.some((entry) => entry === undefined)) return undefined;
    candidate = {
      kind: "stores",
      storeIds: (storeIds as string[]).map((id) => `store:${id}`).sort(compareText),
    };
  }
  const parsed = geographicScopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && value.trim() === value
    ? value
    : undefined;
}

function offerAndSourceFromRow(
  row: PublicOfficialOfferRow,
  at: Date,
): { offer: OfficialOffer; source: ExactProductPlanApiEvidenceSource } | undefined {
  const offerId = databaseId(row.offer_id);
  const productId = databaseId(row.product_id);
  const sourceId = boundedText(row.source_id, 64);
  const sourceDisplayName = boundedText(row.source_display_name, 160);
  const sourceRecordId = typeof row.source_record_id === "string"
    && /^official-source-record:[0-9a-f]{64}$/u.test(row.source_record_id)
    ? row.source_record_id
    : undefined;
  const chain = boundedText(row.chain, 32);
  const amountOre = nonNegativeInteger(row.amount_ore);
  const beforeAmountOre = row.before_amount_ore === null
    ? undefined
    : nonNegativeInteger(row.before_amount_ore);
  const multibuyQuantity = row.multibuy_quantity === null
    ? undefined
    : nonNegativeInteger(row.multibuy_quantity);
  const multibuyTotalOre = row.multibuy_group_amount_ore === null
    ? undefined
    : nonNegativeInteger(row.multibuy_group_amount_ore);
  const validFrom = databaseDate(row.valid_from);
  const validUntil = databaseDate(row.valid_until);
  const capturedAt = databaseDate(row.captured_at);
  const geographicScope = canonicalGeographicScope(row.geographic_scope);
  const channels = canonicalChannels(row.channels);
  if (
    offerId === undefined
    || productId === undefined
    || sourceId === undefined
    || sourceDisplayName === undefined
    || sourceRecordId === undefined
    || chain === undefined
    || amountOre === undefined
    || (row.before_amount_ore !== null && beforeAmountOre === undefined)
    || (multibuyQuantity === undefined) !== (multibuyTotalOre === undefined)
    || validFrom === undefined
    || validUntil === undefined
    || capturedAt === undefined
    || capturedAt > at
    || validFrom > at
    || validUntil <= at
    || geographicScope === undefined
    || channels === undefined
  ) {
    return undefined;
  }

  const membershipRequirement = row.membership_requirement;
  let conditions: OfficialOffer["conditions"];
  if (membershipRequirement === "public" && row.member_program_id === null) {
    conditions = [{ kind: "public" }];
  } else if (membershipRequirement === "member" && typeof row.member_program_id === "string") {
    conditions = [{ kind: "member", programId: row.member_program_id }];
  } else {
    return undefined;
  }

  let pricing: OfficialOffer["pricing"];
  if (multibuyQuantity === undefined && multibuyTotalOre === undefined) {
    pricing = { kind: "unit", unitPriceOre: amountOre as MoneyOre };
  } else {
    if (multibuyQuantity! < 2 || multibuyQuantity! > 100) return undefined;
    const quantity = BigInt(multibuyQuantity!);
    const total = BigInt(multibuyTotalOre!);
    const expectedUnitAmount = (total + quantity - 1n) / quantity;
    if (BigInt(amountOre) !== expectedUnitAmount) return undefined;
    if (
      beforeAmountOre !== undefined
      && (
        BigInt(beforeAmountOre) * quantity > MAX_SAFE_DATABASE_ID
        || BigInt(beforeAmountOre) * quantity < total
      )
    ) {
      return undefined;
    }
    pricing = {
      kind: "multibuy",
      quantity: multibuyQuantity!,
      totalOre: multibuyTotalOre! as MoneyOre,
    };
    conditions.push({ kind: "minimum-quantity", quantity: multibuyQuantity! });
  }

  const source = exactProductPlanApiEvidenceSourceSchema.safeParse({
    contractVersion: 1,
    displayName: sourceDisplayName,
    id: sourceId,
    sourceClass: "offer",
    state: "approved",
  });
  const offer = officialOfferSchema.safeParse({
    applicability: {
      channels,
      contractVersion: 1,
      endsAt: validUntil.toISOString(),
      geographicScope,
      startsAt: validFrom.toISOString(),
    },
    ...(beforeAmountOre === undefined ? {} : { beforePriceOre: beforeAmountOre }),
    capturedAt: capturedAt.toISOString(),
    chainId: chain,
    conditions,
    contractVersion: 1,
    evidenceLevel: "reviewed",
    id: `official-offer:${offerId}`,
    kind: "official-offer",
    pricing,
    productMatch: {
      canonicalProductId: `product:${productId}`,
      kind: "exact",
    },
    sourceId,
    sourceRecordId,
  });
  return source.success && offer.success
    ? { offer: offer.data, source: source.data }
    : undefined;
}

function addSource(
  sources: Map<string, ExactProductPlanApiEvidenceSource>,
  source: ExactProductPlanApiEvidenceSource,
): boolean {
  const previous = sources.get(source.id);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(source)) return false;
  sources.set(source.id, source);
  return true;
}

/** Explicit deterministic fake/test boundary; never used by real composition. */
export class EmptyPublicOfficialOfferReader implements PublicOfficialOfferReader {
  async getMany(
    canonicalProductIds: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicOfficialOfferSnapshot> {
    if (signal?.aborted) throw readerError("CANCELLED");
    if (validatedDatabaseProductIds(canonicalProductIds, at) === undefined) {
      throw readerError("INVALID_REQUEST");
    }
    return { offers: [], sources: [] };
  }
}

export class PostgresPublicOfficialOfferReader implements PublicOfficialOfferReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getMany(
    canonicalProductIds: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicOfficialOfferSnapshot> {
    if (signal?.aborted) throw readerError("CANCELLED");
    const databaseProductIds = validatedDatabaseProductIds(canonicalProductIds, at);
    if (databaseProductIds === undefined) {
      throw readerError("INVALID_REQUEST");
    }
    const requestedIds = new Set(canonicalProductIds);
    const sortedDatabaseProductIds = databaseProductIds.sort((left, right) =>
      BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
    );
    // IDs have already passed the positive-safe-integer grammar above. Bind a
    // canonical array literal as text: postgres.js 3.4.9 does not reliably
    // serialize an Array Parameter after PostgreSQL resolves the explicit
    // bigint[] cast in a prepared statement.
    const databaseProductIdArray = `{${sortedDatabaseProductIds.join(",")}}`;

    const query = this.db.$client<PublicOfficialOfferRow[]>`
      select
        offer_id, source_id, source_display_name, source_record_id, chain,
        product_id, amount_ore, before_amount_ore, multibuy_quantity,
        multibuy_group_amount_ore, membership_requirement, member_program_id,
        valid_from, valid_until, geographic_scope, channels, captured_at,
        product_offer_count, total_offer_count
      from public.public_official_offer_rows_v1(
        ${databaseProductIdArray}::bigint[],
        ${at.toISOString()}::timestamptz
      )
    `;

    try {
      const rows = await awaitAbortable(query, signal);
      if (signal?.aborted) throw readerError("CANCELLED");
      if (!Array.isArray(rows) || rows.length > MAX_RAW_ROWS) {
        throw readerError("UNAVAILABLE");
      }
      const offers = new Map<string, OfficialOffer>();
      const sources = new Map<string, ExactProductPlanApiEvidenceSource>();
      const actualProductCounts = new Map<string, number>();
      const reportedProductCounts = new Map<string, number>();
      let reportedTotal: number | undefined;
      for (const candidate of rows as unknown[]) {
        if (!isRecord(candidate)) throw readerError("UNAVAILABLE");
        const row = candidate as unknown as PublicOfficialOfferRow;
        const mapped = offerAndSourceFromRow(row, at);
        const productCount = positiveCount(row.product_offer_count);
        const totalCount = positiveCount(row.total_offer_count);
        if (mapped === undefined || productCount === undefined || totalCount === undefined) {
          throw readerError("UNAVAILABLE");
        }
        const canonicalProductId = mapped.offer.productMatch.kind === "exact"
          ? mapped.offer.productMatch.canonicalProductId
          : undefined;
        if (
          canonicalProductId === undefined
          || !requestedIds.has(canonicalProductId)
          || productCount > MAX_OFFERS_PER_PRODUCT
          || totalCount > MAX_TOTAL_OFFERS
          || offers.has(mapped.offer.id)
          || !addSource(sources, mapped.source)
          || sources.size > MAX_SOURCES
        ) {
          throw readerError("UNAVAILABLE");
        }
        const previousProductCount = reportedProductCounts.get(canonicalProductId);
        if (
          (reportedTotal !== undefined && reportedTotal !== totalCount)
          || (previousProductCount !== undefined && previousProductCount !== productCount)
        ) {
          throw readerError("UNAVAILABLE");
        }
        reportedTotal = totalCount;
        reportedProductCounts.set(canonicalProductId, productCount);
        actualProductCounts.set(
          canonicalProductId,
          (actualProductCounts.get(canonicalProductId) ?? 0) + 1,
        );
        offers.set(mapped.offer.id, mapped.offer);
      }
      if (rows.length > 0 && reportedTotal !== rows.length) {
        throw readerError("UNAVAILABLE");
      }
      for (const [productId, count] of actualProductCounts) {
        if (reportedProductCounts.get(productId) !== count) {
          throw readerError("UNAVAILABLE");
        }
      }
      return {
        offers: [...offers.values()].sort((left, right) => {
          const leftProduct = left.productMatch.kind === "exact"
            ? left.productMatch.canonicalProductId
            : "";
          const rightProduct = right.productMatch.kind === "exact"
            ? right.productMatch.canonicalProductId
            : "";
          return compareText(leftProduct, rightProduct)
            || compareText(left.applicability.endsAt, right.applicability.endsAt)
            || compareText(left.id, right.id);
        }),
        sources: [...sources.values()].sort((left, right) => compareText(left.id, right.id)),
      };
    } catch (error) {
      if (error instanceof PublicOfficialOfferReaderError) throw error;
      if (signal?.aborted) throw readerError("CANCELLED");
      throw readerError("UNAVAILABLE");
    }
  }
}
