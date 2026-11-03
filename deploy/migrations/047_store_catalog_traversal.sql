-- A checkpoint is appended with the fenced result only after ingestion completes.
alter table worker_job_results add column store_traversal jsonb;
alter table worker_job_results add constraint worker_job_results_store_traversal
  check (store_traversal is null or (
    source_id = 'kassalapp' and job_kind = 'store-catalog-price-refresh'
    and status in ('succeeded', 'partial')
    and jsonb_typeof(store_traversal) = 'array'
    and jsonb_array_length(store_traversal) = 5
  ));
