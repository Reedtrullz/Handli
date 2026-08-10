import { describe, expect, it } from "vitest";

import ReviewPage, { metadata } from "./page";

describe("private review page boundary", () => {
  it("renders only after the actual-request proxy boundary has continued", () => {
    const page = ReviewPage();

    expect(page.type).toBe("div");
    expect(metadata.robots).toEqual({ follow: false, index: false });
  });
});
