import { z } from "zod";

import { gtinSchema, packageMeasureSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { comparisonScopeSchema } from "./coverage";
import { parseEligiblePriceEvidence, priceEvidenceSchema } from "./evidence";
import { calculateCheckoutCost } from "./fulfilment";
import {
  geographicDirectoryEvidenceFromRegionAttestationV1,
  geographicDirectoryRegionAttestationV1Schema,
} from "./geography";
import {
  geographicScopeFingerprint,
  historicalComparisonMatchesEvidence,
  historicalComparisonSchema,
} from "./history";
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
import { canonicalProjectedPlanResultsV2 } from "./frontier-v2";
import { planResultV2Schema, type PlanResultV2 } from "./planner-v2-contracts";
import type { TravelRouteEvidence } from "./travel-contracts";

const maxStoresSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const exactProductIdentitySchema = z
  .object({
    kind: z.literal("gtin"),
    value: gtinSchema,
  })
  .strict();

export const exactProductPlanApiMatchSchema = z
  .object({
    kind: z.literal("exact-product"),
    product: exactProductIdentitySchema,
    userApproved: z.literal(true),
  })
  .strict();

export type ExactProductPlanApiMatch = z.infer<typeof exactProductPlanApiMatchSchema>;

export const exactProductPlanApiNeedSchema = z
  .object({
    id: identifierSchema,
    match: exactProductPlanApiMatchSchema,
    quantity: positiveSafeIntegerSchema,
    quantityUnit: z.enum(["each", "g", "ml", "piece", "package"]),
    required: z.literal(true),
  })
  .strict();

export type ExactProductPlanApiNeed = z.infer<typeof exactProductPlanApiNeedSchema>;

export const exactProductPlanApiRequestSchema = z
  .object({
    contractVersion: contractVersionSchema,
    enabledMembershipProgramIds: enabledMembershipProgramIdsSchema,
    marketContext: marketContextV1Schema,
    maxStores: maxStoresSchema,
    needs: z.array(exactProductPlanApiNeedSchema).min(1).max(50),
  })
  .strict()
  .superRefine(({ needs }, context) => {
    if (!hasUniqueStrings(needs.map(({ id }) => id))) {
      context.addIssue({
        code: "custom",
        message: "Exact-product plan need IDs must be unique",
        path: ["needs"],
      });
    }
  });

export type ExactProductPlanApiRequest = z.infer<typeof exactProductPlanApiRequestSchema>;

const exactProductPlanApiChainSchema = z.enum(["bunnpris", "extra", "rema-1000"]);

export const EXACT_PRODUCT_OFFER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const EXACT_PRODUCT_PRICE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;

function medianOre(amounts: readonly number[]): number | undefined {
  if (amounts.length === 0) return undefined;
  const sorted = [...amounts].sort((left, right) => left - right);
  const upperIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[upperIndex];

  return Number(
    (BigInt(sorted[upperIndex - 1]!) + BigInt(sorted[upperIndex]!)) / 2n,
  );
}

function utcObservationDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export const exactProductPlanApiEvidenceSourceSchema = z
  .object({
    contractVersion: contractVersionSchema,
    id: sourceIdSchema,
    displayName: nonEmptyStringSchema,
    sourceClass: z.enum([
      "catalog",
      "ordinary-price",
      "offer",
      "store",
      "geocoder",
      "routing",
      "legacy",
    ]),
    state: z.literal("approved"),
  })
  .strict();

export type ExactProductPlanApiEvidenceSource = z.infer<
  typeof exactProductPlanApiEvidenceSourceSchema
>;

export const EXACT_PRODUCT_CATALOG_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

export const exactProductPlanApiCatalogEvidenceSchema = z
  .object({
    observedAt: canonicalTimestampSchema,
    source: exactProductPlanApiEvidenceSourceSchema,
    sourceRecordId: z.string().regex(/^source-record:[0-9a-f]{64}$/),
  })
  .strict();

export type ExactProductPlanApiCatalogEvidence = z.infer<
  typeof exactProductPlanApiCatalogEvidenceSchema
>;

export const exactProductPlanApiProductSummarySchema = z
  .object({
    catalogEvidence: exactProductPlanApiCatalogEvidenceSchema,
    gtin: gtinSchema,
    displayName: nonEmptyStringSchema,
    brand: nonEmptyStringSchema.optional(),
    packageMeasure: packageMeasureSchema,
    unitsPerPack: positiveSafeIntegerSchema,
  })
  .strict();

export type ExactProductPlanApiProductSummary = z.infer<
  typeof exactProductPlanApiProductSummarySchema
>;

export const exactProductPlanApiNeedEvidenceSchema = z
  .object({
    needId: identifierSchema,
    ordinaryPrices: z.array(priceEvidenceSchema).max(3),
    historicalPriceEvidence: z.array(priceEvidenceSchema).max(300),
    excludedPriceEvidence: z.array(priceEvidenceSchema).max(3),
    officialOffers: z.array(officialOfferSchema).max(50),
    historicalComparisons: z.array(historicalComparisonSchema).max(3),
    comparisonScope: comparisonScopeSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    const ordinaryIds = entry.ordinaryPrices.map(({ id }) => id);
    const historicalEvidenceIds = entry.historicalPriceEvidence.map(({ id }) => id);
    const excludedEvidenceIds = entry.excludedPriceEvidence.map(({ id }) => id);
    const offerIds = entry.officialOffers.map(({ id }) => id);
    const historicalIds = entry.historicalComparisons.map(({ id }) => id);
    if (!hasUniqueStrings(ordinaryIds)) {
      context.addIssue({
        code: "custom",
        message: "Ordinary price evidence IDs must be unique per need",
        path: ["ordinaryPrices"],
      });
    }
    if (!hasUniqueStrings(offerIds)) {
      context.addIssue({
        code: "custom",
        message: "Official offer IDs must be unique per need",
        path: ["officialOffers"],
      });
    }
    if (
      !hasUniqueStrings(historicalEvidenceIds)
      || historicalEvidenceIds.some((id) => ordinaryIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Historical evidence IDs must be unique and separate from current prices",
        path: ["historicalPriceEvidence"],
      });
    }
    if (
      !hasUniqueStrings(excludedEvidenceIds)
      || excludedEvidenceIds.some(
        (id) => ordinaryIds.includes(id) || historicalEvidenceIds.includes(id),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Excluded evidence IDs must be unique and separate from admitted evidence",
        path: ["excludedPriceEvidence"],
      });
    }
    if (!hasUniqueStrings(historicalIds)) {
      context.addIssue({
        code: "custom",
        message: "Historical comparison IDs must be unique per need",
        path: ["historicalComparisons"],
      });
    }
    if (
      entry.ordinaryPrices.some(
        ({ priceKind, productMatch }) =>
          priceKind !== "ordinary" || productMatch.kind !== "exact",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Strict planning accepts only exact ordinary price evidence",
        path: ["ordinaryPrices"],
      });
    }
    if (
      entry.historicalPriceEvidence.some(
        ({ priceKind, productMatch }) =>
          priceKind !== "ordinary" || productMatch.kind !== "exact",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Historical baselines accept only exact ordinary price evidence",
        path: ["historicalPriceEvidence"],
      });
    }
    if (
      entry.excludedPriceEvidence.some(
        ({ priceKind, productMatch }) =>
          priceKind !== "ordinary" || productMatch.kind !== "exact",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Excluded coverage provenance accepts only exact ordinary evidence",
        path: ["excludedPriceEvidence"],
      });
    }

    const expectedChains = exactProductPlanApiChainSchema.options;
    if (
      entry.comparisonScope.expectedChainIds.length !== expectedChains.length ||
      expectedChains.some(
        (chainId, index) => entry.comparisonScope.expectedChainIds[index] !== chainId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Strict planning coverage must declare all three supported chains",
        path: ["comparisonScope", "expectedChainIds"],
      });
    }

    const ordinaryById = new Map(entry.ordinaryPrices.map((evidence) => [evidence.id, evidence]));
    const pricedEntries = entry.comparisonScope.entries.filter(
      (scopeEntry) => scopeEntry.status.kind === "priced",
    );
    for (const scopeEntry of pricedEntries) {
      if (scopeEntry.status.kind !== "priced") continue;
      const evidence = ordinaryById.get(scopeEntry.status.evidenceId);
      if (evidence === undefined || evidence.chainId !== scopeEntry.chainId) {
        context.addIssue({
          code: "custom",
          message: "Every priced coverage cell must reference same-chain ordinary evidence",
          path: ["comparisonScope", "entries"],
        });
      }
    }
    const pricedIds = pricedEntries.flatMap(({ status }) =>
      status.kind === "priced" ? [status.evidenceId] : [],
    );
    if (
      pricedIds.length !== ordinaryIds.length ||
      ordinaryIds.some((id) => !pricedIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Ordinary price evidence must exactly match priced coverage cells",
        path: ["ordinaryPrices"],
      });
    }
    const excludedById = new Map(
      entry.excludedPriceEvidence.map((evidence) => [evidence.id, evidence]),
    );
    const referencedExcludedIds: string[] = [];
    for (const scopeEntry of entry.comparisonScope.entries) {
      const evidenceId = scopeEntry.status.kind === "stale"
        ? scopeEntry.status.evidenceId
        : scopeEntry.status.kind === "ineligible"
          ? scopeEntry.status.evidenceId
          : undefined;
      if (evidenceId === undefined) continue;
      referencedExcludedIds.push(evidenceId);
      const excluded = excludedById.get(evidenceId);
      if (excluded === undefined || excluded.chainId !== scopeEntry.chainId) {
        context.addIssue({
          code: "custom",
          message: "Stale or ineligible coverage evidence must resolve to excluded provenance",
          path: ["excludedPriceEvidence"],
        });
      }
    }
    if (
      !hasUniqueStrings(referencedExcludedIds)
      || referencedExcludedIds.length !== excludedEvidenceIds.length
      || excludedEvidenceIds.some((id) => !referencedExcludedIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Excluded evidence must be referenced exactly once by unresolved coverage",
        path: ["excludedPriceEvidence"],
      });
    }

    const baselineById = new Map(
      entry.historicalPriceEvidence.map((evidence) => [evidence.id, evidence]),
    );
    for (const comparison of entry.historicalComparisons) {
      const current = ordinaryById.get(comparison.currentEvidenceId);
      if (
        current === undefined
        || current.chainId !== comparison.chainId
        || current.productMatch.kind !== "exact"
        || current.productMatch.canonicalProductId !== comparison.canonicalProductId
        || current.amountOre !== comparison.currentOre
        || current.observedAt !== comparison.windowEndsAt
      ) {
        context.addIssue({
          code: "custom",
          message: "Historical comparisons must exactly match visible current evidence",
          path: ["historicalComparisons"],
        });
      }

      const baselineEvidence = comparison.sourceEvidenceIds.flatMap((id) => {
        const evidence = baselineById.get(id);
        return evidence === undefined ? [] : [evidence];
      });
      const windowStartsAt = Date.parse(comparison.windowStartsAt);
      const windowEndsAt = Date.parse(comparison.windowEndsAt);
      const hasMismatchedBaseline =
        baselineEvidence.length !== comparison.sourceEvidenceIds.length
        || baselineEvidence.some((evidence) => {
          const observedAt = Date.parse(evidence.observedAt);
          return evidence.chainId !== comparison.chainId
            || evidence.productMatch.kind !== "exact"
            || evidence.productMatch.canonicalProductId !== comparison.canonicalProductId
            || current === undefined
            || evidence.sourceId !== current.sourceId
            || geographicScopeFingerprint(evidence.geographicScope)
              !== geographicScopeFingerprint(current.geographicScope)
            || observedAt < windowStartsAt
            || observedAt >= windowEndsAt;
        });
      if (hasMismatchedBaseline) {
        context.addIssue({
          code: "custom",
          message: "Historical source IDs must resolve to matching evidence inside the comparison window",
          path: ["historicalPriceEvidence"],
        });
      }

      const distinctObservationDays = new Set(
        baselineEvidence.map(({ observedAt }) => utcObservationDay(observedAt)),
      ).size;
      if (distinctObservationDays !== comparison.distinctObservationDays) {
        context.addIssue({
          code: "custom",
          message: "Historical distinct-day count must match its source evidence",
          path: ["historicalComparisons"],
        });
      }

      if (
        medianOre(baselineEvidence.map(({ amountOre }) => amountOre))
        !== comparison.baselineOre
      ) {
        context.addIssue({
          code: "custom",
          message: "Historical baseline must equal the median of its source evidence",
          path: ["historicalComparisons"],
        });
      }
    }
    const referencedHistoricalIds = new Set(
      entry.historicalComparisons.flatMap(({ sourceEvidenceIds }) => sourceEvidenceIds),
    );
    if (
      referencedHistoricalIds.size !== historicalEvidenceIds.length
      || historicalEvidenceIds.some((id) => !referencedHistoricalIds.has(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Historical baseline evidence must be referenced exactly by visible comparisons",
        path: ["historicalPriceEvidence"],
      });
    }
  });

export type ExactProductPlanApiNeedEvidence = z.infer<
  typeof exactProductPlanApiNeedEvidenceSchema
>;

const ordinaryPriceAssignmentConditionSchema = z
  .object({ kind: z.literal("ordinary-price") })
  .strict();
const officialOfferAssignmentConditionSchema = z
  .object({
    kind: z.literal("official-offer"),
    offerId: identifierSchema,
  })
  .strict();

export const exactProductPlanApiAssignmentEvidenceSchema = z
  .object({
    planId: identifierSchema,
    needId: identifierSchema,
    chainId: exactProductPlanApiChainSchema,
    evidenceId: identifierSchema,
    conditions: z.discriminatedUnion("kind", [
      ordinaryPriceAssignmentConditionSchema,
      officialOfferAssignmentConditionSchema,
    ]),
  })
  .strict();

export type ExactProductPlanApiAssignmentEvidence = z.infer<
  typeof exactProductPlanApiAssignmentEvidenceSchema
>;

export const exactProductPlanApiEvidenceEnvelopeSchema = z
  .object({
    sources: z.array(exactProductPlanApiEvidenceSourceSchema).max(100),
    needs: z.array(exactProductPlanApiNeedEvidenceSchema).min(1).max(50),
    assignmentEvidence: z.array(exactProductPlanApiAssignmentEvidenceSchema).max(350),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (!hasUniqueStrings(envelope.sources.map(({ id }) => id))) {
      context.addIssue({
        code: "custom",
        message: "Evidence source IDs must be unique",
        path: ["sources"],
      });
    }
    if (!hasUniqueStrings(envelope.needs.map(({ needId }) => needId))) {
      context.addIssue({
        code: "custom",
        message: "Evidence need IDs must be unique",
        path: ["needs"],
      });
    }
    const referenceKeys = envelope.assignmentEvidence.map(
      ({ planId, needId, chainId }) => `${planId}\u0000${needId}\u0000${chainId}`,
    );
    if (!hasUniqueStrings(referenceKeys)) {
      context.addIssue({
        code: "custom",
        message: "Assignment evidence references must be unique",
        path: ["assignmentEvidence"],
      });
    }
  });

export type ExactProductPlanApiEvidenceEnvelope = z.infer<
  typeof exactProductPlanApiEvidenceEnvelopeSchema
>;

export interface ExactProductPlanDeltaExplanationInputV1 {
  evidence: ExactProductPlanApiEvidenceEnvelope;
  generatedAt: string;
  marketContext: ExactProductPlanApiRequest["marketContext"];
  plans: readonly PlanResultV2[];
  travelRoutes?: readonly TravelRouteEvidence[];
}

export function deriveExactProductPlanDeltaExplanationsV1(
  input: ExactProductPlanDeltaExplanationInputV1,
): PlanDeltaExplanationSetV1 | undefined {
  const assignmentEvidence = new Map(input.evidence.assignmentEvidence.map((entry) => [
    `${entry.planId}\u0000${entry.needId}\u0000${entry.chainId}`,
    entry,
  ]));
  const needEvidence = new Map(input.evidence.needs.map((entry) => [entry.needId, entry]));
  const bindings = input.plans.flatMap((plan) => plan.assignments.map((assignment) => {
    const reference = assignmentEvidence.get(
      `${plan.id}\u0000${assignment.needId}\u0000${assignment.chain}`,
    );
    const need = needEvidence.get(assignment.needId);
    if (reference === undefined || need === undefined) return undefined;
    return {
      planId: plan.id,
      needId: assignment.needId,
      canonicalProductId: assignment.canonicalProductId,
      chainId: assignment.chain,
      evidenceId: reference.evidenceId,
      ...(reference.conditions.kind === "official-offer"
        ? { offerId: reference.conditions.offerId }
        : {}),
      comparisonScope: need.comparisonScope,
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

export const exactProductPlanApiResponseSchema = z
  .object({
    contractVersion: contractVersionSchema,
    enabledMembershipProgramIds: enabledMembershipProgramIdsSchema,
    generatedAt: canonicalTimestampSchema,
    geographicDirectoryAttestation: geographicDirectoryRegionAttestationV1Schema.optional(),
    marketContext: marketContextV1Schema,
    priceDataSource: z.literal("cache"),
    caveats: z.array(nonEmptyStringSchema).max(10),
    products: z.array(exactProductPlanApiProductSummarySchema).min(1).max(50),
    plans: z.array(planResultV2Schema).max(7),
    planDeltaExplanations: planDeltaExplanationSetV1Schema,
    evidence: exactProductPlanApiEvidenceEnvelopeSchema,
  })
  .strict();

export type ExactProductPlanApiResponse = z.infer<typeof exactProductPlanApiResponseSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assignmentSetFingerprint(
  assignments: readonly z.infer<typeof planResultV2Schema>["assignments"][number][],
): string {
  return JSON.stringify(
    [...assignments].sort((left, right) =>
      compareText(left.needId, right.needId)
      || compareText(left.canonicalProductId, right.canonicalProductId)
      || compareText(left.ean, right.ean)
      || compareText(left.chain, right.chain)),
  );
}

export function exactProductPlanApiResponseSchemaFor(
  request: ExactProductPlanApiRequest,
  options: { travelRoutes?: readonly TravelRouteEvidence[] } = {},
) {
  const parsedRequest = exactProductPlanApiRequestSchema.parse(request);
  const requestedGtins = [...new Set(
    parsedRequest.needs.map(({ match }) => match.product.value),
  )].sort(compareText);

  return exactProductPlanApiResponseSchema.superRefine((response, context) => {
    const { evidence, plans, priceDataSource, products } = response;
    if (!marketContextsEqual(response.marketContext, parsedRequest.marketContext)) {
      context.addIssue({
        code: "custom",
        message: "Strict planning output must preserve the requested market",
        path: ["marketContext"],
      });
    }
    if (!sameStrings(
      response.enabledMembershipProgramIds,
      parsedRequest.enabledMembershipProgramIds,
    )) {
      context.addIssue({
        code: "custom",
        message: "Strict planning output must preserve enabled membership programs",
        path: ["enabledMembershipProgramIds"],
      });
    }
    if (!hasUniqueStrings(plans.map(({ id }) => id))) {
      context.addIssue({
        code: "custom",
        message: "Strict plan IDs must be unique",
        path: ["plans"],
      });
    }
    if (!hasUniqueStrings(plans.map(({ assignments }) => assignmentSetFingerprint(assignments)))) {
      context.addIssue({
        code: "custom",
        message: "Strict plans must have unique assignment sets",
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
      || plans.some((plan, index) => JSON.stringify(plan) !== JSON.stringify(projectedPlans[index]))
    ) {
      context.addIssue({
        code: "custom",
        message: "Strict plans must be the canonical ordered non-dominated representative set",
        path: ["plans"],
      });
    }
    const expectedExplanations = deriveExactProductPlanDeltaExplanationsV1({
      evidence,
      generatedAt: response.generatedAt,
      marketContext: response.marketContext,
      plans,
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
    const responseGtins = products.map(({ gtin }) => gtin);
    if (!hasUniqueStrings(responseGtins)) {
      context.addIssue({
        code: "custom",
        message: "Product summaries must be distinct by GTIN",
        path: ["products"],
      });
    }
    if (!sameStrings(responseGtins, [...responseGtins].sort(compareText))) {
      context.addIssue({
        code: "custom",
        message: "Product summaries must be sorted by GTIN",
        path: ["products"],
      });
    }
    if (!sameStrings(responseGtins, requestedGtins)) {
      context.addIssue({
        code: "custom",
        message: "Product summaries must exactly match requested GTINs",
        path: ["products"],
      });
    }

    if (priceDataSource !== "cache") {
      context.addIssue({
        code: "custom",
        message: "Versioned planning may read only persisted evidence",
        path: ["priceDataSource"],
      });
    }

    const requestedNeedIds = parsedRequest.needs.map(({ id }) => id).sort(compareText);
    const evidenceNeedIds = evidence.needs.map(({ needId }) => needId);
    if (!sameStrings(evidenceNeedIds, requestedNeedIds)) {
      context.addIssue({
        code: "custom",
        message: "Evidence entries must exactly match requested needs in canonical order",
        path: ["evidence", "needs"],
      });
    }

    const sourceIds = evidence.sources.map(({ id }) => id);
    if (!sameStrings(sourceIds, [...sourceIds].sort(compareText))) {
      context.addIssue({
        code: "custom",
        message: "Evidence sources must be in canonical source-ID order",
        path: ["evidence", "sources"],
      });
    }
    const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
    const generatedAtMs = Date.parse(response.generatedAt);
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
    for (const [needIndex, needEvidence] of evidence.needs.entries()) {
      for (const [priceIndex, price] of needEvidence.ordinaryPrices.entries()) {
        const eligible = parseEligiblePriceEvidence(price, {
          enabledSourceIds: sourceIds,
          ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
          location: marketLocation,
          maxAgeMs: EXACT_PRODUCT_PRICE_MAX_AGE_MS,
          now: new Date(response.generatedAt),
        });
        if (!eligible.eligible) {
          context.addIssue({
            code: "custom",
            message: "Visible ordinary prices must be eligible in the requested market",
            path: ["evidence", "needs", needIndex, "ordinaryPrices", priceIndex],
          });
        }
      }
      for (const [comparisonIndex, comparison] of needEvidence.historicalComparisons.entries()) {
        const current = needEvidence.ordinaryPrices.find(
          ({ id }) => id === comparison.currentEvidenceId,
        );
        if (
          current === undefined
          || !historicalComparisonMatchesEvidence({
            comparison,
            currentEvidence: current,
            historicalEvidence: needEvidence.historicalPriceEvidence,
            derivedAt: new Date(response.generatedAt),
            eligibility: {
              currentMaxAgeMs: EXACT_PRODUCT_PRICE_MAX_AGE_MS,
              enabledSourceIds: sourceIds,
              ...(geographicDirectory === undefined ? {} : { geographicDirectory }),
              location: marketLocation,
            },
          })
        ) {
          context.addIssue({
            code: "custom",
            message: "Historical comparisons must re-derive from same-source, same-market evidence",
            path: ["evidence", "needs", needIndex, "historicalComparisons", comparisonIndex],
          });
        }
      }
      const expectedOfferCells = new Set(needEvidence.ordinaryPrices.flatMap((price) =>
        price.productMatch.kind === "exact"
          ? [`${price.chainId}\u0000${price.productMatch.canonicalProductId}`]
          : []
      ));
      for (const [offerIndex, offer] of needEvidence.officialOffers.entries()) {
        const offerMemberships = offer.conditions.flatMap((condition) =>
          condition.kind === "member" ? [condition.programId] : []
        );
        const eligibility = parseApplicableOfficialOffer(offer, {
          channel: "in-store",
          enabledMembershipProgramIds: offerMemberships,
          enabledSourceIds: sourceIds,
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
            message: "Visible official offers must be current, in-market exact-product evidence",
            path: ["evidence", "needs", needIndex, "officialOffers", offerIndex],
          });
        }
      }
    }
    for (const [productIndex, product] of products.entries()) {
      const { catalogEvidence } = product;
      const observedAtMs = Date.parse(catalogEvidence.observedAt);
      if (
        observedAtMs > generatedAtMs
        || generatedAtMs - observedAtMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS
      ) {
        context.addIssue({
          code: "custom",
          message: "Catalog evidence must be current for the daily refresh policy",
          path: ["products", productIndex, "catalogEvidence", "observedAt"],
        });
      }
      const declaredSource = sourceById.get(catalogEvidence.source.id);
      if (
        declaredSource === undefined
        || declaredSource.contractVersion !== catalogEvidence.source.contractVersion
        || declaredSource.displayName !== catalogEvidence.source.displayName
        || declaredSource.sourceClass !== catalogEvidence.source.sourceClass
        || declaredSource.state !== catalogEvidence.source.state
      ) {
        context.addIssue({
          code: "custom",
          message: "Every catalog record must cross-reference its exact public source descriptor",
          path: ["products", productIndex, "catalogEvidence", "source"],
        });
      }
    }
    const needEvidenceById = new Map(evidence.needs.map((entry) => [entry.needId, entry]));
    const requestedNeedById = new Map(parsedRequest.needs.map((need) => [need.id, need]));
    for (const [planIndex, plan] of plans.entries()) {
      const assignedNeedIds = plan.assignments.map(({ needId }) => needId).sort(compareText);
      if (!sameStrings(assignedNeedIds, requestedNeedIds)) {
        context.addIssue({
          code: "custom",
          message: "Every strict plan must assign the exact requested need set",
          path: ["plans", planIndex, "assignments"],
        });
      }
      if (plan.chains.length > parsedRequest.maxStores) {
        context.addIssue({
          code: "custom",
          message: "A strict plan cannot exceed the requested store limit",
          path: ["plans", planIndex, "chains"],
        });
      }
      for (const [assignmentIndex, assignment] of plan.assignments.entries()) {
        const requestNeed = requestedNeedById.get(assignment.needId);
        const expectedUnit = requestNeed?.quantityUnit === "each"
          ? "package"
          : requestNeed?.quantityUnit;
        if (
          requestNeed === undefined
          || assignment.ean !== requestNeed.match.product.value
          || assignment.fulfilment.requested.amount !== requestNeed.quantity
          || assignment.fulfilment.requested.unit !== expectedUnit
        ) {
          context.addIssue({
            code: "custom",
            message: "Strict assignments must preserve requested identity and quantity",
            path: ["plans", planIndex, "assignments", assignmentIndex],
          });
        }
      }
    }
    const referencedSourceIds = new Set<string>();
    products.forEach(({ catalogEvidence }) => {
      referencedSourceIds.add(catalogEvidence.source.id);
    });
    for (const entry of evidence.needs) {
      entry.ordinaryPrices.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      entry.historicalPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      entry.excludedPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      entry.officialOffers.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      entry.comparisonScope.entries.forEach(({ status }) => {
        if (status.kind === "known-not-carried") referencedSourceIds.add(status.sourceId);
      });
    }
    const expectedSourceIds = [...referencedSourceIds].sort(compareText);
    if (!sameStrings(sourceIds, expectedSourceIds)) {
      context.addIssue({
        code: "custom",
        message: "Evidence sources must exactly cover the sources used by visible claims",
        path: ["evidence", "sources"],
      });
    }

    const assignmentByKey = new Map<string, (typeof plans)[number]["assignments"][number]>();
    for (const plan of plans) {
      for (const assignment of plan.assignments) {
        const key = `${plan.id}\u0000${assignment.needId}\u0000${assignment.chain}`;
        if (assignmentByKey.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Strict plan assignments must have unique plan, need, and chain keys",
            path: ["plans"],
          });
        }
        assignmentByKey.set(key, assignment);
      }
    }
    const referenceByKey = new Map(
      evidence.assignmentEvidence.map((reference) => [
        `${reference.planId}\u0000${reference.needId}\u0000${reference.chainId}`,
        reference,
      ]),
    );
    if (
      assignmentByKey.size !== referenceByKey.size ||
      [...assignmentByKey.keys()].some((key) => !referenceByKey.has(key))
    ) {
      context.addIssue({
        code: "custom",
        message: "Every strict plan assignment requires exactly one evidence reference",
        path: ["evidence", "assignmentEvidence"],
      });
    }

    for (const [key, reference] of referenceByKey) {
      const assignment = assignmentByKey.get(key);
      const needEvidence = needEvidenceById.get(reference.needId);
      if (assignment === undefined || needEvidence === undefined) {
        context.addIssue({
          code: "custom",
          message: "Assignment evidence must resolve to a requested need and assignment",
          path: ["evidence", "assignmentEvidence"],
        });
        continue;
      }
      const requestNeed = requestedNeedById.get(reference.needId);
      if (requestNeed === undefined || assignment.ean !== requestNeed.match.product.value) {
        context.addIssue({
          code: "custom",
          message: "Assignment identities must match their exact requested product",
          path: ["plans"],
        });
      }
      if (reference.conditions.kind === "ordinary-price") {
        const ordinary = needEvidence.ordinaryPrices.find(({ id }) => id === reference.evidenceId);
        if (
          ordinary === undefined ||
          ordinary.chainId !== reference.chainId ||
          ordinary.sourceId !== assignment.source ||
          ordinary.productMatch.kind !== "exact" ||
          ordinary.productMatch.canonicalProductId !== assignment.canonicalProductId ||
          ordinary.observedAt !== assignment.observedAt ||
          BigInt(ordinary.amountOre) * BigInt(assignment.fulfilment.packageCount)
            !== BigInt(assignment.checkout.ordinaryTotalOre) ||
          assignment.checkout.appliedOfferId !== undefined
        ) {
          context.addIssue({
            code: "custom",
            message: "Ordinary assignments must reference same-chain, same-source evidence",
            path: ["evidence", "assignmentEvidence"],
          });
        }
      } else {
        const ordinary = needEvidence.ordinaryPrices.find(({ id }) => id === reference.evidenceId);
        const offerId = reference.conditions.offerId;
        const offer = needEvidence.officialOffers.find(
          ({ id }) => id === offerId,
        );
        const recalculated = offer === undefined
          ? undefined
          : calculateCheckoutCost({
              canonicalProductId: assignment.canonicalProductId,
              chainId: assignment.chain,
              packageCount: assignment.fulfilment.packageCount,
              ordinaryUnitPriceOre: ordinary?.amountOre ?? 0,
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
          ordinary === undefined ||
          ordinary.chainId !== reference.chainId ||
          ordinary.sourceId !== assignment.source ||
          ordinary.productMatch.kind !== "exact" ||
          ordinary.productMatch.canonicalProductId !== assignment.canonicalProductId ||
          ordinary.observedAt !== assignment.observedAt ||
          BigInt(ordinary.amountOre) * BigInt(assignment.fulfilment.packageCount)
            !== BigInt(assignment.checkout.ordinaryTotalOre) ||
          offer === undefined ||
          offer.chainId !== reference.chainId ||
          offer.productMatch.kind !== "exact" ||
          offer.productMatch.canonicalProductId !== assignment.canonicalProductId ||
          offer.id !== assignment.checkout.appliedOfferId ||
          offer.id !== assignment.officialOffer?.id ||
          offer.sourceId !== assignment.officialOffer?.sourceId ||
          offer.sourceRecordId !== assignment.officialOffer?.sourceRecordId ||
          offer.capturedAt !== assignment.officialOffer?.capturedAt ||
          recalculated === undefined ||
          "state" in recalculated ||
          recalculated.appliedOfferId !== offer.id ||
          recalculated.ordinaryTotalOre !== assignment.checkout.ordinaryTotalOre ||
          recalculated.savingOre !== assignment.checkout.savingOre ||
          recalculated.totalOre !== assignment.checkout.totalOre
        ) {
          context.addIssue({
            code: "custom",
            message: "Offer assignments must reference ordinary evidence and the applied official offer",
            path: ["evidence", "assignmentEvidence"],
          });
        }
      }
    }
  });
}
