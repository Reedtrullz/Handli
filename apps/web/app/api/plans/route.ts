import {
  planApiRequestSchema,
  PlanRequestCancelledError,
  PriceDataUnavailableError,
  type PlanServiceContract,
} from "../../../lib/server/plan-service";

const MAX_BODY_BYTES = 64 * 1024;

export const PLAN_CAVEATS = [
  "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
  "Medlemspriser og kundeavis-tilbud er ikke med i denne beregningen.",
] as const;

type ServiceProvider = () => PlanServiceContract | Promise<PlanServiceContract>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ code }, { status });
}

async function readJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: errorResponse("UNSUPPORTED_MEDIA_TYPE", 415) };
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse("REQUEST_TOO_LARGE", 413) };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse("REQUEST_TOO_LARGE", 413) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400) };
  }
}

export function createPlansHandler(
  getService: ServiceProvider,
  now: () => Date = () => new Date(),
) {
  return async function POST(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = planApiRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);

    try {
      const service = await getService();
      const result = await service.calculate(parsed.data, request.signal);
      return Response.json({
        caveats: PLAN_CAVEATS,
        generatedAt: now().toISOString(),
        plans: result.plans,
      });
    } catch (error) {
      if (error instanceof PlanRequestCancelledError) {
        return errorResponse("REQUEST_CANCELLED", 499);
      }
      if (error instanceof PriceDataUnavailableError) {
        return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
      }
      return errorResponse("PRICE_DATA_UNAVAILABLE", 503);
    }
  };
}

export const POST = createPlansHandler(async () => {
  const { getServerContainer } = await import("../../../lib/server/container");
  return getServerContainer().planService;
});
