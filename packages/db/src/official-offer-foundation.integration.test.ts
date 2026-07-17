import { createHash, randomUUID } from "node:crypto";

import {
  SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  syntheticStructuredOfferCandidates,
} from "@handleplan/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresOfficialOfferFoundationRepository,
  type CurrentPublishedOfficialOffer,
} from "./official-offer-foundation";
import { PostgresPublicOfficialOfferReader } from "./public-official-offer-reader";
import { SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED } from "./source-governance-lock";

const runIntegration = process.env.RUN_OFFICIAL_OFFER_DB_INTEGRATION === "1";
const describeIntegration = runIntegration ? describe : describe.skip;

function iso(value: Date): string {
  return value.toISOString();
}

function syntheticGtin(seed: string): string {
  const body = `29${(BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 14)}`)
    % 10_000_000_000n).toString().padStart(10, "0")}`;
  const checksumSum = [...body].reduce((sum, digit, index) =>
    sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - checksumSum % 10) % 10}`;
}

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

  it("runs edition through current read and serializes a concurrent revocation", async () => {
    const suffix = randomUUID();
    const sourceId = `offer-proof-${suffix}`.slice(0, 64);
    const otherSourceId = `offer-proof-other-${suffix}`.slice(0, 64);
    const reviewedAt = new Date(Date.now() - 60_000);
    const validUntil = new Date(Date.now() + 60 * 60_000);
    const permissions = {
      officialOffers: true,
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
          ${reviewedAt}, ${validUntil}
        )
      `;
    }
    const [permission] = await first.sql<Array<{ id: string }>>`
      insert into source_permissions (
        source_id, decision, reviewed_at, valid_until, permissions
      ) values (
        ${sourceId}, 'approved', ${reviewedAt}, ${validUntil},
        ${first.sql.json(permissions)}
      )
      returning id
    `;
    const [otherPermission] = await first.sql<Array<{ id: string }>>`
      insert into source_permissions (
        source_id, decision, reviewed_at, valid_until, permissions
      ) values (
        ${otherSourceId}, 'approved', ${reviewedAt}, ${validUntil},
        ${first.sql.json(permissions)}
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
      const [row] = await first.sql<Array<{ now: Date }>>`
        select clock_timestamp() as now
      `;
      return row!.now;
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
        ${validFrom}, ${validTo}, ${scope!.id}, 'discovered', clock_timestamp(),
        'structured-feed',
        ${first.sql.json(edition.declaredGeographicScope)}, ${"f".repeat(64)},
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
        ${validFrom}, ${validTo}, ${scope!.id}, 'discovered', ${edition.discoveredAt},
        'structured-feed', ${first.sql.json(edition.declaredGeographicScope)},
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
      mimeType: "application/json",
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
      completed_at: Date;
      empty_confirmation_observed_at: Date;
    }>>`
      insert into extraction_runs (
        capture_id, extractor_version, status, started_at, completed_at,
        counts, extraction_method, extraction_permission_id,
        permission_capabilities, source_started_at, source_completed_at,
        empty_result, empty_confirmation, empty_confirmation_observed_at
      ) values (
        ${capture.id}, ${`confirmed-empty-${suffix}`}, 'completed',
        ${confirmedEmptyAt}, '2000-01-01T00:00:00.000Z', '{"total":0}'::jsonb,
        'structured', ${permission!.id},
        '["capture", "discover", "extract"]'::jsonb,
        ${confirmedEmptyAt}, ${confirmedEmptyAt}, 'confirmed-empty',
        ${first.sql.json({
          sourceId,
          externalEditionId: edition.externalEditionId,
          basis: "source-record-count-zero",
          evidenceLocator: "integration-count-field",
        })},
        '2000-01-01T00:00:00.000Z'
      )
      returning completed_at, empty_confirmation_observed_at
    `;
    expect(confirmedEmpty?.empty_confirmation_observed_at.getTime())
      .toBe(confirmedEmpty?.completed_at.getTime());

    await expect(first.sql`
      insert into extraction_runs (
        capture_id, extractor_version, status, started_at, completed_at,
        counts, extraction_method, extraction_permission_id,
        permission_capabilities, source_started_at, source_completed_at,
        empty_result, empty_confirmation, empty_confirmation_observed_at
      ) values (
        ${capture.id}, ${`self-dated-empty-${suffix}`}, 'completed',
        ${confirmedEmptyAt}, clock_timestamp(), '{"total":0}'::jsonb,
        'structured', ${permission!.id},
        '["capture", "discover", "extract"]'::jsonb,
        ${confirmedEmptyAt}, ${confirmedEmptyAt}, 'confirmed-empty',
        ${first.sql.json({
          sourceId,
          externalEditionId: edition.externalEditionId,
          basis: "source-record-count-zero",
          evidenceLocator: "integration-count-field",
          confirmedAt: "2000-01-01T00:00:00.000Z",
        })},
        null
      )
    `).rejects.toThrow(/canonically bound to the publication/i);

    const [candidate] = await first.sql<Array<{ candidate_sha256: string; id: string }>>`
      select id, encode(sha256(convert_to(normalized_fields::text, 'UTF8')), 'hex')
        as candidate_sha256
      from extracted_offer_candidates
      where extraction_run_id = ${extraction.id}
      limit 1
    `;
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
    const decision = {
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
      select encode(sha256(convert_to(${first.sql.json(decision)}::jsonb::text, 'UTF8')), 'hex')
        as sha256
    `;
    const decisionAt = await databaseNow();
    const [offer] = await first.sql<Array<{ id: string }>>`
      insert into approved_offers (
        offer_key, candidate_id, source_id, source_reference, chain,
        geographic_scope_id, amount_ore, before_amount_ore,
        membership_requirement, valid_from, valid_until,
        status, version, approved_at
      ) values (
        ${`official-review:${candidate!.id}:${decisionIdentity!.sha256}`},
        ${candidate!.id}, ${sourceId}, ${`review-candidate:${candidate!.id}:v1`},
        'extra', ${scope!.id}, 2990, 3990,
        'public', ${validFrom}, ${validTo}, 'approved', 1, ${decisionAt}
      )
      returning id
    `;
    await first.sql`
      insert into offer_targets (
        offer_id, product_id, family_slug, match_method, match_confidence
      ) values (${offer!.id}, ${product!.id}, null, 'exact_identifier', 100)
    `;
    await first.sql`
      insert into offer_conditions (offer_id, condition_type, condition_value)
      values (
        ${offer!.id}, 'channel',
        ${first.sql.json({ channels: ["in-store"] })}
      )
    `;
    await first.sql`
      insert into review_actions (
        candidate_id, offer_id, actor_id, action, expected_version,
        previous_values, new_values, reason, acted_at
      ) values (
        ${candidate!.id}, ${offer!.id}, ${`access:${"a".repeat(64)}`}, 'approve', 0,
        ${first.sql.json({
          candidateSha256: candidate!.candidate_sha256,
          contractVersion: 1,
          reviewVersion: 0,
        })},
        ${first.sql.json({
          contractVersion: 1,
          reviewVersion: 1,
          state: "approved",
          decision,
          decisionSha256: decisionIdentity!.sha256,
        })},
        'Synthetic integration approval', ${decisionAt}
      )
    `;
    await first.sql`
      update approved_offers set status = 'published' where id = ${offer!.id}
    `;
    await expect(first.sql`
      insert into offer_conditions (offer_id, condition_type, condition_value)
      values (${offer!.id}, 'payment', '{"kind":"card"}'::jsonb)
    `).rejects.toThrow(/conditions are sealed/i);
    const readAt = await databaseNow();
    const visible: readonly CurrentPublishedOfficialOffer[] =
      await repository.readCurrentPublishedOffers(readAt);
    expect(visible.find(({ id }) => id === Number(offer!.id))).toMatchObject({
      channels: ["in-store"],
      evidenceLevel: "reviewed",
      productId: Number(product!.id),
      sourceId,
    });
    const publicSnapshot = await new PostgresPublicOfficialOfferReader(first.db).getMany(
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
    const legacyDecisionAt = await databaseNow();
    const [legacyOffer] = await first.sql<Array<{ id: string }>>`
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
        ${validFrom}, ${validTo}, 'approved', 1, ${legacyDecisionAt}
      )
      returning id
    `;
    await first.sql`
      insert into offer_targets (
        offer_id, product_id, family_slug, match_method, match_confidence
      ) values (${legacyOffer!.id}, ${product!.id}, null, 'exact_identifier', 100)
    `;
    await first.sql`
      insert into offer_conditions (offer_id, condition_type, condition_value)
      values (
        ${legacyOffer!.id}, 'channel',
        ${first.sql.json({ channels: ["in-store"] })}
      )
    `;
    await first.sql`
      insert into review_actions (
        candidate_id, offer_id, actor_id, action, expected_version,
        previous_values, new_values, reason, acted_at,
        decision_boundary_version
      ) values (
        ${legacyCandidate!.id}, ${legacyOffer!.id},
        ${`access:${"b".repeat(64)}`}, 'approve', 0,
        ${first.sql.json({
          candidateSha256: legacyCandidate!.candidate_sha256,
          contractVersion: 1,
          reviewVersion: 0,
        })},
        ${first.sql.json({
          contractVersion: 1,
          reviewVersion: 1,
          state: "approved",
          decision,
          decisionSha256: decisionIdentity!.sha256,
        })},
        'Legacy direct-table approval probe', ${legacyDecisionAt}, null
      )
    `;
    await first.sql`
      update approved_offers set status = 'published' where id = ${legacyOffer!.id}
    `;
    const legacyQuarantined = await new PostgresPublicOfficialOfferReader(first.db).getMany(
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
        ${new Date(reviewedAt.getTime() - 60_000)}, null, '{}'::jsonb
      )
    `.finally(() => {
      revocationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revocationSettled).toBe(false);
    releaseLock();
    await Promise.all([holding, revocation]);

    expect(await repository.readCurrentPublishedOffers(await databaseNow())).toEqual([]);
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
          ${sourceId}, 'approved', ${reapprovedAt}, ${reapprovedUntil},
          ${transaction.json(permissions)}
        )
      `;
      await transaction`
        update data_sources
        set runtime_state = 'approved',
            permission_reviewed_at = ${reapprovedAt},
            permission_expires_at = ${reapprovedUntil}
        where id = ${sourceId}
      `;
    });
    expect(await new PostgresPublicOfficialOfferReader(first.db).getMany(
      [`product:${product!.id}`],
      await databaseNow(),
    )).toEqual({ offers: [], sources: [] });
  }, 30_000);
});
