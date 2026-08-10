import { isValidGtin } from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

export interface WorkerGtinTargetReader {
  getCatalogDiscoveryPage(signal?: AbortSignal): Promise<number>;
  getCatalogGtins(limit: number, signal?: AbortSignal): Promise<readonly string[]>;
  getPriceGtins(
    limit: number,
    claimEligibility: "historical_eligible" | "ordinary_only",
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

const MAX_TARGETS = 500;

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TARGETS) {
    throw new TypeError(`limit must be an integer from 1 through ${MAX_TARGETS}`);
  }
}

function cancelledError(): Error & { code: "CANCELLED" } {
  return Object.assign(new Error("Worker target query cancelled"), {
    code: "CANCELLED" as const,
    name: "WorkerTargetReaderError",
  });
}

async function awaitAbortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function values(rows: readonly { ean: string }[]): string[] {
  return rows.map(({ ean }) => ean).filter(isValidGtin);
}

export function catalogDiscoveryPageForCompletedRuns(completedRuns: number): number {
  if (!Number.isSafeInteger(completedRuns) || completedRuns < 0) {
    throw new TypeError("completedRuns must be a non-negative safe integer");
  }
  if (completedRuns % 7 === 0) return 1;
  const deepPageIndex = completedRuns - Math.floor(completedRuns / 7) - 1;
  return 2 + (deepPageIndex % 99);
}

export class PostgresWorkerGtinTargetReader implements WorkerGtinTargetReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getCatalogDiscoveryPage(signal?: AbortSignal): Promise<number> {
    const rows = await awaitAbortable(this.db.$client<Array<{ completed_runs: number }>>`
      select (count(*) % 693)::integer as completed_runs
      from ingestion_runs
      where source_id = 'kassalapp'
        and run_type = 'catalog'
        and status = 'completed'
        and coalesce((counts->>'fetched')::integer, 0) > 0
    `, signal);
    if (signal?.aborted) throw cancelledError();
    const completedRuns = rows[0]?.completed_runs;
    if (!Number.isSafeInteger(completedRuns) || (completedRuns as number) < 0) {
      throw new TypeError("PostgreSQL returned an invalid catalog discovery cursor");
    }
    return catalogDiscoveryPageForCompletedRuns(completedRuns as number);
  }

  async getCatalogGtins(limit: number, signal?: AbortSignal): Promise<readonly string[]> {
    requireLimit(limit);
    const rows = await awaitAbortable(this.db.$client<Array<{ ean: string }>>`
      with identifier_candidates as (
        select
          identifier.value as ean,
          identifier.verified_at,
          (
            select max(source_product.last_seen_at)
            from source_products source_product
            where source_product.canonical_product_id = identifier.product_id
              and source_product.source_id = 'kassalapp'
          ) as last_refreshed_at
        from product_identifiers identifier
        join canonical_products product on product.id = identifier.product_id
        where identifier.scheme in ('ean8', 'ean13')
          and identifier.value ~ '^([0-9]{8}|[0-9]{13})$'
          and product.status in ('active', 'quarantined')
      ),
      legacy_cache_candidates as (
        select distinct
          cache.ean,
          null::timestamptz as verified_at,
          null::timestamptz as last_refreshed_at
        from price_cache cache
        where cache.ean ~ '^([0-9]{8}|[0-9]{13})$'
          and not exists (
            select 1
            from product_identifiers identifier
            where identifier.value = cache.ean
              and identifier.scheme in ('ean8', 'ean13')
          )
      ),
      catalog_candidates as (
        select * from identifier_candidates
        union all
        select * from legacy_cache_candidates
      )
      select candidate.ean
      from catalog_candidates candidate
      order by
        (candidate.verified_at is null) desc,
        candidate.last_refreshed_at asc nulls first,
        candidate.ean asc
      limit ${limit}
    `, signal);
    if (signal?.aborted) throw cancelledError();
    return values(rows);
  }

  async getPriceGtins(
    limit: number,
    claimEligibility: "historical_eligible" | "ordinary_only",
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    requireLimit(limit);
    if (claimEligibility !== "ordinary_only" && claimEligibility !== "historical_eligible") {
      throw new TypeError("Unsupported price target class");
    }
    const rows = await awaitAbortable(this.db.$client<Array<{ ean: string }>>`
      select identifier.value as ean
      from product_identifiers identifier
      join canonical_products product on product.id = identifier.product_id
      left join lateral (
        select max(observation.fetched_at) as last_refreshed_at
        from price_observations observation
        inner join ingestion_runs run on run.id = observation.ingestion_run_id
        where observation.product_id = identifier.product_id
          and observation.claim_eligibility = ${claimEligibility}
          and run.status = 'completed'
      ) refresh on true
      where identifier.scheme in ('ean8', 'ean13')
        and identifier.verified_at is not null
        and product.status = 'active'
      order by refresh.last_refreshed_at asc nulls first, identifier.value asc
      limit ${limit}
    `, signal);
    if (signal?.aborted) throw cancelledError();
    return values(rows);
  }
}
