import { describe, expect, it } from "vitest";
import { TjekClient } from "./client";
import type { TjekRpcOfferResponseItem } from "./types";

// Tests for offer normalization via the client's parseOfferResponse.
// We exercise it indirectly through getOffersFromCatalog with a mock fetch.

function createClientForParsing(items: readonly TjekRpcOfferResponseItem[]) {
  const mockFetch = async () =>
    new Response(JSON.stringify(items), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  return new TjekClient({
    baseUrl: "https://fixture.invalid",
    fetch: mockFetch as typeof fetch,
  });
}

describe("TjekClient offer normalization", () => {
  it("normalizes a fully populated offer", async () => {
    const client = createClientForParsing([
      {
        id: "full-1",
        heading: "Kjott",
        name: "Kyllingbryst",
        price: 59.9,
        price_text: "kr 59,90",
        before_price: 79.9,
        quantity: "400",
        unit: "g",
        run_from: "2026-08-17T22:00:00Z",
        run_till: "2026-08-24T21:59:00Z",
        image_url: "https://example.com/kylling.jpg",
        page_number: 3,
      },
    ]);

    const result = await client.getOffersFromCatalog("cat-1");

    expect(result).toHaveLength(1);
    const offer = result[0]!;
    expect(offer.id).toBe("full-1");
    expect(offer.heading).toBe("Kjott");
    expect(offer.name).toBe("Kyllingbryst");
    expect(offer.price).toBe(59.9);
    expect(offer.price_text).toBe("kr 59,90");
    expect(offer.before_price).toBe(79.9);
    expect(offer.quantity).toBe("400");
    expect(offer.unit).toBe("g");
    expect(offer.run_from).toBe("2026-08-17T22:00:00Z");
    expect(offer.run_till).toBe("2026-08-24T21:59:00Z");
    expect(offer.catalog_id).toBe("cat-1");
    expect(offer.dealer_id).toBe("5b11sm");
    expect(offer.image_url).toBe("https://example.com/kylling.jpg");
    expect(offer.page_number).toBe(3);
  });

  it("normalizes an offer with null price", async () => {
    const client = createClientForParsing([
      {
        id: "np-1",
        name: "Ukjent pris",
        price: undefined,
      },
    ]);

    const result = await client.getOffersFromCatalog("cat-2");

    expect(result).toHaveLength(1);
    expect(result[0]!.price).toBeNull();
    expect(result[0]!.price_text).toBeNull();
    expect(result[0]!.before_price).toBeNull();
  });

  it("normalizes an offer with before_price (discount)", async () => {
    const client = createClientForParsing([
      {
        id: "disc-1",
        name: "Paalegg",
        price: 25.0,
        before_price: 35.0,
      },
    ]);

    const result = await client.getOffersFromCatalog("cat-3");

    expect(result).toHaveLength(1);
    expect(result[0]!.price).toBe(25.0);
    expect(result[0]!.before_price).toBe(35.0);
  });

  it("handles offer with all missing optional fields", async () => {
    const client = createClientForParsing([{}]);

    const result = await client.getOffersFromCatalog("cat-empty");

    expect(result).toHaveLength(1);
    const offer = result[0]!;
    expect(offer.id).toBe("cat-empty-0");
    expect(offer.heading).toBeNull();
    expect(offer.name).toBe("Offer 0");
    expect(offer.price).toBeNull();
    expect(offer.price_text).toBeNull();
    expect(offer.before_price).toBeNull();
    expect(offer.quantity).toBeNull();
    expect(offer.unit).toBeNull();
    expect(offer.run_from).toBe("");
    expect(offer.run_till).toBe("");
    expect(offer.image_url).toBeNull();
    expect(offer.page_number).toBeNull();
  });

  it("prefers name over heading for display name", async () => {
    const client = createClientForParsing([
      {
        heading: "Meieri",
        name: "Yoghurt",
      },
    ]);

    const result = await client.getOffersFromCatalog("cat-4");

    expect(result[0]!.name).toBe("Yoghurt");
    expect(result[0]!.heading).toBe("Meieri");
  });

  it("falls back to heading when name is missing", async () => {
    const client = createClientForParsing([
      {
        heading: "Tilbud paa frokost",
      },
    ]);

    const result = await client.getOffersFromCatalog("cat-5");

    expect(result[0]!.name).toBe("Tilbud paa frokost");
    expect(result[0]!.heading).toBe("Tilbud paa frokost");
  });

  it("generates sequential fallback ids", async () => {
    const client = createClientForParsing([{}, {}, {}]);

    const result = await client.getOffersFromCatalog("seq");

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe("seq-0");
    expect(result[1]!.id).toBe("seq-1");
    expect(result[2]!.id).toBe("seq-2");
  });
});
