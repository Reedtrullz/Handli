// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ActiveTripV1,
  TripSnapshotRepository,
} from "../../../lib/trip-snapshot-repository";
import { tripSnapshotFixture } from "../../../test-support/trip-snapshot-fixture";
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
    expect(within(store).getByText("1 pakke")).toBeVisible();
    expect(screen.getByRole("heading", { name: "0 av 1 varer" })).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");

    await user.click(within(store).getByRole("checkbox", { name: /TINE Lettmelk/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "1 av 1 varer" })).toBeVisible());
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
    expect(repository.setCompleted).toHaveBeenCalledWith(
      tripSnapshotFixture().id,
      tripSnapshotFixture().checklistItems[0]!.id,
      true,
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
