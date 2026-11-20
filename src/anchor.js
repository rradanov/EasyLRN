// Text anchors: text model, selectors and re-anchoring (D-012, ARCHITECTURE §4.1–4.3,
// LESSON-ISOLATION §4.1, T-013).
//
// - Text model: the text nodes under a root in document order, without the
//   excluded parts (script, style, form fields, buttons, `.quiz`,
//   `[data-lrn-noanno]` and the extra selectors given). Runs of white space
//   become one space, and a space separates two blocks (p, li, td, h2…), so
//   "end.</p><p>Next" is "end. Next". Offsets in this model are the
//   TextPositionSelector; `exact`/`prefix`/`suffix` (32 characters around)
//   are the TextQuoteSelector; `hint.blockPath` is a CSS path to the nearest
//   block (it only narrows the search, it is never trusted).
// - Re-anchoring: the same version and the same text at the position → ok;
//   else the exact quote, the best by context and nearness → ok (a short quote
//   found in several places with none of its context → fuzzy); else an
//   approximate search (edit distance, similarity ≥ 0.8, a short quote needs
//   its context too) → fuzzy; else orphan. Nothing is ever dropped: an
//   orphan keeps its selector and is listed apart (T-015/T-029).
//
// Rules for this file (T-045, LESSON-ISOLATION §3.2 and §6):
// - a pure module: no `import`, only standard DOM APIs on a given root;
// - it never contains a closing script tag in its text;
// - the Service Worker inlines it, followed by src/lesson-bridge.js, as ONE
//   inline <script type="module"> at the end of every lesson (the bridge calls
//   the functions below by name), and the app may import it directly as well
//   (for its own documents: notes, answers, topics). Every top-level name
//   starts with `anchor`/`ANCHOR` so it cannot clash with the bridge.
// - Inside a lesson it runs in an untrusted document: the lesson may have
//   changed DOM prototypes. The app never trusts what comes back (§5.3).

export const ANCHOR_VERSION = 1;
export const ANCHOR_CONTEXT = 32;
export const ANCHOR_MAX_EXACT = 2000;
export const ANCHOR_FUZZY_MIN = 0.8;
export const ANCHOR_BASE_EXCLUDE = 'script, style, noscript, template, textarea, input, button, select, option, .quiz, [data-lrn-noanno]';

const ANCHOR_BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
  'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'BR']);
const ANCHOR_HINT_BLOCKS = 'p, li, td, th, h1, h2, h3, h4, h5, h6, dt, dd, blockquote, pre, figcaption, div.callout';
const ANCHOR_WS = /\s/;

/** White space runs → one space, trimmed (the form of every stored quote). */
export function anchorNormalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The text model of `root`.
 * @param {Node} root
 * @param {{ exclude?: string }} [opts] a selector list of excluded elements
 * @returns {{ text: string, segs: { node: Text, start: number, len: number, raw: Int32Array }[], index: Map<Text, number>, root: Node }}
 *   `raw[i]` is the offset in `node.data` of character `start + i` of `text`
 *   (`raw[len]` = the end of the node's data).
 */
export function anchorTextModel(root, { exclude = ANCHOR_BASE_EXCLUDE } = {}) {
  const segs = [];
  const index = new Map();
  const parts = [];
  let length = 0;
  let lastSpace = true; // nothing yet: a leading space is dropped
  let lastBlock = null;
  const doc = root.ownerDocument || root;
  const isExcluded = (el) => {
    try { return el.matches(exclude); } catch { return el.matches(ANCHOR_BASE_EXCLUDE); }
  };
  const blocks = new Map();
  const blockOf = (node) => {
    const chain = [];
    let el = node.parentElement;
    let found = null;
    while (el && el !== root) {
      if (blocks.has(el)) { found = blocks.get(el); break; }
      chain.push(el);
      if (ANCHOR_BLOCKS.has(el.tagName)) { found = el; break; }
      el = el.parentElement;
    }
    if (!found) found = root;
    for (const c of chain) blocks.set(c, found);
    return found;
  };
  const walker = doc.createTreeWalker(root, 1 | 4 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: (n) => (n.nodeType === 1 && isExcluded(n) ? 2 /* REJECT: the whole subtree */ : n.nodeType === 1 ? 3 /* SKIP */ : 1),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = n.data;
    if (!data) continue;
    const block = blockOf(n);
    let out = '';
    const raw = [];
    if (lastBlock !== null && block !== lastBlock && !lastSpace) {
      out += ' '; // a virtual space between two blocks, at the start of this node
      raw.push(0);
      lastSpace = true;
    }
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ANCHOR_WS.test(ch)) {
        if (lastSpace) continue;
        out += ' ';
        lastSpace = true;
      } else {
        out += ch;
        lastSpace = false;
      }
      raw.push(i);
    }
    lastBlock = block;
    if (!out.length) continue;
    raw.push(data.length);
    segs.push({ node: n, start: length, len: out.length, raw: Int32Array.from(raw) });
    index.set(n, segs.length - 1);
    parts.push(out);
    length += out.length;
  }
  return { text: parts.join(''), segs, index, root };
}

/** Offset in the model of a DOM point (a boundary of a Range). */
export function anchorOffset(model, container, offset) {
  const { segs } = model;
  if (container && container.nodeType === 3 && model.index.has(container)) {
    const seg = segs[model.index.get(container)];
    const raw = seg.raw;
    let lo = 0;
    let hi = seg.len; // first i with raw[i] >= offset
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (raw[mid] < offset) lo = mid + 1; else hi = mid;
    }
    return seg.start + lo;
  }
  // An element boundary, or a text node that is not in the model (excluded):
  // the first node of the model at or after the point.
  const doc = model.root.ownerDocument || model.root;
  const probe = doc.createRange();
  try { probe.setStart(container, offset); } catch { return model.text.length; }
  probe.collapse(true);
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let cmp;
    try { cmp = probe.comparePoint(segs[mid].node, 0); } catch { cmp = 1; }
    if (cmp >= 0) hi = mid; else lo = mid + 1;
  }
  return lo < segs.length ? segs[lo].start : model.text.length;
}

/** The segment holding offset `at` (for a start: at < end of seg; for an end: at <= end of seg). */
function anchorSegAt(model, at, isEnd) {
  const { segs } = model;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (isEnd ? segs[mid].start < at : segs[mid].start <= at) lo = mid; else hi = mid - 1;
  }
  return segs[lo];
}

/** A DOM Range for [start, end) of the model, or null. */
export function anchorRange(model, start, end) {
  if (!model.segs.length || !(start >= 0) || !(end > start) || end > model.text.length) return null;
  const a = anchorSegAt(model, start, false);
  const b = anchorSegAt(model, end, true);
  const doc = model.root.ownerDocument || model.root;
  const range = doc.createRange();
  try {
    range.setStart(a.node, a.raw[Math.min(start - a.start, a.len)]);
    range.setEnd(b.node, b.raw[Math.min(end - b.start, b.len)]);
  } catch {
    return null;
  }
  return range;
}

/** CSS path from the root to the nearest block of `node` (≤ 200 characters), or null. */
export function anchorBlockPath(root, node) {
  let el = node && (node.nodeType === 1 ? node : node.parentElement);
  el = el && el.closest ? el.closest(ANCHOR_HINT_BLOCKS) : null;
  if (!el || !root.contains(el) || el === root) return null;
  const steps = [];
  for (let cur = el; cur && cur !== root && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur.id && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(cur.id)) { steps.unshift(`#${cur.id}`); break; }
    let k = 1;
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === cur.tagName) k++;
    steps.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${k})`);
    if (steps.length > 12) return null;
  }
  const path = steps.join(' > ');
  return path.length <= 200 ? path : null;
}

/**
 * Selectors for [start, end) of the model (spaces at the ends are left out).
 * @returns {{ quote: { exact, prefix, suffix }, position: { start, end }, hint?: { blockPath } } | null}
 */
export function anchorDescribe(model, start, end) {
  const T = model.text;
  start = Math.max(0, start | 0);
  end = Math.min(T.length, end | 0);
  while (start < end && T[start] === ' ') start++;
  while (end > start && T[end - 1] === ' ') end--;
  if (end <= start) return null;
  if (end - start > ANCHOR_MAX_EXACT) end = start + ANCHOR_MAX_EXACT;
  const selector = {
    quote: {
      exact: T.slice(start, end),
      prefix: T.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
      suffix: T.slice(end, end + ANCHOR_CONTEXT),
    },
    position: { start, end },
  };
  const seg = anchorSegAt(model, start, false);
  const blockPath = seg ? anchorBlockPath(model.root, seg.node) : null;
  if (blockPath) selector.hint = { blockPath };
  return selector;
}

/** Selectors of a DOM Range in the model (a selection), or null. */
export function anchorDescribeRange(model, range) {
  const start = anchorOffset(model, range.startContainer, range.startOffset);
  const end = anchorOffset(model, range.endContainer, range.endOffset);
  return end > start ? anchorDescribe(model, start, end) : null;
}

// --- Re-anchoring ------------------------------------------------------------------

/** How much of prefix/suffix is still around [s, e) of T: 0…1 (1 if there is no context). */
function anchorContextScore(T, s, e, prefix, suffix) {
  let total = 0;
  let same = 0;
  if (prefix) {
    total += prefix.length;
    let i = 0;
    while (i < prefix.length && s - 1 - i >= 0 && T[s - 1 - i] === prefix[prefix.length - 1 - i]) i++;
    same += i;
  }
  if (suffix) {
    total += suffix.length;
    let i = 0;
    while (i < suffix.length && e + i < T.length && T[e + i] === suffix[i]) i++;
    same += i;
  }
  return total ? same / total : 1;
}

/**
 * Approximate substring match (Sellers): the end in text[from, to) where
 * `pattern` matches with the fewest edits. Ties → nearest to `near`.
 */
function anchorBestEnd(text, from, to, pattern, near) {
  const m = pattern.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = m;
  let bestEnd = from;
  for (let j = from; j < to; j++) {
    const c = text.charCodeAt(j);
    cur[0] = 0;
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (pattern.charCodeAt(i - 1) === c ? 0 : 1);
      const del = prev[i] + 1;
      const ins = cur[i - 1] + 1;
      cur[i] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const d = cur[m];
    if (d < best || (d === best && Math.abs(j + 1 - near) < Math.abs(bestEnd - near))) { best = d; bestEnd = j + 1; }
    const t = prev; prev = cur; cur = t;
  }
  return { end: bestEnd, dist: best };
}

const anchorReverse = (s) => {
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) out += s[i];
  return out;
};

/** The best approximate place of `exact` in T: { start, end, similarity } or null. */
function anchorFuzzy(T, exact, prefix, suffix, oldStart, hintStart) {
  const m = exact.length;
  if (!m || !T.length) return null;
  // Seeds: pieces of the quote and the ends of its context that are still there.
  const votes = new Map();
  const vote = (expected, weight) => {
    if (expected < -m || expected > T.length) return;
    const bucket = Math.round(expected / Math.max(8, m >> 1));
    const v = votes.get(bucket) || { n: 0, at: expected };
    v.n += weight;
    votes.set(bucket, v);
  };
  const g = Math.max(4, Math.min(16, m >> 2));
  const pieces = Math.min(8, Math.max(1, Math.floor(m / g)));
  const look = (needle, delta, weight) => {
    if (!needle || needle.length < 4) return;
    let found = 0;
    for (let at = T.indexOf(needle); at >= 0 && found < 50; at = T.indexOf(needle, at + 1)) { vote(at + delta, weight); found++; }
  };
  for (let k = 0; k < pieces; k++) {
    const off = pieces === 1 ? 0 : Math.round((k * (m - g)) / (pieces - 1));
    look(exact.slice(off, off + g), -off, 1);
  }
  const ctx = Math.min(16, prefix.length);
  if (ctx >= 4) look(prefix.slice(-ctx), ctx, 2);
  const ctxS = Math.min(16, suffix.length);
  if (ctxS >= 4) look(suffix.slice(0, ctxS), -m, 2);
  if (Number.isInteger(hintStart) && hintStart >= 0) vote(hintStart, 1);
  if (Number.isInteger(oldStart)) vote(Math.min(oldStart, T.length), 0.5);
  const candidates = [...votes.values()].sort((a, b) => b.n - a.n).slice(0, m > 500 ? 3 : 6);
  let best = null;
  const slack = Math.max(16, m >> 1);
  for (const c of candidates) {
    const from = Math.max(0, Math.round(c.at) - slack);
    const to = Math.min(T.length, Math.round(c.at) + m + slack);
    if (to <= from) continue;
    const near = Math.round(c.at) + m;
    const { end, dist } = anchorBestEnd(T, from, to, exact, near);
    // The start: the same match backwards from `end`.
    const revText = anchorReverse(T.slice(from, end));
    const back = anchorBestEnd(revText, 0, revText.length, anchorReverse(exact), m);
    const start = end - back.end;
    if (end <= start) continue;
    const similarity = 1 - Math.max(dist, back.dist) / Math.max(m, end - start);
    const context = anchorContextScore(T, start, end, prefix, suffix);
    const score = similarity + 0.05 * context;
    if (!best || score > best.score) best = { start, end, similarity, context, score };
  }
  return best;
}

/**
 * Re-anchor one selector in the model.
 * @param {ReturnType<typeof anchorTextModel>} model
 * @param {{ quote: { exact: string, prefix?: string, suffix?: string }, position?: { start: number, end: number }, hint?: { blockPath?: string } }} selector
 * @param {{ sameVersion?: boolean }} [opts]
 * @returns {{ state: 'ok'|'fuzzy'|'orphan', start?: number, end?: number, similarity?: number }}
 */
export function anchorFind(model, selector, { sameVersion = false } = {}) {
  const T = model.text;
  const exact = typeof selector?.quote?.exact === 'string' ? anchorNormalize(selector.quote.exact).slice(0, ANCHOR_MAX_EXACT) : '';
  if (!exact) return { state: 'orphan' };
  const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ') : '');
  const prefix = text(selector.quote.prefix).slice(-ANCHOR_CONTEXT * 2);
  const suffix = text(selector.quote.suffix).slice(0, ANCHOR_CONTEXT * 2);
  const pos = selector.position;
  const oldStart = pos && Number.isInteger(pos.start) ? pos.start : null;
  // 1. The same version: the position, if the text there is still the quote.
  if (sameVersion && oldStart !== null && T.slice(oldStart, oldStart + exact.length) === exact) {
    return { state: 'ok', start: oldStart, end: oldStart + exact.length, similarity: 1 };
  }
  // 2. The exact quote: the best by context, then by nearness to the old place.
  const hits = [];
  for (let at = T.indexOf(exact); at >= 0 && hits.length < 2000; at = T.indexOf(exact, at + 1)) hits.push(at);
  if (hits.length) {
    const scored = hits.map((at) => ({
      at,
      context: anchorContextScore(T, at, at + exact.length, prefix, suffix),
      near: oldStart === null ? 0 : Math.abs(at - oldStart) / Math.max(1, T.length),
    })).sort((a, b) => (b.context - 0.01 * b.near) - (a.context - 0.01 * a.near));
    const best = scored[0];
    const second = scored.length > 1 ? scored[1].context : -1;
    // Several places and none keeps its context: a guess, so "провери".
    const unsure = hits.length > 1 && best.context < 0.2 && exact.length < 24 && best.context - second < 0.1;
    return { state: unsure ? 'fuzzy' : 'ok', start: best.at, end: best.at + exact.length, similarity: 1 };
  }
  // 3. Approximate.
  let hintStart = null;
  const path = selector.hint?.blockPath;
  if (typeof path === 'string' && path && path.length <= 200 && model.root.querySelector) {
    try {
      const el = model.root.querySelector(path);
      if (el) {
        for (const seg of model.segs) {
          if (el.contains(seg.node)) { hintStart = seg.start; break; }
        }
      }
    } catch { /* a bad path: no hint */ }
  }
  const found = anchorFuzzy(T, exact, prefix, suffix, oldStart, hintStart);
  if (found && found.similarity >= ANCHOR_FUZZY_MIN && (exact.length >= 12 || found.context >= 0.5)) {
    return { state: 'fuzzy', start: found.start, end: found.end, similarity: Math.round(found.similarity * 1000) / 1000 };
  }
  // 4. Never dropped.
  return { state: 'orphan' };
}
