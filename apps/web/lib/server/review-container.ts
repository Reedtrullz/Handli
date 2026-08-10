import "server-only";

import { createDatabase } from "@handleplan/db/client";
import {
  PostgresReviewQueueRepository,
  ReviewQueueRepositoryError,
  type ReviewQueueRepository,
} from "@handleplan/db/review-queue";

import { readReviewServerEnv, type ReviewServerEnv } from "./review-env";
import {
  ReviewEvidenceService,
  type ReviewEvidenceServiceContract,
} from "./review-evidence-service";
import { FilesystemPrivateReviewEvidenceReader } from "./review-evidence-reader";
import {
  ReviewEvidenceChallengeCodec,
  ReviewEvidenceProofCodec,
} from "./review-evidence-proof";
import {
  BoundedPrivateRuntimeReadinessProbe,
  createReviewPostgresReadinessCheck,
  PRIVATE_RUNTIME_DATABASE_ROLES,
  type PrivateRuntimeReadinessProbe,
} from "./private-runtime-readiness";
import { REQUIRED_DATABASE_MIGRATION } from "./readiness";
import {
  ReviewService,
  ReviewServiceError,
  type ReviewServiceContract,
} from "./review-service";

export interface ReviewServerContainer {
  readinessProbe: PrivateRuntimeReadinessProbe;
  reviewEvidenceService: ReviewEvidenceServiceContract;
  reviewService: ReviewServiceContract;
}

class EmptyPrivateReviewRepository implements ReviewQueueRepository {
  async list() {
    return { contractVersion: 1 as const, items: [] };
  }

  async get(): Promise<never> {
    throw new ReviewQueueRepositoryError("NOT_FOUND");
  }

  async decide(): Promise<never> {
    throw new ReviewQueueRepositoryError("NOT_FOUND");
  }

  async getPrivateCaptureLocator(): Promise<never> {
    throw new ReviewQueueRepositoryError("NOT_FOUND");
  }

  async recordEvidenceRender(): Promise<never> {
    throw new ReviewQueueRepositoryError("NOT_FOUND");
  }
}

class EmptyPrivateReviewEvidenceService implements ReviewEvidenceServiceContract {
  async render(): Promise<never> {
    throw new ReviewServiceError("NOT_FOUND");
  }

  async acknowledge(): Promise<never> {
    throw new ReviewServiceError("NOT_FOUND");
  }
}

let singleton: ReviewServerContainer | undefined;

export function createReviewServerContainer(env: ReviewServerEnv): ReviewServerContainer {
  if (env.mode === "fake") {
    const repository = new EmptyPrivateReviewRepository();
    return Object.freeze({
      readinessProbe: new BoundedPrivateRuntimeReadinessProbe({
        checkDependency: async () => true,
        expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.review,
        requiredMigration: REQUIRED_DATABASE_MIGRATION,
        runtime: "review",
        timeoutMs: 1_500,
      }),
      reviewEvidenceService: new EmptyPrivateReviewEvidenceService(),
      reviewService: new ReviewService(repository),
    });
  }
  const connection = createDatabase(env.REVIEW_DATABASE_URL);
  const repository = new PostgresReviewQueueRepository(
    connection.db,
  );
  const challengeCodec = new ReviewEvidenceChallengeCodec(env.REVIEW_EVIDENCE_PROOF_SECRET);
  const proofCodec = new ReviewEvidenceProofCodec(env.REVIEW_EVIDENCE_PROOF_SECRET);
  return Object.freeze({
    readinessProbe: new BoundedPrivateRuntimeReadinessProbe({
      checkDependency: createReviewPostgresReadinessCheck(connection.db),
      expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.review,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "review",
      timeoutMs: 1_500,
    }),
    reviewEvidenceService: new ReviewEvidenceService(
      repository,
      new FilesystemPrivateReviewEvidenceReader({
        rootDirectory: env.REVIEW_PRIVATE_CAPTURE_ROOT,
      }),
      challengeCodec,
      proofCodec,
    ),
    reviewService: new ReviewService(repository, undefined, proofCodec),
  });
}

export function getReviewServerContainer(): ReviewServerContainer {
  singleton ??= createReviewServerContainer(readReviewServerEnv());
  return singleton;
}

export function resetReviewServerContainerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Review container reset is test-only");
  }
  singleton = undefined;
}
