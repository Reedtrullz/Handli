import type { MoneyOre, PriceObservation } from "@handleplan/domain";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { HandleplanDatabase } from "./client";
import type { PriceCache } from "./price-cache";
import {
  canonicalProducts,
  dataSources,
  geographicScopes,
  ingestionRuns,
  priceCoverageChecks,
  priceObservations,
  productIdentifiers,
  sourcePermissions,
} from "./schema";

const newerSourcePermissions = alias(sourcePermissions, "newer_source_permissions");

export type EvidenceReadModelMode = "legacy" | "shadow" | "evidence";

export interface ReadModelComparison {
  evidenceOnly: number;
  legacyOnly: number;
  valueMismatch: number;
}

function rowKey(row: PriceObservation): string {
  return `${row.ean}\u0000${row.chain}`;
}

function valueKey(row: PriceObservation): string {
  return `${row.amountOre}\u0000${row.observedAt}\u0000${row.source}`;
}

export function comparePriceReadModels(
  legacyRows: PriceObservation[],
  evidenceRows: PriceObservation[],
): ReadModelComparison {
  const legacy = new Map(legacyRows.map((row) => [rowKey(row), valueKey(row)]));
  const evidence = new Map(evidenceRows.map((row) => [rowKey(row), valueKey(row)]));
  let legacyOnly = 0;
  let evidenceOnly = 0;
  let valueMismatch = 0;

  for (const [key, value] of legacy) {
    if (!evidence.has(key)) {
      legacyOnly += 1;
    } else if (evidence.get(key) !== value) {
      valueMismatch += 1;
    }
  }
  for (const key of evidence.keys()) {
    if (!legacy.has(key)) evidenceOnly += 1;
  }
  return { evidenceOnly, legacyOnly, valueMismatch };
}

export class PostgresEvidencePriceReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getMany(eans: string[]): Promise<PriceObservation[]> {
    const uniqueEans = [...new Set(eans)];
    if (uniqueEans.length === 0) return [];
    const now = new Date();

    const rows = await this.db
      .select({
        amountOre: priceObservations.amountOre,
        chain: priceObservations.chain,
        ean: productIdentifiers.value,
        id: priceObservations.id,
        observedAt: priceObservations.observedAt,
      })
      .from(priceObservations)
      .innerJoin(
        productIdentifiers,
        eq(productIdentifiers.productId, priceObservations.productId),
      )
      .innerJoin(
        canonicalProducts,
        eq(canonicalProducts.id, priceObservations.productId),
      )
      .innerJoin(dataSources, eq(dataSources.id, priceObservations.sourceId))
      .innerJoin(
        sourcePermissions,
        eq(sourcePermissions.sourceId, priceObservations.sourceId),
      )
      .innerJoin(
        ingestionRuns,
        and(
          eq(ingestionRuns.id, priceObservations.ingestionRunId),
          eq(ingestionRuns.sourceId, priceObservations.sourceId),
        ),
      )
      .innerJoin(
        geographicScopes,
        eq(geographicScopes.id, priceObservations.geographicScopeId),
      )
      .innerJoin(
        priceCoverageChecks,
        and(
          eq(priceCoverageChecks.ingestionRunId, priceObservations.ingestionRunId),
          eq(priceCoverageChecks.productId, priceObservations.productId),
          eq(priceCoverageChecks.chain, priceObservations.chain),
          eq(
            priceCoverageChecks.geographicScopeId,
            priceObservations.geographicScopeId,
          ),
        ),
      )
      .where(
        and(
          inArray(productIdentifiers.value, uniqueEans),
          inArray(productIdentifiers.scheme, ["ean8", "ean13"]),
          eq(productIdentifiers.confidence, 100),
          isNotNull(productIdentifiers.verifiedAt),
          lte(productIdentifiers.verifiedAt, now),
          eq(priceObservations.sourceId, "kassalapp"),
          eq(priceObservations.confidence, 100),
          inArray(priceObservations.claimEligibility, [
            "ordinary_only",
            "historical_eligible",
          ]),
          isNotNull(priceObservations.sourceReference),
          isNotNull(priceObservations.rawRecordHash),
          lte(priceObservations.observedAt, now),
          lte(priceObservations.fetchedAt, now),
          eq(dataSources.runtimeState, "approved"),
          eq(sourcePermissions.decision, "approved"),
          lte(sourcePermissions.reviewedAt, now),
          or(
            isNull(sourcePermissions.validUntil),
            gt(sourcePermissions.validUntil, now),
          ),
          sql<boolean>`${sourcePermissions.permissions} @> '{"ordinaryPrice": true}'::jsonb`,
          notExists(
            this.db
              .select({ id: newerSourcePermissions.id })
              .from(newerSourcePermissions)
              .where(
                and(
                  eq(newerSourcePermissions.sourceId, sourcePermissions.sourceId),
                  or(
                    gt(
                      newerSourcePermissions.reviewedAt,
                      sourcePermissions.reviewedAt,
                    ),
                    and(
                      eq(
                        newerSourcePermissions.reviewedAt,
                        sourcePermissions.reviewedAt,
                      ),
                      gt(newerSourcePermissions.id, sourcePermissions.id),
                    ),
                  ),
                ),
              ),
          ),
          eq(ingestionRuns.status, "completed"),
          isNotNull(ingestionRuns.completedAt),
          lte(ingestionRuns.completedAt, now),
          eq(canonicalProducts.status, "active"),
          eq(geographicScopes.scopeKind, "national"),
          eq(geographicScopes.countryCode, "NO"),
          eq(geographicScopes.status, "active"),
          eq(priceCoverageChecks.state, "priced"),
          lte(priceCoverageChecks.checkedAt, now),
        ),
      )
      .orderBy(desc(priceObservations.observedAt), desc(priceObservations.id));

    const latest = new Map<string, PriceObservation>();
    for (const row of rows) {
      const observation: PriceObservation = {
        amountOre: row.amountOre as MoneyOre,
        chain: row.chain as PriceObservation["chain"],
        ean: row.ean,
        observedAt: row.observedAt.toISOString(),
        source: "kassalapp",
      };
      const key = rowKey(observation);
      if (!latest.has(key)) latest.set(key, observation);
    }
    return [...latest.values()].sort(
      (left, right) =>
        left.ean.localeCompare(right.ean) || left.chain.localeCompare(right.chain),
    );
  }
}

export class EvidenceReadModelPriceCache implements PriceCache {
  constructor(
    private readonly options: {
      evidence: Pick<PriceCache, "getMany">;
      legacy: PriceCache;
      mode: EvidenceReadModelMode;
      onComparison?: (comparison: ReadModelComparison) => void;
      onEvidenceError?: () => void;
    },
  ) {}

  async getMany(eans: string[]): Promise<PriceObservation[]> {
    if (this.options.mode === "legacy") {
      return this.options.legacy.getMany(eans);
    }
    if (this.options.mode === "evidence") {
      return this.options.evidence.getMany(eans);
    }

    const [legacyRows, evidenceRows] = await Promise.all([
      this.options.legacy.getMany(eans),
      this.options.evidence.getMany(eans).catch(() => undefined),
    ]);
    if (evidenceRows === undefined) {
      this.options.onEvidenceError?.();
      return legacyRows;
    }
    this.options.onComparison?.(comparePriceReadModels(legacyRows, evidenceRows));
    return legacyRows;
  }

  async putMany(rows: PriceObservation[], now?: Date): Promise<void> {
    await this.options.legacy.putMany(rows, now);
  }
}
