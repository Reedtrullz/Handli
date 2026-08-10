import { reviewCandidateIdSchema } from "@handleplan/domain";

import type { ReviewEvidenceServiceContract } from "../../../../../../lib/server/review-evidence-service";
import {
  authorizePrivateReview,
  defaultReviewAuthenticator,
  privateError,
  privateNotFound,
  reviewServiceErrorResponse,
  type ReviewAuthenticator,
} from "../../../../../../lib/server/review-route";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type BoundedRequestOptions,
} from "../../../../../../lib/server/request-lifetime";

const STREAM_CHUNK_BYTES = 64 * 1024;
type ServiceProvider = () => ReviewEvidenceServiceContract | Promise<ReviewEvidenceServiceContract>;

function streamedBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + STREAM_CHUNK_BYTES, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

export function createReviewEvidenceHandler(
  getService: ServiceProvider,
  authenticate: ReviewAuthenticator = defaultReviewAuthenticator,
  options: BoundedRequestOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options, 10_000);
  return async function GET(request: Request, candidateIdInput: string): Promise<Response> {
    const principal = await authorizePrivateReview(request, authenticate);
    if (principal === undefined) return privateNotFound();
    if (
      [...new URL(request.url).searchParams].length !== 0
      || request.headers.has("range")
      || request.headers.has("if-range")
      || request.headers.has("if-none-match")
      || request.headers.has("if-modified-since")
    ) {
      return privateError("INVALID_REQUEST", 400);
    }
    const candidateId = reviewCandidateIdSchema.safeParse(candidateIdInput);
    if (!candidateId.success) return privateNotFound();

    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const service = await awaitWithinRequest(getService, lifetime.signal);
      const rendered = await awaitWithinRequest(
        () => service.render(candidateId.data, principal, lifetime.signal),
        lifetime.signal,
      );
      if (!["image/jpeg", "image/png", "image/webp"].includes(rendered.mimeType)) {
        return privateError("EVIDENCE_UNAVAILABLE", 409);
      }
      return new Response(streamedBytes(rendered.bytes), {
        headers: {
          "cache-control": "private, no-store, max-age=0, must-revalidate",
          "cdn-cache-control": "no-store",
          "cloudflare-cdn-cache-control": "no-store",
          "content-disposition": "inline; filename=private-review-evidence",
          "content-length": String(rendered.byteLength),
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": rendered.mimeType,
          "cross-origin-resource-policy": "same-origin",
          expires: "0",
          pragma: "no-cache",
          "referrer-policy": "no-referrer",
          "surrogate-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-handleplan-review-evidence-challenge": rendered.challengeToken,
          "x-handleplan-review-evidence-expires": rendered.expiresAt,
          "x-handleplan-review-evidence-presentation": rendered.presentation,
          "x-handleplan-review-evidence-verified-at": rendered.verifiedAt,
        },
      });
    } catch (error) {
      if (lifetime.signal.aborted) {
        return lifetime.deadlineExpired
          ? privateError("REQUEST_TIMEOUT", 503)
          : privateError("REQUEST_CANCELLED", 499);
      }
      if (error instanceof RequestOperationAbortedError) {
        return privateError("REQUEST_CANCELLED", 499);
      }
      return reviewServiceErrorResponse(error);
    } finally {
      lifetime.cleanup();
    }
  };
}

const handler = createReviewEvidenceHandler(async () => {
  const { getReviewServerContainer } = await import(
    "../../../../../../lib/server/review-container"
  );
  return getReviewServerContainer().reviewEvidenceService;
});

export async function GET(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
): Promise<Response> {
  const { candidateId } = await context.params;
  return handler(request, candidateId);
}
