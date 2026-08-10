import "server-only";

import { createHash } from "node:crypto";

import { canonicalizeReviewedFamilyCandidateSetFingerprintInput } from "@handleplan/domain";

export type CandidateSetFingerprintInput = Parameters<
  typeof canonicalizeReviewedFamilyCandidateSetFingerprintInput
>[0];

/**
 * Creates the public confirmation ID from the domain-owned canonical UTF-8
 * fingerprint. Presentation fields and retrieval timestamps are deliberately
 * excluded by that canonical contract.
 */
export function createCandidateSetId(
  input: CandidateSetFingerprintInput,
): `candidate-set:${string}` {
  const canonical = canonicalizeReviewedFamilyCandidateSetFingerprintInput(input);
  const digest = createHash("sha256")
    .update(new TextEncoder().encode(canonical))
    .digest("hex");
  return `candidate-set:${digest}`;
}
