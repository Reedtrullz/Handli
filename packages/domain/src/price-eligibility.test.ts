import { describe, expect, it } from "vitest";

import { classifyFreshness } from "./index";

const hoursAgo = (now: Date, hours: number) =>
  new Date(now.getTime() - hours * 60 * 60 * 1_000);

const daysAgo = (now: Date, days: number) => hoursAgo(now, days * 24);

describe("classifyFreshness", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("keeps observations eligible through the inclusive 72-hour boundary", () => {
    expect(classifyFreshness(now, hoursAgo(now, 72))).toBe("eligible");
  });

  it("keeps observations over 72 hours visible but stale through 14 days", () => {
    expect(classifyFreshness(now, hoursAgo(now, 73))).toBe("stale-visible");
  });

  it("classifies observations over 14 days as historical", () => {
    expect(classifyFreshness(now, daysAgo(now, 15))).toBe("historical");
  });
});
