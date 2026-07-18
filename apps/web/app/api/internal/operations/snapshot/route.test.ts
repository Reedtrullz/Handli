import { describe, expect, it, vi } from "vitest";
import type { OperationsRuntimeSnapshotV1 } from "@handleplan/domain";

vi.mock("server-only", () => ({}));

import type { OperationsRuntimeServiceContract } from "../../../../../lib/server/operations-runtime-service";
import { OperationsRuntimeServiceError } from "../../../../../lib/server/operations-runtime-service";
import {
  createOperationsSnapshotHandler,
  createOperationsUnsupportedMethodHandler,
} from "./route";

const principal = {
  actorId: `access:${"a".repeat(64)}`,
  expiresAt: "2026-07-17T13:00:00.000Z",
};
const authorize = async () => principal;
const snapshot: OperationsRuntimeSnapshotV1 = {
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
  sources: [{
    administrativeRows: {
      activePublishedOffers: { capped: false, value: 0 },
      expiredPublishedOffers: { capped: false, value: 0 },
      expiringPublishedOffers: { capped: false, value: 0 },
      pendingReviewCandidates: { capped: false, value: 0 },
    },
    governanceState: "approval-incomplete",
    health: null,
    latestExtraction: null,
    latestWorkerResults: [],
    newestOrdinaryPriceAt: null,
    sourceId: "fixture-source",
    workerResults24h: {
      nonSuccessful: { capped: false, value: 0 },
      total: { capped: false, value: 0 },
    },
  }],
};

function service(overrides: Partial<OperationsRuntimeServiceContract> = {}) {
  return {
    read: async () => snapshot,
    ...overrides,
  } as OperationsRuntimeServiceContract;
}

describe("GET /api/internal/operations/snapshot", () => {
  it("authenticates before parsing or resolving the aggregate service", async () => {
    const getService = vi.fn(() => service());
    const response = await createOperationsSnapshotHandler(getService, async () => {
      throw new Error("missing assertion");
    })(new Request(
      "https://handle.reidar.tech/api/internal/operations/snapshot?private=true",
    ));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("does not enumerate unsupported methods before authentication", async () => {
    const denied = await createOperationsUnsupportedMethodHandler(async () => {
      throw new Error("wrong audience");
    })(new Request("https://handle.reidar.tech/api/internal/operations/snapshot", {
      method: "POST",
    }));
    expect(denied.status).toBe(404);
    await expect(denied.json()).resolves.toEqual({ code: "NOT_FOUND" });

    const allowed = await createOperationsUnsupportedMethodHandler(authorize)(
      new Request("https://handle.reidar.tech/api/internal/operations/snapshot", {
        method: "POST",
      }),
    );
    expect(allowed.status).toBe(405);
    expect(allowed.headers.get("allow")).toBe("GET, HEAD");
    expect(allowed.headers.get("cache-control")).toBe("private, no-store");
    await expect(allowed.json()).resolves.toEqual({ code: "METHOD_NOT_ALLOWED" });
  });

  it("returns only the bounded aggregate contract and rejects every query parameter", async () => {
    const read = vi.fn(async () => snapshot);
    const handler = createOperationsSnapshotHandler(() => service({ read }), authorize);
    const response = await handler(new Request(
      "https://handle.reidar.tech/api/internal/operations/snapshot",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(read).toHaveBeenCalledWith(expect.any(AbortSignal));

    const rejected = await handler(new Request(
      "https://handle.reidar.tech/api/internal/operations/snapshot?source=fixture-source",
    ));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
  });

  it("sanitizes service failures and bounds the request lifetime", async () => {
    const unavailable = await createOperationsSnapshotHandler(() => service({
      read: async () => { throw new OperationsRuntimeServiceError("UNAVAILABLE"); },
    }), authorize)(new Request(
      "https://handle.reidar.tech/api/internal/operations/snapshot",
    ));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ code: "OPERATIONS_UNAVAILABLE" });

    const timeout = await createOperationsSnapshotHandler(() => service({
      read: (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("private")), { once: true });
      }),
    }), authorize, { timeoutMs: 5 })(new Request(
      "https://handle.reidar.tech/api/internal/operations/snapshot",
    ));
    expect(timeout.status).toBe(503);
    await expect(timeout.json()).resolves.toEqual({ code: "REQUEST_TIMEOUT" });
  });
});
