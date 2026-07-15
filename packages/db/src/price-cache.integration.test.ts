import type { MoneyOre, PriceObservation } from "@handleplan/domain";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  PostgresPriceCache,
  cacheReplacementCondition,
  dedupePriceObservations,
  filterCacheablePriceObservations,
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

  it("keeps the newest observation when an older duplicate arrives later", () => {
    const newer = { ...observation, observedAt: "2026-07-15T10:00:00.000Z" };

    expect(dedupePriceObservations([newer, observation])).toEqual([newer]);
  });

  it("filters future rows but retains stale history for visibility", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const future = {
      ...observation,
      ean: "7038010000141",
      observedAt: "2026-07-15T12:00:00.001Z",
    };
    const historical = {
      ...observation,
      ean: "7038010000158",
      observedAt: "2026-06-01T08:30:00.000Z",
    };

    expect(filterCacheablePriceObservations([future, historical], now)).toEqual([historical]);
  });

  it("generates an atomic strict-newer conflict policy", () => {
    const query = new PgDialect().sqlToQuery(cacheReplacementCondition);

    expect(query.sql).toContain('"price_cache"."observed_at" < excluded."observed_at"');
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

  it("does not replace fresh state with older or future incoming observations", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const current = {
      ...observation,
      ean: "7038010000165",
      observedAt: "2026-07-15T10:00:00.000Z",
    };
    const older = {
      ...current,
      amountOre: 1000 as MoneyOre,
      observedAt: "2026-07-15T09:00:00.000Z",
    };
    const equalTimestamp = {
      ...current,
      amountOre: 700 as MoneyOre,
    };
    const future = {
      ...current,
      amountOre: 500 as MoneyOre,
      observedAt: "2026-07-15T12:00:00.001Z",
    };
    const futureOnly = { ...future, ean: "7038010000172" };

    await cache.putMany([current], now);
    await cache.putMany([older, equalTimestamp, future, futureOnly], now);

    await expect(cache.getMany([current.ean, futureOnly.ean])).resolves.toEqual([current]);
  });
});
