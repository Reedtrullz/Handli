-- Grant handleplan_app EXECUTE on canonical_official_offer_* functions
-- needed by the Tjek handler's computeEditionIdentitySha256.
-- These are called indirectly via SQL function composition.

GRANT EXECUTE ON FUNCTION canonical_official_offer_edition_identity TO handleplan_app;
GRANT EXECUTE ON FUNCTION canonical_official_offer_scope_identity TO handleplan_app;
