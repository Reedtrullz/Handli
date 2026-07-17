import { createHash } from "node:crypto";

import {
  canonicalizeOperationsSourceRosterV1,
  MAX_OPERATIONAL_ALERT_EXPORT_EVENTS,
  MAX_OPERATIONAL_COUNT,
  operationalAlertExportBatchV1Schema,
  operationsRuntimeSnapshotV1Schema,
  operationsSourceRosterV1Schema,
  type BoundedOperationalCount,
  type OperationalAlertExportBatchV1,
  type OperationsRuntimeSnapshotV1,
  type OperationsSourceRosterV1,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

interface OperationsRuntimeRow {
  active_published_offer_rows: unknown;
  expired_published_offer_rows: unknown;
  expiring_published_offer_rows: unknown;
  governance_state: unknown;
  health_persisted_at: unknown;
  health_recorded_at: unknown;
  health_state: unknown;
  health_worker_job_kind: unknown;
  last_capture_success_at: unknown;
  last_discovery_success_at: unknown;
  last_publish_success_at: unknown;
  latest_extraction_candidate_rows: unknown;
  latest_extraction_completed_at: unknown;
  latest_extraction_empty_result: unknown;
  latest_extraction_state: unknown;
  latest_worker_results: unknown;
  newest_eligible_evidence_at: unknown;
  newest_ordinary_price_at: unknown;
  non_successful_worker_results_24h: unknown;
  observed_at: unknown;
  pending_review_rows: unknown;
  source_id: unknown;
  worker_results_24h: unknown;
}

interface OperationsAlertExportRow {
  alert_key: unknown;
  evaluated_at: unknown;
  event_at: unknown;
  event_id: unknown;
  outcome: unknown;
  severity: unknown;
  source_id: unknown;
  status: unknown;
}

export type OperationsRuntimeReaderErrorCode =
  | "CANCELLED"
  | "CORRUPT_RECORD"
  | "INVALID_REQUEST"
  | "INVALID_ROSTER"
  | "UNAVAILABLE";

export class OperationsRuntimeReaderError extends Error {
  constructor(readonly code: OperationsRuntimeReaderErrorCode) {
    super(`Operations runtime reader failed: ${code}`);
    this.name = "OperationsRuntimeReaderError";
  }
}

export interface OperationsRuntimeReader {
  read(signal?: AbortSignal): Promise<OperationsRuntimeSnapshotV1>;
}

export interface OperationsAlertExporter {
  readBatch(
    afterEventId: string | null,
    limit: number,
    signal?: AbortSignal,
  ): Promise<OperationalAlertExportBatchV1>;
}

function fail(code: OperationsRuntimeReaderErrorCode): never {
  throw new OperationsRuntimeReaderError(code);
}

function canonicalRoster(input: OperationsSourceRosterV1): OperationsSourceRosterV1 {
  const parsed = operationsSourceRosterV1Schema.safeParse(input);
  if (!parsed.success) fail("INVALID_ROSTER");
  const digest = createHash("sha256").update(canonicalizeOperationsSourceRosterV1({
    entries: parsed.data.entries,
    version: parsed.data.version,
  }), "utf8").digest("hex");
  if (digest !== parsed.data.contentSha256) fail("INVALID_ROSTER");
  return parsed.data;
}

function timestamp(value: unknown, observedAt?: Date): string {
  const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
  if (
    !Number.isFinite(parsed.getTime())
    || (observedAt !== undefined && parsed > observedAt)
  ) fail("CORRUPT_RECORD");
  return parsed.toISOString();
}

function optionalTimestamp(value: unknown, observedAt: Date): string | null {
  return value === null ? null : timestamp(value, observedAt);
}

function textState<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("CORRUPT_RECORD");
  return value as T;
}

function count(value: unknown): BoundedOperationalCount {
  const numeric = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(numeric)
    || Number(numeric) < 0
    || Number(numeric) > MAX_OPERATIONAL_COUNT + 1
  ) fail("CORRUPT_RECORD");
  return {
    capped: Number(numeric) > MAX_OPERATIONAL_COUNT,
    value: Math.min(Number(numeric), MAX_OPERATIONAL_COUNT),
  };
}

function objectArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 8) fail("CORRUPT_RECORD");
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail("CORRUPT_RECORD");
    }
    return entry as Record<string, unknown>;
  });
}

function sourceIdentifier(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
  ) fail("CORRUPT_RECORD");
  return value;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("CANCELLED");
}

async function awaitAbortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  const cancel = () => query.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const result = await query;
    throwIfCancelled(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) fail("CANCELLED");
    if (error instanceof OperationsRuntimeReaderError) throw error;
    throw new OperationsRuntimeReaderError("UNAVAILABLE");
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export class PostgresOperationsRuntimeReader implements OperationsRuntimeReader {
  private readonly sourceRoster: OperationsSourceRosterV1;

  constructor(
    private readonly db: HandleplanDatabase,
    sourceRosterInput: OperationsSourceRosterV1,
  ) {
    this.sourceRoster = canonicalRoster(sourceRosterInput);
  }

  async read(signal?: AbortSignal): Promise<OperationsRuntimeSnapshotV1> {
    const sourceIds = this.sourceRoster.entries.map(({ sourceId }) => sourceId);
    const rows = await awaitAbortable(this.db.$client<OperationsRuntimeRow[]>`
      select *
      from public.operations_dashboard_rows_v1(
        ${sourceIds}::text[],
        ${sourceIds.length}
      )
    `, signal);
    if (rows.length !== sourceIds.length) fail("CORRUPT_RECORD");

    const observedAtValues = rows.map((row) => timestamp(row.observed_at));
    if (new Set(observedAtValues).size !== 1) fail("CORRUPT_RECORD");
    const observedAt = new Date(observedAtValues[0]!);
    const sources = rows.map((row, index) => {
      const sourceId = sourceIdentifier(row.source_id);
      if (sourceId !== sourceIds[index]) fail("CORRUPT_RECORD");
      const latestWorkerResults = objectArray(row.latest_worker_results).map((job) => ({
        completedAt: timestamp(job.completedAt, observedAt),
        jobKind: textState(job.jobKind, [
          "benchmark-price-refresh",
          "catalog-refresh",
          "historical-observation-collection",
          "official-offer-discovery",
          "official-offer-fetch",
          "official-offer-ingestion",
          "official-offer-lifecycle-reconcile",
          "physical-store-sync",
        ] as const),
        persistedAt: timestamp(job.persistedAt, observedAt),
        status: textState(job.status, [
          "cancelled",
          "failed",
          "partial",
          "succeeded",
          "timed-out",
        ] as const),
      }));

      const healthIsAbsent = row.health_persisted_at === null;
      const health = healthIsAbsent ? null : {
        lastCaptureSuccessAt: optionalTimestamp(row.last_capture_success_at, observedAt),
        lastDiscoverySuccessAt: optionalTimestamp(row.last_discovery_success_at, observedAt),
        lastEligibleEvidenceAt: optionalTimestamp(row.newest_eligible_evidence_at, observedAt),
        lastPublishSuccessAt: optionalTimestamp(row.last_publish_success_at, observedAt),
        persistedAt: timestamp(row.health_persisted_at, observedAt),
        recordedAt: timestamp(row.health_recorded_at, observedAt),
        state: textState(row.health_state, ["degraded", "disabled", "failed", "healthy"] as const),
        workerJobKind: textState(row.health_worker_job_kind, [
          "benchmark-price-refresh",
          "catalog-refresh",
          "historical-observation-collection",
          "official-offer-discovery",
          "official-offer-fetch",
          "official-offer-ingestion",
          "official-offer-lifecycle-reconcile",
          "physical-store-sync",
        ] as const),
      };
      if (healthIsAbsent && [
        row.health_recorded_at,
        row.health_state,
        row.health_worker_job_kind,
        row.last_capture_success_at,
        row.last_discovery_success_at,
        row.last_publish_success_at,
        row.newest_eligible_evidence_at,
      ].some((value) => value !== null)) fail("CORRUPT_RECORD");

      const extractionIsAbsent = row.latest_extraction_completed_at === null;
      const latestExtraction = extractionIsAbsent ? null : {
        candidateRows: count(row.latest_extraction_candidate_rows),
        completedAt: timestamp(row.latest_extraction_completed_at, observedAt),
        emptyResult: textState(row.latest_extraction_empty_result, [
          "confirmed-empty",
          "not-empty",
          "unexpected-empty",
        ] as const),
        state: textState(row.latest_extraction_state, ["completed", "degraded", "failed"] as const),
      };
      if (extractionIsAbsent && [
        row.latest_extraction_candidate_rows,
        row.latest_extraction_empty_result,
        row.latest_extraction_state,
      ].some((value) => value !== null)) fail("CORRUPT_RECORD");

      return {
        administrativeRows: {
          activePublishedOffers: count(row.active_published_offer_rows),
          expiredPublishedOffers: count(row.expired_published_offer_rows),
          expiringPublishedOffers: count(row.expiring_published_offer_rows),
          pendingReviewCandidates: count(row.pending_review_rows),
        },
        governanceState: textState(row.governance_state, [
          "approved-current",
          "approval-incomplete",
          "blocked",
          "conditional",
          "contradictory",
          "expired",
          "revoked",
        ] as const),
        health,
        latestExtraction,
        latestWorkerResults,
        newestOrdinaryPriceAt: optionalTimestamp(row.newest_ordinary_price_at, observedAt),
        sourceId,
        workerResults24h: {
          nonSuccessful: count(row.non_successful_worker_results_24h),
          total: count(row.worker_results_24h),
        },
      };
    });

    const parsed = operationsRuntimeSnapshotV1Schema.safeParse({
      claimBoundary: {
        alertDelivery: "disabled",
        historicalReconstruction: "not-established",
        publicAvailability: "not-established",
        publicOfferEligibility: "not-established",
      },
      completeness: "bounded-aggregate",
      contractVersion: 1,
      kind: "internal-operations-snapshot",
      observedAt: observedAt.toISOString(),
      sourceRoster: this.sourceRoster,
      sources,
    });
    if (!parsed.success) fail("CORRUPT_RECORD");
    throwIfCancelled(signal);
    return parsed.data;
  }
}

function eventIdentifier(value: unknown): string {
  const candidate = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[1-9][0-9]{0,18}$/u.test(candidate)) fail("CORRUPT_RECORD");
  return candidate;
}

/**
 * Reads only the fixed transition projection. It performs no recipient lookup
 * and no delivery; a later off-host adapter can consume this bounded cursor.
 */
export class PostgresOperationsAlertExporter implements OperationsAlertExporter {
  constructor(private readonly db: HandleplanDatabase) {}

  async readBatch(
    afterEventId: string | null,
    limit: number,
    signal?: AbortSignal,
  ): Promise<OperationalAlertExportBatchV1> {
    if (
      (afterEventId !== null && !/^[1-9][0-9]{0,18}$/u.test(afterEventId))
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_OPERATIONAL_ALERT_EXPORT_EVENTS
    ) fail("INVALID_REQUEST");
    const rows = await awaitAbortable(this.db.$client<OperationsAlertExportRow[]>`
      select event_id, alert_key, evaluated_at, event_at, outcome,
        severity, source_id, status
      from public.operations_alert_export_rows_v1(
        ${afterEventId ?? "0"}::bigint,
        ${limit}
      )
    `, signal);
    if (rows.length > limit + 1) fail("CORRUPT_RECORD");
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ({
      alertKey: textState(row.alert_key, [
        "api.coordinator-outage",
        "api.error-rate",
        "api.latency",
        "api.saturation",
        "backup.status",
        "certificate.status",
        "database.saturation",
        "disk.status",
        "offer.expired",
        "offer.expiring",
        "review.queue-age",
        "source.freshness",
        "source.silent-zero-publication",
        "worker.lag",
      ] as const),
      evaluatedAt: timestamp(row.evaluated_at),
      eventAt: timestamp(row.event_at),
      eventId: eventIdentifier(row.event_id),
      outcome: textState(row.outcome, ["critical", "ok", "unknown", "warning"] as const),
      severity: textState(row.severity, ["critical", "info", "warning"] as const),
      sourceId: row.source_id === null ? null : sourceIdentifier(row.source_id),
      status: textState(row.status, ["closed", "open"] as const),
    }));
    const parsed = operationalAlertExportBatchV1Schema.safeParse({
      contractVersion: 1,
      events,
      hasMore,
      nextEventId: events.at(-1)?.eventId ?? null,
    });
    if (!parsed.success) fail("CORRUPT_RECORD");
    return parsed.data;
  }
}
