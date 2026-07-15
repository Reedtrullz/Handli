import "server-only";

import { PostgresPriceCache, type PriceCache } from "@handleplan/db";
import { createDatabase } from "@handleplan/db/client";
import type { PriceObservation, Product } from "@handleplan/domain";
import { FakeKassalappGateway, KassalappClient, type KassalappGateway } from "@handleplan/kassalapp";

import { readServerEnv, type ServerEnv } from "./env";
import { PlanService, type PlanServiceContract } from "./plan-service";

export interface ServerContainer {
  gateway: KassalappGateway;
  planService: PlanServiceContract;
}

let singleton: ServerContainer | undefined;

export const FAKE_EVALUATION_TIME = "2026-07-15T12:00:00.000Z";
const FRESH_OBSERVED_AT = "2026-07-15T10:00:00.000Z";
const STALE_OBSERVED_AT = "2026-07-12T11:59:59.999Z";

const fakeProducts = [
  { ean: "7038010000013", name: "TINE Lettmelk 1 % 1 l", brand: "TINE", packageQuantity: 1000, packageUnit: "ml", productFamily: "lettmelk" },
  { ean: "7038010000020", name: "Evergood Kaffe 500 g", brand: "Evergood", packageQuantity: 500, packageUnit: "g", productFamily: "kaffe" },
  { ean: "7038010000037", name: "Norsk grovbrød 750 g", brand: "Bakehuset", packageQuantity: 750, packageUnit: "g", productFamily: "brød" },
  { ean: "7038010000044", name: "Stale testvare 1 stk", brand: "Test", packageQuantity: 1, packageUnit: "each", productFamily: "stale" },
] satisfies Product[];

function fakePrice(ean: string, chain: PriceObservation["chain"], amountOre: number, observedAt = FRESH_OBSERVED_AT): PriceObservation {
  return { ean, chain, amountOre: amountOre as PriceObservation["amountOre"], observedAt, source: "kassalapp" };
}

const fakePrices: PriceObservation[] = [
  fakePrice("7038010000013", "bunnpris", 2000),
  fakePrice("7038010000013", "rema-1000", 2500),
  fakePrice("7038010000013", "extra", 2600),
  fakePrice("7038010000020", "bunnpris", 5500),
  fakePrice("7038010000020", "rema-1000", 6000),
  fakePrice("7038010000020", "extra", 4000),
  fakePrice("7038010000037", "bunnpris", 3500),
  fakePrice("7038010000037", "rema-1000", 2000),
  fakePrice("7038010000037", "extra", 3200),
  fakePrice("7038010000044", "extra", 100, STALE_OBSERVED_AT),
];

class MemoryPriceCache implements PriceCache {
  private rows: PriceObservation[] = [];

  async getMany(eans: string[]): Promise<PriceObservation[]> {
    const selected = new Set(eans);
    return this.rows.filter(({ ean }) => selected.has(ean)).map((row) => ({ ...row }));
  }

  async putMany(rows: PriceObservation[]): Promise<void> {
    this.rows = rows.map((row) => ({ ...row }));
  }
}

export function createServerContainer(env: ServerEnv): ServerContainer {
  if (env.mode === "fake") {
    const gateway = new FakeKassalappGateway(fakeProducts, fakePrices);
    return {
      gateway,
      planService: new PlanService({
        cache: new MemoryPriceCache(),
        gateway,
        now: () => new Date(FAKE_EVALUATION_TIME),
      }),
    };
  }

  const connection = createDatabase(env.DATABASE_URL);
  const gateway = new KassalappClient({
    apiKey: env.KASSAL_API_KEY,
    baseUrl: env.KASSAL_BASE_URL,
    fetch,
  });
  return {
    gateway,
    planService: new PlanService({
      cache: new PostgresPriceCache(connection.db),
      gateway,
    }),
  };
}

export function getServerContainer(): ServerContainer {
  if (singleton !== undefined) return singleton;
  singleton = createServerContainer(readServerEnv());
  return singleton;
}
