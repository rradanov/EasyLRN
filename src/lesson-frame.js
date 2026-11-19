// A lesson or reference in an isolated iframe (T-045, D-029, LESSON-ISOLATION §3–§5).
//
// - The file is loaded from ./c/<courseId>/<path>. The Service Worker answers
//   from IndexedDB with the assembled (self-contained) lesson, the bridge, and
//   a CSP with `sandbox allow-scripts`: the lesson has an opaque origin and
//   cannot reach the app (IndexedDB, caches, DOM, window), the network,
//   popups or the top window.
// - The iframe gets `sandbox="allow-scripts"` right after `src`, in the same
//   task: the first navigation (ours) still goes through the Service Worker,
//   every navigation the lesson starts itself is sandboxed too. Never
//   allow-same-origin, allow-popups*, allow-top-navigation*, allow-forms,
//   allow-modals. `allow="clipboard-write *"` lets reflect.js copy.
// - The app and the lesson talk only through postMessage (protocol v1, §5).
//   Every message is checked (§5.3): source, origin "null", shape, limits,
//   rate. Nothing secret is ever sent to the lesson.
// - The iframe has no scroll of its own (height from `lrn:size`); the app
//   window scrolls. Reading position, anchors and links are decided here.
// - A second `load`, or a document that sends no message at all within 4 s
//   after its `load` (the lesson navigated away before the bridge ran), means
//   the lesson navigated its own frame: the frame is recreated (twice in a row →
//   stopped with a message). Every document of ours speaks after its load,
//   whatever the lesson does: the guard (src/lesson-guard.js, the first script
//   of the lesson) sends `lrn:hello` (T046-D1).
// - No `lrn:ready` within 8 s → fallback: an inner scroll and a note.
// - A lesson taller than MAX_HEIGHT (T046-D2) → the frame is as tall as the
//   window and the lesson scrolls inside it (`lrn:scroll-mode`).
// - A lesson with a nested frame of its own (D-034, T048-S1) is stopped: the
//   guard reports one it could not remove (`lrn:violation`), and the app reads
//   the frame count of the lesson window from outside every 250 ms
//   (`contentWindow.length`, readable across origins, not spoofable by it).
//   A frame in a shadow root is not in that count (T050-I1): the guard sweeps
//   every shadow root it has seen, and any message to the app from a window
//   nested in the lesson stops the lesson too.
import { h } from './dom.js';
import { ensureRendered } from './lesson-render.js';

const SANDBOX = 'allow-scripts';
const ALLOW = 'clipboard-write *';
const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'orange'];
const ARTIFACT = /^https:\/\/claude\.ai\/(?:public\/)?artifacts?\/([A-Za-z0-9_-]+)/;
const SW_TIMEOUT_MS = 8000;
const READY_TIMEOUT_MS = 8000;
const SILENT_TIMEOUT_MS = 4000;
const MAX_HEIGHT = 1000000; // the frame grows with the lesson up to this, then scrolls inside (T046-D2)
const MAX_COORD = 1e8; // limit of heights and positions in messages
const MAX_MESSAGES_PER_SECOND = 60;
const PROTOCOL = 1;

/** Base URL of the virtual course files: …/EasyLRN/c/ */
export const courseBase = () => new URL('./c/', document.baseURI);

/** URL of a course file (every path segment encoded). */
export function courseFileUrl(courseId, path) {
  const segments = [courseId, ...path.split('/')].map(encodeURIComponent).join('/');
  return new URL(segments, courseBase());
}

/** { courseId, path, hash } of a URL under ./c/, else null. */
export function parseCourseUrl(href) {
  let url;
  try { url = new URL(href, document.baseURI); } catch { return null; }
  const base = courseBase();
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  try {
    const [courseId, ...parts] = url.pathname.slice(base.pathname.length).split('/').map(decodeURIComponent);
    if (!courseId || !parts.length) return null;
    return { courseId, path: parts.join('/'), hash: url.hash };
  } catch {
    return null;
  }
}

/** Wait for an active Service Worker (course files exist only through it). */
async function swReady() {
  if (!('serviceWorker' in navigator)) throw new Error('no-sw');
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), SW_TIMEOUT_MS));
  await Promise.race([ready, timeout]);
}

// --- Checks of the messages from the lesson (§5.2, §5.3) -----------------------

const isPlain = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** Validators by type: return the clean fields, or null to drop the message. */
const CHECK = {
  'lrn:hello': (m) => (m.v === PROTOCOL ? {} : null),
  'lrn:violation': (m) => (m.v === PROTOCOL ? {} : null),
  'lrn:ready': (m) => (m.v === PROTOCOL && (m.title === undefined || isStr(m.title, 300))
    && (m.textLength === undefined || isInt(m.textLength, 0, 1e7)) ? { title: m.title ?? '', textLength: m.textLength ?? 0 } : null),
  'lrn:size': (m) => (isNum(m.height, 0, MAX_COORD) ? { height: Math.ceil(m.height) } : null),
  'lrn:selection': (m) => {
    if (m.empty === true) return { empty: true };
    const q = m.quote;
    const p = m.position;
    if (!isPlain(q) || !isPlain(p) || !isStr(q.exact, 2000) || !q.exact || !isStr(q.prefix ?? '', 64) || !isStr(q.suffix ?? '', 64)) return null;
    if (!isInt(p.start, 0, 1e7) || !isInt(p.end, 0, 1e7) || p.start >= p.end) return null;
    if (m.hint !== undefined && !isStr(m.hint, 200)) return null;
    const rect = isPlain(m.rect) && isNum(m.rect.top, -MAX_COORD, MAX_COORD) && isNum(m.rect.bottom, -MAX_COORD, MAX_COORD)
      ? { top: m.rect.top, bottom: m.rect.bottom } : null;
    return {
      empty: false,
      quote: { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '' },
      position: { start: p.start, end: p.end },
      hint: m.hint ?? null,
      rect,
      inExcluded: m.inExcluded === true,
    };
  },
  'lrn:tap': (m) => (m.annotationId === null || isStr(m.annotationId, 64) ? { annotationId: m.annotationId } : null),
  'lrn:anchored': (m) => (Array.isArray(m.results) && m.results.length <= 10000 ? { results: m.results } : null),
  'lrn:layout': (m) => (Array.isArray(m.items) && m.items.length <= 10000 && isNum(m.height, 0, MAX_COORD) ? { items: m.items, height: m.height } : null),
  'lrn:position': (m) => (m.top === null || isNum(m.top, 0, MAX_COORD) ? { top: m.top } : null),
  'lrn:anchor': (m) => (isNum(m.top, 0, MAX_COORD) ? { top: m.top } : null),
  'lrn:link': (m) => (isStr(m.href, 2048) && m.href ? { href: m.href } : null),
  'lrn:fonts-ok': (m) => (isInt(m.loaded, 0, 64) ? { loaded: m.loaded } : null),
};

/** Highlight colours of the app (CSS variables), for `lrn:init`. */
function palette() {
  const root = getComputedStyle(document.documentElement);
  return Object.fromEntries(HIGHLIGHTS.map((c) => [c, root.getPropertyValue(`--hl-${c}`).trim() || 'Highlight']));
}

const warn = (why, detail) => console.warn(`EasyLRN: lesson message ignored (${why})`, detail ?? '');

/**
 * Create the lesson frame.
 * @param {{ course: object, lesson: object, lessons: object[], fontScale?: number,
 *   initialScroll?: number, hash?: string, onNavigate: (lesson: object, hash: string) => void,
 *   onScroll?: (y: number) => void }} opts
 * @returns {{ element: HTMLElement, readonly frame: HTMLIFrameElement|null, ready: Promise<void>,
 *   readonly selection: object|null, setFontScale: (scale: number) => void, destroy: () => void }}
 */
export function createLessonFrame({ course, lesson, lessons, fontScale = 1, initialScroll = 0, hash = '', onNavigate, onScroll }) {
  const src = courseFileUrl(course.id, lesson.path);
  const status = h('p', { class: 'muted lesson-frame__status', role: 'status', text: 'Зареждам урока…' });
  const note = h('p', { class: 'muted lesson-frame__note', role: 'status', 'data-field': 'lesson-note', hidden: true });
  const element = h('div', { class: 'lesson-frame__wrap', 'data-lesson-state': 'loading' }, status, note);

  const byPath = new Map(lessons.map((l) => [l.path, l]));
  const lowerExt = (p) => p.replace(/\.[^./]+$/, (e) => e.toLowerCase());
  let links = new Set();
  let frame = null;
  let destroyed = false;
  let scale = fontScale;
  let selection = null;

  // Per frame (a recreated frame starts again).
  let loads = 0;
  let initSent = false;
  let initialized = false;
  let readyTimer = null;
  let silentTimer = null;
  let heard = false; // any message from the current document of the frame since its load
  let innerScroll = false; // the lesson is taller than MAX_HEIGHT: it scrolls inside the frame
  let rate = { start: 0, count: 0 };
  let selfNavigations = 0;

  let resolveReady;
  const ready = new Promise((res, rej) => { resolveReady = res; void rej; });

  const setState = (s) => element.setAttribute('data-lesson-state', s);
  const showNote = (text) => { note.textContent = text; note.hidden = !text; };
  const fail = (text) => {
    status.textContent = text;
    status.hidden = false;
    status.classList.add('lesson-frame__status--error');
    if (frame) frame.hidden = true;
    setState('error');
    resolveReady();
  };

  const post = (msg, transfer) => {
    try { frame?.contentWindow?.postMessage({ lrn: PROTOCOL, ...msg }, '*', transfer || []); } catch { /* frame gone */ }
  };

  // --- Geometry and scrolling of the app window ---------------------------------
  const barHeight = () => document.querySelector('.app-bar')?.getBoundingClientRect().height ?? 0;
  const frameTop = () => (frame || element).getBoundingClientRect().top + window.scrollY;
  const scrollToLessonY = (y) => window.scrollTo({ top: Math.max(0, frameTop() + y - barHeight() - 8) });
  const scrollToLessonTop = () => window.scrollTo({ top: Math.max(0, frameTop() - barHeight()) });

  // --- Reading position (T010-D2) ------------------------------------------------
  // Recorded only from `scroll` events while this reader is active, after the
  // position was restored; stops at the first popstate/hashchange (before the
  // next screen renders). destroy() saves the last recorded value as it is.
  let recording = false;
  let lastY = null;
  let pendingSave = false;
  let saveTimer = null;
  const flush = () => {
    saveTimer = null;
    if (!pendingSave || lastY == null) return;
    pendingSave = false;
    onScroll?.(lastY);
  };
  const onWindowScroll = () => {
    if (!recording || destroyed || !frame) return;
    lastY = Math.max(0, Math.round(window.scrollY - (frameTop() - barHeight())));
    pendingSave = true;
    if (!saveTimer) saveTimer = setTimeout(flush, 400);
  };
  const stopRecording = () => { recording = false; };
  window.addEventListener('scroll', onWindowScroll, { passive: true });
  window.addEventListener('popstate', stopRecording, true);
  window.addEventListener('hashchange', stopRecording, true);

  let restored = false;
  let positionWanted = null; // 'restore' | 'fragment' while waiting for lrn:position
  let positionTimer = null;
  const startRecording = () => {
    recording = true;
    resolveReady();
  };
  const askPosition = (fragment, why) => {
    positionWanted = why;
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      if (positionWanted === 'restore') startRecording();
      positionWanted = null;
    }, 1500);
    post({ type: 'lrn:scroll-to', fragment });
  };
  const restore = () => {
    if (restored) {
      // A recreated frame: back to where the reader was.
      if (lastY != null) window.scrollTo({ top: Math.max(0, frameTop() - barHeight() + lastY) });
      return;
    }
    restored = true;
    const fragment = hash && hash.length > 1 ? hash.slice(1) : '';
    if (fragment) {
      askPosition(fragment, 'restore');
      return;
    }
    if (initialScroll > 0) window.scrollTo({ top: Math.max(0, frameTop() - barHeight() + initialScroll) });
    startRecording();
  };

  // --- Links (§4.3) ------------------------------------------------------------------
  const openLink = (href) => {
    let url;
    try { url = new URL(href); } catch { warn('bad URL', href); return; }
    if (!navigator.userActivation?.isActive) { warn('no user gesture', url.href); return; }

    const target = parseCourseUrl(url.href);
    if (target) {
      if (target.courseId !== course.id) { warn('another course', url.href); return; }
      if (target.path === lesson.path || lowerExt(target.path) === lesson.path) {
        if (target.hash.length > 1) askPosition(target.hash.slice(1), 'fragment');
        else scrollToLessonTop();
        return;
      }
      const other = byPath.get(target.path) || byPath.get(lowerExt(target.path));
      if (other) onNavigate(other, target.hash);
      else warn('not a lesson of the course', url.href);
      return;
    }
    const artifact = ARTIFACT.exec(url.href)?.[1];
    if (artifact) {
      const path = course.meta?.artifacts?.[artifact];
      const local = path && byPath.get(path);
      if (local) {
        if (local.id === lesson.id) scrollToLessonTop();
        else onNavigate(local, '');
        return;
      }
    }
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== location.origin && links.has(url.href)) {
      window.open(url.href, '_blank', 'noopener,noreferrer');
      return;
    }
    warn('not in the links of the lesson', url.href);
  };

  // --- Messages ----------------------------------------------------------------------
  const sendInit = () => {
    initSent = true;
    post({ type: 'lrn:init', palette: palette(), fontScale: scale, exclude: [] });
  };
  const handlers = {
    'lrn:ready'() {
      if (!initSent) { sendInit(); return; }
      if (initialized) return;
      initialized = true;
      selfNavigations = 0;
      clearTimeout(readyTimer);
      status.hidden = true;
      if (element.getAttribute('data-lesson-state') !== 'ready') setState('ready');
      // No secrets: an empty list until T-015 (annotations are quotes of the lesson itself).
      post({ type: 'lrn:annotations', items: [] });
      restore();
    },
    'lrn:hello'() { /* `heard` is set for every message */ },
    'lrn:violation'() { stopForFrames(); },
    'lrn:size'({ height }) {
      if (!frame || element.getAttribute('data-lesson-state') === 'fallback') return;
      if (height > MAX_HEIGHT) {
        if (!innerScroll) {
          innerScroll = true;
          element.setAttribute('data-lesson-scroll', 'inner');
          frame.removeAttribute('scrolling');
          post({ type: 'lrn:scroll-mode', inner: true });
          showNote('Урокът е много дълъг: превърта се вътре в рамката.');
        }
        frame.style.height = `${viewportFrameHeight()}px`;
        return;
      }
      if (!innerScroll) frame.style.height = `${height}px`;
    },
    'lrn:selection'(m) { selection = m.empty ? null : m; },
    'lrn:tap'() { /* T-015: only known annotation ids open a card; there are none yet. */ },
    'lrn:anchored'() { /* T-015 */ },
    'lrn:layout'() { /* T-017 */ },
    'lrn:fonts-ok'() {},
    'lrn:position'({ top }) {
      const why = positionWanted;
      if (!why) return; // never asked: ignore
      positionWanted = null;
      clearTimeout(positionTimer);
      if (top != null) scrollToLessonY(top);
      else if (why === 'fragment') scrollToLessonTop();
      if (why === 'restore') startRecording();
    },
    'lrn:anchor'({ top }) {
      if (!navigator.userActivation?.isActive) { warn('no user gesture', 'lrn:anchor'); return; }
      scrollToLessonY(top);
    },
    'lrn:link'({ href }) { openLink(href); },
  };

  const rateOk = () => {
    const now = performance.now();
    if (now - rate.start > 1000) rate = { start: now, count: 0 };
    rate.count++;
    return rate.count <= MAX_MESSAGES_PER_SECOND;
  };
  /** Is `win` a window nested inside the lesson (a frame of the lesson, at any depth)? */
  const nestedInLesson = (win) => {
    const lessonWin = frame?.contentWindow;
    if (!win || !lessonWin || win === lessonWin) return false;
    try {
      // `parent` is readable across origins; a lesson cannot fake it for a window of its own.
      for (let w = win, i = 0; w && i < 20; i++) {
        const up = w.parent;
        if (up === lessonWin) return true;
        if (!up || up === w) return false;
        w = up;
      }
    } catch { /* unreachable window */ }
    return false;
  };
  const onMessage = (event) => {
    // T050-I1: a nested document that talks to the app proves a frame the
    // frame count cannot see (e.g. inside a shadow root of the lesson).
    if (!destroyed && frame && nestedInLesson(event.source)) { stopForFrames(); return; }
    if (destroyed || !frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
    heard = true;
    if (!rateOk()) return;
    const m = event.data;
    if (!isPlain(m) || m.lrn !== PROTOCOL || typeof m.type !== 'string' || !Object.hasOwn(CHECK, m.type)) return;
    const clean = CHECK[m.type](m);
    if (!clean) { warn('invalid fields', m.type); return; }
    handlers[m.type](clean);
  };
  window.addEventListener('message', onMessage);

  const onSettings = (event) => {
    const next = event.detail?.fontScale;
    if (typeof next !== 'number' || next === scale) return;
    scale = next;
    if (initSent) post({ type: 'lrn:settings', fontScale: scale });
  };
  window.addEventListener('easylrn:settings', onSettings);

  // --- The iframe ----------------------------------------------------------------------
  const viewportFrameHeight = () => Math.max(320, Math.round(window.innerHeight - barHeight()));
  const fallback = () => {
    if (destroyed || initialized || !frame) return;
    setState('fallback');
    status.hidden = true;
    frame.removeAttribute('scrolling');
    frame.style.height = `${viewportFrameHeight()}px`;
    showNote('Маркирането не е налично за този урок.');
    if (!restored) { restored = true; startRecording(); }
  };

  /** The lesson has a nested frame (D-034): remove the lesson (and with it every nested document). */
  let frameWatch = null;
  const stopForFrames = () => {
    if (destroyed || !frame) return;
    clearInterval(frameWatch);
    frameWatch = null;
    frame.remove();
    frame = null;
    clearTimeout(readyTimer);
    clearTimeout(silentTimer);
    showNote('');
    console.warn('EasyLRN: the lesson created a nested frame (D-034) and was stopped.');
    fail('Урокът е спрян: опита да отвори вграден прозорец (frame), а това не е позволено. Създай урока отново.');
    element.setAttribute('data-lesson-stopped', 'frame');
  };
  const watchFrames = () => {
    clearInterval(frameWatch);
    frameWatch = setInterval(() => {
      if (destroyed || !frame) { clearInterval(frameWatch); return; }
      let count = 0;
      try { count = frame.contentWindow?.length ?? 0; } catch { count = 0; }
      if (count > 0) stopForFrames();
    }, 250);
  };

  /** The lesson navigated its own frame (§3.1): load the lesson again, but never in a loop. */
  const reloadAfterNavigation = () => {
    selfNavigations++;
    if (selfNavigations >= 2) {
      frame.remove();
      frame = null;
      clearTimeout(readyTimer);
      clearTimeout(silentTimer);
      showNote('');
      fail('Урокът опитва да отвори други страници и е спрян. Отвори го отново от курса.');
      return;
    }
    showNote('Урокът се опита да отвори друга страница; зареден е отново.');
    createFrame();
  };

  const onLoad = (event) => {
    if (destroyed || event.currentTarget !== frame) return;
    loads++;
    clearTimeout(silentTimer);
    if (loads > 1) { reloadAfterNavigation(); return; }
    // Only what the document says after its load counts (the guard's lrn:hello):
    // a lesson that navigates away at once may have spoken before it left.
    heard = false;
    // The lesson itself, unless it navigated away before its bridge ran: then the
    // document that loaded is not ours and never says anything.
    silentTimer = setTimeout(() => {
      if (!destroyed && frame && !heard && !initialized) reloadAfterNavigation();
    }, SILENT_TIMEOUT_MS);
  };

  function createFrame() {
    frame?.remove();
    loads = 0;
    heard = false;
    innerScroll = false;
    element.removeAttribute('data-lesson-scroll');
    clearTimeout(silentTimer);
    initSent = false;
    initialized = false;
    rate = { start: 0, count: 0 };
    clearTimeout(readyTimer);
    setState('loading');
    const f = document.createElement('iframe');
    f.className = 'lesson-frame';
    f.title = lesson.title;
    f.setAttribute('allow', ALLOW); // before src: the permissions of a document are fixed when it loads
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('data-lesson-frame', lesson.id);
    f.addEventListener('load', onLoad);
    f.src = src.href;
    frame = f;
    element.append(f); // the navigation starts here, without the sandbox attribute → the SW serves it
    f.setAttribute('sandbox', SANDBOX); // same task: every later navigation is sandboxed (§2а)
    readyTimer = setTimeout(fallback, READY_TIMEOUT_MS);
    watchFrames();
  }

  /** The iframe must start loading only once it is in the document (see createFrame). */
  const connected = () => new Promise((resolve) => {
    const check = (n) => (element.isConnected || destroyed || n > 300 ? resolve() : requestAnimationFrame(() => check(n + 1)));
    check(0);
  });

  (async () => {
    let file;
    try {
      file = await ensureRendered(course.id, lesson.path);
    } catch (err) {
      console.warn('Cannot prepare the lesson:', err);
      fail('Урокът не може да се подготви за показване.');
      return;
    }
    if (destroyed) return;
    if (!file) { fail('Файлът на урока липсва. Импортирай курса отново.'); return; }
    links = new Set(Array.isArray(file.links) ? file.links : []);
    try {
      await swReady();
    } catch {
      fail('Урокът не може да се покаже: офлайн режимът (Service Worker) още не е готов. Презареди приложението.');
      return;
    }
    await connected();
    if (destroyed || !element.isConnected) return;
    createFrame();
  })();

  return {
    element,
    get frame() { return frame; },
    ready,
    /** The last selection reported by the lesson (checked), or null. Used by T-015. */
    get selection() { return selection; },
    setFontScale(next) {
      if (typeof next !== 'number' || !Number.isFinite(next)) return;
      scale = next;
      if (initSent) post({ type: 'lrn:settings', fontScale: scale });
    },
    destroy() {
      if (destroyed) return;
      recording = false;
      clearTimeout(saveTimer);
      flush(); // the last value recorded from a scroll event, never re-measured here
      destroyed = true;
      clearTimeout(readyTimer);
      clearTimeout(silentTimer);
      clearTimeout(positionTimer);
      clearInterval(frameWatch);
      window.removeEventListener('scroll', onWindowScroll);
      window.removeEventListener('popstate', stopRecording, true);
      window.removeEventListener('hashchange', stopRecording, true);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('easylrn:settings', onSettings);
      resolveReady();
    },
  };
}
