// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AboutPage from "./page";

describe("public-good commitments", () => {
  it("states the ranking, funding, privacy, and correction commitments", () => {
    render(<AboutPage />);

    expect(screen.getByRole("heading", { name: "Handleplan som et offentlig gode" })).toBeVisible();
    expect(screen.getByText(/ingen betalt rangering/i)).toBeVisible();
    expect(screen.getByText(/komplett handlekurv/i)).toBeVisible();
    expect(screen.getByText(/posisjonen din lagres ikke/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /meld en feil/i })).toHaveAttribute(
      "href",
      "https://github.com/Reedtrullz/Handli/issues/new",
    );
    expect(screen.queryByText(/kodeLisens/i)).not.toBeInTheDocument();
  });
});
