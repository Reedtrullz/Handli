import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeOperationsSourceRosterV1,
  type OperationsSourceRosterV1,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";
import {
  PostgresOperationsAlertExporter,
  PostgresOperationsRuntimeReader,
} from "./operations-runtime";

const AT = new Date("2026-07-17T12:00:00.000Z");
const entries = [{
  requiredEvidenceSignals: ["ordinary-price"] as const,
  requiredWorkerJobKinds: ["catalog-refresh"] as const,
  sourceId: "fixture-source",
}];
const canonical = canonicalizeOperationsSourceRosterV1({
  entries: entries.map((entry) => ({
    requiredEvidenceSignals: [...entry.requiredEvidenceSignals],
    requiredWorkerJobKinds: [...entry.requiredWorkerJobKinds],
    sourceId: entry.sourceId,
  })),
  version: "fixture-roster:v1",
});
const roster: OperationsSourceRosterV1 = {
  contentSha256: createHash("sha256").update(canonical).digest("hex"),
  entries: entries.map((entry) => ({
    requiredEvidenceSignals: [...entry.requiredEvidenceSignals],
    requiredWorkerJobKinds: [...entry.requiredWorkerJobKinds],
    sourceId: entry.sourceId,
  })),
  version: "fixture-roster:v1",
};

type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function query(rows: unknown[]): TestQuery {
  const result = Promise.resolve(rows) as TestQuery;
  result.cancel = vi.fn();
  return result;
}

function database(rows: unknown[]) {
  const captures: { parameters: unknown[]; sql: string }[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return query(rows);
  };
  return { captures, db: { $client: client } as unknown as HandleplanDatabase };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    active_published_offer_rows: "3",
    expired_published_offer_rows: "1",
    expiring_published_offer_rows: "2",
    governance_state: "conditional",
    health_persisted_at: new Date("2026-07-17T11:00:01.000Z"),
    health_recorded_at: new Date("2026-07-17T11:00:00.000Z"),
    health_state: "degraded",
    health_worker_job_kind: "catalog-refresh",
    last_capture_success_at: new Date("2026-07-17T10:30:00.000Z"),
    last_discovery_success_at: new Date("2026-07-17T10:30:00.000Z"),
    last_publish_success_at: null,
    latest_extraction_candidate_rows: "4",
    latest_extraction_completed_at: new Date("2026-07-17T10:45:00.000Z"),
    latest_extraction_empty_result: "not-empty",
    latest_extraction_state: "completed",
    latest_worker_results: [{
      completedAt: "2026-07-17T10:30:00.000Z",
      jobKind: "catalog-refresh",
      persistedAt: "2026-07-17T10:30:01.000Z",
      status: "partial",
    }],
    newest_eligible_evidence_at: null,
    newest_ordinary_price_at: new Date("2026-07-17T10:15:00.000Z"),
    non_successful_worker_results_24h: "1",
    observed_at: AT,
    pending_review_rows: "5",
    source_id: "fixture-source",
    worker_results_24h: "2",
    ...overrides,
  };
}

describe("PostgresOperationsRuntimeReader", () => {
  it("calls only the bounded aggregate function and returns explicit claim limits", async () => {
    const { captures, db } = database([row()]);
    const result = await new PostgresOperationsRuntimeReader(db, roster).read();

    expect(result).toMatchObject({
      claimBoundary: {
        alertDelivery: "disabled",
        historicalReconstruction: "not-established",
        publicAvailability: "not-established",
        publicOfferEligibility: "not-established",
      },
      completeness: "bounded-aggregate",
      observedAt: AT.toISOString(),
      sourceRoster: roster,
      sources: [{
        administrativeRows: {
          activePublishedOffers: { capped: false, value: 3 },
          expiredPublishedOffers: { capped: false, value: 1 },
          expiringPublishedOffers: { capped: false, value: 2 },
          pendingReviewCandidates: { capped: false, value: 5 },
        },
        governanceState: "conditional",
        sourceId: "fixture-source",
        workerResults24h: {
          nonSuccessful: { capped: false, value: 1 },
          total: { capped: false, value: 2 },
        },
      }],
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]!.sql).toContain("public.operations_dashboard_rows_v1");
    expect(captures[0]!.sql).not.toMatch(
      /\b(?:review_actions|publication_captures|extracted_offer_candidates|alert_events)\b/u,
    );
    expect(captures[0]!.parameters).toEqual([["fixture-source"], 1]);
  });

  it("caps overflow sentinels and fails closed for missing, future, or malformed aggregates", async () => {
    const capped = await new PostgresOperationsRuntimeReader(
      database([row({ pending_review_rows: "10001" })]).db,
      roster,
    ).read();
    expect(capped.sources[0]!.administrativeRows.pendingReviewCandidates)
      .toEqual({ capped: true, value: 10_000 });

    for (const rows of [
      [],
      [row({ source_id: "other-source" })],
      [row({ observed_at: new Date("invalid") })],
      [row({ latest_worker_results: [{ message: "private detail" }] })],
      [row({ health_persisted_at: new Date("2026-07-17T12:00:01.000Z") })],
    ]) {
      await expect(new PostgresOperationsRuntimeReader(database(rows).db, roster).read())
        .rejects.toMatchObject({ name: "OperationsRuntimeReaderError" });
    }
  });

  it("rejects a roster whose content digest does not match before any query", () => {
    const { captures, db } = database([row()]);
    expect(() => new PostgresOperationsRuntimeReader(db, {
      ...roster,
      contentSha256: "0".repeat(64),
    })).toThrow(expect.objectContaining({ code: "INVALID_ROSTER" }));
    expect(captures).toHaveLength(0);
  });

  it("cancels the aggregate query without exposing the database error", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new PostgresOperationsRuntimeReader(database([row()]).db, roster)
      .read(controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("accepts fixed discovery and fetch result identities without claiming source health", async () => {
    const result = await new PostgresOperationsRuntimeReader(database([row({
      latest_worker_results: [{
        completedAt: "2026-07-17T10:00:00.000Z",
        jobKind: "official-offer-discovery",
        persistedAt: "2026-07-17T10:00:01.000Z",
        status: "succeeded",
      }, {
        completedAt: "2026-07-17T10:10:00.000Z",
        jobKind: "official-offer-fetch",
        persistedAt: "2026-07-17T10:10:01.000Z",
        status: "succeeded",
      }],
    })]).db, roster).read();
    expect(result.sources[0]?.latestWorkerResults.map(({ jobKind }) => jobKind))
      .toEqual(["official-offer-discovery", "official-offer-fetch"]);
  });
});

describe("PostgresOperationsAlertExporter", () => {
  const event = (eventId: string, overrides: Record<string, unknown> = {}) => ({
    alert_key: "api.latency",
    evaluated_at: new Date("2026-07-17T12:00:00.000Z"),
    event_at: new Date("2026-07-17T12:00:00.010Z"),
    event_id: eventId,
    outcome: "warning",
    severity: "warning",
    source_id: null,
    status: "open",
    ...overrides,
  });

  it("returns a bounded cursor from the transition-only SECURITY DEFINER projection", async () => {
    const { captures, db } = database([event("41"), event("42")]);
    const result = await new PostgresOperationsAlertExporter(db).readBatch("40", 1);
    expect(result).toEqual({
      contractVersion: 1,
      events: [{
        alertKey: "api.latency",
        evaluatedAt: "2026-07-17T12:00:00.000Z",
        eventAt: "2026-07-17T12:00:00.010Z",
        eventId: "41",
        outcome: "warning",
        severity: "warning",
        sourceId: null,
        status: "open",
      }],
      hasMore: true,
      nextEventId: "41",
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.sql).toContain("public.operations_alert_export_rows_v1");
    expect(captures[0]?.sql).not.toContain("alert_events");
    expect(captures[0]?.parameters).toEqual(["40", 1]);
  });

  it("fails closed on unsafe cursors, bounds, or malformed transition rows", async () => {
    for (const [cursor, limit] of [["0", 1], ["1", 0], ["1", 101]] as const) {
      const unavailable = database([]);
      await expect(new PostgresOperationsAlertExporter(unavailable.db)
        .readBatch(cursor, limit)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(unavailable.captures).toHaveLength(0);
    }
    for (const rows of [
      [event("42"), event("41")],
      [event("41", { outcome: "ok", status: "open" })],
      [event("41", { source_id: "private source" })],
    ]) {
      await expect(new PostgresOperationsAlertExporter(database(rows).db)
        .readBatch(null, 2)).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    }
  });
});
