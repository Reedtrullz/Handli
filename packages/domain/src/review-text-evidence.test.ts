import { describe, expect, it } from "vitest";
import { decodeReviewTextEvidence, MAX_REVIEW_TEXT_EVIDENCE_BYTES } from "./review-contracts";

describe("private review text evidence", () => {
  it("decodes the complete source literally without interpreting HTML", () => {
    const source = '<!doctype html><html><script>alert("synthetic")</script>ÆØÅ</html>';
    expect(decodeReviewTextEvidence(new TextEncoder().encode(source))).toBe(source);
  });
  it("accepts the exact byte limit and rejects oversized, empty, NUL and malformed UTF-8", () => {
    expect(MAX_REVIEW_TEXT_EVIDENCE_BYTES).toBe(1024 * 1024);
    expect(
      decodeReviewTextEvidence(new Uint8Array(MAX_REVIEW_TEXT_EVIDENCE_BYTES).fill(65)),
    ).toHaveLength(MAX_REVIEW_TEXT_EVIDENCE_BYTES);
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(MAX_REVIEW_TEXT_EVIDENCE_BYTES + 1).fill(65),
      new Uint8Array([65, 0]),
      new Uint8Array([0xc3, 0x28]),
    ]) {
      expect(() => decodeReviewTextEvidence(bytes)).toThrow();
    }
  });
});
