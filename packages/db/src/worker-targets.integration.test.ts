import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresIngestionRepository } from "./ingestion";
import { PostgresWorkerGtinTargetReader } from "./worker-targets";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${process.pid}-${Date.now()}`;
const now = new Date("2026-07-16T12:00:00.000Z");

function gtin13(sequence: number): string {
  const body = String(sequence).padStart(12, "0").slice(-12);
  const weighted = [...body].reduce(
    (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresWorkerGtinTargetReader integration",
  () => {
    let connection: DatabaseConnection;

    beforeAll(() => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
    });

    afterAll(async () => {
      await connection?.close();
    });

    it("selects and promotes a migration-style unverified quarantine before refreshed rows", async () => {
      const migrationEan = gtin13(Date.now() % 1_000_000_000_000);
      const cacheOnlyEan = gtin13((Date.now() + 1) % 1_000_000_000_000);
      const sourceId = `worker-target-${nonce}`;
      await connection.sql.begin(async (transaction) => {
        await transaction`
          insert into data_sources (
            id, display_name, source_kind, runtime_state,
            permission_reviewed_at, permission_expires_at
          ) values (
            ${sourceId}, 'Worker target authorized promotion', 'catalog', 'approved',
            '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
          )
        `;
        await transaction`
          insert into source_permissions (
            source_id, decision, reviewed_at, valid_until, permissions, notes
          ) values (
            ${sourceId}, 'approved', '2026-01-01T00:00:00Z',
            '2099-01-01T00:00:00Z', '{"catalog":true}'::jsonb,
            ${`worker-target-authorized-promotion-${nonce}`}
          )
        `;
      });
      const [product] = await connection.sql`
        insert into canonical_products (
          display_name, package_amount, package_unit, status, units_per_pack
        ) values (
          ${`Legacy quarantine ${nonce}`}, 1, 'package', 'quarantined', 1
        )
        returning id
      `;
      await connection.sql`
        insert into product_identifiers (
          confidence, product_id, scheme, source_id, value, verified_at
        ) values (0, ${product!.id}, 'ean13', null, ${migrationEan}, null)
      `;
      await connection.sql`
        insert into price_cache (ean, chain, amount_ore, observed_at, fetched_at)
        values
          (${migrationEan}, 'extra', 2490, ${now.toISOString()}, ${now.toISOString()}),
          (${cacheOnlyEan}, 'extra', 2590, ${now.toISOString()}, ${now.toISOString()})
        on conflict (ean, chain) do update set fetched_at = excluded.fetched_at
      `;

      const reader = new PostgresWorkerGtinTargetReader(connection.db);
      const targets = await reader.getCatalogGtins(500);
      expect(targets).toContain(migrationEan);
      expect(targets).toContain(cacheOnlyEan);

      const repository = new PostgresIngestionRepository(connection.db, {
        verifyFence: async () => undefined,
      });
      const begun = await repository.beginRun({
        fenceToken: `fixture-fence-${nonce}`,
        jobId: `worker-target-promotion-${nonce}`,
        runType: "catalog",
        sourceId,
        startedAt: now,
      });
      await repository.persistCatalogOutcomes(begun.handle, [{
        outcomeState: "accepted",
        product: {
          displayName: "Promoted exact product",
          retrievedAt: now,
          packageAmount: 1_000,
          packageUnit: "g",
        },
        recordKind: "product",
        recordedAt: now,
        sourceRecordId: `promotion-${nonce}`,
        subjectEan: migrationEan,
      }]);

      const [promoted] = await connection.sql`
        select product.status, identifier.confidence, identifier.verified_at
        from product_identifiers identifier
        inner join canonical_products product on product.id = identifier.product_id
        where identifier.value = ${migrationEan}
          and identifier.scheme = 'ean13'
      `;
      expect(promoted).toMatchObject({ confidence: 100, status: "active" });
      expect(new Date(String(promoted!.verified_at)).toISOString()).toBe(now.toISOString());
    });
  },
);
