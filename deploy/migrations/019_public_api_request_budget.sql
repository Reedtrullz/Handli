-- Application-global admission control for expensive public API operations.
--
-- The rows are deliberately ephemeral and contain only an allowlisted route
-- class plus a server-owned timestamp. Shopper identity, request content and
-- request-derived hashes have no column in which they could be persisted.
create table public_api_request_budget_events (
  route_key varchar(32) not null,
  claimed_at timestamptz not null default clock_timestamp(),
  constraint public_api_request_budget_events_route_key_allowed check (
    route_key in (
      'discovery-impact',
      'discovery-search',
      'locations-current',
      'locations-search',
      'plan-candidates',
      'plans',
      'plans-travel',
      'products-search',
      'source-status'
    )
  )
);

create index public_api_request_budget_events_route_time_idx
  on public_api_request_budget_events (route_key, claimed_at);

-- Keep all table access behind the fixed-policy function. The migration
-- runner grants EXECUTE only to the web role after every migration has run.
revoke all on table public_api_request_budget_events from public;

create function claim_public_api_request_budget(p_route_key text)
returns table (admitted boolean, retry_after_seconds integer)
language plpgsql
volatile
security definer
parallel unsafe
set search_path = pg_catalog, pg_temp
as $$
declare
  v_attempt_count bigint;
  v_limit integer;
  v_oldest_claim timestamptz;
  v_retry_after integer;
  v_window interval;
begin
  -- These policies are intentionally compiled into the database function.
  -- The web role cannot choose a larger limit or a shorter window.
  case p_route_key
    when 'discovery-impact' then v_limit := 120; v_window := interval '1 minute';
    when 'discovery-search' then v_limit := 300; v_window := interval '1 minute';
    when 'locations-current' then v_limit := 120; v_window := interval '1 minute';
    when 'locations-search' then v_limit := 60; v_window := interval '1 minute';
    when 'plan-candidates' then v_limit := 180; v_window := interval '1 minute';
    when 'plans' then v_limit := 120; v_window := interval '1 minute';
    when 'plans-travel' then v_limit := 60; v_window := interval '1 minute';
    when 'products-search' then v_limit := 300; v_window := interval '1 minute';
    when 'source-status' then v_limit := 120; v_window := interval '1 minute';
    else
      raise exception using
        errcode = '22023',
        message = 'unsupported public API route key';
  end case;

  -- Serialize claims for one fixed route class across every application
  -- process. Contention fails closed immediately rather than consuming the
  -- request deadline while waiting for another transaction.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(p_route_key, 7229164303)
  ) then
    return query select false, 1;
    return;
  end if;

  delete from public.public_api_request_budget_events
  where route_key = p_route_key
    and claimed_at <= pg_catalog.clock_timestamp() - v_window;

  select count(*), min(claimed_at)
  into strict v_attempt_count, v_oldest_claim
  from public.public_api_request_budget_events
  where route_key = p_route_key;

  if v_attempt_count < v_limit then
    insert into public.public_api_request_budget_events (route_key)
    values (p_route_key);
    return query select true, 0;
    return;
  end if;

  if v_oldest_claim is null then
    raise exception using
      errcode = 'XX000',
      message = 'public API request budget state is inconsistent';
  end if;

  v_retry_after := least(
    60::numeric,
    greatest(
      1::numeric,
      ceil(
        extract(
          epoch from (v_oldest_claim + v_window - pg_catalog.clock_timestamp())
        )
      )
    )
  )::integer;
  return query select false, v_retry_after;
end;
$$;

revoke all on function claim_public_api_request_budget(text) from public;
