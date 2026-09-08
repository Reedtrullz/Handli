import type {
  TjekCatalog,
  TjekCatalogListResponse,
  TjekOffer,
} from "./types";

const TJEK_BASE_URL = "https://squid-api.tjek.com";
const BUNNPRIS_DEALER_ID = "5b11sm";

export interface TjekDealerConfig {
  readonly dealerId: string;
  readonly chainId: string;
  readonly displayName: string;
  readonly catalogTypes: readonly string[];
}

export const TJEK_NORWEGIAN_DEALERS: readonly TjekDealerConfig[] = [
  { dealerId: "5b11sm", chainId: "bunnpris", displayName: "Bunnpris", catalogTypes: ["incito"] },
  { dealerId: "80742m", chainId: "extra", displayName: "Extra", catalogTypes: ["paged"] },
  { dealerId: "faa0Ym", chainId: "rema-1000", displayName: "REMA 1000", catalogTypes: ["paged"] },
];

export interface TjekClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class TjekClientError extends Error {
  constructor(
    readonly code: "SERVER_ERROR" | "CANCELLED" | "RATE_LIMITED" | "NOT_SUPPORTED",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TjekClientError";
  }
}

interface IncitoOfferView {
  readonly id: string;
  readonly role: string;
}

interface IncitoOfferDetail {
  readonly offer?: {
    readonly name?: string;
    readonly price?: number;
    readonly currency_code?: string;
    readonly validity?: { readonly from?: string; readonly to?: string };
    readonly unit_symbol?: string;
    readonly unit_size?: { readonly from?: number; readonly to?: number };
    readonly piece_count?: { readonly from?: number; readonly to?: number };
    readonly before_price?: number;
  };
  readonly name?: string;
  readonly price?: number;
}

export class TjekClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: TjekClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? TJEK_BASE_URL;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private async rpc(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/v4/rpc/${method}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["X-Api-Key"] = this.apiKey;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "req", method, ...body }),
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
    return await response.json();
  }

  async listCatalogs(
    params?: { limit?: number; order_by?: string; dealerId?: string; types?: string | readonly string[] },
    signal?: AbortSignal,
  ): Promise<readonly TjekCatalog[]> {
    const searchParams = new URLSearchParams();
    searchParams.set("dealer_id", params?.dealerId ?? BUNNPRIS_DEALER_ID);
    const types = params?.types;
    searchParams.set("types", types === undefined ? "incito" : typeof types === "string" ? types : [...types].join(","));
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
    if (Array.isArray(data)) return data as readonly TjekCatalog[];
    const wrapped = data as TjekCatalogListResponse;
    return wrapped.catalogs;
  }

  async getLatestCatalog(signal?: AbortSignal): Promise<TjekCatalog | undefined>;
  async getLatestCatalog(dealerId: string, signal?: AbortSignal): Promise<TjekCatalog | undefined>;
  async getLatestCatalog(dealerIdOrSignal?: string | AbortSignal, signal?: AbortSignal): Promise<TjekCatalog | undefined> {
    const dealerId = typeof dealerIdOrSignal === "string" ? dealerIdOrSignal : undefined;
    const requestSignal = typeof dealerIdOrSignal === "string" ? signal : dealerIdOrSignal;
    const catalogs = await this.listCatalogs(
      { limit: 1, order_by: "-publication_date", ...(dealerId === undefined ? {} : { dealerId }) },
      requestSignal,
    );
    return catalogs[0];
  }

  async getAllLatestCatalogs(signal?: AbortSignal): Promise<readonly (TjekCatalog & { readonly chainId: string })[]> {
    const catalogs = await Promise.all(
      TJEK_NORWEGIAN_DEALERS.map((dealer) =>
      this.getLatestCatalogForDealer(dealer, signal),
      ),
    );
    return catalogs
      .filter((catalog): catalog is TjekCatalog => catalog !== undefined)
      .map((catalog) => ({
        ...catalog,
        chainId: TJEK_NORWEGIAN_DEALERS.find((dealer) => dealer.dealerId === catalog.dealer_id)?.chainId ?? catalog.dealer_id,
      }));
  }

  private async getLatestCatalogForDealer(
    dealer: TjekDealerConfig,
    signal?: AbortSignal,
  ): Promise<TjekCatalog | undefined> {
    const catalogs = await this.listCatalogs(
      { limit: 1, order_by: "-publication_date", dealerId: dealer.dealerId, types: dealer.catalogTypes },
      signal,
    );
    return catalogs[0];
  }

  canExtractOffers(catalog: Pick<TjekCatalog, "dealer_id" | "type"> & { readonly types?: readonly string[]; readonly incito_publication_id?: string | null }): boolean {
    const dealer = TJEK_NORWEGIAN_DEALERS.find((candidate) => candidate.dealerId === catalog.dealer_id);
    return dealer !== undefined
      && dealer.catalogTypes.some((type) => catalog.type === type || catalog.types?.includes(type) === true
        || (type === "incito" && Boolean(catalog.incito_publication_id)));
  }

  private async getPagedOffers(catalog: TjekCatalog, signal?: AbortSignal): Promise<readonly TjekOffer[]> {
    const offers: TjekOffer[] = [];
    const ids = new Set<string>();
    const fail = () => new TjekClientError("SERVER_ERROR", "Invalid or incomplete Tjek paged offers");
    if (!Number.isInteger(catalog.offer_count) || catalog.offer_count < 0) throw fail();
    // ponytail: cap at 500 offers / 21 requests; raise only with measured catalog demand.
    for (let page = 0; page < 21; page++) {
      if (signal?.aborted) throw new TjekClientError("CANCELLED", "Request cancelled");
      const query = new URLSearchParams({ dealer_id: catalog.dealer_id, catalog_id: catalog.id, types: "paged", order_by: "page", offset: String(page * 24), limit: "24" });
      const response = await this.fetchFn(`${this.baseUrl}/v2/offers?${query}`, {
        signal, ...(this.apiKey ? { headers: { "X-Api-Key": this.apiKey } } : {}),
      });
      if (response.status === 429) throw new TjekClientError("RATE_LIMITED", "Rate limited by Tjek API");
      if (!response.ok) throw new TjekClientError("SERVER_ERROR", `Tjek API error: ${response.status}`, response.status);
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || rows.length > 24) throw fail();
      for (const raw of rows) {
        if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || ids.has(raw.id)
          || typeof raw.heading !== "string" || raw.catalog_id !== catalog.id || raw.dealer_id !== catalog.dealer_id
          || typeof raw.run_from !== "string" || typeof raw.run_till !== "string"
          || !raw.pricing || typeof raw.pricing !== "object"
          || (raw.pricing.price !== null && (typeof raw.pricing.price !== "number" || !Number.isFinite(raw.pricing.price)))
          || (raw.pricing.pre_price != null && (typeof raw.pricing.pre_price !== "number" || !Number.isFinite(raw.pricing.pre_price)))) throw fail();
        ids.add(raw.id);
        offers.push({
          id: raw.id, heading: raw.heading, name: raw.heading, price: raw.pricing.price,
          price_text: null, before_price: raw.pricing.pre_price ?? null,
          quantity: typeof raw.quantity?.size?.from === "number" ? String(raw.quantity.size.from) : null,
          unit: typeof raw.quantity?.unit?.symbol === "string" ? raw.quantity.unit.symbol : null,
          run_from: raw.run_from, run_till: raw.run_till, catalog_id: catalog.id, dealer_id: catalog.dealer_id,
          image_url: typeof raw.images?.view === "string" ? raw.images.view : null,
          page_number: Number.isInteger(raw.catalog_page) ? raw.catalog_page : null,
          description: typeof raw.description === "string" ? raw.description : null,
          currency: typeof raw.pricing.currency === "string" ? raw.pricing.currency : null, raw,
        });
      }
      if (offers.length > 500) throw fail();
      if (rows.length < 24) {
        if (offers.length === 0 && catalog.offer_count > 0) throw fail();
        return offers;
      }
    }
    throw fail();
  }

  private findOfferViewIds(node: unknown): string[] {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) {
      return node.flatMap((item) => this.findOfferViewIds(item));
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const ids: string[] = [];
      if (obj.role === "offer" && typeof obj.id === "string") {
        ids.push(obj.id);
      }
      for (const value of Object.values(obj)) {
        ids.push(...this.findOfferViewIds(value));
      }
      return ids;
    }
    return [];
  }

  async getOffersFromCatalog(
    catalog: TjekCatalog,
    signal?: AbortSignal,
  ): Promise<readonly TjekOffer[]>;
  async getOffersFromCatalog(
    catalog: string,
    signal?: AbortSignal,
  ): Promise<readonly TjekOffer[]>;
  async getOffersFromCatalog(
    catalog: TjekCatalog | string,
    signal?: AbortSignal,
  ): Promise<readonly TjekOffer[]> {
    const catalogId = typeof catalog === "string" ? catalog : catalog.id;
    const catalogShape: Pick<TjekCatalog, "dealer_id" | "type"> & { readonly types?: readonly string[]; readonly incito_publication_id?: string | null } = typeof catalog === "string"
      ? { dealer_id: BUNNPRIS_DEALER_ID, type: "incito" }
      : catalog;
    if (!this.canExtractOffers(catalogShape)) {
      throw new TjekClientError("NOT_SUPPORTED", "Offer extraction is not supported for this catalog");
    }
    if (typeof catalog !== "string" && (catalog.type === "paged" || catalog.types?.includes("paged"))) {
      return this.getPagedOffers(catalog, signal);
    }
    if (!this.apiKey) {
      throw new TjekClientError("SERVER_ERROR", "Tjek API key required for offer data");
    }
    if (signal?.aborted) {
      throw new TjekClientError("CANCELLED", "Request cancelled");
    }

    // Step 1: Generate incito from publication to discover offer view IDs
    const incito = await this.rpc(
      "generate_incito_from_publication",
      {
        device_category: "mobile",
        id: catalogId,
        max_width: 414,
        orientation: "vertical",
        pointer: "coarse",
        pixel_ratio: 2,
        versions_supported: ["1.0.0"],
      },
      signal,
    );

    const offerViewIds = [...new Set(this.findOfferViewIds(incito))];
    if (offerViewIds.length === 0) return [];

    // Step 2: Fetch each offer's details
    const offers: TjekOffer[] = [];
    for (const viewId of offerViewIds) {
      if (signal?.aborted) throw new TjekClientError("CANCELLED", "Request cancelled");
      const raw = await this.rpc(
        "get_offer_from_incito_publication_view",
        { id: viewId, publication_id: catalogId, view_id: viewId },
        signal,
      ) as Record<string, unknown>;
      const detail = (raw.offer ?? raw) as Record<string, unknown>;
      if (typeof detail.name !== "string" || typeof detail.price !== "number" || !Number.isFinite(detail.price)) {
        throw new TjekClientError("SERVER_ERROR", "Invalid Tjek incito offer");
      }
      const validity = detail.validity as Record<string, unknown> | undefined;
      const unitSize = detail.unit_size as Record<string, unknown> | undefined;
      offers.push({
        id: `${catalogId}:${viewId}`,
        raw,
        description: typeof detail.description === "string" ? detail.description : null,
        currency: typeof detail.currency_code === "string" ? detail.currency_code : null,
        heading: null,
        name: detail.name,
        price: detail.price,
        price_text: null,
        before_price: typeof detail.before_price === "number" ? detail.before_price : null,
        quantity: typeof unitSize?.from === "number" ? String(unitSize.from) : null,
        unit: typeof detail.unit_symbol === "string" ? detail.unit_symbol : null,
        run_from: typeof validity?.from === "string" ? String(validity.from) : "",
        run_till: typeof validity?.to === "string" ? String(validity.to) : "",
        catalog_id: catalogId,
        dealer_id: catalogShape.dealer_id,
        image_url: null,
        page_number: null,
      });
    }
    return offers;
  }
}
