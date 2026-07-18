import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresPublicSourceStatusReader } from "./source-status-reader";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `source-status-${Date.now()}-${process.pid}`;
const sourceId = nonce.slice(0, 64);
const scopeKey = `${nonce}:scope`;
const now = Date.now();
const evaluatedAt = new Date(now + 5 * 60_000);
const privateSentinel = "PRIVATE-SOURCE-HEALTH-DETAIL-MUST-NOT-BE-READ";

describe.skipIf(!runDatabaseIntegration).sequential(
  "public source-status reader integration",
  () => {
    let admin: DatabaseConnection;
    let web: DatabaseConnection;
    let scopeId: number;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL || !process.env.WEB_DATABASE_URL) {
        throw new Error("DATABASE_URL and WEB_DATABASE_URL are required for DB integration");
      }
      admin = createDatabase(process.env.DATABASE_URL);
      web = createDatabase(process.env.WEB_DATABASE_URL);

      await admin.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId},
          'Source status integration fixture',
          'ordinary_price',
          'approved',
          ${new Date(now - 60 * 60_000).toISOString()},
          ${new Date(now + 24 * 60 * 60_000).toISOString()}
        )
      `;
      await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions
        ) values (
          ${sourceId},
          'approved',
          ${new Date(now - 60 * 60_000).toISOString()},
          ${new Date(now + 24 * 60 * 60_000).toISOString()},
          '{"ordinaryPrice":true}'::jsonb
        )
      `;
      const [scope] = await admin.sql`
        insert into geographic_scopes (
          scope_key, scope_kind, label, country_code, status
        ) values (
          ${scopeKey}, 'region', 'Integration region', 'NO', 'active'
        )
        returning id::integer as id
      `;
      if (typeof scope?.id !== "number") throw new Error("Missing source-status scope id");
      scopeId = scope.id;

      const [run] = await admin.sql`
        insert into ingestion_runs (
          job_id, source_id, run_type, status, started_at, counts
        ) values (
          ${`${nonce}:failed-run`},
          ${sourceId},
          'benchmark-prices',
          'running',
          ${new Date(now - 30 * 60_000).toISOString()},
          '{}'::jsonb
        )
        returning id::integer as id
      `;
      if (typeof run?.id !== "number") throw new Error("Missing source-status run id");
      await admin.sql`
        update ingestion_runs
        set
          status = 'failed',
          completed_at = ${new Date(now - 20 * 60_000).toISOString()},
          counts = '{"accepted":0,"failed":1,"fetched":0,"persisted":0,"quarantined":0,"unknown":0}'::jsonb,
          error_class = 'PRIVATE_PROVIDER_FAILURE'
        where id = ${run.id}
      `;

      await admin.sql`
        insert into source_health_snapshots (
          source_id,
          geographic_scope_id,
          status,
          last_discovery_success_at,
          newest_eligible_evidence_at,
          review_queue_count,
          oldest_review_age_seconds,
          details,
          recorded_at
        ) values (
          ${sourceId},
          ${scopeId},
          'degraded',
          ${new Date(now - 15 * 60_000).toISOString()},
          null,
          99,
          999,
          ${JSON.stringify({ privateSentinel })}::jsonb,
          ${new Date(now - 10 * 60_000).toISOString()}
        ), (
          ${sourceId},
          ${scopeId},
          'healthy',
          ${new Date(now - 3 * 60_000).toISOString()},
          ${new Date(now - 2 * 60_000).toISOString()},
          100,
          1_000,
          ${JSON.stringify({ privateSentinel })}::jsonb,
          ${new Date(now - 60_000).toISOString()}
        )
      `;
    });

    afterAll(async () => {
      await Promise.all([admin?.close(), web?.close()]);
    });

    it("reads the latest allowed row through the public web role", async () => {
      await expect(web.sql`select scope_key from geographic_scopes limit 1`)
        .rejects.toThrow(/permission denied/i);
      const directory = await new PostgresPublicSourceStatusReader(web.db)
        .read(50, evaluatedAt);
      const entry = directory.entries.find(({ source }) => source.id === sourceId);

      expect(entry).toMatchObject({
        governanceState: "approved",
        health: {
          freshness: "current",
          state: "healthy",
        },
        latestTerminalIngestion: {
          scope: "source-wide",
          state: "failed",
        },
        scope: {
          countryCode: "NO",
          kind: "region",
          label: "Integration region",
          state: "active",
        },
        source: {
          displayName: "Source status integration fixture",
          kind: "ordinary-price",
          runtimeState: "approved",
        },
      });
      expect(JSON.stringify(entry)).not.toContain(privateSentinel);
      expect(JSON.stringify(entry)).not.toMatch(/error|queue|review/i);
    });

    it("blocks later future-dated and backdated revocations without rewriting the earlier snapshot", async () => {
      const [clock] = await admin.sql`select clock_timestamp() as snapshot_at`;
      const snapshotAt = new Date(String(clock!.snapshot_at));
      const reader = new PostgresPublicSourceStatusReader(web.db);
      const baseline = await reader.read(50, snapshotAt);
      expect(baseline.entries.find(({ source }) => source.id === sourceId)?.governanceState)
        .toBe("approved");

      const [futureRevocation] = await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${sourceId}, 'revoked',
          ${new Date(snapshotAt.getTime() + 24 * 60 * 60_000).toISOString()},
          null, '{}'::jsonb, 'source-status future-dated revocation'
        )
        returning created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(futureRevocation?.created_later).toBe(true);
      const [afterFutureClock] = await admin.sql`
        select clock_timestamp() + interval '1 millisecond' as current_at
      `;
      const afterFuture = await reader.read(50, new Date(String(afterFutureClock!.current_at)));
      expect(afterFuture.entries.find(({ source }) => source.id === sourceId)?.governanceState)
        .toBe("not-approved");

      const [revocation] = await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes,
          created_at
        ) values (
          ${sourceId}, 'revoked',
          ${new Date(snapshotAt.getTime() - 2 * 60 * 60_000).toISOString()},
          null, '{}'::jsonb, 'source-status backdated revocation',
          '2000-01-01T00:00:00Z'
        )
        returning created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(revocation?.created_later).toBe(true);
      await expect(reader.read(50, snapshotAt)).resolves.toEqual(baseline);

      const [currentClock] = await admin.sql`
        select clock_timestamp() + interval '1 millisecond' as current_at
      `;
      const currentAt = new Date(String(currentClock!.current_at));
      const current = await reader.read(50, currentAt);
      expect(current.entries.find(({ source }) => source.id === sourceId)?.governanceState)
        .toBe("not-approved");
    });
  },
);
