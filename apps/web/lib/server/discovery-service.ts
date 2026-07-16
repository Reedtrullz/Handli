import {
  PublicCatalogIndexReaderError,
  type PublicCatalogIndexReader,
} from "@handleplan/db/public-catalog-index-reader";
import {
  exactProductPlanApiRequestSchema,
  isFiniteDate,
  isValidGtin,
  publicDiscoveryResponseSchema,
  type ExactProductPlanApiEvidenceSource,
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type PublicDiscoveryProduct,
  type PublicDiscoveryResponse,
} from "@handleplan/domain";

import {
  PriceServiceError,
  type ExactPriceServiceResult,
  type PriceService,
} from "./price-service";

const SEARCH_LIMIT = 20;
const BROWSE_LIMIT = 36;
const MAX_PUBLIC_RESPONSE_BYTES = 128 * 1024;

export interface DiscoveryServiceContract {
  browse(signal?: AbortSignal): Promise<PublicDiscoveryResponse>;
  search(query: string, signal?: AbortSignal): Promise<PublicDiscoveryResponse>;
}

export class DiscoveryUnavailableError extends Error {
  constructor() {
    super("Prisfunn er midlertidig utilgjengelige.");
    this.name = "DiscoveryUnavailableError";
  }
}

export class DiscoveryRequestCancelledError extends Error {
  constructor() {
    super("Forespørselen ble avbrutt.");
    this.name = "DiscoveryRequestCancelledError";
  }
}

interface DiscoveryDependencies {
  catalog: PublicCatalogIndexReader;
  priceService: Pick<PriceService, "readExact">;
  now?: () => Date;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRequestFor(
  products: readonly ExactProductPlanApiProductSummary[],
): ExactProductPlanApiRequest {
  return exactProductPlanApiRequestSchema.parse({
    contractVersion: 1,
    maxStores: 3,
    needs: products.map(({ gtin }) => ({
      id: `discovery:${gtin}`,
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: gtin },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    })),
  });
}

function mergeSources(
  products: readonly ExactProductPlanApiProductSummary[],
  evidenceSources: readonly ExactProductPlanApiEvidenceSource[],
): ExactProductPlanApiEvidenceSource[] {
  const sources = new Map<string, ExactProductPlanApiEvidenceSource>();
  for (const source of [
    ...products.map(({ catalogEvidence }) => catalogEvidence.source),
    ...evidenceSources,
  ]) {
    const existing = sources.get(source.id);
    if (
      existing !== undefined
      && (
        existing.contractVersion !== source.contractVersion
        || existing.displayName !== source.displayName
        || existing.sourceClass !== source.sourceClass
        || existing.state !== source.state
      )
    ) {
      throw new DiscoveryUnavailableError();
    }
    sources.set(source.id, source);
  }
  return [...sources.values()].sort((left, right) => compareText(left.id, right.id));
}

function referencedSourceIds(products: readonly PublicDiscoveryProduct[]): Set<string> {
  const sourceIds = new Set<string>();
  for (const entry of products) {
    sourceIds.add(entry.catalog.catalogEvidence.source.id);
    for (const evidence of [
      ...entry.ordinaryPrices,
      ...entry.historicalPriceEvidence,
      ...entry.excludedPriceEvidence,
    ]) {
      sourceIds.add(evidence.sourceId);
    }
    for (const offer of entry.officialOffers) sourceIds.add(offer.sourceId);
    for (const { status } of entry.comparisonScope.entries) {
      if (status.kind === "known-not-carried") sourceIds.add(status.sourceId);
    }
  }
  return sourceIds;
}

function publicSourcesFor(
  products: readonly PublicDiscoveryProduct[],
  evidenceSources: readonly ExactProductPlanApiEvidenceSource[],
): ExactProductPlanApiEvidenceSource[] {
  const needed = referencedSourceIds(products);
  return mergeSources(
    products.map(({ catalog }) => catalog),
    evidenceSources.filter(({ id }) => needed.has(id)),
  ).filter(({ id }) => needed.has(id));
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateResponse(
  products: readonly PublicDiscoveryProduct[],
  evidenceSources: readonly ExactProductPlanApiEvidenceSource[],
  generatedAt: Date,
): PublicDiscoveryResponse {
  const parsed = publicDiscoveryResponseSchema.safeParse({
    contractVersion: 1,
    generatedAt: generatedAt.toISOString(),
    priceDataSource: "cache",
    products,
    sources: publicSourcesFor(products, evidenceSources),
  });
  if (!parsed.success) throw new DiscoveryUnavailableError();
  return parsed.data;
}

function boundedResponse(
  products: readonly PublicDiscoveryProduct[],
  evidenceSources: readonly ExactProductPlanApiEvidenceSource[],
  generatedAt: Date,
): PublicDiscoveryResponse {
  const complete = validateResponse(products, evidenceSources, generatedAt);
  if (serializedBytes(complete) <= MAX_PUBLIC_RESPONSE_BYTES) return complete;

  // Historical comparisons carry their full independent source-evidence set.
  // If that mature evidence would crowd out ordinary-price browsing, omit the
  // entire analytical claim rather than publishing an unverifiable subset.
  const withoutHistory = products.map((entry) => ({
    ...entry,
    historicalComparisons: [],
    historicalPriceEvidence: [],
  }));
  const fallback = validateResponse(withoutHistory, evidenceSources, generatedAt);
  if (serializedBytes(fallback) > MAX_PUBLIC_RESPONSE_BYTES) {
    throw new DiscoveryUnavailableError();
  }
  return fallback;
}

interface DiscoveryCandidate {
  entry: PublicDiscoveryProduct;
  index: number;
}

function preferCandidate(
  current: DiscoveryCandidate,
  candidate: DiscoveryCandidate,
  preferredGtin: string | undefined,
): DiscoveryCandidate {
  const currentPreferred = current.entry.catalog.gtin === preferredGtin;
  const candidatePreferred = candidate.entry.catalog.gtin === preferredGtin;
  if (currentPreferred !== candidatePreferred) return candidatePreferred ? candidate : current;
  return compareText(candidate.entry.catalog.gtin, current.entry.catalog.gtin) < 0
    ? candidate
    : current;
}

function responseFor(
  catalogProducts: readonly ExactProductPlanApiProductSummary[],
  priceResult: ExactPriceServiceResult | undefined,
  generatedAt: Date,
  preferredGtin?: string,
): PublicDiscoveryResponse {
  if (catalogProducts.length === 0) {
    return publicDiscoveryResponseSchema.parse({
      contractVersion: 1,
      generatedAt: generatedAt.toISOString(),
      priceDataSource: "cache",
      products: [],
      sources: [],
    });
  }
  if (priceResult === undefined) throw new DiscoveryUnavailableError();

  const identityByGtin = new Map(priceResult.products.map((product) => [product.gtin, product]));
  const evidenceByNeedId = new Map(
    priceResult.evidence.needs.map((evidence) => [evidence.needId, evidence]),
  );
  const candidates = catalogProducts.map((catalog, index): DiscoveryCandidate => {
    const identity = identityByGtin.get(catalog.gtin);
    const evidence = evidenceByNeedId.get(`discovery:${catalog.gtin}`);
    if (identity === undefined || evidence === undefined) {
      throw new DiscoveryUnavailableError();
    }
    return {
      entry: {
        canonicalProductId: identity.canonicalProductId,
        catalog,
        comparisonScope: evidence.comparisonScope,
        excludedPriceEvidence: evidence.excludedPriceEvidence,
        historicalComparisons: evidence.historicalComparisons,
        historicalPriceEvidence: evidence.historicalPriceEvidence,
        officialOffers: evidence.officialOffers,
        ordinaryPrices: evidence.ordinaryPrices,
      },
      index,
    };
  });
  const canonical = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const current = canonical.get(candidate.entry.canonicalProductId);
    canonical.set(
      candidate.entry.canonicalProductId,
      current === undefined ? candidate : preferCandidate(current, candidate, preferredGtin),
    );
  }
  const products = [...canonical.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ entry }) => entry);
  return boundedResponse(products, priceResult.evidence.sources, generatedAt);
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof PublicCatalogIndexReaderError && error.code === "CANCELLED")
    || (error instanceof PriceServiceError && error.code === "CANCELLED");
}

export class DiscoveryService implements DiscoveryServiceContract {
  constructor(private readonly dependencies: DiscoveryDependencies) {}

  browse(signal?: AbortSignal): Promise<PublicDiscoveryResponse> {
    return this.load(
      (at) => this.dependencies.catalog.browse(BROWSE_LIMIT, at, signal),
      signal,
    );
  }

  search(query: string, signal?: AbortSignal): Promise<PublicDiscoveryResponse> {
    const normalizedQuery = query.trim();
    return this.load(
      (at) => this.dependencies.catalog.search(query, SEARCH_LIMIT, at, signal),
      signal,
      isValidGtin(normalizedQuery) ? normalizedQuery : undefined,
    );
  }

  private async load(
    loadCatalog: (at: Date) => Promise<ExactProductPlanApiProductSummary[]>,
    signal?: AbortSignal,
    preferredGtin?: string,
  ): Promise<PublicDiscoveryResponse> {
    if (signal?.aborted) throw new DiscoveryRequestCancelledError();
    const generatedAt = (this.dependencies.now ?? (() => new Date()))();
    if (!(generatedAt instanceof Date) || !isFiniteDate(generatedAt)) {
      throw new DiscoveryUnavailableError();
    }

    try {
      const catalogProducts = await loadCatalog(generatedAt);
      if (signal?.aborted) throw new DiscoveryRequestCancelledError();
      if (catalogProducts.length === 0) {
        return responseFor([], undefined, generatedAt);
      }
      const request = exactRequestFor(catalogProducts);
      const priceResult = await this.dependencies.priceService.readExact(
        request,
        generatedAt,
        signal,
      );
      if (signal?.aborted) throw new DiscoveryRequestCancelledError();
      return responseFor(catalogProducts, priceResult, generatedAt, preferredGtin);
    } catch (error) {
      if (error instanceof DiscoveryRequestCancelledError || isCancellation(error, signal)) {
        throw new DiscoveryRequestCancelledError();
      }
      if (error instanceof DiscoveryUnavailableError) throw error;
      throw new DiscoveryUnavailableError();
    }
  }
}
