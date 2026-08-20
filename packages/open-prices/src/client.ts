import type { OpenPricesApiResponse, OpenPricesListParams, OpenPricesPrice } from "./types";

const OPEN_PRICES_BASE_URL = "https://prices.openfoodfacts.org/api/v1";
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 500;
const RATE_LIMIT_MS = 1000;

export interface OpenPricesClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class OpenPricesClientError extends Error {
  constructor(
    readonly code: "RATE_LIMITED" | "SERVER_ERROR" | "CANCELLED" | "PAGE_LIMIT",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "OpenPricesClientError";
  }
}

export class OpenPricesClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private lastRequestAt = 0;

  constructor(options: OpenPricesClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? OPEN_PRICES_BASE_URL;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private async rateLimitedFetch(url: string, signal?: AbortSignal): Promise<Response> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }
    if (signal?.aborted) {
      throw new OpenPricesClientError("CANCELLED", "Request cancelled");
    }
    this.lastRequestAt = Date.now();
    const response = await this.fetchFn(url, { signal });
    if (response.status === 429) {
      throw new OpenPricesClientError("RATE_LIMITED", "Rate limited by Open Prices API");
    }
    if (response.status >= 500) {
      throw new OpenPricesClientError("SERVER_ERROR", `Open Prices API server error: ${response.status}`, response.status);
    }
    return response;
  }

  async listPrices(params: OpenPricesListParams, signal?: AbortSignal): Promise<OpenPricesApiResponse> {
    const searchParams = new URLSearchParams();
    if (params.product_code !== undefined) searchParams.set("product_code", params.product_code);
    if (params.product_code__in !== undefined) searchParams.set("product_code__in", params.product_code__in);
    if (params.currency !== undefined) searchParams.set("currency", params.currency);
    if (params.location_id !== undefined) searchParams.set("location_id", String(params.location_id));
    if (params.location_id__in !== undefined) searchParams.set("location_id__in", params.location_id__in);
    if (params.date__gte !== undefined) searchParams.set("date__gte", params.date__gte);
    if (params.date__lte !== undefined) searchParams.set("date__lte", params.date__lte);
    if (params.page !== undefined) {
      if (params.page > MAX_PAGE) {
        throw new OpenPricesClientError("PAGE_LIMIT", `Page ${params.page} exceeds maximum ${MAX_PAGE}`);
      }
      searchParams.set("page", String(params.page));
    }
    searchParams.set("size", String(Math.min(params.size ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)));
    if (params.order_by !== undefined) searchParams.set("order_by", params.order_by);

    const url = `${this.baseUrl}/prices?${searchParams.toString()}`;
    const response = await this.rateLimitedFetch(url, signal);
    if (!response.ok) {
      throw new OpenPricesClientError("SERVER_ERROR", `Open Prices API error: ${response.status}`, response.status);
    }
    return (await response.json()) as OpenPricesApiResponse;
  }

  async getPricesForGtins(gtins: readonly string[], signal?: AbortSignal): Promise<readonly OpenPricesPrice[]> {
    if (gtins.length === 0) return [];
    const allItems: OpenPricesPrice[] = [];
    let page = 1;
    while (page <= MAX_PAGE) {
      if (signal?.aborted) {
        throw new OpenPricesClientError("CANCELLED", "Request cancelled");
      }
      const response = await this.listPrices({
        currency: "NOK",
        order_by: "-date",
        page,
        product_code__in: gtins.join(","),
        size: MAX_PAGE_SIZE,
      }, signal);
      allItems.push(...response.items);
      if (page >= response.pages) break;
      page += 1;
    }
    return allItems;
  }
}
