import { describe, expect, it } from "vitest";

import {
  newestMissedWorkerJob,
  type WorkerScheduleDefinition,
} from "./schedule";

const sixHourlyPrices: WorkerScheduleDefinition = {
  anchorAt: "2026-01-01T00:30:00.000Z",
  intervalMs: 6 * 60 * 60 * 1_000,
  kind: "benchmark-price-refresh",
  sourceId: "kassalapp",
  timeoutMs: 60_000,
};

describe("newestMissedWorkerJob", () => {
  it("returns only the newest due UTC slot after a long gap", () => {
    expect(newestMissedWorkerJob(
      sixHourlyPrices,
      "2026-07-14T00:30:00.000Z",
      new Date("2026-07-16T13:00:00.000Z"),
    )).toEqual({
      contractVersion: 1,
      jobId: "kassalapp:benchmark-price-refresh:2026-07-16T12:30:00.000Z",
      kind: "benchmark-price-refresh",
      requestedAt: "2026-07-16T12:30:00.000Z",
      sourceId: "kassalapp",
      timeoutMs: 60_000,
    });
  });

  it("returns no job before the anchor or after the newest slot was handled", () => {
    expect(newestMissedWorkerJob(
      sixHourlyPrices,
      undefined,
      new Date("2026-01-01T00:29:59.999Z"),
    )).toBeUndefined();
    expect(newestMissedWorkerJob(
      sixHourlyPrices,
      "2026-07-16T12:30:00.000Z",
      new Date("2026-07-16T13:00:00.000Z"),
    )).toBeUndefined();
  });

  it("derives the same slot and stable ID from equivalent offset timestamps", () => {
    const fromUtc = newestMissedWorkerJob(
      sixHourlyPrices,
      undefined,
      new Date("2026-10-25T01:31:00.000Z"),
    );
    const fromOffset = newestMissedWorkerJob(
      sixHourlyPrices,
      undefined,
      new Date("2026-10-25T02:31:00.000+01:00"),
    );

    expect(fromOffset).toEqual(fromUtc);
    expect(fromUtc?.requestedAt.endsWith("Z")).toBe(true);
  });

  it("keeps stable job IDs distinct and within the contract for maximum source IDs", () => {
    const sourcePrefix = "s".repeat(199);
    const firstSchedule = { ...sixHourlyPrices, sourceId: `${sourcePrefix}a` };
    const secondSchedule = { ...sixHourlyPrices, sourceId: `${sourcePrefix}b` };
    const now = new Date("2026-07-16T13:00:00.000Z");

    const first = newestMissedWorkerJob(firstSchedule, undefined, now);
    const repeated = newestMissedWorkerJob(firstSchedule, undefined, now);
    const second = newestMissedWorkerJob(secondSchedule, undefined, now);

    expect(first?.jobId).toBe(repeated?.jobId);
    expect(first?.jobId.length).toBeLessThanOrEqual(200);
    expect(second?.jobId.length).toBeLessThanOrEqual(200);
    expect(first?.jobId).not.toBe(second?.jobId);
  });

  it("rejects unsafe schedule bounds before producing a request", () => {
    expect(() => newestMissedWorkerJob(
      { ...sixHourlyPrices, intervalMs: 0 },
      undefined,
      new Date("2026-07-16T13:00:00.000Z"),
    )).toThrow(TypeError);
    expect(() => newestMissedWorkerJob(
      { ...sixHourlyPrices, anchorAt: "not-a-time" },
      undefined,
      new Date("2026-07-16T13:00:00.000Z"),
    )).toThrow(TypeError);
  });

  it("rejects date ranges whose slot arithmetic is not safely representable", () => {
    expect(() => newestMissedWorkerJob(
      {
        ...sixHourlyPrices,
        anchorAt: new Date(-8_640_000_000_000_000).toISOString(),
        intervalMs: 1,
      },
      undefined,
      new Date(8_640_000_000_000_000),
    )).toThrow("difference between now and anchorAt must be safely representable");
  });
});
