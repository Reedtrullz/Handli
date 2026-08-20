# Adding a Secondary Price Source

This note maps the current Kassalapp ingestion path and the minimum seams for adding Open Prices (https://prices.openfoodfacts.org) as a secondary source. The database evidence model is mostly source-neutral; worker composition, schedules, and some read-model/cache assumptions are Kassalapp-specific.

## Worker handler contract

apps/worker/src/runner.ts defines WorkerJobHandler as (WorkerJobContext) => Promise<WorkerHandlerResult>. Context includes fenceToken, jobId, kind, runId, signal, and sourceId. Results carry fetched/accepted/quarantined/unknown/persisted/failed counters; WorkerRunner enforces fetched = accepted + quarantined + unknown and persisted = fetched, and handles cancellation, timeout, and failure.

apps/worker/src/kassalapp-handlers.ts is source-specific. Its interfaces are KassalappSourceAccessPolicy, KassalappTargetProvider (catalog page, catalog GTINs, benchmark targets, historical targets), KassalappIngestionRepository (beginRun, persistCatalogOutcomes, persistPriceOutcomes, persistPhysicalStoreOutcomes, finalizeRun), and KassalappHandlerDependencies (clock, gateway, repository, access policy, target provider). createKassalappHandlers returns catalog-refresh, benchmark-price-refresh, historical-observation-collection, and physical-store-sync handlers.

The shared executor validates kind/source/fence, checks access before source calls and between batches, starts an ingestion run, persists batches of 25, and finalizes completed/degraded/cancelled. A new source can duplicate this shape in open-prices-handlers.ts or extract a source-neutral price executor. Define source-owned records and map them to DB PriceIngestionOutcome; do not make Open Prices implement Kassalapp types.

## Production and bootstrap

production.ts contains PostgresKassalappTargetProvider over WorkerGtinTargetReader. It validates/deduplicates GTINs, applies targetLimit (max 500), and attaches the national geographic scope. It also defines Kassalapp schedules, GovernedKassalappSourceAccessPolicy (deployment state plus PostgresSourceAccessReader and capability keys catalog/ordinaryPrice/priceHistory/physicalStore), request authorization, and source-keyed leases.

bootstrap.ts builds DB, lease adapter, request budget (providerKey kassalapp), governed access, KassalappClient, PostgresIngestionRepository, worker state, health, runtime, and supervisor. Open Prices needs its own client/adapter, access policy/authorizer, request-budget key, target provider, handlers, schedules, and lease source. A single runtime may merge handler maps, but source identity and request routing must remain explicit.

## Ingestion persistence

packages/db/src/ingestion.ts is source-neutral. PriceIngestionOutcome accepted records contain amountOre, fetchedAt, optional geographicScopeId, observedAt, sourceReference, recordKind price, subjectChain, and subjectEan. persistPriceOutcomes derives capability from run type (benchmark-prices -> ordinaryPrice; historical-prices -> priceHistory), locks source governance, quarantines accepted outcomes when permission is not currently approved, audits every outcome in sourceRecordOutcomes, resolves canonical product by GTIN, and inserts priceObservations with source/run/product/chain/amount/timestamps, evidence key, raw hash, confidence 100, chain evidence, and claim eligibility. Ordinary runs also insert priceCoverageChecks. Evidence inserts are idempotent; conflicting replay identities raise IngestionOutcomeConflictError. finalizeRun reconstructs counters from audited outcomes.

The notable hard-coded source behavior is the legacy priceCache write, guarded by claimEligibility === ordinary_only && handle.sourceId === kassalapp. Open Prices should use priceObservations unless cache/read-model behavior is deliberately generalized.

## Schema and migration patterns

packages/db/src/evidence-schema.ts (re-exported by schema.ts) defines dataSources, sourcePermissions, ingestionRuns, sourceRecordOutcomes, priceObservations, and priceCoverageChecks. data_sources stores stable id, source_kind (use ordinary_price), runtime state, public URL, permission clocks, and kill-switch reason. source_permissions is append-only with decision, review/expiry, references, notes, and JSON capabilities; ordinary fallback requires { ordinaryPrice: true }. ingestion_runs are source/run-type/status/counter records. source_record_outcomes are immutable normalized audit rows keyed by run/kind/source-record identity. price_observations already accepts all supported chains and arbitrary source IDs; no new table is required.

Use a forward-only deploy/migrations SQL migration like 002_sources_catalog.sql plus 029_kassalapp_source_approval.sql: insert open-prices initially fail-closed, then append a reviewed approved permission row and update permission/public clocks. Keep the source id stable (for example open-prices).

## Other sources

contracts.ts includes a separate official-offer pipeline: official-offer-discovery, official-offer-fetch, official-offer-ingestion, and official-offer-lifecycle-reconcile. official-offer-operational.ts uses normalized discovery/fetch ports and per-attempt authorization; bootstrap currently disables production activation. It writes offer/foundation tables, not price_observations. There is no other ordinary-price provider: packages/kassalapp is the only client/gateway implementation. Open Prices needs a new package with typed client, strict normalization, cancellation/error taxonomy, fake, and tests.

## Minimal changes

1. Add an Open Prices client/package with GTIN+chain price API wrapper, strict accepted/unknown normalization, source references/timestamps, one-attempt authorization, and request budgeting.
2. Add Open Prices benchmark (and optionally historical) handlers. Existing handlers reject non-Kassalapp source IDs, so either add source-specific job kinds or make price jobs source-neutral while preserving explicit routing.
3. Add a chain-aware target provider selecting only Extra, REMA 1000, and Bunnpris GTINs lacking an eligible Kassalapp observation. Current WorkerGtinTargetReader returns global lists, so this likely needs a DB query extension. Keep deterministic ordering and 500 cap.
4. Wire env/config, request budget key, governed access, client, handlers, schedules, runtime map, and source lease in production/bootstrap; include new schedules in productionCycleBoundMs.
5. Add data_sources/source_permissions migration; no observation schema migration.
6. Generalize packages/db/src/price-read-model.ts and source-status/API predicates: the public read path currently explicitly filters sourceId = kassalapp, so Open Prices rows otherwise remain non-public despite valid evidence.
7. Add client, handler, fallback-selection, migration, access-change, idempotency, read-model, schedule, and source-health tests.

## Recommended first slice

Implement ordinary benchmark prices only. Keep Kassalapp catalog/product identity authoritative; query Open Prices only for Extra, REMA 1000, and Bunnpris gaps; write normal price_observations, source_record_outcomes, and price_coverage_checks; leave priceCache Kassalapp-only until the read model is source-neutral. Add historical collection only after timestamp quality and source rights are reviewed.

