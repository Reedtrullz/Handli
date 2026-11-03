import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createDatabase, type DatabaseConnection } from "@handleplan/db/client";
import { PostgresIngestionRepository } from "@handleplan/db/ingestion";
import { PostgresOfficialOfferFoundationRepository } from "@handleplan/db/official-offer-foundation";
import { PostgresOfficialOfferLifecycleRepository } from "@handleplan/db/official-offer-lifecycle";
import { PostgresReviewQueueRepository } from "@handleplan/db/review-queue";
import {
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  type OfficialOfferAuthorizationFenceV1,
  type OfficialOfferEditionDiscoveryInputV1,
  type OfficialOfferExtractionEnvelopeV1,
} from "@handleplan/domain";

const execute = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const cursorGtins = ["7038010000010", "7038010000027", "7038010000034"];

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cursor fixture prerequisite: ${name}`);
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/handleplan") {
    throw new Error(`Cursor fixture requires the disposable loopback CI database: ${name}`);
  }
  return url;
}

export async function createCursorFixture() {
  const urls = {
    admin: requiredUrl("DATABASE_URL"),
    app: requiredUrl("APP_DATABASE_URL"),
    review: requiredUrl("REVIEW_DATABASE_URL"),
    web: requiredUrl("WEB_DATABASE_URL"),
    operations: requiredUrl("OPERATIONS_DATABASE_URL"),
  };
  const database = `handleplan_cursor_${process.pid}`;
  const control = createDatabase(urls.admin.toString());
  const connections: DatabaseConnection[] = [];
  let created = false;
  const cleanup = async () => {
    await Promise.all(connections.map((connection) => connection.close()));
    if (created) {
      await control.sql.unsafe(`drop database "${database}" with (force)`);
      const rows = await control.sql`select datname from pg_database where datname = ${database}`;
      if (rows.length !== 0) throw new Error("Cursor fixture database survived cleanup");
      console.info(JSON.stringify({ cursorQa: "cleanup", database, survivors: rows.length }));
    }
    await control.close();
  };
  console.info(JSON.stringify({ cursorQa: "register", database, resources: ["database", "four-role-connections"] }));
  try {
    await control.sql.unsafe(`create database "${database}" template template0`);
    created = true;
    for (const url of Object.values(urls)) url.pathname = `/${database}`;
    await execute(process.execPath, [fileURLToPath(new URL("../../../../deploy/migrate.mjs", import.meta.url))], {
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: urls.admin.toString(),
        MIGRATIONS_DIR: fileURLToPath(new URL("../../../../deploy/migrations", import.meta.url)),
        APP_DATABASE_PASSWORD: decodeURIComponent(urls.app.password),
        WEB_DATABASE_PASSWORD: decodeURIComponent(urls.web.password),
        REVIEW_DATABASE_PASSWORD: decodeURIComponent(urls.review.password),
        OPERATIONS_DATABASE_PASSWORD: decodeURIComponent(urls.operations.password),
      },
      timeout: 45_000,
    });
    const connect = (url: URL) => {
      const connection = createDatabase(url.toString());
      connections.push(connection);
      return connection;
    };
    const admin = connect(urls.admin);
    const app = connect(urls.app);
    const review = connect(urls.review);
    const web = connect(urls.web);
    const clock = async () => {
      const [row] = await admin.sql<Array<{ at: Date }>>`select date_trunc('milliseconds', clock_timestamp()) as at`;
      if (!row) throw new Error("Missing PostgreSQL clock");
      return new Date(row.at);
    };
    const now = await clock();
    const reviewedAt = new Date(now.getTime() - 60_000).toISOString();
    const validUntil = new Date(now.getTime() + 3_600_000).toISOString();
    const sourceIds = { catalog: "cursor-qa-catalog", offer: "cursor-qa-offer" };
    const capabilities = ["capture", "discover", "extract", "ocr"] as const;
    const rights = ["extract_only", "private_review", "public_display"] as const;
    for (const [kind, id] of Object.entries(sourceIds)) {
      const permissions = kind === "catalog" ? { catalog: true } : {
        officialOffers: true, privateReview: true, publicDisplay: true,
        officialOfferCapabilities: capabilities, officialOfferRightsClassifications: rights,
      };
      await admin.sql`insert into data_sources (id, display_name, source_kind, runtime_state, permission_reviewed_at, permission_expires_at)
        values (${id}, ${id}, ${kind}, 'approved', ${reviewedAt}, ${validUntil})`;
      await admin.sql`insert into source_permissions (source_id, decision, reviewed_at, valid_until, permissions)
        values (${id}, 'approved', ${reviewedAt}, ${validUntil}, ${JSON.stringify(permissions)}::jsonb)`;
    }
    const ingestion = new PostgresIngestionRepository(admin.db, { verifyFence: async (transaction) => { await transaction.execute("select 1"); } });
    const run = await ingestion.beginRun({ fenceToken: "cursor-qa-fence", jobId: "cursor-qa-catalog", runType: "catalog", sourceId: sourceIds.catalog, startedAt: new Date(now.getTime() - 30_000) });
    await ingestion.persistCatalogOutcomes(run.handle, cursorGtins.map((gtin, index) => ({
      outcomeState: "accepted" as const, recordKind: "product" as const,
      recordedAt: new Date(now.getTime() - 20_000), sourceRecordId: `cursor-product-${index}`, subjectEan: gtin,
      product: { displayName: `Cursor fixture ${index}`, packageAmount: 1, packageUnit: "package" as const, unitsPerPack: 1, retrievedAt: new Date(now.getTime() - 20_000) },
    })));
    await ingestion.finalizeRun(run.handle, { completedAt: new Date(now.getTime() - 10_000), failed: 0, status: "completed" });
    const [scope] = await admin.sql<Array<{ id: number }>>`insert into geographic_scopes (scope_key, scope_kind, label, country_code)
      values ('cursor-qa-national', 'national', 'Cursor QA', 'NO') returning id::integer as id`;
    const [permission] = await admin.sql<Array<{ id: number }>>`select id::integer as id from source_permissions where source_id = ${sourceIds.offer}`;
    const [product] = await admin.sql<Array<{ id: number }>>`select product_id::integer as id from product_identifiers where value = ${cursorGtins[1]!}`;
    if (!scope || !permission || !product) throw new Error("Cursor offer prerequisites missing");
    const fence = async (): Promise<OfficialOfferAuthorizationFenceV1> => ({
      capabilities: [...capabilities], contractVersion: 1, decision: "approved", evaluatedAt: (await clock()).toISOString(),
      permissionId: permission.id, reviewedAt, rightsClassifications: [...rights], sourceId: sourceIds.offer, validUntil,
    });
    const offerEndsAt = new Date(now.getTime() + 30_000);
    const edition: OfficialOfferEditionDiscoveryInputV1 = {
      authorization: { capabilities: [...capabilities], decision: "approved", reviewedAt, validUntil },
      chain: "extra", contentKind: "structured-feed", contractVersion: 1,
      declaredGeographicScope: { countryCode: "NO", kind: "national" }, discoveredAt: (await clock()).toISOString(),
      externalEditionId: "cursor-qa-edition", geographicScopeId: scope.id, sourceId: sourceIds.offer,
      title: "Authored cursor QA offer", validFrom: reviewedAt, validUntil: offerEndsAt.toISOString(),
    };
    const foundation = new PostgresOfficialOfferFoundationRepository(admin.db);
    const publication = await foundation.recordEdition(edition, await fence());
    const captureChecksumSha256 = digest("cursor-qa-capture");
    const capture = await foundation.recordCapture({ byteLength: 256, checksumSha256: captureChecksumSha256, contractVersion: 1,
      externalEditionId: edition.externalEditionId, mimeType: "image/png", publicationId: publication.id,
      retrievedAt: (await clock()).toISOString(), rightsClassification: "public_display", sourceId: sourceIds.offer,
    }, "official-offers/private/cursor-qa.png", await fence());
    const extractedAt = (await clock()).toISOString();
    const envelope: OfficialOfferExtractionEnvelopeV1 = {
      candidates: [{ anomalyCodes: [], candidateKey: "cursor-qa-offer", channels: ["in-store"], contractVersion: 1,
        eligibility: { kind: "public" }, geographicScope: { countryCode: "NO", kind: "national" },
        package: { amount: 1, state: "parsed", unit: "package", unitsPerPack: 1 },
        pricing: { beforePriceOre: 2490, kind: "unit", offerPriceOre: 1990 },
        product: { kind: "exact-identifier", scheme: "gtin", value: cursorGtins[1]! },
        provenance: { confidence: 100, evidenceLocator: "cursor-qa-authored", method: "structured" },
        validity: { endsAt: offerEndsAt.toISOString(), startsAt: reviewedAt, state: "parsed" },
      }], captureChecksumSha256, completedAt: extractedAt, contractVersion: 1, emptyResult: "not-empty",
      extractorVersion: "cursor-qa-v1", layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
      method: "structured", schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT, startedAt: extractedAt,
    };
    const extraction = await foundation.recordExtraction(capture.id, envelope, edition, {
      contractVersion: 1, exactProductIdsByGtin: { [cursorGtins[1]!]: [`product:${product.id}`] },
      expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT], expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
    }, { contractVersion: 1, serverCompletedAt: extractedAt, serverStartedAt: extractedAt }, await fence());
    const [candidateRow] = await admin.sql<Array<{ id: number }>>`select id::integer as id from extracted_offer_candidates where extraction_run_id = ${extraction.id}`;
    if (!candidateRow) throw new Error("Cursor offer candidate missing");
    const repository = new PostgresReviewQueueRepository(review.db);
    const candidateId = `review-candidate:${candidateRow.id}`;
    const candidate = await repository.get(candidateId, await clock());
    const locator = await repository.getPrivateCaptureLocator(candidateId, await clock());
    const actor = { actorId: `access:${digest("cursor-qa-actor")}`, sessionId: `access-session:${digest("cursor-qa-session")}` };
    const evidenceProofSha256 = digest("cursor-qa-proof");
    const renderAt = await clock();
    const expiresAt = new Date(renderAt.getTime() + 60_000);
    await repository.recordEvidenceRender({ ...actor, candidateId, checksumSha256: locator.checksumSha256, cropReference: locator.cropReference,
      evidenceProofSha256, expectedVersion: 0, expiresAt: expiresAt.toISOString(), presentation: "full_capture", rightsClassification: "public_display",
    }, renderAt);
    if (candidate.candidate.validity.state !== "parsed") throw new Error("Cursor offer validity not parsed");
    await repository.decide({ action: "approve", approvalEvidence: { presentation: "full_capture",
      token: `review-proof:v1.${expiresAt.getTime().toString(36)}.${digest("cursor-qa-token").slice(0, 22)}.${digest("cursor-qa-binding")}.${digest("cursor-qa-signature")}` },
      candidateId, contractVersion: 1, expectedVersion: 0, reason: "Authored cursor fixture fields match synthetic public-display evidence.",
      decision: { channels: [...candidate.candidate.channels], eligibility: candidate.candidate.eligibility, pricing: candidate.candidate.pricing,
        target: { gtin: cursorGtins[1]!, kind: "exact-product" }, validity: { endsAt: candidate.candidate.validity.endsAt, startsAt: candidate.candidate.validity.startsAt } },
    }, actor, evidenceProofSha256, await clock());
    await admin.sql`update official_offer_publication_policy set enabled = true, updated_at = clock_timestamp() where policy_key = 'official-offer-publication-v1'`;
    const published = await new PostgresOfficialOfferLifecycleRepository(app.db).reconcile({ batchLimit: 1, contractVersion: 1,
      jobId: "cursor-qa-publish", ownerId: "cursor-qa-owner", publicationRequested: true, runId: "cursor-qa-publish-run", scheduledAt: await clock(), sourceId: sourceIds.offer });
    if (published.publishedCount !== 1) throw new Error("Cursor offer did not publish");
    await admin.sql`update official_offer_publication_policy set enabled = false, updated_at = clock_timestamp() where policy_key = 'official-offer-publication-v1'`;
    return { admin, web, clock, cleanup, sourceIds, offerEndsAt };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
