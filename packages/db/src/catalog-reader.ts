import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  exactProductPlanApiProductSummarySchema,
  isFiniteDate,
  isValidGtin,
  type ExactProductPlanApiEvidenceSource,
  type ExactProductPlanApiProductSummary,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

export type ActiveCatalogReaderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

const errorMessages: Readonly<Record<ActiveCatalogReaderErrorCode, string>> = {
  CANCELLED: "Active catalog request cancelled",
  INVALID_REQUEST: "Active catalog request is invalid",
  UNAVAILABLE: "Active catalog is unavailable",
};

export class ActiveCatalogReaderError extends Error {
  readonly code: ActiveCatalogReaderErrorCode;

  constructor(code: ActiveCatalogReaderErrorCode) {
    super(errorMessages[code]);
    this.name = "ActiveCatalogReaderError";
    this.code = code;
  }
}

export interface CatalogEligibilityRow {
  brand: string | null;
  canonical_product_id: number;
  catalog_last_seen_at: Date;
  catalog_raw_record_hash: string;
  catalog_runtime_state: string;
  catalog_source_display_name: string;
  catalog_source_id: string;
  catalog_source_kind: string;
  confidence: number;
  display_name: string;
  gtin: string;
  package_amount: number;
  package_unit: string;
  permission_catalog: boolean | null;
  permission_decision: string | null;
  permission_id: number | null;
  permission_reviewed_at: Date | null;
  permission_valid_until: Date | null;
  scheme: string;
  source_permission_expires_at: Date | null;
  source_permission_reviewed_at: Date | null;
  status: string;
  units_per_pack: number;
  verified_at: Date | null;
}

export type CatalogRowClassification = "eligible" | "ineligible" | "malformed";
export type CancelableCatalogQuery<T> = PromiseLike<T> & { cancel(): void };

const catalogTimestampFields = [
  "catalog_last_seen_at",
  "permission_reviewed_at",
  "permission_valid_until",
  "source_permission_expires_at",
  "source_permission_reviewed_at",
  "verified_at",
] as const satisfies readonly (keyof CatalogEligibilityRow)[];

export function normalizeCatalogEligibilityRow(row: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
  const normalized = { ...row } as Record<string, unknown>;
  for (const field of catalogTimestampFields) {
    const value = normalized[field];
    if (typeof value !== "string") continue;
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) normalized[field] = parsed;
  }
  return normalized;
}

function requestIsValid(gtins: readonly string[], at: Date): boolean {
  if (!Array.isArray(gtins) || !(at instanceof Date) || !isFiniteDate(at)) {
    return false;
  }
  const values = [...gtins];
  return (
    values.length >= 1 &&
    values.length <= 50 &&
    values.every((gtin) => typeof gtin === "string" && isValidGtin(gtin)) &&
    new Set(values).size === values.length
  );
}

export function classifyCatalogRow(row: unknown, at: Date): CatalogRowClassification {
  if (typeof row !== "object" || row === null) return "malformed";
  const candidate = row as Partial<CatalogEligibilityRow>;

  if (!(["active", "quarantined", "retired"] as unknown[]).includes(candidate.status)) {
    return "malformed";
  }
  if (candidate.status !== "active") return "ineligible";

  if (
    typeof candidate.confidence !== "number" ||
    !Number.isInteger(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 100
  ) {
    return "malformed";
  }
  if (candidate.confidence !== 100) return "ineligible";

  if (candidate.verified_at === null) return "ineligible";
  if (!(candidate.verified_at instanceof Date) || !isFiniteDate(candidate.verified_at)) {
    return "malformed";
  }
  if (candidate.verified_at.getTime() > at.getTime()) return "ineligible";

  if (!(["ean8", "ean13", "source"] as unknown[]).includes(candidate.scheme)) {
    return "malformed";
  }
  if (candidate.scheme === "source") return "ineligible";
  if (
    typeof candidate.gtin !== "string" ||
    !isValidGtin(candidate.gtin) ||
    candidate.scheme !== (candidate.gtin.length === 8 ? "ean8" : "ean13")
  ) {
    return "malformed";
  }

  if (
    typeof candidate.canonical_product_id !== "number" ||
    !Number.isSafeInteger(candidate.canonical_product_id) ||
    candidate.canonical_product_id <= 0
  ) {
    return "malformed";
  }

  if (!(candidate.catalog_last_seen_at instanceof Date) || !isFiniteDate(candidate.catalog_last_seen_at)) {
    return "malformed";
  }
  const catalogAgeMs = at.getTime() - candidate.catalog_last_seen_at.getTime();
  if (catalogAgeMs < 0 || catalogAgeMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS) {
    return "ineligible";
  }
  if (
    typeof candidate.catalog_raw_record_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.catalog_raw_record_hash)
  ) {
    return "malformed";
  }
  if (
    typeof candidate.catalog_source_id !== "string" ||
    typeof candidate.catalog_source_display_name !== "string" ||
    typeof candidate.catalog_source_kind !== "string" ||
    candidate.catalog_runtime_state === undefined
  ) {
    return "malformed";
  }
  if (!(candidate.catalog_runtime_state === "approved"
    || candidate.catalog_runtime_state === "blocked"
    || candidate.catalog_runtime_state === "conditional"
    || candidate.catalog_runtime_state === "revoked")) {
    return "malformed";
  }
  if (candidate.catalog_runtime_state !== "approved") return "ineligible";

  if (candidate.source_permission_reviewed_at === null) return "ineligible";
  if (
    !(candidate.source_permission_reviewed_at instanceof Date) ||
    !isFiniteDate(candidate.source_permission_reviewed_at)
  ) {
    return "malformed";
  }
  if (candidate.source_permission_reviewed_at.getTime() > at.getTime()) return "ineligible";
  if (candidate.source_permission_expires_at !== null) {
    if (
      !(candidate.source_permission_expires_at instanceof Date) ||
      !isFiniteDate(candidate.source_permission_expires_at)
    ) {
      return "malformed";
    }
    if (candidate.source_permission_expires_at.getTime() <= at.getTime()) return "ineligible";
  }

  if (candidate.permission_id === null || candidate.permission_decision === null) {
    return "ineligible";
  }
  if (
    typeof candidate.permission_id !== "number" ||
    !Number.isSafeInteger(candidate.permission_id) ||
    candidate.permission_id <= 0
  ) {
    return "malformed";
  }
  if (!(candidate.permission_decision === "approved"
    || candidate.permission_decision === "blocked"
    || candidate.permission_decision === "conditional"
    || candidate.permission_decision === "revoked")) {
    return "malformed";
  }
  if (candidate.permission_decision !== "approved") return "ineligible";
  if (candidate.permission_reviewed_at === null) return "ineligible";
  if (
    !(candidate.permission_reviewed_at instanceof Date) ||
    !isFiniteDate(candidate.permission_reviewed_at)
  ) {
    return "malformed";
  }
  if (candidate.permission_reviewed_at.getTime() > at.getTime()) return "ineligible";
  if (candidate.permission_valid_until !== null) {
    if (
      !(candidate.permission_valid_until instanceof Date) ||
      !isFiniteDate(candidate.permission_valid_until)
    ) {
      return "malformed";
    }
    if (candidate.permission_valid_until.getTime() <= at.getTime()) return "ineligible";
  }
  if (candidate.permission_catalog === null || candidate.permission_catalog === false) {
    return "ineligible";
  }
  if (typeof candidate.permission_catalog !== "boolean") return "malformed";

  return "eligible";
}

export function compareCatalogText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceClassFor(sourceKind: string): ExactProductPlanApiEvidenceSource["sourceClass"] {
  switch (sourceKind) {
    case "catalog": return "catalog";
    case "ordinary_price": return "ordinary-price";
    case "offer": return "offer";
    case "store": return "store";
    case "geocoder": return "geocoder";
    case "routing": return "routing";
    case "legacy": return "legacy";
    default: throw new ActiveCatalogReaderError("UNAVAILABLE");
  }
}

export async function awaitAbortableCatalogQuery<T>(
  query: CancelableCatalogQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new ActiveCatalogReaderError("CANCELLED");

  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw new ActiveCatalogReaderError("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function catalogSummaryFromRow(
  row: CatalogEligibilityRow,
): ExactProductPlanApiProductSummary {
  const parsed = exactProductPlanApiProductSummarySchema.safeParse({
    ...(row.brand === null ? {} : { brand: row.brand }),
    catalogEvidence: {
      observedAt: row.catalog_last_seen_at.toISOString(),
      source: {
        contractVersion: 1,
        displayName: row.catalog_source_display_name,
        id: row.catalog_source_id,
        sourceClass: sourceClassFor(row.catalog_source_kind),
        state: "approved",
      },
      sourceRecordId: `source-record:${row.catalog_raw_record_hash}`,
    },
    displayName: row.display_name,
    gtin: row.gtin,
    packageMeasure: {
      amount: row.package_amount,
      unit: row.package_unit,
    },
    unitsPerPack: row.units_per_pack,
  });
  if (!parsed.success) throw new ActiveCatalogReaderError("UNAVAILABLE");
  return parsed.data;
}

export class PostgresActiveCatalogReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getMany(
    gtins: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    if (signal?.aborted) throw new ActiveCatalogReaderError("CANCELLED");
    if (!requestIsValid(gtins, at)) {
      throw new ActiveCatalogReaderError("INVALID_REQUEST");
    }

    const requestedGtins = [...gtins];
    const requestedSet = new Set(requestedGtins);
    const freshnessStartsAt = new Date(at.getTime() - EXACT_PRODUCT_CATALOG_MAX_AGE_MS);
    const atIso = at.toISOString();
    const freshnessStartsAtIso = freshnessStartsAt.toISOString();
    const client = this.db.$client;
    const query = client<CatalogEligibilityRow[]>`
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
            partition by observation.gtin
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
            candidate.id,
            candidate.decision,
            candidate.reviewed_at,
            candidate.valid_until,
            candidate.permissions
          from source_permissions candidate
          where candidate.source_id = source.id
            and candidate.reviewed_at <= ${atIso}::timestamptz
          order by candidate.reviewed_at desc, candidate.id desc
          limit 1
        ) permission on true
        where observation.gtin in (
          select jsonb_array_elements_text(${JSON.stringify(requestedGtins)}::jsonb)
        )
          and observation.retrieved_at >= ${freshnessStartsAtIso}::timestamptz
          and observation.retrieved_at <= ${atIso}::timestamptz
          and observation.retrieved_at <= run.completed_at
          and permission.decision = 'approved'
          and (permission.valid_until is null or permission.valid_until > ${atIso}::timestamptz)
          and permission.permissions @> '{"catalog": true}'::jsonb
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
      from ranked_catalog
      where selection_rank = 1
      order by gtin asc
    `;

    try {
      const rows = await awaitAbortableCatalogQuery(query, signal);
      if (signal?.aborted) throw new ActiveCatalogReaderError("CANCELLED");

      const eligibleRows: CatalogEligibilityRow[] = [];
      for (const rawRow of rows as unknown[]) {
        const row = normalizeCatalogEligibilityRow(rawRow);
        const classification = classifyCatalogRow(row, at);
        if (classification === "malformed") {
          throw new ActiveCatalogReaderError("UNAVAILABLE");
        }
        if (classification === "ineligible") continue;
        const eligible = row as CatalogEligibilityRow;
        if (!requestedSet.has(eligible.gtin)) {
          throw new ActiveCatalogReaderError("UNAVAILABLE");
        }
        eligibleRows.push(eligible);
      }

      if (new Set(eligibleRows.map(({ gtin }) => gtin)).size !== eligibleRows.length) {
        throw new ActiveCatalogReaderError("UNAVAILABLE");
      }

      const summaries = eligibleRows.map(catalogSummaryFromRow);

      return summaries.sort((left, right) => compareCatalogText(left.gtin, right.gtin));
    } catch (error) {
      if (error instanceof ActiveCatalogReaderError) throw error;
      if (signal?.aborted) throw new ActiveCatalogReaderError("CANCELLED");
      throw new ActiveCatalogReaderError("UNAVAILABLE");
    }
  }
}
