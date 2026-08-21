import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { createDatabase } from "@handleplan/db/client";
import { PostgresIngestionRepository } from "@handleplan/db/ingestion";
import { PostgresProviderRequestBudget } from "@handleplan/db/request-budget";
import { PostgresSourceAccessReader } from "@handleplan/db/source-access";
import { PostgresWorkerLeaseAdapter } from "@handleplan/db/worker-lease";
import { PostgresWorkerJobStateRepository } from "@handleplan/db/worker-state";
import { PostgresWorkerGtinTargetReader } from "@handleplan/db/worker-targets";
import { KassalappClient } from "@handleplan/kassalapp";
import { OpenPricesClient } from "@handleplan/open-prices";
import { TjekClient } from "@handleplan/tjek";

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
import { disabledOfficialOfferProductionComposition } from "./official-offer-operational";
import { superviseWorker } from "./supervisor";

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
  const officialOfferComposition = disabledOfficialOfferProductionComposition();
  if (
    productionEnv.officialOfferFoundationEnabled
    || officialOfferComposition.activationEnabled
  ) {
    throw new Error("Official-offer production activation is not approved");
  }
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
      maxCycleDurationMs: productionCycleBoundMs(runtimeEnv.shutdownGraceMs),
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
      ? { db: connection.db }
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
    const healthServer = await startWorkerHealthServer(health);
    try {
      return await superviseWorker(runtime, {
        cycleIntervalMs: runtimeEnv.cycleIntervalMs,
        observer: health,
        signal,
      });
    } finally {
      health.schedulerStopping();
      await healthServer.close();
    }
  } finally {
    await connection.close();
  }
}
