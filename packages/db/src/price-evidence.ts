import { createHash } from "node:crypto";

import type { PriceObservation } from "@handleplan/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { HandleplanDatabase } from "./client";
import {
  canonicalProducts,
  dataSources,
  ingestionRuns,
  priceCoverageChecks,
  priceObservations,
  productIdentifiers,
} from "./schema";

export interface EvidenceMirrorResult {
  appended: number;
  received: number;
  runs: number;
}

export interface PriceEvidenceMirror {
  append(
    rows: PriceObservation<string>[],
    fetchedAt: Date,
    transaction?: HandleplanTransaction,
  ): Promise<EvidenceMirrorResult>;
}

type HandleplanTransaction = Parameters<
  Parameters<HandleplanDatabase["transaction"]>[0]
>[0];

export function evidenceKeyForObservation(
  observation: Pick<
    PriceObservation<string>,
    "amountOre" | "chain" | "ean" | "observedAt" | "source"
  >,
): string {
  return createHash("sha256")
    .update(
      [
        observation.source,
        observation.ean,
        observation.chain,
        observation.observedAt,
        observation.amountOre.toString(),
      ].join("\u0000"),
    )
    .digest("hex");
}

function identifierScheme(ean: string): "ean8" | "ean13" {
  return ean.length === 8 ? "ean8" : "ean13";
}

function groupBySource(
  rows: PriceObservation<string>[],
): Map<string, PriceObservation<string>[]> {
  const groups = new Map<string, PriceObservation<string>[]>();
  for (const row of rows) {
    const group = groups.get(row.source) ?? [];
    group.push(row);
    groups.set(row.source, group);
  }
  return groups;
}

export class PostgresPriceEvidenceMirror implements PriceEvidenceMirror {
  constructor(private readonly db: HandleplanDatabase) {}

  async append(
    rows: PriceObservation<string>[],
    fetchedAt: Date,
    transaction?: HandleplanTransaction,
  ): Promise<EvidenceMirrorResult> {
    if (!Number.isFinite(fetchedAt.getTime())) {
      throw new Error("A valid evidence fetch time is required");
    }
    const eligibleRows = rows.filter(
      ({ observedAt }) => Date.parse(observedAt) <= fetchedAt.getTime(),
    );
    if (eligibleRows.length === 0) {
      return { appended: 0, received: rows.length, runs: 0 };
    }

    const append = (executor: HandleplanTransaction) =>
      this.appendBatches(executor, eligibleRows, fetchedAt, rows.length);
    return transaction === undefined ? this.db.transaction(append) : append(transaction);
  }

  private async appendBatches(
    transaction: HandleplanTransaction,
    rows: PriceObservation<string>[],
    fetchedAt: Date,
    received: number,
  ): Promise<EvidenceMirrorResult> {
    let appended = 0;
    let runs = 0;
    for (const [sourceId, sourceRows] of groupBySource(rows)) {
      appended += await this.appendSourceBatch(transaction, sourceId, sourceRows, fetchedAt);
      runs += 1;
    }
    return { appended, received, runs };
  }

  private async appendSourceBatch(
    transaction: HandleplanTransaction,
    sourceId: string,
    rows: PriceObservation<string>[],
    fetchedAt: Date,
  ): Promise<number> {
    const source = await transaction
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(eq(dataSources.id, sourceId))
        .limit(1);
    if (source.length !== 1) {
      throw new Error(`Evidence source is not registered: ${sourceId}`);
    }

    const [run] = await transaction
        .insert(ingestionRuns)
        .values({
          counts: { received: rows.length },
          runType: "interactive_price_mirror",
          sourceId,
          startedAt: fetchedAt,
          status: "running",
        })
        .returning({ id: ingestionRuns.id });
    if (run === undefined) throw new Error("Could not create evidence ingestion run");

    const productByEan = new Map<string, number>();
    const uniqueEans = [...new Set(rows.map(({ ean }) => ean))].sort();
    const knownIdentifiers = await transaction
        .select({
          productId: productIdentifiers.productId,
          value: productIdentifiers.value,
        })
        .from(productIdentifiers)
        .where(
          and(
            inArray(productIdentifiers.value, uniqueEans),
            inArray(productIdentifiers.scheme, ["ean8", "ean13"]),
          ),
        );
    for (const identifier of knownIdentifiers) {
      productByEan.set(identifier.value, identifier.productId);
    }

    for (const ean of uniqueEans) {
      if (productByEan.has(ean)) continue;
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ean}, 0))`,
      );
      const [concurrentIdentifier] = await transaction
          .select({ productId: productIdentifiers.productId })
          .from(productIdentifiers)
          .where(
            and(
              eq(productIdentifiers.value, ean),
              inArray(productIdentifiers.scheme, ["ean8", "ean13"]),
            ),
          )
          .limit(1);
      if (concurrentIdentifier !== undefined) {
        productByEan.set(ean, concurrentIdentifier.productId);
        continue;
      }

      const [product] = await transaction
          .insert(canonicalProducts)
          .values({
            displayName: `Pending catalog match ${ean}`,
            packageAmount: 1,
            packageUnit: "package",
            status: "quarantined",
            unitsPerPack: 1,
          })
          .returning({ id: canonicalProducts.id });
      if (product === undefined) throw new Error("Could not quarantine unknown product");
      await transaction.insert(productIdentifiers).values({
          confidence: 100,
          productId: product.id,
          scheme: identifierScheme(ean),
          sourceId: null,
          value: ean,
        });
      productByEan.set(ean, product.id);
    }

    const evidenceRows = rows.map((row) => {
      const evidenceKey = evidenceKeyForObservation(row);
      return {
        amountOre: row.amountOre,
        chain: row.chain,
        claimEligibility: "ordinary_only",
        confidence: 70,
        evidenceKey,
        evidenceLevel: "chain",
        fetchedAt,
        ingestionRunId: run.id,
        observedAt: new Date(row.observedAt),
        productId: productByEan.get(row.ean)!,
        rawRecordHash: evidenceKey,
        sourceReference: `normalized-price-observation:${evidenceKey}`,
        sourceId,
      };
    });
    const inserted = await transaction
        .insert(priceObservations)
        .values(evidenceRows)
        .onConflictDoNothing({ target: priceObservations.evidenceKey })
        .returning({ id: priceObservations.id });

    await transaction
        .insert(priceCoverageChecks)
        .values(
          rows.map((row) => ({
            chain: row.chain,
            checkedAt: fetchedAt,
            ingestionRunId: run.id,
            productId: productByEan.get(row.ean)!,
            reason: "interactive_price_mirror_unverified_provenance",
            state: "ineligible",
          })),
        )
        .onConflictDoNothing();

    await transaction
        .update(ingestionRuns)
        .set({
          completedAt: fetchedAt,
          counts: { appended: inserted.length, received: rows.length },
          status: "completed",
        })
        .where(eq(ingestionRuns.id, run.id));

    return inserted.length;
  }
}
