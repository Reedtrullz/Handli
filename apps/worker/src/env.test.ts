import { describe, expect, it } from "vitest";

import { readWorkerProductionEnv, readWorkerRuntimeEnv } from "./env";

describe("readWorkerRuntimeEnv", () => {
  it("returns bounded deterministic supervision defaults", () => {
    expect(readWorkerRuntimeEnv({})).toEqual({
      cycleIntervalMs: 30_000,
      shutdownGraceMs: 30_000,
    });
  });

  it("accepts explicit integer millisecond bounds", () => {
    expect(readWorkerRuntimeEnv({
      WORKER_CYCLE_INTERVAL_MS: "1000",
      WORKER_SHUTDOWN_GRACE_MS: "120000",
    })).toEqual({
      cycleIntervalMs: 1_000,
      shutdownGraceMs: 120_000,
    });
  });

  it.each([
    ["WORKER_CYCLE_INTERVAL_MS", "999"],
    ["WORKER_CYCLE_INTERVAL_MS", "1.5"],
    ["WORKER_SHUTDOWN_GRACE_MS", "0"],
    ["WORKER_SHUTDOWN_GRACE_MS", "120001"],
  ])("rejects unsafe %s=%s", (name, value) => {
    expect(() => readWorkerRuntimeEnv({ [name]: value })).toThrow();
  });
});

describe("readWorkerProductionEnv", () => {
  const required = {
    DATABASE_URL: "postgresql://handleplan_app:placeholder@postgres:5432/handleplan",
    OFFICIAL_OFFER_FOUNDATION_ENABLED: "false",
    OFFICIAL_OFFER_PRIVATE_CAPTURE_ROOT: "/var/lib/handleplan/private-captures",
  };

  it("defaults the source to conditional and keeps optional credentials absent", () => {
    expect(readWorkerProductionEnv(required)).toEqual({
      databaseUrl: required.DATABASE_URL,
      kassalApiKey: undefined,
      kassalBaseUrl: "https://kassal.app/api/v1",
      leaseTtlMs: 120_000,
      officialOfferFoundationEnabled: false,
      officialOfferPrivateCaptureRoot: "/var/lib/handleplan/private-captures",
      requestBudgetLimit: 60,
      requestBudgetMaxWaitMs: 65_000,
      requestBudgetWindowMs: 60_000,
      sourceAccessState: "conditional",
      targetLimit: 500,
    });
  });

  it("requires an explicit credential only when access is approved", () => {
    expect(() => readWorkerProductionEnv({
      ...required,
      KASSAL_SOURCE_ACCESS: "approved",
    })).toThrow(/KASSAL_API_KEY/);
    expect(readWorkerProductionEnv({
      ...required,
      KASSAL_API_KEY: "server-only-placeholder",
      KASSAL_SOURCE_ACCESS: "approved",
    })).toMatchObject({
      kassalApiKey: "server-only-placeholder",
      sourceAccessState: "approved",
    });
  });

  it.each([
    ["DATABASE_URL", ""],
    ["DATABASE_URL", "https://example.com/not-postgres"],
    ["KASSAL_BASE_URL", "http://kassal.app/api/v1"],
    ["KASSAL_SOURCE_ACCESS", "enabled"],
    ["OFFICIAL_OFFER_FOUNDATION_ENABLED", "true"],
    ["OFFICIAL_OFFER_PRIVATE_CAPTURE_ROOT", "relative/captures"],
    ["WORKER_LEASE_TTL_MS", "29999"],
    ["WORKER_TARGET_LIMIT", "501"],
    ["WORKER_REQUEST_BUDGET_LIMIT", "0"],
  ])("rejects unsafe %s=%s", (name, value) => {
    expect(() => readWorkerProductionEnv({
      ...required,
      [name]: value,
    })).toThrow();
  });
});
