-- Register Open Prices as a secondary ordinary-price source for Norwegian gap-filling.
--
-- The worker runs Open Prices benchmark-price-refresh behind the OPEN_PRICES_ENABLED
-- feature flag. This migration seeds the data_sources row (fail-closed by default)
-- and appends the reviewed approved permission with { ordinaryPrice: true }.

lock table public.data_sources in access exclusive mode;
lock table public.source_permissions in access exclusive mode;

do $open_prices_source$
declare
  v_reviewed_at timestamptz := pg_catalog.clock_timestamp();
begin
  -- Insert the source row if it does not exist; always fail-closed
  insert into public.data_sources (
    id,
    display_name,
    source_kind,
    runtime_state,
    public_reference_url,
    permission_reviewed_at,
    permission_expires_at,
    kill_switch_reason,
    created_at,
    updated_at,
    public_state_changed_at
  ) values (
    'open-prices',
    'Open Prices (crowdsourced)',
    'ordinary_price',
    'approved',
    'https://prices.openfoodfacts.org',
    v_reviewed_at,
    null,
    null,
    v_reviewed_at,
    v_reviewed_at,
    v_reviewed_at
  ) on conflict (id) do nothing;

  -- Append the reviewed approved permission
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
end;
$open_prices_source$;
