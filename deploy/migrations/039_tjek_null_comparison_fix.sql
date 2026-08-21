-- Fix null comparison and exactCanonicalProductId path in public_official_offer_rows_v1
--
-- Issue 1: beforePriceOre/beforeUnitPriceOre null comparison
--   review.new_values #> path returns jsonb null (a value), but to_jsonb(NULL) 
--   returns SQL null. IS NOT DISTINCT FROM fails because they are different types.
--   Fix: Use coalesce to normalize both sides to 'null'::jsonb.
--
-- Issue 2: exactCanonicalProductId path
--   The SQL function checks normalized_fields ->> 'exactCanonicalProductId' (top-level),
--   but some extractors put it at normalized_fields #> '{candidate,exactCanonicalProductId}'.
--   Fix: Check both paths with an OR.

DO $fix$
DECLARE
  v_src text;
  v_new text;
  v_count integer;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE proname = 'public_official_offer_rows_v1'
    AND pronargs = 2;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Function public_official_offer_rows_v1 not found';
  END IF;

  v_new := v_src;

  -- Fix 1a: beforePriceOre null comparison (unit pricing)
  v_new := replace(v_new,
    'review.new_values #> ''{decision,pricing,beforePriceOre}''' || E'\n' ||
    '            is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)',
    'pg_catalog.coalesce(review.new_values #> ''{decision,pricing,beforePriceOre}'', ''null''::jsonb)' || E'\n' ||
    '            is not distinct from pg_catalog.coalesce(pg_catalog.to_jsonb(offer.before_amount_ore), ''null''::jsonb)');

  IF v_new = v_src THEN
    -- Try single-line variant
    v_new := replace(v_src,
      'review.new_values #> ''{decision,pricing,beforePriceOre}'' is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)',
      'pg_catalog.coalesce(review.new_values #> ''{decision,pricing,beforePriceOre}'', ''null''::jsonb) is not distinct from pg_catalog.coalesce(pg_catalog.to_jsonb(offer.before_amount_ore), ''null''::jsonb)');
  END IF;

  -- Fix 1b: beforeUnitPriceOre null comparison (multibuy pricing)
  v_new := replace(v_new,
    'review.new_values #> ''{decision,pricing,beforeUnitPriceOre}''' || E'\n' ||
    '            is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)',
    'pg_catalog.coalesce(review.new_values #> ''{decision,pricing,beforeUnitPriceOre}'', ''null''::jsonb)' || E'\n' ||
    '            is not distinct from pg_catalog.coalesce(pg_catalog.to_jsonb(offer.before_amount_ore), ''null''::jsonb)');

  -- Fix 2: exactCanonicalProductId path — check both top-level and nested
  -- There are two occurrences of this pattern
  v_new := replace(v_new,
    'candidate.normalized_fields ->> ''exactCanonicalProductId''' || E'\n' ||
    '          = ''product:'' || target.product_id::text',
    '(candidate.normalized_fields ->> ''exactCanonicalProductId''' || E'\n' ||
    '          = ''product:'' || target.product_id::text' || E'\n' ||
    '          or candidate.normalized_fields #> ''{candidate,exactCanonicalProductId}''' || E'\n' ||
    '          = to_jsonb(''product:'' || target.product_id::text))');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'No replacements were applied to the function body';
  END IF;

  -- Count replacements
  v_count := (length(v_new) - length(replace(v_new, 'coalesce', ''))) / 8;
  RAISE NOTICE 'Applied % coalesce replacements', v_count;

  -- Recreate the function preserving all original attributes
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.public_official_offer_rows_v1(p_product_ids bigint[], p_evaluation_as_of timestamp with time zone)
    RETURNS TABLE(offer_id bigint, source_id text, source_display_name text, source_record_id text, chain text, product_id bigint, amount_ore integer, before_amount_ore integer, multibuy_quantity integer, multibuy_group_amount_ore integer, membership_requirement text, member_program_id text, valid_from timestamp with time zone, valid_until timestamp with time zone, geographic_scope jsonb, channels jsonb, captured_at timestamp with time zone, product_offer_count bigint, total_offer_count bigint)
    LANGUAGE plpgsql
    SECURITY DEFINER
    PARALLEL UNSAFE
    SET search_path TO pg_catalog, pg_temp
    AS %L', v_new);

  RAISE NOTICE 'Function public_official_offer_rows_v1 recreated successfully';
END;
$fix$;
