import type { TjekCatalog, TjekOffer } from "./types";

export class FakeTjekClient {
  private catalogs: readonly TjekCatalog[] = [];
  private offers: Map<string, readonly TjekOffer[]> = new Map();

  setCatalogs(catalogs: readonly TjekCatalog[]): void {
    this.catalogs = catalogs;
  }

  setOffers(catalogId: string, offers: readonly TjekOffer[]): void {
    this.offers.set(catalogId, offers);
  }

  async listCatalogs(): Promise<readonly TjekCatalog[]> {
    return this.catalogs;
  }

  async getLatestCatalog(): Promise<TjekCatalog | undefined> {
    return this.catalogs[0];
  }

  async getOffersFromCatalog(catalogId: string): Promise<readonly TjekOffer[]> {
    return this.offers.get(catalogId) ?? [];
  }
}
