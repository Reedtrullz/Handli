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

const reviewDatabasePassword = process.env.REVIEW_DATABASE_PASSWORD;
if (!reviewDatabasePassword) {
  throw new Error("REVIEW_DATABASE_PASSWORD is required for migrations");
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(reviewDatabasePassword)) {
  throw new Error(
    "REVIEW_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
  );
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(webDatabasePassword)) {
  throw new Error(
    "WEB_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
  );
}

const operationsDatabasePassword = process.env.OPERATIONS_DATABASE_PASSWORD;
if (!operationsDatabasePassword) {
  throw new Error("OPERATIONS_DATABASE_PASSWORD is required for migrations");
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(operationsDatabasePassword)) {
  throw new Error(
    "OPERATIONS_DATABASE_PASSWORD must be a 32-128 character URL-safe secret",
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
const reviewRole = "handleplan_review";
const operationsRole = "handleplan_operations";
const migrationRole = decodeURIComponent(parsedMigrationUrl.username);
const migrationPassword = decodeURIComponent(parsedMigrationUrl.password);
const databaseName = decodeURIComponent(parsedMigrationUrl.pathname.slice(1));
if (
  !/^[a-z][a-z0-9_]{0,62}$/.test(migrationRole)
  || migrationRole === workerRole
  || migrationRole === webRole
  || migrationRole === reviewRole
  || migrationRole === operationsRole
) {
  throw new Error(
    "Migrations require a simple database owner distinct from all runtime roles",
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
if (migrationPassword && migrationPassword === reviewDatabasePassword) {
  throw new Error("Migration and review database credentials must differ");
}
if (migrationPassword && migrationPassword === operationsDatabasePassword) {
  throw new Error("Migration and operations database credentials must differ");
}
if (appDatabasePassword === webDatabasePassword) {
  throw new Error("Worker and web database credentials must differ");
}
if (appDatabasePassword === reviewDatabasePassword) {
  throw new Error("Worker and review database credentials must differ");
}
if (webDatabasePassword === reviewDatabasePassword) {
  throw new Error("Web and review database credentials must differ");
}
if (
  operationsDatabasePassword === appDatabasePassword
  || operationsDatabasePassword === webDatabasePassword
  || operationsDatabasePassword === reviewDatabasePassword
) {
  throw new Error("Operations database credentials must differ from every runtime role");
}

const migrationsDirectory = path.resolve(
  process.env.MIGRATIONS_DIR ?? "/app/deploy/migrations",
);
const bootstrapDirectory = path.resolve(
  process.env.BOOTSTRAP_DIR ?? path.join(migrationsDirectory, "../bootstrap"),
);
const bootstrapManifestPath = path.join(bootstrapDirectory, "040_manifest.json");
const bootstrapArtifactPath = path.join(bootstrapDirectory, "040_schema.sql");
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

const migrationSources = new Map(
  await Promise.all(repositoryMigrationFiles.map(async (id) => {
    const source = await readFile(path.join(migrationsDirectory, id), "utf8");
    return [id, {
      source,
      checksum: createHash("sha256").update(source).digest("hex"),
    }];
  })),
);
const bootstrapManifestSource = await readFile(bootstrapManifestPath, "utf8");
const bootstrapArtifactSource = await readFile(bootstrapArtifactPath, "utf8");
const bootstrapManifestSha256 = createHash("sha256")
  .update(bootstrapManifestSource)
  .digest("hex");
const bootstrapArtifactSha256 = createHash("sha256")
  .update(bootstrapArtifactSource)
  .digest("hex");
let bootstrapManifest;
try {
  bootstrapManifest = JSON.parse(bootstrapManifestSource);
} catch {
  throw new Error("Bootstrap manifest is not valid JSON");
}
if (
  bootstrapManifest?.baseline_id !== "handleplan-040-canonical-v1"
  || bootstrapManifest?.artifact?.path !== "deploy/bootstrap/040_schema.sql"
  || bootstrapManifest?.artifact?.sha256 !== bootstrapArtifactSha256
  || !Array.isArray(bootstrapManifest.covered_migrations)
  || bootstrapManifest.covered_migrations.length !== 40
  || bootstrapManifest.canonical_contract?.schema_catalog_sha256 === undefined
) {
  throw new Error("Bootstrap manifest is incomplete or does not match its artifact");
}
for (const [index, entry] of bootstrapManifest.covered_migrations.entries()) {
  const expectedId = repositoryMigrationFiles[index];
  const actual = migrationSources.get(entry.id);
  if (entry.id !== expectedId || actual?.checksum !== entry.sha256) {
    throw new Error(`Bootstrap manifest migration checksum mismatch: ${entry.id ?? "unknown"}`);
  }
}
if (
  bootstrapManifest.correction_semantics?.migration_041_sha256
  !== migrationSources.get("041_public_offer_projection_repair.sql")?.checksum
) {
  throw new Error("Bootstrap manifest 041 checksum mismatch");
}

const sql = postgres(databaseMigrationUrl, {
  connect_timeout: 10,
  idle_timeout: 5,
  max: 1,
  onnotice: () => {},
});

const advisoryLockId = 7_229_164_301;
const workerSourceHealthEnabled = migrationFiles.includes(
  "016_worker_source_health.sql",
);
const publicApiRequestBudgetEnabled = migrationFiles.includes(
  "019_public_api_request_budget.sql",
);
const privateReviewDecisionBoundaryEnabled = migrationFiles.includes(
  "021_private_review_decision_boundary.sql",
);
const privateReviewEvidenceRendererEnabled = migrationFiles.includes(
  "025_private_review_evidence_renderer.sql",
);
const publicOfficialOfferProjectionEnabled = migrationFiles.includes(
  "022_public_official_offer_projection.sql",
);
const operationsRuntimeBoundaryEnabled = migrationFiles.includes(
  "024_operations_runtime_boundary.sql",
);
const officialOfferLifecycleRuntimeEnabled = migrationFiles.includes(
  "026_official_offer_publication_runtime.sql",
);
const officialOfferEditionIdentityEnabled = migrationFiles.includes(
  "038_tjek_function_grants.sql",
);
const officialOfferPublicationHealthEnabled = migrationFiles.includes(
  "027_official_offer_publication_health.sql",
);
const offerBackedDiscoveryEnabled = migrationFiles.includes(
  "040_offer_backed_discovery.sql",
);

const protectedAppendOnlyTables = [
  "catalog_observations",
  "physical_store_coverage_checks",
  "physical_store_observations",
  "price_observations",
  "price_coverage_checks",
  "source_record_outcomes",
  ...(workerSourceHealthEnabled ? ["source_health_snapshots"] : []),
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

const officialOfferWorkerReadTables = [
  "publications",
  "publication_captures",
  "extraction_runs",
  "extracted_offer_candidates",
  "approved_offers",
  "review_actions",
  "offer_targets",
  "offer_conditions",
];

const officialOfferWorkerWriteTables = [
  "publications",
  "publication_captures",
  "extraction_runs",
  "extracted_offer_candidates",
];

const officialOfferWorkerWriteSequences = [
  "publications_id_seq",
  "publication_captures_id_seq",
  "extraction_runs_id_seq",
  "extracted_offer_candidates_id_seq",
];

const ephemeralRequestBudgetTables = ["provider_request_budget_events"];

const runtimeSequences = [
  "catalog_observations_id_seq",
  "canonical_products_id_seq",
  "product_identifiers_id_seq",
  "ingestion_runs_id_seq",
  "price_observations_id_seq",
  "price_coverage_checks_id_seq",
  "physical_store_coverage_checks_id_seq",
  "physical_store_observations_id_seq",
  "physical_stores_id_seq",
  "source_record_outcomes_id_seq",
  ...(workerSourceHealthEnabled ? ["source_health_snapshots_id_seq"] : []),
  "worker_job_results_id_seq",
];

const webReadOnlyTables = [
  "catalog_observations",
  "family_taxonomy_versions",
  "handleplan_schema_migrations",
  "price_cache",
  "canonical_products",
  "product_identifiers",
  "physical_store_branches_public",
  "physical_store_region_branches_public",
  "physical_store_coverage_checks",
  "geographic_scope_regions",
  "geographic_scope_postal_codes",
  "geographic_scope_stores",
  "geographic_postal_directory_versions",
  "geographic_postal_directory_regions",
  "geographic_postal_directory_codes",
  "price_observations",
  "price_coverage_checks",
  "reviewed_family_aliases",
  "reviewed_family_definitions",
  "reviewed_family_membership_public",
];

const reviewReadOnlyTables = [
  "approved_offers",
  "canonical_products",
  "extracted_offer_candidates",
  "extraction_runs",
  "handleplan_schema_migrations",
  "offer_conditions",
  "offer_targets",
  "product_families",
  "product_identifiers",
  "publication_captures",
  "publications",
  "review_actions",
];

const reviewAppendOnlyTables = [
  "approved_offers",
  "offer_conditions",
  "offer_targets",
  "review_actions",
];

const reviewSequences = [
  "approved_offers_id_seq",
  "offer_conditions_id_seq",
  "review_actions_id_seq",
];

const reviewDataSourceColumns = [
  "id",
  "display_name",
  "source_kind",
  "runtime_state",
  "public_reference_url",
  "permission_reviewed_at",
  "permission_expires_at",
  "created_at",
  "updated_at",
  "public_state_changed_at",
];

const reviewSourcePermissionColumns = [
  "id",
  "source_id",
  "decision",
  "reviewed_at",
  "valid_until",
  "permissions",
  "created_at",
];

const reviewGeographicScopeColumns = [
  "id",
  "scope_kind",
  "label",
  "country_code",
  "status",
  "created_at",
  "public_state_changed_at",
];

const webIngestionRunColumns = [
  "id",
  "source_id",
  "run_type",
  "status",
  "started_at",
  "completed_at",
  "created_at",
  "terminalized_at",
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
  "public_state_changed_at",
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
  "persisted_at",
];

const webOfficialOfferPublicationHealthColumns = [
  "id",
  "source_id",
  "last_publish_success_at",
  "newest_eligible_evidence_at",
  "persisted_at",
];

const webGeographicScopeColumns = [
  "id",
  "scope_kind",
  "label",
  "country_code",
  "status",
  "created_at",
  "public_state_changed_at",
];

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function identifiers(values) {
  return values.map(identifier).join(", ");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
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

async function ensureWorkerRole(transaction) {
  await transaction.unsafe(`
    do $worker_role_bootstrap$
    begin
      if not exists (select 1 from pg_roles where rolname = '${workerRole}') then
        create role ${workerRole} with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
    end
    $worker_role_bootstrap$;
  `);
}

async function configureRuntimeRoles() {
  await sql.begin(async (transaction) => {
    await transaction.unsafe("set local search_path = public, pg_catalog");
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
    await transaction`
      select set_config(
        'handleplan.review_role_bootstrap_password',
        ${reviewDatabasePassword},
        true
      )
    `;
    await transaction`
      select set_config(
        'handleplan.operations_role_bootstrap_password',
        ${operationsDatabasePassword},
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
        if exists (select 1 from pg_roles where rolname = '${reviewRole}') then
          execute format(
            'alter role ${reviewRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.review_role_bootstrap_password')
          );
        else
          execute format(
            'create role ${reviewRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.review_role_bootstrap_password')
          );
        end if;
        if exists (select 1 from pg_roles where rolname = '${operationsRole}') then
          execute format(
            'alter role ${operationsRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.operations_role_bootstrap_password')
          );
        else
          execute format(
            'create role ${operationsRole} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
            current_setting('handleplan.operations_role_bootstrap_password')
          );
        end if;
      end
      $runtime_roles$;
    `);

    await revokeRoleMemberships(transaction, workerRole);
    await revokeRoleMemberships(transaction, webRole);
    await revokeRoleMemberships(transaction, reviewRole);
    await revokeRoleMemberships(transaction, operationsRole);

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
      where role.rolname in (${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole})
      order by role.rolname
    `;
    if (
      ownership.length !== 4
      || ownership.some(({ rolname: _role, ...counts }) =>
        Object.values(counts).some((count) => count !== 0))
    ) {
      throw new Error("Runtime roles must not own database objects");
    }

    await transaction.unsafe(`
      revoke all privileges on database "${databaseName}" from public;
      revoke all privileges on database "${databaseName}" from ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      grant connect on database "${databaseName}" to ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};

      revoke all privileges on schema public from public;
      revoke all privileges on schema public from ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      grant usage on schema public to ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};

      revoke all privileges on all tables in schema public from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      revoke all privileges on all sequences in schema public from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      revoke all privileges on all functions in schema public from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};

      alter default privileges for role ${migrationRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${migrationRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${migrationRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${workerRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${workerRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${workerRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${webRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${webRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${webRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${reviewRole} in schema public
        revoke all privileges on tables from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${reviewRole} in schema public
        revoke all privileges on sequences from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};
      alter default privileges for role ${reviewRole} in schema public
        revoke all privileges on functions from public, ${workerRole}, ${webRole}, ${reviewRole}, ${operationsRole};

      alter role ${operationsRole} set statement_timeout = '4s';
      alter role ${operationsRole} set lock_timeout = '500ms';
      alter role ${operationsRole} set idle_in_transaction_session_timeout = '5s';

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
      grant select on table ${identifiers(officialOfferWorkerReadTables)}
        to ${workerRole};
      grant insert on table ${identifiers(officialOfferWorkerWriteTables)}
        to ${workerRole};
      grant usage on sequence ${identifiers(officialOfferWorkerWriteSequences)} to ${workerRole};

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
      ${officialOfferPublicationHealthEnabled ? `
      grant select (${identifiers(webOfficialOfferPublicationHealthColumns)})
        on table official_offer_publication_health_facts to ${webRole};
      ` : ""}
      grant select (${identifiers(webGeographicScopeColumns)})
        on table geographic_scopes to ${webRole};
      grant select (${identifiers(webIngestionRunColumns)})
        on table ingestion_runs to ${webRole};

    `);

    if (privateReviewDecisionBoundaryEnabled) {
      // Review writes cross exactly one typed SECURITY DEFINER transaction
      // boundary. The companion bounded reader owns the eligibility predicate
      // shared by queue, detail, locator and decision paths.
      await transaction.unsafe(`
        revoke select (${identifiers(reviewDataSourceColumns)})
          on table data_sources from ${reviewRole};
        revoke select (${identifiers(reviewSourcePermissionColumns)})
          on table source_permissions from ${reviewRole};
        revoke select (${identifiers(reviewGeographicScopeColumns)})
          on table geographic_scopes from ${reviewRole};
        grant execute on function public.private_review_candidate_rows_v1(
          bigint, timestamp with time zone, text, text, integer, integer,
          integer, integer, text, timestamp with time zone, bigint, integer
        ) to ${reviewRole};
      `);
      if (privateReviewEvidenceRendererEnabled) {
        await transaction.unsafe(`
          revoke all on function public.private_review_decide_v1(
            bigint, integer, text, text, text, text, text, text, text, integer,
            integer, integer, integer, text, text, timestamp with time zone,
            timestamp with time zone, text[]
          ) from ${reviewRole};
          grant execute on function public.private_review_record_evidence_render_v1(
            bigint, integer, text, text, text, text, text, text, text,
            timestamp with time zone
          ) to ${reviewRole};
          grant execute on function public.private_review_decide_v2(
            bigint, integer, text, text, text, text, text, text, text, text,
            text, integer, integer, integer, integer, text, text,
            timestamp with time zone, timestamp with time zone, text[]
          ) to ${reviewRole};
        `);
      } else {
        await transaction.unsafe(`
          grant execute on function public.private_review_decide_v1(
            bigint, integer, text, text, text, text, text, text, text, integer,
            integer, integer, integer, text, text, timestamp with time zone,
            timestamp with time zone, text[]
          ) to ${reviewRole};
        `);
      }
    } else {
      // Upgrade proofs capped before 021 preserve the historical grants so the
      // forward-only migration runner can still reproduce those exact states.
      await transaction.unsafe(`
        grant select on table ${identifiers(reviewReadOnlyTables)} to ${reviewRole};
        grant select (${identifiers(reviewDataSourceColumns)})
          on table data_sources to ${reviewRole};
        grant select (${identifiers(reviewSourcePermissionColumns)})
          on table source_permissions to ${reviewRole};
        grant select (${identifiers(reviewGeographicScopeColumns)})
          on table geographic_scopes to ${reviewRole};
        grant insert on table ${identifiers(reviewAppendOnlyTables)} to ${reviewRole};
        grant usage on sequence ${identifiers(reviewSequences)} to ${reviewRole};
      `);
    }

    if (publicApiRequestBudgetEnabled) {
      // The web role can only invoke the fixed-policy SECURITY DEFINER
      // coordinator. It receives no direct privilege on the ephemeral table.
      await transaction.unsafe(`
        grant execute on function public.claim_public_api_request_budget(text)
          to ${webRole};
      `);
    }

    if (publicOfficialOfferProjectionEnabled) {
      // Public offer evidence crosses one bounded, public-only SECURITY
      // DEFINER projection. The web role keeps no direct access to pipeline,
      // governance, review, or condition tables.
      await transaction.unsafe(`
        grant execute on function public.public_official_offer_rows_v1(
          bigint[], timestamp with time zone
        ) to ${webRole};
      `);
    }

    if (offerBackedDiscoveryEnabled) {
      // Discovery may use the same reviewed-offer evidence as an identity
      // fallback. This remains a bounded SECURITY DEFINER boundary; the web
      // role receives no direct access to offer pipeline tables.
      await transaction.unsafe(`
        grant execute on function public.public_offer_backed_discovery_rows_v1(
          timestamp with time zone
        ) to ${webRole};
      `);
    }

    if (officialOfferLifecycleRuntimeEnabled) {
      // Official-offer publication/expiry owns its PostgreSQL clock, lease and
      // immutable job accounting. The worker receives only this atomic entry
      // point; it receives no lifecycle-policy, lease or result-table grant.
      await transaction.unsafe(`
        grant execute on function public.official_offer_lifecycle_reconcile_v1(
          text, text, text, timestamp with time zone, text, integer, boolean
        ) to ${workerRole};
      `);
    }
    if (officialOfferEditionIdentityEnabled) {
      // Tjek and other official-offer handlers call into SQL functions that
      // are invoked indirectly (e.g. via INSERT triggers/SECURITY DEFINER).
      // Keep the worker boundary explicit. The blanket grants formerly used
      // here also exposed review/governance functions and every application
      // table to the worker role.
      await transaction.unsafe(`
        grant execute on function public.canonical_official_offer_edition_identity(
          text, text, text, text, text, bigint, jsonb,
          timestamp with time zone, timestamp with time zone, timestamp with time zone
        ) to ${workerRole};
        grant execute on function public.canonical_official_offer_scope_identity(jsonb)
          to ${workerRole};
        revoke insert on table approved_offers, review_actions, offer_targets, offer_conditions
          from ${workerRole};
        revoke usage on sequence approved_offers_id_seq, review_actions_id_seq
          from ${workerRole};
      `);
    }

    if (operationsRuntimeBoundaryEnabled) {
      // The operations process always receives the bounded read projection. At
      // migration 027 and later, alert scheduling is still deliberately
      // uncomposed, so the dashboard role receives no append/export capability.
      await transaction.unsafe(`
        grant execute on function public.operations_dashboard_rows_v1(
          text[], integer
        ) to ${operationsRole};
        ${officialOfferPublicationHealthEnabled ? "" : `
        grant execute on function public.append_operations_alert_evaluation_v1(
          timestamp with time zone, jsonb, jsonb
        ) to ${operationsRole};
        grant execute on function public.operations_alert_export_rows_v1(
          bigint, integer
        ) to ${operationsRole};
        `}
      `);
    }

    await transaction`
      select set_config('handleplan.worker_role_bootstrap_password', '', true)
    `;
    await transaction`
      select set_config('handleplan.web_role_bootstrap_password', '', true)
    `;
    await transaction`
      select set_config('handleplan.review_role_bootstrap_password', '', true)
    `;
    await transaction`
      select set_config('handleplan.operations_role_bootstrap_password', '', true)
    `;
  });
}

try {
  await sql.unsafe("set search_path = public, pg_catalog");
  await sql`select pg_advisory_lock(${advisoryLockId})`;
  const [catalogState] = await sql`
    select
      to_regclass('public.handleplan_schema_migrations') is not null as ledger_exists,
      to_regclass('public.handleplan_schema_baselines') is not null as baseline_exists,
      (
        select count(*)::integer
        from pg_catalog.pg_namespace
        where nspname not in ('pg_catalog', 'information_schema', 'public')
          and nspname !~ '^pg_(toast|temp)'
      ) as custom_schemas,
      (
        select count(*)::integer
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname not in ('pg_catalog', 'information_schema')
          and namespace.nspname !~ '^pg_(toast|temp)'
          and not (
            namespace.nspname = 'public'
            and relation.relname in ('handleplan_schema_migrations', 'handleplan_schema_baselines')
          )
      ) as custom_relations,
      (
        select count(*)::integer
        from pg_catalog.pg_proc procedure
        join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname not in ('pg_catalog', 'information_schema')
          and namespace.nspname !~ '^pg_(toast|temp)'
      ) as custom_functions,
      (
        select count(*)::integer
        from pg_catalog.pg_type type
        join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
        where namespace.nspname not in ('pg_catalog', 'information_schema')
          and namespace.nspname !~ '^pg_(toast|temp)'
          and type.typtype <> 'p'
      ) as custom_types,
      (
        select count(*)::integer
        from pg_catalog.pg_extension extension
        join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
        where not (extension.extname = 'plpgsql' and namespace.nspname = 'pg_catalog')
      ) as non_default_extensions,
      (select count(*)::integer from pg_catalog.pg_event_trigger) as event_triggers
  `;
  const catalogIsEmpty = Object.values(catalogState)
    .slice(2)
    .every((value) => value === 0);
  const [appliedMigrations, baselineRows] = await Promise.all([
    catalogState.ledger_exists
      ? sql`select id, checksum from public.handleplan_schema_migrations order by id`
      : Promise.resolve([]),
    catalogState.baseline_exists
      ? sql`select baseline_id, manifest_sha256, artifact_sha256, covered_migrations,
          resulting_schema_sha256, provenance
          from public.handleplan_schema_baselines order by baseline_id`
      : Promise.resolve([]),
  ]);
  const missingMigrationIds = appliedMigrations
    .map(({ id }) => id)
    .filter((id) => !repositoryMigrationFiles.includes(id));
  if (missingMigrationIds.length > 0) {
    throw new Error(
      `Applied migration is absent from the repository: ${missingMigrationIds.join(", ")}`,
    );
  }
  for (const row of appliedMigrations) {
    const expected = migrationSources.get(row.id)?.checksum;
    if (expected === undefined || row.checksum !== expected) {
      throw new Error(`Applied migration checksum changed: ${row.id}`);
    }
  }
  if (baselineRows.length === 0) {
    const selectedPrefix = repositoryMigrationFiles.slice(0, appliedMigrations.length);
    if (appliedMigrations.some(({ id }, index) => id !== selectedPrefix[index])) {
      throw new Error("Applied migration ledger is not an ordered repository prefix");
    }
  } else {
    const expectedForwardIds = repositoryMigrationFiles.filter(
      (id) => !bootstrapManifest.covered_migrations.some((entry) => entry.id === id),
    );
    if (appliedMigrations.some(({ id }, index) => id !== expectedForwardIds[index])) {
      throw new Error("Applied migration ledger is not an ordered post-baseline suffix");
    }
  }
  if (ciMaxMigrationId === undefined && appliedMigrations.at(-1)?.id === "038_tjek_function_grants.sql") {
    throw new Error("Incomplete historical 038 ledger refuses before mutation");
  }
  if (ciMaxMigrationId !== undefined && baselineRows.length > 0) {
    throw new Error("CI_MAX_MIGRATION_ID cannot use the empty-database baseline");
  }
  if (baselineRows.length > 1) {
    throw new Error("Bootstrap baseline metadata must contain exactly one row");
  }
  if (baselineRows.length === 1) {
    const baseline = baselineRows[0];
    let coveredMigrations;
    let provenance;
    try {
      coveredMigrations = typeof baseline.covered_migrations === "string"
        ? JSON.parse(baseline.covered_migrations)
        : baseline.covered_migrations;
      provenance = typeof baseline.provenance === "string"
        ? JSON.parse(baseline.provenance)
        : baseline.provenance;
    } catch {
      throw new Error("Bootstrap baseline metadata contains invalid JSON");
    }
    if (
      baseline.baseline_id !== bootstrapManifest.baseline_id
      || baseline.manifest_sha256 !== bootstrapManifestSha256
      || baseline.artifact_sha256 !== bootstrapArtifactSha256
      || baseline.resulting_schema_sha256 !== bootstrapManifest.canonical_contract.schema_catalog_sha256
      || JSON.stringify(coveredMigrations) !== JSON.stringify(bootstrapManifest.covered_migrations)
      || JSON.stringify(canonicalJson(provenance))
        !== JSON.stringify(canonicalJson(bootstrapManifest.provenance))
      || appliedMigrations.some(({ id }) => bootstrapManifest.covered_migrations.some((entry) => entry.id === id))
    ) {
      throw new Error("Bootstrap baseline metadata does not match its reviewed manifest");
    }
  } else if (catalogState.baseline_exists) {
    throw new Error("Bootstrap baseline metadata table is present without its provenance row");
  }

  const baselineEligible = ciMaxMigrationId === undefined
    && !catalogState.ledger_exists
    && !catalogState.baseline_exists
    && catalogIsEmpty;
  if (
    ciMaxMigrationId === undefined
    && !catalogState.ledger_exists
    && !catalogState.baseline_exists
    && !baselineEligible
  ) {
    throw new Error("Baseline target must be an empty catalog");
  }
  if (baselineEligible) {
    await sql.begin(async (transaction) => {
      await transaction.unsafe("set local search_path = public, pg_catalog");
      await transaction.unsafe(`
        create table public.handleplan_schema_baselines (
          baseline_id text primary key,
          manifest_sha256 char(64) not null,
          artifact_sha256 char(64) not null,
          covered_migrations jsonb not null,
          resulting_schema_sha256 char(64) not null,
          provenance jsonb not null,
          recorded_at timestamptz not null default pg_catalog.transaction_timestamp(),
          constraint handleplan_schema_baselines_manifest_sha256
            check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
          constraint handleplan_schema_baselines_artifact_sha256
            check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
          constraint handleplan_schema_baselines_schema_sha256
            check (resulting_schema_sha256 ~ '^[0-9a-f]{64}$')
        );
        create table public.handleplan_schema_migrations (
          id varchar(255) primary key,
          checksum char(64) not null,
          applied_at timestamptz not null default pg_catalog.transaction_timestamp()
        );
      `);
      await ensureWorkerRole(transaction);
      if (process.env.HANDLEPLAN_BOOTSTRAP_FAIL_PHASE === "before-artifact") {
        throw new Error("Injected bootstrap failure before artifact");
      }
      await transaction.unsafe(bootstrapArtifactSource);
      await transaction.unsafe("set local search_path = public, pg_catalog");
      await transaction.unsafe("set local check_function_bodies = on");
      if (process.env.HANDLEPLAN_BOOTSTRAP_FAIL_PHASE === "after-artifact") {
        throw new Error("Injected bootstrap failure after artifact");
      }
      await transaction`
        insert into public.handleplan_schema_baselines
          (baseline_id, manifest_sha256, artifact_sha256, covered_migrations,
           resulting_schema_sha256, provenance)
        values (
          ${bootstrapManifest.baseline_id},
          ${bootstrapManifestSha256},
          ${bootstrapArtifactSha256},
          ${transaction.json(bootstrapManifest.covered_migrations)},
          ${bootstrapManifest.canonical_contract.schema_catalog_sha256},
          ${transaction.json(bootstrapManifest.provenance)}
        )
      `;
      if (process.env.HANDLEPLAN_BOOTSTRAP_FAIL_PHASE === "before-commit") {
        throw new Error("Injected bootstrap failure before commit");
      }
    });
    // pg_dump's session guards are intentionally scoped to the artifact;
    // forward migrations must run with ordinary validation settings restored.
    await sql.unsafe("set search_path = public, pg_catalog; set check_function_bodies = on");
  } else if (!catalogState.ledger_exists) {
    await sql`
      create table public.handleplan_schema_migrations (
        id varchar(255) primary key,
        checksum char(64) not null,
        applied_at timestamptz not null default pg_catalog.transaction_timestamp()
      )
    `;
  }

  const coveredBaselineIds = new Set(
    baselineRows.length === 1
      ? bootstrapManifest.covered_migrations.map(({ id }) => id)
      : [],
  );
  if (baselineEligible) {
    coveredBaselineIds.clear();
    for (const entry of bootstrapManifest.covered_migrations) coveredBaselineIds.add(entry.id);
  }
  if (baselineRows.length === 1 && coveredBaselineIds.size !== 40) {
    throw new Error("Bootstrap baseline coverage is incomplete");
  }

  // Migration 037 grants to this role; a fresh database has no runtime roles yet.
  // Leave existing roles untouched; configureRuntimeRoles remains authoritative.
  if (migrationFiles.includes("037_worker_official_offer_grants.sql") && !baselineEligible) {
    await sql.unsafe(`
      do $worker_role_prerequisite$
      begin
        if not exists (select 1 from pg_roles where rolname = '${workerRole}') then
          create role ${workerRole} with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
        end if;
      end
      $worker_role_prerequisite$;
    `);
  }

  for (const id of migrationFiles) {
    const { source, checksum } = migrationSources.get(id);
    const existing = await sql`
      select checksum from public.handleplan_schema_migrations where id = ${id}
    `;

    if (coveredBaselineIds.has(id)) {
      if (existing.length > 0) {
        throw new Error(`Baseline-covered migration is present in execution ledger: ${id}`);
      }
      continue;
    }
    if (existing.length > 0) {
      if (existing[0].checksum !== checksum) {
        throw new Error(`Applied migration checksum changed: ${id}`);
      }
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe("set local search_path = public, pg_catalog");
      await transaction.unsafe(source);
      await transaction.unsafe("set local search_path = public, pg_catalog");
      await transaction.unsafe("set local check_function_bodies = on");
      await transaction`
        insert into public.handleplan_schema_migrations (id, checksum)
        values (${id}, ${checksum})
      `;
    });
  }

  if (migrationFiles.includes("012_reviewed_family_taxonomy.sql")) {
    await sql`
      select public.assert_family_taxonomy_publication(
        'handleplan-reviewed-families@1.0.0'
      )
    `;
    await sql`
      select public.assert_family_taxonomy_publication(version_id)
      from public.family_taxonomy_versions
      order by version_id
    `;
  }

  if (ciMaxMigrationId === undefined) {
    await configureRuntimeRoles();
  }
} finally {
  await sql`select pg_advisory_unlock(${advisoryLockId})`.catch(() => undefined);
  await sql.end({ timeout: 5 });
}
