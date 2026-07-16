import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  isFiniteDate,
  isValidGtin,
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

function validLimit(limit: number, maximum: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum;
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

function compareSearch(
  left: ExactProductPlanApiProductSummary,
  right: ExactProductPlanApiProductSummary,
  query: string,
): number {
  return searchRank(left, query) - searchRank(right, query)
    || compareBrowse(left, right);
}

export class PostgresPublicCatalogIndexReader implements PublicCatalogIndexReader {
  constructor(private readonly db: HandleplanDatabase) {}

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
        inner join data_sources source
          on source.id = run.source_id
         and source.runtime_state = 'approved'
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
            and candidate_permission.reviewed_at <= ${atIso}::timestamptz
          order by candidate_permission.reviewed_at desc, candidate_permission.id desc
          limit 1
        ) permission on true
        where observation.retrieved_at >= ${freshnessStartsAtIso}::timestamptz
          and observation.retrieved_at <= ${atIso}::timestamptz
          and observation.retrieved_at <= run.completed_at
          and permission.decision = 'approved'
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
