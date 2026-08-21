import { describe, expect, it, vi } from "vitest";

import { WorkerCancelledError } from "./runner";
import {
  createTjekHandlers,
  matchOfferToProduct,
  normalizeOfferName,
  scoreProductMatch,
  TJEK_JOB_KIND,
  TJEK_SOURCE_ID,
} from "./tjek-handlers";

const CATALOG = {
  id: "catalog-2026-08-21",
  dealer_id: "5b11sm",
  publication_date: "2026-08-21",
  run_from: "2026-08-21T00:00:00.000Z",
  run_till: "2026-08-27T23:59:59.000Z",
  offer_count: 1,
  brand: "Bunnpris",
  brand_logo_url: null,
  cover_image_url: null,
  page_count: 1,
  type: "incito",
  locale: "nb-NO",
  country_code: "NO",
} as const;

function context(signal = new AbortController().signal) {
  return {
    signal,
    jobId: "tjek-job-1",
    kind: TJEK_JOB_KIND,
    runId: "run-1",
    sourceId: TJEK_SOURCE_ID,
    fenceToken: "fence-1",
  };
}

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    getLatestCatalog: vi.fn(async () => CATALOG),
    getOffersFromCatalog: vi.fn(async () => []),
    getAllLatestCatalogs: vi.fn(async () => [{ ...CATALOG, chainId: "bunnpris" }]),
    canExtractOffers: vi.fn(() => true),
    ...overrides,
  };
}

describe("Tjek fuzzy product matching", () => {
  it("normalizes case, accents, punctuation, and packaging words", () => {
    expect(normalizeOfferName("TINE Lettmelk L,  tilbud!")).toBe("tine lettmelk");
    expect(normalizeOfferName("Kaffe g")).toBe("kaffe");
  });

  it("scores a strong token match above unrelated products", () => {
    expect(scoreProductMatch("Tine Lettmelk 1L", "TINE Lettmelk")).toBeGreaterThanOrEqual(80);
    expect(scoreProductMatch("Tine Lettmelk", "Grandiosa Pizza")).toBe(0);
  });

  it("chooses the highest-confidence product and respects the threshold", () => {
    const products = [
      { id: 1, displayName: "Tine Helmelk" },
      { id: 2, displayName: "Tine Lettmelk" },
    ];
    expect(matchOfferToProduct("Tine Lettmelk 1L", products)).toMatchObject({
      productId: 2,
      displayName: "Tine Lettmelk",
    });
    expect(matchOfferToProduct("Grandiosa Pizza", products)).toBeUndefined();
    expect(matchOfferToProduct("Tine Lettmelk", products, 101)).toBeUndefined();
  });
});

describe("Tjek worker handler wiring and idempotency", () => {
  it("skips an existing catalog across all dealers", async () => {
    const queryCalls: unknown[][] = [];
    const db = {
      $client: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queryCalls.push([strings[0], ...values]);
        return [{ id: 99 }];
      }),
    };
    const client = mockClient();
    const handlers = createTjekHandlers({ client, db: db as never });

    expect(handlers[TJEK_JOB_KIND]).toEqual(expect.any(Function));
    await expect(handlers[TJEK_JOB_KIND]!(context())).resolves.toEqual({ counters: { fetched: 0, accepted: 0, quarantined: 0, unknown: 0, persisted: 0, failed: 0 } });
    expect(client.getAllLatestCatalogs).toHaveBeenCalledWith(expect.anything());
    expect(client.getOffersFromCatalog).not.toHaveBeenCalled();
  });

  it("fails closed on a pre-cancelled signal before making source or database calls", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = mockClient();
    const db = { $client: vi.fn() };
    const handlers = createTjekHandlers({ client, db: db as never });

    await expect(handlers[TJEK_JOB_KIND]!(context(controller.signal))).rejects.toBeInstanceOf(WorkerCancelledError);
    expect(client.getAllLatestCatalogs).not.toHaveBeenCalled();
    expect(db.$client).not.toHaveBeenCalled();
  });
});
