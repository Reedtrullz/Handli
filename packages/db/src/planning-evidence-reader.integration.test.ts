import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresPlanningEvidenceReader } from "./planning-evidence-reader";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `planning-permission-${Date.now()}-${process.pid}`;
const sourceId = nonce.slice(0, 64);

function withCheckDigit(body: string): string {
  const weighted = [...body].reduce(
    (sum, digit, index) =>
      sum + Number(digit) * ((body.length - index) % 2 === 1 ? 3 : 1),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

const gtin = withCheckDigit(
  `705${String((Date.now() + process.pid) % 1_000_000_000).padStart(9, "0")}`,
);

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Planning permission fixture returned an invalid database timestamp");
  }
  return parsed;
}

describe.skipIf(!runDatabaseIntegration).sequential(
  "planning evidence source permission order integration",
  () => {
    let admin: DatabaseConnection;
    let web: DatabaseConnection;
    let reader: PostgresPlanningEvidenceReader;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL || !process.env.WEB_DATABASE_URL) {
        throw new Error("DATABASE_URL and WEB_DATABASE_URL are required for DB integration");
      }
      admin = createDatabase(process.env.DATABASE_URL);
      web = createDatabase(process.env.WEB_DATABASE_URL);
      reader = new PostgresPlanningEvidenceReader(web.db);

      const [clock] = await admin.sql`select clock_timestamp() as current_at`;
      const currentAt = databaseDate(clock!.current_at);
      const reviewedAt = new Date(currentAt.getTime() - 60 * 60_000);
      const expiresAt = new Date(currentAt.getTime() + 24 * 60 * 60_000);
      const observedAt = new Date(currentAt.getTime() - 10 * 60_000);
      const startedAt = new Date(currentAt.getTime() - 20 * 60_000);
      const completedAt = new Date(currentAt.getTime() - 5 * 60_000);

      await admin.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId}, 'Planning permission integration source',
          'ordinary_price', 'approved', ${reviewedAt.toISOString()},
          ${expiresAt.toISOString()}
        )
      `;
      await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${sourceId}, 'approved', ${reviewedAt.toISOString()},
          ${expiresAt.toISOString()}, '{"ordinaryPrice":true}'::jsonb,
          'planning permission baseline approval'
        )
      `;
      const [product] = await admin.sql`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack, status
        ) values ('Planning permission product', 1, 'package', 1, 'active')
        returning id::integer as id
      `;
      if (typeof product?.id !== "number") throw new Error("Missing planning product id");
      await admin.sql`
        insert into product_identifiers (
          product_id, scheme, value, confidence, verified_at
        ) values (
          ${product.id}, 'ean13', ${gtin}, 100, ${observedAt.toISOString()}
        )
      `;
      const [scope] = await admin.sql`
        insert into geographic_scopes (
          scope_key, scope_kind, label, country_code, status
        ) values (
          ${`${nonce}:national`}, 'national', 'Norway', 'NO', 'active'
        )
        returning id::integer as id
      `;
      if (typeof scope?.id !== "number") throw new Error("Missing planning scope id");
      const [run] = await admin.sql`
        insert into ingestion_runs (
          job_id, source_id, run_type, status, started_at, counts
        ) values (
          ${`${nonce}:prices`}, ${sourceId}, 'benchmark-prices', 'running',
          ${startedAt.toISOString()}, '{}'::jsonb
        )
        returning id::integer as id
      `;
      if (typeof run?.id !== "number") throw new Error("Missing planning run id");
      await admin.sql`
        insert into price_observations (
          evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
          source_id, source_reference, ingestion_run_id, geographic_scope_id,
          evidence_level, confidence, claim_eligibility, raw_record_hash
        ) values (
          ${`${nonce}:price`}, ${product.id}, 'extra', 2490,
          ${observedAt.toISOString()}, ${observedAt.toISOString()}, ${sourceId},
          'planning-permission-fixture', ${run.id}, ${scope.id}, 'chain', 100,
          'ordinary_only', ${"a".repeat(64)}
        )
      `;
      await admin.sql`
        update ingestion_runs
        set status = 'completed', completed_at = ${completedAt.toISOString()},
            counts = '{"accepted":1,"failed":0,"fetched":1,"persisted":1,"quarantined":0,"unknown":0}'::jsonb
        where id = ${run.id}
      `;
    });

    afterAll(async () => {
      await Promise.all([admin?.close(), web?.close()]);
    });

    it("blocks current planning evidence on later future-dated and backdated revocations while preserving as-of", async () => {
      const [snapshotClock] = await admin.sql`select clock_timestamp() as snapshot_at`;
      const snapshotAt = databaseDate(snapshotClock!.snapshot_at);
      const baseline = await reader.getMany([gtin], snapshotAt);
      expect(baseline).toMatchObject({
        priceEvidence: [expect.objectContaining({ amountOre: 2490 })],
        products: [expect.objectContaining({ gtin })],
        sources: [expect.objectContaining({ id: sourceId })],
      });

      const [futureRevocation] = await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${sourceId}, 'revoked',
          ${new Date(snapshotAt.getTime() + 24 * 60 * 60_000).toISOString()},
          null, '{}'::jsonb, 'planning future-dated revocation'
        )
        returning created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(futureRevocation?.created_later).toBe(true);
      const [afterFutureClock] = await admin.sql`
        select clock_timestamp() + interval '1 millisecond' as current_at
      `;
      await expect(reader.getMany(
        [gtin],
        databaseDate(afterFutureClock!.current_at),
      )).resolves.toMatchObject({
        coverageChecks: [],
        priceEvidence: [],
        products: [expect.objectContaining({ gtin })],
        sources: [],
      });

      const [revocation] = await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes,
          created_at
        ) values (
          ${sourceId}, 'revoked',
          ${new Date(snapshotAt.getTime() - 2 * 60 * 60_000).toISOString()},
          null, '{}'::jsonb, 'planning backdated revocation',
          '2000-01-01T00:00:00Z'
        )
        returning created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(revocation?.created_later).toBe(true);
      await expect(reader.getMany([gtin], snapshotAt)).resolves.toEqual(baseline);

      const [currentClock] = await admin.sql`
        select clock_timestamp() + interval '1 millisecond' as current_at
      `;
      await expect(reader.getMany(
        [gtin],
        databaseDate(currentClock!.current_at),
      )).resolves.toMatchObject({
        coverageChecks: [],
        priceEvidence: [],
        products: [expect.objectContaining({ gtin })],
        sources: [],
      });
    });
  },
);
