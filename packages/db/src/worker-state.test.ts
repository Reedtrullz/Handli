import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import type { IngestionFenceVerifier } from "./ingestion";
import {
  PostgresWorkerJobStateRepository,
  WorkerJobStateConflictError,
  canonicalWorkerJobResult,
  hashWorkerJobResult,
} from "./worker-state";

const result = {
  completedAt: new Date("2026-07-16T12:00:02.000Z"),
  counts: {
    accepted: 2,
    failed: 0,
    fetched: 3,
    persisted: 3,
    quarantined: 0,
    unknown: 1,
  },
  jobId: "kassalapp:benchmark-price-refresh:2026-07-16T12:00:00.000Z",
  jobKind: "benchmark-price-refresh",
  runId: "run-1",
  scheduledAt: new Date("2026-07-16T12:00:00.000Z"),
  sourceId: "kassalapp",
  startedAt: new Date("2026-07-16T12:00:01.000Z"),
  status: "succeeded",
} as const;

function fakeDatabase(options: {
  existing?: Record<string, unknown>;
  inserted?: boolean;
  latest?: string;
} = {}) {
  const insertedValues: unknown[] = [];
  const transaction = {
    insert: vi.fn(() => ({
      values: (value: unknown) => {
        insertedValues.push(value);
        return {
          onConflictDoNothing: () => ({
            returning: async () => options.inserted === false ? [] : [{ id: 17 }],
          }),
        };
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => options.existing === undefined ? [] : [options.existing] }),
      }),
    })),
  };
  const query = Object.assign(
    Promise.resolve(options.latest === undefined ? [] : [{ scheduled_at: options.latest }]),
    { cancel: vi.fn() },
  );
  const client = vi.fn(() => query);
  const db = {
    $client: client,
    transaction: async (callback: (value: typeof transaction) => unknown) => await callback(transaction),
  } as unknown as HandleplanDatabase;
  return { client, db, insertedValues, query, transaction };
}

describe("worker job state", () => {
  it("canonicalizes exact counters and hashes independently of object key order", () => {
    const canonical = canonicalWorkerJobResult(result);
    expect(canonical).toEqual(result);
    expect(hashWorkerJobResult(result)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWorkerJobResult({
      ...result,
      counts: {
        unknown: 1,
        quarantined: 0,
        persisted: 3,
        fetched: 3,
        failed: 0,
        accepted: 2,
      },
    })).toBe(hashWorkerJobResult(result));
  });

  it("rejects malformed accounting and identities before touching PostgreSQL", async () => {
    const { db, transaction } = fakeDatabase();
    const verifyFence = vi.fn(async (..._args: Parameters<IngestionFenceVerifier>) => undefined);
    const repository = new PostgresWorkerJobStateRepository(db, { verifyFence });

    await expect(repository.record({
      ...result,
      counts: { ...result.counts, persisted: 2 },
    }, "fence-1")).rejects.toBeInstanceOf(TypeError);
    await expect(repository.record({
      ...result,
      sourceId: " ",
    }, "fence-1")).rejects.toBeInstanceOf(TypeError);
    expect(transaction.insert).not.toHaveBeenCalled();
    expect(verifyFence).not.toHaveBeenCalled();
  });

  it("verifies the live fence and appends one result without persisting the token", async () => {
    const { db, insertedValues } = fakeDatabase();
    const verifyFence = vi.fn(async (..._args: Parameters<IngestionFenceVerifier>) => undefined);
    const repository = new PostgresWorkerJobStateRepository(db, { verifyFence });

    await expect(repository.record(result, "private-fence-token")).resolves.toEqual({ created: true });
    expect(verifyFence.mock.calls.map(([, context, phase]) => ({ context, phase }))).toEqual([
      {
        context: {
          fenceToken: "private-fence-token",
          jobId: result.jobId,
          sourceId: "kassalapp",
        },
        phase: "initial",
      },
      {
        context: {
          fenceToken: "private-fence-token",
          jobId: result.jobId,
          sourceId: "kassalapp",
        },
        phase: "before-commit",
      },
    ]);
    expect(insertedValues).toHaveLength(1);
    expect(JSON.stringify(insertedValues[0])).not.toContain("private-fence-token");
    expect(insertedValues[0]).toEqual(expect.objectContaining({
      jobId: result.jobId,
      resultHash: hashWorkerJobResult(result),
    }));
  });

  it("accepts an exact idempotent replay and rejects a conflicting job identity", async () => {
    const canonical = canonicalWorkerJobResult(result);
    const exact = fakeDatabase({
      inserted: false,
      existing: {
        completedAt: canonical.completedAt,
        jobKind: canonical.jobKind,
        resultHash: hashWorkerJobResult(canonical),
        scheduledAt: canonical.scheduledAt,
        sourceId: canonical.sourceId,
      },
    });
    const exactRepository = new PostgresWorkerJobStateRepository(exact.db, {
      verifyFence: async () => undefined,
    });
    await expect(exactRepository.record(result, "fence-1")).resolves.toEqual({ created: false });

    const conflicting = fakeDatabase({
      inserted: false,
      existing: {
        completedAt: canonical.completedAt,
        jobKind: "catalog-refresh",
        resultHash: hashWorkerJobResult(canonical),
        scheduledAt: canonical.scheduledAt,
        sourceId: canonical.sourceId,
      },
    });
    const conflictingRepository = new PostgresWorkerJobStateRepository(conflicting.db, {
      verifyFence: async () => undefined,
    });
    await expect(conflictingRepository.record(result, "fence-1")).rejects.toBeInstanceOf(
      WorkerJobStateConflictError,
    );
  });

  it("reads the latest scheduled slot with an abortable bounded query", async () => {
    const { db, query } = fakeDatabase({ latest: "2026-07-16T12:00:00.000Z" });
    const repository = new PostgresWorkerJobStateRepository(db, {
      verifyFence: async () => undefined,
    });

    await expect(repository.getLastScheduledAt({
      jobKind: "benchmark-price-refresh",
      sourceId: "kassalapp",
    })).resolves.toBe("2026-07-16T12:00:00.000Z");

    const controller = new AbortController();
    controller.abort();
    await expect(repository.getLastScheduledAt({
      jobKind: "benchmark-price-refresh",
      sourceId: "kassalapp",
    }, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(query.cancel).not.toHaveBeenCalled();
  });
});
