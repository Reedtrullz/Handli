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
