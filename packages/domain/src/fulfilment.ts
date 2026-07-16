import { z } from "zod";

import {
  contractVersionSchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "./contract-primitives";
import { packageMeasureSchema } from "./catalog";

export const fulfilmentSchema = z
  .object({
    contractVersion: contractVersionSchema,
    needId: identifierSchema,
    canonicalProductId: identifierSchema,
    requested: packageMeasureSchema,
    packageMeasure: packageMeasureSchema,
    packageCount: positiveSafeIntegerSchema,
    fulfilledAmount: positiveSafeIntegerSchema,
    surplusAmount: nonNegativeSafeIntegerSchema,
    complete: z.literal(true),
  })
  .strict()
  .superRefine((fulfilment, context) => {
    if (fulfilment.requested.unit !== fulfilment.packageMeasure.unit) {
      context.addIssue({
        code: "custom",
        message: "Requested and package measure units must match",
        path: ["packageMeasure", "unit"],
      });
      return;
    }

    const calculatedAmount =
      BigInt(fulfilment.packageMeasure.amount) * BigInt(fulfilment.packageCount);
    if (calculatedAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      context.addIssue({
        code: "custom",
        message: "Fulfilment multiplication exceeds safe integer precision",
        path: ["packageCount"],
      });
      return;
    }

    const expectedFulfilledAmount = Number(calculatedAmount);
    if (fulfilment.fulfilledAmount !== expectedFulfilledAmount) {
      context.addIssue({
        code: "custom",
        message: "Fulfilled amount must equal package amount times package count",
        path: ["fulfilledAmount"],
      });
    }
    if (expectedFulfilledAmount < fulfilment.requested.amount) {
      context.addIssue({
        code: "custom",
        message: "A complete fulfilment must cover the requested amount",
        path: ["complete"],
      });
      return;
    }
    const expectedSurplus = expectedFulfilledAmount - fulfilment.requested.amount;
    if (fulfilment.surplusAmount !== expectedSurplus) {
      context.addIssue({
        code: "custom",
        message: "Surplus must equal fulfilled minus requested amount",
        path: ["surplusAmount"],
      });
    }
  });

export type Fulfilment = z.infer<typeof fulfilmentSchema>;
