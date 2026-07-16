# Database backup and restore evidence

The CI step `Prove migration upgrade and backup restore` runs
`tests/acceptance/prove-database-upgrade.mjs` against real PostgreSQL. It uses
the same pinned PostgreSQL 16.10 image as CI for both `pg_dump` and
`pg_restore`.

## What the proof establishes

The proof creates only the fixed ephemeral databases
`handleplan_ci_v1_03_source` and `handleplan_ci_v1_03_restore`. It applies
migration 001 to the source database, inserts a representative `price_cache`
row, then applies migrations 002 through 008 and repeats the full migration
run. It verifies that the original row and all eight migration checksums remain
unchanged.

The 001-era row is backfilled through the synthetic `legacy-import` source.
Its observation remains ordinary-only (`ordinary_only`), its linked coverage is
explicitly `ineligible` because provenance is missing, the source remains
blocked, and no official claims are created from it.

Before the dump, deterministic fixtures add a source permission audit, private
publication capture metadata, and a rejected review audit. After `pg_restore`,
the proof checks those exact records, the legacy row and classification, and
the complete migration ledger. The restored database is also migrated again,
which proves that the restored checksums remain compatible with an idempotent
runner. Because the dump intentionally excludes ownership and privileges, that
post-restore migration run also reapplies and verifies the runtime-role grant
policy.

## Migration owner and runtime role

Production has two non-interchangeable database identities:

- `handleplan` owns the database and is available only to the one-shot
  `migrate` service through `DATABASE_MIGRATION_URL`;
- `handleplan_app` is the web/worker runtime role and is available through
  `DATABASE_URL` only.

`POSTGRES_PASSWORD` and `APP_DATABASE_PASSWORD` must be distinct, independently
generated URL-safe secrets of 32-128 characters in the protected VPS
`production.env`. Compose refuses to render when either is empty. The migration
runner also refuses a missing, malformed, shared, or runtime-role migration
credential. Do not pass either password on a command line or record it in an
artifact.

Every full migration run reconciles `handleplan_app` after applying schema
migrations. The role is forced to `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOINHERIT`, `NOREPLICATION`, and `NOBYPASSRLS`; deployment fails if it owns an
object or belongs to another role. It receives schema usage, explicit runtime
table/sequence grants, and no schema creation. Governance metadata is narrower:
`data_sources` and `source_permissions` are read-only, so a compromised runtime
cannot approve a source or fabricate permission. Runtime-produced append-only
evidence/audit tables receive only `SELECT` and `INSERT`; the role receives no
`UPDATE`, `DELETE`, trigger control, or direct execution permission on the
append-only guard.

The request-budget event table is ephemeral coordination state, not durable
price evidence. `handleplan_app` receives only `SELECT`, `INSERT`, and `DELETE`
so independent processes can count attempts and prune expired events. It has no
`UPDATE`, ownership, schema DDL, or sequence grant for this table. Restored
events are harmless bounded state: the coordinator uses PostgreSQL time and
deletes events outside the configured rolling window before each claim.

Web and the planned worker still share `handleplan_app`. This is a bounded v1
deployment gap, not the final least-privilege shape: a later deployment slice
must split web-read and worker-write roles before adding any private governance
writer. The generic runtime role must not regain source-state or permission
decision writes as a shortcut.

There is no session-variable maintenance bypass. Exceptional correction or
erasure of protected evidence requires a reviewed, owner-run forward migration
with its own evidence and rollback/readback plan; it must never be exposed to a
web or worker process.

## Restore and rollback sequence

After restoring a custom-format dump with `--no-owner --no-privileges`, run the
current candidate's `deploy/migrate.mjs` with `DATABASE_MIGRATION_URL` and
`APP_DATABASE_PASSWORD` before starting web or worker containers. This step is
required even when every migration checksum is already present: it recreates
the role policy that the dump intentionally omitted. Then read back the
migration ledger and the runtime capability matrix before opening traffic.

Image rollback remains forward-only. `deploy/deploy-on-vps.sh` uses the current
candidate image for the migrator even when it restores the previous app image,
and Compose overrides the app entrypoint so a pre-separation image cannot run
its embedded owner migration under `handleplan_app`. No down migration is
attempted. A rollback image must still work with the current schema and the
documented runtime grant matrix; a failed health check is a failed rollback,
not permission to return owner credentials to the app.

## Safety boundary

The harness requires `CI=true`, an absolute migration directory, a loopback
admin database URL, a distinct URL-safe app-role placeholder password, a local
Docker client host, and one of the two fixed proof database names. It refuses
to replace a pre-existing proof database. Passwords are supplied only through
CI environment placeholders and are not included in the Docker command line.
The temporary custom-format dump and both proof databases are removed at the
end of the run.

The separate `Prove runtime database least privilege` step creates one isolated
proof database. It demonstrates successful runtime inserts/reads and worker
lease/health grants, then demonstrates that `handleplan_app` cannot update or
delete protected rows, use the former custom GUC, disable the trigger, switch
replication mode, create schema objects, call the guard directly, or `SET ROLE`
to the migration owner.

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
