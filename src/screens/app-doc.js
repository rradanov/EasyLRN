// A document of the APP in the panel of the reader (T-025): an additional
// topic, an answer of the teacher. Not a lesson: it is the app's own DOM
// (Markdown through src/markdown.js: marked → DOMPurify), never in the lesson
// frame, and the lesson never sees it.
//
// - Marks: src/highlight.js createDocHighlighter (the CSS Custom Highlight API
//   on the app document; the same text model, D-012 selectors and anchoring as
//   in a lesson, src/anchor.js). A topic is a DocRef { type: 'subtopic', id }
//   (D-013); its annotations are on that DocRef.
// - The tools of the bar (D-042): with the marker / the pencil on, one finger
//   (or the mouse, or a pen) drawn over the text marks / underlines what it
//   went over; the eraser takes the marks it touches; two fingers scroll the
//   panel. Without a tool the text selects as usual.
// - The selection (the system's long press): `onSelection({ selector, quote,
//   paragraph, path })` while it is inside this document, else null.
// - Icons next to the lines (📝 a note, 💬 a question, 🌱 a topic) in a gutter
//   at the right edge; a press opens the thing.
import { h, mount } from '../dom.js';
import { createDocHighlighter } from '../highlight.js';
import { anchorDescribeRange } from '../anchor.js';
import { renderMarkdown } from '../markdown.js';

const ICON_STEP_PX = 30; // icons of one line, one under the other
const SAME_LINE_PX = 12;
const BLOCKS = 'p, li, h2, h3, h4, h5, h6, blockquote, td, th, pre';
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The paragraph and the path of headings of a range inside `root` (the app's own text). */
export function rangeContext(root, range) {
  const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const block = start?.closest?.(BLOCKS);
  const paragraph = block && root.contains(block) ? flat(block.textContent) : '';
  const path = [];
  let level = 7;
  const heads = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  for (let i = heads.length - 1; i >= 0; i--) {
    const hd = heads[i];
    // Only headings before the start of the range (not the block itself).
    if (hd === block || !(hd.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const lv = Number(hd.localName.slice(1));
    if (lv < level) { path.unshift(flat(hd.textContent)); level = lv; }
  }
  return { paragraph, path };
}

/**
 * @param {{ kind: 'subtopic'|'message', id: string, getTool?: () => string|null, getColor?: () => string,
 *   onSelection?: (sel: object|null) => void, onStroke?: (stroke: object) => void,
 *   onIcon?: (icon: object) => void, scroller?: () => Element|null, label?: string }} opts
 */
export function createAppDoc({ kind, id, getTool = () => null, getColor = () => 'yellow', onSelection, onStroke, onIcon, scroller = () => null, label = 'Текст' }) {
  const body = h('div', { class: 'app-doc__body md', 'data-field': 'app-doc-text', 'data-doc-type': kind, 'data-doc-id': id });
  const gutter = h('div', { class: 'app-doc__gutter', 'data-field': 'app-doc-icons', 'aria-label': `Бележки и теми: ${label}`, role: 'group' });
  const element = h('div', { class: 'app-doc', 'data-field': 'app-doc' }, body, gutter);
  let hl = createDocHighlighter(body);
  let destroyed = false;
  let icons = []; // [{ annotationId, kind, id, label }]
  let lastSel = null;

  // --- The selection ------------------------------------------------------------------
  const onSelectionChange = () => {
    if (destroyed || getTool()) return;
    const sel = document.getSelection();
    const inside = sel && sel.rangeCount && !sel.isCollapsed && body.contains(sel.getRangeAt(0).commonAncestorContainer);
    if (!inside) {
      if (lastSel) { lastSel = null; onSelection?.(null); }
      return;
    }
    const range = sel.getRangeAt(0);
    let selector = null;
    try { selector = hl.describe(sel); } catch { selector = null; }
    if (!selector?.quote?.exact) return;
    const { paragraph, path } = rangeContext(body, range);
    lastSel = { kind, id, selector, quote: selector.quote.exact, paragraph, path };
    onSelection?.(lastSel);
  };
  document.addEventListener('selectionchange', onSelectionChange);

  // --- The tools (D-042) --------------------------------------------------------------
  let stroke = null; // { id, points: [{x, y}] }
  let pan = null; // two fingers: { ids: Map, y }
  const fingers = new Map();
  const caretAt = (x, y) => {
    const pos = document.caretPositionFromPoint?.(x, y);
    if (pos && body.contains(pos.offsetNode)) return pos;
    const r = document.caretRangeFromPoint?.(x, y);
    return r && body.contains(r.startContainer) ? { offsetNode: r.startContainer, offset: r.startOffset } : null;
  };
  const toolOn = () => ['marker', 'pencil', 'eraser'].includes(getTool());
  const syncTool = () => { element.dataset.tool = toolOn() ? getTool() : 'none'; };
  body.addEventListener('pointerdown', (e) => {
    syncTool();
    if (!toolOn() || !e.isTrusted) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size >= 2) { // two fingers: scroll the panel, no stroke
      stroke = null;
      pan = { y: [...fingers.values()].reduce((s, p) => s + p.y, 0) / fingers.size };
      return;
    }
    e.preventDefault();
    stroke = { id: e.pointerId, points: [{ x: e.clientX, y: e.clientY }] };
    try { body.setPointerCapture(e.pointerId); } catch { /* gone */ }
  });
  body.addEventListener('pointermove', (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pan && fingers.size >= 2) {
      const y = [...fingers.values()].reduce((s, p) => s + p.y, 0) / fingers.size;
      scroller()?.scrollBy(0, pan.y - y);
      pan.y = y;
      return;
    }
    if (!stroke || e.pointerId !== stroke.id) return;
    const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 4) stroke.points.push({ x: e.clientX, y: e.clientY });
  });
  const endStroke = (e) => {
    fingers.delete(e.pointerId);
    if (fingers.size < 2) pan = null;
    if (!stroke || e.pointerId !== stroke.id) return;
    const s = stroke;
    stroke = null;
    if (e.type === 'pointercancel') return;
    const tool = getTool();
    if (tool === 'eraser') {
      const ids = new Set();
      for (const p of s.points) { const hit = hl.hitTest(p.x, p.y, { colored: true }); if (hit) ids.add(hit); }
      if (ids.size) onStroke?.({ tool, ids: [...ids] });
      return;
    }
    if (tool !== 'marker' && tool !== 'pencil') return;
    const a = caretAt(s.points[0].x, s.points[0].y);
    const b = caretAt(s.points[s.points.length - 1].x, s.points[s.points.length - 1].y);
    if (!a || !b) return;
    const range = document.createRange();
    range.setStart(a.offsetNode, a.offset);
    range.setEnd(a.offsetNode, a.offset);
    const order = range.comparePoint(b.offsetNode, b.offset);
    if (order >= 0) range.setEnd(b.offsetNode, b.offset);
    else range.setStart(b.offsetNode, b.offset);
    // Whole words (as in a lesson, T-016): the start back to its word's start, the end on to its word's end.
    const W = /[\p{L}\p{N}\u00AD'’-]/u;
    if (range.startContainer.nodeType === 3) {
      let i = range.startOffset;
      const text = range.startContainer.data;
      while (i > 0 && W.test(text[i - 1])) i--;
      range.setStart(range.startContainer, i);
    }
    if (range.endContainer.nodeType === 3) {
      let j = range.endOffset;
      const text = range.endContainer.data;
      while (j < text.length && W.test(text[j])) j++;
      range.setEnd(range.endContainer, j);
    }
    if (range.collapsed) return;
    let selector = null;
    try { selector = anchorDescribeRange(hl.model(), range); } catch { selector = null; }
    if (selector?.quote?.exact?.trim()) onStroke?.({ tool, selector, style: tool === 'pencil' ? 'underline' : 'highlight', color: getColor() });
  };
  body.addEventListener('pointerup', endStroke);
  body.addEventListener('pointercancel', endStroke);
  body.addEventListener('lostpointercapture', (e) => { if (stroke && e.pointerId === stroke.id) endStroke(e); });

  // --- The icons ---------------------------------------------------------------------
  const ICON = { note: '📝', thread: '💬', topic: '🌱' };
  function placeIcons() {
    if (destroyed) return;
    const top0 = element.getBoundingClientRect().top;
    const rows = [];
    const out = [];
    for (const icon of icons) {
      const range = hl.rangeOf(icon.annotationId);
      const rect = range?.getClientRects?.()[0];
      if (!rect) continue;
      const top = rect.top - top0 + rect.height / 2;
      let row = rows.find((r) => Math.abs(r.top - top) < SAME_LINE_PX);
      if (!row) { row = { top, n: 0 }; rows.push(row); }
      const b = h('button', {
        type: 'button', class: `app-doc__icon app-doc__icon--${icon.kind}`, 'data-icon': icon.kind, 'data-id': icon.id,
        'data-annotation': icon.annotationId, 'aria-label': icon.label, title: icon.label,
      }, h('span', { 'aria-hidden': 'true', text: ICON[icon.kind] || '•' }));
      b.style.top = `${Math.round(row.top + row.n * ICON_STEP_PX - 15)}px`;
      row.n++;
      b.addEventListener('click', () => onIcon?.(icon));
      out.push(b);
    }
    mount(gutter, out);
    element.dataset.icons = String(out.length);
  }
  let observer = null;
  try { observer = new ResizeObserver(() => placeIcons()); observer.observe(body); } catch { /* resize only */ }

  return {
    element,
    body,
    /** The text (Markdown) of the document, drawn again; marks are painted again with `paint`. */
    setMarkdown(md, { headingOffset = 1 } = {}) {
      mount(body, md ? renderMarkdown(md, { headingOffset }) : null);
      hl.invalidate();
    },
    /** Paint the annotations of the document and the icons next to their lines. */
    paint(annotations, nextIcons = []) {
      const results = hl.paint(annotations);
      icons = nextIcons;
      placeIcons();
      syncTool();
      return results;
    },
    placeIcons,
    syncTool,
    /** The selection inside the document now (or the last one, kept for a moment), or null. */
    get selection() { return lastSel; },
    focus(annotationId) { hl.focus(annotationId); },
    rangeOf: (annotationId) => hl.rangeOf(annotationId),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener('selectionchange', onSelectionChange);
      observer?.disconnect();
      hl.destroy();
      hl = null;
    },
  };
}
