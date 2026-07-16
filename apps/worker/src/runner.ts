import {
  type WorkerJobKind,
  type WorkerJobRequest,
  type WorkerRunCounters,
  type WorkerRunResult,
  WORKER_CONTRACT_VERSION,
  ZERO_WORKER_RUN_COUNTERS,
  workerJobRequestSchema,
  workerRunCountersSchema,
  workerRunResultSchema,
} from "./contracts";

export class WorkerCancelledError extends Error {
  constructor() {
    super("Worker execution was cancelled");
    this.name = "WorkerCancelledError";
  }
}

export interface WorkerJobContext {
  runId: string;
  signal: AbortSignal;
}

export interface WorkerHandlerResult {
  counters?: Partial<WorkerRunCounters>;
  status?: "succeeded" | "partial";
}

export type WorkerJobHandler = (context: WorkerJobContext) => Promise<WorkerHandlerResult>;

export interface WorkerRunnerOptions {
  createRunId: (request: WorkerJobRequest) => string;
  handlers: Partial<Record<WorkerJobKind, WorkerJobHandler>>;
  now: () => Date;
}

type ExecutionOutcome =
  | { kind: "completed"; result: WorkerHandlerResult }
  | { kind: "cancelled" }
  | { kind: "timed-out" }
  | { kind: "failed" };

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid worker clock");
  return value.toISOString();
}

function mergeCounters(input: Partial<WorkerRunCounters> | undefined): WorkerRunCounters {
  return workerRunCountersSchema.parse({
    ...ZERO_WORKER_RUN_COUNTERS,
    ...input,
  });
}

function countersAreAccounted(counters: WorkerRunCounters): boolean {
  return counters.fetched === counters.accepted + counters.quarantined + counters.unknown &&
    counters.persisted === counters.fetched;
}

function completionStatus(counters: WorkerRunCounters): "succeeded" | "partial" | "failed" {
  if (counters.failed === 0) return "succeeded";
  return counters.fetched > 0 ? "partial" : "failed";
}

export class WorkerRunner {
  constructor(private readonly options: WorkerRunnerOptions) {}

  async run(input: unknown, callerSignal?: AbortSignal): Promise<WorkerRunResult> {
    const request = workerJobRequestSchema.parse(input);
    const startedAt = canonicalNow(this.options.now);
    const runId = this.options.createRunId(request);
    const handler = this.options.handlers[request.kind];
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let callerCancelled = callerSignal?.aborted ?? false;
    let timedOut = false;
    let onCallerAbort: (() => void) | undefined;

    const finish = (
      status: WorkerRunResult["status"],
      countersInput?: Partial<WorkerRunCounters>,
    ): WorkerRunResult => {
      let counters: WorkerRunCounters;
      try {
        counters = mergeCounters(countersInput);
        if (!countersAreAccounted(counters)) throw new Error("Invalid worker counter accounting");
      } catch {
        status = "failed";
        counters = { ...ZERO_WORKER_RUN_COUNTERS, failed: 1 };
      }
      if (status === "succeeded" || status === "partial") status = completionStatus(counters);
      if (status === "failed" && counters.failed === 0) counters = { ...counters, failed: 1 };
      return workerRunResultSchema.parse({
        contractVersion: WORKER_CONTRACT_VERSION,
        runId,
        jobId: request.jobId,
        kind: request.kind,
        sourceId: request.sourceId,
        status,
        startedAt,
        completedAt: canonicalNow(this.options.now),
        counters,
      });
    };

    if (callerCancelled) return finish("cancelled");
    if (handler === undefined) return finish("failed");

    const execution = Promise.resolve()
      .then(() => handler({ runId, signal: controller.signal }))
      .then<ExecutionOutcome, ExecutionOutcome>(
        (result) => ({ kind: "completed", result }),
        (error: unknown) => {
          if (timedOut) return { kind: "timed-out" };
          if (callerCancelled || error instanceof WorkerCancelledError) return { kind: "cancelled" };
          return { kind: "failed" };
        },
      );

    const timeout = new Promise<ExecutionOutcome>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ kind: "timed-out" });
      }, request.timeoutMs);
    });

    const cancellation = new Promise<ExecutionOutcome>((resolve) => {
      if (callerSignal === undefined) return;
      onCallerAbort = () => {
        callerCancelled = true;
        controller.abort();
        resolve({ kind: "cancelled" });
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    });

    try {
      const outcome = await Promise.race([execution, timeout, cancellation]);
      switch (outcome.kind) {
        case "completed":
          return finish(outcome.result.status ?? "succeeded", outcome.result.counters);
        case "cancelled":
          return finish("cancelled");
        case "timed-out":
          return finish("timed-out");
        case "failed":
          return finish("failed");
      }
      return finish("failed");
    } finally {
      clearTimeout(timeoutId);
      if (callerSignal !== undefined && onCallerAbort !== undefined) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  }
}
