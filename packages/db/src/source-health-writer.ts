export const WORKER_SOURCE_HEALTH_JOB_KINDS = [
  "catalog-refresh",
  "benchmark-price-refresh",
  "physical-store-sync",
  "historical-observation-collection",
  "official-offer-ingestion",
] as const;

export const WORKER_SOURCE_HEALTH_RESULT_STATUSES = [
  "succeeded",
  "partial",
  "cancelled",
  "timed-out",
  "failed",
] as const;

export type WorkerSourceHealthJobKind =
  (typeof WORKER_SOURCE_HEALTH_JOB_KINDS)[number];
export type WorkerSourceHealthResultStatus =
  (typeof WORKER_SOURCE_HEALTH_RESULT_STATUSES)[number];
export type WorkerSourceHealthState = "healthy" | "degraded" | "failed";

export interface WorkerSourceHealthCounters {
  accepted: number;
  failed: number;
  fetched: number;
  persisted: number;
  quarantined: number;
  unknown: number;
}

export interface WorkerSourceHealthResult {
  completedAt: Date;
  counts: WorkerSourceHealthCounters;
  jobId: string;
  jobKind: WorkerSourceHealthJobKind;
  sourceId: string;
  status: WorkerSourceHealthResultStatus;
}

export interface PreviousWorkerSourceHealthSnapshot {
  lastCaptureSuccessAt: Date | null;
  lastDiscoverySuccessAt: Date | null;
  lastPublishSuccessAt: Date | null;
  newestEligibleEvidenceAt: Date | null;
}

export interface WorkerSourceHealthSnapshotDraft {
  details: Record<string, never>;
  geographicScopeId: null;
  lastCaptureSuccessAt: Date | null;
  lastDiscoverySuccessAt: Date | null;
  lastPublishSuccessAt: Date | null;
  newestEligibleEvidenceAt: Date | null;
  oldestReviewAgeSeconds: null;
  recordedAt: Date;
  reviewQueueCount: 0;
  sourceId: string;
  status: WorkerSourceHealthState;
  workerJobId: string;
}

function copyBoundedClock(value: Date | null, recordedAt: Date, name: string): Date | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date or null`);
  }
  if (value > recordedAt) throw new TypeError(`${name} cannot postdate worker completion`);
  return new Date(value);
}

function healthState(result: WorkerSourceHealthResult): WorkerSourceHealthState {
  if (result.status === "failed" || result.status === "timed-out") return "failed";
  if (result.status === "partial" || result.counts.accepted === 0) return "degraded";
  return "healthy";
}

/**
 * Derives the only source-health payload a worker result may append.
 *
 * Cancellation intentionally returns undefined. The public status model already exposes a
 * newer cancelled ingestion as unknown; asserting healthy would mask it while asserting
 * degraded/failed would misclassify an operator cancellation. The worker result and any
 * terminal ingestion remain append-only audit evidence.
 */
export function deriveWorkerSourceHealthSnapshot(
  result: WorkerSourceHealthResult,
  previous: PreviousWorkerSourceHealthSnapshot | undefined,
): WorkerSourceHealthSnapshotDraft | undefined {
  if (result.status === "cancelled") return undefined;
  const recordedAt = new Date(result.completedAt);
  if (!Number.isFinite(recordedAt.getTime())) {
    throw new TypeError("completedAt must be a valid date");
  }

  const lastDiscoverySuccessAt = copyBoundedClock(
    previous?.lastDiscoverySuccessAt ?? null,
    recordedAt,
    "lastDiscoverySuccessAt",
  );
  const lastCaptureSuccessAt = copyBoundedClock(
    previous?.lastCaptureSuccessAt ?? null,
    recordedAt,
    "lastCaptureSuccessAt",
  );
  const lastPublishSuccessAt = copyBoundedClock(
    previous?.lastPublishSuccessAt ?? null,
    recordedAt,
    "lastPublishSuccessAt",
  );
  const previousEligibleAt = copyBoundedClock(
    previous?.newestEligibleEvidenceAt ?? null,
    recordedAt,
    "newestEligibleEvidenceAt",
  );
  const madeProgress = (result.status === "succeeded" || result.status === "partial")
    && result.counts.persisted > 0;
  const discoversSourceEvidence = result.jobKind === "catalog-refresh"
    || result.jobKind === "official-offer-ingestion";
  const completedAt = new Date(recordedAt);

  return Object.freeze({
    details: Object.freeze({}),
    geographicScopeId: null,
    lastCaptureSuccessAt: madeProgress ? completedAt : lastCaptureSuccessAt,
    lastDiscoverySuccessAt: madeProgress && discoversSourceEvidence
      ? completedAt
      : lastDiscoverySuccessAt,
    // Worker counters prove capture progress, not a governed public publication.
    lastPublishSuccessAt,
    // Eligibility needs source/runtime/permission/scope binding outside this writer.
    newestEligibleEvidenceAt: previousEligibleAt,
    oldestReviewAgeSeconds: null,
    recordedAt,
    reviewQueueCount: 0,
    sourceId: result.sourceId,
    status: healthState(result),
    workerJobId: result.jobId,
  });
}
