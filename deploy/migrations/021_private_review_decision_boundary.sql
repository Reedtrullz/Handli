-- The private review runtime may inspect only candidates that satisfy one
-- centralized, rights-current eligibility predicate. Mutations cross a single
-- SECURITY DEFINER transaction boundary; handleplan_review receives no direct
-- table INSERT or sequence privileges after this migration.

create function public.private_review_candidate_rows_v1(
  p_candidate_id bigint,
  p_evaluation_as_of timestamptz,
  p_chain text,
  p_scope_kind text,
  p_min_confidence integer,
  p_max_confidence integer,
  p_min_age_hours integer,
  p_max_age_hours integer,
  p_anomaly text,
  p_cursor_created_at timestamptz,
  p_cursor_id bigint,
  p_result_limit integer
)
returns table (
  candidate_id bigint,
  candidate_status varchar(16),
  normalized_fields jsonb,
  confidence smallint,
  anomaly_codes jsonb,
  candidate_created_at timestamptz,
  extraction_method varchar(24),
  blob_key text,
  capture_checksum char(64),
  mime_type varchar(120),
  byte_length integer,
  rights_classification varchar(24),
  retrieved_at timestamptz,
  source_id varchar(64),
  chain varchar(32),
  publication_title varchar(240),
  publication_valid_from timestamptz,
  publication_valid_until timestamptz,
  geographic_scope_id bigint,
  scope_kind varchar(24),
  scope_label varchar(200)
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
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

revoke all on function public.private_review_candidate_rows_v1(
  bigint, timestamptz, text, text, integer, integer, integer, integer,
  text, timestamptz, bigint, integer
) from public;

-- The generic migration-020 creation trigger uses statement_timestamp(),
-- whose value is fixed before a statement waits on candidate/source locks.
-- PostgreSQL fires same-kind triggers by name, so this deliberately z-prefixed
-- trigger runs after review_actions_creation_clock and records the real
-- post-lock persistence order used by current-action selection.
create function public.stamp_private_review_action_decision_clock()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function public.stamp_private_review_action_decision_clock() from public;

create trigger review_actions_z_decision_clock
before insert on public.review_actions
for each row execute function public.stamp_private_review_action_decision_clock();

create function public.private_review_decide_v1(
  p_candidate_id bigint,
  p_expected_version integer,
  p_action text,
  p_actor_id text,
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
  if p_action <> 'reject' then
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
    previous_values, new_values, reason, acted_at
  ) values (
    p_candidate_id, v_offer_id, p_actor_id, p_action, p_expected_version,
    v_previous_values, v_new_values, p_reason, v_decision_now
  ) returning id into v_action_id;

  return query select
    v_action_id,
    v_offer_id,
    case when p_action = 'reject' then 'rejected' else 'approved' end,
    1,
    v_decision_now;
end;
$$;

revoke all on function public.private_review_decide_v1(
  bigint, integer, text, text, text, text, text, text, text, integer,
  integer, integer, integer, text, text, timestamptz, timestamptz, text[]
) from public;

-- Upgrade fail-closed: role reconfiguration runs after migration transactions,
-- so an already-existing pre-021 role must lose its historical direct grants in
-- this same commit. Table-level ALL does not erase column ACLs, hence the three
-- explicit legacy column revocations. Fresh databases have no review role yet.
do $private_review_upgrade_fail_closed$
begin
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'handleplan_review'
  ) then
    execute 'revoke all privileges on all tables in schema public from handleplan_review';
    execute 'revoke all privileges on all sequences in schema public from handleplan_review';
    execute 'revoke all privileges on all functions in schema public from handleplan_review';
    execute 'revoke select (
      id, display_name, source_kind, runtime_state, public_reference_url,
      permission_reviewed_at, permission_expires_at, created_at, updated_at,
      public_state_changed_at
    ) on table public.data_sources from handleplan_review';
    execute 'revoke select (
      id, source_id, decision, reviewed_at, valid_until, permissions, created_at
    ) on table public.source_permissions from handleplan_review';
    execute 'revoke select (
      id, scope_kind, label, country_code, status, created_at,
      public_state_changed_at
    ) on table public.geographic_scopes from handleplan_review';
    execute 'grant execute on function public.private_review_candidate_rows_v1(
      bigint, timestamp with time zone, text, text, integer, integer,
      integer, integer, text, timestamp with time zone, bigint, integer
    ) to handleplan_review';
    execute 'grant execute on function public.private_review_decide_v1(
      bigint, integer, text, text, text, text, text, text, text, integer,
      integer, integer, integer, text, text, timestamp with time zone,
      timestamp with time zone, text[]
    ) to handleplan_review';
  end if;
end;
$private_review_upgrade_fail_closed$;
