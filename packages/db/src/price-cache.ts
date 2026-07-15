import { priceObservationSchema, type PriceObservation } from "@handleplan/domain";
import { asc, inArray, sql } from "drizzle-orm";

import type { HandleplanDatabase } from "./client";
import { priceCache, type NewPriceCacheRow, type PriceCacheRow } from "./schema";

export interface PriceCache {
  getMany(eans: string[]): Promise<PriceObservation[]>;
  putMany(rows: PriceObservation[]): Promise<void>;
}

export function toPriceCacheRow(observation: PriceObservation): NewPriceCacheRow {
  return {
    ean: observation.ean,
    chain: observation.chain,
    amountOre: observation.amountOre,
    observedAt: new Date(observation.observedAt),
  };
}

export function fromPriceCacheRow(
  row: Pick<PriceCacheRow, "ean" | "chain" | "amountOre" | "observedAt">,
): PriceObservation {
  return priceObservationSchema.parse({
    ean: row.ean,
    chain: row.chain,
    amountOre: row.amountOre,
    observedAt: row.observedAt.toISOString(),
    source: "kassalapp",
  });
}

export function dedupePriceObservations(rows: PriceObservation[]): PriceObservation[] {
  const byKey = new Map<string, PriceObservation>();

  for (const row of rows) {
    byKey.set(`${row.ean}\u0000${row.chain}`, row);
  }

  return [...byKey.values()];
}

export class PostgresPriceCache implements PriceCache {
  constructor(private readonly db: HandleplanDatabase) {}

  async getMany(eans: string[]): Promise<PriceObservation[]> {
    const uniqueEans = [...new Set(eans)];
    if (uniqueEans.length === 0) return [];

    const rows = await this.db
      .select()
      .from(priceCache)
      .where(inArray(priceCache.ean, uniqueEans))
      .orderBy(asc(priceCache.ean), asc(priceCache.chain));

    return rows.map(fromPriceCacheRow);
  }

  async putMany(rows: PriceObservation[]): Promise<void> {
    const dedupedRows = dedupePriceObservations(rows);
    if (dedupedRows.length === 0) return;

    await this.db
      .insert(priceCache)
      .values(dedupedRows.map(toPriceCacheRow))
      .onConflictDoUpdate({
        target: [priceCache.ean, priceCache.chain],
        set: {
          amountOre: sql`excluded.amount_ore`,
          observedAt: sql`excluded.observed_at`,
          fetchedAt: sql`now()`,
        },
      });
  }
}
