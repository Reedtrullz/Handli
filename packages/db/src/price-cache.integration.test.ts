import type { MoneyOre, PriceObservation } from "@handleplan/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresPriceCache,
  fromPriceCacheRow,
  toPriceCacheRow,
} from "./price-cache";

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

  it("returns no observations for an empty lookup", async () => {
    await expect(cache.getMany([])).resolves.toEqual([]);
  });
});
