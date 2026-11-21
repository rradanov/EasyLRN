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
//   with none of its context, found once or in several places → fuzzy); else
//   an approximate search → fuzzy: edit distance (bit-parallel), similarity
//   ≥ 0.8 (a short quote needs its context too), or ≥ 0.7 when the 16
//   characters on both sides of it are intact; else orphan. Nothing is ever dropped: an orphan
//   keeps its selector and is listed apart (T-015/T-029).
// - T-013-fix (0.12.1): a <br> is a space in the model like a block border
//   (T014-D2); the approximate search first tries the places where the ends
//   of the quote or of its context still are (T014-D3).
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
/** The lower threshold for a quote whose context is intact on both sides (T-013-fix). */
export const ANCHOR_FUZZY_PLACED = 0.7;
export const ANCHOR_BASE_EXCLUDE = 'script, style, noscript, template, textarea, input, button, select, option, .quiz, [data-lrn-noanno]';

const ANCHOR_BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
  'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'BR']);
const ANCHOR_HINT_BLOCKS = 'p, li, td, th, h1, h2, h3, h4, h5, h6, dt, dd, blockquote, pre, figcaption, div.callout';
const ANCHOR_WS = /\s/;
const ANCHOR_WS_RUN = /\s+/g;

/** White space runs → one space, trimmed (the form of every stored quote). */
export function anchorNormalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The text model of `root`.
 * @param {Node} root
 * @param {{ exclude?: string }} [opts] a selector list of excluded elements
 * @returns {{ text: string, segs: { node: Text, start: number, len: number, raw: Int32Array|null }[], index: Map<Text, number>, root: Node }}
 *   `raw[i]` is the offset in `node.data` of character `start + i` of `text`
 *   (`raw[len]` = the end of the node's data); `raw` null = the same offset.
 */
export function anchorTextModel(root, { exclude = ANCHOR_BASE_EXCLUDE } = {}) {
  const segs = [];
  const index = new Map();
  const parts = [];
  let length = 0;
  let lastSpace = true; // nothing yet: a leading space is dropped
  let lastBlock = null;
  let lineBreak = false; // a <br> since the last text (T014-D2): a space, like between blocks
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
    acceptNode: (n) => {
      if (n.nodeType !== 1) return 1;
      if (isExcluded(n)) return 2; // REJECT: the whole subtree
      if (n.tagName === 'BR') lineBreak = true;
      return 3; // SKIP: look inside
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = n.data;
    if (!data) continue;
    const block = blockOf(n);
    const virtual = lastBlock !== null && (block !== lastBlock || lineBreak) && !lastSpace;
    // Fast path (T014-D4): most text nodes need no collapsing, so the offsets
    // map one to one and no table is kept (`raw` null = identity).
    const collapsed = data.replace(ANCHOR_WS_RUN, ' ');
    const drop = !virtual && lastSpace && collapsed.charCodeAt(0) === 32 ? 1 : 0;
    let out;
    let raw = null;
    if (!virtual && !drop && collapsed.length === data.length) {
      out = collapsed;
    } else {
      out = '';
      const map = [];
      let space = lastSpace;
      if (virtual) {
        out += ' '; // a virtual space between two blocks (or after a <br>), at the start of this node
        map.push(0);
        space = true;
      }
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ANCHOR_WS.test(ch)) {
          if (space) continue;
          out += ' ';
          space = true;
        } else {
          out += ch;
          space = false;
        }
        map.push(i);
      }
      map.push(data.length);
      raw = Int32Array.from(map);
    }
    lastBlock = block;
    if (!out.length) continue;
    lineBreak = false;
    lastSpace = out.charCodeAt(out.length - 1) === 32;
    segs.push({ node: n, start: length, len: out.length, raw });
    index.set(n, segs.length - 1);
    parts.push(out);
    length += out.length;
  }
  return { text: parts.join(''), segs, index, root };
}

/** Offset in `node.data` of character `i` of a segment (0 ≤ i ≤ len). */
const anchorRaw = (seg, i) => (seg.raw ? seg.raw[i] : i);

/** Offset in the model of a DOM point (a boundary of a Range). */
export function anchorOffset(model, container, offset) {
  const { segs } = model;
  if (container && container.nodeType === 3 && model.index.has(container)) {
    const seg = segs[model.index.get(container)];
    if (!seg.raw) return seg.start + Math.max(0, Math.min(seg.len, offset));
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
    range.setStart(a.node, anchorRaw(a, Math.min(start - a.start, a.len)));
    range.setEnd(b.node, anchorRaw(b, Math.min(end - b.start, b.len)));
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

/**
 * How much of prefix/suffix is still right around [s, e) of T.
 * `score` 0…1 for both sides together (1 if there is no context at all),
 * `pre`/`post` per side (1 for an absent side), `intact` = matching characters.
 */
function anchorContext(T, s, e, prefix, suffix) {
  let i = 0;
  if (prefix) while (i < prefix.length && s - 1 - i >= 0 && T.charCodeAt(s - 1 - i) === prefix.charCodeAt(prefix.length - 1 - i)) i++;
  let k = 0;
  if (suffix) while (k < suffix.length && e + k < T.length && T.charCodeAt(e + k) === suffix.charCodeAt(k)) k++;
  const total = prefix.length + suffix.length;
  return {
    score: total ? (i + k) / total : 1,
    pre: prefix.length ? i / prefix.length : 1,
    post: suffix.length ? k / suffix.length : 1,
    before: i,
    after: k,
    intact: i + k,
  };
}

/** The bit vectors of a pattern for anchorScan. */
function anchorPattern(pattern) {
  const m = pattern.length;
  const blocks = (m + 31) >> 5;
  const peq = new Map();
  for (let i = 0; i < m; i++) {
    const c = pattern.charCodeAt(i);
    let v = peq.get(c);
    if (!v) { v = new Int32Array(blocks); peq.set(c, v); }
    v[i >> 5] |= 1 << (i & 31);
  }
  return { m, blocks, peq, none: new Int32Array(blocks), pv: new Int32Array(blocks), mv: new Int32Array(blocks) };
}

/**
 * Edit distance (Levenshtein) of a pattern (anchorPattern) against text[from, to):
 * - `global` false: where the pattern ENDS best in the range (approximate
 *   substring match, Sellers): { end, dist }; ties → nearest to `near`;
 * - `global` true: the whole pattern against the whole range: { end: to, dist }.
 * Bit-parallel (Myers 1999, blocks of 32 bits as in Hyyrö 2003): (to − from) ×
 * ⌈m / 32⌉ steps instead of (to − from) × m (T014-D3). The results are the
 * same as the plain dynamic programme (checked in tests/anchor.test.js).
 */
export function anchorScan(text, from, to, P, global = false, near = 0) {
  const { m, blocks, peq, none, pv: Pv, mv: Mv } = P;
  Pv.fill(-1);
  Mv.fill(0);
  const last = blocks - 1;
  const lastBit = 1 << ((m - 1) & 31); // the row of the last pattern character
  const HIGH = 0x80000000 | 0;
  let score = m;
  let best = m;
  let bestEnd = from;
  for (let j = from; j < to; j++) {
    const eq = peq.get(text.charCodeAt(j)) || none;
    let hin = global ? 1 : 0; // the top row: 0 everywhere (search) or j (global)
    for (let b = 0; b <= last; b++) {
      const pv = Pv[b];
      const mv = Mv[b];
      let e = eq[b];
      const xv = e | mv;
      if (hin < 0) e |= 1;
      const xh = ((((e & pv) + pv) | 0) ^ pv) | e;
      let ph = mv | ~(xh | pv);
      let mh = pv & xh;
      const bit = b === last ? lastBit : HIGH;
      const hout = ph & bit ? 1 : mh & bit ? -1 : 0;
      ph <<= 1;
      mh <<= 1;
      if (hin < 0) mh |= 1; else if (hin > 0) ph |= 1;
      Pv[b] = mh | ~(xv | ph);
      Mv[b] = ph & xv;
      hin = hout;
    }
    score += hin;
    if (!global && (score < best || (score === best && Math.abs(j + 1 - near) < Math.abs(bestEnd - near)))) { best = score; bestEnd = j + 1; }
  }
  return global ? { end: to, dist: score } : { end: bestEnd, dist: best };
}

const anchorReverse = (s) => {
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) out += s[i];
  return out;
};

// An index of the 4-grams of a long text (built once per text, on the first
// search that needs it): a search for a piece looks only at the places of its
// rarest 4-gram instead of reading the whole text (T014-D3: hundreds of
// quotes in a 0.5 M-character lesson).
const ANCHOR_INDEX_MIN = 65536;
const ANCHOR_GRAM_BITS = 16;
let anchorIndexCache = null;
const anchorGram = (T, i) => (((T.charCodeAt(i) * 31 + T.charCodeAt(i + 1)) * 31 + T.charCodeAt(i + 2)) * 31 + T.charCodeAt(i + 3)) & ((1 << ANCHOR_GRAM_BITS) - 1);
function anchorIndex(T) {
  if (anchorIndexCache && anchorIndexCache.text === T) return anchorIndexCache;
  const buckets = 1 << ANCHOR_GRAM_BITS;
  const n = Math.max(0, T.length - 3);
  const starts = new Uint32Array(buckets + 1);
  for (let i = 0; i < n; i++) starts[anchorGram(T, i) + 1]++;
  for (let b = 0; b < buckets; b++) starts[b + 1] += starts[b];
  const fill = starts.slice(0, buckets);
  const pos = new Uint32Array(n);
  for (let i = 0; i < n; i++) pos[fill[anchorGram(T, i)]++] = i; // ascending within each bucket
  anchorIndexCache = { text: T, starts, pos };
  return anchorIndexCache;
}

/** Up to `max` places of `needle` in T[from, to) (in order). */
function anchorHits(T, needle, max, from = 0, to = Infinity) {
  const out = [];
  if (!needle) return out;
  from = Math.max(0, from);
  if (to >= T.length && T.length >= ANCHOR_INDEX_MIN && needle.length >= 4) {
    // The whole of a long text: through the index.
    const { starts, pos } = anchorIndex(T);
    let k = 0;
    let size = Infinity;
    const step = Math.max(1, Math.floor((needle.length - 4) / 15));
    for (let o = 0; o + 4 <= needle.length; o += step) {
      const g = anchorGram(needle, o);
      const sz = starts[g + 1] - starts[g];
      if (sz < size) { size = sz; k = o; if (!sz) return out; }
    }
    const g = anchorGram(needle, k);
    let lo = starts[g];
    let hi = starts[g + 1];
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[mid] < from + k) lo = mid + 1; else hi = mid; }
    for (let j = lo; j < starts[g + 1] && out.length < max; j++) {
      const at = pos[j] - k;
      if (T.startsWith(needle, at)) out.push(at);
    }
    return out;
  }
  if (to < T.length) {
    // A window: search in it only (indexOf would run on to the end of the text).
    const W = T.slice(from, Math.min(T.length, to + needle.length - 1));
    for (let at = W.indexOf(needle); at >= 0 && out.length < max; at = W.indexOf(needle, at + 1)) out.push(from + at);
    return out;
  }
  for (let at = T.indexOf(needle, from); at >= 0 && out.length < max; at = T.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** The lengths a match of an m-character quote may have and still reach the lowest threshold. */
const anchorMinLen = (m) => Math.floor(m * ANCHOR_FUZZY_PLACED) - 1;
const anchorMaxLen = (m) => Math.ceil(m / ANCHOR_FUZZY_PLACED) + 1;

/** The best approximate place of `exact` in T: { start, end, similarity, context } or null. */
function anchorFuzzy(T, exact, prefix, suffix, oldStart, hintStart) {
  const m = exact.length;
  if (!m || !T.length) return null;
  const P = anchorPattern(exact);
  let best = null;
  const consider = (start, end, dist) => {
    if (end <= start) return;
    const similarity = 1 - dist / Math.max(m, end - start);
    const context = anchorContext(T, start, end, prefix, suffix);
    const score = similarity + 0.05 * context.score;
    if (!best || score > best.score) best = { start, end, similarity, context, score };
  };
  const near = (at) => (oldStart === null ? 0 : Math.abs(at - oldStart));
  const reach = 2048 + 2 * m; // around the old place: the most likely
  /** Spans [s, e) from two sorted lists of starts and ends, of a plausible length; the best few by length and nearness. */
  const spans = (starts, ends) => {
    const out = [];
    const lo = anchorMinLen(m);
    const hi = anchorMaxLen(m);
    for (const s of starts) {
      for (const e of ends) {
        const len = e - s;
        if (len < lo) continue;
        if (len > hi) break;
        out.push({ s, e, cost: Math.abs(len - m) * 4 + near(s) / Math.max(1, T.length) });
      }
    }
    return out.sort((a, b) => a.cost - b.cost).slice(0, 3);
  };
  const cp = Math.min(16, prefix.length);
  const cs = Math.min(16, suffix.length);
  const g = Math.min(32, Math.max(8, m >> 2));
  const minLen = anchorMinLen(m);
  const maxLen = anchorMaxLen(m);
  /** Places where `needle` is, moved by `shift` (null needle: the edge `edge`). */
  const at = (needle, shift, lo, hi, max, edge) => (needle === null ? [edge] : anchorHits(T, needle, max, lo, hi).map((h) => h + shift));
  /**
   * Spans [s, e) from the places of a start piece and an end piece in T[lo, hi).
   * A piece that is everywhere (≥ 400 places, e.g. the end of a sentence that
   * every paragraph has) is looked for only just before / after the places of
   * the other one.
   */
  const pairs = (sNeedle, sShift, eNeedle, eShift, lo, hi) => {
    const FEW = 64;
    let S = at(sNeedle, sShift, lo, hi, FEW, 0);
    if (!S.length) return;
    let E = at(eNeedle, eShift, lo, hi, FEW, T.length);
    if (!E.length) return;
    if (S.length >= FEW && E.length >= FEW) {
      S = at(sNeedle, sShift, lo, hi, 400, 0);
      E = at(eNeedle, eShift, lo, hi, 400, T.length);
    } else if (S.length >= FEW) {
      S = [...new Set(E.slice(0, 64).flatMap((e) => at(sNeedle, sShift, Math.max(lo, e - maxLen - sShift), Math.min(hi, e - minLen - sShift + 1), 8, 0)))].sort((x, y) => x - y);
    } else if (E.length >= FEW) {
      E = [...new Set(S.slice(0, 64).flatMap((st) => at(eNeedle, eShift, Math.max(lo, st + minLen - eShift), Math.min(hi, st + maxLen - eShift + 1), 8, T.length)))].sort((x, y) => x - y);
    }
    // The likeliest span first; a good one ends the search.
    for (const { s: st, e } of spans(S, E)) {
      consider(st, e, anchorScan(T, st, e, P, true).dist);
      if (best && best.similarity >= 0.9 && best.context.score >= 0.5) return;
    }
  };
  /** The fast ways, with the pieces looked for in T[lo, hi) only. */
  const fast = (lo, hi) => {
    // 1. The ends of the quote are still there, exactly (a small edit inside it).
    if (m >= 24) pairs(exact.slice(0, g), 0, exact.slice(m - g), g, lo, hi);
    if (best && best.similarity >= 0.9 && best.context.score >= 0.5) return;
    // 2. The context around it is still there (an edit at an end of the quote).
    if ((cp >= 4 || !prefix) && (cs >= 4 || !suffix) && (prefix || suffix)) {
      pairs(prefix ? prefix.slice(-cp) : null, cp, suffix ? suffix.slice(0, cs) : null, 0, lo, hi);
    }
  };
  // Around the old place and the hint first (most edits move a quote only a little), then everywhere.
  for (const center of [oldStart, hintStart]) {
    if (!Number.isInteger(center) || center < 0) continue;
    fast(Math.max(0, center - reach), Math.min(T.length, center + m + reach));
    if (best && best.similarity >= ANCHOR_FUZZY_MIN) return best;
  }
  if (T.length > 2 * reach + m || oldStart === null) fast(0, T.length);
  if (best && best.similarity >= ANCHOR_FUZZY_MIN) return best;
  // 3. Search around the places voted for by surviving pieces of the quote,
  //    the ends of its context, the hint and the old position.
  const votes = new Map();
  const vote = (expected, weight) => {
    if (expected < -m || expected > T.length) return;
    const bucket = Math.round(expected / Math.max(8, m >> 1));
    const v = votes.get(bucket) || { n: 0, at: expected };
    v.n += weight;
    votes.set(bucket, v);
  };
  const gp = Math.max(4, Math.min(16, m >> 2));
  const pieces = Math.min(8, Math.max(1, Math.floor(m / gp)));
  const look = (needle, delta, weight) => {
    if (!needle || needle.length < 4) return;
    for (const at of anchorHits(T, needle, 50)) vote(at + delta, weight);
  };
  for (let k = 0; k < pieces; k++) {
    const off = pieces === 1 ? 0 : Math.round((k * (m - gp)) / (pieces - 1));
    look(exact.slice(off, off + gp), -off, 1);
  }
  if (cp >= 4) look(prefix.slice(-cp), cp, 2);
  if (cs >= 4) look(suffix.slice(0, cs), -m, 2);
  if (Number.isInteger(hintStart) && hintStart >= 0) vote(hintStart, 1);
  if (Number.isInteger(oldStart)) vote(Math.min(oldStart, T.length), 0.5);
  const candidates = [...votes.values()].sort((a, b) => b.n - a.n).slice(0, m > 500 ? 3 : 6);
  const slack = Math.max(16, m >> 1);
  let R = null;
  for (const c of candidates) {
    const from = Math.max(0, Math.round(c.at) - slack);
    const to = Math.min(T.length, Math.round(c.at) + m + slack);
    if (to <= from) continue;
    const { end, dist } = anchorScan(T, from, to, P, false, Math.round(c.at) + m);
    // An upper bound of the similarity (the match is at most end − from long): too low → skip the way back.
    if (1 - dist / Math.max(m, end - from) < ANCHOR_FUZZY_PLACED) continue;
    // The start: the same match backwards from `end`.
    R = R || anchorPattern(anchorReverse(exact));
    const revText = anchorReverse(T.slice(from, end));
    const back = anchorScan(revText, 0, revText.length, R, false, m);
    const start = end - back.end;
    consider(start, end, Math.max(dist, back.dist));
    // The edit distance alone may cut a word off an end ("Производителят
    // внимателно оценява" vs "Производителят оценява": dropping the first word
    // costs about as much as the insertion). Where the first / last characters
    // of the quote are still there, those ends are tried too; the context
    // decides between them.
    if (m >= 16) {
      const k = 8;
      const starts = anchorHits(T, exact.slice(0, k), 4, Math.max(0, end - maxLen), Math.max(0, end - minLen + 1)).filter((x) => x !== start);
      const ends = anchorHits(T, exact.slice(m - k), 4, start + minLen - k, Math.min(T.length, start + maxLen - k + 1)).map((x) => x + k).filter((x) => x !== end);
      for (const st of starts) consider(st, end, anchorScan(T, st, end, P, true).dist);
      for (const e of ends) consider(start, e, anchorScan(T, start, e, P, true).dist);
    }
  }
  return best;
}

/**
 * Where the block of a hint starts in the model, or null. The paths that
 * anchorBlockPath makes (`#id`, `tag:nth-of-type(k)` joined by ` > `) are
 * followed directly (fast); anything else through querySelector. A hint only
 * narrows the search: a wrong one costs time, never a wrong place.
 */
function anchorHintStart(model, path) {
  if (typeof path !== 'string' || !path || path.length > 200 || !model.root.querySelector) return null;
  let el = null;
  try {
    const steps = path.split(' > ');
    let cur = model.root;
    for (const step of steps) {
      const id = /^#([A-Za-z][A-Za-z0-9_-]{0,40})$/.exec(step);
      const nth = id ? null : /^([a-z][a-z0-9]{0,15}):nth-of-type\((\d{1,6})\)$/.exec(step);
      if (id) {
        const doc = model.root.ownerDocument || model.root;
        cur = doc.getElementById ? doc.getElementById(id[1]) : null;
        if (cur && !model.root.contains(cur)) cur = null;
      } else if (nth) {
        // The children of a parent by tag, once per model (many hints share a parent).
        const tag = nth[1].toUpperCase();
        if (!model.byTag) model.byTag = new Map();
        let tags = model.byTag.get(cur);
        if (!tags) { tags = new Map(); model.byTag.set(cur, tags); }
        let list = tags.get(tag);
        if (!list) {
          list = [];
          for (let c = cur.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === tag) list.push(c);
          tags.set(tag, list);
        }
        cur = list[Number(nth[2]) - 1] || null;
      } else {
        cur = undefined; // not one of ours
        break;
      }
      if (!cur) break;
    }
    el = cur === undefined ? model.root.querySelector(path) : cur;
  } catch { el = null; }
  if (!el || !model.segs.length) return null;
  // The first text node of the block that is in the model.
  const doc = model.root.ownerDocument || model.root;
  try {
    const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
    for (let n = walker.nextNode(), i = 0; n && i < 5000; n = walker.nextNode(), i++) {
      const k = model.index.get(n);
      if (k !== undefined) return model.segs[k].start;
    }
  } catch { /* a broken DOM: no hint */ }
  return null;
}

/**
 * Re-anchor one selector in the model.
 * @param {ReturnType<typeof anchorTextModel>} model
 * @param {{ quote: { exact: string, prefix?: string, suffix?: string }, position?: { start: number, end: number }, hint?: { blockPath?: string } }} selector
 * @param {{ sameVersion?: boolean, within?: [number, number] }} [opts] `within`: search only
 *   in that part of the text (T014-D4: an orphan after a change elsewhere; the rest was searched before)
 * @returns {{ state: 'ok'|'fuzzy'|'orphan', start?: number, end?: number, similarity?: number }}
 */
export function anchorFind(model, selector, { sameVersion = false, within = null } = {}) {
  const full = model.text;
  const exact = typeof selector?.quote?.exact === 'string' ? anchorNormalize(selector.quote.exact).slice(0, ANCHOR_MAX_EXACT) : '';
  if (!exact) return { state: 'orphan' };
  const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ') : '');
  const prefix = text(selector.quote.prefix).slice(-ANCHOR_CONTEXT * 2);
  const suffix = text(selector.quote.suffix).slice(0, ANCHOR_CONTEXT * 2);
  const pos = selector.position;
  let oldStart = pos && Number.isInteger(pos.start) ? pos.start : null;
  // 1. The same version: the position, if the text there is still the quote.
  if (!within && sameVersion && oldStart !== null && full.slice(oldStart, oldStart + exact.length) === exact) {
    return { state: 'ok', start: oldStart, end: oldStart + exact.length, similarity: 1 };
  }
  let base = 0;
  let T = full;
  if (within) {
    base = Math.max(0, Math.min(full.length, within[0] | 0));
    T = full.slice(base, Math.max(base, Math.min(full.length, within[1] | 0)));
    if (oldStart !== null) oldStart -= base;
  }
  const at = (r) => (r.state === 'orphan' ? r : { ...r, start: r.start + base, end: r.end + base });
  // 2. The exact quote: the best by context, then by nearness to the old place.
  //    Near the old place with all of its context: nothing can be better.
  //    Not for a short quote (< 24, T013F-D2): a repeated sentence can have the
  //    same 32 characters around it elsewhere; it goes through the rule below.
  if (oldStart !== null && exact.length >= 24) {
    const reach = 2048 + 2 * exact.length;
    let near = null;
    for (const h of anchorHits(T, exact, 50, Math.max(0, oldStart - reach), oldStart + reach)) {
      if (anchorContext(T, h, h + exact.length, prefix, suffix).score === 1 && (near === null || Math.abs(h - oldStart) < Math.abs(near - oldStart))) near = h;
    }
    if (near !== null) return at({ state: 'ok', start: near, end: near + exact.length, similarity: 1 });
  }
  const hits = anchorHits(T, exact, 2000);
  if (hits.length) {
    const scored = hits.map((h) => {
      const c = anchorContext(T, h, h + exact.length, prefix, suffix);
      return { at: h, c, context: c.score, near: oldStart === null ? 0 : Math.abs(h - oldStart) / Math.max(1, T.length) };
    }).sort((a, b) => (b.context - 0.01 * b.near) - (a.context - 0.01 * a.near));
    const best = scored[0];
    const second = scored.length > 1 ? scored[1].context : -1;
    // A short quote (< 24) is "ok" only with STRONG context (T013F-D2; T014-D1):
    // - found once: ≥ 80 % of its context, or ≥ 40 % on EACH side and ≥ 75 %
    //   in all (a common phrase on one side, or on both, is not enough);
    // - found at several places: ≥ 90 % of its context at the best one and no
    //   other copy with half of it — in a repeated sentence the 32 characters
    //   on one or both sides are often the same at another copy.
    // Else a guess: "провери". (A selector without any context at all has
    // nothing to compare: the best place as before.)
    // T063-D5: two generic phrases ("в съответствие с … от настоящия регламент")
    // reach 40 % on each side by themselves: that path also needs ≥ 75 % in all.
    const strongOnce = (h) => h.context >= 0.8 || (h.c.pre >= 0.4 && h.c.post >= 0.4 && h.context >= 0.75);
    const unsure = exact.length < 24 && prefix.length + suffix.length > 0 && (hits.length === 1
      ? !strongOnce(best)
      : best.context < 0.9 || second >= 0.5);
    return at({ state: unsure ? 'fuzzy' : 'ok', start: best.at, end: best.at + exact.length, similarity: 1 });
  }
  // 3. Approximate.
  const hintStart = within ? null : anchorHintStart(model, selector.hint?.blockPath);
  const found = anchorFuzzy(T, exact, prefix, suffix, oldStart, hintStart);
  if (found) {
    const c = found.context;
    // ≥ 0.8; a short quote (< 12) needs half of its context too.
    const close = found.similarity >= ANCHOR_FUZZY_MIN && (exact.length >= 12 || c.score >= 0.5);
    // ≥ 0.7 when it is at its very place: the 16 characters right before AND
    // right after it are still there (all of a side if it is shorter: the
    // start or the end of the text), ≥ 16 in all. A word inserted in a short
    // quote ("CRA се прилага само ако отговорът" + 11 characters = 0.75).
    const side = (n, len) => n >= Math.min(16, len);
    const placed = found.similarity >= ANCHOR_FUZZY_PLACED && exact.length >= 12 && side(c.before, prefix.length) && side(c.after, suffix.length) && c.intact >= 16;
    if (close || placed) {
      return at({ state: 'fuzzy', start: found.start, end: found.end, similarity: Math.round(found.similarity * 1000) / 1000 });
    }
  }
  // 4. Never dropped.
  return { state: 'orphan' };
}
