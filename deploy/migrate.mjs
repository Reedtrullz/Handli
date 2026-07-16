import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

const databaseMigrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!databaseMigrationUrl) {
  throw new Error("DATABASE_MIGRATION_URL is required for migrations");
}

const appDatabasePassword = process.env.APP_DATABASE_PASSWORD;
if (!appDatabasePassword) {
  throw new Error("APP_DATABASE_PASSWORD is required for migrations");
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(appDatabasePassword)) {
  throw new Error(
    "APP_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
  );
}

const webDatabasePassword = process.env.WEB_DATABASE_PASSWORD;
if (!webDatabasePassword) {
  throw new Error("WEB_DATABASE_PASSWORD is required for migrations");
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(webDatabasePassword)) {
  throw new Error(
    "WEB_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
  );
}

let parsedMigrationUrl;
try {
  parsedMigrationUrl = new URL(databaseMigrationUrl);
} catch {
  throw new Error("DATABASE_MIGRATION_URL must be a valid PostgreSQL URL");
}
if (!["postgres:", "postgresql:"].includes(parsedMigrationUrl.protocol)) {
  throw new Error("DATABASE_MIGRATION_URL must use PostgreSQL");
}

const workerRole = "handleplan_app";
const webRole = "handleplan_web";
const migrationRole = decodeURIComponent(parsedMigrationUrl.username);
const migrationPassword = decodeURIComponent(parsedMigrationUrl.password);
const databaseName = decodeURIComponent(parsedMigrationUrl.pathname.slice(1));
if (
  !/^[a-z][a-z0-9_]{0,62}$/.test(migrationRole)
  || migrationRole === workerRole
  || migrationRole === webRole
) {
  throw new Error(
    "Migrations require a simple database owner distinct from handleplan_app and handleplan_web",
  );
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(migrationPassword)) {
  throw new Error(
    "DATABASE_MIGRATION_URL must contain a 32-128 character URL-safe password",
  );
}
if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
  throw new Error("DATABASE_MIGRATION_URL must name a simple PostgreSQL database");
}
if (migrationPassword && migrationPassword === appDatabasePassword) {
  throw new Error("Migration and worker database credentials must differ");
}
if (migrationPassword && migrationPassword === webDatabasePassword) {
  throw new Error("Migration and web database credentials must differ");
}
if (appDatabasePassword === webDatabasePassword) {
  throw new Error("Worker and web database credentials must differ");
}

const migrationsDirectory = path.resolve(
  process.env.MIGRATIONS_DIR ?? "/app/deploy/migrations",
);
const ciMaxMigrationId = process.env.CI_MAX_MIGRATION_ID;

if (ciMaxMigrationId !== undefined) {
  if (process.env.CI !== "true") {
    throw new Error("CI_MAX_MIGRATION_ID is only allowed when CI=true");
  }
  if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(ciMaxMigrationId)) {
    throw new Error(
      "CI_MAX_MIGRATION_ID must be an exact migration filename",
    );
  }
}

const repositoryMigrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
  .sort();

if (
  ciMaxMigrationId !== undefined
  && !repositoryMigrationFiles.includes(ciMaxMigrationId)
) {
  throw new Error(
    "CI_MAX_MIGRATION_ID does not identify a repository migration",
  );
}

const migrationFiles = ciMaxMigrationId === undefined
  ? repositoryMigrationFiles
  : repositoryMigrationFiles.filter((file) => file <= ciMaxMigrationId);

const sql = postgres(databaseMigrationUrl, {
  connect_timeout: 10,
  idle_timeout: 5,
  max: 1,
  onnotice: () => {},
});

const advisoryLockId = 7_229_164_301;

const protectedAppendOnlyTables = [
  "catalog_observations",
  "price_observations",
  "price_coverage_checks",
  "source_record_outcomes",
  "worker_job_results",
];

const workerReadOnlyTables = [
  "handleplan_schema_migrations",
  "data_sources",
  "source_permissions",
  "geographic_scopes",
];

const insertUpdateTables = [
  "price_cache",
  "canonical_products",
  "product_identifiers",
  "source_products",
  "ingestion_runs",
  "physical_stores",
];

const replaceableTables = ["worker_leases"];

const ephemeralRequestBudgetTables = ["provider_request_budget_events"];

const runtimeSequences = [
  "catalog_observations_id_seq",
  "canonical_products_id_seq",
  "product_identifiers_id_seq",
  "ingestion_runs_id_seq",
  "price_observations_id_seq",
  "price_coverage_checks_id_seq",
  "physical_stores_id_seq",
  "source_record_outcomes_id_seq",
  "worker_job_results_id_seq",
];

const webReadOnlyTables = [
  "catalog_observations",
  "handleplan_schema_migrations",
  "price_cache",
  "canonical_products",
  "product_identifiers",
  "geographic_scopes",
  "physical_stores",
  "geographic_scope_regions",
  "geographic_scope_stores",
  "ingestion_runs",
  "price_observations",
  "price_coverage_checks",
];

const webDataSourceColumns = [
  "id",
  "display_name",
  "source_kind",
  "runtime_state",
  "public_reference_url",
  "permission_reviewed_at",
  "permission_expires_at",
  "created_at",
  "updated_at",
];

const webSourcePermissionColumns = [
  "id",
  "source_id",
  "decision",
  "reviewed_at",
  "valid_until",
  "permissions",
  "created_at",
];

const webSourceProductColumns = [
  "source_id",
  "external_id",
  "canonical_product_id",
  "raw_record_hash",
  "match_state",
  "first_seen_at",
  "last_seen_at",
];

const webSourceHealthColumns = [
  "id",
  "source_id",
  "geographic_scope_id",
  "status",
  "last_discovery_success_at",
  "last_capture_success_at",
  "last_publish_success_at",
  "newest_eligible_evidence_at",
  "recorded_at",
];

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function identifiers(values) {
  return values.map(identifier).join(", ");
}

async function revokeRoleMemberships(transaction, role) {
  const memberships = await transaction`
    select granted.rolname as granted_role, member.rolname as member_role
    from pg_auth_members membership
    join pg_roles member on member.oid = membership.member
    join pg_roles granted on granted.oid = membership.roleid
    where member.rolname = ${role} or granted.rolname = ${role}
    order by granted.rolname, member.rolname
  `;
  for (const membership of memberships) {
    await transaction.unsafe(
      `revoke ${identifier(membership.granted_role)} from ${identifier(membership.member_role)}`,
    );
  }
}

async function configureRuntimeRoles() {
  await sql.begin(async (transaction) => {
    const [{ current_user: currentUser, current_database: currentDatabase }] =
      await transaction`
        select current_user, current_database()
      `;
    if (currentUser !== migrationRole || currentDatabase !== databaseName) {
      throw new Error("DATABASE_MIGRATION_URL identity changed after connection");
    }

    await transaction`
      select set_config(
        'handleplan.worker_role_bootstrap_password',
        ${appDatabasePassword},
        true
      )
    `;
    await transaction`
      select set_config(
        'handleplan.web_role_bootstrap_password',
        ${webDatabasePassword},
        true
      )
    `;
    await transaction.unsafe(`
      do $runtime_roles$
      begin
        if exists (select 1 from pg_roles where rolname = '${workerRole}') then
          execute format(
            'alter role ${workerRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.worker_role_bootstrap_password')
          );
        else
          execute format(
            'create role ${workerRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.worker_role_bootstrap_password')
          );
        end if;
        if exists (select 1 from pg_roles where rolname = '${webRole}') then
          execute format(
            'alter role ${webRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.web_role_bootstrap_password')
          );
        else
          execute format(
            'create role ${webRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.web_role_bootstrap_password')
          );
        end if;
      end
      $runtime_roles$;
    `);

    await revokeRoleMemberships(transaction, workerRole);
    await revokeRoleMemberships(transaction, webRole);

    const ownership = await transaction`
      select
        role.rolname,
        (
          select count(*)::integer
          from pg_database
          where datname = current_database()
            and datdba = role.oid
        ) as databases,
        (
          select count(*)::integer
          from pg_namespace
          where nspowner = role.oid
        ) as schemas,
        (
          select count(*)::integer
          from pg_class
          where relowner = role.oid
        ) as relations,
        (
          select count(*)::integer
          from pg_proc
          where proowner = role.oid
        ) as functions
      from pg_roles role
      where role.rolname in (${workerRole}, ${webRole})
      order by role.rolname
    `;
    if (
      ownership.length !== 2
      || ownership.some(({ rolname: _role, ...counts }) =>
        Object.values(counts).some((count) => count !== 0))
    ) {
      throw new Error("Runtime roles must not own database objects");
    }

    await transaction.unsafe(`
      revoke all privileges on database "${databaseName}" from public;
      revoke all privileges on database "${databaseName}" from ${workerRole}, ${webRole};
      grant connect on database "${databaseName}" to ${workerRole}, ${webRole};

      revoke all privileges on schema public from public;
      revoke all privileges on schema public from ${workerRole}, ${webRole};
      grant usage on schema public to ${workerRole}, ${webRole};

      revoke all privileges on all tables in schema public from public, ${workerRole}, ${webRole};
      revoke all privileges on all sequences in schema public from public, ${workerRole}, ${webRole};
      revoke all privileges on all functions in schema public from public, ${workerRole}, ${webRole};

      alter default privileges for role ${migrationRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole};
      alter default privileges for role ${migrationRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole};
      alter default privileges for role ${migrationRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole};
      alter default privileges for role ${workerRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole};
      alter default privileges for role ${workerRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole};
      alter default privileges for role ${workerRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole};
      alter default privileges for role ${webRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole};
      alter default privileges for role ${webRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole};
      alter default privileges for role ${webRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole};

      grant select on table ${identifiers(workerReadOnlyTables)}
        to ${workerRole};
      grant select, insert on table ${identifiers(protectedAppendOnlyTables)}
        to ${workerRole};
      grant select, insert, update on table ${identifiers(insertUpdateTables)}
        to ${workerRole};
      grant select, insert, update, delete on table ${identifiers(replaceableTables)}
        to ${workerRole};
      grant select, insert, delete on table ${identifiers(ephemeralRequestBudgetTables)}
        to ${workerRole};
      grant usage on sequence ${identifiers(runtimeSequences)} to ${workerRole};

      grant select on table ${identifiers(webReadOnlyTables)} to ${webRole};
      grant select on table latest_price_evidence to ${webRole};
      grant select (${identifiers(webDataSourceColumns)})
        on table data_sources to ${webRole};
      grant select (${identifiers(webSourcePermissionColumns)})
        on table source_permissions to ${webRole};
      grant select (${identifiers(webSourceProductColumns)})
        on table source_products to ${webRole};
      grant select (${identifiers(webSourceHealthColumns)})
        on table source_health_snapshots to ${webRole};
    `);

    await transaction`
      select set_config('handleplan.worker_role_bootstrap_password', '', true)
    `;
    await transaction`
      select set_config('handleplan.web_role_bootstrap_password', '', true)
    `;
  });
}

try {
  await sql`select pg_advisory_lock(${advisoryLockId})`;
  await sql`
    create table if not exists handleplan_schema_migrations (
      id varchar(255) primary key,
      checksum char(64) not null,
      applied_at timestamptz not null default now()
    )
  `;

  const appliedMigrations = await sql`
    select id from handleplan_schema_migrations order by id
  `;
  const missingMigrationIds = appliedMigrations
    .map(({ id }) => id)
    .filter((id) => !repositoryMigrationFiles.includes(id));
  if (missingMigrationIds.length > 0) {
    throw new Error(
      `Applied migration is absent from the repository: ${missingMigrationIds.join(", ")}`,
    );
  }

  for (const id of migrationFiles) {
    const source = await readFile(path.join(migrationsDirectory, id), "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const existing = await sql`
      select checksum from handleplan_schema_migrations where id = ${id}
    `;

    if (existing.length > 0) {
      if (existing[0].checksum !== checksum) {
        throw new Error(`Applied migration checksum changed: ${id}`);
      }
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`
        insert into handleplan_schema_migrations (id, checksum)
        values (${id}, ${checksum})
      `;
    });
  }

  if (ciMaxMigrationId === undefined) {
    await configureRuntimeRoles();
  }
} finally {
  await sql`select pg_advisory_unlock(${advisoryLockId})`.catch(() => undefined);
  await sql.end({ timeout: 5 });
}
