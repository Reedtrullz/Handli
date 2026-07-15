// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MoneyOre, PlanResult } from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanSelector, orderPlanFrontier } from "./plan-selector";

const money = (value: number) => value as MoneyOre;

function plan(
  id: string,
  totalOre: number,
  chains: PlanResult["chains"],
  substitutions: string[] = [],
): PlanResult {
  return {
    id,
    assignments: [
      {
        needId: `need-${id}`,
        ean: "7038010000013",
        chain: chains[0]!,
        quantity: 1,
        costOre: money(totalOre),
      },
    ],
    totalOre: money(totalOre),
    chains,
    substitutions,
    coverage: 1,
    freshness: { [`need-${id}`]: "eligible" },
  };
}

afterEach(cleanup);

describe("PlanSelector", () => {
  it("orders the complete frontier from convenience to savings with deterministic anchors", () => {
    const balanced = plan("balanced", 82_460, ["rema-1000", "extra"]);
    const savings = plan("savings", 79_320, ["bunnpris", "rema-1000", "extra"]);
    const convenience = plan("convenience", 95_060, ["extra"]);

    expect(orderPlanFrontier([balanced, savings, convenience]).map(({ id }) => id)).toEqual([
      "convenience",
      "balanced",
      "savings",
    ]);
  });

  it("uses native radios for keyboard selection and localized plan evidence", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PlanSelector
        plans={[
          plan("balanced", 82_460, ["rema-1000", "extra"]),
          plan("savings", 79_320, ["bunnpris", "rema-1000", "extra"]),
          plan("convenience", 95_060, ["extra"]),
        ]}
        selectedPlanId="balanced"
        onSelect={onSelect}
      />,
    );

    const balanced = screen.getByRole("radio", { name: /Balansert/ });
    expect(balanced).toBeChecked();
    balanced.focus();
    await user.keyboard("{ArrowDown}");

    expect(onSelect).toHaveBeenCalledWith("savings");
    expect(screen.getByRole("radio", { name: /Mest spart/ })).toBeInTheDocument();
    expect(screen.getByText("793,20 kr")).toBeVisible();
  });

  it("retains equal-objective plans with unique truthful accessible names", () => {
    const first = plan("equal-a", 80_000, ["extra", "rema-1000"]);
    const second = plan("equal-b", 80_000, ["extra", "rema-1000"]);

    render(
      <PlanSelector plans={[second, first]} selectedPlanId="equal-a" onSelect={() => {}} />,
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(new Set(radios.map((radio) => radio.getAttribute("aria-label"))).size).toBe(2);
    expect(radios.map((radio) => radio.getAttribute("aria-label")).join(" ")).toMatch(/alternativ/i);
  });
});
