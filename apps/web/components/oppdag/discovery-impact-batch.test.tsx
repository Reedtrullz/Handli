// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DiscoveryImpactRequestV1,
  DiscoveryImpactResponseV1,
  ExactProductPlanApiProductSummary,
  MoneyOre,
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addReviewedFamilyToBasket,
  emptyBasketV3,
  type BrowserBasket,
} from "../../lib/browser-basket";
import type { DiscoveryImpactCalculation } from "../../lib/discovery-impact-client";
import {
  buildDiscoveryImpactRequest,
  DiscoveryImpactBatch,
  discoveryImpactChoices,
} from "./discovery-impact-batch";

const GTIN_MILK = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const GTIN_BREAD = "7038010000034";

function ean13(index: number): string {
  const body = `703801${String(index).padStart(6, "0")}`;
  const weighted = [...body].reduce(
    (sum, digit, digitIndex) => sum + Number(digit) * (digitIndex % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

function product(
  gtin: string,
  displayName: string,
): ExactProductPlanApiProductSummary {
  return {
    catalogEvidence: {
      observedAt: "2026-07-17T10:00:00.000Z",
      source: {
        contractVersion: 1,
        displayName: "Godkjent katalog",
        id: "catalog-source",
        sourceClass: "catalog",
        state: "approved",
      },
      sourceRecordId: `source-record:${(gtin === GTIN_MILK ? "a" : gtin === GTIN_COFFEE ? "b" : "c").repeat(64)}`,
    },
    displayName,
    gtin,
    packageMeasure: { amount: 1, unit: "package" },
    unitsPerPack: 1,
  };
}

const coffee = product(GTIN_COFFEE, "Kaffe");
const bread = product(GTIN_BREAD, "Brød");

const exactBasket: BrowserBasket = {
  ...emptyBasketV3,
  convenienceWeightBasisPoints: 7_500,
  matchingRules: [{
    exactEan: GTIN_MILK,
    explanation: "Eksakt melk",
    id: "rule:milk",
    mode: "exact",
    userApproved: true,
  }],
  needs: [{
    id: "need:milk",
    matchRuleId: "rule:milk",
    quantity: 2,
    quantityUnit: "ml",
    query: "Melk til frokost",
    required: true,
  }],
  products: [{
    ean: GTIN_MILK,
    name: "Melk",
    packageQuantity: 1_000,
    packageUnit: "ml",
  }],
};

function reviewedCandidateBasket(): BrowserBasket {
  const ids = ["need:family", "rule:family"];
  const reviewed = addReviewedFamilyToBasket(emptyBasketV3, {
    candidateCount: 1,
    confirmation: {
      candidateSetId: `candidate-set:${"d".repeat(64)}`,
      taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
      userApproved: true,
    },
    family: {
      aliases: ["brød"],
      id: "family:brod",
      labelNo: "Brød",
      slug: "brod",
      status: "active",
    },
    quantity: 2,
  }, () => ids.shift()!);
  return {
    ...reviewed,
    products: [{
      ean: GTIN_BREAD,
      name: "Brød",
      productFamily: "family:brod",
    }],
  };
}

function plan(
  totalOre: number,
  chains: Array<"bunnpris" | "extra" | "rema-1000">,
  comparisonCoverage: "complete" | "partial" = "complete",
) {
  return {
    appliedOfficialOfferIds: [],
    chains,
    comparisonCoverage,
    requiredMembershipProgramIds: [],
    storeCount: chains.length as 1 | 2 | 3,
    substitutionCount: 0,
    totalOre: totalOre as MoneyOre,
  };
}

function comparableResponse(request: DiscoveryImpactRequestV1): DiscoveryImpactResponseV1 {
  const baselinePlan = plan(10_000, ["extra"]);
  const exactGtins = request.planning.needs.flatMap((need) =>
    need.match.kind === "exact-product" ? [need.match.product.value] : []
  );
  return {
    baseline: { kind: "complete", plan: baselinePlan },
    contractVersion: 1,
    evaluatedAt: "2026-07-17T12:00:00.000Z",
    evaluatedProductCount: new Set([
      ...exactGtins,
      ...request.actions.map(({ product: actionProduct }) => actionProduct.value),
    ]).size,
    marketContext: request.planning.marketContext,
    outcomes: request.actions.map((action) => {
      if (action.kind === "add") {
        return {
          action,
          actionId: action.actionId,
          actionKind: action.kind,
          comparison: {
            basis: "different-basket" as const,
            chainsAdded: ["bunnpris" as const],
            chainsRemoved: [],
            checkoutTotalDeltaOre: 2_000,
            claimScope: "declared-complete-coverage" as const,
            kind: "comparable" as const,
            storeCountDelta: 1,
            substitutionCountDelta: 0,
          },
          plan: plan(12_000, ["bunnpris", "extra"]),
          state: "complete" as const,
        };
      }
      return {
        action,
        actionId: action.actionId,
        actionKind: action.kind,
        comparison: {
          basis: "same-need" as const,
          chainsAdded: ["rema-1000" as const],
          chainsRemoved: ["extra" as const],
          checkoutTotalDeltaOre: -1_000,
          claimScope: "among-verified-prices" as const,
          kind: "comparable" as const,
          storeCountDelta: 0,
          substitutionCountDelta: 0,
        },
        plan: plan(9_000, ["rema-1000"], "partial"),
        state: "complete" as const,
      };
    }),
    travelImpact: { kind: "omitted", reason: "origin-not-retained" },
  };
}

afterEach(() => cleanup());

describe("Oppdag plan-impact batch", () => {
  it("builds and sends one origin-free batch for every visible add action", async () => {
    const user = userEvent.setup();
    const calculate = vi.fn<DiscoveryImpactCalculation>(async (request) =>
      comparableResponse(request)
    );
    render(
      <DiscoveryImpactBatch
        basket={exactBasket}
        calculateImpact={calculate}
        onBasketChange={vi.fn()}
        products={[coffee, bread]}
      />,
    );

    expect(screen.getAllByLabelText(/^Valg for /)).toHaveLength(2);
    expect(screen.getByLabelText("Valg for Kaffe")).toHaveValue("");
    expect(screen.getByLabelText("Valg for Brød")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Beregn effekten (0 valg)" })).toBeDisabled();
    await user.click(screen.getByRole("button", {
      name: "Velg «Legg til» for alle tilgjengelige",
    }));
    expect(screen.getByLabelText("Valg for Kaffe")).toHaveValue("add");
    expect(screen.getByLabelText("Valg for Brød")).toHaveValue("add");
    await user.click(screen.getByRole("button", { name: "Beregn effekten (2 valg)" }));

    expect(calculate).toHaveBeenCalledOnce();
    const request = calculate.mock.calls[0]![0];
    expect(request.actions).toHaveLength(2);
    expect(request.actions.every(({ kind }) => kind === "add")).toBe(true);
    expect(request.convenienceWeightBasisPoints).toBe(7_500);
    expect(JSON.stringify(request)).not.toMatch(/origin|address|latitude|longitude|travel/i);
    expect(await screen.findAllByText(/Med varen lagt til blir beregnet kassetotal/)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/spar|besparelse/i);
    expect(screen.getAllByText(/Reisetid er ikke med i overslaget/)).toHaveLength(2);
    expect(screen.getAllByText(/Butikkjeder inn i planen: Bunnpris/)).toHaveLength(2);
  });

  it("requires an inline confirmation before one targeted replace request and preserves the need on apply", async () => {
    const user = userEvent.setup();
    const calculate = vi.fn<DiscoveryImpactCalculation>(async (request) =>
      comparableResponse(request)
    );
    const onBasketChange = vi.fn();
    render(
      <DiscoveryImpactBatch
        basket={exactBasket}
        calculateImpact={calculate}
        onBasketChange={onBasketChange}
        products={[bread]}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("Valg for Brød"),
      "replace:need:milk",
    );
    await user.click(screen.getByRole("button", { name: "Beregn effekten (1 valg)" }));
    expect(calculate).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alert");
    expect(confirmation).toHaveTextContent(/Mengde og enhet bevares/);
    expect(confirmation).toHaveTextContent("Erstatt «Melk til frokost» med «Brød».");

    await user.click(within(confirmation).getByRole("button", {
      name: "Bekreft og beregn én batch",
    }));
    expect(calculate).toHaveBeenCalledOnce();
    expect(calculate.mock.calls[0]![0].actions).toEqual([expect.objectContaining({
      kind: "replace",
      needId: "need:milk",
      product: { kind: "gtin", value: GTIN_BREAD },
      userApproved: true,
    })]);
    expect(await screen.findByText(/blant verifiserte priser/)).toBeVisible();
    expect(screen.getByText(/Butikkjeder inn i planen: REMA 1000/)).toBeVisible();
    expect(screen.getByText(/Butikkjeder ut av planen: Extra/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Bruk valget i handlelisten" }));
    expect(onBasketChange).toHaveBeenCalledOnce();
    const applied = onBasketChange.mock.calls[0]![0] as BrowserBasket;
    expect(applied.needs).toEqual(exactBasket.needs);
    expect(applied.needs[0]).toMatchObject({ quantity: 2, quantityUnit: "ml" });
    expect(applied.matchingRules[0]).toMatchObject({
      exactEan: GTIN_BREAD,
      id: "rule:milk",
      mode: "exact",
    });
  });

  it("shows lock only for a bound reviewed-family confirmation plus local candidate context", () => {
    const withCandidate = reviewedCandidateBasket();

    expect(discoveryImpactChoices(withCandidate, bread).map(({ value }) => value))
      .toContain("lock:need:family");
    expect(discoveryImpactChoices(
      { ...withCandidate, familyConfirmations: [] },
      bread,
    ).map(({ value }) => value)).not.toContain("lock:need:family");
    expect(discoveryImpactChoices(
      { ...withCandidate, products: [] },
      bread,
    ).map(({ value }) => value)).not.toContain("lock:need:family");
  });

  it("confirms a reviewed-family lock and applies the exact choice without changing the need", async () => {
    const user = userEvent.setup();
    const basket = reviewedCandidateBasket();
    const calculate = vi.fn<DiscoveryImpactCalculation>(async (request) =>
      comparableResponse(request)
    );
    const onBasketChange = vi.fn();
    render(
      <DiscoveryImpactBatch
        basket={basket}
        calculateImpact={calculate}
        onBasketChange={onBasketChange}
        products={[bread]}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("Valg for Brød"),
      "lock:need:family",
    );
    await user.click(screen.getByRole("button", { name: "Beregn effekten (1 valg)" }));
    expect(calculate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Bekreft og beregn én batch" }));
    expect(calculate.mock.calls[0]![0].actions[0]).toMatchObject({
      kind: "lock",
      needId: "need:family",
      userApproved: true,
    });

    await user.click(await screen.findByRole("button", {
      name: "Bruk valget i handlelisten",
    }));
    const applied = onBasketChange.mock.calls[0]![0] as BrowserBasket;
    expect(applied.needs).toEqual(basket.needs);
    expect(applied.needs[0]).toMatchObject({ quantity: 2, quantityUnit: "each" });
    expect(applied.matchingRules[0]).toMatchObject({
      exactEan: GTIN_BREAD,
      id: "rule:family",
      mode: "exact",
    });
    expect(applied.familyConfirmations).toEqual([]);
  });

  it("caps a page and request at eight products and fails closed when the union contract cannot fit", () => {
    const products = Array.from({ length: 9 }, (_, index) => product(
      ean13(index + 200),
      `Vare ${index + 1}`,
    ));
    render(
      <DiscoveryImpactBatch
        basket={exactBasket}
        calculateImpact={vi.fn()}
        onBasketChange={vi.fn()}
        products={products}
      />,
    );
    expect(screen.getAllByLabelText(/^Valg for /)).toHaveLength(8);
    const addSelections = Object.fromEntries(products.map(({ gtin }) => [gtin, "add"]));
    expect(buildDiscoveryImpactRequest(
      exactBasket,
      products,
      addSelections,
      "request-a",
    )?.actions).toHaveLength(8);

    const fortyThreeNeeds: BrowserBasket = {
      ...exactBasket,
      matchingRules: Array.from({ length: 43 }, (_, index) => ({
        exactEan: ean13(index + 100),
        explanation: "Eksakt",
        id: `rule:${index}`,
        mode: "exact" as const,
        userApproved: true as const,
      })),
      needs: Array.from({ length: 43 }, (_, index) => ({
        id: `need:${index}`,
        matchRuleId: `rule:${index}`,
        quantity: 1,
        quantityUnit: "each" as const,
        query: `Vare ${index}`,
        required: true as const,
      })),
      products: Array.from({ length: 43 }, (_, index) => ({
        ean: ean13(index + 100),
        name: `Kurvvare ${index + 1}`,
      })),
    };
    // The strict request builder, not the UI, owns the final 50-GTIN union gate.
    expect(buildDiscoveryImpactRequest(
      fortyThreeNeeds,
      products,
      addSelections,
      "request-b",
    )).toBeUndefined();

    const fiftyNeeds: BrowserBasket = {
      ...fortyThreeNeeds,
      matchingRules: Array.from({ length: 50 }, (_, index) => ({
        exactEan: ean13(index + 100),
        explanation: "Eksakt",
        id: `rule:${index}`,
        mode: "exact" as const,
        userApproved: true as const,
      })),
      needs: Array.from({ length: 50 }, (_, index) => ({
        id: `need:${index}`,
        matchRuleId: `rule:${index}`,
        quantity: 1,
        quantityUnit: "each" as const,
        query: `Kurvvare ${index + 1}`,
        required: true as const,
      })),
      products: Array.from({ length: 50 }, (_, index) => ({
        ean: ean13(index + 100),
        name: `Kurvvare ${index + 1}`,
      })),
    };
    const alreadyPresent = product(ean13(101), "Kurvvare 2");
    expect(discoveryImpactChoices(fiftyNeeds, alreadyPresent).some(
      ({ value }) => value === "add",
    )).toBe(false);
    expect(buildDiscoveryImpactRequest(
      fiftyNeeds,
      [alreadyPresent],
      {},
      "request-c",
    )).toBeUndefined();
    expect(buildDiscoveryImpactRequest(fiftyNeeds, [alreadyPresent], {
      [alreadyPresent.gtin]: "replace:need:0",
    }, "request-d")?.actions[0]).toMatchObject({
      kind: "replace",
      needId: "need:0",
    });

    const first = buildDiscoveryImpactRequest(
      exactBasket,
      [coffee],
      { [coffee.gtin]: "add" },
      "nonce-one",
    );
    const second = buildDiscoveryImpactRequest(
      exactBasket,
      [coffee],
      { [coffee.gtin]: "add" },
      "nonce-two",
    );
    expect(first?.actions[0]?.actionId).not.toBe(second?.actions[0]?.actionId);
  });

  it("renders no numeric claim when the baseline is incomplete", async () => {
    const user = userEvent.setup();
    const calculate = vi.fn<DiscoveryImpactCalculation>(async (request) => ({
      baseline: { kind: "incomplete", reason: "no-complete-plan" },
      contractVersion: 1,
      evaluatedAt: "2026-07-17T12:00:00.000Z",
      evaluatedProductCount: 2,
      marketContext: request.planning.marketContext,
      outcomes: [{
        action: request.actions[0]!,
        actionId: request.actions[0]!.actionId,
        actionKind: request.actions[0]!.kind,
        comparison: { kind: "unavailable", reason: "baseline-incomplete" },
        plan: plan(12_000, ["extra"]),
        state: "complete",
      }],
      travelImpact: { kind: "omitted", reason: "origin-not-retained" },
    }));
    render(
      <DiscoveryImpactBatch
        basket={exactBasket}
        calculateImpact={calculate}
        onBasketChange={vi.fn()}
        products={[bread]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Valg for Brød"), "add");
    await user.click(screen.getByRole("button", { name: "Beregn effekten (1 valg)" }));
    expect(await screen.findByText(/Beløpsforskjell vises ikke/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/120,00|kr/);
  });

  it("qualifies member-dependent totals with plan chains and never renders opaque IDs", async () => {
    const user = userEvent.setup();
    const baselineProgramId = "opaque-baseline-member-key";
    const outcomeProgramId = "opaque-outcome-member-key";
    const calculate = vi.fn<DiscoveryImpactCalculation>(async (request) => {
      const base = comparableResponse(request);
      return {
        ...base,
        baseline: base.baseline.kind === "complete"
          ? {
              ...base.baseline,
              plan: {
                ...base.baseline.plan,
                requiredMembershipProgramIds: [baselineProgramId],
              },
            }
          : base.baseline,
        outcomes: base.outcomes.map((outcome) => outcome.state === "complete"
          ? {
              ...outcome,
              plan: {
                ...outcome.plan,
                requiredMembershipProgramIds: [outcomeProgramId],
              },
            }
          : outcome),
      };
    });

    render(
      <DiscoveryImpactBatch
        basket={exactBasket}
        calculateImpact={calculate}
        onBasketChange={vi.fn()}
        products={[coffee]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Valg for Kaffe"), "add");
    await user.click(screen.getByRole("button", { name: "Beregn effekten (1 valg)" }));

    expect(await screen.findByText(
      /Beløpssammenligningen forutsetter medlemskap\. Butikkjedene i planene som bruker medlemspris: Bunnpris og Extra\./,
    )).toBeVisible();
    expect(screen.getByText(
      /Medlemspris er inkludert i denne totalen og krever medlemskap\. Planens butikkjeder: Bunnpris og Extra\./,
    )).toBeVisible();
    expect(document.body).not.toHaveTextContent(baselineProgramId);
    expect(document.body).not.toHaveTextContent(outcomeProgramId);
  });
});
