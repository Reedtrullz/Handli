create table if not exists geographic_scopes (
  id bigserial primary key,
  scope_key varchar(160) not null unique,
  scope_kind varchar(24) not null,
  label varchar(200) not null,
  country_code char(2) not null default 'NO',
  status varchar(16) not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint geographic_scopes_kind check (
    scope_kind in ('national', 'region', 'postal_set', 'store_set')
  ),
  constraint geographic_scopes_country_shape check (country_code ~ '^[A-Z]{2}$'),
  constraint geographic_scopes_status check (status in ('active', 'retired'))
);

create table if not exists physical_stores (
  id bigserial primary key,
  source_id varchar(64) not null references data_sources(id),
  external_id varchar(128) not null,
  chain varchar(32) not null,
  name varchar(240) not null,
  address_line varchar(240),
  postal_code varchar(8),
  municipality_code varchar(8),
  latitude numeric(9, 6) not null,
  longitude numeric(9, 6) not null,
  status varchar(16) not null default 'active',
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint physical_stores_source_external_unique unique (source_id, external_id),
  constraint physical_stores_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint physical_stores_latitude_range check (latitude between -90 and 90),
  constraint physical_stores_longitude_range check (longitude between -180 and 180),
  constraint physical_stores_status check (status in ('active', 'closed', 'unknown'))
);

create table if not exists geographic_scope_regions (
  scope_id bigint not null references geographic_scopes(id),
  region_code varchar(32) not null,
  primary key (scope_id, region_code)
);

create table if not exists geographic_scope_postal_codes (
  scope_id bigint not null references geographic_scopes(id),
  postal_code char(4) not null,
  primary key (scope_id, postal_code),
  constraint geographic_scope_postal_codes_shape check (postal_code ~ '^[0-9]{4}$')
);

create table if not exists geographic_scope_stores (
  scope_id bigint not null references geographic_scopes(id),
  store_id bigint not null references physical_stores(id),
  primary key (scope_id, store_id)
);

alter table price_observations
  add constraint price_observations_geographic_scope_fk
  foreign key (geographic_scope_id) references geographic_scopes(id);

alter table price_coverage_checks
  add constraint price_coverage_checks_geographic_scope_fk
  foreign key (geographic_scope_id) references geographic_scopes(id);

create table if not exists publications (
  id bigserial primary key,
  source_id varchar(64) not null references data_sources(id),
  external_id varchar(160) not null,
  chain varchar(32) not null,
  title varchar(240) not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  geographic_scope_id bigint not null references geographic_scopes(id),
  status varchar(16) not null default 'discovered',
  discovered_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publications_source_external_unique unique (source_id, external_id),
  constraint publications_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint publications_valid_range check (valid_until > valid_from),
  constraint publications_status check (
    status in ('discovered', 'captured', 'published', 'expired', 'failed')
  )
);

create table if not exists publication_captures (
  id bigserial primary key,
  publication_id bigint not null references publications(id),
  blob_key text not null,
  checksum char(64) not null,
  mime_type varchar(120) not null,
  byte_length integer not null,
  rights_classification varchar(24) not null default 'private_review',
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint publication_captures_checksum_unique unique (publication_id, checksum),
  constraint publication_captures_checksum_shape check (checksum ~ '^[0-9a-f]{64}$'),
  constraint publication_captures_byte_length_positive check (byte_length > 0),
  constraint publication_captures_rights_classification check (
    rights_classification in ('private_review', 'extract_only', 'public_display')
  )
);

create table if not exists extraction_runs (
  id bigserial primary key,
  capture_id bigint not null references publication_captures(id),
  extractor_version varchar(80) not null,
  status varchar(16) not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  error_class varchar(80),
  created_at timestamptz not null default now(),
  constraint extraction_runs_capture_version_unique unique (capture_id, extractor_version),
  constraint extraction_runs_status check (
    status in ('running', 'completed', 'degraded', 'failed')
  ),
  constraint extraction_runs_time_range check (
    completed_at is null or completed_at >= started_at
  )
);

create table if not exists extracted_offer_candidates (
  id bigserial primary key,
  extraction_run_id bigint not null references extraction_runs(id),
  candidate_key varchar(160) not null,
  normalized_fields jsonb not null,
  confidence smallint not null,
  status varchar(16) not null default 'pending',
  anomaly_codes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint extracted_offer_candidates_run_key_unique unique (
    extraction_run_id,
    candidate_key
  ),
  constraint extracted_offer_candidates_confidence_range check (
    confidence between 0 and 100
  ),
  constraint extracted_offer_candidates_status check (
    status in ('pending', 'approved', 'rejected', 'superseded')
  )
);
