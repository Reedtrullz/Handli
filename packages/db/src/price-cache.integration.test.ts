import type { MoneyOre, PriceObservation } from "@handleplan/domain";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresPriceCache,
  dedupePriceObservations,
  fromPriceCacheRow,
  toPriceCacheRow,
} from "./price-cache";
import { priceCache } from "./schema";

const observation: PriceObservation = {
  ean: "7038010000134",
  chain: "extra",
  amountOre: 2490 as MoneyOre,
  observedAt: "2026-07-15T08:30:00.000Z",
  source: "kassalapp",
};

describe("price-cache mappings", () => {
  it("round-trips a domain observation without inventing source data", () => {
    expect(fromPriceCacheRow(toPriceCacheRow(observation))).toEqual(observation);
  });

  it("fails closed when persisted money data is invalid", () => {
    expect(() =>
      fromPriceCacheRow({
        ean: observation.ean,
        chain: observation.chain,
        amountOre: -1,
        observedAt: new Date(observation.observedAt),
      }),
    ).toThrow();
  });

  it("preserves every accepted timestamp form exactly", () => {
    const accepted = ["2026-07-15T08:30:00.000Z"];

    for (const observedAt of accepted) {
      const candidate = { ...observation, observedAt };
      expect(fromPriceCacheRow(toPriceCacheRow(candidate))).toEqual(candidate);
    }
  });

  it("keeps the last input for duplicate EAN and chain keys", () => {
    const replacement = {
      ...observation,
      amountOre: 1990 as MoneyOre,
      observedAt: "2026-07-15T09:00:00.000Z",
    };

    expect(dedupePriceObservations([observation, replacement])).toEqual([replacement]);
  });

  it("declares fail-closed database checks", () => {
    expect(getTableConfig(priceCache).checks.map(({ name }) => name).sort()).toEqual([
      "price_cache_amount_ore_nonnegative",
      "price_cache_chain_supported",
      "price_cache_ean_shape",
    ]);
  });
});

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";

describe.skipIf(!runDatabaseIntegration)("PostgresPriceCache integration", () => {
  let connection: DatabaseConnection;
  let cache: PostgresPriceCache;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    }
    connection = createDatabase(process.env.DATABASE_URL);
    cache = new PostgresPriceCache(connection.db);
    await connection.sql`delete from price_cache`;
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("upserts and retrieves observations by EAN", async () => {
    await cache.putMany([observation]);

    await expect(cache.getMany([observation.ean])).resolves.toEqual([observation]);
  });

  it("uses the last duplicate in one batch and replaces it on a later write", async () => {
    const duplicate = {
      ...observation,
      amountOre: 2190 as MoneyOre,
      observedAt: "2026-07-15T09:00:00.000Z",
    };
    const sequential = {
      ...observation,
      amountOre: 1990 as MoneyOre,
      observedAt: "2026-07-15T10:00:00.000Z",
    };

    await cache.putMany([observation, duplicate]);
    await expect(cache.getMany([observation.ean])).resolves.toEqual([duplicate]);

    await cache.putMany([sequential]);
    await expect(cache.getMany([observation.ean])).resolves.toEqual([sequential]);
  });

  it("returns no observations for an empty lookup", async () => {
    await expect(cache.getMany([])).resolves.toEqual([]);
  });
});
