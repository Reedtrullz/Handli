import { describe, expect, it } from "vitest";

import {
  derivePublicSourceStatusOverall,
  publicSourceStatusResponseSchema,
  type PublicSourceStatusEntry,
} from "./source-status-contracts";

const HEALTH_AT = "2026-07-17T11:00:00.000Z";
const GENERATED_AT = "2026-07-17T12:00:00.000Z";

function entry(overrides: Partial<PublicSourceStatusEntry> = {}): PublicSourceStatusEntry {
  return {
    governanceState: "approved",
    health: {
      freshness: "current",
      lastSuccess: {
        captureAt: null,
        discoveryAt: "2026-07-17T10:00:00.000Z",
        eligibleEvidenceAt: "2026-07-17T10:30:00.000Z",
        publishAt: null,
      },
      recordedAt: HEALTH_AT,
      state: "healthy",
    },
    latestTerminalIngestion: {
      completedAt: "2026-07-17T10:45:00.000Z",
      scope: "source-wide",
      startedAt: "2026-07-17T10:30:00.000Z",
      state: "completed",
    },
    scope: null,
    source: {
      displayName: "Approved fixture",
      id: "fixture-approved",
      kind: "ordinary-price",
      runtimeState: "approved",
    },
    ...overrides,
  };
}

function response(entries: PublicSourceStatusEntry[], hasMore = false) {
  return {
    claimBoundary: {
      priceCoverage: "not-established",
      publicRanking: "not-established",
      runtimeActivation: "not-established",
      stockStatus: "not-established",
    },
    completeness: "partial",
    contractVersion: 1,
    entries,
    generatedAt: GENERATED_AT,
    hasMore,
    kind: "public-source-status",
    overall: derivePublicSourceStatusOverall(entries, hasMore, GENERATED_AT),
  };
}

describe("public source-status contracts", () => {
  it("accepts a bounded allowlisted operational-health response", () => {
    const parsed = publicSourceStatusResponseSchema.parse(response([entry()]));
    expect(parsed.overall).toBe("operational");
    expect(JSON.stringify(parsed)).not.toMatch(
      /address|basket|coordinate|error|jobId|provider|query|reviewQueue|userAgent/i,
    );
  });

  it("does not treat conditional or unapproved sources as publicly operational", () => {
    const unapproved = entry({
      governanceState: "not-approved",
      source: {
        displayName: "Conditional fixture",
        id: "fixture-conditional",
        kind: "offer",
        runtimeState: "conditional",
      },
    });
    expect(publicSourceStatusResponseSchema.parse(response([unapproved])).overall)
      .toBe("no-approved-sources");
    expect(publicSourceStatusResponseSchema.safeParse({
      ...response([unapproved]),
      overall: "operational",
    }).success).toBe(false);
  });

  it("derives degradation only from current recorded failure signals", () => {
    const olderFailure = entry({
      latestTerminalIngestion: {
        completedAt: "2026-07-17T10:45:00.000Z",
        scope: "source-wide",
        startedAt: "2026-07-17T10:30:00.000Z",
        state: "failed",
      },
    });
    const newerFailure = entry({
      latestTerminalIngestion: {
        completedAt: "2026-07-17T11:30:00.000Z",
        scope: "source-wide",
        startedAt: "2026-07-17T11:15:00.000Z",
        state: "failed",
      },
    });
    const newerDegraded = entry({
      latestTerminalIngestion: {
        completedAt: "2026-07-17T11:30:00.000Z",
        scope: "source-wide",
        startedAt: "2026-07-17T11:15:00.000Z",
        state: "degraded",
      },
    });
    const newerCancelled = entry({
      latestTerminalIngestion: {
        completedAt: "2026-07-17T11:30:00.000Z",
        scope: "source-wide",
        startedAt: "2026-07-17T11:15:00.000Z",
        state: "cancelled",
      },
    });
    expect(derivePublicSourceStatusOverall([olderFailure], false, GENERATED_AT))
      .toBe("operational");
    expect(derivePublicSourceStatusOverall([newerFailure], false, GENERATED_AT))
      .toBe("degraded");
    expect(derivePublicSourceStatusOverall([newerDegraded], false, GENERATED_AT))
      .toBe("degraded");
    expect(derivePublicSourceStatusOverall([newerCancelled], false, GENERATED_AT))
      .toBe("unknown");
    expect(derivePublicSourceStatusOverall([entry({ health: null })], false, GENERATED_AT))
      .toBe("unknown");
    expect(derivePublicSourceStatusOverall([entry({
      health: { ...entry().health!, freshness: "stale" },
    })], false, GENERATED_AT)).toBe("unknown");
    expect(derivePublicSourceStatusOverall([entry({
      health: {
        ...entry().health!,
        lastSuccess: {
          captureAt: null,
          discoveryAt: "2026-07-15T08:59:59.999Z",
          eligibleEvidenceAt: null,
          publishAt: null,
        },
      },
    })], false, GENERATED_AT)).toBe("unknown");
    expect(derivePublicSourceStatusOverall([entry({
      health: {
        ...entry().health!,
        freshness: "current",
        lastSuccess: {
          captureAt: null,
          discoveryAt: "2026-07-15T10:00:00.000Z",
          eligibleEvidenceAt: null,
          publishAt: null,
        },
        recordedAt: "2026-07-16T11:00:00.000Z",
      },
    })], false, GENERATED_AT)).toBe("unknown");
    expect(derivePublicSourceStatusOverall([entry({
      health: {
        freshness: "current",
        lastSuccess: {
          captureAt: null,
          discoveryAt: null,
          eligibleEvidenceAt: null,
          publishAt: null,
        },
        recordedAt: HEALTH_AT,
        state: "healthy",
      },
    })], false, GENERATED_AT)).toBe("unknown");
    expect(derivePublicSourceStatusOverall([], true, GENERATED_AT)).toBe("unknown");
  });

  it("rejects private additions, future clocks, duplicate scopes, and noncanonical order", () => {
    const scope = {
      countryCode: "NO",
      id: `scope:${"a".repeat(64)}`,
      kind: "region" as const,
      label: "Oslo",
      state: "active" as const,
    };
    const first = entry({ scope });
    expect(publicSourceStatusResponseSchema.safeParse({
      ...response([first]),
      entries: [{ ...first, providerError: "private" }],
    }).success).toBe(false);
    expect(publicSourceStatusResponseSchema.safeParse({
      ...response([first]),
      entries: [{
        ...first,
        health: { ...first.health!, recordedAt: "2026-07-17T12:00:00.001Z" },
      }],
    }).success).toBe(false);
    expect(publicSourceStatusResponseSchema.safeParse({
      ...response([first, first]),
      entries: [first, first],
    }).success).toBe(false);

    const later = entry({
      source: { ...first.source, displayName: "Zulu", id: "zulu" },
    });
    expect(publicSourceStatusResponseSchema.safeParse(response([later, first])).success)
      .toBe(false);
  });

  it("requires success clocks to be at or before the recorded snapshot", () => {
    const invalid = entry({
      health: {
        ...entry().health!,
        lastSuccess: {
          ...entry().health!.lastSuccess,
          publishAt: "2026-07-17T11:00:00.001Z",
        },
      },
    });
    expect(publicSourceStatusResponseSchema.safeParse(response([invalid])).success).toBe(false);
  });
});
