import "server-only";

import {
  OperationsRuntimeReaderError,
  type OperationsRuntimeReader,
} from "@handleplan/db/operations-runtime";
import type { OperationsRuntimeSnapshotV1 } from "@handleplan/domain";

export class OperationsRuntimeServiceError extends Error {
  constructor(readonly code: "CANCELLED" | "UNAVAILABLE") {
    super(`Operations runtime service failed: ${code}`);
    this.name = "OperationsRuntimeServiceError";
  }
}
export interface OperationsRuntimeServiceContract {
  read(signal?: AbortSignal): Promise<OperationsRuntimeSnapshotV1>;
}

export class OperationsRuntimeService implements OperationsRuntimeServiceContract {
  constructor(private readonly reader: OperationsRuntimeReader) {}

  async read(signal?: AbortSignal): Promise<OperationsRuntimeSnapshotV1> {
    if (signal?.aborted) throw new OperationsRuntimeServiceError("CANCELLED");
    try {
      return await this.reader.read(signal);
    } catch (error) {
      if (
        signal?.aborted
        || (error instanceof OperationsRuntimeReaderError && error.code === "CANCELLED")
      ) throw new OperationsRuntimeServiceError("CANCELLED");
      throw new OperationsRuntimeServiceError("UNAVAILABLE");
    }
  }
}
