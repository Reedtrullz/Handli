import { readFile } from "node:fs/promises";

import { OFFICIAL_OFFER_FOUNDATION_ACTIVATION } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import {
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
  publicationState: "foundation-disabled",
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
    expect(OFFICIAL_OFFER_FOUNDATION_ACTIVATION.enabled).toBe(false);
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
