import { describe, expect, it } from "vitest";
import { TjekClient } from "./client";

// Tests for offer normalization via the new incito + offer detail flow.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function incitoWithOffers(viewIds: string[]) {
  return {
    id: "test-catalog",
    root_view: {
      role: "paged-mandatory",
      child_views: viewIds.map((id) => ({
        role: "section",
        child_views: [{ role: "offer", id }],
      })),
    },
  };
}

function offerDetail(name: string, price: number, extra: Record<string, unknown> = {}) {
  return {
    offer: {
      name,
      price,
      currency_code: "NOK",
      validity: { from: "2026-08-17T22:00:00Z", to: "2026-08-24T22:00:00Z" },
      ...extra,
    },
  };
}

function createClientWithFlow(responses: unknown[]) {
  let callIndex = 0;
  const mockFetch = async () => {
    const resp = responses[callIndex] ?? {};
    callIndex += 1;
    return jsonResponse(resp);
  };
  return new TjekClient({
    apiKey: "test-key",
    baseUrl: "https://fixture.invalid",
    fetch: mockFetch as typeof fetch,
  });
}

describe("TjekClient offer normalization", () => {
  it("normalizes a fully populated offer", async () => {
    const client = createClientWithFlow([
      incitoWithOffers(["v1"]),
      offerDetail("Kyllingbryst", 59.9, {
        unit_symbol: "g",
        unit_size: { from: 400, to: 1 },
      }),
    ]);

    const result = await client.getOffersFromCatalog("cat-1");

    expect(result).toHaveLength(1);
    const offer = result[0]!;
    expect(offer.name).toBe("Kyllingbryst");
    expect(offer.price).toBe(59.9);
    expect(offer.unit).toBe("g");
    expect(offer.quantity).toBe("400");
    expect(offer.catalog_id).toBe("cat-1");
    expect(offer.dealer_id).toBe("5b11sm");
  });

  it("normalizes multiple offers from different view IDs", async () => {
    const client = createClientWithFlow([
      incitoWithOffers(["v1", "v2"]),
      offerDetail("Kjøttdeig", 40),
      offerDetail("Melk 1L", 14.9),
    ]);

    const result = await client.getOffersFromCatalog("cat-2");

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("Kjøttdeig");
    expect(result[0]!.price).toBe(40);
    expect(result[1]!.name).toBe("Melk 1L");
    expect(result[1]!.price).toBe(14.9);
  });

  it("skips offers with missing name or price", async () => {
    const client = createClientWithFlow([
      incitoWithOffers(["v1", "v2", "v3"]),
      { offer: { price: 10 } },  // missing name
      { offer: { name: "No price" } },  // missing price
      offerDetail("Valid Offer", 25),
    ]);

    const result = await client.getOffersFromCatalog("cat-3");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Valid Offer");
  });

  it("handles before_price (discount)", async () => {
    const client = createClientWithFlow([
      incitoWithOffers(["v1"]),
      offerDetail("Pålegg", 25, { before_price: 35 }),
    ]);

    const result = await client.getOffersFromCatalog("cat-4");
    expect(result).toHaveLength(1);
    expect(result[0]!.before_price).toBe(35);
  });

  it("returns empty when no offer views found", async () => {
    const client = createClientWithFlow([
      incitoWithOffers([]),
    ]);

    const result = await client.getOffersFromCatalog("cat-5");
    expect(result).toHaveLength(0);
  });
});
