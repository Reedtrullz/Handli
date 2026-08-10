import type { OperationsRuntimeServiceContract } from "../../../../../lib/server/operations-runtime-service";
import {
  authorizePrivateOperations,
  defaultOperationsAuthenticator,
  operationsPrivateBoundedJson,
  operationsPrivateError,
  operationsPrivateNotFound,
  operationsServiceErrorResponse,
  type OperationsAuthenticator,
} from "../../../../../lib/server/operations-route";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type BoundedRequestOptions,
} from "../../../../../lib/server/request-lifetime";

const MAX_RESPONSE_BYTES = 256 * 1024;
type ServiceProvider = () => OperationsRuntimeServiceContract
  | Promise<OperationsRuntimeServiceContract>;

export function createOperationsSnapshotHandler(
  getService: ServiceProvider,
  authenticate: OperationsAuthenticator = defaultOperationsAuthenticator,
  options: BoundedRequestOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options, 4_000);
  return async function GET(request: Request): Promise<Response> {
    const principal = await authorizePrivateOperations(request, authenticate);
    if (principal === undefined) return operationsPrivateNotFound();
    const url = new URL(request.url);
    if (url.search !== "") return operationsPrivateError("INVALID_REQUEST", 400);

    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const service = await awaitWithinRequest(getService, lifetime.signal);
      const result = await awaitWithinRequest(
        () => service.read(lifetime.signal),
        lifetime.signal,
      );
      return operationsPrivateBoundedJson(result, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (lifetime.signal.aborted) {
        return lifetime.deadlineExpired
          ? operationsPrivateError("REQUEST_TIMEOUT", 503)
          : operationsPrivateError("REQUEST_CANCELLED", 499);
      }
      if (error instanceof RequestOperationAbortedError) {
        return operationsPrivateError("REQUEST_CANCELLED", 499);
      }
      return operationsServiceErrorResponse(error);
    } finally {
      lifetime.cleanup();
    }
  };
}

export function createOperationsUnsupportedMethodHandler(
  authenticate: OperationsAuthenticator = defaultOperationsAuthenticator,
) {
  return async function unsupported(request: Request): Promise<Response> {
    const principal = await authorizePrivateOperations(request, authenticate);
    if (principal === undefined) return operationsPrivateNotFound();
    const response = operationsPrivateError("METHOD_NOT_ALLOWED", 405);
    response.headers.set("allow", "GET, HEAD");
    return response;
  };
}

export const GET = createOperationsSnapshotHandler(async () => {
  const { getOperationsServerContainer } = await import(
    "../../../../../lib/server/operations-container"
  );
  return getOperationsServerContainer().operationsService;
});

const unsupportedMethod = createOperationsUnsupportedMethodHandler();

export const DELETE = unsupportedMethod;
export const OPTIONS = unsupportedMethod;
export const PATCH = unsupportedMethod;
export const POST = unsupportedMethod;
export const PUT = unsupportedMethod;
