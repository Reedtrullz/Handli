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

let parsedMigrationUrl;
try {
  parsedMigrationUrl = new URL(databaseMigrationUrl);
} catch {
  throw new Error("DATABASE_MIGRATION_URL must be a valid PostgreSQL URL");
}
if (!["postgres:", "postgresql:"].includes(parsedMigrationUrl.protocol)) {
  throw new Error("DATABASE_MIGRATION_URL must use PostgreSQL");
}

const runtimeRole = "handleplan_app";
const migrationRole = decodeURIComponent(parsedMigrationUrl.username);
const migrationPassword = decodeURIComponent(parsedMigrationUrl.password);
const databaseName = decodeURIComponent(parsedMigrationUrl.pathname.slice(1));
if (!migrationRole || migrationRole === runtimeRole) {
  throw new Error("Migrations require a database owner distinct from handleplan_app");
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
  throw new Error("Migration and runtime database credentials must differ");
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
  "price_observations",
  "price_coverage_checks",
  "publication_captures",
  "review_actions",
];

const runtimeReadOnlyTables = ["data_sources", "source_permissions"];

const insertUpdateTables = [
  "price_cache",
  "canonical_products",
  "product_identifiers",
  "source_products",
  "product_families",
  "ingestion_runs",
  "geographic_scopes",
  "physical_stores",
  "publications",
  "extraction_runs",
  "extracted_offer_candidates",
  "approved_offers",
  "alert_events",
];

const replaceableTables = [
  "product_family_memberships",
  "geographic_scope_regions",
  "geographic_scope_postal_codes",
  "geographic_scope_stores",
  "offer_targets",
  "offer_conditions",
  "worker_leases",
  "historical_price_statistics",
];

const appendOnlyOperationalTables = ["source_health_snapshots"];

const ephemeralRequestBudgetTables = ["provider_request_budget_events"];

const runtimeSequences = [
  "canonical_products_id_seq",
  "product_identifiers_id_seq",
  "ingestion_runs_id_seq",
  "price_observations_id_seq",
  "price_coverage_checks_id_seq",
  "geographic_scopes_id_seq",
  "physical_stores_id_seq",
  "publications_id_seq",
  "publication_captures_id_seq",
  "extraction_runs_id_seq",
  "extracted_offer_candidates_id_seq",
  "approved_offers_id_seq",
  "offer_conditions_id_seq",
  "review_actions_id_seq",
  "source_health_snapshots_id_seq",
  "alert_events_id_seq",
];

function identifiers(values) {
  return values.map((value) => `"${value}"`).join(", ");
}

async function configureRuntimeRole() {
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
        'handleplan.runtime_role_bootstrap_password',
        ${appDatabasePassword},
        true
      )
    `;
    await transaction.unsafe(`
      do $runtime_role$
      begin
        if exists (select 1 from pg_roles where rolname = '${runtimeRole}') then
          execute format(
            'alter role ${runtimeRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.runtime_role_bootstrap_password')
          );
        else
          execute format(
            'create role ${runtimeRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.runtime_role_bootstrap_password')
          );
        end if;
      end
      $runtime_role$;
    `);

    const memberships = await transaction`
      select granted.rolname
      from pg_auth_members membership
      join pg_roles member on member.oid = membership.member
      join pg_roles granted on granted.oid = membership.roleid
      where member.rolname = ${runtimeRole}
      order by granted.rolname
    `;
    if (memberships.length > 0) {
      throw new Error(
        `handleplan_app must not inherit or assume other roles: ${memberships
          .map(({ rolname }) => rolname)
          .join(", ")}`,
      );
    }

    const [ownership] = await transaction`
      select
        (
          select count(*)::integer
          from pg_database
          where datname = current_database()
            and datdba = (select oid from pg_roles where rolname = ${runtimeRole})
        ) as databases,
        (
          select count(*)::integer
          from pg_namespace
          where nspowner = (select oid from pg_roles where rolname = ${runtimeRole})
        ) as schemas,
        (
          select count(*)::integer
          from pg_class
          where relowner = (select oid from pg_roles where rolname = ${runtimeRole})
        ) as relations,
        (
          select count(*)::integer
          from pg_proc
          where proowner = (select oid from pg_roles where rolname = ${runtimeRole})
        ) as functions
    `;
    if (Object.values(ownership).some((count) => count !== 0)) {
      throw new Error("handleplan_app must not own database objects");
    }

    await transaction.unsafe(`
      revoke create, temporary on database "${databaseName}" from public;
      revoke all privileges on database "${databaseName}" from ${runtimeRole};
      grant connect on database "${databaseName}" to ${runtimeRole};

      revoke all privileges on schema public from public;
      revoke all privileges on schema public from ${runtimeRole};
      grant usage on schema public to ${runtimeRole};

      revoke all privileges on all tables in schema public from ${runtimeRole};
      revoke all privileges on all sequences in schema public from ${runtimeRole};
      revoke all privileges on all functions in schema public from ${runtimeRole};
      revoke execute on function public.reject_append_only_mutation() from public;

      grant select on table ${identifiers(runtimeReadOnlyTables)}
        to ${runtimeRole};
      grant select, insert on table ${identifiers(protectedAppendOnlyTables)}
        to ${runtimeRole};
      grant select, insert, update on table ${identifiers(insertUpdateTables)}
        to ${runtimeRole};
      grant select, insert, update, delete on table ${identifiers(replaceableTables)}
        to ${runtimeRole};
      grant select, insert on table ${identifiers(appendOnlyOperationalTables)}
        to ${runtimeRole};
      grant select, insert, delete on table ${identifiers(ephemeralRequestBudgetTables)}
        to ${runtimeRole};
      grant select on table latest_price_evidence to ${runtimeRole};
      grant usage on sequence ${identifiers(runtimeSequences)} to ${runtimeRole};
    `);

    await transaction`
      select set_config('handleplan.runtime_role_bootstrap_password', '', true)
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
    await configureRuntimeRole();
  }
} finally {
  await sql`select pg_advisory_unlock(${advisoryLockId})`.catch(() => undefined);
  await sql.end({ timeout: 5 });
}
