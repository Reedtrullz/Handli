# Scheduled ingestion worker runbook

## Safety state

The production image contains a separate scheduled worker process, but source
access is disabled by default. `KASSAL_SOURCE_ACCESS` defaults to
`conditional`; in that state the worker records a failed schedule outcome and
makes no Kassalapp request, starts no ingestion run, and creates no price or
catalog evidence.

Changing one environment variable is not sufficient to activate ingestion.
Every job checks all of these controls immediately before upstream work, after
at most 25 source calls, before every persistence transaction of at most 25
outcomes, and once more after persistence before a run can be marked
`completed`. In addition, the Kassalapp client invokes the worker's
authorization callback immediately before every physical HTTP attempt,
including a retry and internal physical-store requests. A revocation observed
while waiting for `Retry-After` therefore suppresses the retry rather than
spending another upstream attempt:

1. the deployment opt-in is exactly `KASSAL_SOURCE_ACCESS=approved`;
2. `data_sources.runtime_state` is `approved` for `kassalapp`;
3. the source-level permission review is present and not expired according to
   PostgreSQL time;
4. the latest append-only `source_permissions` decision is `approved` and not
   expired according to PostgreSQL time; and
5. that decision contains the exact job scope: `catalog: true` for catalog,
   `ordinaryPrice: true` for current prices, `priceHistory: true` for historical
   collection, or `physicalStore: true` for store sync.

Missing records, missing scopes, unknown values, `conditional`, `blocked`,
`revoked`, or expired permission all fail closed before a source request. Never
change governance rows interactively under the runtime role. An approval or
revocation is an owner-reviewed append-only governance change with its own
evidence; the worker has read-only access to those records.

If access changes or cannot be verified after persistence, the run is finalized
as `degraded` with `SOURCE_ACCESS_CHANGED`; it is never promoted to completed
evidence. Binding the approval decision version and ingestion writes in one
atomic database transaction remains a defense-in-depth hardening task.

Catalog metadata corrections have an additional database boundary. An active
canonical product changes only when the proposed record is strictly newer than
both the canonical row and the existing `source_products` match for the same
source/external ID, and a current approved `catalog` permission is visible in
that transaction. Identical fields are idempotent. A changed retired product,
an unmatched source record, stale/equal timestamps, or missing/revoked access
is recorded as `quarantined` with
`CATALOG_CORRECTION_REVIEW_REQUIRED`; its proposed normalized fields remain in
the append-only outcome audit, while canonical and matched-source fields stay
unchanged. A policy-approved catalog record may still promote a migration-era
quarantined GTIN to active.

## Jobs and bounds

The UTC schedule is deterministic:

| Job | Anchor | Interval | Timeout |
| --- | --- | --- | --- |
| Catalog refresh | 02:15 | 24 h | 15 min |
| Benchmark prices | 00:30 | 6 h | 5 min |
| Physical stores | 03:15 | 24 h | 5 min |
| Historical observations | 04:15 | 24 h | 15 min |

On initial deployment only the newest missed slot is run. Every catalog run
reads one source-normalized `/products` page of at most 100 records. Page 1 is
revisited every seventh terminal non-empty catalog run; the intervening runs
rotate deterministically through pages 2-100. Exact-EAN catalog targets also
include checksum-valid active or quarantined identifiers, including unverified
migration rows and valid cache-only GTINs. They prioritize unverified and
least-recently-refreshed records.

All target sets are bounded by `WORKER_TARGET_LIMIT` (default and maximum 500).
Current and historical price targets include verified active products only and
use separate least-recently-refreshed queues, with never-observed rows first,
so a lexical first page cannot permanently starve later products. Catalog's
single discovery request plus at most 500 sequential exact-EAN requests takes
roughly 8.5 minutes at the default 60-attempt/60-second PostgreSQL budget,
leaving margin inside the 15-minute job timeout. The default budget wait is 65
seconds, and it is combined with client timeout, retry, response-size, and
100-EAN upstream limits. Price calls are deliberately split into at most 25
EANs so governance is rechecked between calls.

One source-scoped PostgreSQL lease fences all four jobs. Lease takeover uses
PostgreSQL time and a new generation token; every ingestion write and worker
schedule result verifies the current fence initially without holding the lease
row lock, then takes a bounded `FOR UPDATE` fence immediately before commit.
The short, at-most-25-row persistence transactions let the separate lease
heartbeat advance during long jobs. `SIGTERM` and `SIGINT` stop new cycles,
cancel active work, join bounded handler cleanup, and release the lease. An
unresponsive handler exits non-zero without voluntarily releasing its
still-live lease.

## Durable result semantics

Migration `010_worker_job_results.sql` adds the append-only schedule ledger.
It is deliberately separate from `ingestion_runs`: a policy-blocked, empty, or
otherwise failed job is operational evidence, not a successful ingestion run.
The ledger stores bounded counters and a semantic hash but never the lease
token, credential, request payload, response payload, basket, address, or
coordinates.

Safe readback examples from an owner/read-only operator session:

```sql
select job_kind, scheduled_at, status, counts
from worker_job_results
where source_id = 'kassalapp'
order by scheduled_at desc
limit 20;
```

```sql
select run_type, started_at, completed_at, status, counts, error_class
from ingestion_runs
where source_id = 'kassalapp'
order by started_at desc
limit 20;
```

A `failed` schedule row with no matching ingestion run is expected while the
source is disabled. Do not relabel it as an empty successful ingestion. A
terminal ingestion run proves persistence counters, not that the evidence is
eligible for a public claim; eligibility and coverage remain separate gates.

Migration `016_worker_source_health.sql` makes the schedule ledger drive one
source-wide, append-only health snapshot in the same fenced transaction for
each non-cancelled terminal worker result. The worker may write only aggregate
success clocks, `status`, an empty `details` object, and zero/null review-queue
placeholders. Request URLs, queries, errors, tokens, addresses, coordinates,
baskets, provider payloads, queue contents, and generic metadata have no writer
field and are rejected by database constraints. A unique `worker_job_id` makes
exact retry converge without duplicating health.

The mapping is deterministic. `succeeded` with at least one accepted record is
`healthy`; `partial` is `degraded`; `failed` and `timed-out` are `failed`. A
nominal `succeeded` result with zero accepted records is `degraded`, making a
silent-zero ingestion visible without calling it successful. Discovery,
and capture clocks advance only for applicable real progress. Raw worker
accepted/persisted counts do not prove a governed public publication or
eligibility, so `last_publish_success_at` and
`newest_eligible_evidence_at` are carried forward unchanged across every job
kind. PostgreSQL enforces that boundary; a future publisher may advance those
clocks only after binding source runtime, current permission, scope, and claim
eligibility. All previous clocks are carried forward across job kinds and may
never postdate the terminal result.

Cancellation deliberately creates no health assertion. If an ingestion run
started, its cancelled terminal row remains newer than the preceding snapshot,
which the public status model treats as `unknown`; a pre-ingestion shutdown is
retained only in the private worker-result ledger and does not relabel source
health. Writing `healthy` would mask the cancellation, while writing
`degraded` or `failed` would misclassify an operator stop.

Health never changes source governance. Conditional, blocked, or revoked
sources can accumulate operational evidence but remain ineligible for public
ranking until the independent source and permission gates are approved.

Migration `011_catalog_observations.sql` adds the append-only public catalog
payload. Every accepted catalog record is linked to its ingestion attempt and
stores the exact normalized name, brand, package fields, GTIN, semantic hash,
retrieval time, and optional upstream source-update time. Public catalog
readers expose only observations from `completed` catalog runs; `running`,
`degraded`, `failed`, and `cancelled` attempts remain audit evidence but are
not publishable. Mutable canonical and source-product rows are matching
projections, not the public payload. The retrieval clock records when the
worker obtained the record and must not be substituted for the independent
upstream source-update clock.

The linked run cannot be relabeled later: the database fixes its job identity,
source, run type, start, and creation time, permits only one `running` to
terminal transition, and rejects terminal updates and all deletes. Retrying an
already-finalized application call remains idempotent because it reads and
returns the existing terminal result without issuing a second update.

Benchmark-price runs persist `ordinary_only` observations and may update current
coverage and the legacy current-price cache. The fenced `historical-prices` run
type persists `historical_eligible` observations and does not write those
current-price projections. The planning reader keeps both classes traceable but
exposes a separate `historicalEligibleEvidenceIds` partition; ordinary-only rows
must never be used as historical-comparison inputs. Current readback also
requires `ordinaryPrice` for ordinary rows and `priceHistory` for historical
rows from the latest effective permission decision.

## Deployment and rollback

The same immutable image contains web and worker artifacts. Compose starts both
only after the one-shot migrator succeeds. The worker runs read-only, without
Linux capabilities, with `no-new-privileges`, a bounded temporary filesystem,
and a 45-second container stop grace. It also receives the exact
`APP_COMMIT_SHA` used by the web image. PostgreSQL identities are split:
`handleplan_app` retains the worker's explicit bounded write matrix, while the
public web uses the separate `handleplan_web` read-only role. The web role has
no worker lease, request-budget, schedule-result, sequence, function, or private
capture/review access.

The worker serves `GET http://127.0.0.1:3005/health` inside its own container;
the port is not published to the host or frontend network. The document contains
only the immutable revision, PID/uptime, scheduler state, saturating cycle
counters, and one bounded last-cycle summary. It never contains credentials,
source identifiers, job IDs, request or response data, database URLs, or source
payloads. Startup, shutdown, a fatal cycle, an over-bound cycle, or an idle
scheduler that misses its next interval returns non-ready health. A running or
freshly completed bounded scheduler cycle is ready.

Source degradation is reported as `status: degraded` with a count only; it
remains ready because permission blocks and upstream degradation must not cause
a liveness restart loop. Compose checks `ready: true`, so `up --wait` rejects a
worker that never starts its scheduler, exits, crash-loops, or becomes unhealthy
without treating a safely recorded degraded source result as a process failure.

Before deployment, render Compose with the protected `production.env` and
confirm `KASSAL_SOURCE_ACCESS` is still `conditional` unless the full approval
record exists. The deploy preflight also requires exactly one bare canonical
review audience and one bare canonical operations audience and rejects reuse
before image load or runtime quiesce. Their base origins may be equal because
the private processes accept disjoint exact paths; their Access applications
and audience tags may not be equal. Do not print or inspect protected values.
After deployment,
`deploy-on-vps.sh` reads the exact web revision from `/api/health`, then executes
the internal worker health request in the container. It requires zero restarts,
the exact worker revision, ready health, and a newest completed cycle whose
duration passed the committed cycle bound and whose `leaseAcquired` value is
`true` before writing `state/current-revision`. A completed standby cycle proves
the scheduler loop is alive but does not prove this deployment can own and fence
work, so it is insufficient for promotion.
The wait is bounded to 55 minutes, covering the four sequential production job
timeouts plus their shutdown grace. After a post-migration startup or readback
failure, the script stops, removes, and proves `review`, `operations`, `worker`,
and `app` absent. It may then restore only a prior public app whose local image
revision label exactly matches the recorded prior commit. With missing state, a pruned or
mislabeled prior image, or any cleanup failure, it leaves every candidate
runtime down and records nothing. Migrations `010` and `011`, together with the
durable newest schedule row, remain useful operator readbacks after rollout.

The checksum-bound operations release is prepared from the verified candidate
source before quiescing anything. Immediately after the migrator succeeds—and
before any candidate process starts—the script atomically points
`operations/current` at that release and reads its manifest back. Consequently,
a later candidate startup/readback failure and public-only image fallback keep
backup, restore, migration-ledger, and rollback controls at the forward schema
revision. Because migrations are individually transactional and an unsuccessful
migrator may already have committed an earlier file, catchable exit cleanup also
attempts this activation after migration begins. This control pointer does not
record the application deployment or advance its immutable image/high-water
state; only complete runtime readback can do that.

The protected deploy workflow runs only from a successful `CI` completion for a
push to this repository's `main`; it has no direct manual-dispatch bypass. It
checks out that exact CI revision and downloads the fixed five-file image bundle
by the triggering workflow's run ID, run attempt, and revision-specific artifact
name. Before configuring SSH it verifies the manifest shape, every SHA-256,
archive bounds, the unsigned provenance subject/commit, and the loaded image's
config digest and revision label. It transfers the bundle plus the verified
manifest SHA-256, `deploy-on-vps.sh`, and `deployment-state.sh` over the
pinned-host-key SSH channel into
`/opt/apps/handleplan/deploy-bundles/<revision>/<ci-run-id>-<ci-attempt>/<deploy-run-id>-<deploy-attempt>/`, and invokes
the real remote script path so sibling resolution cannot depend on
streamed-shell `$0` state.
The VPS fetches the exact `origin/main` ref, requires both the candidate and any
recorded high-water deployment to remain reachable, and rejects a candidate
older than that high-water mark. Before loading anything, it independently
requires the exact five regular artifacts, run ID/attempt/revision bindings,
all SHA-256 values, a maximum-2-GiB Docker archive, and a maximum-128-MiB source
archive. It uses the extracted checksummed source archive—not the mutable
checkout—for Compose and migration definitions, and loads the already-built CI
Docker archive. It then verifies the loaded config digest/revision label and
requires the app, review, operations, and worker containers to use that exact
image ID. The VPS never rebuilds the image. The temporary source extraction is
removed on every exit. GitHub environment protection remains useful
defense-in-depth, but revision/CI selection does not assume that an environment
rule exists or is correctly configured.
Its 120-minute job bound leaves explicit margin around the 55-minute worker
cycle wait for artifact transfer/load, migration, verification, and rollback.
Final workflow readback requires `v1 <revision> current`, the matching
revision-only compatibility marker, and the exact CI image config digest.

This handoff identifies exact image bytes with the Docker-archive SHA-256 and
Docker config digest. It does not claim a signed registry OCI manifest,
release-grade provenance, or public promotion; the CI bundle expires after
seven days and promotion remains intentionally blocked.

Rollback remains forward-only: the current migrator expands schema first, and
push CI builds and boots the exact first-parent application image against that
expanded PostgreSQL schema with the read-only web role before the current image
can pass. The atomic
`state/current-deployment` manifest ties one exact revision to its compatibility
mode. A successful readback records `v1 <revision> current`; the revision-only
`state/current-revision` file remains as a matching compatibility marker for
older operator tooling. Auxiliary `state/current-image-id`,
`state/deployment-high-water`, and create-only
`state/verified-images/<revision>` records bind the exact loaded image and stop
normal deploys from moving backward. A normal deploy advances the high-water
revision; an authorized explicit rollback changes the current revision/image
but preserves the high-water mark. Missing state or a valid old revision-only
marker means `legacy`, while a malformed manifest, unknown mode, invalid
revision, missing marker, or mismatch fails closed before an automatic rollback
mode is selected. See the
[explicit immutable-image rollback runbook](explicit-image-rollback.md) for the
separate operator path and its required image/readiness proof.

Automatic failure recovery never restarts a previous worker or review process.
After the candidate cleanup/absence proof, it may start only the label-verified
previous public image through the legacy overlay. It is deliberately
safe-degraded: the old app keeps
the read-only `handleplan_web` role, receives a static non-secret compatibility
key, and points its required HTTPS source origin at closed loopback port
`127.0.0.1:1`. The database role cannot claim a
provider-budget slot, so the legacy client's pre-fetch coordinator fails before
any request; the loopback-only source origin is a second fail-closed boundary.
The real Kassal credential is never restored to an internet-facing legacy app.
Cached-price reads can remain available, but search, refresh, and complete
planning are explicit rollback non-claims. The old health endpoint proves only
that this safe-degraded shell started.
This failed-candidate fallback is not the explicit rollback path: it remains
public-app-only and source-disabled, does not lower the high-water revision, and
does not claim full application readiness.
Stopping or rolling back the worker does not delete evidence or down-migrate
the schedule ledger.
If the source must stop immediately, set the deployment cap away from
`approved` and record the governance revocation; either gate independently
prevents the next current-worker source call. Automatic legacy rollback remains
source-disabled regardless of that setting.

## Current non-claims

This slice proves composition, bounded scheduling, database fencing, graceful
shutdown, default-disabled policy, and container wiring in tests. Its catalog
discovery horizon is the newest 100 pages (up to 10,000 source rows); a durable
cursor beyond that horizon and page-at-a-time prepare/persist streaming remain
future hardening. It does not prove a credentialed production Kassalapp run,
contractual permission, current regional coverage, a public source-health
dashboard, external alert delivery, off-host encrypted backup, monthly restore
drills, or clean-host recovery.
