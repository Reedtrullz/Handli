// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import PrivacyPage from "./page";

afterEach(cleanup);

describe("Norwegian privacy notice", () => {
  it("states local/server processing and the origin non-retention rule", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("heading", { name: "Personvern i Handleplan" })).toBeVisible();
    expect(screen.getByText(/handlelisten.*lokale lagring/i)).toBeVisible();
    expect(screen.getByText(/søketekst.*sendes til serveren/i)).toBeVisible();
    expect(screen.getByText(/aldri lagres.*logger.*sikkerhetskopi/i)).toBeVisible();
    expect(screen.getByText(/kassalapp-kall.*bakgrunnsjobber/i)).toBeVisible();
  });

  it("does not invent a controller, provider, legal basis, or contact", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/juridisk operatør og behandlingsansvarlig.*ikke.*fastsatt/i))
      .toBeVisible();
    expect(screen.getByText(/geokoder.*rutetjeneste.*ikke valgt og godkjent/i)).toBeVisible();
    expect(screen.getByText(/offentlig lansering er blokkert/i)).toBeVisible();
    expect(screen.queryByRole("link", { name: /send personvernkrav/i })).not.toBeInTheDocument();
  });

  it("links to the full inventory and public status", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("link", { name: "Full norsk personvernerklæring" }))
      .toHaveAttribute(
        "href",
        "https://github.com/Reedtrullz/Handli/blob/main/docs/privacy/personvern.md",
      );
    expect(screen.getByRole("link", { name: "Dataflyt og trusselmodell" }))
      .toHaveAttribute(
        "href",
        "https://github.com/Reedtrullz/Handli/blob/main/docs/security/data-flow-threat-model.md",
      );
    expect(screen.getByRole("link", { name: /gjeldende datadekning/i }))
      .toHaveAttribute("href", "/status");
  });
});
