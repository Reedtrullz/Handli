import "server-only";

import { createDatabase } from "@handleplan/db/client";
import {
  PostgresOperationsRuntimeReader,
  type OperationsRuntimeReader,
} from "@handleplan/db/operations-runtime";
import type { OperationsRuntimeSnapshotV1 } from "@handleplan/domain";

import { readOperationsServerEnv, type OperationsServerEnv } from "./operations-env";
import {
  OperationsRuntimeService,
  type OperationsRuntimeServiceContract,
} from "./operations-runtime-service";
import {
  BoundedPrivateRuntimeReadinessProbe,
  createOperationsPostgresReadinessCheck,
  PRIVATE_RUNTIME_DATABASE_ROLES,
  type PrivateRuntimeReadinessProbe,
} from "./private-runtime-readiness";
import { REQUIRED_DATABASE_MIGRATION } from "./readiness";

export interface OperationsServerContainer {
  operationsService: OperationsRuntimeServiceContract;
  readinessProbe: PrivateRuntimeReadinessProbe;
}

class EmptyOperationsRuntimeReader implements OperationsRuntimeReader {
  constructor(private readonly env: Extract<OperationsServerEnv, { mode: "fake" }>) {}

  async read(): Promise<OperationsRuntimeSnapshotV1> {
    const observedAt = new Date().toISOString();
    return {
      claimBoundary: {
        alertDelivery: "disabled",
        historicalReconstruction: "not-established",
        publicAvailability: "not-established",
        publicOfferEligibility: "not-established",
      },
      completeness: "bounded-aggregate",
      contractVersion: 1,
      kind: "internal-operations-snapshot",
      observedAt,
      sourceRoster: this.env.sourceRoster,
      sources: this.env.sourceRoster.entries.map(({ sourceId }) => ({
        administrativeRows: {
          activePublishedOffers: { capped: false, value: 0 },
          expiredPublishedOffers: { capped: false, value: 0 },
          expiringPublishedOffers: { capped: false, value: 0 },
          pendingReviewCandidates: { capped: false, value: 0 },
        },
        governanceState: "approval-incomplete",
        health: null,
        latestExtraction: null,
        latestWorkerResults: [],
        newestOrdinaryPriceAt: null,
        sourceId,
        workerResults24h: {
          nonSuccessful: { capped: false, value: 0 },
          total: { capped: false, value: 0 },
        },
      })),
    };
  }
}

let singleton: OperationsServerContainer | undefined;

export function createOperationsServerContainer(env: OperationsServerEnv): OperationsServerContainer {
  // Keep this runtime assertion even though OperationsServerEnv narrows the
  // type. It prevents a cast, stale caller, or deserialized test fixture from
  // constructing a green readiness probe for an accepted-but-inert scheduler.
  if (env.alertRuntimeConfig.enabled !== false) {
    throw new Error(
      "Operations alert evaluation cannot be enabled until its production scheduler is composed",
    );
  }
  if (env.mode === "fake") {
    return Object.freeze({
      operationsService: new OperationsRuntimeService(new EmptyOperationsRuntimeReader(env)),
      readinessProbe: new BoundedPrivateRuntimeReadinessProbe({
        checkDependency: async () => true,
        expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.operations,
        requiredMigration: REQUIRED_DATABASE_MIGRATION,
        runtime: "operations",
        timeoutMs: 1_500,
      }),
    });
  }
  const connection = createDatabase(env.OPERATIONS_DATABASE_URL);
  const operationsService = new OperationsRuntimeService(
    new PostgresOperationsRuntimeReader(connection.db, env.sourceRoster),
  );
  return Object.freeze({
    operationsService,
    readinessProbe: new BoundedPrivateRuntimeReadinessProbe({
      checkDependency: createOperationsPostgresReadinessCheck(
        connection.db,
        operationsService,
        env.sourceRoster.contentSha256,
      ),
      expectedDatabaseRole: PRIVATE_RUNTIME_DATABASE_ROLES.operations,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      runtime: "operations",
      timeoutMs: 1_500,
    }),
  });
}

export function getOperationsServerContainer(): OperationsServerContainer {
  singleton ??= createOperationsServerContainer(readOperationsServerEnv());
  return singleton;
}

export function resetOperationsServerContainerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Operations container reset is test-only");
  }
  singleton = undefined;
}
