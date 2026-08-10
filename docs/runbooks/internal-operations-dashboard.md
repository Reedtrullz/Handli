# Internal operations dashboard and alert evaluator

Status: **the source-neutral private dashboard route, aggregate database
boundary, dedicated runtime role/service, and fail-closed authentication are
implemented. The source-neutral evaluator, deterministic schedule/checkpoint
contract, strict append boundary, and bounded pull exporter are implemented;
production activation is rejected rather than merely disabled by default, and
recipient delivery does not exist.**
Repository tests are not evidence that the service is deployed,
that Cloudflare Access is configured, that PostgreSQL privileges work on the
VPS, or that an alert reached a maintainer.

The implementation is split deliberately:

- [`packages/domain/src/operations-contracts.ts`](../../packages/domain/src/operations-contracts.ts)
  defines the only accepted aggregate metrics, supplied status buckets, alert
  keys, severities, and deterministic evaluator.
- [`packages/db/src/operations-dashboard.ts`](../../packages/db/src/operations-dashboard.ts)
  reads bounded aggregate evidence and invokes only the migration-owned strict
  append/checkpoint function.
- [`apps/web/lib/server/operations-service.ts`](../../apps/web/lib/server/operations-service.ts)
  retains the richer fixed alert-evaluation orchestration for a later activation.
- [`deploy/migrations/024_operations_runtime_boundary.sql`](../../deploy/migrations/024_operations_runtime_boundary.sql)
  stamps new worker/health/alert rows with database persistence clocks and
  exposes bounded aggregate, strict append/checkpoint, and transition-export
  `SECURITY DEFINER` functions.
- [`packages/db/src/operations-runtime.ts`](../../packages/db/src/operations-runtime.ts)
  invokes only those fixed functions, rejects malformed responses, and exposes
  a 100-event transition-only pull interface for a later recipient adapter.
- `/internal/operations` and `/api/internal/operations/snapshot` run in a
  separate `operations` process with only `handleplan_operations` credentials
  and an Access audience distinct from review. The public and review processes
  receive neither operations credentials nor the roster.
- Production deployment reads only the two canonical audience assignments from
  the protected env and fails before Docker load or runtime quiesce when they
  are missing, malformed, duplicated, quoted, or equal. The review and
  operations base URLs may remain the same origin because request verification
  also binds each process to its own exact path set.
- The separate [operations telemetry threat model](../security/operations-telemetry-threat-model.md)
  defines the trust and privacy boundary.

## What the evidence snapshot contains

### Enabled private dashboard projection

The enabled route is deliberately narrower than the alert foundation below.
It returns a current database observation for the exact, versioned, SHA-256
bound source roster and only:

- current governance bucket;
- latest post-024, database-stamped source-health aggregate and its fixed worker
  job kind;
- bounded post-024 worker-result totals for the last 24 hours and latest fixed
  status per job kind;
- bounded administrative counts for pending review candidates and published
  offer rows, including expiry buckets;
- the latest identity-fenced extraction envelope and candidate-row count; and
- the newest ordinary-price clock whose stored observation has a terminal run,
  source reference, record hash, and full confidence.

Every potentially large count reads at most 10,001 rows and renders 10,001 as
“at least 10,000”. The function declares three-second statement and 500 ms lock
timeouts; the dedicated role independently enforces four-second statement,
500 ms lock, and five-second idle-transaction limits. It also accepts at most
100 exact, sorted source IDs and has no free-form filter or output field. These
guards fail closed but do not replace candidate-current query-plan/load proof.

These are administrative row-state aggregates, not public-offer eligibility or
availability claims. No candidate contents, review reason/correction, price,
GTIN, source reference, permission notes, capture locator/checksum/bytes,
provider error, request field, user data, or alert details cross the function.
The API accepts no query parameters, authenticates before resolving its service,
has a four-second request lifetime and 256 KiB response limit, and always uses
private/no-store and noindex headers.

### Disabled richer alert snapshot

The disabled richer reader returns at most 100 source rows. Every potentially large logical
count admits at most 10,001 matching rows, exposes at most 10,000, and marks the
result `capped` rather than pretending it is exact. The ordinary-price lookup
likewise considers at most the newest 10,001 source observations and fails
closed if none are eligible. These SQL limits bound result/cardinality work,
but the disabled reader has not been moved behind the migration-024 projection
and no candidate-current plan/load proof exists. A 24-hour window is used for
ingestion and review outcomes. It reads only:

- no source-health snapshot from PostgreSQL yet. Migration 024 stamps new
  health/result rows for the enabled private projection, but this older richer
  reader has not adopted that exact version/persistence fence and therefore
  still emits health as unknown. It must consume only post-024 stamped rows
  before activation (and regional health must not be collapsed into a
  misleading source-wide claim);
- current registry/governance state derived from the source kill switch and
  latest permission by database creation clock and ID. The source permission
  review/expiry pointers must exactly equal that permission. Explicit revoke,
  pointer contradiction, and expiry are critical; every other non-current
  approval state remains open;
- latest ingestion for every fixed worker job kind, ordered by database-owned
  `terminalized_at` and ID. The source clock `completed_at` remains visible but
  never controls lag or as-of ordering. Only job kinds explicitly required by
  that source's roster entry contribute to its worker alert;
- latest currently valid public-display terminal extraction, bounded candidate
  count, and bounded eligible published-offer output from that same extraction
  only under current public-display rights and after the
  publication/capture/extraction identity, capability, rights, source,
  current-permission pointer, scope, validity, and as-of trust fences;
- bounded currently actionable private-review count and oldest database
  creation time (trusted extraction, `private_review`/`public_display`, current
  source permission with `privateReview`), not every stored pending row;
- bounded active, expiring-within-48-hours, and expired-but-still-published
  offer counts after the exact-product target, typed current-review decision,
  condition, source/scope state, canonical edition identity, current
  permission/pointer, public-display, extraction-provenance, and as-of gates
  mirrored from migration 022's public-offer projection. Active/expiring
  counts retain its 14-day capture-age gate; the expired-still-published hygiene
  count deliberately omits that age cutoff so time alone cannot close it;
- newest official-offer evidence by trusted capture retrieval time, never by a
  mutable offer update clock. A currently valid, current-rights public-display
  edition refreshes this signal only when it has active eligible public output
  or is a completed, explicitly confirmed-empty edition. Historical/future,
  unexpected/failed, private-review/extract-only, and non-empty-without-output
  evidence does not refresh public coverage;
- newest ordinary-price observation time only from a completed,
  database-terminalized ingestion and a currently approved source/permission
  with the same public evidence gates as planning;
- bounded review decision/rejection counts, never reasons or corrected values.

Each canonical roster entry names at least one required evidence signal
(`ordinary-price` and/or `official-offer`) and at least one fixed worker job
kind. The vocabulary includes source-neutral `official-offer-discovery`,
`official-offer-fetch`, `official-offer-ingestion`, and
`official-offer-lifecycle-reconcile`. Discovery/fetch results are independently
visible for lag but do not alone assert combined source-health progression.
Signal freshness is retained individually. The aggregate source state is
the worst required signal: a fresh ordinary price cannot hide a stale required
official-offer signal, and vice versa. Unrequired streams do not affect that
source's freshness or worker-lag assessment.

It does not project source-health `details`, ingestion/extraction `error_class`,
review reasons, normalized candidate fields, source references, capture keys or
bytes, request data, or private evidence into the aggregate snapshot. Offer
eligibility reads only explicitly projected typed public-decision paths, never
the full review row or decision object. Historical reconstruction is not
claimed: current offer/source state lacks a complete version history. The
reader excludes an offer whose database-owned state clock is newer than the
observation instead of retroactively showing its new status, but it cannot
reconstruct the older state. An eventual dashboard must therefore describe
this as a current observation only.

## Fixed alert vocabulary

| Key | Scope | Input | Open state |
| --- | --- | --- | --- |
| `api.latency` | global | externally aggregated status | above target, unavailable, or unknown |
| `api.error-rate` | global | externally aggregated status | elevated, critical, or unknown |
| `api.coordinator-outage` | global | externally supplied coordinator status | outage or unknown |
| `api.saturation` | global | externally aggregated status | high, critical, or unknown |
| `database.saturation` | global | externally aggregated status | high, critical, or unknown |
| `worker.lag` | source | worst latest database-terminalized state/lag across roster-required job kinds; six-hour foundation threshold | failed, degraded, cancelled, late, or unknown |
| `source.freshness` | source | exact current governance plus worst roster-required `ordinary-price`/`official-offer` signal; 72-hour target | revoked, contradictory, expired, approval incomplete, blocked, conditional, stale, or unknown |
| `source.silent-zero-publication` | source | latest trusted currently valid extraction envelope plus eligible output from that extraction | unexpected empty is warning; failed or non-empty-without-output is unknown; completed confirmed-empty is healthy |
| `offer.expiring` | source | active published offer expiring within 48 hours | count above zero |
| `offer.expired` | source | published offer already past `valid_until` | count above zero |
| `review.queue-age` | source | oldest pending candidate; 24-hour target | over target or count capped |
| `backup.status` | global | externally supplied status | stale, failed, or unknown |
| `disk.status` | global | externally supplied status | low, critical, or unknown |
| `certificate.status` | global | externally supplied status | expiring, expired, or unknown |

Only `ok`, `warning`, `critical`, and `unknown` outcomes exist. Unknown is an
open warning, never an implicit success. API, database, backup, disk, and
certificate facts are enums supplied by future trusted aggregate collectors;
the foundation does not invent those facts or scrape logs.

The initial latency targets remain the product-plan targets (price-only p95
below 2.5 seconds and travel p95 below 6 seconds), but no collector or measured
SLO window is selected here. The external producer must be specified and tested
before activation.

## Append-only evaluator behavior

The pure evaluator emits exactly eight global assessments plus six assessments
for every canonical roster entry, then sorts by fixed key and source. The
evaluation carries the exact roster version, canonical entries, and SHA-256
digest. The database repository recomputes the digest before reading or
appending. Migration 024's strict append function independently reconstructs
the roster digest, validates the exact matrix, takes a global
transaction-scoped advisory lock, then captures its event clock from PostgreSQL
and checks a distinct
`operations.evaluation-checkpoint` ledger row. Older
evaluations and same-clock contradictory evaluations fail before state writes;
an exact replay returns without writes. It then locks alert identities in the
same canonical order and inserts only when fixed state or roster identity
changes. A newer unchanged evaluation advances only the checkpoint; it does
not create a fake alert transition, and the returned `appended` count excludes
the checkpoint. The repository obtains event clocks from PostgreSQL inside the
transaction; migration 024 also overwrites persistence clocks on every new
alert row. Escalation
preserves the original incident opening time; recovery appends a separate
closed row. It never updates or deletes prior rows. Alert transitions write
only this details shape:

```json
{"contractVersion":1,"evaluatedAt":"2026-07-17T12:00:00.000Z","evaluationContentSha256":"<64 lowercase hex>","outcome":"warning","sourceRosterContentSha256":"<64 lowercase hex>","sourceRosterVersion":"release-v1"}
```

Checkpoint rows are closed/info ledger records with the same version, roster,
evaluation clock, and digest plus `"kind":"evaluation-checkpoint"`. They are
not part of the fixed alert vocabulary or an operator alert timeline. Migration
024 enforces this separation at the write/export boundaries; retention remains
an activation gate.

Malformed, future-dated, free-form, duplicated, unsorted, over-bound,
scope-mismatched, digest-mismatched, matrix-incomplete, or source-incomplete
evidence fails closed before an alert insert. Cancellation is rechecked after
every query, after the checkpoint insert, and immediately before the
transaction callback returns. Once PostgreSQL has committed, the repository
returns the committed result rather than reporting a false rollback. A caller
must supply a versioned,
non-empty canonical source roster. A missing or extra source, missing matrix
cell, or snapshot with more than 100 sources is not evaluated because silently
omitting source alerts would create a false healthy state. This repository
contains only the roster contract and synthetic test roster; selecting and
hashing the real launch roster remains an activation gate.

The operations role has no direct alert-table or sequence access. It invokes a
strict function that owns fixed keys, scopes, details, clocks, monotonic replay,
and state-change-only inserts. A separate bounded pull function returns at most
101 transition rows so the caller can emit a 100-event page with explicit
`hasMore`; checkpoints and arbitrary rows never cross it. This is an exporter
boundary, not an off-host recipient, delivery, or retention implementation.

The reusable worker runtime contract derives the newest slot from a fixed
anchor and interval, requires a schedule-aligned durable checkpoint, and
refuses explicit activation unless evaluator, appender, checkpoint-reader, and
bounded-exporter capabilities are all present. Its cycle deadline both aborts
the shared signal and races every port promise, so an uncooperative hung port
cannot keep the caller pending past the configured deadline. This contract is
not a production scheduler.

The operations server accepts only the disabled alert configuration. It rejects
`OPERATIONS_ALERT_EVALUATION_ENABLED=true` even when a structurally complete
capability JSON value is supplied, and the container independently repeats
that guard before it can construct the dashboard or readiness probe. Therefore
there is no configuration in which alert evaluation is accepted but inert, nor
can the operations health route report green for a requested alert scheduler
that does not exist. Production Compose remains explicitly
`OPERATIONS_ALERT_EVALUATION_ENABLED: "false"`.

## Remaining alert-activation and production-evidence gates

The route exists, but the scheduler and delivery path must remain disabled until
all of the following are evidenced:

1. Official-offer trust migrations and operations migration 024 are proved
   against fresh-install and upgrade PostgreSQL. Migration 024 provides
   database-owned persistence clocks, an append-only alert ledger, the
   dashboard projection, strict alert/checkpoint writes, and bounded transition
   export. Candidate-current live proof must still establish checkpoint
   retention and concurrency-safe idempotency before production activation.
   Bind the exact roster version, canonical entries, required signals/job
   kinds, and SHA-256 to the candidate release/coverage manifest; no production
   default or database-derived roster is permitted.
2. While scheduling remains disabled, candidate-current PostgreSQL proof must
   confirm that `handleplan_operations` has only CONNECT, schema USAGE, and
   EXECUTE on `operations_dashboard_rows_v1`. Migration 027 explicitly removes
   its alert append/export capabilities and direct publication-health access.
   Alert activation must provision a separately reviewed scheduler/delivery
   identity and readiness contract; do not expand the read-only dashboard role.
3. Candidate-current Cloudflare proof must confirm the distinct operations
   application/audience and denial for missing, forged, expired, wrong issuer,
   wrong audience, wrong host, public paths, and review credentials. Unit tests
   prove code behavior only; site-wide preview Access is not this proof.
4. Specify authenticated aggregate producers for API latency/error/saturation,
   PostgreSQL saturation, backup completion, disk capacity, and certificate
   validity. Their inputs must already be fixed buckets; log bodies and request
   attributes must never enter this service.
5. Run live PostgreSQL integration tests for simultaneous evaluators, corrupt
   legacy rows, event transitions, privilege denial, and clock ownership.
   Migration 024 adds targeted worker, source-health, and alert-identity indexes
   plus bounded operation-role timeouts. Candidate-current plans must prove
   their use and add any missing eligible-price, offer, review, extraction, and
   evaluation-checkpoint indexes before alert activation.
6. Configure an alert destination outside the VPS failure domain, retention,
   owner/escalation policy, and dead-man signal. Drill warning, critical,
   recovery, missing collector, delivery failure, and duplicate evaluation.
7. Record candidate-current evidence for backup/restore, disk, certificate,
   database, source, worker, API, and external-monitor alerts before changing
   the release gate.

Until every gate is evidenced and a real scheduler composition plus scheduler
readiness contract are implemented, the dashboard is a protected internal
observation surface only, every operations runtime must keep alert evaluation
exactly `false`, and no recipient delivery is claimed. The
public source-status page remains the only public source-health surface and
must not expose private review or infrastructure data.

## Verification available in this repository

```sh
corepack pnpm --filter @handleplan/domain test
corepack pnpm --dir packages/db exec vitest run src/operations-dashboard.test.ts
corepack pnpm --dir packages/db exec vitest run src/operations-runtime.test.ts src/operations-runtime-boundary.test.ts
corepack pnpm --dir apps/worker exec vitest run src/operations-alert-runtime.test.ts
corepack pnpm --dir apps/web exec vitest run lib/server/operations-service.test.ts lib/server/operations-runtime-service.test.ts lib/server/operations-access.test.ts lib/server/operations-env.test.ts app/api/internal/operations/snapshot/route.test.ts app/internal/operations/page.test.tsx components/operations/operations-workspace.test.tsx proxy.test.ts
```

Unit tests prove schema rejection, bounded mapping, auth-first/no-enumeration,
distinct-audience enforcement, aggregate-only function invocation, fail-closed
alert activation, hard timeout racing for hung ports, response bounding, and UI
nonclaims. Existing tests also
prove worst-required signal/job
aggregation, confirmed/unexpected/failed empty-result semantics, exact alert
matrix, canonical lock ordering, unknown-as-open behavior, monotonic evaluation
checkpoints, state-change-only alert SQL construction, escalation/recovery,
final-insert cancellation refusal, and exact directory enforcement. They do not
prove live PostgreSQL, deployed role grants, configured Cloudflare Access,
production scheduling, retention, off-host exporter delivery, alert delivery, VPS
operation, or public availability.
