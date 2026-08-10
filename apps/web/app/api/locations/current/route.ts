import {
  currentLocationRequestSchema,
  currentLocationResponseSchema,
} from "@handleplan/domain";

import {
  CurrentLocationServiceError,
  type CurrentLocationServiceContract,
} from "../../../../lib/server/travel/current-location-service";
import {
  admitControlledPublicApiOperation,
  publicApiRuntimeControlResponse,
  type ControlledPublicApiRouteOptions,
} from "../../../../lib/server/public-api-route-controls";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type RequestLifetime,
} from "../../../../lib/server/request-lifetime";

const DEFAULT_CURRENT_LOCATION_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512;
const MAX_RESPONSE_BYTES = 512;

type ServiceProvider = () =>
  | CurrentLocationServiceContract
  | Promise<CurrentLocationServiceContract>;

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
      // Cancellation cannot replace the sanitized response.
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

function hasOwnContractVersion(input: unknown): input is { contractVersion: unknown } {
  return input !== null
    && typeof input === "object"
    && Object.prototype.hasOwnProperty.call(input, "contractVersion");
}

function validatedResponse(value: unknown): Response {
  const parsed = currentLocationResponseSchema.safeParse(value);
  if (!parsed.success) return errorResponse("CURRENT_LOCATION_UNAVAILABLE", 503);
  let body: string;
  try {
    body = JSON.stringify(parsed.data);
  } catch {
    return errorResponse("CURRENT_LOCATION_UNAVAILABLE", 503);
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

export function createCurrentLocationHandler(
  getService: ServiceProvider,
  options: ControlledPublicApiRouteOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options, DEFAULT_CURRENT_LOCATION_TIMEOUT_MS);
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
      if (!hasOwnContractVersion(body.value)) {
        return errorResponse("CONTRACT_VERSION_REQUIRED", 400);
      }
      if (body.value.contractVersion !== 1) {
        return errorResponse("UNSUPPORTED_CONTRACT_VERSION", 400);
      }
      const parsed = currentLocationRequestSchema.safeParse(body.value);
      if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

      try {
        await awaitWithinRequest(
          () => admitControlledPublicApiOperation(
            options,
            "locations-current",
            lifetime.signal,
          ),
          lifetime.signal,
        );
        const service = await awaitWithinRequest(getService, lifetime.signal);
        const result = await awaitWithinRequest(
          () => service.issue(parsed.data, lifetime.signal),
          lifetime.signal,
        );
        return validatedResponse(result);
      } catch (error) {
        const aborted = requestAbortResponse(lifetime);
        if (aborted !== undefined) return aborted;
        const controlledResponse = publicApiRuntimeControlResponse(error);
        if (controlledResponse !== undefined) return controlledResponse;
        if (error instanceof RequestOperationAbortedError) {
          return errorResponse("REQUEST_CANCELLED", 499);
        }
        if (error instanceof CurrentLocationServiceError) {
          if (error.code === "INVALID_REQUEST") return errorResponse("INVALID_REQUEST", 400);
          if (error.code === "REQUEST_CANCELLED") {
            return errorResponse("REQUEST_CANCELLED", 499);
          }
        }
        return errorResponse("CURRENT_LOCATION_UNAVAILABLE", 503);
      }
    } finally {
      lifetime.cleanup();
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerContainer } = await import(
    "../../../../lib/server/container"
  );
  const { getProductionCurrentLocationService } = await import(
    "../../../../lib/server/travel/current-location-service"
  );
  const container = getServerContainer();
  return createCurrentLocationHandler(
    () => getProductionCurrentLocationService(),
    { runtimeControls: container.publicApiRuntimeControls },
  )(request);
}
