import { describe, expect, it } from "vitest";

import {
  canonicalizeOperationsSourceRosterV1,
  evaluateOperationalAlertsV1,
  operationsEvidenceSnapshotV1Schema,
  operationalAlertAppendReceiptV1Schema,
  operationsRuntimeSnapshotV1Schema,
  operationalAlertExportBatchV1Schema,
  operationalAlertScheduleV1Schema,
  operationalAlertAssessmentV1Schema,
  operationalAlertEvaluationV1Schema,
  operationsAlertRuntimeConfigV1Schema,
  suppliedOperationalStatusesV1Schema,
  type OperationsEvidenceSnapshotV1,
} from "./operations-contracts";

const count = (value: number, capped = false) => ({ capped, value });
const ROSTER_SHA256 = "45225936211664166b78f69790da00e0360368ca7d358cd0719f44b38dd8d04e";
const unknownWorkerJob = {
  completedAt: null,
  lag: "unknown",
  state: "unknown",
  terminalizedAt: null,
} as const;

const evidence: OperationsEvidenceSnapshotV1 = {
  contractVersion: 1,
  hasMoreSources: false,
  observedAt: "2026-07-17T12:00:00.000Z",
  sources: [{
    counts24h: {
      failedIngestions: count(0),
      ingestions: count(2),
      rejectedReviews: count(1),
      reviewDecisions: count(4),
    },
    derived: {
      ordinaryPriceFreshness: "fresh",
      rejectionRate: "low",
      silentZeroPublication: "clear",
      sourceFreshness: "fresh",
      workerLag: "within-target",
    },
    evidenceSignals: {
      "official-offer": {
        freshness: "fresh",
        newestEligibleAt: "2026-07-17T10:45:00.000Z",
      },
      "ordinary-price": {
        freshness: "fresh",
        newestEligibleAt: "2026-07-17T10:30:00.000Z",
      },
    },
    governanceState: "approved-current",
    health: {
      lastCaptureSuccessAt: "2026-07-17T10:00:00.000Z",
      lastDiscoverySuccessAt: "2026-07-17T09:00:00.000Z",
      lastEligibleEvidenceAt: "2026-07-17T10:30:00.000Z",
      lastPublishSuccessAt: "2026-07-17T10:45:00.000Z",
      persistedAt: "2026-07-17T11:00:01.000Z",
      recordedAt: "2026-07-17T11:00:00.000Z",
      state: "healthy",
      workerJobKind: "catalog-refresh",
    },
    latestExtraction: {
      candidateCount: count(2),
      completedAt: "2026-07-17T10:30:00.000Z",
      emptyResult: "not-empty",
      eligiblePublishedOfferCount: count(1),
      state: "completed",
    },
    offers: {
      active: count(3),
      expiredButPublished: count(0),
      expiringWithin48h: count(0),
    },
    reviewQueue: { count: count(1), oldestAgeSeconds: 3_600 },
    sourceId: "fixture-source",
    workerJobs: {
      "benchmark-price-refresh": unknownWorkerJob,
      "catalog-refresh": {
        completedAt: "2026-07-17T10:00:00.000Z",
        lag: "within-target",
        state: "completed",
        terminalizedAt: "2026-07-17T10:00:01.000Z",
      },
      "historical-observation-collection": unknownWorkerJob,
      "official-offer-discovery": unknownWorkerJob,
      "official-offer-fetch": unknownWorkerJob,
      "official-offer-ingestion": unknownWorkerJob,
      "official-offer-lifecycle-reconcile": unknownWorkerJob,
      "physical-store-sync": unknownWorkerJob,
    },
  }],
  sourceRoster: {
    contentSha256: ROSTER_SHA256,
    entries: [{
      requiredEvidenceSignals: ["official-offer", "ordinary-price"],
      requiredWorkerJobKinds: ["catalog-refresh"],
      sourceId: "fixture-source",
    }],
    version: "fixture-roster:v1",
  },
  windowStartedAt: "2026-07-16T12:00:00.000Z",
};

const healthySupplied = {
  apiCoordinator: "healthy",
  apiErrorRate: "normal",
  apiLatency: "within-target",
  apiSaturation: "normal",
  backup: "current",
  certificate: "valid",
  databaseSaturation: "normal",
  disk: "healthy",
} as const;

describe("operations contracts", () => {
  it("produces a complete deterministic closed state for healthy evidence", () => {
    const first = evaluateOperationalAlertsV1(evidence, healthySupplied);
    const second = evaluateOperationalAlertsV1(evidence, healthySupplied);

    expect(second).toEqual(first);
    expect(first.assessments).toHaveLength(14);
    expect(first.sourceRoster).toEqual(evidence.sourceRoster);
    expect(first.assessments.every((entry) => entry.status === "closed")).toBe(true);
    expect(first.assessments.map((entry) => `${entry.alertKey}:${entry.sourceId ?? "global"}`))
      .toEqual([...first.assessments]
        .sort((left, right) => left.alertKey < right.alertKey
          ? -1
          : left.alertKey > right.alertKey
            ? 1
            : (left.sourceId ?? "") < (right.sourceId ?? "")
              ? -1
              : (left.sourceId ?? "") > (right.sourceId ?? "") ? 1 : 0)
        .map((entry) => `${entry.alertKey}:${entry.sourceId ?? "global"}`));
  });

  it("uses locale-independent code-unit order for punctuation-bearing source IDs", () => {
    const sourceIds = ["a-b", "a.b", "a_b"];
    const multiSource = {
      ...evidence,
      sourceRoster: {
        contentSha256: "c".repeat(64),
        entries: sourceIds.map((sourceId) => ({
          ...evidence.sourceRoster.entries[0]!,
          sourceId,
        })),
        version: "punctuation-roster:v1",
      },
      sources: sourceIds.map((sourceId) => ({
        ...evidence.sources[0]!,
        sourceId,
      })),
    };
    const result = evaluateOperationalAlertsV1(multiSource, healthySupplied);
    expect(result.assessments
      .filter(({ alertKey }) => alertKey === "source.freshness")
      .map(({ sourceId }) => sourceId)).toEqual(sourceIds);
  });

  it("binds the exact sorted 8-global plus 6-per-source matrix to the roster", () => {
    const result = evaluateOperationalAlertsV1(evidence, healthySupplied);
    expect(operationalAlertEvaluationV1Schema.safeParse({
      ...result,
      assessments: result.assessments.slice(1),
    }).success).toBe(false);
    expect(operationalAlertEvaluationV1Schema.safeParse({
      ...result,
      assessments: [...result.assessments].reverse(),
    }).success).toBe(false);
    expect(canonicalizeOperationsSourceRosterV1({
      entries: evidence.sourceRoster.entries,
      version: evidence.sourceRoster.version,
    })).toBe(JSON.stringify({
      contractVersion: 1,
      entries: evidence.sourceRoster.entries,
      version: evidence.sourceRoster.version,
    }));
  });

  it("opens fixed warning/critical buckets and never treats unknown as healthy", () => {
    const result = evaluateOperationalAlertsV1({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        derived: {
          ...evidence.sources[0]!.derived,
          ordinaryPriceFreshness: "unknown",
          silentZeroPublication: "detected",
          sourceFreshness: "unknown",
          workerLag: "late",
        },
        evidenceSignals: {
          ...evidence.sources[0]!.evidenceSignals,
          "ordinary-price": { freshness: "unknown", newestEligibleAt: null },
        },
        health: {
          ...evidence.sources[0]!.health!,
          lastCaptureSuccessAt: null,
          lastEligibleEvidenceAt: null,
          lastPublishSuccessAt: null,
        },
        latestExtraction: {
          ...evidence.sources[0]!.latestExtraction!,
          candidateCount: count(0),
          emptyResult: "unexpected-empty",
          eligiblePublishedOfferCount: count(0),
          state: "degraded",
        },
        offers: {
          ...evidence.sources[0]!.offers,
          expiredButPublished: count(1),
          expiringWithin48h: count(2),
        },
        reviewQueue: { count: count(10_000, true), oldestAgeSeconds: 100_000 },
        workerJobs: {
          ...evidence.sources[0]!.workerJobs,
          "catalog-refresh": {
            completedAt: "2026-07-17T05:00:00.000Z",
            lag: "late",
            state: "completed",
            terminalizedAt: "2026-07-17T05:00:01.000Z",
          },
        },
      }],
    }, {
      ...healthySupplied,
      apiCoordinator: "unknown",
      apiErrorRate: "critical",
      apiLatency: "unavailable",
    });

    expect(result.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ alertKey: "api.coordinator-outage", outcome: "unknown", status: "open" }),
      expect.objectContaining({ alertKey: "api.error-rate", outcome: "critical", severity: "critical" }),
      expect.objectContaining({ alertKey: "offer.expired", outcome: "critical", sourceId: "fixture-source" }),
      expect.objectContaining({ alertKey: "review.queue-age", outcome: "warning" }),
      expect.objectContaining({ alertKey: "source.freshness", outcome: "unknown" }),
    ]));
  });

  it("keeps a required failed health state critical without conflating signal freshness", () => {
    const result = evaluateOperationalAlertsV1({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        health: { ...evidence.sources[0]!.health!, state: "failed" },
      }],
    }, healthySupplied);
    expect(result.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ alertKey: "source.freshness", outcome: "ok" }),
      expect.objectContaining({ alertKey: "worker.lag", outcome: "critical" }),
    ]));
  });

  it("ignores a health state that is not bound to a required worker job kind", () => {
    const result = evaluateOperationalAlertsV1({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        health: {
          ...evidence.sources[0]!.health!,
          state: "failed",
          workerJobKind: "benchmark-price-refresh",
        },
      }],
    }, healthySupplied);
    expect(result.assessments).toContainEqual(expect.objectContaining({
      alertKey: "worker.lag",
      outcome: "ok",
    }));
  });

  it("does not let an unrelated aggregate failure override required job evidence", () => {
    const result = evaluateOperationalAlertsV1({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        counts24h: {
          ...evidence.sources[0]!.counts24h,
          failedIngestions: count(1),
        },
      }],
    }, healthySupplied);
    expect(result.assessments).toContainEqual(expect.objectContaining({
      alertKey: "worker.lag",
      outcome: "ok",
      sourceId: "fixture-source",
      status: "closed",
    }));
  });

  it("refuses to evaluate a paginated source directory", () => {
    expect(() => evaluateOperationalAlertsV1({
      ...evidence,
      hasMoreSources: true,
    }, healthySupplied)).toThrow(/incomplete operational source directory/u);
  });

  it("refuses a missing expected source and opens governance revocation", () => {
    expect(operationsEvidenceSnapshotV1Schema.safeParse({
      ...evidence,
      sources: [],
    }).success).toBe(false);

    const result = evaluateOperationalAlertsV1({
      ...evidence,
      sources: [{ ...evidence.sources[0]!, governanceState: "revoked" }],
    }, healthySupplied);
    expect(result.assessments).toContainEqual(expect.objectContaining({
      alertKey: "source.freshness",
      outcome: "critical",
      sourceId: "fixture-source",
      status: "open",
    }));

    for (const governanceState of ["contradictory", "expired"] as const) {
      const critical = evaluateOperationalAlertsV1({
        ...evidence,
        sources: [{ ...evidence.sources[0]!, governanceState }],
      }, healthySupplied);
      expect(critical.assessments).toContainEqual(expect.objectContaining({
        alertKey: "source.freshness",
        outcome: "critical",
      }));
    }
  });

  it("does not call a non-zero extraction clear without eligible published output", () => {
    const parsed = operationsEvidenceSnapshotV1Schema.parse({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        derived: {
          ...evidence.sources[0]!.derived,
          silentZeroPublication: "unknown",
        },
        latestExtraction: {
          ...evidence.sources[0]!.latestExtraction!,
          eligiblePublishedOfferCount: count(0),
        },
      }],
    });
    expect(evaluateOperationalAlertsV1(parsed, healthySupplied).assessments)
      .toContainEqual(expect.objectContaining({
        alertKey: "source.silent-zero-publication",
        outcome: "unknown",
      }));

    const confirmedEmpty = operationsEvidenceSnapshotV1Schema.parse({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        derived: {
          ...evidence.sources[0]!.derived,
          silentZeroPublication: "confirmed-empty",
        },
        latestExtraction: {
          ...evidence.sources[0]!.latestExtraction!,
          candidateCount: count(0),
          emptyResult: "confirmed-empty",
          eligiblePublishedOfferCount: count(0),
        },
      }],
    });
    expect(evaluateOperationalAlertsV1(confirmedEmpty, healthySupplied).assessments)
      .toContainEqual(expect.objectContaining({
        alertKey: "source.silent-zero-publication",
        outcome: "ok",
      }));

    const failedNonEmptyEnvelope = operationsEvidenceSnapshotV1Schema.parse({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        derived: {
          ...evidence.sources[0]!.derived,
          silentZeroPublication: "unknown",
        },
        latestExtraction: {
          ...evidence.sources[0]!.latestExtraction!,
          candidateCount: count(0),
          emptyResult: "not-empty",
          eligiblePublishedOfferCount: count(0),
          state: "failed",
        },
      }],
    });
    expect(evaluateOperationalAlertsV1(failedNonEmptyEnvelope, healthySupplied).assessments)
      .toContainEqual(expect.objectContaining({
        alertKey: "source.silent-zero-publication",
        outcome: "unknown",
      }));
  });

  it("aggregates only required worker job kinds and takes their worst lag", () => {
    const parsed = operationsEvidenceSnapshotV1Schema.parse({
      ...evidence,
      sourceRoster: {
        ...evidence.sourceRoster,
        contentSha256: "a4c46fe32d9185cbda9b73890fed619227e607be8ebe9f30df6ae002fc3339db",
        entries: [{
          ...evidence.sourceRoster.entries[0]!,
          requiredWorkerJobKinds: ["benchmark-price-refresh", "catalog-refresh"],
        }],
      },
      sources: [{
        ...evidence.sources[0]!,
        derived: { ...evidence.sources[0]!.derived, workerLag: "unknown" },
      }],
    });
    expect(evaluateOperationalAlertsV1(parsed, healthySupplied).assessments)
      .toContainEqual(expect.objectContaining({ alertKey: "worker.lag", outcome: "unknown" }));

    const knownLate = operationsEvidenceSnapshotV1Schema.parse({
      ...parsed,
      sources: [{
        ...parsed.sources[0]!,
        derived: { ...parsed.sources[0]!.derived, workerLag: "late" },
        workerJobs: {
          ...parsed.sources[0]!.workerJobs,
          "catalog-refresh": {
            completedAt: "2026-07-17T05:00:00.000Z",
            lag: "late",
            state: "completed",
            terminalizedAt: "2026-07-17T05:00:01.000Z",
          },
        },
      }],
    });
    expect(evaluateOperationalAlertsV1(knownLate, healthySupplied).assessments)
      .toContainEqual(expect.objectContaining({ alertKey: "worker.lag", outcome: "warning" }));
  });

  it("uses the worst required evidence signal and never a newer unrelated maximum", () => {
    const result = operationsEvidenceSnapshotV1Schema.parse({
      ...evidence,
      sources: [{
        ...evidence.sources[0]!,
        derived: {
          ...evidence.sources[0]!.derived,
          sourceFreshness: "stale",
        },
        evidenceSignals: {
          ...evidence.sources[0]!.evidenceSignals,
          "official-offer": {
            freshness: "stale",
            newestEligibleAt: "2026-07-10T10:30:00.000Z",
          },
        },
      }],
    });
    expect(result.sources[0]?.derived.sourceFreshness).toBe("stale");
    expect(evaluateOperationalAlertsV1(result, healthySupplied).assessments)
      .toContainEqual(expect.objectContaining({
        alertKey: "source.freshness",
        outcome: "critical",
      }));
  });

  it("rejects free text, duplicate sources, mismatched scopes, and false capped counts", () => {
    expect(suppliedOperationalStatusesV1Schema.safeParse({
      ...healthySupplied,
      error: "provider response with a private query",
    }).success).toBe(false);
    expect(operationsEvidenceSnapshotV1Schema.safeParse({
      ...evidence,
      sources: [evidence.sources[0], evidence.sources[0]],
    }).success).toBe(false);
    expect(operationsEvidenceSnapshotV1Schema.safeParse({
      ...evidence,
      sources: [{
        ...evidence.sources[0],
        reviewQueue: { count: count(2, true), oldestAgeSeconds: 0 },
      }],
    }).success).toBe(false);
    expect(operationalAlertAssessmentV1Schema.safeParse({
      alertKey: "source.freshness",
      outcome: "ok",
      severity: "info",
      sourceId: null,
      status: "closed",
    }).success).toBe(false);
    expect(operationsEvidenceSnapshotV1Schema.safeParse({
      ...evidence,
      sources: [{
        ...evidence.sources[0],
        derived: { ...evidence.sources[0]!.derived, sourceFreshness: "stale" },
      }],
    }).success).toBe(false);
    expect(operationsEvidenceSnapshotV1Schema.safeParse({
      ...evidence,
      sources: [{
        ...evidence.sources[0],
        evidenceSignals: {
          ...evidence.sources[0]!.evidenceSignals,
          "ordinary-price": {
            freshness: "fresh",
            newestEligibleAt: "2026-07-17T12:00:00.001Z",
          },
        },
      }],
    }).success).toBe(false);
    expect(operationsEvidenceSnapshotV1Schema.safeParse({
      ...evidence,
      sources: [{
        ...evidence.sources[0],
        reviewQueue: { count: count(1), oldestAgeSeconds: null },
      }],
    }).success).toBe(false);
    for (const latestExtraction of [{
      ...evidence.sources[0]!.latestExtraction!,
      candidateCount: count(0),
      emptyResult: "confirmed-empty",
      eligiblePublishedOfferCount: count(0),
      state: "failed",
    }, {
      ...evidence.sources[0]!.latestExtraction!,
      candidateCount: count(0),
      emptyResult: "unexpected-empty",
      eligiblePublishedOfferCount: count(0),
      state: "completed",
    }]) {
      expect(operationsEvidenceSnapshotV1Schema.safeParse({
        ...evidence,
        sources: [{ ...evidence.sources[0]!, latestExtraction }],
      }).success).toBe(false);
    }
  });

  it.each([
    "basket",
    "query",
    "address",
    "coordinates",
    "ip",
    "userAgent",
    "token",
    "requestHash",
    "message",
    "errorText",
  ])("has no telemetry escape hatch named %s", (field) => {
    expect(JSON.stringify(evaluateOperationalAlertsV1(evidence, healthySupplied)))
      .not.toContain(field);
  });
});

describe("operations runtime snapshot contract", () => {
  const runtimeSnapshot = {
    claimBoundary: {
      alertDelivery: "disabled",
      historicalReconstruction: "not-established",
      publicAvailability: "not-established",
      publicOfferEligibility: "not-established",
    },
    completeness: "bounded-aggregate",
    contractVersion: 1,
    kind: "internal-operations-snapshot",
    observedAt: "2026-07-17T12:00:00.000Z",
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
      administrativeRows: {
        activePublishedOffers: count(2),
        expiredPublishedOffers: count(0),
        expiringPublishedOffers: count(1),
        pendingReviewCandidates: count(3),
      },
      governanceState: "conditional",
      health: null,
      latestExtraction: null,
      latestWorkerResults: [{
        completedAt: "2026-07-17T10:00:00.000Z",
        jobKind: "catalog-refresh",
        persistedAt: "2026-07-17T10:00:01.000Z",
        status: "partial",
      }],
      newestOrdinaryPriceAt: "2026-07-17T09:00:00.000Z",
      sourceId: "fixture-source",
      workerResults24h: { nonSuccessful: count(1), total: count(2) },
    }],
  } as const;

  it("accepts only an exact roster-bound aggregate snapshot", () => {
    expect(operationsRuntimeSnapshotV1Schema.parse(runtimeSnapshot)).toEqual(runtimeSnapshot);
    expect(operationsRuntimeSnapshotV1Schema.safeParse({
      ...runtimeSnapshot,
      sources: [],
    }).success).toBe(false);
    expect(operationsRuntimeSnapshotV1Schema.safeParse({
      ...runtimeSnapshot,
      privateReviewReason: "forbidden",
    }).success).toBe(false);
  });

  it("rejects future evidence, duplicate jobs, and contradictory bounded counts", () => {
    for (const invalidSource of [
      {
        ...runtimeSnapshot.sources[0],
        newestOrdinaryPriceAt: "2026-07-17T12:00:00.001Z",
      },
      {
        ...runtimeSnapshot.sources[0],
        latestWorkerResults: [
          runtimeSnapshot.sources[0].latestWorkerResults[0],
          runtimeSnapshot.sources[0].latestWorkerResults[0],
        ],
      },
      {
        ...runtimeSnapshot.sources[0],
        administrativeRows: {
          ...runtimeSnapshot.sources[0].administrativeRows,
          activePublishedOffers: count(0),
          expiringPublishedOffers: count(1),
        },
      },
      {
        ...runtimeSnapshot.sources[0],
        workerResults24h: { nonSuccessful: count(3), total: count(2) },
      },
      {
        ...runtimeSnapshot.sources[0],
        health: {
          lastCaptureSuccessAt: "2026-07-17T11:00:00.500Z",
          lastDiscoverySuccessAt: null,
          lastEligibleEvidenceAt: null,
          lastPublishSuccessAt: null,
          persistedAt: "2026-07-17T11:00:01.000Z",
          recordedAt: "2026-07-17T11:00:00.000Z",
          state: "healthy",
          workerJobKind: "catalog-refresh",
        },
      },
      {
        ...runtimeSnapshot.sources[0],
        latestExtraction: {
          candidateRows: count(1),
          completedAt: "2026-07-17T11:00:00.000Z",
          emptyResult: "confirmed-empty",
          state: "completed",
        },
      },
      {
        ...runtimeSnapshot.sources[0],
        latestExtraction: {
          candidateRows: count(0),
          completedAt: "2026-07-17T11:00:00.000Z",
          emptyResult: "unexpected-empty",
          state: "completed",
        },
      },
    ]) {
      expect(operationsRuntimeSnapshotV1Schema.safeParse({
        ...runtimeSnapshot,
        sources: [invalidSource],
      }).success).toBe(false);
    }
  });
});

describe("operations alert runtime foundation contracts", () => {
  const checkpoint = {
    contractVersion: 1,
    evaluatedAt: "2026-07-17T12:00:00.000Z",
    evaluationContentSha256: "a".repeat(64),
    persistedAt: "2026-07-17T12:00:00.010Z",
    sourceRosterContentSha256: "b".repeat(64),
    sourceRosterVersion: "fixture-roster:v1",
  } as const;

  it("accepts only a bounded canonical schedule and DB-owned checkpoint receipt", () => {
    expect(operationalAlertScheduleV1Schema.parse({
      anchorAt: "2026-07-17T00:00:00.000Z",
      contractVersion: 1,
      intervalMs: 300_000,
      timeoutMs: 30_000,
    })).toBeDefined();
    expect(operationalAlertAppendReceiptV1Schema.parse({
      appended: 14,
      checkpoint,
    })).toBeDefined();
    expect(operationalAlertScheduleV1Schema.safeParse({
      anchorAt: "2026-07-17T00:00:00Z",
      contractVersion: 1,
      intervalMs: 300_000,
      timeoutMs: 30_000,
    }).success).toBe(false);
    expect(operationalAlertAppendReceiptV1Schema.safeParse({
      appended: 14,
      checkpoint: { ...checkpoint, persistedAt: "2026-07-17T11:59:59.999Z" },
    }).success).toBe(false);
  });

  it("requires every activation capability while keeping recipient delivery disabled", () => {
    expect(operationsAlertRuntimeConfigV1Schema.parse({
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
    })).toBeDefined();
    expect(operationsAlertRuntimeConfigV1Schema.safeParse({
      contractVersion: 1,
      enabled: true,
      schedule: {
        anchorAt: "2026-07-17T00:00:00.000Z",
        contractVersion: 1,
        intervalMs: 300_000,
        timeoutMs: 30_000,
      },
    }).success).toBe(false);
    expect(operationsAlertRuntimeConfigV1Schema.safeParse({
      capabilities: {
        appender: "security-definer-v1",
        checkpoint: "database-checkpoint-v1",
        exporter: "bounded-pull-v1",
        suppliedStatuses: "fixed-buckets-v1",
      },
      contractVersion: 1,
      delivery: "webhook",
      enabled: true,
      schedule: {
        anchorAt: "2026-07-17T00:00:00.000Z",
        contractVersion: 1,
        intervalMs: 300_000,
        timeoutMs: 30_000,
      },
    }).success).toBe(false);
  });

  it("bounds and orders the future exporter payload without metadata escape hatches", () => {
    const first = {
      alertKey: "api.latency",
      evaluatedAt: "2026-07-17T12:00:00.000Z",
      eventAt: "2026-07-17T12:00:00.010Z",
      eventId: "41",
      outcome: "warning",
      severity: "warning",
      sourceId: null,
      status: "open",
    } as const;
    expect(operationalAlertExportBatchV1Schema.parse({
      contractVersion: 1,
      events: [first, { ...first, eventId: "42" }],
      hasMore: false,
      nextEventId: "42",
    })).toBeDefined();
    expect(operationalAlertExportBatchV1Schema.safeParse({
      contractVersion: 1,
      events: [{ ...first, message: "private error" }],
      hasMore: false,
      nextEventId: "41",
    }).success).toBe(false);
    expect(operationalAlertExportBatchV1Schema.safeParse({
      contractVersion: 1,
      events: [{ ...first, eventId: "42" }, first],
      hasMore: false,
      nextEventId: "41",
    }).success).toBe(false);
  });
});
