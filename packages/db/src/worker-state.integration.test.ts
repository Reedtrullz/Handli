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

interface RawSourceHealthClockRow {
  last_capture_success_at: unknown;
  last_discovery_success_at: unknown;
  last_publish_success_at: unknown;
  newest_eligible_evidence_at: unknown;
  status: unknown;
}

interface SourceHealthClockRow {
  last_capture_success_at: Date | null;
  last_discovery_success_at: Date | null;
  last_publish_success_at: Date | null;
  newest_eligible_evidence_at: Date | null;
  status: string;
}

const DATABASE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u;

function decodeDatabaseTimestamp(input: unknown, name: string): Date | null {
  if (input === null) return null;
  if (
    !(input instanceof Date)
    && (typeof input !== "string" || !DATABASE_TIMESTAMP_PATTERN.test(input))
  ) {
    throw new TypeError(`${name} must be a PostgreSQL timestamp`);
  }
  const value = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid PostgreSQL timestamp`);
  }
  return value;
}

function decodeSourceHealthClockRow(
  row: RawSourceHealthClockRow | undefined,
): SourceHealthClockRow {
  if (row === undefined) {
    throw new TypeError("PostgreSQL did not return the expected source-health row");
  }
  if (typeof row.status !== "string") {
    throw new TypeError("source-health status must be a string");
  }
  return {
    last_capture_success_at: decodeDatabaseTimestamp(
      row.last_capture_success_at,
      "last_capture_success_at",
    ),
    last_discovery_success_at: decodeDatabaseTimestamp(
      row.last_discovery_success_at,
      "last_discovery_success_at",
    ),
    last_publish_success_at: decodeDatabaseTimestamp(
      row.last_publish_success_at,
      "last_publish_success_at",
    ),
    newest_eligible_evidence_at: decodeDatabaseTimestamp(
      row.newest_eligible_evidence_at,
      "newest_eligible_evidence_at",
    ),
    status: row.status,
  };
}

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
      const healthRows = await connection.sql<{
        details: Record<string, unknown>;
        recorded_at: Date;
        review_queue_count: number;
        status: string;
        worker_job_id: string;
      }[]>`
        select worker_job_id, status, recorded_at, review_queue_count, details
        from source_health_snapshots
        where worker_job_id = ${input.jobId}
      `;
      expect(healthRows).toEqual([expect.objectContaining({
        details: {},
        review_queue_count: 0,
        status: "failed",
        worker_job_id: input.jobId,
      })]);
      await expect(repository.getLastScheduledAt({
        jobKind: input.jobKind,
        sourceId,
      })).resolves.toBe(scheduledAt.toISOString());
      await expect(repository.record({
        ...input,
        runId: `${input.runId}-conflict`,
      }, lease.fenceToken)).rejects.toBeInstanceOf(WorkerJobStateConflictError);

      const successfulJobId = `${sourceId}:catalog-refresh:2026-07-16T12:30:00.000Z`;
      const successfulCompletedAt = new Date("2026-07-16T12:30:02.000Z");
      await expect(repository.record({
        ...input,
        completedAt: successfulCompletedAt,
        counts: {
          accepted: 1,
          failed: 0,
          fetched: 1,
          persisted: 1,
          quarantined: 0,
          unknown: 0,
        },
        jobId: successfulJobId,
        scheduledAt: new Date("2026-07-16T12:30:00.000Z"),
        startedAt: new Date("2026-07-16T12:30:01.000Z"),
        status: "succeeded",
      }, lease.fenceToken)).resolves.toEqual({ created: true });
      const [successfulHealth] = await connection.sql<RawSourceHealthClockRow[]>`
        select
          status,
          last_discovery_success_at,
          last_capture_success_at,
          last_publish_success_at,
          newest_eligible_evidence_at
        from source_health_snapshots
        where worker_job_id = ${successfulJobId}
      `;
      expect(decodeSourceHealthClockRow(successfulHealth)).toEqual({
        last_capture_success_at: successfulCompletedAt,
        last_discovery_success_at: successfulCompletedAt,
        last_publish_success_at: null,
        newest_eligible_evidence_at: null,
        status: "healthy",
      });

      const forgedJobId = `${sourceId}:catalog-refresh:2026-07-16T12:45:00.000Z`;
      await connection.sql`
        insert into worker_job_results (
          job_id, source_id, job_kind, scheduled_at, run_id, status,
          started_at, completed_at, counts, result_hash
        ) values (
          ${forgedJobId}, ${sourceId}, 'catalog-refresh',
          '2026-07-16T12:45:00Z', ${`forged-health-run-${nonce}`}, 'failed',
          '2026-07-16T12:45:01Z', '2026-07-16T12:45:02Z',
          '{"accepted":0,"failed":1,"fetched":0,"persisted":0,"quarantined":0,"unknown":0}'::jsonb,
          ${"e".repeat(64)}
        )
      `;
      await expect(connection.sql`
        insert into source_health_snapshots (
          worker_job_id, source_id, status, last_discovery_success_at,
          last_capture_success_at, details, recorded_at
        ) values (
          ${forgedJobId}, ${sourceId}, 'failed', '2026-07-16T12:45:02Z',
          '2026-07-16T12:45:02Z', '{}'::jsonb, '2026-07-16T12:45:02Z'
        )
      `).rejects.toThrow(/success must match deterministic job progress/i);
      const [forgedHealth] = await connection.sql<{ count: number }[]>`
        select count(*)::integer as count
        from source_health_snapshots
        where worker_job_id = ${forgedJobId}
      `;
      expect(forgedHealth?.count).toBe(0);

      const cancelledJobId = `${sourceId}:catalog-refresh:2026-07-16T13:00:00.000Z`;
      await expect(repository.record({
        ...input,
        completedAt: new Date("2026-07-16T13:00:02.000Z"),
        counts: {
          accepted: 0,
          failed: 0,
          fetched: 0,
          persisted: 0,
          quarantined: 0,
          unknown: 0,
        },
        jobId: cancelledJobId,
        scheduledAt: new Date("2026-07-16T13:00:00.000Z"),
        startedAt: new Date("2026-07-16T13:00:01.000Z"),
        status: "cancelled",
      }, lease.fenceToken)).resolves.toEqual({ created: true });
      const [cancelledHealth] = await connection.sql<{ count: number }[]>`
        select count(*)::integer as count
        from source_health_snapshots
        where worker_job_id = ${cancelledJobId}
      `;
      expect(cancelledHealth?.count).toBe(0);

      const officialIngestionJobId =
        `${sourceId}:official-offer-ingestion:2026-07-16T13:30:00.000Z`;
      const officialIngestionCompletedAt = new Date("2026-07-16T13:30:02.000Z");
      await expect(repository.record({
        ...input,
        completedAt: officialIngestionCompletedAt,
        counts: {
          accepted: 1,
          failed: 0,
          fetched: 1,
          persisted: 1,
          quarantined: 0,
          unknown: 0,
        },
        jobId: officialIngestionJobId,
        jobKind: "official-offer-ingestion",
        scheduledAt: new Date("2026-07-16T13:30:00.000Z"),
        sourceId,
        startedAt: new Date("2026-07-16T13:30:01.000Z"),
        status: "succeeded",
      }, lease.fenceToken)).resolves.toEqual({ created: true });
      const [officialHealth] = await connection.sql<RawSourceHealthClockRow[]>`
        select
          status,
          last_discovery_success_at,
          last_capture_success_at,
          last_publish_success_at,
          newest_eligible_evidence_at
        from source_health_snapshots
        where worker_job_id = ${officialIngestionJobId}
      `;
      expect(decodeSourceHealthClockRow(officialHealth)).toEqual({
        last_capture_success_at: officialIngestionCompletedAt,
        last_discovery_success_at: officialIngestionCompletedAt,
        last_publish_success_at: null,
        newest_eligible_evidence_at: null,
        status: "healthy",
      });

      const lifecycleJobId =
        `${sourceId}:official-offer-lifecycle-reconcile:2026-07-16T13:40:00.000Z`;
      await expect(repository.record({
        ...input,
        completedAt: new Date("2026-07-16T13:40:02.000Z"),
        counts: {
          accepted: 0,
          failed: 0,
          fetched: 0,
          persisted: 0,
          quarantined: 0,
          unknown: 0,
        },
        jobId: lifecycleJobId,
        jobKind: "official-offer-lifecycle-reconcile",
        scheduledAt: new Date("2026-07-16T13:40:00.000Z"),
        sourceId,
        startedAt: new Date("2026-07-16T13:40:01.000Z"),
        status: "succeeded",
      }, lease.fenceToken)).resolves.toEqual({ created: true });
      const [lifecycleEvidence] = await connection.sql<{
        health_count: number;
        result_count: number;
      }[]>`
        select
          (select count(*)::integer from worker_job_results
           where job_id = ${lifecycleJobId}) as result_count,
          (select count(*)::integer from source_health_snapshots
           where worker_job_id = ${lifecycleJobId}) as health_count
      `;
      expect(lifecycleEvidence).toEqual({ health_count: 0, result_count: 1 });
      await expect(connection.sql`
        insert into source_health_snapshots (
          worker_job_id, source_id, status, details, recorded_at
        ) values (
          ${lifecycleJobId}, ${sourceId}, 'degraded', '{}'::jsonb,
          '2026-07-16T13:40:02.000Z'
        )
      `).rejects.toThrow(/lifecycle results do not assert source-health/i);

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
