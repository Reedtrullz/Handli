import "server-only";

import {
  reviewQueueFiltersV1Schema,
  type ReviewQueueFiltersV1,
} from "@handleplan/domain";

import {
  readReviewAccessConfig,
  verifyReviewAccess,
  type ReviewPrincipal,
} from "./review-access";
import { RequestOperationAbortedError } from "./request-lifetime";
import { ReviewServiceError } from "./review-service";

const MAX_JSON_BODY_BYTES = 32 * 1024;
const PRIVATE_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

export type ReviewAuthenticator = (request: Request) => Promise<ReviewPrincipal>;

export const defaultReviewAuthenticator: ReviewAuthenticator = async (request) =>
  verifyReviewAccess(request, readReviewAccessConfig());

export function privateJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: PRIVATE_HEADERS, status });
}

export function privateBoundedJson(value: unknown, maximumBytes: number): Response {
  try {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > maximumBytes) {
      return privateError("RESPONSE_TOO_LARGE", 503);
    }
    return new Response(body, { headers: PRIVATE_HEADERS });
  } catch {
    return privateError("REVIEW_UNAVAILABLE", 503);
  }
}

export function privateError(code: string, status: number): Response {
  return privateJson({ code }, status);
}

/** Deliberately identical for missing, malformed, expired, and unauthorized requests. */
export function privateNotFound(): Response {
  return privateError("NOT_FOUND", 404);
}

export async function authorizePrivateReview(
  request: Request,
  authenticate: ReviewAuthenticator,
): Promise<ReviewPrincipal | undefined> {
  try {
    return await authenticate(request);
  } catch {
    return undefined;
  }
}

function canonicalInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
  return Number(value);
}

export function parseReviewQueueFilters(url: URL): ReviewQueueFiltersV1 | undefined {
  const allowed = new Set([
    "anomaly",
    "chain",
    "cursor",
    "limit",
    "maxAgeHours",
    "maxConfidence",
    "minAgeHours",
    "minConfidence",
    "scopeKind",
  ]);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) return undefined;
    seen.add(key);
  }
  const minAge = canonicalInteger(url.searchParams.get("minAgeHours"));
  const maxAge = canonicalInteger(url.searchParams.get("maxAgeHours"));
  const minConfidence = canonicalInteger(url.searchParams.get("minConfidence"));
  const maxConfidence = canonicalInteger(url.searchParams.get("maxConfidence"));
  const limit = canonicalInteger(url.searchParams.get("limit")) ?? 25;
  if ([minAge, maxAge, minConfidence, maxConfidence, limit].some(Number.isNaN)) {
    return undefined;
  }
  const value = {
    ...(minAge === undefined && maxAge === undefined
      ? {}
      : { ageHours: { ...(minAge === undefined ? {} : { min: minAge }), ...(maxAge === undefined ? {} : { max: maxAge }) } }),
    ...(url.searchParams.has("anomaly")
      ? { anomaly: url.searchParams.get("anomaly") }
      : {}),
    ...(url.searchParams.has("chain") ? { chain: url.searchParams.get("chain") } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
    ...(minConfidence === undefined && maxConfidence === undefined
      ? {}
      : { confidence: {
        ...(minConfidence === undefined ? {} : { min: minConfidence }),
        ...(maxConfidence === undefined ? {} : { max: maxConfidence }),
      } }),
    contractVersion: 1,
    limit,
    ...(url.searchParams.has("scopeKind")
      ? { scopeKind: url.searchParams.get("scopeKind") }
      : {}),
  };
  const parsed = reviewQueueFiltersV1Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function bestEffortCancel(request: Request): void {
  try {
    const result = request.body?.cancel();
    if (result !== undefined) void result.catch(() => undefined);
  } catch {
    // Cleanup must not alter the sanitized response.
  }
}

export async function readBoundedReviewJson(
  request: Request,
  signal: AbortSignal,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (signal.aborted) throw new RequestOperationAbortedError();
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) {
    bestEffortCancel(request);
    return { ok: false, response: privateError("UNSUPPORTED_MEDIA_TYPE", 415) };
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_JSON_BODY_BYTES)
  ) {
    bestEffortCancel(request);
    return {
      ok: false,
      response: /^\d+$/u.test(declaredLength)
        ? privateError("REQUEST_TOO_LARGE", 413)
        : privateError("INVALID_REQUEST", 400),
    };
  }
  if (request.body === null) return { ok: false, response: privateError("INVALID_REQUEST", 400) };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    bestEffortCancel(request);
    return { ok: false, response: privateError("INVALID_REQUEST", 400) };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytesRead = 0;
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup must not alter the sanitized response.
    }
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (signal.aborted) throw new RequestOperationAbortedError();
      bytesRead += result.value.byteLength;
      if (bytesRead > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: privateError("REQUEST_TOO_LARGE", 413) };
      }
      fragments.push(decoder.decode(result.value, { stream: true }));
    }
    fragments.push(decoder.decode());
  } catch (error) {
    cancelReader();
    if (signal.aborted || error instanceof RequestOperationAbortedError) throw error;
    return { ok: false, response: privateError("INVALID_REQUEST", 400) };
  } finally {
    signal.removeEventListener("abort", cancelReader);
  }
  try {
    return { ok: true, value: JSON.parse(fragments.join("")) as unknown };
  } catch {
    return { ok: false, response: privateError("INVALID_REQUEST", 400) };
  }
}

export function reviewServiceErrorResponse(error: unknown): Response {
  if (!(error instanceof ReviewServiceError)) return privateError("REVIEW_UNAVAILABLE", 503);
  switch (error.code) {
    case "NOT_FOUND": return privateNotFound();
    case "VERSION_CONFLICT": return privateError("VERSION_CONFLICT", 409);
    case "ALREADY_REVIEWED": return privateError("ALREADY_REVIEWED", 409);
    case "EVIDENCE_UNAVAILABLE": return privateError("EVIDENCE_UNAVAILABLE", 409);
    case "DECISION_MISMATCH": return privateError("DECISION_MISMATCH", 422);
    case "TARGET_NOT_FOUND": return privateError("TARGET_NOT_FOUND", 422);
    case "CANCELLED": return privateError("REQUEST_CANCELLED", 499);
    case "CORRUPT_RECORD":
    case "UNAVAILABLE": return privateError("REVIEW_UNAVAILABLE", 503);
  }
}
