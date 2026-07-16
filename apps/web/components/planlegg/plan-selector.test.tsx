// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MoneyOre, PlanResultV2 } from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  balancedPlanId,
  convenienceWeightForPlanId,
  planIdForPreference,
  PlanSelector,
} from "./plan-selector";

const money = (value: number) => value as MoneyOre;

function plan(
  id: string,
  totalOre: number,
  chains: PlanResultV2["chains"],
  substitutions: string[] = [],
): PlanResultV2 {
  return {
    id,
    assignments: [{
      canonicalProductId: `product:${id}`,
      chain: chains[0]!,
      checkout: { ordinaryTotalOre: money(totalOre), savingOre: money(0), totalOre: money(totalOre) },
      costOre: money(totalOre),
      ean: "7038010000010",
      fulfilment: {
        canonicalProductId: `product:${id}`,
        complete: true,
        contractVersion: 2,
        needId: `need:${id}`,
        packageCount: 1,
        packageMeasure: { amount: 1, unit: "package" },
        purchased: { amount: 1, unit: "package" },
        requested: { amount: 1, unit: "package" },
        surplus: { amount: 0, unit: "package" },
      },
      needId: `need:${id}`,
      observedAt: "2026-07-15T10:00:00.000Z",
      source: "kassalapp",
    }],
    totalOre: money(totalOre),
    chains,
    substitutions,
    coverage: 1,
    freshness: { [`need:${id}`]: "eligible" },
  };
}

afterEach(cleanup);

describe("PlanSelector", () => {
  it("maps the slider and list directly onto the representative order returned by the server", () => {
    const returned = [
      plan("server-first", 79_320, ["bunnpris", "rema-1000", "extra"]),
      plan("server-middle", 95_060, ["extra"]),
      plan("server-last", 82_460, ["rema-1000", "extra"]),
    ];

    render(
      <PlanSelector
        plans={returned}
        selectedPlanId="server-first"
        onSelect={() => {}}
      />,
    );

    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual([
      "server-first",
      "server-middle",
      "server-last",
    ]);
    expect(screen.getByRole("radio", { name: /Enklest/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Mest spart/ })).toHaveAttribute("value", "server-last");
  });

  it("uses native controls and reports the selected returned representative", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onPreferenceChange = vi.fn();
    const plans = [
      plan("convenience", 95_060, ["extra"]),
      plan("balanced", 82_460, ["rema-1000", "extra"]),
      plan("savings", 79_320, ["bunnpris", "rema-1000", "extra"]),
    ];
    render(
      <PlanSelector
        plans={plans}
        selectedPlanId="balanced"
        onSelect={onSelect}
        onPreferenceChange={onPreferenceChange}
      />,
    );

    const balanced = screen.getByRole("radio", { name: /Balansert/ });
    expect(balanced).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Mest spart/ }));

    expect(onSelect).toHaveBeenCalledWith("savings");
    expect(onPreferenceChange).toHaveBeenCalledWith(0);
    expect(screen.getByRole("slider", { name: /Enklest mest spart/ })).toHaveAttribute(
      "aria-valuetext",
      "Balansert, 824,60 kr",
    );
  });

  it("maps persisted preferences directly to the returned order without projection", () => {
    const plans = Array.from({ length: 7 }, (_, index) =>
      plan(`plan-${index}`, 20_000 - index * 500, ["extra"]));

    expect(planIdForPreference(plans, 10_000)).toBe("plan-0");
    expect(balancedPlanId(plans)).toBe("plan-3");
    expect(planIdForPreference(plans, 0)).toBe("plan-6");
    expect(convenienceWeightForPlanId(plans, "plan-3")).toBe(5_000);
  });

  it("retains equal-objective representatives with unique truthful names", () => {
    const first = plan("equal-a", 80_000, ["extra"]);
    const second = plan("equal-b", 80_000, ["extra"]);

    render(<PlanSelector plans={[second, first]} selectedPlanId="equal-a" onSelect={() => {}} />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(new Set(radios.map((radio) => radio.getAttribute("aria-label"))).size).toBe(2);
    expect(radios.map((radio) => radio.getAttribute("aria-label")).join(" ")).toMatch(/alternativ/i);
  });
});
