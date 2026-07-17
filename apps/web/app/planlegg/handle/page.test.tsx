// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ActiveTripV1,
  TripSnapshotRepository,
} from "../../../lib/trip-snapshot-repository";
import {
  reviewedStrictResultTripFixture,
  strictResultTripFixture,
} from "../../../test-support/strict-result-trip-fixture";
import {
  legacyTripSnapshotFixture,
  tripSnapshotFixture,
} from "../../../test-support/trip-snapshot-fixture";
import { createStrictResultTripSnapshot } from "../../../lib/strict-result-trip";
import { HandleMode } from "./page";

afterEach(cleanup);

function repositoryFor(initial: ActiveTripV1 | undefined): TripSnapshotRepository & {
  getActive: ReturnType<typeof vi.fn>;
  setCompleted: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  let active = initial;
  const repository = {
    clear: vi.fn(async () => {
      active = undefined;
    }),
    delete: vi.fn(async () => {
      active = undefined;
      return true;
    }),
    finish: vi.fn(async () => {
      active = undefined;
    }),
    getActive: vi.fn(async () => active),
    setCompleted: vi.fn(async (_snapshotId: string, itemId: string, completed: boolean) => {
      if (active === undefined) throw new Error("missing fixture");
      const next = new Set(active.completedItemIds);
      if (completed) next.add(itemId);
      else next.delete(itemId);
      active = { ...active, completedItemIds: [...next] };
      return active;
    }),
    start: vi.fn(async () => {
      if (active === undefined) throw new Error("test start is not configured");
      return active;
    }),
  };
  return repository;
}

function activeTrip(completedItemIds: string[] = []): ActiveTripV1 {
  return { completedItemIds, snapshot: tripSnapshotFixture() };
}

describe("Handlemodus", () => {
  it("groups the immutable checklist by store and persists accessible progress", async () => {
    const user = userEvent.setup();
    const repository = repositoryFor(activeTrip());
    render(<HandleMode repository={repository} now={() => new Date("2026-07-16T12:30:00.000Z")} />);

    const store = await screen.findByRole("region", { name: "Extra" });
    expect(within(store).getByText("TINE Lettmelk 1 l")).toBeVisible();
    expect(within(store).getByText(/Behov 1 pakke · kjøp 1 pakke/)).toBeVisible();
    expect(within(store).getByText(/Forventet 24,90 kr · ordinært 24,90 kr/)).toBeVisible();
    expect(within(store).getByText(/kvalifisert ved planlegging/)).toBeVisible();
    expect(screen.getByRole("heading", { name: /^0 av 1 vare$/u })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: /^0 av 1 vare fullført$/u }))
      .toHaveAttribute("value", "0");

    await user.click(within(store).getByRole("checkbox", { name: /TINE Lettmelk/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^1 av 1 vare$/u })).toBeVisible());
    expect(screen.getByRole("progressbar", { name: /^1 av 1 vare fullført$/u }))
      .toHaveAttribute("value", "1");
    expect(repository.setCompleted).toHaveBeenCalledWith(
      tripSnapshotFixture().id,
      tripSnapshotFixture().checklistItems[0]!.id,
      true,
    );
  });

  it("keeps applied public offer terms and applicability available offline", async () => {
    const snapshot = tripSnapshotFixture({ offer: true });
    const repository = repositoryFor({ completedItemIds: [], snapshot });
    render(<HandleMode repository={repository} />);

    const store = await screen.findByRole("region", { name: "Extra" });
    expect(within(store).getByText(
      /Forventet 19,90 kr · ordinært 24,90 kr · 5,00 kr spart/,
    )).toBeVisible();
    expect(within(store).getByText(
      /Tilbud: 19,90 kr per pakke · offentlig tilbud/,
    )).toBeVisible();
    expect(within(store).getByText(/· i butikk · nasjonalt \(NO\)/)).toBeVisible();
    expect(within(store).getByText(
      /Tilbud observert .* fra fixture-price-source · oppgitt førpris 24,90 kr/,
    )).toBeVisible();
  });

  it("keeps member conditions offline by chain without rendering the opaque program ID", async () => {
    const programId = "opaque-extra-membership-key";
    const fixture = strictResultTripFixture({
      enabledMembershipProgramIds: [programId],
      membershipProgramId: programId,
      offer: true,
    });
    const snapshot = createStrictResultTripSnapshot({
      ...fixture,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:member-handle-mode-test",
    });

    render(<HandleMode repository={repositoryFor({ completedItemIds: [], snapshot })} />);

    const store = await screen.findByRole("region", { name: "Extra" });
    expect(within(store).getByText(
      /Tilbud: 19,90 kr per pakke · Medlemspris hos Extra – medlemskap kreves/,
    )).toBeVisible();
    expect(document.body).not.toHaveTextContent(programId);
  });

  it("shows the redacted reviewed-family provenance for a mixed offline trip", async () => {
    const fixture = reviewedStrictResultTripFixture();
    const snapshot = createStrictResultTripSnapshot({
      ...fixture,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:reviewed-handle-mode-test",
    });
    const { container } = render(
      <HandleMode repository={repositoryFor({ completedItemIds: [], snapshot })} />,
    );

    const store = await screen.findByRole("region", { name: "Extra" });
    expect(within(store).getByText(
      /Godkjent varebytte: Melk · menneskelig kontroll uten lagret identitet/,
    )).toBeVisible();
    expect(within(store).getByText(/taksonomi handleplan-reviewed-families@1.0.0/))
      .toBeVisible();
    expect(within(store).getByText("Evergood Kaffe 500 g")).toBeVisible();
    expect(within(store).getByText("TINE Lettmelk 1 l")).toBeVisible();
    expect(container.textContent).not.toMatch(
      /private capture|query|address|origin|latitude|longitude|reviewer id/i,
    );
  });

  it("warns when price evidence expired and never renders origin or coordinates", async () => {
    const repository = repositoryFor(activeTrip());
    const { container } = render(
      <HandleMode repository={repository} now={() => new Date("2026-07-17T12:00:00.000Z")} />,
    );

    expect(await screen.findByText(/prisgrunnlaget kan være utdatert/i)).toBeVisible();
    expect(container.textContent).not.toMatch(/latitude|longitude|startadresse/i);
  });

  it("keeps the verified public branch order and attributed route estimate offline", async () => {
    const snapshot = tripSnapshotFixture({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 720,
          mode: "car",
          sourceId: "valhalla-openstreetmap-self-hosted",
          sourceRecordId: "route:handlemodus-test",
        },
        kind: "route",
        stops: [{
          branchId: "branch:extra:handlemodus-test",
          chainId: "extra",
          kind: "branch-stop",
          name: "Extra Sentrum",
          sequence: 1,
        }],
      },
    });
    const repository = repositoryFor({ completedItemIds: [], snapshot });
    const { container } = render(<HandleMode repository={repository} />);

    expect(await screen.findByRole("region", { name: "Extra Sentrum" })).toBeVisible();
    expect(screen.getByText(/Estimert reise med bil: 12 min/)).toBeVisible();
    expect(screen.getByRole("link", { name: "© OpenStreetMap-bidragsytere" }))
      .toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(container.textContent).not.toMatch(/latitude|longitude|coordinate|startadresse/i);
  });

  it("keeps legacy routed trips readable without inventing a transport mode", async () => {
    const snapshot = legacyTripSnapshotFixture({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 720,
          sourceId: "legacy-router",
          sourceRecordId: "route:legacy-handlemodus-test",
        },
        kind: "route",
        stops: [{
          branchId: "branch:extra:legacy-handlemodus-test",
          chainId: "extra",
          kind: "branch-stop",
          name: "Extra Sentrum",
          sequence: 1,
        }],
      },
    });

    render(<HandleMode repository={repositoryFor({ completedItemIds: [], snapshot })} />);

    expect(await screen.findByText(/Estimert reise: 12 min/)).toBeVisible();
    expect(screen.queryByText(/Estimert reise med bil|Estimert reise med sykkel/))
      .not.toBeInTheDocument();
  });

  it("finishes and deletes only after every checklist item is complete", async () => {
    const user = userEvent.setup();
    const snapshot = tripSnapshotFixture();
    const repository = repositoryFor(activeTrip());
    render(<HandleMode repository={repository} />);

    const finish = await screen.findByRole("button", { name: "Fullfør og slett turen" });
    expect(finish).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /TINE Lettmelk/ }));
    await waitFor(() => expect(finish).toBeEnabled());
    await user.click(finish);

    expect(repository.finish).toHaveBeenCalledWith(snapshot.id);
    expect(await screen.findByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
  });

  it("offers an explicit delete action and an accessible empty state", async () => {
    const user = userEvent.setup();
    const snapshot = tripSnapshotFixture();
    const repository = repositoryFor(activeTrip());
    render(<HandleMode repository={repository} />);

    await user.click(await screen.findByRole("button", { name: "Slett tur" }));
    expect(repository.delete).toHaveBeenCalledWith(snapshot.id);
    expect(await screen.findByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Gå til Planlegg" })).toHaveAttribute("href", "/planlegg");
  });

  it("fails closed on storage errors and supports an accessible retry", async () => {
    const user = userEvent.setup();
    const repository = repositoryFor(undefined);
    repository.getActive.mockRejectedValueOnce(new Error("private IndexedDB detail"));
    render(<HandleMode repository={repository} />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Handlemodus kunne ikke åpnes")).toBeVisible();
    expect(alert).not.toHaveTextContent("private IndexedDB detail");
    await user.click(within(alert).getByRole("button", { name: "Prøv igjen" }));
    expect(await screen.findByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
  });
});
