create function enforce_ingestion_run_lifecycle()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ingestion_runs lifecycle forbids deletion'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'running' then
      raise exception 'ingestion_runs lifecycle requires a running insert'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.job_id is distinct from old.job_id
     or new.source_id is distinct from old.source_id
     or new.run_type is distinct from old.run_type
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'ingestion_runs lifecycle identity is immutable'
      using errcode = '55000';
  end if;

  if old.status <> 'running' then
    raise exception 'ingestion_runs lifecycle terminal row is immutable'
      using errcode = '55000';
  end if;

  if new.status not in ('completed', 'degraded', 'failed', 'cancelled')
     or new.completed_at is null then
    raise exception 'ingestion_runs lifecycle allows only one running-to-terminal transition'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger ingestion_runs_lifecycle_guard
before insert or update or delete on ingestion_runs
for each row execute function enforce_ingestion_run_lifecycle();

create table catalog_observations (
  id bigserial primary key,
  ingestion_run_id bigint not null references ingestion_runs(id),
  source_record_id varchar(128) not null,
  canonical_product_id bigint not null references canonical_products(id),
  gtin varchar(14) not null,
  display_name varchar(240) not null,
  brand varchar(160),
  package_amount integer not null,
  package_unit varchar(16) not null,
  units_per_pack integer not null default 1,
  retrieved_at timestamptz not null,
  source_updated_at timestamptz,
  raw_record_hash char(64) not null,
  created_at timestamptz not null default now(),
  constraint catalog_observations_run_record_unique unique (
    ingestion_run_id,
    source_record_id
  ),
  constraint catalog_observations_gtin_shape check (
    gtin ~ '^([0-9]{8}|[0-9]{13})$'
  ),
  constraint catalog_observations_display_name_nonempty check (
    length(trim(display_name)) > 0
  ),
  constraint catalog_observations_package_amount_positive check (
    package_amount > 0
  ),
  constraint catalog_observations_package_unit check (
    package_unit in ('g', 'ml', 'piece', 'package')
  ),
  constraint catalog_observations_units_per_pack_positive check (
    units_per_pack > 0
  ),
  constraint catalog_observations_source_time_order check (
    source_updated_at is null or source_updated_at <= retrieved_at
  ),
  constraint catalog_observations_hash_shape check (
    raw_record_hash ~ '^[0-9a-f]{64}$'
  )
);

create index catalog_observations_gtin_retrieved_idx
  on catalog_observations (gtin, retrieved_at desc, id desc);

create index catalog_observations_product_retrieved_idx
  on catalog_observations (canonical_product_id, retrieved_at desc, id desc);

create trigger catalog_observations_append_only
before update or delete on catalog_observations
for each row execute function reject_append_only_mutation();
