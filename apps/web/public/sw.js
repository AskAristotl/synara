/*
 * Synara service worker.
 *
 * Deliberately minimal and conservative. Its only jobs are (1) make the app
 * installable as a PWA and (2) let an already-loaded app relaunch and survive
 * brief network drops. It never caches dynamic data: the realtime layer runs
 * over a WebSocket (which is never a `fetch`, so the SW cannot see it), and all
 * auth / attachment / proxy traffic falls through untouched to the network.
 *
 * Caching strategy:
 *   - navigations      -> network-first, fall back to the cached app shell
 *   - /assets/, /icons -> cache-first (Vite output is content-hashed => immutable)
 *   - everything else  -> not intercepted (default browser behavior)
 *
 * Bump CACHE_VERSION whenever this file's strategy changes so `activate` can
 * purge stale caches. Content-hashed assets self-invalidate by filename, so the
 * app shell is the only mutable entry and it is always revalidated over the net.
 */
const CACHE_VERSION = "v1";
const CACHE_NAME = `synara-cache-${CACHE_VERSION}`;
const APP_SHELL_KEY = "/";

// Same-origin path prefixes whose responses are safe to serve cache-first.
// These are content-hashed (Vite `/assets/`) or otherwise immutable brand assets.
const CACHEABLE_PREFIXES = ["/assets/", "/icons/"];

function isCacheableAsset(url) {
  return CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Prime the offline shell. `reload` bypasses the HTTP cache so we store a
      // fresh copy at install time.
      cache.add(new Request(APP_SHELL_KEY, { cache: "reload" })).catch(() => undefined),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("synara-cache-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // Keep the offline shell fresh from the server's SPA fallback.
    if (response && response.ok) {
      cache.put(APP_SHELL_KEY, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = (await cache.match(request)) ?? (await cache.match(APP_SHELL_KEY));
    if (cached) return cached;
    throw new Error("offline and no cached app shell");
  }
}

async function handleAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only cache complete, same-origin successful responses.
  if (response && response.ok && response.type === "basic") {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(handleAsset(request));
  }
});
