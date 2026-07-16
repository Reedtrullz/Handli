import { z } from "zod";

import { gtinSchema, packageMeasureSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
} from "./contract-primitives";
import { comparisonScopeSchema } from "./coverage";
import { parseEligiblePriceEvidence, priceEvidenceSchema } from "./evidence";
import { historicalComparisonSchema } from "./history";
import { officialOfferSchema, parseApplicableOfficialOffer } from "./offers";
import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  exactProductPlanApiEvidenceSourceSchema,
  exactProductPlanApiNeedEvidenceSchema,
  exactProductPlanApiProductSummarySchema,
  type ExactProductPlanApiProductSummary,
} from "./plan-api-contracts";

const PUBLIC_DISCOVERY_CURRENT_PRICE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;
const EXPECTED_CHAINS = ["bunnpris", "extra", "rema-1000"] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const publicCatalogProductSchema = z
  .object({
    contractVersion: contractVersionSchema,
    gtin: gtinSchema,
    displayName: nonEmptyStringSchema,
    brand: nonEmptyStringSchema.optional(),
    packageMeasure: packageMeasureSchema,
    unitsPerPack: positiveSafeIntegerSchema,
  })
  .strict();

export type PublicCatalogProduct = z.infer<typeof publicCatalogProductSchema>;

export const publicProductSearchResponseSchema = z
  .object({
    contractVersion: contractVersionSchema,
    products: z.array(publicCatalogProductSchema).max(20),
  })
  .strict()
  .superRefine(({ products }, context) => {
    const gtins = products.map(({ gtin }) => gtin);
    if (!hasUniqueStrings(gtins)) {
      context.addIssue({
        code: "custom",
        message: "Public search products must be unique by GTIN",
        path: ["products"],
      });
    }
  });

export type PublicProductSearchResponse = z.infer<typeof publicProductSearchResponseSchema>;

export function publicCatalogProductFromSummary(
  summary: ExactProductPlanApiProductSummary,
): PublicCatalogProduct {
  return publicCatalogProductSchema.parse({
    contractVersion: 1,
    gtin: summary.gtin,
    displayName: summary.displayName,
    ...(summary.brand === undefined ? {} : { brand: summary.brand }),
    packageMeasure: summary.packageMeasure,
    unitsPerPack: summary.unitsPerPack,
  });
}

export const publicDiscoveryProductSchema = z
  .object({
    canonicalProductId: identifierSchema,
    catalog: exactProductPlanApiProductSummarySchema,
    ordinaryPrices: z.array(priceEvidenceSchema).max(EXPECTED_CHAINS.length),
    historicalPriceEvidence: z.array(priceEvidenceSchema).max(1_000),
    excludedPriceEvidence: z.array(priceEvidenceSchema).max(EXPECTED_CHAINS.length),
    comparisonScope: comparisonScopeSchema,
    historicalComparisons: z.array(historicalComparisonSchema).max(EXPECTED_CHAINS.length),
    officialOffers: z.array(officialOfferSchema).max(100),
  })
  .strict()
  .superRefine((entry, context) => {
    const evidence = exactProductPlanApiNeedEvidenceSchema.safeParse({
      comparisonScope: entry.comparisonScope,
      excludedPriceEvidence: entry.excludedPriceEvidence,
      historicalComparisons: entry.historicalComparisons,
      historicalPriceEvidence: entry.historicalPriceEvidence,
      needId: entry.catalog.gtin,
      officialOffers: entry.officialOffers,
      ordinaryPrices: entry.ordinaryPrices,
    });
    if (!evidence.success) {
      context.addIssue({
        code: "custom",
        message: "Discovery evidence must form one internally consistent exact-product claim set",
        path: ["comparisonScope"],
      });
    }

    const evidenceMatchesProduct = [
      ...entry.ordinaryPrices,
      ...entry.historicalPriceEvidence,
      ...entry.excludedPriceEvidence,
    ].every(({ productMatch }) =>
      productMatch.kind === "exact"
      && productMatch.canonicalProductId === entry.canonicalProductId);
    const comparisonsMatchProduct = entry.historicalComparisons.every(
      ({ canonicalProductId }) => canonicalProductId === entry.canonicalProductId,
    );
    const offersMatchProduct = entry.officialOffers.every(({ productMatch }) =>
      productMatch.kind === "exact"
      && productMatch.canonicalProductId === entry.canonicalProductId);
    if (!evidenceMatchesProduct || !comparisonsMatchProduct || !offersMatchProduct) {
      context.addIssue({
        code: "custom",
        message: "All discovery claims must concern the catalog product",
        path: ["canonicalProductId"],
      });
    }
    const supportedChainIds: readonly string[] = EXPECTED_CHAINS;
    const allClaimsUseSupportedChains = [
      ...entry.ordinaryPrices,
      ...entry.historicalPriceEvidence,
      ...entry.excludedPriceEvidence,
      ...entry.historicalComparisons,
      ...entry.officialOffers,
    ].every(({ chainId }) => supportedChainIds.includes(chainId));
    if (!allClaimsUseSupportedChains) {
      context.addIssue({
        code: "custom",
        message: "Discovery exposes claims only for supported chains",
        path: ["comparisonScope", "expectedChainIds"],
      });
    }
  });

export type PublicDiscoveryProduct = z.infer<typeof publicDiscoveryProductSchema>;

export const publicDiscoveryResponseSchema = z
  .object({
    contractVersion: contractVersionSchema,
    generatedAt: canonicalTimestampSchema,
    priceDataSource: z.literal("cache"),
    products: z.array(publicDiscoveryProductSchema).max(36),
    sources: z.array(exactProductPlanApiEvidenceSourceSchema).max(100),
  })
  .strict()
  .superRefine((response, context) => {
    const generatedAt = new Date(response.generatedAt);
    const generatedAtMs = generatedAt.getTime();
    const gtins = response.products.map(({ catalog }) => catalog.gtin);
    if (!hasUniqueStrings(gtins)) {
      context.addIssue({
        code: "custom",
        message: "Discovery products must be unique by GTIN",
        path: ["products"],
      });
    }
    const canonicalIds = response.products.map(({ canonicalProductId }) => canonicalProductId);
    if (!hasUniqueStrings(canonicalIds)) {
      context.addIssue({
        code: "custom",
        message: "Discovery cards must be unique by canonical product",
        path: ["products"],
      });
    }
    const sourceIds = response.sources.map(({ id }) => id);
    if (!hasUniqueStrings(sourceIds) || !sameStrings(sourceIds, [...sourceIds].sort(compareText))) {
      context.addIssue({
        code: "custom",
        message: "Discovery sources must be unique and sorted",
        path: ["sources"],
      });
    }
    const sourceById = new Map(response.sources.map((source) => [source.id, source]));
    const referencedSourceIds = new Set<string>();

    response.products.forEach((entry, productIndex) => {
      const catalogSource = entry.catalog.catalogEvidence.source;
      referencedSourceIds.add(catalogSource.id);
      const declaredCatalogSource = sourceById.get(catalogSource.id);
      if (
        declaredCatalogSource === undefined
        || JSON.stringify(declaredCatalogSource) !== JSON.stringify(catalogSource)
      ) {
        context.addIssue({
          code: "custom",
          message: "Catalog provenance must resolve to its exact public source descriptor",
          path: ["products", productIndex, "catalog", "catalogEvidence", "source"],
        });
      }

      const catalogObservedAtMs = Date.parse(entry.catalog.catalogEvidence.observedAt);
      if (
        catalogObservedAtMs > generatedAtMs
        || generatedAtMs - catalogObservedAtMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS
      ) {
        context.addIssue({
          code: "custom",
          message: "Public discovery accepts only fresh catalog provenance",
          path: ["products", productIndex, "catalog", "catalogEvidence", "observedAt"],
        });
      }
      if (entry.comparisonScope.evaluatedAt !== response.generatedAt) {
        context.addIssue({
          code: "custom",
          message: "Coverage must be evaluated at the discovery snapshot time",
          path: ["products", productIndex, "comparisonScope", "evaluatedAt"],
        });
      }

      entry.ordinaryPrices.forEach((evidence, evidenceIndex) => {
        referencedSourceIds.add(evidence.sourceId);
        const eligible = parseEligiblePriceEvidence(evidence, {
          enabledSourceIds: sourceIds,
          location: { countryCode: "NO" },
          maxAgeMs: PUBLIC_DISCOVERY_CURRENT_PRICE_MAX_AGE_MS,
          now: generatedAt,
        });
        if (!eligible.eligible || evidence.priceKind !== "ordinary") {
          context.addIssue({
            code: "custom",
            message: "Visible ordinary prices must be current, eligible persisted evidence",
            path: ["products", productIndex, "ordinaryPrices", evidenceIndex],
          });
        }
      });
      entry.historicalPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      entry.excludedPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      entry.comparisonScope.entries.forEach(({ status }) => {
        if (status.kind === "known-not-carried") referencedSourceIds.add(status.sourceId);
      });
      entry.historicalComparisons.forEach((comparison, comparisonIndex) => {
        if (comparison.derivedAt !== response.generatedAt) {
          context.addIssue({
            code: "custom",
            message: "Historical comparisons must be derived at the snapshot time",
            path: ["products", productIndex, "historicalComparisons", comparisonIndex],
          });
        }
      });
      entry.officialOffers.forEach((offer, offerIndex) => {
        referencedSourceIds.add(offer.sourceId);
        const memberships = offer.conditions.flatMap((condition) =>
          condition.kind === "member" ? [condition.programId] : []);
        const applicable = parseApplicableOfficialOffer(offer, {
          channel: "in-store",
          enabledMembershipProgramIds: memberships,
          enabledSourceIds: sourceIds,
          location: { countryCode: "NO" },
          maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
          now: generatedAt,
        });
        if (!applicable.applicable) {
          context.addIssue({
            code: "custom",
            message: "Visible official offers must be current and applicable",
            path: ["products", productIndex, "officialOffers", offerIndex],
          });
        }
      });
    });

    const expectedSourceIds = [...referencedSourceIds].sort(compareText);
    if (!sameStrings(sourceIds, expectedSourceIds)) {
      context.addIssue({
        code: "custom",
        message: "Discovery source descriptors must exactly cover every public claim",
        path: ["sources"],
      });
    }
  });

export type PublicDiscoveryResponse = z.infer<typeof publicDiscoveryResponseSchema>;
