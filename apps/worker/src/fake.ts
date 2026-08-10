import type { WorkerRunCounters } from "./contracts";
import {
  WorkerCancelledError,
  type WorkerHandlerResult,
  type WorkerJobHandler,
} from "./runner";

export type { WorkerJobHandler } from "./runner";

export function deterministicFakeExecution(
  counters: Partial<WorkerRunCounters>,
  status: WorkerHandlerResult["status"] = "succeeded",
): WorkerJobHandler {
  const snapshot = Object.freeze({ ...counters });
  return async ({ signal }) => {
    if (signal.aborted) throw new WorkerCancelledError();
    return { counters: { ...snapshot }, status };
  };
}
