import "server-only";

import {
  internalGeocodedCandidateSchema,
  travelCoordinateSchema,
} from "@handleplan/domain";
import { z } from "zod";

import {
  MAX_GEOCODER_CANDIDATES,
  geocoderGatewayResultSchema,
  type GeocoderGateway,
  type GeocoderGatewayResult,
} from "./gateways";

export const KARTVERKET_ADDRESS_SEARCH_URL = "https://ws.geonorge.no/adresser/v1/sok";
export const KARTVERKET_ADDRESS_SOURCE_ID = "kartverket-address-api";
export const DEFAULT_KARTVERKET_RESPONSE_BYTES = 64 * 1024;

const searchQuerySchema = z
  .string()
  .trim()
  .min(2)
  .max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const upstreamCoordinateSchema = z
  .object({
    epsg: z.literal("EPSG:4258"),
    lat: z.number().min(57).max(72),
    lon: z.number().min(4).max(32),
  })
  .passthrough();

const upstreamAddressSchema = z
  .object({
    adressetekst: z.string().trim().min(1).max(500),
    postnummer: z.string().regex(/^\d{4}$/).nullish(),
    poststed: z.string().trim().min(1).max(200).nullish(),
    representasjonspunkt: upstreamCoordinateSchema,
  })
  .passthrough();

const upstreamResponseSchema = z
  .object({
    adresser: z.array(upstreamAddressSchema).max(MAX_GEOCODER_CANDIDATES),
  })
  .passthrough();

export type KartverketGeocoderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "UNAVAILABLE";

export class KartverketGeocoderError extends Error {
  constructor(readonly code: KartverketGeocoderErrorCode) {
    super(`Kartverket geocoder failed: ${code}`);
    this.name = "KartverketGeocoderError";
  }
}

export interface KartverketGeocoderOptions {
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

function validatedResponseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_KARTVERKET_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) {
    throw new RangeError("maxResponseBytes must be an integer from 1 through 1048576");
  }
  return limit;
}

function bestEffortCancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup must never expose or replace the sanitized provider error.
  }
}

async function readBoundedUtf8(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      bestEffortCancelBody(response);
      throw new KartverketGeocoderError("INVALID_RESPONSE");
    }
    if (Number(declaredLength) > maxBytes) {
      bestEffortCancelBody(response);
      throw new KartverketGeocoderError("RESPONSE_TOO_LARGE");
    }
  }
  if (response.body === null) throw new KartverketGeocoderError("INVALID_RESPONSE");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytesRead = 0;
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is best effort and never changes the public error.
    }
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();

  try {
    while (true) {
      if (signal?.aborted) throw new KartverketGeocoderError("CANCELLED");
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new KartverketGeocoderError("RESPONSE_TOO_LARGE");
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return fragments.join("");
  } catch (error) {
    cancelReader();
    if (error instanceof KartverketGeocoderError) throw error;
    if (signal?.aborted) throw new KartverketGeocoderError("CANCELLED");
    throw new KartverketGeocoderError("INVALID_RESPONSE");
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
}

function publicSafeLabel(address: z.infer<typeof upstreamAddressSchema>): string {
  const postalPlace = [address.postnummer, address.poststed]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  return [address.adressetekst, postalPlace]
    .filter((value) => value.length > 0)
    .join(", ");
}

function toCandidate(
  address: z.infer<typeof upstreamAddressSchema>,
  index: number,
) {
  const coordinate = travelCoordinateSchema.parse({
    latitudeE6: Math.round(address.representasjonspunkt.lat * 1_000_000),
    longitudeE6: Math.round(address.representasjonspunkt.lon * 1_000_000),
  });
  return internalGeocodedCandidateSchema.parse({
    coordinate,
    label: publicSafeLabel(address),
    selectionId: `kartverket-address:${index + 1}`,
  });
}

export class KartverketGeocoderGateway implements GeocoderGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(options: KartverketGeocoderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResponseBytes = validatedResponseLimit(options.maxResponseBytes);
  }

  async search(query: string, signal?: AbortSignal): Promise<GeocoderGatewayResult> {
    const parsedQuery = searchQuerySchema.safeParse(query);
    if (!parsedQuery.success) throw new KartverketGeocoderError("INVALID_REQUEST");
    if (signal?.aborted) throw new KartverketGeocoderError("CANCELLED");

    const url = new URL(KARTVERKET_ADDRESS_SEARCH_URL);
    url.searchParams.set("sok", parsedQuery.data);
    url.searchParams.set("treffPerSide", String(MAX_GEOCODER_CANDIDATES));
    url.searchParams.set("side", "0");

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch {
      if (signal?.aborted) throw new KartverketGeocoderError("CANCELLED");
      throw new KartverketGeocoderError("UNAVAILABLE");
    }

    if (!response.ok) {
      bestEffortCancelBody(response);
      throw new KartverketGeocoderError("UNAVAILABLE");
    }
    const mediaType = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(mediaType)) {
      bestEffortCancelBody(response);
      throw new KartverketGeocoderError("INVALID_RESPONSE");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readBoundedUtf8(response, this.maxResponseBytes, signal)) as unknown;
    } catch (error) {
      if (error instanceof KartverketGeocoderError) throw error;
      throw new KartverketGeocoderError("INVALID_RESPONSE");
    }
    const parsed = upstreamResponseSchema.safeParse(raw);
    if (!parsed.success) throw new KartverketGeocoderError("INVALID_RESPONSE");

    try {
      return geocoderGatewayResultSchema.parse({
        candidates: parsed.data.adresser.map(toCandidate),
        contractVersion: 1,
        providerSourceId: KARTVERKET_ADDRESS_SOURCE_ID,
      });
    } catch {
      throw new KartverketGeocoderError("INVALID_RESPONSE");
    }
  }
}
