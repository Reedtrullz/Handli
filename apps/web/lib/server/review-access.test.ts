import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  readReviewAccessConfig,
  resetReviewAccessJwksCacheForTests,
  ReviewAccessDeniedError,
  verifyReviewAccess,
} from "./review-access";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const TEAM_DOMAIN = "https://handleplan-review.cloudflareaccess.com";
const AUDIENCE = "review-audience-0123456789abcdef";

const config = readReviewAccessConfig({
  REVIEW_ACCESS_AUDIENCE: AUDIENCE,
  REVIEW_ACCESS_ISSUER: TEAM_DOMAIN,
  REVIEW_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  REVIEW_BASE_URL: "https://handle.reidar.tech",
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function signingFixture(options: {
  kid?: string;
  modulusLength?: number;
} = {}) {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: options.modulusLength ?? 2_048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = {
    ...exported,
    alg: "RS256",
    kid: options.kid ?? "review-key-1",
    use: "sig",
  };
  async function token(overrides: Record<string, unknown> = {}) {
    const header = encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" });
    const claims = encode({
      aud: AUDIENCE,
      exp: Math.floor(NOW.getTime() / 1_000) + 3_600,
      iat: Math.floor(NOW.getTime() / 1_000) - 60,
      iss: TEAM_DOMAIN,
      sub: "reviewer-subject-1",
      ...overrides,
    });
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    return `${header}.${claims}.${Buffer.from(signature).toString("base64url")}`;
  }
  return { publicJwk, token };
}

function request(assertion: string, url = "https://handle.reidar.tech/api/review/candidates") {
  return new Request(url, {
    headers: {
      "cf-access-authenticated-user-email": "untrusted@example.invalid",
      "cf-access-jwt-assertion": assertion,
    },
  });
}

beforeEach(() => resetReviewAccessJwksCacheForTests());

describe("private review Cloudflare Access verification", () => {
  it("verifies the RS256 assertion, fixed issuer/audience/origin, and derives a pseudonymous actor", async () => {
    const fixture = await signingFixture();
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    const assertion = await fixture.token({
      email: "private-reviewer@example.invalid",
    });

    const principal = await verifyReviewAccess(request(assertion), config, {
      fetcher,
      now: NOW,
    });

    expect(principal).toEqual({
      actorId: expect.stringMatching(/^access:[0-9a-f]{64}$/u),
      expiresAt: "2026-07-17T13:00:00.000Z",
      sessionId: expect.stringMatching(/^access-session:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(principal)).not.toContain("example.invalid");
    expect(fetcher).toHaveBeenCalledWith(
      `${TEAM_DOMAIN}/cdn-cgi/access/certs`,
      expect.objectContaining({ cache: "no-store", redirect: "error" }),
    );
  });

  it("uses a bounded JWKS cache without weakening signature verification", async () => {
    const fixture = await signingFixture();
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    const assertion = await fixture.token();

    await verifyReviewAccess(request(assertion), config, { fetcher, now: NOW });
    await verifyReviewAccess(request(assertion), config, {
      fetcher,
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("single-flights concurrent cold-cache JWKS retrieval", async () => {
    const fixture = await signingFixture();
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetcher = vi.fn(async () => {
      await fetchGate;
      return Response.json({ keys: [fixture.publicJwk] });
    });
    const assertion = await fixture.token();
    const attempts = Array.from({ length: 12 }, () =>
      verifyReviewAccess(request(assertion), config, { fetcher, now: NOW }));

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    releaseFetch?.();
    await expect(Promise.all(attempts)).resolves.toHaveLength(12);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts a legitimate signing-key rotation through one forced cached-miss refresh", async () => {
    const first = await signingFixture({ kid: "review-key-before-rotation" });
    const rotated = await signingFixture({ kid: "review-key-after-rotation" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ keys: [first.publicJwk] }))
      .mockResolvedValueOnce(Response.json({ keys: [rotated.publicJwk] }));

    await verifyReviewAccess(request(await first.token()), config, { fetcher, now: NOW });
    await expect(verifyReviewAccess(request(await rotated.token()), config, {
      fetcher,
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toEqual(expect.objectContaining({
      actorId: expect.stringMatching(/^access:[0-9a-f]{64}$/u),
      sessionId: expect.stringMatching(/^access-session:[0-9a-f]{64}$/u),
    }));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("single-flights and rate-limits concurrent and serial unknown-kid refreshes", async () => {
    const current = await signingFixture({ kid: "review-key-current" });
    const unknown = await signingFixture({ kid: "review-key-unknown" });
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ keys: [current.publicJwk] }))
      .mockImplementation(async () => {
        await refreshGate;
        return Response.json({ keys: [current.publicJwk] });
      });

    await verifyReviewAccess(request(await current.token()), config, { fetcher, now: NOW });
    const assertion = await unknown.token();
    const concurrent = Array.from({ length: 12 }, () =>
      verifyReviewAccess(request(assertion), config, {
        fetcher,
        now: new Date(NOW.getTime() + 1_000),
      }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releaseRefresh?.();
    await Promise.all(concurrent.map(async (attempt) =>
      expect(attempt).rejects.toBeInstanceOf(ReviewAccessDeniedError)));

    for (let seconds = 2; seconds < 20; seconds += 1) {
      await expect(verifyReviewAccess(request(assertion), config, {
        fetcher,
        now: new Date(NOW.getTime() + seconds * 1_000),
      })).rejects.toBeInstanceOf(ReviewAccessDeniedError);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);

    await expect(verifyReviewAccess(request(assertion), config, {
      fetcher,
      now: new Date(NOW.getTime() + 61_000),
    })).rejects.toBeInstanceOf(ReviewAccessDeniedError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects an imported RSA key whose modulus is below 2048 bits", async () => {
    const weak = await signingFixture({
      kid: "review-key-weak-1024",
      modulusLength: 1_024,
    });
    const fetcher = vi.fn(async () => Response.json({ keys: [weak.publicJwk] }));

    await expect(verifyReviewAccess(request(await weak.token()), config, {
      fetcher,
      now: NOW,
    })).rejects.toBeInstanceOf(ReviewAccessDeniedError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels a chunked JWKS response once the streaming byte limit is exceeded", async () => {
    const fixture = await signingFixture();
    const cancelled = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      cancel: cancelled,
      start(controller) {
        controller.enqueue(new Uint8Array(100 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
      },
    });

    await expect(verifyReviewAccess(request(await fixture.token()), config, {
      fetcher: async () => new Response(oversized, {
        headers: { "content-type": "application/json" },
      }),
      now: NOW,
    })).rejects.toBeInstanceOf(ReviewAccessDeniedError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong audience", { aud: "other-review-audience-012345" }],
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["expired", { exp: Math.floor(NOW.getTime() / 1_000) - 120 }],
    ["future not-before", { nbf: Math.floor(NOW.getTime() / 1_000) + 120 }],
    ["overlong lifetime", {
      exp: Math.floor(NOW.getTime() / 1_000) + 90_000,
      iat: Math.floor(NOW.getTime() / 1_000) - 60,
    }],
  ])("rejects %s claims before repository access", async (_label, overrides) => {
    const fixture = await signingFixture();
    const assertion = await fixture.token(overrides);
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));

    await expect(verifyReviewAccess(request(assertion), config, { fetcher, now: NOW }))
      .rejects.toBeInstanceOf(ReviewAccessDeniedError);
  });

  it("rejects tampering, unsigned header identity, and a mismatched base URL", async () => {
    const fixture = await signingFixture();
    const assertion = await fixture.token();
    const fetcher = vi.fn(async () => Response.json({ keys: [fixture.publicJwk] }));
    const [header, claims, signature] = assertion.split(".");
    const tampered = `${header}.${encode({
      aud: AUDIENCE,
      exp: Math.floor(NOW.getTime() / 1_000) + 3_600,
      iat: Math.floor(NOW.getTime() / 1_000) - 60,
      iss: TEAM_DOMAIN,
      sub: "different-reviewer",
    })}.${signature}`;

    await expect(verifyReviewAccess(request(tampered), config, { fetcher, now: NOW }))
      .rejects.toBeInstanceOf(ReviewAccessDeniedError);
    await expect(verifyReviewAccess(new Request(
      "https://handle.reidar.tech/api/review/candidates",
      { headers: { "cf-access-authenticated-user-email": "forged@example.invalid" } },
    ), config, { fetcher, now: NOW })).rejects.toBeInstanceOf(ReviewAccessDeniedError);
    await expect(verifyReviewAccess(
      request(assertion, "https://attacker.invalid/api/review/candidates"),
      config,
      { fetcher, now: NOW },
    )).rejects.toBeInstanceOf(ReviewAccessDeniedError);
    expect(claims).toBeDefined();
  });

  it("fails closed on configuration drift or malformed JWKS", async () => {
    expect(() => readReviewAccessConfig({
      REVIEW_ACCESS_AUDIENCE: AUDIENCE,
      REVIEW_ACCESS_ISSUER: "https://wrong.cloudflareaccess.com",
      REVIEW_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      REVIEW_BASE_URL: "https://handle.reidar.tech",
    })).toThrow();
    expect(() => readReviewAccessConfig({
      REVIEW_ACCESS_AUDIENCE: AUDIENCE,
      REVIEW_ACCESS_ISSUER: TEAM_DOMAIN,
      REVIEW_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      REVIEW_BASE_URL: "http://handle.reidar.tech",
    })).toThrow();

    const fixture = await signingFixture();
    await expect(verifyReviewAccess(request(await fixture.token()), config, {
      fetcher: async () => Response.json({ keys: [{ kid: "review-key-1" }] }),
      now: NOW,
    })).rejects.toBeInstanceOf(ReviewAccessDeniedError);
  });
});
