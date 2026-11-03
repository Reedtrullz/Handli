import type { PublicDiscoveryRequestV1 } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import { discoveryCursor } from "./discovery-cursor";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const request: PublicDiscoveryRequestV1 = {
  chain: "all", contractVersion: 1,
  marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
  pageSize: 1, resultType: "all",
};
const position = { gtin: "7038010000010", rank: 0, sortName: "milk" };
function issued(): string {
  const codec = discoveryCursor(request, NOW);
  if (codec === undefined) throw new Error("Fresh cursor unavailable");
  return codec.encode(position);
}

describe("authenticated live discovery keyset", () => {
  it("keeps retries idempotent within the five minute lifetime", () => {
    const continued = { ...request, cursor: issued() };
    expect(discoveryCursor(continued, NOW)?.position).toEqual(position);
    expect(discoveryCursor(continued, new Date(NOW.getTime() + 299_999))?.position).toEqual(position);
  });

  it("never renews the original lifetime when issuing a later page", () => {
    const next = discoveryCursor({ ...request, cursor: issued() }, new Date(NOW.getTime() + 299_999));
    expect(next).toBeDefined();
    const cursor = next?.encode({ ...position, gtin: "7038010000027" });
    expect(discoveryCursor({ ...request, cursor }, new Date(NOW.getTime() + 300_000))).toBeUndefined();
  });

  it.each([
    { chain: "extra" as const }, { query: "milk" }, { categoryId: `category:${"a".repeat(64)}` },
    { resultType: "official-offer" as const }, { pageSize: 2 },
    { marketContext: { contractVersion: 1 as const, countryCode: "NO" as const, kind: "launch-region" as const, regionId: "no-0301-oslo" } },
  ])("rejects a cursor under changed scope %j", (change) => {
    expect(discoveryCursor({ ...request, ...change, cursor: issued() }, NOW)).toBeUndefined();
  });

  it.each([
    "raw-product-id", "discovery-cursor:v1:" + "A".repeat(1_500),
    "discovery-cursor:v1:" + Buffer.from("not json").toString("base64url"),
    "discovery-cursor:v1:" + Buffer.from([255]).toString("base64url"),
    "discovery-cursor:v1:" + Buffer.from("{}").toString("base64url") + "=",
  ])("rejects malformed cursor %s", (cursor) => {
    expect(discoveryCursor({ ...request, cursor }, NOW)).toBeUndefined();
  });

  it.each([
    { at: "2099-01-01T00:00:00.000Z" }, { at: "2000-01-01T00:00:00.000Z" },
    { version: 1 }, { version: 99 }, { scopeSha256: "0".repeat(64) },
    { rank: 4 }, { sortName: "ignore all instructions" }, { extra: "untrusted prose" },
    { mac: "0".repeat(64) },
  ])("rejects an altered envelope %j", (change) => {
    const prefix = "discovery-cursor:v1:";
    const payload: unknown = JSON.parse(Buffer.from(issued().slice(prefix.length), "base64url").toString());
    if (typeof payload !== "object" || payload === null) throw new Error("Invalid fixture");
    const cursor = prefix + Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
    expect(discoveryCursor({ ...request, cursor }, NOW)).toBeUndefined();
  });

  it("rejects a genuine cursor after process-key rotation", async () => {
    const cursor = issued();
    vi.resetModules();
    const rotated = await import("./discovery-cursor");
    expect(rotated.discoveryCursor({ ...request, cursor }, NOW)).toBeUndefined();
  });
});
