/**
 * sw.js — service worker for offline use.
 *
 * App shell: pre-cached on install; served network-first with a cache
 *            fallback so updates arrive promptly but the app opens offline.
 * Data:      ../data/kanji.json is cached on first successful fetch and
 *            served network-first with a cache fallback.
 * Fonts:     Google Fonts responses are cached opportunistically
 *            (stale-while-revalidate); the app works without them.
 *
 * Bump CACHE_VERSION whenever a shell file changes in a way that must
 * invalidate old caches.
 */

const CACHE_VERSION = 'kanjr-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './engine.js',
  './srs.js',
  './match.js',
  './store.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isFontRequest(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Navigations fall back to the shell so deep links open offline.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isFontRequest(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
