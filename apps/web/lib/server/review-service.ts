import "server-only";

import {
  reviewCandidateIdSchema,
  reviewDecisionRequestV1Schema,
  reviewDecisionResponseV1Schema,
  reviewQueueCandidateV1Schema,
  reviewQueueFiltersV1Schema,
  reviewQueueResponseV1Schema,
  type ReviewDecisionRequestV1,
  type ReviewDecisionResponseV1,
  type ReviewQueueCandidateV1,
  type ReviewQueueFiltersV1,
  type ReviewQueueResponseV1,
} from "@handleplan/domain";
import {
  ReviewQueueRepositoryError,
  type PrivateReviewCaptureLocator,
  type ReviewQueueRepository,
} from "@handleplan/db/review-queue";

import type { ReviewPrincipal } from "./review-access";
import {
  ReviewEvidenceProofCodec,
  ReviewEvidenceProofError,
} from "./review-evidence-proof";

export type ReviewServiceErrorCode =
  | "ALREADY_REVIEWED"
  | "CANCELLED"
  | "CORRUPT_RECORD"
  | "DECISION_MISMATCH"
  | "EVIDENCE_UNAVAILABLE"
  | "NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "UNAVAILABLE"
  | "VERSION_CONFLICT";

export class ReviewServiceError extends Error {
  constructor(readonly code: ReviewServiceErrorCode) {
    super(`Private review service failed: ${code}`);
    this.name = "ReviewServiceError";
  }
}

export interface ReviewServiceContract {
  decide(
    input: ReviewDecisionRequestV1,
    principal: Readonly<ReviewPrincipal>,
    signal?: AbortSignal,
  ): Promise<ReviewDecisionResponseV1>;
  get(candidateId: string, signal?: AbortSignal): Promise<ReviewQueueCandidateV1>;
  getPrivateCaptureLocator(
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<PrivateReviewCaptureLocator>;
  list(
    filters: ReviewQueueFiltersV1,
    signal?: AbortSignal,
  ): Promise<ReviewQueueResponseV1>;
}

function finiteNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReviewServiceError("UNAVAILABLE");
  }
  return new Date(value);
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ReviewQueueRepositoryError) {
    throw new ReviewServiceError(error.code);
  }
  throw error;
}

export class ReviewService implements ReviewServiceContract {
  constructor(
    private readonly repository: ReviewQueueRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly evidenceProofCodec?: ReviewEvidenceProofCodec,
  ) {}

  async list(
    filtersInput: ReviewQueueFiltersV1,
    signal?: AbortSignal,
  ): Promise<ReviewQueueResponseV1> {
    const filters = reviewQueueFiltersV1Schema.parse(filtersInput);
    try {
      const value = await this.repository.list(filters, finiteNow(this.now), signal);
      return reviewQueueResponseV1Schema.parse(value);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async get(candidateIdInput: string, signal?: AbortSignal): Promise<ReviewQueueCandidateV1> {
    const candidateId = reviewCandidateIdSchema.parse(candidateIdInput);
    try {
      const value = await this.repository.get(candidateId, finiteNow(this.now), signal);
      return reviewQueueCandidateV1Schema.parse(value);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async decide(
    input: ReviewDecisionRequestV1,
    principal: Readonly<ReviewPrincipal>,
    signal?: AbortSignal,
  ): Promise<ReviewDecisionResponseV1> {
    const request = reviewDecisionRequestV1Schema.parse(input);
    const at = finiteNow(this.now);
    try {
      let proofSha256: string | undefined;
      if (request.action !== "reject") {
        if (this.evidenceProofCodec === undefined) {
          throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
        }
        const locator = await this.repository.getPrivateCaptureLocator(
          request.candidateId,
          at,
          signal,
        );
        if (locator.rightsClassification === "extract_only") {
          throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
        }
        const proof = this.evidenceProofCodec.verify(request.approvalEvidence.token, {
          candidateId: locator.candidateId,
          candidateVersion: locator.candidateVersion,
          checksumSha256: locator.checksumSha256,
          cropReference: locator.cropReference,
          presentation: request.approvalEvidence.presentation,
          rightsClassification: locator.rightsClassification,
        }, principal);
        proofSha256 = proof.proofSha256;
      }
      const value = await this.repository.decide(
        request,
        { actorId: principal.actorId, sessionId: principal.sessionId },
        proofSha256,
        at,
        signal,
      );
      return reviewDecisionResponseV1Schema.parse(value);
    } catch (error) {
      if (error instanceof ReviewEvidenceProofError) {
        throw new ReviewServiceError("EVIDENCE_UNAVAILABLE");
      }
      mapRepositoryError(error);
    }
  }

  async getPrivateCaptureLocator(
    candidateIdInput: string,
    signal?: AbortSignal,
  ): Promise<PrivateReviewCaptureLocator> {
    const candidateId = reviewCandidateIdSchema.parse(candidateIdInput);
    try {
      return await this.repository.getPrivateCaptureLocator(
        candidateId,
        finiteNow(this.now),
        signal,
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }
}
