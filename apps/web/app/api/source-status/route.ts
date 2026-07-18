import { publicSourceStatusResponseSchema } from "@handleplan/domain";

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
import {
  SourceStatusRequestCancelledError,
  SourceStatusUnavailableError,
  type SourceStatusServiceContract,
} from "../../../lib/server/source-status-service";

const MAX_RESPONSE_BYTES = 32 * 1024;
type ServiceProvider = () => SourceStatusServiceContract | Promise<SourceStatusServiceContract>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function abortResponse(lifetime: RequestLifetime): Response | undefined {
  if (!lifetime.signal.aborted) return undefined;
  return lifetime.deadlineExpired
    ? errorResponse("REQUEST_TIMEOUT", 503)
    : errorResponse("REQUEST_CANCELLED", 499);
}

function validatedResponse(value: unknown): Response {
  const parsed = publicSourceStatusResponseSchema.safeParse(value);
  if (!parsed.success) throw new SourceStatusUnavailableError();
  const body = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new SourceStatusUnavailableError();
  }
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function createSourceStatusHandler(
  getService: ServiceProvider,
  options: ControlledPublicApiRouteOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options, 3_000);
  return async function GET(request: Request): Promise<Response> {
    if ([...new URL(request.url).searchParams].length !== 0) {
      return errorResponse("INVALID_REQUEST", 400);
    }
    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const result = await awaitWithinRequest(
        () => runControlledPublicApiOperation(
          options,
          "source-status",
          { contractVersion: 1 },
          lifetime.signal,
          async (operationSignal) => {
            const service = await awaitWithinRequest(getService, operationSignal);
            return service.read(operationSignal);
          },
        ),
        lifetime.signal,
      );
      return validatedResponse(result);
    } catch (error) {
      const cancelled = abortResponse(lifetime);
      if (cancelled !== undefined) return cancelled;
      const controlledResponse = publicApiRuntimeControlResponse(error);
      if (controlledResponse !== undefined) return controlledResponse;
      if (
        error instanceof RequestOperationAbortedError
        || error instanceof SourceStatusRequestCancelledError
      ) {
        return errorResponse("REQUEST_CANCELLED", 499);
      }
      return errorResponse("SOURCE_STATUS_UNAVAILABLE", 503);
    } finally {
      lifetime.cleanup();
    }
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerContainer } = await import("../../../lib/server/container");
  const container = getServerContainer();
  return createSourceStatusHandler(
    () => container.sourceStatusService,
    { runtimeControls: container.publicApiRuntimeControls },
  )(request);
}
