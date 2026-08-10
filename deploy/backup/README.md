# Disabled V1 backup tooling

This directory is a source-neutral operational foundation. Nothing here is
scheduled or enabled by the repository. See
[`docs/runbooks/offhost-backup-restore.md`](../../docs/runbooks/offhost-backup-restore.md)
before installing a unit or setting an enable flag.

`backup.env.example` and `restore-drill.env.example` are inert names-only
starting points. Both remain disabled and contain no credential or private key.

- `create-backup.mjs` creates a PostgreSQL custom-format dump and a distinct
  same-dump-ledger-bound private-capture bundle, streams both directly through
  `age`, uploads both ciphertexts and the checksum through a create-only
  adapter, then publishes the schema-v2 manifest last. Its source identity,
  ledger, and relation probe run in one live read-only transaction that exports
  the exact snapshot required by `pg_dump`; a redirected dump cannot import a
  snapshot from a different PostgreSQL cluster.
- `verify-restore.mjs` restores only to a freshly `template0`-provisioned,
  catalog-clean database and service named `handleplan_restore_drill_*`. It
  never drops, cleans, creates, or overwrites a database. It create-only fetches
  the capture ciphertext with a separate adapter, stream-verifies it without
  materializing plaintext captures, and compares its digest to the restored
  database metadata. The mutating pass keeps `pg_restore` offline, guards its
  generated SQL against reconnect and transaction-control commands, and sends
  it through the same psql session that proves the target identity before the
  transaction and again after commit.
- The upload boundary is an environment-only adapter contract. There is no
  bundled provider adapter: rclone `copyto --immutable` cannot prove atomic
  create-only publication when identical objects already exist.
- No download adapter is bundled either. Upload and download require distinct
  custody and provider proof.
- `systemd/*.example` are inert examples. The services also default their
  enable flags to `false` and set `LimitCORE=0`.

All configuration is accepted through named environment variables. Database
passwords stay in a mode-0600 libpq password file, the database connection is
selected by a protected service file pinned into the run directory, and
off-host credentials stay in a protected adapter configuration. The selected
service must name one local Unix-socket database and role; remote and multi-host
libpq routes are rejected. No credential belongs in a command argument.
The streaming design avoids a plaintext dump file, but plaintext still passes
through process memory and kernel pipe buffers. Do not activate either service
until core dumps are disabled for the service and host swap is disabled or
encrypted.
Ordinary subprocesses and their process groups receive bounded TERM-to-KILL
teardown; the example units also make systemd's control-group kill behavior
explicit.
Configured executables and the age recipients file must be canonical regular
files owned by root or the service account and must not be group- or
other-writable.

The inert systemd examples execute the exact controls release installed at
`/opt/apps/handleplan/operations/current`, not the nonexistent historical
`/opt/apps/handleplan/current` path. No unit or timer is installed or enabled by
this repository.
