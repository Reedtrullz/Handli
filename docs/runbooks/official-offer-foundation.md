# Official-offer vertical foundation (V1-09)

## Status and nonclaims

This slice is a source-neutral, private ingestion and operational foundation. Public activation is
fixed to `enabled: false` in the versioned domain contract, and migration 026 seeds an independent
database publication policy to `false`. It defines two worker job kinds, a dedicated atomic
publication/expiry database boundary, and an owner-private filesystem blob store, but production
composition returns no official-offer handlers or schedules and bootstrap does not instantiate the
store. It does not add a retailer adapter or URL, network fetch, live source schedule, public offer
endpoint, or ranking input.
The separate V1-10 slice adds an Access-protected source-neutral review UI/API and append-only
repository; see [`private-review.md`](private-review.md). It still has no real source/capture
renderer and cannot activate publication. No retailer publication, artwork, text, price, or
identifier is included in the repository. The golden fixtures are invented and rights-cleared
for tests.

The code does **not** claim that Bunnpris, Extra, Rema 1000, or any other source has granted
capture, extraction, storage, or public-display rights. A real source remains blocked until its
rights record and runtime source policy independently approve the exact capabilities being used.

## Boundaries

The implementation has three deliberately separate layers:

1. `@handleplan/domain` owns strict version-1 edition, capture, extraction, candidate, empty-result,
   and validation contracts. Unknown fields and unbounded values fail validation.
2. `@handleplan/worker` owns private structured-first pipeline and operational orchestration ports.
   Discovery and fetch are explicitly **trusted, server-owned normalized boundaries**: a raw
   network adapter cannot implement them directly. Reviewed code must derive source authorization,
   discovery time, geographic scope, and rights classification. Immediately before each discovery
   or fetch invocation, a separate authorizer is called; a physical adapter must perform exactly
   one attempt and must not hide retries or redirects. Returned values remain unknown, strict,
   bounded input at the orchestrator boundary. There is no live source adapter.
3. `@handleplan/db` records the audit trail in the existing publication and offer-review schema.
   Migration 023 adds the two source-neutral job kinds to the worker-result ledger. It does not add
   a retailer source, runtime grant, publication grant, or activation.

Private capture bytes cross only the blob-store and extractor ports. Receipts and current-offer
reads omit the blob key, capture ID, source reference, candidate ID, reviewer identity, and review
reason. Implementations must not log capture bytes, private keys, or normalized candidate payloads.

## Authorized flow

The future caller must provide a strict edition input whose authorization:

- is `approved`;
- includes `discover`, `capture`, and `extract`;
- was reviewed no later than discovery; and
- has not expired at discovery.

The worker then performs this sequence:

1. Check the dynamic source kill switch for discovery.
2. Record the immutable edition identity without storing private authorization material.
3. Check capture permission, copy and SHA-256 hash the bounded payload, and verify any expected
   checksum.
4. Write to a content-addressed private key with `putIfAbsent`. The blob store must reject an
   existing key with different bytes. The worker verifies returned checksum and length.
5. Recheck capture permission before recording capture metadata. Revocation after the blob write
   can leave a private, unreferenced blob; it must remain inaccessible and is a future bounded
   retention/garbage-collection concern, never a reason to continue ingestion.
6. Try structured extraction, then embedded text. OCR is attempted only when both the edition
   authorization and dynamic policy allow `ocr`.
7. Recheck extraction permission after every extractor call and again before persistence. OCR is
   also rechecked before persistence.
8. Cross-bind the extractor envelope checksum to both the computed capture metadata and blob-store
   result. Resolve exactly the GTIN set present in the envelope, with no extra or omitted keys.
9. Let the database repository derive validation from the parsed envelope, edition, and bounded
   exact-match context, then atomically record the extraction run and candidates.

Cancellation and source revocation stop forward progress. Neither condition can activate or
publish an offer.

## Operational and storage foundation

The worker contract defines `official-offer-ingestion` and
`official-offer-lifecycle-reconcile`. Discovery is capped at five pages, ten editions per page,
ten editions per run, and 100 MiB of fetched bytes per run, with a 50 MiB per-capture ceiling.
Cursor length, duplicate editions/cursors, cross-source fetch results, unknown fields, accounting,
and partial progress all fail closed. Already-persisted progress survives a later failure in a
typed partial worker result.

Lifecycle reconciliation has its own source-bound database lease and advisory-lock namespace in
migration 026. It never reads or writes `worker_leases`, never borrows a Kassalapp fence, and owns
its immutable `worker_job_results` plus lifecycle-detail append in the same transaction. The
dedicated worker executor makes exactly one call to that SQL function and treats its receipt as
authoritative; it must not pass lifecycle work through the generic `WorkerRuntime` state store,
whose second result write is deliberately rejected for the runtime role. Production remains inert:
configuration must contain exact `enabled: false`, and no lifecycle handler or schedule is
returned.

`FilesystemOfficialOfferPrivateBlobStore` implements immutable, content-addressed writes with
owner-only `0700` directories and owner-read-only `0400` blobs. It validates the canonical key,
length, SHA-256, bytes, rights class, ownership, modes, inode/link state, and symlink-free path;
publishes by same-directory temporary file plus hard link; verifies existing content without
replacement; and syncs file and directory metadata before success. The interface is deliberately
write-only. It exposes no checksum-verifying read path for a private-review renderer, which remains
the next source-neutral security gap.

Compose declares a worker-only read-write named volume at
`/var/lib/handleplan/private-captures`; neither public web nor private review mounts it. While the
foundation is disabled this mount is inert. It has no total-volume quota, free-space monitor,
retention/deletion worker, encrypted off-host backup, restore proof, cross-host durability, or
review-safe reader. Those are activation gates, not implied by the per-blob limit.

The synthetic tests use invented rights-cleared fixtures through `WorkerRuntime`, `WorkerRunner`,
the ingestion handler, discovery/fetch ports, the real pipeline, the real filesystem store, and a
fake state ledger/repository. Lifecycle tests use the separate one-call executor. They prove local
composition and persistence, not a retailer adapter, live schedule, production filesystem, public
publication, or network behavior.

## Validation and review routing

Typed candidates represent unit price, source-provided before price, multibuy price, public or
member eligibility, package amount/unit/count, validity, geography, channels, provenance, and
anomalies. Validation behaves as follows:

- one GTIN resolving to one canonical product with no anomaly may be an `exact-match`;
- unmatched labels/GTINs, ambiguous identifiers, OCR, unknown package, unreadable dates, unknown
  or mismatched geography, and validity outside the edition window require review;
- contradictory before-price arithmetic and duplicate candidate keys are rejected;
- duplicate detection includes package, member program, channel, price, validity, and geography,
  so materially different variants are not collapsed;
- OCR always receives `OCR_REVIEW_REQUIRED`, even when its GTIN match is exact;
- schema drift fails, while layout drift and unexpected/silent zero results degrade;
- a healthy confirmed-empty result requires explicit evidence bound to the same source and edition
  and observed during the extraction run.

The exact-product lookup context is strict and bounded: at most 500 valid GTIN keys, at most 20
unique bounded canonical IDs per key, and exactly the key set requested by the envelope.

## Persistence and replay protection

The repository reuses `publications`, `publication_captures`, `extraction_runs`, and
`extracted_offer_candidates`. Approved-offer, applicability, target, and review tables remain the
future governed publication path.

Edition identity conflicts never rewrite dates or geography. Capture identity is publication plus
SHA-256 checksum, and the metadata must match exactly on replay. Extraction identity remains the
existing capture plus extractor-version key. To prevent that coarse key from accepting changed
content, the existing `extraction_runs.counts` JSON also stores:

- `envelopeSha256`: a deterministic digest of the complete parsed envelope, including method,
  schema/layout fingerprints, candidates, and any empty confirmation; and
- `validationSha256`: a deterministic digest of the repository-derived dispositions, anomalies,
  counts, and exact canonical matches.

An idempotent conflict is accepted only when status, clocks, error class, counts, envelope digest,
and validation digest all match. Candidate rows are inserted only for the first accepted run.

## Publication and expiry guard

Migration 026 owns one database-clock transaction for both expiry and publication evaluation. Each
call is bounded to 50 expiry rows and 50 publication candidates, uses circular per-source cursors,
has fixed lock and statement timeouts, and either appends the immutable result accounting with the
status transitions or commits neither. Exact replays return the original database evaluation and
lease-expiry clocks; a changed source, schedule, run, batch, or publication request conflicts.
Successful completion releases the dedicated lease immediately while retaining both cursors.

Expiry is always evaluated, including while publication is disabled. Ended approved offers and
published offers that no longer survive the exact public projection transition one way to
`expired` or, for an explicit source/permission/review revocation, `revoked`. Lifecycle status is
the only mutable approved-offer field; price, target, scope, source, validity, review binding, and
conditions remain immutable. A lifecycle success never writes source-health state and therefore
cannot masquerade as a successful or empty ingestion.

Publication requires two independent booleans: the worker's request and the singleton database
policy. The committed domain constant and database policy are both false. Even if a caller passes
`publicationRequested: true`, no publication candidate is examined unless the owner-controlled DB
policy is also enabled. Enabling it requires a new reviewed forward migration; the runtime role has
no policy-table privilege.

When both gates are eventually enabled, the SQL boundary also requires current source approval and
rights. It tentatively transitions a locked, active approved page inside the transaction, then
retains only rows returned exactly once by `public_official_offer_rows_v1` for their individually
locked products. Migration 026 promotes that projection from legacy review marker 1 to renderer-
consumed marker 2, rather than copying its eligibility predicate. Review/version, current rights,
scope, exact product, arithmetic, condition, freshness, validity, and cardinality failures become
terminal non-public rows before commit. Per-product update locks serialize different sources so two
concurrent pages cannot create a hidden 51st visible offer.

The internal current-offer reader applies source revocation and rights at read time and uses the
half-open clock interval `valid_from <= asOf < valid_until`. It returns only validated safe fields.
It is not wired to a route, planner, discovery ranking, or public API.

The former direct repository publisher and split boolean publication/expiry ports have been
removed. `PostgresOfficialOfferLifecycleRepository` can invoke only the migration-026 function;
it has no direct offer, lease, policy, result, or source-health SQL path. SQL-generated accounting
and hashes are authoritative, so this job must never be recorded a second time by the generic Node
worker-result repository.

## Requirements before activation

Activation requires separate reviewed work: a documented rights-cleared source; append-only source
permission evidence for each capability; a raw-source adapter plus trusted policy/server-clock/
geography normalization and adversarial drift fixtures; monitored scheduling and failure
isolation; a quota, free-space alarm, retention/deletion policy,
encrypted off-host backup, restore drill, and checksum-verifying private read path for the local
blob store; production proof of the rights-current renderer and DB lifecycle transaction;
privacy/security review; and explicit product approval plus a reviewed migration to change both
activation gates. Those items are outside this disabled foundation.

## Migration 023 semantics

Migration 023 is forward-only and extends the existing worker job-kind constraint with the two
official-offer kinds. An `official-offer-ingestion` terminal result may advance only capture and
catalog-discovery clocks when persisted progress exists; it never advances governed publication or
eligible-evidence clocks. A lifecycle reconciliation remains in the immutable worker-result ledger
but intentionally creates no source-health snapshot: a successful expiry/no-op cannot masquerade as
a healthy or silent-zero ingestion. Direct lifecycle source-health insertion is rejected by the
database function.

## Migration 026 semantics

Migration 026 is forward-only and depends on the renderer boundary in migration 025. It adds the
disabled singleton policy, dedicated source lease, append-only lifecycle detail ledger, one-way
approved-offer state trigger, v2 public/operations projection promotion, and one least-privilege
`official_offer_lifecycle_reconcile_v1` function. The migration runner grants the worker role only
`EXECUTE` on that function and explicitly denies the policy, lease, and detail tables. The public
web and operations roles retain only their own bounded projection functions.

The PostgreSQL integration test is enabled by `RUN_DB_INTEGRATION=1`. It proves the committed-false
policy overrides a true caller request, bounded expiry commits with immutable dual-ledger
accounting, no source-health row is created, exact replay converges, changed replay conflicts, and
the released lease permits the next job immediately. It does not enable or claim a production
source, schedule, renderer session, or public offer.

## Focused verification

Run the focused suites and typechecks from the repository root:

```sh
pnpm --filter @handleplan/domain exec vitest run src/offer-ingestion-contracts.test.ts
pnpm --filter @handleplan/db exec vitest run src/official-offer-foundation.test.ts
pnpm --filter @handleplan/db exec vitest run src/official-offer-lifecycle.test.ts src/official-offer-lifecycle-migration.test.ts
RUN_DB_INTEGRATION=1 DATABASE_URL='postgresql://owner:.../disposable_db' pnpm --filter @handleplan/db exec vitest run src/official-offer-lifecycle.integration.test.ts
pnpm --filter @handleplan/db exec vitest run src/worker-state.test.ts src/source-health-writer.test.ts
pnpm --filter @handleplan/worker exec vitest run src/official-offer-foundation.test.ts src/official-offer-operational.test.ts src/private-offer-blob-store.test.ts
pnpm --filter @handleplan/domain exec tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler src/offer-ingestion-contracts.ts src/offer-ingestion-golden-fixtures.ts src/offer-ingestion-contracts.test.ts
pnpm --filter @handleplan/db typecheck
pnpm --filter @handleplan/worker typecheck
```
