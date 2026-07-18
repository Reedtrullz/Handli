import { describe, expect, it } from "vitest";

import {
  MARKET_CONTEXT_CONTRACT_VERSION,
  NATIONAL_MARKET_CONTEXT_V1,
  marketContextsEqual,
  marketContextToGeographicContext,
  marketContextV1Schema,
} from "./market-context";

describe("MarketContextV1", () => {
  it("keeps national selection explicit and store-free", () => {
    expect(marketContextV1Schema.parse(NATIONAL_MARKET_CONTEXT_V1)).toEqual({
      contractVersion: MARKET_CONTEXT_CONTRACT_VERSION,
      countryCode: "NO",
      kind: "national",
    });
    expect(marketContextToGeographicContext(NATIONAL_MARKET_CONTEXT_V1)).toEqual({
      countryCode: "NO",
    });
  });

  it("maps an explicit launch region without inferring a store", () => {
    const market = marketContextV1Schema.parse({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "no-0301-oslo",
    });
    expect(marketContextToGeographicContext(market)).toEqual({
      countryCode: "NO",
      regionCode: "no-0301-oslo",
    });
  });

  it("rejects unversioned, foreign, malformed, and store-shaped contexts", () => {
    expect(marketContextV1Schema.safeParse({ countryCode: "NO", kind: "national" }).success)
      .toBe(false);
    expect(marketContextV1Schema.safeParse({
      contractVersion: 1,
      countryCode: "SE",
      kind: "national",
    }).success).toBe(false);
    expect(marketContextV1Schema.safeParse({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "oslo",
    }).success).toBe(false);
    expect(marketContextV1Schema.safeParse({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "no-0301-oslo",
      storeId: "store:1",
    }).success).toBe(false);
  });

  it("compares canonical contexts exactly", () => {
    const oslo = marketContextV1Schema.parse({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "no-0301-oslo",
    });
    const bergen = marketContextV1Schema.parse({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "no-4601-bergen",
    });
    expect(marketContextsEqual(oslo, oslo)).toBe(true);
    expect(marketContextsEqual(oslo, bergen)).toBe(false);
    expect(marketContextsEqual(oslo, NATIONAL_MARKET_CONTEXT_V1)).toBe(false);
  });
});
