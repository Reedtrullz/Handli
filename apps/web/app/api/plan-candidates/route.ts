import {
  reviewedFamilyCandidateInspectionRequestSchema,
  reviewedFamilyCandidateInspectionResponseSchemaFor,
} from "@handleplan/domain";

import {
  FamilyCandidateServiceError,
  type FamilyCandidateServiceContract,
  type FamilyCandidateServiceErrorCode,
} from "../../../lib/server/family-candidate-service";
import {
  publicApiRuntimeControlResponse,
  runControlledPublicApiOperation,
  type ControlledPublicApiRouteOptions,
} from "../../../lib/server/public-api-route-controls";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type RequestLifetime,
} from "../../../lib/server/request-lifetime";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;

type ServiceProvider = () =>
  | FamilyCandidateServiceContract
  | Promise<FamilyCandidateServiceContract>;

const serviceErrorStatuses: Readonly<Record<FamilyCandidateServiceErrorCode, number>> = {
  AMBIGUOUS_FAMILY_MEMBERSHIP: 409,
  CANDIDATE_SET_INCOMPLETE: 503,
  CANDIDATE_SET_TOO_LARGE: 422,
  EVIDENCE_UNAVAILABLE: 503,
  FAMILY_NO_CANDIDATES: 422,
  INVALID_REQUEST: 400,
  NO_MATCHING_BRANDS: 422,
  REQUEST_CANCELLED: 499,
  UNKNOWN_FAMILY: 422,
};

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

function boundedJsonResponse(value: unknown): Response {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return errorResponse("EVIDENCE_UNAVAILABLE", 503);
  }
  if (
    serialized === undefined
    || new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES
  ) {
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

function bestEffortCancelBody(request: Request): void {
  try {
    const cancellation = request.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup must not affect the sanitized response.
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
      // Cleanup must not affect the sanitized response.
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

function hasOwnContractVersion(input: unknown): input is { contractVersion: unknown } {
  return input !== null
    && typeof input === "object"
    && Object.prototype.hasOwnProperty.call(input, "contractVersion");
}

export function createPlanCandidatesHandler(
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
      if (body.value.contractVersion !== 2) {
        return errorResponse("UNSUPPORTED_CONTRACT_VERSION", 400);
      }

      const parsed = reviewedFamilyCandidateInspectionRequestSchema.safeParse(body.value);
      if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

      try {
        const result = await awaitWithinRequest(
          () => runControlledPublicApiOperation(
            options,
            "plan-candidates",
            parsed.data,
            lifetime.signal,
            async (operationSignal) => {
              const service = await awaitWithinRequest(getService, operationSignal);
              return service.inspect(parsed.data, operationSignal);
            },
          ),
          lifetime.signal,
        );
        const response = reviewedFamilyCandidateInspectionResponseSchemaFor(parsed.data)
          .safeParse(result);
        if (!response.success) return errorResponse("EVIDENCE_UNAVAILABLE", 503);
        return boundedJsonResponse(response.data);
      } catch (error) {
        const abortResponse = requestAbortResponse(lifetime);
        if (abortResponse !== undefined) return abortResponse;
        const controlledResponse = publicApiRuntimeControlResponse(error);
        if (controlledResponse !== undefined) return controlledResponse;
        if (error instanceof RequestOperationAbortedError) {
          return errorResponse("REQUEST_CANCELLED", 499);
        }
        if (error instanceof FamilyCandidateServiceError) {
          return errorResponse(error.code, serviceErrorStatuses[error.code]);
        }
        return errorResponse("EVIDENCE_UNAVAILABLE", 503);
      }
    } finally {
      lifetime.cleanup();
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerContainer } = await import("../../../lib/server/container");
  const container = getServerContainer();
  return createPlanCandidatesHandler(
    () => container.familyCandidateService,
    { runtimeControls: container.publicApiRuntimeControls },
  )(request);
}
