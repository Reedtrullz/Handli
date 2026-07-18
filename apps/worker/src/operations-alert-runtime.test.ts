import { describe, expect, it, vi } from "vitest";

import type {
  OperationalAlertExportBatchV1,
  OperationalAlertEvaluationV1,
  OperationsAlertRuntimeConfigV1,
} from "@handleplan/domain";

import {
  createOperationsAlertRuntimeComposition,
  newestDueOperationsAlertEvaluation,
  type OperationsAlertRuntimeDependencies,
} from "./operations-alert-runtime";

const config: Extract<OperationsAlertRuntimeConfigV1, { enabled: true }> = {
  capabilities: {
    appender: "security-definer-v1",
    checkpoint: "database-checkpoint-v1",
    exporter: "bounded-pull-v1",
    suppliedStatuses: "fixed-buckets-v1",
  },
  contractVersion: 1,
  delivery: "disabled",
  enabled: true,
  schedule: {
    anchorAt: "2026-07-17T00:00:00.000Z",
    contractVersion: 1,
    intervalMs: 300_000,
    timeoutMs: 30_000,
  },
};

const evaluation: OperationalAlertEvaluationV1 = {
  assessments: [...[
    "api.coordinator-outage",
    "api.error-rate",
    "api.latency",
    "api.saturation",
    "backup.status",
    "certificate.status",
    "database.saturation",
    "disk.status",
  ].map((alertKey) => ({
    alertKey: alertKey as OperationalAlertEvaluationV1["assessments"][number]["alertKey"],
    outcome: "warning" as const,
    severity: "warning" as const,
    sourceId: null,
    status: "open" as const,
  })), ...[
    "offer.expired",
    "offer.expiring",
    "review.queue-age",
    "source.freshness",
    "source.silent-zero-publication",
    "worker.lag",
  ].map((alertKey) => ({
    alertKey: alertKey as OperationalAlertEvaluationV1["assessments"][number]["alertKey"],
    outcome: "warning" as const,
    severity: "warning" as const,
    sourceId: "fixture-source",
    status: "open" as const,
  }))].sort((left, right) => left.alertKey < right.alertKey ? -1 : left.alertKey > right.alertKey ? 1 : 0),
  contractVersion: 1,
  evaluatedAt: "2026-07-17T12:00:00.000Z",
  sourceRoster: {
    contentSha256: "a7cf992b898f3d9caaa51e6df55a09f0bb71158928d71dc13627ab7709b83717",
    entries: [{
      requiredEvidenceSignals: ["ordinary-price"],
      requiredWorkerJobKinds: ["catalog-refresh"],
      sourceId: "fixture-source",
    }],
    version: "fixture-roster:v1",
  },
};

function dependencies(): OperationsAlertRuntimeDependencies {
  const checkpoint = {
    contractVersion: 1 as const,
    evaluatedAt: evaluation.evaluatedAt,
    evaluationContentSha256: "a".repeat(64),
    persistedAt: "2026-07-17T12:00:00.010Z",
    sourceRosterContentSha256: evaluation.sourceRoster.contentSha256,
    sourceRosterVersion: evaluation.sourceRoster.version,
  };
  return {
    appender: { append: vi.fn(async () => ({ appended: 14, checkpoint })) },
    checkpointReader: { readCheckpoint: vi.fn(async () => null) },
    evaluator: { evaluate: vi.fn(async () => evaluation) },
    exporter: {
      readBatch: vi.fn(async (): Promise<OperationalAlertExportBatchV1> => ({
        contractVersion: 1 as const,
        events: [],
        hasMore: false,
        nextEventId: null,
      })),
    },
  };
}

describe("operations alert runtime", () => {
  it("keeps the default composition inert with no delivery capability", () => {
    expect(createOperationsAlertRuntimeComposition({
      contractVersion: 1,
      enabled: false,
    })).toEqual({
      activationEnabled: false,
      delivery: "disabled",
      exporter: null,
      runCycle: null,
    });
  });

  it("requires every bounded capability before accepting explicit activation", () => {
    for (const key of ["appender", "checkpointReader", "evaluator", "exporter"] as const) {
      const ports = dependencies();
      delete (ports as Partial<OperationsAlertRuntimeDependencies>)[key];
      expect(() => createOperationsAlertRuntimeComposition(config, ports)).toThrow(/required/u);
    }
  });

  it("derives the newest due slot and rejects off-schedule checkpoints", () => {
    expect(newestDueOperationsAlertEvaluation(
      config,
      null,
      new Date("2026-07-17T12:02:59.999Z"),
    )?.toISOString()).toBe("2026-07-17T12:00:00.000Z");
    expect(newestDueOperationsAlertEvaluation(config, {
      contractVersion: 1,
      evaluatedAt: "2026-07-17T12:00:00.000Z",
      evaluationContentSha256: "a".repeat(64),
      persistedAt: "2026-07-17T12:00:00.010Z",
      sourceRosterContentSha256: "b".repeat(64),
      sourceRosterVersion: "fixture-roster:v1",
    }, new Date("2026-07-17T12:02:59.999Z"))).toBeNull();
    expect(() => newestDueOperationsAlertEvaluation(config, {
      contractVersion: 1,
      evaluatedAt: "2026-07-17T12:00:01.000Z",
      evaluationContentSha256: "a".repeat(64),
      persistedAt: "2026-07-17T12:00:01.010Z",
      sourceRosterContentSha256: "b".repeat(64),
      sourceRosterVersion: "fixture-roster:v1",
    }, new Date("2026-07-17T12:02:59.999Z"))).toThrow(/aligned/u);
  });

  it("evaluates exactly the scheduled clock and returns the durable checkpoint", async () => {
    const ports = dependencies();
    const runtime = createOperationsAlertRuntimeComposition(config, ports);
    await expect(runtime.runCycle?.(new Date("2026-07-17T12:02:00.000Z")))
      .resolves.toMatchObject({
        appended: 14,
        scheduledAt: "2026-07-17T12:00:00.000Z",
        status: "evaluated",
      });
    expect(ports.evaluator.evaluate).toHaveBeenCalledWith(
      new Date("2026-07-17T12:00:00.000Z"),
      expect.any(AbortSignal),
    );
    expect(ports.appender.append).toHaveBeenCalledOnce();
    expect(ports.exporter.readBatch).not.toHaveBeenCalled();
  });

  it("does not evaluate again when the durable checkpoint covers the slot", async () => {
    const ports = dependencies();
    vi.mocked(ports.checkpointReader.readCheckpoint).mockResolvedValue({
      contractVersion: 1,
      evaluatedAt: "2026-07-17T12:00:00.000Z",
      evaluationContentSha256: "a".repeat(64),
      persistedAt: "2026-07-17T12:00:00.010Z",
      sourceRosterContentSha256: evaluation.sourceRoster.contentSha256,
      sourceRosterVersion: evaluation.sourceRoster.version,
    });
    await expect(createOperationsAlertRuntimeComposition(config, ports)
      .runCycle?.(new Date("2026-07-17T12:02:00.000Z")))
      .resolves.toMatchObject({ status: "idle" });
    expect(ports.evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("races the deadline against a hung port and aborts its signal", async () => {
    vi.useFakeTimers();
    try {
      const ports = dependencies();
      let portSignal: AbortSignal | undefined;
      vi.mocked(ports.checkpointReader.readCheckpoint).mockImplementation(async (signal) => {
        portSignal = signal;
        return await new Promise(() => undefined);
      });
      const runtime = createOperationsAlertRuntimeComposition({
        ...config,
        schedule: { ...config.schedule, timeoutMs: 1_000 },
      }, ports);

      const pending = runtime.runCycle?.(new Date("2026-07-17T12:02:00.000Z"));
      const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(portSignal?.aborted).toBe(true);
      expect(ports.evaluator.evaluate).not.toHaveBeenCalled();
      expect(ports.appender.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
