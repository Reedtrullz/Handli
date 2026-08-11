-- Owner-reviewed kassalapp source approval for the v1 public launch.
--
-- Source access stays fail-closed by default: migration 002 seeds kassalapp
-- with runtime_state 'conditional' and no permission record. This reviewed,
-- forward-only migration is the explicit approval that moves the source into
-- the approved state and records the append-only permission decision the
-- worker, readiness readers, and public source-status contract all require.
-- Revocation is a separate reviewed decision; a revoked source is never
-- silently re-approved here.

lock table public.data_sources in access exclusive mode;
lock table public.source_permissions in access exclusive mode;

do $kassalapp_source_approval$
declare
  v_reviewed_at timestamptz := pg_catalog.clock_timestamp();
  v_runtime_state text;
begin
  select runtime_state
    into v_runtime_state
    from public.data_sources
   where id = 'kassalapp';

  if not found then
    raise exception 'kassalapp source row is missing from the source catalog';
  end if;

  if v_runtime_state = 'revoked' then
    raise exception 'kassalapp source is revoked; a reviewed revocation cannot be silently re-approved';
  end if;

  insert into public.source_permissions (
    source_id,
    decision,
    reviewed_at,
    valid_until,
    public_reference_url,
    permissions,
    notes
  ) values (
    'kassalapp',
    'approved',
    v_reviewed_at,
    null,
    'https://kassal.app/api/docs',
    '{"catalog": true, "ordinaryPrice": true, "priceHistory": true, "physicalStore": true}'::jsonb,
    'Reviewed owner approval for the v1 public launch; all four ingestion scopes'
  );

  update public.data_sources
     set runtime_state = 'approved',
         permission_reviewed_at = v_reviewed_at,
         permission_expires_at = null,
         kill_switch_reason = null,
         public_state_changed_at = v_reviewed_at
   where id = 'kassalapp';
end;
$kassalapp_source_approval$;
