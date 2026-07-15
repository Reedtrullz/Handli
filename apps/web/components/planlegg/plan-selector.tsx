"use client";

import { formatNok, type PlanResult } from "@handleplan/domain";

interface PlanSelectorProps {
  plans: PlanResult[];
  selectedPlanId: string;
  onSelect: (planId: string) => void;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareConvenience(left: PlanResult, right: PlanResult): number {
  return (
    left.chains.length - right.chains.length ||
    left.totalOre - right.totalOre ||
    left.substitutions.length - right.substitutions.length ||
    compareText(left.id, right.id)
  );
}

export function compareSavings(left: PlanResult, right: PlanResult): number {
  return (
    left.totalOre - right.totalOre ||
    left.substitutions.length - right.substitutions.length ||
    left.chains.length - right.chains.length ||
    compareText(left.id, right.id)
  );
}

function compareMiddle(left: PlanResult, right: PlanResult): number {
  return (
    left.chains.length - right.chains.length ||
    right.totalOre - left.totalOre ||
    left.substitutions.length - right.substitutions.length ||
    compareText(left.id, right.id)
  );
}

export function orderPlanFrontier(plans: readonly PlanResult[]): PlanResult[] {
  if (plans.length < 2) return [...plans];
  const stable = [...plans].sort(compareMiddle);
  const convenience = [...stable].sort(compareConvenience)[0]!;
  const savings = [...stable].sort(compareSavings)[0]!;

  if (convenience.id === savings.id) return stable;
  const middle = stable.filter(({ id }) => id !== convenience.id && id !== savings.id);
  return [convenience, ...middle, savings];
}

export function balancedPlanId(plans: readonly PlanResult[]): string | undefined {
  const ordered = orderPlanFrontier(plans);
  return ordered[Math.floor((ordered.length - 1) / 2)]?.id;
}

function equalObjective(plans: readonly PlanResult[]): boolean {
  const first = plans[0];
  return first !== undefined && plans.every(
    (plan) =>
      plan.totalOre === first.totalOre &&
      plan.chains.length === first.chains.length &&
      plan.substitutions.length === first.substitutions.length,
  );
}

function planName(index: number, plans: readonly PlanResult[]): string {
  if (plans.length === 1) return "Eneste komplette plan";
  if (equalObjective(plans)) return `Likeverdig alternativ ${index + 1}`;
  if (index === 0) return "Enklest";
  if (index === plans.length - 1) {
    return plans[index]!.totalOre < plans[0]!.totalOre ? "Mest spart" : "Annet kompromiss";
  }
  if (index === Math.floor((plans.length - 1) / 2)) return "Balansert";
  return `Alternativ ${index + 1}`;
}

const CHAIN_NAMES: Record<PlanResult["chains"][number], string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

export function PlanSelector({ plans, selectedPlanId, onSelect }: PlanSelectorProps) {
  const ordered = orderPlanFrontier(plans);

  return (
    <fieldset className="plan-selector">
      <legend>Valgmuligheter</legend>
      <div className="plan-option-list">
        <span className="plan-connector" aria-hidden="true" />
        {ordered.map((plan, index) => {
          const name = planName(index, ordered);
          const selected = plan.id === selectedPlanId;
          const stores = `${plan.chains.length} ${plan.chains.length === 1 ? "butikk" : "butikker"}`;
          const accessibleName = `${name}, ${formatNok(plan.totalOre)}, ${stores}, ${plan.chains.map((chain) => CHAIN_NAMES[chain]).join(" og ")}`;
          return (
            <label className={`plan-option${selected ? " selected" : ""}`} key={plan.id}>
              <input
                type="radio"
                name="handleplan"
                value={plan.id}
                checked={selected}
                aria-label={accessibleName}
                onChange={() => onSelect(plan.id)}
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
