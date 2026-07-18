import { createHash } from "node:crypto";

import {
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  type OfficialOfferAuthorizationFenceV1,
  type OfficialOfferEditionDiscoveryInputV1,
  type OfficialOfferExtractionEnvelopeV1,
  type ReviewDecisionRequestV1,
} from "@handleplan/domain";
import { describe, expect, it } from "vitest";

import { PostgresBranchDirectory } from "./branch-directory";
import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresIngestionRepository,
  type IngestionFenceVerifier,
} from "./ingestion";
import { PostgresOfficialOfferFoundationRepository } from "./official-offer-foundation";
import { PostgresOfficialOfferLifecycleRepository } from "./official-offer-lifecycle";
import { PostgresPlanningEvidenceReader } from "./planning-evidence-reader";
import { PostgresPublicCatalogIndexReader } from "./public-catalog-index-reader";
import { PostgresPublicOfficialOfferReader } from "./public-official-offer-reader";
import { PostgresReviewQueueRepository } from "./review-queue";
import { productionImageDatabaseFixture as fixture } from "../../../tests/image-e2e/production-image-database-fixture";

const runProductionImageDatabaseSeed =
  process.env.RUN_PRODUCTION_IMAGE_DATABASE_SEED === "1";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function databaseDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("exact-image seed received an invalid database clock");
  }
  return date;
}

function reviewProofToken(seed: string, expiresAt: Date): string {
  return `review-proof:v1.${expiresAt.getTime().toString(36)}.${digest(seed).slice(0, 22)}.${digest(`${seed}:binding`)}.${digest(`${seed}:signature`)}`;
}

function requiredDatabaseUrl(name: string, expectedUser: string): string {
  const value = process.env[name] ?? "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`exact-image seed ${name} is invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "5432"
    || parsed.pathname !== "/handleplan"
    || parsed.username !== expectedUser
    || parsed.password.length < 16
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(`exact-image seed ${name} does not match its isolated CI role`);
  }
  return parsed.toString();
}

describe.skipIf(!runProductionImageDatabaseSeed).sequential(
  "exact production image governed database fixture",
  () => {
    it("publishes one rights-current product, price, offer, and store through real boundaries", async () => {
      const revision = process.env.APP_COMMIT_SHA ?? "";
      expect(revision).toMatch(/^[0-9a-f]{40}$/u);
      const suffix = revision.slice(0, 12);
      const admin = createDatabase(requiredDatabaseUrl(
        "HANDLEPLAN_IMAGE_SEED_DATABASE_URL",
        "handleplan",
      ));
      const app = createDatabase(requiredDatabaseUrl(
        "HANDLEPLAN_IMAGE_SEED_APP_DATABASE_URL",
        "handleplan_app",
      ));
      const review = createDatabase(requiredDatabaseUrl(
        "HANDLEPLAN_IMAGE_SEED_REVIEW_DATABASE_URL",
        "handleplan_review",
      ));
      const web = createDatabase(requiredDatabaseUrl(
        "HANDLEPLAN_IMAGE_DATABASE_URL",
        "handleplan_web",
      ));

      const sourceIds = {
        catalog: `image-catalog-${suffix}`,
        offer: `image-offer-${suffix}`,
        price: `image-price-${suffix}`,
        store: `image-store-${suffix}`,
      };
      const fenceToken = `image-seed-fence-${suffix}`;
      const verifyFence: IngestionFenceVerifier = async (transaction) => {
        await transaction.execute("select 1");
      };
      const ingestion = new PostgresIngestionRepository(admin.db, { verifyFence });
      let policyWasEnabled = false;

      const databaseNow = async (connection: DatabaseConnection = admin): Promise<Date> => {
        const [row] = await connection.sql<Array<{ now: Date }>>`
          select date_trunc('milliseconds', clock_timestamp()) as now
        `;
        return databaseDate(row?.now);
      };
      const beginRun = async (sourceId: string, runType: string, label: string, now: Date) => {
        const result = await ingestion.beginRun({
          fenceToken,
          jobId: `image-seed:${suffix}:${label}`,
          runType,
          sourceId,
          startedAt: new Date(now.getTime() - 5 * 60_000),
        });
        expect(result.created).toBe(true);
        return result.handle;
      };
      const finalizeRun = async (
        handle: Awaited<ReturnType<typeof beginRun>>,
        completedAt: Date,
      ) => {
        const result = await ingestion.finalizeRun(handle, {
          completedAt,
          failed: 0,
          status: "completed",
        });
        expect(result.status).toBe("completed");
      };

      try {
        const now = await databaseNow();
        const reviewedAt = new Date(now.getTime() - 10 * 60_000);
        const validUntil = new Date(now.getTime() + 24 * 60 * 60_000);
        const sourceDefinitions = [
          {
            displayName: "CI verifisert varekatalog",
            id: sourceIds.catalog,
            kind: "catalog",
            permissions: { catalog: true },
          },
          {
            displayName: "CI verifisert ordinærpris",
            id: sourceIds.price,
            kind: "ordinary_price",
            permissions: { ordinaryPrice: true },
          },
          {
            displayName: "CI verifisert butikkregister",
            id: sourceIds.store,
            kind: "store",
            permissions: { physicalStore: true },
          },
          {
            displayName: "CI verifisert offisielt tilbud",
            id: sourceIds.offer,
            kind: "offer",
            permissions: {
              officialOffers: true,
              privateReview: true,
              publicDisplay: true,
              officialOfferCapabilities: ["capture", "discover", "extract", "ocr"],
              officialOfferRightsClassifications: [
                "extract_only",
                "private_review",
                "public_display",
              ],
            },
          },
        ] as const;
        for (const source of sourceDefinitions) {
          await admin.sql`
            insert into data_sources (
              id, display_name, source_kind, runtime_state, public_reference_url,
              permission_reviewed_at, permission_expires_at
            ) values (
              ${source.id}, ${source.displayName}, ${source.kind}, 'approved',
              'https://github.com/Reedtrullz/Handli',
              ${reviewedAt.toISOString()}, ${validUntil.toISOString()}
            )
          `;
          await admin.sql`
            insert into source_permissions (
              source_id, decision, reviewed_at, valid_until,
              public_reference_url, permissions, notes
            ) values (
              ${source.id}, 'approved', ${reviewedAt.toISOString()},
              ${validUntil.toISOString()}, 'https://github.com/Reedtrullz/Handli',
              ${JSON.stringify(source.permissions)}::jsonb,
              'Ephemeral CI-only exact-image fixture with synthetic public-display evidence.'
            )
          `;
        }

        const [scope] = await admin.sql<Array<{ id: number }>>`
          insert into geographic_scopes (
            scope_key, scope_kind, label, country_code, status
          ) values (
            ${`image-seed:national:${suffix}`}, 'national',
            'Hele Norge, eksakt bilde-fixture', 'NO', 'active'
          )
          returning id::integer as id
        `;
        if (scope === undefined) throw new Error("exact-image seed scope was not created");

        const catalogRetrievedAt = new Date(now.getTime() - 3 * 60_000);
        const catalogRun = await beginRun(sourceIds.catalog, "catalog", "catalog", now);
        await expect(ingestion.persistCatalogOutcomes(catalogRun, [{
          outcomeState: "accepted",
          product: {
            brand: fixture.brand,
            categoryPath: [
              { depth: 1, name: "Meieri", sourceCategoryId: "10" },
              { depth: 2, name: "Melk", sourceCategoryId: "20" },
            ],
            displayName: fixture.productName,
            packageAmount: 1_000,
            packageUnit: "ml",
            retrievedAt: catalogRetrievedAt,
            sourceUpdatedAt: new Date(catalogRetrievedAt.getTime() - 30_000),
            unitsPerPack: 1,
          },
          recordKind: "product",
          recordedAt: catalogRetrievedAt,
          sourceRecordId: `image-product-${suffix}`,
          subjectEan: fixture.gtin,
        }])).resolves.toEqual({ inserted: 1, received: 1 });
        await finalizeRun(catalogRun, new Date(now.getTime() - 2 * 60_000));

        const [product] = await admin.sql<Array<{ id: number }>>`
          select identifier.product_id::integer as id
          from product_identifiers identifier
          inner join canonical_products product on product.id = identifier.product_id
          where identifier.value = ${fixture.gtin}
            and identifier.scheme = 'ean13'
            and product.status = 'active'
        `;
        if (product === undefined) throw new Error("exact-image seed product was not created");

        const priceObservedAt = new Date(now.getTime() - 2 * 60_000);
        const priceFetchedAt = new Date(now.getTime() - 60_000);
        const priceRun = await beginRun(
          sourceIds.price,
          "benchmark-prices",
          "ordinary-price",
          now,
        );
        await expect(ingestion.persistPriceOutcomes(priceRun, [
          {
            outcomeState: "accepted",
            price: {
              amountOre: fixture.ordinaryPriceOre,
              fetchedAt: priceFetchedAt,
              geographicScopeId: scope.id,
              observedAt: priceObservedAt,
              sourceReference: `ci:image-seed:ordinary:${suffix}`,
            },
            recordKind: "price" as const,
            recordedAt: priceFetchedAt,
            sourceRecordId: `image-price-extra-${suffix}`,
            subjectChain: "extra",
            subjectEan: fixture.gtin,
          },
          ...(["bunnpris", "rema-1000"] as const).map((chain) => ({
            geographicScopeId: scope.id,
            outcomeState: "unknown" as const,
            reason: "source_unavailable",
            recordKind: "price" as const,
            recordedAt: priceFetchedAt,
            sourceRecordId: `image-price-${chain}-${suffix}`,
            subjectChain: chain,
            subjectEan: fixture.gtin,
          })),
        ])).resolves.toEqual({ inserted: 3, received: 3 });
        await finalizeRun(priceRun, now);

        const storeObservedAt = new Date(now.getTime() - 2 * 60_000);
        const storeCheckedAt = new Date(now.getTime() - 60_000);
        const storeRun = await beginRun(sourceIds.store, "physical-stores", "stores", now);
        await expect(ingestion.persistPhysicalStoreOutcomes(storeRun, [{
          outcomeState: "accepted",
          recordKind: "physical-store",
          recordedAt: storeObservedAt,
          sourceRecordId: `image-extra-store-${suffix}`,
          store: {
            addressLine: "Testgata 1",
            latitude: 59.913_900,
            longitude: 10.752_200,
            municipalityCode: "0301",
            name: fixture.storeName,
            observedAt: storeObservedAt,
            postalCode: "0152",
            status: "active",
          },
          subjectChain: "extra",
        }], [{
          chain: "extra",
          checkedAt: storeCheckedAt,
          recordCount: 1,
          state: "complete",
        }])).resolves.toEqual({ inserted: 1, received: 1 });
        await finalizeRun(storeRun, now);

        const capabilities = ["capture", "discover", "extract", "ocr"] as const;
        const rightsClassifications = [
          "extract_only",
          "private_review",
          "public_display",
        ] as const;
        const [offerPermission] = await admin.sql<Array<{ id: number }>>`
          select id::integer as id
          from source_permissions
          where source_id = ${sourceIds.offer}
          order by created_at desc, id desc
          limit 1
        `;
        if (offerPermission === undefined) {
          throw new Error("exact-image offer permission was not created");
        }
        const fence = async (): Promise<OfficialOfferAuthorizationFenceV1> => ({
          capabilities: [...capabilities],
          contractVersion: 1,
          decision: "approved",
          evaluatedAt: (await databaseNow()).toISOString(),
          permissionId: offerPermission.id,
          reviewedAt: reviewedAt.toISOString(),
          rightsClassifications: [...rightsClassifications],
          sourceId: sourceIds.offer,
          validUntil: validUntil.toISOString(),
        });
        const offerValidFrom = new Date(now.getTime() - 60 * 60_000);
        const offerValidUntil = new Date(now.getTime() + 6 * 60 * 60_000);
        const discoveredAt = await databaseNow();
        const edition: OfficialOfferEditionDiscoveryInputV1 = {
          authorization: {
            capabilities: [...capabilities],
            decision: "approved",
            reviewedAt: reviewedAt.toISOString(),
            validUntil: validUntil.toISOString(),
          },
          chain: "extra",
          contentKind: "structured-feed",
          contractVersion: 1,
          declaredGeographicScope: { countryCode: "NO", kind: "national" },
          discoveredAt: discoveredAt.toISOString(),
          externalEditionId: `image-offer-edition-${suffix}`,
          geographicScopeId: scope.id,
          sourceId: sourceIds.offer,
          title: "CI verifisert offentlig melketilbud",
          validFrom: offerValidFrom.toISOString(),
          validUntil: offerValidUntil.toISOString(),
        };
        const foundation = new PostgresOfficialOfferFoundationRepository(admin.db);
        const recordedEdition = await foundation.recordEdition(edition, await fence());
        const captureChecksumSha256 = digest(`image-capture:${suffix}`);
        const capture = await foundation.recordCapture({
          byteLength: 256,
          checksumSha256: captureChecksumSha256,
          contractVersion: 1,
          externalEditionId: edition.externalEditionId,
          mimeType: "image/png",
          publicationId: recordedEdition.id,
          retrievedAt: (await databaseNow()).toISOString(),
          rightsClassification: "public_display",
          sourceId: sourceIds.offer,
        }, `official-offers/private/image-seed/${suffix}.png`, await fence());
        const extractionAt = await databaseNow();
        const extractionEnvelope: OfficialOfferExtractionEnvelopeV1 = {
          candidates: [{
            anomalyCodes: [],
            candidateKey: `image-offer-candidate-${suffix}`,
            channels: ["in-store"],
            contractVersion: 1,
            eligibility: { kind: "public" },
            geographicScope: { countryCode: "NO", kind: "national" },
            package: {
              amount: 1_000,
              state: "parsed",
              unit: "ml",
              unitsPerPack: 1,
            },
            pricing: {
              beforePriceOre: fixture.ordinaryPriceOre,
              kind: "unit",
              offerPriceOre: fixture.offerPriceOre,
            },
            product: { kind: "exact-identifier", scheme: "gtin", value: fixture.gtin },
            provenance: {
              confidence: 100,
              evidenceLocator: `image-offer-evidence-${suffix}`,
              method: "structured",
            },
            validity: {
              endsAt: offerValidUntil.toISOString(),
              startsAt: offerValidFrom.toISOString(),
              state: "parsed",
            },
          }],
          captureChecksumSha256,
          completedAt: extractionAt.toISOString(),
          contractVersion: 1,
          emptyResult: "not-empty",
          extractorVersion: `image-seed-structured-v1-${suffix}`,
          layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
          method: "structured",
          schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
          startedAt: extractionAt.toISOString(),
        };
        const extraction = await foundation.recordExtraction(
          capture.id,
          extractionEnvelope,
          edition,
          {
            contractVersion: 1,
            exactProductIdsByGtin: { [fixture.gtin]: [`product:${product.id}`] },
            expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
            expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
          },
          {
            contractVersion: 1,
            serverCompletedAt: extractionAt.toISOString(),
            serverStartedAt: extractionAt.toISOString(),
          },
          await fence(),
        );
        expect(extraction.counts).toEqual({
          exactMatch: 1,
          rejected: 0,
          reviewRequired: 0,
          total: 1,
        });
        const [candidateRow] = await admin.sql<Array<{ id: number }>>`
          select id::integer as id
          from extracted_offer_candidates
          where extraction_run_id = ${extraction.id}
        `;
        if (candidateRow === undefined) throw new Error("exact-image offer candidate is missing");
        const reviewRepository = new PostgresReviewQueueRepository(review.db);
        const candidateId = `review-candidate:${candidateRow.id}`;
        const candidate = await reviewRepository.get(candidateId, await databaseNow());
        const locator = await reviewRepository.getPrivateCaptureLocator(
          candidateId,
          await databaseNow(),
        );
        const actor = {
          actorId: `access:${digest(`${suffix}:image-review-actor`)}`,
          sessionId: `access-session:${digest(`${suffix}:image-review-session`)}`,
        };
        const evidenceProofSha256 = digest(`${suffix}:image-review-proof`);
        const renderClock = await databaseNow();
        const renderExpiresAt = new Date(renderClock.getTime() + 60_000);
        await reviewRepository.recordEvidenceRender({
          ...actor,
          candidateId,
          checksumSha256: locator.checksumSha256,
          cropReference: locator.cropReference,
          evidenceProofSha256,
          expectedVersion: 0,
          expiresAt: renderExpiresAt.toISOString(),
          presentation: "full_capture",
          rightsClassification: "public_display",
        }, renderClock);
        if (
          candidate.candidate.product.kind !== "exact-identifier"
          || candidate.candidate.validity.state !== "parsed"
        ) {
          throw new Error("exact-image offer candidate is not exactly reviewable");
        }
        const reviewRequest: ReviewDecisionRequestV1 = {
          action: "approve",
          approvalEvidence: {
            presentation: "full_capture",
            token: reviewProofToken(`${suffix}:${candidateId}`, renderExpiresAt),
          },
          candidateId,
          contractVersion: 1,
          decision: {
            channels: [...candidate.candidate.channels],
            eligibility: candidate.candidate.eligibility,
            pricing: candidate.candidate.pricing,
            target: { gtin: fixture.gtin, kind: "exact-product" },
            validity: {
              endsAt: candidate.candidate.validity.endsAt,
              startsAt: candidate.candidate.validity.startsAt,
            },
          },
          expectedVersion: 0,
          reason: "CI synthetic public-display fields match the immutable exact-image evidence.",
        };
        await expect(reviewRepository.decide(
          reviewRequest,
          actor,
          evidenceProofSha256,
          await databaseNow(),
        )).resolves.toMatchObject({ state: "approved" });

        await admin.sql`
          update official_offer_publication_policy
          set enabled = true, updated_at = clock_timestamp()
          where policy_key = 'official-offer-publication-v1'
        `;
        policyWasEnabled = true;
        const lifecycle = new PostgresOfficialOfferLifecycleRepository(app.db);
        const publication = await lifecycle.reconcile({
          batchLimit: 10,
          contractVersion: 1,
          jobId: `image-seed-publication-${suffix}`,
          ownerId: `image-seed-owner-${suffix}`,
          publicationRequested: true,
          runId: `image-seed-publication-run-${suffix}`,
          scheduledAt: await databaseNow(app),
          sourceId: sourceIds.offer,
        });
        expect(publication).toMatchObject({
          publicationState: "evaluated",
          publishedCount: 1,
        });
        await admin.sql`
          update official_offer_publication_policy
          set enabled = false, updated_at = clock_timestamp()
          where policy_key = 'official-offer-publication-v1'
        `;
        policyWasEnabled = false;

        const evaluatedAt = await databaseNow();
        const catalog = await new PostgresPublicCatalogIndexReader(web.db)
          .search("verifisert lettmelk", 10, evaluatedAt);
        expect(catalog).toEqual([
          expect.objectContaining({
            brand: fixture.brand,
            displayName: fixture.productName,
            gtin: fixture.gtin,
          }),
        ]);
        const planning = await new PostgresPlanningEvidenceReader(web.db)
          .getMany([fixture.gtin], evaluatedAt);
        expect(planning.priceEvidence).toEqual([
          expect.objectContaining({
            amountOre: fixture.ordinaryPriceOre,
            chainId: "extra",
            sourceId: sourceIds.price,
          }),
        ]);
        expect(planning.coverageChecks).toEqual([
          expect.objectContaining({ chainId: "bunnpris", state: "source-unavailable" }),
          expect.objectContaining({ chainId: "rema-1000", state: "source-unavailable" }),
        ]);
        const officialOffers = await new PostgresPublicOfficialOfferReader(web.db)
          .getMany([`product:${product.id}`], evaluatedAt);
        expect(officialOffers.offers).toEqual([
          expect.objectContaining({
            beforePriceOre: fixture.ordinaryPriceOre,
            chainId: "extra",
            pricing: { kind: "unit", unitPriceOre: fixture.offerPriceOre },
            sourceId: sourceIds.offer,
          }),
        ]);
        const directory = await new PostgresBranchDirectory(web.db).loadEligibleBranches({
          eligibleChainIds: ["extra"],
          evaluatedAt,
          marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
        });
        expect(directory).toMatchObject({
          branches: [expect.objectContaining({ chainId: "extra", name: fixture.storeName })],
          complete: true,
        });
      } finally {
        if (policyWasEnabled) {
          await admin.sql`
            update official_offer_publication_policy
            set enabled = false, updated_at = clock_timestamp()
            where policy_key = 'official-offer-publication-v1'
          `.catch(() => undefined);
        }
        await Promise.all([
          admin.close(),
          app.close(),
          review.close(),
          web.close(),
        ]);
      }
    }, 60_000);
  },
);
