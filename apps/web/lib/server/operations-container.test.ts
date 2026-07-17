import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { OperationsAlertRuntimeConfigV1 } from "@handleplan/domain";

import { createOperationsServerContainer } from "./operations-container";
import type { OperationsServerEnv } from "./operations-env";

const sourceRoster = {
  contentSha256: "a7cf992b898f3d9caaa51e6df55a09f0bb71158928d71dc13627ab7709b83717",
  entries: [{
    requiredEvidenceSignals: ["ordinary-price" as const],
    requiredWorkerJobKinds: ["catalog-refresh" as const],
    sourceId: "fixture-source",
  }],
  version: "fixture-roster:v1",
};

const disabledEnv: OperationsServerEnv = {
  alertRuntimeConfig: { contractVersion: 1, enabled: false },
  mode: "fake",
  sourceRoster,
};

const enabledConfig: Extract<OperationsAlertRuntimeConfigV1, { enabled: true }> = {
  capabilities: {
    appender: "security-definer-v1",
    checkpoint: "database-checkpoint-v1",
    exporter: "bounded-pull-v1",
    suppliedStatuses: "fixed-buckets-v1",
  },
  contractVersion: 1,
  delivery: "disabled",
  enabled: true,
  schedule: {
    anchorAt: "2026-07-17T00:00:00.000Z",
    contractVersion: 1,
    intervalMs: 300_000,
    timeoutMs: 30_000,
  },
};

describe("operations server container", () => {
  it("constructs dashboard and readiness dependencies only for disabled evaluation", async () => {
    const container = createOperationsServerContainer(disabledEnv);

    await expect(container.readinessProbe.check()).resolves.toMatchObject({
      databaseRole: "handleplan_operations",
      runtime: "operations",
    });
    await expect(container.operationsService.read()).resolves.toMatchObject({
      claimBoundary: { alertDelivery: "disabled" },
      sourceRoster,
    });
  });

  it("rejects a stale or cast enabled config before constructing a green readiness probe", () => {
    const bypassedParser = {
      ...disabledEnv,
      alertRuntimeConfig: enabledConfig,
    } as unknown as OperationsServerEnv;

    expect(() => createOperationsServerContainer(bypassedParser))
      .toThrow(/cannot be enabled until its production scheduler is composed/u);
  });
});
