import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  isFiniteDate,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { moneyOreSchema } from "./contracts";
import { evidenceLevelSchema, evidenceProductMatchSchema } from "./evidence";
import {
  geographicContextSchema,
  geographicScopeIncludes,
  offerApplicabilitySchema,
  type GeographicContext,
} from "./geography";

const publicOfferConditionSchema = z.object({ kind: z.literal("public") }).strict();
const memberOfferConditionSchema = z
  .object({
    kind: z.literal("member"),
    programId: identifierSchema,
  })
  .strict();
const minimumQuantityOfferConditionSchema = z
  .object({
    kind: z.literal("minimum-quantity"),
    quantity: positiveSafeIntegerSchema,
  })
  .strict();

export const offerConditionSchema = z.discriminatedUnion("kind", [
  publicOfferConditionSchema,
  memberOfferConditionSchema,
  minimumQuantityOfferConditionSchema,
]);

export type OfferCondition = z.infer<typeof offerConditionSchema>;

const unitOfferPricingSchema = z
  .object({
    kind: z.literal("unit"),
    unitPriceOre: moneyOreSchema,
  })
  .strict();

const multibuyOfferPricingSchema = z
  .object({
    kind: z.literal("multibuy"),
    quantity: positiveSafeIntegerSchema.min(2),
    totalOre: moneyOreSchema,
  })
  .strict();

const offerPricingSchema = z.discriminatedUnion("kind", [
  unitOfferPricingSchema,
  multibuyOfferPricingSchema,
]);

export const officialOfferSchema = z
  .object({
    contractVersion: contractVersionSchema,
    kind: z.literal("official-offer"),
    id: identifierSchema,
    sourceId: sourceIdSchema,
    sourceRecordId: identifierSchema,
    chainId: identifierSchema,
    productMatch: evidenceProductMatchSchema,
    pricing: offerPricingSchema,
    beforePriceOre: moneyOreSchema.optional(),
    conditions: z.array(offerConditionSchema),
    applicability: offerApplicabilitySchema,
    evidenceLevel: evidenceLevelSchema,
    capturedAt: canonicalTimestampSchema,
  })
  .strict()
  .superRefine((offer, context) => {
    const conditionKeys = offer.conditions.map((condition) =>
      condition.kind === "member" ? `member:${condition.programId}` : condition.kind,
    );
    if (!hasUniqueStrings(conditionKeys)) {
      context.addIssue({
        code: "custom",
        message: "Offer conditions must be unique",
        path: ["conditions"],
      });
    }
    const hasPublicCondition = offer.conditions.some(({ kind }) => kind === "public");
    const hasMemberCondition = offer.conditions.some(({ kind }) => kind === "member");
    if (hasPublicCondition && hasMemberCondition) {
      context.addIssue({
        code: "custom",
        message: "An offer cannot be both public and member-only",
        path: ["conditions"],
      });
    }
    if (offer.beforePriceOre === undefined) return;
    if (offer.pricing.kind === "unit") {
      if (offer.beforePriceOre < offer.pricing.unitPriceOre) {
        context.addIssue({
          code: "custom",
          message: "Before-price cannot be lower than the offer price",
          path: ["beforePriceOre"],
        });
      }
      return;
    }

    const comparisonTotal = BigInt(offer.beforePriceOre) * BigInt(offer.pricing.quantity);
    if (comparisonTotal > BigInt(Number.MAX_SAFE_INTEGER)) {
      context.addIssue({
        code: "custom",
        message: "Offer comparison arithmetic would exceed safe integer precision",
        path: ["pricing", "quantity"],
      });
    }
    if (comparisonTotal < BigInt(offer.pricing.totalOre)) {
      context.addIssue({
        code: "custom",
        message: "Before-price total cannot be lower than the multibuy offer total",
        path: ["beforePriceOre"],
      });
    }
  });

export type OfficialOffer = z.infer<typeof officialOfferSchema>;

export interface OfficialOfferEvaluationContext {
  now: Date;
  maxEvidenceAgeMs: number;
  location: GeographicContext;
  channel: "in-store" | "online";
  enabledSourceIds: readonly string[];
  enabledMembershipProgramIds: readonly string[];
}

export type OfficialOfferEvaluationResult =
  | { applicable: true; offer: OfficialOffer }
  | {
      applicable: false;
      reason:
        | "invalid"
        | "source-disabled"
        | "ambiguous"
        | "future"
        | "stale"
        | "not-yet-active"
        | "expired"
        | "wrong-scope"
        | "wrong-channel"
        | "membership-disabled";
    };

export function parseApplicableOfficialOffer(
  input: unknown,
  context: OfficialOfferEvaluationContext,
): OfficialOfferEvaluationResult {
  const parsed = officialOfferSchema.safeParse(input);
  const parsedLocation = geographicContextSchema.safeParse(context.location);
  if (
    !parsed.success ||
    !parsedLocation.success ||
    !isFiniteDate(context.now) ||
    !Number.isSafeInteger(context.maxEvidenceAgeMs) ||
    context.maxEvidenceAgeMs < 0
  ) {
    return { applicable: false, reason: "invalid" };
  }

  const offer = parsed.data;
  if (!context.enabledSourceIds.includes(offer.sourceId)) {
    return { applicable: false, reason: "source-disabled" };
  }
  if (offer.productMatch.kind === "ambiguous" || offer.evidenceLevel === "ambiguous") {
    return { applicable: false, reason: "ambiguous" };
  }

  const nowMs = context.now.getTime();
  const capturedAtMs = Date.parse(offer.capturedAt);
  if (capturedAtMs > nowMs) {
    return { applicable: false, reason: "future" };
  }
  if (nowMs - capturedAtMs > context.maxEvidenceAgeMs) {
    return { applicable: false, reason: "stale" };
  }
  if (nowMs < Date.parse(offer.applicability.startsAt)) {
    return { applicable: false, reason: "not-yet-active" };
  }
  if (nowMs > Date.parse(offer.applicability.endsAt)) {
    return { applicable: false, reason: "expired" };
  }
  if (!geographicScopeIncludes(offer.applicability.geographicScope, parsedLocation.data)) {
    return { applicable: false, reason: "wrong-scope" };
  }
  if (!offer.applicability.channels.includes(context.channel)) {
    return { applicable: false, reason: "wrong-channel" };
  }

  const requiredMemberships = offer.conditions.flatMap((condition) =>
    condition.kind === "member" ? [condition.programId] : [],
  );
  if (
    requiredMemberships.some(
      (programId) => !context.enabledMembershipProgramIds.includes(programId),
    )
  ) {
    return { applicable: false, reason: "membership-disabled" };
  }

  return { applicable: true, offer };
}
