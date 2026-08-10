import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PgDialect } from "drizzle-orm/pg-core";

import type { HandleplanDatabase } from "./client";
import type { IngestionTransaction } from "./ingestion";
import {
  ingestionWorkerLeaseKey,
  PostgresWorkerLeaseAdapter,
  type PostgresWorkerLeaseAdapterOptions,
  WorkerLeaseError,
} from "./worker-lease";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ScriptedLeaseAdapter extends PostgresWorkerLeaseAdapter {
  claimCalls = 0;
  claimImplementation: () => Promise<string | undefined> = async () =>
    "2026-07-16 12:00:00.123456+00";
  fenceCurrent = true;
  fenceCommitLocks: boolean[] = [];
  fenceLockCalls = 0;
  releaseCalls = 0;
  releaseImplementation: () => Promise<boolean> = async () => true;
  renewCalls = 0;
  renewImplementation: () => Promise<boolean> = async () => true;

  constructor(options: PostgresWorkerLeaseAdapterOptions = {}) {
    super({} as HandleplanDatabase, options);
  }

  protected override async claimLease(): Promise<string | undefined> {
    this.claimCalls += 1;
    return this.claimImplementation();
  }

  protected override async lockCurrentFence(
    _transaction: IngestionTransaction,
    _identity: unknown,
    lockForCommit = true,
  ): Promise<boolean> {
    this.fenceLockCalls += 1;
    this.fenceCommitLocks.push(lockForCommit);
    return this.fenceCurrent;
  }

  protected override async releaseLease(): Promise<boolean> {
    this.releaseCalls += 1;
    return this.releaseImplementation();
  }

  protected override async renewLease(): Promise<boolean> {
    this.renewCalls += 1;
    return this.renewImplementation();
  }
}

const acquireInput = {
  leaseKey: "ingestion:test-lease",
  ownerId: "worker-a",
  ttlMs: 300,
} as const;

describe("PostgresWorkerLeaseAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates bounded identities and TTL before querying", async () => {
    const adapter = new ScriptedLeaseAdapter();
    const invalid = [
      { ...acquireInput, leaseKey: "" },
      { ...acquireInput, leaseKey: "x".repeat(121) },
      { ...acquireInput, ownerId: "" },
      { ...acquireInput, ownerId: "x".repeat(161) },
      { ...acquireInput, ttlMs: 2 },
      { ...acquireInput, ttlMs: 86_400_001 },
    ];

    for (const input of invalid) {
      await expect(adapter.acquire(input)).rejects.toBeInstanceOf(TypeError);
    }
    expect(adapter.claimCalls).toBe(0);
  });

  it("stops before querying when acquisition is already cancelled", async () => {
    const controller = new AbortController();
    const adapter = new ScriptedLeaseAdapter();
    controller.abort("private reason");

    await expect(adapter.acquire({ ...acquireInput, signal: controller.signal })).rejects.toEqual(
      new WorkerLeaseError("CANCELLED", "Worker lease operation cancelled"),
    );
    expect(adapter.claimCalls).toBe(0);
  });

  it("bounds an acquisition even when the underlying operation does not settle", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const adapter = new ScriptedLeaseAdapter({ operationTimeoutMs: 5 });
    adapter.claimImplementation = async () => await new Promise(() => {});

    const acquisition = adapter.acquire(acquireInput);
    expect(
      (setTimeoutSpy.mock.results[0]?.value as { hasRef?: () => boolean } | undefined)?.hasRef?.(),
    ).toBe(false);
    const timedOut = expect(acquisition).rejects.toEqual(
      new WorkerLeaseError("OPERATION_TIMEOUT", "Worker lease operation timed out"),
    );
    await vi.advanceTimersByTimeAsync(5);

    await timedOut;
  });

  it("returns undefined when the database does not grant the lease", async () => {
    const adapter = new ScriptedLeaseAdapter();
    adapter.claimImplementation = async () => undefined;

    await expect(adapter.acquire(acquireInput)).resolves.toBeUndefined();
  });

  it("auto-heartbeats at one third of the TTL and releases cleanly", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const adapter = new ScriptedLeaseAdapter();
    const handle = await adapter.acquire(acquireInput);
    expect(handle).toBeDefined();
    expect(handle?.fenceToken).not.toContain(acquireInput.ownerId);
    expect(handle?.signal.aborted).toBe(false);
    expect(
      (setTimeoutSpy.mock.results[1]?.value as { hasRef?: () => boolean } | undefined)?.hasRef?.(),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(99);
    expect(adapter.renewCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.renewCalls).toBe(1);

    await handle?.release();
    expect(adapter.releaseCalls).toBe(1);
    expect(handle?.signal.aborted).toBe(true);
  });

  it("serializes explicit heartbeats and makes release join the active renewal", async () => {
    const adapter = new ScriptedLeaseAdapter();
    const renewal = deferred<boolean>();
    adapter.renewImplementation = async () => renewal.promise;
    const handle = (await adapter.acquire({ ...acquireInput, ttlMs: 60_000 }))!;

    const first = handle.heartbeat();
    const second = handle.heartbeat();
    const release = handle.release();
    await Promise.resolve();

    expect(adapter.renewCalls).toBe(1);
    expect(adapter.releaseCalls).toBe(0);
    renewal.resolve(true);
    await Promise.all([first, second, release]);
    expect(adapter.releaseCalls).toBe(1);
  });

  it("aborts the handle signal when owner-conditional renewal loses the lease", async () => {
    const adapter = new ScriptedLeaseAdapter();
    adapter.renewImplementation = async () => false;
    const handle = (await adapter.acquire(acquireInput))!;

    await expect(handle.heartbeat()).rejects.toEqual(
      new WorkerLeaseError("LEASE_LOST", "Worker lease ownership was lost"),
    );
    expect(handle.signal.aborted).toBe(true);
  });

  it("fails closed when owner-conditional release no longer matches", async () => {
    const adapter = new ScriptedLeaseAdapter();
    adapter.releaseImplementation = async () => false;
    const handle = (await adapter.acquire(acquireInput))!;

    await expect(handle.release()).rejects.toEqual(
      new WorkerLeaseError("LEASE_LOST", "Worker lease ownership was lost"),
    );
    expect(handle.signal.aborted).toBe(true);
  });

  it("binds ingestion fences to the source lease while allowing multiple jobs", async () => {
    const context = { jobId: "job-catalog-1", sourceId: "kassalapp" };
    const adapter = new ScriptedLeaseAdapter();
    const handle = (await adapter.acquire({
      ...acquireInput,
      leaseKey: ingestionWorkerLeaseKey(context),
      ttlMs: 60_000,
    }))!;

    await expect(adapter.verifyFence({} as never, {
      ...context,
      fenceToken: handle.fenceToken,
    })).resolves.toBeUndefined();
    expect(adapter.fenceLockCalls).toBe(1);
    expect(adapter.fenceCommitLocks).toEqual([false]);

    await expect(adapter.verifyFence({} as never, {
      ...context,
      jobId: "job-catalog-2",
      fenceToken: handle.fenceToken,
    }, "before-commit")).resolves.toBeUndefined();
    expect(adapter.fenceLockCalls).toBe(2);
    expect(adapter.fenceCommitLocks).toEqual([false, true]);

    await expect(adapter.verifyFence({} as never, {
      ...context,
      sourceId: "oda",
      fenceToken: handle.fenceToken,
    })).rejects.toEqual(
      new WorkerLeaseError("STALE_FENCE", "Worker lease fence is stale or invalid"),
    );
    expect(adapter.fenceLockCalls).toBe(2);

    const finalCharacter = handle.fenceToken.endsWith("a") ? "b" : "a";
    const tampered = `${handle.fenceToken.slice(0, -1)}${finalCharacter}`;
    await expect(adapter.verifyFence({} as never, {
      ...context,
      fenceToken: tampered,
    })).rejects.toBeInstanceOf(WorkerLeaseError);
    expect(adapter.fenceLockCalls).toBe(2);

    const invalidGeneration = `wlf1.${Buffer.from(JSON.stringify({
      g: "2026-99-99 99:99:99+99",
      k: ingestionWorkerLeaseKey(context),
      o: acquireInput.ownerId,
      v: 1,
    }), "utf8").toString("base64url")}`;
    await expect(adapter.verifyFence({} as never, {
      ...context,
      fenceToken: invalidGeneration,
    })).rejects.toEqual(
      new WorkerLeaseError("STALE_FENCE", "Worker lease fence is stale or invalid"),
    );
    expect(adapter.fenceLockCalls).toBe(2);

    adapter.fenceCurrent = false;
    await expect(adapter.verifyFence({} as never, {
      ...context,
      fenceToken: handle.fenceToken,
    })).rejects.toEqual(
      new WorkerLeaseError("STALE_FENCE", "Worker lease fence is stale or invalid"),
    );
  });

  it("checks without a row lock, then bounds the short before-commit fence lock", async () => {
    const timeoutSql: unknown[] = [];
    const limit = vi.fn(async () => [{ leaseKey: "present" }]);
    const transaction = {
      execute: vi.fn(async (query: unknown) => {
        timeoutSql.push(query);
        return [];
      }),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit,
            for: () => ({ limit }),
          }),
        }),
      })),
    };
    const adapter = new PostgresWorkerLeaseAdapter({} as HandleplanDatabase, {
      operationTimeoutMs: 1_234,
    });
    const context = { jobId: "job-a", sourceId: "kassalapp" };
    const tokenIssuer = new ScriptedLeaseAdapter();
    const handle = (await tokenIssuer.acquire({
      ...acquireInput,
      leaseKey: ingestionWorkerLeaseKey(context),
      ttlMs: 60_000,
    }))!;

    await expect(adapter.verifyFence(transaction as never, {
      ...context,
      fenceToken: handle.fenceToken,
    })).resolves.toBeUndefined();
    expect(timeoutSql).toHaveLength(0);

    await expect(adapter.verifyFence(transaction as never, {
      ...context,
      fenceToken: handle.fenceToken,
    }, "before-commit")).resolves.toBeUndefined();

    expect(timeoutSql).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(timeoutSql[0] as never);
    expect(rendered.sql).toContain("set_config('lock_timeout'");
    expect(rendered.sql).toContain("set_config('statement_timeout'");
    expect(rendered.params).toEqual(["1234ms", "1234ms"]);
  });
});
