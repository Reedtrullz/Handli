import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  type OfficialOfferLifecycleRequestV1,
  OfficialOfferLifecycleRepositoryError,
  PostgresOfficialOfferLifecycleRepository,
} from "./official-offer-lifecycle";

const SCHEDULED_AT = new Date("2026-07-17T08:00:00.000Z");
const DATABASE_AS_OF = new Date("2026-07-17T08:00:01.000Z");
const LEASE_EXPIRES_AT = new Date("2026-07-17T08:00:11.000Z");

type Query = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function query(rows: unknown[]): Query {
  const promise = Promise.resolve(rows) as Query;
  promise.cancel = vi.fn();
  return promise;
}

function database(rows: unknown[]) {
  const captures: Array<{ parameters: unknown[]; sql: string }> = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return query(rows);
  };
  return { captures, db: { $client: client } as unknown as HandleplanDatabase };
}

function request(
  overrides: Partial<OfficialOfferLifecycleRequestV1> = {},
): OfficialOfferLifecycleRequestV1 {
  return {
    batchLimit: 50,
    contractVersion: 1 as const,
    jobId: "offer-source:official-offer-lifecycle-reconcile:2026-07-17T08:00:00.000Z",
    ownerId: `handleplan-offer-lifecycle-v1:${"a".repeat(64)}`,
    publicationRequested: false,
    runId: "offer-lifecycle-run-1",
    scheduledAt: SCHEDULED_AT,
    sourceId: "offer-source",
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    database_as_of: DATABASE_AS_OF,
    expired_count: 1,
    expiry_examined: 2,
    job_id: request().jobId,
    lease_expires_at: LEASE_EXPIRES_AT,
    outcome: "completed",
    publication_examined: 0,
    publication_state: "foundation-disabled",
    published_count: 0,
    replayed: false,
    revoked_count: 0,
    skipped_count: 1,
    source_id: "offer-source",
    ...overrides,
  };
}

describe("PostgresOfficialOfferLifecycleRepository", () => {
  it("uses only the atomic database-clock lifecycle boundary", async () => {
    const { captures, db } = database([row()]);
    await expect(new PostgresOfficialOfferLifecycleRepository(db).reconcile(request()))
      .resolves.toEqual({
        contractVersion: 1,
        databaseAsOf: DATABASE_AS_OF,
        expiredCount: 1,
        expiryExamined: 2,
        jobId: request().jobId,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        outcome: "completed",
        publicationExamined: 0,
        publicationState: "foundation-disabled",
        publishedCount: 0,
        replayed: false,
        revokedCount: 0,
        skippedCount: 1,
        sourceId: "offer-source",
      });
    expect(captures).toHaveLength(1);
    expect(captures[0]!.sql).toContain(
      "from public.official_offer_lifecycle_reconcile_v1(",
    );
    expect(captures[0]!.sql).not.toMatch(
      /\b(?:approved_offers|worker_leases|worker_job_results|source_health_snapshots)\b/u,
    );
    expect(captures[0]!.parameters).toEqual([
      "offer-source",
      request().jobId,
      "offer-lifecycle-run-1",
      SCHEDULED_AT.toISOString(),
      request().ownerId,
      50,
      false,
    ]);
  });

  it("accepts exact immutable replay and lease-unavailable receipts", async () => {
    const replay = database([row({ outcome: "replayed", replayed: true })]);
    await expect(new PostgresOfficialOfferLifecycleRepository(replay.db).reconcile(request()))
      .resolves.toMatchObject({ outcome: "replayed", replayed: true });

    const unavailable = database([row({
      database_as_of: DATABASE_AS_OF,
      expired_count: 0,
      expiry_examined: 0,
      lease_expires_at: LEASE_EXPIRES_AT,
      outcome: "lease-unavailable",
      publication_examined: 0,
      publication_state: "not-evaluated",
      published_count: 0,
      revoked_count: 0,
      skipped_count: 0,
    })]);
    await expect(new PostgresOfficialOfferLifecycleRepository(unavailable.db).reconcile(request()))
      .resolves.toMatchObject({
        outcome: "lease-unavailable",
        publicationState: "not-evaluated",
      });
  });

  it("accepts PostgreSQL timestamp text without weakening receipt validation", async () => {
    const { db } = database([row({
      database_as_of: DATABASE_AS_OF.toISOString(),
      lease_expires_at: LEASE_EXPIRES_AT.toISOString(),
    })]);
    await expect(new PostgresOfficialOfferLifecycleRepository(db).reconcile(request()))
      .resolves.toMatchObject({
        databaseAsOf: DATABASE_AS_OF,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      });
  });

  it.each([
    ["no row", []],
    ["extra row", [row(), row()]],
    ["wrong identity", [row({ job_id: "different" })]],
    ["bad outcome", [row({ outcome: "succeeded" })]],
    ["bad replay marker", [row({ outcome: "replayed", replayed: false })]],
    ["bad accounting", [row({ skipped_count: 0 })]],
    ["over batch", [row({ expiry_examined: 51, skipped_count: 50 })]],
    ["evaluation after lease expiry", [row({
      database_as_of: new Date(LEASE_EXPIRES_AT.getTime() + 1),
    })]],
  ])("fails closed on a corrupt %s receipt", async (_name, rows) => {
    const { db } = database(rows);
    await expect(new PostgresOfficialOfferLifecycleRepository(db).reconcile(request()))
      .rejects.toEqual(new OfficialOfferLifecycleRepositoryError("CORRUPT_RECEIPT"));
  });

  it.each([
    { batchLimit: 0 },
    { batchLimit: 51 },
    { contractVersion: 2 },
    { jobId: " job" },
    { ownerId: "bad\u0000owner" },
    { publicationRequested: "false" },
    { scheduledAt: new Date(Number.NaN) },
    { sourceId: "Uppercase" },
  ])("rejects invalid input before SQL: %j", async (override) => {
    const { captures, db } = database([row()]);
    await expect(new PostgresOfficialOfferLifecycleRepository(db).reconcile(
      request(override as Partial<OfficialOfferLifecycleRequestV1>),
    )).rejects.toThrow();
    expect(captures).toHaveLength(0);
  });

  it("cancels the database statement without converting cancellation to success", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<unknown[]>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }) as Query;
    pending.cancel = vi.fn(() => reject(new Error("cancelled")));
    const client = () => pending;
    const controller = new AbortController();
    const operation = new PostgresOfficialOfferLifecycleRepository(
      { $client: client } as unknown as HandleplanDatabase,
    ).reconcile(request(), controller.signal);
    controller.abort();
    await expect(operation).rejects.toEqual(
      new OfficialOfferLifecycleRepositoryError("CANCELLED"),
    );
    expect(pending.cancel).toHaveBeenCalledOnce();
  });
});
