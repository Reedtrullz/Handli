import { z } from "zod";

import {
  exactProductPlanApiRequestSchema,
  exactProductPlanApiResponseSchema,
  exactProductPlanApiResponseSchemaFor,
  type ExactProductPlanApiRequest,
} from "./plan-api-contracts";
import {
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyPlanApiResponseV2Schema,
  reviewedFamilyPlanApiResponseV2SchemaFor,
  type ReviewedFamilyPlanApiRequestV2,
} from "./reviewed-family-plan-api-contracts";
import {
  travelCalculationStateSchema,
  travelModeSchema,
} from "./travel-contracts";

export const TRAVEL_PLAN_API_CONTRACT_VERSION = 1 as const;

export const locationSelectionTokenSchema = z
  .string()
  .regex(/^location-choice:[A-Za-z0-9_-]{43}$/u);

const planningRequestSchema = z.discriminatedUnion("contractVersion", [
  exactProductPlanApiRequestSchema,
  reviewedFamilyPlanApiRequestV2Schema,
]);

export const travelPlanApiRequestSchema = z
  .object({
    contractVersion: z.literal(TRAVEL_PLAN_API_CONTRACT_VERSION),
    locationSelectionToken: locationSelectionTokenSchema,
    planning: planningRequestSchema,
    travelMode: travelModeSchema,
  })
  .strict();

export type TravelPlanApiRequest = z.infer<typeof travelPlanApiRequestSchema>;

const planningResponseSchema = z.discriminatedUnion("contractVersion", [
  exactProductPlanApiResponseSchema,
  reviewedFamilyPlanApiResponseV2Schema,
]);

/**
 * Travel stays top-level. Nested planning plans deliberately retain the exact
 * public `/api/plans` shape, while their set and order may be the travel-aware
 * frontier selected by the server.
 */
export const travelPlanApiResponseSchema = z
  .object({
    contractVersion: z.literal(TRAVEL_PLAN_API_CONTRACT_VERSION),
    planning: planningResponseSchema,
    travel: travelCalculationStateSchema,
  })
  .strict();

export type TravelPlanApiResponse = z.infer<typeof travelPlanApiResponseSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requestBoundPlanningIsValid(
  request: ExactProductPlanApiRequest | ReviewedFamilyPlanApiRequestV2,
  planning: TravelPlanApiResponse["planning"],
  travel: TravelPlanApiResponse["travel"],
): boolean {
  if (request.contractVersion !== planning.contractVersion) return false;
  const travelRoutes = travel.kind === "calculated" ? travel.routes : undefined;
  return request.contractVersion === 1
    ? exactProductPlanApiResponseSchemaFor(request, { travelRoutes }).safeParse(planning).success
    : reviewedFamilyPlanApiResponseV2SchemaFor(request, { travelRoutes }).safeParse(planning).success;
}

/**
 * Binds the generic travel envelope to the exact nested browser request and
 * proves that route aggregates describe exactly the returned plan frontier.
 */
export function travelPlanApiResponseSchemaFor(request: unknown) {
  const parsedRequest = travelPlanApiRequestSchema.parse(request);

  return travelPlanApiResponseSchema.superRefine((response, context) => {
    if (!requestBoundPlanningIsValid(parsedRequest.planning, response.planning, response.travel)) {
      context.addIssue({
        code: "custom",
        message: "Travel planning output must satisfy its nested planning request",
        path: ["planning"],
      });
      return;
    }

    if (response.travel.kind === "not-requested") {
      context.addIssue({
        code: "custom",
        message: "A travel-plan response must state calculated or unavailable travel",
        path: ["travel", "kind"],
      });
      return;
    }

    if (response.travel.kind === "unavailable") {
      return;
    }

    const planIds = response.planning.plans.map(({ id }) => id);
    const routeIds = response.travel.routes.map(({ planId }) => planId);
    if (!sameStrings(routeIds, planIds)) {
      context.addIssue({
        code: "custom",
        message: "Calculated routes must exactly follow the returned plan order",
        path: ["travel", "routes"],
      });
    }

    const plansById = new Map(response.planning.plans.map((plan) => [plan.id, plan]));
    for (const [index, route] of response.travel.routes.entries()) {
      const plan = plansById.get(route.planId);
      if (
        plan === undefined
        || route.aggregate.calculatedAt !== response.planning.generatedAt
        || route.aggregate.mode !== parsedRequest.travelMode
        || !sameStrings(
          [...route.stops.map(({ chainId }) => chainId)].sort(compareText),
          [...plan.chains].sort(compareText),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Every route must use the requested mode, planning snapshot, and exactly its plan chains",
          path: ["travel", "routes", index],
        });
      }
    }
  });
}
