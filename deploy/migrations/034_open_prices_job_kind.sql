-- Add open-prices-benchmark-refresh to the worker_job_results job_kind CHECK constraint.
-- The existing constraint does not include the open-prices job kind, causing INSERT
-- failures when the open-prices worker handler completes.
--
-- NOTE: Uses IN syntax instead of = ANY((...)) double-paren form because
-- postgres.js 3.4.9 extended query parser rejects the (( )) nesting.

alter table public.worker_job_results
  drop constraint if exists worker_job_results_job_kind;

alter table public.worker_job_results
  add constraint worker_job_results_job_kind check (
    job_kind in (
      'catalog-refresh',
      'benchmark-price-refresh',
      'physical-store-sync',
      'historical-observation-collection',
      'open-prices-benchmark-refresh',
      'official-offer-discovery',
      'official-offer-fetch',
      'official-offer-ingestion',
      'official-offer-lifecycle-reconcile'
    )
  );
