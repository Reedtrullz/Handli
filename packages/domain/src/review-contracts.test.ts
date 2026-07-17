import { describe, expect, it } from "vitest";

import {
  reviewDecisionRequestV1Schema,
  reviewDecisionResponseV1Schema,
  reviewEvidenceAckRequestV1Schema,
  reviewEvidenceAckResponseV1Schema,
  reviewOfferDecisionV1Schema,
  reviewQueueFiltersV1Schema,
  reviewQueueResponseV1Schema,
} from "./review-contracts";
import { syntheticStructuredOfferCandidates } from "./offer-ingestion-golden-fixtures";

const candidate = syntheticStructuredOfferCandidates[1]!;
const {
  candidateKey: omittedCandidateKey,
  geographicScope: omittedGeographicScope,
  ...reviewCandidate
} = candidate;
void omittedCandidateKey;
void omittedGeographicScope;

const queueEntry = {
  approvalEvidence: {
    cropGeometry: "unavailable",
    presentation: "full_capture",
    state: "render_required",
  },
  anomalyCodes: [],
  candidate: {
    ...reviewCandidate,
    provenance: {
      ...candidate.provenance,
      evidenceLocator: `review-evidence:${"b".repeat(64)}`,
    },
  },
  candidateId: "review-candidate:42",
  capture: {
    cropReference: `review-crop:${"a".repeat(64)}`,
    mimeType: "application/pdf",
    retrievedAt: "2026-07-12T12:00:30.000Z",
    rightsClassification: "private_review",
  },
  chain: "extra",
  confidence: 100,
  createdAt: "2026-07-12T12:01:01.000Z",
  extractionMethod: "structured",
  extractionDisposition: "exact-match",
  publication: {
    title: "Synthetic local edition",
    validFrom: "2026-07-13T00:00:00.000Z",
    validUntil: "2026-07-20T00:00:00.000Z",
  },
  scope: { id: "review-scope:42", kind: "postal_set", label: "Synthetic local" },
  sourceId: "synthetic-rights-cleared-feed",
  version: 0,
} as const;

const approvalEvidence = {
  presentation: "full_capture",
  token: `review-proof:v1.${Date.parse("2026-07-17T12:02:00.000Z").toString(36)}.${"a".repeat(22)}.${"b".repeat(64)}.${"c".repeat(64)}`,
} as const;

const evidenceChallenge = `review-challenge:v1.${Date.parse("2026-07-17T12:02:00.000Z").toString(36)}.${"d".repeat(22)}.${"e".repeat(64)}.${"f".repeat(64)}`;

const decision = {
  channels: ["in-store"],
  eligibility: { kind: "public" },
  pricing: { kind: "unit", offerPriceOre: 3_990, beforePriceOre: 4_990 },
  target: { kind: "exact-product", gtin: "7038010000010" },
  validity: {
    startsAt: "2026-07-13T00:00:00.000Z",
    endsAt: "2026-07-20T00:00:00.000Z",
  },
} as const;

describe("private review contracts", () => {
  it("accepts bounded queue filters without a count-enumeration option", () => {
    const filters = {
      ageHours: { min: 2, max: 72 },
      anomaly: "OCR_REVIEW_REQUIRED",
      chain: "extra",
      confidence: { min: 50, max: 95 },
      contractVersion: 1,
      limit: 25,
      scopeKind: "postal_set",
    };

    expect(reviewQueueFiltersV1Schema.parse(filters)).toEqual(filters);
    expect(reviewQueueFiltersV1Schema.safeParse({ ...filters, includeTotal: true }).success)
      .toBe(false);
    expect(reviewQueueFiltersV1Schema.safeParse({ ...filters, limit: 51 }).success)
      .toBe(false);
    expect(reviewQueueFiltersV1Schema.safeParse({ ...filters, confidence: { min: 96, max: 95 } }).success)
      .toBe(false);
  });

  it("exposes only a rights-classified crop reference and immutable typed candidate", () => {
    const response = { contractVersion: 1, items: [queueEntry] };
    expect(reviewQueueResponseV1Schema.parse(response)).toEqual(response);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      total: 1,
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      items: [{
        ...queueEntry,
        approvalEvidence: { state: "available" },
      }],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      items: [{
        ...queueEntry,
        capture: { ...queueEntry.capture, blobKey: "private/source.pdf" },
      }],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      items: [{
        ...queueEntry,
        capture: { ...queueEntry.capture, rightsClassification: "extract_only" },
      }],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      items: [queueEntry, queueEntry],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      items: [{
        ...queueEntry,
        candidate: {
          ...queueEntry.candidate,
          candidateKey: "/private/captures/source-page-1.png",
        },
      }],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      ...response,
      items: [{
        ...queueEntry,
        candidate: {
          ...queueEntry.candidate,
          geographicScope: {
            countryCode: "NO",
            kind: "postal-set",
            postalCodes: ["0001"],
          },
        },
      }],
    }).success).toBe(false);
    expect(JSON.stringify(reviewQueueResponseV1Schema.parse(response)))
      .not.toContain("/private/captures/source-page-1.png");
    expect(reviewQueueResponseV1Schema.parse(response).items[0]!.candidate)
      .not.toHaveProperty("geographicScope");
  });

  it("binds queue metadata to immutable extraction provenance and anomalies", () => {
    expect(reviewQueueResponseV1Schema.safeParse({
      contractVersion: 1,
      items: [{ ...queueEntry, confidence: 99 }],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      contractVersion: 1,
      items: [{ ...queueEntry, anomalyCodes: ["OCR_REVIEW_REQUIRED"] }],
    }).success).toBe(false);
    expect(reviewQueueResponseV1Schema.safeParse({
      contractVersion: 1,
      items: [{
        ...queueEntry,
        candidate: {
          ...queueEntry.candidate,
          provenance: {
            ...queueEntry.candidate.provenance,
            evidenceLocator: "official-offers/private/source-page-1",
          },
        },
      }],
    }).success).toBe(false);
  });

  it("accepts approve, correction, and rejection actions with optimistic versions", () => {
    expect(reviewDecisionRequestV1Schema.parse({
      action: "approve",
      approvalEvidence,
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      decision,
      expectedVersion: 0,
      reason: "Fields match the rights-cleared source.",
    })).toMatchObject({ action: "approve", expectedVersion: 0 });
    expect(reviewDecisionRequestV1Schema.parse({
      action: "correct_and_approve",
      approvalEvidence,
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      decision: { ...decision, pricing: { ...decision.pricing, offerPriceOre: 3_790 } },
      expectedVersion: 1,
      reason: "Corrected a typed price after visual comparison.",
    })).toMatchObject({ action: "correct_and_approve", expectedVersion: 1 });
    expect(reviewDecisionRequestV1Schema.parse({
      action: "reject",
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      expectedVersion: 0,
      reason: "The source crop is ambiguous.",
    })).toMatchObject({ action: "reject", expectedVersion: 0 });
  });

  it("fails closed on family-scoped approval until reviewed expansion exists", () => {
    expect(reviewOfferDecisionV1Schema.safeParse({
      ...decision,
      target: { familySlug: "melk", kind: "reviewed-family" },
    }).success).toBe(false);
  });

  it("keeps evidence acknowledgement exact, opaque, and separate from approval proof", () => {
    const request = {
      candidateId: queueEntry.candidateId,
      challenge: evidenceChallenge,
      contractVersion: 1,
      digestSha256: "c".repeat(64),
      presentation: "full_capture",
    } as const;
    const response = {
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      expiresAt: "2026-07-17T12:02:00.000Z",
      presentation: "full_capture",
      proofToken: approvalEvidence.token,
      renderedAt: "2026-07-17T12:00:30.000Z",
    } as const;

    expect(reviewEvidenceAckRequestV1Schema.parse(request)).toEqual(request);
    expect(reviewEvidenceAckResponseV1Schema.parse(response)).toEqual(response);
    expect(reviewEvidenceAckRequestV1Schema.safeParse({
      ...request,
      challenge: approvalEvidence.token,
    }).success).toBe(false);
    expect(reviewDecisionRequestV1Schema.safeParse({
      action: "approve",
      approvalEvidence: { presentation: "full_capture", token: evidenceChallenge },
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      decision,
      expectedVersion: 0,
      reason: "A delivery challenge must never authorize approval.",
    }).success).toBe(false);
    expect(reviewEvidenceAckRequestV1Schema.safeParse({
      ...request,
      digestSha256: "C".repeat(64),
    }).success).toBe(false);
    expect(reviewEvidenceAckRequestV1Schema.safeParse({ ...request, checksumSha256: "c".repeat(64) })
      .success).toBe(false);
    expect(reviewEvidenceAckResponseV1Schema.safeParse({ ...response, digestSha256: "c".repeat(64) })
      .success).toBe(false);
  });

  it("keeps reviewed member-program IDs canonical and producer-compatible", () => {
    const memberDecision = {
      ...decision,
      eligibility: { kind: "member", programId: "source-neutral-program" },
    };
    expect(reviewOfferDecisionV1Schema.safeParse(memberDecision).success).toBe(true);
    for (const programId of [
      " source-neutral-program",
      "source-neutral-program ",
      "source\u0000neutral",
      "e\u0301",
      "x".repeat(201),
    ]) {
      expect(reviewOfferDecisionV1Schema.safeParse({
        ...memberDecision,
        eligibility: { kind: "member", programId },
      }).success).toBe(false);
    }
  });

  it("rejects unsafe decision arithmetic and malformed audit responses", () => {
    expect(reviewDecisionRequestV1Schema.safeParse({
      action: "approve",
      approvalEvidence,
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      decision: {
        ...decision,
        pricing: { kind: "unit", offerPriceOre: 5_000, beforePriceOre: 4_000 },
      },
      expectedVersion: 0,
      reason: "Invalid arithmetic must fail.",
    }).success).toBe(false);
    expect(reviewDecisionResponseV1Schema.safeParse({
      actedAt: "2026-07-12T12:10:00.000Z",
      actionId: "review-action:1",
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      newVersion: 1,
      state: "approved",
    }).success).toBe(false);
    expect(reviewDecisionResponseV1Schema.safeParse({
      actedAt: "2026-07-12T12:10:00.000Z",
      actionId: "review-action:1",
      candidateId: queueEntry.candidateId,
      contractVersion: 1,
      newVersion: 1,
      offerId: "review-offer:1",
      state: "rejected",
    }).success).toBe(false);
  });
});
