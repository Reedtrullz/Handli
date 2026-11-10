-- Add store-catalog-price-refresh to the worker_job_results job_kind CHECK
-- constraint. Without it, the new store-scoped catalog+price worker handler
-- cannot persist its results (same failure mode migration 034 fixed for
-- open-prices-benchmark-refresh).

alter table public.worker_job_results
  drop constraint if exists worker_job_results_job_kind;

alter table public.worker_job_results
  add constraint worker_job_results_job_kind check (
    job_kind in (
      'catalog-refresh',
      'benchmark-price-refresh',
      'store-catalog-price-refresh',
      'physical-store-sync',
      'historical-observation-collection',
      'open-prices-benchmark-refresh',
      'official-offer-discovery',
      'official-offer-fetch',
      'official-offer-ingestion',
      'official-offer-lifecycle-reconcile'
    )
  );
