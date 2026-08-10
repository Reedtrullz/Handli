import { createHash } from "node:crypto";

import {
  OFFICIAL_OFFER_FOUNDATION_ACTIVATION,
  MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS,
  MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS,
  canonicalTimestampSchema,
  officialOfferAuthorizationFenceV1Schema,
  officialOfferCaptureMetadataV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  officialOfferExtractionTimingV1Schema,
  type OfficialOfferAuthorizationFenceV1,
  type OfficialOfferCaptureMetadataV1,
  type OfficialOfferEditionDiscoveryInputV1,
  type OfficialOfferExtractionEnvelopeV1,
  type OfficialOfferExtractionTimingV1,
  type OfficialOfferExtractionValidationContext,
  type OfficialOfferExtractionValidation,
} from "@handleplan/domain";
import { z } from "zod";

export const OFFICIAL_OFFER_SOURCE_CAPABILITIES = [
  "capture",
  "discover",
  "extract",
  "ocr",
] as const;

export type OfficialOfferSourceCapability =
  (typeof OFFICIAL_OFFER_SOURCE_CAPABILITIES)[number];

export type OfficialOfferFoundationWorkerErrorCode =
  | "BLOB_CONFLICT"
  | "CANCELLED"
  | "CHECKSUM_MISMATCH"
  | "EXTRACTOR_CONTRACT"
  | "INVALID_INPUT"
  | "NO_EXTRACTOR_AVAILABLE"
  | "RESOLVER_CONTRACT"
  | "SOURCE_DISABLED";

export class OfficialOfferFoundationWorkerError extends Error {
  constructor(readonly code: OfficialOfferFoundationWorkerErrorCode) {
    super(`Official-offer worker foundation failed: ${code}`);
    this.name = "OfficialOfferFoundationWorkerError";
  }
}

const blobWriteResultSchema = z
  .object({
    contractVersion: z.literal(1),
    state: z.enum(["already-present", "stored"]),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    byteLength: z.number().int().positive().max(50 * 1024 * 1024),
  })
  .strict();

const extractorOutcomeSchema = z.discriminatedUnion("state", [
  z.object({
    contractVersion: z.literal(1),
    state: z.literal("available"),
    envelope: z.unknown(),
  }).strict(),
  z.object({
    contractVersion: z.literal(1),
    state: z.literal("unavailable"),
    reason: z.enum(["NO_EMBEDDED_TEXT", "NO_OCR_INPUT", "NO_STRUCTURED_CONTENT"]),
  }).strict(),
]);

export interface OfficialOfferSourceAccessPolicy {
  getDecision(
    sourceId: string,
    capability: OfficialOfferSourceCapability,
    asOf: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface OfficialOfferPrivateBlobWrite {
  contractVersion: 1;
  blobKey: string;
  byteLength: number;
  bytes: Uint8Array;
  checksumSha256: string;
  mimeType: string;
  rightsClassification: "extract_only" | "private_review" | "public_display";
}

/** Implementations must never overwrite an existing key with different bytes. */
export interface OfficialOfferPrivateBlobStore {
  putIfAbsent(
    write: Readonly<OfficialOfferPrivateBlobWrite>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface OfficialOfferExtractionInput {
  contractVersion: 1;
  captureId: number;
  captureMetadata: OfficialOfferCaptureMetadataV1;
  privateBlobKey: string;
}

export interface OfficialOfferExtractor {
  readonly extractorVersion: string;
  readonly method: "embedded-text" | "ocr" | "structured";
  extract(
    input: Readonly<OfficialOfferExtractionInput>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Returns every requested GTIN exactly once; an empty array means no exact match. */
export interface OfficialOfferExactProductResolver {
  resolveGtins(
    gtins: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface OfficialOfferFoundationRepositoryPort {
  recordEdition(
    input: OfficialOfferEditionDiscoveryInputV1,
    authorization: OfficialOfferAuthorizationFenceV1,
    signal?: AbortSignal,
  ): Promise<{ id: number }>;
  recordCapture(
    input: OfficialOfferCaptureMetadataV1,
    blobKey: string,
    authorization: OfficialOfferAuthorizationFenceV1,
    signal?: AbortSignal,
  ): Promise<{ id: number; retrievedAt: string }>;
  recordExtraction(
    captureId: number,
    envelope: OfficialOfferExtractionEnvelopeV1,
    edition: OfficialOfferEditionDiscoveryInputV1,
    validationContext: OfficialOfferExtractionValidationContext,
    timing: OfficialOfferExtractionTimingV1,
    authorization: OfficialOfferAuthorizationFenceV1,
    ocrAuthorization?: OfficialOfferAuthorizationFenceV1,
    signal?: AbortSignal,
  ): Promise<{
    counts: OfficialOfferExtractionValidation["counts"];
    id: number;
    status: "completed" | "degraded" | "failed";
  }>;
}

export interface OfficialOfferFoundationPipelineInput {
  contractVersion: 1;
  bytes: Uint8Array;
  edition: OfficialOfferEditionDiscoveryInputV1;
  expectedChecksumSha256?: string;
  mimeType: string;
  rightsClassification: "extract_only" | "private_review" | "public_display";
}

export interface OfficialOfferFoundationPipelineReceipt {
  readonly activationEnabled: false;
  readonly contractVersion: 1;
  readonly counts: OfficialOfferExtractionValidation["counts"];
  readonly extractionMethod: "embedded-text" | "ocr" | "structured";
  readonly extractionRunId: number;
  readonly status: "completed" | "degraded" | "failed";
}

export interface OfficialOfferFoundationPipelineOptions {
  embeddedTextExtractor?: OfficialOfferExtractor;
  exactProductResolver: OfficialOfferExactProductResolver;
  expectedLayoutFingerprintsSha256: readonly string[];
  expectedSchemaFingerprintSha256: string;
  now: () => Date;
  ocrExtractor?: OfficialOfferExtractor;
  privateBlobStore: OfficialOfferPrivateBlobStore;
  repository: OfficialOfferFoundationRepositoryPort;
  sourceAccessPolicy: OfficialOfferSourceAccessPolicy;
  structuredExtractor: OfficialOfferExtractor;
}

const ALLOWED_PIPELINE_INPUT_KEYS = new Set([
  "bytes",
  "contractVersion",
  "edition",
  "expectedChecksumSha256",
  "mimeType",
  "rightsClassification",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(code: OfficialOfferFoundationWorkerErrorCode): never {
  throw new OfficialOfferFoundationWorkerError(code);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) fail("CANCELLED");
}

function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail("INVALID_INPUT");
  return Number(value);
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("INVALID_INPUT");
  return value.toISOString();
}

function assertEnvelopeTiming(
  envelope: OfficialOfferExtractionEnvelopeV1,
  captureRetrievedAt: string,
  timingInput: OfficialOfferExtractionTimingV1,
): void {
  const timing = officialOfferExtractionTimingV1Schema.parse(timingInput);
  const captureAt = Date.parse(captureRetrievedAt);
  const sourceStartedAt = Date.parse(envelope.startedAt);
  const sourceCompletedAt = Date.parse(envelope.completedAt);
  const serverStartedAt = Date.parse(timing.serverStartedAt);
  const serverCompletedAt = Date.parse(timing.serverCompletedAt);
  if (
    sourceStartedAt < captureAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceStartedAt < serverStartedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceCompletedAt > serverCompletedAt + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceCompletedAt - sourceStartedAt > MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS
  ) {
    fail("EXTRACTOR_CONTRACT");
  }
}

function privateBlobKey(sourceId: string, publicationId: number, checksum: string): string {
  const sourceNamespace = createHash("sha256").update(sourceId, "utf8").digest("hex");
  return `official-offers/private/v1/${sourceNamespace}/${publicationId}/${checksum}`;
}

function exactLookupContext(value: unknown, requestedGtins: readonly string[]) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "contractVersion,matchesByGtin"
    || (value as { contractVersion?: unknown }).contractVersion !== 1
  ) {
    fail("RESOLVER_CONTRACT");
  }
  const matchesByGtin = (value as { matchesByGtin?: unknown }).matchesByGtin;
  if (matchesByGtin === null || typeof matchesByGtin !== "object" || Array.isArray(matchesByGtin)) {
    fail("RESOLVER_CONTRACT");
  }
  const record = matchesByGtin as Record<string, unknown>;
  const requested = [...new Set(requestedGtins)].sort();
  const returned = Object.keys(record).sort();
  if (
    requested.length > 500
    || requested.length !== returned.length
    || requested.some((gtin, index) => gtin !== returned[index])
  ) {
    fail("RESOLVER_CONTRACT");
  }
  const normalized: Record<string, readonly string[]> = {};
  for (const gtin of requested) {
    const matches = record[gtin];
    if (!Array.isArray(matches) || matches.length > 20) fail("RESOLVER_CONTRACT");
    const identifiers = matches.map((identifier) => {
      if (
        typeof identifier !== "string"
        || identifier.length < 1
        || identifier.length > 200
        || identifier.trim() !== identifier
      ) {
        fail("RESOLVER_CONTRACT");
      }
      return identifier;
    });
    if (new Set(identifiers).size !== identifiers.length) fail("RESOLVER_CONTRACT");
    normalized[gtin] = Object.freeze(identifiers);
  }
  return Object.freeze(normalized);
}

function verifiedCounts(
  value: unknown,
  method: OfficialOfferExtractionEnvelopeV1["method"],
): OfficialOfferExtractionValidation["counts"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("EXTRACTOR_CONTRACT");
  }
  const counts = value as Record<string, unknown>;
  if (
    Object.keys(counts).sort().join(",") !== "exactMatch,rejected,reviewRequired,total"
    || ![counts.exactMatch, counts.rejected, counts.reviewRequired, counts.total].every(
      (entry) => Number.isSafeInteger(entry) && Number(entry) >= 0,
    )
    || Number(counts.total) !== Number(counts.exactMatch)
      + Number(counts.rejected)
      + Number(counts.reviewRequired)
    || (method === "ocr" && counts.exactMatch !== 0)
  ) {
    fail("EXTRACTOR_CONTRACT");
  }
  return Object.freeze({
    exactMatch: Number(counts.exactMatch),
    rejected: Number(counts.rejected),
    reviewRequired: Number(counts.reviewRequired),
    total: Number(counts.total),
  });
}

export class OfficialOfferFoundationPipeline {
  private readonly expectedLayouts: readonly string[];
  private readonly expectedSchema: string;

  constructor(private readonly options: OfficialOfferFoundationPipelineOptions) {
    if (
      options.structuredExtractor.method !== "structured"
      || (options.embeddedTextExtractor !== undefined
        && options.embeddedTextExtractor.method !== "embedded-text")
      || (options.ocrExtractor !== undefined && options.ocrExtractor.method !== "ocr")
      || options.expectedLayoutFingerprintsSha256.length < 1
      || options.expectedLayoutFingerprintsSha256.length > 20
      || !options.expectedLayoutFingerprintsSha256.every((value) => SHA256_PATTERN.test(value))
      || new Set(options.expectedLayoutFingerprintsSha256).size
        !== options.expectedLayoutFingerprintsSha256.length
      || !SHA256_PATTERN.test(options.expectedSchemaFingerprintSha256)
    ) {
      fail("INVALID_INPUT");
    }
    this.expectedLayouts = Object.freeze([...options.expectedLayoutFingerprintsSha256]);
    this.expectedSchema = options.expectedSchemaFingerprintSha256;
  }

  async captureAndExtract(
    input: OfficialOfferFoundationPipelineInput,
    signal: AbortSignal,
  ): Promise<OfficialOfferFoundationPipelineReceipt> {
    try {
      return await this.execute(input, signal);
    } catch (error) {
      if (signal.aborted) fail("CANCELLED");
      throw error;
    }
  }

  private async execute(
    input: OfficialOfferFoundationPipelineInput,
    signal: AbortSignal,
  ): Promise<OfficialOfferFoundationPipelineReceipt> {
    throwIfCancelled(signal);
    if (
      input === null
      || typeof input !== "object"
      || Object.keys(input).some((key) => !ALLOWED_PIPELINE_INPUT_KEYS.has(key))
      || input.contractVersion !== 1
      || !(input.bytes instanceof Uint8Array)
      || input.bytes.byteLength < 1
      || input.bytes.byteLength > 50 * 1024 * 1024
      || (
        input.expectedChecksumSha256 !== undefined
        && !SHA256_PATTERN.test(input.expectedChecksumSha256)
      )
    ) {
      fail("INVALID_INPUT");
    }
    const editionResult = officialOfferEditionDiscoveryInputV1Schema.safeParse(input.edition);
    if (!editionResult.success) fail("INVALID_INPUT");
    const edition = editionResult.data;
    const discoveryAuthorization = await this.assertAuthorized(edition, "discover", signal);

    const publication = await this.options.repository.recordEdition(
      edition,
      discoveryAuthorization,
      signal,
    );
    const publicationId = positiveId(publication.id);
    throwIfCancelled(signal);
    await this.assertAuthorized(edition, "discover", signal);
    let captureAuthorization = await this.assertAuthorized(
      edition,
      "capture",
      signal,
      input.rightsClassification,
    );

    const immutableBytes = Uint8Array.from(input.bytes);
    const checksumSha256 = createHash("sha256").update(immutableBytes).digest("hex");
    if (
      input.expectedChecksumSha256 !== undefined
      && input.expectedChecksumSha256 !== checksumSha256
    ) {
      fail("CHECKSUM_MISMATCH");
    }
    const retrievedAt = canonicalNow(this.options.now);
    const metadataResult = officialOfferCaptureMetadataV1Schema.safeParse({
      contractVersion: 1,
      publicationId,
      sourceId: edition.sourceId,
      externalEditionId: edition.externalEditionId,
      checksumSha256,
      mimeType: input.mimeType,
      byteLength: immutableBytes.byteLength,
      rightsClassification: input.rightsClassification,
      retrievedAt,
    });
    if (!metadataResult.success) fail("INVALID_INPUT");
    const captureMetadata = metadataResult.data;
    const blobKey = privateBlobKey(edition.sourceId, publicationId, checksumSha256);
    const blobWrite = blobWriteResultSchema.safeParse(
      await this.options.privateBlobStore.putIfAbsent({
        contractVersion: 1,
        blobKey,
        byteLength: immutableBytes.byteLength,
        bytes: immutableBytes,
        checksumSha256,
        mimeType: captureMetadata.mimeType,
        rightsClassification: captureMetadata.rightsClassification,
      }, signal),
    );
    throwIfCancelled(signal);
    if (
      !blobWrite.success
      || blobWrite.data.checksumSha256 !== captureMetadata.checksumSha256
      || blobWrite.data.byteLength !== captureMetadata.byteLength
    ) {
      fail("BLOB_CONFLICT");
    }
    captureAuthorization = await this.assertAuthorized(
      edition,
      "capture",
      signal,
      input.rightsClassification,
    );

    const capture = await this.options.repository.recordCapture(
      captureMetadata,
      blobKey,
      captureAuthorization,
      signal,
    );
    const captureId = positiveId(capture.id);
    const persistedCaptureMetadata = officialOfferCaptureMetadataV1Schema.parse({
      ...captureMetadata,
      retrievedAt: canonicalTimestampSchema.parse(capture.retrievedAt),
    });
    throwIfCancelled(signal);
    await this.assertAuthorized(edition, "capture", signal, input.rightsClassification);

    const serverStartedAt = canonicalNow(this.options.now);
    const selected = await this.extractStructuredFirst(
      edition,
      persistedCaptureMetadata,
      captureId,
      blobKey,
      signal,
    );
    const parsedEnvelope = officialOfferExtractionEnvelopeV1Schema.safeParse(selected.envelope);
    if (
      !parsedEnvelope.success
      || parsedEnvelope.data.method !== selected.extractor.method
      || parsedEnvelope.data.extractorVersion !== selected.extractor.extractorVersion
      || parsedEnvelope.data.captureChecksumSha256 !== captureMetadata.checksumSha256
      || parsedEnvelope.data.captureChecksumSha256 !== blobWrite.data.checksumSha256
    ) {
      fail("EXTRACTOR_CONTRACT");
    }
    const envelope = parsedEnvelope.data;
    const gtins = [...new Set(envelope.candidates.flatMap((candidate) =>
      candidate.product.kind === "exact-identifier" ? [candidate.product.value] : []))].sort();
    const exactProductIdsByGtin = exactLookupContext(
      await this.options.exactProductResolver.resolveGtins(gtins, signal),
      gtins,
    );
    throwIfCancelled(signal);
    const extractionAuthorization = await this.assertAuthorized(
      edition,
      "extract",
      signal,
      input.rightsClassification,
    );
    const ocrAuthorization = envelope.method === "ocr"
      ? await this.assertAuthorized(
          edition,
          "ocr",
          signal,
          input.rightsClassification,
        )
      : undefined;
    const timing = officialOfferExtractionTimingV1Schema.parse({
      contractVersion: 1,
      serverStartedAt,
      serverCompletedAt: canonicalNow(this.options.now),
    });
    assertEnvelopeTiming(envelope, persistedCaptureMetadata.retrievedAt, timing);
    const validationContext = {
      contractVersion: 1 as const,
      expectedLayoutFingerprintsSha256: this.expectedLayouts,
      expectedSchemaFingerprintSha256: this.expectedSchema,
      exactProductIdsByGtin,
    };
    const extraction = await this.options.repository.recordExtraction(
      captureId,
      envelope,
      edition,
      validationContext,
      timing,
      extractionAuthorization,
      ocrAuthorization,
      signal,
    );
    const extractionRunId = positiveId(extraction.id);
    if (!["completed", "degraded", "failed"].includes(extraction.status)) {
      fail("EXTRACTOR_CONTRACT");
    }
    const counts = verifiedCounts(extraction.counts, envelope.method);
    return Object.freeze({
      activationEnabled: OFFICIAL_OFFER_FOUNDATION_ACTIVATION.enabled,
      contractVersion: 1,
      counts,
      extractionMethod: envelope.method,
      extractionRunId,
      status: extraction.status,
    });
  }

  private async extractStructuredFirst(
    edition: OfficialOfferEditionDiscoveryInputV1,
    captureMetadata: OfficialOfferCaptureMetadataV1,
    captureId: number,
    privateBlobKeyValue: string,
    signal: AbortSignal,
  ): Promise<{ envelope: unknown; extractor: OfficialOfferExtractor }> {
    const nonOcrExtractors = [
      this.options.structuredExtractor,
      this.options.embeddedTextExtractor,
    ].filter((extractor): extractor is OfficialOfferExtractor => extractor !== undefined);
    for (const extractor of nonOcrExtractors) {
      const outcome = await this.runExtractor(
        extractor,
        edition,
        {
          contractVersion: 1,
          captureId,
          captureMetadata,
          privateBlobKey: privateBlobKeyValue,
        },
        signal,
      );
      if (outcome.state === "available") return { envelope: outcome.envelope, extractor };
    }

    const ocr = this.options.ocrExtractor;
    if (ocr === undefined || !edition.authorization.capabilities.includes("ocr")) {
      fail("NO_EXTRACTOR_AVAILABLE");
    }
    await this.assertAuthorized(edition, "ocr", signal);
    const outcome = await this.runExtractor(
      ocr,
      edition,
      {
        contractVersion: 1,
        captureId,
        captureMetadata,
        privateBlobKey: privateBlobKeyValue,
      },
      signal,
    );
    if (outcome.state === "unavailable") fail("NO_EXTRACTOR_AVAILABLE");
    return { envelope: outcome.envelope, extractor: ocr };
  }

  private async runExtractor(
    extractor: OfficialOfferExtractor,
    edition: OfficialOfferEditionDiscoveryInputV1,
    input: OfficialOfferExtractionInput,
    signal: AbortSignal,
  ) {
    await this.assertAuthorized(edition, "extract", signal);
    const outcome = extractorOutcomeSchema.safeParse(await extractor.extract(input, signal));
    throwIfCancelled(signal);
    await this.assertAuthorized(edition, "extract", signal);
    if (!outcome.success) fail("EXTRACTOR_CONTRACT");
    if (
      outcome.data.state === "unavailable"
      && outcome.data.reason !== {
        "embedded-text": "NO_EMBEDDED_TEXT",
        ocr: "NO_OCR_INPUT",
        structured: "NO_STRUCTURED_CONTENT",
      }[extractor.method]
    ) {
      fail("EXTRACTOR_CONTRACT");
    }
    return outcome.data;
  }

  private async assertSourceEnabled(
    sourceId: string,
    capability: OfficialOfferSourceCapability,
    signal: AbortSignal,
  ): Promise<OfficialOfferAuthorizationFenceV1> {
    throwIfCancelled(signal);
    const asOf = canonicalNow(this.options.now);
    const result = officialOfferAuthorizationFenceV1Schema.safeParse(
      await this.options.sourceAccessPolicy.getDecision(sourceId, capability, asOf, signal),
    );
    throwIfCancelled(signal);
    if (
      !result.success
      || result.data.sourceId !== sourceId
      || !result.data.capabilities.includes(capability)
      || result.data.evaluatedAt !== asOf
      || Date.parse(result.data.reviewedAt) > Date.parse(asOf)
      || (
        result.data.validUntil !== undefined
        && Date.parse(result.data.validUntil) <= Date.parse(asOf)
      )
    ) {
      fail("SOURCE_DISABLED");
    }
    return result.data;
  }

  private async assertAuthorized(
    edition: OfficialOfferEditionDiscoveryInputV1,
    capability: OfficialOfferSourceCapability,
    signal: AbortSignal,
    rightsClassification?: OfficialOfferCaptureMetadataV1["rightsClassification"],
  ): Promise<OfficialOfferAuthorizationFenceV1> {
    const asOf = canonicalNow(this.options.now);
    if (
      !edition.authorization.capabilities.includes(capability)
      || Date.parse(edition.authorization.reviewedAt) > Date.parse(asOf)
      || (
        edition.authorization.validUntil !== undefined
        && Date.parse(edition.authorization.validUntil) <= Date.parse(asOf)
      )
    ) {
      fail("SOURCE_DISABLED");
    }
    const authorization = await this.assertSourceEnabled(edition.sourceId, capability, signal);
    if (
      rightsClassification !== undefined
      && !authorization.rightsClassifications.includes(rightsClassification)
    ) {
      fail("SOURCE_DISABLED");
    }
    return authorization;
  }
}
