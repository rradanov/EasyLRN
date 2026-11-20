// EasyLRN Service Worker.
// - Precaches the app shell under a versioned cache name.
// - Serves the shell cache-first, so the app opens offline.
// - A new version installs in the background and waits until the page
//   sends {type: 'SKIP_WAITING'} (the user pressed "Презареди").
// - Serves course files from IndexedDB at ./c/<courseId>/<path> (T-009, T-045,
//   D-029). Every such response carries a CSP with `sandbox allow-scripts`:
//   the lesson gets an opaque origin and cannot reach the app (IndexedDB,
//   caches, DOM, window), the network, popups or the top window.
// - For HTML files it serves the self-contained version assembled by the app
//   (src/lesson-render.js), puts the guard (src/lesson-guard.js: no WebRTC,
//   the bridge's own references, lrn:hello) first, right after the doctype,
//   and appends the bridge (src/anchor.js + src/lesson-bridge.js, read from
//   the shell cache) before </body>.
// - No web fonts (D-031): the old font cache `easylrn-fonts` is deleted.

const VERSION = '0.11.1'; // keep in sync with src/config.js
const RENDER_VERSION = 4; // keep in sync with src/lesson-render.js
const BRIDGE_MARKER = '<!--easylrn:bridge-->'; // the renderer's last child of <body> (T050-D1)
const CACHE_PREFIX = 'easylrn-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

// Paths are relative to the SW location, so the app works under /EasyLRN/.
const SHELL = [
  './',
  './index.html',
  './parser.html',
  './manifest.webmanifest',
  './styles/app.css',
  './src/main.js',
  './src/config.js',
  './src/dom.js',
  './src/router.js',
  './src/sw-client.js',
  './src/db.js',
  './src/lesson-id.js',
  './src/lesson-status.js',
  './src/history.js',
  './src/course-import.js',
  './src/zip.js',
  './src/screens/courses.js',
  './src/screens/course.js',
  './src/markdown.js',
  './src/screens/reader.js',
  './src/screens/quiz.js',
  './src/screens/quiz-link.js',
  './src/screens/confirm.js',
  './src/lesson-frame.js',
  './src/lesson-render.js',
  './src/lesson-bridge.js',
  './src/lesson-guard.js',
  './src/anchor.js',
  './src/claude.js',
  './src/theme.js',
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

const OLD_FONT_CACHE = 'easylrn-fonts'; // 0.4.0 cached Google Fonts here (D-031: removed)

// Headers of every course response (D-029, LESSON-ISOLATION §3.2). `sandbox
// allow-scripts` (no allow-same-origin) gives the document an opaque origin;
// it is in the response itself, so a lesson can never remove it. Lessons are
// self-contained HTML (inline CSS/JS, data: images); no network at all, no
// workers, no frames, no forms, no plugins, no web fonts.
const COURSE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
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
      .filter((key) => (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) || key === OLD_FONT_CACHE)
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
    // The path is looked up as it is (once decoded) in IndexedDB, never on a
    // file system: a "/" there would be a separator and is refused. The
    // second decoding may hold a "/" (T011F-D2: a file literally named
    // "0001-a%2Fb.html" is one segment and must open), but none of its parts
    // may be empty, "." or ".." (double-encoded "../" is still refused).
    if (!once || once === '.' || once === '..' || /[\/\\\u0000]/.test(once)) return null;
    if (/\u0000/.test(twice) || twice.split(/[\/\\]/).some((p) => !p || p === '.' || p === '..')) return null;
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
  if (/\.html?$/i.test(target.path)) {
    // Only the assembled version, with the bridge (LESSON-ISOLATION §3.2, §4.2).
    if (!file.rendered || file.renderVersion !== RENDER_VERSION || file.renderSha !== file.sha256) {
      return courseError(404, 'Урокът още не е подготвен за показване. Отвори урока отново.');
    }
    let html;
    let scripts;
    try {
      [html, scripts] = await Promise.all([file.rendered.text(), bridgeScripts()]);
    } catch {
      return courseError(404, 'Урокът не може да се покаже. Презареди приложението.');
    }
    return new Response(withBridge(html, scripts), {
      status: 200,
      headers: { ...COURSE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(file.blob, {
    status: 200,
    headers: { ...COURSE_HEADERS, 'Content-Type': file.mime || file.blob.type || 'application/octet-stream' },
  });
}

// --- The guard and the bridge in every lesson (D-029, T-045-fix) ----------------

let bridgePromise = null;

/**
 * { guard, bridge } from the shell cache: the guard (src/lesson-guard.js) as a
 * classic inline script, anchor.js + lesson-bridge.js as one inline module.
 */
function bridgeScripts() {
  if (!bridgePromise) {
    bridgePromise = (async () => {
      const cache = await caches.open(CACHE_NAME);
      const read = async (path) => {
        const url = new URL(path, self.location).href;
        const response = (await cache.match(url, { ignoreSearch: true })) || (await fetch(url));
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        return response.text();
      };
      const [guard, anchor, bridge] = await Promise.all([
        read('./src/lesson-guard.js'), read('./src/anchor.js'), read('./src/lesson-bridge.js'),
      ]);
      // None of the files may close the script element early.
      const safe = (text) => text.replace(/<\/(script)/gi, '<\\/$1');
      return {
        guard: `<script data-easylrn="guard">\n${safe(guard)}\n</script>`,
        bridge: `<script type="module" data-easylrn="bridge">\n${safe(anchor)}\n${safe(bridge)}\n</script>`,
      };
    })().catch((err) => {
      bridgePromise = null;
      throw err;
    });
  }
  return bridgePromise;
}

// A leading doctype (after a BOM, spaces and comments): the guard goes right
// after it, so the document keeps its (no-quirks) mode, and before <html>,
// <head> and every script of the lesson (the parser puts it into <head>).
const LEADING_DOCTYPE = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;

/**
 * The guard first (after the doctype), the bridge in place of the renderer's
 * marker, the last child of <body> (T050-D1: only closing tags come after it,
 * so a "</body" inside a comment or script of the lesson does not matter).
 * Without a marker (not expected for RENDER_VERSION 4): at the end of the
 * text, where the parser still puts it into <body>.
 */
function withBridge(html, { guard, bridge }) {
  const doctype = LEADING_DOCTYPE.exec(html);
  const cut = doctype ? doctype[0].length : 0;
  const withGuard = `${html.slice(0, cut)}${guard}${html.slice(cut)}`;
  const at = withGuard.lastIndexOf(BRIDGE_MARKER);
  if (at === -1) return `${withGuard}\n${bridge}`;
  return `${withGuard.slice(0, at)}${bridge}${withGuard.slice(at + BRIDGE_MARKER.length)}`;
}
