import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { expectNoHorizontalOverflow } from "./accessibility-evidence";

describe("accessibility reflow evidence helper", () => {
  it("rejects off-canvas content even when the root scroll width still fits", async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        activeAncestors: [],
        activeElement: undefined,
        clientWidth: 320,
        innerWidth: 320,
        offenders: [{
          className: "synthetic-negative-position",
          left: -40,
          right: 40,
          tagName: "DIV",
          text: "Visible content lost outside the viewport",
          width: 80,
        }],
        scrollWidth: 320,
        scrollX: 0,
      })),
    } as unknown as Page;

    await expect(expectNoHorizontalOverflow(page)).rejects.toThrow();
    expect(page.evaluate).toHaveBeenCalledOnce();
  });
});
