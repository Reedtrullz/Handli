import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type {
  PrivateReviewCaptureLocator,
  ReviewQueueRepository,
} from "@handleplan/db/review-queue";

import type { ReviewPrincipal } from "./review-access";
import {
  PrivateReviewEvidenceReaderError,
  type PrivateReviewEvidenceReader,
} from "./review-evidence-reader";
import {
  ReviewEvidenceChallengeCodec,
  ReviewEvidenceProofCodec,
} from "./review-evidence-proof";
import { ReviewEvidenceService } from "./review-evidence-service";
import { ReviewServiceError } from "./review-service";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const SECRET = Buffer.alloc(32, 0x4a).toString("base64url");
const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const principal: ReviewPrincipal = {
  actorId: `access:${"a".repeat(64)}`,
  expiresAt: "2026-07-17T13:00:00.000Z",
  sessionId: `access-session:${"b".repeat(64)}`,
};
const locator: PrivateReviewCaptureLocator = {
  blobKey: `official-offers/private/v1/${"d".repeat(64)}/42/${"c".repeat(64)}`,
  byteLength: bytes.byteLength,
  candidateId: "review-candidate:42",
  candidateVersion: 0,
  checksumSha256: "c".repeat(64),
  cropReference: `review-crop:${"e".repeat(64)}`,
  evidenceLocator: "synthetic-full-capture",
  mimeType: "image/png",
  rightsClassification: "private_review",
};

function repository(overrides: Partial<ReviewQueueRepository> = {}): ReviewQueueRepository {
  return {
    decide: async () => { throw new Error("unused"); },
    get: async () => { throw new Error("unused"); },
    getPrivateCaptureLocator: async () => locator,
    list: async () => ({ contractVersion: 1, items: [] }),
    recordEvidenceRender: async (input) => ({
      evidenceRenderId: "review-evidence-render:1",
      expiresAt: input.expiresAt,
      renderedAt: NOW.toISOString(),
    }),
    ...overrides,
  };
}

function reader(overrides: Partial<PrivateReviewEvidenceReader> = {}): PrivateReviewEvidenceReader {
  return {
    read: async () => ({
      byteLength: bytes.byteLength,
      bytes,
      checksumSha256: locator.checksumSha256,
      mimeType: "image/png",
    }),
    ...overrides,
  };
}

function bindingFor(value: PrivateReviewCaptureLocator = locator) {
  return {
    candidateId: value.candidateId,
    candidateVersion: value.candidateVersion,
    checksumSha256: value.checksumSha256,
    cropReference: value.cropReference,
    presentation: "full_capture",
    rightsClassification: value.rightsClassification === "extract_only"
      ? "private_review"
      : value.rightsClassification,
  } as const;
}

function ackRequest(challenge: string, digestSha256 = locator.checksumSha256) {
  return {
    candidateId: locator.candidateId,
    challenge,
    contractVersion: 1 as const,
    digestSha256,
    presentation: "full_capture" as const,
  };
}

describe("ReviewEvidenceService", () => {
  it("returns verified bytes with a non-actionable challenge and records nothing on GET", async () => {
    const read = vi.fn<PrivateReviewEvidenceReader["read"]>().mockResolvedValue({
      byteLength: bytes.byteLength,
      bytes,
      checksumSha256: locator.checksumSha256,
      mimeType: "image/png",
    });
    const recordEvidenceRender = vi.fn<ReviewQueueRepository["recordEvidenceRender"]>()
      .mockImplementation(async (input) => ({
        evidenceRenderId: "review-evidence-render:7",
        expiresAt: input.expiresAt,
        renderedAt: NOW.toISOString(),
      }));
    const service = new ReviewEvidenceService(
      repository({ recordEvidenceRender }),
      reader({ read }),
      new ReviewEvidenceChallengeCodec(SECRET, () => NOW),
      new ReviewEvidenceProofCodec(SECRET, () => NOW),
      () => NOW,
    );

    const result = await service.render(locator.candidateId, principal);

    expect(result).toEqual({
      byteLength: bytes.byteLength,
      bytes,
      challengeToken: expect.stringMatching(/^review-challenge:v1\./u),
      expiresAt: "2026-07-17T12:02:00.000Z",
      mimeType: "image/png",
      presentation: "full_capture",
      verifiedAt: NOW.toISOString(),
    });
    expect(read).toHaveBeenCalledWith(locator, expect.any(AbortSignal));
    expect(recordEvidenceRender).not.toHaveBeenCalled();
  });

  it("rejects PDF rendering before reading or returning private bytes", async () => {
    const pdfLocator = { ...locator, mimeType: "application/pdf" as const };
    const read = vi.fn<PrivateReviewEvidenceReader["read"]>();
    const service = new ReviewEvidenceService(
      repository({ getPrivateCaptureLocator: async () => pdfLocator }),
      reader({ read }),
      new ReviewEvidenceChallengeCodec(SECRET, () => NOW),
      new ReviewEvidenceProofCodec(SECRET, () => NOW),
      () => NOW,
    );

    await expect(service.render(pdfLocator.candidateId, principal))
      .rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));
    expect(read).not.toHaveBeenCalled();
  });

  it("issues and records an approval proof only after a current image challenge and full digest acknowledgement", async () => {
    const recordEvidenceRender = vi.fn<ReviewQueueRepository["recordEvidenceRender"]>()
      .mockImplementation(async (input) => ({
        evidenceRenderId: "review-evidence-render:7",
        expiresAt: input.expiresAt,
        renderedAt: NOW.toISOString(),
      }));
    const challengeCodec = new ReviewEvidenceChallengeCodec(SECRET, () => NOW);
    const service = new ReviewEvidenceService(
      repository({ recordEvidenceRender }),
      reader(),
      challengeCodec,
      new ReviewEvidenceProofCodec(SECRET, () => NOW),
      () => NOW,
    );
    const challenge = challengeCodec.issue(bindingFor(), principal);

    const result = await service.acknowledge(ackRequest(challenge.token), principal);

    expect(result).toEqual({
      candidateId: locator.candidateId,
      contractVersion: 1,
      expiresAt: "2026-07-17T12:02:00.000Z",
      presentation: "full_capture",
      proofToken: expect.stringMatching(/^review-proof:v1\./u),
      renderedAt: NOW.toISOString(),
    });
    expect(result.proofToken).not.toBe(challenge.token);
    expect(recordEvidenceRender).toHaveBeenCalledWith(expect.objectContaining({
      actorId: principal.actorId,
      candidateId: locator.candidateId,
      checksumSha256: locator.checksumSha256,
      cropReference: locator.cropReference,
      evidenceProofSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      expectedVersion: 0,
      expiresAt: result.expiresAt,
      presentation: "full_capture",
      rightsClassification: "private_review",
      sessionId: principal.sessionId,
    }), NOW, undefined);
  });

  it("fails closed on cross-candidate, extract-only, corrupt bytes, and receipt drift", async () => {
    const challengeCodec = new ReviewEvidenceChallengeCodec(SECRET, () => NOW);
    const codec = new ReviewEvidenceProofCodec(SECRET, () => NOW);
    await expect(new ReviewEvidenceService(
      repository({ getPrivateCaptureLocator: async () => ({ ...locator, candidateId: "review-candidate:43" }) }),
      reader(), challengeCodec, codec, () => NOW,
    ).render(locator.candidateId, principal)).rejects.toEqual(new ReviewServiceError("CORRUPT_RECORD"));

    await expect(new ReviewEvidenceService(
      repository({ getPrivateCaptureLocator: async () => ({ ...locator, rightsClassification: "extract_only" }) }),
      reader(), challengeCodec, codec, () => NOW,
    ).render(locator.candidateId, principal)).rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));

    await expect(new ReviewEvidenceService(
      repository(),
      reader({ read: async () => { throw new PrivateReviewEvidenceReaderError("EVIDENCE_CORRUPT"); } }),
      challengeCodec, codec, () => NOW,
    ).render(locator.candidateId, principal)).rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));

    const challenge = challengeCodec.issue(bindingFor(), principal);
    await expect(new ReviewEvidenceService(
      repository({
        recordEvidenceRender: async () => ({
          evidenceRenderId: "review-evidence-render:1",
          expiresAt: "2026-07-17T12:01:00.000Z",
          renderedAt: NOW.toISOString(),
        }),
      }),
      reader(), challengeCodec, codec, () => NOW,
    ).acknowledge(ackRequest(challenge.token), principal))
      .rejects.toEqual(new ReviewServiceError("CORRUPT_RECORD"));
  });

  it("rejects forged, stale, cross-candidate, and cross-session challenges before a receipt", async () => {
    const recordEvidenceRender = vi.fn<ReviewQueueRepository["recordEvidenceRender"]>();
    const issued = new ReviewEvidenceChallengeCodec(SECRET, () => NOW).issue(
      bindingFor(),
      principal,
    );
    const tail = issued.token.at(-1) === "0" ? "1" : "0";
    const cases = [
      {
        challenge: `${issued.token.slice(0, -1)}${tail}`,
        codecNow: NOW,
        subject: principal,
      },
      {
        challenge: issued.token,
        codecNow: new Date(Date.parse(issued.expiresAt)),
        subject: principal,
      },
      {
        challenge: new ReviewEvidenceChallengeCodec(SECRET, () => NOW).issue({
          ...bindingFor(),
          candidateId: "review-candidate:43",
        }, principal).token,
        codecNow: NOW,
        subject: principal,
      },
      {
        challenge: issued.token,
        codecNow: NOW,
        subject: {
          ...principal,
          sessionId: `access-session:${"f".repeat(64)}`,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const service = new ReviewEvidenceService(
        repository({ recordEvidenceRender }),
        reader(),
        new ReviewEvidenceChallengeCodec(SECRET, () => testCase.codecNow),
        new ReviewEvidenceProofCodec(SECRET, () => testCase.codecNow),
        () => testCase.codecNow,
      );
      await expect(service.acknowledge(
        ackRequest(testCase.challenge),
        testCase.subject,
      )).rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));
    }
    expect(recordEvidenceRender).not.toHaveBeenCalled();
  });

  it("rejects a wrong client digest and keeps PDF approval fail-closed", async () => {
    const recordEvidenceRender = vi.fn<ReviewQueueRepository["recordEvidenceRender"]>();
    const challengeCodec = new ReviewEvidenceChallengeCodec(SECRET, () => NOW);
    const service = new ReviewEvidenceService(
      repository({ recordEvidenceRender }),
      reader(),
      challengeCodec,
      new ReviewEvidenceProofCodec(SECRET, () => NOW),
      () => NOW,
    );
    const imageChallenge = challengeCodec.issue(bindingFor(), principal);
    await expect(service.acknowledge(
      ackRequest(imageChallenge.token, "f".repeat(64)),
      principal,
    )).rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));

    const pdfLocator = { ...locator, mimeType: "application/pdf" as const };
    const pdfChallenge = challengeCodec.issue(bindingFor(pdfLocator), principal);
    const pdfService = new ReviewEvidenceService(
      repository({
        getPrivateCaptureLocator: async () => pdfLocator,
        recordEvidenceRender,
      }),
      reader(),
      challengeCodec,
      new ReviewEvidenceProofCodec(SECRET, () => NOW),
      () => NOW,
    );
    await expect(pdfService.acknowledge(
      ackRequest(pdfChallenge.token),
      principal,
    )).rejects.toEqual(new ReviewServiceError("EVIDENCE_UNAVAILABLE"));
    expect(recordEvidenceRender).not.toHaveBeenCalled();
  });
});
