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
// T-013: the text model, the selectors of a selection and the re-anchoring
// of the annotations of THIS lesson are done here with src/anchor.js (same
// module scope: anchorTextModel, anchorDescribeRange, anchorFind,
// anchorRange). The annotations the app sends are painted with the CSS
// Custom Highlight API, without any change to the lesson's DOM (D-012), and
// anchored again when the lesson's own scripts change its text. Not here yet
// (T-015): the focus frame (`lrn:focus`), the bottom bar and the cards are in
// the app.
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
  const BASE_EXCLUDE = ANCHOR_BASE_EXCLUDE;
  const MAX_ITEMS = 5000;
  const ID = /^[A-Za-z0-9_:.-]{1,64}$/;

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
    // Found only approximately (D-012 "провери"): a dotted line under it.
    rules.push('::highlight(lrn-fuzzy) { text-decoration: underline dotted 2px; text-underline-offset: 3px; }');
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

  // --- Text model (src/anchor.js) ---------------------------------------------------
  const excluded = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    try { return !!el?.closest(state.exclude); } catch { return !!el?.closest(BASE_EXCLUDE); }
  };
  let cachedModel = null; // dropped at every change of the lesson's DOM (observer below)
  const textModel = () => {
    if (!cachedModel) {
      cachedModel = document.body ? anchorTextModel(document.body, { exclude: state.exclude }) : { text: '', segs: [], index: new Map(), root: document };
    }
    return cachedModel;
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
    const selector = anchorDescribeRange(model, range);
    if (!selector) {
      if (!lastEmpty) send('lrn:selection', { empty: true });
      lastEmpty = true;
      return;
    }
    const rect = range.getBoundingClientRect();
    lastEmpty = false;
    send('lrn:selection', {
      empty: false,
      quote: selector.quote,
      position: selector.position,
      ...(selector.hint ? { hint: selector.hint.blockPath } : {}),
      rect: { top: Math.round(rect.top + pageY()), bottom: Math.round(rect.bottom + pageY()) },
      inExcluded: excluded(range.startContainer) || excluded(range.endContainer),
    });
  };
  document.addEventListener('selectionchange', () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 150);
  });

  // --- Clicks: links, in-page anchors, taps on highlights -----------------------
  let painted = []; // { id, range } of the annotations with a colour (hit-test)
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

  // --- Annotations: anchor (D-012) and paint (CSS Custom Highlight API) ----------
  // `items` are the app's list for this lesson (checked here too: the app is
  // trusted, but a lesson script may post to its own window). `anchored`:
  // id → { state, start, end, range } of the last anchoring.
  let items = [];
  const anchored = new Map();
  const isInt = (v) => Number.isInteger(v) && v >= 0 && v <= 1e7;
  const isText = (v, max) => typeof v === 'string' && v.length <= max;
  function cleanItems(list) {
    const out = [];
    const seen = new Set();
    for (const it of Array.isArray(list) ? list.slice(0, MAX_ITEMS) : []) {
      if (!it || typeof it !== 'object' || !isText(it.id, 64) || !ID.test(it.id) || seen.has(it.id)) continue;
      const q = it.selector?.quote;
      const p = it.selector?.position;
      if (!q || !isText(q.exact, 2000) || !q.exact || !isText(q.prefix ?? '', 64) || !isText(q.suffix ?? '', 64)) continue;
      const color = COLORS.includes(it.color) ? it.color : null;
      const hint = isText(it.selector.hint?.blockPath, 200) ? { blockPath: it.selector.hint.blockPath } : undefined;
      seen.add(it.id);
      out.push({
        id: it.id,
        color,
        selector: { quote: { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '' }, position: p && isInt(p.start) && isInt(p.end) ? { start: p.start, end: p.end } : undefined, hint },
        sameVersion: it.sameVersion === true,
      });
    }
    return out;
  }
  const paint = () => {
    painted = [];
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight !== 'function') return;
    const byColor = new Map(COLORS.map((c) => [c, []]));
    const fuzzy = [];
    for (const it of items) {
      const a = anchored.get(it.id);
      if (!a?.range || !it.color) continue;
      byColor.get(it.color).push(a.range);
      if (a.state === 'fuzzy') fuzzy.push(a.range);
      painted.push({ id: it.id, range: a.range });
    }
    for (const [c, ranges] of byColor) {
      if (ranges.length) CSS.highlights.set(`lrn-${c}`, new Highlight(...ranges));
      else CSS.highlights.delete(`lrn-${c}`);
    }
    if (fuzzy.length) CSS.highlights.set('lrn-fuzzy', new Highlight(...fuzzy));
    else CSS.highlights.delete('lrn-fuzzy');
  };
  /** Anchor every item; `again` = after a change of the lesson's own DOM (positions of the last anchoring). */
  function anchorAll(again) {
    const model = textModel();
    const results = [];
    const previous = new Map(anchored);
    anchored.clear();
    for (const it of items) {
      const last = again ? previous.get(it.id) : null;
      let found;
      if (last && last.state !== 'orphan') {
        // The same text, maybe new nodes: the place of the last anchoring if it still holds.
        const exact = model.text.slice(last.start, last.end);
        found = exact && exact === last.exact ? { state: last.state, start: last.start, end: last.end }
          : anchorFind(model, { ...it.selector, quote: { ...it.selector.quote, exact: last.exact }, position: { start: last.start, end: last.end } }, { sameVersion: true });
        if (found.state === 'ok' && last.state === 'fuzzy') found = { ...found, state: 'fuzzy' };
      } else {
        found = anchorFind(model, it.selector, { sameVersion: it.sameVersion });
      }
      const range = found.state !== 'orphan' ? anchorRange(model, found.start, found.end) : null;
      if (found.state !== 'orphan' && !range) found = { state: 'orphan' };
      const entry = { state: found.state, start: found.start, end: found.end, exact: range ? model.text.slice(found.start, found.end) : '', range };
      anchored.set(it.id, entry);
      const r = { id: it.id, state: found.state };
      if (range) {
        const box = range.getBoundingClientRect();
        r.position = { start: found.start, end: found.end };
        r.top = Math.max(0, Math.round(box.top + pageY()));
        r.bottom = Math.max(r.top, Math.round(box.bottom + pageY()));
      }
      results.push(r);
    }
    paint();
    send('lrn:anchored', { results, textLength: model.text.length });
  }
  // The lesson's own scripts (quiz.js, reflect.js, anything) may change its
  // DOM at any time: the model is dropped and, if the text outside the
  // excluded parts changed, the annotations are anchored again (debounced).
  let reanchorTimer = 0;
  let lastText = null;
  const reanchor = () => {
    reanchorTimer = 0;
    const before = lastText;
    cachedModel = null;
    const model = textModel();
    lastText = model.text;
    if (!items.length) return;
    if (before === model.text) {
      // Same text: the ranges may point into replaced nodes; rebuild them in place.
      let lost = false;
      for (const [id, a] of anchored) {
        if (a.state === 'orphan') continue;
        a.range = anchorRange(model, a.start, a.end);
        if (!a.range) { lost = true; anchored.set(id, { ...a, state: 'orphan' }); }
      }
      paint();
      if (!lost) return;
    }
    anchorAll(true);
  };
  try {
    const watch = new MutationObserver((records) => {
      if (records.every((r) => excluded(r.target))) return; // e.g. quiz.js inside .quiz
      cachedModel = null;
      if (reanchorTimer) clearTimeout(reanchorTimer);
      reanchorTimer = setTimeout(reanchor, 200);
    });
    if (document.body) watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch { /* no observer: anchored once */ }

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
        try { document.createDocumentFragment().querySelector(joined); state.exclude = joined; cachedModel = null; lastText = null; } catch { /* invalid: keep */ }
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
    'lrn:annotations'(m) {
      items = cleanItems(m.items);
      anchorAll(false);
    },
    'lrn:scroll-to'(m) {
      if (typeof m.annotationId === 'string' && m.annotationId.length <= 64) {
        const found = anchored.get(m.annotationId);
        const top = found?.range ? Math.round(found.range.getBoundingClientRect().top + pageY()) : null;
        send('lrn:position', { top: top !== null && top >= 0 ? top : null });
        return;
      }
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
    const model = textModel();
    if (lastText === null) lastText = model.text;
    send('lrn:ready', { v: PROTOCOL, title: String(document.title || '').slice(0, 300), textLength: model.text.length });
  }
  const fontsReady = document.fonts?.ready ?? Promise.resolve();
  Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => {
    sendSize(true);
    sendReady();
  });
})();
