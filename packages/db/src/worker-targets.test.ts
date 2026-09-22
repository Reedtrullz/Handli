import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  catalogDiscoveryPageForCompletedRuns,
  completedRunsForRotation,
  PostgresWorkerGtinTargetReader,
  priceTargetPageState,
} from "./worker-targets";

function readerWith(rows: Array<{ ean: string }>) {
  const query = Object.assign(Promise.resolve(rows), { cancel: vi.fn() });
  const client = vi.fn((..._args: unknown[]) => query);
  return { client, query, reader: new PostgresWorkerGtinTargetReader({
    $client: client,
  } as unknown as HandleplanDatabase) };
}

describe("PostgresWorkerGtinTargetReader", () => {
  it("bootstraps and rotates catalog identifiers while keeping price targets verified", async () => {
    const catalog = readerWith([{ ean: "7038010000010" }]);
    await expect(catalog.reader.getCatalogGtins(100)).resolves.toEqual(["7038010000010"]);
    const catalogSql = (catalog.client.mock.calls[0]?.[0] as readonly string[]).join("?");
    expect(catalogSql).toContain("identifier.scheme in ('ean8', 'ean13')");
    expect(catalogSql).not.toContain("identifier.verified_at is not null");
    expect(catalogSql).toContain("product.status in ('active', 'quarantined')");
    expect(catalogSql).toContain("from price_cache");
    expect(catalogSql).toContain("not exists");
    expect(catalogSql).toContain("candidate.verified_at is null");
    expect(catalogSql).toContain("last_refreshed_at asc nulls first");
    expect(catalogSql).toContain("ean asc");

    const prices = readerWith([{ ean: "7038010000010" }]);
    await expect(prices.reader.getPriceGtins(100, "ordinary_only")).resolves.toEqual([
      "7038010000010",
    ]);
    const priceSql = (prices.client.mock.calls[1]?.[0] as readonly string[]).join("?");
    expect(priceSql).toContain("product.status = 'active'");
    expect(priceSql).not.toContain("'quarantined'");
    expect(priceSql).toContain("observation.claim_eligibility =");
    expect(priceSql).toContain("run.status = 'completed'");
    expect(priceSql).toContain("refresh.last_refreshed_at asc nulls first");
  });

  it("cycles catalog discovery beyond page one while revisiting new products weekly", async () => {
    expect(catalogDiscoveryPageForCompletedRuns(0)).toBe(1);
    expect(catalogDiscoveryPageForCompletedRuns(1)).toBe(2);
    expect(catalogDiscoveryPageForCompletedRuns(6)).toBe(7);
    expect(catalogDiscoveryPageForCompletedRuns(7)).toBe(1);
    expect(catalogDiscoveryPageForCompletedRuns(8)).toBe(8);
    expect(catalogDiscoveryPageForCompletedRuns(115)).toBe(100);
    expect(catalogDiscoveryPageForCompletedRuns(116)).toBe(2);
    expect(() => catalogDiscoveryPageForCompletedRuns(-1)).toThrow(TypeError);

    const query = Object.assign(Promise.resolve([{ completed_runs: 1 }]), { cancel: vi.fn() });
    const client = vi.fn((..._args: unknown[]) => query);
    const reader = new PostgresWorkerGtinTargetReader({ $client: client } as unknown as HandleplanDatabase);
    await expect(reader.getCatalogDiscoveryPage()).resolves.toBe(2);
    const sql = (client.mock.calls[0]?.[0] as readonly string[]).join("?");
    expect(sql).toContain("run_type = 'catalog'");
    expect(sql).toContain("status = 'completed'");
    expect(sql).not.toContain("'degraded'");
    expect(sql).toContain("count(*) % 693");
  });

  it("rejects unsafe limits before querying", async () => {
    const { client, reader } = readerWith([]);
    await expect(reader.getCatalogGtins(0)).rejects.toBeInstanceOf(TypeError);
    await expect(reader.getPriceGtins(501, "ordinary_only")).rejects.toBeInstanceOf(TypeError);
    expect(client).not.toHaveBeenCalled();
  });

  it("cancels a pending query on shutdown", async () => {
    let reject!: (error: unknown) => void;
    const pending = Object.assign(new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }), { cancel: vi.fn(() => reject(new Error("cancelled"))) });
    const reader = new PostgresWorkerGtinTargetReader({
      $client: vi.fn(() => pending),
    } as unknown as HandleplanDatabase);
    const controller = new AbortController();

    const targets = reader.getCatalogGtins(100, controller.signal);
    controller.abort();
    await expect(targets).rejects.toMatchObject({ code: "CANCELLED" });
    expect(pending.cancel).toHaveBeenCalledOnce();
  });
  it("advances the price-target window one full page per completed run", async () => {
    let clientCalls = 0;
    const client = vi.fn((..._args: unknown[]) => {
      clientCalls += 1;
      return Object.assign(Promise.resolve([]), { cancel: vi.fn() });
    });
    const reader = new PostgresWorkerGtinTargetReader({ $client: client } as unknown as HandleplanDatabase);
    await reader.getPriceGtins(2, "ordinary_only");
    await reader.getGapPriceGtins(2, ["bunnpris", "extra", "rema-1000"]);
    expect(clientCalls).toBe(4);
    const sqlOf = (call: readonly unknown[]) => (call.join("")).replace(/\s+/g, " ");
    const priceCursorSql = sqlOf(client.mock.calls[0]![0] as readonly string[]);
    const pricePageSql = sqlOf(client.mock.calls[1]![0] as readonly string[]);
    const gapCursorSql = sqlOf(client.mock.calls[2]![0] as readonly string[]);
    const gapPageSql = sqlOf(client.mock.calls[3]![0] as readonly string[]);
    // Rotation cursor counts mirror the page-query filters.
    expect(priceCursorSql).toContain("run_type = any (array['benchmark-prices', 'historical-prices'])");
    expect(priceCursorSql).toContain("product.status = 'active'");
    expect(priceCursorSql).not.toContain("not exists");
    expect(pricePageSql).toMatch(/limit offset\s*$/);
    expect(gapCursorSql).toContain("run_type = any (array['benchmark-prices'])");
    expect(gapCursorSql).toContain("not exists");
    expect(gapPageSql).toMatch(/limit ::integer offset ::integer\s*$/);
  });

  it("rotates price targets past a starved alphabetical window", async () => {
    expect(priceTargetPageState(0, 9, 2)).toBe(0);
    expect(priceTargetPageState(1, 9, 2)).toBe(2);
    expect(priceTargetPageState(4, 9, 2)).toBe(8);
    expect(priceTargetPageState(5, 9, 2)).toBe(0);
    expect(priceTargetPageState(6, 9, 2)).toBe(2);
    expect(priceTargetPageState(3, 0, 2)).toBe(0);
    expect(priceTargetPageState(2, 0, 2)).toBe(0);
    expect(() => priceTargetPageState(-1, 9, 2)).toThrow(TypeError);
    expect(() => priceTargetPageState(0, -1, 2)).toThrow(TypeError);
    expect(() => priceTargetPageState(0, 9, 0)).toThrow(TypeError);
  });
  it("rejects invalid completed-run cursor rows", async () => {
    expect(completedRunsForRotation([])).toBe(0);
    expect(completedRunsForRotation([{ completed_runs: 7 }])).toBe(7);
    expect(completedRunsForRotation([{ completed_runs: null }])).toBe(0);
    expect(() => completedRunsForRotation([{ completed_runs: -3 }])).toThrow(TypeError);
  });
});
