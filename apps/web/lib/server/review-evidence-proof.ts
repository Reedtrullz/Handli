import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  reviewEvidenceChallengeTokenSchema,
  reviewEvidenceProofTokenSchema,
} from "@handleplan/domain";

import type { ReviewPrincipal } from "./review-access";

export const REVIEW_EVIDENCE_PROOF_TTL_MS = 2 * 60 * 1_000;
export const REVIEW_EVIDENCE_CHALLENGE_TTL_MS = 2 * 60 * 1_000;

export interface ReviewEvidenceBinding {
  readonly candidateId: string;
  readonly candidateVersion: number;
  readonly checksumSha256: string;
  readonly cropReference: string;
  readonly presentation: "full_capture";
  readonly rightsClassification: "private_review" | "public_display";
}

export interface IssuedReviewEvidenceProof {
  readonly expiresAt: string;
  readonly proofSha256: string;
  readonly token: string;
}

export interface IssuedReviewEvidenceChallenge {
  readonly expiresAt: string;
  readonly token: string;
}

export class ReviewEvidenceProofError extends Error {
  constructor() {
    super("Private review evidence proof is invalid");
    this.name = "ReviewEvidenceProofError";
  }
}

function invalid(): never {
  throw new ReviewEvidenceProofError();
}

function finiteNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return new Date(value);
}

function decodeSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43,172}$/u.test(value)) invalid();
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (
    bytes.byteLength < 32
    || bytes.byteLength > 128
    || Buffer.from(bytes).toString("base64url") !== value
  ) invalid();
  return bytes;
}

function bindingDigest(
  domain: "challenge" | "proof",
  binding: Readonly<ReviewEvidenceBinding>,
  principal: Readonly<ReviewPrincipal>,
  expiresAtMs: number,
): string {
  if (
    !Number.isSafeInteger(binding.candidateVersion)
    || binding.candidateVersion < 0
    || !/^[0-9a-f]{64}$/u.test(binding.checksumSha256)
    || !/^review-crop:[0-9a-f]{64}$/u.test(binding.cropReference)
    || !/^access:[0-9a-f]{64}$/u.test(principal.actorId)
    || !/^access-session:[0-9a-f]{64}$/u.test(principal.sessionId)
    || !["private_review", "public_display"].includes(binding.rightsClassification)
    || binding.presentation !== "full_capture"
  ) {
    invalid();
  }
  return createHash("sha256").update([
    `review-evidence-${domain}-binding-v1`,
    binding.candidateId,
    String(binding.candidateVersion),
    binding.checksumSha256,
    binding.cropReference,
    binding.presentation,
    binding.rightsClassification,
    principal.actorId,
    principal.sessionId,
    String(expiresAtMs),
  ].join("\0"), "utf8").digest("hex");
}

function proofHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function issueToken(
  kind: "challenge" | "proof",
  secret: Uint8Array,
  now: () => Date,
  ttlMs: number,
  binding: Readonly<ReviewEvidenceBinding>,
  principal: Readonly<ReviewPrincipal>,
): { expiresAt: string; token: string } {
  const issuedAtMs = finiteNow(now).getTime();
  const accessExpiresAtMs = Date.parse(principal.expiresAt);
  if (!Number.isFinite(accessExpiresAtMs)) invalid();
  const expiresAtMs = Math.min(issuedAtMs + ttlMs, accessExpiresAtMs);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) invalid();
  const expiry = expiresAtMs.toString(36);
  const nonce = randomBytes(16).toString("base64url");
  const digest = bindingDigest(kind, binding, principal, expiresAtMs);
  const unsigned = `v1.${expiry}.${nonce}.${digest}`;
  const mac = createHmac("sha256", secret)
    .update(`review-evidence-${kind}-token-v1\0${unsigned}`, "utf8")
    .digest("hex");
  const rawToken = `review-${kind}:v1.${expiry}.${nonce}.${digest}.${mac}`;
  const token = kind === "proof"
    ? reviewEvidenceProofTokenSchema.parse(rawToken)
    : reviewEvidenceChallengeTokenSchema.parse(rawToken);
  return Object.freeze({
    expiresAt: new Date(expiresAtMs).toISOString(),
    token,
  });
}

function verifyToken(
  kind: "challenge" | "proof",
  secret: Uint8Array,
  now: () => Date,
  ttlMs: number,
  tokenInput: string,
  binding: Readonly<ReviewEvidenceBinding>,
  principal: Readonly<ReviewPrincipal>,
): { expiresAt: string; token: string } {
  const parsed = kind === "proof"
    ? reviewEvidenceProofTokenSchema.safeParse(tokenInput)
    : reviewEvidenceChallengeTokenSchema.safeParse(tokenInput);
  if (!parsed.success) invalid();
  const prefix = `review-${kind}:`;
  const segments = parsed.data.slice(prefix.length).split(".");
  if (segments.length !== 5) invalid();
  const [version, expiry, nonce, digest, suppliedMac] = segments as [
    string, string, string, string, string,
  ];
  if (version !== "v1") invalid();
  const expiresAtMs = Number.parseInt(expiry, 36);
  const nowMs = finiteNow(now).getTime();
  const accessExpiresAtMs = Date.parse(principal.expiresAt);
  if (
    !Number.isSafeInteger(expiresAtMs)
    || !Number.isFinite(accessExpiresAtMs)
    || expiresAtMs <= nowMs
    || expiresAtMs > nowMs + ttlMs
    || expiresAtMs > accessExpiresAtMs
  ) {
    invalid();
  }
  const unsigned = `${version}.${expiry}.${nonce}.${digest}`;
  const expectedMac = createHmac("sha256", secret)
    .update(`review-evidence-${kind}-token-v1\0${unsigned}`, "utf8")
    .digest();
  const receivedMac = Buffer.from(suppliedMac, "hex");
  if (
    receivedMac.byteLength !== expectedMac.byteLength
    || !timingSafeEqual(receivedMac, expectedMac)
  ) {
    invalid();
  }
  const expectedDigest = Buffer.from(
    bindingDigest(kind, binding, principal, expiresAtMs),
    "hex",
  );
  const receivedDigest = Buffer.from(digest, "hex");
  if (
    receivedDigest.byteLength !== expectedDigest.byteLength
    || !timingSafeEqual(receivedDigest, expectedDigest)
  ) {
    invalid();
  }
  return Object.freeze({
    expiresAt: new Date(expiresAtMs).toISOString(),
    token: parsed.data,
  });
}

export class ReviewEvidenceProofCodec {
  private readonly secret: Uint8Array;

  constructor(secret: string, private readonly now: () => Date = () => new Date()) {
    this.secret = decodeSecret(secret);
  }

  issue(
    binding: Readonly<ReviewEvidenceBinding>,
    principal: Readonly<ReviewPrincipal>,
  ): IssuedReviewEvidenceProof {
    const issued = issueToken(
      "proof",
      this.secret,
      this.now,
      REVIEW_EVIDENCE_PROOF_TTL_MS,
      binding,
      principal,
    );
    return Object.freeze({
      ...issued,
      proofSha256: proofHash(issued.token),
    });
  }

  verify(
    tokenInput: string,
    binding: Readonly<ReviewEvidenceBinding>,
    principal: Readonly<ReviewPrincipal>,
  ): IssuedReviewEvidenceProof {
    const verified = verifyToken(
      "proof",
      this.secret,
      this.now,
      REVIEW_EVIDENCE_PROOF_TTL_MS,
      tokenInput,
      binding,
      principal,
    );
    return Object.freeze({
      ...verified,
      proofSha256: proofHash(verified.token),
    });
  }
}

/**
 * Non-actionable delivery challenge. Its token namespace, binding digest, and
 * HMAC input are independent from approval proofs even when both use the same
 * review-only secret.
 */
export class ReviewEvidenceChallengeCodec {
  private readonly secret: Uint8Array;

  constructor(secret: string, private readonly now: () => Date = () => new Date()) {
    this.secret = decodeSecret(secret);
  }

  issue(
    binding: Readonly<ReviewEvidenceBinding>,
    principal: Readonly<ReviewPrincipal>,
  ): IssuedReviewEvidenceChallenge {
    return issueToken(
      "challenge",
      this.secret,
      this.now,
      REVIEW_EVIDENCE_CHALLENGE_TTL_MS,
      binding,
      principal,
    );
  }

  verify(
    tokenInput: string,
    binding: Readonly<ReviewEvidenceBinding>,
    principal: Readonly<ReviewPrincipal>,
  ): IssuedReviewEvidenceChallenge {
    return verifyToken(
      "challenge",
      this.secret,
      this.now,
      REVIEW_EVIDENCE_CHALLENGE_TTL_MS,
      tokenInput,
      binding,
      principal,
    );
  }
}
