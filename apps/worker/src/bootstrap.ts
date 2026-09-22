import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { createDatabase } from "@handleplan/db/client";
import { PostgresOfficialOfferLifecycleRepository } from "@handleplan/db/official-offer-lifecycle";
import { PostgresIngestionRepository } from "@handleplan/db/ingestion";
import { PostgresProviderRequestBudget } from "@handleplan/db/request-budget";
import { PostgresSourceAccessReader } from "@handleplan/db/source-access";
import { PostgresWorkerLeaseAdapter } from "@handleplan/db/worker-lease";
import { PostgresWorkerJobStateRepository } from "@handleplan/db/worker-state";
import { PostgresWorkerGtinTargetReader } from "@handleplan/db/worker-targets";
import { KassalappClient } from "@handleplan/kassalapp";
import { OpenPricesClient } from "@handleplan/open-prices";

import { readWorkerProductionEnv, readWorkerRuntimeEnv } from "./env";
import { startWorkerHealthServer, WorkerHealthMonitor } from "./health";
import {
  KASSALAPP_PRODUCTION_SCHEDULES,
  OPEN_PRICES_PRODUCTION_SCHEDULES,
  TJEK_PRODUCTION_SCHEDULES,
  PostgresKassalappTargetProvider,
  PostgresOpenPricesTargetProvider,
  PostgresWorkerLeaseProvider,
  PostgresWorkerRuntimeStateStore,
  GovernedKassalappSourceAccessPolicy,
  GovernedOpenPricesSourceAccessPolicy,
  createKassalappRequestAttemptAuthorizer,
  createProductionWorkerRuntime,
} from "./production";
import { superviseWorker } from "./supervisor";
import { startOfficialOfferLifecycleLoop } from "./official-offer-lifecycle";
import { createTjekFoundationDependencies } from "./tjek-production";
import { createMenyFoundationDependencies } from "./meny-production";

export function workerOwnerId(host = hostname(), processId = process.pid): string {
  const digest = createHash("sha256")
    .update(`${host}\u0000${processId}`)
    .digest("hex");
  return `handleplan-worker-v1:${digest}`;
}

export function productionCycleBoundMs(shutdownGraceMs: number): number {
  return [
    ...KASSALAPP_PRODUCTION_SCHEDULES,
    ...OPEN_PRICES_PRODUCTION_SCHEDULES,
    ...TJEK_PRODUCTION_SCHEDULES,
  ].reduce(
    (total, schedule) => total + schedule.timeoutMs + shutdownGraceMs,
    0,
  );
}

export async function runProductionWorkerProcess(
  values: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<0 | 1> {
  const runtimeEnv = readWorkerRuntimeEnv(values);
  const productionEnv = readWorkerProductionEnv(values);
  const connection = createDatabase(productionEnv.databaseUrl);
  try {
    const leaseAdapter = new PostgresWorkerLeaseAdapter(connection.db);
    const requestBudget = new PostgresProviderRequestBudget(connection.db, {
      limit: productionEnv.requestBudgetLimit,
      maxWaitMs: productionEnv.requestBudgetMaxWaitMs,
      providerKey: "kassalapp",
      windowMs: productionEnv.requestBudgetWindowMs,
    });
    const sourceAccessPolicy = new GovernedKassalappSourceAccessPolicy(
      productionEnv.sourceAccessState,
      new PostgresSourceAccessReader(connection.db),
    );
    const gateway = new KassalappClient({
      apiKey: productionEnv.kassalApiKey ?? "source-access-not-approved",
      authorizeRequestAttempt: createKassalappRequestAttemptAuthorizer(sourceAccessPolicy),
      baseUrl: productionEnv.kassalBaseUrl,
      fetch,
      requestCoordinator: requestBudget,
    });
    const ingestionRepository = new PostgresIngestionRepository(connection.db, {
      verifyFence: leaseAdapter.verifyFence,
    });
    const stateRepository = new PostgresWorkerJobStateRepository(connection.db, {
      verifyFence: leaseAdapter.verifyFence,
    });
    const health = new WorkerHealthMonitor({
      cycleIntervalMs: runtimeEnv.cycleIntervalMs,
      maxCycleDurationMs: productionCycleBoundMs(runtimeEnv.shutdownGraceMs) + 30_000,
      revision: values.APP_COMMIT_SHA ?? "",
    });
    const openPricesSourceAccessPolicy = productionEnv.openPricesEnabled
      ? new GovernedOpenPricesSourceAccessPolicy(
          productionEnv.sourceAccessState,
          new PostgresSourceAccessReader(connection.db),
        )
      : undefined;

    const openPricesDependencies = productionEnv.openPricesEnabled
      ? {
          client: new OpenPricesClient(),
          ingestionRepository,
          sourceAccessPolicy: openPricesSourceAccessPolicy!,
          targetProvider: new PostgresOpenPricesTargetProvider(
            new PostgresWorkerGtinTargetReader(connection.db),
            productionEnv.targetLimit,
          ),
        }
      : undefined;

    const tjekDependencies = productionEnv.tjekEnabled
      ? { apiKey: productionEnv.tjekApiKey, foundation: createTjekFoundationDependencies(connection.db, productionEnv.officialOfferPrivateCaptureRoot) }
      : undefined;

    const menyDependencies = productionEnv.menyEnabled
      ? { foundation: createMenyFoundationDependencies(connection.db, productionEnv.officialOfferPrivateCaptureRoot) }
      : undefined;

    const runtime = createProductionWorkerRuntime({
      clock: () => new Date(),
      gateway,
      ingestionRepository,
      leaseProvider: new PostgresWorkerLeaseProvider(leaseAdapter, {
        ownerId: workerOwnerId(),
        sourceId: "kassalapp",
        ttlMs: productionEnv.leaseTtlMs,
      }),
      meny: menyDependencies,
      openPrices: openPricesDependencies,
      tjek: tjekDependencies,
      runtimeObserver: health,
      shutdownGraceMs: runtimeEnv.shutdownGraceMs,
      sourceAccessPolicy,
      stateStore: new PostgresWorkerRuntimeStateStore(stateRepository),
      targetProvider: new PostgresKassalappTargetProvider(
        new PostgresWorkerGtinTargetReader(connection.db),
        productionEnv.targetLimit,
      ),
    });
    // Dedicated lifecycle execution: a long ingestion cycle must not delay
    // expiry past the documented 15-minute slot.
    const lifecycleAbort = new AbortController();
    signal.addEventListener("abort", () => lifecycleAbort.abort(), { once: true });
    const lifecycleLoops = [
      ...(productionEnv.tjekEnabled ? [startOfficialOfferLifecycleLoop({
        ownerId: workerOwnerId(),
        repository: new PostgresOfficialOfferLifecycleRepository(connection.db),
        signal: lifecycleAbort.signal,
        sourceId: "tjek",
      })] : []),
      ...(productionEnv.menyEnabled ? [startOfficialOfferLifecycleLoop({
        ownerId: workerOwnerId(),
        repository: new PostgresOfficialOfferLifecycleRepository(connection.db),
        signal: lifecycleAbort.signal,
        sourceId: "meny",
      })] : []),
    ];
    const healthServer = await startWorkerHealthServer(health);
    try {
      return await superviseWorker({
        get exitCode() { return runtime.exitCode; },
        requestShutdown: () => runtime.requestShutdown(),
        runCycle: () => runtime.runCycle(),
      }, {
        cycleIntervalMs: runtimeEnv.cycleIntervalMs,
        observer: health,
        signal,
      });
    } finally {
      lifecycleAbort.abort();
      await Promise.allSettled(lifecycleLoops.map((loop) => loop.stopped));
      health.schedulerStopping();
      await healthServer.close();
    }
  } finally {
    await connection.close();
  }
}
