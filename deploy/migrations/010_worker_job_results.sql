create table worker_job_results (
  id bigserial primary key,
  job_id varchar(200) not null,
  source_id varchar(64) not null references data_sources(id),
  job_kind varchar(40) not null,
  scheduled_at timestamptz not null,
  run_id varchar(200) not null,
  status varchar(16) not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  counts jsonb not null,
  result_hash char(64) not null,
  created_at timestamptz not null default now(),
  constraint worker_job_results_job_kind check (
    job_kind in (
      'catalog-refresh',
      'benchmark-price-refresh',
      'physical-store-sync',
      'historical-observation-collection'
    )
  ),
  constraint worker_job_results_status check (
    status in ('succeeded', 'partial', 'cancelled', 'timed-out', 'failed')
  ),
  constraint worker_job_results_time_range check (
    completed_at >= started_at and completed_at >= scheduled_at
  ),
  constraint worker_job_results_counts_object check (
    jsonb_typeof(counts) = 'object'
  ),
  constraint worker_job_results_hash_shape check (
    result_hash ~ '^[0-9a-f]{64}$'
  )
);

create unique index worker_job_results_job_id_unique
  on worker_job_results (job_id);

create index worker_job_results_source_kind_schedule_idx
  on worker_job_results (source_id, job_kind, scheduled_at desc, id desc);

create trigger worker_job_results_append_only
before update or delete on worker_job_results
for each row execute function reject_append_only_mutation();
