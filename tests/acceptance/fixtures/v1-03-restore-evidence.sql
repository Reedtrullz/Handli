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
scope_fixture as (
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
  )
  returning id
),
publication_fixture as (
  insert into publications (
    source_id,
    external_id,
    chain,
    title,
    valid_from,
    valid_until,
    geographic_scope_id,
    status,
    discovered_at
  )
  select
    'kassalapp',
    'ci-proof-publication-v1-03',
    'extra',
    'Private CI restore proof publication',
    '2026-07-16T00:00:00Z',
    '2026-07-23T00:00:00Z',
    scope_fixture.id,
    'captured',
    '2026-07-16T08:05:00Z'
  from scope_fixture
  returning id
),
capture_fixture as (
  insert into publication_captures (
    publication_id,
    blob_key,
    checksum,
    mime_type,
    byte_length,
    rights_classification,
    retrieved_at
  )
  select
    publication_fixture.id,
    'ci-proof/private/v1-03/publication.pdf',
    repeat('a', 64),
    'application/pdf',
    321,
    'private_review',
    '2026-07-16T08:06:00Z'
  from publication_fixture
  returning id
),
extraction_fixture as (
  insert into extraction_runs (
    capture_id,
    extractor_version,
    status,
    started_at,
    completed_at,
    counts
  )
  select
    capture_fixture.id,
    'ci-proof-v1',
    'completed',
    '2026-07-16T08:07:00Z',
    '2026-07-16T08:08:00Z',
    '{"candidates": 1}'::jsonb
  from capture_fixture
  returning id
),
candidate_fixture as (
  insert into extracted_offer_candidates (
    extraction_run_id,
    candidate_key,
    normalized_fields,
    confidence,
    status,
    anomaly_codes
  )
  select
    extraction_fixture.id,
    'ci-proof-candidate-v1-03',
    '{"title": "CI proof only"}'::jsonb,
    100,
    'rejected',
    '["fixture_only"]'::jsonb
  from extraction_fixture
  returning id
),
review_fixture as (
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
    candidate_fixture.id,
    'ci-v1-03-proof',
    'reject',
    0,
    '{"status": "pending"}'::jsonb,
    '{"status": "rejected"}'::jsonb,
    'Deterministic audit fixture for backup and restore proof',
    '2026-07-16T08:09:00Z'
  from candidate_fixture
  returning id
)
select
  (select id from permission_fixture) as permission_id,
  (select id from capture_fixture) as capture_id,
  (select id from review_fixture) as review_id;
