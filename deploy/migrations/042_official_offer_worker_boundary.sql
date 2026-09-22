-- The worker may persist official-offer evidence only through these three
-- source-fenced entry points.  Existing trigger checks remain authoritative;
-- these functions add the missing transaction boundary around the lock,
-- authorization fence, and state transition.

create function public.official_offer_worker_assert_fence_v1(
  p_source_id text,
  p_permission_id bigint,
  p_capabilities jsonb,
  p_rights_classifications jsonb,
  p_required_capability text,
  p_rights_classification text,
  p_reviewed_at text,
  p_valid_until text,
  p_evaluated_at text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_permission_id bigint;
  v_reviewed_at text;
  v_valid_until text;
  v_evaluated_at text;
begin
  if p_source_id is null
     or pg_catalog.length(p_source_id) not between 1 and 64
     or p_permission_id is null
     or p_permission_id not between 1 and 9007199254740991
     or p_required_capability is null
     or p_required_capability not in ('capture', 'discover', 'extract', 'ocr')
     or p_reviewed_at is null
     or p_reviewed_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$'
     or p_evaluated_at is null
     or p_evaluated_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$'
     or (p_valid_until is not null
       and p_valid_until !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$')
     or pg_catalog.jsonb_typeof(p_capabilities) is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_rights_classifications) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_capabilities) not between 3 and 4
     or exists (select 1 from pg_catalog.jsonb_array_elements_text(p_capabilities) value
       where value not in ('capture', 'discover', 'extract', 'ocr'))
     or (select count(*) from pg_catalog.jsonb_array_elements_text(p_capabilities))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(p_capabilities))
     or p_capabilities is distinct from (
       select pg_catalog.jsonb_agg(value order by value)
       from pg_catalog.jsonb_array_elements_text(p_capabilities) as capabilities(value)
     )
     or pg_catalog.jsonb_array_length(p_rights_classifications) not between 1 and 3
     or exists (select 1 from pg_catalog.jsonb_array_elements_text(p_rights_classifications) value
       where value not in ('extract_only', 'private_review', 'public_display'))
     or (select count(*) from pg_catalog.jsonb_array_elements_text(p_rights_classifications))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(p_rights_classifications))
     or p_rights_classifications is distinct from (
       select pg_catalog.jsonb_agg(value order by value)
       from pg_catalog.jsonb_array_elements_text(p_rights_classifications) as rights(value)
     ) then
    raise exception 'official-offer worker authorization payload is invalid'
      using errcode = '22023';
  end if;

  v_reviewed_at := case when pg_catalog.length(p_reviewed_at) = 24
    then pg_catalog.left(p_reviewed_at, 23) || '000Z' else p_reviewed_at end;
  v_valid_until := case when p_valid_until is null then null when pg_catalog.length(p_valid_until) = 24
    then pg_catalog.left(p_valid_until, 23) || '000Z' else p_valid_until end;
  v_evaluated_at := case when pg_catalog.length(p_evaluated_at) = 24
    then pg_catalog.left(p_evaluated_at, 23) || '000Z' else p_evaluated_at end;
  if pg_catalog.to_char(v_reviewed_at::timestamptz at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> v_reviewed_at
     or pg_catalog.to_char(v_evaluated_at::timestamptz at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> v_evaluated_at
     or (v_valid_until is not null and pg_catalog.to_char(
       v_valid_until::timestamptz at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> v_valid_until) then
    raise exception 'official-offer worker authorization timestamp is not canonical'
      using errcode = '22023';
  end if;

  perform public.assert_current_official_offer_permission(
    p_source_id,
    p_permission_id,
    p_capabilities,
    p_required_capability,
    p_rights_classification
  );

  select permission.id
  into v_permission_id
  from public.data_sources source
  inner join public.source_permissions permission
    on permission.id = (
      select current_permission.id
      from public.source_permissions current_permission
      where current_permission.source_id = source.id
        and current_permission.created_at <= pg_catalog.clock_timestamp()
      order by current_permission.created_at desc, current_permission.id desc
      limit 1
    )
  where source.id = p_source_id
    and source.runtime_state = 'approved'
    and source.public_state_changed_at <= v_evaluated_at::timestamptz
    and source.permission_reviewed_at = permission.reviewed_at
    and source.permission_expires_at is not distinct from permission.valid_until
    and permission.id = p_permission_id
    and permission.decision = 'approved'
    and permission.reviewed_at = v_reviewed_at::timestamptz
    and permission.valid_until is not distinct from v_valid_until::timestamptz
    and permission.created_at <= v_evaluated_at::timestamptz
    and permission.reviewed_at <= v_evaluated_at::timestamptz
    and (permission.valid_until is null or permission.valid_until > pg_catalog.clock_timestamp())
    and v_evaluated_at::timestamptz between
      pg_catalog.clock_timestamp() - interval '5 seconds'
      and pg_catalog.clock_timestamp() + interval '5 seconds'
    and permission.permissions @> '{"officialOffers": true}'::jsonb
    and permission.permissions -> 'officialOfferCapabilities' = p_capabilities
    and permission.permissions -> 'officialOfferRightsClassifications' = p_rights_classifications;

  if v_permission_id is distinct from p_permission_id then
    raise exception 'official-offer worker authorization fence is stale'
      using errcode = '42501';
  end if;
end;
$$;

-- Keep the privileged boundary aligned with the bounded domain contract.  The
-- application validator remains useful for diagnostics, but a caller with the
-- app role must not be able to persist an arbitrary candidate envelope.
create function public.official_offer_worker_validate_candidate_v1(
  p_candidate jsonb,
  p_method text,
  p_edition jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_wrapper jsonb := p_candidate;
  v_candidate jsonb := p_candidate -> 'candidate';
  v_product jsonb := p_candidate -> 'candidate' -> 'product';
  v_package jsonb := p_candidate -> 'candidate' -> 'package';
  v_pricing jsonb := p_candidate -> 'candidate' -> 'pricing';
  v_eligibility jsonb := p_candidate -> 'candidate' -> 'eligibility';
  v_validity jsonb := p_candidate -> 'candidate' -> 'validity';
  v_scope jsonb := p_candidate -> 'candidate' -> 'geographicScope';
  v_provenance jsonb := p_candidate -> 'candidate' -> 'provenance';
  v_anomalies jsonb := p_candidate -> 'candidate' -> 'anomalyCodes';
  v_wrapper_anomalies jsonb := p_candidate -> 'anomalyCodes';
  v_kind text;
  v_value text;
  v_outside boolean := false;
  v_scope_mismatch boolean := false;
  v_pricing_invalid boolean := false;
begin
  if pg_catalog.jsonb_typeof(v_wrapper) is distinct from 'object'
     or (select count(*) from pg_catalog.jsonb_object_keys(v_wrapper)) not between 5 and 6
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_wrapper) key
       where key not in ('contractVersion', 'anomalyCodes', 'candidate', 'disposition',
                         'publicationRoute', 'exactCanonicalProductId'))
     or v_wrapper -> 'contractVersion' is distinct from '1'::jsonb
     or pg_catalog.jsonb_typeof(v_wrapper_anomalies) is distinct from 'array'
     or pg_catalog.jsonb_typeof(v_candidate) is distinct from 'object'
     or (select count(*) from pg_catalog.jsonb_object_keys(v_candidate)) <> 11
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_candidate) key
       where key not in ('contractVersion', 'candidateKey', 'product', 'package',
                         'pricing', 'eligibility', 'validity', 'geographicScope',
                         'channels', 'provenance', 'anomalyCodes'))
     or v_candidate -> 'contractVersion' is distinct from '1'::jsonb
     or pg_catalog.jsonb_typeof(v_candidate -> 'candidateKey') is distinct from 'string'
     or v_candidate ->> 'candidateKey' is null
     or pg_catalog.length(pg_catalog.btrim(v_candidate ->> 'candidateKey')) not between 1 and 160
     or v_wrapper_anomalies <> v_anomalies then
    raise exception 'official-offer candidate contract is invalid' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_anomalies) is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_anomalies) > 20
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_anomalies) code
       where pg_catalog.jsonb_typeof(code) is distinct from 'string'
         or code #>> '{}' not in ('AMBIGUOUS_PRODUCT', 'BEFORE_PRICE_BELOW_OFFER',
                                  'DUPLICATE_CANDIDATE_KEY', 'DUPLICATE_OFFER',
                                  'EXTRACTOR_ANOMALY', 'LAYOUT_DRIFT', 'OCR_REVIEW_REQUIRED',
                                  'PACKAGE_UNKNOWN', 'SCHEMA_DRIFT', 'SCOPE_MISMATCH',
                                  'UNEXPECTED_EMPTY', 'UNKNOWN_SCOPE', 'UNMATCHED_PRODUCT',
                                  'UNREADABLE_DATE', 'VALIDITY_OUTSIDE_EDITION'))
     or (select count(*) from pg_catalog.jsonb_array_elements_text(v_anomalies))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(v_anomalies)) then
    raise exception 'official-offer candidate anomaly contract is invalid' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_product) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_product -> 'kind') is distinct from 'string'
     or v_product ->> 'kind' not in ('exact-identifier', 'unresolved-label') then
    raise exception 'official-offer candidate product contract is invalid' using errcode = '22023';
  end if;
  v_kind := v_product ->> 'kind';
  if v_kind = 'exact-identifier' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_product)) <> 3
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_product) key
         where key not in ('kind', 'scheme', 'value'))
       or pg_catalog.jsonb_typeof(v_product -> 'scheme') is distinct from 'string'
       or v_product ->> 'scheme' is distinct from 'gtin'
       or pg_catalog.jsonb_typeof(v_product -> 'value') is distinct from 'string'
       or v_product ->> 'value' is null
       or (v_product ->> 'value') !~ '^(?:[0-9]{8}|[0-9]{13})$' then
      raise exception 'official-offer candidate exact product is invalid' using errcode = '22023';
    end if;
  else
    if (select count(*) from pg_catalog.jsonb_object_keys(v_product)) not between 2 and 3
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_product) key
         where key not in ('kind', 'label', 'brand'))
       or pg_catalog.jsonb_typeof(v_product -> 'label') is distinct from 'string'
       or pg_catalog.length(pg_catalog.btrim(v_product ->> 'label')) not between 1 and 240
       or (v_product ? 'brand' and pg_catalog.jsonb_typeof(v_product -> 'brand') is distinct from 'string')
       or (v_product ? 'brand' and pg_catalog.length(pg_catalog.btrim(v_product ->> 'brand')) not between 1 and 160)
       or p_candidate ? 'exactCanonicalProductId' then
      raise exception 'official-offer candidate unresolved product is invalid' using errcode = '22023';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(v_package) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_package -> 'state') is distinct from 'string'
     or v_package ->> 'state' not in ('parsed', 'unknown') then
    raise exception 'official-offer candidate package contract is invalid' using errcode = '22023';
  end if;
  if v_package ->> 'state' = 'parsed' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_package)) <> 4
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_package) key
         where key not in ('state', 'amount', 'unit', 'unitsPerPack'))
       or pg_catalog.jsonb_typeof(v_package -> 'amount') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_package -> 'unitsPerPack') is distinct from 'number'
       or (v_package ->> 'amount') !~ '^[1-9][0-9]*$'
       or (v_package ->> 'unitsPerPack') !~ '^[1-9][0-9]*$'
       or (v_package ->> 'amount')::numeric > 1000000
       or (v_package ->> 'unitsPerPack')::numeric > 10000
       or pg_catalog.jsonb_typeof(v_package -> 'unit') is distinct from 'string'
       or v_package ->> 'unit' not in ('g', 'ml', 'piece', 'package') then
      raise exception 'official-offer candidate parsed package is invalid' using errcode = '22023';
    end if;
  elsif (select count(*) from pg_catalog.jsonb_object_keys(v_package)) <> 2
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_package) key
       where key not in ('state', 'reasonCode'))
     or pg_catalog.jsonb_typeof(v_package -> 'reasonCode') is distinct from 'string'
     or v_package ->> 'reasonCode' not in ('MISSING', 'UNREADABLE', 'UNSUPPORTED_UNIT') then
    raise exception 'official-offer candidate unknown package is invalid' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_pricing) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_pricing -> 'kind') is distinct from 'string'
     or v_pricing ->> 'kind' not in ('unit', 'multibuy') then
    raise exception 'official-offer candidate pricing contract is invalid' using errcode = '22023';
  end if;
  if v_pricing ->> 'kind' = 'unit' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_pricing)) not between 2 and 3
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_pricing) key
         where key not in ('kind', 'offerPriceOre', 'beforePriceOre'))
       or pg_catalog.jsonb_typeof(v_pricing -> 'offerPriceOre') is distinct from 'number'
       or (v_pricing ? 'beforePriceOre' and pg_catalog.jsonb_typeof(v_pricing -> 'beforePriceOre') is distinct from 'number')
       or (v_pricing ->> 'offerPriceOre') !~ '^(?:0|[1-9][0-9]*)$'
       or (v_pricing ? 'beforePriceOre' and (v_pricing ->> 'beforePriceOre') !~ '^(?:0|[1-9][0-9]*)$') then
      raise exception 'official-offer candidate unit pricing is invalid' using errcode = '22023';
    end if;
    if (v_pricing ->> 'offerPriceOre')::numeric > 1000000000
       or (v_pricing ? 'beforePriceOre' and (v_pricing ->> 'beforePriceOre')::numeric > 1000000000) then
      raise exception 'official-offer candidate unit pricing is out of bounds' using errcode = '22023';
    end if;
    v_pricing_invalid := v_pricing ? 'beforePriceOre'
      and (v_pricing ->> 'beforePriceOre')::numeric < (v_pricing ->> 'offerPriceOre')::numeric;
  else
    if (select count(*) from pg_catalog.jsonb_object_keys(v_pricing)) not between 3 and 4
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_pricing) key
         where key not in ('kind', 'quantity', 'totalOre', 'beforeUnitPriceOre'))
       or pg_catalog.jsonb_typeof(v_pricing -> 'quantity') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_pricing -> 'totalOre') is distinct from 'number'
       or (v_pricing ? 'beforeUnitPriceOre' and pg_catalog.jsonb_typeof(v_pricing -> 'beforeUnitPriceOre') is distinct from 'number')
       or (v_pricing ->> 'quantity') !~ '^[2-9][0-9]*$'
       or (v_pricing ->> 'quantity')::numeric > 100
       or (v_pricing ->> 'totalOre') !~ '^(?:0|[1-9][0-9]*)$'
       or (v_pricing ? 'beforeUnitPriceOre' and (v_pricing ->> 'beforeUnitPriceOre') !~ '^(?:0|[1-9][0-9]*)$')
       or (v_pricing ->> 'totalOre')::numeric > 1000000000
       or (v_pricing ? 'beforeUnitPriceOre' and (v_pricing ->> 'beforeUnitPriceOre')::numeric > 1000000000) then
      raise exception 'official-offer candidate multibuy pricing is invalid' using errcode = '22023';
    end if;
    v_pricing_invalid := v_pricing ? 'beforeUnitPriceOre'
      and (v_pricing ->> 'beforeUnitPriceOre')::numeric * (v_pricing ->> 'quantity')::numeric
        < (v_pricing ->> 'totalOre')::numeric;
  end if;
  if v_pricing_invalid and not (v_anomalies ? 'BEFORE_PRICE_BELOW_OFFER') then
    raise exception 'official-offer candidate pricing anomaly is missing' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_eligibility) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_eligibility -> 'kind') is distinct from 'string'
     or v_eligibility ->> 'kind' not in ('public', 'member')
     or (v_eligibility ->> 'kind' = 'public'
       and ((select count(*) from pg_catalog.jsonb_object_keys(v_eligibility)) <> 1
         or exists (select 1 from pg_catalog.jsonb_object_keys(v_eligibility) key
           where key is distinct from 'kind')))
     or (v_eligibility ->> 'kind' = 'member'
       and ((select count(*) from pg_catalog.jsonb_object_keys(v_eligibility)) <> 2
         or exists (select 1 from pg_catalog.jsonb_object_keys(v_eligibility) key
           where key not in ('kind', 'programId'))
         or pg_catalog.jsonb_typeof(v_eligibility -> 'programId') is distinct from 'string'
         or pg_catalog.length(pg_catalog.btrim(v_eligibility ->> 'programId')) not between 1 and 200)) then
    raise exception 'official-offer candidate eligibility contract is invalid' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_validity) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_validity -> 'state') is distinct from 'string'
     or v_validity ->> 'state' not in ('parsed', 'unreadable') then
    raise exception 'official-offer candidate validity contract is invalid' using errcode = '22023';
  end if;
  if v_validity ->> 'state' = 'parsed' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_validity)) <> 3
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_validity) key
         where key not in ('state', 'startsAt', 'endsAt'))
       or pg_catalog.jsonb_typeof(v_validity -> 'startsAt') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_validity -> 'endsAt') is distinct from 'string'
       or (v_validity ->> 'startsAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or (v_validity ->> 'endsAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or (v_validity ->> 'startsAt')::timestamptz >= (v_validity ->> 'endsAt')::timestamptz then
      raise exception 'official-offer candidate parsed validity is invalid' using errcode = '22023';
    end if;
    v_outside := (v_validity ->> 'startsAt')::timestamptz < (p_edition ->> 'validFrom')::timestamptz
      or (v_validity ->> 'endsAt')::timestamptz > (p_edition ->> 'validUntil')::timestamptz;
    if v_outside and not (v_anomalies ? 'VALIDITY_OUTSIDE_EDITION') then
      raise exception 'official-offer candidate validity anomaly is missing' using errcode = '22023';
    end if;
  elsif (select count(*) from pg_catalog.jsonb_object_keys(v_validity)) <> 2
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_validity) key
       where key not in ('state', 'reasonCode'))
     or pg_catalog.jsonb_typeof(v_validity -> 'reasonCode') is distinct from 'string'
     or v_validity ->> 'reasonCode' not in ('MISSING', 'OCR_AMBIGUOUS', 'UNSUPPORTED_FORMAT')
     or not (v_anomalies ? 'UNREADABLE_DATE') then
    raise exception 'official-offer candidate unreadable validity is invalid' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_scope) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_scope -> 'kind') is distinct from 'string'
     or v_scope ->> 'kind' not in ('national', 'regions', 'postal-set', 'stores', 'unknown') then
    raise exception 'official-offer candidate scope contract is invalid' using errcode = '22023';
  end if;
  v_kind := v_scope ->> 'kind';
  if v_kind = 'national' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_scope)) <> 2
       or v_scope ->> 'countryCode' is null
       or v_scope ->> 'countryCode' !~ '^[A-Z]{2}$' then
      raise exception 'official-offer candidate national scope is invalid' using errcode = '22023';
    end if;
  elsif v_kind = 'regions' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_scope)) <> 3
       or v_scope ->> 'countryCode' is null
       or v_scope ->> 'countryCode' !~ '^[A-Z]{2}$'
       or pg_catalog.jsonb_typeof(v_scope -> 'regionCodes') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_scope -> 'regionCodes') not between 1 and 100
       or exists (select 1 from pg_catalog.jsonb_array_elements(v_scope -> 'regionCodes') member(value)
         where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
           or pg_catalog.length(pg_catalog.btrim(member.value #>> '{}')) not between 1 and 200)
       or (select count(*) from pg_catalog.jsonb_array_elements_text(v_scope -> 'regionCodes'))
         <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(v_scope -> 'regionCodes')) then
      raise exception 'official-offer candidate region scope is invalid' using errcode = '22023';
    end if;
  elsif v_kind = 'postal-set' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_scope)) <> 3
       or v_scope ->> 'countryCode' is null
       or v_scope ->> 'countryCode' !~ '^[A-Z]{2}$'
       or pg_catalog.jsonb_typeof(v_scope -> 'postalCodes') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_scope -> 'postalCodes') not between 1 and 10000
       or exists (select 1 from pg_catalog.jsonb_array_elements_text(v_scope -> 'postalCodes') value where value is null or value !~ '^[0-9]{4}$')
       or (select count(*) from pg_catalog.jsonb_array_elements_text(v_scope -> 'postalCodes'))
         <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(v_scope -> 'postalCodes')) then
      raise exception 'official-offer candidate postal scope is invalid' using errcode = '22023';
    end if;
  elsif v_kind = 'stores' then
    if (select count(*) from pg_catalog.jsonb_object_keys(v_scope)) <> 2
       or pg_catalog.jsonb_typeof(v_scope -> 'storeIds') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_scope -> 'storeIds') not between 1 and 1000
       or exists (select 1 from pg_catalog.jsonb_array_elements(v_scope -> 'storeIds') member(value)
         where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
           or pg_catalog.length(pg_catalog.btrim(member.value #>> '{}')) not between 1 and 200)
       or (select count(*) from pg_catalog.jsonb_array_elements_text(v_scope -> 'storeIds'))
         <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(v_scope -> 'storeIds')) then
      raise exception 'official-offer candidate store scope is invalid' using errcode = '22023';
    end if;
  elsif (select count(*) from pg_catalog.jsonb_object_keys(v_scope)) <> 2
     or pg_catalog.jsonb_typeof(v_scope -> 'reason') is distinct from 'string'
     or pg_catalog.length(pg_catalog.btrim(v_scope ->> 'reason')) not between 1 and 500
     or not (v_anomalies ? 'UNKNOWN_SCOPE') then
    raise exception 'official-offer candidate unknown scope is invalid' using errcode = '22023';
  end if;
  v_scope_mismatch := v_scope <> (p_edition -> 'declaredGeographicScope');
  if v_scope_mismatch and v_kind <> 'unknown' and not (v_anomalies ? 'SCOPE_MISMATCH') then
    raise exception 'official-offer candidate scope anomaly is missing' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_provenance) is distinct from 'object'
     or (select count(*) from pg_catalog.jsonb_object_keys(v_provenance)) <> 3
     or pg_catalog.jsonb_typeof(v_provenance -> 'method') is distinct from 'string'
     or v_provenance ->> 'method' is distinct from p_method
     or v_provenance ->> 'method' not in ('structured', 'embedded-text', 'ocr')
     or pg_catalog.jsonb_typeof(v_provenance -> 'evidenceLocator') is distinct from 'string'
     or pg_catalog.length(pg_catalog.btrim(v_provenance ->> 'evidenceLocator')) not between 1 and 200
     or pg_catalog.jsonb_typeof(v_provenance -> 'confidence') is distinct from 'number'
     or (v_provenance ->> 'confidence') !~ '^(?:0|[1-9][0-9]?|100)$'
     or (v_provenance ->> 'confidence')::integer > 100
     or (p_method = 'ocr' and not (v_anomalies ? 'OCR_REVIEW_REQUIRED')) then
    raise exception 'official-offer candidate provenance contract is invalid' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_candidate -> 'channels') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_candidate -> 'channels') not between 1 and 2
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_candidate -> 'channels') channel(value)
       where pg_catalog.jsonb_typeof(channel.value) is distinct from 'string'
         or channel.value #>> '{}' not in ('in-store', 'online'))
     or (select count(*) from pg_catalog.jsonb_array_elements_text(v_candidate -> 'channels'))
         <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(v_candidate -> 'channels')) then
    raise exception 'official-offer candidate channels are invalid' using errcode = '22023';
  end if;
  if v_package ->> 'state' = 'unknown' and not (v_anomalies ? 'PACKAGE_UNKNOWN') then
    raise exception 'official-offer candidate package anomaly is missing' using errcode = '22023';
  end if;

  v_value := p_candidate ->> 'disposition';
  if pg_catalog.jsonb_typeof(p_candidate -> 'disposition') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_candidate -> 'publicationRoute') is distinct from 'string'
     or v_value not in ('exact-match', 'rejected', 'review-required')
     or (v_value = 'exact-match' and pg_catalog.jsonb_array_length(v_anomalies) <> 0)
     or (v_value = 'review-required' and pg_catalog.jsonb_array_length(v_anomalies) = 0)
     or (v_value = 'rejected' and not (v_anomalies ?| array['BEFORE_PRICE_BELOW_OFFER', 'DUPLICATE_CANDIDATE_KEY']))
     or p_candidate ->> 'publicationRoute' is distinct from (case when v_value = 'rejected' then 'blocked' else 'human-review-required' end)
     or (p_candidate ? 'exactCanonicalProductId' and (
       pg_catalog.jsonb_typeof(p_candidate -> 'exactCanonicalProductId') is distinct from 'string'
       or
       p_candidate ->> 'exactCanonicalProductId' is null
       or pg_catalog.length(pg_catalog.btrim(p_candidate ->> 'exactCanonicalProductId')) not between 1 and 200
     )) then
    raise exception 'official-offer candidate disposition binding is invalid' using errcode = '22023';
  end if;
end;
$$;

create function public.record_official_offer_edition_v1(
  p_edition jsonb,
  p_authorization jsonb
)
returns table(created boolean, id bigint, status text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_source_id text;
  v_external_id text;
  v_chain text;
  v_title text;
  v_content_kind text;
  v_scope_id bigint;
  v_declared_scope jsonb;
  v_valid_from timestamptz;
  v_valid_until timestamptz;
  v_discovered_at timestamptz;
  v_existing public.publications%rowtype;
  v_created boolean;
begin
  if pg_catalog.jsonb_typeof(p_edition) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_authorization) is distinct from 'object'
     or pg_catalog.pg_column_size(p_edition) > 65536
     or pg_catalog.pg_column_size(p_authorization) > 16384
     or p_edition -> 'contractVersion' is distinct from '1'::jsonb
     or p_authorization -> 'contractVersion' is distinct from '1'::jsonb
     or pg_catalog.jsonb_typeof(p_edition -> 'sourceId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'externalEditionId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'chain') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'title') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'contentKind') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'geographicScopeId') is distinct from 'number'
     or p_edition ->> 'geographicScopeId' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(p_edition -> 'declaredGeographicScope') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_edition -> 'validFrom') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'validUntil') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'discoveredAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_edition -> 'authorization') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_authorization -> 'permissionId') is distinct from 'number'
     or p_authorization ->> 'permissionId' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(p_authorization -> 'sourceId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'decision') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'reviewedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'evaluatedAt') is distinct from 'string'
     or (p_authorization ? 'validUntil'
       and pg_catalog.jsonb_typeof(p_authorization -> 'validUntil') is distinct from 'string')
     or pg_catalog.jsonb_typeof(p_authorization -> 'capabilities') is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_authorization -> 'rightsClassifications') is distinct from 'array'
     or p_authorization ->> 'decision' is distinct from 'approved' then
    raise exception 'official-offer edition payload is invalid' using errcode = '22023';
  end if;

  v_source_id := p_edition ->> 'sourceId';
  v_external_id := p_edition ->> 'externalEditionId';
  v_chain := p_edition ->> 'chain';
  v_title := p_edition ->> 'title';
  v_content_kind := p_edition ->> 'contentKind';
  v_scope_id := (p_edition ->> 'geographicScopeId')::bigint;
  v_declared_scope := p_edition -> 'declaredGeographicScope';
  v_valid_from := (p_edition ->> 'validFrom')::timestamptz;
  v_valid_until := (p_edition ->> 'validUntil')::timestamptz;
  v_discovered_at := (p_edition ->> 'discoveredAt')::timestamptz;

  if v_source_id is null or pg_catalog.length(v_source_id) > 64
     or v_external_id is null or pg_catalog.length(v_external_id) > 160
     or v_chain is null or pg_catalog.length(v_chain) > 32
     or v_title is null or pg_catalog.length(v_title) > 240
     or v_content_kind is null or v_content_kind not in ('structured-feed', 'publication')
     or v_scope_id is null or v_scope_id not between 1 and 9007199254740991
     or v_declared_scope is null
     or v_valid_from is null or v_valid_until is null or v_discovered_at is null then
    raise exception 'official-offer edition payload is invalid' using errcode = '22023';
  end if;

  if p_edition -> 'authorization' ->> 'decision' is distinct from 'approved'
     or p_authorization ->> 'sourceId' is distinct from v_source_id
     or p_edition -> 'authorization' -> 'capabilities'
       is distinct from p_authorization -> 'capabilities'
     or p_edition -> 'authorization' ->> 'reviewedAt'
       is distinct from p_authorization ->> 'reviewedAt'
     or p_edition -> 'authorization' -> 'validUntil'
       is distinct from p_authorization -> 'validUntil' then
    raise exception 'official-offer edition authorization fence mismatch'
      using errcode = '42501';
  end if;

  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (p_authorization ->> 'permissionId')::bigint,
    p_authorization -> 'capabilities',
    p_authorization -> 'rightsClassifications',
    'discover', null,
    p_authorization ->> 'reviewedAt',
    p_authorization ->> 'validUntil',
    p_authorization ->> 'evaluatedAt'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_source_id, 7229164304)
  );

  insert into public.publications (
    source_id, external_id, chain, title, valid_from, valid_until,
    geographic_scope_id, status, discovered_at, content_kind,
    declared_geographic_scope, edition_identity_sha256, discovery_permission_id
  ) values (
    v_source_id, v_external_id, v_chain, v_title, v_valid_from, v_valid_until,
    v_scope_id, 'discovered', v_discovered_at, v_content_kind, v_declared_scope,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      public.canonical_official_offer_edition_identity(
        v_source_id, v_external_id, v_chain, v_title, v_content_kind, v_scope_id,
        v_declared_scope, v_valid_from, v_valid_until, v_discovered_at
      ), 'UTF8')), 'hex'),
    (p_authorization ->> 'permissionId')::bigint
  )
  on conflict (source_id, external_id) do nothing
  returning public.publications.* into v_existing;
  v_created := found;

  if not v_created then
    select publication.* into v_existing
    from public.publications publication
    where publication.source_id = v_source_id
      and publication.external_id = v_external_id
    limit 1 for update;
  end if;
  if v_existing.id is null then
    raise exception 'official-offer edition persistence did not return a publication'
      using errcode = '40001';
  end if;

  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (p_authorization ->> 'permissionId')::bigint,
    p_authorization -> 'capabilities',
    p_authorization -> 'rightsClassifications',
    'discover', null,
    p_authorization ->> 'reviewedAt',
    p_authorization ->> 'validUntil',
    p_authorization ->> 'evaluatedAt'
  );
  return query select v_created, v_existing.id, v_existing.status::text;
end;
$$;

create function public.record_official_offer_capture_v1(
  p_metadata jsonb,
  p_blob_key text,
  p_authorization jsonb
)
returns table(blob_key text, created boolean, id bigint, retrieved_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_publication public.publications%rowtype;
  v_capture public.publication_captures%rowtype;
  v_created boolean;
  v_source_id text;
  v_external_id text;
  v_publication_id bigint;
  v_checksum text;
  v_mime_type text;
  v_byte_length integer;
  v_rights text;
  v_retrieved_at text;
begin
  if pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_authorization) is distinct from 'object'
     or pg_catalog.pg_column_size(p_metadata) > 16384
     or pg_catalog.pg_column_size(p_authorization) > 16384
     or p_metadata -> 'contractVersion' is distinct from '1'::jsonb
     or p_authorization -> 'contractVersion' is distinct from '1'::jsonb
     or pg_catalog.jsonb_typeof(p_metadata -> 'publicationId') is distinct from 'number'
     or p_metadata ->> 'publicationId' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(p_metadata -> 'sourceId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_metadata -> 'externalEditionId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_metadata -> 'checksumSha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_metadata -> 'mimeType') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_metadata -> 'byteLength') is distinct from 'number'
     or p_metadata ->> 'byteLength' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(p_metadata -> 'rightsClassification') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_metadata -> 'retrievedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'permissionId') is distinct from 'number'
     or p_authorization ->> 'permissionId' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(p_authorization -> 'sourceId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'decision') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'reviewedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_authorization -> 'evaluatedAt') is distinct from 'string'
     or (p_authorization ? 'validUntil'
       and pg_catalog.jsonb_typeof(p_authorization -> 'validUntil') is distinct from 'string')
     or pg_catalog.jsonb_typeof(p_authorization -> 'capabilities') is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_authorization -> 'rightsClassifications') is distinct from 'array'
     or p_authorization ->> 'decision' is distinct from 'approved'
     or p_blob_key is null or pg_catalog.length(p_blob_key) not between 1 and 1024
     or p_blob_key ~ '(^/|\.\.)'
     or p_blob_key !~ '^[A-Za-z0-9_./:-]+$' then
    raise exception 'official-offer capture payload is invalid' using errcode = '22023';
  end if;
  v_publication_id := (p_metadata ->> 'publicationId')::bigint;
  v_source_id := p_metadata ->> 'sourceId';
  v_external_id := p_metadata ->> 'externalEditionId';
  v_checksum := p_metadata ->> 'checksumSha256';
  v_mime_type := p_metadata ->> 'mimeType';
  v_byte_length := (p_metadata ->> 'byteLength')::integer;
  v_rights := p_metadata ->> 'rightsClassification';
  v_retrieved_at := p_metadata ->> 'retrievedAt';
  if pg_catalog.jsonb_typeof(p_metadata -> 'publicationId') is distinct from 'number'
     or pg_catalog.jsonb_typeof(p_metadata -> 'byteLength') is distinct from 'number'
     or v_publication_id is null or v_publication_id not between 1 and 9007199254740991
     or v_source_id is null or pg_catalog.length(v_source_id) > 64
     or v_external_id is null or pg_catalog.length(v_external_id) > 160
     or v_checksum is null or v_checksum !~ '^[0-9a-f]{64}$'
     or v_mime_type is null or pg_catalog.length(v_mime_type) not between 1 and 120
     or v_byte_length is null or v_byte_length not between 1 and 52428800
     or v_rights is null or v_rights not in ('extract_only', 'private_review', 'public_display')
     or v_retrieved_at is null
     or v_retrieved_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or pg_catalog.to_char(v_retrieved_at::timestamptz at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_retrieved_at then
    raise exception 'official-offer capture payload is invalid' using errcode = '22023';
  end if;
  if p_authorization ->> 'sourceId' is distinct from v_source_id then
    raise exception 'official-offer capture authorization source mismatch'
      using errcode = '42501';
  end if;

  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (p_authorization ->> 'permissionId')::bigint,
    p_authorization -> 'capabilities',
    p_authorization -> 'rightsClassifications',
    'capture', v_rights,
    p_authorization ->> 'reviewedAt',
    p_authorization ->> 'validUntil',
    p_authorization ->> 'evaluatedAt'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_source_id, 7229164304)
  );

  select publication.* into v_publication
  from public.publications publication
  where publication.id = v_publication_id
  limit 1 for update;
  if v_publication.id is null
     or v_publication.source_id <> v_source_id
     or v_publication.external_id <> v_external_id then
    raise exception 'official-offer capture does not match its publication'
      using errcode = '40001';
  end if;

  insert into public.publication_captures (
    publication_id, blob_key, checksum, mime_type, byte_length,
    rights_classification, retrieved_at, capture_permission_id,
    capture_permission_capabilities
  ) values (
    v_publication_id, p_blob_key, v_checksum, v_mime_type, v_byte_length,
    v_rights, pg_catalog.clock_timestamp(),
    (p_authorization ->> 'permissionId')::bigint,
    p_authorization -> 'capabilities'
  )
  on conflict (publication_id, checksum) do nothing
  returning public.publication_captures.* into v_capture;
  v_created := found;
  if not v_created then
    select capture.* into v_capture
    from public.publication_captures capture
    where capture.publication_id = v_publication_id
      and capture.checksum = v_checksum
    limit 1 for update;
  end if;
  if v_capture.id is null then
    raise exception 'official-offer capture persistence did not return a capture'
      using errcode = '40001';
  end if;

  update public.publications
  set status = case when status = 'discovered' then 'captured' else status end,
      updated_at = pg_catalog.clock_timestamp()
  where public.publications.id = v_publication_id;

  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (p_authorization ->> 'permissionId')::bigint,
    p_authorization -> 'capabilities',
    p_authorization -> 'rightsClassifications',
    'capture', v_rights,
    p_authorization ->> 'reviewedAt',
    p_authorization ->> 'validUntil',
    p_authorization ->> 'evaluatedAt'
  );
  return query select p_blob_key, v_created, v_capture.id, v_capture.retrieved_at;
end;
$$;

create function public.record_official_offer_extraction_v1(
  p_capture_id bigint,
  p_payload jsonb
)
returns table(counts jsonb, created boolean, id bigint, status text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_capture public.publication_captures%rowtype;
  v_publication public.publications%rowtype;
  v_extraction public.extraction_runs%rowtype;
  v_created boolean;
  v_envelope jsonb := p_payload -> 'envelope';
  v_edition jsonb := p_payload -> 'edition';
  v_authorization jsonb := p_payload -> 'authorization';
  v_ocr_authorization jsonb := p_payload -> 'ocrAuthorization';
  v_source_id text;
  v_external_id text;
  v_scope_id bigint;
  v_chain text;
  v_title text;
  v_content_kind text;
  v_declared_scope jsonb;
  v_valid_from timestamptz;
  v_valid_until timestamptz;
  v_discovered_at timestamptz;
  v_status text;
  v_error_class text;
  v_counts jsonb := p_payload -> 'counts';
  v_candidates jsonb := p_payload -> 'candidates';
  v_server_started_at timestamptz;
  v_server_completed_at timestamptz;
  v_source_started_at timestamptz;
  v_source_completed_at timestamptz;
  v_method text;
  v_capture_checksum text;
  v_extractor_version text;
  v_empty_result text;
  v_empty_confirmation jsonb;
  v_expected_identity text;
  v_candidate jsonb;
begin
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
     or pg_catalog.pg_column_size(p_payload) > 4 * 1024 * 1024
     or p_payload -> 'contractVersion' is distinct from '1'::jsonb
     or p_capture_id is null or p_capture_id not between 1 and 9007199254740991
     or pg_catalog.jsonb_typeof(v_envelope) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_edition) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_authorization) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_payload -> 'timing') is distinct from 'object'
     or v_envelope -> 'contractVersion' is distinct from '1'::jsonb
     or v_edition -> 'contractVersion' is distinct from '1'::jsonb
     or v_authorization -> 'contractVersion' is distinct from '1'::jsonb
     or p_payload -> 'timing' -> 'contractVersion' is distinct from '1'::jsonb
     or pg_catalog.jsonb_typeof(v_envelope -> 'captureChecksumSha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'extractorVersion') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'method') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'layoutFingerprintSha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'schemaFingerprintSha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'startedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'completedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_envelope -> 'emptyResult') is distinct from 'string'
     or (v_envelope ? 'emptyConfirmation'
       and pg_catalog.jsonb_typeof(v_envelope -> 'emptyConfirmation') is distinct from 'object')
     or pg_catalog.jsonb_typeof(v_edition -> 'sourceId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'externalEditionId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'chain') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'title') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'contentKind') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'geographicScopeId') is distinct from 'number'
     or v_edition ->> 'geographicScopeId' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(v_edition -> 'declaredGeographicScope') is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_edition -> 'validFrom') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'validUntil') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'discoveredAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_edition -> 'authorization') is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_authorization -> 'permissionId') is distinct from 'number'
     or v_authorization ->> 'permissionId' !~ '^[1-9][0-9]*$'
     or pg_catalog.jsonb_typeof(v_authorization -> 'sourceId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_authorization -> 'decision') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_authorization -> 'reviewedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_authorization -> 'evaluatedAt') is distinct from 'string'
     or (v_authorization ? 'validUntil'
       and pg_catalog.jsonb_typeof(v_authorization -> 'validUntil') is distinct from 'string')
     or pg_catalog.jsonb_typeof(v_authorization -> 'capabilities') is distinct from 'array'
     or pg_catalog.jsonb_typeof(v_authorization -> 'rightsClassifications') is distinct from 'array'
     or (v_ocr_authorization is not null
       and (pg_catalog.jsonb_typeof(v_ocr_authorization) is distinct from 'object'
         or v_ocr_authorization -> 'contractVersion' is distinct from '1'::jsonb
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'permissionId') is distinct from 'number'
         or v_ocr_authorization ->> 'permissionId' !~ '^[1-9][0-9]*$'
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'sourceId') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'decision') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'reviewedAt') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'evaluatedAt') is distinct from 'string'
         or (v_ocr_authorization ? 'validUntil'
           and pg_catalog.jsonb_typeof(v_ocr_authorization -> 'validUntil') is distinct from 'string')
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'capabilities') is distinct from 'array'
         or pg_catalog.jsonb_typeof(v_ocr_authorization -> 'rightsClassifications') is distinct from 'array'))
     or pg_catalog.jsonb_typeof(v_counts) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_candidates) is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_payload -> 'timing' -> 'serverStartedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_payload -> 'timing' -> 'serverCompletedAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_payload -> 'validationStatus') is distinct from 'string'
     or (p_payload ? 'validationErrorClass'
       and pg_catalog.jsonb_typeof(p_payload -> 'validationErrorClass') is distinct from 'string')
     or pg_catalog.jsonb_array_length(v_candidates) > 500
     or pg_catalog.jsonb_typeof(v_envelope -> 'candidates') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_envelope -> 'candidates') > 500
     or v_envelope ->> 'captureChecksumSha256' !~ '^[0-9a-f]{64}$'
     or v_envelope ->> 'layoutFingerprintSha256' !~ '^[0-9a-f]{64}$'
     or v_envelope ->> 'schemaFingerprintSha256' !~ '^[0-9a-f]{64}$'
     or v_envelope ->> 'startedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or v_envelope ->> 'completedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or (v_envelope ->> 'startedAt')::timestamptz > (v_envelope ->> 'completedAt')::timestamptz then
    raise exception 'official-offer extraction payload is invalid' using errcode = '22023';
  end if;

  v_source_id := v_edition ->> 'sourceId';
  v_external_id := v_edition ->> 'externalEditionId';
  v_chain := v_edition ->> 'chain';
  v_title := v_edition ->> 'title';
  v_content_kind := v_edition ->> 'contentKind';
  v_scope_id := (v_edition ->> 'geographicScopeId')::bigint;
  v_declared_scope := v_edition -> 'declaredGeographicScope';
  v_valid_from := (v_edition ->> 'validFrom')::timestamptz;
  v_valid_until := (v_edition ->> 'validUntil')::timestamptz;
  v_discovered_at := (v_edition ->> 'discoveredAt')::timestamptz;
  v_method := v_envelope ->> 'method';
  v_extractor_version := v_envelope ->> 'extractorVersion';
  v_empty_result := v_envelope ->> 'emptyResult';
  v_empty_confirmation := v_envelope -> 'emptyConfirmation';
  v_source_started_at := (v_envelope ->> 'startedAt')::timestamptz;
  v_source_completed_at := (v_envelope ->> 'completedAt')::timestamptz;
  v_capture_checksum := v_envelope ->> 'captureChecksumSha256';
  v_server_started_at := (p_payload -> 'timing' ->> 'serverStartedAt')::timestamptz;
  v_server_completed_at := (p_payload -> 'timing' ->> 'serverCompletedAt')::timestamptz;
  v_status := p_payload ->> 'validationStatus';
  v_error_class := p_payload ->> 'validationErrorClass';

  if v_source_id is null or v_external_id is null or v_scope_id is null
     or v_chain is null or v_title is null or v_content_kind is null
     or v_valid_from is null or v_valid_until is null or v_discovered_at is null
     or v_method is null or v_method not in ('structured', 'embedded-text', 'ocr')
     or v_extractor_version is null or pg_catalog.length(v_extractor_version) > 80
     or v_empty_result is null or v_empty_result not in ('not-empty', 'confirmed-empty', 'unexpected-empty')
     or v_source_started_at is null or v_source_completed_at is null
     or v_server_started_at is null
     or v_server_completed_at is null
     or p_payload -> 'timing' ->> 'serverStartedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or p_payload -> 'timing' ->> 'serverCompletedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or v_server_started_at > v_server_completed_at
     or v_server_completed_at - v_server_started_at > interval '10 minutes'
     or v_source_started_at > v_source_completed_at
     or v_source_completed_at - v_source_started_at > interval '10 minutes'
     or v_status is null or v_status not in ('completed', 'degraded', 'failed')
     or (v_error_class is not null and v_error_class not in
       ('INVALID_CONTRACT', 'LAYOUT_DRIFT', 'SCHEMA_DRIFT', 'UNEXPECTED_EMPTY')) then
    raise exception 'official-offer extraction payload is invalid' using errcode = '22023';
  end if;
  if v_authorization ->> 'decision' is distinct from 'approved'
     or v_edition -> 'authorization' ->> 'decision' is distinct from 'approved'
     or v_edition -> 'authorization' -> 'capabilities' is distinct from v_authorization -> 'capabilities'
     or v_edition -> 'authorization' ->> 'reviewedAt' is distinct from v_authorization ->> 'reviewedAt'
     or v_edition -> 'authorization' -> 'validUntil' is distinct from v_authorization -> 'validUntil'
     or v_authorization ->> 'sourceId' is distinct from v_source_id
     or pg_catalog.jsonb_typeof(v_authorization -> 'rightsClassifications') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_authorization -> 'rightsClassifications') not between 1 and 3
     or exists (select 1 from pg_catalog.jsonb_array_elements_text(v_authorization -> 'rightsClassifications') right_class
       where right_class not in ('extract_only', 'private_review', 'public_display'))
     or (select count(*) from pg_catalog.jsonb_array_elements_text(v_authorization -> 'rightsClassifications'))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(v_authorization -> 'rightsClassifications')) then
    raise exception 'official-offer extraction authorization binding is invalid' using errcode = '42501';
  end if;
  if (v_empty_result = 'not-empty' and pg_catalog.jsonb_array_length(v_envelope -> 'candidates') = 0)
     or (v_empty_result <> 'not-empty' and pg_catalog.jsonb_array_length(v_envelope -> 'candidates') <> 0)
     or pg_catalog.jsonb_array_length(v_candidates) > pg_catalog.jsonb_array_length(v_envelope -> 'candidates')
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_envelope -> 'candidates') as envelope_entries(item)
       where item -> 'contractVersion' is distinct from '1'::jsonb
          or pg_catalog.jsonb_typeof(item -> 'anomalyCodes') is distinct from 'array'
          or exists (
            select 1 from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(item -> 'anomalyCodes') = 'array'
                then item -> 'anomalyCodes' else '[]'::jsonb end
            ) as anomaly(code)
            where pg_catalog.jsonb_typeof(anomaly.code) is distinct from 'string'
          )
          or pg_catalog.jsonb_array_length(
            case when pg_catalog.jsonb_typeof(item -> 'anomalyCodes') = 'array'
              then item -> 'anomalyCodes' else '[]'::jsonb end
          ) > 20
          or (
            select count(*) from pg_catalog.jsonb_array_elements_text(
              case when pg_catalog.jsonb_typeof(item -> 'anomalyCodes') = 'array'
                then item -> 'anomalyCodes' else '[]'::jsonb end
            ) as anomaly(code)
            where code not in (
              'AMBIGUOUS_PRODUCT', 'BEFORE_PRICE_BELOW_OFFER',
              'DUPLICATE_CANDIDATE_KEY', 'DUPLICATE_OFFER', 'EXTRACTOR_ANOMALY',
              'LAYOUT_DRIFT', 'OCR_REVIEW_REQUIRED', 'PACKAGE_UNKNOWN',
              'SCHEMA_DRIFT', 'SCOPE_MISMATCH', 'UNEXPECTED_EMPTY',
              'UNKNOWN_SCOPE', 'UNMATCHED_PRODUCT', 'UNREADABLE_DATE',
              'VALIDITY_OUTSIDE_EDITION'
            )
          ) > 0
          or (
            select count(*) from pg_catalog.jsonb_array_elements_text(
              case when pg_catalog.jsonb_typeof(item -> 'anomalyCodes') = 'array'
                then item -> 'anomalyCodes' else '[]'::jsonb end
            ) as anomaly(code)
          ) <> (
            select count(distinct code) from pg_catalog.jsonb_array_elements_text(
              case when pg_catalog.jsonb_typeof(item -> 'anomalyCodes') = 'array'
                then item -> 'anomalyCodes' else '[]'::jsonb end
            ) as anomaly(code)
          )
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements(v_candidates) as wrapper_entries(wrapper)
            where (item - 'anomalyCodes') is not distinct from
              ((wrapper_entries.wrapper -> 'candidate') - 'anomalyCodes')
              and (wrapper_entries.wrapper -> 'anomalyCodes') @> (item -> 'anomalyCodes')
          )
     ) then
    raise exception 'official-offer extraction envelope candidate binding is invalid' using errcode = '22023';
  end if;
  if (v_error_class in ('INVALID_CONTRACT', 'SCHEMA_DRIFT') and v_status is distinct from 'failed')
     or (v_error_class in ('LAYOUT_DRIFT', 'UNEXPECTED_EMPTY') and v_status is distinct from 'degraded')
     or (v_error_class is null and v_status = 'failed') then
    raise exception 'official-offer extraction validation error binding is invalid' using errcode = '22023';
  end if;
  if (select count(*) from pg_catalog.jsonb_object_keys(v_counts)) <> 7
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_counts) key
       where key not in ('envelopeSha256', 'exactMatch', 'persistedCandidates', 'rejected',
                         'reviewRequired', 'total', 'validationSha256'))
     or pg_catalog.jsonb_typeof(v_counts -> 'envelopeSha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_counts -> 'validationSha256') is distinct from 'string'
     or (v_counts ->> 'envelopeSha256') !~ '^[0-9a-f]{64}$'
     or (v_counts ->> 'validationSha256') !~ '^[0-9a-f]{64}$'
     or pg_catalog.jsonb_typeof(v_counts -> 'exactMatch') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_counts -> 'persistedCandidates') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_counts -> 'rejected') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_counts -> 'reviewRequired') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_counts -> 'total') is distinct from 'number'
     or (v_counts ->> 'exactMatch') !~ '^(?:0|[1-9][0-9]*)$'
     or (v_counts ->> 'persistedCandidates') !~ '^(?:0|[1-9][0-9]*)$'
     or (v_counts ->> 'rejected') !~ '^(?:0|[1-9][0-9]*)$'
     or (v_counts ->> 'reviewRequired') !~ '^(?:0|[1-9][0-9]*)$'
     or (v_counts ->> 'total') !~ '^(?:0|[1-9][0-9]*)$'
     or (v_counts ->> 'persistedCandidates')::integer <> pg_catalog.jsonb_array_length(v_candidates)
     or (v_counts ->> 'total')::integer <> (v_counts ->> 'exactMatch')::integer
       + (v_counts ->> 'rejected')::integer + (v_counts ->> 'reviewRequired')::integer then
    raise exception 'official-offer extraction counts are invalid' using errcode = '22023';
  end if;
  for v_candidate in select value from pg_catalog.jsonb_array_elements(v_candidates) loop
    perform public.official_offer_worker_validate_candidate_v1(v_candidate, v_method, v_edition);
  end loop;
  if exists (
    select 1
    from (
      select value -> 'candidate' ->> 'candidateKey' as candidate_key
      from pg_catalog.jsonb_array_elements(v_candidates)
    ) candidate_keys
    group by candidate_key
    having count(*) > 1
  ) then
    raise exception 'official-offer extraction candidate keys must be unique' using errcode = '22023';
  end if;
  if (v_counts ->> 'exactMatch')::integer <> (
       select count(*) from pg_catalog.jsonb_array_elements(v_candidates)
       where value ->> 'disposition' = 'exact-match'
     )
     or (v_counts ->> 'rejected')::integer <> (
       select count(*) from pg_catalog.jsonb_array_elements(v_candidates)
       where value ->> 'disposition' = 'rejected'
     )
     or (v_counts ->> 'reviewRequired')::integer <> (
       select count(*) from pg_catalog.jsonb_array_elements(v_candidates)
       where value ->> 'disposition' = 'review-required'
     ) then
    raise exception 'official-offer extraction candidate counts do not match dispositions' using errcode = '22023';
  end if;
  if v_authorization ->> 'sourceId' is distinct from v_source_id then
    raise exception 'official-offer extraction authorization source mismatch'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_source_id, 7229164304)
  );
  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (v_authorization ->> 'permissionId')::bigint,
    v_authorization -> 'capabilities',
    v_authorization -> 'rightsClassifications',
    'extract', null,
    v_authorization ->> 'reviewedAt',
    v_authorization ->> 'validUntil',
    v_authorization ->> 'evaluatedAt'
  );
  if v_method = 'ocr' then
    if pg_catalog.jsonb_typeof(v_ocr_authorization) is distinct from 'object' then
      raise exception 'OCR extraction requires an OCR authorization fence'
        using errcode = '42501';
    end if;
    perform public.official_offer_worker_assert_fence_v1(
      v_source_id,
      (v_ocr_authorization ->> 'permissionId')::bigint,
      v_ocr_authorization -> 'capabilities',
      v_ocr_authorization -> 'rightsClassifications',
      'ocr', null,
      v_ocr_authorization ->> 'reviewedAt',
      v_ocr_authorization ->> 'validUntil',
      v_ocr_authorization ->> 'evaluatedAt'
    );
  elsif v_ocr_authorization is not null then
    raise exception 'non-OCR extraction cannot carry OCR authorization'
      using errcode = '42501';
  end if;

  select capture.* into v_capture
  from public.publication_captures capture
  where capture.id = p_capture_id
  limit 1 for update;
  select publication.* into v_publication
  from public.publications publication
  where publication.id = v_capture.publication_id
  limit 1 for update;
  if v_capture.id is null or v_publication.id is null
     or v_capture.checksum <> v_capture_checksum
     or v_publication.source_id <> v_source_id
     or v_publication.external_id <> (v_edition ->> 'externalEditionId')
     or v_publication.chain <> v_chain
     or v_publication.title <> v_title
     or v_publication.content_kind <> v_content_kind
     or v_publication.geographic_scope_id <> v_scope_id
     or v_publication.declared_geographic_scope is distinct from v_declared_scope
     or v_publication.valid_from <> v_valid_from
     or v_publication.valid_until <> v_valid_until
     or v_publication.discovered_at <> v_discovered_at
     or v_capture.capture_permission_id is null then
    raise exception 'official-offer extraction provenance does not match its capture'
      using errcode = '40001';
  end if;
  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (v_authorization ->> 'permissionId')::bigint,
    v_authorization -> 'capabilities',
    v_authorization -> 'rightsClassifications',
    'extract', v_capture.rights_classification,
    v_authorization ->> 'reviewedAt',
    v_authorization ->> 'validUntil',
    v_authorization ->> 'evaluatedAt'
  );

  v_expected_identity := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    public.canonical_official_offer_edition_identity(
      v_publication.source_id, v_publication.external_id, v_publication.chain,
      v_publication.title, v_publication.content_kind,
      v_publication.geographic_scope_id, v_publication.declared_geographic_scope,
      v_publication.valid_from, v_publication.valid_until, v_publication.discovered_at
    ), 'UTF8')), 'hex');
  if v_publication.edition_identity_sha256 is distinct from v_expected_identity then
    raise exception 'official-offer publication identity is invalid'
      using errcode = '40001';
  end if;

  insert into public.extraction_runs (
    capture_id, extractor_version, status, started_at, completed_at, counts,
    error_class, extraction_method, extraction_permission_id, ocr_permission_id,
    permission_capabilities, source_started_at, source_completed_at, empty_result,
    empty_confirmation, empty_confirmation_observed_at
  ) values (
    p_capture_id, v_extractor_version, v_status, v_server_started_at,
    pg_catalog.clock_timestamp(), v_counts, v_error_class, v_method,
    (v_authorization ->> 'permissionId')::bigint,
    case when v_method = 'ocr' then (v_ocr_authorization ->> 'permissionId')::bigint else null end,
    v_authorization -> 'capabilities', v_source_started_at, v_source_completed_at,
    v_empty_result, v_empty_confirmation, null
  )
  on conflict (capture_id, extractor_version) do nothing
  returning public.extraction_runs.* into v_extraction;
  v_created := found;
  if not v_created then
    select extraction.* into v_extraction
    from public.extraction_runs extraction
    where extraction.capture_id = p_capture_id
      and extraction.extractor_version = v_extractor_version
    limit 1 for update;
  end if;
  if v_extraction.id is null then
    raise exception 'official-offer extraction persistence did not return a run'
      using errcode = '40001';
  end if;

  if v_created then
    insert into public.extracted_offer_candidates (
      extraction_run_id, candidate_key, normalized_fields, confidence,
      status, anomaly_codes
    )
    select
      v_extraction.id,
      candidate.item -> 'candidate' ->> 'candidateKey',
      candidate.item,
      ((candidate.item -> 'candidate' -> 'provenance' ->> 'confidence')::smallint),
      case when candidate.item ->> 'publicationRoute' = 'human-review-required'
        then 'pending' else 'rejected' end,
      candidate.item -> 'anomalyCodes'
    from pg_catalog.jsonb_array_elements(v_candidates) as candidate(item);
  end if;

  perform public.official_offer_worker_assert_fence_v1(
    v_source_id,
    (v_authorization ->> 'permissionId')::bigint,
    v_authorization -> 'capabilities',
    v_authorization -> 'rightsClassifications',
    'extract', v_capture.rights_classification,
    v_authorization ->> 'reviewedAt',
    v_authorization ->> 'validUntil',
    v_authorization ->> 'evaluatedAt'
  );
  return query select v_counts, v_created, v_extraction.id, v_extraction.status::text;
end;
$$;

revoke all on function public.official_offer_worker_assert_fence_v1(
  text, bigint, jsonb, jsonb, text, text, text, text, text
) from public, handleplan_app;
revoke all on function public.official_offer_worker_validate_candidate_v1(jsonb, text, jsonb)
  from public, handleplan_app;
revoke all on function public.record_official_offer_edition_v1(jsonb, jsonb) from public;
revoke all on function public.record_official_offer_capture_v1(jsonb, text, jsonb) from public;
revoke all on function public.record_official_offer_extraction_v1(bigint, jsonb) from public;
grant execute on function public.record_official_offer_edition_v1(jsonb, jsonb) to handleplan_app;
grant execute on function public.record_official_offer_capture_v1(jsonb, text, jsonb) to handleplan_app;
grant execute on function public.record_official_offer_extraction_v1(bigint, jsonb) to handleplan_app;
