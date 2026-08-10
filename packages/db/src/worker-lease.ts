import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { HandleplanDatabase } from "./client";
import { workerLeases } from "./evidence-schema";
import type {
  IngestionFenceContext,
  IngestionFenceVerifier,
  IngestionTransaction,
} from "./ingestion";

export type WorkerLeaseErrorCode =
  | "CANCELLED"
  | "LEASE_LOST"
  | "OPERATION_TIMEOUT"
  | "STALE_FENCE";

export class WorkerLeaseError extends Error {
  readonly code: WorkerLeaseErrorCode;

  constructor(code: WorkerLeaseErrorCode, message: string) {
    super(message);
    this.name = "WorkerLeaseError";
    this.code = code;
  }
}

export interface WorkerLeaseAcquireInput {
  readonly leaseKey: string;
  readonly ownerId: string;
  readonly signal?: AbortSignal;
  readonly ttlMs: number;
}

export interface PostgresWorkerLeaseAdapterOptions {
  readonly operationTimeoutMs?: number;
}

export interface PostgresWorkerLeaseHandle {
  readonly fenceToken: string;
  readonly leaseKey: string;
  readonly ownerId: string;
  readonly signal: AbortSignal;
  heartbeat(signal?: AbortSignal): Promise<void>;
  release(signal?: AbortSignal): Promise<void>;
}

interface NormalizedLeaseInput {
  readonly leaseKey: string;
  readonly ownerId: string;
  readonly ttlMs: number;
}

interface LeaseIdentity {
  readonly generation: string;
  readonly leaseKey: string;
  readonly ownerId: string;
}

interface LeaseHandleOperations {
  release(signal?: AbortSignal): Promise<boolean>;
  renew(signal?: AbortSignal): Promise<boolean>;
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

const ADVISORY_LOCK_SEED = 8_719_223_401;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const FENCE_TOKEN_PREFIX = "wlf1.";
const MAX_FENCE_TOKEN_LENGTH = 1_024;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const MAX_TTL_MS = 86_400_000;
const MIN_TTL_MS = 3;
const POSTGRES_GENERATION_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?([+-])(\d{2})(?::?(\d{2}))?$/;

function cancelledError(): WorkerLeaseError {
  return new WorkerLeaseError("CANCELLED", "Worker lease operation cancelled");
}

function leaseLostError(): WorkerLeaseError {
  return new WorkerLeaseError("LEASE_LOST", "Worker lease ownership was lost");
}

function operationTimeoutError(): WorkerLeaseError {
  return new WorkerLeaseError("OPERATION_TIMEOUT", "Worker lease operation timed out");
}

function staleFenceError(): WorkerLeaseError {
  return new WorkerLeaseError("STALE_FENCE", "Worker lease fence is stale or invalid");
}

function requireBoundedIdentity(
  value: unknown,
  name: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim().length < 1
  ) {
    throw new TypeError(`${name} must contain 1-${maximum} nonblank characters`);
  }
}

function requireIntegerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function normalizeAcquireInput(input: WorkerLeaseAcquireInput): NormalizedLeaseInput {
  requireBoundedIdentity(input.leaseKey, "leaseKey", 120);
  requireBoundedIdentity(input.ownerId, "ownerId", 160);
  requireIntegerInRange(input.ttlMs, "ttlMs", MIN_TTL_MS, MAX_TTL_MS);
  return Object.freeze({
    leaseKey: input.leaseKey,
    ownerId: input.ownerId,
    ttlMs: input.ttlMs,
  });
}

function isValidGeneration(input: string): boolean {
  const match = POSTGRES_GENERATION_PATTERN.exec(input);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8]);
  const offsetMinute = Number(match[9] ?? "0");
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]!
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 15
    && offsetMinute <= 59;
}

function encodeFenceToken(identity: LeaseIdentity): string {
  const encoded = Buffer.from(JSON.stringify({
    g: identity.generation,
    k: identity.leaseKey,
    o: identity.ownerId,
    v: 1,
  }), "utf8").toString("base64url");
  return `${FENCE_TOKEN_PREFIX}${encoded}`;
}

function decodeFenceToken(input: unknown): LeaseIdentity | undefined {
  if (
    typeof input !== "string"
    || input.length > MAX_FENCE_TOKEN_LENGTH
    || !input.startsWith(FENCE_TOKEN_PREFIX)
  ) {
    return undefined;
  }

  try {
    const encoded = input.slice(FENCE_TOKEN_PREFIX.length);
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (
      value.v !== 1
      || typeof value.g !== "string"
      || !isValidGeneration(value.g)
      || typeof value.k !== "string"
      || typeof value.o !== "string"
      || Object.keys(value).sort().join(",") !== "g,k,o,v"
    ) {
      return undefined;
    }
    requireBoundedIdentity(value.k, "leaseKey", 120);
    requireBoundedIdentity(value.o, "ownerId", 160);
    const identity = Object.freeze({
      generation: value.g,
      leaseKey: value.k,
      ownerId: value.o,
    });
    return encodeFenceToken(identity) === input ? identity : undefined;
  } catch {
    return undefined;
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw cancelledError();
  const onAbort = () => query.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await query;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function ingestionWorkerLeaseKey(
  context: Pick<IngestionFenceContext, "sourceId">,
): string {
  requireBoundedIdentity(context.sourceId, "sourceId", 64);
  const digest = createHash("sha256")
    .update(context.sourceId, "utf8")
    .digest("hex");
  return `worker:v1:${digest}`;
}

class AcquiredPostgresWorkerLease implements PostgresWorkerLeaseHandle {
  private readonly controller = new AbortController();
  readonly fenceToken: string;
  private heartbeatInFlight: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  readonly leaseKey: string;
  readonly ownerId: string;
  private releasePromise: Promise<void> | undefined;
  private releasing = false;
  readonly signal = this.controller.signal;

  constructor(
    identity: LeaseIdentity,
    private readonly ttlMs: number,
    private readonly operations: LeaseHandleOperations,
  ) {
    this.fenceToken = encodeFenceToken(identity);
    this.leaseKey = identity.leaseKey;
    this.ownerId = identity.ownerId;
    this.scheduleHeartbeat();
  }

  heartbeat(signal?: AbortSignal): Promise<void> {
    if (this.releasing || this.controller.signal.aborted) {
      return Promise.reject(leaseLostError());
    }
    this.clearHeartbeatTimer();
    if (this.heartbeatInFlight !== undefined) return this.heartbeatInFlight;

    const heartbeat = this.operations
      .renew(signal === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, signal]))
      .then((renewed) => {
        if (!renewed) throw leaseLostError();
      })
      .catch((error: unknown) => {
        this.controller.abort();
        throw error;
      })
      .finally(() => {
        if (this.heartbeatInFlight === heartbeat) this.heartbeatInFlight = undefined;
        if (!this.releasing && !this.controller.signal.aborted) this.scheduleHeartbeat();
      });
    this.heartbeatInFlight = heartbeat;
    return heartbeat;
  }

  release(signal?: AbortSignal): Promise<void> {
    if (this.releasePromise !== undefined) return this.releasePromise;
    this.releasing = true;
    this.clearHeartbeatTimer();
    const activeHeartbeat = this.heartbeatInFlight;
    const release = (async () => {
      if (activeHeartbeat !== undefined) {
        try {
          await activeHeartbeat;
        } catch {
          // The conditional delete below determines whether this generation is still owned.
        }
      }
      try {
        const released = await this.operations.release(signal);
        if (!released) throw leaseLostError();
      } catch (error) {
        this.controller.abort();
        throw error;
      }
      this.controller.abort();
    })();
    this.releasePromise = release;
    return release;
  }

  private clearHeartbeatTimer(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleHeartbeat(): void {
    if (this.releasing || this.controller.signal.aborted) return;
    const timer = setTimeout(() => {
      if (this.heartbeatTimer === timer) this.heartbeatTimer = undefined;
      void this.heartbeat().catch(() => undefined);
    }, Math.max(1, Math.floor(this.ttlMs / 3)));
    this.heartbeatTimer = timer;
    unrefTimer(timer);
  }
}

export class PostgresWorkerLeaseAdapter {
  private readonly operationTimeoutMs: number;

  constructor(
    protected readonly db: HandleplanDatabase,
    options: PostgresWorkerLeaseAdapterOptions = {},
  ) {
    const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    requireIntegerInRange(
      operationTimeoutMs,
      "operationTimeoutMs",
      1,
      MAX_OPERATION_TIMEOUT_MS,
    );
    this.operationTimeoutMs = operationTimeoutMs;
  }

  async acquire(input: WorkerLeaseAcquireInput): Promise<PostgresWorkerLeaseHandle | undefined> {
    const normalized = normalizeAcquireInput(input);
    if (input.signal?.aborted) throw cancelledError();
    const generation = await this.runBounded(
      input.signal,
      (signal) => this.claimLease(normalized, signal),
    );
    if (generation === undefined) return undefined;

    const identity = Object.freeze({
      generation,
      leaseKey: normalized.leaseKey,
      ownerId: normalized.ownerId,
    });
    return new AcquiredPostgresWorkerLease(identity, normalized.ttlMs, {
      release: (signal) => this.runBounded(
        signal,
        (operationSignal) => this.releaseLease(identity, operationSignal),
      ),
      renew: (signal) => this.runBounded(
        signal,
        (operationSignal) => this.renewLease(identity, normalized.ttlMs, operationSignal),
      ),
    });
  }

  readonly verifyFence: IngestionFenceVerifier = async (
    transaction,
    context,
    phase = "initial",
  ) => {
    const identity = decodeFenceToken(context.fenceToken);
    let expectedLeaseKey: string;
    try {
      expectedLeaseKey = ingestionWorkerLeaseKey(context);
    } catch {
      throw staleFenceError();
    }
    if (identity === undefined || identity.leaseKey !== expectedLeaseKey) {
      throw staleFenceError();
    }
    if (!(await this.lockCurrentFence(
      transaction,
      identity,
      phase === "before-commit",
    ))) throw staleFenceError();
  };

  protected async claimLease(
    input: NormalizedLeaseInput,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    return this.db.$client.begin(async (transaction) => {
      await awaitAbortable(
        transaction`
          select pg_advisory_xact_lock(
            hashtextextended(${input.leaseKey}, ${ADVISORY_LOCK_SEED})
          )
        `,
        signal,
      );
      const [claim] = await awaitAbortable(
        transaction<[{ generation: string }]>`
          with lease_clock as (
            select clock_timestamp() as acquired_at
          )
          insert into worker_leases (
            lease_key,
            owner_id,
            acquired_at,
            expires_at,
            heartbeat_at
          )
          select
            ${input.leaseKey},
            ${input.ownerId},
            acquired_at,
            acquired_at + (${input.ttlMs}::double precision * interval '1 millisecond'),
            acquired_at
          from lease_clock
          on conflict (lease_key) do update
          set
            owner_id = excluded.owner_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            heartbeat_at = excluded.heartbeat_at
          where worker_leases.expires_at <= excluded.acquired_at
          returning acquired_at::text as generation
        `,
        signal,
      );
      return claim?.generation;
    });
  }

  protected async lockCurrentFence(
    transaction: IngestionTransaction,
    identity: LeaseIdentity,
    lockForCommit = true,
  ): Promise<boolean> {
    if (lockForCommit) {
      await transaction.execute(
        sql`
          select
            set_config('lock_timeout', ${`${this.operationTimeoutMs}ms`}, true),
            set_config('statement_timeout', ${`${this.operationTimeoutMs}ms`}, true)
        `,
      );
    }
    const query = transaction
      .select({ leaseKey: workerLeases.leaseKey })
      .from(workerLeases)
      .where(and(
        eq(workerLeases.leaseKey, identity.leaseKey),
        eq(workerLeases.ownerId, identity.ownerId),
        sql`${workerLeases.acquiredAt} = ${identity.generation}::timestamptz`,
        sql`${workerLeases.expiresAt} > clock_timestamp()`,
      ));
    const [lease] = lockForCommit
      ? await query.for("update").limit(1)
      : await query.limit(1);
    return lease !== undefined;
  }

  protected async releaseLease(
    identity: LeaseIdentity,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.db.$client.begin(async (transaction) => {
      await awaitAbortable(
        transaction`
          select pg_advisory_xact_lock(
            hashtextextended(${identity.leaseKey}, ${ADVISORY_LOCK_SEED})
          )
        `,
        signal,
      );
      const released = await awaitAbortable(
        transaction<[{ lease_key: string }]>`
          delete from worker_leases
          where lease_key = ${identity.leaseKey}
            and owner_id = ${identity.ownerId}
            and acquired_at = ${identity.generation}::timestamptz
          returning lease_key
        `,
        signal,
      );
      return released.length === 1;
    });
  }

  protected async renewLease(
    identity: LeaseIdentity,
    ttlMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.db.$client.begin(async (transaction) => {
      await awaitAbortable(
        transaction`
          select pg_advisory_xact_lock(
            hashtextextended(${identity.leaseKey}, ${ADVISORY_LOCK_SEED})
          )
        `,
        signal,
      );
      const renewed = await awaitAbortable(
        transaction<[{ lease_key: string }]>`
          with lease_clock as (
            select clock_timestamp() as heartbeat_at
          )
          update worker_leases
          set
            heartbeat_at = lease_clock.heartbeat_at,
            expires_at = lease_clock.heartbeat_at
              + (${ttlMs}::double precision * interval '1 millisecond')
          from lease_clock
          where lease_key = ${identity.leaseKey}
            and owner_id = ${identity.ownerId}
            and acquired_at = ${identity.generation}::timestamptz
            and expires_at > lease_clock.heartbeat_at
          returning lease_key
        `,
        signal,
      );
      return renewed.length === 1;
    });
  }

  private async runBounded<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted) throw cancelledError();
    const deadline = new AbortController();
    const operationSignal = callerSignal === undefined
      ? deadline.signal
      : AbortSignal.any([callerSignal, deadline.signal]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(callerSignal?.aborted ? cancelledError() : operationTimeoutError());
      operationSignal.addEventListener("abort", onAbort, { once: true });
      if (operationSignal.aborted) onAbort();
    });
    const timeout = setTimeout(() => deadline.abort(), this.operationTimeoutMs);
    unrefTimer(timeout);

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => operation(operationSignal)),
        aborted,
      ]);
      if (callerSignal?.aborted) throw cancelledError();
      if (deadline.signal.aborted) throw operationTimeoutError();
      return result;
    } catch (error) {
      if (callerSignal?.aborted) throw cancelledError();
      if (deadline.signal.aborted) throw operationTimeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
      operationSignal.removeEventListener("abort", onAbort);
    }
  }
}
