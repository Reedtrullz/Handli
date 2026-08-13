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

    expect(V1_EXPECTED_PRICE_CHAINS).toEqual([
      "bunnpris",
      "extra",
      "rema-1000",
      "fudi",
      "holdbart",
      "meny",
      "havaristen",
      "joker",
      "spar",
      "fastcandy",
      "europris",
      "engrossnett",
      "oda",
    ]);
    expect(result).toMatchObject({
      completeness: "partial",
      expectedChainIds: V1_EXPECTED_PRICE_CHAINS,
      entries: [
        { chainId: "bunnpris", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "extra", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "fudi", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "holdbart", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "meny", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "havaristen", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "joker", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "spar", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "fastcandy", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "europris", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "engrossnett", status: { kind: "unknown", reason: "not-checked" } },
        { chainId: "oda", status: { kind: "unknown", reason: "not-checked" } },
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
