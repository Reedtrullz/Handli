/* global self, caches, fetch */

const CACHE_PREFIX = "handleplan-handlemodus-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const MAX_CACHE_ENTRIES = 64;
const MAX_SHELL_DOCUMENT_CHARACTERS = 1024 * 1024;
const HANDLE_MODE_PATH = "/planlegg/handle";
const APP_SHELL_PATHS = Object.freeze([
  "/",
  "/planlegg",
  "/planlegg/handle",
  "/manifest.webmanifest",
  "/icons/handleplan.svg",
  "/icons/handleplan-maskable.svg",
]);

function requestPolicy(request) {
  if (request.method !== "GET") return "bypass";
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return "bypass";
  if (url.search !== "") return "bypass";
  if (
    url.pathname === "/api"
    || url.pathname.startsWith("/api/")
    || url.pathname === "/provider"
    || url.pathname.startsWith("/provider/")
    || url.pathname === "/providers"
    || url.pathname.startsWith("/providers/")
  ) return "bypass";
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    return "immutable";
  }
  return APP_SHELL_PATHS.includes(url.pathname) ? "shell" : "bypass";
}

function canStore(response) {
  return response.ok && (response.type === "basic" || response.type === "default");
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_CACHE_ENTRIES;
  if (overflow <= 0) return;
  await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
}

async function store(cache, request, response) {
  if (!canStore(response)) return;
  await cache.put(request, response.clone());
  await trimCache(cache);
}

async function discoverStaticAssets(response) {
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    !contentType.toLowerCase().includes("text/html")
    || (Number.isFinite(declaredLength) && declaredLength > MAX_SHELL_DOCUMENT_CHARACTERS)
  ) return [];

  const documentText = await response.clone().text();
  if (documentText.length > MAX_SHELL_DOCUMENT_CHARACTERS) return [];
  const paths = new Set();
  const attributePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of documentText.matchAll(attributePattern)) {
    try {
      const asset = new URL(match[1], self.location.origin);
      if (
        asset.origin === self.location.origin
        && asset.search === ""
        && asset.hash === ""
        && asset.pathname.startsWith("/_next/static/")
      ) paths.add(asset.pathname);
    } catch {
      // Invalid and non-URL attributes are not install-time cache candidates.
    }
  }
  return [...paths].sort();
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await store(cache, request, response);
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    await store(cache, request, response);
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const handleModeStaticAssets = new Set();
    const otherStaticAssets = new Set();
    for (const path of APP_SHELL_PATHS) {
      try {
        const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
        const discovered = canStore(response) ? await discoverStaticAssets(response) : [];
        await store(cache, path, response);
        const destination = path === HANDLE_MODE_PATH
          ? handleModeStaticAssets
          : otherStaticAssets;
        for (const asset of discovered) destination.add(asset);
      } catch {
        // One unavailable shell asset must not widen the cache or retain provider data.
      }
    }
    const staticAssetBudget = Math.max(0, MAX_CACHE_ENTRIES - APP_SHELL_PATHS.length);
    const prioritizedStaticAssets = [
      ...[...handleModeStaticAssets].sort(),
      ...[...otherStaticAssets]
        .filter((path) => !handleModeStaticAssets.has(path))
        .sort(),
    ].slice(0, staticAssetBudget);
    for (const path of prioritizedStaticAssets) {
      try {
        const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
        await store(cache, path, response);
      } catch {
        // A missing immutable asset leaves install successful and bounded.
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const policy = requestPolicy(event.request);
  if (policy === "bypass") return;
  event.respondWith(policy === "immutable"
    ? cacheFirst(event.request)
    : networkFirst(event.request));
});
