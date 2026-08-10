// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { OperationsWorkspace } from "./operations-workspace";

const snapshot = {
  claimBoundary: {
    alertDelivery: "disabled",
    historicalReconstruction: "not-established",
    publicAvailability: "not-established",
    publicOfferEligibility: "not-established",
  },
  completeness: "bounded-aggregate",
  contractVersion: 1,
  kind: "internal-operations-snapshot",
  observedAt: "2026-07-17T12:00:00.000Z",
  sourceRoster: {
    contentSha256: "a7cf992b898f3d9caaa51e6df55a09f0bb71158928d71dc13627ab7709b83717",
    entries: [{
      requiredEvidenceSignals: ["ordinary-price"],
      requiredWorkerJobKinds: ["catalog-refresh"],
      sourceId: "fixture-source",
    }],
    version: "fixture-roster:v1",
  },
  sources: [{
    administrativeRows: {
      activePublishedOffers: { capped: false, value: 2 },
      expiredPublishedOffers: { capped: false, value: 1 },
      expiringPublishedOffers: { capped: false, value: 1 },
      pendingReviewCandidates: { capped: true, value: 10_000 },
    },
    governanceState: "conditional",
    health: null,
    latestExtraction: null,
    latestWorkerResults: [{
      completedAt: "2026-07-17T10:00:00.000Z",
      jobKind: "catalog-refresh",
      persistedAt: "2026-07-17T10:00:01.000Z",
      status: "partial",
    }],
    newestOrdinaryPriceAt: "2026-07-17T09:00:00.000Z",
    sourceId: "fixture-source",
    workerResults24h: {
      nonSuccessful: { capped: false, value: 1 },
      total: { capped: false, value: 2 },
    },
  }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OperationsWorkspace", () => {
  it("renders only bounded aggregates and explicit nonclaims", async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OperationsWorkspace />);

    expect(screen.getByRole("status")).toHaveTextContent("Laster");
    expect(await screen.findByRole("heading", { name: "Intern drift" })).toBeInTheDocument();
    expect(screen.getByText("minst 10 000")).toBeInTheDocument();
    expect(screen.getByText("Deaktivert")).toBeInTheDocument();
    expect(screen.getByText(/beviser ikke offentlig tilgjengelighet/iu)).toBeInTheDocument();
    expect(screen.getByText("fixture-source")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(
      /private-capture-key|review reason sentinel|59\.91273|10\.74609|test@example\.com/iu,
    );
    expect(fetcher).toHaveBeenCalledWith("/api/internal/operations/snapshot", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("fails closed for malformed aggregate responses without rendering their fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...snapshot,
      privateReviewReason: "review reason sentinel",
    })));
    const { container } = render(<OperationsWorkspace />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/Ingen driftsstatus kan utledes/iu)).toBeInTheDocument();
    expect(container.textContent).not.toContain("review reason sentinel");
  });

  it("fails closed when the private API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    render(<OperationsWorkspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent("utilgjengelig");
  });
});
