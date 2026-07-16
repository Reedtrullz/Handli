import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readServerEnv } from "./env";

describe("readServerEnv", () => {
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
    })).toEqual({ mode: "fake" });
  });

  it("rejects fake mode in production even when an override-like value is supplied", () => {
    expect(() => readServerEnv({
      ALLOW_FAKE_IN_PRODUCTION: "true",
      HANDLEPLAN_MODE: "fake",
      NODE_ENV: "production",
    })).toThrow(/production/i);
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
