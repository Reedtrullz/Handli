// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Product,
  ReviewedFamilyCandidateInspectionResponse,
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_QUANTITY_MAX, BASKET_STORAGE_KEY } from "../../lib/browser-basket";
import {
  ReviewedFamilyCandidateClientError,
  type ReviewedFamilyCandidateInspection,
} from "../../lib/reviewed-family-candidates";
import { BasketWorkspace } from "./basket-workspace";

const milk: Product = {
  ean: "7038010000010",
  name: "TINE Lettmelk 1 % 1 l",
  brand: "TINE",
  packageQuantity: 1000,
  packageUnit: "ml",
  productFamily: "lettmelk",
};
const cheese: Product = {
  ean: "7038010000027",
  name: "Norvegia Original 1 kg",
  brand: "TINE",
  packageQuantity: 1000,
  packageUnit: "g",
  productFamily: "gulost",
};

function familyResponse(
  allowedBrands?: string[],
): ReviewedFamilyCandidateInspectionResponse {
  const source = {
    contractVersion: 1 as const,
    displayName: "Publisert katalog",
    id: "catalog-source",
    sourceClass: "catalog" as const,
    state: "approved" as const,
  };
  return {
    candidateSets: [{
      ...(allowedBrands === undefined ? {} : { allowedBrands }),
      candidateProductIds: ["product:milk"],
      candidateSetId: `candidate-set:${(allowedBrands === undefined ? "a" : "b").repeat(64)}`,
      complete: true,
      family: {
        aliases: ["mjølk"],
        id: "family:melk",
        labelNo: "Melk",
        slug: "melk",
        status: "active",
      },
      familyId: "family:melk",
      taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
    }],
    contractVersion: 2,
    generatedAt: "2026-07-17T12:00:00.000Z",
    memberships: [{
      canonicalProductId: "product:milk",
      confidence: 100,
      decision: "approved",
      decisionId: "family-membership:11",
      familyId: "family:melk",
      method: "human-review",
      reviewedAt: "2026-07-16T12:00:00.000Z",
      reviewerAttested: true,
    }],
    productClaims: [{
      canonicalProductId: "product:milk",
      product: {
        brand: "TINE",
        catalogEvidence: {
          observedAt: "2026-07-17T10:00:00.000Z",
          source,
          sourceRecordId: `source-record:${"c".repeat(64)}`,
        },
        displayName: "TINE Lettmelk",
        gtin: milk.ean,
        packageMeasure: { amount: 1_000, unit: "ml" },
        unitsPerPack: 1,
      },
    }],
    sources: [source],
    taxonomy: {
      contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
      contractVersion: 1,
      publishedAt: "2026-07-16T00:00:00.000Z",
      taxonomyId: "handleplan-reviewed-families",
      taxonomyVersion: "1.0.0",
      versionId: "handleplan-reviewed-families@1.0.0",
    },
  };
}

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
  it("qualifies planning claims before comparison coverage is known", () => {
    render(
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => []}
        searchDelayMs={0}
      />,
    );

    expect(screen.getByText("Finn handleplan")).toBeVisible();
    expect(screen.getByText(/komplette kurver blant prisene vi kan verifisere/i)).toBeVisible();
    expect(screen.queryByText(/lavest mulig totalpris/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/beste handleplan/i)).not.toBeInTheDocument();
  });

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

  it("requires server inspection and explicit approval before adding a reviewed family", async () => {
    const user = userEvent.setup();
    const inspect = vi.fn(async () => familyResponse());
    render(
      <BasketWorkspace
        createId={idFactory()}
        inspectFamilyCandidates={inspect}
        searchProducts={async () => []}
        searchDelayMs={0}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Varetype"), "family:melk");
    await user.click(screen.getByRole("button", { name: "Se gjennom alternativer" }));
    expect(inspect).toHaveBeenCalledWith({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    }, expect.any(AbortSignal));
    expect(screen.queryByRole("listitem", { name: /Melk/i })).not.toBeInTheDocument();
    const approval = await screen.findByRole("group", { name: "Godkjenn alternativer for Melk" });
    expect(within(approval).getByText(/1 gjennomgått produkt/i)).toBeVisible();

    await user.click(within(approval).getByRole("button", { name: "Godkjenn kandidatlisten og legg til" }));

    const row = screen.getByRole("listitem", { name: /Melk/i });
    expect(within(row).getByText("Gjennomgått varetype")).toBeVisible();
    expect(within(row).getByText(/1 godkjent kandidat/)).toBeVisible();
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      familyConfirmations: [{
        candidateCount: 1,
        confirmation: {
          candidateSetId: `candidate-set:${"a".repeat(64)}`,
          taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
          userApproved: true,
        },
        family: { id: "family:melk", labelNo: "Melk" },
      }],
      matchingRules: [{
        mode: "flexible",
        productFamily: "family:melk",
        userApproved: true,
      }],
    });
  });

  it("clears reviewed-family confirmations atomically and stays empty after reload", async () => {
    const user = userEvent.setup();
    const props = {
      createId: idFactory(),
      inspectFamilyCandidates: async () => familyResponse(),
      searchProducts: async () => [],
      searchDelayMs: 0,
    };
    const first = render(<BasketWorkspace {...props} />);

    await user.selectOptions(screen.getByLabelText("Varetype"), "family:melk");
    await user.click(screen.getByRole("button", { name: "Se gjennom alternativer" }));
    const approval = await screen.findByRole("group", { name: "Godkjenn alternativer for Melk" });
    await user.click(within(approval).getByRole("button", {
      name: "Godkjenn kandidatlisten og legg til",
    }));
    await user.click(screen.getByRole("button", { name: "Tøm liste" }));

    expect(screen.getByText("Kurven er tom.")).toBeVisible();
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      familyConfirmations: [],
      matchingRules: [],
      needs: [],
      products: [],
    });

    first.unmount();
    render(<BasketWorkspace {...props} />);
    expect(screen.getByText("Kurven er tom.")).toBeVisible();
    expect(screen.queryByRole("listitem", { name: /Melk/i })).not.toBeInTheDocument();
  });

  it("shows the reviewed candidate names and prevents a duplicate family", async () => {
    const user = userEvent.setup();
    render(
      <BasketWorkspace
        createId={idFactory()}
        inspectFamilyCandidates={async () => familyResponse()}
        searchProducts={async () => []}
        searchDelayMs={0}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Varetype"), "family:melk");
    await user.click(screen.getByRole("button", { name: "Se gjennom alternativer" }));
    const approval = await screen.findByRole("group", { name: "Godkjenn alternativer for Melk" });
    expect(within(approval).getByText("TINE Lettmelk")).toBeVisible();
    await user.click(within(approval).getByRole("button", { name: "Godkjenn kandidatlisten og legg til" }));

    expect(screen.getByText(/Melk finnes allerede i kurven/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Se gjennom alternativer" })).toBeDisabled();
  });

  it("shows package measure and multipack facts for otherwise identical candidates", async () => {
    const user = userEvent.setup();
    const response = familyResponse();
    const firstClaim = response.productClaims[0]!;
    const firstMembership = response.memberships[0]!;
    const secondId = "product:milk-small";
    response.candidateSets[0] = {
      ...response.candidateSets[0]!,
      candidateProductIds: ["product:milk", secondId],
    };
    response.productClaims = [firstClaim, {
      canonicalProductId: secondId,
      product: {
        ...firstClaim.product,
        gtin: "7038010000034",
        packageMeasure: { amount: 500, unit: "ml" },
        unitsPerPack: 4,
        catalogEvidence: {
          ...firstClaim.product.catalogEvidence,
          sourceRecordId: `source-record:${"d".repeat(64)}`,
        },
      },
    }];
    response.memberships = [firstMembership, {
      ...firstMembership,
      canonicalProductId: secondId,
      decisionId: "family-membership:12",
    }];

    render(
      <BasketWorkspace
        createId={idFactory()}
        inspectFamilyCandidates={async () => response}
        searchProducts={async () => []}
        searchDelayMs={0}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Varetype"), "family:melk");
    await user.click(screen.getByRole("button", { name: "Se gjennom alternativer" }));
    const approval = await screen.findByRole("group", { name: "Godkjenn alternativer for Melk" });

    expect(within(approval).getAllByText("TINE Lettmelk")).toHaveLength(2);
    expect(within(approval).getByText(/1.?000 ml/)).toBeVisible();
    expect(within(approval).getByText(/500 ml · 4 enheter per pakke/)).toBeVisible();
  });

  it("normalizes an optional brand filter and binds it to the approved candidate set", async () => {
    const user = userEvent.setup();
    const inspect: ReviewedFamilyCandidateInspection = vi.fn(async (request) =>
      familyResponse(request.families[0]?.allowedBrands));
    render(
      <BasketWorkspace
        createId={idFactory()}
        inspectFamilyCandidates={inspect}
        searchProducts={async () => []}
        searchDelayMs={0}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Varetype"), "family:melk");
    await user.type(screen.getByLabelText("Merker (valgfritt)"), " TINE, tine ");
    await user.click(screen.getByRole("button", { name: "Se gjennom alternativer" }));
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      families: [{ allowedBrands: ["tine"], familyId: "family:melk" }],
    }), expect.any(AbortSignal));
    const approval = await screen.findByRole("group", { name: "Godkjenn alternativer for Melk" });
    await user.click(within(approval).getByRole("button", { name: "Godkjenn kandidatlisten og legg til" }));

    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      familyConfirmations: [{ allowedBrands: ["tine"] }],
      matchingRules: [{
        allowedBrands: ["tine"],
        mode: "constrained",
        productFamily: "family:melk",
        userApproved: true,
      }],
    });
  });

  it("fails closed when a reviewed family has no complete candidate set", async () => {
    const user = userEvent.setup();
    render(<BasketWorkspace
      createId={idFactory()}
      inspectFamilyCandidates={async () => {
        throw new ReviewedFamilyCandidateClientError("NO_CANDIDATES");
      }}
      searchProducts={async () => []}
      searchDelayMs={0}
    />);

    await user.click(screen.getByRole("button", { name: "Se gjennom alternativer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/ingen komplett, gjennomgått kandidatliste/i);
    expect(screen.queryByRole("group", { name: /Godkjenn alternativer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /Brød/i })).not.toBeInTheDocument();
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

  it("preserves search inside the composer, dismisses after leaving it, and keeps pointer selection", async () => {
    const user = userEvent.setup();
    render(<>
      <BasketWorkspace
        createId={idFactory()}
        searchProducts={async () => [milk]}
        searchDelayMs={0}
      />
      <button type="button">Utenfor søkerammen</button>
    </>);
    const input = screen.getByRole("combobox", { name: "Hva skal du handle?" });

    await user.type(input, "melk");
    expect(await screen.findByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
    await user.tab();
    expect(screen.getByRole("button", { name: "Øk antall" })).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Varetype" })).toHaveFocus();
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "false"));
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
    fireEvent.change(screen.getByRole("combobox", { name: "Hva skal du handle?" }), { target: { value: "melk" } });
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
    await userEvent.setup().type(screen.getByRole("combobox", { name: "Hva skal du handle?" }), "melk");
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
    expect(await screen.findByText(/Ingen støttede produkter funnet/)).toBeVisible();
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
      version: 3,
      needs,
      matchingRules: needs.map((_, index) => ({ id: `rule-${index}`, mode: "exact", exactEan: milk.ean, userApproved: true, explanation: "Eksakt produkt" })),
      products: [milk],
      convenienceWeightBasisPoints: 5_000,
      familyConfirmations: [],
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
