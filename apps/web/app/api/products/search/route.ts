import {
  KassalappGatewayError,
  type KassalappGateway,
} from "@handleplan/kassalapp";
import { z } from "zod";

const searchParamsSchema = z
  .object({ q: z.string().trim().min(2).max(120) })
  .strict();
const SEARCH_LIMIT = 20;

type GatewayProvider = () => KassalappGateway | Promise<KassalappGateway>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, { status });
}

export function createSearchHandler(getGateway: GatewayProvider) {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (params[key] !== undefined) return errorResponse("INVALID_REQUEST", 400);
      params[key] = value;
    }
    const parsed = searchParamsSchema.safeParse(params);
    if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

    try {
      const gateway = await getGateway();
      const products = await gateway.searchProducts(
        parsed.data.q,
        SEARCH_LIMIT,
        request.signal,
      );
      return Response.json({ products });
    } catch (error) {
      if (error instanceof KassalappGatewayError) {
        switch (error.code) {
          case "INVALID_REQUEST":
            return errorResponse("INVALID_REQUEST", 400);
          case "CANCELLED":
            return errorResponse("REQUEST_CANCELLED", 499);
          case "TIMEOUT":
            return errorResponse("PRICE_DATA_TIMEOUT", 504);
          case "INVALID_RESPONSE":
          case "UPSTREAM_UNAVAILABLE":
            return errorResponse("PRICE_DATA_UNAVAILABLE", 502);
        }
      }
      return errorResponse("PRICE_DATA_UNAVAILABLE", 502);
    }
  };
}

export const GET = createSearchHandler(async () => {
  const { getServerContainer } = await import("../../../../lib/server/container");
  return getServerContainer().gateway;
});
