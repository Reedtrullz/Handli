import { describe, expect, it, vi } from "vitest";
import { officialOfferEditionDiscoveryInputV1Schema, syntheticAuthorizedLocalEdition } from "@handleplan/domain";
import { createTjekHandlers, TJEK_JOB_KIND } from "./tjek-handlers";
const catalog = { id: "edition", dealer_id: "5b11sm", chainId: "bunnpris", type: "incito" } as never;
const edition = officialOfferEditionDiscoveryInputV1Schema.parse({ ...syntheticAuthorizedLocalEdition, sourceId: "tjek", externalEditionId: "edition", chain: "bunnpris" });
function setup() {
  const recordEdition = vi.fn(async () => ({ id: 1 }));
  const recordCapture = vi.fn(async () => ({ id: 2, retrievedAt: "2026-07-17T08:00:00.000Z" }));
  const recordExtraction = vi.fn(async () => ({ id: 3, status: "completed" as const, counts: { total: 1, exactMatch: 0, reviewRequired: 1, rejected: 0 } }));
  const putIfAbsent = vi.fn(async (write: any) => ({ contractVersion: 1, state: "stored", checksumSha256: write.checksumSha256, byteLength: write.byteLength }));
  const client = { getAllLatestCatalogs: vi.fn(async () => [catalog]), canExtractOffers: vi.fn(() => true), getOffersFromCatalog: vi.fn(async () => [{ id: "offer", name: "Milk", price: 20, before_price: null, run_from: edition.validFrom, run_till: edition.validUntil }]) };
  const foundation = { isCaptureComplete: vi.fn(async (): Promise<"completed" | "degraded" | undefined> => undefined), repository: { recordEdition, recordCapture, recordExtraction }, privateBlobStore: { putIfAbsent }, resolveEdition: vi.fn(async () => edition), sourceAccessPolicy: { getDecision: vi.fn(async (_: string, __: string, asOf: string) => ({ contractVersion: 1, permissionId: 1, sourceId: "tjek", decision: "approved", capabilities: ["capture", "discover", "extract"], rightsClassifications: ["public_display"], reviewedAt: "2026-07-01T00:00:00.000Z", evaluatedAt: asOf })) } };
  const handler = createTjekHandlers({ client: client as never, foundation, clock: () => new Date("2026-07-17T08:00:00.000Z") })[TJEK_JOB_KIND]!;
  const run = () => handler({ signal: new AbortController().signal } as never);
  return { run, client, foundation, recordEdition, recordCapture, recordExtraction, putIfAbsent };
}
describe("Tjek foundation ingestion", () => {
  it("stores evidence and only unresolved review candidates", async () => {
    const t = setup();
    expect((await t.run())?.counters).toMatchObject({ accepted: 0, persisted: 1, failed: 0 });
    expect(t.putIfAbsent).toHaveBeenCalledOnce();
    const envelope = t.recordExtraction.mock.calls[0] as unknown as [number, { candidates: any[] }];
    expect(envelope[1].candidates[0].product).toEqual({ kind: "unresolved-label", label: "Milk" });
  });
  it("reports failed writes and retries partially recorded editions", async () => {
    const t = setup();
    t.recordCapture.mockRejectedValueOnce(new Error("permission denied"));
    expect((await t.run())?.counters).toMatchObject({ failed: 1, persisted: 0 });
    expect((await t.run())?.counters).toMatchObject({ failed: 0, persisted: 1 });
    expect(t.recordEdition).toHaveBeenCalledTimes(2);
  });
  it("does not turn unsupported catalogs into confirmed empty", async () => {
    const t = setup(); t.client.canExtractOffers.mockReturnValue(false);
    expect((await t.run())?.counters).toMatchObject({ failed: 1, persisted: 0 });
    expect(t.recordExtraction).not.toHaveBeenCalled();
  });
  it("skips only a verified complete capture and checks authorization before discovery", async () => {
    const t = setup(); t.foundation.isCaptureComplete.mockResolvedValue("completed");
    expect((await t.run())?.counters).toMatchObject({ failed: 0, persisted: 0 });
    expect(t.recordEdition).not.toHaveBeenCalled();
    t.foundation.sourceAccessPolicy.getDecision.mockRejectedValue(new Error("revoked"));
    await expect(t.run()).rejects.toThrow("revoked");
    expect(t.client.getAllLatestCatalogs).toHaveBeenCalledOnce();
  });
  it("fails closed without reviewed scope", async () => {
    const t = setup(); t.foundation.resolveEdition.mockRejectedValue(new Error("scope unavailable"));
    expect((await t.run())?.counters).toMatchObject({ failed: 1 });
    expect(t.putIfAbsent).not.toHaveBeenCalled();
  });
});
