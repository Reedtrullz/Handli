import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const controlledRoutes = [
  ["../../app/api/discovery/impact/route.ts", "discovery-impact"],
  ["../../app/api/discovery/search/route.ts", "discovery-search"],
  ["../../app/api/locations/current/route.ts", "locations-current"],
  ["../../app/api/locations/search/route.ts", "locations-search"],
  ["../../app/api/plan-candidates/route.ts", "plan-candidates"],
  ["../../app/api/plans/route.ts", "plans"],
  ["../../app/api/plans/travel/route.ts", "plans-travel"],
  ["../../app/api/products/search/route.ts", "products-search"],
  ["../../app/api/source-status/route.ts", "source-status"],
] as const;

describe("production public API control wiring", () => {
  it.each(controlledRoutes)("binds %s to fixed route key %s", (path, routeKey) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toContain(`"${routeKey}"`);
    expect(source).toContain("container.publicApiRuntimeControls");
    expect(source).toContain("publicApiRuntimeControlResponse");
    expect(source).not.toMatch(/request\.headers\.get\(["'](?:x-forwarded-for|user-agent)/iu);
  });

  it("coalesces location provider lookup before minting per-caller tokens", () => {
    const source = readFileSync(
      new URL("./travel/location-search-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('"location-geocoder"');
    expect(source.indexOf("geocoderCoalescer.run")).toBeLessThan(
      source.indexOf("choices.issueMany"),
    );
  });
});
