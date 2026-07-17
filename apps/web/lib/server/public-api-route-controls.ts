import "server-only";

import type { PublicApiRouteKey } from "@handleplan/db/public-api-request-budget";

import type { BoundedRequestOptions } from "./request-lifetime";
import {
  PublicApiRuntimeControlError,
  type PublicApiRuntimeControlsContract,
} from "./public-api-runtime-controls";

export interface ControlledPublicApiRouteOptions extends BoundedRequestOptions {
  runtimeControls?: PublicApiRuntimeControlsContract;
}

export async function runControlledPublicApiOperation<T>(
  options: ControlledPublicApiRouteOptions,
  routeKey: PublicApiRouteKey,
  keyMaterial: unknown,
  signal: AbortSignal,
  operation: (operationSignal: AbortSignal) => T | PromiseLike<T>,
): Promise<T> {
  if (options.runtimeControls === undefined) return operation(signal);
  return options.runtimeControls.run(
    routeKey,
    keyMaterial,
    signal,
    operation,
  );
}

export async function admitControlledPublicApiOperation(
  options: ControlledPublicApiRouteOptions,
  routeKey: PublicApiRouteKey,
  signal: AbortSignal,
): Promise<void> {
  await options.runtimeControls?.admit(routeKey, signal);
}

export function publicApiRuntimeControlResponse(error: unknown): Response | undefined {
  if (!(error instanceof PublicApiRuntimeControlError)) return undefined;
  const headers: Record<string, string> = { "cache-control": "private, no-store" };
  let code: string;
  let status: number;
  switch (error.code) {
    case "RATE_LIMITED": {
      if (
        !Number.isSafeInteger(error.retryAfterSeconds)
        || error.retryAfterSeconds === undefined
        || error.retryAfterSeconds < 1
        || error.retryAfterSeconds > 60
      ) {
        code = "REQUEST_BUDGET_UNAVAILABLE";
        status = 503;
        break;
      }
      code = "RATE_LIMITED";
      status = 429;
      headers["retry-after"] = String(error.retryAfterSeconds);
      break;
    }
    case "BUDGET_UNAVAILABLE":
      code = "REQUEST_BUDGET_UNAVAILABLE";
      status = 503;
      break;
    case "BUSY":
      code = "SERVER_BUSY";
      status = 503;
      break;
    case "CANCELLED":
      code = "REQUEST_CANCELLED";
      status = 499;
      break;
  }
  return Response.json({ code }, { headers, status });
}
