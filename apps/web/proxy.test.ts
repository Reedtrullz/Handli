import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { NextRequest } from "next/server";

import { resetReviewAccessJwksCacheForTests } from "./lib/server/review-access";
import { config, proxy } from "./proxy";

const TEAM_DOMAIN = "https://handleplan-review.cloudflareaccess.com";
const AUDIENCE = "review-audience-0123456789abcdef";
const OPERATIONS_TEAM_DOMAIN = "https://handleplan-operations.cloudflareaccess.com";
const OPERATIONS_AUDIENCE = "operations-audience-0123456789abcdef";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function signedAssertion(
  audience = AUDIENCE,
  issuer = TEAM_DOMAIN,
  kid = "proxy-review-key",
) {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2_048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...await crypto.subtle.exportKey("jwk", pair.publicKey),
    alg: "RS256",
    kid,
    use: "sig",
  };
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" });
  const claims = encode({
    aud: audience,
    exp: nowSeconds + 3_600,
    iat: nowSeconds - 60,
    iss: issuer,
    sub: "proxy-reviewer",
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return {
    assertion: `${header}.${claims}.${Buffer.from(signature).toString("base64url")}`,
    publicJwk,
  };
}

function reviewRequest(url: string, assertion: string): NextRequest {
  return new NextRequest(url, {
    headers: { "cf-access-jwt-assertion": assertion },
  });
}

beforeEach(() => {
  vi.stubEnv("REVIEW_ACCESS_AUDIENCE", AUDIENCE);
  vi.stubEnv("REVIEW_ACCESS_ISSUER", TEAM_DOMAIN);
  vi.stubEnv("REVIEW_ACCESS_TEAM_DOMAIN", TEAM_DOMAIN);
  vi.stubEnv("REVIEW_BASE_URL", "https://handle.reidar.tech");
  vi.stubEnv("OPERATIONS_ACCESS_AUDIENCE", OPERATIONS_AUDIENCE);
  vi.stubEnv("OPERATIONS_ACCESS_ISSUER", OPERATIONS_TEAM_DOMAIN);
  vi.stubEnv("OPERATIONS_ACCESS_TEAM_DOMAIN", OPERATIONS_TEAM_DOMAIN);
  vi.stubEnv("OPERATIONS_BASE_URL", "https://handle.reidar.tech");
  resetReviewAccessJwksCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("private review actual-request proxy boundary", () => {
  it("verifies the actual inbound review URL before continuing with no-store", async () => {
    const fixture = await signedAssertion();
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    vi.stubGlobal("fetch", fetcher);

    const response = await proxy(reviewRequest(
      "https://handle.reidar.tech/review",
      fixture.assertion,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(config.matcher).toEqual(["/review/:path*", "/internal/operations/:path*"]);
  });

  it("uses a distinct operations audience for the internal operations page", async () => {
    const fixture = await signedAssertion(
      OPERATIONS_AUDIENCE,
      OPERATIONS_TEAM_DOMAIN,
      "proxy-operations-key",
    );
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    vi.stubGlobal("fetch", fetcher);

    const accepted = await proxy(reviewRequest(
      "https://handle.reidar.tech/internal/operations",
      fixture.assertion,
    ));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");

    const reviewFixture = await signedAssertion();
    const denied = await proxy(reviewRequest(
      "https://handle.reidar.tech/internal/operations",
      reviewFixture.assertion,
    ));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toMatch(/drift|kilde|varsling|operatør/iu);
  });

  it("fails closed for the same valid assertion on an alternate inbound host", async () => {
    const fixture = await signedAssertion();
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    vi.stubGlobal("fetch", fetcher);

    const response = await proxy(reviewRequest(
      "https://alternate.reidar.tech/review",
      fixture.assertion,
    ));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-language")).toBe("nb");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.text();
    expect(body).toContain('<html lang="nb">');
    expect(body).toContain("<h1>Siden finnes ikke</h1>");
    expect(body).not.toMatch(/privat|vurdering|kandidat|kildeutsnitt/iu);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the same non-enumerating response for missing assertions and config drift", async () => {
    const missing = await proxy(new NextRequest("https://handle.reidar.tech/review"));
    vi.stubEnv("REVIEW_BASE_URL", "http://handle.reidar.tech");
    const drifted = await proxy(new NextRequest("https://handle.reidar.tech/review", {
      headers: { "cf-access-jwt-assertion": "not-a-token" },
    }));

    const missingEvidence = {
      body: await missing.text(),
      cache: missing.headers.get("cache-control"),
      contentType: missing.headers.get("content-type"),
      status: missing.status,
    };
    const driftedEvidence = {
      body: await drifted.text(),
      cache: drifted.headers.get("cache-control"),
      contentType: drifted.headers.get("content-type"),
      status: drifted.status,
    };

    expect(missingEvidence).toEqual(driftedEvidence);
    expect(missingEvidence).toMatchObject({
      cache: "private, no-store",
      contentType: "text/html; charset=utf-8",
      status: 404,
    });
    expect(missingEvidence.body).toContain("<h1>Siden finnes ikke</h1>");
  });
});
