import { createHash, randomUUID } from "node:crypto";
import {
  officialOfferAuthorizationFenceV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  syntheticStructuredOfferCandidates,
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  type ReviewDecisionRequestV1,
} from "@handleplan/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseConnection, type HandleplanDatabase } from "./client";
import { PostgresOfficialOfferFoundationRepository } from "./official-offer-foundation";
import { PostgresReviewQueueRepository } from "./review-queue";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const rollback = new Error("synthetic fixture rollback");
const integration =
  process.env.RUN_OFFICIAL_OFFER_DB_INTEGRATION === "1" ? describe : describe.skip;

integration("MENY private text evidence SQL boundary", () => {
  let connection: DatabaseConnection;
  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_MIGRATION_URL!);
  });
  afterAll(async () => {
    await connection?.close();
  });

  async function fixture(
    options: {
      sourceId?: string;
      mimeType?: string;
      byteLength?: number;
      privateReview?: boolean;
      unknownScope?: boolean;
    },
    check: (context: {
      review: PostgresReviewQueueRepository;
      input: Parameters<PostgresReviewQueueRepository["recordEvidenceRender"]>[0];
      approve: ReviewDecisionRequestV1;
      injectForgedReceipt: (bypassTrigger: boolean) => Promise<void>;
      savepoint: (run: () => Promise<unknown>) => Promise<unknown>;
    }) => Promise<void>,
  ): Promise<void> {
    await connection.sql
      .begin(async (tx) => {
        const suffix = randomUUID();
        const sourceId = options.sourceId ?? "meny";
        const reviewedAt = new Date(Date.now() - 1000).toISOString();
        const permissions = {
          officialOffers: true,
          privateReview: options.privateReview ?? true,
          publicDisplay: true,
          officialOfferCapabilities: ["capture", "discover", "extract"],
          officialOfferRightsClassifications: ["public_display"],
        };
        await tx`insert into data_sources (id,display_name,source_kind,runtime_state) values (${sourceId},'Synthetic text evidence','offer','approved') on conflict do nothing`;
        const [permission] =
          await tx`insert into source_permissions (source_id,decision,reviewed_at,permissions) values (${sourceId},'approved',${reviewedAt},${JSON.stringify(permissions)}::jsonb) returning id`;
        await tx`update data_sources set permission_reviewed_at=${reviewedAt},permission_expires_at=null where id=${sourceId}`;
        const [scope] =
          await tx`insert into geographic_scopes (scope_key,scope_kind,label,country_code) values (${`text-evidence:${suffix}`},'national','Synthetic text evidence scope','NO') returning id`;
        // Repository-owned transactions become savepoints inside the rollback-only fixture.
        const client = Object.assign(tx, { begin: tx.savepoint.bind(tx) });
        const db = { $client: client } as unknown as HandleplanDatabase;
        const foundation = new PostgresOfficialOfferFoundationRepository(db);
        const review = new PostgresReviewQueueRepository(db);
        const now = async () => new Date((await tx`select clock_timestamp() as at`)[0]!.at);
        const fence = async () =>
          officialOfferAuthorizationFenceV1Schema.parse({
            contractVersion: 1,
            permissionId: Number(permission!.id),
            sourceId,
            decision: "approved",
            capabilities: permissions.officialOfferCapabilities,
            rightsClassifications: ["public_display"],
            reviewedAt,
            evaluatedAt: (await now()).toISOString(),
          });
        const start = new Date(Date.now() - 60_000).toISOString();
        const end = new Date(Date.now() + 3_600_000).toISOString();
        const edition = officialOfferEditionDiscoveryInputV1Schema.parse({
          contractVersion: 1,
          sourceId,
          externalEditionId: suffix,
          chain: "meny",
          title: "Synthetic text edition",
          contentKind: "publication",
          geographicScopeId: Number(scope!.id),
          declaredGeographicScope: { kind: "national", countryCode: "NO" },
          validFrom: start,
          validUntil: end,
          discoveredAt: (await now()).toISOString(),
          authorization: {
            decision: "approved",
            capabilities: permissions.officialOfferCapabilities,
            reviewedAt,
          },
        });
        const publication = await foundation.recordEdition(edition, await fence());
        const checksumSha256 = digest(suffix);
        const capture = await foundation.recordCapture(
          {
            contractVersion: 1,
            publicationId: publication.id,
            sourceId,
            externalEditionId: suffix,
            checksumSha256,
            mimeType: options.mimeType ?? "text/html",
            byteLength: options.byteLength ?? 100,
            rightsClassification: "public_display",
            retrievedAt: (await now()).toISOString(),
          },
          `official-offers/private/v1/${digest(sourceId)}/${publication.id}/${checksumSha256}`,
          await fence(),
        );
        const at = (await now()).toISOString();
        const candidate = {
          ...syntheticStructuredOfferCandidates[0]!,
          candidateKey: suffix,
          product: { kind: "unresolved-label", label: "Synthetic product" },
          geographicScope: options.unknownScope
            ? { kind: "unknown", reason: "synthetic missing scope" }
            : { kind: "national", countryCode: "NO" },
          validity: { state: "parsed", startsAt: start, endsAt: end },
          provenance: {
            method: "embedded-text",
            evidenceLocator: "synthetic-text-source",
            confidence: 60,
          },
          anomalyCodes: [],
        };
        const envelope = officialOfferExtractionEnvelopeV1Schema.parse({
          contractVersion: 1,
          captureChecksumSha256: checksumSha256,
          extractorVersion: `text-${suffix}`,
          method: "embedded-text",
          layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
          schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
          startedAt: at,
          completedAt: at,
          emptyResult: "not-empty",
          candidates: [candidate],
        });
        const extraction = await foundation.recordExtraction(
          capture.id,
          envelope,
          edition,
          {
            contractVersion: 1,
            exactProductIdsByGtin: {},
            expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
            expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
          },
          { contractVersion: 1, serverStartedAt: at, serverCompletedAt: at },
          await fence(),
        );
        const [row] =
          await tx`select id from extracted_offer_candidates where extraction_run_id=${extraction.id}`;
        const candidateId = `review-candidate:${row!.id}`;
        const cropReference = `review-crop:${digest(`v1\0${row!.id}\0${checksumSha256}\0synthetic-text-source`)}`;
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const input = {
          actorId: `access:${digest(suffix)}`,
          sessionId: `access-session:${digest(suffix + "session")}`,
          candidateId,
          expectedVersion: 0,
          checksumSha256,
          cropReference,
          evidenceProofSha256: digest(suffix + "proof"),
          expiresAt,
          presentation: "full_capture" as const,
          rightsClassification: "public_display" as const,
        };
        const body = `29${(BigInt(`0x${digest(suffix).slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, "0")}`;
        const sum = [...body].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
        const gtin = body + String((10 - (sum % 10)) % 10);
        const [product] =
          await tx`insert into canonical_products (display_name,package_amount,package_unit,units_per_pack) values ('Synthetic text-reviewed product',500,'g',1) returning id`;
        await tx`insert into product_identifiers (product_id,scheme,value,confidence,verified_at) values (${product!.id},'ean13',${gtin},100,clock_timestamp())`;
        const approve: ReviewDecisionRequestV1 = {
          contractVersion: 1,
          action: "correct_and_approve",
          candidateId,
          expectedVersion: 0,
          reason: "Synthetic source reviewed explicitly",
          approvalEvidence: {
            presentation: "full_capture",
            token: `review-proof:v1.${Date.parse(expiresAt).toString(36)}.${"a".repeat(22)}.${digest(suffix + "binding")}.${digest(suffix + "signature")}`,
          },
          decision: {
            target: { kind: "exact-product", gtin },
            pricing: { kind: "unit", offerPriceOre: 2990 },
            eligibility: { kind: "public" },
            validity: { startsAt: start, endsAt: end },
            channels: ["in-store"],
          },
        };
        await tx.unsafe("set local role handleplan_review");
        const injectForgedReceipt = async (bypassTrigger: boolean): Promise<void> => {
          await tx.unsafe("reset role");
          if (bypassTrigger) await tx.unsafe("set local session_replication_role = replica");
          await tx`with at as (select clock_timestamp() as now)
          insert into private_review_evidence_renders (candidate_id,expected_version,capture_checksum,crop_reference,presentation,rights_classification,mime_type,byte_length,actor_id,reviewer_session_id,evidence_proof_sha256,rendered_at,expires_at,created_at)
          select ${row!.id},0,${"0".repeat(64)},${cropReference},'full_capture','public_display','text/html',100,${input.actorId},${input.sessionId},${input.evidenceProofSha256},at.now,${expiresAt}::timestamptz,at.now from at`;
          await tx.unsafe("set local session_replication_role = origin");
          await tx.unsafe("set local role handleplan_review");
        };
        await check({
          review,
          input,
          approve,
          injectForgedReceipt,
          savepoint: (run) => tx.savepoint(run),
        });
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  }

  it("records original-byte MENY text evidence and consumes the proof exactly once", async () => {
    await fixture({}, async ({ review, input, approve, savepoint }) => {
      await expect(review.recordEvidenceRender(input, new Date())).resolves.toMatchObject({
        expiresAt: input.expiresAt,
      });
      await expect(
        savepoint(() =>
          review.decide(
            approve,
            { actorId: input.actorId, sessionId: `access-session:${"f".repeat(64)}` },
            input.evidenceProofSha256,
            new Date(),
          ),
        ),
      ).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
      await expect(
        review.decide(
          approve,
          { actorId: input.actorId, sessionId: input.sessionId },
          input.evidenceProofSha256,
          new Date(),
        ),
      ).resolves.toMatchObject({ candidateId: input.candidateId });
      await expect(
        savepoint(() =>
          review.decide(
            approve,
            { actorId: input.actorId, sessionId: input.sessionId },
            input.evidenceProofSha256,
            new Date(),
          ),
        ),
      ).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    });
  });
  it("rejects forged text capture metadata at table insertion and independently at decision", async () => {
    await fixture({}, async ({ review, input, approve, savepoint, injectForgedReceipt }) => {
      await expect(savepoint(() => injectForgedReceipt(false))).rejects.toThrow(
        /HP_REVIEW_EVIDENCE_UNAVAILABLE/,
      );
      // Simulate an owner-injected bad receipt to exercise the separate decision fence.
      await injectForgedReceipt(true);
      await expect(
        savepoint(() =>
          review.decide(
            approve,
            { actorId: input.actorId, sessionId: input.sessionId },
            input.evidenceProofSha256,
            new Date(),
          ),
        ),
      ).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    });
  });

  it.each([
    { sourceId: "synthetic-other-html" },
    { mimeType: "application/pdf" },
    { byteLength: 1024 * 1024 + 1 },
    { privateReview: false },
    { unknownScope: true },
  ])("keeps unsupported or unqualified evidence blocked: %j", async (options) => {
    await fixture(options, async ({ review, input, savepoint }) => {
      await expect(
        savepoint(() => review.recordEvidenceRender(input, new Date())),
      ).rejects.toThrow();
    });
  });
});
