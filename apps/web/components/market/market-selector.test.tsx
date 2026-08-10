// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarketSelector } from "./market-selector";

afterEach(cleanup);

describe("MarketSelector", () => {
  it("keeps national scope explicit and warns that it is not coverage proof", () => {
    render(<MarketSelector
      id="market"
      marketContext={{ contractVersion: 1, countryCode: "NO", kind: "national" }}
      onChange={() => undefined}
    />);
    expect(screen.getByLabelText("Prisområde")).toHaveValue("national");
    expect(screen.getByRole("status")).toHaveTextContent("betyr ikke at prisdekningen er landsdekkende");
  });

  it("emits only an allowlisted explicit region and shows candidate copy", () => {
    const onChange = vi.fn();
    const { rerender } = render(<MarketSelector
      id="market"
      marketContext={{ contractVersion: 1, countryCode: "NO", kind: "national" }}
      onChange={onChange}
    />);
    fireEvent.change(screen.getByLabelText("Prisområde"), {
      target: { value: "no-0301-oslo" },
    });
    expect(onChange).toHaveBeenCalledWith({
      contractVersion: 1,
      countryCode: "NO",
      kind: "launch-region",
      regionId: "no-0301-oslo",
    });
    rerender(<MarketSelector
      id="market"
      marketContext={{
        contractVersion: 1,
        countryCode: "NO",
        kind: "launch-region",
        regionId: "no-0301-oslo",
      }}
      onChange={onChange}
    />);
    expect(screen.getByRole("status")).toHaveTextContent("ikke lanseringsklar");
    expect(screen.getByRole("status")).toHaveTextContent("butikkspesifikke data holdes utenfor");
  });

  it("requires an explicit replacement when a stored market is no longer available", () => {
    const onChange = vi.fn();
    render(<MarketSelector id="market" marketContext={null} onChange={onChange} />);

    expect(screen.getByLabelText("Prisområde")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("Handlelisten er bevart");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Prisområde"), {
      target: { value: "national" },
    });
    expect(onChange).toHaveBeenCalledWith({
      contractVersion: 1,
      countryCode: "NO",
      kind: "national",
    });
  });
});
