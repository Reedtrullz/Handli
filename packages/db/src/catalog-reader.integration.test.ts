import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ActiveCatalogReaderError,
  PostgresActiveCatalogReader,
} from "./catalog-reader";
import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresPublicCatalogIndexReader } from "./public-catalog-index-reader";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const fixtureNow = Date.now();
const AT = new Date(fixtureNow + 60_000);
const RETRIEVED_AT = new Date(fixtureNow - 10 * 60_000);
const STARTED_AT = new Date(fixtureNow - 20 * 60_000);
const COMPLETED_AT = new Date(fixtureNow - 5 * 60_000);
const SOURCE_REVIEWED_AT = new Date(fixtureNow - 30 * 60_000);
const SOURCE_EXPIRES_AT = new Date(fixtureNow + 24 * 60 * 60_000);
const nonceDigits = String((Date.now() + process.pid) % 10_000_000).padStart(7, "0");
const catalogSourceId = `catalog-observation-test-${nonceDigits}-${process.pid}`;
const observedMilkName = `Observed ${nonceDigits} milk`;
const observedCoffeeName = `Observed ${nonceDigits} coffee`;

function withCheckDigit(body: string): string {
  const weighted = [...body].reduce(
    (sum, digit, index) =>
      sum + Number(digit) * ((body.length - index) % 2 === 1 ? 3 : 1),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

function gtin13(variant: number): string {
  return withCheckDigit(`704${nonceDigits}${String(variant).padStart(2, "0")}`);
}

function gtin8(variant: number): string {
  return withCheckDigit(`${nonceDigits.slice(0, 5)}${String(variant).padStart(2, "0")}`);
}

describe.skipIf(!runDatabaseIntegration).sequential(
  "completed catalog observation readers integration",
  () => {
    let first: DatabaseConnection;
    let second: DatabaseConnection;
    let firstReader: PostgresActiveCatalogReader;
    let secondReader: PostgresActiveCatalogReader;
    let publicReader: PostgresPublicCatalogIndexReader;
    let webConnection: DatabaseConnection;
    let webReader: PostgresActiveCatalogReader;
    let webPublicReader: PostgresPublicCatalogIndexReader;
    let completedRunId: number;
    let canonicalMilkId: number;

    const gtins = {
      milk: gtin13(1),
      milkAlias: gtin8(2),
      coffee: gtin13(3),
      runningOnly: gtin13(4),
      degradedOnly: gtin13(5),
      lateBackdated: gtin13(6),
      lateCompletedInsert: gtin13(7),
    } as const;

    async function createProduct(displayName: string): Promise<number> {
      const [product] = await first.sql`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack, status
        ) values (${displayName}, 1, 'package', 1, 'active')
        returning id::integer as id
      `;
      if (product === undefined || typeof product.id !== "number") {
        throw new Error("Catalog observation fixture did not return a product ID");
      }
      return product.id;
    }

    async function createRun(
      label: string,
      status: "completed" | "degraded" | "running",
      createdAt?: Date,
    ): Promise<number> {
      const completedAt = status === "running" ? null : COMPLETED_AT.toISOString();
      const [run] = await first.sql`
        insert into ingestion_runs (
          job_id, source_id, run_type, status, started_at, completed_at, counts,
          created_at
        ) values (
          ${`${catalogSourceId}:${label}`},
          ${catalogSourceId},
          'catalog',
          'running',
          ${STARTED_AT.toISOString()},
          null,
          '{}'::jsonb,
          coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now())
        )
        returning id::integer as id
      `;
      if (run === undefined || typeof run.id !== "number") {
        throw new Error("Catalog observation fixture did not return a run ID");
      }
      if (status !== "running") {
        await first.sql`
          update ingestion_runs
          set status = ${status},
              completed_at = ${completedAt},
              counts = ${JSON.stringify({ accepted: 1, failed: status === "completed" ? 0 : 1, fetched: 1, persisted: 1, quarantined: 0, unknown: 0 })}::jsonb,
              error_class = ${status === "degraded" ? "FIXTURE_DEGRADED" : null}
          where id = ${run.id}
        `;
      }
      return run.id;
    }

    async function appendObservation(input: {
      brand?: string;
      canonicalProductId: number;
      displayName: string;
      gtin: string;
      hashDigit: string;
      runId: number;
      sourceRecordId: string;
      createdAt?: Date;
    }): Promise<void> {
      await first.sql`
        insert into catalog_observations (
          ingestion_run_id, source_record_id, canonical_product_id, gtin,
          display_name, brand, package_amount, package_unit, units_per_pack,
          retrieved_at, source_updated_at, raw_record_hash, created_at
        ) values (
          ${input.runId},
          ${input.sourceRecordId},
          ${input.canonicalProductId},
          ${input.gtin},
          ${input.displayName},
          ${input.brand ?? null},
          ${input.gtin === gtins.milkAlias ? 4 : 1_000},
          ${input.gtin === gtins.milkAlias ? "piece" : "ml"},
          ${input.gtin === gtins.milkAlias ? 4 : 1},
          ${RETRIEVED_AT.toISOString()},
          ${new Date(RETRIEVED_AT.getTime() - 60_000).toISOString()},
          ${input.hashDigit.repeat(64)},
          coalesce(${input.createdAt?.toISOString() ?? null}::timestamptz, now())
        )
      `;
    }

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      if (!process.env.WEB_DATABASE_URL) {
        throw new Error("WEB_DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      first = createDatabase(process.env.DATABASE_URL);
      second = createDatabase(process.env.DATABASE_URL);
      webConnection = createDatabase(process.env.WEB_DATABASE_URL);
      firstReader = new PostgresActiveCatalogReader(first.db);
      secondReader = new PostgresActiveCatalogReader(second.db);
      publicReader = new PostgresPublicCatalogIndexReader(first.db);
      webReader = new PostgresActiveCatalogReader(webConnection.db);
      webPublicReader = new PostgresPublicCatalogIndexReader(webConnection.db);

      await first.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${catalogSourceId},
          'Catalog observation integration fixture',
          'catalog',
          'approved',
          ${SOURCE_REVIEWED_AT.toISOString()},
          ${SOURCE_EXPIRES_AT.toISOString()}
        )
      `;
      await first.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until,
          public_reference_url, permissions
        ) values (
          ${catalogSourceId},
          'approved',
          ${SOURCE_REVIEWED_AT.toISOString()},
          ${SOURCE_EXPIRES_AT.toISOString()},
          'https://example.invalid/catalog-observation-fixture',
          '{"catalog":true}'::jsonb
        )
      `;

      completedRunId = await createRun("completed", "running");
      canonicalMilkId = await createProduct("Mutable milk projection");
      const canonicalCoffeeId = await createProduct("Mutable coffee projection");
      await appendObservation({
        brand: "Fixture",
        canonicalProductId: canonicalMilkId,
        displayName: observedMilkName,
        gtin: gtins.milk,
        hashDigit: "a",
        runId: completedRunId,
        sourceRecordId: "milk-main",
      });
      await appendObservation({
        canonicalProductId: canonicalMilkId,
        displayName: observedMilkName,
        gtin: gtins.milkAlias,
        hashDigit: "b",
        runId: completedRunId,
        sourceRecordId: "milk-alias",
      });
      await appendObservation({
        brand: "Fixture",
        canonicalProductId: canonicalCoffeeId,
        displayName: observedCoffeeName,
        gtin: gtins.coffee,
        hashDigit: "c",
        runId: completedRunId,
        sourceRecordId: "coffee-main",
      });
      await first.sql`
        update ingestion_runs
        set status = 'completed',
            completed_at = ${COMPLETED_AT.toISOString()},
            counts = '{"accepted":3,"failed":0,"fetched":3,"persisted":3,"quarantined":0,"unknown":0}'::jsonb
        where id = ${completedRunId}
      `;

      const runningProductId = await createProduct("Running partial projection");
      await appendObservation({
        canonicalProductId: runningProductId,
        displayName: "Must stay hidden while running",
        gtin: gtins.runningOnly,
        hashDigit: "d",
        runId: await createRun("running", "running"),
        sourceRecordId: "running-only",
      });
      const degradedProductId = await createProduct("Degraded partial projection");
      const degradedRunId = await createRun("degraded", "running");
      await appendObservation({
        canonicalProductId: degradedProductId,
        displayName: "Must stay hidden when degraded",
        gtin: gtins.degradedOnly,
        hashDigit: "e",
        runId: degradedRunId,
        sourceRecordId: "degraded-only",
      });
      await first.sql`
        update ingestion_runs
        set status = 'degraded',
            completed_at = ${COMPLETED_AT.toISOString()},
            counts = '{"accepted":1,"failed":1,"fetched":1,"persisted":1,"quarantined":0,"unknown":0}'::jsonb,
            error_class = 'FIXTURE_DEGRADED'
        where id = ${degradedRunId}
      `;
    });

    afterAll(async () => {
      await Promise.all([first?.close(), second?.close(), webConnection?.close()]);
    });

    it("returns only completed-run observation payloads and preserves exact aliases", async () => {
      const requested = [
        gtins.runningOnly,
        gtins.milkAlias,
        gtins.degradedOnly,
        gtins.coffee,
        gtins.milk,
      ];
      const [firstResult, secondResult, webResult] = await Promise.all([
        firstReader.getMany(requested, AT),
        secondReader.getMany([...requested].reverse(), AT),
        webReader.getMany(requested, AT),
      ]);

      const expectedGtins = [gtins.coffee, gtins.milk, gtins.milkAlias].sort();
      expect(firstResult.map(({ gtin }) => gtin)).toEqual(expectedGtins);
      expect(secondResult).toEqual(firstResult);
      expect(webResult).toEqual(firstResult);
      expect(firstResult.find(({ gtin }) => gtin === gtins.milk)).toMatchObject({
        brand: "Fixture",
        catalogEvidence: { observedAt: RETRIEVED_AT.toISOString() },
        displayName: observedMilkName,
        packageMeasure: { amount: 1_000, unit: "ml" },
      });
    });

    it("never reads mutable canonical or source-product projection payloads", async () => {
      await first.sql`
        update canonical_products
        set display_name = 'Unpublished partial mutation',
            package_amount = 99,
            package_unit = 'package',
            status = 'retired'
        where id = ${canonicalMilkId}
      `;
      await first.sql`
        insert into source_products (
          source_id, external_id, canonical_product_id, normalized_fields,
          raw_record_hash, match_state, first_seen_at, last_seen_at
        ) values (
          ${catalogSourceId}, 'mutable-partial', ${canonicalMilkId},
          '{"displayName":"Unpublished partial mutation"}'::jsonb,
          ${"f".repeat(64)}, 'matched', ${RETRIEVED_AT.toISOString()}, ${AT.toISOString()}
        )
      `;

      await expect(firstReader.getMany([gtins.milk], AT)).resolves.toEqual([
        expect.objectContaining({
          displayName: observedMilkName,
          packageMeasure: { amount: 1_000, unit: "ml" },
        }),
      ]);
    });

    it("deduplicates browse/name search by canonical product but keeps an exact alias searchable", async () => {
      const browse = await publicReader.browse(36, AT);
      const nameSearch = await publicReader.search(nonceDigits, 20, AT);
      const aliasSearch = await publicReader.search(gtins.milkAlias, 20, AT);
      const webAliasSearch = await webPublicReader.search(gtins.milkAlias, 20, AT);

      const fixtureBrowse = browse.filter(({ catalogEvidence }) =>
        catalogEvidence.source.id === catalogSourceId);
      const fixtureNameSearch = nameSearch.filter(({ catalogEvidence }) =>
        catalogEvidence.source.id === catalogSourceId);
      expect(fixtureBrowse).toHaveLength(2);
      expect(fixtureNameSearch).toHaveLength(2);
      expect(fixtureBrowse.filter(({ displayName }) => displayName === observedMilkName))
        .toHaveLength(1);
      expect(fixtureNameSearch.filter(({ displayName }) => displayName === observedMilkName))
        .toHaveLength(1);
      expect(aliasSearch.map(({ gtin }) => gtin)).toEqual([gtins.milkAlias]);
      expect(webAliasSearch).toEqual(aliasSearch);
    });

    it("keeps an old snapshot closed against a later backdated terminal run", async () => {
      const productId = await createProduct("Late backdated catalog projection");
      const snapshotAt = new Date(Date.now() - 100);
      const persistedAt = new Date(snapshotAt.getTime() - 1_000);
      const runId = await createRun("late-backdated", "running", persistedAt);
      await appendObservation({
        canonicalProductId: productId,
        createdAt: persistedAt,
        displayName: "Must stay outside the old snapshot",
        gtin: gtins.lateBackdated,
        hashDigit: "f",
        runId,
        sourceRecordId: "late-backdated",
      });
      await first.sql`
        update ingestion_runs
        set status = 'completed',
            completed_at = ${COMPLETED_AT.toISOString()},
            counts = '{"accepted":1,"failed":0,"fetched":1,"persisted":1,"quarantined":0,"unknown":0}'::jsonb
        where id = ${runId}
      `;

      await expect(firstReader.getMany([gtins.lateBackdated], snapshotAt)).resolves.toEqual([]);
      await expect(publicReader.search(gtins.lateBackdated, 20, snapshotAt)).resolves.toEqual([]);

      const [run] = await first.sql`
        select terminalized_at > ${snapshotAt.toISOString()}::timestamptz as terminalized_later
        from ingestion_runs
        where id = ${runId}
      `;
      expect(run?.terminalized_later).toBe(true);
    });

    it("rejects a backdated observation appended after run completion", async () => {
      const productId = await createProduct("Late completed-run catalog projection");
      const [snapshotClock] = await first.sql`
        select clock_timestamp() as snapshot_at
      `;
      const snapshotAt = snapshotClock!.snapshot_at as Date;
      await expect(
        appendObservation({
          canonicalProductId: productId,
          createdAt: new Date(snapshotAt.getTime() - 1_000),
          displayName: "Must never attach to a completed run",
          gtin: gtins.lateCompletedInsert,
          hashDigit: "1",
          runId: completedRunId,
          sourceRecordId: "late-completed-insert",
        }),
      ).rejects.toThrow(/running ingestion run/i);
      await expect(
        firstReader.getMany([gtins.lateCompletedInsert], snapshotAt),
      ).resolves.toEqual([]);
    });

    it("database-stamps later permission decisions so old snapshots cannot be replayed", async () => {
      const [snapshotClock] = await first.sql`
        select clock_timestamp() as snapshot_at
      `;
      const snapshotAt = snapshotClock!.snapshot_at as Date;
      const baseline = await firstReader.getMany([gtins.milk], snapshotAt);
      expect(baseline).toHaveLength(1);

      const [revocation] = await first.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes,
          created_at
        ) values (
          ${catalogSourceId}, 'revoked',
          ${new Date(snapshotAt.getTime() - 1_000).toISOString()},
          ${new Date(snapshotAt.getTime() + 24 * 60 * 60_000).toISOString()},
          '{"catalog":true}'::jsonb,
          ${`backdated-revocation-${nonceDigits}`},
          '2000-01-01T00:00:00Z'
        )
        returning
          created_at,
          created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(revocation!.created_later).toBe(true);
      await expect(firstReader.getMany([gtins.milk], snapshotAt)).resolves.toEqual(baseline);
      await expect(publicReader.search(gtins.milk, 20, snapshotAt)).resolves.toHaveLength(1);

      await first.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${catalogSourceId}, 'approved', clock_timestamp(),
          clock_timestamp() + interval '1 day', '{"catalog":true}'::jsonb,
          ${`restore-approval-${nonceDigits}`}
        )
      `;
    });

    it("does not let a later source approval or identity edit rewrite an old snapshot", async () => {
      const changedDisplayName = `Changed after snapshot ${nonceDigits}`;
      await first.sql`
        update data_sources
        set runtime_state = 'blocked'
        where id = ${catalogSourceId}
      `;
      const [snapshotClock] = await first.sql`
        select clock_timestamp() as snapshot_at
      `;
      const snapshotAt = snapshotClock!.snapshot_at as Date;

      try {
        await first.sql`
          update data_sources
          set runtime_state = 'approved', display_name = ${changedDisplayName}
          where id = ${catalogSourceId}
        `;

        await expect(firstReader.getMany([gtins.milk], snapshotAt)).resolves.toEqual([]);
        await expect(publicReader.search(gtins.milk, 20, snapshotAt)).resolves.toEqual([]);

        const [sourceClock] = await first.sql`
          select
            public_state_changed_at > ${snapshotAt.toISOString()}::timestamptz
              as changed_later,
            clock_timestamp() + interval '1 second' as current_at
          from data_sources
          where id = ${catalogSourceId}
        `;
        expect(sourceClock?.changed_later).toBe(true);
        const current = await firstReader.getMany(
          [gtins.milk],
          sourceClock!.current_at as Date,
        );
        expect(current[0]?.catalogEvidence.source.displayName).toBe(changedDisplayName);
      } finally {
        await first.sql`
          update data_sources
          set runtime_state = 'approved',
              display_name = 'Catalog observation integration fixture'
          where id = ${catalogSourceId}
        `;
      }
    });

    it("cancels a PostgreSQL read blocked on append-only catalog observations", async () => {
      let reportLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => {
        reportLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = first.sql.begin(async (transaction) => {
        await transaction`lock table catalog_observations in access exclusive mode`;
        reportLocked();
        await release;
      });

      await locked;
      const controller = new AbortController();
      const read = secondReader.getMany([gtins.milk], AT, controller.signal);

      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();
        await expect(read).rejects.toEqual(new ActiveCatalogReaderError("CANCELLED"));
      } finally {
        releaseLock();
        await blocker;
      }
    });
  },
);
