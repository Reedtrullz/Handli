import "server-only";

import { timingSafeEqual } from "node:crypto";

import {
  reviewCandidateIdSchema,
  reviewEvidenceAckRequestV1Schema,
  reviewEvidenceAckResponseV1Schema,
  type ReviewEvidenceAckRequestV1,
  type ReviewEvidenceAckResponseV1,
} from "@handleplan/domain";
import {
  ReviewQueueRepositoryError,
  type ReviewQueueRepository,
} from "@handleplan/db/review-queue";

import type { ReviewPrincipal } from "./review-access";
import {
  PrivateReviewEvidenceReaderError,
  type PrivateReviewEvidenceReader,
} from "./review-evidence-reader";
import {
  ReviewEvidenceChallengeCodec,
  ReviewEvidenceProofCodec,
  ReviewEvidenceProofError,
} from "./review-evidence-proof";
import { ReviewServiceError } from "./review-service";

export interface RenderedPrivateReviewEvidence {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  readonly presentation: "full_capture";
  readonly verifiedAt: string;
}

export interface ReviewEvidenceServiceContract {
  render(
    candidateId: string,
    principal: Readonly<ReviewPrincipal>,
    signal?: AbortSignal,
  ): Promise<RenderedPrivateReviewEvidence>;
  acknowledge(
    request: Readonly<ReviewEvidenceAckRequestV1>,
    principal: Readonly<ReviewPrincipal>,
    signal?: AbortSignal,
  ): Promise<ReviewEvidenceAckResponseV1>;
}

function finiteNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReviewServiceError("UNAVAILABLE");
  }
  return new Date(value);
}

function mapEvidenceError(error: unknown): never {
  if (error instanceof ReviewServiceError) throw error;
  if (error instanceof ReviewQueueRepositoryError) {
    throw new ReviewServiceError(error.code);
  }
  if (
    error instanceof PrivateReviewEvidenceReaderError
    || error instanceof ReviewEvidenceProofError
  ) {
    throw new ReviewServiceError(
      error instanceof PrivateReviewEvidenceReaderError && error.code === "CANCELLED"
        ? "CANCELLED"
        : "EVIDENCE_UNAVAILABLE",
    );
  }
  throw error;
}

export class ReviewEvidenceService implements ReviewEvidenceServiceContract {
  constructor(
    private readonly repository: ReviewQueueRepository,
    private readonly reader: PrivateReviewEvidenceReader,
    private readonly challengeCodec: ReviewEvidenceChallengeCodec,
    private readonly proofCodec: ReviewEvidenceProofCodec,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async render(
    candidateIdInput: string,
    principal: Readonly<ReviewPrincipal>,
    signal?: AbortSignal,
  ): Promise<RenderedPrivateReviewEvidence> {
    const candidateId = reviewCandidateIdSchema.parse(candidateIdInput);
    const at = finiteNow(this.now);
    try {
      const locator = await this.repository.getPrivateCaptureLocator(candidateId, at, signal);
      if (locator.candidateId !== candidateId) {
        throw new ReviewServiceError("CORRUPT_RECORD");
      }
      if (locator.rightsClassification === "extract_only") {
        throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
      }
      const verified = await this.reader.read(locator, signal ?? new AbortController().signal);
      if (
        verified.byteLength !== locator.byteLength
        || verified.checksumSha256 !== locator.checksumSha256
        || verified.mimeType !== locator.mimeType
      ) {
        throw new ReviewServiceError("CORRUPT_RECORD");
      }
      const binding = {
        candidateId,
        candidateVersion: locator.candidateVersion,
        checksumSha256: locator.checksumSha256,
        cropReference: locator.cropReference,
        presentation: "full_capture",
        rightsClassification: locator.rightsClassification,
      } as const;
      const challenge = this.challengeCodec.issue(binding, principal);
      return Object.freeze({
        byteLength: verified.byteLength,
        bytes: verified.bytes,
        challengeToken: challenge.token,
        expiresAt: challenge.expiresAt,
        mimeType: verified.mimeType,
        presentation: "full_capture",
        verifiedAt: at.toISOString(),
      });
    } catch (error) {
      mapEvidenceError(error);
    }
  }

  async acknowledge(
    requestInput: Readonly<ReviewEvidenceAckRequestV1>,
    principal: Readonly<ReviewPrincipal>,
    signal?: AbortSignal,
  ): Promise<ReviewEvidenceAckResponseV1> {
    const request = reviewEvidenceAckRequestV1Schema.parse(requestInput);
    const at = finiteNow(this.now);
    try {
      const locator = await this.repository.getPrivateCaptureLocator(
        request.candidateId,
        at,
        signal,
      );
      if (locator.candidateId !== request.candidateId) {
        throw new ReviewServiceError("CORRUPT_RECORD");
      }
      if (locator.rightsClassification === "extract_only") {
        throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
      }
      const binding = {
        candidateId: request.candidateId,
        candidateVersion: locator.candidateVersion,
        checksumSha256: locator.checksumSha256,
        cropReference: locator.cropReference,
        presentation: "full_capture",
        rightsClassification: locator.rightsClassification,
      } as const;
      this.challengeCodec.verify(request.challenge, binding, principal);
      const suppliedDigest = Buffer.from(request.digestSha256, "hex");
      const expectedDigest = Buffer.from(locator.checksumSha256, "hex");
      if (
        suppliedDigest.byteLength !== expectedDigest.byteLength
        || !timingSafeEqual(suppliedDigest, expectedDigest)
      ) {
        throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
      }
      // Browser image decode/load is an explicit acknowledgement gate. PDF
      // render completion is not observable with the current browser contract,
      // so PDF approval remains fail-closed.
      if (![
        "image/jpeg",
        "image/png",
        "image/webp",
      ].includes(locator.mimeType)) {
        throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
      }
      const proof = this.proofCodec.issue(binding, principal);
      const receipt = await this.repository.recordEvidenceRender({
        actorId: principal.actorId,
        candidateId: request.candidateId,
        checksumSha256: locator.checksumSha256,
        cropReference: locator.cropReference,
        evidenceProofSha256: proof.proofSha256,
        expectedVersion: locator.candidateVersion,
        expiresAt: proof.expiresAt,
        presentation: "full_capture",
        rightsClassification: locator.rightsClassification,
        sessionId: principal.sessionId,
      }, at, signal);
      if (receipt.expiresAt !== proof.expiresAt) {
        throw new ReviewServiceError("CORRUPT_RECORD");
      }
      return reviewEvidenceAckResponseV1Schema.parse(Object.freeze({
        candidateId: request.candidateId,
        contractVersion: 1,
        expiresAt: proof.expiresAt,
        presentation: "full_capture",
        proofToken: proof.token,
        renderedAt: receipt.renderedAt,
      }));
    } catch (error) {
      mapEvidenceError(error);
    }
  }
}
