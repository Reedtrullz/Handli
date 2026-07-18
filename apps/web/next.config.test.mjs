import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig from "./next.config.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("global response security headers", () => {
  it("derives the build ID only from the canonical source snapshot", async () => {
    vi.stubEnv("HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST", "");
    await expect(nextConfig.generateBuildId()).rejects.toThrow(
      /HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST/u,
    );

    vi.stubEnv("HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST", "A".repeat(64));
    await expect(nextConfig.generateBuildId()).rejects.toThrow(
      /HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST/u,
    );

    const digest = "a".repeat(64);
    vi.stubEnv("HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST", digest);
    await expect(nextConfig.generateBuildId()).resolves.toBe(`hpv2-${digest}`);
  });

  it("applies the public security baseline to every route", async () => {
    const rules = await nextConfig.headers();
    const globalRule = rules.find(({ source }) => source === "/:path*");
    const headers = new Map(globalRule?.headers.map(({ key, value }) => [key, value]));

    expect(globalRule).toBeDefined();
    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(self)",
    );

    const policy = headers.get("Content-Security-Policy");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("default-src *");
    expect(policy).not.toContain("img-src 'self' data: blob:");
    expect(policy).not.toContain("frame-src blob:");
  });

  it("allows ephemeral image evidence only on the private review UI", async () => {
    const rules = await nextConfig.headers();
    const reviewRule = rules.find(({ source }) => source === "/review/:path*");
    const headers = new Map(reviewRule?.headers.map(({ key, value }) => [key, value]));
    const policy = headers.get("Content-Security-Policy");

    expect(reviewRule).toBeDefined();
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });
});
