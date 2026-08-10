import { z } from "zod";

import { gtinSchema } from "./catalog";
import {
  basisPointsSchema,
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";
import { marketContextsEqual, marketContextV1Schema } from "./market-context";
import { enabledMembershipProgramIdsSchema } from "./offers";
import {
  exactProductPlanApiRequestSchema,
  type ExactProductPlanApiRequest,
} from "./plan-api-contracts";
import {
  reviewedFamilyPlanApiRequestV2Schema,
  type ReviewedFamilyPlanApiRequestV2,
} from "./reviewed-family-plan-api-contracts";

export const DISCOVERY_IMPACT_ACTION_MAX = 8;
export const DISCOVERY_IMPACT_PRODUCT_UNION_MAX = 50;

const actionProductSchema = z
  .object({
    kind: z.literal("gtin"),
    value: gtinSchema,
  })
  .strict();

const actionBaseShape = {
  actionId: identifierSchema,
  product: actionProductSchema,
  userApproved: z.literal(true),
};

const addActionSchema = z
  .object({
    ...actionBaseShape,
    kind: z.literal("add"),
  })
  .strict();

const replaceActionSchema = z
  .object({
    ...actionBaseShape,
    kind: z.literal("replace"),
    needId: identifierSchema,
  })
  .strict();

const lockActionSchema = z
  .object({
    ...actionBaseShape,
    kind: z.literal("lock"),
    needId: identifierSchema,
  })
  .strict();

export const discoveryImpactActionV1Schema = z.discriminatedUnion("kind", [
  addActionSchema,
  replaceActionSchema,
  lockActionSchema,
]);

export type DiscoveryImpactActionV1 = z.infer<
  typeof discoveryImpactActionV1Schema
>;

export const discoveryImpactPlanningRequestSchema = z.union([
  exactProductPlanApiRequestSchema,
  reviewedFamilyPlanApiRequestV2Schema,
]);

export type DiscoveryImpactPlanningRequest =
  | ExactProductPlanApiRequest
  | ReviewedFamilyPlanApiRequestV2;

function actionIdentity(action: DiscoveryImpactActionV1): string {
  return [
    action.kind,
    action.kind === "add" ? "" : action.needId,
    action.product.value,
  ].join("\u0000");
}

export const discoveryImpactRequestV1Schema = z
  .object({
    actions: z
      .array(discoveryImpactActionV1Schema)
      .min(1)
      .max(DISCOVERY_IMPACT_ACTION_MAX),
    contractVersion: contractVersionSchema,
    convenienceWeightBasisPoints: basisPointsSchema,
    planning: discoveryImpactPlanningRequestSchema,
  })
  .strict()
  .superRefine(({ actions, planning }, context) => {
    if (!hasUniqueStrings(actions.map(({ actionId }) => actionId))) {
      context.addIssue({
        code: "custom",
        message: "Discovery impact action IDs must be unique",
        path: ["actions"],
      });
    }
    if (!hasUniqueStrings(actions.map(actionIdentity))) {
      context.addIssue({
        code: "custom",
        message: "Discovery impact actions must be unique",
        path: ["actions"],
      });
    }

    const needsById = new Map(planning.needs.map((need) => [need.id, need]));
    actions.forEach((action, index) => {
      if (action.kind === "add") return;
      const target = needsById.get(action.needId);
      if (target === undefined) {
        context.addIssue({
          code: "custom",
          message: "Replace and lock actions must target a requested need",
          path: ["actions", index, "needId"],
        });
        return;
      }
      if (action.kind === "lock" && target.match.kind !== "reviewed-family") {
        context.addIssue({
          code: "custom",
          message: "Lock actions must target a reviewed-family need",
          path: ["actions", index, "needId"],
        });
      }
    });

    if (
      planning.needs.length >= 50
      && actions.some(({ kind }) => kind === "add")
    ) {
      context.addIssue({
        code: "custom",
        message: "Adding one item must keep each impact variant within fifty needs",
        path: ["actions"],
      });
    }

    // Reviewed-family candidate GTINs are server-rehydrated and therefore
    // cannot be counted at this public boundary. Their resolved expansion is
    // capped again by the compiled planner helper.
    const requestVisibleGtins = new Set<string>();
    for (const need of planning.needs) {
      if (need.match.kind === "exact-product") {
        requestVisibleGtins.add(need.match.product.value);
      }
    }
    for (const action of actions) requestVisibleGtins.add(action.product.value);
    if (requestVisibleGtins.size > DISCOVERY_IMPACT_PRODUCT_UNION_MAX) {
      context.addIssue({
        code: "custom",
        message: "Discovery impact exact/action product union exceeds fifty GTINs",
        path: ["actions"],
      });
    }
  });

export type DiscoveryImpactRequestV1 = z.infer<
  typeof discoveryImpactRequestV1Schema
>;

const chainSchema = z.enum(["bunnpris", "extra", "rema-1000"]);
const storeCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const discoveryImpactPlanSummaryV1Schema = z
  .object({
    appliedOfficialOfferIds: z.array(identifierSchema).max(50),
    chains: z.array(chainSchema).min(1).max(3),
    comparisonCoverage: z.enum(["complete", "partial"]),
    requiredMembershipProgramIds: enabledMembershipProgramIdsSchema,
    storeCount: storeCountSchema,
    substitutionCount: nonNegativeSafeIntegerSchema.max(50),
    totalOre: moneyOreSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (!hasUniqueStrings(summary.chains)) {
      context.addIssue({
        code: "custom",
        message: "Impact summary chains must be unique",
        path: ["chains"],
      });
    }
    if (summary.storeCount !== summary.chains.length) {
      context.addIssue({
        code: "custom",
        message: "Impact store count must equal the number of plan chains",
        path: ["storeCount"],
      });
    }
    if (!hasUniqueStrings(summary.appliedOfficialOfferIds)) {
      context.addIssue({
        code: "custom",
        message: "Applied official-offer IDs must be unique",
        path: ["appliedOfficialOfferIds"],
      });
    }
  });

export type DiscoveryImpactPlanSummaryV1 = z.infer<
  typeof discoveryImpactPlanSummaryV1Schema
>;

const baselineSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("complete"),
      plan: discoveryImpactPlanSummaryV1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("incomplete"),
      reason: z.literal("no-complete-plan"),
    })
    .strict(),
]);

const signedSafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

const comparableComparisonSchema = z
  .object({
    basis: z.enum(["different-basket", "same-need"]),
    chainsAdded: z.array(chainSchema).max(3),
    chainsRemoved: z.array(chainSchema).max(3),
    checkoutTotalDeltaOre: signedSafeIntegerSchema,
    claimScope: z.enum([
      "declared-complete-coverage",
      "among-verified-prices",
    ]),
    kind: z.literal("comparable"),
    storeCountDelta: z.number().int().min(-2).max(2),
    substitutionCountDelta: z.number().int().min(-50).max(50),
  })
  .strict()
  .superRefine((comparison, context) => {
    if (
      !hasUniqueStrings(comparison.chainsAdded)
      || !hasUniqueStrings(comparison.chainsRemoved)
    ) {
      context.addIssue({
        code: "custom",
        message: "Impact chain changes must be unique",
        path: ["chainsAdded"],
      });
    }
    const removed = new Set(comparison.chainsRemoved);
    if (comparison.chainsAdded.some((chain) => removed.has(chain))) {
      context.addIssue({
        code: "custom",
        message: "A chain cannot be both added and removed",
        path: ["chainsAdded"],
      });
    }
  });

const unavailableComparisonSchema = z
  .object({
    kind: z.literal("unavailable"),
    reason: z.literal("baseline-incomplete"),
  })
  .strict();

const actionKindSchema = z.enum(["add", "replace", "lock"]);

const outcomeActionShape = {
  action: discoveryImpactActionV1Schema,
  actionId: identifierSchema,
  actionKind: actionKindSchema,
};

const completeOutcomeSchema = z
  .object({
    ...outcomeActionShape,
    comparison: z.union([
      comparableComparisonSchema,
      unavailableComparisonSchema,
    ]),
    plan: discoveryImpactPlanSummaryV1Schema,
    state: z.literal("complete"),
  })
  .strict();

const incompleteOutcomeSchema = z
  .object({
    ...outcomeActionShape,
    reason: z.literal("no-complete-plan"),
    state: z.literal("incomplete"),
  })
  .strict();

const ineligibleOutcomeSchema = z
  .object({
    ...outcomeActionShape,
    reason: z.enum([
      "unknown-product",
      "unknown-need",
      "basket-limit",
      "already-present",
      "already-exact",
      "not-lockable-need",
      "not-reviewed-family-candidate",
    ]),
    state: z.literal("ineligible"),
  })
  .strict();

export const discoveryImpactOutcomeV1Schema = z.discriminatedUnion("state", [
  completeOutcomeSchema,
  incompleteOutcomeSchema,
  ineligibleOutcomeSchema,
]);

export type DiscoveryImpactOutcomeV1 = z.infer<
  typeof discoveryImpactOutcomeV1Schema
>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function expectedDifference(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function sameActionIdentity(
  left: DiscoveryImpactActionV1,
  right: DiscoveryImpactActionV1,
): boolean {
  return left.actionId === right.actionId
    && left.kind === right.kind
    && left.product.kind === right.product.kind
    && left.product.value === right.product.value
    && left.userApproved === right.userApproved
    && (
      left.kind === "add"
        ? right.kind === "add"
        : right.kind !== "add" && left.needId === right.needId
    );
}

export const discoveryImpactResponseV1Schema = z
  .object({
    baseline: baselineSchema,
    contractVersion: contractVersionSchema,
    evaluatedAt: canonicalTimestampSchema,
    evaluatedProductCount: nonNegativeSafeIntegerSchema.max(
      DISCOVERY_IMPACT_PRODUCT_UNION_MAX,
    ),
    marketContext: marketContextV1Schema,
    outcomes: z
      .array(discoveryImpactOutcomeV1Schema)
      .min(1)
      .max(DISCOVERY_IMPACT_ACTION_MAX),
    travelImpact: z
      .object({
        kind: z.literal("omitted"),
        reason: z.literal("origin-not-retained"),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, context) => {
    if (!hasUniqueStrings(response.outcomes.map(({ actionId }) => actionId))) {
      context.addIssue({
        code: "custom",
        message: "Discovery impact outcomes must have unique action IDs",
        path: ["outcomes"],
      });
    }
    response.outcomes.forEach((outcome, index) => {
      if (
        outcome.action.actionId !== outcome.actionId
        || outcome.action.kind !== outcome.actionKind
      ) {
        context.addIssue({
          code: "custom",
          message: "Impact outcome labels must match the echoed full action identity",
          path: ["outcomes", index, "action"],
        });
      }
    });
    if (
      response.evaluatedProductCount === 0
      && (
        response.baseline.kind === "complete"
        || response.outcomes.some(({ state }) => state === "complete")
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "A complete impact plan requires an evaluated product universe",
        path: ["evaluatedProductCount"],
      });
    }

    for (const [index, outcome] of response.outcomes.entries()) {
      if (outcome.state !== "complete") continue;
      const comparison = outcome.comparison;
      if (response.baseline.kind === "incomplete") {
        if (comparison.kind !== "unavailable") {
          context.addIssue({
            code: "custom",
            message: "An incomplete baseline cannot produce numeric impact",
            path: ["outcomes", index, "comparison"],
          });
        }
        continue;
      }
      if (comparison.kind !== "comparable") {
        context.addIssue({
          code: "custom",
          message: "Complete baseline and variant must have a comparable impact",
          path: ["outcomes", index, "comparison"],
        });
        continue;
      }

      const baseline = response.baseline.plan;
      const expectedBasis = outcome.actionKind === "add"
        ? "different-basket"
        : "same-need";
      if (comparison.basis !== expectedBasis) {
        context.addIssue({
          code: "custom",
          message: "Impact comparison basis must match its action",
          path: ["outcomes", index, "comparison", "basis"],
        });
      }
      if (
        comparison.checkoutTotalDeltaOre
        !== outcome.plan.totalOre - baseline.totalOre
      ) {
        context.addIssue({
          code: "custom",
          message: "Checkout delta must equal variant total minus baseline total",
          path: ["outcomes", index, "comparison", "checkoutTotalDeltaOre"],
        });
      }
      if (
        comparison.storeCountDelta
        !== outcome.plan.storeCount - baseline.storeCount
      ) {
        context.addIssue({
          code: "custom",
          message: "Store-count delta must match the compared plans",
          path: ["outcomes", index, "comparison", "storeCountDelta"],
        });
      }
      if (
        comparison.substitutionCountDelta
        !== outcome.plan.substitutionCount - baseline.substitutionCount
      ) {
        context.addIssue({
          code: "custom",
          message: "Substitution delta must match the compared plans",
          path: ["outcomes", index, "comparison", "substitutionCountDelta"],
        });
      }
      const added = expectedDifference(outcome.plan.chains, baseline.chains);
      const removed = expectedDifference(baseline.chains, outcome.plan.chains);
      if (!sameStrings(comparison.chainsAdded, added)) {
        context.addIssue({
          code: "custom",
          message: "Added chains must exactly describe the plan change",
          path: ["outcomes", index, "comparison", "chainsAdded"],
        });
      }
      if (!sameStrings(comparison.chainsRemoved, removed)) {
        context.addIssue({
          code: "custom",
          message: "Removed chains must exactly describe the plan change",
          path: ["outcomes", index, "comparison", "chainsRemoved"],
        });
      }
      const expectedScope = baseline.comparisonCoverage === "complete"
        && outcome.plan.comparisonCoverage === "complete"
        ? "declared-complete-coverage"
        : "among-verified-prices";
      if (comparison.claimScope !== expectedScope) {
        context.addIssue({
          code: "custom",
          message: "Impact scope must remain qualified when coverage is partial",
          path: ["outcomes", index, "comparison", "claimScope"],
        });
      }
    }
  });

export type DiscoveryImpactResponseV1 = z.infer<
  typeof discoveryImpactResponseV1Schema
>;

export function discoveryImpactResponseV1SchemaFor(
  request: DiscoveryImpactRequestV1,
) {
  const parsedRequest = discoveryImpactRequestV1Schema.parse(request);
  const baselineExactProductGtins = new Set(
    parsedRequest.planning.needs.flatMap((need) =>
      need.match.kind === "exact-product" ? [need.match.product.value] : []),
  );
  return discoveryImpactResponseV1Schema.superRefine((response, context) => {
    if (!marketContextsEqual(response.marketContext, parsedRequest.planning.marketContext)) {
      context.addIssue({
        code: "custom",
        message: "Impact output must preserve the planning market",
        path: ["marketContext"],
      });
    }
    const requiredEvaluatedGtins = new Set(baselineExactProductGtins);
    for (const [index, action] of parsedRequest.actions.entries()) {
      const outcome = response.outcomes[index];
      if (
        outcome?.state === "ineligible"
        && outcome.reason === "unknown-product"
      ) {
        continue;
      }
      requiredEvaluatedGtins.add(action.product.value);
    }
    if (response.evaluatedProductCount < requiredEvaluatedGtins.size) {
      context.addIssue({
        code: "custom",
        message: "Evaluated product count cannot omit a resolved baseline or action product",
        path: ["evaluatedProductCount"],
      });
    }
    if (
      response.baseline.kind === "complete"
      && response.baseline.plan.storeCount > parsedRequest.planning.maxStores
    ) {
      context.addIssue({
        code: "custom",
        message: "Baseline impact summary exceeds the requested store limit",
        path: ["baseline", "plan", "storeCount"],
      });
    }
    if (response.outcomes.length !== parsedRequest.actions.length) {
      context.addIssue({
        code: "custom",
        message: "Impact response must cover every requested action exactly once",
        path: ["outcomes"],
      });
      return;
    }
    for (const [index, action] of parsedRequest.actions.entries()) {
      const outcome = response.outcomes[index];
      if (
        outcome === undefined
        || outcome.actionId !== action.actionId
        || outcome.actionKind !== action.kind
        || !sameActionIdentity(outcome.action, action)
      ) {
        context.addIssue({
          code: "custom",
          message: "Impact outcomes must preserve request action identity and order",
          path: ["outcomes", index],
        });
      }
      if (
        outcome?.state === "complete"
        && outcome.plan.storeCount > parsedRequest.planning.maxStores
      ) {
        context.addIssue({
          code: "custom",
          message: "Impact variant summary exceeds the requested store limit",
          path: ["outcomes", index, "plan", "storeCount"],
        });
      }
    }
  });
}
