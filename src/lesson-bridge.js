// Lesson bridge, protocol v1 (T-045, D-029, LESSON-ISOLATION §5).
//
// Runs INSIDE the lesson: the Service Worker appends src/anchor.js + this file
// as one inline <script type="module"> before </body>. The lesson document has
// an opaque origin, so this is the only way the app learns anything about it:
// height, selection, link clicks, anchors; and the only way the app changes it:
// text size, highlight colours, fonts.
//
// This is an UNTRUSTED context (the lesson's own scripts run first and may
// break or imitate the bridge). The app checks every message (§5.3); nothing
// secret is ever sent here. Rules for this file: no `import`, never a closing
// script tag in its text, all names inside the function below (anchor.js
// shares the module scope).
//
// Not here yet: anchoring and painting of annotations (T-013/T-015);
// `lrn:annotations` answers `lrn:anchored` with an empty list.
(function lrnBridge() {
  'use strict';
  // The real references, kept by src/lesson-guard.js before the lesson's scripts
  // ran (T046-D1): `parent`, `scrollY`, timers… are [Replaceable], so an ordinary
  // `var parent = …` in a lesson would replace them. Without the guard (never
  // in the app) the window's own names are used.
  const own = window.__easylrn && typeof window.__easylrn === 'object' ? window.__easylrn : {};
  const fn = (name) => (typeof own[name] === 'function' ? own[name] : window[name].bind(window));
  const parentWindow = own.parent || window.top;
  if (parentWindow === window) return; // only inside the app's lesson frame
  const setTimeout = fn('setTimeout');
  const clearTimeout = fn('clearTimeout');
  const requestAnimationFrame = fn('requestAnimationFrame');
  const getComputedStyle = fn('getComputedStyle');
  const pageY = typeof own.scrollY === 'function' ? own.scrollY : () => window.scrollY;

  const PROTOCOL = 1;
  const APP_ORIGIN = location.origin; // the URL's origin = the app (our own origin is "null")
  const COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
  const CSS_COLOR = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/;
  const FAMILY = /^[A-Za-z0-9 _-]{1,64}$/;
  const BASE_EXCLUDE = 'script, style, textarea, input, button, select, .quiz, [data-lrn-noanno]';

  const send = (type, fields = {}) => {
    try { parentWindow.postMessage({ lrn: PROTOCOL, type, ...fields }, '*'); } catch { /* the lesson broke it */ }
  };

  // --- Style: auto height, text size, highlight colours ----------------------
  const root = document.documentElement;
  const baseFontPx = parseFloat(getComputedStyle(root).fontSize) || 16;
  const style = document.createElement('style');
  style.setAttribute('data-easylrn', 'bridge');
  const state = { fontScale: 1, palette: {}, exclude: BASE_EXCLUDE, active: false, inner: false };
  const renderStyle = () => {
    // Only once the app has answered (lrn:init): the frame is then as tall as its
    // content and the app window scrolls. Before that (or if the app falls back
    // to an inner scroll) the lesson keeps its own scrolling.
    const rules = state.active && !state.inner ? [
      'html { height: auto !important; min-height: 0 !important; overflow-y: hidden !important; }',
      'body { min-height: 0 !important; }',
    ] : [];
    if (state.fontScale !== 1) rules.push(`html { font-size: ${(baseFontPx * state.fontScale).toFixed(2)}px !important; }`);
    for (const c of COLORS) {
      const color = state.palette[c] || 'Highlight';
      rules.push(`::highlight(lrn-${c}) { background-color: ${color}; color: inherit; }`);
    }
    style.textContent = rules.join('\n');
  };
  renderStyle();
  (document.head || root).appendChild(style);

  // --- Height -------------------------------------------------------------------
  let lastHeight = -1;
  let sizeQueued = false;
  const sendSize = (force) => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (!force && height === lastHeight) return;
    lastHeight = height;
    send('lrn:size', { height });
  };
  const queueSize = () => {
    if (sizeQueued) return;
    sizeQueued = true;
    requestAnimationFrame(() => { sizeQueued = false; sendSize(false); });
  };
  try {
    const observer = new ResizeObserver(queueSize);
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  } catch { /* no ResizeObserver: the app falls back to an inner scroll */ }
  window.addEventListener('load', queueSize);

  // --- Text model (offsets for selections; full anchoring in T-013) -----------
  const excluded = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    try { return !!el?.closest(state.exclude); } catch { return !!el?.closest(BASE_EXCLUDE); }
  };
  const textModel = () => {
    const map = [];
    const index = new Map();
    let text = '';
    const body = document.body;
    if (!body) return { text, map, index };
    const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode: (n) => (excluded(n) ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      map.push({ node: n, start: text.length });
      index.set(n, text.length);
      text += n.data;
    }
    return { text, map, index };
  };
  const offsetOf = (model, container, offset) => {
    if (container.nodeType === 3 && model.index.has(container)) {
      return model.index.get(container) + Math.min(offset, container.data.length);
    }
    const probe = document.createRange();
    try { probe.setStart(container, offset); } catch { return model.text.length; }
    probe.collapse(true);
    for (const entry of model.map) {
      if (probe.comparePoint(entry.node, 0) >= 0) return entry.start;
    }
    return model.text.length;
  };

  // --- Selection ------------------------------------------------------------------
  let selectionTimer = 0;
  let lastEmpty = true;
  const reportSelection = () => {
    selectionTimer = 0;
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      if (!lastEmpty) send('lrn:selection', { empty: true });
      lastEmpty = true;
      return;
    }
    const range = sel.getRangeAt(0);
    const model = textModel();
    const start = offsetOf(model, range.startContainer, range.startOffset);
    let end = offsetOf(model, range.endContainer, range.endOffset);
    if (end <= start) {
      if (!lastEmpty) send('lrn:selection', { empty: true });
      lastEmpty = true;
      return;
    }
    end = Math.min(end, start + 2000);
    const rect = range.getBoundingClientRect();
    lastEmpty = false;
    send('lrn:selection', {
      empty: false,
      quote: {
        exact: model.text.slice(start, end),
        prefix: model.text.slice(Math.max(0, start - 32), start),
        suffix: model.text.slice(end, end + 32),
      },
      position: { start, end },
      rect: { top: Math.round(rect.top + pageY()), bottom: Math.round(rect.bottom + pageY()) },
      inExcluded: excluded(range.startContainer) || excluded(range.endContainer),
    });
  };
  document.addEventListener('selectionchange', () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 150);
  });

  // --- Clicks: links, in-page anchors, taps on highlights -----------------------
  const painted = []; // { id, range } — filled by T-015
  const elementForFragment = (fragment) => {
    let id = fragment;
    try { id = decodeURIComponent(fragment); } catch { /* keep it raw */ }
    return document.getElementById(id) || document.getElementsByName(id)[0] || null;
  };
  const topOf = (el) => Math.round(el.getBoundingClientRect().top + pageY());
  const withoutHash = (href) => href.split('#')[0];

  document.addEventListener('click', (event) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const a = target?.closest('a[href], area[href]');
    if (a) {
      const raw = (a.getAttribute('href') || '').trim();
      if (raw === '' || raw === '#') return; // a script "button": the lesson handles it
      event.preventDefault(); // the lesson frame never navigates itself
      let url;
      try { url = new URL(raw, document.baseURI); } catch { return; }
      if (url.hash.length > 1 && withoutHash(url.href) === withoutHash(location.href)) {
        const el = elementForFragment(url.hash.slice(1));
        if (el && state.inner) el.scrollIntoView({ block: 'start' });
        else if (el) send('lrn:anchor', { top: topOf(el) });
        return;
      }
      send('lrn:link', { href: url.href.slice(0, 2048) });
      return;
    }
    if (!painted.length || !document.caretPositionFromPoint) return;
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
    const hit = pos && painted.find((p) => p.range.isPointInRange(pos.offsetNode, pos.offset));
    send('lrn:tap', { annotationId: hit ? hit.id : null });
  }, true);

  // --- Messages from the app ------------------------------------------------------
  const fontsLoaded = [];
  const handlers = {
    'lrn:init'(m) {
      state.active = true;
      if (m.palette && typeof m.palette === 'object') {
        const palette = {};
        for (const c of COLORS) if (typeof m.palette[c] === 'string' && CSS_COLOR.test(m.palette[c])) palette[c] = m.palette[c];
        state.palette = palette;
      }
      applyScale(m.fontScale);
      if (Array.isArray(m.exclude)) {
        const extra = m.exclude.filter((s) => typeof s === 'string' && s.length <= 200).slice(0, 20);
        const joined = [BASE_EXCLUDE, ...extra].join(', ');
        try { document.createDocumentFragment().querySelector(joined); state.exclude = joined; } catch { /* invalid: keep */ }
      }
      renderStyle();
      sendSize(true);
      sendReady();
    },
    'lrn:scroll-mode'(m) {
      // A lesson taller than the app allows for the frame (T046-D2): it scrolls inside.
      state.inner = m.inner === true;
      renderStyle();
    },
    'lrn:settings'(m) {
      applyScale(m.fontScale);
      renderStyle();
      sendSize(true);
    },
    async 'lrn:fonts'(m) {
      let loaded = 0;
      for (const face of Array.isArray(m.faces) ? m.faces.slice(0, 16) : []) {
        if (!face || !FAMILY.test(face.family || '') || !(face.buffer instanceof ArrayBuffer)) continue;
        const d = face.descriptors && typeof face.descriptors === 'object' ? face.descriptors : {};
        const descriptors = {};
        for (const k of ['style', 'weight', 'unicodeRange', 'stretch', 'display']) if (typeof d[k] === 'string') descriptors[k] = d[k];
        try {
          const ff = new FontFace(face.family, face.buffer, descriptors);
          await ff.load();
          document.fonts.add(ff);
          fontsLoaded.push(ff);
          loaded++;
        } catch { /* a broken font is skipped */ }
      }
      send('lrn:fonts-ok', { loaded });
      queueSize();
    },
    'lrn:annotations'() {
      // T-013/T-015: anchor and paint. Until then nothing is anchored.
      send('lrn:anchored', { results: [] });
    },
    'lrn:scroll-to'(m) {
      if (typeof m.fragment === 'string' && m.fragment.length <= 512) {
        const el = elementForFragment(m.fragment.replace(/^#/, ''));
        if (el && state.inner) { el.scrollIntoView({ block: 'start' }); send('lrn:position', { top: null }); return; }
        send('lrn:position', { top: el ? topOf(el) : null });
      } else {
        send('lrn:position', { top: null });
      }
    },
    'lrn:focus'() { /* T-015 */ },
    'lrn:clear-selection'() {
      document.getSelection()?.removeAllRanges();
      lastEmpty = true;
      send('lrn:selection', { empty: true });
    },
  };
  function applyScale(scale) {
    if (typeof scale === 'number' && Number.isFinite(scale) && scale >= 0.5 && scale <= 3) state.fontScale = scale;
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parentWindow || event.origin !== APP_ORIGIN) return;
    const m = event.data;
    if (!m || typeof m !== 'object' || m.lrn !== PROTOCOL || typeof m.type !== 'string') return;
    const handler = Object.prototype.hasOwnProperty.call(handlers, m.type) ? handlers[m.type] : null;
    if (handler) Promise.resolve().then(() => handler(m)).catch(() => {});
  });

  // --- Ready ------------------------------------------------------------------------
  function sendReady() {
    send('lrn:ready', { v: PROTOCOL, title: String(document.title || '').slice(0, 300), textLength: textModel().text.length });
  }
  const fontsReady = document.fonts?.ready ?? Promise.resolve();
  Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => {
    sendSize(true);
    sendReady();
  });
})();
