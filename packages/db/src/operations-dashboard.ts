import { createHash } from "node:crypto";

import {
  canonicalizeOperationsSourceRosterV1,
  MAX_OPERATIONAL_COUNT,
  MAX_OPERATIONAL_SOURCES,
  OPERATIONS_FRESHNESS_TARGET_SECONDS,
  OPERATIONS_WORKER_LAG_TARGET_SECONDS,
  operationalAlertAppendReceiptV1Schema,
  operationsEvidenceSnapshotV1Schema,
  operationsSourceRosterV1Schema,
  operationalAlertEvaluationV1Schema,
  type BoundedOperationalCount,
  type OperationalAlertAppendReceiptV1,
  type OperationalAlertEvaluationV1,
  type OperationsEvidenceSnapshotV1,
  type OperationsSourceRosterV1,
  type OperationalWorkerJobKind,
  type SourceOperationalMetricsV1,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

const WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;
const FRESHNESS_TARGET_MILLISECONDS = OPERATIONS_FRESHNESS_TARGET_SECONDS * 1_000;
const WORKER_LAG_TARGET_MILLISECONDS = OPERATIONS_WORKER_LAG_TARGET_SECONDS * 1_000;

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

export type OperationsRepositoryErrorCode =
  | "CANCELLED"
  | "CORRUPT_RECORD"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

export class OperationsRepositoryError extends Error {
  constructor(readonly code: OperationsRepositoryErrorCode) {
    super(`Operations repository failed: ${code}`);
    this.name = "OperationsRepositoryError";
  }
}

export interface OperationsSnapshotReader {
  read(at: Date, limit: number, signal?: AbortSignal): Promise<OperationsEvidenceSnapshotV1>;
}

export interface OperationalAlertAppender {
  append(
    evaluation: OperationalAlertEvaluationV1,
    signal?: AbortSignal,
  ): Promise<OperationalAlertAppendReceiptV1>;
}

interface OperationsRow {
  active_offer_count: unknown;
  expired_offer_count: unknown;
  expiring_offer_count: unknown;
  failed_ingestion_count: unknown;
  benchmark_ingestion_completed_at: unknown;
  benchmark_ingestion_status: unknown;
  benchmark_ingestion_terminalized_at: unknown;
  governance_state: unknown;
  historical_ingestion_completed_at: unknown;
  historical_ingestion_status: unknown;
  historical_ingestion_terminalized_at: unknown;
  ingestion_count: unknown;
  latest_extraction_candidate_count: unknown;
  latest_extraction_completed_at: unknown;
  latest_extraction_empty_result: unknown;
  latest_extraction_published_offer_count: unknown;
  latest_extraction_status: unknown;
  latest_ingestion_completed_at: unknown;
  latest_ingestion_status: unknown;
  latest_ingestion_terminalized_at: unknown;
  newest_official_offer_at: unknown;
  newest_ordinary_price_at: unknown;
  oldest_review_created_at: unknown;
  rejected_review_count: unknown;
  review_decision_count: unknown;
  review_queue_count: unknown;
  source_id: unknown;
  physical_ingestion_completed_at: unknown;
  physical_ingestion_status: unknown;
  physical_ingestion_terminalized_at: unknown;
}

interface DatabaseClockRow {
  database_clock: unknown;
}

interface AlertAppendRow {
  appended_count: unknown;
  checkpoint_evaluated_at: unknown;
  checkpoint_persisted_at: unknown;
  evaluation_content_sha256: unknown;
  source_roster_content_sha256: unknown;
  source_roster_version: unknown;
}

function fail(code: OperationsRepositoryErrorCode): never {
  throw new OperationsRepositoryError(code);
}

function compareOperationalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRoster(input: OperationsSourceRosterV1): OperationsSourceRosterV1 {
  const parsed = operationsSourceRosterV1Schema.safeParse(input);
  if (!parsed.success) fail("INVALID_REQUEST");
  const expectedDigest = createHash("sha256").update(canonicalizeOperationsSourceRosterV1({
    entries: parsed.data.entries,
    version: parsed.data.version,
  }), "utf8").digest("hex");
  if (parsed.data.contentSha256 !== expectedDigest) fail("INVALID_REQUEST");
  return parsed.data;
}

function finiteClock(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a finite Date`);
  }
  return new Date(value);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("CANCELLED");
}

async function awaitAbortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const result = await query;
    throwIfCancelled(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) fail("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function count(value: unknown): BoundedOperationalCount {
  const numeric = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) < 0 || Number(numeric) > MAX_OPERATIONAL_COUNT + 1) {
    fail("CORRUPT_RECORD");
  }
  return Object.freeze({
    capped: Number(numeric) > MAX_OPERATIONAL_COUNT,
    value: Math.min(Number(numeric), MAX_OPERATIONAL_COUNT),
  });
}

function sourceIdentifier(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 64
    || !/^[a-z0-9][a-z0-9._-]*$/u.test(value)
  ) fail("CORRUPT_RECORD");
  return value;
}

function optionalTimestamp(value: unknown, at: Date): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime()) || date > at) fail("CORRUPT_RECORD");
  return date.toISOString();
}

function requiredTimestamp(value: unknown, at: Date): string {
  const parsed = optionalTimestamp(value, at);
  if (parsed === null) fail("CORRUPT_RECORD");
  return parsed;
}

function state<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("CORRUPT_RECORD");
  return value as T;
}

function freshness(value: string | null, at: Date): "fresh" | "stale" | "unknown" {
  if (value === null) return "unknown";
  return at.getTime() - Date.parse(value) <= FRESHNESS_TARGET_MILLISECONDS ? "fresh" : "stale";
}

function ageSeconds(value: string | null, at: Date): number | null {
  if (value === null) return null;
  const age = Math.floor((at.getTime() - Date.parse(value)) / 1_000);
  if (!Number.isSafeInteger(age) || age < 0) fail("CORRUPT_RECORD");
  return age;
}

function workerJobEvidence(
  jobKind: OperationalWorkerJobKind,
  values: Readonly<{ completedAt: unknown; state: unknown; terminalizedAt: unknown }>,
  at: Date,
): SourceOperationalMetricsV1["workerJobs"][OperationalWorkerJobKind] {
  const completedAt = optionalTimestamp(values.completedAt, at);
  const terminalizedAt = optionalTimestamp(values.terminalizedAt, at);
  if (completedAt === null || terminalizedAt === null) {
    if (completedAt !== null || terminalizedAt !== null || values.state !== null) fail("CORRUPT_RECORD");
    return { completedAt: null, lag: "unknown", state: "unknown", terminalizedAt: null };
  }
  if (Date.parse(completedAt) > Date.parse(terminalizedAt)) fail("CORRUPT_RECORD");
  const lag = at.getTime() - Date.parse(terminalizedAt) <= WORKER_LAG_TARGET_MILLISECONDS
    ? "within-target"
    : "late";
  return {
    completedAt,
    lag,
    state: state(values.state, ["completed", "degraded", "failed", "cancelled"] as const),
    terminalizedAt,
  };
}

function metricsFromRow(
  row: OperationsRow,
  at: Date,
  requirement: OperationsSourceRosterV1["entries"][number],
): SourceOperationalMetricsV1 {
  // source_health_snapshots has no database-owned insertion/as-of clock and
  // worker_job_results.created_at is caller-writable. Until that boundary is
  // hardened, the PostgreSQL reader deliberately emits unknown health rather
  // than ordering worker-supplied clocks as if they were database evidence.
  const health = null;

  const workerJobs = {
    "benchmark-price-refresh": workerJobEvidence("benchmark-price-refresh", {
      completedAt: row.benchmark_ingestion_completed_at,
      state: row.benchmark_ingestion_status,
      terminalizedAt: row.benchmark_ingestion_terminalized_at,
    }, at),
    "catalog-refresh": workerJobEvidence("catalog-refresh", {
      completedAt: row.latest_ingestion_completed_at,
      state: row.latest_ingestion_status,
      terminalizedAt: row.latest_ingestion_terminalized_at,
    }, at),
    "historical-observation-collection": workerJobEvidence("historical-observation-collection", {
      completedAt: row.historical_ingestion_completed_at,
      state: row.historical_ingestion_status,
      terminalizedAt: row.historical_ingestion_terminalized_at,
    }, at),
    // Source-neutral official-offer jobs are part of the fixed vocabulary, but
    // this legacy richer reader cannot trust them until it is moved behind the
    // migration-024 persistence boundary. Unknown is intentionally alerting.
    "official-offer-discovery": workerJobEvidence("official-offer-discovery", {
      completedAt: null,
      state: null,
      terminalizedAt: null,
    }, at),
    "official-offer-fetch": workerJobEvidence("official-offer-fetch", {
      completedAt: null,
      state: null,
      terminalizedAt: null,
    }, at),
    "official-offer-ingestion": workerJobEvidence("official-offer-ingestion", {
      completedAt: null,
      state: null,
      terminalizedAt: null,
    }, at),
    "official-offer-lifecycle-reconcile": workerJobEvidence(
      "official-offer-lifecycle-reconcile",
      { completedAt: null, state: null, terminalizedAt: null },
      at,
    ),
    "physical-store-sync": workerJobEvidence("physical-store-sync", {
      completedAt: row.physical_ingestion_completed_at,
      state: row.physical_ingestion_status,
      terminalizedAt: row.physical_ingestion_terminalized_at,
    }, at),
  };

  const latestExtractionCompletedAt = optionalTimestamp(row.latest_extraction_completed_at, at);
  const latestExtraction = latestExtractionCompletedAt === null ? null : {
    candidateCount: count(row.latest_extraction_candidate_count),
    completedAt: latestExtractionCompletedAt,
    emptyResult: state(row.latest_extraction_empty_result, [
      "not-empty",
      "confirmed-empty",
      "unexpected-empty",
    ] as const),
    eligiblePublishedOfferCount: count(row.latest_extraction_published_offer_count),
    state: state(row.latest_extraction_status, ["completed", "degraded", "failed"] as const),
  };
  if (
    latestExtraction !== null
    && (
      (latestExtraction.emptyResult === "confirmed-empty" && latestExtraction.state !== "completed")
      || (latestExtraction.emptyResult === "unexpected-empty" && latestExtraction.state !== "degraded")
      || (latestExtraction.state === "failed" && latestExtraction.emptyResult !== "not-empty")
    )
  ) fail("CORRUPT_RECORD");
  if (
    latestExtraction === null
    && (
      row.latest_extraction_status !== null
      || row.latest_extraction_candidate_count !== null
      || row.latest_extraction_empty_result !== null
      || row.latest_extraction_published_offer_count !== null
    )
  ) fail("CORRUPT_RECORD");

  const ingestions = count(row.ingestion_count);
  const failedIngestions = count(row.failed_ingestion_count);
  const reviewDecisions = count(row.review_decision_count);
  const rejectedReviews = count(row.rejected_review_count);
  if (
    failedIngestions.value > ingestions.value
    || (!ingestions.capped && failedIngestions.capped)
    || rejectedReviews.value > reviewDecisions.value
    || (!reviewDecisions.capped && rejectedReviews.capped)
  ) fail("CORRUPT_RECORD");

  const newestOrdinaryPriceAt = optionalTimestamp(row.newest_ordinary_price_at, at);
  const newestOfficialOfferAt = optionalTimestamp(row.newest_official_offer_at, at);
  const evidenceSignals = {
    "official-offer": {
      freshness: freshness(newestOfficialOfferAt, at),
      newestEligibleAt: newestOfficialOfferAt,
    },
    "ordinary-price": {
      freshness: freshness(newestOrdinaryPriceAt, at),
      newestEligibleAt: newestOrdinaryPriceAt,
    },
  } as const;
  const requiredSignalFreshness = requirement.requiredEvidenceSignals.map(
    (kind) => evidenceSignals[kind].freshness,
  );
  const sourceFreshness = requiredSignalFreshness.includes("stale")
    ? "stale"
    : requiredSignalFreshness.includes("unknown") ? "unknown" : "fresh";
  const requiredWorkerLag = requirement.requiredWorkerJobKinds.map((kind) => workerJobs[kind].lag);
  const workerLag = requiredWorkerLag.includes("late")
    ? "late"
    : requiredWorkerLag.includes("unknown") ? "unknown" : "within-target";
  const rejectionRate = reviewDecisions.capped || rejectedReviews.capped
    ? "unknown"
    : reviewDecisions.value === 0
      ? "none"
      : rejectedReviews.value * 2 >= reviewDecisions.value ? "high" : "low";
  const silentZeroPublication = latestExtraction === null
    ? "unknown"
    : latestExtraction.emptyResult === "unexpected-empty"
      ? "detected"
      : latestExtraction.emptyResult === "confirmed-empty"
        ? "confirmed-empty"
        : latestExtraction.state === "completed"
            && latestExtraction.eligiblePublishedOfferCount.value > 0
          && !latestExtraction.eligiblePublishedOfferCount.capped
        ? "clear"
        : "unknown";

  const reviewQueueCount = count(row.review_queue_count);
  const oldestReviewCreatedAt = optionalTimestamp(row.oldest_review_created_at, at);
  if ((reviewQueueCount.value === 0) !== (oldestReviewCreatedAt === null)) {
    fail("CORRUPT_RECORD");
  }
  const activeOffers = count(row.active_offer_count);
  const expiringOffers = count(row.expiring_offer_count);
  if (expiringOffers.value > activeOffers.value || (!activeOffers.capped && expiringOffers.capped)) {
    fail("CORRUPT_RECORD");
  }

  return {
    counts24h: { failedIngestions, ingestions, rejectedReviews, reviewDecisions },
    derived: {
      ordinaryPriceFreshness: freshness(newestOrdinaryPriceAt, at),
      rejectionRate,
      silentZeroPublication,
      sourceFreshness,
      workerLag,
    },
    evidenceSignals,
    governanceState: state(row.governance_state, [
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
    offers: {
      active: activeOffers,
      expiredButPublished: count(row.expired_offer_count),
      expiringWithin48h: expiringOffers,
    },
    reviewQueue: {
      count: reviewQueueCount,
      oldestAgeSeconds: ageSeconds(oldestReviewCreatedAt, at),
    },
    sourceId: sourceIdentifier(row.source_id),
    workerJobs,
  };
}

export class PostgresOperationsSnapshotReader implements OperationsSnapshotReader {
  private readonly sourceRoster: OperationsSourceRosterV1;

  constructor(
    private readonly db: HandleplanDatabase,
    sourceRosterInput: OperationsSourceRosterV1,
  ) {
    this.sourceRoster = canonicalRoster(sourceRosterInput);
  }

  async read(atInput: Date, limit: number, signal?: AbortSignal): Promise<OperationsEvidenceSnapshotV1> {
    const at = finiteClock(atInput, "Operations observation clock");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OPERATIONAL_SOURCES) {
      fail("INVALID_REQUEST");
    }
    throwIfCancelled(signal);
    const databaseClocks = await awaitAbortable(this.db.$client<DatabaseClockRow[]>`
      select pg_catalog.clock_timestamp() as database_clock
    `, signal);
    if (databaseClocks.length !== 1) fail("UNAVAILABLE");
    const databaseClockValue = databaseClocks[0]!.database_clock;
    const databaseClock = databaseClockValue instanceof Date
      ? new Date(databaseClockValue)
      : new Date(String(databaseClockValue));
    if (!Number.isFinite(databaseClock.getTime())) fail("CORRUPT_RECORD");
    if (at > databaseClock) fail("INVALID_REQUEST");
    const windowStartedAt = new Date(at.getTime() - WINDOW_MILLISECONDS);
    const rowLimit = limit + 1;
    const countLimit = MAX_OPERATIONAL_COUNT + 1;
    const expiringAt = new Date(at.getTime() + 48 * 60 * 60 * 1_000);
    const expectedSourceIds = this.sourceRoster.entries.map(({ sourceId }) => sourceId);
    const rows = await awaitAbortable(this.db.$client<OperationsRow[]>`
      with bounded_sources as (
        select source.id,
          case
            when source.runtime_state = 'revoked'
              or governance_permission.decision = 'revoked'
              then 'revoked'
            when (
              governance_permission.id is null
              and (
                source.permission_reviewed_at is not null
                or source.permission_expires_at is not null
              )
            ) or (
              governance_permission.id is not null
              and (
                source.permission_reviewed_at is distinct from governance_permission.reviewed_at
                or source.permission_expires_at is distinct from governance_permission.valid_until
              )
            ) then 'contradictory'
            when source.permission_expires_at <= ${at}
              or source.permission_expires_at <= pg_catalog.clock_timestamp()
              or governance_permission.valid_until <= ${at}
              or governance_permission.valid_until <= pg_catalog.clock_timestamp()
              then 'expired'
            when source.runtime_state = 'blocked' then 'blocked'
            when source.runtime_state = 'conditional' then 'conditional'
            when source.runtime_state = 'approved'
              and source.public_state_changed_at <= ${at}
              and source.permission_reviewed_at is not null
              and source.permission_reviewed_at <= ${at}
              and (source.permission_expires_at is null or source.permission_expires_at > ${at})
              and source.permission_reviewed_at = governance_permission.reviewed_at
              and source.permission_expires_at is not distinct from governance_permission.valid_until
              and governance_permission.decision = 'approved'
              and governance_permission.created_at <= ${at}
              and governance_permission.reviewed_at <= ${at}
              and (governance_permission.valid_until is null
                or governance_permission.valid_until > ${at})
              and (governance_permission.valid_until is null
                or governance_permission.valid_until > pg_catalog.clock_timestamp())
              then 'approved-current'
            else 'approval-incomplete'
          end as governance_state
        from data_sources source
        left join lateral (
          select current_permission.id, current_permission.decision, current_permission.reviewed_at,
            current_permission.valid_until, current_permission.created_at
          from source_permissions current_permission
          where current_permission.source_id = source.id
            and current_permission.created_at <= pg_catalog.clock_timestamp()
          order by current_permission.created_at desc, current_permission.id desc
          limit 1
        ) governance_permission on true
        where source.created_at <= ${at}
          and source.id = any(${expectedSourceIds}::text[])
        order by source.id collate "C"
        limit ${rowLimit}
      ),
      trusted_official_extractions as not materialized (
        select extraction.id, extraction.status, extraction.completed_at,
          extraction.empty_result, capture.retrieved_at as captured_at,
          publication.source_id, publication.valid_from as publication_valid_from,
          publication.valid_until as publication_valid_until,
          capture.rights_classification,
          permission.permissions as current_permissions
        from extraction_runs extraction
        inner join publication_captures capture on capture.id = extraction.capture_id
        inner join publications publication on publication.id = capture.publication_id
        inner join data_sources governed_source on governed_source.id = publication.source_id
        inner join geographic_scopes scope on scope.id = publication.geographic_scope_id
        inner join lateral (
          select current_permission.id, current_permission.decision, current_permission.reviewed_at,
            current_permission.valid_until, current_permission.permissions,
            current_permission.created_at
          from source_permissions current_permission
          where current_permission.source_id = publication.source_id
            and current_permission.created_at <= pg_catalog.clock_timestamp()
          order by current_permission.created_at desc, current_permission.id desc
          limit 1
        ) permission on true
        where extraction.status in ('completed', 'degraded', 'failed')
          and extraction.completed_at is not null
          and extraction.completed_at <= ${at}
          and extraction.created_at <= ${at}
          and extraction.started_at <= ${at}
          and extraction.source_started_at is not null
          and extraction.source_started_at <= ${at}
          and extraction.source_completed_at is not null
          and extraction.source_completed_at <= ${at}
          and extraction.extraction_method is not null
          and extraction.extraction_permission_id is not null
          and extraction.permission_capabilities in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and (extraction.extraction_method <> 'ocr' or extraction.ocr_permission_id is not null)
          and capture.created_at <= ${at}
          and capture.retrieved_at <= ${at}
          and capture.capture_permission_id is not null
          and capture.capture_permission_capabilities in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and capture.rights_classification in ('extract_only', 'private_review', 'public_display')
          and publication.created_at <= ${at}
          and publication.discovered_at <= ${at}
          and publication.content_kind is not null
          and publication.declared_geographic_scope is not null
          and publication.edition_identity_sha256 is not null
          and publication.discovery_permission_id is not null
          and pg_catalog.btrim(publication.edition_identity_sha256) = pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              canonical_official_offer_edition_identity(
                publication.source_id,
                publication.external_id,
                publication.chain,
                publication.title,
                publication.content_kind,
                publication.geographic_scope_id,
                publication.declared_geographic_scope,
                publication.valid_from,
                publication.valid_until,
                publication.discovered_at
              ),
              'UTF8'
            )),
            'hex'
          )
          and governed_source.source_kind = 'offer'
          and governed_source.runtime_state = 'approved'
          and governed_source.created_at <= ${at}
          and governed_source.public_state_changed_at <= ${at}
          and governed_source.permission_reviewed_at is not null
          and governed_source.permission_reviewed_at <= ${at}
          and governed_source.permission_reviewed_at = permission.reviewed_at
          and governed_source.permission_expires_at is not distinct from permission.valid_until
          and (governed_source.permission_expires_at is null
            or governed_source.permission_expires_at > ${at})
          and scope.status = 'active'
          and scope.created_at <= ${at}
          and scope.public_state_changed_at <= ${at}
          and permission.decision = 'approved'
          and permission.created_at <= ${at}
          and permission.reviewed_at <= ${at}
          and (permission.valid_until is null or permission.valid_until > ${at})
          and (permission.valid_until is null
            or permission.valid_until > pg_catalog.clock_timestamp())
          and permission.permissions @> '{"officialOffers": true}'::jsonb
          and permission.permissions -> 'officialOfferCapabilities' in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications' in (
            '["extract_only"]'::jsonb,
            '["private_review"]'::jsonb,
            '["public_display"]'::jsonb,
            '["extract_only", "private_review"]'::jsonb,
            '["extract_only", "public_display"]'::jsonb,
            '["private_review", "public_display"]'::jsonb,
            '["extract_only", "private_review", "public_display"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications' ? capture.rights_classification
          and publication.discovery_permission_id = permission.id
          and capture.capture_permission_id = permission.id
          and capture.capture_permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and extraction.extraction_permission_id = permission.id
          and extraction.permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and (
            (extraction.extraction_method = 'ocr'
              and extraction.ocr_permission_id = permission.id
              and permission.permissions -> 'officialOfferCapabilities' ? 'ocr')
            or
            (extraction.extraction_method <> 'ocr'
              and extraction.ocr_permission_id is null)
          )
      ),
      trusted_published_offers as not materialized (
        select distinct offer.id, extraction.id as extraction_id, offer.source_id,
          capture.retrieved_at as captured_at, offer.valid_from, offer.valid_until
        from approved_offers offer
        inner join offer_targets target
          on target.offer_id = offer.id
         and target.family_slug is null
        inner join canonical_products product on product.id = target.product_id
        inner join extracted_offer_candidates candidate on candidate.id = offer.candidate_id
        inner join extraction_runs extraction on extraction.id = candidate.extraction_run_id
        inner join publication_captures capture on capture.id = extraction.capture_id
        inner join publications publication on publication.id = capture.publication_id
        inner join data_sources governed_source on governed_source.id = offer.source_id
        inner join geographic_scopes scope on scope.id = offer.geographic_scope_id
        inner join lateral (
          select current_review.candidate_id, current_review.offer_id,
            current_review.action, current_review.expected_version,
            current_review.acted_at, current_review.created_at,
            current_review.new_values ->> 'state' as decision_state,
            current_review.new_values ->> 'contractVersion' as contract_version,
            current_review.new_values ->> 'reviewVersion' as review_version,
            current_review.new_values ->> 'decisionSha256' as decision_sha256,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              (current_review.new_values -> 'decision')::text,
              'UTF8'
            )), 'hex') as computed_decision_sha256,
            current_review.new_values #>> '{decision,target,kind}' as target_kind,
            current_review.new_values #>> '{decision,target,gtin}' as target_gtin,
            current_review.new_values #>> '{decision,validity,startsAt}' as starts_at,
            current_review.new_values #>> '{decision,validity,endsAt}' as ends_at,
            current_review.new_values #> '{decision,channels}' as channels,
            current_review.new_values #>> '{decision,eligibility,kind}' as eligibility_kind,
            current_review.new_values #>> '{decision,eligibility,programId}' as program_id,
            current_review.new_values #>> '{decision,pricing,kind}' as pricing_kind,
            current_review.new_values #> '{decision,pricing,offerPriceOre}' as offer_price_ore,
            current_review.new_values #> '{decision,pricing,beforePriceOre}' as before_price_ore,
            current_review.new_values #> '{decision,pricing,quantity}' as quantity,
            current_review.new_values #> '{decision,pricing,totalOre}' as total_ore,
            current_review.new_values #> '{decision,pricing,beforeUnitPriceOre}' as before_unit_price_ore
          from review_actions current_review
          where current_review.candidate_id = candidate.id
            and current_review.created_at <= pg_catalog.clock_timestamp()
          order by current_review.created_at desc, current_review.id desc
          limit 1
        ) review on true
        inner join lateral (
          select current_permission.id, current_permission.decision, current_permission.reviewed_at,
            current_permission.valid_until, current_permission.permissions,
            current_permission.created_at
          from source_permissions current_permission
          where current_permission.source_id = offer.source_id
            and current_permission.created_at <= pg_catalog.clock_timestamp()
          order by current_permission.created_at desc, current_permission.id desc
          limit 1
        ) permission on true
        where offer.status = 'published'
          and offer.created_at <= ${at}
          and offer.approved_at <= ${at}
          and offer.updated_at <= ${at}
          and target.created_at <= ${at}
          and product.status = 'active'
          and product.created_at <= ${at}
          and product.public_state_changed_at <= ${at}
          and candidate.created_at <= ${at}
          and extraction.created_at <= ${at}
          and extraction.started_at <= ${at}
          and extraction.status in ('completed', 'degraded')
          and extraction.completed_at is not null
          and extraction.completed_at <= ${at}
          and extraction.source_started_at is not null
          and extraction.source_started_at <= ${at}
          and extraction.source_completed_at is not null
          and extraction.source_completed_at <= ${at}
          and extraction.empty_result = 'not-empty'
          and extraction.extraction_method is not null
          and extraction.extraction_permission_id is not null
          and extraction.permission_capabilities in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and (extraction.extraction_method <> 'ocr' or extraction.ocr_permission_id is not null)
          and capture.created_at <= ${at}
          and capture.retrieved_at <= ${at}
          and capture.capture_permission_id is not null
          and capture.capture_permission_capabilities in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and capture.rights_classification = 'public_display'
          and publication.created_at <= ${at}
          and publication.discovered_at <= ${at}
          and publication.source_id = offer.source_id
          and publication.chain = offer.chain
          and publication.geographic_scope_id = offer.geographic_scope_id
          and publication.valid_from <= offer.valid_from
          and publication.valid_until >= offer.valid_until
          and publication.content_kind is not null
          and publication.declared_geographic_scope is not null
          and publication.edition_identity_sha256 is not null
          and publication.discovery_permission_id is not null
          and pg_catalog.btrim(publication.edition_identity_sha256) = pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              canonical_official_offer_edition_identity(
                publication.source_id,
                publication.external_id,
                publication.chain,
                publication.title,
                publication.content_kind,
                publication.geographic_scope_id,
                publication.declared_geographic_scope,
                publication.valid_from,
                publication.valid_until,
                publication.discovered_at
              ),
              'UTF8'
            )),
            'hex'
          )
          and governed_source.source_kind = 'offer'
          and governed_source.runtime_state = 'approved'
          and governed_source.created_at <= ${at}
          and governed_source.public_state_changed_at <= ${at}
          and governed_source.permission_reviewed_at is not null
          and governed_source.permission_reviewed_at <= ${at}
          and governed_source.permission_reviewed_at = permission.reviewed_at
          and governed_source.permission_expires_at is not distinct from permission.valid_until
          and (governed_source.permission_expires_at is null
            or governed_source.permission_expires_at > ${at})
          and scope.status = 'active'
          and scope.created_at <= ${at}
          and scope.public_state_changed_at <= ${at}
          and review.candidate_id = candidate.id
          and review.offer_id = offer.id
          and review.action in ('approve', 'correct_and_approve')
          and review.expected_version = offer.version - 1
          and review.created_at <= ${at}
          and review.acted_at <= ${at}
          and review.decision_state = 'approved'
          and review.contract_version = '1'
          and review.review_version = '1'
          and review.decision_sha256 = review.computed_decision_sha256
          and review.target_kind = 'exact-product'
          and exists (
            select 1
            from product_identifiers identifier
            where identifier.product_id = target.product_id
              and identifier.value = review.target_gtin
              and identifier.scheme = case pg_catalog.char_length(identifier.value)
                when 8 then 'ean8' else 'ean13'
              end
              and identifier.value ~ '^(?:[0-9]{8}|[0-9]{13})$'
              and identifier.confidence = 100
              and identifier.verified_at is not null
              and identifier.verified_at <= ${at}
              and identifier.created_at <= ${at}
              and identifier.public_state_changed_at <= ${at}
          )
          and review.starts_at
            = pg_catalog.to_char(
              offer.valid_from at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          and review.ends_at
            = pg_catalog.to_char(
              offer.valid_until at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          and review.channels in (
            '["in-store"]'::jsonb,
            '["online"]'::jsonb,
            '["in-store", "online"]'::jsonb,
            '["online", "in-store"]'::jsonb
          )
          and (
            (
              offer.membership_requirement = 'public'
              and review.eligibility_kind = 'public'
              and review.program_id is null
            )
            or
            (
              offer.membership_requirement = 'member'
              and review.eligibility_kind = 'member'
              and review.program_id = pg_catalog.btrim(review.program_id)
              and pg_catalog.length(review.program_id)
                between 1 and 200
            )
          )
          and (
            (
              review.pricing_kind = 'unit'
              and review.offer_price_ore
                = pg_catalog.to_jsonb(offer.amount_ore)
              and review.before_price_ore
                is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)
              and offer.multibuy_quantity is null
              and offer.multibuy_group_amount_ore is null
            )
            or
            (
              review.pricing_kind = 'multibuy'
              and offer.multibuy_quantity between 2 and 100
              and review.quantity
                = pg_catalog.to_jsonb(offer.multibuy_quantity)
              and review.total_ore
                = pg_catalog.to_jsonb(offer.multibuy_group_amount_ore)
              and review.before_unit_price_ore
                is not distinct from pg_catalog.to_jsonb(offer.before_amount_ore)
              and offer.amount_ore = (
                (offer.multibuy_group_amount_ore::bigint
                  + offer.multibuy_quantity::bigint - 1)
                / offer.multibuy_quantity::bigint
              )::integer
              and (
                offer.before_amount_ore is null
                or offer.before_amount_ore::bigint * offer.multibuy_quantity::bigint
                  between offer.multibuy_group_amount_ore::bigint
                    and 9007199254740991::bigint
              )
            )
          )
          and (
            select pg_catalog.count(*)
            from offer_conditions condition
            where condition.offer_id = offer.id
              and condition.created_at <= ${at}
          ) = 1
            + case when offer.membership_requirement = 'member' then 1 else 0 end
            + case when offer.multibuy_quantity is not null then 1 else 0 end
          and exists (
            select 1
            from offer_conditions condition
            where condition.offer_id = offer.id
              and condition.created_at <= ${at}
              and condition.condition_type = 'channel'
              and condition.condition_value = pg_catalog.jsonb_build_object(
                'channels', review.channels
              )
          )
          and (
            (
              offer.membership_requirement = 'public'
              and not exists (
                select 1 from offer_conditions condition
                where condition.offer_id = offer.id
                  and condition.created_at <= ${at}
                  and condition.condition_type = 'membership'
              )
            )
            or exists (
              select 1 from offer_conditions condition
              where condition.offer_id = offer.id
                and condition.created_at <= ${at}
                and condition.condition_type = 'membership'
                and condition.condition_value = pg_catalog.jsonb_build_object(
                  'programId', review.program_id
                )
            )
          )
          and (
            (
              offer.multibuy_quantity is null
              and not exists (
                select 1 from offer_conditions condition
                where condition.offer_id = offer.id
                  and condition.created_at <= ${at}
                  and condition.condition_type = 'quantity'
              )
            )
            or exists (
              select 1 from offer_conditions condition
              where condition.offer_id = offer.id
                and condition.created_at <= ${at}
                and condition.condition_type = 'quantity'
                and condition.condition_value = pg_catalog.jsonb_build_object(
                  'quantity', offer.multibuy_quantity
                )
            )
          )
          and permission.decision = 'approved'
          and permission.created_at <= ${at}
          and permission.reviewed_at <= ${at}
          and (permission.valid_until is null or permission.valid_until > ${at})
          and (permission.valid_until is null
            or permission.valid_until > pg_catalog.clock_timestamp())
          and permission.permissions @> '{"officialOffers": true, "publicDisplay": true}'::jsonb
          and permission.permissions -> 'officialOfferCapabilities' in (
            '["capture", "discover", "extract"]'::jsonb,
            '["capture", "discover", "extract", "ocr"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications' in (
            '["public_display"]'::jsonb,
            '["extract_only", "public_display"]'::jsonb,
            '["private_review", "public_display"]'::jsonb,
            '["extract_only", "private_review", "public_display"]'::jsonb
          )
          and permission.permissions -> 'officialOfferRightsClassifications' ? capture.rights_classification
          and publication.discovery_permission_id = permission.id
          and capture.capture_permission_id = permission.id
          and capture.capture_permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and extraction.extraction_permission_id = permission.id
          and extraction.permission_capabilities
            = permission.permissions -> 'officialOfferCapabilities'
          and (
            (extraction.extraction_method = 'ocr'
              and extraction.ocr_permission_id = permission.id
              and permission.permissions -> 'officialOfferCapabilities' ? 'ocr')
            or
            (extraction.extraction_method <> 'ocr'
              and extraction.ocr_permission_id is null)
          )
      ),
      eligible_public_offers as not materialized (
        select offer.id, offer.extraction_id, offer.source_id, offer.captured_at,
          offer.valid_from, offer.valid_until
        from trusted_published_offers offer
        where offer.captured_at >= ${at} - interval '14 days'
      )
      select
        source.id as source_id,
        source.governance_state,
        latest_ingestion.status as latest_ingestion_status,
        latest_ingestion.completed_at as latest_ingestion_completed_at,
        latest_ingestion.terminalized_at as latest_ingestion_terminalized_at,
        benchmark_ingestion.status as benchmark_ingestion_status,
        benchmark_ingestion.completed_at as benchmark_ingestion_completed_at,
        benchmark_ingestion.terminalized_at as benchmark_ingestion_terminalized_at,
        historical_ingestion.status as historical_ingestion_status,
        historical_ingestion.completed_at as historical_ingestion_completed_at,
        historical_ingestion.terminalized_at as historical_ingestion_terminalized_at,
        physical_ingestion.status as physical_ingestion_status,
        physical_ingestion.completed_at as physical_ingestion_completed_at,
        physical_ingestion.terminalized_at as physical_ingestion_terminalized_at,
        latest_extraction.status as latest_extraction_status,
        latest_extraction.completed_at as latest_extraction_completed_at,
        latest_extraction.empty_result as latest_extraction_empty_result,
        latest_extraction.candidate_count::text as latest_extraction_candidate_count,
        latest_extraction.published_offer_count::text
          as latest_extraction_published_offer_count,
        ingestion_counts.total_count::text as ingestion_count,
        failed_ingestion_counts.total_count::text as failed_ingestion_count,
        review_counts.total_count::text as review_decision_count,
        rejected_review_counts.total_count::text as rejected_review_count,
        review_queue.total_count::text as review_queue_count,
        review_queue.oldest_created_at as oldest_review_created_at,
        active_offers.total_count::text as active_offer_count,
        expiring_offers.total_count::text as expiring_offer_count,
        expired_offers.total_count::text as expired_offer_count,
        official_offer.newest_eligible_at as newest_official_offer_at,
        ordinary_price.newest_observed_at as newest_ordinary_price_at
      from bounded_sources source
      left join lateral (
        select run.status, run.completed_at, run.terminalized_at
        from ingestion_runs run
        where run.source_id = source.id
          and run.run_type = 'catalog'
          and run.status <> 'running'
          and run.completed_at <= ${at}
          and run.terminalized_at <= ${at}
        order by run.terminalized_at desc, run.id desc
        limit 1
      ) latest_ingestion on true
      left join lateral (
        select run.status, run.completed_at, run.terminalized_at
        from ingestion_runs run
        where run.source_id = source.id
          and run.run_type = 'benchmark-prices'
          and run.status <> 'running'
          and run.completed_at <= ${at}
          and run.terminalized_at <= ${at}
        order by run.terminalized_at desc, run.id desc
        limit 1
      ) benchmark_ingestion on true
      left join lateral (
        select run.status, run.completed_at, run.terminalized_at
        from ingestion_runs run
        where run.source_id = source.id
          and run.run_type = 'historical-prices'
          and run.status <> 'running'
          and run.completed_at <= ${at}
          and run.terminalized_at <= ${at}
        order by run.terminalized_at desc, run.id desc
        limit 1
      ) historical_ingestion on true
      left join lateral (
        select run.status, run.completed_at, run.terminalized_at
        from ingestion_runs run
        where run.source_id = source.id
          and run.run_type = 'physical-stores'
          and run.status <> 'running'
          and run.completed_at <= ${at}
          and run.terminalized_at <= ${at}
        order by run.terminalized_at desc, run.id desc
        limit 1
      ) physical_ingestion on true
      left join lateral (
        select extraction.id, extraction.status, extraction.completed_at,
          extraction.empty_result,
          (
            select count(*)
            from (
              select 1
              from extracted_offer_candidates candidate
              where candidate.extraction_run_id = extraction.id
                and candidate.created_at <= ${at}
              limit ${countLimit}
            ) bounded_candidates
          ) as candidate_count,
          (
            select count(*)
            from (
              select 1
              from eligible_public_offers offer
              where offer.extraction_id = extraction.id
              limit ${countLimit}
            ) bounded_published_offers
          ) as published_offer_count
        from trusted_official_extractions extraction
        where extraction.source_id = source.id
          and extraction.publication_valid_from <= ${at}
          and extraction.publication_valid_until > ${at}
          and extraction.rights_classification = 'public_display'
          and extraction.current_permissions
            @> '{"officialOffers": true, "publicDisplay": true}'::jsonb
        order by extraction.completed_at desc, extraction.id desc
        limit 1
      ) latest_extraction on true
      cross join lateral (
        select count(*) as total_count from (
          select 1 from ingestion_runs run
          where run.source_id = source.id
            and run.status <> 'running'
            and run.terminalized_at > ${windowStartedAt}
            and run.terminalized_at <= ${at}
          limit ${countLimit}
        ) bounded
      ) ingestion_counts
      cross join lateral (
        select count(*) as total_count from (
          select 1 from ingestion_runs run
          where run.source_id = source.id
            and run.status in ('failed', 'degraded')
            and run.terminalized_at > ${windowStartedAt}
            and run.terminalized_at <= ${at}
          limit ${countLimit}
        ) bounded
      ) failed_ingestion_counts
      cross join lateral (
        select count(*) as total_count from (
          select 1
          from review_actions action
          inner join extracted_offer_candidates candidate on candidate.id = action.candidate_id
          inner join extraction_runs extraction on extraction.id = candidate.extraction_run_id
          inner join publication_captures capture on capture.id = extraction.capture_id
          inner join publications publication on publication.id = capture.publication_id
          where publication.source_id = source.id
            and action.created_at > ${windowStartedAt}
            and action.created_at <= ${at}
          limit ${countLimit}
        ) bounded
      ) review_counts
      cross join lateral (
        select count(*) as total_count from (
          select 1
          from review_actions action
          inner join extracted_offer_candidates candidate on candidate.id = action.candidate_id
          inner join extraction_runs extraction on extraction.id = candidate.extraction_run_id
          inner join publication_captures capture on capture.id = extraction.capture_id
          inner join publications publication on publication.id = capture.publication_id
          where publication.source_id = source.id
            and action.action = 'reject'
            and action.created_at > ${windowStartedAt}
            and action.created_at <= ${at}
          limit ${countLimit}
        ) bounded
      ) rejected_review_counts
      cross join lateral (
        select count(*) as total_count, min(created_at) as oldest_created_at
        from (
          select candidate.created_at
          from extracted_offer_candidates candidate
          inner join trusted_official_extractions extraction
            on extraction.id = candidate.extraction_run_id
          where extraction.source_id = source.id
            and extraction.rights_classification in ('private_review', 'public_display')
            and extraction.current_permissions @> '{"privateReview": true}'::jsonb
            and candidate.status = 'pending'
            and candidate.created_at <= ${at}
            and not exists (
              select 1 from review_actions action
              where action.candidate_id = candidate.id and action.created_at <= ${at}
            )
          order by candidate.created_at, candidate.id
          limit ${countLimit}
        ) bounded
      ) review_queue
      cross join lateral (
        select count(*) as total_count from (
          select 1 from eligible_public_offers offer
          where offer.source_id = source.id
            and offer.valid_from <= ${at}
            and offer.valid_until > ${at}
          limit ${countLimit}
        ) bounded
      ) active_offers
      cross join lateral (
        select count(*) as total_count from (
          select 1 from eligible_public_offers offer
          where offer.source_id = source.id
            and offer.valid_from <= ${at}
            and offer.valid_until > ${at}
            and offer.valid_until <= ${expiringAt}
          limit ${countLimit}
        ) bounded
      ) expiring_offers
      cross join lateral (
        select count(*) as total_count from (
          select 1 from trusted_published_offers offer
          where offer.source_id = source.id
            and offer.valid_until <= ${at}
          limit ${countLimit}
        ) bounded
      ) expired_offers
      left join lateral (
        select extraction.captured_at as newest_eligible_at
        from trusted_official_extractions extraction
        where extraction.source_id = source.id
          and extraction.publication_valid_from <= ${at}
          and extraction.publication_valid_until > ${at}
          and extraction.rights_classification = 'public_display'
          and extraction.current_permissions
            @> '{"officialOffers": true, "publicDisplay": true}'::jsonb
          and (
            (
              extraction.status = 'completed'
              and extraction.empty_result = 'confirmed-empty'
            )
            or exists (
              select 1
              from eligible_public_offers offer
              where offer.extraction_id = extraction.id
                and offer.valid_from <= ${at}
                and offer.valid_until > ${at}
            )
          )
        order by extraction.captured_at desc, extraction.id desc
        limit 1
      ) official_offer on true
      left join lateral (
        select observation.observed_at as newest_observed_at
        from (
          select candidate_observation.id, candidate_observation.source_id,
            candidate_observation.ingestion_run_id,
            candidate_observation.geographic_scope_id,
            candidate_observation.observed_at, candidate_observation.fetched_at,
            candidate_observation.confidence,
            candidate_observation.claim_eligibility,
            candidate_observation.source_reference is not null as has_source_reference,
            candidate_observation.raw_record_hash is not null as has_raw_record_hash
          from price_observations candidate_observation
          where candidate_observation.source_id = source.id
            and candidate_observation.created_at <= ${at}
            and candidate_observation.observed_at <= ${at}
          order by candidate_observation.observed_at desc, candidate_observation.id desc
          limit ${countLimit}
        ) observation
        inner join ingestion_runs observation_run
          on observation_run.id = observation.ingestion_run_id
         and observation_run.source_id = observation.source_id
        inner join data_sources price_source on price_source.id = observation.source_id
        left join geographic_scopes price_scope
          on price_scope.id = observation.geographic_scope_id
        inner join lateral (
          select current_permission.decision, current_permission.reviewed_at,
            current_permission.valid_until, current_permission.permissions,
            current_permission.created_at
          from source_permissions current_permission
          where current_permission.source_id = price_source.id
            and current_permission.created_at <= pg_catalog.clock_timestamp()
          order by current_permission.created_at desc, current_permission.id desc
          limit 1
        ) price_permission on true
        where observation_run.status = 'completed'
          and observation_run.completed_at is not null
          and observation_run.completed_at <= ${at}
          and observation_run.created_at <= ${at}
          and observation_run.terminalized_at <= ${at}
          and price_source.runtime_state = 'approved'
          and price_source.created_at <= ${at}
          and price_source.public_state_changed_at <= ${at}
          and price_source.permission_reviewed_at is not null
          and price_source.permission_reviewed_at <= ${at}
          and price_source.permission_reviewed_at = price_permission.reviewed_at
          and price_source.permission_expires_at is not distinct from price_permission.valid_until
          and (price_source.permission_expires_at is null or price_source.permission_expires_at > ${at})
          and price_permission.decision = 'approved'
          and price_permission.created_at <= ${at}
          and price_permission.reviewed_at <= ${at}
          and (price_permission.valid_until is null or price_permission.valid_until > ${at})
          and (price_permission.valid_until is null
            or price_permission.valid_until > pg_catalog.clock_timestamp())
          and price_permission.permissions @> '{"ordinaryPrice": true}'::jsonb
          and (
            observation.geographic_scope_id is null
            or (
              price_scope.id is not null
              and price_scope.status = 'active'
              and price_scope.created_at <= ${at}
              and price_scope.public_state_changed_at <= ${at}
            )
          )
          and observation.fetched_at <= ${at}
          and observation.has_source_reference
          and observation.has_raw_record_hash
          and observation.confidence = 100
          and (
            observation.claim_eligibility = 'ordinary_only'
            or (
              observation.claim_eligibility = 'historical_eligible'
              and price_permission.permissions @> '{"priceHistory": true}'::jsonb
            )
          )
        order by observation.observed_at desc, observation.id desc
        limit 1
      ) ordinary_price on true
      order by source.id collate "C"
    `, signal);
    if (rows.length > rowLimit) fail("CORRUPT_RECORD");
    const hasMoreSources = rows.length > limit;
    const boundedRows = rows.slice(0, limit).sort((left, right) =>
      compareOperationalText(sourceIdentifier(left.source_id), sourceIdentifier(right.source_id)));
    const requirements = new Map(this.sourceRoster.entries.map((entry) => [entry.sourceId, entry]));
    const sources = boundedRows.map((row) => {
      const sourceId = sourceIdentifier(row.source_id);
      const requirement = requirements.get(sourceId);
      if (requirement === undefined) fail("CORRUPT_RECORD");
      return metricsFromRow(row, at, requirement);
    });
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
      fail("CORRUPT_RECORD");
    }
    const result = operationsEvidenceSnapshotV1Schema.safeParse({
      contractVersion: 1,
      hasMoreSources,
      observedAt: at.toISOString(),
      sourceRoster: this.sourceRoster,
      sources,
      windowStartedAt: windowStartedAt.toISOString(),
    });
    if (!result.success) fail("CORRUPT_RECORD");
    throwIfCancelled(signal);
    return result.data;
  }
}

export class PostgresOperationalAlertAppender implements OperationalAlertAppender {
  constructor(private readonly db: HandleplanDatabase) {}

  async append(
    evaluationInput: OperationalAlertEvaluationV1,
    signal?: AbortSignal,
  ): Promise<OperationalAlertAppendReceiptV1> {
    const parsed = operationalAlertEvaluationV1Schema.safeParse(evaluationInput);
    if (!parsed.success) fail("INVALID_REQUEST");
    const evaluation = parsed.data;
    canonicalRoster(evaluation.sourceRoster);
    const evaluatedAt = finiteClock(new Date(evaluation.evaluatedAt), "Alert evaluation clock");
    throwIfCancelled(signal);
    const rows = await awaitAbortable(this.db.$client<AlertAppendRow[]>`
      select appended_count, checkpoint_evaluated_at,
        evaluation_content_sha256, checkpoint_persisted_at,
        source_roster_content_sha256, source_roster_version
      from public.append_operations_alert_evaluation_v1(
        ${evaluatedAt},
        ${this.db.$client.json(evaluation.sourceRoster)},
        ${this.db.$client.json(evaluation.assessments)}
      )
    `, signal);
    if (rows.length !== 1) fail("CORRUPT_RECORD");
    const row = rows[0]!;
    const appended = typeof row.appended_count === "number"
      ? row.appended_count
      : typeof row.appended_count === "string" && /^\d+$/u.test(row.appended_count)
        ? Number(row.appended_count)
        : Number.NaN;
    const result = operationalAlertAppendReceiptV1Schema.safeParse({
      appended,
      checkpoint: {
        contractVersion: 1,
        evaluatedAt: requiredTimestamp(row.checkpoint_evaluated_at, new Date(8.64e15)),
        evaluationContentSha256: row.evaluation_content_sha256,
        persistedAt: requiredTimestamp(row.checkpoint_persisted_at, new Date(8.64e15)),
        sourceRosterContentSha256: row.source_roster_content_sha256,
        sourceRosterVersion: row.source_roster_version,
      },
    });
    if (!result.success) fail("CORRUPT_RECORD");
    if (
      result.data.checkpoint.evaluatedAt !== evaluation.evaluatedAt
      || result.data.checkpoint.sourceRosterContentSha256
        !== evaluation.sourceRoster.contentSha256
      || result.data.checkpoint.sourceRosterVersion !== evaluation.sourceRoster.version
    ) fail("CORRUPT_RECORD");
    return result.data;
  }
}
