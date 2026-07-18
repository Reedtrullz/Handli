import { createHash } from "node:crypto";

import {
  PublicCatalogIndexReaderError,
  type PublicCatalogCategoryFacetDirectory,
  type PublicCatalogDiscoveryIndexReader,
  type PublicCatalogDiscoveryPage,
  type PublicCatalogDiscoveryPosition,
} from "@handleplan/db/public-catalog-index-reader";
import {
  exactProductPlanApiRequestSchema,
  isFiniteDate,
  isValidGtin,
  PUBLIC_DISCOVERY_CATALOG_SCAN_MAX,
  PUBLIC_DISCOVERY_PAGE_SIZE_MAX,
  publicDiscoveryCursorSchema,
  publicDiscoveryRequestV1Schema,
  publicDiscoveryResponseSchemaFor,
  type ExactProductPlanApiEvidenceSource,
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type MarketContextV1,
  type PublicDiscoveryRequestV1,
  type PublicDiscoverySelection,
  type PublicDiscoveryProduct,
  type PublicDiscoveryResponse,
} from "@handleplan/domain";

import {
  PriceServiceError,
  type ExactPriceServiceResult,
  type PriceService,
} from "./price-service";

const CATEGORY_FACET_LIMIT = 100;
const MAX_PUBLIC_RESPONSE_BYTES = 128 * 1024;
const DISCOVERY_CURSOR_PREFIX = "discovery-cursor:v1:";

export interface DiscoveryServiceContract {
  discover(
    request: PublicDiscoveryRequestV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse>;
  browse(marketContext: MarketContextV1, signal?: AbortSignal): Promise<PublicDiscoveryResponse>;
  browseCategory(
    categoryId: string,
    marketContext: MarketContextV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse>;
  search(
    query: string,
    marketContext: MarketContextV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse>;
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
  catalog: PublicCatalogDiscoveryIndexReader;
  priceService: Pick<PriceService, "readExact">;
  now?: () => Date;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionFor(request: PublicDiscoveryRequestV1): PublicDiscoverySelection {
  return {
    ...(request.categoryId === undefined ? {} : { categoryId: request.categoryId }),
    chain: request.chain,
    ...(request.query === undefined ? {} : { query: request.query }),
    resultType: request.resultType,
  };
}

function cursorScopeSha256(request: PublicDiscoveryRequestV1): string {
  return createHash("sha256").update(JSON.stringify({
    marketContext: request.marketContext,
    selection: selectionFor(request),
  })).digest("hex");
}

interface DecodedDiscoveryCursor {
  at: Date;
  position: PublicCatalogDiscoveryPosition;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const sorted = [...expected].sort(compareText);
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function decodeCursor(
  cursor: string,
  request: PublicDiscoveryRequestV1,
): DecodedDiscoveryCursor | undefined {
  if (!publicDiscoveryCursorSchema.safeParse(cursor).success) return undefined;
  const encoded = cursor.slice(DISCOVERY_CURSOR_PREFIX.length);
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.byteLength > 1_000) return undefined;
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !hasOnlyKeys(value as Record<string, unknown>, [
      "at",
      "gtin",
      "rank",
      "scopeSha256",
      "sortName",
      "version",
    ])
  ) return undefined;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1
    || typeof payload.at !== "string"
    || typeof payload.scopeSha256 !== "string"
    || payload.scopeSha256 !== cursorScopeSha256(request)
    || typeof payload.gtin !== "string"
    || !isValidGtin(payload.gtin)
    || !Number.isSafeInteger(payload.rank)
    || (payload.rank as number) < 0
    || (payload.rank as number) > 4
    || typeof payload.sortName !== "string"
    || payload.sortName.length < 1
    || payload.sortName.length > 500
  ) return undefined;
  const at = new Date(payload.at);
  if (!isFiniteDate(at) || at.toISOString() !== payload.at) return undefined;
  return {
    at,
    position: {
      gtin: payload.gtin,
      rank: payload.rank as number,
      sortName: payload.sortName,
    },
  };
}

function encodeCursor(
  at: Date,
  position: PublicCatalogDiscoveryPosition,
  request: PublicDiscoveryRequestV1,
): string {
  const encoded = Buffer.from(JSON.stringify({
    at: at.toISOString(),
    gtin: position.gtin,
    rank: position.rank,
    scopeSha256: cursorScopeSha256(request),
    sortName: position.sortName,
    version: 1,
  }), "utf8").toString("base64url");
  return publicDiscoveryCursorSchema.parse(`${DISCOVERY_CURSOR_PREFIX}${encoded}`);
}

function exactRequestFor(
  products: readonly ExactProductPlanApiProductSummary[],
  marketContext: MarketContextV1,
): ExactProductPlanApiRequest {
  return exactProductPlanApiRequestSchema.parse({
    contractVersion: 1,
    enabledMembershipProgramIds: [],
    marketContext,
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

interface DiscoveryResponsePage {
  hasMore: boolean;
  nextCursor?: string;
  pageSize: number;
  scannedCatalogProducts: number;
}

function validateResponse(
  products: readonly PublicDiscoveryProduct[],
  evidenceSources: readonly ExactProductPlanApiEvidenceSource[],
  generatedAt: Date,
  categories: PublicCatalogCategoryFacetDirectory,
  page: DiscoveryResponsePage,
  request: PublicDiscoveryRequestV1,
): PublicDiscoveryResponse {
  const parsed = publicDiscoveryResponseSchemaFor(request).safeParse({
    contractVersion: 1,
    generatedAt: generatedAt.toISOString(),
    marketContext: request.marketContext,
    observedCategories: {
      completeness: "partial",
      facets: categories.facets,
      hasMore: categories.hasMore,
      kind: "observed-category-directory",
    },
    page: {
      hasMore: page.hasMore,
      kind: "bounded-catalog-slice",
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      pageSize: page.pageSize,
      scannedCatalogProducts: page.scannedCatalogProducts,
    },
    priceDataSource: "cache",
    products,
    selection: selectionFor(request),
    sources: publicSourcesFor(products, evidenceSources),
  });
  if (!parsed.success) throw new DiscoveryUnavailableError();
  return parsed.data;
}

function boundedResponse(
  products: readonly PublicDiscoveryProduct[],
  evidenceSources: readonly ExactProductPlanApiEvidenceSource[],
  generatedAt: Date,
  categories: PublicCatalogCategoryFacetDirectory,
  page: DiscoveryResponsePage,
  request: PublicDiscoveryRequestV1,
): PublicDiscoveryResponse {
  const complete = validateResponse(
    products,
    evidenceSources,
    generatedAt,
    categories,
    page,
    request,
  );
  if (serializedBytes(complete) <= MAX_PUBLIC_RESPONSE_BYTES) return complete;

  // Historical comparisons carry their full independent source-evidence set.
  // If that mature evidence would crowd out ordinary-price browsing, omit the
  // entire analytical claim rather than publishing an unverifiable subset.
  const withoutHistory = products.map((entry) => ({
    ...entry,
    historicalComparisons: [],
    historicalPriceEvidence: [],
  }));
  const fallback = validateResponse(
    withoutHistory,
    evidenceSources,
    generatedAt,
    categories,
    page,
    request,
  );
  if (serializedBytes(fallback) > MAX_PUBLIC_RESPONSE_BYTES) {
    throw new DiscoveryUnavailableError();
  }
  return fallback;
}

interface DiscoveryCandidate {
  entry: PublicDiscoveryProduct;
  index: number;
  position: PublicCatalogDiscoveryPosition;
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

function candidateMatchesSelection(
  candidate: DiscoveryCandidate,
  selection: PublicDiscoverySelection,
): boolean {
  const { entry } = candidate;
  const chainMatches = (chainId: string) =>
    selection.chain === "all" || chainId === selection.chain;
  const prices = entry.ordinaryPrices.filter(({ chainId }) => chainMatches(chainId));
  const offers = entry.officialOffers.filter(({ chainId }) => chainMatches(chainId));
  const currentPriceIds = new Set(prices.map(({ id }) => id));
  const comparisons = entry.historicalComparisons.filter(
    ({ chainId, currentEvidenceId }) =>
      chainMatches(chainId) && currentPriceIds.has(currentEvidenceId),
  );
  if (selection.resultType === "official-offer") return offers.length > 0;
  if (selection.resultType === "historical-comparison") return comparisons.length > 0;
  return selection.chain === "all" || prices.length > 0 || offers.length > 0;
}

function responseFor(
  catalogPage: PublicCatalogDiscoveryPage,
  priceResult: ExactPriceServiceResult | undefined,
  generatedAt: Date,
  categories: PublicCatalogCategoryFacetDirectory,
  request: PublicDiscoveryRequestV1,
  preferredGtin?: string,
): PublicDiscoveryResponse {
  const catalogEntries = catalogPage.entries;
  if (catalogEntries.length === 0) {
    const page = catalogPage.hasMore && catalogPage.nextPosition !== undefined
      ? {
          hasMore: true,
          nextCursor: encodeCursor(generatedAt, catalogPage.nextPosition, request),
          pageSize: request.pageSize,
          scannedCatalogProducts: catalogPage.scannedCount,
        }
      : {
          hasMore: false,
          pageSize: request.pageSize,
          scannedCatalogProducts: catalogPage.scannedCount,
        };
    return boundedResponse([], [], generatedAt, categories, page, request);
  }
  if (priceResult === undefined) throw new DiscoveryUnavailableError();

  const identityByGtin = new Map(priceResult.products.map((product) => [product.gtin, product]));
  const evidenceByNeedId = new Map(
    priceResult.evidence.needs.map((evidence) => [evidence.needId, evidence]),
  );
  const candidates = catalogEntries.map(({
    catalogPosition,
    categoryPath,
    product: catalog,
  }, index): DiscoveryCandidate => {
    const identity = identityByGtin.get(catalog.gtin);
    const evidence = evidenceByNeedId.get(`discovery:${catalog.gtin}`);
    if (identity === undefined || evidence === undefined) {
      throw new DiscoveryUnavailableError();
    }
    return {
      entry: {
        canonicalProductId: identity.canonicalProductId,
        catalog,
        categoryPath,
        comparisonScope: evidence.comparisonScope,
        excludedPriceEvidence: evidence.excludedPriceEvidence,
        historicalComparisons: evidence.historicalComparisons,
        historicalPriceEvidence: evidence.historicalPriceEvidence,
        officialOffers: evidence.officialOffers,
        ordinaryPrices: evidence.ordinaryPrices,
      },
      index,
      position: catalogPosition,
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
  const selection = selectionFor(request);
  const matching = [...canonical.values()]
    .sort((left, right) => left.index - right.index)
    .filter((candidate) => candidateMatchesSelection(candidate, selection));
  const visible = matching.slice(0, request.pageSize);
  let nextPosition: PublicCatalogDiscoveryPosition | undefined;
  if (matching.length > request.pageSize) {
    nextPosition = visible.at(-1)?.position;
  } else if (catalogPage.hasMore) {
    nextPosition = catalogPage.nextPosition;
  }
  const page: DiscoveryResponsePage = nextPosition === undefined
    ? {
        hasMore: false,
        pageSize: request.pageSize,
        scannedCatalogProducts: catalogPage.scannedCount,
      }
    : {
        hasMore: true,
        nextCursor: encodeCursor(generatedAt, nextPosition, request),
        pageSize: request.pageSize,
        scannedCatalogProducts: catalogPage.scannedCount,
      };
  return boundedResponse(
    visible.map(({ entry }) => entry),
    priceResult.evidence.sources,
    generatedAt,
    categories,
    page,
    request,
  );
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof PublicCatalogIndexReaderError && error.code === "CANCELLED")
    || (error instanceof PriceServiceError && error.code === "CANCELLED");
}

export class DiscoveryService implements DiscoveryServiceContract {
  constructor(private readonly dependencies: DiscoveryDependencies) {}

  discover(
    request: PublicDiscoveryRequestV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse> {
    return this.load(request, signal);
  }

  browse(
    marketContext: MarketContextV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse> {
    return this.load({
      chain: "all",
      contractVersion: 1,
      marketContext,
      pageSize: PUBLIC_DISCOVERY_PAGE_SIZE_MAX,
      resultType: "all",
    }, signal);
  }

  browseCategory(
    categoryId: string,
    marketContext: MarketContextV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse> {
    return this.load({
      categoryId,
      chain: "all",
      contractVersion: 1,
      marketContext,
      pageSize: PUBLIC_DISCOVERY_PAGE_SIZE_MAX,
      resultType: "all",
    }, signal);
  }

  search(
    query: string,
    marketContext: MarketContextV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse> {
    return this.load({
      chain: "all",
      contractVersion: 1,
      marketContext,
      pageSize: PUBLIC_DISCOVERY_PAGE_SIZE_MAX,
      query,
      resultType: "all",
    }, signal);
  }

  private async load(
    rawRequest: PublicDiscoveryRequestV1,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryResponse> {
    if (signal?.aborted) throw new DiscoveryRequestCancelledError();
    const parsedRequest = publicDiscoveryRequestV1Schema.safeParse(rawRequest);
    if (!parsedRequest.success) throw new DiscoveryUnavailableError();
    const request = parsedRequest.data;
    const decodedCursor = request.cursor === undefined
      ? undefined
      : decodeCursor(request.cursor, request);
    if (request.cursor !== undefined && decodedCursor === undefined) {
      throw new DiscoveryUnavailableError();
    }
    const generatedAt = decodedCursor?.at
      ?? (this.dependencies.now ?? (() => new Date()))();
    if (!(generatedAt instanceof Date) || !isFiniteDate(generatedAt)) {
      throw new DiscoveryUnavailableError();
    }

    try {
      const [catalogPage, categories] = await Promise.all([
        this.dependencies.catalog.readDiscoveryPage({
          ...(request.categoryId === undefined ? {} : { categoryId: request.categoryId }),
          ...(decodedCursor === undefined ? {} : { cursor: decodedCursor.position }),
          limit: PUBLIC_DISCOVERY_CATALOG_SCAN_MAX,
          ...(request.query === undefined ? {} : { query: request.query }),
        }, generatedAt, signal),
        this.dependencies.catalog.categoryFacets(CATEGORY_FACET_LIMIT, generatedAt, signal),
      ]);
      if (signal?.aborted) throw new DiscoveryRequestCancelledError();
      if (
        !Array.isArray(catalogPage.entries)
        || catalogPage.entries.length > PUBLIC_DISCOVERY_CATALOG_SCAN_MAX
        || !Number.isSafeInteger(catalogPage.scannedCount)
        || catalogPage.scannedCount < catalogPage.entries.length
        || catalogPage.scannedCount > PUBLIC_DISCOVERY_CATALOG_SCAN_MAX
        || catalogPage.hasMore !== (catalogPage.nextPosition !== undefined)
      ) {
        throw new DiscoveryUnavailableError();
      }
      if (catalogPage.entries.length === 0) {
        return responseFor(catalogPage, undefined, generatedAt, categories, request);
      }
      const catalogProducts = catalogPage.entries.map(({ product }) => product);
      const priceRequest = exactRequestFor(catalogProducts, request.marketContext);
      const priceResult = await this.dependencies.priceService.readExact(
        priceRequest,
        generatedAt,
        signal,
      );
      if (signal?.aborted) throw new DiscoveryRequestCancelledError();
      return responseFor(
        catalogPage,
        priceResult,
        generatedAt,
        categories,
        request,
        request.query !== undefined && isValidGtin(request.query.trim())
          ? request.query.trim()
          : undefined,
      );
    } catch (error) {
      if (error instanceof DiscoveryRequestCancelledError || isCancellation(error, signal)) {
        throw new DiscoveryRequestCancelledError();
      }
      if (error instanceof DiscoveryUnavailableError) throw error;
      throw new DiscoveryUnavailableError();
    }
  }
}
