import { z } from "zod";

import {
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "./contract-primitives";
import { packageMeasureSchema, type PackageMeasure } from "./catalog";
import {
  MAX_PERSISTED_MONEY_ORE,
  moneyOreSchema,
  type MoneyOre,
} from "./contracts";
import {
  parseApplicableOfficialOffer,
  type OfficialOffer,
  type OfficialOfferEvaluationContext,
} from "./offers";
import { fulfilmentSchema, type Fulfilment } from "./fulfilment-contract";

export { fulfilmentSchema, type Fulfilment } from "./fulfilment-contract";

const nonNegativeMeasureSchema = packageMeasureSchema.extend({
  amount: nonNegativeSafeIntegerSchema,
});

export const fulfilmentV2Schema = z
  .object({
    contractVersion: z.literal(2),
    needId: identifierSchema,
    canonicalProductId: identifierSchema,
    requested: packageMeasureSchema,
    packageMeasure: packageMeasureSchema,
    packageCount: positiveSafeIntegerSchema,
    purchased: packageMeasureSchema,
    surplus: nonNegativeMeasureSchema,
    complete: z.literal(true),
  })
  .strict()
  .superRefine((fulfilment, context) => {
    const expectedPackageCount = fulfilment.requested.unit === "package"
      ? fulfilment.requested.amount
      : Number(
        (BigInt(fulfilment.requested.amount) + BigInt(fulfilment.packageMeasure.amount) - 1n)
          / BigInt(fulfilment.packageMeasure.amount),
      );
    if (fulfilment.packageCount !== expectedPackageCount) {
      context.addIssue({
        code: "custom",
        message: "Package count must be the smallest complete whole-package quantity",
        path: ["packageCount"],
      });
    }

    const physicalPurchaseAmount =
      BigInt(fulfilment.packageMeasure.amount) * BigInt(fulfilment.packageCount);
    if (physicalPurchaseAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      context.addIssue({
        code: "custom",
        message: "Purchased package contents exceed safe integer precision",
        path: ["packageCount"],
      });
      return;
    }

    if (fulfilment.requested.unit === "package") {
      if (
        fulfilment.purchased.unit !== "package"
        || fulfilment.purchased.amount !== fulfilment.packageCount
        || fulfilment.surplus.unit !== "package"
        || fulfilment.surplus.amount !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Explicit package requests must expose exact purchased and surplus package counts",
          path: ["purchased"],
        });
      }
      return;
    }

    if (
      fulfilment.requested.unit !== fulfilment.packageMeasure.unit
      || fulfilment.purchased.unit !== fulfilment.requested.unit
      || fulfilment.surplus.unit !== fulfilment.requested.unit
    ) {
      context.addIssue({
        code: "custom",
        message: "Requested, package, purchased, and surplus measures must use compatible units",
        path: ["packageMeasure", "unit"],
      });
      return;
    }
    const purchasedAmount = Number(physicalPurchaseAmount);
    if (fulfilment.purchased.amount !== purchasedAmount) {
      context.addIssue({
        code: "custom",
        message: "Purchased amount must equal package measure times package count",
        path: ["purchased", "amount"],
      });
    }
    if (fulfilment.surplus.amount !== purchasedAmount - fulfilment.requested.amount) {
      context.addIssue({
        code: "custom",
        message: "Surplus must equal purchased minus requested amount",
        path: ["surplus", "amount"],
      });
    }
  });

export type FulfilmentV2 = z.infer<typeof fulfilmentV2Schema>;

export interface PackageFulfilmentV2Input {
  canonicalProductId: string;
  needId: string;
  requested: PackageMeasure;
  packageMeasure: PackageMeasure;
}

export type PackageFulfilmentV2Result =
  | { state: "complete"; fulfilment: FulfilmentV2 }
  | { state: "unavailable"; reason: "incompatible-unit" | "invalid" | "overflow" };

export function calculatePackageFulfilmentV2(
  input: PackageFulfilmentV2Input,
): PackageFulfilmentV2Result {
  const canonicalProductId = identifierSchema.safeParse(input.canonicalProductId);
  const needId = identifierSchema.safeParse(input.needId);
  const requested = packageMeasureSchema.safeParse(input.requested);
  const packageMeasure = packageMeasureSchema.safeParse(input.packageMeasure);
  if (
    !canonicalProductId.success
    || !needId.success
    || !requested.success
    || !packageMeasure.success
  ) {
    return { state: "unavailable", reason: "invalid" };
  }
  if (
    requested.data.unit !== "package"
    && requested.data.unit !== packageMeasure.data.unit
  ) {
    return { state: "unavailable", reason: "incompatible-unit" };
  }

  const packageCount = requested.data.unit === "package"
    ? BigInt(requested.data.amount)
    : (
      BigInt(requested.data.amount) + BigInt(packageMeasure.data.amount) - 1n
    ) / BigInt(packageMeasure.data.amount);
  const physicalPurchaseAmount = packageCount * BigInt(packageMeasure.data.amount);
  if (
    packageCount > BigInt(Number.MAX_SAFE_INTEGER)
    || physicalPurchaseAmount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return { state: "unavailable", reason: "overflow" };
  }

  const purchased = requested.data.unit === "package"
    ? { amount: Number(packageCount), unit: "package" as const }
    : { amount: Number(physicalPurchaseAmount), unit: requested.data.unit };
  const surplus = requested.data.unit === "package"
    ? { amount: 0, unit: "package" as const }
    : {
      amount: Number(physicalPurchaseAmount) - requested.data.amount,
      unit: requested.data.unit,
    };
  const fulfilment = fulfilmentV2Schema.safeParse({
    contractVersion: 2,
    needId: needId.data,
    canonicalProductId: canonicalProductId.data,
    requested: requested.data,
    packageMeasure: packageMeasure.data,
    packageCount: Number(packageCount),
    purchased,
    surplus,
    complete: true,
  });
  return fulfilment.success
    ? { state: "complete", fulfilment: fulfilment.data }
    : { state: "unavailable", reason: "invalid" };
}

export interface PackageFulfilmentInput {
  canonicalProductId: string;
  needId: string;
  requested: PackageMeasure;
  packageMeasure: PackageMeasure;
}

export type PackageFulfilmentResult =
  | { state: "complete"; fulfilment: Fulfilment }
  | { state: "unavailable"; reason: "incompatible-unit" | "invalid" | "overflow" };

export function calculatePackageFulfilment(
  input: PackageFulfilmentInput,
): PackageFulfilmentResult {
  const canonicalProductId = identifierSchema.safeParse(input.canonicalProductId);
  const needId = identifierSchema.safeParse(input.needId);
  const requested = packageMeasureSchema.safeParse(input.requested);
  const packageMeasure = packageMeasureSchema.safeParse(input.packageMeasure);
  if (
    !canonicalProductId.success
    || !needId.success
    || !requested.success
    || !packageMeasure.success
  ) {
    return { state: "unavailable", reason: "invalid" };
  }
  if (requested.data.unit !== packageMeasure.data.unit) {
    return { state: "unavailable", reason: "incompatible-unit" };
  }

  const requestedAmount = BigInt(requested.data.amount);
  const packageAmount = BigInt(packageMeasure.data.amount);
  const packageCount = (requestedAmount + packageAmount - 1n) / packageAmount;
  const fulfilledAmount = packageCount * packageAmount;
  if (
    packageCount > BigInt(Number.MAX_SAFE_INTEGER)
    || fulfilledAmount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return { state: "unavailable", reason: "overflow" };
  }

  const fulfilment = fulfilmentSchema.safeParse({
    contractVersion: 1,
    needId: needId.data,
    canonicalProductId: canonicalProductId.data,
    requested: requested.data,
    packageMeasure: packageMeasure.data,
    packageCount: Number(packageCount),
    fulfilledAmount: Number(fulfilledAmount),
    surplusAmount: Number(fulfilledAmount - requestedAmount),
    complete: true,
  });
  return fulfilment.success
    ? { state: "complete", fulfilment: fulfilment.data }
    : { state: "unavailable", reason: "invalid" };
}

export interface CheckoutCostInput {
  canonicalProductId: string;
  chainId: string;
  packageCount: number;
  ordinaryUnitPriceOre: number;
  offer?: OfficialOffer;
  offerContext: OfficialOfferEvaluationContext;
}

export interface CheckoutCost {
  ordinaryTotalOre: MoneyOre;
  savingOre: MoneyOre;
  totalOre: MoneyOre;
  appliedOfferId?: string;
}

export type CheckoutCostResult =
  | CheckoutCost
  | { state: "unavailable"; reason: "invalid" | "overflow" };

function safeMoneyProduct(left: number, right: number): number | undefined {
  const value = BigInt(left) * BigInt(right);
  return value <= BigInt(MAX_PERSISTED_MONEY_ORE) ? Number(value) : undefined;
}

function ordinaryCheckoutCost(totalOre: number): CheckoutCost {
  return {
    ordinaryTotalOre: totalOre as MoneyOre,
    savingOre: 0 as MoneyOre,
    totalOre: totalOre as MoneyOre,
  };
}

export function calculateCheckoutCost(input: CheckoutCostInput): CheckoutCostResult {
  if (
    !identifierSchema.safeParse(input.canonicalProductId).success
    || !identifierSchema.safeParse(input.chainId).success
    || !positiveSafeIntegerSchema.safeParse(input.packageCount).success
    || !moneyOreSchema.safeParse(input.ordinaryUnitPriceOre).success
  ) {
    return { state: "unavailable", reason: "invalid" };
  }

  const ordinaryTotalOre = safeMoneyProduct(
    input.packageCount,
    input.ordinaryUnitPriceOre,
  );
  if (ordinaryTotalOre === undefined) {
    return { state: "unavailable", reason: "overflow" };
  }
  const ordinary = ordinaryCheckoutCost(ordinaryTotalOre);
  if (input.offer === undefined) return ordinary;

  const evaluated = parseApplicableOfficialOffer(input.offer, input.offerContext);
  if (!evaluated.applicable) return ordinary;
  const applicableOffer = evaluated.offer;
  if (
    applicableOffer.chainId !== input.chainId
    || applicableOffer.productMatch.kind !== "exact"
    || applicableOffer.productMatch.canonicalProductId !== input.canonicalProductId
  ) {
    return ordinary;
  }
  const minimumQuantity = Math.max(
    1,
    ...applicableOffer.conditions.flatMap((condition) =>
      condition.kind === "minimum-quantity" ? [condition.quantity] : []),
  );
  if (input.packageCount < minimumQuantity) return ordinary;

  let offerTotal: number | undefined;
  if (applicableOffer.pricing.kind === "unit") {
    offerTotal = safeMoneyProduct(
      input.packageCount,
      applicableOffer.pricing.unitPriceOre,
    );
  } else {
    const groups = Math.floor(input.packageCount / applicableOffer.pricing.quantity);
    const remainder = input.packageCount % applicableOffer.pricing.quantity;
    const groupedTotal = safeMoneyProduct(groups, applicableOffer.pricing.totalOre);
    const remainderTotal = safeMoneyProduct(remainder, input.ordinaryUnitPriceOre);
    if (groupedTotal !== undefined && remainderTotal !== undefined) {
      const combined = BigInt(groupedTotal) + BigInt(remainderTotal);
      if (combined <= BigInt(MAX_PERSISTED_MONEY_ORE)) offerTotal = Number(combined);
    }
  }

  // An offer that cannot be represented within the money contract cannot
  // lower an already-valid ordinary checkout. Ignore it instead of making the
  // otherwise purchasable item unavailable.
  if (offerTotal === undefined) return ordinary;
  if (offerTotal >= ordinaryTotalOre) return ordinary;
  return {
    appliedOfferId: applicableOffer.id,
    ordinaryTotalOre: ordinaryTotalOre as MoneyOre,
    savingOre: (ordinaryTotalOre - offerTotal) as MoneyOre,
    totalOre: offerTotal as MoneyOre,
  };
}
