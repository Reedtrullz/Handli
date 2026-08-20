export interface OpenPricesLocation {
  readonly id: number;
  readonly osm_id: number;
  readonly osm_type: string;
  readonly osm_name: string | null;
  readonly osm_address_city: string | null;
  readonly osm_address_country: string | null;
  readonly osm_brand: string | null;
  readonly osm_lat: number | null;
  readonly osm_lon: number | null;
  readonly price_count: number;
}

export interface OpenPricesProduct {
  readonly code: string;
  readonly name: string | null;
  readonly brands: string | null;
  readonly quantity: string | null;
}

export interface OpenPricesProof {
  readonly id: number;
  readonly date: string | null;
  readonly type: string | null;
}

export interface OpenPricesPrice {
  readonly id: number;
  readonly product_code: string;
  readonly price: number;
  readonly currency: string;
  readonly date: string;
  readonly price_is_discounted: boolean;
  readonly price_without_discount: number | null;
  readonly unit_price: number | null;
  readonly quantity: number | null;
  readonly location_id: number;
  readonly location_osm_id: number;
  readonly location_osm_type: string;
  readonly owner: string;
  readonly source: string | null;
  readonly tags: string[];
  readonly created: string;
  readonly updated: string;
  readonly proof_id: number | null;
  readonly product?: OpenPricesProduct;
  readonly location?: OpenPricesLocation;
  readonly proof?: OpenPricesProof;
}

export interface OpenPricesApiResponse {
  readonly items: readonly OpenPricesPrice[];
  readonly page: number;
  readonly pages: number;
  readonly size: number;
  readonly total: number;
}

export interface OpenPricesListParams {
  product_code?: string;
  product_code__in?: string;
  currency?: string;
  location_id?: number;
  location_id__in?: string;
  date__gte?: string;
  date__lte?: string;
  page?: number;
  size?: number;
  order_by?: string;
}
