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
  constructor(readonly counters?: Partial<WorkerRunCounters>) {
    super("Worker execution was cancelled");
    this.name = "WorkerCancelledError";
  }
}

export class WorkerUnresponsiveError extends Error {
  constructor() {
    super("Worker handler did not stop within the shutdown grace period");
    this.name = "WorkerUnresponsiveError";
  }
}

export interface WorkerJobContext {
  fenceToken: string;
  jobId: string;
  kind: WorkerJobKind;
  runId: string;
  signal: AbortSignal;
  sourceId: string;
}

export interface WorkerHandlerResult {
  counters?: Partial<WorkerRunCounters>;
  status?: "succeeded" | "partial";
}

export type WorkerJobHandler = (context: WorkerJobContext) => Promise<WorkerHandlerResult>;

export interface WorkerRunExecution {
  fenceToken: string;
  signal?: AbortSignal;
}

export interface WorkerRunnerOptions {
  createRunId: (request: WorkerJobRequest) => string;
  handlerShutdownGraceMs?: number;
  handlers: Partial<Record<WorkerJobKind, WorkerJobHandler>>;
  now: () => Date;
}

type HandlerSettlement =
  | { kind: "fulfilled"; result: WorkerHandlerResult }
  | { error: unknown; kind: "rejected" };

type InitialOutcome =
  | { kind: "cancelled" }
  | { kind: "settled"; settlement: HandlerSettlement }
  | { kind: "timed-out" };

const DEFAULT_HANDLER_SHUTDOWN_GRACE_MS = 5_000;
const MAX_HANDLER_SHUTDOWN_GRACE_MS = 120_000;

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

function isValidFenceToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 1_024
    && value.trim().length > 0;
}

export class WorkerRunner {
  private readonly handlerShutdownGraceMs: number;

  constructor(private readonly options: WorkerRunnerOptions) {
    const grace = options.handlerShutdownGraceMs ?? DEFAULT_HANDLER_SHUTDOWN_GRACE_MS;
    if (!Number.isInteger(grace) || grace < 1 || grace > MAX_HANDLER_SHUTDOWN_GRACE_MS) {
      throw new TypeError(
        `handlerShutdownGraceMs must be an integer from 1 through ${MAX_HANDLER_SHUTDOWN_GRACE_MS}`,
      );
    }
    this.handlerShutdownGraceMs = grace;
  }

  async run(input: unknown, execution: WorkerRunExecution): Promise<WorkerRunResult> {
    const request = workerJobRequestSchema.parse(input);
    const startedAt = canonicalNow(this.options.now);
    const runId = this.options.createRunId(request);
    const handler = this.options.handlers[request.kind];
    const callerSignal = execution?.signal;
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

    if (!isValidFenceToken(execution?.fenceToken)) return finish("failed");
    if (callerCancelled) return finish("cancelled");
    if (handler === undefined) return finish("failed");

    const handlerExecution: Promise<HandlerSettlement> = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new WorkerCancelledError();
        return handler({
          fenceToken: execution.fenceToken,
          jobId: request.jobId,
          kind: request.kind,
          runId,
          signal: controller.signal,
          sourceId: request.sourceId,
        });
      })
      .then<HandlerSettlement, HandlerSettlement>(
        (result) => ({ kind: "fulfilled", result }),
        (error: unknown) => ({ error, kind: "rejected" }),
      );

    const settled = handlerExecution.then<InitialOutcome>((settlement) => ({ kind: "settled", settlement }));
    const timeout = new Promise<InitialOutcome>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ kind: "timed-out" });
      }, request.timeoutMs);
    });

    const cancellation = new Promise<InitialOutcome>((resolve) => {
      if (callerSignal === undefined) return;
      onCallerAbort = () => {
        callerCancelled = true;
        controller.abort();
        resolve({ kind: "cancelled" });
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      if (callerSignal.aborted) onCallerAbort();
    });

    try {
      const outcome = await Promise.race([settled, timeout, cancellation]);
      let settlement: HandlerSettlement;
      let forcedStatus: "cancelled" | "timed-out" | undefined;

      if (outcome.kind === "settled") {
        settlement = outcome.settlement;
      } else {
        forcedStatus = outcome.kind;
        settlement = await this.joinAfterAbort(handlerExecution);
      }

      const counters = settlement.kind === "fulfilled"
        ? settlement.result.counters
        : settlement.error instanceof WorkerCancelledError
          ? settlement.error.counters
          : undefined;
      if (forcedStatus !== undefined) return finish(forcedStatus, counters);
      if (settlement.kind === "fulfilled") {
        return finish(settlement.result.status ?? "succeeded", settlement.result.counters);
      }
      if (settlement.error instanceof WorkerCancelledError) {
        return finish("cancelled", settlement.error.counters);
      }
      if (timedOut) return finish("timed-out", counters);
      if (callerCancelled) return finish("cancelled", counters);
      return finish("failed", counters);
    } finally {
      clearTimeout(timeoutId);
      if (callerSignal !== undefined && onCallerAbort !== undefined) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  private async joinAfterAbort(execution: Promise<HandlerSettlement>): Promise<HandlerSettlement> {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = Symbol("worker-handler-grace-expired");
    const outcome = await Promise.race([
      execution,
      new Promise<typeof graceExpired>((resolve) => {
        graceTimer = setTimeout(() => resolve(graceExpired), this.handlerShutdownGraceMs);
      }),
    ]);
    clearTimeout(graceTimer);
    if (outcome === graceExpired) throw new WorkerUnresponsiveError();
    return outcome;
  }
}
