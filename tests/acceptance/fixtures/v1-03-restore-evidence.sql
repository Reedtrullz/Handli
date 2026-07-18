-- The guarded evidence inserts below must see their parent run through an
-- ordinary SELECT ... FOR UPDATE in a trigger. Keep run creation in its own
-- command (but the same outer fixture transaction): data-modifying sibling
-- CTEs share one snapshot and are not visible to that trigger lookup.
insert into ingestion_runs (
  job_id,
  source_id,
  run_type,
  status,
  started_at,
  completed_at,
  counts
) values (
  'ci-proof-catalog-run-v1-03',
  'kassalapp',
  'catalog',
  'running',
  '2026-07-16T08:09:45Z',
  null,
  '{}'::jsonb
);

-- Official-offer trust-fence proof uses an invented source, never Kassalapp.
-- Keep each parent insert in its own statement because the 020 INSERT guards
-- perform ordinary parent-table lookups that cannot see sibling data-changing
-- CTE writes from the same PostgreSQL snapshot.
insert into data_sources (
  id,
  display_name,
  source_kind,
  runtime_state,
  permission_reviewed_at,
  permission_expires_at,
  kill_switch_reason
) values (
  'ci-proof-offer-source-v1-03',
  'Synthetic CI official-offer restore proof',
  'offer',
  'approved',
  '2026-07-16T08:00:00Z',
  '2036-08-16T08:00:00Z',
  'Synthetic fixture only; public activation remains disabled'
);

insert into source_permissions (
  source_id,
  decision,
  reviewed_at,
  valid_until,
  permissions,
  notes
) values (
  'ci-proof-offer-source-v1-03',
  'approved',
  '2026-07-16T08:00:00Z',
  '2036-08-16T08:00:00Z',
  '{
    "officialOffers": true,
    "publicDisplay": false,
    "officialOfferCapabilities": ["capture", "discover", "extract"],
    "officialOfferRightsClassifications": ["extract_only", "private_review"]
  }'::jsonb,
  'Rights-cleared invented fixture; not a production-source authorization'
);

insert into geographic_scopes (
  scope_key,
  scope_kind,
  label,
  country_code,
  status
) values (
  'ci-proof:no-0301-oslo',
  'region',
  'CI proof Oslo',
  'NO',
  'active'
);

insert into geographic_scope_regions (scope_id, region_code)
select id, 'no-0301-oslo'
from geographic_scopes
where scope_key = 'ci-proof:no-0301-oslo';

insert into publications (
  source_id,
  external_id,
  chain,
  title,
  valid_from,
  valid_until,
  geographic_scope_id,
  status,
  discovered_at,
  content_kind,
  declared_geographic_scope,
  edition_identity_sha256,
  discovery_permission_id
)
select
  'ci-proof-offer-source-v1-03',
  'ci-proof-publication-v1-03',
  'extra',
  'Private CI restore proof publication',
  '2026-07-16T00:00:00Z',
  '2026-07-23T00:00:00Z',
  scope.id,
  'captured',
  '2026-07-16T08:05:00Z',
  'structured-feed',
  '{"kind":"regions","countryCode":"NO","regionCodes":["no-0301-oslo"]}'::jsonb,
  encode(sha256(convert_to(canonical_official_offer_edition_identity(
    'ci-proof-offer-source-v1-03',
    'ci-proof-publication-v1-03',
    'extra',
    'Private CI restore proof publication',
    'structured-feed',
    scope.id,
    '{"kind":"regions","countryCode":"NO","regionCodes":["no-0301-oslo"]}'::jsonb,
    '2026-07-16T00:00:00Z'::timestamptz,
    '2026-07-23T00:00:00Z'::timestamptz,
    '2026-07-16T08:05:00Z'::timestamptz
  ), 'UTF8')), 'hex'),
  permission.id
from geographic_scopes scope
cross join lateral (
  select id
  from source_permissions
  where source_id = 'ci-proof-offer-source-v1-03'
  order by created_at desc, id desc
  limit 1
) permission
where scope.scope_key = 'ci-proof:no-0301-oslo';

insert into publication_captures (
  publication_id,
  blob_key,
  checksum,
  mime_type,
  byte_length,
  rights_classification,
  retrieved_at,
  capture_permission_id,
  capture_permission_capabilities
)
select
  publication.id,
  'ci-proof/private/v1-03/publication.pdf',
  repeat('a', 64),
  'application/pdf',
  321,
  'private_review',
  '2000-01-01T00:00:00Z',
  permission.id,
  '["capture", "discover", "extract"]'::jsonb
from publications publication
cross join lateral (
  select id
  from source_permissions
  where source_id = 'ci-proof-offer-source-v1-03'
  order by created_at desc, id desc
  limit 1
) permission
where publication.source_id = 'ci-proof-offer-source-v1-03'
  and publication.external_id = 'ci-proof-publication-v1-03';

insert into extraction_runs (
  capture_id,
  extractor_version,
  status,
  started_at,
  completed_at,
  counts,
  extraction_method,
  extraction_permission_id,
  permission_capabilities,
  source_started_at,
  source_completed_at,
  empty_result,
  empty_confirmation,
  empty_confirmation_observed_at
)
select
  capture.id,
  'ci-proof-v1',
  'completed',
  timing.observed_at,
  timing.observed_at,
  '{"candidates": 1}'::jsonb,
  'structured',
  permission.id,
  '["capture", "discover", "extract"]'::jsonb,
  timing.observed_at,
  timing.observed_at,
  'not-empty',
  null,
  null
from publication_captures capture
inner join publications publication on publication.id = capture.publication_id
cross join lateral (
  select id
  from source_permissions
  where source_id = 'ci-proof-offer-source-v1-03'
  order by created_at desc, id desc
  limit 1
) permission
cross join lateral (select clock_timestamp() as observed_at) timing
where publication.source_id = 'ci-proof-offer-source-v1-03'
  and publication.external_id = 'ci-proof-publication-v1-03';

insert into extracted_offer_candidates (
  extraction_run_id,
  candidate_key,
  normalized_fields,
  confidence,
  status,
  anomaly_codes
)
select
  extraction.id,
  'ci-proof-candidate-v1-03',
  '{"title": "CI proof only"}'::jsonb,
  100,
  'rejected',
  '["fixture_only"]'::jsonb
from extraction_runs extraction
inner join publication_captures capture on capture.id = extraction.capture_id
inner join publications publication on publication.id = capture.publication_id
where publication.source_id = 'ci-proof-offer-source-v1-03'
  and extraction.extractor_version = 'ci-proof-v1';

insert into review_actions (
  candidate_id,
  actor_id,
  action,
  expected_version,
  previous_values,
  new_values,
  reason,
  acted_at
)
select
  candidate.id,
  'ci-v1-03-proof',
  'reject',
  0,
  '{"status": "pending"}'::jsonb,
  '{"status": "rejected"}'::jsonb,
  'Deterministic audit fixture for backup and restore proof',
  '2026-07-16T08:09:00Z'
from extracted_offer_candidates candidate
inner join extraction_runs extraction on extraction.id = candidate.extraction_run_id
where extraction.extractor_version = 'ci-proof-v1'
  and candidate.candidate_key = 'ci-proof-candidate-v1-03';

with permission_fixture as (
  insert into source_permissions (
    source_id,
    decision,
    reviewed_at,
    valid_until,
    public_reference_url,
    permissions,
    notes
  ) values (
    'kassalapp',
    'conditional',
    '2026-07-16T08:00:00Z',
    '2026-08-16T08:00:00Z',
    'https://kassal.app/api/docs',
    '{"catalog": true, "ordinaryPrice": true, "officialOffers": false}'::jsonb,
    'V1-03 restore proof fixture'
  )
  returning id
),
catalog_product_fixture as (
  insert into canonical_products (
    display_name,
    brand,
    package_amount,
    package_unit,
    units_per_pack,
    status,
    created_at,
    updated_at
  ) values (
    'Mutable catalog projection (not public evidence)',
    'CI projection',
    1,
    'package',
    1,
    'active',
    '2026-07-16T08:09:30Z',
    '2026-07-16T08:09:30Z'
  )
  returning id
),
family_membership_fixture as (
  insert into reviewed_family_membership_decisions (
    version_id,
    family_id,
    product_id,
    decision,
    method,
    confidence,
    reviewer_id,
    reviewed_at
  )
  select
    'handleplan-reviewed-families@1.0.0',
    'family:melk',
    catalog_product_fixture.id,
    'approved',
    'human_review',
    100,
    'ci-private-family-reviewer',
    '2026-07-16T08:10:00Z'
  from catalog_product_fixture
  returning id
),
catalog_run_fixture as (
  select id
  from ingestion_runs
  where job_id = 'ci-proof-catalog-run-v1-03'
),
catalog_outcome_fixture as (
  insert into source_record_outcomes (
    ingestion_run_id,
    record_kind,
    source_record_id,
    outcome_state,
    reason,
    subject_ean,
    outcome_hash,
    recorded_at,
    created_at
  )
  select
    catalog_run_fixture.id,
    'product',
    'ci-proof-catalog-record-v1-03',
    'accepted',
    null,
    '7038010000010',
    repeat('d', 64),
    '2026-07-16T08:10:30Z',
    '2000-01-01T00:00:00Z'
  from catalog_run_fixture
  returning id
),
catalog_observation_fixture as (
  insert into catalog_observations (
    ingestion_run_id,
    source_record_id,
    canonical_product_id,
    gtin,
    display_name,
    brand,
    package_amount,
    package_unit,
    units_per_pack,
    retrieved_at,
    source_updated_at,
    raw_record_hash
  )
  select
    catalog_run_fixture.id,
    'ci-proof-catalog-record-v1-03',
    catalog_product_fixture.id,
    '7038010000010',
    'CI proof catalog observation',
    'CI observed brand',
    1000,
    'g',
    1,
    '2026-07-16T08:10:30Z',
    '2026-07-16T08:00:30Z',
    repeat('e', 64)
  from catalog_run_fixture
  cross join catalog_product_fixture
  returning id
),
worker_result_fixture as (
  insert into worker_job_results (
    job_id,
    source_id,
    job_kind,
    scheduled_at,
    run_id,
    status,
    started_at,
    completed_at,
    counts,
    result_hash
  ) values (
    'ci-proof:kassalapp:catalog-refresh:2026-07-16T08:10:00.000Z',
    'kassalapp',
    'catalog-refresh',
    '2026-07-16T08:10:00Z',
    'ci-proof-worker-run-v1',
    'failed',
    '2026-07-16T08:10:01Z',
    '2026-07-16T08:10:02Z',
    '{"accepted":0,"failed":1,"fetched":0,"persisted":0,"quarantined":0,"unknown":0}'::jsonb,
    repeat('c', 64)
  )
  returning id
)
select
  (select id from permission_fixture) as permission_id,
  (
    select capture.id
    from publication_captures capture
    inner join publications publication on publication.id = capture.publication_id
    where publication.external_id = 'ci-proof-publication-v1-03'
  ) as capture_id,
  (
    select review.id
    from review_actions review
    inner join extracted_offer_candidates candidate on candidate.id = review.candidate_id
    where candidate.candidate_key = 'ci-proof-candidate-v1-03'
  ) as review_id,
  (select id from family_membership_fixture) as family_membership_id,
  (select id from catalog_outcome_fixture) as catalog_outcome_id,
  (select id from catalog_observation_fixture) as catalog_observation_id,
  (select id from worker_result_fixture) as worker_result_id;

update ingestion_runs
set status = 'completed',
    completed_at = '2026-07-16T08:11:00Z',
    counts = '{"accepted":1,"quarantined":0,"unknown":0}'::jsonb
where job_id = 'ci-proof-catalog-run-v1-03';
