-- Add bounded, original-byte MENY HTML evidence displayed strictly as text.
-- Preserve image receipts and every existing rights/session/expiry/one-use
-- check. This migration grants no source permission or publication approval.
lock table public.private_review_evidence_renders in access exclusive mode;

alter table public.private_review_evidence_renders
  drop constraint private_review_evidence_renders_image_mime,
  add constraint private_review_evidence_renders_supported_mime
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'text/html')),
  add constraint private_review_evidence_renders_text_byte_limit
    check (mime_type <> 'text/html' or byte_length between 1 and 1048576);

-- The table write fence independently binds HTML to its original MENY capture.
create function public.private_review_validate_meny_text_render_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.mime_type = 'text/html' and not exists (
    select 1
    from public.extracted_offer_candidates candidate
    join public.extraction_runs extraction on extraction.id = candidate.extraction_run_id
    join public.publication_captures capture on capture.id = extraction.capture_id
    join public.publications publication on publication.id = capture.publication_id
    where candidate.id = new.candidate_id
      and publication.source_id = 'meny'
      and capture.mime_type = 'text/html'
      and capture.checksum = new.capture_checksum
      and capture.byte_length = new.byte_length
      and capture.rights_classification = new.rights_classification
      and capture.byte_length between 1 and 1048576
  ) then
    raise exception 'HP_REVIEW_EVIDENCE_UNAVAILABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger private_review_meny_text_render_binding
before insert on public.private_review_evidence_renders
for each row execute function public.private_review_validate_meny_text_render_v1();

revoke all on function public.private_review_validate_meny_text_render_v1() from public;

do $private_review_record_meny_text_evidence$
declare
  v_body text;
  v_old text := $old$
     or v_candidate.mime_type is null
     or v_candidate.mime_type not in (
       'image/jpeg', 'image/png', 'image/webp'
     )
$old$;
  v_new text := $new$
     or v_candidate.mime_type is null
     or not (
       v_candidate.mime_type in ('image/jpeg', 'image/png', 'image/webp')
       or (v_candidate.mime_type = 'text/html'
         and v_source_id = 'meny'
         and v_candidate.byte_length between 1 and 1048576)
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
    raise exception 'private_review_record_evidence_render_v1 text MIME boundary drifted';
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
$private_review_record_meny_text_evidence$;


-- Recheck the original text capture independently at proof consumption.
do $private_review_decide_meny_text_evidence$
declare
  v_body text;
  v_old text := $old$
       or v_render.presentation is distinct from 'full_capture'
       or v_render.mime_type is null
       or v_render.mime_type not in ('image/jpeg', 'image/png', 'image/webp')
       or v_render.rights_classification not in ('private_review', 'public_display')
$old$;
  v_new text := $new$
       or v_render.presentation is distinct from 'full_capture'
       or v_render.mime_type is null
       or not (
         v_render.mime_type in ('image/jpeg', 'image/png', 'image/webp')
         or (v_render.mime_type = 'text/html'
           and v_render.byte_length between 1 and 1048576
           and exists (
             select 1
             from public.extracted_offer_candidates candidate
             join public.extraction_runs extraction on extraction.id = candidate.extraction_run_id
             join public.publication_captures capture on capture.id = extraction.capture_id
             join public.publications publication on publication.id = capture.publication_id
             where candidate.id = p_candidate_id
               and publication.source_id = 'meny'
               and capture.mime_type = 'text/html'
               and capture.checksum = v_render.capture_checksum
               and capture.byte_length = v_render.byte_length
           ))
       )
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
    raise exception 'private_review_decide_v2 text MIME boundary drifted';
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
$private_review_decide_meny_text_evidence$;

revoke all on function public.private_review_record_evidence_render_v1(
  bigint, integer, text, text, text, text, text, text, text, timestamptz
) from public;

revoke all on function public.private_review_decide_v2(
  bigint, integer, text, text, text, text, text, text, text, text, text,
  integer, integer, integer, integer, text, text, timestamptz, timestamptz, text[]
) from public;
