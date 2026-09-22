-- Migration 043: Add MENY as an official-offer data source under reviewed national scope.
--
-- MENY's own corporate page (https://meny.no/om-meny/, HTTP 200, 2026-09-22)
-- describes MENY as a "landsdekkende kjede" (nationwide chain). The reviewed
-- decision therefore grants national NO scope following the Extra/Tjek
-- precedent. Source permissions are append-only, so we INSERT a fresh row.

BEGIN;

INSERT INTO data_sources (id, display_name, source_kind, runtime_state)
VALUES ('meny', 'MENY kundeavis', 'offer', 'approved')
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_permissions (source_id, decision, reviewed_at, permissions, notes)
VALUES (
  'meny',
  'approved',
  clock_timestamp(),
  jsonb_build_object(
    'officialOffers', true,
    'officialOfferCapabilities', jsonb_build_array('capture', 'discover', 'extract'),
    'officialOfferRightsClassifications', jsonb_build_array('public_display')
  ),
  'MENY weekly offers ingested from the official kundeavis.meny.no iPaper viewer under reviewed national scope (meny.no/om-meny: landsdekkende kjede).'
)
ON CONFLICT DO NOTHING;

-- Mark the newest permission row as current on the data_sources side.
UPDATE data_sources
SET
  permission_reviewed_at = (
    SELECT reviewed_at FROM source_permissions
    WHERE source_id = 'meny' ORDER BY id DESC LIMIT 1
  ),
  permission_expires_at = NULL
WHERE id = 'meny'
  AND permission_reviewed_at IS NULL;

COMMIT;
