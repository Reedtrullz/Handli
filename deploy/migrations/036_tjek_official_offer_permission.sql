-- Migration 036: Grant Tjek official-offer capabilities required by publication and trust-fence triggers.
--
-- source_permissions is append-only (reject_append_only_mutation). We INSERT a new
-- permission row superseding id=3. The assert_current_official_offer_permission()
-- function picks the latest row by created_at DESC for the source.

INSERT INTO source_permissions
  (source_id, decision, reviewed_at, public_reference_url, permissions, notes)
SELECT
  sp.source_id,
  sp.decision,
  clock_timestamp(),
  sp.public_reference_url,
  (
    jsonb_build_object(
      'officialOffers', true,
      'officialOfferCapabilities', jsonb_build_array('capture', 'discover', 'extract'),
      'officialOfferRightsClassifications', jsonb_build_array('public_display')
    )
  ),
  'Supersedes id=3: adds official-offer capabilities for Tjek weekly catalog pipeline.'
FROM source_permissions sp
WHERE sp.id = 3 AND sp.source_id = 'tjek';
