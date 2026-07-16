import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../../../deploy/migrations/", import.meta.url),
);
const migrationRunner = fileURLToPath(new URL("../../../deploy/migrate.mjs", import.meta.url));
const productionCompose = fileURLToPath(
  new URL("../../../deploy/compose.production.yml", import.meta.url),
);
const productionEntrypoint = fileURLToPath(
  new URL("../../../deploy/entrypoint.sh", import.meta.url),
);
const productionDeploy = fileURLToPath(
  new URL("../../../deploy/deploy-on-vps.sh", import.meta.url),
);
const ciWorkflow = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));
const databaseUpgradeProof = fileURLToPath(
  new URL("../../../tests/acceptance/prove-database-upgrade.mjs", import.meta.url),
);
const runtimeRoleProof = fileURLToPath(
  new URL("../../../tests/acceptance/prove-runtime-database-role.mjs", import.meta.url),
);
const legacyFixture = fileURLToPath(
  new URL("../../../tests/acceptance/fixtures/v1-03-legacy-price-cache.sql", import.meta.url),
);
const restoreFixture = fileURLToPath(
  new URL("../../../tests/acceptance/fixtures/v1-03-restore-evidence.sql", import.meta.url),
);
const backupRestoreRunbook = fileURLToPath(
  new URL("../../../docs/runbooks/database-backup-restore.md", import.meta.url),
);

function runMigrationWith(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [migrationRunner], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL:
        "postgresql://proof:proof_admin_url_safe_000000000001@127.0.0.1:1/proof",
      APP_DATABASE_PASSWORD: "proof_app_url_safe_000000000000000001",
      MIGRATIONS_DIR: migrationsDirectory,
      ...overrides,
    },
    timeout: 5_000,
  });
}

describe("forward-only v1 migrations", () => {
  it("keeps the complete ordered migration set", async () => {
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      .sort();

    expect(files).toEqual([
      "001_price_cache.sql",
      "002_sources_catalog.sql",
      "003_price_evidence_coverage.sql",
      "004_geography_publications.sql",
      "005_offers_reviews.sql",
      "006_source_health.sql",
      "007_append_only_guards.sql",
      "008_provider_request_budget.sql",
    ]);
  });

  it("uses additive SQL and preserves price_cache as rollback state", async () => {
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^00[2-8]_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    const source = (
      await Promise.all(
        files.map((file) => readFile(path.join(migrationsDirectory, file), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(source).not.toMatch(/\btruncate\b/i);
    expect(source).toContain("insert into price_observations");
    expect(source).toContain("legacy-import");
    expect(source).not.toContain("drop table price_cache");
  });

  it("keeps unverified mirror and legacy coverage explicitly ineligible", async () => {
    const [catalog, coverage, mirror] = await Promise.all([
      readFile(path.join(migrationsDirectory, "002_sources_catalog.sql"), "utf8"),
      readFile(path.join(migrationsDirectory, "003_price_evidence_coverage.sql"), "utf8"),
      readFile(
        fileURLToPath(new URL("./price-evidence.ts", import.meta.url)),
        "utf8",
      ),
    ]);

    expect(coverage).toContain("'ineligible',\n  'legacy_price_cache_missing_provenance'");
    expect(coverage).not.toContain("'priced',\n  'legacy_price_cache_backfill'");
    expect(mirror).toContain('reason: "interactive_price_mirror_unverified_provenance"');
    expect(mirror).toContain('state: "ineligible"');
    expect(catalog).toContain("price_cache.ean,\n  null,\n  100");
  });

  it("scopes canonical GTINs globally and source identifiers per source", async () => {
    const source = await readFile(
      path.join(migrationsDirectory, "002_sources_catalog.sql"),
      "utf8",
    );

    expect(source).toContain("constraint product_identifiers_source_scope check");
    expect(source).toContain("product_identifiers_gtin_value_unique");
    expect(source).toContain("product_identifiers_source_value_unique");
    expect(source).not.toContain("product_identifiers_scheme_value_unique");
  });

  it("persists all five coverage states and prevents duplicate concurrent approvals", async () => {
    const coverage = await readFile(
      path.join(migrationsDirectory, "003_price_evidence_coverage.sql"),
      "utf8",
    );
    const offers = await readFile(
      path.join(migrationsDirectory, "005_offers_reviews.sql"),
      "utf8",
    );

    for (const state of ["priced", "known_not_carried", "stale", "ineligible", "unknown"]) {
      expect(coverage).toContain(`'${state}'`);
    }
    expect(offers).toContain("offer_key varchar(255) not null unique");
    expect(offers).toContain("approved_offers_candidate_unique");
    expect(offers).toContain("review_actions_candidate_version_unique");
  });

  it("installs database guards for append-only evidence and audit records", async () => {
    const source = await readFile(
      path.join(migrationsDirectory, "007_append_only_guards.sql"),
      "utf8",
    );

    expect(source).toContain("reject_append_only_mutation");
    for (const table of [
      "source_permissions",
      "price_observations",
      "price_coverage_checks",
      "publication_captures",
      "review_actions",
    ]) {
      expect(source).toContain(`on ${table}`);
    }
    expect(source).not.toContain("handleplan.allow_append_only_mutation");
  });

  it("keeps provider request attempts ephemeral and grants only coordination DML", async () => {
    const [migration, runner, packageManifest] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "008_provider_request_budget.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ]);

    expect(migration).toContain("create table provider_request_budget_events");
    expect(migration).toContain("claimed_at timestamptz not null default clock_timestamp()");
    expect(migration).toContain(
      "provider_request_budget_events_provider_time_idx",
    );
    expect(migration).not.toMatch(/\b(bigserial|generated|identity)\b/i);
    expect(runner).toContain(
      'const ephemeralRequestBudgetTables = ["provider_request_budget_events"]',
    );
    expect(runner).toContain(
      "grant select, insert, delete on table ${identifiers(ephemeralRequestBudgetTables)}",
    );
    expect(JSON.parse(packageManifest).exports["./request-budget"]).toBe(
      "./src/request-budget.ts",
    );
  });

  it("separates the migration owner from the fail-closed runtime role", async () => {
    const [runner, compose, entrypoint, deploy, proof, workflow] = await Promise.all([
      readFile(migrationRunner, "utf8"),
      readFile(productionCompose, "utf8"),
      readFile(productionEntrypoint, "utf8"),
      readFile(productionDeploy, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
      readFile(ciWorkflow, "utf8"),
    ]);

    expect(runner).toContain("DATABASE_MIGRATION_URL");
    expect(runner).toContain("APP_DATABASE_PASSWORD");
    expect(runner).toContain('const runtimeRole = "handleplan_app"');
    expect(compose).toMatch(/migrate:[\s\S]*DATABASE_MIGRATION_URL:/);
    expect(compose).toContain(
      "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${HANDLEPLAN_MIGRATION_IMAGE:?HANDLEPLAN_MIGRATION_IMAGE is required}",
    );
    expect(compose).toMatch(/app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_app:/);
    expect(compose).not.toMatch(/app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan:/);
    expect(compose).toMatch(
      /app:[\s\S]*migrate:[\s\S]*condition: service_completed_successfully/,
    );
    expect(entrypoint).not.toContain("migrate.mjs");
    expect(deploy).toContain('HANDLEPLAN_MIGRATION_IMAGE="$migration_image"');
    expect(deploy).toContain('deploy "$previous_revision" "$revision"');
    expect(proof).toContain("handleplan.allow_append_only_mutation");
    expect(proof).toContain("disable trigger source_permissions_append_only");
    expect(proof).toContain("has_table_privilege");
    expect(proof).toContain("budget_select");
    expect(proof).toContain("budget_insert");
    expect(proof).toContain("budget_delete");
    expect(proof).toContain("budget_update");
    expect(proof).toContain("provider_request_budget_events");
    expect(workflow).toMatch(
      /- name: Prove runtime database least privilege[\s\S]*prove-runtime-database-role\.mjs/,
    );
  });

  it("lets CI select the repository migration directory without changing production", async () => {
    const source = await readFile(migrationRunner, "utf8");

    expect(source).toContain('process.env.MIGRATIONS_DIR ?? "/app/deploy/migrations"');
    expect(source).toContain("path.resolve");
    expect(source).toContain("Applied migration checksum changed");
    expect(source).toContain("Applied migration is absent from the repository");
  });

  it("rejects the migration cutoff outside an explicit CI process before connecting", () => {
    const result = runMigrationWith({
      CI: "false",
      CI_MAX_MIGRATION_ID: "001_price_cache.sql",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CI_MAX_MIGRATION_ID is only allowed when CI=true");
  });

  it("rejects malformed or unknown CI migration cutoffs before connecting", () => {
    const malformed = runMigrationWith({
      CI: "true",
      CI_MAX_MIGRATION_ID: "../001_price_cache.sql",
    });
    const unknown = runMigrationWith({
      CI: "true",
      CI_MAX_MIGRATION_ID: "999_not_a_migration.sql",
    });

    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain(
      "CI_MAX_MIGRATION_ID must be an exact migration filename",
    );
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain(
      "CI_MAX_MIGRATION_ID does not identify a repository migration",
    );
  });

  it("keeps a deterministic CI upgrade and dump/restore proof", async () => {
    const [proof, legacy, restore, workflow, runbook] = await Promise.all([
      readFile(databaseUpgradeProof, "utf8"),
      readFile(legacyFixture, "utf8"),
      readFile(restoreFixture, "utf8"),
      readFile(ciWorkflow, "utf8"),
      readFile(backupRestoreRunbook, "utf8"),
    ]);

    expect(proof).toContain('"handleplan_ci_v1_03_source"');
    expect(proof).toContain('"handleplan_ci_v1_03_restore"');
    expect(proof).toContain('runMigrations(sourceDatabase, "001_price_cache.sql")');
    expect(proof).toContain('"008_provider_request_budget.sql"');
    expect(proof).toContain("009_deleted_history.sql");
    expect(proof).not.toContain("008_deleted_history.sql");
    expect(proof).toContain("Applied migration is absent from the repository");
    expect(proof).toContain(
      "postgres:16.10-alpine@sha256:ab8380566c3ea09690a9ecaa85a59d82bfc6eb86744151a2a54335866c83a3e9",
    );
    expect(proof).toContain('"pg_dump"');
    expect(proof).toContain('"pg_restore"');
    expect(proof).toContain('"--interactive"');
    expect(proof).not.toContain(".catch(() => undefined)");
    expect(legacy).toContain("insert into price_cache");
    expect(restore).toContain("insert into source_permissions");
    expect(restore).toContain("insert into publication_captures");
    expect(restore).toContain("insert into review_actions");
    expect(workflow).toMatch(
      /- name: Prove migration upgrade and backup restore[\s\S]*node tests\/acceptance\/prove-database-upgrade\.mjs/,
    );
    expect(runbook).toMatch(/permission audit.*publication capture.*review audit/is);
    expect(runbook).toMatch(/ordinary-only.*blocked.*official claims/is);
    expect(runbook).toMatch(/migrations 002 through 008.*all eight/is);
    expect(runbook).toMatch(/request-budget.*ephemeral.*SELECT.*INSERT.*DELETE/is);
    expect(runbook).toMatch(/does not prove.*off-host.*retention/is);
  });
});
