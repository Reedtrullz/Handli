import { createHash, randomUUID } from "node:crypto";

import {
  SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  extractedOfficialOfferCandidateV1Schema,
  officialOfferAuthorizationFenceV1Schema,
  officialOfferCaptureMetadataV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  officialOfferExtractionTimingV1Schema,
  syntheticStructuredOfferCandidates,
  type ReviewDecisionRequestV1,
  type ReviewOfferDecisionV1,
} from "@handleplan/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresOfficialOfferFoundationRepository,
} from "./official-offer-foundation";
import { PostgresPublicOfficialOfferReader } from "./public-official-offer-reader";
import { PostgresReviewQueueRepository } from "./review-queue";
import { SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED } from "./source-governance-lock";

const runIntegration = process.env.RUN_OFFICIAL_OFFER_DB_INTEGRATION === "1";
const describeIntegration = runIntegration ? describe : describe.skip;

function iso(value: Date): string {
  return value.toISOString();
}

const POSTGRES_TIMESTAMPTZ_PATTERN =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u;

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string" && POSTGRES_TIMESTAMPTZ_PATTERN.test(value)
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("Official-offer integration fixture returned an invalid database timestamp");
  }
  return parsed;
}

function syntheticGtin(seed: string): string {
  const body = `29${(BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 14)}`)
    % 10_000_000_000n).toString().padStart(10, "0")}`;
  const checksumSum = [...body].reduce((sum, digit, index) =>
    sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - checksumSum % 10) % 10}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reviewProofToken(seed: string, expiresAt: Date): string {
  return `review-proof:v1.${expiresAt.getTime().toString(36)}.${digest(seed).slice(0, 22)}.${digest(`${seed}:binding`)}.${digest(`${seed}:signature`)}`;
}

type JsonLeafMutation = { label: string; value: Record<string, unknown> };
type JsonMutationFixture = { name: string; value: Record<string, unknown> };
type JsonSchemaOracle = (value: unknown) => boolean;

function differentialJsonLeafMutations(
  fixtures: readonly JsonMutationFixture[],
  oracle: JsonSchemaOracle,
): JsonLeafMutation[] {
  const mutations: JsonLeafMutation[] = [];
  const seen = new Set<string>();
  const walk = (
    fixture: JsonMutationFixture,
    path: readonly (string | number)[],
    replace: unknown,
  ): void => {
    const schemaPath = path
      .map((segment) => typeof segment === "number" ? "[]" : segment)
      .join(".");
    const replacementKind = replace === null ? "null" : typeof replace;
    const dedupeKey = `${schemaPath}:${replacementKind}`;
    const clone = structuredClone(fixture.value) as Record<string, unknown>;
    let target: unknown = clone;
    for (const segment of path.slice(0, -1)) target = (target as Record<string | number, unknown>)[segment]!;
    (target as Record<string | number, unknown>)[path.at(-1)!] = replace;
    if (!seen.has(dedupeKey) && !oracle(clone)) {
      seen.add(dedupeKey);
      mutations.push({ label: `${fixture.name}:${path.join(".")}=${JSON.stringify(replace)}`, value: clone });
    }
  };
  const visit = (
    fixture: JsonMutationFixture,
    current: unknown,
    path: readonly (string | number)[],
  ): void => {
    if (typeof current === "string") {
      for (const replacement of [null, 7, true]) walk(fixture, path, replacement);
      return;
    }
    if (typeof current === "number") {
      for (const replacement of [null, "7", true]) walk(fixture, path, replacement);
      return;
    }
    if (typeof current === "boolean") {
      for (const replacement of [null, "true", 1]) walk(fixture, path, replacement);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(fixture, entry, [...path, index]));
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) visit(fixture, entry, [...path, key]);
    }
  };
  for (const fixture of fixtures) visit(fixture, fixture.value, []);
  return mutations;
}

describe("official-offer database timestamp boundary", () => {
  it("normalizes Date and PostgreSQL timestamptz values to fresh finite Dates", () => {
    const input = new Date("2026-07-17T13:55:00.123Z");
    const fromDate = databaseDate(input);
    const fromPostgres = databaseDate("2026-07-17 13:55:00.123456+00");

    expect(fromDate).not.toBe(input);
    expect(fromDate.toISOString()).toBe("2026-07-17T13:55:00.123Z");
    expect(fromPostgres.toISOString()).toBe("2026-07-17T13:55:00.123Z");
  });

  it.each([
    undefined,
    null,
    1_721_228_100_123,
    "",
    "not-a-timestamp",
    "July 17, 2026 13:55 UTC",
    new Date(Number.NaN),
  ])("rejects invalid or missing database clock value %#", (value) => {
    expect(() => databaseDate(value)).toThrow(/invalid database timestamp/i);
  });
});

describeIntegration("official-offer PostgreSQL trust fences", () => {
  let first: DatabaseConnection;
  let second: DatabaseConnection;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_MIGRATION_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_MIGRATION_URL is required when RUN_OFFICIAL_OFFER_DB_INTEGRATION=1",
      );
    }
    first = createDatabase(databaseUrl);
    second = createDatabase(databaseUrl);
  });

  afterAll(async () => {
    await Promise.all([first?.close(), second?.close()]);
  });

  it("rejects a fence that differs from the stored permission by one microsecond", async () => {
    const suffix = randomUUID();
    const sourceId = `offer-precision-${suffix}`.slice(0, 64);
    const reviewedAt = "2026-08-21T16:04:05.780477Z";
    const validUntil = "2026-12-31T23:59:59.000000Z";
    const permissions = {
      officialOffers: true,
      officialOfferCapabilities: ["capture", "discover", "extract"],
      officialOfferRightsClassifications: ["public_display"],
    };
    await first.sql`
      insert into data_sources (
        id, display_name, source_kind, runtime_state,
        permission_reviewed_at, permission_expires_at
      ) values (
        ${sourceId}, ${`Official offer precision ${sourceId}`}, 'offer', 'approved',
        ${reviewedAt}, ${validUntil}
      )
    `;
    const [permission] = await first.sql<Array<{ id: string }>>`
      insert into source_permissions (source_id, decision, reviewed_at, valid_until, permissions)
      values (${sourceId}, 'approved', ${reviewedAt}, ${validUntil}, ${JSON.stringify(permissions)}::jsonb)
      returning id
    `;
    const [scope] = await first.sql<Array<{ id: string }>>`
      insert into geographic_scopes (scope_key, scope_kind, label, country_code)
      values (${`offer-precision:${suffix}`}, 'postal_set', 'Official offer precision', 'NO')
      returning id
    `;
    await first.sql`
      insert into geographic_scope_postal_codes (scope_id, postal_code)
      values (${scope!.id}, '0001')
    `;
    const now = await first.sql<Array<{ now: string }>>`select to_char(
      clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) as now`;
    const evaluatedAt = now[0]!.now;
    const repository = new PostgresOfficialOfferFoundationRepository(first.db);
    const authorization = {
      contractVersion: 1 as const,
      permissionId: Number(permission!.id),
      sourceId,
      decision: "approved" as const,
      capabilities: ["capture", "discover", "extract"] as const,
      rightsClassifications: ["public_display"] as const,
      reviewedAt: reviewedAt,
      validUntil,
      evaluatedAt,
    };
    const edition = {
      contractVersion: 1 as const,
      sourceId,
      externalEditionId: `precision-${suffix}`,
      chain: "extra" as const,
      title: "Precision authorization edition",
      contentKind: "structured-feed" as const,
      geographicScopeId: Number(scope!.id),
      declaredGeographicScope: {
        kind: "postal-set" as const,
        countryCode: "NO",
        postalCodes: ["0001"],
      },
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2026-09-30T00:00:00.000Z",
      discoveredAt: "2026-09-08T13:00:00.000Z",
      authorization: {
        decision: "approved" as const,
        capabilities: authorization.capabilities,
        reviewedAt,
        validUntil,
      },
    };
    const recordedEdition = await repository.recordEdition(edition, authorization);
    await expect(repository.recordCapture({
      contractVersion: 1,
      publicationId: recordedEdition.id,
      sourceId,
      externalEditionId: edition.externalEditionId,
      checksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
      mimeType: "application/json",
      byteLength: 1,
      rightsClassification: "public_display",
      retrievedAt: "2026-09-08T13:00:00.000Z",
    }, `official-offers/private/precision/${suffix}`, {
      ...authorization,
      reviewedAt: "2026-08-21T16:04:05.780478Z",
    })).rejects.toMatchObject({ code: "SOURCE_AUTHORIZATION_STALE" });
  }, 30_000);

  it("runs edition through current read and serializes a concurrent revocation", async () => {
    const suffix = randomUUID();
    const sourceId = `offer-proof-${suffix}`.slice(0, 64);
    const otherSourceId = `offer-proof-other-${suffix}`.slice(0, 64);
    const reviewedAt = new Date(Date.now() - 60_000);
    const validUntil = new Date(Date.now() + 60 * 60_000);
    const permissions = {
      officialOffers: true,
      privateReview: true,
      publicDisplay: true,
      officialOfferCapabilities: ["capture", "discover", "extract"],
      officialOfferRightsClassifications: [
        "extract_only",
        "private_review",
        "public_display",
      ],
    };

    for (const id of [sourceId, otherSourceId]) {
      await first.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${id}, ${`Official offer integration ${id}`}, 'offer', 'approved',
          ${iso(reviewedAt)}, ${iso(validUntil)}
        )
      `;
    }
    const [permission] = await first.sql<Array<{ id: string }>>`
      insert into source_permissions (
        source_id, decision, reviewed_at, valid_until, permissions
      ) values (
        ${sourceId}, 'approved', ${iso(reviewedAt)}, ${iso(validUntil)},
        ${JSON.stringify(permissions)}::jsonb
      )
      returning id
    `;
    const [otherPermission] = await first.sql<Array<{ id: string }>>`
      insert into source_permissions (
        source_id, decision, reviewed_at, valid_until, permissions
      ) values (
        ${otherSourceId}, 'approved', ${iso(reviewedAt)}, ${iso(validUntil)},
        ${JSON.stringify(permissions)}::jsonb
      )
      returning id
    `;
    expect(typeof permission?.id).toBe("string");
    expect(typeof otherPermission?.id).toBe("string");

    const [scope] = await first.sql<Array<{ id: string }>>`
      insert into geographic_scopes (scope_key, scope_kind, label, country_code)
      values (${`offer-proof:${suffix}`}, 'postal_set', 'Official offer proof', 'NO')
      returning id
    `;
    await first.sql`
      insert into geographic_scope_postal_codes (scope_id, postal_code)
      values (${scope!.id}, '0001'), (${scope!.id}, '0002')
    `;
    expect(typeof scope?.id).toBe("string");

    const [boundedScope] = await first.sql<Array<{ id: string }>>`
      insert into geographic_scopes (scope_key, scope_kind, label, country_code)
      values (${`offer-proof-bounded:${suffix}`}, 'region', 'Bounded scope proof', 'NO')
      returning id
    `;
    await first.sql`
      insert into geographic_scope_regions (scope_id, region_code)
      select ${boundedScope!.id}, 'proof-' || lpad(member::text, 3, '0')
      from generate_series(1, 100) member
    `;
    await expect(first.sql`
      insert into geographic_scope_regions (scope_id, region_code)
      values (${boundedScope!.id}, 'proof-101')
    `).rejects.toThrow(/bounded cardinality/i);

    const repository = new PostgresOfficialOfferFoundationRepository(first.db);
    const databaseNow = async () => {
      const [row] = await first.sql<Array<{ now: unknown }>>`
        select clock_timestamp() as now
      `;
      return databaseDate(row?.now);
    };
    const fence = async () => ({
      contractVersion: 1 as const,
      permissionId: Number(permission!.id),
      sourceId,
      decision: "approved" as const,
      capabilities: ["capture", "discover", "extract"] as const,
      rightsClassifications: [
        "extract_only",
        "private_review",
        "public_display",
      ] as const,
      reviewedAt: iso(reviewedAt),
      validUntil: iso(validUntil),
      evaluatedAt: iso(await databaseNow()),
    });
    const validFrom = new Date(Date.now() - 60 * 60_000);
    const validTo = new Date(Date.now() + 24 * 60 * 60_000);
    const edition = {
      contractVersion: 1 as const,
      sourceId,
      externalEditionId: `edition-${suffix}`,
      chain: "extra" as const,
      title: "Rights-cleared synthetic integration edition",
      contentKind: "structured-feed" as const,
      geographicScopeId: Number(scope!.id),
      declaredGeographicScope: {
        kind: "postal-set" as const,
        countryCode: "NO",
        postalCodes: ["0001", "0002"],
      },
      validFrom: iso(validFrom),
      validUntil: iso(validTo),
      discoveredAt: iso(await databaseNow()),
      authorization: {
        decision: "approved" as const,
        capabilities: ["capture", "discover", "extract"] as const,
        reviewedAt: iso(reviewedAt),
        validUntil: iso(validUntil),
      },
    };
    const recordedEdition = await repository.recordEdition(edition, await fence());
    expect(recordedEdition.id).toBeGreaterThan(0);

    await expect(first.sql`
      insert into geographic_scope_postal_codes (scope_id, postal_code)
      values (${scope!.id}, '0003')
    `).rejects.toThrow(/scope membership is sealed/i);
    await expect(first.sql`
      update geographic_scopes set country_code = 'SE' where id = ${scope!.id}
    `).rejects.toThrow(/scope identity is immutable/i);

    await expect(first.sql`
      insert into publications (
        source_id, external_id, chain, title, valid_from, valid_until,
        geographic_scope_id, status, discovered_at, content_kind,
        declared_geographic_scope, edition_identity_sha256, discovery_permission_id
      ) values (
        ${sourceId}, ${`cross-source-${suffix}`}, 'extra', 'forbidden',
        ${iso(validFrom)}, ${iso(validTo)}, ${scope!.id}, 'discovered', clock_timestamp(),
        'structured-feed',
        ${JSON.stringify(edition.declaredGeographicScope)}::jsonb, ${"f".repeat(64)},
        ${otherPermission!.id}
      )
    `).rejects.toThrow(/permission fence is not current for source/i);

    await expect(first.sql`
      insert into publications (
        source_id, external_id, chain, title, valid_from, valid_until,
        geographic_scope_id, status, discovered_at, content_kind,
        declared_geographic_scope, edition_identity_sha256, discovery_permission_id
      ) values (
        ${sourceId}, ${`forged-digest-${suffix}`}, 'extra', 'forbidden digest',
        ${iso(validFrom)}, ${iso(validTo)}, ${scope!.id}, 'discovered', ${edition.discoveredAt},
        'structured-feed', ${JSON.stringify(edition.declaredGeographicScope)}::jsonb,
        ${"f".repeat(64)}, ${permission!.id}
      )
    `).rejects.toThrow(/identity digest does not match stored facts/i);

    const [digestProof] = await first.sql<Array<{ matches: boolean }>>`
      select publication.edition_identity_sha256 = encode(sha256(convert_to(
        canonical_official_offer_edition_identity(
          publication.source_id,
          publication.external_id,
          publication.chain,
          publication.title,
          publication.content_kind,
          publication.geographic_scope_id,
          publication.declared_geographic_scope,
          publication.valid_from,
          publication.valid_until,
          publication.discovered_at
        ), 'UTF8'
      )), 'hex') as matches
      from publications publication
      where publication.id = ${recordedEdition.id}
    `;
    expect(digestProof?.matches).toBe(true);

    const capture = await repository.recordCapture({
      contractVersion: 1,
      publicationId: recordedEdition.id,
      sourceId,
      externalEditionId: edition.externalEditionId,
      checksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
      mimeType: "image/png",
      byteLength: 321,
      rightsClassification: "public_display",
      retrievedAt: iso(await databaseNow()),
    }, `official-offers/private/integration/${suffix}`, await fence());
    expect(capture.id).toBeGreaterThan(0);

    await expect(first.sql`
      insert into publication_captures (
        publication_id, blob_key, checksum, mime_type, byte_length,
        rights_classification, retrieved_at, capture_permission_id,
        capture_permission_capabilities
      ) values (
        ${recordedEdition.id}, ${`official-offers/private/forged/${suffix}`},
        ${"e".repeat(64)}, 'application/json', 1, 'public_display',
        '2000-01-01T00:00:00.000Z', ${permission!.id},
        '["capture", "discover", "extract", "ocr"]'::jsonb
      )
    `).rejects.toThrow(/capabilities do not match current source rights/i);

    const sourceStartedAt = await databaseNow();
    const sourceCompletedAt = new Date(sourceStartedAt.getTime() + 1);
    const baseCandidate = syntheticStructuredOfferCandidates[0]!;
    const targetGtin = syntheticGtin(suffix);
    const envelope = {
      contractVersion: 1 as const,
      captureChecksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
      extractorVersion: `integration-${suffix}`,
      method: "structured" as const,
      layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
      schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
      startedAt: iso(sourceStartedAt),
      completedAt: iso(sourceCompletedAt),
      emptyResult: "not-empty" as const,
      candidates: [{
        ...baseCandidate,
        candidateKey: `integration-${suffix}`,
        anomalyCodes: ["UNMATCHED_PRODUCT" as const],
        product: { kind: "exact-identifier" as const, scheme: "gtin" as const, value: targetGtin },
        pricing: { kind: "unit" as const, offerPriceOre: 2_990, beforePriceOre: 3_990 },
        validity: {
          state: "parsed" as const,
          startsAt: iso(validFrom),
          endsAt: iso(validTo),
        },
      }],
    };
    const extraction = await repository.recordExtraction(
      capture.id,
      envelope,
      edition,
      {
        contractVersion: 1,
        expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
        expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
        exactProductIdsByGtin: { [targetGtin]: [] },
      },
      {
        contractVersion: 1,
        serverStartedAt: iso(sourceStartedAt),
        serverCompletedAt: iso(sourceCompletedAt),
      },
      await fence(),
    );
    expect(extraction).toMatchObject({ created: true, status: "completed" });

    const confirmedEmptyAt = await databaseNow();
    const [confirmedEmpty] = await first.sql<Array<{
      completed_at: unknown;
      empty_confirmation_observed_at: unknown;
    }>>`
      insert into extraction_runs (
        capture_id, extractor_version, status, started_at, completed_at,
        counts, extraction_method, extraction_permission_id,
        permission_capabilities, source_started_at, source_completed_at,
        empty_result, empty_confirmation, empty_confirmation_observed_at
      ) values (
        ${capture.id}, ${`confirmed-empty-${suffix}`}, 'completed',
        ${iso(confirmedEmptyAt)}, '2000-01-01T00:00:00.000Z', '{"total":0}'::jsonb,
        'structured', ${permission!.id},
        '["capture", "discover", "extract"]'::jsonb,
        ${iso(confirmedEmptyAt)}, ${iso(confirmedEmptyAt)}, 'confirmed-empty',
        ${JSON.stringify({
          sourceId,
          externalEditionId: edition.externalEditionId,
          basis: "source-record-count-zero",
          evidenceLocator: "integration-count-field",
        })}::jsonb,
        '2000-01-01T00:00:00.000Z'
      )
      returning completed_at, empty_confirmation_observed_at
    `;
    expect(databaseDate(confirmedEmpty?.empty_confirmation_observed_at).getTime())
      .toBe(databaseDate(confirmedEmpty?.completed_at).getTime());

    await expect(first.sql`
      insert into extraction_runs (
        capture_id, extractor_version, status, started_at, completed_at,
        counts, extraction_method, extraction_permission_id,
        permission_capabilities, source_started_at, source_completed_at,
        empty_result, empty_confirmation, empty_confirmation_observed_at
      ) values (
        ${capture.id}, ${`self-dated-empty-${suffix}`}, 'completed',
        ${iso(confirmedEmptyAt)}, clock_timestamp(), '{"total":0}'::jsonb,
        'structured', ${permission!.id},
        '["capture", "discover", "extract"]'::jsonb,
        ${iso(confirmedEmptyAt)}, ${iso(confirmedEmptyAt)}, 'confirmed-empty',
        ${JSON.stringify({
          sourceId,
          externalEditionId: edition.externalEditionId,
          basis: "source-record-count-zero",
          evidenceLocator: "integration-count-field",
          confirmedAt: "2000-01-01T00:00:00.000Z",
        })}::jsonb,
        null
      )
    `).rejects.toThrow(/canonically bound to the publication/i);

    const [candidate] = await first.sql<Array<{
      candidate_sha256: string;
      disposition: string;
      exact_canonical_product_id: string | null;
      id: string;
    }>>`
      select
        id,
        encode(sha256(convert_to(normalized_fields::text, 'UTF8')), 'hex')
          as candidate_sha256,
        normalized_fields ->> 'disposition' as disposition,
        normalized_fields ->> 'exactCanonicalProductId' as exact_canonical_product_id
      from extracted_offer_candidates
      where extraction_run_id = ${extraction.id}
      limit 1
    `;
    expect(candidate).toMatchObject({
      disposition: "review-required",
      exact_canonical_product_id: null,
    });
    const [product] = await first.sql<Array<{ id: string }>>`
      insert into canonical_products (
        display_name, package_amount, package_unit, units_per_pack
      ) values ('Synthetic integration product', 500, 'g', 1)
      returning id
    `;
    await first.sql`
      insert into product_identifiers (
        product_id, scheme, value, confidence, verified_at
      ) values (${product!.id}, 'ean13', ${targetGtin}, 100, clock_timestamp())
    `;
    const decision: ReviewOfferDecisionV1 = {
      channels: ["in-store"],
      eligibility: { kind: "public" },
      pricing: {
        kind: "unit",
        offerPriceOre: 2_990,
        beforePriceOre: 3_990,
      },
      target: { kind: "exact-product", gtin: targetGtin },
      validity: {
        startsAt: iso(validFrom),
        endsAt: iso(validTo),
      },
    };
    const [decisionIdentity] = await first.sql<Array<{ sha256: string }>>`
      select encode(sha256(convert_to(${JSON.stringify(decision)}::jsonb::text, 'UTF8')), 'hex')
        as sha256
    `;
    const reviewRepository = new PostgresReviewQueueRepository(first.db);
    const candidateId = `review-candidate:${candidate!.id}`;
    const actor = {
      actorId: `access:${digest(`${suffix}:actor`)}`,
      sessionId: `access-session:${digest(`${suffix}:session`)}`,
    };
    const locator = await reviewRepository.getPrivateCaptureLocator(
      candidateId,
      await databaseNow(),
    );
    expect(locator.rightsClassification).toBe("public_display");
    if (locator.rightsClassification !== "public_display") {
      throw new Error("Synthetic review evidence is not publicly displayable");
    }
    const evidenceProofSha256 = digest(`${suffix}:${candidateId}:proof`);
    const renderClock = await databaseNow();
    const evidenceExpiresAt = new Date(renderClock.getTime() + 60_000);
    await reviewRepository.recordEvidenceRender({
      ...actor,
      candidateId,
      checksumSha256: locator.checksumSha256,
      cropReference: locator.cropReference,
      evidenceProofSha256,
      expectedVersion: 0,
      expiresAt: iso(evidenceExpiresAt),
      presentation: "full_capture",
      rightsClassification: locator.rightsClassification,
    }, renderClock);
    const reviewRequest: ReviewDecisionRequestV1 = {
      action: "correct_and_approve",
      approvalEvidence: {
        presentation: "full_capture",
        token: reviewProofToken(`${suffix}:${candidateId}`, evidenceExpiresAt),
      },
      candidateId,
      contractVersion: 1,
      decision,
      expectedVersion: 0,
      reason: "Synthetic rendered evidence resolves the previously unmatched product.",
    };
    const reviewed = await reviewRepository.decide(
      reviewRequest,
      actor,
      evidenceProofSha256,
      await databaseNow(),
    );
    expect(reviewed).toMatchObject({ state: "approved" });
    const offerIdMatch = /^review-offer:([1-9][0-9]{0,15})$/u.exec(reviewed.offerId ?? "");
    if (offerIdMatch === null) throw new Error("Synthetic review did not return an offer ID");
    const offer = { id: offerIdMatch[1]! };
    await first.sql`
      update approved_offers set status = 'published' where id = ${offer!.id}
    `;
    await expect(first.sql`
      insert into offer_conditions (offer_id, condition_type, condition_value)
      values (${offer!.id}, 'payment', '{"kind":"card"}'::jsonb)
    `).rejects.toThrow(/conditions are sealed/i);
    const [projectionBinding] = await first.sql<Array<{
      clocks_are_ordered: boolean;
      correction_is_bound: boolean;
      decision_is_bound: boolean;
      evidence_is_bound: boolean;
      unresolved_requires_correction: boolean;
    }>>`
      select
        candidate.normalized_fields ->> 'disposition' = 'review-required'
          and not (candidate.normalized_fields ? 'exactCanonicalProductId')
          as unresolved_requires_correction,
        review.action = 'correct_and_approve'
          and target.match_method = 'human_review'
          and target.match_confidence = 100
          as correction_is_bound,
        review.decision_boundary_version = 2 as evidence_is_bound,
        offer.offer_key = ${`official-review:${candidate!.id}:${decisionIdentity!.sha256}`}
          as decision_is_bound,
        offer.created_at <= offer.approved_at
          and offer.approved_at = review.acted_at
          and offer.created_at <= target.created_at
          and target.created_at <= review.created_at
          as clocks_are_ordered
      from approved_offers offer
      inner join extracted_offer_candidates candidate on candidate.id = offer.candidate_id
      inner join offer_targets target on target.offer_id = offer.id
      inner join review_actions review on review.offer_id = offer.id
      where offer.id = ${offer!.id}
    `;
    expect(projectionBinding).toEqual({
      clocks_are_ordered: true,
      correction_is_bound: true,
      decision_is_bound: true,
      evidence_is_bound: true,
      unresolved_requires_correction: true,
    });
    const readAt = await databaseNow();
    const publicReader = new PostgresPublicOfficialOfferReader(first.db);
    const publicSnapshot = await publicReader.getMany(
      [`product:${product!.id}`],
      readAt,
    );
    expect(publicSnapshot).toMatchObject({
      offers: [{
        id: `official-offer:${offer!.id}`,
        productMatch: { canonicalProductId: `product:${product!.id}`, kind: "exact" },
        pricing: { kind: "unit", unitPriceOre: 2_990 },
        sourceId,
      }],
      sources: [{ id: sourceId, sourceClass: "offer", state: "approved" }],
    });

    // A pre-022 direct-table action can copy every visible JSON field. It must
    // still remain quarantined because it lacks the post-ACL decision marker.
    const legacyCandidateKey = `legacy-projection-${suffix}`;
    const [legacyCandidate] = await first.sql<Array<{
      candidate_sha256: string;
      id: string;
    }>>`
      insert into extracted_offer_candidates (
        extraction_run_id, candidate_key, normalized_fields,
        confidence, status, anomaly_codes
      )
      select
        extraction_run_id,
        ${legacyCandidateKey},
        jsonb_set(
          normalized_fields,
          '{candidate,candidateKey}',
          to_jsonb(${legacyCandidateKey}::text),
          false
        ),
        confidence,
        status,
        anomaly_codes
      from extracted_offer_candidates
      where id = ${candidate!.id}
      returning id, encode(sha256(convert_to(normalized_fields::text, 'UTF8')), 'hex')
        as candidate_sha256
    `;
    const [legacyOffer] = await first.sql<Array<{ approved_at: unknown; id: string }>>`
      insert into approved_offers (
        offer_key, candidate_id, source_id, source_reference, chain,
        geographic_scope_id, amount_ore, before_amount_ore,
        membership_requirement, valid_from, valid_until,
        status, version, approved_at
      ) values (
        ${`official-review:${legacyCandidate!.id}:${decisionIdentity!.sha256}`},
        ${legacyCandidate!.id}, ${sourceId},
        ${`review-candidate:${legacyCandidate!.id}:v1`},
        'extra', ${scope!.id}, 2990, 3990, 'public',
        ${iso(validFrom)}, ${iso(validTo)}, 'approved', 1, clock_timestamp()
      )
      returning id, approved_at
    `;
    const legacyDecisionAt = databaseDate(legacyOffer?.approved_at);
    await first.sql`
      insert into offer_targets (
        offer_id, product_id, family_slug, match_method, match_confidence
      ) values (${legacyOffer!.id}, ${product!.id}, null, 'human_review', 100)
    `;
    await first.sql`
      insert into offer_conditions (offer_id, condition_type, condition_value)
      values (
        ${legacyOffer!.id}, 'channel',
        ${JSON.stringify({ channels: ["in-store"] })}::jsonb
      )
    `;
    await first.sql`
      insert into review_actions (
        candidate_id, offer_id, actor_id, action, expected_version,
        previous_values, new_values, reason, acted_at,
        decision_boundary_version
      ) values (
        ${legacyCandidate!.id}, ${legacyOffer!.id},
        ${`access:${"b".repeat(64)}`}, 'correct_and_approve', 0,
        ${JSON.stringify({
          candidateSha256: legacyCandidate!.candidate_sha256,
          contractVersion: 1,
          reviewVersion: 0,
        })}::jsonb,
        ${JSON.stringify({
          contractVersion: 1,
          reviewVersion: 1,
          state: "approved",
          decision,
          decisionSha256: decisionIdentity!.sha256,
        })}::jsonb,
        'Legacy direct-table approval probe', ${iso(legacyDecisionAt)}, null
      )
    `;
    await first.sql`
      update approved_offers set status = 'published' where id = ${legacyOffer!.id}
    `;
    const legacyQuarantined = await publicReader.getMany(
      [`product:${product!.id}`],
      await databaseNow(),
    );
    expect(legacyQuarantined.offers.map(({ id }) => id)).toEqual([
      `official-offer:${offer!.id}`,
    ]);

    let releaseLock!: () => void;
    let lockReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      lockReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holding = first.sql.begin(async (transaction) => {
      await transaction`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${sourceId}, ${SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED})
        )
      `;
      lockReady();
      await release;
    });
    await ready;
    let revocationSettled = false;
    const revocation = second.sql`
      insert into source_permissions (
        source_id, decision, reviewed_at, valid_until, permissions
      ) values (
        ${sourceId}, 'revoked',
        ${iso(new Date(reviewedAt.getTime() - 60_000))}, null, '{}'::jsonb
      )
    `.finally(() => {
      revocationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revocationSettled).toBe(false);
    releaseLock();
    await Promise.all([holding, revocation]);

    const afterRevocation = await publicReader.getMany(
      [`product:${product!.id}`],
      await databaseNow(),
    );
    expect(afterRevocation.offers.filter((currentOffer) =>
      currentOffer.sourceId === sourceId)).toEqual([]);
    expect(afterRevocation.sources.filter((source) => source.id === sourceId)).toEqual([]);
    await expect(repository.recordCapture({
      contractVersion: 1,
      publicationId: recordedEdition.id,
      sourceId,
      externalEditionId: edition.externalEditionId,
      checksumSha256: "d".repeat(64),
      mimeType: "application/json",
      byteLength: 1,
      rightsClassification: "public_display",
      retrievedAt: iso(await databaseNow()),
    }, `official-offers/private/revoked/${suffix}`, await fence())).rejects.toMatchObject({
      code: "SOURCE_AUTHORIZATION_STALE",
    });

    const reapprovedAt = await databaseNow();
    const reapprovedUntil = new Date(reapprovedAt.getTime() + 60 * 60_000);
    await first.sql.begin(async (transaction) => {
      await transaction`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions
        ) values (
          ${sourceId}, 'approved', ${iso(reapprovedAt)}, ${iso(reapprovedUntil)},
          ${JSON.stringify(permissions)}::jsonb
        )
      `;
      await transaction`
        update data_sources
        set runtime_state = 'approved',
            permission_reviewed_at = ${iso(reapprovedAt)},
            permission_expires_at = ${iso(reapprovedUntil)}
        where id = ${sourceId}
      `;
    });
    expect(await new PostgresPublicOfficialOfferReader(first.db).getMany(
      [`product:${product!.id}`],
      await databaseNow(),
    )).toEqual({ offers: [], sources: [] });
  }, 30_000);
});

describeIntegration("official-offer direct app-role boundary", () => {
  let admin: DatabaseConnection;
  let worker: DatabaseConnection;
  let sourceId: string;
  let permissionId: number;
  let publicationId: number;
  let edition: Record<string, unknown>;
  let authorization: Record<string, unknown>;

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_MIGRATION_URL;
    const workerUrl = process.env.APP_DATABASE_URL;
    if (!adminUrl || !workerUrl) {
      throw new Error(
        "DATABASE_MIGRATION_URL and APP_DATABASE_URL are required for direct app-role integration",
      );
    }
    admin = createDatabase(adminUrl);
    worker = createDatabase(workerUrl);
    const suffix = randomUUID();
    sourceId = `direct-boundary-${suffix}`.slice(0, 64);
    const reviewedAt = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    const permissions = {
      officialOffers: true,
      officialOfferCapabilities: ["capture", "discover", "extract"],
      officialOfferRightsClassifications: ["public_display"],
    };
    await admin.sql`
      insert into data_sources (
        id, display_name, source_kind, runtime_state,
        permission_reviewed_at, permission_expires_at
      ) values (
        ${sourceId}, ${`Direct boundary ${sourceId}`}, 'offer', 'approved',
        ${reviewedAt}, ${validUntil}
      )
    `;
    const [permission] = await admin.sql<Array<{ id: string }>>`
      insert into source_permissions (source_id, decision, reviewed_at, valid_until, permissions)
      values (${sourceId}, 'approved', ${reviewedAt}, ${validUntil}, ${JSON.stringify(permissions)}::jsonb)
      returning id
    `;
    permissionId = Number(permission!.id);
    const [scope] = await admin.sql<Array<{ id: string }>>`
      insert into geographic_scopes (scope_key, scope_kind, label, country_code)
      values (${`direct-boundary:${suffix}`}, 'postal_set', 'Direct boundary', 'NO')
      returning id
    `;
    await admin.sql`
      insert into geographic_scope_postal_codes (scope_id, postal_code)
      values (${scope!.id}, '0001')
    `;
    const now = await admin.sql<Array<{ now: string }>>`select to_char(
      clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) as now`;
    const evaluatedAt = now[0]!.now;
    const discoveredAt = new Date(evaluatedAt).toISOString();
    authorization = {
      contractVersion: 1,
      permissionId,
      sourceId,
      decision: "approved",
      capabilities: ["capture", "discover", "extract"],
      rightsClassifications: ["public_display"],
      reviewedAt,
      validUntil,
      evaluatedAt,
    };
    edition = {
      contractVersion: 1,
      sourceId,
      externalEditionId: `direct-${suffix}`,
      chain: "extra",
      title: "Direct boundary edition",
      contentKind: "structured-feed",
      geographicScopeId: Number(scope!.id),
      declaredGeographicScope: { kind: "postal-set", countryCode: "NO", postalCodes: ["0001"] },
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      discoveredAt,
      authorization: {
        decision: "approved",
        capabilities: ["capture", "discover", "extract"],
        reviewedAt,
        validUntil,
      },
    };
    const repository = new PostgresOfficialOfferFoundationRepository(admin.db);
    const recorded = await repository.recordEdition(edition, authorization);
    publicationId = recorded.id;
  });

  afterAll(async () => {
    await Promise.all([admin?.close(), worker?.close()]);
  });

  it("rejects sparse, null-field, cross-source, scope-mismatched, stale, and cancelled direct calls", async () => {
    const countPublications = async () => {
      const [row] = await admin.sql<Array<{ count: string }>>`
        select count(*)::text as count from publications where id = ${publicationId}
      `;
      return Number(row!.count);
    };
    const countCaptures = async () => {
      const [row] = await admin.sql<Array<{ count: string }>>`
        select count(*)::text as count from publication_captures where publication_id = ${publicationId}
      `;
      return Number(row!.count);
    };
    const countExtractions = async () => {
      const [row] = await admin.sql<Array<{ count: string }>>`
        select count(*)::text as count from extraction_runs
        where capture_id in (select id from publication_captures where publication_id = ${publicationId})
      `;
      return Number(row!.count);
    };
    const badAuthorization = { ...authorization, reviewedAt: null };
    await expect(worker.sql`
      select * from public.record_official_offer_edition_v1(
        ${JSON.stringify({ sourceId, contractVersion: 1 })}::jsonb,
        ${JSON.stringify(badAuthorization)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countPublications()).toBe(1);

    const numericEditionSource = { ...edition, sourceId: 7 };
    expect(officialOfferEditionDiscoveryInputV1Schema.safeParse(numericEditionSource).success).toBe(false);
    await expect(worker.sql`
      select * from public.record_official_offer_edition_v1(
        ${JSON.stringify({ ...numericEditionSource, externalEditionId: `numeric-edition-${randomUUID()}` })}::jsonb,
        ${JSON.stringify(authorization)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countPublications()).toBe(1);

    const captureMetadata = {
      contractVersion: 1,
      publicationId,
      sourceId,
      externalEditionId: edition.externalEditionId,
      checksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
      mimeType: "application/json",
      byteLength: 1,
      rightsClassification: "public_display",
      retrievedAt: new Date().toISOString(),
    };
    const [capture] = await admin.sql<Array<{ id: string }>>`
      select id from public.record_official_offer_capture_v1(
        ${JSON.stringify(captureMetadata)}::jsonb,
        ${`official-offers/private/direct/${randomUUID()}`},
        ${JSON.stringify(authorization)}::jsonb
      )
    `;
    const captureId = Number(capture!.id);
    await expect(worker.sql`
      select * from public.record_official_offer_capture_v1(
        ${JSON.stringify({ ...captureMetadata, sourceId: "other-source" })}::jsonb,
        ${`official-offers/private/direct/${randomUUID()}`},
        ${JSON.stringify(authorization)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countCaptures()).toBe(1);

    const numericPermissionAuthorization = { ...authorization, permissionId: String(permissionId) };
    expect(officialOfferAuthorizationFenceV1Schema.safeParse(numericPermissionAuthorization).success)
      .toBe(false);
    await expect(worker.sql`
      select * from public.record_official_offer_edition_v1(
        ${JSON.stringify({ ...edition, externalEditionId: `numeric-auth-${randomUUID()}` })}::jsonb,
        ${JSON.stringify(numericPermissionAuthorization)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countPublications()).toBe(1);

    const stringCaptureId = { ...captureMetadata, publicationId: String(publicationId) };
    expect(officialOfferCaptureMetadataV1Schema.safeParse(stringCaptureId).success).toBe(false);
    await expect(worker.sql`
      select * from public.record_official_offer_capture_v1(
        ${JSON.stringify(stringCaptureId)}::jsonb,
        ${`official-offers/private/direct/${randomUUID()}`},
        ${JSON.stringify(authorization)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countCaptures()).toBe(1);

    const envelope = {
      contractVersion: 1,
      captureChecksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
      extractorVersion: `direct-${randomUUID()}`,
      method: "structured",
      layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
      schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
      startedAt: edition.discoveredAt,
      completedAt: edition.discoveredAt,
      emptyResult: "not-empty",
      candidates: [],
    };
    const timing = {
      contractVersion: 1,
      serverStartedAt: edition.discoveredAt,
      serverCompletedAt: edition.discoveredAt,
    };
    const validCandidate = {
      ...syntheticStructuredOfferCandidates[0]!,
      candidateKey: `direct-complete-${randomUUID()}`,
      validity: {
        state: "parsed",
        startsAt: edition.validFrom,
        endsAt: edition.validUntil,
      },
      geographicScope: edition.declaredGeographicScope,
    };
    const extractionPayload = (
      candidate: Record<string, unknown>,
      anomalies: string[] = [],
      options: {
        exactCanonicalProductId?: unknown;
        extractorVersion?: unknown;
        normalizedCandidate?: Record<string, unknown>;
      } = {},
    ) => ({
      contractVersion: 1,
      envelope: {
        ...envelope,
        extractorVersion: options.extractorVersion ?? `direct-${randomUUID()}`,
        candidates: [candidate],
      },
      edition,
      timing,
      authorization,
      counts: {
        envelopeSha256: "a".repeat(64),
        exactMatch: anomalies.length === 0 ? 1 : 0,
        persistedCandidates: 1,
        rejected: 0,
        reviewRequired: anomalies.length === 0 ? 0 : 1,
        total: 1,
        validationSha256: "b".repeat(64),
      },
      validationStatus: anomalies.length === 0 ? "completed" : "degraded",
      candidates: [{
        contractVersion: 1,
        anomalyCodes: anomalies,
        candidate: options.normalizedCandidate ?? candidate,
        disposition: anomalies.length === 0 ? "exact-match" : "review-required",
        publicationRoute: "human-review-required",
        ...(anomalies.length === 0
          ? { exactCanonicalProductId: options.exactCanonicalProductId ?? "product:direct" }
          : {}),
      }],
    });
    const [positiveExtraction] = await worker.sql<Array<{ id: string }>>`
      select id from public.record_official_offer_extraction_v1(
        ${captureId}, ${JSON.stringify(extractionPayload(validCandidate))}::jsonb
      )
    `;
    expect(Number(positiveExtraction!.id)).toBeGreaterThan(0);
    let expectedExtractionCount = 1;
    expect(await countExtractions()).toBe(expectedExtractionCount);

    const rawAnomalyOmissionCandidate = {
      ...validCandidate,
      candidateKey: `direct-raw-anomaly-${randomUUID()}`,
      anomalyCodes: ["UNMATCHED_PRODUCT"],
    };
    expect(extractedOfficialOfferCandidateV1Schema.safeParse(rawAnomalyOmissionCandidate).success).toBe(true);
    await expect(worker.sql`
      select * from public.record_official_offer_extraction_v1(
        ${captureId}, ${JSON.stringify(extractionPayload(rawAnomalyOmissionCandidate, [], {
          exactCanonicalProductId: "product:forged",
          normalizedCandidate: { ...rawAnomalyOmissionCandidate, anomalyCodes: [] },
        }))}::jsonb
      )
    `).rejects.toThrow();
    expect(await countExtractions()).toBe(expectedExtractionCount);

    const validUnionCandidates: Array<[string, Record<string, unknown>, string[]]> = [
      ["unresolved-product", {
        ...validCandidate,
        candidateKey: `direct-unresolved-${randomUUID()}`,
        product: { kind: "unresolved-label", label: "Synthetic unresolved product" },
        anomalyCodes: ["UNMATCHED_PRODUCT"],
      }, ["UNMATCHED_PRODUCT"]],
      ["unknown-package", {
        ...validCandidate,
        candidateKey: `direct-unknown-package-${randomUUID()}`,
        package: { state: "unknown", reasonCode: "MISSING" },
        anomalyCodes: ["PACKAGE_UNKNOWN"],
      }, ["PACKAGE_UNKNOWN"]],
      ["unreadable-validity", {
        ...validCandidate,
        candidateKey: `direct-unreadable-date-${randomUUID()}`,
        validity: { state: "unreadable", reasonCode: "OCR_AMBIGUOUS" },
        anomalyCodes: ["UNREADABLE_DATE"],
      }, ["UNREADABLE_DATE"]],
      ["member-eligibility", {
        ...validCandidate,
        candidateKey: `direct-member-${randomUUID()}`,
        eligibility: { kind: "member", programId: "synthetic-membership" },
      }, []],
      ["multibuy-pricing", {
        ...validCandidate,
        candidateKey: `direct-multibuy-${randomUUID()}`,
        pricing: { kind: "multibuy", quantity: 3, totalOre: 8_000, beforeUnitPriceOre: 3_000 },
      }, []],
      ["unknown-scope", {
        ...validCandidate,
        candidateKey: `direct-unknown-scope-${randomUUID()}`,
        geographicScope: { kind: "unknown", reason: "synthetic scope omitted" },
        anomalyCodes: ["UNKNOWN_SCOPE"],
      }, ["UNKNOWN_SCOPE"]],
      ["regions-scope", {
        ...validCandidate,
        candidateKey: `direct-regions-${randomUUID()}`,
        geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-03"] },
        anomalyCodes: ["SCOPE_MISMATCH"],
      }, ["SCOPE_MISMATCH"]],
      ["stores-scope", {
        ...validCandidate,
        candidateKey: `direct-stores-${randomUUID()}`,
        geographicScope: { kind: "stores", storeIds: ["store:synthetic:1"] },
        anomalyCodes: ["SCOPE_MISMATCH"],
      }, ["SCOPE_MISMATCH"]],
    ];
    for (const [label, candidate, anomalies] of validUnionCandidates) {
      expect(extractedOfficialOfferCandidateV1Schema.safeParse(candidate).success, label).toBe(true);
      const [row] = await worker.sql<Array<{ id: string }>>`
        select id from public.record_official_offer_extraction_v1(
          ${captureId}, ${JSON.stringify(extractionPayload(candidate, anomalies))}::jsonb
        )
      `;
      expect(Number(row!.id), label).toBeGreaterThan(0);
      expectedExtractionCount += 1;
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }

    const validEnvelope = { ...envelope, candidates: [validCandidate] };
    const validTiming = {
      contractVersion: 1,
      serverStartedAt: edition.discoveredAt,
      serverCompletedAt: edition.discoveredAt,
    };
    expect(extractedOfficialOfferCandidateV1Schema.safeParse(validCandidate).success).toBe(true);
    const candidateFixtures: JsonMutationFixture[] = [
      { name: "exact", value: validCandidate },
      ...validUnionCandidates.map(([name, value]) => ({ name, value })),
    ];
    const candidateFixtureAnomalies = new Map<string, string[]>([
      ["exact", []],
      ...validUnionCandidates.map(([name, _value, anomalies]) => [name, anomalies] as const),
    ]);
    const differentialMutations = differentialJsonLeafMutations(
      candidateFixtures,
      (value) => extractedOfficialOfferCandidateV1Schema.safeParse(value).success,
    );
    expect(differentialMutations.length).toBeGreaterThan(64);
    console.info(`Task 4 candidate differential mutations: ${differentialMutations.length}`);
    for (const { label, value: candidate } of differentialMutations) {
      const fixtureName = label.slice(0, label.indexOf(":"));
      const anomalies = candidateFixtureAnomalies.get(fixtureName) ?? [];
      try {
        await expect(worker.sql`
          select * from public.record_official_offer_extraction_v1(
            ${captureId}, ${JSON.stringify(extractionPayload(candidate, anomalies))}::jsonb
          )
        `, label).rejects.toThrow();
      } catch (error) {
        console.error(`Task 4 candidate mutation accepted: ${label}`);
        throw error;
      }
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }

    expect(officialOfferEditionDiscoveryInputV1Schema.safeParse(edition).success).toBe(true);
    const editionMutations = differentialJsonLeafMutations(
      [{ name: "edition", value: edition }],
      (value) => officialOfferEditionDiscoveryInputV1Schema.safeParse(value).success,
    );
    console.info(`Task 4 edition differential mutations: ${editionMutations.length}`);
    for (const { label, value: mutatedEdition } of editionMutations) {
      await expect(worker.sql`
        select * from public.record_official_offer_edition_v1(
          ${JSON.stringify(mutatedEdition)}::jsonb,
          ${JSON.stringify(authorization)}::jsonb
        )
      `).rejects.toThrow();
      expect(await countPublications(), label).toBe(1);
    }

    expect(officialOfferAuthorizationFenceV1Schema.safeParse(authorization).success).toBe(true);
    const authorizationMutations = differentialJsonLeafMutations(
      [{ name: "authorization", value: authorization }],
      (value) => officialOfferAuthorizationFenceV1Schema.safeParse(value).success,
    );
    console.info(`Task 4 authorization differential mutations: ${authorizationMutations.length}`);
    for (const { label, value: mutatedAuthorization } of authorizationMutations) {
      await expect(worker.sql`
        select * from public.record_official_offer_edition_v1(
          ${JSON.stringify({ ...edition, externalEditionId: `invalid-auth-${randomUUID()}` })}::jsonb,
          ${JSON.stringify(mutatedAuthorization)}::jsonb
        )
      `).rejects.toThrow();
      expect(await countPublications(), label).toBe(1);
    }

    expect(officialOfferCaptureMetadataV1Schema.safeParse(captureMetadata).success).toBe(true);
    const captureMutations = differentialJsonLeafMutations(
      [{ name: "capture", value: captureMetadata }],
      (value) => officialOfferCaptureMetadataV1Schema.safeParse(value).success,
    );
    console.info(`Task 4 capture differential mutations: ${captureMutations.length}`);
    for (const { label, value: mutatedCapture } of captureMutations) {
      await expect(worker.sql`
        select * from public.record_official_offer_capture_v1(
          ${JSON.stringify(mutatedCapture)}::jsonb,
          ${`official-offers/private/direct/${randomUUID()}`},
          ${JSON.stringify(authorization)}::jsonb
        )
      `).rejects.toThrow();
      expect(await countCaptures(), label).toBe(1);
    }

    const envelopeMutations = differentialJsonLeafMutations(
      [{ name: "envelope", value: validEnvelope }],
      (value) => officialOfferExtractionEnvelopeV1Schema.safeParse(value).success,
    );
    console.info(`Task 4 envelope differential mutations: ${envelopeMutations.length}`);
    for (const { label, value: mutatedEnvelope } of envelopeMutations) {
      const payload = extractionPayload(validCandidate);
      try {
        await expect(worker.sql`
          select * from public.record_official_offer_extraction_v1(
            ${captureId}, ${JSON.stringify({ ...payload, envelope: mutatedEnvelope })}::jsonb
          )
        `, label).rejects.toThrow();
      } catch (error) {
        console.error(`Task 4 envelope mutation accepted: ${label}`);
        throw error;
      }
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }

    const timingMutations = differentialJsonLeafMutations(
      [{ name: "timing", value: validTiming }],
      (value) => officialOfferExtractionTimingV1Schema.safeParse(value).success,
    );
    console.info(`Task 4 timing differential mutations: ${timingMutations.length}`);
    for (const { label, value: mutatedTiming } of timingMutations) {
      const payload = extractionPayload(validCandidate);
      await expect(worker.sql`
        select * from public.record_official_offer_extraction_v1(
          ${captureId}, ${JSON.stringify({ ...payload, timing: mutatedTiming })}::jsonb
        )
      `).rejects.toThrow();
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }

    const nullUnionCases: Array<[string, Record<string, unknown>]> = [
      ["product null discriminator", {
        ...validCandidate,
        product: { ...(validCandidate.product as Record<string, unknown>), kind: null },
      }],
      ["package missing discriminator", (() => {
        const { state: _state, ...packageWithoutState } = validCandidate.package as Record<string, unknown>;
        return { ...validCandidate, package: packageWithoutState };
      })()],
      ["package null unit", {
        ...validCandidate,
        package: { ...(validCandidate.package as Record<string, unknown>), unit: null },
      }],
      ["eligibility empty object", { ...validCandidate, eligibility: {} },],
      ["regions empty identifier", {
        ...validCandidate,
        geographicScope: { kind: "regions", countryCode: "NO", regionCodes: [""] },
      }],
      ["channels empty array element", { ...validCandidate, channels: [""] },],
    ];
    for (const [label, candidate] of nullUnionCases) {
      const anomalies = label === "regions empty identifier" ? ["SCOPE_MISMATCH"] : [];
      expect(extractedOfficialOfferCandidateV1Schema.safeParse(candidate).success, label).toBe(false);
      await expect(worker.sql`
        select * from public.record_official_offer_extraction_v1(
          ${captureId}, ${JSON.stringify(extractionPayload(candidate, anomalies))}::jsonb
        )
      `).rejects.toThrow();
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }
    const typedCandidateMutations: Array<[string, Record<string, unknown>]> = [
      ["candidate key number", { ...validCandidate, candidateKey: 123 }],
      ["product value number", {
        ...validCandidate,
        product: { ...(validCandidate.product as Record<string, unknown>), value: 70000001 },
      }],
      ["package amount string", {
        ...validCandidate,
        package: { ...(validCandidate.package as Record<string, unknown>), amount: "500" },
      }],
      ["pricing offer number string", {
        ...validCandidate,
        pricing: { ...(validCandidate.pricing as Record<string, unknown>), offerPriceOre: "2990" },
      }],
      ["member program number", {
        ...validCandidate,
        eligibility: { kind: "member", programId: 7 },
      }],
      ["validity timestamp number", {
        ...validCandidate,
        validity: { ...(validCandidate.validity as Record<string, unknown>), startsAt: 1 },
      }],
      ["scope country number", {
        ...validCandidate,
        geographicScope: { kind: "national", countryCode: 47 },
      }],
      ["provenance locator number", {
        ...validCandidate,
        provenance: { ...(validCandidate.provenance as Record<string, unknown>), evidenceLocator: 7 },
      }],
      ["channel number", { ...validCandidate, channels: [1] }],
      ["anomaly number", { ...validCandidate, anomalyCodes: [7] }],
    ];
    for (const [label, candidate] of typedCandidateMutations) {
      expect(extractedOfficialOfferCandidateV1Schema.safeParse(candidate).success, label).toBe(false);
      await expect(worker.sql`
        select * from public.record_official_offer_extraction_v1(
          ${captureId}, ${JSON.stringify(extractionPayload(candidate))}::jsonb
        )
      `).rejects.toThrow();
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }
    for (const [label, options] of [
      ["exact canonical product id number", { exactCanonicalProductId: 123 }],
      ["extractor version number", { extractorVersion: 7 }],
    ] as const) {
      await expect(worker.sql`
        select * from public.record_official_offer_extraction_v1(
          ${captureId}, ${JSON.stringify(extractionPayload(validCandidate, [], options))}::jsonb
        )
      `).rejects.toThrow();
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }
    expect(officialOfferExtractionEnvelopeV1Schema.safeParse(validEnvelope).success).toBe(true);
    for (const [label, mutation] of [
      ["envelope checksum number", { captureChecksumSha256: 3 }],
      ["envelope method number", { method: 1 }],
      ["envelope started timestamp number", { startedAt: 1 }],
      ["envelope empty result number", { emptyResult: 1 }],
    ] as const) {
      const payload = extractionPayload(validCandidate);
      const mutatedPayload = { ...payload, envelope: { ...validEnvelope, ...mutation } };
      expect(officialOfferExtractionEnvelopeV1Schema.safeParse(mutatedPayload.envelope).success, label)
        .toBe(false);
      await expect(worker.sql`
        select * from public.record_official_offer_extraction_v1(
          ${captureId}, ${JSON.stringify(mutatedPayload)}::jsonb
        )
      `).rejects.toThrow();
      expect(await countExtractions(), label).toBe(expectedExtractionCount);
    }
    expect(officialOfferExtractionTimingV1Schema.safeParse(validTiming).success).toBe(true);
    const timingPayload = extractionPayload(validCandidate);
    const invalidTimingPayload = {
      ...timingPayload,
      timing: { ...validTiming, serverStartedAt: 1 },
    };
    expect(officialOfferExtractionTimingV1Schema.safeParse(invalidTimingPayload.timing).success)
      .toBe(false);
    await expect(worker.sql`
      select * from public.record_official_offer_extraction_v1(
        ${captureId}, ${JSON.stringify(invalidTimingPayload)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countExtractions()).toBe(expectedExtractionCount);
    const badCandidatePayload = {
      contractVersion: 1,
      envelope,
      edition,
      timing,
      authorization,
      counts: {
        envelopeSha256: "a".repeat(64),
        exactMatch: 1,
        persistedCandidates: 1,
        rejected: 0,
        reviewRequired: 0,
        total: 1,
        validationSha256: "b".repeat(64),
      },
      validationStatus: "completed",
      candidates: [{
        contractVersion: 1,
        anomalyCodes: [],
        candidate: { candidateKey: "sparse", provenance: { confidence: 100 } },
        disposition: "exact-match",
        publicationRoute: "human-review-required",
      }],
    };
    await expect(worker.sql`
      select * from public.record_official_offer_extraction_v1(
        ${captureId}, ${JSON.stringify(badCandidatePayload)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countExtractions()).toBe(expectedExtractionCount);

    await expect(worker.sql`
      select * from public.record_official_offer_extraction_v1(
        ${captureId}, ${JSON.stringify({
          ...badCandidatePayload,
          edition: {
            ...edition,
            declaredGeographicScope: { kind: "national", countryCode: "NO" },
          },
        })}::jsonb
      )
    `).rejects.toThrow();
    expect(await countExtractions()).toBe(expectedExtractionCount);

    const staleAuthorization = {
      ...authorization,
      reviewedAt: new Date(Date.parse(String(authorization.reviewedAt)) - 1).toISOString(),
    };
    await expect(worker.sql`
      select * from public.record_official_offer_edition_v1(
        ${JSON.stringify({ ...edition, externalEditionId: `stale-${randomUUID()}` })}::jsonb,
        ${JSON.stringify(staleAuthorization)}::jsonb
      )
    `).rejects.toThrow();
    expect(await countPublications()).toBe(1);

    const cancelled = worker.sql`
      select * from public.record_official_offer_extraction_v1(
        ${captureId}, ${JSON.stringify(badCandidatePayload)}::jsonb
      )
    ` as unknown as PromiseLike<unknown> & { cancel(): void };
    cancelled.cancel();
    await expect(cancelled).rejects.toThrow();
    expect(await countExtractions()).toBe(expectedExtractionCount);
  }, 180_000);
});
