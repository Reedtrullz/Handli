-- Source-neutral trust fences for the fixed-disabled official-offer foundation.
-- Legacy rows are retained but remain quarantined with null fence columns. Every
-- new row must carry the complete immutable identity/authorization facts.

alter table publications
  add column content_kind varchar(24),
  add column declared_geographic_scope jsonb,
  add column edition_identity_sha256 char(64),
  add column discovery_permission_id bigint references source_permissions(id),
  add constraint publications_offer_identity_complete check (
    (content_kind is null
      and declared_geographic_scope is null
      and edition_identity_sha256 is null
      and discovery_permission_id is null)
    or
    (content_kind is not null
      and declared_geographic_scope is not null
      and edition_identity_sha256 is not null
      and discovery_permission_id is not null)
  ),
  add constraint publications_content_kind_allowed check (
    content_kind is null or content_kind in ('structured-feed', 'publication')
  ),
  add constraint publications_declared_scope_object check (
    declared_geographic_scope is null
    or jsonb_typeof(declared_geographic_scope) = 'object'
  ),
  add constraint publications_edition_identity_sha256_shape check (
    edition_identity_sha256 is null
    or edition_identity_sha256 ~ '^[0-9a-f]{64}$'
  );

create index publications_discovery_permission_idx
  on publications (discovery_permission_id)
  where discovery_permission_id is not null;

alter table publication_captures
  add column capture_permission_id bigint references source_permissions(id),
  add column capture_permission_capabilities jsonb,
  add constraint publication_captures_permission_fence_complete check (
    (capture_permission_id is null and capture_permission_capabilities is null)
    or (capture_permission_id is not null and capture_permission_capabilities is not null)
  ),
  add constraint publication_captures_permission_capabilities_shape check (
    capture_permission_capabilities is null
    or case
      when jsonb_typeof(capture_permission_capabilities) = 'array'
        then jsonb_array_length(capture_permission_capabilities) between 3 and 4
      else false
    end
  );

create index publication_captures_permission_idx
  on publication_captures (capture_permission_id)
  where capture_permission_id is not null;

alter table extraction_runs
  add column extraction_method varchar(24),
  add column extraction_permission_id bigint references source_permissions(id),
  add column ocr_permission_id bigint references source_permissions(id),
  add column permission_capabilities jsonb,
  add column source_started_at timestamptz,
  add column source_completed_at timestamptz,
  add column empty_result varchar(24),
  add column empty_confirmation jsonb,
  add column empty_confirmation_observed_at timestamptz,
  add constraint extraction_runs_permission_fence_complete check (
    (extraction_method is null
      and extraction_permission_id is null
      and ocr_permission_id is null
      and permission_capabilities is null
      and source_started_at is null
      and source_completed_at is null
      and empty_result is null
      and empty_confirmation is null
      and empty_confirmation_observed_at is null)
    or
    (extraction_method is not null
      and extraction_permission_id is not null
      and permission_capabilities is not null
      and source_started_at is not null
      and source_completed_at is not null
      and empty_result is not null)
  ),
  add constraint extraction_runs_method_allowed check (
    extraction_method is null
    or extraction_method in ('structured', 'embedded-text', 'ocr')
  ),
  add constraint extraction_runs_ocr_permission_pair check (
    extraction_method is null
    or (extraction_method = 'ocr') = (ocr_permission_id is not null)
  ),
  add constraint extraction_runs_permission_capabilities_shape check (
    permission_capabilities is null
    or case
      when jsonb_typeof(permission_capabilities) = 'array'
        then jsonb_array_length(permission_capabilities) between 3 and 4
      else false
    end
  ),
  add constraint extraction_runs_source_time_range check (
    source_started_at is null
    or source_completed_at >= source_started_at
  ),
  add constraint extraction_runs_empty_result_allowed check (
    empty_result is null
    or empty_result in ('not-empty', 'confirmed-empty', 'unexpected-empty')
  ),
  add constraint extraction_runs_empty_confirmation_pair check (
    empty_result is null
    or (
      (empty_result = 'confirmed-empty'
        and empty_confirmation is not null
        and empty_confirmation_observed_at is not null)
      or
      (empty_result <> 'confirmed-empty'
        and empty_confirmation is null
        and empty_confirmation_observed_at is null)
    )
  );

create index extraction_runs_permission_idx
  on extraction_runs (extraction_permission_id)
  where extraction_permission_id is not null;

alter table offer_targets add column created_at timestamptz;
update offer_targets set created_at = transaction_timestamp() where created_at is null;
alter table offer_targets
  alter column created_at set default now(),
  alter column created_at set not null;

-- Every row that can make a published offer or its provenance appear at an
-- as-of boundary receives a database-owned persistence clock. Approved-offer
-- state transitions additionally receive a database-owned mutation clock so
-- a later publish/revoke cannot be backdated into an older snapshot.
create trigger publications_creation_clock
before insert on publications
for each row execute function stamp_persisted_creation_clock();

create trigger publication_captures_creation_clock
before insert on publication_captures
for each row execute function stamp_persisted_creation_clock();

create trigger extraction_runs_creation_clock
before insert on extraction_runs
for each row execute function stamp_persisted_creation_clock();

create trigger extracted_offer_candidates_creation_clock
before insert on extracted_offer_candidates
for each row execute function stamp_persisted_creation_clock();

create trigger approved_offers_creation_clock
before insert on approved_offers
for each row execute function stamp_persisted_creation_clock();

create trigger offer_targets_creation_clock
before insert on offer_targets
for each row execute function stamp_persisted_creation_clock();

create trigger review_actions_creation_clock
before insert on review_actions
for each row execute function stamp_persisted_creation_clock();

create function stamp_approved_offer_state_clock()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

create trigger approved_offers_state_clock
before insert or update on approved_offers
for each row execute function stamp_approved_offer_state_clock();

-- Scope membership is append-only, so a row trigger plus a per-scope
-- transaction lock is a durable cardinality boundary. Refuse to install the
-- boundary over already-oversized data rather than legitimizing it.
do $$
begin
  if exists (
    select 1 from public.geographic_scope_regions
    group by scope_id having pg_catalog.count(*) > 100
  ) or exists (
    select 1 from public.geographic_scope_postal_codes
    group by scope_id having pg_catalog.count(*) > 10000
  ) or exists (
    select 1 from public.geographic_scope_stores
    group by scope_id having pg_catalog.count(*) > 1000
  ) then
    raise exception 'existing geographic scope exceeds official-offer cardinality bounds'
      using errcode = '23514';
  end if;
end;
$$;

create function enforce_geographic_scope_member_limit()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  expected_scope_kind text;
  maximum_members integer;
  member_count integer;
  stored_scope_kind text;
begin
  case tg_table_name
    when 'geographic_scope_regions' then
      expected_scope_kind := 'region';
      maximum_members := 100;
    when 'geographic_scope_postal_codes' then
      expected_scope_kind := 'postal_set';
      maximum_members := 10000;
    when 'geographic_scope_stores' then
      expected_scope_kind := 'store_set';
      maximum_members := 1000;
    else
      raise exception 'unsupported geographic scope membership table'
        using errcode = '23514';
  end case;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'official-offer-geography:' || new.scope_id::text,
      7229164304
    )
  );
  select scope.scope_kind
  into stored_scope_kind
  from public.geographic_scopes scope
  where scope.id = new.scope_id
  for share;
  if stored_scope_kind is distinct from expected_scope_kind then
    raise exception 'geographic scope membership does not match its scope kind'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.publications publication
    where publication.geographic_scope_id = new.scope_id
      and publication.content_kind is not null
      and publication.declared_geographic_scope is not null
      and publication.edition_identity_sha256 is not null
  ) then
    raise exception 'official-offer geographic scope membership is sealed'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    'select count(*) from public.%I where scope_id = $1',
    tg_table_name
  ) into member_count using new.scope_id;
  if member_count >= maximum_members then
    raise exception 'geographic scope membership exceeds the bounded cardinality'
      using errcode = '54000';
  end if;
  return new;
end;
$$;

create trigger geographic_scope_regions_member_limit
before insert on geographic_scope_regions
for each row execute function enforce_geographic_scope_member_limit();

create trigger geographic_scope_postal_codes_member_limit
before insert on geographic_scope_postal_codes
for each row execute function enforce_geographic_scope_member_limit();

create trigger geographic_scope_stores_member_limit
before insert on geographic_scope_stores
for each row execute function enforce_geographic_scope_member_limit();

create function enforce_official_offer_scope_identity_immutability()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.scope_kind is distinct from old.scope_kind
     or new.country_code is distinct from old.country_code then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'official-offer-geography:' || old.id::text,
        7229164304
      )
    );
    if exists (
      select 1
      from public.publications publication
      where publication.geographic_scope_id = old.id
        and publication.content_kind is not null
        and publication.declared_geographic_scope is not null
        and publication.edition_identity_sha256 is not null
    ) then
      raise exception 'official-offer geographic scope identity is immutable'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger geographic_scopes_offer_identity_boundary
before update of scope_kind, country_code on geographic_scopes
for each row execute function enforce_official_offer_scope_identity_immutability();

-- Permission appends, kill-switch changes and rights-sensitive ingestion share
-- this exact per-source advisory-lock namespace: hashtextextended(source_id,
-- 7229164304). This closes append-after-check and state-change-after-check races.
create function lock_source_permission_governance_fence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.source_id, 7229164304)
  );
  -- The earlier generic creation-clock trigger fires before this lock. Stamp
  -- again after serialization so created_at is the per-source decision order,
  -- even when a concurrent INSERT waited behind in-flight ingestion.
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

create trigger source_permissions_governance_fence_lock
before insert on source_permissions
for each row execute function lock_source_permission_governance_fence();

create function lock_data_source_governance_fence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(old.id, 7229164304)
  );
  return new;
end;
$$;

create trigger data_sources_governance_fence_lock
before update of runtime_state, permission_reviewed_at, permission_expires_at on data_sources
for each row execute function lock_data_source_governance_fence();

-- A caller-supplied permission ID or capability array is evidence only when it
-- exactly matches the latest database-persisted source-permission decision at
-- the transaction clock and that exact row is approved/current. This function
-- is called by every rights-sensitive INSERT trigger, so direct SQL has the
-- same fail-closed boundary as the repository.
create function assert_current_official_offer_permission(
  asserted_source_id varchar(64),
  asserted_permission_id bigint,
  asserted_capabilities jsonb,
  required_capability text,
  asserted_rights_classification text default null
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  current_capabilities jsonb;
  current_permission_id bigint;
  current_rights jsonb;
  canonical_rights jsonb;
  rights_count integer;
  distinct_rights_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(asserted_source_id, 7229164304)
  );

  select
    permission.id,
    permission.permissions -> 'officialOfferCapabilities',
    permission.permissions -> 'officialOfferRightsClassifications'
  into current_permission_id, current_capabilities, current_rights
  from public.data_sources source
  inner join public.source_permissions permission
    on permission.id = (
      select candidate.id
      from public.source_permissions candidate
      where candidate.source_id = source.id
        and candidate.created_at <= pg_catalog.clock_timestamp()
      order by candidate.created_at desc, candidate.id desc
      limit 1
    )
  where source.id = asserted_source_id
    and source.runtime_state = 'approved'
    and source.public_state_changed_at <= pg_catalog.clock_timestamp()
    and source.permission_reviewed_at = permission.reviewed_at
    and source.permission_expires_at is not distinct from permission.valid_until
    and permission.decision = 'approved'
    and permission.created_at <= pg_catalog.clock_timestamp()
    and permission.reviewed_at <= pg_catalog.clock_timestamp()
    and (permission.valid_until is null
      or permission.valid_until > pg_catalog.clock_timestamp())
    and permission.permissions @> '{"officialOffers": true}'::jsonb;

  if current_permission_id is null
     or current_permission_id is distinct from asserted_permission_id then
    raise exception 'official-offer permission fence is not current for source'
      using errcode = '42501';
  end if;

  if pg_catalog.jsonb_typeof(current_capabilities) is distinct from 'array' then
    raise exception 'official-offer permission capabilities are missing'
      using errcode = '42501';
  end if;

  if current_capabilities not in (
    '["capture", "discover", "extract"]'::jsonb,
    '["capture", "discover", "extract", "ocr"]'::jsonb
  )
     or not (current_capabilities ? required_capability)
     or (
       asserted_capabilities is not null
       and asserted_capabilities is distinct from current_capabilities
     ) then
    raise exception 'official-offer permission capabilities do not match current source rights'
      using errcode = '42501';
  end if;

  if pg_catalog.jsonb_typeof(current_rights) is distinct from 'array' then
    raise exception 'official-offer rights classifications are missing'
      using errcode = '42501';
  end if;

  select
    pg_catalog.jsonb_agg(right_value order by right_value),
    pg_catalog.count(*),
    pg_catalog.count(distinct right_value)
  into canonical_rights, rights_count, distinct_rights_count
  from pg_catalog.jsonb_array_elements_text(current_rights) as rights(right_value);

  if rights_count not between 1 and 3
     or distinct_rights_count is distinct from rights_count
     or current_rights is distinct from canonical_rights
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements_text(current_rights) as rights(right_value)
       where right_value not in ('extract_only', 'private_review', 'public_display')
     )
     or (
       asserted_rights_classification is not null
       and not (current_rights ? asserted_rights_classification)
     ) then
    raise exception 'official-offer rights classification is not currently authorized'
      using errcode = '42501';
  end if;
end;
$$;

-- Reconstruct the exact JSON.stringify byte sequence used by the domain
-- contract. PostgreSQL core's sha256(bytea) keeps this boundary dependency-free.
create function canonical_official_offer_scope_identity(declared_scope jsonb)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  members text;
begin
  case declared_scope ->> 'kind'
    when 'national' then
      return '['
        || pg_catalog.to_jsonb('national'::text)::text || ','
        || pg_catalog.to_jsonb(declared_scope ->> 'countryCode')::text
        || ']';
    when 'regions' then
      select pg_catalog.string_agg(
        pg_catalog.to_jsonb(member.value)::text,
        ',' order by member.value
      )
      into members
      from pg_catalog.jsonb_array_elements_text(
        declared_scope -> 'regionCodes'
      ) as member(value);
      return '['
        || pg_catalog.to_jsonb('regions'::text)::text || ','
        || pg_catalog.to_jsonb(declared_scope ->> 'countryCode')::text || ',['
        || coalesce(members, '') || ']]';
    when 'postal-set' then
      select pg_catalog.string_agg(
        pg_catalog.to_jsonb(member.value)::text,
        ',' order by member.value
      )
      into members
      from pg_catalog.jsonb_array_elements_text(
        declared_scope -> 'postalCodes'
      ) as member(value);
      return '['
        || pg_catalog.to_jsonb('postal-set'::text)::text || ','
        || pg_catalog.to_jsonb(declared_scope ->> 'countryCode')::text || ',['
        || coalesce(members, '') || ']]';
    when 'stores' then
      select pg_catalog.string_agg(
        pg_catalog.to_jsonb(member.value)::text,
        ',' order by member.value
      )
      into members
      from pg_catalog.jsonb_array_elements_text(
        declared_scope -> 'storeIds'
      ) as member(value);
      return '['
        || pg_catalog.to_jsonb('stores'::text)::text || ',['
        || coalesce(members, '') || ']]';
    else
      raise exception 'unsupported official-offer declared geographic scope'
        using errcode = '23514';
  end case;
end;
$$;

create function canonical_official_offer_edition_identity(
  identity_source_id text,
  identity_external_id text,
  identity_chain text,
  identity_title text,
  identity_content_kind text,
  identity_geographic_scope_id bigint,
  identity_declared_scope jsonb,
  identity_valid_from timestamptz,
  identity_valid_until timestamptz,
  identity_discovered_at timestamptz
)
returns text
language sql
stable
strict
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select '['
    || '1,'
    || pg_catalog.to_jsonb(identity_source_id)::text || ','
    || pg_catalog.to_jsonb(identity_external_id)::text || ','
    || pg_catalog.to_jsonb(identity_chain)::text || ','
    || pg_catalog.to_jsonb(identity_title)::text || ','
    || pg_catalog.to_jsonb(identity_content_kind)::text || ','
    || identity_geographic_scope_id::text || ','
    || public.canonical_official_offer_scope_identity(identity_declared_scope) || ','
    || pg_catalog.to_jsonb(pg_catalog.to_char(
      identity_valid_from at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ))::text || ','
    || pg_catalog.to_jsonb(pg_catalog.to_char(
      identity_valid_until at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ))::text || ','
    || pg_catalog.to_jsonb(pg_catalog.to_char(
      identity_discovered_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ))::text
    || ']'
$$;

create function enforce_publication_offer_identity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  expected_identity_sha256 text;
  expected_scope jsonb;
  scope_member_count integer;
begin
  if tg_op = 'INSERT' and (
    new.content_kind is null
    or new.declared_geographic_scope is null
    or new.edition_identity_sha256 is null
    or new.discovery_permission_id is null
  ) then
    raise exception 'new publications require a complete official-offer identity fence'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    perform public.assert_current_official_offer_permission(
      new.source_id,
      new.discovery_permission_id,
      null,
      'discover',
      null
    );

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'official-offer-geography:' || new.geographic_scope_id::text,
        7229164304
      )
    );

    if new.valid_from is distinct from pg_catalog.date_trunc('milliseconds', new.valid_from)
       or new.valid_until is distinct from pg_catalog.date_trunc('milliseconds', new.valid_until)
       or new.discovered_at is distinct from pg_catalog.date_trunc('milliseconds', new.discovered_at)
       or new.geographic_scope_id > 9007199254740991 then
      raise exception 'publication official-offer identity is not canonically representable'
        using errcode = '23514';
    end if;

    select
      case scope.scope_kind
        when 'national' then pg_catalog.jsonb_build_object(
          'kind', 'national',
          'countryCode', pg_catalog.btrim(scope.country_code)
        )
        when 'region' then pg_catalog.jsonb_build_object(
          'kind', 'regions',
          'countryCode', pg_catalog.btrim(scope.country_code),
          'regionCodes', coalesce((
            select pg_catalog.jsonb_agg(region.region_code order by region.region_code)
            from public.geographic_scope_regions region
            where region.scope_id = scope.id
          ), '[]'::jsonb)
        )
        when 'postal_set' then pg_catalog.jsonb_build_object(
          'kind', 'postal-set',
          'countryCode', pg_catalog.btrim(scope.country_code),
          'postalCodes', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.btrim(postal.postal_code)
              order by pg_catalog.btrim(postal.postal_code)
            )
            from public.geographic_scope_postal_codes postal
            where postal.scope_id = scope.id
          ), '[]'::jsonb)
        )
        when 'store_set' then pg_catalog.jsonb_build_object(
          'kind', 'stores',
          'storeIds', coalesce((
            select pg_catalog.jsonb_agg(
              store.store_id::text order by store.store_id::text
            )
            from public.geographic_scope_stores store
            where store.scope_id = scope.id
          ), '[]'::jsonb)
        )
        else null
      end,
      case scope.scope_kind
        when 'national' then 1
        when 'region' then (
          select pg_catalog.count(*)
          from public.geographic_scope_regions region
          where region.scope_id = scope.id
        )
        when 'postal_set' then (
          select pg_catalog.count(*)
          from public.geographic_scope_postal_codes postal
          where postal.scope_id = scope.id
        )
        when 'store_set' then (
          select pg_catalog.count(*)
          from public.geographic_scope_stores store
          where store.scope_id = scope.id
        )
        else 0
      end
    into expected_scope, scope_member_count
    from public.geographic_scopes scope
    where scope.id = new.geographic_scope_id
      and scope.status = 'active';

    if expected_scope is null
       or scope_member_count < 1
       or new.declared_geographic_scope is distinct from expected_scope then
      raise exception 'publication declared geographic scope does not match stored scope facts'
        using errcode = '23514';
    end if;

    expected_identity_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        public.canonical_official_offer_edition_identity(
          new.source_id,
          new.external_id,
          new.chain,
          new.title,
          new.content_kind,
          new.geographic_scope_id,
          expected_scope,
          new.valid_from,
          new.valid_until,
          new.discovered_at
        ),
        'UTF8'
      )),
      'hex'
    );
    if pg_catalog.btrim(new.edition_identity_sha256) is distinct from expected_identity_sha256 then
      raise exception 'publication official-offer identity digest does not match stored facts'
        using errcode = '23514';
    end if;

  end if;

  if tg_op = 'UPDATE' and (
    new.source_id is distinct from old.source_id
    or new.external_id is distinct from old.external_id
    or new.chain is distinct from old.chain
    or new.title is distinct from old.title
    or new.valid_from is distinct from old.valid_from
    or new.valid_until is distinct from old.valid_until
    or new.geographic_scope_id is distinct from old.geographic_scope_id
    or new.discovered_at is distinct from old.discovered_at
    or new.content_kind is distinct from old.content_kind
    or new.declared_geographic_scope is distinct from old.declared_geographic_scope
    or new.edition_identity_sha256 is distinct from old.edition_identity_sha256
    or new.discovery_permission_id is distinct from old.discovery_permission_id
  ) then
    raise exception 'publication official-offer identity is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger publications_offer_identity_boundary
before insert or update on publications
for each row execute function enforce_publication_offer_identity();

create function enforce_capture_permission_fence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  publication_source_id varchar(64);
  publication_is_trusted boolean;
begin
  if new.capture_permission_id is null or new.capture_permission_capabilities is null then
    raise exception 'new publication captures require a complete permission fence'
      using errcode = '23514';
  end if;

  -- Retrieval is a persistence event, not a caller assertion. The source may
  -- retain its own clock in private metadata, but eligibility uses this value.
  new.retrieved_at := pg_catalog.clock_timestamp();


  select
    publication.source_id,
    publication.content_kind is not null
      and publication.declared_geographic_scope is not null
      and publication.edition_identity_sha256 is not null
      and publication.discovery_permission_id is not null
  into publication_source_id, publication_is_trusted
  from public.publications publication
  where publication.id = new.publication_id;

  if publication_source_id is null or publication_is_trusted is not true then
    raise exception 'publication capture requires trusted publication identity'
      using errcode = '23514';
  end if;

  perform public.assert_current_official_offer_permission(
    publication_source_id,
    new.capture_permission_id,
    new.capture_permission_capabilities,
    'capture',
    new.rights_classification
  );
  return new;
end;
$$;

create trigger publication_captures_permission_boundary
before insert on publication_captures
for each row execute function enforce_capture_permission_fence();

create function enforce_extraction_run_trust_fence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  capture_retrieved_at timestamptz;
  capture_rights_classification varchar(24);
  expected_empty_confirmation jsonb;
  publication_external_id varchar(160);
  publication_source_id varchar(64);
  provenance_is_trusted boolean;
begin
  if tg_op = 'DELETE' then
    if old.status in ('completed', 'degraded', 'failed') then
      raise exception 'terminal extraction runs are immutable evidence'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and (
    new.extraction_method is null
    or new.extraction_permission_id is null
    or new.permission_capabilities is null
    or new.source_started_at is null
    or new.source_completed_at is null
    or new.empty_result is null
  ) then
    raise exception 'new extraction runs require complete authorization and timing fences'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and new.status not in ('completed', 'degraded', 'failed') then
    raise exception 'new official-offer extraction runs must be terminal'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    new.completed_at := pg_catalog.clock_timestamp();
    select
      capture.retrieved_at,
      capture.rights_classification,
      publication.external_id,
      publication.source_id,
      capture.capture_permission_id is not null
        and capture.capture_permission_capabilities is not null
        and publication.content_kind is not null
        and publication.declared_geographic_scope is not null
        and publication.edition_identity_sha256 is not null
        and publication.discovery_permission_id is not null
    into capture_retrieved_at, capture_rights_classification,
         publication_external_id, publication_source_id, provenance_is_trusted
    from public.publication_captures capture
    inner join public.publications publication on publication.id = capture.publication_id
    where capture.id = new.capture_id;

    if publication_source_id is null or provenance_is_trusted is not true then
      raise exception 'extraction run requires trusted capture provenance'
        using errcode = '23514';
    end if;

    if new.empty_result = 'confirmed-empty' then
      expected_empty_confirmation := pg_catalog.jsonb_build_object(
        'sourceId', publication_source_id,
        'externalEditionId', publication_external_id,
        'basis', new.empty_confirmation ->> 'basis',
        'evidenceLocator', new.empty_confirmation ->> 'evidenceLocator'
      );
      if pg_catalog.jsonb_typeof(new.empty_confirmation) is distinct from 'object'
         or new.empty_confirmation ? 'confirmedAt'
         or new.empty_confirmation ->> 'basis' not in (
           'source-declared-empty',
           'source-record-count-zero'
         )
         or pg_catalog.length(new.empty_confirmation ->> 'evidenceLocator') < 1
         or new.empty_confirmation is distinct from expected_empty_confirmation then
        raise exception 'confirmed-empty evidence is not canonically bound to the publication'
          using errcode = '23514';
      end if;
      -- Acceptance is dated by the database completion instant. The extractor
      -- supplies evidence facts, never its eligibility clock.
      new.empty_confirmation_observed_at := new.completed_at;
    elsif new.empty_confirmation is not null
       or new.empty_confirmation_observed_at is not null then
      raise exception 'non-confirmed-empty extraction cannot carry confirmation evidence'
        using errcode = '23514';
    else
      new.empty_confirmation_observed_at := null;
    end if;

    if new.started_at < capture_retrieved_at - interval '5 seconds'
       or new.started_at > new.completed_at + interval '5 seconds'
       or new.completed_at - new.started_at > interval '10 minutes 5 seconds'
       or new.source_started_at < capture_retrieved_at - interval '5 seconds'
       or new.source_started_at < new.started_at - interval '5 seconds'
       or new.source_completed_at > new.completed_at + interval '5 seconds'
       or new.source_completed_at - new.source_started_at > interval '10 minutes' then
      raise exception 'official-offer extraction timing is outside the trusted boundary'
        using errcode = '22007';
    end if;

    perform public.assert_current_official_offer_permission(
      publication_source_id,
      new.extraction_permission_id,
      new.permission_capabilities,
      'extract',
      capture_rights_classification
    );

    if new.extraction_method = 'ocr' then
      perform public.assert_current_official_offer_permission(
        publication_source_id,
        new.ocr_permission_id,
        new.permission_capabilities,
        'ocr',
        capture_rights_classification
      );
    end if;
  end if;

  if tg_op = 'UPDATE' and old.status in ('completed', 'degraded', 'failed') then
    raise exception 'terminal extraction runs are immutable evidence'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' and (
    new.capture_id is distinct from old.capture_id
    or new.extractor_version is distinct from old.extractor_version
    or new.extraction_method is distinct from old.extraction_method
    or new.extraction_permission_id is distinct from old.extraction_permission_id
    or new.ocr_permission_id is distinct from old.ocr_permission_id
    or new.permission_capabilities is distinct from old.permission_capabilities
    or new.started_at is distinct from old.started_at
    or new.source_started_at is distinct from old.source_started_at
    or new.source_completed_at is distinct from old.source_completed_at
    or new.empty_result is distinct from old.empty_result
    or new.empty_confirmation is distinct from old.empty_confirmation
    or new.empty_confirmation_observed_at is distinct from old.empty_confirmation_observed_at
  ) then
    raise exception 'extraction-run identity, authorization and timing are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger extraction_runs_trust_boundary
before insert or update or delete on extraction_runs
for each row execute function enforce_extraction_run_trust_fence();
