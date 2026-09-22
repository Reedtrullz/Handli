# Source authority reconciliation — 2026-09-09

## Decision

The local reconciliation is complete for the seven-chain candidate matrix. The
available evidence does not yet demonstrate release authority for Handleplan
public ranking, despite current runtime approvals. The launch manifest
therefore keeps all 42 cells candidate-only and leaves all three municipalities
unselected.

Runtime database approval and Handleplan agreement authority are separate
claims. The production database records current approvals for `kassalapp`,
`open-prices`, and `tjek`, but the readback contains public documentation only
and no private agreement reference. The registry records those sources as
conditional and uses the canonical runtime ID `tjek`; `tjek-api` is not a
second source.

## Runtime readback

The read-only command used the VPS key with `IdentitiesOnly=yes`, ran against
`handleplan-postgres-1`, and opened a transaction with
`transaction_read_only = on` and `statement_timeout = 15000`. It selected
source IDs, runtime states, permission IDs, review/expiry timestamps, public
reference URLs, permission-key names, and whether private references or notes
exist. No values from credentials, private reference fields, or environment
files were printed.

The observed source records were:

| Source | Runtime state | Latest permission | Review | Expiry | Actual capability values | Reference | Private reference | Notes |
|---|---|---:|---|---|---|---|---|---|
| `kassalapp` | approved | 1 | 2026-08-11 13:50:18.020313+00 | none | `catalog`, `ordinaryPrice`, `physicalStore`, `priceHistory` | public API docs | no | yes |
| `open-prices` | approved | 2 | 2026-08-20 12:54:16.122111+00 | none | `ordinaryPrice` | public API docs | no | yes |
| `tjek` | approved | 7 | 2026-08-21 16:04:05.780477+00 | none | `officialOfferCapabilities`, `officialOfferRightsClassifications`, `officialOffers`, `publicDisplay` | none | no | no |

These are runtime facts only. The current agreement-location question and the
Tjek credential/agreement-location question remain pending. Public terms and
public API pages do not resolve Handleplan-specific storage, derived-display,
redistribution, attribution, geographic, or termination rights.

## Scope and freshness

The database contains one active geographic scope, `no-national`. The 300
physical-store rows contain 100 rows each for Bunnpris, Extra, and REMA 1000,
but none has a municipality code. No production geographic scope proves Oslo
(`0301`), Bergen (`4601`), or Trondheim (`5001`). National and unknown-scope
observations are retained as diagnostics and are not counted as regional
current coverage.

The ordinary-price readback was measured at `2026-09-09 00:08:00.894196 UTC`.
For each chain, it keeps the latest eligible price observation per
`product_id/chain/geographic_scope_id` across the runtime price sources, then
classifies that one row as current when `observed_at` is within 72 hours of the
readback or stale otherwise. Thus current and stale are disjoint latest
product/scope rows; historical rows are not added again. The table is not a
deduplicated product count across multiple geographic scopes. The current
production readback has only the one national scope.

| Chain | Latest product/scope rows | Current ≤72h | Stale >72h | Oldest latest | Newest latest |
|---|---:|---:|---:|---|---|
| Bunnpris | 4 | 4 | 0 | 2026-09-07 07:16 UTC | 2026-09-08 07:18 UTC |
| REMA 1000 | 1 | 0 | 1 | 2026-03-28 00:00 UTC | 2026-03-28 00:00 UTC |
| Extra | 1 | 0 | 1 | 2024-05-02 00:00 UTC | 2024-05-02 00:00 UTC |
| MENY | 50 | 11 | 39 | 2026-08-08 00:00 UTC | 2026-09-08 07:03 UTC |
| SPAR | 31 | 0 | 31 | 2026-08-07 07:01 UTC | 2026-09-05 07:01 UTC |
| Joker | 40 | 16 | 24 | 2026-08-07 07:00 UTC | 2026-09-08 07:01 UTC |
| Europris | 19 | 0 | 19 | 2026-08-13 07:15 UTC | 2026-08-27 07:16 UTC |

The separate latest coverage-check readback contained only `priced` and
`unknown/MISSING_SUPPORTED_CHAIN` states for these chains. It contained no
regional `known_not_carried` evidence. The coverage CSV therefore leaves
regional `known_not_carried` at zero and places the measured catalog universe
in `unknown_products`; zero is not interpreted as availability.

The catalog projection contained 10,822 rows and 1,139 distinct canonical
products, with 928 distinct products retrieved within 48 hours. That 1,139
product universe is the explicit regional-unknown denominator used in every
CSV cell. It is not a claim that every product is carried by every chain.

Official-offer projections contained two approved and one published Bunnpris
offers, each with one target product. No approved-offer projection existed for
REMA 1000, Extra, MENY, SPAR, Joker, or Europris. This is a projection
diagnostic, not rights-cleared regional offer coverage.

## External release blockers

- The Handleplan agreement location is pending; runtime approval is not an
  agreement.
- The Tjek agreement/credential location is pending; the latest Tjek approval
  has no reference or notes.
- Regional scope proof is absent for all three municipalities.
- No rights-cleared, municipality-scoped official-offer feed covers all seven
  named chains.
- The existing ordinary observations have national or unknown scope and cannot
  support a regional public claim.

No provider was contacted, no production data was changed, and no credentials
or private captures were copied into the repository.
