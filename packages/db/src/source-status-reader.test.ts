import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  MAX_PUBLIC_SOURCE_STATUS_ROWS,
  PostgresPublicSourceStatusReader,
} from "./source-status-reader";

const AT = new Date("2026-07-17T12:00:00.000Z");

interface CapturedQuery {
  parameters: unknown[];
  sql: string;
}

type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function row(overrides: Record<string, unknown> = {}) {
  return {
    governance_approved: true,
    health_last_capture_success_at: null,
    health_last_discovery_success_at: new Date("2026-07-17T10:00:00.000Z"),
    health_last_publish_success_at: null,
    health_newest_eligible_evidence_at: new Date("2026-07-17T10:30:00.000Z"),
    health_recorded_at: new Date("2026-07-17T11:00:00.000Z"),
    health_status: "healthy",
    ingestion_completed_at: new Date("2026-07-17T10:45:00.000Z"),
    ingestion_started_at: new Date("2026-07-17T10:30:00.000Z"),
    ingestion_status: "completed",
    runtime_state: "approved",
    scope_country_code: null,
    scope_database_id: null,
    scope_kind: null,
    scope_label: null,
    scope_state: null,
    source_display_name: "Public fixture",
    source_id: "fixture",
    source_kind: "ordinary_price",
    ...overrides,
  };
}

function resolvedQuery(rows: unknown[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function databaseWith(queryFactory: () => TestQuery) {
  const captures: CapturedQuery[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return queryFactory();
  };
  return {
    captures,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

describe("PostgresPublicSourceStatusReader", () => {
  it("reads only the latest bounded allowlisted health and terminal-ingestion state", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([row()]));
    const result = await new PostgresPublicSourceStatusReader(db).read(50, AT);

    expect(result).toEqual({
      entries: [{
        governanceState: "approved",
        health: {
          freshness: "current",
          lastSuccess: {
            captureAt: null,
            discoveryAt: "2026-07-17T10:00:00.000Z",
            eligibleEvidenceAt: "2026-07-17T10:30:00.000Z",
            publishAt: null,
          },
          recordedAt: "2026-07-17T11:00:00.000Z",
          state: "healthy",
        },
        latestTerminalIngestion: {
          completedAt: "2026-07-17T10:45:00.000Z",
          scope: "source-wide",
          startedAt: "2026-07-17T10:30:00.000Z",
          state: "completed",
        },
        scope: null,
        source: {
          displayName: "Public fixture",
          id: "fixture",
          kind: "ordinary-price",
          runtimeState: "approved",
        },
      }],
      hasMore: false,
    });
    const query = captures[0]!;
    expect(query.parameters).toContain(AT.toISOString());
    expect(query.parameters).toContain(51);
    expect(query.sql).toContain("partition by health.source_id, health.geographic_scope_id");
    expect(query.sql).toContain("official_offer_publication_health_facts fact");
    expect(query.sql).toContain("where publication_health_rank = 1");
    expect(query.sql).toContain("publication_health.last_publish_success_at");
    expect(query.sql).toContain("and health.geographic_scope_id is null");
    expect(query.sql).toMatch(
      /publication_health\.persisted_at > health\.persisted_at[\s\S]*?\) then 'degraded'/iu,
    );
    expect(query.sql).toContain("health.recorded_at <= health.persisted_at");
    expect(query.sql).toContain("order by health.persisted_at desc, health.id desc");
    expect(query.sql).not.toContain(
      "publication_health.last_publish_success_at > health.recorded_at",
    );
    expect(query.sql).not.toContain(
      "when health.status = 'healthy' then 'healthy'",
    );
    expect(query.sql).not.toContain("health.*");
    expect(query.sql).toContain("where health_rank = 1");
    expect(query.sql).toContain("run.status <> 'running'");
    expect(query.sql).toContain("where ingestion_rank = 1");
    expect(query.sql).toContain("permission_rank = 1");
    expect(query.sql).toContain("order by permission.created_at desc, permission.id desc");
    expect(query.sql).not.toContain("order by permission.reviewed_at desc");
    expect(query.sql).toContain("source.permission_reviewed_at = permission.reviewed_at");
    expect(query.sql).toContain(
      "source.permission_expires_at is not distinct from permission.valid_until",
    );
    expect(query.sql).toContain("), false) as governance_approved");
    expect(query.sql).toContain("source.public_state_changed_at <=");
    expect(query.sql).toContain("scope.id::text as scope_database_id");
    expect(query.sql).not.toContain("scope.scope_key");
    expect(query.sql).not.toMatch(/address|basket|coordinate|details|error_class|job_id|review_queue/i);
  });

  it("keeps geographic coverage explicit while making its identifier opaque", async () => {
    const { db } = databaseWith(() => resolvedQuery([row({
      scope_country_code: "NO",
      scope_database_id: "42",
      scope_kind: "region",
      scope_label: "Oslo",
      scope_state: "active",
    })]));
    const result = await new PostgresPublicSourceStatusReader(db).read(50, AT);
    expect(result.entries[0]?.scope).toMatchObject({
      countryCode: "NO",
      kind: "region",
      label: "Oslo",
      state: "active",
    });
    expect(result.entries[0]?.scope?.id).toMatch(/^scope:[0-9a-f]{64}$/u);
    expect(result.entries[0]?.scope?.id).not.toBe("42");
  });

  it("does not claim health or approval when no snapshot or current permission exists", async () => {
    const { db } = databaseWith(() => resolvedQuery([row({
      governance_approved: false,
      health_last_discovery_success_at: null,
      health_newest_eligible_evidence_at: null,
      health_recorded_at: null,
      health_status: null,
      ingestion_completed_at: null,
      ingestion_started_at: null,
      ingestion_status: null,
      runtime_state: "conditional",
    })]));
    await expect(new PostgresPublicSourceStatusReader(db).read(50, AT)).resolves.toEqual({
      entries: [expect.objectContaining({
        governanceState: "not-approved",
        health: null,
        latestTerminalIngestion: null,
        source: expect.objectContaining({ runtimeState: "conditional" }),
      })],
      hasMore: false,
    });
  });

  it("fails closed for malformed, future, duplicate, and over-limit rows", async () => {
    for (const invalid of [
      row({ health_status: "mystery" }),
      row({ health_recorded_at: new Date("2026-07-17T12:00:00.001Z") }),
      row({ governance_approved: true, runtime_state: "conditional" }),
      row({ scope_database_id: "42" }),
    ]) {
      const { db } = databaseWith(() => resolvedQuery([invalid]));
      await expect(new PostgresPublicSourceStatusReader(db).read(50, AT))
        .rejects.toMatchObject({ code: "UNAVAILABLE" });
    }

    const duplicate = databaseWith(() => resolvedQuery([row(), row()]));
    await expect(new PostgresPublicSourceStatusReader(duplicate.db).read(50, AT))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });

    const bounded = databaseWith(() => resolvedQuery(
      Array.from({ length: 3 }, (_, index) => row({
        source_display_name: `Fixture ${index}`,
        source_id: `fixture-${index}`,
      })),
    ));
    await expect(new PostgresPublicSourceStatusReader(bounded.db).read(2, AT))
      .resolves.toMatchObject({ entries: expect.arrayContaining([expect.any(Object)]), hasMore: true });
  });

  it("rejects invalid requests before querying and cancels a pending query", async () => {
    const unused = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresPublicSourceStatusReader(unused.db);
    await expect(reader.read(0, AT)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(reader.read(MAX_PUBLIC_SOURCE_STATUS_ROWS + 1, AT))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(reader.read(1, new Date("invalid")))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(unused.captures).toHaveLength(0);

    let reject!: (error: unknown) => void;
    const pending = Object.assign(new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }), { cancel: vi.fn(() => reject(new Error("cancelled"))) }) as TestQuery;
    const database = databaseWith(() => pending);
    const controller = new AbortController();
    const reading = new PostgresPublicSourceStatusReader(database.db)
      .read(10, AT, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "CANCELLED" });
    expect(pending.cancel).toHaveBeenCalledOnce();
  });
});
