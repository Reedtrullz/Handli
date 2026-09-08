# Task 2B1 report — deterministic bootstrap artifact and proof

**Date:** 2026-09-08 (Europe/Oslo)
**Base:** `657de02baa531782d96f9127e7717b1d4eea6c8b`
**Scope:** artifact, manifest, explicit 041 SQL, and bounded artifact tests only

## Result

The candidate literal artifact is `deploy/bootstrap/040_schema.sql`. It is
executable PostgreSQL SQL with no `psql` metacommands, no default-public-schema
creation, no runner-owned migration/baseline tables, and no grants to runtime
roles. Its data section uses `pg_catalog.transaction_timestamp()` for installer
clock fields. The immutable taxonomy publication date remains
`2026-07-16T00:00:00+00`; no source-review date is invented or hardcoded.
The Tjek superseding permission preserves the migration's literal
`pg_catalog.clock_timestamp()` reviewed-at expression; its install-time clock
keeps the row later than the preceding permission without inventing a
historical review date.

The artifact contains only deterministic reference rows: four `data_sources`,
four `source_permissions`, one `family_taxonomy_versions`, one
`geographic_scopes`, one `ingestion_runs`, one publication-policy row, two
reviewed-family aliases, and three reviewed-family definitions. Products,
prices, offers, review actions, captures, publications, and evidence rows are
empty. The Tjek source pointer intentionally does not equal the newest
permission row, so the current-rights fence remains fail-closed.

## Fresh proof

The required headroom check was:

```text
df -h /System/Volumes/Data
/dev/disk3s5  460Gi  371Gi  48Gi  89%  ... /System/Volumes/Data
```

Using PostgreSQL `16.10` in the existing disposable
`handleplan-task2b1-pg` container (`127.0.0.1:55441`), Node `22.22.3`, and
pnpm `10.34.5`, two clean databases were created and each received the exact
artifact. A third clean database received the artifact inside one explicit
transaction, matching the future runner boundary:

```text
docker exec handleplan-task2b1-pg psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS task2b1_artifact_check' \
  -c 'CREATE DATABASE task2b1_artifact_check'
docker exec -i -e PGPASSWORD="$FIXTURE" handleplan-task2b1-pg psql \
  -U postgres -d task2b1_artifact_check -v ON_ERROR_STOP=1 -f /dev/stdin \
  < deploy/bootstrap/040_schema.sql
```

Both independent installs produced `52` relations, `499` columns, `339`
constraints, `105` indexes, `87` triggers, `47` public functions, and `26`
sequences. The transactional install committed with `4:4` rows for
`data_sources:source_permissions`. All three installs had zero rows in the
production product/price/offer/review/capture/publication/evidence tables and
zero runtime-role table or routine grants.

The two installs produced the same corrected function hashes:

```text
public_official_offer_rows_v1:         256e213b63ba618bfe2edf3fb27e3499e4ff584a0e040f6f77e2f3189d7c3e94
public_offer_backed_discovery_rows_v1: b98b8c64a00adaa36b3983bf9127f05c4f17403faaaa23e5882b7d961611ad12
```

The canonical-history comparison applied 001–034 in one transaction, 035 in
its own transaction, 036–038 in one transaction, and then explicit 041 plus
immutable 040. It matched the artifact on all structural counts, both function
hashes, and these normalized contracts:

```text
schema:        b097f01ca5b22001f797056ea395a0039789fb89ae5970c675d5b25956b152a9
seed:          3ec6e86709734a1adea946c6702f2fb40d5e4dae48abd86bb63f5c14169bcd3a
sequence:      73b72c9fd5fdb4e0b34c683d95673a2475bf3dfa8b4940c89b4ce1bd399d6279
ACL/security:  5e959cc908463fd52a6b9a3724c2caba269d74c328b28684db1484a62190ea35
```

Seed normalization replaced only historically clock-generated columns with
`__installer_transaction_timestamp__`; fixed taxonomy `published_at` remained
literal. ACL normalization removed owner names and runtime-role grants while
retaining PUBLIC privileges and security attributes. Raw schema-only dump text
had only PostgreSQL deparser parenthesization/cast spelling differences.

The exact tracked bytes are:

```text
deploy/bootstrap/040_schema.sql
8febf33b13e7260e746e624714e8ee5e054b039f45df673da1cf8b1569198c7e
deploy/bootstrap/040_manifest.json
0a0ae7c9d46b2e20bfcbc4abd672cf9f2a8dbe5279b4237322d64f44c5c38b5c
deploy/migrations/041_public_offer_projection_repair.sql
68f59cfd0b1ada2f600f8540334d9b6eefe19c7970d3827d0ec5ca218905433a
```

## Checks

```text
PATH=/Users/reidar/.nvm/versions/node/v22.22.3/bin:$PATH \
  corepack pnpm --filter @handleplan/db exec vitest run src/migration-files.test.ts
  Test Files  1 passed (1)
  Tests       33 passed (33)

node -e '<sha256 manifest covered-migration check>'
  40 entries; every repository checksum matched
```

The test pins the artifact hash, complete 001–040 covered list, no
`\\restrict`/`\\unrestrict` commands, no runner metadata, no runtime grants,
install-clock timestamp policy, object counts, corrected function hashes, and
the literal 041 correction. It also rejects regex/prosrc/dynamic execution in
041.

## Deferred gates

No runner, backup, role-reconciliation, migration activation, production
database, or 2B2 ACL mutation was performed. Task 2B2/Task 4 must remove the
legacy blanket worker grants before activating the baseline route and must
record baseline provenance separately from the historical execution ledger.

## Fix round 1 review evidence

Independent review found one final-blank-line drift between the recorded
artifact hash and committed bytes and a metacommand guard that matched two
backslashes. The manifest now pins the committed artifact hash
`8febf33b13e7260e746e624714e8ee5e054b039f45df673da1cf8b1569198c7e`, and the
focused test matches one literal PostgreSQL backslash. The focused test passed
33/33 after these edits.

The previously ephemeral canonical proof is retained in
`docs/evidence/release-readiness/task-2B1-proof/` and is rerunnable with
`scripts/release/prove-040-bootstrap.mjs`. It creates two independent
canonical-history installs and two independent artifact installs, retains both
raw dumps and their exact diffs, and records exact catalog/seed/sequence/
PUBLIC-security/owner/denial readbacks. The two generated canonical schema
outputs are byte-identical with SHA-256
`a481183f674e97e0b00a114be1b0e1261b602422edc0d313a6e6e6ee1c46e598`. The raw
canonical/canonical diff contains only the random `pg_dump` restrict guards;
the canonical/artifact raw and normalized diffs are retained separately. The
canonical/artifact normalized diff contains 132 changed constraint/index
definition lines, all checked by an exact line-kind boundary in
`canonical-artifact.diff.check.json`; the differences are PostgreSQL 16.10
deparser cast/parenthesis forms. Independent canonical and artifact round-trip
outputs are each byte-identical, so this does not use a broad text
normalization to erase differences. The normalized output removes only the
two operational restrict lines. The readback
matched 52/499/339/105/87/47/26 object counts, both function hashes, normalized
seed, sequence, PUBLIC/security ACL, and installer-owner contracts between
canonical history and artifact. Canonical history retained 26 runtime ACL rows;
the artifact retained zero. No timestamp or semantic date was normalized
beyond the enumerated historical clock columns.

**Commit:** recorded by the parent task after independent artifact review.
The immutable Tjek superseding permission preserves the migration's literal
`pg_catalog.clock_timestamp()` reviewed-at expression; its install-time clock
keeps it later than the preceding permission without inventing a historical
review date.
