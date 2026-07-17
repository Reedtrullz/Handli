import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ReviewEvidenceServiceContract } from "../../../../../../lib/server/review-evidence-service";
import { ReviewServiceError } from "../../../../../../lib/server/review-service";
import { createReviewEvidenceHandler } from "./route";

const challengeToken = `review-challenge:v1.${Date.parse("2099-07-17T12:02:00.000Z").toString(36)}.${"a".repeat(22)}.${"b".repeat(64)}.${"c".repeat(64)}`;
const principal = {
  actorId: `access:${"a".repeat(64)}`,
  expiresAt: "2099-07-17T13:00:00.000Z",
  sessionId: `access-session:${"b".repeat(64)}`,
};
const bytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);

function service(
  render: ReviewEvidenceServiceContract["render"],
  acknowledge: ReviewEvidenceServiceContract["acknowledge"] = async () => {
    throw new Error("must not acknowledge");
  },
): ReviewEvidenceServiceContract {
  return { acknowledge, render };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/review/candidates/:candidateId/evidence", () => {
  it("authenticates before candidate parsing and private service resolution", async () => {
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const handler = createReviewEvidenceHandler(getService, async () => {
      throw new Error("denied");
    });
    const response = await handler(new Request(
      "https://handle.reidar.tech/api/review/candidates/arbitrary/evidence",
    ), "arbitrary");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("denies the public app when review auth configuration is absent", async () => {
    for (const name of [
      "REVIEW_ACCESS_AUDIENCE",
      "REVIEW_ACCESS_ISSUER",
      "REVIEW_ACCESS_TEAM_DOMAIN",
      "REVIEW_BASE_URL",
    ]) {
      vi.stubEnv(name, "");
    }
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const response = await createReviewEvidenceHandler(getService)(new Request(
      "https://handle.reidar.tech/api/review/candidates/review-candidate:42/evidence",
    ), "review-candidate:42");

    expect(response.status).toBe(404);
    expect(getService).not.toHaveBeenCalled();
  });

  it("streams bounded verified bytes with a non-actionable challenge and strict anti-cache headers", async () => {
    const render = vi.fn<ReviewEvidenceServiceContract["render"]>().mockResolvedValue({
      byteLength: bytes.byteLength,
      bytes,
      challengeToken,
      expiresAt: "2099-07-17T12:02:00.000Z",
      mimeType: "image/png",
      presentation: "full_capture",
      verifiedAt: "2099-07-17T12:00:00.000Z",
    });
    const response = await createReviewEvidenceHandler(
      () => service(render),
      async () => principal,
    )(new Request(
      "https://handle.reidar.tech/api/review/candidates/review-candidate:42/evidence",
    ), "review-candidate:42");

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("surrogate-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-handleplan-review-evidence-challenge")).toBe(challengeToken);
    expect(response.headers.has("x-handleplan-review-evidence-proof")).toBe(false);
    expect(response.headers.has("x-handleplan-review-evidence-rendered-at")).toBe(false);
    expect(response.headers.get("x-handleplan-review-evidence-presentation"))
      .toBe("full_capture");
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("last-modified")).toBe(false);
    expect(response.headers.has("accept-ranges")).toBe(false);
    expect(render).toHaveBeenCalledWith("review-candidate:42", principal, expect.any(AbortSignal));
  });

  it("makes a challenge obtained before body abort non-actionable", async () => {
    const acknowledge = vi.fn<ReviewEvidenceServiceContract["acknowledge"]>();
    const render = vi.fn<ReviewEvidenceServiceContract["render"]>().mockResolvedValue({
      byteLength: bytes.byteLength,
      bytes,
      challengeToken,
      expiresAt: "2099-07-17T12:02:00.000Z",
      mimeType: "image/png",
      presentation: "full_capture",
      verifiedAt: "2099-07-17T12:00:00.000Z",
    });
    const response = await createReviewEvidenceHandler(
      () => service(render, acknowledge),
      async () => principal,
    )(new Request(
      "https://handle.reidar.tech/api/review/candidates/review-candidate:42/evidence",
    ), "review-candidate:42");

    expect(response.headers.get("x-handleplan-review-evidence-challenge"))
      .toBe(challengeToken);
    expect(response.headers.has("x-handleplan-review-evidence-proof")).toBe(false);
    await response.body?.cancel();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("rejects range, conditional, query, and cross-candidate evidence requests before reads", async () => {
    const render = vi.fn<ReviewEvidenceServiceContract["render"]>();
    const handler = createReviewEvidenceHandler(() => service(render), async () => principal);
    for (const request of [
      new Request("https://handle.reidar.tech/api/review/candidates/review-candidate:42/evidence", { headers: { range: "bytes=0-1" } }),
      new Request("https://handle.reidar.tech/api/review/candidates/review-candidate:42/evidence", { headers: { "if-none-match": "forged" } }),
      new Request("https://handle.reidar.tech/api/review/candidates/review-candidate:42/evidence?download=true"),
    ]) {
      const response = await handler(request, "review-candidate:42");
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(render).not.toHaveBeenCalled();

    const missing = await createReviewEvidenceHandler(() => service(async () => {
      throw new ReviewServiceError("NOT_FOUND");
    }), async () => principal)(new Request(
      "https://handle.reidar.tech/api/review/candidates/review-candidate:43/evidence",
    ), "review-candidate:43");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ code: "NOT_FOUND" });
  });
});
