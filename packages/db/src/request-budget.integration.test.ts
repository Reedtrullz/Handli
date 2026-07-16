import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresProviderRequestBudget,
  ProviderRequestBudgetError,
} from "./request-budget";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const providerKey = `test-budget-${process.pid}-${Date.now()}`;
const advisoryLockSeed = 7_229_164_302;

describe.skipIf(!runDatabaseIntegration)("PostgresProviderRequestBudget integration", () => {
  let first: DatabaseConnection;
  let second: DatabaseConnection;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    }
    first = createDatabase(process.env.DATABASE_URL);
    second = createDatabase(process.env.DATABASE_URL);
    await first.sql`
      delete from provider_request_budget_events where provider_key = ${providerKey}
    `;
  });

  afterAll(async () => {
    if (first) {
      await first.sql`
        delete from provider_request_budget_events where provider_key = ${providerKey}
      `;
    }
    await Promise.all([first?.close(), second?.close()]);
  });

  it("admits exactly N of N+1 immediate claims across independent coordinators", async () => {
    const options = {
      limit: 3,
      // The deadline includes pool checkout and advisory-lock acquisition. Keep
      // enough headroom for this concurrency assertion when the full database
      // suite is sharing PostgreSQL; the dedicated max-wait tests below retain
      // the tight timing bounds.
      maxWaitMs: 5_000,
      providerKey,
      windowMs: 60_000,
    } as const;
    const firstBudget = new PostgresProviderRequestBudget(first.db, options);
    const secondBudget = new PostgresProviderRequestBudget(second.db, options);

    await first.sql`
      insert into provider_request_budget_events (provider_key, claimed_at)
      values (${providerKey}, clock_timestamp() - interval '2 minutes')
    `;

    const results = await Promise.allSettled([
      firstBudget.acquire(),
      secondBudget.acquire(),
      firstBudget.acquire(),
      secondBudget.acquire(),
    ]);
    const accepted = results.filter(({ status }) => status === "fulfilled");
    const rejected = results.filter(({ status }) => status === "rejected");

    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        code: "MAX_WAIT_EXCEEDED",
        message: "Provider request budget wait limit exceeded",
        name: "ProviderRequestBudgetError",
      },
    });

    const [state] = await first.sql`
      select
        count(*)::integer as attempt_count,
        bool_and(
          claimed_at > clock_timestamp() - interval '60 seconds'
        ) as all_current
      from provider_request_budget_events
      where provider_key = ${providerKey}
    `;
    expect(state).toEqual({ all_current: true, attempt_count: 3 });
  }, 10_000);

  it("cancels a database advisory-lock wait", async () => {
    const cancellationKey = `${providerKey}-cancel`;
    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = first.sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(
          hashtextextended(${cancellationKey}, ${advisoryLockSeed})
        )
      `;
      reportLocked();
      await release;
    });

    await locked;
    const budget = new PostgresProviderRequestBudget(second.db, {
      limit: 1,
      maxWaitMs: 60_000,
      providerKey: cancellationKey,
      windowMs: 60_000,
    });
    const controller = new AbortController();
    const acquisition = budget.acquire(controller.signal);

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(acquisition).rejects.toEqual(
        new ProviderRequestBudgetError(
          "CANCELLED",
          "Provider request budget acquisition cancelled",
        ),
      );
    } finally {
      releaseLock();
      await blocker;
    }
  });

  it("applies maxWaitMs while blocked on the database advisory lock", async () => {
    const maxWaitKey = `${providerKey}-max-wait`;
    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = first.sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(
          hashtextextended(${maxWaitKey}, ${advisoryLockSeed})
        )
      `;
      reportLocked();
      await release;
    });

    await locked;
    const budget = new PostgresProviderRequestBudget(second.db, {
      limit: 1,
      maxWaitMs: 100,
      providerKey: maxWaitKey,
      windowMs: 60_000,
    });
    const startedAt = performance.now();
    const watchdog = setTimeout(releaseLock, 1_000);

    try {
      await expect(budget.acquire()).rejects.toEqual(
        new ProviderRequestBudgetError(
          "MAX_WAIT_EXCEEDED",
          "Provider request budget wait limit exceeded",
        ),
      );
      expect(performance.now() - startedAt).toBeLessThan(750);
    } finally {
      clearTimeout(watchdog);
      releaseLock();
      await blocker;
    }
  });
});
