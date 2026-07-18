-- Immutable, run-scoped branch snapshots keep public travel suggestions tied
-- to one auditable physical-store sync instead of the mutable private store
-- projection.  Coverage is explicit per chain; absence is never completeness.
create table physical_store_observations (
  id bigserial primary key,
  ingestion_run_id bigint not null references ingestion_runs(id),
  source_id varchar(64) not null references data_sources(id),
  branch_key char(64) not null,
  external_id varchar(128) not null,
  chain varchar(32) not null,
  name varchar(240) not null,
  latitude numeric(9, 6) not null,
  longitude numeric(9, 6) not null,
  status varchar(16) not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint physical_store_observations_run_external_unique unique (
    ingestion_run_id,
    source_id,
    external_id
  ),
  constraint physical_store_observations_run_branch_unique unique (
    ingestion_run_id,
    branch_key
  ),
  constraint physical_store_observations_branch_key_shape check (
    branch_key ~ '^[0-9a-f]{64}$'
  ),
  constraint physical_store_observations_branch_key_binding check (
    branch_key = encode(
      sha256(convert_to(
        octet_length(source_id)::text || ':' || source_id || external_id,
        'UTF8'
      )),
      'hex'
    )
  ),
  constraint physical_store_observations_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint physical_store_observations_name_nonempty check (
    length(trim(name)) > 0
  ),
  constraint physical_store_observations_latitude_range check (
    latitude between -90 and 90
  ),
  constraint physical_store_observations_longitude_range check (
    longitude between -180 and 180
  ),
  constraint physical_store_observations_status check (
    status in ('active', 'closed', 'unknown')
  ),
  constraint physical_store_observations_observed_before_creation check (
    observed_at <= created_at
  )
);

create index physical_store_observations_run_chain_status_idx
  on physical_store_observations (ingestion_run_id, chain, status, branch_key);

create table physical_store_coverage_checks (
  id bigserial primary key,
  ingestion_run_id bigint not null references ingestion_runs(id),
  source_id varchar(64) not null references data_sources(id),
  chain varchar(32) not null,
  state varchar(16) not null,
  reason varchar(40),
  record_count integer not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint physical_store_coverage_checks_run_chain_unique unique (
    ingestion_run_id,
    chain
  ),
  constraint physical_store_coverage_checks_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint physical_store_coverage_checks_state check (
    state in ('complete', 'unknown')
  ),
  constraint physical_store_coverage_checks_reason_state check (
    (
      state = 'complete'
      and reason is null
      and record_count > 0
    ) or (
      state = 'unknown'
      and reason in (
        'DUPLICATE_IDENTITY',
        'INVALID_RECORDS',
        'MISSING_SUPPORTED_CHAIN',
        'POSSIBLY_TRUNCATED',
        'REQUEST_FAILED'
      )
    )
  ),
  constraint physical_store_coverage_checks_record_count_range check (
    record_count between 0 and 1000
  ),
  constraint physical_store_coverage_checks_checked_before_creation check (
    checked_at <= created_at
  )
);

create index physical_store_coverage_checks_run_chain_state_idx
  on physical_store_coverage_checks (ingestion_run_id, chain, state, checked_at);

create trigger physical_store_observations_creation_clock
before insert on physical_store_observations
for each row execute function stamp_persisted_creation_clock();

create trigger physical_store_coverage_checks_creation_clock
before insert on physical_store_coverage_checks
for each row execute function stamp_persisted_creation_clock();

create trigger physical_store_observations_append_only
before update or delete on physical_store_observations
for each row execute function reject_append_only_mutation();

create trigger physical_store_coverage_checks_append_only
before update or delete on physical_store_coverage_checks
for each row execute function reject_append_only_mutation();

create function enforce_running_physical_store_evidence_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  run_source_id varchar(64);
  run_status varchar(16);
  run_type varchar(32);
begin
  select source_id, status, ingestion_runs.run_type
  into run_source_id, run_status, run_type
  from ingestion_runs
  where id = new.ingestion_run_id
  for update;

  if run_status is distinct from 'running' then
    raise exception '% requires a running ingestion run', tg_table_name
      using errcode = '55000';
  end if;

  if run_type is distinct from 'physical-stores' then
    raise exception '% requires a physical-store-sync ingestion run', tg_table_name
      using errcode = '23514';
  end if;

  if new.source_id is distinct from run_source_id then
    raise exception '% source must match its ingestion run', tg_table_name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger physical_store_observations_running_run_guard
before insert on physical_store_observations
for each row execute function enforce_running_physical_store_evidence_insert();

create trigger physical_store_coverage_checks_running_run_guard
before insert on physical_store_coverage_checks
for each row execute function enforce_running_physical_store_evidence_insert();

-- A completed run may be public evidence only when its declared complete row
-- count is exactly the immutable routeable observation count. This keeps a
-- direct worker-role insert from bypassing repository-side atomic validation.
create function enforce_completed_physical_store_run_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.run_type <> 'physical-stores' or new.status <> 'completed' then
    return new;
  end if;

  if not exists (
    select 1
    from physical_store_coverage_checks coverage
    where coverage.ingestion_run_id = new.id
  ) then
    raise exception 'completed physical-store run requires coverage evidence'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from physical_store_observations observation
    where observation.ingestion_run_id = new.id
      and not exists (
        select 1
        from physical_store_coverage_checks coverage
        where coverage.ingestion_run_id = new.id
          and coverage.chain = observation.chain
      )
  ) then
    raise exception 'physical-store observation requires same-run chain coverage'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from physical_store_coverage_checks coverage
    where coverage.ingestion_run_id = new.id
      and coverage.state = 'complete'
      and coverage.record_count <> (
        select count(*)
        from physical_store_observations observation
        where observation.ingestion_run_id = new.id
          and observation.chain = coverage.chain
      )
  ) then
    raise exception 'complete physical-store coverage count does not match observations'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger ingestion_runs_physical_store_completion_guard
after update on ingestion_runs
for each row execute function enforce_completed_physical_store_run_consistency();

-- The run-scoped opaque identity lets the server bind a branch to one selected
-- evidence run while the only visible branch attributes are identity, chain,
-- name, and map point. Private address/postal/municipality fields remain in
-- physical_stores.
create view physical_store_branches_public
with (security_barrier = true)
as
select
  'branch:' || observation.ingestion_run_id::text || ':' || observation.branch_key
    as branch_id,
  observation.chain,
  observation.name,
  observation.latitude,
  observation.longitude
from physical_store_observations observation
where observation.status = 'active';
