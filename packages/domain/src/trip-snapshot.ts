import { z } from "zod";

import { gtinSchema, packageMeasureSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";
import {
  parseEligiblePriceEvidence,
  priceEvidenceSchema,
} from "./evidence";
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
import { enabledMembershipProgramIdsSchema, officialOfferSchema } from "./offers";
import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  exactProductPlanApiAssignmentEvidenceSchema,
  exactProductPlanApiProductSummarySchema,
} from "./plan-api-contracts";
import { planResultV2Schema } from "./planner-v2-contracts";
import {
  reviewedFamilyNeedMatchV2Schema,
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyProductClaimSchema,
  reviewedFamilyPublicMembershipEvidenceSchema,
  reviewedFamilyPublicTaxonomyEvidenceSchema,
} from "./reviewed-family-plan-api-contracts";
import { travelModeSchema } from "./travel-contracts";

const chainSchema = z.enum(["bunnpris", "extra", "rema-1000"]);
const checklistItemIdSchema = z.string().trim().min(1).max(300);
const CURRENT_PRICE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;
const measureUnitSchema = z.enum(["g", "ml", "piece", "package"]);
const nonNegativeMeasureSchema = z
  .object({
    amount: nonNegativeSafeIntegerSchema,
    unit: measureUnitSchema,
  })
  .strict();

export const tripChecklistItemV1Schema = z
  .object({
    id: checklistItemIdSchema,
    needId: identifierSchema,
    canonicalProductId: identifierSchema,
    gtin: gtinSchema,
    chainId: chainSchema,
    label: nonEmptyStringSchema,
  })
  .strict();

const priceOnlyStopSchema = z
  .object({
    kind: z.literal("chain-stop"),
    chainId: chainSchema,
    name: nonEmptyStringSchema,
  })
  .strict();

const priceOnlyNavigationSchema = z
  .object({
    kind: z.literal("price-only"),
    stops: z.array(priceOnlyStopSchema).min(1).max(3),
  })
  .strict();

export const tripPublicBranchStopV1Schema = z
  .object({
    kind: z.literal("branch-stop"),
    branchId: identifierSchema,
    chainId: chainSchema,
    name: nonEmptyStringSchema,
    sequence: positiveSafeIntegerSchema.max(3),
  })
  .strict();

export const tripRouteAggregateV1Schema = z
  .object({
    calculatedAt: canonicalTimestampSchema,
    distanceMeters: nonNegativeSafeIntegerSchema,
    durationSeconds: nonNegativeSafeIntegerSchema,
    // Optional only so active snapshots created before transport-mode binding
    // remain readable. Every newly copied calculated route includes the mode.
    mode: travelModeSchema.optional(),
    sourceId: sourceIdSchema,
    sourceRecordId: identifierSchema,
  })
  .strict();

const routedNavigationSchema = z
  .object({
    kind: z.literal("route"),
    aggregate: tripRouteAggregateV1Schema,
    stops: z.array(tripPublicBranchStopV1Schema).min(1).max(3),
  })
  .strict();

export const tripNavigationV1Schema = z.discriminatedUnion("kind", [
  priceOnlyNavigationSchema,
  routedNavigationSchema,
]);

export const tripPurchaseTermsV2Schema = z
  .object({
    requested: packageMeasureSchema,
    packageMeasure: packageMeasureSchema,
    packageCount: positiveSafeIntegerSchema,
    purchased: packageMeasureSchema,
    surplus: nonNegativeMeasureSchema,
    ordinaryTotalOre: moneyOreSchema,
    checkoutTotalOre: moneyOreSchema,
    savedOre: moneyOreSchema,
    observedAt: canonicalTimestampSchema,
    freshness: z.literal("eligible"),
    ordinaryPrice: priceEvidenceSchema,
    appliedOffer: officialOfferSchema.optional(),
  })
  .strict();

export const tripChecklistItemV2Schema = tripChecklistItemV1Schema
  .extend({ purchase: tripPurchaseTermsV2Schema })
  .strict();

export const tripRouteAggregateV2Schema = tripRouteAggregateV1Schema
  .extend({ mode: travelModeSchema })
  .strict();

const routedNavigationV2Schema = routedNavigationSchema
  .extend({ aggregate: tripRouteAggregateV2Schema })
  .strict();

export const tripNavigationV2Schema = z.discriminatedUnion("kind", [
  priceOnlyNavigationSchema,
  routedNavigationV2Schema,
]);

/**
 * The deliberately small, public-only projection that lets an offline trip
 * prove why a reviewed-family assignment was eligible. It excludes candidate
 * prices, rejected evidence, reviewer identity, browser labels/searches and
 * every route-origin field. Product claims and memberships are limited to the
 * products actually selected by the immutable plan; the confirmed need match
 * keeps the candidate IDs required to prove that selection belonged to the
 * approved candidate set.
 */
export const tripReviewedFamilyEvidenceV2Schema = z
  .object({
    assignmentEvidence: z.array(exactProductPlanApiAssignmentEvidenceSchema).min(1).max(50),
    memberships: z.array(reviewedFamilyPublicMembershipEvidenceSchema).max(50),
    needMatches: z.array(reviewedFamilyNeedMatchV2Schema).min(1).max(50),
    officialOffers: z.array(officialOfferSchema).max(50),
    ordinaryPrices: z.array(priceEvidenceSchema).min(1).max(50),
    productClaims: z.array(reviewedFamilyProductClaimSchema).min(1).max(50),
    request: reviewedFamilyPlanApiRequestV2Schema,
    taxonomy: reviewedFamilyPublicTaxonomyEvidenceSchema,
  })
  .strict();

type TripSnapshotCore = {
  caveats: string[];
  checklistItems: Array<z.output<typeof tripChecklistItemV1Schema>>;
  createdAt: string;
  evaluatedAt: string;
  expiresAt: string;
  navigation: z.output<typeof tripNavigationV1Schema> | z.output<typeof tripNavigationV2Schema>;
  plan: z.output<typeof planResultV2Schema>;
  products: Array<z.output<typeof exactProductPlanApiProductSummarySchema>>;
};

function refineTripSnapshotCore(snapshot: TripSnapshotCore, context: z.RefinementCtx): void {
    const evaluatedAt = Date.parse(snapshot.evaluatedAt);
    const createdAt = Date.parse(snapshot.createdAt);
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (createdAt < evaluatedAt) {
      context.addIssue({
        code: "custom",
        message: "A trip cannot be created before its plan was evaluated",
        path: ["createdAt"],
      });
    }
    if (expiresAt <= evaluatedAt || expiresAt <= createdAt) {
      context.addIssue({
        code: "custom",
        message: "A trip expiry must follow its evaluation and creation",
        path: ["expiresAt"],
      });
    }
    if (!hasUniqueStrings(snapshot.caveats)) {
      context.addIssue({
        code: "custom",
        message: "Trip caveats must be unique",
        path: ["caveats"],
      });
    }

    const productGtins = snapshot.products.map(({ gtin }) => gtin);
    if (!hasUniqueStrings(productGtins)) {
      context.addIssue({
        code: "custom",
        message: "Trip products must be unique by GTIN",
        path: ["products"],
      });
    }
    const productByGtin = new Map(snapshot.products.map((product) => [product.gtin, product]));
    const assignmentByNeed = new Map(
      snapshot.plan.assignments.map((assignment) => [assignment.needId, assignment]),
    );
    const assignedGtins = [...new Set(snapshot.plan.assignments.map(({ ean }) => ean))].sort();
    if (
      productGtins.length !== assignedGtins.length
      || [...productGtins].sort().some((gtin, index) => gtin !== assignedGtins[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Trip products must exactly cover the immutable plan assignments",
        path: ["products"],
      });
    }

    const checklistIds = snapshot.checklistItems.map(({ id }) => id);
    const checklistNeedIds = snapshot.checklistItems.map(({ needId }) => needId);
    if (!hasUniqueStrings(checklistIds) || !hasUniqueStrings(checklistNeedIds)) {
      context.addIssue({
        code: "custom",
        message: "Checklist IDs and need references must be unique",
        path: ["checklistItems"],
      });
    }
    if (
      snapshot.checklistItems.length !== snapshot.plan.assignments.length
      || snapshot.checklistItems.some((item) => {
        const assignment = assignmentByNeed.get(item.needId);
        const product = productByGtin.get(item.gtin);
        return assignment === undefined
          || product === undefined
          || item.canonicalProductId !== assignment.canonicalProductId
          || item.gtin !== assignment.ean
          || item.chainId !== assignment.chain
          || item.label !== product.displayName;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Checklist items must exactly mirror the immutable plan",
        path: ["checklistItems"],
      });
    }

    const planChains = [...snapshot.plan.chains].sort();
    const stopChains = snapshot.navigation.stops.map(({ chainId }) => chainId);
    if (
      !hasUniqueStrings(stopChains)
      || stopChains.length !== planChains.length
      || [...stopChains].sort().some((chain, index) => chain !== planChains[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Trip stops must exactly cover the plan chains",
        path: ["navigation", "stops"],
      });
    }
    if (snapshot.navigation.kind === "route") {
      if (snapshot.navigation.aggregate.calculatedAt !== snapshot.evaluatedAt) {
        context.addIssue({
          code: "custom",
          message: "A trip route must use the immutable plan evaluation time",
          path: ["navigation", "aggregate", "calculatedAt"],
        });
      }
      const branchIds = snapshot.navigation.stops.map(({ branchId }) => branchId);
      const sequences = snapshot.navigation.stops.map(({ sequence }) => sequence);
      if (
        !hasUniqueStrings(branchIds)
        || sequences.some((sequence, index) => sequence !== index + 1)
      ) {
        context.addIssue({
          code: "custom",
          message: "Route stops require unique branches in contiguous public order",
          path: ["navigation", "stops"],
        });
      }
    }
}

const tripSnapshotV1ObjectSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("trip-snapshot"),
    id: identifierSchema,
    createdAt: canonicalTimestampSchema,
    evaluatedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
    caveats: z.array(nonEmptyStringSchema).max(10),
    plan: planResultV2Schema,
    products: z.array(exactProductPlanApiProductSummarySchema).min(1).max(50),
    checklistItems: z.array(tripChecklistItemV1Schema).min(1).max(50),
    navigation: tripNavigationV1Schema,
  })
  .strict();

export const tripSnapshotV1Schema = tripSnapshotV1ObjectSchema
  .superRefine(refineTripSnapshotCore);

function sameMeasure(
  left: z.output<typeof nonNegativeMeasureSchema>,
  right: z.output<typeof nonNegativeMeasureSchema>,
): boolean {
  return left.amount === right.amount && left.unit === right.unit;
}

function addPurchaseIssue(
  context: z.RefinementCtx,
  index: number,
  message: string,
  path: Array<string | number> = [],
): void {
  context.addIssue({
    code: "custom",
    message,
    path: ["checklistItems", index, "purchase", ...path],
  });
}

const tripSnapshotV2ObjectSchema = z
  .object({
    contractVersion: z.literal(2),
    kind: z.literal("trip-snapshot"),
    id: identifierSchema,
    createdAt: canonicalTimestampSchema,
    evaluatedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
    enabledMembershipProgramIds: enabledMembershipProgramIdsSchema.default([]),
    geographicDirectoryAttestation: geographicDirectoryRegionAttestationV1Schema.optional(),
    marketContext: marketContextV1Schema,
    caveats: z.array(nonEmptyStringSchema).max(10),
    plan: planResultV2Schema,
    products: z.array(exactProductPlanApiProductSummarySchema).min(1).max(50),
    checklistItems: z.array(tripChecklistItemV2Schema).min(1).max(50),
    navigation: tripNavigationV2Schema,
    reviewedFamilyEvidence: tripReviewedFamilyEvidenceV2Schema.optional(),
  })
  .strict();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameParsedJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reviewedMembershipKey(familyId: string, canonicalProductId: string): string {
  return `${familyId}\u0000${canonicalProductId}`;
}

function addReviewedIssue(
  context: z.RefinementCtx,
  message: string,
  path: Array<string | number> = [],
): void {
  context.addIssue({
    code: "custom",
    message,
    path: ["reviewedFamilyEvidence", ...path],
  });
}

function refineReviewedFamilyEvidence(
  snapshot: z.output<typeof tripSnapshotV2ObjectSchema>,
  context: z.RefinementCtx,
): void {
  const evidence = snapshot.reviewedFamilyEvidence;
  if (evidence === undefined) return;

  if (!marketContextsEqual(evidence.request.marketContext, snapshot.marketContext)) {
    addReviewedIssue(
      context,
      "Reviewed request market must match the immutable trip market",
      ["request", "marketContext"],
    );
  }
  if (!sameStrings(
    evidence.request.enabledMembershipProgramIds,
    snapshot.enabledMembershipProgramIds,
  )) {
    addReviewedIssue(
      context,
      "Reviewed request membership programs must match the immutable trip preference",
      ["request", "enabledMembershipProgramIds"],
    );
  }

  const assignmentsByNeed = new Map(
    snapshot.plan.assignments.map((assignment) => [assignment.needId, assignment]),
  );
  const requestByNeed = new Map(evidence.request.needs.map((need) => [need.id, need]));
  const matchByNeed = new Map(evidence.needMatches.map((match) => [match.needId, match]));
  const assignmentNeedIds = [...assignmentsByNeed.keys()].sort(compareText);
  const requestNeedIds = [...requestByNeed.keys()].sort(compareText);
  const rawMatchNeedIds = evidence.needMatches.map(({ needId }) => needId);
  const matchNeedIds = [...matchByNeed.keys()].sort(compareText);
  if (
    !sameStrings(assignmentNeedIds, requestNeedIds)
    || !sameStrings(assignmentNeedIds, matchNeedIds)
    || !hasUniqueStrings(rawMatchNeedIds)
    || !sameStrings(rawMatchNeedIds, matchNeedIds)
  ) {
    addReviewedIssue(
      context,
      "Reviewed request and need matches must exactly cover the immutable plan",
      ["needMatches"],
    );
  }
  if (
    snapshot.plan.chains.length > evidence.request.maxStores
    || snapshot.plan.chains.length > 3
  ) {
    addReviewedIssue(
      context,
      "A reviewed-family trip cannot exceed its confirmed store limit",
      ["request", "maxStores"],
    );
  }

  const claimsByCanonicalId = new Map(
    evidence.productClaims.map((claim) => [claim.canonicalProductId, claim]),
  );
  const expectedClaimIds = [...new Set(
    snapshot.plan.assignments.map(({ canonicalProductId }) => canonicalProductId),
  )].sort(compareText);
  const claimIds = evidence.productClaims.map(({ canonicalProductId }) => canonicalProductId);
  if (
    !hasUniqueStrings(claimIds)
    || !sameStrings(claimIds, expectedClaimIds)
  ) {
    addReviewedIssue(
      context,
      "Reviewed product claims must canonically and exactly cover selected products",
      ["productClaims"],
    );
  }
  const productsByGtin = new Map(snapshot.products.map((product) => [product.gtin, product]));
  for (const [index, claim] of evidence.productClaims.entries()) {
    const product = productsByGtin.get(claim.product.gtin);
    if (product === undefined || !sameParsedJson(product, claim.product)) {
      addReviewedIssue(
        context,
        "Reviewed product claims must exactly reproduce the trip product projection",
        ["productClaims", index],
      );
    }
  }

  const expectedMembershipKeys = new Set<string>();
  const reviewedNeedIds: string[] = [];
  for (const [index, assignment] of snapshot.plan.assignments.entries()) {
    const requested = requestByNeed.get(assignment.needId);
    const match = matchByNeed.get(assignment.needId);
    const claim = claimsByCanonicalId.get(assignment.canonicalProductId);
    const expectedRequestedUnit = requested?.quantityUnit === "each"
      ? "package"
      : requested?.quantityUnit;
    if (
      requested === undefined
      || match === undefined
      || claim === undefined
      || claim.product.gtin !== assignment.ean
      || requested.required !== true
      || requested.quantity !== assignment.fulfilment.requested.amount
      || expectedRequestedUnit !== assignment.fulfilment.requested.unit
      || !match.candidateProductIds.includes(assignment.canonicalProductId)
    ) {
      addReviewedIssue(
        context,
        "Reviewed assignments must preserve the confirmed request, product and quantity",
        ["needMatches", index],
      );
      continue;
    }
    if (
      !hasUniqueStrings(match.candidateProductIds)
      || !sameStrings(
        match.candidateProductIds,
        [...match.candidateProductIds].sort(compareText),
      )
    ) {
      addReviewedIssue(
        context,
        "Reviewed candidate identities must be unique and canonically ordered",
        ["needMatches", index, "candidateProductIds"],
      );
    }

    if (requested.match.kind === "exact-product" && match.kind === "exact-product") {
      if (
        match.candidateProductIds.length !== 1
        || requested.match.product.value !== assignment.ean
      ) {
        addReviewedIssue(
          context,
          "Exact needs in a mixed trip must preserve their approved GTIN",
          ["needMatches", index],
        );
      }
      continue;
    }

    if (requested.match.kind !== "reviewed-family" || match.kind !== "reviewed-family") {
      addReviewedIssue(
        context,
        "Reviewed need-match kinds must preserve the confirmed request",
        ["needMatches", index],
      );
      continue;
    }
    reviewedNeedIds.push(assignment.needId);
    if (
      requested.match.familyId !== match.familyId
      || requested.match.confirmation.candidateSetId !== match.candidateSetId
      || requested.match.confirmation.taxonomyVersionId !== match.taxonomyVersionId
      || requested.match.confirmation.userApproved !== true
      || match.family.id !== match.familyId
      || match.family.status !== "active"
      || match.taxonomyVersionId !== evidence.taxonomy.versionId
      || !sameParsedJson(requested.match.allowedBrands, match.allowedBrands)
    ) {
      addReviewedIssue(
        context,
        "Reviewed selections must preserve the approved family confirmation",
        ["needMatches", index],
      );
    }
    expectedMembershipKeys.add(
      reviewedMembershipKey(match.familyId, assignment.canonicalProductId),
    );
  }

  if (!sameStrings([...snapshot.plan.substitutions].sort(compareText), reviewedNeedIds.sort(compareText))) {
    addReviewedIssue(
      context,
      "Every reviewed-family selection must remain visible as a substitution",
      ["needMatches"],
    );
  }

  const membershipKeys = evidence.memberships.map((membership) =>
    reviewedMembershipKey(membership.familyId, membership.canonicalProductId));
  if (
    !hasUniqueStrings(membershipKeys)
    || !sameStrings(membershipKeys, [...expectedMembershipKeys].sort(compareText))
  ) {
    addReviewedIssue(
      context,
      "Redacted membership evidence must exactly cover selected family products",
      ["memberships"],
    );
  }
  for (const [index, membership] of evidence.memberships.entries()) {
    if (Date.parse(membership.reviewedAt) > Date.parse(snapshot.evaluatedAt)) {
      addReviewedIssue(
        context,
        "Membership evidence cannot be reviewed after trip evaluation",
        ["memberships", index, "reviewedAt"],
      );
    }
  }
  if (Date.parse(evidence.taxonomy.publishedAt) > Date.parse(snapshot.evaluatedAt)) {
    addReviewedIssue(
      context,
      "Taxonomy evidence cannot be published after trip evaluation",
      ["taxonomy", "publishedAt"],
    );
  }

  const referenceKeys = evidence.assignmentEvidence.map((reference) =>
    `${reference.planId}\u0000${reference.needId}\u0000${reference.chainId}`);
  const expectedReferenceKeys = snapshot.plan.assignments.map((assignment) =>
    `${snapshot.plan.id}\u0000${assignment.needId}\u0000${assignment.chain}`)
    .sort(compareText);
  if (
    !hasUniqueStrings(referenceKeys)
    || !sameStrings(referenceKeys, expectedReferenceKeys)
  ) {
    addReviewedIssue(
      context,
      "Assignment evidence must exactly cover the selected immutable plan",
      ["assignmentEvidence"],
    );
  }

  const ordinaryById = new Map(evidence.ordinaryPrices.map((price) => [price.id, price]));
  const offerById = new Map(evidence.officialOffers.map((offer) => [offer.id, offer]));
  const checklistByNeed = new Map(snapshot.checklistItems.map((item) => [item.needId, item]));
  const referencedOrdinaryIds = new Set<string>();
  const referencedOfferIds = new Set<string>();
  for (const [index, reference] of evidence.assignmentEvidence.entries()) {
    const assignment = assignmentsByNeed.get(reference.needId);
    const purchase = checklistByNeed.get(reference.needId)?.purchase;
    const ordinary = ordinaryById.get(reference.evidenceId);
    if (
      assignment === undefined
      || purchase === undefined
      || reference.planId !== snapshot.plan.id
      || reference.chainId !== assignment.chain
      || ordinary === undefined
      || !sameParsedJson(ordinary, purchase.ordinaryPrice)
    ) {
      addReviewedIssue(
        context,
        "Reviewed assignment references must bind their selected ordinary evidence",
        ["assignmentEvidence", index],
      );
      continue;
    }
    referencedOrdinaryIds.add(ordinary.id);
    if (reference.conditions.kind === "ordinary-price") {
      if (purchase.appliedOffer !== undefined || assignment.checkout.appliedOfferId !== undefined) {
        addReviewedIssue(
          context,
          "An ordinary reviewed assignment cannot carry an applied offer",
          ["assignmentEvidence", index, "conditions"],
        );
      }
      continue;
    }
    const offer = offerById.get(reference.conditions.offerId);
    if (
      offer === undefined
      || purchase.appliedOffer === undefined
      || !sameParsedJson(offer, purchase.appliedOffer)
      || offer.id !== assignment.checkout.appliedOfferId
    ) {
      addReviewedIssue(
        context,
        "Reviewed offer references must bind the full applied public offer",
        ["assignmentEvidence", index, "conditions"],
      );
      continue;
    }
    referencedOfferIds.add(offer.id);
  }

  const ordinaryIds = evidence.ordinaryPrices.map(({ id }) => id);
  const offerIds = evidence.officialOffers.map(({ id }) => id);
  if (
    !hasUniqueStrings(ordinaryIds)
    || !sameStrings(ordinaryIds, [...referencedOrdinaryIds].sort(compareText))
  ) {
    addReviewedIssue(
      context,
      "Reviewed ordinary evidence must contain only selected assignment facts",
      ["ordinaryPrices"],
    );
  }
  if (
    !hasUniqueStrings(offerIds)
    || !sameStrings(offerIds, [...referencedOfferIds].sort(compareText))
  ) {
    addReviewedIssue(
      context,
      "Reviewed offer evidence must contain only selected applied offers",
      ["officialOffers"],
    );
  }
}

export const tripSnapshotV2Schema = tripSnapshotV2ObjectSchema
  .superRefine((snapshot, context) => {
    refineTripSnapshotCore(snapshot, context);
    if (
      snapshot.plan.substitutions.length > 0
      && snapshot.reviewedFamilyEvidence === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Reviewed substitutions require their redacted public evidence projection",
        path: ["reviewedFamilyEvidence"],
      });
    }
    refineReviewedFamilyEvidence(snapshot, context);

    const evaluatedAtMs = Date.parse(snapshot.evaluatedAt);
    const expiresAtMs = Date.parse(snapshot.expiresAt);
    const productByGtin = new Map(snapshot.products.map((product) => [product.gtin, product]));
    const assignmentByNeed = new Map(
      snapshot.plan.assignments.map((assignment) => [assignment.needId, assignment]),
    );
    const marketLocation = marketContextToGeographicContext(snapshot.marketContext);
    const geographicDirectory = snapshot.geographicDirectoryAttestation === undefined
      ? undefined
      : geographicDirectoryEvidenceFromRegionAttestationV1(
          snapshot.geographicDirectoryAttestation,
          marketLocation,
          snapshot.evaluatedAt,
        );
    if (
      snapshot.geographicDirectoryAttestation !== undefined
      && geographicDirectory === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Trip directory attestation must bind its market and evaluation clock",
        path: ["geographicDirectoryAttestation"],
      });
    }
    if (
      snapshot.geographicDirectoryAttestation?.validUntil !== undefined
      && expiresAtMs > Date.parse(snapshot.geographicDirectoryAttestation.validUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "Trip expiry cannot outlive its directory attestation",
        path: ["geographicDirectoryAttestation", "validUntil"],
      });
    }

    for (const product of snapshot.products) {
      const observedAtMs = Date.parse(product.catalogEvidence.observedAt);
      if (
        observedAtMs > evaluatedAtMs
        || evaluatedAtMs - observedAtMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS
        || expiresAtMs > observedAtMs + EXACT_PRODUCT_CATALOG_MAX_AGE_MS
      ) {
        context.addIssue({
          code: "custom",
          message: "Trip catalog evidence must remain current for the snapshot lifetime",
          path: ["products"],
        });
        break;
      }
    }

    for (const [index, item] of snapshot.checklistItems.entries()) {
      const assignment = assignmentByNeed.get(item.needId);
      const product = productByGtin.get(item.gtin);
      if (assignment === undefined || product === undefined) continue;

      const purchase = item.purchase;
      if (
        !sameMeasure(purchase.requested, assignment.fulfilment.requested)
        || !sameMeasure(purchase.packageMeasure, assignment.fulfilment.packageMeasure)
        || purchase.packageCount !== assignment.fulfilment.packageCount
        || !sameMeasure(purchase.purchased, assignment.fulfilment.purchased)
        || !sameMeasure(purchase.surplus, assignment.fulfilment.surplus)
      ) {
        addPurchaseIssue(
          context,
          index,
          "Purchase quantities must exactly mirror immutable plan fulfilment",
        );
      }
      if (
        purchase.ordinaryTotalOre !== assignment.checkout.ordinaryTotalOre
        || purchase.checkoutTotalOre !== assignment.checkout.totalOre
        || purchase.savedOre !== assignment.checkout.savingOre
      ) {
        addPurchaseIssue(
          context,
          index,
          "Purchase totals must exactly mirror the immutable plan checkout",
        );
      }
      if (
        purchase.observedAt !== assignment.observedAt
        || purchase.freshness !== snapshot.plan.freshness[item.needId]
      ) {
        addPurchaseIssue(
          context,
          index,
          "Purchase observation and freshness must exactly mirror the immutable plan",
        );
      }
      if (!sameMeasure(purchase.packageMeasure, product.packageMeasure)) {
        addPurchaseIssue(
          context,
          index,
          "Purchase package measure must match the selected catalog product",
          ["packageMeasure"],
        );
      }

      const ordinary = purchase.ordinaryPrice;
      const ordinaryEligibility = parseEligiblePriceEvidence(ordinary, {
        enabledSourceIds: [ordinary.sourceId],
        ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
        location: marketLocation,
        maxAgeMs: CURRENT_PRICE_MAX_AGE_MS,
        now: new Date(snapshot.evaluatedAt),
      });
      const ordinaryTotal = BigInt(ordinary.amountOre) * BigInt(purchase.packageCount);
      if (
        !ordinaryEligibility.eligible
        || ordinary.priceKind !== "ordinary"
        || ordinary.chainId !== assignment.chain
        || ordinary.sourceId !== assignment.source
        || ordinary.observedAt !== assignment.observedAt
        || ordinary.productMatch.kind !== "exact"
        || ordinary.productMatch.canonicalProductId !== assignment.canonicalProductId
        || ordinaryTotal !== BigInt(assignment.checkout.ordinaryTotalOre)
      ) {
        addPurchaseIssue(
          context,
          index,
          "Ordinary price evidence must be eligible and cross-bound to the assignment",
          ["ordinaryPrice"],
        );
      }
      const ordinaryObservedAtMs = Date.parse(ordinary.observedAt);
      if (
        expiresAtMs > ordinaryObservedAtMs + CURRENT_PRICE_MAX_AGE_MS
        || (ordinary.validUntil !== undefined && expiresAtMs > Date.parse(ordinary.validUntil))
      ) {
        addPurchaseIssue(
          context,
          index,
          "Trip expiry cannot outlive its ordinary price evidence",
          ["ordinaryPrice"],
        );
      }

      const expectedOfferId = assignment.checkout.appliedOfferId;
      if ((purchase.appliedOffer?.id) !== expectedOfferId) {
        addPurchaseIssue(
          context,
          index,
          "Applied offer evidence must exactly match the immutable plan checkout",
          ["appliedOffer"],
        );
        continue;
      }
      if (expectedOfferId === undefined) {
        if (assignment.officialOffer !== undefined) {
          addPurchaseIssue(
            context,
            index,
            "Ordinary checkout cannot carry an applied offer reference",
            ["appliedOffer"],
          );
        }
        continue;
      }

      const offer = purchase.appliedOffer;
      const offerReference = assignment.officialOffer;
      if (offer === undefined || offerReference === undefined) continue;
      const checkout = calculateCheckoutCost({
            canonicalProductId: assignment.canonicalProductId,
            chainId: assignment.chain,
            offer,
            offerContext: {
              channel: "in-store",
              enabledMembershipProgramIds: snapshot.enabledMembershipProgramIds,
              enabledSourceIds: [offer.sourceId],
              ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
              location: marketLocation,
              maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
              now: new Date(snapshot.evaluatedAt),
            },
            ordinaryUnitPriceOre: ordinary.amountOre,
            packageCount: assignment.fulfilment.packageCount,
          });
      if (
        "state" in checkout
        || checkout.appliedOfferId !== expectedOfferId
        || checkout.ordinaryTotalOre !== assignment.checkout.ordinaryTotalOre
        || checkout.totalOre !== assignment.checkout.totalOre
        || checkout.savingOre !== assignment.checkout.savingOre
        || offer.id !== offerReference.id
        || offer.sourceId !== offerReference.sourceId
        || offer.sourceRecordId !== offerReference.sourceRecordId
        || offer.capturedAt !== offerReference.capturedAt
        || !offer.applicability.channels.includes("in-store")
      ) {
        addPurchaseIssue(
          context,
          index,
          "Applied offer must be eligible for the saved membership preference and reproduce the immutable checkout",
          ["appliedOffer"],
        );
      }
      if (
        expiresAtMs > Date.parse(offer.applicability.endsAt)
        || expiresAtMs > Date.parse(offer.capturedAt) + EXACT_PRODUCT_OFFER_MAX_AGE_MS
      ) {
        addPurchaseIssue(
          context,
          index,
          "Trip expiry cannot outlive its applied offer evidence",
          ["appliedOffer"],
        );
      }
    }
  });

export const tripSnapshotSchema = z.union([
  tripSnapshotV1Schema,
  tripSnapshotV2Schema,
]);

export type TripSnapshotV1 = z.infer<typeof tripSnapshotV1Schema>;
export type TripSnapshotV2 = z.infer<typeof tripSnapshotV2Schema>;
export type TripSnapshot = z.infer<typeof tripSnapshotSchema>;
export type TripPurchaseTermsV2 = z.infer<typeof tripPurchaseTermsV2Schema>;
export type TripChecklistItemV1 = z.infer<typeof tripChecklistItemV1Schema>;
export type TripChecklistItemV2 = z.infer<typeof tripChecklistItemV2Schema>;
export type TripNavigationV1 = z.infer<typeof tripNavigationV1Schema>;
export type TripNavigationV2 = z.infer<typeof tripNavigationV2Schema>;
export type TripReviewedFamilyEvidenceV2 = z.infer<
  typeof tripReviewedFamilyEvidenceV2Schema
>;

type CreateTripNavigationV1 =
  | { kind: "price-only" }
  | z.input<typeof routedNavigationSchema>;

type CreateTripNavigationV2 =
  | { kind: "price-only" }
  | z.input<typeof routedNavigationV2Schema>;

export interface CreateTripSnapshotInput {
  id: string;
  createdAt: string;
  evaluatedAt: string;
  expiresAt: string;
  caveats: string[];
  plan: z.input<typeof planResultV2Schema>;
  products: Array<z.input<typeof exactProductPlanApiProductSummarySchema>>;
  navigation: CreateTripNavigationV1;
}

const tripPurchaseEvidenceV2InputSchema = z
  .object({
    needId: identifierSchema,
    ordinaryPrice: priceEvidenceSchema,
    appliedOffer: officialOfferSchema.optional(),
  })
  .strict();

export interface TripPurchaseEvidenceV2Input {
  needId: string;
  ordinaryPrice: z.input<typeof priceEvidenceSchema>;
  appliedOffer?: z.input<typeof officialOfferSchema>;
}

export interface CreateTripSnapshotV2Input {
  id: string;
  createdAt: string;
  evaluatedAt: string;
  expiresAt: string;
  enabledMembershipProgramIds: string[];
  geographicDirectoryAttestation?: z.input<
    typeof geographicDirectoryRegionAttestationV1Schema
  >;
  marketContext: z.input<typeof marketContextV1Schema>;
  caveats: string[];
  plan: z.input<typeof planResultV2Schema>;
  products: Array<z.input<typeof exactProductPlanApiProductSummarySchema>>;
  navigation: CreateTripNavigationV2;
  purchaseEvidence: TripPurchaseEvidenceV2Input[];
  reviewedFamilyEvidence?: z.input<typeof tripReviewedFamilyEvidenceV2Schema>;
}

const CHAIN_NAMES: Readonly<Record<z.infer<typeof chainSchema>, string>> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

function stableChecklistId(planId: string, needId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of `${planId}\u0000${needId}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `check:${hash.toString(16).padStart(16, "0")}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function createTripSnapshot(input: CreateTripSnapshotInput): TripSnapshotV1 {
  const parsedPlan = planResultV2Schema.parse(input.plan);
  const parsedProducts = z.array(exactProductPlanApiProductSummarySchema).parse(input.products);
  const productByGtin = new Map(parsedProducts.map((product) => [product.gtin, product]));
  const checklistItems = parsedPlan.assignments.map((assignment) => ({
    canonicalProductId: assignment.canonicalProductId,
    chainId: assignment.chain,
    gtin: assignment.ean,
    id: stableChecklistId(parsedPlan.id, assignment.needId),
    label: productByGtin.get(assignment.ean)?.displayName ?? "",
    needId: assignment.needId,
  }));
  const navigation = input.navigation.kind === "price-only"
    ? {
        kind: "price-only" as const,
        stops: [...parsedPlan.chains].sort().map((chainId) => ({
          chainId,
          kind: "chain-stop" as const,
          name: CHAIN_NAMES[chainId],
        })),
      }
    : input.navigation;
  return deepFreeze(tripSnapshotV1Schema.parse({
    caveats: input.caveats,
    checklistItems,
    contractVersion: 1,
    createdAt: input.createdAt,
    evaluatedAt: input.evaluatedAt,
    expiresAt: input.expiresAt,
    id: input.id,
    kind: "trip-snapshot",
    navigation,
    plan: parsedPlan,
    products: parsedProducts,
  }));
}

export function createTripSnapshotV2(input: CreateTripSnapshotV2Input): TripSnapshotV2 {
  const parsedPlan = planResultV2Schema.parse(input.plan);
  const parsedProducts = z.array(exactProductPlanApiProductSummarySchema).parse(input.products);
  const parsedPurchaseEvidence = z.array(tripPurchaseEvidenceV2InputSchema)
    .min(1)
    .max(50)
    .parse(input.purchaseEvidence);
  const evidenceNeedIds = parsedPurchaseEvidence.map(({ needId }) => needId);
  const assignedNeedIds = parsedPlan.assignments.map(({ needId }) => needId);
  if (
    !hasUniqueStrings(evidenceNeedIds)
    || evidenceNeedIds.length !== assignedNeedIds.length
    || assignedNeedIds.some((needId) => !evidenceNeedIds.includes(needId))
  ) {
    throw new Error("Purchase evidence must exactly cover the immutable plan assignments");
  }

  const productByGtin = new Map(parsedProducts.map((product) => [product.gtin, product]));
  const evidenceByNeed = new Map(parsedPurchaseEvidence.map((evidence) => [evidence.needId, evidence]));
  const checklistItems = parsedPlan.assignments.map((assignment) => {
    const evidence = evidenceByNeed.get(assignment.needId);
    return {
      canonicalProductId: assignment.canonicalProductId,
      chainId: assignment.chain,
      gtin: assignment.ean,
      id: stableChecklistId(parsedPlan.id, assignment.needId),
      label: productByGtin.get(assignment.ean)?.displayName ?? "",
      needId: assignment.needId,
      purchase: {
        appliedOffer: evidence?.appliedOffer,
        checkoutTotalOre: assignment.checkout.totalOre,
        freshness: parsedPlan.freshness[assignment.needId],
        observedAt: assignment.observedAt,
        ordinaryPrice: evidence?.ordinaryPrice,
        ordinaryTotalOre: assignment.checkout.ordinaryTotalOre,
        packageCount: assignment.fulfilment.packageCount,
        packageMeasure: assignment.fulfilment.packageMeasure,
        purchased: assignment.fulfilment.purchased,
        requested: assignment.fulfilment.requested,
        savedOre: assignment.checkout.savingOre,
        surplus: assignment.fulfilment.surplus,
      },
    };
  });
  const navigation = input.navigation.kind === "price-only"
    ? {
        kind: "price-only" as const,
        stops: [...parsedPlan.chains].sort().map((chainId) => ({
          chainId,
          kind: "chain-stop" as const,
          name: CHAIN_NAMES[chainId],
        })),
      }
    : input.navigation;

  return deepFreeze(tripSnapshotV2Schema.parse({
    caveats: input.caveats,
    checklistItems,
    contractVersion: 2,
    createdAt: input.createdAt,
    evaluatedAt: input.evaluatedAt,
    expiresAt: input.expiresAt,
    enabledMembershipProgramIds: input.enabledMembershipProgramIds,
    ...(input.geographicDirectoryAttestation === undefined
      ? {}
      : { geographicDirectoryAttestation: input.geographicDirectoryAttestation }),
    id: input.id,
    kind: "trip-snapshot",
    marketContext: input.marketContext,
    navigation,
    plan: parsedPlan,
    products: parsedProducts,
    reviewedFamilyEvidence: input.reviewedFamilyEvidence,
  }));
}
