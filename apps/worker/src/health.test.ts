import { describe, expect, it } from "vitest";

import { workerHealthHttpResponse, WorkerHealthMonitor } from "./health";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function monitorAt(clock: { now: number }, overrides: Partial<{
  cycleIntervalMs: number;
  maxCycleDurationMs: number;
}> = {}): WorkerHealthMonitor {
  return new WorkerHealthMonitor({
    cycleIntervalMs: overrides.cycleIntervalMs ?? 30_000,
    maxCycleDurationMs: overrides.maxCycleDurationMs ?? 60_000,
    now: () => new Date(clock.now),
    pid: 42,
    revision: REVISION,
    uptimeSeconds: () => 12.9,
  });
}

describe("worker health", () => {
  it("requires a full immutable revision and starts unready", () => {
    expect(() => new WorkerHealthMonitor({
      cycleIntervalMs: 30_000,
      maxCycleDurationMs: 60_000,
      revision: "development",
    })).toThrow(/APP_COMMIT_SHA/);

    const snapshot = monitorAt({ now: Date.parse("2026-07-16T20:00:00.000Z") }).snapshot();
    expect(snapshot).toEqual(expect.objectContaining({
      live: true,
      ready: false,
      revision: REVISION,
      schemaVersion: 1,
      status: "starting",
    }));
    expect(snapshot.process).toEqual({ pid: 42, uptimeSeconds: 12 });
    expect(snapshot.scheduler).toEqual(expect.objectContaining({
      completedCycles: 0,
      failedCycles: 0,
      lastCycle: null,
      state: "starting",
    }));
  });

  it("reports source failure as sanitized degradation without failing readiness", () => {
    const clock = { now: Date.parse("2026-07-16T20:00:00.000Z") };
    const monitor = monitorAt(clock);
    monitor.schedulerStarted();
    monitor.cycleStarted();
    expect(monitor.snapshot()).toMatchObject({ ready: false, status: "starting" });
    monitor.cycleOperational();
    expect(monitor.snapshot()).toMatchObject({ ready: true, status: "ok" });

    clock.now += 1_250;
    monitor.cycleCompleted({
      leaseAcquired: true,
      results: [{
        credential: "must-not-leak",
        sourceId: "private-source-payload",
        status: "failed",
      }],
    });
    const snapshot = monitor.snapshot();
    expect(snapshot).toMatchObject({ ready: true, status: "degraded" });
    expect(snapshot.scheduler).toMatchObject({
      completedCycles: 1,
      failedCycles: 0,
      state: "idle",
      lastCycle: {
        degradedJobs: 1,
        durationMs: 1_250,
        jobs: 1,
        leaseAcquired: true,
        outcome: "degraded",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(JSON.stringify(snapshot)).not.toContain("private-source-payload");

    clock.now += 60_001;
    expect(monitor.snapshot()).toMatchObject({ ready: false, status: "unhealthy" });
  });

  it("bounds cycle summaries and fails an overlong running or completed cycle", () => {
    const clock = { now: Date.parse("2026-07-16T20:00:00.000Z") };
    const monitor = monitorAt(clock, { maxCycleDurationMs: 1_000 });
    monitor.cycleStarted();
    monitor.cycleOperational();
    clock.now += 1_001;
    expect(monitor.snapshot()).toMatchObject({ ready: false, status: "unhealthy" });

    monitor.cycleCompleted({
      leaseAcquired: true,
      results: Array.from({ length: 101 }, () => ({ status: "succeeded" })),
    });
    const snapshot = monitor.snapshot();
    expect(snapshot).toMatchObject({ ready: false, status: "unhealthy" });
    expect(snapshot.scheduler.lastCycle).toMatchObject({
      durationMs: 1_001,
      jobs: 100,
      outcome: "degraded",
    });
  });

  it("serves only the health document and uses readiness status codes", () => {
    const clock = { now: Date.parse("2026-07-16T20:00:00.000Z") };
    const monitor = monitorAt(clock);
    const starting = workerHealthHttpResponse(monitor, "GET", "/health");
    expect(starting.statusCode).toBe(503);
    expect(starting.headers["Cache-Control"]).toBe("no-store");

    monitor.cycleStarted();
    monitor.cycleOperational();
    const ready = workerHealthHttpResponse(monitor, "GET", "/health");
    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({ ready: true, revision: REVISION });
    expect(workerHealthHttpResponse(monitor, "GET", "/missing").statusCode).toBe(404);
    expect(workerHealthHttpResponse(monitor, "POST", "/health").statusCode).toBe(405);
  });
});
