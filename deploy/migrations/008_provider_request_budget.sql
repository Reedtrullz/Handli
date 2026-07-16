create table provider_request_budget_events (
  provider_key varchar(64) not null,
  claimed_at timestamptz not null default clock_timestamp(),
  constraint provider_request_budget_events_provider_key_shape
    check (provider_key ~ '^[a-z][a-z0-9_-]{0,63}$')
);

create index provider_request_budget_events_provider_time_idx
  on provider_request_budget_events (provider_key, claimed_at);
