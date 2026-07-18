import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresIngestionRepository,
  type IngestionFenceVerifier,
} from "./ingestion";
import {
  ingestionWorkerLeaseKey,
  PostgresWorkerLeaseAdapter,
  WorkerLeaseError,
} from "./worker-lease";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${process.pid}-${Date.now()}`;
const ownerPrefix = `lease-test-${nonce}`;

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresWorkerLeaseAdapter integration",
  () => {
    let first: DatabaseConnection;
    let second: DatabaseConnection;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      first = createDatabase(process.env.DATABASE_URL);
      second = createDatabase(process.env.DATABASE_URL);
      await first.sql`delete from worker_leases where owner_id like ${`${ownerPrefix}%`}`;
    });

    afterAll(async () => {
      if (first) {
        await first.sql`delete from worker_leases where owner_id like ${`${ownerPrefix}%`}`;
      }
      await Promise.all([first?.close(), second?.close()]);
    });

    it("grants one of two concurrent contenders using PostgreSQL time", async () => {
      const leaseKey = `test-one-${nonce}`;
      const firstAdapter = new PostgresWorkerLeaseAdapter(first.db);
      const secondAdapter = new PostgresWorkerLeaseAdapter(second.db);
      const contenders = await Promise.all([
        firstAdapter.acquire({
          leaseKey,
          ownerId: `${ownerPrefix}-one-a`,
          ttlMs: 30_000,
        }),
        secondAdapter.acquire({
          leaseKey,
          ownerId: `${ownerPrefix}-one-b`,
          ttlMs: 30_000,
        }),
      ]);
      const winners = contenders.filter((handle) => handle !== undefined);

      expect(winners).toHaveLength(1);
      const [clock] = await first.sql`
        select abs(extract(epoch from (acquired_at - clock_timestamp()))) < 2 as database_clock
        from worker_leases where lease_key = ${leaseKey}
      `;
      expect(clock).toEqual({ database_clock: true });
      await winners[0]!.release();
    });

    it("heartbeats and performs owner-and-generation-conditional release", async () => {
      const leaseKey = `test-heartbeat-${nonce}`;
      const adapter = new PostgresWorkerLeaseAdapter(first.db);
      const handle = (await adapter.acquire({
        leaseKey,
        ownerId: `${ownerPrefix}-heartbeat`,
        ttlMs: 30_000,
      }))!;
      const [before] = await first.sql`
        select expires_at::text as expires_at from worker_leases where lease_key = ${leaseKey}
      `;
      await first.sql`select pg_sleep(0.01)`;

      await handle.heartbeat();
      const [extended] = await first.sql`
        select expires_at > ${before!.expires_at}::timestamptz as extended
        from worker_leases where lease_key = ${leaseKey}
      `;
      expect(extended).toEqual({ extended: true });

      await handle.release();
      const [released] = await first.sql`
        select count(*)::integer as count from worker_leases where lease_key = ${leaseKey}
      `;
      expect(released).toEqual({ count: 0 });
    });

    it("takes over an expired row with a new generation", async () => {
      const leaseKey = `test-expiry-${nonce}`;
      await first.sql`
        insert into worker_leases (lease_key, owner_id, acquired_at, heartbeat_at, expires_at)
        values (
          ${leaseKey},
          ${`${ownerPrefix}-expired`},
          clock_timestamp() - interval '2 minutes',
          clock_timestamp() - interval '90 seconds',
          clock_timestamp() - interval '1 minute'
        )
      `;
      const adapter = new PostgresWorkerLeaseAdapter(second.db);
      const handle = await adapter.acquire({
        leaseKey,
        ownerId: `${ownerPrefix}-takeover`,
        ttlMs: 30_000,
      });

      expect(handle).toBeDefined();
      const [row] = await first.sql`
        select owner_id from worker_leases where lease_key = ${leaseKey}
      `;
      expect(row).toEqual({ owner_id: `${ownerPrefix}-takeover` });
      await handle!.release();
    });

    it("aborts on lease loss and cannot delete the successor owner", async () => {
      const leaseKey = `test-loss-${nonce}`;
      const adapter = new PostgresWorkerLeaseAdapter(first.db);
      const handle = (await adapter.acquire({
        leaseKey,
        ownerId: `${ownerPrefix}-loss-original`,
        ttlMs: 30_000,
      }))!;
      await first.sql`
        with lease_clock as (
          select clock_timestamp() as changed_at
        )
        update worker_leases
        set
          owner_id = ${`${ownerPrefix}-loss-successor`},
          acquired_at = lease_clock.changed_at,
          heartbeat_at = lease_clock.changed_at,
          expires_at = lease_clock.changed_at + interval '30 seconds'
        from lease_clock
        where lease_key = ${leaseKey}
      `;

      await expect(handle.heartbeat()).rejects.toEqual(
        new WorkerLeaseError("LEASE_LOST", "Worker lease ownership was lost"),
      );
      expect(handle.signal.aborted).toBe(true);
      await expect(handle.release()).rejects.toBeInstanceOf(WorkerLeaseError);
      const [row] = await first.sql`
        select owner_id from worker_leases where lease_key = ${leaseKey}
      `;
      expect(row).toEqual({ owner_id: `${ownerPrefix}-loss-successor` });
    });

    it("verifies two jobs under one source fence and rejects it after generation changes", async () => {
      const context = {
        jobId: `integration-job-${nonce}`,
        sourceId: "kassalapp",
      };
      const leaseKey = ingestionWorkerLeaseKey(context);
      const adapter = new PostgresWorkerLeaseAdapter(first.db);
      const handle = (await adapter.acquire({
        leaseKey,
        ownerId: `${ownerPrefix}-fence`,
        ttlMs: 30_000,
      }))!;

      await expect(first.db.transaction(async (transaction) => {
        await adapter.verifyFence(transaction, {
          ...context,
          fenceToken: handle.fenceToken,
        });
      })).resolves.toBeUndefined();
      await expect(first.db.transaction(async (transaction) => {
        await adapter.verifyFence(transaction, {
          ...context,
          jobId: `integration-second-job-${nonce}`,
          fenceToken: handle.fenceToken,
        });
      })).resolves.toBeUndefined();

      await first.sql`
        update worker_leases
        set
          acquired_at = clock_timestamp() - interval '2 minutes',
          heartbeat_at = clock_timestamp() - interval '90 seconds',
          expires_at = clock_timestamp() - interval '1 minute'
        where lease_key = ${leaseKey}
      `;
      await expect(first.db.transaction(async (transaction) => {
        await adapter.verifyFence(transaction, {
          ...context,
          fenceToken: handle.fenceToken,
        });
      })).rejects.toEqual(
        new WorkerLeaseError("STALE_FENCE", "Worker lease fence is stale or invalid"),
      );
    });

    it("keeps heartbeat live during a deliberately slow fenced persistence transaction", async () => {
      const context = {
        jobId: `integration-slow-persistence-${nonce}`,
        sourceId: "kassalapp",
      };
      const leaseKey = ingestionWorkerLeaseKey(context);
      const adapter = new PostgresWorkerLeaseAdapter(first.db);
      const handle = (await adapter.acquire({
        leaseKey,
        ownerId: `${ownerPrefix}-slow-persistence`,
        ttlMs: 3_000,
      }))!;
      let reportSlowStart!: () => void;
      const slowStarted = new Promise<void>((resolve) => { reportSlowStart = resolve; });
      let releaseSlowPersistence!: () => void;
      const continueSlowPersistence = new Promise<void>((resolve) => {
        releaseSlowPersistence = resolve;
      });
      let delayed = false;
      const verifyFence: IngestionFenceVerifier = async (transaction, fenceContext, phase) => {
        await adapter.verifyFence(transaction, fenceContext, phase);
        if (phase === "initial" && fenceContext.ingestionRunId !== undefined && !delayed) {
          delayed = true;
          reportSlowStart();
          await continueSlowPersistence;
        }
      };
      const repository = new PostgresIngestionRepository(first.db, { verifyFence });
      const begun = await repository.beginRun({
        fenceToken: handle.fenceToken,
        jobId: context.jobId,
        runType: "catalog",
        sourceId: context.sourceId,
        startedAt: new Date(),
      });

      const persistence = repository.auditOutcomes(begun.handle, [{
        outcomeState: "unknown",
        reason: "NOT_FOUND",
        recordKind: "product",
        recordedAt: new Date(),
        sourceRecordId: `slow-persistence-${nonce}`,
      }]);
      let persistenceSettled = false;
      void persistence.then(
        () => { persistenceSettled = true; },
        () => { persistenceSettled = true; },
      );

      try {
        await slowStarted;
        const heartbeatDeadline = performance.now() + 2_500;
        let heartbeat: { advanced: boolean } | undefined;
        do {
          [heartbeat] = await second.sql<[{ advanced: boolean }]>`
            select heartbeat_at > acquired_at as advanced
            from worker_leases
            where lease_key = ${leaseKey}
          `;
          if (heartbeat?.advanced) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        } while (performance.now() < heartbeatDeadline);

        expect(heartbeat).toEqual({ advanced: true });
        expect(handle.signal.aborted).toBe(false);
        expect(persistenceSettled).toBe(false);
        releaseSlowPersistence();
        await expect(persistence).resolves.toEqual({ inserted: 1, received: 1 });
        await handle.release();
      } finally {
        releaseSlowPersistence();
        await persistence.catch(() => undefined);
        if (!handle.signal.aborted) {
          await handle.release().catch(() => undefined);
        }
      }
    });

    it("cancels while blocked on a lease row lock", async () => {
      const leaseKey = `test-cancel-${nonce}`;
      await first.sql`
        with lease_clock as (
          select clock_timestamp() as acquired_at
        )
        insert into worker_leases (lease_key, owner_id, acquired_at, heartbeat_at, expires_at)
        select
          ${leaseKey},
          ${`${ownerPrefix}-cancel-incumbent`},
          acquired_at,
          acquired_at,
          acquired_at + interval '30 seconds'
        from lease_clock
      `;
      let reportLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const blocker = first.sql.begin(async (transaction) => {
        await transaction`select lease_key from worker_leases where lease_key = ${leaseKey} for update`;
        reportLocked();
        await release;
      });
      await locked;

      const adapter = new PostgresWorkerLeaseAdapter(second.db, { operationTimeoutMs: 5_000 });
      const controller = new AbortController();
      const acquisition = adapter.acquire({
        leaseKey,
        ownerId: `${ownerPrefix}-cancel-contender`,
        signal: controller.signal,
        ttlMs: 30_000,
      });
      const startedAt = performance.now();

      try {
        setTimeout(() => controller.abort(), 50);
        await expect(acquisition).rejects.toEqual(
          new WorkerLeaseError("CANCELLED", "Worker lease operation cancelled"),
        );
        expect(performance.now() - startedAt).toBeLessThan(750);
      } finally {
        releaseLock();
        await blocker;
      }
    });
  },
);
