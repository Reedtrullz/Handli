import { publicDiscoveryResponseSchema } from "@handleplan/domain";
import { z } from "zod";

import {
  DiscoveryRequestCancelledError,
  DiscoveryUnavailableError,
  type DiscoveryServiceContract,
} from "../../../../lib/server/discovery-service";
import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
  resolveRequestTimeoutMs,
  type BoundedRequestOptions,
  type RequestLifetime,
} from "../../../../lib/server/request-lifetime";

const searchParamsSchema = z.object({ q: z.string().trim().min(2).max(120).optional() }).strict();
const MAX_RESPONSE_BYTES = 128 * 1024;
type ServiceProvider = () => DiscoveryServiceContract | Promise<DiscoveryServiceContract>;

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

function validatedResponse(value: unknown): Response {
  const parsed = publicDiscoveryResponseSchema.safeParse(value);
  if (!parsed.success) throw new DiscoveryUnavailableError();
  const body = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new DiscoveryUnavailableError();
  }
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function createDiscoverySearchHandler(
  getService: ServiceProvider,
  options: BoundedRequestOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options);
  return async function GET(request: Request): Promise<Response> {
    const params: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      if (params[key] !== undefined) return errorResponse("INVALID_REQUEST", 400);
      params[key] = value;
    }
    const parsed = searchParamsSchema.safeParse(params);
    if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const service = await awaitWithinRequest(getService, lifetime.signal);
      const result = parsed.data.q === undefined
        ? await awaitWithinRequest(
            () => service.browse(lifetime.signal),
            lifetime.signal,
          )
        : await awaitWithinRequest(
            () => service.search(parsed.data.q!, lifetime.signal),
            lifetime.signal,
          );
      return validatedResponse(result);
    } catch (error) {
      const abortResponse = requestAbortResponse(lifetime);
      if (abortResponse !== undefined) return abortResponse;
      if (error instanceof RequestOperationAbortedError) {
        return errorResponse("REQUEST_CANCELLED", 499);
      }
      if (error instanceof DiscoveryRequestCancelledError) {
        return errorResponse("REQUEST_CANCELLED", 499);
      }
      if (error instanceof DiscoveryUnavailableError) {
        return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
      }
      return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
    } finally {
      lifetime.cleanup();
    }
  };
}

export const GET = createDiscoverySearchHandler(async () => {
  const { getServerContainer } = await import("../../../../lib/server/container");
  return getServerContainer().discoveryService;
});
