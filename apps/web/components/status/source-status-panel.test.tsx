// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceStatusPanel } from "./source-status-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    claimBoundary: {
      priceCoverage: "not-established",
      publicRanking: "not-established",
      runtimeActivation: "not-established",
      stockStatus: "not-established",
    },
    completeness: "partial",
    contractVersion: 1,
    entries: [{
      governanceState: "not-approved",
      health: {
        freshness: "current",
        lastSuccess: {
          captureAt: null,
          discoveryAt: "2026-07-17T10:00:00.000Z",
          eligibleEvidenceAt: null,
          publishAt: null,
        },
        recordedAt: "2026-07-17T11:00:00.000Z",
        state: "disabled",
      },
      latestTerminalIngestion: {
        completedAt: "2026-07-17T10:30:00.000Z",
        scope: "source-wide",
        startedAt: "2026-07-17T10:15:00.000Z",
        state: "degraded",
      },
      scope: null,
      source: {
        displayName: "Kildekandidat",
        id: "source-candidate",
        kind: "ordinary-price",
        runtimeState: "conditional",
      },
    }],
    generatedAt: "2026-07-17T12:00:00.000Z",
    hasMore: false,
    kind: "public-source-status",
    overall: "no-approved-sources",
    ...overrides,
  };
}

describe("SourceStatusPanel", () => {
  it("renders allowlisted source health without turning it into a coverage claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload())));
    render(<SourceStatusPanel />);

    expect(screen.getByRole("status")).toHaveTextContent(/henter avgrenset/i);
    expect(await screen.findByText("Kildekandidat")).toBeVisible();
    expect(screen.getByText("Ingen godkjente kilder")).toBeVisible();
    expect(screen.getByText(/prisdekning.*offentlig rangering.*lagerstatus/i)).toBeVisible();
    expect(screen.getByText(/siste oppdagelse/i)).toBeVisible();
    expect(screen.getByText(/ikke godkjent/i)).toBeVisible();
    expect(JSON.stringify(payload())).not.toMatch(/address|basket|providerError|query|reviewQueue/i);
  });

  it("fails closed when the endpoint is unavailable or adds a private field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const unavailable = render(<SourceStatusPanel />);
    expect(await screen.findByText(/kildehelse kan ikke leses nå/i)).toBeVisible();
    unavailable.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload({
      providerError: "private upstream detail",
    }))));
    render(<SourceStatusPanel />);
    expect(await screen.findByText(/kildehelse kan ikke leses nå/i)).toBeVisible();
    expect(screen.queryByText(/private upstream detail/i)).not.toBeInTheDocument();
  });
});
