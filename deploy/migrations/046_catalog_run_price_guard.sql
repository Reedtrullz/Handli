-- The store-scoped catalog+price walk persists price evidence from a
-- 'catalog' ingestion run. Migration 012's running-run guard only allowed
-- price rows from price-typed runs, so every walk run failed price
-- persistence and finalized degraded, hiding its catalog rows from discovery.
create or replace function enforce_running_ingestion_evidence_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  run_source_id varchar(64);
  run_status varchar(16);
  run_type varchar(32);
begin
  select source_id, status, ingestion_runs.run_type
  into run_source_id, run_status, run_type
  from ingestion_runs
  where id = new.ingestion_run_id
  for update;

  if run_status is distinct from 'running' then
    raise exception '% requires a running ingestion run', tg_table_name
      using errcode = '55000';
  end if;

  if tg_table_name = 'catalog_observations'
     and run_type is distinct from 'catalog' then
    raise exception 'catalog_observations requires a catalog ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_observations'
     and run_type not in (
       'benchmark-prices',
       'historical-prices',
       'interactive_price_mirror',
       'catalog'
     ) then
    raise exception 'price_observations requires a price ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_observations'
     and (to_jsonb(new) ->> 'source_id') is distinct from run_source_id then
    raise exception 'price_observations source must match its ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_observations'
     and (
       (
         run_type = 'historical-prices'
         and (to_jsonb(new) ->> 'claim_eligibility') is distinct from 'historical_eligible'
       ) or (
         run_type <> 'historical-prices'
         and (to_jsonb(new) ->> 'claim_eligibility') is distinct from 'ordinary_only'
       )
     ) then
    raise exception 'price_observations eligibility must match its ingestion run'
      using errcode = '23514';
  end if;

  if tg_table_name = 'price_coverage_checks'
     and run_type not in ('benchmark-prices', 'interactive_price_mirror', 'catalog') then
    raise exception 'price_coverage_checks requires an ordinary-price ingestion run'
      using errcode = '23514';
  end if;

  return new;
end;
$$;
