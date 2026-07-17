/* global self, caches, fetch */

const CACHE_PREFIX = "handleplan-handlemodus-";
const CACHE_REVISION = "v4";
const SHELL_CACHE_NAME = `${CACHE_PREFIX}${CACHE_REVISION}-shell`;
const RUNTIME_CACHE_NAME = `${CACHE_PREFIX}${CACHE_REVISION}-runtime`;
const ACTIVE_CACHE_NAMES = Object.freeze([SHELL_CACHE_NAME, RUNTIME_CACHE_NAME]);
const MAX_CACHE_ENTRIES = 64;
const MAX_SHELL_DOCUMENT_CHARACTERS = 1024 * 1024;
const HANDLE_MODE_PATH = "/planlegg/handle";
const READY_REQUEST_KIND = "handleplan:handle-mode-offline-ready:v1";
const READY_RESPONSE_KIND = "handleplan:handle-mode-offline-ready-result:v1";
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
  const removable = keys.filter((key) => {
    try {
      const value = typeof key === "string" ? key : key.url;
      const url = new URL(value, self.location.origin);
      return url.origin !== self.location.origin
        || url.search !== ""
        || !APP_SHELL_PATHS.includes(url.pathname);
    } catch {
      return true;
    }
  });
  // APP_SHELL_PATHS is much smaller than MAX_CACHE_ENTRIES, so every real
  // overflow has a removable immutable entry. Keep the documents that make
  // Handlemodus bootable offline instead of relying on Cache insertion order.
  await Promise.all(removable.slice(0, overflow).map((key) => cache.delete(key)));
}

async function store(cache, request, response, bounded = true) {
  if (!canStore(response)) return;
  await cache.put(request, response.clone());
  if (bounded) await trimCache(cache);
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
  const shellCache = await caches.open(SHELL_CACHE_NAME);
  const shellCached = await shellCache.match(request);
  if (shellCached) return shellCached;
  const runtimeCache = await caches.open(RUNTIME_CACHE_NAME);
  const runtimeCached = await runtimeCache.match(request);
  if (runtimeCached) return runtimeCached;
  const response = await fetch(request);
  await store(runtimeCache, request, response);
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  try {
    const response = await fetch(request);
    await store(cache, request, response, false);
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function handleModeOfflineReady() {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const documentResponse = await cache.match(HANDLE_MODE_PATH);
  if (!documentResponse || !canStore(documentResponse)) return false;
  const staticAssets = await discoverStaticAssets(documentResponse);
  if (staticAssets.length === 0) return false;
  const cachedAssets = await Promise.all(staticAssets.map((path) => cache.match(path)));
  return cachedAssets.every((response) => response !== undefined && canStore(response));
}

async function warmCurrentHandleModeShell() {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const documentResponse = await fetch(HANDLE_MODE_PATH, {
    cache: "no-cache",
    credentials: "same-origin",
  });
  if (!canStore(documentResponse)) return false;
  const staticAssets = await discoverStaticAssets(documentResponse);
  if (staticAssets.length === 0 || staticAssets.length > MAX_CACHE_ENTRIES - APP_SHELL_PATHS.length) {
    return false;
  }

  const fetchedAssets = [];
  for (const path of staticAssets) {
    const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
    if (!canStore(response)) return false;
    fetchedAssets.push([path, response]);
  }
  for (const [path, response] of fetchedAssets) {
    await store(cache, path, response, false);
  }
  await store(cache, HANDLE_MODE_PATH, documentResponse, false);

  const currentStaticPaths = new Set(staticAssets);
  const keys = await cache.keys();
  await Promise.all(keys.flatMap((key) => {
    try {
      const value = typeof key === "string" ? key : key.url;
      const url = new URL(value, self.location.origin);
      return url.origin === self.location.origin
        && url.search === ""
        && url.pathname.startsWith("/_next/static/")
        && !currentStaticPaths.has(url.pathname)
        ? [cache.delete(key)]
        : [];
    } catch {
      return [cache.delete(key)];
    }
  }));
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE_NAME);
    const handleModeStaticAssets = new Set();
    const otherStaticAssets = new Set();
    for (const path of APP_SHELL_PATHS) {
      try {
        const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
        const discovered = canStore(response) ? await discoverStaticAssets(response) : [];
        await store(cache, path, response, false);
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
        await store(cache, path, response, false);
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
      .filter((name) => name.startsWith(CACHE_PREFIX) && !ACTIVE_CACHE_NAMES.includes(name))
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

self.addEventListener("message", (event) => {
  if (
    event.data?.kind !== READY_REQUEST_KIND
    || event.ports.length !== 1
  ) return;
  event.waitUntil((async () => {
    let ready = false;
    try {
      ready = await warmCurrentHandleModeShell() && await handleModeOfflineReady();
    } catch {
      ready = false;
    }
    event.ports[0].postMessage({ kind: READY_RESPONSE_KIND, ready });
  })());
});
