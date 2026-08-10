alter table ingestion_runs
  add column if not exists job_id varchar(200);

create unique index ingestion_runs_job_id_unique
  on ingestion_runs (job_id)
  where job_id is not null;

create table source_record_outcomes (
  id bigserial primary key,
  ingestion_run_id bigint not null references ingestion_runs(id),
  record_kind varchar(32) not null,
  source_record_id varchar(200) not null,
  outcome_state varchar(16) not null,
  reason varchar(80),
  subject_ean varchar(14),
  subject_chain varchar(32),
  raw_chain_code varchar(100),
  normalized_record jsonb,
  outcome_hash char(64) not null,
  recorded_at timestamptz not null,
  constraint source_record_outcomes_run_kind_record_unique unique (
    ingestion_run_id,
    record_kind,
    source_record_id
  ),
  constraint source_record_outcomes_state check (
    outcome_state in ('accepted', 'quarantined', 'unknown')
  ),
  constraint source_record_outcomes_reason_state check (
    (outcome_state = 'accepted' and reason is null)
    or (outcome_state in ('quarantined', 'unknown') and reason is not null)
  ),
  constraint source_record_outcomes_ean_shape check (
    subject_ean is null or subject_ean ~ '^([0-9]{8}|[0-9]{13})$'
  ),
  constraint source_record_outcomes_chain_supported check (
    subject_chain is null
    or subject_chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint source_record_outcomes_hash_shape check (
    outcome_hash ~ '^[0-9a-f]{64}$'
  )
);

create trigger source_record_outcomes_append_only
before update or delete on source_record_outcomes
for each row execute function reject_append_only_mutation();
