create table if not exists price_cache (
  ean varchar(14) not null,
  chain varchar(32) not null,
  amount_ore integer not null,
  observed_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  constraint price_cache_pkey primary key (ean, chain),
  constraint price_cache_ean_shape check (ean ~ '^([0-9]{8}|[0-9]{13})$'),
  constraint price_cache_chain_supported check (chain in ('bunnpris', 'rema-1000', 'extra')),
  constraint price_cache_amount_ore_nonnegative check (amount_ore >= 0)
);
