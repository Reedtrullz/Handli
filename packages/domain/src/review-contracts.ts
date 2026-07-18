import { z } from "zod";

import { gtinSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { MAX_PERSISTED_MONEY_ORE } from "./contracts";
import {
  extractedOfficialOfferCandidateV1Schema,
  officialOfferAnomalyCodeSchema,
  officialOfferExtractionMethodSchema,
} from "./offer-ingestion-contracts";
import { membershipProgramIdSchema } from "./offers";

export const REVIEW_QUEUE_LIMIT_MAX = 50;
export const REVIEW_REASON_MAX_LENGTH = 1_000;

const chainSchema = z.enum(["bunnpris", "extra", "rema-1000"]);
const scopeKindSchema = z.enum(["national", "region", "postal_set", "store_set"]);
const moneySchema = z.number().int().nonnegative().max(MAX_PERSISTED_MONEY_ORE);

export const reviewCandidateIdSchema = z.string()
  .regex(/^review-candidate:[1-9][0-9]{0,15}$/u);
export const reviewActionIdSchema = z.string()
  .regex(/^review-action:[1-9][0-9]{0,15}$/u);
export const reviewOfferIdSchema = z.string()
  .regex(/^review-offer:[1-9][0-9]{0,15}$/u);
export const reviewScopeIdSchema = z.string()
  .regex(/^review-scope:[1-9][0-9]{0,15}$/u);
export const reviewCropReferenceSchema = z.string()
  .regex(/^review-crop:[0-9a-f]{64}$/u);
export const reviewEvidenceReferenceSchema = z.string()
  .regex(/^review-evidence:[0-9a-f]{64}$/u);
export const reviewEvidenceProofTokenSchema = z.string()
  .regex(/^review-proof:v1\.[0-9a-z]{8,12}\.[A-Za-z0-9_-]{22}\.[0-9a-f]{64}\.[0-9a-f]{64}$/u)
  .max(256);
export const reviewEvidenceChallengeTokenSchema = z.string()
  .regex(/^review-challenge:v1\.[0-9a-z]{8,12}\.[A-Za-z0-9_-]{22}\.[0-9a-f]{64}\.[0-9a-f]{64}$/u)
  .max(256);
export const reviewCursorSchema = z.string()
  .regex(/^review-cursor:[A-Za-z0-9_-]{8,500}$/u);

const boundedRangeSchema = (maximum: number) => z
  .object({
    max: nonNegativeSafeIntegerSchema.max(maximum).optional(),
    min: nonNegativeSafeIntegerSchema.max(maximum).optional(),
  })
  .strict()
  .refine(({ max, min }) => max === undefined || min === undefined || min <= max, {
    message: "Review filter minimum cannot exceed maximum",
  });

export const reviewQueueFiltersV1Schema = z
  .object({
    ageHours: boundedRangeSchema(24 * 90).optional(),
    anomaly: officialOfferAnomalyCodeSchema.optional(),
    chain: chainSchema.optional(),
    confidence: boundedRangeSchema(100).optional(),
    contractVersion: contractVersionSchema,
    cursor: reviewCursorSchema.optional(),
    limit: positiveSafeIntegerSchema.max(REVIEW_QUEUE_LIMIT_MAX),
    scopeKind: scopeKindSchema.optional(),
  })
  .strict();

export type ReviewQueueFiltersV1 = z.infer<typeof reviewQueueFiltersV1Schema>;

const reviewScopeSchema = z
  .object({
    id: reviewScopeIdSchema,
    kind: scopeKindSchema,
    label: nonEmptyStringSchema.max(200),
  })
  .strict();

const reviewCaptureReferenceSchema = z
  .object({
    cropReference: reviewCropReferenceSchema,
    mimeType: z.string().trim().min(1).max(120),
    retrievedAt: canonicalTimestampSchema,
    rightsClassification: z.enum(["private_review", "public_display"]),
  })
  .strict();

const reviewApprovalEvidenceSchema = z
  .object({
    cropGeometry: z.literal("unavailable"),
    presentation: z.literal("full_capture"),
    state: z.literal("render_required"),
  })
  .strict();

// Extractor candidate keys are source-controlled correlation values. Full
// geographic scopes can also contain 10,000 postal codes or 1,000 store IDs.
// Neither belongs in the browser contract: the queue already carries the
// database-derived scope kind/label separately. Reuse the refined ingestion
// schema with private sentinels only while parsing, then remove both fields
// from the output. Inputs that contain either private field are rejected rather
// than silently stripped.
export const reviewCandidateProjectionV1Schema = z
  .preprocess((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (
      Object.hasOwn(record, "candidateKey")
      || Object.hasOwn(record, "geographicScope")
    ) return null;
    return {
      ...record,
      candidateKey: "private-review-projection",
      geographicScope: { countryCode: "NO", kind: "national" },
    };
  }, extractedOfficialOfferCandidateV1Schema)
  .transform(({
    candidateKey: _candidateKey,
    geographicScope: _geographicScope,
    ...candidate
  }) => candidate);

export type ReviewCandidateProjectionV1 = z.infer<
  typeof reviewCandidateProjectionV1Schema
>;

export const reviewQueueCandidateV1Schema = z
  .object({
    approvalEvidence: reviewApprovalEvidenceSchema,
    anomalyCodes: z.array(officialOfferAnomalyCodeSchema).max(20),
    candidate: reviewCandidateProjectionV1Schema,
    candidateId: reviewCandidateIdSchema,
    capture: reviewCaptureReferenceSchema,
    chain: chainSchema,
    confidence: z.number().int().min(0).max(100),
    createdAt: canonicalTimestampSchema,
    extractionMethod: officialOfferExtractionMethodSchema,
    extractionDisposition: z.enum(["exact-match", "review-required"]),
    publication: z
      .object({
        title: nonEmptyStringSchema.max(240),
        validFrom: canonicalTimestampSchema,
        validUntil: canonicalTimestampSchema,
      })
      .strict(),
    scope: reviewScopeSchema,
    sourceId: sourceIdSchema.max(64),
    version: nonNegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      !hasUniqueStrings(entry.anomalyCodes)
      || entry.anomalyCodes.some((code) => !entry.candidate.anomalyCodes.includes(code))
      || entry.candidate.anomalyCodes.some((code) => !entry.anomalyCodes.includes(code))
    ) {
      context.addIssue({
        code: "custom",
        message: "Review anomaly codes must exactly match the immutable candidate",
        path: ["anomalyCodes"],
      });
    }
    if (
      entry.confidence !== entry.candidate.provenance.confidence
      || entry.extractionMethod !== entry.candidate.provenance.method
    ) {
      context.addIssue({
        code: "custom",
        message: "Review metadata must match immutable extraction provenance",
        path: ["confidence"],
      });
    }
    if (!reviewEvidenceReferenceSchema.safeParse(
      entry.candidate.provenance.evidenceLocator,
    ).success) {
      context.addIssue({
        code: "custom",
        message: "Private review candidates require an opaque evidence reference",
        path: ["candidate", "provenance", "evidenceLocator"],
      });
    }
    if (Date.parse(entry.publication.validFrom) >= Date.parse(entry.publication.validUntil)) {
      context.addIssue({
        code: "custom",
        message: "Review publication validity is invalid",
        path: ["publication", "validUntil"],
      });
    }
  });

export type ReviewQueueCandidateV1 = z.infer<typeof reviewQueueCandidateV1Schema>;

export const reviewQueueResponseV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    items: z.array(reviewQueueCandidateV1Schema).max(REVIEW_QUEUE_LIMIT_MAX),
    nextCursor: reviewCursorSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (!hasUniqueStrings(response.items.map(({ candidateId }) => candidateId))) {
      context.addIssue({
        code: "custom",
        message: "Review queue candidate IDs must be unique",
        path: ["items"],
      });
    }
  });

export type ReviewQueueResponseV1 = z.infer<typeof reviewQueueResponseV1Schema>;

// V1 publication is exact-product only. A family-scoped offer would need a
// separately reviewed, version-bound expansion into explicit products; a
// bare family slug is not enough publication evidence.
const reviewTargetSchema = z
  .object({ kind: z.literal("exact-product"), gtin: gtinSchema })
  .strict();

const unitDecisionPricingSchema = z
  .object({
    beforePriceOre: moneySchema.optional(),
    kind: z.literal("unit"),
    offerPriceOre: moneySchema,
  })
  .strict()
  .refine(
    ({ beforePriceOre, offerPriceOre }) =>
      beforePriceOre === undefined || beforePriceOre >= offerPriceOre,
    { message: "Review before price cannot be below the offer price" },
  );

const multibuyDecisionPricingSchema = z
  .object({
    beforeUnitPriceOre: moneySchema.optional(),
    kind: z.literal("multibuy"),
    quantity: positiveSafeIntegerSchema.min(2).max(100),
    totalOre: moneySchema,
  })
  .strict()
  .refine(
    ({ beforeUnitPriceOre, quantity, totalOre }) =>
      beforeUnitPriceOre === undefined
      || BigInt(beforeUnitPriceOre) * BigInt(quantity) >= BigInt(totalOre),
    { message: "Review multibuy before price cannot be below the group price" },
  );

export const reviewOfferDecisionV1Schema = z
  .object({
    channels: z.array(z.enum(["in-store", "online"])).min(1).max(2),
    eligibility: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("public") }).strict(),
      z.object({ kind: z.literal("member"), programId: membershipProgramIdSchema }).strict(),
    ]),
    pricing: z.discriminatedUnion("kind", [
      unitDecisionPricingSchema,
      multibuyDecisionPricingSchema,
    ]),
    target: reviewTargetSchema,
    validity: z
      .object({
        endsAt: canonicalTimestampSchema,
        startsAt: canonicalTimestampSchema,
      })
      .strict()
      .refine(({ endsAt, startsAt }) => Date.parse(startsAt) < Date.parse(endsAt), {
        message: "Reviewed offer validity must end after it begins",
      }),
  })
  .strict()
  .superRefine((decision, context) => {
    if (!hasUniqueStrings(decision.channels)) {
      context.addIssue({
        code: "custom",
        message: "Reviewed offer channels must be unique",
        path: ["channels"],
      });
    }
  });

export type ReviewOfferDecisionV1 = z.infer<typeof reviewOfferDecisionV1Schema>;

const reviewActionBase = {
  candidateId: reviewCandidateIdSchema,
  contractVersion: contractVersionSchema,
  expectedVersion: nonNegativeSafeIntegerSchema,
  reason: z.string().trim().min(1).max(REVIEW_REASON_MAX_LENGTH),
};

const renderedApprovalEvidenceSchema = z
  .object({
    presentation: z.literal("full_capture"),
    token: reviewEvidenceProofTokenSchema,
  })
  .strict();

export const reviewDecisionRequestV1Schema = z.discriminatedUnion("action", [
  z.object({
    ...reviewActionBase,
    action: z.literal("approve"),
    approvalEvidence: renderedApprovalEvidenceSchema,
    decision: reviewOfferDecisionV1Schema,
  }).strict(),
  z.object({
    ...reviewActionBase,
    action: z.literal("correct_and_approve"),
    approvalEvidence: renderedApprovalEvidenceSchema,
    decision: reviewOfferDecisionV1Schema,
  }).strict(),
  z.object({
    ...reviewActionBase,
    action: z.literal("reject"),
  }).strict(),
]);

export type ReviewDecisionRequestV1 = z.infer<typeof reviewDecisionRequestV1Schema>;

export const reviewEvidenceAckRequestV1Schema = z
  .object({
    candidateId: reviewCandidateIdSchema,
    challenge: reviewEvidenceChallengeTokenSchema,
    contractVersion: contractVersionSchema,
    digestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    presentation: z.literal("full_capture"),
  })
  .strict();

export type ReviewEvidenceAckRequestV1 = z.infer<typeof reviewEvidenceAckRequestV1Schema>;

export const reviewEvidenceAckResponseV1Schema = z
  .object({
    candidateId: reviewCandidateIdSchema,
    contractVersion: contractVersionSchema,
    expiresAt: canonicalTimestampSchema,
    presentation: z.literal("full_capture"),
    proofToken: reviewEvidenceProofTokenSchema,
    renderedAt: canonicalTimestampSchema,
  })
  .strict();

export type ReviewEvidenceAckResponseV1 = z.infer<typeof reviewEvidenceAckResponseV1Schema>;

export const reviewDecisionResponseV1Schema = z
  .object({
    actedAt: canonicalTimestampSchema,
    actionId: reviewActionIdSchema,
    candidateId: reviewCandidateIdSchema,
    contractVersion: contractVersionSchema,
    newVersion: positiveSafeIntegerSchema,
    offerId: reviewOfferIdSchema.optional(),
    state: z.enum(["approved", "rejected"]),
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.state === "approved") !== (response.offerId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Approved review actions must identify their immutable offer projection",
        path: ["offerId"],
      });
    }
  });

export type ReviewDecisionResponseV1 = z.infer<typeof reviewDecisionResponseV1Schema>;
