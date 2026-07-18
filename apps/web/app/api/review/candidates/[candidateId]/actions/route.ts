import {
  reviewCandidateIdSchema,
  reviewDecisionRequestV1Schema,
} from "@handleplan/domain";

import type { ReviewServiceContract } from "../../../../../../lib/server/review-service";
import {
  authorizePrivateReview,
  defaultReviewAuthenticator,
  privateBoundedJson,
  privateError,
  privateNotFound,
  readBoundedReviewJson,
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

const MAX_RESPONSE_BYTES = 8 * 1024;
type ServiceProvider = () => ReviewServiceContract | Promise<ReviewServiceContract>;

export function createReviewActionHandler(
  getService: ServiceProvider,
  authenticate: ReviewAuthenticator = defaultReviewAuthenticator,
  options: BoundedRequestOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options, 5_000);
  return async function POST(request: Request, candidateIdInput: string): Promise<Response> {
    const principal = await authorizePrivateReview(request, authenticate);
    if (principal === undefined) return privateNotFound();
    if ([...new URL(request.url).searchParams].length !== 0) {
      return privateError("INVALID_REQUEST", 400);
    }
    const candidateId = reviewCandidateIdSchema.safeParse(candidateIdInput);
    if (!candidateId.success) return privateNotFound();

    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const body = await readBoundedReviewJson(request, lifetime.signal);
      if (!body.ok) return body.response;
      const parsed = reviewDecisionRequestV1Schema.safeParse(body.value);
      if (!parsed.success || parsed.data.candidateId !== candidateId.data) {
        return privateError("INVALID_REQUEST", 400);
      }
      const service = await awaitWithinRequest(getService, lifetime.signal);
      const result = await awaitWithinRequest(
        () => service.decide(parsed.data, principal, lifetime.signal),
        lifetime.signal,
      );
      return privateBoundedJson(result, MAX_RESPONSE_BYTES);
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

const handler = createReviewActionHandler(async () => {
  const { getReviewServerContainer } = await import("../../../../../../lib/server/review-container");
  return getReviewServerContainer().reviewService;
});

export async function POST(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
): Promise<Response> {
  const { candidateId } = await context.params;
  return handler(request, candidateId);
}
