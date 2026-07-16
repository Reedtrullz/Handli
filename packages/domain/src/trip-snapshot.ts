import { z } from "zod";

import { gtinSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { exactProductPlanApiProductSummarySchema } from "./plan-api-contracts";
import { planResultV2Schema } from "./planner-v2-contracts";

const chainSchema = z.enum(["bunnpris", "extra", "rema-1000"]);
const checklistItemIdSchema = z.string().trim().min(1).max(300);

export const tripChecklistItemV1Schema = z
  .object({
    id: checklistItemIdSchema,
    needId: identifierSchema,
    canonicalProductId: identifierSchema,
    gtin: gtinSchema,
    chainId: chainSchema,
    label: nonEmptyStringSchema,
  })
  .strict();

const priceOnlyStopSchema = z
  .object({
    kind: z.literal("chain-stop"),
    chainId: chainSchema,
    name: nonEmptyStringSchema,
  })
  .strict();

const priceOnlyNavigationSchema = z
  .object({
    kind: z.literal("price-only"),
    stops: z.array(priceOnlyStopSchema).min(1).max(3),
  })
  .strict();

export const tripPublicBranchStopV1Schema = z
  .object({
    kind: z.literal("branch-stop"),
    branchId: identifierSchema,
    chainId: chainSchema,
    name: nonEmptyStringSchema,
    sequence: positiveSafeIntegerSchema.max(3),
  })
  .strict();

export const tripRouteAggregateV1Schema = z
  .object({
    calculatedAt: canonicalTimestampSchema,
    distanceMeters: nonNegativeSafeIntegerSchema,
    durationSeconds: nonNegativeSafeIntegerSchema,
    sourceId: sourceIdSchema,
    sourceRecordId: identifierSchema,
  })
  .strict();

const routedNavigationSchema = z
  .object({
    kind: z.literal("route"),
    aggregate: tripRouteAggregateV1Schema,
    stops: z.array(tripPublicBranchStopV1Schema).min(1).max(3),
  })
  .strict();

export const tripNavigationV1Schema = z.discriminatedUnion("kind", [
  priceOnlyNavigationSchema,
  routedNavigationSchema,
]);

export const tripSnapshotV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("trip-snapshot"),
    id: identifierSchema,
    createdAt: canonicalTimestampSchema,
    evaluatedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
    caveats: z.array(nonEmptyStringSchema).max(10),
    plan: planResultV2Schema,
    products: z.array(exactProductPlanApiProductSummarySchema).min(1).max(50),
    checklistItems: z.array(tripChecklistItemV1Schema).min(1).max(50),
    navigation: tripNavigationV1Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const evaluatedAt = Date.parse(snapshot.evaluatedAt);
    const createdAt = Date.parse(snapshot.createdAt);
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (createdAt < evaluatedAt) {
      context.addIssue({
        code: "custom",
        message: "A trip cannot be created before its plan was evaluated",
        path: ["createdAt"],
      });
    }
    if (expiresAt <= evaluatedAt) {
      context.addIssue({
        code: "custom",
        message: "A trip expiry must follow its evaluation",
        path: ["expiresAt"],
      });
    }
    if (!hasUniqueStrings(snapshot.caveats)) {
      context.addIssue({
        code: "custom",
        message: "Trip caveats must be unique",
        path: ["caveats"],
      });
    }

    const productGtins = snapshot.products.map(({ gtin }) => gtin);
    if (!hasUniqueStrings(productGtins)) {
      context.addIssue({
        code: "custom",
        message: "Trip products must be unique by GTIN",
        path: ["products"],
      });
    }
    const productByGtin = new Map(snapshot.products.map((product) => [product.gtin, product]));
    const assignmentByNeed = new Map(
      snapshot.plan.assignments.map((assignment) => [assignment.needId, assignment]),
    );
    const assignedGtins = [...new Set(snapshot.plan.assignments.map(({ ean }) => ean))].sort();
    if (
      productGtins.length !== assignedGtins.length
      || [...productGtins].sort().some((gtin, index) => gtin !== assignedGtins[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Trip products must exactly cover the immutable plan assignments",
        path: ["products"],
      });
    }

    const checklistIds = snapshot.checklistItems.map(({ id }) => id);
    const checklistNeedIds = snapshot.checklistItems.map(({ needId }) => needId);
    if (!hasUniqueStrings(checklistIds) || !hasUniqueStrings(checklistNeedIds)) {
      context.addIssue({
        code: "custom",
        message: "Checklist IDs and need references must be unique",
        path: ["checklistItems"],
      });
    }
    if (
      snapshot.checklistItems.length !== snapshot.plan.assignments.length
      || snapshot.checklistItems.some((item) => {
        const assignment = assignmentByNeed.get(item.needId);
        const product = productByGtin.get(item.gtin);
        return assignment === undefined
          || product === undefined
          || item.canonicalProductId !== assignment.canonicalProductId
          || item.gtin !== assignment.ean
          || item.chainId !== assignment.chain
          || item.label !== product.displayName;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Checklist items must exactly mirror the immutable plan",
        path: ["checklistItems"],
      });
    }

    const planChains = [...snapshot.plan.chains].sort();
    const stopChains = snapshot.navigation.stops.map(({ chainId }) => chainId);
    if (
      !hasUniqueStrings(stopChains)
      || stopChains.length !== planChains.length
      || [...stopChains].sort().some((chain, index) => chain !== planChains[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Trip stops must exactly cover the plan chains",
        path: ["navigation", "stops"],
      });
    }
    if (snapshot.navigation.kind === "route") {
      const branchIds = snapshot.navigation.stops.map(({ branchId }) => branchId);
      const sequences = snapshot.navigation.stops.map(({ sequence }) => sequence);
      if (
        !hasUniqueStrings(branchIds)
        || sequences.some((sequence, index) => sequence !== index + 1)
      ) {
        context.addIssue({
          code: "custom",
          message: "Route stops require unique branches in contiguous public order",
          path: ["navigation", "stops"],
        });
      }
    }
  });

export type TripSnapshotV1 = z.infer<typeof tripSnapshotV1Schema>;
export type TripChecklistItemV1 = z.infer<typeof tripChecklistItemV1Schema>;
export type TripNavigationV1 = z.infer<typeof tripNavigationV1Schema>;

type CreateTripNavigationV1 =
  | { kind: "price-only" }
  | z.input<typeof routedNavigationSchema>;

export interface CreateTripSnapshotInput {
  id: string;
  createdAt: string;
  evaluatedAt: string;
  expiresAt: string;
  caveats: string[];
  plan: z.input<typeof planResultV2Schema>;
  products: Array<z.input<typeof exactProductPlanApiProductSummarySchema>>;
  navigation: CreateTripNavigationV1;
}

const CHAIN_NAMES: Readonly<Record<z.infer<typeof chainSchema>, string>> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

function stableChecklistId(planId: string, needId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of `${planId}\u0000${needId}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `check:${hash.toString(16).padStart(16, "0")}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function createTripSnapshot(input: CreateTripSnapshotInput): TripSnapshotV1 {
  const parsedPlan = planResultV2Schema.parse(input.plan);
  const parsedProducts = z.array(exactProductPlanApiProductSummarySchema).parse(input.products);
  const productByGtin = new Map(parsedProducts.map((product) => [product.gtin, product]));
  const checklistItems = parsedPlan.assignments.map((assignment) => ({
    canonicalProductId: assignment.canonicalProductId,
    chainId: assignment.chain,
    gtin: assignment.ean,
    id: stableChecklistId(parsedPlan.id, assignment.needId),
    label: productByGtin.get(assignment.ean)?.displayName ?? "",
    needId: assignment.needId,
  }));
  const navigation = input.navigation.kind === "price-only"
    ? {
        kind: "price-only" as const,
        stops: [...parsedPlan.chains].sort().map((chainId) => ({
          chainId,
          kind: "chain-stop" as const,
          name: CHAIN_NAMES[chainId],
        })),
      }
    : input.navigation;
  return deepFreeze(tripSnapshotV1Schema.parse({
    caveats: input.caveats,
    checklistItems,
    contractVersion: 1,
    createdAt: input.createdAt,
    evaluatedAt: input.evaluatedAt,
    expiresAt: input.expiresAt,
    id: input.id,
    kind: "trip-snapshot",
    navigation,
    plan: parsedPlan,
    products: parsedProducts,
  }));
}
