-- Append-only, database-owned proof that a reviewed official offer actually
-- crossed the public lifecycle boundary. The generic worker health writer
-- remains unable to assert either governed publication clock.

-- Migration 026 and the versioned application contract are both disabled by
-- default. Refuse to install this boundary over an out-of-band activation: a
-- pre-existing public row or positive lifecycle result has no replayable
-- lifecycle-to-health binding. A previously published offer may already have
-- expired or been revoked, so current offer state alone is not an adequate
-- upgrade precondition.
--
-- The lifecycle updates approved_offers before it appends its immutable result.
-- Take the same table order here and hold both write fences through trigger
-- installation. Otherwise a lifecycle transaction could cross between the
-- precondition snapshot and CREATE TRIGGER, leaving a positive result with no
-- publication-health fact.
lock table public.approved_offers in share row exclusive mode;
lock table public.official_offer_lifecycle_job_results in share row exclusive mode;

do $official_offer_publication_health_precondition$
begin
  if exists (
    select 1
    from public.official_offer_lifecycle_job_results result
    where result.published_count > 0
  ) then
    raise exception 'pre-existing positive lifecycle results require reviewed health reconciliation';
  end if;

  if exists (
    select 1
    from public.approved_offers offer
    where offer.status = 'published'
  ) then
    raise exception 'pre-existing published offers require reviewed health reconciliation';
  end if;
end;
$official_offer_publication_health_precondition$;

create table public.official_offer_publication_health_facts (
  id bigserial primary key,
  lifecycle_job_id varchar(200) not null unique
    references public.official_offer_lifecycle_job_results(job_id),
  source_id varchar(64) not null references public.data_sources(id),
  published_count integer not null,
  last_publish_success_at timestamptz not null,
  newest_eligible_evidence_at timestamptz not null,
  persisted_at timestamptz not null,
  constraint official_offer_publication_health_count check (
    published_count between 1 and 50
  ),
  constraint official_offer_publication_health_clocks check (
    newest_eligible_evidence_at <= last_publish_success_at
    and last_publish_success_at <= persisted_at
  )
);

create index official_offer_publication_health_source_time_idx
  on public.official_offer_publication_health_facts (
    source_id, persisted_at desc, id desc
  );

-- The trigger below derives its authoritative count from the final published
-- state inside the lifecycle transaction. Keep that bounded by source and
-- transition clock as reviewed-offer history grows.
create index official_offer_publication_health_final_state_idx
  on public.approved_offers (source_id, updated_at)
  where status = 'published';

create trigger official_offer_publication_health_facts_append_only
before update or delete on public.official_offer_publication_health_facts
for each row execute function public.reject_append_only_mutation();

-- The fact is derived only from the immutable lifecycle result and the final
-- post-reconciliation offer state. A transient published transition that the
-- lifecycle immediately expires/revokes cannot produce health evidence.
create function public.record_official_offer_publication_health_v1()
returns trigger
language plpgsql
security definer
parallel unsafe
set search_path = pg_catalog, pg_temp
as $$
declare
  v_current_eligible_evidence_at timestamptz;
  v_final_published_count integer;
  v_newest_eligible_evidence_at timestamptz;
  v_persisted_at timestamptz;
  v_prior_eligible_evidence_at timestamptz;
begin
  if new.published_count = 0 then
    return new;
  end if;
  if not new.publication_authorized
     or not new.publication_requested
     or new.publication_state <> 'evaluated' then
    raise exception 'HP_OFFER_PUBLICATION_HEALTH_UNAUTHORIZED'
      using errcode = '23514';
  end if;

  -- Lifecycle reconciliation is already serialized per source. Retain a
  -- separate namespace so a future privileged maintenance path cannot race the
  -- cumulative evidence clock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'official-offer-publication-health-v1:' || new.source_id,
      7229164308
    )
  );

  select
    pg_catalog.count(*)::integer,
    pg_catalog.max(capture.retrieved_at)
  into v_final_published_count, v_current_eligible_evidence_at
  from public.approved_offers offer
  inner join public.extracted_offer_candidates candidate
    on candidate.id = offer.candidate_id
  inner join public.extraction_runs extraction
    on extraction.id = candidate.extraction_run_id
  inner join public.publication_captures capture
    on capture.id = extraction.capture_id
  where offer.source_id = new.source_id
    and offer.status = 'published'
    and offer.updated_at > new.evaluated_at
    and offer.updated_at <= new.created_at;

  if v_final_published_count is distinct from new.published_count
     or v_current_eligible_evidence_at is null
     or v_current_eligible_evidence_at > new.created_at then
    raise exception 'HP_OFFER_PUBLICATION_HEALTH_MISMATCH'
      using errcode = '23514';
  end if;

  select fact.newest_eligible_evidence_at
  into v_prior_eligible_evidence_at
  from public.official_offer_publication_health_facts fact
  where fact.source_id = new.source_id
  order by fact.persisted_at desc, fact.id desc
  limit 1;

  v_newest_eligible_evidence_at := case
    when v_prior_eligible_evidence_at is null
      then v_current_eligible_evidence_at
    when v_prior_eligible_evidence_at >= v_current_eligible_evidence_at
      then v_prior_eligible_evidence_at
    else v_current_eligible_evidence_at
  end;
  v_persisted_at := pg_catalog.clock_timestamp();
  if new.created_at > v_persisted_at
     or v_newest_eligible_evidence_at > new.created_at then
    raise exception 'HP_OFFER_PUBLICATION_HEALTH_CLOCK_INVALID'
      using errcode = '23514';
  end if;

  insert into public.official_offer_publication_health_facts (
    lifecycle_job_id,
    source_id,
    published_count,
    last_publish_success_at,
    newest_eligible_evidence_at,
    persisted_at
  ) values (
    new.job_id,
    new.source_id,
    new.published_count,
    new.created_at,
    v_newest_eligible_evidence_at,
    v_persisted_at
  );

  return new;
end;
$$;

revoke all on function public.record_official_offer_publication_health_v1()
from public;

create trigger official_offer_lifecycle_publication_health
after insert on public.official_offer_lifecycle_job_results
for each row execute function public.record_official_offer_publication_health_v1();

-- Merge the latest governed publication fact into the existing bounded
-- operations projection. Keep the previous worker state when it is newer; a
-- publication fact with no newer full health snapshot is explicitly degraded
-- rather than claiming that discovery/capture are healthy.
do $official_offer_publication_health_operations_projection$
declare
  v_body text;
  v_old_select text := $old_select$
    health.status::text,
    health.recorded_at,
    health.persisted_at,
    health.last_discovery_success_at,
    health.last_capture_success_at,
    health.last_publish_success_at,
    health.newest_eligible_evidence_at,
    health_job.job_kind::text,
$old_select$;
  v_new_select text := $new_select$
    case
      when publication_health.persisted_at is not null
        and (
          health.persisted_at is null
          or publication_health.persisted_at > health.persisted_at
        ) then 'degraded'
      else health.status::text
    end,
    case
      when publication_health.persisted_at is not null
        and (
          health.persisted_at is null
          or publication_health.persisted_at > health.persisted_at
        ) then publication_health.last_publish_success_at
      else health.recorded_at
    end,
    case
      when publication_health.persisted_at is not null
        and (
          health.persisted_at is null
          or publication_health.persisted_at > health.persisted_at
        ) then publication_health.persisted_at
      else health.persisted_at
    end,
    health.last_discovery_success_at,
    health.last_capture_success_at,
    case
      when health.last_publish_success_at is null
        then publication_health.last_publish_success_at
      when publication_health.last_publish_success_at is null
        then health.last_publish_success_at
      when health.last_publish_success_at
        >= publication_health.last_publish_success_at
        then health.last_publish_success_at
      else publication_health.last_publish_success_at
    end,
    case
      when health.newest_eligible_evidence_at is null
        then publication_health.newest_eligible_evidence_at
      when publication_health.newest_eligible_evidence_at is null
        then health.newest_eligible_evidence_at
      when health.newest_eligible_evidence_at
        >= publication_health.newest_eligible_evidence_at
        then health.newest_eligible_evidence_at
      else publication_health.newest_eligible_evidence_at
    end,
    case
      when publication_health.persisted_at is not null
        and (
          health.persisted_at is null
          or publication_health.persisted_at > health.persisted_at
        ) then null::text
      else health_job.job_kind::text
    end,
$new_select$;
  v_old_join text := $old_join$
  ) health on true
  left join public.worker_job_results health_job
$old_join$;
  v_new_join text := $new_join$
  ) health on true
  left join lateral (
    select
      fact.last_publish_success_at,
      fact.newest_eligible_evidence_at,
      fact.persisted_at
    from public.official_offer_publication_health_facts fact
    where fact.source_id = source.id
      and fact.persisted_at <= v_observed_at
      and fact.last_publish_success_at <= fact.persisted_at
      and fact.newest_eligible_evidence_at <= fact.last_publish_success_at
    order by fact.persisted_at desc, fact.id desc
    limit 1
  ) publication_health on true
  left join public.worker_job_results health_job
$new_join$;
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.operations_dashboard_rows_v1(text[],integer)'
  );

  if v_body is null
     or (
       pg_catalog.length(v_body)
       - pg_catalog.length(pg_catalog.replace(v_body, v_old_select, ''))
     ) / pg_catalog.length(v_old_select) <> 1
     or (
       pg_catalog.length(v_body)
       - pg_catalog.length(pg_catalog.replace(v_body, v_old_join, ''))
     ) / pg_catalog.length(v_old_join) <> 1 then
    raise exception 'operations publication-health projection drifted';
  end if;

  v_body := pg_catalog.replace(v_body, v_old_select, v_new_select);
  v_body := pg_catalog.replace(v_body, v_old_join, v_new_join);
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
$official_offer_publication_health_operations_projection$;

revoke all on function public.operations_dashboard_rows_v1(text[], integer)
from public;

-- Upgrade fail closed. While the scheduler remains deliberately uncomposed,
-- the dashboard process can read the bounded aggregate only; it cannot write
-- the alert ledger or advance the delivery cursor.
do $official_offer_publication_health_upgrade_acl$
begin
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_app'
  ) then
    execute 'revoke all on table public.official_offer_publication_health_facts from handleplan_app';
    execute 'revoke all on sequence public.official_offer_publication_health_facts_id_seq from handleplan_app';
    execute 'revoke all on function public.record_official_offer_publication_health_v1() from handleplan_app';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_review'
  ) then
    execute 'revoke all on table public.official_offer_publication_health_facts from handleplan_review';
    execute 'revoke all on sequence public.official_offer_publication_health_facts_id_seq from handleplan_review';
    execute 'revoke all on function public.record_official_offer_publication_health_v1() from handleplan_review';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_operations'
  ) then
    execute 'revoke all on table public.official_offer_publication_health_facts from handleplan_operations';
    execute 'revoke all on sequence public.official_offer_publication_health_facts_id_seq from handleplan_operations';
    execute 'revoke all on function public.record_official_offer_publication_health_v1() from handleplan_operations';
    execute 'revoke all on function public.append_operations_alert_evaluation_v1(
      timestamp with time zone, jsonb, jsonb
    ) from handleplan_operations';
    execute 'revoke all on function public.operations_alert_export_rows_v1(
      bigint, integer
    ) from handleplan_operations';
    execute 'grant execute on function public.operations_dashboard_rows_v1(
      text[], integer
    ) to handleplan_operations';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_web'
  ) then
    execute 'revoke all on table public.official_offer_publication_health_facts from handleplan_web';
    execute 'revoke all on sequence public.official_offer_publication_health_facts_id_seq from handleplan_web';
    execute 'revoke all on function public.record_official_offer_publication_health_v1() from handleplan_web';
    execute 'grant select (
      id, source_id, last_publish_success_at,
      newest_eligible_evidence_at, persisted_at
    ) on table public.official_offer_publication_health_facts to handleplan_web';
  end if;
end;
$official_offer_publication_health_upgrade_acl$;
