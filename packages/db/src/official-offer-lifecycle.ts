import type { HandleplanDatabase } from "./client";

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

export const MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH = 50;

export type OfficialOfferLifecycleOutcome =
  | "completed"
  | "lease-unavailable"
  | "replayed";

export type OfficialOfferLifecyclePublicationState =
  | "evaluated"
  | "foundation-disabled"
  | "not-evaluated"
  | "source-ineligible";

export interface OfficialOfferLifecycleRequestV1 {
  readonly batchLimit: number;
  readonly contractVersion: 1;
  readonly jobId: string;
  readonly ownerId: string;
  readonly publicationRequested: boolean;
  readonly runId: string;
  readonly scheduledAt: Date;
  readonly sourceId: string;
}

export interface OfficialOfferLifecycleReceiptV1 {
  readonly contractVersion: 1;
  readonly databaseAsOf: Date;
  readonly expiredCount: number;
  readonly expiryExamined: number;
  readonly jobId: string;
  readonly leaseExpiresAt: Date;
  readonly outcome: OfficialOfferLifecycleOutcome;
  readonly publicationExamined: number;
  readonly publicationState: OfficialOfferLifecyclePublicationState;
  readonly publishedCount: number;
  readonly replayed: boolean;
  readonly revokedCount: number;
  readonly skippedCount: number;
  readonly sourceId: string;
}

export type OfficialOfferLifecycleRepositoryErrorCode =
  | "CANCELLED"
  | "CONFLICT"
  | "CORRUPT_RECEIPT"
  | "UNAVAILABLE";

export class OfficialOfferLifecycleRepositoryError extends Error {
  constructor(
    readonly code: OfficialOfferLifecycleRepositoryErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Official-offer lifecycle repository failed: ${code}`, options);
    this.name = "OfficialOfferLifecycleRepositoryError";
  }
}

interface LifecycleRow {
  database_as_of: unknown;
  expired_count: unknown;
  expiry_examined: unknown;
  job_id: unknown;
  lease_expires_at: unknown;
  outcome: unknown;
  publication_examined: unknown;
  publication_state: unknown;
  published_count: unknown;
  replayed: unknown;
  revoked_count: unknown;
  skipped_count: unknown;
  source_id: unknown;
}

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;

function boundedIdentity(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || CONTROL_PATTERN.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded canonical identity`);
  }
  return value;
}

function canonicalRequestDate(value: unknown, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a finite Date`);
  }
  return new Date(value);
}

function databaseDate(value: unknown, name: string): Date {
  const parsed = value instanceof Date
    ? new Date(value)
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${name} must be a finite database timestamp`);
  }
  return parsed;
}

function canonicalRequest(input: OfficialOfferLifecycleRequestV1): OfficialOfferLifecycleRequestV1 {
  if (input?.contractVersion !== 1 || typeof input.publicationRequested !== "boolean") {
    throw new TypeError("Official-offer lifecycle request must use contract version 1");
  }
  const sourceId = boundedIdentity(input.sourceId, "sourceId", 64);
  if (!SOURCE_PATTERN.test(sourceId)) throw new TypeError("sourceId is not canonical");
  if (!Number.isSafeInteger(input.batchLimit)
      || input.batchLimit < 1
      || input.batchLimit > MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH) {
    throw new TypeError("batchLimit must be an integer from 1 through 50");
  }
  return Object.freeze({
    batchLimit: input.batchLimit,
    contractVersion: 1,
    jobId: boundedIdentity(input.jobId, "jobId", 200),
    ownerId: boundedIdentity(input.ownerId, "ownerId", 160),
    publicationRequested: input.publicationRequested,
    runId: boundedIdentity(input.runId, "runId", 200),
    scheduledAt: canonicalRequestDate(input.scheduledAt, "scheduledAt"),
    sourceId,
  });
}

function count(value: unknown, name: string, maximum: number): number {
  const numeric = typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) < 0 || Number(numeric) > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return Number(numeric);
}

function parseReceipt(
  rows: readonly LifecycleRow[],
  request: OfficialOfferLifecycleRequestV1,
): OfficialOfferLifecycleReceiptV1 {
  if (rows.length !== 1) throw new Error("Lifecycle function returned an invalid row count");
  const row = rows[0]!;
  if (
    !["completed", "lease-unavailable", "replayed"].includes(String(row.outcome))
    || !["evaluated", "foundation-disabled", "not-evaluated", "source-ineligible"]
      .includes(String(row.publication_state))
    || typeof row.replayed !== "boolean"
    || row.job_id !== request.jobId
    || row.source_id !== request.sourceId
  ) throw new Error("Lifecycle function returned a mismatched receipt");

  const outcome = row.outcome as OfficialOfferLifecycleOutcome;
  const publicationState = row.publication_state as OfficialOfferLifecyclePublicationState;
  if (
    (outcome === "replayed") !== row.replayed
    || (outcome === "lease-unavailable") !== (publicationState === "not-evaluated")
    || (
      request.publicationRequested === false
      && !["foundation-disabled", "not-evaluated"].includes(publicationState)
    )
  ) throw new Error("Lifecycle function returned inconsistent state");

  const expiryExamined = count(row.expiry_examined, "expiry examined count", request.batchLimit);
  const expiredCount = count(row.expired_count, "expired count", expiryExamined);
  const revokedCount = count(row.revoked_count, "revoked count", expiryExamined);
  const publicationExamined = count(
    row.publication_examined,
    "publication examined count",
    request.batchLimit,
  );
  const publishedCount = count(row.published_count, "published count", publicationExamined);
  const skippedCount = count(
    row.skipped_count,
    "skipped count",
    expiryExamined + publicationExamined,
  );
  if (
    expiredCount + revokedCount > expiryExamined
    || skippedCount !== expiryExamined + publicationExamined
      - expiredCount - revokedCount - publishedCount
    || (outcome === "lease-unavailable" && (
      expiryExamined !== 0 || publicationExamined !== 0 || skippedCount !== 0
    ))
  ) throw new Error("Lifecycle function returned inconsistent accounting");

  const databaseAsOf = databaseDate(row.database_as_of, "database lifecycle clock");
  const leaseExpiresAt = databaseDate(row.lease_expires_at, "database lease expiry");
  if (outcome !== "lease-unavailable" && databaseAsOf > leaseExpiresAt) {
    throw new Error("Lifecycle receipt was evaluated after its lease expired");
  }
  return Object.freeze({
    contractVersion: 1,
    databaseAsOf,
    expiredCount,
    expiryExamined,
    jobId: request.jobId,
    leaseExpiresAt,
    outcome,
    publicationExamined,
    publicationState,
    publishedCount,
    replayed: row.replayed,
    revokedCount,
    skippedCount,
    sourceId: request.sourceId,
  });
}

async function abortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new OfficialOfferLifecycleRepositoryError("CANCELLED");
  const cancel = () => query.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw new OfficialOfferLifecycleRepositoryError("CANCELLED");
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate?.code === "40001" || String(candidate?.message).includes("JOB_CONFLICT")) {
      throw new OfficialOfferLifecycleRepositoryError("CONFLICT");
    }
    throw new OfficialOfferLifecycleRepositoryError("UNAVAILABLE", { cause: error });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export class PostgresOfficialOfferLifecycleRepository {
  constructor(private readonly db: HandleplanDatabase) {}

  async reconcile(
    input: OfficialOfferLifecycleRequestV1,
    signal?: AbortSignal,
  ): Promise<OfficialOfferLifecycleReceiptV1> {
    const request = canonicalRequest(input);
    let rows: LifecycleRow[];
    try {
      rows = await abortable(this.db.$client<LifecycleRow[]>`
        select *
        from public.official_offer_lifecycle_reconcile_v1(
          ${request.sourceId},
          ${request.jobId},
          ${request.runId},
          ${request.scheduledAt.toISOString()},
          ${request.ownerId},
          ${request.batchLimit},
          ${request.publicationRequested}
        )
      `, signal);
    } catch (error) {
      if (error instanceof OfficialOfferLifecycleRepositoryError) throw error;
      throw new OfficialOfferLifecycleRepositoryError("UNAVAILABLE");
    }
    try {
      return parseReceipt(rows, request);
    } catch (error) {
      throw new OfficialOfferLifecycleRepositoryError("CORRUPT_RECEIPT", { cause: error });
    }
  }
}
