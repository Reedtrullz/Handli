import type { HandleplanDatabase } from "./client";

export const PUBLIC_API_ROUTE_KEYS = [
  "discovery-impact",
  "discovery-search",
  "locations-current",
  "locations-search",
  "plan-candidates",
  "plans",
  "plans-travel",
  "products-search",
  "source-status",
] as const;

export type PublicApiRouteKey = typeof PUBLIC_API_ROUTE_KEYS[number];

export interface PublicApiRequestBudgetDecision {
  admitted: boolean;
  retryAfterSeconds: number;
}

export interface PublicApiRequestBudgetContract {
  claim(
    routeKey: PublicApiRouteKey,
    signal?: AbortSignal,
  ): Promise<PublicApiRequestBudgetDecision>;
}

export type PublicApiRequestBudgetErrorCode = "CANCELLED" | "UNAVAILABLE";

export class PublicApiRequestBudgetError extends Error {
  constructor(readonly code: PublicApiRequestBudgetErrorCode) {
    super(`Public API request budget failed: ${code}`);
    this.name = "PublicApiRequestBudgetError";
  }
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

function isRouteKey(value: string): value is PublicApiRouteKey {
  return (PUBLIC_API_ROUTE_KEYS as readonly string[]).includes(value);
}

function cancelled(): PublicApiRequestBudgetError {
  return new PublicApiRequestBudgetError("CANCELLED");
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelled();
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Fast, application-global admission control. PostgreSQL owns the fixed route
 * policies and serializes claims; the web role receives only EXECUTE on the
 * SECURITY DEFINER function, never access to the ephemeral event table.
 */
export class PostgresPublicApiRequestBudget implements PublicApiRequestBudgetContract {
  constructor(private readonly db: HandleplanDatabase) {}

  async claim(
    routeKey: PublicApiRouteKey,
    signal?: AbortSignal,
  ): Promise<PublicApiRequestBudgetDecision> {
    if (!isRouteKey(routeKey)) {
      // Defensive runtime validation keeps arbitrary values away from the DB
      // even if an untyped caller bypasses the TypeScript union.
      throw new TypeError("routeKey must be a fixed public API route key");
    }
    if (signal?.aborted) throw cancelled();

    try {
      const rows = await awaitAbortable(
        this.db.$client<{
          admitted: boolean;
          retry_after_seconds: number;
        }[]>`
          select admitted, retry_after_seconds
          from public.claim_public_api_request_budget(${routeKey})
        `,
        signal,
      );
      if (
        rows.length !== 1
        || typeof rows[0]?.admitted !== "boolean"
        || !Number.isSafeInteger(rows[0]?.retry_after_seconds)
        || rows[0].retry_after_seconds < 0
        || rows[0].retry_after_seconds > 60
        || (rows[0].admitted && rows[0].retry_after_seconds !== 0)
        || (!rows[0].admitted && rows[0].retry_after_seconds < 1)
      ) {
        throw new PublicApiRequestBudgetError("UNAVAILABLE");
      }
      return {
        admitted: rows[0].admitted,
        retryAfterSeconds: rows[0].retry_after_seconds,
      };
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof PublicApiRequestBudgetError) throw error;
      // Never copy a driver/backend message into an application-visible error.
      throw new PublicApiRequestBudgetError("UNAVAILABLE");
    }
  }
}

/** Fake-mode composition still exercises route/coalescing behavior without DB. */
export class PermissivePublicApiRequestBudget implements PublicApiRequestBudgetContract {
  async claim(
    _routeKey: PublicApiRouteKey,
    signal?: AbortSignal,
  ): Promise<PublicApiRequestBudgetDecision> {
    if (signal?.aborted) throw cancelled();
    return { admitted: true, retryAfterSeconds: 0 };
  }
}
