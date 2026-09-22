# Tjek live intake verification (Bunnpris, REMA 1000, Extra)

**Captured:** 2026-09-21 (Europe/Oslo)
**Branch:** `codex/prices-and-discounts`
**Scope:** redacted release-readiness evidence. No key material, no raw offer payloads, no credential contents.

## Production worker state at capture

The deployed worker (`main` @ `34b9ad1`) runs a weekly Tjek job that fails every
week (last observed run 2026-09-18 02:15 UTC). Three independent failure modes:

1. **Bunnpris approval path:** the legacy handler writes `approved_offers` /
   `review_actions` directly and failed with `permission denied for table
   approved_offers`. Post-capture grant verification showed
   `has_table_privilege` true for `handleplan_app` and a role-probe
   insert+rollback succeeded; the 09-18 denial cause is unresolved but moot
   because this branch replaces the path with the foundation pipeline plus
   migrations 041/042 (not yet applied to prod; prod ledger stops at 040).
2. **Extra / REMA empty-catalog path:** the deployed handler inserts
   `confirmed-empty` extraction rows with NULL confirmation, violating
   `extraction_runs_empty_confirmation_pair`. Five extraction rows exist, all
   `tjek-v1`, all `not-empty {"offers":1}`.
3. **Accumulated publications:** per-catalog try/catch commits publication and
   capture rows even when extraction fails, so 15 publications exist with no
   valid extraction.

## Bounded live probe (authorized, counts only)

Three catalog-list requests ran inside the worker container using the runtime
`TJEK_API_KEY`; responses were reduced to counts and scope flags before
leaving the container. No key material was read or logged.

| Chain | External edition ID | Offer count | Scope flags |
| --- | --- | --- | --- |
| bunnpris | `oY6H4Pai` | 4 (expires 2026-09-21T21:59Z) | `all_stores:true`, dealer country NO, 1 market NO |
| extra | `90PcyaWx` | 3 | `all_stores:true`, dealer country NO, 1 market NO |
| rema-1000 | `NoGQS7Cj` | 113 | `all_stores:true`, dealer country NO, 1 market NO |

National scope is positively proven by the response flags for all three
catalogues, so the plan's national branch in `resolveEdition`
(`tjek-production.ts:80-180`, requires `raw.all_stores === true`) applies to
Extra as well. Catalog IDs rotate weekly; they are recorded as observed
identity, not as stable configuration.

## Request-attempt governance (Task 8 Step 3)

`TjekClientOptions` gained an optional `authorizeRequestAttempt` callback
(`packages/tjek/src/client.ts`). It is awaited at every physical fetch
boundary — RPC, `listCatalogs`, and each paged `getPagedOffers` request —
with the caller's signal, before fetch. No hidden retries were added; 429
handling and abort propagation are unchanged.

The production wiring (`apps/worker/src/production.ts`,
`createTjekRequestAttemptAuthorizer`) calls the persisted source-access
policy for `("tjek", "discover")`, parses the decision with
`officialOfferAuthorizationFenceV1Schema`, and rejects when the returned
capabilities lack `discover`. The live prod fence carries capabilities
`["capture","discover","extract"]` with rights `["public_display"]`, so
physical requests proceed only while the persisted approval stands.

Tests (`packages/tjek/src/client.test.ts`) assert:

- authorization count equals physical request count (3 dealer discoveries for
  `getAllLatestCatalogs`; +2 per additional paged offers page; Incito flow
  counts generate + detail requests individually);
- revocation between request 1 and request 2 prevents request 2 while the
  client still reports the first response.

## Verification runs (2026-09-21)

```
corepack pnpm --filter @handleplan/tjek test
  -> Test Files 2 passed (2); Tests 31 passed (31)

corepack pnpm --filter @handleplan/worker exec vitest run \
  src/tjek-handlers.test.ts src/tjek-production.integration.test.ts
  -> 5 passed; integration file skipped (RUN_OFFICIAL_OFFER_DB_INTEGRATION gate)

corepack pnpm --filter @handleplan/worker typecheck
  -> tsc --noEmit OK (strict)
```

## Review vs transport semantics (Task 8 Step 4)

The foundation pipeline keeps fetched / persisted / quarantined / failed
counters distinct. Semantic uncertainty stays `review-required` /
`EXTRACTOR_ANOMALY`; it is never coerced to zero failures. Monitoring is
expected to distinguish review backlog from request/SQL failure.

## Explicit non-claims

- No full offer extraction has been run against the live Tjek API yet; the
  probe verified catalogues, counts, and scope flags only. Full captures are
  produced by the deployed foundation pipeline after Task 24.
- Nothing is deployed; prod remains `34b9ad1`.
- Bunnpris offer count 4 reflects the catalogue valid until
  2026-09-21T21:59Z; counts are point-in-time.
