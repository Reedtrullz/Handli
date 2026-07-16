import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { HandleplanDatabase } from "./client";
import { workerJobResults } from "./schema";
import type { IngestionFenceVerifier } from "./ingestion";

export const WORKER_JOB_STATE_KINDS = [
  "catalog-refresh",
  "benchmark-price-refresh",
  "physical-store-sync",
  "historical-observation-collection",
] as const;

export const WORKER_JOB_STATE_STATUSES = [
  "succeeded",
  "partial",
  "cancelled",
  "timed-out",
  "failed",
] as const;

export type WorkerJobStateKind = (typeof WORKER_JOB_STATE_KINDS)[number];
export type WorkerJobStateStatus = (typeof WORKER_JOB_STATE_STATUSES)[number];

export interface WorkerJobStateCounters {
  accepted: number;
  failed: number;
  fetched: number;
  persisted: number;
  quarantined: number;
  unknown: number;
}

export interface WorkerJobResultRecord {
  completedAt: Date;
  counts: WorkerJobStateCounters;
  jobId: string;
  jobKind: WorkerJobStateKind;
  runId: string;
  scheduledAt: Date;
  sourceId: string;
  startedAt: Date;
  status: WorkerJobStateStatus;
}

export type WorkerJobStateErrorCode = "CANCELLED";

export class WorkerJobStateError extends Error {
  constructor(readonly code: WorkerJobStateErrorCode, message: string) {
    super(message);
    this.name = "WorkerJobStateError";
  }
}

export class WorkerJobStateConflictError extends Error {
  constructor(readonly jobId: string) {
    super(`Conflicting worker result replay for ${jobId}`);
    this.name = "WorkerJobStateConflictError";
  }
}

export interface WorkerJobStateLookup {
  jobKind: WorkerJobStateKind;
  sourceId: string;
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SOURCE_ID_LENGTH = 64;
const COUNTER_KEYS = [
  "accepted",
  "failed",
  "fetched",
  "persisted",
  "quarantined",
  "unknown",
] as const;

function cancelledError(): WorkerJobStateError {
  return new WorkerJobStateError("CANCELLED", "Worker state operation cancelled");
}

function requireIdentifier(value: unknown, name: string, maximum: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim().length < 1
  ) {
    throw new TypeError(`${name} must contain 1-${maximum} nonblank characters`);
  }
}

function canonicalDate(value: unknown, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date`);
  }
  return new Date(value.getTime());
}

function canonicalCounters(input: unknown): WorkerJobStateCounters {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("counts must be an object");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== [...COUNTER_KEYS].sort().join(",")) {
    throw new TypeError("counts must contain the exact worker counter set");
  }
  const counters = Object.fromEntries(COUNTER_KEYS.map((key) => {
    const counter = value[key];
    if (!Number.isSafeInteger(counter) || (counter as number) < 0) {
      throw new TypeError(`${key} must be a non-negative safe integer`);
    }
    return [key, counter];
  })) as unknown as WorkerJobStateCounters;
  if (counters.fetched !== counters.accepted + counters.quarantined + counters.unknown) {
    throw new TypeError("fetched must equal accepted, quarantined, and unknown");
  }
  if (counters.persisted !== counters.fetched) {
    throw new TypeError("persisted must equal fetched");
  }
  return counters;
}

function isJobKind(value: unknown): value is WorkerJobStateKind {
  return WORKER_JOB_STATE_KINDS.includes(value as WorkerJobStateKind);
}

function isStatus(value: unknown): value is WorkerJobStateStatus {
  return WORKER_JOB_STATE_STATUSES.includes(value as WorkerJobStateStatus);
}

export function canonicalWorkerJobResult(input: WorkerJobResultRecord): WorkerJobResultRecord {
  requireIdentifier(input.jobId, "jobId", MAX_IDENTIFIER_LENGTH);
  requireIdentifier(input.runId, "runId", MAX_IDENTIFIER_LENGTH);
  requireIdentifier(input.sourceId, "sourceId", MAX_SOURCE_ID_LENGTH);
  if (!isJobKind(input.jobKind)) throw new TypeError("Unsupported worker job kind");
  if (!isStatus(input.status)) throw new TypeError("Unsupported worker result status");

  const scheduledAt = canonicalDate(input.scheduledAt, "scheduledAt");
  const startedAt = canonicalDate(input.startedAt, "startedAt");
  const completedAt = canonicalDate(input.completedAt, "completedAt");
  if (completedAt < startedAt || completedAt < scheduledAt) {
    throw new TypeError("completedAt must not precede the schedule or run start");
  }
  const counts = canonicalCounters(input.counts);
  if (input.status === "succeeded" && counts.failed !== 0) {
    throw new TypeError("Succeeded results cannot contain failures");
  }
  if (input.status === "partial" && (counts.failed === 0 || counts.fetched === 0)) {
    throw new TypeError("Partial results require progress and failures");
  }
  if (input.status === "failed" && (counts.failed === 0 || counts.fetched !== 0)) {
    throw new TypeError("Failed results require failures and no fetched progress");
  }

  return Object.freeze({
    completedAt,
    counts: Object.freeze({ ...counts }),
    jobId: input.jobId,
    jobKind: input.jobKind,
    runId: input.runId,
    scheduledAt,
    sourceId: input.sourceId,
    startedAt,
    status: input.status,
  });
}

export function hashWorkerJobResult(input: WorkerJobResultRecord): string {
  const value = canonicalWorkerJobResult(input);
  return createHash("sha256").update(JSON.stringify({
    completedAt: value.completedAt.toISOString(),
    counts: {
      accepted: value.counts.accepted,
      failed: value.counts.failed,
      fetched: value.counts.fetched,
      persisted: value.counts.persisted,
      quarantined: value.counts.quarantined,
      unknown: value.counts.unknown,
    },
    jobId: value.jobId,
    jobKind: value.jobKind,
    runId: value.runId,
    scheduledAt: value.scheduledAt.toISOString(),
    sourceId: value.sourceId,
    startedAt: value.startedAt.toISOString(),
    status: value.status,
  })).digest("hex");
}

function canonicalLookup(input: WorkerJobStateLookup): WorkerJobStateLookup {
  requireIdentifier(input.sourceId, "sourceId", MAX_SOURCE_ID_LENGTH);
  if (!isJobKind(input.jobKind)) throw new TypeError("Unsupported worker job kind");
  return { jobKind: input.jobKind, sourceId: input.sourceId };
}

async function awaitAbortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function canonicalDatabaseTimestamp(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  const date = input instanceof Date ? input : new Date(String(input));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("PostgreSQL returned an invalid worker schedule timestamp");
  }
  return date.toISOString();
}

export class PostgresWorkerJobStateRepository {
  private readonly verifyFence: IngestionFenceVerifier;

  constructor(
    private readonly db: HandleplanDatabase,
    options: { verifyFence: IngestionFenceVerifier },
  ) {
    if (typeof options?.verifyFence !== "function") {
      throw new TypeError("A worker state fence verifier is required");
    }
    this.verifyFence = options.verifyFence;
  }

  async getLastScheduledAt(
    input: WorkerJobStateLookup,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const value = canonicalLookup(input);
    const rows = await awaitAbortable(
      this.db.$client<[{ scheduled_at: Date | string | null }]>`
        select max(scheduled_at) as scheduled_at
        from worker_job_results
        where source_id = ${value.sourceId}
          and job_kind = ${value.jobKind}
      `,
      signal,
    );
    if (signal?.aborted) throw cancelledError();
    return canonicalDatabaseTimestamp(rows[0]?.scheduled_at);
  }

  async record(
    input: WorkerJobResultRecord,
    fenceToken: string,
    signal?: AbortSignal,
  ): Promise<{ created: boolean }> {
    const value = canonicalWorkerJobResult(input);
    requireIdentifier(fenceToken, "fenceToken", 1_024);
    if (signal?.aborted) throw cancelledError();
    const resultHash = hashWorkerJobResult(value);

    const recorded = await this.db.transaction(async (transaction) => {
      await this.verifyFence(transaction, {
        fenceToken,
        jobId: value.jobId,
        sourceId: value.sourceId,
      }, "initial");
      if (signal?.aborted) throw cancelledError();

      const [inserted] = await transaction
        .insert(workerJobResults)
        .values({
          completedAt: value.completedAt,
          counts: { ...value.counts },
          jobId: value.jobId,
          jobKind: value.jobKind,
          resultHash,
          runId: value.runId,
          scheduledAt: value.scheduledAt,
          sourceId: value.sourceId,
          startedAt: value.startedAt,
          status: value.status,
        })
        .onConflictDoNothing({ target: workerJobResults.jobId })
        .returning({ id: workerJobResults.id });
      let result: { created: boolean };
      if (inserted !== undefined) {
        result = { created: true };
      } else {
        const [existing] = await transaction
          .select({
            completedAt: workerJobResults.completedAt,
            jobKind: workerJobResults.jobKind,
            resultHash: workerJobResults.resultHash,
            scheduledAt: workerJobResults.scheduledAt,
            sourceId: workerJobResults.sourceId,
          })
          .from(workerJobResults)
          .where(eq(workerJobResults.jobId, value.jobId))
          .limit(1);
        if (
          existing === undefined
          || existing.sourceId !== value.sourceId
          || existing.jobKind !== value.jobKind
          || existing.scheduledAt.getTime() !== value.scheduledAt.getTime()
          || existing.completedAt.getTime() !== value.completedAt.getTime()
          || existing.resultHash !== resultHash
        ) {
          throw new WorkerJobStateConflictError(value.jobId);
        }
        result = { created: false };
      }
      if (signal?.aborted) throw cancelledError();
      await this.verifyFence(transaction, {
        fenceToken,
        jobId: value.jobId,
        sourceId: value.sourceId,
      }, "before-commit");
      return result;
    });
    if (signal?.aborted) throw cancelledError();
    return recorded;
  }
}
