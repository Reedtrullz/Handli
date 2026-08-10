import { describe, expect, it } from "vitest";

import { deterministicFakeExecution } from "./fake";

describe("deterministicFakeExecution", () => {
  it("returns fresh deterministic counters and honors cancellation", async () => {
    const execute = deterministicFakeExecution({ accepted: 2, fetched: 2 });
    const signal = new AbortController().signal;
    const context = {
      fenceToken: "wlf1.fixture",
      jobId: "job-1",
      kind: "catalog-refresh" as const,
      runId: "run-1",
      signal,
      sourceId: "fixture-source",
    };
    const first = await execute(context);
    const second = await execute(context);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(execute({
      ...context,
      runId: "run-2",
      signal: cancelled.signal,
    })).rejects.toMatchObject({
      name: "WorkerCancelledError",
    });
  });
});
