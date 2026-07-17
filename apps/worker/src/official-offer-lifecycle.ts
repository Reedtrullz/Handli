import {
  MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH,
  type OfficialOfferLifecycleReceiptV1,
  type OfficialOfferLifecycleRequestV1,
} from "@handleplan/db/official-offer-lifecycle";
import { OFFICIAL_OFFER_FOUNDATION_ACTIVATION } from "@handleplan/domain";

export { MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH } from "@handleplan/db/official-offer-lifecycle";
export type {
  OfficialOfferLifecycleReceiptV1,
  OfficialOfferLifecycleRequestV1,
} from "@handleplan/db/official-offer-lifecycle";

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/u;

export interface OfficialOfferLifecycleRepositoryPort {
  reconcile(
    request: Readonly<OfficialOfferLifecycleRequestV1>,
    signal?: AbortSignal,
  ): Promise<OfficialOfferLifecycleReceiptV1>;
}

export interface OfficialOfferLifecycleExecutionV1 {
  readonly contractVersion: 1;
  readonly jobId: string;
  readonly runId: string;
  readonly scheduledAt: Date;
}

export interface OfficialOfferLifecycleJobExecutorOptions {
  readonly batchLimit?: number;
  readonly ownerId: string;
  readonly repository: OfficialOfferLifecycleRepositoryPort;
  readonly sourceId: string;
}

function boundedIdentity(
  value: unknown,
  label: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || CONTROL_OR_FORMAT_PATTERN.test(value)
    || (pattern !== undefined && !pattern.test(value))
  ) {
    throw new TypeError(`${label} must be a bounded canonical identity`);
  }
  return value;
}

function canonicalScheduledAt(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("scheduledAt must be a finite Date");
  }
  return new Date(value);
}

/**
 * Dedicated official-offer lifecycle boundary.
 *
 * The database function owns its clock, source-specific lease, replay fence,
 * publication policy, status mutations, and immutable accounting. This
 * executor deliberately does not adapt the receipt into the generic worker
 * runtime: the single SQL reconciliation receipt is authoritative.
 */
export class OfficialOfferLifecycleJobExecutor {
  private readonly batchLimit: number;
  private readonly ownerId: string;
  private readonly sourceId: string;

  constructor(private readonly options: OfficialOfferLifecycleJobExecutorOptions) {
    this.sourceId = boundedIdentity(options.sourceId, "sourceId", 64, SOURCE_ID_PATTERN);
    this.ownerId = boundedIdentity(options.ownerId, "ownerId", 160);
    this.batchLimit = options.batchLimit ?? MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH;
    if (
      !Number.isSafeInteger(this.batchLimit)
      || this.batchLimit < 1
      || this.batchLimit > MAX_OFFICIAL_OFFER_LIFECYCLE_BATCH
    ) {
      throw new TypeError("batchLimit must be an integer from 1 through 50");
    }
  }

  execute(
    input: Readonly<OfficialOfferLifecycleExecutionV1>,
    signal?: AbortSignal,
  ): Promise<OfficialOfferLifecycleReceiptV1> {
    if (input?.contractVersion !== 1) {
      throw new TypeError("Official-offer lifecycle execution must use contract version 1");
    }
    const request: OfficialOfferLifecycleRequestV1 = Object.freeze({
      batchLimit: this.batchLimit,
      contractVersion: 1,
      jobId: boundedIdentity(input.jobId, "jobId", 200),
      ownerId: this.ownerId,
      publicationRequested: OFFICIAL_OFFER_FOUNDATION_ACTIVATION.enabled,
      runId: boundedIdentity(input.runId, "runId", 200),
      scheduledAt: canonicalScheduledAt(input.scheduledAt),
      sourceId: this.sourceId,
    });
    return this.options.repository.reconcile(request, signal);
  }
}
