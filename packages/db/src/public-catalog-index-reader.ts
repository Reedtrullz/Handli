import { createHash } from "node:crypto";

import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  isFiniteDate,
  isValidGtin,
  exactProductPlanApiProductSummarySchema,
  type ExactProductPlanApiEvidenceSource,
  type ExactProductPlanApiProductSummary,
} from "@handleplan/domain";

import {
  ActiveCatalogReaderError,
  awaitAbortableCatalogQuery,
  catalogSummaryFromRow,
  classifyCatalogRow,
  compareCatalogText,
  normalizeCatalogEligibilityRow,
  type CatalogEligibilityRow,
} from "./catalog-reader";
import type { HandleplanDatabase } from "./client";

export type PublicCatalogIndexReaderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

const errorMessages: Readonly<Record<PublicCatalogIndexReaderErrorCode, string>> = {
  CANCELLED: "Public catalog request cancelled",
  INVALID_REQUEST: "Public catalog request is invalid",
  UNAVAILABLE: "Public catalog is unavailable",
};

export class PublicCatalogIndexReaderError extends Error {
  readonly code: PublicCatalogIndexReaderErrorCode;

  constructor(code: PublicCatalogIndexReaderErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicCatalogIndexReaderError";
    this.code = code;
  }
}

export interface PublicCatalogIndexReader {
  browse(
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]>;
  search(
    query: string,
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]>;
}

export interface PublicCatalogCategory {
  /** Opaque, source-scoped identifier. The source category identifier is never public. */
  id: string;
  depth: number;
  name: string;
  sourceId: string;
}

export interface PublicCatalogDiscoveryEntry {
  /** Internal stable keyset position. It is wrapped before crossing the public API. */
  catalogPosition: PublicCatalogDiscoveryPosition;
  categoryPath: PublicCatalogCategory[] | null;
  product: ExactProductPlanApiProductSummary;
}

export interface PublicCatalogDiscoveryPosition {
  gtin: string;
  rank: number;
  sortName: string;
}

export interface PublicCatalogDiscoveryPage {
  entries: PublicCatalogDiscoveryEntry[];
  hasMore: boolean;
  nextPosition?: PublicCatalogDiscoveryPosition;
  scannedCount: number;
}

export interface PublicCatalogCategoryFacet extends PublicCatalogCategory {
  productCount: number;
}

export interface PublicCatalogCategoryFacetDirectory {
  facets: PublicCatalogCategoryFacet[];
  hasMore: boolean;
}

/** Bounded projection returned by migration 040; never exposes pipeline rows. */
interface OfferBackedRow {
  amount_ore: unknown;
  before_amount_ore: unknown;
  brand: unknown;
  captured_at: unknown;
  chain: unknown;
  channels: unknown;
  display_name: unknown;
  geographic_scope: unknown;
  gtin: unknown;
  identifier_verified_at: unknown;
  membership_requirement: unknown;
  multibuy_group_amount_ore: unknown;
  multibuy_quantity: unknown;
  offer_id: unknown;
  package_amount: unknown;
  package_unit: unknown;
  product_id: unknown;
  product_is_offer_backed: unknown;
  source_display_name: unknown;
  source_id: unknown;
  source_record_id: unknown;
  units_per_pack: unknown;
}

export interface PublicCatalogDiscoveryPageOptions {
  categoryId?: string;
  cursor?: PublicCatalogDiscoveryPosition;
  limit: number;
  query?: string;
}

/** Separate from the established summary reader so existing consumers remain unchanged. */
export interface PublicCatalogDiscoveryIndexReader {
  readDiscoveryPage(
    options: PublicCatalogDiscoveryPageOptions,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicCatalogDiscoveryPage>;
  categoryFacets(
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicCatalogCategoryFacetDirectory>;
}

interface DiscoveryCatalogEligibilityRow extends CatalogEligibilityRow {
  category_path: unknown;
  sort_name: unknown;
  sort_rank: unknown;
}

interface CategoryFacetRow {
  catalog_source_id: unknown;
  category_variants: unknown;
  product_count: unknown;
}

interface OfferBackedCatalogEligibilityRow extends CatalogEligibilityRow {
  category_path: null;
  sort_name: string;
  sort_rank: number;
}

interface CanonicalCategoryPathEntry {
  depth: number;
  name: string;
  sourceCategoryId: string;
}

const PUBLIC_CATEGORY_ID_PREFIX = "category:";
const PUBLIC_CATEGORY_ID_PATTERN = /^category:[0-9a-f]{64}$/u;
const CATEGORY_PATH_MAX_ENTRIES = 100;
const CATEGORY_DEPTH_MAXIMUM = 100;
const CATEGORY_NAME_MAX_LENGTH = 500;
const SOURCE_ID_MAX_LENGTH = 64;
const CANONICAL_SOURCE_CATEGORY_ID = /^(?:0|[1-9][0-9]*)$/u;
const DISCOVERY_SCAN_LIMIT_MAXIMUM = 50;
const DISCOVERY_SORT_NAME_MAX_LENGTH = 500;
const OFFICIAL_OFFER_SOURCE_RECORD_PREFIX = "official-source-record:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCatalogText);
  const sortedExpected = [...expected].sort(compareCatalogText);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function canonicalIdentifier(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length >= 1 && value.length <= maximumLength ? value : undefined;
}

function canonicalCategoryName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length >= 1
    && value.length <= CATEGORY_NAME_MAX_LENGTH
    && value.trim() === value
    ? value
    : undefined;
}

function parseCategoryPathEntry(value: unknown): CanonicalCategoryPathEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sourceCategoryId", "depth", "name"])) {
    return undefined;
  }
  const sourceCategoryId = typeof value.sourceCategoryId === "string"
    && CANONICAL_SOURCE_CATEGORY_ID.test(value.sourceCategoryId)
    && Number.isSafeInteger(Number(value.sourceCategoryId))
    && String(Number(value.sourceCategoryId)) === value.sourceCategoryId
    ? value.sourceCategoryId
    : undefined;
  const name = canonicalCategoryName(value.name);
  if (
    sourceCategoryId === undefined
    || name === undefined
    || !Number.isSafeInteger(value.depth)
    || (value.depth as number) < 0
    || (value.depth as number) > CATEGORY_DEPTH_MAXIMUM
  ) {
    return undefined;
  }
  return { depth: value.depth as number, name, sourceCategoryId };
}

function publicCategoryId(sourceId: string, sourceCategoryId: string): string {
  const digest = createHash("sha256")
    .update(Buffer.byteLength(sourceId, "utf8").toString())
    .update(":")
    .update(sourceId)
    .update(sourceCategoryId)
    .digest("hex");
  return `${PUBLIC_CATEGORY_ID_PREFIX}${digest}`;
}

function parseCategoryPath(
  value: unknown,
  sourceId: string,
): PublicCatalogCategory[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > CATEGORY_PATH_MAX_ENTRIES) return undefined;

  const path: PublicCatalogCategory[] = [];
  const sourceCategoryIds = new Set<string>();
  const publicIds = new Set<string>();
  let previous: CanonicalCategoryPathEntry | undefined;
  for (const candidate of value) {
    const entry = parseCategoryPathEntry(candidate);
    if (
      entry === undefined
      || sourceCategoryIds.has(entry.sourceCategoryId)
      || (previous !== undefined && (
        previous.depth > entry.depth
        || (
          previous.depth === entry.depth
          && Number(previous.sourceCategoryId) >= Number(entry.sourceCategoryId)
        )
      ))
    ) {
      return undefined;
    }
    const id = publicCategoryId(sourceId, entry.sourceCategoryId);
    if (publicIds.has(id)) return undefined;
    sourceCategoryIds.add(entry.sourceCategoryId);
    publicIds.add(id);
    previous = entry;
    path.push({ depth: entry.depth, id, name: entry.name, sourceId });
  }
  return path;
}

function parsePublicCategoryId(value: unknown): string | undefined {
  return typeof value === "string" && PUBLIC_CATEGORY_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function compareDiscovery(
  left: PublicCatalogDiscoveryEntry,
  right: PublicCatalogDiscoveryEntry,
): number {
  return compareBrowse(left.product, right.product);
}

function compareCategoryFacet(
  left: PublicCatalogCategoryFacet,
  right: PublicCatalogCategoryFacet,
): number {
  return left.depth - right.depth
    || compareCatalogText(left.name, right.name)
    || compareCatalogText(left.sourceId, right.sourceId)
    || compareCatalogText(left.id, right.id);
}

function validLimit(limit: number, maximum: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum;
}

function parseDiscoveryPosition(value: unknown): PublicCatalogDiscoveryPosition | undefined {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ["gtin", "rank", "sortName"])
    || typeof value.gtin !== "string"
    || !isValidGtin(value.gtin)
    || !Number.isSafeInteger(value.rank)
    || (value.rank as number) < 0
    || (value.rank as number) > 4
    || typeof value.sortName !== "string"
    || value.sortName.length < 1
    || value.sortName.length > DISCOVERY_SORT_NAME_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    gtin: value.gtin,
    rank: value.rank as number,
    sortName: value.sortName,
  };
}

function positionFromRow(row: DiscoveryCatalogEligibilityRow): PublicCatalogDiscoveryPosition {
  return parseDiscoveryPosition({
    gtin: row.gtin,
    rank: row.sort_rank,
    sortName: row.sort_name,
  }) ?? (() => { throw new PublicCatalogIndexReaderError("UNAVAILABLE"); })();
}

function normalizeQuery(query: string): string | undefined {
  if (typeof query !== "string") return undefined;
  const normalized = query.trim();
  return normalized.length >= 2 && normalized.length <= 120 ? normalized : undefined;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function summaryMatchesQuery(
  summary: ExactProductPlanApiProductSummary,
  query: string,
): boolean {
  const normalized = query.toLocaleLowerCase("nb-NO");
  return summary.gtin === query
    || summary.displayName.toLocaleLowerCase("nb-NO").includes(normalized)
    || summary.brand?.toLocaleLowerCase("nb-NO").includes(normalized) === true;
}

function compareBrowse(
  left: ExactProductPlanApiProductSummary,
  right: ExactProductPlanApiProductSummary,
): number {
  return compareCatalogText(left.displayName.toLocaleLowerCase("nb-NO"), right.displayName.toLocaleLowerCase("nb-NO"))
    || compareCatalogText(left.gtin, right.gtin);
}

function searchRank(summary: ExactProductPlanApiProductSummary, query: string): number {
  const normalized = query.toLocaleLowerCase("nb-NO");
  const name = summary.displayName.toLocaleLowerCase("nb-NO");
  const brand = summary.brand?.toLocaleLowerCase("nb-NO");
  if (summary.gtin === query || name === normalized) return 0;
  if (name.startsWith(normalized)) return 1;
  if (brand === normalized) return 2;
  if (brand?.startsWith(normalized) === true) return 3;
  return 4;
}

function databaseTimestamp(value: unknown): Date | undefined {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : undefined;
  return date !== undefined && isFiniteDate(date) ? date : undefined;
}

function offerBackedSummaryFromRow(
  row: OfferBackedRow,
): ExactProductPlanApiProductSummary {
  const gtin = typeof row.gtin === "string" && isValidGtin(row.gtin)
    ? row.gtin
    : undefined;
  const sourceId = canonicalIdentifier(row.source_id, SOURCE_ID_MAX_LENGTH);
  const displayName = canonicalIdentifier(row.display_name, 240);
  const brand = row.brand === null ? undefined : canonicalIdentifier(row.brand, 160);
  const packageAmount = Number.isSafeInteger(row.package_amount)
    && (row.package_amount as number) > 0
    ? row.package_amount as number
    : undefined;
  const packageUnit = row.package_unit === "g"
    || row.package_unit === "ml"
    || row.package_unit === "piece"
    || row.package_unit === "package"
    ? row.package_unit
    : undefined;
  const unitsPerPack = Number.isSafeInteger(row.units_per_pack)
    && (row.units_per_pack as number) > 0
    ? row.units_per_pack as number
    : undefined;
  const capturedAt = databaseTimestamp(row.captured_at);
  const verifiedAt = databaseTimestamp(row.identifier_verified_at);
  const sourceDisplayName = canonicalIdentifier(row.source_display_name, 160);
  const sourceRecordId = typeof row.source_record_id === "string"
    && row.source_record_id.startsWith(OFFICIAL_OFFER_SOURCE_RECORD_PREFIX)
    ? row.source_record_id.slice(OFFICIAL_OFFER_SOURCE_RECORD_PREFIX.length)
    : undefined;
  if (
    gtin === undefined
    || sourceId === undefined
    || displayName === undefined
    || unitsPerPack === undefined
    || capturedAt === undefined
    || verifiedAt === undefined
    || verifiedAt.getTime() > capturedAt.getTime()
    || sourceDisplayName === undefined
    || !/^[0-9a-f]{64}$/u.test(sourceRecordId ?? "")
  ) {
    throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  }

  const parsed = exactProductPlanApiProductSummarySchema.safeParse({
    ...(brand === undefined ? {} : { brand }),
    ...(packageAmount === undefined || packageUnit === undefined
      ? {}
      : { packageMeasure: { amount: packageAmount, unit: packageUnit } }),
    catalogEvidence: {
      observedAt: capturedAt.toISOString(),
      source: {
        contractVersion: 1,
        displayName: sourceDisplayName,
        id: sourceId,
        sourceClass: "offer",
        state: "approved",
      },
      sourceRecordId: `source-record:${sourceRecordId}`,
    },
    displayName,
    gtin,
    unitsPerPack,
  });
  if (!parsed.success) throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  return parsed.data;
}

function offerBackedEligibilityRow(
  row: OfferBackedRow,
): OfferBackedCatalogEligibilityRow {
  if (
    typeof row.product_is_offer_backed !== "boolean"
    || row.product_is_offer_backed !== true
  ) {
    throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  }
  const summary = offerBackedSummaryFromRow(row);
  return {
    brand: summary.brand ?? null,
    canonical_product_id: row.product_id as number,
    catalog_last_seen_at: new Date(summary.catalogEvidence.observedAt),
    catalog_raw_record_hash:
      summary.catalogEvidence.sourceRecordId.slice("source-record:".length),
    catalog_runtime_state: "approved",
    catalog_source_display_name: summary.catalogEvidence.source.displayName,
    catalog_source_id: summary.catalogEvidence.source.id,
    catalog_source_kind: "offer",
    category_path: null,
    confidence: 100,
    display_name: summary.displayName,
    gtin: summary.gtin,
    package_amount: summary.packageMeasure?.amount ?? null,
    package_unit: summary.packageMeasure?.unit ?? null,
    permission_catalog: true,
    permission_decision: "approved",
    permission_id: row.offer_id as number,
    permission_reviewed_at: new Date(summary.catalogEvidence.observedAt),
    permission_valid_until: null,
    scheme: summary.gtin.length === 8 ? "ean8" : "ean13",
    sort_name: summary.displayName.toLocaleLowerCase("nb-NO"),
    sort_rank: 0,
    source_permission_expires_at: null,
    source_permission_reviewed_at: new Date(summary.catalogEvidence.observedAt),
    status: "active",
    units_per_pack: summary.unitsPerPack,
    verified_at: new Date(summary.catalogEvidence.observedAt),
  };
}

function compareSearch(
  left: ExactProductPlanApiProductSummary,
  right: ExactProductPlanApiProductSummary,
  query: string,
): number {
  return searchRank(left, query) - searchRank(right, query)
    || compareBrowse(left, right);
}

export class PostgresPublicCatalogIndexReader implements
  PublicCatalogIndexReader,
  PublicCatalogDiscoveryIndexReader {
  constructor(
    private readonly db: HandleplanDatabase,
    private readonly offerBackedDiscoveryEnabled = false,
  ) {}

  browse(
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    if (!validLimit(limit, 36)) {
      return Promise.reject(new PublicCatalogIndexReaderError("INVALID_REQUEST"));
    }
    return this.read(undefined, limit, at, signal);
  }

  search(
    query: string,
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    const normalized = normalizeQuery(query);
    if (normalized === undefined || !validLimit(limit, 20)) {
      return Promise.reject(new PublicCatalogIndexReaderError("INVALID_REQUEST"));
    }
    return this.read(normalized, limit, at, signal);
  }

  async readDiscoveryPage(
    options: PublicCatalogDiscoveryPageOptions,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicCatalogDiscoveryPage> {
    if (
      !isRecord(options)
      || !hasOnlyKeys(
        options,
        [
          ...(options.categoryId === undefined ? [] : ["categoryId"]),
          ...(options.cursor === undefined ? [] : ["cursor"]),
          "limit",
          ...(options.query === undefined ? [] : ["query"]),
        ],
      )
      || !validLimit(options.limit, DISCOVERY_SCAN_LIMIT_MAXIMUM)
    ) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    const categoryId = options.categoryId === undefined
      ? undefined
      : parsePublicCategoryId(options.categoryId);
    if (options.categoryId !== undefined && categoryId === undefined) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    const query = options.query === undefined ? undefined : normalizeQuery(options.query);
    if (options.query !== undefined && query === undefined) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    const cursor = options.cursor === undefined
      ? undefined
      : parseDiscoveryPosition(options.cursor);
    if (options.cursor !== undefined && cursor === undefined) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    return this.readDiscovery(query, categoryId, cursor, options.limit, at, signal);
  }

  private async readDiscovery(
    query: string | undefined,
    categoryId: string | undefined,
    cursor: PublicCatalogDiscoveryPosition | undefined,
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicCatalogDiscoveryPage> {
    if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
    if (!(at instanceof Date) || !isFiniteDate(at)) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }

    const freshnessStartsAt = new Date(at.getTime() - EXACT_PRODUCT_CATALOG_MAX_AGE_MS);
    const atIso = at.toISOString();
    const freshnessStartsAtIso = freshnessStartsAt.toISOString();
    const categoryDigest = categoryId?.slice(PUBLIC_CATEGORY_ID_PREFIX.length) ?? null;
    const searchTerm = query ?? null;
    const exactGtin = query !== undefined && isValidGtin(query) ? query : null;
    const contains = query === undefined ? null : `%${escapeLike(query)}%`;
    const prefix = query === undefined ? null : `${escapeLike(query)}%`;
    const cursorRank = cursor?.rank ?? null;
    const cursorSortName = cursor?.sortName ?? null;
    const cursorGtin = cursor?.gtin ?? null;
    const client = this.db.$client;
    const offerBackedRowsPromise = this.offerBackedDiscoveryEnabled
      ? await client<OfferBackedRow[]>`
        select
          offers.offer_id,
          offers.source_id,
          offers.source_display_name,
          offers.source_record_id,
          offers.chain,
          offers.product_id,
          offers.amount_ore,
          offers.before_amount_ore,
          offers.multibuy_quantity,
          offers.multibuy_group_amount_ore,
          offers.membership_requirement,
          offers.member_program_id,
          offers.valid_from,
          offers.valid_until,
          offers.geographic_scope,
          offers.channels,
          offers.captured_at,
          offers.product_offer_count,
          offers.total_offer_count,
          offers.product_is_offer_backed,
          product.display_name,
          product.brand,
          product.package_amount,
          product.package_unit,
          product.units_per_pack,
          identifier.value as gtin,
          identifier.verified_at as identifier_verified_at
        from public.public_offer_backed_discovery_rows_v1(
          ${atIso}::timestamptz
        ) offers
        inner join public.canonical_products product
          on product.id = offers.product_id
         and product.status = 'active'
         and product.public_state_changed_at <= ${atIso}::timestamptz
        inner join public.product_identifiers identifier
          on identifier.product_id = offers.product_id
         and identifier.scheme = case char_length(identifier.value)
           when 8 then 'ean8'::text
           else 'ean13'::text
         end
         and identifier.confidence = 100
         and identifier.verified_at is not null
         and identifier.verified_at <= ${atIso}::timestamptz
         and identifier.created_at <= ${atIso}::timestamptz
         and identifier.public_state_changed_at <= ${atIso}::timestamptz
      `
      : Promise.resolve([]);

    const sqlQuery = client<DiscoveryCatalogEligibilityRow[]>`
      with ranked_catalog as (
        select
          observation.gtin,
          case char_length(observation.gtin)
            when 8 then 'ean8'::text
            else 'ean13'::text
          end as scheme,
          100::smallint as confidence,
          observation.retrieved_at as verified_at,
          observation.canonical_product_id::double precision as canonical_product_id,
          observation.display_name,
          observation.brand,
          observation.package_amount,
          observation.package_unit,
          observation.units_per_pack,
          observation.category_path,
          'active'::text as status,
          run.source_id as catalog_source_id,
          source.display_name as catalog_source_display_name,
          source.source_kind as catalog_source_kind,
          source.runtime_state as catalog_runtime_state,
          source.permission_reviewed_at as source_permission_reviewed_at,
          source.permission_expires_at as source_permission_expires_at,
          observation.raw_record_hash as catalog_raw_record_hash,
          observation.retrieved_at as catalog_last_seen_at,
          permission.id::double precision as permission_id,
          permission.decision as permission_decision,
          permission.reviewed_at as permission_reviewed_at,
          permission.valid_until as permission_valid_until,
          (permission.permissions -> 'catalog') = 'true'::jsonb as permission_catalog,
          row_number() over (
            partition by case
              when ${exactGtin}::text is null
                then 'product:' || observation.canonical_product_id::text
              else 'gtin:' || observation.gtin
            end
            order by
              observation.retrieved_at desc,
              run.completed_at desc,
              observation.id desc,
              run.source_id asc
          ) as selection_rank
        from catalog_observations observation
        inner join ingestion_runs run
          on run.id = observation.ingestion_run_id
         and run.run_type = 'catalog'
         and run.status = 'completed'
         and run.completed_at is not null
         and run.completed_at <= ${atIso}::timestamptz
         and run.created_at <= ${atIso}::timestamptz
         and run.terminalized_at <= ${atIso}::timestamptz
        inner join data_sources source
          on source.id = run.source_id
         and source.runtime_state = 'approved'
         and source.created_at <= ${atIso}::timestamptz
         and source.public_state_changed_at <= ${atIso}::timestamptz
         and source.permission_reviewed_at is not null
         and source.permission_reviewed_at <= ${atIso}::timestamptz
         and (source.permission_expires_at is null or source.permission_expires_at > ${atIso}::timestamptz)
        inner join lateral (
          select
            candidate_permission.id,
            candidate_permission.decision,
            candidate_permission.reviewed_at,
            candidate_permission.valid_until,
            candidate_permission.permissions
          from source_permissions candidate_permission
          where candidate_permission.source_id = source.id
            and candidate_permission.created_at <= ${atIso}::timestamptz
          order by candidate_permission.created_at desc, candidate_permission.id desc
          limit 1
        ) permission on true
        where observation.retrieved_at >= ${freshnessStartsAtIso}::timestamptz
          and observation.retrieved_at <= ${atIso}::timestamptz
          and observation.retrieved_at <= run.completed_at
          and observation.created_at <= ${atIso}::timestamptz
          and permission.decision = 'approved'
          and permission.reviewed_at <= ${atIso}::timestamptz
          and source.permission_reviewed_at = permission.reviewed_at
          and source.permission_expires_at is not distinct from permission.valid_until
          and (permission.valid_until is null or permission.valid_until > ${atIso}::timestamptz)
          and permission.permissions @> '{"catalog": true}'::jsonb
      ), latest_catalog as (
        select *
        from ranked_catalog
        where selection_rank = 1
      ), category_candidates as (
        select *
        from latest_catalog latest
        where (
            ${categoryDigest}::text is null
            or exists (
              select 1
              from jsonb_array_elements(latest.category_path) category_entry
              where encode(sha256(convert_to(
                octet_length(latest.catalog_source_id)::text
                  || ':'
                  || latest.catalog_source_id
                  || (category_entry ->> 'sourceCategoryId'),
                'UTF8'
              )), 'hex') = ${categoryDigest}
            )
          )
          and (
            ${searchTerm}::text is null
            or gtin = ${searchTerm}
            or lower(display_name) like lower(${contains}) escape '\\'
            or lower(coalesce(brand, '')) like lower(${contains}) escape '\\'
          )
      ), ordered_candidates as (
        select
          category_candidates.*,
          case
            when ${searchTerm}::text is null then 0
            when gtin = ${searchTerm} or lower(display_name) = lower(${searchTerm}) then 0
            when lower(display_name) like lower(${prefix}) escape '\\' then 1
            when lower(coalesce(brand, '')) = lower(${searchTerm}) then 2
            when lower(coalesce(brand, '')) like lower(${prefix}) escape '\\' then 3
            else 4
          end as sort_rank,
          lower(display_name) as sort_name
        from category_candidates
      ), cursor_candidates as (
        select *
        from ordered_candidates
        where ${cursorRank}::integer is null
          or sort_rank > ${cursorRank}::integer
          or (
            sort_rank = ${cursorRank}::integer
            and sort_name collate "C" > ${cursorSortName}::text collate "C"
          )
          or (
            sort_rank = ${cursorRank}::integer
            and sort_name collate "C" = ${cursorSortName}::text collate "C"
            and gtin > ${cursorGtin}::text
          )
      )
      select
        gtin,
        scheme,
        confidence,
        verified_at,
        canonical_product_id,
        display_name,
        brand,
        package_amount,
        package_unit,
        units_per_pack,
        category_path,
        status,
        catalog_source_id,
        catalog_source_display_name,
        catalog_source_kind,
        catalog_runtime_state,
        source_permission_reviewed_at,
        source_permission_expires_at,
        catalog_raw_record_hash,
        catalog_last_seen_at,
        permission_id,
        permission_decision,
        permission_reviewed_at,
        permission_valid_until,
        permission_catalog,
        sort_rank,
        sort_name
      from cursor_candidates
      order by
        sort_rank,
        sort_name collate "C",
        gtin
      limit ${DISCOVERY_SCAN_LIMIT_MAXIMUM}
    `;

    try {
      const [rows, rawOfferBackedRows] = await Promise.all([
        awaitAbortableCatalogQuery(sqlQuery, signal),
        offerBackedRowsPromise,
      ]);
      if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
      if (
        !Array.isArray(rows)
        || !Array.isArray(rawOfferBackedRows)
        || rows.length > DISCOVERY_SCAN_LIMIT_MAXIMUM
      ) {
        throw new PublicCatalogIndexReaderError("UNAVAILABLE");
      }

      const entries: PublicCatalogDiscoveryEntry[] = [];
      const canonicalProductIds = new Set<number>();
      const gtins = new Set<string>();
      const offerRows = (rawOfferBackedRows as unknown[])
        .map((candidate) => {
          if (!isRecord(candidate)) {
            throw new PublicCatalogIndexReaderError("UNAVAILABLE");
          }
          // A single offer-backed row with unverifiable identity (for example a
          // checksum-invalid GTIN captured upstream) must not make the whole
          // discovery page unavailable; drop that row and serve the rest.
          try {
            return offerBackedEligibilityRow(candidate as unknown as OfferBackedRow);
          } catch (error) {
            if (!(error instanceof PublicCatalogIndexReaderError)) throw error;
            return null;
          }
        })
        .filter((row): row is OfferBackedCatalogEligibilityRow => row !== null)
        .sort((left, right) =>
          compareCatalogText(left.sort_name, right.sort_name)
          || compareCatalogText(left.gtin, right.gtin));
      const scannedRows = rows as unknown[];
      for (const row of offerRows) {
        if (
          !Number.isSafeInteger(row.canonical_product_id)
          || (row.canonical_product_id as number) <= 0
          || canonicalProductIds.has(row.canonical_product_id)
          || gtins.has(row.gtin)
        ) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        canonicalProductIds.add(row.canonical_product_id);
        gtins.add(row.gtin);
      }
      const seenCatalogKeys = new Set<string>();
      const catalogCandidates = scannedRows.map((candidate) => {
        const normalized = normalizeCatalogEligibilityRow(candidate);
        if (!isRecord(normalized)) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        const row = normalized as unknown as DiscoveryCatalogEligibilityRow;
        const key = query !== undefined && isValidGtin(query)
          ? `gtin:${row.gtin}`
          : `product:${row.canonical_product_id}`;
        if (seenCatalogKeys.has(key)) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        seenCatalogKeys.add(key);
        return row;
      });
      const offerKeySet = new Set(offerRows.map((row) =>
        query !== undefined && isValidGtin(query)
          ? `gtin:${row.gtin}`
          : `product:${row.canonical_product_id}`));
      const mergedCandidates = [
        ...catalogCandidates,
        ...offerRows.filter((row) => {
          if (categoryId !== undefined) return false;
          const key = query !== undefined && isValidGtin(query)
            ? `gtin:${row.gtin}`
            : `product:${row.canonical_product_id}`;
          return !offerKeySet.has(key) || !seenCatalogKeys.has(key);
        }),
      ].sort((left, right) =>
        (left.sort_rank as number) - (right.sort_rank as number)
        || compareCatalogText(left.sort_name as string, right.sort_name as string)
        || compareCatalogText(left.gtin as string, right.gtin as string));
      let nextPosition: PublicCatalogDiscoveryPosition | undefined;
      const pageCandidates = mergedCandidates.slice(0, limit);
      for (const row of pageCandidates) {
        nextPosition = positionFromRow(row);
        const classification = classifyCatalogRow(row, at);
        if (classification === "malformed") {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        if (classification === "ineligible") continue;
        const sourceId = canonicalIdentifier(row.catalog_source_id, SOURCE_ID_MAX_LENGTH);
        const categoryPath = sourceId === undefined
          ? undefined
          : parseCategoryPath(row.category_path, sourceId);
        if (categoryPath === undefined) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        if (
          categoryId !== undefined
          && (categoryPath === null || !categoryPath.some(({ id }) => id === categoryId))
        ) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        if (
          canonicalProductIds.has(row.canonical_product_id)
          || gtins.has(row.gtin)
        ) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        canonicalProductIds.add(row.canonical_product_id);
        gtins.add(row.gtin);
        const product = catalogSummaryFromRow(row);
        if (query !== undefined && !summaryMatchesQuery(product, query)) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        entries.push({
          catalogPosition: nextPosition,
          categoryPath,
          product,
        });
      }
      const hasMore = mergedCandidates.length > limit;
      const sorted = entries.sort((left, right) =>
        left.catalogPosition.rank - right.catalogPosition.rank
        || compareCatalogText(left.catalogPosition.sortName, right.catalogPosition.sortName)
        || compareCatalogText(left.catalogPosition.gtin, right.catalogPosition.gtin));
      return {
        entries: sorted,
        hasMore,
        ...(hasMore && nextPosition !== undefined ? { nextPosition } : {}),
        scannedCount: Math.min(mergedCandidates.length, limit),
      };
    } catch (error) {
      if (error instanceof PublicCatalogIndexReaderError) throw error;
      if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
      if (error instanceof ActiveCatalogReaderError) {
        throw new PublicCatalogIndexReaderError(
          error.code === "CANCELLED" ? "CANCELLED" : "UNAVAILABLE",
        );
      }
      throw new PublicCatalogIndexReaderError("UNAVAILABLE");
    }
  }

  async categoryFacets(
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicCatalogCategoryFacetDirectory> {
    if (!validLimit(limit, 100) || !(at instanceof Date) || !isFiniteDate(at)) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");

    const freshnessStartsAt = new Date(at.getTime() - EXACT_PRODUCT_CATALOG_MAX_AGE_MS);
    const atIso = at.toISOString();
    const freshnessStartsAtIso = freshnessStartsAt.toISOString();
    const client = this.db.$client;
    const sqlQuery = client<CategoryFacetRow[]>`
      with ranked_catalog as (
        select
          observation.canonical_product_id::double precision as canonical_product_id,
          observation.category_path,
          run.source_id as catalog_source_id,
          row_number() over (
            partition by observation.canonical_product_id
            order by
              observation.retrieved_at desc,
              run.completed_at desc,
              observation.id desc,
              run.source_id asc
          ) as selection_rank
        from catalog_observations observation
        inner join ingestion_runs run
          on run.id = observation.ingestion_run_id
         and run.run_type = 'catalog'
         and run.status = 'completed'
         and run.completed_at is not null
         and run.completed_at <= ${atIso}::timestamptz
         and run.created_at <= ${atIso}::timestamptz
         and run.terminalized_at <= ${atIso}::timestamptz
        inner join data_sources source
          on source.id = run.source_id
         and source.runtime_state = 'approved'
         and source.created_at <= ${atIso}::timestamptz
         and source.public_state_changed_at <= ${atIso}::timestamptz
         and source.permission_reviewed_at is not null
         and source.permission_reviewed_at <= ${atIso}::timestamptz
         and (source.permission_expires_at is null or source.permission_expires_at > ${atIso}::timestamptz)
        inner join lateral (
          select
            candidate_permission.decision,
            candidate_permission.reviewed_at,
            candidate_permission.valid_until,
            candidate_permission.permissions
          from source_permissions candidate_permission
          where candidate_permission.source_id = source.id
            and candidate_permission.created_at <= ${atIso}::timestamptz
          order by candidate_permission.created_at desc, candidate_permission.id desc
          limit 1
        ) permission on true
        where observation.retrieved_at >= ${freshnessStartsAtIso}::timestamptz
          and observation.retrieved_at <= ${atIso}::timestamptz
          and observation.retrieved_at <= run.completed_at
          and observation.created_at <= ${atIso}::timestamptz
          and permission.decision = 'approved'
          and permission.reviewed_at <= ${atIso}::timestamptz
          and source.permission_reviewed_at = permission.reviewed_at
          and source.permission_expires_at is not distinct from permission.valid_until
          and (permission.valid_until is null or permission.valid_until > ${atIso}::timestamptz)
          and permission.permissions @> '{"catalog": true}'::jsonb
      ), latest_catalog as (
        select *
        from ranked_catalog
        where selection_rank = 1
      ), category_rows as (
        select
          latest.canonical_product_id,
          latest.catalog_source_id,
          category_entry
        from latest_catalog latest
        cross join lateral jsonb_array_elements(latest.category_path) category_entry
        where latest.category_path is not null
      ), category_groups as (
        select
          catalog_source_id,
          category_entry ->> 'sourceCategoryId' as source_category_id,
          jsonb_agg(distinct category_entry) as category_variants,
          count(distinct canonical_product_id)::double precision as product_count,
          min((category_entry ->> 'depth')::integer) as sort_depth,
          min(category_entry ->> 'name') as sort_name,
          encode(sha256(convert_to(
            octet_length(catalog_source_id)::text
              || ':'
              || catalog_source_id
              || (category_entry ->> 'sourceCategoryId'),
            'UTF8'
          )), 'hex') as public_category_digest
        from category_rows
        group by catalog_source_id, category_entry ->> 'sourceCategoryId'
      )
      select
        catalog_source_id,
        category_variants,
        product_count
      from category_groups
      order by
        sort_depth,
        sort_name collate "C",
        catalog_source_id,
        public_category_digest
      limit ${limit + 1}
    `;

    try {
      const rows = await awaitAbortableCatalogQuery(sqlQuery, signal);
      if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
      if (!Array.isArray(rows) || rows.length > limit + 1) {
        throw new PublicCatalogIndexReaderError("UNAVAILABLE");
      }

      const facets: PublicCatalogCategoryFacet[] = [];
      const publicIds = new Set<string>();
      for (const rawRow of rows as unknown[]) {
        if (
          !isRecord(rawRow)
          || !hasOnlyKeys(rawRow, ["catalog_source_id", "category_variants", "product_count"])
        ) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        const sourceId = canonicalIdentifier(rawRow.catalog_source_id, SOURCE_ID_MAX_LENGTH);
        const variants = rawRow.category_variants;
        const category = Array.isArray(variants) && variants.length === 1
          ? parseCategoryPathEntry(variants[0])
          : undefined;
        const productCount = rawRow.product_count;
        if (
          sourceId === undefined
          || category === undefined
          || typeof productCount !== "number"
          || !Number.isSafeInteger(productCount)
          || productCount < 1
        ) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        const id = publicCategoryId(sourceId, category.sourceCategoryId);
        if (publicIds.has(id)) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        publicIds.add(id);
        facets.push({
          depth: category.depth,
          id,
          name: category.name,
          productCount,
          sourceId,
        });
      }
      facets.sort(compareCategoryFacet);
      return {
        facets: facets.slice(0, limit),
        hasMore: facets.length > limit,
      };
    } catch (error) {
      if (error instanceof PublicCatalogIndexReaderError) throw error;
      if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
      if (error instanceof ActiveCatalogReaderError) {
        throw new PublicCatalogIndexReaderError(
          error.code === "CANCELLED" ? "CANCELLED" : "UNAVAILABLE",
        );
      }
      throw new PublicCatalogIndexReaderError("UNAVAILABLE");
    }
  }

  private async read(
    query: string | undefined,
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
    if (!(at instanceof Date) || !isFiniteDate(at)) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }

    const freshnessStartsAt = new Date(at.getTime() - EXACT_PRODUCT_CATALOG_MAX_AGE_MS);
    const atIso = at.toISOString();
    const freshnessStartsAtIso = freshnessStartsAt.toISOString();
    const searchTerm = query ?? null;
    const exactGtin = query !== undefined && isValidGtin(query) ? query : null;
    const contains = query === undefined ? null : `%${escapeLike(query)}%`;
    const prefix = query === undefined ? null : `${escapeLike(query)}%`;
    const client = this.db.$client;
    const sqlQuery = client<CatalogEligibilityRow[]>`
      with ranked_catalog as (
        select
          observation.gtin,
          case char_length(observation.gtin)
            when 8 then 'ean8'::text
            else 'ean13'::text
          end as scheme,
          100::smallint as confidence,
          observation.retrieved_at as verified_at,
          observation.canonical_product_id::double precision as canonical_product_id,
          observation.display_name,
          observation.brand,
          observation.package_amount,
          observation.package_unit,
          observation.units_per_pack,
          'active'::text as status,
          run.source_id as catalog_source_id,
          source.display_name as catalog_source_display_name,
          source.source_kind as catalog_source_kind,
          source.runtime_state as catalog_runtime_state,
          source.permission_reviewed_at as source_permission_reviewed_at,
          source.permission_expires_at as source_permission_expires_at,
          observation.raw_record_hash as catalog_raw_record_hash,
          observation.retrieved_at as catalog_last_seen_at,
          permission.id::double precision as permission_id,
          permission.decision as permission_decision,
          permission.reviewed_at as permission_reviewed_at,
          permission.valid_until as permission_valid_until,
          (permission.permissions -> 'catalog') = 'true'::jsonb as permission_catalog,
          row_number() over (
            partition by case
              when ${exactGtin}::text is null
                then 'product:' || observation.canonical_product_id::text
              else 'gtin:' || observation.gtin
            end
            order by
              observation.retrieved_at desc,
              run.completed_at desc,
              observation.id desc,
              run.source_id asc
          ) as selection_rank
        from catalog_observations observation
        inner join ingestion_runs run
          on run.id = observation.ingestion_run_id
         and run.run_type = 'catalog'
         and run.status = 'completed'
         and run.completed_at is not null
         and run.completed_at <= ${atIso}::timestamptz
         and run.created_at <= ${atIso}::timestamptz
         and run.terminalized_at <= ${atIso}::timestamptz
        inner join data_sources source
          on source.id = run.source_id
         and source.runtime_state = 'approved'
         and source.created_at <= ${atIso}::timestamptz
         and source.public_state_changed_at <= ${atIso}::timestamptz
         and source.permission_reviewed_at is not null
         and source.permission_reviewed_at <= ${atIso}::timestamptz
         and (source.permission_expires_at is null or source.permission_expires_at > ${atIso}::timestamptz)
        inner join lateral (
          select
            candidate_permission.id,
            candidate_permission.decision,
            candidate_permission.reviewed_at,
            candidate_permission.valid_until,
            candidate_permission.permissions
          from source_permissions candidate_permission
          where candidate_permission.source_id = source.id
            and candidate_permission.created_at <= ${atIso}::timestamptz
          order by candidate_permission.created_at desc, candidate_permission.id desc
          limit 1
        ) permission on true
        where observation.retrieved_at >= ${freshnessStartsAtIso}::timestamptz
          and observation.retrieved_at <= ${atIso}::timestamptz
          and observation.retrieved_at <= run.completed_at
          and observation.created_at <= ${atIso}::timestamptz
          and permission.decision = 'approved'
          and permission.reviewed_at <= ${atIso}::timestamptz
          and source.permission_reviewed_at = permission.reviewed_at
          and source.permission_expires_at is not distinct from permission.valid_until
          and (permission.valid_until is null or permission.valid_until > ${atIso}::timestamptz)
          and permission.permissions @> '{"catalog": true}'::jsonb
      ), catalog_candidates as (
        select *
        from ranked_catalog
        where selection_rank = 1
          and (
            ${searchTerm}::text is null
            or gtin = ${searchTerm}
            or lower(display_name) like lower(${contains}) escape '\\'
            or lower(coalesce(brand, '')) like lower(${contains}) escape '\\'
          )
      )
      select
        gtin,
        scheme,
        confidence,
        verified_at,
        canonical_product_id,
        display_name,
        brand,
        package_amount,
        package_unit,
        units_per_pack,
        status,
        catalog_source_id,
        catalog_source_display_name,
        catalog_source_kind,
        catalog_runtime_state,
        source_permission_reviewed_at,
        source_permission_expires_at,
        catalog_raw_record_hash,
        catalog_last_seen_at,
        permission_id,
        permission_decision,
        permission_reviewed_at,
        permission_valid_until,
        permission_catalog
      from catalog_candidates
      order by
        case
          when ${searchTerm}::text is null then 0
          when gtin = ${searchTerm} or lower(display_name) = lower(${searchTerm}) then 0
          when lower(display_name) like lower(${prefix}) escape '\\' then 1
          when lower(coalesce(brand, '')) = lower(${searchTerm}) then 2
          when lower(coalesce(brand, '')) like lower(${prefix}) escape '\\' then 3
          else 4
        end,
        lower(display_name),
        gtin
      limit ${limit}
    `;

    try {
      const rows = await awaitAbortableCatalogQuery(sqlQuery, signal);
      if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
      if (!Array.isArray(rows) || rows.length > limit) {
        throw new PublicCatalogIndexReaderError("UNAVAILABLE");
      }

      const summaries: ExactProductPlanApiProductSummary[] = [];
      for (const rawCandidate of rows as unknown[]) {
        const candidate = normalizeCatalogEligibilityRow(rawCandidate);
        const classification = classifyCatalogRow(candidate, at);
        if (classification === "malformed") {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        if (classification === "ineligible") continue;
        const summary = catalogSummaryFromRow(candidate as CatalogEligibilityRow);
        if (query !== undefined && !summaryMatchesQuery(summary, query)) {
          throw new PublicCatalogIndexReaderError("UNAVAILABLE");
        }
        summaries.push(summary);
      }
      if (new Set(summaries.map(({ gtin }) => gtin)).size !== summaries.length) {
        throw new PublicCatalogIndexReaderError("UNAVAILABLE");
      }
      return summaries.sort((left, right) =>
        query === undefined ? compareBrowse(left, right) : compareSearch(left, right, query));
    } catch (error) {
      if (error instanceof PublicCatalogIndexReaderError) throw error;
      if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
      if (error instanceof ActiveCatalogReaderError) {
        throw new PublicCatalogIndexReaderError(
          error.code === "CANCELLED" ? "CANCELLED" : "UNAVAILABLE",
        );
      }
      throw new PublicCatalogIndexReaderError("UNAVAILABLE");
    }
  }
}
