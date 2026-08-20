import { createHash } from "node:crypto";

import {
  type PostgresWorkerJobStateRepository,
  type WorkerJobResultRecord,
} from "@handleplan/db/worker-state";
import { ingestionWorkerLeaseKey } from "@handleplan/db/worker-lease";
import type {
  SourceAccessSnapshot,
} from "@handleplan/db/source-access";
import { PostgresIngestionRepository } from "@handleplan/db/ingestion";
import type { WorkerGtinTargetReader } from "@handleplan/db/worker-targets";
import {
  isValidGtin,
  type KassalappIngestionGateway,
  type KassalappRequestAttemptAuthorizer,
  type KassalappRequestScope,
} from "@handleplan/kassalapp";
import type {
  OpenPricesPrice,
  OpenPricesPriceIngestionOutcome,
} from "@handleplan/open-prices";

import type {
  KassalappWorkerJobKind,
  OpenPricesWorkerJobKind,
  WorkerJobRequest,
  WorkerRunResult,
} from "./contracts";
import type {
  KassalappIngestionRepository,
  KassalappSourceAccessPolicy,
  KassalappSourceAccessState,
  KassalappTargetProvider,
} from "./kassalapp-handlers";
import {
  createOpenPricesHandlers,
  type OpenPricesSourceAccessPolicy,
  type OpenPricesSourceAccessState,
  type OpenPricesTargetProvider,
} from "./open-prices-handlers";
import { createKassalappHandlers } from "./kassalapp-handlers";
import { WorkerRunner } from "./runner";
import {
  WorkerRuntime,
  type WorkerLeaseHandle,
  type WorkerLeaseProvider,
  type WorkerRuntimeObserver,
  type WorkerRuntimeStateStore,
} from "./runtime";
import type { WorkerScheduleDefinition } from "./schedule";

const KASSALAPP_SOURCE_ID = "kassalapp" as const;
const MAX_TARGETS = 500;

export const KASSALAPP_PRODUCTION_SCHEDULES: readonly WorkerScheduleDefinition[] = Object.freeze([
  Object.freeze({
    anchorAt: "2026-08-13T10:30:00.000Z",
    intervalMs: 24 * 60 * 60 * 1_000,
    kind: "catalog-refresh",
    sourceId: KASSALAPP_SOURCE_ID,
    timeoutMs: 15 * 60 * 1_000,
  }),
  Object.freeze({
    anchorAt: "2026-08-14T00:40:00.000Z",
    intervalMs: 6 * 60 * 60 * 1_000,
    kind: "benchmark-price-refresh",
    sourceId: KASSALAPP_SOURCE_ID,
    timeoutMs: 5 * 60 * 1_000,
  }),
  Object.freeze({
    anchorAt: "2026-01-01T03:15:00.000Z",
    intervalMs: 24 * 60 * 60 * 1_000,
    kind: "physical-store-sync",
    sourceId: KASSALAPP_SOURCE_ID,
    timeoutMs: 5 * 60 * 1_000,
  }),
  Object.freeze({
    anchorAt: "2026-01-01T04:15:00.000Z",
    intervalMs: 24 * 60 * 60 * 1_000,
    kind: "historical-observation-collection",
    sourceId: KASSALAPP_SOURCE_ID,
    timeoutMs: 15 * 60 * 1_000,
  }),
]);


export const OPEN_PRICES_PRODUCTION_SCHEDULES: readonly WorkerScheduleDefinition[] = Object.freeze([
  Object.freeze({
    anchorAt: "2026-08-20T01:30:00.000Z",
    intervalMs: 6 * 60 * 60 * 1_000,
    kind: "open-prices-benchmark-refresh" as const,
    sourceId: "open-prices" as const,
    timeoutMs: 10 * 60 * 1_000,
  }),
]);

const OPEN_PRICES_PERMISSION_SCOPE_BY_JOB: Readonly<Record<OpenPricesWorkerJobKind, string>> = {
  "open-prices-benchmark-refresh": "ordinaryPrice",
};

export class StaticOpenPricesSourceAccessPolicy implements OpenPricesSourceAccessPolicy {
  constructor(private readonly state: OpenPricesSourceAccessState = "conditional") {
    if (!["approved", "blocked", "conditional", "revoked"].includes(state)) {
      throw new TypeError("Unsupported Open Prices source access state");
    }
    Object.freeze(this);
  }

  async getAccessState(
    _context: Readonly<{ jobKind: OpenPricesWorkerJobKind; sourceId: "open-prices" }>,
    signal: AbortSignal,
  ): Promise<OpenPricesSourceAccessState> {
    if (signal.aborted) throw Object.assign(new Error("Source access check cancelled"), {
      code: "CANCELLED",
    });
    return this.state;
  }
}

export class GovernedOpenPricesSourceAccessPolicy implements OpenPricesSourceAccessPolicy {
  constructor(
    private readonly deploymentState: OpenPricesSourceAccessState,
    private readonly reader: SourceAccessReader,
  ) {
    if (!["approved", "blocked", "conditional", "revoked"].includes(deploymentState)) {
      throw new TypeError("Unsupported Open Prices deployment access state");
    }
  }

  async getAccessState(
    context: Readonly<{ jobKind: OpenPricesWorkerJobKind; sourceId: "open-prices" }>,
    signal: AbortSignal,
  ): Promise<OpenPricesSourceAccessState> {
    if (this.deploymentState !== "approved") return this.deploymentState;
    const access = await this.reader.getSourceAccess(context.sourceId, signal);
    if (access === undefined) return "blocked";
    if (access.runtimeState !== "approved") return access.runtimeState;
    if (!access.sourcePermissionCurrent || !access.permissionCurrent) return "blocked";
    const decision = access.permissionDecision;
    if (decision !== "approved") return decision ?? "blocked";
    const scope = OPEN_PRICES_PERMISSION_SCOPE_BY_JOB[context.jobKind];
    return access.permissions[scope] === true ? "approved" : "blocked";
  }
}

export class PostgresOpenPricesTargetProvider implements OpenPricesTargetProvider {
  constructor(
    private readonly reader: WorkerGtinTargetReader,
    private readonly targetLimit: number,
  ) {
    requireTargetLimit(targetLimit);
  }

  async getBenchmarkPriceTargets(signal: AbortSignal): Promise<readonly { ean: string; geographicScopeId?: number }[]> {
    const geographicScopeId = await this.reader.getNationalPriceScopeId(signal);
    const chains = ["bunnpris", "extra", "rema-1000"] as const;
    const rawGtins = await this.reader.getGapPriceGtins(this.targetLimit, chains, signal);
    const unique = new Set<string>();
    for (const value of rawGtins) {
      if (isValidGtin(value)) unique.add(value);
    }
    return [...unique]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, this.targetLimit)
      .map((ean) => ({
        ean,
        ...(geographicScopeId === undefined ? {} : { geographicScopeId }),
      }));
  }
}

export class StaticKassalappSourceAccessPolicy implements KassalappSourceAccessPolicy {
  constructor(private readonly state: KassalappSourceAccessState = "conditional") {
    if (!["approved", "blocked", "conditional", "revoked"].includes(state)) {
      throw new TypeError("Unsupported Kassalapp source access state");
    }
    Object.freeze(this);
  }

  async getAccessState(
    _context: Readonly<{ jobKind: WorkerJobRequest["kind"]; sourceId: "kassalapp" }>,
    signal: AbortSignal,
  ): Promise<KassalappSourceAccessState> {
    if (signal.aborted) throw Object.assign(new Error("Source access check cancelled"), {
      code: "CANCELLED",
    });
    return this.state;
  }
}

export interface SourceAccessReader {
  getSourceAccess(sourceId: string, signal?: AbortSignal): Promise<SourceAccessSnapshot | undefined>;
}

const PERMISSION_SCOPE_BY_JOB: Readonly<Record<KassalappWorkerJobKind, string>> = {
  "benchmark-price-refresh": "ordinaryPrice",
  "catalog-refresh": "catalog",
  "historical-observation-collection": "priceHistory",
  "physical-store-sync": "physicalStore",
};

const JOB_KIND_BY_REQUEST_SCOPE: Readonly<
  Record<KassalappRequestScope, KassalappWorkerJobKind>
> = {
  catalog: "catalog-refresh",
  "ordinary-price": "benchmark-price-refresh",
  "physical-store": "physical-store-sync",
  "price-history": "historical-observation-collection",
};

export function createKassalappRequestAttemptAuthorizer(
  policy: KassalappSourceAccessPolicy,
): KassalappRequestAttemptAuthorizer {
  return async ({ scope }, signal) => {
    const access = await policy.getAccessState({
      jobKind: JOB_KIND_BY_REQUEST_SCOPE[scope],
      sourceId: KASSALAPP_SOURCE_ID,
    }, signal);
    if (access !== "approved") {
      throw new Error("Kassalapp request attempt is not authorized");
    }
  };
}

export class GovernedKassalappSourceAccessPolicy implements KassalappSourceAccessPolicy {
  constructor(
    private readonly deploymentState: KassalappSourceAccessState,
    private readonly reader: SourceAccessReader,
  ) {
    if (!["approved", "blocked", "conditional", "revoked"].includes(deploymentState)) {
      throw new TypeError("Unsupported Kassalapp deployment access state");
    }
  }

  async getAccessState(
    context: Readonly<{ jobKind: KassalappWorkerJobKind; sourceId: "kassalapp" }>,
    signal: AbortSignal,
  ): Promise<KassalappSourceAccessState> {
    if (this.deploymentState !== "approved") return this.deploymentState;
    const access = await this.reader.getSourceAccess(context.sourceId, signal);
    if (access === undefined) return "blocked";
    if (access.runtimeState !== "approved") return access.runtimeState;
    if (!access.sourcePermissionCurrent || !access.permissionCurrent) return "blocked";
    const decision = access.permissionDecision;
    if (decision !== "approved") return decision ?? "blocked";
    const scope = PERMISSION_SCOPE_BY_JOB[context.jobKind];
    return access.permissions[scope] === true ? "approved" : "blocked";
  }
}

function requireTargetLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TARGETS) {
    throw new TypeError(`targetLimit must be an integer from 1 through ${MAX_TARGETS}`);
  }
}

function canonicalTargets(values: readonly string[], limit: number): Array<{ ean: string }> {
  if (!Array.isArray(values)) throw new TypeError("Target reader must return an array");
  const unique = new Set<string>();
  for (const value of values) {
    if (!isValidGtin(value)) throw new TypeError("Target reader returned an invalid GTIN");
    unique.add(value);
  }
  return [...unique].sort((left, right) => left.localeCompare(right)).slice(0, limit)
    .map((ean) => ({ ean }));
}

export class PostgresKassalappTargetProvider implements KassalappTargetProvider {
  constructor(
    private readonly reader: WorkerGtinTargetReader,
    private readonly targetLimit: number,
  ) {
    requireTargetLimit(targetLimit);
  }

  async getCatalogTargets(signal: AbortSignal): Promise<readonly { ean: string }[]> {
    return canonicalTargets(await this.reader.getCatalogGtins(this.targetLimit, signal), this.targetLimit);
  }

  async getCatalogDiscoveryPage(signal: AbortSignal): Promise<number> {
    return await this.reader.getCatalogDiscoveryPage(signal);
  }

  async getBenchmarkPriceTargets(signal: AbortSignal): Promise<readonly { ean: string; geographicScopeId?: number }[]> {
    const geographicScopeId = await this.reader.getNationalPriceScopeId(signal);
    return canonicalTargets(
      await this.reader.getPriceGtins(this.targetLimit, "ordinary_only", signal),
      this.targetLimit,
    ).map(({ ean }) => ({ ean, ...(geographicScopeId === undefined ? {} : { geographicScopeId }) }));
  }

  async getHistoricalObservationTargets(signal: AbortSignal): Promise<readonly { ean: string; geographicScopeId?: number }[]> {
    const geographicScopeId = await this.reader.getNationalPriceScopeId(signal);
    return canonicalTargets(
      await this.reader.getPriceGtins(this.targetLimit, "historical_eligible", signal),
      this.targetLimit,
    ).map(({ ean }) => ({ ean, ...(geographicScopeId === undefined ? {} : { geographicScopeId }) }));
  }
}

interface WorkerLeaseAdapter {
  acquire(input: Readonly<{
    leaseKey: string;
    ownerId: string;
    signal?: AbortSignal;
    ttlMs: number;
  }>): Promise<WorkerLeaseHandle | undefined>;
}

export interface PostgresWorkerLeaseProviderOptions {
  ownerId: string;
  sourceId: string;
  ttlMs: number;
}

function requireIdentity(value: string, name: string, maximum: number): void {
  if (value.length < 1 || value.length > maximum || value.trim().length < 1) {
    throw new TypeError(`${name} must contain 1-${maximum} nonblank characters`);
  }
}

export class PostgresWorkerLeaseProvider implements WorkerLeaseProvider {
  private readonly options: Readonly<PostgresWorkerLeaseProviderOptions>;

  constructor(
    private readonly adapter: WorkerLeaseAdapter,
    options: PostgresWorkerLeaseProviderOptions,
  ) {
    requireIdentity(options.ownerId, "ownerId", 160);
    requireIdentity(options.sourceId, "sourceId", 64);
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 30_000 || options.ttlMs > 900_000) {
      throw new TypeError("ttlMs must be an integer from 30000 through 900000");
    }
    this.options = Object.freeze({ ...options });
  }

  async acquire(signal: AbortSignal): Promise<WorkerLeaseHandle | undefined> {
    return await this.adapter.acquire({
      leaseKey: ingestionWorkerLeaseKey({ sourceId: this.options.sourceId }),
      ownerId: this.options.ownerId,
      signal,
      ttlMs: this.options.ttlMs,
    });
  }
}

interface WorkerJobStateRepository {
  getLastScheduledAt(
    input: Readonly<{ jobKind: WorkerJobRequest["kind"]; sourceId: string }>,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  record(
    input: WorkerJobResultRecord,
    fenceToken: string,
    signal?: AbortSignal,
  ): Promise<{ created: boolean }>;
}

export class PostgresWorkerRuntimeStateStore implements WorkerRuntimeStateStore {
  constructor(
    private readonly repository: WorkerJobStateRepository | PostgresWorkerJobStateRepository,
  ) {}

  async getLastScheduledAt(
    schedule: WorkerScheduleDefinition,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    return await this.repository.getLastScheduledAt({
      jobKind: schedule.kind,
      sourceId: schedule.sourceId,
    }, signal);
  }

  async recordResult(
    request: WorkerJobRequest,
    result: WorkerRunResult,
    fence: Readonly<{ fenceToken: string; signal: AbortSignal }>,
  ): Promise<void> {
    if (
      result.jobId !== request.jobId
      || result.kind !== request.kind
      || result.sourceId !== request.sourceId
    ) {
      throw new TypeError("Worker result identity does not match its schedule request");
    }
    await this.repository.record({
      completedAt: new Date(result.completedAt),
      counts: { ...result.counters },
      jobId: result.jobId,
      jobKind: result.kind,
      runId: result.runId,
      scheduledAt: new Date(request.requestedAt),
      sourceId: result.sourceId,
      startedAt: new Date(result.startedAt),
      status: result.status,
    }, fence.fenceToken, fence.signal);
  }
}

export interface OpenPricesProductionRuntimeDependencies {
  client: { getPricesForGtins(gtins: readonly string[], signal: AbortSignal): Promise<readonly OpenPricesPrice[]> };
  ingestionRepository: PostgresIngestionRepository;
  sourceAccessPolicy: OpenPricesSourceAccessPolicy;
  targetProvider: OpenPricesTargetProvider;
}

export interface ProductionWorkerRuntimeDependencies<RunHandle = unknown> {
  clock: () => Date;
  gateway: KassalappIngestionGateway;
  ingestionRepository: KassalappIngestionRepository<RunHandle>;
  leaseProvider: WorkerLeaseProvider;
  openPrices?: OpenPricesProductionRuntimeDependencies;
  runtimeObserver?: WorkerRuntimeObserver;
  schedules?: readonly WorkerScheduleDefinition[];
  shutdownGraceMs: number;
  sourceAccessPolicy: KassalappSourceAccessPolicy;
  stateStore: WorkerRuntimeStateStore;
  targetProvider: KassalappTargetProvider;
}

function runIdFor(request: WorkerJobRequest): string {
  return `worker-v1:${createHash("sha256").update(request.jobId).digest("hex")}`;
}

export function createProductionWorkerRuntime<RunHandle = unknown>(
  dependencies: ProductionWorkerRuntimeDependencies<RunHandle>,
): WorkerRuntime {
  const kassalappHandlers = createKassalappHandlers({
    clock: dependencies.clock,
    gateway: dependencies.gateway,
    repository: dependencies.ingestionRepository,
    sourceAccessPolicy: dependencies.sourceAccessPolicy,
    targetProvider: dependencies.targetProvider,
  });

  const openPricesHandlers = dependencies.openPrices !== undefined
    ? createOpenPricesHandlers({
        clock: dependencies.clock,
        client: dependencies.openPrices.client,
        repository: dependencies.openPrices.ingestionRepository,
        sourceAccessPolicy: dependencies.openPrices.sourceAccessPolicy,
        targetProvider: dependencies.openPrices.targetProvider,
      })
    : {};

  const handlers = { ...kassalappHandlers, ...openPricesHandlers };

  const schedules = dependencies.openPrices !== undefined
    ? [
        ...(dependencies.schedules ?? KASSALAPP_PRODUCTION_SCHEDULES),
        ...OPEN_PRICES_PRODUCTION_SCHEDULES,
      ]
    : (dependencies.schedules ?? KASSALAPP_PRODUCTION_SCHEDULES);

  const runner = new WorkerRunner({
    createRunId: runIdFor,
    handlerShutdownGraceMs: dependencies.shutdownGraceMs,
    handlers,
    now: dependencies.clock,
  });
  return new WorkerRuntime({
    leaseProvider: dependencies.leaseProvider,
    now: dependencies.clock,
    observer: dependencies.runtimeObserver,
    runner,
    schedules,
    shutdownGraceMs: dependencies.shutdownGraceMs,
    stateStore: dependencies.stateStore,
  });
}
  ingestionRepository: PostgresIngestionRepository;
