import type { ReviewServiceContract } from "../../../../lib/server/review-service";
import { ReviewServiceError } from "../../../../lib/server/review-service";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createReviewQueueHandler } from "./route";

const principal = {
  actorId: `access:${"a".repeat(64)}`,
  expiresAt: "2026-07-17T13:00:00.000Z",
  sessionId: `access-session:${"b".repeat(64)}`,
};
const authorize = async () => principal;

function service(overrides: Partial<ReviewServiceContract> = {}): ReviewServiceContract {
  return {
    decide: async () => { throw new Error("unused"); },
    get: async () => { throw new Error("unused"); },
    getPrivateCaptureLocator: async () => { throw new Error("unused"); },
    list: async () => ({ contractVersion: 1, items: [] }),
    ...overrides,
  };
}

describe("GET /api/review/candidates", () => {
  it("authenticates before parsing or resolving service and hides queue cardinality", async () => {
    const getService = vi.fn(() => service());
    const denied = createReviewQueueHandler(getService, async () => {
      throw new Error("invalid access assertion");
    });

    const malformedQuery = await denied(new Request(
      "https://handle.reidar.tech/api/review/candidates?includeTotal=true",
    ));
    expect(malformedQuery.status).toBe(404);
    expect(malformedQuery.headers.get("cache-control")).toBe("private, no-store");
    await expect(malformedQuery.json()).resolves.toEqual({ code: "NOT_FOUND" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("returns the strict private no-store queue without a total count", async () => {
    const list = vi.fn<ReviewServiceContract["list"]>().mockResolvedValue({
      contractVersion: 1,
      items: [],
    });
    const response = await createReviewQueueHandler(() => service({ list }), authorize)(
      new Request("https://handle.reidar.tech/api/review/candidates?chain=extra&scopeKind=postal_set&minAgeHours=2&maxAgeHours=72&minConfidence=50&maxConfidence=95&anomaly=OCR_REVIEW_REQUIRED&limit=25"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ contractVersion: 1, items: [] });
    expect(list).toHaveBeenCalledWith({
      ageHours: { min: 2, max: 72 },
      anomaly: "OCR_REVIEW_REQUIRED",
      chain: "extra",
      confidence: { min: 50, max: 95 },
      contractVersion: 1,
      limit: 25,
      scopeKind: "postal_set",
    }, expect.any(AbortSignal));
  });

  it("rejects unknown, duplicate, and out-of-range filters before service access", async () => {
    const getService = vi.fn(() => service());
    const handler = createReviewQueueHandler(getService, authorize);
    for (const query of [
      "total=true",
      "chain=extra&chain=bunnpris",
      "limit=51",
      "minConfidence=96&maxConfidence=95",
      "minAgeHours=-1",
    ]) {
      const response = await handler(new Request(
        `https://handle.reidar.tech/api/review/candidates?${query}`,
      ));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    }
    expect(getService).not.toHaveBeenCalled();
  });

  it("sanitizes repository failures and preserves private no-store headers", async () => {
    const response = await createReviewQueueHandler(() => service({
      list: async () => { throw new ReviewServiceError("CORRUPT_RECORD"); },
    }), authorize)(new Request("https://handle.reidar.tech/api/review/candidates"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ code: "REVIEW_UNAVAILABLE" });
  });
});
