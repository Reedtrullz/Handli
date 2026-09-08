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
seed:          c036b0b50d92e812fdf3f262f8084021aac43082d8054dc6e311938db65b675a
sequence:      ecbe4ba722d6129910da88016c7cadc5727a666d4e3cd5057047786dd11f2889
ACL/security:  22ac365288cd7414943f9f11604a3ed7c372bc297b6db976b5d84582ecbd2311
```

Seed normalization replaced only historically clock-generated columns with
`__installer_transaction_timestamp__`; fixed taxonomy `published_at` remained
literal. ACL normalization removed owner names and runtime-role grants while
retaining PUBLIC privileges and security attributes. Raw schema-only dump text
had only PostgreSQL deparser parenthesization/cast spelling differences.

The exact tracked bytes are:

```text
deploy/bootstrap/040_schema.sql
57cdaa0681c9e044e4a35e8b3413f2f0960b71e210f63b3f1afacd460cc5111d
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

**Commit:** recorded by the parent task after independent artifact review.
The immutable Tjek superseding permission preserves the migration's literal
`pg_catalog.clock_timestamp()` reviewed-at expression; its install-time clock
keeps it later than the preceding permission without inventing a historical
review date.
