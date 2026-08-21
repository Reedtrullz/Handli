-- Migration 036: Grant Tjek official-offer capabilities required by publication and trust-fence triggers.

UPDATE source_permissions 
SET permissions = permissions || '{
  "officialOffers": true,
  "officialOfferCapabilities": ["capture", "discover", "extract"],
  "officialOfferRightsClassifications": ["public_display"]
}'::jsonb
WHERE id = 3 AND source_id = 'tjek';
