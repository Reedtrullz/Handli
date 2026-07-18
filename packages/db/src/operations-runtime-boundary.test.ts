import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL(
  "../../../deploy/migrations/024_operations_runtime_boundary.sql",
  import.meta.url,
));
const publicationHealthMigrationPath = fileURLToPath(new URL(
  "../../../deploy/migrations/027_official_offer_publication_health.sql",
  import.meta.url,
));
const runnerPath = fileURLToPath(new URL("../../../deploy/migrate.mjs", import.meta.url));
const composePath = fileURLToPath(new URL(
  "../../../deploy/compose.production.yml",
  import.meta.url,
));

describe("operations runtime database boundary", () => {
  it("exposes only fixed aggregate columns through a bounded security-definer function", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const signature = migration.match(
      /create function public\.operations_dashboard_rows_v1\([\s\S]*?returns table \(([\s\S]*?)\)\nlanguage plpgsql/u,
    )?.[1];
    expect(signature).toBeDefined();
    expect(signature).toContain("governance_state text");
    expect(signature).toContain("pending_review_rows bigint");
    expect(signature).toContain("latest_worker_results jsonb");
    expect(signature).not.toMatch(
      /actor|address|basket|blob|candidate_key|checksum|coordinate|details|error|gtin|normalized|reason|reference|request|token/iu,
    );
    expect(migration).toMatch(
      /operations_dashboard_rows_v1[\s\S]*security definer[\s\S]*set search_path = pg_catalog, pg_temp/u,
    );
    expect(migration).toContain("set statement_timeout = '3000ms'");
    expect(migration).toContain("set lock_timeout = '500ms'");
    expect(migration).toContain("pg_catalog.cardinality(p_source_ids) not between 1 and 100");
    expect(migration).toContain("operations source roster must be canonically sorted");
    expect(migration).not.toContain("pg_catalog.coalesce(");
    expect(migration.match(/limit 10001/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(migration.match(/health_job\.job_kind::text,/gu)).toHaveLength(1);
    expect(migration).toContain("health_job.source_id = source.id");
    expect(migration).toContain("health_job.persisted_at <= health.persisted_at");
    expect(migration).toContain("health_job.completed_at <= health_job.persisted_at");
    expect(migration).toContain("revoke all on function public.operations_dashboard_rows_v1");
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete|execute)/iu);
  });

  it("owns strict append/checkpoint state and a bounded transition-only export", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("create function public.append_operations_alert_evaluation_v1(");
    expect(migration).toContain("operations alert evaluation matrix is incomplete");
    expect(migration).toContain("operations alert assessments must be unique and canonically sorted");
    expect(migration).toContain("operations alert roster digest does not match canonical content");
    expect(migration).toContain("operations alert evaluation replay conflicts with checkpoint");
    expect(migration).toContain("returning persisted_at into strict v_checkpoint_persisted_at");
    expect(migration).toContain("create function public.operations_alert_export_rows_v1(");
    expect(migration).toContain("limit p_result_limit + 1");
    expect(migration).toContain("corrupt operations alert export row");
    expect(migration).toContain("alert_events_operations_checkpoint_idx");
    expect(migration).toContain("'official-offer-discovery'");
    expect(migration).toContain("'official-offer-fetch'");
  });

  it("database-stamps new evidence, preserves legacy rows as untrusted, and seals alerts", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("add column operations_boundary_version smallint");
    expect(migration).not.toContain("operations_boundary_version smallint default");
    expect(migration).toContain("new.operations_boundary_version := 1");
    expect(migration).toContain("new.persisted_at := pg_catalog.clock_timestamp()");
    expect(migration).toContain("create trigger alert_events_append_only");
    expect(migration).toContain("execute function public.reject_append_only_mutation()");
    expect(migration).toContain("where operations_boundary_version = 1");
  });

  it("keeps the disabled-alert operations role read-only and credentials process-local", async () => {
    const [runner, compose, publicationHealthMigration] = await Promise.all([
      readFile(runnerPath, "utf8"),
      readFile(composePath, "utf8"),
      readFile(publicationHealthMigrationPath, "utf8"),
    ]);
    expect(runner).toContain('const operationsRole = "handleplan_operations"');
    expect(runner).toContain("operationsRuntimeBoundaryEnabled");
    expect(runner).toMatch(
      /grant execute on function public\.operations_dashboard_rows_v1\([\s\S]*?to \$\{operationsRole\}/u,
    );
    expect(runner).toContain("officialOfferPublicationHealthEnabled");
    expect(publicationHealthMigration).toContain(
      "revoke all on function public.append_operations_alert_evaluation_v1(",
    );
    expect(publicationHealthMigration).toContain(
      "revoke all on function public.operations_alert_export_rows_v1(",
    );
    expect(runner).not.toMatch(/grant\s+(?:select|insert|update|delete)[^;]*\$\{operationsRole\}/iu);
    expect(runner).toContain("alter role ${operationsRole} set statement_timeout = '4s'");

    const app = compose.match(/  app:\n([\s\S]*?)\n  review:/u)?.[1] ?? "";
    const review = compose.match(/  review:\n([\s\S]*?)\n  operations:/u)?.[1] ?? "";
    const operations = compose.match(/  operations:\n([\s\S]*?)\n  worker:/u)?.[1] ?? "";
    expect(operations).toContain("handleplan_operations");
    expect(operations).toContain('OPERATIONS_ALERT_EVALUATION_ENABLED: "false"');
    expect(operations).toContain("127.0.0.1:3007:3000");
    expect(app).not.toContain("OPERATIONS_");
    expect(review).not.toContain("OPERATIONS_");
    expect(operations).not.toContain("REVIEW_DATABASE_URL");
    expect(operations).not.toMatch(/^\s+DATABASE_URL:/mu);
  });
});
