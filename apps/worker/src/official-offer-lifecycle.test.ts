import { readFile } from "node:fs/promises";

import { OFFICIAL_OFFER_FOUNDATION_ACTIVATION } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createOfficialOfferLifecycleScheduler,
  MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH,
  OfficialOfferLifecycleJobExecutor,
  type OfficialOfferLifecycleReceiptV1,
  type OfficialOfferLifecycleRepositoryPort,
} from "./official-offer-lifecycle";

const SCHEDULED_AT = new Date("2026-07-17T08:00:00.000Z");
const RECEIPT: OfficialOfferLifecycleReceiptV1 = Object.freeze({
  contractVersion: 1,
  databaseAsOf: new Date("2026-07-17T08:00:00.250Z"),
  expiredCount: 2,
  expiryExamined: 3,
  jobId: "synthetic-source:official-offer-lifecycle-reconcile:2026-07-17T08:00:00.000Z",
  leaseExpiresAt: new Date("2026-07-17T08:00:10.250Z"),
  outcome: "completed",
  publicationExamined: 0,
  publicationState: "evaluated",
  publishedCount: 0,
  replayed: false,
  revokedCount: 1,
  skippedCount: 0,
  sourceId: "synthetic-source",
});

function execution() {
  return {
    contractVersion: 1 as const,
    jobId: RECEIPT.jobId,
    runId: "synthetic-offer-lifecycle-run",
    scheduledAt: SCHEDULED_AT,
  };
}

describe("dedicated official-offer lifecycle executor", () => {
  it("makes one atomic repository call and returns its SQL receipt unchanged", async () => {
    const controller = new AbortController();
    const reconcile = vi.fn<OfficialOfferLifecycleRepositoryPort["reconcile"]>(
      async () => RECEIPT,
    );
    const executor = new OfficialOfferLifecycleJobExecutor({
      ownerId: "offer-lifecycle-worker-1",
      repository: { reconcile },
      sourceId: "synthetic-source",
    });

    await expect(executor.execute(execution(), controller.signal)).resolves.toBe(RECEIPT);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({
      batchLimit: 50,
      contractVersion: 1,
      jobId: RECEIPT.jobId,
      ownerId: "offer-lifecycle-worker-1",
      publicationRequested: OFFICIAL_OFFER_FOUNDATION_ACTIVATION.enabled,
      runId: "synthetic-offer-lifecycle-run",
      scheduledAt: SCHEDULED_AT,
      sourceId: "synthetic-source",
    }, controller.signal);
    expect(OFFICIAL_OFFER_FOUNDATION_ACTIVATION.enabled).toBe(true);
  });

  it("enforces the database batch ceiling before making a repository call", () => {
    const repository: OfficialOfferLifecycleRepositoryPort = {
      reconcile: vi.fn(async () => RECEIPT),
    };
    expect(MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH).toBe(50);
    expect(() => new OfficialOfferLifecycleJobExecutor({
      batchLimit: 51,
      ownerId: "offer-lifecycle-worker-1",
      repository,
      sourceId: "synthetic-source",
    })).toThrow(new TypeError("batchLimit must be an integer from 1 through 50"));
    expect(repository.reconcile).not.toHaveBeenCalled();
  });

  it("rejects malformed execution identities locally and never opens a second boundary", () => {
    const reconcile = vi.fn<OfficialOfferLifecycleRepositoryPort["reconcile"]>(
      async () => RECEIPT,
    );
    const executor = new OfficialOfferLifecycleJobExecutor({
      batchLimit: 1,
      ownerId: "offer-lifecycle-worker-1",
      repository: { reconcile },
      sourceId: "synthetic-source",
    });
    expect(() => executor.execute({
      ...execution(),
      runId: " bad-run-id",
    })).toThrow(TypeError);
    expect(() => executor.execute({
      ...execution(),
      scheduledAt: new Date(Number.NaN),
    })).toThrow(TypeError);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("has no generic runtime, lease, state-store, or split mutation dependency", async () => {
    const source = await readFile(new URL("./official-offer-lifecycle.ts", import.meta.url), "utf8");
    expect(source).not.toContain('from "./runtime"');
    expect(source).not.toContain('from "./runner"');
    expect(source).not.toContain("worker_leases");
    expect(source).not.toContain("stateStore");
    expect(source).not.toContain("publicationGate");
    expect(source).not.toContain("publishReviewedOffers");
    expect(source).not.toContain("expireEndedOffers");
  });
});

describe("official-offer lifecycle schedule", () => {
  it("retries failed and busy slots with fresh attempts, preserving SQL receipts and replay completion", async () => {
    const busy = { ...RECEIPT, outcome: "lease-unavailable" as const };
    const replay = { ...RECEIPT, outcome: "replayed" as const, replayed: true };
    const reconcile = vi.fn<OfficialOfferLifecycleRepositoryPort["reconcile"]>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(replay)
      .mockResolvedValue(RECEIPT);
    const run = createOfficialOfferLifecycleScheduler({
      sourceId: "synthetic-source", ownerId: "worker", repository: { reconcile },
    });
    const now = new Date("2026-07-17T08:04:00Z");
    await expect(run(now)).rejects.toThrow("database unavailable");
    await expect(run(now)).resolves.toBe(busy);
    await expect(run(now)).resolves.toBe(replay);
    await expect(run(new Date("2026-07-17T08:14:59Z"))).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(3);
    const requests = reconcile.mock.calls.map(([request]) => request);
    expect(new Set(requests.map((request) => request.runId)).size).toBe(3);
    expect(requests.every((request) => request.jobId === RECEIPT.jobId)).toBe(true);
    expect(requests.every((request) => request.scheduledAt.getTime() === SCHEDULED_AT.getTime())).toBe(true);
    await expect(run(new Date("2026-07-17T08:15:00Z"))).resolves.toBe(RECEIPT);
    expect(reconcile.mock.calls[3]?.[0].jobId).toContain("08:15:00.000Z");
  });

  it("bounds hung attempts to 30 seconds and propagates shutdown without consuming the slot", async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi.fn<OfficialOfferLifecycleRepositoryPort["reconcile"]>()
        .mockImplementation(() => new Promise(() => {}));
      const run = createOfficialOfferLifecycleScheduler({
        sourceId: "synthetic-source", ownerId: "worker", repository: { reconcile },
      });
      const timedOut = expect(run(SCHEDULED_AT)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await timedOut;
      expect(reconcile.mock.calls[0]?.[1]?.aborted).toBe(true);
      const controller = new AbortController();
      const stopped = expect(run(SCHEDULED_AT, controller.signal)).rejects.toThrow("shutdown");
      controller.abort(new Error("shutdown"));
      await stopped;
      expect(reconcile.mock.calls[1]?.[1]?.aborted).toBe(true);
      await expect(run(SCHEDULED_AT, controller.signal)).rejects.toThrow("shutdown");
      expect(reconcile).toHaveBeenCalledTimes(2);
      reconcile.mockResolvedValue(RECEIPT);
      await expect(run(SCHEDULED_AT)).resolves.toBe(RECEIPT);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
