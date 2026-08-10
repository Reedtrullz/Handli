import { z } from "zod";

import { gtinSchema, packageMeasureSchema } from "./catalog";
import {
  canonicalTimestampSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";
import { comparisonScopeSchema, type ComparisonScope } from "./coverage";
import { canonicalProjectedPlanResultsV2 } from "./frontier-v2";
import { marketContextV1Schema, type MarketContextV1 } from "./market-context";
import { formatNok } from "./money";
import { planResultV2Schema, type PlanAssignmentV2, type PlanResultV2 } from "./planner-v2-contracts";
import { travelRouteEvidenceSchema, type TravelRouteEvidence } from "./travel-contracts";

export const PLAN_DELTA_EXPLANATION_CONTRACT_VERSION = 1 as const;

const chainSchema = z.enum(["bunnpris", "extra", "rema-1000"]);
type Chain = z.infer<typeof chainSchema>;

const nonNegativeMeasureSchema = packageMeasureSchema.extend({
  amount: nonNegativeSafeIntegerSchema,
});

const quantitySnapshotSchema = z
  .object({
    packageCount: positiveSafeIntegerSchema,
    packageMeasure: packageMeasureSchema,
    purchased: packageMeasureSchema,
    surplus: nonNegativeMeasureSchema,
  })
  .strict();

const referencePriceDeltaSchema = z
  .object({
    kind: z.literal("reference"),
    message: nonEmptyStringSchema,
  })
  .strict();
const samePriceDeltaSchema = z
  .object({
    kind: z.literal("same"),
    differenceOre: z.literal(0),
    savingOre: z.literal(0),
    message: nonEmptyStringSchema,
  })
  .strict();
const cheaperPriceDeltaSchema = z
  .object({
    kind: z.literal("cheaper"),
    differenceOre: moneyOreSchema.refine((value) => value > 0),
    savingOre: moneyOreSchema.refine((value) => value > 0),
    message: nonEmptyStringSchema,
  })
  .strict()
  .refine(({ differenceOre, savingOre }) => differenceOre === savingOre, {
    message: "A cheaper-plan saving must equal its basket-price difference",
    path: ["savingOre"],
  });
const moreExpensivePriceDeltaSchema = z
  .object({
    kind: z.literal("more-expensive"),
    differenceOre: moneyOreSchema.refine((value) => value > 0),
    savingOre: z.literal(0),
    message: nonEmptyStringSchema,
  })
  .strict();
const withheldPriceDeltaSchema = z
  .object({
    kind: z.literal("withheld"),
    reason: z.enum(["ineligible-evidence", "partial-coverage", "unknown-coverage"]),
    message: nonEmptyStringSchema,
  })
  .strict();

export const planBasketPriceDeltaV1Schema = z.discriminatedUnion("kind", [
  referencePriceDeltaSchema,
  samePriceDeltaSchema,
  cheaperPriceDeltaSchema,
  moreExpensivePriceDeltaSchema,
  withheldPriceDeltaSchema,
]);

const offerSavingV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), message: nonEmptyStringSchema }).strict(),
  z.object({
    kind: z.literal("documented"),
    amountOre: moneyOreSchema.refine((value) => value > 0),
    message: nonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal("withheld"),
    reason: z.enum(["ineligible-evidence", "partial-coverage", "unknown-coverage"]),
    message: nonEmptyStringSchema,
  }).strict(),
]);

const productDeltaV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("same"),
    canonicalProductId: identifierSchema,
    gtin: gtinSchema,
  }).strict(),
  z.object({
    kind: z.literal("changed"),
    fromCanonicalProductId: identifierSchema,
    fromGtin: gtinSchema,
    toCanonicalProductId: identifierSchema,
    toGtin: gtinSchema,
  }).strict(),
]);

const quantityDeltaV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same"), value: quantitySnapshotSchema }).strict(),
  z.object({
    kind: z.literal("changed"),
    from: quantitySnapshotSchema,
    to: quantitySnapshotSchema,
  }).strict(),
]);

const offerDeltaV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same"), offerId: identifierSchema.nullable() }).strict(),
  z.object({ kind: z.literal("added"), toOfferId: identifierSchema }).strict(),
  z.object({ kind: z.literal("removed"), fromOfferId: identifierSchema }).strict(),
  z.object({
    kind: z.literal("changed"),
    fromOfferId: identifierSchema,
    toOfferId: identifierSchema,
  }).strict(),
]);

const chainDeltaV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same"), chainId: chainSchema }).strict(),
  z.object({ kind: z.literal("changed"), fromChainId: chainSchema, toChainId: chainSchema }).strict(),
]);

export const planNeedDeltaExplanationV1Schema = z
  .object({
    needId: identifierSchema,
    product: productDeltaV1Schema,
    quantity: quantityDeltaV1Schema,
    offer: offerDeltaV1Schema,
    chain: chainDeltaV1Schema,
    message: nonEmptyStringSchema,
  })
  .strict();

const storeDeltaV1Schema = z
  .object({
    count: z.number().int().min(1).max(3),
    chainIds: z.array(chainSchema).min(1).max(3),
    referenceCount: z.number().int().min(1).max(3),
    referenceChainIds: z.array(chainSchema).min(1).max(3),
    addedChainIds: z.array(chainSchema).max(3),
    removedChainIds: z.array(chainSchema).max(3),
    message: nonEmptyStringSchema,
  })
  .strict()
  .superRefine((stores, context) => {
    for (const [path, values] of [
      ["chainIds", stores.chainIds],
      ["referenceChainIds", stores.referenceChainIds],
      ["addedChainIds", stores.addedChainIds],
      ["removedChainIds", stores.removedChainIds],
    ] as const) {
      if (!hasUniqueStrings(values)) {
        context.addIssue({ code: "custom", message: "Store-chain lists must be unique", path: [path] });
      }
    }
  });

const travelAxisDeltaV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same"), difference: z.literal(0) }).strict(),
  z.object({
    kind: z.enum(["less", "more"]),
    difference: nonNegativeSafeIntegerSchema.refine((value) => value > 0),
  }).strict(),
]);

const planTravelDeltaV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reference"), message: nonEmptyStringSchema }).strict(),
  z.object({
    kind: z.literal("compared"),
    durationSeconds: travelAxisDeltaV1Schema,
    distanceMeters: travelAxisDeltaV1Schema,
    message: nonEmptyStringSchema,
  }).strict(),
]);

export const planDeltaExplanationV1Schema = z
  .object({
    planId: identifierSchema,
    referencePlanId: identifierSchema,
    presentation: z.object({
      role: z.enum(["only", "convenience", "balanced", "savings", "alternative", "equivalent"]),
      label: nonEmptyStringSchema,
    }).strict(),
    price: planBasketPriceDeltaV1Schema,
    offerSaving: offerSavingV1Schema,
    stores: storeDeltaV1Schema,
    needs: z.array(planNeedDeltaExplanationV1Schema).max(50),
    travel: planTravelDeltaV1Schema.optional(),
    summary: nonEmptyStringSchema,
  })
  .strict();

const routeBindingV1Schema = z
  .object({
    planId: identifierSchema,
    calculatedAt: canonicalTimestampSchema,
    mode: z.enum(["car", "bike"]),
    providerSourceId: sourceIdSchema,
    routeFingerprint: identifierSchema,
  })
  .strict();

export const planDeltaExplanationSetV1Schema = z
  .object({
    contractVersion: z.literal(PLAN_DELTA_EXPLANATION_CONTRACT_VERSION),
    binding: z.object({
      generatedAt: canonicalTimestampSchema,
      marketContext: marketContextV1Schema,
      planIds: z.array(identifierSchema).max(7),
      evidenceIds: z.array(identifierSchema).max(350),
      officialOfferIds: z.array(identifierSchema).max(350),
      comparisonScope: z.enum(["complete", "partial", "not-applicable"]),
      unresolvedReasons: z.array(z.enum([
        "ineligible-evidence",
        "partial-coverage",
        "unknown-coverage",
      ])).max(3),
      routes: z.array(routeBindingV1Schema).max(7).optional(),
    }).strict(),
    referencePlanId: identifierSchema.nullable(),
    qualifier: z.object({
      locale: z.literal("nb-NO"),
      policy: z.literal("returned-complete-plans-only"),
      message: nonEmptyStringSchema,
    }).strict(),
    entries: z.array(planDeltaExplanationV1Schema).max(7),
  })
  .strict()
  .superRefine((set, context) => {
    const { binding, entries, referencePlanId } = set;
    const entryIds = entries.map(({ planId }) => planId);
    if (
      !hasUniqueStrings(binding.planIds)
      || !hasUniqueStrings(binding.evidenceIds)
      || !hasUniqueStrings(binding.officialOfferIds)
      || !hasUniqueStrings(binding.unresolvedReasons)
      || !hasUniqueStrings(entryIds)
    ) {
      context.addIssue({ code: "custom", message: "Explanation bindings must be unique" });
    }
    if (JSON.stringify(binding.planIds) !== JSON.stringify(entryIds)) {
      context.addIssue({ code: "custom", message: "Explanation entries must follow the bound plan order", path: ["entries"] });
    }
    if (binding.planIds.length === 0) {
      if (referencePlanId !== null || entries.length !== 0 || binding.comparisonScope !== "not-applicable") {
        context.addIssue({ code: "custom", message: "An empty explanation set has no reference or comparison" });
      }
    } else if (
      referencePlanId !== binding.planIds[0]
      || entries.some((entry) => entry.referencePlanId !== referencePlanId)
    ) {
      context.addIssue({ code: "custom", message: "Every explanation must use the first returned plan as its reference", path: ["referencePlanId"] });
    }
    const hasRoutes = binding.routes !== undefined;
    if (
      entries.length > 0
      && hasRoutes !== entries.every((entry) => entry.travel !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "Travel explanations require a complete route binding", path: ["binding", "routes"] });
    }
    if (
      binding.routes !== undefined
      && JSON.stringify(binding.routes.map(({ planId }) => planId)) !== JSON.stringify(binding.planIds)
    ) {
      context.addIssue({ code: "custom", message: "Route bindings must follow the bound plan order", path: ["binding", "routes"] });
    }
    if (
      binding.routes !== undefined
      && !hasUniqueStrings(binding.routes.map(({ routeFingerprint }) => routeFingerprint))
    ) {
      context.addIssue({ code: "custom", message: "Route fingerprints must be unique", path: ["binding", "routes"] });
    }
  });

export type PlanDeltaExplanationSetV1 = z.infer<typeof planDeltaExplanationSetV1Schema>;
export type PlanDeltaExplanationV1 = z.infer<typeof planDeltaExplanationV1Schema>;

export interface PlanDeltaAssignmentEvidenceV1 {
  planId: string;
  needId: string;
  canonicalProductId: string;
  chainId: string;
  evidenceId: string;
  offerId?: string;
  comparisonScope: ComparisonScope;
}

export interface DerivePlanDeltaExplanationsV1Input {
  plans: readonly PlanResultV2[];
  generatedAt: string;
  marketContext: MarketContextV1;
  assignmentEvidence: readonly PlanDeltaAssignmentEvidenceV1[];
  travelRoutes?: readonly TravelRouteEvidence[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function chainName(chain: Chain): string {
  if (chain === "rema-1000") return "REMA 1000";
  return chain === "bunnpris" ? "Bunnpris" : "Extra";
}

function joinNorwegian(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} og ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} og ${values.at(-1)}`;
}

function quantitySnapshot(assignment: PlanAssignmentV2) {
  const { packageCount, packageMeasure, purchased, surplus } = assignment.fulfilment;
  return { packageCount, packageMeasure, purchased, surplus };
}

function storeDelta(plan: PlanResultV2, reference: PlanResultV2) {
  const chainIds = [...plan.chains] as Chain[];
  const referenceChainIds = [...reference.chains] as Chain[];
  const addedChainIds = chainIds.filter((chain) => !referenceChainIds.includes(chain));
  const removedChainIds = referenceChainIds.filter((chain) => !chainIds.includes(chain));
  let message = "Samme butikksett som første plan.";
  if (addedChainIds.length > 0 || removedChainIds.length > 0) {
    const changes = [
      addedChainIds.length === 0 ? undefined : `legger til ${joinNorwegian(addedChainIds.map(chainName))}`,
      removedChainIds.length === 0 ? undefined : `tar bort ${joinNorwegian(removedChainIds.map(chainName))}`,
    ].filter((value): value is string => value !== undefined);
    message = `${changes.join(" og ").replace(/^./u, (value) => value.toUpperCase())}.`;
  }
  return {
    count: chainIds.length,
    chainIds,
    referenceCount: referenceChainIds.length,
    referenceChainIds,
    addedChainIds,
    removedChainIds,
    message,
  };
}

function needDelta(current: PlanAssignmentV2, reference: PlanAssignmentV2) {
  const product = current.canonicalProductId === reference.canonicalProductId
      && current.ean === reference.ean
    ? { kind: "same" as const, canonicalProductId: current.canonicalProductId, gtin: current.ean }
    : {
        kind: "changed" as const,
        fromCanonicalProductId: reference.canonicalProductId,
        fromGtin: reference.ean,
        toCanonicalProductId: current.canonicalProductId,
        toGtin: current.ean,
      };
  const currentQuantity = quantitySnapshot(current);
  const referenceQuantity = quantitySnapshot(reference);
  const quantity = sameJson(currentQuantity, referenceQuantity)
    ? { kind: "same" as const, value: currentQuantity }
    : { kind: "changed" as const, from: referenceQuantity, to: currentQuantity };
  const currentOfferId = current.checkout.appliedOfferId;
  const referenceOfferId = reference.checkout.appliedOfferId;
  const offer = currentOfferId === referenceOfferId
    ? { kind: "same" as const, offerId: currentOfferId ?? null }
    : referenceOfferId === undefined
      ? { kind: "added" as const, toOfferId: currentOfferId! }
      : currentOfferId === undefined
        ? { kind: "removed" as const, fromOfferId: referenceOfferId }
        : { kind: "changed" as const, fromOfferId: referenceOfferId, toOfferId: currentOfferId };
  const chain = current.chain === reference.chain
    ? { kind: "same" as const, chainId: current.chain }
    : { kind: "changed" as const, fromChainId: reference.chain, toChainId: current.chain };
  const changes = [
    product.kind === "changed" ? "Bytter produkt" : undefined,
    quantity.kind === "changed"
      ? `endrer pakkeantall fra ${quantity.from.packageCount} til ${quantity.to.packageCount}`
      : undefined,
    offer.kind === "added" ? "bruker et dokumentert tilbud" : undefined,
    offer.kind === "removed" ? "bruker ikke tilbudet fra første plan" : undefined,
    offer.kind === "changed" ? "bruker et annet dokumentert tilbud" : undefined,
    chain.kind === "changed"
      ? `flytter varen fra ${chainName(chain.fromChainId)} til ${chainName(chain.toChainId)}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const message = changes.length === 0
    ? "Samme produkt, mengde, tilbud og butikk som i første plan."
    : `${changes.join(", ").replace(/^./u, (value) => value.toUpperCase())}.`;
  return { needId: current.needId, product, quantity, offer, chain, message };
}

type WithheldReason = "ineligible-evidence" | "partial-coverage" | "unknown-coverage";

function unresolvedReasons(scopes: readonly ComparisonScope[]): WithheldReason[] {
  const reasons = new Set<WithheldReason>();
  for (const scope of scopes) {
    if (scope.completeness === "partial") reasons.add("partial-coverage");
    for (const { status } of scope.entries) {
      if (status.kind === "ineligible") reasons.add("ineligible-evidence");
      if (status.kind === "unknown" || status.kind === "stale") reasons.add("unknown-coverage");
    }
  }
  const order: WithheldReason[] = ["ineligible-evidence", "unknown-coverage", "partial-coverage"];
  return order.filter((reason) => reasons.has(reason));
}

function withheldMessage(reason: WithheldReason): string {
  if (reason === "ineligible-evidence") {
    return "Prisforskjell oppgis ikke fordi sammenligningen inneholder prisgrunnlag som ikke er kvalifisert.";
  }
  if (reason === "unknown-coverage") {
    return "Prisforskjell oppgis ikke fordi deler av kjededekningen er ukjent eller utdatert.";
  }
  return "Prisforskjell oppgis ikke fordi kjededekningen ikke er komplett.";
}

function withheldOfferMessage(reason: WithheldReason): string {
  if (reason === "ineligible-evidence") {
    return "Dokumentert tilbudssparing oppgis ikke fordi prisgrunnlaget ikke er kvalifisert.";
  }
  if (reason === "unknown-coverage") {
    return "Dokumentert tilbudssparing oppgis ikke fordi deler av kjededekningen er ukjent eller utdatert.";
  }
  return "Dokumentert tilbudssparing oppgis ikke fordi kjededekningen ikke er komplett.";
}

function priceDelta(
  plan: PlanResultV2,
  reference: PlanResultV2,
  reason?: WithheldReason,
) {
  if (plan.id === reference.id) {
    return { kind: "reference" as const, message: "Første returnerte plan er sammenligningsgrunnlaget." };
  }
  if (reason !== undefined) {
    return { kind: "withheld" as const, reason, message: withheldMessage(reason) };
  }
  const difference = BigInt(plan.totalOre) - BigInt(reference.totalOre);
  if (difference === 0n) {
    return {
      kind: "same" as const,
      differenceOre: 0 as const,
      savingOre: 0 as const,
      message: "Samme beregnede kurvpris som første plan.",
    };
  }
  const magnitude = Number(difference < 0n ? -difference : difference);
  return difference < 0n
    ? {
        kind: "cheaper" as const,
        differenceOre: magnitude,
        savingOre: magnitude,
        message: `${formatNok(magnitude)} lavere beregnet kurvpris enn første plan.`,
      }
    : {
        kind: "more-expensive" as const,
        differenceOre: magnitude,
        savingOre: 0 as const,
        message: `${formatNok(magnitude)} høyere beregnet kurvpris enn første plan.`,
      };
}

function offerSaving(plan: PlanResultV2, reason?: WithheldReason) {
  if (reason !== undefined) {
    return { kind: "withheld" as const, reason, message: withheldOfferMessage(reason) };
  }
  const total = plan.assignments.reduce(
    (sum, assignment) => sum + BigInt(assignment.checkout.savingOre),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  if (total === 0n) {
    return { kind: "none" as const, message: "Ingen dokumentert tilbudssparing i denne planen." };
  }
  const amountOre = Number(total);
  return {
    kind: "documented" as const,
    amountOre,
    message: `${formatNok(amountOre)} dokumentert tilbudssparing i denne planen.`,
  };
}

function axisDelta(current: number, reference: number) {
  const difference = current - reference;
  if (difference === 0) return { kind: "same" as const, difference: 0 as const };
  return {
    kind: difference < 0 ? "less" as const : "more" as const,
    difference: Math.abs(difference),
  };
}

function durationCopy(delta: ReturnType<typeof axisDelta>): string {
  if (delta.kind === "same") return "samme estimerte reisetid";
  const minutes = Math.max(1, Math.round(delta.difference / 60));
  return `${minutes} min ${delta.kind === "less" ? "kortere" : "lengre"} estimert reisetid`;
}

function distanceCopy(delta: ReturnType<typeof axisDelta>): string {
  if (delta.kind === "same") return "samme estimerte avstand";
  const distance = delta.difference < 1_000
    ? `${delta.difference} m`
    : `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(delta.difference / 1_000)} km`;
  return `${distance} ${delta.kind === "less" ? "kortere" : "lengre"} estimert rute`;
}

function travelDelta(
  planId: string,
  referencePlanId: string,
  route: TravelRouteEvidence,
  referenceRoute: TravelRouteEvidence,
) {
  if (planId === referencePlanId) {
    return { kind: "reference" as const, message: "Første plan er sammenligningsgrunnlaget for reisetid." };
  }
  const durationSeconds = axisDelta(
    route.aggregate.durationSeconds,
    referenceRoute.aggregate.durationSeconds,
  );
  const distanceMeters = axisDelta(
    route.aggregate.distanceMeters,
    referenceRoute.aggregate.distanceMeters,
  );
  const durationMessage = durationSeconds.kind === "same"
    ? "Samme estimerte reisetid som første plan"
    : `${durationCopy(durationSeconds).replace(/^./u, (value) => value.toUpperCase())} enn første plan`;
  const distanceMessage = distanceMeters.kind === "same"
    ? "samme estimerte avstand som første plan"
    : `${distanceCopy(distanceMeters)} enn første plan`;
  return {
    kind: "compared" as const,
    durationSeconds,
    distanceMeters,
    message: `${durationMessage} og ${distanceMessage}.`,
  };
}

function presentation(
  planId: string,
  index: number,
  count: number,
  objectivesAreEquivalent: boolean,
  comparisonIsComplete: boolean,
  conveniencePlanId: string,
  savingsPlanId: string,
  shortestTravelPlanId?: string,
) {
  if (count === 1) {
    return { role: "only" as const, label: "Eneste komplette plan" };
  }
  if (!comparisonIsComplete) {
    return { role: "alternative" as const, label: `Alternativ ${index + 1}` };
  }
  if (objectivesAreEquivalent) {
    return { role: "equivalent" as const, label: `Likeverdig alternativ ${index + 1}` };
  }
  if (conveniencePlanId === savingsPlanId) {
    if (planId === conveniencePlanId) {
      return { role: "convenience" as const, label: "Enklest og lavest pris" };
    }
    if (planId === shortestTravelPlanId) {
      return { role: "alternative" as const, label: "Kortest reise" };
    }
    return { role: "alternative" as const, label: `Alternativ ${index + 1}` };
  }
  if (planId === conveniencePlanId) {
    return { role: "convenience" as const, label: "Enklest" };
  }
  if (planId === savingsPlanId) {
    return { role: "savings" as const, label: "Mest spart" };
  }
  if (index === Math.floor((count - 1) / 2)) {
    return { role: "balanced" as const, label: "Balansert" };
  }
  return { role: "alternative" as const, label: `Alternativ ${index + 1}` };
}

function compareConvenienceObjective(
  left: PlanResultV2,
  right: PlanResultV2,
  routesByPlan?: ReadonlyMap<string, TravelRouteEvidence>,
): number {
  return (
    left.chains.length - right.chains.length
    || (routesByPlan === undefined
      ? 0
      : routesByPlan.get(left.id)!.aggregate.durationSeconds
        - routesByPlan.get(right.id)!.aggregate.durationSeconds)
    || left.totalOre - right.totalOre
    || left.substitutions.length - right.substitutions.length
    || compareText(left.id, right.id)
  );
}

function compareSavingsObjective(
  left: PlanResultV2,
  right: PlanResultV2,
  routesByPlan?: ReadonlyMap<string, TravelRouteEvidence>,
): number {
  return (
    left.totalOre - right.totalOre
    || (routesByPlan === undefined
      ? 0
      : routesByPlan.get(left.id)!.aggregate.durationSeconds
        - routesByPlan.get(right.id)!.aggregate.durationSeconds)
    || left.substitutions.length - right.substitutions.length
    || left.chains.length - right.chains.length
    || compareText(left.id, right.id)
  );
}

function uniqueShortestTravelPlanId(
  plans: readonly PlanResultV2[],
  routesByPlan?: ReadonlyMap<string, TravelRouteEvidence>,
): string | undefined {
  if (routesByPlan === undefined) return undefined;
  const shortestDuration = Math.min(
    ...plans.map((plan) => routesByPlan.get(plan.id)!.aggregate.durationSeconds),
  );
  const shortestPlans = plans.filter((plan) =>
    routesByPlan.get(plan.id)!.aggregate.durationSeconds === shortestDuration);
  return shortestPlans.length === 1 ? shortestPlans[0]!.id : undefined;
}

function canonicalPlans(
  plans: readonly PlanResultV2[],
  routes?: readonly TravelRouteEvidence[],
): PlanResultV2[] | undefined {
  const parsed = z.array(planResultV2Schema).max(7).safeParse(plans);
  if (!parsed.success) return undefined;
  if (routes === undefined) {
    const expected = canonicalProjectedPlanResultsV2(parsed.data, 7);
    return sameJson(expected, parsed.data) ? parsed.data : undefined;
  }
  const parsedRoutes = z.array(travelRouteEvidenceSchema).max(7).safeParse(routes);
  if (!parsedRoutes.success || parsedRoutes.data.length !== parsed.data.length) return undefined;
  if (parsedRoutes.data.some((route, index) => route.planId !== parsed.data[index]?.id)) return undefined;
  const travelEvidence = parsed.data.map((plan, index) => ({
    planId: plan.id,
    travel: {
      contractVersion: 1 as const,
      kind: "calculated" as const,
      durationSeconds: parsedRoutes.data[index]!.aggregate.durationSeconds,
      distanceMeters: parsedRoutes.data[index]!.aggregate.distanceMeters,
      providerSourceId: parsedRoutes.data[index]!.aggregate.providerSourceId,
      calculatedAt: parsedRoutes.data[index]!.aggregate.calculatedAt,
      routeFingerprint: parsedRoutes.data[index]!.aggregate.routeFingerprint,
    },
  }));
  const expected = canonicalProjectedPlanResultsV2(parsed.data, 7, travelEvidence);
  return sameJson(expected, parsed.data) ? parsed.data : undefined;
}

/**
 * Derives presentation copy and metadata exclusively from one server planning
 * snapshot. Invalid, dominated, incomplete-basket, mixed-snapshot, or
 * evidence-detached inputs produce no explanation object.
 */
export function derivePlanDeltaExplanationsV1(
  input: DerivePlanDeltaExplanationsV1Input,
): PlanDeltaExplanationSetV1 | undefined {
  const generatedAt = canonicalTimestampSchema.safeParse(input.generatedAt);
  const marketContext = marketContextV1Schema.safeParse(input.marketContext);
  const routes = input.travelRoutes === undefined
    ? undefined
    : z.array(travelRouteEvidenceSchema).max(7).safeParse(input.travelRoutes);
  if (!generatedAt.success || !marketContext.success || routes?.success === false) return undefined;
  const plans = canonicalPlans(input.plans, routes?.data);
  if (plans === undefined) return undefined;
  if (plans.length === 0) {
    if (input.assignmentEvidence.length !== 0 || routes?.data !== undefined) return undefined;
    return planDeltaExplanationSetV1Schema.parse({
      contractVersion: 1,
      binding: {
        generatedAt: generatedAt.data,
        marketContext: marketContext.data,
        planIds: [],
        evidenceIds: [],
        officialOfferIds: [],
        comparisonScope: "not-applicable",
        unresolvedReasons: [],
      },
      referencePlanId: null,
      qualifier: {
        locale: "nb-NO",
        policy: "returned-complete-plans-only",
        message: "Ingen komplett plan ble returnert, så ingen forskjell er beregnet.",
      },
      entries: [],
    });
  }

  const reference = plans[0]!;
  const referenceNeedIds = reference.assignments.map(({ needId }) => needId).sort(compareText);
  if (plans.some((plan) =>
    plan.coverage !== 1
    || plan.chains.length > 3
    || Object.values(plan.freshness).some((state) => state !== "eligible")
    || !sameJson(plan.assignments.map(({ needId }) => needId).sort(compareText), referenceNeedIds)
  )) return undefined;

  const bindingByKey = new Map<string, PlanDeltaAssignmentEvidenceV1>();
  for (const raw of input.assignmentEvidence) {
    const scope = comparisonScopeSchema.safeParse(raw.comparisonScope);
    if (!scope.success || scope.data.evaluatedAt !== generatedAt.data) return undefined;
    const key = `${raw.planId}\u0000${raw.needId}`;
    if (bindingByKey.has(key)) return undefined;
    bindingByKey.set(key, { ...raw, comparisonScope: scope.data });
  }
  const expectedBindingCount = plans.reduce((count, plan) => count + plan.assignments.length, 0);
  if (bindingByKey.size !== expectedBindingCount) return undefined;

  const scopesByPlan = new Map<string, ComparisonScope[]>();
  const evidenceIds = new Set<string>();
  const officialOfferIds = new Set<string>();
  for (const plan of plans) {
    const scopes: ComparisonScope[] = [];
    for (const assignment of plan.assignments) {
      const binding = bindingByKey.get(`${plan.id}\u0000${assignment.needId}`);
      const scopeEntry = binding?.comparisonScope.entries.find(({ chainId }) =>
        chainId === assignment.chain);
      if (
        binding === undefined
        || binding.planId !== plan.id
        || binding.needId !== assignment.needId
        || binding.canonicalProductId !== assignment.canonicalProductId
        || binding.chainId !== assignment.chain
        || binding.offerId !== assignment.checkout.appliedOfferId
        || scopeEntry?.status.kind !== "priced"
        || scopeEntry.status.evidenceId !== binding.evidenceId
      ) return undefined;
      scopes.push(binding.comparisonScope);
      evidenceIds.add(binding.evidenceId);
      for (const entry of binding.comparisonScope.entries) {
        if (entry.status.kind === "priced") evidenceIds.add(entry.status.evidenceId);
      }
      if (binding.offerId !== undefined) officialOfferIds.add(binding.offerId);
    }
    scopesByPlan.set(plan.id, scopes);
  }

  const allScopes = [...scopesByPlan.values()].flat();
  const allUnresolvedReasons = unresolvedReasons(allScopes);
  const routesByPlan = routes?.data === undefined
    ? undefined
    : new Map(routes.data.map((route) => [route.planId, route]));
  if (routes?.data !== undefined && routes.data.some((route, index) => {
    const plan = plans[index];
    return plan === undefined
      || route.planId !== plan.id
      || route.aggregate.calculatedAt !== generatedAt.data
      || !sameJson(
        route.stops.map(({ chainId }) => chainId).sort(compareText),
        [...plan.chains].sort(compareText),
      );
  })) return undefined;
  const referenceRoute = routesByPlan?.get(reference.id);
  const objectivesAreEquivalent = plans.every((plan) =>
    plan.totalOre === reference.totalOre
    && plan.chains.length === reference.chains.length
    && plan.substitutions.length === reference.substitutions.length
    && (
      routesByPlan === undefined
      || routesByPlan.get(plan.id)?.aggregate.durationSeconds
        === referenceRoute?.aggregate.durationSeconds
    ));
  const conveniencePlanId = [...plans]
    .sort((left, right) => compareConvenienceObjective(left, right, routesByPlan))[0]!.id;
  const savingsPlanId = [...plans]
    .sort((left, right) => compareSavingsObjective(left, right, routesByPlan))[0]!.id;
  const shortestTravelPlanId = uniqueShortestTravelPlanId(plans, routesByPlan);

  const entries = plans.map((plan, index) => {
    const pairScopes = [
      ...(scopesByPlan.get(reference.id) ?? []),
      ...(scopesByPlan.get(plan.id) ?? []),
    ];
    const reason = unresolvedReasons(pairScopes)[0];
    const price = priceDelta(plan, reference, reason);
    const saving = offerSaving(plan, reason);
    if (saving === undefined) return undefined;
    const stores = storeDelta(plan, reference);
    const referenceAssignments = new Map(
      reference.assignments.map((assignment) => [assignment.needId, assignment]),
    );
    const needs = plan.id === reference.id
      ? []
      : [...plan.assignments]
          .sort((left, right) => compareText(left.needId, right.needId))
          .map((assignment) => {
            const referenceAssignment = referenceAssignments.get(assignment.needId);
            return referenceAssignment === undefined
              ? undefined
              : needDelta(assignment, referenceAssignment);
          });
    if (needs.some((need) => need === undefined)) return undefined;
    const route = routesByPlan?.get(plan.id);
    const travel = route === undefined || referenceRoute === undefined
      ? undefined
      : travelDelta(plan.id, reference.id, route, referenceRoute);
    const summaryParts = [price.message, stores.message, travel?.message]
      .filter((value): value is string => value !== undefined);
    return {
      planId: plan.id,
      referencePlanId: reference.id,
      presentation: presentation(
        plan.id,
        index,
        plans.length,
        objectivesAreEquivalent,
        allUnresolvedReasons.length === 0,
        conveniencePlanId,
        savingsPlanId,
        shortestTravelPlanId,
      ),
      price,
      offerSaving: saving,
      stores,
      needs: needs as z.infer<typeof planNeedDeltaExplanationV1Schema>[],
      ...(travel === undefined ? {} : { travel }),
      summary: summaryParts.join(" "),
    };
  });
  if (entries.some((entry) => entry === undefined)) return undefined;

  const candidate = {
    contractVersion: 1 as const,
    binding: {
      generatedAt: generatedAt.data,
      marketContext: marketContext.data,
      planIds: plans.map(({ id }) => id),
      evidenceIds: [...evidenceIds].sort(compareText),
      officialOfferIds: [...officialOfferIds].sort(compareText),
      comparisonScope: allUnresolvedReasons.length === 0 ? "complete" as const : "partial" as const,
      unresolvedReasons: allUnresolvedReasons,
      ...(routes?.data === undefined ? {} : {
        routes: routes.data.map(({ planId, aggregate }) => ({
          planId,
          calculatedAt: aggregate.calculatedAt,
          mode: aggregate.mode,
          providerSourceId: aggregate.providerSourceId,
          routeFingerprint: aggregate.routeFingerprint,
        })),
      }),
    },
    referencePlanId: reference.id,
    qualifier: {
      locale: "nb-NO" as const,
      policy: "returned-complete-plans-only" as const,
      message: "Forskjellene gjelder bare de returnerte komplette planene i dette prisøyeblikket; lager og lokal hyllepris er ikke bekreftet.",
    },
    entries: entries as PlanDeltaExplanationV1[],
  };
  const parsed = planDeltaExplanationSetV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
