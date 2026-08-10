import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  KARTVERKET_ADDRESS_SEARCH_URL,
  KartverketGeocoderError,
  KartverketGeocoderGateway,
} from "./kartverket-geocoder";

function upstreamAddress(overrides: Record<string, unknown> = {}) {
  return {
    adressetekst: "Storgata 1",
    postnummer: "0155",
    poststed: "OSLO",
    representasjonspunkt: {
      epsg: "EPSG:4258",
      lat: 59.9139,
      lon: 10.7522,
    },
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...init.headers },
    status: init.status,
  });
}

describe("KartverketGeocoderGateway", () => {
  it("uses only the fixed official address endpoint and maps a bounded Norwegian result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      adresser: [upstreamAddress()],
      metadata: { totaltAntallTreff: 1 },
    })) as unknown as typeof fetch;
    const gateway = new KartverketGeocoderGateway({ fetchImpl });

    await expect(gateway.search(" Storgata 1, Oslo ")).resolves.toEqual({
      candidates: [{
        coordinate: { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
        label: "Storgata 1, 0155 OSLO",
        selectionId: "kartverket-address:1",
      }],
      contractVersion: 1,
      providerSourceId: "kartverket-address-api",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [rawUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(`${url.origin}${url.pathname}`).toBe(KARTVERKET_ADDRESS_SEARCH_URL);
    expect([...url.searchParams.keys()].sort()).toEqual(["side", "sok", "treffPerSide"]);
    expect(url.searchParams.get("sok")).toBe("Storgata 1, Oslo");
    expect(url.searchParams.get("treffPerSide")).toBe("5");
    expect(url.searchParams.get("side")).toBe("0");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect((init?.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("treats URL-looking user text only as encoded search text", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ adresser: [] })) as unknown as typeof fetch;
    const gateway = new KartverketGeocoderGateway({ fetchImpl });
    const sentinel = "Oslo?providerUrl=https://attacker.invalid/private";

    await gateway.search(sentinel);

    const [rawUrl] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe("https://ws.geonorge.no");
    expect(url.pathname).toBe("/adresser/v1/sok");
    expect(url.searchParams.get("sok")).toBe(sentinel);
    expect(url.searchParams.has("providerUrl")).toBe(false);
  });

  it("passes cancellation through without adding shopper headers or details", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        seenSignal?.addEventListener("abort", () => reject(new DOMException("private", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = new KartverketGeocoderGateway({ fetchImpl }).search("Storgata", controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(seenSignal).toBe(controller.signal);
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ accept: "application/json" });
  });

  it("fails closed on status, media type, malformed JSON, coordinates, EPSG, or result count", async () => {
    const cases = [
      new Response("private upstream detail", { status: 503 }),
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      jsonResponse({ adresser: [upstreamAddress({ representasjonspunkt: {
        epsg: "EPSG:4326", lat: 59.9, lon: 10.7,
      } })] }),
      jsonResponse({ adresser: [upstreamAddress({ representasjonspunkt: {
        epsg: "EPSG:4258", lat: 10, lon: 10,
      } })] }),
      jsonResponse({ adresser: Array.from({ length: 6 }, () => upstreamAddress()) }),
    ];

    for (const response of cases) {
      const gateway = new KartverketGeocoderGateway({
        fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
      });
      await expect(gateway.search("Storgata")).rejects.toBeInstanceOf(KartverketGeocoderError);
    }
  });

  it("bounds declared and streamed upstream bodies and cancels unread bytes", async () => {
    const declaredCancelled = vi.fn();
    const declaredBody = new ReadableStream<Uint8Array>({ cancel: declaredCancelled });
    const declared = new Response(declaredBody, {
      headers: {
        "content-length": "65",
        "content-type": "application/json",
      },
    });
    const declaredGateway = new KartverketGeocoderGateway({
      fetchImpl: vi.fn(async () => declared) as unknown as typeof fetch,
      maxResponseBytes: 64,
    });

    await expect(declaredGateway.search("Storgata")).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(declaredCancelled).toHaveBeenCalledOnce();

    const streamedCancelled = vi.fn();
    let sent = false;
    const streamedBody = new ReadableStream<Uint8Array>({
      cancel: streamedCancelled,
      pull(controller) {
        if (!sent) {
          controller.enqueue(new Uint8Array(65));
          sent = true;
        }
      },
    });
    const streamed = new Response(streamedBody, {
      headers: { "content-type": "application/json" },
    });
    const streamedGateway = new KartverketGeocoderGateway({
      fetchImpl: vi.fn(async () => streamed) as unknown as typeof fetch,
      maxResponseBytes: 64,
    });

    await expect(streamedGateway.search("Storgata")).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(streamedCancelled).toHaveBeenCalledOnce();
  });
});
