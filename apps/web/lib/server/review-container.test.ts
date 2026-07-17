import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createReviewServerContainer } from "./review-container";
import { ReviewServiceError } from "./review-service";

describe("private review container", () => {
  it("keeps fake review state empty and unavailable outside production", async () => {
    const container = createReviewServerContainer({ mode: "fake" });
    await expect(container.reviewService.list({ contractVersion: 1, limit: 25 }))
      .resolves.toEqual({ contractVersion: 1, items: [] });
    await expect(container.reviewService.get("review-candidate:1"))
      .rejects.toEqual(new ReviewServiceError("NOT_FOUND"));
  });
});
