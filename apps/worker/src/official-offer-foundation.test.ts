import { createHash } from "node:crypto";

import {
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  syntheticAuthorizedLocalEdition,
  syntheticExactProductIdsByGtin,
  syntheticStructuredOfferCandidates,
  validateOfficialOfferExtraction,
  type OfficialOfferExtractionEnvelopeV1,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import {
  OfficialOfferFoundationPipeline,
  OfficialOfferFoundationWorkerError,
  type OfficialOfferExtractor,
  type OfficialOfferFoundationPipelineInput,
  type OfficialOfferFoundationRepositoryPort,
  type OfficialOfferPrivateBlobWrite,
  type OfficialOfferSourceAccessPolicy,
} from "./official-offer-foundation";

const NOW = new Date("2026-07-17T08:00:00.000Z");
const PAYLOAD = new TextEncoder().encode("synthetic rights-cleared offer fixture");
const PAYLOAD_CHECKSUM = createHash("sha256").update(PAYLOAD).digest("hex");
const SYNTHETIC_EDITION = officialOfferEditionDiscoveryInputV1Schema.parse(
  syntheticAuthorizedLocalEdition,
);

function envelopeFor(
  method: OfficialOfferExtractionEnvelopeV1["method"],
  options: {
    candidates?: readonly (typeof syntheticStructuredOfferCandidates)[number][];
    checksum?: string;
    emptyResult?: OfficialOfferExtractionEnvelopeV1["emptyResult"];
    layoutFingerprintSha256?: string;
    schemaFingerprintSha256?: string;
  } = {},
): OfficialOfferExtractionEnvelopeV1 {
  const candidates = options.candidates ?? syntheticStructuredOfferCandidates;
  return officialOfferExtractionEnvelopeV1Schema.parse({
    contractVersion: 1,
    captureChecksumSha256: options.checksum ?? PAYLOAD_CHECKSUM,
    extractorVersion: `synthetic-${method}-v1`,
    method,
    layoutFingerprintSha256:
      options.layoutFingerprintSha256 ?? SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
    schemaFingerprintSha256:
      options.schemaFingerprintSha256 ?? SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
    startedAt: "2026-07-17T08:00:01.000Z",
    completedAt: "2026-07-17T08:00:02.000Z",
    emptyResult: options.emptyResult ?? (candidates.length === 0 ? "unexpected-empty" : "not-empty"),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      provenance: { ...candidate.provenance, method },
    })),
  });
}

function extractor(
  method: OfficialOfferExtractor["method"],
  outcome: unknown,
): OfficialOfferExtractor & { extract: ReturnType<typeof vi.fn> } {
  return {
    extractorVersion: `synthetic-${method}-v1`,
    method,
    extract: vi.fn().mockResolvedValue({
      ...(outcome as Record<string, unknown>),
      contractVersion: 1,
    }),
  };
}

function approvedDecision(sourceId: string, _capability: string, evaluatedAt = NOW.toISOString()) {
  return {
    contractVersion: 1,
    permissionId: 11,
    sourceId,
    decision: "approved",
    capabilities: ["capture", "discover", "extract", "ocr"],
    rightsClassifications: ["extract_only", "private_review", "public_display"],
    reviewedAt: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z",
    evaluatedAt,
  };
}

function approvedPolicy(): OfficialOfferSourceAccessPolicy & {
  getDecision: ReturnType<typeof vi.fn>;
} {
  return {
    getDecision: vi.fn(async (sourceId: string, capability: string, asOf: string) =>
      approvedDecision(sourceId, capability, asOf)),
  };
}

function exactResolver() {
  return {
    resolveGtins: vi.fn(async (gtins: readonly string[]) => ({
      contractVersion: 1,
      matchesByGtin: Object.fromEntries(
        gtins.map((gtin) => [gtin, [...(syntheticExactProductIdsByGtin[
          gtin as keyof typeof syntheticExactProductIdsByGtin
        ] ?? [])]]),
      ),
    })),
  };
}

function repository(): OfficialOfferFoundationRepositoryPort & {
  recordCapture: ReturnType<typeof vi.fn>;
  recordEdition: ReturnType<typeof vi.fn>;
  recordExtraction: ReturnType<typeof vi.fn>;
} {
  return {
    recordEdition: vi.fn().mockResolvedValue({ id: 42 }),
    recordCapture: vi.fn().mockResolvedValue({ id: 84, retrievedAt: NOW.toISOString() }),
    recordExtraction: vi.fn(async (
      _captureId,
      envelope,
      edition,
      validationContext,
    ) => {
      const validation = validateOfficialOfferExtraction(
        envelope,
        edition,
        validationContext,
      );
      return { counts: validation.counts, id: 126, status: validation.status };
    }),
  };
}

function pipelineInput(
  edition: OfficialOfferFoundationPipelineInput["edition"] = SYNTHETIC_EDITION,
): OfficialOfferFoundationPipelineInput {
  return {
    contractVersion: 1,
    bytes: PAYLOAD,
    edition,
    expectedChecksumSha256: PAYLOAD_CHECKSUM,
    mimeType: "application/json",
    rightsClassification: "extract_only",
  };
}

function pipeline(options: {
  blobResult?: unknown;
  embedded?: OfficialOfferExtractor;
  ocr?: OfficialOfferExtractor;
  policy?: OfficialOfferSourceAccessPolicy;
  repository?: ReturnType<typeof repository>;
  resolver?: ReturnType<typeof exactResolver>;
  structured?: OfficialOfferExtractor;
} = {}) {
  const repo = options.repository ?? repository();
  const resolver = options.resolver ?? exactResolver();
  const policy = options.policy ?? approvedPolicy();
  const blobStore = {
    putIfAbsent: vi.fn(async (write: OfficialOfferPrivateBlobWrite) =>
      ({
        contractVersion: 1,
        ...(options.blobResult as Record<string, unknown> | undefined),
        ...(options.blobResult === undefined
          ? {
              state: "stored",
              checksumSha256: write.checksumSha256,
              byteLength: write.byteLength,
            }
          : {}),
      })),
  };
  const structured = options.structured ?? extractor("structured", {
    state: "available",
    envelope: envelopeFor("structured"),
  });
  return {
    blobStore,
    policy,
    repo,
    resolver,
    structured,
    value: new OfficialOfferFoundationPipeline({
      structuredExtractor: structured,
      ...(options.embedded === undefined ? {} : { embeddedTextExtractor: options.embedded }),
      ...(options.ocr === undefined ? {} : { ocrExtractor: options.ocr }),
      exactProductResolver: resolver,
      expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
      expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
      now: () => new Date(NOW),
      privateBlobStore: blobStore,
      repository: repo,
      sourceAccessPolicy: policy,
    }),
  };
}

const signal = () => new AbortController().signal;

describe("OfficialOfferFoundationPipeline", () => {
  it("uses structured extraction first and returns an explicitly disabled, non-sensitive receipt", async () => {
    const embedded = extractor("embedded-text", {
      state: "available",
      envelope: envelopeFor("embedded-text"),
    });
    const ocr = extractor("ocr", { state: "available", envelope: envelopeFor("ocr") });
    const harness = pipeline({ embedded, ocr });

    const receipt = await harness.value.captureAndExtract(pipelineInput(), signal());

    expect(receipt).toEqual({
      activationEnabled: false,
      contractVersion: 1,
      counts: { exactMatch: 5, rejected: 0, reviewRequired: 0, total: 5 },
      extractionMethod: "structured",
      extractionRunId: 126,
      status: "completed",
    });
    expect(harness.structured.extract).toHaveBeenCalledOnce();
    expect(embedded.extract).not.toHaveBeenCalled();
    expect(ocr.extract).not.toHaveBeenCalled();
    const blobWrite = harness.blobStore.putIfAbsent.mock.calls[0]?.[0];
    expect(blobWrite.blobKey).toMatch(
      /^official-offers\/private\/v1\/[0-9a-f]{64}\/42\/[0-9a-f]{64}$/,
    );
    expect(blobWrite.bytes).not.toBe(PAYLOAD);
    expect(Object.keys(receipt)).not.toEqual(expect.arrayContaining([
      "blobKey",
      "candidateId",
      "captureId",
      "reviewerId",
      "sourceReference",
    ]));
  });

  it("falls back from structured data to embedded text before OCR", async () => {
    const structured = extractor("structured", {
      state: "unavailable",
      reason: "NO_STRUCTURED_CONTENT",
    });
    const embedded = extractor("embedded-text", {
      state: "available",
      envelope: envelopeFor("embedded-text"),
    });
    const ocr = extractor("ocr", { state: "available", envelope: envelopeFor("ocr") });
    const harness = pipeline({ structured, embedded, ocr });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).resolves
      .toMatchObject({ extractionMethod: "embedded-text", status: "completed" });
    expect(structured.extract).toHaveBeenCalledOnce();
    expect(embedded.extract).toHaveBeenCalledOnce();
    expect(ocr.extract).not.toHaveBeenCalled();
  });

  it("allows authorized OCR only as mandatory-review evidence", async () => {
    const structured = extractor("structured", {
      state: "unavailable",
      reason: "NO_STRUCTURED_CONTENT",
    });
    const embedded = extractor("embedded-text", {
      state: "unavailable",
      reason: "NO_EMBEDDED_TEXT",
    });
    const ocr = extractor("ocr", {
      state: "available",
      envelope: envelopeFor("ocr", { candidates: [syntheticStructuredOfferCandidates[0]!] }),
    });
    const harness = pipeline({ structured, embedded, ocr });
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse({
      ...SYNTHETIC_EDITION,
      authorization: {
        ...SYNTHETIC_EDITION.authorization,
        capabilities: ["discover", "capture", "extract", "ocr"],
      },
    });

    await expect(harness.value.captureAndExtract(pipelineInput(edition), signal())).resolves
      .toMatchObject({
        extractionMethod: "ocr",
        counts: { exactMatch: 0, rejected: 0, reviewRequired: 1, total: 1 },
      });
    expect(ocr.extract).toHaveBeenCalledOnce();
    expect((harness.policy.getDecision as ReturnType<typeof vi.fn>).mock.calls)
      .toEqual(expect.arrayContaining([
        expect.arrayContaining([edition.sourceId, "ocr"]),
      ]));
  });

  it("stops before private capture when the source kill switch is closed", async () => {
    const policy = approvedPolicy();
    policy.getDecision.mockImplementation(async (sourceId: string, capability: string) => ({
      ...approvedDecision(sourceId, capability),
      decision: capability === "capture" ? "revoked" : "approved",
    }));
    const harness = pipeline({ policy });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("SOURCE_DISABLED"));
    expect(harness.blobStore.putIfAbsent).not.toHaveBeenCalled();
    expect(harness.repo.recordCapture).not.toHaveBeenCalled();
    expect(harness.repo.recordExtraction).not.toHaveBeenCalled();
  });

  it("does not reuse edition authorization after it expires", async () => {
    const harness = pipeline();
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse({
      ...SYNTHETIC_EDITION,
      authorization: {
        ...SYNTHETIC_EDITION.authorization,
        validUntil: "2026-07-13T00:00:00.000Z",
      },
    });

    await expect(harness.value.captureAndExtract(pipelineInput(edition), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("SOURCE_DISABLED"));
    expect(harness.repo.recordEdition).not.toHaveBeenCalled();
    expect(harness.blobStore.putIfAbsent).not.toHaveBeenCalled();
  });

  it("rechecks revocation after blob storage and before capture metadata is persisted", async () => {
    let captureChecks = 0;
    const policy: OfficialOfferSourceAccessPolicy = {
      getDecision: vi.fn(async (sourceId: string, capability: string) => ({
        ...approvedDecision(sourceId, capability),
        decision: capability === "capture" && captureChecks++ > 0 ? "revoked" : "approved",
      })),
    };
    const harness = pipeline({ policy });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("SOURCE_DISABLED"));
    expect(harness.blobStore.putIfAbsent).toHaveBeenCalledOnce();
    expect(harness.repo.recordCapture).not.toHaveBeenCalled();
    expect(harness.repo.recordExtraction).not.toHaveBeenCalled();
  });

  it("rechecks revocation after extraction and refuses candidate persistence", async () => {
    let extractionChecks = 0;
    const policy: OfficialOfferSourceAccessPolicy = {
      getDecision: vi.fn(async (sourceId: string, capability: string) => ({
        ...approvedDecision(sourceId, capability),
        decision: capability === "extract" && extractionChecks++ > 0 ? "revoked" : "approved",
      })),
    };
    const harness = pipeline({ policy });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("SOURCE_DISABLED"));
    expect(harness.structured.extract).toHaveBeenCalledOnce();
    expect(harness.repo.recordExtraction).not.toHaveBeenCalled();
  });

  it("accepts an immutable idempotent blob result and rejects conflicting blob metadata", async () => {
    const idempotent = pipeline({
      blobResult: {
        state: "already-present",
        checksumSha256: PAYLOAD_CHECKSUM,
        byteLength: PAYLOAD.byteLength,
      },
    });
    await expect(idempotent.value.captureAndExtract(pipelineInput(), signal())).resolves
      .toMatchObject({ status: "completed" });

    const conflict = pipeline({
      blobResult: {
        state: "already-present",
        checksumSha256: "f".repeat(64),
        byteLength: PAYLOAD.byteLength,
      },
    });
    await expect(conflict.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("BLOB_CONFLICT"));
    expect(conflict.repo.recordCapture).not.toHaveBeenCalled();
  });

  it.each([
    ["schema drift", { schemaFingerprintSha256: "4".repeat(64) }, "failed", "SCHEMA_DRIFT"],
    ["layout drift", { layoutFingerprintSha256: "5".repeat(64) }, "degraded", "LAYOUT_DRIFT"],
    ["silent zero", { candidates: [], emptyResult: "unexpected-empty" as const }, "degraded", "UNEXPECTED_EMPTY"],
  ])("persists %s as a non-healthy terminal result", async (_label, changes, status, errorClass) => {
    const driftEnvelope = envelopeFor("structured", changes);
    const structured = extractor("structured", { state: "available", envelope: driftEnvelope });
    const harness = pipeline({ structured });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).resolves
      .toMatchObject({ status, counts: { exactMatch: 0, total: 0 } });
    const context = harness.repo.recordExtraction.mock.calls[0]?.[3];
    expect(validateOfficialOfferExtraction(
      driftEnvelope,
      syntheticAuthorizedLocalEdition,
      context,
    )).toMatchObject({ status, errorClass });
  });

  it("cross-binds extractor output to the immutable capture checksum", async () => {
    const structured = extractor("structured", {
      state: "available",
      envelope: envelopeFor("structured", { checksum: "f".repeat(64) }),
    });
    const harness = pipeline({ structured });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("EXTRACTOR_CONTRACT"));
    expect(harness.resolver.resolveGtins).not.toHaveBeenCalled();
    expect(harness.repo.recordExtraction).not.toHaveBeenCalled();
  });

  it("requires the resolver to return a bounded exact key set", async () => {
    const resolver = exactResolver();
    resolver.resolveGtins.mockResolvedValue({
      contractVersion: 1,
      matchesByGtin: {
        "70000001": ["product:synthetic-1", "product:synthetic-1"],
      },
    });
    const harness = pipeline({ resolver });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("RESOLVER_CONTRACT"));
    expect(harness.repo.recordExtraction).not.toHaveBeenCalled();
  });

  it("does not fall through to OCR without edition-level authorization", async () => {
    const structured = extractor("structured", {
      state: "unavailable",
      reason: "NO_STRUCTURED_CONTENT",
    });
    const embedded = extractor("embedded-text", {
      state: "unavailable",
      reason: "NO_EMBEDDED_TEXT",
    });
    const ocr = extractor("ocr", {
      state: "available",
      envelope: envelopeFor("ocr"),
    });
    const harness = pipeline({ structured, embedded, ocr });

    await expect(harness.value.captureAndExtract(pipelineInput(), signal())).rejects
      .toEqual(new OfficialOfferFoundationWorkerError("NO_EXTRACTOR_AVAILABLE"));
    expect(ocr.extract).not.toHaveBeenCalled();
    expect(harness.repo.recordExtraction).not.toHaveBeenCalled();
  });
});
