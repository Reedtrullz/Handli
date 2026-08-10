import { basisPointsSchema, isFiniteDate } from "./contract-primitives";
import {
  DISCOVERY_IMPACT_ACTION_MAX,
  DISCOVERY_IMPACT_PRODUCT_UNION_MAX,
  discoveryImpactActionV1Schema,
  type DiscoveryImpactActionV1,
} from "./discovery-impact-contracts";
import { projectRepresentativesV2, paretoFrontierV2 } from "./frontier-v2";
import { matchProducts } from "./matching";
import { enumerateCompletePlanCandidatesV2 } from "./planner-v2";
import {
  serverPlanningInputV2Schema,
  type PlanResultV2,
  type PlanningNeedV2,
  type PlanningProductV2,
  type ServerPlanningInputV2,
} from "./planner-v2-contracts";
import type { MatchRule, Need, Product } from "./contracts";

export type DiscoveryImpactMutationIneligibleReason =
  | "unknown-product"
  | "unknown-need"
  | "basket-limit"
  | "already-present"
  | "already-exact"
  | "not-lockable-need"
  | "not-reviewed-family-candidate";

export type CompiledDiscoveryImpactMutationV1 =
  | {
      planning: ServerPlanningInputV2;
      state: "compiled";
    }
  | {
      reason: DiscoveryImpactMutationIneligibleReason;
      state: "ineligible";
    };

export interface CompileDiscoveryImpactMutationV1Input {
  action: DiscoveryImpactActionV1;
  baselineCandidateSets: readonly DiscoveryImpactBaselineCandidateSetV1[];
  planning: ServerPlanningInputV2;
  sequence?: number;
}

export interface DiscoveryImpactBaselineCandidateSetV1 {
  candidateGtins: readonly string[];
  needId: string;
}

export interface DiscoveryImpactPlannerEvaluationV1 {
  plans: PlanResultV2[];
  selectedPlan?: PlanResultV2;
}

export type DiscoveryImpactPlannerOutcomeV1 =
  | {
      actionId: string;
      actionKind: DiscoveryImpactActionV1["kind"];
      planning: ServerPlanningInputV2;
      plans: PlanResultV2[];
      selectedPlan?: PlanResultV2;
      state: "compiled";
    }
  | {
      actionId: string;
      actionKind: DiscoveryImpactActionV1["kind"];
      reason: DiscoveryImpactMutationIneligibleReason;
      state: "ineligible";
    };

export interface CalculateDiscoveryImpactBatchV1Input {
  actions: readonly DiscoveryImpactActionV1[];
  baselineCandidateSets: readonly DiscoveryImpactBaselineCandidateSetV1[];
  convenienceWeightBasisPoints: number;
  evaluatedAt: Date;
  planning: ServerPlanningInputV2;
}

export interface DiscoveryImpactPlannerBatchV1 {
  baseline: DiscoveryImpactPlannerEvaluationV1;
  evaluatedProductCount: number;
  outcomes: DiscoveryImpactPlannerOutcomeV1[];
}

function toLegacyNeed(need: PlanningNeedV2): Need {
  return {
    id: need.id,
    matchRuleId: need.matchRuleId,
    query: need.query,
    quantity: need.requested.amount,
    quantityUnit:
      need.requested.unit === "g" || need.requested.unit === "ml"
        ? need.requested.unit
        : "each",
    required: true,
  };
}

function toLegacyProduct(product: PlanningProductV2): Product {
  return {
    ...(product.brand === undefined ? {} : { brand: product.brand }),
    ean: product.ean,
    name: product.name,
    packageQuantity: product.packageMeasure.amount,
    packageUnit:
      product.packageMeasure.unit === "g"
        || product.packageMeasure.unit === "ml"
        ? product.packageMeasure.unit
        : "each",
    ...(product.productFamily === undefined
      ? {}
      : { productFamily: product.productFamily }),
  };
}

function referencedExactEans(planning: ServerPlanningInputV2): Set<string> {
  const rules = new Map(planning.matchingRules.map((rule) => [rule.id, rule]));
  return new Set(planning.needs.flatMap((need) => {
    const rule = rules.get(need.matchRuleId);
    return rule?.mode === "exact" && rule.exactEan !== undefined
      ? [rule.exactEan]
      : [];
  }));
}

function uniqueIdentifier(base: string, occupied: ReadonlySet<string>): string {
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

function exactRule(
  action: DiscoveryImpactActionV1,
  id: string,
): MatchRule {
  const explanation = action.kind === "add"
    ? "Eksakt vare lagt til etter uttrykkelig godkjenning."
    : action.kind === "replace"
      ? "Eksakt vare erstattet etter uttrykkelig godkjenning."
      : "Eksakt vare låst etter uttrykkelig godkjenning.";
  return {
    exactEan: action.product.value,
    explanation,
    id,
    mode: "exact",
    userApproved: true,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validatedBaselineCandidateSets(
  planning: ServerPlanningInputV2,
  input: readonly DiscoveryImpactBaselineCandidateSetV1[],
): Map<string, ReadonlySet<string>> | undefined {
  if (!Array.isArray(input) || input.length !== planning.needs.length) {
    return undefined;
  }
  const candidateSets = new Map<string, ReadonlySet<string>>();
  const productGtins = new Set(planning.products.map(({ ean }) => ean));
  const rules = new Map(planning.matchingRules.map((rule) => [rule.id, rule]));
  for (const entry of input) {
    if (
      entry === null
      || typeof entry !== "object"
      || typeof entry.needId !== "string"
      || !Array.isArray(entry.candidateGtins)
      || entry.candidateGtins.length < 1
      || entry.candidateGtins.length > DISCOVERY_IMPACT_PRODUCT_UNION_MAX
      || new Set(entry.candidateGtins).size !== entry.candidateGtins.length
      || entry.candidateGtins.some((gtin: string) =>
        typeof gtin !== "string" || !productGtins.has(gtin))
      || candidateSets.has(entry.needId)
    ) {
      return undefined;
    }
    candidateSets.set(entry.needId, new Set(entry.candidateGtins));
  }
  if (planning.needs.some(({ id }) => !candidateSets.has(id))) return undefined;

  for (const need of planning.needs) {
    const rule = rules.get(need.matchRuleId);
    const declared = candidateSets.get(need.id);
    if (rule === undefined || declared === undefined) return undefined;
    const matched = matchProducts(
      toLegacyNeed(need),
      rule,
      planning.products.map(toLegacyProduct),
    ).map(({ ean }) => ean).sort();
    const expected = [...declared].sort();
    if (!sameStrings(matched, expected)) return undefined;
  }
  return candidateSets;
}

function compileAdd(
  planning: ServerPlanningInputV2,
  action: Extract<DiscoveryImpactActionV1, { kind: "add" }>,
  product: PlanningProductV2,
  sequence: number,
): CompiledDiscoveryImpactMutationV1 {
  if (planning.needs.length >= 50) {
    return { reason: "basket-limit", state: "ineligible" };
  }
  if (referencedExactEans(planning).has(product.ean)) {
    return { reason: "already-present", state: "ineligible" };
  }

  const needIds = new Set(planning.needs.map(({ id }) => id));
  const ruleIds = new Set(planning.matchingRules.map(({ id }) => id));
  const needId = uniqueIdentifier(`impact:${sequence + 1}:add:need`, needIds);
  const ruleId = uniqueIdentifier(`impact:${sequence + 1}:add:rule`, ruleIds);
  const candidate = {
    ...planning,
    matchingRules: [
      ...planning.matchingRules,
      exactRule(action, ruleId),
    ],
    needs: [
      ...planning.needs,
      {
        id: needId,
        matchRuleId: ruleId,
        query: product.name,
        requested: { amount: 1, unit: "package" as const },
        required: true as const,
      },
    ],
  };
  const parsed = serverPlanningInputV2Schema.safeParse(candidate);
  return parsed.success
    ? { planning: parsed.data, state: "compiled" }
    : { reason: "basket-limit", state: "ineligible" };
}

function compileTargeted(
  planning: ServerPlanningInputV2,
  action: Extract<DiscoveryImpactActionV1, { kind: "replace" | "lock" }>,
  baselineCandidateGtins: ReadonlyMap<string, ReadonlySet<string>>,
  product: PlanningProductV2,
  sequence: number,
): CompiledDiscoveryImpactMutationV1 {
  const target = planning.needs.find(({ id }) => id === action.needId);
  if (target === undefined) {
    return { reason: "unknown-need", state: "ineligible" };
  }
  const oldRule = planning.matchingRules.find(({ id }) => id === target.matchRuleId);
  if (oldRule === undefined) {
    return { reason: "unknown-need", state: "ineligible" };
  }
  if (oldRule.mode === "exact" && oldRule.exactEan === product.ean) {
    return { reason: "already-exact", state: "ineligible" };
  }
  if (action.kind === "lock") {
    if (oldRule.mode === "exact") {
      return { reason: "not-lockable-need", state: "ineligible" };
    }
    if (baselineCandidateGtins.get(target.id)?.has(product.ean) !== true) {
      return {
        reason: "not-reviewed-family-candidate",
        state: "ineligible",
      };
    }
  }

  const ruleIds = new Set(planning.matchingRules.map(({ id }) => id));
  const ruleId = uniqueIdentifier(
    `impact:${sequence + 1}:${action.kind}:rule`,
    ruleIds,
  );
  const needs = planning.needs.map((need) => need.id === target.id
    ? { ...need, matchRuleId: ruleId }
    : need);
  const stillReferencedRuleIds = new Set(needs.map(({ matchRuleId }) => matchRuleId));
  const matchingRules = [
    ...planning.matchingRules.filter(({ id }) =>
      id !== oldRule.id || stillReferencedRuleIds.has(id)),
    exactRule(action, ruleId),
  ];
  const parsed = serverPlanningInputV2Schema.safeParse({
    ...planning,
    matchingRules,
    needs,
  });
  return parsed.success
    ? { planning: parsed.data, state: "compiled" }
    : { reason: "basket-limit", state: "ineligible" };
}

/**
 * Compiles one approved action against an immutable, server-resolved planning
 * universe. The universe must already contain every reviewed candidate and
 * visible action product; this function performs no reads and mutates exactly
 * one semantic need (or appends one need for `add`).
 */
export function compileDiscoveryImpactMutationV1(
  input: CompileDiscoveryImpactMutationV1Input,
): CompiledDiscoveryImpactMutationV1 | undefined {
  const parsedPlanning = serverPlanningInputV2Schema.safeParse(input.planning);
  const parsedAction = discoveryImpactActionV1Schema.safeParse(input.action);
  const sequence = input.sequence ?? 0;
  if (
    !parsedPlanning.success
    || !parsedAction.success
    || parsedPlanning.data.products.length > DISCOVERY_IMPACT_PRODUCT_UNION_MAX
    || !Number.isSafeInteger(sequence)
    || sequence < 0
    || sequence >= DISCOVERY_IMPACT_ACTION_MAX
  ) {
    return undefined;
  }

  const planning = parsedPlanning.data;
  const baselineCandidateGtins = validatedBaselineCandidateSets(
    planning,
    input.baselineCandidateSets,
  );
  if (baselineCandidateGtins === undefined) return undefined;
  const action = parsedAction.data;
  const product = planning.products.find(({ ean }) => ean === action.product.value);
  if (product === undefined) {
    return { reason: "unknown-product", state: "ineligible" };
  }
  return action.kind === "add"
    ? compileAdd(planning, action, product, sequence)
    : compileTargeted(
        planning,
        action,
        baselineCandidateGtins,
        product,
        sequence,
      );
}

export function selectDiscoveryImpactPlanV1(
  plans: readonly PlanResultV2[],
  convenienceWeightBasisPoints: number,
): PlanResultV2 | undefined {
  const parsedPreference = basisPointsSchema.safeParse(
    convenienceWeightBasisPoints,
  );
  if (!parsedPreference.success || plans.length === 0) return undefined;
  if (plans.length === 1) return plans[0];
  const index = Math.floor(
    ((10_000 - parsedPreference.data) / 10_000) * (plans.length - 1),
  );
  return plans[index];
}

function evaluate(
  planning: ServerPlanningInputV2,
  evaluatedAt: Date,
  convenienceWeightBasisPoints: number,
): DiscoveryImpactPlannerEvaluationV1 {
  const plans = projectRepresentativesV2(
    paretoFrontierV2(
      enumerateCompletePlanCandidatesV2(planning, evaluatedAt),
    ),
    7,
  );
  const selectedPlan = selectDiscoveryImpactPlanV1(
    plans,
    convenienceWeightBasisPoints,
  );
  return {
    plans,
    ...(selectedPlan === undefined ? {} : { selectedPlan }),
  };
}

/**
 * Evaluates the baseline and all bounded single-action variants from the same
 * resolved product/price universe and captured instant. No variant can widen
 * the universe or introduce a fourth store.
 */
export function calculateDiscoveryImpactBatchV1(
  input: CalculateDiscoveryImpactBatchV1Input,
): DiscoveryImpactPlannerBatchV1 | undefined {
  const parsedPlanning = serverPlanningInputV2Schema.safeParse(input.planning);
  const parsedPreference = basisPointsSchema.safeParse(
    input.convenienceWeightBasisPoints,
  );
  if (
    !parsedPlanning.success
    || !parsedPreference.success
    || !(input.evaluatedAt instanceof Date)
    || !isFiniteDate(input.evaluatedAt)
    || !Array.isArray(input.actions)
    || input.actions.length < 1
    || input.actions.length > DISCOVERY_IMPACT_ACTION_MAX
    || parsedPlanning.data.products.length > DISCOVERY_IMPACT_PRODUCT_UNION_MAX
  ) {
    return undefined;
  }
  const actions: DiscoveryImpactActionV1[] = [];
  for (const action of input.actions) {
    const parsedAction = discoveryImpactActionV1Schema.safeParse(action);
    if (!parsedAction.success) return undefined;
    actions.push(parsedAction.data);
  }
  if (new Set(actions.map(({ actionId }) => actionId)).size !== actions.length) {
    return undefined;
  }
  const mutationIdentities = actions.map((action) => [
    action.kind,
    action.kind === "add" ? "" : action.needId,
    action.product.value,
  ].join("\u0000"));
  if (new Set(mutationIdentities).size !== mutationIdentities.length) {
    return undefined;
  }

  const planning = parsedPlanning.data;
  if (
    validatedBaselineCandidateSets(planning, input.baselineCandidateSets)
    === undefined
  ) {
    return undefined;
  }
  const baseline = evaluate(
    planning,
    input.evaluatedAt,
    parsedPreference.data,
  );
  const outcomes: DiscoveryImpactPlannerOutcomeV1[] = [];
  for (const [sequence, action] of actions.entries()) {
    const compiled = compileDiscoveryImpactMutationV1({
      action,
      baselineCandidateSets: input.baselineCandidateSets,
      planning,
      sequence,
    });
    if (compiled === undefined) return undefined;
    if (compiled.state === "ineligible") {
      outcomes.push({
        actionId: action.actionId,
        actionKind: action.kind,
        reason: compiled.reason,
        state: "ineligible",
      });
      continue;
    }
    const evaluation = evaluate(
      compiled.planning,
      input.evaluatedAt,
      parsedPreference.data,
    );
    outcomes.push({
      actionId: action.actionId,
      actionKind: action.kind,
      planning: compiled.planning,
      plans: evaluation.plans,
      ...(evaluation.selectedPlan === undefined
        ? {}
        : { selectedPlan: evaluation.selectedPlan }),
      state: "compiled",
    });
  }

  return {
    baseline,
    evaluatedProductCount: planning.products.length,
    outcomes,
  };
}
