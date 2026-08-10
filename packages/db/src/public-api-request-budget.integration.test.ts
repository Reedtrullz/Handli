import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresPublicApiRequestBudget,
} from "./public-api-request-budget";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const advisoryLockSeed = 7_229_164_303;

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresPublicApiRequestBudget integration",
  () => {
    let first: DatabaseConnection;
    let second: DatabaseConnection;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      first = createDatabase(process.env.DATABASE_URL);
      second = createDatabase(process.env.DATABASE_URL);
    });

    afterAll(async () => {
      if (first !== undefined) {
        await first.sql`
          delete from public_api_request_budget_events
          where route_key in ('locations-search', 'plans-travel')
        `;
      }
      await Promise.all([first?.close(), second?.close()]);
    });

    it("admits exactly one final claim across two independent coordinators", async () => {
      await first.sql`
        delete from public_api_request_budget_events
        where route_key = 'locations-search'
      `;
      await first.sql`
        insert into public_api_request_budget_events (route_key, claimed_at)
        select 'locations-search', clock_timestamp()
        from generate_series(1, 59)
      `;
      const results = await Promise.all([
        new PostgresPublicApiRequestBudget(first.db).claim("locations-search"),
        new PostgresPublicApiRequestBudget(second.db).claim("locations-search"),
      ]);
      expect(results.filter(({ admitted }) => admitted)).toHaveLength(1);
      expect(results.filter(({ admitted }) => !admitted)).toEqual([
        expect.objectContaining({ retryAfterSeconds: expect.any(Number) }),
      ]);

      const [state] = await first.sql<{ count: number }[]>`
        select count(*)::integer as count
        from public_api_request_budget_events
        where route_key = 'locations-search'
      `;
      expect(state?.count).toBe(60);
    });

    it("prunes expired events and returns bounded Retry-After", async () => {
      await first.sql`
        delete from public_api_request_budget_events
        where route_key = 'plans-travel'
      `;
      await first.sql`
        insert into public_api_request_budget_events (route_key, claimed_at)
        select 'plans-travel', clock_timestamp()
          - case when value = 1 then interval '2 minutes' else interval '0 seconds' end
        from generate_series(1, 60) as series(value)
      `;
      const firstDecision = await new PostgresPublicApiRequestBudget(first.db)
        .claim("plans-travel");
      expect(firstDecision).toEqual({ admitted: true, retryAfterSeconds: 0 });
      const denied = await new PostgresPublicApiRequestBudget(second.db)
        .claim("plans-travel");
      expect(denied.admitted).toBe(false);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it("fails closed immediately while another coordinator holds the route lock", async () => {
      let releaseLock!: () => void;
      let reportLocked!: () => void;
      const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const blocker = first.sql.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(
            hashtextextended('plans-travel', ${advisoryLockSeed})
          )
        `;
        reportLocked();
        await release;
      });
      await locked;

      const startedAt = performance.now();
      try {
        await expect(new PostgresPublicApiRequestBudget(second.db).claim("plans-travel"))
          .resolves.toEqual({ admitted: false, retryAfterSeconds: 1 });
        expect(performance.now() - startedAt).toBeLessThan(750);
      } finally {
        releaseLock();
        await blocker;
      }
    });
  },
);
