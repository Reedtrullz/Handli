# Migration recovery design — Task 2A

**Captured:** 2026-09-08 (Europe/Oslo)
**Status:** DESIGN_READY_FOR_INDEPENDENT_REVIEW; IMPLEMENTATION_BLOCKED
**Scope:** design and evidence only. No migration, runner, backup reader, or
role-grant source was changed by this task.

This document defines the smallest recovery boundary that can preserve the
immutable 022–040 history while making a new empty database installable. It is
an implementation contract for Task 2B, not evidence that the proposed branch
exists or that production has been changed.

## Evidence and root cause

The workflow and the existing upgrade proof name the exact CI image
postgres:16.10-alpine@sha256:ab8380566c3ea09690a9ecaa85a59d82bfc6eb86744151a2a54335866c83a3e9,
whose digest has 64 hexadecimal characters. Docker inspected and pulled this
exact reference successfully; the observed image ID was
sha256:ab8380566c3ea09690a9ecaa85a59d82bfc6eb86744151a2a54335866c83a3e9.

Using that exact pinned image, a disposable PostgreSQL container was started on
127.0.0.1:55440 with the non-secret CI fixture environment and the required
Node runtime v22.22.3. The command was:

    DATABASE_MIGRATION_URL='postgresql://handleplan:<fixture>@127.0.0.1:55440/handleplan' \
    APP_DATABASE_PASSWORD='<fixture>' \
    WEB_DATABASE_PASSWORD='<fixture>' \
    REVIEW_DATABASE_PASSWORD='<fixture>' \
    OPERATIONS_DATABASE_PASSWORD='<fixture>' \
    MIGRATIONS_DIR="$PWD/deploy/migrations" \
    /Users/reidar/.nvm/versions/node/v22.22.3/bin/node deploy/migrate.mjs

The bounded failure excerpt was:

    PostgresError: syntax error at or near "candidate.normalized_fields"
    severity: ERROR
    code: 42601

After the failed run, the disposable database contained exactly 38 ledger
rows, ending at 038_tjek_function_grants.sql; 039 and 040 were absent. The
projection definition remained the through-038 definition with
pg_get_functiondef SHA-256
09d99d60dc86a6d3dc64a3bd7d942f3cebaca64b9baeed23d2559c0c78282028.
Repeating the run under Node 22 produced the same error and the same state.

The failure is caused by the implementation of 039, not by a missing function.
The migration uses regexp_replace(..., 'g') to edit pg_proc.prosrc. The
E-string escape processing consumes the backslashes before PostgreSQL's regular
expression engine sees the pattern, so the intended literal SQL || reaches the
engine as raw || alternation. The global replacement therefore inserts the
replacement repeatedly. In the
disposable reproduction the function body grew from 25,513 to 6,276,379 bytes
before the generated CREATE OR REPLACE FUNCTION failed. This is why a
regex patch, a warning-only no-op, or a fabricated checksum is not an
acceptable recovery.

The immutable file hashes used by this design are:

| Artifact | SHA-256 |
| --- | --- |
| deploy/migrations/039_tjek_null_comparison_fix.sql | b92edd7f8c6e23bcea67a28b40c8150c168999ac70b03dce2bb4334bce4002a8 |
| deploy/migrations/040_offer_backed_discovery.sql | acc7a16e1e4ab4c0eed51df5724cd9cb92d08c8fd467d4d74f6f18f7bded809f |
| read-only live-public-projection.sql | 07c3e5d2679ff9eda86d153ef3bdd438679de4225d960b8279b72deb2cb80f95 |

On the disposable through-038 schema, applying the read-only projection file
and then the immutable 040 file produced these review anchors:

| Observation | SHA-256 |
| --- | --- |
| pg_get_functiondef(public_official_offer_rows_v1(...)) after captured live-definition application | cdddf786986553a1c3044799affbb0080d6e7c6ae391be4addfe4cfbee440347 |
| pg_get_functiondef(public_offer_backed_discovery_rows_v1(...)) after 040 | b98b8c64a00adaa36b3983bf9127f05c4f17403faaaa23e5882b7d961611ad12 |
| schema-only dump through 038 | bfdeb07f8458e6e9e0ad5dfa67bb121ae375dc82cbc7c015bf6706d208676de9 |
| schema-only dump after corrected projection + 040 | d5d04d62fc3129efeb119fb7b153147a8d762aff8782dca84f766e98011e5a45 |

The live function file is a captured production definition from Task 1, not an
independent approval record. It contains the intended null-aware pricing comparisons and
the nested exactCanonicalProductId path, but also contains duplicated nested
path alternatives. Task 2B must review the predicate semantically and write a
single explicit function body; it must not blindly copy live text or use text
rewriting.

## Recovery decision

Use a separate baseline provenance record and a normal forward migration. Do
not insert 001–040 into handleplan_schema_migrations when those files were
covered by a fresh-install baseline, because that would falsely claim that
039 executed. A baseline is coverage/provenance metadata; the historical
migration ledger remains an execution ledger.

The preferred representation is a small public.handleplan_schema_baselines
table with one immutable row for a generated baseline artifact. Its reviewed
shape is:

    create table public.handleplan_schema_baselines (
      baseline_id text primary key,
      manifest_sha256 char(64) not null,
      artifact_sha256 char(64) not null,
      covered_migrations jsonb not null,
      resulting_schema_sha256 char(64) not null,
      provenance jsonb not null,
      recorded_at timestamptz not null default pg_catalog.transaction_timestamp(),
      constraint handleplan_schema_baselines_manifest_sha256
        check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
      constraint handleplan_schema_baselines_artifact_sha256
        check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
      constraint handleplan_schema_baselines_schema_sha256
        check (resulting_schema_sha256 ~ '^[0-9a-f]{64}$')
    );

The manifest covered by manifest_sha256 must contain a sorted, complete
ordered array of {id, checksum} entries for 001–040, the hash of the
generated bootstrap artifact, the resulting schema digest, the repository
commit, the read-only projection-file hash, and a statement that 039 is
covered by the reviewed correction but was not executed. Hashes are checked
against the repository bytes before any SQL is run. provenance records source
and reviewer references without credentials or private captures.

The generated artifact is the selected atomicity solution. Task 2B must build
it from a disposable canonical database after applying the immutable 001–038
and 040 semantics plus one explicit corrected CREATE OR REPLACE FUNCTION
public.public_official_offer_rows_v1(...) in place of 039. Before
implementation, the generated artifact must be independently reviewed and
hash-pinned as a standalone SQL install; it is not a runtime rewrite of
historical files and does not claim that 039 executed. The
explicit function must preserve the existing SECURITY DEFINER, PARALLEL
UNSAFE, SET search_path TO pg_catalog, pg_temp, owner, and grant boundary. Its
only semantic changes are:

    -- unit and multibuy before-price checks
    (
      offer.before_amount_ore is null
      and jsonb_typeof(review.new_values #> '{decision,pricing,beforePriceOre}') = 'null'
    )
    or (
      offer.before_amount_ore is not null
      and review.new_values #> '{decision,pricing,beforePriceOre}'
          = pg_catalog.to_jsonb(offer.before_amount_ore)
    )

    -- exact product binding, allowing the reviewed nested extractor path
    candidate.normalized_fields ->> 'exactCanonicalProductId'
      = 'product:' || target.product_id::text
    or candidate.normalized_fields #> '{candidate,exactCanonicalProductId}'
      = pg_catalog.to_jsonb('product:' || target.product_id::text)

The multibuy clause uses the same null-aware comparison with
beforeUnitPriceOre. The full reviewed function body, including all existing
trust, freshness, source-rights, geographic, and review predicates, must be
written literally into 041 and into the generated artifact. No regex, prosrc
lookup, dynamic SQL, warning-only no-op, or historical-file edit is permitted.

Migration 035 contains top-level BEGIN; and COMMIT;. Executing its immutable
bytes inside one outer bootstrap transaction commits the outer transaction, so
raw replay is rejected for the atomic empty-database route. The generated
artifact preserves the resulting schema semantics without stripping or
mutating the historical files. It must still be reviewed against every
covered hash, the through-038 schema digest, the corrected projection
definition, and the immutable 040 function. If generation cannot prove those
bindings, the baseline route remains blocked and requires an explicit
historical-file exception; it may not silently ignore 039 or 035.

## Runner algorithm for Task 2B

The runner must hold the existing advisory lock for the entire decision and
must validate the connection identity before touching application objects.
The proposed order is:

1. Read and hash the repository migration files and baseline manifest before
   opening the mutation transaction. Require the exact immutable 022–040
   hashes and reject unknown or duplicate IDs.
2. Inspect the public catalog. A baseline candidate must have no user schemas,
   relations, functions, custom types, non-default extensions, or event
   triggers; no nonempty historical ledger; and no baseline record. The
   standard public schema and plpgsql are allowed. Any existing object or
   row routes to the ordinary legacy path or fails closed.
3. On an empty target, verify the manifest and generated-artifact hashes, create the
   baseline metadata table, create the worker-role prerequisite before any
   grant-bearing SQL, execute the reviewed artifact, and insert one baseline row
   in the same atomic bootstrap boundary. Do not insert covered migrations as
   applied rows.
4. On a database with a baseline record, validate the manifest hash, artifact
   hash, complete covered list, schema digest, and the absence of historical
   ledger rows claiming covered migrations. Then run only migrations after the
   covered range; 041 is recorded normally after its SQL commits.
5. On a legacy database, validate every existing ID/checksum against the
   repository, require the ordered 001–040 prefix, and run 041 in an ordinary
   transaction. A complete legacy 040 ledger remains unchanged; no 039 row is
   rewritten or forged.
6. Run the existing family publication checks and role reconciliation after
   migrations. Keep the role prerequisite before 037 grants and retain the
   explicit least-privilege review of worker, web, review, and operations
   functions. Task 4 must remove the current blanket worker EXECUTE and
   SELECT restoration; the baseline must not preserve that broad authority.

The baseline transaction must be failure-injected before its metadata insert,
after each artifact phase, and before commit. Every injected failure must leave
no baseline row and no partial application eligible for a later silent
resume. If the generated artifact cannot prove this, the baseline route is
rejected.

## Required route behavior

| Starting state | Required behavior | Ledger truth |
| --- | --- | --- |
| Fresh empty database | Run only the reviewed empty-target baseline artifact, then apply 041 normally | Baseline row covers 001–040; only actually executed 041 is in the historical ledger |
| Legacy complete 040 | Validate every historical checksum, apply 041 as a normal forward migration, and make the second run a no-op | Existing 001–040 rows and checksums remain byte-for-byte unchanged; 041 is added after its SQL commits |
| Interrupted partial 038 | Refuse the baseline branch and refuse to reinterpret 038 as complete; require clean restore or an explicitly approved recovery path | Rows 001–038 remain unchanged; no fabricated 039 or baseline row |
| Baseline present, 041 missing | Validate baseline metadata and resume only 041 | Baseline coverage remains separate from applied execution |
| Nonempty target with no valid baseline | Fail closed before bootstrap | No migration or role mutation |

## Consumer changes required in Task 2B

The design crosses more readers than deploy/migrate.mjs; all must be reviewed
together:

| Consumer | Required change or proof |
| --- | --- |
| deploy/migrate.mjs | Validate baseline metadata, distinguish covered from applied IDs, enforce empty-target gate, preserve advisory lock and role prerequisite, and apply 041 normally |
| deploy/backup/toolkit.mjs | Read/export/restore the baseline record with the migration ledger; validate an effective ordered coverage sequence without converting baseline coverage into executed rows |
| tests/acceptance/prove-database-upgrade.mjs | Add clean bootstrap, replay, restored legacy 040, interrupted 038, nonempty target, manifest/hash tamper, unknown checksum, and failure-injection cases; compare pg_get_functiondef, ordered checksums, and schema digests |
| tests/acceptance/prove-runtime-database-role.mjs | Prove the baseline route creates the same role ownership and function/table boundary; explicitly deny review/governance functions to the worker |
| acceptance and backup fixtures | Compare representative seeded rows, sequence state, role ownership, explicit table/function grants, and baseline provenance across clean, legacy, restore, and interrupted states |
| packages/db/src/migration-files.test.ts | Assert immutable 022–040 bytes, explicit 041 function definition, manifest coverage, no regex/prosrc surgery, and correct migration ordering |
| tests/operations/backup-tooling.test.mjs | Add baseline-aware backup/restore fixtures and reject missing, altered, partial, or mismatched baseline metadata |
| scripts/release/generate-v1-draft-manifest.mjs and scripts/release/verify-v1-candidate-manifest.mjs | Keep repository migration hashes exact and include baseline provenance where a candidate uses the empty-database route |
| .github/workflows/ci.yml | Run both baseline and legacy upgrade routes against the exact pinned image with Node 22.22.3 |

## Regression assertions

The upgrade proof should call the following with values read from PostgreSQL
and the ordered ledger, never with hardcoded success booleans:

    import assert from "node:assert/strict";

    function assertMigrationEquivalence({
      cleanProjectionDefinition,
      upgradedProjectionDefinition,
      legacyChecksumsAfterUpgrade,
      legacyChecksumsBeforeUpgrade,
      secondMigrationRunChangedSchema,
    }) {
      assert.equal(cleanProjectionDefinition, upgradedProjectionDefinition);
      assert.deepEqual(legacyChecksumsAfterUpgrade, legacyChecksumsBeforeUpgrade);
      assert.equal(secondMigrationRunChangedSchema, false);
    }

The same proof must reject: a nonempty target sent to the baseline branch, an
altered baseline hash, an unknown legacy checksum, a baseline whose covered
list omits 039, a baseline row without its manifest, a partial bootstrap after
failure injection, and a baseline that grants a runtime role ownership or
governance execution. It must prove that a complete legacy 040 database keeps
its exact 001–040 rows while the corrected public projection definition and
041 behavior match the clean route.

## Non-claims and handoff

- No bootstrap SQL, 041 SQL, manifest, runner, backup reader, or test source
  was implemented by Task 2A.
- No production database was connected to or changed.
- The exact pinned CI image reproduces the failure; no tag fallback is used for
  the final evidence.
- The private reproducer, bounded logs, schema dumps, and function snapshots
  are retained outside Git under
  /Users/reidar/.codex/handleplan-task2a-repro-20260908/; they contain only
  disposable schema and fixture evidence.

Task 2B may implement only after an independent review resolves the migration
035 atomicity choice and accepts this baseline provenance model. Any rejected
choice requires an explicit historical-file exception; it must not become a
runtime regex patch or a forged migration checksum.
