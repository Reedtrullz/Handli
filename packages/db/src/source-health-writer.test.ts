import { describe, expect, it } from "vitest";

import {
  deriveWorkerSourceHealthSnapshot,
  type PreviousWorkerSourceHealthSnapshot,
  type WorkerSourceHealthResult,
} from "./source-health-writer";

const COMPLETED_AT = new Date("2026-07-17T08:00:00.000Z");
const result: WorkerSourceHealthResult = {
  completedAt: COMPLETED_AT,
  counts: {
    accepted: 2,
    failed: 0,
    fetched: 3,
    persisted: 3,
    quarantined: 0,
    unknown: 1,
  },
  jobId: "kassalapp:catalog-refresh:2026-07-17T07:00:00.000Z",
  jobKind: "catalog-refresh",
  sourceId: "kassalapp",
  status: "succeeded",
};

const previous: PreviousWorkerSourceHealthSnapshot = {
  lastCaptureSuccessAt: new Date("2026-07-16T08:00:00.000Z"),
  lastDiscoverySuccessAt: new Date("2026-07-16T07:00:00.000Z"),
  lastPublishSuccessAt: new Date("2026-07-16T08:00:00.000Z"),
  newestEligibleEvidenceAt: new Date("2026-07-16T06:00:00.000Z"),
};

describe("worker source-health snapshot derivation", () => {
  it("records successful accepted-record processing using only allowlisted aggregate clocks", () => {
    expect(deriveWorkerSourceHealthSnapshot(
      result,
      previous,
    )).toEqual({
      details: {},
      geographicScopeId: null,
      lastCaptureSuccessAt: COMPLETED_AT,
      lastDiscoverySuccessAt: COMPLETED_AT,
      lastPublishSuccessAt: previous.lastPublishSuccessAt,
      newestEligibleEvidenceAt: previous.newestEligibleEvidenceAt,
      oldestReviewAgeSeconds: null,
      recordedAt: COMPLETED_AT,
      reviewQueueCount: 0,
      sourceId: "kassalapp",
      status: "healthy",
      workerJobId: result.jobId,
    });
  });

  it("advances discovery and capture, but not publication, for official-offer ingestion", () => {
    const snapshot = deriveWorkerSourceHealthSnapshot({
      ...result,
      jobId: "synthetic:official-offer-ingestion:2026-07-17T07:00:00.000Z",
      jobKind: "official-offer-ingestion",
      sourceId: "synthetic",
    }, previous);
    expect(snapshot).toMatchObject({
      lastCaptureSuccessAt: COMPLETED_AT,
      lastDiscoverySuccessAt: COMPLETED_AT,
      lastPublishSuccessAt: previous.lastPublishSuccessAt,
      newestEligibleEvidenceAt: previous.newestEligibleEvidenceAt,
    });
  });

  it("marks partial progress degraded while retaining real success clocks", () => {
    const snapshot = deriveWorkerSourceHealthSnapshot({
      ...result,
      counts: { ...result.counts, failed: 1 },
      jobKind: "benchmark-price-refresh",
      status: "partial",
    }, previous);

    expect(snapshot).toMatchObject({
      lastCaptureSuccessAt: COMPLETED_AT,
      lastDiscoverySuccessAt: previous.lastDiscoverySuccessAt,
      lastPublishSuccessAt: previous.lastPublishSuccessAt,
      newestEligibleEvidenceAt: previous.newestEligibleEvidenceAt,
      status: "degraded",
    });
  });

  it("fails closed on a nominal ingestion success with zero accepted rows", () => {
    const snapshot = deriveWorkerSourceHealthSnapshot({
      ...result,
      counts: {
        accepted: 0,
        failed: 0,
        fetched: 2,
        persisted: 2,
        quarantined: 2,
        unknown: 0,
      },
      jobKind: "physical-store-sync",
    }, previous);

    expect(snapshot).toMatchObject({
      lastCaptureSuccessAt: COMPLETED_AT,
      lastPublishSuccessAt: previous.lastPublishSuccessAt,
      status: "degraded",
    });
  });

  it.each(["failed", "timed-out"] as const)(
    "maps %s to failed without inventing success",
    (status) => {
      const snapshot = deriveWorkerSourceHealthSnapshot({
        ...result,
        counts: {
          accepted: 0,
          failed: 1,
          fetched: 0,
          persisted: 0,
          quarantined: 0,
          unknown: 0,
        },
        status,
      }, previous);
      expect(snapshot).toMatchObject({ ...previous, status: "failed" });
    },
  );

  it("does not assert a health state for cancellation", () => {
    expect(deriveWorkerSourceHealthSnapshot({
      ...result,
      status: "cancelled",
    }, previous)).toBeUndefined();
  });

  it("rejects future or malformed aggregate clocks", () => {
    expect(() => deriveWorkerSourceHealthSnapshot(result, {
      ...previous,
      lastPublishSuccessAt: new Date("2026-07-18T08:00:00.000Z"),
    })).toThrow(/cannot postdate/u);
  });

  it("never promotes publish or eligibility clocks from raw worker counts", () => {
    const withoutGovernedPublication = deriveWorkerSourceHealthSnapshot(result, undefined);
    expect(withoutGovernedPublication).toMatchObject({
      lastCaptureSuccessAt: COMPLETED_AT,
      lastPublishSuccessAt: null,
      newestEligibleEvidenceAt: null,
    });
  });

  it.each([
    "benchmark-price-refresh",
    "physical-store-sync",
    "historical-observation-collection",
  ] as const)("preserves discovery and governed clocks across %s", (jobKind) => {
    const snapshot = deriveWorkerSourceHealthSnapshot({ ...result, jobKind }, previous);
    expect(snapshot).toMatchObject({
      lastCaptureSuccessAt: COMPLETED_AT,
      lastDiscoverySuccessAt: previous.lastDiscoverySuccessAt,
      lastPublishSuccessAt: previous.lastPublishSuccessAt,
      newestEligibleEvidenceAt: previous.newestEligibleEvidenceAt,
    });
  });

  it("drops non-allowlisted caller metadata instead of serializing it", () => {
    const tainted = {
      ...result,
      address: "private address",
      error: "provider response",
      requestUrl: "https://provider.invalid/private?q=secret",
      token: "private-token",
    } as WorkerSourceHealthResult & Record<string, unknown>;
    const serialized = JSON.stringify(deriveWorkerSourceHealthSnapshot(tainted, previous));
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("secret");
  });
});
