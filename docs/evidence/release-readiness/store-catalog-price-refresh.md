# Store-scoped catalog+price refresh (REMA 1000, Extra, Europris)

Date: 2026-09-22 · Branch: codex/discovery-chain-scan (on 75c0ca4) · Status: implemented, tests green, not yet deployed

## Diagnosis

REMA 1000 and Extra showed no products or prices in Oppdag because the worker only persisted prices for exact-EAN targets from the local catalog, and upstream REMA EANs overlap that target universe at 0%. Fix A (75c0ca4) already stops discovery rows from chains without fresh prices; Fix B adds a new ingestion path that creates the products themselves.

## Live probes (VPS, 2026-09-22)

- REMA_1000 and EUROPRIS_NO listing pages return 100-row pages with prices and EANs (pages 1–3 verified).
- COOP_EXTRA: 1 row total upstream, and that row has current_price null. Extra is an upstream gap; the job tolerates sparse chains.
- Listing row shape: id, name, ean, current_price, weight, weight_unit, store (singular object), price_history, created_at, updated_at. No last_checked; created_at is used as price observedAt.
- No total/last_page in meta; transient HTTP-200 empty pages occur.

## Implementation (Fix B)

- New worker job kind store-catalog-price-refresh (run type catalog, 6h schedule, 10min timeout): walks /products?store={CODE}&page={N}&size=100&sort=date_desc&unique=1&exclude_without_ean=1 for REMA_1000, COOP_EXTRA, EUROPRIS_NO, 12 pages per chain with jobId-digit rotation (no cursor state; repeated walks self-heal).
- Normalizer normalizeStoreScopedProductPage emits catalog outcomes (one per row) plus current-price outcomes (one per row with a parseable current price). Malformed rows, invalid GTINs, and future timestamps are quarantined fail-closed. Catalog outcomes persist before price outcomes because prices reference products the catalog batch creates.
- Registered the kind across contracts, worker state, operations dashboards/runtime, source-health writer, evidence schema, and migration 044 (worker_job_results kind CHECK).

## Verification

- corepack pnpm -r typecheck: all 7 packages pass.
- kassalapp source-contracts 38 tests; worker 219 tests (incl. 3 new store-walk handler tests and schedule coverage); db 68 focused tests; domain 320; web operations-service 3.

## Non-claims

- Not deployed yet; no live Oppdag evidence yet.
- Extra will stay near-empty until upstream adds rows/prices; the job reports honest degraded/failed counters for empty pages instead of fabricating coverage.
- observedAt=created_at is a proxy (upstream exposes no per-price check time).


## 2026-10-01 update: PR #81 merged and deployed; governance incident found and fixed

- PR #81 (9471ea0) merged 15:26Z; deploy run 36886997059 success 15:50Z; worker restarted 15:49:47Z on commit 9471ea0; migration 046 applied (catalog-run price guard; observedAt now retrievedAt; all five chains walked; empty pages continue).
- Immediately after deploy, discovery returned zero products for every chain (including previously-working meny=8, spar=8). Root cause: integration tests run earlier that day against the production database through the SSH tunnel appended ingestion-integration-approved permission rows 9-11 and reset data_sources.runtime_state to conditional with null permission_reviewed_at. The public-catalog reader requires the source row approved and aligned with the latest permission row, so discovery fail-closed.
- Restored production governance: appended an owner re-approval row (no expiry, all four scopes, notes documenting supersession of rows 9-11) and aligned the source row to it. Discovery verified: bunnpris=2, meny=8, spar=8, others 0 (baseline).
- Prevention: PR #82 restores the pre-test source-row state in afterAll and fails closed when the target database contains catalog_observations.
- Next scheduled walk 18:15 UTC (first post-fix run). Live verification pending: worker_job_results status, ingestion_runs completed, price_observations per chain (bunnpris, rema-1000, extra, europris, joker nonzero), discovery counts per chain.



## 2026-10-01 update: PR #82 fix for PERSISTENCE_FAILURE (root cause: upstream pagination duplicate)

### Root cause (reproduced end-to-end)

- The 18:15 UTC walk 1687 repeated the earlier symptom: partial, failed=1, fetched=1175 (47x25), catalog persisted, prices never persisted.
- Full local replay against an isolated Postgres (all migrations, real PostgresIngestionRepository, 4801 cached live outcomes) reproduced the failure at batch 775: IngestionOutcomeConflictError, "Conflicting replay for ingestion outcome 2/product/183891". The day's duplicate sourceRecordId (different retrievedAt stamp after upstream pagination drift) hits the audit ledger's per-run identity rule exactly at the observed failure index (walk 609 audited 1175 = 47x25 rows before dying).
- Live data contained 4 duplicate identity pairs that walk (product 183891, 183892, 229115, 226784).

### Fix (PR #82, merge commit 0cbe2fc557f2f54183cec95aabdab5dc89de9275)

- apps/worker/src/kassalapp-handlers.ts: dedupeOutcomesByIdentity keeps the first sighting per (recordKind, sourceRecordId); walk path persists deduped catalog/price outcomes. catalog-refresh untouched.
- Regression test: duplicated REMA_1000 row across two pages persists once.

### Validation before deploy

- Worker: 219 tests passed incl. regression test; typecheck clean; db package: 350 tests passed.
- CI run 36922275065 (PR): first attempt hung 60+ min on the playwright-install runner step and was cancelled; rerun succeeded. CI run 36925851646 (main, 0cbe2fc): success.
- PR #82 merged into main at 2026-10-01T21:01:45Z; protected deploy run 36926909874 for 0cbe2fc in progress at time of writing.

### Non-claims

- Live post-deploy walk verification (00:15 UTC Oct 2 walk or manual trigger) still pending; discovery counts unchanged until the fixed worker completes a full walk.
