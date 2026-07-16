# Database backup and restore evidence

The CI step `Prove migration upgrade and backup restore` runs
`tests/acceptance/prove-database-upgrade.mjs` against real PostgreSQL. It uses
the same pinned PostgreSQL 16.10 image as CI for both `pg_dump` and
`pg_restore`.

## What the proof establishes

The proof creates only the fixed ephemeral databases
`handleplan_ci_v1_03_source` and `handleplan_ci_v1_03_restore`. It applies
migration 001 to the source database, inserts a representative `price_cache`
row, then applies migrations 002 through 011 and repeats the full migration
run. It verifies that the original row and all eleven migration checksums remain
unchanged.

The 001-era row is backfilled through the synthetic `legacy-import` source.
Its observation remains ordinary-only (`ordinary_only`), its linked coverage is
explicitly `ineligible` because provenance is missing, the source remains
blocked, and no official claims are created from it.

Before the dump, deterministic fixtures add a source permission audit, private
publication capture metadata, a rejected review audit, an append-only worker
schedule result, and a completed-run append-only catalog observation with
separate source-update and retrieval clocks. After `pg_restore`,
the proof checks those exact records, the legacy row and classification, and
the complete migration ledger. The restored database is also migrated again,
which proves that the restored checksums remain compatible with an idempotent
runner. Because the dump intentionally excludes ownership and privileges, that
post-restore migration run also reapplies and verifies the runtime-role grant
policy.

## Migration owner and runtime roles

Production has three non-interchangeable database identities:

- `handleplan` owns the database and is available only to the one-shot
  `migrate` service through `DATABASE_MIGRATION_URL`;
- `handleplan_app` is the bounded ingestion-worker role;
- `handleplan_web` is the public Next.js read-only role and is the normal web
  `DATABASE_URL` identity.

`POSTGRES_PASSWORD`, `APP_DATABASE_PASSWORD`, and `WEB_DATABASE_PASSWORD` must
be pairwise distinct, independently generated URL-safe secrets of 32-128
characters in the protected VPS `production.env`. Compose refuses to render
when any is empty. The migration runner refuses a missing, malformed, or shared
credential before connecting. Do not pass passwords on a command line or
record them in an artifact.

Every full migration run reconciles both runtime roles after applying schema
migrations. Both are forced to `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
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
scope needed by the previous-image evidence reader; and only the nine write
sequences. It does not inherit the public web table allowlist. It cannot alter
source permissions, rewrite append-only evidence, or access the private
capture/review/candidate pipeline.

`handleplan_web` receives no DML, sequences, or functions. Its table reads are
an explicit public allowlist for readiness, persisted prices, completed-run
catalog observations, evidence/coverage, and geography. Tables not consumed by the public
Next.js read model, including offer candidates and conditions, publication
ingestion, family-review, postal-scope, and historical-statistics state, remain
ungranted. Offer access requires a filtered public reader or view that excludes
candidate and source-reference internals. Source, permission, source-product,
and public-health reads use column grants that exclude private reference keys,
raw normalized source fields, internal kill-switch details, and review-queue
details. It cannot read captures, extraction candidates, review actions,
leases, request budgets, or worker schedule results.

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
web or worker process.

Catalog publication also depends on immutable ingestion provenance. New run
rows must begin as `running`; their job identity, source, run type, start time,
and creation time cannot change. The database permits exactly one transition
from `running` to a terminal status with a completion time, then rejects every
later update and every delete. This prevents a degraded or failed catalog
attempt from being relabeled as completed after the fact while preserving
idempotent application finalization, which reads an already-terminal result
without issuing another update.

## Restore and rollback sequence

After restoring a custom-format dump with `--no-owner --no-privileges`, run the
current candidate's `deploy/migrate.mjs` with `DATABASE_MIGRATION_URL`,
`APP_DATABASE_PASSWORD`, and `WEB_DATABASE_PASSWORD` before starting web or
worker containers. This step is required even when every migration checksum is
already present: it recreates the role policy that the dump intentionally
omitted. Then read back the migration ledger and both runtime capability
matrices before opening traffic.

Image rollback remains forward-only. `deploy/deploy-on-vps.sh` uses the current
candidate image for the migrator even when it restores the previous app image.
The atomic `state/current-deployment` manifest records the previous revision and
whether it uses `current` or `legacy` composition. A current rollback retains
the worker and web/worker role split. Only the transition from an old
revision-only state uses `compose.rollback-legacy.yml`, removes the worker, and
checks `/api/health` instead of `/api/ready`. That previous app remains on the
read-only `handleplan_web` role and receives only non-secret, source-disabled
compatibility variables; it can serve cached reads but cannot claim
request-budget writes or reach the Kassal API. This is a safe-degraded rollback,
not proof of search, refresh, or full planning. Malformed or inconsistent state
stops automatic rollback.
No down migration is attempted, and owner credentials are never returned to an
app.

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
operational controls remain separate release-readiness work.
