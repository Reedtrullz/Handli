import { describe, expect, it, vi } from "vitest";

import {
  KASSALAPP_PRODUCTION_SCHEDULES,
  GovernedKassalappSourceAccessPolicy,
  PostgresKassalappTargetProvider,
  PostgresWorkerLeaseProvider,
  PostgresWorkerRuntimeStateStore,
  StaticKassalappSourceAccessPolicy,
  createKassalappRequestAttemptAuthorizer,
  createProductionWorkerRuntime,
} from "./production";
import type { WorkerRunResult } from "./contracts";
import type { KassalappSourceAccessPolicy } from "./kassalapp-handlers";

const SIGNAL = new AbortController().signal;
const EANS = ["7038010000010", "7040000000009"];

describe("production worker adapters", () => {
  it("ships all four deterministic Kassalapp schedules with bounded execution", () => {
    expect(KASSALAPP_PRODUCTION_SCHEDULES.map(({ kind }) => kind).sort()).toEqual([
      "benchmark-price-refresh",
      "catalog-refresh",
      "historical-observation-collection",
      "physical-store-sync",
    ]);
    expect(KASSALAPP_PRODUCTION_SCHEDULES.every(({ sourceId }) => sourceId === "kassalapp")).toBe(true);
    expect(KASSALAPP_PRODUCTION_SCHEDULES.every(({ intervalMs, timeoutMs }) =>
      intervalMs >= 60 * 60 * 1_000 && timeoutMs <= 15 * 60 * 1_000)).toBe(true);
  });

  it("keeps source access conditional by default and exposes no mutable approval path", async () => {
    const policy = new StaticKassalappSourceAccessPolicy();
    await expect(policy.getAccessState({
      jobKind: "catalog-refresh",
      sourceId: "kassalapp",
    }, SIGNAL)).resolves.toBe("conditional");
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([
    ["conditional", undefined, "conditional"],
    ["approved", undefined, "blocked"],
    ["approved", {
      permissionCurrent: true,
      permissionDecision: "approved",
      permissions: { catalog: true },
      runtimeState: "conditional",
      sourcePermissionCurrent: true,
    }, "conditional"],
    ["approved", {
      permissionCurrent: false,
      permissionDecision: "approved",
      permissions: { catalog: true },
      runtimeState: "approved",
      sourcePermissionCurrent: true,
    }, "blocked"],
    ["approved", {
      permissionCurrent: true,
      permissionDecision: "approved",
      permissions: { catalog: true },
      runtimeState: "approved",
      sourcePermissionCurrent: false,
    }, "blocked"],
    ["approved", {
      permissionCurrent: true,
      permissionDecision: "revoked",
      permissions: { catalog: true },
      runtimeState: "approved",
      sourcePermissionCurrent: true,
    }, "revoked"],
    ["approved", {
      permissionCurrent: true,
      permissionDecision: "approved",
      permissions: { ordinaryPrice: true },
      runtimeState: "approved",
      sourcePermissionCurrent: true,
    }, "blocked"],
    ["approved", {
      permissionCurrent: true,
      permissionDecision: "approved",
      permissions: { catalog: true },
      runtimeState: "approved",
      sourcePermissionCurrent: true,
    }, "approved"],
  ] as const)(
    "requires deployment=%s plus current database governance before catalog access",
    async (deploymentState, snapshot, expected) => {
      const reader = { getSourceAccess: vi.fn(async () => snapshot) };
      const policy = new GovernedKassalappSourceAccessPolicy(deploymentState, reader);

      await expect(policy.getAccessState({
        jobKind: "catalog-refresh",
        sourceId: "kassalapp",
      }, SIGNAL)).resolves.toBe(expected);
      expect(reader.getSourceAccess).toHaveBeenCalledTimes(deploymentState === "approved" ? 1 : 0);
    },
  );

  it("requires a distinct approved permission scope for every ingestion class", async () => {
    const reader = {
      getSourceAccess: vi.fn(async () => ({
        permissionCurrent: true,
        permissionDecision: "approved" as const,
        permissions: {
          catalog: true,
          ordinaryPrice: true,
          priceHistory: true,
          physicalStore: false,
        },
        runtimeState: "approved" as const,
        sourcePermissionCurrent: true,
      })),
    };
    const policy = new GovernedKassalappSourceAccessPolicy("approved", reader);

    await expect(policy.getAccessState({
      jobKind: "benchmark-price-refresh",
      sourceId: "kassalapp",
    }, SIGNAL)).resolves.toBe("approved");
    await expect(policy.getAccessState({
      jobKind: "historical-observation-collection",
      sourceId: "kassalapp",
    }, SIGNAL)).resolves.toBe("approved");
    await expect(policy.getAccessState({
      jobKind: "physical-store-sync",
      sourceId: "kassalapp",
    }, SIGNAL)).resolves.toBe("blocked");

    const ordinaryOnly = new GovernedKassalappSourceAccessPolicy("approved", {
      getSourceAccess: async () => ({
        permissionCurrent: true,
        permissionDecision: "approved",
        permissions: { ordinaryPrice: true, priceHistory: false },
        runtimeState: "approved",
        sourcePermissionCurrent: true,
      }),
    });
    await expect(ordinaryOnly.getAccessState({
      jobKind: "historical-observation-collection",
      sourceId: "kassalapp",
    }, SIGNAL)).resolves.toBe("blocked");
  });

  it("maps every low-level source attempt scope back through current worker governance", async () => {
    const getAccessState = vi.fn<KassalappSourceAccessPolicy["getAccessState"]>(
      async () => "approved" as const,
    );
    const authorize = createKassalappRequestAttemptAuthorizer({ getAccessState });

    for (const scope of [
      "catalog",
      "ordinary-price",
      "physical-store",
      "price-history",
    ] as const) {
      await expect(authorize({ attempt: 1, scope }, SIGNAL)).resolves.toBeUndefined();
    }

    expect(getAccessState.mock.calls.map(([context]) => context.jobKind)).toEqual([
      "catalog-refresh",
      "benchmark-price-refresh",
      "physical-store-sync",
      "historical-observation-collection",
    ]);

    const revoked = createKassalappRequestAttemptAuthorizer({
      getAccessState: vi.fn(async () => "revoked" as const),
    });
    await expect(revoked({ attempt: 2, scope: "catalog" }, SIGNAL)).rejects.toThrow(
      "Kassalapp request attempt is not authorized",
    );
  });

  it("bounds, deduplicates, and sorts verified database targets", async () => {
    const reader = {
      getCatalogDiscoveryPage: vi.fn(async () => 3),
      getCatalogGtins: vi.fn(async () => [...EANS, EANS[0]!]),
      getPriceGtins: vi.fn(async () => [...EANS].reverse()),
    };
    const targets = new PostgresKassalappTargetProvider(reader, 2);

    await expect(targets.getCatalogDiscoveryPage(SIGNAL)).resolves.toBe(3);
    await expect(targets.getCatalogTargets(SIGNAL)).resolves.toEqual(
      EANS.map((ean) => ({ ean })),
    );
    await expect(targets.getBenchmarkPriceTargets(SIGNAL)).resolves.toEqual(
      EANS.map((ean) => ({ ean })),
    );
    await expect(targets.getHistoricalObservationTargets(SIGNAL)).resolves.toEqual(
      EANS.map((ean) => ({ ean })),
    );
    expect(reader.getCatalogGtins).toHaveBeenCalledWith(2, SIGNAL);
    expect(reader.getPriceGtins).toHaveBeenNthCalledWith(1, 2, "ordinary_only", SIGNAL);
    expect(reader.getPriceGtins).toHaveBeenNthCalledWith(2, 2, "historical_eligible", SIGNAL);
  });

  it("binds the runtime lease to the source and maps fenced schedule state", async () => {
    const leaseHandle = {
      fenceToken: "fence-1",
      release: vi.fn(async () => undefined),
      signal: SIGNAL,
    };
    const leaseAdapter = { acquire: vi.fn(async () => leaseHandle) };
    const leaseProvider = new PostgresWorkerLeaseProvider(leaseAdapter, {
      ownerId: "worker-a",
      sourceId: "kassalapp",
      ttlMs: 120_000,
    });
    await expect(leaseProvider.acquire(SIGNAL)).resolves.toBe(leaseHandle);
    expect(leaseAdapter.acquire).toHaveBeenCalledWith({
      leaseKey: expect.stringMatching(/^worker:v1:[0-9a-f]{64}$/),
      ownerId: "worker-a",
      signal: SIGNAL,
      ttlMs: 120_000,
    });

    const repository = {
      getLastScheduledAt: vi.fn(async () => "2026-07-16T12:00:00.000Z"),
      record: vi.fn(async () => ({ created: true })),
    };
    const state = new PostgresWorkerRuntimeStateStore(repository);
    const schedule = KASSALAPP_PRODUCTION_SCHEDULES[0]!;
    await expect(state.getLastScheduledAt(schedule, SIGNAL)).resolves.toBe(
      "2026-07-16T12:00:00.000Z",
    );
    const request = {
      contractVersion: 1,
      jobId: "kassalapp:catalog-refresh:2026-07-16T12:00:00.000Z",
      kind: "catalog-refresh",
      requestedAt: "2026-07-16T12:00:00.000Z",
      sourceId: "kassalapp",
      timeoutMs: 60_000,
    } as const;
    const result = {
      contractVersion: 1,
      runId: "run-1",
      jobId: request.jobId,
      kind: request.kind,
      sourceId: request.sourceId,
      status: "failed",
      startedAt: "2026-07-16T12:00:01.000Z",
      completedAt: "2026-07-16T12:00:02.000Z",
      counters: { accepted: 0, failed: 1, fetched: 0, persisted: 0, quarantined: 0, unknown: 0 },
    } satisfies WorkerRunResult;
    await state.recordResult(request, result, { fenceToken: "fence-1", signal: SIGNAL });
    expect(repository.record).toHaveBeenCalledWith(expect.objectContaining({
      jobId: request.jobId,
      jobKind: request.kind,
      scheduledAt: new Date(request.requestedAt),
      status: "failed",
    }), "fence-1", SIGNAL);
  });

  it("does not call the gateway or create ingestion evidence under default policy", async () => {
    const gateway = {
      getSourceCatalogProducts: vi.fn(),
      getSourceBulkPrices: vi.fn(),
      getSourceCategories: vi.fn(),
      getSourceHistoricalPrices: vi.fn(),
      getSourceLabels: vi.fn(),
      getSourcePhysicalStores: vi.fn(),
      getSourceProductByEan: vi.fn(),
      getSourceProductById: vi.fn(),
    };
    const ingestionRepository = {
      beginRun: vi.fn(),
      finalizeRun: vi.fn(),
      persistCatalogOutcomes: vi.fn(),
      persistPhysicalStoreOutcomes: vi.fn(),
      persistPriceOutcomes: vi.fn(),
    };
    const state = {
      getLastScheduledAt: vi.fn(async () => undefined),
      recordResult: vi.fn(async () => undefined),
    };
    const runtime = createProductionWorkerRuntime({
      clock: () => new Date("2026-07-16T12:00:00.000Z"),
      gateway,
      ingestionRepository,
      leaseProvider: {
        acquire: async () => ({
          fenceToken: "fence-1",
          release: async () => undefined,
          signal: SIGNAL,
        }),
      },
      schedules: [KASSALAPP_PRODUCTION_SCHEDULES.find(({ kind }) => kind === "catalog-refresh")!],
      shutdownGraceMs: 1_000,
      sourceAccessPolicy: new StaticKassalappSourceAccessPolicy(),
      stateStore: state,
      targetProvider: {
        getCatalogDiscoveryPage: vi.fn(),
        getBenchmarkPriceTargets: vi.fn(),
        getCatalogTargets: vi.fn(),
        getHistoricalObservationTargets: vi.fn(),
      },
    });

    await expect(runtime.runCycle()).resolves.toMatchObject({
      results: [expect.objectContaining({ status: "failed" })],
    });
    expect(gateway.getSourceProductByEan).not.toHaveBeenCalled();
    expect(ingestionRepository.beginRun).not.toHaveBeenCalled();
    expect(state.recordResult).toHaveBeenCalledOnce();
  });
});
