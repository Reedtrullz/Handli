import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readReviewServerEnv } from "./review-env";

describe("readReviewServerEnv", () => {
  const proofSecret = Buffer.alloc(32, 0x42).toString("base64url");
  const captureRoot = "/var/lib/handleplan/private-captures";
  const databaseUrl = (username: string) => {
    const url = new URL("postgresql://postgres:5432/handleplan");
    url.username = username;
    url.password = "ci_review_url_safe_00000000000000001";
    return url.toString();
  };

  it("requires the dedicated least-privilege review role", () => {
    expect(readReviewServerEnv({
      HANDLEPLAN_REVIEW_MODE: "real",
      REVIEW_DATABASE_URL: databaseUrl("handleplan_review"),
      REVIEW_EVIDENCE_PROOF_SECRET: proofSecret,
      REVIEW_PRIVATE_CAPTURE_ROOT: captureRoot,
    })).toEqual({
      mode: "real",
      REVIEW_DATABASE_URL: databaseUrl("handleplan_review"),
      REVIEW_EVIDENCE_PROOF_SECRET: proofSecret,
      REVIEW_PRIVATE_CAPTURE_ROOT: captureRoot,
    });
    expect(() => readReviewServerEnv({
      REVIEW_DATABASE_URL: databaseUrl("handleplan_web"),
      REVIEW_EVIDENCE_PROOF_SECRET: proofSecret,
      REVIEW_PRIVATE_CAPTURE_ROOT: captureRoot,
    })).toThrow(/handleplan_review/u);
    expect(() => readReviewServerEnv({
      REVIEW_DATABASE_URL: databaseUrl("handleplan"),
      REVIEW_EVIDENCE_PROOF_SECRET: proofSecret,
      REVIEW_PRIVATE_CAPTURE_ROOT: captureRoot,
    })).toThrow(/handleplan_review/u);
  });

  it("requires a canonical private capture root and independent 256-bit proof secret", () => {
    expect(() => readReviewServerEnv({
      REVIEW_DATABASE_URL: databaseUrl("handleplan_review"),
      REVIEW_EVIDENCE_PROOF_SECRET: "too-short",
      REVIEW_PRIVATE_CAPTURE_ROOT: captureRoot,
    })).toThrow(/PROOF_SECRET/u);
    expect(() => readReviewServerEnv({
      REVIEW_DATABASE_URL: databaseUrl("handleplan_review"),
      REVIEW_EVIDENCE_PROOF_SECRET: proofSecret,
      REVIEW_PRIVATE_CAPTURE_ROOT: "relative/captures",
    })).toThrow(/CAPTURE_ROOT/u);
  });

  it("fails closed without real configuration and disables fake mode in production", () => {
    expect(() => readReviewServerEnv({})).toThrow();
    expect(readReviewServerEnv({ HANDLEPLAN_REVIEW_MODE: "fake", NODE_ENV: "test" }))
      .toEqual({ mode: "fake" });
    expect(() => readReviewServerEnv({
      HANDLEPLAN_REVIEW_MODE: "fake",
      NODE_ENV: "production",
    })).toThrow(/disabled/u);
    expect(() => readReviewServerEnv({ HANDLEPLAN_REVIEW_MODE: "preview" }))
      .toThrow(/real or fake/u);
  });
});
