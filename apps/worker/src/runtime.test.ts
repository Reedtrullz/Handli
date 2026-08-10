import { describe, expect, it } from "vitest";

import { WorkerRunner, type WorkerJobHandler } from "./runner";
import {
  WorkerRuntime,
  type WorkerLeaseHandle,
  type WorkerLeaseProvider,
  type WorkerRuntimeStateStore,
} from "./runtime";
import type { WorkerScheduleDefinition } from "./schedule";

const NOW = new Date("2026-07-16T13:00:00.000Z");
const schedules: WorkerScheduleDefinition[] = [
  {
    anchorAt: "2026-01-01T00:15:00.000Z",
    intervalMs: 24 * 60 * 60 * 1_000,
    kind: "catalog-refresh",
    sourceId: "kassalapp",
    timeoutMs: 60_000,
  },
  {
    anchorAt: "2026-01-01T00:30:00.000Z",
    intervalMs: 6 * 60 * 60 * 1_000,
    kind: "benchmark-price-refresh",
    sourceId: "kassalapp",
    timeoutMs: 60_000,
  },
];

function createLeaseProvider(onRelease: () => void = () => undefined): WorkerLeaseProvider {
  return {
    acquire: async (): Promise<WorkerLeaseHandle> => ({
      fenceToken: "fence-1",
      release: async () => onRelease(),
      signal: new AbortController().signal,
    }),
  };
}

function createStateStore(
  recorded: Array<{ jobId: string; status: string; persisted: number }>,
  recordedFences: string[] = [],
): WorkerRuntimeStateStore {
  return {
    getLastScheduledAt: async () => undefined,
    recordResult: async (request, result, fence) => {
      recordedFences.push(fence.fenceToken);
      recorded.push({
        jobId: request.jobId,
        persisted: result.counters.persisted,
        status: result.status,
      });
    },
  };
}

describe("WorkerRuntime", () => {
  it("runs newest due slots in deterministic order and coalesces concurrent cycles", async () => {
    const recorded: Array<{ jobId: string; status: string; persisted: number }> = [];
    const recordedFences: string[] = [];
    const order: string[] = [];
    const handlerContexts: Array<{
      fenceToken: string;
      jobId: string;
      kind: string;
      sourceId: string;
    }> = [];
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handler = (label: string, gate?: Promise<void>): WorkerJobHandler => async (context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      handlerContexts.push({
        fenceToken: context.fenceToken,
        jobId: context.jobId,
        kind: context.kind,
        sourceId: context.sourceId,
      });
      order.push(`${label}:start`);
      await gate;
      order.push(`${label}:finish`);
      active -= 1;
      return { counters: { accepted: 1, fetched: 1, persisted: 1 } };
    };
    const runner = new WorkerRunner({
      createRunId: ({ jobId }) => `run:${jobId}`,
      handlers: {
        "benchmark-price-refresh": handler("prices"),
        "catalog-refresh": handler("catalog", firstGate),
      },
      now: () => NOW,
    });
    const runtime = new WorkerRuntime({
      leaseProvider: createLeaseProvider(),
      now: () => NOW,
      runner,
      schedules: [...schedules].reverse(),
      shutdownGraceMs: 100,
      stateStore: createStateStore(recorded, recordedFences),
    });

    const first = runtime.runCycle();
    const second = runtime.runCycle();
    await Promise.resolve();
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "catalog:start",
      "catalog:finish",
      "prices:start",
      "prices:finish",
    ]);
    expect(recorded.map(({ jobId }) => jobId)).toEqual([
      "kassalapp:catalog-refresh:2026-07-16T00:15:00.000Z",
      "kassalapp:benchmark-price-refresh:2026-07-16T12:30:00.000Z",
    ]);
    expect(recordedFences).toEqual(["fence-1", "fence-1"]);
    expect(handlerContexts).toEqual([
      {
        fenceToken: "fence-1",
        jobId: "kassalapp:catalog-refresh:2026-07-16T00:15:00.000Z",
        kind: "catalog-refresh",
        sourceId: "kassalapp",
      },
      {
        fenceToken: "fence-1",
        jobId: "kassalapp:benchmark-price-refresh:2026-07-16T12:30:00.000Z",
        kind: "benchmark-price-refresh",
        sourceId: "kassalapp",
      },
    ]);
  });

  it("drains on the first shutdown request, joins cleanup, and admits no new work", async () => {
    const recorded: Array<{ jobId: string; status: string; persisted: number }> = [];
    let starts = 0;
    let sawAbort = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const handler: WorkerJobHandler = async ({ signal }) => {
      starts += 1;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve();
      }, { once: true }));
      await cleanup;
      return { counters: { fetched: 1, persisted: 1, unknown: 1 } };
    };
    const runtime = new WorkerRuntime({
      leaseProvider: createLeaseProvider(),
      now: () => NOW,
      runner: new WorkerRunner({
        createRunId: ({ jobId }) => `run:${jobId}`,
        handlerShutdownGraceMs: 100,
        handlers: { "catalog-refresh": handler },
        now: () => NOW,
      }),
      schedules: [schedules[0]!],
      shutdownGraceMs: 100,
      stateStore: createStateStore(recorded),
    });

    const cycle = runtime.runCycle();
    while (starts === 0) await Promise.resolve();
    const shutdown = runtime.requestShutdown();
    expect(runtime.requestShutdown()).toBe(shutdown);
    expect(runtime.status).toBe("draining");
    expect(sawAbort).toBe(true);
    await expect(runtime.runCycle()).resolves.toEqual({ leaseAcquired: false, results: [] });
    expect(starts).toBe(1);

    releaseCleanup();
    await shutdown;
    await cycle;
    expect(runtime.status).toBe("stopped");
    expect(runtime.exitCode).toBe(0);
    expect(recorded).toEqual([expect.objectContaining({ persisted: 1, status: "cancelled" })]);
  });

  it("bounds signal-triggered shutdown and marks an unresponsive handler fatal", async () => {
    let starts = 0;
    let releases = 0;
    const runtime = new WorkerRuntime({
      leaseProvider: createLeaseProvider(() => { releases += 1; }),
      now: () => NOW,
      runner: new WorkerRunner({
        createRunId: ({ jobId }) => `run:${jobId}`,
        handlerShutdownGraceMs: 25,
        handlers: {
          "catalog-refresh": async () => {
            starts += 1;
            return await new Promise(() => {});
          },
        },
        now: () => NOW,
      }),
      schedules: [schedules[0]!],
      shutdownGraceMs: 5,
      stateStore: createStateStore([]),
    });

    const cycleOutcome = runtime.runCycle().catch((error: unknown) => error);
    while (starts === 0) await Promise.resolve();
    await runtime.requestShutdown();

    expect(runtime.status).toBe("fatal");
    expect(runtime.exitCode).toBe(1);
    await expect(cycleOutcome).resolves.toMatchObject({ name: "WorkerUnresponsiveError" });
    expect(releases).toBe(0);
  });

  it("does not write a cancelled result after losing its lease", async () => {
    const lease = new AbortController();
    let recordCalls = 0;
    let starts = 0;
    const runtime = new WorkerRuntime({
      leaseProvider: {
        acquire: async () => ({
          fenceToken: "lost-fence",
          release: async () => undefined,
          signal: lease.signal,
        }),
      },
      now: () => NOW,
      runner: new WorkerRunner({
        createRunId: ({ jobId }) => `run:${jobId}`,
        handlers: {
          "catalog-refresh": async ({ signal }) => {
            starts += 1;
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return { counters: { fetched: 1, persisted: 1, unknown: 1 } };
          },
        },
        now: () => NOW,
      }),
      schedules: [schedules[0]!],
      shutdownGraceMs: 100,
      stateStore: {
        getLastScheduledAt: async () => undefined,
        recordResult: async () => { recordCalls += 1; },
      },
    });

    const cycle = runtime.runCycle();
    while (starts === 0) await Promise.resolve();
    lease.abort();

    await expect(cycle).resolves.toMatchObject({
      results: [expect.objectContaining({ status: "cancelled" })],
    });
    expect(recordCalls).toBe(0);
  });

  it("snapshots schedule definitions against external mutation", async () => {
    const schedule = { ...schedules[0]! };
    const runtime = new WorkerRuntime({
      leaseProvider: createLeaseProvider(),
      now: () => NOW,
      runner: new WorkerRunner({
        createRunId: ({ jobId }) => `run:${jobId}`,
        handlers: {
          "catalog-refresh": async () => ({
            counters: { accepted: 1, fetched: 1, persisted: 1 },
          }),
        },
        now: () => NOW,
      }),
      schedules: [schedule],
      shutdownGraceMs: 100,
      stateStore: createStateStore([]),
    });
    schedule.anchorAt = "2099-01-01T00:15:00.000Z";

    await expect(runtime.runCycle()).resolves.toMatchObject({
      results: [expect.objectContaining({ status: "succeeded" })],
    });
  });

  it("enters a fatal nonzero state when a handler cannot settle inside the bound", async () => {
    const runtime = new WorkerRuntime({
      leaseProvider: createLeaseProvider(),
      now: () => NOW,
      runner: new WorkerRunner({
        createRunId: ({ jobId }) => `run:${jobId}`,
        handlerShutdownGraceMs: 5,
        handlers: { "catalog-refresh": async () => await new Promise(() => {}) },
        now: () => NOW,
      }),
      schedules: [{ ...schedules[0]!, timeoutMs: 5 }],
      shutdownGraceMs: 25,
      stateStore: createStateStore([]),
    });

    await expect(runtime.runCycle()).rejects.toMatchObject({ name: "WorkerUnresponsiveError" });
    expect(runtime.status).toBe("fatal");
    expect(runtime.exitCode).toBe(1);
    await expect(runtime.runCycle()).resolves.toEqual({ leaseAcquired: false, results: [] });
  });

  it("does no work when the distributed lease is held elsewhere", async () => {
    let readState = false;
    let operationalCycles = 0;
    const stateStore: WorkerRuntimeStateStore = {
      getLastScheduledAt: async () => {
        readState = true;
        return undefined;
      },
      recordResult: async () => undefined,
    };
    const leaseProvider: WorkerLeaseProvider = { acquire: async () => undefined };
    const runtime = new WorkerRuntime({
      leaseProvider,
      now: () => NOW,
      observer: { cycleOperational: () => { operationalCycles += 1; } },
      runner: new WorkerRunner({ createRunId: () => "unused", handlers: {}, now: () => NOW }),
      schedules,
      shutdownGraceMs: 100,
      stateStore,
    });

    await expect(runtime.runCycle()).resolves.toEqual({ leaseAcquired: false, results: [] });
    expect(readState).toBe(false);
    expect(operationalCycles).toBe(1);
    expect(runtime.status).toBe("idle");
  });
});
