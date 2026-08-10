import { createHash } from "node:crypto";

import { isValidGtin } from "@handleplan/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { HandleplanDatabase } from "./client";
import {
  catalogObservations,
  canonicalProducts,
  dataSources,
  ingestionRuns,
  physicalStoreCoverageChecks,
  physicalStoreObservations,
  physicalStores,
  priceCache,
  priceCoverageChecks,
  priceObservations,
  productIdentifiers,
  sourceProducts,
  sourcePermissions,
  sourceRecordOutcomes,
} from "./schema";
import { SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED } from "./source-governance-lock";

export type SupportedChain = "bunnpris" | "extra" | "rema-1000";
export type SourceRecordOutcomeState = "accepted" | "quarantined" | "unknown";

type SourceRecordOutcomeBase = {
  normalizedRecord?: Record<string, unknown>;
  rawChainCode?: string;
  recordKind: string;
  recordedAt: Date;
  sourceRecordId: string;
  subjectChain?: SupportedChain;
  subjectEan?: string;
};

export type SourceRecordOutcomeInput =
  | (SourceRecordOutcomeBase & {
      outcomeState: "accepted";
      reason?: never;
    })
  | (SourceRecordOutcomeBase & {
      outcomeState: "quarantined" | "unknown";
      reason: string;
    });

type NonAcceptedSourceRecordOutcome = Extract<
  SourceRecordOutcomeInput,
  { outcomeState: "quarantined" | "unknown" }
>;

export type IngestionRunCounters = {
  accepted: number;
  failed: number;
  fetched: number;
  persisted: number;
  quarantined: number;
  unknown: number;
};

export type PhysicalStoreRecord = {
  addressLine?: string;
  latitude?: number;
  longitude?: number;
  municipalityCode?: string;
  name: string;
  observedAt: Date;
  postalCode?: string;
  status?: "active" | "closed" | "unknown";
};

export type PhysicalStoreIngestionOutcome =
  | (Omit<SourceRecordOutcomeBase, "normalizedRecord" | "recordKind"> & {
      outcomeState: "accepted";
      reason?: never;
      recordKind: "physical-store";
      store: PhysicalStoreRecord;
      subjectChain: SupportedChain;
    })
  | (NonAcceptedSourceRecordOutcome & { recordKind: "physical-store" });

export type PhysicalStoreCoverageReason =
  | "DUPLICATE_IDENTITY"
  | "INVALID_RECORDS"
  | "MISSING_SUPPORTED_CHAIN"
  | "POSSIBLY_TRUNCATED"
  | "REQUEST_FAILED";

export type PhysicalStoreCoverageInput = {
  chain: SupportedChain;
  checkedAt: Date;
  recordCount: number;
} & (
  | { state: "complete"; reason?: never }
  | { state: "unknown"; reason: PhysicalStoreCoverageReason }
);

export type CatalogProductRecord = {
  brand?: string;
  categoryPath?: readonly CatalogCategoryPathEntry[];
  displayName: string;
  packageAmount: number;
  packageUnit: "g" | "ml" | "package" | "piece";
  retrievedAt: Date;
  sourceUpdatedAt?: Date;
  unitsPerPack?: number;
};

export interface CatalogCategoryPathEntry {
  sourceCategoryId: string;
  depth: number;
  name: string;
}

type CatalogCanonicalSnapshot = {
  brand: string | null;
  displayName: string;
  packageAmount: number;
  packageUnit: CatalogProductRecord["packageUnit"];
  status: "active" | "quarantined" | "retired";
  unitsPerPack: number;
  updatedAt: Date;
};

export type CatalogCanonicalMutationDecision = "activate" | "correct" | "none" | "review";

export function catalogCanonicalMutationDecision(input: {
  canonical: Readonly<CatalogCanonicalSnapshot>;
  incoming: Readonly<CatalogProductRecord>;
  matchedSourceVersion?: Readonly<{ sourceUpdatedAt: Date | null }> | undefined;
  sourceAccessApproved: boolean;
}): CatalogCanonicalMutationDecision {
  const fieldsMatch = input.canonical.brand === (input.incoming.brand ?? null)
    && input.canonical.displayName === input.incoming.displayName
    && input.canonical.packageAmount === input.incoming.packageAmount
    && input.canonical.packageUnit === input.incoming.packageUnit
    && input.canonical.unitsPerPack === (input.incoming.unitsPerPack ?? 1);
  if (input.canonical.status === "retired") return "review";
  if (input.canonical.status === "quarantined") {
    return input.sourceAccessApproved ? "activate" : "review";
  }
  if (fieldsMatch) return "none";
  if (
    !input.sourceAccessApproved
    || input.matchedSourceVersion === undefined
    || input.incoming.sourceUpdatedAt === undefined
  ) {
    return "review";
  }
  if (
    input.matchedSourceVersion.sourceUpdatedAt !== null
    && input.incoming.sourceUpdatedAt <= input.matchedSourceVersion.sourceUpdatedAt
  ) {
    return "review";
  }
  return "correct";
}

export type CatalogIngestionOutcome =
  | (Omit<SourceRecordOutcomeBase, "normalizedRecord" | "recordKind" | "subjectEan"> & {
      outcomeState: "accepted";
      product: CatalogProductRecord;
      reason?: never;
      recordKind: "product";
      subjectEan: string;
    })
  | (NonAcceptedSourceRecordOutcome & { recordKind: "product" });

type AcceptedCatalogIngestionOutcome = Extract<
  CatalogIngestionOutcome,
  { outcomeState: "accepted" }
>;

export type PriceRecord = {
  amountOre: number;
  fetchedAt: Date;
  geographicScopeId?: number;
  observedAt: Date;
  sourceReference: string;
};

export type PriceIngestionOutcome =
  | (Omit<SourceRecordOutcomeBase, "normalizedRecord" | "recordKind" | "subjectChain" | "subjectEan"> & {
      outcomeState: "accepted";
      price: PriceRecord;
      reason?: never;
      recordKind: "price";
      subjectChain: SupportedChain;
      subjectEan: string;
    })
  | (NonAcceptedSourceRecordOutcome & {
      geographicScopeId?: number;
      recordKind: "price";
    });

export type IngestionRunStatus =
  | "cancelled"
  | "completed"
  | "degraded"
  | "failed"
  | "running";

export type IngestionTerminalStatus = Exclude<IngestionRunStatus, "running">;

export type IngestionRunHandle = {
  fenceToken: string;
  id: number;
  jobId: string;
  runType: string;
  sourceId: string;
};

export type IngestionFenceContext = {
  fenceToken: string;
  ingestionRunId?: number;
  jobId: string;
  sourceId: string;
};

export type IngestionTransaction = Parameters<
  Parameters<HandleplanDatabase["transaction"]>[0]
>[0];

export type IngestionFenceVerifier = (
  transaction: IngestionTransaction,
  context: Readonly<IngestionFenceContext>,
  phase?: "before-commit" | "initial",
) => Promise<void>;

export type IngestionWriteResult = {
  inserted: number;
  received: number;
};

type SourceIngestionCapability =
  | "catalog"
  | "ordinaryPrice"
  | "physicalStore"
  | "priceHistory";

const SOURCE_ACCESS_REVIEW_REQUIRED = "SOURCE_ACCESS_REVIEW_REQUIRED";
const INGESTION_LOCK_TIMEOUT_MS = 5_000;
const INGESTION_STATEMENT_TIMEOUT_MS = 60_000;

function throwIfIngestionCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Ingestion operation cancelled");
}

const MAX_INGESTION_OUTCOMES_PER_WRITE = 1_000;
const MAX_PHYSICAL_STORE_COVERAGE_PER_WRITE = 3;
const MAX_CATALOG_CATEGORY_PATH_LENGTH = 100;

export const sourceProductReplacementCondition = sql`
  ${sourceProducts.lastSeenAt} < excluded.last_seen_at
  or (
    ${sourceProducts.lastSeenAt} = excluded.last_seen_at
    and ${sourceProducts.rawRecordHash} > excluded.raw_record_hash
  )
`;

export const physicalStoreReplacementCondition = sql`
  ${physicalStores.observedAt} < excluded.observed_at
`;

export function physicalStoreBranchKey(sourceId: string, externalId: string): string {
  requireBoundedString(sourceId, "sourceId", 64);
  requireBoundedString(externalId, "externalId", 128);
  return createHash("sha256")
    .update(Buffer.byteLength(sourceId, "utf8").toString())
    .update(":")
    .update(sourceId)
    .update(externalId)
    .digest("hex");
}

export class IngestionOutcomeConflictError extends Error {
  constructor(
    readonly ingestionRunId: number,
    readonly recordKind: string,
    readonly sourceRecordId: string,
  ) {
    super(
      `Conflicting replay for ingestion outcome ${ingestionRunId}/${recordKind}/${sourceRecordId}`,
    );
    this.name = "IngestionOutcomeConflictError";
  }
}

export function canonicalGtin(value: string): string | undefined {
  return isValidGtin(value) ? value : undefined;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot hash a non-finite JSON number");
    }
    return value;
  }

  throw new TypeError(`Cannot hash non-JSON value of type ${typeof value}`);
}

export function hashSourceRecordOutcome(outcome: SourceRecordOutcomeInput): string {
  const semanticOutcome = {
    normalizedRecord: outcome.normalizedRecord,
    outcomeState: outcome.outcomeState,
    rawChainCode: outcome.rawChainCode,
    reason: outcome.outcomeState === "accepted" ? undefined : outcome.reason,
    recordKind: outcome.recordKind,
    sourceRecordId: outcome.sourceRecordId,
    subjectChain: outcome.subjectChain,
    subjectEan: outcome.subjectEan,
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalize(semanticOutcome)))
    .digest("hex");
}

export function reconstructIngestionRunCounters(
  states: readonly SourceRecordOutcomeState[],
  failed = 0,
): IngestionRunCounters {
  if (!Number.isSafeInteger(failed) || failed < 0) {
    throw new RangeError("failed must be a non-negative safe integer");
  }

  const counters: IngestionRunCounters = {
    accepted: 0,
    failed,
    fetched: states.length,
    persisted: states.length,
    quarantined: 0,
    unknown: 0,
  };

  for (const state of states) {
    counters[state] += 1;
  }

  return counters;
}

function normalizedStoreRecord(store: PhysicalStoreRecord): Record<string, unknown> {
  return {
    ...(store.addressLine === undefined ? {} : { addressLine: store.addressLine }),
    ...(store.latitude === undefined ? {} : { latitude: store.latitude }),
    ...(store.longitude === undefined ? {} : { longitude: store.longitude }),
    ...(store.municipalityCode === undefined
      ? {}
      : { municipalityCode: store.municipalityCode }),
    name: store.name,
    observedAt: store.observedAt.toISOString(),
    ...(store.postalCode === undefined ? {} : { postalCode: store.postalCode }),
    ...(store.status === undefined ? {} : { status: store.status }),
  };
}

export function normalizePhysicalStoreIngestionOutcome(
  outcome: PhysicalStoreIngestionOutcome,
): SourceRecordOutcomeInput {
  if (outcome.outcomeState !== "accepted" || !("store" in outcome)) {
    return outcome;
  }

  validatePhysicalStoreRecord(outcome.store);

  const normalizedRecord = normalizedStoreRecord(outcome.store);
  const base = {
    normalizedRecord,
    rawChainCode: outcome.rawChainCode,
    recordKind: outcome.recordKind,
    recordedAt: outcome.recordedAt,
    sourceRecordId: outcome.sourceRecordId,
    subjectChain: outcome.subjectChain,
    subjectEan: outcome.subjectEan,
  };

  if (outcome.store.latitude === undefined || outcome.store.longitude === undefined) {
    return {
      ...base,
      outcomeState: "unknown",
      reason: "MISSING_COORDINATES",
    };
  }

  return { ...base, outcomeState: "accepted" };
}

function requireBoundedString(value: unknown, name: string, maximum: number): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${name} must contain 1-${maximum} characters`);
  }
}

function requireValidDate(value: unknown, name: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date`);
  }
}

function requireOptionalPositiveId(value: unknown, name: string): void {
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function requireBoundedOutcomeBatch(outcomes: readonly unknown[]): void {
  if (outcomes.length > MAX_INGESTION_OUTCOMES_PER_WRITE) {
    throw new RangeError(
      `An ingestion write accepts at most ${MAX_INGESTION_OUTCOMES_PER_WRITE} outcomes`,
    );
  }
}

export function validateSourceRecordOutcome(
  input: unknown,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Source record outcome must be an object");
  }
  const outcome = input as Record<string, unknown>;
  if (
    outcome.outcomeState !== "accepted"
    && outcome.outcomeState !== "quarantined"
    && outcome.outcomeState !== "unknown"
  ) {
    throw new TypeError("outcomeState must be accepted, quarantined, or unknown");
  }
  requireBoundedString(outcome.recordKind, "recordKind", 32);
  requireBoundedString(outcome.sourceRecordId, "sourceRecordId", 200);
  requireValidDate(outcome.recordedAt, "recordedAt");
  if (outcome.outcomeState === "accepted") {
    if (outcome.reason !== undefined) {
      throw new TypeError("An accepted outcome cannot carry a reason");
    }
  } else {
    requireBoundedString(outcome.reason, "reason", 80);
  }
  if (outcome.rawChainCode !== undefined) {
    requireBoundedString(outcome.rawChainCode, "rawChainCode", 100);
  }
  if (
    outcome.subjectEan !== undefined
    && (typeof outcome.subjectEan !== "string"
      || canonicalGtin(outcome.subjectEan) === undefined)
  ) {
    throw new TypeError("subjectEan must be an exact checksum-valid GTIN");
  }
  if (
    outcome.subjectChain !== undefined
    && outcome.subjectChain !== "bunnpris"
    && outcome.subjectChain !== "extra"
    && outcome.subjectChain !== "rema-1000"
  ) {
    throw new TypeError("subjectChain must be a supported canonical chain");
  }
  if (
    outcome.normalizedRecord !== undefined
    && (outcome.normalizedRecord === null
      || typeof outcome.normalizedRecord !== "object"
      || Array.isArray(outcome.normalizedRecord))
  ) {
    throw new TypeError("normalizedRecord must be a JSON object");
  }
  hashSourceRecordOutcome(outcome as SourceRecordOutcomeInput);
}

function validatePhysicalStoreRecord(store: PhysicalStoreRecord): void {
  requireBoundedString(store.name, "store.name", 240);
  requireValidDate(store.observedAt, "store.observedAt");
  if (store.addressLine !== undefined) {
    requireBoundedString(store.addressLine, "store.addressLine", 240);
  }
  if (store.postalCode !== undefined) {
    if (!/^[0-9]{4}$/u.test(store.postalCode)) {
      throw new TypeError("store.postalCode must contain exactly four digits");
    }
  }
  if (store.municipalityCode !== undefined) {
    requireBoundedString(store.municipalityCode, "store.municipalityCode", 8);
  }
  if (
    store.status !== undefined
    && store.status !== "active"
    && store.status !== "closed"
    && store.status !== "unknown"
  ) {
    throw new TypeError("store.status is invalid");
  }
  if (
    store.latitude !== undefined
    && (!Number.isFinite(store.latitude) || store.latitude < -90 || store.latitude > 90)
  ) {
    throw new TypeError("store.latitude is invalid");
  }
  if (
    store.longitude !== undefined
    && (!Number.isFinite(store.longitude) || store.longitude < -180 || store.longitude > 180)
  ) {
    throw new TypeError("store.longitude is invalid");
  }
}

function validatePhysicalStoreCoverage(
  coverage: readonly PhysicalStoreCoverageInput[],
): void {
  if (
    !Array.isArray(coverage)
    || coverage.length < 1
    || coverage.length > MAX_PHYSICAL_STORE_COVERAGE_PER_WRITE
  ) {
    throw new RangeError("Physical-store coverage requires 1-3 chain rows");
  }
  const chains = new Set<SupportedChain>();
  for (const entry of coverage) {
    if (
      entry.chain !== "bunnpris"
      && entry.chain !== "extra"
      && entry.chain !== "rema-1000"
    ) {
      throw new TypeError("Physical-store coverage chain is invalid");
    }
    if (chains.has(entry.chain)) {
      throw new TypeError("Physical-store coverage chains must be unique");
    }
    chains.add(entry.chain);
    requireValidDate(entry.checkedAt, "coverage.checkedAt");
    if (
      !Number.isSafeInteger(entry.recordCount)
      || entry.recordCount < 0
      || entry.recordCount > MAX_INGESTION_OUTCOMES_PER_WRITE
    ) {
      throw new RangeError("coverage.recordCount must be an integer from 0 to 1000");
    }
    if (entry.state === "complete") {
      if (entry.reason !== undefined || entry.recordCount < 1) {
        throw new TypeError("Complete physical-store coverage requires records and no reason");
      }
      continue;
    }
    if (
      entry.state !== "unknown"
      || ![
        "DUPLICATE_IDENTITY",
        "INVALID_RECORDS",
        "MISSING_SUPPORTED_CHAIN",
        "POSSIBLY_TRUNCATED",
        "REQUEST_FAILED",
      ].includes(entry.reason)
    ) {
      throw new TypeError("Unknown physical-store coverage requires an explicit known reason");
    }
  }
}

function normalizeCatalogOutcome(outcome: CatalogIngestionOutcome): SourceRecordOutcomeInput {
  if (outcome.outcomeState !== "accepted" || !("product" in outcome)) {
    return outcome;
  }
  const { product } = outcome;
  return {
    normalizedRecord: {
      ...(product.brand === undefined ? {} : { brand: product.brand }),
      ...(product.categoryPath === undefined
        ? {}
        : { categoryPath: product.categoryPath.map((entry) => ({ ...entry })) }),
      displayName: product.displayName,
      packageAmount: product.packageAmount,
      packageUnit: product.packageUnit,
      retrievedAt: product.retrievedAt.toISOString(),
      ...(product.sourceUpdatedAt === undefined
        ? {}
        : { sourceUpdatedAt: product.sourceUpdatedAt.toISOString() }),
      unitsPerPack: product.unitsPerPack ?? 1,
    },
    outcomeState: "accepted",
    rawChainCode: outcome.rawChainCode,
    recordKind: outcome.recordKind,
    recordedAt: outcome.recordedAt,
    sourceRecordId: outcome.sourceRecordId,
    subjectChain: outcome.subjectChain,
    subjectEan: outcome.subjectEan,
  };
}

function normalizePriceOutcome(outcome: PriceIngestionOutcome): SourceRecordOutcomeInput {
  if (outcome.outcomeState === "accepted" && "price" in outcome) {
    return {
      normalizedRecord: {
        amountOre: outcome.price.amountOre,
        fetchedAt: outcome.price.fetchedAt.toISOString(),
        ...(outcome.price.geographicScopeId === undefined
          ? {}
          : { geographicScopeId: outcome.price.geographicScopeId }),
        observedAt: outcome.price.observedAt.toISOString(),
        sourceReference: outcome.price.sourceReference,
      },
      outcomeState: "accepted",
      rawChainCode: outcome.rawChainCode,
      recordKind: outcome.recordKind,
      recordedAt: outcome.recordedAt,
      sourceRecordId: outcome.sourceRecordId,
      subjectChain: outcome.subjectChain,
      subjectEan: outcome.subjectEan,
    };
  }

  const geographicScopeId = "geographicScopeId" in outcome
    ? outcome.geographicScopeId
    : undefined;
  return {
    ...outcome,
    normalizedRecord: {
      ...(outcome.normalizedRecord ?? {}),
      ...(geographicScopeId === undefined ? {} : { geographicScopeId }),
    },
  };
}

function compareCategoryPathEntries(
  left: CatalogCategoryPathEntry,
  right: CatalogCategoryPathEntry,
): number {
  return left.depth - right.depth
    || Number(left.sourceCategoryId) - Number(right.sourceCategoryId);
}

export function validateCatalogCategoryPath(categoryPath: unknown): void {
  if (categoryPath === undefined) return;
  if (!Array.isArray(categoryPath)) {
    throw new TypeError("product.categoryPath must be an array when supplied");
  }
  if (categoryPath.length > MAX_CATALOG_CATEGORY_PATH_LENGTH) {
    throw new RangeError(
      `product.categoryPath accepts at most ${MAX_CATALOG_CATEGORY_PATH_LENGTH} entries`,
    );
  }

  const seenIds = new Set<string>();
  let previous: CatalogCategoryPathEntry | undefined;
  for (const [index, candidate] of categoryPath.entries()) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError(`product.categoryPath[${index}] must be an object`);
    }
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join("\u0000")
      !== ["depth", "name", "sourceCategoryId"].join("\u0000")
    ) {
      throw new TypeError(`product.categoryPath[${index}] must contain only known fields`);
    }
    if (
      typeof entry.sourceCategoryId !== "string"
      || !/^(?:0|[1-9][0-9]*)$/.test(entry.sourceCategoryId)
      || !Number.isSafeInteger(Number(entry.sourceCategoryId))
      || String(Number(entry.sourceCategoryId)) !== entry.sourceCategoryId
    ) {
      throw new TypeError(`product.categoryPath[${index}].sourceCategoryId is invalid`);
    }
    if (
      typeof entry.depth !== "number"
      || !Number.isSafeInteger(entry.depth)
      || entry.depth < 0
      || entry.depth > 100
    ) {
      throw new TypeError(`product.categoryPath[${index}].depth is invalid`);
    }
    if (
      typeof entry.name !== "string"
      || entry.name.length < 1
      || entry.name.length > 500
      || entry.name.trim() !== entry.name
    ) {
      throw new TypeError(`product.categoryPath[${index}].name is invalid`);
    }
    if (seenIds.has(entry.sourceCategoryId)) {
      throw new TypeError("product.categoryPath sourceCategoryId values must be unique");
    }
    seenIds.add(entry.sourceCategoryId);
    const normalized = entry as unknown as CatalogCategoryPathEntry;
    if (previous !== undefined && compareCategoryPathEntries(previous, normalized) >= 0) {
      throw new TypeError("product.categoryPath must use canonical order");
    }
    previous = normalized;
  }
}

function validateCatalogProduct(product: CatalogProductRecord): void {
  requireBoundedString(product.displayName, "product.displayName", 240);
  if (product.brand !== undefined) requireBoundedString(product.brand, "product.brand", 160);
  validateCatalogCategoryPath(product.categoryPath);
  requireValidDate(product.retrievedAt, "product.retrievedAt");
  if (product.sourceUpdatedAt !== undefined) {
    requireValidDate(product.sourceUpdatedAt, "product.sourceUpdatedAt");
    if (product.sourceUpdatedAt > product.retrievedAt) {
      throw new TypeError("product.sourceUpdatedAt must not follow product.retrievedAt");
    }
  }
  if (!Number.isSafeInteger(product.packageAmount) || product.packageAmount < 1) {
    throw new TypeError("product.packageAmount must be a positive safe integer");
  }
  const unitsPerPack = product.unitsPerPack ?? 1;
  if (!Number.isSafeInteger(unitsPerPack) || unitsPerPack < 1) {
    throw new TypeError("product.unitsPerPack must be a positive safe integer");
  }
}

function validatePriceRecord(price: PriceRecord): void {
  if (!Number.isSafeInteger(price.amountOre) || price.amountOre < 0) {
    throw new TypeError("price.amountOre must be a non-negative safe integer");
  }
  requireValidDate(price.observedAt, "price.observedAt");
  requireValidDate(price.fetchedAt, "price.fetchedAt");
  if (price.fetchedAt < price.observedAt) {
    throw new TypeError("price.fetchedAt must not precede price.observedAt");
  }
  requireOptionalPositiveId(price.geographicScopeId, "price.geographicScopeId");
  requireBoundedString(price.sourceReference, "price.sourceReference", 8_192);
}

function identifierScheme(ean: string): "ean8" | "ean13" {
  return ean.length === 8 ? "ean8" : "ean13";
}

function evidenceKeyForPrice(
  sourceId: string,
  ean: string,
  chain: SupportedChain,
  price: PriceRecord,
  claimEligibility: "historical_eligible" | "ordinary_only",
): string {
  return createHash("sha256")
    .update(
      [
        sourceId,
        ean,
        chain,
        price.observedAt.toISOString(),
        price.amountOre.toString(),
        claimEligibility,
      ].join("\u0000"),
    )
    .digest("hex");
}

export function claimEligibilityForRunType(
  runType: string,
): "historical_eligible" | "ordinary_only" {
  if (runType === "historical-prices") return "historical_eligible";
  if (runType === "benchmark-prices") return "ordinary_only";
  throw new TypeError("Price persistence requires an exact supported ingestion run type");
}

function priceCapabilityForRunType(runType: string): SourceIngestionCapability {
  if (runType === "benchmark-prices") return "ordinaryPrice";
  if (runType === "historical-prices") return "priceHistory";
  throw new TypeError("Price persistence requires an exact supported ingestion run type");
}

function quarantineAcceptedOutcomes(
  original: readonly SourceRecordOutcomeInput[],
  normalized: readonly SourceRecordOutcomeInput[],
): SourceRecordOutcomeInput[] {
  return normalized.map((outcome, index) =>
    original[index]?.outcomeState === "accepted"
      ? {
          ...outcome,
          outcomeState: "quarantined",
          reason: SOURCE_ACCESS_REVIEW_REQUIRED,
        }
      : outcome);
}

export class PostgresIngestionRepository {
  private readonly verifyFence: IngestionFenceVerifier;

  constructor(
    private readonly db: HandleplanDatabase,
    options: { verifyFence: IngestionFenceVerifier },
  ) {
    if (typeof options?.verifyFence !== "function") {
      throw new TypeError("An ingestion fence verifier is required");
    }
    this.verifyFence = options.verifyFence;
  }

  async beginRun(input: {
    fenceToken: string;
    jobId: string;
    runType: string;
    sourceId: string;
    startedAt: Date;
  }, signal?: AbortSignal): Promise<{
    created: boolean;
    handle: IngestionRunHandle;
    status: IngestionRunStatus;
  }> {
    requireBoundedString(input.fenceToken, "fenceToken", 1_024);
    requireBoundedString(input.jobId, "jobId", 200);
    requireBoundedString(input.runType, "runType", 32);
    requireBoundedString(input.sourceId, "sourceId", 64);
    requireValidDate(input.startedAt, "startedAt");

    const fenceContext = {
        fenceToken: input.fenceToken,
        jobId: input.jobId,
        sourceId: input.sourceId,
      };
    return this.fencedTransaction(fenceContext, signal, async (transaction) => {
      const [inserted] = await transaction
        .insert(ingestionRuns)
        .values({
          counts: reconstructIngestionRunCounters([]),
          jobId: input.jobId,
          runType: input.runType,
          sourceId: input.sourceId,
          startedAt: input.startedAt,
          status: "running",
        })
        .onConflictDoNothing()
        .returning({
          id: ingestionRuns.id,
          runType: ingestionRuns.runType,
          sourceId: ingestionRuns.sourceId,
          status: ingestionRuns.status,
        });

      const existing = inserted ?? (await transaction
        .select({
          id: ingestionRuns.id,
          runType: ingestionRuns.runType,
          sourceId: ingestionRuns.sourceId,
          status: ingestionRuns.status,
        })
        .from(ingestionRuns)
        .where(eq(ingestionRuns.jobId, input.jobId))
        .limit(1))[0];
      if (existing === undefined) throw new Error("Could not begin ingestion run");
      if (existing.sourceId !== input.sourceId || existing.runType !== input.runType) {
        throw new Error(`Conflicting job identity for ${input.jobId}`);
      }

      return {
        created: inserted !== undefined,
        handle: {
          fenceToken: input.fenceToken,
          id: existing.id,
          jobId: input.jobId,
          runType: input.runType,
          sourceId: input.sourceId,
        },
        status: existing.status as IngestionRunStatus,
      };
    });
  }

  async auditOutcomes(
    handle: IngestionRunHandle,
    outcomes: readonly SourceRecordOutcomeInput[],
    signal?: AbortSignal,
  ): Promise<IngestionWriteResult> {
    requireBoundedOutcomeBatch(outcomes);
    return this.withRunningRun(handle, (transaction) =>
      this.auditOutcomesWithin(transaction, handle, outcomes, signal), signal);
  }

  async persistCatalogOutcomes(
    handle: IngestionRunHandle,
    outcomes: readonly CatalogIngestionOutcome[],
    signal?: AbortSignal,
  ): Promise<IngestionWriteResult> {
    if (handle.runType !== "catalog") {
      throw new TypeError("Catalog persistence requires a catalog ingestion run");
    }
    requireBoundedOutcomeBatch(outcomes);
    return this.withRunningRun(handle, async (transaction) => {
      const containsAcceptedCatalogMutation = outcomes.some(
        (outcome) => outcome.outcomeState === "accepted",
      );
      let catalogSourceAccessApproved = false;
      for (const outcome of outcomes) {
        throwIfIngestionCancelled(signal);
        validateSourceRecordOutcome(outcome);
        if (outcome.outcomeState !== "accepted") continue;
        validateCatalogProduct(outcome.product);
        requireBoundedString(outcome.sourceRecordId, "sourceRecordId", 128);
        if (canonicalGtin(outcome.subjectEan) === undefined) {
          throw new TypeError("Accepted catalog records require a valid GTIN");
        }
      }

      // Source governance is the outermost lock for the whole rights-sensitive
      // batch. Sorted unique GTIN locks follow it before any product row is
      // touched. That gives same-source and cross-source catalog writers one
      // canonical lock order even when their input batches are reversed.
      if (containsAcceptedCatalogMutation) {
        await this.lockSourceGovernance(transaction, handle.sourceId);
        catalogSourceAccessApproved = await this.sourceAllowsCapabilities(
          transaction,
          handle.sourceId,
          ["catalog"],
        );
        if (catalogSourceAccessApproved) {
          const acceptedGtins = [...new Set(
            outcomes
              .filter((outcome) => outcome.outcomeState === "accepted")
              .map((outcome) => outcome.subjectEan),
          )].sort();
          await this.lockProductGtins(transaction, acceptedGtins);
        }
      }

      let inserted = 0;
      for (const outcome of outcomes) {
        throwIfIngestionCancelled(signal);
        const normalized = normalizeCatalogOutcome(outcome);
        if (outcome.outcomeState !== "accepted") {
          const audit = await this.auditOutcomesWithin(
            transaction,
            handle,
            [normalized],
            signal,
          );
          inserted += audit.inserted;
          continue;
        }
        // Current catalog authority gates the complete accepted persistence
        // path. A governance change that won the outer source lock leaves only
        // an append-only review outcome: no canonical resolution, identifier
        // verification, source link or catalog observation is allowed.
        if (!catalogSourceAccessApproved) {
          const audit = await this.auditOutcomesWithin(
            transaction,
            handle,
            [{
              ...normalized,
              outcomeState: "quarantined",
              reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
            }],
            signal,
          );
          inserted += audit.inserted;
          continue;
        }
        const resolution = await this.resolveProductByGtin(
          transaction,
          outcome.subjectEan,
          { handle, outcome, sourceAccessApproved: true },
        );
        if (resolution.reviewRequired) {
          const audit = await this.auditOutcomesWithin(
            transaction,
            handle,
            [{
              ...normalized,
              outcomeState: "quarantined",
              reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
            }],
            signal,
          );
          inserted += audit.inserted;
          continue;
        }
        const audit = await this.auditOutcomesWithin(
          transaction,
          handle,
          [normalized],
          signal,
        );
        inserted += audit.inserted;
        await this.linkSourceProduct(
          transaction,
          handle,
          outcome,
          normalized,
          resolution.productId,
        );
        await this.appendCatalogObservation(
          transaction,
          handle,
          outcome,
          normalized,
          resolution.productId,
        );
      }
      return { inserted, received: outcomes.length };
    }, signal);
  }

  async persistPriceOutcomes(
    handle: IngestionRunHandle,
    outcomes: readonly PriceIngestionOutcome[],
    signal?: AbortSignal,
  ): Promise<IngestionWriteResult> {
    const capability = priceCapabilityForRunType(handle.runType);
    const claimEligibility = claimEligibilityForRunType(handle.runType);
    requireBoundedOutcomeBatch(outcomes);
    return this.withRunningRun(handle, async (transaction) => {
      for (const outcome of outcomes) {
        throwIfIngestionCancelled(signal);
        validateSourceRecordOutcome(outcome);
        if (outcome.outcomeState === "accepted") {
          validatePriceRecord(outcome.price);
          if (canonicalGtin(outcome.subjectEan) === undefined) {
            throw new TypeError("Accepted price records require a valid GTIN");
          }
        } else {
          requireOptionalPositiveId(
            outcome.geographicScopeId,
            "geographicScopeId",
          );
        }
      }

      const normalized = outcomes.map(normalizePriceOutcome);
      await this.lockSourceGovernance(transaction, handle.sourceId);
      const sourceAccessApproved = await this.sourceAllowsCapabilities(
        transaction,
        handle.sourceId,
        [capability],
      );
      if (!sourceAccessApproved) {
        return this.auditOutcomesWithin(
          transaction,
          handle,
          quarantineAcceptedOutcomes(outcomes, normalized),
          signal,
        );
      }

      const subjectGtins = [...new Set(outcomes.flatMap((outcome) =>
        outcome.subjectChain !== undefined && outcome.subjectEan !== undefined
          ? [outcome.subjectEan]
          : []))].sort();
      await this.lockProductGtins(transaction, subjectGtins);

      const audit = await this.auditOutcomesWithin(transaction, handle, normalized, signal);
      for (let index = 0; index < outcomes.length; index += 1) {
        throwIfIngestionCancelled(signal);
        const outcome = outcomes[index]!;
        if (outcome.subjectChain === undefined || outcome.subjectEan === undefined) {
          continue;
        }
        const ean = canonicalGtin(outcome.subjectEan);
        if (ean === undefined) {
          throw new TypeError("Known price subjects require a valid GTIN");
        }
        const { productId } = await this.resolveProductByGtin(transaction, ean);
        const audited = normalized[index]!;

        if (outcome.outcomeState === "accepted") {
          const evidenceKey = evidenceKeyForPrice(
            handle.sourceId,
            ean,
            outcome.subjectChain,
            outcome.price,
            claimEligibility,
          );
          await transaction
            .insert(priceObservations)
            .values({
              amountOre: outcome.price.amountOre,
              chain: outcome.subjectChain,
              claimEligibility,
              confidence: 100,
              evidenceKey,
              evidenceLevel: "chain",
              fetchedAt: outcome.price.fetchedAt,
              geographicScopeId: outcome.price.geographicScopeId,
              ingestionRunId: handle.id,
              observedAt: outcome.price.observedAt,
              productId,
              rawRecordHash: hashSourceRecordOutcome(audited),
              sourceId: handle.sourceId,
              sourceReference: outcome.price.sourceReference,
            })
            .onConflictDoNothing({ target: priceObservations.evidenceKey });
          if (claimEligibility === "ordinary_only") {
            await transaction
              .insert(priceCoverageChecks)
              .values({
                chain: outcome.subjectChain,
                checkedAt: outcome.price.fetchedAt,
                geographicScopeId: outcome.price.geographicScopeId,
                ingestionRunId: handle.id,
                productId,
                reason: "source_price_observed",
                state: "priced",
              })
              .onConflictDoNothing();
          }

          if (claimEligibility === "ordinary_only" && handle.sourceId === "kassalapp") {
            await transaction
              .insert(priceCache)
              .values({
                amountOre: outcome.price.amountOre,
                chain: outcome.subjectChain,
                ean,
                fetchedAt: outcome.price.fetchedAt,
                observedAt: outcome.price.observedAt,
              })
              .onConflictDoUpdate({
                target: [priceCache.ean, priceCache.chain],
                set: {
                  amountOre: sql`excluded.amount_ore`,
                  fetchedAt: sql`excluded.fetched_at`,
                  observedAt: sql`excluded.observed_at`,
                },
                setWhere: sql`${priceCache.observedAt} < excluded.observed_at`,
              });
          }
        } else if (claimEligibility === "ordinary_only") {
          await transaction
            .insert(priceCoverageChecks)
            .values({
              chain: outcome.subjectChain,
              checkedAt: outcome.recordedAt,
              geographicScopeId: outcome.geographicScopeId,
              ingestionRunId: handle.id,
              productId,
              reason: outcome.reason,
              state: "unknown",
            })
            .onConflictDoNothing();
        }
      }
      return audit;
    }, signal);
  }

  async persistPhysicalStoreOutcomes(
    handle: IngestionRunHandle,
    outcomes: readonly PhysicalStoreIngestionOutcome[],
    coverage: readonly PhysicalStoreCoverageInput[],
    signal?: AbortSignal,
  ): Promise<IngestionWriteResult> {
    if (handle.runType !== "physical-stores") {
      throw new TypeError("Physical-store persistence requires a physical-stores ingestion run");
    }
    requireBoundedOutcomeBatch(outcomes);
    validatePhysicalStoreCoverage(coverage);
    return this.withRunningRun(handle, async (transaction) => {
      const coverageByChain = new Map(coverage.map((entry) => [entry.chain, entry]));
      const outcomeIdentity = new Set<string>();
      for (const outcome of outcomes) {
        throwIfIngestionCancelled(signal);
        validateSourceRecordOutcome(outcome);
        if (
          outcome.subjectChain !== undefined
          && !coverageByChain.has(outcome.subjectChain)
        ) {
          throw new TypeError("Every physical-store subject chain requires coverage evidence");
        }
        const identity = `${outcome.recordKind}\u0000${outcome.sourceRecordId}`;
        if (outcomeIdentity.has(identity)) {
          throw new TypeError("Physical-store source identities must be unique within a snapshot");
        }
        outcomeIdentity.add(identity);
        if (outcome.outcomeState !== "accepted") continue;
        requireBoundedString(outcome.sourceRecordId, "sourceRecordId", 128);
        validatePhysicalStoreRecord(outcome.store);
        const chainCoverage = coverageByChain.get(outcome.subjectChain);
        if (
          chainCoverage === undefined
          || outcome.store.observedAt > chainCoverage.checkedAt
        ) {
          throw new TypeError("Physical-store observations must precede their chain coverage check");
        }
      }
      for (const entry of coverage) {
        if (entry.state !== "complete") continue;
        const chainOutcomes = outcomes.filter(
          ({ subjectChain }) => subjectChain === entry.chain,
        );
        if (
          chainOutcomes.length !== entry.recordCount
          || chainOutcomes.some((outcome) =>
            outcome.outcomeState !== "accepted"
            || outcome.store.latitude === undefined
            || outcome.store.longitude === undefined)
        ) {
          throw new TypeError(
            "Complete physical-store coverage requires every counted routing record",
          );
        }
      }

      const normalized = outcomes.map(normalizePhysicalStoreIngestionOutcome);
      await this.lockSourceGovernance(transaction, handle.sourceId);
      const sourceAccessApproved = await this.sourceAllowsCapabilities(
        transaction,
        handle.sourceId,
        ["physicalStore"],
      );
      if (!sourceAccessApproved) {
        return this.auditOutcomesWithin(
          transaction,
          handle,
          quarantineAcceptedOutcomes(outcomes, normalized),
          signal,
        );
      }

      const audit = await this.auditOutcomesWithin(transaction, handle, normalized, signal);
      for (let index = 0; index < outcomes.length; index += 1) {
        throwIfIngestionCancelled(signal);
        const outcome = outcomes[index]!;
        if (outcome.outcomeState !== "accepted") continue;
        if (
          outcome.store.latitude === undefined
          || outcome.store.longitude === undefined
        ) {
          continue;
        }
        await transaction
          .insert(physicalStoreObservations)
          .values({
            branchKey: physicalStoreBranchKey(handle.sourceId, outcome.sourceRecordId),
            chain: outcome.subjectChain,
            externalId: outcome.sourceRecordId,
            ingestionRunId: handle.id,
            latitude: outcome.store.latitude.toFixed(6),
            longitude: outcome.store.longitude.toFixed(6),
            name: outcome.store.name,
            observedAt: outcome.store.observedAt,
            postalCode: outcome.store.postalCode,
            sourceId: handle.sourceId,
            status: outcome.store.status ?? "active",
          });
        await transaction
          .insert(physicalStores)
          .values({
            addressLine: outcome.store.addressLine,
            chain: outcome.subjectChain,
            externalId: outcome.sourceRecordId,
            latitude: outcome.store.latitude.toFixed(6),
            longitude: outcome.store.longitude.toFixed(6),
            municipalityCode: outcome.store.municipalityCode,
            name: outcome.store.name,
            observedAt: outcome.store.observedAt,
            postalCode: outcome.store.postalCode,
            sourceId: handle.sourceId,
            status: outcome.store.status ?? "active",
          })
          .onConflictDoUpdate({
            target: [physicalStores.sourceId, physicalStores.externalId],
            set: {
              addressLine: outcome.store.addressLine,
              chain: outcome.subjectChain,
              latitude: outcome.store.latitude.toFixed(6),
              longitude: outcome.store.longitude.toFixed(6),
              municipalityCode: outcome.store.municipalityCode,
              name: outcome.store.name,
              observedAt: outcome.store.observedAt,
              postalCode: outcome.store.postalCode,
              status: outcome.store.status ?? "active",
              updatedAt: sql`now()`,
            },
            setWhere: physicalStoreReplacementCondition,
          });
      }
      throwIfIngestionCancelled(signal);
      await transaction.insert(physicalStoreCoverageChecks).values(coverage.map((entry) => ({
        chain: entry.chain,
        checkedAt: entry.checkedAt,
        ingestionRunId: handle.id,
        reason: entry.state === "unknown" ? entry.reason : null,
        recordCount: entry.recordCount,
        sourceId: handle.sourceId,
        state: entry.state,
      })));
      return audit;
    }, signal);
  }

  async finalizeRun(
    handle: IngestionRunHandle,
    input: {
      completedAt: Date;
      errorClass?: string;
      failed?: number;
      status: IngestionTerminalStatus;
    },
    signal?: AbortSignal,
  ): Promise<{ counts: IngestionRunCounters; status: IngestionTerminalStatus }> {
    requireValidDate(input.completedAt, "completedAt");
    if (input.errorClass !== undefined) {
      requireBoundedString(input.errorClass, "errorClass", 80);
    }
    const failed = input.failed ?? 0;
    reconstructIngestionRunCounters([], failed);
    if (
      input.status !== "cancelled"
      && input.status !== "completed"
      && input.status !== "degraded"
      && input.status !== "failed"
    ) {
      throw new TypeError("Ingestion finalization requires a terminal status");
    }
    if (input.status === "completed" && failed > 0) {
      throw new TypeError("A completed ingestion run cannot contain failures");
    }

    return this.fencedTransaction(this.fenceContext(handle), signal, async (transaction) => {
      const run = await this.lockRun(transaction, handle);
      if (run.status !== "running") {
        if (run.status !== input.status) {
          throw new Error(`Ingestion run ${handle.id} is already ${run.status}`);
        }
        return {
          counts: run.counts as IngestionRunCounters,
          status: run.status as IngestionTerminalStatus,
        };
      }
      if (input.completedAt < run.startedAt) {
        throw new TypeError("completedAt must not precede startedAt");
      }

      const states = await transaction
        .select({ outcomeState: sourceRecordOutcomes.outcomeState })
        .from(sourceRecordOutcomes)
        .where(eq(sourceRecordOutcomes.ingestionRunId, handle.id));
      const counts = reconstructIngestionRunCounters(
        states.map(({ outcomeState }) => outcomeState as SourceRecordOutcomeState),
        failed,
      );
      await transaction
        .update(ingestionRuns)
        .set({
          completedAt: input.completedAt,
          counts,
          errorClass: input.errorClass ?? null,
          status: input.status,
        })
        .where(eq(ingestionRuns.id, handle.id));
      return { counts, status: input.status };
    });
  }

  private async resolveProductByGtin(
    transaction: IngestionTransaction,
    ean: string,
    catalog?: {
      handle: IngestionRunHandle;
      outcome: AcceptedCatalogIngestionOutcome;
      sourceAccessApproved: true;
    },
  ): Promise<{ productId: number; reviewRequired: boolean }> {
    if (canonicalGtin(ean) === undefined) {
      throw new TypeError("Canonical product resolution requires a valid GTIN");
    }
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ean}, 0))`,
    );
    const [identifier] = await transaction
      .select({
        id: productIdentifiers.id,
        productId: productIdentifiers.productId,
        verifiedAt: productIdentifiers.verifiedAt,
      })
      .from(productIdentifiers)
      .where(
        and(
          eq(productIdentifiers.value, ean),
          inArray(productIdentifiers.scheme, ["ean8", "ean13"]),
        ),
      )
      .limit(1);

    if (identifier !== undefined) {
      if (catalog !== undefined) {
        const [canonical] = await transaction
          .select({
            brand: canonicalProducts.brand,
            displayName: canonicalProducts.displayName,
            packageAmount: canonicalProducts.packageAmount,
            packageUnit: canonicalProducts.packageUnit,
            status: canonicalProducts.status,
            unitsPerPack: canonicalProducts.unitsPerPack,
            updatedAt: canonicalProducts.updatedAt,
          })
          .from(canonicalProducts)
          .where(eq(canonicalProducts.id, identifier.productId))
          .for("update")
          .limit(1);
        if (canonical === undefined) {
          throw new Error(`Canonical product ${identifier.productId} does not exist`);
        }
        const [matchedSource] = await transaction
          .select({
            canonicalProductId: sourceProducts.canonicalProductId,
            matchState: sourceProducts.matchState,
          })
          .from(sourceProducts)
          .where(
            and(
              eq(sourceProducts.sourceId, catalog.handle.sourceId),
              eq(sourceProducts.externalId, catalog.outcome.sourceRecordId),
            ),
          )
          .limit(1);
        const isSameMatchedSource = matchedSource?.canonicalProductId === identifier.productId
          && matchedSource.matchState === "matched";
        const [priorCompletedObservation] = isSameMatchedSource
          ? await transaction
              .select({ sourceUpdatedAt: catalogObservations.sourceUpdatedAt })
              .from(catalogObservations)
              .innerJoin(
                ingestionRuns,
                and(
                  eq(ingestionRuns.id, catalogObservations.ingestionRunId),
                  eq(ingestionRuns.sourceId, catalog.handle.sourceId),
                  eq(ingestionRuns.status, "completed"),
                ),
              )
              .where(
                and(
                  eq(catalogObservations.canonicalProductId, identifier.productId),
                  eq(catalogObservations.sourceRecordId, catalog.outcome.sourceRecordId),
                ),
              )
              .orderBy(desc(catalogObservations.retrievedAt), desc(catalogObservations.id))
              .limit(1)
          : [];
        const identifierNeedsVerification = identifier.verifiedAt === null;
        const mutation = catalogCanonicalMutationDecision({
          canonical: canonical as CatalogCanonicalSnapshot,
          incoming: catalog.outcome.product,
          ...(isSameMatchedSource
            ? {
                matchedSourceVersion: {
                  sourceUpdatedAt: priorCompletedObservation?.sourceUpdatedAt ?? null,
                },
              }
            : {}),
          sourceAccessApproved: catalog.sourceAccessApproved,
        });
        if (mutation === "review") {
          return { productId: identifier.productId, reviewRequired: true };
        }
        // Matching canonical fields are idempotent, but turning an unverified
        // GTIN into public identity evidence remains behind the batch's exact
        // source-governance decision.
        if (mutation === "activate" || mutation === "correct") {
          await transaction
            .update(canonicalProducts)
            .set({
              brand: catalog.outcome.product.brand ?? null,
              displayName: catalog.outcome.product.displayName,
              packageAmount: catalog.outcome.product.packageAmount,
              packageUnit: catalog.outcome.product.packageUnit,
              ...(mutation === "activate" ? { status: "active" } : {}),
              unitsPerPack: catalog.outcome.product.unitsPerPack ?? 1,
              updatedAt: catalog.outcome.product.retrievedAt,
            })
            .where(eq(canonicalProducts.id, identifier.productId));
        }
        if (identifierNeedsVerification) {
          await transaction
            .update(productIdentifiers)
            .set({ confidence: 100, verifiedAt: catalog.outcome.product.retrievedAt })
            .where(eq(productIdentifiers.id, identifier.id));
        }
      }
      return { productId: identifier.productId, reviewRequired: false };
    }

    const catalogProduct = catalog?.outcome.product;
    const [product] = await transaction
      .insert(canonicalProducts)
      .values(
        catalogProduct === undefined
          ? {
              displayName: `Pending catalog match ${ean}`,
              packageAmount: 1,
              packageUnit: "package",
              status: "quarantined",
              unitsPerPack: 1,
            }
          : {
              brand: catalogProduct.brand,
              displayName: catalogProduct.displayName,
              packageAmount: catalogProduct.packageAmount,
              packageUnit: catalogProduct.packageUnit,
              status: catalog?.sourceAccessApproved === true ? "active" : "quarantined",
              unitsPerPack: catalogProduct.unitsPerPack ?? 1,
              updatedAt: catalogProduct.retrievedAt,
            },
      )
      .returning({ id: canonicalProducts.id });
    if (product === undefined) throw new Error("Could not create canonical product");
    await transaction.insert(productIdentifiers).values({
      confidence: 100,
      productId: product.id,
      scheme: identifierScheme(ean),
      sourceId: null,
      value: ean,
      verifiedAt: catalogProduct?.retrievedAt,
    });
    return {
      productId: product.id,
      reviewRequired: catalogProduct !== undefined && catalog?.sourceAccessApproved !== true,
    };
  }

  private async sourceAllowsCapabilities(
    transaction: IngestionTransaction,
    sourceId: string,
    capabilities: readonly SourceIngestionCapability[],
  ): Promise<boolean> {
    if (capabilities.length < 1) return false;
    await this.lockSourceGovernance(transaction, sourceId);
    const requiredPermissions = JSON.stringify(Object.fromEntries(
      capabilities.map((capability) => [capability, true]),
    ));
    const [authorization] = await transaction
      .select({
        approved: sql<boolean>`
          ${dataSources.runtimeState} = 'approved'
          and ${dataSources.permissionReviewedAt} is not null
          and ${dataSources.permissionReviewedAt} <= clock_timestamp()
          and ${dataSources.permissionReviewedAt} = ${sourcePermissions.reviewedAt}
          and ${dataSources.permissionExpiresAt} is not distinct from ${sourcePermissions.validUntil}
          and (
            ${dataSources.permissionExpiresAt} is null
            or ${dataSources.permissionExpiresAt} > clock_timestamp()
          )
          and ${sourcePermissions.createdAt} <= clock_timestamp()
          and ${sourcePermissions.reviewedAt} <= clock_timestamp()
          and ${sourcePermissions.decision} = 'approved'
          and (
            ${sourcePermissions.validUntil} is null
            or ${sourcePermissions.validUntil} > clock_timestamp()
          )
          and ${sourcePermissions.permissions} @> ${requiredPermissions}::jsonb
        `,
      })
      .from(dataSources)
      .innerJoin(
        sourcePermissions,
        eq(sourcePermissions.sourceId, dataSources.id),
      )
      .where(
        and(
          eq(dataSources.id, sourceId),
          sql`${sourcePermissions.createdAt} <= clock_timestamp()`,
        ),
      )
      .orderBy(desc(sourcePermissions.createdAt), desc(sourcePermissions.id))
      .limit(1);
    return authorization?.approved === true;
  }

  private async lockSourceGovernance(
    transaction: IngestionTransaction,
    sourceId: string,
  ): Promise<void> {
    await transaction.execute(sql`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${sourceId},
          ${SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED}
        )
      )
    `);
  }

  private async lockProductGtins(
    transaction: IngestionTransaction,
    gtins: readonly string[],
  ): Promise<void> {
    for (const gtin of gtins) {
      await transaction.execute(sql`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${gtin}, 0)
        )
      `);
    }
  }

  private async linkSourceProduct(
    transaction: IngestionTransaction,
    handle: IngestionRunHandle,
    outcome: AcceptedCatalogIngestionOutcome,
    audited: SourceRecordOutcomeInput,
    productId: number,
  ): Promise<void> {
    await transaction
      .insert(productIdentifiers)
      .values({
        confidence: 100,
        productId,
        scheme: "source",
        sourceId: handle.sourceId,
        value: outcome.sourceRecordId,
        verifiedAt: outcome.product.retrievedAt,
      })
      .onConflictDoNothing();
    const [sourceIdentifier] = await transaction
      .select({ productId: productIdentifiers.productId })
      .from(productIdentifiers)
      .where(
        and(
          eq(productIdentifiers.scheme, "source"),
          eq(productIdentifiers.sourceId, handle.sourceId),
          eq(productIdentifiers.value, outcome.sourceRecordId),
        ),
      )
      .limit(1);
    if (sourceIdentifier === undefined || sourceIdentifier.productId !== productId) {
      throw new Error(
        `Source product identity conflict for ${handle.sourceId}/${outcome.sourceRecordId}`,
      );
    }

    await transaction
      .insert(sourceProducts)
      .values({
        canonicalProductId: productId,
        externalId: outcome.sourceRecordId,
        firstSeenAt: outcome.product.retrievedAt,
        lastSeenAt: outcome.product.retrievedAt,
        matchState: "matched",
        normalizedFields: audited.normalizedRecord ?? {},
        rawRecordHash: hashSourceRecordOutcome(audited),
        sourceId: handle.sourceId,
      })
      .onConflictDoUpdate({
        target: [sourceProducts.sourceId, sourceProducts.externalId],
        set: {
          canonicalProductId: productId,
          lastSeenAt: outcome.product.retrievedAt,
          matchState: "matched",
          normalizedFields: audited.normalizedRecord ?? {},
          rawRecordHash: hashSourceRecordOutcome(audited),
        },
        setWhere: sourceProductReplacementCondition,
      });
  }

  private async appendCatalogObservation(
    transaction: IngestionTransaction,
    handle: IngestionRunHandle,
    outcome: AcceptedCatalogIngestionOutcome,
    audited: SourceRecordOutcomeInput,
    productId: number,
  ): Promise<void> {
    await transaction
      .insert(catalogObservations)
      .values({
        brand: outcome.product.brand ?? null,
        categoryPath: outcome.product.categoryPath?.map((entry) => ({ ...entry })) ?? null,
        canonicalProductId: productId,
        displayName: outcome.product.displayName,
        gtin: outcome.subjectEan,
        ingestionRunId: handle.id,
        packageAmount: outcome.product.packageAmount,
        packageUnit: outcome.product.packageUnit,
        rawRecordHash: hashSourceRecordOutcome(audited),
        retrievedAt: outcome.product.retrievedAt,
        sourceRecordId: outcome.sourceRecordId,
        sourceUpdatedAt: outcome.product.sourceUpdatedAt ?? null,
        unitsPerPack: outcome.product.unitsPerPack ?? 1,
      })
      .onConflictDoNothing({
        target: [catalogObservations.ingestionRunId, catalogObservations.sourceRecordId],
      });
  }

  private fenceContext(handle: IngestionRunHandle): IngestionFenceContext {
    return {
      fenceToken: handle.fenceToken,
      ingestionRunId: handle.id,
      jobId: handle.jobId,
      sourceId: handle.sourceId,
    };
  }

  private async withRunningRun<T>(
    handle: IngestionRunHandle,
    callback: (transaction: IngestionTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.fencedTransaction(this.fenceContext(handle), signal, async (transaction) => {
      const run = await this.lockRun(transaction, handle);
      if (run.status !== "running") {
        throw new Error(`Ingestion run ${handle.id} is ${run.status}, not running`);
      }
      return callback(transaction);
    });
  }

  private async fencedTransaction<T>(
    context: Readonly<IngestionFenceContext>,
    signal: AbortSignal | undefined,
    callback: (transaction: IngestionTransaction) => Promise<T>,
  ): Promise<T> {
    throwIfIngestionCancelled(signal);
    return this.db.transaction(async (transaction) => {
      // Keep every persistence statement and advisory-lock wait bounded well
      // inside the shortest five-minute worker job. set_config(..., true) is
      // transaction-local, so pooled sessions cannot retain these limits.
      await transaction.execute(sql`
        select
          pg_catalog.set_config(
            'lock_timeout',
            ${`${INGESTION_LOCK_TIMEOUT_MS}ms`},
            true
          ),
          pg_catalog.set_config(
            'statement_timeout',
            ${`${INGESTION_STATEMENT_TIMEOUT_MS}ms`},
            true
          )
      `);
      await this.verifyFence(transaction, context, "initial");
      throwIfIngestionCancelled(signal);
      const result = await callback(transaction);
      throwIfIngestionCancelled(signal);
      await this.verifyFence(transaction, context, "before-commit");
      return result;
    });
  }

  private async lockRun(
    transaction: IngestionTransaction,
    handle: IngestionRunHandle,
  ): Promise<{
    counts: Record<string, number>;
    runType: string;
    sourceId: string;
    startedAt: Date;
    status: string;
  }> {
    const [run] = await transaction
      .select({
        counts: ingestionRuns.counts,
        jobId: ingestionRuns.jobId,
        runType: ingestionRuns.runType,
        sourceId: ingestionRuns.sourceId,
        startedAt: ingestionRuns.startedAt,
        status: ingestionRuns.status,
      })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, handle.id))
      .for("update")
      .limit(1);
    if (run === undefined) throw new Error(`Ingestion run ${handle.id} does not exist`);
    if (
      run.jobId !== handle.jobId
      || run.sourceId !== handle.sourceId
      || run.runType !== handle.runType
    ) {
      throw new Error(`Ingestion run handle identity mismatch for ${handle.id}`);
    }
    return run;
  }

  private async auditOutcomesWithin(
    transaction: IngestionTransaction,
    handle: IngestionRunHandle,
    outcomes: readonly SourceRecordOutcomeInput[],
    signal?: AbortSignal,
  ): Promise<IngestionWriteResult> {
    let inserted = 0;
    for (const outcome of outcomes) {
      throwIfIngestionCancelled(signal);
      validateSourceRecordOutcome(outcome);
      const outcomeHash = hashSourceRecordOutcome(outcome);
      const [created] = await transaction
        .insert(sourceRecordOutcomes)
        .values({
          ingestionRunId: handle.id,
          normalizedRecord: outcome.normalizedRecord,
          outcomeHash,
          outcomeState: outcome.outcomeState,
          rawChainCode: outcome.rawChainCode,
          reason: outcome.outcomeState === "accepted" ? null : outcome.reason,
          recordedAt: outcome.recordedAt,
          recordKind: outcome.recordKind,
          sourceRecordId: outcome.sourceRecordId,
          subjectChain: outcome.subjectChain,
          subjectEan: outcome.subjectEan,
        })
        .onConflictDoNothing()
        .returning({ id: sourceRecordOutcomes.id });
      if (created !== undefined) {
        inserted += 1;
        continue;
      }

      const [existing] = await transaction
        .select({ outcomeHash: sourceRecordOutcomes.outcomeHash })
        .from(sourceRecordOutcomes)
        .where(
          and(
            eq(sourceRecordOutcomes.ingestionRunId, handle.id),
            eq(sourceRecordOutcomes.recordKind, outcome.recordKind),
            eq(sourceRecordOutcomes.sourceRecordId, outcome.sourceRecordId),
          ),
        )
        .limit(1);
      if (existing === undefined || existing.outcomeHash !== outcomeHash) {
        throw new IngestionOutcomeConflictError(
          handle.id,
          outcome.recordKind,
          outcome.sourceRecordId,
        );
      }
    }
    return { inserted, received: outcomes.length };
  }
}
