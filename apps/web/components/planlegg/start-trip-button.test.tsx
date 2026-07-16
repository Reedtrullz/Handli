// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TripSnapshotRepositoryError,
  type TripSnapshotRepository,
} from "../../lib/trip-snapshot-repository";
import { strictResultTripFixture } from "../../test-support/strict-result-trip-fixture";
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
  repository?: TripSnapshotRepository;
  now?: () => Date;
  fixture?: ReturnType<typeof strictResultTripFixture>;
} = {}) {
  const fixture = options.fixture ?? strictResultTripFixture({ offer: true });
  const tripRepository = options.repository ?? repository();
  render(
    <StartTripButton
      {...fixture}
      createId={() => "trip:component-test"}
      now={options.now ?? (() => new Date("2026-07-16T13:00:00.000Z"))}
      repository={tripRepository}
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
        evidence: { ...fixture.evidence, assignmentEvidence: [] },
      },
      repository: tripRepository,
    });

    await user.click(screen.getByRole("button", { name: "Start Handlemodus" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prisgrunnlaget kunne ikke bekreftes");
    expect(alert).not.toHaveTextContent("assignmentEvidence");
    expect(tripRepository.start).not.toHaveBeenCalled();
  });
});
