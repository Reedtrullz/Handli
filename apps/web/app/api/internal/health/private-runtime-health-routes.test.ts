import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPrivateRuntimeReadyHandler,
  privateRuntimeHealthRequestHeaders,
  type PrivateRuntimeKind,
  type PrivateRuntimeReadinessProbe,
} from "../../../../lib/server/private-runtime-readiness";

function request(runtime: PrivateRuntimeKind, overrides: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000/api/internal/health/${runtime}`, {
    ...overrides,
    headers: {
      host: "127.0.0.1:3000",
      ...privateRuntimeHealthRequestHeaders(runtime),
      ...Object.fromEntries(new Headers(overrides.headers)),
    },
  });
}

function probe(runtime: PrivateRuntimeKind): PrivateRuntimeReadinessProbe {
  return {
    check: async () => ({
      databaseRole: runtime === "review" ? "handleplan_review" : "handleplan_operations",
      requiredMigration: "026_official_offer_publication_runtime.sql",
      runtime,
    }),
  };
}

describe("loopback-only private runtime health routes", () => {
  it.each(["review", "operations"] as const)(
    "returns the exact %s role and migration only for the marked loopback request",
    async (runtime) => {
      const response = await createPrivateRuntimeReadyHandler(
        runtime,
        async () => probe(runtime),
      )(request(runtime));

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      await expect(response.json()).resolves.toEqual({
        database: {
          requiredMigration: "026_official_offer_publication_runtime.sql",
          role: runtime === "review" ? "handleplan_review" : "handleplan_operations",
          status: "ok",
        },
        runtime,
        status: "ok",
        version: 1,
      });
    },
  );

  it("returns a generic 404 before resolving dependencies for non-loopback or proxied requests", async () => {
    const provider = vi.fn(async () => probe("review"));
    const handler = createPrivateRuntimeReadyHandler("review", provider);
    const invalidRequests = [
      new Request("https://handle.reidar.tech/api/internal/health/review", {
        headers: {
          host: "handle.reidar.tech",
          ...privateRuntimeHealthRequestHeaders("review"),
        },
      }),
      request("review", { headers: { forwarded: "for=203.0.113.8" } }),
      request("review", { headers: { "x-forwarded-for": "203.0.113.8" } }),
      request("review", { headers: { "x-handleplan-internal-health": "wrong" } }),
      new Request("http://127.0.0.1:3000/api/internal/health/review?probe=1", {
        headers: {
          host: "127.0.0.1:3000",
          ...privateRuntimeHealthRequestHeaders("review"),
        },
      }),
    ];

    for (const invalid of invalidRequests) {
      const response = await handler(invalid);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("sanitizes configuration, database, timeout, and runtime-mismatch failures", async () => {
    const sentinels = [
      "postgresql://private-role:private-password@postgres/handleplan",
      "private-roster-source",
    ];
    const failing = createPrivateRuntimeReadyHandler("operations", async () => {
      throw new Error(sentinels.join(" "));
    });
    const mismatched = createPrivateRuntimeReadyHandler(
      "operations",
      async () => probe("review"),
    );
    const wrongRole = createPrivateRuntimeReadyHandler("operations", async () => ({
      check: async () => ({
        databaseRole: "handleplan_review",
        requiredMigration: "026_official_offer_publication_runtime.sql",
        runtime: "operations",
      }),
    }));

    for (const handler of [failing, mismatched, wrongRole]) {
      const response = await handler(request("operations"));
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        code: "DEPENDENCY_UNAVAILABLE",
        status: "unavailable",
        version: 1,
      });
      for (const sentinel of sentinels) expect(body).not.toContain(sentinel);
    }
  });
});
