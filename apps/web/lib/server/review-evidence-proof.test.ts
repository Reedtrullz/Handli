import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ReviewPrincipal } from "./review-access";
import {
  ReviewEvidenceChallengeCodec,
  ReviewEvidenceProofCodec,
  ReviewEvidenceProofError,
} from "./review-evidence-proof";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const SECRET = Buffer.alloc(32, 0x5a).toString("base64url");
const principal: ReviewPrincipal = {
  actorId: `access:${"a".repeat(64)}`,
  expiresAt: "2026-07-17T13:00:00.000Z",
  sessionId: `access-session:${"b".repeat(64)}`,
};
const binding = {
  candidateId: "review-candidate:42",
  candidateVersion: 0,
  checksumSha256: "c".repeat(64),
  cropReference: `review-crop:${"d".repeat(64)}`,
  presentation: "full_capture",
  rightsClassification: "private_review",
} as const;

function expectInvalid(callback: () => unknown): void {
  expect(callback).toThrow(ReviewEvidenceProofError);
}

describe("ReviewEvidenceProofCodec", () => {
  it("issues a short opaque proof bound to candidate, version, checksum, reference, rights, and session", () => {
    const codec = new ReviewEvidenceProofCodec(SECRET, () => NOW);
    const proof = codec.issue(binding, principal);

    expect(proof).toEqual({
      expiresAt: "2026-07-17T12:02:00.000Z",
      proofSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      token: expect.stringMatching(/^review-proof:v1\./u),
    });
    expect(proof.token).not.toContain(binding.candidateId);
    expect(proof.token).not.toContain(binding.checksumSha256);
    expect(codec.verify(proof.token, binding, principal)).toEqual(proof);
  });

  it("caps proof expiry at the current Access assertion expiry", () => {
    const shortSession = {
      ...principal,
      expiresAt: "2026-07-17T12:00:30.000Z",
    };
    const proof = new ReviewEvidenceProofCodec(SECRET, () => NOW).issue(binding, shortSession);
    expect(proof.expiresAt).toBe(shortSession.expiresAt);
  });

  it("rejects forged, stale, cross-candidate, cross-version, cross-capture, and cross-session proofs", () => {
    const issued = new ReviewEvidenceProofCodec(SECRET, () => NOW).issue(binding, principal);
    const verifier = new ReviewEvidenceProofCodec(SECRET, () => new Date(NOW.getTime() + 1_000));
    const tokenTail = issued.token.at(-1) === "0" ? "1" : "0";

    expectInvalid(() => verifier.verify(`${issued.token.slice(0, -1)}${tokenTail}`, binding, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, candidateId: "review-candidate:43" }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, candidateVersion: 1 }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, checksumSha256: "e".repeat(64) }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, cropReference: `review-crop:${"e".repeat(64)}` }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, rightsClassification: "public_display" }, principal));
    expectInvalid(() => verifier.verify(issued.token, binding, {
      ...principal,
      sessionId: `access-session:${"f".repeat(64)}`,
    }));
    expectInvalid(() => new ReviewEvidenceProofCodec(SECRET, () => new Date(
      Date.parse(issued.expiresAt),
    )).verify(issued.token, binding, principal));
  });

  it("requires a canonical independent secret with at least 256 bits", () => {
    expectInvalid(() => new ReviewEvidenceProofCodec("short"));
    expectInvalid(() => new ReviewEvidenceProofCodec(Buffer.alloc(31).toString("base64url")));
  });
});

describe("ReviewEvidenceChallengeCodec", () => {
  it("issues a short opaque non-proof challenge in an independent cryptographic domain", () => {
    const challengeCodec = new ReviewEvidenceChallengeCodec(SECRET, () => NOW);
    const challenge = challengeCodec.issue(binding, principal);

    expect(challenge).toEqual({
      expiresAt: "2026-07-17T12:02:00.000Z",
      token: expect.stringMatching(/^review-challenge:v1\./u),
    });
    expect(challenge.token).not.toContain(binding.candidateId);
    expect(challenge.token).not.toContain(binding.checksumSha256);
    expect(challengeCodec.verify(challenge.token, binding, principal)).toEqual(challenge);
    expectInvalid(() => new ReviewEvidenceProofCodec(SECRET, () => NOW)
      .verify(challenge.token, binding, principal));
  });

  it("rejects forged, stale, cross-candidate, cross-version, cross-capture, and cross-session challenges", () => {
    const issued = new ReviewEvidenceChallengeCodec(SECRET, () => NOW).issue(binding, principal);
    const verifier = new ReviewEvidenceChallengeCodec(
      SECRET,
      () => new Date(NOW.getTime() + 1_000),
    );
    const tokenTail = issued.token.at(-1) === "0" ? "1" : "0";

    expectInvalid(() => verifier.verify(`${issued.token.slice(0, -1)}${tokenTail}`, binding, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, candidateId: "review-candidate:43" }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, candidateVersion: 1 }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, checksumSha256: "e".repeat(64) }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, cropReference: `review-crop:${"e".repeat(64)}` }, principal));
    expectInvalid(() => verifier.verify(issued.token, { ...binding, rightsClassification: "public_display" }, principal));
    expectInvalid(() => verifier.verify(issued.token, binding, {
      ...principal,
      sessionId: `access-session:${"f".repeat(64)}`,
    }));
    expectInvalid(() => new ReviewEvidenceChallengeCodec(SECRET, () => new Date(
      Date.parse(issued.expiresAt),
    )).verify(issued.token, binding, principal));
  });
});
