import { describe, expect, it } from "vitest";

import {
  OFFICIAL_OFFER_FOUNDATION_ACTIVATION,
  canonicalOfficialOfferEditionIdentity,
  extractedOfficialOfferCandidateV1Schema,
  officialOfferAuthorizationFenceV1Schema,
  officialOfferCaptureMetadataV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  officialOfferExtractionTimingV1Schema,
  officialOfferFoundationActivationSchema,
  validateOfficialOfferExtraction,
} from "./offer-ingestion-contracts";
import {
  SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  syntheticAuthorizedLocalEdition,
  syntheticContradictoryBeforePriceCandidate,
  syntheticExactProductIdsByGtin,
  syntheticStructuredExtractionEnvelope,
  syntheticStructuredOfferCandidates,
  syntheticUnreadableDateOfferCandidate,
} from "./offer-ingestion-golden-fixtures";

const validationContext = {
  contractVersion: 1,
  expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
  expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  exactProductIdsByGtin: syntheticExactProductIdsByGtin,
};

function validationContextFor(...gtins: (keyof typeof syntheticExactProductIdsByGtin)[]) {
  return {
    ...validationContext,
    exactProductIdsByGtin: Object.fromEntries(gtins.map((gtin) => [
      gtin,
      syntheticExactProductIdsByGtin[gtin],
    ])),
  };
}

describe("official-offer ingestion contracts", () => {
  it("binds canonical edition identity to every immutable source fact, not authorization refreshes", () => {
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse(
      syntheticAuthorizedLocalEdition,
    );
    const identity = canonicalOfficialOfferEditionIdentity(edition);
    const refreshedAuthorization = officialOfferEditionDiscoveryInputV1Schema.parse({
      ...syntheticAuthorizedLocalEdition,
      authorization: {
        ...syntheticAuthorizedLocalEdition.authorization,
        capabilities: ["capture", "discover", "extract"],
      },
    });
    expect(canonicalOfficialOfferEditionIdentity(refreshedAuthorization)).toBe(identity);
    for (const changed of [
      { ...edition, contentKind: "publication" as const },
      { ...edition, discoveredAt: "2026-07-12T12:00:01.000Z" },
      {
        ...edition,
        declaredGeographicScope: {
          kind: "postal-set" as const,
          countryCode: "NO",
          postalCodes: ["0001", "0003"],
        },
      },
    ]) {
      expect(canonicalOfficialOfferEditionIdentity(changed)).not.toBe(identity);
    }
  });

  it("requires a canonical, current permission fence and bounded server timing", () => {
    const fence = {
      contractVersion: 1,
      permissionId: 11,
      sourceId: syntheticAuthorizedLocalEdition.sourceId,
      decision: "approved",
      capabilities: ["capture", "discover", "extract"],
      rightsClassifications: ["extract_only", "private_review", "public_display"],
      reviewedAt: "2026-07-12T11:00:00.000Z",
      validUntil: "2026-07-12T13:00:00.000Z",
      evaluatedAt: "2026-07-12T12:00:00.000Z",
    };
    expect(officialOfferAuthorizationFenceV1Schema.safeParse(fence).success).toBe(true);
    expect(officialOfferAuthorizationFenceV1Schema.safeParse({
      ...fence,
      capabilities: ["discover", "capture", "extract"],
    }).success).toBe(false);
    expect(officialOfferAuthorizationFenceV1Schema.safeParse({
      ...fence,
      validUntil: fence.evaluatedAt,
    }).success).toBe(false);
    expect(officialOfferExtractionTimingV1Schema.safeParse({
      contractVersion: 1,
      serverStartedAt: "2026-07-12T12:00:00.000Z",
      serverCompletedAt: "2026-07-12T12:10:00.000Z",
    }).success).toBe(true);
    expect(officialOfferExtractionTimingV1Schema.safeParse({
      contractVersion: 1,
      serverStartedAt: "2026-07-12T12:00:00.000Z",
      serverCompletedAt: "2026-07-12T12:10:00.001Z",
    }).success).toBe(false);
  });

  it("stays explicitly disabled and accepts only an authorized, bounded edition", () => {
    expect(officialOfferFoundationActivationSchema.parse(
      OFFICIAL_OFFER_FOUNDATION_ACTIVATION,
    )).toEqual(OFFICIAL_OFFER_FOUNDATION_ACTIVATION);
    expect(officialOfferFoundationActivationSchema.safeParse({
      ...OFFICIAL_OFFER_FOUNDATION_ACTIVATION,
      enabled: true,
    }).success).toBe(false);
    expect(officialOfferEditionDiscoveryInputV1Schema.parse(
      syntheticAuthorizedLocalEdition,
    )).toEqual(syntheticAuthorizedLocalEdition);
    expect(officialOfferEditionDiscoveryInputV1Schema.safeParse({
      ...syntheticAuthorizedLocalEdition,
      authorization: {
        ...syntheticAuthorizedLocalEdition.authorization,
        decision: "conditional",
      },
    }).success).toBe(false);
    expect(officialOfferEditionDiscoveryInputV1Schema.safeParse({
      ...syntheticAuthorizedLocalEdition,
      authorization: {
        ...syntheticAuthorizedLocalEdition.authorization,
        capabilities: ["discover", "capture"],
      },
    }).success).toBe(false);
    expect(officialOfferEditionDiscoveryInputV1Schema.safeParse({
      ...syntheticAuthorizedLocalEdition,
      authorization: {
        ...syntheticAuthorizedLocalEdition.authorization,
        reviewedAt: "2026-07-12T12:00:01.000Z",
      },
    }).success).toBe(false);
  });

  it("accepts only immutable private capture metadata with a bounded SHA-256 identity", () => {
    const metadata = {
      contractVersion: 1,
      publicationId: 42,
      sourceId: syntheticAuthorizedLocalEdition.sourceId,
      externalEditionId: syntheticAuthorizedLocalEdition.externalEditionId,
      checksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
      mimeType: "application/json",
      byteLength: 321,
      rightsClassification: "extract_only",
      retrievedAt: "2026-07-12T12:00:30.000Z",
    };
    expect(officialOfferCaptureMetadataV1Schema.parse(metadata)).toEqual(metadata);
    expect(officialOfferCaptureMetadataV1Schema.safeParse({
      ...metadata,
      checksumSha256: "not-a-checksum",
    }).success).toBe(false);
    expect(officialOfferCaptureMetadataV1Schema.safeParse({
      ...metadata,
      rawBytes: "private-content-must-not-enter-metadata",
    }).success).toBe(false);
  });

  it("bounds aggregate geographic scope members across one extraction envelope", () => {
    const candidate = syntheticStructuredOfferCandidates[0]!;
    const storeIds = Array.from({ length: 1_000 }, (_, index) => `store-${index}`);
    expect(officialOfferExtractionEnvelopeV1Schema.safeParse({
      ...syntheticStructuredExtractionEnvelope,
      candidates: Array.from({ length: 11 }, (_, index) => ({
        ...candidate,
        candidateKey: `aggregate-scope-${index}`,
        geographicScope: { kind: "stores", storeIds },
      })),
    }).success).toBe(false);
  });

  it("validates synthetic ordinary, before-price, multibuy, member, package, and local offers", () => {
    expect(officialOfferExtractionEnvelopeV1Schema.parse(
      syntheticStructuredExtractionEnvelope,
    )).toEqual(syntheticStructuredExtractionEnvelope);
    const result = validateOfficialOfferExtraction(
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      validationContext,
    );
    expect(result).toMatchObject({
      status: "completed",
      counts: { exactMatch: 5, rejected: 0, reviewRequired: 0, total: 5 },
    });
    expect(result.candidates.map(({ disposition }) => disposition)).toEqual(
      Array.from({ length: 5 }, () => "exact-match"),
    );
    expect(result.candidates.map(({ publicationRoute }) => publicationRoute)).toEqual(
      Array.from({ length: 5 }, () => "human-review-required"),
    );
    expect(result.candidates[2]?.candidate.pricing).toEqual({
      kind: "multibuy",
      quantity: 3,
      totalOre: 10_000,
      beforeUnitPriceOre: 3_990,
    });
    expect(result.candidates[3]?.candidate.eligibility).toEqual({
      kind: "member",
      programId: "synthetic-member-program",
    });
    expect(result.candidates[4]?.candidate.package).toEqual({
      state: "parsed",
      amount: 750,
      unit: "ml",
      unitsPerPack: 2,
    });
  });

  it("forces OCR through review even when the product match is exact", () => {
    const candidate = syntheticStructuredOfferCandidates[0]!;
    const result = validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      method: "ocr",
      candidates: [{
        ...candidate,
        provenance: { ...candidate.provenance, method: "ocr", confidence: 92 },
      }],
    }, syntheticAuthorizedLocalEdition, validationContextFor("70000001"));

    expect(result).toMatchObject({
      status: "completed",
      counts: { exactMatch: 0, rejected: 0, reviewRequired: 1, total: 1 },
    });
    expect(result.candidates[0]).toMatchObject({
      disposition: "review-required",
      exactCanonicalProductId: "product:synthetic-1",
      anomalyCodes: ["OCR_REVIEW_REQUIRED"],
      publicationRoute: "human-review-required",
    });
    expect(result.candidates[0]?.candidate.anomalyCodes).toEqual([
      "OCR_REVIEW_REQUIRED",
    ]);
  });

  it("degrades unreadable dates and rejects contradictory before-price arithmetic", () => {
    const result = validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      candidates: [
        syntheticUnreadableDateOfferCandidate,
        syntheticContradictoryBeforePriceCandidate,
      ],
    }, syntheticAuthorizedLocalEdition, validationContextFor("70000001", "70000002"));

    expect(result.status).toBe("degraded");
    expect(result.candidates[0]).toMatchObject({
      disposition: "review-required",
      anomalyCodes: ["UNREADABLE_DATE"],
    });
    expect(result.candidates[1]).toMatchObject({
      disposition: "rejected",
      anomalyCodes: ["BEFORE_PRICE_BELOW_OFFER"],
      publicationRoute: "blocked",
    });
  });

  it("fails closed on schema drift and degrades layout or silent-zero drift", () => {
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      schemaFingerprintSha256: "4".repeat(64),
    }, syntheticAuthorizedLocalEdition, validationContext)).toEqual({
      candidates: [],
      counts: { exactMatch: 0, rejected: 0, reviewRequired: 0, total: 0 },
      errorClass: "SCHEMA_DRIFT",
      status: "failed",
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      layoutFingerprintSha256: "5".repeat(64),
    }, syntheticAuthorizedLocalEdition, validationContext)).toMatchObject({
      errorClass: "LAYOUT_DRIFT",
      status: "degraded",
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      emptyResult: "unexpected-empty",
      candidates: [],
    }, syntheticAuthorizedLocalEdition, validationContextFor())).toMatchObject({
      errorClass: "UNEXPECTED_EMPTY",
      status: "degraded",
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      emptyResult: "confirmed-empty",
      candidates: [],
    }, syntheticAuthorizedLocalEdition, validationContext)).toMatchObject({
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      emptyResult: "confirmed-empty",
      emptyConfirmation: {
        sourceId: syntheticAuthorizedLocalEdition.sourceId,
        externalEditionId: syntheticAuthorizedLocalEdition.externalEditionId,
        basis: "source-record-count-zero",
        evidenceLocator: "synthetic-empty-count-field",
      },
      candidates: [],
    }, syntheticAuthorizedLocalEdition, validationContextFor())).toEqual({
      candidates: [],
      counts: { exactMatch: 0, rejected: 0, reviewRequired: 0, total: 0 },
      status: "completed",
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      emptyResult: "confirmed-empty",
      emptyConfirmation: {
        sourceId: syntheticAuthorizedLocalEdition.sourceId,
        externalEditionId: syntheticAuthorizedLocalEdition.externalEditionId,
        basis: "source-record-count-zero",
        evidenceLocator: "synthetic-empty-count-field",
        confirmedAt: "2000-01-01T00:00:00.000Z",
      },
      candidates: [],
    }, syntheticAuthorizedLocalEdition, validationContextFor())).toMatchObject({
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      emptyResult: "confirmed-empty",
      emptyConfirmation: {
        sourceId: "different-synthetic-source",
        externalEditionId: syntheticAuthorizedLocalEdition.externalEditionId,
        basis: "source-declared-empty",
        evidenceLocator: "synthetic-empty-marker",
      },
      candidates: [],
    }, syntheticAuthorizedLocalEdition, validationContextFor())).toMatchObject({
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
  });

  it("routes validity outside the edition window to review", () => {
    const candidate = syntheticStructuredOfferCandidates[0]!;
    const result = validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      candidates: [{
        ...candidate,
        validity: {
          state: "parsed",
          startsAt: "2026-07-12T00:00:00.000Z",
          endsAt: syntheticAuthorizedLocalEdition.validUntil,
        },
      }],
    }, syntheticAuthorizedLocalEdition, validationContextFor("70000001"));

    expect(result).toMatchObject({
      status: "degraded",
      candidates: [{
        disposition: "review-required",
        anomalyCodes: ["VALIDITY_OUTSIDE_EDITION"],
      }],
    });
  });

  it("does not collapse distinct package, eligibility, or channel variants", () => {
    const candidate = syntheticStructuredOfferCandidates[0]!;
    const result = validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      candidates: [
        candidate,
        {
          ...candidate,
          candidateKey: "synthetic-member-variant",
          eligibility: { kind: "member", programId: "synthetic-member-program" },
        },
        {
          ...candidate,
          candidateKey: "synthetic-package-variant",
          package: { state: "parsed", amount: 1_000, unit: "g", unitsPerPack: 1 },
        },
        {
          ...candidate,
          candidateKey: "synthetic-channel-variant",
          channels: ["online"],
        },
      ],
    }, syntheticAuthorizedLocalEdition, validationContextFor("70000001"));

    expect(result.counts).toEqual({ exactMatch: 4, rejected: 0, reviewRequired: 0, total: 4 });
    expect(result.candidates.every(({ anomalyCodes }) =>
      !anomalyCodes.includes("DUPLICATE_OFFER"))).toBe(true);
  });

  it("permits automatic matching only for one exact canonical identifier", () => {
    const candidate = syntheticStructuredOfferCandidates[0]!;
    const result = validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      candidates: [
        {
          ...candidate,
          candidateKey: "synthetic-unresolved-label",
          product: { kind: "unresolved-label", label: "Invented test item" },
        },
        {
          ...candidate,
          candidateKey: "synthetic-ambiguous-identifier",
        },
      ],
    }, syntheticAuthorizedLocalEdition, {
      ...validationContext,
      exactProductIdsByGtin: {
        "70000001": ["product:synthetic-1", "product:synthetic-duplicate"],
      },
    });

    expect(result.counts).toEqual({ exactMatch: 0, rejected: 0, reviewRequired: 2, total: 2 });
    expect(result.candidates).toMatchObject([
      { disposition: "review-required", anomalyCodes: ["UNMATCHED_PRODUCT"] },
      { disposition: "review-required", anomalyCodes: ["AMBIGUOUS_PRODUCT"] },
    ]);
  });

  it("fails closed on malformed or duplicate exact-product lookup context", () => {
    expect(validateOfficialOfferExtraction(
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      {
        ...validationContext,
        exactProductIdsByGtin: { "70000001": ["product:one", "product:one"] },
      },
    )).toMatchObject({ errorClass: "INVALID_CONTRACT", status: "failed" });
    expect(validateOfficialOfferExtraction(
      syntheticStructuredExtractionEnvelope,
      syntheticAuthorizedLocalEdition,
      {
        ...validationContext,
        exactProductIdsByGtin: { invalid: ["product:one"] },
      },
    )).toMatchObject({ errorClass: "INVALID_CONTRACT", status: "failed" });
    expect(validateOfficialOfferExtraction(
      {
        ...syntheticStructuredExtractionEnvelope,
        candidates: [syntheticStructuredOfferCandidates[0]!],
      },
      syntheticAuthorizedLocalEdition,
      validationContext,
    )).toMatchObject({ errorClass: "INVALID_CONTRACT", status: "failed" });
  });

  it("detects duplicate keys, duplicate offers, unknown scope, and invalid contract drift", () => {
    const duplicate = syntheticStructuredOfferCandidates[0]!;
    const duplicateResult = validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      candidates: [duplicate, duplicate],
    }, syntheticAuthorizedLocalEdition, validationContextFor("70000001"));
    expect(duplicateResult.counts.rejected).toBe(2);
    expect(duplicateResult.candidates[0]?.anomalyCodes).toEqual([
      "DUPLICATE_CANDIDATE_KEY",
      "DUPLICATE_OFFER",
    ]);

    const unknownScope = {
      ...duplicate,
      candidateKey: "synthetic-unknown-scope",
      geographicScope: { kind: "unknown", reason: "source omitted edition scope" },
    };
    expect(extractedOfficialOfferCandidateV1Schema.safeParse(unknownScope).success).toBe(true);
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      candidates: [unknownScope],
    }, syntheticAuthorizedLocalEdition, validationContextFor("70000001"))).toMatchObject({
      status: "degraded",
      candidates: [{
        disposition: "review-required",
        anomalyCodes: ["UNKNOWN_SCOPE"],
      }],
    });
    expect(validateOfficialOfferExtraction({
      ...syntheticStructuredExtractionEnvelope,
      extraField: true,
    }, syntheticAuthorizedLocalEdition, validationContext)).toMatchObject({
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
  });
});
