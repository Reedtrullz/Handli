import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EXPECTED_BASE_UNION_ROWS,
  FIXTURE,
  V1_CHAINS,
  evaluatedAtNow,
  expectedUnionRows,
  guardCiDatabaseUrls,
  insertBoundaryHistory,
  insertFixture,
  insertRevocation,
  rawUnionCount,
} from "../../../tests/acceptance/planner-database-fixture.mjs";
import { PriceService } from "../../../apps/web/lib/server/price-service";
import { createDatabase } from "./client";
import { PostgresPlanningEvidenceReader } from "./planning-evidence-reader";
import { PostgresPublicOfficialOfferReader } from "./public-official-offer-reader";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const MARKET_CONTEXT = { contractVersion: 1, countryCode: "NO", kind: "national" };
const TIMEOUT = 120_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Sequential on purpose: boundary and revocation steps append to the shared append-only fixture.
describe.skipIf(!runDatabaseIntegration).sequential("planner workload on the actual web role", () => {
  let admin;
  let web;
  let reader;
  let fx;
  let mainSource;
  let bulkSource;

  beforeAll(async () => {
    const { adminUrl, webUrl } = guardCiDatabaseUrls(process.env);
    admin = createDatabase(adminUrl);
    web = createDatabase(webUrl);
    reader = new PostgresPlanningEvidenceReader(web.db);
    fx = await insertFixture(admin.sql);
    mainSource = fx.sourceId;
    bulkSource = fx.ns + "-bulk";
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all([admin?.close(), web?.close()]);
  });

  const expectedPrice = (p) => ({
    amountOre: p.amount_ore,
    chainId: p.chain,
    geographicScope: p.geographic_scope_id === null
      ? { kind: "unknown", reason: "missing-geographic-scope" }
      : { countryCode: "NO", kind: "national" },
    id: "price:" + p.id,
    observedAt: new Date(p.observed_at).toISOString(),
    productId: "product:" + p.product_id,
    sourceId: p.source_id,
    sourceRecordId: "source-record:" + p.raw_record_hash,
  });
  const actualPrice = (e) => ({
    amountOre: e.amountOre,
    chainId: e.chainId,
    geographicScope: e.geographicScope,
    id: e.id,
    observedAt: e.observedAt,
    productId: e.productMatch.canonicalProductId,
    sourceId: e.sourceId,
    sourceRecordId: e.sourceRecordId,
  });
  const winnerFor = (gi, ci) => 1000 + gi * 7 + ci * 13;

  it("runs as handleplan_web with no privileged attributes and denied private access", async () => {
    const [who] = await web.sql.unsafe("select current_user::text as name, r.rolsuper, r.rolcreatedb, r.rolbypassrls"
      + " from pg_roles r where r.rolname = current_user");
    expect(who).toEqual({ name: "handleplan_web", rolbypassrls: false, rolcreatedb: false, rolsuper: false });
    await expect(web.sql.unsafe("select scope_key from geographic_scopes limit 1")).rejects.toThrow(/permission denied/i);
    await expect(web.sql.unsafe("insert into canonical_products (display_name, package_amount, package_unit,"
      + " units_per_pack, status) values ('web role write probe', 1, 'package', 1, 'active')"))
      .rejects.toThrow(/permission denied/i);
    // Pending-native fixture facts: authored raw records, never reader output.
    expect(fx.gtins).toHaveLength(FIXTURE.gtinCount);
    expect(new Set(fx.gtins).size).toBe(FIXTURE.gtinCount);
    expect(fx.sizeAfter).toBeLessThanOrEqual(FIXTURE.maxDatabaseBytes);
  }, TIMEOUT);

  it("returns the 50 GTIN raw records through the real reader exactly as authored", async () => {
    const at = await evaluatedAtNow(admin.sql);
    const expected = expectedUnionRows(fx, [mainSource], at);
    const raw = await rawUnionCount(admin.sql, fx, [mainSource], at);
    expect(raw).toEqual({ coverage: expected.coverage.length, prices: expected.prices.length,
      products: 50, total: expected.total });
    expect(expected.total).toBe(EXPECTED_BASE_UNION_ROWS);
    expect(expected.coverage).toHaveLength(FIXTURE.gtinCount * FIXTURE.chainCount);

    // Authored newest price per product/chain is the unique cheapest; every older row costs more.
    for (const p of fx.prices.filter((row) => row.kind === "current")) {
      const older = fx.prices.filter((row) => row.kind === "history" && row.product_id === p.product_id && row.chain === p.chain);
      expect(older).toHaveLength(FIXTURE.historyPerPair);
      for (const row of older) {
        expect(new Date(row.observed_at).getTime()).toBeLessThan(new Date(p.observed_at).getTime());
        expect(row.amount_ore).toBeGreaterThan(p.amount_ore);
      }
    }

    const snapshot = await reader.getMany(fx.gtins, at);
    expect(snapshot.products).toEqual([...fx.gtins].sort(byText).map((gtin) => ({
      canonicalProductId: "product:" + fx.productIds[fx.gtins.indexOf(gtin)], gtin })));
    expect(snapshot.priceEvidence.map(actualPrice).sort((a, b) => byText(a.id, b.id)))
      .toEqual(expected.prices.map(expectedPrice).sort((a, b) => byText(a.id, b.id)));
    expect(snapshot.historicalEligibleEvidenceIds).toEqual(expected.prices
      .filter((p) => p.claim_eligibility === "historical_eligible").map((p) => "price:" + p.id).sort(byText));
    expect(snapshot.sources.map(({ id, sourceClass }) => ({ id, sourceClass })))
      .toEqual([{ id: mainSource, sourceClass: "ordinary-price" }]);
    // Priced coverage rows count toward the 10000 UNION but are omitted from the public projection.
    expect(snapshot.coverageChecks).toEqual([]);
    const unknown = snapshot.priceEvidence.filter((e) => e.geographicScope.kind === "unknown");
    expect(unknown.map((e) => e.amountOre)).toEqual([1]);
  }, TIMEOUT);

  it("keeps price qualification, history and unknown geography honest through the real PriceService", async () => {
    const at = await evaluatedAtNow(admin.sql);
    const service = new PriceService({ officialOfferReader: new PostgresPublicOfficialOfferReader(web.db), reader });
    const result = await service.readProducts(fx.gtins, MARKET_CONTEXT, at);
    const unknownRecord = fx.prices.find((p) => p.kind === "unknown-scope");
    expect(result.productEvidence).toHaveLength(50);
    expect(result.prices).toHaveLength(FIXTURE.gtinCount * FIXTURE.chainCount);
    expect(result.sources.map(({ id }) => id)).toEqual([mainSource]);
    for (const evidence of result.productEvidence) {
      const gi = fx.gtins.indexOf(evidence.gtin);
      expect(evidence.officialOffers).toEqual([]);
      expect(evidence.ordinaryPrices).toHaveLength(FIXTURE.chainCount);
      expect(evidence.ordinaryPrices.map(({ id }) => id)).not.toContain("price:" + unknownRecord.id);
      expect(evidence.historicalComparisons.length).toBeGreaterThan(0);
      for (const price of evidence.ordinaryPrices) {
        expect(price.amountOre).toBe(winnerFor(gi, V1_CHAINS.indexOf(price.chainId)));
      }
    }
    expect(result.prices.find((p) => p.ean === fx.gtins[1] && p.chain === "oda").amountOre).toBe(winnerFor(1, 12));
  }, TIMEOUT);

  it("cancels an in-flight web-role query held behind an owned ACCESS EXCLUSIVE lock", async () => {
    const at = await evaluatedAtNow(admin.sql);
    const blocked = () => admin.sql.unsafe("select pid from pg_stat_activity where usename = 'handleplan_web'"
      + " and datname = current_database() and state = 'active' and wait_event_type = 'Lock'"
      + " and query like '%requested_products%' and pid <> pg_backend_pid()");
    const holder = await admin.sql.reserve();
    const controller = new AbortController();
    try {
      await holder.unsafe("begin");
      await holder.unsafe("set local idle_in_transaction_session_timeout = '60s'");
      await holder.unsafe("lock table price_observations in access exclusive mode");
      const pending = reader.getMany(fx.gtins, at, controller.signal).then(() => undefined, (error) => error);
      let seen = [];
      for (let i = 0; i < 100 && seen.length === 0; i += 1) {
        await sleep(100);
        seen = await blocked();
      }
      expect(seen.length).toBeGreaterThan(0);
      controller.abort();
      const error = await pending;
      expect(error).toMatchObject({ code: "CANCELLED", name: "PlanningEvidenceReaderError" });
      let left = await blocked();
      for (let i = 0; i < 50 && left.length > 0; i += 1) {
        await sleep(100);
        left = await blocked();
      }
      expect(left).toEqual([]);
    } finally {
      controller.abort();
      try {
        await holder.unsafe("rollback");
      } finally {
        holder.release();
      }
    }
  }, TIMEOUT);

  it("returns exactly 10000 raw UNION rows, then fails closed at 10001", async () => {
    await insertBoundaryHistory(admin.sql, fx, FIXTURE.maxRows - EXPECTED_BASE_UNION_ROWS, "at-limit");
    const atLimit = await evaluatedAtNow(admin.sql);
    const sources = [mainSource, bulkSource];
    const expected = expectedUnionRows(fx, sources, atLimit);
    expect(expected.total).toBe(FIXTURE.maxRows);
    expect((await rawUnionCount(admin.sql, fx, sources, atLimit)).total).toBe(FIXTURE.maxRows);
    const snapshot = await reader.getMany(fx.gtins, atLimit);
    expect(snapshot.priceEvidence).toHaveLength(expected.prices.length);
    expect(snapshot.sources.map(({ id }) => id).sort(byText)).toEqual(sources.sort(byText));

    await insertBoundaryHistory(admin.sql, fx, 1, "over-limit");
    const overLimit = await evaluatedAtNow(admin.sql);
    expect((await rawUnionCount(admin.sql, fx, sources, overLimit)).total).toBe(FIXTURE.maxRows + 1);
    await expect(reader.getMany(fx.gtins, overLimit)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }, TIMEOUT);

  it("drops the oversized source after revocation with no price or source conclusion from it", async () => {
    await insertRevocation(admin.sql, bulkSource);
    const at = await evaluatedAtNow(admin.sql);
    const expected = expectedUnionRows(fx, [mainSource], at);
    expect((await rawUnionCount(admin.sql, fx, [mainSource], at)).total).toBe(expected.total);
    const snapshot = await reader.getMany(fx.gtins, at);
    const bulkIds = new Set(fx.bulk.map((p) => "price:" + p.id));
    expect(snapshot.sources.map(({ id }) => id)).toEqual([mainSource]);
    expect(snapshot.priceEvidence.filter(({ id }) => bulkIds.has(id))).toEqual([]);
    expect(snapshot.priceEvidence).toHaveLength(expected.prices.length);
  }, TIMEOUT);
});
