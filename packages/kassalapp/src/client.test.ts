import { beforeEach, describe, expect, it, vi } from "vitest";

import pricesFixture from "../test/fixtures/prices-bulk.json";
import searchFixture from "../test/fixtures/search.json";
import officialProductFixture from "../test/fixtures/v1/product-by-id.json";
import {
  KassalappClient,
  KassalappGatewayError,
  resetKassalappRequestCoordinationForTests,
} from "./client";
import { isValidGtin } from "./source-contracts";

const EAN = "7038010000010";
const API_KEY = "synthetic-test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function gtin13(sequence: number): string {
  const body = String(sequence).padStart(12, "0");
  const weighted = [...body].reduce(
    (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

function createClient(fetchImplementation: typeof fetch): KassalappClient {
  return new KassalappClient({
    apiKey: API_KEY,
    baseUrl: "https://fixture.invalid/api/v1",
    fetch: fetchImplementation,
  });
}

describe("KassalappClient contract", () => {
  beforeEach(() => {
    resetKassalappRequestCoordinationForTests();
  });

  it("keeps intended-valid compatibility fixtures checksum-valid", () => {
    expect([
      EAN,
      searchFixture.data[0]?.ean,
      pricesFixture.data[0]?.ean,
    ].every((ean) => typeof ean === "string" && isValidGtin(ean))).toBe(true);
  });

  it("browses documented ProductResource rows with store arrays and opaque update metadata", async () => {
    const seenUrls: string[] = [];
    const injectedFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seenUrls.push(url.toString());
      return jsonResponse({ data: [{
        ...officialProductFixture.data,
        ean: EAN,
        name: "Tine Lettmelk 1 %",
        current_price: 21.9,
        price_history: [
          { price: 21.9, date: "2026-07-15T10:00:00Z" },
          { price: 29.9, date: "2026-07-10T10:00:00Z" },
        ],
        store: [{
          name: "Fixture store",
          code: url.searchParams.get("store"),
          url: "https://example.invalid/store",
          logo: "https://example.invalid/store.svg",
        }],
        updated_at: null,
      }] });
    };

    const catalog = await createClient(injectedFetch).browseCatalog(36);
    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toEqual({
      product: expect.objectContaining({ ean: EAN, name: "Tine Lettmelk 1 %" }),
      price: expect.objectContaining({ amountOre: 2190, chain: "bunnpris" }),
      previousPrice: expect.objectContaining({ amountOre: 2990, chain: "bunnpris" }),
    });
    expect(seenUrls).toEqual([
      "https://fixture.invalid/api/v1/products?store=BUNNPRIS&size=100&sort=date_desc&unique=1&exclude_without_ean=1",
      "https://fixture.invalid/api/v1/products?store=REMA_1000&size=100&sort=date_desc&unique=1&exclude_without_ean=1",
      "https://fixture.invalid/api/v1/products?store=COOP_EXTRA&size=100&sort=date_desc&unique=1&exclude_without_ean=1",
    ]);
  });

  it("prioritizes documented price drops inside each store catalog", async () => {
    const injectedFetch: typeof fetch = async (input) => {
      const store = new URL(String(input)).searchParams.get("store");
      return jsonResponse({ data: [
        {
          ...officialProductFixture.data, ean: "7038010000027", name: "Vanlig pris",
          current_price: 10, price_history: [{ price: 10, date: "2026-07-15T10:00:00Z" }],
          store: [{ name: "Fixture", code: store, url: "https://example.invalid", logo: "https://example.invalid/logo.svg" }],
          updated_at: null,
        },
        {
          ...officialProductFixture.data, ean: "7038010000034", name: "Dokumentert prisfall",
          current_price: 8, price_history: [
            { price: 8, date: "2026-07-15T10:00:00Z" },
            { price: 16, date: "2026-07-10T10:00:00Z" },
          ],
          store: [{ name: "Fixture", code: store, url: "https://example.invalid", logo: "https://example.invalid/logo.svg" }],
          updated_at: null,
        },
      ] });
    };

    const catalog = await createClient(injectedFetch).browseCatalog(3);
    expect(catalog.map(({ product }) => product.name)).toEqual([
      "Dokumentert prisfall", "Dokumentert prisfall", "Dokumentert prisfall",
    ]);
    expect(catalog.every(({ previousPrice }) => previousPrice?.amountOre === 1600)).toBe(true);
  });

  it("does not cherry-pick an older high price after a more recent price increase", async () => {
    const injectedFetch: typeof fetch = async (input) => jsonResponse({ data: [{
      ...officialProductFixture.data,
      ean: EAN,
      current_price: 10,
      price_history: [
        { price: 10, date: "2026-07-16T10:00:00Z" },
        { price: 9, date: "2026-07-15T10:00:00Z" },
        { price: 20, date: "2026-07-10T10:00:00Z" },
      ],
      store: [{
        name: "Fixture",
        code: new URL(String(input)).searchParams.get("store"),
        url: "https://example.invalid",
        logo: "https://example.invalid/logo.svg",
      }],
      updated_at: null,
    }] });

    const catalog = await createClient(injectedFetch).browseCatalog(3);
    expect(catalog).toHaveLength(3);
    expect(catalog.every((item) => item.previousPrice === undefined)).toBe(true);
  });

  it("searches with the injected fetch and normalizes a validated product fixture", async () => {
    let seenAuthorization: string | null = null;
    const seenUrls: string[] = [];
    const injectedFetch: typeof fetch = async (input, init) => {
      seenUrls.push(String(input));
      seenAuthorization = new Headers(init?.headers).get("authorization");
      return jsonResponse(searchFixture);
    };

    const products = await createClient(injectedFetch).searchProducts(" lettmelk ", 10);

    expect(products).toEqual([
      {
        ean: EAN,
        name: "Tine Lettmelk 1 %",
        brand: "Tine",
        packageQuantity: 1000,
        packageUnit: "ml",
      },
    ]);
    expect(seenAuthorization).toBe(`Bearer ${API_KEY}`);
    expect(seenUrls).toEqual([
      "https://fixture.invalid/api/v1/products?search=lettmelk&size=10&unique=1&exclude_without_ean=1",
    ]);
  });

  it("normalizes NOK prices and canonicalizes observed timestamps to millisecond UTC", async () => {
    const injectedFetch: typeof fetch = async () => jsonResponse(pricesFixture);

    await expect(createClient(injectedFetch).getBulkPrices([EAN])).resolves.toEqual([
      {
        amountOre: 2240,
        chain: "rema-1000",
        ean: EAN,
        observedAt: "2026-07-15T08:45:00.000Z",
        source: "kassalapp",
      },
      {
        amountOre: 2190,
        chain: "extra",
        ean: EAN,
        observedAt: "2026-07-15T08:30:00.000Z",
        source: "kassalapp",
      },
    ]);
  });

  it("omits an official bulk-price row whose last_checked timestamp is null", async () => {
    const fixture = structuredClone(pricesFixture);
    fixture.data[0]!.stores[0]!.last_checked = null as unknown as string;

    await expect(createClient(async () => jsonResponse(fixture)).getBulkPrices([EAN])).resolves.toEqual([
      expect.objectContaining({ chain: "rema-1000", amountOre: 2240 }),
    ]);
  });

  it("rejects a legacy price amount above the signed 32-bit øre boundary", async () => {
    const fixture = structuredClone(pricesFixture);
    fixture.data[0]!.stores[0]!.current_price = 21_474_836.48;

    await expect(createClient(async () => jsonResponse(fixture)).getBulkPrices([EAN]))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("enforces the requested result limit even if upstream overproduces", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          searchFixture.data[0],
          { ...searchFixture.data[0], ean: "7038010000027", name: "Annen lettmelk" },
        ],
      });

    await expect(createClient(injectedFetch).searchProducts("lettmelk", 1)).resolves.toEqual([
      expect.objectContaining({ ean: EAN }),
    ]);
  });

  it("omits search rows that cannot be used by the EAN-8/EAN-13 price contract", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          searchFixture.data[0],
          { ...searchFixture.data[0], ean: "16229001704", name: "Vendor-ID product" },
          { ...searchFixture.data[0], ean: "17037154346104", name: "GTIN-14 product" },
        ],
      });

    await expect(createClient(injectedFetch).searchProducts("melk", 10)).resolves.toEqual([
      expect.objectContaining({ ean: EAN }),
    ]);
  });

  it("batches 101 EANs into requests of at most 100", async () => {
    const batchSizes: number[] = [];
    const injectedFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eans: string[] };
      batchSizes.push(body.eans.length);
      return jsonResponse({ data: [] });
    };
    const eans = Array.from({ length: 101 }, (_, index) => gtin13(index + 1));

    await expect(createClient(injectedFetch).getBulkPrices(eans)).resolves.toEqual([]);
    expect(batchSizes).toEqual([100, 1]);
  });

  it("fails closed on malformed upstream JSON without exposing its body", async () => {
    const secretBody = `not-json-${API_KEY}`;
    const injectedFetch: typeof fetch = async () => new Response(secretBody, { status: 200 });

    const error = await createClient(injectedFetch).searchProducts("melk", 10).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(KassalappGatewayError);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(String(error)).not.toContain(secretBody);
    expect(String(error)).not.toContain(API_KEY);
  });

  it("bounds a no-content-length streaming response and cancels cleanup without leaking the key", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(120)); },
      cancel() { cancelled = true; },
    });
    const injectedFetch: typeof fetch = async () => new Response(stream, {
      headers: { "content-type": "application/json" },
    });

    const error = await createClient(injectedFetch).searchProducts("melk", 10).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(cancelled).toBe(true);
    expect(String(error)).not.toContain(API_KEY);
  });

  it("rejects malformed UTF-8 and an unexpected content type", async () => {
    const malformedUtf8: typeof fetch = async () => new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { "content-type": "application/json" },
    });
    const wrongType: typeof fetch = async () => new Response(JSON.stringify(searchFixture), {
      headers: { "content-type": "text/plain" },
    });

    await expect(createClient(malformedUtf8).searchProducts("melk", 10)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(createClient(wrongType).searchProducts("melk", 10)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects upstream envelopes beyond request-derived safe maxima", async () => {
    const overproduced = Array.from({ length: 101 }, (_, index) => ({
      ...searchFixture.data[0],
      ean: gtin13(index + 1),
    }));
    await expect(createClient(async () => jsonResponse({ data: overproduced })).searchProducts("melk", 100)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("fails closed when a normalized observation would violate the domain timestamp", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          {
            ...pricesFixture.data[0],
            stores: [
              {
                ...pricesFixture.data[0].stores[0],
                last_checked: "not-a-timestamp",
              },
            ],
          },
        ],
      });

    await expect(createClient(injectedFetch).getBulkPrices([EAN])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("fails closed when bulk data contains an EAN that was not requested", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          {
            ...pricesFixture.data[0],
            ean: "7038010000027",
          },
        ],
      });

    await expect(createClient(injectedFetch).getBulkPrices([EAN])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it.each([
    ["search envelope", { ...searchFixture, unknown_envelope_field: true }, "search"],
    [
      "nested product",
      { data: [{ ...searchFixture.data[0], unknown_product_field: true }] },
      "search",
    ],
    ["price envelope", { ...pricesFixture, unknown_envelope_field: true }, "prices"],
    [
      "nested price",
      { data: [{ ...pricesFixture.data[0], unknown_price_field: true }] },
      "prices",
    ],
  ] as const)("ignores an unneeded field at the %s level", async (_name, body, method) => {
    const injectedFetch: typeof fetch = async () => jsonResponse(body);
    const client = createClient(injectedFetch);
    const result =
      method === "search"
        ? client.searchProducts("melk", 10)
        : client.getBulkPrices([EAN]);

    await expect(result).resolves.not.toHaveLength(0);
  });

  it("returns bulk rows in requested EAN, Phase 1 chain, then newest-observation order", async () => {
    const eans = Array.from({ length: 101 }, (_, index) => gtin13(index + 1));
    const row = (
      ean: string,
      chain: "bunnpris" | "rema-1000" | "extra",
      observedAt: string,
      priceNok: number,
    ) => ({
      ean,
      stores: [
        {
          store: {
            bunnpris: "BUNNPRIS",
            "rema-1000": "REMA_1000",
            extra: "COOP_EXTRA",
          }[chain],
          current_price: priceNok,
          last_checked: observedAt,
        },
      ],
    });
    const injectedFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eans: string[] };
      if (body.eans.includes(eans[100]!)) {
        return jsonResponse({
          data: [row(eans[100]!, "extra", "2026-07-15T08:00:00Z", 30)],
        });
      }
      return jsonResponse({
        data: [
          row(eans[1]!, "bunnpris", "2026-07-15T08:00:00Z", 25),
          row(eans[0]!, "extra", "2026-07-14T08:00:00Z", 23),
          row(eans[0]!, "extra", "2026-07-15T08:00:00Z", 21),
          row(eans[0]!, "bunnpris", "2026-07-15T08:00:00Z", 24),
          row(eans[0]!, "bunnpris", "2026-07-15T08:00:00Z", 22),
        ],
      });
    };

    const observations = await createClient(injectedFetch).getBulkPrices(eans);

    expect(observations.map(({ ean, chain, amountOre }) => [ean, chain, amountOre])).toEqual([
      [eans[0], "bunnpris", 2200],
      [eans[0], "bunnpris", 2400],
      [eans[0], "extra", 2100],
      [eans[0], "extra", 2300],
      [eans[1], "bunnpris", 2500],
      [eans[100], "extra", 3000],
    ]);
  });

  it("collapses duplicate requested EANs but preserves duplicate validated observations", async () => {
    const requestBodies: string[][] = [];
    const duplicate = {
      ...pricesFixture.data[0],
      stores: [pricesFixture.data[0].stores[0]],
    };
    const injectedFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eans: string[] };
      requestBodies.push(body.eans);
      return jsonResponse({ data: [duplicate, duplicate] });
    };

    const observations = await createClient(injectedFetch).getBulkPrices([EAN, EAN]);

    expect(requestBodies).toEqual([[EAN]]);
    expect(observations).toHaveLength(2);
  });

  it("rejects an invalid base URL with a fixed error that omits the input", () => {
    const invalidUrl = `not-a-url-${API_KEY}`;

    expect(() =>
      new KassalappClient({ apiKey: API_KEY, baseUrl: invalidUrl, fetch }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Ugyldig forespørsel til prisgrunnlaget.",
      }),
    );
    try {
      new KassalappClient({ apiKey: API_KEY, baseUrl: invalidUrl, fetch });
    } catch (error) {
      expect(String(error)).not.toContain(invalidUrl);
      expect(String(error)).not.toContain(API_KEY);
    }
  });

  it("returns a distinct sanitized cancellation before calling fetch", async () => {
    const controller = new AbortController();
    controller.abort(`private-reason-${API_KEY}`);
    const injectedFetch = vi.fn<typeof fetch>();

    const error = await createClient(injectedFetch)
      .searchProducts("melk", 10, controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CANCELLED",
      message: "Forespørselen til prisgrunnlaget ble avbrutt.",
    });
    expect(String(error)).not.toContain(API_KEY);
    expect(injectedFetch).not.toHaveBeenCalled();
  });

  it("honors an already-aborted bulk signal even when there are no EANs", async () => {
    const caller = new AbortController();
    caller.abort("stop empty request");
    const injectedFetch = vi.fn<typeof fetch>();

    await expect(createClient(injectedFetch).getBulkPrices([], caller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(injectedFetch).not.toHaveBeenCalled();
  });

  it("cancels an active request without retry and cleans its timer and listener", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const addListener = vi.spyOn(caller.signal, "addEventListener");
      const removeListener = vi.spyOn(caller.signal, "removeEventListener");
      let attempts = 0;
      const injectedFetch: typeof fetch = async (_input, init) => {
        attempts += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("raw", "AbortError")));
        });
      };
      const result = createClient(injectedFetch).searchProducts("melk", 10, caller.signal);
      const rejection = expect(result).rejects.toMatchObject({ code: "CANCELLED" });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      caller.abort(`private-reason-${API_KEY}`);
      await vi.advanceTimersByTimeAsync(8_000);

      await rejection;
      expect(attempts).toBe(1);
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancellation after a retryable response prevents the second attempt", async () => {
    const caller = new AbortController();
    let attempts = 0;
    const injectedFetch: typeof fetch = async () => {
      attempts += 1;
      caller.abort("stop before retry");
      return jsonResponse({}, 429);
    };

    await expect(
      createClient(injectedFetch).searchProducts("melk", 10, caller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(attempts).toBe(1);
  });

  it("coalesces identical in-flight calls without letting one caller cancel the other", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    let sharedSignal: AbortSignal | undefined;
    const injectedFetch = vi.fn<typeof fetch>(async (_input, init) => {
      sharedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((resolve) => { resolveResponse = resolve; });
    });
    const client = createClient(injectedFetch);
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();

    const first = client.searchProducts("melk", 10, firstCaller.signal).catch((error: unknown) => error);
    const second = client.searchProducts("melk", 10, secondCaller.signal);
    await vi.waitFor(() => expect(injectedFetch).toHaveBeenCalledTimes(1));

    firstCaller.abort("cancel only the first subscriber");
    await expect(first).resolves.toMatchObject({ code: "CANCELLED" });
    expect(sharedSignal?.aborted).toBe(false);

    resolveResponse?.(jsonResponse({ data: [] }));
    await expect(second).resolves.toEqual([]);
    expect(injectedFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds subscribers waiting on one coalesced request", async () => {
    const injectedFetch = vi.fn<typeof fetch>(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }));
    const client = createClient(injectedFetch);
    const callers = Array.from({ length: 101 }, () => new AbortController());
    const requests = callers.map((caller) =>
      client.searchProducts("same-product", 1, caller.signal).catch((error: unknown) => error));

    await vi.waitFor(() => expect(injectedFetch).toHaveBeenCalledTimes(1));
    await expect(requests.at(-1)).resolves.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    callers.slice(0, 100).forEach((caller) => caller.abort());
    const outcomes = await Promise.all(requests);
    expect(outcomes.slice(0, 100)).toEqual(
      Array.from({ length: 100 }, () => expect.objectContaining({ code: "CANCELLED" })),
    );
  });

  it("starts a fresh identical request after the final subscriber cancels", async () => {
    let attempts = 0;
    const injectedFetch: typeof fetch = async (_input, init) => {
      attempts += 1;
      if (attempts > 1) return jsonResponse({ data: [] });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };
    const client = createClient(injectedFetch);
    const firstCaller = new AbortController();
    const first = client.searchProducts("melk", 10, firstCaller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(attempts).toBe(1));

    firstCaller.abort("replace request");
    const replacement = client.searchProducts("melk", 10);

    await expect(first).resolves.toMatchObject({ code: "CANCELLED" });
    await expect(replacement).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it("shares the 60 request/minute budget across client instances", async () => {
    vi.useFakeTimers();
    try {
      const injectedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
      const firstClient = createClient(injectedFetch);
      const secondClient = createClient(injectedFetch);
      const requests = Array.from({ length: 61 }, (_, index) =>
        (index % 2 === 0 ? firstClient : secondClient).searchProducts(`product-${index}`, 1));

      await vi.advanceTimersByTimeAsync(0);
      expect(injectedFetch).toHaveBeenCalledTimes(60);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(injectedFetch).toHaveBeenCalledTimes(60);
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.all(requests)).resolves.toHaveLength(61);
      expect(injectedFetch).toHaveBeenCalledTimes(61);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the process-local rate-limit wait queue and releases cancelled waiters", async () => {
    vi.useFakeTimers();
    try {
      const injectedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
      const clients = [createClient(injectedFetch), createClient(injectedFetch)] as const;
      const controllers = Array.from({ length: 181 }, () => new AbortController());
      const requests = controllers.map((controller, index) =>
        clients[index % clients.length]!.searchProducts(`queued-product-${index}`, 1, controller.signal)
          .catch((error: unknown) => error));

      await vi.advanceTimersByTimeAsync(0);
      expect(injectedFetch).toHaveBeenCalledTimes(60);
      await expect(requests.at(-1)).resolves.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

      controllers[60]!.abort();
      await expect(requests[60]).resolves.toMatchObject({ code: "CANCELLED" });
      const replacementController = new AbortController();
      const replacement = clients[0].searchProducts("replacement-waiter", 1, replacementController.signal)
        .catch((error: unknown) => error);
      let replacementSettled = false;
      void replacement.finally(() => { replacementSettled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(replacementSettled).toBe(false);

      replacementController.abort();
      controllers.slice(61, 180).forEach((controller) => controller.abort());
      await Promise.all([...requests, replacement]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an injected shared coordinator for every upstream attempt", async () => {
    vi.useFakeTimers();
    try {
      const acquire = vi.fn(async () => undefined);
      let attempts = 0;
      const client = new KassalappClient({
        apiKey: API_KEY,
        baseUrl: "https://fixture.invalid/api/v1",
        fetch: async () => {
          attempts += 1;
          return attempts === 1 ? new Response(null, { status: 503 }) : jsonResponse({ data: [] });
        },
        requestCoordinator: { acquire },
      });

      const result = client.searchProducts("melk", 10);
      await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toEqual([]);
      expect(acquire).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes shared-coordinator failure and forwards active cancellation", async () => {
    const waitingCaller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch,
      requestCoordinator: {
        acquire: async (signal) => await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error(`private ${API_KEY}`)), { once: true });
        }),
      },
    });
    const cancelled = client.searchProducts("melk", 10, waitingCaller.signal);
    waitingCaller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();

    const failed = new KassalappClient({
      apiKey: API_KEY,
      baseUrl: "https://fixture.invalid/api/v1",
      fetch,
      requestCoordinator: { acquire: async () => { throw new Error(`private ${API_KEY}`); } },
    }).searchProducts("melk", 10).catch((error: unknown) => error);
    const error = await failed;
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(String(error)).not.toContain(API_KEY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cleans the caller listener and timeout after success", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const addListener = vi.spyOn(caller.signal, "addEventListener");
      const removeListener = vi.spyOn(caller.signal, "removeEventListener");

      await expect(
        createClient(async () => jsonResponse({ data: [] })).searchProducts(
          "melk",
          10,
          caller.signal,
        ),
      ).resolves.toEqual([]);

      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts each attempt at eight seconds and does not retry a timeout", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const addListener = vi.spyOn(caller.signal, "addEventListener");
      const removeListener = vi.spyOn(caller.signal, "removeEventListener");
      let attempts = 0;
      let suppliedSignal: AbortSignal | undefined;
      const injectedFetch: typeof fetch = async (_input, init) => {
        attempts += 1;
        suppliedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          suppliedSignal?.addEventListener("abort", () => {
            reject(new DOMException("synthetic secret detail", "AbortError"));
          });
        });
      };

      const result = createClient(injectedFetch).searchProducts("melk", 10, caller.signal);
      const rejection = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(suppliedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(suppliedSignal?.aborted).toBe(true);
      expect(attempts).toBe(1);
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([429, 502, 503, 504])("retries status %s exactly once", async (status) => {
    let attempts = 0;
    const injectedFetch: typeof fetch = async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ private: API_KEY }, status) : jsonResponse({ data: [] });
    };

    await expect(createClient(injectedFetch).searchProducts("melk", 10)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it("honors Retry-After before making the single retry", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const injectedFetch: typeof fetch = async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { headers: { "retry-after": "2" }, status: 429 })
          : jsonResponse({ data: [] });
      };
      const result = createClient(injectedFetch).searchProducts("melk", 10);

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual([]);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a Retry-After wait without issuing the retry", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      let attempts = 0;
      const injectedFetch: typeof fetch = async () => {
        attempts += 1;
        return new Response(null, { headers: { "retry-after": "2" }, status: 429 });
      };
      const result = createClient(injectedFetch).searchProducts("melk", 10, caller.signal);
      const rejection = expect(result).rejects.toMatchObject({ code: "CANCELLED" });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      caller.abort("cancel retry wait");
      await rejection;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a bounded fallback delay when Retry-After is absent", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const injectedFetch: typeof fetch = async () => {
        attempts += 1;
        return attempts === 1 ? new Response(null, { status: 503 }) : jsonResponse({ data: [] });
      };
      const result = createClient(injectedFetch).searchProducts("melk", 10);

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual([]);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry earlier than an excessive Retry-After window", async () => {
    const injectedFetch = vi.fn<typeof fetch>(async () =>
      new Response(null, { headers: { "retry-after": "120" }, status: 429 }));

    await expect(createClient(injectedFetch).searchProducts("melk", 10)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(injectedFetch).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry and returns a sanitized public error", async () => {
    const injectedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ header: `Bearer ${API_KEY}`, body: "private-upstream-body" }, 503),
    );

    const error = await createClient(injectedFetch).getBulkPrices([EAN]).catch(
      (caught: unknown) => caught,
    );

    expect(injectedFetch).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("private-upstream-body");
  });

  it.each([400, 401, 404, 500])("does not retry status %s", async (status) => {
    const injectedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ secret: API_KEY }, status));

    await expect(createClient(injectedFetch).searchProducts("melk", 10)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(injectedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not call upstream for an empty bulk request", async () => {
    const injectedFetch = vi.fn<typeof fetch>();

    await expect(createClient(injectedFetch).getBulkPrices([])).resolves.toEqual([]);
    expect(injectedFetch).not.toHaveBeenCalled();
  });
});
