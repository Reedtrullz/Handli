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
      KASSAL_API_KEY: "test-key",
      DATABASE_URL: "postgresql://localhost/handleplan",
      KASSAL_BASE_URL: "https://kassal.app/api/v1",
    });
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
      expect(
        readServerEnv({
          KASSAL_API_KEY: "test-key",
          DATABASE_URL,
          KASSAL_BASE_URL: "https://kassal.app/api/v1",
        }).DATABASE_URL,
      ).toBe(DATABASE_URL);
    }
  });
});
