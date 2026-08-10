import "server-only";

import {
  evaluateOperationalAlertsV1,
  suppliedOperationalStatusesV1Schema,
  type OperationalAlertCheckpointV1,
  type OperationalAlertEvaluationV1,
  type OperationsEvidenceSnapshotV1,
  type SuppliedOperationalStatusesV1,
} from "@handleplan/domain";
import type {
  OperationalAlertAppender,
  OperationsSnapshotReader,
} from "@handleplan/db/operations-dashboard";

const INTERNAL_SOURCE_LIMIT = 100;

export class OperationsServiceError extends Error {
  constructor(readonly code: "INCOMPLETE_SNAPSHOT" | "INVALID_CLOCK") {
    super(`Internal operations service failed: ${code}`);
    this.name = "OperationsServiceError";
  }
}

export interface OperationsEvaluationResult {
  appended: number;
  checkpoint: OperationalAlertCheckpointV1;
  evaluation: OperationalAlertEvaluationV1;
  evidence: OperationsEvidenceSnapshotV1;
}

/**
 * Internal orchestration only. This class is deliberately not connected to a
 * route: the private authentication boundary and least-privilege database role
 * must be proved before the dashboard can be enabled.
 */
export class OperationsService {
  constructor(
    private readonly reader: OperationsSnapshotReader,
    private readonly appender: OperationalAlertAppender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async evaluateAndAppend(
    suppliedInput: SuppliedOperationalStatusesV1,
    signal?: AbortSignal,
  ): Promise<OperationsEvaluationResult> {
    const supplied = suppliedOperationalStatusesV1Schema.parse(suppliedInput);
    const at = this.now();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
      throw new OperationsServiceError("INVALID_CLOCK");
    }
    const evidence = await this.reader.read(new Date(at), INTERNAL_SOURCE_LIMIT, signal);
    if (evidence.hasMoreSources) {
      throw new OperationsServiceError("INCOMPLETE_SNAPSHOT");
    }
    const evaluation = evaluateOperationalAlertsV1(evidence, supplied);
    const result = await this.appender.append(evaluation, signal);
    return {
      appended: result.appended,
      checkpoint: result.checkpoint,
      evaluation,
      evidence,
    };
  }
}
