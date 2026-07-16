"use client";

import { formatNok, type PlanResultV2 } from "@handleplan/domain";

interface PlanSelectorProps {
  plans: readonly PlanResultV2[];
  selectedPlanId: string;
  onSelect: (planId: string) => void;
  onPreferenceChange?: (convenienceWeightBasisPoints: number) => void;
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

function equalObjective(plans: readonly PlanResultV2[]): boolean {
  const first = plans[0];
  return first !== undefined && plans.every(
    (plan) =>
      plan.totalOre === first.totalOre &&
      plan.chains.length === first.chains.length &&
      plan.substitutions.length === first.substitutions.length,
  );
}

function planName(index: number, plans: readonly PlanResultV2[]): string {
  if (plans.length === 1) return "Eneste komplette plan";
  if (equalObjective(plans)) return `Likeverdig alternativ ${index + 1}`;
  if (index === 0) return "Enklest";
  if (index === plans.length - 1) {
    return "Mest spart";
  }
  if (index === Math.floor((plans.length - 1) / 2)) return "Balansert";
  return `Alternativ ${index + 1}`;
}

const CHAIN_NAMES: Record<PlanResultV2["chains"][number], string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

export function PlanSelector({
  plans,
  selectedPlanId,
  onSelect,
  onPreferenceChange,
}: PlanSelectorProps) {
  if (plans.length === 0) return null;
  const convenience = plans[0]!;
  const selectedIndex = Math.max(0, plans.findIndex(({ id }) => id === selectedPlanId));

  function select(planId: string): void {
    onSelect(planId);
    onPreferenceChange?.(convenienceWeightForPlanId(plans, planId));
  }

  const selectedName = planName(selectedIndex, plans);

  return (
    <fieldset className="plan-selector">
      <legend>Valgmuligheter</legend>
      <div className="plan-preference-slider">
        <label htmlFor="plan-preference">Enklest <span aria-hidden="true">↔</span> mest spart</label>
        <input
          id="plan-preference"
          type="range"
          min={0}
          max={Math.max(0, plans.length - 1)}
          step={1}
          value={selectedIndex}
          disabled={plans.length <= 1}
          aria-valuetext={`${selectedName}, ${formatNok(plans[selectedIndex]!.totalOre)}`}
          onChange={(event) => {
            const plan = plans[Number(event.currentTarget.value)];
            if (plan !== undefined) select(plan.id);
          }}
        />
        <small>Velg bare mellom faktiske, komplette handleplaner.</small>
      </div>
      <div className="plan-option-list">
        <span className="plan-connector" aria-hidden="true" />
        {plans.map((plan, index) => {
          const name = planName(index, plans);
          const selected = plan.id === selectedPlanId;
          const stores = `${plan.chains.length} ${plan.chains.length === 1 ? "butikk" : "butikker"}`;
          const difference = plan.totalOre - convenience.totalOre;
          const comparison = difference === 0
            ? "samme pris"
            : difference > 0
              ? `${formatNok(difference)} dyrere`
              : `${formatNok(-difference)} spart`;
          const accessibleName = `${name}, ${formatNok(plan.totalOre)}, ${comparison}, ${stores}, ${plan.chains.map((chain) => CHAIN_NAMES[chain]).join(" og ")}`;
          return (
            <label className={`plan-option${selected ? " selected" : ""}`} key={plan.id}>
              <input
                type="radio"
                name="handleplan"
                value={plan.id}
                checked={selected}
                aria-label={accessibleName}
                onChange={() => select(plan.id)}
              />
              <span className="plan-option-copy">
                <span className="plan-option-heading">
                  <strong>{name}</strong>
                  <span>{formatNok(plan.totalOre)}</span>
                </span>
                <span>{plan.chains.map((chain) => CHAIN_NAMES[chain]).join(" + ")}</span>
                <small>{stores} · {plan.substitutions.length === 0 ? "Ingen bytter" : `${plan.substitutions.length} godkjente bytter`}</small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
