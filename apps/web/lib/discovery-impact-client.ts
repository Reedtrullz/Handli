import {
  discoveryImpactRequestV1Schema,
  discoveryImpactResponseV1SchemaFor,
  type DiscoveryImpactRequestV1,
  type DiscoveryImpactResponseV1,
} from "@handleplan/domain";

export const DISCOVERY_IMPACT_BODY_MAX_BYTES = 128 * 1_024;

export type DiscoveryImpactCalculation = (
  request: DiscoveryImpactRequestV1,
  signal: AbortSignal,
) => Promise<DiscoveryImpactResponseV1>;

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Cleanup is best effort; callers receive one sanitized unavailable error.
  }
}

function isJsonContentType(value: string): boolean {
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  return new RegExp(
    `^application/json(?:\\s*;\\s*${parameter})*\\s*$`,
    "i",
  ).test(value);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!isJsonContentType(response.headers.get("content-type") ?? "")) {
    await cancelBody(response.body);
    throw new Error("DISCOVERY_IMPACT_FAILED");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > DISCOVERY_IMPACT_BODY_MAX_BYTES
  ) {
    await cancelBody(response.body);
    throw new Error("DISCOVERY_IMPACT_FAILED");
  }
  if (response.body === null) throw new Error("DISCOVERY_IMPACT_FAILED");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > DISCOVERY_IMPACT_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new Error("DISCOVERY_IMPACT_FAILED");
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Cleanup only.
    }
    throw new Error("DISCOVERY_IMPACT_FAILED");
  }
}

/**
 * Sends one bounded, origin-free batch and independently validates the
 * response against the exact action order and identities in that request.
 */
export const calculateDiscoveryImpactFromApi: DiscoveryImpactCalculation = async (
  input,
  signal,
) => {
  const request = discoveryImpactRequestV1Schema.safeParse(input);
  if (!request.success) throw new Error("DISCOVERY_IMPACT_FAILED");
  const body = JSON.stringify(request.data);
  if (new TextEncoder().encode(body).byteLength > DISCOVERY_IMPACT_BODY_MAX_BYTES) {
    throw new Error("DISCOVERY_IMPACT_FAILED");
  }

  const response = await fetch("/api/discovery/impact", {
    body,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    await cancelBody(response.body);
    throw new Error("DISCOVERY_IMPACT_FAILED");
  }
  const parsed = discoveryImpactResponseV1SchemaFor(request.data).safeParse(
    await readBoundedJson(response),
  );
  if (!parsed.success) throw new Error("DISCOVERY_IMPACT_FAILED");
  return parsed.data;
};
