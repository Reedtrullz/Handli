import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type {
  OperationalAlertAppender,
  OperationsSnapshotReader,
} from "@handleplan/db/operations-dashboard";
import type { OperationsEvidenceSnapshotV1 } from "@handleplan/domain";

import { OperationsService } from "./operations-service";

const AT = new Date("2026-07-17T12:00:00.000Z");
const zero = { capped: false, value: 0 } as const;
const unknownWorkerJob = {
  completedAt: null,
  lag: "unknown",
  state: "unknown",
  terminalizedAt: null,
} as const;
const evidence: OperationsEvidenceSnapshotV1 = {
  contractVersion: 1,
  hasMoreSources: false,
  observedAt: AT.toISOString(),
  sourceRoster: {
    contentSha256: "a7cf992b898f3d9caaa51e6df55a09f0bb71158928d71dc13627ab7709b83717",
    entries: [{
      requiredEvidenceSignals: ["ordinary-price"],
      requiredWorkerJobKinds: ["catalog-refresh"],
      sourceId: "fixture-source",
    }],
    version: "fixture-roster:v1",
  },
  sources: [{
    counts24h: {
      failedIngestions: zero,
      ingestions: zero,
      rejectedReviews: zero,
      reviewDecisions: zero,
    },
    derived: {
      ordinaryPriceFreshness: "unknown",
      rejectionRate: "none",
      silentZeroPublication: "unknown",
      sourceFreshness: "unknown",
      workerLag: "unknown",
    },
    evidenceSignals: {
      "official-offer": { freshness: "unknown", newestEligibleAt: null },
      "ordinary-price": { freshness: "unknown", newestEligibleAt: null },
    },
    governanceState: "approval-incomplete",
    health: null,
    latestExtraction: null,
    offers: { active: zero, expiredButPublished: zero, expiringWithin48h: zero },
    reviewQueue: { count: zero, oldestAgeSeconds: null },
    sourceId: "fixture-source",
    workerJobs: {
      "benchmark-price-refresh": unknownWorkerJob,
      "catalog-refresh": unknownWorkerJob,
      "historical-observation-collection": unknownWorkerJob,
      "official-offer-discovery": unknownWorkerJob,
      "official-offer-fetch": unknownWorkerJob,
      "official-offer-ingestion": unknownWorkerJob,
      "official-offer-lifecycle-reconcile": unknownWorkerJob,
      "physical-store-sync": unknownWorkerJob,
    },
  }],
  windowStartedAt: "2026-07-16T12:00:00.000Z",
};
const supplied = {
  apiCoordinator: "unknown",
  apiErrorRate: "unknown",
  apiLatency: "unknown",
  apiSaturation: "unknown",
  backup: "unknown",
  certificate: "unknown",
  databaseSaturation: "unknown",
  disk: "unknown",
} as const;

function dependencies(snapshot: OperationsEvidenceSnapshotV1 = evidence) {
  const reader: OperationsSnapshotReader = { read: vi.fn(async () => snapshot) };
  const appender: OperationalAlertAppender = { append: vi.fn(async () => ({
    appended: 14,
    checkpoint: {
      contractVersion: 1 as const,
      evaluatedAt: AT.toISOString(),
      evaluationContentSha256: "a".repeat(64),
      persistedAt: "2026-07-17T12:00:00.010Z",
      sourceRosterContentSha256: evidence.sourceRoster.contentSha256,
      sourceRosterVersion: evidence.sourceRoster.version,
    },
  })) };
  return { appender, reader };
}

describe("OperationsService", () => {
  it("evaluates every fixed global status and appends only the typed result", async () => {
    const { appender, reader } = dependencies();
    const result = await new OperationsService(reader, appender, () => AT)
      .evaluateAndAppend(supplied);

    expect(reader.read).toHaveBeenCalledWith(AT, 100, undefined);
    expect(result.appended).toBe(14);
    expect(result.evaluation.assessments).toHaveLength(14);
    expect(result.evaluation.assessments.filter((entry) => entry.sourceId === null).every((entry) =>
      entry.outcome === "unknown" && entry.status === "open")).toBe(true);
    expect(appender.append).toHaveBeenCalledWith(result.evaluation, undefined);
  });

  it("fails closed before alert writes when the bounded source directory is incomplete", async () => {
    const { appender, reader } = dependencies({ ...evidence, hasMoreSources: true });
    await expect(new OperationsService(reader, appender, () => AT)
      .evaluateAndAppend(supplied)).rejects.toMatchObject({ code: "INCOMPLETE_SNAPSHOT" });
    expect(appender.append).not.toHaveBeenCalled();
  });

  it("rejects free-form fields before reading evidence and rejects an invalid clock", async () => {
    const invalidInput = dependencies();
    await expect(new OperationsService(invalidInput.reader, invalidInput.appender, () => AT)
      .evaluateAndAppend({ ...supplied, message: "private request" } as never)).rejects.toBeDefined();
    expect(invalidInput.reader.read).not.toHaveBeenCalled();
    expect(invalidInput.appender.append).not.toHaveBeenCalled();

    const invalidClock = dependencies();
    await expect(new OperationsService(
      invalidClock.reader,
      invalidClock.appender,
      () => new Date("invalid"),
    ).evaluateAndAppend(supplied)).rejects.toMatchObject({ code: "INVALID_CLOCK" });
    expect(invalidClock.reader.read).not.toHaveBeenCalled();
  });
});
