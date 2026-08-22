-- Offer-backed products can be legitimate discovery identities even when no
-- catalog source currently covers their GTIN. Derive the bounded public row set
-- from the live reviewed-offer projection so this reader cannot drift behind
-- later changes to the official-offer trust predicate.
do $offer_backed_discovery$
declare
  v_body text;
  v_offer_select text;
begin
  select procedure.prosrc
  into v_body
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.public_official_offer_rows_v1(bigint[],timestamp with time zone)'
  );

  if v_body is null then
    raise exception 'public official-offer projection is missing';
  end if;

  v_body := pg_catalog.btrim(v_body);
  v_offer_select := 'select' || chr(10) ||
    pg_catalog.regexp_replace(
      v_body,
      'from payload_bounded[[:space:]]+where[[:space:]]+public\.assert_public_official_offer_payload_v1\([[:space:]]+payload_bounded\.total_payload_bytes[[:space:]]+\)[[:space:]]+order by payload_bounded\.product_id,[[:space:]]*payload_bounded\.valid_until,[[:space:]]*payload_bounded\.offer_id[[:space:]]+limit 501;[[:space:]]+end;[[:space:]]*$',
      E'true as product_is_offer_backed,\n      payload_bounded.offer_id, payload_bounded.source_id, payload_bounded.source_display_name, payload_bounded.source_record_id, payload_bounded.chain, payload_bounded.product_id, payload_bounded.amount_ore, payload_bounded.before_amount_ore, payload_bounded.multibuy_quantity, payload_bounded.multibuy_group_amount_ore, payload_bounded.membership_requirement, payload_bounded.member_program_id, payload_bounded.valid_from, payload_bounded.valid_until, payload_bounded.geographic_scope, payload_bounded.channels, payload_bounded.captured_at, payload_bounded.product_offer_count, payload_bounded.total_offer_count\n    from payload_bounded\n    limit 500',
    );

  if v_offer_select = 'select' || chr(10)
     or v_offer_select not like '%product_is_offer_backed%'
     or position('assert_public_official_offer_payload_v1' in v_offer_select) <> 0 then
    raise exception 'public official-offer discovery shape drifted';
  end if;

  execute pg_catalog.format(E'
    create function public.public_offer_backed_discovery_rows_v1(
      p_evaluation_as_of timestamptz
    ) returns table (
      offer_id bigint,
      source_id text,
      source_display_name text,
      source_record_id text,
      chain text,
      product_id bigint,
      amount_ore integer,
      before_amount_ore integer,
      multibuy_quantity integer,
      multibuy_group_amount_ore integer,
      membership_requirement text,
      member_program_id text,
      valid_from timestamp with time zone,
      valid_until timestamp with time zone,
      geographic_scope jsonb,
      channels jsonb,
      captured_at timestamp with time zone,
      product_offer_count bigint,
      total_offer_count bigint,
      product_is_offer_backed boolean
    ) language plpgsql volatile security definer parallel unsafe
      set search_path = pg_catalog, pg_temp as %L\n    begin\n      return query ' || v_offer_select || '\n    end;', v_offer_select);
end;
$offer_backed_discovery$;

revoke all on function public.public_offer_backed_discovery_rows_v1(
  timestamptz
) from public;
