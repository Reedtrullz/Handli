import {
  PublicCatalogIndexReaderError,
  type PublicCatalogIndexReader,
} from "@handleplan/db/public-catalog-index-reader";
import {
  publicCatalogProductFromSummary,
  publicProductSearchResponseSchema,
} from "@handleplan/domain";
import { z } from "zod";

const searchParamsSchema = z
  .object({ q: z.string().trim().min(2).max(120) })
  .strict();
const SEARCH_LIMIT = 20;
const MAX_RESPONSE_BYTES = 128 * 1024;

type CatalogProvider = () => PublicCatalogIndexReader | Promise<PublicCatalogIndexReader>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, { status });
}

function validatedResponse(value: unknown): Response {
  const parsed = publicProductSearchResponseSchema.safeParse(value);
  if (!parsed.success) throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  const body = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new PublicCatalogIndexReaderError("UNAVAILABLE");
  }
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function createSearchHandler(
  getCatalog: CatalogProvider,
  now: () => Date = () => new Date(),
) {
  return async function GET(request: Request): Promise<Response> {
    const params: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      if (params[key] !== undefined) return errorResponse("INVALID_REQUEST", 400);
      params[key] = value;
    }
    const parsed = searchParamsSchema.safeParse(params);
    if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

    try {
      const catalog = await getCatalog();
      const products = await catalog.search(
        parsed.data.q,
        SEARCH_LIMIT,
        now(),
        request.signal,
      );
      return validatedResponse({
        contractVersion: 1,
        products: products.map(publicCatalogProductFromSummary),
      });
    } catch (error) {
      if (error instanceof PublicCatalogIndexReaderError) {
        if (error.code === "INVALID_REQUEST") return errorResponse("INVALID_REQUEST", 400);
        if (error.code === "CANCELLED") return errorResponse("REQUEST_CANCELLED", 499);
      }
      return errorResponse("CATALOG_UNAVAILABLE", 503);
    }
  };
}

export const GET = createSearchHandler(async () => {
  const { getServerContainer } = await import("../../../../lib/server/container");
  return getServerContainer().publicCatalogIndex;
});
