import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const migrationRunner = resolve(root, "deploy/migrate.mjs");
const workerRole = "handleplan_app";
const runtimeRole = workerRole;
const webRole = "handleplan_web";
const webTableSelects = [
  "catalog_observations",
  "canonical_products",
  "family_taxonomy_versions",
  "geographic_scope_regions",
  "geographic_scope_stores",
  "geographic_scopes",
  "handleplan_schema_migrations",
  "ingestion_runs",
  "latest_price_evidence",
  "physical_stores",
  "price_cache",
  "price_coverage_checks",
  "price_observations",
  "product_identifiers",
  "reviewed_family_aliases",
  "reviewed_family_definitions",
  "reviewed_family_membership_public",
];
const workerReadOnlyTables = [
  "data_sources",
  "geographic_scopes",
  "handleplan_schema_migrations",
  "source_permissions",
];
const workerAppendTables = [
  "catalog_observations",
  "price_coverage_checks",
  "price_observations",
  "source_record_outcomes",
  "worker_job_results",
];
const workerInsertUpdateTables = [
  "canonical_products",
  "ingestion_runs",
  "physical_stores",
  "price_cache",
  "product_identifiers",
  "source_products",
];
const workerSequenceUsage = [
  "canonical_products_id_seq",
  "catalog_observations_id_seq",
  "ingestion_runs_id_seq",
  "physical_stores_id_seq",
  "price_coverage_checks_id_seq",
  "price_observations_id_seq",
  "product_identifiers_id_seq",
  "source_record_outcomes_id_seq",
  "worker_job_results_id_seq",
];
const webColumnSelects = {
  data_sources: [
    "created_at",
    "display_name",
    "id",
    "permission_expires_at",
    "permission_reviewed_at",
    "public_reference_url",
    "public_state_changed_at",
    "runtime_state",
    "source_kind",
    "updated_at",
  ],
  source_health_snapshots: [
    "geographic_scope_id",
    "id",
    "last_capture_success_at",
    "last_discovery_success_at",
    "last_publish_success_at",
    "newest_eligible_evidence_at",
    "recorded_at",
    "source_id",
    "status",
  ],
  source_permissions: [
    "created_at",
    "decision",
    "id",
    "permissions",
    "reviewed_at",
    "source_id",
    "valid_until",
  ],
  source_products: [
    "canonical_product_id",
    "external_id",
    "first_seen_at",
    "last_seen_at",
    "match_state",
    "raw_record_hash",
    "source_id",
  ],
};

assert.equal(process.env.CI, "true", "runtime-role proof requires CI=true");
assert.ok(process.env.DATABASE_ADMIN_URL, "DATABASE_ADMIN_URL is required");
assert.ok(process.env.APP_DATABASE_PASSWORD, "APP_DATABASE_PASSWORD is required");
assert.match(
  process.env.APP_DATABASE_PASSWORD,
  /^[A-Za-z0-9_-]{32,128}$/,
  "APP_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.ok(process.env.WEB_DATABASE_PASSWORD, "WEB_DATABASE_PASSWORD is required");
assert.match(
  process.env.WEB_DATABASE_PASSWORD,
  /^[A-Za-z0-9_-]{32,128}$/,
  "WEB_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.notEqual(
  process.env.APP_DATABASE_PASSWORD,
  process.env.WEB_DATABASE_PASSWORD,
  "worker and web credentials must differ",
);
assert.ok(process.env.MIGRATIONS_DIR, "MIGRATIONS_DIR is required");
assert.ok(isAbsolute(process.env.MIGRATIONS_DIR), "MIGRATIONS_DIR must be absolute");

const proofDatabase = process.env.RUNTIME_ROLE_PROOF_DATABASE;
assert.match(
  proofDatabase ?? "",
  /^handleplan_runtime_role_proof_[a-z0-9_]{1,32}$/,
  "RUNTIME_ROLE_PROOF_DATABASE must use the isolated proof prefix",
);

const adminUrl = new URL(process.env.DATABASE_ADMIN_URL);
assert.ok(
  ["postgres:", "postgresql:"].includes(adminUrl.protocol),
  "DATABASE_ADMIN_URL must use PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname),
  "runtime-role proof only accepts a loopback PostgreSQL server",
);
assert.equal(
  decodeURIComponent(adminUrl.username),
  "handleplan",
  "runtime-role proof requires the handleplan migration owner",
);
assert.ok(adminUrl.password, "DATABASE_ADMIN_URL must include a CI placeholder password");
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.APP_DATABASE_PASSWORD,
  "runtime and migration credentials must differ",
);
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.WEB_DATABASE_PASSWORD,
  "web and migration credentials must differ",
);

function urlForDatabase(database) {
  assert.equal(database, proofDatabase, "refusing an unapproved proof database name");
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function runtimeUrlForDatabase(database) {
  const url = new URL(urlForDatabase(database));
  url.username = runtimeRole;
  url.password = process.env.APP_DATABASE_PASSWORD;
  return url.toString();
}

function webUrlForDatabase(database) {
  const url = new URL(urlForDatabase(database));
  url.username = webRole;
  url.password = process.env.WEB_DATABASE_PASSWORD;
  return url.toString();
}

function run(command, args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "inherit", "pipe"],
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

async function databaseExists(sql) {
  const rows = await sql`
    select 1 from pg_database where datname = ${proofDatabase}
  `;
  return rows.length > 0;
}

async function dropProofDatabase(sql) {
  await sql`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${proofDatabase}
      and pid <> pg_backend_pid()
  `;
  await sql.unsafe(`drop database if exists "${proofDatabase}"`);
}

async function expectDenied(operation, label) {
  await assert.rejects(
    operation,
    /permission denied|must be owner|must be superuser|not permitted|append-only|lifecycle|running ingestion run/i,
    label,
  );
}

function expectedTableGrants(role) {
  const grants = new Set();
  const add = (table, privileges) => {
    for (const privilege of privileges) grants.add(`${table}:${privilege}`);
  };
  if (role === webRole) {
    for (const table of webTableSelects) add(table, ["SELECT"]);
  } else {
    for (const table of workerReadOnlyTables) add(table, ["SELECT"]);
    for (const table of workerAppendTables) add(table, ["SELECT", "INSERT"]);
    for (const table of workerInsertUpdateTables) {
      add(table, ["SELECT", "INSERT", "UPDATE"]);
    }
    add("worker_leases", ["SELECT", "INSERT", "UPDATE", "DELETE"]);
    add("provider_request_budget_events", ["SELECT", "INSERT", "DELETE"]);
  }
  return [...grants].sort();
}

async function assertExactTableGrants(client, role) {
  const rows = await client`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = ${role}
      and table_schema = 'public'
    order by table_name, privilege_type
  `;
  assert.deepEqual(
    rows.map(({ table_name: table, privilege_type: privilege }) => `${table}:${privilege}`).sort(),
    expectedTableGrants(role),
    `${role} table grants must match the explicit allowlist exactly`,
  );
}

async function assertExactWebColumnGrants(client) {
  const tableNames = Object.keys(webColumnSelects);
  const rows = await client`
    select table_name, column_name, privilege_type
    from information_schema.role_column_grants
    where grantee = ${webRole}
      and table_schema = 'public'
      and table_name = any(${client.array(tableNames)}::text[])
    order by table_name, column_name, privilege_type
  `;
  const expected = Object.entries(webColumnSelects)
    .flatMap(([table, columns]) => columns.map((column) => `${table}:${column}:SELECT`))
    .sort();
  assert.deepEqual(
    rows.map(({ table_name: table, column_name: column, privilege_type: privilege }) =>
      `${table}:${column}:${privilege}`).sort(),
    expected,
    "handleplan_web column grants must exclude private source and status fields",
  );
}

async function assertExactSequenceAndFunctionGrants(client, role) {
  const sequences = await client`
    select relation.relname as sequence_name
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'S'
      and has_sequence_privilege(current_user, relation.oid, 'USAGE')
    order by relation.relname
  `;
  assert.deepEqual(
    sequences.map(({ sequence_name: sequence }) => sequence),
    role === workerRole ? workerSequenceUsage : [],
    `${role} sequence usage must match the explicit allowlist exactly`,
  );

  const functions = await client`
    select p.oid
    from pg_proc p
    join pg_namespace namespace on namespace.oid = p.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(current_user, p.oid, 'EXECUTE')
  `;
  assert.equal(
    functions.length,
    0,
    `${role} must not execute any function in the public schema`,
  );
}

let admin;
let runtime;
let web;
let createdDatabase = false;
let proofError;
let proofResult;

try {
  admin = postgres(adminUrl.toString(), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  assert.equal(
    await databaseExists(admin),
    false,
    `${proofDatabase} already exists; refusing to replace it`,
  );
  await admin.unsafe(`create database "${proofDatabase}"`);
  createdDatabase = true;

  const migrationEnvironment = {
    ...process.env,
    DATABASE_MIGRATION_URL: urlForDatabase(proofDatabase),
    APP_DATABASE_PASSWORD: process.env.APP_DATABASE_PASSWORD,
    MIGRATIONS_DIR: process.env.MIGRATIONS_DIR,
    WEB_DATABASE_PASSWORD: process.env.WEB_DATABASE_PASSWORD,
  };
  await run(process.execPath, [migrationRunner], migrationEnvironment);

  const ownershipAdmin = postgres(urlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  try {
    await ownershipAdmin.unsafe(
      "create table worker_owned_migration_probe (id integer primary key)",
    );
    await ownershipAdmin.unsafe(
      "create table web_owned_migration_probe (id integer primary key)",
    );
    await ownershipAdmin.unsafe(
      `alter table worker_owned_migration_probe owner to ${workerRole}`,
    );
    await ownershipAdmin.unsafe(
      `alter table web_owned_migration_probe owner to ${webRole}`,
    );
    await assert.rejects(
      () => run(process.execPath, [migrationRunner], migrationEnvironment),
      /Runtime roles must not own database objects/,
      "migration hardening must fail closed instead of silently reassigning runtime ownership",
    );
  } finally {
    await ownershipAdmin.unsafe("drop table if exists worker_owned_migration_probe");
    await ownershipAdmin.unsafe("drop table if exists web_owned_migration_probe");
    await ownershipAdmin.end({ timeout: 5 });
  }
  await run(process.execPath, [migrationRunner], migrationEnvironment);

  runtime = postgres(runtimeUrlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  web = postgres(webUrlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });

  await assertExactTableGrants(runtime, workerRole);
  await assertExactTableGrants(web, webRole);
  await assertExactWebColumnGrants(web);
  await assertExactSequenceAndFunctionGrants(runtime, workerRole);
  await assertExactSequenceAndFunctionGrants(web, webRole);

  const [capabilities] = await runtime`
    select
      current_user as role_name,
      has_database_privilege(current_user, current_database(), 'CREATE') as database_create,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') as database_temp,
      has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
      has_table_privilege(
        current_user,
        'handleplan_schema_migrations',
        'SELECT'
      ) as migration_select,
      has_table_privilege(current_user, 'source_permissions', 'SELECT') as protected_select,
      has_table_privilege(current_user, 'source_permissions', 'INSERT') as permission_insert,
      has_table_privilege(current_user, 'source_permissions', 'UPDATE') as protected_update,
      has_table_privilege(current_user, 'source_permissions', 'DELETE') as protected_delete,
      has_table_privilege(current_user, 'data_sources', 'UPDATE') as source_state_update,
      has_table_privilege(current_user, 'price_observations', 'SELECT')
        as evidence_select,
      has_table_privilege(current_user, 'price_observations', 'INSERT')
        as evidence_insert,
      has_table_privilege(current_user, 'price_observations', 'UPDATE')
        as evidence_update,
      has_table_privilege(current_user, 'price_observations', 'DELETE')
        as evidence_delete,
      has_table_privilege(current_user, 'catalog_observations', 'SELECT')
        as catalog_observation_select,
      has_table_privilege(current_user, 'catalog_observations', 'INSERT')
        as catalog_observation_insert,
      has_table_privilege(current_user, 'catalog_observations', 'UPDATE')
        as catalog_observation_update,
      has_table_privilege(current_user, 'catalog_observations', 'DELETE')
        as catalog_observation_delete,
      has_table_privilege(current_user, 'family_taxonomy_versions', 'SELECT')
        as taxonomy_version_select,
      has_table_privilege(current_user, 'reviewed_family_definitions', 'SELECT')
        as family_definition_select,
      has_table_privilege(current_user, 'reviewed_family_aliases', 'SELECT')
        as family_alias_select,
      has_table_privilege(current_user, 'reviewed_family_membership_public', 'SELECT')
        as family_membership_public_select,
      has_table_privilege(
        current_user,
        'reviewed_family_membership_decisions',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as family_membership_private_access,
      has_table_privilege(
        current_user,
        'worker_leases',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as worker_lease_write,
      has_table_privilege(
        current_user,
        'source_health_snapshots',
        'SELECT, INSERT'
      ) as source_health_append,
      has_table_privilege(
        current_user,
        'publication_captures',
        'SELECT, INSERT'
      ) as private_pipeline_access,
      has_table_privilege(
        current_user,
        'worker_job_results',
        'SELECT, INSERT'
      ) as worker_results_append,
      has_table_privilege(
        current_user,
        'worker_job_results',
        'UPDATE, DELETE'
      ) as worker_results_rewrite,
      has_table_privilege(
        current_user,
        'provider_request_budget_events',
        'SELECT'
      ) as budget_select,
      has_table_privilege(
        current_user,
        'provider_request_budget_events',
        'INSERT'
      ) as budget_insert,
      has_table_privilege(
        current_user,
        'provider_request_budget_events',
        'DELETE'
      ) as budget_delete,
      has_table_privilege(
        current_user,
        'provider_request_budget_events',
        'UPDATE'
      ) as budget_update,
      has_function_privilege(
        current_user,
        'reject_append_only_mutation()',
        'EXECUTE'
      ) as guard_execute,
      pg_has_role(current_user, 'handleplan', 'MEMBER') as migration_role_member,
      (
        select count(*)::integer
        from pg_class
        where relowner = (select oid from pg_roles where rolname = current_user)
      ) as owned_relations,
      (
        select rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls
        from pg_roles
        where rolname = current_user
      ) as elevated_role
  `;

  assert.deepEqual(capabilities, {
    role_name: runtimeRole,
    database_create: false,
    database_temp: false,
    schema_create: false,
    migration_select: true,
    protected_select: true,
    permission_insert: false,
    protected_update: false,
    protected_delete: false,
    source_state_update: false,
    evidence_select: true,
    evidence_insert: true,
    evidence_update: false,
    evidence_delete: false,
    catalog_observation_select: true,
    catalog_observation_insert: true,
    catalog_observation_update: false,
    catalog_observation_delete: false,
    taxonomy_version_select: false,
    family_definition_select: false,
    family_alias_select: false,
    family_membership_public_select: false,
    family_membership_private_access: false,
    worker_lease_write: true,
    source_health_append: false,
    private_pipeline_access: false,
    worker_results_append: true,
    worker_results_rewrite: false,
    budget_select: true,
    budget_insert: true,
    budget_delete: true,
    budget_update: false,
    guard_execute: false,
    migration_role_member: false,
    owned_relations: 0,
    elevated_role: false,
  });
  const rollbackReadiness = await runtime`
    select id from handleplan_schema_migrations where id = '011_catalog_observations.sql'
  `;
  assert.equal(
    rollbackReadiness.length,
    1,
    "legacy rollback role must retain migration-ledger readiness reads",
  );

  const ean = "7044710999998";
  await runtime`
    insert into price_cache (ean, chain, amount_ore, observed_at, fetched_at)
    values (${ean}, 'extra', 3190, now() - interval '1 minute', now())
    on conflict (ean, chain) do update
    set amount_ore = excluded.amount_ore,
        observed_at = excluded.observed_at,
        fetched_at = excluded.fetched_at
  `;
  const cacheRows = await runtime`
    select amount_ore from price_cache where ean = ${ean} and chain = 'extra'
  `;
  assert.equal(cacheRows[0]?.amount_ore, 3190, "runtime role must retain normal cache writes");

  await runtime`
    insert into worker_leases (
      lease_key,
      owner_id,
      acquired_at,
      expires_at,
      heartbeat_at
    ) values (
      'runtime-role-proof',
      'runtime-role-proof-worker',
      now(),
      now() + interval '5 minutes',
      now()
    )
  `;
  await runtime`
    update worker_leases
    set heartbeat_at = now()
    where lease_key = 'runtime-role-proof'
  `;
  const leaseRows = await runtime`
    select owner_id from worker_leases where lease_key = 'runtime-role-proof'
  `;
  assert.equal(leaseRows[0]?.owner_id, "runtime-role-proof-worker");
  await runtime`delete from worker_leases where lease_key = 'runtime-role-proof'`;

  const workerJobId = "runtime-role-proof:catalog-refresh:2026-07-16T12:00:00.000Z";
  await runtime`
    insert into worker_job_results (
      job_id,
      source_id,
      job_kind,
      scheduled_at,
      run_id,
      status,
      started_at,
      completed_at,
      counts,
      result_hash
    ) values (
      ${workerJobId},
      'kassalapp',
      'catalog-refresh',
      '2026-07-16T12:00:00Z',
      'runtime-role-proof-run',
      'failed',
      '2026-07-16T12:00:01Z',
      '2026-07-16T12:00:02Z',
      '{"accepted":0,"failed":1,"fetched":0,"persisted":0,"quarantined":0,"unknown":0}'::jsonb,
      ${"d".repeat(64)}
    )
  `;
  const workerResultRows = await runtime`
    select status from worker_job_results where job_id = ${workerJobId}
  `;
  assert.equal(workerResultRows[0]?.status, "failed");
  await expectDenied(
    () => runtime`
      update worker_job_results
      set status = 'succeeded'
      where job_id = ${workerJobId}
    `,
    "runtime role must not rewrite worker schedule results",
  );
  await expectDenied(
    () => runtime`delete from worker_job_results where job_id = ${workerJobId}`,
    "runtime role must not delete worker schedule results",
  );

  const [budgetEvent] = await runtime`
    insert into provider_request_budget_events (provider_key)
    values ('runtime-role-proof')
    returning provider_key, claimed_at
  `;
  assert.equal(budgetEvent?.provider_key, "runtime-role-proof");
  assert.ok(budgetEvent?.claimed_at instanceof Date);
  const budgetRows = await runtime`
    select provider_key
    from provider_request_budget_events
    where provider_key = 'runtime-role-proof'
  `;
  assert.equal(budgetRows.length, 1);
  assert.equal(budgetRows[0]?.provider_key, "runtime-role-proof");
  await expectDenied(
    () => runtime`
      update provider_request_budget_events
      set claimed_at = clock_timestamp()
      where provider_key = 'runtime-role-proof'
    `,
    "runtime role must not rewrite request-budget attempts",
  );
  await runtime`
    delete from provider_request_budget_events
    where provider_key = 'runtime-role-proof'
  `;

  const [ingestionRun] = await runtime`
    insert into ingestion_runs (
      source_id,
      run_type,
      status,
      started_at,
      completed_at,
      counts
    ) values (
      'kassalapp',
      'catalog',
      'running',
      now() - interval '1 minute',
      null,
      '{}'::jsonb
    )
    returning id
  `;
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set status = 'completed',
          completed_at = now(),
          terminalized_at = '2000-01-01T00:00:00Z'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not forge the database terminalization clock",
  );
  const [product] = await runtime`
    insert into canonical_products (
      display_name,
      package_amount,
      package_unit,
      units_per_pack,
      status
    ) values ('Runtime role proof product', 1, 'package', 1, 'active')
    returning id, public_state_changed_at
  `;
  await runtime`
    update canonical_products
    set status = 'quarantined',
        public_state_changed_at = '2000-01-01T00:00:00Z'
    where id = ${product.id}
  `;
  const [changedProduct] = await runtime`
    select status, public_state_changed_at
    from canonical_products
    where id = ${product.id}
  `;
  assert.equal(changedProduct?.status, "quarantined");
  assert.notEqual(
    changedProduct?.public_state_changed_at.toISOString(),
    "2000-01-01T00:00:00.000Z",
    "worker input must not forge the database-owned public-state clock",
  );
  assert.ok(
    changedProduct.public_state_changed_at >= product.public_state_changed_at,
    "public-state mutation clock must advance monotonically across worker updates",
  );
  await runtime`
    update canonical_products set status = 'active' where id = ${product.id}
  `;
  const [priceIngestionRun] = await runtime`
    insert into ingestion_runs (
      source_id,
      run_type,
      status,
      started_at,
      completed_at,
      counts
    ) values (
      'kassalapp',
      'benchmark-prices',
      'running',
      now() - interval '1 minute',
      null,
      '{}'::jsonb
    )
    returning id
  `;
  const [observation] = await runtime`
    insert into price_observations (
      evidence_key,
      product_id,
      chain,
      amount_ore,
      observed_at,
      fetched_at,
      source_id,
      source_reference,
      ingestion_run_id,
      evidence_level,
      confidence,
      claim_eligibility,
      raw_record_hash,
      created_at
    ) values (
      'runtime-role-proof-evidence',
      ${product.id},
      'extra',
      3190,
      now() - interval '1 minute',
      now(),
      'kassalapp',
      'runtime-role-proof',
      ${priceIngestionRun.id},
      'chain',
      100,
      'ordinary_only',
      ${"b".repeat(64)},
      '2000-01-01T00:00:00Z'
    )
    returning id, created_at
  `;
  assert.notEqual(observation.created_at.toISOString(), "2000-01-01T00:00:00.000Z");
  const [coverage] = await runtime`
    insert into price_coverage_checks (
      ingestion_run_id,
      product_id,
      chain,
      state,
      reason,
      checked_at,
      created_at
    ) values (
      ${priceIngestionRun.id},
      ${product.id},
      'extra',
      'priced',
      'runtime_role_proof',
      now(),
      '2000-01-01T00:00:00Z'
    )
    returning id, created_at
  `;
  assert.notEqual(coverage.created_at.toISOString(), "2000-01-01T00:00:00.000Z");
  const [outcome] = await runtime`
    insert into source_record_outcomes (
      ingestion_run_id,
      record_kind,
      source_record_id,
      outcome_state,
      reason,
      outcome_hash,
      recorded_at,
      created_at
    ) values (
      ${priceIngestionRun.id},
      'price',
      'runtime-role-proof-outcome',
      'accepted',
      null,
      ${"c".repeat(64)},
      now(),
      '2000-01-01T00:00:00Z'
    )
    returning id, created_at
  `;
  assert.notEqual(outcome.created_at.toISOString(), "2000-01-01T00:00:00.000Z");
  const protectedRows = await runtime`
    select amount_ore from price_observations where id = ${observation.id}
  `;
  assert.equal(protectedRows[0]?.amount_ore, 3190);
  const [catalogObservation] = await runtime`
    insert into catalog_observations (
      ingestion_run_id,
      source_record_id,
      canonical_product_id,
      gtin,
      display_name,
      brand,
      package_amount,
      package_unit,
      units_per_pack,
      retrieved_at,
      source_updated_at,
      raw_record_hash,
      created_at
    ) values (
      ${ingestionRun.id},
      'runtime-role-proof-catalog',
      ${product.id},
      '7038010000010',
      'Runtime observed catalog payload',
      'Runtime observed brand',
      1000,
      'g',
      1,
      now() - interval '30 seconds',
      now() - interval '2 minutes',
      ${"a".repeat(64)},
      '2000-01-01T00:00:00Z'
    )
    returning id, created_at
  `;
  assert.notEqual(
    catalogObservation.created_at.toISOString(),
    "2000-01-01T00:00:00.000Z",
  );
  const catalogRows = await runtime`
    select display_name, source_updated_at, retrieved_at
    from catalog_observations
    where id = ${catalogObservation.id}
  `;
  assert.equal(catalogRows[0]?.display_name, "Runtime observed catalog payload");
  assert.ok(catalogRows[0]?.source_updated_at < catalogRows[0]?.retrieved_at);
  await expectDenied(
    () => runtime`
      insert into ingestion_runs (
        source_id, run_type, status, started_at, completed_at, counts
      ) values (
        'kassalapp', 'catalog', 'completed', now(), now(), '{}'::jsonb
      )
    `,
    "runtime role must not insert an already-publishable ingestion run",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set source_id = 'legacy-import'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not relabel an ingestion source",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set run_type = 'historical-prices'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not relabel an ingestion type",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set started_at = started_at - interval '1 minute'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not rewrite ingestion start time",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set created_at = created_at - interval '1 minute'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not rewrite ingestion creation time",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set status = 'running'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not rewrite a still-running ingestion row",
  );
  await runtime`
    update ingestion_runs
    set status = 'completed',
        completed_at = now(),
        counts = '{"observations":1}'::jsonb
    where id = ${ingestionRun.id}
  `;
  await runtime`
    update ingestion_runs
    set status = 'completed',
        completed_at = now(),
        counts = '{"observations":1,"coverage":1}'::jsonb
    where id = ${priceIngestionRun.id}
  `;
  const [terminalizedRun] = await runtime`
    select created_at, completed_at, terminalized_at
    from ingestion_runs
    where id = ${ingestionRun.id}
  `;
  assert.ok(terminalizedRun?.terminalized_at instanceof Date);
  assert.ok(terminalizedRun.terminalized_at >= terminalizedRun.created_at);
  assert.ok(terminalizedRun.terminalized_at >= terminalizedRun.completed_at);
  await expectDenied(
    () => runtime`
      insert into source_record_outcomes (
        ingestion_run_id, record_kind, source_record_id, outcome_state,
        reason, outcome_hash, recorded_at, created_at
      ) values (
        ${priceIngestionRun.id}, 'price', 'runtime-role-proof-late-outcome',
        'accepted', null, ${"d".repeat(64)}, now(), '2000-01-01T00:00:00Z'
      )
    `,
    "runtime role must not append outcomes to a terminal ingestion run",
  );
  await expectDenied(
    () => runtime`
      insert into catalog_observations (
        ingestion_run_id, source_record_id, canonical_product_id, gtin,
        display_name, package_amount, package_unit, units_per_pack,
        retrieved_at, raw_record_hash, created_at
      ) values (
        ${ingestionRun.id}, 'runtime-role-proof-late-catalog', ${product.id},
        '7038010000010', 'Late catalog', 1, 'package', 1, now(),
        ${"e".repeat(64)}, '2000-01-01T00:00:00Z'
      )
    `,
    "runtime role must not append catalog evidence to a terminal ingestion run",
  );
  await expectDenied(
    () => runtime`
      insert into price_observations (
        evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
        source_id, source_reference, ingestion_run_id, evidence_level,
        confidence, claim_eligibility, raw_record_hash, created_at
      ) values (
        'runtime-role-proof-late-price', ${product.id}, 'extra', 3190,
        now() - interval '1 minute', now(), 'kassalapp', 'late',
        ${priceIngestionRun.id}, 'chain', 100, 'ordinary_only', ${"f".repeat(64)},
        '2000-01-01T00:00:00Z'
      )
    `,
    "runtime role must not append price evidence to a terminal ingestion run",
  );
  await expectDenied(
    () => runtime`
      insert into price_coverage_checks (
        ingestion_run_id, product_id, chain, state, reason, checked_at, created_at
      ) values (
        ${priceIngestionRun.id}, ${product.id}, 'extra', 'priced', 'late', now(),
        '2000-01-01T00:00:00Z'
      )
    `,
    "runtime role must not append coverage to a terminal ingestion run",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set status = 'degraded'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not promote or relabel a terminal ingestion run",
  );
  await expectDenied(
    () => runtime`
      update ingestion_runs
      set counts = '{"observations":999}'::jsonb
      where id = ${ingestionRun.id}
    `,
    "runtime role must not rewrite terminal ingestion counts",
  );
  await expectDenied(
    () => runtime`delete from ingestion_runs where id = ${ingestionRun.id}`,
    "runtime role must not delete ingestion provenance",
  );

  const [webCapabilities] = await web`
    select
      current_user as role_name,
      has_database_privilege(current_user, current_database(), 'CREATE') as database_create,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') as database_temp,
      has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
      has_table_privilege(
        current_user,
        'handleplan_schema_migrations',
        'SELECT'
      ) as migration_select,
      has_table_privilege(current_user, 'price_cache', 'SELECT') as cache_select,
      has_table_privilege(current_user, 'price_cache', 'INSERT, UPDATE, DELETE')
        as cache_write,
      has_table_privilege(current_user, 'canonical_products', 'SELECT')
        as catalog_select,
      has_table_privilege(current_user, 'canonical_products', 'INSERT, UPDATE, DELETE')
        as catalog_write,
      has_table_privilege(current_user, 'catalog_observations', 'SELECT')
        as catalog_observation_select,
      has_table_privilege(
        current_user,
        'catalog_observations',
        'INSERT, UPDATE, DELETE'
      ) as catalog_observation_write,
      has_table_privilege(current_user, 'price_observations', 'SELECT')
        as evidence_select,
      has_table_privilege(current_user, 'price_observations', 'INSERT, UPDATE, DELETE')
        as evidence_write,
      has_table_privilege(current_user, 'family_taxonomy_versions', 'SELECT')
        as taxonomy_version_select,
      has_table_privilege(current_user, 'reviewed_family_definitions', 'SELECT')
        as family_definition_select,
      has_table_privilege(current_user, 'reviewed_family_aliases', 'SELECT')
        as family_alias_select,
      has_table_privilege(current_user, 'reviewed_family_membership_public', 'SELECT')
        as family_membership_public_select,
      has_table_privilege(current_user, 'reviewed_family_membership_decisions', 'SELECT')
        as family_membership_private_select,
      has_column_privilege(current_user, 'source_permissions', 'permissions', 'SELECT')
        as source_permission_public_select,
      has_column_privilege(
        current_user,
        'source_permissions',
        'private_reference_key',
        'SELECT'
      ) as source_permission_private_select,
      has_table_privilege(current_user, 'publication_captures', 'SELECT')
        as private_capture_select,
      has_table_privilege(current_user, 'extracted_offer_candidates', 'SELECT')
        as private_candidate_select,
      has_table_privilege(current_user, 'review_actions', 'SELECT')
        as review_queue_select,
      has_table_privilege(current_user, 'worker_leases', 'SELECT')
        as worker_lease_select,
      has_table_privilege(current_user, 'worker_job_results', 'SELECT')
        as worker_result_select,
      has_table_privilege(current_user, 'provider_request_budget_events', 'SELECT')
        as budget_select,
      has_sequence_privilege(current_user, 'canonical_products_id_seq', 'USAGE')
        as sequence_usage,
      has_function_privilege(
        current_user,
        'reject_append_only_mutation()',
        'EXECUTE'
      ) as guard_execute,
      pg_has_role(current_user, 'handleplan', 'MEMBER') as migration_role_member,
      pg_has_role(current_user, 'handleplan_app', 'MEMBER') as worker_role_member,
      (
        select count(*)::integer
        from pg_class
        where relowner = (select oid from pg_roles where rolname = current_user)
      ) as owned_relations,
      (
        select rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls
        from pg_roles
        where rolname = current_user
      ) as elevated_role
  `;
  assert.deepEqual(webCapabilities, {
    role_name: webRole,
    database_create: false,
    database_temp: false,
    schema_create: false,
    migration_select: true,
    cache_select: true,
    cache_write: false,
    catalog_select: true,
    catalog_write: false,
    catalog_observation_select: true,
    catalog_observation_write: false,
    evidence_select: true,
    evidence_write: false,
    taxonomy_version_select: true,
    family_definition_select: true,
    family_alias_select: true,
    family_membership_public_select: true,
    family_membership_private_select: false,
    source_permission_public_select: true,
    source_permission_private_select: false,
    private_capture_select: false,
    private_candidate_select: false,
    review_queue_select: false,
    worker_lease_select: false,
    worker_result_select: false,
    budget_select: false,
    sequence_usage: false,
    guard_execute: false,
    migration_role_member: false,
    worker_role_member: false,
    owned_relations: 0,
    elevated_role: false,
  });

  const webMigrations = await web`
    select id from handleplan_schema_migrations where id = '012_reviewed_family_taxonomy.sql'
  `;
  assert.equal(webMigrations.length, 1, "web readiness must read the migration ledger");
  const webEvidence = await web`
    select observation.amount_ore, product.display_name, coverage.state
    from price_observations observation
    inner join canonical_products product on product.id = observation.product_id
    inner join price_coverage_checks coverage
      on coverage.ingestion_run_id = observation.ingestion_run_id
     and coverage.product_id = observation.product_id
     and coverage.chain = observation.chain
    where observation.id = ${observation.id}
  `;
  assert.deepEqual(
    [...webEvidence],
    [{ amount_ore: 3190, display_name: "Runtime role proof product", state: "priced" }],
    "web SELECT must read public price evidence",
  );
  const webCatalogEvidence = await web`
    select display_name, gtin, retrieved_at, source_updated_at
    from catalog_observations
    where id = ${catalogObservation.id}
  `;
  assert.equal(webCatalogEvidence[0]?.display_name, "Runtime observed catalog payload");
  assert.equal(webCatalogEvidence[0]?.gtin, "7038010000010");
  await web`
    select source_id, permissions
    from source_permissions
    order by reviewed_at desc, id desc
    limit 1
  `;
  const [webSourceClock] = await web`
    select public_state_changed_at
    from data_sources
    where id = 'kassalapp'
  `;
  assert.ok(
    webSourceClock?.public_state_changed_at instanceof Date,
    "web reader role must read the database-owned source-state clock",
  );
  const webTaxonomy = await web`
    select
      version.version_id,
      version.content_sha256,
      version.content_json,
      version.expected_family_count,
      version.expected_alias_count,
      family.family_id,
      alias.alias
    from family_taxonomy_versions version
    inner join reviewed_family_definitions family
      on family.version_id = version.version_id
    inner join reviewed_family_aliases alias
      on alias.version_id = family.version_id
     and alias.family_id = family.family_id
    where family.family_id = 'family:melk'
  `;
  assert.deepEqual(
    [...webTaxonomy],
    [{
      version_id: "handleplan-reviewed-families@1.0.0",
      content_sha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
      content_json: [
        { aliases: ["brød"], id: "family:brod", labelNo: "Brød", slug: "brod", status: "active" },
        { aliases: [], id: "family:kaffe", labelNo: "Kaffe", slug: "kaffe", status: "active" },
        { aliases: ["mjølk"], id: "family:melk", labelNo: "Melk", slug: "melk", status: "active" },
      ],
      expected_family_count: 3,
      expected_alias_count: 2,
      family_id: "family:melk",
      alias: "mjølk",
    }],
    "web role must read only the published reviewed-family definition",
  );
  await web`
    select id, family_id, decision, method, reviewer_attested
    from reviewed_family_membership_public
    limit 0
  `;

  await expectDenied(
    () => web`select private_reference_key from source_permissions limit 1`,
    "web role must not read private source references",
  );
  await expectDenied(
    () => web`select reviewer_id from reviewed_family_membership_decisions limit 1`,
    "web role must not read private reviewed-family reviewer identities",
  );
  await expectDenied(
    () => web`select id from publication_captures limit 1`,
    "web role must not read private publication captures",
  );
  await expectDenied(
    () => web`
      insert into reviewed_family_membership_decisions (
        version_id, family_id, product_id, decision, method, confidence,
        reviewer_id, reviewed_at
      ) values (
        'handleplan-reviewed-families@1.0.0', 'family:melk', ${product.id},
        'approved', 'human_review', 100, 'web-forgery', now()
      )
    `,
    "web role must not forge reviewed-family decisions",
  );
  await expectDenied(
    () => web`select id from extracted_offer_candidates limit 1`,
    "web role must not read private offer candidates",
  );
  await expectDenied(
    () => web`select lease_key from worker_leases limit 1`,
    "web role must not read worker leases",
  );
  await expectDenied(
    () => web`select provider_key from provider_request_budget_events limit 1`,
    "web role must not read request-budget state",
  );
  await expectDenied(
    () => web`
      insert into canonical_products (
        display_name, package_amount, package_unit, units_per_pack, status
      ) values ('Web forgery', 1, 'package', 1, 'active')
    `,
    "web role must not write canonical products",
  );
  await expectDenied(
    () => web`
      insert into ingestion_runs (source_id, run_type, status, started_at, counts)
      values ('kassalapp', 'web_forgery', 'running', now(), '{}'::jsonb)
    `,
    "web role must not write ingestion runs",
  );
  await expectDenied(
    () => web`
      insert into price_cache (ean, chain, amount_ore, observed_at, fetched_at)
      values ('7044710999981', 'extra', 1, now(), now())
    `,
    "web role must not write the legacy price cache",
  );
  await expectDenied(
    () => web`
      insert into price_observations (
        evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
        source_id, ingestion_run_id, evidence_level, confidence, claim_eligibility
      ) values (
        'web-forgery', ${product.id}, 'extra', 1, now(), now(),
        'kassalapp', ${ingestionRun.id}, 'chain', 100, 'ordinary_only'
      )
    `,
    "web role must not write price evidence",
  );
  await expectDenied(
    () => web`
      insert into catalog_observations (
        ingestion_run_id, source_record_id, canonical_product_id, gtin,
        display_name, package_amount, package_unit, units_per_pack,
        retrieved_at, raw_record_hash
      ) values (
        ${ingestionRun.id}, 'web-forgery', ${product.id}, '7038010000010',
        'Web forgery', 1, 'package', 1, now(), ${"f".repeat(64)}
      )
    `,
    "web role must not write catalog evidence",
  );
  await expectDenied(
    () => web`
      insert into worker_leases (
        lease_key, owner_id, acquired_at, expires_at, heartbeat_at
      ) values ('web-forgery', 'web', now(), now() + interval '1 minute', now())
    `,
    "web role must not write worker leases",
  );
  await expectDenied(
    () => web`
      insert into provider_request_budget_events (provider_key)
      values ('web-forgery')
    `,
    "web role must not write request-budget state",
  );
  await expectDenied(
    () => web`select nextval('canonical_products_id_seq')`,
    "web role must not use sequences",
  );
  await expectDenied(
    () => web.unsafe("select reject_append_only_mutation()"),
    "web role must not execute database functions",
  );

  await expectDenied(
    () => runtime`
      insert into source_permissions (
        source_id,
        decision,
        reviewed_at,
        permissions,
        notes
      ) values (
        'kassalapp',
        'approved',
        now(),
        '{"ordinaryPrice":true}'::jsonb,
        'runtime-role-proof-forgery'
      )
    `,
    "runtime role must not fabricate permission decisions",
  );
  await expectDenied(
    () => runtime`
      update data_sources set runtime_state = 'approved' where id = 'kassalapp'
    `,
    "runtime role must not promote source eligibility",
  );
  await expectDenied(
    () => runtime`
      insert into source_health_snapshots (source_id, status, details, recorded_at)
      values ('kassalapp', 'healthy', '{}'::jsonb, now())
    `,
    "worker role must not write unimplemented public-status pipelines",
  );
  await expectDenied(
    () => runtime`select id from publication_captures limit 1`,
    "worker role must not read private capture pipelines",
  );
  await expectDenied(
    () => runtime`select family_id from reviewed_family_membership_public limit 1`,
    "worker role must not read reviewed-family taxonomy state",
  );
  await expectDenied(
    () => runtime`
      insert into reviewed_family_membership_decisions (
        version_id, family_id, product_id, decision, method, confidence,
        rule_version, reviewed_at
      ) values (
        'handleplan-reviewed-families@1.0.0', 'family:melk', ${product.id},
        'approved', 'deterministic_rule', 100, 'worker-forgery', now()
      )
    `,
    "worker role must not forge reviewed-family decisions",
  );
  await expectDenied(
    () => runtime`
      update price_observations set amount_ore = 1 where id = ${observation.id}
    `,
    "runtime role must not update append-only evidence",
  );
  await expectDenied(
    () => runtime`
      update catalog_observations
      set display_name = 'Rewritten catalog payload'
      where id = ${catalogObservation.id}
    `,
    "runtime role must not update append-only catalog evidence",
  );
  await expectDenied(
    () => runtime`
      delete from catalog_observations where id = ${catalogObservation.id}
    `,
    "runtime role must not delete append-only catalog evidence",
  );
  await runtime`select set_config('handleplan.allow_append_only_mutation', 'on', false)`;
  await expectDenied(
    () => runtime`delete from price_coverage_checks where id = ${coverage.id}`,
    "a custom GUC must not bypass append-only protection",
  );
  await expectDenied(
    () => runtime.unsafe(
      "alter table source_permissions disable trigger source_permissions_append_only",
    ),
    "runtime role must not disable the append-only trigger",
  );
  await expectDenied(
    () => runtime.unsafe("set session_replication_role = replica"),
    "runtime role must not suppress triggers through replication mode",
  );
  await expectDenied(
    () => runtime.unsafe("create table runtime_role_escape (id integer)"),
    "runtime role must not perform schema DDL",
  );
  await expectDenied(
    () => runtime.unsafe("select reject_append_only_mutation()"),
    "runtime role must not invoke the guard function directly",
  );
  await expectDenied(
    () => runtime.unsafe("set role handleplan"),
    "runtime role must not assume the migration owner",
  );

  const survivingRows = await runtime`
    select count(*)::integer as count from price_observations where id = ${observation.id}
  `;
  assert.equal(survivingRows[0]?.count, 1, "protected proof row must survive bypass attempts");

  proofResult = {
    database: proofDatabase,
    workerRole,
    webRole,
    ownershipFailClosed: true,
    cacheAndWorkerWrites: true,
    requestBudgetCoordination: true,
    webPublicReads: true,
    webPrivateReadsDenied: true,
    webWritesDenied: true,
    protectedInsertRead: true,
    catalogObservationInsertRead: true,
    reviewedFamilyPublicProjection: true,
    reviewedFamilyPrivateReviewerDenied: true,
    reviewedFamilyWorkerAccessDenied: true,
    protectedMutationDenied: true,
    triggerDisableDenied: true,
    schemaDdlDenied: true,
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

  if (web) {
    await attemptCleanup("close web connection", () => web.end({ timeout: 5 }));
  }
  if (runtime) {
    await attemptCleanup("close runtime connection", () => runtime.end({ timeout: 5 }));
  }
  if (admin && createdDatabase) {
    await attemptCleanup(`drop ${proofDatabase}`, () => dropProofDatabase(admin));
  }
  if (admin) {
    await attemptCleanup("close admin connection", () => admin.end({ timeout: 5 }));
  }

  if (cleanupErrors.length > 0) {
    proofError = new AggregateError(
      proofError ? [proofError, ...cleanupErrors] : cleanupErrors,
      proofError
        ? "Runtime-role database proof and cleanup failed"
        : "Runtime-role database proof cleanup failed",
    );
  }
}

if (proofError) throw proofError;
console.log("Runtime database least-privilege proof passed", proofResult);
