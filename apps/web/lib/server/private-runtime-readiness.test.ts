import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { HandleplanDatabase } from "@handleplan/db/client";
import type { OperationsRuntimeSnapshotV1 } from "@handleplan/domain";

import type { OperationsRuntimeServiceContract } from "./operations-runtime-service";
import {
  BoundedPrivateRuntimeReadinessProbe,
  createOperationsPostgresReadinessCheck,
  createReviewPostgresReadinessCheck,
  PRIVATE_RUNTIME_DATABASE_ROLES,
  PrivateRuntimeReadinessUnavailableError,
} from "./private-runtime-readiness";
import { REQUIRED_DATABASE_MIGRATION } from "./readiness";

function cancelable<T>(value: T) {
  return Object.assign(Promise.resolve(value), { cancel: vi.fn() });
}

function databaseReturning(...results: unknown[]): {
  calls: { strings: readonly string[]; values: readonly unknown[] }[];
  db: HandleplanDatabase;
} {
  const calls: { strings: readonly string[]; values: readonly unknown[] }[] = [];
  let index = 0;
  const client = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const result = results[index];
    index += 1;
    return cancelable(result);
  };
  return {
    calls,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

const operationsSnapshot = {
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
    contentSha256: "a".repeat(64),
    entries: [{
      requiredEvidenceSignals: ["ordinary-price"],
      requiredWorkerJobKinds: ["catalog-refresh"],
      sourceId: "fixture-source",
    }],
    version: "fixture:v1",
  },
  sources: [{}],
} as unknown as OperationsRuntimeSnapshotV1;

describe("private runtime database readiness", () => {
  it("proves review capability and the 026 marker without reopening the migration ledger", async () => {
    const database = databaseReturning([{
      decision_v1_execute: false,
      decision_v2_execute: true,
      evidence_render_execute: true,
      lifecycle_execute: false,
      migration_026_marker: true,
      migration_ledger_select: false,
      queue_execute: true,
      role_name: "handleplan_review",
    }]);
    const check = createReviewPostgresReadinessCheck(database.db);

    await expect(check(new AbortController().signal)).resolves.toBe(true);
    expect(database.calls).toHaveLength(1);
    const sql = database.calls[0]?.strings.join("?") ?? "";
    expect(sql).toContain("has_table_privilege");
    expect(sql).not.toMatch(/from\s+public\.handleplan_schema_migrations/iu);
    expect(database.calls[0]?.values).toEqual([
      "public.private_review_candidate_rows_v1(bigint,timestamp with time zone,text,text,integer,integer,integer,integer,text,timestamp with time zone,bigint,integer)",
      "public.private_review_record_evidence_render_v1(bigint,integer,text,text,text,text,text,text,text,timestamp with time zone)",
      "public.private_review_decide_v1(bigint,integer,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamp with time zone,timestamp with time zone,text[])",
      "public.private_review_decide_v2(bigint,integer,text,text,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamp with time zone,timestamp with time zone,text[])",
      "public.official_offer_lifecycle_reconcile_v1(text,text,text,timestamp with time zone,text,integer,boolean)",
      "public.official_offer_lifecycle_reconcile_v1(text,text,text,timestamp with time zone,text,integer,boolean)",
    ]);
  });

  it("rejects a connected review database with the wrong role or missing migration", async () => {
    const wrongRole = databaseReturning([{
      decision_v1_execute: false,
      decision_v2_execute: true,
      evidence_render_execute: true,
      lifecycle_execute: false,
      migration_026_marker: true,
      migration_ledger_select: false,
      queue_execute: true,
      role_name: "handleplan_web",
    }]);
    const missingMigration = databaseReturning([{
      decision_v1_execute: false,
      decision_v2_execute: true,
      evidence_render_execute: true,
      lifecycle_execute: false,
      migration_026_marker: false,
      migration_ledger_select: false,
      queue_execute: true,
      role_name: "handleplan_review",
    }]);
    const legacyDecisionStillExecutable = databaseReturning([{
      decision_v1_execute: true,
      decision_v2_execute: true,
      evidence_render_execute: true,
      lifecycle_execute: false,
      migration_026_marker: true,
      migration_ledger_select: false,
      queue_execute: true,
      role_name: "handleplan_review",
    }]);

    await expect(createReviewPostgresReadinessCheck(wrongRole.db)(
      new AbortController().signal,
    )).resolves.toBe(false);
    await expect(createReviewPostgresReadinessCheck(missingMigration.db)(
      new AbortController().signal,
    )).resolves.toBe(false);
    await expect(createReviewPostgresReadinessCheck(legacyDecisionStillExecutable.db)(
      new AbortController().signal,
    )).resolves.toBe(false);
  });

  it("keeps operations off the ledger while proving its role, 026 marker, and aggregate read", async () => {
    const database = databaseReturning([{
      dashboard_execute: true,
      lifecycle_execute: false,
      migration_ledger_select: false,
      migration_026_marker: true,
      role_name: "handleplan_operations",
    }]);
    const operationsService: OperationsRuntimeServiceContract = {
      read: vi.fn(async () => operationsSnapshot),
    };
    const check = createOperationsPostgresReadinessCheck(
      database.db,
      operationsService,
      operationsSnapshot.sourceRoster.contentSha256,
    );

    await expect(check(new AbortController().signal)).resolves.toBe(true);
    const sql = database.calls[0]?.strings.join("?") ?? "";
    expect(sql).toContain("has_function_privilege");
    expect(sql).toContain("has_table_privilege");
    expect(sql).toContain("to_regprocedure");
    expect(sql).not.toMatch(/from\s+public\.handleplan_schema_migrations/iu);
    expect(database.calls[0]?.values).toEqual([
      "public.operations_dashboard_rows_v1(text[],integer)",
      "public.official_offer_lifecycle_reconcile_v1(text,text,text,timestamp with time zone,text,integer,boolean)",
      "public.official_offer_lifecycle_reconcile_v1(text,text,text,timestamp with time zone,text,integer,boolean)",
    ]);
    expect(operationsService.read).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("does not call the operations aggregate when role capability or 026 marker is absent", async () => {
    const database = databaseReturning([{
      dashboard_execute: true,
      lifecycle_execute: false,
      migration_ledger_select: false,
      migration_026_marker: false,
      role_name: "handleplan_operations",
    }]);
    const operationsService: OperationsRuntimeServiceContract = {
      read: vi.fn(async () => operationsSnapshot),
    };

    await expect(createOperationsPostgresReadinessCheck(
      database.db,
      operationsService,
      operationsSnapshot.sourceRoster.contentSha256,
    )(new AbortController().signal)).resolves.toBe(false);
    expect(operationsService.read).not.toHaveBeenCalled();
  });
});

describe("bounded private runtime readiness", () => {
  it("returns only the role-bound current-migration contract after the dependency passes", async () => {
    const probe = new BoundedPrivateRuntimeReadinessProbe({
      checkDependency: async () => true,
      expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.review,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "review",
      timeoutMs: 100,
    });

    await expect(probe.check()).resolves.toEqual({
      databaseRole: "handleplan_review",
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "review",
    });
  });

  it("rejects mismatched runtime roles and fails closed on false or timeout", async () => {
    expect(() => new BoundedPrivateRuntimeReadinessProbe({
      checkDependency: async () => true,
      expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.review,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "operations",
      timeoutMs: 100,
    })).toThrow(/role does not match/u);

    const unavailable = new BoundedPrivateRuntimeReadinessProbe({
      checkDependency: async () => false,
      expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.operations,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "operations",
      timeoutMs: 100,
    });
    await expect(unavailable.check()).rejects.toBeInstanceOf(
      PrivateRuntimeReadinessUnavailableError,
    );

    vi.useFakeTimers();
    let dependencySignal: AbortSignal | undefined;
    const timedOut = new BoundedPrivateRuntimeReadinessProbe({
      checkDependency: async (signal) => {
        dependencySignal = signal;
        return await new Promise<boolean>(() => undefined);
      },
      expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.operations,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "operations",
      timeoutMs: 25,
    });
    const pending = timedOut.check();
    const rejected = expect(pending).rejects.toBeInstanceOf(
      PrivateRuntimeReadinessUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(dependencySignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
