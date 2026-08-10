import type { ReviewServiceContract } from "../../../../../../lib/server/review-service";
import { ReviewServiceError } from "../../../../../../lib/server/review-service";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createReviewActionHandler } from "./route";

const actorId = `access:${"a".repeat(64)}`;
const authorize = async () => ({
  actorId,
  expiresAt: "2026-07-17T13:00:00.000Z",
  sessionId: `access-session:${"b".repeat(64)}`,
});
const rejection = {
  action: "reject",
  candidateId: "review-candidate:42",
  contractVersion: 1,
  expectedVersion: 0,
  reason: "Synthetic crop is ambiguous.",
} as const;

function service(decide: ReviewServiceContract["decide"]): ReviewServiceContract {
  return {
    decide,
    get: async () => { throw new Error("unused"); },
    getPrivateCaptureLocator: async () => { throw new Error("unused"); },
    list: async () => ({ contractVersion: 1, items: [] }),
  };
}

function request(body: unknown): Request {
  return new Request(
    "https://handle.reidar.tech/api/review/candidates/review-candidate:42/actions",
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}

describe("POST /api/review/candidates/:candidateId/actions", () => {
  it("authenticates before reading the body or resolving the review service", async () => {
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const response = await createReviewActionHandler(getService, async () => {
      throw new Error("denied");
    })(request({ secretBodySentinel: true }), "review-candidate:42");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("binds the path, pseudonymous actor, and optimistic version to the decision", async () => {
    const decide = vi.fn<ReviewServiceContract["decide"]>().mockResolvedValue({
      actedAt: "2026-07-17T12:00:00.000Z",
      actionId: "review-action:7",
      candidateId: "review-candidate:42",
      contractVersion: 1,
      newVersion: 1,
      state: "rejected",
    });
    const response = await createReviewActionHandler(() => service(decide), authorize)(
      request(rejection),
      "review-candidate:42",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      actionId: "review-action:7",
      newVersion: 1,
      state: "rejected",
    });
    expect(decide).toHaveBeenCalledWith(
      rejection,
      expect.objectContaining({ actorId, sessionId: expect.stringMatching(/^access-session:/u) }),
      expect.any(AbortSignal),
    );
  });

  it("rejects path/body confusion and overlong input before service access", async () => {
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const handler = createReviewActionHandler(getService, authorize);
    const mismatch = await handler(request({ ...rejection, candidateId: "review-candidate:43" }), "review-candidate:42");
    expect(mismatch.status).toBe(400);

    const oversized = new Request(
      "https://handle.reidar.tech/api/review/candidates/review-candidate:42/actions",
      {
        body: "{}",
        headers: {
          "content-length": String(33 * 1024),
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    const tooLarge = await handler(oversized, "review-candidate:42");
    expect(tooLarge.status).toBe(413);
    expect(getService).not.toHaveBeenCalled();
  });

  it("surfaces stale optimistic writes only as a sanitized conflict", async () => {
    const response = await createReviewActionHandler(() => service(async () => {
      throw new ReviewServiceError("VERSION_CONFLICT");
    }), authorize)(request(rejection), "review-candidate:42");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "VERSION_CONFLICT" });
  });

  it("reports unavailable approval evidence as a typed private conflict", async () => {
    const response = await createReviewActionHandler(() => service(async () => {
      throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
    }), authorize)(request(rejection), "review-candidate:42");
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ code: "EVIDENCE_UNAVAILABLE" });
  });
});
