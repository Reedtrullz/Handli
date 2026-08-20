-- Register Open Prices as a secondary ordinary-price source for Norwegian gap-filling.
--
-- The worker runs Open Prices benchmark-price-refresh behind the OPEN_PRICES_ENABLED
-- feature flag. This migration seeds the data_sources row (fail-closed by default)
-- and appends the reviewed approved permission with { ordinaryPrice: true }.
-- Idempotent: safe to run multiple times.

lock table public.data_sources in access exclusive mode;
lock table public.source_permissions in access exclusive mode;

do $open_prices_source$
declare
  v_reviewed_at timestamptz := transaction_timestamp();
  v_existing_decision text;
begin
  -- Insert the source row if it does not exist; always fail-closed.
  -- Let defaults and the public_state_clock trigger handle timestamps.
  insert into public.data_sources (
    id,
    display_name,
    source_kind,
    runtime_state,
    public_reference_url,
    permission_reviewed_at,
    permission_expires_at,
    kill_switch_reason
  ) values (
    'open-prices',
    'Open Prices (crowdsourced)',
    'ordinary_price',
    'approved',
    'https://prices.openfoodfacts.org',
    v_reviewed_at,
    null,
    null
  ) on conflict (id) do nothing;

  -- Update the source row to set permission timestamps and approved state.
  update public.data_sources
     set runtime_state = 'approved',
         permission_reviewed_at = v_reviewed_at,
         permission_expires_at = null,
         kill_switch_reason = null,
         public_reference_url = 'https://prices.openfoodfacts.org'
   where id = 'open-prices';

  -- Append the reviewed approved permission only if not already present.
  select decision into v_existing_decision
    from public.source_permissions
   where source_id = 'open-prices'
     and decision = 'approved'
   order by created_at desc, id desc
   limit 1;

  if v_existing_decision is null then
    insert into public.source_permissions (
      source_id,
      decision,
      reviewed_at,
      valid_until,
      public_reference_url,
      permissions,
      notes
    ) values (
      'open-prices',
      'approved',
      v_reviewed_at,
      null,
      'https://prices.openfoodfacts.org/api/docs',
      '{"ordinaryPrice": true}'::jsonb,
      'Reviewed owner approval for Open Prices as a gap-filling ordinary-price source for Norwegian chains (Bunnpris, Extra, REMA 1000). ODbL attribution required.'
    );
  end if;
end;
$open_prices_source$;

