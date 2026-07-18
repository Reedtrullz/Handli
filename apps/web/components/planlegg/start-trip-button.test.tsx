// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveExactProductPlanDeltaExplanationsV1 } from "@handleplan/domain";

import {
  TripSnapshotRepositoryError,
  type TripSnapshotRepository,
} from "../../lib/trip-snapshot-repository";
import {
  reviewedStrictResultTripFixture,
  strictResultTripFixture,
} from "../../test-support/strict-result-trip-fixture";
import { StartTripButton } from "./start-trip-button";

afterEach(cleanup);

function repository(
  start: TripSnapshotRepository["start"] = vi.fn(async (snapshot) => ({
    completedItemIds: [],
    snapshot,
  })),
): TripSnapshotRepository & { start: ReturnType<typeof vi.fn> } {
  return {
    clear: vi.fn(async () => undefined),
    delete: vi.fn(async () => false),
    finish: vi.fn(async () => undefined),
    getActive: vi.fn(async () => undefined),
    setCompleted: vi.fn(async () => {
      throw new Error("not used");
    }),
    start: vi.fn(start),
  };
}

function renderButton(options: {
  ensureOfflineReady?: () => Promise<void>;
  repository?: TripSnapshotRepository;
  now?: () => Date;
  fixture?: ReturnType<typeof strictResultTripFixture>;
  travelBinding?: React.ComponentProps<typeof StartTripButton>["travelBinding"];
} = {}) {
  const fixture = options.fixture ?? strictResultTripFixture({ offer: true });
  const tripRepository = options.repository ?? repository();
  render(
    <StartTripButton
      {...fixture}
      createId={() => "trip:component-test"}
      ensureOfflineReady={options.ensureOfflineReady ?? vi.fn(async () => undefined)}
      now={options.now ?? (() => new Date("2026-07-16T13:00:00.000Z"))}
      repository={tripRepository}
      travelBinding={options.travelBinding}
    />,
  );
  return tripRepository;
}

describe("StartTripButton", () => {
  it("starts an immutable selected trip and exposes the Handlemodus link", async () => {
    const user = userEvent.setup();
    const tripRepository = renderButton() as ReturnType<typeof repository>;

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    expect(tripRepository.start).toHaveBeenCalledTimes(1);
    const snapshot = tripRepository.start.mock.calls[0]![0];
    expect(snapshot).toMatchObject({
      id: "trip:component-test",
      navigation: { kind: "price-only" },
      plan: { id: "plan:strict-result-fixture" },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/origin|address|latitude|longitude|query|travel/i);
    const status = await screen.findByRole("status");
    expect(within(status).getByText(/lagret på denne enheten/i)).toBeVisible();
    expect(within(status).getByRole("link", { name: "Åpne Handlemodus" }))
      .toHaveAttribute("href", "/planlegg/handle");
  });

  it("does not overwrite an existing trip and links to it", async () => {
    const user = userEvent.setup();
    const tripRepository = repository(vi.fn(async () => {
      throw new TripSnapshotRepositoryError("ACTIVE_TRIP_EXISTS");
    }));
    renderButton({ repository: tripRepository });

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    const status = await screen.findByRole("status");
    expect(within(status).getByText(/ble ikke erstattet/i)).toBeVisible();
    expect(within(status).getByRole("link", { name: "Åpne aktiv handletur" }))
      .toHaveAttribute("href", "/planlegg/handle");
    expect(tripRepository.start).toHaveBeenCalledTimes(1);
  });

  it("does not claim success or persist a trip until the offline shell is proven", async () => {
    const user = userEvent.setup();
    const tripRepository = repository();
    const ensureOfflineReady = vi.fn(async (): Promise<void> => {
      throw new Error("private service worker detail");
    });
    renderButton({ ensureOfflineReady, repository: tripRepository });

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    expect(ensureOfflineReady).toHaveBeenCalledOnce();
    expect(tripRepository.start).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ikke klart for bruk uten nett");
    expect(alert).toHaveTextContent("Hele offline-pakken hentes og kontrolleres");
    expect(alert).not.toHaveTextContent("private service worker detail");
    expect(screen.getByRole("button", { name: "Prøv Handlemodus igjen" })).toBeVisible();

    ensureOfflineReady.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Prøv Handlemodus igjen" }));
    expect(ensureOfflineReady).toHaveBeenCalledTimes(2);
    expect(tripRepository.start).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("lagret på denne enheten");
  });

  it("stores a calculated route without storing its origin", async () => {
    const user = userEvent.setup();
    const fixture = strictResultTripFixture();
    const route = {
      aggregate: {
        calculatedAt: fixture.exactResponse.generatedAt,
        distanceMeters: 4_200,
        durationSeconds: 720,
        mode: "bike" as const,
        providerSourceId: "valhalla-openstreetmap-self-hosted",
        routeFingerprint: "route:component-test",
      },
      planId: fixture.plan.id,
      stops: [{
        branchId: "branch:extra:component-test",
        chainId: "extra" as const,
        name: "Extra Sentrum",
        sequence: 1,
      }],
    };
    const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
      evidence: fixture.exactResponse.evidence,
      generatedAt: fixture.exactResponse.generatedAt,
      marketContext: fixture.exactResponse.marketContext,
      plans: fixture.exactResponse.plans,
      travelRoutes: [route],
    });
    if (planDeltaExplanations === undefined) throw new Error("invalid route fixture");
    const planning = { ...fixture.exactResponse, planDeltaExplanations };
    const tripRepository = renderButton({
      fixture: { ...fixture, exactResponse: planning },
      travelBinding: {
        request: {
          contractVersion: 1,
          locationSelectionToken: `location-choice:${"C".repeat(43)}`,
          planning: fixture.exactRequest,
          travelMode: "bike",
        },
        response: {
          contractVersion: 1,
          planning,
          travel: { contractVersion: 1, kind: "calculated", routes: [route] },
        },
      },
    }) as ReturnType<typeof repository>;

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    const snapshot = tripRepository.start.mock.calls[0]![0];
    expect(snapshot.navigation).toMatchObject({
      aggregate: { mode: "bike" },
      kind: "route",
      stops: [{ branchId: "branch:extra:component-test", name: "Extra Sentrum" }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /origin|address|latitude|longitude|coordinate|geometry|location-choice|selectionToken/i,
    );
  });

  it("fails before storage when selected evidence is expired", async () => {
    const user = userEvent.setup();
    const tripRepository = repository();
    renderButton({
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      repository: tripRepository,
    });

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Prisgrunnlaget er utløpt");
    expect(tripRepository.start).not.toHaveBeenCalled();
  });

  it("fails closed and sanitizes invalid evidence", async () => {
    const user = userEvent.setup();
    const tripRepository = repository();
    const fixture = strictResultTripFixture();
    renderButton({
      fixture: {
        ...fixture,
        exactResponse: {
          ...fixture.exactResponse,
          evidence: { ...fixture.exactResponse.evidence, assignmentEvidence: [] },
        },
      },
      repository: tripRepository,
    });

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prisgrunnlaget kunne ikke bekreftes");
    expect(alert).not.toHaveTextContent("assignmentEvidence");
    expect(tripRepository.start).not.toHaveBeenCalled();
  });

  it("starts a mixed reviewed-family trip only after the same offline readiness proof", async () => {
    const user = userEvent.setup();
    const fixture = reviewedStrictResultTripFixture();
    const tripRepository = repository();
    const ensureOfflineReady = vi.fn(async () => undefined);
    render(
      <StartTripButton
        {...fixture}
        createId={() => "trip:reviewed-component-test"}
        ensureOfflineReady={ensureOfflineReady}
        now={() => new Date("2026-07-16T13:00:00.000Z")}
        repository={tripRepository}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    expect(ensureOfflineReady).toHaveBeenCalledOnce();
    expect(tripRepository.start).toHaveBeenCalledOnce();
    const snapshot = (tripRepository.start as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(snapshot).toMatchObject({
      id: "trip:reviewed-component-test",
      reviewedFamilyEvidence: {
        memberships: [{ canonicalProductId: "product:milk" }],
        request: { contractVersion: 2 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /query|browser|origin|address|latitude|longitude|reviewerId|reviewerName/i,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("lagret på denne enheten");
  });
});
