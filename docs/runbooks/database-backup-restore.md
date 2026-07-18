# Database backup and restore evidence

The CI proof described here is separate from the disabled encrypted off-host
foundation and operator drill in
[`offhost-backup-restore.md`](offhost-backup-restore.md). Neither document may
be used to imply that a production backup or external recovery has occurred.

The CI step `Prove migration upgrade and backup restore` runs
`tests/acceptance/prove-database-upgrade.mjs` against real PostgreSQL. It uses
the same pinned PostgreSQL 16.10 image as CI for both `pg_dump` and
`pg_restore`.

## What the proof establishes

The proof creates only the fixed ephemeral databases
`handleplan_ci_v1_03_source`, `handleplan_ci_v1_03_restore`, and
`handleplan_ci_v1_03_completion_clock`. It applies
migration 001 to the source database, inserts a representative `price_cache`
row, then applies every remaining repository migration and repeats the full
migration run. It verifies that the original row and the complete migration
ledger remain unchanged.

The completion-clock database is staged through migration 013. It proves that
migration 014 rejects and fully rolls back a pre-existing future completion,
then applies after that corrupt fixture is removed without rewriting a valid
013-era terminal row.

The 001-era row is backfilled through the synthetic `legacy-import` source.
Its observation remains ordinary-only (`ordinary_only`), its linked coverage is
explicitly `ineligible` because provenance is missing, the source remains
blocked, and no official claims are created from it.

Before the dump, deterministic fixtures add a source permission audit, private
publication capture metadata, a rejected review audit, an append-only worker
schedule result, and a completed-run append-only catalog observation with
separate source-update and retrieval clocks. It also records one reviewed-family
membership whose private reviewer identity is exposed publicly only as an
attestation boolean. After `pg_restore`,
the proof checks those exact records, the legacy row and classification, and
the complete migration ledger. The restored database is also migrated again,
which proves that the restored checksums remain compatible with an idempotent
runner. Because the dump intentionally excludes ownership and privileges, that
post-restore migration run also reapplies and verifies the runtime-role grant
policy.

## Migration owner and runtime roles

Production has four non-interchangeable database identities:

- `handleplan` owns the database and is available only to the one-shot
  `migrate` service through `DATABASE_MIGRATION_URL`;
- `handleplan_app` is the bounded ingestion-worker role;
- `handleplan_web` is the public Next.js read-only role and is the normal web
  `DATABASE_URL` identity;
- `handleplan_review` is the private review runtime role used only through the
  access-protected review boundary and its separate `REVIEW_DATABASE_URL`.

`POSTGRES_PASSWORD`, `APP_DATABASE_PASSWORD`, `WEB_DATABASE_PASSWORD`, and
`REVIEW_DATABASE_PASSWORD` must be pairwise distinct, independently generated
URL-safe secrets of 32-128 characters in the protected VPS `production.env`.
Compose refuses to render when any is empty. The migration runner refuses a
missing, malformed, or shared credential before connecting. Do not pass
passwords on a command line or record them in an artifact.

Every full migration run reconciles all runtime roles after applying schema
migrations. All are forced to `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOINHERIT`, `NOREPLICATION`, and `NOBYPASSRLS`; memberships are removed,
and a pre-existing runtime-owned database, schema, relation, or function aborts
the migration instead of being silently reassigned. The zero-ownership state is
verified before `PUBLIC`, current-role, and default table, sequence, and
function privileges are revoked and the explicit grants are rebuilt.

`handleplan_app` receives only the implemented worker surface: governance and
migration-ledger reads; `SELECT/INSERT/UPDATE` for
cache, canonical catalog, ingestion-run, source-product, and physical-store
state; `SELECT/INSERT` for append-only catalog observations, price evidence,
coverage, source outcomes, and schedule results; lease CRUD; request-budget
`SELECT/INSERT/DELETE`; read-only source governance and national geographic
scope needed by the previous-image evidence reader; and only its allowlisted write
sequences. It does not inherit the public web table allowlist. It cannot alter
source permissions, read or write reviewed-family taxonomy state, rewrite
append-only evidence, or access the private capture/review/candidate pipeline.

`handleplan_web` receives no DML or sequences. Its only function grant is
EXECUTE on `claim_public_api_request_budget(text)`, whose fixed-policy
SECURITY DEFINER implementation can append only an allowlisted route class and
server timestamp; the role has no direct access to that ephemeral table. Its
table reads are an explicit public allowlist for readiness, persisted prices, completed-run
catalog observations, evidence/coverage, and geography. Tables not consumed by the public
Next.js read model, including offer candidates and conditions, publication
ingestion, postal-scope, and historical-statistics state, remain
ungranted. Offer access requires a filtered public reader or view that excludes
candidate and source-reference internals. Source, permission, source-product,
and public-health reads use column grants that exclude private reference keys,
raw normalized source fields, internal kill-switch details, and review-queue
details. It cannot read captures, extraction candidates, review actions,
leases, provider request budgets, public API budget rows, or worker schedule
results. Off-host backup keeps the public API budget schema but excludes its
ephemeral rows.

After migration 021, `handleplan_review` has no direct table, column, or sequence
privilege. It may execute only the bounded rights-current candidate reader and
the typed decision transaction. The reader is the sole queue/detail/locator
projection; the decision function is the sole append boundary. This prevents a
runtime compromise from bypassing eligibility with direct `SELECT`, forging an
offer/review row, consuming a sequence, or invoking an unrelated function.
Upgrade proofs intentionally capped before 021 recreate the historical grants
only for that older schema state, then the complete migration removes them.

Migration 018 keeps extracted candidates append-only. Migration 021 also keeps
approval/correction fail closed with `EVIDENCE_UNAVAILABLE` until a
candidate-bound capture renderer exists; only a rejection can currently append
a `review_actions` row. Public offer projection and publication remain separate,
disabled boundaries owned by later migrations and cannot be invoked by the
review role.

Reviewed-family reads are a narrower exception: the web role can select the
immutable version, definition, and alias tables plus the security-barrier
`reviewed_family_membership_public` view. It cannot select the private decision
table, so immutable reviewer identities stay operator-only while the reader can
require `reviewer_attested = true`. No runtime role can append taxonomy
definitions or membership decisions.

The request-budget event table is ephemeral coordination state, not durable
price evidence. `handleplan_app` receives only `SELECT`, `INSERT`, and `DELETE`
so independent processes can count attempts and prune expired events. It has no
`UPDATE`, ownership, schema DDL, or sequence grant for this table. Restored
events are harmless bounded state: the coordinator uses PostgreSQL time and
deletes events outside the configured rolling window before each claim.

The public web composition does not install the PostgreSQL request-budget
writer and wraps persisted price storage in a read-only adapter. Upstream rows
cannot be admitted by the web role; normal public results must come from the
persisted worker-owned evidence path.

There is no session-variable maintenance bypass. Exceptional correction or
erasure of protected evidence requires a reviewed, owner-run forward migration
with its own evidence and rollback/readback plan; it must never be exposed to a
web, worker, or review process.

Catalog publication also depends on immutable ingestion provenance. New run
rows must begin as `running`; their job identity, source, run type, start time,
and creation time cannot change. The database permits exactly one transition
from `running` to a terminal status with a completion time, then rejects every
later update and every delete. This prevents a degraded or failed catalog
attempt from being relabeled as completed after the fact while preserving
idempotent application finalization, which reads an already-terminal result
without issuing another update.

Migration 012 adds an independent, database-owned `terminalized_at` clock to
that transition. Callers must leave it null; the lifecycle trigger sets it from
PostgreSQL `statement_timestamp()` and terminal rows make it immutable. Older
terminal runs are conservatively backfilled no earlier than the migration
transaction and row-creation clocks, so a historical read before migration 012
fails closed. Public price,
catalog, planning, and reviewed-family readers require both business clocks and
persisted creation/terminalization clocks to be no later than their requested
snapshot. A row inserted later with backdated observation or completion times
therefore cannot appear retroactively.

Migration 012 also seals the write order at the database boundary. Before any
catalog observation, price observation, coverage check, or source-record
outcome is inserted, a trigger locks its parent ingestion run and requires the
run to still be `running`. Finalization takes the same row lock. Consequently,
an evidence append either commits before the one terminal transition or is
rejected; a compromised worker cannot attach a backdated child to a completed
run. The production repository already follows this order (all outcome writes,
then finalization), and the legacy price mirror performs the same sequence in
one transaction.

The same guard binds public evidence to run purpose. Catalog observations
require `catalog`; ordinary observations require `benchmark-prices` or the
explicit `interactive_price_mirror`; historical observations require
`historical-prices` and `historical_eligible`; coverage is allowed only on the
ordinary-price run types. A price observation's source must equal its parent
run source. Migration validates existing rows, with one narrow grandfathered
exception for the blocked `legacy-import` / `price_cache_backfill` evidence
created before these guards existed.

Creation timestamps for those append-only child rows are overwritten from
PostgreSQL `statement_timestamp()`. Source-permission decisions and reviewed
family membership decisions receive the same database-owned insertion clock;
pre-012 source-permission rows are conservatively moved to the migration
boundary. Taxonomy versions, definitions, and aliases keep their specialized
transaction-clock build window and deferred content seal instead of the generic
statement clock, because every valid publication must be assembled atomically
in its creation transaction.

The same migration adds `public_state_changed_at`, a separate database-owned
mutation clock, to data sources, canonical products, product identifiers, and
geographic scopes. Their existing `updated_at` values remain business/source
metadata and are not accepted as persistence clocks. A trigger overwrites any
caller-supplied public-state timestamp on every insert or update, and every
as-of reader requires the resulting clock to be no later than its snapshot.
Scope membership rows receive a database-owned creation clock and are
append-only; planning reads include only memberships persisted by the snapshot.
Existing rows and memberships are conservatively backfilled at migration 012,
so snapshots before that migration do not gain unproven public state.

This is deliberately fail-closed rather than full bitemporal reconstruction.
After a later approval, correction, revocation, or identity edit, an old
snapshot may become unavailable; it never substitutes the new value into that
old snapshot. Reconstructing the exact former value would require immutable
version rows for each mutable entity and is outside the V1 storage contract.
The clocks are stamped while the writing statement runs, so correctness also
assumes the existing short, transaction-bounded worker writes; PostgreSQL does
not expose a portable commit timestamp for this contract. Long-running owner
transactions that straddle a captured wall-clock timestamp remain an operator
boundary and must not be used for public-state changes.

Migration 013 adds immutable, run-scoped physical-store observations and
explicit per-chain completeness checks. Migration 014 locks ingestion-run
writes while validating the upgrade, rejects a caller-supplied completion in
the future, and constrains `completed_at` to be no later than the
database-stamped `terminalized_at`.

Migration 015 adds nullable `category_path` evidence to the existing immutable
catalog observation. `NULL` remains unknown or not captured, while `[]` is an
explicitly empty path. The migration leaves existing
observations as `NULL`, requires exact bounded entries with JS-safe decimal
source IDs in canonical depth-and-ID order, adds a partial GIN index for
non-null paths, and inherits the catalog table's existing append-only and
running-run guards.

Migration 016 links each worker-written source-health snapshot to one immutable
terminal worker result. It adds a unique replay key, makes worker snapshots
append-only, restricts them to source-wide aggregate clocks and an empty details
object, and checks the result-to-health mapping in PostgreSQL. A completed
processing result with accepted records is healthy, partial progress is
degraded, and a nominal success with zero accepted rows is degraded as a
silent-zero ingestion.
Worker counts may advance capture and catalog-discovery clocks, but cannot
advance governed publish-success or eligible-evidence clocks. Failed and
timed-out results are failed. A cancelled result deliberately writes
no source-health assertion: when an ingestion began, its terminal row remains
visible and newer than the prior snapshot, so public status becomes unknown
instead of falsely claiming healthy or degraded. A cancellation before
ingestion starts remains only in the private worker-result ledger. Exact
worker-result replay is idempotent through the unique worker-job link.

Reviewed-family publications are sealed at commit against the exact stored
`content_json`, expected family and alias counts, and SHA-256 of deterministic
canonical JSON reconstructed from definition and alias rows. Deferred
constraint triggers are queued by inserts into the version, definition, and
alias tables, including inserts after an explicit `SET CONSTRAINTS ...
IMMEDIATE`. The migration runner additionally verifies the required 1.0.0 seed
and every stored publication on every run. That explicit readback is essential
after `pg_restore`, because PostgreSQL restores table data before post-data
constraint triggers are created.

The seal intentionally targets the pinned PostgreSQL 16 runtime. It uses the
built-in `sha256(bytea)` function, UTF-8 conversion, `jsonb`, and the built-in
`C` collation; it does not depend on `pgcrypto` or an operating-system locale.
Moving the database to another engine or an older PostgreSQL major requires a
canonicalization/checksum compatibility proof before migration.

## Restore and rollback sequence

After restoring a custom-format dump with `--no-owner --no-privileges`, run the
current candidate's `deploy/migrate.mjs` with `DATABASE_MIGRATION_URL`,
`APP_DATABASE_PASSWORD`, `WEB_DATABASE_PASSWORD`, and
`REVIEW_DATABASE_PASSWORD` before starting web or worker containers. This step
is required even when every migration checksum is already present: it recreates
the role policy that the dump intentionally omitted. Then read back the
migration ledger and every runtime capability matrix before opening traffic.

Image rollback remains forward-only. Failed, uncommitted candidates may restore
only the previous source-disabled public shell after proving all candidate
runtimes absent. A deliberate post-commit rollback instead uses
`deploy/rollback-on-vps.sh`: it requires a create-once commit-SHA-to-Docker-
image-ID binding, expected-current compare-and-swap guard, origin/main ancestry,
exact container readback, and the latest successful deployment controls. It
restarts app, review, operations, and worker without invoking any migration and
preserves a separate normal-deploy high-water revision. See
[`explicit-image-rollback.md`](explicit-image-rollback.md) for the command,
state machine, failure behavior, and evidence contract. No down migration is
attempted, and owner credentials are never returned to an app. Malformed,
partial, or conflicting state fails closed.

## Safety boundary

The harness requires `CI=true`, an absolute migration directory, a loopback
admin database URL, a distinct URL-safe app-role placeholder password, a local
pairwise-distinct URL-safe web-role placeholder password, a local Docker client
host, and one of the two fixed proof database names. It refuses
to replace a pre-existing proof database. Passwords are supplied only through
CI environment placeholders and are not included in the Docker command line.
The temporary custom-format dump and both proof databases are removed at the
end of the run.

The separate `Prove runtime database least privilege` step creates one isolated
proof database and connects as both roles. It compares their exact table ACLs
to committed allowlists and checks the web-only source/status column ACLs. It
then proves public readiness/catalog/evidence reads, including observation
payloads whose retrieval and source-update clocks survive independently;
denial of web DML, private
pipeline and worker-state reads, sequences, and functions; successful bounded
worker cache/evidence/run/lease/budget writes; and denial of permission forgery,
append-only rewrites, trigger bypass, DDL, functions, or owner-role assumption.

`CI_MAX_MIGRATION_ID` is an acceptance-test control, not a production rollout
control. The migration runner accepts it only when `CI=true`, only as an exact
existing migration filename, and otherwise retains the production default of
applying every repository migration.

## Deliberate non-claims

This CI round-trip does not prove encrypted off-host backup transport,
scheduled backup operation, retention enforcement, production RPO/RTO, a
clean-host recovery drill, or restoration of the private capture blobs
themselves. It proves PostgreSQL state and capture metadata only. Those wider
operational controls remain separate release-readiness work. The source-neutral
filesystem blob store is outside PostgreSQL and its worker-only volume is not
covered by this database proof.
