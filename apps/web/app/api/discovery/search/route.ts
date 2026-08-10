import {
  PUBLIC_DISCOVERY_PAGE_SIZE_MAX,
  publicDiscoveryChainFilterSchema,
  publicDiscoveryCursorSchema,
  publicDiscoveryRequestV1Schema,
  publicDiscoveryResponseSchemaFor,
  publicDiscoveryTypeFilterSchema,
  type PublicDiscoveryRequestV1,
} from "@handleplan/domain";
import { z } from "zod";

import {
  DiscoveryRequestCancelledError,
  DiscoveryUnavailableError,
  type DiscoveryServiceContract,
} from "../../../../lib/server/discovery-service";
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
import { allowedLaunchMarketFromQueryValue } from "../../../../lib/launch-markets";

const searchParamsSchema = z
  .object({
    category: z.string().regex(/^category:[0-9a-f]{64}$/u).optional(),
    chain: publicDiscoveryChainFilterSchema.optional(),
    cursor: publicDiscoveryCursorSchema.optional(),
    market: z.string().min(1).max(120),
    pageSize: z.coerce.number().int().min(1).max(PUBLIC_DISCOVERY_PAGE_SIZE_MAX).optional(),
    q: z.string().trim().min(2).max(120).optional(),
    type: publicDiscoveryTypeFilterSchema.optional(),
  })
  .strict()
  .refine(({ category, q }) => category === undefined || q === undefined, {
    message: "Text and category filters are mutually exclusive",
  });
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

function validatedResponse(value: unknown, request: PublicDiscoveryRequestV1): Response {
  const parsed = publicDiscoveryResponseSchemaFor(request).safeParse(value);
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
  options: ControlledPublicApiRouteOptions = {},
) {
  const timeoutMs = resolveRequestTimeoutMs(options);
  return async function GET(request: Request): Promise<Response> {
    const params: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      if (params[key] !== undefined) return errorResponse("INVALID_REQUEST", 400);
      params[key] = value;
    }
    const parsed = searchParamsSchema.safeParse(params);
    if (!parsed.success) {
      return params.market === undefined
        ? errorResponse("MARKET_CONTEXT_REQUIRED", 400)
        : errorResponse("INVALID_REQUEST", 400);
    }
    const marketContext = allowedLaunchMarketFromQueryValue(parsed.data.market);
    if (marketContext === undefined) return errorResponse("MARKET_UNAVAILABLE", 422);
    const discoveryRequest = publicDiscoveryRequestV1Schema.safeParse({
      ...(parsed.data.category === undefined ? {} : { categoryId: parsed.data.category }),
      chain: parsed.data.chain ?? "all",
      contractVersion: 1,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      marketContext,
      pageSize: parsed.data.pageSize ?? PUBLIC_DISCOVERY_PAGE_SIZE_MAX,
      ...(parsed.data.q === undefined ? {} : { query: parsed.data.q }),
      resultType: parsed.data.type ?? "all",
    });
    if (!discoveryRequest.success) return errorResponse("INVALID_REQUEST", 400);

    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const result = await awaitWithinRequest(
        () => runControlledPublicApiOperation(
          options,
          "discovery-search",
          discoveryRequest.data,
          lifetime.signal,
          async (operationSignal) => {
            const service = await awaitWithinRequest(getService, operationSignal);
            return service.discover(discoveryRequest.data, operationSignal);
          },
        ),
        lifetime.signal,
      );
      return validatedResponse(result, discoveryRequest.data);
    } catch (error) {
      const abortResponse = requestAbortResponse(lifetime);
      if (abortResponse !== undefined) return abortResponse;
      const controlledResponse = publicApiRuntimeControlResponse(error);
      if (controlledResponse !== undefined) return controlledResponse;
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

export async function GET(request: Request): Promise<Response> {
  const { getServerContainer } = await import("../../../../lib/server/container");
  const container = getServerContainer();
  return createDiscoverySearchHandler(
    () => container.discoveryService,
    { runtimeControls: container.publicApiRuntimeControls },
  )(request);
}
