import "server-only";

import {
  ReviewedFamilyReaderError,
  type ReviewedFamilyCatalogMatch,
  type ReviewedFamilyReader,
  type ReviewedFamilySnapshot,
} from "@handleplan/db/reviewed-family-reader";
import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT,
  exactProductPlanApiProductSummarySchema,
  normalizeReviewedFamilyAllowedBrand,
  reviewedFamilyCandidateInspectionRequestSchema,
  reviewedFamilyCandidateInspectionResponseSchemaFor,
  reviewedFamilyDescriptorSchema,
  reviewedFamilyPublicMembershipEvidenceSchema,
  reviewedFamilyPublicTaxonomyEvidenceSchema,
  type ReviewedFamilyCandidateInspectionRequest,
  type ReviewedFamilyCandidateInspectionResponse,
  type ReviewedFamilyPublicMembershipEvidence,
} from "@handleplan/domain";

import { createCandidateSetId } from "./candidate-set";

const PRODUCTS_PER_FAMILY = 20;

export type FamilyCandidateServiceErrorCode =
  | "AMBIGUOUS_FAMILY_MEMBERSHIP"
  | "CANDIDATE_SET_INCOMPLETE"
  | "CANDIDATE_SET_TOO_LARGE"
  | "EVIDENCE_UNAVAILABLE"
  | "FAMILY_NO_CANDIDATES"
  | "INVALID_REQUEST"
  | "NO_MATCHING_BRANDS"
  | "REQUEST_CANCELLED"
  | "UNKNOWN_FAMILY";

const errorMessages: Readonly<Record<FamilyCandidateServiceErrorCode, string>> = {
  AMBIGUOUS_FAMILY_MEMBERSHIP: "Reviewed family membership is ambiguous",
  CANDIDATE_SET_INCOMPLETE: "Reviewed family candidates are incomplete",
  CANDIDATE_SET_TOO_LARGE: "Reviewed family candidate set is too large",
  EVIDENCE_UNAVAILABLE: "Reviewed family evidence is unavailable",
  FAMILY_NO_CANDIDATES: "Reviewed family has no eligible candidates",
  INVALID_REQUEST: "Reviewed family request is invalid",
  NO_MATCHING_BRANDS: "Reviewed family has no candidates for the selected brands",
  REQUEST_CANCELLED: "Reviewed family request was cancelled",
  UNKNOWN_FAMILY: "Reviewed family is unknown",
};

export class FamilyCandidateServiceError extends Error {
  readonly code: FamilyCandidateServiceErrorCode;

  constructor(code: FamilyCandidateServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "FamilyCandidateServiceError";
    this.code = code;
  }
}

export interface FamilyCandidateServiceContract {
  inspect(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCandidateInspectionResponse>;
}

/**
 * Internal evaluation boundary used by planning so candidate evidence, catalog
 * evidence, and price evidence are all evaluated against one captured instant.
 * The public candidate route continues to expose only `inspect`.
 */
export interface FamilyCandidateEvaluationContract {
  inspectAt(
    request: unknown,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCandidateInspectionResponse>;
}

interface FamilyCandidateServiceDependencies {
  now?: () => Date;
  reader: ReviewedFamilyReader;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function publicMembership(
  match: ReviewedFamilyCatalogMatch,
): ReviewedFamilyPublicMembershipEvidence {
  return reviewedFamilyPublicMembershipEvidenceSchema.parse({
    canonicalProductId: match.canonicalProductId,
    familyId: match.family.id,
    ...match.membership,
  });
}

function validateMatch(
  match: ReviewedFamilyCatalogMatch,
  snapshot: Extract<ReviewedFamilySnapshot, { state: "active" }>,
  generatedAt: Date,
): ReviewedFamilyPublicMembershipEvidence {
  if (
    !isRecord(match)
    || match.family.id !== snapshot.familyId
    || canonicalJson(match.family) !== canonicalJson(snapshot.family)
    || canonicalJson(match.taxonomy) !== canonicalJson(snapshot.taxonomy)
  ) {
    throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
  }

  const family = reviewedFamilyDescriptorSchema.safeParse(match.family);
  const taxonomy = reviewedFamilyPublicTaxonomyEvidenceSchema.safeParse(match.taxonomy);
  const product = exactProductPlanApiProductSummarySchema.safeParse(match.product);
  let membership: ReviewedFamilyPublicMembershipEvidence;
  try {
    membership = publicMembership(match);
  } catch {
    throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
  }
  if (!family.success || !taxonomy.success || !product.success) {
    throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
  }

  const generatedAtMs = generatedAt.getTime();
  const catalogObservedAtMs = Date.parse(product.data.catalogEvidence.observedAt);
  const reviewedAtMs = Date.parse(membership.reviewedAt);
  if (
    product.data.catalogEvidence.source.sourceClass !== "catalog"
    || Date.parse(taxonomy.data.publishedAt) > generatedAtMs
    || reviewedAtMs > generatedAtMs
    || catalogObservedAtMs > generatedAtMs
    || generatedAtMs - catalogObservedAtMs > EXACT_PRODUCT_CATALOG_MAX_AGE_MS
  ) {
    throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
  }
  return membership;
}

function normalizeReaderFailure(error: unknown, signal?: AbortSignal): never {
  if (
    signal?.aborted
    || (error instanceof ReviewedFamilyReaderError && error.code === "CANCELLED")
  ) {
    throw new FamilyCandidateServiceError("REQUEST_CANCELLED");
  }
  throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
}

export class FamilyCandidateService
  implements FamilyCandidateServiceContract, FamilyCandidateEvaluationContract {
  readonly dependencies: Required<FamilyCandidateServiceDependencies>;

  constructor(dependencies: FamilyCandidateServiceDependencies) {
    this.dependencies = {
      now: dependencies.now ?? (() => new Date()),
      reader: dependencies.reader,
    };
  }

  async inspect(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCandidateInspectionResponse> {
    return this.inspectAt(input, this.dependencies.now(), signal);
  }

  async inspectAt(
    input: unknown,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCandidateInspectionResponse> {
    if (signal?.aborted) {
      throw new FamilyCandidateServiceError("REQUEST_CANCELLED");
    }
    const parsed = reviewedFamilyCandidateInspectionRequestSchema.safeParse(input);
    if (!parsed.success) throw new FamilyCandidateServiceError("INVALID_REQUEST");

    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }
    const selections = [...parsed.data.families].sort((left, right) =>
      compareText(left.familyId, right.familyId));
    const familyIds = selections.map(({ familyId }) => familyId);

    let snapshots: ReviewedFamilySnapshot[];
    try {
      snapshots = await this.dependencies.reader.getSnapshots(
        familyIds,
        PRODUCTS_PER_FAMILY,
        at,
        signal,
      );
    } catch (error) {
      normalizeReaderFailure(error, signal);
    }
    if (signal?.aborted) {
      throw new FamilyCandidateServiceError("REQUEST_CANCELLED");
    }
    if (!Array.isArray(snapshots) || snapshots.length !== familyIds.length) {
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }

    const activeSnapshots: Extract<ReviewedFamilySnapshot, { state: "active" }>[] = [];
    for (const [index, rawSnapshot] of snapshots.entries()) {
      if (!isRecord(rawSnapshot) || rawSnapshot.familyId !== familyIds[index]) {
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }
      if (rawSnapshot.state === "unknown") {
        throw new FamilyCandidateServiceError("UNKNOWN_FAMILY");
      }
      if (rawSnapshot.state !== "active") {
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }
      if (rawSnapshot.complete !== true) {
        throw new FamilyCandidateServiceError("CANDIDATE_SET_INCOMPLETE");
      }
      if (!Array.isArray(rawSnapshot.matches) || rawSnapshot.matches.length > PRODUCTS_PER_FAMILY) {
        throw new FamilyCandidateServiceError("CANDIDATE_SET_INCOMPLETE");
      }
      activeSnapshots.push(rawSnapshot as Extract<ReviewedFamilySnapshot, { state: "active" }>);
    }

    const taxonomy = activeSnapshots[0]?.taxonomy;
    if (taxonomy === undefined) {
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }
    const taxonomyIdentity = canonicalJson(taxonomy);
    if (activeSnapshots.some((snapshot) => canonicalJson(snapshot.taxonomy) !== taxonomyIdentity)) {
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }

    const selectionByFamily = new Map(
      selections.map((selection) => [selection.familyId, selection]),
    );
    const familyByProduct = new Map<string, string>();
    const membershipsByFamilyProduct = new Map<string, ReviewedFamilyPublicMembershipEvidence>();
    for (const snapshot of activeSnapshots) {
      const seenWithinFamily = new Set<string>();
      for (const candidate of snapshot.matches) {
        const membership = validateMatch(candidate, snapshot, at);
        if (seenWithinFamily.has(candidate.canonicalProductId)) {
          throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
        }
        seenWithinFamily.add(candidate.canonicalProductId);
        const priorFamily = familyByProduct.get(candidate.canonicalProductId);
        if (priorFamily !== undefined && priorFamily !== snapshot.familyId) {
          throw new FamilyCandidateServiceError("AMBIGUOUS_FAMILY_MEMBERSHIP");
        }
        familyByProduct.set(candidate.canonicalProductId, snapshot.familyId);
        membershipsByFamilyProduct.set(
          `${snapshot.familyId}\u0000${candidate.canonicalProductId}`,
          membership,
        );
      }
    }

    const selectedByFamily = new Map<string, ReviewedFamilyCatalogMatch[]>();
    for (const snapshot of activeSnapshots) {
      if (snapshot.matches.length === 0) {
        throw new FamilyCandidateServiceError("FAMILY_NO_CANDIDATES");
      }
      const allowedBrands = selectionByFamily.get(snapshot.familyId)?.allowedBrands;
      const selected = allowedBrands === undefined
        ? [...snapshot.matches]
        : snapshot.matches.filter(({ product }) =>
          product.brand !== undefined
          && allowedBrands.includes(normalizeReviewedFamilyAllowedBrand(product.brand)));
      if (selected.length === 0) {
        throw new FamilyCandidateServiceError("NO_MATCHING_BRANDS");
      }
      selected.sort((left, right) =>
        compareText(left.canonicalProductId, right.canonicalProductId));
      selectedByFamily.set(snapshot.familyId, selected);
    }

    const selectedMatches = activeSnapshots.flatMap((snapshot) =>
      selectedByFamily.get(snapshot.familyId) ?? []);
    if (selectedMatches.length > REVIEWED_FAMILY_CANDIDATE_UNION_LIMIT) {
      throw new FamilyCandidateServiceError("CANDIDATE_SET_TOO_LARGE");
    }

    try {
      const candidateSets = activeSnapshots.map((snapshot) => {
        const allowedBrands = selectionByFamily.get(snapshot.familyId)?.allowedBrands;
        const candidates = selectedByFamily.get(snapshot.familyId) ?? [];
        const fingerprintCandidates = candidates.map((candidate) => ({
          canonicalProductId: candidate.canonicalProductId,
          membership: membershipsByFamilyProduct.get(
            `${snapshot.familyId}\u0000${candidate.canonicalProductId}`,
          )!,
          product: candidate.product,
        }));
        return {
          ...(allowedBrands === undefined ? {} : { allowedBrands }),
          candidateProductIds: candidates.map(({ canonicalProductId }) => canonicalProductId),
          candidateSetId: createCandidateSetId({
            ...(allowedBrands === undefined ? {} : { allowedBrands }),
            candidates: fingerprintCandidates,
            familyId: snapshot.familyId,
            taxonomy,
          }),
          complete: true as const,
          family: snapshot.family,
          familyId: snapshot.familyId,
          taxonomyVersionId: taxonomy.versionId,
        };
      });

      const selectedKeys = new Set(selectedMatches.map((candidate) =>
        `${candidate.family.id}\u0000${candidate.canonicalProductId}`));
      const memberships = [...membershipsByFamilyProduct.entries()]
        .filter(([key]) => selectedKeys.has(key))
        .sort(([left], [right]) => compareText(left, right))
        .map(([, membership]) => membership);
      const productClaims = [...selectedMatches]
        .sort((left, right) => compareText(left.canonicalProductId, right.canonicalProductId))
        .map((candidate) => ({
          canonicalProductId: candidate.canonicalProductId,
          product: candidate.product,
        }));
      const sourceById = new Map(
        productClaims.map(({ product }) => [
          product.catalogEvidence.source.id,
          product.catalogEvidence.source,
        ]),
      );
      const response = {
        candidateSets,
        contractVersion: 2 as const,
        generatedAt: at.toISOString(),
        memberships,
        productClaims,
        sources: [...sourceById.values()].sort((left, right) =>
          compareText(left.id, right.id)),
        taxonomy,
      };
      const validated = reviewedFamilyCandidateInspectionResponseSchemaFor(parsed.data)
        .safeParse(response);
      if (!validated.success) {
        throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
      }
      return validated.data;
    } catch (error) {
      if (error instanceof FamilyCandidateServiceError) throw error;
      throw new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE");
    }
  }
}

export type ParsedFamilyCandidateRequest = ReviewedFamilyCandidateInspectionRequest;
