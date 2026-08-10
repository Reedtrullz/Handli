import { createHash } from "node:crypto";

import {
  extractedOfficialOfferCandidateV1Schema,
  officialOfferAnomalyCodeSchema,
  reviewCandidateProjectionV1Schema,
  reviewCandidateIdSchema,
  reviewDecisionRequestV1Schema,
  reviewDecisionResponseV1Schema,
  reviewQueueCandidateV1Schema,
  reviewQueueFiltersV1Schema,
  reviewQueueResponseV1Schema,
  type ExtractedOfficialOfferCandidateV1,
  type OfficialOfferAnomalyCode,
  type ReviewDecisionRequestV1,
  type ReviewDecisionResponseV1,
  type ReviewQueueCandidateV1,
  type ReviewQueueFiltersV1,
  type ReviewQueueResponseV1,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

export type ReviewQueueRepositoryErrorCode =
  | "ALREADY_REVIEWED"
  | "CANCELLED"
  | "CORRUPT_RECORD"
  | "DECISION_MISMATCH"
  | "EVIDENCE_UNAVAILABLE"
  | "NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "VERSION_CONFLICT";

export class ReviewQueueRepositoryError extends Error {
  constructor(readonly code: ReviewQueueRepositoryErrorCode) {
    super(`Private review repository operation failed: ${code}`);
    this.name = "ReviewQueueRepositoryError";
  }
}

export interface PrivateReviewCaptureLocator {
  readonly blobKey: string;
  readonly byteLength: number;
  readonly candidateId: string;
  readonly candidateVersion: number;
  readonly checksumSha256: string;
  readonly cropReference: string;
  readonly evidenceLocator: string;
  readonly mimeType: string;
  readonly rightsClassification: "extract_only" | "private_review" | "public_display";
}

export interface PrivateReviewActor {
  readonly actorId: string;
  readonly sessionId: string;
}

export interface PrivateReviewEvidenceRenderInput extends PrivateReviewActor {
  readonly candidateId: string;
  readonly expectedVersion: number;
  readonly checksumSha256: string;
  readonly cropReference: string;
  readonly evidenceProofSha256: string;
  readonly expiresAt: string;
  readonly presentation: "full_capture";
  readonly rightsClassification: "private_review" | "public_display";
}

export interface PrivateReviewEvidenceRenderReceipt {
  readonly evidenceRenderId: string;
  readonly expiresAt: string;
  readonly renderedAt: string;
}

export interface ReviewQueueRepository {
  decide(
    request: ReviewDecisionRequestV1,
    actor: Readonly<PrivateReviewActor>,
    evidenceProofSha256: string | undefined,
    actedAt: Date,
    signal?: AbortSignal,
  ): Promise<ReviewDecisionResponseV1>;
  get(
    candidateId: string,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewQueueCandidateV1>;
  getPrivateCaptureLocator(
    candidateId: string,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PrivateReviewCaptureLocator>;
  recordEvidenceRender(
    input: Readonly<PrivateReviewEvidenceRenderInput>,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PrivateReviewEvidenceRenderReceipt>;
  list(
    filters: ReviewQueueFiltersV1,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewQueueResponseV1>;
}

interface CandidateRow {
  anomaly_codes: unknown;
  blob_key: string;
  byte_length: number;
  candidate_created_at: Date | string;
  candidate_id: number | string;
  candidate_status: string;
  capture_checksum: string;
  chain: string;
  confidence: number | string;
  extraction_method: string | null;
  geographic_scope_id: number | string;
  mime_type: string;
  normalized_fields: unknown;
  publication_title: string;
  publication_valid_from: Date | string;
  publication_valid_until: Date | string;
  retrieved_at: Date | string;
  rights_classification: string;
  scope_kind: string;
  scope_label: string;
  source_id: string;
}

interface DecisionRow {
  acted_at: Date | string;
  action_id: number | string;
  new_version: number | string;
  offer_id: number | string | null;
  review_state: string;
}

interface EvidenceRenderRow {
  evidence_render_id: number | string;
  expires_at: Date | string;
  rendered_at: Date | string;
}

interface CursorPayload {
  createdAt: string;
  id: number;
}

const ACTOR_ID_PATTERN = /^access:[0-9a-f]{64}$/u;
const SESSION_ID_PATTERN = /^access-session:[0-9a-f]{64}$/u;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const BLOB_KEY_PATTERN = /^[A-Za-z0-9_./:-]+$/u;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

function fail(code: ReviewQueueRepositoryErrorCode): never {
  throw new ReviewQueueRepositoryError(code);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("CANCELLED");
}

async function awaitAbortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) fail("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function requireDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail("CORRUPT_RECORD");
  return date;
}

function requireClock(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Review clock must be a finite Date");
  }
  return new Date(value);
}

function requirePositiveId(value: unknown): number {
  const numeric = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) <= 0) fail("CORRUPT_RECORD");
  return Number(numeric);
}

function requirePositiveVersion(value: unknown): number {
  const numeric = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) <= 0) fail("CORRUPT_RECORD");
  return Number(numeric);
}

function parseCandidateId(value: string): number {
  const parsed = reviewCandidateIdSchema.parse(value);
  const id = Number(parsed.slice("review-candidate:".length));
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("Invalid review candidate ID");
  return id;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CORRUPT_RECORD");
  }
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function parseAnomalyCodes(value: unknown): OfficialOfferAnomalyCode[] {
  if (!Array.isArray(value) || value.length > 20) fail("CORRUPT_RECORD");
  const parsed = value.map((entry) => {
    const result = officialOfferAnomalyCodeSchema.safeParse(entry);
    if (!result.success) fail("CORRUPT_RECORD");
    return result.data;
  });
  if (new Set(parsed).size !== parsed.length) fail("CORRUPT_RECORD");
  return parsed;
}

function immutableCandidate(row: CandidateRow): ExtractedOfficialOfferCandidateV1 {
  const normalized = recordValue(row.normalized_fields);
  if (normalized.contractVersion !== 1) fail("CORRUPT_RECORD");
  const anomalyCodes = parseAnomalyCodes(row.anomaly_codes);
  const normalizedAnomalies = parseAnomalyCodes(normalized.anomalyCodes);
  if (stableJson(anomalyCodes) !== stableJson(normalizedAnomalies)) fail("CORRUPT_RECORD");
  const parsed = extractedOfficialOfferCandidateV1Schema.safeParse({
    ...recordValue(normalized.candidate),
    anomalyCodes,
  });
  if (!parsed.success) fail("CORRUPT_RECORD");
  return parsed.data;
}

function validatedCandidate(row: CandidateRow): ExtractedOfficialOfferCandidateV1 {
  const candidate = immutableCandidate(row);
  const confidence = Number(row.confidence);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    fail("CORRUPT_RECORD");
  }
  if (candidate.provenance.confidence !== confidence) fail("CORRUPT_RECORD");
  if (candidate.provenance.method !== row.extraction_method) fail("CORRUPT_RECORD");
  return candidate;
}

function reviewableExtractionDisposition(
  row: CandidateRow,
): "exact-match" | "review-required" {
  const normalized = recordValue(row.normalized_fields);
  if (
    normalized.publicationRoute !== "human-review-required"
    || (normalized.disposition !== "exact-match"
      && normalized.disposition !== "review-required")
  ) fail("CORRUPT_RECORD");
  return normalized.disposition;
}

function requireCaptureLocator(
  row: CandidateRow,
  candidate: ExtractedOfficialOfferCandidateV1,
): PrivateReviewCaptureLocator {
  const candidateId = requirePositiveId(row.candidate_id);
  if (
    typeof row.blob_key !== "string"
    || row.blob_key.length < 1
    || row.blob_key.length > 1_024
    || row.blob_key.startsWith("/")
    || row.blob_key.includes("..")
    || !BLOB_KEY_PATTERN.test(row.blob_key)
    || !CHECKSUM_PATTERN.test(row.capture_checksum)
    || !Number.isSafeInteger(row.byte_length)
    || row.byte_length <= 0
    || row.byte_length > MAX_CAPTURE_BYTES
    || !["private_review", "public_display"].includes(row.rights_classification)
  ) {
    fail("CORRUPT_RECORD");
  }
  const cropReference = `review-crop:${createHash("sha256")
    .update(`v1\0${candidateId}\0${row.capture_checksum}\0${candidate.provenance.evidenceLocator}`, "utf8")
    .digest("hex")}`;
  return Object.freeze({
    blobKey: row.blob_key,
    byteLength: row.byte_length,
    candidateId: `review-candidate:${candidateId}`,
    candidateVersion: 0,
    checksumSha256: row.capture_checksum,
    cropReference,
    evidenceLocator: candidate.provenance.evidenceLocator,
    mimeType: row.mime_type,
    rightsClassification: row.rights_classification as PrivateReviewCaptureLocator["rightsClassification"],
  });
}

function queueCandidate(row: CandidateRow): ReviewQueueCandidateV1 {
  if (row.candidate_status !== "pending") fail("CORRUPT_RECORD");
  const candidate = validatedCandidate(row);
  const extractionDisposition = reviewableExtractionDisposition(row);
  const capture = requireCaptureLocator(row, candidate);
  const {
    candidateKey: omittedCandidateKey,
    geographicScope: omittedGeographicScope,
    ...candidateProjection
  } = candidate;
  void omittedCandidateKey;
  void omittedGeographicScope;
  const reviewSafeCandidate = reviewCandidateProjectionV1Schema.parse({
    ...candidateProjection,
    provenance: {
      ...candidate.provenance,
      evidenceLocator: `review-evidence:${sha256({
        candidateId: requirePositiveId(row.candidate_id),
        evidenceLocator: candidate.provenance.evidenceLocator,
      })}`,
    },
  });
  const parsed = reviewQueueCandidateV1Schema.safeParse({
    approvalEvidence: {
      cropGeometry: "unavailable",
      presentation: "full_capture",
      state: "render_required",
    },
    anomalyCodes: reviewSafeCandidate.anomalyCodes,
    candidate: reviewSafeCandidate,
    candidateId: `review-candidate:${requirePositiveId(row.candidate_id)}`,
    capture: {
      cropReference: capture.cropReference,
      mimeType: capture.mimeType,
      retrievedAt: requireDate(row.retrieved_at).toISOString(),
      rightsClassification: capture.rightsClassification,
    },
    chain: row.chain,
    confidence: reviewSafeCandidate.provenance.confidence,
    createdAt: requireDate(row.candidate_created_at).toISOString(),
    extractionDisposition,
    extractionMethod: reviewSafeCandidate.provenance.method,
    publication: {
      title: row.publication_title,
      validFrom: requireDate(row.publication_valid_from).toISOString(),
      validUntil: requireDate(row.publication_valid_until).toISOString(),
    },
    scope: {
      id: `review-scope:${requirePositiveId(row.geographic_scope_id)}`,
      kind: row.scope_kind,
      label: row.scope_label,
    },
    sourceId: row.source_id,
    version: 0,
  });
  if (!parsed.success) fail("CORRUPT_RECORD");
  return Object.freeze(parsed.data);
}

function encodeCursor(row: CandidateRow): string {
  const payload: CursorPayload = {
    createdAt: requireDate(row.candidate_created_at).toISOString(),
    id: requirePositiveId(row.candidate_id),
  };
  return `review-cursor:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeCursor(value: string | undefined): CursorPayload | undefined {
  if (value === undefined) return undefined;
  try {
    const encoded = value.slice("review-cursor:".length);
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    const record = recordValue(parsed);
    if (Object.keys(record).sort().join(",") !== "createdAt,id") throw new Error("shape");
    const date = requireDate(record.createdAt).toISOString();
    const id = requirePositiveId(record.id);
    if (date !== record.createdAt) throw new Error("timestamp");
    return { createdAt: date, id };
  } catch {
    throw new TypeError("Invalid private review cursor");
  }
}

function mapDecisionBoundaryError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("HP_REVIEW_VERSION_CONFLICT")) fail("VERSION_CONFLICT");
  if (message.includes("HP_REVIEW_EVIDENCE_UNAVAILABLE")) fail("EVIDENCE_UNAVAILABLE");
  if (message.includes("HP_REVIEW_DECISION_MISMATCH")) fail("DECISION_MISMATCH");
  if (message.includes("HP_REVIEW_TARGET_NOT_FOUND")) fail("TARGET_NOT_FOUND");
  if (message.includes("HP_REVIEW_NOT_FOUND")) fail("NOT_FOUND");
  throw error;
}

export class PostgresReviewQueueRepository implements ReviewQueueRepository {
  constructor(private readonly db: HandleplanDatabase) {}

  async list(
    filtersInput: ReviewQueueFiltersV1,
    atInput: Date,
    signal?: AbortSignal,
  ): Promise<ReviewQueueResponseV1> {
    const filters = reviewQueueFiltersV1Schema.parse(filtersInput);
    const at = requireClock(atInput);
    const cursor = decodeCursor(filters.cursor);
    const rows = await awaitAbortable(this.db.$client<CandidateRow[]>`
      select *
      from public.private_review_candidate_rows_v1(
        ${null}::bigint,
        ${at.toISOString()}::timestamptz,
        ${filters.chain ?? null}::text,
        ${filters.scopeKind ?? null}::text,
        ${filters.confidence?.min ?? null}::integer,
        ${filters.confidence?.max ?? null}::integer,
        ${filters.ageHours?.min ?? null}::integer,
        ${filters.ageHours?.max ?? null}::integer,
        ${filters.anomaly ?? null}::text,
        ${cursor?.createdAt ?? null}::timestamptz,
        ${cursor?.id ?? null}::bigint,
        ${filters.limit + 1}::integer
      )
    `, signal);
    const hasMore = rows.length > filters.limit;
    const visibleRows = rows.slice(0, filters.limit);
    const parsed = reviewQueueResponseV1Schema.safeParse({
      contractVersion: 1,
      items: visibleRows.map(queueCandidate),
      ...(hasMore && visibleRows.length > 0
        ? { nextCursor: encodeCursor(visibleRows[visibleRows.length - 1]!) }
        : {}),
    });
    if (!parsed.success) fail("CORRUPT_RECORD");
    return Object.freeze(parsed.data);
  }

  async get(
    candidateIdInput: string,
    atInput: Date,
    signal?: AbortSignal,
  ): Promise<ReviewQueueCandidateV1> {
    const candidateId = parseCandidateId(candidateIdInput);
    const at = requireClock(atInput);
    const rows = await awaitAbortable(this.db.$client<CandidateRow[]>`
      select *
      from public.private_review_candidate_rows_v1(
        ${candidateId}::bigint, ${at.toISOString()}::timestamptz,
        ${null}::text, ${null}::text, ${null}::integer, ${null}::integer,
        ${null}::integer, ${null}::integer, ${null}::text,
        ${null}::timestamptz, ${null}::bigint, ${1}::integer
      )
    `, signal);
    const row = rows[0];
    if (row === undefined) fail("NOT_FOUND");
    return queueCandidate(row);
  }

  async getPrivateCaptureLocator(
    candidateIdInput: string,
    atInput: Date,
    signal?: AbortSignal,
  ): Promise<PrivateReviewCaptureLocator> {
    const candidateId = parseCandidateId(candidateIdInput);
    const at = requireClock(atInput);
    const rows = await awaitAbortable(this.db.$client<CandidateRow[]>`
      select *
      from public.private_review_candidate_rows_v1(
        ${candidateId}::bigint, ${at.toISOString()}::timestamptz,
        ${null}::text, ${null}::text, ${null}::integer, ${null}::integer,
        ${null}::integer, ${null}::integer, ${null}::text,
        ${null}::timestamptz, ${null}::bigint, ${1}::integer
      )
    `, signal);
    const row = rows[0];
    if (row === undefined) fail("NOT_FOUND");
    const candidate = validatedCandidate(row);
    return requireCaptureLocator(row, candidate);
  }

  async decide(
    requestInput: ReviewDecisionRequestV1,
    actor: Readonly<PrivateReviewActor>,
    evidenceProofSha256: string | undefined,
    actedAtInput: Date,
    signal?: AbortSignal,
  ): Promise<ReviewDecisionResponseV1> {
    const request = reviewDecisionRequestV1Schema.parse(requestInput);
    if (
      !ACTOR_ID_PATTERN.test(actor.actorId)
      || !SESSION_ID_PATTERN.test(actor.sessionId)
      || (evidenceProofSha256 !== undefined && !CHECKSUM_PATTERN.test(evidenceProofSha256))
      || ((request.action === "reject") !== (evidenceProofSha256 === undefined))
    ) {
      throw new TypeError("Invalid private review evidence actor or proof");
    }
    requireClock(actedAtInput); // Compatibility clock is validated, never trusted for persistence.
    const candidateId = parseCandidateId(request.candidateId);
    const decision = request.action === "reject" ? undefined : request.decision;
    const target = decision?.target;
    const pricing = decision?.pricing;
    const eligibility = decision?.eligibility;
    throwIfCancelled(signal);

    try {
      const rows = await awaitAbortable(this.db.$client<DecisionRow[]>`
        select *
        from public.private_review_decide_v2(
          ${candidateId}::bigint,
          ${request.expectedVersion}::integer,
          ${request.action}::text,
          ${actor.actorId}::text,
          ${actor.sessionId}::text,
          ${evidenceProofSha256 ?? null}::text,
          ${request.reason}::text,
          ${target?.kind ?? null}::text,
          ${target?.gtin ?? null}::text,
          ${null}::text,
          ${pricing?.kind ?? null}::text,
          ${pricing?.kind === "unit" ? pricing.offerPriceOre : null}::integer,
          ${pricing?.kind === "unit"
            ? pricing.beforePriceOre ?? null
            : pricing?.kind === "multibuy" ? pricing.beforeUnitPriceOre ?? null : null}::integer,
          ${pricing?.kind === "multibuy" ? pricing.quantity : null}::integer,
          ${pricing?.kind === "multibuy" ? pricing.totalOre : null}::integer,
          ${eligibility?.kind ?? null}::text,
          ${eligibility?.kind === "member" ? eligibility.programId : null}::text,
          ${decision?.validity.startsAt ?? null}::timestamptz,
          ${decision?.validity.endsAt ?? null}::timestamptz,
          ${decision === undefined ? null : `{${decision.channels.join(",")}}`}::text[]
        )
      `, signal);
      if (rows.length !== 1) fail("CORRUPT_RECORD");
      const row = rows[0]!;
      const actionId = requirePositiveId(row.action_id);
      const newVersion = requirePositiveVersion(row.new_version);
      const offerId = row.offer_id === null ? undefined : requirePositiveId(row.offer_id);
      if (!['approved', 'rejected'].includes(row.review_state)) fail("CORRUPT_RECORD");
      const parsed = reviewDecisionResponseV1Schema.safeParse({
        actedAt: requireDate(row.acted_at).toISOString(),
        actionId: `review-action:${actionId}`,
        candidateId: request.candidateId,
        contractVersion: 1,
        newVersion,
        ...(offerId === undefined ? {} : { offerId: `review-offer:${offerId}` }),
        state: row.review_state,
      });
      if (!parsed.success) fail("CORRUPT_RECORD");
      throwIfCancelled(signal);
      return Object.freeze(parsed.data);
    } catch (error) {
      if (error instanceof ReviewQueueRepositoryError) throw error;
      mapDecisionBoundaryError(error);
    }
  }

  async recordEvidenceRender(
    input: Readonly<PrivateReviewEvidenceRenderInput>,
    atInput: Date,
    signal?: AbortSignal,
  ): Promise<PrivateReviewEvidenceRenderReceipt> {
    const candidateId = parseCandidateId(input.candidateId);
    requireClock(atInput);
    if (
      !Number.isSafeInteger(input.expectedVersion)
      || input.expectedVersion < 0
      || !CHECKSUM_PATTERN.test(input.checksumSha256)
      || !/^review-crop:[0-9a-f]{64}$/u.test(input.cropReference)
      || !CHECKSUM_PATTERN.test(input.evidenceProofSha256)
      || !ACTOR_ID_PATTERN.test(input.actorId)
      || !SESSION_ID_PATTERN.test(input.sessionId)
      || input.presentation !== "full_capture"
      || !["private_review", "public_display"].includes(input.rightsClassification)
    ) {
      throw new TypeError("Invalid private review evidence render");
    }
    const expiresAt = requireDate(input.expiresAt);
    try {
      const rows = await awaitAbortable(this.db.$client<EvidenceRenderRow[]>`
        select *
        from public.private_review_record_evidence_render_v1(
          ${candidateId}::bigint,
          ${input.expectedVersion}::integer,
          ${input.checksumSha256}::text,
          ${input.cropReference}::text,
          ${input.presentation}::text,
          ${input.rightsClassification}::text,
          ${input.actorId}::text,
          ${input.sessionId}::text,
          ${input.evidenceProofSha256}::text,
          ${expiresAt.toISOString()}::timestamptz
        )
      `, signal);
      if (rows.length !== 1) fail("CORRUPT_RECORD");
      const row = rows[0]!;
      const renderedAt = requireDate(row.rendered_at).toISOString();
      const persistedExpiresAt = requireDate(row.expires_at).toISOString();
      if (persistedExpiresAt !== expiresAt.toISOString()) fail("CORRUPT_RECORD");
      return Object.freeze({
        evidenceRenderId: `review-evidence-render:${requirePositiveId(row.evidence_render_id)}`,
        expiresAt: persistedExpiresAt,
        renderedAt,
      });
    } catch (error) {
      if (error instanceof ReviewQueueRepositoryError) throw error;
      mapDecisionBoundaryError(error);
    }
  }
}
