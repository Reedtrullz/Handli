import type {
  GeographicDirectoryReader,
} from "@handleplan/db/geographic-directory";
import type {
  PlanningEvidenceProductIdentity,
  PlanningEvidenceReader,
  PlanningEvidenceSnapshot,
} from "@handleplan/db/planning-evidence-reader";
import type {
  PublicOfficialOfferReader,
  PublicOfficialOfferSnapshot,
} from "@handleplan/db/public-official-offer-reader";
import {
  coverageCheckSchema,
  deriveHistoricalComparison,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiEvidenceSourceSchema,
  exactProductPlanApiRequestSchema,
  geographicDirectoryEvidenceSchema,
  isFiniteDate,
  isValidGtin,
  marketContextToGeographicContext,
  marketContextV1Schema,
  officialOfferSchema,
  parseApplicableOfficialOffer,
  priceEvidenceSchema,
  selectOfficialOffersAtHighestGeographicSpecificity,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiNeedEvidence,
  type ExactProductPlanApiRequest,
  type GeographicDirectoryEvidence,
  type MoneyOre,
  type MarketContextV1,
  type OfficialOffer,
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
  geographicDirectory?: GeographicDirectoryEvidence;
  prices: PriceObservation<string>[];
  products: PlanningEvidenceProductIdentity[];
}

export interface ProductPriceEvidence
  extends Omit<ExactProductPlanApiNeedEvidence, "needId"> {
  canonicalProductId: string;
  gtin: string;
}

export interface ProductPriceServiceResult {
  geographicDirectory?: GeographicDirectoryEvidence;
  productEvidence: ProductPriceEvidence[];
  prices: PriceObservation<string>[];
  products: PlanningEvidenceProductIdentity[];
  sources: ExactProductPlanApiEvidenceEnvelope["sources"];
}

export interface PriceServiceDependencies {
  reader: PlanningEvidenceReader;
  coverageService?: CoverageService;
  geographicDirectoryReader?: GeographicDirectoryReader;
  officialOfferReader: PublicOfficialOfferReader;
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

function validatedOfficialOfferSnapshot(
  snapshot: PublicOfficialOfferSnapshot,
  canonicalProductIds: ReadonlySet<string>,
): PublicOfficialOfferSnapshot {
  if (
    snapshot === null
    || typeof snapshot !== "object"
    || !Array.isArray(snapshot.offers)
    || !Array.isArray(snapshot.sources)
    || snapshot.offers.length > 500
  ) {
    throw new PriceServiceError("UNAVAILABLE");
  }
  failIfDuplicate(snapshot.offers.map(({ id }) => id));
  failIfDuplicate(snapshot.sources.map(({ id }) => id));
  const sourceIds = new Set<string>();
  for (const source of snapshot.sources) {
    const parsed = exactProductPlanApiEvidenceSourceSchema.safeParse(source);
    if (!parsed.success || parsed.data.sourceClass !== "offer") {
      throw new PriceServiceError("UNAVAILABLE");
    }
    sourceIds.add(parsed.data.id);
  }
  const referencedSourceIds = new Set<string>();
  const productCounts = new Map<string, number>();
  for (const candidate of snapshot.offers) {
    const parsed = officialOfferSchema.safeParse(candidate);
    if (
      !parsed.success
      || parsed.data.productMatch.kind !== "exact"
      || !canonicalProductIds.has(parsed.data.productMatch.canonicalProductId)
      || !sourceIds.has(parsed.data.sourceId)
    ) {
      throw new PriceServiceError("UNAVAILABLE");
    }
    referencedSourceIds.add(parsed.data.sourceId);
    const productId = parsed.data.productMatch.canonicalProductId;
    const count = (productCounts.get(productId) ?? 0) + 1;
    if (count > 50) throw new PriceServiceError("UNAVAILABLE");
    productCounts.set(productId, count);
  }
  if (
    sourceIds.size !== referencedSourceIds.size
    || [...sourceIds].some((id) => !referencedSourceIds.has(id))
  ) {
    throw new PriceServiceError("UNAVAILABLE");
  }
  return snapshot;
}

function mergeSource(
  sources: Map<string, ExactProductPlanApiEvidenceEnvelope["sources"][number]>,
  source: ExactProductPlanApiEvidenceEnvelope["sources"][number],
): void {
  const previous = sources.get(source.id);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(source)) {
    throw new PriceServiceError("UNAVAILABLE");
  }
  sources.set(source.id, source);
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

  /**
   * Reads a bounded, canonical GTIN union once for server-authoritative mixed
   * planning. The synthetic exact needs are internal projection keys only;
   * browser-controlled labels or matching metadata never enter this boundary.
   */
  async readProducts(
    gtins: readonly string[],
    marketContext: MarketContextV1,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ProductPriceServiceResult> {
    if (
      !Array.isArray(gtins)
      || gtins.length < 1
      || gtins.length > 50
      || new Set(gtins).size !== gtins.length
      || gtins.some((gtin) => typeof gtin !== "string" || !isValidGtin(gtin))
      || !marketContextV1Schema.safeParse(marketContext).success
      || !(at instanceof Date)
      || !isFiniteDate(at)
    ) {
      throw new PriceServiceError("INVALID_REQUEST");
    }
    const canonicalGtins = [...gtins].sort(compareText);
    const needIdByGtin = new Map(
      canonicalGtins.map((gtin, index) => [
        gtin,
        `product-read:${String(index + 1).padStart(2, "0")}`,
      ]),
    );
    const request: ExactProductPlanApiRequest = {
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      marketContext,
      maxStores: 3,
      needs: canonicalGtins.map((gtin) => ({
        id: needIdByGtin.get(gtin)!,
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: gtin },
          userApproved: true,
        },
        quantity: 1,
        quantityUnit: "package",
        required: true,
      })),
    };
    const exact = await this.readExact(request, at, signal);
    const productByGtin = new Map(exact.products.map((product) => [product.gtin, product]));
    const needEvidenceById = new Map(
      exact.evidence.needs.map((evidence) => [evidence.needId, evidence]),
    );
    const productEvidence = canonicalGtins.map((gtin) => {
      const identity = productByGtin.get(gtin);
      const evidence = needEvidenceById.get(needIdByGtin.get(gtin)!);
      if (identity === undefined || evidence === undefined) {
        throw new PriceServiceError("UNAVAILABLE");
      }
      return {
        canonicalProductId: identity.canonicalProductId,
        comparisonScope: evidence.comparisonScope,
        excludedPriceEvidence: evidence.excludedPriceEvidence,
        gtin,
        historicalComparisons: evidence.historicalComparisons,
        historicalPriceEvidence: evidence.historicalPriceEvidence,
        officialOffers: evidence.officialOffers,
        ordinaryPrices: evidence.ordinaryPrices,
      };
    });
    return {
      ...(exact.geographicDirectory === undefined
        ? {}
        : { geographicDirectory: exact.geographicDirectory }),
      productEvidence,
      prices: exact.prices,
      products: exact.products,
      sources: exact.evidence.sources,
    };
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
    let geographicDirectory: GeographicDirectoryEvidence;
    try {
      const [rawSnapshot, rawDirectory] = await Promise.all([
        this.dependencies.reader.getMany(gtins, at, signal),
        this.dependencies.geographicDirectoryReader?.read(
          input.marketContext.countryCode,
          at,
          signal,
        ) ?? Promise.resolve({
          state: "unknown" as const,
          reason: "postal-directory-unavailable",
        }),
      ]);
      snapshot = validatedSnapshot(
        rawSnapshot,
        gtins,
      );
      const parsedDirectory = geographicDirectoryEvidenceSchema.safeParse(rawDirectory);
      geographicDirectory = parsedDirectory.success
        ? parsedDirectory.data
        : { state: "unknown" as const, reason: "invalid-postal-directory" };
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

    let officialOfferSnapshot: PublicOfficialOfferSnapshot;
    const canonicalProductIds = new Set(
      snapshot.products.map(({ canonicalProductId }) => canonicalProductId),
    );
    try {
      officialOfferSnapshot = validatedOfficialOfferSnapshot(
        await this.dependencies.officialOfferReader.getMany(
          [...canonicalProductIds].sort(compareText),
          at,
          signal,
        ),
        canonicalProductIds,
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
      geographicDirectory,
      location: marketContextToGeographicContext(input.marketContext),
      maxAgeMs: CURRENT_PRICE_MAX_AGE_MS,
      now: at,
    };
    const offerSourceIds = officialOfferSnapshot.sources.map(({ id }) => id).sort(compareText);
    const applicableOffers: OfficialOffer[] = [];
    for (const candidate of officialOfferSnapshot.offers) {
      const memberships = candidate.conditions.flatMap((condition) =>
        condition.kind === "member" ? [condition.programId] : [],
      );
      const applicability = parseApplicableOfficialOffer(candidate, {
        channel: "in-store",
        enabledMembershipProgramIds: memberships,
        enabledSourceIds: offerSourceIds,
        geographicDirectory,
        location: context.location,
        maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
        now: at,
      });
      if (!applicability.applicable) continue;
      const productId = applicability.offer.productMatch.kind === "exact"
        ? applicability.offer.productMatch.canonicalProductId
        : undefined;
      if (productId === undefined || !canonicalProductIds.has(productId)) {
        throw new PriceServiceError("UNAVAILABLE");
      }
      applicableOffers.push(applicability.offer);
    }
    const applicableOffersByProduct = new Map<string, OfficialOffer[]>();
    for (const offer of selectOfficialOffersAtHighestGeographicSpecificity(
      applicableOffers,
      { geographicDirectory, location: context.location },
    )) {
      if (offer.productMatch.kind !== "exact") throw new PriceServiceError("UNAVAILABLE");
      const offers = applicableOffersByProduct.get(offer.productMatch.canonicalProductId) ?? [];
      offers.push(offer);
      applicableOffersByProduct.set(offer.productMatch.canonicalProductId, offers);
    }
    for (const offers of applicableOffersByProduct.values()) {
      offers.sort((left, right) => compareText(left.applicability.endsAt, right.applicability.endsAt)
        || compareText(left.id, right.id));
    }
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
              geographicDirectory,
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
          officialOffers: applicableOffersByProduct.get(product.canonicalProductId) ?? [],
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
    const sourceById = new Map<string, ExactProductPlanApiEvidenceEnvelope["sources"][number]>();
    snapshot.sources.forEach((source) => mergeSource(sourceById, source));
    officialOfferSnapshot.sources.forEach((source) => mergeSource(sourceById, source));
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
      geographicDirectory,
      prices: [...plannerPrices.values()].sort(
        (left, right) => compareText(left.ean, right.ean)
          || compareText(left.chain, right.chain),
      ),
      products: [...snapshot.products].sort((left, right) => compareText(left.gtin, right.gtin)),
    };
  }
}
