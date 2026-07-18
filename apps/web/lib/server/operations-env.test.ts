import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readOperationsServerEnv } from "./operations-env";

const roster = JSON.stringify({
  contentSha256: "a7cf992b898f3d9caaa51e6df55a09f0bb71158928d71dc13627ab7709b83717",
  entries: [{
    requiredEvidenceSignals: ["ordinary-price"],
    requiredWorkerJobKinds: ["catalog-refresh"],
    sourceId: "fixture-source",
  }],
  version: "fixture-roster:v1",
});
const base = {
  NODE_ENV: "production",
  OPERATIONS_ALERT_EVALUATION_ENABLED: "false",
  OPERATIONS_DATABASE_URL:
    "postgresql://handleplan_operations:operations_url_safe_password_000000001@postgres:5432/handleplan",
  OPERATIONS_SOURCE_ROSTER_JSON: roster,
};

describe("operations server environment", () => {
  it("accepts only the dedicated database role and a digest-bound roster", () => {
    expect(readOperationsServerEnv(base)).toMatchObject({
      alertRuntimeConfig: { contractVersion: 1, enabled: false },
      mode: "real",
      sourceRoster: { version: "fixture-roster:v1" },
    });
  });

  it("fails closed on every activation request until production scheduling is composed", () => {
    for (const value of ["1", "enabled", "TRUE"]) {
      expect(() => readOperationsServerEnv({
        ...base,
        OPERATIONS_ALERT_EVALUATION_ENABLED: value,
      })).toThrow(/explicitly true or false/u);
    }
    expect(readOperationsServerEnv({
      ...base,
      OPERATIONS_ALERT_EVALUATION_ENABLED: undefined,
    })).toMatchObject({ alertRuntimeConfig: { enabled: false } });
    expect(() => readOperationsServerEnv({
      ...base,
      OPERATIONS_ALERT_EVALUATION_ENABLED: "true",
    })).toThrow(/cannot be enabled until its production scheduler is composed/u);
    expect(() => readOperationsServerEnv({
      ...base,
      OPERATIONS_ALERT_EVALUATION_ENABLED: "true",
      OPERATIONS_ALERT_RUNTIME_CONFIG_JSON: JSON.stringify({
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
      }),
    })).toThrow(/cannot be enabled until its production scheduler is composed/u);
    expect(() => readOperationsServerEnv({
      ...base,
      OPERATIONS_ALERT_RUNTIME_CONFIG_JSON: JSON.stringify({ contractVersion: 1, enabled: false }),
    })).toThrow(/cannot carry activation/u);
  });

  it("rejects public/review roles, malformed or forged rosters, and production fake mode", () => {
    expect(() => readOperationsServerEnv({
      ...base,
      OPERATIONS_DATABASE_URL:
        "postgresql://handleplan_web:operations_url_safe_password_000000001@postgres:5432/handleplan",
    })).toThrow(/handleplan_operations/u);
    expect(() => readOperationsServerEnv({
      ...base,
      OPERATIONS_SOURCE_ROSTER_JSON: "not-json",
    })).toThrow(/valid JSON/u);
    expect(() => readOperationsServerEnv({
      ...base,
      OPERATIONS_SOURCE_ROSTER_JSON: JSON.stringify({
        ...JSON.parse(roster),
        contentSha256: "0".repeat(64),
      }),
    })).toThrow(/digest/u);
    expect(() => readOperationsServerEnv({
      ...base,
      HANDLEPLAN_OPERATIONS_MODE: "fake",
    })).toThrow(/disabled in production/u);
  });
});
