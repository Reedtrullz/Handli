import { createHash } from "node:crypto";

import {
  type KassalappChainId,
  type KassalappIngestionGateway,
  type KassalappPhysicalStoreCoverageV1,
  type PhysicalStoreCoverageReason,
  type KassalappPhysicalStoreSourceRecordV1,
  type KassalappPriceSourceRecordV1,
  type KassalappProductSourceRecordV1,
  type SourceRecordOutcome,
  isValidGtin,
} from "@handleplan/kassalapp";

import type {
  KassalappWorkerJobKind,
  WorkerRunCounters,
} from "./contracts";
import {
  WorkerCancelledError,
  type WorkerJobHandler,
} from "./runner";

const KASSALAPP_SOURCE_ID = "kassalapp" as const;
const MAX_INGESTION_BATCH_SIZE = 25;
const MAX_SOURCE_CALLS_BETWEEN_ACCESS_CHECKS = 25;
const MAX_TARGETS = 500;

const RUN_TYPE_BY_JOB_KIND: Readonly<Record<KassalappWorkerJobKind, string>> = {
  "benchmark-price-refresh": "benchmark-prices",
  "catalog-refresh": "catalog",
  "historical-observation-collection": "historical-prices",
  "physical-store-sync": "physical-stores",
};

const CHAIN_BY_CODE: Readonly<Record<string, KassalappChainId>> = {
  BUNNPRIS: "bunnpris",
  COOP_EXTRA: "extra",
  REMA_1000: "rema-1000",
};

export type KassalappSourceAccessState =
  | "approved"
  | "blocked"
  | "conditional"
  | "revoked";

export interface KassalappSourceAccessPolicy {
  getAccessState(
    context: Readonly<{
      jobKind: KassalappWorkerJobKind;
      sourceId: typeof KASSALAPP_SOURCE_ID;
    }>,
    signal: AbortSignal,
  ): Promise<KassalappSourceAccessState>;
}

export interface KassalappCatalogTarget {
  readonly ean: string;
}

export interface KassalappPriceTarget extends KassalappCatalogTarget {
  readonly geographicScopeId?: number;
}

export interface KassalappTargetProvider {
  getCatalogDiscoveryPage(signal: AbortSignal): Promise<number>;
  getCatalogTargets(signal: AbortSignal): Promise<readonly KassalappCatalogTarget[]>;
  getBenchmarkPriceTargets(signal: AbortSignal): Promise<readonly KassalappPriceTarget[]>;
  getHistoricalObservationTargets(signal: AbortSignal): Promise<readonly KassalappPriceTarget[]>;
}

interface PersistedOutcomeBase {
  readonly normalizedRecord?: Readonly<Record<string, unknown>>;
  readonly outcomeState: "accepted" | "quarantined" | "unknown";
  readonly rawChainCode?: string;
  readonly recordedAt: Date;
  readonly sourceRecordId: string;
  readonly subjectChain?: KassalappChainId;
  readonly subjectEan?: string;
}

interface PersistedNonAcceptedOutcome extends PersistedOutcomeBase {
  readonly outcomeState: "quarantined" | "unknown";
  readonly reason: string;
}

export type KassalappCatalogIngestionOutcome =
  | (PersistedOutcomeBase & {
      readonly outcomeState: "accepted";
      readonly product: {
        readonly brand?: string;
        readonly categoryPath?: readonly {
          readonly depth: number;
          readonly name: string;
          readonly sourceCategoryId: string;
        }[];
        readonly displayName: string;
        readonly packageAmount: number;
        readonly packageUnit: "g" | "ml" | "package" | "piece";
        readonly retrievedAt: Date;
        readonly sourceUpdatedAt?: Date;
        readonly unitsPerPack?: number;
      };
      readonly recordKind: "product";
      readonly subjectEan: string;
    })
  | (PersistedNonAcceptedOutcome & { readonly recordKind: "product" });

export type KassalappPriceIngestionOutcome =
  | (PersistedOutcomeBase & {
      readonly outcomeState: "accepted";
      readonly price: {
        readonly amountOre: number;
        readonly fetchedAt: Date;
        readonly geographicScopeId?: number;
        readonly observedAt: Date;
        readonly sourceReference: string;
      };
      readonly recordKind: "price";
      readonly subjectChain: KassalappChainId;
      readonly subjectEan: string;
    })
  | (PersistedNonAcceptedOutcome & {
      readonly geographicScopeId?: number;
      readonly recordKind: "price";
    });

export type KassalappPhysicalStoreIngestionOutcome =
  | (PersistedOutcomeBase & {
      readonly outcomeState: "accepted";
      readonly recordKind: "physical-store";
      readonly store: {
        readonly addressLine?: string;
        readonly latitude?: number;
        readonly longitude?: number;
        readonly name: string;
        readonly observedAt: Date;
        readonly postalCode?: string;
        readonly status?: "active" | "closed" | "unknown";
      };
      readonly subjectChain: KassalappChainId;
    })
  | (PersistedNonAcceptedOutcome & { readonly recordKind: "physical-store" });

export type KassalappPhysicalStoreCoverage = {
  readonly chain: KassalappChainId;
  readonly checkedAt: Date;
  readonly recordCount: number;
} & (
  | { readonly state: "complete"; readonly reason?: never }
  | {
      readonly state: "unknown";
      readonly reason: PhysicalStoreCoverageReason;
    }
);

export interface KassalappIngestionRepository<RunHandle = unknown> {
  beginRun(
    input: Readonly<{
      fenceToken: string;
      jobId: string;
      runType: string;
      sourceId: typeof KASSALAPP_SOURCE_ID;
      startedAt: Date;
    }>,
    signal?: AbortSignal,
  ): Promise<{ readonly handle: RunHandle }>;
  persistCatalogOutcomes(
    handle: RunHandle,
    outcomes: readonly KassalappCatalogIngestionOutcome[],
    signal: AbortSignal,
  ): Promise<unknown>;
  persistPriceOutcomes(
    handle: RunHandle,
    outcomes: readonly KassalappPriceIngestionOutcome[],
    signal: AbortSignal,
  ): Promise<unknown>;
  persistPhysicalStoreOutcomes(
    handle: RunHandle,
    outcomes: readonly KassalappPhysicalStoreIngestionOutcome[],
    coverage: readonly KassalappPhysicalStoreCoverage[],
    signal: AbortSignal,
  ): Promise<unknown>;
  finalizeRun(
    handle: RunHandle,
    input: Readonly<{
      completedAt: Date;
      errorClass?: "CANCELLED" | "PERSISTENCE_FAILURE" | "SOURCE_ACCESS_CHANGED";
      failed: number;
      status: "cancelled" | "completed" | "degraded";
    }>,
    signal?: AbortSignal,
  ): Promise<{ readonly counts: WorkerRunCounters }>;
}

export interface KassalappHandlerDependencies<RunHandle = unknown> {
  readonly clock: () => Date;
  readonly gateway: KassalappIngestionGateway;
  readonly repository: KassalappIngestionRepository<RunHandle>;
  readonly sourceAccessPolicy: KassalappSourceAccessPolicy;
  readonly targetProvider: KassalappTargetProvider;
}

class KassalappHandlerError extends Error {
  constructor(readonly code: "FINALIZATION_FAILURE") {
    super("Kassalapp ingestion finalization failed");
    this.name = "KassalappHandlerError";
  }
}

class SourceAccessChangedError extends Error {
  constructor() {
    super("Kassalapp source access changed");
    this.name = "SourceAccessChangedError";
  }
}

interface PreparedIngestion<RunHandle> {
  readonly failed: number;
  persist(handle: RunHandle, signal: AbortSignal): Promise<void>;
}

type CatalogCandidateOrigin = "discovery" | "exact";

interface CatalogSourceCandidate {
  readonly origin: CatalogCandidateOrigin;
  readonly outcome: SourceRecordOutcome<KassalappProductSourceRecordV1>;
  readonly targetEan: string;
}

interface IndexedCatalogOutcome {
  readonly index: number;
  readonly outcome: KassalappCatalogIngestionOutcome;
}

function checkedNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Invalid Kassalapp handler clock");
  }
  return new Date(value);
}

function checkedDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Invalid Kassalapp source timestamp");
  return parsed;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkerCancelledError();
}

function failedWithoutEvidence(): { counters: { failed: 1 } } {
  return { counters: { failed: 1 } };
}

function normalizedRecord(record: object): Readonly<Record<string, unknown>> {
  return { ...record };
}

function catalogSourceRecordId(candidate: CatalogSourceCandidate): string {
  return candidate.outcome.state === "accepted"
    ? candidate.outcome.record.sourceRecordId
    : candidate.outcome.sourceRecordId;
}

function catalogSubjectEan(candidate: CatalogSourceCandidate): string | undefined {
  const ean = candidate.outcome.state === "accepted"
    ? candidate.outcome.record.ean
    : candidate.outcome.ean ?? candidate.targetEan;
  return isValidGtin(ean) ? ean : undefined;
}

function catalogConflictOutcome(input: Readonly<{
  candidateCount: number;
  conflictSourceRecordIds: readonly string[];
  conflictType: "source-record-id" | "subject-ean";
  recordedAt: Date;
  sourceRecordId: string;
  subjectEan?: string;
}>): KassalappCatalogIngestionOutcome {
  return {
    normalizedRecord: {
      candidateCount: input.candidateCount,
      conflictSourceRecordIds: [...input.conflictSourceRecordIds].sort((left, right) =>
        left.localeCompare(right)),
      conflictType: input.conflictType,
    },
    outcomeState: "quarantined",
    reason: "DUPLICATE_IDENTITY",
    recordedAt: new Date(input.recordedAt),
    recordKind: "product",
    sourceRecordId: input.sourceRecordId,
    ...(input.subjectEan === undefined ? {} : { subjectEan: input.subjectEan }),
  };
}

/**
 * Produces one audit outcome per source identity and at most one accepted product per GTIN.
 * A discovery record wins a same-source/same-GTIN overlap because the exact request is only
 * a comparison read; every other ambiguous accepted identity is quarantined fail-closed.
 */
function canonicalCatalogOutcomes(
  candidates: readonly CatalogSourceCandidate[],
  recordedAt: Date,
): KassalappCatalogIngestionOutcome[] {
  const bySourceRecordId = new Map<string, Array<{
    candidate: CatalogSourceCandidate;
    index: number;
  }>>();
  candidates.forEach((candidate, index) => {
    const sourceRecordId = catalogSourceRecordId(candidate);
    const group = bySourceRecordId.get(sourceRecordId) ?? [];
    group.push({ candidate, index });
    bySourceRecordId.set(sourceRecordId, group);
  });

  const sourceCanonical: IndexedCatalogOutcome[] = [];
  for (const [sourceRecordId, group] of bySourceRecordId) {
    const firstIndex = Math.min(...group.map(({ index }) => index));
    const discoveryCandidates = group.filter(({ candidate }) => candidate.origin === "discovery");
    const discoveryAccepted = discoveryCandidates.filter(({ candidate }) =>
      candidate.outcome.state === "accepted");
    const knownEans = new Set(group
      .map(({ candidate }) => catalogSubjectEan(candidate))
      .filter((ean): ean is string => ean !== undefined));
    const discoveryShapes = new Set(discoveryAccepted.map(({ candidate }) =>
      JSON.stringify(candidate.outcome)));
    const allShapes = new Set(group.map(({ candidate }) => JSON.stringify(candidate.outcome)));

    let selected: CatalogSourceCandidate | undefined;
    if (group.length === 1 || allShapes.size === 1) {
      selected = group[0]!.candidate;
    } else if (
      discoveryAccepted.length > 0
      && discoveryCandidates.every(({ candidate }) => candidate.outcome.state === "accepted")
      && discoveryShapes.size === 1
      && knownEans.size === 1
    ) {
      selected = discoveryAccepted[0]!.candidate;
    }

    if (selected !== undefined) {
      sourceCanonical.push({
        index: firstIndex,
        outcome: mapCatalogOutcome(selected.outcome, selected.targetEan, recordedAt),
      });
      continue;
    }

    sourceCanonical.push({
      index: firstIndex,
      outcome: catalogConflictOutcome({
        candidateCount: group.length,
        conflictSourceRecordIds: [sourceRecordId],
        conflictType: "source-record-id",
        recordedAt,
        sourceRecordId,
        ...(
          knownEans.size === 1
            ? { subjectEan: [...knownEans][0]! }
            : {}
        ),
      }),
    });
  }

  const acceptedByEan = new Map<string, IndexedCatalogOutcome[]>();
  for (const entry of sourceCanonical) {
    if (entry.outcome.outcomeState !== "accepted") continue;
    const group = acceptedByEan.get(entry.outcome.subjectEan) ?? [];
    group.push(entry);
    acceptedByEan.set(entry.outcome.subjectEan, group);
  }

  const conflictingAccepted = new Set<IndexedCatalogOutcome>();
  const eanConflicts: IndexedCatalogOutcome[] = [];
  for (const [subjectEan, group] of acceptedByEan) {
    if (group.length < 2) continue;
    group.forEach((entry) => conflictingAccepted.add(entry));
    const sourceRecordIds = group.map(({ outcome }) => outcome.sourceRecordId)
      .sort((left, right) => left.localeCompare(right));
    eanConflicts.push(...group.map(({ index, outcome }) => ({
      index,
      outcome: catalogConflictOutcome({
        candidateCount: group.length,
        conflictSourceRecordIds: sourceRecordIds,
        conflictType: "subject-ean",
        recordedAt,
        sourceRecordId: outcome.sourceRecordId,
        subjectEan,
      }),
    })));
  }

  return sourceCanonical
    .filter((entry) => !conflictingAccepted.has(entry))
    .concat(eanConflicts)
    .sort((left, right) => left.index - right.index ||
      left.outcome.sourceRecordId.localeCompare(right.outcome.sourceRecordId))
    .map(({ outcome }) => outcome);
}

function ingestionAttemptJobId(jobId: string, fenceToken: string): string {
  const digest = createHash("sha256")
    .update(jobId)
    .update("\u0000")
    .update(fenceToken)
    .digest("hex");
  const suffix = `~attempt-${digest}`;
  return `${jobId.slice(0, 200 - suffix.length)}${suffix}`;
}

function subjectChain(
  outcome: Exclude<SourceRecordOutcome<never>, { state: "accepted" }>,
): KassalappChainId | undefined {
  return outcome.chainId ?? (outcome.chainCode === undefined
    ? undefined
    : CHAIN_BY_CODE[outcome.chainCode]);
}

function canonicalCatalogTargets(
  targets: readonly KassalappCatalogTarget[],
): KassalappCatalogTarget[] | undefined {
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS) {
    return undefined;
  }
  const byEan = new Map<string, KassalappCatalogTarget>();
  for (const target of targets) {
    if (typeof target !== "object" || target === null || !isValidGtin(target.ean)) return undefined;
    byEan.set(target.ean, { ean: target.ean });
  }
  return [...byEan.values()].sort((left, right) => left.ean.localeCompare(right.ean));
}

function canonicalPriceTargets(
  targets: readonly KassalappPriceTarget[],
): KassalappPriceTarget[] | undefined {
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  const catalogTargets = canonicalCatalogTargets(targets);
  if (catalogTargets === undefined) return undefined;
  const byEan = new Map<string, KassalappPriceTarget>();
  for (const target of targets) {
    if (
      target.geographicScopeId !== undefined
      && (!Number.isSafeInteger(target.geographicScopeId) || target.geographicScopeId < 1)
    ) {
      return undefined;
    }
    const previous = byEan.get(target.ean);
    if (
      previous !== undefined
      && previous.geographicScopeId !== target.geographicScopeId
    ) {
      return undefined;
    }
    byEan.set(target.ean, {
      ean: target.ean,
      ...(target.geographicScopeId === undefined
        ? {}
        : { geographicScopeId: target.geographicScopeId }),
    });
  }
  return catalogTargets.map(({ ean }) => byEan.get(ean)!);
}

function mapCatalogOutcome(
  outcome: SourceRecordOutcome<KassalappProductSourceRecordV1>,
  targetEan: string,
  recordedAt: Date,
): KassalappCatalogIngestionOutcome {
  if (outcome.state !== "accepted") {
    return {
      normalizedRecord: normalizedRecord(outcome),
      outcomeState: outcome.state,
      rawChainCode: outcome.chainCode,
      reason: outcome.reason,
      recordedAt,
      recordKind: "product",
      sourceRecordId: outcome.sourceRecordId,
      subjectChain: subjectChain(outcome),
      subjectEan: outcome.ean ?? targetEan,
    };
  }

  const record = outcome.record;
  const sourceRecordedAt = checkedDate(record.retrievedAt);
  if (record.packageMeasure === undefined) {
    return {
      normalizedRecord: normalizedRecord(record),
      outcomeState: "unknown",
      rawChainCode: undefined,
      reason: record.packageMeasureState === "unknown-unit" ? "UNKNOWN_UNIT" : "MISSING_MEASURE",
      recordedAt: sourceRecordedAt,
      recordKind: "product",
      sourceRecordId: record.sourceRecordId,
      subjectEan: record.ean,
    };
  }

  return {
    normalizedRecord: normalizedRecord(record),
    outcomeState: "accepted",
    rawChainCode: undefined,
    recordedAt: sourceRecordedAt,
    recordKind: "product",
    sourceRecordId: record.sourceRecordId,
    subjectEan: record.ean,
    product: {
      ...(record.brand === undefined ? {} : { brand: record.brand }),
      ...(record.categoryPath === undefined
        ? {}
        : { categoryPath: record.categoryPath.map((category) => ({ ...category })) }),
      displayName: record.name,
      packageAmount: record.packageMeasure.amount,
      packageUnit: record.packageMeasure.unit,
      retrievedAt: sourceRecordedAt,
      ...(record.sourceUpdatedAt === undefined
        ? {}
        : { sourceUpdatedAt: checkedDate(record.sourceUpdatedAt) }),
    },
  };
}

function eanForPriceOutcome(
  outcome: Exclude<SourceRecordOutcome<KassalappPriceSourceRecordV1>, { state: "accepted" }>,
  targets: ReadonlyMap<string, KassalappPriceTarget>,
): string | undefined {
  if (outcome.ean !== undefined) return outcome.ean;
  return targets.has(outcome.sourceRecordId) ? outcome.sourceRecordId : undefined;
}

function mapPriceOutcome(
  outcome: SourceRecordOutcome<KassalappPriceSourceRecordV1>,
  targets: ReadonlyMap<string, KassalappPriceTarget>,
  recordedAt: Date,
): KassalappPriceIngestionOutcome {
  if (outcome.state !== "accepted") {
    const ean = eanForPriceOutcome(outcome, targets);
    const geographicScopeId = ean === undefined ? undefined : targets.get(ean)?.geographicScopeId;
    return {
      ...(geographicScopeId === undefined ? {} : { geographicScopeId }),
      normalizedRecord: normalizedRecord(outcome),
      outcomeState: outcome.state,
      rawChainCode: outcome.chainCode,
      reason: outcome.reason,
      recordedAt,
      recordKind: "price",
      sourceRecordId: outcome.sourceRecordId,
      subjectChain: subjectChain(outcome),
      ...(ean === undefined ? {} : { subjectEan: ean }),
    };
  }

  const record = outcome.record;
  const geographicScopeId = targets.get(record.ean)?.geographicScopeId;
  const fetchedAt = checkedDate(record.retrievedAt);
  return {
    normalizedRecord: normalizedRecord(record),
    outcomeState: "accepted",
    rawChainCode: record.chainCode,
    recordedAt: fetchedAt,
    recordKind: "price",
    sourceRecordId: record.sourceRecordId,
    subjectChain: record.chainId,
    subjectEan: record.ean,
    price: {
      amountOre: record.amountOre,
      fetchedAt,
      ...(geographicScopeId === undefined ? {} : { geographicScopeId }),
      observedAt: checkedDate(record.observedAt),
      sourceReference: `${KASSALAPP_SOURCE_ID}:${record.sourceRecordId}`,
    },
  };
}

function mapStoreOutcome(
  outcome: SourceRecordOutcome<KassalappPhysicalStoreSourceRecordV1>,
  recordedAt: Date,
): KassalappPhysicalStoreIngestionOutcome {
  if (outcome.state !== "accepted") {
    return {
      normalizedRecord: normalizedRecord(outcome),
      outcomeState: outcome.state,
      rawChainCode: outcome.chainCode,
      reason: outcome.reason,
      recordedAt,
      recordKind: "physical-store",
      sourceRecordId: outcome.sourceRecordId,
      subjectChain: subjectChain(outcome),
    };
  }

  const record = outcome.record;
  const sourceRecordedAt = checkedDate(record.retrievedAt);
  if (record.latitude === undefined || record.longitude === undefined) {
    return {
      normalizedRecord: normalizedRecord(record),
      outcomeState: "unknown",
      rawChainCode: record.chainCode,
      reason: "MISSING_COORDINATES",
      recordedAt: sourceRecordedAt,
      recordKind: "physical-store",
      sourceRecordId: record.sourceRecordId,
      subjectChain: record.chainId,
    };
  }

  return {
    normalizedRecord: normalizedRecord(record),
    outcomeState: "accepted",
    rawChainCode: record.chainCode,
    recordedAt: sourceRecordedAt,
    recordKind: "physical-store",
    sourceRecordId: record.sourceRecordId,
    subjectChain: record.chainId,
    store: {
      ...(record.address === undefined ? {} : { addressLine: record.address }),
      ...(record.postalCode === undefined ? {} : { postalCode: record.postalCode }),
      latitude: record.latitude,
      longitude: record.longitude,
      name: record.name,
      observedAt: checkedDate(record.sourceUpdatedAt ?? record.retrievedAt),
      status: "active",
    },
  };
}

function mapStoreCoverage(
  coverage: KassalappPhysicalStoreCoverageV1,
  checkedAt: Date,
  outcomes: readonly KassalappPhysicalStoreIngestionOutcome[],
): KassalappPhysicalStoreCoverage {
  const normalizedCoverage = coverage.state === "complete"
    && outcomes.some((outcome) =>
      outcome.subjectChain === coverage.chainId && outcome.outcomeState !== "accepted")
    ? { reason: "INVALID_RECORDS" as const, state: "unknown" as const }
    : coverage;
  return normalizedCoverage.state === "complete"
    ? {
        chain: coverage.chainId,
        checkedAt: new Date(checkedAt),
        recordCount: coverage.recordCount,
        state: "complete",
      }
    : {
        chain: coverage.chainId,
        checkedAt: new Date(checkedAt),
        reason: normalizedCoverage.reason,
        recordCount: coverage.recordCount,
        state: "unknown",
      };
}

async function persistInBatches<RunHandle, Outcome>(
  handle: RunHandle,
  outcomes: readonly Outcome[],
  signal: AbortSignal,
  recheckAccess: (signal: AbortSignal) => Promise<void>,
  persist: (handle: RunHandle, batch: readonly Outcome[], signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < outcomes.length; index += MAX_INGESTION_BATCH_SIZE) {
    throwIfCancelled(signal);
    await recheckAccess(signal);
    await persist(handle, outcomes.slice(index, index + MAX_INGESTION_BATCH_SIZE), signal);
  }
  throwIfCancelled(signal);
}

function createExecutor<RunHandle>(
  dependencies: KassalappHandlerDependencies<RunHandle>,
  jobKind: KassalappWorkerJobKind,
  prepare: (
    signal: AbortSignal,
    recheckAccess: (signal: AbortSignal) => Promise<void>,
  ) => Promise<PreparedIngestion<RunHandle> | undefined>,
): WorkerJobHandler {
  const { repository, sourceAccessPolicy } = dependencies;
  return async ({ fenceToken, jobId, kind, signal, sourceId }) => {
    throwIfCancelled(signal);
    if (
      kind !== jobKind
      || sourceId !== KASSALAPP_SOURCE_ID
      || typeof fenceToken !== "string"
      || fenceToken.length < 1
      || fenceToken.length > 1_024
      || fenceToken.trim().length < 1
    ) {
      return failedWithoutEvidence();
    }
    try {
      const recheckAccess = async (accessSignal: AbortSignal): Promise<void> => {
        try {
          const access = await sourceAccessPolicy.getAccessState({
            jobKind,
            sourceId: KASSALAPP_SOURCE_ID,
          }, accessSignal);
          throwIfCancelled(accessSignal);
          if (access !== "approved") throw new SourceAccessChangedError();
        } catch (error) {
          if (error instanceof WorkerCancelledError) throw error;
          if (accessSignal.aborted) throw new WorkerCancelledError();
          if (error instanceof SourceAccessChangedError) throw error;
          throw new SourceAccessChangedError();
        }
      };

      await recheckAccess(signal);

      const prepared = await prepare(signal, recheckAccess);
      throwIfCancelled(signal);
      if (prepared === undefined) return failedWithoutEvidence();

      await recheckAccess(signal);

      let handle: RunHandle;
      try {
        const begun = await repository.beginRun({
          fenceToken,
          jobId: ingestionAttemptJobId(jobId, fenceToken),
          runType: RUN_TYPE_BY_JOB_KIND[jobKind],
          sourceId: KASSALAPP_SOURCE_ID,
          startedAt: checkedNow(dependencies.clock),
        }, signal);
        handle = begun.handle;
      } catch {
        if (signal.aborted) throw new WorkerCancelledError();
        return failedWithoutEvidence();
      }

      const finalizeNonCompletedRun = async (
        reason: "cancelled" | "persistence-failure" | "source-access-changed",
      ) => {
        const cancelled = reason === "cancelled";
        try {
          const finalized = await repository.finalizeRun(handle, {
            completedAt: checkedNow(dependencies.clock),
            errorClass: cancelled
              ? "CANCELLED"
              : reason === "persistence-failure"
                ? "PERSISTENCE_FAILURE"
                : "SOURCE_ACCESS_CHANGED",
            failed: cancelled ? prepared.failed : prepared.failed + 1,
            status: cancelled ? "cancelled" : "degraded",
          }, cancelled ? undefined : signal);
          if (cancelled) throw new WorkerCancelledError(finalized.counts);
          return { counters: finalized.counts };
        } catch (error) {
          if (error instanceof WorkerCancelledError) throw error;
          if (cancelled) throw new WorkerCancelledError();
          throw new KassalappHandlerError("FINALIZATION_FAILURE");
        }
      };

      try {
        await prepared.persist(handle, signal);
      } catch (error) {
        return finalizeNonCompletedRun(
          signal.aborted
            ? "cancelled"
            : error instanceof SourceAccessChangedError
              ? "source-access-changed"
              : "persistence-failure",
        );
      }

      try {
        await recheckAccess(signal);
      } catch {
        return finalizeNonCompletedRun(signal.aborted ? "cancelled" : "source-access-changed");
      }

      try {
        const finalized = await repository.finalizeRun(handle, {
          completedAt: checkedNow(dependencies.clock),
          failed: prepared.failed,
          status: prepared.failed === 0 ? "completed" : "degraded",
        }, signal);
        return { counters: finalized.counts };
      } catch {
        if (signal.aborted) throw new WorkerCancelledError();
        throw new KassalappHandlerError("FINALIZATION_FAILURE");
      }
    } catch (error) {
      if (error instanceof WorkerCancelledError) throw error;
      if (signal.aborted) throw new WorkerCancelledError();
      if (error instanceof KassalappHandlerError) throw error;
      return failedWithoutEvidence();
    }
  };
}

export function createKassalappHandlers<RunHandle>(
  dependencies: KassalappHandlerDependencies<RunHandle>,
): Record<KassalappWorkerJobKind, WorkerJobHandler> {
  const { gateway, repository, targetProvider } = dependencies;

  const catalogRefresh = createExecutor(dependencies, "catalog-refresh", async (
    signal,
    recheckAccess,
  ) => {
    const targets = canonicalCatalogTargets(await targetProvider.getCatalogTargets(signal));
    if (targets === undefined) return undefined;
    const discoveryPage = await targetProvider.getCatalogDiscoveryPage(signal);
    if (!Number.isSafeInteger(discoveryPage) || discoveryPage < 1 || discoveryPage > 100) {
      return undefined;
    }
    const sourceOutcomes: CatalogSourceCandidate[] = [];
    let failed = 0;
    const discovered = await gateway.getSourceCatalogProducts(discoveryPage, 100, signal);
    if (!Array.isArray(discovered) || discovered.length > 100) return undefined;
    sourceOutcomes.push(...discovered.map((outcome) => ({
      origin: "discovery" as const,
      outcome,
      targetEan: outcome.state === "accepted"
        ? outcome.record.ean
        : outcome.ean ?? outcome.sourceRecordId,
    })));
    const discoveredAcceptedEans = new Set(discovered.flatMap((outcome) =>
      outcome.state === "accepted" ? [outcome.record.ean] : []));
    const exactTargets = targets.filter(({ ean }) => !discoveredAcceptedEans.has(ean));
    if (exactTargets.length > 0) {
      await recheckAccess(signal);
    }
    for (let index = 0; index < exactTargets.length; index += 1) {
      if (index > 0 && index % MAX_SOURCE_CALLS_BETWEEN_ACCESS_CHECKS === 0) {
        await recheckAccess(signal);
      }
      const target = exactTargets[index]!;
      throwIfCancelled(signal);
      let outcomes: Array<SourceRecordOutcome<KassalappProductSourceRecordV1>>;
      try {
        outcomes = await gateway.getSourceProductByEan(target.ean, signal);
      } catch {
        throwIfCancelled(signal);
        failed += 1;
        outcomes = [{
          ean: target.ean,
          reason: "BATCH_FAILED",
          sourceRecordId: target.ean,
          state: "unknown",
        }];
      }
      if (outcomes.length === 0) {
        sourceOutcomes.push({
          origin: "exact",
          outcome: {
            ean: target.ean,
            reason: "NOT_FOUND",
            sourceRecordId: target.ean,
            state: "unknown",
          },
          targetEan: target.ean,
        });
      } else {
        sourceOutcomes.push(...outcomes.map((outcome) => ({
          origin: "exact" as const,
          outcome,
          targetEan: target.ean,
        })));
      }
    }
    if (sourceOutcomes.length === 0) return undefined;
    const recordedAt = checkedNow(dependencies.clock);
    const outcomes = canonicalCatalogOutcomes(sourceOutcomes, recordedAt);
    return {
      failed,
      persist: async (handle, persistSignal) => await persistInBatches(
        handle,
        outcomes,
        persistSignal,
        recheckAccess,
        (run, batch, batchSignal) => repository.persistCatalogOutcomes(run, batch, batchSignal),
      ),
    };
  });

  const createPriceHandler = (
    jobKind: "benchmark-price-refresh" | "historical-observation-collection",
    getTargets: (signal: AbortSignal) => Promise<readonly KassalappPriceTarget[]>,
    getPrices: (
      eans: string[],
      signal: AbortSignal,
    ) => Promise<Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>>>,
  ) => createExecutor(dependencies, jobKind, async (signal, recheckAccess) => {
    const targets = canonicalPriceTargets(await getTargets(signal));
    if (targets === undefined) return undefined;
    const byEan = new Map(targets.map((target) => [target.ean, target]));
    const sourceOutcomes: Array<SourceRecordOutcome<KassalappPriceSourceRecordV1>> = [];
    for (
      let index = 0;
      index < targets.length;
      index += MAX_SOURCE_CALLS_BETWEEN_ACCESS_CHECKS
    ) {
      if (index > 0) await recheckAccess(signal);
      sourceOutcomes.push(...await getPrices(
        targets
          .slice(index, index + MAX_SOURCE_CALLS_BETWEEN_ACCESS_CHECKS)
          .map(({ ean }) => ean),
        signal,
      ));
    }
    const recordedAt = checkedNow(dependencies.clock);
    const outcomes = sourceOutcomes.map((outcome) => mapPriceOutcome(outcome, byEan, recordedAt));
    const failed = sourceOutcomes.filter((outcome) =>
      outcome.state === "unknown" && outcome.reason === "BATCH_FAILED").length;
    return {
      failed,
      persist: async (handle, persistSignal) => await persistInBatches(
        handle,
        outcomes,
        persistSignal,
        recheckAccess,
        (run, batch, batchSignal) => repository.persistPriceOutcomes(run, batch, batchSignal),
      ),
    };
  });

  const benchmarkPriceRefresh = createPriceHandler(
    "benchmark-price-refresh",
    (signal) => targetProvider.getBenchmarkPriceTargets(signal),
    (eans, signal) => gateway.getSourceBulkPrices(eans, signal),
  );

  const historicalObservationCollection = createPriceHandler(
    "historical-observation-collection",
    (signal) => targetProvider.getHistoricalObservationTargets(signal),
    (eans, signal) => gateway.getSourceHistoricalPrices(eans, signal),
  );

  const physicalStoreSync = createExecutor(dependencies, "physical-store-sync", async (
    signal,
    recheckAccess,
  ) => {
    const result = await gateway.getSourcePhysicalStores(signal);
    const recordedAt = checkedNow(dependencies.clock);
    const outcomes = result.outcomes.map((outcome) => mapStoreOutcome(outcome, recordedAt));
    const coverage = result.coverage.map((entry) =>
      mapStoreCoverage(entry, recordedAt, outcomes));
    const failed = result.coverage.filter((entry) =>
      entry.state === "unknown" && entry.reason === "REQUEST_FAILED").length;
    return {
      failed,
      persist: async (handle, persistSignal) => {
        throwIfCancelled(persistSignal);
        await recheckAccess(persistSignal);
        await repository.persistPhysicalStoreOutcomes(
          handle,
          outcomes,
          coverage,
          persistSignal,
        );
        throwIfCancelled(persistSignal);
      },
    };
  });

  return {
    "benchmark-price-refresh": benchmarkPriceRefresh,
    "catalog-refresh": catalogRefresh,
    "historical-observation-collection": historicalObservationCollection,
    "physical-store-sync": physicalStoreSync,
  };
}
