import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ReviewEvidenceServiceContract } from "../../../../../../../lib/server/review-evidence-service";
import { ReviewServiceError } from "../../../../../../../lib/server/review-service";
import { createReviewEvidenceAckHandler } from "./route";

const candidateId = "review-candidate:42";
const challenge = `review-challenge:v1.${Date.parse("2099-07-17T12:02:00.000Z").toString(36)}.${"a".repeat(22)}.${"b".repeat(64)}.${"c".repeat(64)}`;
const proofToken = `review-proof:v1.${Date.parse("2099-07-17T12:02:00.000Z").toString(36)}.${"d".repeat(22)}.${"e".repeat(64)}.${"f".repeat(64)}`;
const principal = {
  actorId: `access:${"a".repeat(64)}`,
  expiresAt: "2099-07-17T13:00:00.000Z",
  sessionId: `access-session:${"b".repeat(64)}`,
};
const body = {
  candidateId,
  challenge,
  contractVersion: 1 as const,
  digestSha256: "c".repeat(64),
  presentation: "full_capture" as const,
};

function request(value: unknown = body, suffix = ""): Request {
  return new Request(
    `https://review.handle.reidar.tech/api/review/candidates/${candidateId}/evidence/ack${suffix}`,
    {
      body: JSON.stringify(value),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}

function service(
  acknowledge: ReviewEvidenceServiceContract["acknowledge"],
): ReviewEvidenceServiceContract {
  return {
    acknowledge,
    render: async () => { throw new Error("must not render"); },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/review/candidates/:candidateId/evidence/ack", () => {
  it("authenticates before candidate parsing, body parsing, and service resolution", async () => {
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const handler = createReviewEvidenceAckHandler(getService, async () => {
      throw new Error("denied");
    });
    const response = await handler(request(), "arbitrary");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("denies the public app when review Access configuration is absent", async () => {
    for (const name of [
      "REVIEW_ACCESS_AUDIENCE",
      "REVIEW_ACCESS_ISSUER",
      "REVIEW_ACCESS_TEAM_DOMAIN",
      "REVIEW_BASE_URL",
    ]) {
      vi.stubEnv(name, "");
    }
    const getService = vi.fn(() => service(async () => { throw new Error("must not run"); }));
    const response = await createReviewEvidenceAckHandler(getService)(request(), candidateId);

    expect(response.status).toBe(404);
    expect(getService).not.toHaveBeenCalled();
  });

  it("returns only a bounded private no-store approval proof after acknowledgement", async () => {
    const acknowledge = vi.fn<ReviewEvidenceServiceContract["acknowledge"]>()
      .mockResolvedValue({
        candidateId,
        contractVersion: 1,
        expiresAt: "2099-07-17T12:02:00.000Z",
        presentation: "full_capture",
        proofToken,
        renderedAt: "2099-07-17T12:00:30.000Z",
      });
    const response = await createReviewEvidenceAckHandler(
      () => service(acknowledge),
      async () => principal,
    )(request(), candidateId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("surrogate-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      candidateId,
      contractVersion: 1,
      expiresAt: "2099-07-17T12:02:00.000Z",
      presentation: "full_capture",
      proofToken,
      renderedAt: "2099-07-17T12:00:30.000Z",
    });
    expect(acknowledge).toHaveBeenCalledWith(body, principal, expect.any(AbortSignal));
  });

  it("rejects mismatched IDs, queries, proof-as-challenge, malformed digests, and extra fields", async () => {
    const acknowledge = vi.fn<ReviewEvidenceServiceContract["acknowledge"]>();
    const handler = createReviewEvidenceAckHandler(
      () => service(acknowledge),
      async () => principal,
    );
    const invalid: Array<[Request, string]> = [
      [request({ ...body, candidateId: "review-candidate:43" }), candidateId],
      [request(body, "?retry=true"), candidateId],
      [request({ ...body, challenge: proofToken }), candidateId],
      [request({ ...body, digestSha256: "C".repeat(64) }), candidateId],
      [request({ ...body, checksumSha256: body.digestSha256 }), candidateId],
    ];

    for (const [input, pathCandidateId] of invalid) {
      const response = await handler(input, pathCandidateId);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("sanitizes fail-closed evidence acknowledgement errors", async () => {
    const response = await createReviewEvidenceAckHandler(
      () => service(async () => { throw new ReviewServiceError("EVIDENCE_UNAVAILABLE"); }),
      async () => principal,
    )(request(), candidateId);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "EVIDENCE_UNAVAILABLE" });
  });
});
