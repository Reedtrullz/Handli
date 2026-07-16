import type { PriceObservation, Product } from "@handleplan/domain";
import { z } from "zod";

import { normalizeBrowseResponse, normalizeBulkPriceResponse, normalizeSearchResponse } from "./schemas";
import {
  type KassalappCategorySyncResultV1,
  type KassalappLabelSourceRecordV1,
  type KassalappPhysicalStoreSyncResultV1,
  type KassalappPhysicalStoreSourceRecordV1,
  type KassalappPriceSourceRecordV1,
  type KassalappProductSourceRecordV1,
  type SourceRecordOutcome,
  canonicalizeSourceRecordOutcomes,
  isValidGtin,
  normalizeCategoryPageSourceResponse,
  normalizeLabelSourceResponse,
  normalizeHistoricalPriceSourceResponse,
  normalizePhysicalStorePageSourceResponse,
  normalizePriceSourceResponse,
  normalizeProductComparisonSourceResponse,
  normalizeProductPageSourceResponse,
  normalizeProductSourceResponse,
} from "./source-contracts";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const PROCESS_REQUEST_LIMIT = 60;
const PROCESS_REQUEST_WINDOW_MS = 60_000;
const MAX_PROCESS_REQUEST_WAITERS = 120;
const MAX_IN_FLIGHT_REQUESTS_PER_CLIENT = 180;
const MAX_SUBSCRIBERS_PER_REQUEST = 100;
const MAX_BULK_EANS = 100;
const MAX_TOTAL_BULK_EANS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CHAIN_ORDER: Record<PriceObservation["chain"], number> = {
  bunnpris: 0,
  "rema-1000": 1,
  extra: 2,
};
const BROWSE_STORE_CODES = ["BUNNPRIS", "REMA_1000", "COOP_EXTRA"] as const;
const CHAIN_ID_BY_SOURCE_CODE = {
  BUNNPRIS: "bunnpris",
  REMA_1000: "rema-1000",
  COOP_EXTRA: "extra",
} as const;
const eanSchema = z.string().regex(/^(?:\d{8}|\d{13})$/);

export interface BrowseCatalogItem {
  product: Product;
  price: PriceObservation;
  previousPrice?: PriceObservation;
}

export type KassalappGatewayErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_UNAVAILABLE";

export class KassalappGatewayError extends Error {
  constructor(public readonly code: KassalappGatewayErrorCode) {
    super(publicMessage(code));
    this.name = "KassalappGatewayError";
  }
}

export interface KassalappGateway {
  browseCatalog?(limit: number, signal?: AbortSignal): Promise<BrowseCatalogItem[]>;
  browseProducts(limit: number, signal?: AbortSignal): Promise<Product[]>;
  searchProducts(query: string, limit: number, signal?: AbortSignal): Promise<Product[]>;
  getBulkPrices(eans: string[], signal?: AbortSignal): Promise<PriceObservation[]>;
}

/**
 * Worker-facing ingestion contract. This deliberately sits beside the legacy
 * public Product gateway: ingestion callers must persist accepted, unknown,
 * and quarantined source states before deriving public read models.
 */
export interface KassalappIngestionGateway {
  getSourceCatalogProducts(
    page: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappProductSourceRecordV1>>>;
  getSourceProductByEan(
    ean: string,
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappProductSourceRecordV1>>>;
  getSourceProductById(
    productId: number,
    signal?: AbortSignal,
  ): Promise<SourceRecordOutcome<KassalappProductSourceRecordV1>>;
  getSourceBulkPrices(
    eans: string[],
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>>>;
  getSourceHistoricalPrices(
    eans: string[],
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>>>;
  getSourceCategories(
    signal?: AbortSignal,
  ): Promise<KassalappCategorySyncResultV1>;
  getSourceLabels(
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappLabelSourceRecordV1>>>;
  getSourcePhysicalStores(
    signal?: AbortSignal,
  ): Promise<KassalappPhysicalStoreSyncResultV1>;
}

export interface KassalappClientOptions {
  authorizeRequestAttempt?: KassalappRequestAttemptAuthorizer;
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  now?: () => Date;
  requestCoordinator?: KassalappRequestCoordinator;
}

export type KassalappRequestScope =
  | "catalog"
  | "ordinary-price"
  | "physical-store"
  | "price-history";

export interface KassalappRequestAttemptContext {
  readonly attempt: 1 | 2;
  readonly scope: KassalappRequestScope;
}

export type KassalappRequestAttemptAuthorizer = (
  context: Readonly<KassalappRequestAttemptContext>,
  signal: AbortSignal,
) => Promise<void>;

export interface KassalappRequestCoordinator {
  acquire(signal?: AbortSignal): Promise<void>;
}

interface AttemptResult {
  response: Response;
  body?: unknown;
}

class AttemptTimeoutError extends Error {}
class AttemptCancelledError extends Error {}
class InvalidResponseError extends Error {}

let processRequestStarts: number[] = [];
let processRequestWaiters = 0;

/** Test isolation for the deliberately process-local request budget. */
export function resetKassalappRequestCoordinationForTests(): void {
  processRequestStarts = [];
  processRequestWaiters = 0;
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (error?: KassalappGatewayError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(new KassalappGatewayError("CANCELLED"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => finish(), delayMs);
  });
}

async function acquireProcessRequestSlot(signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
    const now = Date.now();
    processRequestStarts = processRequestStarts.filter(
      (startedAt) => startedAt > now - PROCESS_REQUEST_WINDOW_MS,
    );
    if (processRequestStarts.length < PROCESS_REQUEST_LIMIT) {
      processRequestStarts.push(now);
      return;
    }
    if (processRequestWaiters >= MAX_PROCESS_REQUEST_WAITERS) {
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }
    processRequestWaiters += 1;
    try {
      await waitForDelay(
        Math.max(0, processRequestStarts[0]! + PROCESS_REQUEST_WINDOW_MS - now),
        signal,
      );
    } finally {
      processRequestWaiters -= 1;
    }
  }
}

function retryDelayMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after")?.trim();
  let delayMs = DEFAULT_RETRY_DELAY_MS;
  if (retryAfter !== undefined && retryAfter !== "") {
    if (/^\d+$/.test(retryAfter)) {
      delayMs = Number(retryAfter) * 1_000;
    } else {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) delayMs = Math.max(0, retryAt - Date.now());
    }
  }
  return Number.isFinite(delayMs) && delayMs <= MAX_RETRY_DELAY_MS ? delayMs : undefined;
}

interface SharedRequest {
  controller: AbortController;
  promise: Promise<unknown>;
  settled: boolean;
  subscribers: number;
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Cleanup only. */ }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  if (!new RegExp(`^application/json(?:\\s*;\\s*${parameter})*\\s*$`, "i").test(contentType)) {
    await cancelBody(response);
    throw new InvalidResponseError();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new InvalidResponseError();
  }
  if (response.body === null) throw new InvalidResponseError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new InvalidResponseError();
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Cleanup only. */ }
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError();
  }
}

function publicMessage(code: KassalappGatewayErrorCode): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "Ugyldig forespørsel til prisgrunnlaget.";
    case "INVALID_RESPONSE":
      return "Prisgrunnlaget hadde et ukjent format.";
    case "TIMEOUT":
      return "Prisgrunnlaget svarte ikke i tide.";
    case "CANCELLED":
      return "Forespørselen til prisgrunnlaget ble avbrutt.";
    case "UPSTREAM_UNAVAILABLE":
      return "Prisgrunnlaget er midlertidig utilgjengelig.";
  }
}

function normalizeBaseUrl(input: string): string {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Invalid base URL");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new KassalappGatewayError("INVALID_REQUEST");
  }
}

function sortBulkObservations(
  observations: PriceObservation[],
  requestedEans: readonly string[],
): PriceObservation[] {
  const eanOrder = new Map(requestedEans.map((ean, index) => [ean, index]));
  return observations.sort((left, right) => {
    const byEan =
      (eanOrder.get(left.ean) ?? Number.MAX_SAFE_INTEGER) -
      (eanOrder.get(right.ean) ?? Number.MAX_SAFE_INTEGER);
    if (byEan !== 0) return byEan;

    const byChain = CHAIN_ORDER[left.chain] - CHAIN_ORDER[right.chain];
    if (byChain !== 0) return byChain;

    const byObservedAt = right.observedAt.localeCompare(left.observedAt);
    if (byObservedAt !== 0) return byObservedAt;

    return left.amountOre - right.amountOre;
  });
}

function toGatewayError(error: unknown): KassalappGatewayError {
  if (error instanceof KassalappGatewayError) {
    return error;
  }
  return new KassalappGatewayError("INVALID_RESPONSE");
}

export class KassalappClient implements KassalappGateway, KassalappIngestionGateway {
  private readonly baseUrl: string;
  private readonly inFlightRequests = new Map<string, SharedRequest>();

  constructor(private readonly options: KassalappClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  async getSourceCatalogProducts(
    page: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappProductSourceRecordV1>>> {
    const parsed = z.object({
      limit: z.number().int().min(1).max(100),
      page: z.number().int().min(1).max(10_000),
    }).safeParse({ limit, page });
    if (!parsed.success) throw new KassalappGatewayError("INVALID_REQUEST");
    try {
      const url = new URL(`${this.baseUrl}/products`);
      url.searchParams.set("page", String(parsed.data.page));
      url.searchParams.set("size", String(parsed.data.limit));
      url.searchParams.set("sort", "date_desc");
      url.searchParams.set("unique", "1");
      url.searchParams.set("exclude_without_ean", "1");
      const response = await this.requestJson(url, { method: "GET" }, signal, "catalog");
      const now = this.currentTime();
      return normalizeProductPageSourceResponse(response, {
        limit: parsed.data.limit,
        now,
        retrievedAt: now.toISOString(),
      });
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getSourceProductByEan(
    ean: string,
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappProductSourceRecordV1>>> {
    if (!isValidGtin(ean)) throw new KassalappGatewayError("INVALID_REQUEST");
    const url = `${this.baseUrl}/products/ean/${encodeURIComponent(ean)}`;
    try {
      const response = await this.requestOptionalJson(url, { method: "GET" }, signal, "catalog");
      if (response === undefined) {
        return [{ ean, state: "unknown", sourceRecordId: ean, reason: "NOT_FOUND" }];
      }
      const now = this.currentTime();
      return normalizeProductComparisonSourceResponse(response, {
        expectedEan: ean,
        now,
        retrievedAt: now.toISOString(),
      });
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getSourceProductById(
    productId: number,
    signal?: AbortSignal,
  ): Promise<SourceRecordOutcome<KassalappProductSourceRecordV1>> {
    const parsed = z.number().int().safe().positive().safeParse(productId);
    if (!parsed.success) throw new KassalappGatewayError("INVALID_REQUEST");
    const url = `${this.baseUrl}/products/id/${encodeURIComponent(parsed.data)}`;
    try {
      const response = await this.requestOptionalJson(url, { method: "GET" }, signal, "catalog");
      if (response === undefined) {
        return { state: "unknown", sourceRecordId: String(parsed.data), reason: "NOT_FOUND" };
      }
      const now = this.currentTime();
      return normalizeProductSourceResponse(response, {
        expectedProductId: parsed.data,
        now,
        retrievedAt: now.toISOString(),
      });
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getSourceCategories(
    signal?: AbortSignal,
  ): Promise<KassalappCategorySyncResultV1> {
    try {
      const url = new URL(`${this.baseUrl}/categories`);
      url.searchParams.set("size", "100");
      const response = await this.requestJson(url, { method: "GET" }, signal, "catalog");
      return normalizeCategoryPageSourceResponse(response, this.currentTime().toISOString());
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getSourceLabels(
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappLabelSourceRecordV1>>> {
    try {
      const response = await this.requestJson(
        `${this.baseUrl}/labels`,
        { method: "GET" },
        signal,
        "catalog",
      );
      return normalizeLabelSourceResponse(response, this.currentTime().toISOString());
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getSourcePhysicalStores(
    signal?: AbortSignal,
  ): Promise<KassalappPhysicalStoreSyncResultV1> {
    const outcomes: Array<SourceRecordOutcome<KassalappPhysicalStoreSourceRecordV1>> = [];
    const coverage: KassalappPhysicalStoreSyncResultV1["coverage"] = [];
    const chainPagesByStoreIdentity = new Map<string, Set<string>>();
    for (const chainCode of BROWSE_STORE_CODES) {
      const url = new URL(`${this.baseUrl}/physical-stores`);
      url.searchParams.set("group", chainCode);
      url.searchParams.set("size", "100");
      try {
        const response = await this.requestJson(url, { method: "GET" }, signal, "physical-store");
        const now = this.currentTime();
        const page = normalizePhysicalStorePageSourceResponse(response, {
          expectedChainCode: chainCode,
          now,
          retrievedAt: now.toISOString(),
        });
        for (const outcome of page.outcomes) {
          const sourceRecordId = outcome.state === "accepted"
            ? outcome.record.sourceRecordId
            : outcome.sourceRecordId;
          const chainPages = chainPagesByStoreIdentity.get(sourceRecordId) ?? new Set<string>();
          chainPages.add(chainCode);
          chainPagesByStoreIdentity.set(sourceRecordId, chainPages);
        }
        outcomes.push(...page.outcomes);
        coverage.push(...page.coverage);
      } catch (error) {
        const gatewayError = toGatewayError(error);
        if (gatewayError.code === "CANCELLED") throw gatewayError;
        coverage.push({
          chainCode,
          chainId: CHAIN_ID_BY_SOURCE_CODE[chainCode],
          recordCount: 0,
          reason: "REQUEST_FAILED",
          state: "unknown",
        });
      }
    }
    const conflictingChains = new Set(
      [...chainPagesByStoreIdentity.values()]
        .filter((chains) => chains.size > 1)
        .flatMap((chains) => [...chains]),
    );
    return {
      coverage: coverage.map((entry) =>
        entry.state === "complete" && conflictingChains.has(entry.chainCode)
          ? { ...entry, reason: "DUPLICATE_IDENTITY" as const, state: "unknown" as const }
          : entry),
      outcomes: canonicalizeSourceRecordOutcomes(outcomes),
    };
  }

  async getSourceBulkPrices(
    eans: string[],
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>>> {
    return await this.getSourcePrices(eans, "current", signal);
  }

  async getSourceHistoricalPrices(
    eans: string[],
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>>> {
    return await this.getSourcePrices(eans, "historical", signal);
  }

  private async getSourcePrices(
    eans: string[],
    observationKind: "current" | "historical",
    signal?: AbortSignal,
  ): Promise<Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>>> {
    if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
    if (eans.length === 0) return [];
    if (!z.array(z.string()).max(MAX_TOTAL_BULK_EANS).safeParse(eans).success ||
      eans.some((ean) => !isValidGtin(ean))) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    const requestedEans = [...new Set(eans)];
    const outcomes: Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>> = [];
    for (let index = 0; index < requestedEans.length; index += MAX_BULK_EANS) {
      const batch = requestedEans.slice(index, index + MAX_BULK_EANS);
      try {
        const response = await this.requestJson(
          `${this.baseUrl}/products/prices-bulk`,
          { body: JSON.stringify({ eans: batch }), method: "POST" },
          signal,
          observationKind === "current" ? "ordinary-price" : "price-history",
        );
        const now = this.currentTime();
        const normalize = observationKind === "current"
          ? normalizePriceSourceResponse
          : normalizeHistoricalPriceSourceResponse;
        outcomes.push(...normalize(response, {
          expectedEans: batch,
          now,
          retrievedAt: now.toISOString(),
        }));
      } catch (error) {
        const gatewayError = toGatewayError(error);
        if (gatewayError.code === "CANCELLED") throw gatewayError;
        outcomes.push(...batch.map((ean) => ({
          ean,
          state: "unknown" as const,
          sourceRecordId: ean,
          reason: "BATCH_FAILED" as const,
        })));
      }
    }
    return outcomes;
  }

  async browseProducts(limit: number, signal?: AbortSignal): Promise<Product[]> {
    return [...new Map((await this.browseCatalog(limit, signal)).map(({ product }) => [product.ean, product])).values()]
      .slice(0, limit);
  }

  async browseCatalog(limit: number, signal?: AbortSignal): Promise<BrowseCatalogItem[]> {
    const parsed = z.number().int().min(1).max(100).safeParse(limit);
    if (!parsed.success) throw new KassalappGatewayError("INVALID_REQUEST");

    try {
      const perStoreLimit = Math.ceil(parsed.data / BROWSE_STORE_CODES.length);
      const batches = await Promise.all(BROWSE_STORE_CODES.map(async (store) => {
        const url = new URL(`${this.baseUrl}/products`);
        url.searchParams.set("store", store);
        // Inspect a wider, still API-bounded catalog window so documented price
        // drops are not hidden merely because they are not the newest products.
        url.searchParams.set("size", "100");
        url.searchParams.set("sort", "date_desc");
        url.searchParams.set("unique", "1");
        url.searchParams.set("exclude_without_ean", "1");
        return normalizeBrowseResponse(await this.requestJson(url, { method: "GET" }, signal), store)
          .sort((left, right) => {
            const leftPrevious = left.previousPrice?.amountOre ?? left.price.amountOre;
            const rightPrevious = right.previousPrice?.amountOre ?? right.price.amountOre;
            const leftSaving = leftPrevious - left.price.amountOre;
            const rightSaving = rightPrevious - right.price.amountOre;
            const byDiscountRate = rightSaving * leftPrevious - leftSaving * rightPrevious;
            if (byDiscountRate !== 0) return byDiscountRate;
            if (rightSaving !== leftSaving) return rightSaving - leftSaving;
            return right.price.observedAt.localeCompare(left.price.observedAt);
          })
          .slice(0, perStoreLimit);
      }));
      return batches.flat().slice(0, parsed.data);
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async searchProducts(query: string, limit: number, signal?: AbortSignal): Promise<Product[]> {
    const parsed = z
      .object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(100) })
      .safeParse({ query, limit });
    if (!parsed.success) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    const url = new URL(`${this.baseUrl}/products`);
    url.searchParams.set("search", parsed.data.query);
    url.searchParams.set("size", String(parsed.data.limit));
    url.searchParams.set("unique", "1");
    url.searchParams.set("exclude_without_ean", "1");

    try {
      return normalizeSearchResponse(
        await this.requestJson(url, { method: "GET" }, signal),
      ).slice(0, parsed.data.limit);
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getBulkPrices(eans: string[], signal?: AbortSignal): Promise<PriceObservation[]> {
    if (signal?.aborted) {
      throw new KassalappGatewayError("CANCELLED");
    }
    if (eans.length === 0) {
      return [];
    }

    const parsed = z.array(eanSchema).safeParse(eans);
    if (!parsed.success) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    // Duplicate request EANs are collapsed at first occurrence. Every validated
    // upstream observation row is preserved and canonicalized by the final sort.
    const requestedEans = [...new Set(parsed.data)];
    const observations: PriceObservation[] = [];
    for (let index = 0; index < requestedEans.length; index += MAX_BULK_EANS) {
      const batch = requestedEans.slice(index, index + MAX_BULK_EANS);
      try {
        const response = await this.requestJson(
          `${this.baseUrl}/products/prices-bulk`,
          {
            body: JSON.stringify({ eans: batch }),
            method: "POST",
          },
          signal,
        );
        const normalized = normalizeBulkPriceResponse(response);
        const requested = new Set(batch);
        if (normalized.some((observation) => !requested.has(observation.ean))) {
          throw new KassalappGatewayError("INVALID_RESPONSE");
        }
        observations.push(...normalized);
      } catch (error) {
        throw toGatewayError(error);
      }
    }

    return sortBulkObservations(observations, requestedEans);
  }

  private async requestJson(
    input: string | URL,
    init: RequestInit,
    signal?: AbortSignal,
    scope?: KassalappRequestScope,
  ): Promise<unknown> {
    return await this.subscribeToRequest(
      this.requestKey("required", input, init, scope),
      (sharedSignal) => this.requestJsonUncoalesced(input, init, sharedSignal, scope),
      signal,
    );
  }

  private async requestJsonUncoalesced(
    input: string | URL,
    init: RequestInit,
    signal: AbortSignal,
    scope?: KassalappRequestScope,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new KassalappGatewayError("CANCELLED");
      }
      const result = await this.attempt(input, init, signal, scope, (attempt + 1) as 1 | 2);
      if (signal?.aborted) {
        throw new KassalappGatewayError("CANCELLED");
      }
      if (result.response.ok) {
        return result.body;
      }
      if (attempt === 0 && RETRYABLE_STATUSES.has(result.response.status)) {
        const delayMs = retryDelayMs(result.response);
        if (delayMs === undefined) break;
        await waitForDelay(delayMs, signal);
        continue;
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }

    throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
  }

  private currentTime(): Date {
    const now = this.options.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new KassalappGatewayError("INVALID_RESPONSE");
    return new Date(now.getTime());
  }

  private async requestOptionalJson(
    input: string | URL,
    init: RequestInit,
    signal?: AbortSignal,
    scope?: KassalappRequestScope,
  ): Promise<unknown | undefined> {
    return await this.subscribeToRequest(
      this.requestKey("optional", input, init, scope),
      (sharedSignal) => this.requestOptionalJsonUncoalesced(input, init, sharedSignal, scope),
      signal,
    );
  }

  private async requestOptionalJsonUncoalesced(
    input: string | URL,
    init: RequestInit,
    signal: AbortSignal,
    scope?: KassalappRequestScope,
  ): Promise<unknown | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
      const result = await this.attempt(input, init, signal, scope, (attempt + 1) as 1 | 2);
      if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
      if (result.response.ok) return result.body;
      if (result.response.status === 404) return undefined;
      if (attempt === 0 && RETRYABLE_STATUSES.has(result.response.status)) {
        const delayMs = retryDelayMs(result.response);
        if (delayMs === undefined) break;
        await waitForDelay(delayMs, signal);
        continue;
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }
    throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
  }

  private async attempt(
    input: string | URL,
    init: RequestInit,
    callerSignal: AbortSignal,
    scope: KassalappRequestScope | undefined,
    attemptNumber: 1 | 2,
  ): Promise<AttemptResult> {
    if (callerSignal?.aborted) {
      throw new KassalappGatewayError("CANCELLED");
    }

    await this.acquireRequestSlot(callerSignal);
    if (callerSignal?.aborted) throw new KassalappGatewayError("CANCELLED");

    if (scope !== undefined && this.options.authorizeRequestAttempt !== undefined) {
      try {
        await this.options.authorizeRequestAttempt({ attempt: attemptNumber, scope }, callerSignal);
      } catch {
        if (callerSignal.aborted) throw new KassalappGatewayError("CANCELLED");
        throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
      }
      if (callerSignal.aborted) throw new KassalappGatewayError("CANCELLED");
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let cancelled = false;
    let onCallerAbort: (() => void) | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new AttemptTimeoutError());
      }, DEFAULT_TIMEOUT_MS);
    });

    const cancellation = new Promise<never>((_resolve, reject) => {
      if (callerSignal === undefined) return;
      onCallerAbort = () => {
        cancelled = true;
        controller.abort();
        reject(new AttemptCancelledError());
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    });

    const request = (async (): Promise<AttemptResult> => {
      const response = await this.options.fetch(input, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        await cancelBody(response);
        return { response };
      }
      try {
        return { body: await readBoundedJson(response), response };
      } catch {
        throw new InvalidResponseError();
      }
    })();

    try {
      return await Promise.race([request, timeout, cancellation]);
    } catch (error) {
      if (error instanceof AttemptCancelledError || cancelled || callerSignal?.aborted) {
        throw new KassalappGatewayError("CANCELLED");
      }
      if (error instanceof AttemptTimeoutError || timedOut) {
        throw new KassalappGatewayError("TIMEOUT");
      }
      if (error instanceof InvalidResponseError) {
        throw new KassalappGatewayError("INVALID_RESPONSE");
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeoutId);
      if (callerSignal !== undefined && onCallerAbort !== undefined) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  private requestKey(
    mode: "optional" | "required",
    input: string | URL,
    init: RequestInit,
    scope?: KassalappRequestScope,
  ): string {
    return JSON.stringify([
      mode,
      scope ?? "ungoverned",
      init.method ?? "GET",
      String(input),
      typeof init.body === "string" ? init.body : "",
    ]);
  }

  private async acquireRequestSlot(signal?: AbortSignal): Promise<void> {
    if (this.options.requestCoordinator === undefined) {
      await acquireProcessRequestSlot(signal);
      return;
    }
    try {
      await this.options.requestCoordinator.acquire(signal);
    } catch {
      if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }
  }

  private async subscribeToRequest<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) throw new KassalappGatewayError("CANCELLED");

    let shared = this.inFlightRequests.get(key);
    if (shared === undefined) {
      if (this.inFlightRequests.size >= MAX_IN_FLIGHT_REQUESTS_PER_CLIENT) {
        throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
      }
      const controller = new AbortController();
      const promise = operation(controller.signal);
      shared = { controller, promise, settled: false, subscribers: 0 };
      this.inFlightRequests.set(key, shared);
      const settledShared = shared;
      const cleanup = () => {
        settledShared.settled = true;
        if (this.inFlightRequests.get(key) === settledShared) this.inFlightRequests.delete(key);
      };
      void promise.then(cleanup, cleanup);
    }

    if (shared.subscribers >= MAX_SUBSCRIBERS_PER_REQUEST) {
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }
    shared.subscribers += 1;
    const subscribed = shared;
    return await new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        callerSignal?.removeEventListener("abort", onCallerAbort);
        subscribed.subscribers -= 1;
        if (subscribed.subscribers === 0 && !subscribed.settled) {
          if (this.inFlightRequests.get(key) === subscribed) this.inFlightRequests.delete(key);
          subscribed.controller.abort();
        }
        return true;
      };
      const onCallerAbort = () => {
        if (release()) reject(new KassalappGatewayError("CANCELLED"));
      };
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      if (callerSignal?.aborted) {
        onCallerAbort();
        return;
      }
      subscribed.promise.then(
        (value) => { if (release()) resolve(value as T); },
        (error: unknown) => { if (release()) reject(error); },
      );
    });
  }
}
