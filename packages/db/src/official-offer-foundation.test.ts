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
      sql.includes("insert into publications") ? [publicationRow] : []);
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    await expect(repository.recordEdition(
      syntheticAuthorizedLocalEdition,
      authorizationFence,
    )).resolves.toEqual({
      created: true,
      id: 42,
      status: "discovered",
    });
    const insert = database.calls.find(({ sql }) => sql.includes("insert into publications"));
    expect(insert?.sql).toContain("on conflict (source_id, external_id) do nothing");
    expect(insert?.sql).not.toContain("authorization");
    expect(insert?.sql).not.toContain("private_reference");
    const authorizationQuery = database.calls.find(({ sql }) =>
      sql.includes("from data_sources source"));
    expect(authorizationQuery?.sql).toContain(
      "order by current_permission.created_at desc, current_permission.id desc",
    );
    expect(authorizationQuery?.sql).not.toContain(
      "order by current_permission.reviewed_at desc",
    );
    const scopeQuery = database.calls.find(({ sql }) =>
      sql.includes("from geographic_scopes scope"));
    expect(scopeQuery?.sql).toContain("limit 101");
    expect(scopeQuery?.sql).toContain("limit 10001");
    expect(scopeQuery?.sql).toContain("limit 1001");
  });

  it("rejects an edition identity collision instead of rewriting scope or validity", async () => {
    let insertAttempted = false;
    const database = scriptedDatabase((sql) => {
      if (sql.includes("insert into publications")) {
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
      if (sql.includes("insert into publication_captures")) return [captureRow];
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
      sql.includes("insert into publication_captures"));
    expect(captureInsert?.sql).toContain("on conflict (publication_id, checksum) do nothing");
    expect(captureInsert?.sql).not.toContain("raw_bytes");
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
      if (sql.includes("insert into extraction_runs")) {
        extractionInsertCount += 1;
        const counts = findJsonObjectParameter(values, "envelopeSha256");
        if (persistedCounts === undefined) persistedCounts = counts;
        return extractionInsertCount === 1 ? [extractionRow(persistedCounts)] : [];
      }
      if (sql.includes("from extraction_runs")) return [extractionRow(persistedCounts)];
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
      sql.includes("insert into extracted_offer_candidates"))).toHaveLength(5);
    expect(database.calls.find(({ sql }) => sql.includes("insert into extraction_runs"))?.sql)
      .toContain("on conflict (capture_id, extractor_version) do nothing");
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
      if (sql.includes("insert into extraction_runs")) {
        const attemptedCounts = findJsonObjectParameter(values, "envelopeSha256");
        if (firstInsert) {
          firstInsert = false;
          persistedCounts = attemptedCounts;
          return [extractionRow()];
        }
        return [];
      }
      if (sql.includes("from extraction_runs")) return [extractionRow()];
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
      if (sql.includes("insert into extraction_runs")) {
        persistedCounts = findJsonObjectParameter(values, "envelopeSha256");
        return [{
          id: "127",
          status: validation.status,
          started_at: new Date(extractionTiming.serverStartedAt),
          completed_at: completion,
          counts: persistedCounts,
          error_class: null,
          extraction_method: envelope.method,
          extraction_permission_id: "11",
          ocr_permission_id: null,
          permission_capabilities: authorizationFence.capabilities,
          source_started_at: new Date(envelope.startedAt),
          source_completed_at: new Date(envelope.completedAt),
          empty_result: envelope.emptyResult,
          empty_confirmation: envelope.emptyConfirmation,
          empty_confirmation_observed_at: completion,
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
    const insert = database.calls.find(({ sql }) => sql.includes("insert into extraction_runs"));
    expect(insert?.sql).toContain("empty_confirmation_observed_at");
    expect(JSON.stringify(insert?.values)).not.toContain("confirmedAt");
  });

  it("filters expiry and revocation at read time without capture or reviewer exposure", async () => {
    const database = scriptedDatabase((sql) => sql.includes("from approved_offers offer")
      ? [{
          id: "7",
          offer_key: "synthetic-offer-7",
          source_reference: "review-candidate:7:v1",
          source_id: syntheticAuthorizedLocalEdition.sourceId,
          chain: "extra",
          geographic_scope_id: "42",
          amount_ore: 3_990,
          before_amount_ore: 4_990,
          multibuy_quantity: null,
          multibuy_group_amount_ore: null,
          membership_requirement: "public",
          valid_from: new Date("2026-07-13T00:00:00.000Z"),
          valid_until: new Date("2026-07-20T00:00:00.000Z"),
          product_id: "9",
          family_slug: null,
          match_method: "exact_identifier",
          match_confidence: 100,
          capture_retrieved_at: new Date("2026-07-12T12:00:30.000Z"),
          external_id: syntheticAuthorizedLocalEdition.externalEditionId,
          content_kind: syntheticAuthorizedLocalEdition.contentKind,
          declared_geographic_scope: syntheticAuthorizedLocalEdition.declaredGeographicScope,
          review_channels: ["in-store"],
          member_program_id: null,
        }]
      : []);
    const repository = new PostgresOfficialOfferFoundationRepository(database.db);

    const rows = await repository.readCurrentPublishedOffers(
      new Date("2026-07-17T00:00:00.000Z"),
    );
    expect(rows).toHaveLength(1);
    const read = database.calls.find(({ sql }) => sql.includes("from approved_offers offer"))?.sql
      ?? "";
    expect(read).toContain("offer.valid_from <=");
    expect(read).toContain("offer.valid_until >");
    expect(read).toContain("source.runtime_state = 'approved'");
    expect(read).toContain("permission.decision = 'approved'");
    expect(read).toContain(
      "order by current_permission.created_at desc, current_permission.id desc",
    );
    expect(read).not.toContain("order by current_permission.reviewed_at desc");
    expect(read).toContain("officialOffers");
    expect(read).toContain("review_actions");
    expect(read).toContain("review.offer_id = offer.id");
    expect(read).toContain("review.expected_version = offer.version - 1");
    expect(read).toContain("current_review.created_at desc");
    expect(read).toContain(
      "order by current_review.created_at desc,\n                 current_review.id desc",
    );
    expect(read).not.toContain("order by current_review.expected_version desc");
    expect(read).not.toContain("current_review.acted_at desc");
    expect(read).toContain("publication_captures");
    expect(read).toContain("capture.rights_classification = 'public_display'");
    expect(read).toContain("limit");
    expect(read).not.toContain("actor_id");
    expect(Object.keys(rows[0] ?? {})).not.toEqual(
      expect.arrayContaining(["candidateId", "reviewerId", "sourceReference"]),
    );
  });
});
