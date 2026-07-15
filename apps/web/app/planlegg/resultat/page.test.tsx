// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_STORAGE_KEY } from "../../../lib/browser-basket";
import ResultPage from "./page";

const basket = {
  version: 1,
  needs: [
    { id: "milk", query: "Lettmelk", quantity: 1, quantityUnit: "each", matchRuleId: "milk-rule", required: true },
    { id: "cheese", query: "Norvegia", quantity: 1, quantityUnit: "each", matchRuleId: "cheese-rule", required: true },
    { id: "soap", query: "Omo", quantity: 1, quantityUnit: "each", matchRuleId: "soap-rule", required: true },
  ],
  matchingRules: [
    { id: "milk-rule", mode: "exact", exactEan: "7038010000013", userApproved: true, explanation: "Eksakt produkt" },
    { id: "cheese-rule", mode: "exact", exactEan: "7038010000020", userApproved: true, explanation: "Eksakt produkt" },
    { id: "soap-rule", mode: "exact", exactEan: "7038010000037", userApproved: true, explanation: "Eksakt produkt" },
  ],
  products: [
    { ean: "7038010000013", name: "TINE Lettmelk 1 l", brand: "TINE" },
    { ean: "7038010000020", name: "Norvegia 1 kg", brand: "TINE" },
    { ean: "7038010000037", name: "Omo Color 1,2 l", brand: "Omo" },
  ],
  travel: { enabled: false, mode: "car" },
} as const;

function assignment(needId: string, ean: string, chain: string, costOre: number) {
  return { needId, ean, chain, quantity: 1, costOre };
}

function resultResponse() {
  return {
    generatedAt: "2026-07-15T07:12:00.000Z",
    caveats: [
      "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
      "Medlemspriser og kundeavis-tilbud er ikke med i denne beregningen.",
    ],
    plans: [
      {
        id: "plan-balanced",
        assignments: [
          assignment("milk", "7038010000013", "rema-1000", 30_000),
          assignment("cheese", "7038010000020", "extra", 20_000),
          assignment("soap", "7038010000037", "extra", 32_460),
        ],
        totalOre: 82_460,
        chains: ["extra", "rema-1000"],
        substitutions: [], coverage: 1,
        freshness: { milk: "eligible", cheese: "eligible", soap: "eligible" },
      },
      {
        id: "plan-savings",
        assignments: [
          assignment("milk", "7038010000013", "bunnpris", 30_000),
          assignment("cheese", "7038010000020", "rema-1000", 20_000),
          assignment("soap", "7038010000037", "extra", 29_320),
        ],
        totalOre: 79_320,
        chains: ["bunnpris", "extra", "rema-1000"],
        substitutions: [], coverage: 1,
        freshness: { milk: "eligible", cheese: "eligible", soap: "eligible" },
      },
      {
        id: "plan-convenience",
        assignments: [
          assignment("milk", "7038010000013", "extra", 30_000),
          assignment("cheese", "7038010000020", "extra", 30_000),
          assignment("soap", "7038010000037", "extra", 35_060),
        ],
        totalOre: 95_060,
        chains: ["extra"], substitutions: [], coverage: 1,
        freshness: { milk: "eligible", cheese: "eligible", soap: "eligible" },
      },
    ],
  };
}

function okFetch(body: unknown = resultResponse()) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Planlegg result workspace", () => {
  it("posts the safe local basket, defaults to balanced, and renders complete grouped evidence", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = okFetch();
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    expect(screen.getByText("Beregner komplette handleplaner …")).toBeVisible();
    expect(await screen.findByRole("radio", { name: /Balansert/ })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Handleliste fordelt på rute" })).toBeVisible();
    expect(screen.getByText("824,60 kr", { selector: ".result-total" })).toBeVisible();
    expect(screen.getByText(/Alle 3 nødvendige varer er med/)).toBeVisible();
    expect(screen.getByText(/garanterer ikke lagerstatus/i)).toBeVisible();
    expect(screen.getByText(/Kjedepriser/)).toBeVisible();
    expect(screen.getByText(/15\. juli 2026 kl\. 09:12/)).toBeVisible();
    expect(screen.getByText(/Reisetid er ikke beregnet/)).toBeVisible();
    expect(screen.queryByText(/konto/i)).not.toBeInTheDocument();

    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      needs: basket.needs,
      matchingRules: basket.matchingRules,
      products: basket.products,
      maxStores: 3,
    });
    expect(String(request.body)).not.toMatch(/KASSAL_API_KEY|origin|selectedPlanId/);

    const extra = screen.getByRole("region", { name: /Stopp 1: Extra/ });
    expect(within(extra).getByText("524,60 kr")).toBeVisible();
  });

  it("changes selection, saves it safely, and restores only a still-returned plan", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch());
    const first = render(<ResultPage />);
    const savings = await screen.findByRole("radio", { name: /Mest spart/ });
    await user.click(savings);
    expect(screen.getByText("793,20 kr", { selector: ".result-total" })).toBeVisible();
    expect(screen.getByText("157,40 kr")).toBeVisible();
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      selectedPlanId: "plan-savings",
      needs: basket.needs,
      matchingRules: basket.matchingRules,
    });
    first.unmount();

    render(<ResultPage />);
    expect(await screen.findByRole("radio", { name: /Mest spart/ })).toBeChecked();
  });

  it("shows honest zero savings for the one-store anchor and all three groups for max savings", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch());
    render(<ResultPage />);

    await user.click(await screen.findByRole("radio", { name: /Enklest/ }));
    expect(screen.getByText("0,00 kr")).toBeVisible();
    expect(screen.getAllByRole("region", { name: /Stopp/ })).toHaveLength(1);

    await user.click(screen.getByRole("radio", { name: /Mest spart/ }));
    expect(screen.getAllByRole("region", { name: /Stopp/ })).toHaveLength(3);
    expect(screen.getByText("793,20 kr", { selector: ".result-total" })).toBeVisible();
  });

  it("falls back safely when a persisted selected plan no longer exists", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify({ ...basket, selectedPlanId: "stale-id" }));
    vi.stubGlobal("fetch", okFetch());
    render(<ResultPage />);

    expect(await screen.findByRole("radio", { name: /Balansert/ })).toBeChecked();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}").selectedPlanId).toBe("plan-balanced"));
  });

  it("does not call the API for a missing or corrupt basket and provides a way back", () => {
    const fetch = okFetch();
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem(BASKET_STORAGE_KEY, "not-json");
    render(<ResultPage />);

    expect(screen.getByRole("heading", { name: "Handlekurven er tom" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Tilbake til Planlegg" })).toHaveAttribute("href", "/planlegg");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never presents a partial recommendation when no complete plan exists", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch({ ...resultResponse(), plans: [] }));
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
    expect(screen.queryByText("Anbefalt totalpris")).not.toBeInTheDocument();
  });

  it("sanitizes 503 failures and retries without exposing server details", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "PRICE_DATA_UNAVAILABLE", detail: "secret" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resultResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Prisdata er utilgjengelig" })).toBeVisible();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prøv igjen" }));
    expect(await screen.findByRole("radio", { name: /Balansert/ })).toBeChecked();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...resultResponse(), extra: "unsafe" },
    { ...resultResponse(), plans: [{ ...resultResponse().plans[0], coverage: 0 }] },
    { ...resultResponse(), plans: [{ ...resultResponse().plans[0], totalOre: 1 }] },
  ])("fails closed on malformed or unsafe API responses", async (unsafe) => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(unsafe));
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Kunne ikke vise handleplanen" })).toBeVisible();
    expect(screen.queryByText("Anbefalt totalpris")).not.toBeInTheDocument();
  });

  it("aborts the request on unmount and ignores a late response", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let resolve!: (response: Response) => void;
    let signal!: AbortSignal;
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((done) => (resolve = done));
    });
    vi.stubGlobal("fetch", fetch);
    const view = render(<ResultPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(new Response(JSON.stringify(resultResponse()), { status: 200 })));
    expect(screen.queryByText("Anbefalt totalpris")).not.toBeInTheDocument();
  });
});
