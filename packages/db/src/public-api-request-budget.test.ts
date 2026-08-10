import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  PermissivePublicApiRequestBudget,
  PostgresPublicApiRequestBudget,
  PublicApiRequestBudgetError,
} from "./public-api-request-budget";

type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function resolvedQuery(rows: unknown[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function databaseWith(factory: () => TestQuery) {
  const captures: { parameters: unknown[]; sql: string }[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return factory();
  };
  return {
    captures,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

describe("PostgresPublicApiRequestBudget", () => {
  it("calls only the fixed-policy function and accepts a bounded decision", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([{
      admitted: false,
      retry_after_seconds: 17,
    }]));

    await expect(new PostgresPublicApiRequestBudget(db).claim("plans-travel"))
      .resolves.toEqual({ admitted: false, retryAfterSeconds: 17 });
    expect(captures).toEqual([{
      parameters: ["plans-travel"],
      sql: expect.stringContaining("from public.claim_public_api_request_budget(?)"),
    }]);
    expect(captures[0]?.sql).not.toMatch(/insert|delete|public_api_request_budget_events/iu);
  });

  it("rejects an untyped route before a query without echoing it", async () => {
    const sentinel = "address=Secretveien 42&token=private";
    const { captures, db } = databaseWith(() => resolvedQuery([]));
    await expect(
      new PostgresPublicApiRequestBudget(db).claim(sentinel as "plans"),
    ).rejects.toThrow("routeKey must be a fixed public API route key");
    expect(captures).toHaveLength(0);
  });

  it("fails closed for malformed, contradictory and overflow-shaped rows", async () => {
    const invalidRows = [
      [],
      [{ admitted: true, retry_after_seconds: 0 }, { admitted: true, retry_after_seconds: 0 }],
      [{ admitted: "true", retry_after_seconds: 0 }],
      [{ admitted: true, retry_after_seconds: 1 }],
      [{ admitted: false, retry_after_seconds: 0 }],
      [{ admitted: false, retry_after_seconds: 61 }],
      [{ admitted: false, retry_after_seconds: Number.MAX_SAFE_INTEGER + 1 }],
    ];
    for (const rows of invalidRows) {
      const { db } = databaseWith(() => resolvedQuery(rows));
      await expect(new PostgresPublicApiRequestBudget(db).claim("plans"))
        .rejects.toEqual(new PublicApiRequestBudgetError("UNAVAILABLE"));
    }
  });

  it("cancels a pending database claim and normalizes backend failures", async () => {
    let rejectPending!: (error: unknown) => void;
    const pending = Object.assign(new Promise((_resolve, reject) => {
      rejectPending = reject;
    }), {
      cancel: vi.fn(() => rejectPending(new Error("db contained address sentinel"))),
    }) as TestQuery;
    const cancelledDb = databaseWith(() => pending);
    const controller = new AbortController();
    const claim = new PostgresPublicApiRequestBudget(cancelledDb.db)
      .claim("discovery-search", controller.signal);
    controller.abort();
    await expect(claim).rejects.toEqual(new PublicApiRequestBudgetError("CANCELLED"));
    expect(pending.cancel).toHaveBeenCalledOnce();

    const failedDb = databaseWith(() => {
      const rejected = Promise.reject(
        new Error("query=private basket=secret coordinate=59.9,10.7"),
      ) as TestQuery;
      rejected.cancel = vi.fn();
      return rejected;
    });
    const failure = await new PostgresPublicApiRequestBudget(failedDb.db)
      .claim("locations-search").catch((error: unknown) => error);
    expect(failure).toEqual(new PublicApiRequestBudgetError("UNAVAILABLE"));
    expect(String(failure)).not.toMatch(/private|basket|coordinate|59\.9/iu);
  });

  it("keeps fake mode permissive but cancellation-aware", async () => {
    const budget = new PermissivePublicApiRequestBudget();
    await expect(budget.claim("plans")).resolves.toEqual({
      admitted: true,
      retryAfterSeconds: 0,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(budget.claim("plans", controller.signal))
      .rejects.toEqual(new PublicApiRequestBudgetError("CANCELLED"));
  });
});
