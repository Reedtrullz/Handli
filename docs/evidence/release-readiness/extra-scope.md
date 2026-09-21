# Extra geographic scope verification

**Captured:** 2026-09-21 (Europe/Oslo)
**Branch:** `codex/prices-and-discounts`
**Scope:** redacted scope evidence for the Extra chain via Tjek. No key material, no raw payloads.

## Live probe result (authorized, counts only)

One catalog-list request inside the worker container (runtime `TJEK_API_KEY`,
response reduced to counts/flags before leaving the container):

| Field | Observed |
| --- | --- |
| External edition ID | `90PcyaWx` (rotates weekly; observed identity, not stable config) |
| Offer count | 3 |
| `all_stores` | `true` |
| Dealer country | `NO` |
| Markets | 1 market, `country_code: "NO"` |

This is positive national-scope evidence from the source response itself. The
plan's prohibition on inferring scope from postcode alone is respected: no
postcode was used as evidence, and `resolveEdition` requires all three
response conditions `all_stores === true`, dealer country `NO`, and every
market `NO` before the national branch applies.

## Existing resolver behavior (`apps/worker/src/tjek-production.ts`)

- National branch: accepts the catalogue only with the three conditions above;
  resolves the single active `national/NO` scope row from `geographic_scopes`
  (`status = 'active'`); rejects when the row is missing or ambiguous
  (`TJEK_REVIEWED_SCOPE_UNAVAILABLE`).
- Existing publications: conflicting chain, validity window, or nonnational
  stored scope rejects with `TJEK_EDITION_CONFLICT`.
- Legacy importer publications alone are not treated as reviewed geographic
  evidence.

## Regression coverage

`corepack pnpm --filter @handleplan/worker exec vitest run
src/tjek-production.test.ts` → 4 passed:

- all-`true` catalogue resolves national scope (fixture asserts
  `geographicScopeId` + `declaredGeographicScope {kind: "national", countryCode: "NO"}`);
- `all_stores: false` catalogue rejects with `TJEK_REVIEWED_SCOPE_UNAVAILABLE`
  regardless of stored scope rows — no negative evidence implies national.

`tjek-production.integration.test.ts` is DB-gated
(`RUN_OFFICIAL_OFFER_DB_INTEGRATION=1`) and skipped in this local run; CI
exercises it with migrations (migration 039 repair is a known baseline item).

## Regional branch deferral (deliberate)

The plan's regional mapping lookup (keyed by source + external edition
identity for nonnational catalogues) is intentionally not implemented: the
live probe showed all three current Tjek catalogues (Bunnpris, Extra,
REMA 1000) are national, so no nonnational catalogue exists to map. The
national branch rejects any future nonnational catalogue with
`TJEK_REVIEWED_SCOPE_UNAVAILABLE` — fail-closed, not silently scoped.
Upgrade path: when a nonnational Extra catalogue is observed, add the reviewed
mapping lookup against the existing reviewed geography workflow and extend
`resolveEdition` fixtures with matched-store, unproven-store, expired-proof,
and conflicting-legacy cases per the plan.

## Explicit non-claims

- This verifies scope evidence and resolver behavior only; offer extraction
  runs with the deployed foundation pipeline (Task 24).
- Catalogue IDs and counts are point-in-time observations.
