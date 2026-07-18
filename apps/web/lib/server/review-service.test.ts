import type {
  ReviewDecisionRequestV1,
  ReviewQueueCandidateV1,
} from "@handleplan/domain";
import type { ReviewQueueRepository } from "@handleplan/db/review-queue";
import {
  ReviewQueueRepositoryError,
} from "@handleplan/db/review-queue";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ReviewService, ReviewServiceError } from "./review-service";
import { ReviewEvidenceProofCodec } from "./review-evidence-proof";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const principal = {
  actorId: `access:${"d".repeat(64)}`,
  expiresAt: "2026-07-17T13:00:00.000Z",
  sessionId: `access-session:${"e".repeat(64)}`,
};

const entry: ReviewQueueCandidateV1 = {
  approvalEvidence: {
    cropGeometry: "unavailable",
    presentation: "full_capture",
    state: "render_required",
  },
  anomalyCodes: ["OCR_REVIEW_REQUIRED"],
  candidate: {
    anomalyCodes: ["OCR_REVIEW_REQUIRED"],
    channels: ["in-store"],
    contractVersion: 1,
    eligibility: { kind: "public" },
    package: { amount: 1_000, state: "parsed", unit: "ml", unitsPerPack: 1 },
    pricing: { beforePriceOre: 3_990, kind: "unit", offerPriceOre: 2_990 },
    product: { kind: "exact-identifier", scheme: "gtin", value: "7038010000010" },
    provenance: {
      confidence: 92,
      evidenceLocator: `review-evidence:${"c".repeat(64)}`,
      method: "ocr",
    },
    validity: {
      endsAt: "2026-07-20T00:00:00.000Z",
      startsAt: "2026-07-13T00:00:00.000Z",
      state: "parsed",
    },
  },
  candidateId: "review-candidate:42",
  capture: {
    cropReference: `review-crop:${"a".repeat(64)}`,
    mimeType: "image/png",
    retrievedAt: "2026-07-12T12:00:30.000Z",
    rightsClassification: "private_review",
  },
  chain: "extra",
  confidence: 92,
  createdAt: "2026-07-12T12:01:01.000Z",
  extractionMethod: "ocr",
  extractionDisposition: "review-required",
  publication: {
    title: "Synthetic local edition",
    validFrom: "2026-07-13T00:00:00.000Z",
    validUntil: "2026-07-20T00:00:00.000Z",
  },
  scope: { id: "review-scope:9", kind: "postal_set", label: "Synthetic local" },
  sourceId: "synthetic-rights-cleared-feed",
  version: 0,
};

function repository(overrides: Partial<ReviewQueueRepository> = {}): ReviewQueueRepository {
  return {
    decide: async (request) => ({
      actedAt: "2026-07-17T12:00:00.000Z",
      actionId: "review-action:1",
      candidateId: request.candidateId,
      contractVersion: 1,
      newVersion: 1,
      state: "rejected",
    }),
    get: async () => entry,
    getPrivateCaptureLocator: async () => ({
      blobKey: `official-offers/private/v1/${"a".repeat(64)}/42/${"b".repeat(64)}`,
      byteLength: 10,
      candidateId: entry.candidateId,
      candidateVersion: entry.version,
      checksumSha256: "b".repeat(64),
      cropReference: entry.capture.cropReference,
      evidenceLocator: "crop-1",
      mimeType: "image/png",
      rightsClassification: "private_review",
    }),
    list: async () => ({ contractVersion: 1, items: [entry] }),
    recordEvidenceRender: async (input) => ({
      evidenceRenderId: "review-evidence-render:1",
      expiresAt: input.expiresAt,
      renderedAt: NOW.toISOString(),
    }),
    ...overrides,
  };
}

const rejected: ReviewDecisionRequestV1 = {
  action: "reject",
  candidateId: "review-candidate:42",
  contractVersion: 1,
  expectedVersion: 0,
  reason: "Synthetic rejection.",
};

const approval: ReviewDecisionRequestV1 = {
  action: "approve",
  approvalEvidence: {
    presentation: "full_capture",
    token: `review-proof:v1.${Date.parse("2026-07-17T12:02:00.000Z").toString(36)}.${"a".repeat(22)}.${"b".repeat(64)}.${"c".repeat(64)}`,
  },
  candidateId: "review-candidate:42",
  contractVersion: 1,
  decision: {
    channels: ["in-store"],
    eligibility: { kind: "public" },
    pricing: { beforePriceOre: 3_990, kind: "unit", offerPriceOre: 2_990 },
    target: { gtin: "7038010000010", kind: "exact-product" },
    validity: {
      endsAt: "2026-07-20T00:00:00.000Z",
      startsAt: "2026-07-13T00:00:00.000Z",
    },
  },
  expectedVersion: 0,
  reason: "Synthetic approval.",
};

describe("ReviewService", () => {
  it("captures one review clock and validates repository output", async () => {
    const list = vi.fn<ReviewQueueRepository["list"]>().mockResolvedValue({
      contractVersion: 1,
      items: [entry],
    });
    const now = vi.fn(() => new Date("2026-07-17T12:00:00.000Z"));
    const service = new ReviewService(repository({ list }), now);

    await expect(service.list({ contractVersion: 1, limit: 25 })).resolves.toEqual({
      contractVersion: 1,
      items: [entry],
    });
    expect(now).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(
      { contractVersion: 1, limit: 25 },
      new Date("2026-07-17T12:00:00.000Z"),
      undefined,
    );
  });

  it("passes the pseudonymous actor to an append-only decision", async () => {
    const decide = vi.fn<ReviewQueueRepository["decide"]>().mockResolvedValue({
      actedAt: "2026-07-17T12:00:00.000Z",
      actionId: "review-action:1",
      candidateId: rejected.candidateId,
      contractVersion: 1,
      newVersion: 1,
      state: "rejected",
    });
    const service = new ReviewService(
      repository({ decide }),
      () => new Date("2026-07-17T12:00:00.000Z"),
    );
    await service.decide(rejected, principal);
    expect(decide).toHaveBeenCalledWith(
      rejected,
      { actorId: principal.actorId, sessionId: principal.sessionId },
      undefined,
      new Date("2026-07-17T12:00:00.000Z"),
      undefined,
    );
  });

  it("blocks approval before repository access while no evidence renderer exists", async () => {
    const decide = vi.fn<ReviewQueueRepository["decide"]>();
    const service = new ReviewService(repository({ decide }));

    await expect(service.decide(approval, principal))
      .rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));
    expect(decide).not.toHaveBeenCalled();
  });

  it("allows approval only with a current proof bound to the locator and reviewer session", async () => {
    const codec = new ReviewEvidenceProofCodec(
      Buffer.alloc(32, 0x42).toString("base64url"),
      () => NOW,
    );
    const capture = await repository().getPrivateCaptureLocator(entry.candidateId, NOW);
    if (capture.rightsClassification === "extract_only") throw new Error("invalid fixture");
    const proof = codec.issue({
      candidateId: capture.candidateId,
      candidateVersion: capture.candidateVersion,
      checksumSha256: capture.checksumSha256,
      cropReference: capture.cropReference,
      presentation: "full_capture",
      rightsClassification: capture.rightsClassification,
    }, principal);
    const request = {
      ...approval,
      approvalEvidence: { presentation: "full_capture" as const, token: proof.token },
    };
    const decide = vi.fn<ReviewQueueRepository["decide"]>().mockResolvedValue({
      actedAt: NOW.toISOString(),
      actionId: "review-action:1",
      candidateId: entry.candidateId,
      contractVersion: 1,
      newVersion: 1,
      offerId: "review-offer:1",
      state: "approved",
    });
    const service = new ReviewService(repository({ decide }), () => NOW, codec);

    await expect(service.decide(request, principal)).resolves.toMatchObject({ state: "approved" });
    expect(decide).toHaveBeenCalledWith(
      request,
      { actorId: principal.actorId, sessionId: principal.sessionId },
      proof.proofSha256,
      NOW,
      undefined,
    );
    await expect(service.decide(request, {
      ...principal,
      sessionId: `access-session:${"f".repeat(64)}`,
    })).rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));
  });

  it("maps repository concurrency and not-found failures without leaking details", async () => {
    const conflict = new ReviewService(repository({
      decide: async () => { throw new ReviewQueueRepositoryError("VERSION_CONFLICT"); },
    }));
    await expect(conflict.decide(rejected, principal))
      .rejects.toEqual(new ReviewServiceError("VERSION_CONFLICT"));

    const missing = new ReviewService(repository({
      get: async () => { throw new ReviewQueueRepositoryError("NOT_FOUND"); },
    }));
    await expect(missing.get("review-candidate:42"))
      .rejects.toEqual(new ReviewServiceError("NOT_FOUND"));
  });

  it("fails closed on malformed repository output or clocks", async () => {
    const malformed = new ReviewService(repository({
      list: async () => ({ contractVersion: 1, items: [], total: 99 } as never),
    }));
    await expect(malformed.list({ contractVersion: 1, limit: 25 })).rejects.toThrow();

    const badClock = new ReviewService(repository(), () => new Date(Number.NaN));
    await expect(badClock.get("review-candidate:42"))
      .rejects.toEqual(new ReviewServiceError("UNAVAILABLE"));
  });
});
