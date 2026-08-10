import {
  OFFICIAL_OFFER_FOUNDATION_ACTIVATION,
  officialOfferEditionDiscoveryInputV1Schema,
  type OfficialOfferEditionDiscoveryInputV1,
} from "@handleplan/domain";

import type { WorkerJobKind, WorkerRunCounters } from "./contracts";
import {
  OfficialOfferFoundationWorkerError,
  type OfficialOfferFoundationPipeline,
  type OfficialOfferFoundationPipelineInput,
  type OfficialOfferFoundationPipelineReceipt,
} from "./official-offer-foundation";
import {
  WorkerCancelledError,
  type WorkerJobHandler,
} from "./runner";
import type { WorkerScheduleDefinition } from "./schedule";

export const MAX_OFFICIAL_OFFER_DISCOVERY_PAGES = 5;
export const MAX_OFFICIAL_OFFER_EDITIONS_PER_PAGE = 10;
export const MAX_OFFICIAL_OFFER_EDITIONS_PER_RUN = 10;
export const MAX_OFFICIAL_OFFER_DISCOVERY_CURSOR_LENGTH = 512;
export const MAX_OFFICIAL_OFFER_CAPTURE_BYTES_PER_RUN = 100 * 1024 * 1024;

const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
const MAX_SCHEDULE_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_SCHEDULE_TIMEOUT_MS = 15 * 60 * 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/u;

export interface OfficialOfferDiscoveryRequestV1 {
  readonly contractVersion: 1;
  readonly cursor?: string;
  readonly limit: number;
  readonly sourceId: string;
}

/**
 * Trusted, server-owned normalization boundary. A raw retailer/network adapter
 * must not implement this port directly: source authorization, the server
 * discovery clock, and the geographic-scope identifier must already have been
 * derived by reviewed policy code. The orchestrator still treats the returned
 * page as unknown and owns strict validation and cardinality enforcement.
 */
export interface OfficialOfferNormalizedEditionDiscoveryPort {
  discoverPage(
    request: Readonly<OfficialOfferDiscoveryRequestV1>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Trusted normalized fetch boundary. It exposes no URL and returns a rights
 * classification selected by reviewed server policy, not raw source input.
 * A physical adapter must additionally honor the one-attempt contract below.
 */
export interface OfficialOfferNormalizedEditionFetchPort {
  fetchEdition(
    edition: Readonly<OfficialOfferEditionDiscoveryInputV1>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface OfficialOfferSourceAttemptAuthorizationRequestV1 {
  readonly contractVersion: 1;
  readonly externalEditionId?: string;
  readonly operation: "discover" | "fetch";
  readonly sourceId: string;
}

/**
 * Called immediately before each port invocation. Port implementations must
 * perform exactly one physical source attempt per invocation and must not hide
 * redirects or retries; every additional attempt belongs in a new authorized
 * invocation at the adapter boundary.
 */
export interface OfficialOfferSourceAttemptAuthorizer {
  authorizeAttempt(
    request: Readonly<OfficialOfferSourceAttemptAuthorizationRequestV1>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface OfficialOfferIngestionRunReceiptV1 {
  readonly completed: number;
  readonly contractVersion: 1;
  readonly degraded: number;
  readonly discovered: number;
  readonly failed: number;
  readonly fetched: number;
  readonly persisted: number;
}

export type OfficialOfferIngestionProgressErrorCode =
  | "CANCELLED"
  | "FAILED"
  | "SOURCE_DISABLED";

export class OfficialOfferIngestionProgressError extends Error {
  constructor(
    readonly code: OfficialOfferIngestionProgressErrorCode,
    readonly receipt: OfficialOfferIngestionRunReceiptV1,
  ) {
    super(`Official-offer ingestion stopped after persisted progress: ${code}`);
    this.name = "OfficialOfferIngestionProgressError";
  }
}

export interface OfficialOfferIngestionOrchestratorOptions {
  attemptAuthorizer: OfficialOfferSourceAttemptAuthorizer;
  discovery: OfficialOfferNormalizedEditionDiscoveryPort;
  fetcher: OfficialOfferNormalizedEditionFetchPort;
  pageLimit?: number;
  pipeline: Pick<OfficialOfferFoundationPipeline, "captureAndExtract">;
  sourceId: string;
}

interface ParsedDiscoveryPage {
  editions: readonly OfficialOfferEditionDiscoveryInputV1[];
  nextCursor?: string;
}

const DISCOVERY_PAGE_KEYS = new Set(["contractVersion", "editions", "nextCursor"]);
const FETCH_RESULT_KEYS = new Set([
  "bytes",
  "checksumSha256",
  "contractVersion",
  "externalEditionId",
  "mimeType",
  "rightsClassification",
  "sourceId",
]);

function fail(code: ConstructorParameters<typeof OfficialOfferFoundationWorkerError>[0]): never {
  throw new OfficialOfferFoundationWorkerError(code);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) fail("CANCELLED");
}

function requireSourceId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 64
    || value.trim() !== value
    || !SOURCE_ID_PATTERN.test(value)
  ) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireCursor(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_OFFICIAL_OFFER_DISCOVERY_CURSOR_LENGTH
    || value.trim() !== value
    || CONTROL_OR_FORMAT_PATTERN.test(value)
  ) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireStrictRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
  ) {
    fail("INVALID_INPUT");
  }
  return value as Record<string, unknown>;
}

function parseDiscoveryPage(
  value: unknown,
  sourceId: string,
  pageLimit: number,
): ParsedDiscoveryPage {
  const page = requireStrictRecord(value, DISCOVERY_PAGE_KEYS);
  if (page.contractVersion !== 1 || !Array.isArray(page.editions)) fail("INVALID_INPUT");
  if (page.editions.length > pageLimit) fail("INVALID_INPUT");
  const editions = page.editions.map((edition) => {
    const parsed = officialOfferEditionDiscoveryInputV1Schema.safeParse(edition);
    if (!parsed.success || parsed.data.sourceId !== sourceId) fail("INVALID_INPUT");
    return parsed.data;
  });
  const nextCursor = page.nextCursor === undefined
    ? undefined
    : requireCursor(page.nextCursor);
  return Object.freeze({
    editions: Object.freeze(editions),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function parseFetchResult(
  value: unknown,
  edition: OfficialOfferEditionDiscoveryInputV1,
): OfficialOfferFoundationPipelineInput {
  const result = requireStrictRecord(value, FETCH_RESULT_KEYS);
  if (
    result.contractVersion !== 1
    || result.sourceId !== edition.sourceId
    || result.externalEditionId !== edition.externalEditionId
    || !(result.bytes instanceof Uint8Array)
    || result.bytes.byteLength < 1
    || result.bytes.byteLength > MAX_CAPTURE_BYTES
    || typeof result.checksumSha256 !== "string"
    || !SHA256_PATTERN.test(result.checksumSha256)
    || typeof result.mimeType !== "string"
    || !["extract_only", "private_review", "public_display"]
      .includes(String(result.rightsClassification))
  ) {
    fail("INVALID_INPUT");
  }
  return Object.freeze({
    bytes: Uint8Array.from(result.bytes),
    contractVersion: 1,
    edition,
    expectedChecksumSha256: result.checksumSha256,
    mimeType: result.mimeType,
    rightsClassification: result.rightsClassification as
      OfficialOfferFoundationPipelineInput["rightsClassification"],
  });
}

function incrementStatus(
  receipt: OfficialOfferFoundationPipelineReceipt,
  counts: { completed: number; degraded: number; failed: number },
): void {
  counts[receipt.status] += 1;
}

export class OfficialOfferIngestionOrchestrator {
  private readonly pageLimit: number;
  private readonly sourceId: string;

  constructor(private readonly options: OfficialOfferIngestionOrchestratorOptions) {
    this.sourceId = requireSourceId(options.sourceId);
    this.pageLimit = options.pageLimit ?? MAX_OFFICIAL_OFFER_EDITIONS_PER_PAGE;
    if (
      !Number.isSafeInteger(this.pageLimit)
      || this.pageLimit < 1
      || this.pageLimit > MAX_OFFICIAL_OFFER_EDITIONS_PER_PAGE
    ) {
      fail("INVALID_INPUT");
    }
  }

  async run(signal: AbortSignal): Promise<OfficialOfferIngestionRunReceiptV1> {
    throwIfCancelled(signal);
    const editionKeys = new Set<string>();
    const cursors = new Set<string>();
    const statusCounts = { completed: 0, degraded: 0, failed: 0 };
    let cursor: string | undefined;
    let discovered = 0;
    let fetched = 0;
    let fetchedBytes = 0;

    const receipt = (): OfficialOfferIngestionRunReceiptV1 => Object.freeze({
      ...statusCounts,
      contractVersion: 1,
      discovered,
      fetched,
      persisted: fetched,
    });

    try {
      for (let pageIndex = 0; pageIndex < MAX_OFFICIAL_OFFER_DISCOVERY_PAGES; pageIndex += 1) {
        const discoveryAuthorization = await this.options.attemptAuthorizer.authorizeAttempt({
          contractVersion: 1,
          operation: "discover",
          sourceId: this.sourceId,
        }, signal);
        if (discoveryAuthorization !== undefined) fail("INVALID_INPUT");
        throwIfCancelled(signal);
        const page = parseDiscoveryPage(await this.options.discovery.discoverPage({
          contractVersion: 1,
          ...(cursor === undefined ? {} : { cursor }),
          limit: this.pageLimit,
          sourceId: this.sourceId,
        }, signal), this.sourceId, this.pageLimit);
        throwIfCancelled(signal);

        if (discovered + page.editions.length > MAX_OFFICIAL_OFFER_EDITIONS_PER_RUN) {
          fail("INVALID_INPUT");
        }
        for (const edition of page.editions) {
          const editionKey = `${edition.sourceId}\u0000${edition.externalEditionId}`;
          if (editionKeys.has(editionKey)) fail("INVALID_INPUT");
          editionKeys.add(editionKey);
          discovered += 1;
          const fetchAuthorization = await this.options.attemptAuthorizer.authorizeAttempt({
            contractVersion: 1,
            externalEditionId: edition.externalEditionId,
            operation: "fetch",
            sourceId: this.sourceId,
          }, signal);
          if (fetchAuthorization !== undefined) fail("INVALID_INPUT");
          throwIfCancelled(signal);
          const fetchResult = await this.options.fetcher.fetchEdition(edition, signal);
          throwIfCancelled(signal);
          const pipelineInput = parseFetchResult(fetchResult, edition);
          fetchedBytes += pipelineInput.bytes.byteLength;
          if (fetchedBytes > MAX_OFFICIAL_OFFER_CAPTURE_BYTES_PER_RUN) fail("INVALID_INPUT");
          const pipelineReceipt = await this.options.pipeline.captureAndExtract(
            pipelineInput,
            signal,
          );
          throwIfCancelled(signal);
          incrementStatus(pipelineReceipt, statusCounts);
          fetched += 1;
        }

        if (page.nextCursor === undefined) return receipt();
        if (cursors.has(page.nextCursor)) fail("INVALID_INPUT");
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      fail("INVALID_INPUT");
    } catch (error) {
      if (fetched === 0 || error instanceof OfficialOfferIngestionProgressError) throw error;
      const cancelled = signal.aborted
        || (error instanceof OfficialOfferFoundationWorkerError && error.code === "CANCELLED");
      const sourceDisabled = error instanceof OfficialOfferFoundationWorkerError
        && error.code === "SOURCE_DISABLED";
      if (!cancelled) statusCounts.failed += 1;
      throw new OfficialOfferIngestionProgressError(
        cancelled ? "CANCELLED" : sourceDisabled ? "SOURCE_DISABLED" : "FAILED",
        receipt(),
      );
    }
  }
}

export interface OfficialOfferEnabledProductionConfigV1 {
  readonly contractVersion: 1;
  readonly enabled: true;
  readonly ingestion: Omit<WorkerScheduleDefinition, "kind" | "sourceId">;
  readonly lifecycle: Omit<WorkerScheduleDefinition, "kind" | "sourceId">;
  readonly sourceId: string;
}

export interface OfficialOfferDisabledProductionConfigV1 {
  readonly contractVersion: 1;
  readonly enabled: false;
  readonly reason: string;
}

export type OfficialOfferProductionConfigV1 =
  | OfficialOfferDisabledProductionConfigV1
  | OfficialOfferEnabledProductionConfigV1;

export interface OfficialOfferProductionComposition {
  readonly activationEnabled: boolean;
  readonly handlers: Partial<Record<WorkerJobKind, WorkerJobHandler>>;
  readonly schedules: readonly WorkerScheduleDefinition[];
}

function countersForIngestion(
  receipt: OfficialOfferIngestionRunReceiptV1,
): WorkerRunCounters {
  const unknown = receipt.fetched - receipt.completed - receipt.degraded;
  if (!Number.isSafeInteger(unknown) || unknown < 0) fail("INVALID_INPUT");
  return {
    accepted: receipt.completed,
    failed: receipt.failed,
    fetched: receipt.fetched,
    persisted: receipt.persisted,
    quarantined: receipt.degraded,
    unknown,
  };
}

function normalizedScheduleDefinition(
  input: unknown,
): Omit<WorkerScheduleDefinition, "kind" | "sourceId"> {
  const definition = requireStrictRecord(
    input,
    new Set(["anchorAt", "intervalMs", "timeoutMs"]),
  );
  const anchor = typeof definition.anchorAt === "string"
    ? new Date(definition.anchorAt)
    : new Date(Number.NaN);
  if (
    !Number.isFinite(anchor.getTime())
    || anchor.toISOString() !== definition.anchorAt
    || !Number.isSafeInteger(definition.intervalMs)
    || Number(definition.intervalMs) < 1
    || Number(definition.intervalMs) > MAX_SCHEDULE_INTERVAL_MS
    || !Number.isSafeInteger(definition.timeoutMs)
    || Number(definition.timeoutMs) < 1
    || Number(definition.timeoutMs) > MAX_SCHEDULE_TIMEOUT_MS
  ) {
    fail("INVALID_INPUT");
  }
  return Object.freeze({
    anchorAt: definition.anchorAt as string,
    intervalMs: Number(definition.intervalMs),
    timeoutMs: Number(definition.timeoutMs),
  });
}

/**
 * Builds the private-ingestion handler used by synthetic runtime proof and, in
 * the future, a dedicated per-source production runtime. This does not enable
 * publication or register a production schedule.
 */
export function createOfficialOfferIngestionHandler(
  orchestrator: Pick<OfficialOfferIngestionOrchestrator, "run">,
  sourceIdInput: string,
): WorkerJobHandler {
  const sourceId = requireSourceId(sourceIdInput);
  return async (context) => {
    if (context.sourceId !== sourceId || context.kind !== "official-offer-ingestion") {
      fail("INVALID_INPUT");
    }
    try {
      const receipt = await orchestrator.run(context.signal);
      return { counters: countersForIngestion(receipt) };
    } catch (error) {
      if (!(error instanceof OfficialOfferIngestionProgressError)) throw error;
      const counters = countersForIngestion(error.receipt);
      if (error.code === "CANCELLED") throw new WorkerCancelledError(counters);
      return { counters, status: "partial" };
    }
  };
}

/**
 * Current production composition is deliberately inert. An enabled local
 * config always fails closed before schedules or handlers are returned; a
 * separately reviewed code change is required to add production composition.
 */
export function createOfficialOfferProductionComposition(
  config: OfficialOfferProductionConfigV1,
): OfficialOfferProductionComposition {
  const configRecord = requireStrictRecord(config, new Set([
    "contractVersion",
    "enabled",
    "ingestion",
    "lifecycle",
    "reason",
    "sourceId",
  ]));
  if (configRecord.contractVersion !== 1 || typeof configRecord.enabled !== "boolean") {
    fail("INVALID_INPUT");
  }
  if (configRecord.enabled === false) {
    requireStrictRecord(config, new Set(["contractVersion", "enabled", "reason"]));
    if (
      typeof configRecord.reason !== "string"
      || configRecord.reason.length < 1
      || configRecord.reason.length > 240
      || configRecord.reason.trim() !== configRecord.reason
    ) {
      fail("INVALID_INPUT");
    }
    return Object.freeze({
      activationEnabled: false,
      handlers: Object.freeze({}),
      schedules: Object.freeze([]),
    });
  }
  requireStrictRecord(config, new Set([
    "contractVersion",
    "enabled",
    "ingestion",
    "lifecycle",
    "sourceId",
  ]));
  const enabledConfig = config as OfficialOfferEnabledProductionConfigV1;
  normalizedScheduleDefinition(enabledConfig.ingestion);
  normalizedScheduleDefinition(enabledConfig.lifecycle);
  requireSourceId(enabledConfig.sourceId);

  // Production activation needs a separate reviewed composition change. The
  // current worker cannot register either ingestion or lifecycle work from
  // config alone, even if a future domain flag changes accidentally.
  fail("SOURCE_DISABLED");
}

export function disabledOfficialOfferProductionComposition(): OfficialOfferProductionComposition {
  return createOfficialOfferProductionComposition({
    contractVersion: 1,
    enabled: false,
    reason: OFFICIAL_OFFER_FOUNDATION_ACTIVATION.reason,
  });
}
