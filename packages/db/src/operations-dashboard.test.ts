import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeOperationsSourceRosterV1,
  type OperationalAlertEvaluationV1,
  type OperationsSourceRosterV1,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";
import {
  PostgresOperationalAlertAppender,
  PostgresOperationsSnapshotReader,
} from "./operations-dashboard";

const AT = new Date("2026-07-17T12:00:00.000Z");
const ROSTER_SHA256 = "45225936211664166b78f69790da00e0360368ca7d358cd0719f44b38dd8d04e";
const FIXTURE_ROSTER: OperationsSourceRosterV1 = {
  contentSha256: ROSTER_SHA256,
  entries: [{
    requiredEvidenceSignals: ["official-offer", "ordinary-price"],
    requiredWorkerJobKinds: ["catalog-refresh"],
    sourceId: "fixture-source",
  }],
  version: "fixture-roster:v1",
};

interface Capture {
  parameters: unknown[];
  sql: string;
}

type Query<T = unknown[]> = Promise<T> & { cancel: ReturnType<typeof vi.fn> };

function query<T>(value: T): Query<T> {
  const promise = Promise.resolve(value) as Query<T>;
  promise.cancel = vi.fn();
  return promise;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    active_offer_count: "3",
    benchmark_ingestion_completed_at: null,
    benchmark_ingestion_status: null,
    benchmark_ingestion_terminalized_at: null,
    expired_offer_count: "0",
    expiring_offer_count: "1",
    failed_ingestion_count: "1",
    governance_state: "approved-current",
    health_last_capture_success_at: new Date("2026-07-17T10:00:00.000Z"),
    health_last_discovery_success_at: new Date("2026-07-17T09:00:00.000Z"),
    health_last_eligible_evidence_at: new Date("2026-07-17T10:30:00.000Z"),
    health_last_publish_success_at: new Date("2026-07-17T10:45:00.000Z"),
    health_job_completed_at: new Date("2026-07-17T11:00:00.000Z"),
    health_persisted_at: new Date("2026-07-17T11:00:01.000Z"),
    health_recorded_at: new Date("2026-07-17T11:00:00.000Z"),
    health_status: "healthy",
    health_worker_job_kind: "catalog-refresh",
    historical_ingestion_completed_at: null,
    historical_ingestion_status: null,
    historical_ingestion_terminalized_at: null,
    ingestion_count: "4",
    latest_extraction_candidate_count: "2",
    latest_extraction_completed_at: new Date("2026-07-17T10:30:00.000Z"),
    latest_extraction_empty_result: "not-empty",
    latest_extraction_published_offer_count: "1",
    latest_extraction_status: "completed",
    latest_ingestion_completed_at: new Date("2026-07-17T10:00:00.000Z"),
    latest_ingestion_status: "completed",
    latest_ingestion_terminalized_at: new Date("2026-07-17T10:00:01.000Z"),
    newest_official_offer_at: new Date("2026-07-17T10:45:00.000Z"),
    newest_ordinary_price_at: new Date("2026-07-17T10:30:00.000Z"),
    oldest_review_created_at: new Date("2026-07-17T08:00:00.000Z"),
    rejected_review_count: "1",
    review_decision_count: "4",
    review_queue_count: "2",
    source_id: "fixture-source",
    physical_ingestion_completed_at: null,
    physical_ingestion_status: null,
    physical_ingestion_terminalized_at: null,
    ...overrides,
  };
}

function directDatabase(rows: unknown[], databaseClock: Date = AT) {
  const captures: Capture[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return query(strings.join("?").includes("clock_timestamp() as database_clock")
      ? [{ database_clock: databaseClock }]
      : rows);
  };
  return { captures, db: { $client: client } as unknown as HandleplanDatabase };
}

function alertFunctionDatabase(rows: unknown[] = [{
  appended_count: 14,
  checkpoint_evaluated_at: AT,
  checkpoint_persisted_at: new Date("2026-07-17T12:00:00.010Z"),
  evaluation_content_sha256: "a".repeat(64),
  source_roster_content_sha256: ROSTER_SHA256,
  source_roster_version: FIXTURE_ROSTER.version,
}]) {
  const captures: Capture[] = [];
  const executor = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const capture = { parameters, sql: strings.join("?") };
    captures.push(capture);
    return query(rows);
  };
  Object.assign(executor, { json: (value: unknown) => value });
  return { captures, db: { $client: executor } as unknown as HandleplanDatabase };
}

function snapshotReader(
  db: HandleplanDatabase,
  expectedSourceIds: readonly string[] = FIXTURE_ROSTER.entries.map(({ sourceId }) => sourceId),
) {
  const entries = expectedSourceIds.map((sourceId) => ({
      requiredEvidenceSignals: ["official-offer", "ordinary-price"] as const,
      requiredWorkerJobKinds: ["catalog-refresh"] as const,
      sourceId,
    }));
  const canonical = canonicalizeOperationsSourceRosterV1({
    entries: entries.map((entry) => ({
      requiredEvidenceSignals: [...entry.requiredEvidenceSignals],
      requiredWorkerJobKinds: [...entry.requiredWorkerJobKinds],
      sourceId: entry.sourceId,
    })),
    version: "fixture-roster:v1",
  });
  return new PostgresOperationsSnapshotReader(db, {
    contentSha256: createHash("sha256").update(canonical).digest("hex"),
    entries: entries.map((entry) => ({
      requiredEvidenceSignals: [...entry.requiredEvidenceSignals],
      requiredWorkerJobKinds: [...entry.requiredWorkerJobKinds],
      sourceId: entry.sourceId,
    })),
    version: "fixture-roster:v1",
  });
}

const GLOBAL_KEYS = [
  "api.coordinator-outage",
  "api.error-rate",
  "api.latency",
  "api.saturation",
  "backup.status",
  "certificate.status",
  "database.saturation",
  "disk.status",
] as const;
const SOURCE_KEYS = [
  "offer.expired",
  "offer.expiring",
  "review.queue-age",
  "source.freshness",
  "source.silent-zero-publication",
  "worker.lag",
] as const;

function evaluation(
  overrides: Partial<OperationalAlertEvaluationV1["assessments"][number]> = {},
  evaluatedAt = AT,
) {
  const assessments = [
    ...GLOBAL_KEYS.map((alertKey) => ({
      alertKey,
      outcome: "warning" as const,
      severity: "warning" as const,
      sourceId: null,
      status: "open" as const,
    })),
    ...SOURCE_KEYS.map((alertKey) => ({
      alertKey,
      outcome: "warning" as const,
      severity: "warning" as const,
      sourceId: "fixture-source",
      status: "open" as const,
    })),
  ].map((assessment) => assessment.alertKey === "api.latency"
    ? { ...assessment, ...overrides }
    : assessment).sort((left, right) => left.alertKey < right.alertKey
      ? -1
      : left.alertKey > right.alertKey
        ? 1
        : (left.sourceId ?? "") < (right.sourceId ?? "")
          ? -1
          : (left.sourceId ?? "") > (right.sourceId ?? "") ? 1 : 0);
  return {
    assessments,
    contractVersion: 1,
    evaluatedAt: evaluatedAt.toISOString(),
    sourceRoster: FIXTURE_ROSTER,
  } as OperationalAlertEvaluationV1;
}

describe("PostgresOperationsSnapshotReader", () => {
  it("maps bounded aggregate evidence without reading private or request-bearing columns", async () => {
    const { captures, db } = directDatabase([row()]);
    const snapshot = await snapshotReader(db).read(AT, 10);

    expect(snapshot).toMatchObject({
      contractVersion: 1,
      hasMoreSources: false,
      sourceRoster: FIXTURE_ROSTER,
      sources: [{
        counts24h: {
          failedIngestions: { capped: false, value: 1 },
          ingestions: { capped: false, value: 4 },
          rejectedReviews: { capped: false, value: 1 },
          reviewDecisions: { capped: false, value: 4 },
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
        offers: {
          active: { capped: false, value: 3 },
          expiredButPublished: { capped: false, value: 0 },
          expiringWithin48h: { capped: false, value: 1 },
        },
        reviewQueue: { count: { capped: false, value: 2 }, oldestAgeSeconds: 14_400 },
        sourceId: "fixture-source",
        workerJobs: {
          "catalog-refresh": {
            completedAt: "2026-07-17T10:00:00.000Z",
            lag: "within-target",
            state: "completed",
            terminalizedAt: "2026-07-17T10:00:01.000Z",
          },
        },
      }],
    });
    expect(captures).toHaveLength(2);
    expect(captures[0]!.sql).toContain("clock_timestamp() as database_clock");
    const sql = captures[1]!.sql;
    expect(sql).toContain("limit ?");
    expect(sql).toContain("terminalized_at <=");
    expect(sql).toContain("run.run_type = 'catalog'");
    expect(sql).toContain("order by run.terminalized_at desc, run.id desc");
    expect(sql).not.toContain("source_health_snapshots");
    expect(sql).not.toContain("worker_job_results");
    expect(sql).toContain("end as governance_state");
    expect(sql).toContain("governance_permission.decision = 'revoked'");
    expect(sql).toContain("then 'contradictory'");
    expect(sql).toContain("then 'expired'");
    expect(sql).toContain("governance_permission.decision = 'approved'");
    expect(sql).toContain("source.permission_reviewed_at = governance_permission.reviewed_at");
    expect(sql).toContain("source.permission_expires_at is not distinct from governance_permission.valid_until");
    expect(sql).toContain("order by current_permission.created_at desc, current_permission.id desc");
    expect(sql).toContain("candidate.status = 'pending'");
    expect(sql).toContain("offer.status = 'published'");
    expect(sql).toContain("offer.updated_at <=");
    expect(sql).toContain("trusted_official_extractions as not materialized");
    expect(sql).toContain("trusted_published_offers as not materialized");
    expect(sql).toContain("eligible_public_offers as not materialized");
    expect(sql).toContain("from trusted_published_offers offer\n        where offer.captured_at >=");
    expect(sql).toContain("publication.edition_identity_sha256 is not null");
    expect(sql).toContain("permission.permissions -> 'officialOfferRightsClassifications'");
    expect(sql).toContain("from trusted_official_extractions extraction");
    expect(sql).toContain("from eligible_public_offers offer");
    expect(sql).toContain("offer.extraction_id = extraction.id");
    expect(sql).toContain("extraction.current_permissions @> '{\"privateReview\": true}'::jsonb");
    expect(sql).toContain("inner join offer_targets target");
    expect(sql).toContain("and target.family_slug is null");
    expect(sql).toContain("inner join canonical_products product");
    expect(sql).toContain("product.public_state_changed_at <=");
    expect(sql).toContain("review.action in ('approve', 'correct_and_approve')");
    expect(sql).toContain("current_review.created_at <= pg_catalog.clock_timestamp()");
    expect(sql).toContain("order by current_review.created_at desc, current_review.id desc");
    expect(sql).not.toContain("order by current_review.expected_version desc");
    expect(sql).toContain("capture.rights_classification = 'public_display'");
    expect(sql).toContain("permission.permissions @> '{\"officialOffers\": true, \"publicDisplay\": true}'::jsonb");
    expect(sql).toContain("extraction.empty_result = 'not-empty'");
    expect(sql).toContain("extraction.source_completed_at <=");
    expect(sql).toContain("publication.valid_from <= offer.valid_from");
    expect(sql).toContain("canonical_official_offer_edition_identity(");
    expect(sql).toContain("governed_source.source_kind = 'offer'");
    expect(sql).toContain("current_review.new_values ->> 'state' as decision_state");
    expect(sql).toContain("and review.decision_state = 'approved'");
    expect(sql).toContain("and review.channels in");
    expect(sql).toContain("publication.discovery_permission_id = permission.id");
    expect(sql).toContain("capture.capture_permission_id = permission.id");
    expect(sql).toContain("extraction.extraction_permission_id = permission.id");
    expect(sql).toContain("capture.capture_permission_capabilities\n            = permission.permissions -> 'officialOfferCapabilities'");
    expect(sql).toContain("extraction.permission_capabilities\n            = permission.permissions -> 'officialOfferCapabilities'");
    expect(sql).toContain("select extraction.captured_at as newest_eligible_at");
    expect(sql).toContain("extraction.empty_result = 'confirmed-empty'");
    expect(sql).toContain("extraction.publication_valid_from <=");
    expect(sql).toContain("select 1 from trusted_published_offers offer");
    expect(sql).toContain("observation_run.status = 'completed'");
    expect(sql).toContain("observation_run.terminalized_at <=");
    expect(sql).toContain("price_permission.decision = 'approved'");
    expect(sql).toContain("price_permission.permissions @> '{\"ordinaryPrice\": true}'::jsonb");
    expect(sql).toContain("price_scope.status = 'active'");
    expect(sql).not.toContain("max(observation.observed_at)");
    expect(sql).not.toMatch(/\b(details|reason|error_class|normalized_fields|blob_key|user_agent)\b/iu);
    expect(sql).not.toContain("source_reference as");
    expect(sql).not.toMatch(/select\s+(?:[a-z_]+\.)?\*/iu);
    expect(captures[1]!.parameters).toContain(10_001);
    expect(captures[1]!.parameters).toContain(11);
  });

  it("caps saturated counts visibly and reports source pagination", async () => {
    const database = directDatabase([
      row({ ingestion_count: "10001", source_id: "a" }),
      row({ source_id: "b" }),
    ]);
    const snapshot = await snapshotReader(database.db, ["a"]).read(AT, 1);
    expect(snapshot.hasMoreSources).toBe(true);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]?.counts24h.ingestions).toEqual({ capped: true, value: 10_000 });
  });

  it("retains a revoked registry source as explicit non-current governance evidence", async () => {
    const database = directDatabase([row({ governance_state: "revoked" })]);
    const snapshot = await snapshotReader(database.db).read(AT, 10);
    expect(snapshot.sources[0]?.governanceState).toBe("revoked");
  });

  it("does not trust legacy/manual health without a worker-result binding", async () => {
    const database = directDatabase([row({
      health_job_completed_at: null,
      health_last_capture_success_at: null,
      health_last_discovery_success_at: null,
      health_last_eligible_evidence_at: null,
      health_last_publish_success_at: null,
      health_persisted_at: null,
      health_recorded_at: null,
      health_status: null,
      health_worker_job_kind: null,
    })]);
    const snapshot = await snapshotReader(database.db).read(AT, 10);
    expect(snapshot.sources[0]?.health).toBeNull();
  });

  it("classifies trusted empty-result evidence without closing corrupt or failed runs", async () => {
    const confirmed = await snapshotReader(directDatabase([row({
      latest_extraction_candidate_count: "0",
      latest_extraction_empty_result: "confirmed-empty",
      latest_extraction_published_offer_count: "0",
    })]).db).read(AT, 10);
    expect(confirmed.sources[0]?.derived.silentZeroPublication).toBe("confirmed-empty");

    const unexpected = await snapshotReader(directDatabase([row({
      latest_extraction_candidate_count: "0",
      latest_extraction_empty_result: "unexpected-empty",
      latest_extraction_published_offer_count: "0",
      latest_extraction_status: "degraded",
    })]).db).read(AT, 10);
    expect(unexpected.sources[0]?.derived.silentZeroPublication).toBe("detected");

    const failedEnvelope = await snapshotReader(directDatabase([row({
      latest_extraction_candidate_count: "0",
      latest_extraction_empty_result: "not-empty",
      latest_extraction_published_offer_count: "0",
      latest_extraction_status: "failed",
    })]).db).read(AT, 10);
    expect(failedEnvelope.sources[0]?.derived.silentZeroPublication).toBe("unknown");
  });

  it("fails closed for future clocks, inconsistent subsets, malformed counts, and invalid limits", async () => {
    for (const invalid of [
      row({ expiring_offer_count: "4" }),
      row({ rejected_review_count: "5" }),
      row({ review_queue_count: "0" }),
      row({ ingestion_count: "10002" }),
      row({ latest_extraction_published_offer_count: "10002" }),
      row({ latest_ingestion_terminalized_at: new Date("2026-07-17T09:59:59.000Z") }),
      row({ newest_official_offer_at: new Date("2026-07-17T12:00:00.001Z") }),
      row({ governance_state: "mystery" }),
      row({
        latest_extraction_candidate_count: "0",
        latest_extraction_empty_result: "confirmed-empty",
        latest_extraction_published_offer_count: "0",
        latest_extraction_status: "failed",
      }),
      row({
        latest_extraction_candidate_count: "0",
        latest_extraction_empty_result: "unexpected-empty",
        latest_extraction_published_offer_count: "0",
        latest_extraction_status: "completed",
      }),
    ]) {
      const database = directDatabase([invalid]);
      await expect(snapshotReader(database.db).read(AT, 10))
        .rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    }
    const unused = directDatabase([]);
    await expect(snapshotReader(unused.db).read(AT, 0))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(unused.captures).toHaveLength(0);

    const missingExpected = directDatabase([]);
    await expect(snapshotReader(missingExpected.db).read(AT, 10))
      .rejects.toMatchObject({ code: "CORRUPT_RECORD" });

    const future = directDatabase([], new Date("2026-07-17T11:59:59.999Z"));
    await expect(snapshotReader(future.db).read(AT, 10))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(future.captures).toHaveLength(1);

    expect(() => new PostgresOperationsSnapshotReader(directDatabase([]).db, {
      ...FIXTURE_ROSTER,
      contentSha256: "b".repeat(64),
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("PostgresOperationalAlertAppender", () => {
  it("crosses only the typed SECURITY DEFINER boundary and maps its DB checkpoint", async () => {
    const database = alertFunctionDatabase();
    await expect(new PostgresOperationalAlertAppender(database.db).append(evaluation()))
      .resolves.toEqual({
        appended: 14,
        checkpoint: {
          contractVersion: 1,
          evaluatedAt: AT.toISOString(),
          evaluationContentSha256: "a".repeat(64),
          persistedAt: "2026-07-17T12:00:00.010Z",
          sourceRosterContentSha256: ROSTER_SHA256,
          sourceRosterVersion: FIXTURE_ROSTER.version,
        },
      });

    expect(database.captures).toHaveLength(1);
    expect(database.captures[0]?.sql)
      .toContain("public.append_operations_alert_evaluation_v1");
    expect(database.captures[0]?.sql).not.toMatch(
      /\b(?:from|insert\s+into|update|delete\s+from)\s+(?:public\.)?alert_events\b/iu,
    );
    expect(database.captures[0]?.parameters).toEqual([
      AT,
      FIXTURE_ROSTER,
      evaluation().assessments,
    ]);
    expect(JSON.stringify(database.captures[0]?.parameters)).not.toMatch(
      /basket|query|address|coordinate|token|requestHash|userAgent|message|errorText|providerError/iu,
    );
  });

  it("accepts an exact DB-owned replay checkpoint without fabricating transitions", async () => {
    const database = alertFunctionDatabase([{
      appended_count: "0",
      checkpoint_evaluated_at: AT,
      checkpoint_persisted_at: new Date("2026-07-17T12:00:00.010Z"),
      evaluation_content_sha256: "a".repeat(64),
      source_roster_content_sha256: ROSTER_SHA256,
      source_roster_version: FIXTURE_ROSTER.version,
    }]);
    await expect(new PostgresOperationalAlertAppender(database.db).append(evaluation()))
      .resolves.toMatchObject({ appended: 0 });
  });

  it("rejects non-allowlisted input before SQL and malformed function receipts after SQL", async () => {
    const unused = alertFunctionDatabase();
    await expect(new PostgresOperationalAlertAppender(unused.db).append({
      ...evaluation(),
      assessments: [{ ...evaluation().assessments[0]!, message: "private" }],
    } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(unused.captures).toHaveLength(0);

    const mismatchedDigest = alertFunctionDatabase();
    await expect(new PostgresOperationalAlertAppender(mismatchedDigest.db).append({
      ...evaluation(),
      sourceRoster: { ...FIXTURE_ROSTER, contentSha256: "b".repeat(64) },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mismatchedDigest.captures).toHaveLength(0);

    for (const rows of [[], [{
      appended_count: 14,
      checkpoint_evaluated_at: AT,
      checkpoint_persisted_at: new Date("2026-07-17T11:59:59.000Z"),
      evaluation_content_sha256: "invalid",
      source_roster_content_sha256: ROSTER_SHA256,
      source_roster_version: FIXTURE_ROSTER.version,
    }]]) {
      await expect(new PostgresOperationalAlertAppender(alertFunctionDatabase(rows).db)
        .append(evaluation())).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    }
  });

  it("cancels before invoking the atomic function", async () => {
    const controller = new AbortController();
    controller.abort();
    const database = alertFunctionDatabase();
    await expect(new PostgresOperationalAlertAppender(database.db)
      .append(evaluation(), controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(database.captures).toHaveLength(0);
  });
});
