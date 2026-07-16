// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { MoneyOre, PlanResultV2 } from "@handleplan/domain";
import { describe, expect, it } from "vitest";
import { PlanSummary } from "./plan-summary";

const money = (value: number) => value as MoneyOre;

function summary(totalOre: number, offerSavingOre = 0) {
  const ordinaryTotalOre = totalOre + offerSavingOre;
  const plan: PlanResultV2 = {
    id: "plan",
    assignments: [{
      canonicalProductId: "product:milk",
      chain: "extra",
      checkout: {
        ...(offerSavingOre > 0 ? { appliedOfferId: "offer:milk" } : {}),
        ordinaryTotalOre: money(ordinaryTotalOre),
        savingOre: money(offerSavingOre),
        totalOre: money(totalOre),
      },
      costOre: money(totalOre),
      ean: "7038010000010",
      fulfilment: {
        canonicalProductId: "product:milk",
        complete: true,
        contractVersion: 2,
        needId: "milk",
        packageCount: 1,
        packageMeasure: { amount: 1_000, unit: "ml" },
        purchased: { amount: 1, unit: "package" },
        requested: { amount: 1, unit: "package" },
        surplus: { amount: 0, unit: "package" },
      },
      needId: "milk",
      observedAt: "2026-07-15T10:00:00.000Z",
      ...(offerSavingOre > 0 ? {
        officialOffer: {
          capturedAt: "2026-07-15T09:00:00.000Z",
          id: "offer:milk",
          sourceId: "kassalapp",
          sourceRecordId: "source-record:offer:milk",
        },
      } : {}),
      source: "kassalapp",
    }],
    totalOre: money(totalOre),
    chains: ["extra"],
    substitutions: [],
    coverage: 1,
    freshness: { milk: "eligible" },
  };
  return <PlanSummary plan={plan} convenienceTotalOre={10_000} requiredItems={1} />;
}

describe("PlanSummary price comparison", () => {
  it("describes representative and official-offer savings separately", () => {
    const view = render(summary(9_000, 500));
    expect(screen.getByText("Komplett handlekurv")).toBeVisible();
    expect(screen.getByText("10,00 kr spart")).toBeVisible();
    expect(screen.getByText("5,00 kr")).toBeVisible();
    view.rerender(summary(10_000));
    expect(screen.getByText("Samme pris")).toBeVisible();
    expect(screen.getByText("Ingen tilbud brukt")).toBeVisible();
    view.rerender(summary(11_000));
    expect(screen.getByText("10,00 kr dyrere")).toBeVisible();
  });
});
