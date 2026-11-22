// The notes of the reader (T-017, D-045): a strip RIGHT of the lesson (the
// marking tools are on the left, D-042).
//
// - Narrow by default: a 📝 next to every line with a note (the place comes
//   from the bridge, `lrn:layout`, frame coordinates; it follows rotation,
//   the text size and the lesson's own scripts because the bridge reports
//   again), "Бележки (N)" opens the list of all notes of the lesson in text
//   order (quote + text; a tap scrolls to the place and opens the note),
//   ▲ / ▼ go to the previous / next note (the lesson scrolls, the note opens).
// - A note opens in a panel: on the right side of the window (a tablet, ≥ 600
//   px) or over the whole window under the app bar (a phone, < 600 px: the
//   field stays above the keyboard, `visualViewport`). Not a bottom sheet: the
//   bottom of the screen is Google's "Докосване за търсене" while text is
//   selected (D-045).
// - A new note: with no tool on, the user selects text in the lesson (the
//   system selection, long press); "📝 Бележка" appears at the top of the
//   strip (and next to the handle when the strip is hidden). Pressed: the note
//   for that place opens — the one already there (one note per place, D-045:
//   the same or an overlapping place), else a new one (on the mark at exactly
//   that place, or on a new annotation without a colour). The text is saved by
//   itself (about 1 s after the last key, and when the note closes); an empty
//   new note is not saved. "Въпрос" (T-023) and "Развий ми го" (T-025) come
//   into SELECTION_ACTIONS below when they are ready; until then they are not
//   shown.
// - A tap on a mark without a tool (`lrn:tap`): its note, or a small card with
//   "📝 Добави бележка".
// - Deleting: "Изтрий" in the note; "Върни" brings it back for a few seconds.
//   The eraser never deletes a note (src/screens/mark-tools.js).
// - Notes whose text is no longer found exactly: "⚠ провери" (found
//   approximately: "Да, тук е" confirms the place) and "Неприкачени" (not
//   found) — at the end of the list, never lost; "Бележки (N)" shows ⚠.
// - A narrow window (< 600 px) starts with the strip hidden behind a handle
//   "☰" at the right edge, like the tool bar; the choice is kept
//   (`notesStrip.hidden`).
// - Security: the lesson is untrusted. What it sends is checked in
//   lesson-frame.js (known ids only, numbers only); a selection or a tap from
//   the lesson can only SHOW a button or a note of the user — nothing is
//   created, changed or deleted without the user's own press in the app. The
//   text of a note is shown only here (textContent / src/markdown.js) and is
//   never posted to the lesson.
import { h, mount } from '../dom.js';
import { saveSettings, COLORS } from '../db.js';
import { renderMarkdown } from '../markdown.js';
import { confirmAnnotationPlace } from '../annotations.js';
import {
  lessonNotes, saveNote, deleteNote, restoreNote, noteAtSelection, markAtSelection, MAX_NOTE_LENGTH,
  keepPendingNote, dropPendingNote,
} from '../notes.js';

const NARROW_PX = 600; // below this the strip starts hidden and a note fills the window
const SAVE_MS = 1000;
const UNDO_MS = 8000;
const SELECTION_GRACE_MS = 700; // the button stays this long after the selection went (a tap on it may clear it)
const FOCUS_MS = 5000;
const SAME_LINE_PX = 14; // notes closer than this share one 📝 (with a number)
const QUOTE_MAX = 200;
const LIST_BODY_MAX = 2000; // T018-D13: the list shows this much of a note (a 1 MB body from a backup froze it)
const SWITCH_GUARD_MS = 350; // T018-D11: as the tool bar (T066-D4): a press this soon after the strip was shown / hidden…
const SWITCH_NEAR_PX = 64; // …this near the press that switched it is the rest of a double tap
const USER_MOVE_MS = 400; // T018-D2: a blur of the note field this soon after a press / Tab of the user is the user's

/**
 * Buttons for a selection (D-045). Only "Бележка" now; "Въпрос" (T-023) and
 * "Развий ми го" (T-025) are added here when they exist (`ready: false` keeps
 * them out of the strip).
 */
export const SELECTION_ACTIONS = Object.freeze([
  { id: 'note', label: 'Бележка', icon: '📝', ready: true },
  { id: 'question', label: 'Въпрос', icon: '💬', ready: false }, // T-023
  { id: 'expand', label: 'Развий ми го', icon: '✨', ready: false }, // T-025
]);

const narrowScreen = () => (window.innerWidth || document.documentElement.clientWidth) < NARROW_PX;
const short = (text, max = QUOTE_MAX) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const quoted = (text, max) => `«${short(text, max)}»`;

/** The stored choice: true / false when the user chose, null when not yet (→ by the width). */
export function stripChoice(settings) {
  const s = settings?.notesStrip && typeof settings.notesStrip === 'object' ? settings.notesStrip : {};
  return { hidden: typeof s.hidden === 'boolean' ? s.hidden : null };
}

/**
 * @param {{ getFrame: () => object|null, getTool: () => string|null, course: object, lesson: object,
 *   settings: object, announce: (text: string) => void, onLayout?: (hidden: boolean) => void }} opts
 */
export function createNotesStrip({ getFrame, getTool = () => null, course, lesson, settings, announce, onLayout }) {
  let hidden = stripChoice(settings).hidden ?? narrowScreen();
  // T018-D14: until the user chooses (here or before: `notesStrip.hidden`), the
  // strip follows the width of the window — also when it becomes narrow after
  // the reader opened (rotation, split screen on Android).
  let chosen = stripChoice(settings).hidden !== null;
  let destroyed = false;
  let notes = []; // [{ note, annotation }] of this lesson (live ones)
  let places = new Map(); // annotation id → { top, bottom } (frame coordinates, lrn:layout)
  let selection = null; // the last selection of the lesson (checked), for "Бележка"
  let selectionTimer = 0;
  let pressingUntil = 0;

  // T018-D11: the strip shown / hidden at a press: for 350 ms another press
  // within 64 px of it is the second tap of a double tap (it would land on
  // "» Скрий" / "☰", now under the finger) and is ignored. A press elsewhere,
  // and a switch from the keyboard (no press), act at once.
  let switchedAt = -Infinity;
  let switchedFrom = null; // { x, y } of the press that switched the strip, or null
  let lastPress = null; // { x, y, t } of the last pointer press anywhere
  let lastUserMove = -Infinity; // T018-D2: a press in the app or a focus key (Tab, Escape, F6) of the user
  const onAnyPress = (e) => {
    if (!e.isTrusted) return;
    lastUserMove = performance.now();
    if (e.isPrimary) lastPress = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onFocusKey = (e) => { if (e.isTrusted && (e.key === 'Tab' || e.key === 'Escape' || e.key === 'F6')) lastUserMove = performance.now(); };
  window.addEventListener('pointerdown', onAnyPress, true);
  window.addEventListener('keydown', onFocusKey, true);
  // T018-D2: the page focus went into the lesson (the window blurs while the
  // document still has the focus: a child frame has it) while the note field is
  // guarded and the user did not press anything since: taken back at once.
  const onWindowBlur = () => {
    const ed = editing;
    if (!ed || !guarded || destroyed) return;
    if (lastUserMove > (ed.focusedAt ?? 0) && performance.now() - lastUserMove < USER_MOVE_MS) return;
    queueMicrotask(() => { if (document.hasFocus()) reclaimFocus(ed); });
  };
  window.addEventListener('blur', onWindowBlur);
  const ghost = (e) => switchedFrom !== null && performance.now() - switchedAt < SWITCH_GUARD_MS
    && Math.hypot(e.clientX - switchedFrom.x, e.clientY - switchedFrom.y) <= SWITCH_NEAR_PX;

  // A finger / pen acts on pointerup (a tap right after a selection may lose its
  // click on Android), the mouse and the keyboard through click; one action per press.
  function press(button, action) {
    let down = null;
    let tappedAt = -Infinity;
    button.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      if (ghost(e)) { down = null; return; }
      down = e.pointerId;
      pressingUntil = performance.now() + 1500;
    });
    button.addEventListener('pointercancel', () => { down = null; });
    // The click Chrome makes from a tap would land on whatever is under the
    // finger AFTER the action (the strip shown, the panel closed: another
    // button, the lesson): no click from a touch at all, the tap acts on pointerup.
    button.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    button.addEventListener('pointerup', (e) => {
      if (down !== e.pointerId) return;
      down = null;
      const r = button.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom || button.disabled) return;
      tappedAt = performance.now();
      action(e);
    });
    button.addEventListener('click', (e) => {
      if (e.detail !== 0 && (performance.now() - tappedAt < 700 || ghost(e))) return;
      action(e);
    });
    return button;
  }
  const button = (props, ...children) => h('button', { type: 'button', ...props }, ...children);

  // --- The strip ---------------------------------------------------------------------
  const noteButton = press(button({
    class: 'notes-strip__button notes-strip__new', 'data-action': 'new-note', hidden: true,
    'aria-label': 'Бележка към избрания текст', title: 'Бележка към избрания текст',
  }, h('span', { 'aria-hidden': 'true', class: 'notes-strip__icon', text: '📝' }), h('span', { class: 'notes-strip__label', 'aria-hidden': 'true', text: 'Бележка' })), () => newFromSelection());
  const listCount = h('span', { class: 'notes-strip__count', 'data-field': 'notes-count', text: '0' });
  const listWarn = h('span', { class: 'notes-strip__warn', 'aria-hidden': 'true', hidden: true, text: '⚠' });
  const listButton = press(button({
    class: 'notes-strip__button notes-strip__list', 'data-action': 'notes-list', 'aria-expanded': 'false', 'aria-controls': 'notes-panel',
    'aria-label': 'Всички бележки', title: 'Всички бележки на урока',
  }, h('span', { 'aria-hidden': 'true', class: 'notes-strip__icon', text: '☷' }), listCount, listWarn), () => (panelMode === 'list' ? closePanel() : openList()));
  const prevButton = press(button({
    class: 'notes-strip__button notes-strip__step', 'data-action': 'prev-note', 'aria-label': 'Предишна бележка', title: 'Предишна бележка',
  }, h('span', { 'aria-hidden': 'true', text: '▲' })), () => step(-1));
  const nextButton = press(button({
    class: 'notes-strip__button notes-strip__step', 'data-action': 'next-note', 'aria-label': 'Следваща бележка', title: 'Следваща бележка',
  }, h('span', { 'aria-hidden': 'true', text: '▼' })), () => step(1));
  const hideButton = press(button({
    class: 'notes-strip__button notes-strip__hide', 'data-action': 'hide-notes', 'aria-expanded': 'true', 'aria-controls': 'notes-strip',
    'aria-label': 'Скрий бележките', title: 'Скрий бележките',
  }, h('span', { 'aria-hidden': 'true', text: '»' }), h('span', { class: 'notes-strip__label', 'aria-hidden': 'true', text: 'Скрий' })), () => setHidden(true, { focus: true }));
  const bar = h('div', { class: 'notes-strip__bar', role: 'toolbar', 'aria-label': 'Бележки', 'aria-orientation': 'vertical' },
    hideButton, noteButton, listButton, prevButton, nextButton);
  const marks = h('div', { class: 'notes-strip__marks', 'data-field': 'notes-marks' });
  const element = h('div', { class: 'notes-strip', id: 'notes-strip', 'data-field': 'notes-strip' }, bar, marks);

  // Hidden: the handle "☰" at the right edge and, while text is selected, "📝 Бележка" next to it.
  const handle = press(button({
    class: 'notes-strip-handle', 'data-action': 'show-notes', 'data-field': 'notes-strip-handle',
    'aria-label': 'Покажи бележките', title: 'Покажи бележките', 'aria-expanded': 'false', 'aria-controls': 'notes-strip',
  }, h('span', { 'aria-hidden': 'true', text: '☰' }), h('span', { class: 'notes-strip-handle__count', 'aria-hidden': 'true' })), () => setHidden(false, { focus: true }));
  const quickNote = press(button({
    class: 'notes-strip-quick', 'data-action': 'new-note-quick', hidden: true,
    'aria-label': 'Бележка към избрания текст', title: 'Бележка към избрания текст',
  }, h('span', { 'aria-hidden': 'true', text: '📝' }), h('span', { class: 'notes-strip-quick__label', text: 'Бележка' })), () => newFromSelection());
  const handleBox = h('div', { class: 'notes-strip-handle-box' }, handle, quickNote);
  const slot = h('div', { class: 'reader__notes', 'data-field': 'reader-notes' }, handleBox, element);

  // Keyboard: one stop for the strip, arrows move inside (a toolbar).
  const stripButtons = () => [...bar.querySelectorAll('button')].filter((b) => !b.hidden && !b.disabled);
  const rove = (target) => { for (const b of bar.querySelectorAll('button')) b.tabIndex = b === target ? 0 : -1; };
  bar.addEventListener('keydown', (event) => {
    const list = stripButtons();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const b = list[(next + list.length) % list.length];
    rove(b);
    b.focus();
  });
  bar.addEventListener('focusin', (event) => { if (event.target instanceof HTMLButtonElement) rove(event.target); });
  const fixRove = () => { if (!bar.querySelector('button[tabindex="0"]:not([hidden])')) rove(stripButtons()[0] || hideButton); };

  function setHidden(next, { focus = false, save = true } = {}) {
    if (!!next !== hidden || element.hidden !== !!next) {
      switchedAt = performance.now();
      switchedFrom = lastPress && switchedAt - lastPress.t < 1000 ? { x: lastPress.x, y: lastPress.y } : null;
    }
    if (save) chosen = true;
    hidden = !!next;
    element.hidden = hidden;
    handleBox.hidden = !hidden;
    hideButton.setAttribute('aria-expanded', String(!hidden));
    handle.setAttribute('aria-expanded', String(!hidden));
    slot.dataset.hidden = String(hidden);
    if (save) saveSettings({ notesStrip: { hidden } }).catch((err) => console.warn('Cannot save the notes strip:', err?.name || err));
    showSelectionButtons();
    if (!hidden) queuePlace();
    if (panelMode) fitViewport();
    if (focus) (hidden ? handle : (bar.querySelector('button[tabindex="0"]:not([hidden])') || hideButton)).focus();
    if (save) announce(hidden ? 'Бележките са скрити.' : 'Бележките са показани.');
    onLayout?.(hidden);
  }

  // --- Order and places ---------------------------------------------------------------
  const startOf = (a) => (Number.isInteger(a.anchoredStart) ? a.anchoredStart : a.selector?.position?.start ?? 0);
  const stateOf = (a) => (a.anchorState === 'fuzzy' || a.anchorState === 'orphan' ? a.anchorState : 'ok');
  /** Live annotations from the frame (their last anchoring), else the stored ones. */
  const withAnchoring = () => {
    const frame = getFrame();
    const live = new Map((frame?.annotations || []).map((a) => [a.id, a]));
    return notes.map((item) => ({ note: item.note, annotation: live.get(item.annotation.id) || item.annotation }));
  };
  const ordered = () => {
    const list = withAnchoring();
    const placed = list.filter((x) => stateOf(x.annotation) !== 'orphan').sort((a, b) => startOf(a.annotation) - startOf(b.annotation));
    const orphans = list.filter((x) => stateOf(x.annotation) === 'orphan');
    return { placed, orphans, all: [...placed, ...orphans] };
  };
  const topOf = (item) => {
    const p = places.get(item.annotation.id);
    if (p) return p.top;
    return Number.isFinite(item.annotation.anchoredTop) ? item.annotation.anchoredTop : null;
  };
  /** The middle of the first line of a place (a place of several lines: about one line). */
  const lineMiddle = (item) => {
    const p = places.get(item.annotation.id) || { top: item.annotation.anchoredTop, bottom: item.annotation.anchoredBottom };
    if (!Number.isFinite(p.top)) return null;
    const height = Number.isFinite(p.bottom) ? Math.max(0, p.bottom - p.top) : 0;
    return p.top + Math.min(height, 40) / 2;
  };

  // The 📝 next to the lines: positions relative to the strip (the frame's top is the origin of the places).
  let placeQueued = 0;
  const queuePlace = () => {
    if (placeQueued || destroyed) return;
    placeQueued = requestAnimationFrame(() => { placeQueued = 0; placeMarks(); });
  };
  function placeMarks() {
    if (destroyed) return;
    const frame = getFrame();
    const f = frame?.frame;
    if (hidden || !f || frame.innerScroll || !f.isConnected) { mount(marks); return; }
    const fr = f.getBoundingClientRect();
    const offset = fr.top - marks.getBoundingClientRect().top;
    const rows = [];
    for (const item of ordered().placed) {
      const top = lineMiddle(item);
      // T018-D1: a place the lesson reports below its own frame is not drawn (it would make the page that tall).
      if (top === null || top > fr.height + 1) continue;
      const row = rows.find((r) => Math.abs(r.top - top) < SAME_LINE_PX);
      if (row) row.items.push(item);
      else rows.push({ top, items: [item] });
    }
    mount(marks, rows.map((row) => {
      const first = row.items[0];
      const label = row.items.length > 1
        ? `${row.items.length} бележки на този ред: ${quoted(first.annotation.selector?.quote?.exact, 60)}`
        : `Бележка: ${quoted(first.annotation.selector?.quote?.exact, 60)}`;
      const b = press(button({
        class: 'notes-strip__mark', 'data-note': first.note.id, 'data-annotation': first.annotation.id,
        'data-state': stateOf(first.annotation), 'aria-label': label, title: label, tabindex: '-1',
      }, h('span', { 'aria-hidden': 'true', text: '📝' }), row.items.length > 1 ? h('span', { class: 'notes-strip__mark-count', 'aria-hidden': 'true', text: String(row.items.length) }) : null),
      () => openNote(first.note.id, { from: b }));
      b.style.top = `${Math.round(offset + row.top)}px`;
      return b;
    }));
  }

  // --- The panel (a note, the list, a mark) ------------------------------------------
  const panelTitle = h('h2', { class: 'notes-panel__title', id: 'notes-panel-title', tabindex: '-1' });
  const closeButton = press(button({ class: 'notes-panel__close', 'data-action': 'close-notes-panel', 'aria-label': 'Затвори', title: 'Затвори (Esc)' }, '✕'), () => closePanel({ focus: true }));
  const panelBody = h('div', { class: 'notes-panel__body' });
  const panel = h('section', {
    class: 'notes-panel', id: 'notes-panel', 'data-field': 'notes-panel', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': 'notes-panel-title', hidden: true,
  }, h('header', { class: 'notes-panel__head' }, panelTitle,
    press(button({ class: 'notes-panel__step', 'data-action': 'panel-prev-note', 'aria-label': 'Предишна бележка', title: 'Предишна бележка' }, '▲'), () => step(-1)),
    press(button({ class: 'notes-panel__step', 'data-action': 'panel-next-note', 'aria-label': 'Следваща бележка', title: 'Следваща бележка' }, '▼'), () => step(1)),
    closeButton), panelBody);
  const undoText = h('span', { class: 'notes-undo__text' });
  const undoButton = press(button({ class: 'button notes-undo__button', 'data-action': 'undo-note-delete' }, 'Върни'), () => runUndo());
  const toast = h('div', { class: 'notes-undo', 'data-field': 'notes-undo', role: 'status', hidden: true }, undoText, undoButton);

  let panelMode = null; // null | 'note' | 'list' | 'mark'
  let returnFocus = null;
  let editing = null; // { draft, quote, textarea, status, dirty, timer, saving: Promise, annotationId, noteId }
  const setMode = (mode) => {
    panelMode = mode;
    panel.hidden = !mode;
    panel.dataset.mode = mode || 'none';
    listButton.setAttribute('aria-expanded', String(mode === 'list'));
    slot.dataset.panel = mode || 'none';
    fitViewport();
  };
  // Where the panel goes: on a phone over the whole window; else right of the
  // strip when there is room (a wide window: nothing of the lesson is covered),
  // or left of it, over the right part of the lesson — the strip (▲ / ▼, the
  // list) stays reachable either way. A phone keyboard: the panel ends above it.
  const fitViewport = () => {
    if (panel.hidden) { panel.style.removeProperty('--notes-vv-bottom'); return; }
    const full = narrowScreen();
    panel.dataset.layout = full ? 'full' : 'side';
    panel.style.left = '';
    panel.style.right = '';
    panel.style.width = '';
    if (!full) {
      const r = (hidden ? handleBox : element).getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const free = vw - r.right;
      if (free >= 340) {
        panel.style.left = `${Math.round(r.right)}px`;
        panel.style.right = '0px';
        panel.style.width = 'auto';
      } else {
        panel.style.right = `${Math.max(0, Math.round(vw - r.left))}px`;
        panel.style.width = `${Math.max(260, Math.min(400, Math.round(r.left) - 8))}px`;
      }
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    panel.style.setProperty('--notes-vv-bottom', `${Math.round(covered)}px`);
  };

  function closePanel({ focus = false } = {}) {
    if (!panelMode) return Promise.resolve();
    const was = editing;
    editing = null;
    const done = was ? finishEditing(was) : Promise.resolve();
    // T018-D12: whether the focus was in the panel is known only before it is emptied.
    const hadFocus = panel.contains(document.activeElement);
    setMode(null);
    mount(panelBody);
    unguardFrame();
    const back = returnFocus;
    returnFocus = null;
    if (focus || hadFocus) {
      (back?.isConnected && !back.hidden ? back : (hidden ? handle : listButton)).focus({ preventScroll: true });
    }
    getFrame()?.focus(null);
    return done;
  }

  const stateBadge = (a) => {
    const s = stateOf(a);
    if (s === 'fuzzy') return h('span', { class: 'notes-badge notes-badge--fuzzy', 'data-state': 'fuzzy', text: '⚠ провери' });
    if (s === 'orphan') return h('span', { class: 'notes-badge notes-badge--orphan', 'data-state': 'orphan', text: 'неприкачена' });
    return null;
  };

  let focusTimer = 0;
  /** Scroll the lesson to an annotation and frame it for a while. */
  function showPlace(annotationId) {
    const frame = getFrame();
    if (!frame?.scrollToAnnotation(annotationId)) return false;
    frame.focus(annotationId);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => getFrame()?.focus(null), FOCUS_MS);
    return true;
  }

  /** Open the editor of a note (or of a draft). */
  async function openEditor({ draft, quote, annotation = null, body = '', focusText = false, from = null }) {
    const active = document.activeElement;
    const fromPanel = panel.contains(active);
    await closePanel();
    if (destroyed) return;
    // T018-D12: back to where the user was; an item of the list (gone with it) → the list button.
    returnFocus = from || (fromPanel || !active || active === document.body || !active.isConnected ? (hidden ? handle : listButton) : active);
    const textarea = h('textarea', {
      class: 'notes-panel__text', 'data-field': 'note-text', rows: '8', maxlength: String(MAX_NOTE_LENGTH),
      'aria-label': 'Текст на бележката', placeholder: 'Напиши бележката си… (Markdown: **удебелен**, - списък)',
    });
    // T018-D13: a body longer than the field keeps (an old backup) is shown up to
    // the limit (a 1 MB word froze the field); the database keeps it all until it is edited.
    const tooLong = String(body).length > MAX_NOTE_LENGTH;
    textarea.value = tooLong ? String(body).slice(0, MAX_NOTE_LENGTH) : body;
    const status = h('p', { class: 'notes-panel__status', 'data-field': 'note-status', role: 'status', 'aria-live': 'polite' });
    const ed = {
      draft, quote, textarea, status, dirty: false, timer: 0, saving: Promise.resolve(),
      annotationId: annotation?.id || draft.annotationId || null, noteId: draft.noteId || null,
      savedBody: String(body).slice(0, MAX_NOTE_LENGTH), // what the database has (T018-D3; a longer body: its start)
    };
    editing = ed;
    textarea.addEventListener('input', () => {
      ed.dirty = true;
      // T018-I5: the field keeps MAX_NOTE_LENGTH characters; say so instead of cutting silently.
      status.textContent = textarea.value.length >= MAX_NOTE_LENGTH ? `Бележката е до ${MAX_NOTE_LENGTH.toLocaleString('bg-BG')} знака; останалото не се пази.` : 'Пиша…';
      clearTimeout(ed.timer);
      ed.timer = setTimeout(() => { save(ed); }, SAVE_MS);
    });
    // T018-D2: while the user is in the field, the lesson cannot take the focus:
    // focus moved into the frame without the user (no press of the user reaches
    // the frame then: a layer of the app lies over it) goes straight back to the
    // field, before a key can follow. A tap on the lesson leaves the field (the
    // layer goes) and the lesson is live again.
    textarea.addEventListener('focus', () => { ed.focusedAt = performance.now(); if (editing === ed) guardFrame(); });
    textarea.addEventListener('blur', () => {
      if (ed.reclaiming) return;
      // The user's own move (a press in the app, Tab / Escape / F6, since the field got the focus) — or a steal.
      const own = !guarded || (lastUserMove > (ed.focusedAt ?? 0) && performance.now() - lastUserMove < USER_MOVE_MS);
      const back = () => {
        if (editing !== ed || !guarded) return;
        const at = document.activeElement;
        if (at === textarea || (at !== guarded.frame && at !== document.body && at !== null)) return;
        reclaimFocus(ed);
      };
      if (own) { queueMicrotask(() => { if (document.activeElement !== textarea) unguardFrame(); }); return; }
      queueMicrotask(back);
      setTimeout(back, 0);
    });
    // Escape in the field closes the note (saved first); the field keeps every other key.
    textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel({ focus: true }); } });
    const showButton = annotation && stateOf(annotation) !== 'orphan'
      ? press(button({ class: 'button notes-panel__show', 'data-action': 'show-note-place' }, 'Покажи мястото'), () => showPlace(annotation.id)) : null;
    const confirmButton = annotation && stateOf(annotation) === 'fuzzy'
      ? press(button({ class: 'button', 'data-action': 'confirm-note-place' }, 'Да, тук е'), () => confirmPlace(annotation)) : null;
    const deleteButton = press(button({ class: 'button notes-panel__delete', 'data-action': 'delete-note', hidden: !ed.noteId }, 'Изтрий'), () => removeNote(ed));
    ed.deleteButton = deleteButton;
    const doneButton = press(button({ class: 'button button--primary', 'data-action': 'note-done' }, 'Готово'), () => closePanel({ focus: true }));
    const toList = press(button({ class: 'notes-panel__back', 'data-action': 'notes-back-to-list' }, '← Всички бележки'), () => openList());
    const hintText = annotation && stateOf(annotation) === 'orphan'
      ? 'Текстът на урока се е променил и това място не е намерено. Бележката е запазена; цитатът е от старата версия.'
      : annotation && stateOf(annotation) === 'fuzzy'
        ? 'Текстът на урока се е променил; мястото е намерено приблизително. Провери го („Покажи мястото“) и потвърди.'
        : '';
    setMode('note');
    panelTitle.textContent = ed.noteId ? 'Бележка' : 'Нова бележка';
    mount(panelBody,
      toList,
      h('blockquote', { class: 'notes-panel__quote', 'data-field': 'note-quote' }, quoted(quote, 400)),
      annotation ? stateBadge(annotation) : null,
      hintText ? h('p', { class: 'notes-panel__hint', text: hintText }) : null,
      tooLong ? h('p', { class: 'notes-panel__hint', 'data-field': 'note-too-long', text: `Бележката е по-дълга от ${MAX_NOTE_LENGTH.toLocaleString('bg-BG')} знака (напр. от резервно копие). Показано е началото; ако я промениш, ще се запази само то.` }) : null,
      // T-041: the 🎤 comes next to this field (dictation of the keyboard works already).
      textarea,
      status,
      h('div', { class: 'notes-panel__actions' }, doneButton, showButton, confirmButton, deleteButton));
    if (focusText) textarea.focus({ preventScroll: true });
    else panelTitle.focus({ preventScroll: true });
  }

  /** Save the text of the note now (the timer, or the note closes). */
  function save(ed) {
    clearTimeout(ed.timer);
    ed.timer = 0;
    if (!ed.dirty) return ed.saving;
    ed.dirty = false;
    const body = ed.textarea.value.slice(0, MAX_NOTE_LENGTH);
    const since = Date.now();
    ed.saving = ed.saving.then(async () => {
      // A new note is created only when it has text; an empty one is not kept.
      if (!ed.noteId && !body.trim()) { ed.status.textContent = ''; return; }
      if (ed.noteId && !body.trim()) { ed.status.textContent = 'Празна бележка: ще бъде изтрита, ако я затвориш така.'; return; }
      ed.status.textContent = 'Записвам…';
      const draft = ed.noteId ? { noteId: ed.noteId } : ed.draft;
      const { note, annotation, createdAnnotation, revived } = await saveNote({ course, lesson, draft, body });
      ed.noteId = note.id;
      ed.annotationId = annotation.id;
      ed.savedBody = body;
      dropPendingNote({ body, since });
      if (ed.deleteButton) ed.deleteButton.hidden = false;
      if (editing === ed) panelTitle.textContent = 'Бележка';
      // T018-D10: deleted meanwhile (another tab): it is back, with what was typed here.
      ed.status.textContent = revived ? 'Записано. Бележката беше изтрита (в друг раздел) и е върната.' : 'Записано.';
      if (revived) announce('Бележката беше изтрита в друг раздел; върната е с написаното.');
      if (createdAnnotation) await getFrame()?.reloadAnnotations();
      await reload();
    }).catch((err) => {
      console.warn('Cannot save the note:', err?.message || err);
      ed.dirty = true;
      ed.status.textContent = 'Бележката не можа да се запише. Опитай пак.';
      announce('Бележката не можа да се запише.');
    });
    return ed.saving;
  }

  /** The note closes: write what is left; an existing note left empty is deleted (with "Върни"). */
  async function finishEditing(ed) {
    await save(ed);
    if (ed.noteId && !ed.textarea.value.trim()) await removeNote(ed, { empty: true });
  }

  let undoEntry = null;
  let undoTimer = 0;
  async function removeNote(ed, { empty = false } = {}) {
    clearTimeout(ed.timer);
    ed.dirty = false;
    await ed.saving;
    if (!ed.noteId) return;
    try {
      const entry = await deleteNote(lesson, ed.noteId);
      ed.noteId = null;
      if (entry.annotationDeleted) await getFrame()?.reloadAnnotations();
      await reload();
      if (editing === ed) { editing = null; await closePanel({ focus: true }); }
      undoEntry = entry;
      undoText.textContent = empty ? 'Празната бележка е изтрита.' : 'Бележката е изтрита.';
      toast.hidden = false;
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => { toast.hidden = true; undoEntry = null; }, UNDO_MS);
      announce(`${undoText.textContent} „Върни“ я връща.`);
    } catch (err) {
      console.warn('Cannot delete the note:', err?.message || err);
      announce('Бележката не можа да се изтрие.');
    }
  }
  async function runUndo() {
    const entry = undoEntry;
    undoEntry = null;
    clearTimeout(undoTimer);
    toast.hidden = true;
    if (!entry) return;
    try {
      const { annotationRestored } = await restoreNote(lesson, entry);
      if (annotationRestored) await getFrame()?.reloadAnnotations();
      await reload();
      announce('Бележката е върната.');
      openNote(entry.noteId);
    } catch (err) {
      console.warn('Cannot restore the note:', err?.message || err);
      announce('Бележката не можа да се върне.');
    }
  }

  async function confirmPlace(annotation) {
    const frame = getFrame();
    const described = await frame?.describe(annotation.id);
    if (!described) { announce('Мястото не може да се потвърди сега. Отвори урока отново.'); return; }
    try {
      await confirmAnnotationPlace(lesson, annotation.id, described);
      await frame.reloadAnnotations();
      await reload();
      announce('Мястото е потвърдено.');
      const item = notes.find((x) => x.annotation.id === annotation.id);
      if (item && panelMode === 'note') openNote(item.note.id);
    } catch (err) {
      console.warn('Cannot confirm the place:', err?.message || err);
      announce('Мястото не можа да се запише.');
    }
  }

  /** Open a saved note (its place is framed in the lesson, no scrolling unless asked). */
  function openNote(noteId, { from = null, scroll = false } = {}) {
    const item = withAnchoring().find((x) => x.note.id === noteId);
    if (!item) return Promise.resolve();
    if (scroll) showPlace(item.annotation.id);
    else getFrame()?.focus(item.annotation.id);
    return openEditor({
      draft: { noteId }, quote: item.annotation.selector?.quote?.exact, annotation: item.annotation, body: item.note.body || '', from,
    }).then(() => { if (!scroll) getFrame()?.focus(item.annotation.id); });
  }

  const listBody = (body) => {
    const text = String(body || '');
    return text.length > LIST_BODY_MAX ? `${text.slice(0, LIST_BODY_MAX)}…` : text;
  };
  async function openList() {
    const from = document.activeElement;
    await closePanel();
    returnFocus = from === document.body ? listButton : from;
    const { placed, orphans, all } = ordered();
    const item = (x) => h('li', { class: 'notes-list__item', 'data-note': x.note.id, 'data-state': stateOf(x.annotation) },
      press(button({ class: 'notes-list__open', 'data-action': 'open-note' },
        h('span', { class: 'notes-list__quote', text: quoted(x.annotation.selector?.quote?.exact, 160) }),
        stateBadge(x.annotation)),
      () => openNote(x.note.id, { scroll: stateOf(x.annotation) !== 'orphan' })),
      h('div', { class: 'notes-list__body md' }, renderMarkdown(listBody(x.note.body), { headingOffset: 3 })));
    setMode('list');
    panelTitle.textContent = `Бележки (${all.length})`;
    mount(panelBody,
      all.length ? null : h('p', { class: 'notes-panel__hint', 'data-field': 'notes-empty', text: 'Още няма бележки. Задръж пръста върху текста на урока и натисни „📝 Бележка“ вдясно.' }),
      placed.length ? h('ol', { class: 'notes-list', 'data-field': 'notes-list' }, placed.map(item)) : null,
      orphans.length ? h('section', { class: 'notes-list__orphans', 'data-field': 'notes-orphans' },
        h('h3', { class: 'notes-list__heading', text: `Неприкачени (${orphans.length})` }),
        h('p', { class: 'notes-panel__hint', text: 'Текстът на урока се е променил и тези места не са намерени. Бележките са запазени; цитатът е от старата версия.' }),
        h('ul', { class: 'notes-list' }, orphans.map(item))) : null);
    panelTitle.focus({ preventScroll: true });
  }

  /** The small card of a mark without a note (a tap on it). */
  async function openMarkCard(annotation) {
    const from = document.activeElement;
    await closePanel();
    returnFocus = from;
    setMode('mark');
    panelTitle.textContent = 'Маркировка';
    getFrame()?.focus(annotation.id);
    const add = press(button({ class: 'button button--primary', 'data-action': 'add-note-to-mark' }, '📝 Добави бележка'), () => openEditor({
      draft: { annotationId: annotation.id }, quote: annotation.selector?.quote?.exact, annotation, focusText: true,
    }));
    mount(panelBody,
      h('blockquote', { class: 'notes-panel__quote', 'data-field': 'note-quote' }, quoted(annotation.selector?.quote?.exact, 400)),
      // T-023 / T-025: "Въпрос" and "Развий ми го" come next to it.
      h('div', { class: 'notes-panel__actions' }, add));
    add.focus({ preventScroll: true });
  }

  // --- A new note from the selection ------------------------------------------------
  function showSelectionButtons() {
    const on = Boolean(selection) && !getTool();
    noteButton.hidden = !on || hidden;
    quickNote.hidden = !on || !hidden;
    handle.dataset.attention = String(on && hidden);
    slot.dataset.selection = String(on);
    fixRove();
  }
  async function newFromSelection() {
    const sel = selection;
    if (!sel) return;
    selection = null;
    clearTimeout(selectionTimer);
    showSelectionButtons();
    const frame = getFrame();
    if (sel.excludedOnly || !sel.position) {
      frame?.clearSelection();
      announce('Тук не може да се закачи бележка: тази част на урока (тест или бележка на автора) не се маркира.');
      return;
    }
    frame?.clearSelection();
    // One note per place (D-045): a note at this place (the same or overlapping) opens for more text.
    const there = noteAtSelection(sel, withAnchoring());
    if (there) {
      announce('Тук вече има бележка: допиши я.');
      await openNote(there.note.id);
      editing?.textarea.focus({ preventScroll: true });
      return;
    }
    const mark = markAtSelection(sel, frame?.annotations || []);
    await openEditor({
      draft: mark ? { annotationId: mark.id } : { selection: sel },
      quote: sel.quote.exact, annotation: mark, focusText: true, from: hidden ? handle : listButton,
    });
  }

  // --- Keys ------------------------------------------------------------------------------
  const onKey = (event) => {
    if (destroyed || event.defaultPrevented || event.key !== 'Escape' || !panelMode || getTool()) return;
    event.preventDefault();
    closePanel({ focus: true });
  };
  document.addEventListener('keydown', onKey);

  // --- ▲ / ▼ ------------------------------------------------------------------------------
  function step(dir) {
    const list = ordered().placed.filter((x) => topOf(x) !== null);
    if (!list.length) { announce(notes.length ? 'Бележките на този урок не са намерени в текста: виж списъка.' : 'В този урок още няма бележки.'); return; }
    list.sort((a, b) => topOf(a) - topOf(b));
    const openId = panelMode === 'note' && editing?.noteId;
    let i = openId ? list.findIndex((x) => x.note.id === openId) : -1;
    let target;
    if (i >= 0) target = list[i + dir];
    else {
      // From the place on the screen: the first note below (above) the top third of the window.
      const f = getFrame()?.frame;
      const y = f ? (window.innerHeight / 3) - f.getBoundingClientRect().top : 0;
      target = dir > 0 ? list.find((x) => topOf(x) > y + 4) : [...list].reverse().find((x) => topOf(x) < y - 4);
    }
    if (!target) { announce(dir > 0 ? 'Това е последната бележка.' : 'Това е първата бележка.'); return; }
    i = list.indexOf(target);
    openNote(target.note.id, { scroll: true, from: dir > 0 ? nextButton : prevButton });
    announce(`Бележка ${i + 1} от ${list.length}.`);
  }

  // --- Data ------------------------------------------------------------------------------
  let reloadRun = 0;
  async function reload() {
    const run = ++reloadRun;
    let list = [];
    try { list = await lessonNotes(lesson); } catch (err) { console.warn('Cannot read the notes:', err?.name || err); }
    if (destroyed || run !== reloadRun) return;
    notes = list;
    refreshCounts();
    queuePlace();
    if (panelMode === 'list') {
      const scroll = panelBody.scrollTop;
      await openList();
      panelBody.scrollTop = scroll;
    }
  }
  function refreshCounts() {
    const { all } = ordered();
    const check = all.filter((x) => stateOf(x.annotation) !== 'ok').length;
    listCount.textContent = String(all.length);
    listWarn.hidden = !check;
    const label = `Всички бележки: ${all.length}${check ? `, ${check} за проверка` : ''}`;
    listButton.setAttribute('aria-label', label);
    listButton.title = label;
    handle.querySelector('.notes-strip-handle__count').textContent = all.length ? String(all.length) : '';
    element.dataset.count = String(all.length);
    prevButton.disabled = !all.length;
    nextButton.disabled = !all.length;
    fixRove();
  }

  const onResize = () => {
    if (!chosen && !destroyed) {
      const want = narrowScreen();
      if (want !== hidden) setHidden(want, { save: false });
    }
    queuePlace();
    if (panelMode) fitViewport();
  };
  window.addEventListener('resize', onResize);

  // T018-D2: while the note field has the focus a transparent layer of the app
  // lies over the lesson (a press of the user there is the app's: it leaves the
  // field, the next press reaches the lesson; a scroll still moves the page);
  // the frame is out of the tab order. Note: `inert` on the iframe (or a modal
  // dialog) does NOT stop the lesson's own focus() in Chrome — checked.
  let guarded = null; // { frame, tabindex }
  /** Bring the keyboard back into the note field (the lesson took it). */
  function reclaimFocus(ed) {
    if (editing !== ed || !guarded) return;
    const ta = ed.textarea;
    // With the lesson in its own process the browser hands the focus over
    // asynchronously: the field lets go now (its focus() would do nothing while
    // it is still the active element here) and takes it back in the next task.
    ed.reclaiming = true;
    try { if (document.activeElement === ta) ta.blur(); } finally { ed.reclaiming = false; }
    setTimeout(() => { if (editing === ed && guarded) ta.focus({ preventScroll: true }); }, 0);
    if (!ed.stolen) announce('Урокът се опита да вземе фокуса; бележката го задържа.');
    ed.stolen = (ed.stolen || 0) + 1;
  }
  const guardLayer = h('div', { class: 'note-guard', 'data-field': 'note-guard', 'aria-hidden': 'true' });
  guardLayer.addEventListener('pointerdown', () => {
    const ta = editing?.textarea;
    unguardFrame();
    if (ta && document.activeElement === ta) ta.blur();
  });
  function guardFrame() {
    const lf = getFrame();
    const f = lf?.frame;
    if (!f) return;
    if (guarded?.frame === f) return;
    unguardFrame();
    guarded = { frame: f, lessonFrame: lf, tabindex: f.getAttribute('tabindex') };
    lf.keysOff?.(true);
    f.setAttribute('tabindex', '-1');
    f.setAttribute('data-note-guard', 'on');
    lf.element?.append(guardLayer);
  }
  function unguardFrame() {
    if (!guarded) return;
    const { frame: f, lessonFrame: lf, tabindex } = guarded;
    guarded = null;
    lf.keysOff?.(false);
    if (tabindex === null) f.removeAttribute('tabindex'); else f.setAttribute('tabindex', tabindex);
    f.removeAttribute('data-note-guard');
    guardLayer.remove();
  }

  // T018-D3: the page goes (reload, closed tab, Android puts Chrome away and may
  // kill it): the text not yet in the database is kept at once (synchronously)
  // and saved; the next start writes a kept text that did not make it.
  const keepNow = () => {
    const ed = editing;
    if (!ed || destroyed) return;
    const body = ed.textarea.value.slice(0, MAX_NOTE_LENGTH);
    if (body === ed.savedBody || (!ed.noteId && !body.trim())) return;
    keepPendingNote({ courseId: course.id, lessonId: lesson.id, draft: ed.noteId ? { noteId: ed.noteId } : ed.draft, body });
    ed.dirty = true;
    save(ed);
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') keepNow(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', keepNow);
  window.addEventListener('beforeunload', keepNow);
  window.visualViewport?.addEventListener('resize', fitViewport);
  let observer = null;
  try { observer = new ResizeObserver(queuePlace); observer.observe(slot); } catch { /* old engine: resize only */ }

  // The first state, without saving (no choice made yet).
  setHidden(hidden, { save: false });
  refreshCounts();
  reload();

  return {
    element: slot,
    panel,
    toast,
    get hidden() { return hidden; },
    setHidden: (value) => setHidden(value),
    /** The lesson's selection (checked by lesson-frame.js), or null. */
    onSelection(sel) {
      clearTimeout(selectionTimer);
      if (sel && !getTool()) {
        selection = sel;
        showSelectionButtons();
        return;
      }
      // Gone: keep the button a moment (a tap on it may be what cleared the selection).
      const wait = Math.max(SELECTION_GRACE_MS, pressingUntil - performance.now());
      selectionTimer = setTimeout(() => { selection = null; showSelectionButtons(); }, wait);
    },
    /** A tap on a mark / a noted place of the lesson (a known id), without a tool. */
    onTap(annotation) {
      if (!annotation || getTool()) return;
      const item = notes.find((x) => x.annotation.id === annotation.id);
      if (item) { openNote(item.note.id); return; }
      if (COLORS.includes(annotation.color)) openMarkCard(annotation);
    },
    onLayout(next) { places = next; queuePlace(); },
    onAnchored() { refreshCounts(); queuePlace(); if (panelMode === 'list') reload(); },
    /** The tool changed: no "Бележка" while a tool is on. */
    onTool() { showSelectionButtons(); },
    reload,
    /** Escape inside the lesson (lrn:escape). */
    escape() {
      if (panelMode) { closePanel({ focus: true }); return true; }
      return false;
    },
    destroy() {
      if (destroyed) return;
      const ed = editing;
      if (ed) save(ed); // the last text is written (the save does not need this screen)
      destroyed = true;
      clearTimeout(selectionTimer);
      clearTimeout(undoTimer);
      clearTimeout(focusTimer);
      cancelAnimationFrame(placeQueued);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onAnyPress, true);
      window.removeEventListener('keydown', onFocusKey, true);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', keepNow);
      window.removeEventListener('beforeunload', keepNow);
      unguardFrame();
      window.visualViewport?.removeEventListener('resize', fitViewport);
      observer?.disconnect();
    },
  };
}
