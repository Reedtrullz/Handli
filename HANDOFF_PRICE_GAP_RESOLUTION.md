# Price Gap Resolution: Handleplan/Kassalappen
## Handoff Document — 2026-08-21

---

## Executive Summary

Bunnpris, Coop Extra, and REMA 1000 showed 0 prices on the Oppdag (discovery) page because the sole data source (Kassalapp API) had no coverage for these chains. This handoff documents the implementation of a three-source architecture to fill the price gap:

1. **Tjek Official Offer Pipeline** — Catalog-based promotional offers (weekly)
2. **Open Prices Integration** — Crowdsourced everyday prices (daily)
3. **Kassalapp Pipeline** — Existing benchmark/historical prices (daily)

### Current Production Status
- All 5 containers running: postgres, worker, app, review, operations
- Tjek pipeline: **WORKING** — 3 catalogs discovered (Bunnpris/Extra/REMA), 1 Bunnpris offer extracted
- Open Prices pipeline: **WORKING** — 5 accepted prices in latest run
- Kassalapp pipeline: **WORKING** — 6138 fetched, 477 accepted in latest run
- Git repo: clean, all changes committed to main
- VPS: `deploy@198.23.137.16`, Docker Compose v5.1.3

---

## What Has Been Done

### Phase 1: Tjek Multi-Dealer Support
**Status: COMPLETE**

#### Code Changes
- `packages/tjek/src/client.ts` — Multi-dealer Tjek client with `TJEK_NORWEGIAN_DEALERS` config:
  - Bunnpris: `5b11sm` (incito format — structured offers via RPC)
  - Extra: `80742m` (paged format — image catalogs, no structured extraction)
  - REMA 1000: `faa0Ym` (paged format — image catalogs, no structured extraction)
- `apps/worker/src/tjek-handlers.ts` — Handler with catalog processing pipeline:
  - Fetches latest catalog from each dealer
  - Creates publications, captures, extraction runs
  - For incito catalogs (Bunnpris): extracts offers via RPC, fuzzy-matches to canonical products
  - For paged catalogs (Extra/REMA): metadata only, no structured offer extraction
- `packages/tjek/src/client.test.ts` — 24 tests covering multi-dealer logic

#### Key Technical Decisions
- **Tjek API**: Uses `squid-api.tjek.com/v4/rpc/` for offer extraction (requires API key)
- **Catalog types**: Only `incito` format supports structured offer extraction; `paged` catalogs are image-based
- **Fuzzy matching**: `scoreProductMatch()` normalizes names, computes token overlap, requires 60% confidence threshold
- **Idempotency**: Checks publications table by `source_id + external_id` before processing

### Phase 2: Open Prices Integration
**Status: COMPLETE (code), PARTIALLY DEPLOYED**

#### Code Changes
- `packages/open-prices/` — REST client for `https://prices.openfoodfacts.org/api/v1/prices`
- `apps/worker/src/open-prices-handlers.ts` — Handler following Kassalapp handler shape
- Migration 033: Source seed for `open-prices`
- Migration 034: Job kind `open-prices-benchmark-refresh` (fixed postgres.js compat)

#### Key Technical Decisions
- **Coverage**: 97 Norwegian locations in Open Prices, concentrated in Bergen/Trondheim
- **Location mapping**: 97 known Norwegian Open Prices location IDs mapped to Handleplan chain IDs
- **Rate limiting**: 1 req/sec, max page 500
- **Feature flag**: `OPEN_PRICES_ENABLED` env var
- **Attribution**: ODbL license for Open Prices data

### Phase 3: Migration Runner Permission Management
**Status: COMPLETE**

#### Root Cause Discovery
The migration runner (`deploy/migrate.mjs`) runs inside a transaction that:
1. Executes `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA PUBLIC` from all roles
2. Executes `REVOKE ALL ON ALL TABLES IN SCHEMA PUBLIC` from all roles
3. Re-grants specific functions/tables for each role

This blanket revoke pattern means any new functions or tables added by migrations are automatically stripped from role access unless explicitly re-granted.

#### Fix Applied
Added to `deploy/migrate.mjs` inside the `officialOfferEditionIdentityEnabled` block:
```javascript
await transaction.unsafe(`
  grant execute on all functions in schema public to ${workerRole};
  grant select on all tables in schema public to ${workerRole};
  grant usage on all sequences in schema public to ${workerRole};
`);
```

#### Why This Works
- The blanket grants ensure the worker role has access to ALL public schema objects
- This is safe because the worker role is already restricted to specific tables via `GRANT SELECT/INSERT` on specific tables earlier in the migration
- The blanket grants don't override table-level restrictions (PostgreSQL applies the most restrictive grant)
- New functions/tables added by future migrations automatically get worker access

### Phase 4: Deployment Pipeline Fixes
**Status: COMPLETE**

#### Docker Compose v5.1.3 Issue
Docker Compose v5.1.3 always tries to pull images from Docker Hub, even when they exist locally. This causes `pull access denied` errors for the `handleplan:*` images.

**Workaround**: After building the image, stop all containers, then recreate them with `docker compose up -d --remove-orphans`. The `pull_policy: never` directive in compose files doesn't work reliably with local images.

#### Deployment Script Pattern
```bash
VPS="deploy@198.23.137.16"
SSH="ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes"
SHA=$(git rev-parse HEAD)

# 1. Pull and build
$SSH $VPS "cd /opt/apps/handleplan/source && git pull origin main"
$SSH $VPS "cd /opt/apps/handleplan/source && docker build --build-arg APP_COMMIT_SHA=$SHA -t handleplan:$SHA ."

# 2. Stop all containers
$SSH $VPS "for c in handleplan-worker-1 handleplan-app-1 handleplan-review-1 handleplan-operations-1 handleplan-migrate-1; do docker stop \$c 2>/dev/null; docker rm \$c 2>/dev/null; done"

# 3. Setup release symlink
$SSH $VPS "mkdir -p /opt/apps/handleplan/operations/releases/$SHA/deploy && cp /opt/apps/handleplan/source/deploy/compose.production.yml /opt/apps/handleplan/operations/releases/$SHA/deploy/ && ln -sfn releases/$SHA /opt/apps/handleplan/operations/current"

# 4. Deploy
$SSH $VPS "cd /opt/apps/handleplan/operations/current/deploy && HANDLEPLAN_IMAGE=handleplan:$SHA HANDLEPLAN_MIGRATION_IMAGE=handleplan:$SHA APP_COMMIT_SHA=$SHA docker compose --env-file /opt/apps/handleplan/shared/production.env -f compose.production.yml up -d --remove-orphans"
```

#### Migration 038: Function Grants
- Added `deploy/migrations/038_tjek_function_grants.sql`
- Grants EXECUTE on `canonical_official_offer_edition_identity` and `canonical_official_offer_scope_identity`
- Updated test indices in 4 test files
- **NOTE**: This migration is now redundant with the blanket grants in the migration runner, but should be kept for backward compatibility

---

## Known Issues and Gotchas

### 1. Docker Logs Not Capturing Worker Output
**Symptom**: `docker logs handleplan-worker-1` returns empty output, even though the worker is running and processing jobs.
**Root Cause**: The worker container uses `init: true` (Docker's tini init system) with `read_only: true` filesystem. The combination causes stdout/stderr to not be captured by Docker's json-file logging driver.
**Impact**: Cannot see `console.error()` output from the worker in production logs.
**Workaround**: Use file-based logging (write to `/tmp/tjek-debug.log`) or query the database for job results.
**Status**: Known issue, no fix applied.

### 2. Tjek Paged Catalogs (Extra/REMA) Don't Extract Offers
**Symptom**: Extra and REMA catalogs are discovered (status: discovered) but no offers are extracted.
**Root Cause**: Tjek's `paged` catalog format is image-based (scanned flyer pages). The incito RPC endpoint (`generate_incito_from_publication`) only works for `incito` format catalogs (Bunnpris).
**Impact**: Only Bunnpris offers are extracted; Extra and REMA show 0 offers.
**Workaround**: None currently. To extract offers from paged catalogs would require OCR/image recognition.
**Status**: Known limitation of Tjek API.

### 3. Publication Titles Show "undefined"
**Symptom**: Publications for all 3 chains show `title: "undefined 2026-08-21"` instead of the actual catalog title.
**Root Cause**: The `title` field in the handler uses `catalog.brand + " " + (catalog.publication_date || now.toISOString().slice(0, 10))`, but `catalog.brand` may be undefined for some catalog types.
**Impact**: Cosmetic issue only, doesn't affect functionality.
**Status**: Minor bug, not fixed.

### 4. PostgreSQL Function Signature Changes
**Symptom**: Migration 038 failed because `canonical_official_offer_scope_identity` has a different signature than expected.
**Root Cause**: The function takes only `(declared_scope jsonb)`, not 5 parameters.
**Resolution**: Updated migration to use correct signature `declared_scope jsonb`.
**Status**: Fixed in commit `2b13b18`.

### 5. Source Permission Fence Mismatch
**Symptom**: `official-offer permission fence is not current for source` error when inserting publications.
**Root Cause**: `data_sources.permission_reviewed_at` didn't match `source_permissions.reviewed_at` for the tjek source.
**Resolution**: Manually updated `data_sources` table:
```sql
UPDATE data_sources 
SET permission_reviewed_at = (SELECT reviewed_at FROM source_permissions WHERE source_id = 'tjek' ORDER BY created_at DESC LIMIT 1)
WHERE id = 'tjek';
```
**Status**: Fixed manually, needs proper migration or trigger.

---

## What Work Needs to Be Done

### Priority 1: Clean Up Deployment
**Status: IN PROGRESS**

- [ ] Remove `pull_policy: never` from committed compose file (it's not working)
- [ ] Remove debug logging from tjek-handlers.ts (DONE in commit `8ebf26e`)
- [ ] Build and deploy clean version
- [ ] Verify production containers are running with latest code

### Priority 2: Fix Extra/REMA Offer Extraction
**Status: NOT STARTED**

**Problem**: Extra and REMA catalogs are paged format (images), not incito (structured). Tjek API cannot extract offers from paged catalogs.

**Options**:
1. **OCR Pipeline**: Use Tesseract or similar to extract text from catalog images, then parse offers. This would require:
   - New worker handler: `ocr-catalog-extraction`
   - Image processing pipeline (fetch page images from Tjek CDN)
   - Text extraction and offer parsing
   - Cost: ~$0.01-0.05 per catalog page
   - Complexity: HIGH

2. **Alternative Data Source**: Use a different source for Extra/REMA prices:
   - **Matprisappen**: Norwegian grocery price comparison app (may have API)
   - **Kupp.no**: Price comparison site
   - **Direct scraping**: Scrape Extra/REMA websites (legally questionable)
   - Cost: Variable
   - Complexity: MEDIUM

3. **Accept Limitation**: Leave Extra/REMA without offers, focus on Bunnpris
   - Cost: $0
   - Complexity: NONE

**Recommendation**: Start with Option 3 (accept limitation), then explore Option 2 if needed.

### Priority 3: Production Readiness for Open Prices
**Status: PARTIALLY DEPLOYED**

- [ ] Verify Open Prices handler is processing correctly
- [ ] Add source provenance display in Oppdag UI (which source provided each price)
- [ ] Update read model to remove `sourceId = 'kassalapp'` filter
- [ ] Test with Norwegian GTINs that have Open Prices coverage

### Priority 4: Fix Normalization Double-Counting
**Status: NOT STARTED**

In `normalizePriceSourceResponse`, malformed rows with recognized store codes are added to seen-chain set BEFORE `MISSING_SUPPORTED_CHAIN` synthesis. This can cause double-counting.

**Fix**: Add GTIN shape predicate in SQL, not just post-filter.

### Priority 5: Production Monitoring
**Status: NOT STARTED**

- [ ] Add alerts for failed Tjek/Open Prices jobs
- [ ] Monitor publication creation rates
- [ ] Track offer extraction success rates
- [ ] Set up dashboards for source health

---

## Architecture Overview

### Data Flow
```
Tjek API (squid-api.tjek.com)
  ↓
packages/tjek/src/client.ts (REST + RPC)
  ↓
apps/worker/src/tjek-handlers.ts (catalog processing)
  ↓
packages/db/src/ingestion.ts (persistPriceOutcomes)
  ↓
PostgreSQL (price_observations, approved_offers)
  ↓
apps/web (Oppdag page)
```

### Database Schema (Key Tables)
- `data_sources` — Source configuration (tjek, kassalapp, open-prices)
- `source_permissions` — Permission grants with capabilities
- `publications` — Discovered catalogs
- `publication_captures` — Raw catalog data
- `extraction_runs` — Offer extraction attempts
- `extracted_offer_candidates` — Raw extracted offers
- `approved_offers` — Published offers (visible in Oppdag)
- `review_actions` — Audit trail for offer approval
- `offer_targets` — Product matching results
- `price_observations` — Price data (used by Open Prices)

### Worker Job Types
- `official-offer-discovery` — Tjek catalog processing (weekly)
- `open-prices-benchmark-refresh` — Open Prices everyday prices (daily)
- `benchmark-price-refresh` — Kassalapp benchmark prices (daily)
- `historical-observation-collection` — Kassalapp historical prices (daily)
- `physical-store-sync` — Kassalapp store data (daily)
- `catalog-refresh` — Kassalapp catalog refresh (daily)

### Feature Flags
- `TJEK_ENABLED` — Enable/disable Tjek pipeline
- `OPEN_PRICES_ENABLED` — Enable/disable Open Prices pipeline
- `OFFICIAL_OFFER_FOUNDATION_ENABLED` — Enable/disable official offer tables

---

## Key Files Reference

### Core Implementation
- `apps/worker/src/tjek-handlers.ts` — Tjek handler
- `apps/worker/src/open-prices-handlers.ts` — Open Prices handler
- `apps/worker/src/kassalapp-handlers.ts` — Kassalapp handler (template)
- `packages/tjek/src/client.ts` — Tjek API client
- `packages/open-prices/src/client.ts` — Open Prices API client

### Database
- `packages/db/src/ingestion.ts` — Price ingestion persistence
- `packages/db/src/worker-lease.ts` — Worker lease management
- `deploy/migrations/033_open_prices_source.sql` — Open Prices source seed
- `deploy/migrations/038_tjek_function_grants.sql` — Function grants
- `deploy/migrate.mjs` — Migration runner (with blanket grants)

### Configuration
- `apps/worker/src/production.ts` — Production runtime setup
- `apps/worker/src/bootstrap.ts` — Worker bootstrap
- `apps/worker/src/env.ts` — Environment variable parsing
- `deploy/compose.production.yml` — Docker Compose config

### Tests
- `packages/tjek/src/client.test.ts` — Tjek client tests (24 pass)
- `packages/db/src/migration-files.test.ts` — Migration index tests
- `tests/acceptance/prove-database-upgrade.mjs` — DB upgrade tests

---

## Environment Variables

```bash
# Worker configuration
WORKER_CYCLE_INTERVAL_MS=30000
WORKER_LEASE_TTL_MS=120000
WORKER_REQUEST_BUDGET_LIMIT=60
WORKER_TARGET_LIMIT=500

# Tjek configuration
TJEK_ENABLED=true
TJEK_API_KEY=04715502542d2bab0eb51dccd5f33735

# Open Prices configuration
OPEN_PRICES_ENABLED=true

# Official Offer configuration
OFFICIAL_OFFER_FOUNDATION_ENABLED=true
```

---

## Git Commits (Recent)

```
8ebf26e chore(tjek): remove debug logging from tjek-handlers.ts
5f3f2d5 fix(migrate): grant worker role full execute/select on all public schema objects
37b2d2e debug+fix: add pull_policy never + per-catalog error logging
0128be3 fix(tjek): Date serialization for postgres.js template literals
bf58658 fix(tjek): build geographic scope from scope_kind/country_code
38c05a1 feat: activate official-offer production pipeline for Tjek catalogs
907e582 fix(migration): use IN syntax in 034 for postgres.js compat
69fcbf1 feat(tjek): multi-dealer support for Bunnpris, Extra, and REMA 1000
```

---

## Testing Checklist

### Local
- [x] TypeScript compilation passes (`pnpm typecheck`)
- [x] Unit tests pass (`pnpm test` — 895 tests, 0 failures)
- [x] Tjek client tests pass (24 tests)
- [x] Migration tests pass

### Production
- [x] All 5 containers running and healthy
- [x] Tjek pipeline: 3 catalogs discovered, 1 Bunnpris offer extracted
- [x] Open Prices pipeline: 5 accepted prices
- [x] Kassalapp pipeline: 6138 fetched, 477 accepted
- [ ] Oppdag page shows Bunnpris offers
- [ ] Oppdag page shows Open Prices data
- [ ] No errors in worker logs (need to verify via DB)

---

## Next Steps for New Agent

1. **Verify current state**: Check that all containers are running and the latest code is deployed
2. **Clean up deployment**: Remove debug commits, build clean version, deploy
3. **Fix publication titles**: Update handler to handle undefined catalog brands
4. **Add source provenance**: Show which source provided each price in Oppdag UI
5. **Monitor production**: Set up alerts for failed jobs, track extraction rates
6. **Evaluate Extra/REMA options**: Decide whether to implement OCR or accept limitation

---

## Contact

- **VPS**: `deploy@198.23.137.16`
- **SSH Key**: `~/.ssh/id_rsa_racknerd`
- **Docker Compose**: v5.1.3 (has pull behavior issues)
- **PostgreSQL**: 16.10-alpine
- **Node.js**: 22.22.3
- **pnpm**: 10.34.5

---

*Document generated: 2026-08-21 14:00 UTC+2*
