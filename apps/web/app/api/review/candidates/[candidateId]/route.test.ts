import type { ReviewServiceContract } from "../../../../../lib/server/review-service";
import { ReviewServiceError } from "../../../../../lib/server/review-service";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createReviewCandidateHandler } from "./route";

function service(get: ReviewServiceContract["get"]): ReviewServiceContract {
  return {
    decide: async () => { throw new Error("unused"); },
    get,
    getPrivateCaptureLocator: async () => { throw new Error("unused"); },
    list: async () => ({ contractVersion: 1, items: [] }),
  };
}

describe("GET /api/review/candidates/:candidateId", () => {
  it("makes absent assertion, invalid assertion, and arbitrary IDs indistinguishable", async () => {
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const denied = createReviewCandidateHandler(getService, async () => {
      throw new Error("denied");
    });
    const responses = await Promise.all([
      denied(new Request("https://handle.reidar.tech/api/review/candidates/review-candidate:1"), "review-candidate:1"),
      denied(new Request("https://handle.reidar.tech/api/review/candidates/arbitrary"), "arbitrary"),
    ]);
    expect(await Promise.all(responses.map(async (response) => ({
      body: await response.text(),
      cache: response.headers.get("cache-control"),
      status: response.status,
    })))).toEqual([
      { body: '{"code":"NOT_FOUND"}', cache: "private, no-store", status: 404 },
      { body: '{"code":"NOT_FOUND"}', cache: "private, no-store", status: 404 },
    ]);
    expect(getService).not.toHaveBeenCalled();
  });

  it("uses the same sanitized 404 for an authorized missing candidate", async () => {
    const response = await createReviewCandidateHandler(() => service(async () => {
      throw new ReviewServiceError("NOT_FOUND");
    }), async () => ({
      actorId: `access:${"a".repeat(64)}`,
      expiresAt: "2026-07-17T13:00:00.000Z",
      sessionId: `access-session:${"b".repeat(64)}`,
    }))(new Request(
      "https://handle.reidar.tech/api/review/candidates/review-candidate:999",
    ), "review-candidate:999");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
  });
});
