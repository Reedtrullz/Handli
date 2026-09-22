--
-- PostgreSQL database dump
--

\restrict BRN2b6Ba8CQdoNqcN5JQ60HBS3S8tuHAfNmWMn096qtFwcVfexDyDwEDS3fbHKB

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: append_operations_alert_evaluation_v1(timestamp with time zone, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_operations_alert_evaluation_v1(p_evaluated_at timestamp with time zone, p_source_roster jsonb, p_assessments jsonb) RETURNS TABLE(appended_count integer, checkpoint_evaluated_at timestamp with time zone, evaluation_content_sha256 text, checkpoint_persisted_at timestamp with time zone, source_roster_content_sha256 text, source_roster_version text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET statement_timeout TO '3000ms'
    SET lock_timeout TO '500ms'
    AS $_$
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
$_$;


--
-- Name: assert_current_official_offer_permission(character varying, bigint, jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_current_official_offer_permission(asserted_source_id character varying, asserted_permission_id bigint, asserted_capabilities jsonb, required_capability text, asserted_rights_classification text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: assert_family_taxonomy_publication(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_family_taxonomy_publication(target_version_id character varying) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: assert_public_official_offer_payload_v1(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_public_official_offer_payload_v1(p_payload_bytes bigint) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  -- Bound the complete serialized row set before it crosses the SECURITY
  -- DEFINER boundary. This prevents repeated 10,000-postcode scopes from
  -- amplifying the 501-row overflow-sentinel ceiling into a huge response.
  if p_payload_bytes is null or p_payload_bytes > 8388608 then
    raise exception using
      errcode = '54000',
      message = 'public official-offer projection exceeds the 8 MiB payload bound';
  end if;
  return true;
end;
$$;


--
-- Name: canonical_family_taxonomy_json(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_family_taxonomy_json(input_value jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog'
    AS $$
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


--
-- Name: canonical_official_offer_edition_identity(text, text, text, text, text, bigint, jsonb, timestamp with time zone, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_official_offer_edition_identity(identity_source_id text, identity_external_id text, identity_chain text, identity_title text, identity_content_kind text, identity_geographic_scope_id bigint, identity_declared_scope jsonb, identity_valid_from timestamp with time zone, identity_valid_until timestamp with time zone, identity_discovered_at timestamp with time zone) RETURNS text
    LANGUAGE sql STABLE STRICT
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: canonical_official_offer_scope_identity(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_official_offer_scope_identity(declared_scope jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: claim_public_api_request_budget(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_public_api_request_budget(p_route_key text) RETURNS TABLE(admitted boolean, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare
  v_attempt_count bigint;
  v_limit integer;
  v_oldest_claim timestamptz;
  v_retry_after integer;
  v_window interval;
begin
  -- These policies are intentionally compiled into the database function.
  -- The web role cannot choose a larger limit or a shorter window.
  case p_route_key
    when 'discovery-impact' then v_limit := 120; v_window := interval '1 minute';
    when 'discovery-search' then v_limit := 300; v_window := interval '1 minute';
    when 'locations-current' then v_limit := 120; v_window := interval '1 minute';
    when 'locations-search' then v_limit := 60; v_window := interval '1 minute';
    when 'plan-candidates' then v_limit := 180; v_window := interval '1 minute';
    when 'plans' then v_limit := 120; v_window := interval '1 minute';
    when 'plans-travel' then v_limit := 60; v_window := interval '1 minute';
    when 'products-search' then v_limit := 300; v_window := interval '1 minute';
    when 'source-status' then v_limit := 120; v_window := interval '1 minute';
    else
      raise exception using
        errcode = '22023',
        message = 'unsupported public API route key';
  end case;

  -- Serialize claims for one fixed route class across every application
  -- process. Contention fails closed immediately rather than consuming the
  -- request deadline while waiting for another transaction.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(p_route_key, 7229164303)
  ) then
    return query select false, 1;
    return;
  end if;

  delete from public.public_api_request_budget_events
  where route_key = p_route_key
    and claimed_at <= pg_catalog.clock_timestamp() - v_window;

  select count(*), min(claimed_at)
  into strict v_attempt_count, v_oldest_claim
  from public.public_api_request_budget_events
  where route_key = p_route_key;

  if v_attempt_count < v_limit then
    insert into public.public_api_request_budget_events (route_key)
    values (p_route_key);
    return query select true, 0;
    return;
  end if;

  if v_oldest_claim is null then
    raise exception using
      errcode = 'XX000',
      message = 'public API request budget state is inconsistent';
  end if;

  v_retry_after := least(
    60::numeric,
    greatest(
      1::numeric,
      ceil(
        extract(
          epoch from (v_oldest_claim + v_window - pg_catalog.clock_timestamp())
        )
      )
    )
  )::integer;
  return query select false, v_retry_after;
end;
$$;


--
-- Name: enforce_approved_offer_insert_boundary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_approved_offer_insert_boundary() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.status is distinct from 'approved' then
    raise exception 'approved_offers must begin approved; publication requires the guarded update path'
      using errcode = '23514';
  end if;

  if (session_user = 'handleplan_review' or current_user = 'handleplan_review')
     and new.candidate_id is null then
    raise exception 'handleplan_review offers require an extracted candidate'
      using errcode = '23514';
  end if;

  return new;
end;
$$;


--
-- Name: enforce_approved_offer_lifecycle_transition_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_approved_offer_lifecycle_transition_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: enforce_capture_permission_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_capture_permission_fence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: enforce_catalog_observation_category_path(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_catalog_observation_category_path() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  category_entry jsonb;
  source_category_id text;
  source_category_numeric bigint;
  category_depth_text text;
  category_depth integer;
  category_name text;
  seen_source_category_ids text[] := array[]::text[];
  previous_category_depth integer;
  previous_source_category_numeric bigint;
  has_previous_category boolean := false;
begin
  if new.category_path is null then
    return new;
  end if;

  if jsonb_typeof(new.category_path) is distinct from 'array' then
    raise exception 'catalog observation category path has an invalid container'
      using
        errcode = '23514',
        constraint = 'catalog_observations_category_path_shape';
  end if;
  if jsonb_array_length(new.category_path) > 100 then
    raise exception 'catalog observation category path has an invalid container'
      using
        errcode = '23514',
        constraint = 'catalog_observations_category_path_shape';
  end if;

  for category_entry in
    select value
    from jsonb_array_elements(new.category_path)
  loop
    if jsonb_typeof(category_entry) is distinct from 'object' then
      raise exception 'catalog observation category path entry has an invalid shape'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    if not (category_entry ?& array['sourceCategoryId', 'depth', 'name'])
       or (
         select count(*)
         from jsonb_object_keys(category_entry)
       ) <> 3 then
      raise exception 'catalog observation category path entry has an invalid shape'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    if jsonb_typeof(category_entry -> 'sourceCategoryId') is distinct from 'string' then
      raise exception 'catalog observation category path source id is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    source_category_id := category_entry ->> 'sourceCategoryId';
    if source_category_id is distinct from btrim(source_category_id)
       or source_category_id !~ '^(0|[1-9][0-9]{0,15})$' then
      raise exception 'catalog observation category path source id is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    source_category_numeric := source_category_id::bigint;
    if source_category_numeric > 9007199254740991 then
      raise exception 'catalog observation category path source id is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    if source_category_id = any(seen_source_category_ids) then
      raise exception 'catalog observation category path source ids must be unique'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    seen_source_category_ids := array_append(
      seen_source_category_ids,
      source_category_id
    );

    if jsonb_typeof(category_entry -> 'depth') is distinct from 'number' then
      raise exception 'catalog observation category path depth is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    category_depth_text := category_entry ->> 'depth';
    if category_depth_text !~ '^(0|[1-9][0-9]{0,2})$' then
      raise exception 'catalog observation category path depth is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    category_depth := category_depth_text::integer;
    if category_depth not between 0 and 100 then
      raise exception 'catalog observation category path depth is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    if has_previous_category
       and (
         category_depth < previous_category_depth
         or (
           category_depth = previous_category_depth
           and source_category_numeric <= previous_source_category_numeric
         )
       ) then
      raise exception 'catalog observation category path order is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    previous_category_depth := category_depth;
    previous_source_category_numeric := source_category_numeric;
    has_previous_category := true;

    if jsonb_typeof(category_entry -> 'name') is distinct from 'string' then
      raise exception 'catalog observation category path name is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    category_name := category_entry ->> 'name';
    if category_name is distinct from btrim(category_name)
       or char_length(category_name) not between 1 and 500 then
      raise exception 'catalog observation category path name is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
  end loop;

  return new;
end;
$_$;


--
-- Name: enforce_completed_physical_store_run_consistency(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_completed_physical_store_run_consistency() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: enforce_extraction_run_trust_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_extraction_run_trust_fence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: enforce_family_taxonomy_build_window(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_family_taxonomy_build_window() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: enforce_geographic_scope_member_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_geographic_scope_member_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: enforce_ingestion_run_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_ingestion_run_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  terminal_time timestamptz;
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

  terminal_time := statement_timestamp();
  if new.completed_at > terminal_time then
    raise exception 'ingestion_runs completion cannot be in the future'
      using errcode = '23514';
  end if;

  new.terminalized_at := terminal_time;
  return new;
end;
$$;


--
-- Name: enforce_official_offer_lifecycle_job_boundary_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_official_offer_lifecycle_job_boundary_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if new.job_kind = 'official-offer-lifecycle-reconcile'
     and current_user = 'handleplan_app' then
    raise exception 'HP_OFFER_LIFECYCLE_DEDICATED_BOUNDARY_REQUIRED'
      using errcode = '42501';
  end if;
  return new;
end;
$$;


--
-- Name: enforce_official_offer_scope_identity_immutability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_official_offer_scope_identity_immutability() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: enforce_publication_offer_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_publication_offer_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: enforce_running_ingestion_evidence_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_running_ingestion_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: enforce_running_physical_store_evidence_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_running_physical_store_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: guard_geographic_postal_directory_child(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_geographic_postal_directory_child() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: guard_geographic_postal_directory_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_geographic_postal_directory_version() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: guard_official_offer_condition_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_official_offer_condition_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'official-offer conditions are append-only'
      using errcode = '55000';
  end if;
  -- Serialize condition inserts with the publication UPDATE. Without this row
  -- lock, an INSERT that observed `approved` could commit after publication.
  perform 1
  from public.approved_offers offer
  where offer.id = new.offer_id
    and offer.status = 'approved'
  for share;
  if not found then
    raise exception 'published official-offer conditions are sealed'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: is_canonical_membership_program_id_v1(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_canonical_membership_program_id_v1(p_value text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  -- Bound byte work before Unicode scans. The domain maximum is 200 UTF-16
  -- code units, whose UTF-8 representation cannot exceed 800 bytes.
  if pg_catalog.octet_length(p_value) not between 1 and 800 then
    return false;
  end if;

  return p_value = pg_catalog.btrim(p_value)
    and (
      pg_catalog.char_length(p_value)
      + (
        select pg_catalog.count(*)::integer
        from pg_catalog.generate_series(
          1, pg_catalog.char_length(p_value)
        ) character_index
        where pg_catalog.ascii(pg_catalog.substr(
          p_value, character_index, 1
        )) > 65535
      )
    ) between 1 and 200
    -- btrim(text) covers U+0020. Mirror the remaining ECMAScript edge
    -- whitespace and reject Cc/Cf code points anywhere in the identifier.
    and pg_catalog.ascii(nullif(pg_catalog.left(p_value, 1), ''))
      not in (160, 5760, 8232, 8233, 8239, 8287, 12288)
    and not (pg_catalog.ascii(nullif(pg_catalog.left(p_value, 1), ''))
      between 8192 and 8202)
    and pg_catalog.ascii(nullif(pg_catalog.right(p_value, 1), ''))
      not in (160, 5760, 8232, 8233, 8239, 8287, 12288)
    and not (pg_catalog.ascii(nullif(pg_catalog.right(p_value, 1), ''))
      between 8192 and 8202)
    and (p_value is nfc normalized)
    and not exists (
      select 1
      from pg_catalog.generate_series(
        1, pg_catalog.char_length(p_value)
      ) character_index
      where pg_catalog.ascii(pg_catalog.substr(
        p_value, character_index, 1
      )) between 0 and 31
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 127 and 159
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) in (173, 1564, 1757, 1807, 2274, 6158, 65279, 69821, 69837, 917505)
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 1536 and 1541
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 2192 and 2193
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 8203 and 8207
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 8234 and 8238
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 8288 and 8292
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 8294 and 8303
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 65529 and 65531
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 78896 and 78911
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 113824 and 113827
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 119155 and 119162
         or pg_catalog.ascii(pg_catalog.substr(
           p_value, character_index, 1
         )) between 917536 and 917631
    );
end;
$$;


--
-- Name: lock_data_source_governance_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_data_source_governance_fence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(old.id, 7229164304)
  );
  return new;
end;
$$;


--
-- Name: lock_source_permission_governance_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_source_permission_governance_fence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: official_offer_lifecycle_is_revoked_v1(bigint, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.official_offer_lifecycle_is_revoked_v1(p_offer_id bigint, p_evaluated_at timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: official_offer_lifecycle_reconcile_v1(text, text, text, timestamp with time zone, text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.official_offer_lifecycle_reconcile_v1(p_source_id text, p_job_id text, p_run_id text, p_scheduled_at timestamp with time zone, p_owner_id text, p_batch_limit integer, p_publication_requested boolean) RETURNS TABLE(outcome text, replayed boolean, job_id text, source_id text, database_as_of timestamp with time zone, lease_expires_at timestamp with time zone, publication_state text, expiry_examined integer, expired_count integer, revoked_count integer, publication_examined integer, published_count integer, skipped_count integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET statement_timeout TO '5000ms'
    SET lock_timeout TO '500ms'
    AS $_$
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
$_$;


--
-- Name: operations_alert_export_rows_v1(bigint, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.operations_alert_export_rows_v1(p_after_event_id bigint, p_result_limit integer) RETURNS TABLE(event_id bigint, alert_key text, evaluated_at timestamp with time zone, event_at timestamp with time zone, outcome text, severity text, source_id text, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET statement_timeout TO '2000ms'
    SET lock_timeout TO '500ms'
    AS $_$
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
$_$;


--
-- Name: operations_dashboard_rows_v1(text[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.operations_dashboard_rows_v1(p_source_ids text[], p_result_limit integer) RETURNS TABLE(observed_at timestamp with time zone, source_id text, governance_state text, health_state text, health_recorded_at timestamp with time zone, health_persisted_at timestamp with time zone, last_discovery_success_at timestamp with time zone, last_capture_success_at timestamp with time zone, last_publish_success_at timestamp with time zone, newest_eligible_evidence_at timestamp with time zone, health_worker_job_kind text, worker_results_24h bigint, non_successful_worker_results_24h bigint, latest_worker_results jsonb, pending_review_rows bigint, active_published_offer_rows bigint, expiring_published_offer_rows bigint, expired_published_offer_rows bigint, latest_extraction_state text, latest_extraction_completed_at timestamp with time zone, latest_extraction_empty_result text, latest_extraction_candidate_rows bigint, newest_ordinary_price_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET statement_timeout TO '3000ms'
    SET lock_timeout TO '500ms'
    AS $_$
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
            and current_action.decision_boundary_version = 2
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
            and current_action.decision_boundary_version = 2
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
            and current_action.decision_boundary_version = 2
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
$_$;


--
-- Name: private_review_candidate_rows_v1(bigint, timestamp with time zone, text, text, integer, integer, integer, integer, text, timestamp with time zone, bigint, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_review_candidate_rows_v1(p_candidate_id bigint, p_evaluation_as_of timestamp with time zone, p_chain text, p_scope_kind text, p_min_confidence integer, p_max_confidence integer, p_min_age_hours integer, p_max_age_hours integer, p_anomaly text, p_cursor_created_at timestamp with time zone, p_cursor_id bigint, p_result_limit integer) RETURNS TABLE(candidate_id bigint, candidate_status character varying, normalized_fields jsonb, confidence smallint, anomaly_codes jsonb, candidate_created_at timestamp with time zone, extraction_method character varying, blob_key text, capture_checksum character, mime_type character varying, byte_length integer, rights_classification character varying, retrieved_at timestamp with time zone, source_id character varying, chain character varying, publication_title character varying, publication_valid_from timestamp with time zone, publication_valid_until timestamp with time zone, geographic_scope_id bigint, scope_kind character varying, scope_label character varying)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare
  v_database_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_evaluation_as_of is null
     or p_evaluation_as_of > v_database_now + interval '5 seconds'
     or p_result_limit is null
     or p_result_limit not between 1 and 51
     or (p_candidate_id is not null and p_candidate_id not between 1 and 9007199254740991)
     or (p_cursor_id is not null and p_cursor_id not between 1 and 9007199254740991)
     or ((p_cursor_created_at is null) <> (p_cursor_id is null))
     or (p_chain is not null and p_chain not in ('bunnpris', 'extra', 'rema-1000'))
     or (p_scope_kind is not null
       and p_scope_kind not in ('national', 'region', 'postal_set', 'store_set'))
     or (p_min_confidence is not null and p_min_confidence not between 0 and 100)
     or (p_max_confidence is not null and p_max_confidence not between 0 and 100)
     or (p_min_confidence is not null and p_max_confidence is not null
       and p_min_confidence > p_max_confidence)
     or (p_min_age_hours is not null and p_min_age_hours not between 0 and 2160)
     or (p_max_age_hours is not null and p_max_age_hours not between 0 and 2160)
     or (p_min_age_hours is not null and p_max_age_hours is not null
       and p_min_age_hours > p_max_age_hours)
     or (p_anomaly is not null and p_anomaly not in (
       'AMBIGUOUS_PRODUCT', 'BEFORE_PRICE_BELOW_OFFER', 'DUPLICATE_CANDIDATE_KEY',
       'DUPLICATE_OFFER', 'EXTRACTOR_ANOMALY', 'LAYOUT_DRIFT',
       'OCR_REVIEW_REQUIRED', 'PACKAGE_UNKNOWN', 'SCHEMA_DRIFT', 'SCOPE_MISMATCH',
       'UNEXPECTED_EMPTY', 'UNKNOWN_SCOPE', 'UNMATCHED_PRODUCT', 'UNREADABLE_DATE',
       'VALIDITY_OUTSIDE_EDITION'
     )) then
    raise exception 'HP_REVIEW_INVALID_READ_REQUEST'
      using errcode = '22023';
  end if;

  return query
  select
    candidate.id,
    candidate.status,
    candidate.normalized_fields,
    candidate.confidence,
    candidate.anomaly_codes,
    candidate.created_at,
    extraction.extraction_method,
    capture.blob_key,
    capture.checksum,
    capture.mime_type,
    capture.byte_length,
    capture.rights_classification,
    capture.retrieved_at,
    publication.source_id,
    publication.chain,
    publication.title,
    publication.valid_from,
    publication.valid_until,
    scope.id,
    scope.scope_kind,
    scope.label
  from public.extracted_offer_candidates candidate
  inner join public.extraction_runs extraction
    on extraction.id = candidate.extraction_run_id
  inner join public.publication_captures capture
    on capture.id = extraction.capture_id
  inner join public.publications publication
    on publication.id = capture.publication_id
  inner join public.geographic_scopes scope
    on scope.id = publication.geographic_scope_id
  inner join public.data_sources source
    on source.id = publication.source_id
  inner join lateral (
    select current_permission.*
    from public.source_permissions current_permission
    where current_permission.source_id = source.id
      and current_permission.created_at <= v_database_now
    order by current_permission.created_at desc, current_permission.id desc
    limit 1
  ) permission on true
  where candidate.status = 'pending'
    and candidate.created_at <= p_evaluation_as_of
    and candidate.normalized_fields ->> 'contractVersion' = '1'
    and candidate.normalized_fields ->> 'publicationRoute' = 'human-review-required'
    and candidate.normalized_fields ->> 'disposition' in (
      'exact-match', 'review-required'
    )
    and pg_catalog.jsonb_typeof(candidate.normalized_fields -> 'candidate') = 'object'
    and candidate.normalized_fields #>> '{candidate,contractVersion}' = '1'
    and candidate.normalized_fields #>> '{candidate,candidateKey}' = candidate.candidate_key
    and candidate.normalized_fields #> '{candidate,anomalyCodes}' = candidate.anomaly_codes
    and candidate.normalized_fields -> 'anomalyCodes' = candidate.anomaly_codes
    and candidate.normalized_fields #> '{candidate,provenance,confidence}'
      = pg_catalog.to_jsonb(candidate.confidence)
    and candidate.normalized_fields #>> '{candidate,provenance,method}'
      = extraction.extraction_method
    and extraction.status in ('completed', 'degraded')
    and extraction.completed_at is not null
    and extraction.created_at <= p_evaluation_as_of
    and extraction.started_at <= p_evaluation_as_of
    and extraction.completed_at <= p_evaluation_as_of
    and extraction.source_started_at is not null
    and extraction.source_started_at <= p_evaluation_as_of
    and extraction.source_completed_at is not null
    and extraction.source_completed_at <= p_evaluation_as_of
    and extraction.empty_result = 'not-empty'
    and extraction.extraction_method in ('structured', 'embedded-text', 'ocr')
    and capture.created_at <= p_evaluation_as_of
    and capture.retrieved_at <= p_evaluation_as_of
    and capture.rights_classification in ('private_review', 'public_display')
    and publication.created_at <= p_evaluation_as_of
    and publication.discovered_at <= p_evaluation_as_of
    and publication.content_kind in ('structured-feed', 'publication')
    and publication.declared_geographic_scope is not null
    -- The normalized review payload is not independently protected by the
    -- publication-scope seal in migration 020. Do not expose a candidate whose
    -- embedded scope has drifted from the immutable publication identity.
    and candidate.normalized_fields #> '{candidate,geographicScope}'
      = publication.declared_geographic_scope
    and publication.edition_identity_sha256 is not null
    and publication.discovery_permission_id is not null
    and scope.status = 'active'
    and scope.created_at <= p_evaluation_as_of
    and scope.public_state_changed_at <= p_evaluation_as_of
    and source.runtime_state = 'approved'
    and source.created_at <= p_evaluation_as_of
    and source.public_state_changed_at <= p_evaluation_as_of
    and permission.decision = 'approved'
    -- Select current permission by the database persistence clock, never by a
    -- caller-controlled reviewed_at. A later revoke therefore invalidates an
    -- otherwise historical evaluation immediately.
    and permission.created_at <= p_evaluation_as_of
    and permission.reviewed_at <= p_evaluation_as_of
    and (permission.valid_until is null or permission.valid_until > p_evaluation_as_of)
    and (permission.valid_until is null or permission.valid_until > v_database_now)
    and source.permission_reviewed_at = permission.reviewed_at
    and source.permission_expires_at is not distinct from permission.valid_until
    and permission.permissions @> '{"officialOffers": true, "privateReview": true}'::jsonb
    and permission.permissions -> 'officialOfferCapabilities' in (
      '["capture", "discover", "extract"]'::jsonb,
      '["capture", "discover", "extract", "ocr"]'::jsonb
    )
    and permission.permissions -> 'officialOfferRightsClassifications' in (
      '["extract_only"]'::jsonb,
      '["private_review"]'::jsonb,
      '["public_display"]'::jsonb,
      '["extract_only", "private_review"]'::jsonb,
      '["extract_only", "public_display"]'::jsonb,
      '["private_review", "public_display"]'::jsonb,
      '["extract_only", "private_review", "public_display"]'::jsonb
    )
    and permission.permissions -> 'officialOfferRightsClassifications'
      ? capture.rights_classification
    -- Every persisted provenance pointer and capability snapshot must still
    -- equal the one current permission selected above.
    and publication.discovery_permission_id = permission.id
    and capture.capture_permission_id = permission.id
    and capture.capture_permission_capabilities
      = permission.permissions -> 'officialOfferCapabilities'
    and extraction.extraction_permission_id = permission.id
    and extraction.permission_capabilities
      = permission.permissions -> 'officialOfferCapabilities'
    and (
      (extraction.extraction_method = 'ocr'
        and extraction.ocr_permission_id = permission.id
        and permission.permissions -> 'officialOfferCapabilities' ? 'ocr')
      or
      (extraction.extraction_method <> 'ocr' and extraction.ocr_permission_id is null)
    )
    and not exists (
      select 1
      from public.review_actions previous_action
      where previous_action.candidate_id = candidate.id
    )
    and (p_candidate_id is null or candidate.id = p_candidate_id)
    and (p_chain is null or publication.chain = p_chain)
    and (p_scope_kind is null or scope.scope_kind = p_scope_kind)
    and (p_min_confidence is null or candidate.confidence >= p_min_confidence)
    and (p_max_confidence is null or candidate.confidence <= p_max_confidence)
    and (p_min_age_hours is null
      or candidate.created_at <= p_evaluation_as_of - p_min_age_hours * interval '1 hour')
    and (p_max_age_hours is null
      or candidate.created_at >= p_evaluation_as_of - p_max_age_hours * interval '1 hour')
    and (p_anomaly is null or candidate.anomaly_codes ? p_anomaly)
    and (p_cursor_created_at is null or (
      candidate.created_at > p_cursor_created_at
      or (candidate.created_at = p_cursor_created_at and candidate.id > p_cursor_id)
    ))
  order by candidate.created_at, candidate.id
  limit p_result_limit;
end;
$$;


--
-- Name: private_review_decide_v1(bigint, integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, timestamp with time zone, timestamp with time zone, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_review_decide_v1(p_candidate_id bigint, p_expected_version integer, p_action text, p_actor_id text, p_reason text, p_target_kind text, p_target_gtin text, p_target_family_slug text, p_pricing_kind text, p_offer_price_ore integer, p_before_price_ore integer, p_multibuy_quantity integer, p_multibuy_total_ore integer, p_eligibility_kind text, p_membership_program_id text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_channels text[]) RETURNS TABLE(action_id bigint, offer_id bigint, review_state text, new_version integer, acted_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
declare
  v_source_id varchar(64);
  v_scope_id bigint;
  v_decision_now timestamptz;
  v_current_version integer;
  v_candidate record;
  v_product_id bigint;
  v_product_ids bigint[];
  v_offer_id bigint;
  v_action_id bigint;
  v_amount_ore integer;
  v_before_amount_ore integer;
  v_decision jsonb;
  v_candidate_decision jsonb;
  v_previous_values jsonb;
  v_new_values jsonb;
  v_decision_sha256 text;
  v_checksum_sum integer := 0;
  v_digit integer;
  v_index integer;
begin
  -- Stage cheap byte and array-shape ceilings before regexes, Unicode scans or
  -- unnest. SQL boolean expressions are not required to short-circuit, so these
  -- must be separate statements to bound hostile direct-SQL inputs reliably.
  if (p_action is not null and pg_catalog.octet_length(p_action) > 64)
     or (p_actor_id is not null and pg_catalog.octet_length(p_actor_id) > 80)
     or (p_reason is not null and pg_catalog.octet_length(p_reason) > 4000)
     or (p_target_kind is not null and pg_catalog.octet_length(p_target_kind) > 64)
     or (p_target_gtin is not null and pg_catalog.octet_length(p_target_gtin) > 52)
     or (p_target_family_slug is not null
       and pg_catalog.octet_length(p_target_family_slug) > 320)
     or (p_pricing_kind is not null and pg_catalog.octet_length(p_pricing_kind) > 64)
     or (p_eligibility_kind is not null
       and pg_catalog.octet_length(p_eligibility_kind) > 64)
     or (p_membership_program_id is not null
       and pg_catalog.octet_length(p_membership_program_id) > 800) then
    raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
      using errcode = '22023';
  end if;

  if p_channels is not null then
    if pg_catalog.array_ndims(p_channels) is distinct from 1
       or pg_catalog.cardinality(p_channels) not between 1 and 2 then
      raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
        using errcode = '22023';
    end if;
    if exists (
      select 1
      from pg_catalog.unnest(p_channels) channel
      where channel is not null and pg_catalog.octet_length(channel) > 64
    ) then
      raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
        using errcode = '22023';
    end if;
  end if;

  if p_eligibility_kind = 'member'
     and (
       p_membership_program_id is null
       or pg_catalog.octet_length(p_membership_program_id) not between 1 and 800
     ) then
    raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
      using errcode = '22023';
  end if;

  if p_candidate_id is null
     or p_candidate_id not between 1 and 9007199254740991
     or p_expected_version is null
     or p_expected_version < 0
     or p_action is null
     or p_action not in ('approve', 'correct_and_approve', 'reject')
     or p_actor_id is null
     or p_actor_id !~ '^access:[0-9a-f]{64}$'
     or p_reason is null
     or p_reason is distinct from pg_catalog.btrim(p_reason)
     or pg_catalog.char_length(p_reason) not between 1 and 1000 then
    raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
      using errcode = '22023';
  end if;

  if p_action = 'reject' then
    if p_target_kind is not null
       or p_target_gtin is not null
       or p_target_family_slug is not null
       or p_pricing_kind is not null
       or p_offer_price_ore is not null
       or p_before_price_ore is not null
       or p_multibuy_quantity is not null
       or p_multibuy_total_ore is not null
       or p_eligibility_kind is not null
       or p_membership_program_id is not null
       or p_valid_from is not null
       or p_valid_until is not null
       or p_channels is not null then
      raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
        using errcode = '22023';
    end if;
  else
    if p_target_kind is null
       or p_target_kind <> 'exact-product'
       or p_pricing_kind is null
       or p_pricing_kind not in ('unit', 'multibuy')
       or p_eligibility_kind is null
       or p_eligibility_kind not in ('public', 'member')
       or p_valid_from is null
       or p_valid_until is null
       or p_valid_from <> pg_catalog.date_trunc('milliseconds', p_valid_from)
       or p_valid_until <> pg_catalog.date_trunc('milliseconds', p_valid_until)
       or p_valid_until <= p_valid_from
       or p_channels is null
       or pg_catalog.array_ndims(p_channels) is distinct from 1
       or pg_catalog.cardinality(p_channels) not between 1 and 2
       or exists (
         select 1 from pg_catalog.unnest(p_channels) channel
         where channel is null or channel not in ('in-store', 'online')
       )
       or (select pg_catalog.count(distinct channel) from pg_catalog.unnest(p_channels) channel)
         <> pg_catalog.cardinality(p_channels)
       or (p_eligibility_kind = 'public' and p_membership_program_id is not null)
       or (p_eligibility_kind = 'member' and (
         p_membership_program_id is null
         or p_membership_program_id is distinct from pg_catalog.btrim(p_membership_program_id)
         -- Zod/JavaScript bounds strings in UTF-16 code units, not Unicode
         -- scalar values. Count every supplementary code point twice.
         or (
           pg_catalog.char_length(p_membership_program_id)
           + (
             select pg_catalog.count(*)::integer
             from pg_catalog.generate_series(
               1, pg_catalog.char_length(p_membership_program_id)
             ) character_index
             where pg_catalog.ascii(pg_catalog.substr(
               p_membership_program_id, character_index, 1
             )) > 65535
           )
         ) not between 1 and 200
         -- btrim(text) covers U+0020 only. Mirror ECMAScript trim for the
         -- remaining non-Cc/Cf edge whitespace that the domain rejects.
         or pg_catalog.ascii(nullif(
           pg_catalog.left(p_membership_program_id, 1), ''
         ))
           in (160, 5760, 8232, 8233, 8239, 8287, 12288)
         or pg_catalog.ascii(nullif(
           pg_catalog.left(p_membership_program_id, 1), ''
         ))
           between 8192 and 8202
         or pg_catalog.ascii(nullif(
           pg_catalog.right(p_membership_program_id, 1), ''
         ))
           in (160, 5760, 8232, 8233, 8239, 8287, 12288)
         or pg_catalog.ascii(nullif(
           pg_catalog.right(p_membership_program_id, 1), ''
         ))
           between 8192 and 8202
         or not (p_membership_program_id is nfc normalized)
         or exists (
           select 1
           from pg_catalog.generate_series(
             1, pg_catalog.char_length(p_membership_program_id)
           ) character_index
           where pg_catalog.ascii(pg_catalog.substr(
             p_membership_program_id, character_index, 1
           )) between 0 and 31
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 127 and 159
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) in (173, 1564, 1757, 1807, 2274, 6158, 65279, 69821, 69837, 917505)
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 1536 and 1541
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 2192 and 2193
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 8203 and 8207
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 8234 and 8238
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 8288 and 8292
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 8294 and 8303
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 65529 and 65531
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 78896 and 78911
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 113824 and 113827
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 119155 and 119162
              or pg_catalog.ascii(pg_catalog.substr(
                p_membership_program_id, character_index, 1
              )) between 917536 and 917631
         )
       ))
       or (p_pricing_kind = 'unit' and (
         p_offer_price_ore is null
         or p_offer_price_ore < 0
         or p_before_price_ore < 0
         or p_multibuy_quantity is not null
         or p_multibuy_total_ore is not null
         or (p_before_price_ore is not null and p_before_price_ore < p_offer_price_ore)
       ))
       or (p_pricing_kind = 'multibuy' and (
         p_offer_price_ore is not null
         or p_before_price_ore < 0
         or p_multibuy_quantity is null
         or p_multibuy_quantity not between 2 and 100
         or p_multibuy_total_ore is null
         or p_multibuy_total_ore < 0
         or (p_before_price_ore is not null
           and p_before_price_ore::bigint * p_multibuy_quantity::bigint
             < p_multibuy_total_ore::bigint)
       ))
       or p_target_gtin is null
       or p_target_gtin !~ '^(?:[0-9]{8}|[0-9]{13})$'
       or p_target_family_slug is not null then
      raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
        using errcode = '22023';
    end if;

    if p_target_kind = 'exact-product' then
      for v_index in 1..pg_catalog.char_length(p_target_gtin) - 1 loop
        v_digit := pg_catalog.substr(p_target_gtin, v_index, 1)::integer;
        v_checksum_sum := v_checksum_sum + v_digit * case
          when (pg_catalog.char_length(p_target_gtin) - v_index) % 2 = 1 then 3
          else 1
        end;
      end loop;
      if (10 - (v_checksum_sum % 10)) % 10
        <> pg_catalog.right(p_target_gtin, 1)::integer then
        raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST'
          using errcode = '22023';
      end if;
    end if;
  end if;

  -- Candidate row lock precedes the source governance lock by design. The
  -- permission/state triggers introduced in migration 020 take the same source
  -- lock, so the rights recheck below cannot race a revocation.
  select publication.source_id, publication.geographic_scope_id
  into v_source_id, v_scope_id
  from public.extracted_offer_candidates candidate
  inner join public.extraction_runs extraction
    on extraction.id = candidate.extraction_run_id
  inner join public.publication_captures capture
    on capture.id = extraction.capture_id
  inner join public.publications publication
    on publication.id = capture.publication_id
  where candidate.id = p_candidate_id
  limit 1
  for update of candidate;

  if v_source_id is null then
    raise exception 'HP_REVIEW_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_source_id, 7229164304)
  );

  -- Publication scope identity/membership is sealed by migration 020. Hold a
  -- row lock as well so an active -> retired state transition cannot race the
  -- final eligibility read and append.
  perform 1
  from public.geographic_scopes scope
  where scope.id = v_scope_id
  for share;
  if not found then
    raise exception 'HP_REVIEW_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  v_decision_now := pg_catalog.clock_timestamp();

  select existing.expected_version + 1
  into v_current_version
  from public.review_actions existing
  where existing.candidate_id = p_candidate_id
    and existing.created_at <= v_decision_now
  order by existing.expected_version desc, existing.created_at desc, existing.id desc
  limit 1;
  v_current_version := coalesce(v_current_version, 0);
  if p_expected_version is distinct from v_current_version or v_current_version <> 0 then
    raise exception 'HP_REVIEW_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  select eligible.*
  into v_candidate
  from public.private_review_candidate_rows_v1(
    p_candidate_id, v_decision_now,
    null, null, null, null, null, null, null, null, null, 1
  ) eligible;
  if not found then
    raise exception 'HP_REVIEW_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if v_candidate.source_id is distinct from v_source_id then
    raise exception 'HP_REVIEW_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- The current source-neutral review UI exposes only an opaque crop digest;
  -- it has no candidate-bound, rights-checked blob reader/renderer. Until that
  -- separate boundary exists, reject remains auditable but an operator cannot
  -- truthfully attest an approval or correction from rendered evidence.
  if p_action <> 'reject'
     and pg_catalog.current_setting('handleplan.review_evidence_authorized', true)
       is distinct from 'v1' then
    raise exception 'HP_REVIEW_EVIDENCE_UNAVAILABLE'
      using errcode = '55000';
  end if;

  if p_action <> 'reject' then
    if p_valid_from < v_candidate.publication_valid_from
       or p_valid_until > v_candidate.publication_valid_until
       or p_valid_until <= v_decision_now then
      raise exception 'HP_REVIEW_DECISION_MISMATCH'
        using errcode = '22023';
    end if;

    v_decision := pg_catalog.jsonb_build_object(
      'channels', pg_catalog.to_jsonb(p_channels),
      'eligibility', case p_eligibility_kind
        when 'public' then pg_catalog.jsonb_build_object('kind', 'public')
        else pg_catalog.jsonb_build_object(
          'kind', 'member', 'programId', p_membership_program_id
        )
      end,
      'pricing', case p_pricing_kind
        when 'unit' then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'unit', 'offerPriceOre', p_offer_price_ore,
          'beforePriceOre', p_before_price_ore
        ))
        else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'multibuy', 'quantity', p_multibuy_quantity,
          'totalOre', p_multibuy_total_ore,
          'beforeUnitPriceOre', p_before_price_ore
        ))
      end,
      'target', pg_catalog.jsonb_build_object(
        'kind', 'exact-product', 'gtin', p_target_gtin
      ),
      'validity', pg_catalog.jsonb_build_object(
        'startsAt', pg_catalog.to_char(
          p_valid_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'endsAt', pg_catalog.to_char(
          p_valid_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )
    );

    if v_candidate.normalized_fields #>> '{candidate,product,kind}' = 'exact-identifier'
       and v_candidate.normalized_fields #>> '{candidate,product,scheme}' = 'gtin'
       and v_candidate.normalized_fields #>> '{candidate,validity,state}' = 'parsed' then
      v_candidate_decision := pg_catalog.jsonb_build_object(
        'channels', v_candidate.normalized_fields #> '{candidate,channels}',
        'eligibility', v_candidate.normalized_fields #> '{candidate,eligibility}',
        'pricing', v_candidate.normalized_fields #> '{candidate,pricing}',
        'target', pg_catalog.jsonb_build_object(
          'kind', 'exact-product',
          'gtin', v_candidate.normalized_fields #>> '{candidate,product,value}'
        ),
        'validity', pg_catalog.jsonb_build_object(
          'startsAt', v_candidate.normalized_fields #>> '{candidate,validity,startsAt}',
          'endsAt', v_candidate.normalized_fields #>> '{candidate,validity,endsAt}'
        )
      );
    else
      v_candidate_decision := null;
    end if;

    if p_action = 'approve' and v_decision is distinct from v_candidate_decision then
      raise exception 'HP_REVIEW_DECISION_MISMATCH'
        using errcode = '22023';
    end if;

    select pg_catalog.array_agg(target.product_id order by target.identifier_id)
    into v_product_ids
    from (
      select identifier.id as identifier_id, identifier.product_id
      from public.product_identifiers identifier
      inner join public.canonical_products product on product.id = identifier.product_id
      where identifier.value = p_target_gtin
        and identifier.scheme = case pg_catalog.char_length(p_target_gtin)
          when 8 then 'ean8' else 'ean13'
        end
        and identifier.confidence = 100
        and identifier.verified_at is not null
        and identifier.verified_at <= v_decision_now
        and identifier.created_at <= v_decision_now
        and identifier.public_state_changed_at <= v_decision_now
        and product.created_at <= v_decision_now
        and product.public_state_changed_at <= v_decision_now
        and product.status = 'active'
      order by identifier.id
      limit 2
    ) target;
    if pg_catalog.cardinality(v_product_ids) is distinct from 1 then
      raise exception 'HP_REVIEW_TARGET_NOT_FOUND'
        using errcode = 'P0002';
    end if;
    v_product_id := v_product_ids[1];

    if p_pricing_kind = 'unit' then
      v_amount_ore := p_offer_price_ore;
      v_before_amount_ore := p_before_price_ore;
    else
      v_amount_ore := ((p_multibuy_total_ore::bigint
        + p_multibuy_quantity::bigint - 1) / p_multibuy_quantity::bigint)::integer;
      v_before_amount_ore := p_before_price_ore;
    end if;

    v_decision_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_decision::text, 'UTF8')),
      'hex'
    );
    insert into public.approved_offers (
      offer_key, candidate_id, source_id, source_reference, chain,
      geographic_scope_id, amount_ore, before_amount_ore,
      multibuy_quantity, multibuy_group_amount_ore,
      membership_requirement, valid_from, valid_until,
      status, version, approved_at
    ) values (
      'official-review:' || p_candidate_id::text || ':' || v_decision_sha256,
      p_candidate_id, v_candidate.source_id,
      'review-candidate:' || p_candidate_id::text || ':v1',
      v_candidate.chain, v_candidate.geographic_scope_id,
      v_amount_ore, v_before_amount_ore,
      case when p_pricing_kind = 'multibuy' then p_multibuy_quantity else null end,
      case when p_pricing_kind = 'multibuy' then p_multibuy_total_ore else null end,
      p_eligibility_kind, p_valid_from, p_valid_until,
      'approved', 1, v_decision_now
    ) returning id into v_offer_id;

    insert into public.offer_targets (
      offer_id, product_id, family_slug, match_method, match_confidence
    ) values (
      v_offer_id, v_product_id, null,
      case when p_action = 'approve' then 'exact_identifier' else 'human_review' end,
      case when p_action = 'approve' then v_candidate.confidence else 100 end
    );

    if p_eligibility_kind = 'member' then
      insert into public.offer_conditions (offer_id, condition_type, condition_value)
      values (
        v_offer_id, 'membership',
        pg_catalog.jsonb_build_object('programId', p_membership_program_id)
      );
    end if;
    if p_pricing_kind = 'multibuy' then
      insert into public.offer_conditions (offer_id, condition_type, condition_value)
      values (
        v_offer_id, 'quantity',
        pg_catalog.jsonb_build_object('quantity', p_multibuy_quantity)
      );
    end if;
    insert into public.offer_conditions (offer_id, condition_type, condition_value)
    values (
      v_offer_id, 'channel', pg_catalog.jsonb_build_object('channels', p_channels)
    );
  end if;

  v_previous_values := pg_catalog.jsonb_build_object(
    'candidateSha256', pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_candidate.normalized_fields::text, 'UTF8')),
      'hex'
    ),
    'contractVersion', 1,
    'reviewVersion', v_current_version
  );
  v_new_values := case when p_action = 'reject'
    then pg_catalog.jsonb_build_object(
      'contractVersion', 1, 'reviewVersion', 1, 'state', 'rejected'
    )
    else pg_catalog.jsonb_build_object(
      'contractVersion', 1,
      'decision', v_decision,
      'decisionSha256', v_decision_sha256,
      'reviewVersion', 1,
      'state', 'approved'
    )
  end;

  insert into public.review_actions (
    candidate_id, offer_id, actor_id, action, expected_version,
    previous_values, new_values, reason, acted_at, decision_boundary_version
  ) values (
    p_candidate_id, v_offer_id, p_actor_id, p_action, p_expected_version,
    v_previous_values, v_new_values, p_reason, v_decision_now,
    case when pg_catalog.current_setting(
      'handleplan.review_decision_boundary_version', true
    ) = '2' then 2 else 1 end
  ) returning id into v_action_id;

  return query select
    v_action_id,
    v_offer_id,
    case when p_action = 'reject' then 'rejected' else 'approved' end,
    1,
    v_decision_now;
end;
$_$;


--
-- Name: private_review_decide_v2(bigint, integer, text, text, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, timestamp with time zone, timestamp with time zone, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_review_decide_v2(p_candidate_id bigint, p_expected_version integer, p_action text, p_actor_id text, p_reviewer_session_id text, p_evidence_proof_sha256 text, p_reason text, p_target_kind text, p_target_gtin text, p_target_family_slug text, p_pricing_kind text, p_offer_price_ore integer, p_before_price_ore integer, p_multibuy_quantity integer, p_multibuy_total_ore integer, p_eligibility_kind text, p_membership_program_id text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_channels text[]) RETURNS TABLE(action_id bigint, offer_id bigint, review_state text, new_version integer, acted_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
declare
  v_decision_now timestamptz;
  v_render public.private_review_evidence_renders%rowtype;
  v_result record;
begin
  if (p_action is not null and pg_catalog.octet_length(p_action) > 64)
     or (p_actor_id is not null and pg_catalog.octet_length(p_actor_id) > 80)
     or (p_reviewer_session_id is not null
       and pg_catalog.octet_length(p_reviewer_session_id) > 80)
     or (p_evidence_proof_sha256 is not null
       and pg_catalog.octet_length(p_evidence_proof_sha256) > 64) then
    raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST' using errcode = '22023';
  end if;

  if p_action is null
     or p_action not in ('approve', 'correct_and_approve', 'reject')
     or p_actor_id is null
     or p_actor_id !~ '^access:[0-9a-f]{64}$'
     or p_reviewer_session_id is null
     or p_reviewer_session_id !~ '^access-session:[0-9a-f]{64}$'
     or (p_action = 'reject' and p_evidence_proof_sha256 is not null)
     or (p_action <> 'reject' and (
       p_evidence_proof_sha256 is null
       or p_evidence_proof_sha256 !~ '^[0-9a-f]{64}$'
     )) then
    raise exception 'HP_REVIEW_INVALID_DECISION_REQUEST' using errcode = '22023';
  end if;

  if p_action <> 'reject' then
    v_decision_now := pg_catalog.clock_timestamp();
    select evidence.*
    into v_render
    from public.private_review_evidence_renders evidence
    where evidence.evidence_proof_sha256 = p_evidence_proof_sha256
    for update;

    if not found
       or v_render.candidate_id is distinct from p_candidate_id
       or v_render.expected_version is distinct from p_expected_version
       or v_render.actor_id is distinct from p_actor_id
       or v_render.reviewer_session_id is distinct from p_reviewer_session_id
       or v_render.presentation is distinct from 'full_capture'
       or v_render.mime_type is null
       or v_render.mime_type not in ('image/jpeg', 'image/png', 'image/webp')
       or v_render.rights_classification not in ('private_review', 'public_display')
       or v_render.rendered_at > v_decision_now
       or v_render.expires_at <= v_decision_now
       or exists (
         select 1
         from public.private_review_evidence_consumptions consumption
         where consumption.evidence_render_id = v_render.id
       ) then
      raise exception 'HP_REVIEW_EVIDENCE_UNAVAILABLE' using errcode = '55000';
    end if;
    perform pg_catalog.set_config('handleplan.review_evidence_authorized', 'v1', true);
  end if;

  perform pg_catalog.set_config('handleplan.review_decision_boundary_version', '2', true);

  select decision.*
  into strict v_result
  from public.private_review_decide_v1(
    p_candidate_id, p_expected_version, p_action, p_actor_id, p_reason,
    p_target_kind, p_target_gtin, p_target_family_slug, p_pricing_kind,
    p_offer_price_ore, p_before_price_ore, p_multibuy_quantity,
    p_multibuy_total_ore, p_eligibility_kind, p_membership_program_id,
    p_valid_from, p_valid_until, p_channels
  ) decision;

  if p_action <> 'reject' then
    v_decision_now := pg_catalog.clock_timestamp();
    insert into public.private_review_evidence_consumptions (
      evidence_render_id, review_action_id, candidate_id, consumed_at, created_at
    ) values (
      v_render.id, v_result.action_id, p_candidate_id, v_decision_now, v_decision_now
    );
  end if;

  return query select
    v_result.action_id::bigint,
    v_result.offer_id::bigint,
    v_result.review_state::text,
    v_result.new_version::integer,
    v_result.acted_at::timestamptz;
end;
$_$;


--
-- Name: private_review_record_evidence_render_v1(bigint, integer, text, text, text, text, text, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_review_record_evidence_render_v1(p_candidate_id bigint, p_expected_version integer, p_capture_checksum text, p_crop_reference text, p_presentation text, p_rights_classification text, p_actor_id text, p_reviewer_session_id text, p_evidence_proof_sha256 text, p_expires_at timestamp with time zone) RETURNS TABLE(evidence_render_id bigint, rendered_at timestamp with time zone, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
declare
  v_source_id varchar(64);
  v_scope_id bigint;
  v_render_now timestamptz;
  v_current_version integer;
  v_candidate record;
  v_expected_crop_reference text;
  v_render_id bigint;
begin
  if (p_capture_checksum is not null and pg_catalog.octet_length(p_capture_checksum) > 64)
     or (p_crop_reference is not null and pg_catalog.octet_length(p_crop_reference) > 76)
     or (p_presentation is not null and pg_catalog.octet_length(p_presentation) > 24)
     or (p_rights_classification is not null
       and pg_catalog.octet_length(p_rights_classification) > 24)
     or (p_actor_id is not null and pg_catalog.octet_length(p_actor_id) > 80)
     or (p_reviewer_session_id is not null
       and pg_catalog.octet_length(p_reviewer_session_id) > 80)
     or (p_evidence_proof_sha256 is not null
       and pg_catalog.octet_length(p_evidence_proof_sha256) > 64) then
    raise exception 'HP_REVIEW_INVALID_EVIDENCE_RENDER'
      using errcode = '22023';
  end if;

  if p_candidate_id is null
     or p_candidate_id not between 1 and 9007199254740991
     or p_expected_version is null
     or p_expected_version < 0
     or p_capture_checksum is null
     or p_capture_checksum !~ '^[0-9a-f]{64}$'
     or p_crop_reference is null
     or p_crop_reference !~ '^review-crop:[0-9a-f]{64}$'
     or p_presentation is distinct from 'full_capture'
     or p_rights_classification is null
     or p_rights_classification not in ('private_review', 'public_display')
     or p_actor_id is null
     or p_actor_id !~ '^access:[0-9a-f]{64}$'
     or p_reviewer_session_id is null
     or p_reviewer_session_id !~ '^access-session:[0-9a-f]{64}$'
     or p_evidence_proof_sha256 is null
     or p_evidence_proof_sha256 !~ '^[0-9a-f]{64}$'
     or p_expires_at is null
     or p_expires_at <> pg_catalog.date_trunc('milliseconds', p_expires_at) then
    raise exception 'HP_REVIEW_INVALID_EVIDENCE_RENDER'
      using errcode = '22023';
  end if;

  select publication.source_id, publication.geographic_scope_id
  into v_source_id, v_scope_id
  from public.extracted_offer_candidates candidate
  inner join public.extraction_runs extraction
    on extraction.id = candidate.extraction_run_id
  inner join public.publication_captures capture
    on capture.id = extraction.capture_id
  inner join public.publications publication
    on publication.id = capture.publication_id
  where candidate.id = p_candidate_id
  limit 1
  for update of candidate;

  if v_source_id is null then
    raise exception 'HP_REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_source_id, 7229164304)
  );
  perform 1
  from public.geographic_scopes scope
  where scope.id = v_scope_id
  for share;
  if not found then
    raise exception 'HP_REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_render_now := pg_catalog.clock_timestamp();
  if p_expires_at <= v_render_now
     or p_expires_at > v_render_now + interval '125 seconds' then
    raise exception 'HP_REVIEW_EVIDENCE_UNAVAILABLE' using errcode = '55000';
  end if;

  select existing.expected_version + 1
  into v_current_version
  from public.review_actions existing
  where existing.candidate_id = p_candidate_id
    and existing.created_at <= v_render_now
  order by existing.expected_version desc, existing.created_at desc, existing.id desc
  limit 1;
  v_current_version := coalesce(v_current_version, 0);
  if p_expected_version is distinct from v_current_version or v_current_version <> 0 then
    raise exception 'HP_REVIEW_VERSION_CONFLICT' using errcode = '40001';
  end if;

  select eligible.*
  into v_candidate
  from public.private_review_candidate_rows_v1(
    p_candidate_id, v_render_now,
    null, null, null, null, null, null, null, null, null, 1
  ) eligible;
  if not found or v_candidate.source_id is distinct from v_source_id then
    raise exception 'HP_REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_expected_crop_reference := 'review-crop:' || pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('v1', 'UTF8') || pg_catalog.decode('00', 'hex')
      || pg_catalog.convert_to(p_candidate_id::text, 'UTF8') || pg_catalog.decode('00', 'hex')
      || pg_catalog.convert_to(v_candidate.capture_checksum, 'UTF8') || pg_catalog.decode('00', 'hex')
      || pg_catalog.convert_to(
        v_candidate.normalized_fields #>> '{candidate,provenance,evidenceLocator}',
        'UTF8'
      )
    ),
    'hex'
  );

  if p_capture_checksum is distinct from v_candidate.capture_checksum
     or p_crop_reference is distinct from v_expected_crop_reference
     or p_rights_classification is distinct from v_candidate.rights_classification
     or v_candidate.rights_classification not in ('private_review', 'public_display')
     or v_candidate.mime_type is null
     or v_candidate.mime_type not in (
       'image/jpeg', 'image/png', 'image/webp'
     )
     or v_candidate.byte_length not between 1 and 52428800 then
    raise exception 'HP_REVIEW_EVIDENCE_UNAVAILABLE' using errcode = '55000';
  end if;

  begin
    insert into public.private_review_evidence_renders (
      candidate_id, expected_version, capture_checksum, crop_reference,
      presentation, rights_classification, mime_type, byte_length,
      actor_id, reviewer_session_id, evidence_proof_sha256,
      rendered_at, expires_at, created_at
    ) values (
      p_candidate_id, p_expected_version, p_capture_checksum, p_crop_reference,
      p_presentation, p_rights_classification, v_candidate.mime_type,
      v_candidate.byte_length, p_actor_id, p_reviewer_session_id,
      p_evidence_proof_sha256, v_render_now, p_expires_at, v_render_now
    ) returning id into v_render_id;
  exception when unique_violation then
    raise exception 'HP_REVIEW_EVIDENCE_UNAVAILABLE' using errcode = '55000';
  end;

  return query select v_render_id, v_render_now, p_expires_at;
end;
$_$;


--
-- Name: public_offer_backed_discovery_rows_v1(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.public_offer_backed_discovery_rows_v1(p_evaluation_as_of timestamp with time zone) RETURNS TABLE(offer_id bigint, source_id text, source_display_name text, source_record_id text, chain text, product_id bigint, amount_ore integer, before_amount_ore integer, multibuy_quantity integer, multibuy_group_amount_ore integer, membership_requirement text, member_program_id text, valid_from timestamp with time zone, valid_until timestamp with time zone, geographic_scope jsonb, channels jsonb, captured_at timestamp with time zone, product_offer_count bigint, total_offer_count bigint, product_is_offer_backed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
declare
  v_database_now timestamptz;
begin
  v_database_now := pg_catalog.clock_timestamp();

  if p_evaluation_as_of is null
     or not pg_catalog.isfinite(p_evaluation_as_of) then
    raise exception using
      errcode = '22023',
      message = 'offer-backed discovery evaluation timestamp is invalid';
  end if;

  -- App and database clocks can differ by a few milliseconds. Accept only a
  -- tiny bounded skew and cap evaluation to the database clock so a caller
  -- can never use that tolerance to expose future state.
  if p_evaluation_as_of > v_database_now + interval '5 seconds' then
    raise exception using
      errcode = '22007',
      message = 'offer-backed discovery evaluation clock cannot be in the future';
  end if;
  p_evaluation_as_of := least(p_evaluation_as_of, v_database_now);

  return query
  with eligible as materialized (
    select
      offer.id as offer_id,
      source.id::text as source_id,
      source.display_name::text as source_display_name,
      ('official-source-record:' || pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(offer.source_reference, 'UTF8')),
        'hex'
      ))::text as source_record_id,
      offer.chain::text as chain,
      target.product_id,
      offer.amount_ore,
      offer.before_amount_ore,
      offer.multibuy_quantity,
      offer.multibuy_group_amount_ore,
      offer.membership_requirement::text as membership_requirement,
      review.new_values #>> '{decision,eligibility,programId}' as member_program_id,
      offer.valid_from,
      offer.valid_until,
      publication.declared_geographic_scope as geographic_scope,
      review.new_values #> '{decision,channels}' as channels,
      capture.retrieved_at as captured_at
    from public.offer_targets target
    inner join public.approved_offers offer on offer.id = target.offer_id
    inner join public.canonical_products product on product.id = target.product_id
    inner join public.extracted_offer_candidates candidate on candidate.id = offer.candidate_id
    inner join public.extraction_runs extraction on extraction.id = candidate.extraction_run_id
    inner join public.publication_captures capture on capture.id = extraction.capture_id
    inner join public.publications publication on publication.id = capture.publication_id
    inner join public.data_sources source on source.id = offer.source_id
    inner join public.geographic_scopes scope on scope.id = offer.geographic_scope_id
    inner join lateral (
      select current_review.*
      from public.review_actions current_review
      where current_review.candidate_id = candidate.id
        and current_review.created_at <= v_database_now
      -- Current means database persistence recency. A later malformed or
      -- lower-version terminal action must shadow an older approval; future
      -- multi-version review must enforce monotonic sequence at write time.
      order by current_review.created_at desc,
               current_review.id desc,
               current_review.expected_version desc
      limit 1
    ) review on true
    where offer.status = 'published'
      and offer.valid_from <= p_evaluation_as_of
      and offer.valid_until > p_evaluation_as_of
      and offer.created_at <= p_evaluation_as_of
      and offer.approved_at <= p_evaluation_as_of
      and offer.updated_at <= p_evaluation_as_of
      and target.created_at <= p_evaluation_as_of
      and product.status = 'active'
      and product.created_at <= p_evaluation_as_of
      and product.public_state_changed_at <= p_evaluation_as_of
      and candidate.created_at <= p_evaluation_as_of
      and candidate.status = 'pending'
      and candidate.normalized_fields ->> 'contractVersion' = '1'
      and candidate.normalized_fields ->> 'publicationRoute' = 'human-review-required'
      and candidate.normalized_fields ->> 'disposition' in (
        'exact-match', 'review-required'
      )
      and pg_catalog.jsonb_typeof(candidate.normalized_fields -> 'candidate') = 'object'
      and candidate.normalized_fields #>> '{candidate,contractVersion}' = '1'
      and candidate.normalized_fields #>> '{candidate,candidateKey}' = candidate.candidate_key
      and candidate.normalized_fields #> '{candidate,anomalyCodes}' = candidate.anomaly_codes
      and candidate.normalized_fields -> 'anomalyCodes' = candidate.anomaly_codes
      and candidate.normalized_fields #> '{candidate,provenance,confidence}'
        = pg_catalog.to_jsonb(candidate.confidence)
      and candidate.normalized_fields #>> '{candidate,provenance,method}'
        = extraction.extraction_method
      and candidate.normalized_fields #> '{candidate,geographicScope}'
        = publication.declared_geographic_scope
      and extraction.created_at <= p_evaluation_as_of
      and extraction.started_at <= p_evaluation_as_of
      and extraction.status in ('completed', 'degraded')
      and extraction.completed_at is not null
      and extraction.completed_at <= p_evaluation_as_of
      and extraction.source_started_at is not null
      and extraction.source_started_at <= p_evaluation_as_of
      and extraction.source_completed_at is not null
      and extraction.source_completed_at <= p_evaluation_as_of
      and extraction.empty_result = 'not-empty'
      and extraction.extraction_method is not null
      and extraction.extraction_permission_id is not null
      and extraction.permission_capabilities in (
        '["capture", "discover", "extract"]'::jsonb,
        '["capture", "discover", "extract", "ocr"]'::jsonb
      )
      and (extraction.extraction_method <> 'ocr' or extraction.ocr_permission_id is not null)
      and capture.created_at <= p_evaluation_as_of
      and capture.retrieved_at <= p_evaluation_as_of
      and capture.retrieved_at >= p_evaluation_as_of - interval '14 days'
      and capture.capture_permission_id is not null
      and capture.capture_permission_capabilities in (
        '["capture", "discover", "extract"]'::jsonb,
        '["capture", "discover", "extract", "ocr"]'::jsonb
      )
      and capture.rights_classification = 'public_display'
      and publication.created_at <= p_evaluation_as_of
      and publication.discovered_at <= p_evaluation_as_of
      and publication.source_id = offer.source_id
      and publication.chain = offer.chain
      and publication.geographic_scope_id = offer.geographic_scope_id
      and publication.valid_from <= offer.valid_from
      and publication.valid_until >= offer.valid_until
      and publication.content_kind is not null
      and publication.declared_geographic_scope is not null
      and publication.edition_identity_sha256 is not null
      and publication.discovery_permission_id is not null
      and pg_catalog.btrim(publication.edition_identity_sha256) = pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          public.canonical_official_offer_edition_identity(
            publication.source_id,
            publication.external_id,
            publication.chain,
            publication.title,
            publication.content_kind,
            publication.geographic_scope_id,
            publication.declared_geographic_scope,
            publication.valid_from,
            publication.valid_until,
            publication.discovered_at
          ),
          'UTF8'
        )),
        'hex'
      )
      and source.source_kind = 'offer'
      and source.runtime_state = 'approved'
      and source.created_at <= p_evaluation_as_of
      and source.public_state_changed_at <= p_evaluation_as_of
      and source.permission_reviewed_at is not null
      and source.permission_reviewed_at <= p_evaluation_as_of
      and (source.permission_expires_at is null
        or source.permission_expires_at > p_evaluation_as_of)
      and scope.status = 'active'
      and scope.created_at <= p_evaluation_as_of
      and scope.public_state_changed_at <= p_evaluation_as_of
      and review.candidate_id = candidate.id
      and review.offer_id = offer.id
      and review.action in ('approve', 'correct_and_approve')
      and review.decision_boundary_version = 2
      and offer.version = 1
      and review.expected_version = 0
      and review.expected_version = offer.version - 1
      and review.created_at <= p_evaluation_as_of
      and review.acted_at <= p_evaluation_as_of
      and review.acted_at <= review.created_at
      and review.actor_id ~ '^access:[0-9a-f]{64}$'
      and review.reason = pg_catalog.btrim(review.reason)
      and pg_catalog.char_length(review.reason) between 1 and 1000
      and pg_catalog.octet_length(review.reason) <= 4000
      and review.previous_values = pg_catalog.jsonb_build_object(
        'candidateSha256', pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            candidate.normalized_fields::text,
            'UTF8'
          )),
          'hex'
        ),
        'contractVersion', 1,
        'reviewVersion', review.expected_version
      )
      -- 021 persists state at the top level and the typed public decision
      -- payload beneath "decision".
      and review.new_values ->> 'state' = 'approved'
      and review.new_values ->> 'contractVersion' = '1'
      and review.new_values ->> 'reviewVersion' = '1'
      and review.new_values ->> 'decisionSha256' = pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          (review.new_values -> 'decision')::text,
          'UTF8'
        )),
        'hex'
      )
      and review.new_values = pg_catalog.jsonb_build_object(
        'contractVersion', 1,
        'decision', review.new_values -> 'decision',
        'decisionSha256', review.new_values ->> 'decisionSha256',
        'reviewVersion', 1,
        'state', 'approved'
      )
      and offer.offer_key = 'official-review:' || candidate.id::text || ':'
        || (review.new_values ->> 'decisionSha256')
      and offer.source_reference = 'review-candidate:' || candidate.id::text || ':v1'
      and offer.approved_at = review.acted_at
      -- approved_offers.created_at uses the transaction-start clock while
      -- approved_at is the review decision's wall clock. A legitimate row is
      -- therefore created no later than the decision it records.
      and offer.created_at <= offer.approved_at
      and offer.created_at <= target.created_at
      and target.created_at <= review.created_at
      and (
        (review.action = 'approve'
          and target.match_method = 'exact_identifier'
          and target.match_confidence = candidate.confidence)
        or
        (review.action = 'correct_and_approve'
          and target.match_method = 'human_review'
          and target.match_confidence = 100)
      )
      -- An extraction-time exact match must remain bound to that same product.
      -- A review-required candidate may be corrected after rendered evidence;
      -- an unchanged approval still needs the exact resolver binding.
      and (
        candidate.normalized_fields ->> 'disposition' = 'review-required'
        or candidate.normalized_fields ->> 'exactCanonicalProductId'
          = 'product:' || target.product_id::text
        or candidate.normalized_fields #> '{candidate,exactCanonicalProductId}'
          = pg_catalog.to_jsonb('product:' || target.product_id::text)
      )
      and (
        review.action = 'correct_and_approve'
        or candidate.normalized_fields ->> 'exactCanonicalProductId'
          = 'product:' || target.product_id::text
        or candidate.normalized_fields #> '{candidate,exactCanonicalProductId}'
          = pg_catalog.to_jsonb('product:' || target.product_id::text)
      )
      and (
        review.action = 'correct_and_approve'
        or (
          review.action = 'approve'
          and candidate.normalized_fields #>> '{candidate,product,kind}' = 'exact-identifier'
          and candidate.normalized_fields #>> '{candidate,product,scheme}' = 'gtin'
          and candidate.normalized_fields #>> '{candidate,validity,state}' = 'parsed'
          and review.new_values -> 'decision' = pg_catalog.jsonb_build_object(
            'channels', candidate.normalized_fields #> '{candidate,channels}',
            'eligibility', candidate.normalized_fields #> '{candidate,eligibility}',
            'pricing', candidate.normalized_fields #> '{candidate,pricing}',
            'target', pg_catalog.jsonb_build_object(
              'kind', 'exact-product',
              'gtin', candidate.normalized_fields #>> '{candidate,product,value}'
            ),
            'validity', pg_catalog.jsonb_build_object(
              'startsAt', candidate.normalized_fields #>> '{candidate,validity,startsAt}',
              'endsAt', candidate.normalized_fields #>> '{candidate,validity,endsAt}'
            )
          )
        )
      )
      and review.new_values #>> '{decision,target,kind}' = 'exact-product'
      and exists (
        select 1
        from public.product_identifiers identifier
        where identifier.product_id = target.product_id
          and identifier.value = review.new_values #>> '{decision,target,gtin}'
          and identifier.scheme = case pg_catalog.char_length(identifier.value)
            when 8 then 'ean8' else 'ean13'
          end
          and identifier.value ~ '^(?:[0-9]{8}|[0-9]{13})$'
          and identifier.confidence = 100
          and identifier.verified_at is not null
          and identifier.verified_at <= p_evaluation_as_of
          and identifier.created_at <= p_evaluation_as_of
          and identifier.public_state_changed_at <= p_evaluation_as_of
      )
      and review.new_values #>> '{decision,validity,startsAt}'
        = pg_catalog.to_char(
          offer.valid_from at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      and review.new_values #>> '{decision,validity,endsAt}'
        = pg_catalog.to_char(
          offer.valid_until at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      and review.new_values #> '{decision,channels}' in (
        '["in-store"]'::jsonb,
        '["online"]'::jsonb,
        '["in-store", "online"]'::jsonb,
        '["online", "in-store"]'::jsonb
      )
      and (
        (
          offer.membership_requirement = 'public'
          and review.new_values #>> '{decision,eligibility,kind}' = 'public'
          and review.new_values #>> '{decision,eligibility,programId}' is null
        )
        or
        (
          offer.membership_requirement = 'member'
          and review.new_values #>> '{decision,eligibility,kind}' = 'member'
          and public.is_canonical_membership_program_id_v1(
            review.new_values #>> '{decision,eligibility,programId}'
          ) is true
        )
      )
      and (
        (
          review.new_values #>> '{decision,pricing,kind}' = 'unit'
          and review.new_values #> '{decision,pricing,offerPriceOre}'
            = pg_catalog.to_jsonb(offer.amount_ore)
          and (
            (offer.before_amount_ore is null
              and pg_catalog.jsonb_typeof(
                review.new_values #> '{decision,pricing,beforePriceOre}'
              ) = 'null')
            or (offer.before_amount_ore is not null
              and review.new_values #> '{decision,pricing,beforePriceOre}'
                = pg_catalog.to_jsonb(offer.before_amount_ore))
          )
          and offer.multibuy_quantity is null
          and offer.multibuy_group_amount_ore is null
        )
        or
        (
          review.new_values #>> '{decision,pricing,kind}' = 'multibuy'
          and offer.multibuy_quantity between 2 and 100
          and review.new_values #> '{decision,pricing,quantity}'
            = pg_catalog.to_jsonb(offer.multibuy_quantity)
          and review.new_values #> '{decision,pricing,totalOre}'
            = pg_catalog.to_jsonb(offer.multibuy_group_amount_ore)
          and (
            (offer.before_amount_ore is null
              and pg_catalog.jsonb_typeof(
                review.new_values #> '{decision,pricing,beforeUnitPriceOre}'
              ) = 'null')
            or (offer.before_amount_ore is not null
              and review.new_values #> '{decision,pricing,beforeUnitPriceOre}'
                = pg_catalog.to_jsonb(offer.before_amount_ore))
          )
          and offer.amount_ore = (
            (offer.multibuy_group_amount_ore::bigint
              + offer.multibuy_quantity::bigint - 1)
            / offer.multibuy_quantity::bigint
          )::integer
          and (
            offer.before_amount_ore is null
            or (
              offer.before_amount_ore::bigint * offer.multibuy_quantity::bigint
                between offer.multibuy_group_amount_ore::bigint
                  and 9007199254740991::bigint
            )
          )
        )
      )
      -- The discovery contract mirrors the projection contract: every
      -- condition_row must be accounted for, and opaque, duplicate, or
      -- mismatched conditions make the offer ineligible.
      and (
        select pg_catalog.count(*)
        from public.offer_conditions condition_row
        where condition_row.offer_id = offer.id
          and condition_row.created_at <= p_evaluation_as_of
      ) = 1
        + case when offer.membership_requirement = 'member' then 1 else 0 end
        + case when offer.multibuy_quantity is not null then 1 else 0 end
      and exists (
        select 1
        from public.offer_conditions condition_row
        where condition_row.offer_id = offer.id
          and condition_row.created_at <= p_evaluation_as_of
          and condition_row.created_at >= offer.created_at
          and condition_row.created_at <= review.created_at
          and condition_row.condition_type = 'channel'
          and condition_row.condition_value = pg_catalog.jsonb_build_object(
            'channels', review.new_values #> '{decision,channels}'
          )
      )
      and (
        (
          offer.membership_requirement = 'public'
          and not exists (
            select 1 from public.offer_conditions condition_row
            where condition_row.offer_id = offer.id
              and condition_row.created_at <= p_evaluation_as_of
              and condition_row.condition_type = 'membership'
          )
        )
        or exists (
          select 1 from public.offer_conditions condition_row
          where condition_row.offer_id = offer.id
            and condition_row.created_at <= p_evaluation_as_of
            and condition_row.created_at >= offer.created_at
            and condition_row.created_at <= review.created_at
            and condition_row.condition_type = 'membership'
            and condition_row.condition_value = pg_catalog.jsonb_build_object(
              'programId',
              review.new_values #>> '{decision,eligibility,programId}'
            )
        )
      )
      and (
        (
          offer.multibuy_quantity is null
          and not exists (
            select 1 from public.offer_conditions condition_row
            where condition_row.offer_id = offer.id
              and condition_row.created_at <= p_evaluation_as_of
              and condition_row.condition_type = 'quantity'
          )
        )
        or exists (
          select 1 from public.offer_conditions condition_row
          where condition_row.offer_id = offer.id
            and condition_row.created_at <= p_evaluation_as_of
            and condition_row.created_at >= offer.created_at
            and condition_row.created_at <= review.created_at
            and condition_row.condition_type = 'quantity'
            and condition_row.condition_value = pg_catalog.jsonb_build_object(
              'quantity', offer.multibuy_quantity
            )
        )
      )
      and exists (
        select 1
        from public.source_permissions permission
        where permission.id = (
          select current_permission.id
          from public.source_permissions current_permission
          where current_permission.source_id = offer.source_id
            and current_permission.created_at <= v_database_now
          order by current_permission.created_at desc, current_permission.id desc
          limit 1
        )
          and permission.decision = 'approved'
          and permission.created_at <= p_evaluation_as_of
          and permission.reviewed_at <= p_evaluation_as_of
          and (permission.valid_until is null
            or permission.valid_until > p_evaluation_as_of)
          and (permission.valid_until is null
            or permission.valid_until > v_database_now)
          and source.permission_reviewed_at = permission.reviewed_at
          and source.permission_expires_at is not distinct from permission.valid_until
          and permission.permissions @> '{"officialOffers": true, "publicDisplay": true}'::jsonb
          and permission.permissions -> 'officialOfferCapabilities' in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications' in (
            '["public_display"]'::jsonb,
            '["extract_only", "public_display"]'::jsonb,
            '["private_review", "public_display"]'::jsonb,
            '["extract_only", "private_review", "public_display"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications'
            ? capture.rights_classification
          -- A later re-approval cannot launder evidence captured under a
          -- different permission. Every pointer and capability snapshot must
          -- still bind to the one current permission selected above.
          and publication.discovery_permission_id = permission.id
          and capture.capture_permission_id = permission.id
          and capture.capture_permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and extraction.extraction_permission_id = permission.id
          and extraction.permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and (
            (extraction.extraction_method = 'ocr'
              and extraction.ocr_permission_id = permission.id
              and permission.permissions -> 'officialOfferCapabilities' ? 'ocr')
            or
            (extraction.extraction_method <> 'ocr'
              and extraction.ocr_permission_id is null)
          )
      )
  ),
  ranked as (
    select
      eligible.*,
      pg_catalog.row_number() over (
        partition by eligible.product_id
        order by eligible.valid_until, eligible.offer_id
      ) as product_rank
    from eligible
  ),
  per_product_bounded as materialized (
    select ranked.*
    from ranked
    where ranked.product_rank <= 51
  ),
  globally_bounded as materialized (
    select per_product_bounded.*
    from per_product_bounded
    order by per_product_bounded.product_id,
             per_product_bounded.valid_until,
             per_product_bounded.offer_id
    limit 500
  ),
  counted as (
    select
      globally_bounded.*,
      pg_catalog.count(*) over (
        partition by globally_bounded.product_id
      ) as product_offer_count,
      pg_catalog.count(*) over () as total_offer_count
    from globally_bounded
  )
  select
    counted.offer_id,
    counted.source_id,
    counted.source_display_name,
    counted.source_record_id,
    counted.chain,
    counted.product_id,
    counted.amount_ore,
    counted.before_amount_ore,
    counted.multibuy_quantity,
    counted.multibuy_group_amount_ore,
    counted.membership_requirement,
    counted.member_program_id,
    counted.valid_from,
    counted.valid_until,
    counted.geographic_scope,
    counted.channels,
    counted.captured_at,
    counted.product_offer_count,
    counted.total_offer_count,
    true as product_is_offer_backed
  from counted
  order by counted.product_id,
           counted.valid_until,
           counted.offer_id;
end;
$_$;


--
-- Name: public_official_offer_rows_v1(bigint[], timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.public_official_offer_rows_v1(p_product_ids bigint[], p_evaluation_as_of timestamp with time zone) RETURNS TABLE(offer_id bigint, source_id text, source_display_name text, source_record_id text, chain text, product_id bigint, amount_ore integer, before_amount_ore integer, multibuy_quantity integer, multibuy_group_amount_ore integer, membership_requirement text, member_program_id text, valid_from timestamp with time zone, valid_until timestamp with time zone, geographic_scope jsonb, channels jsonb, captured_at timestamp with time zone, product_offer_count bigint, total_offer_count bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
declare
  v_database_now timestamptz;
  v_distinct_product_count integer;
  v_evaluation_as_of timestamptz;
  v_product_count integer;
begin
  v_product_count := pg_catalog.cardinality(p_product_ids);
  if p_product_ids is null
     or pg_catalog.array_ndims(p_product_ids) is distinct from 1
     or v_product_count not between 1 and 50
     or p_evaluation_as_of is null
     or not pg_catalog.isfinite(p_evaluation_as_of) then
    raise exception using
      errcode = '22023',
      message = 'public official-offer request is invalid';
  end if;

  select pg_catalog.count(distinct requested.product_id)::integer
  into strict v_distinct_product_count
  from pg_catalog.unnest(p_product_ids) as requested(product_id)
  where requested.product_id is not null
    and requested.product_id between 1 and 9007199254740991;

  if v_distinct_product_count is distinct from v_product_count then
    raise exception using
      errcode = '22023',
      message = 'public official-offer product IDs must be unique safe positive integers';
  end if;

  v_database_now := pg_catalog.clock_timestamp();
  -- App and database clocks can differ by a few milliseconds. Accept only a
  -- tiny bounded skew and cap evaluation to the database clock so a caller can
  -- never use that tolerance to expose future state.
  if p_evaluation_as_of > v_database_now + interval '5 seconds' then
    raise exception using
      errcode = '22007',
      message = 'public official-offer evaluation clock cannot be in the future';
  end if;
  v_evaluation_as_of := least(p_evaluation_as_of, v_database_now);

  return query
  with requested(product_id) as materialized (
    select requested_id
    from pg_catalog.unnest(p_product_ids) as input(requested_id)
  ),
  eligible as materialized (
    select
      offer.id as offer_id,
      source.id::text as source_id,
      source.display_name::text as source_display_name,
      ('official-source-record:' || pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(offer.source_reference, 'UTF8')),
        'hex'
      ))::text as source_record_id,
      offer.chain::text as chain,
      target.product_id,
      offer.amount_ore,
      offer.before_amount_ore,
      offer.multibuy_quantity,
      offer.multibuy_group_amount_ore,
      offer.membership_requirement::text as membership_requirement,
      review.new_values #>> '{decision,eligibility,programId}' as member_program_id,
      offer.valid_from,
      offer.valid_until,
      publication.declared_geographic_scope as geographic_scope,
      review.new_values #> '{decision,channels}' as channels,
      capture.retrieved_at as captured_at
    from requested
    inner join public.offer_targets target
      on target.product_id = requested.product_id
     and target.family_slug is null
    inner join public.approved_offers offer on offer.id = target.offer_id
    inner join public.canonical_products product on product.id = target.product_id
    inner join public.extracted_offer_candidates candidate on candidate.id = offer.candidate_id
    inner join public.extraction_runs extraction on extraction.id = candidate.extraction_run_id
    inner join public.publication_captures capture on capture.id = extraction.capture_id
    inner join public.publications publication on publication.id = capture.publication_id
    inner join public.data_sources source on source.id = offer.source_id
    inner join public.geographic_scopes scope on scope.id = offer.geographic_scope_id
    inner join lateral (
      select current_review.*
      from public.review_actions current_review
      where current_review.candidate_id = candidate.id
        and current_review.created_at <= v_database_now
      -- Current means database persistence recency. A later malformed or
      -- lower-version terminal action must shadow an older approval; future
      -- multi-version review must enforce monotonic sequence at write time.
      order by current_review.created_at desc,
               current_review.id desc,
               current_review.expected_version desc
      limit 1
    ) review on true
    where offer.status = 'published'
      and offer.valid_from <= v_evaluation_as_of
      and offer.valid_until > v_evaluation_as_of
      and offer.created_at <= v_evaluation_as_of
      and offer.approved_at <= v_evaluation_as_of
      and offer.updated_at <= v_evaluation_as_of
      and target.created_at <= v_evaluation_as_of
      and product.status = 'active'
      and product.created_at <= v_evaluation_as_of
      and product.public_state_changed_at <= v_evaluation_as_of
      and candidate.created_at <= v_evaluation_as_of
      and candidate.status = 'pending'
      and candidate.normalized_fields ->> 'contractVersion' = '1'
      and candidate.normalized_fields ->> 'publicationRoute' = 'human-review-required'
      and candidate.normalized_fields ->> 'disposition' in (
        'exact-match', 'review-required'
      )
      and pg_catalog.jsonb_typeof(candidate.normalized_fields -> 'candidate') = 'object'
      and candidate.normalized_fields #>> '{candidate,contractVersion}' = '1'
      and candidate.normalized_fields #>> '{candidate,candidateKey}' = candidate.candidate_key
      and candidate.normalized_fields #> '{candidate,anomalyCodes}' = candidate.anomaly_codes
      and candidate.normalized_fields -> 'anomalyCodes' = candidate.anomaly_codes
      and candidate.normalized_fields #> '{candidate,provenance,confidence}'
        = pg_catalog.to_jsonb(candidate.confidence)
      and candidate.normalized_fields #>> '{candidate,provenance,method}'
        = extraction.extraction_method
      and candidate.normalized_fields #> '{candidate,geographicScope}'
        = publication.declared_geographic_scope
      and extraction.created_at <= v_evaluation_as_of
      and extraction.started_at <= v_evaluation_as_of
      and extraction.status in ('completed', 'degraded')
      and extraction.completed_at is not null
      and extraction.completed_at <= v_evaluation_as_of
      and extraction.source_started_at is not null
      and extraction.source_started_at <= v_evaluation_as_of
      and extraction.source_completed_at is not null
      and extraction.source_completed_at <= v_evaluation_as_of
      and extraction.empty_result = 'not-empty'
      and extraction.extraction_method is not null
      and extraction.extraction_permission_id is not null
      and extraction.permission_capabilities in (
        '["capture", "discover", "extract"]'::jsonb,
        '["capture", "discover", "extract", "ocr"]'::jsonb
      )
      and (extraction.extraction_method <> 'ocr' or extraction.ocr_permission_id is not null)
      and capture.created_at <= v_evaluation_as_of
      and capture.retrieved_at <= v_evaluation_as_of
      and capture.retrieved_at >= v_evaluation_as_of - interval '14 days'
      and capture.capture_permission_id is not null
      and capture.capture_permission_capabilities in (
        '["capture", "discover", "extract"]'::jsonb,
        '["capture", "discover", "extract", "ocr"]'::jsonb
      )
      and capture.rights_classification = 'public_display'
      and publication.created_at <= v_evaluation_as_of
      and publication.discovered_at <= v_evaluation_as_of
      and publication.source_id = offer.source_id
      and publication.chain = offer.chain
      and publication.geographic_scope_id = offer.geographic_scope_id
      and publication.valid_from <= offer.valid_from
      and publication.valid_until >= offer.valid_until
      and publication.content_kind is not null
      and publication.declared_geographic_scope is not null
      and publication.edition_identity_sha256 is not null
      and publication.discovery_permission_id is not null
      and pg_catalog.btrim(publication.edition_identity_sha256) = pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          public.canonical_official_offer_edition_identity(
            publication.source_id,
            publication.external_id,
            publication.chain,
            publication.title,
            publication.content_kind,
            publication.geographic_scope_id,
            publication.declared_geographic_scope,
            publication.valid_from,
            publication.valid_until,
            publication.discovered_at
          ),
          'UTF8'
        )),
        'hex'
      )
      and source.source_kind = 'offer'
      and source.runtime_state = 'approved'
      and source.created_at <= v_evaluation_as_of
      and source.public_state_changed_at <= v_evaluation_as_of
      and source.permission_reviewed_at is not null
      and source.permission_reviewed_at <= v_evaluation_as_of
      and (source.permission_expires_at is null
        or source.permission_expires_at > v_evaluation_as_of)
      and scope.status = 'active'
      and scope.created_at <= v_evaluation_as_of
      and scope.public_state_changed_at <= v_evaluation_as_of
      and review.candidate_id = candidate.id
      and review.offer_id = offer.id
      and review.action in ('approve', 'correct_and_approve')
      and review.decision_boundary_version = 2
      and offer.version = 1
      and review.expected_version = 0
      and review.expected_version = offer.version - 1
      and review.created_at <= v_evaluation_as_of
      and review.acted_at <= v_evaluation_as_of
      and review.acted_at <= review.created_at
      and review.actor_id ~ '^access:[0-9a-f]{64}$'
      and review.reason = pg_catalog.btrim(review.reason)
      and pg_catalog.char_length(review.reason) between 1 and 1000
      and pg_catalog.octet_length(review.reason) <= 4000
      and review.previous_values = pg_catalog.jsonb_build_object(
        'candidateSha256', pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            candidate.normalized_fields::text,
            'UTF8'
          )),
          'hex'
        ),
        'contractVersion', 1,
        'reviewVersion', review.expected_version
      )
      -- 021 persists state at the top level and the typed public decision
      -- payload beneath `decision`.
      and review.new_values ->> 'state' = 'approved'
      and review.new_values ->> 'contractVersion' = '1'
      and review.new_values ->> 'reviewVersion' = '1'
      and review.new_values ->> 'decisionSha256' = pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          (review.new_values -> 'decision')::text,
          'UTF8'
        )),
        'hex'
      )
      and review.new_values = pg_catalog.jsonb_build_object(
        'contractVersion', 1,
        'decision', review.new_values -> 'decision',
        'decisionSha256', review.new_values ->> 'decisionSha256',
        'reviewVersion', 1,
        'state', 'approved'
      )
      and offer.offer_key = 'official-review:' || candidate.id::text || ':'
        || (review.new_values ->> 'decisionSha256')
      and offer.source_reference = 'review-candidate:' || candidate.id::text || ':v1'
      and offer.approved_at = review.acted_at
      -- approved_offers.created_at uses the transaction-start clock while
      -- approved_at is the review decision's wall clock. A legitimate row is
      -- therefore created no later than the decision it records.
      and offer.created_at <= offer.approved_at
      and offer.created_at <= target.created_at
      and target.created_at <= review.created_at
      and (
        (review.action = 'approve'
          and target.match_method = 'exact_identifier'
          and target.match_confidence = candidate.confidence)
        or
        (review.action = 'correct_and_approve'
          and target.match_method = 'human_review'
          and target.match_confidence = 100)
      )
      -- An extraction-time exact match must remain bound to that same product.
      -- A review-required candidate may be corrected after rendered evidence;
      -- an unchanged approval still needs the exact resolver binding.
      and (
        candidate.normalized_fields ->> 'disposition' = 'review-required'
        or candidate.normalized_fields ->> 'exactCanonicalProductId'
          = 'product:' || target.product_id::text
        or candidate.normalized_fields #> '{candidate,exactCanonicalProductId}'
          = pg_catalog.to_jsonb('product:' || target.product_id::text)
      )
      and (
        review.action = 'correct_and_approve'
        or candidate.normalized_fields ->> 'exactCanonicalProductId'
          = 'product:' || target.product_id::text
        or candidate.normalized_fields #> '{candidate,exactCanonicalProductId}'
          = pg_catalog.to_jsonb('product:' || target.product_id::text)
      )
      and (
        review.action = 'correct_and_approve'
        or (
          review.action = 'approve'
          and candidate.normalized_fields #>> '{candidate,product,kind}' = 'exact-identifier'
          and candidate.normalized_fields #>> '{candidate,product,scheme}' = 'gtin'
          and candidate.normalized_fields #>> '{candidate,validity,state}' = 'parsed'
          and review.new_values -> 'decision' = pg_catalog.jsonb_build_object(
            'channels', candidate.normalized_fields #> '{candidate,channels}',
            'eligibility', candidate.normalized_fields #> '{candidate,eligibility}',
            'pricing', candidate.normalized_fields #> '{candidate,pricing}',
            'target', pg_catalog.jsonb_build_object(
              'kind', 'exact-product',
              'gtin', candidate.normalized_fields #>> '{candidate,product,value}'
            ),
            'validity', pg_catalog.jsonb_build_object(
              'startsAt', candidate.normalized_fields #>> '{candidate,validity,startsAt}',
              'endsAt', candidate.normalized_fields #>> '{candidate,validity,endsAt}'
            )
          )
        )
      )
      and review.new_values #>> '{decision,target,kind}' = 'exact-product'
      and exists (
        select 1
        from public.product_identifiers identifier
        where identifier.product_id = target.product_id
          and identifier.value = review.new_values #>> '{decision,target,gtin}'
          and identifier.scheme = case pg_catalog.char_length(identifier.value)
            when 8 then 'ean8' else 'ean13'
          end
          and identifier.value ~ '^(?:[0-9]{8}|[0-9]{13})$'
          and identifier.confidence = 100
          and identifier.verified_at is not null
          and identifier.verified_at <= v_evaluation_as_of
          and identifier.created_at <= v_evaluation_as_of
          and identifier.public_state_changed_at <= v_evaluation_as_of
      )
      and review.new_values #>> '{decision,validity,startsAt}'
        = pg_catalog.to_char(
          offer.valid_from at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      and review.new_values #>> '{decision,validity,endsAt}'
        = pg_catalog.to_char(
          offer.valid_until at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      and review.new_values #> '{decision,channels}' in (
        '["in-store"]'::jsonb,
        '["online"]'::jsonb,
        '["in-store", "online"]'::jsonb,
        '["online", "in-store"]'::jsonb
      )
      and (
        (
          offer.membership_requirement = 'public'
          and review.new_values #>> '{decision,eligibility,kind}' = 'public'
          and review.new_values #>> '{decision,eligibility,programId}' is null
        )
        or
        (
          offer.membership_requirement = 'member'
          and review.new_values #>> '{decision,eligibility,kind}' = 'member'
          and public.is_canonical_membership_program_id_v1(
            review.new_values #>> '{decision,eligibility,programId}'
          ) is true
        )
      )
      and (
        (
          review.new_values #>> '{decision,pricing,kind}' = 'unit'
          and review.new_values #> '{decision,pricing,offerPriceOre}'
            = pg_catalog.to_jsonb(offer.amount_ore)
          and (
            (offer.before_amount_ore is null
              and pg_catalog.jsonb_typeof(
                review.new_values #> '{decision,pricing,beforePriceOre}'
              ) = 'null')
            or (offer.before_amount_ore is not null
              and review.new_values #> '{decision,pricing,beforePriceOre}'
                = pg_catalog.to_jsonb(offer.before_amount_ore))
          )
          and offer.multibuy_quantity is null
          and offer.multibuy_group_amount_ore is null
        )
        or
        (
          review.new_values #>> '{decision,pricing,kind}' = 'multibuy'
          and offer.multibuy_quantity between 2 and 100
          and review.new_values #> '{decision,pricing,quantity}'
            = pg_catalog.to_jsonb(offer.multibuy_quantity)
          and review.new_values #> '{decision,pricing,totalOre}'
            = pg_catalog.to_jsonb(offer.multibuy_group_amount_ore)
          and (
            (offer.before_amount_ore is null
              and pg_catalog.jsonb_typeof(
                review.new_values #> '{decision,pricing,beforeUnitPriceOre}'
              ) = 'null')
            or (offer.before_amount_ore is not null
              and review.new_values #> '{decision,pricing,beforeUnitPriceOre}'
                = pg_catalog.to_jsonb(offer.before_amount_ore))
          )
          and offer.amount_ore = (
            (offer.multibuy_group_amount_ore::bigint
              + offer.multibuy_quantity::bigint - 1)
            / offer.multibuy_quantity::bigint
          )::integer
          and (
            offer.before_amount_ore is null
            or (
              offer.before_amount_ore::bigint * offer.multibuy_quantity::bigint
                between offer.multibuy_group_amount_ore::bigint
                  and 9007199254740991::bigint
            )
          )
        )
      )
      -- The public contract projects every condition_row. Any opaque, duplicate,
      -- or mismatched condition therefore makes the offer ineligible.
      and (
        select pg_catalog.count(*)
        from public.offer_conditions condition_row
        where condition_row.offer_id = offer.id
          and condition_row.created_at <= v_evaluation_as_of
      ) = 1
        + case when offer.membership_requirement = 'member' then 1 else 0 end
        + case when offer.multibuy_quantity is not null then 1 else 0 end
      and exists (
        select 1
        from public.offer_conditions condition_row
        where condition_row.offer_id = offer.id
          and condition_row.created_at <= v_evaluation_as_of
          and condition_row.created_at >= offer.created_at
          and condition_row.created_at <= review.created_at
          and condition_row.condition_type = 'channel'
          and condition_row.condition_value = pg_catalog.jsonb_build_object(
            'channels', review.new_values #> '{decision,channels}'
          )
      )
      and (
        (
          offer.membership_requirement = 'public'
          and not exists (
            select 1 from public.offer_conditions condition_row
            where condition_row.offer_id = offer.id
              and condition_row.created_at <= v_evaluation_as_of
              and condition_row.condition_type = 'membership'
          )
        )
        or exists (
          select 1 from public.offer_conditions condition_row
          where condition_row.offer_id = offer.id
            and condition_row.created_at <= v_evaluation_as_of
            and condition_row.created_at >= offer.created_at
            and condition_row.created_at <= review.created_at
            and condition_row.condition_type = 'membership'
            and condition_row.condition_value = pg_catalog.jsonb_build_object(
              'programId',
              review.new_values #>> '{decision,eligibility,programId}'
            )
        )
      )
      and (
        (
          offer.multibuy_quantity is null
          and not exists (
            select 1 from public.offer_conditions condition_row
            where condition_row.offer_id = offer.id
              and condition_row.created_at <= v_evaluation_as_of
              and condition_row.condition_type = 'quantity'
          )
        )
        or exists (
          select 1 from public.offer_conditions condition_row
          where condition_row.offer_id = offer.id
            and condition_row.created_at <= v_evaluation_as_of
            and condition_row.created_at >= offer.created_at
            and condition_row.created_at <= review.created_at
            and condition_row.condition_type = 'quantity'
            and condition_row.condition_value = pg_catalog.jsonb_build_object(
              'quantity', offer.multibuy_quantity
            )
        )
      )
      and exists (
        select 1
        from public.source_permissions permission
        where permission.id = (
          select current_permission.id
          from public.source_permissions current_permission
          where current_permission.source_id = offer.source_id
            and current_permission.created_at <= v_database_now
          order by current_permission.created_at desc, current_permission.id desc
          limit 1
        )
          and permission.decision = 'approved'
          and permission.created_at <= v_evaluation_as_of
          and permission.reviewed_at <= v_evaluation_as_of
          and (permission.valid_until is null
            or permission.valid_until > v_evaluation_as_of)
          and (permission.valid_until is null
            or permission.valid_until > v_database_now)
          and source.permission_reviewed_at = permission.reviewed_at
          and source.permission_expires_at is not distinct from permission.valid_until
          and permission.permissions @> '{"officialOffers": true, "publicDisplay": true}'::jsonb
          and permission.permissions -> 'officialOfferCapabilities' in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications' in (
            '["public_display"]'::jsonb,
            '["extract_only", "public_display"]'::jsonb,
            '["private_review", "public_display"]'::jsonb,
            '["extract_only", "private_review", "public_display"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications'
            ? capture.rights_classification
          -- A later re-approval cannot launder evidence captured under a
          -- different permission. Every pointer and capability snapshot must
          -- still bind to the one current permission selected above.
          and publication.discovery_permission_id = permission.id
          and capture.capture_permission_id = permission.id
          and capture.capture_permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and extraction.extraction_permission_id = permission.id
          and extraction.permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and (
            (extraction.extraction_method = 'ocr'
              and extraction.ocr_permission_id = permission.id
              and permission.permissions -> 'officialOfferCapabilities' ? 'ocr')
            or
            (extraction.extraction_method <> 'ocr'
              and extraction.ocr_permission_id is null)
          )
      )
  ),
  ranked as (
    select
      eligible.*,
      pg_catalog.row_number() over (
        partition by eligible.product_id
        order by eligible.valid_until, eligible.offer_id
      ) as product_rank
    from eligible
  ),
  per_product_bounded as materialized (
    select ranked.*
    from ranked
    where ranked.product_rank <= 51
  ),
  globally_bounded as materialized (
    select per_product_bounded.*
    from per_product_bounded
    order by per_product_bounded.product_id,
             per_product_bounded.valid_until,
             per_product_bounded.offer_id
    limit 501
  ),
  counted as (
    select
      globally_bounded.*,
      pg_catalog.count(*) over (
        partition by globally_bounded.product_id
      ) as product_offer_count,
      pg_catalog.count(*) over () as total_offer_count
    from globally_bounded
  ),
  public_rows as materialized (
    select
      counted.offer_id,
      counted.source_id,
      counted.source_display_name,
      counted.source_record_id,
      counted.chain,
      counted.product_id,
      counted.amount_ore,
      counted.before_amount_ore,
      counted.multibuy_quantity,
      counted.multibuy_group_amount_ore,
      counted.membership_requirement,
      counted.member_program_id,
      counted.valid_from,
      counted.valid_until,
      counted.geographic_scope,
      counted.channels,
      counted.captured_at,
      counted.product_offer_count,
      counted.total_offer_count
    from counted
  ),
  payload_bounded as materialized (
    select
      public_rows.*,
      -- Exact UTF-8 bytes of the canonical public-row JSON array defined here:
      -- every returned row object plus one comma per gap and two brackets.
      -- This is a database-boundary size, not a claim about later HTTP bytes.
      pg_catalog.sum(pg_catalog.octet_length(
        pg_catalog.row_to_json(public_rows)::text
      )) over () + pg_catalog.count(*) over () + 1 as total_payload_bytes
    from public_rows
  )
  select
    payload_bounded.offer_id,
    payload_bounded.source_id,
    payload_bounded.source_display_name,
    payload_bounded.source_record_id,
    payload_bounded.chain,
    payload_bounded.product_id,
    payload_bounded.amount_ore,
    payload_bounded.before_amount_ore,
    payload_bounded.multibuy_quantity,
    payload_bounded.multibuy_group_amount_ore,
    payload_bounded.membership_requirement,
    payload_bounded.member_program_id,
    payload_bounded.valid_from,
    payload_bounded.valid_until,
    payload_bounded.geographic_scope,
    payload_bounded.channels,
    payload_bounded.captured_at,
    payload_bounded.product_offer_count,
    payload_bounded.total_offer_count
  from payload_bounded
  where public.assert_public_official_offer_payload_v1(
    payload_bounded.total_payload_bytes
  )
  order by payload_bounded.product_id,
           payload_bounded.valid_until,
           payload_bounded.offer_id
  limit 501;
end;
$_$;


--
-- Name: record_official_offer_publication_health_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_official_offer_publication_health_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: reject_append_only_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_append_only_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = '55000';
end;
$$;


--
-- Name: stamp_approved_offer_state_clock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_approved_offer_state_clock() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


--
-- Name: stamp_operations_runtime_boundary_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_operations_runtime_boundary_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  new.operations_boundary_version := 1;
  new.persisted_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


--
-- Name: stamp_persisted_creation_clock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_persisted_creation_clock() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  new.created_at := statement_timestamp();
  return new;
end;
$$;


--
-- Name: stamp_private_review_action_decision_clock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_private_review_action_decision_clock() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


--
-- Name: stamp_public_state_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_public_state_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  new.public_state_changed_at := statement_timestamp();
  return new;
end;
$$;


--
-- Name: validate_family_taxonomy_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_family_taxonomy_publication() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  perform assert_family_taxonomy_publication(new.version_id);
  return null;
end;
$$;


--
-- Name: validate_worker_source_health_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_worker_source_health_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
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
    if worker_result.job_kind in ('catalog-refresh', 'official-offer-ingestion') then
      expected_discovery_success_at := worker_result.completed_at;
    end if;
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
  if (
    worker_result.status = 'partial'
    or (
      worker_result.status = 'succeeded'
      and accepted_count = 0
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
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alert_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_events (
    id bigint NOT NULL,
    alert_key character varying(160) NOT NULL,
    severity character varying(16) NOT NULL,
    status character varying(16) NOT NULL,
    source_id character varying(64),
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    operations_boundary_version smallint,
    persisted_at timestamp with time zone,
    CONSTRAINT alert_events_operations_boundary_pair CHECK ((((operations_boundary_version IS NULL) AND (persisted_at IS NULL)) OR ((operations_boundary_version = 1) AND (persisted_at IS NOT NULL)))),
    CONSTRAINT alert_events_severity CHECK (((severity)::text = ANY (ARRAY[('info'::character varying)::text, ('warning'::character varying)::text, ('critical'::character varying)::text]))),
    CONSTRAINT alert_events_status CHECK (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('acknowledged'::character varying)::text, ('closed'::character varying)::text]))),
    CONSTRAINT alert_events_time_range CHECK (((closed_at IS NULL) OR (closed_at >= opened_at)))
);


--
-- Name: alert_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_events_id_seq OWNED BY public.alert_events.id;


--
-- Name: approved_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approved_offers (
    id bigint NOT NULL,
    offer_key character varying(255) NOT NULL,
    candidate_id bigint,
    source_id character varying(64) NOT NULL,
    source_reference text NOT NULL,
    chain character varying(32) NOT NULL,
    geographic_scope_id bigint NOT NULL,
    amount_ore integer NOT NULL,
    before_amount_ore integer,
    multibuy_quantity integer,
    multibuy_group_amount_ore integer,
    membership_requirement character varying(24) DEFAULT 'public'::character varying NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT 'approved'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    approved_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approved_offers_amount_ore_nonnegative CHECK ((amount_ore >= 0)),
    CONSTRAINT approved_offers_before_amount_ore_nonnegative CHECK (((before_amount_ore IS NULL) OR (before_amount_ore >= 0))),
    CONSTRAINT approved_offers_before_not_lower CHECK (((before_amount_ore IS NULL) OR (before_amount_ore >= amount_ore))),
    CONSTRAINT approved_offers_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT approved_offers_membership_requirement CHECK (((membership_requirement)::text = ANY (ARRAY[('public'::character varying)::text, ('member'::character varying)::text]))),
    CONSTRAINT approved_offers_multibuy_pair CHECK ((((multibuy_quantity IS NULL) AND (multibuy_group_amount_ore IS NULL)) OR ((multibuy_quantity IS NOT NULL) AND (multibuy_quantity > 1) AND (multibuy_group_amount_ore IS NOT NULL) AND (multibuy_group_amount_ore >= 0)))),
    CONSTRAINT approved_offers_published_candidate_binding CHECK ((((status)::text <> 'published'::text) OR (candidate_id IS NOT NULL))),
    CONSTRAINT approved_offers_status CHECK (((status)::text = ANY (ARRAY[('approved'::character varying)::text, ('published'::character varying)::text, ('expired'::character varying)::text, ('revoked'::character varying)::text]))),
    CONSTRAINT approved_offers_valid_range CHECK ((valid_until > valid_from)),
    CONSTRAINT approved_offers_version_positive CHECK ((version > 0))
);


--
-- Name: approved_offers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.approved_offers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: approved_offers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.approved_offers_id_seq OWNED BY public.approved_offers.id;


--
-- Name: canonical_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_products (
    id bigint NOT NULL,
    display_name character varying(240) NOT NULL,
    brand character varying(160),
    package_amount integer,
    package_unit character varying(16),
    units_per_pack integer DEFAULT 1 NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    public_state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canonical_products_package_amount_positive CHECK (((package_amount IS NULL) OR (package_amount > 0))),
    CONSTRAINT canonical_products_package_unit CHECK (((package_unit IS NULL) OR ((package_unit)::text = ANY (ARRAY[('g'::character varying)::text, ('ml'::character varying)::text, ('piece'::character varying)::text, ('package'::character varying)::text])))),
    CONSTRAINT canonical_products_public_state_clock CHECK ((public_state_changed_at >= created_at)),
    CONSTRAINT canonical_products_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('quarantined'::character varying)::text, ('retired'::character varying)::text]))),
    CONSTRAINT canonical_products_units_per_pack_positive CHECK ((units_per_pack > 0))
);


--
-- Name: canonical_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canonical_products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: canonical_products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canonical_products_id_seq OWNED BY public.canonical_products.id;


--
-- Name: catalog_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_observations (
    id bigint NOT NULL,
    ingestion_run_id bigint NOT NULL,
    source_record_id character varying(128) NOT NULL,
    canonical_product_id bigint NOT NULL,
    gtin character varying(14) NOT NULL,
    display_name character varying(240) NOT NULL,
    brand character varying(160),
    package_amount integer,
    package_unit character varying(16),
    units_per_pack integer DEFAULT 1 NOT NULL,
    retrieved_at timestamp with time zone NOT NULL,
    source_updated_at timestamp with time zone,
    raw_record_hash character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    category_path jsonb,
    CONSTRAINT catalog_observations_category_path_shape CHECK (((category_path IS NULL) OR
CASE
    WHEN (jsonb_typeof(category_path) = 'array'::text) THEN (jsonb_array_length(category_path) <= 100)
    ELSE false
END)),
    CONSTRAINT catalog_observations_display_name_nonempty CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT catalog_observations_gtin_shape CHECK (((gtin)::text ~ '^([0-9]{8}|[0-9]{13})$'::text)),
    CONSTRAINT catalog_observations_hash_shape CHECK ((raw_record_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT catalog_observations_package_amount_positive CHECK (((package_amount IS NULL) OR (package_amount > 0))),
    CONSTRAINT catalog_observations_package_unit CHECK (((package_unit IS NULL) OR ((package_unit)::text = ANY (ARRAY[('g'::character varying)::text, ('ml'::character varying)::text, ('piece'::character varying)::text, ('package'::character varying)::text])))),
    CONSTRAINT catalog_observations_source_time_order CHECK (((source_updated_at IS NULL) OR (source_updated_at <= retrieved_at))),
    CONSTRAINT catalog_observations_units_per_pack_positive CHECK ((units_per_pack > 0))
);


--
-- Name: catalog_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.catalog_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.catalog_observations_id_seq OWNED BY public.catalog_observations.id;


--
-- Name: data_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_sources (
    id character varying(64) NOT NULL,
    display_name character varying(160) NOT NULL,
    source_kind character varying(32) NOT NULL,
    runtime_state character varying(16) DEFAULT 'blocked'::character varying NOT NULL,
    public_reference_url text,
    permission_reviewed_at timestamp with time zone,
    permission_expires_at timestamp with time zone,
    kill_switch_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    public_state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_sources_kind CHECK (((source_kind)::text = ANY (ARRAY[('catalog'::character varying)::text, ('ordinary_price'::character varying)::text, ('offer'::character varying)::text, ('store'::character varying)::text, ('geocoder'::character varying)::text, ('routing'::character varying)::text, ('legacy'::character varying)::text]))),
    CONSTRAINT data_sources_permission_range CHECK (((permission_expires_at IS NULL) OR (permission_reviewed_at IS NULL) OR (permission_expires_at > permission_reviewed_at))),
    CONSTRAINT data_sources_public_state_clock CHECK ((public_state_changed_at >= created_at)),
    CONSTRAINT data_sources_runtime_state CHECK (((runtime_state)::text = ANY (ARRAY[('approved'::character varying)::text, ('conditional'::character varying)::text, ('blocked'::character varying)::text, ('revoked'::character varying)::text])))
);


--
-- Name: extracted_offer_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extracted_offer_candidates (
    id bigint NOT NULL,
    extraction_run_id bigint NOT NULL,
    candidate_key character varying(160) NOT NULL,
    normalized_fields jsonb NOT NULL,
    confidence smallint NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    anomaly_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extracted_offer_candidates_confidence_range CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT extracted_offer_candidates_status CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('superseded'::character varying)::text])))
);


--
-- Name: extracted_offer_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.extracted_offer_candidates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: extracted_offer_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.extracted_offer_candidates_id_seq OWNED BY public.extracted_offer_candidates.id;


--
-- Name: extraction_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extraction_runs (
    id bigint NOT NULL,
    capture_id bigint NOT NULL,
    extractor_version character varying(80) NOT NULL,
    status character varying(16) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class character varying(80),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    extraction_method character varying(24),
    extraction_permission_id bigint,
    ocr_permission_id bigint,
    permission_capabilities jsonb,
    source_started_at timestamp with time zone,
    source_completed_at timestamp with time zone,
    empty_result character varying(24),
    empty_confirmation jsonb,
    empty_confirmation_observed_at timestamp with time zone,
    CONSTRAINT extraction_runs_empty_confirmation_pair CHECK (((empty_result IS NULL) OR ((((empty_result)::text = 'confirmed-empty'::text) AND (empty_confirmation IS NOT NULL) AND (empty_confirmation_observed_at IS NOT NULL)) OR (((empty_result)::text <> 'confirmed-empty'::text) AND (empty_confirmation IS NULL) AND (empty_confirmation_observed_at IS NULL))))),
    CONSTRAINT extraction_runs_empty_result_allowed CHECK (((empty_result IS NULL) OR ((empty_result)::text = ANY (ARRAY[('not-empty'::character varying)::text, ('confirmed-empty'::character varying)::text, ('unexpected-empty'::character varying)::text])))),
    CONSTRAINT extraction_runs_method_allowed CHECK (((extraction_method IS NULL) OR ((extraction_method)::text = ANY (ARRAY[('structured'::character varying)::text, ('embedded-text'::character varying)::text, ('ocr'::character varying)::text])))),
    CONSTRAINT extraction_runs_ocr_permission_pair CHECK (((extraction_method IS NULL) OR (((extraction_method)::text = 'ocr'::text) = (ocr_permission_id IS NOT NULL)))),
    CONSTRAINT extraction_runs_permission_capabilities_shape CHECK (((permission_capabilities IS NULL) OR
CASE
    WHEN (jsonb_typeof(permission_capabilities) = 'array'::text) THEN ((jsonb_array_length(permission_capabilities) >= 3) AND (jsonb_array_length(permission_capabilities) <= 4))
    ELSE false
END)),
    CONSTRAINT extraction_runs_permission_fence_complete CHECK ((((extraction_method IS NULL) AND (extraction_permission_id IS NULL) AND (ocr_permission_id IS NULL) AND (permission_capabilities IS NULL) AND (source_started_at IS NULL) AND (source_completed_at IS NULL) AND (empty_result IS NULL) AND (empty_confirmation IS NULL) AND (empty_confirmation_observed_at IS NULL)) OR ((extraction_method IS NOT NULL) AND (extraction_permission_id IS NOT NULL) AND (permission_capabilities IS NOT NULL) AND (source_started_at IS NOT NULL) AND (source_completed_at IS NOT NULL) AND (empty_result IS NOT NULL)))),
    CONSTRAINT extraction_runs_source_time_range CHECK (((source_started_at IS NULL) OR (source_completed_at >= source_started_at))),
    CONSTRAINT extraction_runs_status CHECK (((status)::text = ANY (ARRAY[('running'::character varying)::text, ('completed'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT extraction_runs_time_range CHECK (((completed_at IS NULL) OR (completed_at >= started_at)))
);


--
-- Name: extraction_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.extraction_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: extraction_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.extraction_runs_id_seq OWNED BY public.extraction_runs.id;


--
-- Name: family_taxonomy_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_taxonomy_versions (
    version_id character varying(120) NOT NULL,
    taxonomy_id character varying(80) NOT NULL,
    taxonomy_version character varying(32) NOT NULL,
    contract_version smallint NOT NULL,
    published_at timestamp with time zone NOT NULL,
    content_sha256 character(64) NOT NULL,
    content_json jsonb NOT NULL,
    expected_family_count integer NOT NULL,
    expected_alias_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_taxonomy_versions_alias_count_range CHECK (((expected_alias_count >= 0) AND (expected_alias_count <= (expected_family_count * 20)))),
    CONSTRAINT family_taxonomy_versions_checksum_shape CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT family_taxonomy_versions_content_array CHECK ((jsonb_typeof(content_json) = 'array'::text)),
    CONSTRAINT family_taxonomy_versions_contract_version CHECK ((contract_version = 1)),
    CONSTRAINT family_taxonomy_versions_family_count_range CHECK (((expected_family_count >= 1) AND (expected_family_count <= 500) AND (jsonb_array_length(content_json) = expected_family_count))),
    CONSTRAINT family_taxonomy_versions_publication_not_future_created CHECK ((published_at <= created_at)),
    CONSTRAINT family_taxonomy_versions_semver_shape CHECK (((taxonomy_version)::text ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT family_taxonomy_versions_taxonomy_id_shape CHECK (((taxonomy_id)::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT family_taxonomy_versions_version_id_binding CHECK (((version_id)::text = (((taxonomy_id)::text || '@'::text) || (taxonomy_version)::text)))
);


--
-- Name: geographic_postal_directory_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_postal_directory_codes (
    version_id character varying(80) NOT NULL,
    region_code character varying(80) NOT NULL,
    postal_code character(4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geographic_postal_directory_postal_shape CHECK ((postal_code ~ '^[0-9]{4}$'::text))
);


--
-- Name: geographic_postal_directory_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_postal_directory_regions (
    version_id character varying(80) NOT NULL,
    region_code character varying(80) NOT NULL,
    coverage_state character varying(16) NOT NULL,
    postal_count integer NOT NULL,
    evidence_reference character varying(240) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geographic_postal_directory_region_code_nonempty CHECK ((length(TRIM(BOTH FROM region_code)) > 0)),
    CONSTRAINT geographic_postal_directory_region_count CHECK (((((coverage_state)::text = 'complete'::text) AND ((postal_count >= 1) AND (postal_count <= 10000))) OR (((coverage_state)::text = 'ambiguous'::text) AND ((postal_count >= 0) AND (postal_count <= 10000))))),
    CONSTRAINT geographic_postal_directory_region_evidence_nonempty CHECK ((length(TRIM(BOTH FROM evidence_reference)) > 0)),
    CONSTRAINT geographic_postal_directory_region_state CHECK (((coverage_state)::text = ANY (ARRAY[('complete'::character varying)::text, ('ambiguous'::character varying)::text])))
);


--
-- Name: geographic_postal_directory_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_postal_directory_versions (
    version_id character varying(80) NOT NULL,
    contract_version smallint NOT NULL,
    country_code character(2) NOT NULL,
    status character varying(16) NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone,
    evidence_reference character varying(240) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sealed_at timestamp with time zone,
    CONSTRAINT geographic_postal_directory_contract CHECK ((contract_version = 1)),
    CONSTRAINT geographic_postal_directory_country CHECK ((country_code ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT geographic_postal_directory_evidence_nonempty CHECK ((length(TRIM(BOTH FROM evidence_reference)) > 0)),
    CONSTRAINT geographic_postal_directory_review_clock CHECK ((reviewed_at <= created_at)),
    CONSTRAINT geographic_postal_directory_seal_clock CHECK (((sealed_at IS NULL) OR (sealed_at >= created_at))),
    CONSTRAINT geographic_postal_directory_seal_state CHECK (((((status)::text = 'building'::text) AND (sealed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('approved'::character varying)::text, ('blocked'::character varying)::text, ('retired'::character varying)::text])) AND (sealed_at IS NOT NULL)))),
    CONSTRAINT geographic_postal_directory_status CHECK (((status)::text = ANY (ARRAY[('building'::character varying)::text, ('approved'::character varying)::text, ('blocked'::character varying)::text, ('retired'::character varying)::text]))),
    CONSTRAINT geographic_postal_directory_validity CHECK (((valid_until IS NULL) OR (valid_until > valid_from)))
);


--
-- Name: geographic_scope_postal_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_scope_postal_codes (
    scope_id bigint NOT NULL,
    postal_code character(4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geographic_scope_postal_codes_shape CHECK ((postal_code ~ '^[0-9]{4}$'::text))
);


--
-- Name: geographic_scope_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_scope_regions (
    scope_id bigint NOT NULL,
    region_code character varying(32) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: geographic_scope_stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_scope_stores (
    scope_id bigint NOT NULL,
    store_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: geographic_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geographic_scopes (
    id bigint NOT NULL,
    scope_key character varying(160) NOT NULL,
    scope_kind character varying(24) NOT NULL,
    label character varying(200) NOT NULL,
    country_code character(2) DEFAULT 'NO'::bpchar NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    public_state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geographic_scopes_country_shape CHECK ((country_code ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT geographic_scopes_kind CHECK (((scope_kind)::text = ANY (ARRAY[('national'::character varying)::text, ('region'::character varying)::text, ('postal_set'::character varying)::text, ('store_set'::character varying)::text]))),
    CONSTRAINT geographic_scopes_public_state_clock CHECK ((public_state_changed_at >= created_at)),
    CONSTRAINT geographic_scopes_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('retired'::character varying)::text])))
);


--
-- Name: geographic_scopes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.geographic_scopes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: geographic_scopes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.geographic_scopes_id_seq OWNED BY public.geographic_scopes.id;


--
-- Name: historical_price_statistics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_price_statistics (
    product_id bigint NOT NULL,
    chain character varying(32) NOT NULL,
    geographic_scope_id bigint,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    median_amount_ore integer NOT NULL,
    observation_count integer NOT NULL,
    distinct_observation_days integer NOT NULL,
    computed_at timestamp with time zone NOT NULL,
    CONSTRAINT historical_price_statistics_amount_nonnegative CHECK ((median_amount_ore >= 0)),
    CONSTRAINT historical_price_statistics_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT historical_price_statistics_counts CHECK (((observation_count >= distinct_observation_days) AND (distinct_observation_days >= 7))),
    CONSTRAINT historical_price_statistics_window_range CHECK ((window_end > window_start))
);


--
-- Name: ingestion_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingestion_runs (
    id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    run_type character varying(32) NOT NULL,
    status character varying(16) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class character varying(80),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    job_id character varying(200),
    terminalized_at timestamp with time zone,
    CONSTRAINT ingestion_runs_completion_not_after_terminalization CHECK ((((status)::text = 'running'::text) OR (completed_at <= terminalized_at))),
    CONSTRAINT ingestion_runs_status CHECK (((status)::text = ANY (ARRAY[('running'::character varying)::text, ('completed'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text]))),
    CONSTRAINT ingestion_runs_terminalization_state CHECK (((((status)::text = 'running'::text) AND (completed_at IS NULL) AND (terminalized_at IS NULL)) OR (((status)::text <> 'running'::text) AND (completed_at IS NOT NULL) AND (terminalized_at IS NOT NULL) AND (terminalized_at >= created_at)))),
    CONSTRAINT ingestion_runs_time_range CHECK (((completed_at IS NULL) OR (completed_at >= started_at)))
);


--
-- Name: ingestion_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ingestion_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ingestion_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ingestion_runs_id_seq OWNED BY public.ingestion_runs.id;


--
-- Name: price_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_observations (
    id bigint NOT NULL,
    evidence_key character varying(255) NOT NULL,
    product_id bigint NOT NULL,
    chain character varying(32) NOT NULL,
    amount_ore integer NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    source_id character varying(64) NOT NULL,
    source_reference text,
    ingestion_run_id bigint NOT NULL,
    geographic_scope_id bigint,
    evidence_level character varying(16) NOT NULL,
    confidence smallint NOT NULL,
    claim_eligibility character varying(24) DEFAULT 'ordinary_only'::character varying NOT NULL,
    raw_record_hash character(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT price_observations_amount_ore_nonnegative CHECK ((amount_ore >= 0)),
    CONSTRAINT price_observations_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT price_observations_claim_eligibility CHECK (((claim_eligibility)::text = ANY (ARRAY[('ordinary_only'::character varying)::text, ('historical_eligible'::character varying)::text]))),
    CONSTRAINT price_observations_confidence_range CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT price_observations_evidence_level CHECK (((evidence_level)::text = ANY (ARRAY[('chain'::character varying)::text, ('branch'::character varying)::text]))),
    CONSTRAINT price_observations_hash_shape CHECK (((raw_record_hash IS NULL) OR (raw_record_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT price_observations_time_range CHECK ((fetched_at >= observed_at))
);


--
-- Name: latest_price_evidence; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.latest_price_evidence AS
 SELECT DISTINCT ON (product_id, chain, geographic_scope_id) id,
    evidence_key,
    product_id,
    chain,
    amount_ore,
    observed_at,
    fetched_at,
    source_id,
    source_reference,
    ingestion_run_id,
    geographic_scope_id,
    evidence_level,
    confidence,
    claim_eligibility,
    raw_record_hash,
    created_at
   FROM public.price_observations
  ORDER BY product_id, chain, geographic_scope_id, observed_at DESC, fetched_at DESC, id DESC;


--
-- Name: offer_conditions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offer_conditions (
    id bigint NOT NULL,
    offer_id bigint NOT NULL,
    condition_type character varying(32) NOT NULL,
    condition_value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT offer_conditions_type CHECK (((condition_type)::text = ANY (ARRAY[('membership'::character varying)::text, ('quantity'::character varying)::text, ('channel'::character varying)::text, ('payment'::character varying)::text, ('other'::character varying)::text])))
);


--
-- Name: offer_conditions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.offer_conditions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: offer_conditions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.offer_conditions_id_seq OWNED BY public.offer_conditions.id;


--
-- Name: offer_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offer_targets (
    offer_id bigint NOT NULL,
    product_id bigint,
    family_slug character varying(80),
    match_method character varying(24) NOT NULL,
    match_confidence smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT offer_targets_confidence_range CHECK (((match_confidence >= 0) AND (match_confidence <= 100))),
    CONSTRAINT offer_targets_exactly_one_target CHECK ((((product_id IS NOT NULL) AND (family_slug IS NULL)) OR ((product_id IS NULL) AND (family_slug IS NOT NULL)))),
    CONSTRAINT offer_targets_match_method CHECK (((match_method)::text = ANY (ARRAY[('exact_identifier'::character varying)::text, ('deterministic_rule'::character varying)::text, ('human_review'::character varying)::text])))
);


--
-- Name: official_offer_lifecycle_job_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.official_offer_lifecycle_job_results (
    job_id character varying(200) NOT NULL,
    source_id character varying(64) NOT NULL,
    lease_token character(64) NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    evaluated_at timestamp with time zone NOT NULL,
    batch_limit integer NOT NULL,
    publication_requested boolean NOT NULL,
    publication_authorized boolean NOT NULL,
    publication_state character varying(24) NOT NULL,
    expiry_examined integer NOT NULL,
    expired_count integer NOT NULL,
    revoked_count integer NOT NULL,
    publication_examined integer NOT NULL,
    published_count integer NOT NULL,
    skipped_count integer NOT NULL,
    result_sha256 character(64) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT official_offer_lifecycle_job_results_batch CHECK (((batch_limit >= 1) AND (batch_limit <= 50))),
    CONSTRAINT official_offer_lifecycle_job_results_counts CHECK (((expiry_examined >= 0) AND (expiry_examined <= batch_limit) AND ((expired_count >= 0) AND (expired_count <= expiry_examined)) AND ((revoked_count >= 0) AND (revoked_count <= expiry_examined)) AND ((expired_count + revoked_count) <= expiry_examined) AND ((publication_examined >= 0) AND (publication_examined <= batch_limit)) AND ((published_count >= 0) AND (published_count <= publication_examined)) AND (skipped_count = ((((expiry_examined + publication_examined) - expired_count) - revoked_count) - published_count)) AND (skipped_count >= 0))),
    CONSTRAINT official_offer_lifecycle_job_results_hash CHECK ((result_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT official_offer_lifecycle_job_results_publication CHECK (((publication_authorized AND publication_requested AND ((publication_state)::text = ANY (ARRAY[('source-ineligible'::character varying)::text, ('evaluated'::character varying)::text]))) OR ((NOT publication_authorized) AND ((publication_state)::text = 'foundation-disabled'::text)))),
    CONSTRAINT official_offer_lifecycle_job_results_state CHECK (((publication_state)::text = ANY (ARRAY[('foundation-disabled'::character varying)::text, ('source-ineligible'::character varying)::text, ('evaluated'::character varying)::text]))),
    CONSTRAINT official_offer_lifecycle_job_results_time CHECK (((created_at >= evaluated_at) AND (lease_expires_at >= created_at))),
    CONSTRAINT official_offer_lifecycle_job_results_token CHECK ((lease_token ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: official_offer_lifecycle_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.official_offer_lifecycle_leases (
    source_id character varying(64) NOT NULL,
    lease_kind character varying(48) NOT NULL,
    owner_id character varying(160) NOT NULL,
    job_id character varying(200) NOT NULL,
    lease_token character(64) NOT NULL,
    acquired_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    expiry_cursor_offer_id bigint DEFAULT 0 NOT NULL,
    publication_cursor_offer_id bigint DEFAULT 0 NOT NULL,
    CONSTRAINT official_offer_lifecycle_leases_cursors CHECK (((expiry_cursor_offer_id >= 0) AND (expiry_cursor_offer_id <= '9007199254740991'::bigint) AND ((publication_cursor_offer_id >= 0) AND (publication_cursor_offer_id <= '9007199254740991'::bigint)))),
    CONSTRAINT official_offer_lifecycle_leases_kind CHECK (((lease_kind)::text = 'official-offer-lifecycle-v1'::text)),
    CONSTRAINT official_offer_lifecycle_leases_time CHECK (((expires_at > acquired_at) AND ((completed_at IS NULL) OR ((completed_at >= acquired_at) AND (completed_at <= expires_at))))),
    CONSTRAINT official_offer_lifecycle_leases_token CHECK ((lease_token ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: official_offer_publication_health_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.official_offer_publication_health_facts (
    id bigint NOT NULL,
    lifecycle_job_id character varying(200) NOT NULL,
    source_id character varying(64) NOT NULL,
    published_count integer NOT NULL,
    last_publish_success_at timestamp with time zone NOT NULL,
    newest_eligible_evidence_at timestamp with time zone NOT NULL,
    persisted_at timestamp with time zone NOT NULL,
    CONSTRAINT official_offer_publication_health_clocks CHECK (((newest_eligible_evidence_at <= last_publish_success_at) AND (last_publish_success_at <= persisted_at))),
    CONSTRAINT official_offer_publication_health_count CHECK (((published_count >= 1) AND (published_count <= 50)))
);


--
-- Name: official_offer_publication_health_facts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.official_offer_publication_health_facts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: official_offer_publication_health_facts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.official_offer_publication_health_facts_id_seq OWNED BY public.official_offer_publication_health_facts.id;


--
-- Name: official_offer_publication_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.official_offer_publication_policy (
    policy_key character varying(40) NOT NULL,
    enabled boolean NOT NULL,
    policy_version integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT official_offer_publication_policy_singleton CHECK (((policy_key)::text = 'official-offer-publication-v1'::text)),
    CONSTRAINT official_offer_publication_policy_version CHECK ((policy_version = 1))
);


--
-- Name: physical_store_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_store_observations (
    id bigint NOT NULL,
    ingestion_run_id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    branch_key character(64) NOT NULL,
    external_id character varying(128) NOT NULL,
    chain character varying(32) NOT NULL,
    name character varying(240) NOT NULL,
    latitude numeric(9,6) NOT NULL,
    longitude numeric(9,6) NOT NULL,
    status character varying(16) NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    postal_code character varying(4),
    CONSTRAINT physical_store_observations_branch_key_binding CHECK (((branch_key)::text = encode(sha256(convert_to(((((octet_length((source_id)::text))::text || ':'::text) || (source_id)::text) || (external_id)::text), 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT physical_store_observations_branch_key_shape CHECK ((branch_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT physical_store_observations_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT physical_store_observations_latitude_range CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))),
    CONSTRAINT physical_store_observations_longitude_range CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))),
    CONSTRAINT physical_store_observations_name_nonempty CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT physical_store_observations_observed_before_creation CHECK ((observed_at <= created_at)),
    CONSTRAINT physical_store_observations_postal_shape CHECK (((postal_code IS NULL) OR ((postal_code)::text ~ '^[0-9]{4}$'::text))),
    CONSTRAINT physical_store_observations_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('closed'::character varying)::text, ('unknown'::character varying)::text])))
);


--
-- Name: physical_store_branches_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.physical_store_branches_public WITH (security_barrier='true') AS
 SELECT ((('branch:'::text || (ingestion_run_id)::text) || ':'::text) || (branch_key)::text) AS branch_id,
    chain,
    name,
    latitude,
    longitude
   FROM public.physical_store_observations observation
  WHERE ((status)::text = 'active'::text);


--
-- Name: physical_store_coverage_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_store_coverage_checks (
    id bigint NOT NULL,
    ingestion_run_id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    chain character varying(32) NOT NULL,
    state character varying(16) NOT NULL,
    reason character varying(40),
    record_count integer NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT physical_store_coverage_checks_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT physical_store_coverage_checks_checked_before_creation CHECK ((checked_at <= created_at)),
    CONSTRAINT physical_store_coverage_checks_reason_state CHECK (((((state)::text = 'complete'::text) AND (reason IS NULL) AND (record_count > 0)) OR (((state)::text = 'unknown'::text) AND ((reason)::text = ANY (ARRAY[('DUPLICATE_IDENTITY'::character varying)::text, ('INVALID_RECORDS'::character varying)::text, ('MISSING_SUPPORTED_CHAIN'::character varying)::text, ('POSSIBLY_TRUNCATED'::character varying)::text, ('REQUEST_FAILED'::character varying)::text]))))),
    CONSTRAINT physical_store_coverage_checks_record_count_range CHECK (((record_count >= 0) AND (record_count <= 1000))),
    CONSTRAINT physical_store_coverage_checks_state CHECK (((state)::text = ANY (ARRAY[('complete'::character varying)::text, ('unknown'::character varying)::text])))
);


--
-- Name: physical_store_coverage_checks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.physical_store_coverage_checks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: physical_store_coverage_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.physical_store_coverage_checks_id_seq OWNED BY public.physical_store_coverage_checks.id;


--
-- Name: physical_store_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.physical_store_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: physical_store_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.physical_store_observations_id_seq OWNED BY public.physical_store_observations.id;


--
-- Name: physical_store_region_branches_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.physical_store_region_branches_public WITH (security_barrier='true') AS
 SELECT ((('branch:'::text || (observation.ingestion_run_id)::text) || ':'::text) || (observation.branch_key)::text) AS branch_id,
    observation.chain,
    observation.name,
    observation.latitude,
    observation.longitude,
    observation.observed_at AS branch_observed_at,
    observation.created_at AS branch_created_at,
    version.version_id AS directory_version_id,
    version.country_code,
    version.status AS directory_status,
    version.reviewed_at AS directory_reviewed_at,
    version.valid_from AS directory_valid_from,
    version.valid_until AS directory_valid_until,
    version.evidence_reference AS directory_evidence_reference,
    version.created_at AS directory_created_at,
    version.sealed_at AS directory_sealed_at,
    region.region_code,
    region.coverage_state AS region_coverage_state,
    region.postal_count AS region_postal_count,
    region.evidence_reference AS region_evidence_reference,
    region.created_at AS region_created_at,
    code.created_at AS postal_mapping_created_at
   FROM (((public.physical_store_observations observation
     JOIN public.geographic_postal_directory_codes code ON ((code.postal_code = (observation.postal_code)::bpchar)))
     JOIN public.geographic_postal_directory_regions region ON ((((region.version_id)::text = (code.version_id)::text) AND ((region.region_code)::text = (code.region_code)::text))))
     JOIN public.geographic_postal_directory_versions version ON (((version.version_id)::text = (region.version_id)::text)))
  WHERE (((observation.status)::text = 'active'::text) AND ((version.status)::text = 'approved'::text) AND (version.sealed_at IS NOT NULL));


--
-- Name: physical_stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_stores (
    id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    external_id character varying(128) NOT NULL,
    chain character varying(32) NOT NULL,
    name character varying(240) NOT NULL,
    address_line character varying(240),
    postal_code character varying(8),
    municipality_code character varying(8),
    latitude numeric(9,6) NOT NULL,
    longitude numeric(9,6) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT physical_stores_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT physical_stores_latitude_range CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))),
    CONSTRAINT physical_stores_longitude_range CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))),
    CONSTRAINT physical_stores_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('closed'::character varying)::text, ('unknown'::character varying)::text])))
);


--
-- Name: physical_stores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.physical_stores_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: physical_stores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.physical_stores_id_seq OWNED BY public.physical_stores.id;


--
-- Name: price_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_cache (
    ean character varying(14) NOT NULL,
    chain character varying(32) NOT NULL,
    amount_ore integer NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT price_cache_amount_ore_nonnegative CHECK ((amount_ore >= 0)),
    CONSTRAINT price_cache_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT price_cache_ean_shape CHECK (((ean)::text ~ '^([0-9]{8}|[0-9]{13})$'::text))
);


--
-- Name: price_coverage_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_coverage_checks (
    id bigint NOT NULL,
    ingestion_run_id bigint NOT NULL,
    product_id bigint NOT NULL,
    chain character varying(32) NOT NULL,
    geographic_scope_id bigint,
    state character varying(24) NOT NULL,
    reason character varying(160) NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT price_coverage_checks_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT price_coverage_checks_state CHECK (((state)::text = ANY (ARRAY[('priced'::character varying)::text, ('known_not_carried'::character varying)::text, ('stale'::character varying)::text, ('ineligible'::character varying)::text, ('unknown'::character varying)::text])))
);


--
-- Name: price_coverage_checks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_coverage_checks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_coverage_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_coverage_checks_id_seq OWNED BY public.price_coverage_checks.id;


--
-- Name: price_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_observations_id_seq OWNED BY public.price_observations.id;


--
-- Name: private_review_evidence_consumptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_review_evidence_consumptions (
    id bigint NOT NULL,
    evidence_render_id bigint NOT NULL,
    review_action_id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    consumed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT private_review_evidence_consumptions_time CHECK ((consumed_at = created_at))
);


--
-- Name: private_review_evidence_consumptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.private_review_evidence_consumptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: private_review_evidence_consumptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.private_review_evidence_consumptions_id_seq OWNED BY public.private_review_evidence_consumptions.id;


--
-- Name: private_review_evidence_renders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_review_evidence_renders (
    id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    expected_version integer NOT NULL,
    capture_checksum character(64) NOT NULL,
    crop_reference character varying(76) NOT NULL,
    presentation character varying(24) NOT NULL,
    rights_classification character varying(24) NOT NULL,
    mime_type character varying(120) NOT NULL,
    byte_length integer NOT NULL,
    actor_id character varying(80) NOT NULL,
    reviewer_session_id character varying(80) NOT NULL,
    evidence_proof_sha256 character(64) NOT NULL,
    rendered_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT private_review_evidence_renders_actor CHECK (((actor_id)::text ~ '^access:[0-9a-f]{64}$'::text)),
    CONSTRAINT private_review_evidence_renders_byte_length CHECK (((byte_length >= 1) AND (byte_length <= 52428800))),
    CONSTRAINT private_review_evidence_renders_checksum CHECK ((capture_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_review_evidence_renders_crop_reference CHECK (((crop_reference)::text ~ '^review-crop:[0-9a-f]{64}$'::text)),
    CONSTRAINT private_review_evidence_renders_expected_version CHECK ((expected_version >= 0)),
    CONSTRAINT private_review_evidence_renders_image_mime CHECK (((mime_type)::text = ANY (ARRAY[('image/jpeg'::character varying)::text, ('image/png'::character varying)::text, ('image/webp'::character varying)::text]))),
    CONSTRAINT private_review_evidence_renders_presentation CHECK (((presentation)::text = 'full_capture'::text)),
    CONSTRAINT private_review_evidence_renders_proof CHECK ((evidence_proof_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_review_evidence_renders_rights CHECK (((rights_classification)::text = ANY (ARRAY[('private_review'::character varying)::text, ('public_display'::character varying)::text]))),
    CONSTRAINT private_review_evidence_renders_session CHECK (((reviewer_session_id)::text ~ '^access-session:[0-9a-f]{64}$'::text)),
    CONSTRAINT private_review_evidence_renders_time CHECK (((rendered_at = created_at) AND (expires_at > rendered_at)))
);


--
-- Name: private_review_evidence_renders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.private_review_evidence_renders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: private_review_evidence_renders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.private_review_evidence_renders_id_seq OWNED BY public.private_review_evidence_renders.id;


--
-- Name: product_families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_families (
    slug character varying(80) NOT NULL,
    label_no character varying(160) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_families_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('retired'::character varying)::text])))
);


--
-- Name: product_family_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_family_memberships (
    product_id bigint NOT NULL,
    family_slug character varying(80) NOT NULL,
    confidence smallint NOT NULL,
    method character varying(24) NOT NULL,
    review_state character varying(16) NOT NULL,
    rule_version character varying(64),
    reviewed_at timestamp with time zone,
    CONSTRAINT product_family_memberships_confidence_range CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT product_family_memberships_method CHECK (((method)::text = ANY (ARRAY[('exact_identifier'::character varying)::text, ('deterministic_rule'::character varying)::text, ('human_review'::character varying)::text]))),
    CONSTRAINT product_family_memberships_review_state CHECK (((review_state)::text = ANY (ARRAY[('approved'::character varying)::text, ('candidate'::character varying)::text, ('rejected'::character varying)::text])))
);


--
-- Name: product_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_identifiers (
    id bigint NOT NULL,
    product_id bigint NOT NULL,
    scheme character varying(16) NOT NULL,
    value character varying(128) NOT NULL,
    source_id character varying(64),
    confidence smallint DEFAULT 100 NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    public_state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_identifiers_confidence_range CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT product_identifiers_ean_shape CHECK (((((scheme)::text = 'ean8'::text) AND ((value)::text ~ '^[0-9]{8}$'::text)) OR (((scheme)::text = 'ean13'::text) AND ((value)::text ~ '^[0-9]{13}$'::text)) OR (((scheme)::text = 'source'::text) AND ((length((value)::text) >= 1) AND (length((value)::text) <= 128))))),
    CONSTRAINT product_identifiers_public_state_clock CHECK ((public_state_changed_at >= created_at)),
    CONSTRAINT product_identifiers_scheme CHECK (((scheme)::text = ANY (ARRAY[('ean8'::character varying)::text, ('ean13'::character varying)::text, ('source'::character varying)::text]))),
    CONSTRAINT product_identifiers_source_scope CHECK (((((scheme)::text = ANY (ARRAY[('ean8'::character varying)::text, ('ean13'::character varying)::text])) AND (source_id IS NULL)) OR (((scheme)::text = 'source'::text) AND (source_id IS NOT NULL))))
);


--
-- Name: product_identifiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_identifiers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_identifiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_identifiers_id_seq OWNED BY public.product_identifiers.id;


--
-- Name: provider_request_budget_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_request_budget_events (
    provider_key character varying(64) NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT provider_request_budget_events_provider_key_shape CHECK (((provider_key)::text ~ '^[a-z][a-z0-9_-]{0,63}$'::text))
);


--
-- Name: public_api_request_budget_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_api_request_budget_events (
    route_key character varying(32) NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT public_api_request_budget_events_route_key_allowed CHECK (((route_key)::text = ANY (ARRAY[('discovery-impact'::character varying)::text, ('discovery-search'::character varying)::text, ('locations-current'::character varying)::text, ('locations-search'::character varying)::text, ('plan-candidates'::character varying)::text, ('plans'::character varying)::text, ('plans-travel'::character varying)::text, ('products-search'::character varying)::text, ('source-status'::character varying)::text])))
);


--
-- Name: publication_captures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_captures (
    id bigint NOT NULL,
    publication_id bigint NOT NULL,
    blob_key text NOT NULL,
    checksum character(64) NOT NULL,
    mime_type character varying(120) NOT NULL,
    byte_length integer NOT NULL,
    rights_classification character varying(24) DEFAULT 'private_review'::character varying NOT NULL,
    retrieved_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_permission_id bigint,
    capture_permission_capabilities jsonb,
    CONSTRAINT publication_captures_byte_length_positive CHECK ((byte_length > 0)),
    CONSTRAINT publication_captures_checksum_shape CHECK ((checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT publication_captures_permission_capabilities_shape CHECK (((capture_permission_capabilities IS NULL) OR
CASE
    WHEN (jsonb_typeof(capture_permission_capabilities) = 'array'::text) THEN ((jsonb_array_length(capture_permission_capabilities) >= 3) AND (jsonb_array_length(capture_permission_capabilities) <= 4))
    ELSE false
END)),
    CONSTRAINT publication_captures_permission_fence_complete CHECK ((((capture_permission_id IS NULL) AND (capture_permission_capabilities IS NULL)) OR ((capture_permission_id IS NOT NULL) AND (capture_permission_capabilities IS NOT NULL)))),
    CONSTRAINT publication_captures_rights_classification CHECK (((rights_classification)::text = ANY (ARRAY[('private_review'::character varying)::text, ('extract_only'::character varying)::text, ('public_display'::character varying)::text])))
);


--
-- Name: publication_captures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.publication_captures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: publication_captures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.publication_captures_id_seq OWNED BY public.publication_captures.id;


--
-- Name: publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publications (
    id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    external_id character varying(160) NOT NULL,
    chain character varying(32) NOT NULL,
    title character varying(240) NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    geographic_scope_id bigint NOT NULL,
    status character varying(16) DEFAULT 'discovered'::character varying NOT NULL,
    discovered_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    content_kind character varying(24),
    declared_geographic_scope jsonb,
    edition_identity_sha256 character(64),
    discovery_permission_id bigint,
    CONSTRAINT publications_chain_supported CHECK (((chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text]))),
    CONSTRAINT publications_content_kind_allowed CHECK (((content_kind IS NULL) OR ((content_kind)::text = ANY (ARRAY[('structured-feed'::character varying)::text, ('publication'::character varying)::text])))),
    CONSTRAINT publications_declared_scope_object CHECK (((declared_geographic_scope IS NULL) OR (jsonb_typeof(declared_geographic_scope) = 'object'::text))),
    CONSTRAINT publications_edition_identity_sha256_shape CHECK (((edition_identity_sha256 IS NULL) OR (edition_identity_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT publications_offer_identity_complete CHECK ((((content_kind IS NULL) AND (declared_geographic_scope IS NULL) AND (edition_identity_sha256 IS NULL) AND (discovery_permission_id IS NULL)) OR ((content_kind IS NOT NULL) AND (declared_geographic_scope IS NOT NULL) AND (edition_identity_sha256 IS NOT NULL) AND (discovery_permission_id IS NOT NULL)))),
    CONSTRAINT publications_status CHECK (((status)::text = ANY (ARRAY[('discovered'::character varying)::text, ('captured'::character varying)::text, ('published'::character varying)::text, ('expired'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT publications_valid_range CHECK ((valid_until > valid_from))
);


--
-- Name: publications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.publications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: publications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.publications_id_seq OWNED BY public.publications.id;


--
-- Name: review_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_actions (
    id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    offer_id bigint,
    actor_id character varying(160) NOT NULL,
    action character varying(24) NOT NULL,
    expected_version integer NOT NULL,
    previous_values jsonb,
    new_values jsonb,
    reason text NOT NULL,
    acted_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decision_boundary_version smallint DEFAULT 1,
    CONSTRAINT review_actions_action CHECK (((action)::text = ANY (ARRAY[('approve'::character varying)::text, ('correct_and_approve'::character varying)::text, ('reject'::character varying)::text, ('revoke'::character varying)::text]))),
    CONSTRAINT review_actions_decision_boundary_version CHECK (((decision_boundary_version IS NULL) OR (decision_boundary_version = ANY (ARRAY[1, 2])))),
    CONSTRAINT review_actions_expected_version_nonnegative CHECK ((expected_version >= 0))
);


--
-- Name: review_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_actions_id_seq OWNED BY public.review_actions.id;


--
-- Name: reviewed_family_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviewed_family_aliases (
    version_id character varying(120) NOT NULL,
    family_id character varying(80) NOT NULL,
    alias character varying(80) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviewed_family_aliases_alias_nonempty CHECK ((length(TRIM(BOTH FROM alias)) > 0)),
    CONSTRAINT reviewed_family_aliases_alias_shape CHECK (((alias)::text ~ '^[a-z0-9æøå]+([ -][a-z0-9æøå]+)*$'::text))
);


--
-- Name: reviewed_family_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviewed_family_definitions (
    version_id character varying(120) NOT NULL,
    family_id character varying(80) NOT NULL,
    slug character varying(80) NOT NULL,
    label_no character varying(160) NOT NULL,
    parent_family_id character varying(80),
    status character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviewed_family_definitions_family_id_shape CHECK (((family_id)::text ~ '^family:[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT reviewed_family_definitions_label_nonempty CHECK ((length(TRIM(BOTH FROM label_no)) > 0)),
    CONSTRAINT reviewed_family_definitions_parent_not_self CHECK (((parent_family_id IS NULL) OR ((parent_family_id)::text <> (family_id)::text))),
    CONSTRAINT reviewed_family_definitions_slug_shape CHECK (((slug)::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT reviewed_family_definitions_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('retired'::character varying)::text])))
);


--
-- Name: reviewed_family_membership_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviewed_family_membership_decisions (
    id bigint NOT NULL,
    version_id character varying(120) NOT NULL,
    family_id character varying(80) NOT NULL,
    product_id bigint NOT NULL,
    decision character varying(16) NOT NULL,
    method character varying(24) NOT NULL,
    confidence smallint NOT NULL,
    reviewer_id character varying(160),
    reviewed_at timestamp with time zone NOT NULL,
    rule_version character varying(80),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviewed_family_membership_decisions_confidence_range CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT reviewed_family_membership_decisions_decision CHECK (((decision)::text = ANY (ARRAY[('approved'::character varying)::text, ('candidate'::character varying)::text, ('rejected'::character varying)::text]))),
    CONSTRAINT reviewed_family_membership_decisions_method CHECK (((method)::text = ANY (ARRAY[('deterministic_rule'::character varying)::text, ('human_review'::character varying)::text]))),
    CONSTRAINT reviewed_family_membership_decisions_provenance CHECK (((((method)::text = 'human_review'::text) AND (reviewer_id IS NOT NULL) AND (length(TRIM(BOTH FROM reviewer_id)) > 0) AND (rule_version IS NULL)) OR (((method)::text = 'deterministic_rule'::text) AND (reviewer_id IS NULL) AND (rule_version IS NOT NULL) AND (length(TRIM(BOTH FROM rule_version)) > 0)))),
    CONSTRAINT reviewed_family_membership_decisions_review_not_future_created CHECK ((reviewed_at <= created_at))
);


--
-- Name: reviewed_family_membership_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reviewed_family_membership_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reviewed_family_membership_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reviewed_family_membership_decisions_id_seq OWNED BY public.reviewed_family_membership_decisions.id;


--
-- Name: reviewed_family_membership_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.reviewed_family_membership_public WITH (security_barrier='true') AS
 SELECT id,
    version_id,
    family_id,
    product_id,
    decision,
    method,
    confidence,
    reviewed_at,
    rule_version,
    created_at,
    ((reviewer_id IS NOT NULL) AND (length(TRIM(BOTH FROM reviewer_id)) > 0)) AS reviewer_attested
   FROM public.reviewed_family_membership_decisions;


--
-- Name: source_health_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_health_snapshots (
    id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    geographic_scope_id bigint,
    status character varying(16) NOT NULL,
    last_discovery_success_at timestamp with time zone,
    last_capture_success_at timestamp with time zone,
    last_publish_success_at timestamp with time zone,
    newest_eligible_evidence_at timestamp with time zone,
    review_queue_count integer DEFAULT 0 NOT NULL,
    oldest_review_age_seconds integer,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    worker_job_id character varying(200),
    operations_boundary_version smallint,
    persisted_at timestamp with time zone,
    CONSTRAINT source_health_snapshots_operations_boundary_pair CHECK ((((operations_boundary_version IS NULL) AND (persisted_at IS NULL)) OR ((operations_boundary_version = 1) AND (persisted_at IS NOT NULL)))),
    CONSTRAINT source_health_snapshots_queue_nonnegative CHECK ((review_queue_count >= 0)),
    CONSTRAINT source_health_snapshots_review_age_nonnegative CHECK (((oldest_review_age_seconds IS NULL) OR (oldest_review_age_seconds >= 0))),
    CONSTRAINT source_health_snapshots_status CHECK (((status)::text = ANY (ARRAY[('healthy'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text, ('disabled'::character varying)::text]))),
    CONSTRAINT source_health_snapshots_success_clocks_not_future CHECK (((worker_job_id IS NULL) OR (((last_discovery_success_at IS NULL) OR (last_discovery_success_at <= recorded_at)) AND ((last_capture_success_at IS NULL) OR (last_capture_success_at <= recorded_at)) AND ((last_publish_success_at IS NULL) OR (last_publish_success_at <= recorded_at)) AND ((newest_eligible_evidence_at IS NULL) OR (newest_eligible_evidence_at <= recorded_at))))),
    CONSTRAINT source_health_snapshots_worker_payload_allowlist CHECK (((worker_job_id IS NULL) OR ((details = '{}'::jsonb) AND (review_queue_count = 0) AND (oldest_review_age_seconds IS NULL))))
);


--
-- Name: source_health_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.source_health_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: source_health_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.source_health_snapshots_id_seq OWNED BY public.source_health_snapshots.id;


--
-- Name: source_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_permissions (
    id bigint NOT NULL,
    source_id character varying(64) NOT NULL,
    decision character varying(16) NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    valid_until timestamp with time zone,
    public_reference_url text,
    private_reference_key text,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_permissions_decision CHECK (((decision)::text = ANY (ARRAY[('approved'::character varying)::text, ('conditional'::character varying)::text, ('blocked'::character varying)::text, ('revoked'::character varying)::text]))),
    CONSTRAINT source_permissions_valid_range CHECK (((valid_until IS NULL) OR (valid_until > reviewed_at)))
);


--
-- Name: source_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.source_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: source_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.source_permissions_id_seq OWNED BY public.source_permissions.id;


--
-- Name: source_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_products (
    source_id character varying(64) NOT NULL,
    external_id character varying(128) NOT NULL,
    canonical_product_id bigint,
    normalized_fields jsonb NOT NULL,
    raw_record_hash character(64) NOT NULL,
    match_state character varying(16) DEFAULT 'unmatched'::character varying NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    CONSTRAINT source_products_hash_shape CHECK ((raw_record_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_products_match_state CHECK (((match_state)::text = ANY (ARRAY[('unmatched'::character varying)::text, ('candidate'::character varying)::text, ('matched'::character varying)::text, ('quarantined'::character varying)::text]))),
    CONSTRAINT source_products_seen_range CHECK ((last_seen_at >= first_seen_at))
);


--
-- Name: source_record_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_record_outcomes (
    id bigint NOT NULL,
    ingestion_run_id bigint NOT NULL,
    record_kind character varying(32) NOT NULL,
    source_record_id character varying(200) NOT NULL,
    outcome_state character varying(16) NOT NULL,
    reason character varying(80),
    subject_ean character varying(14),
    subject_chain character varying(32),
    raw_chain_code character varying(100),
    normalized_record jsonb,
    outcome_hash character(64) NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_record_outcomes_chain_supported CHECK (((subject_chain IS NULL) OR ((subject_chain)::text = ANY (ARRAY[('bunnpris'::character varying)::text, ('extra'::character varying)::text, ('rema-1000'::character varying)::text, ('fudi'::character varying)::text, ('holdbart'::character varying)::text, ('meny'::character varying)::text, ('havaristen'::character varying)::text, ('joker'::character varying)::text, ('spar'::character varying)::text, ('fastcandy'::character varying)::text, ('europris'::character varying)::text, ('engrossnett'::character varying)::text, ('oda'::character varying)::text])))),
    CONSTRAINT source_record_outcomes_ean_shape CHECK (((subject_ean IS NULL) OR ((subject_ean)::text ~ '^([0-9]{8}|[0-9]{13})$'::text))),
    CONSTRAINT source_record_outcomes_hash_shape CHECK ((outcome_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_record_outcomes_reason_state CHECK (((((outcome_state)::text = 'accepted'::text) AND (reason IS NULL)) OR (((outcome_state)::text = ANY (ARRAY[('quarantined'::character varying)::text, ('unknown'::character varying)::text])) AND (reason IS NOT NULL)))),
    CONSTRAINT source_record_outcomes_state CHECK (((outcome_state)::text = ANY (ARRAY[('accepted'::character varying)::text, ('quarantined'::character varying)::text, ('unknown'::character varying)::text])))
);


--
-- Name: source_record_outcomes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.source_record_outcomes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: source_record_outcomes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.source_record_outcomes_id_seq OWNED BY public.source_record_outcomes.id;


--
-- Name: worker_job_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_job_results (
    id bigint NOT NULL,
    job_id character varying(200) NOT NULL,
    source_id character varying(64) NOT NULL,
    job_kind character varying(40) NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    run_id character varying(200) NOT NULL,
    status character varying(16) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    counts jsonb NOT NULL,
    result_hash character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    operations_boundary_version smallint,
    persisted_at timestamp with time zone,
    CONSTRAINT worker_job_results_counts_object CHECK ((jsonb_typeof(counts) = 'object'::text)),
    CONSTRAINT worker_job_results_hash_shape CHECK ((result_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT worker_job_results_job_kind CHECK (((job_kind)::text = ANY (ARRAY[('catalog-refresh'::character varying)::text, ('benchmark-price-refresh'::character varying)::text, ('physical-store-sync'::character varying)::text, ('historical-observation-collection'::character varying)::text, ('open-prices-benchmark-refresh'::character varying)::text, ('official-offer-discovery'::character varying)::text, ('official-offer-fetch'::character varying)::text, ('official-offer-ingestion'::character varying)::text, ('official-offer-lifecycle-reconcile'::character varying)::text]))),
    CONSTRAINT worker_job_results_operations_boundary_pair CHECK ((((operations_boundary_version IS NULL) AND (persisted_at IS NULL)) OR ((operations_boundary_version = 1) AND (persisted_at IS NOT NULL)))),
    CONSTRAINT worker_job_results_status CHECK (((status)::text = ANY (ARRAY[('succeeded'::character varying)::text, ('partial'::character varying)::text, ('cancelled'::character varying)::text, ('timed-out'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT worker_job_results_time_range CHECK (((completed_at >= started_at) AND (completed_at >= scheduled_at)))
);


--
-- Name: worker_job_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.worker_job_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worker_job_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.worker_job_results_id_seq OWNED BY public.worker_job_results.id;


--
-- Name: worker_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_leases (
    lease_key character varying(120) NOT NULL,
    owner_id character varying(160) NOT NULL,
    acquired_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    heartbeat_at timestamp with time zone NOT NULL,
    CONSTRAINT worker_leases_heartbeat_range CHECK (((heartbeat_at >= acquired_at) AND (heartbeat_at <= expires_at))),
    CONSTRAINT worker_leases_valid_range CHECK ((expires_at > acquired_at))
);


--
-- Name: alert_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_events ALTER COLUMN id SET DEFAULT nextval('public.alert_events_id_seq'::regclass);


--
-- Name: approved_offers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_offers ALTER COLUMN id SET DEFAULT nextval('public.approved_offers_id_seq'::regclass);


--
-- Name: canonical_products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_products ALTER COLUMN id SET DEFAULT nextval('public.canonical_products_id_seq'::regclass);


--
-- Name: catalog_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_observations ALTER COLUMN id SET DEFAULT nextval('public.catalog_observations_id_seq'::regclass);


--
-- Name: extracted_offer_candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_offer_candidates ALTER COLUMN id SET DEFAULT nextval('public.extracted_offer_candidates_id_seq'::regclass);


--
-- Name: extraction_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extraction_runs ALTER COLUMN id SET DEFAULT nextval('public.extraction_runs_id_seq'::regclass);


--
-- Name: geographic_scopes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scopes ALTER COLUMN id SET DEFAULT nextval('public.geographic_scopes_id_seq'::regclass);


--
-- Name: ingestion_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_runs ALTER COLUMN id SET DEFAULT nextval('public.ingestion_runs_id_seq'::regclass);


--
-- Name: offer_conditions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_conditions ALTER COLUMN id SET DEFAULT nextval('public.offer_conditions_id_seq'::regclass);


--
-- Name: official_offer_publication_health_facts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_publication_health_facts ALTER COLUMN id SET DEFAULT nextval('public.official_offer_publication_health_facts_id_seq'::regclass);


--
-- Name: physical_store_coverage_checks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_coverage_checks ALTER COLUMN id SET DEFAULT nextval('public.physical_store_coverage_checks_id_seq'::regclass);


--
-- Name: physical_store_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_observations ALTER COLUMN id SET DEFAULT nextval('public.physical_store_observations_id_seq'::regclass);


--
-- Name: physical_stores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_stores ALTER COLUMN id SET DEFAULT nextval('public.physical_stores_id_seq'::regclass);


--
-- Name: price_coverage_checks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_coverage_checks ALTER COLUMN id SET DEFAULT nextval('public.price_coverage_checks_id_seq'::regclass);


--
-- Name: price_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations ALTER COLUMN id SET DEFAULT nextval('public.price_observations_id_seq'::regclass);


--
-- Name: private_review_evidence_consumptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions ALTER COLUMN id SET DEFAULT nextval('public.private_review_evidence_consumptions_id_seq'::regclass);


--
-- Name: private_review_evidence_renders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_renders ALTER COLUMN id SET DEFAULT nextval('public.private_review_evidence_renders_id_seq'::regclass);


--
-- Name: product_identifiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_identifiers ALTER COLUMN id SET DEFAULT nextval('public.product_identifiers_id_seq'::regclass);


--
-- Name: publication_captures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_captures ALTER COLUMN id SET DEFAULT nextval('public.publication_captures_id_seq'::regclass);


--
-- Name: publications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications ALTER COLUMN id SET DEFAULT nextval('public.publications_id_seq'::regclass);


--
-- Name: review_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_actions ALTER COLUMN id SET DEFAULT nextval('public.review_actions_id_seq'::regclass);


--
-- Name: reviewed_family_membership_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_membership_decisions ALTER COLUMN id SET DEFAULT nextval('public.reviewed_family_membership_decisions_id_seq'::regclass);


--
-- Name: source_health_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health_snapshots ALTER COLUMN id SET DEFAULT nextval('public.source_health_snapshots_id_seq'::regclass);


--
-- Name: source_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_permissions ALTER COLUMN id SET DEFAULT nextval('public.source_permissions_id_seq'::regclass);


--
-- Name: source_record_outcomes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes ALTER COLUMN id SET DEFAULT nextval('public.source_record_outcomes_id_seq'::regclass);


--
-- Name: worker_job_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_job_results ALTER COLUMN id SET DEFAULT nextval('public.worker_job_results_id_seq'::regclass);


--
-- Name: alert_events alert_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_events
    ADD CONSTRAINT alert_events_pkey PRIMARY KEY (id);


--
-- Name: approved_offers approved_offers_offer_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_offers
    ADD CONSTRAINT approved_offers_offer_key_key UNIQUE (offer_key);


--
-- Name: approved_offers approved_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_offers
    ADD CONSTRAINT approved_offers_pkey PRIMARY KEY (id);


--
-- Name: canonical_products canonical_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_products
    ADD CONSTRAINT canonical_products_pkey PRIMARY KEY (id);


--
-- Name: catalog_observations catalog_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_observations
    ADD CONSTRAINT catalog_observations_pkey PRIMARY KEY (id);


--
-- Name: catalog_observations catalog_observations_run_record_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_observations
    ADD CONSTRAINT catalog_observations_run_record_unique UNIQUE (ingestion_run_id, source_record_id);


--
-- Name: data_sources data_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_sources
    ADD CONSTRAINT data_sources_pkey PRIMARY KEY (id);


--
-- Name: extracted_offer_candidates extracted_offer_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_offer_candidates
    ADD CONSTRAINT extracted_offer_candidates_pkey PRIMARY KEY (id);


--
-- Name: extracted_offer_candidates extracted_offer_candidates_run_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_offer_candidates
    ADD CONSTRAINT extracted_offer_candidates_run_key_unique UNIQUE (extraction_run_id, candidate_key);


--
-- Name: extraction_runs extraction_runs_capture_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extraction_runs
    ADD CONSTRAINT extraction_runs_capture_version_unique UNIQUE (capture_id, extractor_version);


--
-- Name: extraction_runs extraction_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extraction_runs
    ADD CONSTRAINT extraction_runs_pkey PRIMARY KEY (id);


--
-- Name: family_taxonomy_versions family_taxonomy_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_taxonomy_versions
    ADD CONSTRAINT family_taxonomy_versions_pkey PRIMARY KEY (version_id);


--
-- Name: family_taxonomy_versions family_taxonomy_versions_taxonomy_publication_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_taxonomy_versions
    ADD CONSTRAINT family_taxonomy_versions_taxonomy_publication_unique UNIQUE (taxonomy_id, published_at);


--
-- Name: family_taxonomy_versions family_taxonomy_versions_taxonomy_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_taxonomy_versions
    ADD CONSTRAINT family_taxonomy_versions_taxonomy_version_unique UNIQUE (taxonomy_id, taxonomy_version);


--
-- Name: geographic_postal_directory_codes geographic_postal_directory_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_postal_directory_codes
    ADD CONSTRAINT geographic_postal_directory_codes_pkey PRIMARY KEY (version_id, region_code, postal_code);


--
-- Name: geographic_postal_directory_codes geographic_postal_directory_codes_version_postal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_postal_directory_codes
    ADD CONSTRAINT geographic_postal_directory_codes_version_postal_unique UNIQUE (version_id, postal_code);


--
-- Name: geographic_postal_directory_regions geographic_postal_directory_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_postal_directory_regions
    ADD CONSTRAINT geographic_postal_directory_regions_pkey PRIMARY KEY (version_id, region_code);


--
-- Name: geographic_postal_directory_versions geographic_postal_directory_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_postal_directory_versions
    ADD CONSTRAINT geographic_postal_directory_versions_pkey PRIMARY KEY (version_id);


--
-- Name: geographic_scope_postal_codes geographic_scope_postal_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_postal_codes
    ADD CONSTRAINT geographic_scope_postal_codes_pkey PRIMARY KEY (scope_id, postal_code);


--
-- Name: geographic_scope_regions geographic_scope_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_regions
    ADD CONSTRAINT geographic_scope_regions_pkey PRIMARY KEY (scope_id, region_code);


--
-- Name: geographic_scope_stores geographic_scope_stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_stores
    ADD CONSTRAINT geographic_scope_stores_pkey PRIMARY KEY (scope_id, store_id);


--
-- Name: geographic_scopes geographic_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scopes
    ADD CONSTRAINT geographic_scopes_pkey PRIMARY KEY (id);


--
-- Name: geographic_scopes geographic_scopes_scope_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scopes
    ADD CONSTRAINT geographic_scopes_scope_key_key UNIQUE (scope_key);


--
-- Name: ingestion_runs ingestion_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_runs
    ADD CONSTRAINT ingestion_runs_pkey PRIMARY KEY (id);


--
-- Name: offer_conditions offer_conditions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_conditions
    ADD CONSTRAINT offer_conditions_pkey PRIMARY KEY (id);


--
-- Name: offer_targets offer_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_targets
    ADD CONSTRAINT offer_targets_pkey PRIMARY KEY (offer_id);


--
-- Name: official_offer_lifecycle_job_results official_offer_lifecycle_job_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_lifecycle_job_results
    ADD CONSTRAINT official_offer_lifecycle_job_results_pkey PRIMARY KEY (job_id);


--
-- Name: official_offer_lifecycle_leases official_offer_lifecycle_leases_lease_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_lifecycle_leases
    ADD CONSTRAINT official_offer_lifecycle_leases_lease_token_key UNIQUE (lease_token);


--
-- Name: official_offer_lifecycle_leases official_offer_lifecycle_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_lifecycle_leases
    ADD CONSTRAINT official_offer_lifecycle_leases_pkey PRIMARY KEY (source_id);


--
-- Name: official_offer_publication_health_facts official_offer_publication_health_facts_lifecycle_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_publication_health_facts
    ADD CONSTRAINT official_offer_publication_health_facts_lifecycle_job_id_key UNIQUE (lifecycle_job_id);


--
-- Name: official_offer_publication_health_facts official_offer_publication_health_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_publication_health_facts
    ADD CONSTRAINT official_offer_publication_health_facts_pkey PRIMARY KEY (id);


--
-- Name: official_offer_publication_policy official_offer_publication_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_publication_policy
    ADD CONSTRAINT official_offer_publication_policy_pkey PRIMARY KEY (policy_key);


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_coverage_checks
    ADD CONSTRAINT physical_store_coverage_checks_pkey PRIMARY KEY (id);


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_run_chain_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_coverage_checks
    ADD CONSTRAINT physical_store_coverage_checks_run_chain_unique UNIQUE (ingestion_run_id, chain);


--
-- Name: physical_store_observations physical_store_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_observations
    ADD CONSTRAINT physical_store_observations_pkey PRIMARY KEY (id);


--
-- Name: physical_store_observations physical_store_observations_run_branch_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_observations
    ADD CONSTRAINT physical_store_observations_run_branch_unique UNIQUE (ingestion_run_id, branch_key);


--
-- Name: physical_store_observations physical_store_observations_run_external_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_observations
    ADD CONSTRAINT physical_store_observations_run_external_unique UNIQUE (ingestion_run_id, source_id, external_id);


--
-- Name: physical_stores physical_stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_stores
    ADD CONSTRAINT physical_stores_pkey PRIMARY KEY (id);


--
-- Name: physical_stores physical_stores_source_external_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_stores
    ADD CONSTRAINT physical_stores_source_external_unique UNIQUE (source_id, external_id);


--
-- Name: price_cache price_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_cache
    ADD CONSTRAINT price_cache_pkey PRIMARY KEY (ean, chain);


--
-- Name: price_coverage_checks price_coverage_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_coverage_checks
    ADD CONSTRAINT price_coverage_checks_pkey PRIMARY KEY (id);


--
-- Name: price_observations price_observations_evidence_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations
    ADD CONSTRAINT price_observations_evidence_key_key UNIQUE (evidence_key);


--
-- Name: price_observations price_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations
    ADD CONSTRAINT price_observations_pkey PRIMARY KEY (id);


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_evidence_render_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions
    ADD CONSTRAINT private_review_evidence_consumptions_evidence_render_id_key UNIQUE (evidence_render_id);


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions
    ADD CONSTRAINT private_review_evidence_consumptions_pkey PRIMARY KEY (id);


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_review_action_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions
    ADD CONSTRAINT private_review_evidence_consumptions_review_action_id_key UNIQUE (review_action_id);


--
-- Name: private_review_evidence_renders private_review_evidence_renders_evidence_proof_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_renders
    ADD CONSTRAINT private_review_evidence_renders_evidence_proof_sha256_key UNIQUE (evidence_proof_sha256);


--
-- Name: private_review_evidence_renders private_review_evidence_renders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_renders
    ADD CONSTRAINT private_review_evidence_renders_pkey PRIMARY KEY (id);


--
-- Name: product_families product_families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_families
    ADD CONSTRAINT product_families_pkey PRIMARY KEY (slug);


--
-- Name: product_family_memberships product_family_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_family_memberships
    ADD CONSTRAINT product_family_memberships_pkey PRIMARY KEY (product_id, family_slug);


--
-- Name: product_identifiers product_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_identifiers
    ADD CONSTRAINT product_identifiers_pkey PRIMARY KEY (id);


--
-- Name: publication_captures publication_captures_checksum_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_captures
    ADD CONSTRAINT publication_captures_checksum_unique UNIQUE (publication_id, checksum);


--
-- Name: publication_captures publication_captures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_captures
    ADD CONSTRAINT publication_captures_pkey PRIMARY KEY (id);


--
-- Name: publications publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (id);


--
-- Name: publications publications_source_external_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_source_external_unique UNIQUE (source_id, external_id);


--
-- Name: review_actions review_actions_candidate_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_actions
    ADD CONSTRAINT review_actions_candidate_version_unique UNIQUE (candidate_id, expected_version);


--
-- Name: review_actions review_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_actions
    ADD CONSTRAINT review_actions_pkey PRIMARY KEY (id);


--
-- Name: reviewed_family_aliases reviewed_family_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_aliases
    ADD CONSTRAINT reviewed_family_aliases_pkey PRIMARY KEY (version_id, alias);


--
-- Name: reviewed_family_definitions reviewed_family_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_definitions
    ADD CONSTRAINT reviewed_family_definitions_pkey PRIMARY KEY (version_id, family_id);


--
-- Name: reviewed_family_definitions reviewed_family_definitions_version_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_definitions
    ADD CONSTRAINT reviewed_family_definitions_version_slug_unique UNIQUE (version_id, slug);


--
-- Name: reviewed_family_membership_decisions reviewed_family_membership_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_membership_decisions
    ADD CONSTRAINT reviewed_family_membership_decisions_pkey PRIMARY KEY (id);


--
-- Name: source_health_snapshots source_health_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_pkey PRIMARY KEY (id);


--
-- Name: source_permissions source_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_permissions
    ADD CONSTRAINT source_permissions_pkey PRIMARY KEY (id);


--
-- Name: source_products source_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_products
    ADD CONSTRAINT source_products_pkey PRIMARY KEY (source_id, external_id);


--
-- Name: source_record_outcomes source_record_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_pkey PRIMARY KEY (id);


--
-- Name: source_record_outcomes source_record_outcomes_run_kind_record_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_run_kind_record_unique UNIQUE (ingestion_run_id, record_kind, source_record_id);


--
-- Name: worker_job_results worker_job_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_job_results
    ADD CONSTRAINT worker_job_results_pkey PRIMARY KEY (id);


--
-- Name: worker_leases worker_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_leases
    ADD CONSTRAINT worker_leases_pkey PRIMARY KEY (lease_key);


--
-- Name: alert_events_key_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_events_key_time_idx ON public.alert_events USING btree (alert_key, opened_at DESC);


--
-- Name: alert_events_operations_checkpoint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_events_operations_checkpoint_idx ON public.alert_events USING btree (id DESC) WHERE ((operations_boundary_version = 1) AND ((alert_key)::text = 'operations.evaluation-checkpoint'::text) AND (source_id IS NULL));


--
-- Name: alert_events_operations_identity_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_events_operations_identity_time_idx ON public.alert_events USING btree (alert_key, source_id, persisted_at DESC, id DESC) WHERE (operations_boundary_version = 1);


--
-- Name: approved_offers_candidate_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approved_offers_candidate_unique ON public.approved_offers USING btree (candidate_id) WHERE (candidate_id IS NOT NULL);


--
-- Name: catalog_observations_category_path_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_observations_category_path_gin_idx ON public.catalog_observations USING gin (category_path jsonb_path_ops) WHERE (category_path IS NOT NULL);


--
-- Name: catalog_observations_gtin_retrieved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_observations_gtin_retrieved_idx ON public.catalog_observations USING btree (gtin, retrieved_at DESC, id DESC);


--
-- Name: catalog_observations_product_retrieved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_observations_product_retrieved_idx ON public.catalog_observations USING btree (canonical_product_id, retrieved_at DESC, id DESC);


--
-- Name: extracted_offer_candidates_pending_anomalies_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extracted_offer_candidates_pending_anomalies_idx ON public.extracted_offer_candidates USING gin (anomaly_codes jsonb_path_ops) WHERE ((status)::text = 'pending'::text);


--
-- Name: extracted_offer_candidates_pending_confidence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extracted_offer_candidates_pending_confidence_idx ON public.extracted_offer_candidates USING btree (confidence, created_at, id) WHERE ((status)::text = 'pending'::text);


--
-- Name: extracted_offer_candidates_pending_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extracted_offer_candidates_pending_queue_idx ON public.extracted_offer_candidates USING btree (created_at, id) INCLUDE (extraction_run_id, confidence) WHERE ((status)::text = 'pending'::text);


--
-- Name: extraction_runs_permission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extraction_runs_permission_idx ON public.extraction_runs USING btree (extraction_permission_id) WHERE (extraction_permission_id IS NOT NULL);


--
-- Name: geographic_postal_directory_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geographic_postal_directory_effective_idx ON public.geographic_postal_directory_versions USING btree (country_code, reviewed_at DESC, sealed_at DESC, version_id);


--
-- Name: historical_price_statistics_identity_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX historical_price_statistics_identity_uidx ON public.historical_price_statistics USING btree (product_id, chain, geographic_scope_id, window_start, window_end) NULLS NOT DISTINCT;


--
-- Name: ingestion_runs_job_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ingestion_runs_job_id_unique ON public.ingestion_runs USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: official_offer_publication_health_final_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX official_offer_publication_health_final_state_idx ON public.approved_offers USING btree (source_id, updated_at) WHERE ((status)::text = 'published'::text);


--
-- Name: official_offer_publication_health_source_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX official_offer_publication_health_source_time_idx ON public.official_offer_publication_health_facts USING btree (source_id, persisted_at DESC, id DESC);


--
-- Name: physical_store_coverage_checks_run_chain_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX physical_store_coverage_checks_run_chain_state_idx ON public.physical_store_coverage_checks USING btree (ingestion_run_id, chain, state, checked_at);


--
-- Name: physical_store_observations_run_chain_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX physical_store_observations_run_chain_status_idx ON public.physical_store_observations USING btree (ingestion_run_id, chain, status, branch_key);


--
-- Name: price_coverage_checks_run_product_chain_scope_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX price_coverage_checks_run_product_chain_scope_uidx ON public.price_coverage_checks USING btree (ingestion_run_id, product_id, chain, geographic_scope_id) NULLS NOT DISTINCT;


--
-- Name: price_observations_product_chain_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_observations_product_chain_time_idx ON public.price_observations USING btree (product_id, chain, observed_at DESC);


--
-- Name: price_observations_source_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_observations_source_run_idx ON public.price_observations USING btree (source_id, ingestion_run_id);


--
-- Name: private_review_evidence_renders_candidate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_review_evidence_renders_candidate_idx ON public.private_review_evidence_renders USING btree (candidate_id, expected_version, rendered_at, id);


--
-- Name: product_identifiers_gtin_value_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_identifiers_gtin_value_unique ON public.product_identifiers USING btree (value) WHERE ((scheme)::text = ANY (ARRAY[('ean8'::character varying)::text, ('ean13'::character varying)::text]));


--
-- Name: product_identifiers_source_value_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_identifiers_source_value_unique ON public.product_identifiers USING btree (source_id, value) WHERE ((scheme)::text = 'source'::text);


--
-- Name: provider_request_budget_events_provider_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_request_budget_events_provider_time_idx ON public.provider_request_budget_events USING btree (provider_key, claimed_at);


--
-- Name: public_api_request_budget_events_route_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX public_api_request_budget_events_route_time_idx ON public.public_api_request_budget_events USING btree (route_key, claimed_at);


--
-- Name: publication_captures_permission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_captures_permission_idx ON public.publication_captures USING btree (capture_permission_id) WHERE (capture_permission_id IS NOT NULL);


--
-- Name: publications_discovery_permission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_discovery_permission_idx ON public.publications USING btree (discovery_permission_id) WHERE (discovery_permission_id IS NOT NULL);


--
-- Name: publications_review_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_review_scope_idx ON public.publications USING btree (chain, geographic_scope_id, id);


--
-- Name: review_actions_candidate_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_actions_candidate_time_idx ON public.review_actions USING btree (candidate_id, acted_at, id);


--
-- Name: reviewed_family_membership_decisions_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviewed_family_membership_decisions_latest_idx ON public.reviewed_family_membership_decisions USING btree (version_id, family_id, product_id, reviewed_at DESC, id DESC);


--
-- Name: source_health_snapshots_operations_source_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_health_snapshots_operations_source_time_idx ON public.source_health_snapshots USING btree (source_id, persisted_at DESC, id DESC) WHERE ((operations_boundary_version = 1) AND (geographic_scope_id IS NULL));


--
-- Name: source_health_snapshots_source_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_health_snapshots_source_time_idx ON public.source_health_snapshots USING btree (source_id, recorded_at DESC);


--
-- Name: source_health_snapshots_worker_job_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_health_snapshots_worker_job_uidx ON public.source_health_snapshots USING btree (worker_job_id) WHERE (worker_job_id IS NOT NULL);


--
-- Name: worker_job_results_job_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX worker_job_results_job_id_unique ON public.worker_job_results USING btree (job_id);


--
-- Name: worker_job_results_operations_source_kind_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_job_results_operations_source_kind_time_idx ON public.worker_job_results USING btree (source_id, job_kind, persisted_at DESC, id DESC) WHERE (operations_boundary_version = 1);


--
-- Name: worker_job_results_source_kind_schedule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_job_results_source_kind_schedule_idx ON public.worker_job_results USING btree (source_id, job_kind, scheduled_at DESC, id DESC);


--
-- Name: alert_events alert_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alert_events_append_only BEFORE DELETE OR UPDATE ON public.alert_events FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: alert_events alert_events_operations_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alert_events_operations_boundary BEFORE INSERT ON public.alert_events FOR EACH ROW EXECUTE FUNCTION public.stamp_operations_runtime_boundary_v1();


--
-- Name: approved_offers approved_offers_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approved_offers_creation_clock BEFORE INSERT ON public.approved_offers FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: approved_offers approved_offers_insert_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approved_offers_insert_boundary BEFORE INSERT ON public.approved_offers FOR EACH ROW EXECUTE FUNCTION public.enforce_approved_offer_insert_boundary();


--
-- Name: approved_offers approved_offers_state_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approved_offers_state_clock BEFORE INSERT OR UPDATE ON public.approved_offers FOR EACH ROW EXECUTE FUNCTION public.stamp_approved_offer_state_clock();


--
-- Name: approved_offers approved_offers_z_lifecycle_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approved_offers_z_lifecycle_transition BEFORE UPDATE ON public.approved_offers FOR EACH ROW EXECUTE FUNCTION public.enforce_approved_offer_lifecycle_transition_v1();


--
-- Name: canonical_products canonical_products_public_state_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER canonical_products_public_state_clock BEFORE INSERT OR UPDATE ON public.canonical_products FOR EACH ROW EXECUTE FUNCTION public.stamp_public_state_change();


--
-- Name: catalog_observations catalog_observations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_observations_append_only BEFORE DELETE OR UPDATE ON public.catalog_observations FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: catalog_observations catalog_observations_category_path_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_observations_category_path_guard BEFORE INSERT OR UPDATE OF category_path ON public.catalog_observations FOR EACH ROW EXECUTE FUNCTION public.enforce_catalog_observation_category_path();


--
-- Name: catalog_observations catalog_observations_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_observations_creation_clock BEFORE INSERT ON public.catalog_observations FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: catalog_observations catalog_observations_running_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_observations_running_run_guard BEFORE INSERT ON public.catalog_observations FOR EACH ROW EXECUTE FUNCTION public.enforce_running_ingestion_evidence_insert();


--
-- Name: data_sources data_sources_governance_fence_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER data_sources_governance_fence_lock BEFORE UPDATE OF runtime_state, permission_reviewed_at, permission_expires_at ON public.data_sources FOR EACH ROW EXECUTE FUNCTION public.lock_data_source_governance_fence();


--
-- Name: data_sources data_sources_public_state_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER data_sources_public_state_clock BEFORE INSERT OR UPDATE ON public.data_sources FOR EACH ROW EXECUTE FUNCTION public.stamp_public_state_change();


--
-- Name: extracted_offer_candidates extracted_offer_candidates_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER extracted_offer_candidates_append_only BEFORE DELETE OR UPDATE ON public.extracted_offer_candidates FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: extracted_offer_candidates extracted_offer_candidates_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER extracted_offer_candidates_creation_clock BEFORE INSERT ON public.extracted_offer_candidates FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: extraction_runs extraction_runs_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER extraction_runs_creation_clock BEFORE INSERT ON public.extraction_runs FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: extraction_runs extraction_runs_trust_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER extraction_runs_trust_boundary BEFORE INSERT OR DELETE OR UPDATE ON public.extraction_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_run_trust_fence();


--
-- Name: family_taxonomy_versions family_taxonomy_versions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER family_taxonomy_versions_append_only BEFORE DELETE OR UPDATE ON public.family_taxonomy_versions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: family_taxonomy_versions family_taxonomy_versions_publication_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER family_taxonomy_versions_publication_check AFTER INSERT ON public.family_taxonomy_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_family_taxonomy_publication();


--
-- Name: geographic_postal_directory_codes geographic_postal_directory_codes_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_postal_directory_codes_creation_clock BEFORE INSERT ON public.geographic_postal_directory_codes FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: geographic_postal_directory_codes geographic_postal_directory_codes_lifecycle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_postal_directory_codes_lifecycle_guard BEFORE INSERT OR DELETE OR UPDATE ON public.geographic_postal_directory_codes FOR EACH ROW EXECUTE FUNCTION public.guard_geographic_postal_directory_child();


--
-- Name: geographic_postal_directory_regions geographic_postal_directory_regions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_postal_directory_regions_creation_clock BEFORE INSERT ON public.geographic_postal_directory_regions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: geographic_postal_directory_regions geographic_postal_directory_regions_lifecycle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_postal_directory_regions_lifecycle_guard BEFORE INSERT OR DELETE OR UPDATE ON public.geographic_postal_directory_regions FOR EACH ROW EXECUTE FUNCTION public.guard_geographic_postal_directory_child();


--
-- Name: geographic_postal_directory_versions geographic_postal_directory_versions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_postal_directory_versions_creation_clock BEFORE INSERT ON public.geographic_postal_directory_versions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: geographic_postal_directory_versions geographic_postal_directory_versions_lifecycle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_postal_directory_versions_lifecycle_guard BEFORE INSERT OR DELETE OR UPDATE ON public.geographic_postal_directory_versions FOR EACH ROW EXECUTE FUNCTION public.guard_geographic_postal_directory_version();


--
-- Name: geographic_scope_postal_codes geographic_scope_postal_codes_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_postal_codes_append_only BEFORE DELETE OR UPDATE ON public.geographic_scope_postal_codes FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: geographic_scope_postal_codes geographic_scope_postal_codes_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_postal_codes_creation_clock BEFORE INSERT ON public.geographic_scope_postal_codes FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: geographic_scope_postal_codes geographic_scope_postal_codes_member_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_postal_codes_member_limit BEFORE INSERT ON public.geographic_scope_postal_codes FOR EACH ROW EXECUTE FUNCTION public.enforce_geographic_scope_member_limit();


--
-- Name: geographic_scope_regions geographic_scope_regions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_regions_append_only BEFORE DELETE OR UPDATE ON public.geographic_scope_regions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: geographic_scope_regions geographic_scope_regions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_regions_creation_clock BEFORE INSERT ON public.geographic_scope_regions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: geographic_scope_regions geographic_scope_regions_member_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_regions_member_limit BEFORE INSERT ON public.geographic_scope_regions FOR EACH ROW EXECUTE FUNCTION public.enforce_geographic_scope_member_limit();


--
-- Name: geographic_scope_stores geographic_scope_stores_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_stores_append_only BEFORE DELETE OR UPDATE ON public.geographic_scope_stores FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: geographic_scope_stores geographic_scope_stores_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_stores_creation_clock BEFORE INSERT ON public.geographic_scope_stores FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: geographic_scope_stores geographic_scope_stores_member_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scope_stores_member_limit BEFORE INSERT ON public.geographic_scope_stores FOR EACH ROW EXECUTE FUNCTION public.enforce_geographic_scope_member_limit();


--
-- Name: geographic_scopes geographic_scopes_offer_identity_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scopes_offer_identity_boundary BEFORE UPDATE OF scope_kind, country_code ON public.geographic_scopes FOR EACH ROW EXECUTE FUNCTION public.enforce_official_offer_scope_identity_immutability();


--
-- Name: geographic_scopes geographic_scopes_public_state_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER geographic_scopes_public_state_clock BEFORE INSERT OR UPDATE ON public.geographic_scopes FOR EACH ROW EXECUTE FUNCTION public.stamp_public_state_change();


--
-- Name: ingestion_runs ingestion_runs_lifecycle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ingestion_runs_lifecycle_guard BEFORE INSERT OR DELETE OR UPDATE ON public.ingestion_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_ingestion_run_lifecycle();


--
-- Name: ingestion_runs ingestion_runs_physical_store_completion_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ingestion_runs_physical_store_completion_guard AFTER UPDATE ON public.ingestion_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_completed_physical_store_run_consistency();


--
-- Name: offer_conditions offer_conditions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offer_conditions_creation_clock BEFORE INSERT ON public.offer_conditions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: offer_conditions offer_conditions_mutation_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offer_conditions_mutation_fence BEFORE INSERT OR DELETE OR UPDATE ON public.offer_conditions FOR EACH ROW EXECUTE FUNCTION public.guard_official_offer_condition_mutation();


--
-- Name: offer_targets offer_targets_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offer_targets_creation_clock BEFORE INSERT ON public.offer_targets FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: official_offer_lifecycle_job_results official_offer_lifecycle_job_results_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER official_offer_lifecycle_job_results_append_only BEFORE DELETE OR UPDATE ON public.official_offer_lifecycle_job_results FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: official_offer_lifecycle_job_results official_offer_lifecycle_publication_health; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER official_offer_lifecycle_publication_health AFTER INSERT ON public.official_offer_lifecycle_job_results FOR EACH ROW EXECUTE FUNCTION public.record_official_offer_publication_health_v1();


--
-- Name: official_offer_publication_health_facts official_offer_publication_health_facts_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER official_offer_publication_health_facts_append_only BEFORE DELETE OR UPDATE ON public.official_offer_publication_health_facts FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER physical_store_coverage_checks_append_only BEFORE DELETE OR UPDATE ON public.physical_store_coverage_checks FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER physical_store_coverage_checks_creation_clock BEFORE INSERT ON public.physical_store_coverage_checks FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_running_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER physical_store_coverage_checks_running_run_guard BEFORE INSERT ON public.physical_store_coverage_checks FOR EACH ROW EXECUTE FUNCTION public.enforce_running_physical_store_evidence_insert();


--
-- Name: physical_store_observations physical_store_observations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER physical_store_observations_append_only BEFORE DELETE OR UPDATE ON public.physical_store_observations FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: physical_store_observations physical_store_observations_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER physical_store_observations_creation_clock BEFORE INSERT ON public.physical_store_observations FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: physical_store_observations physical_store_observations_running_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER physical_store_observations_running_run_guard BEFORE INSERT ON public.physical_store_observations FOR EACH ROW EXECUTE FUNCTION public.enforce_running_physical_store_evidence_insert();


--
-- Name: price_coverage_checks price_coverage_checks_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_coverage_checks_append_only BEFORE DELETE OR UPDATE ON public.price_coverage_checks FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: price_coverage_checks price_coverage_checks_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_coverage_checks_creation_clock BEFORE INSERT ON public.price_coverage_checks FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: price_coverage_checks price_coverage_checks_running_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_coverage_checks_running_run_guard BEFORE INSERT ON public.price_coverage_checks FOR EACH ROW EXECUTE FUNCTION public.enforce_running_ingestion_evidence_insert();


--
-- Name: price_observations price_observations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_observations_append_only BEFORE DELETE OR UPDATE ON public.price_observations FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: price_observations price_observations_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_observations_creation_clock BEFORE INSERT ON public.price_observations FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: price_observations price_observations_running_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_observations_running_run_guard BEFORE INSERT ON public.price_observations FOR EACH ROW EXECUTE FUNCTION public.enforce_running_ingestion_evidence_insert();


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER private_review_evidence_consumptions_append_only BEFORE DELETE OR UPDATE ON public.private_review_evidence_consumptions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: private_review_evidence_renders private_review_evidence_renders_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER private_review_evidence_renders_append_only BEFORE DELETE OR UPDATE ON public.private_review_evidence_renders FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: product_identifiers product_identifiers_public_state_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_identifiers_public_state_clock BEFORE INSERT OR UPDATE ON public.product_identifiers FOR EACH ROW EXECUTE FUNCTION public.stamp_public_state_change();


--
-- Name: publication_captures publication_captures_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publication_captures_append_only BEFORE DELETE OR UPDATE ON public.publication_captures FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: publication_captures publication_captures_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publication_captures_creation_clock BEFORE INSERT ON public.publication_captures FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: publication_captures publication_captures_permission_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publication_captures_permission_boundary BEFORE INSERT ON public.publication_captures FOR EACH ROW EXECUTE FUNCTION public.enforce_capture_permission_fence();


--
-- Name: publications publications_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publications_creation_clock BEFORE INSERT ON public.publications FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: publications publications_offer_identity_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publications_offer_identity_boundary BEFORE INSERT OR UPDATE ON public.publications FOR EACH ROW EXECUTE FUNCTION public.enforce_publication_offer_identity();


--
-- Name: review_actions review_actions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_actions_append_only BEFORE DELETE OR UPDATE ON public.review_actions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: review_actions review_actions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_actions_creation_clock BEFORE INSERT ON public.review_actions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: review_actions review_actions_z_decision_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_actions_z_decision_clock BEFORE INSERT ON public.review_actions FOR EACH ROW EXECUTE FUNCTION public.stamp_private_review_action_decision_clock();


--
-- Name: reviewed_family_aliases reviewed_family_aliases_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reviewed_family_aliases_append_only BEFORE DELETE OR UPDATE ON public.reviewed_family_aliases FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: reviewed_family_aliases reviewed_family_aliases_build_window; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reviewed_family_aliases_build_window BEFORE INSERT ON public.reviewed_family_aliases FOR EACH ROW EXECUTE FUNCTION public.enforce_family_taxonomy_build_window();


--
-- Name: reviewed_family_aliases reviewed_family_aliases_publication_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER reviewed_family_aliases_publication_check AFTER INSERT ON public.reviewed_family_aliases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_family_taxonomy_publication();


--
-- Name: reviewed_family_definitions reviewed_family_definitions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reviewed_family_definitions_append_only BEFORE DELETE OR UPDATE ON public.reviewed_family_definitions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: reviewed_family_definitions reviewed_family_definitions_build_window; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reviewed_family_definitions_build_window BEFORE INSERT ON public.reviewed_family_definitions FOR EACH ROW EXECUTE FUNCTION public.enforce_family_taxonomy_build_window();


--
-- Name: reviewed_family_definitions reviewed_family_definitions_publication_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER reviewed_family_definitions_publication_check AFTER INSERT ON public.reviewed_family_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_family_taxonomy_publication();


--
-- Name: reviewed_family_membership_decisions reviewed_family_membership_decisions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reviewed_family_membership_decisions_append_only BEFORE DELETE OR UPDATE ON public.reviewed_family_membership_decisions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: reviewed_family_membership_decisions reviewed_family_membership_decisions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reviewed_family_membership_decisions_creation_clock BEFORE INSERT ON public.reviewed_family_membership_decisions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: source_health_snapshots source_health_snapshots_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_health_snapshots_append_only BEFORE DELETE OR UPDATE ON public.source_health_snapshots FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: source_health_snapshots source_health_snapshots_operations_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_health_snapshots_operations_boundary BEFORE INSERT ON public.source_health_snapshots FOR EACH ROW EXECUTE FUNCTION public.stamp_operations_runtime_boundary_v1();


--
-- Name: source_health_snapshots source_health_snapshots_worker_contract; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_health_snapshots_worker_contract BEFORE INSERT ON public.source_health_snapshots FOR EACH ROW EXECUTE FUNCTION public.validate_worker_source_health_snapshot();


--
-- Name: source_permissions source_permissions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_permissions_append_only BEFORE DELETE OR UPDATE ON public.source_permissions FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: source_permissions source_permissions_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_permissions_creation_clock BEFORE INSERT ON public.source_permissions FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: source_permissions source_permissions_governance_fence_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_permissions_governance_fence_lock BEFORE INSERT ON public.source_permissions FOR EACH ROW EXECUTE FUNCTION public.lock_source_permission_governance_fence();


--
-- Name: source_record_outcomes source_record_outcomes_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_record_outcomes_append_only BEFORE DELETE OR UPDATE ON public.source_record_outcomes FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: source_record_outcomes source_record_outcomes_creation_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_record_outcomes_creation_clock BEFORE INSERT ON public.source_record_outcomes FOR EACH ROW EXECUTE FUNCTION public.stamp_persisted_creation_clock();


--
-- Name: source_record_outcomes source_record_outcomes_running_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_record_outcomes_running_run_guard BEFORE INSERT ON public.source_record_outcomes FOR EACH ROW EXECUTE FUNCTION public.enforce_running_ingestion_evidence_insert();


--
-- Name: worker_job_results worker_job_results_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER worker_job_results_append_only BEFORE DELETE OR UPDATE ON public.worker_job_results FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();


--
-- Name: worker_job_results worker_job_results_official_offer_lifecycle_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER worker_job_results_official_offer_lifecycle_boundary BEFORE INSERT ON public.worker_job_results FOR EACH ROW EXECUTE FUNCTION public.enforce_official_offer_lifecycle_job_boundary_v1();


--
-- Name: worker_job_results worker_job_results_operations_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER worker_job_results_operations_boundary BEFORE INSERT ON public.worker_job_results FOR EACH ROW EXECUTE FUNCTION public.stamp_operations_runtime_boundary_v1();


--
-- Name: alert_events alert_events_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_events
    ADD CONSTRAINT alert_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: approved_offers approved_offers_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_offers
    ADD CONSTRAINT approved_offers_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.extracted_offer_candidates(id);


--
-- Name: approved_offers approved_offers_geographic_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_offers
    ADD CONSTRAINT approved_offers_geographic_scope_id_fkey FOREIGN KEY (geographic_scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: approved_offers approved_offers_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_offers
    ADD CONSTRAINT approved_offers_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: catalog_observations catalog_observations_canonical_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_observations
    ADD CONSTRAINT catalog_observations_canonical_product_id_fkey FOREIGN KEY (canonical_product_id) REFERENCES public.canonical_products(id);


--
-- Name: catalog_observations catalog_observations_ingestion_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_observations
    ADD CONSTRAINT catalog_observations_ingestion_run_id_fkey FOREIGN KEY (ingestion_run_id) REFERENCES public.ingestion_runs(id);


--
-- Name: extracted_offer_candidates extracted_offer_candidates_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_offer_candidates
    ADD CONSTRAINT extracted_offer_candidates_extraction_run_id_fkey FOREIGN KEY (extraction_run_id) REFERENCES public.extraction_runs(id);


--
-- Name: extraction_runs extraction_runs_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extraction_runs
    ADD CONSTRAINT extraction_runs_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.publication_captures(id);


--
-- Name: extraction_runs extraction_runs_extraction_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extraction_runs
    ADD CONSTRAINT extraction_runs_extraction_permission_id_fkey FOREIGN KEY (extraction_permission_id) REFERENCES public.source_permissions(id);


--
-- Name: extraction_runs extraction_runs_ocr_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extraction_runs
    ADD CONSTRAINT extraction_runs_ocr_permission_id_fkey FOREIGN KEY (ocr_permission_id) REFERENCES public.source_permissions(id);


--
-- Name: geographic_postal_directory_codes geographic_postal_directory_codes_region_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_postal_directory_codes
    ADD CONSTRAINT geographic_postal_directory_codes_region_fk FOREIGN KEY (version_id, region_code) REFERENCES public.geographic_postal_directory_regions(version_id, region_code);


--
-- Name: geographic_postal_directory_regions geographic_postal_directory_regions_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_postal_directory_regions
    ADD CONSTRAINT geographic_postal_directory_regions_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.geographic_postal_directory_versions(version_id);


--
-- Name: geographic_scope_postal_codes geographic_scope_postal_codes_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_postal_codes
    ADD CONSTRAINT geographic_scope_postal_codes_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: geographic_scope_regions geographic_scope_regions_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_regions
    ADD CONSTRAINT geographic_scope_regions_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: geographic_scope_stores geographic_scope_stores_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_stores
    ADD CONSTRAINT geographic_scope_stores_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: geographic_scope_stores geographic_scope_stores_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geographic_scope_stores
    ADD CONSTRAINT geographic_scope_stores_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.physical_stores(id);


--
-- Name: historical_price_statistics historical_price_statistics_geographic_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_price_statistics
    ADD CONSTRAINT historical_price_statistics_geographic_scope_id_fkey FOREIGN KEY (geographic_scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: historical_price_statistics historical_price_statistics_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_price_statistics
    ADD CONSTRAINT historical_price_statistics_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: ingestion_runs ingestion_runs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_runs
    ADD CONSTRAINT ingestion_runs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: offer_conditions offer_conditions_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_conditions
    ADD CONSTRAINT offer_conditions_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.approved_offers(id);


--
-- Name: offer_targets offer_targets_family_slug_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_targets
    ADD CONSTRAINT offer_targets_family_slug_fkey FOREIGN KEY (family_slug) REFERENCES public.product_families(slug);


--
-- Name: offer_targets offer_targets_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_targets
    ADD CONSTRAINT offer_targets_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.approved_offers(id);


--
-- Name: offer_targets offer_targets_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offer_targets
    ADD CONSTRAINT offer_targets_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: official_offer_lifecycle_job_results official_offer_lifecycle_job_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_lifecycle_job_results
    ADD CONSTRAINT official_offer_lifecycle_job_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.worker_job_results(job_id);


--
-- Name: official_offer_lifecycle_job_results official_offer_lifecycle_job_results_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_lifecycle_job_results
    ADD CONSTRAINT official_offer_lifecycle_job_results_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: official_offer_lifecycle_leases official_offer_lifecycle_leases_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_lifecycle_leases
    ADD CONSTRAINT official_offer_lifecycle_leases_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: official_offer_publication_health_facts official_offer_publication_health_facts_lifecycle_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_publication_health_facts
    ADD CONSTRAINT official_offer_publication_health_facts_lifecycle_job_id_fkey FOREIGN KEY (lifecycle_job_id) REFERENCES public.official_offer_lifecycle_job_results(job_id);


--
-- Name: official_offer_publication_health_facts official_offer_publication_health_facts_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_offer_publication_health_facts
    ADD CONSTRAINT official_offer_publication_health_facts_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_ingestion_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_coverage_checks
    ADD CONSTRAINT physical_store_coverage_checks_ingestion_run_id_fkey FOREIGN KEY (ingestion_run_id) REFERENCES public.ingestion_runs(id);


--
-- Name: physical_store_coverage_checks physical_store_coverage_checks_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_coverage_checks
    ADD CONSTRAINT physical_store_coverage_checks_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: physical_store_observations physical_store_observations_ingestion_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_observations
    ADD CONSTRAINT physical_store_observations_ingestion_run_id_fkey FOREIGN KEY (ingestion_run_id) REFERENCES public.ingestion_runs(id);


--
-- Name: physical_store_observations physical_store_observations_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_store_observations
    ADD CONSTRAINT physical_store_observations_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: physical_stores physical_stores_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_stores
    ADD CONSTRAINT physical_stores_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: price_coverage_checks price_coverage_checks_geographic_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_coverage_checks
    ADD CONSTRAINT price_coverage_checks_geographic_scope_fk FOREIGN KEY (geographic_scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: price_coverage_checks price_coverage_checks_ingestion_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_coverage_checks
    ADD CONSTRAINT price_coverage_checks_ingestion_run_id_fkey FOREIGN KEY (ingestion_run_id) REFERENCES public.ingestion_runs(id);


--
-- Name: price_coverage_checks price_coverage_checks_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_coverage_checks
    ADD CONSTRAINT price_coverage_checks_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: price_observations price_observations_geographic_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations
    ADD CONSTRAINT price_observations_geographic_scope_fk FOREIGN KEY (geographic_scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: price_observations price_observations_ingestion_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations
    ADD CONSTRAINT price_observations_ingestion_run_id_fkey FOREIGN KEY (ingestion_run_id) REFERENCES public.ingestion_runs(id);


--
-- Name: price_observations price_observations_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations
    ADD CONSTRAINT price_observations_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: price_observations price_observations_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_observations
    ADD CONSTRAINT price_observations_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions
    ADD CONSTRAINT private_review_evidence_consumptions_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.extracted_offer_candidates(id);


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_evidence_render_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions
    ADD CONSTRAINT private_review_evidence_consumptions_evidence_render_id_fkey FOREIGN KEY (evidence_render_id) REFERENCES public.private_review_evidence_renders(id);


--
-- Name: private_review_evidence_consumptions private_review_evidence_consumptions_review_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_consumptions
    ADD CONSTRAINT private_review_evidence_consumptions_review_action_id_fkey FOREIGN KEY (review_action_id) REFERENCES public.review_actions(id);


--
-- Name: private_review_evidence_renders private_review_evidence_renders_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_review_evidence_renders
    ADD CONSTRAINT private_review_evidence_renders_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.extracted_offer_candidates(id);


--
-- Name: product_family_memberships product_family_memberships_family_slug_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_family_memberships
    ADD CONSTRAINT product_family_memberships_family_slug_fkey FOREIGN KEY (family_slug) REFERENCES public.product_families(slug);


--
-- Name: product_family_memberships product_family_memberships_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_family_memberships
    ADD CONSTRAINT product_family_memberships_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: product_identifiers product_identifiers_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_identifiers
    ADD CONSTRAINT product_identifiers_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: product_identifiers product_identifiers_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_identifiers
    ADD CONSTRAINT product_identifiers_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: publication_captures publication_captures_capture_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_captures
    ADD CONSTRAINT publication_captures_capture_permission_id_fkey FOREIGN KEY (capture_permission_id) REFERENCES public.source_permissions(id);


--
-- Name: publication_captures publication_captures_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_captures
    ADD CONSTRAINT publication_captures_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


--
-- Name: publications publications_discovery_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_discovery_permission_id_fkey FOREIGN KEY (discovery_permission_id) REFERENCES public.source_permissions(id);


--
-- Name: publications publications_geographic_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_geographic_scope_id_fkey FOREIGN KEY (geographic_scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: publications publications_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: review_actions review_actions_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_actions
    ADD CONSTRAINT review_actions_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.extracted_offer_candidates(id);


--
-- Name: review_actions review_actions_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_actions
    ADD CONSTRAINT review_actions_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.approved_offers(id);


--
-- Name: reviewed_family_aliases reviewed_family_aliases_definition_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_aliases
    ADD CONSTRAINT reviewed_family_aliases_definition_fk FOREIGN KEY (version_id, family_id) REFERENCES public.reviewed_family_definitions(version_id, family_id);


--
-- Name: reviewed_family_definitions reviewed_family_definitions_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_definitions
    ADD CONSTRAINT reviewed_family_definitions_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.family_taxonomy_versions(version_id);


--
-- Name: reviewed_family_definitions reviewed_family_definitions_version_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_definitions
    ADD CONSTRAINT reviewed_family_definitions_version_parent_fk FOREIGN KEY (version_id, parent_family_id) REFERENCES public.reviewed_family_definitions(version_id, family_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: reviewed_family_membership_decisions reviewed_family_membership_decisions_definition_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_membership_decisions
    ADD CONSTRAINT reviewed_family_membership_decisions_definition_fk FOREIGN KEY (version_id, family_id) REFERENCES public.reviewed_family_definitions(version_id, family_id);


--
-- Name: reviewed_family_membership_decisions reviewed_family_membership_decisions_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviewed_family_membership_decisions
    ADD CONSTRAINT reviewed_family_membership_decisions_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.canonical_products(id);


--
-- Name: source_health_snapshots source_health_snapshots_geographic_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_geographic_scope_id_fkey FOREIGN KEY (geographic_scope_id) REFERENCES public.geographic_scopes(id);


--
-- Name: source_health_snapshots source_health_snapshots_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: source_health_snapshots source_health_snapshots_worker_job_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_worker_job_fk FOREIGN KEY (worker_job_id) REFERENCES public.worker_job_results(job_id);


--
-- Name: source_permissions source_permissions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_permissions
    ADD CONSTRAINT source_permissions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: source_products source_products_canonical_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_products
    ADD CONSTRAINT source_products_canonical_product_id_fkey FOREIGN KEY (canonical_product_id) REFERENCES public.canonical_products(id);


--
-- Name: source_products source_products_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_products
    ADD CONSTRAINT source_products_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- Name: source_record_outcomes source_record_outcomes_ingestion_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_ingestion_run_id_fkey FOREIGN KEY (ingestion_run_id) REFERENCES public.ingestion_runs(id);


--
-- Name: worker_job_results worker_job_results_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_job_results
    ADD CONSTRAINT worker_job_results_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.data_sources(id);


--
-- PostgreSQL database dump complete
--

\unrestrict BRN2b6Ba8CQdoNqcN5JQ60HBS3S8tuHAfNmWMn096qtFwcVfexDyDwEDS3fbHKB

