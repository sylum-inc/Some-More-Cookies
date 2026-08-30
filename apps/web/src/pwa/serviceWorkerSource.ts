/**
 * The service worker, as source text.
 *
 * It is generated rather than written as a static file because its precache
 * list is the build's own asset list — hashed filenames included — and a
 * hand-maintained copy of that list is a stale cache waiting to happen. The
 * build calls this with what it actually emitted (see `vite.config.ts`).
 *
 * The shape of the thing, and why:
 *
 *  - **Cache-first for the shell.** Everything the ritual needs is already on
 *    the device (ARCHITECTURE §1.5): the simulation, the geometry, the
 *    textures and the sounds are all code. So an offline boot is not a
 *    degraded mode, it is the ordinary mode with the radio off, and the
 *    fastest correct answer is the one already in the cache.
 *  - **Versioned caches, never mutated.** A cache is named for the build that
 *    filled it and is never written to by a different build. Activation
 *    deletes every other one. This is what stops the classic failure where a
 *    half-updated cache serves an old shell against new assets.
 *  - **The update is asked for, not taken.** A new worker installs and then
 *    waits. It takes over only when the page says so, which is what lets the
 *    product show a person "there is a newer campsite, reload when you like"
 *    instead of reloading under their hands mid-roast.
 *  - **The service is never cached, and never faked.** `/v1/*` is left
 *    entirely alone — no `respondWith`, no fallback response — so a failed
 *    call fails as a network error and `ApiClient` reports its `offline`
 *    kind honestly rather than parsing a cached lie.
 */

export interface ServiceWorkerSourceOptions {
  /** Identifies the build. Derived from the emitted asset names. */
  version: string;
  /** Same-origin, root-relative URLs to fill the cache with on install. */
  precache: readonly string[];
  /** The navigation shell, which must also appear in `precache`. */
  shell: string;
}

export function serviceWorkerSource(options: ServiceWorkerSourceOptions): string {
  const { version, precache, shell } = options;
  return `/*
 * Some More — generated service worker. Do not edit; see
 * apps/web/src/pwa/serviceWorkerSource.ts.
 */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'some-more-' + VERSION;
const SHELL = ${JSON.stringify(shell)};
const PRECACHE = ${JSON.stringify([...precache], null, 2)};

/* Shown only if a navigation happens with no cache and no network at all,
   which means the very first visit was offline. Dark, because everything
   here is. */
const NO_CACHE_YET =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<title>Some More</title><style>html,body{height:100%;margin:0;background:#0a0d12;' +
  'color:#e8e0cd;font:14px/1.6 "Helvetica Neue",Arial,sans-serif;display:flex;' +
  'align-items:center;justify-content:center;text-align:center}p{max-width:22em;' +
  'padding:0 2em;opacity:0.8}</style></head><body><p>The campsite has not been ' +
  'downloaded yet. Open Some More once with a connection and it will work ' +
  'without one from then on.</p></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      /* One at a time rather than addAll: addAll rejects the whole install if
         any single entry fails, and an install that fails leaves the previous
         worker in charge forever. A missing icon should not cost somebody the
         update to the machine. */
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch (error) {
            /* Logged, not thrown. */
            console.warn('[sw] could not precache', url, error);
          }
        }),
      );
      /* Deliberately no skipWaiting(). See the note at the top of the
         generator: the page asks for the update. */
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('some-more-') && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'sm-skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'sm-version') {
    const port = event.ports && event.ports[0];
    const reply = { type: 'sm-version', version: VERSION, cache: CACHE };
    if (port) port.postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  /* The service, left strictly alone. A cached or synthesised reply here
     would turn "no signal" into "wrong answer", and the whole local-first
     design depends on the client being told the truth. */
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return;

  /* The worker script itself is never served from the cache. */
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(handleAsset(event, request));
});

async function handleNavigation(request) {
  const cache = await caches.open(CACHE);
  /* Vary is ignored on purpose: a static host that varies on Origin or on
     Accept-Encoding would otherwise miss its own precached shell, and every
     entry in this cache is a same-origin GET of this build's own files, so
     there is nothing for Vary to disambiguate. */
  const cached = await cache.match(SHELL, { ignoreVary: true });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (error) {
    return new Response(NO_CACHE_YET, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

async function handleAsset(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    /* Only same-origin successes are kept, and only in this build's cache, so
       nothing another build put there can be resurrected. */
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy).catch(() => undefined));
    }
    return response;
  } catch (error) {
    /* A query string on an asset (a cache-buster, a share link) should still
       find the asset. */
    const loose = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (loose) return loose;
    throw error;
  }
}
`;
}
