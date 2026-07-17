import { z } from "zod";

import { gtinSchema, packageMeasureSchema } from "./catalog";
import {
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import {
  matchRuleSchema,
  moneyOreSchema,
  sourceNeutralPriceObservationSchema,
} from "./contracts";
import { fulfilmentV2Schema } from "./fulfilment";
import {
  geographicContextSchema,
  geographicDirectoryEvidenceSchema,
} from "./geography";
import { officialOfferSchema } from "./offers";

const chainSchema = z.enum(["bunnpris", "rema-1000", "extra"]);
const maxStoresSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const planningNeedV2Schema = z
  .object({
    id: identifierSchema,
    query: nonEmptyStringSchema,
    requested: packageMeasureSchema,
    matchRuleId: identifierSchema,
    required: z.literal(true),
  })
  .strict();

export const planningProductV2Schema = z
  .object({
    canonicalProductId: identifierSchema,
    ean: gtinSchema,
    name: nonEmptyStringSchema,
    brand: nonEmptyStringSchema.optional(),
    packageMeasure: packageMeasureSchema,
    productFamily: identifierSchema.optional(),
  })
  .strict();

export const offerEligibilityV2Schema = z
  .object({
    maxEvidenceAgeMs: nonNegativeSafeIntegerSchema,
    location: geographicContextSchema,
    channel: z.enum(["in-store", "online"]),
      enabledSourceIds: z.array(sourceIdSchema).max(100),
      enabledMembershipProgramIds: z.array(identifierSchema).max(100),
      geographicDirectory: geographicDirectoryEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((context, refinement) => {
    if (!hasUniqueStrings(context.enabledSourceIds)) {
      refinement.addIssue({
        code: "custom",
        message: "Enabled source IDs must be unique",
        path: ["enabledSourceIds"],
      });
    }
    if (!hasUniqueStrings(context.enabledMembershipProgramIds)) {
      refinement.addIssue({
        code: "custom",
        message: "Enabled membership program IDs must be unique",
        path: ["enabledMembershipProgramIds"],
      });
    }
  });

// This is an internal, server-owned planning projection. Public request schemas
// intentionally do not expose product, price, offer, or eligibility metadata.
// `ordinaryPrices` must already have passed source, scope, permission, evidence,
// and current-price admission; official offers remain a distinct evidence type.
export const serverPlanningInputV2Schema = z
  .object({
    contractVersion: z.literal(2),
    needs: z.array(planningNeedV2Schema).min(1).max(50),
    matchingRules: z.array(matchRuleSchema).min(1).max(50),
    products: z.array(planningProductV2Schema).min(1).max(500),
    ordinaryPrices: z.array(sourceNeutralPriceObservationSchema).max(5_000),
    officialOffers: z.array(officialOfferSchema).max(5_000),
    offerEligibility: offerEligibilityV2Schema,
    maxStores: maxStoresSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const uniqueFields: Array<{
      path: string;
      values: string[];
      message: string;
    }> = [
      {
        path: "needs",
        values: input.needs.map(({ id }) => id),
        message: "Need IDs must be unique",
      },
      {
        path: "matchingRules",
        values: input.matchingRules.map(({ id }) => id),
        message: "Matching-rule IDs must be unique",
      },
      {
        path: "products",
        values: input.products.map(({ canonicalProductId }) => canonicalProductId),
        message: "Canonical product IDs must be unique",
      },
      {
        path: "products",
        values: input.products.map(({ ean }) => ean),
        message: "Planning product GTINs must be unique",
      },
      {
        path: "officialOffers",
        values: input.officialOffers.map(({ id }) => id),
        message: "Official-offer IDs must be unique",
      },
      {
        path: "ordinaryPrices",
        values: input.ordinaryPrices.map(({ ean, chain }) => `${ean}\u0000${chain}`),
        message: "Ordinary prices must be unique by GTIN and chain",
      },
    ];
    for (const field of uniqueFields) {
      if (!hasUniqueStrings(field.values)) {
        context.addIssue({
          code: "custom",
          message: field.message,
          path: [field.path],
        });
      }
    }

    const rulesById = new Map(input.matchingRules.map((rule) => [rule.id, rule]));
    for (const [index, need] of input.needs.entries()) {
      if (!rulesById.has(need.matchRuleId)) {
        context.addIssue({
          code: "custom",
          message: "Every need must reference an admitted matching rule",
          path: ["needs", index, "matchRuleId"],
        });
      }
    }
  });

export type ServerPlanningInputV2 = z.infer<typeof serverPlanningInputV2Schema>;
export type PlanningNeedV2 = z.infer<typeof planningNeedV2Schema>;
export type PlanningProductV2 = z.infer<typeof planningProductV2Schema>;

export const checkoutCostV2Schema = z
  .object({
    ordinaryTotalOre: moneyOreSchema,
    savingOre: moneyOreSchema,
    totalOre: moneyOreSchema,
    appliedOfferId: identifierSchema.optional(),
  })
  .strict()
  .superRefine((checkout, context) => {
    if (checkout.ordinaryTotalOre - checkout.savingOre !== checkout.totalOre) {
      context.addIssue({
        code: "custom",
        message: "Checkout total must equal ordinary total minus saving",
        path: ["totalOre"],
      });
    }
    if ((checkout.appliedOfferId === undefined) !== (checkout.savingOre === 0)) {
      context.addIssue({
        code: "custom",
        message: "A positive saving must identify the applied official offer",
        path: ["appliedOfferId"],
      });
    }
  });

export const appliedOfficialOfferReferenceSchema = z
  .object({
    id: identifierSchema,
    sourceId: sourceIdSchema,
    sourceRecordId: identifierSchema,
    capturedAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export const planAssignmentV2Schema = z
  .object({
    needId: identifierSchema,
    canonicalProductId: identifierSchema,
    ean: gtinSchema,
    chain: chainSchema,
    costOre: moneyOreSchema,
    observedAt: z.iso.datetime({ offset: false, precision: 3 }),
    source: sourceIdSchema,
    fulfilment: fulfilmentV2Schema,
    checkout: checkoutCostV2Schema,
    officialOffer: appliedOfficialOfferReferenceSchema.optional(),
  })
  .strict()
  .superRefine((assignment, context) => {
    if (assignment.costOre !== assignment.checkout.totalOre) {
      context.addIssue({
        code: "custom",
        message: "Assignment cost must be the qualifying checkout total",
        path: ["costOre"],
      });
    }
    if (assignment.needId !== assignment.fulfilment.needId) {
      context.addIssue({
        code: "custom",
        message: "Assignment and fulfilment need IDs must match",
        path: ["fulfilment", "needId"],
      });
    }
    if (assignment.canonicalProductId !== assignment.fulfilment.canonicalProductId) {
      context.addIssue({
        code: "custom",
        message: "Assignment and fulfilment product IDs must match",
        path: ["fulfilment", "canonicalProductId"],
      });
    }
    if (assignment.checkout.appliedOfferId !== assignment.officialOffer?.id) {
      context.addIssue({
        code: "custom",
        message: "Applied offer reference must match checkout",
        path: ["officialOffer"],
      });
    }
  });

export const planResultV2Schema = z
  .object({
    id: identifierSchema,
    assignments: z.array(planAssignmentV2Schema).min(1).max(50),
    totalOre: moneyOreSchema,
    chains: z.array(chainSchema).min(1).max(3),
    substitutions: z.array(identifierSchema).max(50),
    coverage: z.literal(1),
    freshness: z.record(identifierSchema, z.literal("eligible")),
  })
  .strict()
  .superRefine((plan, context) => {
    if (!hasUniqueStrings(plan.chains)) {
      context.addIssue({
        code: "custom",
        message: "Plan chains must be unique",
        path: ["chains"],
      });
    }
    const assignmentChains = [...new Set(plan.assignments.map(({ chain }) => chain))].sort();
    if (
      assignmentChains.length !== plan.chains.length
      || assignmentChains.some((chain, index) => chain !== [...plan.chains].sort()[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Plan chains must exactly describe its assignments",
        path: ["chains"],
      });
    }
    const calculatedTotal = plan.assignments.reduce(
      (total, assignment) => total + BigInt(assignment.costOre),
      0n,
    );
    if (calculatedTotal !== BigInt(plan.totalOre)) {
      context.addIssue({
        code: "custom",
        message: "Plan total must equal the sum of assignment checkout totals",
        path: ["totalOre"],
      });
    }
    if (!hasUniqueStrings(plan.assignments.map(({ needId }) => needId))) {
      context.addIssue({
        code: "custom",
        message: "A plan must assign each need exactly once",
        path: ["assignments"],
      });
    }
    const assignedNeedIds = plan.assignments.map(({ needId }) => needId).sort();
    const freshnessNeedIds = Object.keys(plan.freshness).sort();
    if (
      assignedNeedIds.length !== freshnessNeedIds.length
      || assignedNeedIds.some((needId, index) => needId !== freshnessNeedIds[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Freshness must explicitly cover every assigned need",
        path: ["freshness"],
      });
    }
    if (!hasUniqueStrings(plan.substitutions)) {
      context.addIssue({
        code: "custom",
        message: "Substitution need IDs must be unique",
        path: ["substitutions"],
      });
    }
    const assignedNeedIdSet = new Set(assignedNeedIds);
    if (plan.substitutions.some((needId) => !assignedNeedIdSet.has(needId))) {
      context.addIssue({
        code: "custom",
        message: "Substitutions must reference assigned needs",
        path: ["substitutions"],
      });
    }
  });

export type CheckoutCostV2 = z.infer<typeof checkoutCostV2Schema>;
export type PlanAssignmentV2 = z.infer<typeof planAssignmentV2Schema>;
export type PlanResultV2 = z.infer<typeof planResultV2Schema>;
