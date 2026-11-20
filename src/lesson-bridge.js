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
// anchored again when the lesson's own scripts change its text.
// T-013-fix: the anchoring runs in slices of ~10 ms (the lesson and the app
// share one process: it never freezes the app); after a change of the text
// only what the change can touch is searched again (an orphan only around the
// changed part), and a lesson that changes all the time is re-anchored at most
// every few seconds (T014-D3/D4).
// T-015: the frame around the active mark (`lrn:focus`, an overlay outside
// <body>, never in the text model), `lrn:layout` (the places of the marks for
// the margin of the app), `lrn:describe` (the selector of a mark at its new
// place, when the user confirms a "провери"), and a selection that is only in
// an excluded part (`.quiz`, data-lrn-noanno) is reported as a quote without a
// position (`excludedOnly`). The bottom bar and the card are in the app.
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
  const now = (() => { try { const p = performance; const f = p.now.bind(p); f(); return f; } catch { return () => Date.now(); } })();

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
  const state = { fontScale: 1, palette: {}, paletteDark: {}, exclude: BASE_EXCLUDE, active: false, inner: false };
  const renderStyle = () => {
    // Only once the app has answered (lrn:init): the frame is then as tall as its
    // content and the app window scrolls. Before that (or if the app falls back
    // to an inner scroll) the lesson keeps its own scrolling.
    const rules = state.active && !state.inner ? [
      'html { height: auto !important; min-height: 0 !important; overflow-y: hidden !important; }',
      'body { min-height: 0 !important; }',
    ] : [];
    if (state.fontScale !== 1) rules.push(`html { font-size: ${(baseFontPx * state.fontScale).toFixed(2)}px !important; }`);
    const dark = [];
    for (const c of COLORS) {
      const color = state.palette[c] || 'Highlight';
      rules.push(`::highlight(lrn-${c}) { background-color: ${color}; color: inherit; }`);
      if (state.paletteDark[c]) dark.push(`::highlight(lrn-${c}) { background-color: ${state.paletteDark[c]}; }`);
    }
    // The lesson follows the system theme (T-019): the dark colours of the app with it.
    if (dark.length) rules.push(`@media (prefers-color-scheme: dark) { ${dark.join(' ')} }`);
    // Found only approximately (D-012 "провери"): a dotted line under it.
    rules.push('::highlight(lrn-fuzzy) { text-decoration: underline dotted 2px; text-underline-offset: 3px; }');
    // Forced colours (high contrast): the system colours of a mark.
    rules.push(`@media (forced-colors: active) { ${COLORS.map((c) => `::highlight(lrn-${c})`).join(', ')} { background-color: Mark; color: MarkText; } }`);
    // The frame around the active mark (T-015, lrn:focus).
    rules.push('[data-easylrn="focus"] { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483647; }');
    rules.push('[data-easylrn="focus"] > div { position: absolute; box-sizing: border-box; border: 2px solid #1f5fbf; border-radius: 4px; pointer-events: none; }');
    rules.push('@media (prefers-color-scheme: dark) { [data-easylrn="focus"] > div { border-color: #8ab4f8; } }');
    rules.push('@media (forced-colors: active) { [data-easylrn="focus"] > div { border-color: Highlight; } }');
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
    requestAnimationFrame(() => { sizeQueued = false; sendSize(false); queueLayout(); });
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
      // Only inside an excluded part (a quiz, data-lrn-noanno): no mark there,
      // but the app shows the quote (a question about it comes with T-023/T-025).
      const quote = excluded(range.startContainer) && excluded(range.endContainer)
        ? String(range.toString()).replace(/\s+/g, ' ').trim().slice(0, 2000) : '';
      if (quote) {
        const box = range.getBoundingClientRect();
        lastEmpty = false;
        send('lrn:selection', {
          empty: false, excludedOnly: true, quote: { exact: quote, prefix: '', suffix: '' },
          rect: { top: Math.round(box.top + pageY()), bottom: Math.round(box.bottom + pageY()) }, inExcluded: true,
        });
        return;
      }
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

  // Escape inside the lesson (a keyboard selection): the app closes its bar (T-015).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) send('lrn:escape');
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
    let hit = null;
    if (pos) {
      for (const p of painted) {
        let inside = false;
        try { inside = p.range.isPointInRange(pos.offsetNode, pos.offset); } catch { inside = false; }
        // Overlapping marks: the shortest one (the innermost) wins.
        if (inside && (!hit || p.end - p.start < hit.end - hit.start)) hit = p;
      }
    }
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
      painted.push({ id: it.id, range: a.range, start: a.start, end: a.end });
    }
    try {
      for (const [c, ranges] of byColor) {
        if (ranges.length) CSS.highlights.set(`lrn-${c}`, new Highlight(...ranges));
        else CSS.highlights.delete(`lrn-${c}`);
      }
      if (fuzzy.length) CSS.highlights.set('lrn-fuzzy', new Highlight(...fuzzy));
      else CSS.highlights.delete('lrn-fuzzy');
    } catch { /* the lesson broke the Highlight API: no colours, the rest works */ }
    drawFocus();
  };

  // --- The frame around the active mark (lrn:focus) ---------------------------------
  // An overlay after <body> (outside the text model and the observer), with
  // pointer-events: none, so taps and selections go through it.
  let focusId = null;
  let focusBox = null;
  function drawFocus() {
    const a = focusId ? anchored.get(focusId) : null;
    if (!a?.range) { focusBox?.remove(); focusBox = null; return; }
    if (!focusBox) {
      focusBox = document.createElement('div');
      focusBox.setAttribute('data-easylrn', 'focus');
      focusBox.setAttribute('aria-hidden', 'true');
    }
    if (focusBox.parentNode !== root) root.appendChild(focusBox);
    const y = pageY();
    const x = window.scrollX || 0;
    const boxes = [];
    let rects = [];
    try { rects = [...a.range.getClientRects()].slice(0, 400); } catch { rects = []; }
    // One box per line: the rectangles of one line merged.
    for (const r of rects) {
      if (!(r.width > 0 && r.height > 0)) continue;
      const line = boxes.find((b) => Math.abs(b.top - r.top) < r.height / 2);
      if (line) {
        line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
        line.bottom = Math.max(line.bottom, r.bottom); line.top = Math.min(line.top, r.top);
      } else boxes.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    focusBox.replaceChildren(...boxes.slice(0, 200).map((b) => {
      const d = document.createElement('div');
      d.style.left = `${Math.round(b.left + x - 3)}px`;
      d.style.top = `${Math.round(b.top + y - 2)}px`;
      d.style.width = `${Math.round(b.right - b.left + 6)}px`;
      d.style.height = `${Math.round(b.bottom - b.top + 4)}px`;
      return d;
    }));
  }

  // --- Places of the marks for the margin of the app (lrn:layout) -------------------
  let layoutTimer = 0;
  function sendLayout() {
    layoutTimer = 0;
    const y = pageY();
    const list = [];
    for (const it of items) {
      const a = anchored.get(it.id);
      if (!a?.range) continue;
      let box;
      try { box = a.range.getBoundingClientRect(); } catch { continue; }
      const top = Math.max(0, Math.round(box.top + y));
      list.push({ id: it.id, top, bottom: Math.max(top, Math.round(box.bottom + y)) });
    }
    send('lrn:layout', { items: list, height: Math.ceil(root.getBoundingClientRect().height) });
    drawFocus();
  }
  function queueLayout() {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(sendLayout, 150);
  }

  // --- Anchoring (T-013, T-013-fix) --------------------------------------------------
  // `anchored`: id → { state, start, end, exact, range, base, key } of the last
  // anchoring; `base` is the text of the model it was found in, `key` the
  // selector it was found for (a cache: the same selector in the same text is
  // not searched again).
  const keyOf = (it) => `${it.sameVersion ? 1 : 0}|${it.selector.position ? `${it.selector.position.start}:${it.selector.position.end}` : ''}|${it.selector.hint?.blockPath ?? ''}|${it.selector.quote.prefix}\u0000${it.selector.quote.exact}\u0000${it.selector.quote.suffix}`;
  /** The common start and end of two texts: [p, s] (p + s ≤ the shorter length). */
  const diffCache = new Map();
  function textDiff(a, b) {
    if (a === b) return [a.length, 0];
    const cached = diffCache.get(a);
    if (cached && cached.b === b) return cached.d;
    const n = Math.min(a.length, b.length);
    let p = 0;
    while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    const d = [p, s];
    if (diffCache.size > 8) diffCache.clear();
    diffCache.set(a, { b, d });
    return d;
  }
  /** One item (the cache, then what a change of the text can have touched, then a full search). */
  function anchorOne(it, model) {
    const T = model.text;
    const last = anchored.get(it.id);
    const key = keyOf(it);
    if (last && last.key === key && last.base === T) {
      // The same selector in the same text: the same place.
      return last.state === 'orphan' ? { state: 'orphan' } : { state: last.state, start: last.start, end: last.end };
    }
    if (last && last.key === key && typeof last.base === 'string') {
      const [p, s] = textDiff(last.base, T);
      const delta = T.length - last.base.length;
      if (last.state !== 'orphan') {
        // The same text at the place (moved by the change before it, if any).
        const shift = last.end <= p ? 0 : last.start >= last.base.length - s ? delta : null;
        if (shift !== null && T.slice(last.start + shift, last.end + shift) === last.exact) {
          return { state: last.state, start: last.start + shift, end: last.end + shift };
        }
        const found = anchorFind(model, { ...it.selector, quote: { ...it.selector.quote, exact: last.exact }, position: { start: last.start, end: last.end } }, { sameVersion: true });
        return found.state === 'ok' && last.state === 'fuzzy' ? { ...found, state: 'fuzzy' } : found;
      }
      // An orphan: the text outside the change was searched already; only around it now.
      const from = p;
      const to = T.length - s;
      if (to <= from && delta <= 0) return { state: 'orphan' };
      const reach = it.selector.quote.exact.length * 2 + 64;
      return anchorFind(model, it.selector, { within: [from - reach, to + reach] });
    }
    return anchorFind(model, it.selector, { sameVersion: it.sameVersion });
  }
  let run = 0;
  let runningSince = 0;
  let lastCost = 0; // ms of work of the last anchoring (the model and every slice)
  let lastRunEnd = 0;
  const SLICE_MS = 12;
  const PAINT_EVERY_MS = 300;
  // The next slice as soon as other tasks (input, the app) had their turn; a
  // message channel is not clamped to 4 ms like a nested setTimeout.
  const later = (() => {
    try {
      const channel = new MessageChannel();
      const queue = [];
      channel.port1.onmessage = () => { const f = queue.shift(); if (f) f(); };
      return (f) => { queue.push(f); channel.port2.postMessage(0); };
    } catch {
      return (f) => setTimeout(f, 0);
    }
  })();
  /** Anchor every item, in slices; one `lrn:anchored` with all the results at the end. */
  function anchorAll(modelCost = 0) {
    const id = ++run;
    const t0 = now();
    const model = textModel();
    let cost = modelCost + (now() - t0);
    const list = items;
    const results = new Array(list.length);
    let i = 0;
    let paintedAt = t0;
    runningSince = t0;
    const step = () => {
      if (id !== run) return; // a newer anchoring took over
      const start = now();
      do {
        const it = list[i];
        let found;
        try { found = anchorOne(it, model); } catch { found = { state: 'orphan' }; }
        const range = found.state !== 'orphan' ? anchorRange(model, found.start, found.end) : null;
        if (found.state !== 'orphan' && !range) found = { state: 'orphan' };
        const previous = anchored.get(it.id);
        anchored.set(it.id, {
          state: found.state, start: found.start, end: found.end, range, base: model.text, key: keyOf(it),
          // An orphan keeps the text it was last found with (for the next change).
          exact: range ? model.text.slice(found.start, found.end) : previous?.exact ?? '',
        });
        const r = { id: it.id, state: found.state };
        if (range) {
          let box = null;
          try { box = range.getBoundingClientRect(); } catch { box = null; }
          r.position = { start: found.start, end: found.end };
          if (box) {
            r.top = Math.max(0, Math.round(box.top + pageY()));
            r.bottom = Math.max(r.top, Math.round(box.bottom + pageY()));
          }
        }
        results[i] = r;
        i++;
      } while (i < list.length && now() - start < SLICE_MS);
      cost += now() - start;
      if (i < list.length) {
        // What is anchored so far is painted now and then (not after every
        // slice: a repaint of a long lesson costs more than the slice).
        if (now() - paintedAt > PAINT_EVERY_MS) { paint(); paintedAt = now(); }
        later(step);
        return;
      }
      const live = new Set(list.map((it) => it.id));
      for (const key of [...anchored.keys()]) if (!live.has(key)) anchored.delete(key);
      paint();
      lastCost = cost;
      lastRunEnd = now();
      runningSince = 0;
      send('lrn:anchored', { results, textLength: model.text.length });
      queueLayout();
    };
    if (!list.length) {
      anchored.clear();
      paint();
      send('lrn:anchored', { results: [], textLength: model.text.length });
      return;
    }
    step();
  }
  // The lesson's own scripts (quiz.js, reflect.js, anything) may change its
  // DOM at any time: the model is dropped and, if the text outside the
  // excluded parts changed, the annotations are anchored again: 200 ms after
  // the changes stop, but at least every MAX_WAIT (a clock never stops), and
  // never sooner than 20 × the cost of the last anchoring after it (a lesson
  // that changes all the time costs at most ~5 % of the processor).
  let reanchorTimer = 0;
  let lastText = null;
  let dirtySince = 0;
  const QUIET_MS = 200;
  const reanchor = () => {
    reanchorTimer = 0;
    dirtySince = 0;
    const t0 = now();
    const before = lastText;
    cachedModel = null;
    const model = textModel();
    lastText = model.text;
    const modelCost = now() - t0;
    if (!items.length) return;
    if (before === model.text) {
      // Same text: the ranges may point into replaced nodes; rebuild them in place.
      let lost = false;
      for (const [id, a] of anchored) {
        if (a.state === 'orphan') continue;
        a.range = anchorRange(model, a.start, a.end);
        a.base = model.text;
        if (!a.range) { lost = true; anchored.set(id, { ...a, state: 'orphan' }); }
      }
      paint();
      queueLayout();
      lastCost = modelCost;
      lastRunEnd = now();
      if (!lost) return;
    }
    anchorAll(modelCost);
  };
  const scheduleReanchor = () => {
    const t = now();
    if (!dirtySince) dirtySince = t;
    if (reanchorTimer) clearTimeout(reanchorTimer);
    const maxWait = Math.max(2000, 20 * lastCost);
    let delay = Math.min(QUIET_MS, Math.max(0, dirtySince + maxWait - t));
    delay = Math.max(delay, lastRunEnd + 20 * lastCost - t, runningSince ? QUIET_MS : 0);
    reanchorTimer = setTimeout(reanchor, Math.max(0, delay));
  };
  try {
    const watch = new MutationObserver((records) => {
      if (records.every((r) => excluded(r.target))) return; // e.g. quiz.js inside .quiz
      cachedModel = null;
      scheduleReanchor();
    });
    if (document.body) watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch { /* no observer: anchored once */ }

  // --- Messages from the app ------------------------------------------------------
  const fontsLoaded = [];
  const handlers = {
    'lrn:init'(m) {
      state.active = true;
      const colours = (given) => {
        const out = {};
        for (const c of COLORS) if (typeof given[c] === 'string' && CSS_COLOR.test(given[c])) out[c] = given[c];
        return out;
      };
      if (m.palette && typeof m.palette === 'object') state.palette = colours(m.palette);
      if (m.paletteDark && typeof m.paletteDark === 'object') state.paletteDark = colours(m.paletteDark);
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
      queueLayout();
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
      queueLayout();
    },
    'lrn:annotations'(m) {
      items = cleanItems(m.items);
      anchorAll();
    },
    'lrn:describe'(m) {
      // The selector of a mark at the place it was found now ("провери" → "Да, тук е").
      if (typeof m.annotationId !== 'string' || m.annotationId.length > 64) return;
      const a = anchored.get(m.annotationId);
      const model = textModel();
      const selector = a && a.state !== 'orphan' && a.base === model.text ? anchorDescribe(model, a.start, a.end) : null;
      send('lrn:described', selector
        ? { annotationId: m.annotationId, quote: selector.quote, position: selector.position, ...(selector.hint ? { hint: selector.hint.blockPath } : {}) }
        : { annotationId: m.annotationId, quote: null });
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
    'lrn:focus'(m) {
      focusId = typeof m.annotationId === 'string' && m.annotationId.length <= 64 ? m.annotationId : null;
      drawFocus();
    },
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
