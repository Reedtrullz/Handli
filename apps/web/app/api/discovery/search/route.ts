import { z } from "zod";

import {
  DiscoveryRequestCancelledError,
  DiscoveryUnavailableError,
  type DiscoveryServiceContract,
} from "../../../../lib/server/discovery-service";

const searchParamsSchema = z.object({ q: z.string().trim().min(2).max(80) }).strict();
type ServiceProvider = () => DiscoveryServiceContract | Promise<DiscoveryServiceContract>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, { status });
}

export function createDiscoverySearchHandler(getService: ServiceProvider) {
  return async function GET(request: Request): Promise<Response> {
    const params: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      if (params[key] !== undefined) return errorResponse("INVALID_REQUEST", 400);
      params[key] = value;
    }
    const parsed = searchParamsSchema.safeParse(params);
    if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

    try {
      return Response.json(await (await getService()).search(parsed.data.q, request.signal));
    } catch (error) {
      if (error instanceof DiscoveryRequestCancelledError) {
        return errorResponse("REQUEST_CANCELLED", 499);
      }
      if (error instanceof DiscoveryUnavailableError) {
        return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
      }
      return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
    }
  };
}

export const GET = createDiscoverySearchHandler(async () => {
  const { getServerContainer } = await import("../../../../lib/server/container");
  return getServerContainer().discoveryService;
});
