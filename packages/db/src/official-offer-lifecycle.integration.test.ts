import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  OfficialOfferLifecycleRepositoryError,
  PostgresOfficialOfferLifecycleRepository,
  type OfficialOfferLifecycleRequestV1,
} from "./official-offer-lifecycle";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Lifecycle integration fixture returned an invalid database timestamp");
  }
  return parsed;
}

describe.skipIf(!runDatabaseIntegration).sequential(
  "official-offer lifecycle PostgreSQL boundary",
  () => {
    let connection: DatabaseConnection;

    beforeAll(() => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
    });

    afterAll(async () => {
      await connection?.close();
    });

    it("expires a bounded page while publication stays DB-disabled and replays immutably", async () => {
      const suffix = randomUUID();
      const sourceId = `offer-lifecycle-${suffix}`.slice(0, 64);
      const [clock] = await connection.sql<Array<{ now: Date }>>`
        select date_trunc('milliseconds', clock_timestamp()) as now
      `;
      const scheduledAt = databaseDate(clock!.now);
      const validFrom = new Date(scheduledAt.getTime() - 2 * 60 * 60_000);
      const validUntil = new Date(scheduledAt.getTime() - 60 * 60_000);

      await connection.sql`
        insert into data_sources (id, display_name, source_kind, runtime_state)
        values (${sourceId}, 'Synthetic lifecycle integration source', 'offer', 'blocked')
      `;
      const [scope] = await connection.sql<Array<{ id: string }>>`
        insert into geographic_scopes (scope_key, scope_kind, label, country_code)
        values (${`lifecycle:${suffix}`}, 'national', 'Synthetic lifecycle scope', 'NO')
        returning id
      `;
      const [product] = await connection.sql<Array<{ id: string }>>`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack
        ) values ('Synthetic lifecycle product', 1, 'piece', 1)
        returning id
      `;
      const [offer] = await connection.sql<Array<{ id: string }>>`
        insert into approved_offers (
          offer_key, source_id, source_reference, chain, geographic_scope_id,
          amount_ore, membership_requirement, valid_from, valid_until,
          status, version, approved_at
        ) values (
          ${`lifecycle:${suffix}`}, ${sourceId}, ${`synthetic:${suffix}`},
          'extra', ${scope!.id}, 1990, 'public',
          ${validFrom.toISOString()}, ${validUntil.toISOString()},
          'approved', 1, ${validFrom.toISOString()}
        )
        returning id
      `;
      await connection.sql`
        insert into offer_targets (
          offer_id, product_id, family_slug, match_method, match_confidence
        ) values (${offer!.id}, ${product!.id}, null, 'human_review', 100)
      `;

      const repository = new PostgresOfficialOfferLifecycleRepository(connection.db);
      const request: OfficialOfferLifecycleRequestV1 = {
        batchLimit: 50,
        contractVersion: 1,
        jobId: `${sourceId}:lifecycle:${suffix}`,
        ownerId: `integration-owner:${suffix}`,
        publicationRequested: true,
        runId: `integration-run:${suffix}`,
        scheduledAt,
        sourceId,
      };

      const receipt = await repository.reconcile(request);
      expect(receipt).toMatchObject({
        expiredCount: 1,
        expiryExamined: 1,
        outcome: "completed",
        publicationExamined: 0,
        publicationState: "foundation-disabled",
        publishedCount: 0,
        replayed: false,
        revokedCount: 0,
        skippedCount: 0,
      });
      const [stored] = await connection.sql<Array<{
        detail_count: number;
        health_count: number;
        publication_authorized: boolean;
        publication_requested: boolean;
        status: string;
      }>>`
        select
          offer.status,
          detail.publication_requested,
          detail.publication_authorized,
          (select count(*)::integer
             from official_offer_lifecycle_job_results immutable
            where immutable.job_id = ${request.jobId}) as detail_count,
          (select count(*)::integer
             from source_health_snapshots health
            where health.worker_job_id = ${request.jobId}) as health_count
        from approved_offers offer
        cross join official_offer_lifecycle_job_results detail
        where offer.id = ${offer!.id}
          and detail.job_id = ${request.jobId}
      `;
      expect(stored).toEqual({
        detail_count: 1,
        health_count: 0,
        publication_authorized: false,
        publication_requested: true,
        status: "expired",
      });

      await expect(repository.reconcile(request)).resolves.toMatchObject({
        databaseAsOf: receipt.databaseAsOf,
        leaseExpiresAt: receipt.leaseExpiresAt,
        outcome: "replayed",
        replayed: true,
      });
      await expect(repository.reconcile({ ...request, batchLimit: 49 }))
        .rejects.toEqual(new OfficialOfferLifecycleRepositoryError("CONFLICT"));

      const [nextClock] = await connection.sql<Array<{ now: Date }>>`
        select date_trunc('milliseconds', clock_timestamp()) as now
      `;
      await expect(repository.reconcile({
        ...request,
        jobId: `${sourceId}:lifecycle-next:${suffix}`,
        runId: `integration-run-next:${suffix}`,
        scheduledAt: databaseDate(nextClock!.now),
      })).resolves.toMatchObject({
        expiryExamined: 0,
        outcome: "completed",
        publicationState: "foundation-disabled",
      });
      const [policy] = await connection.sql<Array<{ enabled: boolean }>>`
        select enabled
        from official_offer_publication_policy
        where policy_key = 'official-offer-publication-v1'
      `;
      expect(policy?.enabled).toBe(false);
    }, 30_000);
  },
);
