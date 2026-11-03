import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { PublicCatalogDiscoveryPosition } from "@handleplan/db/public-catalog-index-reader";
import { isValidGtin, publicDiscoveryCursorSchema, type PublicDiscoveryRequestV1 } from "@handleplan/domain";
import { z } from "zod";

const PREFIX = "discovery-cursor:v1:";
const TTL_MS = 5 * 60_000;
// Process-local rotation deliberately invalidates cursors on restart or a different replica.
const key = randomBytes(32);
const payloadSchema = z.object({
  at: z.string(),
  gtin: z.string().refine(isValidGtin),
  rank: z.number().int().min(0).max(4),
  scopeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sortName: z.string().min(1).max(500),
  version: z.literal(2),
}).strict();
const envelopeSchema = payloadSchema.extend({ mac: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

function scopeSha256(request: PublicDiscoveryRequestV1): string {
  return createHash("sha256").update(JSON.stringify({
    categoryId: request.categoryId,
    chain: request.chain,
    contractVersion: request.contractVersion,
    marketContext: request.marketContext,
    pageSize: request.pageSize,
    policy: "current-eligibility-keyset-v2",
    query: request.query,
    resultType: request.resultType,
  })).digest("hex");
}

function macFor(payload: z.infer<typeof payloadSchema>): Buffer {
  return createHmac("sha256", key).update(`${PREFIX}${JSON.stringify(payload)}`).digest();
}

/** Live keyset: unchanged eligible identities/order paginate once; catalog changes require a new search. */
export function discoveryCursor(request: PublicDiscoveryRequestV1, now: Date): {
  readonly position?: PublicCatalogDiscoveryPosition;
  readonly encode: (position: PublicCatalogDiscoveryPosition) => string;
} | undefined {
  let issuedAt = now;
  let position: PublicCatalogDiscoveryPosition | undefined;
  if (request.cursor !== undefined) {
    if (!publicDiscoveryCursorSchema.safeParse(request.cursor).success) return undefined;
    const encoded = request.cursor.slice(PREFIX.length);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.byteLength > 1_100) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return undefined;
    }
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { mac, ...payload } = parsed.data;
    if (!timingSafeEqual(Buffer.from(mac, "hex"), macFor(payload))) return undefined;
    issuedAt = new Date(payload.at);
    const age = now.getTime() - issuedAt.getTime();
    if (!Number.isFinite(age) || age < 0 || age >= TTL_MS
      || issuedAt.toISOString() !== payload.at
      || payload.scopeSha256 !== scopeSha256(request)) return undefined;
    position = { gtin: payload.gtin, rank: payload.rank, sortName: payload.sortName };
  }
  return {
    ...(position === undefined ? {} : { position }),
    encode: (nextPosition) => {
      const payload = payloadSchema.parse({
        at: issuedAt.toISOString(),
        gtin: nextPosition.gtin,
        rank: nextPosition.rank,
        scopeSha256: scopeSha256(request),
        sortName: nextPosition.sortName,
        version: 2,
      });
      const encoded = Buffer.from(JSON.stringify({ ...payload, mac: macFor(payload).toString("hex") })).toString("base64url");
      return publicDiscoveryCursorSchema.parse(`${PREFIX}${encoded}`);
    },
  };
}
