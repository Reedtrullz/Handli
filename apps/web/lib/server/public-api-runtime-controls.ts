import "server-only";

import {
  PublicApiRequestBudgetError,
  type PublicApiRequestBudgetContract,
  type PublicApiRouteKey,
} from "@handleplan/db/public-api-request-budget";

import {
  InFlightCoalescingError,
  type InFlightOperationCoalescer,
} from "./in-flight-operation-coalescer";

export type PublicApiRuntimeControlErrorCode =
  | "BUDGET_UNAVAILABLE"
  | "BUSY"
  | "CANCELLED"
  | "RATE_LIMITED";

export class PublicApiRuntimeControlError extends Error {
  constructor(
    readonly code: PublicApiRuntimeControlErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Public API runtime control failed: ${code}`);
    this.name = "PublicApiRuntimeControlError";
  }
}

export interface PublicApiRuntimeControlsContract {
  admit(routeKey: PublicApiRouteKey, signal?: AbortSignal): Promise<void>;
  run<T>(
    routeKey: PublicApiRouteKey,
    keyMaterial: unknown,
    signal: AbortSignal | undefined,
    operation: (sharedSignal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T>;
}

export class PublicApiRuntimeControls implements PublicApiRuntimeControlsContract {
  constructor(
    private readonly budget: PublicApiRequestBudgetContract,
    private readonly coalescer: InFlightOperationCoalescer,
  ) {}

  async admit(routeKey: PublicApiRouteKey, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new PublicApiRuntimeControlError("CANCELLED");
    try {
      const decision = await this.budget.claim(routeKey, signal);
      if (!decision.admitted) {
        throw new PublicApiRuntimeControlError(
          "RATE_LIMITED",
          decision.retryAfterSeconds,
        );
      }
    } catch (error) {
      if (error instanceof PublicApiRuntimeControlError) throw error;
      if (signal?.aborted) throw new PublicApiRuntimeControlError("CANCELLED");
      if (
        error instanceof PublicApiRequestBudgetError
        && error.code === "CANCELLED"
      ) {
        throw new PublicApiRuntimeControlError("CANCELLED");
      }
      throw new PublicApiRuntimeControlError("BUDGET_UNAVAILABLE");
    }
  }

  async run<T>(
    routeKey: PublicApiRouteKey,
    keyMaterial: unknown,
    signal: AbortSignal | undefined,
    operation: (sharedSignal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T> {
    await this.admit(routeKey, signal);
    try {
      return await this.coalescer.run(routeKey, keyMaterial, signal, operation);
    } catch (error) {
      if (!(error instanceof InFlightCoalescingError)) throw error;
      if (error.code === "CANCELLED") {
        throw new PublicApiRuntimeControlError("CANCELLED");
      }
      throw new PublicApiRuntimeControlError("BUSY");
    }
  }
}
