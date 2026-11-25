// Highlights (T-015, D-012, ARCHITECTURE §4.4, LESSON-ISOLATION §4.1).
//
// - The colours of the marks: the same five in the app and in the lessons.
//   The lesson follows the SYSTEM theme (T-019: Chromium does not pass a
//   chosen theme into the frame), so it gets both palettes and picks with its
//   own prefers-color-scheme; the app's CSS variables --hl-* are the same values.
// - Lessons are painted by the bridge inside their opaque frame
//   (src/lesson-bridge.js). THIS module paints the app's OWN documents (notes,
//   teacher answers, subtopics: T-017/T-023/T-025) with the CSS Custom
//   Highlight API on the app document, anchored with src/anchor.js — the same
//   text model, selectors and re-anchoring as in a lesson, without any change
//   to their DOM. Several documents share one registry (CSS.highlights is per
//   document): each colour is one Highlight with the ranges of every document.
// - Hit-testing: caretPositionFromPoint → the innermost mark at the point.
import {
  anchorTextModel, anchorDescribeRange, anchorFind, anchorRange, ANCHOR_BASE_EXCLUDE,
} from './anchor.js';

export const HIGHLIGHT_COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink', 'orange']);

/** The palettes sent to a lesson (`lrn:init`); keep in sync with --hl-* in styles/app.css. */
export const HIGHLIGHT_PALETTE = Object.freeze({
  light: Object.freeze({ yellow: '#fff1a8', green: '#cdeccd', blue: '#cfe3f7', pink: '#f8d3e1', orange: '#fbd9b5' }),
  dark: Object.freeze({ yellow: '#5c5216', green: '#2c4a2c', blue: '#23405c', pink: '#5a2a3d', orange: '#5c3a17' }),
});

/**
 * The lines of the pencil (T-015, D-042): strong colours, ≥ 3:1 against the
 * paper of their theme (a line is not text: WCAG 1.4.11); keep in sync with
 * --ul-* in styles/app.css.
 */
export const PENCIL_PALETTE = Object.freeze({
  light: Object.freeze({ yellow: '#8a6d00', green: '#2e7d32', blue: '#1f5fbf', pink: '#c2185b', orange: '#b85200' }),
  dark: Object.freeze({ yellow: '#ffd84d', green: '#6fd17a', blue: '#7fb2ff', pink: '#ff7fbf', orange: '#ffa552' }),
});

/** The order of the colours in the tool bar (D-042). */
export const TOOL_COLORS = Object.freeze(['yellow', 'green', 'blue', 'orange', 'pink']);

/** Default names of the colours (UI-DESIGN §5; the user's names are in the settings). */
export const DEFAULT_COLOR_NAMES = Object.freeze({ yellow: 'Жълт', green: 'Зелен', blue: 'Син', pink: 'Розов', orange: 'Оранжев' });

/**
 * The colours with the names from the settings (`colors: [{id, label}]`):
 * [{ id, name, label }] — `name` is the colour ("Жълт"), `label` its meaning ("Важно") or ''.
 */
export function colorChoices(settings) {
  const labels = new Map((Array.isArray(settings?.colors) ? settings.colors : [])
    .filter((c) => c && HIGHLIGHT_COLORS.includes(c.id) && typeof c.label === 'string')
    .map((c) => [c.id, c.label.trim().slice(0, 40)]));
  return HIGHLIGHT_COLORS.map((id) => ({ id, name: DEFAULT_COLOR_NAMES[id], label: labels.get(id) || '' }));
}

// --- The app's own documents ------------------------------------------------------

const registry = new Map(); // highlighter → { byColor: Map<colour, Range[]>, fuzzy: Range[], focus: Range|null }
const supported = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';

function repaint() {
  if (!supported()) return;
  const all = new Map(HIGHLIGHT_COLORS.map((c) => [c, []]));
  const fuzzy = [];
  const focus = [];
  for (const c of HIGHLIGHT_COLORS) all.set(`ul-${c}`, []); // T-025: the pencil (underline)
  for (const entry of registry.values()) {
    for (const [c, ranges] of entry.byColor) all.get(c).push(...ranges);
    fuzzy.push(...entry.fuzzy);
    if (entry.focus) focus.push(entry.focus);
  }
  for (const [c, ranges] of all) {
    if (ranges.length) CSS.highlights.set(`lrn-app-${c}`, new Highlight(...ranges));
    else CSS.highlights.delete(`lrn-app-${c}`);
  }
  if (fuzzy.length) CSS.highlights.set('lrn-app-fuzzy', new Highlight(...fuzzy)); else CSS.highlights.delete('lrn-app-fuzzy');
  if (focus.length) CSS.highlights.set('lrn-app-focus', new Highlight(...focus)); else CSS.highlights.delete('lrn-app-focus');
}

/**
 * Marks on a document of the app (a container element it rendered itself).
 * @param {Element} root
 * @param {{ exclude?: string }} [opts]
 */
export function createDocHighlighter(root, { exclude = ANCHOR_BASE_EXCLUDE } = {}) {
  let model = null;
  let marks = []; // { id, color, state, start, end, range }
  const self = {};
  const entry = { byColor: new Map(), fuzzy: [], focus: null };
  registry.set(self, entry);
  const textModel = () => (model && model.root === root ? model : (model = anchorTextModel(root, { exclude })));

  const update = () => {
    entry.byColor = new Map([...HIGHLIGHT_COLORS.map((c) => [c, []]), ...HIGHLIGHT_COLORS.map((c) => [`ul-${c}`, []])]);
    entry.fuzzy = [];
    for (const m of marks) {
      if (!m.range || !m.color) continue;
      entry.byColor.get(m.style === 'underline' ? `ul-${m.color}` : m.color).push(m.range);
      if (m.state === 'fuzzy') entry.fuzzy.push(m.range);
    }
    const f = marks.find((m) => m.id === self.focused);
    entry.focus = f?.range ?? null;
    repaint();
  };

  Object.assign(self, {
    focused: null,
    /** Forget the text model (after the document changed). */
    invalidate() { model = null; },
    /** The selectors of a selection inside this document, or null. */
    describe(selection = document.getSelection()) {
      if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return null;
      return anchorDescribeRange(textModel(), range);
    },
    /**
     * Anchor and paint annotations [{ id, color, selector, sameVersion }].
     * @returns {{ id: string, state: 'ok'|'fuzzy'|'orphan', start?: number, end?: number }[]}
     */
    paint(annotations) {
      const m = textModel();
      marks = (Array.isArray(annotations) ? annotations : []).map((a) => {
        const found = anchorFind(m, a.selector, { sameVersion: a.sameVersion === true });
        const range = found.state !== 'orphan' ? anchorRange(m, found.start, found.end) : null;
        return { id: a.id, color: HIGHLIGHT_COLORS.includes(a.color) ? a.color : null, style: a.style === 'underline' ? 'underline' : 'highlight', state: range ? found.state : 'orphan', start: found.start, end: found.end, range };
      });
      update();
      return marks.map(({ id, state, start, end }) => (state === 'orphan' ? { id, state } : { id, state, start, end }));
    },
    /** The live Range of a painted annotation (T-025: the icons next to its line), or null. */
    rangeOf(id) { return marks.find((m) => m.id === id)?.range || null; },
    /** The text model of the document (T-025: a stroke of a tool → selectors). */
    model: () => textModel(),
    /** The id of the innermost mark at a point of the viewport, or null. */
    hitTest(x, y, { colored = false } = {}) {
      const pos = document.caretPositionFromPoint?.(x, y);
      if (!pos) return null;
      let hit = null;
      for (const m of marks) {
        if (!m.range || (colored && !m.color)) continue;
        let inside = false;
        try { inside = m.range.isPointInRange(pos.offsetNode, pos.offset); } catch { inside = false; }
        if (inside && (!hit || m.end - m.start < hit.end - hit.start)) hit = m;
      }
      return hit ? hit.id : null;
    },
    /** Frame (underline) the active mark, or none. */
    focus(id) {
      self.focused = id ?? null;
      update();
    },
    destroy() {
      registry.delete(self);
      repaint();
    },
  });
  return self;
}
