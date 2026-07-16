import type { PriceObservation, Product } from "@handleplan/domain";
import { z } from "zod";

import { normalizeBulkPriceResponse, normalizeSearchResponse } from "./schemas";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BULK_EANS = 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CHAIN_ORDER: Record<PriceObservation["chain"], number> = {
  bunnpris: 0,
  "rema-1000": 1,
  extra: 2,
};
const BROWSE_STORE_CODES = ["BUNNPRIS", "REMA_1000", "COOP_EXTRA"] as const;
const eanSchema = z.string().regex(/^(?:\d{8}|\d{13})$/);

export type KassalappGatewayErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_UNAVAILABLE";

export class KassalappGatewayError extends Error {
  constructor(public readonly code: KassalappGatewayErrorCode) {
    super(publicMessage(code));
    this.name = "KassalappGatewayError";
  }
}

export interface KassalappGateway {
  browseProducts(limit: number, signal?: AbortSignal): Promise<Product[]>;
  searchProducts(query: string, limit: number, signal?: AbortSignal): Promise<Product[]>;
  getBulkPrices(eans: string[], signal?: AbortSignal): Promise<PriceObservation[]>;
}

export interface KassalappClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}

interface AttemptResult {
  response: Response;
  body?: unknown;
}

class AttemptTimeoutError extends Error {}
class AttemptCancelledError extends Error {}
class InvalidResponseError extends Error {}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Cleanup only. */ }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  if (!new RegExp(`^application/json(?:\\s*;\\s*${parameter})*\\s*$`, "i").test(contentType)) {
    await cancelBody(response);
    throw new InvalidResponseError();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new InvalidResponseError();
  }
  if (response.body === null) throw new InvalidResponseError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new InvalidResponseError();
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Cleanup only. */ }
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError();
  }
}

function publicMessage(code: KassalappGatewayErrorCode): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "Ugyldig forespørsel til prisgrunnlaget.";
    case "INVALID_RESPONSE":
      return "Prisgrunnlaget hadde et ukjent format.";
    case "TIMEOUT":
      return "Prisgrunnlaget svarte ikke i tide.";
    case "CANCELLED":
      return "Forespørselen til prisgrunnlaget ble avbrutt.";
    case "UPSTREAM_UNAVAILABLE":
      return "Prisgrunnlaget er midlertidig utilgjengelig.";
  }
}

function normalizeBaseUrl(input: string): string {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Invalid base URL");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new KassalappGatewayError("INVALID_REQUEST");
  }
}

function sortBulkObservations(
  observations: PriceObservation[],
  requestedEans: readonly string[],
): PriceObservation[] {
  const eanOrder = new Map(requestedEans.map((ean, index) => [ean, index]));
  return observations.sort((left, right) => {
    const byEan =
      (eanOrder.get(left.ean) ?? Number.MAX_SAFE_INTEGER) -
      (eanOrder.get(right.ean) ?? Number.MAX_SAFE_INTEGER);
    if (byEan !== 0) return byEan;

    const byChain = CHAIN_ORDER[left.chain] - CHAIN_ORDER[right.chain];
    if (byChain !== 0) return byChain;

    const byObservedAt = right.observedAt.localeCompare(left.observedAt);
    if (byObservedAt !== 0) return byObservedAt;

    return left.amountOre - right.amountOre;
  });
}

function toGatewayError(error: unknown): KassalappGatewayError {
  if (error instanceof KassalappGatewayError) {
    return error;
  }
  return new KassalappGatewayError("INVALID_RESPONSE");
}

export class KassalappClient implements KassalappGateway {
  private readonly baseUrl: string;

  constructor(private readonly options: KassalappClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  async browseProducts(limit: number, signal?: AbortSignal): Promise<Product[]> {
    const parsed = z.number().int().min(1).max(100).safeParse(limit);
    if (!parsed.success) throw new KassalappGatewayError("INVALID_REQUEST");

    try {
      const perStoreLimit = Math.ceil(parsed.data / BROWSE_STORE_CODES.length);
      const batches = await Promise.all(BROWSE_STORE_CODES.map(async (store) => {
        const url = new URL(`${this.baseUrl}/products`);
        url.searchParams.set("store", store);
        url.searchParams.set("size", String(perStoreLimit));
        url.searchParams.set("sort", "date_desc");
        url.searchParams.set("unique", "1");
        url.searchParams.set("exclude_without_ean", "1");
        return normalizeSearchResponse(await this.requestJson(url, { method: "GET" }, signal));
      }));
      return [...new Map(batches.flat().map((product) => [product.ean, product])).values()]
        .slice(0, parsed.data);
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async searchProducts(query: string, limit: number, signal?: AbortSignal): Promise<Product[]> {
    const parsed = z
      .object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(100) })
      .safeParse({ query, limit });
    if (!parsed.success) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    const url = new URL(`${this.baseUrl}/products`);
    url.searchParams.set("search", parsed.data.query);
    url.searchParams.set("size", String(parsed.data.limit));
    url.searchParams.set("unique", "1");
    url.searchParams.set("exclude_without_ean", "1");

    try {
      return normalizeSearchResponse(
        await this.requestJson(url, { method: "GET" }, signal),
      ).slice(0, parsed.data.limit);
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getBulkPrices(eans: string[], signal?: AbortSignal): Promise<PriceObservation[]> {
    if (signal?.aborted) {
      throw new KassalappGatewayError("CANCELLED");
    }
    if (eans.length === 0) {
      return [];
    }

    const parsed = z.array(eanSchema).safeParse(eans);
    if (!parsed.success) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    // Duplicate request EANs are collapsed at first occurrence. Every validated
    // upstream observation row is preserved and canonicalized by the final sort.
    const requestedEans = [...new Set(parsed.data)];
    const observations: PriceObservation[] = [];
    for (let index = 0; index < requestedEans.length; index += MAX_BULK_EANS) {
      const batch = requestedEans.slice(index, index + MAX_BULK_EANS);
      try {
        const response = await this.requestJson(
          `${this.baseUrl}/products/prices-bulk`,
          {
            body: JSON.stringify({ eans: batch }),
            method: "POST",
          },
          signal,
        );
        const normalized = normalizeBulkPriceResponse(response);
        const requested = new Set(batch);
        if (normalized.some((observation) => !requested.has(observation.ean))) {
          throw new KassalappGatewayError("INVALID_RESPONSE");
        }
        observations.push(...normalized);
      } catch (error) {
        throw toGatewayError(error);
      }
    }

    return sortBulkObservations(observations, requestedEans);
  }

  private async requestJson(
    input: string | URL,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new KassalappGatewayError("CANCELLED");
      }
      const result = await this.attempt(input, init, signal);
      if (signal?.aborted) {
        throw new KassalappGatewayError("CANCELLED");
      }
      if (result.response.ok) {
        return result.body;
      }
      if (attempt === 0 && RETRYABLE_STATUSES.has(result.response.status)) {
        continue;
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }

    throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
  }

  private async attempt(
    input: string | URL,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<AttemptResult> {
    if (callerSignal?.aborted) {
      throw new KassalappGatewayError("CANCELLED");
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let cancelled = false;
    let onCallerAbort: (() => void) | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new AttemptTimeoutError());
      }, DEFAULT_TIMEOUT_MS);
    });

    const cancellation = new Promise<never>((_resolve, reject) => {
      if (callerSignal === undefined) return;
      onCallerAbort = () => {
        cancelled = true;
        controller.abort();
        reject(new AttemptCancelledError());
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    });

    const request = (async (): Promise<AttemptResult> => {
      const response = await this.options.fetch(input, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        await cancelBody(response);
        return { response };
      }
      try {
        return { body: await readBoundedJson(response), response };
      } catch {
        throw new InvalidResponseError();
      }
    })();

    try {
      return await Promise.race([request, timeout, cancellation]);
    } catch (error) {
      if (error instanceof AttemptCancelledError || cancelled || callerSignal?.aborted) {
        throw new KassalappGatewayError("CANCELLED");
      }
      if (error instanceof AttemptTimeoutError || timedOut) {
        throw new KassalappGatewayError("TIMEOUT");
      }
      if (error instanceof InvalidResponseError) {
        throw new KassalappGatewayError("INVALID_RESPONSE");
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeoutId);
      if (callerSignal !== undefined && onCallerAbort !== undefined) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  }
}
