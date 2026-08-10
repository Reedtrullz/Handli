// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type {
  MoneyOre,
  PlanDeltaExplanationV1,
  PlanResultV2,
  TravelRouteEvidence,
} from "@handleplan/domain";
import { describe, expect, it } from "vitest";
import { PlanSummary } from "./plan-summary";

const money = (value: number) => value as MoneyOre;

function summary(totalOre: number, options: {
  offerSavingOre?: number;
  offerMessage?: string;
  priceMessage?: string;
  travelRoute?: TravelRouteEvidence;
  travelMessage?: string;
} = {}) {
  const {
    offerSavingOre = 0,
    offerMessage = "Serveren fant ingen dokumentert tilbudssparing.",
    priceMessage = "Serverens sammenligningsgrunnlag.",
    travelRoute,
    travelMessage,
  } = options;
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
  const explanation: PlanDeltaExplanationV1 = {
    planId: plan.id,
    referencePlanId: plan.id,
    presentation: { role: "only", label: "Eneste komplette plan" },
    price: { kind: "reference", message: priceMessage },
    offerSaving: { kind: "none", message: offerMessage },
    stores: {
      count: 1,
      chainIds: ["extra"],
      referenceCount: 1,
      referenceChainIds: ["extra"],
      addedChainIds: [],
      removedChainIds: [],
      message: "Samme butikksett.",
    },
    needs: [],
    ...(travelMessage === undefined
      ? {}
      : { travel: { kind: "reference" as const, message: travelMessage } }),
    summary: priceMessage,
  };
  return (
    <PlanSummary
      plan={plan}
      explanation={explanation}
      explanationQualifier="Serverkvalifisert mot samme prisøyeblikk."
      requiredItems={1}
      travelRoute={travelRoute}
    />
  );
}

describe("PlanSummary price comparison", () => {
  it("renders server-provided representative and offer explanations without deriving deltas", () => {
    const view = render(summary(9_000, {
      offerSavingOre: 500,
      offerMessage: "Server: 5,00 kr dokumentert tilbudssparing.",
      priceMessage: "Server: 10,00 kr lavere.",
    }));
    expect(screen.getByText("Komplett handlekurv")).toBeVisible();
    expect(screen.getByText("1 nødvendig vare er med")).toBeVisible();
    expect(screen.queryByText(/1 nødvendige varer/u)).not.toBeInTheDocument();
    expect(screen.getByText("Server: 10,00 kr lavere.")).toBeVisible();
    expect(screen.getByText("Server: 5,00 kr dokumentert tilbudssparing.")).toBeVisible();
    view.rerender(summary(11_000, {
      priceMessage: "Serveren holder tilbake prisforskjellen.",
    }));
    expect(screen.getByText("Serveren holder tilbake prisforskjellen.")).toBeVisible();
    expect(screen.queryByText("10,00 kr dyrere")).not.toBeInTheDocument();
  });

  it("labels displayed route duration as estimated", () => {
    const route: TravelRouteEvidence = {
      aggregate: {
        calculatedAt: "2026-07-17T10:00:00.000Z",
        distanceMeters: 4_200,
        durationSeconds: 720,
        mode: "car",
        providerSourceId: "valhalla-openstreetmap-self-hosted",
        routeFingerprint: `route:${"a".repeat(32)}`,
      },
      planId: "plan",
      stops: [{
        branchId: "branch:extra:majorstuen",
        chainId: "extra",
        name: "Extra Majorstuen",
        sequence: 1,
      }],
    };

    render(summary(9_000, { travelRoute: route, travelMessage: "Serverberegnet reiseforskjell." }));

    const label = screen.getByText("Estimert reisetid", { selector: "dt" });
    expect(label).toBeVisible();
    expect(label.nextElementSibling).toHaveTextContent("12 min");
    expect(screen.getByText("Serverberegnet reiseforskjell.")).toBeVisible();
  });
});
