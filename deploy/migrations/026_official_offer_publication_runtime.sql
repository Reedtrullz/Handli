-- Dedicated, source-neutral lifecycle boundary for reviewed official offers.
--
-- This boundary is deliberately separate from the generic ingestion lease and
-- Kassalapp ingestion fence. The runtime role receives EXECUTE on one atomic
-- function only; it receives no privilege on either table below and cannot
-- insert a lifecycle worker result directly.

create table public.official_offer_publication_policy (
  policy_key varchar(40) primary key,
  enabled boolean not null,
  policy_version integer not null,
  updated_at timestamptz not null,
  constraint official_offer_publication_policy_singleton check (
    policy_key = 'official-offer-publication-v1'
  ),
  constraint official_offer_publication_policy_version check (
    policy_version = 1
  )
);

insert into public.official_offer_publication_policy (
  policy_key, enabled, policy_version, updated_at
) values (
  'official-offer-publication-v1', false, 1, pg_catalog.clock_timestamp()
);

create table public.official_offer_lifecycle_leases (
  source_id varchar(64) primary key references public.data_sources(id),
  lease_kind varchar(48) not null,
  owner_id varchar(160) not null,
  job_id varchar(200) not null,
  lease_token char(64) not null unique,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  expiry_cursor_offer_id bigint not null default 0,
  publication_cursor_offer_id bigint not null default 0,
  constraint official_offer_lifecycle_leases_kind check (
    lease_kind = 'official-offer-lifecycle-v1'
  ),
  constraint official_offer_lifecycle_leases_token check (
    lease_token ~ '^[0-9a-f]{64}$'
  ),
  constraint official_offer_lifecycle_leases_time check (
    expires_at > acquired_at
    and (completed_at is null
      or (completed_at >= acquired_at and completed_at <= expires_at))
  ),
  constraint official_offer_lifecycle_leases_cursors check (
    expiry_cursor_offer_id between 0 and 9007199254740991
    and publication_cursor_offer_id between 0 and 9007199254740991
  )
);

create table public.official_offer_lifecycle_job_results (
  job_id varchar(200) primary key
    references public.worker_job_results(job_id),
  source_id varchar(64) not null references public.data_sources(id),
  lease_token char(64) not null,
  lease_expires_at timestamptz not null,
  evaluated_at timestamptz not null,
  batch_limit integer not null,
  publication_requested boolean not null,
  publication_authorized boolean not null,
  publication_state varchar(24) not null,
  expiry_examined integer not null,
  expired_count integer not null,
  revoked_count integer not null,
  publication_examined integer not null,
  published_count integer not null,
  skipped_count integer not null,
  result_sha256 char(64) not null,
  created_at timestamptz not null,
  constraint official_offer_lifecycle_job_results_token check (
    lease_token ~ '^[0-9a-f]{64}$'
  ),
  constraint official_offer_lifecycle_job_results_batch check (
    batch_limit between 1 and 50
  ),
  constraint official_offer_lifecycle_job_results_state check (
    publication_state in ('foundation-disabled', 'source-ineligible', 'evaluated')
  ),
  constraint official_offer_lifecycle_job_results_counts check (
    expiry_examined between 0 and batch_limit
    and expired_count between 0 and expiry_examined
    and revoked_count between 0 and expiry_examined
    and expired_count + revoked_count <= expiry_examined
    and publication_examined between 0 and batch_limit
    and published_count between 0 and publication_examined
    and skipped_count = expiry_examined + publication_examined
      - expired_count - revoked_count - published_count
    and skipped_count >= 0
  ),
  constraint official_offer_lifecycle_job_results_publication check (
    (publication_authorized
      and publication_requested
      and publication_state in ('source-ineligible', 'evaluated'))
    or (not publication_authorized and publication_state = 'foundation-disabled')
  ),
  constraint official_offer_lifecycle_job_results_hash check (
    result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint official_offer_lifecycle_job_results_time check (
    created_at >= evaluated_at and lease_expires_at >= created_at
  )
);

create trigger official_offer_lifecycle_job_results_append_only
before update or delete on public.official_offer_lifecycle_job_results
for each row execute function public.reject_append_only_mutation();

-- The generic worker state repository must never account a lifecycle job under
-- the Kassalapp/source-ingestion lease. SECURITY DEFINER changes current_user
-- to the migration owner, so only the dedicated function below can cross this
-- trigger when the login role is handleplan_app.
create function public.enforce_official_offer_lifecycle_job_boundary_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.job_kind = 'official-offer-lifecycle-reconcile'
     and current_user = 'handleplan_app' then
    raise exception 'HP_OFFER_LIFECYCLE_DEDICATED_BOUNDARY_REQUIRED'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_official_offer_lifecycle_job_boundary_v1()
from public;

create trigger worker_job_results_official_offer_lifecycle_boundary
before insert on public.worker_job_results
for each row execute function public.enforce_official_offer_lifecycle_job_boundary_v1();

-- Once review has created an immutable offer, only one-way lifecycle status
-- transitions are mutable. Price, target identity, scope, validity, source and
-- review bindings cannot be rewritten by any runtime path.
create function public.enforce_approved_offer_lifecycle_transition_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.offer_key is distinct from old.offer_key
     or new.candidate_id is distinct from old.candidate_id
     or new.source_id is distinct from old.source_id
     or new.source_reference is distinct from old.source_reference
     or new.chain is distinct from old.chain
     or new.geographic_scope_id is distinct from old.geographic_scope_id
     or new.amount_ore is distinct from old.amount_ore
     or new.before_amount_ore is distinct from old.before_amount_ore
     or new.multibuy_quantity is distinct from old.multibuy_quantity
     or new.multibuy_group_amount_ore is distinct from old.multibuy_group_amount_ore
     or new.membership_requirement is distinct from old.membership_requirement
     or new.valid_from is distinct from old.valid_from
     or new.valid_until is distinct from old.valid_until
     or new.version is distinct from old.version
     or new.approved_at is distinct from old.approved_at
     or new.created_at is distinct from old.created_at
     or not (
       (old.status = 'approved'
         and new.status in ('published', 'expired', 'revoked'))
       or (old.status = 'published' and new.status in ('expired', 'revoked'))
     ) then
    raise exception 'official-offer projection is immutable outside one-way lifecycle state'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_approved_offer_lifecycle_transition_v1()
from public;

create trigger approved_offers_z_lifecycle_transition
before update on public.approved_offers
for each row execute function public.enforce_approved_offer_lifecycle_transition_v1();

-- Classification affects only the terminal non-public status. Publication
-- authority remains exclusively public_official_offer_rows_v1 below.
create function public.official_offer_lifecycle_is_revoked_v1(
  p_offer_id bigint,
  p_evaluated_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((
    select
      source.runtime_state = 'revoked'
      or current_permission.decision = 'revoked'
      or current_review.action = 'revoke'
    from public.approved_offers offer
    inner join public.data_sources source on source.id = offer.source_id
    left join lateral (
      select permission.decision
      from public.source_permissions permission
      where permission.source_id = source.id
        and permission.created_at <= p_evaluated_at
      order by permission.created_at desc, permission.id desc
      limit 1
    ) current_permission on true
    left join lateral (
      select review.action
      from public.review_actions review
      where review.candidate_id = offer.candidate_id
        and review.created_at <= p_evaluated_at
      order by review.created_at desc, review.id desc
      limit 1
    ) current_review on true
    where offer.id = p_offer_id
  ), false)
$$;

revoke all on function public.official_offer_lifecycle_is_revoked_v1(
  bigint, timestamptz
) from public;

-- Migration 025 marks only renderer-gated v2 decisions with boundary version
-- 2. Promote that exact marker into the already-audited 022 public projection
-- without copying or weakening its long eligibility predicate. Fail migration
-- if the historical predicate has drifted or appears more than once.
do $official_offer_promote_review_boundary_v2$
declare
  v_body text;
  v_old text := 'and review.decision_boundary_version = 1';
  v_new text := 'and review.decision_boundary_version = 2';
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.public_official_offer_rows_v1(bigint[],timestamp with time zone)'
  );

  if v_body is null
     or pg_catalog.strpos(v_body, v_old) = 0
     or pg_catalog.strpos(
       pg_catalog.substr(
         v_body,
         pg_catalog.strpos(v_body, v_old) + pg_catalog.length(v_old)
       ),
       v_old
     ) <> 0 then
    raise exception 'public official-offer review boundary drifted';
  end if;

  v_body := pg_catalog.replace(v_body, v_old, v_new);
  execute pg_catalog.format(
    'create or replace function public.public_official_offer_rows_v1(
      p_product_ids bigint[], p_evaluation_as_of timestamptz
    ) returns table (
      offer_id bigint, source_id text, source_display_name text,
      source_record_id text, chain text, product_id bigint,
      amount_ore integer, before_amount_ore integer,
      multibuy_quantity integer, multibuy_group_amount_ore integer,
      membership_requirement text, member_program_id text,
      valid_from timestamptz, valid_until timestamptz,
      geographic_scope jsonb, channels jsonb, captured_at timestamptz,
      product_offer_count bigint, total_offer_count bigint
    ) language plpgsql volatile security definer parallel unsafe
      set search_path = pg_catalog, pg_temp as %L',
    v_body
  );
end;
$official_offer_promote_review_boundary_v2$;

revoke all on function public.public_official_offer_rows_v1(
  bigint[], timestamptz
) from public;

-- Keep the private operations aggregate aligned with the same renderer-gated
-- marker. Migration 024 has three source-offer hygiene predicates; replace all
-- three or fail rather than silently reporting zero legitimate v2 offers.
do $official_offer_promote_operations_review_boundary_v2$
declare
  v_body text;
  v_old text := 'and current_action.decision_boundary_version = 1';
  v_new text := 'and current_action.decision_boundary_version = 2';
  v_occurrences integer;
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.operations_dashboard_rows_v1(text[],integer)'
  );

  if v_body is null then
    raise exception 'operations official-offer review boundary is missing';
  end if;
  v_occurrences := (
    pg_catalog.length(v_body)
    - pg_catalog.length(pg_catalog.replace(v_body, v_old, ''))
  ) / pg_catalog.length(v_old);
  if v_occurrences <> 3 then
    raise exception 'operations official-offer review boundary drifted';
  end if;

  v_body := pg_catalog.replace(v_body, v_old, v_new);
  execute pg_catalog.format(
    'create or replace function public.operations_dashboard_rows_v1(
      p_source_ids text[], p_result_limit integer
    ) returns table (
      observed_at timestamptz, source_id text, governance_state text,
      health_state text, health_recorded_at timestamptz,
      health_persisted_at timestamptz,
      last_discovery_success_at timestamptz,
      last_capture_success_at timestamptz,
      last_publish_success_at timestamptz,
      newest_eligible_evidence_at timestamptz,
      health_worker_job_kind text, worker_results_24h bigint,
      non_successful_worker_results_24h bigint, latest_worker_results jsonb,
      pending_review_rows bigint, active_published_offer_rows bigint,
      expiring_published_offer_rows bigint, expired_published_offer_rows bigint,
      latest_extraction_state text,
      latest_extraction_completed_at timestamptz,
      latest_extraction_empty_result text,
      latest_extraction_candidate_rows bigint,
      newest_ordinary_price_at timestamptz
    ) language plpgsql volatile security definer parallel unsafe
      set search_path = pg_catalog, pg_temp
      set statement_timeout = ''3000ms''
      set lock_timeout = ''500ms'' as %L',
    v_body
  );
end;
$official_offer_promote_operations_review_boundary_v2$;

revoke all on function public.operations_dashboard_rows_v1(
  text[], integer
) from public;

create function public.official_offer_lifecycle_reconcile_v1(
  p_source_id text,
  p_job_id text,
  p_run_id text,
  p_scheduled_at timestamptz,
  p_owner_id text,
  p_batch_limit integer,
  p_publication_requested boolean
)
returns table (
  outcome text,
  replayed boolean,
  job_id text,
  source_id text,
  database_as_of timestamptz,
  lease_expires_at timestamptz,
  publication_state text,
  expiry_examined integer,
  expired_count integer,
  revoked_count integer,
  publication_examined integer,
  published_count integer,
  skipped_count integer
)
language plpgsql
volatile
security definer
parallel unsafe
set search_path = pg_catalog, pg_temp
set statement_timeout = '5000ms'
set lock_timeout = '500ms'
as $$
declare
  v_started_at timestamptz;
  v_completed_at timestamptz;
  v_lease_token text;
  v_lease_expires_at timestamptz;
  v_existing record;
  v_expiry_offer_ids bigint[] := '{}'::bigint[];
  v_expiry_product_ids bigint[] := '{}'::bigint[];
  v_visible_expiry_offer_ids bigint[] := '{}'::bigint[];
  v_publication_offer_ids bigint[] := '{}'::bigint[];
  v_publication_product_ids bigint[] := '{}'::bigint[];
  v_visible_publication_offer_ids bigint[] := '{}'::bigint[];
  v_expiry_examined integer := 0;
  v_expired_count integer := 0;
  v_revoked_count integer := 0;
  v_publication_examined integer := 0;
  v_published_count integer := 0;
  v_skipped_count integer := 0;
  v_publication_state text;
  v_source_is_current boolean := false;
  v_database_publication_enabled boolean := false;
  v_publication_authorized boolean := false;
  v_expiry_cursor_offer_id bigint := 0;
  v_publication_cursor_offer_id bigint := 0;
  v_expiry_next_cursor_offer_id bigint := 0;
  v_publication_next_cursor_offer_id bigint := 0;
  v_publication_projection_as_of timestamptz;
  v_counts jsonb;
  v_worker_result_sha256 text;
  v_lifecycle_result_sha256 text;
begin
  -- Cheap byte ceilings precede regex/control scans.
  if (p_source_id is not null and pg_catalog.octet_length(p_source_id) > 64)
     or (p_job_id is not null and pg_catalog.octet_length(p_job_id) > 200)
     or (p_run_id is not null and pg_catalog.octet_length(p_run_id) > 200)
     or (p_owner_id is not null and pg_catalog.octet_length(p_owner_id) > 160) then
    raise exception 'HP_OFFER_LIFECYCLE_INVALID_REQUEST'
      using errcode = '22023';
  end if;

  v_started_at := pg_catalog.clock_timestamp();
  if p_source_id is null
     or p_source_id !~ '^[a-z0-9][a-z0-9._-]*$'
     or p_job_id is null
     or p_job_id is distinct from pg_catalog.btrim(p_job_id)
     or pg_catalog.char_length(p_job_id) not between 1 and 200
     or p_job_id ~ '[[:cntrl:]]'
     or p_run_id is null
     or p_run_id is distinct from pg_catalog.btrim(p_run_id)
     or pg_catalog.char_length(p_run_id) not between 1 and 200
     or p_run_id ~ '[[:cntrl:]]'
     or p_owner_id is null
     or p_owner_id is distinct from pg_catalog.btrim(p_owner_id)
     or pg_catalog.char_length(p_owner_id) not between 1 and 160
     or p_owner_id ~ '[[:cntrl:]]'
     or p_scheduled_at is null
     or not pg_catalog.isfinite(p_scheduled_at)
     or p_scheduled_at <> pg_catalog.date_trunc('milliseconds', p_scheduled_at)
     or p_scheduled_at > v_started_at
     or p_scheduled_at < v_started_at - interval '7 days'
     or p_batch_limit is null
     or p_batch_limit not between 1 and 50
     or p_publication_requested is null then
    raise exception 'HP_OFFER_LIFECYCLE_INVALID_REQUEST'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.data_sources source
    where source.id = p_source_id
      and source.source_kind = 'offer'
  ) then
    raise exception 'HP_OFFER_LIFECYCLE_SOURCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Job identity is global in worker_job_results. Serialize replay checks in a
  -- namespace distinct from both ingestion and lifecycle source leases.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_job_id, 7229164307)
  );

  select
    worker.source_id as worker_source_id,
    worker.job_kind as worker_job_kind,
    worker.scheduled_at as worker_scheduled_at,
    worker.run_id as worker_run_id,
    detail.job_id as detail_job_id,
    detail.lease_expires_at as detail_lease_expires_at,
    detail.evaluated_at,
    detail.batch_limit,
    detail.publication_requested,
    detail.publication_state,
    detail.expiry_examined,
    detail.expired_count,
    detail.revoked_count,
    detail.publication_examined,
    detail.published_count,
    detail.skipped_count
  into v_existing
  from public.worker_job_results worker
  left join public.official_offer_lifecycle_job_results detail
    on detail.job_id = worker.job_id
  where worker.job_id = p_job_id;

  if found then
    if v_existing.worker_job_kind is distinct from 'official-offer-lifecycle-reconcile'
       or v_existing.worker_source_id is distinct from p_source_id
       or v_existing.worker_scheduled_at is distinct from p_scheduled_at
       or v_existing.worker_run_id is distinct from p_run_id
       or v_existing.detail_job_id is null
       or v_existing.batch_limit is distinct from p_batch_limit
       or v_existing.publication_requested is distinct from p_publication_requested then
      raise exception 'HP_OFFER_LIFECYCLE_JOB_CONFLICT'
        using errcode = '40001';
    end if;

    return query select
      'replayed'::text,
      true,
      p_job_id,
      p_source_id,
      v_existing.evaluated_at,
      v_existing.detail_lease_expires_at,
      v_existing.publication_state::text,
      v_existing.expiry_examined,
      v_existing.expired_count,
      v_existing.revoked_count,
      v_existing.publication_examined,
      v_existing.published_count,
      v_existing.skipped_count
    ;
    return;
  end if;

  -- A nonblocking transaction lock plus an independently persisted lease gives
  -- this job a source-bound boundary that cannot alias worker_leases.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'official-offer-lifecycle-v1:' || p_source_id,
      7229164306
    )
  ) then
    return query select
      'lease-unavailable'::text, false, p_job_id, p_source_id,
      v_started_at, v_started_at, 'not-evaluated'::text,
      0, 0, 0, 0, 0, 0;
    return;
  end if;

  v_lease_token := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_source_id, 'UTF8') || pg_catalog.decode('00', 'hex')
    || pg_catalog.convert_to(p_owner_id, 'UTF8') || pg_catalog.decode('00', 'hex')
    || pg_catalog.convert_to(p_job_id, 'UTF8') || pg_catalog.decode('00', 'hex')
    || pg_catalog.convert_to(v_started_at::text, 'UTF8')
  ), 'hex');

  insert into public.official_offer_lifecycle_leases (
    source_id, lease_kind, owner_id, job_id, lease_token,
    acquired_at, expires_at, completed_at
  ) values (
    p_source_id, 'official-offer-lifecycle-v1', p_owner_id, p_job_id,
    v_lease_token, v_started_at,
    v_started_at + interval '10 seconds',
    null
  )
  on conflict on constraint official_offer_lifecycle_leases_pkey do update
  set
    lease_kind = excluded.lease_kind,
    owner_id = excluded.owner_id,
    job_id = excluded.job_id,
    lease_token = excluded.lease_token,
    acquired_at = excluded.acquired_at,
    expires_at = excluded.expires_at,
    completed_at = null
  where public.official_offer_lifecycle_leases.expires_at <= excluded.acquired_at
  returning
    expires_at, expiry_cursor_offer_id, publication_cursor_offer_id
  into
    v_lease_expires_at, v_expiry_cursor_offer_id, v_publication_cursor_offer_id;

  if v_lease_expires_at is null then
    select lease.expires_at
    into v_lease_expires_at
    from public.official_offer_lifecycle_leases lease
    where lease.source_id = p_source_id;
    return query select
      'lease-unavailable'::text, false, p_job_id, p_source_id,
      v_started_at, v_lease_expires_at, 'not-evaluated'::text,
      0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- Serialize with permission appends and source kill-switch transitions. The
  -- public projection performs the authoritative current-rights check later.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_source_id, 7229164304)
  );
  perform 1
  from public.data_sources source
  where source.id = p_source_id
  for share;
  if not found then
    raise exception 'HP_OFFER_LIFECYCLE_SOURCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  v_started_at := pg_catalog.clock_timestamp();

  select policy.enabled
  into strict v_database_publication_enabled
  from public.official_offer_publication_policy policy
  where policy.policy_key = 'official-offer-publication-v1'
    and policy.policy_version = 1
  for share;
  v_publication_authorized := p_publication_requested
    and v_database_publication_enabled;

  select exists (
    select 1
    from public.data_sources source
    inner join lateral (
      select permission.*
      from public.source_permissions permission
      where permission.source_id = source.id
        and permission.created_at <= v_started_at
      order by permission.created_at desc, permission.id desc
      limit 1
    ) current_permission on true
    where source.id = p_source_id
      and source.source_kind = 'offer'
      and source.runtime_state = 'approved'
      and source.created_at <= v_started_at
      and source.public_state_changed_at <= v_started_at
      and source.permission_reviewed_at = current_permission.reviewed_at
      and source.permission_expires_at is not distinct from current_permission.valid_until
      and current_permission.decision = 'approved'
      and current_permission.created_at <= v_started_at
      and current_permission.reviewed_at <= v_started_at
      and (current_permission.valid_until is null
        or current_permission.valid_until > v_started_at)
      and current_permission.permissions @>
        '{"officialOffers": true, "publicDisplay": true}'::jsonb
      and current_permission.permissions -> 'officialOfferCapabilities' in (
        '["capture", "discover", "extract"]'::jsonb,
        '["capture", "discover", "extract", "ocr"]'::jsonb
      )
      and current_permission.permissions -> 'officialOfferRightsClassifications'
        ? 'public_display'
  ) into v_source_is_current;

  v_publication_state := case
    when not v_publication_authorized then 'foundation-disabled'
    when v_source_is_current then 'evaluated'
    else 'source-ineligible'
  end;

  -- Inspect at most one bounded page. Ended/explicitly revoked rows are first,
  -- followed by currently published rows that must still survive the exact
  -- public projection. Row locks also serialize condition inserts.
  select
    coalesce(pg_catalog.array_agg(
      selected.offer_id order by selected.scan_segment, selected.offer_id
    ),
      '{}'::bigint[]),
    coalesce(pg_catalog.array_agg(distinct selected.product_id)
      filter (where selected.product_id is not null), '{}'::bigint[])
  into v_expiry_offer_ids, v_expiry_product_ids
  from (
    select
      offer.id as offer_id,
      target.product_id,
      case when offer.id > v_expiry_cursor_offer_id then 0 else 1 end
        as scan_segment
    from public.approved_offers offer
    left join public.offer_targets target on target.offer_id = offer.id
    where offer.source_id = p_source_id
      and (
        offer.status = 'published'
        or (
          offer.status = 'approved'
          and (
            offer.valid_until <= v_started_at
            or public.official_offer_lifecycle_is_revoked_v1(
              offer.id, v_started_at
            )
          )
        )
      )
    order by
      case when offer.id > v_expiry_cursor_offer_id then 0 else 1 end,
      offer.id
    limit p_batch_limit
    for update of offer
  ) selected;

  v_expiry_examined := pg_catalog.cardinality(v_expiry_offer_ids);
  if v_expiry_examined > 0 then
    v_expiry_next_cursor_offer_id := v_expiry_offer_ids[v_expiry_examined];
  end if;
  if v_expiry_examined > 0 then
    perform 1
    from public.geographic_scopes scope
    inner join public.approved_offers offer
      on offer.geographic_scope_id = scope.id
    where offer.id = any(v_expiry_offer_ids)
    order by scope.id
    for share of scope;

    perform 1
    from public.canonical_products product
    inner join public.offer_targets target on target.product_id = product.id
    where target.offer_id = any(v_expiry_offer_ids)
    order by product.id
    for update of product;

    perform 1
    from public.product_identifiers identifier
    inner join public.offer_targets target
      on target.product_id = identifier.product_id
    where target.offer_id = any(v_expiry_offer_ids)
    order by identifier.id
    for share of identifier;

    if pg_catalog.cardinality(v_expiry_product_ids) > 0 then
      select coalesce(
        pg_catalog.array_agg(eligible.offer_id order by eligible.offer_id),
        '{}'::bigint[]
      )
      into v_visible_expiry_offer_ids
      from (
        select projected.offer_id
        from pg_catalog.unnest(v_expiry_product_ids) requested(product_id)
        cross join lateral public.public_official_offer_rows_v1(
          array[requested.product_id], v_started_at
        ) projected
        where projected.offer_id = any(v_expiry_offer_ids)
          and projected.product_offer_count <= 50
          and projected.total_offer_count <= 50
        group by projected.offer_id
        having pg_catalog.count(*) = 1
      ) eligible;
    end if;

    with transitioned as (
      update public.approved_offers offer
      set status = case
        when public.official_offer_lifecycle_is_revoked_v1(offer.id, v_started_at)
          then 'revoked'
        else 'expired'
      end
      where offer.id = any(v_expiry_offer_ids)
        and (
          offer.status = 'approved'
          or (
            offer.status = 'published'
            and not (offer.id = any(v_visible_expiry_offer_ids))
          )
        )
      returning status
    )
    select
      pg_catalog.count(*) filter (where status = 'expired')::integer,
      pg_catalog.count(*) filter (where status = 'revoked')::integer
    into v_expired_count, v_revoked_count
    from transitioned;
  end if;

  if v_publication_authorized and v_source_is_current then
    select
      coalesce(
        pg_catalog.array_agg(
          selected.offer_id order by selected.scan_segment, selected.offer_id
        ),
        '{}'::bigint[]
      ),
      coalesce(
        pg_catalog.array_agg(distinct selected.product_id)
          filter (where selected.product_id is not null),
        '{}'::bigint[]
      )
    into v_publication_offer_ids, v_publication_product_ids
    from (
      select
        offer.id as offer_id,
        target.product_id,
        case when offer.id > v_publication_cursor_offer_id then 0 else 1 end
          as scan_segment
      from public.approved_offers offer
      left join public.offer_targets target on target.offer_id = offer.id
      where offer.source_id = p_source_id
        and offer.status = 'approved'
        and offer.valid_from <= v_started_at
        and offer.valid_until > v_started_at
      order by
        case when offer.id > v_publication_cursor_offer_id then 0 else 1 end,
        offer.id
      limit p_batch_limit
      for update of offer
    ) selected;

    v_publication_examined := pg_catalog.cardinality(v_publication_offer_ids);
    if v_publication_examined > 0 then
      v_publication_next_cursor_offer_id :=
        v_publication_offer_ids[v_publication_examined];
    end if;
    if v_publication_examined > 0 then
      perform 1
      from public.geographic_scopes scope
      inner join public.approved_offers offer
        on offer.geographic_scope_id = scope.id
      where offer.id = any(v_publication_offer_ids)
      order by scope.id
      for share of scope;

      perform 1
      from public.canonical_products product
      inner join public.offer_targets target on target.product_id = product.id
      where target.offer_id = any(v_publication_offer_ids)
      order by product.id
      for update of product;

      perform 1
      from public.product_identifiers identifier
      inner join public.offer_targets target
        on target.product_id = identifier.product_id
      where target.offer_id = any(v_publication_offer_ids)
      order by identifier.id
      for share of identifier;

      -- The transition is invisible until commit. The existing public-only
      -- projection is then the single authority: rows that fail its current
      -- review, rights, source, scope, exact-product, arithmetic, condition,
      -- freshness, or cardinality gates never remain published.
      update public.approved_offers offer
      set status = 'published'
      where offer.id = any(v_publication_offer_ids)
        and offer.status = 'approved';

      -- The lifecycle transition trigger stamps updated_at after v_started_at.
      -- Use a fresh database-owned clock for the authoritative projection so
      -- a row cannot fail solely because its own transition is newer than the
      -- job's initial evaluation snapshot.
      v_publication_projection_as_of := pg_catalog.clock_timestamp();

      if pg_catalog.cardinality(v_publication_product_ids) > 0 then
        select coalesce(
          pg_catalog.array_agg(eligible.offer_id order by eligible.offer_id),
          '{}'::bigint[]
        )
        into v_visible_publication_offer_ids
        from (
          select projected.offer_id
          from pg_catalog.unnest(v_publication_product_ids) requested(product_id)
          cross join lateral public.public_official_offer_rows_v1(
            array[requested.product_id], v_publication_projection_as_of
          ) projected
          where projected.offer_id = any(v_publication_offer_ids)
            and projected.product_offer_count <= 50
            and projected.total_offer_count <= 50
          group by projected.offer_id
          having pg_catalog.count(*) = 1
        ) eligible;
      end if;

      select pg_catalog.count(*)::integer
      into v_published_count
      from public.approved_offers offer
      where offer.id = any(v_visible_publication_offer_ids)
        and offer.status = 'published';

      update public.approved_offers offer
      set status = case
        when public.official_offer_lifecycle_is_revoked_v1(offer.id, v_started_at)
          then 'revoked'
        else 'expired'
      end
      where offer.id = any(v_publication_offer_ids)
        and offer.status = 'published'
        and not (offer.id = any(v_visible_publication_offer_ids));
    end if;
  end if;

  v_skipped_count := v_expiry_examined + v_publication_examined
    - v_expired_count - v_revoked_count - v_published_count;
  v_completed_at := pg_catalog.clock_timestamp();
  if v_completed_at > v_lease_expires_at then
    raise exception 'HP_OFFER_LIFECYCLE_LEASE_EXPIRED'
      using errcode = '57014';
  end if;

  v_counts := pg_catalog.jsonb_build_object(
    'accepted', v_expired_count + v_revoked_count + v_published_count,
    'failed', 0,
    'fetched', v_expiry_examined + v_publication_examined,
    'persisted', v_expiry_examined + v_publication_examined,
    'quarantined', 0,
    'unknown', v_skipped_count
  );
  v_worker_result_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'completedAt', v_completed_at,
      'counts', v_counts,
      'jobId', p_job_id,
      'jobKind', 'official-offer-lifecycle-reconcile',
      'runId', p_run_id,
      'scheduledAt', p_scheduled_at,
      'sourceId', p_source_id,
      'startedAt', v_started_at,
      'status', 'succeeded'
    )::text, 'UTF8')
  ), 'hex');

  insert into public.worker_job_results (
    job_id, source_id, job_kind, scheduled_at, run_id, status,
    started_at, completed_at, counts, result_hash
  ) values (
    p_job_id, p_source_id, 'official-offer-lifecycle-reconcile',
    p_scheduled_at, p_run_id, 'succeeded', v_started_at, v_completed_at,
    v_counts, v_worker_result_sha256
  );

  v_lifecycle_result_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'batchLimit', p_batch_limit,
      'evaluatedAt', v_started_at,
      'expiredCount', v_expired_count,
      'expiryExamined', v_expiry_examined,
      'jobId', p_job_id,
      'leaseExpiresAt', v_lease_expires_at,
      'leaseToken', v_lease_token,
      'publicationExamined', v_publication_examined,
      'publicationAuthorized', v_publication_authorized,
      'publicationRequested', p_publication_requested,
      'publicationState', v_publication_state,
      'publishedCount', v_published_count,
      'revokedCount', v_revoked_count,
      'skippedCount', v_skipped_count,
      'sourceId', p_source_id,
      'workerResultSha256', v_worker_result_sha256
    )::text, 'UTF8')
  ), 'hex');

  insert into public.official_offer_lifecycle_job_results (
    job_id, source_id, lease_token, lease_expires_at, evaluated_at, batch_limit,
    publication_requested, publication_authorized, publication_state, expiry_examined,
    expired_count, revoked_count, publication_examined, published_count,
    skipped_count, result_sha256, created_at
  ) values (
    p_job_id, p_source_id, v_lease_token, v_lease_expires_at,
    v_started_at, p_batch_limit,
    p_publication_requested, v_publication_authorized,
    v_publication_state, v_expiry_examined,
    v_expired_count, v_revoked_count, v_publication_examined,
    v_published_count, v_skipped_count, v_lifecycle_result_sha256,
    v_completed_at
  );

  update public.official_offer_lifecycle_leases lease
  set
    completed_at = v_completed_at,
    expires_at = case
      when v_completed_at > lease.acquired_at then v_completed_at
      else lease.acquired_at + interval '1 microsecond'
    end,
    expiry_cursor_offer_id = v_expiry_next_cursor_offer_id,
    publication_cursor_offer_id = v_publication_next_cursor_offer_id
  where lease.source_id = p_source_id
    and lease.lease_token = v_lease_token;
  if not found then
    raise exception 'HP_OFFER_LIFECYCLE_LEASE_LOST'
      using errcode = '40001';
  end if;

  return query select
    'completed'::text, false, p_job_id, p_source_id,
    v_started_at, v_lease_expires_at, v_publication_state,
    v_expiry_examined, v_expired_count, v_revoked_count,
    v_publication_examined, v_published_count, v_skipped_count;
end;
$$;

revoke all on function public.official_offer_lifecycle_reconcile_v1(
  text, text, text, timestamptz, text, integer, boolean
) from public;

-- Upgrade fail closed: an already-existing worker role gets only EXECUTE on
-- the atomic boundary. It receives no direct lifecycle table privilege.
do $official_offer_lifecycle_upgrade$
begin
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_app'
  ) then
    execute 'revoke all on table public.official_offer_publication_policy from handleplan_app';
    execute 'revoke all on table public.official_offer_lifecycle_leases from handleplan_app';
    execute 'revoke all on table public.official_offer_lifecycle_job_results from handleplan_app';
    execute 'grant execute on function public.official_offer_lifecycle_reconcile_v1(
      text, text, text, timestamp with time zone, text, integer, boolean
    ) to handleplan_app';
  end if;
end;
$official_offer_lifecycle_upgrade$;
