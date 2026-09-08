import { createHash } from "node:crypto";

import {
  MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS,
  MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS,
  canonicalOfficialOfferEditionIdentity,
  geographicScopeSchema,
  officialOfferAuthorizationOrderKey,
  officialOfferAuthorizationFenceV1Schema,
  officialOfferCaptureMetadataV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  officialOfferExtractionTimingV1Schema,
  officialOfferExtractionValidationContextV1Schema,
  validateOfficialOfferExtraction,
  type GeographicScope,
  type OfficialOfferAuthorizationCapability,
  type OfficialOfferAuthorizationFenceV1,
  type OfficialOfferCaptureMetadataV1,
  type OfficialOfferEditionDiscoveryInputV1,
  type OfficialOfferExtractionEnvelopeV1,
  type OfficialOfferExtractionTimingV1,
  type OfficialOfferExtractionValidationContext,
  type OfficialOfferExtractionValidation,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

export type OfficialOfferFoundationErrorCode =
  | "CANCELLED"
  | "CAPTURE_CONFLICT"
  | "EDITION_CONFLICT"
  | "EXTRACTION_CONFLICT"
  | "SOURCE_AUTHORIZATION_STALE";

export class OfficialOfferFoundationError extends Error {
  constructor(readonly code: OfficialOfferFoundationErrorCode) {
    super(`Official-offer foundation operation failed: ${code}`);
    this.name = "OfficialOfferFoundationError";
  }
}

export interface RecordedOfficialOfferEdition {
  created: boolean;
  id: number;
  status: "captured" | "discovered" | "expired" | "failed" | "published";
}

export interface RecordedOfficialOfferCapture {
  blobKey: string;
  created: boolean;
  id: number;
  retrievedAt: string;
}

export interface RecordedOfficialOfferExtraction {
  counts: OfficialOfferExtractionValidation["counts"];
  created: boolean;
  id: number;
  status: "completed" | "degraded" | "failed";
}

interface PublicationRow {
  chain: string;
  content_kind: string | null;
  declared_geographic_scope: unknown;
  discovered_at: Date;
  discovery_permission_id: unknown;
  edition_identity_sha256: string | null;
  external_id: string;
  geographic_scope_id: unknown;
  id: unknown;
  source_id: string;
  status: string;
  title: string;
  valid_from: Date;
  valid_until: Date;
}

interface CaptureExtractionBindingRow extends PublicationRow {
  capture_permission_id: unknown;
  checksum: string;
  capture_retrieved_at: Date;
  database_clock: Date;
  rights_classification: string;
}

function cancelledError(): OfficialOfferFoundationError {
  return new OfficialOfferFoundationError("CANCELLED");
}

function rethrowFoundationSqlError(error: unknown): never {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "42501"
  ) {
    throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
  }
  throw error;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfCancelled(signal);
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

function dateValue(value: unknown, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid ${label} from PostgreSQL`);
  return date;
}

function sameDate(left: unknown, right: string): boolean {
  return dateValue(left, "timestamp").toISOString() === right;
}

function jsonKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${jsonKey(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requirePositiveId(value: unknown, label: string): number {
  const numeric = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) <= 0) {
    throw new TypeError(`PostgreSQL returned an invalid ${label}`);
  }
  return Number(numeric);
}

function requireBlobKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || value.startsWith("/")
    || value.includes("..")
    || !/^[A-Za-z0-9_./:-]+$/u.test(value)
  ) {
    throw new TypeError("blobKey must be a bounded relative private-storage key");
  }
}

function publicationStatus(value: unknown): RecordedOfficialOfferEdition["status"] {
  if (!["captured", "discovered", "expired", "failed", "published"].includes(String(value))) {
    throw new TypeError("PostgreSQL returned an invalid publication status");
  }
  return value as RecordedOfficialOfferEdition["status"];
}

function requireStringArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > maximum
    || value.some((entry) => typeof entry !== "string" || entry.trim() !== entry)
    || new Set(value).size !== value.length
  ) {
    throw new TypeError(`PostgreSQL returned invalid ${label}`);
  }
  return Object.freeze((value as string[]).slice().sort());
}

function canonicalScope(scopeInput: unknown): GeographicScope {
  const scope = geographicScopeSchema.parse(scopeInput);
  switch (scope.kind) {
    case "regions":
      return { ...scope, regionCodes: [...scope.regionCodes].sort() };
    case "postal-set":
      return { ...scope, postalCodes: [...scope.postalCodes].sort() };
    case "stores":
      return { ...scope, storeIds: [...scope.storeIds].sort() };
    default:
      return scope;
  }
}

function sameScope(left: unknown, right: unknown): boolean {
  try {
    return jsonKey(canonicalScope(left)) === jsonKey(canonicalScope(right));
  } catch {
    return false;
  }
}

function editionIdentitySha256(edition: OfficialOfferEditionDiscoveryInputV1): string {
  return createHash("sha256")
    .update(canonicalOfficialOfferEditionIdentity(edition), "utf8")
    .digest("hex");
}

function extractionStatus(value: unknown): RecordedOfficialOfferExtraction["status"] {
  if (!["completed", "degraded", "failed"].includes(String(value))) {
    throw new TypeError("PostgreSQL returned an invalid extraction status");
  }
  return value as RecordedOfficialOfferExtraction["status"];
}

function exactEditionMatch(
  row: PublicationRow,
  edition: OfficialOfferEditionDiscoveryInputV1,
): boolean {
  return row.source_id === edition.sourceId
    && row.external_id === edition.externalEditionId
    && row.chain === edition.chain
    && row.title === edition.title
    && requirePositiveId(row.geographic_scope_id, "publication geographic scope id")
      === edition.geographicScopeId
    && sameDate(row.valid_from, edition.validFrom)
    && sameDate(row.valid_until, edition.validUntil)
    && sameDate(row.discovered_at, edition.discoveredAt)
    && row.content_kind === edition.contentKind
    && sameScope(row.declared_geographic_scope, edition.declaredGeographicScope)
    && row.edition_identity_sha256 === editionIdentitySha256(edition)
    && requirePositiveId(row.discovery_permission_id, "discovery permission id") > 0;
}

function validateExtractionTiming(
  envelope: OfficialOfferExtractionEnvelopeV1,
  timingInput: OfficialOfferExtractionTimingV1,
  captureRetrievedAtInput: unknown,
  databaseClockInput: unknown,
): OfficialOfferExtractionTimingV1 {
  const timing = officialOfferExtractionTimingV1Schema.parse(timingInput);
  const captureRetrievedAt = dateValue(captureRetrievedAtInput, "capture retrieval clock").getTime();
  const databaseClock = dateValue(databaseClockInput, "database clock").getTime();
  const serverStartedAt = Date.parse(timing.serverStartedAt);
  const serverCompletedAt = Date.parse(timing.serverCompletedAt);
  const sourceStartedAt = Date.parse(envelope.startedAt);
  const sourceCompletedAt = Date.parse(envelope.completedAt);
  if (
    serverStartedAt < captureRetrievedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || serverCompletedAt > databaseClock + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || databaseClock - serverStartedAt
      > MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceStartedAt < captureRetrievedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceStartedAt < serverStartedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceCompletedAt > serverCompletedAt + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceCompletedAt - sourceStartedAt > MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS
  ) {
    throw new OfficialOfferFoundationError("EXTRACTION_CONFLICT");
  }
  return timing;
}

function extractionCounts(
  envelope: OfficialOfferExtractionEnvelopeV1,
  validation: OfficialOfferExtractionValidation,
  persistedCandidates: number,
): Record<string, number | string> {
  return {
    envelopeSha256: createHash("sha256").update(jsonKey(envelope), "utf8").digest("hex"),
    exactMatch: validation.counts.exactMatch,
    persistedCandidates,
    rejected: validation.counts.rejected,
    reviewRequired: validation.counts.reviewRequired,
    total: validation.counts.total,
    validationSha256: createHash("sha256").update(jsonKey(validation), "utf8").digest("hex"),
  };
}

function canonicalCapabilities(
  capabilities: readonly OfficialOfferAuthorizationCapability[],
): readonly OfficialOfferAuthorizationCapability[] {
  return Object.freeze([...capabilities].sort());
}

function assertEditionAuthorizationFence(
  edition: OfficialOfferEditionDiscoveryInputV1,
  authorization: OfficialOfferAuthorizationFenceV1,
): void {
  if (
    authorization.sourceId !== edition.sourceId
    || jsonKey(canonicalCapabilities(authorization.capabilities))
      !== jsonKey(canonicalCapabilities(edition.authorization.capabilities))
    || officialOfferAuthorizationOrderKey(authorization.reviewedAt)
      !== officialOfferAuthorizationOrderKey(edition.authorization.reviewedAt)
    || (authorization.validUntil === undefined) !== (edition.authorization.validUntil === undefined)
    || (
      authorization.validUntil !== undefined
      && edition.authorization.validUntil !== undefined
      && officialOfferAuthorizationOrderKey(authorization.validUntil)
        !== officialOfferAuthorizationOrderKey(edition.authorization.validUntil)
    )
  ) {
    throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
  }
}

export class PostgresOfficialOfferFoundationRepository {
  constructor(private readonly db: HandleplanDatabase) {}

  async recordEdition(
    input: unknown,
    authorizationInput: unknown,
    signal?: AbortSignal,
  ): Promise<RecordedOfficialOfferEdition> {
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse(input);
    const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
    assertEditionAuthorizationFence(edition, authorization);
    throwIfCancelled(signal);
    try {
      const rows = await awaitAbortable(this.db.$client<{
        created: boolean;
        id: unknown;
        status: unknown;
      }[]>`
        select * from public.record_official_offer_edition_v1(
          ${JSON.stringify(edition)}::jsonb,
          ${JSON.stringify(authorization)}::jsonb
        )
      `, signal);
      const row = rows[0];
      if (row === undefined) throw new OfficialOfferFoundationError("EDITION_CONFLICT");
      throwIfCancelled(signal);
      return Object.freeze({
        created: row.created,
        id: requirePositiveId(row.id, "publication id"),
        status: publicationStatus(row.status),
      });
    } catch (error) {
      rethrowFoundationSqlError(error);
    }
  }

  async recordCapture(
    input: unknown,
    blobKeyInput: unknown,
    authorizationInput: unknown,
    signal?: AbortSignal,
  ): Promise<RecordedOfficialOfferCapture> {
    const metadata = officialOfferCaptureMetadataV1Schema.parse(input);
    const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
    if (authorization.sourceId !== metadata.sourceId) {
      throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
    }
    requireBlobKey(blobKeyInput);
    const blobKey = blobKeyInput;
    throwIfCancelled(signal);
    try {
      const rows = await awaitAbortable(this.db.$client<{
        blob_key: string;
        created: boolean;
        id: unknown;
        retrieved_at: Date;
      }[]>`
        select * from public.record_official_offer_capture_v1(
          ${JSON.stringify(metadata)}::jsonb,
          ${blobKey},
          ${JSON.stringify(authorization)}::jsonb
        )
      `, signal);
      const row = rows[0];
      if (row === undefined || row.blob_key !== blobKey) {
        throw new OfficialOfferFoundationError("CAPTURE_CONFLICT");
      }
      throwIfCancelled(signal);
      return Object.freeze({
        blobKey,
        created: row.created,
        id: requirePositiveId(row.id, "capture id"),
        retrievedAt: dateValue(row.retrieved_at, "capture retrieval clock").toISOString(),
      });
    } catch (error) {
      rethrowFoundationSqlError(error);
    }
  }

  async recordExtraction(
    captureIdInput: unknown,
    envelopeInput: unknown,
    editionInput: unknown,
    validationContextInput: unknown,
    timingInput: unknown,
    authorizationInput: unknown,
    ocrAuthorizationInput?: unknown,
    signal?: AbortSignal,
  ): Promise<RecordedOfficialOfferExtraction> {
    const captureId = requirePositiveId(captureIdInput, "capture id");
    const envelope = officialOfferExtractionEnvelopeV1Schema.parse(envelopeInput);
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse(editionInput);
    const validationContext = officialOfferExtractionValidationContextV1Schema.parse(
      validationContextInput,
    );
    const timing = officialOfferExtractionTimingV1Schema.parse(timingInput);
    const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
    const ocrAuthorization = ocrAuthorizationInput === undefined
      ? undefined
      : officialOfferAuthorizationFenceV1Schema.parse(ocrAuthorizationInput);
    assertEditionAuthorizationFence(edition, authorization);
    if ((envelope.method === "ocr") !== (ocrAuthorization !== undefined)) {
      throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
    }
    throwIfCancelled(signal);
    try {
      return await this.db.$client.begin(async (transaction) => {
        const [capture] = await awaitAbortable(transaction<CaptureExtractionBindingRow[]>`
        select
          capture.checksum, capture.retrieved_at as capture_retrieved_at,
          capture.capture_permission_id, capture.rights_classification,
          clock_timestamp() as database_clock,
          publication.id, publication.source_id, publication.chain,
          publication.external_id, publication.title,
          publication.valid_from, publication.valid_until,
          publication.geographic_scope_id, publication.status,
          publication.discovered_at, publication.content_kind,
          publication.declared_geographic_scope,
          publication.edition_identity_sha256,
          publication.discovery_permission_id
        from publication_captures capture
        inner join publications publication on publication.id = capture.publication_id
        where capture.id = ${captureId}
        limit 1
      `, signal);
        if (
          capture?.checksum !== envelope.captureChecksumSha256
          || capture?.external_id !== edition.externalEditionId
          || !exactEditionMatch(capture, edition)
          || requirePositiveId(capture.capture_permission_id, "capture permission id") <= 0
        ) {
          throw new OfficialOfferFoundationError("EXTRACTION_CONFLICT");
        }
        validateExtractionTiming(
          envelope,
          timing,
          capture.capture_retrieved_at,
          capture.database_clock,
        );
        const storedEdition = officialOfferEditionDiscoveryInputV1Schema.parse({
        contractVersion: 1,
        sourceId: capture.source_id,
        externalEditionId: capture.external_id,
        chain: capture.chain,
        title: capture.title,
        contentKind: capture.content_kind,
        geographicScopeId: requirePositiveId(
          capture.geographic_scope_id,
          "publication geographic scope id",
        ),
        declaredGeographicScope: canonicalScope(capture.declared_geographic_scope),
        validFrom: dateValue(capture.valid_from, "publication start").toISOString(),
        validUntil: dateValue(capture.valid_until, "publication end").toISOString(),
        discoveredAt: dateValue(capture.discovered_at, "publication discovery").toISOString(),
        authorization: {
          decision: "approved",
          capabilities: authorization.capabilities,
          reviewedAt: authorization.reviewedAt,
          ...(authorization.validUntil === undefined
            ? {}
            : { validUntil: authorization.validUntil }),
        },
        });
        const validation = validateOfficialOfferExtraction(
          envelope,
          storedEdition,
          validationContext,
        );
        const uniqueCandidates = [...new Map(
          validation.candidates.map((candidate) => [candidate.candidate.candidateKey, candidate]),
        ).values()];
        const counts = extractionCounts(envelope, validation, uniqueCandidates.length);
        const payload = {
          contractVersion: 1,
          envelope,
          edition,
          timing,
          authorization,
          ...(ocrAuthorization === undefined ? {} : { ocrAuthorization }),
          counts,
          validationStatus: validation.status,
          ...(validation.errorClass === undefined
            ? {}
            : { validationErrorClass: validation.errorClass }),
          candidates: uniqueCandidates,
        };
        const rows = await awaitAbortable(transaction<{
          counts: unknown;
          created: boolean;
          id: unknown;
          status: unknown;
        }[]>`
          select * from public.record_official_offer_extraction_v1(
            ${captureId}, ${JSON.stringify(payload)}::jsonb
          )
        `, signal);
        const row = rows[0];
        if (row === undefined || jsonKey(row.counts) !== jsonKey(counts)) {
          throw new OfficialOfferFoundationError("EXTRACTION_CONFLICT");
        }
        throwIfCancelled(signal);
        return Object.freeze({
          counts: validation.counts,
          created: row.created,
          id: requirePositiveId(row.id, "extraction id"),
          status: extractionStatus(row.status),
        });
      });
    } catch (error) {
      rethrowFoundationSqlError(error);
    }
  }

}

export type {
  OfficialOfferCaptureMetadataV1,
  OfficialOfferEditionDiscoveryInputV1,
  OfficialOfferExtractionEnvelopeV1,
  OfficialOfferExtractionValidationContext,
};
