// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { MoneyOre, PlanResult } from "@handleplan/domain";
import { describe, expect, it } from "vitest";
import { PlanSummary } from "./plan-summary";

function summary(totalOre: number) {
  const plan = { id: "plan", assignments: [], totalOre: totalOre as MoneyOre, chains: ["extra"], substitutions: [], coverage: 1, freshness: {} } satisfies PlanResult;
  return <PlanSummary plan={plan} convenienceTotalOre={10_000} requiredItems={1}  />;
}

describe("PlanSummary price comparison", () => {
  it("describes positive, zero, and negative savings truthfully", () => {
    const view = render(summary(9_000));
    expect(screen.getByText("10,00 kr spart")).toBeVisible();
    view.rerender(summary(10_000));
    expect(screen.getByText("Samme pris")).toBeVisible();
    view.rerender(summary(11_000));
    expect(screen.getByText("10,00 kr dyrere")).toBeVisible();
  });
});
