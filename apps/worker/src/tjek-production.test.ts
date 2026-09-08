import { describe, expect, it, vi } from "vitest";
import { createTjekFoundationDependencies } from "./tjek-production";
const catalog = { id: "edition", dealer_id: "5b11sm", publication_date: "2026-09-08", run_from: "2026-09-07T00:00:00.000Z", run_till: "2026-09-14T00:00:00.000Z", all_stores: true, dealer: { country: { id: "NO" }, markets: [{ country_code: "NO" }] } } as never;
function factory(existing: unknown[] = []) {
  const permissions = { officialOffers: true, officialOfferCapabilities: ["capture", "discover", "extract"], officialOfferRightsClassifications: ["public_display"] };
  const query = vi.fn().mockResolvedValueOnce([{ runtime_state: "approved", permission_current: true, source_permission_current: true, permission_decision: "approved", permissions }])
    .mockResolvedValueOnce([{ id: 7, reviewed_at: new Date("2026-01-01"), valid_until: null, permissions }])
    .mockResolvedValueOnce(existing).mockResolvedValueOnce([{ id: 88 }]);
  return { value: createTjekFoundationDependencies({ $client: query } as never, "/tmp/tjek-unused-test-blobs"), query };
}
describe("Tjek geographic evidence", () => {
  it("uses explicit all-store Norway evidence and looks up the scope ID", async () => {
    const t = factory();
    expect(await t.value.resolveEdition(catalog, new AbortController().signal)).toMatchObject({ geographicScopeId: 88, declaredGeographicScope: { kind: "national", countryCode: "NO" } });
  });
  it("rejects missing provider scope even when a legacy publication exists", async () => {
    const t = factory([{ geographic_scope_id: 1, declared_geographic_scope: { kind: "national", countryCode: "NO" } }]);
    await expect(t.value.resolveEdition({ ...(catalog as object), all_stores: false } as never, new AbortController().signal)).rejects.toThrow("TJEK_REVIEWED_SCOPE_UNAVAILABLE");
  });
});
