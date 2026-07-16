import {
  canonicalTimestampSchema,
  createTripSnapshot,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiProductSummarySchema,
  planResultV2Schema,
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiProductSummary,
  type PlanResultV2,
  type TripSnapshotV1,
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

export interface StrictResultTripInput {
  tripId: string;
  now: Date;
  generatedAt: string;
  plan: PlanResultV2;
  products: readonly ExactProductPlanApiProductSummary[];
  evidence: ExactProductPlanApiEvidenceEnvelope;
  caveats: readonly string[];
}

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

export function createStrictResultTripSnapshot(
  input: StrictResultTripInput,
): TripSnapshotV1 {
  const parsedPlan = planResultV2Schema.safeParse(input.plan);
  const parsedEvidence = exactProductPlanApiEvidenceEnvelopeSchema.safeParse(input.evidence);
  const parsedProducts = input.products.map((product) =>
    exactProductPlanApiProductSummarySchema.safeParse(product));
  if (
    !parsedPlan.success
    || !parsedEvidence.success
    || parsedProducts.some((product) => !product.success)
  ) invalid();

  const plan = parsedPlan.data;
  const evidence = parsedEvidence.data;
  const products = parsedProducts.map((product) => {
    if (!product.success) return invalid();
    return product.data;
  });
  const evaluatedAtMs = timestamp(input.generatedAt);
  const clientNowMs = input.now.getTime();
  if (!Number.isFinite(clientNowMs)) invalid();
  const createdAtMs = Math.max(evaluatedAtMs, clientNowMs);

  const selectedGtins = [...new Set(plan.assignments.map(({ ean }) => ean))];
  const selectedProducts = selectedGtins.map((gtin) => {
    const matches = products.filter((product) => product.gtin === gtin);
    if (matches.length !== 1) return invalid();
    return matches[0]!;
  });
  const needEvidenceById = new Map(evidence.needs.map((entry) => [entry.needId, entry]));
  const expiryCandidates: number[] = [];

  for (const product of selectedProducts) {
    const observedAtMs = timestamp(product.catalogEvidence.observedAt);
    if (observedAtMs > evaluatedAtMs) invalid();
    expiryCandidates.push(expiresAfter(product.catalogEvidence.observedAt, CATALOG_VALIDITY_MS));
  }

  for (const assignment of plan.assignments) {
    const references = evidence.assignmentEvidence.filter((reference) =>
      reference.planId === plan.id
      && reference.needId === assignment.needId
      && reference.chainId === assignment.chain);
    if (references.length !== 1) invalid();
    const reference = references[0]!;
    const needEvidence = needEvidenceById.get(assignment.needId);
    if (needEvidence === undefined) invalid();
    const ordinary = needEvidence.ordinaryPrices.find(({ id }) => id === reference.evidenceId);
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
      continue;
    }

    const conditions = reference.conditions;
    if (
      conditions.kind !== "official-offer"
      || conditions.offerId !== assignment.checkout.appliedOfferId
    ) invalid();
    const appliedOffer = assignment.officialOffer;
    if (appliedOffer === undefined) invalid();
    const offer = needEvidence.officialOffers.find(({ id }) =>
      id === conditions.offerId);
    if (
      offer === undefined
      || offer.id !== appliedOffer.id
      || offer.chainId !== assignment.chain
      || offer.sourceId !== appliedOffer.sourceId
      || offer.sourceRecordId !== appliedOffer.sourceRecordId
      || offer.capturedAt !== appliedOffer.capturedAt
      || offer.productMatch.kind !== "exact"
      || offer.productMatch.canonicalProductId !== assignment.canonicalProductId
      || !offer.conditions.some(({ kind }) => kind === "public")
      || !offer.applicability.channels.includes("in-store")
      || timestamp(offer.capturedAt) > evaluatedAtMs
      || timestamp(offer.applicability.startsAt) > evaluatedAtMs
    ) invalid();
    expiryCandidates.push(timestamp(offer.applicability.endsAt));
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
    return createTripSnapshot({
      caveats: [...input.caveats],
      createdAt: new Date(createdAtMs).toISOString(),
      evaluatedAt: new Date(evaluatedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      id: input.tripId,
      navigation: { kind: "price-only" },
      plan,
      products: selectedProducts,
    });
  } catch (error) {
    if (error instanceof StrictResultTripError) throw error;
    return invalid();
  }
}
