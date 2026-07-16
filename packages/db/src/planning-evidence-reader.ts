import {
  coverageCheckSchema,
  exactProductPlanApiEvidenceSourceSchema,
  geographicScopeSchema,
  isFiniteDate,
  isValidGtin,
  priceEvidenceSchema,
  type CoverageCheck,
  type ExactProductPlanApiEvidenceSource,
  type GeographicScope,
  type PriceEvidence,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

const MAX_GTINS = 50;
const MAX_ROWS = 10_000;
const HISTORY_AND_CURRENT_WINDOW_MS = 33 * 24 * 60 * 60 * 1_000;
const CURRENT_COVERAGE_WINDOW_MS = 72 * 60 * 60 * 1_000;

export type PlanningEvidenceReaderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

const errorMessages: Readonly<Record<PlanningEvidenceReaderErrorCode, string>> = {
  CANCELLED: "Planning evidence request cancelled",
  INVALID_REQUEST: "Planning evidence request is invalid",
  UNAVAILABLE: "Planning evidence is unavailable",
};

export class PlanningEvidenceReaderError extends Error {
  readonly code: PlanningEvidenceReaderErrorCode;

  constructor(code: PlanningEvidenceReaderErrorCode) {
    super(errorMessages[code]);
    this.name = "PlanningEvidenceReaderError";
    this.code = code;
  }
}

export interface PlanningEvidenceProductIdentity {
  canonicalProductId: string;
  gtin: string;
}

export interface PlanningEvidenceSnapshot {
  products: PlanningEvidenceProductIdentity[];
  sources: ExactProductPlanApiEvidenceSource[];
  priceEvidence: PriceEvidence[];
  historicalEligibleEvidenceIds: string[];
  coverageChecks: CoverageCheck[];
}

export interface PlanningEvidenceReader {
  getMany(
    gtins: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<PlanningEvidenceSnapshot>;
}

interface PlanningEvidenceRow {
  amount_ore: number | null;
  chain: string | null;
  checked_at: Date | null;
  claim_eligibility: "historical_eligible" | "ordinary_only" | null;
  country_code: string | null;
  coverage_reason: string | null;
  coverage_state: string | null;
  display_name: string | null;
  fetched_at: Date | null;
  gtin: string;
  observed_at: Date | null;
  product_id: number;
  raw_record_hash: string | null;
  record_id: number | null;
  record_type: "coverage" | "price" | "product";
  region_codes: string[];
  scope_kind: string | null;
  scope_status: string | null;
  source_id: string | null;
  source_kind: string | null;
  store_ids: string[];
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requestIsValid(gtins: readonly string[], at: Date): boolean {
  if (!Array.isArray(gtins) || !(at instanceof Date) || !isFiniteDate(at)) return false;
  const values = [...gtins];
  return values.length >= 1
    && values.length <= MAX_GTINS
    && values.every((gtin) => typeof gtin === "string" && isValidGtin(gtin))
    && new Set(values).size === values.length;
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new PlanningEvidenceReaderError("CANCELLED");
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw new PlanningEvidenceReaderError("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowHasValidIdentity(
  row: unknown,
  requestedGtins: ReadonlySet<string>,
): row is PlanningEvidenceRow {
  if (!isRecord(row)) return false;
  return (
    (row.record_type === "product" || row.record_type === "price" || row.record_type === "coverage")
    && typeof row.gtin === "string"
    && isValidGtin(row.gtin)
    && requestedGtins.has(row.gtin)
    && typeof row.product_id === "number"
    && Number.isSafeInteger(row.product_id)
    && row.product_id > 0
    && Array.isArray(row.region_codes)
    && row.region_codes.every((value) => typeof value === "string")
    && Array.isArray(row.store_ids)
    && row.store_ids.every((value) => typeof value === "string")
  );
}

function geographicScopeFor(row: PlanningEvidenceRow): GeographicScope {
  let candidate: unknown;
  if (row.scope_kind === null) {
    candidate = { kind: "unknown", reason: "missing-geographic-scope" };
  } else if (row.scope_status !== "active") {
    candidate = { kind: "unknown", reason: "inactive-geographic-scope" };
  } else if (row.scope_kind === "national") {
    candidate = { kind: "national", countryCode: row.country_code };
  } else if (row.scope_kind === "region") {
    candidate = row.region_codes.length === 0
      ? { kind: "unknown", reason: "empty-region-scope" }
      : {
          kind: "regions",
          countryCode: row.country_code,
          regionCodes: [...new Set(row.region_codes)].sort(compareText),
        };
  } else if (row.scope_kind === "store_set") {
    candidate = row.store_ids.length === 0
      ? { kind: "unknown", reason: "empty-store-scope" }
      : { kind: "stores", storeIds: [...new Set(row.store_ids)].sort(compareText) };
  } else if (row.scope_kind === "postal_set") {
    candidate = { kind: "unknown", reason: "unsupported-postal-set-scope" };
  } else {
    throw new PlanningEvidenceReaderError("UNAVAILABLE");
  }
  const parsed = geographicScopeSchema.safeParse(candidate);
  if (!parsed.success) throw new PlanningEvidenceReaderError("UNAVAILABLE");
  return parsed.data;
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
    default: throw new PlanningEvidenceReaderError("UNAVAILABLE");
  }
}

function sourceFor(row: PlanningEvidenceRow): ExactProductPlanApiEvidenceSource {
  if (
    typeof row.source_id !== "string"
    || typeof row.display_name !== "string"
    || typeof row.source_kind !== "string"
  ) {
    throw new PlanningEvidenceReaderError("UNAVAILABLE");
  }
  const parsed = exactProductPlanApiEvidenceSourceSchema.safeParse({
    contractVersion: 1,
    displayName: row.display_name,
    id: row.source_id,
    sourceClass: sourceClassFor(row.source_kind),
    state: "approved",
  });
  if (!parsed.success) throw new PlanningEvidenceReaderError("UNAVAILABLE");
  return parsed.data;
}

function finiteDate(value: unknown): value is Date {
  return value instanceof Date && isFiniteDate(value);
}

function priceFor(row: PlanningEvidenceRow, at: Date): PriceEvidence {
  if (
    typeof row.record_id !== "number"
    || !Number.isSafeInteger(row.record_id)
    || row.record_id <= 0
    || typeof row.chain !== "string"
    || typeof row.amount_ore !== "number"
    || !finiteDate(row.observed_at)
    || !finiteDate(row.fetched_at)
    || row.observed_at.getTime() > at.getTime()
    || row.fetched_at.getTime() > at.getTime()
    || row.fetched_at.getTime() < row.observed_at.getTime()
    || typeof row.raw_record_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(row.raw_record_hash)
    || typeof row.source_id !== "string"
    || (row.claim_eligibility !== "ordinary_only"
      && row.claim_eligibility !== "historical_eligible")
  ) {
    throw new PlanningEvidenceReaderError("UNAVAILABLE");
  }
  const parsed = priceEvidenceSchema.safeParse({
    amountOre: row.amount_ore,
    chainId: row.chain,
    contractVersion: 1,
    evidenceLevel: "observed",
    geographicScope: geographicScopeFor(row),
    id: `price:${row.record_id}`,
    kind: "price-evidence",
    observedAt: row.observed_at.toISOString(),
    priceKind: "ordinary",
    productMatch: {
      canonicalProductId: `product:${row.product_id}`,
      kind: "exact",
    },
    sourceId: row.source_id,
    sourceRecordId: `source-record:${row.raw_record_hash}`,
  });
  if (!parsed.success) throw new PlanningEvidenceReaderError("UNAVAILABLE");
  return parsed.data;
}

function coverageFor(row: PlanningEvidenceRow, at: Date): CoverageCheck | undefined {
  const state = row.coverage_state === "known_not_carried"
    ? "known-not-carried"
    : row.coverage_state === "unknown" && row.coverage_reason === "source_unavailable"
      ? "source-unavailable"
      : undefined;
  if (state === undefined) return undefined;
  if (
    typeof row.record_id !== "number"
    || !Number.isSafeInteger(row.record_id)
    || row.record_id <= 0
    || typeof row.chain !== "string"
    || !finiteDate(row.checked_at)
    || row.checked_at.getTime() > at.getTime()
    || typeof row.source_id !== "string"
  ) {
    throw new PlanningEvidenceReaderError("UNAVAILABLE");
  }
  const parsed = coverageCheckSchema.safeParse({
    canonicalProductId: `product:${row.product_id}`,
    chainId: row.chain,
    checkedAt: row.checked_at.toISOString(),
    contractVersion: 1,
    geographicScope: geographicScopeFor(row),
    id: `coverage:${row.record_id}`,
    sourceId: row.source_id,
    state,
  });
  if (!parsed.success) throw new PlanningEvidenceReaderError("UNAVAILABLE");
  return parsed.data;
}

function addSource(
  sources: Map<string, ExactProductPlanApiEvidenceSource>,
  source: ExactProductPlanApiEvidenceSource,
): void {
  const previous = sources.get(source.id);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(source)) {
    throw new PlanningEvidenceReaderError("UNAVAILABLE");
  }
  sources.set(source.id, source);
}

export class PostgresPlanningEvidenceReader implements PlanningEvidenceReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getMany(
    gtins: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<PlanningEvidenceSnapshot> {
    if (signal?.aborted) throw new PlanningEvidenceReaderError("CANCELLED");
    if (!requestIsValid(gtins, at)) {
      throw new PlanningEvidenceReaderError("INVALID_REQUEST");
    }
    const requestedGtins = [...gtins];
    const requestedSet = new Set(requestedGtins);
    const windowStartsAt = new Date(at.getTime() - HISTORY_AND_CURRENT_WINDOW_MS);
    const coverageStartsAt = new Date(at.getTime() - CURRENT_COVERAGE_WINDOW_MS);
    const client = this.db.$client;
    const query = client<PlanningEvidenceRow[]>`
      with requested_products as (
        select
          pi.value as gtin,
          pi.product_id
        from product_identifiers pi
        inner join canonical_products cp on cp.id = pi.product_id
        where pi.value = any(${client.array(requestedGtins)}::text[])
          and pi.scheme in ('ean8', 'ean13')
          and pi.confidence = 100
          and pi.verified_at is not null
          and pi.verified_at <= ${at}
          and pi.created_at <= ${at}
          and pi.public_state_changed_at <= ${at}
          and cp.created_at <= ${at}
          and cp.public_state_changed_at <= ${at}
          and cp.status = 'active'
      ),
      effective_sources as (
        select
          ds.id,
          ds.display_name,
          ds.source_kind,
          permission.permissions
        from data_sources ds
        inner join lateral (
          select permission.decision, permission.reviewed_at,
                 permission.valid_until, permission.permissions
          from source_permissions permission
          where permission.source_id = ds.id
            and permission.reviewed_at <= ${at}
            and permission.created_at <= ${at}
          order by permission.reviewed_at desc, permission.id desc
          limit 1
        ) permission on true
        where ds.runtime_state = 'approved'
          and ds.created_at <= ${at}
          and ds.public_state_changed_at <= ${at}
          and ds.permission_reviewed_at is not null
          and ds.permission_reviewed_at <= ${at}
          and (ds.permission_expires_at is null or ds.permission_expires_at > ${at})
          and permission.decision = 'approved'
          and permission.reviewed_at <= ${at}
          and (permission.valid_until is null or permission.valid_until > ${at})
      ),
      price_records as (
        select
          'price'::text as record_type,
          rp.gtin,
          rp.product_id,
          po.id as record_id,
          po.chain,
          po.amount_ore,
          po.observed_at,
          po.fetched_at,
          po.raw_record_hash,
          po.claim_eligibility,
          null::text as coverage_state,
          null::text as coverage_reason,
          null::timestamptz as checked_at,
          source.id as source_id,
          source.display_name,
          source.source_kind,
          gs.scope_kind,
          gs.country_code,
          gs.status as scope_status,
          coalesce(array(
            select gsr.region_code
            from geographic_scope_regions gsr
            where gsr.scope_id = gs.id
              and gsr.created_at <= ${at}
            order by gsr.region_code
          ), array[]::varchar[]) as region_codes,
          coalesce(array(
            select 'store:' || gss.store_id::text
            from geographic_scope_stores gss
            where gss.scope_id = gs.id
              and gss.created_at <= ${at}
            order by gss.store_id
          ), array[]::text[]) as store_ids
        from requested_products rp
        inner join price_observations po on po.product_id = rp.product_id
        inner join effective_sources source on source.id = po.source_id
        inner join ingestion_runs run
          on run.id = po.ingestion_run_id
         and run.source_id = po.source_id
        left join geographic_scopes gs on gs.id = po.geographic_scope_id
        where run.status = 'completed'
          and run.completed_at is not null
          and run.completed_at <= ${at}
          and run.created_at <= ${at}
          and run.terminalized_at <= ${at}
          and po.observed_at >= ${windowStartsAt}
          and po.observed_at <= ${at}
          and po.fetched_at <= ${at}
          and po.created_at <= ${at}
          and (
            po.geographic_scope_id is null
            or (
              gs.id is not null
              and gs.created_at <= ${at}
              and gs.public_state_changed_at <= ${at}
            )
          )
          and po.source_reference is not null
          and po.raw_record_hash is not null
          and po.confidence = 100
          and source.permissions @> '{"ordinaryPrice": true}'::jsonb
          and (
            po.claim_eligibility = 'ordinary_only'
            or
            (po.claim_eligibility = 'historical_eligible'
              and source.permissions @> '{"priceHistory": true}'::jsonb)
          )
      ),
      coverage_records as (
        select
          'coverage'::text as record_type,
          rp.gtin,
          rp.product_id,
          coverage.id as record_id,
          coverage.chain,
          null::integer as amount_ore,
          null::timestamptz as observed_at,
          null::timestamptz as fetched_at,
          null::text as raw_record_hash,
          null::text as claim_eligibility,
          coverage.state as coverage_state,
          coverage.reason as coverage_reason,
          coverage.checked_at,
          source.id as source_id,
          source.display_name,
          source.source_kind,
          gs.scope_kind,
          gs.country_code,
          gs.status as scope_status,
          coalesce(array(
            select gsr.region_code
            from geographic_scope_regions gsr
            where gsr.scope_id = gs.id
              and gsr.created_at <= ${at}
            order by gsr.region_code
          ), array[]::varchar[]) as region_codes,
          coalesce(array(
            select 'store:' || gss.store_id::text
            from geographic_scope_stores gss
            where gss.scope_id = gs.id
              and gss.created_at <= ${at}
            order by gss.store_id
          ), array[]::text[]) as store_ids
        from requested_products rp
        inner join price_coverage_checks coverage on coverage.product_id = rp.product_id
        inner join ingestion_runs run on run.id = coverage.ingestion_run_id
        inner join effective_sources source on source.id = run.source_id
        left join geographic_scopes gs on gs.id = coverage.geographic_scope_id
        where run.status = 'completed'
          and run.completed_at is not null
          and run.completed_at <= ${at}
          and run.created_at <= ${at}
          and run.terminalized_at <= ${at}
          and coverage.checked_at >= ${coverageStartsAt}
          and coverage.checked_at <= ${at}
          and coverage.created_at <= ${at}
          and (
            coverage.geographic_scope_id is null
            or (
              gs.id is not null
              and gs.created_at <= ${at}
              and gs.public_state_changed_at <= ${at}
            )
          )
          and source.permissions @> '{"ordinaryPrice": true}'::jsonb
      )
      select
        'product'::text as record_type,
        rp.gtin,
        rp.product_id,
        null::bigint as record_id,
        null::text as chain,
        null::integer as amount_ore,
        null::timestamptz as observed_at,
        null::timestamptz as fetched_at,
        null::text as raw_record_hash,
        null::text as claim_eligibility,
        null::text as coverage_state,
        null::text as coverage_reason,
        null::timestamptz as checked_at,
        null::text as source_id,
        null::text as display_name,
        null::text as source_kind,
        null::text as scope_kind,
        null::char(2) as country_code,
        null::text as scope_status,
        array[]::varchar[] as region_codes,
        array[]::text[] as store_ids
      from requested_products rp
      union all
      select * from price_records
      union all
      select * from coverage_records
      order by gtin, record_type, chain, record_id
      limit 10001
    `;

    try {
      const rows = await awaitAbortable(query, signal);
      if (signal?.aborted) throw new PlanningEvidenceReaderError("CANCELLED");
      if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
        throw new PlanningEvidenceReaderError("UNAVAILABLE");
      }

      const products = new Map<string, PlanningEvidenceProductIdentity>();
      const sources = new Map<string, ExactProductPlanApiEvidenceSource>();
      const prices = new Map<string, PriceEvidence>();
      const priceHistoryEligibility = new Map<string, boolean>();
      const historicalEligibleEvidenceIds = new Set<string>();
      const coverageChecks = new Map<string, CoverageCheck>();
      for (const candidate of rows as unknown[]) {
        if (!rowHasValidIdentity(candidate, requestedSet)) {
          throw new PlanningEvidenceReaderError("UNAVAILABLE");
        }
        const row = candidate;
        if (row.record_type === "product") {
          if (products.has(row.gtin)) throw new PlanningEvidenceReaderError("UNAVAILABLE");
          products.set(row.gtin, {
            canonicalProductId: `product:${row.product_id}`,
            gtin: row.gtin,
          });
          continue;
        }
        if (row.record_type === "price") {
          const price = priceFor(row, at);
          const previous = prices.get(price.id);
          const historicalEligible = row.claim_eligibility === "historical_eligible";
          if (
            (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(price))
            || (priceHistoryEligibility.has(price.id)
              && priceHistoryEligibility.get(price.id) !== historicalEligible)
          ) {
            throw new PlanningEvidenceReaderError("UNAVAILABLE");
          }
          prices.set(price.id, price);
          priceHistoryEligibility.set(price.id, historicalEligible);
          if (historicalEligible) {
            historicalEligibleEvidenceIds.add(price.id);
          }
          addSource(sources, sourceFor(row));
          continue;
        }
        const coverage = coverageFor(row, at);
        if (coverage === undefined) continue;
        const previousCoverage = coverageChecks.get(coverage.id);
        if (
          previousCoverage !== undefined
          && JSON.stringify(previousCoverage) !== JSON.stringify(coverage)
        ) {
          throw new PlanningEvidenceReaderError("UNAVAILABLE");
        }
        coverageChecks.set(coverage.id, coverage);
        addSource(sources, sourceFor(row));
      }

      if (
        products.size !== requestedGtins.length
        || requestedGtins.some((gtin) => !products.has(gtin))
      ) {
        throw new PlanningEvidenceReaderError("UNAVAILABLE");
      }

      return {
        coverageChecks: [...coverageChecks.values()].sort(
          (left, right) => compareText(left.canonicalProductId, right.canonicalProductId)
            || compareText(left.chainId, right.chainId)
            || compareText(left.id, right.id),
        ),
        historicalEligibleEvidenceIds: [...historicalEligibleEvidenceIds].sort(compareText),
        priceEvidence: [...prices.values()].sort(
          (left, right) => {
            const leftProduct = left.productMatch.kind === "exact"
              ? left.productMatch.canonicalProductId
              : "";
            const rightProduct = right.productMatch.kind === "exact"
              ? right.productMatch.canonicalProductId
              : "";
            return compareText(leftProduct, rightProduct)
              || compareText(left.chainId, right.chainId)
              || compareText(right.observedAt, left.observedAt)
              || compareText(left.id, right.id);
          },
        ),
        products: [...products.values()].sort((left, right) => compareText(left.gtin, right.gtin)),
        sources: [...sources.values()].sort((left, right) => compareText(left.id, right.id)),
      };
    } catch (error) {
      if (error instanceof PlanningEvidenceReaderError) throw error;
      if (signal?.aborted) throw new PlanningEvidenceReaderError("CANCELLED");
      throw new PlanningEvidenceReaderError("UNAVAILABLE");
    }
  }
}
