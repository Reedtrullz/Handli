-- Let production official-offer discovery (Tjek, MENY) assert source health.
--
-- Those sources are approved, but their only production job is
-- official-offer-discovery, which runs discovery, capture, and review-only
-- extraction in a single fenced job. Until now neither the worker nor this
-- trigger let that job append a source-health snapshot, so both sources stayed
-- without health forever and /api/source-status reported overall `unknown`
-- (GitHub issue #97).
--
-- Official-offer candidates always go to human review, so `accepted` is
-- structurally zero for this job kind. A succeeded discovery result therefore
-- asserts a healthy snapshot without accepted records and advances the discovery
-- clock even when the current edition was already captured. Capture, publish,
-- and eligible-evidence clocks keep their existing rules: capture still needs
-- persisted progress, and worker counters can never advance governed
-- publication or eligibility.
create or replace function validate_worker_source_health_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  accepted_count bigint;
  expected_capture_success_at timestamptz;
  expected_discovery_success_at timestamptz;
  failed_count bigint;
  fetched_count bigint;
  persisted_count bigint;
  prior_capture_success_at timestamptz;
  prior_discovery_success_at timestamptz;
  prior_newest_eligible_evidence_at timestamptz;
  prior_publish_success_at timestamptz;
  quarantined_count bigint;
  unknown_count bigint;
  worker_result public.worker_job_results%rowtype;
begin
  if new.worker_job_id is null then
    if current_user = 'handleplan_app' then
      raise exception 'worker source-health snapshots require a terminal worker job identity'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select * into worker_result
  from public.worker_job_results
  where job_id = new.worker_job_id;

  if not found then
    raise exception 'worker source-health snapshot requires its terminal worker result'
      using errcode = '23503';
  end if;
  if new.source_id <> worker_result.source_id then
    raise exception 'worker source-health snapshot source must match its worker result'
      using errcode = '23514';
  end if;
  if new.geographic_scope_id is not null then
    raise exception 'worker source-health snapshots are source-wide'
      using errcode = '23514';
  end if;
  if new.recorded_at <> worker_result.completed_at then
    raise exception 'worker source-health snapshot clock must match worker completion'
      using errcode = '23514';
  end if;
  if worker_result.job_kind = 'official-offer-lifecycle-reconcile' then
    raise exception 'official-offer lifecycle results do not assert source-health snapshots'
      using errcode = '23514';
  end if;
  if worker_result.completed_at > clock_timestamp() then
    raise exception 'worker source-health snapshot completion cannot be in the future'
      using errcode = '23514';
  end if;

  if jsonb_typeof(worker_result.counts) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(worker_result.counts)) <> 6
     or not (worker_result.counts ?& array[
       'accepted', 'failed', 'fetched', 'persisted', 'quarantined', 'unknown'
     ])
     or jsonb_typeof(worker_result.counts -> 'accepted') is distinct from 'number'
     or jsonb_typeof(worker_result.counts -> 'failed') is distinct from 'number'
     or jsonb_typeof(worker_result.counts -> 'fetched') is distinct from 'number'
     or jsonb_typeof(worker_result.counts -> 'persisted') is distinct from 'number'
     or jsonb_typeof(worker_result.counts -> 'quarantined') is distinct from 'number'
     or jsonb_typeof(worker_result.counts -> 'unknown') is distinct from 'number'
     or worker_result.counts ->> 'accepted' !~ '^(0|[1-9][0-9]{0,15})$'
     or worker_result.counts ->> 'failed' !~ '^(0|[1-9][0-9]{0,15})$'
     or worker_result.counts ->> 'fetched' !~ '^(0|[1-9][0-9]{0,15})$'
     or worker_result.counts ->> 'persisted' !~ '^(0|[1-9][0-9]{0,15})$'
     or worker_result.counts ->> 'quarantined' !~ '^(0|[1-9][0-9]{0,15})$'
     or worker_result.counts ->> 'unknown' !~ '^(0|[1-9][0-9]{0,15})$' then
    raise exception 'worker source-health snapshot requires canonical aggregate counters'
      using errcode = '23514';
  end if;

  accepted_count := (worker_result.counts ->> 'accepted')::bigint;
  failed_count := (worker_result.counts ->> 'failed')::bigint;
  fetched_count := (worker_result.counts ->> 'fetched')::bigint;
  persisted_count := (worker_result.counts ->> 'persisted')::bigint;
  quarantined_count := (worker_result.counts ->> 'quarantined')::bigint;
  unknown_count := (worker_result.counts ->> 'unknown')::bigint;
  if greatest(
    accepted_count,
    failed_count,
    fetched_count,
    persisted_count,
    quarantined_count,
    unknown_count
  ) > 9007199254740991
     or fetched_count <> accepted_count + quarantined_count + unknown_count
     or persisted_count <> fetched_count
     or (worker_result.status = 'succeeded' and failed_count <> 0)
     or (
       worker_result.status = 'partial'
       and (failed_count = 0 or fetched_count = 0)
     )
     or (
       worker_result.status = 'failed'
       and (failed_count = 0 or fetched_count <> 0)
     ) then
    raise exception 'worker source-health snapshot requires consistent aggregate counters'
      using errcode = '23514';
  end if;

  select
    health.last_discovery_success_at,
    health.last_capture_success_at,
    health.last_publish_success_at,
    health.newest_eligible_evidence_at
  into
    prior_discovery_success_at,
    prior_capture_success_at,
    prior_publish_success_at,
    prior_newest_eligible_evidence_at
  from public.source_health_snapshots health
  where health.source_id = new.source_id
    and health.geographic_scope_id is null
    and health.recorded_at <= new.recorded_at
    and health.worker_job_id is distinct from new.worker_job_id
  order by health.recorded_at desc, health.id desc
  limit 1;

  expected_discovery_success_at := prior_discovery_success_at;
  expected_capture_success_at := prior_capture_success_at;
  if worker_result.status in ('succeeded', 'partial')
     and persisted_count > 0 then
    expected_capture_success_at := worker_result.completed_at;
    if worker_result.job_kind in ('catalog-refresh', 'official-offer-ingestion', 'store-catalog-price-refresh') then
      expected_discovery_success_at := worker_result.completed_at;
    end if;
  end if;
  if worker_result.job_kind = 'official-offer-discovery'
     and worker_result.status in ('succeeded', 'partial') then
    expected_discovery_success_at := worker_result.completed_at;
  end if;

  if new.last_discovery_success_at is distinct from expected_discovery_success_at then
    raise exception 'worker discovery success must match deterministic job progress'
      using errcode = '23514';
  end if;
  if new.last_capture_success_at is distinct from expected_capture_success_at then
    raise exception 'worker capture success must match deterministic job progress'
      using errcode = '23514';
  end if;

  if new.last_publish_success_at is distinct from prior_publish_success_at then
    raise exception 'worker counters cannot advance governed publish success'
      using errcode = '23514';
  end if;
  if new.newest_eligible_evidence_at is distinct from prior_newest_eligible_evidence_at then
    raise exception 'worker counters cannot advance governed eligible evidence'
      using errcode = '23514';
  end if;
  if worker_result.status = 'succeeded'
     and accepted_count > 0
     and new.status <> 'healthy' then
    raise exception 'successful processing with accepted records requires healthy source health'
      using errcode = '23514';
  end if;
  if worker_result.status = 'succeeded'
     and worker_result.job_kind = 'official-offer-discovery'
     and new.status <> 'healthy' then
    raise exception 'successful official-offer discovery requires healthy source health'
      using errcode = '23514';
  end if;
  if (
    worker_result.status = 'partial'
    or (
      worker_result.status = 'succeeded'
      and accepted_count = 0
      and worker_result.job_kind <> 'official-offer-discovery'
    )
  ) and new.status <> 'degraded' then
    raise exception 'partial or zero-accepted-record ingestion requires degraded source health'
      using errcode = '23514';
  end if;
  if worker_result.status in ('failed', 'timed-out') and new.status <> 'failed' then
    raise exception 'failed or timed-out worker result requires failed source health'
      using errcode = '23514';
  end if;
  if worker_result.status = 'cancelled' then
    raise exception 'cancelled worker results do not assert a source-health state'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
