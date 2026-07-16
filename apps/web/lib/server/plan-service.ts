import type { PriceCache } from "@handleplan/db";
import {
  calculatePlans,
  enumerateCompletePlanCandidatesV2,
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiProductSummarySchema,
  exactProductPlanApiRequestSchema,
  matchProducts,
  paretoFrontierV2,
  projectRepresentativesV2,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type MatchRule,
  type Need,
  type PlanResult,
  type PlanResultV2,
  type PriceObservation,
  type Product,
  type ServerPlanningInputV2,
} from "@handleplan/domain";
import {
  type KassalappGateway,
  KassalappGatewayError,
} from "@handleplan/kassalapp";
import { z } from "zod";

import { PriceService, PriceServiceError } from "./price-service";

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
  /** Both variants are read through the configured persisted read model. */
  priceDataSource: "upstream" | "cache";
}

export interface ExactProductPlanServiceResult {
  evidence: ExactProductPlanApiEvidenceEnvelope;
  generatedAt: string;
  plans: PlanResultV2[];
  priceDataSource: "cache";
  products: ExactProductPlanApiProductSummary[];
}

export interface ActiveCatalogReader {
  getMany(
    gtins: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]>;
}

export interface PlanServiceContract {
  calculate(request: PlanApiRequest, signal?: AbortSignal): Promise<PlanServiceResult>;
  calculateExact?(
    request: ExactProductPlanApiRequest,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanServiceResult>;
}

export interface PlanServiceDependencies {
  cache?: PriceCache;
  catalog?: ActiveCatalogReader;
  gateway?: KassalappGateway;
  now?: () => Date;
  priceService?: Pick<PriceService, "readExact">;
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

export class UnknownExactProductError extends Error {
  constructor() {
    super("Ett eller flere eksakte produkter er ukjente.");
    this.name = "UnknownExactProductError";
  }
}

export class CatalogUnavailableError extends Error {
  constructor() {
    super("Produktkatalogen er midlertidig utilgjengelig.");
    this.name = "CatalogUnavailableError";
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

function exactRequestAsPlannerV2Input(
  request: ExactProductPlanApiRequest,
  products: readonly ExactProductPlanApiProductSummary[],
  priceResult: Awaited<ReturnType<PriceService["readExact"]>>,
): ServerPlanningInputV2 {
  const catalogByGtin = new Map(products.map((product) => [product.gtin, product]));
  const identityByGtin = new Map(
    priceResult.products.map((product) => [product.gtin, product]),
  );
  const officialOffers = new Map(
    priceResult.evidence.needs
      .flatMap(({ officialOffers: offers }) => offers)
      .map((offer) => [offer.id, offer]),
  );
  return {
    contractVersion: 2,
    matchingRules: request.needs.map((need) => ({
      exactEan: need.match.product.value,
      explanation: "Eksakt produkt valgt av brukeren",
      id: need.id,
      mode: "exact" as const,
      userApproved: true as const,
    })),
    maxStores: request.maxStores,
    needs: request.needs.map((need) => ({
      id: need.id,
      matchRuleId: need.id,
      query: catalogByGtin.get(need.match.product.value)?.displayName
        ?? need.match.product.value,
      requested: {
        amount: need.quantity,
        unit: need.quantityUnit === "each" ? "package" as const : need.quantityUnit,
      },
      required: true,
    })),
    offerEligibility: {
      channel: "in-store",
      enabledMembershipProgramIds: [],
      enabledSourceIds: priceResult.evidence.sources.map(({ id }) => id),
      location: { countryCode: "NO" },
      maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
    },
    officialOffers: [...officialOffers.values()],
    ordinaryPrices: priceResult.prices,
    products: products.map((product) => {
      const identity = identityByGtin.get(product.gtin);
      if (identity === undefined) throw new PriceDataUnavailableError();
      return {
        ...(product.brand === undefined ? {} : { brand: product.brand }),
        canonicalProductId: identity.canonicalProductId,
        ean: product.gtin,
        name: product.displayName,
        packageMeasure: product.packageMeasure,
      };
    }),
  };
}

function attachAssignmentEvidence(
  evidence: ExactProductPlanApiEvidenceEnvelope,
  plans: readonly PlanResultV2[],
  products: readonly ExactProductPlanApiProductSummary[],
): ExactProductPlanApiEvidenceEnvelope {
  const needEvidence = new Map(evidence.needs.map((entry) => [entry.needId, entry]));
  const assignmentEvidence = plans.flatMap((plan) => plan.assignments.map((assignment) => {
    const entry = needEvidence.get(assignment.needId);
    const ordinary = entry?.ordinaryPrices.find((candidate) =>
      candidate.id.length > 0
      && candidate.chainId === assignment.chain
      && candidate.sourceId === assignment.source
      && candidate.productMatch.kind === "exact"
      && candidate.productMatch.canonicalProductId === assignment.canonicalProductId);
    if (ordinary === undefined) throw new PriceDataUnavailableError();
    return {
      chainId: assignment.chain,
      conditions: assignment.checkout.appliedOfferId === undefined
        ? { kind: "ordinary-price" as const }
        : {
            kind: "official-offer" as const,
            offerId: assignment.checkout.appliedOfferId,
          },
      evidenceId: ordinary.id,
      needId: assignment.needId,
      planId: plan.id,
    };
  }));
  const sources = new Map(evidence.sources.map((source) => [source.id, source]));
  for (const { catalogEvidence } of products) {
    const source = catalogEvidence.source;
    const existing = sources.get(source.id);
    if (
      existing !== undefined
      && (
        existing.contractVersion !== source.contractVersion
        || existing.displayName !== source.displayName
        || existing.sourceClass !== source.sourceClass
        || existing.state !== source.state
      )
    ) {
      throw new PriceDataUnavailableError();
    }
    sources.set(source.id, source);
  }
  const parsed = exactProductPlanApiEvidenceEnvelopeSchema.safeParse({
    ...evidence,
    assignmentEvidence,
    sources: [...sources.values()].sort((left, right) => left.id.localeCompare(right.id)),
  });
  if (!parsed.success) throw new PriceDataUnavailableError();
  return parsed.data;
}

function requestedExactGtins(request: ExactProductPlanApiRequest): string[] {
  return [...new Set(request.needs.map(({ match }) => match.product.value))].sort();
}

function summariesExactlyCover(
  gtins: readonly string[],
  products: readonly ExactProductPlanApiProductSummary[],
): boolean {
  return products.length === gtins.length
    && products.every((product, index) => product.gtin === gtins[index]);
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
    return this.calculateParsed(parsed.data, signal);
  }

  async calculateExact(
    request: ExactProductPlanApiRequest,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanServiceResult> {
    const parsed = exactProductPlanApiRequestSchema.safeParse(request);
    if (!parsed.success) throw new UnknownExactProductError();
    if (this.dependencies.catalog === undefined) throw new CatalogUnavailableError();

    const input = parsed.data;
    const gtins = requestedExactGtins(input);
    const catalogAt = this.now();
    let products: ExactProductPlanApiProductSummary[];
    try {
      products = await this.dependencies.catalog.getMany(gtins, catalogAt, signal);
    } catch {
      if (signal?.aborted) throw new PlanRequestCancelledError();
      throw new CatalogUnavailableError();
    }
    const parsedProducts = z.array(exactProductPlanApiProductSummarySchema).max(50)
      .safeParse(products);
    if (!parsedProducts.success) throw new CatalogUnavailableError();
    products = parsedProducts.data;
    if (products.some(({ catalogEvidence }) => {
      const ageMs = catalogAt.getTime() - Date.parse(catalogEvidence.observedAt);
      return ageMs < 0 || ageMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS;
    })) {
      throw new CatalogUnavailableError();
    }
    if (!summariesExactlyCover(gtins, products)) throw new UnknownExactProductError();
    if (this.dependencies.priceService === undefined) throw new PriceDataUnavailableError();

    try {
      const priceResult = await this.dependencies.priceService.readExact(
        input,
        catalogAt,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
      const planningInput = exactRequestAsPlannerV2Input(input, products, priceResult);
      // Keep every complete candidate until optional travel evidence has had a
      // chance to participate. Price-only pruning at enumeration time would
      // make a faster route impossible to recover later.
      const completeCandidates = enumerateCompletePlanCandidatesV2(
        planningInput,
        catalogAt,
      );
      const plans = projectRepresentativesV2(
        paretoFrontierV2(completeCandidates),
        7,
      );
      return {
        evidence: attachAssignmentEvidence(priceResult.evidence, plans, products),
        generatedAt: catalogAt.toISOString(),
        plans,
        priceDataSource: "cache",
        products,
      };
    } catch (error) {
      if (error instanceof PlanRequestCancelledError || signal?.aborted) {
        throw new PlanRequestCancelledError();
      }
      if (error instanceof PriceServiceError && error.code === "CANCELLED") {
        throw new PlanRequestCancelledError();
      }
      throw new PriceDataUnavailableError();
    }
  }

  private async calculateParsed(
    input: PlanApiRequest,
    signal?: AbortSignal,
  ): Promise<PlanServiceResult> {
    const eans = requiredCandidateEans(input);
    const { cache, gateway } = this.dependencies;
    if (cache === undefined || gateway === undefined) {
      throw new PriceDataUnavailableError();
    }

    try {
      const upstreamRows = await gateway.getBulkPrices(eans, signal);
      const evaluationNow = this.now();
      const prices = normalizePrices(
        upstreamRows,
        evaluationNow,
      );
      await cache.putMany(prices, evaluationNow);
      const admittedPrices = normalizePrices(
        await cache.getMany(eans),
        evaluationNow,
      );
      return {
        generatedAt: evaluationNow.toISOString(),
        plans: calculatePlans(toPlannerRequest(input, admittedPrices), evaluationNow),
        priceDataSource: "upstream",
      };
    } catch (error) {
      if (error instanceof KassalappGatewayError && error.code === "CANCELLED") {
        throw new PlanRequestCancelledError();
      }
      const fallbackNow = this.now();
      try {
        const cached = normalizePrices(
          await cache.getMany(eans),
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
