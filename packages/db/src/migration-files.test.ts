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
      OPERATIONS_DATABASE_PASSWORD: "proof_operations_url_safe_00000000001",
      REVIEW_DATABASE_PASSWORD: "proof_review_url_safe_0000000000000001",
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
      "013_physical_store_directory.sql",
      "014_ingestion_completion_clock.sql",
      "015_catalog_category_path.sql",
      "016_worker_source_health.sql",
      "017_geographic_directory_region_proof.sql",
      "018_review_candidate_immutability.sql",
      "019_public_api_request_budget.sql",
      "020_official_offer_trust_fences.sql",
      "021_private_review_decision_boundary.sql",
      "022_public_official_offer_projection.sql",
      "023_official_offer_worker_jobs.sql",
      "024_operations_runtime_boundary.sql",
      "025_private_review_evidence_renderer.sql",
      "026_official_offer_publication_runtime.sql",
    ]);
  });

  it("dynamically guards every post-001 migration against destructive table rewrites", async () => {
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    expect(files[0]).toBe("001_price_cache.sql");
    const guardedFiles = files.slice(1);
    expect(guardedFiles.at(-1)).toBe("026_official_offer_publication_runtime.sql");
    const source = (
      await Promise.all(
        guardedFiles.map((file) => readFile(path.join(migrationsDirectory, file), "utf8")),
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

  it("keeps public API admission global, identity-free, and EXECUTE-only for web", async () => {
    const [migration, runner, packageManifest, backupToolkit, runtimeProof] =
      await Promise.all([
        readFile(
          path.join(migrationsDirectory, "019_public_api_request_budget.sql"),
          "utf8",
        ),
        readFile(migrationRunner, "utf8"),
        readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
        readFile(
          fileURLToPath(new URL("../../../deploy/backup/toolkit.mjs", import.meta.url)),
          "utf8",
        ),
        readFile(runtimeRoleProof, "utf8"),
      ]);

    expect(migration).toContain("create table public_api_request_budget_events");
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog, pg_temp");
    expect(migration).toContain("pg_catalog.pg_try_advisory_xact_lock");
    expect(migration).toContain("delete from public.public_api_request_budget_events");
    expect(migration).toContain("insert into public.public_api_request_budget_events");
    expect(migration).toContain("revoke all on function claim_public_api_request_budget(text) from public");
    const tableDefinition = migration.match(
      /create table public_api_request_budget_events \(([\s\S]*?)\n\);/iu,
    )?.[1];
    expect(tableDefinition).toBeDefined();
    expect(tableDefinition).not.toMatch(/\b(bigserial|generated|identity)\b/iu);
    expect(tableDefinition).not.toMatch(
      /ip|user_agent|query|basket|address|coordinate|token|request_hash/iu,
    );
    for (const routeKey of [
      "discovery-impact",
      "discovery-search",
      "locations-current",
      "locations-search",
      "plan-candidates",
      "plans",
      "plans-travel",
      "products-search",
      "source-status",
    ]) {
      expect(migration).toContain(`'${routeKey}'`);
    }

    expect(runner).toContain(
      'migrationFiles.includes(\n  "019_public_api_request_budget.sql",\n)',
    );
    expect(runner).toContain(
      "grant execute on function public.claim_public_api_request_budget(text)",
    );
    expect(runner).not.toMatch(
      /grant[^;]*on table[^;]*public_api_request_budget_events[^;]*to \$\{webRole\}/isu,
    );
    expect(JSON.parse(packageManifest).exports["./public-api-request-budget"])
      .toBe("./src/public-api-request-budget.ts");
    expect(backupToolkit).toContain(
      "--exclude-table-data=public.public_api_request_budget_events",
    );
    expect(runtimeProof).toContain("web role must not read public API request-budget state directly");
    expect(runtimeProof).toContain("claim_public_api_request_budget('plans')");
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

  it("appends one privacy-safe source-health snapshot per non-cancelled worker result", async () => {
    const [migration, runner, packageManifest] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "016_worker_source_health.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ]);

    expect(migration).toContain("worker_job_id varchar(200)");
    expect(migration).toContain("source_health_snapshots_worker_job_uidx");
    expect(migration).toContain("source_health_snapshots_worker_payload_allowlist");
    expect(migration).toContain("source_health_snapshots_success_clocks_not_future");
    expect(migration).toMatch(
      /function validate_worker_source_health_snapshot\(\)[\s\S]*set search_path = pg_catalog, public[\s\S]*as \$\$/,
    );
    expect(migration).toContain("public.worker_job_results%rowtype");
    expect(migration).toContain("from public.worker_job_results");
    expect(migration).toContain("from public.source_health_snapshots health");
    expect(migration).toContain("completion cannot be in the future");
    expect(migration).toContain("requires canonical aggregate counters");
    expect(migration).toContain("requires consistent aggregate counters");
    expect(migration).toContain("count(*) from jsonb_object_keys(worker_result.counts)");
    expect(migration).not.toContain("jsonb_object_length");
    expect(migration).toContain("zero-accepted-record ingestion requires degraded source health");
    expect(migration).toContain("worker discovery success must match deterministic job progress");
    expect(migration).toContain("worker capture success must match deterministic job progress");
    expect(migration).toContain("worker counters cannot advance governed publish success");
    expect(migration).toContain("worker counters cannot advance governed eligible evidence");
    expect(migration).toContain("cancelled worker results do not assert a source-health state");
    expect(migration).toContain("source_health_snapshots_append_only");
    expect(runner).toMatch(/protectedAppendOnlyTables[\s\S]*source_health_snapshots/);
    expect(runner).toContain("source_health_snapshots_id_seq");
    expect(runner).toContain("workerSourceHealthEnabled");
    expect(runner).toContain('migrationFiles.includes(\n  "016_worker_source_health.sql"');
    expect(JSON.parse(packageManifest).exports["./source-health-writer"]).toBe(
      "./src/source-health-writer.ts",
    );
  });

  it("adds source-neutral official-offer jobs without rewriting the applied worker migrations", async () => {
    const [workerMigration, healthMigration, forwardMigration] = await Promise.all([
      readFile(path.join(migrationsDirectory, "010_worker_job_results.sql"), "utf8"),
      readFile(path.join(migrationsDirectory, "016_worker_source_health.sql"), "utf8"),
      readFile(
        path.join(migrationsDirectory, "023_official_offer_worker_jobs.sql"),
        "utf8",
      ),
    ]);

    expect(workerMigration).not.toContain("official-offer-ingestion");
    expect(healthMigration).not.toContain("official-offer-ingestion");
    expect(forwardMigration).toContain("drop constraint worker_job_results_job_kind");
    expect(forwardMigration).toContain("'official-offer-ingestion'");
    expect(forwardMigration).toContain("'official-offer-lifecycle-reconcile'");
    expect(forwardMigration).toContain(
      "create or replace function validate_worker_source_health_snapshot()",
    );
    expect(forwardMigration).toContain(
      "official-offer lifecycle results do not assert source-health snapshots",
    );
    expect(forwardMigration).toContain(
      "worker_result.job_kind in ('catalog-refresh', 'official-offer-ingestion')",
    );
    expect(forwardMigration).toContain(
      "worker counters cannot advance governed publish success",
    );
  });

  it("seals versioned postal directories once and rejects late child append", async () => {
    const [migration, runner, roleProof] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "017_geographic_directory_region_proof.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
    ]);

    expect(migration).toContain("status in ('building', 'approved', 'blocked', 'retired')");
    expect(migration).toContain("sealed_at timestamptz");
    expect(migration).toContain("geographic_postal_directory_seal_state");
    expect(migration).toContain("new.sealed_at := statement_timestamp()");
    expect(migration).toContain("create table public.geographic_postal_directory_versions");
    expect(migration).toContain("create view public.physical_store_region_branches_public");
    expect(migration).toContain("function public.guard_geographic_postal_directory_version()");
    expect(migration).toContain("function public.guard_geographic_postal_directory_child()");
    expect(migration).toContain("for update");
    expect(migration).toContain("sealed postal directory children are immutable");
    expect(migration).toContain("postal directory region count must match immutable codes");
    expect(migration).not.toContain("create constraint trigger geographic_postal_directory");
    expect(migration).not.toContain("deferrable initially deferred");
    expect(runner).toContain('"geographic_postal_directory_versions"');
    expect(runner).toContain('"physical_store_region_branches_public"');
    expect(runner).toContain('set search_path = public, pg_catalog');
    expect(runner).toContain('set local search_path = public, pg_catalog');
    expect(runner).toContain("public.handleplan_schema_migrations");
    expect(roleProof).toContain("approved postal directories must reject late child append");
    expect(roleProof).toContain("migration runner must ignore hostile role search_path");
    expect(roleProof).toContain(
      "current terminal status must not authorize an evaluation from before sealed_at",
    );
    expect(roleProof).toContain("sealedGeographicDirectory: true");
  });

  it("seals candidates and prevents direct offer publication from review inserts", async () => {
    const [migration, roleProof] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "018_review_candidate_immutability.sql"),
        "utf8",
      ),
      readFile(runtimeRoleProof, "utf8"),
    ]);

    expect(migration).toContain("create trigger extracted_offer_candidates_append_only");
    expect(migration).toContain("before update or delete on extracted_offer_candidates");
    expect(migration).toContain("execute function reject_append_only_mutation()");
    expect(migration).toContain("extracted_offer_candidates_pending_queue_idx");
    expect(migration).toContain("include (extraction_run_id, confidence)");
    expect(migration).toContain("extracted_offer_candidates_pending_confidence_idx");
    expect(migration).toContain("extracted_offer_candidates_pending_anomalies_idx");
    expect(migration).toContain("using gin (anomaly_codes jsonb_path_ops)");
    expect(migration.match(/where status = 'pending'/g)).toHaveLength(3);
    expect(migration).not.toMatch(/\bupdate\s+extracted_offer_candidates\b/i);
    expect(migration).not.toMatch(/\bdelete\s+from\s+extracted_offer_candidates\b/i);
    expect(migration).toContain("approved_offers_published_candidate_binding");
    expect(migration).toContain("status <> 'published' or candidate_id is not null");
    expect(migration).toContain("function enforce_approved_offer_insert_boundary()");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("new.status is distinct from 'approved'");
    expect(migration).toContain("session_user = 'handleplan_review'");
    expect(migration).toContain("current_user = 'handleplan_review'");
    expect(migration).toContain("new.candidate_id is null");
    expect(migration).toContain("create trigger approved_offers_insert_boundary");
    expect(migration).toContain("before insert on approved_offers");
    expect(migration).toContain("publication requires the guarded update path");
    // Assert the denied mutations themselves rather than coupling this gate to
    // the human-readable failure labels in the runtime proof.
    expect(roleProof).toContain('const directPublishedOfferKey =');
    expect(roleProof).toContain('const candidateLessOfferKey =');
    expect(roleProof).toContain("update approved_offers set status = 'published' where false");
  });

  it("binds official-offer identity, rights, timing, and as-of clocks", async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, "020_official_offer_trust_fences.sql"),
      "utf8",
    );

    for (const field of [
      "content_kind varchar(24)",
      "declared_geographic_scope jsonb",
      "edition_identity_sha256 char(64)",
      "discovery_permission_id bigint",
      "capture_permission_id bigint",
      "capture_permission_capabilities jsonb",
      "extraction_method varchar(24)",
      "extraction_permission_id bigint",
      "ocr_permission_id bigint",
      "permission_capabilities jsonb",
      "source_started_at timestamptz",
      "source_completed_at timestamptz",
      "empty_result varchar(24)",
      "empty_confirmation jsonb",
      "empty_confirmation_observed_at timestamptz",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain("publications_offer_identity_complete");
    expect(migration).toContain("publication official-offer identity is immutable");
    expect(migration).toContain("terminal extraction runs are immutable evidence");
    expect(migration).toContain("new.completed_at := pg_catalog.clock_timestamp()");
    expect(migration).toContain("new official-offer extraction runs must be terminal");
    expect(migration).toContain("official-offer extraction timing is outside the trusted boundary");
    expect(migration).toContain("hashtextextended(new.source_id, 7229164304)");
    expect(migration).toContain("hashtextextended(old.id, 7229164304)");
    expect(migration).toContain("source_permissions_governance_fence_lock");
    expect(migration).toContain("new.created_at := pg_catalog.clock_timestamp()");
    expect(migration).toContain("data_sources_governance_fence_lock");
    expect(migration).toContain("create function assert_current_official_offer_permission(");
    expect(migration).toContain("permission.permissions -> 'officialOfferCapabilities'");
    expect(migration).toContain("permission.permissions -> 'officialOfferRightsClassifications'");
    expect(migration).toContain(
      "pg_catalog.jsonb_typeof(current_capabilities) is distinct from 'array'",
    );
    expect(migration).toContain("official-offer permission capabilities are missing");
    expect(migration).toContain("current_permission_id is distinct from asserted_permission_id");
    expect(migration).toContain("order by candidate.created_at desc, candidate.id desc");
    expect(migration).not.toContain("order by candidate.reviewed_at desc");
    expect(migration).toContain("asserted_capabilities is distinct from current_capabilities");
    expect(migration).toContain("not (current_rights ? asserted_rights_classification)");
    expect(migration).toContain("publication capture requires trusted publication identity");
    expect(migration).toContain("new.retrieved_at := pg_catalog.clock_timestamp()");
    expect(migration).toContain("extraction run requires trusted capture provenance");
    expect(migration).toContain("new.empty_confirmation_observed_at := new.completed_at");
    expect(migration).toContain("confirmed-empty evidence is not canonically bound");
    expect(migration).toContain("create function canonical_official_offer_edition_identity(");
    expect(migration).toContain("pg_catalog.sha256(pg_catalog.convert_to(");
    expect(migration).toContain("identity digest does not match stored facts");
    expect(migration).toContain("create function enforce_geographic_scope_member_limit()");
    expect(migration).toContain("geographic_scope_regions_member_limit");
    expect(migration).toContain("geographic_scope_postal_codes_member_limit");
    expect(migration).toContain("geographic_scope_stores_member_limit");
    expect(migration).toContain("official-offer geographic scope membership is sealed");
    expect(migration).toContain("geographic_scopes_offer_identity_boundary");
    expect(migration).toContain("official-offer geographic scope identity is immutable");
    expect(migration).toContain("new.ocr_permission_id");
    expect(migration).toContain("offer_targets add column created_at timestamptz");
    for (const table of [
      "publications",
      "publication_captures",
      "extraction_runs",
      "extracted_offer_candidates",
      "approved_offers",
      "offer_targets",
      "review_actions",
    ]) {
      expect(migration).toContain(`create trigger ${table}_creation_clock`);
    }
    expect(migration).toContain("create trigger approved_offers_state_clock");
    expect(migration).toContain("new.updated_at := pg_catalog.clock_timestamp()");
    expect(migration).not.toMatch(/pg_catalog\.(?:coalesce|greatest|least)\s*\(/iu);
    expect(migration).not.toMatch(/\bdrop\s+(table|column)\b/iu);
    const fixture = await readFile(restoreFixture, "utf8");
    expect(fixture).toContain("canonical_official_offer_edition_identity(");
    expect(fixture).not.toContain("repeat('b', 64)");
    expect(fixture).not.toContain("order by reviewed_at desc");
  });

  it("projects reviewed official offers through one bounded public-only function", async () => {
    const [migration, runner] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "022_public_official_offer_projection.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
    ]);

    expect(migration).toContain("create function public.public_official_offer_rows_v1(");
    expect(migration).toContain("returns table (");
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog, pg_temp");
    expect(migration).toContain("revoke all on function public.public_official_offer_rows_v1(");
    expect(migration).toContain("v_product_count not between 1 and 50");
    expect(migration).toContain("pg_catalog.array_ndims(p_product_ids) is distinct from 1");
    expect(migration).toContain("ranked.product_rank <= 51");
    expect(migration).toContain("globally_bounded as materialized");
    expect(migration).toContain("limit 501");
    expect(migration).toContain("create function public.assert_public_official_offer_payload_v1(");
    expect(migration).toContain("p_payload_bytes > 8388608");
    expect(migration).toContain("exceeds the 8 MiB payload bound");
    expect(migration).toContain("public_rows as materialized");
    expect(migration).toContain("counted.total_offer_count\n    from counted");
    expect(migration).toContain("pg_catalog.octet_length(\n        pg_catalog.row_to_json(public_rows)::text");
    expect(migration).not.toContain("pg_catalog.to_jsonb(counted)::text");
    expect(migration).toContain(
      ")) over () + pg_catalog.count(*) over () + 1 as total_payload_bytes",
    );
    expect(migration).toContain("payload_bounded.total_payload_bytes");
    expect(migration).toContain("v_database_now + interval '5 seconds'");
    expect(migration).toContain(
      "v_evaluation_as_of := least(p_evaluation_as_of, v_database_now)",
    );
    expect(migration).not.toMatch(/pg_catalog\.(?:coalesce|greatest|least)\s*\(/iu);

    // 021 stores state at the top level, while reviewed decision facts live
    // below `decision`. A nested state path would make every valid row vanish.
    expect(migration).toContain("review.new_values ->> 'state' = 'approved'");
    expect(migration).not.toContain("review.new_values #>> '{decision,state}'");
    expect(migration).toContain("review.new_values #> '{decision,channels}'");
    expect(migration).toContain(
      "review.new_values #>> '{decision,eligibility,programId}'",
    );
    expect(migration).toContain("'[\"online\", \"in-store\"]'::jsonb");
    expect(migration).toContain("create function public.is_canonical_membership_program_id_v1(");
    expect(migration).toContain("p_value is nfc normalized");
    expect(migration).toContain("between 917536 and 917631");
    expect(migration).toContain("public.is_canonical_membership_program_id_v1(");
    expect(migration).toContain("review.new_values ->> 'decisionSha256'");
    expect(migration).toContain(
      "alter table public.review_actions add column decision_boundary_version smallint",
    );
    expect(migration).toContain("review.decision_boundary_version = 1");
    expect(migration).toContain(
      "order by current_review.created_at desc,\n               current_review.id desc",
    );
    expect(migration).not.toContain("order by current_review.expected_version desc");
    expect(migration).toContain("review.previous_values = pg_catalog.jsonb_build_object(");
    expect(migration).toContain("candidate.normalized_fields::text");
    expect(migration).toContain(
      "candidate.normalized_fields ->> 'publicationRoute' = 'human-review-required'",
    );
    expect(migration).toContain(
      "candidate.normalized_fields ->> 'disposition' in (",
    );
    expect(migration).toContain("'exact-match', 'review-required'");
    expect(migration).toContain(
      "= 'product:' || target.product_id::text",
    );
    expect(migration).toContain("candidate.normalized_fields #> '{candidate,geographicScope}'");
    expect(migration).toContain("review.actor_id ~ '^access:[0-9a-f]{64}$'");
    expect(migration).toContain("review.acted_at <= review.created_at");
    expect(migration).toContain("offer.source_reference = 'review-candidate:'");

    // Stored offer/target facts must be exactly the reviewed decision, not a
    // recombination of independently valid rows.
    for (const path of [
      "{decision,target,kind}",
      "{decision,target,gtin}",
      "{decision,validity,startsAt}",
      "{decision,validity,endsAt}",
      "{decision,pricing,kind}",
      "{decision,pricing,offerPriceOre}",
      "{decision,pricing,beforePriceOre}",
      "{decision,pricing,quantity}",
      "{decision,pricing,totalOre}",
      "{decision,pricing,beforeUnitPriceOre}",
    ]) {
      expect(migration).toContain(path);
    }
    expect(migration).toContain("identifier.product_id = target.product_id");
    expect(migration).toContain("offer.membership_requirement = 'public'");
    expect(migration).toContain("offer.membership_requirement = 'member'");

    // A current re-approval cannot launder evidence gathered under a stale
    // permission; OCR additionally remains current-capability gated.
    expect(migration).toContain("publication.discovery_permission_id = permission.id");
    expect(migration).toContain("capture.capture_permission_id = permission.id");
    expect(migration).toContain(
      "capture.capture_permission_capabilities\n            = permission.permissions -> 'officialOfferCapabilities'",
    );
    expect(migration).toContain("extraction.extraction_permission_id = permission.id");
    expect(migration).toContain(
      "extraction.permission_capabilities\n            = permission.permissions -> 'officialOfferCapabilities'",
    );
    expect(migration).toContain("extraction.ocr_permission_id = permission.id");
    expect(migration).toContain(
      "permission.permissions -> 'officialOfferCapabilities' ? 'ocr'",
    );
    expect(migration).toContain(
      "permission.permissions -> 'officialOfferRightsClassifications'\n            ? capture.rights_classification",
    );

    for (const predicate of [
      "product.created_at <= v_evaluation_as_of",
      "source.created_at <= v_evaluation_as_of",
      "scope.created_at <= v_evaluation_as_of",
      "publication.discovered_at <= v_evaluation_as_of",
      "extraction.started_at <= v_evaluation_as_of",
      "extraction.source_started_at <= v_evaluation_as_of",
      "extraction.source_completed_at <= v_evaluation_as_of",
      "capture.retrieved_at >= v_evaluation_as_of - interval '14 days'",
    ]) {
      expect(migration).toContain(predicate);
    }

    // Conditions are persistence-clocked, append-only, sealed at publication,
    // and every supported condition must exactly match the reviewed decision.
    expect(migration).toContain("offer_conditions add column created_at timestamptz");
    expect(migration).toContain(
      "alter column created_at set default pg_catalog.transaction_timestamp()",
    );
    expect(migration).toContain("official-offer conditions are append-only");
    expect(migration).toContain("published official-offer conditions are sealed");
    expect(migration).toContain("for share");
    expect(migration).toContain("condition_row.condition_type = 'channel'");
    expect(migration).toContain("condition_row.condition_type = 'membership'");
    expect(migration).toContain("condition_row.condition_type = 'quantity'");
    expect(migration).toContain("between offer.multibuy_group_amount_ore::bigint");
    expect(migration).toContain("and 9007199254740991::bigint");

    expect(runner).toContain(
      'migrationFiles.includes(\n  "022_public_official_offer_projection.sql",\n)',
    );
    expect(runner).toContain(
      "grant execute on function public.public_official_offer_rows_v1(\n"
      + "          bigint[], timestamp with time zone",
    );
    expect(runner).not.toMatch(
      /grant select on table (?:approved_offers|offer_conditions|offer_targets|publications|publication_captures|extraction_runs|extracted_offer_candidates|review_actions) to \$\{webRole\}/u,
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
    expect(runner).toContain("select public.assert_family_taxonomy_publication(version_id)");
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

  it("persists complete physical-store snapshots as immutable run-scoped evidence", async () => {
    const [migration, runner, proof] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "013_physical_store_directory.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
    ]);

    expect(migration).toContain("create table physical_store_observations");
    expect(migration).toContain("create table physical_store_coverage_checks");
    expect(migration).toContain("ingestion_run_id bigint not null references ingestion_runs(id)");
    expect(migration).toContain("physical_store_observations_branch_key_binding");
    expect(migration).toContain("physical_store_coverage_checks_reason_state");
    expect(migration).toContain("state in ('complete', 'unknown')");
    expect(migration).toContain("create trigger physical_store_observations_creation_clock");
    expect(migration).toContain("create trigger physical_store_coverage_checks_creation_clock");
    expect(migration).toContain("create trigger physical_store_observations_append_only");
    expect(migration).toContain("create trigger physical_store_coverage_checks_append_only");
    expect(migration).toContain("create function enforce_running_physical_store_evidence_insert()");
    expect(migration).toContain("run_type is distinct from 'physical-stores'");
    expect(migration).toContain("new.source_id is distinct from run_source_id");
    expect(migration).toContain("from ingestion_runs\n  where id = new.ingestion_run_id\n  for update");
    expect(migration).toContain("create view physical_store_branches_public");
    expect(migration).toContain("create function enforce_completed_physical_store_run_consistency()");
    expect(migration).toContain("create trigger ingestion_runs_physical_store_completion_guard");
    expect(migration).toContain("complete physical-store coverage count does not match observations");
    expect(migration).toContain("with (security_barrier = true)");
    expect(migration).toContain("'branch:' || observation.ingestion_run_id::text || ':'");
    expect(migration).not.toContain("observation.ingestion_run_id,\n  'branch:'");
    expect(migration).toContain("where observation.status = 'active'");
    expect(migration).not.toContain("observation.address_line");
    expect(migration).not.toContain("observation.postal_code");
    expect(migration).not.toContain("observation.municipality_code");

    const webList = runner.match(/const webReadOnlyTables = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect(webList).toContain('"physical_store_branches_public"');
    expect(webList).toContain('"physical_store_coverage_checks"');
    expect(webList).not.toContain('"physical_stores"');
    expect(webList).not.toContain('"physical_store_observations"');
    expect(runner).toMatch(/protectedAppendOnlyTables[\s\S]*physical_store_observations/);
    expect(runner).toMatch(/protectedAppendOnlyTables[\s\S]*physical_store_coverage_checks/);
    expect(proof).toContain('"physical_store_branches_public"');
    expect(proof).toContain('"physical_store_coverage_checks"');
    expect(proof).toContain("web role must not read private physical stores");
  });

  it("rejects future ingestion completion clocks before terminal evidence can publish", async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, "014_ingestion_completion_clock.sql"),
      "utf8",
    );

    expect(migration).toContain("lock table ingestion_runs in share row exclusive mode");
    expect(migration).toContain("completed_at > statement_timestamp()");
    expect(migration).toContain("terminalized_at < completed_at");
    expect(migration).toContain("terminal_time := statement_timestamp()");
    expect(migration).toContain("new.completed_at > terminal_time");
    expect(migration).toContain("ingestion_runs completion cannot be in the future");
    expect(migration).toContain("ingestion_runs_completion_not_after_terminalization");
    expect(migration).toContain("completed_at <= terminalized_at");
  });

  it("adds strict nullable category evidence to immutable catalog observations", async () => {
    const [migration, catalogMigration, taxonomyMigration] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "015_catalog_category_path.sql"),
        "utf8",
      ),
      readFile(
        path.join(migrationsDirectory, "011_catalog_observations.sql"),
        "utf8",
      ),
      readFile(
        path.join(migrationsDirectory, "012_reviewed_family_taxonomy.sql"),
        "utf8",
      ),
    ]);

    expect(migration).toContain("add column category_path jsonb");
    expect(migration).not.toContain("category_path jsonb not null");
    expect(migration).toMatch(/NULL means.*not captured.*\[\].*explicitly returned/is);
    expect(migration).toContain("catalog_observations_category_path_shape");
    expect(migration).toContain("jsonb_array_length(category_path) <= 100");
    expect(migration).toContain("category_entry ?& array['sourceCategoryId', 'depth', 'name']");
    expect(migration).toContain("from jsonb_object_keys(category_entry)");
    expect(migration).toContain("source_category_id !~ '^(0|[1-9][0-9]{0,15})$'");
    expect(migration).toContain("source_category_numeric > 9007199254740991");
    expect(migration).toContain("source_category_id = any(seen_source_category_ids)");
    expect(migration).toContain("category_depth not between 0 and 100");
    expect(migration).toContain("category_depth < previous_category_depth");
    expect(migration).toContain("source_category_numeric <= previous_source_category_numeric");
    expect(migration).toContain("char_length(category_name) not between 1 and 500");
    expect(migration).toContain("catalog_observations_category_path_guard");
    expect(migration).toMatch(
      /using gin \(category_path jsonb_path_ops\)[\s\S]*where category_path is not null/,
    );
    expect(migration).not.toMatch(/\bcreate\s+(table|sequence)\b/i);
    expect(migration).not.toMatch(/\bupdate\s+catalog_observations\b/i);
    expect(catalogMigration).toContain("catalog_observations_append_only");
    expect(taxonomyMigration).toContain("catalog_observations_running_run_guard");
  });

  it("gives private operations one bounded aggregate boundary and no direct state access", async () => {
    const [migration, lifecycleMigration, runner, proof, workflow] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "024_operations_runtime_boundary.sql"),
        "utf8",
      ),
      readFile(
        path.join(migrationsDirectory, "026_official_offer_publication_runtime.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
      readFile(ciWorkflow, "utf8"),
    ]);

    expect(migration).toContain("operations_boundary_version smallint");
    expect(migration).toContain("persisted_at timestamptz");
    expect(migration).toContain("alert_events_append_only");
    expect(migration).toContain("create function public.operations_dashboard_rows_v1(");
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog, pg_temp");
    expect(migration).toContain("set statement_timeout = '3000ms'");
    expect(migration).toContain("pg_catalog.cardinality(p_source_ids) not between 1 and 100");
    expect(migration).toContain("operations source roster must be canonically sorted");
    expect(migration).toContain("operations source roster does not match stored sources");
    expect(migration).toContain("limit 10001");
    expect(migration).toContain(
      "revoke all on function public.operations_dashboard_rows_v1(text[], integer)",
    );
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete|usage)\b/iu);
    expect(lifecycleMigration).toContain(
      "official_offer_promote_operations_review_boundary_v2",
    );
    expect(lifecycleMigration).toContain(
      "v_old text := 'and current_action.decision_boundary_version = 1'",
    );
    expect(lifecycleMigration).toContain(
      "v_new text := 'and current_action.decision_boundary_version = 2'",
    );
    expect(lifecycleMigration).toContain("if v_occurrences <> 3 then");
    expect(lifecycleMigration).toContain(
      "create or replace function public.operations_dashboard_rows_v1(",
    );
    expect(lifecycleMigration).toContain("set statement_timeout = ''3000ms''");
    expect(lifecycleMigration).toContain("set lock_timeout = ''500ms''");

    expect(runner).toContain("OPERATIONS_DATABASE_PASSWORD");
    expect(runner).toContain('const operationsRole = "handleplan_operations"');
    expect(runner).toContain('"024_operations_runtime_boundary.sql"');
    expect(runner).toContain("operationsRuntimeBoundaryEnabled");
    expect(runner).toContain("grant execute on function public.operations_dashboard_rows_v1(");
    expect(runner).not.toMatch(
      /grant\s+(?:select|insert|update|delete|usage)[^;]*to \$\{operationsRole\}/isu,
    );
    expect(proof).toContain('const operationsRole = "handleplan_operations"');
    expect(proof).toContain("operations role must not bypass its bounded aggregate function");
    expect(proof).toContain("operations output must stay on the exact aggregate-only contract");
    expect(proof).toContain("operations worker evidence must omit job IDs");
    expect(workflow).toMatch(
      /- name: Prove runtime database least privilege[\s\S]*OPERATIONS_DATABASE_PASSWORD:[\s\S]*prove-runtime-database-role\.mjs/,
    );
  });

  it("keeps private review evidence behind append-only render and v2 decision functions", async () => {
    const [migration, runner, proof] = await Promise.all([
      readFile(
        path.join(migrationsDirectory, "025_private_review_evidence_renderer.sql"),
        "utf8",
      ),
      readFile(migrationRunner, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
    ]);

    expect(migration).toContain("create table public.private_review_evidence_renders");
    expect(migration).toContain("create table public.private_review_evidence_consumptions");
    expect(migration).toContain("private_review_evidence_renders_append_only");
    expect(migration).toContain("private_review_evidence_consumptions_append_only");
    expect(migration).toContain("private_review_record_evidence_render_v1(");
    expect(migration).toContain("private_review_decide_v2(");
    expect(migration).toContain("v_render.candidate_id is distinct from p_candidate_id");
    expect(migration).toContain("v_render.expected_version is distinct from p_expected_version");
    expect(migration).toContain("v_render.actor_id is distinct from p_actor_id");
    expect(migration).toContain(
      "v_render.reviewer_session_id is distinct from p_reviewer_session_id",
    );
    expect(migration).toContain("v_render.presentation is distinct from 'full_capture'");
    expect(migration).toContain("v_render.expires_at <= v_decision_now");
    expect(migration).toContain("private_review_evidence_consumptions consumption");
    expect(migration).toContain("insert into public.private_review_evidence_consumptions");
    expect(migration).not.toMatch(/raw[_ ]token|raw[_ ]bytes|blob[_ ]bytes/iu);

    expect(runner).toContain('"025_private_review_evidence_renderer.sql"');
    expect(runner).toContain("privateReviewEvidenceRendererEnabled");
    expect(runner).toContain("revoke all on function public.private_review_decide_v1(");
    expect(runner).toContain(
      "grant execute on function public.private_review_record_evidence_render_v1(",
    );
    expect(runner).toContain("grant execute on function public.private_review_decide_v2(");
    expect(proof).toContain("decision_v1_execute: false");
    expect(proof).toContain("evidence_render_execute: true");
    expect(proof).toContain("decision_v2_execute: true");
  });

  it("separates owner, worker, public web, private review, and private operations roles", async () => {
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
    expect(runner).toContain("OPERATIONS_DATABASE_PASSWORD");
    expect(runner).toContain("REVIEW_DATABASE_PASSWORD");
    expect(runner).toContain("WEB_DATABASE_PASSWORD");
    expect(runner).toContain('const workerRole = "handleplan_app"');
    expect(runner).toContain('const webRole = "handleplan_web"');
    expect(runner).toContain('const reviewRole = "handleplan_review"');
    expect(runner).toContain('const operationsRole = "handleplan_operations"');
    expect(runner).toContain("webReadOnlyTables");
    expect(runner).toContain("webGeographicScopeColumns");
    expect(runner).toContain("webIngestionRunColumns");
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
    expect(webAllowlist).not.toContain('"geographic_scopes"');
    expect(webAllowlist).not.toContain('"ingestion_runs"');
    const reviewReadAllowlist = runner.match(
      /const reviewReadOnlyTables = \[([\s\S]*?)\];/,
    )?.[1];
    expect(reviewReadAllowlist).toBeDefined();
    expect(reviewReadAllowlist).toContain('"publication_captures"');
    expect(reviewReadAllowlist).toContain('"extracted_offer_candidates"');
    expect(reviewReadAllowlist).toContain('"review_actions"');
    expect(reviewReadAllowlist).not.toContain('"price_cache"');
    expect(reviewReadAllowlist).not.toContain('"worker_leases"');
    const reviewAppendAllowlist = runner.match(
      /const reviewAppendOnlyTables = \[([\s\S]*?)\];/,
    )?.[1];
    expect(reviewAppendAllowlist).toBeDefined();
    expect(reviewAppendAllowlist).toContain('"approved_offers"');
    expect(reviewAppendAllowlist).toContain('"offer_targets"');
    expect(reviewAppendAllowlist).toContain('"offer_conditions"');
    expect(reviewAppendAllowlist).toContain('"review_actions"');
    expect(reviewAppendAllowlist).not.toContain('"extracted_offer_candidates"');
    const reviewPermissionColumns = runner.match(
      /const reviewSourcePermissionColumns = \[([\s\S]*?)\];/,
    )?.[1];
    expect(reviewPermissionColumns).toBeDefined();
    expect(reviewPermissionColumns).toContain('"permissions"');
    expect(reviewPermissionColumns).not.toContain('"private_reference_key"');
    expect(reviewPermissionColumns).not.toContain('"notes"');
    expect(runner).not.toMatch(/grant (?:update|delete)[^;]+to \$\{reviewRole\}/i);
    const geographicScopeColumns = runner.match(
      /const webGeographicScopeColumns = \[([\s\S]*?)\];/,
    )?.[1];
    expect(geographicScopeColumns).toBeDefined();
    expect(geographicScopeColumns).toContain('"id"');
    expect(geographicScopeColumns).toContain('"label"');
    expect(geographicScopeColumns).not.toContain('"scope_key"');
    const ingestionRunColumns = runner.match(
      /const webIngestionRunColumns = \[([\s\S]*?)\];/,
    )?.[1];
    expect(ingestionRunColumns).toBeDefined();
    expect(ingestionRunColumns).toContain('"source_id"');
    expect(ingestionRunColumns).toContain('"terminalized_at"');
    expect(ingestionRunColumns).not.toContain('"job_id"');
    expect(ingestionRunColumns).not.toContain('"error_class"');
    expect(ingestionRunColumns).not.toContain('"counts"');
    expect(compose).toMatch(/migrate:[\s\S]*DATABASE_MIGRATION_URL:/);
    expect(compose).toContain(
      "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${WEB_DATABASE_PASSWORD:?WEB_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${REVIEW_DATABASE_PASSWORD:?REVIEW_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${OPERATIONS_DATABASE_PASSWORD:?OPERATIONS_DATABASE_PASSWORD is required}",
    );
    expect(compose).toContain(
      "${HANDLEPLAN_MIGRATION_IMAGE:?HANDLEPLAN_MIGRATION_IMAGE is required}",
    );
    expect(compose).toMatch(/app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_web:/);
    expect(compose).toMatch(
      /review:[\s\S]*REVIEW_DATABASE_URL: postgresql:\/\/handleplan_review:/,
    );
    expect(compose).toMatch(
      /operations:[\s\S]*OPERATIONS_DATABASE_URL: postgresql:\/\/handleplan_operations:/,
    );
    expect(compose).toMatch(/worker:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_app:/);
    expect(compose).not.toMatch(/app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan:/);
    const appBlock = compose.match(/  app:\n([\s\S]*?)\n  review:/)?.[1];
    expect(appBlock).toBeDefined();
    expect(appBlock).not.toContain("REVIEW_DATABASE_URL");
    expect(appBlock).not.toContain("REVIEW_ACCESS_");
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
    expect(deploy).not.toContain(
      'deploy "$previous_revision" "$revision" "$previous_compatibility_mode"',
    );
    expect(deploy).toContain(
      'deploy "$previous_revision" "$revision" legacy "$previous_fallback_image"',
    );
    expect(deploy).toContain("record_immutable_deployment_state");
    expect(deploy).toContain(
      '"$state_dir" "$revision" current "$loaded_image_id" "$revision"',
    );
    expect(deploy).toContain("compose.rollback-legacy.yml");
    expect(deploy).toContain('source_archive="$bundle_dir/handleplan-source.tar"');
    expect(deploy).toContain('docker image load --input "$image_archive"');
    expect(deploy).not.toContain("docker build");
    expect(deploy).toContain('"$deployment_high_water_revision" "$revision"');
    expect(deploy).toContain('deployment_source_dir="$build_root/source"');
    expect(deploy).toContain('-f "$deployment_source_dir/deploy/compose.production.yml"');
    expect(deploy).not.toContain('-f "$source_dir/deploy/compose.production.yml"');
    expect(deploy).toContain("remove_runtime_services() {");
    expect(deploy).toContain('stop "$runtime_service"');
    expect(deploy).toContain('rm -f "$runtime_service"');
    expect(deploy).toContain('ps -aq "$runtime_service"');
    expect(deploy).toContain(
      '"Failed deployment could not prove private runtimes, worker, and app absent; fallback refused"',
    );
    expect(deploy).toContain("review operations worker app || return 1");
    expect(deploy).toContain(
      "Deployment failed; no verified prior image, leaving all candidate runtimes down",
    );
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
    expect(proof).toContain('const reviewRole = "handleplan_review"');
    expect(proof).toContain('const operationsRole = "handleplan_operations"');
    expect(proof).toContain("web SELECT must read public price evidence");
    expect(proof).toContain("web role must not read private publication captures");
    expect(proof).toContain("web role must not read private geographic scope keys");
    expect(proof).toContain("web role must not write canonical products");
    expect(proof).toContain("operations role must not bypass its bounded aggregate function");
    expect(workflow).toMatch(
      /- name: Prove runtime database least privilege[\s\S]*prove-runtime-database-role\.mjs/,
    );
  });

  it("rejects any shared owner or runtime-role credential before connecting", () => {
    const sharedRuntime = runMigrationWith({
      WEB_DATABASE_PASSWORD: "proof_app_url_safe_000000000000000001",
    });
    const sharedOwner = runMigrationWith({
      WEB_DATABASE_PASSWORD: "proof_admin_url_safe_000000000001",
    });
    const sharedReviewWorker = runMigrationWith({
      REVIEW_DATABASE_PASSWORD: "proof_app_url_safe_000000000000000001",
    });
    const sharedReviewWeb = runMigrationWith({
      REVIEW_DATABASE_PASSWORD: "proof_web_url_safe_000000000000000001",
    });
    const sharedReviewOwner = runMigrationWith({
      REVIEW_DATABASE_PASSWORD: "proof_admin_url_safe_000000000001",
    });
    const sharedOperationsWorker = runMigrationWith({
      OPERATIONS_DATABASE_PASSWORD: "proof_app_url_safe_000000000000000001",
    });
    const sharedOperationsWeb = runMigrationWith({
      OPERATIONS_DATABASE_PASSWORD: "proof_web_url_safe_000000000000000001",
    });
    const sharedOperationsReview = runMigrationWith({
      OPERATIONS_DATABASE_PASSWORD: "proof_review_url_safe_0000000000000001",
    });
    const sharedOperationsOwner = runMigrationWith({
      OPERATIONS_DATABASE_PASSWORD: "proof_admin_url_safe_000000000001",
    });

    expect(sharedRuntime.status).not.toBe(0);
    expect(sharedRuntime.stderr).toContain("Worker and web database credentials must differ");
    expect(sharedOwner.status).not.toBe(0);
    expect(sharedOwner.stderr).toContain("Migration and web database credentials must differ");
    expect(sharedReviewWorker.status).not.toBe(0);
    expect(sharedReviewWorker.stderr).toContain(
      "Worker and review database credentials must differ",
    );
    expect(sharedReviewWeb.status).not.toBe(0);
    expect(sharedReviewWeb.stderr).toContain(
      "Web and review database credentials must differ",
    );
    expect(sharedReviewOwner.status).not.toBe(0);
    expect(sharedReviewOwner.stderr).toContain(
      "Migration and review database credentials must differ",
    );
    for (const sharedRuntimeRole of [
      sharedOperationsWorker,
      sharedOperationsWeb,
      sharedOperationsReview,
    ]) {
      expect(sharedRuntimeRole.status).not.toBe(0);
      expect(sharedRuntimeRole.stderr).toContain(
        "Operations database credentials must differ from every runtime role",
      );
    }
    expect(sharedOperationsOwner.status).not.toBe(0);
    expect(sharedOperationsOwner.stderr).toContain(
      "Migration and operations database credentials must differ",
    );
  });

  it("requires a bounded review credential before connecting", () => {
    const missing = runMigrationWith({ REVIEW_DATABASE_PASSWORD: "" });
    const malformed = runMigrationWith({ REVIEW_DATABASE_PASSWORD: "too-short" });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(
      "REVIEW_DATABASE_PASSWORD is required for migrations",
    );
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain(
      "REVIEW_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
    );
  });

  it("requires a bounded operations credential before connecting", () => {
    const missing = runMigrationWith({ OPERATIONS_DATABASE_PASSWORD: "" });
    const malformed = runMigrationWith({ OPERATIONS_DATABASE_PASSWORD: "too-short" });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(
      "OPERATIONS_DATABASE_PASSWORD is required for migrations",
    );
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain(
      "OPERATIONS_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
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
    expect(runbook).toMatch(
      /every remaining repository migration.*complete migration ledger/is,
    );
    expect(runbook).toMatch(/migration 014.*rolls back.*future completion/is);
    expect(runbook).toMatch(/migration 015.*NULL.*unknown.*\[\].*explicitly empty/is);
    expect(runbook).toMatch(/migration 016.*worker result.*silent-zero.*cancelled/is);
    expect(runbook).toMatch(/request-budget.*ephemeral.*SELECT.*INSERT.*DELETE/is);
    expect(runbook).toMatch(/terminalized_at.*backfilled.*fails closed/is);
    expect(runbook).toMatch(/content_json.*SHA-256.*pg_restore/is);
    expect(runbook).toMatch(/does not prove.*off-host.*retention/is);
  });
});
