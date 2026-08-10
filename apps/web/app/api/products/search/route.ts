import {
  PublicCatalogIndexReaderError,
  type PublicCatalogIndexReader,
} from "@handleplan/db/public-catalog-index-reader";
import {
  publicCatalogProductFromSummary,
  publicProductSearchResponseSchema,
} from "@handleplan/domain";
import { z } from "zod";

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

const searchParamsSchema = z
  .object({ q: z.string().trim().min(2).max(120) })
  .strict();
const SEARCH_LIMIT = 20;
const MAX_RESPONSE_BYTES = 128 * 1024;

type CatalogProvider = () => PublicCatalogIndexReader | Promise<PublicCatalogIndexReader>;

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
  const parsed = publicProductSearchResponseSchema.safeParse(value);
  if (!parsed.success) throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  const body = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  }
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function createSearchHandler(
  getCatalog: CatalogProvider,
  now: () => Date = () => new Date(),
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
    if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

    const lifetime = createRequestLifetime(request.signal, timeoutMs);
    try {
      const products = await awaitWithinRequest(
        () => runControlledPublicApiOperation(
          options,
          "products-search",
          { query: parsed.data.q },
          lifetime.signal,
          async (operationSignal) => {
            const catalog = await awaitWithinRequest(getCatalog, operationSignal);
            return catalog.search(
              parsed.data.q,
              SEARCH_LIMIT,
              now(),
              operationSignal,
            );
          },
        ),
        lifetime.signal,
      );
      return validatedResponse({
        contractVersion: 1,
        products: products.map(publicCatalogProductFromSummary),
      });
    } catch (error) {
      const abortResponse = requestAbortResponse(lifetime);
      if (abortResponse !== undefined) return abortResponse;
      const controlledResponse = publicApiRuntimeControlResponse(error);
      if (controlledResponse !== undefined) return controlledResponse;
      if (error instanceof RequestOperationAbortedError) {
        return errorResponse("REQUEST_CANCELLED", 499);
      }
      if (error instanceof PublicCatalogIndexReaderError) {
        if (error.code === "INVALID_REQUEST") return errorResponse("INVALID_REQUEST", 400);
        if (error.code === "CANCELLED") return errorResponse("REQUEST_CANCELLED", 499);
      }
      return errorResponse("CATALOG_UNAVAILABLE", 503);
    } finally {
      lifetime.cleanup();
    }
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerContainer } = await import("../../../../lib/server/container");
  const container = getServerContainer();
  return createSearchHandler(
    () => container.publicCatalogIndex,
    () => new Date(),
    { runtimeControls: container.publicApiRuntimeControls },
  )(request);
}
