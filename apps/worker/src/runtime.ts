import type { WorkerJobRequest, WorkerRunResult } from "./contracts";
import { WorkerRunner, WorkerUnresponsiveError } from "./runner";
import {
  newestMissedWorkerJob,
  type WorkerScheduleDefinition,
} from "./schedule";

export interface WorkerLeaseFence {
  readonly fenceToken: string;
  readonly signal: AbortSignal;
}

export interface WorkerLeaseHandle extends WorkerLeaseFence {
  release(): Promise<void>;
}

export interface WorkerLeaseProvider {
  acquire(signal: AbortSignal): Promise<WorkerLeaseHandle | undefined>;
}

export interface WorkerRuntimeStateStore {
  getLastScheduledAt(
    schedule: WorkerScheduleDefinition,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  /** Implementations must atomically reject writes when the fence is no longer current. */
  recordResult(
    request: WorkerJobRequest,
    result: WorkerRunResult,
    fence: WorkerLeaseFence,
  ): Promise<void>;
}

export interface WorkerRuntimeObserver {
  cycleOperational(): void;
}

export type WorkerRuntimeStatus = "idle" | "running" | "draining" | "stopped" | "fatal";

export interface WorkerCycleResult {
  leaseAcquired: boolean;
  results: readonly WorkerRunResult[];
}

export interface WorkerRuntimeOptions {
  leaseProvider: WorkerLeaseProvider;
  now: () => Date;
  observer?: WorkerRuntimeObserver;
  runner: WorkerRunner;
  schedules: readonly WorkerScheduleDefinition[];
  shutdownGraceMs: number;
  stateStore: WorkerRuntimeStateStore;
}

const EMPTY_CYCLE_RESULT: WorkerCycleResult = Object.freeze({
  leaseAcquired: false,
  results: Object.freeze([]),
});

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSchedules(left: WorkerScheduleDefinition, right: WorkerScheduleDefinition): number {
  return compareText(left.anchorAt, right.anchorAt) ||
    compareText(left.sourceId.trim(), right.sourceId.trim()) ||
    compareText(left.kind, right.kind) ||
    left.intervalMs - right.intervalMs ||
    left.timeoutMs - right.timeoutMs;
}

export class WorkerRuntime {
  private activeCycle: Promise<WorkerCycleResult> | undefined;
  private readonly controller = new AbortController();
  private exitCodeValue: 0 | 1 = 0;
  private readonly schedules: readonly WorkerScheduleDefinition[];
  private shutdown: Promise<void> | undefined;
  private statusValue: WorkerRuntimeStatus = "idle";

  constructor(private readonly options: WorkerRuntimeOptions) {
    if (
      !Number.isInteger(options.shutdownGraceMs) ||
      options.shutdownGraceMs < 1 ||
      options.shutdownGraceMs > 120_000
    ) {
      throw new TypeError("shutdownGraceMs must be an integer from 1 through 120000");
    }
    this.schedules = Object.freeze(
      options.schedules
        .map((schedule) => Object.freeze({ ...schedule }))
        .sort(compareSchedules),
    );
  }

  get exitCode(): 0 | 1 {
    return this.exitCodeValue;
  }

  get status(): WorkerRuntimeStatus {
    return this.statusValue;
  }

  runCycle(): Promise<WorkerCycleResult> {
    if (
      this.statusValue === "draining" ||
      this.statusValue === "stopped" ||
      this.statusValue === "fatal"
    ) {
      return Promise.resolve(EMPTY_CYCLE_RESULT);
    }
    if (this.activeCycle !== undefined) return this.activeCycle;

    this.statusValue = "running";
    const cycle = this.executeCycle()
      .catch((error: unknown) => {
        this.markFatal();
        throw error;
      })
      .finally(() => {
        if (this.activeCycle === cycle) this.activeCycle = undefined;
        if (this.statusValue === "running") this.statusValue = "idle";
      });
    this.activeCycle = cycle;
    return cycle;
  }

  requestShutdown(): Promise<void> {
    if (this.shutdown !== undefined) return this.shutdown;
    if (this.statusValue === "fatal" || this.statusValue === "stopped") {
      this.shutdown = Promise.resolve();
      return this.shutdown;
    }

    this.statusValue = "draining";
    this.controller.abort();
    this.shutdown = this.finishShutdown();
    return this.shutdown;
  }

  private async executeCycle(): Promise<WorkerCycleResult> {
    let lease: WorkerLeaseHandle | undefined;
    try {
      lease = await this.options.leaseProvider.acquire(this.controller.signal);
    } catch (error) {
      if (this.controller.signal.aborted) return EMPTY_CYCLE_RESULT;
      throw error;
    }
    this.options.observer?.cycleOperational();
    if (lease === undefined) return EMPTY_CYCLE_RESULT;

    const results: WorkerRunResult[] = [];
    const fence: WorkerLeaseFence = Object.freeze({
      fenceToken: lease.fenceToken,
      signal: lease.signal,
    });
    const workSignal = AbortSignal.any([this.controller.signal, lease.signal]);
    let releaseLease = true;
    try {
      for (const schedule of this.schedules) {
        if (workSignal.aborted) break;
        let lastScheduledAt: string | undefined;
        try {
          lastScheduledAt = await this.options.stateStore.getLastScheduledAt(schedule, workSignal);
        } catch (error) {
          if (workSignal.aborted) break;
          throw error;
        }
        if (workSignal.aborted) break;
        const request = newestMissedWorkerJob(schedule, lastScheduledAt, this.options.now());
        if (request === undefined) continue;

        const result = await this.options.runner.run(request, {
          fenceToken: lease.fenceToken,
          signal: workSignal,
        });
        results.push(result);
        if (lease.signal.aborted) break;
        await this.options.stateStore.recordResult(request, result, fence);
        if (workSignal.aborted) break;
      }
      return { leaseAcquired: true, results };
    } catch (error) {
      if (error instanceof WorkerUnresponsiveError) {
        // The handler may still be mutating state. A future process entrypoint must exit on
        // this fatal error; lease expiry, not voluntary release, then permits safe takeover.
        releaseLease = false;
      }
      throw error;
    } finally {
      if (releaseLease) await lease.release();
    }
  }

  private async finishShutdown(): Promise<void> {
    const active = this.activeCycle;
    if (active === undefined) {
      if (this.statusValue !== "fatal") this.statusValue = "stopped";
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("worker-runtime-shutdown-timeout");
    const settled = active.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    const outcome = await Promise.race([
      settled,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.options.shutdownGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === timedOut) {
      this.markFatal();
      return;
    }
    if (this.statusValue !== "fatal") this.statusValue = "stopped";
  }

  private markFatal(): void {
    this.exitCodeValue = 1;
    this.statusValue = "fatal";
    this.controller.abort();
  }
}
