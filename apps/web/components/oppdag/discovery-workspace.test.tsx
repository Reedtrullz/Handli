// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MoneyOre } from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_STORAGE_KEY } from "../../lib/browser-basket";
import { DiscoveryWorkspace, type DiscoverySearch } from "./discovery-workspace";

const response = {
  generatedAt: "2026-07-15T10:00:00.000Z",
  priceDataSource: "upstream" as const,
  opportunities: [
    {
      product: {
        ean: "7038010000013",
        name: "TINE Lettmelk 1 % 1 l",
        brand: "TINE",
        packageQuantity: 1000,
        packageUnit: "ml" as const,
        productFamily: "lettmelk",
      },
      prices: [
        { ean: "7038010000013", chain: "rema-1000" as const, amountOre: 2_390 as MoneyOre, observedAt: "2026-07-15T09:00:00.000Z", source: "kassalapp" as const },
        { ean: "7038010000013", chain: "extra" as const, amountOre: 2_590 as MoneyOre, observedAt: "2026-07-15T09:00:00.000Z", source: "kassalapp" as const },
      ],
    },
    {
      product: { ean: "7038010000020", name: "Lettmelk Bunnpris", brand: "Butikk" },
      prices: [
        { ean: "7038010000020", chain: "bunnpris" as const, amountOre: 2_490 as MoneyOre, observedAt: "2026-07-15T09:00:00.000Z", source: "kassalapp" as const },
      ],
    },
  ],
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(cleanup);

describe("Oppdag discovery workspace", () => {
  it("browses fresh prices without a query and filters findings by store", async () => {
    const user = userEvent.setup();
    const search = vi.fn<DiscoverySearch>().mockResolvedValue(response);
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    expect(await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    expect(search).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(screen.getByRole("heading", { name: "Beste prisfunn akkurat nå" })).toBeVisible();
    expect(screen.getByText("lavest hos REMA 1000")).toBeVisible();
    expect(screen.getByText(/lavere enn høyeste kjedepris/)).toBeVisible();
    expect(screen.getByText(/Kassalapp direkte/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Bunnpris" }));
    expect(screen.getByRole("button", { name: "Bunnpris" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Aktuelle priser hos Bunnpris" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lettmelk Bunnpris" })).toBeVisible();
    expect(screen.getByText("observert hos Bunnpris")).toBeVisible();

  });

  it("explains when a store has no fresh catalog prices", async () => {
    const user = userEvent.setup();
    render(<DiscoveryWorkspace
      searchDiscovery={vi.fn<DiscoverySearch>().mockResolvedValue({ ...response, opportunities: [] })}
      storage={memoryStorage()}
    />);

    await user.click(await screen.findByRole("button", { name: "Extra" }));
    expect(screen.getByText("Kassalapp har ingen ferske katalogpriser fra Extra akkurat nå.")).toBeVisible();
  });

  it("keeps search as an optional filter and can return to browsing", async () => {
    const user = userEvent.setup();
    const search = vi.fn<DiscoverySearch>().mockResolvedValue(response);
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);
    await screen.findByRole("heading", { name: "Beste prisfunn akkurat nå" });

    await user.type(screen.getByLabelText("Filtrer varene (valgfritt)"), "kaffe");
    await user.click(screen.getByRole("button", { name: "Søk" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("kaffe", expect.any(AbortSignal)));
    expect(screen.getByRole("heading", { name: "Prisfunn for «kaffe»" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Vis alle prisfunn" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal)));
    expect(screen.getByRole("heading", { name: "Beste prisfunn akkurat nå" })).toBeVisible();
  });

  it("adds an exact product to the basket shared with Planlegg", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    render(
      <DiscoveryWorkspace
        createId={vi.fn().mockReturnValueOnce("need-1").mockReturnValueOnce("rule-1")}
        searchDiscovery={vi.fn<DiscoverySearch>().mockResolvedValue(response)}
        storage={storage}
      />,
    );

    const card = (await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).closest("article");
    expect(card).not.toBeNull();
    await user.click(within(card!).getByRole("button", { name: "Legg til i handlelisten" }));

    expect(within(card!).getByRole("button", { name: "I handlelisten" })).toBeDisabled();
    expect(screen.getByText("1 vare")).toBeVisible();
    expect(JSON.parse(storage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      needs: [{ id: "need-1", query: "TINE Lettmelk 1 % 1 l", matchRuleId: "rule-1" }],
      matchingRules: [{ id: "rule-1", mode: "exact", exactEan: "7038010000013" }],
    });
  });

  it("can retry the same query after a temporary failure", async () => {
    const user = userEvent.setup();
    const search = vi.fn<DiscoverySearch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response);
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Prøv igjen" }));
    expect(await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });
});
