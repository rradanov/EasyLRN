// A lesson or reference from IndexedDB in an iframe (T-009, ARCHITECTURE §5, D-011).
//
// - The file is loaded from the virtual address ./c/<courseId>/<path>; the
//   Service Worker answers from IndexedDB with a CSP without network access.
// - sandbox: scripts and same-origin (the lesson's own quiz.js / reflect.js run
//   unchanged, the app reaches the DOM and the selection); popups only for
//   links the app opens itself. No top navigation, no forms, no modals.
// - The iframe has no scroll of its own: its height follows the content
//   (ResizeObserver), the app column scrolls.
// - Injected style: text size (settings.fontScale) and ::highlight() colours.
// - Links: a lesson/reference of the course or its claude.ai artifact → opens
//   in the app; in-page anchors → scroll; everything else → a new tab.
import { h } from './dom.js';

const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';
const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'orange'];
const ARTIFACT = /^https:\/\/claude\.ai\/(?:public\/)?artifacts?\/([A-Za-z0-9_-]+)/;
const SW_TIMEOUT_MS = 8000;

/** Base URL of the virtual course files: …/EasyLRN/c/ */
export const courseBase = () => new URL('./c/', document.baseURI);

/** URL of a course file (every path segment encoded). */
export function courseFileUrl(courseId, path) {
  const segments = [courseId, ...path.split('/')].map(encodeURIComponent).join('/');
  return new URL(segments, courseBase());
}

/** { courseId, path } of a URL under ./c/, else null. */
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

function injectedCss({ fontScale, baseFontPx }) {
  const root = getComputedStyle(document.documentElement);
  const rules = [
    // The iframe is as tall as its content; the app column scrolls.
    'html { height: auto !important; min-height: 0 !important; overflow-y: hidden !important; }',
    'body { min-height: 0 !important; }',
  ];
  if (fontScale && fontScale !== 1 && baseFontPx) {
    rules.push(`html { font-size: ${(baseFontPx * fontScale).toFixed(2)}px !important; }`);
  }
  for (const c of HIGHLIGHTS) {
    const color = root.getPropertyValue(`--hl-${c}`).trim() || 'Highlight';
    rules.push(`::highlight(lrn-${c}) { background-color: ${color}; color: inherit; }`);
  }
  return rules.join('\n');
}

/**
 * Create the lesson frame.
 * @param {{ course: object, lesson: object, lessons: object[], fontScale?: number,
 *   initialScroll?: number, onNavigate: (lesson: object, hash: string) => void,
 *   onScroll?: (y: number) => void }} opts
 * @returns {{ element: HTMLElement, frame: HTMLIFrameElement, ready: Promise<void>, destroy: () => void }}
 */
export function createLessonFrame({ course, lesson, lessons, fontScale = 1, initialScroll = 0, hash = '', onNavigate, onScroll }) {
  const src = courseFileUrl(course.id, lesson.path);
  if (hash) src.hash = hash;
  const frame = h('iframe', {
    class: 'lesson-frame',
    title: lesson.title,
    sandbox: SANDBOX,
    allow: 'clipboard-write',
    referrerpolicy: 'no-referrer',
    scrolling: 'no',
    'data-lesson-frame': lesson.id,
  });
  const status = h('p', { class: 'muted lesson-frame__status', role: 'status', text: 'Зареждам урока…' });
  const element = h('div', { class: 'lesson-frame__wrap' }, status, frame);

  const byPath = new Map(lessons.map((l) => [l.path, l]));
  const cleanups = [];
  let destroyed = false;
  let restored = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});

  const fail = (text) => {
    status.textContent = text;
    status.hidden = false;
    status.classList.add('lesson-frame__status--error');
    frame.hidden = true;
    rejectReady(new Error(text));
  };

  const frameTop = () => frame.getBoundingClientRect().top + window.scrollY;
  const barHeight = () => document.querySelector('.app-bar')?.getBoundingClientRect().height ?? 0;
  const scrollToElement = (el) => {
    window.scrollTo({ top: Math.max(0, frameTop() + el.getBoundingClientRect().top - barHeight() - 8) });
  };
  const scrollToHash = (doc, rawHash) => {
    if (!rawHash || rawHash === '#') return false;
    let id = rawHash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const el = doc.getElementById(id) || doc.getElementsByName(id)[0];
    if (!el) return false;
    scrollToElement(el);
    return true;
  };

  const openExternal = (href) => {
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  /** Decide what a link in the lesson does. */
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const a = event.target?.closest?.('a[href]');
    if (!a) return;
    const doc = frame.contentDocument;
    const href = a.href; // absolute, resolved against the lesson URL
    let url;
    try { url = new URL(href); } catch { event.preventDefault(); return; }
    event.preventDefault();
    if (url.protocol === 'javascript:') return;

    // Another file of this course?
    const target = parseCourseUrl(url.href);
    if (target) {
      if (target.courseId === course.id && target.path === lesson.path) {
        if (!scrollToHash(doc, target.hash)) window.scrollTo({ top: frameTop() - barHeight() });
        return;
      }
      const other = target.courseId === course.id ? byPath.get(target.path) : null;
      if (other) onNavigate(other, target.hash);
      else openExternal(url.href);
      return;
    }
    // The lesson's own claude.ai artifact → the local copy (INDEX.md table).
    const artifact = ARTIFACT.exec(url.href)?.[1];
    if (artifact) {
      const path = course.meta?.artifacts?.[artifact];
      const local = path && byPath.get(path);
      if (local) {
        if (local.id === lesson.id) window.scrollTo({ top: frameTop() - barHeight() });
        else onNavigate(local, '');
        return;
      }
    }
    if (url.origin === location.origin) return; // other app URLs: ignore
    openExternal(url.href);
  };

  const fit = () => {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return;
    const height = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    if (height > 0 && frame.style.height !== `${height}px`) frame.style.height = `${height}px`;
  };

  let started = false;
  const onLoad = () => {
    if (destroyed || !started) return; // the initial about:blank
    let doc;
    try {
      doc = frame.contentDocument;
      void doc?.documentElement;
    } catch {
      doc = null;
    }
    // The frame navigated away (a script set location): go back to the lesson.
    if (!doc || !parseCourseUrl(frame.contentWindow.location.href)) {
      frame.src = src.href;
      return;
    }
    const errorMeta = doc.querySelector('meta[name="easylrn-error"]');
    if (errorMeta) {
      fail(doc.body?.textContent?.trim() || 'Урокът не може да се покаже.');
      return;
    }
    const baseFontPx = parseFloat(frame.contentWindow.getComputedStyle(doc.documentElement).fontSize) || 0;
    const style = doc.createElement('style');
    style.setAttribute('data-easylrn', 'injected');
    style.textContent = injectedCss({ fontScale, baseFontPx });
    (doc.head || doc.documentElement).appendChild(style);

    status.hidden = true;
    frame.hidden = false;
    doc.addEventListener('click', onClick);
    const observer = new ResizeObserver(fit);
    observer.observe(doc.documentElement);
    if (doc.body) observer.observe(doc.body);
    cleanups.push(() => observer.disconnect());
    fit();
    const finish = () => {
      if (destroyed || restored) return;
      fit();
      restored = true;
      const fromHash = parseCourseUrl(frame.contentWindow.location.href)?.hash;
      if (!scrollToHash(doc, fromHash) && initialScroll > 0) {
        window.scrollTo({ top: frameTop() - barHeight() + initialScroll });
      }
      resolveReady();
    };
    // Restore the position once the fonts have their final metrics (or soon anyway).
    Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]).then(finish, finish);
  };
  frame.addEventListener('load', onLoad);

  // Reading position: offset of the window scroll from the top of the lesson.
  let scrollTimer = null;
  const reportScroll = () => {
    scrollTimer = null;
    if (!restored || destroyed || frame.hidden) return;
    onScroll?.(Math.max(0, Math.round(window.scrollY - (frameTop() - barHeight()))));
  };
  const onWindowScroll = () => {
    if (!scrollTimer) scrollTimer = setTimeout(reportScroll, 400);
  };
  window.addEventListener('scroll', onWindowScroll, { passive: true });

  swReady().then(() => {
    if (destroyed) return;
    started = true;
    frame.src = src.href;
  }, () => fail('Урокът не може да се покаже: офлайн режимът (Service Worker) още не е готов. Презареди приложението.'));

  return {
    element,
    frame,
    ready,
    destroy() {
      if (destroyed) return;
      if (scrollTimer) { clearTimeout(scrollTimer); reportScroll(); }
      destroyed = true;
      window.removeEventListener('scroll', onWindowScroll);
      try { frame.contentDocument?.removeEventListener('click', onClick); } catch { /* gone */ }
      cleanups.forEach((fn) => fn());
    },
  };
}
