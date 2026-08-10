import {
  discoveryImpactRequestV1Schema,
  discoveryImpactResponseV1SchemaFor,
  type DiscoveryImpactRequestV1,
} from "@handleplan/domain";

import {
  DiscoveryImpactEvaluationError,
  type DiscoveryImpactServiceContract,
} from "../../../../lib/server/discovery-impact-service";
import { FamilyCandidateServiceError } from "../../../../lib/server/family-candidate-service";
import {
  CatalogUnavailableError,
  PlanRequestCancelledError,
  PriceDataUnavailableError,
  ReviewedFamilyPlanError,
  UnknownExactProductError,
} from "../../../../lib/server/plan-service";
import {
  publicApiRuntimeControlResponse,
  runControlledPublicApiOperation,
  type ControlledPublicApiRouteOptions,
} from "../../../../lib/server/public-api-route-controls";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type RequestLifetime,
} from "../../../../lib/server/request-lifetime";
import { isAllowedLaunchMarketContext } from "../../../../lib/launch-markets";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

type ServiceProvider = () =>
  | DiscoveryImpactServiceContract
  | Promise<DiscoveryImpactServiceContract>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, {
    headers: { "cache-control": "private, no-store" },
    status,
  });
}

function requestAbortResponse(lifetime: RequestLifetime): Response | undefined {
  if (!lifetime.signal.aborted) return undefined;
  return lifetime.deadlineExpired
    ? errorResponse("REQUEST_TIMEOUT", 503)
    : errorResponse("REQUEST_CANCELLED", 499);
}

function bestEffortCancelBody(request: Request): void {
  try {
    const cancellation = request.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup cannot replace the sanitized response.
  }
}

async function readJsonBody(request: Request, signal: AbortSignal): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  if (signal.aborted) throw new RequestOperationAbortedError();
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) {
    bestEffortCancelBody(request);
    return { ok: false, response: errorResponse("UNSUPPORTED_MEDIA_TYPE", 415) };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      bestEffortCancelBody(request);
      return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
    }
    if (Number(declaredLength) > MAX_BODY_BYTES) {
      bestEffortCancelBody(request);
      return { ok: false, response: errorResponse("REQUEST_TOO_LARGE", 413) };
    }
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
      // Cleanup cannot replace the sanitized response.
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
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: errorResponse("REQUEST_TOO_LARGE", 413) };
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
  } catch (error) {
    cancelReader();
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

function boundedResponse(request: DiscoveryImpactRequestV1, value: unknown): Response {
  let parsed;
  try {
    parsed = discoveryImpactResponseV1SchemaFor(request).safeParse(value);
  } catch {
    return errorResponse("INVALID_SERVICE_RESPONSE", 503);
  }
  if (!parsed.success) return errorResponse("INVALID_SERVICE_RESPONSE", 503);
  let body: string;
  try {
    body = JSON.stringify(parsed.data);
  } catch {
    return errorResponse("INVALID_SERVICE_RESPONSE", 503);
  }
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    return errorResponse("RESPONSE_TOO_LARGE", 503);
  }
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function serviceErrorResponse(error: unknown): Response {
  if (error instanceof PlanRequestCancelledError) {
    return errorResponse("REQUEST_CANCELLED", 499);
  }
  if (error instanceof ReviewedFamilyPlanError) {
    if (error.code === "CANDIDATE_CONFIRMATION_STALE") {
      return errorResponse("CANDIDATE_CONFIRMATION_STALE", 409);
    }
    if (error.code === "AMBIGUOUS_FAMILY_SELECTION") {
      return errorResponse("AMBIGUOUS_FAMILY_SELECTION", 422);
    }
    return errorResponse("INVALID_REQUEST", 400);
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
  if (error instanceof DiscoveryImpactEvaluationError) {
    return errorResponse("IMPACT_UNAVAILABLE", 503);
  }
  return errorResponse("IMPACT_UNAVAILABLE", 503);
}

export function createDiscoveryImpactHandler(
  getService: ServiceProvider,
  options: ControlledPublicApiRouteOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options);
  return async function POST(request: Request): Promise<Response> {
    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      let body: Awaited<ReturnType<typeof readJsonBody>>;
      try {
        body = await readJsonBody(request, lifetime.signal);
      } catch (error) {
        const aborted = requestAbortResponse(lifetime);
        if (aborted !== undefined) return aborted;
        if (error instanceof RequestOperationAbortedError) {
          return errorResponse("REQUEST_CANCELLED", 499);
        }
        return errorResponse("INVALID_REQUEST", 400);
      }
      if (!body.ok) return body.response;
      const parsed = discoveryImpactRequestV1Schema.safeParse(body.value);
      if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
      if (!isAllowedLaunchMarketContext(parsed.data.planning.marketContext)) {
        return errorResponse("MARKET_UNAVAILABLE", 422);
      }

      try {
        const result = await awaitWithinRequest(
          () => runControlledPublicApiOperation(
            options,
            "discovery-impact",
            parsed.data,
            lifetime.signal,
            async (operationSignal) => {
              const service = await awaitWithinRequest(getService, operationSignal);
              return service.calculate(parsed.data, operationSignal);
            },
          ),
          lifetime.signal,
        );
        return boundedResponse(parsed.data, result);
      } catch (error) {
        const aborted = requestAbortResponse(lifetime);
        if (aborted !== undefined) return aborted;
        const controlledResponse = publicApiRuntimeControlResponse(error);
        if (controlledResponse !== undefined) return controlledResponse;
        if (error instanceof RequestOperationAbortedError) {
          return errorResponse("REQUEST_CANCELLED", 499);
        }
        return serviceErrorResponse(error);
      }
    } finally {
      lifetime.cleanup();
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerContainer } = await import("../../../../lib/server/container");
  const container = getServerContainer();
  return createDiscoveryImpactHandler(
    () => container.discoveryImpactService,
    { runtimeControls: container.publicApiRuntimeControls },
  )(request);
}
