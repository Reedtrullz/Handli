import type { OpenPricesLocation } from "./types";

export type HandleplanChainId = "bunnpris" | "extra" | "rema-1000";

const CHAIN_BY_LOCATION_ID: ReadonlyMap<number, HandleplanChainId> = new Map([
  [2728, "rema-1000"], [3583, "rema-1000"], [357, "rema-1000"], [497, "rema-1000"],
  [2729, "bunnpris"], [619, "bunnpris"], [4006, "bunnpris"], [6255, "bunnpris"], [6543, "bunnpris"],
  [3568, "extra"], [341, "extra"], [3148, "extra"], [3663, "extra"], [4210, "extra"], [4418, "extra"], [5454, "extra"],
]);

const CHAIN_BY_OSM_BRAND: ReadonlyMap<string, HandleplanChainId> = new Map([
  ["rema 1000", "rema-1000"], ["rema1000", "rema-1000"],
  ["bunnpris", "bunnpris"],
  ["coop extra", "extra"], ["extra", "extra"],
]);

const SUPPORTED_CHAINS: ReadonlySet<HandleplanChainId> = new Set(["bunnpris", "extra", "rema-1000"]);

export function resolveChainFromLocation(
  location: Pick<OpenPricesLocation, "id" | "osm_brand" | "osm_name">,
): HandleplanChainId | undefined {
  const byId = CHAIN_BY_LOCATION_ID.get(location.id);
  if (byId !== undefined) return byId;
  const brand = location.osm_brand?.toLowerCase().trim();
  if (brand !== undefined) {
    const byBrand = CHAIN_BY_OSM_BRAND.get(brand);
    if (byBrand !== undefined) return byBrand;
  }
  const name = location.osm_name?.toLowerCase().trim();
  if (name !== undefined) {
    for (const [pattern, chain] of CHAIN_BY_OSM_BRAND) {
      if (name.includes(pattern)) return chain;
    }
  }
  return undefined;
}

export function isSupportedChain(chain: string): chain is HandleplanChainId {
  return SUPPORTED_CHAINS.has(chain as HandleplanChainId);
}

export const NORWEGIAN_LOCATION_IDS: readonly number[] = [...CHAIN_BY_LOCATION_ID.keys()];

export function norwegianLocationIdFilter(): string {
  return NORWEGIAN_LOCATION_IDS.join(",");
}
