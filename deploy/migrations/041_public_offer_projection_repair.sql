-- Task 2B1 explicit correction for immutable 039 semantics; 039 itself remains untouched.
-- Only null-aware before-price comparisons and the reviewed nested product identity path change.
CREATE OR REPLACE FUNCTION public.public_official_offer_rows_v1(p_product_ids bigint[], p_evaluation_as_of timestamp with time zone)
 RETURNS TABLE(offer_id bigint, source_id text, source_display_name text, source_record_id text, chain text, product_id bigint, amount_ore integer, before_amount_ore integer, multibuy_quantity integer, multibuy_group_amount_ore integer, membership_requirement text, member_program_id text, valid_from timestamp with time zone, valid_until timestamp with time zone, geographic_scope jsonb, channels jsonb, captured_at timestamp with time zone, product_offer_count bigint, total_offer_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 PARALLEL UNSAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.public_official_offer_rows_v1(
  bigint[], timestamptz
) FROM PUBLIC;
