import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
      // Synthetic authorization fixture in the disposable integration database.
      const reviewedAt = new Date(Date.now() - 1_000).toISOString();
      await admin.sql`insert into source_permissions (source_id, decision, reviewed_at, permissions)
        values ('tjek', 'approved', ${reviewedAt},
          '{"officialOffers":true,"officialOfferCapabilities":["capture","discover","extract"],"officialOfferRightsClassifications":["public_display"]}'::jsonb)`;
      await admin.sql`update data_sources source set runtime_state = 'approved',
        permission_reviewed_at = permission.reviewed_at,
        permission_expires_at = permission.valid_until from source_permissions permission
        where source.id = 'tjek' and permission.id =
          (select id from source_permissions where source_id = 'tjek' order by created_at desc, id desc limit 1)`;
      const [{ now: databaseNow }] = await admin.sql<{ now: Date }[]>`select clock_timestamp() as now`;
      const catalog = {
        id: `integration-${randomUUID()}`, dealer_id: "5b11sm",
        publication_date: new Date().toISOString().slice(0, 10),
        run_from: new Date(Date.now() - 60_000).toISOString(),
        run_till: new Date(Date.now() + 86_400_000).toISOString(),
        all_stores: true, dealer: { country: { id: "NO" }, markets: [{ country_code: "NO" }] },
      };
      const retryCatalog = {
        ...catalog,
        id: `integration-retry-${randomUUID()}`,
      };
      let catalogs = [catalog];
      let workerNow = new Date(databaseNow);
      const client = {
        getAllLatestCatalogs: async () => catalogs, canExtractOffers: () => true,
        getOffersFromCatalog: async (selectedCatalog: typeof catalog) => [{ id: "milk", name: "Synthetic milk", price: 20, currency: "NOK", before_price: null, run_from: selectedCatalog.run_from, run_till: selectedCatalog.run_till }],
      };
      const foundation = createTjekFoundationDependencies(connection.db, await realpath(root));
      const handler = createTjekHandlers({ client: client as never, foundation, clock: () => new Date(workerNow) })[TJEK_JOB_KIND]!;
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

      catalogs = [retryCatalog];
      const originalRecordExtraction = foundation.repository.recordExtraction.bind(foundation.repository);
      let failExtraction = true;
      foundation.repository.recordExtraction = async (...args) => {
        if (failExtraction) {
          failExtraction = false;
          throw new Error("injected extraction failure");
        }
        return originalRecordExtraction(...args);
      };
      const failedRetry = await handler(context);
      expect(failedRetry.counters?.persisted).toBe(0);
      expect(failedRetry.counters?.failed).toBe(1);
      const captureBeforeRetry = await connection.sql<{
        id: number;
        checksum: string;
        blob_key: string;
        byte_length: number;
        rights_classification: string;
        retrieved_at: string;
        capture_count: number;
      }[]>`
        select capture.id, capture.checksum, capture.blob_key,
          capture.byte_length, capture.rights_classification,
          to_char(capture.retrieved_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as retrieved_at,
          (select count(*)::integer from publication_captures sibling
            where sibling.publication_id = publication.id) as capture_count
        from publications publication
        join publication_captures capture on capture.publication_id = publication.id
        where publication.source_id = 'tjek' and publication.external_id = ${retryCatalog.id}`;
      expect(captureBeforeRetry).toHaveLength(1);
      expect(captureBeforeRetry[0]?.capture_count).toBe(1);
      await admin.sql`select pg_sleep(0.01)`;
      const [{ now: retryDatabaseNow }] = await admin.sql<{ now: Date | string }[]>`select clock_timestamp() as now`;
      workerNow = new Date(new Date(retryDatabaseNow).getTime() - 1);
      const successfulRetry = await handler(context);
      expect(successfulRetry.counters?.persisted).toBe(1);
      const captureAfterRetry = await connection.sql`
        select capture.id, capture.checksum, capture.blob_key,
          capture.byte_length, capture.rights_classification,
          to_char(capture.retrieved_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as retrieved_at,
          (select count(*)::integer from publication_captures sibling
            where sibling.publication_id = publication.id) as capture_count
        from publications publication
        join publication_captures capture on capture.publication_id = publication.id
        where publication.source_id = 'tjek' and publication.external_id = ${retryCatalog.id}`;
      expect(captureAfterRetry).toEqual(captureBeforeRetry);
      const retryRows = await connection.sql`
        select extraction.id
        from publications publication
        join publication_captures capture on capture.publication_id = publication.id
        join extraction_runs extraction on extraction.capture_id = capture.id
        where publication.source_id = 'tjek' and publication.external_id = ${retryCatalog.id}`;
      expect(retryRows).toHaveLength(1);
    } finally {
      await Promise.all([connection.close(), admin.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
