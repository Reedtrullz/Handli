import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const migrationRunner = resolve(root, "deploy/migrate.mjs");
const workerRole = "handleplan_app";
const runtimeRole = workerRole;
const webRole = "handleplan_web";
const reviewRole = "handleplan_review";
const operationsRole = "handleplan_operations";
const reviewActorId = `access:${"e".repeat(64)}`;
const reviewSessionId = `access-session:${"d".repeat(64)}`;
const reviewEvidenceProof = "c".repeat(64);
const reviewCaptureChecksum = "a".repeat(64);
const reviewEvidenceLocator = "runtime-review-boundary-evidence";
const webTableSelects = [
  "catalog_observations",
  "canonical_products",
  "family_taxonomy_versions",
  "geographic_scope_regions",
  "geographic_scope_postal_codes",
  "geographic_scope_stores",
  "geographic_postal_directory_codes",
  "geographic_postal_directory_regions",
  "geographic_postal_directory_versions",
  "handleplan_schema_migrations",
  "latest_price_evidence",
  "physical_store_branches_public",
  "physical_store_region_branches_public",
  "physical_store_coverage_checks",
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
  "physical_store_coverage_checks",
  "physical_store_observations",
  "price_coverage_checks",
  "price_observations",
  "source_record_outcomes",
  "source_health_snapshots",
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
  "physical_store_coverage_checks_id_seq",
  "physical_store_observations_id_seq",
  "price_observations_id_seq",
  "product_identifiers_id_seq",
  "source_record_outcomes_id_seq",
  "source_health_snapshots_id_seq",
  "worker_job_results_id_seq",
];
const reviewTableSelects = [];
const reviewTableInserts = [];
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
  geographic_scopes: [
    "country_code",
    "created_at",
    "id",
    "label",
    "public_state_changed_at",
    "scope_kind",
    "status",
  ],
  ingestion_runs: [
    "completed_at",
    "created_at",
    "id",
    "run_type",
    "source_id",
    "started_at",
    "status",
    "terminalized_at",
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
const reviewColumnSelects = {};

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
assert.ok(process.env.REVIEW_DATABASE_PASSWORD, "REVIEW_DATABASE_PASSWORD is required");
assert.match(
  process.env.REVIEW_DATABASE_PASSWORD,
  /^[A-Za-z0-9_-]{32,128}$/,
  "REVIEW_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.ok(
  process.env.OPERATIONS_DATABASE_PASSWORD,
  "OPERATIONS_DATABASE_PASSWORD is required",
);
assert.match(
  process.env.OPERATIONS_DATABASE_PASSWORD,
  /^[A-Za-z0-9_-]{32,128}$/,
  "OPERATIONS_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
);
assert.notEqual(
  process.env.APP_DATABASE_PASSWORD,
  process.env.WEB_DATABASE_PASSWORD,
  "worker and web credentials must differ",
);
assert.notEqual(
  process.env.APP_DATABASE_PASSWORD,
  process.env.REVIEW_DATABASE_PASSWORD,
  "worker and review credentials must differ",
);
assert.notEqual(
  process.env.WEB_DATABASE_PASSWORD,
  process.env.REVIEW_DATABASE_PASSWORD,
  "web and review credentials must differ",
);
for (const [otherName, otherPassword] of [
  ["worker", process.env.APP_DATABASE_PASSWORD],
  ["web", process.env.WEB_DATABASE_PASSWORD],
  ["review", process.env.REVIEW_DATABASE_PASSWORD],
]) {
  assert.notEqual(
    process.env.OPERATIONS_DATABASE_PASSWORD,
    otherPassword,
    `operations and ${otherName} credentials must differ`,
  );
}
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
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.REVIEW_DATABASE_PASSWORD,
  "review and migration credentials must differ",
);
assert.notEqual(
  decodeURIComponent(adminUrl.password),
  process.env.OPERATIONS_DATABASE_PASSWORD,
  "operations and migration credentials must differ",
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

function reviewUrlForDatabase(database) {
  const url = new URL(urlForDatabase(database));
  url.username = reviewRole;
  url.password = process.env.REVIEW_DATABASE_PASSWORD;
  return url.toString();
}

function operationsUrlForDatabase(database) {
  const url = new URL(urlForDatabase(database));
  url.username = operationsRole;
  url.password = process.env.OPERATIONS_DATABASE_PASSWORD;
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

function evidenceCropReference(candidateId) {
  const separator = Buffer.from([0]);
  const digest = createHash("sha256")
    .update(Buffer.concat([
      Buffer.from("v1", "utf8"),
      separator,
      Buffer.from(String(candidateId), "utf8"),
      separator,
      Buffer.from(reviewCaptureChecksum, "utf8"),
      separator,
      Buffer.from(reviewEvidenceLocator, "utf8"),
    ]))
    .digest("hex");
  return `review-crop:${digest}`;
}

function expectedTableGrants(role) {
  const grants = new Set();
  const add = (table, privileges) => {
    for (const privilege of privileges) grants.add(`${table}:${privilege}`);
  };
  if (role === webRole) {
    for (const table of webTableSelects) add(table, ["SELECT"]);
  } else if (role === reviewRole) {
    for (const table of reviewTableSelects) add(table, ["SELECT"]);
    for (const table of reviewTableInserts) add(table, ["INSERT"]);
  } else if (role === operationsRole) {
    // The private operations process crosses one aggregate function boundary
    // and deliberately receives no direct table or column privileges.
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

async function assertExactColumnGrants(client, role, columnSelects) {
  const tableNames = Object.keys(columnSelects);
  const rows = tableNames.length === 0
    ? await client`
      select table_name, column_name, privilege_type
      from information_schema.role_column_grants
      where grantee = ${role}
        and table_schema = 'public'
      order by table_name, column_name, privilege_type
    `
    : await client`
      select table_name, column_name, privilege_type
      from information_schema.role_column_grants
      where grantee = ${role}
        and table_schema = 'public'
        and table_name = any(${client.array(tableNames)}::text[])
      order by table_name, column_name, privilege_type
    `;
  const expected = Object.entries(columnSelects)
    .flatMap(([table, columns]) => columns.map((column) => `${table}:${column}:SELECT`))
    .sort();
  assert.deepEqual(
    rows.map(({ table_name: table, column_name: column, privilege_type: privilege }) =>
      `${table}:${column}:${privilege}`).sort(),
    expected,
    `${role} column grants must match the private-data allowlist exactly`,
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
    role === workerRole ? [...workerSequenceUsage].sort() : [],
    `${role} sequence usage must match the explicit allowlist exactly`,
  );

  const functions = await client`
    select p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace namespace on namespace.oid = p.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(current_user, p.oid, 'EXECUTE')
  `;
  assert.deepEqual(
    functions.map(({ function_name: name, identity_arguments: argumentsList }) =>
      `${name}(${argumentsList})`).sort(),
    role === workerRole ? [
      "official_offer_lifecycle_reconcile_v1(p_source_id text, p_job_id text, p_run_id text, p_scheduled_at timestamp with time zone, p_owner_id text, p_batch_limit integer, p_publication_requested boolean)",
    ] : role === webRole
      ? [
        "claim_public_api_request_budget(p_route_key text)",
        "public_official_offer_rows_v1(p_product_ids bigint[], p_evaluation_as_of timestamp with time zone)",
      ]
      : role === reviewRole ? [
        "private_review_candidate_rows_v1(p_candidate_id bigint, p_evaluation_as_of timestamp with time zone, p_chain text, p_scope_kind text, p_min_confidence integer, p_max_confidence integer, p_min_age_hours integer, p_max_age_hours integer, p_anomaly text, p_cursor_created_at timestamp with time zone, p_cursor_id bigint, p_result_limit integer)",
        "private_review_decide_v2(p_candidate_id bigint, p_expected_version integer, p_action text, p_actor_id text, p_reviewer_session_id text, p_evidence_proof_sha256 text, p_reason text, p_target_kind text, p_target_gtin text, p_target_family_slug text, p_pricing_kind text, p_offer_price_ore integer, p_before_price_ore integer, p_multibuy_quantity integer, p_multibuy_total_ore integer, p_eligibility_kind text, p_membership_program_id text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_channels text[])",
        "private_review_record_evidence_render_v1(p_candidate_id bigint, p_expected_version integer, p_capture_checksum text, p_crop_reference text, p_presentation text, p_rights_classification text, p_actor_id text, p_reviewer_session_id text, p_evidence_proof_sha256 text, p_expires_at timestamp with time zone)",
      ] : role === operationsRole ? [
        "append_operations_alert_evaluation_v1(p_evaluated_at timestamp with time zone, p_source_roster jsonb, p_assessments jsonb)",
        "operations_alert_export_rows_v1(p_after_event_id bigint, p_result_limit integer)",
        "operations_dashboard_rows_v1(p_source_ids text[], p_result_limit integer)",
      ] : [],
    `${role} function execution must match the explicit allowlist exactly`,
  );
}

let admin;
let runtime;
let web;
let review;
let operations;
let createdDatabase = false;
let proofError;
let proofResult;
let reviewBoundaryCandidateId;
let reviewBoundaryValidFrom;
let reviewBoundaryValidUntil;

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

  const hostileSchema = "handleplan_hostile_path";
  const preMigration = postgres(urlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  try {
    await preMigration.unsafe(`create schema "${hostileSchema}"`);
    await preMigration.unsafe(
      `alter role handleplan in database "${proofDatabase}" set search_path = "${hostileSchema}", public`,
    );
  } finally {
    await preMigration.end({ timeout: 5 });
  }

  const migrationEnvironment = {
    ...process.env,
    DATABASE_MIGRATION_URL: urlForDatabase(proofDatabase),
    APP_DATABASE_PASSWORD: process.env.APP_DATABASE_PASSWORD,
    MIGRATIONS_DIR: process.env.MIGRATIONS_DIR,
    OPERATIONS_DATABASE_PASSWORD: process.env.OPERATIONS_DATABASE_PASSWORD,
    WEB_DATABASE_PASSWORD: process.env.WEB_DATABASE_PASSWORD,
    REVIEW_DATABASE_PASSWORD: process.env.REVIEW_DATABASE_PASSWORD,
  };
  await run(process.execPath, [migrationRunner], migrationEnvironment);

  const ownershipAdmin = postgres(urlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  try {
    const [schemaPlacement] = await ownershipAdmin`
      select
        to_regclass('public.handleplan_schema_migrations') is not null as public_ledger,
        to_regclass('public.geographic_postal_directory_versions') is not null
          as public_directory,
        to_regclass('handleplan_hostile_path.handleplan_schema_migrations') is null
          as hostile_ledger_absent,
        to_regclass('handleplan_hostile_path.geographic_postal_directory_versions') is null
          as hostile_directory_absent
    `;
    assert.deepEqual(schemaPlacement, {
      hostile_directory_absent: true,
      hostile_ledger_absent: true,
      public_directory: true,
      public_ledger: true,
    }, "migration runner must ignore hostile role search_path");

    const [operationsProjection] = await ownershipAdmin`
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
      "operations projection must require the renderer-gated review marker at all three offer aggregates",
    );
    assert.doesNotMatch(
      operationsProjection.body,
      /current_action\.decision_boundary_version\s*=\s*1/,
      "operations projection must retain no legacy review marker",
    );
    const [publicOfferProjection] = await ownershipAdmin`
      select procedure.prosrc as body
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.public_official_offer_rows_v1(bigint[],timestamptz)'
      )
    `;
    assert.match(
      publicOfferProjection.body,
      /review\.decision_boundary_version\s*=\s*2/,
      "public offer projection must require the renderer-gated review marker",
    );
    assert.doesNotMatch(
      publicOfferProjection.body,
      /review\.decision_boundary_version\s*=\s*1/,
      "public offer projection must retain no legacy review marker",
    );

    await assert.rejects(
      () => ownershipAdmin`
        insert into public.geographic_postal_directory_versions (
          version_id, contract_version, country_code, status, reviewed_at,
          valid_from, evidence_reference
        ) values (
          'runtime-role-proof-direct-terminal', 1, 'NO', 'blocked',
          now() - interval '2 minutes', now() - interval '1 minute',
          'proof:direct-terminal'
        )
      `,
      /must be inserted unsealed in building state/,
      "directory terminal states must be reached only through the guarded transition",
    );

    const directoryVersionId = "runtime-role-proof-postal-v1";
    let beforeDirectorySeal;
    await ownershipAdmin.begin(async (transaction) => {
      await transaction`
        insert into geographic_postal_directory_versions (
          version_id, contract_version, country_code, status, reviewed_at,
          valid_from, evidence_reference
        ) values (
          ${directoryVersionId}, 1, 'NO', 'building',
          now() - interval '2 minutes', now() - interval '1 minute',
          'proof:runtime-role-directory'
        )
      `;
      await transaction`
        insert into geographic_postal_directory_regions (
          version_id, region_code, coverage_state, postal_count,
          evidence_reference
        ) values (
          ${directoryVersionId}, 'no-0301-oslo', 'complete', 2,
          'proof:runtime-role-oslo'
        )
      `;
      await transaction`
        insert into geographic_postal_directory_codes (
          version_id, region_code, postal_code
        ) values
          (${directoryVersionId}, 'no-0301-oslo', '0152'),
          (${directoryVersionId}, 'no-0301-oslo', '0452')
      `;
      const [preSealClock] = await transaction`select clock_timestamp() as evaluated_at`;
      beforeDirectorySeal = preSealClock?.evaluated_at;
      await transaction`select pg_sleep(0.005)`;
      await transaction`
        update geographic_postal_directory_versions
        set status = 'approved'
        where version_id = ${directoryVersionId}
      `;
    });
    assert.ok(beforeDirectorySeal instanceof Date, "pre-seal proof clock must be a database time");
    const [sealedDirectory] = await ownershipAdmin`
      select sealed_at
      from public.geographic_postal_directory_versions
      where version_id = ${directoryVersionId}
    `;
    assert.ok(
      sealedDirectory?.sealed_at instanceof Date
        && sealedDirectory.sealed_at > beforeDirectorySeal,
      "terminal transition must stamp sealed_at after the pre-seal clock",
    );
    const [preSealAuthorization] = await ownershipAdmin`
      select count(*)::integer as terminal_count
      from public.geographic_postal_directory_versions
      where version_id = ${directoryVersionId}
        and status <> 'building'
        and sealed_at <= ${beforeDirectorySeal}
    `;
    assert.equal(
      preSealAuthorization?.terminal_count,
      0,
      "current terminal status must not authorize an evaluation from before sealed_at",
    );
    await assert.rejects(
      () => ownershipAdmin`
        insert into geographic_postal_directory_regions (
          version_id, region_code, coverage_state, postal_count,
          evidence_reference
        ) values (
          ${directoryVersionId}, 'no-4601-bergen', 'ambiguous', 0,
          'proof:late-region'
        )
      `,
      /sealed postal directory children are immutable/,
      "approved postal directories must reject late child append",
    );
    await assert.rejects(
      () => ownershipAdmin`
        update geographic_postal_directory_versions
        set evidence_reference = 'proof:forged-late-edit'
        where version_id = ${directoryVersionId}
      `,
      /sealed postal directory versions are immutable/,
      "approved postal directory metadata must stay immutable",
    );

    await ownershipAdmin.unsafe(
      "create table worker_owned_migration_probe (id integer primary key)",
    );
    await ownershipAdmin.unsafe(
      "create table web_owned_migration_probe (id integer primary key)",
    );
    await ownershipAdmin.unsafe(
      "create table review_owned_migration_probe (id integer primary key)",
    );
    await ownershipAdmin.unsafe(
      `alter table worker_owned_migration_probe owner to ${workerRole}`,
    );
    await ownershipAdmin.unsafe(
      `alter table web_owned_migration_probe owner to ${webRole}`,
    );
    await ownershipAdmin.unsafe(
      `alter table review_owned_migration_probe owner to ${reviewRole}`,
    );
    await assert.rejects(
      () => run(process.execPath, [migrationRunner], migrationEnvironment),
      /Runtime roles must not own database objects/,
      "migration hardening must fail closed instead of silently reassigning runtime ownership",
    );

    const [reviewClock] = await ownershipAdmin`
      select
        date_trunc('milliseconds', clock_timestamp() - interval '1 minute') as reviewed_at,
        date_trunc('milliseconds', clock_timestamp() - interval '1 hour') as valid_from,
        date_trunc('milliseconds', clock_timestamp() + interval '1 day') as valid_until
    `;
    reviewBoundaryValidFrom = reviewClock?.valid_from;
    reviewBoundaryValidUntil = reviewClock?.valid_until;
    assert.ok(
      reviewClock?.reviewed_at instanceof Date
        && reviewBoundaryValidFrom instanceof Date
        && reviewBoundaryValidUntil instanceof Date,
      "private review decision-boundary fixture requires database clocks",
    );
    await ownershipAdmin`
      insert into data_sources (
        id, display_name, source_kind, runtime_state,
        permission_reviewed_at, permission_expires_at, kill_switch_reason
      ) values (
        'runtime-review-boundary', 'Synthetic private review boundary proof',
        'offer', 'approved', ${reviewClock.reviewed_at},
        ${reviewBoundaryValidUntil}, 'CI-only rights-cleared fixture'
      )
    `;
    const [reviewPermission] = await ownershipAdmin`
      insert into source_permissions (
        source_id, decision, reviewed_at, valid_until, permissions, notes
      ) values (
        'runtime-review-boundary', 'approved', ${reviewClock.reviewed_at},
        ${reviewBoundaryValidUntil},
        ${ownershipAdmin.json({
          officialOffers: true,
          privateReview: true,
          publicDisplay: false,
          officialOfferCapabilities: ["capture", "discover", "extract"],
          officialOfferRightsClassifications: ["private_review"],
        })},
        'Synthetic runtime-role proof only'
      )
      returning id
    `;
    assert.ok(reviewPermission?.id, "private review permission fixture must persist");
    const [reviewScope] = await ownershipAdmin`
      insert into geographic_scopes (
        scope_key, scope_kind, label, country_code, status
      ) values (
        'runtime-review-boundary:national', 'national',
        'Runtime review boundary Norway', 'NO', 'active'
      )
      returning id
    `;
    assert.ok(reviewScope?.id, "private review scope fixture must persist");
    const declaredScope = { kind: "national", countryCode: "NO" };
    const discoveredAt = reviewClock.reviewed_at;
    const [reviewPublication] = await ownershipAdmin`
      insert into publications (
        source_id, external_id, chain, title, valid_from, valid_until,
        geographic_scope_id, status, discovered_at, content_kind,
        declared_geographic_scope, edition_identity_sha256,
        discovery_permission_id
      ) values (
        'runtime-review-boundary', 'runtime-review-boundary-edition', 'extra',
        'Synthetic private review boundary edition', ${reviewBoundaryValidFrom},
        ${reviewBoundaryValidUntil}, ${reviewScope.id}, 'captured', ${discoveredAt},
        'structured-feed', ${ownershipAdmin.json(declaredScope)},
        encode(sha256(convert_to(canonical_official_offer_edition_identity(
          'runtime-review-boundary', 'runtime-review-boundary-edition', 'extra',
          'Synthetic private review boundary edition', 'structured-feed',
          ${reviewScope.id}, ${ownershipAdmin.json(declaredScope)},
          ${reviewBoundaryValidFrom}, ${reviewBoundaryValidUntil}, ${discoveredAt}
        ), 'UTF8')), 'hex'),
        ${reviewPermission.id}
      )
      returning id
    `;
    assert.ok(reviewPublication?.id, "private review publication fixture must persist");
    const [reviewCapture] = await ownershipAdmin`
      insert into publication_captures (
        publication_id, blob_key, checksum, mime_type, byte_length,
        rights_classification, retrieved_at, capture_permission_id,
        capture_permission_capabilities
      ) values (
        ${reviewPublication.id}, 'runtime-review-boundary/capture.png',
        ${reviewCaptureChecksum}, 'image/png', 128, 'private_review', clock_timestamp(),
        ${reviewPermission.id}, '["capture", "discover", "extract"]'::jsonb
      )
      returning id, retrieved_at
    `;
    assert.ok(reviewCapture?.id, "private review capture fixture must persist");
    const [reviewExtraction] = await ownershipAdmin`
      insert into extraction_runs (
        capture_id, extractor_version, status, started_at, completed_at, counts,
        extraction_method, extraction_permission_id, permission_capabilities,
        source_started_at, source_completed_at, empty_result
      ) values (
        ${reviewCapture.id}, 'runtime-review-boundary-v1', 'completed',
        ${reviewCapture.retrieved_at}, ${reviewCapture.retrieved_at},
        '{"candidates": 1}'::jsonb, 'structured', ${reviewPermission.id},
        '["capture", "discover", "extract"]'::jsonb,
        ${reviewCapture.retrieved_at}, ${reviewCapture.retrieved_at}, 'not-empty'
      )
      returning id
    `;
    assert.ok(reviewExtraction?.id, "private review extraction fixture must persist");
    const candidatePayload = {
      contractVersion: 1,
      candidateKey: "runtime-review-boundary-candidate",
      product: { kind: "exact-identifier", scheme: "gtin", value: "7038010000010" },
      package: { state: "parsed", amount: 1_000, unit: "ml", unitsPerPack: 1 },
      pricing: { kind: "unit", offerPriceOre: 2_990, beforePriceOre: 3_990 },
      eligibility: { kind: "public" },
      validity: {
        state: "parsed",
        startsAt: reviewBoundaryValidFrom.toISOString(),
        endsAt: reviewBoundaryValidUntil.toISOString(),
      },
      geographicScope: declaredScope,
      channels: ["in-store"],
      provenance: {
        method: "structured",
        evidenceLocator: reviewEvidenceLocator,
        confidence: 92,
      },
      anomalyCodes: ["OCR_REVIEW_REQUIRED"],
    };
    const reviewCandidateEnvelope = {
      contractVersion: 1,
      anomalyCodes: ["OCR_REVIEW_REQUIRED"],
      candidate: candidatePayload,
      disposition: "review-required",
      publicationRoute: "human-review-required",
    };
    const [reviewCandidate] = await ownershipAdmin`
      insert into extracted_offer_candidates (
        extraction_run_id, candidate_key, normalized_fields, confidence,
        status, anomaly_codes
      ) values (
        ${reviewExtraction.id}, 'runtime-review-boundary-candidate',
        ${ownershipAdmin.json(reviewCandidateEnvelope)},
        92, 'pending', '["OCR_REVIEW_REQUIRED"]'::jsonb
      )
      returning id
    `;
    reviewBoundaryCandidateId = reviewCandidate?.id;
    assert.ok(reviewBoundaryCandidateId, "private review candidate fixture must persist");
  } finally {
    await ownershipAdmin.unsafe("drop table if exists worker_owned_migration_probe");
    await ownershipAdmin.unsafe("drop table if exists web_owned_migration_probe");
    await ownershipAdmin.unsafe("drop table if exists review_owned_migration_probe");
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
  review = postgres(reviewUrlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  operations = postgres(operationsUrlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });

  await assertExactTableGrants(runtime, workerRole);
  await assertExactTableGrants(web, webRole);
  await assertExactTableGrants(review, reviewRole);
  await assertExactTableGrants(operations, operationsRole);
  await assertExactColumnGrants(web, webRole, webColumnSelects);
  await assertExactColumnGrants(review, reviewRole, reviewColumnSelects);
  await assertExactColumnGrants(operations, operationsRole, {});
  await assertExactSequenceAndFunctionGrants(runtime, workerRole);
  await assertExactSequenceAndFunctionGrants(web, webRole);
  await assertExactSequenceAndFunctionGrants(review, reviewRole);
  await assertExactSequenceAndFunctionGrants(operations, operationsRole);

  const [operationsCapabilities] = await operations`
    select
      current_user as role_name,
      has_database_privilege(current_user, current_database(), 'CREATE') as database_create,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') as database_temp,
      has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
      has_table_privilege(current_user, 'data_sources', 'SELECT') as public_table_select,
      has_table_privilege(current_user, 'worker_job_results', 'SELECT') as worker_table_select,
      has_table_privilege(current_user, 'publication_captures', 'SELECT')
        as private_table_select,
      has_table_privilege(
        current_user,
        'alert_events',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as alert_ledger_access,
      has_sequence_privilege(current_user, 'alert_events_id_seq', 'USAGE')
        as sequence_usage,
      has_function_privilege(
        current_user,
        'operations_dashboard_rows_v1(text[],integer)',
        'EXECUTE'
      ) as dashboard_execute,
      has_function_privilege(
        current_user,
        'append_operations_alert_evaluation_v1(timestamptz,jsonb,jsonb)',
        'EXECUTE'
      ) as alert_append_execute,
      has_function_privilege(
        current_user,
        'operations_alert_export_rows_v1(bigint,integer)',
        'EXECUTE'
      ) as alert_export_execute,
      has_function_privilege(current_user, 'reject_append_only_mutation()', 'EXECUTE')
        as generic_guard_execute,
      has_function_privilege(
        current_user,
        'stamp_operations_runtime_boundary_v1()',
        'EXECUTE'
      ) as trigger_function_execute,
      pg_has_role(current_user, 'handleplan', 'MEMBER') as migration_role_member,
      pg_has_role(current_user, 'handleplan_app', 'MEMBER') as worker_role_member,
      pg_has_role(current_user, 'handleplan_web', 'MEMBER') as web_role_member,
      pg_has_role(current_user, 'handleplan_review', 'MEMBER') as review_role_member,
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
  assert.deepEqual(operationsCapabilities, {
    role_name: operationsRole,
    database_create: false,
    database_temp: false,
    schema_create: false,
    public_table_select: false,
    worker_table_select: false,
    private_table_select: false,
    alert_ledger_access: false,
    sequence_usage: false,
    dashboard_execute: true,
    alert_append_execute: true,
    alert_export_execute: true,
    generic_guard_execute: false,
    trigger_function_execute: false,
    migration_role_member: false,
    worker_role_member: false,
    web_role_member: false,
    review_role_member: false,
    owned_relations: 0,
    elevated_role: false,
  });
  for (const table of [
    "alert_events",
    "approved_offers",
    "canonical_products",
    "data_sources",
    "handleplan_schema_migrations",
    "latest_price_evidence",
    "private_review_evidence_renders",
    "publication_captures",
    "source_health_snapshots",
    "worker_job_results",
  ]) {
    await expectDenied(
      () => operations.unsafe(`select * from ${table} limit 0`),
      "operations role must not bypass its bounded aggregate function",
    );
  }
  await expectDenied(
    () => operations`select nextval('alert_events_id_seq')`,
    "operations role must not use sequences",
  );
  await expectDenied(
    () => operations.unsafe("select reject_append_only_mutation()"),
    "operations role must not invoke generic database functions",
  );
  await expectDenied(
    () => operations.unsafe("create table operations_role_escape (id integer)"),
    "operations role must not perform schema DDL",
  );
  await expectDenied(
    () => operations.unsafe("set role handleplan"),
    "operations role must not assume the migration owner",
  );

  const [reviewCapabilities] = await review`
    select
      current_user as role_name,
      has_database_privilege(current_user, current_database(), 'CREATE') as database_create,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') as database_temp,
      has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
      has_table_privilege(current_user, 'publication_captures', 'SELECT')
        as capture_select,
      has_table_privilege(current_user, 'extracted_offer_candidates', 'SELECT')
        as candidate_select,
      has_table_privilege(current_user, 'extracted_offer_candidates', 'INSERT, UPDATE, DELETE')
        as candidate_write,
      has_table_privilege(current_user, 'review_actions', 'SELECT, INSERT')
        as review_action_append,
      has_table_privilege(current_user, 'review_actions', 'UPDATE, DELETE')
        as review_action_rewrite,
      has_table_privilege(
        current_user,
        'private_review_evidence_renders',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as evidence_render_table_access,
      has_table_privilege(
        current_user,
        'private_review_evidence_consumptions',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as evidence_consumption_table_access,
      has_table_privilege(current_user, 'approved_offers', 'SELECT, INSERT')
        as offer_append,
      has_table_privilege(current_user, 'approved_offers', 'UPDATE, DELETE')
        as offer_rewrite,
      has_table_privilege(current_user, 'offer_targets', 'SELECT, INSERT')
        as target_append,
      has_table_privilege(current_user, 'offer_conditions', 'SELECT, INSERT')
        as condition_append,
      has_table_privilege(current_user, 'source_permissions', 'SELECT')
        as source_permission_table_select,
      has_column_privilege(current_user, 'source_permissions', 'permissions', 'SELECT')
        as source_permission_column_select,
      has_column_privilege(current_user, 'source_permissions', 'private_reference_key', 'SELECT')
        as source_permission_private_select,
      has_table_privilege(current_user, 'price_cache', 'SELECT')
        as public_cache_select,
      has_sequence_privilege(current_user, 'review_actions_id_seq', 'USAGE')
        as review_sequence_usage,
      has_sequence_privilege(current_user, 'canonical_products_id_seq', 'USAGE')
        as unrelated_sequence_usage,
      has_function_privilege(current_user, 'reject_append_only_mutation()', 'EXECUTE')
        as guard_execute,
      has_function_privilege(
        current_user,
        'private_review_decide_v1(bigint,integer,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamptz,timestamptz,text[])',
        'EXECUTE'
      ) as decision_v1_execute,
      has_function_privilege(
        current_user,
        'private_review_record_evidence_render_v1(bigint,integer,text,text,text,text,text,text,text,timestamptz)',
        'EXECUTE'
      ) as evidence_render_execute,
      has_function_privilege(
        current_user,
        'private_review_decide_v2(bigint,integer,text,text,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamptz,timestamptz,text[])',
        'EXECUTE'
      ) as decision_v2_execute,
      pg_has_role(current_user, 'handleplan', 'MEMBER') as migration_role_member,
      pg_has_role(current_user, 'handleplan_app', 'MEMBER') as worker_role_member,
      pg_has_role(current_user, 'handleplan_web', 'MEMBER') as web_role_member,
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
  assert.deepEqual(reviewCapabilities, {
    role_name: reviewRole,
    database_create: false,
    database_temp: false,
    schema_create: false,
    capture_select: false,
    candidate_select: false,
    candidate_write: false,
    review_action_append: false,
    review_action_rewrite: false,
    evidence_render_table_access: false,
    evidence_consumption_table_access: false,
    offer_append: false,
    offer_rewrite: false,
    target_append: false,
    condition_append: false,
    source_permission_table_select: false,
    source_permission_column_select: false,
    source_permission_private_select: false,
    public_cache_select: false,
    review_sequence_usage: false,
    unrelated_sequence_usage: false,
    guard_execute: false,
    decision_v1_execute: false,
    evidence_render_execute: true,
    decision_v2_execute: true,
    migration_role_member: false,
    worker_role_member: false,
    web_role_member: false,
    owned_relations: 0,
    elevated_role: false,
  });
  for (const table of [
    "approved_offers",
    "canonical_products",
    "extracted_offer_candidates",
    "extraction_runs",
    "geographic_scopes",
    "offer_conditions",
    "offer_targets",
    "private_review_evidence_consumptions",
    "private_review_evidence_renders",
    "product_families",
    "product_identifiers",
    "publication_captures",
    "publications",
    "review_actions",
    "source_permissions",
  ]) {
    await expectDenied(
      () => review.unsafe(`select * from ${table} limit 0`),
      "review role must not bypass the bounded eligibility function with direct SELECT",
    );
  }
  const eligibleReviewRows = await review`
    select candidate_id
    from public.private_review_candidate_rows_v1(
      ${reviewBoundaryCandidateId}::bigint, clock_timestamp(),
      ${null}::text, ${null}::text, ${null}::integer, ${null}::integer,
      ${null}::integer, ${null}::integer, ${null}::text,
      ${null}::timestamptz, ${null}::bigint, 1::integer
    )
  `;
  assert.deepEqual(
    eligibleReviewRows.map(({ candidate_id: candidateId }) => Number(candidateId)),
    [Number(reviewBoundaryCandidateId)],
    "review role may inspect only a bounded rights-current candidate projection",
  );
  await expectDenied(
    () => review`select private_reference_key, notes from source_permissions limit 1`,
    "review role must not read private permission notes or source references",
  );
  await expectDenied(
    () => review`select ean from price_cache limit 1`,
    "review role must not read unrelated public price-cache state",
  );
  const directPublishedOfferKey = "review-proof:direct-published";
  await expectDenied(
    () => review`
      insert into approved_offers (
        offer_key, candidate_id, source_id, source_reference, chain,
        geographic_scope_id, amount_ore, valid_from, valid_until,
        status, approved_at
      ) values (
        ${directPublishedOfferKey}, 1, 'kassalapp', 'review-proof:forbidden',
        'extra', 1, 1, now(), now() + interval '1 day', 'published', now()
      )
    `,
    "review role must not insert approved offers directly",
  );
  const candidateLessOfferKey = "review-proof:candidate-less";
  await expectDenied(
    () => review`
      insert into approved_offers (
        offer_key, candidate_id, source_id, source_reference, chain,
        geographic_scope_id, amount_ore, valid_from, valid_until,
        status, approved_at
      ) values (
        ${candidateLessOfferKey}, null, 'kassalapp', 'review-proof:forbidden',
        'extra', 1, 1, now(), now() + interval '1 day', 'approved', now()
      )
    `,
    "review role must not create an offer without the decision function",
  );
  await expectDenied(
    () => review`
      update approved_offers set status = 'published' where false
    `,
    "review role must not update an approved offer into public state",
  );
  const [reviewEvidenceRender] = await review`
    select *
    from public.private_review_record_evidence_render_v1(
      ${reviewBoundaryCandidateId}::bigint,
      0::integer,
      ${reviewCaptureChecksum}::text,
      ${evidenceCropReference(reviewBoundaryCandidateId)}::text,
      'full_capture'::text,
      'private_review'::text,
      ${reviewActorId}::text,
      ${reviewSessionId}::text,
      ${reviewEvidenceProof}::text,
      date_trunc('milliseconds', clock_timestamp() + interval '120 seconds')
    )
  `;
  assert.ok(
    Number(reviewEvidenceRender?.evidence_render_id) > 0
      && reviewEvidenceRender.rendered_at instanceof Date
      && reviewEvidenceRender.expires_at instanceof Date
      && reviewEvidenceRender.expires_at > reviewEvidenceRender.rendered_at,
    "review role may record only a short-lived candidate-bound evidence proof",
  );
  await assert.rejects(
    () => review`
      select *
      from public.private_review_decide_v2(
        ${reviewBoundaryCandidateId}::bigint,
        0::integer,
        'approve'::text,
        ${reviewActorId}::text,
        ${reviewSessionId}::text,
        ${reviewEvidenceProof}::text,
        'Malformed multidimensional channel proof.'::text,
        'exact-product'::text,
        '7038010000010'::text,
        ${null}::text,
        'unit'::text,
        2790::integer,
        3990::integer,
        ${null}::integer,
        ${null}::integer,
        'public'::text,
        ${null}::text,
        ${reviewBoundaryValidFrom}::timestamptz,
        ${reviewBoundaryValidUntil}::timestamptz,
        array[array['in-store'::text]]::text[]
      )
    `,
    /HP_REVIEW_INVALID_DECISION_REQUEST/,
    "decision boundary must reject multidimensional channel arrays",
  );
  await assert.rejects(
    () => review`
      select *
      from public.private_review_decide_v2(
        ${reviewBoundaryCandidateId}::bigint,
        0::integer,
        'approve'::text,
        ${reviewActorId}::text,
        ${reviewSessionId}::text,
        ${reviewEvidenceProof}::text,
        'Oversized channel array proof.'::text,
        'exact-product'::text,
        '7038010000010'::text,
        ${null}::text,
        'unit'::text,
        2790::integer,
        3990::integer,
        ${null}::integer,
        ${null}::integer,
        'public'::text,
        ${null}::text,
        ${reviewBoundaryValidFrom}::timestamptz,
        ${reviewBoundaryValidUntil}::timestamptz,
        pg_catalog.array_fill('in-store'::text, array[10000])
      )
    `,
    /HP_REVIEW_INVALID_DECISION_REQUEST/,
    "decision boundary must reject oversized channel arrays before unnesting",
  );
  for (const malformedMembershipProgramId of [
    "",
    "e\u0301",
    "member\u200Bprogram",
    "\u00A0member-program",
    "😀".repeat(101),
    "x".repeat(10_000),
  ]) {
    await assert.rejects(
      () => review`
        select *
        from public.private_review_decide_v2(
          ${reviewBoundaryCandidateId}::bigint,
          0::integer,
          'approve'::text,
          ${reviewActorId}::text,
          ${reviewSessionId}::text,
          ${reviewEvidenceProof}::text,
          'Malformed membership identity proof.'::text,
          'exact-product'::text,
          '7038010000010'::text,
          ${null}::text,
          'unit'::text,
          2790::integer,
          3990::integer,
          ${null}::integer,
          ${null}::integer,
          'member'::text,
          ${malformedMembershipProgramId}::text,
          ${reviewBoundaryValidFrom}::timestamptz,
          ${reviewBoundaryValidUntil}::timestamptz,
          ${review.array(["in-store"])}::text[]
        )
      `,
      /HP_REVIEW_INVALID_DECISION_REQUEST/,
      "decision boundary must reject non-canonical membership program IDs",
    );
  }
  await assert.rejects(
    () => review`
      select *
      from public.private_review_decide_v2(
        ${reviewBoundaryCandidateId}::bigint,
        0::integer,
        'approve'::text,
        ${reviewActorId}::text,
        ${reviewSessionId}::text,
        ${"f".repeat(64)}::text,
        'Forged approval without renderable evidence.'::text,
        'exact-product'::text,
        '7038010000010'::text,
        ${null}::text,
        'unit'::text,
        2790::integer,
        3990::integer,
        ${null}::integer,
        ${null}::integer,
        'public'::text,
        ${null}::text,
        ${reviewBoundaryValidFrom}::timestamptz,
        ${reviewBoundaryValidUntil}::timestamptz,
        ${review.array(["in-store"])}::text[]
      )
    `,
    /HP_REVIEW_EVIDENCE_UNAVAILABLE/,
    "forged exact approval must be rejected by the decision boundary",
  );
  const candidateAfterFailedApproval = await review`
    select candidate_id
    from public.private_review_candidate_rows_v1(
      ${reviewBoundaryCandidateId}::bigint, clock_timestamp(),
      ${null}::text, ${null}::text, ${null}::integer, ${null}::integer,
      ${null}::integer, ${null}::integer, ${null}::text,
      ${null}::timestamptz, ${null}::bigint, 1::integer
    )
  `;
  assert.equal(
    Number(candidateAfterFailedApproval[0]?.candidate_id),
    Number(reviewBoundaryCandidateId),
    "failed evidence attestation must leave the candidate undecided",
  );
  const [reviewRejection] = await review`
    select *
    from public.private_review_decide_v2(
      ${reviewBoundaryCandidateId}::bigint,
      0::integer,
      'reject'::text,
      ${reviewActorId}::text,
      ${reviewSessionId}::text,
      ${null}::text,
      'Opaque evidence cannot support approval.'::text,
      ${null}::text, ${null}::text, ${null}::text, ${null}::text,
      ${null}::integer, ${null}::integer, ${null}::integer, ${null}::integer,
      ${null}::text, ${null}::text, ${null}::timestamptz,
      ${null}::timestamptz, ${null}::text[]
    )
  `;
  assert.deepEqual(
    {
      actionId: Number(reviewRejection?.action_id),
      newVersion: reviewRejection?.new_version,
      offerId: reviewRejection?.offer_id,
      state: reviewRejection?.review_state,
    },
    { actionId: Number(reviewRejection?.action_id), newVersion: 1, offerId: null, state: "rejected" },
    "the exact decision function may append a rejection without an offer",
  );
  assert.ok(Number(reviewRejection?.action_id) > 0, "review rejection must return an action ID");
  const decisionAuditAdmin = postgres(urlForDatabase(proofDatabase), {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
  });
  try {
    const [decisionAudit] = await decisionAuditAdmin`
      select acted_at, created_at
      from review_actions
      where id = ${reviewRejection.action_id}
    `;
    assert.ok(
      decisionAudit?.created_at instanceof Date
        && decisionAudit.acted_at instanceof Date
        && decisionAudit.created_at >= decisionAudit.acted_at,
      "review action creation clock must be stamped after decision locks",
    );
  } finally {
    await decisionAuditAdmin.end({ timeout: 5 });
  }
  const candidateAfterRejection = await review`
    select candidate_id
    from public.private_review_candidate_rows_v1(
      ${reviewBoundaryCandidateId}::bigint, clock_timestamp(),
      ${null}::text, ${null}::text, ${null}::integer, ${null}::integer,
      ${null}::integer, ${null}::integer, ${null}::text,
      ${null}::timestamptz, ${null}::bigint, 1::integer
    )
  `;
  assert.deepEqual(
    [...candidateAfterRejection],
    [],
    "the central eligibility reader must hide a terminally reviewed candidate",
  );
  await expectDenied(
    () => review`
      insert into extracted_offer_candidates (
        extraction_run_id, candidate_key, normalized_fields, confidence
      ) values (1, 'review-forgery', '{}'::jsonb, 100)
    `,
    "review role must not fabricate extracted candidate evidence",
  );
  await expectDenied(
    () => review`
      update extracted_offer_candidates set confidence = 0 where false
    `,
    "review role must not update extracted candidate evidence",
  );
  await expectDenied(
    () => review`delete from extracted_offer_candidates where false`,
    "review role must not delete extracted candidate evidence",
  );
  await expectDenied(
    () => review`
      update review_actions set reason = 'rewrite' where false
    `,
    "review role must not rewrite review actions",
  );
  await expectDenied(
    () => review`delete from review_actions where false`,
    "review role must not delete review actions",
  );
  await expectDenied(
    () => review`
      insert into review_actions (
        candidate_id, actor_id, action, expected_version, reason, acted_at
      ) values (
        ${reviewBoundaryCandidateId}, ${`access:${"e".repeat(64)}`},
        'reject', 0, 'direct review action forgery', now()
      )
    `,
    "review role must not insert review actions directly",
  );
  await expectDenied(
    () => review`
      insert into offer_targets (
        offer_id, family_slug, match_method, match_confidence
      ) values (1, 'melk', 'human_review', 100)
    `,
    "review role must not insert offer targets directly",
  );
  await expectDenied(
    () => review`
      insert into offer_conditions (offer_id, condition_type, condition_value)
      values (1, 'channel', '{"channels":["in-store"]}'::jsonb)
    `,
    "review role must not insert offer conditions directly",
  );
  for (const sequence of [
    "approved_offers_id_seq",
    "offer_conditions_id_seq",
    "review_actions_id_seq",
  ]) {
    await expectDenied(
      () => review.unsafe(`select nextval('${sequence}')`),
      "review role must not use review sequences directly",
    );
  }
  await expectDenied(
    () => review`
      insert into publications (
        source_id, external_id, chain, title, valid_from, valid_until,
        geographic_scope_id, discovered_at
      ) values (
        'kassalapp', 'review-forgery', 'extra', 'forgery', now(),
        now() + interval '1 day', 1, now()
      )
    `,
    "review role must not fabricate publication evidence",
  );
  await expectDenied(
    () => review.unsafe("create table review_role_escape (id integer)"),
    "review role must not perform schema DDL",
  );
  await expectDenied(
    () => review.unsafe("select reject_append_only_mutation()"),
    "review role must not invoke non-allowlisted functions",
  );
  await expectDenied(
    () => review.unsafe("set role handleplan"),
    "review role must not assume the migration owner",
  );

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
    source_health_append: true,
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
  await runtime`
    insert into source_health_snapshots (
      worker_job_id,
      source_id,
      status,
      review_queue_count,
      oldest_review_age_seconds,
      details,
      recorded_at
    ) values (
      ${workerJobId},
      'kassalapp',
      'failed',
      0,
      null,
      '{}'::jsonb,
      '2026-07-16T12:00:02Z'
    )
  `;
  const workerHealthRows = await runtime`
    select status, details, review_queue_count
    from source_health_snapshots
    where worker_job_id = ${workerJobId}
  `;
  assert.deepEqual([...workerHealthRows], [{
    details: {},
    review_queue_count: 0,
    status: "failed",
  }]);
  const unsafeHealthJobId =
    "runtime-role-proof:catalog-refresh:2026-07-16T12:10:00.000Z";
  await runtime`
    insert into worker_job_results (
      job_id, source_id, job_kind, scheduled_at, run_id, status,
      started_at, completed_at, counts, result_hash
    ) values (
      ${unsafeHealthJobId}, 'kassalapp', 'catalog-refresh',
      '2026-07-16T12:10:00Z', 'runtime-role-proof-unsafe-health', 'failed',
      '2026-07-16T12:10:01Z', '2026-07-16T12:10:02Z',
      '{"accepted":0,"failed":1,"fetched":0,"persisted":0,"quarantined":0,"unknown":0}'::jsonb,
      ${"e".repeat(64)}
    )
  `;
  await assert.rejects(
    runtime`
      insert into source_health_snapshots (
        worker_job_id, source_id, status, last_discovery_success_at,
        last_capture_success_at, details, recorded_at
      ) values (
        ${unsafeHealthJobId}, 'kassalapp', 'failed',
        '2026-07-16T12:10:02Z', '2026-07-16T12:10:02Z', '{}'::jsonb,
        '2026-07-16T12:10:02Z'
      )
    `,
    /success must match deterministic job progress/i,
    "worker source health must reject invented discovery or capture success",
  );
  await assert.rejects(
    runtime`
      insert into source_health_snapshots (
        worker_job_id, source_id, status, details, recorded_at
      ) values (
        ${unsafeHealthJobId}, 'kassalapp', 'failed',
        '{"requestUrl":"https://provider.invalid/private"}'::jsonb,
        '2026-07-16T12:10:02Z'
      )
    `,
    /source_health_snapshots_worker_payload_allowlist|violates check constraint/i,
    "worker source health must reject non-allowlisted details",
  );
  await expectDenied(
    () => runtime`
      update source_health_snapshots
      set status = 'healthy'
      where worker_job_id = ${workerJobId}
    `,
    "runtime role must not rewrite source health",
  );
  await expectDenied(
    () => runtime`
      delete from source_health_snapshots where worker_job_id = ${workerJobId}
    `,
    "runtime role must not delete source health",
  );
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
  await assert.rejects(
    () => runtime`
      update ingestion_runs
      set status = 'completed',
          completed_at = now(),
          terminalized_at = '2000-01-01T00:00:00Z'
      where id = ${ingestionRun.id}
    `,
    "runtime role must not forge the database terminalization clock",
  );
  await assert.rejects(
    runtime`
      update ingestion_runs
      set status = 'completed',
          completed_at = clock_timestamp() + interval '1 minute'
      where id = ${ingestionRun.id}
    `,
    /completion cannot be in the future/i,
    "runtime role must not terminalize an ingestion run in the future",
  );
  const [stillRunningAfterFutureCompletion] = await runtime`
    select status, completed_at, terminalized_at
    from ingestion_runs
    where id = ${ingestionRun.id}
  `;
  assert.deepEqual(
    stillRunningAfterFutureCompletion,
    { completed_at: null, status: "running", terminalized_at: null },
    "rejected future completion must leave the run atomically running",
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
  const catalogCategoryPath = [
    { sourceCategoryId: "10", depth: 0, name: "Mat og drikke" },
    { sourceCategoryId: "20", depth: 1, name: "Meieriprodukter" },
  ];
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
      category_path,
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
      ${runtime.json(catalogCategoryPath)},
      '2000-01-01T00:00:00Z'
    )
    returning id, category_path, created_at
  `;
  assert.notEqual(
    catalogObservation.created_at.toISOString(),
    "2000-01-01T00:00:00.000Z",
  );
  assert.deepEqual(catalogObservation.category_path, catalogCategoryPath);
  const catalogRows = await runtime`
    select category_path, display_name, source_updated_at, retrieved_at
    from catalog_observations
    where id = ${catalogObservation.id}
  `;
  assert.equal(catalogRows[0]?.display_name, "Runtime observed catalog payload");
  assert.deepEqual(catalogRows[0]?.category_path, catalogCategoryPath);
  assert.ok(catalogRows[0]?.source_updated_at < catalogRows[0]?.retrieved_at);
  await assert.rejects(
    runtime`
      insert into catalog_observations (
        ingestion_run_id, source_record_id, canonical_product_id, gtin,
        display_name, package_amount, package_unit, units_per_pack,
        retrieved_at, raw_record_hash, category_path
      ) values (
        ${ingestionRun.id}, 'runtime-role-proof-invalid-category', ${product.id},
        '7038010000010', 'Invalid category payload', 1, 'package', 1, now(),
        ${"b".repeat(64)},
        ${runtime.json([
          { sourceCategoryId: "20", depth: 0, name: "Meieri" },
          { sourceCategoryId: "10", depth: 0, name: "Mat" },
        ])}
      )
    `,
    /category path order is invalid/i,
    "runtime role must not insert a noncanonical category path",
  );
  const [invalidCategoryObservation] = await runtime`
    select count(*)::integer as count
    from catalog_observations
    where ingestion_run_id = ${ingestionRun.id}
      and source_record_id = 'runtime-role-proof-invalid-category'
  `;
  assert.equal(
    invalidCategoryObservation.count,
    0,
    "a rejected runtime category insert must leave no evidence row",
  );
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
      has_table_privilege(current_user, 'geographic_scopes', 'SELECT')
        as scope_table_select,
      has_column_privilege(current_user, 'geographic_scopes', 'id', 'SELECT')
        as scope_public_id_select,
      has_column_privilege(current_user, 'geographic_scopes', 'scope_key', 'SELECT')
        as scope_key_private_select,
      has_table_privilege(current_user, 'physical_store_branches_public', 'SELECT')
        as branch_public_select,
      has_table_privilege(current_user, 'physical_store_coverage_checks', 'SELECT')
        as branch_coverage_select,
      has_table_privilege(current_user, 'physical_store_observations', 'SELECT')
        as branch_observation_private_select,
      has_table_privilege(current_user, 'physical_stores', 'SELECT')
        as branch_projection_private_select,
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
      has_table_privilege(
        current_user,
        'public_api_request_budget_events',
        'SELECT, INSERT, UPDATE, DELETE'
      ) as public_api_budget_table_access,
      has_function_privilege(
        current_user,
        'claim_public_api_request_budget(text)',
        'EXECUTE'
      ) as public_api_budget_execute,
      has_function_privilege(
        current_user,
        'public_official_offer_rows_v1(bigint[], timestamp with time zone)',
        'EXECUTE'
      ) as public_official_offer_execute,
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
    scope_table_select: false,
    scope_public_id_select: true,
    scope_key_private_select: false,
    branch_public_select: true,
    branch_coverage_select: true,
    branch_observation_private_select: false,
    branch_projection_private_select: false,
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
    public_api_budget_table_access: false,
    public_api_budget_execute: true,
    public_official_offer_execute: true,
    sequence_usage: false,
    guard_execute: false,
    migration_role_member: false,
    worker_role_member: false,
    owned_relations: 0,
    elevated_role: false,
  });

  const webMigrations = await web`
    select id from handleplan_schema_migrations where id = '022_public_official_offer_projection.sql'
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
    select category_path, display_name, gtin, retrieved_at, source_updated_at
    from catalog_observations
    where id = ${catalogObservation.id}
  `;
  assert.equal(webCatalogEvidence[0]?.display_name, "Runtime observed catalog payload");
  assert.equal(webCatalogEvidence[0]?.gtin, "7038010000010");
  assert.deepEqual(webCatalogEvidence[0]?.category_path, catalogCategoryPath);
  await web`
    select source_id, permissions
    from source_permissions
    order by reviewed_at desc, id desc
    limit 1
  `;
  await web`
    select id, scope_kind, label, country_code, status, created_at, public_state_changed_at
    from geographic_scopes
    limit 0
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
  await web`
    select branch_id, chain, name, latitude, longitude
    from physical_store_branches_public
    limit 0
  `;
  const branchPublicColumns = await web`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'physical_store_branches_public'
    order by ordinal_position
  `;
  assert.deepEqual(
    branchPublicColumns.map(({ column_name: column }) => column),
    ["branch_id", "chain", "name", "latitude", "longitude"],
    "web branch view must expose only active public routing fields",
  );
  await web`
    select ingestion_run_id, source_id, chain, state, reason, record_count, checked_at, created_at
    from physical_store_coverage_checks
    limit 0
  `;

  await expectDenied(
    () => web`select private_reference_key from source_permissions limit 1`,
    "web role must not read private source references",
  );
  await expectDenied(
    () => web`select scope_key from geographic_scopes limit 1`,
    "web role must not read private geographic scope keys",
  );
  await expectDenied(
    () => web`select job_id, error_class, counts from ingestion_runs limit 1`,
    "web role must not read private ingestion diagnostics or aggregate counters",
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
    () => web`select address_line, postal_code, municipality_code from physical_stores limit 1`,
    "web role must not read private physical stores",
  );
  await expectDenied(
    () => web`select external_id from physical_store_observations limit 1`,
    "web role must not read private physical-store observations",
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
  for (const table of [
    "approved_offers",
    "extraction_runs",
    "offer_conditions",
    "offer_targets",
    "publications",
    "review_actions",
  ]) {
    await expectDenied(
      () => web.unsafe(`select * from ${table} limit 0`),
      "web role must not bypass the bounded official-offer projection",
    );
  }
  const publicOfficialOffers = await web`
    select offer_id
    from public.public_official_offer_rows_v1(
      ${web.array([product.id])}::bigint[],
      clock_timestamp()
    )
  `;
  assert.deepEqual(
    [...publicOfficialOffers],
    [],
    "inactive official-offer sources must project no public rows",
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
    () => web`select route_key from public_api_request_budget_events limit 1`,
    "web role must not read public API request-budget state directly",
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
    () => web`
      insert into public_api_request_budget_events (route_key)
      values ('plans')
    `,
    "web role must not write public API request-budget state directly",
  );
  const [publicApiBudgetDecision] = await web`
    select admitted, retry_after_seconds
    from claim_public_api_request_budget('plans')
  `;
  assert.deepEqual(
    publicApiBudgetDecision,
    { admitted: true, retry_after_seconds: 0 },
    "web role may claim only through the fixed-policy coordinator",
  );
  await expectDenied(
    () => web`select nextval('canonical_products_id_seq')`,
    "web role must not use sequences",
  );
  await expectDenied(
    () => web.unsafe("select reject_append_only_mutation()"),
    "web role must not execute non-allowlisted database functions",
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
  await assert.rejects(
    runtime`
      insert into source_health_snapshots (source_id, status, details, recorded_at)
      values ('kassalapp', 'healthy', '{}'::jsonb, now())
    `,
    /terminal worker job identity/i,
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
      set category_path = '[]'::jsonb
      where id = ${catalogObservation.id}
    `,
    "runtime role must not update append-only catalog category evidence",
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

  const operationsRows = await operations`
    select *
    from public.operations_dashboard_rows_v1(
      ${operations.array(["kassalapp"])}::text[],
      1::integer
    )
  `;
  assert.equal(
    operationsRows.length,
    1,
    "the operations boundary must return exactly the requested fixture roster",
  );
  const [operationsRow] = operationsRows;
  assert.deepEqual(
    Object.keys(operationsRow).sort(),
    [
      "active_published_offer_rows",
      "expired_published_offer_rows",
      "expiring_published_offer_rows",
      "governance_state",
      "health_persisted_at",
      "health_recorded_at",
      "health_state",
      "health_worker_job_kind",
      "last_capture_success_at",
      "last_discovery_success_at",
      "last_publish_success_at",
      "latest_extraction_candidate_rows",
      "latest_extraction_completed_at",
      "latest_extraction_empty_result",
      "latest_extraction_state",
      "latest_worker_results",
      "newest_eligible_evidence_at",
      "newest_ordinary_price_at",
      "non_successful_worker_results_24h",
      "observed_at",
      "pending_review_rows",
      "source_id",
      "worker_results_24h",
    ].sort(),
    "operations output must stay on the exact aggregate-only contract",
  );
  assert.equal(operationsRow.source_id, "kassalapp");
  assert.equal(operationsRow.health_state, "failed");
  assert.equal(operationsRow.health_worker_job_kind, "catalog-refresh");
  assert.equal(Number(operationsRow.worker_results_24h), 2);
  assert.equal(Number(operationsRow.non_successful_worker_results_24h), 2);
  assert.equal(Number(operationsRow.pending_review_rows), 0);
  assert.ok(operationsRow.observed_at instanceof Date);
  assert.ok(Array.isArray(operationsRow.latest_worker_results));
  for (const latestResult of operationsRow.latest_worker_results) {
    assert.deepEqual(
      Object.keys(latestResult).sort(),
      ["completedAt", "jobKind", "persistedAt", "status"].sort(),
      "operations worker evidence must omit job IDs, counters, errors, and raw payloads",
    );
  }
  await assert.rejects(
    operations`
      select *
      from public.operations_dashboard_rows_v1(
        ${operations.array(["kassalapp", "kassalapp"])}::text[],
        2::integer
      )
    `,
    /invalid operations source roster/i,
    "the operations boundary must reject duplicate source rosters",
  );

  const survivingRows = await runtime`
    select count(*)::integer as count from price_observations where id = ${observation.id}
  `;
  assert.equal(survivingRows[0]?.count, 1, "protected proof row must survive bypass attempts");

  proofResult = {
    database: proofDatabase,
    workerRole,
    webRole,
    reviewRole,
    operationsRole,
    ownershipFailClosed: true,
    cacheAndWorkerWrites: true,
    requestBudgetCoordination: true,
    webPublicReads: true,
    webPrivateReadsDenied: true,
    webWritesDenied: true,
    privateReviewReads: true,
    privateReviewDecisionFunctionOnly: true,
    privateReviewEvidenceApprovalFailClosed: true,
    privateReviewUnrelatedAccessDenied: true,
    privateReviewDirectPublicationDenied: true,
    privateOperationsAggregateOnly: true,
    privateOperationsDirectAccessDenied: true,
    protectedInsertRead: true,
    catalogObservationInsertRead: true,
    reviewedFamilyPublicProjection: true,
    reviewedFamilyPrivateReviewerDenied: true,
    reviewedFamilyWorkerAccessDenied: true,
    sealedGeographicDirectory: true,
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

  if (review) {
    await attemptCleanup("close review connection", () => review.end({ timeout: 5 }));
  }
  if (operations) {
    await attemptCleanup("close operations connection", () => operations.end({ timeout: 5 }));
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
