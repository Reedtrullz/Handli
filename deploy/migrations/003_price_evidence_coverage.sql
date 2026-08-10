create table if not exists ingestion_runs (
  id bigserial primary key,
  source_id varchar(64) not null references data_sources(id),
  run_type varchar(32) not null,
  status varchar(16) not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  error_class varchar(80),
  created_at timestamptz not null default now(),
  constraint ingestion_runs_status check (
    status in ('running', 'completed', 'degraded', 'failed', 'cancelled')
  ),
  constraint ingestion_runs_time_range check (
    completed_at is null or completed_at >= started_at
  )
);

create table if not exists price_observations (
  id bigserial primary key,
  evidence_key varchar(255) not null unique,
  product_id bigint not null references canonical_products(id),
  chain varchar(32) not null,
  amount_ore integer not null,
  observed_at timestamptz not null,
  fetched_at timestamptz not null,
  source_id varchar(64) not null references data_sources(id),
  source_reference text,
  ingestion_run_id bigint not null references ingestion_runs(id),
  geographic_scope_id bigint,
  evidence_level varchar(16) not null,
  confidence smallint not null,
  claim_eligibility varchar(24) not null default 'ordinary_only',
  raw_record_hash char(64),
  created_at timestamptz not null default now(),
  constraint price_observations_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint price_observations_amount_ore_nonnegative check (amount_ore >= 0),
  constraint price_observations_time_range check (fetched_at >= observed_at),
  constraint price_observations_evidence_level check (
    evidence_level in ('chain', 'branch')
  ),
  constraint price_observations_confidence_range check (
    confidence between 0 and 100
  ),
  constraint price_observations_claim_eligibility check (
    claim_eligibility in ('ordinary_only', 'historical_eligible')
  ),
  constraint price_observations_hash_shape check (
    raw_record_hash is null or raw_record_hash ~ '^[0-9a-f]{64}$'
  )
);

create index if not exists price_observations_product_chain_time_idx
  on price_observations (product_id, chain, observed_at desc);
create index if not exists price_observations_source_run_idx
  on price_observations (source_id, ingestion_run_id);

create table if not exists price_coverage_checks (
  id bigserial primary key,
  ingestion_run_id bigint not null references ingestion_runs(id),
  product_id bigint not null references canonical_products(id),
  chain varchar(32) not null,
  geographic_scope_id bigint,
  state varchar(24) not null,
  reason varchar(160) not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint price_coverage_checks_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint price_coverage_checks_state check (
    state in ('priced', 'known_not_carried', 'stale', 'ineligible', 'unknown')
  )
);

create unique index if not exists price_coverage_checks_run_product_chain_scope_uidx
  on price_coverage_checks (
    ingestion_run_id,
    product_id,
    chain,
    geographic_scope_id
  ) nulls not distinct;

create or replace view latest_price_evidence as
select distinct on (
  price_observations.product_id,
  price_observations.chain,
  price_observations.geographic_scope_id
)
  price_observations.*
from price_observations
order by
  price_observations.product_id,
  price_observations.chain,
  price_observations.geographic_scope_id,
  price_observations.observed_at desc,
  price_observations.fetched_at desc,
  price_observations.id desc;

with legacy_run as (
  insert into ingestion_runs (
    source_id,
    run_type,
    status,
    started_at,
    completed_at,
    counts
  )
  values (
    'legacy-import',
    'price_cache_backfill',
    'completed',
    now(),
    now(),
    jsonb_build_object('rows', (select count(*) from price_cache))
  )
  returning id
)
insert into price_observations (
  evidence_key,
  product_id,
  chain,
  amount_ore,
  observed_at,
  fetched_at,
  source_id,
  source_reference,
  ingestion_run_id,
  evidence_level,
  confidence,
  claim_eligibility
)
select
  'legacy-import:' || price_cache.ean || ':' || price_cache.chain || ':'
    || extract(epoch from price_cache.observed_at)::text || ':' || price_cache.amount_ore::text,
  product_identifiers.product_id,
  price_cache.chain,
  price_cache.amount_ore,
  price_cache.observed_at,
  greatest(price_cache.fetched_at, price_cache.observed_at),
  'legacy-import',
  null,
  legacy_run.id,
  'chain',
  50,
  'ordinary_only'
from price_cache
join product_identifiers
  on product_identifiers.value = price_cache.ean
 and product_identifiers.scheme in ('ean8', 'ean13')
cross join legacy_run
on conflict (evidence_key) do nothing;

insert into price_coverage_checks (
  ingestion_run_id,
  product_id,
  chain,
  state,
  reason,
  checked_at
)
select
  price_observations.ingestion_run_id,
  price_observations.product_id,
  price_observations.chain,
  'ineligible',
  'legacy_price_cache_missing_provenance',
  price_observations.fetched_at
from price_observations
where price_observations.source_id = 'legacy-import'
on conflict do nothing;
