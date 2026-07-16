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
const proofDatabases = [sourceDatabase, restoreDatabase];
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
assert.notEqual(
  process.env.APP_DATABASE_PASSWORD,
  process.env.WEB_DATABASE_PASSWORD,
  "worker and web database credentials must differ",
);
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
    join price_observations
      on price_observations.product_id = product_identifiers.product_id
     and price_observations.chain = price_cache.chain
     and price_observations.amount_ore = price_cache.amount_ore
     and price_observations.observed_at = price_cache.observed_at
    join data_sources
      on data_sources.id = price_observations.source_id
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
  assert.equal(row.coverage_state, "ineligible");
  assert.equal(row.coverage_reason, "legacy_price_cache_missing_provenance");
  assert.equal(row.official_claim_eligible, false);
  assert.equal(row.official_claim_count, 0);
}

async function verifyRestoreEvidence(sql) {
  const permissions = await sql`
    select decision, reviewed_at, valid_until, public_reference_url, permissions, notes
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

  const captures = await sql`
    select
      publications.external_id,
      publications.source_id,
      publication_captures.blob_key,
      publication_captures.checksum,
      publication_captures.mime_type,
      publication_captures.byte_length,
      publication_captures.rights_classification,
      publication_captures.retrieved_at
    from publication_captures
    join publications on publications.id = publication_captures.publication_id
    where publications.external_id = 'ci-proof-publication-v1-03'
  `;
  assert.equal(captures.length, 1, "publication capture metadata must be present");
  assert.deepEqual(
    {
      ...captures[0],
      retrieved_at: captures[0].retrieved_at.toISOString(),
    },
    {
      external_id: "ci-proof-publication-v1-03",
      source_id: "kassalapp",
      blob_key: "ci-proof/private/v1-03/publication.pdf",
      checksum: "a".repeat(64),
      mime_type: "application/pdf",
      byte_length: 321,
      rights_classification: "private_review",
      retrieved_at: "2026-07-16T08:06:00.000Z",
    },
  );

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
      run.source_id,
      run.run_type,
      run.status,
      run.completed_at
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
      source_id: "kassalapp",
      run_type: "catalog",
      status: "completed",
      completed_at: "2026-07-16T08:11:00.000Z",
    },
    "restore must preserve the completed-run catalog payload and both clocks",
  );
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
      pg_has_role('handleplan_web', 'handleplan_app', 'MEMBER') as web_worker_member
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
    worker_lease_write: true,
    source_health_append: false,
    worker_results_append: true,
    worker_results_rewrite: false,
    budget_select: true,
    budget_insert: true,
    budget_delete: true,
    budget_update: false,
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
    web_permission_public_read: true,
    web_permission_private_read: false,
    web_private_capture_read: false,
    web_worker_state_read: false,
    web_budget_read: false,
    web_sequence_usage: false,
    web_guard_execute: false,
    web_owner_member: false,
    web_worker_member: false,
  });
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

  await createDatabase(admin, sourceDatabase);
  createdDatabases.add(sourceDatabase);
  await runMigrations(sourceDatabase, "001_price_cache.sql");

  source = postgres(urlForDatabase(sourceDatabase), { max: 1, onnotice: () => {} });
  await applyFixture(source, "v1-03-legacy-price-cache.sql");
  await source.end({ timeout: 5 });
  source = undefined;

  await runMigrations(sourceDatabase);
  await runMigrations(sourceDatabase);

  source = postgres(urlForDatabase(sourceDatabase), { max: 1, onnotice: () => {} });
  await verifyLegacyUpgrade(source);
  await verifyRuntimeRolePolicy(source);
  const sourceLedger = await readMigrationLedger(source);
  await verifyDeletedMigrationHistoryIsRejected(source, sourceDatabase);
  await applyFixture(source, "v1-03-restore-evidence.sql");
  await verifyRestoreEvidence(source);
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
  await verifyRestoreEvidence(restored);
  await verifyRuntimeRolePolicy(restored);
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
    restoredRuntimeRolePolicy: true,
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
