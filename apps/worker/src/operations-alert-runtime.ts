import {
  operationalAlertAppendReceiptV1Schema,
  operationalAlertCheckpointV1Schema,
  operationalAlertEvaluationV1Schema,
  operationsAlertRuntimeConfigV1Schema,
  type OperationalAlertAppendReceiptV1,
  type OperationalAlertCheckpointV1,
  type OperationalAlertEvaluationV1,
  type OperationalAlertExportBatchV1,
  type OperationsAlertRuntimeConfigV1,
} from "@handleplan/domain";

export interface OperationsAlertCheckpointReaderPort {
  readCheckpoint(signal: AbortSignal): Promise<OperationalAlertCheckpointV1 | null>;
}

export interface OperationsAlertEvaluatorPort {
  evaluate(
    scheduledAt: Date,
    signal: AbortSignal,
  ): Promise<OperationalAlertEvaluationV1>;
}

export interface OperationsAlertAppenderPort {
  append(
    evaluation: OperationalAlertEvaluationV1,
    signal: AbortSignal,
  ): Promise<OperationalAlertAppendReceiptV1>;
}

/** Pull-only boundary. Recipient selection and delivery intentionally live elsewhere. */
export interface OperationsAlertExporterPort {
  readBatch(
    afterEventId: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<OperationalAlertExportBatchV1>;
}

export interface OperationsAlertRuntimeDependencies {
  appender: OperationsAlertAppenderPort;
  checkpointReader: OperationsAlertCheckpointReaderPort;
  evaluator: OperationsAlertEvaluatorPort;
  exporter: OperationsAlertExporterPort;
}

export type OperationsAlertCycleResult = Readonly<{
  appended: number;
  checkpoint: OperationalAlertCheckpointV1 | null;
  scheduledAt: string | null;
  status: "evaluated" | "idle";
}>;

export type OperationsAlertRuntimeComposition = Readonly<{
  activationEnabled: boolean;
  delivery: "disabled";
  exporter: OperationsAlertExporterPort | null;
  runCycle: ((now: Date, signal?: AbortSignal) => Promise<OperationsAlertCycleResult>) | null;
}>;

function finiteClock(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a finite Date`);
  }
  return new Date(value);
}

function requirePort<T extends object, K extends keyof T>(
  value: T | undefined,
  method: K,
  name: string,
): T {
  if (value === undefined || typeof value[method] !== "function") {
    throw new TypeError(`${name} capability is required for alert activation`);
  }
  return value;
}

export function newestDueOperationsAlertEvaluation(
  configInput: Extract<OperationsAlertRuntimeConfigV1, { enabled: true }>,
  checkpointInput: OperationalAlertCheckpointV1 | null,
  nowInput: Date,
): Date | null {
  const config = operationsAlertRuntimeConfigV1Schema.parse(configInput);
  if (!config.enabled) throw new TypeError("Alert schedule is disabled");
  const now = finiteClock(nowInput, "now");
  const anchorMs = Date.parse(config.schedule.anchorAt);
  if (now.getTime() < anchorMs) return null;
  const slotIndex = Math.floor((now.getTime() - anchorMs) / config.schedule.intervalMs);
  const slotMs = anchorMs + slotIndex * config.schedule.intervalMs;
  if (!Number.isSafeInteger(slotMs)) throw new TypeError("Alert schedule is outside the safe range");

  const checkpoint = checkpointInput === null
    ? null
    : operationalAlertCheckpointV1Schema.parse(checkpointInput);
  if (checkpoint !== null) {
    const checkpointMs = Date.parse(checkpoint.evaluatedAt);
    if (
      checkpointMs < anchorMs
      || (checkpointMs - anchorMs) % config.schedule.intervalMs !== 0
      || checkpointMs > now.getTime()
    ) {
      throw new TypeError("Alert checkpoint is not aligned with the configured schedule");
    }
    if (checkpointMs >= slotMs) return null;
  }
  return new Date(slotMs);
}

async function withinTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutController = new AbortController();
  const combined = signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([signal, timeoutController.signal]);
  let deadlineExceeded = false;
  const timeout = setTimeout(() => {
    deadlineExceeded = true;
    timeoutController.abort();
  }, timeoutMs);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException(
      deadlineExceeded ? "Alert cycle deadline exceeded" : "Alert cycle cancelled",
      deadlineExceeded ? "TimeoutError" : "AbortError",
    ));
    combined.addEventListener("abort", onAbort, { once: true });
    if (combined.aborted) onAbort();
  });
  try {
    if (combined.aborted) return await aborted;
    const pending = Promise.resolve().then(async () => await operation(combined));
    return await Promise.race([pending, aborted]);
  } finally {
    clearTimeout(timeout);
    if (onAbort !== undefined) combined.removeEventListener("abort", onAbort);
  }
}

export function createOperationsAlertRuntimeComposition(
  configInput: OperationsAlertRuntimeConfigV1,
  dependencies?: Partial<OperationsAlertRuntimeDependencies>,
): OperationsAlertRuntimeComposition {
  const config = operationsAlertRuntimeConfigV1Schema.parse(configInput);
  if (!config.enabled) {
    return Object.freeze({
      activationEnabled: false,
      delivery: "disabled",
      exporter: null,
      runCycle: null,
    });
  }
  const appender = requirePort(dependencies?.appender, "append", "Appender");
  const checkpointReader = requirePort(
    dependencies?.checkpointReader,
    "readCheckpoint",
    "Checkpoint reader",
  );
  const evaluator = requirePort(dependencies?.evaluator, "evaluate", "Evaluator");
  const exporter = requirePort(dependencies?.exporter, "readBatch", "Exporter");

  return Object.freeze({
    activationEnabled: true,
    delivery: "disabled",
    exporter,
    runCycle: async (nowInput: Date, signal?: AbortSignal) => withinTimeout(
      config.schedule.timeoutMs,
      signal,
      async (cycleSignal) => {
        const checkpointInput = await checkpointReader.readCheckpoint(cycleSignal);
        const checkpoint = checkpointInput === null
          ? null
          : operationalAlertCheckpointV1Schema.parse(checkpointInput);
        const scheduledAt = newestDueOperationsAlertEvaluation(config, checkpoint, nowInput);
        if (scheduledAt === null) {
          return Object.freeze({
            appended: 0,
            checkpoint,
            scheduledAt: null,
            status: "idle" as const,
          });
        }
        const evaluation = operationalAlertEvaluationV1Schema.parse(
          await evaluator.evaluate(scheduledAt, cycleSignal),
        );
        if (evaluation.evaluatedAt !== scheduledAt.toISOString()) {
          throw new TypeError("Alert evaluator returned a non-scheduled clock");
        }
        const receipt = operationalAlertAppendReceiptV1Schema.parse(
          await appender.append(evaluation, cycleSignal),
        );
        if (
          receipt.checkpoint.evaluatedAt !== evaluation.evaluatedAt
          || receipt.checkpoint.sourceRosterContentSha256
            !== evaluation.sourceRoster.contentSha256
          || receipt.checkpoint.sourceRosterVersion !== evaluation.sourceRoster.version
        ) {
          throw new TypeError("Alert appender returned a mismatched checkpoint");
        }
        return Object.freeze({
          appended: receipt.appended,
          checkpoint: receipt.checkpoint,
          scheduledAt: scheduledAt.toISOString(),
          status: "evaluated" as const,
        });
      },
    ),
  });
}
