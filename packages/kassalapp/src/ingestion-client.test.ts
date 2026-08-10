import { describe, expect, it, vi } from "vitest";

import categoriesFixture from "../test/fixtures/v1/categories.json";
import labelsFixture from "../test/fixtures/v1/labels.json";
import physicalStoresFixture from "../test/fixtures/v1/physical-stores.json";
import pricesFixture from "../test/fixtures/v1/prices-bulk.json";
import productByEanFixture from "../test/fixtures/v1/product-by-ean.json";
import productByIdFixture from "../test/fixtures/v1/product-by-id.json";
import { KassalappClient, type KassalappRequestAttemptAuthorizer } from "./client";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const API_KEY = "synthetic-test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function gtin13(sequence: number): string {
  const body = String(sequence).padStart(12, "0");
  const weighted = [...body].reduce((sum, digit, index) =>
    sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

describe("KassalappClient ingestion gateway", () => {
  it("rechecks authorization after Retry-After and suppresses a revoked retry", async () => {
    const events: string[] = [];
    const authorizeRequestAttempt = vi.fn(async ({ attempt, scope }) => {
      events.push(`authorize:${scope}:${attempt}`);
      if (attempt === 2) throw new Error("private revoked policy detail");
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      events.push("fetch");
      return new Response(null, {
        headers: { "retry-after": "0" },
        status: 503,
      });
    });
    const client = new KassalappClient({
      apiKey: API_KEY,
      authorizeRequestAttempt,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch,
      now: () => NOW,
    });

    await expect(client.getSourceProductByEan("7038010000010")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(events).toEqual([
      "authorize:catalog:1",
      "fetch",
      "authorize:catalog:2",
    ]);
    expect(authorizeRequestAttempt).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rechecks authorization before every physical-store chain request", async () => {
    let checks = 0;
    const authorizeRequestAttempt = vi.fn<KassalappRequestAttemptAuthorizer>(async () => {
      checks += 1;
      if (checks > 1) throw new Error("private revoked policy detail");
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      data: [physicalStoresFixture.data[0]],
    }));
    const client = new KassalappClient({
      apiKey: API_KEY,
      authorizeRequestAttempt,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch,
      now: () => NOW,
    });

    const result = await client.getSourcePhysicalStores();

    expect(fetch).toHaveBeenCalledOnce();
    expect(authorizeRequestAttempt).toHaveBeenCalledTimes(3);
    expect(authorizeRequestAttempt.mock.calls.map(([context]) => context)).toEqual([
      { attempt: 1, scope: "physical-store" },
      { attempt: 1, scope: "physical-store" },
      { attempt: 1, scope: "physical-store" },
    ]);
    expect(result.coverage).toEqual([
      expect.objectContaining({ chainCode: "BUNNPRIS", state: "complete" }),
      expect.objectContaining({ chainCode: "REMA_1000", reason: "REQUEST_FAILED", state: "unknown" }),
      expect.objectContaining({ chainCode: "COOP_EXTRA", reason: "REQUEST_FAILED", state: "unknown" }),
    ]);
  });

  it("discovers a bounded source-normalized catalog page", async () => {
    const urls: string[] = [];
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async (input) => {
        urls.push(String(input));
        return jsonResponse({ data: [productByIdFixture.data] });
      },
      now: () => NOW,
    });

    await expect(client.getSourceCatalogProducts(1, 100)).resolves.toEqual([
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({ ean: "7038010000010", sourceRecordId: "117" }),
      }),
    ]);
    expect(urls).toEqual([
      "https://fixture.invalid/api/v1/products?page=1&size=100&sort=date_desc&unique=1&exclude_without_ean=1",
    ]);
    await expect(client.getSourceCatalogProducts(1, 101)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("preserves every retailer product from the official EAN comparison response", async () => {
    const urls: string[] = [];
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        return jsonResponse(url.includes("/ean/") ? productByEanFixture : productByIdFixture);
      },
      now: () => NOW,
    });

    await expect(client.getSourceProductByEan("7038010000010")).resolves.toEqual([
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({
          chainCodes: ["BUNNPRIS"],
          contractVersion: 1,
          kind: "product",
          sourceRecordId: "117",
        }),
      }),
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({
          chainCodes: ["REMA_1000"],
          contractVersion: 1,
          kind: "product",
          sourceRecordId: "118",
        }),
      }),
    ]);
    await expect(client.getSourceProductById(117)).resolves.toMatchObject({
      state: "accepted",
      record: { contractVersion: 1, kind: "product", sourceRecordId: "117" },
    });
    expect(urls).toEqual([
      "https://fixture.invalid/api/v1/products/ean/7038010000010",
      "https://fixture.invalid/api/v1/products/id/117",
    ]);
  });

  it("requires a positive integer product ID and quarantines a returned-ID mismatch", async () => {
    const fetch = async () => jsonResponse({
      ...productByIdFixture,
      data: { ...productByIdFixture.data, id: 118 },
    });
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch,
      now: () => NOW,
    });

    await expect(client.getSourceProductById(117)).resolves.toMatchObject({
      state: "quarantined",
      reason: "IDENTIFIER_MISMATCH",
      sourceRecordId: "118",
    });
    await expect(client.getSourceProductById(0)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(client.getSourceProductById(1.5)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("represents an exact lookup 404 as unknown rather than provider failure", async () => {
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => jsonResponse({ message: "not found" }, 404),
      now: () => NOW,
    });

    await expect(client.getSourceProductByEan("7038010000010")).resolves.toEqual([{
      ean: "7038010000010",
      state: "unknown",
      sourceRecordId: "7038010000010",
      reason: "NOT_FOUND",
    }]);
  });

  it("requests the bounded category maximum and reports complete coverage below the cap", async () => {
    const urls: string[] = [];
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        const path = url.pathname;
        if (path.endsWith("/categories")) return jsonResponse(categoriesFixture);
        if (path.endsWith("/labels")) return jsonResponse(labelsFixture);
        return jsonResponse(labelsFixture);
      },
      now: () => NOW,
    });

    await expect(client.getSourceCategories()).resolves.toEqual({
      coverage: [{ recordCount: 2, state: "complete" }],
      outcomes: expect.arrayContaining([
        expect.objectContaining({ state: "accepted" }),
        expect.objectContaining({ state: "accepted" }),
      ]),
    });
    await expect(client.getSourceLabels()).resolves.toHaveLength(2);
    expect(urls).toEqual([
      "https://fixture.invalid/api/v1/categories?size=100",
      "https://fixture.invalid/api/v1/labels",
    ]);
  });

  it("marks a category response at the endpoint cap as possibly truncated", async () => {
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => jsonResponse({
        data: Array.from({ length: 100 }, (_, index) => ({
          ...categoriesFixture.data[0]!,
          id: String(index + 1),
          name: `Category ${index + 1}`,
        })),
      }),
      now: () => NOW,
    });

    await expect(client.getSourceCategories()).resolves.toMatchObject({
      coverage: [{ recordCount: 100, reason: "POSSIBLY_TRUNCATED", state: "unknown" }],
      outcomes: expect.any(Array),
    });
  });

  it.each([
    ["malformed", (base: typeof categoriesFixture.data[number]) => ({ ...base, name: "" })],
    ["conflicting", (base: typeof categoriesFixture.data[number]) => ({ ...base, name: `${base.name} conflict` })],
  ])("marks a below-cap category page with %s records as unknown", async (_label, second) => {
    const base = categoriesFixture.data[0]!;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => jsonResponse({ data: [base, second(base)] }),
      now: () => NOW,
    });

    await expect(client.getSourceCategories()).resolves.toMatchObject({
      coverage: [{ recordCount: 2, reason: "INVALID_RECORDS", state: "unknown" }],
      outcomes: [expect.objectContaining({ state: "quarantined" })],
    });
  });

  it("syncs each required chain within the official size bound and exposes coverage gaps", async () => {
    const urls: string[] = [];
    const baseStore = physicalStoresFixture.data[0]!;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        const group = url.searchParams.get("group");
        if (group === "BUNNPRIS") return jsonResponse({ data: [baseStore] });
        if (group === "REMA_1000") return jsonResponse({ data: [] });
        return jsonResponse({
          data: Array.from({ length: 100 }, (_, index) => ({
            ...baseStore,
            id: 1_000 + index,
            group: "COOP_EXTRA",
            name: `Extra ${index}`,
            position: { lat: null, lng: null },
          })),
        });
      },
      now: () => NOW,
    });

    const result = await client.getSourcePhysicalStores();
    expect(urls).toEqual([
      "https://fixture.invalid/api/v1/physical-stores?group=BUNNPRIS&size=100",
      "https://fixture.invalid/api/v1/physical-stores?group=REMA_1000&size=100",
      "https://fixture.invalid/api/v1/physical-stores?group=COOP_EXTRA&size=100",
    ]);
    expect(result.outcomes.filter((outcome) => outcome.state === "accepted")).toHaveLength(101);
    expect(result.coverage).toEqual([
      { chainCode: "BUNNPRIS", chainId: "bunnpris", recordCount: 1, state: "complete" },
      {
        chainCode: "REMA_1000",
        chainId: "rema-1000",
        recordCount: 0,
        reason: "MISSING_SUPPORTED_CHAIN",
        state: "unknown",
      },
      {
        chainCode: "COOP_EXTRA",
        chainId: "extra",
        recordCount: 100,
        reason: "POSSIBLY_TRUNCATED",
        state: "unknown",
      },
    ]);
  });

  it("downgrades both chain coverages when one store identity appears across chains", async () => {
    const baseStore = physicalStoresFixture.data[0]!;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async (input) => {
        const group = new URL(String(input)).searchParams.get("group");
        if (group === "REMA_1000") return jsonResponse({ data: [] });
        return jsonResponse({ data: [{ ...baseStore, group }] });
      },
      now: () => NOW,
    });

    const result = await client.getSourcePhysicalStores();
    expect(result.outcomes).toContainEqual(expect.objectContaining({
      state: "quarantined",
      sourceRecordId: "501",
      reason: "DUPLICATE_IDENTITY",
    }));
    expect(result.coverage).toEqual([
      {
        chainCode: "BUNNPRIS",
        chainId: "bunnpris",
        recordCount: 1,
        reason: "DUPLICATE_IDENTITY",
        state: "unknown",
      },
      {
        chainCode: "REMA_1000",
        chainId: "rema-1000",
        recordCount: 0,
        reason: "MISSING_SUPPORTED_CHAIN",
        state: "unknown",
      },
      {
        chainCode: "COOP_EXTRA",
        chainId: "extra",
        recordCount: 1,
        reason: "DUPLICATE_IDENTITY",
        state: "unknown",
      },
    ]);
  });

  it("downgrades accepted coverage when the same store identity is quarantined on another chain page", async () => {
    const baseStore = physicalStoresFixture.data[0]!;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async (input) => {
        const group = new URL(String(input)).searchParams.get("group");
        if (group === "BUNNPRIS") return jsonResponse({ data: [baseStore] });
        if (group === "COOP_EXTRA") {
          return jsonResponse({ data: [{ ...baseStore, group: "BUNNPRIS" }] });
        }
        return jsonResponse({ data: [] });
      },
      now: () => NOW,
    });

    const result = await client.getSourcePhysicalStores();
    expect(result.outcomes).toContainEqual(expect.objectContaining({
      state: "quarantined",
      sourceRecordId: "501",
      reason: "DUPLICATE_IDENTITY",
    }));
    expect(result.coverage).toContainEqual({
      chainCode: "BUNNPRIS",
      chainId: "bunnpris",
      recordCount: 1,
      reason: "DUPLICATE_IDENTITY",
      state: "unknown",
    });
  });

  it("exposes null prices and unknown chains from a bulk fetch", async () => {
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => jsonResponse(pricesFixture),
      now: () => NOW,
    });

    await expect(client.getSourceBulkPrices(["7038010000010"])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "accepted" }),
      expect.objectContaining({ state: "quarantined", reason: "UNKNOWN_CHAIN" }),
      expect.objectContaining({ state: "unknown", reason: "MISSING_PRICE" }),
      expect.objectContaining({ state: "unknown", reason: "MISSING_SUPPORTED_CHAIN" }),
    ]));
  });

  it("fetches historical observations separately from current observations", async () => {
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => jsonResponse(pricesFixture),
      now: () => NOW,
    });

    const outcomes = await client.getSourceHistoricalPrices(["7038010000010"]);
    expect(outcomes).toEqual([
      expect.objectContaining({
        state: "accepted",
        record: expect.objectContaining({
          amountOre: 2190,
          ean: "7038010000010",
          observationKind: "historical",
        }),
      }),
    ]);
    expect(outcomes.some((outcome) =>
      outcome.state === "accepted" && outcome.record.observationKind === "current"))
      .toBe(false);
  });

  it("bounds the total source bulk workload before making a request", async () => {
    let fetched = false;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => {
        fetched = true;
        return jsonResponse({ data: [] });
      },
      now: () => NOW,
    });

    await expect(client.getSourceBulkPrices(Array.from({ length: 10_001 }, () => "7038010000010")))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetched).toBe(false);
  });

  it("preserves earlier batch outcomes and marks only a failed later batch unknown", async () => {
    const eans = Array.from({ length: 101 }, (_, index) => gtin13(index + 1));
    let request = 0;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => {
        request += 1;
        if (request === 1) {
          return jsonResponse({
            data: [{ ...pricesFixture.data[0], ean: eans[0] }],
            meta: { ...pricesFixture.meta, requested_eans: 100 },
          });
        }
        return jsonResponse({ message: "private upstream detail" }, 500);
      },
      now: () => NOW,
    });

    const outcomes = await client.getSourceBulkPrices(eans);
    expect(outcomes).toContainEqual(expect.objectContaining({
      state: "accepted",
      record: expect.objectContaining({ ean: eans[0] }),
    }));
    expect(outcomes).toContainEqual({
      ean: eans[100],
      state: "unknown",
      sourceRecordId: eans[100],
      reason: "BATCH_FAILED",
    });
    expect(outcomes.filter((outcome) => outcome.state === "unknown" && outcome.reason === "BATCH_FAILED"))
      .toHaveLength(1);
  });

  it("keeps active cancellation distinct instead of converting it to batch failure", async () => {
    const eans = Array.from({ length: 101 }, (_, index) => gtin13(index + 1));
    const caller = new AbortController();
    let request = 0;
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch: async () => {
        request += 1;
        if (request === 1) {
          return jsonResponse({ data: [], meta: { ...pricesFixture.meta, requested_eans: 100, found_products: 0 } });
        }
        caller.abort("private cancellation reason");
        return jsonResponse({ data: [], meta: { ...pricesFixture.meta, requested_eans: 1, found_products: 0 } });
      },
      now: () => NOW,
    });

    await expect(client.getSourceBulkPrices(eans, caller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
