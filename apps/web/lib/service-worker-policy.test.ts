import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

interface InstallEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike {
  request: Request;
  respondWith(promise: Promise<Response>): void;
}

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async put(request: string | Request, response: Response): Promise<void> {
    this.entries.set(typeof request === "string" ? request : request.url, response);
  }

  async match(request: string | Request): Promise<Response | undefined> {
    return this.entries.get(typeof request === "string" ? request : request.url)?.clone();
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  async delete(request: string | Request): Promise<boolean> {
    return this.entries.delete(typeof request === "string" ? request : request.url);
  }
}

describe("static Handlemodus service-worker policy", () => {
  it("caches only bounded shell/static assets and bypasses private or provider requests", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

    expect(source).toContain("const MAX_CACHE_ENTRIES = 64");
    expect(source).toContain("request.method !== \"GET\"");
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain("url.search !== \"\"");
    expect(source).toContain("url.pathname.startsWith(\"/api/\")");
    expect(source).toContain("url.pathname.startsWith(\"/provider/\")");
    expect(source).toContain("url.pathname.startsWith(\"/_next/static/\")");
    expect(source).toContain("APP_SHELL_PATHS.includes(url.pathname)");
    expect(source).toContain("keys.slice(0, overflow)");
    expect(source).not.toContain("indexedDB");
    expect(source).not.toMatch(/localStorage|sessionStorage|latitude|longitude|originAddress/);
  });

  it("purges only superseded Handlemodus caches", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    expect(source).toContain("name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME");
    expect(source).toContain("caches.delete(name)");
  });

  it("behaviorally bypasses API, non-GET, query, external, and provider requests", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map<string, (event: FetchEventLike) => void>();
    const cache = new MemoryCache();
    const fetchMock = vi.fn(async () => new Response("network", {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    }));
    const context = vm.createContext({
      URL,
      Request,
      Response,
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
        location: { origin: "https://handle.test" },
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
    expect(cache.entries.has(shell.url)).toBe(true);
  });

  it("warms the Handlemodus route's same-origin hashed assets during install", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map<string, (event: InstallEventLike) => void>();
    const cache = new MemoryCache();
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (input: string | Request) => {
      const value = typeof input === "string" ? input : input.url;
      fetched.push(value);
      if (value === "/planlegg/handle") {
        return new Response(`<!doctype html>
          <script src="/_next/static/chunks/handle-abc.js"></script>
          <link rel="stylesheet" href="/_next/static/css/handle-def.css">
          <script src="/_next/static/chunks/query.js?private=1"></script>
          <script src="https://provider.example/_next/static/external.js"></script>
          <script src="/api/private"></script>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }
      if (value === "/") {
        return new Response(`<!doctype html>${Array.from(
          { length: 60 },
          (_, index) => `<script src="/_next/static/chunks/home-${String(index).padStart(2, "0")}.js"></script>`,
        ).join("")}`, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      }
      return new Response(value.startsWith("/_next/static/") ? "asset" : "<!doctype html>", {
        headers: {
          "content-type": value.startsWith("/_next/static/")
            ? "application/javascript"
            : "text/html; charset=utf-8",
        },
        status: 200,
      });
    });
    const context = vm.createContext({
      URL,
      Request,
      Response,
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
        location: { origin: "https://handle.test" },
        skipWaiting: vi.fn(async () => undefined),
      },
    });
    vm.runInContext(source, context);

    let installation: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil: (promise) => { installation = promise; } });
    await installation;

    expect(fetched).toContain("/_next/static/chunks/handle-abc.js");
    expect(fetched).toContain("/_next/static/css/handle-def.css");
    expect(fetched).not.toContain("/_next/static/chunks/query.js?private=1");
    expect(fetched).not.toContain("https://provider.example/_next/static/external.js");
    expect(fetched).not.toContain("/api/private");
    expect(cache.entries.has("/_next/static/chunks/handle-abc.js")).toBe(true);
    expect(cache.entries.has("/_next/static/css/handle-def.css")).toBe(true);
    expect([...cache.entries.keys()].filter((key) => key.includes("/home-")).length)
      .toBeLessThan(60);
    expect(cache.entries.size).toBeLessThanOrEqual(64);
  });
});
