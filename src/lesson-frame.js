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
// - T-015: the marks (D-042). The drawing gesture is the user's, in the app
//   (src/screens/mark-tools.js); `stroke()` sends its points (lrn:stroke) and
//   only the bridge's answer to THAT stroke (lrn:stroked, same number, within
//   3 s, checked like a selection; eraser: known ids only) is handed back. A
//   lesson cannot start a stroke. `lrn:selection` / `lrn:layout` /
//   `lrn:described` are checked here too. To the lesson go only its own
//   annotations (id, colour, style, selector), the focus id and
//   `lrn:describe` for one of its own ids.
import { h } from './dom.js';
import { ensureRendered } from './lesson-render.js';
import { resolveLessonPath } from './lesson-id.js';
import { lessonAnnotations, bridgeItems, checkAnchored, anchorSaver, annotateSelection } from './annotations.js';
import { HIGHLIGHT_PALETTE, PENCIL_PALETTE } from './highlight.js';

const SANDBOX = 'allow-scripts';
const ALLOW = 'clipboard-write *';
const ARTIFACT = /^https:\/\/claude\.ai\/(?:public\/)?artifacts?\/([A-Za-z0-9_-]+)/;
const SW_TIMEOUT_MS = 8000;
const READY_TIMEOUT_MS = 8000;
const SILENT_TIMEOUT_MS = 4000;
const MAX_HEIGHT = 1000000; // the frame grows with the lesson up to this, then scrolls inside (T046-D2)
const MAX_COORD = 1e8; // limit of heights and positions in messages
const MAX_MESSAGES_PER_SECOND = 60;
const PROTOCOL = 1;
const STROKE_TOOLS = ['marker', 'pencil', 'eraser'];
const STROKE_ANSWER_MS = 3000;

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
    const rectOf = (r) => (isPlain(r) && isNum(r.top, -MAX_COORD, MAX_COORD) && isNum(r.bottom, -MAX_COORD, MAX_COORD) ? { top: r.top, bottom: r.bottom } : null);
    // Only inside an excluded part (a quiz, data-lrn-noanno): a quote, no position, no mark (T-015).
    if (m.excludedOnly === true) {
      if (!isPlain(q) || !isStr(q.exact, 2000) || !q.exact || p !== undefined) return null;
      return { empty: false, excludedOnly: true, quote: { exact: q.exact, prefix: '', suffix: '' }, position: null, hint: null, rect: rectOf(m.rect), inExcluded: true };
    }
    if (!isPlain(q) || !isPlain(p) || !isStr(q.exact, 2000) || !q.exact || !isStr(q.prefix ?? '', 64) || !isStr(q.suffix ?? '', 64)) return null;
    if (!isInt(p.start, 0, 1e7) || !isInt(p.end, 0, 1e7) || p.start >= p.end) return null;
    if (m.hint !== undefined && !isStr(m.hint, 200)) return null;
    const rect = rectOf(m.rect);
    return {
      empty: false,
      excludedOnly: false,
      quote: { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '' },
      position: { start: p.start, end: p.end },
      hint: m.hint ?? null,
      rect,
      inExcluded: m.inExcluded === true,
    };
  },
  'lrn:escape': () => ({}),
  // No 'lrn:undo' (D-044): the lesson cannot ask for an undo; such a message is
  // not a known type and is dropped.
  // T-015: the answer to the app's own stroke (marker / pencil: the text; eraser: ids).
  'lrn:stroked': (m) => {
    if (!isInt(m.seq, 0, 1e9) || !STROKE_TOOLS.includes(m.tool)) return null;
    if (m.tool === 'eraser') {
      if (!Array.isArray(m.ids) || m.ids.length > 5000 || !m.ids.every((id) => isStr(id, 64) && id)) return null;
      return { seq: m.seq, tool: m.tool, ids: [...new Set(m.ids)] };
    }
    if (m.quote === null) return { seq: m.seq, tool: m.tool, quote: null };
    const q = m.quote;
    const p = m.position;
    if (!isPlain(q) || !isStr(q.exact, 2000) || !q.exact || !isStr(q.prefix ?? '', 64) || !isStr(q.suffix ?? '', 64)) return null;
    if (!isPlain(p) || !isInt(p.start, 0, 1e7) || !isInt(p.end, 0, 1e7) || p.start >= p.end) return null;
    if (m.hint !== undefined && !isStr(m.hint, 200)) return null;
    return {
      seq: m.seq, tool: m.tool,
      quote: { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '' },
      position: { start: p.start, end: p.end },
      hint: m.hint ?? null,
      covered: m.covered === true,
    };
  },
  'lrn:tap': (m) => (m.annotationId === null || isStr(m.annotationId, 64) ? { annotationId: m.annotationId } : null),
  'lrn:anchored': (m) => (Array.isArray(m.results) && m.results.length <= 10000
    && (m.textLength === undefined || isInt(m.textLength, 0, 1e7)) ? { results: m.results, textLength: m.textLength ?? null } : null),
  'lrn:layout': (m) => (Array.isArray(m.items) && m.items.length <= 10000 && isNum(m.height, 0, MAX_COORD) ? { items: m.items, height: m.height } : null),
  'lrn:described': (m) => {
    if (!isStr(m.annotationId, 64) || !m.annotationId) return null;
    if (m.quote === null) return { annotationId: m.annotationId, quote: null, position: null, hint: null };
    const q = m.quote;
    const p = m.position;
    if (!isPlain(q) || !isStr(q.exact, 2000) || !q.exact || !isStr(q.prefix ?? '', 64) || !isStr(q.suffix ?? '', 64)) return null;
    if (!isPlain(p) || !isInt(p.start, 0, 1e7) || !isInt(p.end, 0, 1e7) || p.start >= p.end) return null;
    if (m.hint !== undefined && !isStr(m.hint, 200)) return null;
    return { annotationId: m.annotationId, quote: { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '' }, position: { start: p.start, end: p.end }, hint: m.hint ?? null };
  },
  'lrn:position': (m) => (m.top === null || isNum(m.top, 0, MAX_COORD) ? { top: m.top } : null),
  'lrn:anchor': (m) => (isNum(m.top, 0, MAX_COORD) ? { top: m.top } : null),
  'lrn:link': (m) => (isStr(m.href, 2048) && m.href ? { href: m.href } : null),
  'lrn:fonts-ok': (m) => (isInt(m.loaded, 0, 64) ? { loaded: m.loaded } : null),
};


// T051-I3: what a lesson sends (a URL it built, maybe from text typed into it,
// even a key typed into a phishing lesson) never goes into the console of the
// app: a URL is shown only as its scheme and lengths (a host can carry data
// too: https://<data>.example/), anything else only as its type and length.
/** "https: URL, host 12 + 40 characters" / "text, 42 characters" / "object". */
const KNOWN_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'file:', 'about:', 'ws:', 'wss:', 'ftp:']);
export function describeForLog(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) return value === null ? 'null' : typeof value;
  const text = String(value);
  let url = null;
  try { url = new URL(text); } catch { url = null; }
  if (!url) return `text, ${text.length} characters`;
  const scheme = KNOWN_SCHEMES.has(url.protocol) ? url.protocol : 'other:';
  return `${scheme} URL, host ${url.host.length} + ${url.href.length - url.protocol.length - url.host.length} characters`;
}
const warn = (why, detail) => console.warn(`EasyLRN: lesson message ignored (${why})`, detail === undefined ? '' : describeForLog(detail));

/**
 * Create the lesson frame.
 * @param {{ course: object, lesson: object, lessons: object[], fontScale?: number,
 *   initialScroll?: number, hash?: string, onNavigate: (lesson: object, hash: string) => void,
 *   onScroll?: (y: number) => void, onTap?: (annotation: object|null) => void,
 *   onAnchored?: (annotations: object[]) => void, onSelection?: (selection: object|null) => void,
 *   onLayout?: (places: Map<string, {top: number, bottom: number}>, height: number) => void, onEscape?: () => void }} opts
 * @returns {{ element: HTMLElement, readonly frame: HTMLIFrameElement|null, ready: Promise<void>,
 *   readonly selection: object|null, readonly annotations: object[], annotate: (color: string|null) => Promise<object>,
 *   reloadAnnotations: () => Promise<void>, setFontScale: (scale: number) => void, destroy: () => void }}
 */
export function createLessonFrame({ course, lesson, lessons, fontScale = 1, initialScroll = 0, hash = '', onNavigate, onScroll, onTap, onAnchored, onSelection, onLayout, onEscape }) {
  const src = courseFileUrl(course.id, lesson.path);
  const status = h('p', { class: 'muted lesson-frame__status', role: 'status', text: 'Зареждам урока…' });
  const note = h('p', { class: 'muted lesson-frame__note', role: 'status', 'data-field': 'lesson-note', hidden: true });
  const element = h('div', { class: 'lesson-frame__wrap', 'data-lesson-state': 'loading' }, status, note);

  // D-039 §А.3: a link path → the lesson by path, an earlier path, or the number in the file name.
  const lessonAt = (path) => resolveLessonPath(lessons, path);
  let links = new Set();
  let frame = null;
  let destroyed = false;
  let scale = fontScale;
  let selection = null;
  // T-013: the annotations of THIS lesson (id → record) and the text length the
  // bridge reported (limits of the positions it may send back).
  let known = new Map();
  let textLength = null;
  let layout = new Map(); // id → {top, bottom} from lrn:layout
  let describing = null; // { id, resolve, timer } while waiting for lrn:described
  let focused = null;
  let strokeSeq = 0;
  let stroking = null; // { seq, tool } of the user's stroke in progress (T-015)
  const answers = new Map(); // seq → { tool, resolve, timer }: finished strokes waiting for lrn:stroked
  const saver = anchorSaver(lesson);
  let annotationsRun = 0;
  const sendAnnotations = async () => {
    const run = ++annotationsRun;
    let list = [];
    try { list = await lessonAnnotations(lesson); } catch (err) { console.warn('Cannot read the annotations:', err?.name || err); }
    if (destroyed || run !== annotationsRun || !initialized) return;
    known = new Map(list.map((a) => [a.id, a]));
    // No secrets (§5.1): quotes of this lesson itself, colours, positions.
    post({ type: 'lrn:annotations', items: bridgeItems(list, lesson) });
  };

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
  // T060-D1: the reader's own jump to the restored place (a fragment `?at=`
  // or the saved position) is not a scroll of the user. Its scroll event comes
  // after startRecording(); while the window is still where that jump put it,
  // the event is ignored, so the history keeps the fragment until the user
  // really scrolls.
  let ownJumpY = null;
  const jumpTo = (top) => {
    window.scrollTo({ top: Math.max(0, top) });
    ownJumpY = Math.round(window.scrollY);
  };
  const onWindowScroll = () => {
    if (!recording || destroyed || !frame) return;
    if (ownJumpY != null) {
      if (Math.abs(Math.round(window.scrollY) - ownJumpY) <= 1) return;
      ownJumpY = null;
    }
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
    if (initialScroll > 0) jumpTo(frameTop() - barHeight() + initialScroll);
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
      const other = lessonAt(target.path);
      if (other && other.id === lesson.id) {
        if (target.hash.length > 1) askPosition(target.hash.slice(1), 'fragment');
        else scrollToLessonTop();
        return;
      }
      if (other) onNavigate(other, target.hash);
      else warn('not a lesson of the course', url.href);
      return;
    }
    const artifact = ARTIFACT.exec(url.href)?.[1];
    if (artifact) {
      const path = course.meta?.artifacts?.[artifact];
      const local = path && lessonAt(path);
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
    post({
      type: 'lrn:init',
      palette: { ...HIGHLIGHT_PALETTE.light },
      paletteDark: { ...HIGHLIGHT_PALETTE.dark },
      pencil: { ...PENCIL_PALETTE.light },
      pencilDark: { ...PENCIL_PALETTE.dark },
      fontScale: scale,
      exclude: [],
    });
  };
  const handlers = {
    'lrn:ready'({ textLength: reported }) {
      if (!initSent) { sendInit(); return; }
      if (initialized) return;
      initialized = true;
      textLength = reported;
      selfNavigations = 0;
      clearTimeout(readyTimer);
      status.hidden = true;
      if (element.getAttribute('data-lesson-state') !== 'ready') setState('ready');
      restore();
      sendAnnotations();
      if (focused) post({ type: 'lrn:focus', annotationId: focused });
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
    'lrn:selection'(m) {
      selection = m.empty ? null : m;
      onSelection?.(selection);
    },
    'lrn:escape'() { onEscape?.(); },
    'lrn:stroked'(m) {
      // Only the answer to a stroke the user has just finished in the app.
      const wait = answers.get(m.seq);
      if (!wait || wait.tool !== m.tool) { warn('unasked: lrn:stroked'); return; }
      answers.delete(m.seq);
      clearTimeout(wait.timer);
      if (m.tool === 'eraser') {
        const ids = m.ids.filter((id) => known.has(id));
        if (ids.length !== m.ids.length) warn('unknown annotation: lrn:stroked');
        wait.resolve({ tool: m.tool, ids });
        return;
      }
      if (m.quote && Number.isInteger(textLength) && m.position.end > textLength) { warn('position out of the text: lrn:stroked'); wait.resolve(null); return; }
      wait.resolve(m.quote ? { tool: m.tool, quote: m.quote, position: m.position, hint: m.hint, covered: m.covered } : { tool: m.tool, quote: null });
    },
    'lrn:tap'({ annotationId }) {
      // Only a known id of this lesson opens anything (T-015: the card).
      if (annotationId !== null && !known.has(annotationId)) { warn('unknown annotation: lrn:tap'); return; }
      onTap?.(annotationId === null ? null : known.get(annotationId));
    },
    'lrn:anchored'({ results, textLength: reported }) {
      // The text may grow after lrn:ready (the lesson's scripts): the new length is the limit.
      if (Number.isInteger(reported)) textLength = reported;
      const limit = textLength;
      const clean = checkAnchored(results, known, limit);
      if (results.length && !clean.length) warn('no known annotation: lrn:anchored');
      saver.add(known, clean);
      for (const r of clean) {
        const a = known.get(r.id);
        if (a) { a.anchorState = r.state; a.anchoredTop = r.top; a.anchoredBottom = r.bottom; }
      }
      element.setAttribute('data-anchored', String(clean.length));
      onAnchored?.([...known.values()]);
    },
    'lrn:layout'({ items, height }) {
      // Places of the marks (the margin of the reader): known ids only, numbers only.
      const places = new Map();
      for (const it of items.slice(0, 10000)) {
        if (!isPlain(it) || !isStr(it.id, 64) || !known.has(it.id) || places.has(it.id)) continue;
        if (!isNum(it.top, 0, MAX_COORD) || !isNum(it.bottom, 0, MAX_COORD)) continue;
        places.set(it.id, { top: it.top, bottom: Math.max(it.top, it.bottom) });
      }
      layout = places;
      onLayout?.(places, height);
    },
    'lrn:described'(m) {
      // Only the answer to our own pending question, for that id.
      const wait = describing;
      if (!wait || wait.id !== m.annotationId) { warn('unasked: lrn:described'); return; }
      describing = null;
      clearTimeout(wait.timer);
      wait.resolve(m.quote ? { quote: m.quote, position: m.position, hint: m.hint } : null);
    },
    'lrn:fonts-ok'() {},
    'lrn:position'({ top }) {
      const why = positionWanted;
      if (!why) return; // never asked: ignore
      positionWanted = null;
      clearTimeout(positionTimer);
      if (why === 'restore') {
        if (top != null) jumpTo(frameTop() + top - barHeight() - 8);
        startRecording();
        return;
      }
      if (top != null) scrollToLessonY(top);
      else scrollToLessonTop();
    },
    'lrn:anchor'({ top }) {
      if (!navigator.userActivation?.isActive) { warn('no user gesture: lrn:anchor'); return; }
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
    if (!clean) { warn(`invalid fields: ${m.type}`); return; } // m.type is one of CHECK's own keys
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
    /** The annotations of this lesson with their last anchoring (`anchorState`). */
    get annotations() { return [...known.values()]; },
    /**
     * A new annotation from the last selection (T-015's bottom bar calls this;
     * no button here yet), then the whole list goes to the lesson again.
     */
    async annotate(color = null, from = selection) {
      const created = await annotateSelection({ course, lesson, selection: from, color });
      await sendAnnotations();
      return created;
    },
    /** The places of the marks from the last `lrn:layout` (frame coordinates). */
    get layout() { return layout; },
    /** The frame around the active mark (`lrn:focus`), or none. */
    focus(id) {
      focused = typeof id === 'string' && known.has(id) ? id : null;
      if (initialized) post({ type: 'lrn:focus', annotationId: focused });
    },
    /** Clear the selection in the lesson (after a mark is made: the system menu goes away). */
    clearSelection() {
      selection = null;
      if (initialized) post({ type: 'lrn:clear-selection' });
    },
    /** Scroll the app window to a mark of this lesson. */
    scrollToAnnotation(id) {
      const place = layout.get(id) || (known.get(id)?.anchoredTop != null ? { top: known.get(id).anchoredTop } : null);
      if (place) scrollToLessonY(Math.max(0, place.top - Math.round(window.innerHeight / 3)));
      return Boolean(place);
    },
    /** The selector of a mark at the place the bridge found it now (for "Да, тук е"), or null. */
    describe(id) {
      if (!known.has(id) || !initialized) return Promise.resolve(null);
      if (describing) { clearTimeout(describing.timer); describing.resolve(null); }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (describing?.id === id) describing = null; resolve(null); }, 3000);
        describing = { id, resolve, timer };
        post({ type: 'lrn:describe', annotationId: id });
      });
    },
    /**
     * The drawing tools (T-015, D-042): one stroke of the user, in the
     * coordinates of the frame. `start` begins it (a new number), `move` adds
     * a point, `end` finishes it and resolves with the bridge's checked answer
     * ({ tool, quote, position, hint, covered } / { tool, ids } / null),
     * `cancel` drops it (a second finger: scrolling).
     */
    stroke(phase, { x = 0, y = 0, tool = null, color = null } = {}) {
      if (!initialized || !frame) return Promise.resolve(null);
      const px = Math.round(x * 10) / 10;
      const py = Math.round(y * 10) / 10;
      if (phase === 'start') {
        if (stroking) post({ type: 'lrn:stroke', phase: 'cancel', seq: stroking.seq });
        const seq = ++strokeSeq;
        stroking = { seq, tool };
        post({ type: 'lrn:stroke', phase, seq, tool, color, x: px, y: py });
        return Promise.resolve(null);
      }
      const current = stroking;
      if (!current) return Promise.resolve(null);
      if (phase === 'move') { post({ type: 'lrn:stroke', phase, seq: current.seq, x: px, y: py }); return Promise.resolve(null); }
      stroking = null;
      if (phase === 'cancel') {
        post({ type: 'lrn:stroke', phase, seq: current.seq });
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { answers.delete(current.seq); resolve(null); }, STROKE_ANSWER_MS);
        answers.set(current.seq, { tool: current.tool, resolve, timer });
        while (answers.size > 8) { const [k, w] = answers.entries().next().value; clearTimeout(w.timer); w.resolve(null); answers.delete(k); }
        post({ type: 'lrn:stroke', phase: 'end', seq: current.seq, x: px, y: py });
      });
    },
    /** A tap with a tool on: the lesson's own control at that point (a quiz answer, a link). */
    activate(x, y) {
      if (initialized && frame) post({ type: 'lrn:activate', x: Math.round(x), y: Math.round(y) });
    },
    /** Two fingers on a lesson that scrolls inside its frame (T046-D2). */
    scrollInside(dx, dy) {
      if (initialized && frame && innerScroll) post({ type: 'lrn:scroll-by', dx: Math.round(dx), dy: Math.round(dy) });
      return innerScroll;
    },
    /** Is the bridge of this lesson ready (the tools work only then)? */
    get bridgeReady() { return initialized && !!frame; },
    /** Read the annotations again and send them to the lesson (after a change elsewhere). */
    reloadAnnotations: () => sendAnnotations(),
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
      saver.flush();
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
      if (describing) { clearTimeout(describing.timer); describing.resolve(null); describing = null; }
      stroking = null;
      for (const w of answers.values()) { clearTimeout(w.timer); w.resolve(null); }
      answers.clear();
      resolveReady();
    },
  };
}
