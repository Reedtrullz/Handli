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
});
