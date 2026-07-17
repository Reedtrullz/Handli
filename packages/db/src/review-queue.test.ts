import { describe, expect, it, vi } from "vitest";
import type { ReviewOfferDecisionV1 } from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";
import {
  PostgresReviewQueueRepository,
  ReviewQueueRepositoryError,
} from "./review-queue";

type Responder = (sql: string, values: readonly unknown[]) => unknown[];

interface RawSql {
  readonly raw: string;
}

function scriptedDatabase(responder: Responder) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const begin = vi.fn(() => {
    throw new Error("review repository must not open an application transaction");
  });
  const rawExecutor = (strings: readonly string[], ...values: unknown[]) => {
    const sql = strings.reduce((result, part, index) => {
      const value = values[index];
      return result + part + (
        value !== null
        && typeof value === "object"
        && "raw" in value
          ? (value as RawSql).raw
          : index < values.length ? "?" : ""
      );
    }, "");
    const boundValues = values.filter((value) => !(
      value !== null && typeof value === "object" && "raw" in value
    ));
    calls.push({ sql, values: boundValues });
    const cancel = vi.fn();
    cancels.push(cancel);
    let promise: Promise<unknown[]>;
    try {
      promise = Promise.resolve(responder(sql, boundValues));
    } catch (error) {
      promise = Promise.reject(error);
    }
    return Object.assign(promise, { cancel });
  };
  Object.assign(rawExecutor, {
    array: (value: readonly unknown[]) => value,
    begin,
    json: (value: unknown) => value,
    unsafe: (raw: string): RawSql => ({ raw }),
  });
  return {
    begin,
    calls,
    cancels,
    db: { $client: rawExecutor } as unknown as HandleplanDatabase,
  };
}

const candidate = {
  contractVersion: 1,
  candidateKey: "/private/captures/synthetic-review-candidate.png",
  product: { kind: "exact-identifier", scheme: "gtin", value: "7038010000010" },
  package: { state: "parsed", amount: 1_000, unit: "ml", unitsPerPack: 1 },
  pricing: { kind: "unit", offerPriceOre: 2_990, beforePriceOre: 3_990 },
  eligibility: { kind: "public" },
  validity: {
    state: "parsed",
    startsAt: "2026-07-13T00:00:00.000Z",
    endsAt: "2026-07-20T00:00:00.000Z",
  },
  geographicScope: { kind: "postal-set", countryCode: "NO", postalCodes: ["0001"] },
  channels: ["in-store"],
  provenance: {
    method: "ocr",
    evidenceLocator: "page-1-crop-2",
    confidence: 92,
  },
  anomalyCodes: ["OCR_REVIEW_REQUIRED"],
} as const;

const candidateRow = {
  anomaly_codes: ["OCR_REVIEW_REQUIRED"],
  blob_key: `official-offers/private/v1/${"b".repeat(64)}/42/${"c".repeat(64)}`,
  byte_length: 12_345,
  candidate_created_at: new Date("2026-07-12T12:01:01.000Z"),
  candidate_id: 42,
  candidate_status: "pending",
  capture_checksum: "c".repeat(64),
  chain: "extra",
  confidence: 92,
  extraction_method: "ocr",
  geographic_scope_id: 9,
  mime_type: "image/png",
  normalized_fields: {
    contractVersion: 1,
    anomalyCodes: ["OCR_REVIEW_REQUIRED"],
    candidate,
    disposition: "review-required",
    exactCanonicalProductId: "product:synthetic-1",
    publicationRoute: "human-review-required",
  },
  publication_title: "Synthetic local edition",
  publication_valid_from: new Date("2026-07-13T00:00:00.000Z"),
  publication_valid_until: new Date("2026-07-20T00:00:00.000Z"),
  retrieved_at: new Date("2026-07-12T12:00:30.000Z"),
  rights_classification: "private_review",
  scope_kind: "postal_set",
  scope_label: "Synthetic local",
  source_id: "synthetic-rights-cleared-feed",
};

const filters = { contractVersion: 1, limit: 1 } as const;
const at = new Date("2026-07-17T12:00:00.000Z");
const actorId = `access:${"d".repeat(64)}`;
const actor = {
  actorId,
  sessionId: `access-session:${"e".repeat(64)}`,
};
const evidenceProofSha256 = "f".repeat(64);
const approvalEvidence = {
  presentation: "full_capture" as const,
  token: `review-proof:v1.${Date.parse("2026-07-17T12:02:00.000Z").toString(36)}.${"a".repeat(22)}.${"b".repeat(64)}.${"c".repeat(64)}`,
};
const decision: ReviewOfferDecisionV1 = {
  channels: ["in-store"],
  eligibility: { kind: "public" },
  pricing: { kind: "unit", offerPriceOre: 2_990, beforePriceOre: 3_990 },
  target: { kind: "exact-product", gtin: "7038010000010" },
  validity: {
    startsAt: "2026-07-13T00:00:00.000Z",
    endsAt: "2026-07-20T00:00:00.000Z",
  },
};

describe("PostgresReviewQueueRepository", () => {
  it("lists a bounded keyset page exclusively through the central eligibility function", async () => {
    const database = scriptedDatabase((sql) =>
      sql.includes("private_review_candidate_rows_v1")
        ? [candidateRow, { ...candidateRow, candidate_id: 43 }]
        : []);
    const repository = new PostgresReviewQueueRepository(database.db);

    const response = await repository.list(filters, at);

    expect(response).toMatchObject({
      contractVersion: 1,
      items: [{
        approvalEvidence: {
          cropGeometry: "unavailable",
          presentation: "full_capture",
          state: "render_required",
        },
        candidateId: "review-candidate:42",
        confidence: 92,
        extractionDisposition: "review-required",
        capture: {
          cropReference: expect.stringMatching(/^review-crop:[0-9a-f]{64}$/u),
          rightsClassification: "private_review",
        },
        version: 0,
      }],
      nextCursor: expect.stringMatching(/^review-cursor:/u),
    });
    expect(JSON.stringify(response)).not.toMatch(/blob|checksum|byteLength/iu);
    expect(JSON.stringify(response)).not.toContain("page-1-crop-2");
    expect(JSON.stringify(response)).not.toContain(candidate.candidateKey);
    expect(response.items[0]!.candidate).not.toHaveProperty("candidateKey");
    expect(response.items[0]!.candidate.provenance.evidenceLocator)
      .toMatch(/^review-evidence:[0-9a-f]{64}$/u);
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]!.sql).toContain("public.private_review_candidate_rows_v1");
    expect(database.calls[0]!.sql).not.toContain("extracted_offer_candidates");
    expect(database.calls[0]!.sql).not.toMatch(/count\s*\(/iu);
  });

  it("keeps maximum-cardinality scopes out of bounded browser JSON", async () => {
    const postalCodes = Array.from(
      { length: 10_000 },
      (_, index) => index.toString().padStart(4, "0"),
    );
    const maximalRow = {
      ...candidateRow,
      normalized_fields: {
        ...candidateRow.normalized_fields,
        candidate: {
          ...candidate,
          geographicScope: {
            countryCode: "NO",
            kind: "postal-set",
            postalCodes,
          },
        },
      },
    };

    const detailDatabase = scriptedDatabase(() => [maximalRow]);
    const detail = await new PostgresReviewQueueRepository(detailDatabase.db)
      .get("review-candidate:42", at);
    const detailJson = JSON.stringify(detail);

    expect(detail.candidate).not.toHaveProperty("candidateKey");
    expect(detail.candidate).not.toHaveProperty("geographicScope");
    expect(detailJson).not.toContain('"geographicScope"');
    expect(Buffer.byteLength(detailJson, "utf8")).toBeLessThan(48 * 1024);
    expect(detail.scope).toEqual({
      id: "review-scope:9",
      kind: "postal_set",
      label: "Synthetic local",
    });

    const listDatabase = scriptedDatabase(() => Array.from(
      { length: 50 },
      (_, index) => ({ ...maximalRow, candidate_id: index + 1 }),
    ));
    const list = await new PostgresReviewQueueRepository(listDatabase.db).list({
      contractVersion: 1,
      limit: 50,
    }, at);
    const listJson = JSON.stringify(list);

    expect(list.items).toHaveLength(50);
    expect(list.items.every(({ candidate: projected }) =>
      !("geographicScope" in projected))).toBe(true);
    expect(listJson).not.toContain('"geographicScope"');
    expect(Buffer.byteLength(listJson, "utf8")).toBeLessThan(512 * 1024);
  });

  it("passes every queue filter and cursor as a typed function parameter", async () => {
    const firstPageDatabase = scriptedDatabase(() => [
      candidateRow,
      { ...candidateRow, candidate_id: 43 },
    ]);
    const firstPage = await new PostgresReviewQueueRepository(firstPageDatabase.db)
      .list(filters, at);
    const database = scriptedDatabase(() => []);

    await new PostgresReviewQueueRepository(database.db).list({
      ageHours: { min: 1, max: 120 },
      anomaly: "OCR_REVIEW_REQUIRED",
      chain: "extra",
      confidence: { min: 50, max: 95 },
      contractVersion: 1,
      cursor: firstPage.nextCursor,
      limit: 10,
      scopeKind: "postal_set",
    }, at);

    expect(database.calls[0]!.values).toEqual(expect.arrayContaining([
      "extra",
      "postal_set",
      "OCR_REVIEW_REQUIRED",
      50,
      95,
      1,
      120,
      42,
      11,
    ]));
  });

  it("rejects an undecodable cursor before invoking PostgreSQL", async () => {
    const database = scriptedDatabase(() => { throw new Error("must not query"); });
    const repository = new PostgresReviewQueueRepository(database.db);

    await expect(repository.list({
      contractVersion: 1,
      cursor: "review-cursor:aaaaaaaa",
      limit: 25,
    }, at)).rejects.toThrow("Invalid private review cursor");
    expect(database.calls).toHaveLength(0);
  });

  it("uses the same eligibility function for detail and private capture locator reads", async () => {
    const database = scriptedDatabase(() => [candidateRow]);
    const repository = new PostgresReviewQueueRepository(database.db);

    await expect(repository.get("review-candidate:42", at)).resolves
      .toMatchObject({ candidateId: "review-candidate:42" });
    await expect(repository.getPrivateCaptureLocator("review-candidate:42", at)).resolves
      .toMatchObject({
        blobKey: candidateRow.blob_key,
        byteLength: candidateRow.byte_length,
        candidateId: "review-candidate:42",
        candidateVersion: 0,
        checksumSha256: candidateRow.capture_checksum,
        cropReference: expect.stringMatching(/^review-crop:[0-9a-f]{64}$/u),
        evidenceLocator: "page-1-crop-2",
      });
    expect(database.calls).toHaveLength(2);
    expect(database.calls.every(({ sql }) =>
      sql.includes("public.private_review_candidate_rows_v1"))).toBe(true);
  });

  it("records only the digest of a current candidate-bound evidence render", async () => {
    const renderedAt = new Date("2026-07-17T12:00:00.123Z");
    const expiresAt = "2026-07-17T12:02:00.000Z";
    const database = scriptedDatabase((sql) =>
      sql.includes("private_review_record_evidence_render_v1")
        ? [{ evidence_render_id: 77, rendered_at: renderedAt, expires_at: expiresAt }]
        : []);
    const repository = new PostgresReviewQueueRepository(database.db);

    await expect(repository.recordEvidenceRender({
      ...actor,
      candidateId: "review-candidate:42",
      checksumSha256: candidateRow.capture_checksum,
      cropReference: `review-crop:${"a".repeat(64)}`,
      evidenceProofSha256,
      expectedVersion: 0,
      expiresAt,
      presentation: "full_capture",
      rightsClassification: "private_review",
    }, at)).resolves.toEqual({
      evidenceRenderId: "review-evidence-render:77",
      expiresAt,
      renderedAt: renderedAt.toISOString(),
    });
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]!.sql).toContain("public.private_review_record_evidence_render_v1");
    expect(database.calls[0]!.values).toEqual(expect.arrayContaining([
      42,
      0,
      candidateRow.capture_checksum,
      "full_capture",
      "private_review",
      actor.actorId,
      actor.sessionId,
      evidenceProofSha256,
      expiresAt,
    ]));
    expect(JSON.stringify(database.calls[0]!.values)).not.toContain("review-proof:v1");
  });

  it("fails closed if an extract-only capture escapes the database eligibility boundary", async () => {
    const database = scriptedDatabase(() => [{
      ...candidateRow,
      rights_classification: "extract_only",
    }]);

    await expect(new PostgresReviewQueueRepository(database.db)
      .getPrivateCaptureLocator("review-candidate:42", at))
      .rejects.toEqual(new ReviewQueueRepositoryError("CORRUPT_RECORD"));
  });

  it("approves with one typed database function call and trusts its database clock", async () => {
    const databaseActedAt = new Date("2026-07-17T12:00:00.321Z");
    const database = scriptedDatabase((sql) => sql.includes("private_review_decide_v2")
      ? [{
        acted_at: databaseActedAt,
        action_id: 202,
        new_version: 1,
        offer_id: 101,
        review_state: "approved",
      }]
      : []);
    const repository = new PostgresReviewQueueRepository(database.db);

    await expect(repository.decide({
      action: "approve",
      approvalEvidence,
      candidateId: "review-candidate:42",
      contractVersion: 1,
      decision,
      expectedVersion: 0,
      reason: "Synthetic fields match.",
    }, actor, evidenceProofSha256, at)).resolves.toEqual({
      actedAt: databaseActedAt.toISOString(),
      actionId: "review-action:202",
      candidateId: "review-candidate:42",
      contractVersion: 1,
      newVersion: 1,
      offerId: "review-offer:101",
      state: "approved",
    });
    expect(database.begin).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]!.sql).toContain("public.private_review_decide_v2");
    expect(database.calls[0]!.sql).not.toMatch(/insert into|pg_advisory/iu);
    expect(database.calls[0]!.values).toEqual(expect.arrayContaining([
      42,
      0,
      "approve",
      actorId,
      actor.sessionId,
      evidenceProofSha256,
      "exact-product",
      "7038010000010",
      "unit",
      2_990,
      3_990,
      "public",
      decision.validity.startsAt,
      decision.validity.endsAt,
      "{in-store}",
    ]));
  });

  it("maps a database-rejected forged approval to a decision mismatch", async () => {
    const database = scriptedDatabase(() => {
      throw new Error("HP_REVIEW_DECISION_MISMATCH");
    });

    await expect(new PostgresReviewQueueRepository(database.db).decide({
      action: "approve",
      approvalEvidence,
      candidateId: "review-candidate:42",
      contractVersion: 1,
      decision: {
        ...decision,
        pricing: { kind: "unit", offerPriceOre: 2_790, beforePriceOre: 3_990 },
      },
      expectedVersion: 0,
      reason: "An approval cannot silently rewrite price.",
    }, actor, evidenceProofSha256, at)).rejects.toEqual(new ReviewQueueRepositoryError("DECISION_MISMATCH"));
    expect(database.calls).toHaveLength(1);
  });

  it("fails closed when the candidate-bound renderer proof is unavailable", async () => {
    const database = scriptedDatabase(() => {
      throw new Error("HP_REVIEW_EVIDENCE_UNAVAILABLE");
    });

    await expect(new PostgresReviewQueueRepository(database.db).decide({
      action: "approve",
      approvalEvidence,
      candidateId: "review-candidate:42",
      contractVersion: 1,
      decision,
      expectedVersion: 0,
      reason: "Opaque evidence cannot support approval.",
    }, actor, evidenceProofSha256, at)).rejects
      .toEqual(new ReviewQueueRepositoryError("EVIDENCE_UNAVAILABLE"));
  });

  it("rejects through the same function with every decision field absent", async () => {
    const database = scriptedDatabase(() => [{
      acted_at: at,
      action_id: 203,
      new_version: 1,
      offer_id: null,
      review_state: "rejected",
    }]);

    await expect(new PostgresReviewQueueRepository(database.db).decide({
      action: "reject",
      candidateId: "review-candidate:42",
      contractVersion: 1,
      expectedVersion: 0,
      reason: "Synthetic crop is ambiguous.",
    }, actor, undefined, at)).resolves.toMatchObject({ state: "rejected" });
    const values = database.calls[0]!.values;
    expect(values.slice(-13)).toEqual(Array(13).fill(null));
  });

  it.each([
    ["HP_REVIEW_VERSION_CONFLICT", "VERSION_CONFLICT"],
    ["HP_REVIEW_TARGET_NOT_FOUND", "TARGET_NOT_FOUND"],
    ["HP_REVIEW_NOT_FOUND", "NOT_FOUND"],
  ] as const)("maps %s without attempting an application-side fallback", async (token, code) => {
    const database = scriptedDatabase(() => { throw new Error(token); });

    await expect(new PostgresReviewQueueRepository(database.db).decide({
      action: "reject",
      candidateId: "review-candidate:42",
      contractVersion: 1,
      expectedVersion: 0,
      reason: "Boundary mapping proof.",
    }, actor, undefined, at)).rejects.toEqual(new ReviewQueueRepositoryError(code));
    expect(database.calls).toHaveLength(1);
    expect(database.begin).not.toHaveBeenCalled();
  });

  it("fails closed on corrupt provenance and not-found candidates", async () => {
    const corrupt = scriptedDatabase(() => [{ ...candidateRow, confidence: 91 }]);
    await expect(new PostgresReviewQueueRepository(corrupt.db).get(
      "review-candidate:42",
      at,
    )).rejects.toEqual(new ReviewQueueRepositoryError("CORRUPT_RECORD"));

    const missing = scriptedDatabase(() => []);
    await expect(new PostgresReviewQueueRepository(missing.db).get(
      "review-candidate:42",
      at,
    )).rejects.toEqual(new ReviewQueueRepositoryError("NOT_FOUND"));
  });
});
