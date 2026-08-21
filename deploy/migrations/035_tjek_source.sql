-- Migration 035: Add Tjek as a data source for Bunnpris promotional catalog
-- The Tjek API (squid-api.tjek.com) provides structured weekly offer data for Bunnpris.
-- This source feeds the official-offer pipeline so weekly promotions appear on Oppdag.

BEGIN;

INSERT INTO data_sources (id, runtime_state)
VALUES ('tjek', 'approved')
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_permissions (source_id, permissions, decision, reviewed_at, created_at)
VALUES (
  'tjek',
  '{"catalog": true}'::jsonb,
  'approved',
  now(),
  now()
)
ON CONFLICT DO NOTHING;

-- Mark the source permission as current on the data_sources side
UPDATE data_sources
SET
  permission_reviewed_at = (
    SELECT reviewed_at FROM source_permissions
    WHERE source_id = 'tjek' ORDER BY id DESC LIMIT 1
  ),
  permission_expires_at = NULL
WHERE id = 'tjek'
  AND permission_reviewed_at IS NULL;

COMMIT;
