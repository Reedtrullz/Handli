import type { DatabaseReadinessProbe } from "../../../lib/server/readiness";
import {
  noopOperationalEventLogger,
  stdoutOperationalEventLogger,
  type OperationalEventLogger,
} from "../../../lib/server/operational-events";

type ProbeProvider = () => DatabaseReadinessProbe | Promise<DatabaseReadinessProbe>;

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

function recordReadiness(
  events: OperationalEventLogger,
  outcome: "ok" | "unavailable",
): void {
  try {
    events.dependencyReadinessChecked(outcome);
  } catch {
    // A telemetry-export failure must not change the sanitized readiness contract.
  }
}

export function createReadyHandler(
  getProbe: ProbeProvider,
  events: OperationalEventLogger = noopOperationalEventLogger,
) {
  return async function GET(request?: Request): Promise<Response> {
    try {
      const probe = await getProbe();
      const result = await probe.check(request?.signal);
      recordReadiness(events, "ok");
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
      recordReadiness(events, "unavailable");
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
}, stdoutOperationalEventLogger);
