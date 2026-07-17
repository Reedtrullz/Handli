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
  type PriceEvidenceMirror,
} from "./price-cache";
import { evidenceKeyForObservation } from "./price-evidence";
import { PostgresEvidencePriceReader } from "./price-read-model";
import { priceCache } from "./schema";

const observation: PriceObservation = {
  ean: "7038010000133",
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
      ean: "7038010000140",
      observedAt: "2026-07-15T12:00:00.001Z",
    };
    const historical = {
      ...observation,
      ean: "7038010000157",
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

  it("derives a stable evidence identity without exposing raw record content", () => {
    expect(evidenceKeyForObservation(observation)).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceKeyForObservation({ ...observation })).toBe(
      evidenceKeyForObservation(observation),
    );
    expect(
      evidenceKeyForObservation({ ...observation, amountOre: 2491 as MoneyOre }),
    ).not.toBe(evidenceKeyForObservation(observation));
  });
});

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const integrationNonce = String(Date.now() % 1_000_000_000).padStart(9, "0");

function integrationEan(suffix: number): string {
  return `703${integrationNonce.slice(0, 8)}${String(suffix).padStart(2, "0")}`;
}

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Price-cache integration fixture returned an invalid database timestamp");
  }
  return parsed;
}

describe.skipIf(!runDatabaseIntegration)("PostgresPriceCache integration", () => {
  let connection: DatabaseConnection;
  let cache: PostgresPriceCache;

  async function evidenceReaderAtDatabaseNow(): Promise<PostgresEvidencePriceReader> {
    const [clock] = await connection.sql`
      select clock_timestamp() as snapshot_at
    `;
    return new PostgresEvidencePriceReader(
      connection.db,
      () => databaseDate(clock?.snapshot_at),
    );
  }

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
      ean: "7038010000164",
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
    const futureOnly = { ...future, ean: "7038010000171" };

    await cache.putMany([current], now);
    await cache.putMany([older, equalTimestamp, future, futureOnly], now);

    await expect(cache.getMany([current.ean, futureOnly.ean])).resolves.toEqual([current]);
  });

  it("mirrors cache writes into immutable evidence without duplicating an observation", async () => {
    const first = {
      ...observation,
      ean: integrationEan(0),
      observedAt: "2026-07-15T10:00:00.000Z",
    };
    const newer = {
      ...first,
      amountOre: 2390 as MoneyOre,
      observedAt: "2026-07-15T11:00:00.000Z",
    };

    await cache.putMany([first], new Date("2026-07-15T12:00:00.000Z"));
    await cache.putMany([first], new Date("2026-07-15T12:01:00.000Z"));

    const afterDuplicate = await connection.sql`
      select
        price_observations.evidence_key,
        price_observations.source_id,
        price_observations.claim_eligibility,
        canonical_products.status as product_status,
        product_identifiers.source_id as identifier_source_id,
        price_coverage_checks.state as coverage_state,
        price_coverage_checks.reason as coverage_reason
      from price_observations
      join canonical_products on canonical_products.id = price_observations.product_id
      join product_identifiers on product_identifiers.product_id = canonical_products.id
      join price_coverage_checks
        on price_coverage_checks.ingestion_run_id = price_observations.ingestion_run_id
       and price_coverage_checks.product_id = price_observations.product_id
       and price_coverage_checks.chain = price_observations.chain
      where product_identifiers.value = ${first.ean}
        and price_observations.source_id = 'kassalapp'
      order by price_observations.observed_at
    `;
    expect(afterDuplicate).toEqual([
      expect.objectContaining({
        claim_eligibility: "ordinary_only",
        coverage_reason: "interactive_price_mirror_unverified_provenance",
        coverage_state: "ineligible",
        evidence_key: evidenceKeyForObservation(first),
        identifier_source_id: null,
        product_status: "quarantined",
        source_id: "kassalapp",
      }),
    ]);

    await cache.putMany([newer], new Date("2026-07-15T12:02:00.000Z"));
    const immutableHistory = await connection.sql`
      select amount_ore, observed_at
      from price_observations
      where product_id = (
        select product_id from product_identifiers where value = ${first.ean}
      )
        and source_id = 'kassalapp'
      order by observed_at
    `;
    expect(immutableHistory).toHaveLength(2);
    expect(immutableHistory.map(({ amount_ore: amountOre }) => amountOre)).toEqual([
      first.amountOre,
      newer.amountOre,
    ]);
  });

  it("preserves every distinct observation when one cache batch has the same EAN and chain", async () => {
    const first = {
      ...observation,
      ean: integrationEan(1),
      observedAt: "2026-07-15T10:00:00.000Z",
    };
    const newer = {
      ...first,
      amountOre: 2390 as MoneyOre,
      observedAt: "2026-07-15T11:00:00.000Z",
    };

    await cache.putMany([first, newer], new Date("2026-07-15T12:00:00.000Z"));

    const history = await connection.sql`
      select amount_ore, observed_at
      from price_observations
      where product_id = (
        select product_id from product_identifiers
        where scheme in ('ean8', 'ean13') and value = ${first.ean}
      )
        and source_id = 'kassalapp'
      order by observed_at
    `;
    expect(history.map(({ amount_ore: amountOre }) => amountOre)).toEqual([
      first.amountOre,
      newer.amountOre,
    ]);
    await expect(cache.getMany([first.ean])).resolves.toEqual([newer]);
  });

  it("rolls back the legacy write when evidence mirroring fails", async () => {
    const failingMirror: PriceEvidenceMirror = {
      append: async () => {
        throw new Error("mirror unavailable");
      },
    };
    const atomicCache = new PostgresPriceCache(connection.db, failingMirror);
    const candidate = { ...observation, ean: integrationEan(2) };

    await expect(atomicCache.putMany([candidate])).rejects.toThrow("mirror unavailable");
    await expect(cache.getMany([candidate.ean])).resolves.toEqual([]);
  });

  it("resolves an EAN only through an EAN identifier scheme", async () => {
    const ean = integrationEan(3);
    const [wrongProduct] = await connection.sql`
      insert into canonical_products (
        display_name, package_amount, package_unit, units_per_pack, status
      ) values ('Numeric source-id collision', 1, 'package', 1, 'active')
      returning id
    `;
    await connection.sql`
      insert into product_identifiers (
        product_id, scheme, value, source_id, confidence
      ) values (${wrongProduct!.id}, 'source', ${ean}, 'kassalapp', 100)
    `;

    await cache.putMany([{ ...observation, ean }]);

    const [resolved] = await connection.sql`
      select po.product_id, pi.scheme
      from price_observations po
      join product_identifiers pi on pi.product_id = po.product_id
      where po.source_id = 'kassalapp'
        and pi.value = ${ean}
        and pi.scheme in ('ean8', 'ean13')
    `;
    expect(resolved).toBeDefined();
    expect(resolved!.product_id).not.toBe(wrongProduct!.id);
    expect(resolved!.scheme).toBe('ean13');
  });

  it("enforces canonical and source-owned identifier scope in PostgreSQL", async () => {
    const [firstProduct, secondProduct] = await connection.sql`
      insert into canonical_products (
        display_name, package_amount, package_unit, units_per_pack, status
      ) values
        (${`Identifier scope A ${integrationNonce}`}, 1, 'package', 1, 'active'),
        (${`Identifier scope B ${integrationNonce}`}, 1, 'package', 1, 'active')
      returning id
    `;
    const scopedValue = `shared-source-id-${integrationNonce}`;

    await expect(
      connection.sql`
        insert into product_identifiers (
          product_id, scheme, value, source_id, confidence
        ) values (${firstProduct!.id}, 'ean13', ${integrationEan(4)}, 'kassalapp', 100)
      `,
    ).rejects.toThrow(/product_identifiers_source_scope/i);
    await expect(
      connection.sql`
        insert into product_identifiers (
          product_id, scheme, value, source_id, confidence
        ) values (${firstProduct!.id}, 'source', ${`unowned-${integrationNonce}`}, null, 100)
      `,
    ).rejects.toThrow(/product_identifiers_source_scope/i);

    await connection.sql`
      insert into product_identifiers (
        product_id, scheme, value, source_id, confidence
      ) values
        (${firstProduct!.id}, 'source', ${scopedValue}, 'kassalapp', 100),
        (${secondProduct!.id}, 'source', ${scopedValue}, 'legacy-import', 100)
    `;
    await expect(
      connection.sql`
        insert into product_identifiers (
          product_id, scheme, value, source_id, confidence
        ) values (${secondProduct!.id}, 'source', ${scopedValue}, 'kassalapp', 100)
      `,
    ).rejects.toThrow(/product_identifiers_source_value_unique/i);

    const canonicalEan = integrationEan(5);
    await connection.sql`
      insert into product_identifiers (
        product_id, scheme, value, source_id, confidence
      ) values (${firstProduct!.id}, 'ean13', ${canonicalEan}, null, 100)
    `;
    await expect(
      connection.sql`
        insert into product_identifiers (
          product_id, scheme, value, source_id, confidence
        ) values (${secondProduct!.id}, 'ean13', ${canonicalEan}, null, 100)
      `,
    ).rejects.toThrow(/product_identifiers_gtin_value_unique/i);
  });

  it("requires the latest approved permission audit and a completed ingestion run", async () => {
    const reader = new PostgresEvidencePriceReader(connection.db);
    const quarantined = { ...observation, ean: integrationEan(6) };
    await cache.putMany([quarantined]);

    await expect(reader.getMany([quarantined.ean])).resolves.toEqual([]);

    const eligibleEan = integrationEan(7);
    const failedRunEan = integrationEan(8);
    const runningRunEan = integrationEan(9);
    const futureRunEan = integrationEan(10);
    const futureVerificationEan = integrationEan(11);
    const futureObservationEan = integrationEan(12);
    const futureFetchEan = integrationEan(13);
    const futureCoverageEan = integrationEan(14);
    const lateTerminalEan = integrationEan(15);
    const mutableIdentifierEan = integrationEan(16);
    const mutableProductEan = integrationEan(17);
    const mutableScopeEan = integrationEan(18);
    const eligibleObservedAt = "2026-07-15T11:00:00.000Z";
    const futureAt = new Date(Date.now() + 60_000).toISOString();
    const furtherFutureAt = new Date(Date.now() + 120_000).toISOString();
    await connection.sql`
      update data_sources
      set runtime_state = 'approved',
          permission_reviewed_at = now(),
          permission_expires_at = now() + interval '1 day'
      where id = 'kassalapp'
    `;
    try {
      const [scope] = await connection.sql`
        insert into geographic_scopes (
          scope_key, scope_kind, label, country_code, status
        ) values (
          ${`test:national:${integrationNonce}`}, 'national', 'Test national', 'NO', 'active'
        )
        returning id
      `;

      const insertEvidence = async (
        ean: string,
        runStatus: "completed" | "failed" | "running",
        overrides: {
          checkedAt?: string;
          completedAt?: string | null;
          createdAt?: string;
          fetchedAt?: string;
          observedAt?: string;
          verifiedAt?: string;
        } = {},
      ) => {
        const [product] = await connection.sql`
          insert into canonical_products (
            display_name, package_amount, package_unit, units_per_pack, status,
            created_at
          ) values (
            ${`Reader evidence ${ean}`}, 1, 'package', 1, 'active',
            coalesce(${overrides.createdAt ?? null}::timestamptz, now())
          )
          returning id
        `;
        await connection.sql`
          insert into product_identifiers (
            product_id, scheme, value, source_id, confidence, verified_at,
            created_at
          ) values (
            ${product!.id}, 'ean13', ${ean}, null, 100,
            ${overrides.verifiedAt ?? new Date().toISOString()},
            coalesce(${overrides.createdAt ?? null}::timestamptz, now())
          )
        `;
        const completedAt = overrides.completedAt === undefined
          ? runStatus === "running"
            ? null
            : new Date().toISOString()
          : overrides.completedAt;
        const [run] = await connection.sql`
          insert into ingestion_runs (
            source_id, run_type, status, started_at, completed_at, counts,
            created_at
          ) values (
            'kassalapp', 'benchmark-prices', 'running',
            ${overrides.createdAt ?? new Date(Date.now() - 1_000).toISOString()},
            null, '{}',
            coalesce(${overrides.createdAt ?? null}::timestamptz, now())
          )
          returning id
        `;
        const [evidence] = await connection.sql`
          insert into price_observations (
            evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
            source_id, source_reference, ingestion_run_id, geographic_scope_id,
            evidence_level, confidence, claim_eligibility, raw_record_hash,
            created_at
          ) values (
            ${`eligible-reader-${ean}-${integrationNonce}`}, ${product!.id}, 'extra',
            2490, ${overrides.observedAt ?? eligibleObservedAt},
            ${overrides.fetchedAt ?? "2026-07-15T12:00:00.000Z"}, 'kassalapp',
            'fixture:eligible-reader', ${run!.id}, ${scope!.id}, 'chain', 100,
            'ordinary_only',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            coalesce(${overrides.createdAt ?? null}::timestamptz, now())
          )
          returning id
        `;
        await connection.sql`
          insert into price_coverage_checks (
            ingestion_run_id, product_id, chain, geographic_scope_id,
            state, reason, checked_at, created_at
          ) values (
            ${run!.id}, ${product!.id}, 'extra', ${scope!.id},
            'priced', 'eligible_reader_test',
            ${overrides.checkedAt ?? "2026-07-15T12:00:00.000Z"},
            coalesce(${overrides.createdAt ?? null}::timestamptz, now())
          )
        `;
        if (runStatus !== "running") {
          await connection.sql`
            update ingestion_runs
            set status = ${runStatus}, completed_at = ${completedAt}
            where id = ${run!.id}
          `;
        }
        expect(evidence).toBeDefined();
        return run!.id as number;
      };

      await insertEvidence(eligibleEan, "completed");
      await insertEvidence(failedRunEan, "failed");
      await insertEvidence(runningRunEan, "running");
      await insertEvidence(futureRunEan, "completed", { completedAt: futureAt });
      await insertEvidence(futureVerificationEan, "completed", {
        verifiedAt: futureAt,
      });
      await insertEvidence(futureObservationEan, "completed", {
        fetchedAt: furtherFutureAt,
        observedAt: futureAt,
      });
      await insertEvidence(futureFetchEan, "completed", { fetchedAt: futureAt });
      await insertEvidence(futureCoverageEan, "completed", { checkedAt: futureAt });
      await insertEvidence(mutableIdentifierEan, "completed");
      await insertEvidence(mutableProductEan, "completed");
      await insertEvidence(mutableScopeEan, "completed");

      await expect(
        reader.getMany([
          eligibleEan,
          failedRunEan,
          runningRunEan,
          futureRunEan,
          futureVerificationEan,
          futureObservationEan,
          futureFetchEan,
          futureCoverageEan,
        ]),
      ).resolves.toEqual([]);

      const insufficientPermissionAt = new Date(Date.now() - 200).toISOString();
      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          'kassalapp', 'approved', ${insufficientPermissionAt},
          ${new Date(Date.now() + 60_000).toISOString()},
          '{"ordinaryPrice": false}'::jsonb,
          ${`reader-without-ordinary-price-${integrationNonce}`}
        )
      `;
      await expect(reader.getMany([eligibleEan])).resolves.toEqual([]);

      const approvedAt = new Date(Date.now() - 100).toISOString();
      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          'kassalapp', 'approved', ${approvedAt},
          ${new Date(Date.now() + 60_000).toISOString()},
          '{"ordinaryPrice": true}'::jsonb, ${`reader-approved-${integrationNonce}`}
        )
      `;

      const approvedReader = await evidenceReaderAtDatabaseNow();
      await expect(approvedReader.getMany([eligibleEan, quarantined.ean])).resolves.toEqual([
        {
          amountOre: 2490,
          chain: "extra",
          ean: eligibleEan,
          observedAt: eligibleObservedAt,
          source: "kassalapp",
        },
      ]);
      await expect(
        approvedReader.getMany([
          failedRunEan,
          runningRunEan,
          futureRunEan,
          futureVerificationEan,
          futureObservationEan,
          futureFetchEan,
          futureCoverageEan,
        ]),
      ).resolves.toEqual([]);

      const [snapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const snapshotAt = databaseDate(snapshotClock!.snapshot_at);
      const persistedAt = new Date(snapshotAt.getTime() - 1_000).toISOString();
      const completedBeforeSnapshot = new Date(snapshotAt.getTime() - 500).toISOString();
      const observedBeforeSnapshot = new Date(snapshotAt.getTime() - 2_000).toISOString();
      const lateRunId = await insertEvidence(lateTerminalEan, "completed", {
        checkedAt: completedBeforeSnapshot,
        completedAt: completedBeforeSnapshot,
        createdAt: persistedAt,
        fetchedAt: completedBeforeSnapshot,
        observedAt: observedBeforeSnapshot,
        verifiedAt: completedBeforeSnapshot,
      });
      const historicalReader = new PostgresEvidencePriceReader(
        connection.db,
        () => snapshotAt,
      );
      await expect(historicalReader.getMany([lateTerminalEan])).resolves.toEqual([]);
      const [lateRun] = await connection.sql`
        select terminalized_at > ${snapshotAt.toISOString()}::timestamptz
          as terminalized_later
        from ingestion_runs
        where id = ${lateRunId}
      `;
      expect(lateRun?.terminalized_later).toBe(true);

      const [mutableIdentifier] = await connection.sql`
        select id, product_id
        from product_identifiers
        where value = ${mutableIdentifierEan}
      `;
      await connection.sql`
        update product_identifiers set verified_at = null
        where id = ${mutableIdentifier!.id}
      `;
      const [identifierSnapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const identifierSnapshotAt = databaseDate(identifierSnapshotClock!.snapshot_at);
      await connection.sql`
        update product_identifiers
        set verified_at = ${new Date(identifierSnapshotAt.getTime() - 1_000).toISOString()}
        where id = ${mutableIdentifier!.id}
      `;
      await expect(
        new PostgresEvidencePriceReader(
          connection.db,
          () => identifierSnapshotAt,
        ).getMany([mutableIdentifierEan]),
      ).resolves.toEqual([]);
      await expect(
        (await evidenceReaderAtDatabaseNow()).getMany([mutableIdentifierEan]),
      ).resolves.toHaveLength(1);

      const [mutableProduct] = await connection.sql`
        select product_id
        from product_identifiers
        where value = ${mutableProductEan}
      `;
      await connection.sql`
        update canonical_products set status = 'retired'
        where id = ${mutableProduct!.product_id}
      `;
      const [productSnapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const productSnapshotAt = databaseDate(productSnapshotClock!.snapshot_at);
      await connection.sql`
        update canonical_products set status = 'active'
        where id = ${mutableProduct!.product_id}
      `;
      await expect(
        new PostgresEvidencePriceReader(
          connection.db,
          () => productSnapshotAt,
        ).getMany([mutableProductEan]),
      ).resolves.toEqual([]);
      await expect(
        (await evidenceReaderAtDatabaseNow()).getMany([mutableProductEan]),
      ).resolves.toHaveLength(1);

      await connection.sql`
        update geographic_scopes set status = 'retired'
        where id = ${scope!.id}
      `;
      const [scopeSnapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const scopeSnapshotAt = databaseDate(scopeSnapshotClock!.snapshot_at);
      await connection.sql`
        update geographic_scopes set status = 'active'
        where id = ${scope!.id}
      `;
      await expect(
        new PostgresEvidencePriceReader(
          connection.db,
          () => scopeSnapshotAt,
        ).getMany([mutableScopeEan]),
      ).resolves.toEqual([]);
      await expect(
        (await evidenceReaderAtDatabaseNow()).getMany([mutableScopeEan]),
      ).resolves.toHaveLength(1);

      await connection.sql`
        update data_sources set runtime_state = 'blocked' where id = 'kassalapp'
      `;
      await expect(reader.getMany([eligibleEan])).resolves.toEqual([]);
      const [sourceSnapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const sourceSnapshotAt = databaseDate(sourceSnapshotClock!.snapshot_at);
      await connection.sql`
        update data_sources set runtime_state = 'approved' where id = 'kassalapp'
      `;
      await expect(
        new PostgresEvidencePriceReader(
          connection.db,
          () => sourceSnapshotAt,
        ).getMany([eligibleEan]),
      ).resolves.toEqual([]);
      await expect(
        (await evidenceReaderAtDatabaseNow()).getMany([eligibleEan]),
      ).resolves.toHaveLength(1);

      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, permissions, notes
        ) values (
          'kassalapp', 'revoked', ${new Date().toISOString()},
          '{"ordinaryPrice": true}'::jsonb,
          ${`reader-revoked-${integrationNonce}`}
        )
      `;
      await expect(
        (await evidenceReaderAtDatabaseNow()).getMany([eligibleEan]),
      ).resolves.toEqual([]);
    } finally {
      await connection.sql`
        update data_sources
        set runtime_state = 'conditional',
            permission_reviewed_at = null,
            permission_expires_at = null
        where id = 'kassalapp'
      `;
    }
  });

  it("enforces append-only evidence and audit guards inside PostgreSQL", async () => {
    const triggers = await connection.sql`
      select tgname
      from pg_trigger
      where not tgisinternal
        and tgname in (
          'source_permissions_append_only',
          'price_observations_append_only',
          'price_coverage_checks_append_only',
          'publication_captures_append_only',
          'review_actions_append_only'
        )
      order by tgname
    `;
    expect(triggers.map(({ tgname }) => tgname)).toEqual([
      "price_coverage_checks_append_only",
      "price_observations_append_only",
      "publication_captures_append_only",
      "review_actions_append_only",
      "source_permissions_append_only",
    ]);

    const [permission] = await connection.sql`
      insert into source_permissions (
        source_id, decision, reviewed_at, permissions, notes
      ) values (
        'kassalapp', 'conditional', now(), '{}', ${`append-only-test-${integrationNonce}`}
      )
      returning id
    `;
    await expect(
      connection.sql`
        update source_permissions set decision = 'approved' where id = ${permission!.id}
      `,
    ).rejects.toThrow(/append-only/i);
  });

  it("database-stamps and seals geographic scope membership", async () => {
    const [scope] = await connection.sql`
      insert into geographic_scopes (scope_key, scope_kind, label, status)
      values (${`test:region:${integrationNonce}`}, 'region', 'Test region', 'active')
      returning id
    `;
    const [membership] = await connection.sql`
      insert into geographic_scope_regions (scope_id, region_code, created_at)
      values (${scope!.id}, ${`region-${integrationNonce}`}, '2000-01-01T00:00:00Z')
      returning created_at
    `;

    expect(databaseDate(membership!.created_at).getTime()).toBeGreaterThan(
      new Date("2000-01-01T00:00:00Z").getTime(),
    );
    await expect(
      connection.sql`
        update geographic_scope_regions
        set region_code = ${`changed-${integrationNonce}`}
        where scope_id = ${scope!.id}
      `,
    ).rejects.toThrow(/append-only/i);
    await expect(
      connection.sql`
        delete from geographic_scope_regions where scope_id = ${scope!.id}
      `,
    ).rejects.toThrow(/append-only/i);
  });

  it("converges concurrent offer approvals on one stable offer identity", async () => {
    const [scope] = await connection.sql`
      insert into geographic_scopes (scope_key, scope_kind, label, status)
      values (${`test:offer:${integrationNonce}`}, 'national', 'Offer test', 'active')
      returning id
    `;
    const offerKey = `offer:test:${integrationNonce}`;
    const insertOffer = () => connection.sql`
      insert into approved_offers (
        offer_key, source_id, source_reference, chain, geographic_scope_id,
        amount_ore, valid_from, valid_until, approved_at
      ) values (
        ${offerKey}, 'kassalapp', 'fixture:offer', 'extra', ${scope!.id},
        2490, '2026-07-15T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
        '2026-07-15T12:00:00.000Z'
      )
    `;

    const outcomes = await Promise.allSettled([insertOffer(), insertOffer()]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const [stored] = await connection.sql`
      select count(*)::integer as count from approved_offers where offer_key = ${offerKey}
    `;
    expect(stored!.count).toBe(1);
  });
});
