import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

describe("result route metadata", () => {
  it("identifies the result workspace in the browser title", () => {
    expect(metadata.title).toBe("Resultat | Handleplan");
  });
});
