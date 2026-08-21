import {
  type OpenPricesPrice,
  type OpenPricesPriceIngestionOutcome,
  normalizeOpenPricesOutcome,
} from "@handleplan/open-prices";

import type {
  OpenPricesWorkerJobKind,
  WorkerRunCounters,
} from "./contracts";
import {
  WorkerCancelledError,
  type WorkerJobHandler,
} from "./runner";

const OPEN_PRICES_SOURCE_ID = "open-prices" as const;
const MAX_TARGETS = 500;
const MAX_INGESTION_BATCH_SIZE = 25;

export type OpenPricesSourceAccessState =
  | "approved"
  | "blocked"
  | "conditional"
  | "revoked";

export interface OpenPricesSourceAccessPolicy {
  getAccessState(
    context: Readonly<{
      jobKind: OpenPricesWorkerJobKind;
      sourceId: typeof OPEN_PRICES_SOURCE_ID;
    }>,
    signal: AbortSignal,
  ): Promise<OpenPricesSourceAccessState>;
}

export interface OpenPricesTargetProvider {
  getBenchmarkPriceTargets(
    signal: AbortSignal,
  ): Promise<readonly { ean: string; geographicScopeId?: number }[]>;
}

export interface OpenPricesHandlerDependencies {
  readonly clock: () => Date;
  readonly client: {
    getPricesForGtins(
      gtins: readonly string[],
      signal: AbortSignal,
    ): Promise<readonly OpenPricesPrice[]>;
  };
  readonly repository: {
    beginRun(
      input: {
        fenceToken: string;
        jobId: string;
        runType: string;
        sourceId: "open-prices";
        startedAt: Date;
      },
      signal?: AbortSignal,
    ): Promise<{ handle: unknown }>;
    persistPriceOutcomes(
      handle: unknown,
      outcomes: readonly OpenPricesPriceIngestionOutcome[],
      signal: AbortSignal,
    ): Promise<unknown>;
    finalizeRun(
      handle: unknown,
      input: {
        completedAt: Date;
        failed: number;
        status: "cancelled" | "completed" | "degraded";
        errorClass?: string;
      },
      signal?: AbortSignal,
    ): Promise<{ counts: WorkerRunCounters }>;
  };
  readonly sourceAccessPolicy: OpenPricesSourceAccessPolicy;
  readonly targetProvider: OpenPricesTargetProvider;
}

class OpenPricesHandlerError extends Error {
  constructor(readonly code: "FINALIZATION_FAILURE") {
    super("Open Prices ingestion finalization failed");
    this.name = "OpenPricesHandlerError";
  }
}

class SourceAccessChangedError extends Error {
  constructor() {
    super("Open Prices source access changed");
    this.name = "SourceAccessChangedError";
  }
}

function checkedNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Invalid Open Prices handler clock");
  }
  return new Date(value);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkerCancelledError();
}

function requireAccessApproved(
  policy: OpenPricesSourceAccessPolicy,
  jobKind: OpenPricesWorkerJobKind,
  signal: AbortSignal,
): Promise<OpenPricesSourceAccessState> {
  return policy.getAccessState(
    { jobKind, sourceId: OPEN_PRICES_SOURCE_ID },
    signal,
  );
}

function batchOutcomes<T>(
  outcomes: readonly T[],
  batchSize: number,
): readonly (readonly T[])[] {
  const batches: (readonly T[])[] = [];
  for (let i = 0; i < outcomes.length; i += batchSize) {
    batches.push(outcomes.slice(i, i + batchSize));
  }
  return batches;
}

export function createOpenPricesHandlers(
  dependencies: OpenPricesHandlerDependencies,
): Partial<Record<OpenPricesWorkerJobKind, WorkerJobHandler>> {
  const benchmarkRefresh = async (context: {
    fenceToken: string;
    jobId: string;
    signal: AbortSignal;
  }): Promise<{ counters: Partial<WorkerRunCounters> }> => {
    const { fenceToken, jobId, signal } = context;
    const clock = dependencies.clock;

    const accessState = await requireAccessApproved(
      dependencies.sourceAccessPolicy,
      "open-prices-benchmark-refresh",
      signal,
    );
    if (accessState !== "approved") {
      throw new SourceAccessChangedError();
    }

    const targets = await dependencies.targetProvider.getBenchmarkPriceTargets(signal);
    if (targets.length === 0) {
      return { counters: { fetched: 0, accepted: 0, quarantined: 0, unknown: 0, persisted: 0, failed: 0 } };
    }

    const startedAt = checkedNow(clock);
    const { handle } = await dependencies.repository.beginRun(
      {
        fenceToken,
        jobId,
        runType: "benchmark-prices",
        sourceId: OPEN_PRICES_SOURCE_ID,
        startedAt,
      },
      signal,
    );

    let failed = 0;
    let accepted = 0;
    let quarantined = 0;
    let unknown = 0;
    let persisted = 0;

    try {
      console.error("[open-prices] targets:", targets.length, "gtins:", targets.slice(0,5).map(t => t.ean).join(","));
      const gtins = targets.map(({ ean }: { ean: string }) => ean);
      throwIfCancelled(signal);

      const accessBeforeFetch = await requireAccessApproved(
        dependencies.sourceAccessPolicy,
        "open-prices-benchmark-refresh",
        signal,
      );
      if (accessBeforeFetch !== "approved") {
        throw new SourceAccessChangedError();
      }

      console.error("[open-prices] calling API with", gtins.length, "gtins");
      const prices = await dependencies.client.getPricesForGtins(gtins, signal);
      console.error("[open-prices] API returned", prices.length, "prices");
      throwIfCancelled(signal);

      const geographicScopeId = targets[0]?.geographicScopeId;
      const fetchedAt = checkedNow(clock);
      const outcomes: OpenPricesPriceIngestionOutcome[] = prices.map(
        (price: OpenPricesPrice) => normalizeOpenPricesOutcome(price, fetchedAt, geographicScopeId),
      );

      for (const outcome of outcomes) {
        if (outcome.outcomeState === "accepted") accepted++;
        else if (outcome.outcomeState === "quarantined") quarantined++;
        else unknown++;
      }

      const batches = batchOutcomes(outcomes, MAX_INGESTION_BATCH_SIZE);
      for (const batch of batches) {
        throwIfCancelled(signal);
        console.error("[open-prices] persisting batch of", batch.length);
        await dependencies.repository.persistPriceOutcomes(handle, batch, signal);
        persisted += batch.length;
      }

      const completedAt = checkedNow(clock);
      throwIfCancelled(signal);

      const status = failed > 0 ? "degraded" as const : "completed" as const;
      const finalization = await dependencies.repository.finalizeRun(
        handle,
        { completedAt, failed, status },
        signal,
      );

      return { counters: { ...finalization.counts, failed } };
    } catch (error) {
      console.error("[open-prices] handler error:", error instanceof Error ? error.message : String(error));
      const isCancelled =
        signal.aborted || error instanceof WorkerCancelledError;
      const isAccessChanged = error instanceof SourceAccessChangedError;

      let finalizationStatus: "cancelled" | "completed" | "degraded";
      let errorClass: string | undefined;

      if (isCancelled) {
        finalizationStatus = "cancelled";
        errorClass = "CANCELLED";
      } else if (isAccessChanged) {
        finalizationStatus = "degraded";
        errorClass = "SOURCE_ACCESS_CHANGED";
        failed = 1;
      } else {
        finalizationStatus = "degraded";
        failed = 1;
      }

      try {
        const completedAt = checkedNow(clock);
        const finalization = await dependencies.repository.finalizeRun(
          handle,
          {
            completedAt,
            failed,
            status: finalizationStatus,
            ...(errorClass === undefined ? {} : { errorClass }),
          },
          signal,
        );
        return {
          counters: {
            ...finalization.counts,
            failed: finalizationStatus === "cancelled" ? 0 : failed,
          },
        };
      } catch {
        throw new OpenPricesHandlerError("FINALIZATION_FAILURE");
      }
    }
  };

  return {
    "open-prices-benchmark-refresh": async (context) => {
      const result = await benchmarkRefresh({
        fenceToken: context.fenceToken,
        jobId: context.jobId,
        signal: context.signal,
      });
      return { counters: result.counters };
    },
  };
}
