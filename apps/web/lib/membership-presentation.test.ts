import type { MoneyOre, OfficialOffer } from "@handleplan/domain";
import { describe, expect, it } from "vitest";

import {
  membershipPreferencePresentations,
  membershipRequirementCopy,
} from "./membership-presentation";

function offer(
  id: string,
  chainId: string,
  programId: string,
): OfficialOffer {
  return {
    applicability: {
      channels: ["in-store"],
      contractVersion: 1,
      endsAt: "2026-07-18T00:00:00.000Z",
      geographicScope: { countryCode: "NO", kind: "national" },
      startsAt: "2026-07-14T00:00:00.000Z",
    },
    capturedAt: "2026-07-17T00:00:00.000Z",
    chainId,
    conditions: [{ kind: "member", programId }],
    contractVersion: 1,
    evidenceLevel: "reviewed",
    id,
    kind: "official-offer",
    pricing: { kind: "unit", unitPriceOre: 2_000 as MoneyOre },
    productMatch: { canonicalProductId: `product:${id}`, kind: "exact" },
    sourceId: "verified-source",
    sourceRecordId: `source-record:${id}`,
  };
}

describe("customer membership presentation", () => {
  it("derives available choices from chain evidence without exposing opaque IDs", () => {
    const opaque = "opaque-eligibility-key";
    const [presentation] = membershipPreferencePresentations([
      offer("offer:one", "extra", opaque),
      offer("offer:two", "rema-1000", opaque),
    ], []);

    expect(presentation).toMatchObject({
      available: true,
      label: "Medlemspriser hos Extra og REMA 1000",
    });
    expect(`${presentation?.label} ${presentation?.detail}`).not.toContain(opaque);
    expect(membershipRequirementCopy(["extra", "rema-1000"]))
      .toBe("Medlemspriser hos Extra og REMA 1000 krever medlemskap.");
  });

  it("keeps a saved unknown choice removable behind a neutral non-ID label", () => {
    const opaque = "saved-opaque-eligibility-key";
    const [presentation] = membershipPreferencePresentations([], [opaque]);

    expect(presentation).toEqual({
      available: false,
      detail: "Ingen verifiserte medlemstilbud er tilgjengelige nå. Du kan fjerne valget.",
      label: "Lagret medlemsvalg uten aktivt tilbud",
      programId: opaque,
    });
    expect(`${presentation?.label} ${presentation?.detail}`).not.toContain(opaque);
  });

  it("uses neutral ordinals when two opaque programs share the same chain context", () => {
    const presentations = membershipPreferencePresentations([
      offer("offer:one", "extra", "internal-a"),
      offer("offer:two", "extra", "internal-b"),
    ], []);

    expect(presentations.map(({ label }) => label)).toEqual([
      "Medlemspris hos Extra – valg 1",
      "Medlemspris hos Extra – valg 2",
    ]);
    expect(presentations.map(({ label }) => label).join(" ")).not.toMatch(/internal-[ab]/u);
  });
});
