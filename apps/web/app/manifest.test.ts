import { describe, expect, it } from "vitest";

import manifest from "./manifest";

describe("Handleplan web app manifest", () => {
  it("opens the local-only Handlemodus shell without query or provider state", () => {
    const value = manifest();
    expect(value).toMatchObject({
      display: "standalone",
      lang: "nb-NO",
      scope: "/",
      start_url: "/planlegg/handle",
    });
    expect(String(value.start_url)).not.toContain("?");
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "maskable", src: "/icons/handleplan-maskable.svg" }),
    ]));
  });
});
