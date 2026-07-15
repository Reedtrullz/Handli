import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readServerEnv } from "./env";

describe("readServerEnv", () => {
  it("rejects a missing Kassalapp credential", () => {
    expect(() => readServerEnv({})).toThrow(/KASSAL_API_KEY/);
  });

  it("rejects missing database and upstream configuration", () => {
    expect(() => readServerEnv({ KASSAL_API_KEY: "test-key" })).toThrow(/DATABASE_URL/);
    expect(() =>
      readServerEnv({
        KASSAL_API_KEY: "test-key",
        DATABASE_URL: "postgresql://localhost/handleplan",
      }),
    ).toThrow(/KASSAL_BASE_URL/);
  });

  it("returns only validated server configuration", () => {
    expect(
      readServerEnv({
        KASSAL_API_KEY: "test-key",
        DATABASE_URL: "postgresql://localhost/handleplan",
        KASSAL_BASE_URL: "https://kassal.app/api/v1",
        NEXT_PUBLIC_UNRELATED: "visible",
      }),
    ).toEqual({
      mode: "real",
      KASSAL_API_KEY: "test-key",
      DATABASE_URL: "postgresql://localhost/handleplan",
      KASSAL_BASE_URL: "https://kassal.app/api/v1",
    });
  });

  it("allows an explicit fake mode without production credentials", () => {
    expect(
      readServerEnv({
        KASSAL_MODE: "fake",
        KASSAL_API_KEY: "must-not-be-read",
        NEXT_PUBLIC_KASSAL_MODE: "fake",
      }),
    ).toEqual({ mode: "fake" });
  });

  it("rejects fake mode in production even when an override-like value is supplied", () => {
    expect(() => readServerEnv({
      NODE_ENV: "production",
      KASSAL_MODE: "fake",
      ALLOW_FAKE_IN_PRODUCTION: "true",
    })).toThrow(/production/i);
  });

  it("rejects unsupported modes and keeps real mode strict", () => {
    expect(() => readServerEnv({ KASSAL_MODE: "preview" })).toThrow(/KASSAL_MODE/);
    expect(() => readServerEnv({ KASSAL_MODE: "real" })).toThrow(/KASSAL_API_KEY/);
  });

  it.each(["https://db.example/handleplan", "mysql://db.example/handleplan", "ftp://db.example/handleplan"])(
    "rejects the non-PostgreSQL database URL %s",
    (DATABASE_URL) => {
      expect(() =>
        readServerEnv({
          KASSAL_API_KEY: "test-key",
          DATABASE_URL,
          KASSAL_BASE_URL: "https://kassal.app/api/v1",
        }),
      ).toThrow(/DATABASE_URL/);
    },
  );

  it.each([
    "http://kassal.app/api/v1",
    "ftp://kassal.app/api/v1",
    "javascript:alert(1)",
  ])("rejects the non-HTTPS Kassalapp URL %s", (KASSAL_BASE_URL) => {
    expect(() =>
      readServerEnv({
        KASSAL_API_KEY: "test-key",
        DATABASE_URL: "postgresql://localhost/handleplan",
        KASSAL_BASE_URL,
      }),
    ).toThrow(/KASSAL_BASE_URL/);
  });

  it("accepts both PostgreSQL URL spellings", () => {
    for (const DATABASE_URL of [
      "postgres://localhost/handleplan",
      "postgresql://localhost/handleplan",
    ]) {
      const parsed = readServerEnv({
        KASSAL_API_KEY: "test-key",
        DATABASE_URL,
        KASSAL_BASE_URL: "https://kassal.app/api/v1",
      });
      expect(parsed.mode).toBe("real");
      if (parsed.mode === "real") expect(parsed.DATABASE_URL).toBe(DATABASE_URL);
    }
  });
});
