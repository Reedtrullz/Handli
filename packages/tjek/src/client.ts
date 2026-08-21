import type {
  TjekCatalog,
  TjekCatalogListResponse,
  TjekOffer,
  TjekRpcOfferResponseItem,
} from "./types";

const TJEK_BASE_URL = "https://squid-api.tjek.com";
const BUNNPRIS_DEALER_ID = "5b11sm";

export interface TjekClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class TjekClientError extends Error {
  constructor(
    readonly code: "SERVER_ERROR" | "CANCELLED" | "RATE_LIMITED",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TjekClientError";
  }
}

export class TjekClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: TjekClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? TJEK_BASE_URL;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async listCatalogs(
    params?: { limit?: number; order_by?: string },
    signal?: AbortSignal,
  ): Promise<readonly TjekCatalog[]> {
    const searchParams = new URLSearchParams();
    searchParams.set("dealer_id", BUNNPRIS_DEALER_ID);
    searchParams.set("types", "incito");
    searchParams.set("limit", String(params?.limit ?? 24));
    if (params?.order_by !== undefined) {
      searchParams.set("order_by", params.order_by);
    }

    const url = `${this.baseUrl}/v2/catalogs?${searchParams.toString()}`;
    if (signal?.aborted) {
      throw new TjekClientError("CANCELLED", "Request cancelled");
    }

    const response = await this.fetchFn(url, { signal });
    if (response.status === 429) {
      throw new TjekClientError("RATE_LIMITED", "Rate limited by Tjek API");
    }
    if (!response.ok) {
      throw new TjekClientError(
        "SERVER_ERROR",
        `Tjek API error: ${response.status}`,
        response.status,
      );
    }
    const data: unknown = await response.json();
    // API returns a raw array of catalogs, not { catalogs: [...] }
    if (Array.isArray(data)) return data as readonly TjekCatalog[];
    const wrapped = data as TjekCatalogListResponse;
    return wrapped.catalogs;
  }

  async getLatestCatalog(
    signal?: AbortSignal,
  ): Promise<TjekCatalog | undefined> {
    const catalogs = await this.listCatalogs(
      { limit: 1, order_by: "-publication_date" },
      signal,
    );
    return catalogs[0];
  }

  async getOffersFromCatalog(
    catalogId: string,
    signal?: AbortSignal,
  ): Promise<readonly TjekOffer[]> {
    if (signal?.aborted) {
      throw new TjekClientError("CANCELLED", "Request cancelled");
    }

    const url = `${this.baseUrl}/v4/rpc/get_offer_products`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "get_offer_products",
        params: [{ catalog_id: catalogId }],
      }),
      signal,
    });

    if (response.status === 429) {
      throw new TjekClientError("RATE_LIMITED", "Rate limited by Tjek API");
    }
    if (!response.ok) {
      throw new TjekClientError(
        "SERVER_ERROR",
        `Tjek RPC error: ${response.status}`,
        response.status,
      );
    }

    const data: unknown = await response.json();
    return this.parseOfferResponse(data, catalogId);
  }

  private parseOfferResponse(
    data: unknown,
    catalogId: string,
  ): readonly TjekOffer[] {
    const raw = data as Record<string, unknown>;
    const items: readonly TjekRpcOfferResponseItem[] = Array.isArray(data)
      ? (data as readonly TjekRpcOfferResponseItem[])
      : Array.isArray(raw?.result)
        ? (raw.result as readonly TjekRpcOfferResponseItem[])
        : [];

    return items.map((item, index) => ({
      id: typeof item.id === "string" ? item.id : `${catalogId}-${index}`,
      heading: typeof item.heading === "string" ? item.heading : null,
      name:
        typeof item.name === "string"
          ? item.name
          : typeof item.heading === "string"
            ? item.heading
            : `Offer ${index}`,
      price: typeof item.price === "number" ? item.price : null,
      price_text: typeof item.price_text === "string" ? item.price_text : null,
      before_price:
        typeof item.before_price === "number" ? item.before_price : null,
      quantity: typeof item.quantity === "string" ? item.quantity : null,
      unit: typeof item.unit === "string" ? item.unit : null,
      run_from: typeof item.run_from === "string" ? item.run_from : "",
      run_till: typeof item.run_till === "string" ? item.run_till : "",
      catalog_id: catalogId,
      dealer_id: BUNNPRIS_DEALER_ID,
      image_url: typeof item.image_url === "string" ? item.image_url : null,
      page_number:
        typeof item.page_number === "number" ? item.page_number : null,
    }));
  }
}
