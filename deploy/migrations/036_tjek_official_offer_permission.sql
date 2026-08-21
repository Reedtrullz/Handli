-- Migration 036: Grant Tjek official-offer capabilities required by publication and trust-fence triggers.
--
-- source_permissions is append-only (reject_append_only_mutation). We INSERT a new
-- permission row superseding id=3. The assert_current_official_offer_permission()
-- function picks the latest row by created_at DESC for the source.

INSERT INTO source_permissions (source_id, decision, reviewed_at, public_reference_url, permissions, notes)
SELECT
  source_id,
  decision,
  clock_timestamp(),
  public_reference_url,
  permissions || '{
    "officialOffers": true,
    "officialOfferCapabilities": ["capture", "discover", "extract"],
    "officialOfferRightsClassifications": ["public_display"]
  }'::jsonb,
  'Supersedes id=3: adds official-offer capabilities for Tjek weekly catalog pipeline.'
FROM source_permissions
WHERE id = 3 AND source_id = 'tjek';
