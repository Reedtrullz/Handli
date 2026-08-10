import { describe, expect, it } from "vitest";

import { WORKER_JOB_KINDS, workerJobRequestSchema, workerRunResultSchema } from "./contracts";

describe("worker job contracts", () => {
  it.each(WORKER_JOB_KINDS)("accepts the %s job", (kind) => {
    expect(workerJobRequestSchema.parse({
      contractVersion: 1,
      jobId: `job-${kind}`,
      kind,
      requestedAt: "2026-07-16T12:00:00.000Z",
      sourceId: "fixture-source",
      timeoutMs: 10_000,
    })).toMatchObject({ kind, sourceId: "fixture-source" });
  });

  it("rejects unknown jobs and unsafe timeouts", () => {
    expect(workerJobRequestSchema.safeParse({
      contractVersion: 1,
      jobId: "job-unknown",
      kind: "unknown",
      requestedAt: "2026-07-16T12:00:00.000Z",
      sourceId: "fixture-source",
      timeoutMs: 10_000,
    }).success).toBe(false);
    expect(workerJobRequestSchema.safeParse({
      contractVersion: 1,
      jobId: "job-catalog",
      kind: "catalog-refresh",
      requestedAt: "2026-07-16T12:00:00.000Z",
      sourceId: "fixture-source",
      timeoutMs: 0,
    }).success).toBe(false);
  });

  it("requires complete bounded counters and canonical timestamps", () => {
    expect(workerRunResultSchema.safeParse({
      contractVersion: 1,
      runId: "run-1",
      jobId: "job-1",
      kind: "catalog-refresh",
      sourceId: "fixture-source",
      status: "succeeded",
      startedAt: "2026-07-16T12:00:00.000Z",
      completedAt: "2026-07-16T12:00:01.000Z",
      counters: { fetched: 1 },
    }).success).toBe(false);
  });

  it("requires every fetched outcome state to be persisted for audit", () => {
    const base = {
      contractVersion: 1,
      runId: "run-1",
      jobId: "job-1",
      kind: "catalog-refresh",
      sourceId: "fixture-source",
      status: "succeeded",
      startedAt: "2026-07-16T12:00:00.000Z",
      completedAt: "2026-07-16T12:00:01.000Z",
    } as const;

    expect(workerRunResultSchema.safeParse({
      ...base,
      counters: { accepted: 1, failed: 0, fetched: 2, persisted: 1, quarantined: 0, unknown: 0 },
    }).success).toBe(false);
    expect(workerRunResultSchema.safeParse({
      ...base,
      counters: { accepted: 1, failed: 0, fetched: 1, persisted: 0, quarantined: 0, unknown: 0 },
    }).success).toBe(false);
    expect(workerRunResultSchema.safeParse({
      ...base,
      counters: { accepted: 0, failed: 0, fetched: 2, persisted: 2, quarantined: 1, unknown: 1 },
    }).success).toBe(true);
  });

  it("rejects succeeded, partial, and failed statuses that contradict failure counters", () => {
    const base = {
      contractVersion: 1,
      runId: "run-1",
      jobId: "job-1",
      kind: "catalog-refresh",
      sourceId: "fixture-source",
      startedAt: "2026-07-16T12:00:00.000Z",
      completedAt: "2026-07-16T12:00:01.000Z",
    } as const;
    const parse = (status: string, counters: Record<string, number>) => workerRunResultSchema.safeParse({
      ...base,
      counters,
      status,
    }).success;

    expect(parse("succeeded", { accepted: 1, failed: 1, fetched: 1, persisted: 1, quarantined: 0, unknown: 0 }))
      .toBe(false);
    expect(parse("partial", { accepted: 1, failed: 0, fetched: 1, persisted: 1, quarantined: 0, unknown: 0 }))
      .toBe(false);
    expect(parse("failed", { accepted: 1, failed: 1, fetched: 1, persisted: 1, quarantined: 0, unknown: 0 }))
      .toBe(false);
  });
});
