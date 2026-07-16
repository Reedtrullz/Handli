import { describe, expect, it, vi } from "vitest";

import { superviseWorker } from "./supervisor";

describe("worker supervision", () => {
  it("repeats bounded cycles and drains exactly once on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = new AbortController();
      const observer = {
        cycleCompleted: vi.fn(),
        cycleFailed: vi.fn(),
        cycleStarted: vi.fn(),
        schedulerStarted: vi.fn(),
        schedulerStopped: vi.fn(),
        schedulerStopping: vi.fn(),
      };
      const runtime = {
        exitCode: 0 as const,
        requestShutdown: vi.fn(async () => undefined),
        runCycle: vi.fn(async () => ({ leaseAcquired: false, results: [] })),
      };
      const supervised = superviseWorker(runtime, {
        cycleIntervalMs: 1_000,
        observer,
        signal: shutdown.signal,
      });
      await vi.advanceTimersByTimeAsync(2_001);
      shutdown.abort();
      await vi.runAllTimersAsync();

      await expect(supervised).resolves.toBe(0);
      expect(runtime.runCycle.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(runtime.requestShutdown).toHaveBeenCalledOnce();
      expect(observer.schedulerStarted).toHaveBeenCalledOnce();
      expect(observer.cycleStarted).toHaveBeenCalledTimes(runtime.runCycle.mock.calls.length);
      expect(observer.cycleCompleted).toHaveBeenCalledTimes(runtime.runCycle.mock.calls.length);
      expect(observer.cycleFailed).not.toHaveBeenCalled();
      expect(observer.schedulerStopping).toHaveBeenCalledOnce();
      expect(observer.schedulerStopped).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns failure after a cycle error without exposing the error", async () => {
    const observer = {
      cycleCompleted: vi.fn(),
      cycleFailed: vi.fn(),
      cycleStarted: vi.fn(),
      schedulerStarted: vi.fn(),
      schedulerStopped: vi.fn(),
      schedulerStopping: vi.fn(),
    };
    const runtime = {
      exitCode: 0 as 0 | 1,
      requestShutdown: vi.fn(async () => undefined),
      runCycle: vi.fn(async () => { throw new Error("sensitive upstream response"); }),
    };

    await expect(superviseWorker(runtime, {
      cycleIntervalMs: 1_000,
      observer,
      signal: new AbortController().signal,
    })).resolves.toBe(1);
    expect(runtime.requestShutdown).toHaveBeenCalledOnce();
    expect(observer.cycleFailed).toHaveBeenCalledOnce();
    expect(observer.cycleCompleted).not.toHaveBeenCalled();
    expect(observer.schedulerStopped).toHaveBeenCalledWith(1);
  });
});
