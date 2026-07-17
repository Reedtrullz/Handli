import { z } from "zod";

import {
  canonicalTimestampSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { comparisonScopeSchema } from "./coverage";
import { parseEligiblePriceEvidence, priceEvidenceSchema } from "./evidence";
import {
  familyIdentifierSchema,
  familyTaxonomyIdSchema,
  familyTaxonomyVersionSchema,
  reviewedFamilyDescriptorSchema,
} from "./family-taxonomy";
import { calculateCheckoutCost } from "./fulfilment";
import {
  geographicDirectoryEvidenceFromRegionAttestationV1,
  geographicDirectoryRegionAttestationV1Schema,
} from "./geography";
import {
  marketContextsEqual,
  marketContextToGeographicContext,
  marketContextV1Schema,
} from "./market-context";
import {
  enabledMembershipProgramIdsSchema,
  officialOfferSchema,
  parseApplicableOfficialOffer,
} from "./offers";
import {
  derivePlanDeltaExplanationsV1,
  planDeltaExplanationSetV1Schema,
  type PlanDeltaExplanationSetV1,
} from "./plan-delta-explanations";
import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  EXACT_PRODUCT_PRICE_MAX_AGE_MS,
  exactProductPlanApiAssignmentEvidenceSchema,
  exactProductPlanApiEvidenceSourceSchema,
  exactProductPlanApiNeedSchema,
  exactProductPlanApiProductSummarySchema,
} from "./plan-api-contracts";
import { canonicalProjectedPlanResultsV2 } from "./frontier-v2";
import { planResultV2Schema, type PlanResultV2 } from "./planner-v2-contracts";
import type { TravelRouteEvidence } from "./travel-contracts";

export const REVIEWED_FAMILY_PLAN_API_CONTRACT_VERSION = 2 as const;
export const REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT = 50 as const;

const reviewedFamilyContractVersionSchema = z.literal(
  REVIEWED_FAMILY_PLAN_API_CONTRACT_VERSION,
);
const reviewedFamilyMaxStoresSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
const reviewedFamilyCandidateSetIdSchema = z
  .string()
  .regex(/^candidate-set:[0-9a-f]{64}$/);
const reviewedFamilyTaxonomyVersionIdSchema = z
  .string()
  .min(7)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const EXPECTED_CHAIN_IDS = ["bunnpris", "extra", "rema-1000"] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function arraysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (left === undefined || right === undefined) return left === right;
  return sameStrings(left, right);
}

export function normalizeReviewedFamilyAllowedBrand(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("nb-NO");
}

const reviewedFamilyAllowedBrandInputSchema = z
  .string()
  .max(160)
  .transform(normalizeReviewedFamilyAllowedBrand)
  .pipe(
    z.string().min(1).max(120).refine((brand) => !/[\p{Cc}\p{Cf}]/u.test(brand), {
      message: "Allowed brands cannot contain control or formatting characters",
    }),
  );

export const reviewedFamilyAllowedBrandsInputSchema = z
  .array(reviewedFamilyAllowedBrandInputSchema)
  .min(1)
  .max(20)
  .transform(canonicalStrings);

const canonicalReviewedFamilyAllowedBrandSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((brand) => normalizeReviewedFamilyAllowedBrand(brand) === brand, {
    message: "Allowed brands must be normalized Norwegian-locale lowercase text",
  });

export const canonicalReviewedFamilyAllowedBrandsSchema = z
  .array(canonicalReviewedFamilyAllowedBrandSchema)
  .min(1)
  .max(20)
  .refine((brands) => hasUniqueStrings(brands), {
    message: "Allowed brands must be unique",
  })
  .refine((brands) => sameStrings(brands, [...brands].sort(compareText)), {
    message: "Allowed brands must use canonical code-point order",
  });

export const reviewedFamilyPublicTaxonomyEvidenceSchema = z
  .object({
    contentSha256: sha256Schema,
    contractVersion: z.literal(1),
    publishedAt: canonicalTimestampSchema,
    taxonomyId: familyTaxonomyIdSchema,
    taxonomyVersion: familyTaxonomyVersionSchema,
    versionId: reviewedFamilyTaxonomyVersionIdSchema,
  })
  .strict()
  .refine(
    ({ taxonomyId, taxonomyVersion, versionId }) =>
      versionId === `${taxonomyId}@${taxonomyVersion}`,
    {
      message: "Taxonomy version ID must bind the taxonomy ID and semantic version",
      path: ["versionId"],
    },
  );

export type ReviewedFamilyPublicTaxonomyEvidence = z.infer<
  typeof reviewedFamilyPublicTaxonomyEvidenceSchema
>;

const reviewedFamilyMembershipBase = {
  canonicalProductId: identifierSchema,
  confidence: z.literal(100),
  decision: z.literal("approved"),
  decisionId: z.string().regex(/^family-membership:[1-9][0-9]{0,18}$/),
  familyId: familyIdentifierSchema,
  reviewedAt: canonicalTimestampSchema,
};

const reviewedFamilyHumanMembershipEvidenceSchema = z
  .object({
    ...reviewedFamilyMembershipBase,
    method: z.literal("human-review"),
    reviewerAttested: z.literal(true),
  })
  .strict();

const reviewedFamilyRuleMembershipEvidenceSchema = z
  .object({
    ...reviewedFamilyMembershipBase,
    method: z.literal("deterministic-rule"),
    ruleVersion: nonEmptyStringSchema,
  })
  .strict();

/**
 * Public membership provenance. Human reviewer identity is deliberately absent;
 * the only public human-review statement is an attestation bit.
 */
export const reviewedFamilyPublicMembershipEvidenceSchema = z.discriminatedUnion(
  "method",
  [
    reviewedFamilyHumanMembershipEvidenceSchema,
    reviewedFamilyRuleMembershipEvidenceSchema,
  ],
);

export type ReviewedFamilyPublicMembershipEvidence = z.infer<
  typeof reviewedFamilyPublicMembershipEvidenceSchema
>;

export const reviewedFamilyProductClaimSchema = z
  .object({
    canonicalProductId: identifierSchema,
    product: exactProductPlanApiProductSummarySchema,
  })
  .strict();

export type ReviewedFamilyProductClaim = z.infer<
  typeof reviewedFamilyProductClaimSchema
>;

const reviewedFamilyCandidateSelectionSchema = z
  .object({
    familyId: familyIdentifierSchema,
    allowedBrands: reviewedFamilyAllowedBrandsInputSchema.optional(),
  })
  .strict();

export const reviewedFamilyCandidateInspectionRequestSchema = z
  .object({
    contractVersion: reviewedFamilyContractVersionSchema,
    families: z.array(reviewedFamilyCandidateSelectionSchema).min(1).max(20),
  })
  .strict()
  .superRefine(({ families }, context) => {
    if (!hasUniqueStrings(families.map(({ familyId }) => familyId))) {
      context.addIssue({
        code: "custom",
        message: "Candidate inspection family IDs must be unique",
        path: ["families"],
      });
    }
  });

export type ReviewedFamilyCandidateInspectionRequest = z.infer<
  typeof reviewedFamilyCandidateInspectionRequestSchema
>;

export const reviewedFamilyCandidateSetSchema = z
  .object({
    allowedBrands: canonicalReviewedFamilyAllowedBrandsSchema.optional(),
    candidateProductIds: z
      .array(identifierSchema)
      .min(1)
      .max(REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT),
    candidateSetId: reviewedFamilyCandidateSetIdSchema,
    complete: z.literal(true),
    family: reviewedFamilyDescriptorSchema,
    familyId: familyIdentifierSchema,
    taxonomyVersionId: reviewedFamilyTaxonomyVersionIdSchema,
  })
  .strict()
  .superRefine(({ candidateProductIds }, context) => {
    if (!hasUniqueStrings(candidateProductIds)) {
      context.addIssue({
        code: "custom",
        message: "Candidate products must be unique within a candidate set",
        path: ["candidateProductIds"],
      });
    }
    if (!sameStrings(candidateProductIds, [...candidateProductIds].sort(compareText))) {
      context.addIssue({
        code: "custom",
        message: "Candidate products must use canonical product-ID order",
        path: ["candidateProductIds"],
      });
    }
  });

export type ReviewedFamilyCandidateSet = z.infer<
  typeof reviewedFamilyCandidateSetSchema
>;

export const reviewedFamilyCandidateInspectionResponseSchema = z
  .object({
    candidateSets: z.array(reviewedFamilyCandidateSetSchema).min(1).max(20),
    contractVersion: reviewedFamilyContractVersionSchema,
    generatedAt: canonicalTimestampSchema,
    memberships: z
      .array(reviewedFamilyPublicMembershipEvidenceSchema)
      .min(1)
      .max(REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT),
    productClaims: z
      .array(reviewedFamilyProductClaimSchema)
      .min(1)
      .max(REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT),
    sources: z.array(exactProductPlanApiEvidenceSourceSchema).min(1).max(100),
    taxonomy: reviewedFamilyPublicTaxonomyEvidenceSchema,
  })
  .strict();

export type ReviewedFamilyCandidateInspectionResponse = z.infer<
  typeof reviewedFamilyCandidateInspectionResponseSchema
>;

function membershipKey(
  membership: Pick<ReviewedFamilyPublicMembershipEvidence, "familyId" | "canonicalProductId">,
): string {
  return `${membership.familyId}\u0000${membership.canonicalProductId}`;
}

function candidateKey(familyId: string, canonicalProductId: string): string {
  return `${familyId}\u0000${canonicalProductId}`;
}

function validateTaxonomyTime(
  taxonomy: ReviewedFamilyPublicTaxonomyEvidence,
  generatedAt: string,
  context: z.RefinementCtx,
): void {
  if (Date.parse(taxonomy.publishedAt) > Date.parse(generatedAt)) {
    context.addIssue({
      code: "custom",
      message: "A response cannot use a taxonomy publication from the future",
      path: ["taxonomy", "publishedAt"],
    });
  }
}

function validateCanonicalProductClaims(
  productClaims: readonly ReviewedFamilyProductClaim[],
  expectedProductIds: readonly string[],
  generatedAt: string,
  context: z.RefinementCtx,
): Map<string, ReviewedFamilyProductClaim> {
  const productIds = productClaims.map(({ canonicalProductId }) => canonicalProductId);
  if (
    !hasUniqueStrings(productIds)
    || !sameStrings(productIds, [...productIds].sort(compareText))
    || !sameStrings(productIds, expectedProductIds)
  ) {
    context.addIssue({
      code: "custom",
      message: "Product claims must exactly cover the candidate union in canonical order",
      path: ["productClaims"],
    });
  }
  if (!hasUniqueStrings(productClaims.map(({ product }) => product.gtin))) {
    context.addIssue({
      code: "custom",
      message: "One GTIN cannot ambiguously identify different canonical products",
      path: ["productClaims"],
    });
  }

  const generatedAtMs = Date.parse(generatedAt);
  for (const [index, claim] of productClaims.entries()) {
    const observedAtMs = Date.parse(claim.product.catalogEvidence.observedAt);
    if (
      claim.product.catalogEvidence.source.sourceClass !== "catalog"
      || observedAtMs > generatedAtMs
      || generatedAtMs - observedAtMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS
    ) {
      context.addIssue({
        code: "custom",
        message: "Candidate product claims require current approved catalog evidence",
        path: ["productClaims", index, "product", "catalogEvidence"],
      });
    }
  }
  return new Map(productClaims.map((claim) => [claim.canonicalProductId, claim]));
}

function validateMembershipSet(
  memberships: readonly ReviewedFamilyPublicMembershipEvidence[],
  expectedKeys: readonly string[],
  generatedAt: string,
  context: z.RefinementCtx,
): Map<string, ReviewedFamilyPublicMembershipEvidence> {
  const keys = memberships.map(membershipKey);
  if (
    !hasUniqueStrings(memberships.map(({ decisionId }) => decisionId))
    || !hasUniqueStrings(keys)
    || !sameStrings(keys, [...keys].sort(compareText))
    || !sameStrings(keys, expectedKeys)
  ) {
    context.addIssue({
      code: "custom",
      message: "Redacted membership evidence must exactly cover family candidates canonically",
      path: ["memberships"],
    });
  }
  for (const [index, membership] of memberships.entries()) {
    if (Date.parse(membership.reviewedAt) > Date.parse(generatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Membership evidence cannot be reviewed in the future",
        path: ["memberships", index, "reviewedAt"],
      });
    }
  }
  return new Map(memberships.map((membership) => [membershipKey(membership), membership]));
}

function validateCatalogSources(
  sources: readonly z.infer<typeof exactProductPlanApiEvidenceSourceSchema>[],
  productClaims: readonly ReviewedFamilyProductClaim[],
  context: z.RefinementCtx,
): void {
  const sourceIds = sources.map(({ id }) => id);
  const expectedSourceIds = canonicalStrings(
    productClaims.map(({ product }) => product.catalogEvidence.source.id),
  );
  if (
    !hasUniqueStrings(sourceIds)
    || !sameStrings(sourceIds, [...sourceIds].sort(compareText))
    || !sameStrings(sourceIds, expectedSourceIds)
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate sources must exactly cover product catalog claims canonically",
      path: ["sources"],
    });
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  for (const [index, claim] of productClaims.entries()) {
    const embedded = claim.product.catalogEvidence.source;
    const declared = sourceById.get(embedded.id);
    if (declared === undefined || JSON.stringify(declared) !== JSON.stringify(embedded)) {
      context.addIssue({
        code: "custom",
        message: "Catalog claims must embed their exact declared public source",
        path: ["productClaims", index, "product", "catalogEvidence", "source"],
      });
    }
  }
}

export function reviewedFamilyCandidateInspectionResponseSchemaFor(
  request: unknown,
) {
  const parsedRequest = reviewedFamilyCandidateInspectionRequestSchema.parse(request);
  const expectedFamilies = [...parsedRequest.families].sort((left, right) =>
    compareText(left.familyId, right.familyId)
  );

  return reviewedFamilyCandidateInspectionResponseSchema.superRefine(
    (response, context) => {
      validateTaxonomyTime(response.taxonomy, response.generatedAt, context);
      const responseFamilyIds = response.candidateSets.map(({ familyId }) => familyId);
      if (
        !sameStrings(responseFamilyIds, expectedFamilies.map(({ familyId }) => familyId))
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate sets must exactly match requested families in canonical order",
          path: ["candidateSets"],
        });
      }
      if (!hasUniqueStrings(response.candidateSets.map(({ candidateSetId }) => candidateSetId))) {
        context.addIssue({
          code: "custom",
          message: "Candidate-set IDs must be unique across requested families",
          path: ["candidateSets"],
        });
      }

      const selectionByFamily = new Map(
        expectedFamilies.map((selection) => [selection.familyId, selection]),
      );
      const allCandidateIds = response.candidateSets.flatMap(
        ({ candidateProductIds }) => candidateProductIds,
      );
      if (
        allCandidateIds.length > REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT
        || !hasUniqueStrings(allCandidateIds)
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate inspection must expose at most 50 unambiguous products",
          path: ["candidateSets"],
        });
      }

      const expectedMembershipKeys: string[] = [];
      for (const [index, candidateSet] of response.candidateSets.entries()) {
        const requested = selectionByFamily.get(candidateSet.familyId);
        if (
          requested === undefined
          || candidateSet.family.id !== candidateSet.familyId
          || candidateSet.family.status !== "active"
          || !arraysEqual(candidateSet.allowedBrands, requested.allowedBrands)
          || candidateSet.taxonomyVersionId !== response.taxonomy.versionId
        ) {
          context.addIssue({
            code: "custom",
            message: "Candidate sets must bind the requested family, brand filter, and taxonomy",
            path: ["candidateSets", index],
          });
        }
        expectedMembershipKeys.push(
          ...candidateSet.candidateProductIds.map((productId) =>
            candidateKey(candidateSet.familyId, productId)
          ),
        );
      }
      expectedMembershipKeys.sort(compareText);

      const expectedProductIds = canonicalStrings(allCandidateIds);
      const productById = validateCanonicalProductClaims(
        response.productClaims,
        expectedProductIds,
        response.generatedAt,
        context,
      );
      validateMembershipSet(
        response.memberships,
        expectedMembershipKeys,
        response.generatedAt,
        context,
      );
      validateCatalogSources(response.sources, response.productClaims, context);

      for (const [setIndex, candidateSet] of response.candidateSets.entries()) {
        if (candidateSet.allowedBrands === undefined) continue;
        for (const productId of candidateSet.candidateProductIds) {
          const brand = productById.get(productId)?.product.brand;
          if (
            brand === undefined
            || !candidateSet.allowedBrands.includes(
              normalizeReviewedFamilyAllowedBrand(brand),
            )
          ) {
            context.addIssue({
              code: "custom",
              message: "Brand-filtered candidate sets may contain only admitted brands",
              path: ["candidateSets", setIndex, "candidateProductIds"],
            });
          }
        }
      }
    },
  );
}

type CandidateFingerprintInput = {
  readonly allowedBrands?: readonly string[];
  readonly candidates: readonly {
    readonly canonicalProductId: string;
    readonly membership: ReviewedFamilyPublicMembershipEvidence;
    readonly product: ReviewedFamilyProductClaim["product"];
  }[];
  readonly familyId: string;
  readonly taxonomy: ReviewedFamilyPublicTaxonomyEvidence;
};

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson | undefined };

function stableJson(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as { readonly [key: string]: CanonicalJson | undefined };
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key] as CanonicalJson)}`)
    .join(",")}}`;
}

/**
 * Returns the normative UTF-8 input for the `candidate-set:<sha256>` digest.
 * Price facts, catalog retrieval times, labels, and other mutable display data
 * are intentionally excluded from the confirmation identity.
 */
export function canonicalizeReviewedFamilyCandidateSetFingerprintInput(
  input: CandidateFingerprintInput,
): string {
  const taxonomy = reviewedFamilyPublicTaxonomyEvidenceSchema.parse(input.taxonomy);
  const familyId = familyIdentifierSchema.parse(input.familyId);
  const allowedBrands = input.allowedBrands === undefined
    ? undefined
    : canonicalReviewedFamilyAllowedBrandsSchema.parse(input.allowedBrands);
  const candidates = input.candidates.map((candidate) => {
    const product = exactProductPlanApiProductSummarySchema.parse(candidate.product);
    return {
      canonicalProductId: identifierSchema.parse(candidate.canonicalProductId),
      representativeGtin: product.gtin,
      brand: product.brand === undefined
        ? undefined
        : normalizeReviewedFamilyAllowedBrand(product.brand),
      packageMeasure: product.packageMeasure,
      unitsPerPack: product.unitsPerPack,
      membership: reviewedFamilyPublicMembershipEvidenceSchema.parse(candidate.membership),
    };
  }).sort((left, right) => compareText(left.canonicalProductId, right.canonicalProductId));
  if (!hasUniqueStrings(candidates.map(({ canonicalProductId }) => canonicalProductId))) {
    throw new Error("Candidate fingerprint products must be unique");
  }
  if (
    candidates.some(({ membership, canonicalProductId }) =>
      membership.familyId !== familyId
      || membership.canonicalProductId !== canonicalProductId
    )
  ) {
    throw new Error("Candidate fingerprint memberships must match their family products");
  }
  return stableJson({
    allowedBrands,
    candidates,
    familyId,
    taxonomy: {
      contentSha256: taxonomy.contentSha256,
      taxonomyId: taxonomy.taxonomyId,
      taxonomyVersion: taxonomy.taxonomyVersion,
      versionId: taxonomy.versionId,
    },
  });
}

export const reviewedFamilyCandidateConfirmationSchema = z
  .object({
    candidateSetId: reviewedFamilyCandidateSetIdSchema,
    taxonomyVersionId: reviewedFamilyTaxonomyVersionIdSchema,
    userApproved: z.literal(true),
  })
  .strict();

export const reviewedFamilyPlanApiMatchSchema = z
  .object({
    allowedBrands: reviewedFamilyAllowedBrandsInputSchema.optional(),
    confirmation: reviewedFamilyCandidateConfirmationSchema,
    familyId: familyIdentifierSchema,
    kind: z.literal("reviewed-family"),
  })
  .strict();

export const reviewedFamilyPlanApiNeedSchema = z
  .object({
    id: identifierSchema,
    match: reviewedFamilyPlanApiMatchSchema,
    quantity: positiveSafeIntegerSchema,
    quantityUnit: z.enum(["each", "g", "ml", "piece", "package"]),
    required: z.literal(true),
  })
  .strict();

export const reviewedFamilyPlanApiRequestV2Schema = z
  .object({
    contractVersion: reviewedFamilyContractVersionSchema,
    enabledMembershipProgramIds: enabledMembershipProgramIdsSchema,
    marketContext: marketContextV1Schema,
    maxStores: reviewedFamilyMaxStoresSchema,
    needs: z
      .array(z.union([exactProductPlanApiNeedSchema, reviewedFamilyPlanApiNeedSchema]))
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine(({ needs }, context) => {
    if (!hasUniqueStrings(needs.map(({ id }) => id))) {
      context.addIssue({
        code: "custom",
        message: "Reviewed-family plan need IDs must be unique",
        path: ["needs"],
      });
    }
    const familyNeeds = needs.filter(
      (need): need is z.infer<typeof reviewedFamilyPlanApiNeedSchema> =>
        need.match.kind === "reviewed-family",
    );
    if (familyNeeds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Contract v2 is reserved for plans containing a reviewed-family need",
        path: ["needs"],
      });
    }

    const selectionByCandidateSet = new Map<string, string>();
    const candidateSetBySelection = new Map<string, string>();
    for (const [index, need] of familyNeeds.entries()) {
      const selection = JSON.stringify({
        allowedBrands: need.match.allowedBrands,
        familyId: need.match.familyId,
        taxonomyVersionId: need.match.confirmation.taxonomyVersionId,
      });
      const candidateSetId = need.match.confirmation.candidateSetId;
      const priorSelection = selectionByCandidateSet.get(candidateSetId);
      const priorCandidateSet = candidateSetBySelection.get(selection);
      if (
        (priorSelection !== undefined && priorSelection !== selection)
        || (priorCandidateSet !== undefined && priorCandidateSet !== candidateSetId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate confirmations must bind one family, brand filter, and taxonomy",
          path: ["needs", index, "match", "confirmation"],
        });
      }
      selectionByCandidateSet.set(candidateSetId, selection);
      candidateSetBySelection.set(selection, candidateSetId);
    }
  });

export type ReviewedFamilyPlanApiRequestV2 = z.infer<
  typeof reviewedFamilyPlanApiRequestV2Schema
>;

const exactProductNeedMatchV2Schema = z
  .object({
    candidateProductIds: z.array(identifierSchema).length(1),
    kind: z.literal("exact-product"),
    needId: identifierSchema,
  })
  .strict();

const reviewedFamilyNeedMatchDetailsV2Schema = z
  .object({
    allowedBrands: canonicalReviewedFamilyAllowedBrandsSchema.optional(),
    candidateProductIds: z
      .array(identifierSchema)
      .min(1)
      .max(REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT),
    candidateSetId: reviewedFamilyCandidateSetIdSchema,
    family: reviewedFamilyDescriptorSchema,
    familyId: familyIdentifierSchema,
    kind: z.literal("reviewed-family"),
    needId: identifierSchema,
    taxonomyVersionId: reviewedFamilyTaxonomyVersionIdSchema,
  })
  .strict();

export const reviewedFamilyNeedMatchV2Schema = z.discriminatedUnion("kind", [
  exactProductNeedMatchV2Schema,
  reviewedFamilyNeedMatchDetailsV2Schema,
]);

export type ReviewedFamilyNeedMatchV2 = z.infer<
  typeof reviewedFamilyNeedMatchV2Schema
>;

export const reviewedFamilyCandidateCoverageSchema = z
  .object({
    canonicalProductId: identifierSchema,
    comparisonScope: comparisonScopeSchema,
    needId: identifierSchema,
  })
  .strict();

export const reviewedFamilyPlanApiEvidenceEnvelopeV2Schema = z
  .object({
    assignmentEvidence: z
      .array(exactProductPlanApiAssignmentEvidenceSchema)
      .max(350),
    candidateCoverage: z
      .array(reviewedFamilyCandidateCoverageSchema)
      .min(1)
      .max(2_500),
    excludedPriceEvidence: z.array(priceEvidenceSchema).max(150),
    memberships: z
      .array(reviewedFamilyPublicMembershipEvidenceSchema)
      .max(REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT),
    officialOffers: z.array(officialOfferSchema).max(350),
    ordinaryPrices: z.array(priceEvidenceSchema).max(150),
    sources: z.array(exactProductPlanApiEvidenceSourceSchema).min(1).max(100),
  })
  .strict()
  .superRefine((evidence, context) => {
    const idGroups = [
      ["ordinaryPrices", evidence.ordinaryPrices.map(({ id }) => id)],
      ["excludedPriceEvidence", evidence.excludedPriceEvidence.map(({ id }) => id)],
      ["officialOffers", evidence.officialOffers.map(({ id }) => id)],
    ] as const;
    for (const [path, ids] of idGroups) {
      if (!hasUniqueStrings(ids) || !sameStrings(ids, [...ids].sort(compareText))) {
        context.addIssue({
          code: "custom",
          message: "Evidence IDs must be unique and canonically ordered",
          path: [path],
        });
      }
    }
    if (
      evidence.ordinaryPrices.some(
        ({ priceKind, productMatch }) =>
          priceKind !== "ordinary" || productMatch.kind !== "exact",
      )
      || evidence.excludedPriceEvidence.some(
        ({ priceKind, productMatch }) =>
          priceKind !== "ordinary" || productMatch.kind !== "exact",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Reviewed-family planning accepts only exact ordinary price evidence",
        path: ["ordinaryPrices"],
      });
    }

    const coverageKeys = evidence.candidateCoverage.map(
      ({ needId, canonicalProductId }) => `${needId}\u0000${canonicalProductId}`,
    );
    if (
      !hasUniqueStrings(coverageKeys)
      || !sameStrings(coverageKeys, [...coverageKeys].sort(compareText))
    ) {
      context.addIssue({
        code: "custom",
        message: "Candidate coverage must be unique and canonically ordered",
        path: ["candidateCoverage"],
      });
    }
    const assignmentKeys = evidence.assignmentEvidence.map(
      ({ planId, needId, chainId }) => `${planId}\u0000${needId}\u0000${chainId}`,
    );
    if (
      !hasUniqueStrings(assignmentKeys)
      || !sameStrings(assignmentKeys, [...assignmentKeys].sort(compareText))
    ) {
      context.addIssue({
        code: "custom",
        message: "Assignment evidence must be unique and canonically ordered",
        path: ["assignmentEvidence"],
      });
    }
  });

export type ReviewedFamilyPlanApiEvidenceEnvelopeV2 = z.infer<
  typeof reviewedFamilyPlanApiEvidenceEnvelopeV2Schema
>;

export interface ReviewedFamilyPlanDeltaExplanationInputV1 {
  evidence: ReviewedFamilyPlanApiEvidenceEnvelopeV2;
  generatedAt: string;
  marketContext: ReviewedFamilyPlanApiRequestV2["marketContext"];
  plans: readonly PlanResultV2[];
  travelRoutes?: readonly TravelRouteEvidence[];
}

export function deriveReviewedFamilyPlanDeltaExplanationsV1(
  input: ReviewedFamilyPlanDeltaExplanationInputV1,
): PlanDeltaExplanationSetV1 | undefined {
  const assignmentEvidence = new Map(input.evidence.assignmentEvidence.map((entry) => [
    `${entry.planId}\u0000${entry.needId}\u0000${entry.chainId}`,
    entry,
  ]));
  const coverage = new Map(input.evidence.candidateCoverage.map((entry) => [
    `${entry.needId}\u0000${entry.canonicalProductId}`,
    entry,
  ]));
  const bindings = input.plans.flatMap((plan) => plan.assignments.map((assignment) => {
    const reference = assignmentEvidence.get(
      `${plan.id}\u0000${assignment.needId}\u0000${assignment.chain}`,
    );
    const candidateCoverage = coverage.get(
      `${assignment.needId}\u0000${assignment.canonicalProductId}`,
    );
    if (reference === undefined || candidateCoverage === undefined) return undefined;
    return {
      planId: plan.id,
      needId: assignment.needId,
      canonicalProductId: assignment.canonicalProductId,
      chainId: assignment.chain,
      evidenceId: reference.evidenceId,
      ...(reference.conditions.kind === "official-offer"
        ? { offerId: reference.conditions.offerId }
        : {}),
      comparisonScope: candidateCoverage.comparisonScope,
    };
  }));
  if (bindings.some((binding) => binding === undefined)) return undefined;
  return derivePlanDeltaExplanationsV1({
    plans: input.plans,
    generatedAt: input.generatedAt,
    marketContext: input.marketContext,
    assignmentEvidence: bindings.filter((binding) => binding !== undefined),
    ...(input.travelRoutes === undefined ? {} : { travelRoutes: input.travelRoutes }),
  });
}

export const reviewedFamilyPlanApiResponseV2Schema = z
  .object({
    caveats: z.array(nonEmptyStringSchema).max(10),
    contractVersion: reviewedFamilyContractVersionSchema,
    enabledMembershipProgramIds: enabledMembershipProgramIdsSchema,
    evidence: reviewedFamilyPlanApiEvidenceEnvelopeV2Schema,
    generatedAt: canonicalTimestampSchema,
    geographicDirectoryAttestation: geographicDirectoryRegionAttestationV1Schema.optional(),
    marketContext: marketContextV1Schema,
    needMatches: z.array(reviewedFamilyNeedMatchV2Schema).min(1).max(50),
    plans: z.array(planResultV2Schema).max(7),
    planDeltaExplanations: planDeltaExplanationSetV1Schema,
    priceDataSource: z.literal("cache"),
    productClaims: z
      .array(reviewedFamilyProductClaimSchema)
      .min(1)
      .max(REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT),
    taxonomy: reviewedFamilyPublicTaxonomyEvidenceSchema,
  })
  .strict();

export type ReviewedFamilyPlanApiResponseV2 = z.infer<
  typeof reviewedFamilyPlanApiResponseV2Schema
>;

function planAssignmentFingerprint(
  assignments: readonly z.infer<typeof planResultV2Schema>["assignments"][number][],
): string {
  return JSON.stringify(
    [...assignments].sort((left, right) =>
      compareText(left.needId, right.needId)
      || compareText(left.canonicalProductId, right.canonicalProductId)
      || compareText(left.ean, right.ean)
      || compareText(left.chain, right.chain)
    ),
  );
}

export function reviewedFamilyPlanApiResponseV2SchemaFor(
  request: unknown,
  options: { travelRoutes?: readonly TravelRouteEvidence[] } = {},
) {
  const parsedRequest = reviewedFamilyPlanApiRequestV2Schema.parse(request);
  const requestedNeeds = [...parsedRequest.needs].sort((left, right) =>
    compareText(left.id, right.id)
  );
  const requestedById = new Map(requestedNeeds.map((need) => [need.id, need]));

  return reviewedFamilyPlanApiResponseV2Schema.superRefine((response, context) => {
    if (!marketContextsEqual(response.marketContext, parsedRequest.marketContext)) {
      context.addIssue({
        code: "custom",
        message: "Reviewed-family planning output must preserve the requested market",
        path: ["marketContext"],
      });
    }
    if (!sameStrings(
      response.enabledMembershipProgramIds,
      parsedRequest.enabledMembershipProgramIds,
    )) {
      context.addIssue({
        code: "custom",
        message: "Reviewed-family output must preserve enabled membership programs",
        path: ["enabledMembershipProgramIds"],
      });
    }
    const expectedExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
      evidence: response.evidence,
      generatedAt: response.generatedAt,
      marketContext: response.marketContext,
      plans: response.plans,
      ...(options.travelRoutes === undefined ? {} : { travelRoutes: options.travelRoutes }),
    });
    if (
      expectedExplanations === undefined
      || JSON.stringify(response.planDeltaExplanations) !== JSON.stringify(expectedExplanations)
    ) {
      context.addIssue({
        code: "custom",
        message: "Plan explanations must re-derive from the same planning snapshot and evidence",
        path: ["planDeltaExplanations"],
      });
    }
    const marketLocation = marketContextToGeographicContext(parsedRequest.marketContext);
    const geographicDirectory = response.geographicDirectoryAttestation === undefined
      ? undefined
      : geographicDirectoryEvidenceFromRegionAttestationV1(
          response.geographicDirectoryAttestation,
          marketLocation,
          response.generatedAt,
        );
    if (
      response.geographicDirectoryAttestation !== undefined
      && geographicDirectory === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Directory attestation must bind the selected market and evaluation clock",
        path: ["geographicDirectoryAttestation"],
      });
    }
    const responseSourceIds = response.evidence.sources.map(({ id }) => id);
    for (const [priceIndex, price] of response.evidence.ordinaryPrices.entries()) {
      const eligible = parseEligiblePriceEvidence(price, {
        enabledSourceIds: responseSourceIds,
        ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
        location: marketLocation,
        maxAgeMs: EXACT_PRODUCT_PRICE_MAX_AGE_MS,
        now: new Date(response.generatedAt),
      });
      if (!eligible.eligible) {
        context.addIssue({
          code: "custom",
          message: "Visible ordinary prices must be eligible in the requested market",
          path: ["evidence", "ordinaryPrices", priceIndex],
        });
      }
    }
    validateTaxonomyTime(response.taxonomy, response.generatedAt, context);
    const matchNeedIds = response.needMatches.map(({ needId }) => needId);
    const requestedNeedIds = requestedNeeds.map(({ id }) => id);
    if (
      !hasUniqueStrings(matchNeedIds)
      || !sameStrings(matchNeedIds, requestedNeedIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "Need matches must exactly cover requested needs canonically",
        path: ["needMatches"],
      });
    }

    const matchByNeedId = new Map(
      response.needMatches.map((match) => [match.needId, match]),
    );
    const familyByCandidateId = new Map<string, string>();
    const candidatesBySetId = new Map<string, string>();
    const allCandidateIds: string[] = [];
    const expectedMembershipKeys = new Set<string>();
    for (const [index, match] of response.needMatches.entries()) {
      const requested = requestedById.get(match.needId);
      if (requested === undefined || requested.match.kind !== match.kind) {
        context.addIssue({
          code: "custom",
          message: "Need-match kinds must preserve the browser request",
          path: ["needMatches", index],
        });
        continue;
      }
      if (
        !hasUniqueStrings(match.candidateProductIds)
        || !sameStrings(
          match.candidateProductIds,
          [...match.candidateProductIds].sort(compareText),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Need candidates must be unique and canonically ordered",
          path: ["needMatches", index, "candidateProductIds"],
        });
      }
      allCandidateIds.push(...match.candidateProductIds);

      if (requested.match.kind === "reviewed-family" && match.kind === "reviewed-family") {
        if (
          requested.match.familyId !== match.familyId
          || match.family.id !== match.familyId
          || match.family.status !== "active"
          || requested.match.confirmation.candidateSetId !== match.candidateSetId
          || requested.match.confirmation.taxonomyVersionId !== match.taxonomyVersionId
          || match.taxonomyVersionId !== response.taxonomy.versionId
          || !arraysEqual(requested.match.allowedBrands, match.allowedBrands)
        ) {
          context.addIssue({
            code: "custom",
            message: "Family need matches must preserve the confirmed candidate snapshot",
            path: ["needMatches", index],
          });
        }
        const candidateFingerprint = JSON.stringify(match.candidateProductIds);
        const prior = candidatesBySetId.get(match.candidateSetId);
        if (prior !== undefined && prior !== candidateFingerprint) {
          context.addIssue({
            code: "custom",
            message: "One candidate-set ID cannot resolve to different products",
            path: ["needMatches", index, "candidateProductIds"],
          });
        }
        candidatesBySetId.set(match.candidateSetId, candidateFingerprint);
        for (const productId of match.candidateProductIds) {
          const priorFamily = familyByCandidateId.get(productId);
          if (priorFamily !== undefined && priorFamily !== match.familyId) {
            context.addIssue({
              code: "custom",
              message: "A product cannot ambiguously satisfy different requested families",
              path: ["needMatches", index, "candidateProductIds"],
            });
          }
          familyByCandidateId.set(productId, match.familyId);
          expectedMembershipKeys.add(candidateKey(match.familyId, productId));
        }
      }
    }

    const candidateUnion = canonicalStrings(allCandidateIds);
    if (candidateUnion.length > REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT) {
      context.addIssue({
        code: "custom",
        message: "The mixed-plan candidate union cannot exceed 50 products",
        path: ["needMatches"],
      });
    }
    const productById = validateCanonicalProductClaims(
      response.productClaims,
      candidateUnion,
      response.generatedAt,
      context,
    );
    validateMembershipSet(
      response.evidence.memberships,
      [...expectedMembershipKeys].sort(compareText),
      response.generatedAt,
      context,
    );

    for (const [index, match] of response.needMatches.entries()) {
      const requested = requestedById.get(match.needId);
      if (requested?.match.kind === "exact-product" && match.kind === "exact-product") {
        const product = productById.get(match.candidateProductIds[0]!);
        if (product?.product.gtin !== requested.match.product.value) {
          context.addIssue({
            code: "custom",
            message: "Exact need matches must resolve the requested GTIN",
            path: ["needMatches", index, "candidateProductIds"],
          });
        }
      } else if (
        requested?.match.kind === "reviewed-family"
        && match.kind === "reviewed-family"
        && match.allowedBrands !== undefined
      ) {
        for (const productId of match.candidateProductIds) {
          const brand = productById.get(productId)?.product.brand;
          if (
            brand === undefined
            || !match.allowedBrands.includes(normalizeReviewedFamilyAllowedBrand(brand))
          ) {
            context.addIssue({
              code: "custom",
              message: "Family need candidates must satisfy the confirmed brand filter",
              path: ["needMatches", index, "candidateProductIds"],
            });
          }
        }
      }
    }

    const ordinaryById = new Map(
      response.evidence.ordinaryPrices.map((evidence) => [evidence.id, evidence]),
    );
    const excludedById = new Map(
      response.evidence.excludedPriceEvidence.map((evidence) => [evidence.id, evidence]),
    );
    const officialOfferById = new Map(
      response.evidence.officialOffers.map((offer) => [offer.id, offer]),
    );
    const expectedOfferCells = new Set(response.evidence.ordinaryPrices.flatMap((price) =>
      price.productMatch.kind === "exact"
        ? [`${price.chainId}\u0000${price.productMatch.canonicalProductId}`]
        : []
    ));
    for (const [offerIndex, offer] of response.evidence.officialOffers.entries()) {
      const offerMemberships = offer.conditions.flatMap((condition) =>
        condition.kind === "member" ? [condition.programId] : []
      );
      const eligibility = parseApplicableOfficialOffer(offer, {
        channel: "in-store",
        enabledMembershipProgramIds: offerMemberships,
        enabledSourceIds: responseSourceIds,
        ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
        location: marketLocation,
        maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
        now: new Date(response.generatedAt),
      });
      if (
        !eligibility.applicable
        || offer.productMatch.kind !== "exact"
        || !expectedOfferCells.has(
          `${offer.chainId}\u0000${offer.productMatch.canonicalProductId}`,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Visible official offers must be current, in-market candidate evidence",
          path: ["evidence", "officialOffers", offerIndex],
        });
      }
    }
    const expectedCoverageKeys = response.needMatches.flatMap((match) =>
      match.candidateProductIds.map((productId) =>
        `${match.needId}\u0000${productId}`
      )
    ).sort(compareText);
    const coverageKeys = response.evidence.candidateCoverage.map(
      ({ needId, canonicalProductId }) => `${needId}\u0000${canonicalProductId}`,
    );
    if (!sameStrings(coverageKeys, expectedCoverageKeys)) {
      context.addIssue({
        code: "custom",
        message: "Coverage must explicitly describe every need candidate",
        path: ["evidence", "candidateCoverage"],
      });
    }

    const referencedOrdinaryIds = new Set<string>();
    const referencedExcludedIds = new Set<string>();
    const referencedKnownNotCarriedSourceIds = new Set<string>();
    for (const [index, coverage] of response.evidence.candidateCoverage.entries()) {
      if (
        !sameStrings(coverage.comparisonScope.expectedChainIds, EXPECTED_CHAIN_IDS)
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate coverage must declare all three supported chains",
          path: ["evidence", "candidateCoverage", index, "comparisonScope"],
        });
      }
      for (const scopeEntry of coverage.comparisonScope.entries) {
        if (scopeEntry.status.kind === "known-not-carried") {
          referencedKnownNotCarriedSourceIds.add(scopeEntry.status.sourceId);
        }
        const excludedEvidenceId =
          (scopeEntry.status.kind === "stale" || scopeEntry.status.kind === "ineligible")
            ? scopeEntry.status.evidenceId
            : undefined;
        const evidence = scopeEntry.status.kind === "priced"
          ? ordinaryById.get(scopeEntry.status.evidenceId)
          : excludedEvidenceId !== undefined
            ? excludedById.get(excludedEvidenceId)
            : undefined;
        if (scopeEntry.status.kind === "priced") {
          referencedOrdinaryIds.add(scopeEntry.status.evidenceId);
        } else if (
          scopeEntry.status.kind === "stale"
          || scopeEntry.status.kind === "ineligible"
        ) {
          if (scopeEntry.status.evidenceId !== undefined) {
            referencedExcludedIds.add(scopeEntry.status.evidenceId);
          }
        }
        if (
          evidence !== undefined
          && (
            evidence.chainId !== scopeEntry.chainId
            || evidence.productMatch.kind !== "exact"
            || evidence.productMatch.canonicalProductId !== coverage.canonicalProductId
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Coverage evidence must match its exact product and chain",
            path: ["evidence", "candidateCoverage", index, "comparisonScope"],
          });
        }
        if (
          (scopeEntry.status.kind === "priced"
            || scopeEntry.status.kind === "stale"
            || (scopeEntry.status.kind === "ineligible"
              && scopeEntry.status.evidenceId !== undefined))
          && evidence === undefined
        ) {
          context.addIssue({
            code: "custom",
            message: "Every resolved coverage cell requires visible price evidence",
            path: ["evidence", "candidateCoverage", index, "comparisonScope"],
          });
        }
      }
    }
    if (
      !sameStrings(
        [...referencedOrdinaryIds].sort(compareText),
        [...ordinaryById.keys()].sort(compareText),
      )
      || !sameStrings(
        [...referencedExcludedIds].sort(compareText),
        [...excludedById.keys()].sort(compareText),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Visible price evidence must be referenced by candidate coverage",
        path: ["evidence"],
      });
    }

    const plans = response.plans;
    if (
      !hasUniqueStrings(plans.map(({ id }) => id))
      || !hasUniqueStrings(plans.map(({ assignments }) =>
        planAssignmentFingerprint(assignments)
      ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Plans and assignment sets must be unique",
        path: ["plans"],
      });
    }
    const travelEvidence = options.travelRoutes?.map(({ planId, aggregate }) => ({
      planId,
      travel: {
        contractVersion: 1 as const,
        kind: "calculated" as const,
        durationSeconds: aggregate.durationSeconds,
        distanceMeters: aggregate.distanceMeters,
        providerSourceId: aggregate.providerSourceId,
        calculatedAt: aggregate.calculatedAt,
        routeFingerprint: aggregate.routeFingerprint,
      },
    }));
    const projectedPlans = canonicalProjectedPlanResultsV2(plans, 7, travelEvidence);
    if (
      projectedPlans === undefined
      || projectedPlans.length !== plans.length
      || plans.some((plan, index) =>
        JSON.stringify(plan) !== JSON.stringify(projectedPlans[index])
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Plans must be the canonical non-dominated representative frontier",
        path: ["plans"],
      });
    }

    const assignmentByKey = new Map<string, z.infer<typeof planResultV2Schema>["assignments"][number]>();
    const familyNeedIds = requestedNeeds
      .filter(({ match }) => match.kind === "reviewed-family")
      .map(({ id }) => id)
      .sort(compareText);
    for (const [planIndex, plan] of plans.entries()) {
      const assignedNeedIds = plan.assignments.map(({ needId }) => needId).sort(compareText);
      if (!sameStrings(assignedNeedIds, requestedNeedIds)) {
        context.addIssue({
          code: "custom",
          message: "Every plan must assign the complete requested basket exactly once",
          path: ["plans", planIndex, "assignments"],
        });
      }
      if (plan.chains.length > parsedRequest.maxStores) {
        context.addIssue({
          code: "custom",
          message: "A plan cannot exceed the requested store limit",
          path: ["plans", planIndex, "chains"],
        });
      }
      if (!sameStrings([...plan.substitutions].sort(compareText), familyNeedIds)) {
        context.addIssue({
          code: "custom",
          message: "Every reviewed-family choice must remain visible as a substitution",
          path: ["plans", planIndex, "substitutions"],
        });
      }

      for (const [assignmentIndex, assignment] of plan.assignments.entries()) {
        const requested = requestedById.get(assignment.needId);
        const match = matchByNeedId.get(assignment.needId);
        const claim = productById.get(assignment.canonicalProductId);
        const expectedUnit = requested?.quantityUnit === "each"
          ? "package"
          : requested?.quantityUnit;
        if (
          requested === undefined
          || match === undefined
          || !match.candidateProductIds.includes(assignment.canonicalProductId)
          || claim?.product.gtin !== assignment.ean
          || assignment.fulfilment.requested.amount !== requested.quantity
          || assignment.fulfilment.requested.unit !== expectedUnit
        ) {
          context.addIssue({
            code: "custom",
            message: "Assignments must preserve quantity and stay inside their admitted candidates",
            path: ["plans", planIndex, "assignments", assignmentIndex],
          });
        }
        const key = `${plan.id}\u0000${assignment.needId}\u0000${assignment.chain}`;
        if (assignmentByKey.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Plan assignment evidence keys must be unambiguous",
            path: ["plans", planIndex, "assignments", assignmentIndex],
          });
        }
        assignmentByKey.set(key, assignment);
      }
    }

    const evidenceByAssignmentKey = new Map(
      response.evidence.assignmentEvidence.map((reference) => [
        `${reference.planId}\u0000${reference.needId}\u0000${reference.chainId}`,
        reference,
      ]),
    );
    if (
      assignmentByKey.size !== evidenceByAssignmentKey.size
      || [...assignmentByKey.keys()].some((key) => !evidenceByAssignmentKey.has(key))
    ) {
      context.addIssue({
        code: "custom",
        message: "Every plan assignment requires exactly one evidence reference",
        path: ["evidence", "assignmentEvidence"],
      });
    }

    const referencedOfferIds = new Set<string>();
    for (const [key, reference] of evidenceByAssignmentKey) {
      const assignment = assignmentByKey.get(key);
      const ordinary = ordinaryById.get(reference.evidenceId);
      if (
        assignment === undefined
        || ordinary === undefined
        || ordinary.chainId !== reference.chainId
        || ordinary.sourceId !== assignment.source
        || ordinary.productMatch.kind !== "exact"
        || ordinary.productMatch.canonicalProductId !== assignment.canonicalProductId
        || ordinary.observedAt !== assignment.observedAt
        || BigInt(ordinary.amountOre) * BigInt(assignment.fulfilment.packageCount)
          !== BigInt(assignment.checkout.ordinaryTotalOre)
      ) {
        context.addIssue({
          code: "custom",
          message: "Assignments must reference same-product, same-chain ordinary evidence",
          path: ["evidence", "assignmentEvidence"],
        });
        continue;
      }
      if (reference.conditions.kind === "ordinary-price") {
        if (
          assignment.checkout.appliedOfferId !== undefined
          || assignment.officialOffer !== undefined
        ) {
          context.addIssue({
            code: "custom",
            message: "Ordinary assignments cannot claim an official offer",
            path: ["evidence", "assignmentEvidence"],
          });
        }
        continue;
      }

      const offer = officialOfferById.get(reference.conditions.offerId);
      if (offer !== undefined) referencedOfferIds.add(offer.id);
      const recalculated = offer === undefined
        ? undefined
        : calculateCheckoutCost({
            canonicalProductId: assignment.canonicalProductId,
            chainId: assignment.chain,
            packageCount: assignment.fulfilment.packageCount,
            ordinaryUnitPriceOre: ordinary.amountOre,
            offer,
            offerContext: {
              channel: "in-store",
              enabledMembershipProgramIds: parsedRequest.enabledMembershipProgramIds,
              enabledSourceIds: [offer.sourceId],
              ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
              location: marketLocation,
              maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
              now: new Date(response.generatedAt),
            },
          });
      if (
        offer === undefined
        || offer.chainId !== assignment.chain
        || offer.productMatch.kind !== "exact"
        || offer.productMatch.canonicalProductId !== assignment.canonicalProductId
        || offer.id !== assignment.checkout.appliedOfferId
        || offer.id !== assignment.officialOffer?.id
        || offer.sourceId !== assignment.officialOffer?.sourceId
        || offer.sourceRecordId !== assignment.officialOffer?.sourceRecordId
        || offer.capturedAt !== assignment.officialOffer?.capturedAt
        || recalculated === undefined
        || "state" in recalculated
        || recalculated.ordinaryTotalOre !== assignment.checkout.ordinaryTotalOre
        || recalculated.savingOre !== assignment.checkout.savingOre
        || recalculated.totalOre !== assignment.checkout.totalOre
      ) {
        context.addIssue({
          code: "custom",
          message: "Offer assignments must resolve and reproduce official offer arithmetic",
          path: ["evidence", "assignmentEvidence"],
        });
      }
    }
    if ([...referencedOfferIds].some((offerId) => !officialOfferById.has(offerId))) {
      context.addIssue({
        code: "custom",
        message: "Every applied official offer must be present in visible evidence",
        path: ["evidence", "officialOffers"],
      });
    }

    const referencedSourceIds = new Set<string>();
    response.productClaims.forEach(({ product }) =>
      referencedSourceIds.add(product.catalogEvidence.source.id)
    );
    response.evidence.ordinaryPrices.forEach(({ sourceId }) =>
      referencedSourceIds.add(sourceId)
    );
    response.evidence.excludedPriceEvidence.forEach(({ sourceId }) =>
      referencedSourceIds.add(sourceId)
    );
    response.evidence.officialOffers.forEach(({ sourceId }) =>
      referencedSourceIds.add(sourceId)
    );
    referencedKnownNotCarriedSourceIds.forEach((sourceId) =>
      referencedSourceIds.add(sourceId)
    );
    const sourceIds = response.evidence.sources.map(({ id }) => id);
    if (
      !hasUniqueStrings(sourceIds)
      || !sameStrings(sourceIds, [...sourceIds].sort(compareText))
      || !sameStrings(sourceIds, [...referencedSourceIds].sort(compareText))
    ) {
      context.addIssue({
        code: "custom",
        message: "Public sources must exactly cover every visible evidence claim",
        path: ["evidence", "sources"],
      });
    }
    const sourceById = new Map(
      response.evidence.sources.map((source) => [source.id, source]),
    );
    for (const [index, claim] of response.productClaims.entries()) {
      const embedded = claim.product.catalogEvidence.source;
      if (JSON.stringify(sourceById.get(embedded.id)) !== JSON.stringify(embedded)) {
        context.addIssue({
          code: "custom",
          message: "Product claims must embed their exact declared public source",
          path: ["productClaims", index, "product", "catalogEvidence", "source"],
        });
      }
    }
    for (const [index, evidence] of [
      ...response.evidence.ordinaryPrices,
      ...response.evidence.excludedPriceEvidence,
    ].entries()) {
      if (!sourceById.has(evidence.sourceId)) {
        context.addIssue({
          code: "custom",
          message: "Price evidence must resolve to a public source descriptor",
          path: ["evidence", "ordinaryPrices", index],
        });
      }
    }
  });
}
