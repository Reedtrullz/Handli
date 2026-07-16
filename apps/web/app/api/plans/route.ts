import {
  exactProductPlanApiRequestSchema,
  exactProductPlanApiResponseSchemaFor,
  isValidGtin,
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyPlanApiResponseV2SchemaFor,
} from "@handleplan/domain";

import { FamilyCandidateServiceError } from "../../../lib/server/family-candidate-service";
import {
  CatalogUnavailableError,
  PlanRequestCancelledError,
  PriceDataUnavailableError,
  ReviewedFamilyPlanError,
  UnknownExactProductError,
  type PlanServiceContract,
} from "../../../lib/server/plan-service";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type BoundedRequestOptions,
  type RequestLifetime,
} from "../../../lib/server/request-lifetime";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;

export const PLAN_CAVEATS = [
  "Resultatet gjelder prisene Handleplan kunne verifisere; ukjent kjededekning kan påvirke sammenligningen.",
  "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
  "Medlemspriser og kundeavis-tilbud er ikke med i denne beregningen.",
] as const;

type ServiceProvider = () => PlanServiceContract | Promise<PlanServiceContract>;

function requestAbortResponse(lifetime: RequestLifetime): Response | undefined {
  if (!lifetime.signal.aborted) return undefined;
  return lifetime.deadlineExpired
    ? errorResponse("REQUEST_TIMEOUT", 503)
    : errorResponse("REQUEST_CANCELLED", 499);
}

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, {
    headers: { "cache-control": "private, no-store" },
    status,
  });
}

function boundedJsonResponse(value: unknown): Response {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return errorResponse("INVALID_SERVICE_RESPONSE", 503);
  }
  if (serialized === undefined) {
    return errorResponse("INVALID_SERVICE_RESPONSE", 503);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
    return errorResponse("RESPONSE_TOO_LARGE", 503);
  }
  return new Response(serialized, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}

function hasOwnContractVersion(input: unknown): input is { contractVersion: unknown } {
  return input !== null
    && typeof input === "object"
    && Object.prototype.hasOwnProperty.call(input, "contractVersion");
}

function reviewedPlanningErrorResponse(error: unknown): Response {
  if (error instanceof PlanRequestCancelledError) {
    return errorResponse("REQUEST_CANCELLED", 499);
  }
  if (error instanceof ReviewedFamilyPlanError) {
    switch (error.code) {
      case "INVALID_REQUEST": return errorResponse("INVALID_REQUEST", 400);
      case "CANDIDATE_CONFIRMATION_STALE": {
        return errorResponse("CANDIDATE_CONFIRMATION_STALE", 409);
      }
      case "AMBIGUOUS_FAMILY_SELECTION": {
        return errorResponse("AMBIGUOUS_FAMILY_SELECTION", 422);
      }
    }
  }
  if (error instanceof FamilyCandidateServiceError) {
    switch (error.code) {
      case "REQUEST_CANCELLED": return errorResponse("REQUEST_CANCELLED", 499);
      case "INVALID_REQUEST": return errorResponse("INVALID_REQUEST", 400);
      case "UNKNOWN_FAMILY":
      case "FAMILY_NO_CANDIDATES":
      case "NO_MATCHING_BRANDS":
      case "CANDIDATE_SET_TOO_LARGE":
      case "AMBIGUOUS_FAMILY_MEMBERSHIP": {
        return errorResponse(error.code, 422);
      }
      case "CANDIDATE_SET_INCOMPLETE":
      case "EVIDENCE_UNAVAILABLE": {
        return errorResponse(error.code, 503);
      }
    }
  }
  if (error instanceof UnknownExactProductError) {
    return errorResponse("UNKNOWN_EXACT_PRODUCT", 422);
  }
  if (error instanceof CatalogUnavailableError) {
    return errorResponse("CATALOG_UNAVAILABLE", 503);
  }
  if (error instanceof PriceDataUnavailableError) {
    return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
  }
  return errorResponse("EVIDENCE_UNAVAILABLE", 503);
}

function containsDigitShapedInvalidGtin(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const needs = (input as { needs?: unknown }).needs;
  if (!Array.isArray(needs)) return false;
  return needs.some((need) => {
    if (need === null || typeof need !== "object") return false;
    const match = (need as { match?: unknown }).match;
    if (match === null || typeof match !== "object") return false;
    const product = (match as { product?: unknown }).product;
    if (product === null || typeof product !== "object") return false;
    const value = (product as { value?: unknown }).value;
    return typeof value === "string"
      && /^(?:\d{8}|\d{13})$/.test(value)
      && !isValidGtin(value);
  });
}

function bestEffortCancelBody(request: Request): void {
  try {
    const cancellation = request.body?.cancel();
    if (cancellation !== undefined) {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is cleanup only and never changes the sanitized response.
  }
}

async function readJsonBody(request: Request, signal: AbortSignal): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  if (signal.aborted) throw new RequestOperationAbortedError();
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    bestEffortCancelBody(request);
    return { ok: false, response: errorResponse("UNSUPPORTED_MEDIA_TYPE", 415) };
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    bestEffortCancelBody(request);
    return { ok: false, response: errorResponse("REQUEST_TOO_LARGE", 413) };
  }

  if (request.body === null) {
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    bestEffortCancelBody(request);
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytesRead = 0;
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is cleanup only and never changes the sanitized response.
    }
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  try {
    while (true) {
      const { done, value } = await awaitWithinRequest(() => reader.read(), signal);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, response: errorResponse("REQUEST_TOO_LARGE", 413) };
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof RequestOperationAbortedError || signal.aborted) throw error;
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
  } finally {
    signal.removeEventListener("abort", cancelReader);
  }
  try {
    return { ok: true, value: JSON.parse(fragments.join("")) as unknown };
  } catch {
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
  }
}

export function createPlansHandler(
  getService: ServiceProvider,
  options: BoundedRequestOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options);
  return async function POST(request: Request): Promise<Response> {
    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      let body: Awaited<ReturnType<typeof readJsonBody>>;
      try {
        body = await readJsonBody(request, lifetime.signal);
      } catch (error) {
        const abortResponse = requestAbortResponse(lifetime);
        if (abortResponse !== undefined) return abortResponse;
        if (error instanceof RequestOperationAbortedError) {
          return errorResponse("REQUEST_CANCELLED", 499);
        }
        return errorResponse("INVALID_REQUEST", 400);
      }
      if (!body.ok) return body.response;

      if (!hasOwnContractVersion(body.value)) {
        return errorResponse("CONTRACT_VERSION_REQUIRED", 400);
      }

      if (body.value.contractVersion !== 1 && body.value.contractVersion !== 2) {
        return errorResponse("UNSUPPORTED_CONTRACT_VERSION", 400);
      }

      if (body.value.contractVersion === 1) {
        const parsed = exactProductPlanApiRequestSchema.safeParse(body.value);
        if (!parsed.success) {
          return containsDigitShapedInvalidGtin(body.value)
            ? errorResponse("INVALID_EXACT_PRODUCT", 422)
            : errorResponse("INVALID_REQUEST", 400);
        }

        try {
          const service = await awaitWithinRequest(getService, lifetime.signal);
          const result = await awaitWithinRequest(
            () => service.calculateExact(parsed.data, lifetime.signal),
            lifetime.signal,
          );
          const response = exactProductPlanApiResponseSchemaFor(parsed.data).safeParse({
            caveats: PLAN_CAVEATS,
            contractVersion: 1,
            evidence: result.evidence,
            generatedAt: result.generatedAt,
            plans: result.plans,
            priceDataSource: result.priceDataSource,
            products: result.products,
          });
          if (!response.success) throw new CatalogUnavailableError();
          return boundedJsonResponse(response.data);
        } catch (error) {
          const abortResponse = requestAbortResponse(lifetime);
          if (abortResponse !== undefined) return abortResponse;
          if (
            error instanceof RequestOperationAbortedError
            || error instanceof PlanRequestCancelledError
          ) {
            return errorResponse("REQUEST_CANCELLED", 499);
          }
          if (error instanceof UnknownExactProductError) {
            return errorResponse("UNKNOWN_EXACT_PRODUCT", 422);
          }
          if (error instanceof CatalogUnavailableError) {
            return errorResponse("CATALOG_UNAVAILABLE", 503);
          }
          if (error instanceof PriceDataUnavailableError) {
            return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
          }
          return errorResponse("CATALOG_UNAVAILABLE", 503);
        }
      }

      const parsed = reviewedFamilyPlanApiRequestV2Schema.safeParse(body.value);
      if (!parsed.success) {
        return containsDigitShapedInvalidGtin(body.value)
          ? errorResponse("INVALID_EXACT_PRODUCT", 422)
          : errorResponse("INVALID_REQUEST", 400);
      }
      try {
        const service = await awaitWithinRequest(getService, lifetime.signal);
        const result = await awaitWithinRequest(
          () => service.calculateReviewed(parsed.data, lifetime.signal),
          lifetime.signal,
        );
        const response = reviewedFamilyPlanApiResponseV2SchemaFor(parsed.data).safeParse({
          caveats: PLAN_CAVEATS,
          contractVersion: 2,
          evidence: result.evidence,
          generatedAt: result.generatedAt,
          needMatches: result.needMatches,
          plans: result.plans,
          priceDataSource: result.priceDataSource,
          productClaims: result.productClaims,
          taxonomy: result.taxonomy,
        });
        if (!response.success) {
          return errorResponse("INVALID_SERVICE_RESPONSE", 503);
        }
        return boundedJsonResponse(response.data);
      } catch (error) {
        const abortResponse = requestAbortResponse(lifetime);
        if (abortResponse !== undefined) return abortResponse;
        if (error instanceof RequestOperationAbortedError) {
          return errorResponse("REQUEST_CANCELLED", 499);
        }
        return reviewedPlanningErrorResponse(error);
      }
    } finally {
      lifetime.cleanup();
    }
  };
}

export const POST = createPlansHandler(async () => {
  const { getServerContainer } = await import("../../../lib/server/container");
  return getServerContainer().planService;
});
