import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("result workspace responsive contract", () => {
  it("defines stable desktop, tablet, and 320px mobile structures", () => {
    const css = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.result-grid\s*\{[^}]*grid-template-columns:[^}]*380px/s);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*\.result-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.result-store-row\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.result-rail\s*\{[^}]*order:\s*-1/);
    expect(css).toMatch(/width:\s*calc\(100% - 32px\)/);
  });
});
