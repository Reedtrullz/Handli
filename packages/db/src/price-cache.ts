import { priceObservationSchema, type PriceObservation } from "@handleplan/domain";
import { asc, inArray, lt, sql } from "drizzle-orm";

import type { HandleplanDatabase } from "./client";
import {
  PostgresPriceEvidenceMirror,
  type PriceEvidenceMirror,
} from "./price-evidence";
import { priceCache, type NewPriceCacheRow, type PriceCacheRow } from "./schema";

export interface PriceCache {
  getMany(eans: string[]): Promise<PriceObservation[]>;
  putMany(rows: PriceObservation[], now?: Date): Promise<void>;
}

export const cacheReplacementCondition = lt(
  priceCache.observedAt,
  sql.raw('excluded."observed_at"'),
);

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
    const key = `${row.ean}\u0000${row.chain}`;
    const previous = byKey.get(key);
    // A batch keeps its last equal-timestamp input. Once persisted, the strict
    // conflict condition below preserves the existing row on equal timestamps.
    if (previous === undefined || row.observedAt >= previous.observedAt) {
      byKey.set(key, row);
    }
  }

  return [...byKey.values()];
}

export function filterCacheablePriceObservations(
  rows: PriceObservation[],
  now: Date,
): PriceObservation[] {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("A valid cache observation boundary is required");
  }
  return rows.filter((row) => new Date(row.observedAt).getTime() <= now.getTime());
}

export class PostgresPriceCache implements PriceCache {
  private readonly evidenceMirror: PriceEvidenceMirror;

  constructor(
    private readonly db: HandleplanDatabase,
    evidenceMirror?: PriceEvidenceMirror,
  ) {
    this.evidenceMirror = evidenceMirror ?? new PostgresPriceEvidenceMirror(db);
  }

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

  async putMany(rows: PriceObservation[], now: Date = new Date()): Promise<void> {
    const cacheableRows = filterCacheablePriceObservations(rows, now);
    const dedupedRows = dedupePriceObservations(cacheableRows);
    if (dedupedRows.length === 0) return;

    await this.db.transaction(async (transaction) => {
      await transaction
        .insert(priceCache)
        .values(dedupedRows.map(toPriceCacheRow))
        .onConflictDoUpdate({
          target: [priceCache.ean, priceCache.chain],
          set: {
            amountOre: sql`excluded.amount_ore`,
            observedAt: sql`excluded.observed_at`,
            fetchedAt: sql`now()`,
          },
          setWhere: cacheReplacementCondition,
        });
      await this.evidenceMirror.append(cacheableRows, now, transaction);
    });
  }
}

export {
  PostgresPriceEvidenceMirror,
  evidenceKeyForObservation,
  type EvidenceMirrorResult,
  type PriceEvidenceMirror,
} from "./price-evidence";
export {
  EvidenceReadModelPriceCache,
  PostgresEvidencePriceReader,
  comparePriceReadModels,
  type EvidenceReadModelMode,
  type ReadModelComparison,
} from "./price-read-model";
