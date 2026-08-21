-- Fix null comparison and exactCanonicalProductId path in public_official_offer_rows_v1
--
-- Issue 1: beforePriceOre/beforeUnitPriceOre null comparison
--   review.new_values #> path returns jsonb null (a value), but to_jsonb(NULL) 
--   returns SQL null. IS NOT DISTINCT FROM fails because they are different types.
--   Fix: Use CASE to handle nulls explicitly.
--
-- Issue 2: exactCanonicalProductId path
--   The SQL function checks normalized_fields ->> 'exactCanonicalProductId' (top-level),
--   but some extractors put it at normalized_fields #> '{candidate,exactCanonicalProductId}'.
--   Fix: Check both paths with an OR.

-- NOTE: This migration modifies the function body via text replacement.
-- It is designed to be idempotent: if the patterns aren't found, it raises a warning.

DO $fix$
DECLARE
  v_src text;
  v_new text;
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
    E'review.new_values #> ''{decision,pricing,beforePriceOre}''\n            is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)',
    E'((offer.before_amount_ore is null and jsonb_typeof(review.new_values #> ''{decision,pricing,beforePriceOre}'') = ''null'')\n            or (offer.before_amount_ore is not null and review.new_values #> ''{decision,pricing,beforePriceOre}'' = pg_catalog.to_jsonb(offer.before_amount_ore)))');

  -- Fix 1b: beforeUnitPriceOre null comparison (multibuy pricing)
  v_new := replace(v_new,
    E'review.new_values #> ''{decision,pricing,beforeUnitPriceOre}''\n            is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)',
    E'((offer.before_amount_ore is null and jsonb_typeof(review.new_values #> ''{decision,pricing,beforeUnitPriceOre}'') = ''null'')\n            or (offer.before_amount_ore is not null and review.new_values #> ''{decision,pricing,beforeUnitPriceOre}'' = pg_catalog.to_jsonb(offer.before_amount_ore)))');

  -- Fix 2: exactCanonicalProductId path — check both top-level and nested
  v_new := regexp_replace(v_new,
    E'candidate\.normalized_fields ->> ''exactCanonicalProductId''\n          = ''product:'' \|\| target\.product_id::text',
    E'candidate.normalized_fields ->> ''exactCanonicalProductId''\n          = ''product:'' || target.product_id::text\n        or candidate.normalized_fields #> ''{candidate,exactCanonicalProductId}''\n          = to_jsonb(''product:'' || target.product_id::text)',
    'g');

  IF v_new = v_src THEN
    RAISE NOTICE 'No changes applied (patterns may already be fixed)';
    RETURN;
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.public_official_offer_rows_v1(p_product_ids bigint[], p_evaluation_as_of timestamp with time zone)
    RETURNS TABLE(offer_id bigint, source_id text, source_display_name text, source_record_id text, chain text, product_id bigint, amount_ore integer, before_amount_ore integer, multibuy_quantity integer, multibuy_group_amount_ore integer, membership_requirement text, member_program_id text, valid_from timestamp with time zone, valid_until timestamp with time zone, geographic_scope jsonb, channels jsonb, captured_at timestamp with time zone, product_offer_count bigint, total_offer_count bigint)
    LANGUAGE plpgsql
    SECURITY DEFINER
    PARALLEL UNSAFE
    SET search_path TO pg_catalog, pg_temp
    AS %L', v_new);

  RAISE NOTICE 'Function public_official_offer_rows_v1 updated successfully';
END;
$fix$;
