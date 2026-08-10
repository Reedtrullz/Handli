-- Least-privilege runtime boundary for the private operations dashboard.
-- The handleplan_operations role is created by deploy/migrate.mjs and receives
-- EXECUTE on the aggregate function below only. It receives no direct table,
-- sequence, generic alert-ledger, review, capture, or publication privileges.

-- Phase-level discovery and fetch results are fixed source-neutral job
-- identities. They are observable for lag independently, but do not assert a
-- combined source-health snapshot; official-offer-ingestion retains that
-- responsibility.
alter table public.worker_job_results
  drop constraint worker_job_results_job_kind;

alter table public.worker_job_results
  add constraint worker_job_results_job_kind check (
    job_kind in (
      'catalog-refresh',
      'benchmark-price-refresh',
      'physical-store-sync',
      'historical-observation-collection',
      'official-offer-discovery',
      'official-offer-fetch',
      'official-offer-ingestion',
      'official-offer-lifecycle-reconcile'
    )
  );

alter table public.worker_job_results
  add column operations_boundary_version smallint,
  add column persisted_at timestamptz,
  add constraint worker_job_results_operations_boundary_pair check (
    (operations_boundary_version is null and persisted_at is null)
    or (operations_boundary_version = 1 and persisted_at is not null)
  );

alter table public.source_health_snapshots
  add column operations_boundary_version smallint,
  add column persisted_at timestamptz,
  add constraint source_health_snapshots_operations_boundary_pair check (
    (operations_boundary_version is null and persisted_at is null)
    or (operations_boundary_version = 1 and persisted_at is not null)
  );

alter table public.alert_events
  add column operations_boundary_version smallint,
  add column persisted_at timestamptz,
  add constraint alert_events_operations_boundary_pair check (
    (operations_boundary_version is null and persisted_at is null)
    or (operations_boundary_version = 1 and persisted_at is not null)
  );

create function public.stamp_operations_runtime_boundary_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  new.operations_boundary_version := 1;
  new.persisted_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function public.stamp_operations_runtime_boundary_v1() from public;

create trigger worker_job_results_operations_boundary
before insert on public.worker_job_results
for each row execute function public.stamp_operations_runtime_boundary_v1();

create trigger source_health_snapshots_operations_boundary
before insert on public.source_health_snapshots
for each row execute function public.stamp_operations_runtime_boundary_v1();

create trigger alert_events_operations_boundary
before insert on public.alert_events
for each row execute function public.stamp_operations_runtime_boundary_v1();

create trigger alert_events_append_only
before update or delete on public.alert_events
for each row execute function public.reject_append_only_mutation();

create index worker_job_results_operations_source_kind_time_idx
  on public.worker_job_results (source_id, job_kind, persisted_at desc, id desc)
  where operations_boundary_version = 1;

create index source_health_snapshots_operations_source_time_idx
  on public.source_health_snapshots (source_id, persisted_at desc, id desc)
  where operations_boundary_version = 1 and geographic_scope_id is null;

create index alert_events_operations_identity_time_idx
  on public.alert_events (alert_key, source_id, persisted_at desc, id desc)
  where operations_boundary_version = 1;

create index alert_events_operations_checkpoint_idx
  on public.alert_events (id desc)
  where operations_boundary_version = 1
    and alert_key = 'operations.evaluation-checkpoint'
    and source_id is null;

-- This projection deliberately reports administrative row state rather than
-- claiming public eligibility. The richer alert evaluator remains disabled
-- until its independently specified current-rights projection and off-host
-- delivery path have live evidence.
create function public.operations_dashboard_rows_v1(
  p_source_ids text[],
  p_result_limit integer
)
returns table (
  observed_at timestamptz,
  source_id text,
  governance_state text,
  health_state text,
  health_recorded_at timestamptz,
  health_persisted_at timestamptz,
  last_discovery_success_at timestamptz,
  last_capture_success_at timestamptz,
  last_publish_success_at timestamptz,
  newest_eligible_evidence_at timestamptz,
  health_worker_job_kind text,
  worker_results_24h bigint,
  non_successful_worker_results_24h bigint,
  latest_worker_results jsonb,
  pending_review_rows bigint,
  active_published_offer_rows bigint,
  expiring_published_offer_rows bigint,
  expired_published_offer_rows bigint,
  latest_extraction_state text,
  latest_extraction_completed_at timestamptz,
  latest_extraction_empty_result text,
  latest_extraction_candidate_rows bigint,
  newest_ordinary_price_at timestamptz
)
language plpgsql
volatile
security definer
parallel unsafe
set search_path = pg_catalog, pg_temp
set statement_timeout = '3000ms'
set lock_timeout = '500ms'
as $$
declare
  v_observed_at timestamptz := pg_catalog.clock_timestamp();
  v_sorted_source_ids text[];
begin
  if p_source_ids is null
     or pg_catalog.array_ndims(p_source_ids) is distinct from 1
     or pg_catalog.cardinality(p_source_ids) not between 1 and 100
     or p_result_limit is null
     or p_result_limit not between 1 and 100
     or pg_catalog.cardinality(p_source_ids) > p_result_limit
     or exists (
       select 1
       from pg_catalog.unnest(p_source_ids) as requested(value)
       where requested.value is null
         or pg_catalog.char_length(requested.value) not between 1 and 64
         or requested.value !~ '^[a-z0-9][a-z0-9._-]*$'
     )
     or (
       select pg_catalog.count(distinct requested.value)
       from pg_catalog.unnest(p_source_ids) as requested(value)
     ) <> pg_catalog.cardinality(p_source_ids) then
    raise exception 'invalid operations source roster'
      using errcode = '22023';
  end if;

  select pg_catalog.array_agg(requested.value order by requested.value collate "C")
  into strict v_sorted_source_ids
  from pg_catalog.unnest(p_source_ids) as requested(value);
  if v_sorted_source_ids is distinct from p_source_ids then
    raise exception 'operations source roster must be canonically sorted'
      using errcode = '22023';
  end if;

  if (
    select pg_catalog.count(*)
    from public.data_sources source
    where source.id = any(p_source_ids)
  ) <> pg_catalog.cardinality(p_source_ids) then
    raise exception 'operations source roster does not match stored sources'
      using errcode = '22023';
  end if;

  return query
  with bounded_sources as materialized (
    select
      source.id,
      case
        when source.runtime_state = 'revoked'
          or current_permission.decision = 'revoked' then 'revoked'
        when (
          current_permission.id is null
          and (
            source.permission_reviewed_at is not null
            or source.permission_expires_at is not null
          )
        ) or (
          current_permission.id is not null
          and (
            source.permission_reviewed_at is distinct from current_permission.reviewed_at
            or source.permission_expires_at is distinct from current_permission.valid_until
          )
        ) then 'contradictory'
        when source.permission_expires_at <= v_observed_at
          or current_permission.valid_until <= v_observed_at then 'expired'
        when source.runtime_state = 'blocked' then 'blocked'
        when source.runtime_state = 'conditional' then 'conditional'
        when source.runtime_state = 'approved'
          and source.public_state_changed_at <= v_observed_at
          and source.permission_reviewed_at is not null
          and source.permission_reviewed_at <= v_observed_at
          and source.permission_reviewed_at = current_permission.reviewed_at
          and source.permission_expires_at is not distinct from current_permission.valid_until
          and current_permission.decision = 'approved'
          and current_permission.created_at <= v_observed_at
          and current_permission.reviewed_at <= v_observed_at
          and (current_permission.valid_until is null
            or current_permission.valid_until > v_observed_at)
          then 'approved-current'
        else 'approval-incomplete'
      end as governance_state
    from public.data_sources source
    left join lateral (
      select permission.id, permission.decision, permission.reviewed_at,
        permission.valid_until, permission.created_at
      from public.source_permissions permission
      where permission.source_id = source.id
        and permission.created_at <= v_observed_at
      order by permission.created_at desc, permission.id desc
      limit 1
    ) current_permission on true
    where source.id = any(p_source_ids)
      and source.created_at <= v_observed_at
    order by source.id collate "C"
    limit p_result_limit
  )
  select
    v_observed_at,
    source.id::text,
    source.governance_state,
    health.status::text,
    health.recorded_at,
    health.persisted_at,
    health.last_discovery_success_at,
    health.last_capture_success_at,
    health.last_publish_success_at,
    health.newest_eligible_evidence_at,
    health_job.job_kind::text,
    worker_counts.total_count,
    worker_counts.non_successful_count,
    coalesce(latest_jobs.items, '[]'::jsonb),
    review_rows.total_count,
    offer_rows.active_count,
    offer_rows.expiring_count,
    offer_rows.expired_count,
    latest_extraction.status::text,
    latest_extraction.completed_at,
    latest_extraction.empty_result::text,
    latest_extraction.candidate_count,
    ordinary_price.newest_observed_at
  from bounded_sources source
  left join lateral (
    select snapshot.*
    from public.source_health_snapshots snapshot
    where snapshot.source_id = source.id
      and snapshot.geographic_scope_id is null
      and snapshot.operations_boundary_version = 1
      and snapshot.persisted_at <= v_observed_at
      and snapshot.recorded_at <= snapshot.persisted_at
    order by snapshot.persisted_at desc, snapshot.id desc
    limit 1
  ) health on true
  left join public.worker_job_results health_job
    on health_job.job_id = health.worker_job_id
   and health_job.source_id = source.id
   and health_job.operations_boundary_version = 1
   and health_job.persisted_at <= v_observed_at
   and health_job.persisted_at <= health.persisted_at
   and health_job.completed_at <= health_job.persisted_at
  cross join lateral (
    select
      (
        select pg_catalog.count(*)
        from (
          select result.id
          from public.worker_job_results result
          where result.source_id = source.id
            and result.operations_boundary_version = 1
            and result.persisted_at > v_observed_at - interval '24 hours'
            and result.persisted_at <= v_observed_at
            and result.completed_at <= result.persisted_at
          order by result.persisted_at desc, result.id desc
          limit 10001
        ) bounded_total
      ) as total_count,
      (
        select pg_catalog.count(*)
        from (
          select result.id
          from public.worker_job_results result
          where result.source_id = source.id
            and result.operations_boundary_version = 1
            and result.persisted_at > v_observed_at - interval '24 hours'
            and result.persisted_at <= v_observed_at
            and result.completed_at <= result.persisted_at
            and result.status <> 'succeeded'
          order by result.persisted_at desc, result.id desc
          limit 10001
        ) bounded_non_successful
      ) as non_successful_count
  ) worker_counts
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'jobKind', latest.job_kind,
        'status', latest.status,
        'completedAt', latest.completed_at,
        'persistedAt', latest.persisted_at
      ) order by latest.job_kind collate "C"
    ) as items
    from (
      select distinct on (result.job_kind)
        result.job_kind, result.status, result.completed_at, result.persisted_at
      from public.worker_job_results result
      where result.source_id = source.id
        and result.operations_boundary_version = 1
        and result.persisted_at <= v_observed_at
        and result.completed_at <= result.persisted_at
      order by result.job_kind, result.persisted_at desc, result.id desc
    ) latest
  ) latest_jobs on true
  cross join lateral (
    select pg_catalog.count(*) as total_count
    from (
      select candidate.id
      from public.extracted_offer_candidates candidate
      inner join public.extraction_runs extraction
        on extraction.id = candidate.extraction_run_id
      inner join public.publication_captures capture
        on capture.id = extraction.capture_id
      inner join public.publications publication
        on publication.id = capture.publication_id
      where publication.source_id = source.id
        and publication.content_kind is not null
        and publication.edition_identity_sha256 is not null
        and publication.discovery_permission_id is not null
        and capture.capture_permission_id is not null
        and extraction.extraction_permission_id is not null
        and candidate.status = 'pending'
        and candidate.created_at <= v_observed_at
        and not exists (
          select 1
          from public.review_actions action
          where action.candidate_id = candidate.id
            and action.created_at <= v_observed_at
        )
      order by candidate.created_at, candidate.id
      limit 10001
    ) bounded
  ) review_rows
  cross join lateral (
    select
      (
        select pg_catalog.count(*)
        from (
          select offer.id
          from public.approved_offers offer
          inner join lateral (
            select action.action, action.decision_boundary_version
            from public.review_actions action
            where action.candidate_id = offer.candidate_id
              and action.created_at <= v_observed_at
            order by action.created_at desc, action.id desc
            limit 1
          ) current_action on true
          where offer.source_id = source.id
            and offer.status = 'published'
            and offer.updated_at <= v_observed_at
            and offer.valid_from <= v_observed_at
            and offer.valid_until > v_observed_at
            and current_action.action in ('approve', 'correct_and_approve')
            and current_action.decision_boundary_version = 1
          order by offer.id
          limit 10001
        ) bounded_active
      ) as active_count,
      (
        select pg_catalog.count(*)
        from (
          select offer.id
          from public.approved_offers offer
          inner join lateral (
            select action.action, action.decision_boundary_version
            from public.review_actions action
            where action.candidate_id = offer.candidate_id
              and action.created_at <= v_observed_at
            order by action.created_at desc, action.id desc
            limit 1
          ) current_action on true
          where offer.source_id = source.id
            and offer.status = 'published'
            and offer.updated_at <= v_observed_at
            and offer.valid_from <= v_observed_at
            and offer.valid_until > v_observed_at
            and offer.valid_until <= v_observed_at + interval '48 hours'
            and current_action.action in ('approve', 'correct_and_approve')
            and current_action.decision_boundary_version = 1
          order by offer.id
          limit 10001
        ) bounded_expiring
      ) as expiring_count,
      (
        select pg_catalog.count(*)
        from (
          select offer.id
          from public.approved_offers offer
          inner join lateral (
            select action.action, action.decision_boundary_version
            from public.review_actions action
            where action.candidate_id = offer.candidate_id
              and action.created_at <= v_observed_at
            order by action.created_at desc, action.id desc
            limit 1
          ) current_action on true
          where offer.source_id = source.id
            and offer.status = 'published'
            and offer.updated_at <= v_observed_at
            and offer.valid_until <= v_observed_at
            and current_action.action in ('approve', 'correct_and_approve')
            and current_action.decision_boundary_version = 1
          order by offer.id
          limit 10001
        ) bounded_expired
      ) as expired_count
  ) offer_rows
  left join lateral (
    select extraction.status, extraction.completed_at, extraction.empty_result,
      (
        select pg_catalog.count(*)
        from (
          select candidate.id
          from public.extracted_offer_candidates candidate
          where candidate.extraction_run_id = extraction.id
            and candidate.created_at <= v_observed_at
          order by candidate.id
          limit 10001
        ) bounded_candidates
      ) as candidate_count
    from public.extraction_runs extraction
    inner join public.publication_captures capture
      on capture.id = extraction.capture_id
    inner join public.publications publication
      on publication.id = capture.publication_id
    where publication.source_id = source.id
      and publication.content_kind is not null
      and publication.edition_identity_sha256 is not null
      and publication.discovery_permission_id is not null
      and capture.capture_permission_id is not null
      and extraction.extraction_permission_id is not null
      and extraction.status in ('completed', 'degraded', 'failed')
      and extraction.completed_at is not null
      and extraction.completed_at <= v_observed_at
      and extraction.created_at <= v_observed_at
    order by extraction.completed_at desc, extraction.id desc
    limit 1
  ) latest_extraction on true
  left join lateral (
    select observation.observed_at as newest_observed_at
    from public.price_observations observation
    inner join public.ingestion_runs run
      on run.id = observation.ingestion_run_id
     and run.source_id = observation.source_id
    where observation.source_id = source.id
      and observation.created_at <= v_observed_at
      and observation.observed_at <= v_observed_at
      and observation.fetched_at <= v_observed_at
      and observation.source_reference is not null
      and observation.raw_record_hash is not null
      and observation.confidence = 100
      and run.status = 'completed'
      and run.terminalized_at is not null
      and run.terminalized_at <= v_observed_at
    order by observation.observed_at desc, observation.id desc
    limit 1
  ) ordinary_price on true
  order by source.id collate "C";
end;
$$;

revoke all on function public.operations_dashboard_rows_v1(text[], integer)
from public;

-- Atomic append-only alert transition and evaluation-checkpoint boundary. The
-- caller supplies only the exact typed roster and assessment matrix. This
-- function validates cardinality, ordering, scope, outcome/severity/status
-- agreement, roster SHA-256, monotonic evaluation time and replay identity;
-- it owns locks, event clocks, transition details and checkpoint persistence.
create function public.append_operations_alert_evaluation_v1(
  p_evaluated_at timestamptz,
  p_source_roster jsonb,
  p_assessments jsonb
)
returns table (
  appended_count integer,
  checkpoint_evaluated_at timestamptz,
  evaluation_content_sha256 text,
  checkpoint_persisted_at timestamptz,
  source_roster_content_sha256 text,
  source_roster_version text
)
language plpgsql
volatile
security definer
parallel unsafe
set search_path = pg_catalog, pg_temp
set statement_timeout = '3000ms'
set lock_timeout = '500ms'
as $$
declare
  v_alert_key text;
  v_appended integer := 0;
  v_assessment jsonb;
  v_assessment_count integer;
  v_assessment_source_id text;
  v_canonical_roster text;
  v_checkpoint_persisted_at timestamptz;
  v_entry jsonb;
  v_entry_ordinality bigint;
  v_evaluated_at_text text;
  v_evaluation_content_sha256 text;
  v_event_at timestamptz;
  v_expected_count integer;
  v_expected_key text;
  v_job_json text;
  v_job_values text[];
  v_opened_at timestamptz;
  v_outcome text;
  v_previous_alert_key text;
  v_previous_source_id text;
  v_prior public.alert_events%rowtype;
  v_prior_found boolean;
  v_roster_content_sha256 text;
  v_roster_entries_canonical text := '';
  v_roster_version text;
  v_severity text;
  v_signal_json text;
  v_signal_values text[];
  v_source_id text;
  v_source_ids text[] := array[]::text[];
  v_status text;
begin
  if p_evaluated_at is null
     or pg_catalog.date_trunc('milliseconds', p_evaluated_at) <> p_evaluated_at
     or p_source_roster is null
     or p_assessments is null
     or pg_catalog.jsonb_typeof(p_source_roster) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_assessments) is distinct from 'array'
     or (select pg_catalog.count(*)
         from pg_catalog.jsonb_object_keys(p_source_roster)) <> 3
     or not (p_source_roster ?& array['contentSha256', 'entries', 'version'])
     or pg_catalog.jsonb_typeof(p_source_roster -> 'entries') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_source_roster -> 'entries') not between 1 and 100
     or pg_catalog.jsonb_typeof(p_source_roster -> 'contentSha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_source_roster -> 'version') is distinct from 'string' then
    raise exception 'invalid operations alert evaluation envelope'
      using errcode = '22023';
  end if;

  v_roster_content_sha256 := p_source_roster ->> 'contentSha256';
  v_roster_version := p_source_roster ->> 'version';
  if v_roster_content_sha256 !~ '^[0-9a-f]{64}$'
     or pg_catalog.octet_length(v_roster_version) not between 1 and 80
     or v_roster_version !~ '^[a-z0-9][a-z0-9._:-]*$' then
    raise exception 'invalid operations alert roster identity'
      using errcode = '22023';
  end if;

  for v_entry, v_entry_ordinality in
    select roster_entry.value, roster_entry.ordinality
    from pg_catalog.jsonb_array_elements(p_source_roster -> 'entries')
      with ordinality as roster_entry(value, ordinality)
    order by roster_entry.ordinality
  loop
    if pg_catalog.jsonb_typeof(v_entry) is distinct from 'object'
       or (select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(v_entry)) <> 3
       or not (v_entry ?& array[
         'requiredEvidenceSignals', 'requiredWorkerJobKinds', 'sourceId'
       ])
       or pg_catalog.jsonb_typeof(v_entry -> 'sourceId') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_entry -> 'requiredEvidenceSignals') is distinct from 'array'
       or pg_catalog.jsonb_typeof(v_entry -> 'requiredWorkerJobKinds') is distinct from 'array' then
      raise exception 'invalid operations alert roster entry'
        using errcode = '22023';
    end if;

    v_source_id := v_entry ->> 'sourceId';
    if pg_catalog.octet_length(v_source_id) not between 1 and 64
       or v_source_id !~ '^[a-z0-9][a-z0-9._-]*$'
       or (
         pg_catalog.cardinality(v_source_ids) > 0
         and (v_source_ids[pg_catalog.cardinality(v_source_ids)] collate "C")
           >= (v_source_id collate "C")
       ) then
      raise exception 'operations alert roster must be unique and canonically sorted'
        using errcode = '22023';
    end if;
    v_source_ids := pg_catalog.array_append(v_source_ids, v_source_id);

    if pg_catalog.jsonb_array_length(v_entry -> 'requiredEvidenceSignals') not between 1 and 2
       or exists (
         select 1
         from pg_catalog.jsonb_array_elements(v_entry -> 'requiredEvidenceSignals') signal(value)
         where pg_catalog.jsonb_typeof(signal.value) is distinct from 'string'
           or (signal.value #>> '{}') not in ('official-offer', 'ordinary-price')
       ) then
      raise exception 'invalid required operations evidence signals'
        using errcode = '22023';
    end if;
    select pg_catalog.array_agg(signal.value #>> '{}' order by signal.ordinality)
      into v_signal_values
    from pg_catalog.jsonb_array_elements(v_entry -> 'requiredEvidenceSignals')
      with ordinality as signal(value, ordinality);
    if pg_catalog.cardinality(v_signal_values) <> (
         select pg_catalog.count(distinct value)::integer
         from pg_catalog.unnest(v_signal_values) required(value)
       )
       or v_signal_values is distinct from (
         select pg_catalog.array_agg(value order by value collate "C")
         from pg_catalog.unnest(v_signal_values) required(value)
       ) then
      raise exception 'required operations evidence signals must be unique and sorted'
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_array_length(v_entry -> 'requiredWorkerJobKinds') not between 1 and 8
       or exists (
         select 1
         from pg_catalog.jsonb_array_elements(v_entry -> 'requiredWorkerJobKinds') job(value)
         where pg_catalog.jsonb_typeof(job.value) is distinct from 'string'
           or (job.value #>> '{}') not in (
             'benchmark-price-refresh',
             'catalog-refresh',
             'historical-observation-collection',
             'official-offer-discovery',
             'official-offer-fetch',
             'official-offer-ingestion',
             'official-offer-lifecycle-reconcile',
             'physical-store-sync'
           )
       ) then
      raise exception 'invalid required operations worker jobs'
        using errcode = '22023';
    end if;
    select pg_catalog.array_agg(job.value #>> '{}' order by job.ordinality)
      into v_job_values
    from pg_catalog.jsonb_array_elements(v_entry -> 'requiredWorkerJobKinds')
      with ordinality as job(value, ordinality);
    if pg_catalog.cardinality(v_job_values) <> (
         select pg_catalog.count(distinct value)::integer
         from pg_catalog.unnest(v_job_values) required(value)
       )
       or v_job_values is distinct from (
         select pg_catalog.array_agg(value order by value collate "C")
         from pg_catalog.unnest(v_job_values) required(value)
       ) then
      raise exception 'required operations worker jobs must be unique and sorted'
        using errcode = '22023';
    end if;

    select '[' || pg_catalog.string_agg(pg_catalog.to_jsonb(value)::text, ',' order by ordinality) || ']'
      into strict v_signal_json
    from pg_catalog.unnest(v_signal_values) with ordinality required(value, ordinality);
    select '[' || pg_catalog.string_agg(pg_catalog.to_jsonb(value)::text, ',' order by ordinality) || ']'
      into strict v_job_json
    from pg_catalog.unnest(v_job_values) with ordinality required(value, ordinality);
    if v_entry_ordinality > 1 then
      v_roster_entries_canonical := v_roster_entries_canonical || ',';
    end if;
    v_roster_entries_canonical := v_roster_entries_canonical
      || '{"requiredEvidenceSignals":' || v_signal_json
      || ',"requiredWorkerJobKinds":' || v_job_json
      || ',"sourceId":' || pg_catalog.to_jsonb(v_source_id)::text || '}';
  end loop;

  v_canonical_roster := '{"contractVersion":1,"entries":['
    || v_roster_entries_canonical || '],"version":'
    || pg_catalog.to_jsonb(v_roster_version)::text || '}';
  if pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(v_canonical_roster, 'UTF8')
     ), 'hex') is distinct from v_roster_content_sha256 then
    raise exception 'operations alert roster digest does not match canonical content'
      using errcode = '22023';
  end if;
  if (
    select pg_catalog.count(*)
    from public.data_sources source
    where source.id = any(v_source_ids)
  ) <> pg_catalog.cardinality(v_source_ids) then
    raise exception 'operations alert roster does not match stored sources'
      using errcode = '22023';
  end if;

  v_assessment_count := pg_catalog.jsonb_array_length(p_assessments);
  v_expected_count := 8 + 6 * pg_catalog.cardinality(v_source_ids);
  if v_assessment_count <> v_expected_count then
    raise exception 'operations alert evaluation matrix is incomplete'
      using errcode = '22023';
  end if;

  v_previous_alert_key := null;
  v_previous_source_id := null;
  for v_assessment in
    select assessment.value
    from pg_catalog.jsonb_array_elements(p_assessments)
      with ordinality as assessment(value, ordinality)
    order by assessment.ordinality
  loop
    if pg_catalog.jsonb_typeof(v_assessment) is distinct from 'object'
       or (select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(v_assessment)) <> 5
       or not (v_assessment ?& array[
         'alertKey', 'outcome', 'severity', 'sourceId', 'status'
       ])
       or pg_catalog.jsonb_typeof(v_assessment -> 'alertKey') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_assessment -> 'outcome') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_assessment -> 'severity') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_assessment -> 'status') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_assessment -> 'sourceId') not in ('string', 'null') then
      raise exception 'invalid operations alert assessment'
        using errcode = '22023';
    end if;
    v_alert_key := v_assessment ->> 'alertKey';
    v_outcome := v_assessment ->> 'outcome';
    v_severity := v_assessment ->> 'severity';
    v_status := v_assessment ->> 'status';
    v_assessment_source_id := v_assessment ->> 'sourceId';
    if v_alert_key not in (
         'api.coordinator-outage', 'api.error-rate', 'api.latency', 'api.saturation',
         'backup.status', 'certificate.status', 'database.saturation', 'disk.status',
         'offer.expired', 'offer.expiring', 'review.queue-age', 'source.freshness',
         'source.silent-zero-publication', 'worker.lag'
       )
       or v_outcome not in ('ok', 'warning', 'critical', 'unknown')
       or (v_outcome = 'ok') is distinct from (v_status = 'closed')
       or (v_outcome = 'ok' and v_severity <> 'info')
       or (v_outcome = 'critical' and v_severity <> 'critical')
       or (v_outcome in ('warning', 'unknown') and v_severity <> 'warning') then
      raise exception 'operations alert assessment state is invalid'
        using errcode = '22023';
    end if;
    if v_alert_key in (
         'offer.expired', 'offer.expiring', 'review.queue-age', 'source.freshness',
         'source.silent-zero-publication', 'worker.lag'
       ) then
      if v_assessment_source_id is null
         or not (v_assessment_source_id = any(v_source_ids)) then
        raise exception 'operations alert source scope is invalid'
          using errcode = '22023';
      end if;
    elsif v_assessment_source_id is not null then
      raise exception 'operations global alert cannot carry source scope'
        using errcode = '22023';
    end if;
    if v_previous_alert_key is not null and (
      (v_previous_alert_key collate "C") > (v_alert_key collate "C")
      or (
        v_previous_alert_key = v_alert_key
        and (coalesce(v_previous_source_id, '') collate "C")
          >= (coalesce(v_assessment_source_id, '') collate "C")
      )
    ) then
      raise exception 'operations alert assessments must be unique and canonically sorted'
        using errcode = '22023';
    end if;
    v_previous_alert_key := v_alert_key;
    v_previous_source_id := v_assessment_source_id;
  end loop;

  foreach v_expected_key in array array[
    'api.coordinator-outage', 'api.error-rate', 'api.latency', 'api.saturation',
    'backup.status', 'certificate.status', 'database.saturation', 'disk.status'
  ] loop
    if (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(p_assessments) assessment(value)
      where assessment.value ->> 'alertKey' = v_expected_key
        and assessment.value -> 'sourceId' = 'null'::jsonb
    ) <> 1 then
      raise exception 'operations alert global matrix is incomplete'
        using errcode = '22023';
    end if;
  end loop;
  foreach v_source_id in array v_source_ids loop
    foreach v_expected_key in array array[
      'offer.expired', 'offer.expiring', 'review.queue-age', 'source.freshness',
      'source.silent-zero-publication', 'worker.lag'
    ] loop
      if (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(p_assessments) assessment(value)
        where assessment.value ->> 'alertKey' = v_expected_key
          and assessment.value ->> 'sourceId' = v_source_id
      ) <> 1 then
        raise exception 'operations alert source matrix is incomplete'
          using errcode = '22023';
      end if;
    end loop;
  end loop;

  v_evaluated_at_text := pg_catalog.to_char(
    p_evaluated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_evaluation_content_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'assessments', p_assessments,
      'contractVersion', 1,
      'evaluatedAt', v_evaluated_at_text,
      'sourceRoster', p_source_roster
    )::text, 'UTF8')
  ), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('operations.evaluation', 7229164305)
  );
  v_event_at := pg_catalog.clock_timestamp();
  if p_evaluated_at > v_event_at then
    raise exception 'operations alert evaluation cannot be future dated'
      using errcode = '22023';
  end if;

  select event.* into v_prior
  from public.alert_events event
  where event.alert_key = 'operations.evaluation-checkpoint'
    and event.source_id is null
    and event.operations_boundary_version = 1
  order by event.id desc
  limit 1;
  v_prior_found := found;
  if v_prior_found then
    if v_prior.status <> 'closed'
       or v_prior.severity <> 'info'
       or v_prior.opened_at is distinct from v_prior.closed_at
       or v_prior.persisted_at is null
       or v_prior.opened_at > v_prior.persisted_at
       or pg_catalog.jsonb_typeof(v_prior.details) is distinct from 'object'
       or (select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(v_prior.details)) <> 6
       or not (v_prior.details ?& array[
         'contractVersion', 'evaluatedAt', 'evaluationContentSha256', 'kind',
         'sourceRosterContentSha256', 'sourceRosterVersion'
       ])
       or v_prior.details ->> 'contractVersion' <> '1'
       or v_prior.details ->> 'kind' <> 'evaluation-checkpoint'
       or v_prior.details ->> 'evaluationContentSha256' !~ '^[0-9a-f]{64}$'
       or v_prior.details ->> 'sourceRosterContentSha256' !~ '^[0-9a-f]{64}$'
       or v_prior.details ->> 'evaluatedAt'
         !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       or (v_prior.details ->> 'evaluatedAt')::timestamptz > v_prior.opened_at then
      raise exception 'corrupt operations alert checkpoint'
        using errcode = '22000';
    end if;
    if (v_prior.details ->> 'evaluatedAt')::timestamptz > p_evaluated_at then
      raise exception 'operations alert evaluation is older than checkpoint'
        using errcode = '22023';
    end if;
    if (v_prior.details ->> 'evaluatedAt')::timestamptz = p_evaluated_at then
      if v_prior.details ->> 'evaluationContentSha256' <> v_evaluation_content_sha256
         or v_prior.details ->> 'sourceRosterContentSha256' <> v_roster_content_sha256
         or v_prior.details ->> 'sourceRosterVersion' <> v_roster_version then
        raise exception 'operations alert evaluation replay conflicts with checkpoint'
          using errcode = '22023';
      end if;
      return query select
        0,
        p_evaluated_at,
        v_evaluation_content_sha256,
        v_prior.persisted_at,
        v_roster_content_sha256,
        v_roster_version;
      return;
    end if;
  end if;

  for v_assessment in
    select assessment.value
    from pg_catalog.jsonb_array_elements(p_assessments)
      with ordinality as assessment(value, ordinality)
    order by assessment.ordinality
  loop
    v_alert_key := v_assessment ->> 'alertKey';
    v_assessment_source_id := v_assessment ->> 'sourceId';
    v_outcome := v_assessment ->> 'outcome';
    v_severity := v_assessment ->> 'severity';
    v_status := v_assessment ->> 'status';
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_alert_key || ':' || coalesce(v_assessment_source_id, ''),
      7229164305
    ));

    select event.* into v_prior
    from public.alert_events event
    where event.alert_key = v_alert_key
      and event.source_id is not distinct from v_assessment_source_id
      and event.operations_boundary_version = 1
    order by event.id desc
    limit 1;
    v_prior_found := found;
    if v_prior_found then
      if v_prior.status not in ('open', 'closed')
         or (v_prior.status = 'closed') is distinct from (v_prior.closed_at is not null)
         or v_prior.opened_at > coalesce(v_prior.closed_at, v_event_at)
         or v_prior.persisted_at is null
         or v_prior.opened_at > v_prior.persisted_at
         or pg_catalog.jsonb_typeof(v_prior.details) is distinct from 'object'
         or (select pg_catalog.count(*)
             from pg_catalog.jsonb_object_keys(v_prior.details)) <> 6
         or not (v_prior.details ?& array[
           'contractVersion', 'evaluatedAt', 'evaluationContentSha256', 'outcome',
           'sourceRosterContentSha256', 'sourceRosterVersion'
         ])
         or v_prior.details ->> 'contractVersion' <> '1'
         or v_prior.details ->> 'evaluationContentSha256' !~ '^[0-9a-f]{64}$'
         or v_prior.details ->> 'sourceRosterContentSha256' !~ '^[0-9a-f]{64}$'
         or v_prior.details ->> 'evaluatedAt'
           !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
         or (v_prior.details ->> 'evaluatedAt')::timestamptz > v_prior.persisted_at
         or v_prior.details ->> 'outcome' not in ('ok', 'warning', 'critical', 'unknown')
         or ((v_prior.details ->> 'outcome') = 'ok') is distinct from (v_prior.status = 'closed')
         or ((v_prior.details ->> 'outcome') = 'ok' and v_prior.severity <> 'info')
         or ((v_prior.details ->> 'outcome') = 'critical' and v_prior.severity <> 'critical')
         or ((v_prior.details ->> 'outcome') in ('warning', 'unknown')
           and v_prior.severity <> 'warning') then
        raise exception 'corrupt operations alert transition'
          using errcode = '22000';
      end if;
      if (v_prior.details ->> 'evaluatedAt')::timestamptz > p_evaluated_at then
        raise exception 'operations alert transition postdates evaluation'
          using errcode = '22000';
      end if;
      if (v_prior.details ->> 'evaluatedAt')::timestamptz = p_evaluated_at
         and (
           v_prior.details ->> 'evaluationContentSha256' <> v_evaluation_content_sha256
           or v_prior.details ->> 'outcome' <> v_outcome
           or v_prior.severity <> v_severity
           or v_prior.status <> v_status
           or v_prior.details ->> 'sourceRosterContentSha256' <> v_roster_content_sha256
           or v_prior.details ->> 'sourceRosterVersion' <> v_roster_version
         ) then
        raise exception 'operations alert transition conflicts at evaluation clock'
          using errcode = '22023';
      end if;
      if v_prior.details ->> 'outcome' = v_outcome
         and v_prior.severity = v_severity
         and v_prior.status = v_status
         and v_prior.details ->> 'sourceRosterContentSha256' = v_roster_content_sha256
         and v_prior.details ->> 'sourceRosterVersion' = v_roster_version then
        continue;
      end if;
    end if;

    v_opened_at := case
      when v_prior_found and v_prior.status = 'open' then v_prior.opened_at
      else v_event_at
    end;
    insert into public.alert_events (
      alert_key, severity, status, source_id, opened_at, closed_at, details
    ) values (
      v_alert_key,
      v_severity,
      v_status,
      v_assessment_source_id,
      v_opened_at,
      case when v_status = 'closed' then v_event_at else null end,
      pg_catalog.jsonb_build_object(
        'contractVersion', 1,
        'evaluatedAt', v_evaluated_at_text,
        'evaluationContentSha256', v_evaluation_content_sha256,
        'outcome', v_outcome,
        'sourceRosterContentSha256', v_roster_content_sha256,
        'sourceRosterVersion', v_roster_version
      )
    );
    v_appended := v_appended + 1;
  end loop;

  insert into public.alert_events (
    alert_key, severity, status, source_id, opened_at, closed_at, details
  ) values (
    'operations.evaluation-checkpoint',
    'info',
    'closed',
    null,
    v_event_at,
    v_event_at,
    pg_catalog.jsonb_build_object(
      'contractVersion', 1,
      'evaluatedAt', v_evaluated_at_text,
      'evaluationContentSha256', v_evaluation_content_sha256,
      'kind', 'evaluation-checkpoint',
      'sourceRosterContentSha256', v_roster_content_sha256,
      'sourceRosterVersion', v_roster_version
    )
  ) returning persisted_at into strict v_checkpoint_persisted_at;

  return query select
    v_appended,
    p_evaluated_at,
    v_evaluation_content_sha256,
    v_checkpoint_persisted_at,
    v_roster_content_sha256,
    v_roster_version;
end;
$$;

revoke all on function public.append_operations_alert_evaluation_v1(
  timestamptz, jsonb, jsonb
) from public;

-- Bounded transition-only export surface. It is a pull interface, not a
-- recipient integration or delivery claim. Checkpoints and arbitrary ledger
-- rows never cross it; a malformed post-boundary transition fails the batch.
create function public.operations_alert_export_rows_v1(
  p_after_event_id bigint,
  p_result_limit integer
)
returns table (
  event_id bigint,
  alert_key text,
  evaluated_at timestamptz,
  event_at timestamptz,
  outcome text,
  severity text,
  source_id text,
  status text
)
language plpgsql
volatile
security definer
parallel unsafe
set search_path = pg_catalog, pg_temp
set statement_timeout = '2000ms'
set lock_timeout = '500ms'
as $$
declare
  v_event public.alert_events%rowtype;
begin
  if p_after_event_id is null
     or p_after_event_id < 0
     or p_result_limit is null
     or p_result_limit not between 1 and 100 then
    raise exception 'invalid operations alert export request'
      using errcode = '22023';
  end if;

  for v_event in
    select event.*
    from public.alert_events event
    where event.operations_boundary_version = 1
      and event.id > p_after_event_id
      and event.alert_key <> 'operations.evaluation-checkpoint'
    order by event.id
    limit p_result_limit + 1
  loop
    if v_event.alert_key not in (
         'api.coordinator-outage', 'api.error-rate', 'api.latency', 'api.saturation',
         'backup.status', 'certificate.status', 'database.saturation', 'disk.status',
         'offer.expired', 'offer.expiring', 'review.queue-age', 'source.freshness',
         'source.silent-zero-publication', 'worker.lag'
       )
       or v_event.status not in ('open', 'closed')
       or (v_event.status = 'closed') is distinct from (v_event.closed_at is not null)
       or v_event.persisted_at is null
       or pg_catalog.jsonb_typeof(v_event.details) is distinct from 'object'
       or (select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(v_event.details)) <> 6
       or not (v_event.details ?& array[
         'contractVersion', 'evaluatedAt', 'evaluationContentSha256', 'outcome',
         'sourceRosterContentSha256', 'sourceRosterVersion'
       ])
       or v_event.details ->> 'contractVersion' <> '1'
       or v_event.details ->> 'evaluationContentSha256' !~ '^[0-9a-f]{64}$'
       or v_event.details ->> 'sourceRosterContentSha256' !~ '^[0-9a-f]{64}$'
       or v_event.details ->> 'sourceRosterVersion' !~ '^[a-z0-9][a-z0-9._:-]{0,79}$'
       or v_event.details ->> 'evaluatedAt'
         !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       or (v_event.details ->> 'evaluatedAt')::timestamptz > v_event.persisted_at
       or v_event.details ->> 'outcome' not in ('ok', 'warning', 'critical', 'unknown')
       or ((v_event.details ->> 'outcome') = 'ok') is distinct from (v_event.status = 'closed')
       or ((v_event.details ->> 'outcome') = 'ok' and v_event.severity <> 'info')
       or ((v_event.details ->> 'outcome') = 'critical' and v_event.severity <> 'critical')
       or ((v_event.details ->> 'outcome') in ('warning', 'unknown')
         and v_event.severity <> 'warning')
       or (
         v_event.alert_key in (
           'offer.expired', 'offer.expiring', 'review.queue-age', 'source.freshness',
           'source.silent-zero-publication', 'worker.lag'
         )
       ) is distinct from (v_event.source_id is not null) then
      raise exception 'corrupt operations alert export row'
        using errcode = '22000';
    end if;

    event_id := v_event.id;
    alert_key := v_event.alert_key;
    evaluated_at := (v_event.details ->> 'evaluatedAt')::timestamptz;
    event_at := v_event.persisted_at;
    outcome := v_event.details ->> 'outcome';
    severity := v_event.severity;
    source_id := v_event.source_id;
    status := v_event.status;
    return next;
  end loop;
end;
$$;

revoke all on function public.operations_alert_export_rows_v1(bigint, integer)
from public;
