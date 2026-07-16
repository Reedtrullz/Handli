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
const legacyRollbackCompose = fileURLToPath(
  new URL("../../../deploy/compose.rollback-legacy.yml", import.meta.url),
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
const productFamilyTaxonomy = fileURLToPath(
  new URL("../../../docs/data/product-family-taxonomy.v1.json", import.meta.url),
);

function runMigrationWith(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [migrationRunner], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL:
        "postgresql://proof:proof_admin_url_safe_000000000001@127.0.0.1:1/proof",
      APP_DATABASE_PASSWORD: "proof_app_url_safe_000000000000000001",
      WEB_DATABASE_PASSWORD: "proof_web_url_safe_000000000000000001",
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
      "009_ingestion_outcomes.sql",
      "010_worker_job_results.sql",
      "011_catalog_observations.sql",
      "012_reviewed_family_taxonomy.sql",
    ]);
  });

  it("uses additive SQL and preserves price_cache as rollback state", async () => {
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^(?:00[2-9]|01[0-2])_[a-z0-9_]+\.sql$/.test(file))
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

  it("adds idempotent scheduled runs and append-only source outcome audit", async () => {
    const [migration, runner, packageManifest] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "009_ingestion_outcomes.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ]);

    expect(migration).toContain("add column if not exists job_id varchar(200)");
    expect(migration).toContain("ingestion_runs_job_id_unique");
    expect(migration).toContain("create table source_record_outcomes");
    expect(migration).toContain("source_record_outcomes_append_only");
    expect(migration).toContain("source_record_outcomes_run_kind_record_unique");
    expect(runner).toMatch(
      /protectedAppendOnlyTables[\s\S]*source_record_outcomes/,
    );
    expect(runner).toContain("source_record_outcomes_id_seq");
    expect(JSON.parse(packageManifest).exports["./ingestion"]).toBe(
      "./src/ingestion.ts",
    );
  });

  it("persists fenced worker schedule outcomes independently of ingestion evidence", async () => {
    const [migration, runner, packageManifest] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "010_worker_job_results.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ]);

    expect(migration).toContain("create table worker_job_results");
    expect(migration).toContain("worker_job_results_job_id_unique");
    expect(migration).toContain("worker_job_results_append_only");
    expect(migration).toContain("result_hash char(64) not null");
    expect(migration).not.toContain("fence_token");
    expect(runner).toMatch(/protectedAppendOnlyTables[\s\S]*worker_job_results/);
    expect(runner).toContain("worker_job_results_id_seq");
    expect(JSON.parse(packageManifest).exports["./worker-state"]).toBe(
      "./src/worker-state.ts",
    );
  });

  it("versions catalog payloads append-only and grants only append/read capabilities", async () => {
    const [migration, runner] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "011_catalog_observations.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
    ]);

    expect(migration).toContain("create table catalog_observations");
    expect(migration).toContain("ingestion_run_id bigint not null references ingestion_runs(id)");
    expect(migration).toContain("retrieved_at timestamptz not null");
    expect(migration).toContain("source_updated_at timestamptz");
    expect(migration).toContain("catalog_observations_append_only");
    expect(migration).toContain("create function enforce_ingestion_run_lifecycle()");
    expect(migration).toContain("create trigger ingestion_runs_lifecycle_guard");
    expect(migration).toContain("new.source_id is distinct from old.source_id");
    expect(migration).toContain("new.run_type is distinct from old.run_type");
    expect(migration).toContain("new.started_at is distinct from old.started_at");
    expect(migration).toContain("new.created_at is distinct from old.created_at");
    expect(migration).toContain("old.status <> 'running'");
    expect(migration).toContain(
      "new.status not in ('completed', 'degraded', 'failed', 'cancelled')",
    );
    expect(runner).toMatch(/protectedAppendOnlyTables[\s\S]*catalog_observations/);
    expect(runner).toMatch(/webReadOnlyTables[\s\S]*catalog_observations/);
    expect(runner).toContain("catalog_observations_id_seq");
  });

  it("publishes the exact reviewed-family artifact with immutable versioned decisions", async () => {
    const [migration, runner, artifactSource, packageManifest] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "012_reviewed_family_taxonomy.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(productFamilyTaxonomy, "utf8"),
      readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ]);
    const artifact = JSON.parse(artifactSource) as {
      contentSha256: string;
      publishedAt: string;
      versionId: string;
    };

    expect(migration).toContain("create table family_taxonomy_versions");
    expect(migration).toContain("create table reviewed_family_definitions");
    expect(migration).toContain("create table reviewed_family_aliases");
    expect(migration).toContain("create table reviewed_family_membership_decisions");
    expect(migration).toContain("add column terminalized_at timestamptz");
    expect(migration).toContain("greatest(transaction_timestamp(), created_at)");
    expect(migration).toContain("new.terminalized_at := statement_timestamp()");
    expect(migration).toContain("ingestion_runs_terminalization_state");
    expect(migration).toContain("create function stamp_public_state_change()");
    expect(migration).toContain("new.public_state_changed_at := statement_timestamp()");
    for (const table of [
      "data_sources",
      "canonical_products",
      "product_identifiers",
      "geographic_scopes",
    ]) {
      expect(migration).toContain(`constraint ${table}_public_state_clock`);
      expect(migration).toContain(`create trigger ${table}_public_state_clock`);
    }
    expect(migration).toContain("create function stamp_persisted_creation_clock()");
    for (const table of [
      "geographic_scope_regions",
      "geographic_scope_postal_codes",
      "geographic_scope_stores",
    ]) {
      expect(migration).toContain(`create trigger ${table}_creation_clock`);
      expect(migration).toContain(`create trigger ${table}_append_only`);
    }
    expect(migration).toContain("alter table source_record_outcomes add column created_at");
    for (const table of [
      "source_permissions",
      "price_observations",
      "price_coverage_checks",
      "source_record_outcomes",
      "catalog_observations",
      "reviewed_family_membership_decisions",
    ]) {
      expect(migration).toContain(`create trigger ${table}_creation_clock`);
    }
    expect(migration).toContain(
      "create function enforce_running_ingestion_evidence_insert()",
    );
    expect(migration).toContain("validate_existing_ingestion_evidence_provenance");
    expect(migration).toContain("existing price observation has incompatible run provenance");
    expect(migration).toContain("run.source_id = 'legacy-import'");
    expect(migration).toContain("from ingestion_runs\n  where id = new.ingestion_run_id\n  for update");
    expect(migration).toContain("'benchmark-prices',\n       'historical-prices',\n       'interactive_price_mirror'");
    expect(migration).toContain(
      "run_type not in ('benchmark-prices', 'interactive_price_mirror')",
    );
    expect(migration).toContain("eligibility must match its ingestion run");
    expect(migration).toContain("source must match its ingestion run");
    for (const table of [
      "catalog_observations",
      "price_observations",
      "price_coverage_checks",
      "source_record_outcomes",
    ]) {
      expect(migration).toContain(`create trigger ${table}_running_run_guard`);
    }
    expect(migration).toContain("create function canonical_family_taxonomy_json");
    expect(migration).toContain("create function assert_family_taxonomy_publication");
    expect(migration).toContain("create function validate_family_taxonomy_publication");
    expect(migration).toContain("create constraint trigger family_taxonomy_versions_publication_check");
    expect(migration).toContain("create constraint trigger reviewed_family_definitions_publication_check");
    expect(migration).toContain("create constraint trigger reviewed_family_aliases_publication_check");
    expect(migration).toContain("deferrable initially deferred");
    expect(migration).toContain("expected_family_count");
    expect(migration).toContain("expected_alias_count");
    expect(migration).toContain("content_json jsonb not null");
    expect(migration).toContain("sha256(convert_to");
    expect(runner).toContain("assert_family_taxonomy_publication(\n        'handleplan-reviewed-families@1.0.0'");
    expect(runner).toContain("select assert_family_taxonomy_publication(version_id)");
    expect(migration).toContain("create view reviewed_family_membership_public");
    expect(migration).toContain("with (security_barrier = true)");
    expect(migration).toContain("as reviewer_attested");
    expect(migration).toContain("reviewed_family_membership_decisions_latest_idx");
    expect(migration).toContain("create function enforce_family_taxonomy_build_window()");
    expect(migration).toContain("version.created_at = transaction_timestamp()");
    expect(migration).toContain("create trigger reviewed_family_definitions_build_window");
    expect(migration).toContain("create trigger reviewed_family_aliases_build_window");
    expect(migration).toContain("decision in ('approved', 'candidate', 'rejected')");
    expect(migration).toContain("method in ('deterministic_rule', 'human_review')");
    expect(migration).toContain("reviewer_id is not null");
    expect(migration).toContain("rule_version is not null");
    for (const table of [
      "family_taxonomy_versions",
      "reviewed_family_definitions",
      "reviewed_family_aliases",
      "reviewed_family_membership_decisions",
    ]) {
      expect(migration).toContain(`create trigger ${table}_append_only`);
    }
    expect(migration).toContain(artifact.versionId);
    expect(migration).toContain(artifact.publishedAt);
    expect(migration).toContain(artifact.contentSha256);
    expect(migration).toContain("'family:brod', 'brod', 'Brød'");
    expect(migration).toContain("'family:kaffe', 'kaffe', 'Kaffe'");
    expect(migration).toContain("'family:melk', 'melk', 'Melk'");
    expect(migration).toContain("'family:brod', 'brød'");
    expect(migration).toContain("'family:melk', 'mjølk'");
    expect(runner).toMatch(/webReadOnlyTables[\s\S]*family_taxonomy_versions/);
    expect(runner).toMatch(/webReadOnlyTables[\s\S]*reviewed_family_membership_public/);
    const webList = runner.match(/const webReadOnlyTables = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect(webList).not.toContain('"reviewed_family_membership_decisions"');
    const workerLists = [
      "protectedAppendOnlyTables",
      "workerReadOnlyTables",
      "insertUpdateTables",
      "replaceableTables",
      "ephemeralRequestBudgetTables",
      "runtimeSequences",
    ].map((name) => runner.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] ?? "");
    expect(workerLists.join("\n")).not.toContain("family_taxonomy_versions");
    expect(workerLists.join("\n")).not.toContain("reviewed_family_definitions");
    expect(workerLists.join("\n")).not.toContain("reviewed_family_aliases");
    expect(workerLists.join("\n")).not.toContain("reviewed_family_membership_decisions");
    expect(JSON.parse(packageManifest).exports["./reviewed-family-reader"]).toBe(
      "./src/reviewed-family-reader.ts",
    );
  });

  it("separates the migration owner, write-capable worker, and read-only web roles", async () => {
    const [runner, compose, rollbackCompose, entrypoint, deploy, proof, workflow] = await Promise.all([
      readFile(migrationRunner, "utf8"),
      readFile(productionCompose, "utf8"),
      readFile(legacyRollbackCompose, "utf8"),
      readFile(productionEntrypoint, "utf8"),
      readFile(productionDeploy, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
      readFile(ciWorkflow, "utf8"),
    ]);

    expect(runner).toContain("DATABASE_MIGRATION_URL");
    expect(runner).toContain("APP_DATABASE_PASSWORD");
    expect(runner).toContain("WEB_DATABASE_PASSWORD");
    expect(runner).toContain('const workerRole = "handleplan_app"');
    expect(runner).toContain('const webRole = "handleplan_web"');
    expect(runner).toContain("webReadOnlyTables");
    expect(runner).toContain('"public_state_changed_at"');
    expect(runner).toContain('"handleplan_schema_migrations"');
    expect(runner).not.toContain("reassign owned by");
    expect(runner).not.toMatch(
      /grant select on table \$\{identifiers\(webReadOnlyTables\)\}\s+to \$\{workerRole\}/,
    );
    const webAllowlist = runner.match(/const webReadOnlyTables = \[([\s\S]*?)\];/)?.[1];
    expect(webAllowlist).toBeDefined();
    expect(webAllowlist).not.toContain('"publication_captures"');
    expect(webAllowlist).not.toContain('"review_actions"');
    expect(webAllowlist).not.toContain('"worker_leases"');
    expect(webAllowlist).not.toContain('"worker_job_results"');
    expect(webAllowlist).not.toContain('"provider_request_budget_events"');
    expect(compose).toMatch(/migrate:[\s\S]*DATABASE_MIGRATION_URL:/);
    expect(compose).toContain(
      "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${WEB_DATABASE_PASSWORD:?WEB_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${HANDLEPLAN_MIGRATION_IMAGE:?HANDLEPLAN_MIGRATION_IMAGE is required}",
    );
    expect(compose).toMatch(/app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_web:/);
    expect(compose).toMatch(/worker:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_app:/);
    expect(compose).not.toMatch(/app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan:/);
    const appBlock = compose.match(/  app:\n([\s\S]*?)\n  worker:/)?.[1];
    expect(appBlock).toBeDefined();
    expect(appBlock).not.toContain("KASSAL_API_KEY");
    expect(appBlock).not.toContain("KASSAL_BASE_URL");
    expect(appBlock).not.toContain("KASSAL_MODE");
    expect(compose).toMatch(
      /app:[\s\S]*migrate:[\s\S]*condition: service_completed_successfully/,
    );
    expect(compose).toMatch(
      /app:[\s\S]*healthcheck:[\s\S]*127\.0\.0\.1:3000\/api\/ready/,
    );
    expect(entrypoint).not.toContain("migrate.mjs");
    expect(deploy).toContain('HANDLEPLAN_MIGRATION_IMAGE="$migration_image"');
    expect(deploy).toContain(
      'deploy "$previous_revision" "$revision" "$previous_compatibility_mode"',
    );
    expect(deploy).toContain('record_deployment_state "$state_dir" "$revision" current');
    expect(deploy).toContain("compose.rollback-legacy.yml");
    expect(deploy).toContain("rm -f worker");
    expect(rollbackCompose).toContain("postgresql://handleplan_web:");
    expect(rollbackCompose).toContain("KASSAL_API_KEY: legacy-rollback-network-disabled");
    expect(rollbackCompose).toContain("KASSAL_BASE_URL: https://127.0.0.1:1");
    expect(rollbackCompose).not.toContain("postgresql://handleplan_app:");
    expect(rollbackCompose).not.toContain("${KASSAL_API_KEY");
    expect(rollbackCompose).not.toContain("https://kassal.app/");
    expect(rollbackCompose).toContain("127.0.0.1:3000/api/health");
    expect(rollbackCompose).not.toContain("worker:");
    expect(proof).toContain("handleplan.allow_append_only_mutation");
    expect(proof).toContain("disable trigger source_permissions_append_only");
    expect(proof).toContain("has_table_privilege");
    expect(proof).toContain("budget_select");
    expect(proof).toContain("budget_insert");
    expect(proof).toContain("budget_delete");
    expect(proof).toContain("budget_update");
    expect(proof).toContain("provider_request_budget_events");
    expect(proof).toContain('const webRole = "handleplan_web"');
    expect(proof).toContain("web SELECT must read public price evidence");
    expect(proof).toContain("web role must not read private publication captures");
    expect(proof).toContain("web role must not write canonical products");
    expect(workflow).toMatch(
      /- name: Prove runtime database least privilege[\s\S]*prove-runtime-database-role\.mjs/,
    );
  });

  it("rejects any shared owner, worker, or web credential before connecting", () => {
    const sharedRuntime = runMigrationWith({
      WEB_DATABASE_PASSWORD: "proof_app_url_safe_000000000000000001",
    });
    const sharedOwner = runMigrationWith({
      WEB_DATABASE_PASSWORD: "proof_admin_url_safe_000000000001",
    });

    expect(sharedRuntime.status).not.toBe(0);
    expect(sharedRuntime.stderr).toContain("Worker and web database credentials must differ");
    expect(sharedOwner.status).not.toBe(0);
    expect(sharedOwner.stderr).toContain("Migration and web database credentials must differ");
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
    expect(proof).toContain("verifyTaxonomyPublicationGuards(source)");
    expect(proof).toContain("verifyTaxonomyPublicationGuards(restored)");
    expect(proof).toContain("set constraints all immediate");
    expect(proof).toContain("family:proof-late-definition");
    expect(proof).toContain("family:proof-late-alias");
    expect(proof).not.toContain(".catch(() => undefined)");
    expect(legacy).toContain("insert into price_cache");
    expect(restore).toContain("insert into source_permissions");
    expect(restore).toContain("insert into publication_captures");
    expect(restore).toContain("insert into review_actions");
    expect(restore).toContain("insert into catalog_observations");
    expect(restore).toContain("insert into reviewed_family_membership_decisions");
    expect(workflow).toMatch(
      /- name: Prove migration upgrade and backup restore[\s\S]*node tests\/acceptance\/prove-database-upgrade\.mjs/,
    );
    expect(runbook).toMatch(/permission audit.*publication capture.*review audit/is);
    expect(runbook).toMatch(/ordinary-only.*blocked.*official claims/is);
    expect(runbook).toMatch(/migrations 002 through 012.*all twelve/is);
    expect(runbook).toMatch(/request-budget.*ephemeral.*SELECT.*INSERT.*DELETE/is);
    expect(runbook).toMatch(/terminalized_at.*backfilled.*fails closed/is);
    expect(runbook).toMatch(/content_json.*SHA-256.*pg_restore/is);
    expect(runbook).toMatch(/does not prove.*off-host.*retention/is);
  });
});
