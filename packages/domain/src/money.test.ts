import { describe, expect, it } from "vitest";

import { formatNok } from "./index";

describe("formatNok", () => {
  it("formats integer ore as Norwegian kroner with stable spaces", () => {
    expect(formatNok(82460)).toBe("824,60 kr");
  });
});
