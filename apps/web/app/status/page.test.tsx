// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import StatusPage from "./page";

afterEach(cleanup);

describe("public coverage status", () => {
  it("shows all candidate regions and chains without implying launch eligibility", () => {
    render(<StatusPage />);

    expect(screen.getByRole("heading", { name: "Datadekning og status" })).toBeVisible();
    expect(screen.getByText(/ingen region er lanseringsklar/i)).toBeVisible();
    expect(screen.queryByText(/alle priser er dekket/i)).not.toBeInTheDocument();
    for (const region of ["Oslo", "Bergen", "Trondheim"]) {
      const section = screen.getByRole("region", { name: region });
      for (const chain of ["Bunnpris", "REMA 1000", "Extra"]) {
        expect(within(section).getByText(chain)).toBeVisible();
      }
      expect(within(section).getByText(/0 av 6 dataløp er lanseringsklare/i)).toBeVisible();
    }
  });

  it("publishes the manifest version, review date, blockers, and protected-alpha boundary", () => {
    render(<StatusPage />);

    expect(screen.getByText("Manifest")).toBeVisible();
    expect(screen.getByText("1.0.0")).toBeVisible();
    expect(screen.getByText(/16\. juli 2026/)).toBeVisible();
    expect(screen.getByText(/Kassalapp.*rettigheter/i)).toBeVisible();
    expect(screen.getByText(/beskyttet alfa/i)).toBeVisible();
  });
});
