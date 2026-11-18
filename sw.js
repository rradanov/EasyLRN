// EasyLRN Service Worker.
// - Precaches the app shell under a versioned cache name.
// - Serves the shell cache-first, so the app opens offline.
// - A new version installs in the background and waits until the page
//   sends {type: 'SKIP_WAITING'} (the user pressed "Презареди").
// - Serves course files from IndexedDB at ./c/<courseId>/<path> (T-009, D-011)
//   with a strict CSP: lessons may run their own JS but make no network
//   requests (connect-src 'none'), so a lesson script cannot send anything away.
// - Caches the lesson fonts (Google Fonts) so lessons look the same offline.

const VERSION = '0.4.0'; // keep in sync with src/config.js
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
  './src/db.js',
  './src/course-import.js',
  './src/zip.js',
  './src/screens/courses.js',
  './src/screens/course.js',
  './src/screens/reader.js',
  './src/lesson-frame.js',
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
const COURSE_URL = new URL('./c/', self.location).href;

const FONT_CACHE = 'easylrn-fonts'; // not versioned: kept across app updates
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

// Headers of every course response (ARCHITECTURE §5, D-011). Lessons are
// self-contained HTML with inline CSS/JS; fonts may come from Google Fonts.
// No fetch/XHR/WebSocket/beacon (connect-src 'none'), no workers, no forms,
// no plugins; images and frames only from the app itself, data: and blob:.
const COURSE_CSP = [
  "default-src 'self' 'unsafe-inline' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const COURSE_HEADERS = {
  'Content-Security-Policy': COURSE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
};
const COURSE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

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
  if (FONT_HOSTS.has(url.hostname) && url.protocol === 'https:') {
    event.respondWith(fontStaleWhileRevalidate(event, request, url));
    return;
  }
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE_URL)) return;

  // Course files: always from IndexedDB, never from the network or the shell cache.
  if ((url.origin + url.pathname).startsWith(COURSE_URL)) {
    event.respondWith(serveCourseFile(url));
    return;
  }

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

// --- Course files (T-009) -----------------------------------------------------

/**
 * Turn the part of the URL after ./c/ into { courseId, path }, or null.
 * The URL parser has already resolved "." / ".." and "%2e%2e" segments; here
 * every segment is decoded once and the result is checked again, also after a
 * second decoding (double encoding such as %252e%252e or %252f), so a path
 * can never name a file outside the course: no "." / ".." segments, no "/",
 * "\" or NUL inside a segment, no empty segments.
 */
function coursePath(url) {
  const rest = (url.origin + url.pathname).slice(COURSE_URL.length);
  const raw = rest.split('/');
  if (raw.length < 2) return null;
  const decoded = [];
  for (const segment of raw) {
    let once;
    try {
      once = decodeURIComponent(segment);
    } catch {
      return null;
    }
    let twice = once;
    try {
      twice = decodeURIComponent(once);
    } catch {
      /* not double-encoded */
    }
    for (const s of [once, twice]) {
      if (!s || s === '.' || s === '..' || /[\/\\\u0000]/.test(s)) return null;
    }
    decoded.push(once);
  }
  const [courseId, ...parts] = decoded;
  if (!COURSE_ID.test(courseId)) return null;
  return { courseId, path: parts.join('/') };
}

let dbPromise = null;

/** Open the app database read-only style: never create or upgrade it here. */
function openAppDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('lrn-app');
      // No database yet (nothing imported): do not create an empty one, the app owns the schema.
      req.onupgradeneeded = () => req.transaction.abort();
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function getCourseFile(courseId, path) {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').get(`${courseId}/${path}`);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function courseError(status, text) {
  const html = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><meta name="easylrn-error" content="${status}">`
    + `<title>${text}</title></head><body><p>${text}</p></body></html>`;
  return new Response(html, { status, headers: { ...COURSE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

async function serveCourseFile(url) {
  const target = coursePath(url);
  if (!target) return courseError(400, 'Невалиден адрес на файл от курса.');
  let file;
  try {
    file = await getCourseFile(target.courseId, target.path);
  } catch {
    file = null;
  }
  if (!file || file.deleted || file.courseId !== target.courseId || file.path !== target.path || !file.blob) {
    return courseError(404, 'Файлът не е намерен в курса. Импортирай курса отново.');
  }
  return new Response(file.blob, {
    status: 200,
    headers: { ...COURSE_HEADERS, 'Content-Type': file.mime || file.blob.type || 'application/octet-stream' },
  });
}

// --- Fonts of the lessons ---------------------------------------------------

async function fontStaleWhileRevalidate(event, request, url) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const response = await network;
  if (response) return response;
  // Offline and never cached: the lesson falls back to its system fonts.
  return url.hostname === 'fonts.googleapis.com'
    ? new Response('/* offline: font CSS not cached */', { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
    : new Response(null, { status: 504 });
}
