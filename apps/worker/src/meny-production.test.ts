import { describe, expect, it, vi } from "vitest";
import { createMenyFoundationDependencies, parseMenyValidityHeadline } from "./meny-production";
import { createMenyHandlers, MENY_JOB_KIND } from "./meny-handlers";
import { WorkerRunner } from "./runner";
import { MENY_LAYOUT_FINGERPRINT } from "./meny-offers";
import { officialOfferEditionDiscoveryInputV1Schema } from "@handleplan/domain";

const HEADLINE = "MANDAG 21. SEPTEMBER - L\u00d8RDAG 26. SEPTEMBER UKE 39, 2026";
function viewerHtml(pageTexts: string[]): string {
  return '<html><script>window.staticSettings=' + JSON.stringify({ paperId: 3060440, licenseId: 9445, name: "Uke 39 mandag", pageTexts }) + ';</script></html>';
}
const html = viewerHtml([HEADLINE, "UKENS TILBUD FERSK KYLLINGFILET 99 00 / PK 700G F\u00d8RPRIS 139,00"]);
const permissions = { officialOffers: true, officialOfferCapabilities: ["capture", "discover", "extract"], officialOfferRightsClassifications: ["public_display"] };

describe("parseMenyValidityHeadline", () => {
  it("parses the qualified front-page headline", () => {
    expect(parseMenyValidityHeadline(HEADLINE)).toEqual({ validFrom: "2026-09-21T00:00:00.000Z", validUntil: "2026-09-27T00:00:00.000Z" });
  });
  it("fails closed on missing, single-date or garbage headlines", () => {
    expect(parseMenyValidityHeadline("INGEN DATOER HER")).toBeUndefined();
    expect(parseMenyValidityHeadline("MANDAG 21. SEPTEMBER UKE 39, 2026")).toBeUndefined();
    expect(parseMenyValidityHeadline("")).toBeUndefined();
  });
});

describe("Meny edition discovery", () => {
  it("resolves national NO scope and preserves the exact permission timestamp", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ runtime_state: "approved", permission_current: true, source_permission_current: true, permission_decision: "approved", permissions }])
      .mockResolvedValueOnce([{ id: 7, reviewed_at_exact: "2026-07-01T00:00:00.123456Z", valid_until_exact: null, permissions }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 88 }]);
    const deps = createMenyFoundationDependencies({ $client: query } as never, "/tmp/meny-unused-test-blobs");
    const edition = await deps.resolveEdition(html, new AbortController().signal);
    expect(edition).toMatchObject({ sourceId: "meny", externalEditionId: "3060440", chain: "meny", contentKind: "publication", declaredGeographicScope: { kind: "national", countryCode: "NO" }, geographicScopeId: 88, validFrom: "2026-09-21T00:00:00.000Z", validUntil: "2026-09-27T00:00:00.000Z" });
    expect(edition.authorization.reviewedAt).toBe("2026-07-01T00:00:00.123456Z");
  });

  it("rejects an unreadable validity headline", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ runtime_state: "approved", permission_current: true, source_permission_current: true, permission_decision: "approved", permissions }])
      .mockResolvedValueOnce([{ id: 7, reviewed_at_exact: "2026-07-01T00:00:00.123456Z", valid_until_exact: null, permissions }])
      .mockResolvedValueOnce([]);
    const deps = createMenyFoundationDependencies({ $client: query } as never, "/tmp/meny-unused-test-blobs");
    await expect(deps.resolveEdition(viewerHtml(["INGEN TILBUD"]), new AbortController().signal)).rejects.toThrow("MENY_VALIDITY_UNREADABLE");
  });

  it("rejects a legacy publication whose stored edition identity is incompatible", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ runtime_state: "approved", permission_current: true, source_permission_current: true, permission_decision: "approved", permissions }])
      .mockResolvedValueOnce([{ id: 7, reviewed_at_exact: "2026-07-01T00:00:00.123456Z", valid_until_exact: null, permissions }])
      .mockResolvedValueOnce([{ title: "Uke 39 mandag", content_kind: "publication", chain: "meny", geographic_scope_id: 88, declared_geographic_scope: { kind: "national", countryCode: "NO" }, valid_from: new Date("2026-09-21T00:00:00.000Z"), valid_until: new Date("2026-09-27T00:00:00.000Z"), discovered_at: new Date("2026-09-22T00:00:00.000Z"), edition_identity_sha256: "0".repeat(64) }]);
    const deps = createMenyFoundationDependencies({ $client: query } as never, "/tmp/meny-unused-test-blobs");
    await expect(deps.resolveEdition(html, new AbortController().signal)).rejects.toThrow("MENY_EDITION_CONFLICT");
  });

  it("fails closed without a single active national scope row", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ runtime_state: "approved", permission_current: true, source_permission_current: true, permission_decision: "approved", permissions }])
      .mockResolvedValueOnce([{ id: 7, reviewed_at_exact: "2026-07-01T00:00:00.123456Z", valid_until_exact: null, permissions }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 88 }, { id: 89 }]);
    const deps = createMenyFoundationDependencies({ $client: query } as never, "/tmp/meny-unused-test-blobs");
    await expect(deps.resolveEdition(html, new AbortController().signal)).rejects.toThrow("MENY_REVIEWED_SCOPE_UNAVAILABLE");
  });
});

describe("Meny ingestion handler", () => {
  function handlerSetup(viewer = html) {
    const recordEdition = vi.fn(async () => ({ id: 1 }));
    const recordCapture = vi.fn(async () => ({ id: 2, retrievedAt: "2026-09-22T08:00:00.000Z" }));
    const recordExtraction = vi.fn(async () => ({ id: 3, status: "completed" as "completed" | "degraded" | "failed", counts: { total: 1, exactMatch: 0, reviewRequired: 1, rejected: 0 } }));
    const putIfAbsent = vi.fn(async (write: any) => ({ contractVersion: 1, state: "stored", checksumSha256: write.checksumSha256, byteLength: write.byteLength }));
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse({
      contractVersion: 1, sourceId: "meny", externalEditionId: "3060440", chain: "meny", title: "Uke 39 mandag",
      contentKind: "publication", geographicScopeId: 88, declaredGeographicScope: { kind: "national", countryCode: "NO" },
      validFrom: "2026-09-21T00:00:00.000Z", validUntil: "2026-09-27T00:00:00.000Z",
      discoveredAt: "2026-09-22T00:00:00.000Z",
      authorization: { decision: "approved", capabilities: ["capture", "discover", "extract"], reviewedAt: "2026-09-01T00:00:00.000Z" },
    });
    const foundation = {
      isCaptureComplete: vi.fn(async (): Promise<"completed" | "degraded" | undefined> => undefined),
      repository: { recordEdition, recordCapture, recordExtraction },
      privateBlobStore: { putIfAbsent },
      resolveEdition: vi.fn(async () => edition),
      sourceAccessPolicy: { getDecision: vi.fn(async (_sourceId: string, _capability: string, asOf: string) => ({ contractVersion: 1, permissionId: 1, sourceId: "meny", decision: "approved", capabilities: ["capture", "discover", "extract"], rightsClassifications: ["public_display"], reviewedAt: "2026-09-01T00:00:00.000Z", evaluatedAt: asOf })) },
    };
    const handler = createMenyHandlers({ foundation, fetchViewerHtml: vi.fn(async () => viewer), clock: () => new Date("2026-09-22T08:00:00.000Z") })[MENY_JOB_KIND]!;
    const run = () => handler({ signal: new AbortController().signal } as never);
    const runWorker = () => new WorkerRunner({
      createRunId: () => "meny-counter-test",
      handlers: { [MENY_JOB_KIND]: handler },
      now: () => new Date("2026-09-22T08:00:00.000Z"),
    }).run({
      contractVersion: 1, jobId: "meny-counter-test", kind: MENY_JOB_KIND,
      requestedAt: "2026-09-22T08:00:00.000Z", sourceId: "meny", timeoutMs: 5_000,
    }, { fenceToken: "meny-counter-test-fence" });
    return { run, runWorker, foundation, recordEdition, recordCapture, recordExtraction, putIfAbsent };
  }

  it.each(["completed", "degraded"] as const)("accounts for multiple candidates in a %s extraction", async (status) => {
    const t = handlerSetup(viewerHtml([HEADLINE,
      "UKENS TILBUD FERSK KYLLINGFILET 99 00 / PK 700G FØRPRIS 139,00",
      "UKENS TILBUD NORSKE EPLER 39 00 / PK 1KG FØRPRIS 59,00",
    ]));
    t.recordExtraction.mockResolvedValue({ id: 3, status, counts: { total: 2, exactMatch: 0, reviewRequired: 2, rejected: 0 } });
    expect(await t.runWorker()).toMatchObject({
      status: status === "completed" ? "succeeded" : "partial",
      counters: { fetched: 2, persisted: 2, quarantined: 2, accepted: 0, unknown: 0, failed: status === "completed" ? 0 : 1 },
    });
    const envelope = t.recordExtraction.mock.calls[0] as unknown as [number, { candidates: unknown[] }];
    expect(envelope[1].candidates).toHaveLength(2);
  });

  it.each(["completed", "degraded"] as const)("accounts for an idempotent %s capture without repeating writes", async (status) => {
    const t = handlerSetup();
    t.foundation.isCaptureComplete.mockResolvedValue(status);
    expect(await t.runWorker()).toMatchObject({
      status: status === "completed" ? "succeeded" : "failed",
      counters: { fetched: 0, persisted: 0, quarantined: 0, accepted: 0, unknown: 0, failed: status === "completed" ? 0 : 1 },
    });
    expect(t.recordEdition).not.toHaveBeenCalled();
    expect(t.putIfAbsent).not.toHaveBeenCalled();
    expect(t.recordExtraction).not.toHaveBeenCalled();
  });

  it("preserves degradation when extraction finds no candidates", async () => {
    const t = handlerSetup(viewerHtml([HEADLINE]));
    t.recordExtraction.mockResolvedValue({ id: 3, status: "degraded", counts: { total: 0, exactMatch: 0, reviewRequired: 0, rejected: 0 } });
    expect(await t.runWorker()).toMatchObject({ status: "failed", counters: { fetched: 0, persisted: 0, quarantined: 0, accepted: 0, unknown: 0, failed: 1 } });
    expect(t.recordExtraction).toHaveBeenCalledOnce();
  });

  it("stores evidence and only review candidates", async () => {
    const t = handlerSetup();
    expect((await t.run())?.counters).toMatchObject({ fetched: 1, persisted: 1, failed: 0 });
    expect(t.putIfAbsent).toHaveBeenCalledOnce();
    const envelope = t.recordExtraction.mock.calls[0] as unknown as [number, { candidates: any[] }];
    expect(envelope[1].candidates[0].product).toEqual({ kind: "unresolved-label", label: "FERSK KYLLINGFILET" });
  });

  it("skips a verified complete capture and checks authorization before fetching", async () => {
    const t = handlerSetup();
    t.foundation.isCaptureComplete.mockResolvedValue("completed");
    expect((await t.run())?.counters).toMatchObject({ failed: 0, persisted: 0 });
    expect(t.recordEdition).not.toHaveBeenCalled();
    t.foundation.sourceAccessPolicy.getDecision.mockRejectedValue(new Error("revoked"));
    await expect(t.run()).rejects.toThrow("revoked");
  });

  it("reports failed writes and retries partially recorded editions", async () => {
    const t = handlerSetup();
    t.recordCapture.mockRejectedValueOnce(new Error("permission denied"));
    expect((await t.run())?.counters).toMatchObject({ failed: 1, fetched: 0, persisted: 0 });
    expect((await t.run())?.counters).toMatchObject({ failed: 0, persisted: 1 });
    expect(t.recordEdition).toHaveBeenCalledTimes(2);
  });
});
