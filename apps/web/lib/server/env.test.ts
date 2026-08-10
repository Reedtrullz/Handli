import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readServerEnv } from "./env";

const browserEvidenceRuntimeProofKey = Symbol.for(
  "handleplan.e2e.loopback-production-browser-fake-runtime.v1",
);

describe("readServerEnv", () => {
  const browserEvidenceSentinel = `handleplan-e2e-${"a".repeat(48)}`;
  const loopbackProductionBrowserEnv = {
    HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN: browserEvidenceSentinel,
    HANDLEPLAN_E2E_PUBLIC_ORIGIN: "https://127.0.0.1:3109",
    HANDLEPLAN_E2E_SENTINEL: browserEvidenceSentinel,
    HANDLEPLAN_MODE: "fake",
    HOSTNAME: "127.0.0.1",
    KASSAL_API_KEY: browserEvidenceSentinel,
    NODE_ENV: "production",
    PORT: "3108",
  } as const;

  beforeEach(() => {
    Reflect.set(globalThis, browserEvidenceRuntimeProofKey, browserEvidenceSentinel);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, browserEvidenceRuntimeProofKey);
  });

  it("requires only the read-only PostgreSQL URL in real mode", () => {
    expect(() => readServerEnv({})).toThrow(/DATABASE_URL/);
    expect(readServerEnv({
      DATABASE_URL: "postgresql://handleplan_web:password@localhost/handleplan",
    })).toEqual({
      mode: "real",
      DATABASE_URL: "postgresql://handleplan_web:password@localhost/handleplan",
    });
  });

  it("does not read worker-only Kassalapp credentials into public web configuration", () => {
    expect(readServerEnv({
      DATABASE_URL: "postgresql://handleplan_web:password@localhost/handleplan",
      KASSAL_API_KEY: "worker-only-secret",
      KASSAL_BASE_URL: "https://provider.invalid/api",
      PRICE_EVIDENCE_READ_MODEL: "legacy",
    })).toEqual({
      mode: "real",
      DATABASE_URL: "postgresql://handleplan_web:password@localhost/handleplan",
    });
  });

  it("allows an explicit local fake mode without production credentials", () => {
    expect(readServerEnv({
      HANDLEPLAN_MODE: "fake",
      KASSAL_API_KEY: "must-not-be-read",
      NODE_ENV: "development",
    })).toEqual({ mode: "fake" });
  });

  it("rejects fake data outside explicit development or test runtimes", () => {
    expect(() => readServerEnv({ HANDLEPLAN_MODE: "fake" })).toThrow(/development and test/i);
  });

  it("rejects fake mode in production even when an override-like value is supplied", () => {
    expect(() => readServerEnv({
      ALLOW_FAKE_IN_PRODUCTION: "true",
      HANDLEPLAN_MODE: "fake",
      NODE_ENV: "production",
    })).toThrow(/production/i);
  });

  it("allows fake data only for the exact loopback production browser harness proof", () => {
    expect(readServerEnv(loopbackProductionBrowserEnv)).toEqual({ mode: "fake" });
  });

  it.each([
    ["mismatched token", { HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN: `handleplan-e2e-${"b".repeat(48)}` }],
    ["mismatched credential canary", { KASSAL_API_KEY: `handleplan-e2e-${"b".repeat(48)}` }],
    ["short sentinel", { HANDLEPLAN_E2E_SENTINEL: "handleplan-e2e-short" }],
    ["foreign hostname", { HOSTNAME: "0.0.0.0" }],
    ["foreign public origin", { HANDLEPLAN_E2E_PUBLIC_ORIGIN: "https://example.test" }],
    ["wrong upstream port", { PORT: "3000" }],
  ])("rejects an incomplete loopback production browser proof: %s", (_label, override) => {
    expect(() => readServerEnv({
      ...loopbackProductionBrowserEnv,
      ...override,
    })).toThrow(/production/i);
  });

  it("rejects the environment tuple without the wrapper-only runtime capability", () => {
    Reflect.deleteProperty(globalThis, browserEvidenceRuntimeProofKey);
    expect(() => readServerEnv(loopbackProductionBrowserEnv)).toThrow(/production/i);
  });

  it("rejects unsupported public-web modes", () => {
    expect(() => readServerEnv({ HANDLEPLAN_MODE: "preview" })).toThrow(/HANDLEPLAN_MODE/);
  });

  it.each([
    "https://db.example/handleplan",
    "mysql://db.example/handleplan",
    "ftp://db.example/handleplan",
  ])("rejects the non-PostgreSQL database URL %s", (DATABASE_URL) => {
    expect(() => readServerEnv({ DATABASE_URL })).toThrow(/DATABASE_URL/);
  });

  it("accepts both PostgreSQL URL spellings", () => {
    for (const DATABASE_URL of [
      "postgres://handleplan_web:password@localhost/handleplan",
      "postgresql://handleplan_web:password@localhost/handleplan",
    ]) {
      expect(readServerEnv({ DATABASE_URL })).toEqual({ mode: "real", DATABASE_URL });
    }
  });
});
