# Handleplan Full Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an evidence-backed Handleplan release with working prices, discounts, basket planning and shopping flows for all seven requested chains in explicitly supported geography.

**Architecture:** Reuse the existing source adapters, official-offer foundation, review boundary, lifecycle SQL, public projection and planner. Repair the database boundaries first, qualify each source independently, then prove the complete product against candidate-current real evidence. Keep discovery of unknown provider formats as explicit gated engineering tasks rather than inventing their contracts.

**Tech Stack:** Node 22.22.3, pnpm 10.34.5, TypeScript, Next.js/React, Vitest, Playwright, postgres.js/Drizzle, PostgreSQL 16.10, Docker Compose, GitHub Actions, Cloudflare Access.

**Spec:** `docs/superpowers/plans/2026-09-08-handleplan-full-release-spec.md` (read alongside `docs/evidence/prices-discounts-2026-09-08.md`).

## Global Constraints

- Use Node 22.22.3 and pnpm 10.34.5.
- Do not modify migrations 022–040.
- Do not fabricate products, prices, discounts, source rights, review decisions or production evidence.
- Do not weaken trust, freshness, source-permission, supported-chain, geographic or generic GTIN validation gates.
- Do not grant the worker direct review/approval/publication authority.
- Preserve unrelated work, database contents, existing private captures and historical evidence.
- Keep credentials, private captures and personal account data out of Git and durable reports.
- Do not contact providers or send messages to others without explicit authorization.
- Use `ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes` for the VPS.
- Check `df -h /System/Volumes/Data` before long builds; stop below 30 GiB free.
- Use the prescribed Compose stop/remove/recreate procedure and verify the exact deployed SHA and image digest.
- No public-release claim until every applicable G1–G12 gate passes for the same candidate.


---

## Execution map and completion rules

This is the umbrella plan for four independently reviewable workstreams: database reliability (1–5), source/data delivery (6–15), user acceptance (16–20), and release operations (21–25). Separate source-specific implementation plans are required outputs of qualification when the payload has not been observed; this is a discovery dependency, not permission to omit that chain. Execute the database work first. Source rights and format research can proceed independently. Do not dispatch agents merely to copy this plan; each implementation task gets its own ownership boundary and review.

Baseline: draft PR12, `3912d52a0c1b278136e4bde364accedd1912db8d`. This plan does not assert that draft is deployable. All checkboxes are open; existing code must be reviewed and verified rather than rewritten. Commit each independently testable change; do not merge a dependency with a known failing integration test. If an external dependency blocks one task, continue independent tasks and leave the release blocked.

Each numbered checkbox below is one bounded action or one named test run. A long CI build/device journey is a monitored operation, not a reason to split its evidence into fake passes. Each source implementation task is decomposed further once its actual payload is captured. No estimate assumes provider access, legal approval, a device reviewer or a release signer will appear automatically.

## File structure and responsibilities

| Files | Responsibility |
|---|---|
| `deploy/migrate.mjs`, proposed `deploy/bootstrap/040_schema.sql`, `deploy/bootstrap/040_manifest.json`, proposed migrations `041_public_offer_projection_repair.sql`, `042_official_offer_worker_boundary.sql` | Fresh bootstrap, explicit ledger provenance, forward projection repair, least-privilege ingestion SQL. Verify next available numbers before creating them. |
| `packages/domain/src/offer-ingestion-contracts.ts`, `packages/db/src/official-offer-foundation.ts`, `apps/worker/src/tjek-production.ts` | Exact authorization timestamps, transactional persistence and source composition. |
| `packages/tjek/src/client.ts`, `apps/worker/src/tjek-handlers.ts`, `apps/worker/src/official-offer-lifecycle.ts`, `apps/worker/src/bootstrap.ts` | Bounded fetch, truthful review intake, retries and lifecycle scheduling. |
| `packages/kassalapp/src/client.ts`, `packages/open-prices/src/normalizer.ts`, `apps/worker/src/production.ts`, `packages/db/src/worker-targets.ts` | Ordinary-price coverage and refresh selection. |
| proposed `apps/worker/src/meny-offers.ts`, `spar-offers.ts`, `joker-offers.ts`, `europris-offers.ts` and corresponding `.test.ts` files | One adapter per proven provider contract, created only after qualification; no new universal scraping framework. |
| `packages/db/src/review-queue.ts`, `apps/web/lib/server/review-evidence-reader.ts`, `review-evidence-service.ts`, `review-service.ts` | Private evidence rendering and explicit review decisions. |
| `packages/db/src/public-catalog-index-reader.ts`, `apps/web/lib/server/discovery-service.ts`, `price-service.ts`, `plan-service.ts`, `packages/domain/src/planner-v2.ts` | Public discovery and planning semantics. |
| `docs/data/source-registry.v1.json`, `launch-coverage.v1.json`, `benchmark-baskets.v1.json`, `tests/acceptance/` | Measured coverage, basket execution and independent verification. |
| `deploy/backup/`, `scripts/operations/`, `docs/runbooks/`, `.github/workflows/ci.yml`, `.github/workflows/deploy-preview.yml` | Operational proof and exact-image delivery. |
| `docs/evidence/release-readiness/` | Redacted execution evidence, per-source qualification and unresolved blockers. |
| `docs/evidence/v1/<candidate>/` | Final source-bound release artifacts; `<candidate>` is assigned once the immutable source commit exists, not a guessed value. |

## Working commands

Run from the isolated checkout. Use the existing worktree for planning; at execution, verify ownership/cleanliness with the worktree skill before selecting it. Never copy production credentials into test commands.

```bash
export PATH=/Users/reidar/.nvm/versions/node/v22.22.3/bin:$PATH
node --version
corepack pnpm --version
git status --short
git rev-parse HEAD
df -h /System/Volumes/Data
```

Expected Node `v22.22.3`, pnpm `10.34.5`, at least 30 GiB available before a build. Disposable DB test variables are exactly the non-secret CI fixture variables in `.github/workflows/ci.yml`; use a unique local container and loopback port, never `production.env`. Set `RUN_DB_INTEGRATION=1` and `RUN_OFFICIAL_OFFER_DB_INTEGRATION=1` only for that disposable DB. Preserve sanitized logs under `docs/evidence/release-readiness/`; raw private inputs stay in the protected capture store.


### Task 1: Freeze scope and collect a new execution baseline

**Depends on:** None

**Files:**
- Read: `docs/superpowers/plans/2026-09-08-handleplan-full-release-spec.md`
- Create: `docs/evidence/release-readiness/baseline.md`
- Read: repository and `apps/web/AGENTS.md` instructions

**Interfaces:** Consumes PR12 and the live installation; produces a dated baseline naming commit, image, migration ledger, chain scope and external owners. No new runtime API.


- [ ] **Step 1: Record repository and CI identity**

```bash
git status --short
git rev-parse HEAD
gh pr view 12 --json headRefOid,statusCheckRollup
gh run view 34231658984 --log-failed
```
Record failure step, not megabytes of generated SQL.


- [ ] **Step 2: Read live service and schema state**

```bash
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16 'docker ps --filter name=handleplan --format "{{.Names}} {{.Image}} {{.Status}}"'
```
Read ledger IDs/checksums and current source approval through read-only SQL; no tokens or account rows.


- [ ] **Step 3: Fix the release scope in the baseline**

List all seven required chains. Retain the existing three-region/60-run protocol until measured coverage supports a documented scope change. Record actual provider-access, review, operations, device and independent-signing owners; unassigned owners are release blockers.


- [ ] **Step 4: Commit only the redacted baseline**

```bash
git add docs/evidence/release-readiness/baseline.md
git commit -m "docs: record full-release execution baseline"
```


**Review/exit:** A new engineer can identify exactly which checkout, live system and scope the plan addresses.


### Task 2: Design and prove immutable migration recovery

**Depends on:** 1

**Files:**
- Modify: `deploy/migrate.mjs`
- Create: `deploy/bootstrap/040_schema.sql`, `deploy/bootstrap/040_manifest.json`, `deploy/migrations/041_public_offer_projection_repair.sql`
- Modify/Test: `tests/acceptance/prove-database-upgrade.mjs`, `packages/db/src/migration-files.test.ts`
- Create: `docs/evidence/release-readiness/migration-recovery.md`

**Interfaces:** Consumes the exact legacy checksums and production pg_get_functiondef; produces an empty-database-only baseline path and an ordinary forward migration. Existing installations keep their historical ledger. Baseline metadata is distinct from claims that old migrations executed.


- [ ] **Step 1: Reproduce the fresh install failure**

Use the CI PostgreSQL image and migration environment. Run:
```bash
node deploy/migrate.mjs
```
Expected current failure: migration039 SQL syntax. Retain a bounded error excerpt. Add the fresh-install/replay/upgrade cases to the existing upgrade proof before changing the runner.


- [ ] **Step 2: Write the recovery decision**

Compare pristine schema through038, reviewed intended projection changes and the live function definition. Require a reviewed correction expressed as explicit CREATE OR REPLACE FUNCTION, never regex surgery. Proposed baseline installs the resulting040-equivalent schema only into a catalog-empty DB. Its manifest includes file hash, covered migration hashes and provenance. The runner must distinguish baseline provenance from legacy applied rows, validate both, and fail on any mismatch. Review this design before implementation; if rejected, require an explicit historical-file exception rather than silently skipping039.


- [ ] **Step 3: Capture the regression expectations**

```js
import assert from 'node:assert/strict';
function assertMigrationEquivalence({cleanProjectionDefinition, upgradedProjectionDefinition,
  legacyChecksumsAfterUpgrade, legacyChecksumsBeforeUpgrade, secondMigrationRunChangedSchema}) {
  assert.equal(cleanProjectionDefinition, upgradedProjectionDefinition);
  assert.deepEqual(legacyChecksumsAfterUpgrade, legacyChecksumsBeforeUpgrade);
  assert.equal(secondMigrationRunChangedSchema, false);
}
```
Call assertMigrationEquivalence with function definitions from pg_get_functiondef, ordered ledger ID/checksum arrays and before/after schema digests read by the existing proof. Its input property names are defined in the function above; none is a hardcoded success boolean. Add rejection cases: nonempty target, altered baseline hash, unknown legacy checksum and interrupted bootstrap.


- [ ] **Step 4: Implement the explicit baseline branch**

Implement one atomic empty-DB bootstrap transaction under the runner advisory lock; use the existing checksum validator for manifest-covered files. Keep role prerequisite before grants. Use a separate baseline ledger record, teach the migration and backup-ledger readers to recognize it, and apply041 to legacy DBs. Copy the complete reviewed projection definition into041; qualify schema, fixed search_path, owner and grants exactly as the existing boundary. No historical file changes. Review the SQL body and both ledger readers together.


- [ ] **Step 5: Prove both routes and the rerun**

```bash
node deploy/migrate.mjs
node deploy/migrate.mjs
node tests/acceptance/prove-database-upgrade.mjs
corepack pnpm --filter @handleplan/db exec vitest run src/migration-files.test.ts
```
Expected all pass using a clean database, restored legacy ledger and baseline path. Any mismatch blocks Task3.


- [ ] **Step 6: Commit the recovery unit**

```bash
git add deploy/migrate.mjs deploy/bootstrap deploy/migrations/041_public_offer_projection_repair.sql tests/acceptance/prove-database-upgrade.mjs packages/db/src/migration-files.test.ts docs/evidence/release-readiness/migration-recovery.md
git commit -m "fix: support verified fresh bootstrap and legacy projection upgrade"
```


**Review/exit:** No edits to022–040; no forged applied039 checksum; identical intended schema and read behavior after both paths.


### Task 3: Preserve exact authorization timestamp identity

**Depends on:** 2

**Files:**
- Modify/Test: `packages/domain/src/offer-ingestion-contracts.ts`, `offer-ingestion-contracts.test.ts`
- Modify/Test: `packages/db/src/official-offer-foundation.ts`, `official-offer-foundation.integration.test.ts`
- Modify/Test: `apps/worker/src/tjek-production.ts`, `tjek-production.test.ts`

**Interfaces:** Keep OfficialOfferAuthorizationFenceV1Schema and edition authorization names; extend only authorization timestamp representation to accept canonical UTC milliseconds or microseconds without loss. Capture/event timestamps retain their existing contract. SQL identity comparisons remain exact.


- [ ] **Step 1: Add a real precision regression**

```ts
const fence = {
  contractVersion: 1, permissionId: 7, sourceId: 'tjek', decision: 'approved',
  capabilities: ['capture', 'discover', 'extract'],
  rightsClassifications: ['public_display'],
  reviewedAt: '2026-08-21T16:04:05.780477Z',
  evaluatedAt: '2026-09-08T13:00:00.000Z'
};
expect(officialOfferAuthorizationFenceV1Schema.parse(fence).reviewedAt)
  .toBe('2026-08-21T16:04:05.780477Z');
```
Import the existing schema in its test. Add an integration case that changes the permission timestamp by one microsecond with the same millisecond prefix and must reject the stale fence.


- [ ] **Step 2: Run the red test**

```bash
corepack pnpm --filter @handleplan/domain exec vitest run src/offer-ingestion-contracts.test.ts
```
Expected current schema rejects precision6.


- [ ] **Step 3: Implement lossless authorization serialization**

```sql
to_char(permission.reviewed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reviewed_at_exact
```
The authorization-only representation can reuse Zod without a dependency:

```ts
const authorizationTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/u)
  .refine(value => {
    const milliseconds = value.slice(0, 23) + "Z";
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === milliseconds;
  });
const authorizationOrderKey = (value: string): string =>
  value.slice(0, 20) + value.slice(20, -1).padEnd(6, "0") + "Z";
```

Use authorizationOrderKey only after schema validation. Keep exact strings for SQL equality and normalize only comparisons; do not use this helper to rehash an existing publication. Add precision3 backward compatibility and reject >6digits, offsets, invalid dates and trailing text.

Select permission reviewed/expiry timestamps as exact strings in all authorization readers. Do not round-trip through JS Date. Add a local authorization-only Zod timestamp schema accepting exactly3or6 fractional digits with valid calendar semantics. For order comparisons use normalized six-digit UTC strings after validation, not Date.parse truncation. Update edition authorization too and enumerate every caller with rg. Never rewrite existing publication identity hashes.


- [ ] **Step 4: Prove temporal and revocation boundaries**

```bash
corepack pnpm --filter @handleplan/domain exec vitest run src/offer-ingestion-contracts.test.ts
corepack pnpm --filter @handleplan/db exec vitest run src/official-offer-foundation.integration.test.ts
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-production.test.ts
```
Disposable DB integration enabled. Include expiry at exact boundary, future review, leap-date invalidity, stale permission ID and revoke-during-capture.


- [ ] **Step 5: Commit the precise boundary**

```bash
git add packages/domain/src/offer-ingestion-contracts.ts packages/domain/src/offer-ingestion-contracts.test.ts packages/db/src/official-offer-foundation.ts packages/db/src/official-offer-foundation.integration.test.ts apps/worker/src/tjek-production.ts apps/worker/src/tjek-production.test.ts
git commit -m "fix: preserve exact authorization timestamps across ingestion"
```


**Review/exit:** The live microsecond-shaped fixture succeeds without changing its timestamp; a one-microsecond wrong fence fails.


### Task 4: Make foundation persistence work under the real worker role

**Depends on:** 3

**Files:**
- Create: `deploy/migrations/042_official_offer_worker_boundary.sql`
- Modify: `packages/db/src/official-offer-foundation.ts`, `deploy/migrate.mjs`
- Test: `apps/worker/src/tjek-production.integration.test.ts`, `packages/db/src/official-offer-foundation.integration.test.ts`, `tests/acceptance/prove-runtime-database-role.mjs`

**Interfaces:** Preserve recordEdition(input, authorization, signal), recordCapture(input, authorization, signal), recordExtraction(input, authorization, signal) and their existing receipts. Move privileged lock/transition operations behind source-fenced SQL functions; worker receives EXECUTE, not table UPDATE or review DML.


- [ ] **Step 1: Run the actual-role regression**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-production.integration.test.ts
```
With disposable app/admin URLs and integration flag, current failure is geographic_scopes permission denied. This test is the acceptance test, not an admin substitute.


- [ ] **Step 2: Add negative privilege assertions**

```sql
select has_table_privilege('handleplan_app','public.approved_offers','UPDATE') as may_approve,
       has_table_privilege('handleplan_app','public.review_actions','INSERT') as may_review,
       has_table_privilege('handleplan_app','public.geographic_scopes','UPDATE') as may_edit_scope;
```
Assert every result false after final role configuration. Add attempts to mutate another source, substitute a scope and reuse a stale fence; all must fail.


- [ ] **Step 3: Implement the narrow SQL boundary**

Use042 SECURITY DEFINER functions with fixed pg_catalog/pg_temp search_path, fully qualified tables, bounded versioned JSON inputs, REVOKE ALL FROM PUBLIC and EXECUTE only to handleplan_app. Port existing transaction assertions and source governance advisory locks together with the DML, preserving parameterized SQL. Do not split validation and mutation into different transactions. Return existing receipt fields; map SQL errors through existing repository errors. The repository method signatures above do not change. Review all three persistence methods because capture requires publication FOR UPDATE after the scope failure is fixed.


- [ ] **Step 4: Run worker, revocation and role proofs**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-production.integration.test.ts
corepack pnpm --filter @handleplan/db exec vitest run src/official-offer-foundation.integration.test.ts
node tests/acceptance/prove-runtime-database-role.mjs
```
Expected review candidate persisted once, same capture deduplicated, no approved offers, negatives denied, no leaked query after cancellation.


- [ ] **Step 5: Commit the boundary**

```bash
git add deploy/migrations/042_official_offer_worker_boundary.sql deploy/migrate.mjs packages/db/src/official-offer-foundation.ts apps/worker/src/tjek-production.integration.test.ts packages/db/src/official-offer-foundation.integration.test.ts tests/acceptance/prove-runtime-database-role.mjs
git commit -m "fix: expose least-privilege official-offer persistence boundary"
```


**Review/exit:** Real worker intake passes; admin-only tests cannot satisfy this gate.


### Task 5: Recover legacy partial editions without rewriting evidence

**Depends on:** 4

**Files:**
- Modify/Test: `apps/worker/src/tjek-production.ts`, `tjek-production.test.ts`, `tjek-production.integration.test.ts`
- Create: `docs/evidence/release-readiness/legacy-editions.md`
- Read: `packages/db/src/official-offer-foundation.ts`

**Interfaces:** Consumes legacy publications/captures and canonical edition identity; produces a per-edition disposition and explicit supported recovery behavior. Existing immutable identities and approved offers are not rewritten.


- [ ] **Step 1: Inventory exact conflicts**

Query source/external edition ID, canonical identity presence, discovery/capture/extraction state and counts. Report only nonprivate identifiers and counts. Classify exact complete replay, resumable partial capture, invalid legacy identity, expired edition and newer edition. Do not infer completion from publication existence.


- [ ] **Step 2: Add retry acceptance to the integration regression**

```ts
const first = await handler(context);
const second = await handler(context);
expect(first.counters?.persisted).toBe(1);
expect(second.counters?.persisted).toBe(0);
```
Use the existing handler/context fixture in tjek-production.integration.test.ts. Add a failure injected between capture and extraction; retry must create exactly one extraction. Add an incompatible legacy identity and assert explicit conflict.


- [ ] **Step 3: Implement only supported recovery**

Keep exact-byte completed capture replay. For partial records use existing idempotent repository calls. For incompatible immutable rows, document a separately reviewed superseding edition mechanism only if the source publishes a genuinely distinct revision; otherwise quarantine and use a future edition. Never invent an external revision ID to evade a uniqueness constraint.


- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-production.test.ts src/tjek-production.integration.test.ts
git add apps/worker/src/tjek-production.ts apps/worker/src/tjek-production.test.ts apps/worker/src/tjek-production.integration.test.ts docs/evidence/release-readiness/legacy-editions.md
git commit -m "fix: make legacy edition recovery explicit and idempotent"
```


**Review/exit:** Every existing partial publication has an honest disposition; new editions and retry tests work.


### Task 6: Reconcile source authority and declare measured coverage

**Depends on:** 1; measurement refreshed after each adapter

**Files:**
- Modify: `docs/data/source-registry.v1.json`, `docs/data/source-registry.md`, `docs/data/launch-coverage.v1.json`
- Create: `docs/evidence/release-readiness/source-authority.md`, `coverage.csv`
- Read: `packages/db/src/source-access.ts`, `docs/data/launch-coverage.v1.schema.json`

**Interfaces:** Consumes real authorization records and provider terms plus runtime source permissions; produces schema-valid source/chain/region/price-class declarations. DB approval alone is not an agreement, and stale July registry prose does not invalidate a newer legitimate approval.


- [ ] **Step 1: Compare runtime and repository claims**

For each active source collect permission ID, reviewed/expiry dates, capabilities and private reference to authorization. Match processing, retention, display, derived savings, artwork, attribution, store geography and API quotas. Never copy agreements containing secrets into Git. Record missing fields and the specific owner action. Do not contact anyone without authorization.


- [ ] **Step 2: Measure chain/region/price-class coverage**

Create coverage.csv with columns chain,region,price_class,current_products,stale_products,unknown_products,known_not_carried,oldest_current_observed_at,scope_proof,permission_id. Query actual catalogue+price+offer projections, distinguishing ordinary-price72h and catalogue48h defaults from each source-specific contract. A zero count stays zero; a flyer count does not become ordinary-price coverage.


- [ ] **Step 3: Update only supported declarations**

```bash
corepack pnpm validate:v1-data
```
Run before edits to establish current validity, then after registry/coverage edits. Use existing schema fields; mark a region selected only after its required chain/class cells are measured and authorized. Record all seven named chains; if a schema restricts the original3, extend its exact enums and validator tests in the same reviewed change.


- [ ] **Step 4: Commit truthful source declarations**

```bash
git add docs/data/source-registry.v1.json docs/data/source-registry.md docs/data/launch-coverage.v1.json docs/evidence/release-readiness/source-authority.md docs/evidence/release-readiness/coverage.csv
git commit -m "docs: reconcile source authority and measured release coverage"
```


**Review/exit:** Every release claim has current authority and measured scope; missing access remains an explicit blocked dependency.


### Task 7: Make ordinary-price ingestion sufficiently complete and current

**Depends on:** 4,6

**Files:**
- Modify/Test: `apps/worker/src/production.ts`, `production.test.ts`, `open-prices-handlers.ts`
- Modify/Test: `packages/db/src/worker-targets.ts`, `worker-targets.test.ts`
- Modify/Test: `packages/open-prices/src/normalizer.ts`, `normalizer.test.ts`
- Read: `packages/kassalapp/src/client.ts`, `apps/web/lib/server/price-service.ts`

**Interfaces:** Consumes approved source targets and provider evidence; produces current scoped ordinary-price observations and coverage checks through existing ingestion repository. Receipt prices without verified store mapping remain geographically unknown.


- [ ] **Step 1: Preserve demonstrated trust regressions**

```bash
corepack pnpm --filter @handleplan/open-prices exec vitest run src/normalizer.test.ts
corepack pnpm --filter @handleplan/worker exec vitest run src/production.test.ts
```
Assert discounted/unknown-discount receipts are quarantined and the Open Prices target provider never calls national-scope assignment. Reuse the existing regressions, not a duplicate suite.


- [ ] **Step 2: Reproduce refresh starvation with actual targets**

Record current target selection for each required chain. Add a worker-target test containing more eligible targets than one batch, current and stale records, and explicit source missing-supported-chain responses. Assert subsequent runs advance to unrefreshed evidence and unknown is not translated to known-not-carried.


- [ ] **Step 3: Implement the minimum target correction**

Change the shared worker-target query if coverage is caused by starvation; retain bounded pages, durable progress/oldest-first fairness and provider request budgets. If the provider does not have the chain, record upstream missing coverage and acquire another approved feed through Task6. Do not retry permanently missing records in a tight loop or fill prices from unrelated stores.


- [ ] **Step 4: Verify ordinary-price coverage through a full scheduled cycle**

```bash
corepack pnpm --filter @handleplan/db exec vitest run src/worker-targets.test.ts
corepack pnpm --filter @handleplan/worker typecheck
corepack pnpm --filter @handleplan/open-prices typecheck
```
In protected staging, compare two refresh cycles and source request budgets with coverage.csv. Empty chains remain release-blocking until supported evidence exists.


- [ ] **Step 5: Commit the ordinary-price correction**

```bash
git add apps/worker/src/production.ts apps/worker/src/production.test.ts apps/worker/src/open-prices-handlers.ts packages/db/src/worker-targets.ts packages/db/src/worker-targets.test.ts packages/open-prices/src/normalizer.ts packages/open-prices/src/normalizer.test.ts
git commit -m "fix: refresh ordinary-price coverage without inventing scope"
```


**Review/exit:** All declared ordinary-price cells are usable; selective promotional offers do not satisfy this task.


### Task 8: Complete Bunnpris and REMA structured intake

**Depends on:** 5,6

**Files:**
- Modify/Test: `packages/tjek/src/client.ts`, `client.test.ts`
- Modify/Test: `apps/worker/src/tjek-handlers.ts`, `tjek-handlers.test.ts`, `tjek-production.integration.test.ts`
- Create: `docs/evidence/release-readiness/tjek-live.md`

**Interfaces:** Consumes TjekClient.getOffersFromCatalog(catalog, signal) and createTjekFoundationDependencies(db, privateCaptureRoot); produces raw private captures and extracted review candidates via OfficialOfferFoundationPipeline.captureAndExtract.


- [ ] **Step 1: Run the retained parser and intake checks**

```bash
corepack pnpm --filter @handleplan/tjek exec vitest run
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-handlers.test.ts src/tjek-production.integration.test.ts
```
Bunnpris key comes only from runtime configuration. Assert failed requests, duplicate pages and malformed money fail; a short final paged response is complete even if advertised count differs.


- [ ] **Step 2: Capture one current catalogue per chain**

Use approved configuration and a bounded AbortSignal. Confirm credentialed Bunnpris RPC succeeds. For REMA use catalog-object dispatch to the paged endpoint, not the legacy string overload. Retain full raw conditions/currency/quantity and catalogue scope; publish only redacted counts in tjek-live.md.


- [ ] **Step 3: Make physical request governance complete**

If needed, extend the existing options (not a new client abstraction):

```ts
// Member added to existing TjekClientOptions.
authorizeRequestAttempt?: (signal?: AbortSignal) => Promise<void>;
```

At each existing physical fetch call, await that callback with the same signal before fetch. Its production closure invokes the persisted source-access policy for that operation and rejects missing/revoked capability. Test the callback count equals physical request count and revocation before request2 prevents request2.

Trace listCatalogs, each paged request and each Incito detail request. Recheck persisted approval before every physical attempt using the existing source policy. Preserve429 handling and abort; do not introduce hidden retries. If the current client cannot inject authorization per attempt, add an optional awaitable callback to TjekClientOptions and exercise it at the shared physical-request boundary.


- [ ] **Step 4: Distinguish review work from transport failure**

Use existing counters for fetched, persisted, quarantined and failed. Retain semantic uncertainty as review-required/degraded; do not erase EXTRACTOR_ANOMALY solely to achieve zero failures. Document the expected operational outcome and let monitoring distinguish review backlog from request/SQL failure.


- [ ] **Step 5: Verify retry and commit**

```bash
corepack pnpm --filter @handleplan/tjek exec vitest run
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-handlers.test.ts src/tjek-production.integration.test.ts
git add packages/tjek/src/client.ts packages/tjek/src/client.test.ts apps/worker/src/tjek-handlers.ts apps/worker/src/tjek-handlers.test.ts apps/worker/src/tjek-production.integration.test.ts docs/evidence/release-readiness/tjek-live.md
git commit -m "feat: verify governed Bunnpris and REMA catalogue intake"
```


**Review/exit:** Both current sources reach persisted review candidates under worker credentials; neither is claimed publicly approved yet.


### Task 9: Resolve Extra geography and ingest scoped offers

**Depends on:** 6,8

**Files:**
- Modify/Test: `apps/worker/src/tjek-production.ts`, `tjek-production.test.ts`, `tjek-production.integration.test.ts`
- Read: `deploy/migrations/017_geographic_directory_region_proof.sql`
- Create: `docs/evidence/release-readiness/extra-scope.md`

**Interfaces:** Consumes current Extra catalogue plus source-backed store/region membership; produces OfficialOfferEditionDiscoveryInputV1 with a proven declaredGeographicScope and matching stored scope. all_stores:false and null store_id never imply national.


- [ ] **Step 1: Keep the current rejection regression**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-production.test.ts
```
Confirm the all_stores:false catalogue remains rejected without positive scope evidence.


- [ ] **Step 2: Resolve the catalogue-to-store mapping**

Inspect authorized retailer/store-specific catalogue discovery for the chosen geography. Record exact external edition ID and store directory identities, boundary dates and source reference. If no positive mapping exists, Extra stays blocked; do not hardcode nationwide scope or infer it from postcode alone.


- [ ] **Step 3: Add matched and wrong-region cases**

Extend the existing resolveEdition fixture with a proven stored regional/store-set scope. Assert exact matching stores accepted, one unproven store rejected, expired directory proof rejected and conflicting legacy scope rejected. Persist scope through existing reviewed geography workflow, not a source-supplied numeric DB ID.


- [ ] **Step 4: Implement and verify the scoped branch**

Keep the national all_stores+Norway proof branch. Add a reviewed mapping lookup keyed by source and external edition identity for nonnational catalogues, validate against active scope membership, and return the existing edition schema.
```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/tjek-production.test.ts src/tjek-production.integration.test.ts
```


- [ ] **Step 5: Commit Extra scope support**

```bash
git add apps/worker/src/tjek-production.ts apps/worker/src/tjek-production.test.ts apps/worker/src/tjek-production.integration.test.ts docs/evidence/release-readiness/extra-scope.md
git commit -m "feat: ingest Extra offers only with verified geographic scope"
```


**Review/exit:** Extra offers reach review with defensible store coverage; outside-scope discovery/planning excludes them.


### Task 10: Qualify and implement MENY offer delivery

**Depends on:** 4,6; can qualify independently of8–9

**Files:**
- Create: `docs/evidence/release-readiness/meny-source.md`
- Create after qualification: `docs/superpowers/plans/2026-09-08-meny-offer-adapter.md`
- Create after qualification: `apps/worker/src/meny-offers.ts`, `meny-offers.test.ts`
- Modify when adapter verified: `apps/worker/src/production.ts`, `bootstrap.ts`

**Interfaces:** Consumes the source-authority decision and protected raw capture. Produces candidates conforming to existing extractedOfficialOfferCandidateV1Schema and an existing foundation structured/embedded-text extractor port. No alternative publication or review interface.


- [ ] **Step 1: Discover one authorized current edition**

Read `https://meny.no/api/kundeavis?postCode=7011` with one bounded request after approval. Follow only the returned official destination; preserve status and timestamp. The observed destination uses iPaper. Inspect its actual enrichment data; viewer-language defaults are not offer currency. Do not assume postcode7011 defines the whole launch region.


- [ ] **Step 2: Create a concrete source contract**

Retain approved private payload bytes and checksum. In the redacted source note enumerate exact JSON paths or PDF page/text anchors for name, offer price, before price, quantity, currency, validity, scope, member/multibuy/channel conditions and image rights. For each missing field write the actual rejection/review reason. Capture at least one ordinary unit offer, one conditional/ambiguous offer and one invalid/expired input. If the source cannot provide these, this task remains blocked rather than claiming an implemented feed.


- [ ] **Step 3: Write and review the source-specific implementation plan**

Write `docs/superpowers/plans/2026-09-08-meny-offer-adapter.md` using writing-plans once the actual payload is known. Include byte-derived red/green fixtures, complete extractor code for the observed paths, the existing foundation port type, request cap/timeout, approved rights, explicit failures and scoped geographic resolver. The parser cannot be safely specified before this observation; this deliverable is a mandatory design gate, not an omitted implementation task.


- [ ] **Step 4: Execute the verified source plan**

Run its fixture regression red, implement the smallest extractor in the named file and connect only the existing foundation pipeline. Never fabricate exact IDs or treat marketing before-prices as verified savings. Keep uncertain fields as review evidence and refuse invalid monetary values.


- [ ] **Step 5: Run source and real-role acceptance**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/meny-offers.test.ts
corepack pnpm --filter @handleplan/worker typecheck
```
Then capture the current edition in protected staging under worker credentials, review a representative offer and prove public inclusion/exclusion by scope. Repeat after a changed or expired edition. Human-approved fixtures stay private when reuse rights do not permit committing them.


- [ ] **Step 6: Commit the independently working adapter**

```bash
git add apps/worker/src/meny-offers.ts apps/worker/src/meny-offers.test.ts apps/worker/src/production.ts apps/worker/src/bootstrap.ts docs/evidence/release-readiness/meny-source.md docs/superpowers/plans/2026-09-08-meny-offer-adapter.md
git commit -m "feat: add governed MENY offer intake"
```


**Review/exit:** MENY has real authorized capture, tested extraction, review and scoped publication proof; otherwise all-seven-chain release stays blocked.


### Task 11: Qualify and implement SPAR offer delivery

**Depends on:** 4,6; can qualify independently of8–9

**Files:**
- Create: `docs/evidence/release-readiness/spar-source.md`
- Create after qualification: `docs/superpowers/plans/2026-09-08-spar-offer-adapter.md`
- Create after qualification: `apps/worker/src/spar-offers.ts`, `spar-offers.test.ts`
- Modify when adapter verified: `apps/worker/src/production.ts`, `bootstrap.ts`

**Interfaces:** Consumes the source-authority decision and protected raw capture. Produces candidates conforming to existing extractedOfficialOfferCandidateV1Schema and an existing foundation structured/embedded-text extractor port. No alternative publication or review interface.


- [ ] **Step 1: Discover one authorized current edition**

Read `https://spar.no/api/kundeavis?postCode=7011` with one bounded request after approval. Follow only the returned official destination; preserve status and timestamp. The observed destination is a PDF. Use embedded text first; OCR requires explicit source capability and reviewed evidence. Do not assume postcode7011 defines the whole launch region.


- [ ] **Step 2: Create a concrete source contract**

Retain approved private payload bytes and checksum. In the redacted source note enumerate exact JSON paths or PDF page/text anchors for name, offer price, before price, quantity, currency, validity, scope, member/multibuy/channel conditions and image rights. For each missing field write the actual rejection/review reason. Capture at least one ordinary unit offer, one conditional/ambiguous offer and one invalid/expired input. If the source cannot provide these, this task remains blocked rather than claiming an implemented feed.


- [ ] **Step 3: Write and review the source-specific implementation plan**

Write `docs/superpowers/plans/2026-09-08-spar-offer-adapter.md` using writing-plans once the actual payload is known. Include byte-derived red/green fixtures, complete extractor code for the observed paths, the existing foundation port type, request cap/timeout, approved rights, explicit failures and scoped geographic resolver. The parser cannot be safely specified before this observation; this deliverable is a mandatory design gate, not an omitted implementation task.


- [ ] **Step 4: Execute the verified source plan**

Run its fixture regression red, implement the smallest extractor in the named file and connect only the existing foundation pipeline. Never fabricate exact IDs or treat marketing before-prices as verified savings. Keep uncertain fields as review evidence and refuse invalid monetary values.


- [ ] **Step 5: Run source and real-role acceptance**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/spar-offers.test.ts
corepack pnpm --filter @handleplan/worker typecheck
```
Then capture the current edition in protected staging under worker credentials, review a representative offer and prove public inclusion/exclusion by scope. Repeat after a changed or expired edition. Human-approved fixtures stay private when reuse rights do not permit committing them.


- [ ] **Step 6: Commit the independently working adapter**

```bash
git add apps/worker/src/spar-offers.ts apps/worker/src/spar-offers.test.ts apps/worker/src/production.ts apps/worker/src/bootstrap.ts docs/evidence/release-readiness/spar-source.md docs/superpowers/plans/2026-09-08-spar-offer-adapter.md
git commit -m "feat: add governed SPAR offer intake"
```


**Review/exit:** SPAR has real authorized capture, tested extraction, review and scoped publication proof; otherwise all-seven-chain release stays blocked.


### Task 12: Qualify and implement Joker offer delivery

**Depends on:** 4,6; can qualify independently of8–9

**Files:**
- Create: `docs/evidence/release-readiness/joker-source.md`
- Create after qualification: `docs/superpowers/plans/2026-09-08-joker-offer-adapter.md`
- Create after qualification: `apps/worker/src/joker-offers.ts`, `joker-offers.test.ts`
- Modify when adapter verified: `apps/worker/src/production.ts`, `bootstrap.ts`

**Interfaces:** Consumes the source-authority decision and protected raw capture. Produces candidates conforming to existing extractedOfficialOfferCandidateV1Schema and an existing foundation structured/embedded-text extractor port. No alternative publication or review interface.


- [ ] **Step 1: Discover one authorized current edition**

Read `https://joker.no/api/kundeavis?postCode=7011` with one bounded request after approval. Follow only the returned official destination; preserve status and timestamp. The observed destination returned403. Stop on access denial; obtain an authorized feed or permitted alternative. Do not route around the denial. Do not assume postcode7011 defines the whole launch region.


- [ ] **Step 2: Create a concrete source contract**

Retain approved private payload bytes and checksum. In the redacted source note enumerate exact JSON paths or PDF page/text anchors for name, offer price, before price, quantity, currency, validity, scope, member/multibuy/channel conditions and image rights. For each missing field write the actual rejection/review reason. Capture at least one ordinary unit offer, one conditional/ambiguous offer and one invalid/expired input. If the source cannot provide these, this task remains blocked rather than claiming an implemented feed.


- [ ] **Step 3: Write and review the source-specific implementation plan**

Write `docs/superpowers/plans/2026-09-08-joker-offer-adapter.md` using writing-plans once the actual payload is known. Include byte-derived red/green fixtures, complete extractor code for the observed paths, the existing foundation port type, request cap/timeout, approved rights, explicit failures and scoped geographic resolver. The parser cannot be safely specified before this observation; this deliverable is a mandatory design gate, not an omitted implementation task.


- [ ] **Step 4: Execute the verified source plan**

Run its fixture regression red, implement the smallest extractor in the named file and connect only the existing foundation pipeline. Never fabricate exact IDs or treat marketing before-prices as verified savings. Keep uncertain fields as review evidence and refuse invalid monetary values.


- [ ] **Step 5: Run source and real-role acceptance**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/joker-offers.test.ts
corepack pnpm --filter @handleplan/worker typecheck
```
Then capture the current edition in protected staging under worker credentials, review a representative offer and prove public inclusion/exclusion by scope. Repeat after a changed or expired edition. Human-approved fixtures stay private when reuse rights do not permit committing them.


- [ ] **Step 6: Commit the independently working adapter**

```bash
git add apps/worker/src/joker-offers.ts apps/worker/src/joker-offers.test.ts apps/worker/src/production.ts apps/worker/src/bootstrap.ts docs/evidence/release-readiness/joker-source.md docs/superpowers/plans/2026-09-08-joker-offer-adapter.md
git commit -m "feat: add governed Joker offer intake"
```


**Review/exit:** Joker has real authorized capture, tested extraction, review and scoped publication proof; otherwise all-seven-chain release stays blocked.


### Task 13: Qualify and implement Europris offer delivery

**Depends on:** 4,6; can qualify independently of8–9

**Files:**
- Create: `docs/evidence/release-readiness/europris-source.md`
- Create after qualification: `docs/superpowers/plans/2026-09-08-europris-offer-adapter.md`
- Create after qualification: `apps/worker/src/europris-offers.ts`, `europris-offers.test.ts`
- Modify when adapter verified: `apps/worker/src/production.ts`, `bootstrap.ts`

**Interfaces:** Consumes the source-authority decision and protected raw capture. Produces candidates conforming to existing extractedOfficialOfferCandidateV1Schema and an existing foundation structured/embedded-text extractor port. No alternative publication or review interface.


- [ ] **Step 1: Discover one authorized current edition**

Read `https://www.europris.no/kundeavis` with one bounded request after approval. Follow only the returned official destination; preserve status and timestamp. The observed viewer is Zmags. Identify an actual structured offer/enrichment payload or obtain an approved feed; publication metadata alone is insufficient. Do not assume postcode7011 defines the whole launch region.


- [ ] **Step 2: Create a concrete source contract**

Retain approved private payload bytes and checksum. In the redacted source note enumerate exact JSON paths or PDF page/text anchors for name, offer price, before price, quantity, currency, validity, scope, member/multibuy/channel conditions and image rights. For each missing field write the actual rejection/review reason. Capture at least one ordinary unit offer, one conditional/ambiguous offer and one invalid/expired input. If the source cannot provide these, this task remains blocked rather than claiming an implemented feed.


- [ ] **Step 3: Write and review the source-specific implementation plan**

Write `docs/superpowers/plans/2026-09-08-europris-offer-adapter.md` using writing-plans once the actual payload is known. Include byte-derived red/green fixtures, complete extractor code for the observed paths, the existing foundation port type, request cap/timeout, approved rights, explicit failures and scoped geographic resolver. The parser cannot be safely specified before this observation; this deliverable is a mandatory design gate, not an omitted implementation task.


- [ ] **Step 4: Execute the verified source plan**

Run its fixture regression red, implement the smallest extractor in the named file and connect only the existing foundation pipeline. Never fabricate exact IDs or treat marketing before-prices as verified savings. Keep uncertain fields as review evidence and refuse invalid monetary values.


- [ ] **Step 5: Run source and real-role acceptance**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/europris-offers.test.ts
corepack pnpm --filter @handleplan/worker typecheck
```
Then capture the current edition in protected staging under worker credentials, review a representative offer and prove public inclusion/exclusion by scope. Repeat after a changed or expired edition. Human-approved fixtures stay private when reuse rights do not permit committing them.


- [ ] **Step 6: Commit the independently working adapter**

```bash
git add apps/worker/src/europris-offers.ts apps/worker/src/europris-offers.test.ts apps/worker/src/production.ts apps/worker/src/bootstrap.ts docs/evidence/release-readiness/europris-source.md docs/superpowers/plans/2026-09-08-europris-offer-adapter.md
git commit -m "feat: add governed Europris offer intake"
```


**Review/exit:** Europris has real authorized capture, tested extraction, review and scoped publication proof; otherwise all-seven-chain release stays blocked.


### Task 14: Complete review evidence, product identity and commercial conditions

**Depends on:** 8–13 for each source;4

**Files:**
- Modify/Test: `apps/web/lib/server/review-evidence-reader.ts`, `review-evidence-reader.test.ts`, `review-evidence-service.ts`, `review-evidence-service.test.ts`
- Modify/Test: `apps/worker/src/tjek-handlers.ts`, `tjek-handlers.test.ts`
- Read/Test: `packages/db/src/review-queue.ts`, `packages/domain/src/review-contracts.test.ts`
- Modify: `docs/runbooks/private-review.md`

**Interfaces:** Consumes private raw captures and candidate schema; produces explicit reviewed decisions through PostgresReviewQueueRepository.decide and the protected review service. No worker-generated review identities.


- [ ] **Step 1: Test an actual captured evidence format**

Current evidence renderer is image-bound. Add a regression for a structured JSON capture: rendering it must either produce a source-faithful authorized image for the existing renderer boundary or fail with an explicit unsupported state. Never pass JSON bytes as an image. Test unsupported mime type, mismatched checksum and stale review proof.


- [ ] **Step 2: Implement one source-faithful review path**

Reuse the existing evidence renderer and proof binding. For structured feeds, render source fields/conditions and locator into a private deterministic image if the approved source rights allow it; bind capture checksum and renderer version. For PDF, preserve page and crop identity. Show all conditions needed to make the decision, not only the numeric price.


- [ ] **Step 3: Review identity and money semantics**

Review exact product/GTIN or supported reviewed-family match, package and variant, integer øre, NOK, store/channel, member program, bundle/minimum quantities and dates. Require source evidence for before-price comparisons; if absent display offer price without a savings percentage. Add per-condition regression to the existing candidate/decision tests before implementing mappings. Preserve raw evidence for each decision.


- [ ] **Step 4: Verify reviewers can complete the workflow**

```bash
corepack pnpm --filter web exec vitest run lib/server/review-evidence-reader.test.ts lib/server/review-evidence-service.test.ts
corepack pnpm --filter @handleplan/domain exec vitest run src/review-contracts.test.ts
corepack pnpm --filter @handleplan/db exec vitest run src/official-offer-publication-vertical.integration.test.ts
```
Perform one protected UI review per enabled source. Record who owns the recurring queue and measure backlog/age; no blanket auto-approval.


- [ ] **Step 5: Commit usable review evidence**

```bash
git add apps/web/lib/server/review-evidence-reader.ts apps/web/lib/server/review-evidence-reader.test.ts apps/web/lib/server/review-evidence-service.ts apps/web/lib/server/review-evidence-service.test.ts apps/worker/src/tjek-handlers.ts apps/worker/src/tjek-handlers.test.ts docs/runbooks/private-review.md
git commit -m "feat: support source-faithful review of captured offers"
```


**Review/exit:** A reviewer can see and approve the actual commercial proposition, with no invented product or eligibility facts.


### Task 15: Activate and observe the full offer lifecycle

**Depends on:** 14

**Files:**
- Modify/Test: `apps/worker/src/official-offer-lifecycle.ts`, `official-offer-lifecycle.test.ts`, `bootstrap.ts`
- Test: `packages/db/src/official-offer-lifecycle.integration.test.ts`, `official-offer-publication-vertical.integration.test.ts`
- Modify: `docs/runbooks/official-offer-foundation.md`, `docs/runbooks/internal-operations-dashboard.md`

**Interfaces:** Consumes reviewed offers and OfficialOfferLifecycleJobExecutor.execute; produces authoritative SQL receipts and public projection changes. DB policy remains independently controlled; no parallel generic ledger for lifecycle.


- [ ] **Step 1: Run the dedicated lifecycle checks**

```bash
corepack pnpm --filter @handleplan/worker exec vitest run src/official-offer-lifecycle.test.ts
corepack pnpm --filter @handleplan/db exec vitest run src/official-offer-lifecycle.integration.test.ts src/official-offer-publication-vertical.integration.test.ts
```
Use actual worker role. Cover lease conflict, replay, restart,30s abort, exact expiry and permission revocation.


- [ ] **Step 2: Verify scheduling is not starved**

Measure a maximum ingestion cycle before lifecycle execution. If a long cycle exceeds expiry SLA, schedule the dedicated executor independently using the existing supervisor pattern; preserve its SQL lease/accounting. Do not claim15-minute expiry if it actually waits behind a50-minute catalogue cycle.


- [ ] **Step 3: Enable only the reviewed staging scope**

Use the existing publication-policy operator boundary after rights/review evidence exists; record the exact actor/time/policy transition. Read public_offer_backed_discovery_rows_v1 through the application, then advance a disposable clock fixture or await a real expiry. Never update approved_offers directly.


- [ ] **Step 4: Observe two refreshes and one validity boundary**

Check current public result, source revocation removal, stale-data removal and expiry; verify no duplicate publication on replay. Transport/SQL failures must be visible separately from expected review backlog. Record timing against source freshness and alert thresholds.


- [ ] **Step 5: Commit scheduling fixes and evidence**

```bash
git add apps/worker/src/official-offer-lifecycle.ts apps/worker/src/official-offer-lifecycle.test.ts apps/worker/src/bootstrap.ts docs/runbooks/official-offer-foundation.md docs/runbooks/internal-operations-dashboard.md
git commit -m "fix: verify offer publication expiry and revocation scheduling"
```


**Review/exit:** Publication and withdrawal work through normal runtime paths within documented SLA.


### Task 16: Close the discovery-to-planner identity and completeness gap

**Depends on:** 7,15

**Files:**
- Modify/Test: `packages/db/src/public-catalog-index-reader.ts`, `public-catalog-index-reader.test.ts`
- Modify/Test: `apps/web/lib/server/discovery-service.ts`, `discovery-service.test.ts`, `price-service.ts`, `price-service.test.ts`, `plan-service.ts`, `plan-service.test.ts`
- Test: `packages/domain/src/planner-v2.test.ts`

**Interfaces:** Consumes public reviewed offers/current ordinary prices; produces consistent discovery and plan eligibility. Preserve generic checksum validation; an explicit internal canonical-product path is required for any reviewed nonstandard identifier.


- [ ] **Step 1: Run the known discovery regression**

```bash
corepack pnpm --filter @handleplan/db exec vitest run src/public-catalog-index-reader.test.ts
corepack pnpm --filter web exec vitest run lib/server/discovery-service.test.ts lib/server/price-service.test.ts lib/server/plan-service.test.ts
```
Retain50/51 sentinel, duplicate merge, bigint strings, null-category rules and cursor cases.


- [ ] **Step 2: Add a reviewed identifier end-to-end case**

Use shape-valid/checksum-invalid7048860110511 only in an approved synthetic reviewed-offer fixture. Assert generic product input still rejects it. Choose an explicit canonical product identifier in the add-to-list/plan request, resolve it through the reviewed evidence boundary, and assert the selected offer remains eligible only for that exact product. If no safe canonical mapping exists, the UI must explain that it cannot be planned and cannot count it as complete release coverage.


- [ ] **Step 3: Verify all exposed chain filters in the browser**

For each named chain and FUDI/Holdbart/Havaristen/FastCandy/Engrossnett/Oda filters, record exact request,200/error state, count, first item and next cursor. Use `/api/discovery/search?market=national&chain=bunnpris&type=all&pageSize=8` and `q` for search. Category, regional/store selection and expired offers each need positive and negative cases. No frontend success claim from mocked data.


- [ ] **Step 4: Implement only the shared failing boundary**

Fix reader/service identity resolution once rather than adding card-specific bypasses. Make unavailable and partial coverage visible and prevent an incomplete basket from claiming a complete cheapest result. Keep conditional/member prices labelled and use the same eligibility decision in discovery and planning.


- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm --filter @handleplan/db exec vitest run src/public-catalog-index-reader.test.ts
corepack pnpm --filter web exec vitest run lib/server/discovery-service.test.ts lib/server/price-service.test.ts lib/server/plan-service.test.ts
corepack pnpm --filter @handleplan/domain exec vitest run src/planner-v2.test.ts
git add packages/db/src/public-catalog-index-reader.ts packages/db/src/public-catalog-index-reader.test.ts apps/web/lib/server/discovery-service.ts apps/web/lib/server/discovery-service.test.ts apps/web/lib/server/price-service.ts apps/web/lib/server/price-service.test.ts apps/web/lib/server/plan-service.ts apps/web/lib/server/plan-service.test.ts packages/domain/src/planner-v2.test.ts
git commit -m "fix: align reviewed discovery products with planning eligibility"
```


**Review/exit:** Each publicly plannable offer survives add-to-list and calculation without weakening generic GTIN checks.


### Task 17: Execute the real basket corpus and seven-chain acceptance

**Depends on:** 16,6 coverage complete

**Files:**
- Modify evidence inputs: `docs/data/benchmark-baskets.v1.json`, `docs/data/launch-coverage.v1.json`
- Read/Test: `tests/acceptance/v1-basket-runner.mjs`, `v1-basket-oracle-v2.mjs`, `v1-basket-runner.test.mjs`, `check-v1-baskets.mjs`
- Create: `docs/evidence/release-readiness/basket-reconciliation.md`, `basket-candidate.json`, `basket-runner-attestation.json`, `basket-report.json` (private evidence excluded from Git when required)

**Interfaces:** Consumes current authorized prices/offers/stores/reviewed identities; produces existing V2 candidate and runner-attestation artifacts with real measurements. Retain independent oracle; candidate code must not self-certify its answer.


- [ ] **Step 1: Retain the blocked baseline**

```bash
corepack pnpm acceptance:v1-baskets:check
```
Current expected exit2,60pending. Do not treat that as test failure to suppress or replace with synthetic pass.


- [ ] **Step 2: Build the real candidate input under existing schemas**

Bind exact corpus/source/coverage hashes and store/product evidence. Use20basket scenarios across the current3regions:60runs. Include all seven chains in the coverage contract and supplement the original three-chain corpus so each added chain is exercised in selection, ordinary price and discount application. If extending the bounded oracle store/option limits is unnecessary, use separate at-most3-store scenarios rather than unbounded enumeration.


- [ ] **Step 3: Execute independent arithmetic and negative controls**

```bash
corepack pnpm acceptance:v1-baskets:test
node tests/acceptance/check-v1-baskets.mjs --candidate docs/evidence/release-readiness/basket-candidate.json --runner-attestation docs/evidence/release-readiness/basket-runner-attestation.json --output docs/evidence/release-readiness/basket-report.json
```
Step2 creates basket-candidate.json and basket-runner-attestation.json under docs/evidence/release-readiness/ using the existing V2 schemas. The output file must not already exist; preserve each run under a distinct evidence directory rather than overwriting it. Do not commit private source payloads embedded in an artifact. Check package rounding, variable weight, deposits, multibuy remainder, exact member-program isolation, missing coverage, stale price, wrong region, revoked source and expired offer.


- [ ] **Step 4: Manually reconcile five baskets per declared region**

Review at least5perregion to the exact source captures, checkout arithmetic, dates and conditions. Record reviewer/time and discrepancies. A discrepancy gets a red regression in the existing planner/runner suite, a minimal fix and rerun of affected scenarios; no changed expected total without source evidence.


- [ ] **Step 5: Record acceptance and commit evidence**

Require all expected runs passed, zero pending/failed, exact seven-chain scope and price-only p95<=2500ms under the current contract. Store sensitive receipts privately and commit only hashes/redacted reconciliations.
```bash
git add docs/data/benchmark-baskets.v1.json docs/data/launch-coverage.v1.json docs/evidence/release-readiness/basket-reconciliation.md
git commit -m "test: retain real-source basket acceptance and reconciliation"
```


**Review/exit:** A complete grocery list is proven correct; one visible item per chain is insufficient.


### Task 18: Verify mobile offline shopping and accessibility

**Depends on:** 17

**Files:**
- Test: `tests/e2e/v1-accessibility.spec.ts`, `tests/e2e/planlegg.spec.ts`, `apps/web/tests/handlemodus/offline-trip.spec.ts`
- Modify only demonstrated failures: `apps/web/lib/handle-mode-offline-readiness.ts`, `apps/web/components/oppdag/discovery-workspace.tsx`
- Create: `docs/evidence/release-readiness/device-accessibility.md`

**Interfaces:** Consumes real accepted plan and immutable trip snapshot; produces exact-candidate browser and physical-device reports. Do not cache private API responses or introduce background location storage.


- [ ] **Step 1: Run automated browser journeys**

```bash
corepack pnpm exec playwright test tests/e2e/v1-accessibility.spec.ts tests/e2e/planlegg.spec.ts
corepack pnpm e2e:handlemodus
```
Use the configured production harness, not a development server with substituted source claims.


- [ ] **Step 2: Test physical iOS and Android trips**

Install PWA; create a real plan online; enter shopping mode; disable network; reload; check/uncheck items; close/reopen; reconnect. Confirm progress, stale/evicted snapshot message, touch target usability and no silent price freshness claim while offline. Record device/OS/browser/build and actual results.


- [ ] **Step 3: Test accessible completion**

Complete browse→list→plan→shopping via keyboard only and VoiceOver, native zoom and narrow viewport. Confirm labels and errors for empty/partial chains, member eligibility and changing totals. Any failure gets its smallest regression in existing suites before a UI fix.


- [ ] **Step 4: Commit fixes with device evidence**

```bash
git add tests/e2e/v1-accessibility.spec.ts tests/e2e/planlegg.spec.ts apps/web/tests/handlemodus/offline-trip.spec.ts apps/web/lib/handle-mode-offline-readiness.ts apps/web/components/oppdag/discovery-workspace.tsx docs/evidence/release-readiness/device-accessibility.md
git commit -m "test: verify accessible offline shopping on release devices"
```


**Review/exit:** Actual physical-device and assistive-technology reports exist; missing reviewer/device remains an external gate.


### Task 19: Verify travel scope and location privacy

**Depends on:** 17; can overlap18

**Files:**
- Read/Test: `apps/web/lib/server/travel/kartverket-geocoder.ts`, `kartverket-geocoder.test.ts`, `valhalla-route-matrix-gateway.ts`, `valhalla-route-matrix-gateway.test.ts`, `travel-plan-service.production.test.ts`
- Modify: `docs/privacy/personvern.md`
- Create: `docs/evidence/release-readiness/travel-privacy.md`

**Interfaces:** Consumes optional location consent and existing ephemeral location tokens; produces route-aware totals only when live route service and privacy requirements pass. Disabled travel must remain clearly disabled.


- [ ] **Step 1: Run current travel tests**

```bash
corepack pnpm --filter web exec vitest run lib/server/travel/kartverket-geocoder.test.ts lib/server/travel/valhalla-route-matrix-gateway.test.ts lib/server/travel/travel-plan-service.production.test.ts
```


- [ ] **Step 2: Verify a live consented route**

Use nonpersonal test coordinates, opt-in flow and the actual self-hosted Valhalla endpoint. Check distance/time route applicability, unavailable routing fallback and budgeted latency. Inspect application/edge/provider logs with unique nonpersonal sentinels; confirm no persistent addresses or tokens in URL/cache/analytics.


- [ ] **Step 3: Reconcile enabled behavior and privacy copy**

If travel cannot pass, obtain explicit release scope agreement to keep it disabled and make the UI/pricing claims match. Do not advertise savings after travel costs when no route has been measured. Record Kartverket usage/retention and route-log settings in evidence.


- [ ] **Step 4: Commit verified behavior and evidence**

```bash
git add docs/privacy/personvern.md docs/evidence/release-readiness/travel-privacy.md
git commit -m "docs: retain live travel and location privacy acceptance"
```


**Review/exit:** Every enabled travel claim has live route and telemetry proof; no hidden location persistence.


### Task 20: Make coverage and source failures observable to users and operators

**Depends on:** 15,16

**Files:**
- Read/Modify: `docs/runbooks/public-source-status.md`, `docs/runbooks/internal-operations-dashboard.md`, `docs/runbooks/worker.md`
- Read/Test: `apps/worker/src/health.ts`, `apps/worker/src/health.test.ts`
- Create: `docs/evidence/release-readiness/refresh-observation.md`

**Interfaces:** Consumes source status, actual worker result counters and lifecycle receipts; produces truthful public status and operational alert signals, without mixing review backlog with successful price publication.


- [ ] **Step 1: Record a controlled failure matrix**

In disposable staging exercise source disabled,429,timeout,SQL failure,partial extraction,review backlog,empty source,stale data and expired offer. Compare API/UI status and job counters for each. Expected: no misleading current/complete claim; SQL/transport errors visible.


- [ ] **Step 2: Run monitor contracts**

```bash
corepack pnpm operations:monitor:test
corepack pnpm --filter @handleplan/worker exec vitest run src/health.test.ts
```


- [ ] **Step 3: Repair only misleading transitions**

Use existing health and operations projection mechanisms; no second monitoring database. Source request failures must increment failed accounting, and normal review work must identify pending review explicitly. Specify and verify thresholds for stale ordinary prices, overdue catalogue capture and expiry scheduling.


- [ ] **Step 4: Commit observed refresh evidence**

```bash
git add docs/runbooks/public-source-status.md docs/runbooks/internal-operations-dashboard.md docs/runbooks/worker.md docs/evidence/release-readiness/refresh-observation.md
git commit -m "docs: verify price refresh and failure observability"
```


**Review/exit:** A healthy container cannot conceal a dead importer or expired public offer.


### Task 21: Prove recovery, alert delivery and operator readiness

**Depends on:** 2,20

**Files:**
- Read/Modify: `deploy/backup/README.md`, `docs/runbooks/offhost-backup-restore.md`, `docs/runbooks/explicit-image-rollback.md`, `docs/runbooks/external-public-monitoring.md`
- Read/Test: `deploy/backup/create-backup.mjs`, `verify-restore.mjs`, `tests/operations/backup-tooling.test.mjs`, `private-capture-archive.test.mjs`
- Create: `docs/evidence/release-readiness/operations.md`

**Interfaces:** Consumes exact candidate schema/private captures and protected operator configuration; produces authenticated off-host backup, clean restore, rollback and delivered test-alert evidence.


- [ ] **Step 1: Run operational checks**

```bash
corepack pnpm operations:backup:test
corepack pnpm operations:image:test
corepack pnpm operations:monitor:test
```


- [ ] **Step 2: Provision missing off-host boundaries**

Existing backup tooling has no bundled upload/download adapter. Select the approved operator provider and implement its exact create-only upload/authenticated-download contracts documented in deploy/backup/README.md. Require immutable object creation under concurrent attempts, manifest-last publication, authenticated origin and separate restore credentials. Write a provider-specific plan from its actual API before implementation; no rclone overwrite semantics disguised as immutable storage.


- [ ] **Step 3: Perform the clean restore drill**

Create encrypted DB+private-capture backup with a single bound snapshot; restore into the guarded clean drill target through existing toolkit. Verify ledger/baseline provenance fromTask2, representative captures/read projections, application startup and measured RPO/RTO. Never restore over production. Remove only the owned disposable target after evidence is retained.


- [ ] **Step 4: Test actual alert delivery and rollback**

Use the designated operator test destination with explicit sending authorization. Trigger one controlled failure, prove delivery and recovery, record latency. Drill exact-image rollback against staging with the documented source-disabled safeguards; verify it cannot resurrect unauthorized worker access.


- [ ] **Step 5: Commit operator evidence**

```bash
git add deploy/backup/README.md docs/runbooks/offhost-backup-restore.md docs/runbooks/explicit-image-rollback.md docs/runbooks/external-public-monitoring.md docs/evidence/release-readiness/operations.md
git commit -m "docs: prove backup restore rollback and alert delivery"
```


**Review/exit:** Real restored system and delivered alerts are proven; passing toolkit tests alone does not complete operations.


### Task 22: Close security, legal and public-governance release gates

**Depends on:** 6,18–21

**Files:**
- Read/Modify: `docs/release/v1-release-gates.md`, `docs/privacy/personvern.md`, `docs/security/supply-chain.md`, `docs/governance/public-good-governance.md`, `docs/data/source-registry.md`
- Create: `docs/evidence/release-readiness/security-governance.md`

**Interfaces:** Consumes current authority, operator and infrastructure facts; produces reviewed G1/G6/G9/G12 evidence without treating old documentation as current truth.


- [ ] **Step 1: Run repository supply-chain checks**

```bash
corepack pnpm security:audit
corepack pnpm security:licenses
corepack pnpm security:secrets
corepack pnpm security:scripts:test
```


- [ ] **Step 2: Inspect final shipment and prior key exposure**

Run the configured image/history scans on the exact candidate. Confirm no runtime source keys in image layers or handoffs. Classify the previously committed Tjek key with the source owner; rotate/revoke if it grants nonpublic authority, without printing it. A clean working-tree secret scan does not erase Git history.


- [ ] **Step 3: Complete real operator facts**

Verify named operator/data controller, processors, data retention/logging, confidential privacy/security contacts, attribution/marks/imagery permission, funding/conflicts and correction/appeal ownership. Test contacts only with explicit authorization. Legal/reviewer approval is retained as dated evidence; do not invent names or self-sign external approval.


- [ ] **Step 4: Reassess every release gate**

Update the July ledger using current candidate evidence. Label old historical claims as historical, not failed current facts. Every missing gate remains blocked/partial. No blanket conversion of the twelve rows to passed.


- [ ] **Step 5: Commit accurate governance records**

```bash
git add docs/release/v1-release-gates.md docs/privacy/personvern.md docs/security/supply-chain.md docs/governance/public-good-governance.md docs/data/source-registry.md docs/evidence/release-readiness/security-governance.md
git commit -m "docs: retain reviewed candidate governance and security evidence"
```


**Review/exit:** All legal/source/operator facts have an actual owner and current evidence; confidential data stays private.


### Task 23: Build and test the immutable release candidate

**Depends on:** 17–22

**Files:**
- Read/Modify only on failing checks: `.github/workflows/ci.yml`, `Dockerfile`
- Read/Test: `tests/image-e2e/immutable-image.spec.ts`, `tests/operations/production-image-contract.test.mjs`
- Create: `docs/evidence/release-readiness/candidate-checks.md`

**Interfaces:** Consumes completed implementation and current acceptance inputs; produces one clean source SHA, CI-built image digest, SBOM/provenance and passing candidate tests. Do not build from uncommitted local patches.


- [ ] **Step 1: Run the required local checks**

```bash
df -h /System/Volumes/Data
corepack pnpm --filter @handleplan/db typecheck
corepack pnpm --filter @handleplan/db exec vitest run
corepack pnpm --filter web typecheck
corepack pnpm --filter web exec vitest run
corepack pnpm --filter @handleplan/worker typecheck
corepack pnpm --filter @handleplan/worker exec vitest run
corepack pnpm --filter @handleplan/tjek test
corepack pnpm --filter @handleplan/open-prices test
```
Real DB suites run with disposable integration flags. Record skips; none of the release-critical role/upgrade/publication tests may be skipped.


- [ ] **Step 2: Review and freeze the source**

Review spec coverage and actual diff, especially database security and parser assumptions. Resolve findings with smallest red/green corrections. Commit all source fixes and record immutable source SHA; do not amend it after candidate evidence starts. Push the PR and require successful CI including migrations twice, role proofs, browser/image checks and scans.


- [ ] **Step 3: Verify the CI image artifacts**

```bash
corepack pnpm operations:image:test
gh pr checks 12
```
Follow the existing exact-CI image-bundle verifier and provenance steps in .github/workflows/deploy-preview.yml. Retain image ID/digest, platform, source binding and scan results. A newly built local image does not replace the CI artifact.


- [ ] **Step 4: Record candidate-current test evidence**

Retain sanitized exact commands, timestamps, SHA/image digest and artifact links. Full tests passing on an earlier SHA do not certify this candidate. Run further tests only for changed code or identified gaps.


- [ ] **Step 5: Keep candidate documentation separate**

Do not add final promotion artifacts to the source commit. The existing release protocol requires a following evidence-only commit; ordinary working notes remain staging material untilTask25.


**Review/exit:** One immutable candidate passes complete CI and genuine real-role integration; no unresolved release-critical tests.


### Task 24: Deploy protected candidate and verify live acceptance

**Depends on:** 23

**Files:**
- Read: `.github/workflows/deploy-preview.yml`, `deploy/deploy-on-vps.sh`, `deploy/compose.production.yml`
- Create: `docs/evidence/release-readiness/live-acceptance.md`

**Interfaces:** Consumes verified candidate image and exact source SHA; produces VPS image/readiness, real browser/API and lifecycle acceptance proof. No deployment inferred from git push.


- [ ] **Step 1: Check current deployment and rollback evidence**

Confirm GitHub deployment job status before manual operation to avoid a race. Check VPS disk, running ports, backup restore proof and currently verified rollback image. Keep production.env/private volume untouched.


- [ ] **Step 2: Deploy the exact approved bundle**

Prefer the existing workflow. If the prescribed manual path is required, use its exact verified image variables and stop/remove only app,worker,review,operations,migrate before up; never remove postgres or its volume.
```bash
docker compose --env-file /opt/apps/handleplan/shared/production.env -f compose.production.yml stop worker app review operations migrate
docker compose --env-file /opt/apps/handleplan/shared/production.env -f compose.production.yml rm -f worker app review operations migrate
docker compose --env-file /opt/apps/handleplan/shared/production.env -f compose.production.yml up -d --remove-orphans
```
Commands run on the VPS from the activated verified release deploy directory with HANDLEPLAN_IMAGE, HANDLEPLAN_MIGRATION_IMAGE and APP_COMMIT_SHA supplied by the release bundle. Do not execute these unbound from the laptop.


- [ ] **Step 3: Verify five services and exact image**

Read container image IDs/labels and app readiness revision; compare to candidate. Check current migration/baseline ledger, worker SQL/transport failures, source freshness and lifecycle receipts. Expected review backlog is reported separately, not concealed as zero failures.


- [ ] **Step 4: Perform all-chain real browser acceptance**

In authenticated Chrome, run national and supported regional/store browse, everychain, cursor/category/exactsearch, addtolist, plan and shopping mode. Record real URL/request/status/count and source-backed price/conditions. Test an ineligible scope/member/expired offer exclusion. Repeat API checks at the origin without bypassing user-facing Access.


- [ ] **Step 5: Observe refresh and validity transition**

Observe at least two scheduled refreshes and an actual offer expiry/publication boundary. Record backlog, alert health, source freshness and removal timing. If a period has not elapsed, keep this checkbox open; do not synthesize production evidence to finish sooner.


- [ ] **Step 6: Retain live acceptance**

Write live-acceptance.md with SHA/digest, exact URLs, receipt IDs/counts and nonclaims. If any promised chain lacks current usable evidence, keep protected and return to that source task. Do not remove Access as a workaround.


**Review/exit:** All claimed chains and complete user flows work on the exact running candidate through refresh and expiry.


### Task 25: Promote public release and hand off operations

**Depends on:** 24 and all external gates

**Files:**
- Read: `docs/runbooks/release-candidate-manifest.md`, `docs/release/v1-candidate-manifest.schema.json`, `scripts/release/verify-v1-candidate-manifest.mjs`
- Create: candidate directory under `docs/evidence/v1/` containing manifest, typed G1–G12 evidence and external trust receipt
- Update: Obsidian project/daily log

**Interfaces:** Consumes immutable source image and reviewed current evidence; produces one evidence-only commit, valid independently signed promotion receipt, approved public routing and monitored release.


- [ ] **Step 1: Assemble the source-bound promotion candidate**

Use the existing manifest schema and runbook. Choose the candidate directory once from the source SHA; bind all evidence to that source and exact image, store approved reviewer identities and timestamps, and preserve old candidate artifacts. Do not use draft generator output as promotion proof.


- [ ] **Step 2: Obtain the independent release receipt**

The designated external authority verifies registry image/signature/provenance and typed G1–G12 evidence, then signs the short-lived receipt under protected release Environment policy. No generated self-trust key or copied signature. If signer/policy is unavailable, public promotion remains blocked.


- [ ] **Step 3: Run strict promotion verification**

```bash
node scripts/release/verify-v1-candidate-manifest.mjs --require-promotion "$CANDIDATE_MANIFEST"
```
CANDIDATE_MANIFEST is the actual repository-relative manifest path just created. Expected exit0 with all gates passed; a draft validation pass is insufficient. Create exactly one clean evidence-only commit after the immutable source commit and rerun the prescribed two-commit verification.


- [ ] **Step 4: Publish only the approved scope**

After successful protected acceptance and release authorization, change the existing public routing/Access policy through the configured deployment mechanism. Recheck public unauthenticated discovery/planning/status/privacy/contact flows and abuse controls. Keep review and operations protected. Do not claim geographic or chain coverage absent from the accepted manifest.


- [ ] **Step 5: Observe post-launch and hand off**

Verify next scheduled data refresh, active alert delivery, backup schedule and an expiry/revocation scenario. Hand off source owner/reviewer queue, key custody, on-call contact, rollback instructions and correction process. Record exact source/evidence SHA, image digest, public URLs and residual non-release limitations.


- [ ] **Step 6: Log completion without overclaiming**

Update the Obsidian release-readiness note and daily log with candidate evidence links. Close PR12/release tracking only after all required checkboxes and G1–G12 pass; if an external input is missing, report its precise owner action and leave release incomplete.


**Review/exit:** A working public release, current operational ownership and verifiable signed evidence; no hidden skipped gate.


## Coverage self-review

| Requirement | Tasks |
|---|---|
| R1 reproducible install/upgrade/restore | 1–2,21,23–24 |
| R2 exact authorization and least privilege | 3–5,8,22 |
| R3 seven-chain ordinary and discount coverage | 6–13,17 |
| R4 identity, conditions and source truth | 7,9,14,16–17 |
| R5 recurring review/publication/expiry | 5,8,14–15,20,24 |
| R6 discovery/planning continuity | 16–17,24 |
| R7 real complete baskets | 7,16–17 |
| R8 device/offline/accessibility/travel | 18–19 |
| R9 operational/legal/security evidence | 6,20–22 |
| R10 exact image and public launch | 23–25 |

G1→6/22; G2→6/17; G3→7–16; G4→17; G5→8–9/17; G6→19; G7→18; G8→18; G9→22; G10→20–25; G11→17; G12→22/25. All seven named chains have an explicit delivery task; all other exposed filters have truthful-status acceptance in16.

## Stop and escalation conditions

- Migration recovery design would require changing022–040: present the exact proposed exception and checksum/upgrade consequences; do not execute it implicitly.
- Missing provider access, rights, source payload or store mapping: keep that chain blocked, record the exact request the owner must supply, continue independent engineering.
- Missing physical device, manual reviewer, operator configuration or independent signer: retain the failed evidence gate, not a fabricated pass.
- Unexpected production writes, mismatched image/ledger or revoked source: halt affected deployment/intake through existing fail-closed controls and preserve evidence.
- Builds below30GiB free: stop the build; do not delete unrelated data to make room.

## Execution handoff

Use subagent-driven-development for independent task ownership and two-stage review, or executing-plans for inline batches with checkpoints. Source-specific plans in10–13 and the backup provider plan in21 must be authored from observed contracts before code; the source work is not complete merely because those plans exist. Revisit this master dependency map when qualification produces a new blocker. Do not lower the release scope without a recorded user decision.
