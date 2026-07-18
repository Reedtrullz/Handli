# Encrypted off-host backup and isolated restore drill

**Operational state:** disabled, source-neutral foundation only.

This runbook defines the V1-17 database and private-capture backup boundary. The repository has not
executed a production backup and does not claim an off-host destination,
retention policy, schedule, restore drill, clean-host recovery, RPO, or RTO. The
CI database round trip in
[`database-backup-restore.md`](database-backup-restore.md) is separate evidence.

## Implemented safety contract

`node deploy/backup/create-backup.mjs` refuses to run unless explicitly enabled.
It accepts configuration only through named environment variables and connects
through a protected libpq service file plus a separate mode-0600 password file.
No database URL or credential is placed in a command argument or output.
The service file is copied once into the private run directory and the selected
section must bind the expected database and role to one absolute Unix-socket
directory and one port. Remote hosts, host lists, `hostaddr`, and nested service
selection are rejected. All probes and dump/restore commands use that pinned
copy. This foundation therefore requires colocated socket access; remote
PostgreSQL backup is not supported.

Backup adds a transaction-level binding on top of that route restriction. One
long-lived `psql` session starts a repeatable-read, read-only transaction, reads
the database/role/server identity, migration ledger, and required-relation
checks, then calls `pg_export_snapshot()`. The session and transaction remain
open while `pg_dump --snapshot=<exported id>` produces the archive. An endpoint
swap or redirection between the probe and dump cannot silently succeed because
another PostgreSQL cluster cannot import that live exported snapshot. The dump
ledger must also equal the ledger read by the exporting transaction. The
manifest records `postgresql-exported-snapshot-v1`; the snapshot identifier is
ephemeral and is not retained.

This is code and synthetic negative-path proof, not a production backup result.
Restore also binds execution to its probe session: `pg_restore` runs offline as
an SQL transformer with no libpq environment or `--dbname`, and its guarded SQL
stream executes through the same long-lived `psql` connection that proves the
target identity and clean-room catalog before the transaction and proves the
identity again after commit. Live endpoint-redirection evidence remains an
activation gate.

Before dumping, the command verifies the operator-pinned database name, role,
and SHA-256 of the PostgreSQL server system identifier. It requires the live
migration ledger to match the checked-out migration files exactly and verifies
the required evidence relations. The PostgreSQL identity query uses
`pg_control_system()`; the backup role must have no privileged role attribute,
explicit membership, or database ownership and needs only narrowly reviewed
execution access to that function.

The tool never creates a plaintext dump file. Plaintext archive bytes still
exist transiently in process memory and kernel pipe buffers. One `pg_dump
--format=custom --no-owner --no-privileges --snapshot=<exported id>` stdout stream feeds four bounded
consumers:

1. `age` authenticated encryption into the private ciphertext file;
2. `pg_restore --list` custom-archive validation; and
3. `pg_restore --data-only --table=handleplan_schema_migrations` ledger
   extraction; and
4. `pg_restore --data-only --table=publication_captures` private-capture ledger
   extraction.

`pg_dump` also uses
`--exclude-table-data=public.public_api_request_budget_events`. The archive
retains that table's schema and the migration/function contract, but not its
ephemeral route-class timestamps. Those rows are admission-control state, not
shopper or evidence data, and are deliberately excluded from restore and all
semantic-backup claims.

The pipeline stops if any consumer fails, exceeds its timeout, or exceeds a
bounded output/artifact limit. The exporting session stays open through dump
completion and must close cleanly before any upload. Its transaction ledger and
the embedded archive ledger must match, so a wrong endpoint, expired snapshot,
or inconsistent archive cannot publish a green manifest. Scratch cleanup
therefore handles ciphertext and metadata only; it
does not clean or make confidentiality claims about process memory, core dumps,
swap, crash dumps, or host-level forensic storage.

The command creates `SHA256SUMS` for both ciphertexts and the completed manifest, and
a bounded JSON manifest that cross-binds:

- dataset, UTC creation time, backup ID, date prefix, and exact object key;
- ciphertext byte length and SHA-256;
- source database, role, hashed probed-server identity, schema contract, and exact
  migration ledger;
- separate database/capture artifact, entry-count, and plaintext-byte limits; and
- declared retention days and computed retain-until timestamp.

The upload adapter receives the database ciphertext, private-capture
ciphertext, checksum file, and manifest in that order. Every operation is
`put-create-only`; the manifest is uploaded last and acts as the only completion marker. Local
evidence is written only after all four adapter calls succeed.
Every psql or adapter command runs in its own process group. Timeout or bounded
output failure sends TERM, waits two seconds, sends KILL, and waits for the
direct child to close. The systemd examples additionally use
`KillMode=control-group` so service timeout/stop also covers descendants.

All configured `psql`, `pg_dump`, `pg_restore`, `age`, and adapter executables,
plus the public age recipients file, must resolve to canonical regular files
owned by root or the executing service account and not writable by group or
others. The tool checks the files, but does not mechanically attest the full
parent-directory/package chain. Activation therefore also requires root-owned,
non-untrusted-writable parent directories and retained package/digest provenance;
otherwise a local rename can replace a checked executable between validation
and spawn.

`age` and SHA-256 authenticate ciphertext bytes against corruption. This does not authenticate backup origin.
The manifest is not signed. Operator pinning of the selected backup ID, object
key, and ciphertext hash limits accidental replay or misattribution, but signed
manifest provenance remains an activation gap.

## Upload adapter boundary

There is no bundled provider adapter. In particular, rclone `copyto
--immutable` may exit successfully when an identical destination already
exists, so it cannot satisfy the required atomic create-only publication
contract. It is deliberately not used as proof of a new backup.

`HANDLEPLAN_BACKUP_UPLOAD_ADAPTER` must name a separately reviewed executable.
The orchestrator invokes it with no arguments and supplies only these fields:

- `HANDLEPLAN_BACKUP_UPLOAD_OPERATION=put-create-only`
- `HANDLEPLAN_BACKUP_UPLOAD_SOURCE_FILE`
- `HANDLEPLAN_BACKUP_UPLOAD_OBJECT_KEY`
- `HANDLEPLAN_BACKUP_UPLOAD_MEDIA_TYPE`
- `HANDLEPLAN_BACKUP_UPLOAD_RETENTION_UNTIL`
- `HANDLEPLAN_BACKUP_UPLOAD_TIMEOUT_MS`

An approved adapter must provide atomic create-if-absent semantics, fail on an
existing key including identical content, suppress provider diagnostics that
may contain endpoints, keep credentials in protected environment/config files,
remain in the foreground until durable completion, and implement no list,
delete, purge, move, sync, or retention-pruning path. A zero exit that leaves a
descendant process is rejected after the process group is reaped.
Provider selection, atomic-create proof, destination immutability, lifecycle
configuration, and live restore retrieval remain blocked external gates.

`HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER` is a distinct restore-custody executable.
It receives no arguments and only:

- `HANDLEPLAN_RESTORE_DOWNLOAD_OPERATION=get-create-only`
- `HANDLEPLAN_RESTORE_DOWNLOAD_DESTINATION_FILE`
- `HANDLEPLAN_RESTORE_DOWNLOAD_OBJECT_KEY`
- `HANDLEPLAN_RESTORE_DOWNLOAD_EXPECTED_BYTES`
- `HANDLEPLAN_RESTORE_DOWNLOAD_EXPECTED_SHA256`
- `HANDLEPLAN_RESTORE_DOWNLOAD_TIMEOUT_MS`

It must atomically create the named absent destination, fail if it exists,
remain in the foreground, suppress provider diagnostics, and provide no list,
delete, sync, or mutation capability. Backup upload and restore download
credentials belong to different principals/configuration. No provider adapter
is bundled, so this interface is implemented but not live-proven.

## Private-capture boundary

The source-neutral capture backup supports only the frozen filesystem layout
`official-offers/private/v1/<source SHA-256>/<positive publication ID>/<content
SHA-256>`. The configured root must be canonical, nonsymbolic, mode 0700, and
owned by the separately pinned worker UID. Every path component is checked as
an owner-matching 0700 directory. Every selected blob must be a nonsymbolic
regular owner file, mode 0400, single-link, at most 50 MiB, and match its key,
database publication ID, byte length, and SHA-256 before and after
descriptor-based reads.
Unexpected layout entries, unsafe modes, hard links, missing files, checksum
conflicts, bounds, and observed mutation fail the run before any upload.

Selection is not an arbitrary directory archive. A fourth bounded consumer of
the exact `pg_dump` stream extracts `publication_captures`. Only those
database-archive-referenced blobs enter the bundle. The complete store is
scanned before and after bundle production so observed concurrent mutation also
fails closed, but unreferenced/orphan files are deliberately not claimed as
backed up. Orphan detection and reconciliation remain a separate operational
gate.

The custom length-framed bundle streams directly into a second `age` process;
there is no plaintext bundle, tar, or zip file. Blob keys and per-entry metadata
remain inside the encrypted stream. The plaintext manifest exposes only bounded
aggregate count/bytes plus inventory and database-ledger digests. Its capture
fields cross-bind the ciphertext filename, date-derived object key, byte length,
SHA-256, format, selection contract, and the same-dump database ledger.

The tool cannot establish whether one shared off-host retention period is
authorized for every source/right classification. Rights-aware retention review
therefore remains an activation gate even though the encrypted source-neutral
bundle and verification path are implemented.

## Separate backup and restore custody

Routine backup runs as an unprivileged, networked `handleplan-backup` account.
It receives only the public age recipients file and write-only adapter access.
It must never read an age restore identity.

The worker-owned 0700/0400 Docker volume is not directly readable by that
principal. Production activation requires a separately reviewed read-only bind
or snapshot plus narrowly scoped filesystem ACL that preserves the worker's
owner/mode contract. The repository does not install that mount or prove its
custody. Making the backup account the writable capture owner is not an
acceptable shortcut.

Restore runs manually under a different `handleplan-restore` principal,
preferably on a separate isolated host. The age identity is supplied just in
time from offline custody into protected runtime storage, removed after the
drill, and never placed in the routine backup account, persistent uploader
environment, command arguments, logs, tickets, or evidence. The inert restore
systemd example reads configuration from `/run/handleplan-restore` and has no
timer or install section.

Both inert units execute from
`/opt/apps/handleplan/operations/current/deploy/backup/`. A normal deploy stages
`deploy/backup`, `deploy/migrations`, and the rollback controls from the
checksum-verified CI source archive into `operations/releases/<revision>/` and
verifies any existing release byte-for-byte before runtime quiesce. Immediately
after migration succeeds, before candidate application startup or readback, it
atomically repoints `operations/current` and reads the exact release manifest
back. If candidate startup then fails, public-only image fallback does not move
that link backward because the database remains forward-migrated. Catchable
cleanup also attempts activation after a migration command begins, since an
unsuccessful multi-file run may already have committed an earlier forward file.
The operations pointer is not an application deployment record and does not
advance immutable image or deployment-high-water state.
The old `/opt/apps/handleplan/current/` path is not part of the deploy layout and
must not be used when installing these examples. The examples remain disabled;
the presence of an operations release is not evidence that a service or timer
was installed.

## Backup configuration names

Review names and permissions without printing values or file contents.

| Purpose | Required name |
|---|---|
| Explicit activation | `HANDLEPLAN_BACKUP_ENABLED` |
| Work root, owned and mode 0700 | `HANDLEPLAN_BACKUP_WORK_DIR` |
| Local evidence root, owned and mode 0700 | `HANDLEPLAN_BACKUP_EVIDENCE_DIR` |
| Command timeout in milliseconds | `HANDLEPLAN_BACKUP_COMMAND_TIMEOUT_MS` |
| Maximum ciphertext bytes | `HANDLEPLAN_BACKUP_MAX_ARTIFACT_BYTES` |
| Canonical read-only capture root | `HANDLEPLAN_BACKUP_CAPTURE_ROOT` |
| Pinned worker owner UID | `HANDLEPLAN_BACKUP_EXPECTED_CAPTURE_OWNER_UID` |
| Maximum selected capture files | `HANDLEPLAN_BACKUP_MAX_CAPTURE_FILES` |
| Maximum capture plaintext bytes | `HANDLEPLAN_BACKUP_MAX_CAPTURE_PLAINTEXT_BYTES` |
| Maximum capture ciphertext bytes | `HANDLEPLAN_BACKUP_MAX_CAPTURE_ARTIFACT_BYTES` |
| Maximum extracted capture-ledger bytes | `HANDLEPLAN_BACKUP_MAX_CAPTURE_LEDGER_BYTES` |
| Dataset label | `HANDLEPLAN_BACKUP_DATASET_ID` (optional) |
| libpq service name | `HANDLEPLAN_BACKUP_PGSERVICE` |
| Protected libpq service file | `HANDLEPLAN_BACKUP_PGSERVICE_FILE` |
| Protected libpq password file | `HANDLEPLAN_BACKUP_PGPASS_FILE` |
| Pinned source database | `HANDLEPLAN_BACKUP_EXPECTED_DATABASE` |
| Pinned source role | `HANDLEPLAN_BACKUP_EXPECTED_ROLE` |
| Pinned source server-ID hash | `HANDLEPLAN_BACKUP_EXPECTED_SERVER_ID_SHA256` |
| Current migration directory | `HANDLEPLAN_BACKUP_MIGRATIONS_DIR` |
| Absolute `pg_dump` executable | `HANDLEPLAN_BACKUP_PGDUMP_BIN` |
| Absolute `pg_restore` executable | `HANDLEPLAN_BACKUP_PGRESTORE_BIN` |
| Absolute `psql` executable | `HANDLEPLAN_BACKUP_PSQL_BIN` |
| Absolute `age` executable | `HANDLEPLAN_BACKUP_AGE_BIN` |
| Age recipients file | `HANDLEPLAN_BACKUP_AGE_RECIPIENTS_FILE` |
| Absolute reviewed upload adapter | `HANDLEPLAN_BACKUP_UPLOAD_ADAPTER` |
| Retention contract in days | `HANDLEPLAN_BACKUP_RETENTION_DAYS` |

The work, evidence, and capture roots are pairwise separate and non-nested. A run lock prevents
concurrent execution. A crash may leave a stale lock, which blocks the next run
until an operator confirms service/process state and open handles; stale-lock
removal is never automated. The systemd example also sets `LimitFSIZE`; use a
dedicated filesystem quota because the in-process ciphertext size check is not
a substitute for an operating-system storage bound.

## Retention and RPO

The retention value is recorded in the manifest and passed as object metadata.
It does not enforce expiry. A provider-side versioning/object-lock/lifecycle
policy must be approved and evidenced separately; this repository never deletes
remote data. Local manifests are evidence, not backups, and are not pruned by
this foundation.

The example services set `LimitCORE=0`. Before activation, an operator must also
verify that service and host core dumps are disabled and that swap is disabled
or encrypted; retained crash diagnostics and hibernation storage require the
same confidentiality review. These are activation prerequisites because
streamed plaintext exists transiently in memory and pipe buffers.

The inert timer example runs every twelve hours. That cadence leaves margin
under an initial at-most-24-hour RPO only after runtime, destination, manifest
completion, missing-backup alerting, and supervised restore evidence exist.
Measure RPO from the newest *restorable off-host completion*, not from a timer
invocation or local file.

## Isolated restore contract

Retrieve one completed manifest and database ciphertext into protected JIT
restore storage using separately approved read tooling. Record the backup ID,
not a URL. The tool itself retrieves the manifest-selected capture ciphertext
through a distinct, separately reviewed download adapter. It supplies no
credentials in arguments and requires `get-create-only` into a previously absent
path inside the mode-0700 scratch root. A symlink, nonregular file, wrong owner,
mode other than 0600, extra hard link, wrong byte length, or wrong digest fails
before either archive can mutate the database.
Before running `node deploy/backup/verify-restore.mjs`, independently pin the
full manifest SHA-256, backup ID, both object keys, and both ciphertext SHA-256 values from
retained trusted evidence. The tool copies and hashes the exact manifest before
using any source identity or ledger field. Because no signature exists, the
operator must establish that digest through separate trusted custody; the hash
alone does not prove origin.
The tool opens the selected path once, makes a bounded exclusive ciphertext
copy inside the mode-0700 restore work root, hashes that exact copy, and uses
only the copy for both decrypt passes. Replacing the originally selected path
after pinning therefore cannot change the archive being restored. A crash may
leave only encrypted scratch; the stale run lock blocks reuse until supervised
cleanup.

The command requires explicit isolation, cluster-review, and template0
provisioning acknowledgements. The operator must create the disposable database
from `template0` for this drill; the tool does not create it. Before executing
archive content it verifies all of the following:

- manifest ID/time/date/key/retention/hash/source-ledger cross-binding;
- full manifest bytes against the independently pinned manifest SHA-256;
- ciphertext bytes and SHA-256 against both manifest and operator pin;
- capture ciphertext bytes and SHA-256 against the manifest and independent
  operator pins;
- one no-write streaming capture decrypt that verifies exact magic, canonical
  bounded headers, sorted content keys, declared lengths, per-blob SHA-256,
  aggregate inventory/database-ledger digests, trailer, and exact EOF;
- selected backup ledger is an immutable prefix of current migrations;
- database, libpq service, and owner role use the dedicated
  `handleplan_restore_drill_*` naming contract;
- probed database, role, and hashed server system identifier equal independent
  operator pins;
- target probe identity differs from the backup source probe identity;
- connected role owns the disposable database but has `rolsuper`,
  `rolcreaterole`, `rolcreatedb`, `rolreplication`, and `rolbypassrls` all false;
- connected role has no explicit role memberships and owns no other database;
- target catalog has no custom namespaces, relations, functions, types,
  non-baseline extensions, or event triggers; and
- no `--create`, `--clean`, ownership, or privilege restoration is requested.

Names and acknowledgements alone do not prove a nonproduction cluster. The
separately captured probe identity, source/target probe mismatch, unprivileged owner
role, network isolation, and operator review are all required. A deliberately
misconfigured pin could still target the wrong cluster, so the runbook does not
claim the tool is intrinsically unable to reach production.

Restore uses two streaming decrypt passes and never writes a plaintext dump
file. Decrypted bytes still exist transiently in memory and pipe buffers, so the
core-dump and swap activation prerequisites apply equally to restore.
The first pass feeds only `pg_restore --list`; the list must satisfy the archive
contract before a target connection is opened. For the second pass,
`pg_restore --file=-` has no database credentials or connection argument and
only converts the authenticated custom archive to SQL. A bounded guard rejects
generated transaction control and every psql meta-command other than a matched
`\\restrict`/`\\unrestrict` pair; COPY data is tracked separately. In
particular, `\\connect`, `\\c`, include, shell, variable, and early-exit commands
cannot reach psql. The guarded stream runs inside a transaction owned by the
same psql session that emitted unpredictable-nonce identity and clean-room
markers. That session commits only after both decrypt and transformer succeed,
then emits a post-commit identity marker before it may close successfully.
After restore, the tool re-verifies database/server/role identity, exact manifest
ledger, and required evidence relations. It then canonicalizes restored
`publication_captures` and requires the exact count and SHA-256 ledger digest
already verified inside the encrypted capture bundle. Raw capture bytes are not
materialized by this verification command. They exist transiently only in the
decrypt process, Node buffers, and pipe buffers.

The retained status is `archive-restored-schema-verified`, not a statement that
database contents are complete or semantically correct. Evidence records
`semanticDataVerified: false`, the nonsecret target role and probed server-ID
hash, and the source/target probe mismatch. It sets
`archiveSessionServerBindingVerified: true` only after both the source exported
snapshot contract and the restore execution-session proof pass, and records
`archiveExecutionSessionBinding:
pg-restore-sql-same-psql-transaction-v1`. It also records the pinned
full-manifest digest, zero-membership result, and single-database-ownership result.
Representative row canaries, cardinality checks, and application reads remain
separate runtime evidence gates.

Capture evidence is aggregate-only:
`encrypted-archive-stream-verified`, ciphertext bytes/hash, selected entry
count, aggregate plaintext bytes, inventory digest, and restored-database-ledger
match. It contains no blob key, source identifier, right classification,
absolute path, raw byte, endpoint, or credential. This proves only a synthetic
and code-level verification path until a real provider retrieval and isolated
live drill are retained.

An older backup with a valid immutable migration prefix is accepted. Evidence
records `schemaState: forward-migration-required` and the pending count. The
operator must then run the current `deploy/migrate.mjs` with isolated owner and
distinct runtime-role credentials and separately prove the runtime ACL matrix.
The restore tool itself does not reconcile roles or make the database ready for
application traffic.

## Restore configuration names

| Purpose | Required name |
|---|---|
| Explicit activation | `HANDLEPLAN_RESTORE_DRILL_ENABLED` |
| Isolation acknowledgement | `HANDLEPLAN_RESTORE_ISOLATION_ACK` |
| Reviewed-cluster acknowledgement | `HANDLEPLAN_RESTORE_CLUSTER_ACK` |
| Template0 provisioning acknowledgement | `HANDLEPLAN_RESTORE_TEMPLATE_ACK` |
| Command timeout in milliseconds | `HANDLEPLAN_RESTORE_COMMAND_TIMEOUT_MS` |
| Maximum ciphertext bytes | `HANDLEPLAN_RESTORE_MAX_ARTIFACT_BYTES` |
| Pinned backup ID | `HANDLEPLAN_RESTORE_EXPECTED_BACKUP_ID` |
| Pinned object key | `HANDLEPLAN_RESTORE_EXPECTED_OBJECT_KEY` |
| Pinned ciphertext hash | `HANDLEPLAN_RESTORE_EXPECTED_CIPHERTEXT_SHA256` |
| Pinned capture object key | `HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_OBJECT_KEY` |
| Pinned capture ciphertext hash | `HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_CIPHERTEXT_SHA256` |
| Pinned full-manifest hash | `HANDLEPLAN_RESTORE_EXPECTED_MANIFEST_SHA256` |
| Expected disposable database | `HANDLEPLAN_RESTORE_EXPECTED_DATABASE` |
| Expected unprivileged owner role | `HANDLEPLAN_RESTORE_EXPECTED_ROLE` |
| Expected target server-ID hash | `HANDLEPLAN_RESTORE_EXPECTED_SERVER_ID_SHA256` |
| Restore libpq service | `HANDLEPLAN_RESTORE_PGSERVICE` |
| Protected libpq service file | `HANDLEPLAN_RESTORE_PGSERVICE_FILE` |
| Protected libpq password file | `HANDLEPLAN_RESTORE_PGPASS_FILE` |
| Downloaded encrypted artifact | `HANDLEPLAN_RESTORE_ENCRYPTED_FILE` |
| Downloaded manifest | `HANDLEPLAN_RESTORE_MANIFEST_FILE` |
| Absolute reviewed create-only download adapter | `HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER` |
| Maximum capture ciphertext bytes | `HANDLEPLAN_RESTORE_MAX_CAPTURE_ARTIFACT_BYTES` |
| Maximum selected capture files | `HANDLEPLAN_RESTORE_MAX_CAPTURE_FILES` |
| Maximum capture plaintext bytes | `HANDLEPLAN_RESTORE_MAX_CAPTURE_PLAINTEXT_BYTES` |
| JIT protected age identity | `HANDLEPLAN_RESTORE_AGE_IDENTITY_FILE` |
| Absolute `age` executable | `HANDLEPLAN_RESTORE_AGE_BIN` |
| Absolute `pg_restore` executable | `HANDLEPLAN_RESTORE_PGRESTORE_BIN` |
| Absolute `psql` executable | `HANDLEPLAN_RESTORE_PSQL_BIN` |
| Current migration directory | `HANDLEPLAN_RESTORE_MIGRATIONS_DIR` |
| Restore work root, owned and mode 0700 | `HANDLEPLAN_RESTORE_WORK_DIR` |
| Restore evidence root, owned and mode 0700 | `HANDLEPLAN_RESTORE_EVIDENCE_DIR` |

The destination database must be newly created with `TEMPLATE template0` for
the individual drill. The acknowledgement is an operator assertion; the
catalog vector is the fail-closed machine check against pre-existing executable
or user-defined objects. The destination role needs ownership of only the
disposable drill database and narrow execution access required for the hashed
`pg_control_system()` identity query. It must have no cluster-wide privileged
role attribute, no explicit membership (including built-in roles), and no other
database ownership.

## RTO and clean-host drill

Start the RTO clock before retrieving the selected off-host manifest. Record:

1. alert/drill start;
2. manifest, database ciphertext, and create-only capture-ciphertext retrieval;
3. JIT restore identity availability;
4. capture stream verification and database restore evidence completion;
5. forward migration and runtime-role reconciliation;
6. exact image start with all upstream sources disabled;
7. private-loopback health, readiness, and representative public read smoke;
8. evidence retention and isolated-database destruction approval; and
9. JIT identity removal.

The command never drops the drill database. Destruction is a separate reviewed
operator action. A monthly prepared-host restore is not a clean-host drill. One
pre-public-launch exercise must provision the database, tools, JIT key custody,
exact application image, proxy boundary, and configuration from documented
inputs and reach the same smoke checks.

## Exact non-claims

The committed source and unit tests do **not** prove:

- an installed timer or successful production `pg_dump`;
- a reviewed provider adapter with atomic create-only semantics;
- a configured, immutable, independent off-host destination;
- manifest signature or authenticated backup origin;
- creation or independent custody of a trusted full-manifest digest;
- a live production negative test of backup or restore endpoint redirection;
- executable parent-directory trust or package/digest provenance;
- provider lifecycle enforcement or any deletion/expiry event;
- external backup failure/missing-completion alert delivery;
- age restore identity availability during an incident;
- a provider-backed private-capture upload/download or live recovery;
- a proven read-only bind/ACL from the worker-owned capture volume to the
  separate backup principal;
- backup of unreferenced/orphan store files or orphan reconciliation;
- source/right-specific authorization for the shared off-host retention period;
- a restore against live PostgreSQL;
- semantic row completeness or representative data-canary validation;
- runtime-role reconciliation or application smoke after restore;
- the at-most-24-hour RPO or at-most-two-hour RTO; or
- a monthly drill, clean-host recovery, or public-release readiness.

Each claim becomes available only after separately retained, redacted runtime
evidence exists. Never retain credentials, URLs, tokens, raw private evidence,
or copyrighted captures in that evidence.
