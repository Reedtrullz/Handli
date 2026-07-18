import {
  canonicalTimestampSchema,
  createTripSnapshotV2,
  EXACT_PRODUCT_OFFER_MAX_AGE_MS,
  exactProductPlanApiRequestSchema,
  exactProductPlanApiResponseSchema,
  exactProductPlanApiResponseSchemaFor,
  planResultV2Schema,
  reviewedFamilyPlanApiRequestV2Schema,
  reviewedFamilyPlanApiResponseV2Schema,
  reviewedFamilyPlanApiResponseV2SchemaFor,
  travelPlanApiRequestSchema,
  travelPlanApiResponseSchemaFor,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type ExactProductPlanApiResponse,
  type GeographicDirectoryRegionAttestationV1,
  type MarketContextV1,
  type PlanResultV2,
  type ReviewedFamilyPlanApiRequestV2,
  type ReviewedFamilyPlanApiResponseV2,
  type TravelPlanApiRequest,
  type TravelPlanApiResponse,
  type TravelRouteEvidence,
  type TripPurchaseEvidenceV2Input,
  type TripReviewedFamilyEvidenceV2,
  type TripSnapshotV2,
} from "@handleplan/domain";

const ORDINARY_PRICE_VALIDITY_MS = 72 * 60 * 60 * 1_000;
const CATALOG_VALIDITY_MS = 48 * 60 * 60 * 1_000;

export type StrictResultTripErrorCode = "EXPIRED_EVIDENCE" | "INVALID_EVIDENCE";

export class StrictResultTripError extends Error {
  constructor(readonly code: StrictResultTripErrorCode) {
    super(code === "EXPIRED_EVIDENCE"
      ? "The selected plan evidence has expired"
      : "The selected plan evidence is invalid");
    this.name = "StrictResultTripError";
  }
}

interface StrictResultTripCommonInput {
  tripId: string;
  now: Date;
  plan: PlanResultV2;
  travelBinding?: StrictTravelPlanBinding;
}

export interface StrictTravelPlanBinding {
  request: TravelPlanApiRequest;
  response: TravelPlanApiResponse;
}

export type StrictResultTripInput = StrictResultTripCommonInput & (
  | {
      kind?: "exact-product";
      exactRequest: ExactProductPlanApiRequest;
      exactResponse: ExactProductPlanApiResponse;
      reviewedRequest?: never;
      reviewedResponse?: never;
    }
  | {
      kind: "reviewed-family";
      reviewedRequest: ReviewedFamilyPlanApiRequestV2;
      reviewedResponse: ReviewedFamilyPlanApiResponseV2;
      exactRequest?: never;
      exactResponse?: never;
    }
);

function invalid(): never {
  throw new StrictResultTripError("INVALID_EVIDENCE");
}

function timestamp(value: string): number {
  const parsed = canonicalTimestampSchema.safeParse(value);
  if (!parsed.success) invalid();
  const milliseconds = Date.parse(parsed.data);
  if (!Number.isFinite(milliseconds)) invalid();
  return milliseconds;
}

function expiresAfter(observedAt: string, validityMs: number): number {
  const observedAtMs = timestamp(observedAt);
  const expiresAtMs = observedAtMs + validityMs;
  if (!Number.isSafeInteger(expiresAtMs)) invalid();
  return expiresAtMs;
}

export function createLocalTripId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure local identifiers are unavailable");
  }
  return `trip:${globalThis.crypto.randomUUID()}`;
}

type TripAssignmentEvidence = ExactProductPlanApiEvidenceEnvelope[
  "assignmentEvidence"
][number];
type TripOrdinaryPrice = ExactProductPlanApiEvidenceEnvelope[
  "needs"
][number]["ordinaryPrices"][number];
type TripOfficialOffer = ExactProductPlanApiEvidenceEnvelope[
  "needs"
][number]["officialOffers"][number];

interface StrictTripMaterial {
  assignmentEvidence: TripAssignmentEvidence[];
  officialOffers: TripOfficialOffer[];
  ordinaryPrices: TripOrdinaryPrice[];
  products: ExactProductPlanApiProductSummary[];
  reviewedFamilyEvidence?: TripReviewedFamilyEvidenceV2;
}

interface BoundStrictTripMaterial {
  caveats: readonly string[];
  enabledMembershipProgramIds: readonly string[];
  generatedAt: string;
  geographicDirectoryAttestation?: GeographicDirectoryRegionAttestationV1;
  marketContext: MarketContextV1;
  material: StrictTripMaterial;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactTripMaterial(
  input: Extract<StrictResultTripInput, { kind?: "exact-product" }>,
  plan: PlanResultV2,
  travelRoutes?: readonly TravelRouteEvidence[],
): BoundStrictTripMaterial {
  const request = exactProductPlanApiRequestSchema.safeParse(input.exactRequest);
  const response = exactProductPlanApiResponseSchema.safeParse(input.exactResponse);
  if (!request.success || !response.success) invalid();

  const boundResponse = exactProductPlanApiResponseSchemaFor(request.data, {
    travelRoutes,
  }).safeParse(response.data);
  if (!boundResponse.success) invalid();
  const matchingPlans = response.data.plans.filter((candidate) =>
    candidate.id === plan.id && sameJson(candidate, plan));
  if (matchingPlans.length !== 1) invalid();

  return {
    caveats: response.data.caveats,
    enabledMembershipProgramIds: request.data.enabledMembershipProgramIds,
    generatedAt: response.data.generatedAt,
    ...(response.data.geographicDirectoryAttestation === undefined
      ? {}
      : {
          geographicDirectoryAttestation:
            response.data.geographicDirectoryAttestation,
        }),
    marketContext: response.data.marketContext,
    material: {
      assignmentEvidence: response.data.evidence.assignmentEvidence,
      officialOffers: response.data.evidence.needs.flatMap(({ officialOffers }) => officialOffers),
      ordinaryPrices: response.data.evidence.needs.flatMap(({ ordinaryPrices }) => ordinaryPrices),
      products: response.data.products,
    },
  };
}

function reviewedTripMaterial(
  input: Extract<StrictResultTripInput, { kind: "reviewed-family" }>,
  plan: PlanResultV2,
  travelRoutes?: readonly TravelRouteEvidence[],
): BoundStrictTripMaterial {
  const request = reviewedFamilyPlanApiRequestV2Schema.safeParse(input.reviewedRequest);
  const response = reviewedFamilyPlanApiResponseV2Schema.safeParse(input.reviewedResponse);
  if (!request.success || !response.success) invalid();
  const boundResponse = reviewedFamilyPlanApiResponseV2SchemaFor(request.data, {
    travelRoutes,
  }).safeParse(response.data);
  if (!boundResponse.success) invalid();
  const matchingPlans = response.data.plans.filter((candidate) =>
    candidate.id === plan.id && sameJson(candidate, plan));
  if (matchingPlans.length !== 1) invalid();

  const selectedCanonicalIds = [...new Set(
    plan.assignments.map(({ canonicalProductId }) => canonicalProductId),
  )].sort(compareText);
  const productClaims = response.data.productClaims
    .filter(({ canonicalProductId }) => selectedCanonicalIds.includes(canonicalProductId))
    .sort((left, right) => compareText(left.canonicalProductId, right.canonicalProductId));
  if (
    productClaims.length !== selectedCanonicalIds.length
    || productClaims.some(({ canonicalProductId }, index) =>
      canonicalProductId !== selectedCanonicalIds[index])
  ) invalid();

  const assignmentEvidence = response.data.evidence.assignmentEvidence
    .filter(({ planId }) => planId === plan.id)
    .sort((left, right) =>
      compareText(left.planId, right.planId)
      || compareText(left.needId, right.needId)
      || compareText(left.chainId, right.chainId));
  if (assignmentEvidence.length !== plan.assignments.length) invalid();

  const ordinaryIds = [...new Set(assignmentEvidence.map(({ evidenceId }) => evidenceId))]
    .sort(compareText);
  const ordinaryPrices = response.data.evidence.ordinaryPrices
    .filter(({ id }) => ordinaryIds.includes(id))
    .sort((left, right) => compareText(left.id, right.id));
  if (
    ordinaryPrices.length !== ordinaryIds.length
    || ordinaryPrices.some(({ id }, index) => id !== ordinaryIds[index])
  ) invalid();

  const offerIds = [...new Set(assignmentEvidence.flatMap(({ conditions }) =>
    conditions.kind === "official-offer" ? [conditions.offerId] : []))]
    .sort(compareText);
  const officialOffers = response.data.evidence.officialOffers
    .filter(({ id }) => offerIds.includes(id))
    .sort((left, right) => compareText(left.id, right.id));
  if (
    officialOffers.length !== offerIds.length
    || officialOffers.some(({ id }, index) => id !== offerIds[index])
  ) invalid();

  const matchByNeed = new Map(response.data.needMatches.map((match) => [match.needId, match]));
  const membershipByKey = new Map(response.data.evidence.memberships.map((membership) => [
    `${membership.familyId}\u0000${membership.canonicalProductId}`,
    membership,
  ]));
  const selectedMemberships = new Map<string, ReviewedFamilyPlanApiResponseV2[
    "evidence"
  ]["memberships"][number]>();
  for (const assignment of plan.assignments) {
    const match = matchByNeed.get(assignment.needId);
    if (match?.kind !== "reviewed-family") continue;
    const key = `${match.familyId}\u0000${assignment.canonicalProductId}`;
    const membership = membershipByKey.get(key);
    if (membership === undefined) invalid();
    selectedMemberships.set(key, membership);
  }

  const reviewedFamilyEvidence: TripReviewedFamilyEvidenceV2 = {
    assignmentEvidence,
    memberships: [...selectedMemberships.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, membership]) => membership),
    needMatches: response.data.needMatches,
    officialOffers,
    ordinaryPrices,
    productClaims,
    request: request.data,
    taxonomy: response.data.taxonomy,
  };
  return {
    caveats: response.data.caveats,
    enabledMembershipProgramIds: request.data.enabledMembershipProgramIds,
    generatedAt: response.data.generatedAt,
    ...(response.data.geographicDirectoryAttestation === undefined
      ? {}
      : {
          geographicDirectoryAttestation:
            response.data.geographicDirectoryAttestation,
        }),
    marketContext: response.data.marketContext,
    material: {
      assignmentEvidence,
      officialOffers,
      ordinaryPrices,
      products: productClaims.map(({ product }) => product),
      reviewedFamilyEvidence,
    },
  };
}

export function createStrictResultTripSnapshot(
  input: StrictResultTripInput,
): TripSnapshotV2 {
  const parsedPlan = planResultV2Schema.safeParse(input.plan);
  if (!parsedPlan.success) invalid();

  const plan = parsedPlan.data;
  let travelRoutes: readonly TravelRouteEvidence[] | undefined;
  let travelRoute: TravelRouteEvidence | undefined;
  if (input.travelBinding !== undefined) {
    const travelRequest = travelPlanApiRequestSchema.safeParse(input.travelBinding.request);
    if (!travelRequest.success) invalid();
    const travelResponse = travelPlanApiResponseSchemaFor(travelRequest.data)
      .safeParse(input.travelBinding.response);
    if (
      !travelResponse.success
      || travelResponse.data.travel.kind !== "calculated"
    ) invalid();

    const primaryRequest = input.kind === "reviewed-family"
      ? input.reviewedRequest
      : input.exactRequest;
    const primaryResponse = input.kind === "reviewed-family"
      ? input.reviewedResponse
      : input.exactResponse;
    if (
      !sameJson(travelRequest.data.planning, primaryRequest)
      || !sameJson(travelResponse.data.planning, primaryResponse)
    ) invalid();

    travelRoutes = travelResponse.data.travel.routes;
    const matchingRoutes = travelRoutes.filter(({ planId }) => planId === plan.id);
    if (matchingRoutes.length !== 1) invalid();
    travelRoute = matchingRoutes[0]!;
  }

  const bound = input.kind === "reviewed-family"
    ? reviewedTripMaterial(input, plan, travelRoutes)
    : exactTripMaterial(input, plan, travelRoutes);
  const material = bound.material;
  const products = material.products;
  const evaluatedAtMs = timestamp(bound.generatedAt);
  const clientNowMs = input.now.getTime();
  if (!Number.isFinite(clientNowMs)) invalid();
  const createdAtMs = Math.max(evaluatedAtMs, clientNowMs);

  const selectedGtins = [...new Set(plan.assignments.map(({ ean }) => ean))];
  const selectedProducts = selectedGtins.map((gtin) => {
    const matches = products.filter((product) => product.gtin === gtin);
    if (matches.length !== 1) return invalid();
    return matches[0]!;
  });
  const expiryCandidates: number[] = [];
  const purchaseEvidence: TripPurchaseEvidenceV2Input[] = [];

  if (bound.geographicDirectoryAttestation?.validUntil !== undefined) {
    expiryCandidates.push(timestamp(bound.geographicDirectoryAttestation.validUntil));
  }

  if (travelRoute !== undefined) {
    const planChains = [...plan.chains].sort();
    const routeChains = travelRoute.stops.map(({ chainId }) => chainId).sort();
    if (
      travelRoute.planId !== plan.id
      || travelRoute.aggregate.calculatedAt !== bound.generatedAt
      || routeChains.length !== planChains.length
      || routeChains.some((chainId, index) => chainId !== planChains[index])
    ) invalid();
  }

  for (const product of selectedProducts) {
    const observedAtMs = timestamp(product.catalogEvidence.observedAt);
    if (observedAtMs > evaluatedAtMs) invalid();
    expiryCandidates.push(expiresAfter(product.catalogEvidence.observedAt, CATALOG_VALIDITY_MS));
  }

  for (const assignment of plan.assignments) {
    const references = material.assignmentEvidence.filter((reference) =>
      reference.planId === plan.id
      && reference.needId === assignment.needId
      && reference.chainId === assignment.chain);
    if (references.length !== 1) invalid();
    const reference = references[0]!;
    const ordinaryMatches = material.ordinaryPrices.filter(({ id }) =>
      id === reference.evidenceId);
    if (ordinaryMatches.length !== 1) invalid();
    const ordinary = ordinaryMatches[0]!;
    if (
      ordinary === undefined
      || ordinary.chainId !== assignment.chain
      || ordinary.sourceId !== assignment.source
      || ordinary.observedAt !== assignment.observedAt
      || ordinary.productMatch.kind !== "exact"
      || ordinary.productMatch.canonicalProductId !== assignment.canonicalProductId
      || BigInt(ordinary.amountOre) * BigInt(assignment.fulfilment.packageCount)
        !== BigInt(assignment.checkout.ordinaryTotalOre)
    ) invalid();

    const ordinaryObservedAtMs = timestamp(ordinary.observedAt);
    if (ordinaryObservedAtMs > evaluatedAtMs) invalid();
    if (ordinary.validFrom !== undefined && timestamp(ordinary.validFrom) > evaluatedAtMs) invalid();
    expiryCandidates.push(expiresAfter(ordinary.observedAt, ORDINARY_PRICE_VALIDITY_MS));
    if (ordinary.validUntil !== undefined) expiryCandidates.push(timestamp(ordinary.validUntil));

    if (assignment.checkout.appliedOfferId === undefined) {
      if (reference.conditions.kind !== "ordinary-price" || assignment.officialOffer !== undefined) {
        invalid();
      }
      purchaseEvidence.push({ needId: assignment.needId, ordinaryPrice: ordinary });
      continue;
    }

    const conditions = reference.conditions;
    if (
      conditions.kind !== "official-offer"
      || conditions.offerId !== assignment.checkout.appliedOfferId
    ) invalid();
    const appliedOffer = assignment.officialOffer;
    if (appliedOffer === undefined) invalid();
    const offerMatches = material.officialOffers.filter(({ id }) =>
      id === conditions.offerId);
    if (offerMatches.length !== 1) invalid();
    const offer = offerMatches[0]!;
    if (
      offer === undefined
      || offer.id !== appliedOffer.id
      || offer.chainId !== assignment.chain
      || offer.sourceId !== appliedOffer.sourceId
      || offer.sourceRecordId !== appliedOffer.sourceRecordId
      || offer.capturedAt !== appliedOffer.capturedAt
      || offer.productMatch.kind !== "exact"
      || offer.productMatch.canonicalProductId !== assignment.canonicalProductId
      || offer.conditions.some((condition) =>
        condition.kind === "member"
        && !bound.enabledMembershipProgramIds.includes(condition.programId)
      )
      || !offer.applicability.channels.includes("in-store")
      || timestamp(offer.capturedAt) > evaluatedAtMs
      || timestamp(offer.applicability.startsAt) > evaluatedAtMs
    ) invalid();
    expiryCandidates.push(timestamp(offer.applicability.endsAt));
    expiryCandidates.push(expiresAfter(offer.capturedAt, EXACT_PRODUCT_OFFER_MAX_AGE_MS));
    purchaseEvidence.push({
      appliedOffer: offer,
      needId: assignment.needId,
      ordinaryPrice: ordinary,
    });
  }

  const expiresAtMs = Math.min(...expiryCandidates);
  if (
    expiryCandidates.length === 0
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= evaluatedAtMs
    || expiresAtMs <= createdAtMs
  ) {
    throw new StrictResultTripError("EXPIRED_EVIDENCE");
  }

  try {
    return createTripSnapshotV2({
      caveats: [...bound.caveats],
      createdAt: new Date(createdAtMs).toISOString(),
      evaluatedAt: new Date(evaluatedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      enabledMembershipProgramIds: [...bound.enabledMembershipProgramIds],
      ...(bound.geographicDirectoryAttestation === undefined
        ? {}
        : { geographicDirectoryAttestation: bound.geographicDirectoryAttestation }),
      id: input.tripId,
      marketContext: bound.marketContext,
      navigation: travelRoute === undefined
        ? { kind: "price-only" }
        : {
            aggregate: {
              calculatedAt: travelRoute.aggregate.calculatedAt,
              distanceMeters: travelRoute.aggregate.distanceMeters,
              durationSeconds: travelRoute.aggregate.durationSeconds,
              mode: travelRoute.aggregate.mode,
              sourceId: travelRoute.aggregate.providerSourceId,
              sourceRecordId: travelRoute.aggregate.routeFingerprint,
            },
            kind: "route",
            stops: travelRoute.stops.map((stop) => ({
              branchId: stop.branchId,
              chainId: stop.chainId,
              kind: "branch-stop" as const,
              name: stop.name,
              sequence: stop.sequence,
            })),
          },
      plan,
      products: selectedProducts,
      purchaseEvidence,
      reviewedFamilyEvidence: material.reviewedFamilyEvidence,
    });
  } catch (error) {
    if (error instanceof StrictResultTripError) throw error;
    return invalid();
  }
}
