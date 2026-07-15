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

  if (convenience.id === savings.id) {
    const alternatives = stable
      .filter(({ id }) => id !== convenience.id)
      .sort((left, right) =>
        left.substitutions.length - right.substitutions.length ||
        left.totalOre - right.totalOre ||
        left.chains.length - right.chains.length ||
        compareText(left.id, right.id),
      );
    return [convenience, ...alternatives];
  }
  const middle = stable.filter(({ id }) => id !== convenience.id && id !== savings.id);
  return [convenience, ...middle, savings];
}

export function balancedPlanId(plans: readonly PlanResult[]): string | undefined {
  const ordered = orderPlanFrontier(plans);
  if (ordered.length > 1) {
    const convenience = [...ordered].sort(compareConvenience)[0];
    const savings = [...ordered].sort(compareSavings)[0];
    if (convenience?.id === savings?.id) return convenience?.id;
  }
  return ordered[Math.floor((ordered.length - 1) / 2)]?.id;
}

export const FRONTIER_DISPLAY_MAX = 7;

export function projectPlanFrontier(plans: readonly PlanResult[]): PlanResult[] {
  const maximum = FRONTIER_DISPLAY_MAX;
  const ordered = orderPlanFrontier(plans);
  if (ordered.length <= maximum) return ordered;
  const indexes = new Set<number>();

  const convenience = [...ordered].sort(compareConvenience)[0]!;
  const savings = [...ordered].sort(compareSavings)[0]!;
  indexes.add(ordered.findIndex(({ id }) => id === convenience.id));
  indexes.add(ordered.findIndex(({ id }) => id === savings.id));

  const transitions = ordered.flatMap((candidate, index) => {
    const next = ordered[index + 1];
    return next && candidate.chains.length !== next.chains.length ? [[index, index + 1] as const] : [];
  });
  const transitionAdjacency = (index: number) => transitions.reduce(
    (count, pair) => count + (pair.includes(index) ? 1 : 0),
    0,
  );

  const chainCounts = [...new Set(ordered.map(({ chains }) => chains.length))].sort((left, right) => left - right);
  for (const chainCount of chainCounts) {
    if ([...indexes].some((index) => ordered[index]?.chains.length === chainCount)) continue;
    const representative = ordered
      .map((_candidate, index) => index)
      .filter((index) => ordered[index]!.chains.length === chainCount)
      .sort((left, right) => transitionAdjacency(right) - transitionAdjacency(left) || left - right)[0];
    if (representative !== undefined && indexes.size < maximum) indexes.add(representative);
  }

  for (const pair of transitions) {
    const missing = pair.filter((index) => !indexes.has(index));
    if (missing.length <= maximum - indexes.size) missing.forEach((index) => indexes.add(index));
  }
  for (const pair of transitions) {
    for (const index of pair) {
      if (indexes.size < maximum) indexes.add(index);
    }
  }

  while (indexes.size < maximum) {
    const remaining = ordered
      .map((_candidate, index) => index)
      .filter((index) => !indexes.has(index));
    if (remaining.length === 0) break;
    remaining.sort((left, right) => {
      const leftDistance = Math.min(...[...indexes].map((index) => Math.abs(index - left)));
      const rightDistance = Math.min(...[...indexes].map((index) => Math.abs(index - right)));
      return rightDistance - leftDistance || left - right;
    });
    indexes.add(remaining[0]!);
  }
  return [...indexes].sort((left, right) => left - right).map((index) => ordered[index]!);
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
  const convenience = [...plans].sort(compareConvenience)[0]!;
  const savings = [...plans].sort(compareSavings)[0]!;
  if (convenience.id === savings.id && plans[index]?.id === convenience.id) return "Enklest og lavest pris";
  if (convenience.id === savings.id && plans[index]!.substitutions.length < convenience.substitutions.length) return "Færre bytter";
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
  const ordered = projectPlanFrontier(plans);
  const convenience = [...ordered].sort(compareConvenience)[0]!;

  return (
    <fieldset className="plan-selector">
      <legend>Valgmuligheter</legend>
      <div className="plan-option-list">
        <span className="plan-connector" aria-hidden="true" />
        {ordered.map((plan, index) => {
          const name = planName(index, ordered);
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
