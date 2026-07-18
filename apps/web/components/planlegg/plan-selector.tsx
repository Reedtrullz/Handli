"use client";

import {
  formatNok,
  type OfficialOffer,
  type PlanDeltaExplanationSetV1,
  type PlanResultV2,
  type TravelCalculationState,
} from "@handleplan/domain";

import {
  formatTravelDistance,
  formatTravelDuration,
} from "./travel-presentation";
import {
  hasMembershipCondition,
  membershipRequirementCopy,
} from "../../lib/membership-presentation";

interface PlanSelectorProps {
  plans: readonly PlanResultV2[];
  selectedPlanId: string;
  onSelect: (planId: string) => void;
  onPreferenceChange?: (convenienceWeightBasisPoints: number) => void;
  officialOffers: readonly OfficialOffer[];
  planDeltaExplanations: PlanDeltaExplanationSetV1;
  travel?: Extract<TravelCalculationState, { kind: "calculated" }>;
}

export function balancedPlanId(plans: readonly PlanResultV2[]): string | undefined {
  return planIdForPreference(plans, 5_000);
}

function preferenceIndex(length: number, convenienceWeightBasisPoints: number): number {
  if (length <= 1) return 0;
  const bounded = Math.min(10_000, Math.max(0, convenienceWeightBasisPoints));
  return Math.floor(((10_000 - bounded) / 10_000) * (length - 1));
}

export function planIdForPreference(
  plans: readonly PlanResultV2[],
  convenienceWeightBasisPoints: number,
): string | undefined {
  return plans[preferenceIndex(plans.length, convenienceWeightBasisPoints)]?.id;
}

export function convenienceWeightForPlanId(
  plans: readonly PlanResultV2[],
  planId: string,
): number {
  const index = plans.findIndex(({ id }) => id === planId);
  if (index <= 0 || plans.length <= 1) return 10_000;
  return Math.round((1 - index / (plans.length - 1)) * 10_000);
}

const CHAIN_NAMES: Record<PlanResultV2["chains"][number], string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

function membershipCopyForPlan(
  plan: PlanResultV2,
  offersById: ReadonlyMap<string, OfficialOffer>,
): string | undefined {
  const membershipChains = [...new Set(plan.assignments.flatMap((assignment) => {
    const offerId = assignment.checkout.appliedOfferId;
    const offer = offerId === undefined ? undefined : offersById.get(offerId);
    return hasMembershipCondition(offer) ? [assignment.chain] : [];
  }))];
  return membershipChains.length === 0
    ? undefined
    : membershipRequirementCopy(membershipChains);
}

export function PlanSelector({
  plans,
  selectedPlanId,
  onSelect,
  onPreferenceChange,
  officialOffers,
  planDeltaExplanations,
  travel,
}: PlanSelectorProps) {
  if (plans.length === 0) return null;
  const selectedIndex = Math.max(0, plans.findIndex(({ id }) => id === selectedPlanId));

  function select(planId: string): void {
    onSelect(planId);
    onPreferenceChange?.(convenienceWeightForPlanId(plans, planId));
  }

  const routesByPlan = new Map(travel?.routes.map((route) => [route.planId, route]) ?? []);
  const explanationsByPlan = new Map(
    planDeltaExplanations.entries.map((entry) => [entry.planId, entry]),
  );
  const offersById = new Map(officialOffers.map((offer) => [offer.id, offer]));
  const selectedExplanation = explanationsByPlan.get(plans[selectedIndex]!.id);
  if (selectedExplanation === undefined) return null;
  const selectedName = selectedExplanation.presentation.label;
  const selectedRoute = routesByPlan.get(plans[selectedIndex]!.id);
  const selectedMembershipCopy = membershipCopyForPlan(
    plans[selectedIndex]!,
    offersById,
  );

  return (
    <fieldset className="plan-selector">
      <legend>Valgmuligheter</legend>
      <div className="plan-preference-slider">
        <label htmlFor="plan-preference">Velg komplett plan</label>
        <input
          id="plan-preference"
          type="range"
          min={0}
          max={Math.max(0, plans.length - 1)}
          step={1}
          value={selectedIndex}
          disabled={plans.length <= 1}
          aria-valuetext={`${selectedName}, ${formatNok(plans[selectedIndex]!.totalOre)}${selectedRoute === undefined ? "" : `, estimert reisetid ${formatTravelDuration(selectedRoute.aggregate.durationSeconds)}`}${selectedMembershipCopy === undefined ? "" : `, ${selectedMembershipCopy}`}`}
          onKeyDown={(event) => {
            let nextIndex: number | undefined;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = plans.length - 1;
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              nextIndex = Math.max(0, selectedIndex - 1);
            }
            if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              nextIndex = Math.min(plans.length - 1, selectedIndex + 1);
            }
            const plan = nextIndex === undefined ? undefined : plans[nextIndex];
            if (plan !== undefined) {
              event.preventDefault();
              select(plan.id);
            }
          }}
          onChange={(event) => {
            const plan = plans[Number(event.currentTarget.value)];
            if (plan !== undefined) select(plan.id);
          }}
        />
        <small>Velg bare mellom faktiske, komplette handleplaner.</small>
      </div>
      <div className="plan-option-list">
        <span className="plan-connector" aria-hidden="true" />
        {plans.map((plan) => {
          const selected = plan.id === selectedPlanId;
          const stores = `${plan.chains.length} ${plan.chains.length === 1 ? "butikk" : "butikker"}`;
          const explanation = explanationsByPlan.get(plan.id);
          if (explanation === undefined) return null;
          const name = explanation.presentation.label;
          const membershipCopy = membershipCopyForPlan(plan, offersById);
          const accessibleName = `${name}, ${formatNok(plan.totalOre)}, ${explanation.price.message}, ${stores}, ${plan.chains.map((chain) => CHAIN_NAMES[chain]).join(" og ")}${membershipCopy === undefined ? "" : `, ${membershipCopy}`}`;
          const route = routesByPlan.get(plan.id);
          const routeSummary = route === undefined
            ? undefined
            : `Estimert reisetid: ${formatTravelDuration(route.aggregate.durationSeconds)} · ${formatTravelDistance(route.aggregate.distanceMeters)} · ${route.stops.length} stopp`;
          return (
            <label className={`plan-option${selected ? " selected" : ""}`} key={plan.id}>
              <input
                type="radio"
                name="handleplan"
                value={plan.id}
                checked={selected}
                aria-label={`${accessibleName}${routeSummary === undefined ? "" : `, ${routeSummary}`}`}
                onChange={() => select(plan.id)}
              />
              <span className="plan-option-copy">
                <span className="plan-option-heading">
                  <strong>{name}</strong>
                  <span>{formatNok(plan.totalOre)}</span>
                </span>
                <span>{plan.chains.map((chain) => CHAIN_NAMES[chain]).join(" + ")}</span>
                <small>{stores} · {plan.substitutions.length === 0 ? "Ingen bytter" : `${plan.substitutions.length} godkjente bytter`}</small>
                {routeSummary === undefined ? null : <small>{routeSummary}</small>}
                {membershipCopy === undefined ? null : <small>{membershipCopy}</small>}
                {explanation.travel === undefined ? null : (
                  <small className="plan-travel-delta">
                    {explanation.travel.message}
                  </small>
                )}
                <small className="plan-price-delta">{explanation.price.message}</small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
