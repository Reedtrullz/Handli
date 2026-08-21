// Based on squid-api.tjek.com/v2/catalogs response shape
export interface TjekCatalog {
  readonly id: string;
  readonly dealer_id: string;
  readonly publication_date: string;
  readonly run_from: string;
  readonly run_till: string;
  readonly offer_count: number;
  readonly brand: string;
  readonly brand_logo_url: string | null;
  readonly cover_image_url: string | null;
  readonly page_count: number;
  readonly type: string;
  readonly types?: readonly string[];
  readonly incito_publication_id?: string | null;
  readonly locale: string;
  readonly country_code: string;
}

export interface TjekCatalogListResponse {
  readonly catalogs: readonly TjekCatalog[];
  readonly total: number;
}

export interface TjekOffer {
  readonly id: string;
  readonly heading: string | null;
  readonly name: string;
  readonly price: number | null;
  readonly price_text: string | null;
  readonly before_price: number | null;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly run_from: string;
  readonly run_till: string;
  readonly catalog_id: string;
  readonly dealer_id: string;
  readonly image_url: string | null;
  readonly page_number: number | null;
}

export interface TjekRpcRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface TjekRpcOfferResponseItem {
  readonly id?: string;
  readonly heading?: string;
  readonly name?: string;
  readonly price?: number;
  readonly price_text?: string;
  readonly before_price?: number;
  readonly quantity?: string;
  readonly unit?: string;
  readonly run_from?: string;
  readonly run_till?: string;
  readonly image_url?: string;
  readonly page_number?: number;
}
