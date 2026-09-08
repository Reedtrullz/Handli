import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  canonicalOfficialOfferEditionIdentity,
  officialOfferEditionDiscoveryInputV1Schema,
  syntheticAuthorizedLocalEdition,
  syntheticExactProductIdsByGtin,
  syntheticStructuredExtractionEnvelope,
  validateOfficialOfferExtraction,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";
import {
  OfficialOfferFoundationError,
  PostgresOfficialOfferFoundationRepository,
} from "./official-offer-foundation";

type Responder = (sql: string, values: readonly unknown[]) => unknown[];

function findJsonObjectParameter(
  values: readonly unknown[],
  property: string,
): Record<string, unknown> | undefined {
  for (const value of values) {
    let candidate = value;
    if (typeof value === "string") {
      try {
        candidate = JSON.parse(value) as unknown;
      } catch {
        continue;
      }
    }
    if (
      candidate !== null
      && typeof candidate === "object"
      && property in candidate
    ) {
      return candidate as Record<string, unknown>;
    }
  }
  return undefined;
}

function scriptedDatabase(responder: Responder) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const rawExecutor = (strings: readonly string[], ...values: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ sql, values });
    const cancel = vi.fn();
    cancels.push(cancel);
    const response = responder(sql, values);
    const fallback = sql.includes("select clock_timestamp() as database_clock")
      ? [{ database_clock: new Date("2026-07-17T00:00:01.000Z") }]
      : sql.includes("from data_sources source")
        ? [authorizationRow]
      : sql.includes("from geographic_scopes scope")
        ? [geographicScopeRow]
        : [];
    return Object.assign(Promise.resolve(response.length > 0 ? response : fallback), { cancel });
  };
  Object.assign(rawExecutor, {
    json: (value: unknown) => value,
    begin: (callback: (transaction: unknown) => Promise<unknown>) => callback(rawExecutor),
  });
  const executor = rawExecutor as unknown as HandleplanDatabase["$client"];
  return {
    calls,
    cancels,
    db: { $client: executor } as HandleplanDatabase,
  };
}

const authorizationFence = {
  contractVersion: 1,
  permissionId: 11,
  sourceId: syntheticAuthorizedLocalEdition.sourceId,
  decision: "approved",
  capabilities: ["capture", "discover", "extract"],
  rightsClassifications: ["extract_only", "private_review", "public_display"],
  reviewedAt: syntheticAuthorizedLocalEdition.authorization.reviewedAt,
  validUntil: syntheticAuthorizedLocalEdition.authorization.validUntil,
  evaluatedAt: "2026-07-12T12:01:02.000Z",
} as const;

const authorizationRow = {
  id: "11",
  capabilities: authorizationFence.capabilities,
  rights_classifications: authorizationFence.rightsClassifications,
  database_clock: new Date(authorizationFence.evaluatedAt),
};

const geographicScopeRow = {
  scope_kind: "postal_set",
  country_code: "NO",
  status: "active",
  region_codes: [],
  postal_codes: ["0001", "0002"],
  store_ids: [],
};

const extractionTiming = {
  contractVersion: 1,
  serverStartedAt: "2026-07-12T12:00:59.000Z",
  serverCompletedAt: "2026-07-12T12:01:01.500Z",
} as const;

const captureMetadata = {
  contractVersion: 1,
  publicationId: 42,
  sourceId: syntheticAuthorizedLocalEdition.sourceId,
  externalEditionId: syntheticAuthorizedLocalEdition.externalEditionId,
  checksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  mimeType: "application/json",
  byteLength: 321,
  rightsClassification: "extract_only",
  retrievedAt: "2026-07-12T12:00:30.000Z",
} as const;

const publicationRow = {
  id: "42",
  source_id: syntheticAuthorizedLocalEdition.sourceId,
  external_id: syntheticAuthorizedLocalEdition.externalEditionId,
  chain: syntheticAuthorizedLocalEdition.chain,
  title: syntheticAuthorizedLocalEdition.title,
  valid_from: new Date(syntheticAuthorizedLocalEdition.validFrom),
  valid_until: new Date(syntheticAuthorizedLocalEdition.validUntil),
  geographic_scope_id: syntheticAuthorizedLocalEdition.geographicScopeId,
  status: "discovered",
  discovered_at: new Date(syntheticAuthorizedLocalEdition.discoveredAt),
  content_kind: syntheticAuthorizedLocalEdition.contentKind,
  declared_geographic_scope: syntheticAuthorizedLocalEdition.declaredGeographicScope,
  edition_identity_sha256: createHash("sha256")
    .update(canonicalOfficialOfferEditionIdentity(
      officialOfferEditionDiscoveryInputV1Schema.parse(syntheticAuthorizedLocalEdition),
    ), "utf8")
    .digest("hex"),
  discovery_permission_id: "11",
};

const captureRow = {
  id: "84",
  blob_key: "official-offers/private/synthetic/3".concat("3".repeat(63)),
  checksum: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  mime_type: captureMetadata.mimeType,
  byte_length: captureMetadata.byteLength,
  rights_classification: captureMetadata.rightsClassification,
  retrieved_at: new Date(captureMetadata.retrievedAt),
  capture_permission_id: "11",
  capture_permission_capabilities: authorizationFence.capabilities,
};

const captureBindingRow = {
  ...publicationRow,
  checksum: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  capture_retrieved_at: new Date(captureMetadata.retrievedAt),
  capture_permission_id: "11",
  rights_classification: captureMetadata.rightsClassification,
  database_clock: new Date("2026-07-12T12:01:02.000Z"),
};

const extractionValidationContext = {
  contractVersion: 1,
  expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
  expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  exactProductIdsByGtin: syntheticExactProductIdsByGtin,
};

describe("PostgresOfficialOfferFoundationRepository", () => {
  it("records an authorized edition idempotently without persisting authorization details", async () => {
    const database = scriptedDatabase((sql) =>
      sql.includes("record_official_offer_edition_v1")
        ? [{ created: true, id: publicationRow.id, status: publicationRow.status }]
        : []);
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await expect(repository.recordEdition(
      syntheticAuthorizedLocalEdition,
      authorizationFence,
    )).resolves.toEqual({
      created: true,
      id: 42,
      status: "discovered",
    });
    const insert = database.calls.find(({ sql }) => sql.includes("record_official_offer_edition_v1"));
    expect(insert?.sql).toContain("record_official_offer_edition_v1");
    expect(database.calls.some(({ sql }) => sql.includes("insert into publications"))).toBe(false);
    expect(insert?.sql).not.toContain("private_reference");
  });

  it("rejects an edition identity collision instead of rewriting scope or validity", async () => {
    let insertAttempted = false;
    const database = scriptedDatabase((sql) => {
      if (sql.includes("record_official_offer_edition_v1")) {
        insertAttempted = true;
        return [];
      }
      if (sql.includes("from publications")) {
        return [{ ...publicationRow, geographic_scope_id: 99 }];
      }
      return [];
    });
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await expect(repository.recordEdition(
      syntheticAuthorizedLocalEdition,
      authorizationFence,
    )).rejects.toMatchObject({
      code: "EDITION_CONFLICT",
    });
    expect(insertAttempted).toBe(true);
    expect(database.calls.some(({ sql }) => /update publications.*geographic_scope_id/is.test(sql)))
      .toBe(false);
  });

  it("binds immutable capture metadata to its publication and idempotent checksum", async () => {
    const database = scriptedDatabase((sql) => {
      if (sql.includes("select id, source_id, external_id")) {
        return [{
          id: 42,
          source_id: syntheticAuthorizedLocalEdition.sourceId,
          external_id: syntheticAuthorizedLocalEdition.externalEditionId,
        }];
      }
      if (sql.includes("record_official_offer_capture_v1")) {
        return [{
          blob_key: captureRow.blob_key,
          created: true,
          id: captureRow.id,
          retrieved_at: captureRow.retrieved_at,
        }];
      }
      return [];
    });
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await expect(repository.recordCapture(
      captureMetadata,
      captureRow.blob_key,
      authorizationFence,
    )).resolves.toEqual({
      blobKey: captureRow.blob_key,
      created: true,
      id: 84,
      retrievedAt: captureMetadata.retrievedAt,
    });
    const captureInsert = database.calls.find(({ sql }) =>
      sql.includes("record_official_offer_capture_v1"));
    expect(captureInsert?.sql).toContain("record_official_offer_capture_v1");
    expect(database.calls.some(({ sql }) => sql.includes("insert into publication_captures"))).toBe(false);
  });

  it("persists one terminal extraction per capture/version and only unique typed candidates", async () => {
    const validation = validateOfficialOfferExtraction(
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      extractionValidationContext,
    );
    const extractionRow = (counts: unknown) => ({
      id: "126",
      status: validation.status,
      started_at: new Date(extractionTiming.serverStartedAt),
      completed_at: new Date("2026-07-12T12:01:02.000Z"),
      counts,
      error_class: null,
      extraction_method: syntheticStructuredExtractionEnvelope.method,
      extraction_permission_id: "11",
      ocr_permission_id: null,
      permission_capabilities: authorizationFence.capabilities,
      source_started_at: new Date(syntheticStructuredExtractionEnvelope.startedAt),
      source_completed_at: new Date(syntheticStructuredExtractionEnvelope.completedAt),
      empty_result: syntheticStructuredExtractionEnvelope.emptyResult,
      empty_confirmation: null,
      empty_confirmation_observed_at: null,
    });
    let extractionInsertCount = 0;
    let persistedCounts: unknown;
    const database = scriptedDatabase((sql, values) => {
      if (sql.includes("from publication_captures capture")) {
        return [captureBindingRow];
      }
      if (sql.includes("record_official_offer_extraction_v1")) {
        extractionInsertCount += 1;
        const payload = findJsonObjectParameter(values, "counts");
        const counts = payload?.counts;
        if (persistedCounts === undefined) persistedCounts = counts;
        return [{ counts: persistedCounts, created: extractionInsertCount === 1, id: extractionRow(persistedCounts).id, status: "completed" }];
      }
      return [];
    });
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await expect(repository.recordExtraction(
      84,
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      extractionValidationContext,
      extractionTiming,
      authorizationFence,
    )).resolves.toEqual({
      counts: validation.counts,
      created: true,
      id: 126,
      status: "completed",
    });
    await expect(repository.recordExtraction(
      84,
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      extractionValidationContext,
      extractionTiming,
      authorizationFence,
    )).resolves.toEqual({
      counts: validation.counts,
      created: false,
      id: 126,
      status: "completed",
    });
    expect(database.calls.filter(({ sql }) =>
      sql.includes("insert into extracted_offer_candidates"))).toHaveLength(0);
    expect(database.calls.filter(({ sql }) =>
      sql.includes("record_official_offer_extraction_v1"))).toHaveLength(2);
    expect(persistedCounts).toMatchObject({
      envelopeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      validationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(repository.recordExtraction(
      84,
      syntheticStructuredExtractionEnvelope,
      {
        ...syntheticAuthorizedLocalEdition,
        externalEditionId: "synthetic-detached-edition",
      },
      extractionValidationContext,
      extractionTiming,
      authorizationFence,
    )).rejects.toEqual(new OfficialOfferFoundationError("EXTRACTION_CONFLICT"));
  });

  it("rejects changed envelopes or match results under an idempotent extraction identity", async () => {
    const validation = validateOfficialOfferExtraction(
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      extractionValidationContext,
    );
    let persistedCounts: unknown;
    let firstInsert = true;
    const extractionRow = () => ({
      id: "126",
      status: validation.status,
      started_at: new Date(extractionTiming.serverStartedAt),
      completed_at: new Date("2026-07-12T12:01:02.000Z"),
      counts: persistedCounts,
      error_class: null,
      extraction_method: syntheticStructuredExtractionEnvelope.method,
      extraction_permission_id: "11",
      ocr_permission_id: null,
      permission_capabilities: authorizationFence.capabilities,
      source_started_at: new Date(syntheticStructuredExtractionEnvelope.startedAt),
      source_completed_at: new Date(syntheticStructuredExtractionEnvelope.completedAt),
      empty_result: syntheticStructuredExtractionEnvelope.emptyResult,
      empty_confirmation: null,
      empty_confirmation_observed_at: null,
    });
    const database = scriptedDatabase((sql, values) => {
      if (sql.includes("from publication_captures capture")) {
        return [captureBindingRow];
      }
      if (sql.includes("record_official_offer_extraction_v1")) {
        const payload = findJsonObjectParameter(values, "counts");
        const attemptedCounts = payload?.counts;
        if (firstInsert) {
          firstInsert = false;
          persistedCounts = attemptedCounts;
          return [extractionRow()];
        }
        return [];
      }
      return [];
    });
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await repository.recordExtraction(
      84,
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      extractionValidationContext,
      extractionTiming,
      authorizationFence,
    );
    const firstCandidate = syntheticStructuredExtractionEnvelope.candidates[0]!;
    await expect(repository.recordExtraction(
      84,
      {
        ...syntheticStructuredExtractionEnvelope,
        candidates: [{
          ...firstCandidate,
          pricing: { kind: "unit", offerPriceOre: 2_991 },
        }, ...syntheticStructuredExtractionEnvelope.candidates.slice(1)],
      },
      syntheticAuthorizedLocalEdition,
      extractionValidationContext,
      extractionTiming,
      authorizationFence,
    )).rejects.toEqual(new OfficialOfferFoundationError("EXTRACTION_CONFLICT"));
    await expect(repository.recordExtraction(
      84,
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      {
        ...extractionValidationContext,
        exactProductIdsByGtin: {
          ...syntheticExactProductIdsByGtin,
          "70000001": ["product:changed-match"],
        },
      },
      extractionTiming,
      authorizationFence,
    )).rejects.toEqual(new OfficialOfferFoundationError("EXTRACTION_CONFLICT"));
  });

  it("binds confirmed-empty acceptance to the database completion clock", async () => {
    const envelope = {
      ...syntheticStructuredExtractionEnvelope,
      extractorVersion: "synthetic-confirmed-empty-v1",
      emptyResult: "confirmed-empty" as const,
      emptyConfirmation: {
        sourceId: syntheticAuthorizedLocalEdition.sourceId,
        externalEditionId: syntheticAuthorizedLocalEdition.externalEditionId,
        basis: "source-record-count-zero" as const,
        evidenceLocator: "synthetic-empty-count-field",
      },
      candidates: [],
    };
    const validation = validateOfficialOfferExtraction(
      envelope,
      syntheticAuthorizedLocalEdition,
      { ...extractionValidationContext, exactProductIdsByGtin: {} },
    );
    let persistedCounts: unknown;
    const completion = new Date("2026-07-12T12:01:02.000Z");
    const database = scriptedDatabase((sql, values) => {
      if (sql.includes("from publication_captures capture")) return [captureBindingRow];
      if (sql.includes("record_official_offer_extraction_v1")) {
        const payload = findJsonObjectParameter(values, "counts");
        persistedCounts = payload?.counts;
        return [{
          counts: persistedCounts,
          created: true,
          id: "127",
          status: validation.status,
        }];
      }
      return [];
    });
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await expect(repository.recordExtraction(
      84,
      envelope,
      syntheticAuthorizedLocalEdition,
      { ...extractionValidationContext, exactProductIdsByGtin: {} },
      extractionTiming,
      authorizationFence,
    )).resolves.toMatchObject({ created: true, id: 127, status: "completed" });
    const insert = database.calls.find(({ sql }) => sql.includes("record_official_offer_extraction_v1"));
    expect(insert?.sql).toContain("record_official_offer_extraction_v1");
    expect(JSON.stringify(insert?.values)).not.toContain("confirmedAt");
  });

  it("does not expose a second current-offer projection beside the canonical reader", () => {
    const database = scriptedDatabase(() => []);
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    expect("readCurrentPublishedOffers" in repository).toBe(false);
  });
});
