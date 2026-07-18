import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

interface InstallEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike {
  request: Request;
  respondWith(promise: Promise<Response>): void;
  waitUntil?(promise: Promise<unknown>): void;
}

interface MessageEventLike {
  data: unknown;
  ports: Array<{ postMessage(value: unknown): void }>;
  waitUntil(promise: Promise<unknown>): void;
}

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async put(request: string | Request, response: Response): Promise<void> {
    this.entries.set(typeof request === "string" ? request : request.url, response);
  }

  async match(request: string | Request): Promise<Response | undefined> {
    const response = this.entries.get(typeof request === "string" ? request : request.url);
    return response === undefined ? undefined : cloneResponseMetadata(response);
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  async delete(request: string | Request): Promise<boolean> {
    return this.entries.delete(typeof request === "string" ? request : request.url);
  }
}

function cloneResponseMetadata(response: Response): Response {
  const clone = Response.prototype.clone.call(response);
  Object.defineProperties(clone, {
    clone: { configurable: true, value: () => cloneResponseMetadata(clone) },
    redirected: { configurable: true, value: response.redirected },
    url: { configurable: true, value: response.url },
  });
  return clone;
}

function responseAt(
  path: string,
  body: BodyInit | null,
  init: ResponseInit & { redirected?: boolean; responseUrl?: string } = {},
): Response {
  const { redirected = false, responseUrl = path, ...responseInit } = init;
  const response = new Response(body, responseInit);
  Object.defineProperties(response, {
    clone: { configurable: true, value: () => cloneResponseMetadata(response) },
    redirected: { configurable: true, value: redirected },
    url: { configurable: true, value: new URL(responseUrl, "https://handle.test").href },
  });
  return response;
}

async function bootstrapResponse({
  corrupt = false,
  contentType = "application/javascript; charset=utf-8",
  includeContentLength = true,
  status = 200,
}: {
  corrupt?: boolean;
  contentType?: string;
  includeContentLength?: boolean;
  status?: number;
} = {}): Promise<Response> {
  const expected = await readFile(
    new URL("../public/zod-jitless-v1.js", import.meta.url),
    "utf8",
  );
  const body = corrupt ? `x${expected.slice(1)}` : expected;
  return responseAt("/zod-jitless-v1.js", body, {
    headers: {
      ...(includeContentLength
        ? { "content-length": String(new TextEncoder().encode(body).byteLength) }
        : {}),
      "content-type": contentType,
    },
    status,
  });
}

const TEST_BUILD_ID = `hpv2-${"a".repeat(64)}`;
const PRIOR_BUILD_ID = `hpv2-${"b".repeat(64)}`;

async function materializedServiceWorkerSource(buildId = TEST_BUILD_ID): Promise<string> {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const placeholder = "__HANDLEPLAN_PUBLIC_BUILD_ID__";
  if (source.split(placeholder).length !== 2) {
    throw new Error("service-worker test fixture requires exactly one build placeholder");
  }
  return source.replace(placeholder, buildId);
}

function handleDocument(contents: string, buildId = TEST_BUILD_ID): string {
  return `<!doctype html><html><head>
    <meta content="${buildId}" name="handleplan-public-build-id">
    </head><body>${contents}</body></html>`;
}

async function populateReadyShellCache(
  cache: MemoryCache,
  documentText: string,
  staticPaths: readonly string[],
): Promise<void> {
  cache.entries.clear();
  await cache.put("/planlegg/handle", responseAt("/planlegg/handle", documentText, {
    headers: { "content-type": "text/html; charset=utf-8" },
    status: 200,
  }));
  await cache.put("/manifest.webmanifest", responseAt(
    "/manifest.webmanifest",
    "{}",
    { headers: { "content-type": "application/manifest+json" }, status: 200 },
  ));
  for (const path of ["/icons/handleplan.svg", "/icons/handleplan-maskable.svg"]) {
    await cache.put(path, responseAt(path, "<svg/>", {
      headers: { "content-type": "image/svg+xml" },
      status: 200,
    }));
  }
  await cache.put("/zod-jitless-v1.js", await bootstrapResponse());
  for (const path of staticPaths) {
    await cache.put(path, responseAt(path, "asset", {
      headers: {
        "content-type": path.endsWith(".css") ? "text/css" : "application/javascript",
      },
      status: 200,
    }));
  }
}

function serviceWorkerLocation(buildId = TEST_BUILD_ID) {
  return {
    href: `https://handle.test/sw.js?build=${buildId}`,
    origin: "https://handle.test",
  };
}

function serviceWorkerRegistration(buildId = TEST_BUILD_ID) {
  return { active: { scriptURL: serviceWorkerLocation(buildId).href } };
}

describe("static Handlemodus service-worker policy", () => {
  it("caches only bounded shell/static assets and bypasses private or provider requests", async () => {
    const rawSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const source = await materializedServiceWorkerSource();

    expect(rawSource).toContain('const EMBEDDED_PUBLIC_BUILD_ID = "__HANDLEPLAN_PUBLIC_BUILD_ID__"');
    expect(source).toContain("const MAX_CACHE_ENTRIES = 64");
    expect(source).toContain("const MAX_SHELL_DOCUMENT_BYTES = 1024 * 1024");
    expect(source).toContain("const CACHE_REVISION = PUBLIC_BUILD_ID");
    expect(source).toContain("SERVICE_WORKER_URL.searchParams.size !== 1");
    expect(source).toContain("REQUESTED_PUBLIC_BUILD_ID !== EMBEDDED_PUBLIC_BUILD_ID");
    expect(source).toContain("documentHasExactBuildMarker(documentText)");
    expect(source).toContain('Object.freeze(["/zod-jitless-v1.js"])');
    expect(source).toContain("request.method !== \"GET\"");
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain("url.search !== \"\"");
    expect(source).toContain("url.pathname.startsWith(\"/api/\")");
    expect(source).toContain("url.pathname.startsWith(\"/provider/\")");
    expect(source).toContain("url.pathname.startsWith(\"/_next/static/\")");
    expect(source).toContain("APP_SHELL_PATHS.includes(url.pathname)");
    expect(source).toContain("removable.slice(0, overflow)");
    expect(source).toContain("APP_SHELL_PATHS.includes(url.pathname)");
    expect(source).not.toContain("indexedDB");
    expect(source).not.toMatch(/localStorage|sessionStorage|latitude|longitude|originAddress/);
  });

  it("purges only superseded Handlemodus caches", async () => {
    const source = await materializedServiceWorkerSource();
    expect(source).toContain(
      "name.startsWith(CACHE_PREFIX) && !ACTIVE_CACHE_NAMES.includes(name)",
    );
    expect(source).toContain("caches.delete(name)");
  });

  it("rejects a registration query that does not match the embedded sealed build", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, unknown>();
    const deleteCache = vi.fn(async () => true);
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: deleteCache,
        keys: vi.fn(async () => []),
        open: vi.fn(async () => new MemoryCache()),
      },
      fetch: vi.fn(),
      self: {
        addEventListener: (name: string, listener: unknown) => listeners.set(name, listener),
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(PRIOR_BUILD_ID),
        skipWaiting: vi.fn(async () => undefined),
      },
    });

    expect(() => vm.runInContext(source, context)).toThrow(
      "service worker identity does not match its sealed build",
    );
    expect(listeners.size).toBe(0);
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("behaviorally bypasses API, non-GET, query, external, and provider requests", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: FetchEventLike) => void>();
    const cache = new MemoryCache();
    const fetchMock = vi.fn(async () => responseAt("/planlegg/handle", "network", {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    }));
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => [`handleplan-handlemodus-${TEST_BUILD_ID}-shell`]),
        open: vi.fn(async () => cache),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: FetchEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);
    const fetchListener = listeners.get("fetch");
    expect(fetchListener).toBeDefined();

    const bypassed = [
      new Request("https://handle.test/api"),
      new Request("https://handle.test/api/health"),
      new Request("https://handle.test/planlegg/handle", { method: "POST" }),
      new Request("https://handle.test/planlegg/handle?private=1"),
      new Request("https://provider.example/planlegg/handle"),
      new Request("https://handle.test/provider"),
      new Request("https://handle.test/provider/private"),
      new Request("https://handle.test/providers"),
      new Request("https://handle.test/providers/private"),
    ];
    for (const request of bypassed) {
      let response: Promise<Response> | undefined;
      fetchListener?.({ request, respondWith: (promise) => { response = promise; } });
      expect(response, request.url).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.entries.size).toBe(0);

    let shellResponse: Promise<Response> | undefined;
    const shell = new Request("https://handle.test/planlegg/handle");
    fetchListener?.({ request: shell, respondWith: (promise) => { shellResponse = promise; } });
    await expect(shellResponse).resolves.toHaveProperty("status", 200);
    expect(fetchMock).toHaveBeenCalledWith(shell);
    expect(cache.entries.has(shell.url)).toBe(false);
  });

  it("never runtime-caches redirected, mistyped, or arbitrary icon responses", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: FetchEventLike) => void>();
    const cache = new MemoryCache();
    const fetchMock = vi.fn<() => Promise<Response>>();
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => []),
        open: vi.fn(async () => cache),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: FetchEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration: serviceWorkerRegistration(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);
    const fetchListener = listeners.get("fetch");
    const icon = new Request("https://handle.test/icons/handleplan.svg");
    const invalidResponses = [
      responseAt("/icons/handleplan.svg", "private redirect", {
        headers: { "content-type": "text/html" },
        redirected: true,
        responseUrl: "/provider/private",
        status: 200,
      }),
      responseAt("/icons/handleplan.svg", "private html", {
        headers: { "content-type": "text/html" },
        status: 200,
      }),
    ];
    for (const invalidResponse of invalidResponses) {
      await cache.put(icon, invalidResponse);
      fetchMock.mockResolvedValueOnce(invalidResponse);
      let response: Promise<Response> | undefined;
      fetchListener?.({ request: icon, respondWith: (promise) => { response = promise; } });
      await expect(response).resolves.toHaveProperty("status", 200);
      expect(cache.entries.has(icon.url)).toBe(false);
    }

    const arbitraryIcon = new Request("https://handle.test/icons/private.svg");
    let arbitraryResponse: Promise<Response> | undefined;
    fetchListener?.({
      request: arbitraryIcon,
      respondWith: (promise) => { arbitraryResponse = promise; },
    });
    expect(arbitraryResponse).toBeUndefined();
    expect(cache.entries.has(arbitraryIcon.url)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects lengthless oversized shell documents before caching or offline fallback", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: FetchEventLike) => void>();
    const cache = new MemoryCache();
    const oversizedDocument = `<!doctype html>${"x".repeat(1024 * 1024)}`;
    let offline = false;
    const fetchMock = vi.fn(async () => {
      if (offline) throw new Error("offline");
      return responseAt("/planlegg/handle", oversizedDocument, {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
      });
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => [`handleplan-handlemodus-${TEST_BUILD_ID}-shell`]),
        open: vi.fn(async () => cache),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: FetchEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration: serviceWorkerRegistration(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    const shell = new Request("https://handle.test/planlegg/handle");
    let onlineResponse: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: shell,
      respondWith: (promise) => { onlineResponse = promise; },
    });
    await expect(onlineResponse).resolves.toHaveProperty("status", 200);
    expect(cache.entries.has(shell.url)).toBe(false);

    await cache.put("/planlegg/handle", responseAt("/planlegg/handle", oversizedDocument, {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    }));
    offline = true;
    let offlineResponse: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: shell,
      respondWith: (promise) => { offlineResponse = promise; },
    });
    await expect(offlineResponse).rejects.toThrow("offline");
    expect(cache.entries.has("/planlegg/handle")).toBe(false);
  });

  it("keeps the installed offline document immutable during an ordinary online navigation", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: FetchEventLike) => void>();
    const cache = new MemoryCache();
    const shell = new Request("https://handle.test/planlegg/handle");
    const knownGoodDocument = handleDocument(
      '<script src="/_next/static/chunks/known-good.js"></script>',
    );
    await populateReadyShellCache(
      cache,
      knownGoodDocument,
      ["/_next/static/chunks/known-good.js"],
    );
    const replacementDocument = handleDocument(
      '<script src="/_next/static/chunks/not-yet-published.js"></script>',
    );
    const fetchMock = vi.fn(async () => responseAt(
      "/planlegg/handle",
      replacementDocument,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
      },
    ));
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => [`handleplan-handlemodus-${TEST_BUILD_ID}-shell`]),
        open: vi.fn(async () => cache),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: FetchEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration: serviceWorkerRegistration(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    let onlineResponse: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: shell,
      respondWith: (promise) => { onlineResponse = promise; },
    });
    await expect(onlineResponse).resolves.toHaveProperty("status", 200);
    expect(await (await onlineResponse)?.text()).toBe(replacementDocument);
    expect(await (await cache.match("/planlegg/handle"))?.text()).toBe(knownGoodDocument);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(responseAt("/planlegg/handle", "upstream unavailable", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 503,
    }));
    let outageResponse: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: shell,
      respondWith: (promise) => { outageResponse = promise; },
    });
    await expect(outageResponse).resolves.toHaveProperty("status", 200);
    expect(await (await outageResponse)?.text()).toBe(knownGoodDocument);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts immutable entries before the offline shell when the cache reaches its bound", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: FetchEventLike) => void>();
    const shellCache = new MemoryCache();
    const runtimeCache = new MemoryCache();
    const requiredStaticPath = "/_next/static/chunks/handle-required.js";
    const shellPaths = [
      "/planlegg/handle",
      "/manifest.webmanifest",
      "/icons/handleplan.svg",
      "/icons/handleplan-maskable.svg",
      "/zod-jitless-v1.js",
    ];
    await populateReadyShellCache(
      shellCache,
      handleDocument(`<script src="${requiredStaticPath}"></script>`),
      [requiredStaticPath],
    );
    for (let index = 0; index < 64; index += 1) {
      await runtimeCache.put(`/_next/static/chunks/existing-${index}.js`, new Response("asset"));
    }
    expect(runtimeCache.entries.size).toBe(64);

    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => [`handleplan-handlemodus-${TEST_BUILD_ID}-shell`]),
        open: vi.fn(async (name: string) =>
          name.endsWith("-shell") ? shellCache : runtimeCache),
      },
      fetch: vi.fn(async () => responseAt("/_next/static/chunks/new.js", "new asset", {
        headers: { "content-type": "application/javascript" },
        status: 200,
      })),
      self: {
        addEventListener: (name: string, listener: (event: FetchEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration: serviceWorkerRegistration(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    const request = new Request("https://handle.test/_next/static/chunks/new.js");
    let response: Promise<Response> | undefined;
    listeners.get("fetch")?.({ request, respondWith: (promise) => { response = promise; } });
    await response;

    expect(runtimeCache.entries.size).toBe(64);
    expect(runtimeCache.entries.has(request.url)).toBe(true);
    expect(runtimeCache.entries.has("/_next/static/chunks/existing-0.js")).toBe(false);
    for (const path of shellPaths) expect(shellCache.entries.has(path)).toBe(true);
    expect(shellCache.entries.has(requiredStaticPath)).toBe(true);
  });

  it("warms the Handlemodus route's same-origin hashed assets during install", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: InstallEventLike) => void>();
    const cache = new MemoryCache();
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (input: string | Request) => {
      const value = typeof input === "string" ? input : input.url;
      fetched.push(value);
      if (value === "/planlegg/handle") {
        return responseAt(value, handleDocument(`
          <!-- <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
               <script src="/_next/static/chunks/comment-forged.js"></script> -->
          <script>self.fakeMarkup = '<meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id"><link href="/_next/static/css/script-forged.css">'</script>
          <script src="/_next/static/chunks/handle-abc.js"></script>
          <link rel="stylesheet" href="/_next/static/css/handle-def.css">
          <script src="/_next/static/chunks/query.js?private=1"></script>
          <script src="https://provider.example/_next/static/external.js"></script>
          <script src="/api/private"></script>`), {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }
      if (value === "/") {
        return responseAt(value, `<!doctype html>${Array.from(
          { length: 60 },
          (_, index) => `<script src="/_next/static/chunks/home-${String(index).padStart(2, "0")}.js"></script>`,
        ).join("")}`, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }
      if (value === "/zod-jitless-v1.js") return bootstrapResponse();
      return responseAt(value, value.startsWith("/_next/static/") ? "asset" : "<!doctype html>", {
        headers: {
          "content-type": value.endsWith(".js")
            ? "application/javascript"
            : value.endsWith(".css")
              ? "text/css"
              : value.startsWith("/icons/")
                ? "image/svg+xml"
                : value === "/manifest.webmanifest"
                  ? "application/manifest+json"
                  : "text/html; charset=utf-8",
        },
        status: 200,
      });
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => []),
        open: vi.fn(async () => cache),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: InstallEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    let installation: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil: (promise) => { installation = promise; } });
    await installation;

    expect(fetched).toContain("/_next/static/chunks/handle-abc.js");
    expect(fetched).toContain("/_next/static/css/handle-def.css");
    expect(fetched).toContain("/zod-jitless-v1.js");
    expect(fetched).not.toContain("/_next/static/chunks/query.js?private=1");
    expect(fetched).not.toContain("https://provider.example/_next/static/external.js");
    expect(fetched).not.toContain("/api/private");
    expect(fetched).not.toContain("/_next/static/chunks/comment-forged.js");
    expect(fetched).not.toContain("/_next/static/css/script-forged.css");
    expect(cache.entries.has("/_next/static/chunks/handle-abc.js")).toBe(true);
    expect(cache.entries.has("/_next/static/css/handle-def.css")).toBe(true);
    expect(cache.entries.has("/zod-jitless-v1.js")).toBe(true);
    expect([...cache.entries.keys()].filter((key) => key.includes("/home-")).length)
      .toBeLessThan(60);
    expect(cache.entries.size).toBeLessThanOrEqual(64);
  });

  it.each([
    ["comment", `<!doctype html><html><head><!--
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      --></head><body></body></html>`],
    ["script", `<!doctype html><html><head><script>
      self.forged = '<meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">';
      </script></head><body></body></html>`],
    ["nested template", `<!doctype html><html><head><template><template></template>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </template></head><body></body></html>`],
    ["body after an unclosed head", `<!doctype html><html><head><body>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </body></html>`],
    ["flow content that implicitly closes head", `<!doctype html><html><head><div>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </div></head><body></body></html>`],
    ["foreign SVG content", `<!doctype html><html><head><svg>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </svg></head><body></body></html>`],
    ["plaintext content", `<!doctype html><html><head><plaintext>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">`],
    ["nominally self-closing script text", `<!doctype html><html><head><script/>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </script></head><body></body></html>`],
    ["nominally self-closing style text", `<!doctype html><html><head><style/>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </style></head><body></body></html>`],
    ["unexpected closing body in head", `<!doctype html><html><head></body>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["unexpected closing html in head", `<!doctype html><html><head></html>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["unexpected closing br in head", `<!doctype html><html><head></br>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["body before the explicit head", `<!doctype html><html><body><head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head></body></html>`],
    ["flow content before the explicit head", `<!doctype html><html><div></div><head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["foreign content before the explicit head", `<!doctype html><html><svg></svg><head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["closing body before the explicit head", `<!doctype html><html></body><head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["closing html before the explicit head", `<!doctype html><html></html><head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["closing br before the explicit head", `<!doctype html><html></br><head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["text before the explicit head", `<!doctype html><html>X<head>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["text inside the explicit head", `<!doctype html><html><head>X
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["entity text inside the explicit head", `<!doctype html><html><head>&nbsp;
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["script double-escaped state", `<!doctype html><html><head><script><!--<script></script>
      <meta content="${TEST_BUILD_ID}" name="handleplan-public-build-id">
      </head><body></body></html>`],
    ["slash in an unquoted attribute value", `<!doctype html><html><head>
      <meta name=handleplan-public-build-id content=${TEST_BUILD_ID}/>
      </head><body></body></html>`],
    ["canonical-first duplicate marker name", `<!doctype html><html><head>
      <meta name="handleplan-public-build-id" content="${TEST_BUILD_ID}">
      <meta name="handleplan-public-build-id" name="other" content="${TEST_BUILD_ID}">
      </head><body></body></html>`],
    ["character-reference marker name in head", `<!doctype html><html><head>
      <meta name="handleplan-public-build-id" content="${TEST_BUILD_ID}">
      <meta name="handleplan-public-build&#45;id" content="${TEST_BUILD_ID}">
      </head><body></body></html>`],
    ["character-reference marker name in body", `<!doctype html><html><head>
      <meta name="handleplan-public-build-id" content="${TEST_BUILD_ID}">
      </head><body>
      <meta name="handleplan-public-build&#45;id" content="${TEST_BUILD_ID}">
      </body></html>`],
    ["dot-suffixed meta-like tag name", `<!doctype html><html><head>
      <meta.foo name="handleplan-public-build-id" content="${TEST_BUILD_ID}">
      </head><body></body></html>`],
    ["underscore-suffixed meta-like tag name", `<!doctype html><html><head>
      <meta_foo name="handleplan-public-build-id" content="${TEST_BUILD_ID}">
      </head><body></body></html>`],
    ["at-suffixed meta-like tag name", `<!doctype html><html><head>
      <meta@foo name="handleplan-public-build-id" content="${TEST_BUILD_ID}">
      </head><body></body></html>`],
  ])("does not accept a build marker serialized inside a %s", async (_location, documentText) => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: InstallEventLike) => void>();
    const cache = new MemoryCache();
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => []),
        open: vi.fn(async () => cache),
      },
      fetch: vi.fn(async (input: string | Request) => {
        const value = typeof input === "string" ? input : new URL(input.url).pathname;
        return responseAt(value, documentText, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }),
      self: {
        addEventListener: (name: string, listener: (event: InstallEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    let installation: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil: (promise) => { installation = promise; } });
    await expect(installation).rejects.toThrow(
      "required Handlemodus shell response is invalid: /planlegg/handle",
    );
  });

  it.each([
    ["redirected icon", "/icons/handleplan.svg", () => responseAt(
      "/icons/handleplan.svg",
      "<svg/>",
      {
        headers: { "content-type": "image/svg+xml" },
        redirected: true,
        responseUrl: "/provider/private",
        status: 200,
      },
    )],
    ["mistyped manifest", "/manifest.webmanifest", () => responseAt(
      "/manifest.webmanifest",
      "<!doctype html>private response",
      { headers: { "content-type": "text/html" }, status: 200 },
    )],
    ["redirected bootstrap", "/zod-jitless-v1.js", async () => {
      const response = await bootstrapResponse();
      return responseAt("/zod-jitless-v1.js", await response.text(), {
        headers: { "content-type": "application/javascript" },
        redirected: true,
        responseUrl: "/review/private",
        status: 200,
      });
    }],
  ])("preserves the prior cache when install receives a %s", async (
    _failure,
    invalidPath,
    invalidResponse,
  ) => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: InstallEventLike) => void>();
    const cachesByName = new Map<string, MemoryCache>();
    const priorCache = new MemoryCache();
    const priorShellCacheName = `handleplan-handlemodus-${PRIOR_BUILD_ID}-shell`;
    const currentShellCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-shell`;
    const currentRuntimeCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-runtime`;
    await priorCache.put("/planlegg/handle", new Response("known-good-prior-shell"));
    cachesByName.set(priorShellCacheName, priorCache);
    const fetchMock = vi.fn(async (input: string | Request) => {
      const value = typeof input === "string" ? input : new URL(input.url).pathname;
      if (value === invalidPath) return invalidResponse();
      if (value === "/planlegg/handle") {
        return responseAt(value, handleDocument(
          '<script src="/_next/static/chunks/required.js"></script>',
        ), { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 });
      }
      if (value === "/_next/static/chunks/required.js") {
        return responseAt(value, "asset", {
          headers: { "content-type": "application/javascript" },
          status: 200,
        });
      }
      if (value === "/zod-jitless-v1.js") return bootstrapResponse();
      return responseAt(value, value.startsWith("/icons/") ? "<svg/>" : "<!doctype html>", {
        headers: {
          "content-type": value.startsWith("/icons/")
            ? "image/svg+xml"
            : value === "/manifest.webmanifest"
              ? "application/manifest+json"
              : "text/html",
        },
        status: 200,
      });
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async (name: string) => cachesByName.delete(name)),
        keys: vi.fn(async () => [...cachesByName.keys()]),
        open: vi.fn(async (name: string) => {
          const existing = cachesByName.get(name);
          if (existing !== undefined) return existing;
          const created = new MemoryCache();
          cachesByName.set(name, created);
          return created;
        }),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: InstallEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    let installation: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil: (promise) => { installation = promise; } });
    await expect(installation).rejects.toThrow("required Handlemodus shell response is invalid");
    expect(cachesByName.get(priorShellCacheName)).toBe(priorCache);
    expect(cachesByName.has(currentShellCacheName)).toBe(false);
    expect(cachesByName.has(currentRuntimeCacheName)).toBe(false);
  });

  it("keeps the prior offline cache when the next revision cannot install transactionally", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: InstallEventLike) => void>();
    const cachesByName = new Map<string, MemoryCache>();
    const priorCache = new MemoryCache();
    await priorCache.put("/planlegg/handle", new Response("known-good-prior-shell"));
    const priorShellCacheName = `handleplan-handlemodus-${PRIOR_BUILD_ID}-shell`;
    const currentShellCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-shell`;
    const currentRuntimeCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-runtime`;
    cachesByName.set(priorShellCacheName, priorCache);
    const skipWaiting = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: string | Request) => {
      const value = typeof input === "string" ? input : new URL(input.url).pathname;
      if (value === "/planlegg/handle") {
        return responseAt(value, handleDocument(
          '<script src="/_next/static/chunks/required-but-unavailable.js"></script>',
        ), {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }
      if (value === "/_next/static/chunks/required-but-unavailable.js") {
        return responseAt(value, "unavailable", {
          headers: { "content-type": "application/javascript" },
          status: 503,
        });
      }
      if (value === "/zod-jitless-v1.js") return bootstrapResponse();
      return responseAt(value, value.startsWith("/icons/") ? "<svg/>" : "<!doctype html>", {
        headers: {
          "content-type": value.startsWith("/icons/")
            ? "image/svg+xml"
            : value === "/manifest.webmanifest"
              ? "application/manifest+json"
              : "text/html; charset=utf-8",
        },
        status: 200,
      });
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async (name: string) => cachesByName.delete(name)),
        keys: vi.fn(async () => [...cachesByName.keys()]),
        open: vi.fn(async (name: string) => {
          const existing = cachesByName.get(name);
          if (existing !== undefined) return existing;
          const created = new MemoryCache();
          cachesByName.set(name, created);
          return created;
        }),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: (event: InstallEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        skipWaiting,
      },
    });
    vm.runInContext(source, context);

    let installation: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil: (promise) => { installation = promise; } });
    await expect(installation).rejects.toThrow(
      "required Handlemodus static asset is invalid",
    );
    expect(skipWaiting).not.toHaveBeenCalled();
    expect(cachesByName.get(priorShellCacheName)).toBe(priorCache);
    expect(cachesByName.has(currentShellCacheName)).toBe(false);
    expect(cachesByName.has(currentRuntimeCacheName)).toBe(false);
  });

  it("repairs an evicted active shell online without activating a new build or exposing a partial repair", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, unknown>();
    const cachesByName = new Map<string, MemoryCache>();
    const currentShellCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-shell`;
    const repairShellCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-repair-shell`;
    const currentCache = new MemoryCache();
    const requiredStaticPath = "/_next/static/chunks/repair-required.js";
    const currentDocument = handleDocument(
      `<script src="${requiredStaticPath}"></script>`,
    );
    await populateReadyShellCache(currentCache, currentDocument, [requiredStaticPath]);
    await currentCache.delete(requiredStaticPath);
    const incompleteCurrentKeys = [...currentCache.entries.keys()].sort();
    cachesByName.set(currentShellCacheName, currentCache);

    let failRequiredAsset = true;
    let offline = false;
    let concurrentKeysCalls = 0;
    let holdRedundantKeys = false;
    let releaseStaleKeys: (() => void) | undefined;
    const keysMock = vi.fn(() => {
      const snapshot = [...cachesByName.keys()];
      if (holdRedundantKeys) {
        concurrentKeysCalls += 1;
        if (concurrentKeysCalls === 2) {
          return new Promise<string[]>((resolve) => {
            releaseStaleKeys = () => resolve(snapshot);
          });
        }
      }
      return Promise.resolve(snapshot);
    });
    const fetchMock = vi.fn(async (input: string | Request) => {
      if (offline) throw new Error("offline");
      const value = typeof input === "string" ? input : new URL(input.url).pathname;
      if (value === "/planlegg/handle") {
        return responseAt(value, currentDocument, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }
      if (value === "/manifest.webmanifest") {
        return responseAt(value, "{}", {
          headers: { "content-type": "application/manifest+json" },
          status: 200,
        });
      }
      if (value === "/zod-jitless-v1.js") return bootstrapResponse();
      if (value === requiredStaticPath) {
        return responseAt(value, failRequiredAsset ? "unavailable" : "asset", {
          headers: { "content-type": "application/javascript" },
          status: failRequiredAsset ? 503 : 200,
        });
      }
      if (value.startsWith("/icons/")) {
        return responseAt(value, "<svg/>", {
          headers: { "content-type": "image/svg+xml" },
          status: 200,
        });
      }
      throw new Error(`unexpected repair fetch: ${value}`);
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async (name: string) => cachesByName.delete(name)),
        keys: keysMock,
        open: vi.fn(async (name: string) => {
          const existing = cachesByName.get(name);
          if (existing !== undefined) return existing;
          const created = new MemoryCache();
          cachesByName.set(name, created);
          return created;
        }),
      },
      fetch: fetchMock,
      self: {
        addEventListener: (name: string, listener: unknown) => listeners.set(name, listener),
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration: serviceWorkerRegistration(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    const requestReadiness = async () => {
      const responses: unknown[] = [];
      let proof: Promise<unknown> | undefined;
      const listener = listeners.get("message") as ((event: MessageEventLike) => void) | undefined;
      listener?.({
        data: {
          buildId: TEST_BUILD_ID,
          kind: "handleplan:handle-mode-offline-ready:v1",
        },
        ports: [{ postMessage: (value) => responses.push(value) }],
        waitUntil: (promise) => { proof = promise; },
      });
      await proof;
      return responses.at(-1);
    };

    await expect(requestReadiness()).resolves.toEqual({
      buildId: TEST_BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: false,
    });
    expect(cachesByName.has(repairShellCacheName)).toBe(false);
    expect([...currentCache.entries.keys()].sort()).toEqual(incompleteCurrentKeys);

    failRequiredAsset = false;
    holdRedundantKeys = true;
    const firstRepair = requestReadiness();
    const redundantRepair = requestReadiness();
    await expect(firstRepair).resolves.toEqual({
      buildId: TEST_BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    });
    // A stale second precheck in the old implementation resumes only after the
    // successful first repair has cleared the single-flight slot. Make any
    // resulting destructive replacement fail so the race is deterministic.
    failRequiredAsset = true;
    releaseStaleKeys?.();
    await expect(redundantRepair).resolves.toEqual({
      buildId: TEST_BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    });
    expect(concurrentKeysCalls).toBe(1);
    holdRedundantKeys = false;
    expect(fetchMock.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : new URL(input.url).pathname) === requiredStaticPath))
      .toHaveLength(2);
    const repairCache = cachesByName.get(repairShellCacheName);
    expect(repairCache).toBeDefined();
    expect(repairCache?.entries.has(requiredStaticPath)).toBe(true);
    expect([...currentCache.entries.keys()].sort()).toEqual(incompleteCurrentKeys);

    offline = true;
    const shellRequest = new Request("https://handle.test/planlegg/handle");
    let response: Promise<Response> | undefined;
    let maintenance: Promise<unknown> | undefined;
    const fetchListener = listeners.get("fetch") as ((event: FetchEventLike) => void) | undefined;
    fetchListener?.({
      request: shellRequest,
      respondWith: (promise) => { response = promise; },
      waitUntil: (promise) => { maintenance = promise; },
    });
    await expect(response).resolves.toHaveProperty("status", 200);
    expect(await (await response)?.text()).toBe(currentDocument);
    await expect(maintenance).resolves.toBe(true);
  });

  it("does not recreate a retired generation cache from an in-flight shell request", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: MessageEventLike) => void>();
    const shellCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-shell`;
    const cachesByName = new Map([[shellCacheName, new MemoryCache()]]);
    const registration = serviceWorkerRegistration();
    let releaseKeys: (() => void) | undefined;
    const keys = vi.fn(() => {
      const snapshot = [...cachesByName.keys()];
      return new Promise<string[]>((resolve) => {
        releaseKeys = () => resolve(snapshot);
      });
    });
    const openCache = vi.fn(async (name: string) => {
      const cache = new MemoryCache();
      cachesByName.set(name, cache);
      return cache;
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async (name: string) => cachesByName.delete(name)),
        keys,
        open: openCache,
      },
      fetch: vi.fn(async () => { throw new Error("retired readiness must not fetch"); }),
      self: {
        addEventListener: (name: string, listener: (event: MessageEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration,
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    const responses: unknown[] = [];
    let readiness: Promise<unknown> | undefined;
    listeners.get("message")?.({
      data: {
        buildId: TEST_BUILD_ID,
        kind: "handleplan:handle-mode-offline-ready:v1",
      },
      ports: [{ postMessage: (value) => responses.push(value) }],
      waitUntil: (promise) => { readiness = promise; },
    });
    expect(releaseKeys).toBeDefined();
    registration.active.scriptURL = serviceWorkerLocation(PRIOR_BUILD_ID).href;
    cachesByName.clear();
    releaseKeys?.();

    await readiness;
    expect(responses).toEqual([{
      buildId: TEST_BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: false,
    }]);
    expect([...cachesByName.keys()]).toEqual([]);
    expect(openCache).toHaveBeenCalledWith(shellCacheName);
  });

  it("deletes a retired shell cache if ownership changes while it is being opened", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: MessageEventLike) => void>();
    const shellCacheName = `handleplan-handlemodus-${TEST_BUILD_ID}-shell`;
    const cachesByName = new Map([[shellCacheName, new MemoryCache()]]);
    const registration = serviceWorkerRegistration();
    const deleteCache = vi.fn(async (name: string) => cachesByName.delete(name));
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: deleteCache,
        keys: vi.fn(async () => [...cachesByName.keys()]),
        open: vi.fn(async (name: string) => {
          const cache = cachesByName.get(name) ?? new MemoryCache();
          cachesByName.set(name, cache);
          registration.active.scriptURL = serviceWorkerLocation(PRIOR_BUILD_ID).href;
          return cache;
        }),
      },
      fetch: vi.fn(async () => { throw new Error("retired readiness must not fetch"); }),
      self: {
        addEventListener: (name: string, listener: (event: MessageEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        registration,
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    const responses: unknown[] = [];
    let readiness: Promise<unknown> | undefined;
    listeners.get("message")?.({
      data: {
        buildId: TEST_BUILD_ID,
        kind: "handleplan:handle-mode-offline-ready:v1",
      },
      ports: [{ postMessage: (value) => responses.push(value) }],
      waitUntil: (promise) => { readiness = promise; },
    });
    await readiness;

    expect(responses).toEqual([{
      buildId: TEST_BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: false,
    }]);
    expect(deleteCache).toHaveBeenCalledWith(shellCacheName);
    expect([...cachesByName.keys()]).toEqual([]);
  });

  it("proves the Handlemodus bootstrap, document, and each referenced static asset before start", async () => {
    const source = await materializedServiceWorkerSource();
    const listeners = new Map<string, (event: MessageEventLike) => void>();
    const cache = new MemoryCache();
    const currentDocument = handleDocument(`
      <script src="/_next/static/chunks/handle-ready.js"></script>
      <link href="/_next/static/css/handle-ready.css" rel="stylesheet">`);
    const populateReadyCache = async () => {
      await populateReadyShellCache(cache, currentDocument, [
        "/_next/static/chunks/handle-ready.js",
        "/_next/static/css/handle-ready.css",
      ]);
    };
    await populateReadyCache();
    const context = vm.createContext({
      URL,
      Request,
      Response,
      crypto: webcrypto,
      caches: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => [`handleplan-handlemodus-${TEST_BUILD_ID}-shell`]),
        open: vi.fn(async () => cache),
      },
      fetch: vi.fn(async () => { throw new Error("readiness must not mutate the installed cache"); }),
      self: {
        addEventListener: (name: string, listener: (event: MessageEventLike) => void) => {
          listeners.set(name, listener);
        },
        clients: { claim: vi.fn(async () => undefined) },
        location: serviceWorkerLocation(),
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    const mismatchedResponses: unknown[] = [];
    let mismatchedProof: Promise<unknown> | undefined;
    listeners.get("message")?.({
      data: {
        buildId: PRIOR_BUILD_ID,
        kind: "handleplan:handle-mode-offline-ready:v1",
      },
      ports: [{ postMessage: (value) => mismatchedResponses.push(value) }],
      waitUntil: (promise) => { mismatchedProof = promise; },
    });
    expect(mismatchedProof).toBeUndefined();
    expect(mismatchedResponses).toEqual([]);

    const requestReadiness = async () => {
      const responses: unknown[] = [];
      let proof: Promise<unknown> | undefined;
      listeners.get("message")?.({
        data: {
          buildId: TEST_BUILD_ID,
          kind: "handleplan:handle-mode-offline-ready:v1",
        },
        ports: [{ postMessage: (value) => responses.push(value) }],
        waitUntil: (promise) => { proof = promise; },
      });
      await proof;
      return responses.at(-1);
    };

    await expect(requestReadiness()).resolves.toEqual({
      buildId: TEST_BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    });

    const invalidCases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      ["bootstrap-corrupt", async () => {
        await cache.put("/zod-jitless-v1.js", await bootstrapResponse({ corrupt: true }));
      }],
      ["bootstrap-mime", async () => {
        await cache.put(
          "/zod-jitless-v1.js",
          await bootstrapResponse({ contentType: "text/html; charset=utf-8" }),
        );
      }],
      ["js-mime", async () => {
        await cache.put("/_next/static/chunks/handle-ready.js", responseAt(
          "/_next/static/chunks/handle-ready.js",
          "asset",
          { headers: { "content-type": "text/html" }, status: 200 },
        ));
      }],
      ["js-redirect", async () => {
        await cache.put("/_next/static/chunks/handle-ready.js", responseAt(
          "/_next/static/chunks/handle-ready.js",
          "asset",
          {
            headers: { "content-type": "application/javascript" },
            redirected: true,
            status: 200,
          },
        ));
      }],
      ["js-url", async () => {
        await cache.put("/_next/static/chunks/handle-ready.js", responseAt(
          "/_next/static/chunks/handle-ready.js",
          "asset",
          {
            headers: { "content-type": "application/javascript" },
            responseUrl: "/login",
            status: 200,
          },
        ));
      }],
      ["css-mime", async () => {
        await cache.put("/_next/static/css/handle-ready.css", responseAt(
          "/_next/static/css/handle-ready.css",
          "asset",
          { headers: { "content-type": "text/html" }, status: 200 },
        ));
      }],
      ["css-redirect", async () => {
        await cache.put("/_next/static/css/handle-ready.css", responseAt(
          "/_next/static/css/handle-ready.css",
          "asset",
          { headers: { "content-type": "text/css" }, redirected: true, status: 200 },
        ));
      }],
      ["css-status", async () => {
        await cache.put("/_next/static/css/handle-ready.css", responseAt(
          "/_next/static/css/handle-ready.css",
          "unavailable",
          { headers: { "content-type": "text/css" }, status: 503 },
        ));
      }],
      ["manifest-missing", async () => {
        await cache.delete("/manifest.webmanifest");
      }],
      ["icon-mime", async () => {
        await cache.put("/icons/handleplan.svg", responseAt(
          "/icons/handleplan.svg",
          "not svg",
          { headers: { "content-type": "text/html" }, status: 200 },
        ));
      }],
      ["document-mime", async () => {
        await cache.put("/planlegg/handle", responseAt(
          "/planlegg/handle",
          currentDocument,
          { headers: { "content-type": "application/javascript" }, status: 200 },
        ));
      }],
      ["document-charset", async () => {
        await cache.put("/planlegg/handle", responseAt(
          "/planlegg/handle",
          currentDocument,
          { headers: { "content-type": "text/html; charset=utf-16le" }, status: 200 },
        ));
      }],
      ["document-redirect", async () => {
        await cache.put("/planlegg/handle", responseAt(
          "/planlegg/handle",
          currentDocument,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
            redirected: true,
            status: 200,
          },
        ));
      }],
      ["document-url", async () => {
        await cache.put("/planlegg/handle", responseAt(
          "/planlegg/handle",
          currentDocument,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
            responseUrl: "/login",
            status: 200,
          },
        ));
      }],
      ["document-build-id", async () => {
        await cache.put("/planlegg/handle", responseAt(
          "/planlegg/handle",
          handleDocument(
            '<script src="/_next/static/chunks/handle-ready.js"></script>',
            PRIOR_BUILD_ID,
          ),
          { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 },
        ));
      }],
      ["document-oversize", async () => {
        await cache.put("/planlegg/handle", responseAt(
          "/planlegg/handle",
          `<!doctype html>${"x".repeat(1024 * 1024)}`,
          { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 },
        ));
      }],
    ];
    for (const [failure, corruptCache] of invalidCases) {
      await populateReadyCache();
      await corruptCache();
      await expect(requestReadiness(), failure).resolves.toEqual({
        buildId: TEST_BUILD_ID,
        kind: "handleplan:handle-mode-offline-ready-result:v1",
        ready: false,
      });
    }
  });
});
