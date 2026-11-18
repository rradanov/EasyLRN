// EasyLRN Service Worker.
// - Precaches the app shell under a versioned cache name.
// - Serves the shell cache-first, so the app opens offline.
// - A new version installs in the background and waits until the page
//   sends {type: 'SKIP_WAITING'} (the user pressed "Презареди").
// Course files (./c/<course>/<path> from IndexedDB) will be served here in T-009.

const VERSION = '0.1.1'; // keep in sync with src/config.js
const CACHE_PREFIX = 'easylrn-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

// Paths are relative to the SW location, so the app works under /EasyLRN/.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/app.css',
  './src/main.js',
  './src/config.js',
  './src/dom.js',
  './src/router.js',
  './src/sw-client.js',
  './src/screens/courses.js',
  './src/screens/course.js',
  './src/screens/reader.js',
  './src/screens/settings.js',
  './src/screens/not-found.js',
  './vendor/idb.js',
  './vendor/fflate.js',
  './vendor/marked.js',
  './vendor/purify.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const SCOPE_URL = new URL('./', self.location).href;
const INDEX_URL = new URL('./index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // `reload` bypasses the HTTP cache so a new version never precaches stale files.
    await cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE_URL)) return;

  // App navigations (the shell uses hash routes) → cached index.html.
  const pathOnly = url.origin + url.pathname;
  if (request.mode === 'navigate' && (pathOnly === SCOPE_URL || pathOnly === INDEX_URL)) {
    event.respondWith(cacheFirst(INDEX_URL, request));
    return;
  }

  event.respondWith(cacheFirst(request, request));
});

async function cacheFirst(cacheKey, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey, { ignoreSearch: true });
  if (cached) return cached;
  return fetch(request);
}
