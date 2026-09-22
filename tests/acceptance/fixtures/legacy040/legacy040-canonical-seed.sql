-- Local proof seed only: canonical reference rows needed by the migration
-- runner. The authentic legacy040 capture intentionally contains no data rows.
insert into public.data_sources (
  id, display_name, source_kind, runtime_state, public_reference_url,
  permission_reviewed_at, permission_expires_at, kill_switch_reason,
  created_at, updated_at, public_state_changed_at
) values
  ('legacy-import', 'Legacy price_cache import', 'legacy', 'blocked', null, null, null, 'Legacy rows lack sufficient provenance for official or historical claims', transaction_timestamp(), transaction_timestamp(), transaction_timestamp()),
  ('kassalapp', 'Kassalapp', 'ordinary_price', 'approved', 'https://kassal.app/api/docs', transaction_timestamp(), null, null, transaction_timestamp(), transaction_timestamp(), transaction_timestamp()),
  ('open-prices', 'Open Prices (crowdsourced)', 'ordinary_price', 'approved', 'https://prices.openfoodfacts.org', transaction_timestamp(), null, null, transaction_timestamp(), transaction_timestamp(), transaction_timestamp()),
  ('tjek', 'Tjek / Bunnpris kundeavis', 'offer', 'approved', null, transaction_timestamp(), null, null, transaction_timestamp(), transaction_timestamp(), transaction_timestamp());

insert into public.family_taxonomy_versions (
  version_id, taxonomy_id, taxonomy_version, contract_version, published_at,
  content_sha256, content_json, expected_family_count, expected_alias_count,
  created_at
) values (
  'handleplan-reviewed-families@1.0.0', 'handleplan-reviewed-families', '1.0.0', 1,
  '2026-07-16 00:00:00+00',
  '1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520',
  '[{"id":"family:brod","slug":"brod","status":"active","aliases":["brød"],"labelNo":"Brød"},{"id":"family:kaffe","slug":"kaffe","status":"active","aliases":[],"labelNo":"Kaffe"},{"id":"family:melk","slug":"melk","status":"active","aliases":["mjølk"],"labelNo":"Melk"}]',
  3, 2, transaction_timestamp());

insert into public.geographic_scopes (
  id, scope_key, scope_kind, label, country_code, status,
  created_at, updated_at, public_state_changed_at
) values (1, 'no-national', 'national', 'Norge (nasjonalt)', 'NO', 'active', transaction_timestamp(), transaction_timestamp(), transaction_timestamp());

insert into public.ingestion_runs (
  id, source_id, run_type, status, started_at, completed_at, counts,
  error_class, created_at, job_id, terminalized_at
) values (1, 'legacy-import', 'price_cache_backfill', 'running', transaction_timestamp(), null, '{"rows":0}', null, transaction_timestamp(), null, null);
update public.ingestion_runs
set status = 'completed', completed_at = transaction_timestamp()
where id = 1;

insert into public.official_offer_publication_policy (
  policy_key, enabled, policy_version, updated_at
) values ('official-offer-publication-v1', false, 1, transaction_timestamp());

insert into public.reviewed_family_definitions (
  version_id, family_id, slug, label_no, parent_family_id, status, created_at
) values
  ('handleplan-reviewed-families@1.0.0', 'family:brod', 'brod', 'Brød', null, 'active', transaction_timestamp()),
  ('handleplan-reviewed-families@1.0.0', 'family:kaffe', 'kaffe', 'Kaffe', null, 'active', transaction_timestamp()),
  ('handleplan-reviewed-families@1.0.0', 'family:melk', 'melk', 'Melk', null, 'active', transaction_timestamp());

insert into public.reviewed_family_aliases (version_id, family_id, alias, created_at) values
  ('handleplan-reviewed-families@1.0.0', 'family:brod', 'brød', transaction_timestamp()),
  ('handleplan-reviewed-families@1.0.0', 'family:melk', 'mjølk', transaction_timestamp());

insert into public.source_permissions (
  id, source_id, decision, reviewed_at, valid_until, public_reference_url,
  private_reference_key, permissions, notes, created_at
) values
  (1, 'kassalapp', 'approved', transaction_timestamp(), null, 'https://kassal.app/api/docs', null, '{"catalog":true,"priceHistory":true,"ordinaryPrice":true,"physicalStore":true}', 'Reviewed owner approval for the v1 public launch; all four ingestion scopes', transaction_timestamp()),
  (2, 'open-prices', 'approved', transaction_timestamp(), null, 'https://prices.openfoodfacts.org/api/docs', null, '{"ordinaryPrice":true}', 'Reviewed owner approval for Open Prices as a gap-filling ordinary-price source for Norwegian chains (Bunnpris, Extra, REMA 1000). ODbL attribution required.', transaction_timestamp()),
  (3, 'tjek', 'approved', transaction_timestamp(), null, null, null, '{"catalog":true}', null, transaction_timestamp()),
  (4, 'tjek', 'approved', clock_timestamp(), null, null, null, '{"officialOffers":true,"officialOfferCapabilities":["capture","discover","extract"],"officialOfferRightsClassifications":["public_display"]}', 'Supersedes id=3: adds official-offer capabilities for Tjek weekly catalog pipeline.', transaction_timestamp());

select setval(
  'public.geographic_scopes_id_seq',
  (select max(id) from public.geographic_scopes),
  true
);
