// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_QUANTITY_MAX, BASKET_STORAGE_KEY } from "../../lib/browser-basket";
import { BasketWorkspace } from "./basket-workspace";

const milk: Product = {
  ean: "7038010000013",
  name: "TINE Lettmelk 1 % 1 l",
  brand: "TINE",
  packageQuantity: 1000,
  packageUnit: "ml",
  productFamily: "lettmelk",
};
const cheese: Product = {
  ean: "7038010000020",
  name: "Norvegia Original 1 kg",
  brand: "TINE",
  packageQuantity: 1000,
  packageUnit: "g",
  productFamily: "gulost",
};

function idFactory() {
  let id = 0;
  return () => `id-${++id}`;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("Planlegg basket workspace", () => {
  it("supports combobox arrows, enter, escape, and locks an exact selection", async () => {
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => [milk, cheese]}
        searchDelayMs={0}
      />,
    );
    const input = screen.getByLabelText("Hva skal du handle?");

    await user.type(input, "lettmelk");
    expect(await screen.findByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");

    const row = screen.getByRole("listitem", { name: /TINE Lettmelk/ });
    expect(within(row).getByText("Eksakt produkt")).toBeVisible();
    expect(within(row).getByText(/Låst til TINE Lettmelk/)).toBeVisible();
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      matchingRules: [{ mode: "exact", exactEan: milk.ean, userApproved: true }],
    });

    await user.type(input, "ost");
    expect(await screen.findByRole("listbox")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("requires explicit approval before including a flexible generic need", async () => {
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => [{ ...milk, name: "Havregryn", productFamily: "havregryn" }]}
        searchDelayMs={0}
      />,
    );

    await user.type(screen.getByLabelText("Hva skal du handle?"), "havregryn");
    await screen.findByRole("option", { name: /Havregryn/ });
    await user.click(screen.getByRole("button", { name: "Legg til" }));
    expect(screen.queryByRole("listitem", { name: /havregryn/i })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Godkjenn treff for havregryn" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Samme type, valgfritt merke" }));

    const row = screen.getByRole("listitem", { name: /havregryn/i });
    expect(within(row).getByText("Samme type, valgfritt merke")).toBeVisible();
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      matchingRules: [
        { mode: "flexible", productFamily: "havregryn", userApproved: true },
      ],
      products: [expect.objectContaining({ productFamily: "havregryn" })],
    });
  });

  it("offers a constrained generic match that requires a brand before approval", async () => {
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => [{ ...milk, name: "Tacoskjell", brand: "Old El Paso", productFamily: "tacoskjell" }]}
        searchDelayMs={0}
      />,
    );

    await user.type(screen.getByLabelText("Hva skal du handle?"), "tacoskjell");
    await screen.findByRole("option", { name: /Tacoskjell/ });
    await user.click(screen.getByRole("button", { name: "Legg til" }));
    await user.click(screen.getByRole("button", { name: "Begrens merker" }));
    const approve = screen.getByRole("button", { name: "Godkjenn begrensning" });
    expect(approve).toBeDisabled();
    await user.type(screen.getByLabelText("Tillatte merker"), "Old El Paso, Santa Maria");
    await user.click(approve);

    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      matchingRules: [
        {
          mode: "constrained",
          productFamily: "tacoskjell",
          allowedBrands: ["Old El Paso", "Santa Maria"],
          userApproved: true,
        },
      ],
      products: [expect.objectContaining({ brand: "Old El Paso", productFamily: "tacoskjell" })],
    });
  });

  it("keeps generic approval disabled for ambiguous or family-less candidates", async () => {
    const user = userEvent.setup();
    render(<BasketWorkspace
      createId={idFactory()}
      searchProducts={async () => [milk, cheese]}
      searchDelayMs={0}
    />);

    await user.type(screen.getByLabelText("Hva skal du handle?"), "mat");
    await screen.findByRole("option", { name: /TINE Lettmelk/ });
    expect(screen.getByRole("button", { name: "Legg til" })).toBeDisabled();
    expect(screen.getByText(/flere eller ukjente varetyper/)).toBeVisible();
    expect(screen.queryByRole("group", { name: /Godkjenn treff/ })).not.toBeInTheDocument();
  });

  it("ignores stale results even when an older request does not honor abort", async () => {
    vi.useFakeTimers();
    let resolveOld!: (products: Product[]) => void;
    let resolveNew!: (products: Product[]) => void;
    const searchProducts = vi.fn((query: string) =>
      new Promise<Product[]>((resolve) => {
        if (query === "melk") resolveOld = resolve;
        else resolveNew = resolve;
      }),
    );
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={searchProducts}
        searchDelayMs={250}
      />,
    );
    const input = screen.getByLabelText("Hva skal du handle?");

    fireEvent.change(input, { target: { value: "melk" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.change(input, { target: { value: "ost" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await act(async () => resolveNew([cheese]));
    expect(screen.getByRole("option", { name: /Norvegia/ })).toBeVisible();
    await act(async () => resolveOld([milk]));

    expect(screen.queryByRole("option", { name: /TINE Lettmelk/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Norvegia/ })).toBeVisible();
  });

  it("aborts replaced searches and keeps aborts out of the error state", async () => {
    const signals: AbortSignal[] = [];
    const searchProducts = vi.fn((_query: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Product[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={searchProducts}
        searchDelayMs={0}
      />,
    );
    const input = screen.getByLabelText("Hva skal du handle?");

    await user.type(input, "melk");
    await waitFor(() => expect(searchProducts).toHaveBeenCalled());
    await user.clear(input);
    await user.type(input, "ost");
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));

    expect(screen.queryByText("Kunne ikke hente produkter. Prøv igjen.")).not.toBeInTheDocument();
  });

  it("cancels delayed search on Escape, stays closed, and reopens only after new typing", async () => {
    vi.useFakeTimers();
    const searchProducts = vi.fn(async () => [milk]);
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={searchProducts}
        searchDelayMs={250}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Hva skal du handle?" });

    fireEvent.change(input, { target: { value: "melk" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(searchProducts).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input, { target: { value: "melkx" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await act(async () => {});
    expect(screen.getByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
  });

  it("aborts an active search on Escape and ignores its late response", async () => {
    let resolve!: (products: Product[]) => void;
    let seenSignal!: AbortSignal;
    const searchProducts = vi.fn((_query: string, signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<Product[]>((resolvePromise) => (resolve = resolvePromise));
    });
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={searchProducts}
        searchDelayMs={0}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Hva skal du handle?" });

    await user.type(input, "melk");
    await waitFor(() => expect(searchProducts).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    expect(seenSignal.aborted).toBe(true);
    await act(async () => resolve([milk]));
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: /TINE Lettmelk/ })).not.toBeInTheDocument();
  });

  it("dismisses on Tab blur while option pointer selection still succeeds", async () => {
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => [milk]}
        searchDelayMs={0}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Hva skal du handle?" });

    await user.type(input, "melk");
    expect(await screen.findByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
    await user.tab();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(input);
    await user.type(input, "x");
    const option = await screen.findByRole("option", { name: /TINE Lettmelk/ });
    await user.click(option);
    expect(screen.getByRole("listitem", { name: /TINE Lettmelk/ })).toBeVisible();
  });

  it("cleans up both delayed and active searches on unmount", async () => {
    vi.useFakeTimers();
    const delayedSearch = vi.fn(async () => [milk]);
    const delayed = render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={delayedSearch}
        searchDelayMs={250}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "melk" } });
    delayed.unmount();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(delayedSearch).not.toHaveBeenCalled();

    vi.useRealTimers();
    let signal!: AbortSignal;
    const activeSearch = vi.fn((_query: string, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<Product[]>(() => {});
    });
    const active = render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={activeSearch}
        searchDelayMs={0}
      />,
    );
    await userEvent.setup().type(screen.getByRole("combobox"), "melk");
    await waitFor(() => expect(activeSearch).toHaveBeenCalled());
    active.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("keeps aria-controls on the same listbox through loading, error, empty, and ready", async () => {
    let rejectLoading!: (error: Error) => void;
    const searchProducts = vi.fn((query: string) => {
      if (query === "melk") {
        return new Promise<Product[]>((_resolve, reject) => (rejectLoading = reject));
      }
      if (query === "tomt") return Promise.resolve([]);
      return Promise.resolve([milk]);
    });
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={searchProducts}
        searchDelayMs={0}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Hva skal du handle?" });
    const controls = input.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const controlledListbox = document.getElementById(controls ?? "");
    expect(controlledListbox).toHaveRole("listbox");
    expect(controlledListbox).not.toBeVisible();
    expect(input).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input, { target: { value: "melk" } });
    expect(await screen.findByText("Henter produkter …")).toBeVisible();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(controls ?? "")).toBe(controlledListbox);
    expect(controlledListbox).toHaveRole("listbox");
    expect(controlledListbox).toBeVisible();

    await act(async () => rejectLoading(new Error("offline")));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(controls ?? "")).toBe(controlledListbox);
    expect(controlledListbox).toHaveRole("listbox");

    fireEvent.change(input, { target: { value: "tomt" } });
    expect(await screen.findByText("Ingen produkter funnet. Legg til som et generelt behov.")).toBeVisible();
    expect(document.getElementById(controls ?? "")).toBe(controlledListbox);
    expect(controlledListbox).toHaveRole("listbox");

    fireEvent.change(input, { target: { value: "ost" } });
    expect(await screen.findByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
    expect(document.getElementById(controls ?? "")).toBe(controlledListbox);
    expect(controlledListbox).toHaveRole("listbox");
  });

  it("caps composer quantity at the exported maximum", async () => {
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => []}
        searchDelayMs={0}
      />,
    );
    const increment = screen.getByRole("button", { name: "Øk antall" });

    for (let quantity = 1; quantity < BASKET_QUANTITY_MAX; quantity += 1) {
      fireEvent.click(increment);
    }

    expect(screen.getByText(String(BASKET_QUANTITY_MAX), { selector: "output" })).toBeVisible();
    expect(increment).toBeDisabled();
    await user.click(increment);
    expect(screen.getByText(String(BASKET_QUANTITY_MAX), { selector: "output" })).toBeVisible();
  });

  it("disables creation visibly when the basket already has 50 needs", () => {
    const needs = Array.from({ length: 50 }, (_, index) => ({
      id: `need-${index}`, query: milk.name, quantity: 1, quantityUnit: "each", matchRuleId: `rule-${index}`, required: true,
    }));
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify({
      version: 1,
      needs,
      matchingRules: needs.map((_, index) => ({ id: `rule-${index}`, mode: "exact", exactEan: milk.ean, userApproved: true, explanation: "Eksakt produkt" })),
      products: [milk],
      travel: { enabled: false, mode: "car" },
    }));

    render(<BasketWorkspace createId={idFactory()} searchProducts={async () => [milk]} searchDelayMs={0} />);

    expect(screen.getByRole("combobox", { name: "Hva skal du handle?" })).toBeDisabled();
    expect(screen.getByText(/maksimalt 50 varebehov/)).toBeVisible();
  });

  it("edits integer quantity, deletes, and restores the basket after reload", async () => {
    const user = userEvent.setup();
    const props = {
      createId: idFactory(),
      searchProducts: async () => [milk],
      searchDelayMs: 0,
    };
    const first = render(<BasketWorkspace {...props} />);

    await user.type(screen.getByLabelText("Hva skal du handle?"), "melk");
    await user.click(await screen.findByRole("option", { name: /TINE Lettmelk/ }));
    const quantity = screen.getByRole("spinbutton", { name: /Antall TINE Lettmelk/ });
    await user.clear(quantity);
    await user.type(quantity, "3");
    await user.tab();
    expect(quantity).toHaveValue(3);
    first.unmount();

    render(<BasketWorkspace {...props} />);
    const restored = screen.getByRole("listitem", { name: /TINE Lettmelk/ });
    expect(within(restored).getByRole("spinbutton")).toHaveValue(3);
    await user.click(within(restored).getByRole("button", { name: /Fjern TINE Lettmelk/ }));
    expect(screen.queryByRole("listitem", { name: /TINE Lettmelk/ })).not.toBeInTheDocument();
  });

  it("has usable loading, empty, and error states without an account prompt", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={() => new Promise((_resolve, rejectPromise) => (reject = rejectPromise))}
        searchDelayMs={0}
      />,
    );

    expect(screen.getByText("Kurven er tom.")).toBeVisible();
    expect(screen.queryByText(/logg inn|opprett konto/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Hva skal du handle?"), "melk");
    expect(await screen.findByText("Henter produkter …")).toBeVisible();
    await act(async () => reject(new Error("offline")));
    expect(await screen.findByText("Kunne ikke hente produkter. Prøv igjen.")).toBeVisible();
  });
});
