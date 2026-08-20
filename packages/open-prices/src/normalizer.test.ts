import { describe, expect, it } from "vitest";
import { normalizeOpenPricesOutcome, OPEN_PRICES_SOURCE_ID } from "./normalizer";
import type { OpenPricesPrice } from "./types";

function makePrice(overrides: Partial<OpenPricesPrice> = {}): OpenPricesPrice {
  return {
    id: 42,
    product_code: "7038010000010",
    price: 29.9,
    currency: "NOK",
    date: "2026-08-15",
    price_is_discounted: false,
    price_without_discount: null,
    unit_price: null,
    quantity: null,
    location_id: 2728,
    location_osm_id: 12345,
    location_osm_type: "node",
    owner: "testuser",
    source: null,
    tags: [],
    created: "2026-08-15T10:00:00Z",
    updated: "2026-08-15T10:00:00Z",
    proof_id: null,
    ...overrides,
  };
}

const FETCHED_AT = new Date("2026-08-16T12:00:00Z");

describe("normalizeOpenPricesOutcome", () => {
  it("accepts valid price with known Rema 1000 location (id 2728)", () => {
    const price = makePrice({ location_id: 2728 });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("accepted");
    if (result.outcomeState !== "accepted") throw new Error("unreachable");
    expect(result.subjectChain).toBe("rema-1000");
    expect(result.subjectEan).toBe("7038010000010");
    expect(result.price.amountOre).toBe(2990);
    expect(result.price.sourceReference).toBe(`${OPEN_PRICES_SOURCE_ID}:42`);
    expect(result.sourceRecordId).toBe("op-42");
  });

  it("accepts valid price with known Bunnpris location (id 2729)", () => {
    const price = makePrice({ location_id: 2729 });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("accepted");
    if (result.outcomeState !== "accepted") throw new Error("unreachable");
    expect(result.subjectChain).toBe("bunnpris");
  });

  it("accepts valid price with known Extra location (id 341)", () => {
    const price = makePrice({ location_id: 341 });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("accepted");
    if (result.outcomeState !== "accepted") throw new Error("unreachable");
    expect(result.subjectChain).toBe("extra");
  });

  it("quarantines invalid GTIN (empty string)", () => {
    const price = makePrice({ product_code: "" });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("quarantined");
    if (result.outcomeState !== "quarantined") throw new Error("unreachable");
    expect(result.reason).toBe("INVALID_GTIN");
  });

  it("quarantines invalid GTIN (too short)", () => {
    const price = makePrice({ product_code: "123" });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("quarantined");
    if (result.outcomeState !== "quarantined") throw new Error("unreachable");
    expect(result.reason).toBe("INVALID_GTIN");
  });

  it("quarantines zero price", () => {
    const price = makePrice({ price: 0 });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("quarantined");
    if (result.outcomeState !== "quarantined") throw new Error("unreachable");
    expect(result.reason).toBe("INVALID_PRICE");
  });

  it("quarantines negative price", () => {
    const price = makePrice({ price: -5.0 });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("quarantined");
    if (result.outcomeState !== "quarantined") throw new Error("unreachable");
    expect(result.reason).toBe("INVALID_PRICE");
  });

  it("quarantines EUR currency", () => {
    const price = makePrice({ currency: "EUR" });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("quarantined");
    if (result.outcomeState !== "quarantined") throw new Error("unreachable");
    expect(result.reason).toBe("UNSUPPORTED_CURRENCY");
  });

  it("quarantines invalid date string", () => {
    const price = makePrice({ date: "not-a-date" });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("quarantined");
    if (result.outcomeState !== "quarantined") throw new Error("unreachable");
    expect(result.reason).toBe("INVALID_DATE");
  });

  it("marks unknown location ID with no brand as unknown UNKNOWN_CHAIN", () => {
    const price = makePrice({
      location_id: 99999,
      location: {
        id: 99999,
        osm_id: 99999,
        osm_type: "node",
        osm_name: null,
        osm_address_city: null,
        osm_address_country: null,
        osm_brand: null,
        osm_lat: null,
        osm_lon: null,
        price_count: 0,
      },
    });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("unknown");
    if (result.outcomeState !== "unknown") throw new Error("unreachable");
    expect(result.reason).toBe("UNKNOWN_CHAIN");
  });

  it("accepts discounted price (price_is_discounted=true)", () => {
    const price = makePrice({
      price_is_discounted: true,
      price_without_discount: 39.9,
    });
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("accepted");
    if (result.outcomeState !== "accepted") throw new Error("unreachable");
    expect(result.price.amountOre).toBe(2990);
  });

  it("passes through geographicScopeId when provided", () => {
    const price = makePrice();
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT, 42);

    expect(result.outcomeState).toBe("accepted");
    if (result.outcomeState !== "accepted") throw new Error("unreachable");
    expect(result.price.geographicScopeId).toBe(42);
  });

  it("omits geographicScopeId when not provided", () => {
    const price = makePrice();
    const result = normalizeOpenPricesOutcome(price, FETCHED_AT);

    expect(result.outcomeState).toBe("accepted");
    if (result.outcomeState !== "accepted") throw new Error("unreachable");
    expect(result.price.geographicScopeId).toBeUndefined();
  });
});
