// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MoneyOre, PlanResult } from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { balancedPlanId, PlanSelector, projectPlanFrontier, orderPlanFrontier } from "./plan-selector";

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
        observedAt: "2026-07-15T10:00:00.000Z",
        source: "kassalapp",
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

  it("keeps a coincident convenience and savings endpoint first and balanced", () => {
    const endpoint = plan("endpoint", 10_000, ["extra"], ["need-endpoint"]);
    const fewerSubstitutions = plan("fewer-subs", 11_000, ["extra"]);

    expect(orderPlanFrontier([fewerSubstitutions, endpoint]).map(({ id }) => id)).toEqual([
      "endpoint",
      "fewer-subs",
    ]);
    expect(balancedPlanId([fewerSubstitutions, endpoint])).toBe("endpoint");

    render(<PlanSelector plans={[fewerSubstitutions, endpoint]} selectedPlanId="endpoint" onSelect={() => {}} />);
    expect(screen.getByRole("radio", { name: /Enklest og lavest pris/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Færre bytter/ })).toHaveAccessibleName(/10,00 kr dyrere/);
  });

  it("projects a large valid frontier to seven spread representatives with both endpoints", () => {
    const plans = Array.from({ length: 12 }, (_, index) =>
      plan(`plan-${index}`, 20_000 - index * 500, Array.from({ length: index < 4 ? 1 : index < 8 ? 2 : 3 }, (_unused, chainIndex) => ["extra", "rema-1000", "bunnpris"][chainIndex]!) as PlanResult["chains"]),
    );
    const ordered = orderPlanFrontier(plans);
    const projected = projectPlanFrontier(plans);

    expect(projected).toHaveLength(7);
    expect(projected[0]?.id).toBe(ordered[0]?.id);
    expect(projected.at(-1)?.id).toBe(ordered.at(-1)?.id);
    expect(new Set(projected.map(({ id }) => id)).size).toBe(7);
  });

  it("preserves a unique two-store compromise when uniform sampling would crowd it out", () => {
    const oneStore = Array.from({ length: 10 }, (_, index) =>
      plan(`one-${index}`, 30_000 - index * 100, ["extra"]),
    );
    const compromise = plan("only-two-store", 28_900, ["extra", "rema-1000"]);
    const threeStore = Array.from({ length: 13 }, (_, index) =>
      plan(`three-${index}`, 28_800 - index * 100, ["extra", "rema-1000", "bunnpris"]),
    );
    const plans = [...oneStore, compromise, ...threeStore];

    const projected = projectPlanFrontier(plans);

    expect(projected).toHaveLength(7);
    expect(projected[0]?.id).toBe(orderPlanFrontier(plans)[0]?.id);
    expect(projected.at(-1)?.id).toBe(orderPlanFrontier(plans).at(-1)?.id);
    expect(projected.map(({ id }) => id)).toContain("only-two-store");
    expect(new Set(projected.map(({ id }) => id)).size).toBe(projected.length);
    expect(new Set(projected.map(({ chains }) => chains.length))).toEqual(new Set([1, 2, 3]));
  });

  it("selects repeated transition representatives deterministically across input permutations", () => {
    const sharedEndpoint = plan("endpoint", 10_000, ["extra"], ["swap-a", "swap-b"]);
    const plans = [
      sharedEndpoint,
      plan("two-a", 10_200, ["extra", "rema-1000"]),
      plan("one-a", 10_300, ["extra"]),
      plan("three-a", 10_400, ["extra", "rema-1000", "bunnpris"]),
      plan("two-b", 10_500, ["extra", "rema-1000"]),
      plan("one-b", 10_600, ["extra"]),
      plan("three-b", 10_700, ["extra", "rema-1000", "bunnpris"]),
      plan("two-c", 10_800, ["extra", "rema-1000"]),
      plan("one-c", 10_900, ["extra"]),
    ];

    const projected = projectPlanFrontier(plans);
    const reversed = projectPlanFrontier([...plans].reverse());

    expect(projected).toHaveLength(7);
    expect(projected.map(({ id }) => id)).toEqual(reversed.map(({ id }) => id));
    expect(new Set(projected.map(({ chains }) => chains.length))).toEqual(new Set([1, 2, 3]));
    expect(new Set(projected.map(({ id }) => id)).size).toBe(projected.length);
    expect(projected.map(({ id }) => id)).toEqual(
      orderPlanFrontier(plans).filter(({ id }) => projected.some((candidate) => candidate.id === id)).map(({ id }) => id),
    );
  });
});
