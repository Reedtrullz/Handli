import { describe, expect, it } from "vitest";

import { deterministicFakeExecution, type WorkerJobHandler } from "./fake";
import { WorkerRunner } from "./runner";

const request = {
  contractVersion: 1 as const,
  jobId: "job-catalog-1",
  kind: "catalog-refresh" as const,
  requestedAt: "2026-07-16T12:00:00.000Z",
  sourceId: "fixture-source",
  timeoutMs: 50,
};

function sequenceClock(...timestamps: string[]): () => Date {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]!);
}

describe("WorkerRunner", () => {
  it("produces deterministic IDs, counters, and timing from injected dependencies", async () => {
    const runner = new WorkerRunner({
      createRunId: ({ jobId }) => `run:${jobId}`,
      handlers: {
        "catalog-refresh": deterministicFakeExecution({
          accepted: 3,
          fetched: 5,
          persisted: 5,
          quarantined: 1,
          unknown: 1,
        }),
      },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    await expect(runner.run(request)).resolves.toEqual({
      contractVersion: 1,
      runId: "run:job-catalog-1",
      jobId: "job-catalog-1",
      kind: "catalog-refresh",
      sourceId: "fixture-source",
      status: "succeeded",
      startedAt: "2026-07-16T12:00:00.000Z",
      completedAt: "2026-07-16T12:00:01.000Z",
      counters: {
        accepted: 3,
        failed: 0,
        fetched: 5,
        persisted: 5,
        quarantined: 1,
        unknown: 1,
      },
    });
  });

  it("does not invoke a handler when the caller is already cancelled", async () => {
    let invoked = false;
    const handler: WorkerJobHandler = async () => {
      invoked = true;
      return {};
    };
    const controller = new AbortController();
    controller.abort("private caller reason");
    const runner = new WorkerRunner({
      createRunId: () => "run-cancelled",
      handlers: { "catalog-refresh": handler },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:00.000Z"),
    });

    await expect(runner.run(request, controller.signal)).resolves.toMatchObject({ status: "cancelled" });
    expect(invoked).toBe(false);
  });

  it("bounds an uncooperative handler with the job timeout", async () => {
    const never: WorkerJobHandler = async () => new Promise(() => {});
    const runner = new WorkerRunner({
      createRunId: () => "run-timeout",
      handlers: { "catalog-refresh": never },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    await expect(runner.run({ ...request, timeoutMs: 5 })).resolves.toMatchObject({
      runId: "run-timeout",
      status: "timed-out",
    });
  });

  it("sanitizes handler failures and keeps the run result structurally valid", async () => {
    const handler: WorkerJobHandler = async () => {
      throw new Error("secret payload should never be returned");
    };
    const runner = new WorkerRunner({
      createRunId: () => "run-failed",
      handlers: { "catalog-refresh": handler },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    const result = await runner.run(request);
    expect(result).toMatchObject({ status: "failed", counters: { failed: 1 } });
    expect(JSON.stringify(result)).not.toContain("secret payload");
  });

  it("derives partial or failed from counters instead of trusting handler status", async () => {
    const partial = new WorkerRunner({
      createRunId: () => "run-partial",
      handlers: {
        "catalog-refresh": async () => ({
          counters: { accepted: 1, failed: 1, fetched: 1, persisted: 1 },
          status: "succeeded",
        }),
      },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });
    const failed = new WorkerRunner({
      createRunId: () => "run-no-progress",
      handlers: {
        "catalog-refresh": async () => ({
          counters: { failed: 1 },
          status: "succeeded",
        }),
      },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    await expect(partial.run(request)).resolves.toMatchObject({ status: "partial" });
    await expect(failed.run(request)).resolves.toMatchObject({ status: "failed" });
  });

  it("turns invalid counter accounting into a bounded failed result", async () => {
    const runner = new WorkerRunner({
      createRunId: () => "run-invalid-counters",
      handlers: {
        "catalog-refresh": async () => ({ counters: { accepted: 1, fetched: 2, persisted: 2 } }),
      },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    await expect(runner.run(request)).resolves.toMatchObject({
      counters: { accepted: 0, failed: 1, fetched: 0, persisted: 0 },
      status: "failed",
    });
  });

  it("cannot succeed when accepted outcomes have not been persisted", async () => {
    const runner = new WorkerRunner({
      createRunId: () => "run-unpersisted",
      handlers: {
        "catalog-refresh": async () => ({ counters: { accepted: 1, fetched: 1, persisted: 0 } }),
      },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    await expect(runner.run(request)).resolves.toMatchObject({
      counters: { accepted: 0, failed: 1, fetched: 0, persisted: 0 },
      status: "failed",
    });
  });

  it("actively cancels a running handler and propagates the bounded abort signal", async () => {
    const caller = new AbortController();
    let handlerSignal: AbortSignal | undefined;
    const handler: WorkerJobHandler = async ({ signal }) => {
      handlerSignal = signal;
      return await new Promise(() => {});
    };
    const runner = new WorkerRunner({
      createRunId: () => "run-active-cancel",
      handlers: { "catalog-refresh": handler },
      now: sequenceClock("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:01.000Z"),
    });

    const run = runner.run(request, caller.signal);
    await Promise.resolve();
    caller.abort("private cancellation reason");

    await expect(run).resolves.toMatchObject({ status: "cancelled" });
    expect(handlerSignal?.aborted).toBe(true);
  });
});
