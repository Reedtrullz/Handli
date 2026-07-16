alter table ingestion_runs
  add column terminalized_at timestamptz;

do $validate_existing_ingestion_runs$
begin
  if exists (
    select 1
    from ingestion_runs
    where (status = 'running' and completed_at is not null)
       or (status <> 'running' and completed_at is null)
  ) then
    raise exception 'existing ingestion run lifecycle is inconsistent'
      using errcode = '23514';
  end if;
end;
$validate_existing_ingestion_runs$;

-- Pre-012 terminal transitions have no trustworthy database-recorded clock.
-- Backfill them no earlier than migration/creation time so historical reads
-- fail closed instead of trusting caller-supplied completion timestamps.
alter table ingestion_runs disable trigger ingestion_runs_lifecycle_guard;
update ingestion_runs
set terminalized_at = greatest(transaction_timestamp(), created_at)
where status <> 'running';
alter table ingestion_runs enable trigger ingestion_runs_lifecycle_guard;

create or replace function enforce_ingestion_run_lifecycle()
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
    if new.status <> 'running'
       or new.completed_at is not null
       or new.terminalized_at is not null then
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
     or new.completed_at is null
     or new.terminalized_at is not null then
    raise exception 'ingestion_runs lifecycle allows only one running-to-terminal transition'
      using errcode = '55000';
  end if;

  new.terminalized_at := statement_timestamp();
  return new;
end;
$$;

alter table ingestion_runs
  add constraint ingestion_runs_terminalization_state check (
    (
      status = 'running'
      and completed_at is null
      and terminalized_at is null
    ) or (
      status <> 'running'
      and completed_at is not null
      and terminalized_at is not null
      and terminalized_at >= created_at
    )
  );

-- The business/source updated_at fields on these rows are caller-controlled
-- and cannot establish what the database had persisted at an as-of boundary.
-- Keep an independent database-owned clock for every mutation that can change
-- public identity or eligibility. Readers use it to fail closed for snapshots
-- captured before a later mutation instead of retroactively gaining/changing
-- data under the same timestamp.
alter table data_sources
  add column public_state_changed_at timestamptz;
update data_sources
set public_state_changed_at = greatest(transaction_timestamp(), created_at);
alter table data_sources
  alter column public_state_changed_at set default now(),
  alter column public_state_changed_at set not null,
  add constraint data_sources_public_state_clock check (
    public_state_changed_at >= created_at
  );

alter table canonical_products
  add column public_state_changed_at timestamptz;
update canonical_products
set public_state_changed_at = greatest(transaction_timestamp(), created_at);
alter table canonical_products
  alter column public_state_changed_at set default now(),
  alter column public_state_changed_at set not null,
  add constraint canonical_products_public_state_clock check (
    public_state_changed_at >= created_at
  );

alter table product_identifiers
  add column public_state_changed_at timestamptz;
update product_identifiers
set public_state_changed_at = greatest(transaction_timestamp(), created_at);
alter table product_identifiers
  alter column public_state_changed_at set default now(),
  alter column public_state_changed_at set not null,
  add constraint product_identifiers_public_state_clock check (
    public_state_changed_at >= created_at
  );

alter table geographic_scopes
  add column public_state_changed_at timestamptz;
update geographic_scopes
set public_state_changed_at = greatest(transaction_timestamp(), created_at);
alter table geographic_scopes
  alter column public_state_changed_at set default now(),
  alter column public_state_changed_at set not null,
  add constraint geographic_scopes_public_state_clock check (
    public_state_changed_at >= created_at
  );

create function stamp_public_state_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.public_state_changed_at := statement_timestamp();
  return new;
end;
$$;

create trigger data_sources_public_state_clock
before insert or update on data_sources
for each row execute function stamp_public_state_change();

create trigger canonical_products_public_state_clock
before insert or update on canonical_products
for each row execute function stamp_public_state_change();

create trigger product_identifiers_public_state_clock
before insert or update on product_identifiers
for each row execute function stamp_public_state_change();

create trigger geographic_scopes_public_state_clock
before insert or update on geographic_scopes
for each row execute function stamp_public_state_change();

-- Older permission decisions and ingestion outcomes predate a trustworthy
-- persistence clock. Backfill them at migration time while their append-only
-- guards are explicitly suspended, then make every future insert
-- database-stamped. Source rows and terminal runs receive the same migration
-- boundary above, so pre-012 public snapshots remain fail closed.
alter table source_permissions disable trigger source_permissions_append_only;
update source_permissions
set created_at = greatest(transaction_timestamp(), created_at);
alter table source_permissions enable trigger source_permissions_append_only;

alter table source_record_outcomes add column created_at timestamptz;
alter table source_record_outcomes disable trigger source_record_outcomes_append_only;
update source_record_outcomes set created_at = transaction_timestamp();
alter table source_record_outcomes enable trigger source_record_outcomes_append_only;
alter table source_record_outcomes
  alter column created_at set default now(),
  alter column created_at set not null;

-- Scope membership is part of the public scope identity. It has no business
-- update lifecycle, so seal it as append-only evidence and record insertion
-- with a database-owned clock. Existing memberships become visible no earlier
-- than migration 012, which is the conservative answer for old snapshots.
alter table geographic_scope_regions add column created_at timestamptz;
alter table geographic_scope_postal_codes add column created_at timestamptz;
alter table geographic_scope_stores add column created_at timestamptz;

update geographic_scope_regions set created_at = transaction_timestamp();
update geographic_scope_postal_codes set created_at = transaction_timestamp();
update geographic_scope_stores set created_at = transaction_timestamp();

alter table geographic_scope_regions
  alter column created_at set default now(),
  alter column created_at set not null;
alter table geographic_scope_postal_codes
  alter column created_at set default now(),
  alter column created_at set not null;
alter table geographic_scope_stores
  alter column created_at set default now(),
  alter column created_at set not null;

create function stamp_persisted_creation_clock()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.created_at := statement_timestamp();
  return new;
end;
$$;

create trigger geographic_scope_regions_creation_clock
before insert on geographic_scope_regions
for each row execute function stamp_persisted_creation_clock();

create trigger geographic_scope_postal_codes_creation_clock
before insert on geographic_scope_postal_codes
for each row execute function stamp_persisted_creation_clock();

create trigger geographic_scope_stores_creation_clock
before insert on geographic_scope_stores
for each row execute function stamp_persisted_creation_clock();

create trigger source_permissions_creation_clock
before insert on source_permissions
for each row execute function stamp_persisted_creation_clock();

create trigger price_observations_creation_clock
before insert on price_observations
for each row execute function stamp_persisted_creation_clock();

create trigger price_coverage_checks_creation_clock
before insert on price_coverage_checks
for each row execute function stamp_persisted_creation_clock();

create trigger source_record_outcomes_creation_clock
before insert on source_record_outcomes
for each row execute function stamp_persisted_creation_clock();

create trigger catalog_observations_creation_clock
before insert on catalog_observations
for each row execute function stamp_persisted_creation_clock();

create trigger geographic_scope_regions_append_only
before update or delete on geographic_scope_regions
for each row execute function reject_append_only_mutation();

create trigger geographic_scope_postal_codes_append_only
before update or delete on geographic_scope_postal_codes
for each row execute function reject_append_only_mutation();

create trigger geographic_scope_stores_append_only
before update or delete on geographic_scope_stores
for each row execute function reject_append_only_mutation();

-- Serialize every run-linked append with finalization. The row lock makes the
-- status check race-free: either the append completes while the run is still
-- running, or finalization wins and the append is rejected. This closes the
-- otherwise-valid path of attaching a backdated child to a terminal run.
do $validate_existing_ingestion_evidence_provenance$
begin
  if exists (
    select 1
    from catalog_observations observation
    inner join ingestion_runs run on run.id = observation.ingestion_run_id
    where run.run_type <> 'catalog'
  ) then
    raise exception 'existing catalog observation has incompatible run provenance'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from price_observations observation
    inner join ingestion_runs run on run.id = observation.ingestion_run_id
    where observation.source_id <> run.source_id
       or not (
         (
           run.run_type = 'historical-prices'
           and observation.claim_eligibility = 'historical_eligible'
         ) or (
           run.run_type in ('benchmark-prices', 'interactive_price_mirror')
           and observation.claim_eligibility = 'ordinary_only'
         ) or (
           run.source_id = 'legacy-import'
           and run.run_type = 'price_cache_backfill'
           and observation.claim_eligibility = 'ordinary_only'
         )
       )
  ) then
    raise exception 'existing price observation has incompatible run provenance'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from price_coverage_checks coverage
    inner join ingestion_runs run on run.id = coverage.ingestion_run_id
    where run.run_type not in ('benchmark-prices', 'interactive_price_mirror')
      and not (
        run.source_id = 'legacy-import'
        and run.run_type = 'price_cache_backfill'
      )
  ) then
    raise exception 'existing price coverage has incompatible run provenance'
      using errcode = '23514';
  end if;
end;
$validate_existing_ingestion_evidence_provenance$;

create function enforce_running_ingestion_evidence_insert()
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

  if tg_table_name = 'catalog_observations'
     and run_type is distinct from 'catalog' then
    raise exception 'catalog_observations requires a catalog ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_observations'
     and run_type not in (
       'benchmark-prices',
       'historical-prices',
       'interactive_price_mirror'
     ) then
    raise exception 'price_observations requires a price ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_observations'
     and (to_jsonb(new) ->> 'source_id') is distinct from run_source_id then
    raise exception 'price_observations source must match its ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_observations'
     and (
       (
         run_type = 'historical-prices'
         and (to_jsonb(new) ->> 'claim_eligibility') is distinct from 'historical_eligible'
       ) or (
         run_type <> 'historical-prices'
         and (to_jsonb(new) ->> 'claim_eligibility') is distinct from 'ordinary_only'
       )
     ) then
    raise exception 'price_observations eligibility must match its ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_coverage_checks'
     and run_type not in ('benchmark-prices', 'interactive_price_mirror') then
    raise exception 'price_coverage_checks requires an ordinary-price ingestion run'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger catalog_observations_running_run_guard
before insert on catalog_observations
for each row execute function enforce_running_ingestion_evidence_insert();

create trigger price_observations_running_run_guard
before insert on price_observations
for each row execute function enforce_running_ingestion_evidence_insert();

create trigger price_coverage_checks_running_run_guard
before insert on price_coverage_checks
for each row execute function enforce_running_ingestion_evidence_insert();

create trigger source_record_outcomes_running_run_guard
before insert on source_record_outcomes
for each row execute function enforce_running_ingestion_evidence_insert();

create function canonical_family_taxonomy_json(input_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  canonical text;
begin
  case
    when jsonb_typeof(input_value) in ('null', 'boolean', 'number', 'string') then
      return input_value::text;
    when jsonb_typeof(input_value) = 'array' then
      select '[' || coalesce(
        string_agg(
          public.canonical_family_taxonomy_json(element.value),
          ',' order by element.ordinality
        ),
        ''
      ) || ']'
      into canonical
      from jsonb_array_elements(input_value) with ordinality
        as element(value, ordinality);
      return canonical;
    when jsonb_typeof(input_value) = 'object' then
      select '{' || coalesce(
        string_agg(
          to_jsonb(entry.key)::text || ':'
            || public.canonical_family_taxonomy_json(entry.value),
          ',' order by entry.key collate "C"
        ),
        ''
      ) || '}'
      into canonical
      from jsonb_each(input_value) as entry(key, value);
      return canonical;
    else
      raise exception 'unsupported JSON value in family taxonomy'
        using errcode = '22023';
  end case;
end;
$$;

create table family_taxonomy_versions (
  version_id varchar(120) primary key,
  taxonomy_id varchar(80) not null,
  taxonomy_version varchar(32) not null,
  contract_version smallint not null,
  published_at timestamptz not null,
  content_sha256 char(64) not null,
  content_json jsonb not null,
  expected_family_count integer not null,
  expected_alias_count integer not null,
  created_at timestamptz not null default now(),
  constraint family_taxonomy_versions_taxonomy_version_unique unique (
    taxonomy_id,
    taxonomy_version
  ),
  constraint family_taxonomy_versions_taxonomy_publication_unique unique (
    taxonomy_id,
    published_at
  ),
  constraint family_taxonomy_versions_version_id_binding check (
    version_id = taxonomy_id || '@' || taxonomy_version
  ),
  constraint family_taxonomy_versions_taxonomy_id_shape check (
    taxonomy_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint family_taxonomy_versions_semver_shape check (
    taxonomy_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint family_taxonomy_versions_contract_version check (
    contract_version = 1
  ),
  constraint family_taxonomy_versions_checksum_shape check (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint family_taxonomy_versions_content_array check (
    jsonb_typeof(content_json) = 'array'
  ),
  constraint family_taxonomy_versions_family_count_range check (
    expected_family_count between 1 and 500
    and jsonb_array_length(content_json) = expected_family_count
  ),
  constraint family_taxonomy_versions_alias_count_range check (
    expected_alias_count between 0 and expected_family_count * 20
  ),
  constraint family_taxonomy_versions_publication_not_future_created check (
    published_at <= created_at
  )
);

create table reviewed_family_definitions (
  version_id varchar(120) not null references family_taxonomy_versions(version_id),
  family_id varchar(80) not null,
  slug varchar(80) not null,
  label_no varchar(160) not null,
  parent_family_id varchar(80),
  status varchar(16) not null,
  created_at timestamptz not null default now(),
  constraint reviewed_family_definitions_pkey primary key (version_id, family_id),
  constraint reviewed_family_definitions_version_slug_unique unique (version_id, slug),
  constraint reviewed_family_definitions_version_parent_fk foreign key (
    version_id,
    parent_family_id
  ) references reviewed_family_definitions(version_id, family_id)
    deferrable initially deferred,
  constraint reviewed_family_definitions_family_id_shape check (
    family_id ~ '^family:[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint reviewed_family_definitions_slug_shape check (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint reviewed_family_definitions_label_nonempty check (
    length(trim(label_no)) > 0
  ),
  constraint reviewed_family_definitions_parent_not_self check (
    parent_family_id is null or parent_family_id <> family_id
  ),
  constraint reviewed_family_definitions_status check (
    status in ('active', 'retired')
  )
);

create table reviewed_family_aliases (
  version_id varchar(120) not null,
  family_id varchar(80) not null,
  alias varchar(80) not null,
  created_at timestamptz not null default now(),
  constraint reviewed_family_aliases_pkey primary key (version_id, alias),
  constraint reviewed_family_aliases_definition_fk foreign key (
    version_id,
    family_id
  ) references reviewed_family_definitions(version_id, family_id),
  constraint reviewed_family_aliases_alias_nonempty check (
    length(trim(alias)) > 0
  ),
  constraint reviewed_family_aliases_alias_shape check (
    alias ~ '^[a-z0-9æøå]+([ -][a-z0-9æøå]+)*$'
  )
);

create table reviewed_family_membership_decisions (
  id bigserial primary key,
  version_id varchar(120) not null,
  family_id varchar(80) not null,
  product_id bigint not null references canonical_products(id),
  decision varchar(16) not null,
  method varchar(24) not null,
  confidence smallint not null,
  reviewer_id varchar(160),
  reviewed_at timestamptz not null,
  rule_version varchar(80),
  created_at timestamptz not null default now(),
  constraint reviewed_family_membership_decisions_definition_fk foreign key (
    version_id,
    family_id
  ) references reviewed_family_definitions(version_id, family_id),
  constraint reviewed_family_membership_decisions_decision check (
    decision in ('approved', 'candidate', 'rejected')
  ),
  constraint reviewed_family_membership_decisions_method check (
    method in ('deterministic_rule', 'human_review')
  ),
  constraint reviewed_family_membership_decisions_confidence_range check (
    confidence between 0 and 100
  ),
  constraint reviewed_family_membership_decisions_provenance check (
    (
      method = 'human_review'
      and reviewer_id is not null
      and length(trim(reviewer_id)) > 0
      and rule_version is null
    ) or (
      method = 'deterministic_rule'
      and reviewer_id is null
      and rule_version is not null
      and length(trim(rule_version)) > 0
    )
  ),
  constraint reviewed_family_membership_decisions_review_not_future_created check (
    reviewed_at <= created_at
  )
);

create trigger reviewed_family_membership_decisions_creation_clock
before insert on reviewed_family_membership_decisions
for each row execute function stamp_persisted_creation_clock();

create function assert_family_taxonomy_publication(target_version_id varchar)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  actual_alias_count bigint;
  actual_content jsonb;
  actual_family_count bigint;
  actual_sha256 text;
  publication family_taxonomy_versions%rowtype;
begin
  select *
  into strict publication
  from family_taxonomy_versions version
  where version.version_id = target_version_id;

  select
    coalesce(jsonb_agg(family.descriptor order by family.family_id collate "C"), '[]'::jsonb),
    count(*)
  into actual_content, actual_family_count
  from (
    select
      definition.family_id,
      jsonb_build_object(
        'aliases', coalesce((
          select jsonb_agg(alias.alias order by alias.alias collate "C")
          from reviewed_family_aliases alias
          where alias.version_id = definition.version_id
            and alias.family_id = definition.family_id
        ), '[]'::jsonb),
        'id', definition.family_id,
        'labelNo', definition.label_no,
        'slug', definition.slug,
        'status', definition.status
      ) || case
        when definition.parent_family_id is null then '{}'::jsonb
        else jsonb_build_object('parentId', definition.parent_family_id)
      end as descriptor
    from reviewed_family_definitions definition
    where definition.version_id = target_version_id
  ) family;

  select count(*)
  into actual_alias_count
  from reviewed_family_aliases alias
  where alias.version_id = target_version_id;

  actual_sha256 := encode(
    sha256(convert_to(public.canonical_family_taxonomy_json(actual_content), 'UTF8')),
    'hex'
  );

  if actual_family_count <> publication.expected_family_count
     or actual_alias_count <> publication.expected_alias_count
     or actual_content is distinct from publication.content_json
     or actual_sha256 <> publication.content_sha256 then
    raise exception 'family taxonomy publication does not match its sealed content'
      using
        errcode = '23514',
        constraint = 'family_taxonomy_versions_publication_check';
  end if;
end;
$$;

create function validate_family_taxonomy_publication()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform assert_family_taxonomy_publication(new.version_id);
  return null;
end;
$$;

create constraint trigger family_taxonomy_versions_publication_check
after insert on family_taxonomy_versions
deferrable initially deferred
for each row execute function validate_family_taxonomy_publication();

-- Queue the same end-of-transaction verification for every row that can
-- change a publication's reconstructed content.  This also closes the
-- SET CONSTRAINTS ... IMMEDIATE case: any later child insert is checked
-- immediately instead of escaping the already-fired version trigger.
create constraint trigger reviewed_family_definitions_publication_check
after insert on reviewed_family_definitions
deferrable initially deferred
for each row execute function validate_family_taxonomy_publication();

create constraint trigger reviewed_family_aliases_publication_check
after insert on reviewed_family_aliases
deferrable initially deferred
for each row execute function validate_family_taxonomy_publication();

create index reviewed_family_membership_decisions_latest_idx
  on reviewed_family_membership_decisions (
    version_id,
    family_id,
    product_id,
    reviewed_at desc,
    id desc
  );

create view reviewed_family_membership_public
with (security_barrier = true)
as
select
  id,
  version_id,
  family_id,
  product_id,
  decision,
  method,
  confidence,
  reviewed_at,
  rule_version,
  created_at,
  (
    reviewer_id is not null
    and length(trim(reviewer_id)) > 0
  ) as reviewer_attested
from reviewed_family_membership_decisions;

create function enforce_family_taxonomy_build_window()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.created_at is distinct from transaction_timestamp()
     or not exists (
       select 1
       from family_taxonomy_versions version
       where version.version_id = new.version_id
         and version.created_at = transaction_timestamp()
     ) then
    raise exception 'reviewed family definitions can only be appended while creating their version'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger reviewed_family_definitions_build_window
before insert on reviewed_family_definitions
for each row execute function enforce_family_taxonomy_build_window();

create trigger reviewed_family_aliases_build_window
before insert on reviewed_family_aliases
for each row execute function enforce_family_taxonomy_build_window();

create trigger family_taxonomy_versions_append_only
before update or delete on family_taxonomy_versions
for each row execute function reject_append_only_mutation();

create trigger reviewed_family_definitions_append_only
before update or delete on reviewed_family_definitions
for each row execute function reject_append_only_mutation();

create trigger reviewed_family_aliases_append_only
before update or delete on reviewed_family_aliases
for each row execute function reject_append_only_mutation();

create trigger reviewed_family_membership_decisions_append_only
before update or delete on reviewed_family_membership_decisions
for each row execute function reject_append_only_mutation();

-- The seed below is generated from docs/data/product-family-taxonomy.v1.json.
-- Its exact SHA-256 is filled by the same source-controlled V1-05A change.
insert into family_taxonomy_versions (
  version_id,
  taxonomy_id,
  taxonomy_version,
  contract_version,
  published_at,
  content_sha256,
  content_json,
  expected_family_count,
  expected_alias_count
) values (
  'handleplan-reviewed-families@1.0.0',
  'handleplan-reviewed-families',
  '1.0.0',
  1,
  '2026-07-16T00:00:00.000Z',
  '1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520',
  '[
    {"aliases":["brød"],"id":"family:brod","labelNo":"Brød","slug":"brod","status":"active"},
    {"aliases":[],"id":"family:kaffe","labelNo":"Kaffe","slug":"kaffe","status":"active"},
    {"aliases":["mjølk"],"id":"family:melk","labelNo":"Melk","slug":"melk","status":"active"}
  ]'::jsonb,
  3,
  2
);

insert into reviewed_family_definitions (
  version_id,
  family_id,
  slug,
  label_no,
  parent_family_id,
  status
) values
  ('handleplan-reviewed-families@1.0.0', 'family:brod', 'brod', 'Brød', null, 'active'),
  ('handleplan-reviewed-families@1.0.0', 'family:kaffe', 'kaffe', 'Kaffe', null, 'active'),
  ('handleplan-reviewed-families@1.0.0', 'family:melk', 'melk', 'Melk', null, 'active');

insert into reviewed_family_aliases (version_id, family_id, alias) values
  ('handleplan-reviewed-families@1.0.0', 'family:brod', 'brød'),
  ('handleplan-reviewed-families@1.0.0', 'family:melk', 'mjølk');
