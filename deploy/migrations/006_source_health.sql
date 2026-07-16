create table if not exists source_health_snapshots (
  id bigserial primary key,
  source_id varchar(64) not null references data_sources(id),
  geographic_scope_id bigint references geographic_scopes(id),
  status varchar(16) not null,
  last_discovery_success_at timestamptz,
  last_capture_success_at timestamptz,
  last_publish_success_at timestamptz,
  newest_eligible_evidence_at timestamptz,
  review_queue_count integer not null default 0,
  oldest_review_age_seconds integer,
  details jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null,
  constraint source_health_snapshots_status check (
    status in ('healthy', 'degraded', 'failed', 'disabled')
  ),
  constraint source_health_snapshots_queue_nonnegative check (review_queue_count >= 0),
  constraint source_health_snapshots_review_age_nonnegative check (
    oldest_review_age_seconds is null or oldest_review_age_seconds >= 0
  )
);

create index if not exists source_health_snapshots_source_time_idx
  on source_health_snapshots (source_id, recorded_at desc);

create table if not exists worker_leases (
  lease_key varchar(120) primary key,
  owner_id varchar(160) not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  constraint worker_leases_valid_range check (expires_at > acquired_at),
  constraint worker_leases_heartbeat_range check (
    heartbeat_at >= acquired_at and heartbeat_at <= expires_at
  )
);

create table if not exists alert_events (
  id bigserial primary key,
  alert_key varchar(160) not null,
  severity varchar(16) not null,
  status varchar(16) not null,
  source_id varchar(64) references data_sources(id),
  opened_at timestamptz not null,
  closed_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  constraint alert_events_severity check (
    severity in ('info', 'warning', 'critical')
  ),
  constraint alert_events_status check (
    status in ('open', 'acknowledged', 'closed')
  ),
  constraint alert_events_time_range check (
    closed_at is null or closed_at >= opened_at
  )
);

create index if not exists alert_events_key_time_idx
  on alert_events (alert_key, opened_at desc);

create table if not exists historical_price_statistics (
  product_id bigint not null references canonical_products(id),
  chain varchar(32) not null,
  geographic_scope_id bigint references geographic_scopes(id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  median_amount_ore integer not null,
  observation_count integer not null,
  distinct_observation_days integer not null,
  computed_at timestamptz not null,
  constraint historical_price_statistics_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint historical_price_statistics_window_range check (window_end > window_start),
  constraint historical_price_statistics_amount_nonnegative check (median_amount_ore >= 0),
  constraint historical_price_statistics_counts check (
    observation_count >= distinct_observation_days
    and distinct_observation_days >= 7
  )
);

create unique index if not exists historical_price_statistics_identity_uidx
  on historical_price_statistics (
    product_id,
    chain,
    geographic_scope_id,
    window_start,
    window_end
  ) nulls not distinct;
