import { createHash, randomUUID } from "node:crypto";

import {
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  type OfficialOfferAuthorizationFenceV1,
  type OfficialOfferEditionDiscoveryInputV1,
  type OfficialOfferExtractionEnvelopeV1,
  type ReviewDecisionRequestV1,
  type ReviewQueueCandidateV1,
} from "@handleplan/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresOfficialOfferFoundationRepository } from "./official-offer-foundation";
import {
  PostgresOfficialOfferLifecycleRepository,
  type OfficialOfferLifecycleRequestV1,
} from "./official-offer-lifecycle";
import { PostgresPublicOfficialOfferReader } from "./public-official-offer-reader";
import { PostgresReviewQueueRepository } from "./review-queue";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const temporalRaceApplicationName = "handleplan-offer-temporal-race";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function databaseDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Offer publication vertical returned an invalid database clock");
  }
  return date;
}

function validGtin13(seed: string): string {
  const digits = (BigInt(`0x${digest(seed).slice(0, 16)}`) % 10_000_000_000n)
    .toString()
    .padStart(10, "0");
  const body = `29${digits}`;
  const sum = [...body].reduce((total, digit, index) =>
    total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - sum % 10) % 10}`;
}

function reviewProofToken(seed: string, expiresAt: Date): string {
  return `review-proof:v1.${expiresAt.getTime().toString(36)}.${digest(seed).slice(0, 22)}.${digest(`${seed}:binding`)}.${digest(`${seed}:signature`)}`;
}

function withApplicationName(databaseUrl: string, applicationName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForLifecycleLock(
  connection: DatabaseConnection,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await connection.sql<Array<{
      state: string;
      wait_event_type: string | null;
    }>>`
      select state, wait_event_type
      from pg_catalog.pg_stat_activity
      where application_name = ${applicationName}
        and pid <> pg_catalog.pg_backend_pid()
      order by query_start desc
      limit 1
    `;
    if (activity?.state === "active" && activity.wait_event_type === "Lock") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Offer publication did not reach the expected database lock wait");
}

describe.skipIf(!runDatabaseIntegration).sequential(
  "official-offer reviewed publication vertical",
  () => {
    let admin: DatabaseConnection;
    let contender: DatabaseConnection;
    let publisher: DatabaseConnection;
    let review: DatabaseConnection;
    let web: DatabaseConnection;

    beforeAll(() => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      if (!process.env.REVIEW_DATABASE_URL || !process.env.WEB_DATABASE_URL) {
        throw new Error(
          "REVIEW_DATABASE_URL and WEB_DATABASE_URL are required for the publication vertical",
        );
      }
      admin = createDatabase(process.env.DATABASE_URL);
      contender = createDatabase(process.env.DATABASE_URL);
      publisher = createDatabase(withApplicationName(
        process.env.DATABASE_URL,
        temporalRaceApplicationName,
      ));
      review = createDatabase(process.env.REVIEW_DATABASE_URL);
      web = createDatabase(process.env.WEB_DATABASE_URL);
    });

    afterAll(async () => {
      if (admin !== undefined) {
        await admin.sql`
          update official_offer_publication_policy
          set enabled = false, updated_at = clock_timestamp()
          where policy_key = 'official-offer-publication-v1'
        `;
      }
      await Promise.all([
        admin?.close(),
        contender?.close(),
        publisher?.close(),
        review?.close(),
        web?.close(),
      ]);
    });

    it("keeps reviewed offers gated and preserves as-of truth across a publication lock race", async () => {
      const suffix = randomUUID();
      const sourceId = `offer-vertical-${suffix}`.slice(0, 64);
      const actor = {
        actorId: `access:${digest(`${suffix}:actor`)}`,
        sessionId: `access-session:${digest(`${suffix}:session`)}`,
      };
      const databaseNow = async (): Promise<Date> => {
        const [row] = await admin.sql<Array<{ now: Date }>>`
          select date_trunc('milliseconds', clock_timestamp()) as now
        `;
        return databaseDate(row?.now);
      };

      const initialNow = await databaseNow();
      const reviewedAt = new Date(initialNow.getTime() - 60_000);
      const permissionValidUntil = new Date(initialNow.getTime() + 60 * 60_000);
      const offerValidFrom = new Date(initialNow.getTime() - 60 * 60_000);
      const offerValidUntil = new Date(initialNow.getTime() + 30 * 60_000);
      const capabilities = ["capture", "discover", "extract", "ocr"] as const;
      const rightsClassifications = [
        "extract_only",
        "private_review",
        "public_display",
      ] as const;
      const permissions = {
        officialOffers: true,
        privateReview: true,
        publicDisplay: true,
        officialOfferCapabilities: capabilities,
        officialOfferRightsClassifications: rightsClassifications,
      };

      await admin.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId}, 'Synthetic reviewed publication vertical', 'offer', 'approved',
          ${reviewedAt.toISOString()}, ${permissionValidUntil.toISOString()}
        )
      `;
      const [permission] = await admin.sql<Array<{ id: string }>>`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions
        ) values (
          ${sourceId}, 'approved', ${reviewedAt.toISOString()},
          ${permissionValidUntil.toISOString()}, ${JSON.stringify(permissions)}::jsonb
        )
        returning id
      `;
      const [scope] = await admin.sql<Array<{ id: string }>>`
        insert into geographic_scopes (scope_key, scope_kind, label, country_code)
        values (
          ${`offer-vertical:${suffix}`}, 'national',
          'Synthetic reviewed publication scope', 'NO'
        )
        returning id
      `;
      if (permission === undefined || scope === undefined) {
        throw new Error("Offer publication vertical setup did not return identifiers");
      }

      const products = await Promise.all(["exact", "ocr"].map(async (kind) => {
        const gtin = validGtin13(`${suffix}:${kind}`);
        const [product] = await admin.sql<Array<{ id: string }>>`
          insert into canonical_products (
            display_name, package_amount, package_unit, units_per_pack
          ) values (${`Synthetic ${kind} publication product`}, 500, 'g', 1)
          returning id
        `;
        if (product === undefined) throw new Error("Missing synthetic product ID");
        await admin.sql`
          insert into product_identifiers (
            product_id, scheme, value, confidence, verified_at
          ) values (${product.id}, 'ean13', ${gtin}, 100, clock_timestamp())
        `;
        return { gtin, id: product.id, kind };
      }));

      const foundation = new PostgresOfficialOfferFoundationRepository(admin.db);
      const fence = async (): Promise<OfficialOfferAuthorizationFenceV1> => ({
        capabilities: [...capabilities],
        contractVersion: 1,
        decision: "approved",
        evaluatedAt: (await databaseNow()).toISOString(),
        permissionId: Number(permission.id),
        reviewedAt: reviewedAt.toISOString(),
        rightsClassifications: [...rightsClassifications],
        sourceId,
        validUntil: permissionValidUntil.toISOString(),
      });

      const extractionRows: Array<{
        candidateId: string;
        candidate: ReviewQueueCandidateV1;
        productId: string;
      }> = [];
      for (const product of products) {
        const discoveredAt = await databaseNow();
        const edition: OfficialOfferEditionDiscoveryInputV1 = {
          authorization: {
            capabilities: [...capabilities],
            decision: "approved",
            reviewedAt: reviewedAt.toISOString(),
            validUntil: permissionValidUntil.toISOString(),
          },
          chain: "extra",
          contentKind: "structured-feed",
          contractVersion: 1,
          declaredGeographicScope: { countryCode: "NO", kind: "national" },
          discoveredAt: discoveredAt.toISOString(),
          externalEditionId: `vertical-${product.kind}-${suffix}`,
          geographicScopeId: Number(scope.id),
          sourceId,
          title: `Synthetic ${product.kind} reviewed edition`,
          validFrom: offerValidFrom.toISOString(),
          validUntil: offerValidUntil.toISOString(),
        };
        const recordedEdition = await foundation.recordEdition(edition, await fence());
        const checksumSha256 = digest(`${suffix}:${product.kind}:capture`);
        const capture = await foundation.recordCapture({
          byteLength: 256,
          checksumSha256,
          contractVersion: 1,
          externalEditionId: edition.externalEditionId,
          mimeType: "image/png",
          publicationId: recordedEdition.id,
          retrievedAt: (await databaseNow()).toISOString(),
          rightsClassification: "public_display",
          sourceId,
        }, `official-offers/private/vertical/${suffix}/${product.kind}`, await fence());
        const extractionAt = await databaseNow();
        const method = product.kind === "ocr" ? "ocr" as const : "structured" as const;
        const envelope: OfficialOfferExtractionEnvelopeV1 = {
          candidates: [{
            anomalyCodes: [],
            candidateKey: `vertical-${product.kind}-${suffix}`,
            channels: ["in-store"],
            contractVersion: 1,
            eligibility: { kind: "public" },
            geographicScope: { countryCode: "NO", kind: "national" },
            package: { amount: 500, state: "parsed", unit: "g", unitsPerPack: 1 },
            pricing: {
              beforePriceOre: product.kind === "ocr" ? 4_990 : 3_990,
              kind: "unit",
              offerPriceOre: product.kind === "ocr" ? 3_490 : 2_990,
            },
            product: { kind: "exact-identifier", scheme: "gtin", value: product.gtin },
            provenance: {
              confidence: product.kind === "ocr" ? 92 : 100,
              evidenceLocator: `vertical-evidence-${product.kind}-${suffix}`,
              method,
            },
            validity: {
              endsAt: offerValidUntil.toISOString(),
              startsAt: offerValidFrom.toISOString(),
              state: "parsed",
            },
          }],
          captureChecksumSha256: checksumSha256,
          completedAt: extractionAt.toISOString(),
          contractVersion: 1,
          emptyResult: "not-empty",
          extractorVersion: `vertical-${product.kind}-v1-${suffix}`,
          layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
          method,
          schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
          startedAt: extractionAt.toISOString(),
        };
        const extraction = await foundation.recordExtraction(
          capture.id,
          envelope,
          edition,
          {
            contractVersion: 1,
            exactProductIdsByGtin: { [product.gtin]: [`product:${product.id}`] },
            expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
            expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
          },
          {
            contractVersion: 1,
            serverCompletedAt: extractionAt.toISOString(),
            serverStartedAt: extractionAt.toISOString(),
          },
          await fence(),
          method === "ocr" ? await fence() : undefined,
        );
        expect(extraction.counts).toEqual(method === "ocr"
          ? { exactMatch: 0, rejected: 0, reviewRequired: 1, total: 1 }
          : { exactMatch: 1, rejected: 0, reviewRequired: 0, total: 1 });
        const [candidateRow] = await admin.sql<Array<{ id: string }>>`
          select id
          from extracted_offer_candidates
          where extraction_run_id = ${extraction.id}
        `;
        if (candidateRow === undefined) throw new Error("Missing persisted review candidate");
        const reviewRepository = new PostgresReviewQueueRepository(review.db);
        const candidateId = `review-candidate:${candidateRow.id}`;
        const candidate = await reviewRepository.get(candidateId, await databaseNow());
        extractionRows.push({ candidate, candidateId, productId: product.id });
      }

      expect(extractionRows.map(({ candidate }) => candidate.extractionDisposition).sort())
        .toEqual(["exact-match", "review-required"]);
      const ocrCandidate = extractionRows.find(({ candidate }) =>
        candidate.extractionMethod === "ocr")?.candidate;
      expect(ocrCandidate?.anomalyCodes).toEqual(["OCR_REVIEW_REQUIRED"]);
      expect(ocrCandidate?.candidate.anomalyCodes).toEqual(["OCR_REVIEW_REQUIRED"]);

      await admin.sql`
        update official_offer_publication_policy
        set enabled = true, updated_at = clock_timestamp()
        where policy_key = 'official-offer-publication-v1'
      `;
      const lifecycle = new PostgresOfficialOfferLifecycleRepository(admin.db);
      const lifecycleRequest = async (
        label: string,
      ): Promise<OfficialOfferLifecycleRequestV1> => ({
        batchLimit: 50,
        contractVersion: 1,
        jobId: `${sourceId}:${label}`,
        ownerId: `vertical-owner:${suffix}`,
        publicationRequested: true,
        runId: `vertical-run:${label}:${suffix}`,
        scheduledAt: await databaseNow(),
        sourceId,
      });
      const preReview = await lifecycle.reconcile(await lifecycleRequest("pre-review"));
      expect(preReview).toMatchObject({
        publicationExamined: 0,
        publishedCount: 0,
        publicationState: "evaluated",
      });
      const publicReader = new PostgresPublicOfficialOfferReader(web.db);
      await expect(publicReader.getMany(
        extractionRows.map(({ productId }) => `product:${productId}`),
        await databaseNow(),
      )).resolves.toEqual({ offers: [], sources: [] });

      const reviewRepository = new PostgresReviewQueueRepository(review.db);
      for (const { candidate, candidateId } of extractionRows) {
        const locator = await reviewRepository.getPrivateCaptureLocator(
          candidateId,
          await databaseNow(),
        );
        const proofSha256 = digest(`${suffix}:${candidateId}:proof`);
        const renderClock = await databaseNow();
        const expiresAt = new Date(renderClock.getTime() + 60_000);
        await reviewRepository.recordEvidenceRender({
          ...actor,
          candidateId,
          checksumSha256: locator.checksumSha256,
          cropReference: locator.cropReference,
          evidenceProofSha256: proofSha256,
          expectedVersion: 0,
          expiresAt: expiresAt.toISOString(),
          presentation: "full_capture",
          rightsClassification: "public_display",
        }, renderClock);
        if (
          candidate.candidate.product.kind !== "exact-identifier"
          || candidate.candidate.validity.state !== "parsed"
        ) throw new Error("Synthetic review candidate is not exactly approvable");
        const request: ReviewDecisionRequestV1 = {
          action: "approve",
          approvalEvidence: {
            presentation: "full_capture",
            token: reviewProofToken(`${suffix}:${candidateId}`, expiresAt),
          },
          candidateId,
          contractVersion: 1,
          decision: {
            channels: [...candidate.candidate.channels],
            eligibility: candidate.candidate.eligibility,
            pricing: candidate.candidate.pricing,
            target: {
              gtin: candidate.candidate.product.value,
              kind: "exact-product",
            },
            validity: {
              endsAt: candidate.candidate.validity.endsAt,
              startsAt: candidate.candidate.validity.startsAt,
            },
          },
          expectedVersion: 0,
          reason: "Synthetic full-capture fields match the immutable candidate.",
        };
        await expect(reviewRepository.decide(
          request,
          actor,
          proofSha256,
          await databaseNow(),
        )).resolves.toMatchObject({ state: "approved" });
      }

      const [expiredProduct] = await admin.sql<Array<{ id: string }>>`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack
        ) values ('Synthetic already-ended lifecycle product', 1, 'piece', 1)
        returning id
      `;
      const [expiredOffer] = await admin.sql<Array<{ id: string }>>`
        insert into approved_offers (
          offer_key, source_id, source_reference, chain, geographic_scope_id,
          amount_ore, membership_requirement, valid_from, valid_until,
          status, version, approved_at
        ) values (
          ${`vertical-expired:${suffix}`}, ${sourceId}, ${`vertical-expired:${suffix}`},
          'extra', ${scope.id}, 990, 'public',
          ${new Date(initialNow.getTime() - 2 * 60 * 60_000).toISOString()},
          ${new Date(initialNow.getTime() - 60 * 60_000).toISOString()},
          'approved', 1,
          ${new Date(initialNow.getTime() - 2 * 60 * 60_000).toISOString()}
        )
        returning id
      `;
      if (expiredProduct === undefined || expiredOffer === undefined) {
        throw new Error("Missing synthetic expiry fixture");
      }
      await admin.sql`
        insert into offer_targets (
          offer_id, product_id, family_slug, match_method, match_confidence
        ) values (${expiredOffer.id}, ${expiredProduct.id}, null, 'human_review', 100)
      `;

      const publishRequest = await lifecycleRequest("publish-reviewed");
      const [offerToLock] = await admin.sql<Array<{ id: string }>>`
        select offer.id
        from approved_offers offer
        where offer.source_id = ${sourceId}
          and offer.status = 'approved'
          and offer.candidate_id is not null
        order by offer.id
        limit 1
      `;
      if (offerToLock === undefined) {
        throw new Error("Missing reviewed offer for temporal publication race");
      }

      let confirmPublicationLock!: () => void;
      let releasePublicationLock!: () => void;
      const publicationLockHeld = new Promise<void>((resolve) => {
        confirmPublicationLock = resolve;
      });
      const publicationLockRelease = new Promise<void>((resolve) => {
        releasePublicationLock = resolve;
      });
      const publicationLockHolder = contender.sql.begin(async (transaction) => {
        await transaction`
          select offer.id
          from approved_offers offer
          where offer.id = ${offerToLock.id}
          for update of offer
        `;
        confirmPublicationLock();
        await publicationLockRelease;
      });
      await publicationLockHeld;

      const publishingLifecycle = new PostgresOfficialOfferLifecycleRepository(publisher.db);
      const publication = publishingLifecycle.reconcile(publishRequest);
      let preCommitAsOf!: Date;
      try {
        await waitForLifecycleLock(admin, temporalRaceApplicationName);
        preCommitAsOf = await databaseNow();
        // The client timestamp is millisecond-precision. Keep the publisher
        // blocked across the next millisecond so the persisted ordering can be
        // asserted without discarding PostgreSQL's finer clock precision.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      } finally {
        releasePublicationLock();
        await publicationLockHolder;
      }
      const published = await publication;
      expect(published).toMatchObject({
        expiredCount: 1,
        expiryExamined: 1,
        publicationExamined: 2,
        publicationState: "evaluated",
        publishedCount: 2,
        revokedCount: 0,
      });

      const transitionedOffers = await admin.sql<Array<{ updated_at: Date }>>`
        select offer.updated_at
        from approved_offers offer
        where offer.source_id = ${sourceId}
          and offer.status = 'published'
        order by offer.id
      `;
      expect(transitionedOffers).toHaveLength(2);
      expect(transitionedOffers.every(({ updated_at: updatedAt }) =>
        databaseDate(updatedAt).getTime() > preCommitAsOf.getTime())).toBe(true);
      await expect(publicReader.getMany(
        extractionRows.map(({ productId }) => `product:${productId}`),
        preCommitAsOf,
      )).resolves.toEqual({ offers: [], sources: [] });

      await expect(lifecycle.reconcile(publishRequest)).resolves.toMatchObject({
        databaseAsOf: published.databaseAsOf,
        outcome: "replayed",
        replayed: true,
      });

      const publicSnapshot = await publicReader.getMany(
        extractionRows.map(({ productId }) => `product:${productId}`),
        await databaseNow(),
      );
      expect(publicSnapshot.offers).toHaveLength(2);
      expect(new Set(publicSnapshot.offers.map(({ productMatch }) => {
        if (productMatch.kind !== "exact") {
          throw new Error("Reviewed official offer did not retain an exact product target");
        }
        return productMatch.canonicalProductId;
      }))).toEqual(new Set(
        extractionRows.map(({ productId }) => `product:${productId}`),
      ));

      let releaseLock!: () => void;
      let confirmLock!: () => void;
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const locked = new Promise<void>((resolve) => { confirmLock = resolve; });
      const holder = contender.sql.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(hashtextextended(
            ${`official-offer-lifecycle-v1:${sourceId}`}, 7229164306
          ))
        `;
        confirmLock();
        await release;
      });
      await locked;
      try {
        await expect(lifecycle.reconcile(await lifecycleRequest("contended")))
          .resolves.toMatchObject({
            outcome: "lease-unavailable",
            publicationState: "not-evaluated",
          });
      } finally {
        releaseLock();
        await holder;
      }

      await admin.sql`
        update data_sources
        set runtime_state = 'revoked',
            kill_switch_reason = 'Synthetic publication vertical revocation',
            updated_at = clock_timestamp()
        where id = ${sourceId}
      `;
      const revokeRequest = await lifecycleRequest("revoke-published");
      const revoked = await lifecycle.reconcile(revokeRequest);
      expect(revoked).toMatchObject({
        expiredCount: 0,
        expiryExamined: 2,
        publicationExamined: 0,
        publicationState: "source-ineligible",
        publishedCount: 0,
        revokedCount: 2,
      });
      await expect(lifecycle.reconcile(revokeRequest)).resolves.toMatchObject({
        outcome: "replayed",
        replayed: true,
        revokedCount: 2,
      });
      await expect(publicReader.getMany(
        extractionRows.map(({ productId }) => `product:${productId}`),
        await databaseNow(),
      )).resolves.toEqual({ offers: [], sources: [] });
    }, 45_000);
  },
);
