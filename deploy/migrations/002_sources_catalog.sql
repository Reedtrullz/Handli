create table if not exists data_sources (
  id varchar(64) primary key,
  display_name varchar(160) not null,
  source_kind varchar(32) not null,
  runtime_state varchar(16) not null default 'blocked',
  public_reference_url text,
  permission_reviewed_at timestamptz,
  permission_expires_at timestamptz,
  kill_switch_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_sources_kind check (
    source_kind in ('catalog', 'ordinary_price', 'offer', 'store', 'geocoder', 'routing', 'legacy')
  ),
  constraint data_sources_runtime_state check (
    runtime_state in ('approved', 'conditional', 'blocked', 'revoked')
  ),
  constraint data_sources_permission_range check (
    permission_expires_at is null
    or permission_reviewed_at is null
    or permission_expires_at > permission_reviewed_at
  )
);

create table if not exists source_permissions (
  id bigserial primary key,
  source_id varchar(64) not null references data_sources(id),
  decision varchar(16) not null,
  reviewed_at timestamptz not null,
  valid_until timestamptz,
  public_reference_url text,
  private_reference_key text,
  permissions jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  constraint source_permissions_decision check (
    decision in ('approved', 'conditional', 'blocked', 'revoked')
  ),
  constraint source_permissions_valid_range check (
    valid_until is null or valid_until > reviewed_at
  )
);

create table if not exists canonical_products (
  id bigserial primary key,
  display_name varchar(240) not null,
  brand varchar(160),
  package_amount integer not null,
  package_unit varchar(16) not null,
  units_per_pack integer not null default 1,
  status varchar(16) not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint canonical_products_package_amount_positive check (package_amount > 0),
  constraint canonical_products_package_unit check (
    package_unit in ('g', 'ml', 'piece', 'package')
  ),
  constraint canonical_products_units_per_pack_positive check (units_per_pack > 0),
  constraint canonical_products_status check (
    status in ('active', 'quarantined', 'retired')
  )
);

create table if not exists product_identifiers (
  id bigserial primary key,
  product_id bigint not null references canonical_products(id),
  scheme varchar(16) not null,
  value varchar(128) not null,
  source_id varchar(64) references data_sources(id),
  confidence smallint not null default 100,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint product_identifiers_scheme check (
    scheme in ('ean8', 'ean13', 'source')
  ),
  constraint product_identifiers_confidence_range check (
    confidence between 0 and 100
  ),
  constraint product_identifiers_ean_shape check (
    (scheme = 'ean8' and value ~ '^[0-9]{8}$')
    or (scheme = 'ean13' and value ~ '^[0-9]{13}$')
    or (scheme = 'source' and length(value) between 1 and 128)
  ),
  constraint product_identifiers_source_scope check (
    (scheme in ('ean8', 'ean13') and source_id is null)
    or (scheme = 'source' and source_id is not null)
  )
);

create unique index if not exists product_identifiers_gtin_value_unique
  on product_identifiers (value)
  where scheme in ('ean8', 'ean13');
create unique index if not exists product_identifiers_source_value_unique
  on product_identifiers (source_id, value)
  where scheme = 'source';

create table if not exists source_products (
  source_id varchar(64) not null references data_sources(id),
  external_id varchar(128) not null,
  canonical_product_id bigint references canonical_products(id),
  normalized_fields jsonb not null,
  raw_record_hash char(64) not null,
  match_state varchar(16) not null default 'unmatched',
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (source_id, external_id),
  constraint source_products_hash_shape check (raw_record_hash ~ '^[0-9a-f]{64}$'),
  constraint source_products_match_state check (
    match_state in ('unmatched', 'candidate', 'matched', 'quarantined')
  ),
  constraint source_products_seen_range check (last_seen_at >= first_seen_at)
);

create table if not exists product_families (
  slug varchar(80) primary key,
  label_no varchar(160) not null,
  status varchar(16) not null default 'active',
  created_at timestamptz not null default now(),
  constraint product_families_status check (status in ('active', 'retired'))
);

create table if not exists product_family_memberships (
  product_id bigint not null references canonical_products(id),
  family_slug varchar(80) not null references product_families(slug),
  confidence smallint not null,
  method varchar(24) not null,
  review_state varchar(16) not null,
  rule_version varchar(64),
  reviewed_at timestamptz,
  primary key (product_id, family_slug),
  constraint product_family_memberships_confidence_range check (
    confidence between 0 and 100
  ),
  constraint product_family_memberships_method check (
    method in ('exact_identifier', 'deterministic_rule', 'human_review')
  ),
  constraint product_family_memberships_review_state check (
    review_state in ('approved', 'candidate', 'rejected')
  )
);

insert into data_sources (
  id,
  display_name,
  source_kind,
  runtime_state,
  public_reference_url,
  kill_switch_reason
) values
  (
    'legacy-import',
    'Legacy price_cache import',
    'legacy',
    'blocked',
    null,
    'Legacy rows lack sufficient provenance for official or historical claims'
  ),
  (
    'kassalapp',
    'Kassalapp',
    'ordinary_price',
    'conditional',
    'https://kassal.app/api/docs',
    'Existing protected-preview use only until the source registry records public reuse rights'
  )
on conflict (id) do nothing;

insert into canonical_products (
  display_name,
  package_amount,
  package_unit,
  units_per_pack,
  status
)
select
  'Legacy import ' || price_cache.ean,
  1,
  'package',
  1,
  'quarantined'
from (select distinct ean from price_cache) as price_cache
order by price_cache.ean;

insert into product_identifiers (
  product_id,
  scheme,
  value,
  source_id,
  confidence
)
select
  canonical_products.id,
  case when length(price_cache.ean) = 8 then 'ean8' else 'ean13' end,
  price_cache.ean,
  null,
  100
from (select distinct ean from price_cache) as price_cache
join canonical_products
  on canonical_products.display_name = 'Legacy import ' || price_cache.ean
 and canonical_products.status = 'quarantined'
on conflict (value) where scheme in ('ean8', 'ean13') do nothing;
