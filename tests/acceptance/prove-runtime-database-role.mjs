import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const migrationRunner = resolve(root, "deploy/migrate.mjs");
const runtimeRole = "handleplan_app";

assert.equal(process.env.CI, "true", "runtime-role proof requires CI=true");
assert.ok(process.env.DATABASE_ADMIN_URL, "DATABASE_ADMIN_URL is required");
assert.ok(process.env.APP_DATABASE_PASSWORD, "APP_DATABASE_PASSWORD is required");
assert.match(
  process.env.APP_DATABASE_PASSWORD,
  /^[A-Za-z0-9_-]{32,128}$/,
  "APP_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
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
    /permission denied|must be owner|must be superuser|not permitted|append-only/i,
    label,
  );
}

let admin;
let runtime;
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

  await run(process.execPath, [migrationRunner], {
    ...process.env,
    DATABASE_MIGRATION_URL: urlForDatabase(proofDatabase),
    APP_DATABASE_PASSWORD: process.env.APP_DATABASE_PASSWORD,
    MIGRATIONS_DIR: process.env.MIGRATIONS_DIR,
  });

  runtime = postgres(runtimeUrlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });

  const [capabilities] = await runtime`
    select
      current_user as role_name,
      has_database_privilege(current_user, current_database(), 'CREATE') as database_create,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') as database_temp,
      has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
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
    protected_select: true,
    permission_insert: false,
    protected_update: false,
    protected_delete: false,
    source_state_update: false,
    evidence_select: true,
    evidence_insert: true,
    evidence_update: false,
    evidence_delete: false,
    worker_lease_write: true,
    source_health_append: true,
    budget_select: true,
    budget_insert: true,
    budget_delete: true,
    budget_update: false,
    guard_execute: false,
    migration_role_member: false,
    owned_relations: 0,
    elevated_role: false,
  });

  const ean = "7044710999991";
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

  const [health] = await runtime`
    insert into source_health_snapshots (
      source_id,
      status,
      details,
      recorded_at
    ) values (
      'kassalapp',
      'healthy',
      '{"proof":true}'::jsonb,
      now()
    )
    returning id
  `;
  const healthRows = await runtime`
    select status from source_health_snapshots where id = ${health.id}
  `;
  assert.equal(healthRows[0]?.status, "healthy");

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
      'runtime_role_proof',
      'completed',
      now() - interval '1 minute',
      now(),
      '{"observations":1}'::jsonb
    )
    returning id
  `;
  const [product] = await runtime`
    insert into canonical_products (
      display_name,
      package_amount,
      package_unit,
      units_per_pack,
      status
    ) values ('Runtime role proof product', 1, 'package', 1, 'active')
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
      raw_record_hash
    ) values (
      'runtime-role-proof-evidence',
      ${product.id},
      'extra',
      3190,
      now() - interval '1 minute',
      now(),
      'kassalapp',
      'runtime-role-proof',
      ${ingestionRun.id},
      'chain',
      100,
      'ordinary_only',
      ${"b".repeat(64)}
    )
    returning id
  `;
  const [coverage] = await runtime`
    insert into price_coverage_checks (
      ingestion_run_id,
      product_id,
      chain,
      state,
      reason,
      checked_at
    ) values (
      ${ingestionRun.id},
      ${product.id},
      'extra',
      'priced',
      'runtime_role_proof',
      now()
    )
    returning id
  `;
  const protectedRows = await runtime`
    select amount_ore from price_observations where id = ${observation.id}
  `;
  assert.equal(protectedRows[0]?.amount_ore, 3190);

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
      update price_observations set amount_ore = 1 where id = ${observation.id}
    `,
    "runtime role must not update append-only evidence",
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
    role: runtimeRole,
    cacheAndWorkerWrites: true,
    requestBudgetCoordination: true,
    protectedInsertRead: true,
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
