import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { ingestionWorkerLeaseKey, PostgresWorkerLeaseAdapter } from "./worker-lease";
import {
  PostgresWorkerJobStateRepository,
  WorkerJobStateConflictError,
} from "./worker-state";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${process.pid}-${Date.now()}`;
const sourceId = `state-test-${nonce}`.slice(0, 64);
const scheduledAt = new Date("2026-07-16T12:00:00.000Z");

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresWorkerJobStateRepository integration",
  () => {
    let connection: DatabaseConnection;
    let leaseAdapter: PostgresWorkerLeaseAdapter;
    let repository: PostgresWorkerJobStateRepository;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
      leaseAdapter = new PostgresWorkerLeaseAdapter(connection.db);
      repository = new PostgresWorkerJobStateRepository(connection.db, {
        verifyFence: leaseAdapter.verifyFence,
      });
      await connection.sql`
        insert into data_sources (id, display_name, source_kind, runtime_state)
        values (${sourceId}, 'Worker state integration fixture', 'catalog', 'blocked')
      `;
    });

    afterAll(async () => {
      await connection?.close();
    });

    it("appends one fenced result, converges exact replay, and rejects conflicts", async () => {
      const lease = (await leaseAdapter.acquire({
        leaseKey: ingestionWorkerLeaseKey({ sourceId }),
        ownerId: `worker-state-integration-${nonce}`,
        ttlMs: 30_000,
      }))!;
      const input = {
        completedAt: new Date("2026-07-16T12:00:02.000Z"),
        counts: {
          accepted: 0,
          failed: 1,
          fetched: 0,
          persisted: 0,
          quarantined: 0,
          unknown: 0,
        },
        jobId: `${sourceId}:catalog-refresh:2026-07-16T12:00:00.000Z`,
        jobKind: "catalog-refresh" as const,
        runId: `worker-state-run-${nonce}`,
        scheduledAt,
        sourceId,
        startedAt: new Date("2026-07-16T12:00:01.000Z"),
        status: "failed" as const,
      };

      await expect(repository.record(input, lease.fenceToken)).resolves.toEqual({ created: true });
      await expect(repository.record(input, lease.fenceToken)).resolves.toEqual({ created: false });
      await expect(repository.getLastScheduledAt({
        jobKind: input.jobKind,
        sourceId,
      })).resolves.toBe(scheduledAt.toISOString());
      await expect(repository.record({
        ...input,
        runId: `${input.runId}-conflict`,
      }, lease.fenceToken)).rejects.toBeInstanceOf(WorkerJobStateConflictError);

      await lease.release();
      await expect(repository.record({
        ...input,
        jobId: `${sourceId}:catalog-refresh:2026-07-17T12:00:00.000Z`,
        scheduledAt: new Date("2026-07-17T12:00:00.000Z"),
        startedAt: new Date("2026-07-17T12:00:01.000Z"),
        completedAt: new Date("2026-07-17T12:00:02.000Z"),
      }, lease.fenceToken)).rejects.toMatchObject({ code: "STALE_FENCE" });
    });
  },
);
