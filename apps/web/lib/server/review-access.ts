import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 128 * 1024;
const JWKS_CACHE_MS = 5 * 60 * 1_000;
const JWKS_FORCED_REFRESH_COOLDOWN_MS = 60 * 1_000;
const JWKS_TIMEOUT_MS = 3_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

const teamDomainSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine((url) =>
    url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash === ""
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u
      .test(url.hostname), {
      message: "Review Access team domain must be a fixed Cloudflare Access HTTPS origin",
    })
  .transform((url) => url.origin);

const baseUrlSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine((url) =>
    url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash === "", {
      message: "Review base URL must be a fixed HTTPS origin",
    })
  .transform((url) => url.origin);

const reviewAccessEnvSchema = z
  .object({
    REVIEW_ACCESS_AUDIENCE: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/u),
    REVIEW_ACCESS_ISSUER: teamDomainSchema,
    REVIEW_ACCESS_TEAM_DOMAIN: teamDomainSchema,
    REVIEW_BASE_URL: baseUrlSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.REVIEW_ACCESS_ISSUER !== value.REVIEW_ACCESS_TEAM_DOMAIN) {
      context.addIssue({
        code: "custom",
        message: "Review Access issuer must equal the configured team domain",
        path: ["REVIEW_ACCESS_ISSUER"],
      });
    }
  });

export interface ReviewAccessConfig {
  audience: string;
  baseUrl: string;
  issuer: string;
  jwksUrl: string;
  teamDomain: string;
}

export interface ReviewPrincipal {
  actorId: string;
  expiresAt: string;
  sessionId: string;
}

export class ReviewAccessDeniedError extends Error {
  constructor() {
    super("Private review access denied");
    this.name = "ReviewAccessDeniedError";
  }
}

interface CachedJwks {
  expiresAtMs: number;
  keys: ReadonlyMap<string, JsonWebKey>;
}

let jwksCache = new Map<string, CachedJwks>();
let jwksFetches = new Map<string, Promise<ReadonlyMap<string, JsonWebKey>>>();
let jwksForcedRefreshAtMs = new Map<string, number>();

function denied(): never {
  throw new ReviewAccessDeniedError();
}

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) denied();
  try {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  } catch {
    denied();
  }
}

function parsedSegment(value: string): unknown {
  const bytes = base64UrlBytes(value);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_ASSERTION_BYTES) denied();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    denied();
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const jwtHeaderSchema = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().min(1).max(200),
    typ: z.literal("JWT").optional(),
  })
  .strict();

const jwtClaimsSchema = z
  .object({
    aud: z.union([
      z.string().min(1).max(200),
      z.array(z.string().min(1).max(200)).min(1).max(10),
    ]),
    exp: z.number().int().positive(),
    iat: z.number().int().positive(),
    iss: z.string().min(1).max(500),
    nbf: z.number().int().positive().optional(),
    sub: z.string().min(1).max(500),
  })
  .passthrough();

function validJwk(value: unknown): { jwk: JsonWebKey; kid: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    entry.kty !== "RSA"
    || entry.alg !== "RS256"
    || (entry.use !== undefined && entry.use !== "sig")
    || typeof entry.kid !== "string"
    || entry.kid.length < 1
    || entry.kid.length > 200
    || typeof entry.n !== "string"
    || !/^[A-Za-z0-9_-]{128,2048}$/u.test(entry.n)
    || typeof entry.e !== "string"
    || !/^[A-Za-z0-9_-]{2,16}$/u.test(entry.e)
  ) {
    return undefined;
  }
  return { jwk: entry as JsonWebKey, kid: entry.kid };
}

async function fetchJwks(
  config: ReviewAccessConfig,
  nowMs: number,
  fetcher: typeof fetch,
): Promise<ReadonlyMap<string, JsonWebKey>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const response = await fetcher(config.jwksUrl, {
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) denied();
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null
      && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_JWKS_BYTES)
    ) {
      denied();
    }
    if (response.body === null) denied();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const fragments: string[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytesRead += chunk.value.byteLength;
        if (bytesRead > MAX_JWKS_BYTES) {
          await reader.cancel().catch(() => undefined);
          denied();
        }
        fragments.push(decoder.decode(chunk.value, { stream: true }));
      }
      fragments.push(decoder.decode());
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof ReviewAccessDeniedError) throw error;
      denied();
    }
    const text = fragments.join("");
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      denied();
    }
    if (
      raw === null
      || typeof raw !== "object"
      || Array.isArray(raw)
      || !Array.isArray((raw as { keys?: unknown }).keys)
      || (raw as { keys: unknown[] }).keys.length < 1
      || (raw as { keys: unknown[] }).keys.length > 20
    ) {
      denied();
    }
    const keys = new Map<string, JsonWebKey>();
    for (const candidate of (raw as { keys: unknown[] }).keys) {
      const parsed = validJwk(candidate);
      if (parsed === undefined || keys.has(parsed.kid)) denied();
      keys.set(parsed.kid, parsed.jwk);
    }
    jwksCache.set(config.jwksUrl, {
      expiresAtMs: nowMs + JWKS_CACHE_MS,
      keys,
    });
    return keys;
  } catch (error) {
    if (error instanceof ReviewAccessDeniedError) throw error;
    denied();
  } finally {
    clearTimeout(timer);
  }
}

function fetchJwksSingleFlight(
  config: ReviewAccessConfig,
  nowMs: number,
  fetcher: typeof fetch,
): Promise<ReadonlyMap<string, JsonWebKey>> {
  const existing = jwksFetches.get(config.jwksUrl);
  if (existing !== undefined) return existing;

  const pending = fetchJwks(config, nowMs, fetcher);
  const clearPending = () => {
    if (jwksFetches.get(config.jwksUrl) === pending) {
      jwksFetches.delete(config.jwksUrl);
    }
  };
  jwksFetches.set(config.jwksUrl, pending);
  void pending.then(clearPending, clearPending);
  return pending;
}

async function readJwk(
  config: ReviewAccessConfig,
  kid: string,
  nowMs: number,
  fetcher: typeof fetch,
): Promise<JsonWebKey> {
  const cached = jwksCache.get(config.jwksUrl);
  if (cached === undefined || cached.expiresAtMs <= nowMs) {
    const keys = await fetchJwksSingleFlight(config, nowMs, fetcher);
    return keys.get(kid) ?? denied();
  }

  const cachedKey = cached.keys.get(kid);
  if (cachedKey !== undefined) return cachedKey;

  // A new Access signing key may appear before the five-minute cache expires.
  // Refresh once per cooldown and share that refresh across concurrent misses.
  const inFlight = jwksFetches.get(config.jwksUrl);
  if (inFlight !== undefined) {
    const keys = await inFlight;
    return keys.get(kid) ?? denied();
  }
  const lastRefreshAtMs = jwksForcedRefreshAtMs.get(config.jwksUrl);
  if (
    lastRefreshAtMs !== undefined
    && nowMs - lastRefreshAtMs < JWKS_FORCED_REFRESH_COOLDOWN_MS
  ) {
    denied();
  }
  // Record the attempt before I/O so failures and unknown-kid floods are also
  // rate limited rather than turning the cert endpoint into an oracle.
  jwksForcedRefreshAtMs.set(config.jwksUrl, nowMs);
  const refreshed = await fetchJwksSingleFlight(config, nowMs, fetcher);
  return refreshed.get(kid) ?? denied();
}

function isStrongImportedReviewKey(key: CryptoKey): boolean {
  if (key.type !== "public" || !key.usages.includes("verify")) return false;
  const algorithm = key.algorithm as Partial<RsaHashedKeyAlgorithm>;
  return algorithm.name === "RSASSA-PKCS1-v1_5"
    && algorithm.hash?.name === "SHA-256"
    && typeof algorithm.modulusLength === "number"
    && Number.isInteger(algorithm.modulusLength)
    && algorithm.modulusLength >= 2_048;
}

function exactRequestOrigin(request: Request, config: ReviewAccessConfig): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    denied();
  }
  if (
    url.origin !== config.baseUrl
    || !(url.pathname === "/review" || url.pathname.startsWith("/review/")
      || url.pathname === "/api/review" || url.pathname.startsWith("/api/review/"))
  ) {
    denied();
  }
}

export function readReviewAccessConfig(
  values: Record<string, string | undefined> = process.env,
): ReviewAccessConfig {
  const parsed = reviewAccessEnvSchema.parse({
    REVIEW_ACCESS_AUDIENCE: values.REVIEW_ACCESS_AUDIENCE,
    REVIEW_ACCESS_ISSUER: values.REVIEW_ACCESS_ISSUER,
    REVIEW_ACCESS_TEAM_DOMAIN: values.REVIEW_ACCESS_TEAM_DOMAIN,
    REVIEW_BASE_URL: values.REVIEW_BASE_URL,
  });
  return Object.freeze({
    audience: parsed.REVIEW_ACCESS_AUDIENCE,
    baseUrl: parsed.REVIEW_BASE_URL,
    issuer: parsed.REVIEW_ACCESS_ISSUER,
    jwksUrl: `${parsed.REVIEW_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
    teamDomain: parsed.REVIEW_ACCESS_TEAM_DOMAIN,
  });
}

export async function verifyReviewAccess(
  request: Request,
  config: ReviewAccessConfig,
  options: {
    fetcher?: typeof fetch;
    now?: Date;
  } = {},
): Promise<ReviewPrincipal> {
  exactRequestOrigin(request, config);
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (
    assertion === null
    || assertion.length < 1
    || new TextEncoder().encode(assertion).byteLength > MAX_ASSERTION_BYTES
  ) {
    denied();
  }
  const segments = assertion.split(".");
  if (segments.length !== 3) denied();
  const [headerSegment, claimsSegment, signatureSegment] = segments as [
    string,
    string,
    string,
  ];
  const header = jwtHeaderSchema.safeParse(parsedSegment(headerSegment));
  const claims = jwtClaimsSchema.safeParse(parsedSegment(claimsSegment));
  if (!header.success || !claims.success) denied();

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) denied();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const audiences = Array.isArray(claims.data.aud)
    ? claims.data.aud
    : [claims.data.aud];
  if (
    claims.data.iss !== config.issuer
    || !audiences.includes(config.audience)
    || claims.data.exp <= nowSeconds - CLOCK_SKEW_SECONDS
    || claims.data.iat > nowSeconds + CLOCK_SKEW_SECONDS
    || (claims.data.nbf !== undefined
      && claims.data.nbf > nowSeconds + CLOCK_SKEW_SECONDS)
    || claims.data.exp <= claims.data.iat
    || claims.data.exp - claims.data.iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    denied();
  }

  const jwk = await readJwk(
    config,
    header.data.kid,
    nowMs,
    options.fetcher ?? fetch,
  );
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"],
    );
  } catch {
    denied();
  }
  if (!isStrongImportedReviewKey(key)) denied();
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    exactArrayBuffer(base64UrlBytes(signatureSegment)),
    new TextEncoder().encode(`${headerSegment}.${claimsSegment}`),
  );
  if (!valid) denied();

  return Object.freeze({
    actorId: `access:${createHash("sha256")
      .update(`${claims.data.iss}\u0000${claims.data.sub}`, "utf8")
      .digest("hex")}`,
    expiresAt: new Date(claims.data.exp * 1_000).toISOString(),
    // Bind rendered evidence to this verified Access assertion, not only to
    // the stable reviewer subject. The assertion itself never leaves this
    // server boundary and no email/header identity is retained.
    sessionId: `access-session:${createHash("sha256")
      .update(assertion, "utf8")
      .digest("hex")}`,
  });
}

export function resetReviewAccessJwksCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") denied();
  jwksCache = new Map();
  jwksFetches = new Map();
  jwksForcedRefreshAtMs = new Map();
}
