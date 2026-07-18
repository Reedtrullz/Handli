/* global self, caches, fetch */

const CACHE_PREFIX = "handleplan-handlemodus-";
const SERVICE_WORKER_URL = new URL(self.location.href);
const EMBEDDED_PUBLIC_BUILD_ID = "__HANDLEPLAN_PUBLIC_BUILD_ID__";
const REQUESTED_PUBLIC_BUILD_ID = SERVICE_WORKER_URL.searchParams.get("build");
if (
  !/^hpv2-[0-9a-f]{64}$/u.test(EMBEDDED_PUBLIC_BUILD_ID)
  || SERVICE_WORKER_URL.origin !== self.location.origin
  || SERVICE_WORKER_URL.pathname !== "/sw.js"
  || SERVICE_WORKER_URL.hash !== ""
  || SERVICE_WORKER_URL.searchParams.size !== 1
  || REQUESTED_PUBLIC_BUILD_ID !== EMBEDDED_PUBLIC_BUILD_ID
) {
  throw new Error("Handlemodus service worker identity does not match its sealed build");
}
const PUBLIC_BUILD_ID = EMBEDDED_PUBLIC_BUILD_ID;
const CACHE_REVISION = PUBLIC_BUILD_ID;
const SHELL_CACHE_NAME = `${CACHE_PREFIX}${CACHE_REVISION}-shell`;
const REPAIR_SHELL_CACHE_NAME = `${CACHE_PREFIX}${CACHE_REVISION}-repair-shell`;
const RUNTIME_CACHE_NAME = `${CACHE_PREFIX}${CACHE_REVISION}-runtime`;
const ACTIVE_CACHE_NAMES = Object.freeze([
  SHELL_CACHE_NAME,
  REPAIR_SHELL_CACHE_NAME,
  RUNTIME_CACHE_NAME,
]);
const MAX_CACHE_ENTRIES = 64;
const MAX_SHELL_DOCUMENT_BYTES = 1024 * 1024;
const HANDLE_MODE_PATH = "/planlegg/handle";
const HANDLE_MODE_BOOTSTRAP_PATHS = Object.freeze(["/zod-jitless-v1.js"]);
const HANDLE_MODE_BOOTSTRAP_BYTE_LENGTH = 245;
const HANDLE_MODE_BOOTSTRAP_SHA256 = "6ee55dd6eb3c514d4b5ccae48e8b2ab789defd9aba194e59ca94e7a4b02ca036";
const HANDLE_MODE_ICON_PATHS = Object.freeze([
  "/icons/handleplan.svg",
  "/icons/handleplan-maskable.svg",
]);
const READY_REQUEST_KIND = "handleplan:handle-mode-offline-ready:v1";
const READY_RESPONSE_KIND = "handleplan:handle-mode-offline-ready-result:v1";
const APP_SHELL_PATHS = Object.freeze([
  "/planlegg/handle",
  "/manifest.webmanifest",
  ...HANDLE_MODE_ICON_PATHS,
  ...HANDLE_MODE_BOOTSTRAP_PATHS,
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
  if (HANDLE_MODE_BOOTSTRAP_PATHS.includes(url.pathname)) return "bootstrap";
  if (url.pathname.startsWith("/_next/static/") || HANDLE_MODE_ICON_PATHS.includes(url.pathname)) {
    return "immutable";
  }
  return APP_SHELL_PATHS.includes(url.pathname) ? "shell" : "bypass";
}

function canStore(response) {
  return response.ok && (response.type === "basic" || response.type === "default");
}

function exactSameOriginRequestUrl(request) {
  try {
    const value = typeof request === "string" ? request : request.url;
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.search === "" && url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExactUnredirectedResponseUrl(request, response) {
  const expectedUrl = exactSameOriginRequestUrl(request);
  if (expectedUrl === undefined || response.redirected || response.url === "") return false;
  try {
    return new URL(response.url).href === expectedUrl.href;
  } catch {
    return false;
  }
}

function expectedStaticAssetContentType(pathname) {
  if (pathname.endsWith(".js")) return /^(?:application|text)\/javascript(?:\s*;|$)/iu;
  if (pathname.endsWith(".css")) return /^text\/css(?:\s*;|$)/iu;
  return undefined;
}

function isExpectedStaticAsset(request, response) {
  const requestUrl = exactSameOriginRequestUrl(request);
  if (requestUrl === undefined || !requestUrl.pathname.startsWith("/_next/static/")) return false;
  const expectedContentType = expectedStaticAssetContentType(requestUrl.pathname);
  return expectedContentType !== undefined
    && canStore(response)
    && hasExactUnredirectedResponseUrl(requestUrl.href, response)
    && expectedContentType.test(response.headers.get("content-type") ?? "");
}

function expectedShellContentType(pathname) {
  if (pathname === HANDLE_MODE_PATH) {
    // Response.text() is UTF-8. Requiring the navigation response to declare
    // the same encoding prevents the worker and browser HTML parser from
    // validating different character streams.
    return /^text\/html\s*;\s*charset\s*=\s*(?:"(?:utf-8|utf8)"|(?:utf-8|utf8))\s*$/iu;
  }
  if (pathname === "/manifest.webmanifest") {
    return /^application\/(?:manifest\+json|json)(?:\s*;|$)/iu;
  }
  if (HANDLE_MODE_ICON_PATHS.includes(pathname)) {
    return /^image\/svg\+xml(?:\s*;|$)/iu;
  }
  return undefined;
}

function isExpectedShellResponse(request, response) {
  const requestUrl = exactSameOriginRequestUrl(request);
  const expectedContentType = requestUrl === undefined
    ? undefined
    : expectedShellContentType(requestUrl.pathname);
  return expectedContentType !== undefined
    && canStore(response)
    && hasExactUnredirectedResponseUrl(requestUrl.href, response)
    && expectedContentType.test(response.headers.get("content-type") ?? "");
}

const RAW_TEXT_ELEMENT_NAMES = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const DIRECT_HEAD_ELEMENT_NAMES = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "noscript",
  "script",
  "style",
  "title",
]);

function isHtmlSpace(value) {
  return value === " " || value === "\t" || value === "\n" || value === "\f" || value === "\r";
}

function containsOnlyHtmlSpace(value) {
  for (const character of value) {
    if (!isHtmlSpace(character)) return false;
  }
  return true;
}

function parseConservativeHtmlTag(documentText, start) {
  let cursor = start + 1;
  let closing = false;
  if (documentText[cursor] === "/") {
    closing = true;
    cursor += 1;
  }
  const nameStart = cursor;
  while (
    cursor < documentText.length
    && !isHtmlSpace(documentText[cursor])
    && !["/", ">"].includes(documentText[cursor])
  ) {
    // HTML replaces NUL during tokenization. Rejecting it avoids comparing a
    // different tag name than the browser while still consuming punctuation
    // such as `.`, `_`, and `@` as part of the real tag-name token.
    if (documentText[cursor] === "\0") return undefined;
    cursor += 1;
  }
  if (cursor === nameStart) return undefined;
  const name = documentText.slice(nameStart, cursor).toLowerCase();
  const attributes = new Map();
  let duplicateAttribute = false;
  let selfClosing = false;

  while (cursor < documentText.length) {
    while (isHtmlSpace(documentText[cursor])) cursor += 1;
    if (documentText[cursor] === ">") {
      return {
        attributes,
        closing,
        duplicateAttribute,
        end: cursor + 1,
        name,
        selfClosing,
      };
    }
    if (documentText[cursor] === "/" && documentText[cursor + 1] === ">") {
      selfClosing = true;
      return {
        attributes,
        closing,
        duplicateAttribute,
        end: cursor + 2,
        name,
        selfClosing,
      };
    }
    if (closing) return undefined;

    const attributeStart = cursor;
    while (
      cursor < documentText.length
      && !isHtmlSpace(documentText[cursor])
      && !["=", ">", "/"].includes(documentText[cursor])
    ) cursor += 1;
    if (cursor === attributeStart) return undefined;
    const attributeName = documentText.slice(attributeStart, cursor).toLowerCase();
    while (isHtmlSpace(documentText[cursor])) cursor += 1;

    let attributeValue = "";
    if (documentText[cursor] === "=") {
      cursor += 1;
      while (isHtmlSpace(documentText[cursor])) cursor += 1;
      const quote = documentText[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < documentText.length && documentText[cursor] !== quote) cursor += 1;
        if (cursor >= documentText.length) return undefined;
        attributeValue = documentText.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (
          cursor < documentText.length
          && !isHtmlSpace(documentText[cursor])
          && documentText[cursor] !== ">"
        ) cursor += 1;
        if (cursor === valueStart) return undefined;
        attributeValue = documentText.slice(valueStart, cursor);
      }
    }
    if (attributes.has(attributeName)) duplicateAttribute = true;
    attributes.set(attributeName, attributeValue);
  }
  return undefined;
}

function findRawTextElementEnd(documentText, elementName, contentStart) {
  const lowerDocument = documentText.toLowerCase();
  const prefix = `</${elementName}`;
  let cursor = contentStart;
  while (cursor < documentText.length) {
    const candidate = lowerDocument.indexOf(prefix, cursor);
    if (candidate < 0) return undefined;
    const boundary = documentText[candidate + prefix.length];
    if (boundary === ">" || isHtmlSpace(boundary)) {
      if (elementName === "script") {
        const rawContent = lowerDocument.slice(contentStart, candidate);
        if (
          rawContent.includes("<!--")
          || rawContent.includes("-->")
          || rawContent.includes("<script")
        ) {
          // HTML's script escaped/double-escaped states can make a visually
          // matching </script> fail to close the element. The sealed shell
          // does not need legacy comment wrappers or nested script text, so
          // reject those ambiguous states instead of approximating them.
          return undefined;
        }
      }
      const closingTag = parseConservativeHtmlTag(documentText, candidate);
      if (closingTag?.closing === true && closingTag.name === elementName) {
        return closingTag.end;
      }
    }
    cursor = candidate + prefix.length;
  }
  return undefined;
}

function conservativeHtmlStartTags(documentText) {
  const tags = [];
  let cursor = 0;
  let doctypeSeen = false;
  let htmlSeen = false;
  let inHead = false;
  let headClosed = false;
  let headSeen = false;
  while (cursor < documentText.length) {
    const start = documentText.indexOf("<", cursor);
    const gapEnd = start < 0 ? documentText.length : start;
    if (
      (!headSeen || inHead)
      && !containsOnlyHtmlSpace(documentText.slice(cursor, gapEnd))
    ) return undefined;
    if (start < 0) break;
    if (documentText.startsWith("<!--", start)) {
      const commentEnd = documentText.indexOf("-->", start + 4);
      if (commentEnd < 0) return undefined;
      cursor = commentEnd + 3;
      continue;
    }
    if (documentText.startsWith("<!", start)) {
      const declarationEnd = documentText.indexOf(">", start + 2);
      if (declarationEnd < 0) return undefined;
      const declaration = documentText.slice(start, declarationEnd + 1);
      if (
        doctypeSeen
        || htmlSeen
        || headSeen
        || !/^<!doctype\s+html\s*>$/iu.test(declaration)
      ) return undefined;
      doctypeSeen = true;
      cursor = declarationEnd + 1;
      continue;
    }
    if (documentText.startsWith("<?", start)) return undefined;

    const tag = parseConservativeHtmlTag(documentText, start);
    if (tag === undefined) return undefined;
    // HTML keeps the first duplicate attribute while Map assignment keeps the
    // last. Reject duplicates globally so scanner and DOM cannot disagree.
    if (tag.duplicateAttribute) return undefined;
    if (tag.closing) {
      if (!headSeen) return undefined;
      if (tag.name === "head") {
        if (!inHead) return undefined;
        inHead = false;
        headClosed = true;
      } else if (inHead) {
        // Raw-text closers are consumed together with their opener. Any other
        // closing tag in head is malformed and may trigger browser error
        // recovery that changes the parsing context, so reject it outright.
        return undefined;
      }
      cursor = tag.end;
      continue;
    }
    // Templates have their own nested parsing context. The production shell
    // does not use them, so rejecting one is safer than approximating that
    // context and accidentally accepting a marker from inert template markup.
    if (tag.name === "template") return undefined;
    if (!headSeen) {
      if (tag.name === "html") {
        if (htmlSeen) return undefined;
        htmlSeen = true;
      } else if (tag.name === "head") {
        if (!htmlSeen || headClosed || inHead) return undefined;
        headSeen = true;
        inHead = true;
      } else {
        // Any body, flow, metadata, foreign, or raw-text start before the sole
        // explicit head causes the browser to create or close an implicit head.
        return undefined;
      }
    } else if (tag.name === "html" || tag.name === "head") {
      return undefined;
    } else if (tag.name === "body") {
      // The sealed production document closes head explicitly before body.
      if (inHead || !headClosed) return undefined;
    } else if (inHead && !DIRECT_HEAD_ELEMENT_NAMES.has(tag.name)) {
      // The browser implicitly closes <head> before arbitrary flow or foreign
      // content. Rejecting that structure avoids treating a later body/SVG
      // meta element as a direct document-head marker.
      return undefined;
    }
    tags.push({ ...tag, inHead });
    // In HTML syntax, a trailing slash does not self-close raw-text or RCDATA
    // elements. Always consume through their real end tag so markup-looking
    // script/style text cannot be mistaken for a document-head marker.
    if (RAW_TEXT_ELEMENT_NAMES.has(tag.name)) {
      const rawTextEnd = findRawTextElementEnd(documentText, tag.name, tag.end);
      if (rawTextEnd === undefined) return undefined;
      cursor = rawTextEnd;
      continue;
    }
    cursor = tag.end;
  }
  return htmlSeen && headSeen && headClosed ? tags : undefined;
}

function documentHasExactBuildMarker(documentText) {
  const tags = conservativeHtmlStartTags(documentText);
  if (tags === undefined) return false;
  let matchingMarkers = 0;
  for (const tag of tags) {
    if (tag.name !== "meta") continue;
    const markerName = tag.attributes.get("name");
    // Browser HTML parsing decodes character references in attribute values.
    // The sealed marker name is plain ASCII, so rejecting reference syntax is
    // safer than comparing the undecoded source text.
    if (markerName?.includes("&")) return false;
    if (markerName !== "handleplan-public-build-id") continue;
    matchingMarkers += 1;
    if (
      !tag.inHead
      || tag.attributes.get("content") !== PUBLIC_BUILD_ID
    ) return false;
  }
  return matchingMarkers === 1;
}

function canStoreImmutableRequest(request, response) {
  const requestUrl = exactSameOriginRequestUrl(request);
  if (requestUrl?.pathname.startsWith("/_next/static/")) {
    return isExpectedStaticAsset(request, response);
  }
  if (requestUrl !== undefined && HANDLE_MODE_ICON_PATHS.includes(requestUrl.pathname)) {
    return isExpectedShellResponse(request, response);
  }
  return false;
}

async function canStoreShellRequest(request, response) {
  const requestUrl = exactSameOriginRequestUrl(request);
  if (requestUrl === undefined || !isExpectedShellResponse(request, response)) return false;
  if (requestUrl.pathname !== HANDLE_MODE_PATH) return true;
  const documentText = await readBoundedText(response, MAX_SHELL_DOCUMENT_BYTES);
  return documentText !== undefined
    && (requestUrl?.pathname !== HANDLE_MODE_PATH
      || documentHasExactBuildMarker(documentText));
}

async function readExactBoundedBytes(response, expectedByteLength) {
  const stream = response.clone().body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > expectedByteLength) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(result.value);
    }
  } catch {
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled reader remains an invalid bootstrap response.
    }
  }
  if (byteLength !== expectedByteLength) return undefined;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedText(response, maximumByteLength) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) > maximumByteLength)
  ) {
    return undefined;
  }
  const stream = response.clone().body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumByteLength) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(result.value);
    }
  } catch {
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled reader remains an invalid shell response.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes).text();
  } catch {
    return undefined;
  }
}

async function isExpectedHandleModeBootstrap(request, response) {
  const requestUrl = exactSameOriginRequestUrl(request);
  if (
    requestUrl?.pathname !== "/zod-jitless-v1.js"
    || !canStore(response)
    || !hasExactUnredirectedResponseUrl(requestUrl.href, response)
  ) return false;
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^(?:application|text)\/javascript(?:\s*;|$)/iu.test(contentType)) return false;
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) > HANDLE_MODE_BOOTSTRAP_BYTE_LENGTH)
  ) {
    return false;
  }
  const bytes = await readExactBoundedBytes(response, HANDLE_MODE_BOOTSTRAP_BYTE_LENGTH);
  if (bytes === undefined) return false;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const digestHex = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return digestHex === HANDLE_MODE_BOOTSTRAP_SHA256;
  } catch {
    return false;
  }
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
  if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) return [];
  const documentText = await readBoundedText(response, MAX_SHELL_DOCUMENT_BYTES);
  if (documentText === undefined) return [];
  const tags = conservativeHtmlStartTags(documentText);
  if (tags === undefined) return [];
  const paths = new Set();
  for (const tag of tags) {
    const candidatePaths = [tag.attributes.get("src"), tag.attributes.get("href")]
      .filter((value) => value !== undefined);
    for (const candidatePath of candidatePaths) {
      try {
        const asset = new URL(candidatePath, self.location.origin);
        if (
          asset.origin === self.location.origin
          && asset.search === ""
          && asset.hash === ""
          && asset.pathname.startsWith("/_next/static/")
          && expectedStaticAssetContentType(asset.pathname) !== undefined
        ) paths.add(asset.pathname);
      } catch {
        // Invalid and non-URL attributes are not install-time cache candidates.
      }
    }
  }
  return [...paths].sort();
}

async function cacheFirst(request) {
  const readyShellCache = await findOfflineReadyShellCache();
  const shellCacheKey = exactSameOriginRequestUrl(request)?.pathname ?? request;
  const shellCached = await readyShellCache?.match(shellCacheKey);
  if (shellCached && canStoreImmutableRequest(request, shellCached)) return shellCached;
  if (!isCurrentRegistrationWorker()) return fetch(request);
  const runtimeCache = await caches.open(RUNTIME_CACHE_NAME);
  if (!isCurrentRegistrationWorker()) {
    await caches.delete(RUNTIME_CACHE_NAME);
    return fetch(request);
  }
  const runtimeCached = await runtimeCache.match(request);
  if (runtimeCached && canStoreImmutableRequest(request, runtimeCached)) return runtimeCached;
  if (runtimeCached) await runtimeCache.delete(request);
  const response = await fetch(request);
  if (canStoreImmutableRequest(request, response) && isCurrentRegistrationWorker()) {
    await store(runtimeCache, request, response);
    if (!isCurrentRegistrationWorker()) await caches.delete(RUNTIME_CACHE_NAME);
  }
  return response;
}

async function networkFirst(request) {
  try {
    // Installed shell documents remain immutable. Publishing a new HTML
    // document before every referenced chunk is available would break the
    // known-good offline trip. Every source-bound build gets a distinct worker
    // and cache identity, and install validates the entire replacement shell
    // before activation.
    const response = await fetch(request);
    if (response.status < 500) return response;
    const cache = await findOfflineReadyShellCache();
    const cacheKey = exactSameOriginRequestUrl(request)?.pathname ?? request;
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
    return response;
  } catch (error) {
    const cache = await findOfflineReadyShellCache();
    const cacheKey = exactSameOriginRequestUrl(request)?.pathname ?? request;
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

async function verifiedBootstrapFirst(request) {
  try {
    const response = await fetch(request);
    if (await isExpectedHandleModeBootstrap(request, response)) {
      return response;
    }
  } catch {
    // Fall back only to a complete, independently revalidated offline shell.
  }
  const cache = await findOfflineReadyShellCache();
  const cacheKey = exactSameOriginRequestUrl(request)?.pathname ?? request;
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;
  throw new Error("verified Handlemodus bootstrap is unavailable");
}

async function handleModeOfflineReady(existingCache) {
  const cache = existingCache ?? await caches.open(SHELL_CACHE_NAME);
  const documentResponse = await cache.match(HANDLE_MODE_PATH);
  if (!documentResponse || !(await canStoreShellRequest(HANDLE_MODE_PATH, documentResponse))) {
    if (documentResponse) await cache.delete(HANDLE_MODE_PATH);
    return false;
  }
  const staticAssets = await discoverStaticAssets(documentResponse);
  if (staticAssets.length === 0) return false;
  for (const path of APP_SHELL_PATHS) {
    if (path === HANDLE_MODE_PATH || HANDLE_MODE_BOOTSTRAP_PATHS.includes(path)) continue;
    const response = await cache.match(path);
    if (response === undefined || !(await canStoreShellRequest(path, response))) return false;
  }
  for (const path of staticAssets) {
    const response = await cache.match(path);
    if (response === undefined || !isExpectedStaticAsset(path, response)) return false;
  }
  for (const path of HANDLE_MODE_BOOTSTRAP_PATHS) {
    const response = await cache.match(path);
    if (response === undefined || !(await isExpectedHandleModeBootstrap(path, response))) return false;
  }
  return true;
}

async function findOfflineReadyShellCache() {
  // Merely checking readiness must not create a third empty cache in a
  // healthy installation. A repair cache is considered only after the
  // transactional repair path has actually created it.
  const names = await caches.keys();
  if (names.includes(REPAIR_SHELL_CACHE_NAME)) {
    const repairCache = await caches.open(REPAIR_SHELL_CACHE_NAME);
    if (await handleModeOfflineReady(repairCache)) return repairCache;
    if (!isCurrentRegistrationWorker()) await caches.delete(REPAIR_SHELL_CACHE_NAME);
  }
  // A superseded worker can still finish an in-flight fetch after the next
  // generation has removed its caches. Merely checking readiness must not
  // recreate the retired shell cache in that window.
  if (!names.includes(SHELL_CACHE_NAME)) return undefined;
  const installedCache = await caches.open(SHELL_CACHE_NAME);
  if (await handleModeOfflineReady(installedCache)) return installedCache;
  if (!isCurrentRegistrationWorker()) await caches.delete(SHELL_CACHE_NAME);
  return undefined;
}

function isCurrentRegistrationWorker() {
  return self.registration?.active?.scriptURL === self.location.href;
}

async function populateShellCache(cacheName) {
  await caches.delete(cacheName);
  const cache = await caches.open(cacheName);
  try {
    let handleModeStaticAssets = [];
    for (const path of APP_SHELL_PATHS) {
      const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
      const acceptable = HANDLE_MODE_BOOTSTRAP_PATHS.includes(path)
        ? await isExpectedHandleModeBootstrap(path, response)
        : await canStoreShellRequest(path, response);
      if (!acceptable) throw new Error(`required Handlemodus shell response is invalid: ${path}`);
      if (path === HANDLE_MODE_PATH) {
        handleModeStaticAssets = await discoverStaticAssets(response);
        if (
          handleModeStaticAssets.length === 0
          || handleModeStaticAssets.length > MAX_CACHE_ENTRIES - APP_SHELL_PATHS.length
        ) {
          throw new Error("required Handlemodus static asset set is invalid");
        }
      }
      await store(cache, path, response, false);
    }
    for (const path of handleModeStaticAssets) {
      const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
      if (!isExpectedStaticAsset(path, response)) {
        throw new Error(`required Handlemodus static asset is invalid: ${path}`);
      }
      await store(cache, path, response, false);
    }
    if (!(await handleModeOfflineReady(cache))) {
      throw new Error("installed Handlemodus cache is not offline-ready");
    }
    return cache;
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

let repairInFlight;
function ensureHandleModeOfflineReady() {
  if (repairInFlight !== undefined) return repairInFlight;
  const attempt = (async () => {
    try {
      // Recheck only after this caller has synchronously claimed the
      // single-flight slot. No stale precheck can outlive another successful
      // repair and then destructively replace it.
      if (await findOfflineReadyShellCache() !== undefined) return true;
      if (!isCurrentRegistrationWorker()) return false;
      await populateShellCache(REPAIR_SHELL_CACHE_NAME);
      if (!isCurrentRegistrationWorker()) {
        await caches.delete(REPAIR_SHELL_CACHE_NAME);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  })();
  repairInFlight = attempt;
  void attempt.then(() => {
    if (repairInFlight === attempt) repairInFlight = undefined;
  });
  return attempt;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await Promise.all([
      caches.delete(SHELL_CACHE_NAME),
      caches.delete(REPAIR_SHELL_CACHE_NAME),
      caches.delete(RUNTIME_CACHE_NAME),
    ]);
    try {
      await populateShellCache(SHELL_CACHE_NAME);
      await self.skipWaiting();
    } catch (error) {
      await Promise.all([
        caches.delete(SHELL_CACHE_NAME),
        caches.delete(REPAIR_SHELL_CACHE_NAME),
        caches.delete(RUNTIME_CACHE_NAME),
      ]);
      throw error;
    }
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
  if (policy === "shell" && typeof event.waitUntil === "function") {
    event.waitUntil(ensureHandleModeOfflineReady().catch(() => false));
  }
  event.respondWith(policy === "immutable"
    ? cacheFirst(event.request)
    : policy === "bootstrap"
      ? verifiedBootstrapFirst(event.request)
      : networkFirst(event.request));
});

self.addEventListener("message", (event) => {
  if (
    event.data?.kind !== READY_REQUEST_KIND
    || event.data?.buildId !== PUBLIC_BUILD_ID
    || event.ports.length !== 1
  ) return;
  event.waitUntil((async () => {
    let ready = false;
    try {
      ready = await ensureHandleModeOfflineReady();
    } catch {
      ready = false;
    }
    event.ports[0].postMessage({
      buildId: PUBLIC_BUILD_ID,
      kind: READY_RESPONSE_KIND,
      ready,
    });
  })());
});
