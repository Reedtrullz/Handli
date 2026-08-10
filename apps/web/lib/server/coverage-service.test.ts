import { describe, expect, it } from "vitest";

import {
  CoverageService,
  CoverageUnavailableError,
  V1_EXPECTED_PRICE_CHAINS,
} from "./coverage-service";

const NOW = new Date("2026-07-16T12:00:00.000Z");

describe("CoverageService", () => {
  it("always derives the explicit Bunnpris, Extra, and REMA 1000 matrix", () => {
    const result = new CoverageService().derive({
      canonicalProductId: "product:milk",
      coverageChecks: [],
      priceEvidence: [],
      context: {
        enabledSourceIds: [],
        location: { countryCode: "NO" },
        maxAgeMs: 72 * 60 * 60 * 1_000,
        now: NOW,
      },
    });

    expect(V1_EXPECTED_PRICE_CHAINS).toEqual(["bunnpris", "extra", "rema-1000"]);
    expect(result).toMatchObject({
      completeness: "partial",
      expectedChainIds: V1_EXPECTED_PRICE_CHAINS,
      entries: [
        { chainId: "bunnpris", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "extra", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
      ],
    });
  });

  it("fails closed instead of fabricating a scope when derivation input is invalid", () => {
    expect(() => new CoverageService().derive({
      canonicalProductId: " ",
      coverageChecks: [],
      priceEvidence: [],
      context: {
        enabledSourceIds: [],
        location: { countryCode: "NO" },
        maxAgeMs: 72 * 60 * 60 * 1_000,
        now: NOW,
      },
    })).toThrow(new CoverageUnavailableError());
  });
});
