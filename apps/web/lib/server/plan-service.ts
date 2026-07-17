import {
  attestGeographicDirectoryRegionV1,
  enumerateCompletePlanCandidatesV2,
  DISCOVERY_IMPACT_PRODUCT_UNION_MAX,
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiProductSummarySchema,
  exactProductPlanApiRequestSchema,
  deriveExactProductPlanDeltaExplanationsV1,
  deriveReviewedFamilyPlanDeltaExplanationsV1,
  discoveryImpactRequestV1Schema,
  marketContextToGeographicContext,
  paretoFrontierV2,
  projectRepresentativesV2,
  reviewedFamilyCandidateInspectionResponseSchemaFor,
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyPlanApiResponseV2SchemaFor,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiEvidenceSource,
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type GeographicDirectoryRegionAttestationV1,
  type DiscoveryImpactBaselineCandidateSetV1,
  type DiscoveryImpactRequestV1,
  type PlanResultV2,
  type PlanDeltaExplanationSetV1,
  type PriceEvidence,
  type ReviewedFamilyCandidateInspectionRequest,
  type ReviewedFamilyCandidateInspectionResponse,
  type ReviewedFamilyNeedMatchV2,
  type ReviewedFamilyPlanApiEvidenceEnvelopeV2,
  type ReviewedFamilyPlanApiRequestV2,
  type ReviewedFamilyPlanApiResponseV2,
  type ReviewedFamilyProductClaim,
  type ServerPlanningInputV2,
} from "@handleplan/domain";
import { z } from "zod";

import {
  FamilyCandidateServiceError,
  type FamilyCandidateEvaluationContract,
} from "./family-candidate-service";
import {
  PriceService,
  PriceServiceError,
  type ProductPriceServiceResult,
} from "./price-service";

export interface ExactProductPlanServiceResult {
  completeCandidateSet: {
    evidence: ExactProductPlanApiEvidenceEnvelope;
    plans: PlanResultV2[];
  };
  evidence: ExactProductPlanApiEvidenceEnvelope;
  generatedAt: string;
  geographicDirectoryAttestation?: GeographicDirectoryRegionAttestationV1;
  planDeltaExplanations: PlanDeltaExplanationSetV1;
  plans: PlanResultV2[];
  priceDataSource: "cache";
  products: ExactProductPlanApiProductSummary[];
}

export interface ReviewedFamilyPlanServiceResult extends Omit<
  ReviewedFamilyPlanApiResponseV2,
  "caveats" | "contractVersion" | "enabledMembershipProgramIds" | "marketContext"
> {
  completeCandidateSet: {
    evidence: ReviewedFamilyPlanApiEvidenceEnvelopeV2;
    plans: PlanResultV2[];
  };
}

export interface ActiveCatalogReader {
  getMany(
    gtins: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]>;
}

export interface PlanServiceContract {
  calculateExact(
    request: ExactProductPlanApiRequest,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanServiceResult>;
  calculateReviewed(
    request: ReviewedFamilyPlanApiRequestV2,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyPlanServiceResult>;
}

export interface DiscoveryImpactPlanningResolution {
  baselineCandidateSets: DiscoveryImpactBaselineCandidateSetV1[];
  comparisonCoverageByCanonicalProductId: ReadonlyMap<
    string,
    "complete" | "partial"
  >;
  evaluatedAt: Date;
  planning: ServerPlanningInputV2;
}

export interface DiscoveryImpactPlanningResolver {
  resolveDiscoveryImpactPlanning(
    request: DiscoveryImpactRequestV1,
    signal?: AbortSignal,
  ): Promise<DiscoveryImpactPlanningResolution>;
}

export interface PlanServiceDependencies {
  catalog?: ActiveCatalogReader;
  familyCandidateService?: FamilyCandidateEvaluationContract;
  now?: () => Date;
  priceService?: Pick<PriceService, "readExact">
    & Partial<Pick<PriceService, "readProducts">>;
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

export type ReviewedFamilyPlanErrorCode =
  | "AMBIGUOUS_FAMILY_SELECTION"
  | "CANDIDATE_CONFIRMATION_STALE"
  | "INVALID_REQUEST";

const reviewedFamilyPlanErrorMessages: Readonly<Record<
  ReviewedFamilyPlanErrorCode,
  string
>> = {
  AMBIGUOUS_FAMILY_SELECTION: "Reviewed-family selection is ambiguous.",
  CANDIDATE_CONFIRMATION_STALE: "Reviewed-family confirmation is stale.",
  INVALID_REQUEST: "Reviewed-family planning request is invalid.",
};

export class ReviewedFamilyPlanError extends Error {
  readonly code: ReviewedFamilyPlanErrorCode;

  constructor(code: ReviewedFamilyPlanErrorCode) {
    super(reviewedFamilyPlanErrorMessages[code]);
    this.name = "ReviewedFamilyPlanError";
    this.code = code;
  }
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
  const gtinByCanonicalProductId = new Map<string, string>();
  for (const product of products) {
    const identity = identityByGtin.get(product.gtin);
    if (identity === undefined) throw new PriceDataUnavailableError();
    const previousGtin = gtinByCanonicalProductId.get(identity.canonicalProductId);
    if (previousGtin !== undefined && previousGtin !== product.gtin) {
      throw new PriceDataUnavailableError();
    }
    gtinByCanonicalProductId.set(identity.canonicalProductId, product.gtin);
  }
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
      enabledMembershipProgramIds: request.enabledMembershipProgramIds,
      enabledSourceIds: priceResult.evidence.sources.map(({ id }) => id),
      ...(priceResult.geographicDirectory === undefined
        ? {}
        : { geographicDirectory: priceResult.geographicDirectory }),
      location: marketContextToGeographicContext(request.marketContext),
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type ReviewedFamilyNeed = Extract<
  ReviewedFamilyPlanApiRequestV2["needs"][number],
  { match: { kind: "reviewed-family" } }
>;

function isReviewedFamilyNeed(
  need: ReviewedFamilyPlanApiRequestV2["needs"][number],
): need is ReviewedFamilyNeed {
  return need.match.kind === "reviewed-family";
}

function familySelectionIdentity(need: ReviewedFamilyNeed): string {
  return JSON.stringify({
    allowedBrands: need.match.allowedBrands,
    candidateSetId: need.match.confirmation.candidateSetId,
    familyId: need.match.familyId,
    taxonomyVersionId: need.match.confirmation.taxonomyVersionId,
  });
}

function uniqueFamilySelections(
  request: ReviewedFamilyPlanApiRequestV2,
): ReviewedFamilyNeed[] {
  const byFamilyId = new Map<string, ReviewedFamilyNeed>();
  for (const need of request.needs.filter(isReviewedFamilyNeed)) {
    const previous = byFamilyId.get(need.match.familyId);
    if (
      previous !== undefined
      && familySelectionIdentity(previous) !== familySelectionIdentity(need)
    ) {
      throw new ReviewedFamilyPlanError("AMBIGUOUS_FAMILY_SELECTION");
    }
    byFamilyId.set(need.match.familyId, need);
  }
  return [...byFamilyId.values()].sort((left, right) =>
    compareText(left.match.familyId, right.match.familyId));
}

function candidateInspectionRequest(
  selections: readonly ReviewedFamilyNeed[],
): ReviewedFamilyCandidateInspectionRequest {
  return {
    contractVersion: 2,
    families: selections.map(({ match }) => ({
      ...(match.allowedBrands === undefined ? {} : { allowedBrands: match.allowedBrands }),
      familyId: match.familyId,
    })),
  };
}

function validateCatalogAt(
  products: readonly ExactProductPlanApiProductSummary[],
  at: Date,
  requireCatalogSource: boolean,
): void {
  if (products.some(({ catalogEvidence }) => {
    const ageMs = at.getTime() - Date.parse(catalogEvidence.observedAt);
    return ageMs < 0
      || ageMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS
      || (requireCatalogSource && catalogEvidence.source.sourceClass !== "catalog");
  })) {
    throw new CatalogUnavailableError();
  }
}

function addExactSource(
  sources: Map<string, ExactProductPlanApiEvidenceSource>,
  source: ExactProductPlanApiEvidenceSource,
): void {
  const previous = sources.get(source.id);
  if (previous !== undefined && !sameJson(previous, source)) {
    throw new PriceDataUnavailableError();
  }
  sources.set(source.id, source);
}

function addUniqueEvidence<T extends { id: string }>(
  target: Map<string, T>,
  entries: readonly T[],
): void {
  for (const entry of entries) {
    const previous = target.get(entry.id);
    if (previous !== undefined && !sameJson(previous, entry)) {
      throw new PriceDataUnavailableError();
    }
    target.set(entry.id, entry);
  }
}

function priceEvidenceProductId(evidence: PriceEvidence): string | undefined {
  return evidence.productMatch.kind === "exact"
    ? evidence.productMatch.canonicalProductId
    : undefined;
}

function requestedUnit(
  quantityUnit: ReviewedFamilyPlanApiRequestV2["needs"][number]["quantityUnit"],
): "g" | "ml" | "package" | "piece" {
  return quantityUnit === "each" ? "package" : quantityUnit;
}

function inspectedCandidateSetByFamily(
  inspection: ReviewedFamilyCandidateInspectionResponse,
): Map<string, ReviewedFamilyCandidateInspectionResponse["candidateSets"][number]> {
  return new Map(inspection.candidateSets.map((candidateSet) => [
    candidateSet.familyId,
    candidateSet,
  ]));
}

function exactCatalogGtins(request: ReviewedFamilyPlanApiRequestV2): string[] {
  return [...new Set(request.needs.flatMap((need) =>
    need.match.kind === "exact-product" ? [need.match.product.value] : []))]
    .sort(compareText);
}

function productClaimsForMixedPlan(
  exactProducts: readonly ExactProductPlanApiProductSummary[],
  inspection: ReviewedFamilyCandidateInspectionResponse,
  identityByGtin: ReadonlyMap<string, ProductPriceServiceResult["products"][number]>,
): ReviewedFamilyProductClaim[] {
  const claimsByCanonicalId = new Map<string, ReviewedFamilyProductClaim>();
  const addClaim = (claim: ReviewedFamilyProductClaim) => {
    const previous = claimsByCanonicalId.get(claim.canonicalProductId);
    if (previous !== undefined && !sameJson(previous, claim)) {
      throw new CatalogUnavailableError();
    }
    claimsByCanonicalId.set(claim.canonicalProductId, claim);
  };

  for (const claim of inspection.productClaims) {
    const identity = identityByGtin.get(claim.product.gtin);
    if (identity?.canonicalProductId !== claim.canonicalProductId) {
      throw new PriceDataUnavailableError();
    }
    addClaim(claim);
  }
  for (const product of exactProducts) {
    const identity = identityByGtin.get(product.gtin);
    if (identity === undefined) throw new PriceDataUnavailableError();
    addClaim({ canonicalProductId: identity.canonicalProductId, product });
  }
  return [...claimsByCanonicalId.values()].sort((left, right) =>
    compareText(left.canonicalProductId, right.canonicalProductId));
}

function validatePriceUnion(
  gtins: readonly string[],
  result: ProductPriceServiceResult,
): {
  evidenceByGtin: Map<string, ProductPriceServiceResult["productEvidence"][number]>;
  identityByGtin: Map<string, ProductPriceServiceResult["products"][number]>;
} {
  const identities = [...result.products].sort((left, right) =>
    compareText(left.gtin, right.gtin));
  if (
    identities.length !== gtins.length
    || identities.some((identity, index) => identity.gtin !== gtins[index])
  ) {
    throw new PriceDataUnavailableError();
  }
  const gtinByCanonicalId = new Map<string, string>();
  for (const identity of identities) {
    const previous = gtinByCanonicalId.get(identity.canonicalProductId);
    if (previous !== undefined && previous !== identity.gtin) {
      throw new ReviewedFamilyPlanError("AMBIGUOUS_FAMILY_SELECTION");
    }
    gtinByCanonicalId.set(identity.canonicalProductId, identity.gtin);
  }

  const evidence = [...result.productEvidence].sort((left, right) =>
    compareText(left.gtin, right.gtin));
  if (
    evidence.length !== gtins.length
    || evidence.some((entry, index) => entry.gtin !== gtins[index])
  ) {
    throw new PriceDataUnavailableError();
  }
  const identityByGtin = new Map(identities.map((identity) => [identity.gtin, identity]));
  for (const entry of evidence) {
    if (identityByGtin.get(entry.gtin)?.canonicalProductId !== entry.canonicalProductId) {
      throw new PriceDataUnavailableError();
    }
  }
  return {
    evidenceByGtin: new Map(evidence.map((entry) => [entry.gtin, entry])),
    identityByGtin,
  };
}

function familyByCanonicalProduct(
  inspection: ReviewedFamilyCandidateInspectionResponse,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const candidateSet of inspection.candidateSets) {
    for (const canonicalProductId of candidateSet.candidateProductIds) {
      const previous = result.get(canonicalProductId);
      if (previous !== undefined && previous !== candidateSet.familyId) {
        throw new FamilyCandidateServiceError("AMBIGUOUS_FAMILY_MEMBERSHIP");
      }
      result.set(canonicalProductId, candidateSet.familyId);
    }
  }
  return result;
}

function needMatchesForMixedPlan(
  request: ReviewedFamilyPlanApiRequestV2,
  inspection: ReviewedFamilyCandidateInspectionResponse,
  identityByGtin: ReadonlyMap<string, ProductPriceServiceResult["products"][number]>,
): ReviewedFamilyNeedMatchV2[] {
  const candidateSetByFamily = inspectedCandidateSetByFamily(inspection);
  return [...request.needs]
    .sort((left, right) => compareText(left.id, right.id))
    .map((need) => {
      if (need.match.kind === "exact-product") {
        const identity = identityByGtin.get(need.match.product.value);
        if (identity === undefined) throw new PriceDataUnavailableError();
        return {
          candidateProductIds: [identity.canonicalProductId],
          kind: "exact-product" as const,
          needId: need.id,
        };
      }
      const candidateSet = candidateSetByFamily.get(need.match.familyId);
      if (candidateSet === undefined) {
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }
      return {
        ...(candidateSet.allowedBrands === undefined
          ? {}
          : { allowedBrands: candidateSet.allowedBrands }),
        candidateProductIds: candidateSet.candidateProductIds,
        candidateSetId: candidateSet.candidateSetId,
        family: candidateSet.family,
        familyId: candidateSet.familyId,
        kind: "reviewed-family" as const,
        needId: need.id,
        taxonomyVersionId: candidateSet.taxonomyVersionId,
      };
    });
}

function mixedPlannerInput(
  request: ReviewedFamilyPlanApiRequestV2,
  needMatches: readonly ReviewedFamilyNeedMatchV2[],
  productClaims: readonly ReviewedFamilyProductClaim[],
  familyByProduct: ReadonlyMap<string, string>,
  priceResult: ProductPriceServiceResult,
): ServerPlanningInputV2 {
  const claimByCanonicalId = new Map(
    productClaims.map((claim) => [claim.canonicalProductId, claim]),
  );
  const matchByNeedId = new Map(needMatches.map((match) => [match.needId, match]));
  const officialOffers = new Map<string, ProductPriceServiceResult["productEvidence"][number]["officialOffers"][number]>();
  for (const evidence of priceResult.productEvidence) {
    addUniqueEvidence(officialOffers, evidence.officialOffers);
  }

  return {
    contractVersion: 2,
    matchingRules: request.needs.map((need) => {
      const match = matchByNeedId.get(need.id);
      if (match === undefined) throw new PriceDataUnavailableError();
      if (need.match.kind === "exact-product") {
        return {
          exactEan: need.match.product.value,
          explanation: "Eksakt produkt valgt av brukeren",
          id: need.id,
          mode: "exact" as const,
          userApproved: true as const,
        };
      }
      return {
        explanation: "Serververifisert produktfamilie godkjent av brukeren",
        id: need.id,
        mode: "flexible" as const,
        productFamily: need.match.familyId,
        userApproved: true as const,
      };
    }),
    maxStores: request.maxStores,
    needs: request.needs.map((need) => {
      const match = matchByNeedId.get(need.id);
      if (match === undefined) throw new PriceDataUnavailableError();
      const query = match.kind === "reviewed-family"
        ? match.family.labelNo
        : claimByCanonicalId.get(match.candidateProductIds[0]!)?.product.displayName;
      if (query === undefined) throw new CatalogUnavailableError();
      return {
        id: need.id,
        matchRuleId: need.id,
        query,
        requested: {
          amount: need.quantity,
          unit: requestedUnit(need.quantityUnit),
        },
        required: true as const,
      };
    }),
    offerEligibility: {
      channel: "in-store",
      enabledMembershipProgramIds: request.enabledMembershipProgramIds,
      enabledSourceIds: [...new Set(priceResult.sources.map(({ id }) => id))]
        .sort(compareText),
      ...(priceResult.geographicDirectory === undefined
        ? {}
        : { geographicDirectory: priceResult.geographicDirectory }),
      location: marketContextToGeographicContext(request.marketContext),
      maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
    },
    officialOffers: [...officialOffers.values()].sort((left, right) =>
      compareText(left.id, right.id)),
    ordinaryPrices: priceResult.prices,
    products: productClaims.map(({ canonicalProductId, product }) => ({
      ...(product.brand === undefined ? {} : { brand: product.brand }),
      canonicalProductId,
      ean: product.gtin,
      name: product.displayName,
      packageMeasure: product.packageMeasure,
      ...(familyByProduct.get(canonicalProductId) === undefined
        ? {}
        : { productFamily: familyByProduct.get(canonicalProductId)! }),
    })),
  };
}

function visibleMixedEvidence(
  needMatches: readonly ReviewedFamilyNeedMatchV2[],
  productClaims: readonly ReviewedFamilyProductClaim[],
  inspection: ReviewedFamilyCandidateInspectionResponse,
  priceResult: ProductPriceServiceResult,
  plans: readonly PlanResultV2[],
): ReviewedFamilyPlanApiEvidenceEnvelopeV2 {
  const claimByCanonicalId = new Map(
    productClaims.map((claim) => [claim.canonicalProductId, claim]),
  );
  const evidenceByGtin = new Map(
    priceResult.productEvidence.map((entry) => [entry.gtin, entry]),
  );
  const ordinaryById = new Map<string, PriceEvidence>();
  const excludedById = new Map<string, PriceEvidence>();
  const allOffersById = new Map<string, ProductPriceServiceResult["productEvidence"][number]["officialOffers"][number]>();
  for (const entry of priceResult.productEvidence) {
    addUniqueEvidence(ordinaryById, entry.ordinaryPrices);
    addUniqueEvidence(excludedById, entry.excludedPriceEvidence);
    addUniqueEvidence(allOffersById, entry.officialOffers);
  }

  const candidateCoverage = needMatches.flatMap((match) =>
    match.candidateProductIds.map((canonicalProductId) => {
      const claim = claimByCanonicalId.get(canonicalProductId);
      const productEvidence = claim === undefined
        ? undefined
        : evidenceByGtin.get(claim.product.gtin);
      if (
        claim === undefined
        || productEvidence === undefined
        || productEvidence.canonicalProductId !== canonicalProductId
      ) {
        throw new PriceDataUnavailableError();
      }
      return {
        canonicalProductId,
        comparisonScope: productEvidence.comparisonScope,
        needId: match.needId,
      };
    }))
    .sort((left, right) =>
      compareText(left.needId, right.needId)
      || compareText(left.canonicalProductId, right.canonicalProductId));

  const assignmentEvidence: ReviewedFamilyPlanApiEvidenceEnvelopeV2["assignmentEvidence"] = [];
  for (const plan of plans) {
    for (const assignment of plan.assignments) {
      const ordinary = [...ordinaryById.values()].find((evidence) =>
        evidence.chainId === assignment.chain
        && evidence.sourceId === assignment.source
        && evidence.observedAt === assignment.observedAt
        && priceEvidenceProductId(evidence) === assignment.canonicalProductId);
      if (ordinary === undefined) throw new PriceDataUnavailableError();
      const appliedOfferId = assignment.checkout.appliedOfferId;
      assignmentEvidence.push({
        chainId: assignment.chain,
        conditions: appliedOfferId === undefined
          ? { kind: "ordinary-price" as const }
          : { kind: "official-offer" as const, offerId: appliedOfferId },
        evidenceId: ordinary.id,
        needId: assignment.needId,
        planId: plan.id,
      });
    }
  }
  assignmentEvidence.sort((left, right) =>
    compareText(left.planId, right.planId)
    || compareText(left.needId, right.needId)
    || compareText(left.chainId, right.chainId));

  const officialOffers = [...allOffersById.values()].sort((left, right) =>
    compareText(left.id, right.id));

  const referencedSourceIds = new Set<string>();
  productClaims.forEach(({ product }) =>
    referencedSourceIds.add(product.catalogEvidence.source.id));
  ordinaryById.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
  excludedById.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
  officialOffers.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
  candidateCoverage.forEach(({ comparisonScope }) =>
    comparisonScope.entries.forEach(({ status }) => {
      if (status.kind === "known-not-carried") {
        referencedSourceIds.add(status.sourceId);
      }
    }));

  const sourceById = new Map<string, ExactProductPlanApiEvidenceSource>();
  productClaims.forEach(({ product }) =>
    addExactSource(sourceById, product.catalogEvidence.source));
  for (const source of priceResult.sources) {
    if (referencedSourceIds.has(source.id)) addExactSource(sourceById, source);
  }
  if ([...referencedSourceIds].some((sourceId) => !sourceById.has(sourceId))) {
    throw new PriceDataUnavailableError();
  }

  return {
    assignmentEvidence,
    candidateCoverage,
    excludedPriceEvidence: [...excludedById.values()].sort((left, right) =>
      compareText(left.id, right.id)),
    memberships: inspection.memberships,
    officialOffers,
    ordinaryPrices: [...ordinaryById.values()].sort((left, right) =>
      compareText(left.id, right.id)),
    sources: [...sourceById.values()].sort((left, right) => compareText(left.id, right.id)),
  };
}

function directImpactCatalogGtins(request: DiscoveryImpactRequestV1): string[] {
  const baselineGtins = request.planning.contractVersion === 1
    ? requestedExactGtins(request.planning)
    : exactCatalogGtins(request.planning);
  return [...new Set([
    ...baselineGtins,
    ...request.actions.map(({ product }) => product.value),
  ])].sort(compareText);
}

function exactImpactPlannerInput(
  request: ExactProductPlanApiRequest,
  catalogProducts: readonly ExactProductPlanApiProductSummary[],
  identityByGtin: ReadonlyMap<string, ProductPriceServiceResult["products"][number]>,
  priceResult: ProductPriceServiceResult,
): ServerPlanningInputV2 {
  const productByGtin = new Map(
    catalogProducts.map((product) => [product.gtin, product]),
  );
  const officialOffers = new Map<
    string,
    ProductPriceServiceResult["productEvidence"][number]["officialOffers"][number]
  >();
  for (const evidence of priceResult.productEvidence) {
    addUniqueEvidence(officialOffers, evidence.officialOffers);
  }

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
      query: productByGtin.get(need.match.product.value)?.displayName
        ?? need.match.product.value,
      requested: {
        amount: need.quantity,
        unit: need.quantityUnit === "each"
          ? "package" as const
          : need.quantityUnit,
      },
      required: true as const,
    })),
    offerEligibility: {
      channel: "in-store",
      enabledMembershipProgramIds: request.enabledMembershipProgramIds,
      enabledSourceIds: [...new Set(priceResult.sources.map(({ id }) => id))]
        .sort(compareText),
      ...(priceResult.geographicDirectory === undefined
        ? {}
        : { geographicDirectory: priceResult.geographicDirectory }),
      location: marketContextToGeographicContext(request.marketContext),
      maxEvidenceAgeMs: EXACT_PRODUCT_OFFER_MAX_AGE_MS,
    },
    officialOffers: [...officialOffers.values()].sort((left, right) =>
      compareText(left.id, right.id)),
    ordinaryPrices: priceResult.prices,
    products: catalogProducts.map((product) => {
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

function impactBaselineCandidateSets(
  planning: ServerPlanningInputV2,
  needMatches: readonly ReviewedFamilyNeedMatchV2[] | undefined,
  productClaims: readonly ReviewedFamilyProductClaim[] | undefined,
): DiscoveryImpactBaselineCandidateSetV1[] {
  if (needMatches === undefined || productClaims === undefined) {
    const ruleById = new Map(planning.matchingRules.map((rule) => [rule.id, rule]));
    return planning.needs.map((need) => {
      const rule = ruleById.get(need.matchRuleId);
      if (rule?.mode !== "exact" || rule.exactEan === undefined) {
        throw new PriceDataUnavailableError();
      }
      return { candidateGtins: [rule.exactEan], needId: need.id };
    });
  }

  const gtinByCanonicalProductId = new Map(
    productClaims.map(({ canonicalProductId, product }) => [
      canonicalProductId,
      product.gtin,
    ]),
  );
  const matchByNeedId = new Map(needMatches.map((match) => [match.needId, match]));
  return planning.needs.map((need) => {
    const match = matchByNeedId.get(need.id);
    if (match === undefined) throw new PriceDataUnavailableError();
    const candidateGtins = match.candidateProductIds.map((canonicalProductId) => {
      const gtin = gtinByCanonicalProductId.get(canonicalProductId);
      if (gtin === undefined) throw new PriceDataUnavailableError();
      return gtin;
    });
    return { candidateGtins, needId: need.id };
  });
}

export class PlanService
  implements PlanServiceContract, DiscoveryImpactPlanningResolver {
  private readonly now: () => Date;

  constructor(private readonly dependencies: PlanServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Resolves one bounded, immutable universe for Oppdag impact evaluation.
   * The method deliberately performs no plan calculation: all variants are
   * evaluated later from this single catalog/price/family snapshot.
   */
  async resolveDiscoveryImpactPlanning(
    request: DiscoveryImpactRequestV1,
    signal?: AbortSignal,
  ): Promise<DiscoveryImpactPlanningResolution> {
    if (signal?.aborted) throw new PlanRequestCancelledError();
    const parsed = discoveryImpactRequestV1Schema.safeParse(request);
    if (!parsed.success) throw new ReviewedFamilyPlanError("INVALID_REQUEST");
    const input = parsed.data;
    const evaluatedAt = this.now();
    if (
      !(evaluatedAt instanceof Date)
      || !Number.isFinite(evaluatedAt.getTime())
    ) {
      throw new PriceDataUnavailableError();
    }
    if (this.dependencies.catalog === undefined) {
      throw new CatalogUnavailableError();
    }

    let inspection: ReviewedFamilyCandidateInspectionResponse | undefined;
    let reviewedInput: ReviewedFamilyPlanApiRequestV2 | undefined;
    if (input.planning.contractVersion === 2) {
      reviewedInput = input.planning;
      const selections = uniqueFamilySelections(reviewedInput);
      const inspectionRequest = candidateInspectionRequest(selections);
      if (this.dependencies.familyCandidateService === undefined) {
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }
      try {
        const rawInspection = await this.dependencies.familyCandidateService.inspectAt(
          inspectionRequest,
          evaluatedAt,
          signal,
        );
        if (signal?.aborted) throw new PlanRequestCancelledError();
        const validatedInspection = reviewedFamilyCandidateInspectionResponseSchemaFor(
          inspectionRequest,
        ).safeParse(rawInspection);
        if (
          !validatedInspection.success
          || validatedInspection.data.generatedAt !== evaluatedAt.toISOString()
        ) {
          throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
        }
        inspection = validatedInspection.data;
      } catch (error) {
        if (
          error instanceof PlanRequestCancelledError
          || signal?.aborted
          || (error instanceof FamilyCandidateServiceError
            && error.code === "REQUEST_CANCELLED")
        ) {
          throw new PlanRequestCancelledError();
        }
        if (error instanceof FamilyCandidateServiceError) throw error;
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }

      const candidateSetByFamily = inspectedCandidateSetByFamily(inspection);
      for (const selection of selections) {
        const current = candidateSetByFamily.get(selection.match.familyId);
        if (
          current === undefined
          || current.candidateSetId
            !== selection.match.confirmation.candidateSetId
          || current.taxonomyVersionId
            !== selection.match.confirmation.taxonomyVersionId
          || current.taxonomyVersionId !== inspection.taxonomy.versionId
          || !sameJson(current.allowedBrands, selection.match.allowedBrands)
        ) {
          throw new ReviewedFamilyPlanError("CANDIDATE_CONFIRMATION_STALE");
        }
      }
    }

    const requestedCatalogGtins = directImpactCatalogGtins(input);
    let directProducts: ExactProductPlanApiProductSummary[];
    try {
      const rawProducts = await this.dependencies.catalog.getMany(
        requestedCatalogGtins,
        evaluatedAt,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
      const parsedProducts = z.array(exactProductPlanApiProductSummarySchema)
        .max(DISCOVERY_IMPACT_PRODUCT_UNION_MAX)
        .safeParse(rawProducts);
      if (!parsedProducts.success) throw new CatalogUnavailableError();
      directProducts = [...parsedProducts.data].sort((left, right) =>
        compareText(left.gtin, right.gtin));
      const requested = new Set(requestedCatalogGtins);
      if (
        new Set(directProducts.map(({ gtin }) => gtin)).size
          !== directProducts.length
        || directProducts.some(({ gtin }) => !requested.has(gtin))
      ) {
        throw new CatalogUnavailableError();
      }
      validateCatalogAt(directProducts, evaluatedAt, reviewedInput !== undefined);
    } catch (error) {
      if (error instanceof PlanRequestCancelledError || signal?.aborted) {
        throw new PlanRequestCancelledError();
      }
      if (error instanceof CatalogUnavailableError) throw error;
      throw new CatalogUnavailableError();
    }

    const baselineExactGtins = input.planning.contractVersion === 1
      ? requestedExactGtins(input.planning)
      : exactCatalogGtins(input.planning);
    const directGtinSet = new Set(directProducts.map(({ gtin }) => gtin));
    if (baselineExactGtins.some((gtin) => !directGtinSet.has(gtin))) {
      throw new UnknownExactProductError();
    }

    const candidateGtins = inspection?.productClaims.map(
      ({ product }) => product.gtin,
    ) ?? [];
    if (new Set(candidateGtins).size !== candidateGtins.length) {
      throw new FamilyCandidateServiceError("AMBIGUOUS_FAMILY_MEMBERSHIP");
    }
    const gtins = [...new Set([
      ...candidateGtins,
      ...directProducts.map(({ gtin }) => gtin),
    ])].sort(compareText);
    if (gtins.length < 1 || gtins.length > DISCOVERY_IMPACT_PRODUCT_UNION_MAX) {
      throw new FamilyCandidateServiceError("CANDIDATE_SET_TOO_LARGE");
    }
    if (this.dependencies.priceService?.readProducts === undefined) {
      throw new PriceDataUnavailableError();
    }

    let priceResult: ProductPriceServiceResult;
    try {
      priceResult = await this.dependencies.priceService.readProducts(
        gtins,
        input.planning.marketContext,
        evaluatedAt,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
    } catch (error) {
      if (
        error instanceof PlanRequestCancelledError
        || signal?.aborted
        || (error instanceof PriceServiceError && error.code === "CANCELLED")
      ) {
        throw new PlanRequestCancelledError();
      }
      throw new PriceDataUnavailableError();
    }

    try {
      const { identityByGtin } = validatePriceUnion(gtins, priceResult);
      let planning: ServerPlanningInputV2;
      let baselineCandidateSets: DiscoveryImpactBaselineCandidateSetV1[];
      if (reviewedInput === undefined || inspection === undefined) {
        planning = exactImpactPlannerInput(
          input.planning as ExactProductPlanApiRequest,
          directProducts,
          identityByGtin,
          priceResult,
        );
        baselineCandidateSets = impactBaselineCandidateSets(
          planning,
          undefined,
          undefined,
        );
      } else {
        const productClaims = productClaimsForMixedPlan(
          directProducts,
          inspection,
          identityByGtin,
        );
        if (productClaims.length > DISCOVERY_IMPACT_PRODUCT_UNION_MAX) {
          throw new FamilyCandidateServiceError("CANDIDATE_SET_TOO_LARGE");
        }
        const needMatches = needMatchesForMixedPlan(
          reviewedInput,
          inspection,
          identityByGtin,
        );
        planning = mixedPlannerInput(
          reviewedInput,
          needMatches,
          productClaims,
          familyByCanonicalProduct(inspection),
          priceResult,
        );
        baselineCandidateSets = impactBaselineCandidateSets(
          planning,
          needMatches,
          productClaims,
        );
      }

      return {
        baselineCandidateSets,
        comparisonCoverageByCanonicalProductId: new Map(
          priceResult.productEvidence.map((entry) => [
            entry.canonicalProductId,
            entry.comparisonScope.completeness,
          ]),
        ),
        evaluatedAt,
        planning,
      };
    } catch (error) {
      if (
        error instanceof PlanRequestCancelledError
        || error instanceof PriceDataUnavailableError
        || error instanceof CatalogUnavailableError
        || error instanceof ReviewedFamilyPlanError
        || error instanceof FamilyCandidateServiceError
      ) {
        throw error;
      }
      throw new PriceDataUnavailableError();
    }
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
      const completeCandidateEvidence = attachAssignmentEvidence(
        priceResult.evidence,
        completeCandidates,
        products,
      );
      const evidence = attachAssignmentEvidence(priceResult.evidence, plans, products);
      const generatedAt = catalogAt.toISOString();
      const geographicDirectoryAttestation = attestGeographicDirectoryRegionV1(
        priceResult.geographicDirectory,
        input.marketContext.kind === "launch-region"
          ? input.marketContext.regionId
          : undefined,
      );
      const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
        evidence,
        generatedAt,
        marketContext: input.marketContext,
        plans,
      });
      if (planDeltaExplanations === undefined) throw new PriceDataUnavailableError();
      return {
        completeCandidateSet: {
          evidence: completeCandidateEvidence,
          plans: completeCandidates,
        },
        evidence,
        generatedAt,
        ...(geographicDirectoryAttestation === undefined
          ? {}
          : { geographicDirectoryAttestation }),
        planDeltaExplanations,
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

  async calculateReviewed(
    request: ReviewedFamilyPlanApiRequestV2,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyPlanServiceResult> {
    if (signal?.aborted) throw new PlanRequestCancelledError();
    const parsed = reviewedFamilyPlanApiRequestV2Schema.safeParse(request);
    if (!parsed.success) throw new ReviewedFamilyPlanError("INVALID_REQUEST");
    const input = parsed.data;
    const evaluatedAt = this.now();
    if (!(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.getTime())) {
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }

    const selections = uniqueFamilySelections(input);
    const inspectionRequest = candidateInspectionRequest(selections);
    if (this.dependencies.familyCandidateService === undefined) {
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }

    let inspection: ReviewedFamilyCandidateInspectionResponse;
    try {
      const rawInspection = await this.dependencies.familyCandidateService.inspectAt(
        inspectionRequest,
        evaluatedAt,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
      const validatedInspection = reviewedFamilyCandidateInspectionResponseSchemaFor(
        inspectionRequest,
      ).safeParse(rawInspection);
      if (
        !validatedInspection.success
        || validatedInspection.data.generatedAt !== evaluatedAt.toISOString()
      ) {
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }
      inspection = validatedInspection.data;
    } catch (error) {
      if (
        error instanceof PlanRequestCancelledError
        || signal?.aborted
        || (error instanceof FamilyCandidateServiceError
          && error.code === "REQUEST_CANCELLED")
      ) {
        throw new PlanRequestCancelledError();
      }
      if (error instanceof FamilyCandidateServiceError) throw error;
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }

    const candidateSetByFamily = inspectedCandidateSetByFamily(inspection);
    for (const selection of selections) {
      const current = candidateSetByFamily.get(selection.match.familyId);
      if (
        current === undefined
        || current.candidateSetId !== selection.match.confirmation.candidateSetId
        || current.taxonomyVersionId !== selection.match.confirmation.taxonomyVersionId
        || current.taxonomyVersionId !== inspection.taxonomy.versionId
        || !sameJson(current.allowedBrands, selection.match.allowedBrands)
      ) {
        throw new ReviewedFamilyPlanError("CANDIDATE_CONFIRMATION_STALE");
      }
    }

    const exactGtins = exactCatalogGtins(input);
    let exactProducts: ExactProductPlanApiProductSummary[] = [];
    if (exactGtins.length > 0) {
      if (this.dependencies.catalog === undefined) throw new CatalogUnavailableError();
      try {
        const rawProducts = await this.dependencies.catalog.getMany(
          exactGtins,
          evaluatedAt,
          signal,
        );
        if (signal?.aborted) throw new PlanRequestCancelledError();
        const parsedProducts = z.array(exactProductPlanApiProductSummarySchema).max(50)
          .safeParse(rawProducts);
        if (!parsedProducts.success) throw new CatalogUnavailableError();
        exactProducts = parsedProducts.data;
        validateCatalogAt(exactProducts, evaluatedAt, true);
        if (!summariesExactlyCover(exactGtins, exactProducts)) {
          throw new UnknownExactProductError();
        }
      } catch (error) {
        if (error instanceof PlanRequestCancelledError || signal?.aborted) {
          throw new PlanRequestCancelledError();
        }
        if (
          error instanceof CatalogUnavailableError
          || error instanceof UnknownExactProductError
        ) {
          throw error;
        }
        throw new CatalogUnavailableError();
      }
    }

    const candidateGtins = inspection.productClaims.map(({ product }) => product.gtin);
    if (new Set(candidateGtins).size !== candidateGtins.length) {
      throw new FamilyCandidateServiceError("AMBIGUOUS_FAMILY_MEMBERSHIP");
    }
    const gtins = [...new Set([
      ...candidateGtins,
      ...exactProducts.map(({ gtin }) => gtin),
    ])].sort(compareText);
    if (gtins.length > 50) {
      throw new FamilyCandidateServiceError("CANDIDATE_SET_TOO_LARGE");
    }
    if (this.dependencies.priceService?.readProducts === undefined) {
      throw new PriceDataUnavailableError();
    }

    let priceResult: ProductPriceServiceResult;
    try {
      priceResult = await this.dependencies.priceService.readProducts(
        gtins,
        input.marketContext,
        evaluatedAt,
        signal,
      );
      if (signal?.aborted) throw new PlanRequestCancelledError();
    } catch (error) {
      if (
        error instanceof PlanRequestCancelledError
        || signal?.aborted
        || (error instanceof PriceServiceError && error.code === "CANCELLED")
      ) {
        throw new PlanRequestCancelledError();
      }
      throw new PriceDataUnavailableError();
    }

    try {
      const { identityByGtin } = validatePriceUnion(gtins, priceResult);
      const productClaims = productClaimsForMixedPlan(
        exactProducts,
        inspection,
        identityByGtin,
      );
      if (productClaims.length > 50) {
        throw new FamilyCandidateServiceError("CANDIDATE_SET_TOO_LARGE");
      }
      const familyByProduct = familyByCanonicalProduct(inspection);
      const needMatches = needMatchesForMixedPlan(input, inspection, identityByGtin);
      const planningInput = mixedPlannerInput(
        input,
        needMatches,
        productClaims,
        familyByProduct,
        priceResult,
      );
      const completeCandidates = enumerateCompletePlanCandidatesV2(
        planningInput,
        evaluatedAt,
      );
      const plans = projectRepresentativesV2(
        paretoFrontierV2(completeCandidates),
        7,
      );
      const completeCandidateEvidence = visibleMixedEvidence(
        needMatches,
        productClaims,
        inspection,
        priceResult,
        completeCandidates,
      );
      const evidence = visibleMixedEvidence(
        needMatches,
        productClaims,
        inspection,
        priceResult,
        plans,
      );
      const planDeltaExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
        evidence,
        generatedAt: evaluatedAt.toISOString(),
        marketContext: input.marketContext,
        plans,
      });
      if (planDeltaExplanations === undefined) throw new PriceDataUnavailableError();
      const geographicDirectoryAttestation = attestGeographicDirectoryRegionV1(
        priceResult.geographicDirectory,
        input.marketContext.kind === "launch-region"
          ? input.marketContext.regionId
          : undefined,
      );
      const fullResponse = reviewedFamilyPlanApiResponseV2SchemaFor(input).safeParse({
        caveats: [],
        contractVersion: 2,
        evidence,
        enabledMembershipProgramIds: input.enabledMembershipProgramIds,
        generatedAt: evaluatedAt.toISOString(),
        ...(geographicDirectoryAttestation === undefined
          ? {}
          : { geographicDirectoryAttestation }),
        marketContext: input.marketContext,
        needMatches,
        planDeltaExplanations,
        plans,
        priceDataSource: "cache",
        productClaims,
        taxonomy: inspection.taxonomy,
      });
      if (!fullResponse.success) throw new PriceDataUnavailableError();
      return {
        completeCandidateSet: {
          evidence: completeCandidateEvidence,
          plans: completeCandidates,
        },
        evidence: fullResponse.data.evidence,
        generatedAt: fullResponse.data.generatedAt,
        ...(fullResponse.data.geographicDirectoryAttestation === undefined
          ? {}
          : {
              geographicDirectoryAttestation:
                fullResponse.data.geographicDirectoryAttestation,
            }),
        needMatches: fullResponse.data.needMatches,
        planDeltaExplanations: fullResponse.data.planDeltaExplanations,
        plans: fullResponse.data.plans,
        priceDataSource: fullResponse.data.priceDataSource,
        productClaims: fullResponse.data.productClaims,
        taxonomy: fullResponse.data.taxonomy,
      };
    } catch (error) {
      if (
        error instanceof PlanRequestCancelledError
        || error instanceof PriceDataUnavailableError
        || error instanceof CatalogUnavailableError
        || error instanceof ReviewedFamilyPlanError
        || error instanceof FamilyCandidateServiceError
      ) {
        throw error;
      }
      throw new PriceDataUnavailableError();
    }
  }
}
