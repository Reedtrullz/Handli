-- Candidate-bound private evidence renders are append-only audit facts. Raw
-- artwork and raw proof tokens never enter PostgreSQL; only the immutable
-- capture binding and a SHA-256 proof digest cross this boundary.

create table public.private_review_evidence_renders (
  id bigserial primary key,
  candidate_id bigint not null references public.extracted_offer_candidates(id),
  expected_version integer not null,
  capture_checksum char(64) not null,
  crop_reference varchar(76) not null,
  presentation varchar(24) not null,
  rights_classification varchar(24) not null,
  mime_type varchar(120) not null,
  byte_length integer not null,
  actor_id varchar(80) not null,
  reviewer_session_id varchar(80) not null,
  evidence_proof_sha256 char(64) not null unique,
  rendered_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  constraint private_review_evidence_renders_expected_version
    check (expected_version >= 0),
  constraint private_review_evidence_renders_checksum
    check (capture_checksum ~ '^[0-9a-f]{64}$'),
  constraint private_review_evidence_renders_crop_reference
    check (crop_reference ~ '^review-crop:[0-9a-f]{64}$'),
  constraint private_review_evidence_renders_presentation
    check (presentation = 'full_capture'),
  constraint private_review_evidence_renders_rights
    check (rights_classification in ('private_review', 'public_display')),
  constraint private_review_evidence_renders_mime
    check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  constraint private_review_evidence_renders_byte_length
    check (byte_length between 1 and 52428800),
  constraint private_review_evidence_renders_actor
    check (actor_id ~ '^access:[0-9a-f]{64}$'),
  constraint private_review_evidence_renders_session
    check (reviewer_session_id ~ '^access-session:[0-9a-f]{64}$'),
  constraint private_review_evidence_renders_proof
    check (evidence_proof_sha256 ~ '^[0-9a-f]{64}$'),
  constraint private_review_evidence_renders_time
    check (rendered_at = created_at and expires_at > rendered_at)
);

create index private_review_evidence_renders_candidate_idx
  on public.private_review_evidence_renders (candidate_id, expected_version, rendered_at, id);

create table public.private_review_evidence_consumptions (
  id bigserial primary key,
  evidence_render_id bigint not null unique
    references public.private_review_evidence_renders(id),
  review_action_id bigint not null unique references public.review_actions(id),
  candidate_id bigint not null references public.extracted_offer_candidates(id),
  consumed_at timestamptz not null,
  created_at timestamptz not null,
  constraint private_review_evidence_consumptions_time
    check (consumed_at = created_at)
);

create trigger private_review_evidence_renders_append_only
before update or delete on public.private_review_evidence_renders
for each row execute function public.reject_append_only_mutation();

create trigger private_review_evidence_consumptions_append_only
before update or delete on public.private_review_evidence_consumptions
for each row execute function public.reject_append_only_mutation();

-- Version 1 identifies the migration-021 boundary. Version 2 is emitted only
-- when the v2 wrapper below has validated (and, for approval, consumed) the
-- renderer proof. Public projections can therefore exclude legacy/direct
-- v1-shaped approvals without coupling to the private renderer tables.
alter table public.review_actions
  drop constraint review_actions_decision_boundary_version,
  add constraint review_actions_decision_boundary_version check (
    decision_boundary_version is null or decision_boundary_version in (1, 2)
  );

create function public.private_review_record_evidence_render_v1(
  p_candidate_id bigint,
  p_expected_version integer,
  p_capture_checksum text,
  p_crop_reference text,
  p_presentation text,
  p_rights_classification text,
  p_actor_id text,
  p_reviewer_session_id text,
  p_evidence_proof_sha256 text,
  p_expires_at timestamptz
)
returns table (
  evidence_render_id bigint,
  rendered_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
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
     or v_candidate.mime_type not in (
       'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
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
$$;

revoke all on function public.private_review_record_evidence_render_v1(
  bigint, integer, text, text, text, text, text, text, text, timestamptz
) from public;

-- Migration 021 intentionally blocked approvals until a renderer existed. The
-- only change to that already-audited function is replacing its unconditional
-- approval block with a transaction-local authorization asserted exclusively
-- by private_review_decide_v2 below. Fail the migration if the exact historical
-- block is not present once and only once.
do $private_review_enable_renderer$
declare
  v_body text;
  v_old text := 'if p_action <> ''reject'' then
    raise exception ''HP_REVIEW_EVIDENCE_UNAVAILABLE''
      using errcode = ''55000'';
  end if;';
  v_new text := 'if p_action <> ''reject''
     and pg_catalog.current_setting(''handleplan.review_evidence_authorized'', true)
       is distinct from ''v1'' then
    raise exception ''HP_REVIEW_EVIDENCE_UNAVAILABLE''
      using errcode = ''55000'';
  end if;';
  v_old_insert text := '  insert into public.review_actions (
    candidate_id, offer_id, actor_id, action, expected_version,
    previous_values, new_values, reason, acted_at
  ) values (
    p_candidate_id, v_offer_id, p_actor_id, p_action, p_expected_version,
    v_previous_values, v_new_values, p_reason, v_decision_now
  ) returning id into v_action_id;';
  v_new_insert text := '  insert into public.review_actions (
    candidate_id, offer_id, actor_id, action, expected_version,
    previous_values, new_values, reason, acted_at, decision_boundary_version
  ) values (
    p_candidate_id, v_offer_id, p_actor_id, p_action, p_expected_version,
    v_previous_values, v_new_values, p_reason, v_decision_now,
    case when pg_catalog.current_setting(
      ''handleplan.review_decision_boundary_version'', true
    ) = ''2'' then 2 else 1 end
  ) returning id into v_action_id;';
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.private_review_decide_v1(bigint,integer,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamptz,timestamptz,text[])'
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
    raise exception 'private_review_decide_v1 evidence block drifted';
  end if;

  v_body := pg_catalog.replace(v_body, v_old, v_new);
  if pg_catalog.strpos(v_body, v_old_insert) = 0
     or pg_catalog.strpos(
       pg_catalog.substr(
         v_body,
         pg_catalog.strpos(v_body, v_old_insert) + pg_catalog.length(v_old_insert)
       ),
       v_old_insert
     ) <> 0 then
    raise exception 'private_review_decide_v1 action insert drifted';
  end if;
  v_body := pg_catalog.replace(v_body, v_old_insert, v_new_insert);
  execute pg_catalog.format(
    'create or replace function public.private_review_decide_v1(
      p_candidate_id bigint, p_expected_version integer, p_action text,
      p_actor_id text, p_reason text, p_target_kind text, p_target_gtin text,
      p_target_family_slug text, p_pricing_kind text, p_offer_price_ore integer,
      p_before_price_ore integer, p_multibuy_quantity integer,
      p_multibuy_total_ore integer, p_eligibility_kind text,
      p_membership_program_id text, p_valid_from timestamptz,
      p_valid_until timestamptz, p_channels text[]
    ) returns table (
      action_id bigint, offer_id bigint, review_state text,
      new_version integer, acted_at timestamptz
    ) language plpgsql security definer set search_path = pg_catalog, pg_temp as %L',
    v_body
  );
end;
$private_review_enable_renderer$;

revoke all on function public.private_review_decide_v1(
  bigint, integer, text, text, text, text, text, text, text, integer,
  integer, integer, integer, text, text, timestamptz, timestamptz, text[]
) from public;

create function public.private_review_decide_v2(
  p_candidate_id bigint,
  p_expected_version integer,
  p_action text,
  p_actor_id text,
  p_reviewer_session_id text,
  p_evidence_proof_sha256 text,
  p_reason text,
  p_target_kind text,
  p_target_gtin text,
  p_target_family_slug text,
  p_pricing_kind text,
  p_offer_price_ore integer,
  p_before_price_ore integer,
  p_multibuy_quantity integer,
  p_multibuy_total_ore integer,
  p_eligibility_kind text,
  p_membership_program_id text,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_channels text[]
)
returns table (
  action_id bigint,
  offer_id bigint,
  review_state text,
  new_version integer,
  acted_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
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
$$;

revoke all on function public.private_review_decide_v2(
  bigint, integer, text, text, text, text, text, text, text, text, text,
  integer, integer, integer, integer, text, text, timestamptz, timestamptz, text[]
) from public;

-- A pre-existing runtime role loses v1 and receives only the bounded reader,
-- render recorder and v2 decision transaction in this same migration commit.
do $private_review_renderer_upgrade_fail_closed$
begin
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_review'
  ) then
    execute 'revoke all privileges on all tables in schema public from handleplan_review';
    execute 'revoke all privileges on all sequences in schema public from handleplan_review';
    execute 'revoke all privileges on all functions in schema public from handleplan_review';
    execute 'grant execute on function public.private_review_candidate_rows_v1(
      bigint, timestamp with time zone, text, text, integer, integer,
      integer, integer, text, timestamp with time zone, bigint, integer
    ) to handleplan_review';
    execute 'grant execute on function public.private_review_record_evidence_render_v1(
      bigint, integer, text, text, text, text, text, text, text,
      timestamp with time zone
    ) to handleplan_review';
    execute 'grant execute on function public.private_review_decide_v2(
      bigint, integer, text, text, text, text, text, text, text, text, text,
      integer, integer, integer, integer, text, text, timestamp with time zone,
      timestamp with time zone, text[]
    ) to handleplan_review';
  end if;
end;
$private_review_renderer_upgrade_fail_closed$;
