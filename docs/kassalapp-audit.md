# Kassalapp price-ingestion audit

## Conclusion

The worker is not omitting Extra or REMA 1000 in its request. `benchmark-price-refresh` obtains the bounded EAN target set from `PostgresKassalappTargetProvider`, then calls `gateway.getSourceBulkPrices`; the client posts those EANs to `/api/v1/products/prices-bulk` in batches of at most 100. The body is exactly `{"eans":[...]}` and contains no chain/store filter. Therefore the persistent zero accepted Extra/REMA observations is consistent with an upstream coverage gap (the live bulk response usually contains other chains), not a chain parameter bug. Bunnpris having only two products is the same coverage phenomenon.

There are, however, normalization and target-selection defects that can make diagnostics less truthful or starve batches.

## Data flow

`apps/worker/src/kassalapp-handlers.ts:937-941` wires `benchmark-price-refresh` to `getBenchmarkPriceTargets` and `getSourceBulkPrices`. The provider (`apps/worker/src/production.ts:187-192`) asks Postgres for `ordinary_only` EANs, validates/deduplicates/sorts them, and attaches the first active Norwegian national geographic scope. The client (`packages/kassalapp/src/client.ts:526-557`) deduplicates, validates GTINs, chunks by 100, and POSTs `/products/prices-bulk` with no store or geographic arguments.

`packages/db/src/worker-targets.ts:159-175` selects active verified EAN8/EAN13 identifiers associated with active products, ordered by least-recent refresh, then applies the limit. It does not select by chain; chain is determined solely by each upstream store row.

## Normalization and quarantine

`normalizePriceSourceResponse` (`packages/kassalapp/src/source-contracts.ts:647-805`) accepts each valid store row whose exact source code is in `CHAIN_BY_CODE`. Current mappings are correct: `BUNNPRIS -> bunnpris`, `COOP_EXTRA -> extra`, `REMA_1000 -> rema-1000`, plus ten additional live codes (FUDI, HOLDBART, MENY_NO, HAVARISTEN, JOKER_NO, SPAR_NO, FASTCANDY, EUROPRIS_NO, ENGROSSNETT_NO, ODA_NO).

For every returned EAN, the normalizer emits `MISSING_SUPPORTED_CHAIN` unknown outcomes for supported codes absent from that product. This does not quarantine a valid price: a valid Extra/REMA row is accepted before coverage synthesis. A row with `current_price: null` is `MISSING_PRICE`; missing timestamp is `MISSING_TIMESTAMP`; unknown store codes are quarantined as `UNKNOWN_CHAIN`.

Two edge cases can overstate missing coverage: malformed product rows are quarantined before their valid EAN is added to `returnedEans`, causing an additional `MISSING_REQUESTED_EAN`; malformed store rows with a recognizable supported `store` are not added to the seen-chain set, causing both `MALFORMED_RECORD` and `MISSING_SUPPORTED_CHAIN`. Lowercase or aliased store codes are also treated as unknown because lookup is exact after trim. These are diagnostic/accounting bugs, not evidence that valid Extra/REMA prices are intentionally rejected.

## Store parameters and alternate endpoints

The adapter uses `GET /products?store=...` only for public browse and `GET /physical-stores?group=...` for physical-store sync, both hardcoded to `BUNNPRIS`, `REMA_1000`, and `COOP_EXTRA`. Bulk current and historical ingestion both use `POST /products/prices-bulk`; no store code, store id, branch, geography, cursor, or alternate price endpoint is implemented or documented. The published/reconciled contract and tests show no chain-specific bulk parameter. A credentialed live probe would be required to establish whether Kassalapp offers undocumented filters or better-coverage endpoints.

## Important historical context

Commit `6507e33` expanded normalization from the original three chains after live bulk data was observed to be dominated by ten other chain codes and added support for string price amounts. Commit `3b7ed12` fixed a persistence validator that still hardcoded three chains; before that fix, expanded-chain outcomes could cause `PERSISTENCE_FAILURE` and zero persisted rows. Verify production runs occurred after that fix.

## Target-selection risk

`PostgresWorkerGtinTargetReader` filters only digit length in SQL; checksum validation happens in `values(rows)` after `LIMIT`. Invalid-checksum identifiers can therefore consume the limit and reduce/starve refresh targets. Add a SQL checksum predicate or over-fetch/refill until enough valid GTINs are obtained. `getNationalPriceScopeId` also chooses the lowest active NO national scope without detecting multiple active scopes, so geographic tagging can be ambiguous.

## Recommended verification

1. Inspect persisted run outcomes by `raw_chain_code` and reasons, distinguishing `UNKNOWN/MISSING_SUPPORTED_CHAIN` from `QUARANTINED/UNKNOWN_CHAIN` and `MISSING_PRICE`.
2. Confirm the deployed worker includes `3b7ed12` or equivalent expanded-chain validator fix.
3. Capture one redacted live `/products/prices-bulk` response for representative EANs to measure actual Extra/REMA/Bunnpris rows and casing.
4. Fix malformed-row seen-EAN/seen-chain accounting and the SQL checksum/limit starvation issue.

## Non-claims

This audit does not establish branch inventory, branch shelf prices, or undocumented Kassalapp endpoint behavior.
