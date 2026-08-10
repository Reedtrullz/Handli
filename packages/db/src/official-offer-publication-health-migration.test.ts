import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, "deploy", "migrations");
const migrationPath = path.join(
  migrationsDirectory,
  "027_official_offer_publication_health.sql",
);

describe("official-offer publication-health migration", () => {
  it("precedes the image-evidence hardening and binds facts to final lifecycle state", async () => {
    const [files, migration] = await Promise.all([
      readdir(migrationsDirectory),
      readFile(migrationPath, "utf8"),
    ]);
    expect(files.filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file)).sort().at(-2))
      .toBe("027_official_offer_publication_health.sql");
    expect(migration).toContain(
      "create table public.official_offer_publication_health_facts",
    );
    expect(migration).toContain(
      "pre-existing published offers require reviewed health reconciliation",
    );
    expect(migration).toContain(
      "pre-existing positive lifecycle results require reviewed health reconciliation",
    );
    const approvedOffersLock = migration.indexOf(
      "lock table public.approved_offers in share row exclusive mode",
    );
    const lifecycleResultsLock = migration.indexOf(
      "lock table public.official_offer_lifecycle_job_results in share row exclusive mode",
    );
    const precondition = migration.indexOf(
      "do $official_offer_publication_health_precondition$",
    );
    const triggerInstall = migration.indexOf(
      "create trigger official_offer_lifecycle_publication_health",
    );
    expect(approvedOffersLock).toBeGreaterThanOrEqual(0);
    expect(lifecycleResultsLock).toBeGreaterThan(approvedOffersLock);
    expect(precondition).toBeGreaterThan(lifecycleResultsLock);
    expect(triggerInstall).toBeGreaterThan(precondition);
    expect(migration).toMatch(
      /from public\.official_offer_lifecycle_job_results result\s+where result\.published_count > 0/iu,
    );
    expect(migration).toContain("lifecycle_job_id varchar(200) not null unique");
    expect(migration).toContain("official_offer_publication_health_facts_append_only");
    expect(migration).toMatch(
      /create index official_offer_publication_health_final_state_idx\s+on public\.approved_offers \(source_id, updated_at\)\s+where status = 'published'/iu,
    );
    expect(migration).toContain(
      "after insert on public.official_offer_lifecycle_job_results",
    );
    expect(migration).toContain("and offer.status = 'published'");
    expect(migration).toContain(
      "v_final_published_count is distinct from new.published_count",
    );
    expect(migration).toContain("newest_eligible_evidence_at <= last_publish_success_at");
    expect(migration).toContain("last_publish_success_at <= persisted_at");
    expect(migration).not.toMatch(/grant\s+(?:insert|update|delete)/iu);
  });

  it("merges governed clocks into operations while leaving dormant alerts denied", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain(
      "official_offer_publication_health_operations_projection",
    );
    expect(migration).toContain("publication_health.last_publish_success_at");
    expect(migration).toContain("publication_health.newest_eligible_evidence_at");
    expect(migration).toMatch(
      /publication_health\.persisted_at > health\.persisted_at[\s\S]*?\) then 'degraded'/iu,
    );
    expect(migration).not.toContain(
      "when health.status = 'healthy' then 'healthy'",
    );
    expect(migration).toContain("then null::text");
    expect(migration).toContain(
      "revoke all on function public.append_operations_alert_evaluation_v1(",
    );
    expect(migration).toContain(
      "revoke all on function public.operations_alert_export_rows_v1(",
    );
    expect(migration).toContain(
      "grant execute on function public.operations_dashboard_rows_v1(",
    );
  });

  it("pins readiness and gives public status only the non-sensitive fact columns", async () => {
    const [runner, readiness, sourceStatus] = await Promise.all([
      readFile(path.join(repositoryRoot, "deploy", "migrate.mjs"), "utf8"),
      readFile(path.join(
        repositoryRoot,
        "apps",
        "web",
        "lib",
        "server",
        "readiness.ts",
      ), "utf8"),
      readFile(path.join(repositoryRoot, "packages", "db", "src", "source-status-reader.ts"), "utf8"),
    ]);
    expect(readiness).toContain('"028_private_review_image_evidence_only.sql"');
    expect(runner).toContain("webOfficialOfferPublicationHealthColumns");
    expect(runner).not.toMatch(
      /webOfficialOfferPublicationHealthColumns[\s\S]*?lifecycle_job_id/iu,
    );
    expect(sourceStatus).toContain("ranked_publication_health");
    expect(sourceStatus).toContain("official_offer_publication_health_facts fact");
    expect(sourceStatus).toContain("publication_health.last_publish_success_at");
  });
});
