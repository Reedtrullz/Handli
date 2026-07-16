import type { DatabaseReadinessProbe } from "../../../lib/server/readiness";

type ProbeProvider = () => DatabaseReadinessProbe | Promise<DatabaseReadinessProbe>;

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

export function createReadyHandler(getProbe: ProbeProvider) {
  return async function GET(request?: Request): Promise<Response> {
    try {
      const probe = await getProbe();
      const result = await probe.check(request?.signal);
      return Response.json(
        {
          database: {
            requiredMigration: result.requiredMigration,
            status: "ok",
          },
          status: "ok",
          version: 1,
        },
        { headers: NO_STORE_HEADERS },
      );
    } catch {
      return Response.json(
        {
          code: "DEPENDENCY_UNAVAILABLE",
          status: "unavailable",
          version: 1,
        },
        { headers: NO_STORE_HEADERS, status: 503 },
      );
    }
  };
}

export const GET = createReadyHandler(async () => {
  const { getServerContainer } = await import("../../../lib/server/container");
  return getServerContainer().readinessProbe;
});
