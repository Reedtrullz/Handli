import { describe, expect, it } from "vitest";

import {
  coverageCheckSchema,
  deriveComparisonScope,
  type PriceEvidenceEligibilityContext,
} from "./index";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const CONTEXT: PriceEvidenceEligibilityContext = {
  now: NOW,
  maxAgeMs: 72 * 60 * 60 * 1_000,
  location: { countryCode: "NO", regionCode: "NO-03" },
  enabledSourceIds: ["licensed-feed"],
};

function evidence(
  id: string,
  chainId: string,
  amountOre: number,
  observedAt = "2026-07-16T10:00:00.000Z",
  overrides: Record<string, unknown> = {},
) {
  return {
    contractVersion: 1,
    kind: "price-evidence",
    id,
    sourceId: "licensed-feed",
    sourceRecordId: `source:${id}`,
    chainId,
    productMatch: { kind: "exact", canonicalProductId: "product:milk" },
    amountOre,
    priceKind: "ordinary",
    evidenceLevel: "observed",
    observedAt,
    geographicScope: { kind: "national", countryCode: "NO" },
    ...overrides,
  };
}

function check(
  id: string,
  chainId: string,
  state: "known-not-carried" | "source-unavailable",
  overrides: Record<string, unknown> = {},
) {
  return {
    contractVersion: 1,
    id,
    sourceId: "licensed-feed",
    canonicalProductId: "product:milk",
    chainId,
    state,
    checkedAt: "2026-07-16T11:00:00.000Z",
    geographicScope: { kind: "national", countryCode: "NO" },
    ...overrides,
  };
}

function derive(
  priceEvidence: readonly unknown[],
  coverageChecks: readonly unknown[] = [],
  expectedChainIds = ["bunnpris", "extra", "rema-1000"],
) {
  return deriveComparisonScope({
    canonicalProductId: "product:milk",
    expectedChainIds,
    priceEvidence,
    coverageChecks,
    context: CONTEXT,
  });
}

describe("deriveComparisonScope", () => {
  it("selects deterministic eligible evidence and is byte-stable under permutations", () => {
    const rows = [
      evidence("price:older", "extra", 1_000, "2026-07-16T09:00:00.000Z"),
      evidence("price:newer-expensive", "extra", 1_200, "2026-07-16T09:30:00.000Z"),
      evidence("price:newer-cheap-z", "extra", 900),
      evidence("price:newer-cheap-a", "extra", 900),
    ];
    const checks = [
      check("check:bunnpris", "bunnpris", "known-not-carried"),
      check("check:rema", "rema-1000", "known-not-carried"),
    ];

    const forward = derive(rows, checks, ["rema-1000", "extra", "bunnpris"]);
    const reverse = derive([...rows].reverse(), [...checks].reverse());

    expect(forward).toEqual(reverse);
    expect(forward).toEqual({
      contractVersion: 1,
      completeness: "complete",
      evaluatedAt: NOW.toISOString(),
      expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      entries: [
        {
          chainId: "bunnpris",
          status: {
            kind: "known-not-carried",
            sourceId: "licensed-feed",
            checkedAt: "2026-07-16T11:00:00.000Z",
          },
        },
        { chainId: "extra", status: { kind: "priced", evidenceId: "price:newer-cheap-a" } },
        {
          chainId: "rema-1000",
          status: {
            kind: "known-not-carried",
            sourceId: "licensed-feed",
            checkedAt: "2026-07-16T11:00:00.000Z",
          },
        },
      ],
    });
  });

  it("never infers known absence and preserves explicit source-unavailable coverage", () => {
    expect(derive([], [check("check:extra", "extra", "source-unavailable")])).toEqual({
      contractVersion: 1,
      completeness: "partial",
      evaluatedAt: NOW.toISOString(),
      expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      entries: [
        { chainId: "bunnpris", status: { kind: "unknown", reason: "not-checked" } },
        {
          chainId: "extra",
          status: {
            kind: "unknown",
            reason: "source-unavailable",
            checkedAt: "2026-07-16T11:00:00.000Z",
          },
        },
        { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
      ],
    });
  });

  it("fails closed when equally current eligible evidence disagrees on price", () => {
    const result = derive([
      evidence("price:same-time-low", "extra", 900),
      evidence("price:same-time-high", "extra", 1_200),
    ]);

    expect(result?.entries.find(({ chainId }) => chainId === "extra")).toEqual({
      chainId: "extra",
      status: {
        evaluatedAt: NOW.toISOString(),
        evidenceId: "price:same-time-high",
        kind: "ineligible",
        reason: "invalid-evidence",
      },
    });
    expect(result?.completeness).toBe("partial");
  });

  it("reports stale and bounded ineligible reasons without turning them into prices", () => {
    const result = derive([
      evidence("price:stale", "bunnpris", 500, "2026-07-13T11:59:59.999Z"),
      evidence("price:wrong-scope", "extra", 500, undefined, {
        geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-46"] },
      }),
      evidence("price:disabled", "rema-1000", 500, undefined, { sourceId: "blocked-feed" }),
    ]);

    expect(result?.entries).toEqual([
      {
        chainId: "bunnpris",
        status: {
          kind: "stale",
          evidenceId: "price:stale",
          observedAt: "2026-07-13T11:59:59.999Z",
          staleAt: "2026-07-16T11:59:59.999Z",
        },
      },
      {
        chainId: "extra",
        status: {
          kind: "ineligible",
          evidenceId: "price:wrong-scope",
          reason: "wrong-scope",
          evaluatedAt: NOW.toISOString(),
        },
      },
      {
        chainId: "rema-1000",
        status: {
          kind: "ineligible",
          evidenceId: "price:disabled",
          reason: "source-disabled",
          evaluatedAt: NOW.toISOString(),
        },
      },
    ]);
    expect(result?.completeness).toBe("partial");
  });

  it("rejects stale, disabled, wrong-product, and wrong-scope not-carried checks", () => {
    const invalidChecks = [
      check("check:stale", "bunnpris", "known-not-carried", {
        checkedAt: "2026-07-13T11:59:59.999Z",
      }),
      check("check:disabled", "extra", "known-not-carried", { sourceId: "blocked-feed" }),
      check("check:product", "rema-1000", "known-not-carried", {
        canonicalProductId: "product:bread",
      }),
      check("check:scope", "extra", "known-not-carried", {
        geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-46"] },
      }),
    ];

    expect(derive([], invalidChecks)?.entries.every(({ status }) => status.kind === "unknown")).toBe(true);
  });

  it("fails closed for conflicting evidence IDs and invalid request bounds", () => {
    const first = evidence("price:duplicate", "extra", 900);
    expect(derive([first, { ...first, amountOre: 901 }])).toBeNull();
    expect(derive([], [], [])).toBeNull();
    expect(derive([], [], ["extra", "extra"])).toBeNull();
    expect(derive([], [], ["a", "b", "c", "d"])).toBeNull();
    expect(deriveComparisonScope({
      canonicalProductId: "product:milk",
      expectedChainIds: ["extra"],
      priceEvidence: [],
      coverageChecks: [],
      context: { ...CONTEXT, now: new Date("invalid") },
    })).toBeNull();
  });
});

describe("coverageCheckSchema", () => {
  it("requires a source, exact subject, scope, state, and canonical checked time", () => {
    expect(coverageCheckSchema.safeParse(check("check:extra", "extra", "known-not-carried")).success).toBe(true);
    expect(coverageCheckSchema.safeParse({
      ...check("check:extra", "extra", "known-not-carried"),
      origin: { latitude: 59.9, longitude: 10.7 },
    }).success).toBe(false);
  });
});
