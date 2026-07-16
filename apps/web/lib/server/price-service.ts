import type {
  PlanningEvidenceProductIdentity,
  PlanningEvidenceReader,
  PlanningEvidenceSnapshot,
} from "@handleplan/db/planning-evidence-reader";
import {
  coverageCheckSchema,
  deriveHistoricalComparison,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiEvidenceSourceSchema,
  exactProductPlanApiRequestSchema,
  isFiniteDate,
  priceEvidenceSchema,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiNeedEvidence,
  type ExactProductPlanApiRequest,
  type MoneyOre,
  type PriceEvidence,
  type PriceObservation,
} from "@handleplan/domain";

import { CoverageService, CoverageUnavailableError } from "./coverage-service";

const CURRENT_PRICE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;

export type PriceServiceErrorCode = "CANCELLED" | "INVALID_REQUEST" | "UNAVAILABLE";

const errorMessages: Readonly<Record<PriceServiceErrorCode, string>> = {
  CANCELLED: "Price evidence request cancelled",
  INVALID_REQUEST: "Price evidence request is invalid",
  UNAVAILABLE: "Price evidence is unavailable",
};

export class PriceServiceError extends Error {
  readonly code: PriceServiceErrorCode;

  constructor(code: PriceServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PriceServiceError";
    this.code = code;
  }
}

export interface ExactPriceServiceResult {
  evidence: ExactProductPlanApiEvidenceEnvelope;
  prices: PriceObservation<string>[];
  products: PlanningEvidenceProductIdentity[];
}

export interface PriceServiceDependencies {
  reader: PlanningEvidenceReader;
  coverageService?: CoverageService;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failIfDuplicate(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new PriceServiceError("UNAVAILABLE");
}

function validatedSnapshot(
  snapshot: PlanningEvidenceSnapshot,
  gtins: readonly string[],
): PlanningEvidenceSnapshot {
  if (
    snapshot === null
    || typeof snapshot !== "object"
    || !Array.isArray(snapshot.products)
    || !Array.isArray(snapshot.sources)
    || !Array.isArray(snapshot.priceEvidence)
    || !Array.isArray(snapshot.historicalEligibleEvidenceIds)
    || !Array.isArray(snapshot.coverageChecks)
  ) {
    throw new PriceServiceError("UNAVAILABLE");
  }
  failIfDuplicate(snapshot.products.map(({ gtin }) => gtin));
  failIfDuplicate(snapshot.sources.map(({ id }) => id));

  const requested = [...gtins].sort(compareText);
  const returned = snapshot.products.map(({ gtin }) => gtin).sort(compareText);
  if (
    requested.length !== returned.length
    || requested.some((gtin, index) => gtin !== returned[index])
  ) {
    throw new PriceServiceError("UNAVAILABLE");
  }
  const canonicalIds = new Set(snapshot.products.map(({ canonicalProductId }) => canonicalProductId));
  const sourceIds = new Set<string>();
  for (const source of snapshot.sources) {
    const parsed = exactProductPlanApiEvidenceSourceSchema.safeParse(source);
    if (!parsed.success) throw new PriceServiceError("UNAVAILABLE");
    sourceIds.add(parsed.data.id);
  }
  failIfDuplicate(snapshot.priceEvidence.map(({ id }) => id));
  const priceEvidenceIds = new Set(snapshot.priceEvidence.map(({ id }) => id));
  failIfDuplicate(snapshot.historicalEligibleEvidenceIds);
  if (
    snapshot.historicalEligibleEvidenceIds.some(
      (id) => typeof id !== "string" || !priceEvidenceIds.has(id),
    )
  ) {
    throw new PriceServiceError("UNAVAILABLE");
  }
  for (const evidence of snapshot.priceEvidence) {
    const parsed = priceEvidenceSchema.safeParse(evidence);
    if (
      !parsed.success
      || parsed.data.productMatch.kind !== "exact"
      || !canonicalIds.has(parsed.data.productMatch.canonicalProductId)
      || !sourceIds.has(parsed.data.sourceId)
    ) {
      throw new PriceServiceError("UNAVAILABLE");
    }
  }
  failIfDuplicate(snapshot.coverageChecks.map(({ id }) => id));
  for (const check of snapshot.coverageChecks) {
    const parsed = coverageCheckSchema.safeParse(check);
    if (
      !parsed.success
      || !canonicalIds.has(parsed.data.canonicalProductId)
      || !sourceIds.has(parsed.data.sourceId)
    ) {
      throw new PriceServiceError("UNAVAILABLE");
    }
  }
  return snapshot;
}

function evidenceProductId(evidence: PriceEvidence): string | undefined {
  return evidence.productMatch.kind === "exact"
    ? evidence.productMatch.canonicalProductId
    : undefined;
}

function sourceIdsReferencedBy(needs: readonly ExactProductPlanApiNeedEvidence[]): Set<string> {
  const ids = new Set<string>();
  for (const need of needs) {
    need.ordinaryPrices.forEach(({ sourceId }) => ids.add(sourceId));
    need.historicalPriceEvidence.forEach(({ sourceId }) => ids.add(sourceId));
    need.excludedPriceEvidence.forEach(({ sourceId }) => ids.add(sourceId));
    need.officialOffers.forEach(({ sourceId }) => ids.add(sourceId));
    need.comparisonScope.entries.forEach(({ status }) => {
      if (status.kind === "known-not-carried") ids.add(status.sourceId);
    });
  }
  return ids;
}

export class PriceService {
  private readonly coverageService: CoverageService;

  constructor(private readonly dependencies: PriceServiceDependencies) {
    this.coverageService = dependencies.coverageService ?? new CoverageService();
  }

  async readExact(
    request: ExactProductPlanApiRequest,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactPriceServiceResult> {
    if (signal?.aborted) throw new PriceServiceError("CANCELLED");
    const parsedRequest = exactProductPlanApiRequestSchema.safeParse(request);
    if (!parsedRequest.success || !(at instanceof Date) || !isFiniteDate(at)) {
      throw new PriceServiceError("INVALID_REQUEST");
    }
    const input = parsedRequest.data;
    const gtins = [...new Set(
      input.needs.map(({ match }) => match.product.value),
    )].sort(compareText);

    let snapshot: PlanningEvidenceSnapshot;
    try {
      snapshot = validatedSnapshot(
        await this.dependencies.reader.getMany(gtins, at, signal),
        gtins,
      );
    } catch (error) {
      if (
        signal?.aborted
        || (error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "CANCELLED")
      ) {
        throw new PriceServiceError("CANCELLED");
      }
      if (error instanceof PriceServiceError) throw error;
      throw new PriceServiceError("UNAVAILABLE");
    }

    const productByGtin = new Map(snapshot.products.map((product) => [product.gtin, product]));
    const evidenceById = new Map(snapshot.priceEvidence.map((evidence) => [evidence.id, evidence]));
    const historicalEligibleEvidenceIds = new Set(snapshot.historicalEligibleEvidenceIds);
    const enabledSourceIds = snapshot.sources.map(({ id }) => id).sort(compareText);
    const context = {
      enabledSourceIds,
      location: { countryCode: "NO" as const },
      maxAgeMs: CURRENT_PRICE_MAX_AGE_MS,
      now: at,
    };
    const needs: ExactProductPlanApiNeedEvidence[] = [];
    const plannerPrices = new Map<string, PriceObservation<string>>();

    try {
      for (const need of input.needs) {
        const product = productByGtin.get(need.match.product.value);
        if (product === undefined) throw new PriceServiceError("UNAVAILABLE");
        const productEvidence = snapshot.priceEvidence.filter(
          (evidence) => evidenceProductId(evidence) === product.canonicalProductId,
        );
        const productChecks = snapshot.coverageChecks.filter(
          ({ canonicalProductId }) => canonicalProductId === product.canonicalProductId,
        );
        const productHistoricalEvidence = productEvidence.filter(
          ({ id }) => historicalEligibleEvidenceIds.has(id),
        );
        const comparisonScope = this.coverageService.derive({
          canonicalProductId: product.canonicalProductId,
          coverageChecks: productChecks,
          context,
          priceEvidence: productEvidence,
        });
        const ordinaryPrices = comparisonScope.entries.flatMap(({ status }) => {
          if (status.kind !== "priced") return [];
          const evidence = evidenceById.get(status.evidenceId);
          if (evidence === undefined) throw new PriceServiceError("UNAVAILABLE");
          return [evidence];
        });
        const excludedPriceEvidence = comparisonScope.entries.flatMap(({ status }) => {
          const evidenceId = status.kind === "stale"
            ? status.evidenceId
            : status.kind === "ineligible"
              ? status.evidenceId
              : undefined;
          if (evidenceId === undefined) return [];
          const evidence = evidenceById.get(evidenceId);
          if (evidence === undefined) throw new PriceServiceError("UNAVAILABLE");
          return [evidence];
        });

        const historicalComparisons = ordinaryPrices.flatMap((currentEvidence) => {
          const comparison = deriveHistoricalComparison({
            comparisonId: `history:${currentEvidence.id}`,
            currentEvidence,
            derivedAt: at,
            eligibility: {
              currentMaxAgeMs: CURRENT_PRICE_MAX_AGE_MS,
              enabledSourceIds,
              location: context.location,
            },
            historicalEvidence: productHistoricalEvidence,
          });
          return comparison === null ? [] : [comparison];
        });
        const historicalPriceEvidence = historicalComparisons.flatMap((comparison) =>
          comparison.sourceEvidenceIds.map((evidenceId) => {
            const evidence = evidenceById.get(evidenceId);
            if (evidence === undefined) throw new PriceServiceError("UNAVAILABLE");
            return evidence;
          }),
        );
        const uniqueHistory = new Map(
          historicalPriceEvidence.map((evidence) => [evidence.id, evidence]),
        );

        for (const evidence of ordinaryPrices) {
          const key = `${need.match.product.value}\u0000${evidence.chainId}`;
          const observation: PriceObservation<string> = {
            amountOre: evidence.amountOre as MoneyOre,
            chain: evidence.chainId as PriceObservation<string>["chain"],
            ean: need.match.product.value,
            observedAt: evidence.observedAt,
            source: evidence.sourceId,
          };
          const previous = plannerPrices.get(key);
          if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(observation)) {
            throw new PriceServiceError("UNAVAILABLE");
          }
          plannerPrices.set(key, observation);
        }
        needs.push({
          comparisonScope,
          excludedPriceEvidence,
          historicalComparisons,
          historicalPriceEvidence: [...uniqueHistory.values()],
          needId: need.id,
          officialOffers: [],
          ordinaryPrices,
        });
      }
    } catch (error) {
      if (error instanceof PriceServiceError) throw error;
      if (error instanceof CoverageUnavailableError) throw new PriceServiceError("UNAVAILABLE");
      throw new PriceServiceError("UNAVAILABLE");
    }

    needs.sort((left, right) => compareText(left.needId, right.needId));
    const referencedSourceIds = sourceIdsReferencedBy(needs);
    const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
    const sources = [...referencedSourceIds].sort(compareText).map((sourceId) => {
      const source = sourceById.get(sourceId);
      if (source === undefined) throw new PriceServiceError("UNAVAILABLE");
      return source;
    });
    const evidence = exactProductPlanApiEvidenceEnvelopeSchema.safeParse({
      assignmentEvidence: [],
      needs,
      sources,
    });
    if (!evidence.success) throw new PriceServiceError("UNAVAILABLE");

    return {
      evidence: evidence.data,
      prices: [...plannerPrices.values()].sort(
        (left, right) => compareText(left.ean, right.ean)
          || compareText(left.chain, right.chain),
      ),
      products: [...snapshot.products].sort((left, right) => compareText(left.gtin, right.gtin)),
    };
  }
}
