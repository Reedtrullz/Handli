import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, "deploy", "migrations");
const migrationPath = path.join(
  migrationsDirectory,
  "026_official_offer_publication_runtime.sql",
);
const trustFenceMigrationPath = path.join(
  migrationsDirectory,
  "020_official_offer_trust_fences.sql",
);
const migrationRunner = path.join(repositoryRoot, "deploy", "migrate.mjs");

describe("official-offer publication runtime migration", () => {
  it("is the forward-only migration after renderer and operations boundaries", async () => {
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
      .sort();
    expect(files.at(-3)).toBe("024_operations_runtime_boundary.sql");
    expect(files.at(-2)).toBe("025_private_review_evidence_renderer.sql");
    expect(files.at(-1)).toBe("026_official_offer_publication_runtime.sql");
  });

  it("owns an inactive policy, dedicated lease and immutable job boundary", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("create table public.official_offer_publication_policy");
    expect(migration).toMatch(
      /'official-offer-publication-v1', false, 1, pg_catalog\.clock_timestamp\(\)/u,
    );
    expect(migration).toContain("create table public.official_offer_lifecycle_leases");
    expect(migration).toContain("expiry_cursor_offer_id bigint not null default 0");
    expect(migration).toContain("publication_cursor_offer_id bigint not null default 0");
    expect(migration).toContain(
      "on conflict on constraint official_offer_lifecycle_leases_pkey do update",
    );
    expect(migration).toContain("create table public.official_offer_lifecycle_job_results");
    expect(migration).toContain("official_offer_lifecycle_job_results_append_only");
    expect(migration).toContain("HP_OFFER_LIFECYCLE_DEDICATED_BOUNDARY_REQUIRED");
    expect(migration).toContain(
      "revoke all on table public.official_offer_publication_policy from handleplan_app",
    );
    expect(migration).not.toMatch(
      /\b(?:insert\s+into|update|delete\s+from|from|join)\s+(?:public\.)?worker_leases\b/iu,
    );
    expect(migration).not.toContain("source_health_snapshots");
  });

  it("uses one DB-clock transaction and the exact v2 public projection", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("create function public.official_offer_lifecycle_reconcile_v1(");
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog, pg_temp");
    expect(migration).toContain("set statement_timeout = '5000ms'");
    expect(migration).toContain("set lock_timeout = '500ms'");
    expect(migration).toContain("v_started_at := pg_catalog.clock_timestamp()");
    expect(migration).toContain("p_scheduled_at > v_started_at");
    expect(migration).toContain("v_publication_authorized := p_publication_requested");
    expect(migration).toContain("and v_database_publication_enabled");
    expect(migration).toContain("if v_publication_authorized and v_source_is_current then");
    expect(migration).toContain("v_old text := 'and review.decision_boundary_version = 1'");
    expect(migration).toContain("v_new text := 'and review.decision_boundary_version = 2'");
    expect(migration).toContain("public.public_official_offer_rows_v1(");
    expect(migration).toContain("array[requested.product_id]");
    expect(migration).toContain(
      "v_publication_projection_as_of := pg_catalog.clock_timestamp()",
    );
    expect(migration).toContain(
      "array[requested.product_id], v_publication_projection_as_of",
    );
    expect(migration).toContain("projected.product_offer_count <= 50");
    expect(migration).toContain("projected.total_offer_count <= 50");
    expect(migration).not.toContain("private_review_evidence_consumptions");
    expect(migration).not.toContain("skip locked");
    expect(migration).not.toContain("pg_catalog.coalesce(");
    const projection = await readFile(path.join(
      migrationsDirectory,
      "022_public_official_offer_projection.sql",
    ), "utf8");
    expect(projection).toContain(
      "candidate.normalized_fields ->> 'publicationRoute' = 'human-review-required'",
    );
    expect(projection).toContain("'exact-match', 'review-required'");
    expect(projection).toContain("= 'product:' || target.product_id::text");
    expect(projection).toContain("offer.created_at <= offer.approved_at");
    expect(projection).not.toContain("offer.approved_at <= offer.created_at");
    expect(projection).not.toContain(
      "not (candidate.normalized_fields ? 'exactCanonicalProductId')",
    );
  });

  it("stamps offer state after lock waits instead of backdating it to statement start", async () => {
    const migration = await readFile(trustFenceMigrationPath, "utf8");
    const functionStart = migration.indexOf(
      "create function stamp_approved_offer_state_clock()",
    );
    const functionEnd = migration.indexOf("$$;", functionStart);
    const stateClock = migration.slice(functionStart, functionEnd);

    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(stateClock).toContain(
      "new.updated_at := pg_catalog.clock_timestamp()",
    );
    expect(stateClock).not.toContain("statement_timestamp()");
  });

  it("serializes shared products and keeps status changes one-way", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.match(/for update of product/g)).toHaveLength(2);
    expect(migration.match(/for share of identifier/g)).toHaveLength(2);
    expect(migration).toContain("approved_offers_z_lifecycle_transition");
    expect(migration).toContain(
      "old.status = 'approved'\n         and new.status in ('published', 'expired', 'revoked')",
    );
    expect(migration).toContain(
      "old.status = 'published' and new.status in ('expired', 'revoked')",
    );
    expect(migration).toContain("hashtextextended(p_source_id, 7229164304)");
    expect(migration).toContain("7229164306");
    expect(migration).toContain("7229164307");
  });

  it("promotes all three operations predicates and restores exact runtime ACL", async () => {
    const [migration, runner] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(migrationRunner, "utf8"),
    ]);
    expect(migration).toContain(
      "v_old text := 'and current_action.decision_boundary_version = 1'",
    );
    expect(migration).toContain(
      "v_new text := 'and current_action.decision_boundary_version = 2'",
    );
    expect(migration).toContain("if v_occurrences <> 3 then");
    expect(runner).toContain('"026_official_offer_publication_runtime.sql"');
    expect(runner).toContain("if (officialOfferLifecycleRuntimeEnabled)");
    expect(runner).toContain(
      "grant execute on function public.official_offer_lifecycle_reconcile_v1(",
    );
    expect(runner).toContain(
      "text, text, text, timestamp with time zone, text, integer, boolean",
    );
  });
});
