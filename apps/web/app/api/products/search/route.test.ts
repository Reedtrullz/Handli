import {
  PublicCatalogIndexReaderError,
  type PublicCatalogIndexReader,
} from "@handleplan/db/public-catalog-index-reader";
import type { ExactProductPlanApiProductSummary } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSearchHandler } from "./route";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const product: ExactProductPlanApiProductSummary = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-16T11:00:00.000Z",
    source: {
      contractVersion: 1,
      displayName: "Kassalapp",
      id: "kassalapp",
      sourceClass: "ordinary-price",
      state: "approved",
    },
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "TINE Lettmelk 1 %",
  gtin: "7038010000010",
  packageMeasure: { amount: 1_000, unit: "ml" },
  unitsPerPack: 1,
};

function request(q: string): Request {
  return new Request(`https://handleplan.no/api/products/search?q=${encodeURIComponent(q)}`);
}

function reader(search: PublicCatalogIndexReader["search"]): PublicCatalogIndexReader {
  return { browse: async () => [], search };
}

describe("GET /api/products/search", () => {
  it("returns only canonical public metadata from the persisted catalog", async () => {
    const search = vi.fn<PublicCatalogIndexReader["search"]>().mockResolvedValue([product]);
    const incoming = request("melk");

    const response = await createSearchHandler(() => reader(search), () => NOW)(incoming);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      contractVersion: 1,
      products: [{
        brand: "TINE",
        contractVersion: 1,
        displayName: "TINE Lettmelk 1 %",
        gtin: "7038010000010",
        packageMeasure: { amount: 1_000, unit: "ml" },
        unitsPerPack: 1,
      }],
    });
    expect(search).toHaveBeenCalledWith("melk", 20, NOW, incoming.signal);
    expect(JSON.stringify(await (await createSearchHandler(
      () => reader(async () => [product]),
      () => NOW,
    )(request("melk"))).json())).not.toMatch(/catalogEvidence|sourceRecord|permission|raw/i);
  });

  it.each(["", "m", " "])('rejects the too-short query "%s"', async (query) => {
    const response = await createSearchHandler(() => reader(async () => []))(request(query));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
  });

  it("rejects oversized, duplicate, and unexpected query parameters before reading", async () => {
    const search = vi.fn<PublicCatalogIndexReader["search"]>();
    const handler = createSearchHandler(() => reader(search));

    expect((await handler(request("m".repeat(121)))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/products/search?q=melk&q=ost"))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/products/search?q=melk&debug=1"))).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_REQUEST", 400, "INVALID_REQUEST"],
    ["CANCELLED", 499, "REQUEST_CANCELLED"],
    ["UNAVAILABLE", 503, "CATALOG_UNAVAILABLE"],
  ] as const)("maps %s without exposing storage details", async (readerCode, status, code) => {
    const response = await createSearchHandler(() => reader(async () => {
      const error = new PublicCatalogIndexReaderError(readerCode);
      error.stack = "secret postgres stack";
      throw error;
    }))(request("melk"));

    expect(response.status).toBe(status);
    const body = JSON.stringify(await response.json());
    expect(body).toBe(JSON.stringify({ code }));
    expect(body).not.toMatch(/postgres|stack|query|Bearer/i);
  });

  it("fails closed if the reader returns malformed catalog data", async () => {
    const response = await createSearchHandler(() => reader(async () => [
      { ...product, displayName: "" },
    ] as ExactProductPlanApiProductSummary[]))(request("melk"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "CATALOG_UNAVAILABLE" });
  });
});
