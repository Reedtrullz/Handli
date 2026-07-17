import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../../components/operations/operations-workspace", () => ({
  OperationsWorkspace: () => <main data-testid="operations-workspace" />,
}));

import OperationsPage, { dynamic, metadata, revalidate } from "./page";

describe("internal operations page shell", () => {
  it("is dynamic, non-indexable, and links only private drift plus public status", () => {
    const html = renderToStaticMarkup(<OperationsPage />);
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
    expect(metadata.robots).toEqual({ follow: false, index: false });
    expect(html).toContain('href="/internal/operations"');
    expect(html).toContain('href="/status"');
    expect(html).not.toContain('href="/review"');
    expect(html).toContain("data-testid=\"operations-workspace\"");
  });
});
