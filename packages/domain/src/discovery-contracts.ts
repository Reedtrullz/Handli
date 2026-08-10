import { z } from "zod";

import { gtinSchema, packageMeasureSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
} from "./contract-primitives";
import { comparisonScopeSchema } from "./coverage";
import { parseEligiblePriceEvidence, priceEvidenceSchema } from "./evidence";
import {
  historicalComparisonMatchesEvidence,
  historicalComparisonSchema,
} from "./history";
import {
  marketContextsEqual,
  marketContextToGeographicContext,
  marketContextV1Schema,
  type MarketContextV1,
} from "./market-context";
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

/** One Oppdag page is also the maximum bounded plan-impact action batch. */
export const PUBLIC_DISCOVERY_PAGE_SIZE_MAX = 8;
/** One request may evaluate at most one exact-product planning batch. */
export const PUBLIC_DISCOVERY_CATALOG_SCAN_MAX = 50;

export const publicDiscoveryChainFilterSchema = z.enum([
  "all",
  ...EXPECTED_CHAINS,
]);
export type PublicDiscoveryChainFilter = z.infer<
  typeof publicDiscoveryChainFilterSchema
>;

export const publicDiscoveryTypeFilterSchema = z.enum([
  "all",
  "historical-comparison",
  "official-offer",
]);
export type PublicDiscoveryTypeFilter = z.infer<
  typeof publicDiscoveryTypeFilterSchema
>;

export const publicDiscoveryCursorSchema = z
  .string()
  .min(32)
  .max(1_500)
  .regex(/^discovery-cursor:v1:[A-Za-z0-9_-]+$/u);
export type PublicDiscoveryCursor = z.infer<typeof publicDiscoveryCursorSchema>;

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

export const publicDiscoveryCategoryIdSchema = z
  .string()
  .regex(/^category:[0-9a-f]{64}$/u);

export const publicDiscoveryRequestV1Schema = z
  .object({
    categoryId: publicDiscoveryCategoryIdSchema.optional(),
    chain: publicDiscoveryChainFilterSchema,
    contractVersion: z.literal(1),
    cursor: publicDiscoveryCursorSchema.optional(),
    marketContext: marketContextV1Schema,
    pageSize: positiveSafeIntegerSchema.max(PUBLIC_DISCOVERY_PAGE_SIZE_MAX),
    query: z.string().trim().min(2).max(120).optional(),
    resultType: publicDiscoveryTypeFilterSchema,
  })
  .strict()
  .refine(({ categoryId, query }) => categoryId === undefined || query === undefined, {
    message: "Text and category filters are mutually exclusive",
  });

export type PublicDiscoveryRequestV1 = z.infer<typeof publicDiscoveryRequestV1Schema>;

export const publicDiscoverySelectionSchema = z
  .object({
    categoryId: publicDiscoveryCategoryIdSchema.optional(),
    chain: publicDiscoveryChainFilterSchema,
    query: z.string().trim().min(2).max(120).optional(),
    resultType: publicDiscoveryTypeFilterSchema,
  })
  .strict()
  .refine(({ categoryId, query }) => categoryId === undefined || query === undefined, {
    message: "Text and category filters are mutually exclusive",
  });

export type PublicDiscoverySelection = z.infer<typeof publicDiscoverySelectionSchema>;

export const publicDiscoveryPageSchema = z
  .object({
    hasMore: z.boolean(),
    kind: z.literal("bounded-catalog-slice"),
    nextCursor: publicDiscoveryCursorSchema.optional(),
    pageSize: positiveSafeIntegerSchema.max(PUBLIC_DISCOVERY_PAGE_SIZE_MAX),
    scannedCatalogProducts: nonNegativeSafeIntegerSchema.max(
      PUBLIC_DISCOVERY_CATALOG_SCAN_MAX,
    ),
  })
  .strict()
  .superRefine(({ hasMore, nextCursor }, context) => {
    if (hasMore !== (nextCursor !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "A continuing discovery page must expose exactly one opaque cursor",
        path: ["nextCursor"],
      });
    }
  });

export type PublicDiscoveryPage = z.infer<typeof publicDiscoveryPageSchema>;

export const publicDiscoveryCategorySchema = z
  .object({
    depth: nonNegativeSafeIntegerSchema.max(100),
    id: publicDiscoveryCategoryIdSchema,
    name: nonEmptyStringSchema,
    sourceId: identifierSchema,
  })
  .strict();

export type PublicDiscoveryCategory = z.infer<typeof publicDiscoveryCategorySchema>;

export const publicDiscoveryCategoryFacetSchema = publicDiscoveryCategorySchema
  .extend({ productCount: positiveSafeIntegerSchema })
  .strict();

export type PublicDiscoveryCategoryFacet = z.infer<
  typeof publicDiscoveryCategoryFacetSchema
>;

export const publicObservedCategoryDirectorySchema = z
  .object({
    completeness: z.literal("partial"),
    facets: z.array(publicDiscoveryCategoryFacetSchema).max(100),
    hasMore: z.boolean(),
    kind: z.literal("observed-category-directory"),
  })
  .strict()
  .superRefine(({ facets }, context) => {
    const ids = facets.map(({ id }) => id);
    if (!hasUniqueStrings(ids)) {
      context.addIssue({
        code: "custom",
        message: "Observed category facets must use unique opaque identifiers",
        path: ["facets"],
      });
    }
    const sorted = [...facets].sort((left, right) =>
      left.depth - right.depth
      || compareText(left.name, right.name)
      || compareText(left.sourceId, right.sourceId)
      || compareText(left.id, right.id));
    if (facets.some(({ id }, index) => id !== sorted[index]?.id)) {
      context.addIssue({
        code: "custom",
        message: "Observed category facets must use canonical public ordering",
        path: ["facets"],
      });
    }
  });

export type PublicObservedCategoryDirectory = z.infer<
  typeof publicObservedCategoryDirectorySchema
>;

export const publicDiscoveryProductSchema = z
  .object({
    canonicalProductId: identifierSchema,
    catalog: exactProductPlanApiProductSummarySchema,
    categoryPath: z.array(publicDiscoveryCategorySchema).max(100).nullable(),
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

    if (entry.categoryPath !== null) {
      const categoryPath = entry.categoryPath;
      const categoryIds = categoryPath.map(({ id }) => id);
      const catalogSourceId = entry.catalog.catalogEvidence.source.id;
      const pathUsesCatalogSource = categoryPath.every(
        ({ sourceId }) => sourceId === catalogSourceId,
      );
      const hasCanonicalDepthOrder = categoryPath.every(
        ({ depth }, index) => index === 0 || categoryPath[index - 1]!.depth <= depth,
      );
      if (
        !hasUniqueStrings(categoryIds)
        || !pathUsesCatalogSource
        || !hasCanonicalDepthOrder
      ) {
        context.addIssue({
          code: "custom",
          message: "Observed category paths must be unique, ordered, and bound to catalog provenance",
          path: ["categoryPath"],
        });
      }
    }
  });

export type PublicDiscoveryProduct = z.infer<typeof publicDiscoveryProductSchema>;

function discoveryProductMatchesSelection(
  product: PublicDiscoveryProduct,
  selection: PublicDiscoverySelection,
): boolean {
  const chainMatches = (chainId: string) =>
    selection.chain === "all" || chainId === selection.chain;
  const prices = product.ordinaryPrices.filter(({ chainId }) => chainMatches(chainId));
  const offers = product.officialOffers.filter(({ chainId }) => chainMatches(chainId));
  const currentPriceIds = new Set(prices.map(({ id }) => id));
  const comparisons = product.historicalComparisons.filter(
    ({ chainId, currentEvidenceId }) =>
      chainMatches(chainId) && currentPriceIds.has(currentEvidenceId),
  );

  if (selection.resultType === "official-offer") return offers.length > 0;
  if (selection.resultType === "historical-comparison") return comparisons.length > 0;
  return selection.chain === "all" || prices.length > 0 || offers.length > 0;
}

export const publicDiscoveryResponseSchema = z
  .object({
    contractVersion: contractVersionSchema,
    generatedAt: canonicalTimestampSchema,
    marketContext: marketContextV1Schema,
    observedCategories: publicObservedCategoryDirectorySchema,
    page: publicDiscoveryPageSchema,
    priceDataSource: z.literal("cache"),
    products: z.array(publicDiscoveryProductSchema).max(PUBLIC_DISCOVERY_PAGE_SIZE_MAX),
    selection: publicDiscoverySelectionSchema,
    sources: z.array(exactProductPlanApiEvidenceSourceSchema).max(100),
  })
  .strict()
  .superRefine((response, context) => {
    const generatedAt = new Date(response.generatedAt);
    const marketLocation = marketContextToGeographicContext(response.marketContext);
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
    if (response.products.length > response.page.pageSize) {
      context.addIssue({
        code: "custom",
        message: "Discovery cannot return more products than the declared page size",
        path: ["products"],
      });
    }
    response.products.forEach((product, productIndex) => {
      if (!discoveryProductMatchesSelection(product, response.selection)) {
        context.addIssue({
          code: "custom",
          message: "Every discovery card must satisfy the server-owned selection",
          path: ["products", productIndex],
        });
      }
    });
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
          location: marketLocation,
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
        const current = entry.ordinaryPrices.find(
          ({ id }) => id === comparison.currentEvidenceId,
        );
        if (
          comparison.derivedAt !== response.generatedAt
          || current === undefined
          || !historicalComparisonMatchesEvidence({
            comparison,
            currentEvidence: current,
            historicalEvidence: entry.historicalPriceEvidence,
            derivedAt: generatedAt,
            eligibility: {
              currentMaxAgeMs: PUBLIC_DISCOVERY_CURRENT_PRICE_MAX_AGE_MS,
              enabledSourceIds: sourceIds,
              location: marketLocation,
            },
          })
        ) {
          context.addIssue({
            code: "custom",
            message: "Historical comparisons must re-derive from same-source, same-market evidence",
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
          location: marketLocation,
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

    response.observedCategories.facets.forEach(({ sourceId }, facetIndex) => {
      if (!sourceById.has(sourceId) && response.products.some(
        ({ catalog }) => catalog.catalogEvidence.source.id === sourceId,
      )) {
        context.addIssue({
          code: "custom",
          message: "Observed category provenance must resolve when its source is present in this snapshot",
          path: ["observedCategories", "facets", facetIndex, "sourceId"],
        });
      }
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

export function publicDiscoveryResponseSchemaFor(
  request: PublicDiscoveryRequestV1 | MarketContextV1,
) {
  const marketContext = "marketContext" in request
    ? publicDiscoveryRequestV1Schema.parse(request).marketContext
    : marketContextV1Schema.parse(request);
  return publicDiscoveryResponseSchema.superRefine((response, context) => {
    if (!marketContextsEqual(response.marketContext, marketContext)) {
      context.addIssue({
        code: "custom",
        message: "Discovery output must preserve the requested market",
        path: ["marketContext"],
      });
    }
    if ("marketContext" in request) {
      const parsedRequest = publicDiscoveryRequestV1Schema.parse(request);
      const expectedSelection: PublicDiscoverySelection = {
        ...(parsedRequest.categoryId === undefined
          ? {}
          : { categoryId: parsedRequest.categoryId }),
        chain: parsedRequest.chain,
        ...(parsedRequest.query === undefined ? {} : { query: parsedRequest.query }),
        resultType: parsedRequest.resultType,
      };
      if (
        JSON.stringify(response.selection) !== JSON.stringify(expectedSelection)
        || response.page.pageSize !== parsedRequest.pageSize
      ) {
        context.addIssue({
          code: "custom",
          message: "Discovery output must preserve the requested filters and page size",
          path: ["selection"],
        });
      }
    }
  });
}
