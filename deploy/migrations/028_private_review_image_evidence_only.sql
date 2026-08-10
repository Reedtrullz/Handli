-- V1 has no bounded PDF page renderer. Evidence receipts must therefore prove
-- delivery and browser decoding of a complete supported image, never merely
-- the existence of a PDF capture. Refuse to reinterpret any historical PDF
-- receipt: reconciliation requires an explicit, reviewed forward migration.

lock table public.private_review_evidence_renders in access exclusive mode;

do $private_review_image_evidence_precondition$
begin
  if exists (
    select 1
    from public.private_review_evidence_renders evidence
    where evidence.mime_type = 'application/pdf'
  ) then
    raise exception 'pre-existing PDF evidence renders require reviewed reconciliation';
  end if;
end;
$private_review_image_evidence_precondition$;

alter table public.private_review_evidence_renders
  drop constraint private_review_evidence_renders_mime,
  add constraint private_review_evidence_renders_image_mime
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp'));

-- Preserve the audited v1 signature and every existing eligibility check while
-- narrowing the capture MIME allowlist. Refuse to patch a drifted function.
do $private_review_record_image_evidence_only$
declare
  v_body text;
  v_old text := $old$
     or v_candidate.mime_type not in (
       'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
     )
$old$;
  v_new text := $new$
     or v_candidate.mime_type is null
     or v_candidate.mime_type not in (
       'image/jpeg', 'image/png', 'image/webp'
     )
$new$;
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.private_review_record_evidence_render_v1(bigint,integer,text,text,text,text,text,text,text,timestamptz)'
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
    raise exception 'private_review_record_evidence_render_v1 MIME boundary drifted';
  end if;

  v_body := pg_catalog.replace(v_body, v_old, v_new);
  execute pg_catalog.format(
    'create or replace function public.private_review_record_evidence_render_v1(
      p_candidate_id bigint, p_expected_version integer,
      p_capture_checksum text, p_crop_reference text, p_presentation text,
      p_rights_classification text, p_actor_id text,
      p_reviewer_session_id text, p_evidence_proof_sha256 text,
      p_expires_at timestamptz
    ) returns table (
      evidence_render_id bigint, rendered_at timestamptz,
      expires_at timestamptz
    ) language plpgsql security definer set search_path = pg_catalog, pg_temp as %L',
    v_body
  );
end;
$private_review_record_image_evidence_only$;

-- The table constraint and recorder are the primary write fences. Keep the
-- approval transaction independently fail-closed so even an owner-injected or
-- otherwise corrupted legacy non-image receipt cannot authorize an offer.
do $private_review_decide_image_evidence_only$
declare
  v_body text;
  v_old text := $old$
       or v_render.presentation is distinct from 'full_capture'
       or v_render.rights_classification not in ('private_review', 'public_display')
$old$;
  v_new text := $new$
       or v_render.presentation is distinct from 'full_capture'
       or v_render.mime_type is null
       or v_render.mime_type not in ('image/jpeg', 'image/png', 'image/webp')
       or v_render.rights_classification not in ('private_review', 'public_display')
$new$;
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.private_review_decide_v2(bigint,integer,text,text,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamptz,timestamptz,text[])'
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
    raise exception 'private_review_decide_v2 MIME boundary drifted';
  end if;

  v_body := pg_catalog.replace(v_body, v_old, v_new);
  execute pg_catalog.format(
    'create or replace function public.private_review_decide_v2(
      p_candidate_id bigint, p_expected_version integer, p_action text,
      p_actor_id text, p_reviewer_session_id text,
      p_evidence_proof_sha256 text, p_reason text, p_target_kind text,
      p_target_gtin text, p_target_family_slug text, p_pricing_kind text,
      p_offer_price_ore integer, p_before_price_ore integer,
      p_multibuy_quantity integer, p_multibuy_total_ore integer,
      p_eligibility_kind text, p_membership_program_id text,
      p_valid_from timestamptz, p_valid_until timestamptz, p_channels text[]
    ) returns table (
      action_id bigint, offer_id bigint, review_state text,
      new_version integer, acted_at timestamptz
    ) language plpgsql security definer set search_path = pg_catalog, pg_temp as %L',
    v_body
  );
end;
$private_review_decide_image_evidence_only$;

revoke all on function public.private_review_record_evidence_render_v1(
  bigint, integer, text, text, text, text, text, text, text, timestamptz
) from public;

revoke all on function public.private_review_decide_v2(
  bigint, integer, text, text, text, text, text, text, text, text, text,
  integer, integer, integer, integer, text, text, timestamptz, timestamptz, text[]
) from public;
