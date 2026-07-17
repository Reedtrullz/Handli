import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const migrationRunner = resolve(root, "deploy/migrate.mjs");
const sourceDatabase = "handleplan_ci_v1_03_source";
const restoreDatabase = "handleplan_ci_v1_03_restore";
const completionClockDatabase = "handleplan_ci_v1_03_completion_clock";
const proofDatabases = [sourceDatabase, restoreDatabase, completionClockDatabase];
const postgresImage =
  "postgres:16.10-alpine@sha256:ab8380566c3ea09690a9ecaa85a59d82bfc6eb86744151a2a54335866c83a3e9";
const expectedMigrations = [
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
];

assert.equal(process.env.CI, "true", "database proof requires CI=true");
assert.ok(process.env.DATABASE_ADMIN_URL, "DATABASE_ADMIN_URL is required");
assert.match(
  process.env.APP_DATABASE_PASSWORD ?? "",
  /^[A-Za-z0-9_-]{32,128}$/,
  "APP_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.match(
  process.env.WEB_DATABASE_PASSWORD ?? "",
  /^[A-Za-z0-9_-]{32,128}$/,
  "WEB_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.match(
  process.env.REVIEW_DATABASE_PASSWORD ?? "",
  /^[A-Za-z0-9_-]{32,128}$/,
  "REVIEW_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.match(
  process.env.OPERATIONS_DATABASE_PASSWORD ?? "",
  /^[A-Za-z0-9_-]{32,128}$/,
  "OPERATIONS_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.notEqual(
  process.env.APP_DATABASE_PASSWORD,
  process.env.WEB_DATABASE_PASSWORD,
  "worker and web database credentials must differ",
);
assert.notEqual(
  process.env.APP_DATABASE_PASSWORD,
  process.env.REVIEW_DATABASE_PASSWORD,
  "worker and review database credentials must differ",
);
assert.notEqual(
  process.env.WEB_DATABASE_PASSWORD,
  process.env.REVIEW_DATABASE_PASSWORD,
  "web and review database credentials must differ",
);
for (const [otherName, otherPassword] of [
  ["worker", process.env.APP_DATABASE_PASSWORD],
  ["web", process.env.WEB_DATABASE_PASSWORD],
  ["review", process.env.REVIEW_DATABASE_PASSWORD],
]) {
  assert.notEqual(
    process.env.OPERATIONS_DATABASE_PASSWORD,
    otherPassword,
    `operations and ${otherName} database credentials must differ`,
  );
}
assert.ok(process.env.MIGRATIONS_DIR, "MIGRATIONS_DIR is required");
assert.ok(isAbsolute(process.env.MIGRATIONS_DIR), "MIGRATIONS_DIR must be absolute");

const adminUrl = new URL(process.env.DATABASE_ADMIN_URL);
assert.ok(
  ["postgres:", "postgresql:"].includes(adminUrl.protocol),
  "DATABASE_ADMIN_URL must use PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname),
  "database proof only accepts a loopback PostgreSQL server",
);
assert.ok(adminUrl.username, "DATABASE_ADMIN_URL must include a username");
assert.ok(adminUrl.password, "DATABASE_ADMIN_URL must include a CI placeholder password");
assert.ok(adminUrl.pathname.length > 1, "DATABASE_ADMIN_URL must name an admin database");
assert.ok(
  !proofDatabases.includes(adminUrl.pathname.slice(1)),
  "DATABASE_ADMIN_URL must not target a proof database",
);
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.APP_DATABASE_PASSWORD,
  "migration and worker database credentials must differ",
);
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.WEB_DATABASE_PASSWORD,
  "migration and web database credentials must differ",
);
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.REVIEW_DATABASE_PASSWORD,
  "migration and review database credentials must differ",
);
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.OPERATIONS_DATABASE_PASSWORD,
  "migration and operations database credentials must differ",
);

const postgresClientHost = process.env.POSTGRES_CLIENT_HOST;
const postgresClientNetwork = process.env.POSTGRES_CLIENT_NETWORK;
assert.ok(
  ["127.0.0.1", "localhost", "host.docker.internal"].includes(postgresClientHost),
  "POSTGRES_CLIENT_HOST must stay on the local machine",
);
assert.ok(
  ["host", "bridge"].includes(postgresClientNetwork),
  "POSTGRES_CLIENT_NETWORK must be host or bridge",
);
if (postgresClientNetwork === "host") {
  assert.ok(
    ["127.0.0.1", "localhost"].includes(postgresClientHost),
    "host-network clients must use a loopback database host",
  );
}

const postgresPort = adminUrl.port || "5432";
assert.match(postgresPort, /^\d{1,5}$/, "PostgreSQL port must be numeric");

function urlForDatabase(database) {
  assert.ok(proofDatabases.includes(database), "refusing an unapproved proof database name");
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: [options.stdinFd ?? "ignore", options.stdoutFd ?? "inherit", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args[0] ?? ""} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function runMigrations(database, maxMigrationId) {
  const env = {
    ...process.env,
    CI: "true",
    DATABASE_MIGRATION_URL: urlForDatabase(database),
    MIGRATIONS_DIR: process.env.MIGRATIONS_DIR,
  };
  delete env.CI_MAX_MIGRATION_ID;
  if (maxMigrationId !== undefined) {
    env.CI_MAX_MIGRATION_ID = maxMigrationId;
  }
  await run(process.execPath, [migrationRunner], { env });
}

async function seedLegacyReviewRolePrivileges(sql) {
  await sql.unsafe(`
    do $legacy_review_role$
    begin
      if not exists (
        select 1 from pg_catalog.pg_roles where rolname = 'handleplan_review'
      ) then
        create role handleplan_review
          nologin nosuperuser nocreatedb nocreaterole noinherit
          noreplication nobypassrls;
      end if;
    end
    $legacy_review_role$;

    revoke all privileges on all tables in schema public from public;
    revoke all privileges on all sequences in schema public from public;
    revoke all privileges on all functions in schema public from public;
    grant usage on schema public to handleplan_review;
    grant select on table
      approved_offers, canonical_products, extracted_offer_candidates,
      extraction_runs, handleplan_schema_migrations, offer_conditions,
      offer_targets, product_families, product_identifiers,
      publication_captures, publications, review_actions
      to handleplan_review;
    grant insert on table
      approved_offers, offer_conditions, offer_targets, review_actions
      to handleplan_review;
    grant usage on sequence
      approved_offers_id_seq, offer_conditions_id_seq, review_actions_id_seq
      to handleplan_review;
    grant select (
      id, display_name, source_kind, runtime_state, public_reference_url,
      permission_reviewed_at, permission_expires_at, created_at, updated_at,
      public_state_changed_at
    ) on table data_sources to handleplan_review;
    grant select (
      id, source_id, decision, reviewed_at, valid_until, permissions, created_at
    ) on table source_permissions to handleplan_review;
    grant select (
      id, scope_kind, label, country_code, status, created_at,
      public_state_changed_at
    ) on table geographic_scopes to handleplan_review;
    grant execute on function reject_append_only_mutation()
      to handleplan_review;
  `);
}

async function verifyPrivateReviewUpgradeCrashBoundary(sql) {
  const tableGrants = await sql`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'handleplan_review'
      and table_schema = 'public'
    order by table_name, privilege_type
  `;
  assert.deepEqual(
    [...tableGrants],
    [],
    "021 commit must erase historical review table privileges before role reconciliation",
  );

  const columnGrants = await sql`
    select table_name, column_name, privilege_type
    from information_schema.role_column_grants
    where grantee = 'handleplan_review'
      and table_schema = 'public'
    order by table_name, column_name, privilege_type
  `;
  assert.deepEqual(
    [...columnGrants],
    [],
    "021 commit must erase historical review column grants before role reconciliation",
  );

  const sequenceGrants = await sql`
    select relation.relname as sequence_name, privilege.privilege_type
    from pg_catalog.pg_class relation
    inner join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        relation.relacl,
        pg_catalog.acldefault('s', relation.relowner)
      )
    ) privilege
    inner join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
    where namespace.nspname = 'public'
      and relation.relkind = 'S'
      and grantee.rolname = 'handleplan_review'
    order by relation.relname, privilege.privilege_type
  `;
  assert.deepEqual(
    [...sequenceGrants],
    [],
    "021 commit must erase historical review sequence grants before role reconciliation",
  );

  const functionGrants = await sql`
    select routine.proname as function_name,
      pg_catalog.pg_get_function_identity_arguments(routine.oid) as identity_arguments,
      privilege.privilege_type
    from pg_catalog.pg_proc routine
    inner join pg_catalog.pg_namespace namespace
      on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) privilege
    inner join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
    where namespace.nspname = 'public'
      and grantee.rolname = 'handleplan_review'
    order by routine.proname, identity_arguments, privilege.privilege_type
  `;
  assert.deepEqual(
    functionGrants.map(({ function_name: name, identity_arguments: args, privilege_type: privilege }) =>
      `${name}(${args}):${privilege}`),
    [
      "private_review_candidate_rows_v1(p_candidate_id bigint, p_evaluation_as_of timestamp with time zone, p_chain text, p_scope_kind text, p_min_confidence integer, p_max_confidence integer, p_min_age_hours integer, p_max_age_hours integer, p_anomaly text, p_cursor_created_at timestamp with time zone, p_cursor_id bigint, p_result_limit integer):EXECUTE",
      "private_review_decide_v1(p_candidate_id bigint, p_expected_version integer, p_action text, p_actor_id text, p_reason text, p_target_kind text, p_target_gtin text, p_target_family_slug text, p_pricing_kind text, p_offer_price_ore integer, p_before_price_ore integer, p_multibuy_quantity integer, p_multibuy_total_ore integer, p_eligibility_kind text, p_membership_program_id text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_channels text[]):EXECUTE",
    ],
    "a crash after 021 commit may leave only the two exact procedure grants",
  );
}

function postgresClientArgs(command, database, extraArgs) {
  assert.ok(proofDatabases.includes(database), "refusing an unapproved client database name");
  return [
    "run",
    "--rm",
    ...(command === "pg_restore" ? ["--interactive"] : []),
    ...(postgresClientNetwork === "host" ? ["--network", "host"] : []),
    "-e",
    "PGPASSWORD",
    postgresImage,
    command,
    "--host",
    postgresClientHost,
    "--port",
    postgresPort,
    "--username",
    decodeURIComponent(adminUrl.username),
    "--dbname",
    database,
    ...extraArgs,
  ];
}

async function runPostgresClient(command, database, extraArgs, io) {
  await run("docker", postgresClientArgs(command, database, extraArgs), {
    ...io,
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(adminUrl.password),
    },
  });
}

async function applyFixture(sql, filename) {
  const fixture = readFileSync(resolve(here, "fixtures", filename), "utf8");
  await sql.begin((transaction) => transaction.unsafe(fixture));
}

async function readMigrationLedger(sql) {
  const rows = await sql`
    select id, checksum
    from handleplan_schema_migrations
    order by id
  `;
  assert.deepEqual(rows.map((row) => row.id), expectedMigrations);
  for (const row of rows) {
    assert.match(row.checksum, /^[0-9a-f]{64}$/);
  }
  return rows.map((row) => ({ id: row.id, checksum: row.checksum }));
}

async function verifyLegacyUpgrade(sql) {
  const [conditionClock] = await sql`
    select is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'offer_conditions'
      and column_name = 'created_at'
  `;
  assert.equal(conditionClock?.is_nullable, "NO");
  assert.match(
    conditionClock?.column_default ?? "",
    /(?:transaction_timestamp|now)\(\)/,
    "offer condition persistence clock must retain a database default",
  );
  const conditionTriggers = await sql`
    select trigger.tgname
    from pg_catalog.pg_trigger trigger
    inner join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'offer_conditions'
      and not trigger.tgisinternal
    order by trigger.tgname
  `;
  assert.deepEqual(
    conditionTriggers.map(({ tgname: name }) => name),
    ["offer_conditions_creation_clock", "offer_conditions_mutation_fence"],
  );
  const [reviewBoundaryVersion] = await sql`
    select is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'review_actions'
      and column_name = 'decision_boundary_version'
  `;
  assert.equal(reviewBoundaryVersion?.is_nullable, "YES");
  assert.match(
    reviewBoundaryVersion?.column_default ?? "",
    /\b1\b/,
    "post-022 review decisions must receive the trusted boundary marker",
  );
  const [payloadBoundary] = await sql`
    select public.assert_public_official_offer_payload_v1(8388608) as accepted
  `;
  assert.equal(payloadBoundary?.accepted, true);
  await assert.rejects(
    sql`select public.assert_public_official_offer_payload_v1(8388609)`,
    /exceeds the 8 MiB payload bound/i,
  );

  const rows = await sql`
    select
      price_cache.ean,
      price_cache.chain,
      price_cache.amount_ore,
      price_cache.observed_at,
      price_cache.fetched_at,
      price_observations.source_id,
      price_observations.claim_eligibility,
      data_sources.source_kind,
      data_sources.runtime_state,
      data_sources.created_at as source_created_at,
      data_sources.public_state_changed_at as source_public_state_changed_at,
      product_identifiers.created_at as identifier_created_at,
      product_identifiers.public_state_changed_at as identifier_public_state_changed_at,
      canonical_products.created_at as product_created_at,
      canonical_products.public_state_changed_at as product_public_state_changed_at,
      ingestion_runs.completed_at as run_completed_at,
      ingestion_runs.terminalized_at as run_terminalized_at,
      terminal_clock_migration.applied_at as terminal_clock_migration_at,
      price_coverage_checks.state as coverage_state,
      price_coverage_checks.reason as coverage_reason,
      (
        data_sources.runtime_state = 'approved'
        and price_observations.claim_eligibility = 'historical_eligible'
      ) as official_claim_eligible,
      (
        select count(*)::integer
        from approved_offers
        where approved_offers.source_id = 'legacy-import'
      ) as official_claim_count
    from price_cache
    join product_identifiers
      on product_identifiers.value = price_cache.ean
     and product_identifiers.scheme in ('ean8', 'ean13')
    join canonical_products
      on canonical_products.id = product_identifiers.product_id
    join price_observations
      on price_observations.product_id = product_identifiers.product_id
     and price_observations.chain = price_cache.chain
     and price_observations.amount_ore = price_cache.amount_ore
     and price_observations.observed_at = price_cache.observed_at
    join data_sources
      on data_sources.id = price_observations.source_id
    join ingestion_runs
      on ingestion_runs.id = price_observations.ingestion_run_id
    join handleplan_schema_migrations terminal_clock_migration
      on terminal_clock_migration.id = '012_reviewed_family_taxonomy.sql'
    join price_coverage_checks
      on price_coverage_checks.ingestion_run_id = price_observations.ingestion_run_id
     and price_coverage_checks.product_id = price_observations.product_id
     and price_coverage_checks.chain = price_observations.chain
    where price_cache.ean = '7044710000007'
      and price_cache.chain = 'extra'
  `;

  assert.equal(rows.length, 1, "the representative legacy row must survive exactly once");
  const [row] = rows;
  assert.equal(row.amount_ore, 4290);
  assert.equal(row.observed_at.toISOString(), "2026-06-01T10:00:00.000Z");
  assert.equal(row.fetched_at.toISOString(), "2026-06-01T10:05:00.000Z");
  assert.equal(row.source_id, "legacy-import");
  assert.equal(row.claim_eligibility, "ordinary_only");
  assert.equal(row.source_kind, "legacy");
  assert.equal(row.runtime_state, "blocked");
  assert.ok(row.source_public_state_changed_at >= row.source_created_at);
  assert.ok(row.identifier_public_state_changed_at >= row.identifier_created_at);
  assert.ok(row.product_public_state_changed_at >= row.product_created_at);
  assert.equal(
    row.run_terminalized_at.toISOString(),
    row.terminal_clock_migration_at.toISOString(),
    "pre-012 terminal runs must use the conservative migration clock",
  );
  assert.ok(row.run_terminalized_at >= row.run_completed_at);
  assert.equal(row.coverage_state, "ineligible");
  assert.equal(row.coverage_reason, "legacy_price_cache_missing_provenance");
  assert.equal(row.official_claim_eligible, false);
  assert.equal(row.official_claim_count, 0);
}

async function verifyRestoreEvidence(sql) {
  const permissions = await sql`
    select decision, reviewed_at, valid_until, public_reference_url, permissions, notes,
           created_at
    from source_permissions
    where source_id = 'kassalapp'
      and notes = 'V1-03 restore proof fixture'
  `;
  assert.equal(permissions.length, 1, "source permission audit must be present");
  assert.equal(permissions[0].decision, "conditional");
  assert.equal(permissions[0].reviewed_at.toISOString(), "2026-07-16T08:00:00.000Z");
  assert.equal(permissions[0].valid_until.toISOString(), "2026-08-16T08:00:00.000Z");
  assert.equal(permissions[0].public_reference_url, "https://kassal.app/api/docs");
  assert.deepEqual(permissions[0].permissions, {
    catalog: true,
    officialOffers: false,
    ordinaryPrice: true,
  });
  assert.ok(permissions[0].created_at >= permissions[0].reviewed_at);

  const publicStateRows = await sql`
    select
      source.created_at as source_created_at,
      source.public_state_changed_at as source_public_state_changed_at,
      product.created_at as product_created_at,
      product.public_state_changed_at as product_public_state_changed_at,
      scope.created_at as scope_created_at,
      scope.public_state_changed_at as scope_public_state_changed_at
    from data_sources source
    inner join canonical_products product
      on product.display_name = 'Mutable catalog projection (not public evidence)'
    inner join geographic_scopes scope
      on scope.scope_key = 'ci-proof:no-0301-oslo'
    where source.id = 'kassalapp'
  `;
  assert.equal(publicStateRows.length, 1, "public-state clock fixtures must be unique");
  const [publicState] = publicStateRows;
  assert.ok(publicState.source_public_state_changed_at >= publicState.source_created_at);
  assert.ok(publicState.product_public_state_changed_at >= publicState.product_created_at);
  assert.ok(publicState.scope_public_state_changed_at >= publicState.scope_created_at);
  const persistenceClockFingerprint = {
    ...Object.fromEntries(
    Object.entries(publicState).map(([key, value]) => [key, value.toISOString()]),
    ),
    source_permission_created_at: permissions[0].created_at.toISOString(),
  };

  const captures = await sql`
    select
      publications.external_id,
      publications.source_id,
      publication_captures.blob_key,
      publication_captures.checksum,
      publication_captures.mime_type,
      publication_captures.byte_length,
      publication_captures.rights_classification,
      publication_captures.retrieved_at,
      publication_captures.created_at,
      publication_captures.capture_permission_id,
      publication_captures.capture_permission_capabilities
    from publication_captures
    join publications on publications.id = publication_captures.publication_id
    where publications.external_id = 'ci-proof-publication-v1-03'
  `;
  assert.equal(captures.length, 1, "publication capture metadata must be present");
  assert.equal(captures[0].external_id, "ci-proof-publication-v1-03");
  assert.equal(captures[0].source_id, "ci-proof-offer-source-v1-03");
  assert.equal(captures[0].blob_key, "ci-proof/private/v1-03/publication.pdf");
  assert.equal(captures[0].checksum, "a".repeat(64));
  assert.equal(captures[0].mime_type, "application/pdf");
  assert.equal(captures[0].byte_length, 321);
  assert.equal(captures[0].rights_classification, "private_review");
  assert.ok(captures[0].retrieved_at >= captures[0].created_at);
  assert.ok(captures[0].capture_permission_id > 0);
  assert.deepEqual(
    captures[0].capture_permission_capabilities,
    ["capture", "discover", "extract"],
  );
  persistenceClockFingerprint.offer_capture_retrieved_at =
    captures[0].retrieved_at.toISOString();

  const reviews = await sql`
    select actor_id, action, expected_version, previous_values, new_values, reason, acted_at
    from review_actions
    where actor_id = 'ci-v1-03-proof'
  `;
  assert.equal(reviews.length, 1, "review audit action must be present");
  assert.equal(reviews[0].action, "reject");
  assert.equal(reviews[0].expected_version, 0);
  assert.deepEqual(reviews[0].previous_values, { status: "pending" });
  assert.deepEqual(reviews[0].new_values, { status: "rejected" });
  assert.equal(
    reviews[0].reason,
    "Deterministic audit fixture for backup and restore proof",
  );
  assert.equal(reviews[0].acted_at.toISOString(), "2026-07-16T08:09:00.000Z");

  await assert.rejects(
    sql`
      update extracted_offer_candidates
      set normalized_fields = '{"title":"rewritten"}'::jsonb
      where candidate_key = 'ci-proof-candidate-v1-03'
    `,
    /extracted_offer_candidates is append-only/i,
    "review corrections must not rewrite the original extracted candidate",
  );
  await assert.rejects(
    sql`
      delete from extracted_offer_candidates
      where candidate_key = 'ci-proof-candidate-v1-03'
    `,
    /extracted_offer_candidates is append-only/i,
    "review rejection must not delete the original extracted candidate",
  );
  const [unchangedCandidate] = await sql`
    select normalized_fields, status
    from extracted_offer_candidates
    where candidate_key = 'ci-proof-candidate-v1-03'
  `;
  assert.deepEqual(
    unchangedCandidate,
    { normalized_fields: { title: "CI proof only" }, status: "rejected" },
    "candidate evidence must survive review and restore unchanged",
  );

  const workerResults = await sql`
    select job_id, source_id, job_kind, scheduled_at, status, counts, result_hash
    from worker_job_results
    where job_id = 'ci-proof:kassalapp:catalog-refresh:2026-07-16T08:10:00.000Z'
  `;
  assert.equal(workerResults.length, 1, "worker schedule result must be present");
  assert.deepEqual(
    {
      ...workerResults[0],
      scheduled_at: workerResults[0].scheduled_at.toISOString(),
    },
    {
      job_id: "ci-proof:kassalapp:catalog-refresh:2026-07-16T08:10:00.000Z",
      source_id: "kassalapp",
      job_kind: "catalog-refresh",
      scheduled_at: "2026-07-16T08:10:00.000Z",
      status: "failed",
      counts: {
        accepted: 0,
        failed: 1,
        fetched: 0,
        persisted: 0,
        quarantined: 0,
        unknown: 0,
      },
      result_hash: "c".repeat(64),
    },
  );

  const catalogObservations = await sql`
    select
      observation.source_record_id,
      observation.gtin,
      observation.display_name,
      observation.brand,
      observation.package_amount,
      observation.package_unit,
      observation.units_per_pack,
      observation.retrieved_at,
      observation.source_updated_at,
      observation.raw_record_hash,
      observation.category_path,
      observation.created_at as observation_created_at,
      run.source_id,
      run.run_type,
      run.status,
      run.completed_at,
      run.created_at as run_created_at,
      run.terminalized_at
    from catalog_observations observation
    inner join ingestion_runs run on run.id = observation.ingestion_run_id
    where observation.source_record_id = 'ci-proof-catalog-record-v1-03'
  `;
  assert.equal(catalogObservations.length, 1, "catalog observation must be present");
  assert.deepEqual(
    {
      ...catalogObservations[0],
      retrieved_at: catalogObservations[0].retrieved_at.toISOString(),
      source_updated_at: catalogObservations[0].source_updated_at.toISOString(),
      completed_at: catalogObservations[0].completed_at.toISOString(),
      run_created_at: catalogObservations[0].run_created_at.toISOString(),
      terminalized_at: catalogObservations[0].terminalized_at.toISOString(),
      observation_created_at: catalogObservations[0].observation_created_at.toISOString(),
    },
    {
      source_record_id: "ci-proof-catalog-record-v1-03",
      gtin: "7038010000010",
      display_name: "CI proof catalog observation",
      brand: "CI observed brand",
      package_amount: 1000,
      package_unit: "g",
      units_per_pack: 1,
      retrieved_at: "2026-07-16T08:10:30.000Z",
      source_updated_at: "2026-07-16T08:00:30.000Z",
      raw_record_hash: "e".repeat(64),
      category_path: null,
      source_id: "kassalapp",
      run_type: "catalog",
      status: "completed",
      completed_at: "2026-07-16T08:11:00.000Z",
      run_created_at: catalogObservations[0].run_created_at.toISOString(),
      terminalized_at: catalogObservations[0].terminalized_at.toISOString(),
      observation_created_at: catalogObservations[0].observation_created_at.toISOString(),
    },
    "restore must preserve the completed-run catalog payload and both clocks",
  );
  assert.ok(
    catalogObservations[0].terminalized_at >= catalogObservations[0].run_created_at,
    "the database terminal clock must not precede run creation",
  );
  assert.ok(
    catalogObservations[0].terminalized_at >= catalogObservations[0].completed_at,
    "the database terminal clock must not precede the caller completion clock",
  );
  persistenceClockFingerprint.catalog_observation_created_at =
    catalogObservations[0].observation_created_at.toISOString();

  const sourceOutcomes = await sql`
    select outcome_state, recorded_at, created_at
    from source_record_outcomes
    where source_record_id = 'ci-proof-catalog-record-v1-03'
  `;
  assert.equal(sourceOutcomes.length, 1, "source outcome audit must be present");
  assert.equal(sourceOutcomes[0].outcome_state, "accepted");
  assert.equal(
    sourceOutcomes[0].recorded_at.toISOString(),
    "2026-07-16T08:10:30.000Z",
  );
  assert.notEqual(
    sourceOutcomes[0].created_at.toISOString(),
    "2000-01-01T00:00:00.000Z",
  );
  persistenceClockFingerprint.source_record_outcome_created_at =
    sourceOutcomes[0].created_at.toISOString();

  const familyEvidence = await sql`
    select
      version.version_id,
      version.published_at,
      version.content_sha256,
      version.content_json,
      version.expected_family_count,
      version.expected_alias_count,
      family.family_id,
      family.slug,
      family.label_no,
      alias.alias,
      private.reviewer_id,
      public.decision,
      public.method,
      public.confidence,
      public.reviewed_at,
      public.created_at as membership_created_at,
      public.reviewer_attested
    from family_taxonomy_versions version
    inner join reviewed_family_definitions family
      on family.version_id = version.version_id
     and family.family_id = 'family:melk'
    inner join reviewed_family_aliases alias
      on alias.version_id = family.version_id
     and alias.family_id = family.family_id
    inner join reviewed_family_membership_decisions private
      on private.version_id = family.version_id
     and private.family_id = family.family_id
     and private.reviewer_id = 'ci-private-family-reviewer'
    inner join reviewed_family_membership_public public
      on public.id = private.id
  `;
  assert.deepEqual(
    familyEvidence.map((row) => ({
      ...row,
      published_at: row.published_at.toISOString(),
      reviewed_at: row.reviewed_at.toISOString(),
      membership_created_at: row.membership_created_at.toISOString(),
    })),
    [{
      version_id: "handleplan-reviewed-families@1.0.0",
      published_at: "2026-07-16T00:00:00.000Z",
      content_sha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
      content_json: [
        { aliases: ["brød"], id: "family:brod", labelNo: "Brød", slug: "brod", status: "active" },
        { aliases: [], id: "family:kaffe", labelNo: "Kaffe", slug: "kaffe", status: "active" },
        { aliases: ["mjølk"], id: "family:melk", labelNo: "Melk", slug: "melk", status: "active" },
      ],
      expected_family_count: 3,
      expected_alias_count: 2,
      family_id: "family:melk",
      slug: "melk",
      label_no: "Melk",
      alias: "mjølk",
      reviewer_id: "ci-private-family-reviewer",
      decision: "approved",
      method: "human_review",
      confidence: 100,
      reviewed_at: "2026-07-16T08:10:00.000Z",
      membership_created_at: familyEvidence[0].membership_created_at.toISOString(),
      reviewer_attested: true,
    }],
    "restore must preserve reviewed-family checksum, alias, private provenance, and public attestation",
  );
  persistenceClockFingerprint.reviewed_membership_created_at =
    familyEvidence[0].membership_created_at.toISOString();
  return persistenceClockFingerprint;
}

async function verifyTerminalRunInsertGuards(sql) {
  const triggerRows = await sql`
    select tgname
    from pg_trigger
    where not tgisinternal
      and tgname = any(${sql.array([
        "catalog_observations_running_run_guard",
        "price_observations_running_run_guard",
        "price_coverage_checks_running_run_guard",
        "source_record_outcomes_running_run_guard",
      ])}::text[])
    order by tgname
  `;
  assert.deepEqual(triggerRows.map(({ tgname }) => tgname), [
    "catalog_observations_running_run_guard",
    "price_coverage_checks_running_run_guard",
    "price_observations_running_run_guard",
    "source_record_outcomes_running_run_guard",
  ]);

  const [fixture] = await sql`
    select run.id as run_id, observation.canonical_product_id
    from catalog_observations observation
    inner join ingestion_runs run on run.id = observation.ingestion_run_id
    where observation.source_record_id = 'ci-proof-catalog-record-v1-03'
      and run.status = 'completed'
  `;
  assert.ok(fixture, "completed catalog fixture must exist for the insert guard proof");
  const [clock] = await sql`select clock_timestamp() as snapshot_at`;
  await assert.rejects(
    sql`
      insert into catalog_observations (
        ingestion_run_id, source_record_id, canonical_product_id, gtin,
        display_name, package_amount, package_unit, units_per_pack,
        retrieved_at, raw_record_hash, created_at
      ) values (
        ${fixture.run_id}, 'ci-proof-late-terminal-catalog',
        ${fixture.canonical_product_id}, '7038010000027', 'Late terminal catalog',
        1, 'package', 1, '2026-07-16T08:10:30Z', ${"f".repeat(64)},
        '2000-01-01T00:00:00Z'
      )
    `,
    /running ingestion run/i,
    "a terminal run must reject a later backdated catalog observation",
  );
  const [late] = await sql`
    select count(*)::integer as count
    from catalog_observations
    where source_record_id = 'ci-proof-late-terminal-catalog'
      and created_at <= ${clock.snapshot_at}
  `;
  assert.equal(late.count, 0, "the captured snapshot must not gain a rejected late row");
}

async function verifyTaxonomyPublicationGuards(sql) {
  const publications = [
    {
      content: [{ aliases: [], id: "family:proof-empty", labelNo: "Empty", slug: "proof-empty", status: "active" }],
      definitions: [],
      version: "92.0.1",
    },
    {
      content: [
        { aliases: [], id: "family:proof-subset-a", labelNo: "Subset A", slug: "proof-subset-a", status: "active" },
        { aliases: [], id: "family:proof-subset-b", labelNo: "Subset B", slug: "proof-subset-b", status: "active" },
      ],
      definitions: [{ id: "family:proof-subset-a", label: "Subset A", slug: "proof-subset-a" }],
      version: "92.0.2",
    },
    {
      content: [{ aliases: [], id: "family:proof-mismatch", labelNo: "Expected", slug: "proof-mismatch", status: "active" }],
      definitions: [{ id: "family:proof-mismatch", label: "Different", slug: "proof-mismatch" }],
      version: "92.0.3",
    },
  ];

  for (const publication of publications) {
    await assert.rejects(
      sql.begin(async (transaction) => {
        const content = transaction.json(publication.content);
        await transaction`
          insert into family_taxonomy_versions (
            version_id, taxonomy_id, taxonomy_version, contract_version,
            published_at, content_sha256, content_json,
            expected_family_count, expected_alias_count
          ) values (
            ${`handleplan-reviewed-families@${publication.version}`},
            'handleplan-reviewed-families', ${publication.version}, 1,
            transaction_timestamp(),
            encode(sha256(convert_to(canonical_family_taxonomy_json(${content}), 'UTF8')), 'hex'),
            ${content}, ${publication.content.length}, 0
          )
        `;
        for (const definition of publication.definitions) {
          await transaction`
            insert into reviewed_family_definitions (
              version_id, family_id, slug, label_no, status
            ) values (
              ${`handleplan-reviewed-families@${publication.version}`},
              ${definition.id}, ${definition.slug}, ${definition.label}, 'active'
            )
          `;
        }
      }),
      /does not match its sealed content/,
    );
  }

  const lateMutationCases = [
    {
      content: [{ aliases: [], id: "family:proof-late-definition", labelNo: "Late definition", slug: "proof-late-definition", status: "active" }],
      mutate: async (transaction, versionId) => {
        await transaction`
          insert into reviewed_family_definitions (
            version_id, family_id, slug, label_no, status
          ) values (
            ${versionId}, 'family:proof-late-extra', 'proof-late-extra',
            'Late extra', 'active'
          )
        `;
      },
      version: "92.0.4",
    },
    {
      content: [{ aliases: [], id: "family:proof-late-alias", labelNo: "Late alias", slug: "proof-late-alias", status: "active" }],
      mutate: async (transaction, versionId) => {
        await transaction`
          insert into reviewed_family_aliases (version_id, family_id, alias)
          values (${versionId}, 'family:proof-late-alias', 'sen alias')
        `;
      },
      version: "92.0.5",
    },
  ];

  for (const publication of lateMutationCases) {
    await assert.rejects(
      sql.begin(async (transaction) => {
        const content = transaction.json(publication.content);
        const versionId = `handleplan-reviewed-families@${publication.version}`;
        await transaction`
          insert into family_taxonomy_versions (
            version_id, taxonomy_id, taxonomy_version, contract_version,
            published_at, content_sha256, content_json,
            expected_family_count, expected_alias_count
          ) values (
            ${versionId}, 'handleplan-reviewed-families', ${publication.version}, 1,
            transaction_timestamp(),
            encode(sha256(convert_to(canonical_family_taxonomy_json(${content}), 'UTF8')), 'hex'),
            ${content}, 1, 0
          )
        `;
        const [definition] = publication.content;
        await transaction`
          insert into reviewed_family_definitions (
            version_id, family_id, slug, label_no, status
          ) values (
            ${versionId}, ${definition.id}, ${definition.slug},
            ${definition.labelNo}, 'active'
          )
        `;
        await transaction.unsafe("set constraints all immediate");
        await publication.mutate(transaction, versionId);
      }),
      /does not match its sealed content/,
    );
  }
}

async function verifyRuntimeRolePolicy(sql) {
  const [policy] = await sql`
    select
      has_database_privilege(
        'handleplan_app',
        current_database(),
        'CREATE'
      ) as database_create,
      has_database_privilege(
        'handleplan_app',
        current_database(),
        'TEMPORARY'
      ) as database_temp,
      has_schema_privilege('handleplan_app', 'public', 'CREATE') as schema_create,
      has_table_privilege(
        'handleplan_app',
        'source_permissions',
        'SELECT'
      ) as permission_read,
      has_table_privilege(
        'handleplan_app',
        'source_permissions',
        'INSERT'
      ) as permission_insert,
      has_table_privilege(
        'handleplan_app',
        'source_permissions',
        'UPDATE'
      ) as protected_update,
      has_table_privilege(
        'handleplan_app',
        'source_permissions',
        'DELETE'
      ) as protected_delete,
      has_table_privilege(
        'handleplan_app',
        'data_sources',
        'UPDATE'
      ) as source_state_update,
      has_table_privilege(
        'handleplan_app',
        'price_observations',
        'SELECT, INSERT'
      ) as evidence_append_read,
      has_table_privilege(
        'handleplan_app',
        'catalog_observations',
        'SELECT, INSERT'
      ) as catalog_append_read,
      has_table_privilege(
        'handleplan_app',
        'catalog_observations',
        'UPDATE, DELETE'
      ) as catalog_rewrite,
      has_table_privilege(
        'handleplan_app',
        'reviewed_family_membership_public',
        'SELECT'
      ) as worker_family_public_read,
      has_table_privilege(
        'handleplan_app',
        'reviewed_family_membership_decisions',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as worker_family_private_access,
      has_table_privilege(
        'handleplan_app',
        'worker_leases',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as worker_lease_write,
      has_table_privilege(
        'handleplan_app',
        'source_health_snapshots',
        'SELECT, INSERT'
      ) as source_health_append,
      has_table_privilege(
        'handleplan_app',
        'worker_job_results',
        'SELECT, INSERT'
      ) as worker_results_append,
      has_table_privilege(
        'handleplan_app',
        'worker_job_results',
        'UPDATE, DELETE'
      ) as worker_results_rewrite,
      has_table_privilege(
        'handleplan_app',
        'provider_request_budget_events',
        'SELECT'
      ) as budget_select,
      has_table_privilege(
        'handleplan_app',
        'provider_request_budget_events',
        'INSERT'
      ) as budget_insert,
      has_table_privilege(
        'handleplan_app',
        'provider_request_budget_events',
        'DELETE'
      ) as budget_delete,
      has_table_privilege(
        'handleplan_app',
        'provider_request_budget_events',
        'UPDATE'
      ) as budget_update,
      has_table_privilege(
        'handleplan_app',
        'public_api_request_budget_events',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as public_api_budget_worker_table_access,
      has_function_privilege(
        'handleplan_app',
        'claim_public_api_request_budget(text)',
        'EXECUTE'
      ) as public_api_budget_worker_execute,
      has_function_privilege(
        'handleplan_app',
        'official_offer_lifecycle_reconcile_v1(text,text,text,timestamptz,text,integer,boolean)',
        'EXECUTE'
      ) as worker_offer_lifecycle_execute,
      has_function_privilege(
        'handleplan_app',
        'reject_append_only_mutation()',
        'EXECUTE'
      ) as guard_execute,
      pg_has_role('handleplan_app', 'handleplan', 'MEMBER') as owner_member,
      has_database_privilege(
        'handleplan_web',
        current_database(),
        'CREATE'
      ) as web_database_create,
      has_database_privilege(
        'handleplan_web',
        current_database(),
        'TEMPORARY'
      ) as web_database_temp,
      has_schema_privilege('handleplan_web', 'public', 'CREATE') as web_schema_create,
      has_table_privilege(
        'handleplan_web',
        'handleplan_schema_migrations',
        'SELECT'
      ) as web_migration_read,
      has_table_privilege(
        'handleplan_web',
        'price_observations',
        'SELECT'
      ) as web_evidence_read,
      has_table_privilege(
        'handleplan_web',
        'price_observations',
        'INSERT, UPDATE, DELETE'
      ) as web_evidence_write,
      has_table_privilege(
        'handleplan_web',
        'catalog_observations',
        'SELECT'
      ) as web_catalog_observation_read,
      has_table_privilege(
        'handleplan_web',
        'catalog_observations',
        'INSERT, UPDATE, DELETE'
      ) as web_catalog_observation_write,
      has_table_privilege(
        'handleplan_web',
        'family_taxonomy_versions',
        'SELECT'
      ) as web_family_version_read,
      has_table_privilege(
        'handleplan_web',
        'reviewed_family_definitions',
        'SELECT'
      ) as web_family_definition_read,
      has_table_privilege(
        'handleplan_web',
        'reviewed_family_aliases',
        'SELECT'
      ) as web_family_alias_read,
      has_table_privilege(
        'handleplan_web',
        'reviewed_family_membership_public',
        'SELECT'
      ) as web_family_public_read,
      has_table_privilege(
        'handleplan_web',
        'reviewed_family_membership_decisions',
        'SELECT'
      ) as web_family_private_read,
      has_column_privilege(
        'handleplan_web',
        'source_permissions',
        'permissions',
        'SELECT'
      ) as web_permission_public_read,
      has_column_privilege(
        'handleplan_web',
        'source_permissions',
        'private_reference_key',
        'SELECT'
      ) as web_permission_private_read,
      has_table_privilege(
        'handleplan_web',
        'publication_captures',
        'SELECT'
      ) as web_private_capture_read,
      has_table_privilege(
        'handleplan_web',
        'worker_leases',
        'SELECT'
      ) as web_worker_state_read,
      has_table_privilege(
        'handleplan_web',
        'provider_request_budget_events',
        'SELECT'
      ) as web_budget_read,
      has_table_privilege(
        'handleplan_web',
        'public_api_request_budget_events',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as web_public_api_budget_table_access,
      has_function_privilege(
        'handleplan_web',
        'claim_public_api_request_budget(text)',
        'EXECUTE'
      ) as web_public_api_budget_execute,
      has_function_privilege(
        'handleplan_web',
        'public_official_offer_rows_v1(bigint[],timestamptz)',
        'EXECUTE'
      ) as web_public_official_offer_execute,
      has_sequence_privilege(
        'handleplan_web',
        'canonical_products_id_seq',
        'USAGE'
      ) as web_sequence_usage,
      has_function_privilege(
        'handleplan_web',
        'reject_append_only_mutation()',
        'EXECUTE'
      ) as web_guard_execute,
      pg_has_role('handleplan_web', 'handleplan', 'MEMBER') as web_owner_member,
      pg_has_role('handleplan_web', 'handleplan_app', 'MEMBER') as web_worker_member,
      has_database_privilege(
        'handleplan_review',
        current_database(),
        'CREATE'
      ) as review_database_create,
      has_schema_privilege('handleplan_review', 'public', 'CREATE')
        as review_schema_create,
      has_table_privilege(
        'handleplan_review',
        'publication_captures',
        'SELECT'
      ) as review_capture_read,
      has_table_privilege(
        'handleplan_review',
        'extracted_offer_candidates',
        'SELECT'
      ) as review_candidate_read,
      has_table_privilege(
        'handleplan_review',
        'extracted_offer_candidates',
        'INSERT, UPDATE, DELETE'
      ) as review_candidate_write,
      has_table_privilege(
        'handleplan_review',
        'review_actions',
        'SELECT, INSERT'
      ) as review_action_append,
      has_table_privilege(
        'handleplan_review',
        'review_actions',
        'UPDATE, DELETE'
      ) as review_action_rewrite,
      has_table_privilege(
        'handleplan_review',
        'private_review_evidence_renders',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as review_evidence_render_table_access,
      has_table_privilege(
        'handleplan_review',
        'private_review_evidence_consumptions',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as review_evidence_consumption_table_access,
      has_table_privilege(
        'handleplan_review',
        'approved_offers',
        'SELECT, INSERT'
      ) as review_offer_append,
      has_table_privilege(
        'handleplan_review',
        'approved_offers',
        'UPDATE, DELETE'
      ) as review_offer_rewrite,
      has_table_privilege(
        'handleplan_review',
        'source_permissions',
        'SELECT'
      ) as review_permission_table_read,
      has_column_privilege(
        'handleplan_review',
        'source_permissions',
        'permissions',
        'SELECT'
      ) as review_permission_column_read,
      has_column_privilege(
        'handleplan_review',
        'source_permissions',
        'private_reference_key',
        'SELECT'
      ) as review_permission_private_read,
      has_table_privilege(
        'handleplan_review',
        'price_cache',
        'SELECT'
      ) as review_unrelated_cache_read,
      has_sequence_privilege(
        'handleplan_review',
        'review_actions_id_seq',
        'USAGE'
      ) as review_sequence_usage,
      has_function_privilege(
        'handleplan_review',
        'reject_append_only_mutation()',
        'EXECUTE'
      ) as review_guard_execute,
      has_table_privilege(
        'handleplan_review',
        'public_api_request_budget_events',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as review_public_api_budget_table_access,
      has_function_privilege(
        'handleplan_review',
        'claim_public_api_request_budget(text)',
        'EXECUTE'
      ) as review_public_api_budget_execute,
      has_function_privilege(
        'handleplan_review',
        'private_review_candidate_rows_v1(bigint,timestamptz,text,text,integer,integer,integer,integer,text,timestamptz,bigint,integer)',
        'EXECUTE'
      ) as review_candidate_reader_execute,
      has_function_privilege(
        'handleplan_review',
        'private_review_decide_v1(bigint,integer,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamptz,timestamptz,text[])',
        'EXECUTE'
      ) as review_decision_v1_execute,
      has_function_privilege(
        'handleplan_review',
        'private_review_record_evidence_render_v1(bigint,integer,text,text,text,text,text,text,text,timestamptz)',
        'EXECUTE'
      ) as review_evidence_render_execute,
      has_function_privilege(
        'handleplan_review',
        'private_review_decide_v2(bigint,integer,text,text,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamptz,timestamptz,text[])',
        'EXECUTE'
      ) as review_decision_v2_execute,
      pg_has_role('handleplan_review', 'handleplan', 'MEMBER') as review_owner_member,
      pg_has_role('handleplan_review', 'handleplan_app', 'MEMBER') as review_worker_member,
      pg_has_role('handleplan_review', 'handleplan_web', 'MEMBER') as review_web_member,
      has_database_privilege(
        'handleplan_operations',
        current_database(),
        'CREATE'
      ) as operations_database_create,
      has_database_privilege(
        'handleplan_operations',
        current_database(),
        'TEMPORARY'
      ) as operations_database_temp,
      has_schema_privilege('handleplan_operations', 'public', 'CREATE')
        as operations_schema_create,
      has_table_privilege(
        'handleplan_operations',
        'data_sources',
        'SELECT'
      ) as operations_public_table_read,
      has_table_privilege(
        'handleplan_operations',
        'publication_captures',
        'SELECT'
      ) as operations_private_table_read,
      has_table_privilege(
        'handleplan_operations',
        'alert_events',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as operations_alert_ledger_access,
      has_sequence_privilege(
        'handleplan_operations',
        'alert_events_id_seq',
        'USAGE'
      ) as operations_sequence_usage,
      has_function_privilege(
        'handleplan_operations',
        'operations_dashboard_rows_v1(text[],integer)',
        'EXECUTE'
      ) as operations_dashboard_execute,
      has_function_privilege(
        'handleplan_operations',
        'append_operations_alert_evaluation_v1(timestamptz,jsonb,jsonb)',
        'EXECUTE'
      ) as operations_alert_append_execute,
      has_function_privilege(
        'handleplan_operations',
        'operations_alert_export_rows_v1(bigint,integer)',
        'EXECUTE'
      ) as operations_alert_export_execute,
      has_function_privilege(
        'handleplan_operations',
        'reject_append_only_mutation()',
        'EXECUTE'
      ) as operations_generic_function_execute,
      pg_has_role('handleplan_operations', 'handleplan', 'MEMBER')
        as operations_owner_member,
      pg_has_role('handleplan_operations', 'handleplan_app', 'MEMBER')
        as operations_worker_member,
      pg_has_role('handleplan_operations', 'handleplan_web', 'MEMBER')
        as operations_web_member,
      pg_has_role('handleplan_operations', 'handleplan_review', 'MEMBER')
        as operations_review_member
  `;

  assert.deepEqual(policy, {
    database_create: false,
    database_temp: false,
    schema_create: false,
    permission_read: true,
    permission_insert: false,
    protected_update: false,
    protected_delete: false,
    source_state_update: false,
    evidence_append_read: true,
    catalog_append_read: true,
    catalog_rewrite: false,
    worker_family_public_read: false,
    worker_family_private_access: false,
    worker_lease_write: true,
    source_health_append: true,
    worker_results_append: true,
    worker_results_rewrite: false,
    budget_select: true,
    budget_insert: true,
    budget_delete: true,
    budget_update: false,
    public_api_budget_worker_table_access: false,
    public_api_budget_worker_execute: false,
    worker_offer_lifecycle_execute: true,
    guard_execute: false,
    owner_member: false,
    web_database_create: false,
    web_database_temp: false,
    web_schema_create: false,
    web_migration_read: true,
    web_evidence_read: true,
    web_evidence_write: false,
    web_catalog_observation_read: true,
    web_catalog_observation_write: false,
    web_family_version_read: true,
    web_family_definition_read: true,
    web_family_alias_read: true,
    web_family_public_read: true,
    web_family_private_read: false,
    web_permission_public_read: true,
    web_permission_private_read: false,
    web_private_capture_read: false,
    web_worker_state_read: false,
    web_budget_read: false,
    web_public_api_budget_table_access: false,
    web_public_api_budget_execute: true,
    web_public_official_offer_execute: true,
    web_sequence_usage: false,
    web_guard_execute: false,
    web_owner_member: false,
    web_worker_member: false,
    review_database_create: false,
    review_schema_create: false,
    review_capture_read: false,
    review_candidate_read: false,
    review_candidate_write: false,
    review_action_append: false,
    review_action_rewrite: false,
    review_evidence_render_table_access: false,
    review_evidence_consumption_table_access: false,
    review_offer_append: false,
    review_offer_rewrite: false,
    review_permission_table_read: false,
    review_permission_column_read: false,
    review_permission_private_read: false,
    review_unrelated_cache_read: false,
    review_sequence_usage: false,
    review_guard_execute: false,
    review_public_api_budget_table_access: false,
    review_public_api_budget_execute: false,
    review_candidate_reader_execute: true,
    review_decision_v1_execute: false,
    review_evidence_render_execute: true,
    review_decision_v2_execute: true,
    review_owner_member: false,
    review_worker_member: false,
    review_web_member: false,
    operations_database_create: false,
    operations_database_temp: false,
    operations_schema_create: false,
    operations_public_table_read: false,
    operations_private_table_read: false,
    operations_alert_ledger_access: false,
    operations_sequence_usage: false,
    operations_dashboard_execute: true,
    operations_alert_append_execute: true,
    operations_alert_export_execute: true,
    operations_generic_function_execute: false,
    operations_owner_member: false,
    operations_worker_member: false,
    operations_web_member: false,
    operations_review_member: false,
  });

  const [operationsProjection] = await sql`
    select procedure.prosrc as body
    from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'public.operations_dashboard_rows_v1(text[],integer)'
    )
  `;
  assert.equal(
    operationsProjection.body.match(
      /current_action\.decision_boundary_version\s*=\s*2/g,
    )?.length,
    3,
    "final operations projection must require marker 2 at all three offer aggregates",
  );
  assert.doesNotMatch(
    operationsProjection.body,
    /current_action\.decision_boundary_version\s*=\s*1/,
    "final operations projection must retain no legacy marker 1 predicate",
  );
  const [publicOfferProjection] = await sql`
    select procedure.prosrc as body
    from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'public.public_official_offer_rows_v1(bigint[],timestamptz)'
    )
  `;
  assert.match(
    publicOfferProjection.body,
    /review\.decision_boundary_version\s*=\s*2/,
    "final public offer projection must require marker 2",
  );
  assert.doesNotMatch(
    publicOfferProjection.body,
    /review\.decision_boundary_version\s*=\s*1/,
    "final public offer projection must retain no legacy marker 1 predicate",
  );

  const [budgetFunction] = await sql`
    select
      pg_get_functiondef(routine.oid) as definition,
      pg_get_userbyid(routine.proowner) as owner,
      routine.proconfig as configuration,
      routine.prosecdef as security_definer
    from pg_proc routine
    where routine.oid = 'claim_public_api_request_budget(text)'::regprocedure
  `;
  assert.equal(budgetFunction.owner, "handleplan");
  assert.equal(budgetFunction.security_definer, true);
  assert.ok(
    budgetFunction.configuration.includes("search_path=pg_catalog, pg_temp"),
    "budget SECURITY DEFINER function must pin its search path",
  );
  assert.match(budgetFunction.definition, /pg_try_advisory_xact_lock/iu);
  assert.match(budgetFunction.definition, /delete from public\.public_api_request_budget_events/iu);
  assert.match(budgetFunction.definition, /insert into public\.public_api_request_budget_events/iu);
  assert.doesNotMatch(
    budgetFunction.definition,
    /ip_address|user_agent|basket|coordinate|request_hash|address|token/iu,
    "budget function must not accept or persist shopper/request identity",
  );
  const budgetColumns = await sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_api_request_budget_events'
    order by ordinal_position
  `;
  assert.deepEqual(
    budgetColumns.map(({ column_name: column }) => column),
    ["route_key", "claimed_at"],
    "ephemeral application budget has no request-identity storage column",
  );
}

async function verifyReviewOfferInsertBoundary(sql) {
  const [installedBoundary] = await sql`
    select
      constraint_state.constraint_definition,
      trigger_state.trigger_definition,
      function_state.function_definition
    from (
      select pg_get_constraintdef(oid) as constraint_definition
      from pg_constraint
      where conrelid = 'approved_offers'::regclass
        and conname = 'approved_offers_published_candidate_binding'
    ) constraint_state
    cross join (
      select pg_get_triggerdef(oid) as trigger_definition
      from pg_trigger
      where tgrelid = 'approved_offers'::regclass
        and tgname = 'approved_offers_insert_boundary'
        and not tgisinternal
    ) trigger_state
    cross join (
      select pg_get_functiondef(oid) as function_definition
      from pg_proc
      where oid = 'enforce_approved_offer_insert_boundary()'::regprocedure
    ) function_state
  `;
  assert.match(
    installedBoundary.constraint_definition,
    /status.*published.*candidate_id is not null/i,
    "published offers must retain a candidate binding",
  );
  assert.match(
    installedBoundary.trigger_definition,
    /before insert on public\.approved_offers/i,
    "approved-offer insertion must pass the database boundary trigger",
  );
  assert.match(
    installedBoundary.function_definition,
    /new\.status is distinct from 'approved'/i,
    "direct INSERT must not create a public offer state",
  );
  assert.match(
    installedBoundary.function_definition,
    /session_user = 'handleplan_review'.*new\.candidate_id is null/is,
    "review-role offers must bind immutable extracted candidate evidence",
  );

  const scopeKey = "ci-proof:review-offer-boundary";
  const [scope] = await sql`
    insert into geographic_scopes (scope_key, scope_kind, label, status)
    values (${scopeKey}, 'national', 'Review offer boundary proof', 'active')
    returning id
  `;
  const directPublishedKey = "ci-proof:direct-published-offer";
  await assert.rejects(
    sql`
      insert into approved_offers (
        offer_key, source_id, source_reference, chain, geographic_scope_id,
        amount_ore, valid_from, valid_until, status, approved_at
      ) values (
        ${directPublishedKey}, 'kassalapp', 'ci-proof:forbidden', 'extra',
        ${scope.id}, 1, now(), now() + interval '1 day', 'published', now()
      )
    `,
    /approved_offers must begin approved/i,
    "even the owner must use the guarded UPDATE publisher instead of direct INSERT",
  );

  const candidateLessKey = "ci-proof:candidate-less-approved-offer";
  const [candidateLessOffer] = await sql`
    insert into approved_offers (
      offer_key, source_id, source_reference, chain, geographic_scope_id,
      amount_ore, valid_from, valid_until, approved_at
    ) values (
      ${candidateLessKey}, 'kassalapp', 'ci-proof:owner-projection', 'extra',
      ${scope.id}, 1, now(), now() + interval '1 day', now()
    )
    returning id, status
  `;
  assert.equal(candidateLessOffer.status, "approved");
  await assert.rejects(
    sql`
      update approved_offers
      set status = 'published'
      where id = ${candidateLessOffer.id}
    `,
    /approved_offers_published_candidate_binding/i,
    "an unbound projection must never become public through UPDATE",
  );
  const [unchangedOffer] = await sql`
    select status from approved_offers where id = ${candidateLessOffer.id}
  `;
  assert.equal(unchangedOffer.status, "approved");
  await sql`delete from approved_offers where id = ${candidateLessOffer.id}`;
  await sql`delete from geographic_scopes where id = ${scope.id}`;
}

async function verifyDeletedMigrationHistoryIsRejected(sql, database) {
  const deletedMigrationId = "009_deleted_history.sql";
  await sql`
    insert into handleplan_schema_migrations (id, checksum)
    values (${deletedMigrationId}, ${"f".repeat(64)})
  `;
  try {
    await assert.rejects(
      runMigrations(database),
      /Applied migration is absent from the repository: 009_deleted_history\.sql/,
    );
  } finally {
    await sql`
      delete from handleplan_schema_migrations where id = ${deletedMigrationId}
    `;
  }
}

async function verifyCatalogCategoryPathMigration(sql, preMigrationFixture) {
  const [installedShape] = await sql`
    select
      constraint_state.convalidated,
      trigger_state.trigger_definition,
      index_state.indexdef
    from (
      select convalidated
      from pg_constraint
      where conrelid = 'catalog_observations'::regclass
        and conname = 'catalog_observations_category_path_shape'
    ) constraint_state
    cross join (
      select pg_get_triggerdef(oid) as trigger_definition
      from pg_trigger
      where tgrelid = 'catalog_observations'::regclass
        and tgname = 'catalog_observations_category_path_guard'
        and not tgisinternal
    ) trigger_state
    cross join (
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'catalog_observations'
        and indexname = 'catalog_observations_category_path_gin_idx'
    ) index_state
  `;
  assert.equal(installedShape.convalidated, true, "015 must validate its container constraint");
  assert.match(
    installedShape.trigger_definition,
    /BEFORE INSERT OR UPDATE OF category_path/i,
    "015 must validate category paths before any category write",
  );
  assert.match(
    installedShape.indexdef,
    /USING gin \(category_path jsonb_path_ops\) WHERE \(category_path IS NOT NULL\)/i,
    "015 must install the partial jsonb_path_ops GIN index",
  );

  const [preMigrationObservation] = await sql`
    select category_path
    from catalog_observations
    where id = ${preMigrationFixture.observationId}
  `;
  assert.deepEqual(
    preMigrationObservation,
    { category_path: null },
    "015 must preserve a pre-existing observation as unknown category evidence",
  );

  const [categoryRun] = await sql`
    insert into ingestion_runs (
      job_id, source_id, run_type, status, started_at, completed_at, counts
    ) values (
      'ci-proof:category-path:validations', 'kassalapp', 'catalog', 'running',
      statement_timestamp(), null, '{}'::jsonb
    )
    returning id
  `;
  const validCategoryPath = [
    { sourceCategoryId: "10", depth: 0, name: "Mat og drikke" },
    { sourceCategoryId: "20", depth: 1, name: "Meieriprodukter" },
  ];
  const insertCategoryObservation = (sourceRecordId, categoryPath) => sql`
    insert into catalog_observations (
      ingestion_run_id, source_record_id, canonical_product_id, gtin,
      display_name, package_amount, package_unit, units_per_pack,
      retrieved_at, raw_record_hash, category_path
    ) values (
      ${categoryRun.id}, ${sourceRecordId}, ${preMigrationFixture.productId},
      '7038010000096', 'Category path proof', 1, 'package', 1,
      statement_timestamp(), ${"9".repeat(64)}, ${sql.json(categoryPath)}
    )
  `;

  await insertCategoryObservation("ci-proof-category-empty", []);
  await insertCategoryObservation("ci-proof-category-valid", validCategoryPath);

  const invalidCategoryPaths = [
    { id: "non-array", path: { sourceCategoryId: "10", depth: 0, name: "Mat" } },
    { id: "too-long", path: Array.from({ length: 101 }, (_, depth) => ({
      sourceCategoryId: String(depth),
      depth: Math.min(depth, 100),
      name: `Category ${depth}`,
    })) },
    { id: "missing-key", path: [{ sourceCategoryId: "10", depth: 0 }] },
    { id: "extra-key", path: [{
      sourceCategoryId: "10", depth: 0, name: "Mat", slug: "mat",
    }] },
    { id: "duplicate-id", path: [
      { sourceCategoryId: "10", depth: 0, name: "Mat" },
      { sourceCategoryId: "10", depth: 1, name: "Meieri" },
    ] },
    { id: "blank-id", path: [{ sourceCategoryId: " ", depth: 0, name: "Mat" }] },
    { id: "leading-zero-id", path: [{ sourceCategoryId: "01", depth: 0, name: "Mat" }] },
    { id: "unsafe-id", path: [{
      sourceCategoryId: "9007199254740992", depth: 0, name: "Mat",
    }] },
    { id: "fractional-depth", path: [{
      sourceCategoryId: "10", depth: 0.5, name: "Mat",
    }] },
    { id: "negative-depth", path: [{ sourceCategoryId: "10", depth: -1, name: "Mat" }] },
    { id: "large-depth", path: [{ sourceCategoryId: "10", depth: 101, name: "Mat" }] },
    { id: "blank-name", path: [{ sourceCategoryId: "10", depth: 0, name: " " }] },
    { id: "long-name", path: [{
      sourceCategoryId: "10", depth: 0, name: "n".repeat(501),
    }] },
    { id: "descending-depth", path: [
      { sourceCategoryId: "10", depth: 1, name: "Meieri" },
      { sourceCategoryId: "20", depth: 0, name: "Mat" },
    ] },
    { id: "descending-id", path: [
      { sourceCategoryId: "20", depth: 0, name: "Mat" },
      { sourceCategoryId: "10", depth: 0, name: "Drikke" },
    ] },
  ];

  for (const invalid of invalidCategoryPaths) {
    await assert.rejects(
      insertCategoryObservation(`ci-proof-category-${invalid.id}`, invalid.path),
      /category path/i,
      `015 must reject ${invalid.id} category evidence`,
    );
  }

  const storedPaths = await sql`
    select source_record_id, category_path
    from catalog_observations
    where ingestion_run_id = ${categoryRun.id}
    order by source_record_id
  `;
  assert.deepEqual([...storedPaths], [
    { source_record_id: "ci-proof-category-empty", category_path: [] },
    { source_record_id: "ci-proof-category-valid", category_path: validCategoryPath },
  ]);

  await assert.rejects(
    sql`
      update catalog_observations
      set category_path = '[]'::jsonb
      where ingestion_run_id = ${categoryRun.id}
        and source_record_id = 'ci-proof-category-valid'
    `,
    /append-only/i,
    "015 category evidence must inherit the catalog append-only guard",
  );

  await sql`
    update ingestion_runs
    set status = 'completed', completed_at = statement_timestamp()
    where id = ${categoryRun.id}
  `;
  await assert.rejects(
    insertCategoryObservation("ci-proof-category-terminal", validCategoryPath),
    /running ingestion run/i,
    "015 category evidence must inherit the running-run insert guard",
  );
}

async function verifyCompletionClockMigrationUpgrade(sql, database) {
  const [validRun] = await sql`
    insert into ingestion_runs (
      job_id, source_id, run_type, status, started_at, completed_at, counts
    ) values (
      'ci-proof:completion-clock:valid', 'kassalapp', 'catalog', 'running',
      statement_timestamp() - interval '2 minutes', null, '{}'::jsonb
    )
    returning id
  `;
  const [categoryProduct] = await sql`
    insert into canonical_products (
      display_name, package_amount, package_unit, units_per_pack, status
    ) values (
      'Pre-015 category path proof', 1, 'package', 1, 'active'
    )
    returning id
  `;
  const [preMigrationObservation] = await sql`
    insert into catalog_observations (
      ingestion_run_id, source_record_id, canonical_product_id, gtin,
      display_name, package_amount, package_unit, units_per_pack,
      retrieved_at, raw_record_hash
    ) values (
      ${validRun.id}, 'ci-proof-category-pre-015', ${categoryProduct.id},
      '7038010000089', 'Pre-015 category path proof', 1, 'package', 1,
      statement_timestamp(), ${"8".repeat(64)}
    )
    returning id
  `;
  const [validClockBefore] = await sql`
    update ingestion_runs
    set status = 'completed',
        completed_at = statement_timestamp() - interval '1 minute'
    where id = ${validRun.id}
    returning status, completed_at, terminalized_at
  `;
  assert.ok(
    validClockBefore.terminalized_at >= validClockBefore.completed_at,
    "the valid 013-era terminal run must have ordered completion clocks",
  );

  const [invalidRun] = await sql`
    insert into ingestion_runs (
      job_id, source_id, run_type, status, started_at, completed_at, counts
    ) values (
      'ci-proof:completion-clock:invalid', 'kassalapp', 'catalog', 'running',
      statement_timestamp(), null, '{}'::jsonb
    )
    returning id
  `;
  const [invalidClockBefore] = await sql`
    update ingestion_runs
    set status = 'completed',
        completed_at = clock_timestamp() + interval '10 minutes'
    where id = ${invalidRun.id}
    returning status, completed_at, terminalized_at
  `;
  assert.ok(
    invalidClockBefore.completed_at > invalidClockBefore.terminalized_at,
    "the invalid 013-era fixture must carry a caller-controlled future completion",
  );

  await assert.rejects(
    runMigrations(database),
    /existing ingestion run completion clock is inconsistent/i,
    "014 must reject inconsistent completion clocks already persisted by 013",
  );

  const [failedUpgradeState] = await sql`
    select
      exists (
        select 1
        from handleplan_schema_migrations
        where id = '014_ingestion_completion_clock.sql'
      ) as ledger_recorded,
      exists (
        select 1
        from pg_constraint
        where conrelid = 'ingestion_runs'::regclass
          and conname = 'ingestion_runs_completion_not_after_terminalization'
      ) as constraint_installed,
      pg_get_functiondef(
        'enforce_ingestion_run_lifecycle()'::regprocedure
      ) as lifecycle_definition
  `;
  assert.equal(
    failedUpgradeState.ledger_recorded,
    false,
    "a rejected 014 migration must not enter the migration ledger",
  );
  assert.equal(
    failedUpgradeState.constraint_installed,
    false,
    "a rejected 014 migration must not leave its constraint installed",
  );
  assert.doesNotMatch(
    failedUpgradeState.lifecycle_definition,
    /completion cannot be in the future/i,
    "a rejected 014 migration must leave the 013 lifecycle function in place",
  );

  const [invalidClockAfterFailure] = await sql`
    select status, completed_at, terminalized_at
    from ingestion_runs
    where id = ${invalidRun.id}
  `;
  assert.deepEqual(
    {
      ...invalidClockAfterFailure,
      completed_at: invalidClockAfterFailure.completed_at.toISOString(),
      terminalized_at: invalidClockAfterFailure.terminalized_at.toISOString(),
    },
    {
      ...invalidClockBefore,
      completed_at: invalidClockBefore.completed_at.toISOString(),
      terminalized_at: invalidClockBefore.terminalized_at.toISOString(),
    },
    "a rejected 014 migration must not rewrite the inconsistent row",
  );

  await sql.begin(async (transaction) => {
    await transaction.unsafe(
      "alter table ingestion_runs disable trigger ingestion_runs_lifecycle_guard",
    );
    await transaction`delete from ingestion_runs where id = ${invalidRun.id}`;
    await transaction.unsafe(
      "alter table ingestion_runs enable trigger ingestion_runs_lifecycle_guard",
    );
  });

  await runMigrations(database);

  const [validClockAfter] = await sql`
    select status, completed_at, terminalized_at
    from ingestion_runs
    where id = ${validRun.id}
  `;
  assert.deepEqual(
    {
      ...validClockAfter,
      completed_at: validClockAfter.completed_at.toISOString(),
      terminalized_at: validClockAfter.terminalized_at.toISOString(),
    },
    {
      ...validClockBefore,
      completed_at: validClockBefore.completed_at.toISOString(),
      terminalized_at: validClockBefore.terminalized_at.toISOString(),
    },
    "014 must preserve the valid 013-era terminal row and both of its clocks",
  );

  const [installedUpgradeState] = await sql`
    select
      convalidated,
      pg_get_functiondef(
        'enforce_ingestion_run_lifecycle()'::regprocedure
      ) as lifecycle_definition
    from pg_constraint
    where conrelid = 'ingestion_runs'::regclass
      and conname = 'ingestion_runs_completion_not_after_terminalization'
  `;
  assert.equal(
    installedUpgradeState.convalidated,
    true,
    "014 must install a validated completion-order constraint",
  );
  assert.match(
    installedUpgradeState.lifecycle_definition,
    /completion cannot be in the future/i,
    "014 must install the future-completion lifecycle guard",
  );
  await verifyCatalogCategoryPathMigration(sql, {
    observationId: preMigrationObservation.id,
    productId: categoryProduct.id,
  });
  await readMigrationLedger(sql);
}

async function databaseExists(sql, database) {
  const rows = await sql`
    select 1
    from pg_database
    where datname = ${database}
  `;
  return rows.length > 0;
}

async function createDatabase(sql, database) {
  assert.ok(proofDatabases.includes(database), "refusing to create an unapproved database");
  await sql.unsafe(`create database "${database}"`);
}

async function dropDatabase(sql, database) {
  assert.ok(proofDatabases.includes(database), "refusing to drop an unapproved database");
  await sql`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${database}
      and pid <> pg_backend_pid()
  `;
  await sql.unsafe(`drop database if exists "${database}"`);
}

const scratchDirectory = mkdtempSync(resolve(tmpdir(), "handleplan-v1-03-"));
const dumpPath = resolve(scratchDirectory, "database.dump");
const createdDatabases = new Set();
let admin;
let source;
let restored;
let completionClock;
let proofError;
let proofResult;

try {
  admin = postgres(adminUrl.toString(), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });

  for (const database of proofDatabases) {
    assert.equal(
      await databaseExists(admin, database),
      false,
      `${database} already exists; refusing to replace it`,
    );
  }

  await createDatabase(admin, completionClockDatabase);
  createdDatabases.add(completionClockDatabase);
  await runMigrations(completionClockDatabase, "013_physical_store_directory.sql");
  completionClock = postgres(urlForDatabase(completionClockDatabase), {
    max: 1,
    onnotice: () => {},
  });
  await verifyCompletionClockMigrationUpgrade(
    completionClock,
    completionClockDatabase,
  );
  await completionClock.end({ timeout: 5 });
  completionClock = undefined;

  await createDatabase(admin, sourceDatabase);
  createdDatabases.add(sourceDatabase);
  await runMigrations(sourceDatabase, "001_price_cache.sql");

  source = postgres(urlForDatabase(sourceDatabase), { max: 1, onnotice: () => {} });
  await applyFixture(source, "v1-03-legacy-price-cache.sql");
  await source.end({ timeout: 5 });
  source = undefined;

  await runMigrations(sourceDatabase, "020_official_offer_trust_fences.sql");
  source = postgres(urlForDatabase(sourceDatabase), { max: 1, onnotice: () => {} });
  await seedLegacyReviewRolePrivileges(source);
  await source.end({ timeout: 5 });
  source = undefined;

  // CI_MAX skips post-migration role reconciliation. This deliberately models
  // a process crash after 021 commits but before configureRuntimeRoles() runs.
  await runMigrations(sourceDatabase, "021_private_review_decision_boundary.sql");
  source = postgres(urlForDatabase(sourceDatabase), { max: 1, onnotice: () => {} });
  await verifyPrivateReviewUpgradeCrashBoundary(source);
  await source.end({ timeout: 5 });
  source = undefined;

  await runMigrations(sourceDatabase);
  await runMigrations(sourceDatabase);

  source = postgres(urlForDatabase(sourceDatabase), { max: 1, onnotice: () => {} });
  await verifyLegacyUpgrade(source);
  await verifyRuntimeRolePolicy(source);
  await verifyReviewOfferInsertBoundary(source);
  await verifyTaxonomyPublicationGuards(source);
  const sourceLedger = await readMigrationLedger(source);
  await verifyDeletedMigrationHistoryIsRejected(source, sourceDatabase);
  await applyFixture(source, "v1-03-restore-evidence.sql");
  const sourcePublicStateFingerprint = await verifyRestoreEvidence(source);
  await verifyTerminalRunInsertGuards(source);
  await source.end({ timeout: 5 });
  source = undefined;

  const dumpFd = openSync(dumpPath, "wx", 0o600);
  try {
    await runPostgresClient(
      "pg_dump",
      sourceDatabase,
      ["--format=custom", "--no-owner", "--no-privileges"],
      { stdoutFd: dumpFd },
    );
  } finally {
    closeSync(dumpFd);
  }

  await createDatabase(admin, restoreDatabase);
  createdDatabases.add(restoreDatabase);
  const restoreFd = openSync(dumpPath, "r");
  try {
    await runPostgresClient(
      "pg_restore",
      restoreDatabase,
      ["--exit-on-error", "--no-owner", "--no-privileges"],
      { stdinFd: restoreFd },
    );
  } finally {
    closeSync(restoreFd);
  }

  await runMigrations(restoreDatabase);
  restored = postgres(urlForDatabase(restoreDatabase), { max: 1, onnotice: () => {} });
  await verifyLegacyUpgrade(restored);
  const restoredPublicStateFingerprint = await verifyRestoreEvidence(restored);
  await verifyTerminalRunInsertGuards(restored);
  assert.deepEqual(
    restoredPublicStateFingerprint,
    sourcePublicStateFingerprint,
    "restore must preserve database-owned public-state clocks exactly",
  );
  await verifyRuntimeRolePolicy(restored);
  await verifyReviewOfferInsertBoundary(restored);
  await verifyTaxonomyPublicationGuards(restored);
  assert.deepEqual(await readMigrationLedger(restored), sourceLedger);

  proofResult = {
    sourceDatabase,
    restoreDatabase,
    migrations: sourceLedger.length,
    legacyRows: 1,
    restoredPermissionAudits: 1,
    restoredPublicationCaptures: 1,
    restoredReviewActions: 1,
    restoredCatalogObservations: 1,
    restoredReviewedFamilyDecisions: 1,
    restoredRuntimeRolePolicy: true,
    completionClockUpgradeRollback: true,
    categoryPathUpgradeValidation: true,
    immutableReviewCandidates: true,
    guardedReviewOfferPublication: true,
  };
} catch (error) {
  proofError = error;
} finally {
  const cleanupErrors = [];
  async function attemptCleanup(label, operation) {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(new Error(`Cleanup failed: ${label}`, { cause: error }));
    }
  }

  if (restored) {
    await attemptCleanup("close restored database connection", () =>
      restored.end({ timeout: 5 }));
  }
  if (source) {
    await attemptCleanup("close source database connection", () =>
      source.end({ timeout: 5 }));
  }
  if (completionClock) {
    await attemptCleanup("close completion-clock database connection", () =>
      completionClock.end({ timeout: 5 }));
  }
  if (admin) {
    for (const database of [...createdDatabases].reverse()) {
      await attemptCleanup(`drop ${database}`, () => dropDatabase(admin, database));
    }
    await attemptCleanup("close admin database connection", () =>
      admin.end({ timeout: 5 }));
  }
  await attemptCleanup("remove dump scratch directory", () => {
    rmSync(scratchDirectory, { force: true, recursive: true });
  });

  if (cleanupErrors.length > 0) {
    proofError = new AggregateError(
      proofError ? [proofError, ...cleanupErrors] : cleanupErrors,
      proofError
        ? "V1-03 database proof and cleanup failed"
        : "V1-03 database proof cleanup failed",
    );
  }
}

if (proofError) throw proofError;
console.log("V1-03 database upgrade and restore proof passed", proofResult);
