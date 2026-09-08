#!/usr/bin/env node

/**
 * Rerunnable Task 2B1 proof harness.
 *
 * It builds two independent disposable PostgreSQL databases from the
 * immutable migration history (001-038, explicit 041, immutable 040), dumps
 * their public schema, and reads back the bounded catalog/seed/sequence/ACL
 * contracts. The committed literal artifact is installed into two additional
 * databases and compared at those same contract boundaries.
 *
 * This harness intentionally requires an already-running disposable
 * PostgreSQL container. It never targets production and never writes outside
 * the selected output directory.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const migrations = path.join(root, "deploy/migrations");
const artifactPath = path.join(root, "deploy/bootstrap/040_schema.sql");
const manifestPath = path.join(root, "deploy/bootstrap/040_manifest.json");
const container = process.env.TASK2B1_CONTAINER ?? "handleplan-task2b1-pg";
const output = path.resolve(process.env.TASK2B1_OUTPUT ?? path.join(root, "docs/evidence/release-readiness/task-2B1-proof"));
const postgresUser = process.env.TASK2B1_POSTGRES_USER ?? "postgres";

const seedTables = [
  ["data_sources", "id"],
  ["family_taxonomy_versions", "version_id"],
  ["geographic_scopes", "id"],
  ["ingestion_runs", "id"],
  ["official_offer_publication_policy", "policy_key"],
  ["reviewed_family_aliases", "version_id, family_id, alias"],
  ["reviewed_family_definitions", "version_id, family_id"],
  ["source_permissions", "id"],
];

const volatileColumns = new Map([
  ["data_sources", ["created_at", "updated_at", "permission_reviewed_at", "public_state_changed_at"]],
  ["family_taxonomy_versions", ["created_at"]],
  ["geographic_scopes", ["created_at", "updated_at", "public_state_changed_at"]],
  ["ingestion_runs", ["started_at", "completed_at", "created_at", "terminalized_at"]],
  ["official_offer_publication_policy", ["updated_at"]],
  ["reviewed_family_aliases", ["created_at"]],
  ["reviewed_family_definitions", ["created_at"]],
  ["source_permissions", ["reviewed_at", "created_at"]],
]);

function fail(message) {
  throw new Error(message);
}

function docker(args, input = undefined) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`docker ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function psql(database, sql, { json = false } = {}) {
  const args = ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", postgresUser, "-d", database];
  if (json) args.push("-A", "-t", "-q");
  else args.push("-q");
  if (json) args.push("-c", sql);
  return docker(args, json ? undefined : sql);
}

function query(database, sql) {
  const result = psql(database, sql, { json: true }).trim();
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch (error) {
    fail(`query did not return JSON: ${error.message}\n${result.slice(0, 500)}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function normalizeExpressionTrees(rows) {
  // PostgreSQL stores source offsets in pg_node_tree. They change when an
  // equivalent expression is deparsed and replayed, while node/operator
  // structure remains semantic. Remove only the parser's location fields.
  return rows.map((row) => ({
    ...row,
    expression_tree: (row.expression_tree ?? "").replaceAll(/ :location \d+/gu, ""),
  }));
}

function normalizeSeed(table, rows) {
  const columns = new Set(volatileColumns.get(table) ?? []);
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    columns.has(key) ? "__installer_transaction_timestamp__" : value,
  ])));
}

function schemaDump(database) {
  return docker([
    "exec", container, "pg_dump", "--schema-only", "--schema=public", "--no-owner", "--no-privileges",
    "--no-comments", "--no-publications", "--no-subscriptions", "--column-inserts",
    "--exclude-table=public.handleplan_schema_migrations", "--exclude-table=public.handleplan_schema_baselines",
    "-U", postgresUser, "-d", database,
  ]);
}

function normalizedSchemaDump(raw) {
  // pg_dump's random session guards are operational metadata, not schema.
  // Keep the raw files too; only these two exact lines are removed here.
  return raw.replace(/^\\(?:restrict|unrestrict)\b.*\n/gmu, "");
}

function deparserDiffCheck(diff) {
  const changed = diff.split("\n").filter((line) => /^[+-]/u.test(line) && !line.startsWith("+++") && !line.startsWith("---"));
  const allowed = changed.every((line) => /^(?:[+-]\s+CONSTRAINT\s+\S+|[+-]CREATE UNIQUE INDEX\s+\S+)/u.test(line));
  return {
    changed_lines: changed.length,
    allowed_definition_lines: allowed,
    allowed_kinds: [...new Set(changed.map((line) => line.includes("CREATE UNIQUE INDEX") ? "index_deparser" : "constraint_deparser"))],
  };
}

function dropAndCreate(database) {
  psql("postgres", `drop database if exists ${database};\ncreate database ${database};`);
}

async function installCanonical(database) {
  psql(database, "do $$ begin if not exists (select 1 from pg_roles where rolname = 'handleplan_app') then create role handleplan_app nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls; end if; end $$;", { json: false });
  const files = [];
  const migrationFiles = await (await import("node:fs/promises")).readdir(migrations);
  const byId = (id) => migrationFiles.find((name) => name.startsWith(`${String(id).padStart(3, "0")}_`));
  for (let id = 1; id <= 34; id += 1) files.push(await readFile(path.join(migrations, byId(id)), "utf8"));
  psql(database, `begin;\n${files.join("\n")}\ncommit;`);
  psql(database, await readFile(path.join(migrations, byId(35)), "utf8"));
  psql(database, `begin;\n${await readFile(path.join(migrations, byId(36)), "utf8")}\n${await readFile(path.join(migrations, byId(37)), "utf8")}\n${await readFile(path.join(migrations, byId(38)), "utf8")}\ncommit;`);
  psql(database, await readFile(path.join(migrations, "041_public_offer_projection_repair.sql"), "utf8"));
  psql(database, await readFile(path.join(migrations, "040_offer_backed_discovery.sql"), "utf8"));
}

async function installArtifact(database) {
  psql(database, await readFile(artifactPath, "utf8"));
}

function readback(database) {
  const counts = query(database, `select json_build_object(
    'relations', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')),
    'columns', (select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped),
    'constraints', (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'),
    'indexes', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'i'),
    'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal),
    'public_functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
    'sequences', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S')
  )`);
  const functions = query(database, `select coalesce(json_agg(json_build_object('name', p.proname, 'sha256', encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex')) order by p.proname), '[]'::json)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('public_official_offer_rows_v1', 'public_offer_backed_discovery_rows_v1')`);
  const seed = [];
  for (const [table, order] of seedTables) {
    const rows = query(database, `select coalesce(json_agg(to_jsonb(t) order by ${order}), '[]'::json) from (select * from public.${table}) t`);
    seed.push({ table, rows: normalizeSeed(table, rows) });
  }
  const sequences = query(database, `select coalesce(json_agg(to_jsonb(t) order by sequence_name), '[]'::json) from (
    select schemaname, sequencename as sequence_name, start_value::text, min_value::text, max_value::text,
      increment_by::text, cycle, cache_size::text, last_value::text
    from pg_catalog.pg_sequences where schemaname = 'public'
  ) t`);
  const aclSecurity = query(database, `select json_build_object(
    'public_relation_acl', coalesce((select json_agg(to_jsonb(t) order by object_name, privilege_type) from (
      select c.relname as object_name, x.privilege_type, x.is_grantable
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S') and x.grantee = 0
    ) t), '[]'::json),
    'public_function_acl', coalesce((select json_agg(to_jsonb(t) order by object_name, privilege_type) from (
      select p.proname as object_name, pg_get_function_identity_arguments(p.oid) as identity_arguments, x.privilege_type, x.is_grantable
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      where n.nspname = 'public' and x.grantee = 0
    ) t), '[]'::json),
    'security_flags', coalesce((select json_agg(to_jsonb(t) order by object_name, identity_arguments) from (
      select p.proname as object_name, pg_get_function_identity_arguments(p.oid) as identity_arguments, p.prosecdef as security_definer, p.proparallel
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    ) t), '[]'::json)
  )`);
  const ownerShape = query(database, `select json_build_object(
    'relation_owner_mismatches', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S') and pg_get_userbyid(c.relowner) <> current_user),
    'function_owner_mismatches', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and pg_get_userbyid(p.proowner) <> current_user)
  )`);
  const denials = query(database, `select json_build_object(
    'runtime_acl_rows', (select count(*) from (
      select x.grantee from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      where n.nspname = 'public' and pg_get_userbyid(x.grantee) in ('handleplan_app','handleplan_web','handleplan_review','handleplan_operations')
      union all
      select x.grantee from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      where n.nspname = 'public' and pg_get_userbyid(x.grantee) in ('handleplan_app','handleplan_web','handleplan_review','handleplan_operations')
    ) denied),
    'tjek_pointer_matches_latest', (select count(*) from data_sources source where source.id = 'tjek' and source.permission_reviewed_at = (select reviewed_at from source_permissions permission where permission.source_id = source.id order by permission.id desc limit 1)),
    'source_permission_rows', (select count(*) from source_permissions),
    'product_price_offer_review_capture_rows', (select count(*) from canonical_products) + (select count(*) from price_observations) + (select count(*) from approved_offers) + (select count(*) from review_actions) + (select count(*) from publication_captures)
  )`);
  const expressionTrees = query(database, `select coalesce(json_agg(to_jsonb(t) order by object_type, object_name), '[]'::json) from (
    select 'constraint' as object_type, c.conname as object_name, c.conbin::text as expression_tree
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
    union all
    select 'index' as object_type, c.relname as object_name, coalesce(i.indexprs::text, '') || '|' || coalesce(i.indpred::text, '') as expression_tree
    from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
  ) t`);
  const digests = {
    seed: sha256(stableJson(seed)),
    sequences: sha256(stableJson(sequences)),
    acl_security: sha256(stableJson(aclSecurity)),
  };
  return { counts, functions, seed, sequences, acl_security: aclSecurity, owner_shape: ownerShape, denials, expression_trees: normalizeExpressionTrees(expressionTrees), digests };
}

async function main() {
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifactBytes = await readFile(artifactPath);
  if (sha256(artifactBytes) !== manifest.artifact.sha256) fail("manifest artifact hash does not match artifact bytes");
  const databases = ["task2b1_source_1", "task2b1_source_2", "task2b1_artifact_1", "task2b1_artifact_2"];
  for (const database of databases) dropAndCreate(database);
  await installCanonical(databases[0]);
  await installCanonical(databases[1]);
  await installArtifact(databases[2]);
  await installArtifact(databases[3]);

  const raw1 = schemaDump(databases[0]);
  const raw2 = schemaDump(databases[1]);
  const rawArtifact = schemaDump(databases[2]);
  const rawArtifact2 = schemaDump(databases[3]);
  const generated1 = normalizedSchemaDump(raw1);
  const generated2 = normalizedSchemaDump(raw2);
  const generatedArtifact = normalizedSchemaDump(rawArtifact);
  const generatedArtifact2 = normalizedSchemaDump(rawArtifact2);
  await writeFile(path.join(output, "canonical-1.raw.sql"), raw1);
  await writeFile(path.join(output, "canonical-2.raw.sql"), raw2);
  await writeFile(path.join(output, "artifact.raw.sql"), rawArtifact);
  await writeFile(path.join(output, "artifact-2.raw.sql"), rawArtifact2);
  await writeFile(path.join(output, "canonical-1.sql"), generated1);
  await writeFile(path.join(output, "canonical-2.sql"), generated2);
  await writeFile(path.join(output, "artifact.sql"), generatedArtifact);
  await writeFile(path.join(output, "artifact-2.sql"), generatedArtifact2);
  await writeFile(path.join(output, "canonical-raw.diff"), (() => {
    const result = spawnSync("diff", ["-u", path.join(output, "canonical-1.raw.sql"), path.join(output, "canonical-2.raw.sql")], { encoding: "utf8" });
    return result.status === 1 ? result.stdout : "";
  })());
  await writeFile(path.join(output, "canonical-generated.diff"), (() => {
    const result = spawnSync("diff", ["-u", path.join(output, "canonical-1.sql"), path.join(output, "canonical-2.sql")], { encoding: "utf8" });
    return result.status === 1 ? result.stdout : "";
  })());
  await writeFile(path.join(output, "canonical-artifact.raw.diff"), (() => {
    const result = spawnSync("diff", ["-u", path.join(output, "canonical-1.raw.sql"), path.join(output, "artifact.raw.sql")], { encoding: "utf8" });
    return result.status === 1 ? result.stdout : "";
  })());
  await writeFile(path.join(output, "canonical-artifact.diff"), (() => {
    const result = spawnSync("diff", ["-u", path.join(output, "canonical-1.sql"), path.join(output, "artifact.sql")], { encoding: "utf8" });
    return result.status === 1 ? result.stdout : "";
  })());
  await writeFile(path.join(output, "artifact-generated.diff"), (() => {
    const result = spawnSync("diff", ["-u", path.join(output, "artifact.sql"), path.join(output, "artifact-2.sql")], { encoding: "utf8" });
    return result.status === 1 ? result.stdout : "";
  })());
  const canonicalArtifactDiff = await readFile(path.join(output, "canonical-artifact.diff"), "utf8");
  const deparserDiff = deparserDiffCheck(canonicalArtifactDiff);
  await writeFile(path.join(output, "canonical-artifact.diff.check.json"), `${JSON.stringify(deparserDiff, null, 2)}\n`);

  const readbacks = {
    source_1: readback(databases[0]),
    source_2: readback(databases[1]),
    artifact_1: readback(databases[2]),
    artifact_2: readback(databases[3]),
  };
  await writeFile(path.join(output, "readback.json"), `${JSON.stringify(readbacks, null, 2)}\n`);
  const proof = {
    generated_output_sha256: [sha256(generated1), sha256(generated2)],
    generated_artifact_output_sha256: sha256(generatedArtifact),
    generated_artifact_output_sha256_2: sha256(generatedArtifact2),
    manifest_contract_hashes: {
      schema_catalog: manifest.canonical_contract.schema_catalog_sha256,
      normalized_seed: manifest.canonical_contract.normalized_seed_sha256,
      sequence_state: manifest.canonical_contract.sequence_state_sha256,
      public_acl_security: manifest.canonical_contract.public_acl_security_sha256,
    },
    generated_outputs_byte_equal: generated1 === generated2,
    artifact_outputs_byte_equal: generatedArtifact === generatedArtifact2,
    raw_schema_diff_sha256: sha256(await readFile(path.join(output, "canonical-raw.diff"))),
    canonical_artifact_raw_diff_sha256: sha256(await readFile(path.join(output, "canonical-artifact.raw.diff"))),
    canonical_artifact_deparser_diff_sha256: sha256(await readFile(path.join(output, "canonical-artifact.diff"))),
    canonical_artifact_deparser_diff_check: deparserDiff,
    readback_sha256: sha256(JSON.stringify(readbacks)),
    source_contract_equal: JSON.stringify(readbacks.source_1) === JSON.stringify(readbacks.source_2),
    artifact_contract_equal: JSON.stringify(readbacks.artifact_1) === JSON.stringify(readbacks.artifact_2),
    canonical_to_artifact: {
      counts: JSON.stringify(readbacks.source_1.counts) === JSON.stringify(readbacks.artifact_1.counts),
      functions: JSON.stringify(readbacks.source_1.functions) === JSON.stringify(readbacks.artifact_1.functions),
      seed: readbacks.source_1.digests.seed === readbacks.artifact_1.digests.seed,
      sequences: readbacks.source_1.digests.sequences === readbacks.artifact_1.digests.sequences,
      public_acl_security: readbacks.source_1.digests.acl_security === readbacks.artifact_1.digests.acl_security,
      owner_shape: JSON.stringify(readbacks.source_1.owner_shape) === JSON.stringify(readbacks.artifact_1.owner_shape),
    },
    runtime_denial_artifact_1: readbacks.artifact_1.denials.runtime_acl_rows === 0,
    output_directory: output,
  };
  if (proof.generated_artifact_output_sha256 !== manifest.canonical_contract.schema_catalog_sha256
    || readbacks.artifact_1.digests.seed !== manifest.canonical_contract.normalized_seed_sha256
    || readbacks.artifact_1.digests.sequences !== manifest.canonical_contract.sequence_state_sha256
    || readbacks.artifact_1.digests.acl_security !== manifest.canonical_contract.public_acl_security_sha256) {
    fail(`manifest canonical contract does not match readback: ${JSON.stringify(proof)}`);
  }
  await writeFile(path.join(output, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  if (!proof.generated_outputs_byte_equal || !proof.artifact_outputs_byte_equal || !proof.source_contract_equal || !proof.artifact_contract_equal || !deparserDiff.allowed_definition_lines) {
    fail(`proof contract failed: ${JSON.stringify(proof)}`);
  }
  console.log(JSON.stringify(proof, null, 2));
}

await main();
