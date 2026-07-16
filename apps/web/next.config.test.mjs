import { describe, expect, it } from "vitest";

import nextConfig from "./next.config.mjs";

describe("global response security headers", () => {
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
  });
});
