import type { OpenPricesApiResponse, OpenPricesListParams, OpenPricesPrice } from "./types";

export class FakeOpenPricesClient {
  private responses: Map<string, OpenPricesApiResponse> = new Map();
  private defaultResponse: OpenPricesApiResponse = {
    items: [], page: 1, pages: 1, size: 0, total: 0,
  };

  setResponse(key: string, response: OpenPricesApiResponse): void {
    this.responses.set(key, response);
  }

  setDefaultResponse(response: OpenPricesApiResponse): void {
    this.defaultResponse = response;
  }

  async listPrices(params: OpenPricesListParams): Promise<OpenPricesApiResponse> {
    const key = params.product_code__in ?? params.product_code ?? "default";
    return this.responses.get(key) ?? this.defaultResponse;
  }

  async getPricesForGtins(gtins: readonly string[]): Promise<readonly OpenPricesPrice[]> {
    const allItems: OpenPricesPrice[] = [];
    for (const gtin of gtins) {
      const response = this.responses.get(gtin);
      if (response !== undefined) allItems.push(...response.items);
    }
    return allItems;
  }
}
