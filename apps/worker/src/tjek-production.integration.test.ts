import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@handleplan/db/client";
import { describe, expect, it } from "vitest";
import { createTjekFoundationDependencies } from "./tjek-production";
import { createTjekHandlers, TJEK_JOB_KIND } from "./tjek-handlers";

const integration = process.env.RUN_OFFICIAL_OFFER_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("Tjek production foundation under worker role", () => {
  it("persists review evidence with app grants and deduplicates a complete capture", async () => {
    const admin = createDatabase(process.env.DATABASE_MIGRATION_URL!);
    const connection = createDatabase(process.env.APP_DATABASE_URL!);
    const root = await mkdtemp(join(tmpdir(), "handleplan-tjek-proof-"));
    try {
      // Synthetic authorization fixture; production permission is never modified.
      await admin.sql`insert into source_permissions (source_id, decision, reviewed_at, permissions)
        values ('tjek', 'approved', ${new Date(Date.now() - 1_000).toISOString()},
          '{"officialOffers":true,"officialOfferCapabilities":["capture","discover","extract"],"officialOfferRightsClassifications":["public_display"]}'::jsonb)`;
      await admin.sql`update data_sources source set permission_reviewed_at = permission.reviewed_at,
        permission_expires_at = permission.valid_until from source_permissions permission
        where source.id = 'tjek' and permission.id =
          (select id from source_permissions where source_id = 'tjek' order by created_at desc, id desc limit 1)`;
      const catalog = {
        id: `integration-${randomUUID()}`, dealer_id: "5b11sm",
        publication_date: new Date().toISOString().slice(0, 10),
        run_from: new Date(Date.now() - 60_000).toISOString(),
        run_till: new Date(Date.now() + 86_400_000).toISOString(),
        all_stores: true, dealer: { country: { id: "NO" }, markets: [{ country_code: "NO" }] },
      };
      const client = {
        getAllLatestCatalogs: async () => [catalog], canExtractOffers: () => true,
        getOffersFromCatalog: async () => [{ id: "milk", name: "Synthetic milk", price: 20, currency: "NOK", before_price: null, run_from: catalog.run_from, run_till: catalog.run_till }],
      };
      const foundation = createTjekFoundationDependencies(connection.db, root);
      const handler = createTjekHandlers({ client: client as never, foundation })[TJEK_JOB_KIND]!;
      const context = { signal: new AbortController().signal, sourceId: "tjek", jobId: "integration", runId: randomUUID(), fenceToken: "integration", kind: TJEK_JOB_KIND };
      const first = await handler(context);
      expect(first.counters?.persisted).toBe(1);
      expect(first.counters?.quarantined).toBe(1);
      expect(first.counters?.accepted).toBe(0);
      const second = await handler(context);
      expect(second.counters?.persisted).toBe(0);
      expect(second.counters?.failed).toBe(first.counters?.failed);
      const rows = await connection.sql`
        select extraction.status, extraction.counts,
          (select count(*)::integer from extracted_offer_candidates candidate where candidate.extraction_run_id = extraction.id) as candidates
        from publications publication
        join publication_captures capture on capture.publication_id = publication.id
        join extraction_runs extraction on extraction.capture_id = capture.id
        where publication.source_id = 'tjek' and publication.external_id = ${catalog.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.candidates).toBe(1);
    } finally {
      await Promise.all([connection.close(), admin.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
