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
// position (`excludedOnly`).
// T-015 (D-042): the drawing tools. The gesture is in the APP (its layer over
// this frame); here only `lrn:stroke` points → caret → text (whole words), a
// live preview (lrn-pv-*), the eraser's hit-test, ONE `lrn:stroked` answer per
// stroke; `lrn:activate` presses the lesson's own control under a tap. Marks
// are painted as lrn-<colour> (marker: background) and lrn-u-<colour> (pencil:
// a line), in the palette that fits the lesson's own background.
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
  const state = {
    fontScale: 1, palette: {}, paletteDark: {}, pencil: {}, pencilDark: {}, dark: false,
    exclude: BASE_EXCLUDE, active: false, inner: false,
  };
  // Is the lesson itself dark (its computed background)? Its own CSS may follow
  // prefers-color-scheme or not; the marks must be readable on what is there.
  const parseRgb = (value) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(String(value || ''));
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return alpha < 0.5 ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const luminance = ([r, g, b]) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const darkLesson = () => {
    try {
      for (const el of [document.body, root]) {
        if (!el) continue;
        const rgb = parseRgb(getComputedStyle(el).backgroundColor);
        if (rgb) return luminance(rgb) < 0.25;
      }
      // No background of its own: the canvas (white, or dark only with color-scheme: dark).
      const scheme = getComputedStyle(root).colorScheme || '';
      return /dark/.test(scheme) && !/light/.test(scheme) ? true
        : /dark/.test(scheme) && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
    } catch { return false; }
  };
  const renderStyle = () => {
    // Only once the app has answered (lrn:init): the frame is then as tall as its
    // content and the app window scrolls. Before that (or if the app falls back
    // to an inner scroll) the lesson keeps its own scrolling.
    const rules = state.active && !state.inner ? [
      'html { height: auto !important; min-height: 0 !important; overflow-y: hidden !important; }',
      'body { min-height: 0 !important; }',
    ] : [];
    if (state.fontScale !== 1) rules.push(`html { font-size: ${(baseFontPx * state.fontScale).toFixed(2)}px !important; }`);
    // T-015: the palette follows the lesson's OWN background (a lesson without a
    // dark style stays white in a dark system theme: light marks there), see darkLesson().
    const dark = state.dark;
    const marker = dark ? state.paletteDark : state.palette;
    const pencil = dark ? state.pencilDark : state.pencil;
    for (const c of COLORS) {
      const bg = marker[c] || state.palette[c] || 'Highlight';
      const line = pencil[c] || 'currentColor';
      // Marker: the background (the text keeps its own colour).
      rules.push(`::highlight(lrn-${c}), ::highlight(lrn-pv-marker-${c}) { background-color: ${bg}; color: inherit; }`);
      // Pencil: a line under the text (no change of the text or its background).
      rules.push(`::highlight(lrn-u-${c}), ::highlight(lrn-pv-pencil-${c}) { text-decoration: underline solid 3px ${line}; text-underline-offset: 3px; text-decoration-skip-ink: none; }`);
      // A pencil mark found only approximately: dashed.
      rules.push(`::highlight(lrn-uf-${c}) { text-decoration: underline dashed 3px ${line}; text-underline-offset: 3px; text-decoration-skip-ink: none; }`);
    }
    // Found only approximately (D-012 "провери"): a dotted line under it.
    rules.push('::highlight(lrn-fuzzy) { text-decoration: underline dotted 2px; text-underline-offset: 3px; }');
    // Forced colours (high contrast): the system colours of a mark.
    rules.push(`@media (forced-colors: active) { ${COLORS.map((c) => `::highlight(lrn-${c}), ::highlight(lrn-pv-marker-${c})`).join(', ')} { background-color: Mark; color: MarkText; }`
      + ` ${COLORS.map((c) => `::highlight(lrn-u-${c}), ::highlight(lrn-uf-${c}), ::highlight(lrn-pv-pencil-${c})`).join(', ')} { text-decoration-color: CanvasText; } }`);
    // The frame around the active mark (T-015, lrn:focus).
    rules.push('[data-easylrn="focus"] { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483647; }');
    rules.push('[data-easylrn="focus"] > div { position: absolute; box-sizing: border-box; border: 2px solid #1f5fbf; border-radius: 4px; pointer-events: none; }');
    rules.push('@media (prefers-color-scheme: dark) { [data-easylrn="focus"] > div { border-color: #8ab4f8; } }');
    rules.push('@media (forced-colors: active) { [data-easylrn="focus"] > div { border-color: Highlight; } }');
    style.textContent = rules.join('\n');
  };
  state.dark = darkLesson();
  renderStyle();
  (document.head || root).appendChild(style);
  const followTheme = () => {
    const next = darkLesson();
    if (next !== state.dark) { state.dark = next; renderStyle(); }
  };
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', followTheme); } catch { /* old engine */ }
  window.addEventListener('load', followTheme);
  // T016-D3: a lesson that changes its own background later (its own theme
  // button: a class / style / data-* on <html> or <body>, a new <style>) gets
  // the palette again; once at the next frame and once after a CSS transition.
  let themeTimer = 0;
  const themeSoon = () => {
    clearTimeout(themeTimer);
    requestAnimationFrame(followTheme);
    themeTimer = setTimeout(followTheme, 450);
  };
  try {
    const watch = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'attributes' || [...r.addedNodes, ...r.removedNodes].some((n) => n !== style && /^(STYLE|LINK)$/.test(n.nodeName)))) themeSoon();
    });
    const attributes = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'data-color-scheme'] };
    watch.observe(root, attributes);
    if (document.head) watch.observe(document.head, { childList: true });
    const watchBody = () => { if (document.body) watch.observe(document.body, attributes); };
    if (document.body) watchBody(); else document.addEventListener('DOMContentLoaded', watchBody, { once: true });
  } catch { /* no MutationObserver */ }

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
  // Ctrl+Z / Cmd+Z there (T016-D6): only the command "undo" goes to the app (no
  // data); the app undoes ITS last action, the same as its own Ctrl+Z. Not in a
  // field of the lesson (its own undo of typing stays).
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') { send('lrn:escape'); return; }
    const t = event.target;
    const typing = t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      send('lrn:undo');
    }
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
        style: it.style === 'underline' ? 'underline' : 'highlight',
        selector: { quote: { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '' }, position: p && isInt(p.start) && isInt(p.end) ? { start: p.start, end: p.end } : undefined, hint },
        sameVersion: it.sameVersion === true,
      });
    }
    return out;
  }
  const paint = () => {
    painted = [];
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight !== 'function') return;
    // lrn-<colour>: marker; lrn-u-<colour>: pencil; lrn-uf-<colour>: pencil, found approximately.
    const sets = new Map();
    for (const c of COLORS) for (const k of ['', 'u-', 'uf-']) sets.set(`lrn-${k}${c}`, []);
    const fuzzy = [];
    for (const it of items) {
      const a = anchored.get(it.id);
      if (!a?.range || !it.color) continue;
      painted.push({ id: it.id, range: a.range, start: a.start, end: a.end, style: it.style, color: it.color });
      if (stroke.erased.has(it.id)) continue; // under the eraser right now (shown again if it is not deleted)
      if (it.style === 'underline') sets.get(`lrn-${a.state === 'fuzzy' ? 'uf-' : 'u-'}${it.color}`).push(a.range);
      else {
        sets.get(`lrn-${it.color}`).push(a.range);
        if (a.state === 'fuzzy') fuzzy.push(a.range);
      }
    }
    try {
      for (const [name, ranges] of sets) {
        if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
        else CSS.highlights.delete(name);
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

  // --- Drawing tools (T-015, D-042) ---------------------------------------------------
  // The gesture itself is in the APP (a layer over this frame, trusted pointer
  // events there): it sends the points of one stroke, in the coordinates of
  // this frame, as `lrn:stroke` (start / move / end / cancel). Here they become
  // text: the caret at each point (caretPositionFromPoint), the model offsets,
  // a live preview (a highlight of its own, no DOM change), and at the end ONE
  // answer `lrn:stroked` with the selectors (marker, pencil) or the ids under
  // the path (eraser). The app saves only an answer to its own stroke.
  const WORD = /[\p{L}\p{N}\p{M}­]/u;
  // Inner punctuation that keeps a word whole when it stands BETWEEN two word
  // characters (T016-D1): "don't", "1,25", "3.5", "по-рано", "2024/2847".
  const JOIN = /['’ʼ.,\-‐‑/]/u;
  const TOOLS = ['marker', 'pencil', 'eraser'];
  const MAX_POINT = 1e6;
  const stroke = {
    seq: null, tool: null, color: null, from: null, to: null, x0: 0, y0: 0, moved: 0, last: null,
    erased: new Set(), keep: 0, // `erased`: ids hidden under the eraser until the app's next list
  };
  const isPoint = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -MAX_POINT && v <= MAX_POINT;
  /** The model offset of the caret at a point of this frame, or null (outside the text, in an excluded part). */
  function caretOffset(x, y) {
    let node = null;
    let offset = 0;
    try {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
      }
    } catch { node = null; }
    if (!node) return null;
    const under = document.elementFromPoint(x, y);
    if (excluded(node) || (under && excluded(under))) return null;
    const model = textModel();
    if (!model.text.length) return null;
    return anchorOffset(model, node, offset);
  }
  /** The character under a point (its box, a little larger for a finger), or null. */
  function charAt(x, y) {
    const at = caretOffset(x, y);
    if (at === null) return null;
    const model = textModel();
    for (const c of [at, at - 1]) {
      if (c < 0 || c >= model.text.length || model.text[c] === ' ') continue;
      const r = anchorRange(model, c, c + 1);
      let rects = [];
      try { rects = r ? [...r.getClientRects()] : []; } catch { rects = []; }
      for (const b of rects) {
        if (x >= b.left - 6 && x <= b.right + 6 && y >= b.top - 6 && y <= b.bottom + 10) return c;
      }
    }
    return null;
  }
  /** [start, end) from the two caret offsets, widened to whole words (no word is cut). */
  function wordSpan(a, b) {
    const T = textModel().text;
    const isWord = (i) => i >= 0 && i < T.length && (WORD.test(T[i])
      || (JOIN.test(T[i]) && i > 0 && i + 1 < T.length && WORD.test(T[i - 1]) && WORD.test(T[i + 1])));
    let s = Math.min(a, b);
    let e = Math.max(a, b);
    while (s > 0 && isWord(s - 1) && isWord(s)) s--;
    while (e > 0 && isWord(e) && isWord(e - 1)) e++;
    // A stroke on one word only (both carets inside it): that word.
    if (s === e) {
      while (isWord(s - 1)) s--;
      while (isWord(e)) e++;
    }
    while (s < e && T[s] === ' ') s++;
    while (e > s && T[e - 1] === ' ') e--;
    return e > s ? [s, e] : null;
  }
  const PREVIEW = [];
  for (const t of ['marker', 'pencil']) for (const c of COLORS) PREVIEW.push(`lrn-pv-${t}-${c}`);
  function clearPreview() {
    try { for (const name of PREVIEW) CSS.highlights.delete(name); } catch { /* no Highlight API */ }
  }
  function showPreview() {
    if (stroke.from === null || stroke.to === null || stroke.tool === 'eraser') return;
    const span = stroke.moved >= 6 ? wordSpan(stroke.from, stroke.to) : null;
    const range = span ? anchorRange(textModel(), span[0], span[1]) : null;
    try {
      clearPreview();
      if (range) CSS.highlights.set(`lrn-pv-${stroke.tool}-${stroke.color}`, new Highlight(range));
    } catch { /* no Highlight API: no preview, the mark is still made */ }
  }
  /** The eraser at one point: the marks with the character under it (both kinds). */
  function eraseAt(x, y) {
    const c = charAt(x, y);
    if (c === null) return false;
    let changed = false;
    for (const p of painted) {
      if (p.start <= c && c < p.end && !stroke.erased.has(p.id)) { stroke.erased.add(p.id); changed = true; }
    }
    return changed;
  }
  /** Points between the last one and (x, y), every 6 px (a fast finger skips characters). */
  function* along(x, y) {
    const [lx, ly] = stroke.last || [x, y];
    const n = Math.min(200, Math.ceil(Math.hypot(x - lx, y - ly) / 6));
    for (let i = 1; i <= n; i++) yield [lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n];
    if (!n) yield [x, y];
  }
  function strokePoint(x, y) {
    stroke.moved = Math.max(stroke.moved, Math.hypot(x - stroke.x0, y - stroke.y0));
    if (stroke.tool === 'eraser') {
      let changed = false;
      for (const [px, py] of along(x, y)) changed = eraseAt(px, py) || changed;
      stroke.last = [x, y];
      if (changed) paint();
      return;
    }
    stroke.last = [x, y];
    const at = caretOffset(x, y);
    if (at === null) return; // over an excluded part or outside the text: the last good point stays
    if (stroke.from === null) stroke.from = at;
    stroke.to = at;
    showPreview();
  }
  function strokeAnswer() {
    const base = { seq: stroke.seq, tool: stroke.tool };
    if (stroke.tool === 'eraser') return { ...base, ids: [...stroke.erased].slice(0, MAX_ITEMS) };
    const span = stroke.from !== null && stroke.to !== null && stroke.moved >= 6 ? wordSpan(stroke.from, stroke.to) : null;
    const selector = span ? anchorDescribe(textModel(), span[0], span[1]) : null;
    if (!selector) return { ...base, quote: null };
    const style = stroke.tool === 'pencil' ? 'underline' : 'highlight';
    const { start, end } = selector.position;
    // Already all under a mark of the same kind and colour: nothing new (the app makes no copy).
    const covered = painted.some((p) => p.style === style && p.color === stroke.color && p.start <= start && end <= p.end);
    return { ...base, quote: selector.quote, position: selector.position, ...(selector.hint ? { hint: selector.hint.blockPath } : {}), covered };
  }
  /** Interactive element of the lesson at a point (a tap with a tool on: a quiz button, a link…). */
  const INTERACTIVE = 'a[href], area[href], button, input, select, textarea, label, summary, [role="button"], [role="radio"], [role="checkbox"], [role="tab"], [role="link"], [onclick], [tabindex]';
  function activateAt(x, y) {
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch { el = null; }
    const target = el?.closest?.(INTERACTIVE);
    if (!target || target === document.body || target === root) return;
    try { target.focus?.({ preventScroll: true }); } catch { /* not focusable */ }
    try { target.click(); } catch { /* the lesson broke it */ }
  }

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
      if (m.pencil && typeof m.pencil === 'object') state.pencil = colours(m.pencil);
      if (m.pencilDark && typeof m.pencilDark === 'object') state.pencilDark = colours(m.pencilDark);
      state.dark = darkLesson();
      applyScale(m.fontScale);
      if (Array.isArray(m.exclude)) {
        const extra = m.exclude.filter((s) => typeof s === 'string' && s.length <= 200).slice(0, 20);
        const joined = [BASE_EXCLUDE, ...extra].join(', ');
        // The same exclusions as now (the usual case): keep the model built for lrn:ready.
        if (joined !== state.exclude) {
          try { document.createDocumentFragment().querySelector(joined); state.exclude = joined; cachedModel = null; lastText = null; } catch { /* invalid: keep */ }
        }
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
    'lrn:stroke'(m) {
      const phase = m.phase;
      if (phase === 'cancel') {
        if (m.seq !== stroke.seq) return;
        stroke.seq = null;
        clearPreview();
        if (stroke.erased.size) { stroke.erased.clear(); paint(); }
        return;
      }
      if (!isPoint(m.x) || !isPoint(m.y)) return;
      if (phase === 'start') {
        if (!Number.isInteger(m.seq) || m.seq < 0 || !TOOLS.includes(m.tool)) return;
        if (m.tool !== 'eraser' && !COLORS.includes(m.color)) return;
        clearPreview();
        if (stroke.erased.size) { stroke.erased.clear(); paint(); }
        Object.assign(stroke, { seq: m.seq, tool: m.tool, color: m.color ?? null, from: null, to: null, x0: m.x, y0: m.y, moved: 0, last: null });
        strokePoint(m.x, m.y);
        return;
      }
      if (m.seq !== stroke.seq || stroke.seq === null) return;
      if (phase === 'move') { strokePoint(m.x, m.y); return; }
      if (phase === 'end') {
        strokePoint(m.x, m.y);
        const answer = strokeAnswer();
        stroke.seq = null;
        // The preview (or the erased marks) stays until the app's next list, at most 3 s.
        clearTimeout(stroke.keep);
        stroke.keep = setTimeout(() => { clearPreview(); if (stroke.erased.size) { stroke.erased.clear(); paint(); } }, 3000);
        send('lrn:stroked', answer);
      }
    },
    'lrn:activate'(m) {
      if (isPoint(m.x) && isPoint(m.y)) activateAt(m.x, m.y);
    },
    'lrn:scroll-by'(m) {
      // Two fingers with a tool on, in a lesson that scrolls inside its frame (T046-D2).
      if (state.inner && isPoint(m.dx) && isPoint(m.dy)) window.scrollBy(m.dx, m.dy);
    },
    'lrn:annotations'(m) {
      clearTimeout(stroke.keep);
      if (stroke.seq === null) { clearPreview(); stroke.erased.clear(); }
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
