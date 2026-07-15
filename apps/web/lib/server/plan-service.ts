import type { PriceCache } from "@handleplan/db";
import {
  calculatePlans,
  matchProducts,
  type MatchRule,
  type Need,
  type PlanResult,
  type PriceObservation,
  type Product,
} from "@handleplan/domain";
import {
  type KassalappGateway,
  KassalappGatewayError,
} from "@handleplan/kassalapp";
import { z } from "zod";

const MAX_NEEDS = 50;
const MAX_RULES = 50;
const MAX_PRODUCTS = 200;
const MAX_PRICE_OBSERVATIONS = MAX_PRODUCTS * 3;
const publicString = z.string().trim().min(1).max(200);
const ean = z.string().regex(/^(?:\d{8}|\d{13})$/);
const sizeRange = z
  .object({
    max: z.number().positive(),
    min: z.number().positive(),
    unit: z.enum(["g", "ml"]),
  })
  .strict()
  .refine(({ max, min }) => min <= max);
const ruleBase = {
  explanation: publicString,
  id: publicString,
  userApproved: z.literal(true),
};
const publicMatchRule = z.discriminatedUnion("mode", [
  z.object({ ...ruleBase, exactEan: ean, mode: z.literal("exact") }).strict(),
  z
    .object({
      ...ruleBase,
      allowedBrands: z.array(publicString).min(1).max(20).optional(),
      mode: z.literal("constrained"),
      productFamily: publicString.optional(),
      sizeRange: sizeRange.optional(),
    })
    .strict()
    .refine(
      ({ allowedBrands, productFamily, sizeRange: range }) =>
        allowedBrands !== undefined || productFamily !== undefined || range !== undefined,
    ),
  z
    .object({
      ...ruleBase,
      mode: z.literal("flexible"),
      productFamily: publicString,
    })
    .strict(),
]);
const publicNeed = z
  .object({
    id: publicString,
    matchRuleId: publicString,
    query: publicString,
    quantity: z.number().int().positive().max(10_000),
    quantityUnit: z.enum(["each", "g", "ml"]),
    required: z.boolean(),
  })
  .strict();
const publicProduct = z
  .object({
    brand: publicString.optional(),
    ean,
    name: publicString,
    packageQuantity: z.number().positive().max(1_000_000).optional(),
    packageUnit: z.enum(["g", "ml", "each"]).optional(),
    productFamily: publicString.optional(),
  })
  .strict();

export const planApiRequestSchema = z
  .object({
    matchingRules: z.array(publicMatchRule).min(1).max(MAX_RULES),
    maxStores: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    needs: z.array(publicNeed).min(1).max(MAX_NEEDS),
    products: z.array(publicProduct).min(1).max(MAX_PRODUCTS),
  })
  .strict()
  .superRefine(({ matchingRules, needs, products }, context) => {
    if (new Set(needs.map(({ id }) => id)).size !== needs.length) {
      context.addIssue({ code: "custom", message: "Need IDs must be unique" });
    }
    if (new Set(matchingRules.map(({ id }) => id)).size !== matchingRules.length) {
      context.addIssue({ code: "custom", message: "Rule IDs must be unique" });
    }
    if (new Set(products.map(({ ean: productEan }) => productEan)).size !== products.length) {
      context.addIssue({ code: "custom", message: "Product EANs must be unique" });
    }
    const ruleIds = new Set(matchingRules.map(({ id }) => id));
    if (needs.some(({ matchRuleId }) => !ruleIds.has(matchRuleId))) {
      context.addIssue({ code: "custom", message: "Every need must reference a rule" });
    }
    if (!needs.some(({ required }) => required)) {
      context.addIssue({ code: "custom", message: "At least one need must be required" });
    }
    needs.forEach((need, index) => {
      if (need.required && need.quantityUnit !== "each") {
        context.addIssue({
          code: "custom",
          message: "Required needs must use package counts in Phase 1",
          path: ["needs", index, "quantityUnit"],
        });
      }
    });
    const rulesById = new Map(matchingRules.map((rule) => [rule.id, rule]));
    needs.forEach((need, index) => {
      if (!need.required) return;
      const rule = rulesById.get(need.matchRuleId);
      if (
        rule !== undefined &&
        matchProducts(need as Need, rule as MatchRule, products as Product[]).length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Every required need must have an approved catalog candidate",
          path: ["needs", index],
        });
      }
    });
  });

export type PlanApiRequest = z.infer<typeof planApiRequestSchema>;

export interface PlanServiceResult {
  generatedAt: string;
  plans: PlanResult[];
  priceDataSource: "upstream" | "cache";
}

export interface PlanServiceContract {
  calculate(request: PlanApiRequest, signal?: AbortSignal): Promise<PlanServiceResult>;
}

export interface PlanServiceDependencies {
  cache: PriceCache;
  gateway: KassalappGateway;
  now?: () => Date;
}

export class PriceDataUnavailableError extends Error {
  constructor() {
    super("Prisgrunnlaget er midlertidig utilgjengelig.");
    this.name = "PriceDataUnavailableError";
  }
}

export class PlanRequestCancelledError extends Error {
  constructor() {
    super("Forespørselen ble avbrutt.");
    this.name = "PlanRequestCancelledError";
  }
}

function normalizePrices(rows: PriceObservation[], now: Date): PriceObservation[] {
  if (rows.length > MAX_PRICE_OBSERVATIONS) {
    throw new KassalappGatewayError("INVALID_RESPONSE");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new KassalappGatewayError("INVALID_RESPONSE");
  }

  const latest = new Map<string, PriceObservation>();
  for (const row of rows) {
    if (new Date(row.observedAt).getTime() > now.getTime()) continue;
    const key = `${row.ean}\u0000${row.chain}`;
    const previous = latest.get(key);
    if (
      previous === undefined ||
      row.observedAt > previous.observedAt ||
      (row.observedAt === previous.observedAt && row.amountOre < previous.amountOre)
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.ean.localeCompare(right.ean) ||
      left.chain.localeCompare(right.chain) ||
      right.observedAt.localeCompare(left.observedAt),
  );
}

function requiredCandidateEans(request: PlanApiRequest): string[] {
  const rulesById = new Map(request.matchingRules.map((rule) => [rule.id, rule]));
  const candidates = new Set<string>();
  for (const need of request.needs) {
    if (!need.required) continue;
    const rule = rulesById.get(need.matchRuleId);
    if (rule === undefined) continue;
    for (const product of matchProducts(
      need as Need,
      rule as MatchRule,
      request.products as Product[],
    )) {
      candidates.add(product.ean);
    }
  }
  return [...candidates].sort();
}

function toPlannerRequest(request: PlanApiRequest, prices: PriceObservation[]) {
  return {
    matchingRules: request.matchingRules as MatchRule[],
    maxStores: request.maxStores,
    needs: request.needs as Need[],
    prices,
    products: request.products as Product[],
  };
}

export class PlanService implements PlanServiceContract {
  private readonly now: () => Date;

  constructor(private readonly dependencies: PlanServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async calculate(request: PlanApiRequest, signal?: AbortSignal): Promise<PlanServiceResult> {
    const parsed = planApiRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new PriceDataUnavailableError();
    }
    const input = parsed.data;
    const eans = requiredCandidateEans(input);

    try {
      const upstreamRows = await this.dependencies.gateway.getBulkPrices(eans, signal);
      const evaluationNow = this.now();
      const prices = normalizePrices(
        upstreamRows,
        evaluationNow,
      );
      try {
        await this.dependencies.cache.putMany(prices, evaluationNow);
      } catch {
        // A cache write is best-effort; fresh validated upstream data is still usable.
      }
      return {
        generatedAt: evaluationNow.toISOString(),
        plans: calculatePlans(toPlannerRequest(input, prices), evaluationNow),
        priceDataSource: "upstream",
      };
    } catch (error) {
      if (error instanceof KassalappGatewayError && error.code === "CANCELLED") {
        throw new PlanRequestCancelledError();
      }
      const fallbackNow = this.now();
      try {
        const cached = normalizePrices(
          await this.dependencies.cache.getMany(eans),
          fallbackNow,
        );
        const plans = calculatePlans(toPlannerRequest(input, cached), fallbackNow);
        if (plans.length > 0) {
          return {
            generatedAt: fallbackNow.toISOString(),
            plans,
            priceDataSource: "cache",
          };
        }
      } catch {
        // Collapse cache/storage details into the public unavailable state.
      }
      throw new PriceDataUnavailableError();
    }
  }
}
