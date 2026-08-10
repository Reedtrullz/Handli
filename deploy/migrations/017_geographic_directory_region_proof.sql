-- Versioned postal geography is assembled while status=building, then sealed
-- into immutable evidence. A later blocked or retired version shadows an older
-- approval; runtime code never infers a region from coordinates or from a
-- caller-provided origin.
create table public.geographic_postal_directory_versions (
  version_id varchar(80) primary key,
  contract_version smallint not null,
  country_code char(2) not null,
  status varchar(16) not null,
  reviewed_at timestamptz not null,
  valid_from timestamptz not null,
  valid_until timestamptz,
  evidence_reference varchar(240) not null,
  created_at timestamptz not null default now(),
  sealed_at timestamptz,
  constraint geographic_postal_directory_contract check (contract_version = 1),
  constraint geographic_postal_directory_country check (country_code ~ '^[A-Z]{2}$'),
  constraint geographic_postal_directory_status check (
    status in ('building', 'approved', 'blocked', 'retired')
  ),
  constraint geographic_postal_directory_evidence_nonempty check (
    length(trim(evidence_reference)) > 0
  ),
  constraint geographic_postal_directory_review_clock check (
    reviewed_at <= created_at
  ),
  constraint geographic_postal_directory_seal_clock check (
    sealed_at is null or sealed_at >= created_at
  ),
  constraint geographic_postal_directory_seal_state check (
    (status = 'building' and sealed_at is null)
    or (status in ('approved', 'blocked', 'retired') and sealed_at is not null)
  ),
  constraint geographic_postal_directory_validity check (
    valid_until is null or valid_until > valid_from
  )
);

create index geographic_postal_directory_effective_idx
  on public.geographic_postal_directory_versions (
    country_code,
    reviewed_at desc,
    sealed_at desc,
    version_id
  );

create table public.geographic_postal_directory_regions (
  version_id varchar(80) not null
    references public.geographic_postal_directory_versions(version_id),
  region_code varchar(80) not null,
  coverage_state varchar(16) not null,
  postal_count integer not null,
  evidence_reference varchar(240) not null,
  created_at timestamptz not null default now(),
  primary key (version_id, region_code),
  constraint geographic_postal_directory_region_state check (
    coverage_state in ('complete', 'ambiguous')
  ),
  constraint geographic_postal_directory_region_count check (
    (coverage_state = 'complete' and postal_count between 1 and 10000)
    or (coverage_state = 'ambiguous' and postal_count between 0 and 10000)
  ),
  constraint geographic_postal_directory_region_code_nonempty check (
    length(trim(region_code)) > 0
  ),
  constraint geographic_postal_directory_region_evidence_nonempty check (
    length(trim(evidence_reference)) > 0
  )
);

create table public.geographic_postal_directory_codes (
  version_id varchar(80) not null,
  region_code varchar(80) not null,
  postal_code char(4) not null,
  created_at timestamptz not null default now(),
  primary key (version_id, region_code, postal_code),
  constraint geographic_postal_directory_codes_region_fk foreign key (
    version_id,
    region_code
  ) references public.geographic_postal_directory_regions(version_id, region_code),
  constraint geographic_postal_directory_codes_version_postal_unique unique (
    version_id,
    postal_code
  ),
  constraint geographic_postal_directory_postal_shape check (
    postal_code ~ '^[0-9]{4}$'
  )
);

create trigger geographic_postal_directory_versions_creation_clock
before insert on public.geographic_postal_directory_versions
for each row execute function public.stamp_persisted_creation_clock();

create trigger geographic_postal_directory_regions_creation_clock
before insert on public.geographic_postal_directory_regions
for each row execute function public.stamp_persisted_creation_clock();

create trigger geographic_postal_directory_codes_creation_clock
before insert on public.geographic_postal_directory_codes
for each row execute function public.stamp_persisted_creation_clock();

create function public.guard_geographic_postal_directory_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  region_count integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'building' or new.sealed_at is not null then
      raise exception 'postal directory must be inserted unsealed in building state'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'sealed postal directory versions are immutable'
      using errcode = '55000';
  end if;

  if old.status <> 'building' then
    raise exception 'sealed postal directory versions are immutable'
      using errcode = '55000';
  end if;
  if new.status not in ('approved', 'blocked', 'retired') then
    raise exception 'building postal directory requires a terminal seal state'
      using errcode = '23514';
  end if;
  if new.version_id is distinct from old.version_id
     or new.contract_version is distinct from old.contract_version
     or new.country_code is distinct from old.country_code
     or new.reviewed_at is distinct from old.reviewed_at
     or new.valid_from is distinct from old.valid_from
     or new.valid_until is distinct from old.valid_until
     or new.evidence_reference is distinct from old.evidence_reference
     or new.created_at is distinct from old.created_at
     or new.sealed_at is distinct from old.sealed_at then
    raise exception 'postal directory seal may change only status'
      using errcode = '23514';
  end if;

  if new.status = 'approved' then
    select count(*)::integer into region_count
    from public.geographic_postal_directory_regions region
    where region.version_id = old.version_id;
    if region_count = 0 then
      raise exception 'approved postal directory requires region evidence'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.geographic_postal_directory_regions region
      where region.version_id = old.version_id
        and region.postal_count <> (
          select count(*)
          from public.geographic_postal_directory_codes code
          where code.version_id = region.version_id
            and code.region_code = region.region_code
        )
    ) then
      raise exception 'postal directory region count must match immutable codes'
        using errcode = '23514';
    end if;
  end if;

  new.sealed_at := statement_timestamp();
  return new;
end;
$$;

create function public.guard_geographic_postal_directory_child()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  parent_status varchar(16);
begin
  if tg_op <> 'INSERT' then
    raise exception 'postal directory children are append-only'
      using errcode = '55000';
  end if;

  select version.status into parent_status
  from public.geographic_postal_directory_versions version
  where version.version_id = new.version_id
  for update;
  if parent_status is distinct from 'building' then
    raise exception 'sealed postal directory children are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger geographic_postal_directory_versions_lifecycle_guard
before insert or update or delete on public.geographic_postal_directory_versions
for each row execute function public.guard_geographic_postal_directory_version();

create trigger geographic_postal_directory_regions_lifecycle_guard
before insert or update or delete on public.geographic_postal_directory_regions
for each row execute function public.guard_geographic_postal_directory_child();

create trigger geographic_postal_directory_codes_lifecycle_guard
before insert or update or delete on public.geographic_postal_directory_codes
for each row execute function public.guard_geographic_postal_directory_child();

-- The immutable run snapshot keeps only source-provided postal evidence. Old
-- snapshots remain valid but cannot participate in region-bound routing.
alter table public.physical_store_observations
  add column postal_code varchar(4);

alter table public.physical_store_observations
  add constraint physical_store_observations_postal_shape check (
    postal_code is null or postal_code ~ '^[0-9]{4}$'
  );

-- Region proof is exposed without exposing the branch postal code, address,
-- external source identity, or any user location. The web role can only read
-- branches that join persisted observations to governed directory evidence.
create view public.physical_store_region_branches_public
with (security_barrier = true)
as
select
  'branch:' || observation.ingestion_run_id::text || ':' || observation.branch_key
    as branch_id,
  observation.chain,
  observation.name,
  observation.latitude,
  observation.longitude,
  observation.observed_at as branch_observed_at,
  observation.created_at as branch_created_at,
  version.version_id as directory_version_id,
  version.country_code,
  version.status as directory_status,
  version.reviewed_at as directory_reviewed_at,
  version.valid_from as directory_valid_from,
  version.valid_until as directory_valid_until,
  version.evidence_reference as directory_evidence_reference,
  version.created_at as directory_created_at,
  version.sealed_at as directory_sealed_at,
  region.region_code,
  region.coverage_state as region_coverage_state,
  region.postal_count as region_postal_count,
  region.evidence_reference as region_evidence_reference,
  region.created_at as region_created_at,
  code.created_at as postal_mapping_created_at
from public.physical_store_observations observation
inner join public.geographic_postal_directory_codes code
  on code.postal_code = observation.postal_code
inner join public.geographic_postal_directory_regions region
  on region.version_id = code.version_id
 and region.region_code = code.region_code
inner join public.geographic_postal_directory_versions version
  on version.version_id = region.version_id
where observation.status = 'active'
  and version.status = 'approved'
  and version.sealed_at is not null;
