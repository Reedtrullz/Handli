// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  MoneyOre,
  OfficialOffer,
  PlanDeltaExplanationSetV1,
  PlanResultV2,
  TravelCalculationState,
} from "@handleplan/domain";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  balancedPlanId,
  convenienceWeightForPlanId,
  planIdForPreference,
  PlanSelector,
} from "./plan-selector";

const money = (value: number) => value as MoneyOre;

const memberOffer: OfficialOffer = {
  applicability: {
    channels: ["in-store"],
    contractVersion: 1,
    endsAt: "2026-07-18T00:00:00.000Z",
    geographicScope: { countryCode: "NO", kind: "national" },
    startsAt: "2026-07-14T00:00:00.000Z",
  },
  beforePriceOre: money(90_000),
  capturedAt: "2026-07-15T10:00:00.000Z",
  chainId: "extra",
  conditions: [{ kind: "member", programId: "source-neutral-program" }],
  contractVersion: 1,
  evidenceLevel: "reviewed",
  id: "offer:member-plan",
  kind: "official-offer",
  pricing: { kind: "unit", unitPriceOre: money(80_000) },
  productMatch: { canonicalProductId: "product:member-plan", kind: "exact" },
  sourceId: "offer-source",
  sourceRecordId: "source-record:member-plan",
};

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

function explanations(
  plans: readonly PlanResultV2[],
  includeTravel = false,
  equivalent = false,
): PlanDeltaExplanationSetV1 {
  const reference = plans[0]!;
  return {
    contractVersion: 1,
    binding: {
      generatedAt: "2026-07-17T10:00:00.000Z",
      marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
      planIds: plans.map(({ id }) => id),
      evidenceIds: ["price:fixture"],
      officialOfferIds: [],
      comparisonScope: "complete",
      unresolvedReasons: [],
      ...(includeTravel ? {
        routes: plans.map(({ id }) => ({
          planId: id,
          calculatedAt: "2026-07-17T10:00:00.000Z",
          mode: "car" as const,
          providerSourceId: "route-source",
          routeFingerprint: `route:${id}`,
        })),
      } : {}),
    },
    referencePlanId: reference.id,
    qualifier: {
      locale: "nb-NO",
      policy: "returned-complete-plans-only",
      message: "Serverkvalifisert sammenligning.",
    },
    entries: plans.map((candidate, index) => ({
      planId: candidate.id,
      referencePlanId: reference.id,
      presentation: plans.length === 1
        ? { role: "only" as const, label: "Eneste komplette plan" }
        : equivalent
          ? { role: "equivalent" as const, label: `Likeverdig alternativ ${index + 1}` }
          : index === 0
            ? { role: "convenience" as const, label: "Enklest" }
            : index === plans.length - 1
              ? { role: "savings" as const, label: "Mest spart" }
              : { role: "balanced" as const, label: "Balansert" },
      price: index === 0
        ? { kind: "reference" as const, message: "Serverens sammenligningsgrunnlag." }
        : { kind: "same" as const, differenceOre: 0 as const, savingOre: 0 as const, message: "Serveren oppgir samme pris." },
      offerSaving: { kind: "none" as const, message: "Ingen dokumentert tilbudssparing." },
      stores: {
        count: candidate.chains.length,
        chainIds: [...candidate.chains],
        referenceCount: reference.chains.length,
        referenceChainIds: [...reference.chains],
        addedChainIds: candidate.chains.filter((chain) => !reference.chains.includes(chain)),
        removedChainIds: reference.chains.filter((chain) => !candidate.chains.includes(chain)),
        message: "Serverberegnet butikkforskjell.",
      },
      needs: [],
      ...(includeTravel ? {
        travel: index === 0
          ? { kind: "reference" as const, message: "Serverens reisereferanse." }
          : {
              kind: "compared" as const,
              durationSeconds: { kind: "same" as const, difference: 0 as const },
              distanceMeters: { kind: "same" as const, difference: 0 as const },
              message: "Serverberegnet reiseforskjell.",
            },
      } : {}),
      summary: "Serverberegnet forskjell.",
    })),
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
        officialOffers={[]}
        planDeltaExplanations={explanations(returned)}
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

  it("renders neutral server labels without inferring convenience or savings from totals", () => {
    const returned = [
      plan("higher-price", 95_060, ["extra"]),
      plan("lower-price", 79_320, ["bunnpris", "extra"]),
    ];
    const supplied = explanations(returned);
    supplied.entries = supplied.entries.map((entry, index) => ({
      ...entry,
      presentation: { role: "alternative", label: `Alternativ ${index + 1}` },
    }));

    render(
      <PlanSelector
        plans={returned}
        officialOffers={[]}
        planDeltaExplanations={supplied}
        selectedPlanId="higher-price"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByRole("radio", { name: /Alternativ 1/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Alternativ 2/ })).toHaveAttribute(
      "value",
      "lower-price",
    );
    expect(screen.queryByText("Enklest")).not.toBeInTheDocument();
    expect(screen.queryByText("Mest spart")).not.toBeInTheDocument();
  });

  it("discloses an applied member condition by chain without exposing the opaque ID", () => {
    const base = plan("member-plan", 80_000, ["extra"]);
    const memberPlan: PlanResultV2 = {
      ...base,
      assignments: [{
        ...base.assignments[0]!,
        checkout: {
          appliedOfferId: memberOffer.id,
          ordinaryTotalOre: money(90_000),
          savingOre: money(10_000),
          totalOre: money(80_000),
        },
        officialOffer: {
          capturedAt: memberOffer.capturedAt,
          id: memberOffer.id,
          sourceId: memberOffer.sourceId,
          sourceRecordId: memberOffer.sourceRecordId,
        },
      }],
    };

    render(
      <PlanSelector
        plans={[memberPlan]}
        officialOffers={[memberOffer]}
        planDeltaExplanations={explanations([memberPlan])}
        selectedPlanId={memberPlan.id}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("Medlemspris hos Extra krever medlemskap.")).toBeVisible();
    expect(screen.getByRole("radio")).toHaveAccessibleName(
      /medlemspris hos Extra krever medlemskap/i,
    );
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Eneste komplette plan, 800,00 kr, Medlemspris hos Extra krever medlemskap.",
    );
    expect(document.body).not.toHaveTextContent("source-neutral-program");
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
        officialOffers={[]}
        planDeltaExplanations={explanations(plans)}
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
    expect(screen.getByRole("slider", { name: /Velg komplett plan/ })).toHaveAttribute(
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

    const plans = [second, first];
    render(<PlanSelector plans={plans} officialOffers={[]} planDeltaExplanations={explanations(plans, false, true)} selectedPlanId="equal-a" onSelect={() => {}} />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(new Set(radios.map((radio) => radio.getAttribute("aria-label"))).size).toBe(2);
    expect(radios.map((radio) => radio.getAttribute("aria-label")).join(" ")).toMatch(/alternativ/i);
  });

  it("labels route duration as estimated in visible and accessible copy", () => {
    const plans = [plan("only-plan", 79_320, ["extra"])];
    const travel: Extract<TravelCalculationState, { kind: "calculated" }> = {
      contractVersion: 1,
      kind: "calculated",
      routes: [{
        aggregate: {
          calculatedAt: "2026-07-17T10:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 720,
          mode: "car",
          providerSourceId: "valhalla-openstreetmap-self-hosted",
          routeFingerprint: `route:${"a".repeat(32)}`,
        },
        planId: "only-plan",
        stops: [{
          branchId: "branch:extra:majorstuen",
          chainId: "extra",
          name: "Extra Majorstuen",
          sequence: 1,
        }],
      }],
    };

    render(
      <PlanSelector
        plans={plans}
        officialOffers={[]}
        planDeltaExplanations={explanations(plans, true)}
        selectedPlanId="only-plan"
        onSelect={() => {}}
        travel={travel}
      />,
    );

    expect(screen.getByText("Estimert reisetid: 12 min · 4,2 km · 1 stopp")).toBeVisible();
    expect(screen.getByRole("radio")).toHaveAccessibleName(/estimert reisetid: 12 min/i);
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Eneste komplette plan, 793,20 kr, estimert reisetid 12 min",
    );
  });

  it("keeps the returned-plan range and radio group synchronized from the keyboard", async () => {
    const user = userEvent.setup();
    const plans = [
      plan("convenience", 95_060, ["extra"]),
      plan("balanced", 82_460, ["rema-1000", "extra"]),
      plan("savings", 79_320, ["bunnpris", "rema-1000", "extra"]),
    ];

    function Harness() {
      const [selectedPlanId, setSelectedPlanId] = useState("balanced");
      return (
        <PlanSelector
          plans={plans}
          officialOffers={[]}
          planDeltaExplanations={explanations(plans)}
          selectedPlanId={selectedPlanId}
          onSelect={setSelectedPlanId}
        />
      );
    }

    render(<Harness />);
    const slider = screen.getByRole("slider", { name: /Velg komplett plan/ });
    slider.focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: /Mest spart/ })).toBeChecked();
    expect(slider).toHaveValue("2");
    expect(slider).toHaveAttribute("aria-valuetext", "Mest spart, 793,20 kr");

    screen.getByRole("radio", { name: /Mest spart/ }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: /Balansert/ })).toBeChecked();
    expect(slider).toHaveValue("1");
  });
});
