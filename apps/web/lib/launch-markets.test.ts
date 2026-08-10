import { describe, expect, it } from "vitest";

import {
  allowedLaunchMarketFromQueryValue,
  isAllowedLaunchMarketContext,
  launchMarketIsCandidateUnverified,
  launchMarketOptions,
  marketContextQueryValue,
} from "./launch-markets";

describe("launch market allowlist", () => {
  it("offers only explicit national scope and manifest candidate regions", () => {
    expect(launchMarketOptions.map(({ marketContext }) =>
      marketContextQueryValue(marketContext))).toEqual([
      "national",
      "no-0301-oslo",
      "no-4601-bergen",
      "no-5001-trondheim",
    ]);
    expect(launchMarketOptions.slice(1).every(({ candidateUnverified }) =>
      candidateUnverified)).toBe(true);
    expect(launchMarketOptions[0]?.label).toBe("Kun nasjonalt omfang");
  });

  it("never falls back to national for an unknown region", () => {
    expect(allowedLaunchMarketFromQueryValue("no-9999-nowhere")).toBeUndefined();
    expect(allowedLaunchMarketFromQueryValue("")).toBeUndefined();
  });

  it("rejects store-shaped and non-manifest contexts", () => {
    expect(isAllowedLaunchMarketContext({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "no-9999-nowhere",
    })).toBe(false);
    expect(isAllowedLaunchMarketContext({
      contractVersion: 1,
      countryCode: "NO",
      kind: "national",
      storeId: "store:1",
    })).toBe(false);
  });

  it("keeps candidate status visible", () => {
    const oslo = allowedLaunchMarketFromQueryValue("no-0301-oslo");
    expect(oslo).toBeDefined();
    expect(launchMarketIsCandidateUnverified(oslo!)).toBe(true);
  });
});
