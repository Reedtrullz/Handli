import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resetReviewAccessJwksCacheForTests } from "./review-access";
import {
  readOperationsAccessConfig,
  verifyOperationsAccess,
} from "./operations-access";

const TEAM_DOMAIN = "https://handleplan-operations.cloudflareaccess.com";
const OPERATIONS_AUDIENCE = "operations-audience-0123456789abcdef";
const REVIEW_AUDIENCE = "review-audience-0123456789abcdef";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function signedAssertion(audience = OPERATIONS_AUDIENCE) {
  const pair = await crypto.subtle.generateKey({
    hash: "SHA-256",
    modulusLength: 2_048,
    name: "RSASSA-PKCS1-v1_5",
    publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["sign", "verify"]);
  const publicJwk = {
    ...await crypto.subtle.exportKey("jwk", pair.publicKey),
    alg: "RS256",
    kid: `operations-${audience}`,
    use: "sig",
  };
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" });
  const claims = encode({
    aud: audience,
    exp: now + 3_600,
    iat: now - 30,
    iss: TEAM_DOMAIN,
    sub: "operations-maintainer",
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

beforeEach(() => {
  resetReviewAccessJwksCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("private operations Access boundary", () => {
  const config = readOperationsAccessConfig({
    OPERATIONS_ACCESS_AUDIENCE: OPERATIONS_AUDIENCE,
    OPERATIONS_ACCESS_ISSUER: TEAM_DOMAIN,
    OPERATIONS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    OPERATIONS_BASE_URL: "https://handle.reidar.tech",
  });

  it("accepts its own signed audience on only the exact operations page and snapshot API", async () => {
    const fixture = await signedAssertion();
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    for (const url of [
      "https://handle.reidar.tech/internal/operations",
      "https://handle.reidar.tech/api/internal/operations/snapshot",
    ]) {
      await expect(verifyOperationsAccess(new Request(url, {
        headers: { "cf-access-jwt-assertion": fixture.assertion },
      }), config, { fetcher })).resolves.toMatchObject({
        actorId: expect.stringMatching(/^access:[0-9a-f]{64}$/u),
      });
    }
  });

  it("rejects a valid review audience, alternate host, review/public path, and missing assertion", async () => {
    const review = await signedAssertion(REVIEW_AUDIENCE);
    const fetcher = vi.fn(async () => Response.json({ keys: [review.publicJwk] }));
    await expect(verifyOperationsAccess(new Request(
      "https://handle.reidar.tech/internal/operations",
      { headers: { "cf-access-jwt-assertion": review.assertion } },
    ), config, { fetcher })).rejects.toBeDefined();
    for (const url of [
      "https://alternate.reidar.tech/internal/operations",
      "https://handle.reidar.tech/review",
      "https://handle.reidar.tech/status",
      "https://handle.reidar.tech/internal/operations/source",
      "https://handle.reidar.tech/api/internal/operations/other",
    ]) {
      await expect(verifyOperationsAccess(new Request(url, {
        headers: { "cf-access-jwt-assertion": review.assertion },
      }), config, { fetcher })).rejects.toBeDefined();
    }
    await expect(verifyOperationsAccess(
      new Request("https://handle.reidar.tech/internal/operations"),
      config,
      { fetcher },
    )).rejects.toBeDefined();
  });

  it("fails closed for config drift", () => {
    expect(() => readOperationsAccessConfig({
      OPERATIONS_ACCESS_AUDIENCE: OPERATIONS_AUDIENCE,
      OPERATIONS_ACCESS_ISSUER: TEAM_DOMAIN,
      OPERATIONS_ACCESS_TEAM_DOMAIN: "https://other.cloudflareaccess.com",
      OPERATIONS_BASE_URL: "http://handle.reidar.tech",
    })).toThrow();
  });
});
