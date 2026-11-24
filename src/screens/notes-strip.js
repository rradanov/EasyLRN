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
//   new note is not saved. "💬 Въпрос" (T-023, D-047) is next to it; "Развий
//   ми го" (T-025) comes into SELECTION_ACTIONS below when it is ready.
// - T-023 (D-047): questions to the teacher in the same panel — a thread on
//   the selected text (an annotation, 💬 next to its line) or about the lesson
//   as a whole ("💬" in the strip: the field and the list of all questions);
//   the answer streams in as Markdown (src/markdown.js), its cost under it;
//   "Отказ", "Опитай пак", "Покажи промпта"; the question field is guarded like
//   the note's. See src/questions.js and the block "T-023" below.
// - A tap on a mark without a tool (`lrn:tap`): its note, or a small card with
//   "📝 Добави бележка".
// - Deleting: "Изтрий" in the note; "Върни" brings it back for a few seconds.
//   The eraser never deletes a note (src/screens/mark-tools.js).
// - Notes whose text is no longer found exactly: "⚠ провери" (found
//   approximately: "Да, тук е" confirms the place) and "Неприкачени" (not
//   found) — at the end of the list, never lost; "Бележки (N)" shows ⚠.
// - T-069 (the user, an addition to D-045):
//   - a tablet (≥ 600 px): the panel of a note is a COLUMN of its own at the
//     right edge; the lesson becomes narrower (the space is kept free with a
//     margin of the strip, only as much as the free space right of the centred
//     reader does not give), so the text of the lesson and of the note are seen
//     side by side, never one over the other. Its width: a quarter of the
//     window, 280…440 px;
//   - a smaller strip (buttons 44 × 40 px, the 📝 36 px, ≈ 95 px in all);
//   - a phone (< 600 px, followed live: rotation, split screen): no lesson and
//     note at once. Only the column of the 📝 next to the lesson (≈ 41 px), no
//     bar; "📝 Бележка" floats at the right edge while text is selected; a 📝 →
//     the note over the whole window; ✕ / "Готово" → back to the lesson. The
//     buttons of the bar are in the panel (▲ / ▼, "← Всички бележки"); a small
//     "☷" shows only when some note has no 📝 (not found in the text).
// - A tablet strip can be hidden ("» Скрий" → a handle "☰" at the right edge);
//   the choice is kept (`notesStrip.hidden`).
// - D-046 (the user, after 0.14.2 on the tablet; src/screens/reader-layout.js):
//   - portrait (taller than wide, ≥ 600 px): the bar of the strip is
//     HORIZONTAL at the top of the reader (`topSlot`, right of the tool bar;
//     "Скрий" leaves a small "☰" there); the 📝 column stays next to the lesson;
//     a note / the list / a mark card opens UNDER the lesson (fixed at the
//     bottom of the window; the page gets as much room below, so the end of the
//     lesson can still be read above it) and the place of the note is scrolled
//     into the part of the lesson that is seen;
//   - landscape: as before (the strip right of the lesson, the panel a column at
//     the right edge);
//   - a movable divider between the lesson and the panel (a 24 px grip, a
//     line and "⋮" / "⋯"; a finger, the mouse, the arrow keys); the lesson keeps
//     ≥ 45 % (of the width / of the height below the bars), the panel ≥ 200 px;
//     the place is kept per orientation (`notesSplit`: { portrait, landscape }:
//     a part of the window) and the right one is used after a rotation;
//   - while the panel is open the 📝 column and the bar of the strip are hidden
//     (the panel has ▲ / ▼, ✕, "← Всички бележки"); "📝 Бележка" for a new
//     selection floats at the right edge then;
//   - a phone (< 600 px): unchanged (only the 📝, the note over the whole window).
// - Security: the lesson is untrusted. What it sends is checked in
//   lesson-frame.js (known ids only, numbers only); a selection or a tap from
//   the lesson can only SHOW a button or a note of the user — nothing is
//   created, changed or deleted without the user's own press in the app. The
//   text of a note is shown only here (textContent / src/markdown.js) and is
//   never posted to the lesson.
import { h, mount } from '../dom.js';
import { saveSettings, getSettings, getApiKey, COLORS } from '../db.js';
import { link } from '../router.js';
import { askTeacher, previewTeacher, lessonText } from '../teacher.js';
import { createVoiceInput } from '../voice.js';
import { monthState, budgetWarning, formatUSD } from '../usage.js';
import {
  lessonThreads, threadMessages, quoteContext, startThread, sentText, addExchange, restartAnswer, finishAnswer,
  isStale, threadHistory, deleteThread, restoreThread, threadAtSelection, MAX_QUESTION_LENGTH,
} from '../questions.js';
import { renderMarkdown } from '../markdown.js';
import { confirmAnnotationPlace } from '../annotations.js';
import {
  lessonNotes, saveNote, deleteNote, restoreNote, noteAtSelection, markAtSelection, MAX_NOTE_LENGTH,
  keepPendingNote, dropPendingNote, takeEmptiedNotes,
} from '../notes.js';
import { readerLayout } from './reader-layout.js';

const PANEL_MIN = 280; // the note column in landscape, at first: a quarter of the window within these
const PANEL_MAX = 440;
const PORTRAIT_SHARE = 0.4; // the panel under the lesson in portrait, at first: this part of the window's height
const NOTE_MIN_PX = 200; // D-046: the divider keeps the panel at least this big …
const LESSON_MIN_SHARE = 0.45; // … and the lesson at least this part (of the width / of the height below the bars)
const DIVIDER_STEP_PX = 24; // an arrow key moves the divider this far
const SPLIT_SAVE_MS = 400;
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
const STREAM_PAINT_MS = 80; // T-023: an answer coming in is drawn again at most this often
const PROMPT_PREVIEW_MS = 400; // "Покажи промпта" follows the typed question after this pause

/**
 * Buttons for a selection (D-045). "Бележка" and "Въпрос" (T-023); "Развий ми
 * го" (T-025) is added when it exists (`ready: false` keeps it out of the strip).
 */
export const SELECTION_ACTIONS = Object.freeze([
  { id: 'note', label: 'Бележка', icon: '📝', ready: true },
  { id: 'question', label: 'Въпрос', icon: '💬', ready: true }, // T-023 (D-047)
  { id: 'expand', label: 'Развий ми го', icon: '✨', ready: false }, // T-025
]);

const short = (text, max = QUOTE_MAX) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const quoted = (text, max) => `«${short(text, max)}»`;

/** D-046: the stored places of the divider: a part of the window (0…1) per orientation, or null (the default). */
export function splitChoice(settings) {
  const s = settings?.notesSplit && typeof settings.notesSplit === 'object' ? settings.notesSplit : {};
  const part = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1 ? v : null);
  return { portrait: part(s.portrait), landscape: part(s.landscape) };
}

/** The stored choice: true / false when the user chose, null when not yet (→ by the width). */
export function stripChoice(settings) {
  const s = settings?.notesStrip && typeof settings.notesStrip === 'object' ? settings.notesStrip : {};
  return { hidden: typeof s.hidden === 'boolean' ? s.hidden : null };
}

/**
 * @param {{ getFrame: () => object|null, getTool: () => string|null, course: object, lesson: object,
 *   settings: object, announce: (text: string) => void, onLayout?: (hidden: boolean) => void }} opts
 */
export function createNotesStrip({ getFrame, getTool = () => null, course, lesson, settings, announce, onLayout, topSlot = null, viewInsets = null }) {
  let hidden = stripChoice(settings).hidden ?? false; // a tablet strip hidden by the user
  // T018-D14 / T-069 / D-046: the layout follows the window live (rotation,
  // split screen on Android): 'phone' | 'portrait' | 'landscape'.
  let layout = readerLayout();
  let phone = layout === 'phone';
  const split = splitChoice(settings); // D-046: the divider per orientation
  let destroyed = false;
  let notes = []; // [{ note, annotation }] of this lesson (live ones)
  let threads = []; // T-023: [{ thread, annotation|null, messages }] of this lesson (live ones)
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
    const ed = editing || asking; // T-023: the question field is guarded the same way
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
  // T-023 (D-047): "💬 Въпрос" for the selected text, next to "📝 Бележка".
  const askButton = press(button({
    class: 'notes-strip__button notes-strip__new notes-strip__ask', 'data-action': 'new-question', hidden: true,
    'aria-label': 'Въпрос към учителя за избрания текст', title: 'Въпрос към учителя за избрания текст',
  }, h('span', { 'aria-hidden': 'true', class: 'notes-strip__icon', text: '💬' }), h('span', { class: 'notes-strip__label', 'aria-hidden': 'true', text: 'Въпрос' })), () => askFromSelection());
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
  // T-023 (D-047): "💬" — a question about the lesson as a whole, and the questions of the lesson.
  const questionsCount = h('span', { class: 'notes-strip__count', 'data-field': 'questions-count', text: '' });
  const questionsButton = press(button({
    class: 'notes-strip__button notes-strip__questions', 'data-action': 'questions', 'aria-expanded': 'false', 'aria-controls': 'notes-panel',
    'aria-label': 'Въпрос към учителя за урока', title: 'Въпрос към учителя за урока и всички въпроси',
  }, h('span', { 'aria-hidden': 'true', class: 'notes-strip__icon', text: '💬' }), questionsCount), () => (panelMode === 'questions' ? closePanel() : openQuestions({ focusField: true })));
  const hideButton = press(button({
    class: 'notes-strip__button notes-strip__hide', 'data-action': 'hide-notes', 'aria-expanded': 'true', 'aria-controls': 'notes-strip',
    'aria-label': 'Скрий бележките', title: 'Скрий бележките',
  }, h('span', { 'aria-hidden': 'true', text: '»' }), h('span', { class: 'notes-strip__label', 'aria-hidden': 'true', text: 'Скрий' })), () => setHidden(true, { focus: true }));
  const bar = h('div', { class: 'notes-strip__bar', role: 'toolbar', 'aria-label': 'Бележки', 'aria-orientation': 'vertical' },
    hideButton, noteButton, askButton, listButton, prevButton, nextButton, questionsButton);
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
  const quickAsk = press(button({
    class: 'notes-strip-quick notes-strip-quick--ask', 'data-action': 'new-question-quick', hidden: true,
    'aria-label': 'Въпрос към учителя за избрания текст', title: 'Въпрос към учителя за избрания текст',
  }, h('span', { 'aria-hidden': 'true', text: '💬' }), h('span', { class: 'notes-strip-quick__label', text: 'Въпрос' })), () => askFromSelection());
  // A phone: "💬" for a question about the lesson (and the list of the questions); no bar there.
  const phoneAsk = press(button({
    class: 'notes-strip-phone-list notes-strip-phone-ask', 'data-action': 'questions-phone', hidden: true,
    'aria-label': 'Въпрос към учителя за урока', title: 'Въпрос към учителя за урока и всички въпроси',
  }, h('span', { 'aria-hidden': 'true', text: '💬' }), h('span', { class: 'notes-strip-phone-list__count', 'aria-hidden': 'true' })), () => openQuestions({ focusField: true }));
  // A phone: "☷" only when some note has no 📝 (not found in the text): else the list is one 📝 away.
  const phoneList = press(button({
    class: 'notes-strip-phone-list', 'data-action': 'notes-list-phone', hidden: true,
    'aria-label': 'Всички бележки', title: 'Всички бележки на урока',
  }, h('span', { 'aria-hidden': 'true', text: '☷' }), h('span', { class: 'notes-strip-phone-list__count', 'aria-hidden': 'true' })), () => openList());
  const refreshPhoneList = () => {
    const unplaced = notes.length > 0 && (ordered().orphans.length > 0 || !marks.querySelector('.notes-strip__mark[data-note]'));
    phoneList.hidden = !phone || !unplaced;
    phoneList.querySelector('.notes-strip-phone-list__count').textContent = notes.length ? String(notes.length) : '';
    phoneAsk.hidden = !phone;
    phoneAsk.querySelector('.notes-strip-phone-list__count').textContent = threads.length ? String(threads.length) : '';
  };
  const handleBox = h('div', { class: 'notes-strip-handle-box' }, handle, quickNote, quickAsk, phoneList, phoneAsk);
  const slot = h('div', { class: 'reader__notes', 'data-field': 'reader-notes' }, handleBox, element);

  // Keyboard: one stop for the strip, arrows move inside (a toolbar).
  const stripButtons = () => [...bar.querySelectorAll('button')].filter((b) => !b.hidden && !b.disabled);
  const rove = (target) => { for (const b of bar.querySelectorAll('button')) b.tabIndex = b === target ? 0 : -1; };
  bar.addEventListener('keydown', (event) => {
    const list = stripButtons();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[event.key];
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
    hidden = !!next;
    if (save) saveSettings({ notesStrip: { hidden } }).catch((err) => console.warn('Cannot save the notes strip:', err?.name || err));
    applyLayout();
    if (focus) (hidden ? handle : (bar.querySelector('button[tabindex="0"]:not([hidden])') || hideButton)).focus();
    if (save) announce(hidden ? 'Бележките са скрити.' : 'Бележките са показани.');
  }
  /** D-046: the bar and the handle at the top (portrait) or in the strip. */
  function placeBar() {
    const top = layout === 'portrait' && topSlot;
    const had = bar.contains(document.activeElement) || document.activeElement === handle;
    if (top) {
      if (handle.parentNode !== topSlot || bar.parentNode !== topSlot) topSlot.append(handle, bar);
    } else {
      if (bar.parentNode !== element) element.prepend(bar);
      if (handle.parentNode !== handleBox) handleBox.prepend(handle);
    }
    bar.setAttribute('aria-orientation', top ? 'horizontal' : 'vertical');
    bar.dataset.orientation = top ? 'horizontal' : 'vertical';
    handle.dataset.orientation = bar.dataset.orientation;
    if (had && !document.activeElement?.isConnected) homeButton()?.focus({ preventScroll: true });
  }
  /** What is shown, from the layout, `hidden` (the user's choice on a tablet) and the panel (D-046). */
  function applyLayout() {
    const off = hidden && !phone; // the tablet strip hidden behind "☰"
    const panelOpen = Boolean(panelMode) && !phone; // D-046: the panel has its own ▲ / ▼ / ✕
    placeBar();
    element.hidden = off || panelOpen;
    bar.hidden = off || panelOpen || phone;
    handleBox.hidden = !(off || phone || panelOpen); // also the floating "📝 Бележка" / "☷"
    handle.hidden = phone || !off || panelOpen;
    hideButton.setAttribute('aria-expanded', String(!off));
    handle.setAttribute('aria-expanded', String(!off));
    slot.dataset.hidden = String(off);
    slot.dataset.phone = String(phone);
    slot.dataset.layout = layout;
    slot.dataset.panelOpen = String(panelOpen);
    if (topSlot) topSlot.dataset.panelOpen = String(panelOpen);
    showSelectionButtons();
    refreshPhoneList();
    if (!off && !panelOpen) queuePlace();
    fitViewport();
    onLayout?.(off || panelOpen);
  }
  /** Where the focus goes back when nothing else is there. */
  const homeButton = () => {
    if (phone) return marks.querySelector('.notes-strip__mark[data-note]') || (phoneList.hidden ? document.getElementById('main') : phoneList);
    if (panelMode) return panelTitle; // D-046: the strip is hidden while the panel is open
    return hidden ? handle : listButton;
  };

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
  /** T-023: the threads with their live anchoring, in text order; those about the lesson / not found after them. */
  const orderedThreads = () => {
    const frame = getFrame();
    const live = new Map((frame?.annotations || []).map((a) => [a.id, a]));
    const list = threads.map((x) => ({ ...x, annotation: x.annotation ? (live.get(x.annotation.id) || x.annotation) : null }));
    const placed = list.filter((x) => x.annotation && stateOf(x.annotation) !== 'orphan').sort((a, b) => startOf(a.annotation) - startOf(b.annotation));
    const whole = list.filter((x) => !x.thread.annotationId);
    const orphans = list.filter((x) => x.thread.annotationId && (!x.annotation || stateOf(x.annotation) === 'orphan'));
    return { placed, whole, orphans, all: [...placed, ...whole, ...orphans] };
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
    // D-046: behind the open panel the 📝 are still made (hidden; placed again when it closes).
    if ((hidden && !phone) || !f || frame.innerScroll || !f.isConnected) { mount(marks); refreshPhoneList(); return; }
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
    // T-023: the 💬 of the threads, in the same column (under a 📝 of the same line).
    const threadRows = [];
    for (const item of orderedThreads().placed) {
      const top = lineMiddle(item);
      if (top === null || top > fr.height + 1) continue;
      const row = threadRows.find((r) => Math.abs(r.top - top) < SAME_LINE_PX);
      if (row) row.items.push(item);
      else threadRows.push({ top, items: [item] });
    }
    const threadMarks = threadRows.map((row) => {
      const first = row.items[0];
      const q = first.annotation.selector?.quote?.exact || first.thread.quote;
      const label = row.items.length > 1 ? `${row.items.length} въпроса на този ред: ${quoted(q, 60)}` : `Въпрос: ${quoted(q, 60)}`;
      const b = press(button({
        class: 'notes-strip__mark notes-strip__mark--thread', 'data-thread': first.thread.id, 'data-annotation': first.annotation.id,
        'data-state': stateOf(first.annotation), 'aria-label': label, title: label, tabindex: '-1',
      }, h('span', { 'aria-hidden': 'true', text: '💬' }), row.items.length > 1 ? h('span', { class: 'notes-strip__mark-count', 'aria-hidden': 'true', text: String(row.items.length) }) : null),
      () => openThread({ threadId: first.thread.id, from: b }));
      const under = rows.some((r) => Math.abs(r.top - row.top) < SAME_LINE_PX);
      b.style.top = `${Math.round(offset + row.top + (under ? 38 : 0))}px`;
      return b;
    });
    mount(marks, ...threadMarks, ...rows.map((row) => {
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
    refreshPhoneList();
  }

  // --- The panel (a note, the list, a mark) ------------------------------------------
  const panelTitle = h('h2', { class: 'notes-panel__title', id: 'notes-panel-title', tabindex: '-1' });
  const closeButton = press(button({ class: 'notes-panel__close', 'data-action': 'close-notes-panel', 'aria-label': 'Затвори', title: 'Затвори (Esc)' }, '✕'), () => closePanel({ focus: true }));
  const panelBody = h('div', { class: 'notes-panel__body' });
  // D-046: the divider between the lesson and the panel (a finger, the mouse, the arrow keys).
  const grip = h('span', { class: 'notes-panel__grip', 'aria-hidden': 'true', text: '⋮' });
  const divider = h('div', {
    class: 'notes-panel__divider', 'data-field': 'notes-divider', role: 'separator', tabindex: '0',
    'aria-label': 'Граница между урока и бележката', 'aria-controls': 'notes-panel', title: 'Плъзни, за да смениш размера (или стрелките)',
  }, h('span', { class: 'notes-panel__line', 'aria-hidden': 'true' }), grip);
  const panel = h('section', {
    class: 'notes-panel', id: 'notes-panel', 'data-field': 'notes-panel', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': 'notes-panel-title', hidden: true,
  }, divider, h('header', { class: 'notes-panel__head' }, panelTitle,
    press(button({ class: 'notes-panel__step', 'data-action': 'panel-prev-note', 'aria-label': 'Предишна бележка', title: 'Предишна бележка' }, '▲'), () => step(-1)),
    press(button({ class: 'notes-panel__step', 'data-action': 'panel-next-note', 'aria-label': 'Следваща бележка', title: 'Следваща бележка' }, '▼'), () => step(1)),
    closeButton), panelBody);
  const undoText = h('span', { class: 'notes-undo__text' });
  const undoButton = press(button({ class: 'button notes-undo__button', 'data-action': 'undo-note-delete' }, 'Върни'), () => runUndo());
  const toast = h('div', { class: 'notes-undo', 'data-field': 'notes-undo', role: 'status', hidden: true }, undoText, undoButton);

  let panelMode = null; // null | 'note' | 'list' | 'mark'
  let returnFocus = null;
  let editing = null; // { draft, quote, textarea, status, dirty, timer, saving: Promise, annotationId, noteId }
  let asking = null; // T-023: the open thread / question: { question: true, textarea, threadId, draft, … }
  const setMode = (mode) => {
    panelMode = mode;
    panel.hidden = !mode;
    panel.dataset.mode = mode || 'none';
    listButton.setAttribute('aria-expanded', String(mode === 'list'));
    questionsButton.setAttribute('aria-expanded', String(mode === 'questions'));
    slot.dataset.panel = mode || 'none';
    applyLayout(); // D-046: the strip goes while the panel is open, comes back after
  };
  // Where the panel goes (T-069, D-046): on a phone over the whole window; in
  // landscape a column of its own at the right edge, and the strip keeps that
  // much free (its margin): the lesson becomes narrower and nothing of it is
  // covered; in portrait under the lesson, at the bottom of the window, and the
  // page gets as much room below (--notes-cover-bottom) so the lesson can be
  // read to its end above the panel.
  let keepPlace = null; // { id, until }: the place of the opened note is brought back into view after the lesson reflows
  const winWidth = () => document.documentElement.clientWidth || window.innerWidth;
  const keyboardCover = () => {
    const vv = window.visualViewport;
    return vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
  };
  const insets = () => viewInsets?.() || {
    top: document.querySelector('.app-bar')?.getBoundingClientRect().bottom ?? 0,
    bottom: parseFloat(document.documentElement.style.getPropertyValue('--notes-cover-bottom')) || 0,
  };
  /** The limits of the panel now: [min, max] px (the lesson keeps its share, the panel 200 px). */
  const panelBounds = () => {
    if (layout === 'portrait') {
      const avail = window.innerHeight - keyboardCover() - insets().top;
      return [NOTE_MIN_PX, Math.max(NOTE_MIN_PX, Math.floor(avail * (1 - LESSON_MIN_SHARE)))];
    }
    const vw = winWidth();
    const left = Math.max(0, getFrame()?.element?.getBoundingClientRect().left ?? 0);
    return [NOTE_MIN_PX, Math.max(NOTE_MIN_PX, Math.floor(vw - left - vw * LESSON_MIN_SHARE))];
  };
  /** The size of the panel (px): the user's place of the divider, else the default; within the limits. */
  const panelSize = () => {
    const [min, max] = panelBounds();
    let want;
    if (layout === 'portrait') want = (split.portrait ?? PORTRAIT_SHARE) * window.innerHeight;
    else if (split.landscape !== null) want = split.landscape * winWidth();
    else want = Math.max(PANEL_MIN, Math.min(PANEL_MAX, winWidth() * 0.25));
    return Math.round(Math.max(min, Math.min(max, want)));
  };
  const setCover = (px) => {
    const v = px > 0 ? `${Math.round(px)}px` : '';
    const root = document.documentElement.style;
    if (root.getPropertyValue('--notes-cover-bottom') !== v) {
      if (v) root.setProperty('--notes-cover-bottom', v); else root.removeProperty('--notes-cover-bottom');
    }
  };
  const fitViewport = () => {
    if (panel.hidden || destroyed) {
      panel.style.removeProperty('--notes-vv-bottom');
      setCover(0);
      if (slot.style.marginRight) { slot.style.marginRight = ''; queuePlace(); }
      return;
    }
    const where = phone ? 'full' : layout === 'portrait' ? 'bottom' : 'side';
    panel.dataset.layout = where;
    panel.style.left = '';
    panel.style.right = '';
    panel.style.width = '';
    panel.style.height = '';
    const covered = keyboardCover();
    panel.style.setProperty('--notes-vv-bottom', `${Math.round(covered)}px`);
    const size = where === 'full' ? 0 : panelSize();
    if (where === 'side') {
      setCover(0);
      panel.style.right = '0px';
      panel.style.width = `${size}px`;
      // Only what the free space right of the reader (a wide window: the content is centred) does not give.
      const vw = winWidth();
      const now = parseFloat(slot.style.marginRight) || 0;
      const free = vw - (slot.getBoundingClientRect().right + now);
      const margin = `${Math.max(0, Math.ceil(size - free))}px`;
      if (slot.style.marginRight !== margin) { slot.style.marginRight = margin; queuePlace(); }
    } else {
      if (slot.style.marginRight) { slot.style.marginRight = ''; queuePlace(); }
      if (where === 'bottom') {
        panel.style.height = `${size}px`;
        setCover(size + covered);
      } else {
        setCover(0);
      }
    }
    // The divider: what it says to a screen reader, its look.
    if (where !== 'full') {
      const [min, max] = panelBounds();
      const whole = where === 'side' ? winWidth() : window.innerHeight;
      divider.setAttribute('aria-orientation', where === 'side' ? 'vertical' : 'horizontal');
      divider.setAttribute('aria-valuemin', String(Math.round((min / whole) * 100)));
      divider.setAttribute('aria-valuemax', String(Math.round((max / whole) * 100)));
      divider.setAttribute('aria-valuenow', String(Math.round((size / whole) * 100)));
      divider.setAttribute('aria-valuetext', `Бележката: ${Math.round((size / whole) * 100)} % от ${where === 'side' ? 'ширината' : 'височината'}`);
      grip.textContent = where === 'side' ? '⋮' : '⋯';
    }
  };

  // --- D-046: the divider ------------------------------------------------------------
  let splitTimer = 0;
  const saveSplit = () => {
    clearTimeout(splitTimer);
    splitTimer = setTimeout(() => {
      saveSettings({ notesSplit: { portrait: split.portrait, landscape: split.landscape } })
        .catch((err) => console.warn('Cannot save the divider:', err?.name || err));
    }, SPLIT_SAVE_MS);
  };
  /** The panel is `px` big now (within the limits); kept for this orientation. */
  function setPanelSize(px, { save = true } = {}) {
    if (phone || panel.hidden) return;
    const [min, max] = panelBounds();
    const size = Math.max(min, Math.min(max, Math.round(px)));
    const portrait = layout === 'portrait';
    split[portrait ? 'portrait' : 'landscape'] = size / (portrait ? window.innerHeight : winWidth());
    fitViewport();
    if (save) saveSplit();
  }
  let drag = null; // { id, frame } while the divider is dragged
  divider.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || phone) return;
    e.preventDefault();
    // Where the finger holds the grip: the edge of the panel keeps that distance (no jump).
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, frame: 0, x: e.clientX, y: e.clientY, dx: r.left - e.clientX, dy: r.top - e.clientY };
    try { divider.setPointerCapture(e.pointerId); } catch { /* gone */ }
    divider.dataset.dragging = 'true';
  });
  const dragSize = () => (layout === 'portrait'
    ? window.innerHeight - keyboardCover() - (drag.y + drag.dy)
    : winWidth() - (drag.x + drag.dx));
  divider.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      setPanelSize(dragSize(), { save: false });
    });
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cancelAnimationFrame(drag.frame);
    setPanelSize(dragSize());
    drag = null;
    delete divider.dataset.dragging;
    keepInView();
  };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);
  divider.addEventListener('lostpointercapture', endDrag);
  divider.addEventListener('keydown', (e) => {
    const portrait = layout === 'portrait';
    const now = portrait ? panel.getBoundingClientRect().height : panel.getBoundingClientRect().width;
    const [min, max] = panelBounds();
    // The arrow points where the divider goes: towards the lesson = a bigger panel.
    const grow = portrait ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowLeft: 1, ArrowRight: -1 };
    let next = null;
    if (e.key in grow) next = now + grow[e.key] * DIVIDER_STEP_PX;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    setPanelSize(next);
    keepInView();
  });
  /** The place of the open note stays where it is seen (after the divider moved / the layout changed). */
  function keepInView() {
    const id = editing?.annotationId;
    if (!id || panelMode !== 'note') return;
    const frame = getFrame();
    const f = frame?.frame;
    const place = frame?.layout?.get(id);
    if (!f || !place) return;
    const top = f.getBoundingClientRect().top + place.top;
    const bottom = f.getBoundingClientRect().top + (Number.isFinite(place.bottom) ? place.bottom : place.top + 20);
    const { top: seenTop, bottom: coverBottom } = insets();
    const seenBottom = window.innerHeight - coverBottom;
    if (top < seenTop + 4 || bottom > seenBottom - 4) frame.scrollToAnnotation(id);
  }

  function closePanel({ focus = false } = {}) {
    if (!panelMode) return Promise.resolve();
    const was = editing;
    editing = null;
    if (asking) { clearTimeout(asking.previewTimer); asking.closed = true; }
    asking = null; // T-023: an answer still coming in goes on and is kept (src/questions.js)
    dropVoices(); // T-041: the 🎤 of the panel stops (no audio is kept)
    const done = was ? finishEditing(was) : Promise.resolve();
    // T018-D12: whether the focus was in the panel is known only before it is emptied.
    const hadFocus = panel.contains(document.activeElement);
    setMode(null);
    mount(panelBody);
    unguardFrame();
    const back = returnFocus;
    returnFocus = null;
    if (focus || hadFocus) {
      (back?.isConnected && !back.hidden && back.getClientRects().length ? back : homeButton())?.focus({ preventScroll: true });
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

  // T-041 (D-025): the 🎤 of the fields of the panel.
  const voices = new Set();
  const voiceFor = (field, label) => {
    const v = createVoiceInput({ field, label });
    voices.add(v);
    return v;
  };
  function dropVoices() {
    for (const v of voices) v.destroy();
    voices.clear();
  }

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
    returnFocus = from || (fromPanel || !active || active === document.body || !active.isConnected ? homeButton() : active);
    if (annotation && !phone) keepPlace = { id: annotation.id, until: performance.now() + 1500 };
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
    attachFieldGuard(ed);
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
      // T-041: 🎤 next to the field (hidden without the API / offline: the keyboard's dictation stays).
      h('div', { class: 'voice-field' }, textarea, voiceFor(textarea, 'Гласово въвеждане на бележката').element),
      status,
      h('div', { class: 'notes-panel__actions' }, doneButton, showButton, confirmButton, deleteButton));
    if (focusText) textarea.focus({ preventScroll: true });
    else panelTitle.focus({ preventScroll: true });
    // D-046: in portrait the panel covers the bottom of the window: the place goes where it is seen.
    requestAnimationFrame(() => { if (editing === ed && !destroyed) keepInView(); });
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
      dropPendingNote({ lessonId: lesson.id, drafts: [ed.draft, { noteId: note.id }], body, since });
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
      // A copy kept for this note (the page was hidden meanwhile) must not bring it back.
      dropPendingNote({ lessonId: lesson.id, drafts: [ed.draft, { noteId: ed.noteId }] });
      ed.noteId = null;
      if (entry.annotationDeleted) await getFrame()?.reloadAnnotations();
      await reload();
      if (editing === ed) { editing = null; await closePanel({ focus: true }); }
      offerUndo(entry, empty ? 'Празната бележка е изтрита.' : 'Бележката е изтрита.');
    } catch (err) {
      console.warn('Cannot delete the note:', err?.message || err);
      announce('Бележката не можа да се изтрие.');
    }
  }
  /** `entry`: one entry of deleteNote, or several (T072-D1: all come back at once). */
  function offerUndo(entry, text) {
    undoEntry = Array.isArray(entry) ? entry : [entry];
    undoText.textContent = text;
    toast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { toast.hidden = true; undoEntry = null; }, UNDO_MS);
    announce(`${text} „Върни“ ${undoEntry.length > 1 ? 'ги' : undoEntry[0].kind === 'thread' ? 'го' : 'я'} връща.`);
  }
  async function runUndo() {
    const entries = undoEntry;
    undoEntry = null;
    clearTimeout(undoTimer);
    toast.hidden = true;
    if (!entries?.length) return;
    try {
      let annotationRestored = false;
      for (const entry of entries) {
        const back = entry.kind === 'thread' ? await restoreThread(lesson, entry) : await restoreNote(lesson, entry);
        if (back.annotationRestored) annotationRestored = true;
      }
      if (annotationRestored) await getFrame()?.reloadAnnotations();
      await reload();
      const last = entries[entries.length - 1];
      if (last.kind === 'thread') {
        announce('Въпросът е върнат.');
        openThread({ threadId: last.threadId });
        return;
      }
      announce(entries.length > 1 ? 'Бележките са върнати.' : 'Бележката е върната.');
      openNote(last.noteId);
    } catch (err) {
      console.warn('Cannot restore:', err?.message || err);
      announce(entries.some((e) => e.kind === 'thread') ? 'Въпросът не можа да се върне.' : 'Бележката не можа да се върне.');
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
    const ask = press(button({ class: 'button', 'data-action': 'ask-about-mark' }, '💬 Въпрос'), () => askAboutAnnotation(annotation));
    mount(panelBody,
      h('blockquote', { class: 'notes-panel__quote', 'data-field': 'note-quote' }, quoted(annotation.selector?.quote?.exact, 400)),
      // T-025: "Развий ми го" comes next to them.
      h('div', { class: 'notes-panel__actions' }, add, ask));
    add.focus({ preventScroll: true });
  }

  // --- A new note from the selection ------------------------------------------------
  function showSelectionButtons() {
    const on = Boolean(selection) && !getTool();
    const off = (hidden && !phone) || (Boolean(panelMode) && !phone); // D-046: no bar while the panel is open
    noteButton.hidden = !on || off || phone;
    quickNote.hidden = !on || !(off || phone);
    askButton.hidden = noteButton.hidden;
    quickAsk.hidden = quickNote.hidden;
    handle.dataset.attention = String(on && off);
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
      quote: sel.quote.exact, annotation: mark, focusText: true, from: homeButton(),
    });
  }

  // --- T-023 (D-047): questions to the teacher ----------------------------------------
  // The panel of a thread is the panel of a note (its place, its divider, its
  // guard). Nothing of a question or an answer is ever posted to the lesson;
  // the lesson cannot start a question (only the app's own buttons do), read an
  // answer or change the quote (it is taken at the press of "Въпрос" and is the
  // app's own text of the lesson file, checked in src/questions.js quoteContext).
  const running = new Map(); // assistant message id → { controller, text, threadId }
  const settingsLink = () => h('a', { href: link('settings'), 'data-action': 'open-settings', text: 'Настройки' });

  /** The quote of a selection with its paragraph and path from the app's text of the lesson. */
  async function contextOf(quote) {
    try {
      const text = await lessonText(lesson);
      return quoteContext(text, quote);
    } catch (err) {
      console.warn('Cannot read the lesson text:', err?.name || err);
      return { found: false, paragraph: '', path: [] };
    }
  }

  async function askFromSelection() {
    const sel = selection;
    if (!sel) return;
    selection = null;
    clearTimeout(selectionTimer);
    showSelectionButtons();
    const frame = getFrame();
    frame?.clearSelection();
    if (sel.excludedOnly || !sel.position) {
      announce('Тук не може да се закачи въпрос: тази част на урока (тест или бележка на автора) не се маркира. Питай за урока с „💬“.');
      return;
    }
    // A thread at exactly this place opens (its next question goes there).
    const there = threadAtSelection(sel, orderedThreads().all);
    if (there) {
      announce('Тук вече има въпрос: попитай още в същата нишка.');
      await openThread({ threadId: there.thread.id, focusField: true });
      return;
    }
    const mark = markAtSelection(sel, frame?.annotations || []);
    const ctx = await contextOf(sel.quote);
    await openThread({
      draft: { place: mark ? { annotationId: mark.id } : { selection: sel }, quote: sel.quote.exact, ...ctx, annotation: mark },
      focusField: true, from: homeButton(),
    });
  }
  /** "💬 Въпрос" in the card of a mark. */
  async function askAboutAnnotation(annotation) {
    const there = threads.find((x) => x.thread.annotationId === annotation.id);
    if (there) { await openThread({ threadId: there.thread.id, focusField: true }); return; }
    const ctx = await contextOf(annotation.selector?.quote || {});
    await openThread({
      draft: { place: { annotationId: annotation.id }, quote: annotation.selector?.quote?.exact || '', ...ctx, annotation },
      focusField: true,
    });
  }

  /** The composer: the field of a question, "Изпрати", "Отказ", "Покажи промпта". */
  function composer(state) {
    const textarea = h('textarea', {
      class: 'notes-panel__text thread__field', 'data-field': 'question-text', rows: '3', maxlength: String(MAX_QUESTION_LENGTH),
      'aria-label': state.threadId ? 'Следващ въпрос към учителя' : 'Въпрос към учителя',
      placeholder: state.threadId ? 'Следващ въпрос…' : 'Попитай учителя…',
    });
    textarea.value = state.typed || '';
    state.textarea = textarea;
    attachFieldGuard(state);
    const status = h('p', { class: 'notes-panel__status', 'data-field': 'question-status', role: 'status', 'aria-live': 'polite' });
    state.status = status;
    const send = press(button({ class: 'button button--primary', 'data-action': 'question-send' }, 'Изпрати'), () => sendQuestion(state));
    const cancel = press(button({ class: 'button', 'data-action': 'question-cancel', hidden: true }, 'Отказ'), () => cancelAnswer(state));
    state.send = send;
    state.cancel = cancel;
    const promptBox = h('pre', { class: 'thread__prompt', 'data-field': 'question-prompt', hidden: true, tabindex: '0' });
    const promptToggle = press(button({ class: 'button thread__prompt-toggle', 'data-action': 'question-prompt', 'aria-expanded': 'false', 'aria-controls': 'question-prompt' }, 'Покажи промпта'), () => {
      const on = promptBox.hidden;
      promptBox.hidden = !on;
      promptToggle.setAttribute('aria-expanded', String(on));
      promptToggle.textContent = on ? 'Скрий промпта' : 'Покажи промпта';
      if (on) showPromptNow(state);
    });
    promptBox.id = 'question-prompt';
    state.promptBox = promptBox;
    textarea.addEventListener('input', () => {
      state.typed = textarea.value;
      if (!promptBox.hidden) { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(() => showPromptNow(state), PROMPT_PREVIEW_MS); }
    });
    // Escape closes the panel; Ctrl+Enter sends.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel({ focus: true }); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendQuestion(state); }
    });
    const keyNote = h('p', { class: 'thread__notice', 'data-field': 'question-no-key', hidden: true },
      'Няма API ключ. Въведи го в ', settingsLink(), '. Уроците никога не искат API ключ — въвеждай го само в „Настройки“ на приложението.');
    const budget = h('p', { class: 'thread__notice thread__notice--budget', 'data-field': 'question-budget', hidden: true });
    state.keyNote = keyNote;
    state.budget = budget;
    // T-025: "Развий ми го" comes here (data-slot="expand").
    const expandSlot = h('span', { class: 'thread__slot', 'data-slot': 'expand', hidden: true });
    state.voice = voiceFor(textarea, 'Гласово въвеждане на въпроса');
    return h('div', { class: 'thread__composer', 'data-field': 'question-composer' },
      h('div', { class: 'voice-field' }, textarea, state.voice.element), status, keyNote, budget,
      h('div', { class: 'notes-panel__actions' }, send, cancel, promptToggle, expandSlot),
      promptBox);
  }
  /** The month's spend over the threshold (D-022): a warning, the user can go on. */
  async function showBudget(state) {
    try {
      const m = await monthState();
      const text = budgetWarning(m);
      if (state.closed) return;
      state.budget.textContent = text;
      state.budget.hidden = !text;
    } catch { /* no warning */ }
  }
  /** The request as it would go now ("Покажи промпта", D-047): no request is made. */
  async function showPromptNow(state) {
    if (state.promptBox.hidden) return;
    const run = (state.previewRun = (state.previewRun || 0) + 1);
    try {
      const settings = await getSettings();
      const t = state.threadId ? threads.find((x) => x.thread.id === state.threadId)?.thread : null;
      const messages = state.threadId ? await threadMessages(lesson, state.threadId) : [];
      const followUp = messages.some((m) => m.role === 'user');
      const src = t || state.draft;
      const { text } = await previewTeacher({
        settings, course, lesson, quote: src?.quote || '', paragraph: src?.paragraph || '', path: src?.path || [],
        question: state.textarea.value.trim() || '…', history: threadHistory(messages), followUp,
      });
      if (run === state.previewRun && !state.closed) state.promptBox.textContent = text;
    } catch (err) {
      console.warn('Cannot build the prompt:', err?.message || err);
      if (run === state.previewRun && !state.closed) state.promptBox.textContent = 'Промптът не може да се сглоби сега.';
    }
  }

  /** One message of a thread in the panel. */
  function messageView(m, all, state) {
    if (m.role === 'user') {
      return h('div', { class: 'thread__q', 'data-message': m.id, 'data-role': 'user' },
        h('span', { class: 'thread__who', text: 'Ти' }), h('p', { class: 'thread__q-text', text: m.content }));
    }
    const live = running.get(m.id);
    const stale = isStale(m, new Set(running.keys()));
    const status = live ? 'streaming' : stale ? 'error' : m.status;
    const text = live ? live.text : m.content;
    const body = h('div', { class: 'thread__a-body md', 'data-field': 'answer-text' }, text ? renderMarkdown(text, { headingOffset: 3 }) : null);
    const lastUser = [...all].reverse().find((x) => x.role === 'user');
    const isLast = lastUser && m.replyTo === lastUser.id;
    const foot = [];
    if (status === 'streaming') foot.push(h('p', { class: 'thread__state', 'data-field': 'answer-state', text: text ? 'Учителят пише…' : 'Чакам отговора…' }));
    if (status === 'done' && Number.isFinite(Number(m.costUSD))) {
      foot.push(h('p', { class: 'thread__cost', 'data-field': 'answer-cost', text: `Цена на отговора: ${formatUSD(m.costUSD)}` }));
    }
    if (status === 'error') {
      const why = stale ? 'Отговорът прекъсна (страницата беше затворена).' : (m.errorText || 'Отговорът не дойде.');
      foot.push(h('p', { class: 'thread__error', 'data-field': 'answer-error', role: 'alert' },
        m.interrupted || (stale && text) ? `${why} Показано е полученото дотук.` : why,
        m.errorKind === 'no-key' || m.errorKind === 'auth' || m.errorKind === 'bad-key' ? h('span', {}, ' ', settingsLink()) : null));
      if (isLast) foot.push(press(button({ class: 'button', 'data-action': 'question-retry' }, 'Опитай пак'), () => retryAnswer(state, m)));
    }
    return h('div', { class: 'thread__a', 'data-message': m.id, 'data-role': 'assistant', 'data-status': status },
      h('span', { class: 'thread__who', text: 'Учителят' }), body, ...foot);
  }
  /** Draw the messages of the open thread again (the field and its text stay). */
  async function paintThread(state) {
    if (!state.threadId || state.closed || !state.log) return;
    let messages = [];
    try { messages = await threadMessages(lesson, state.threadId); } catch { return; }
    if (state.closed || asking !== state) return;
    state.messages = messages;
    mount(state.log, messages.map((m) => messageView(m, messages, state)));
    const busy = messages.some((m) => running.has(m.id));
    state.send.disabled = busy;
    state.cancel.hidden = !busy;
    state.textarea.setAttribute('aria-label', 'Следващ въпрос към учителя');
    state.textarea.placeholder = 'Следващ въпрос…';
    if (state.deleteButton) state.deleteButton.hidden = false;
  }
  /** An answer coming in: only its own block is drawn again, at most every STREAM_PAINT_MS. */
  function paintStream(id) {
    const live = running.get(id);
    if (!live || live.paintTimer) return;
    live.paintTimer = setTimeout(() => {
      live.paintTimer = 0;
      const state = asking;
      if (!state || state.threadId !== live.threadId) return;
      const box = state.log?.querySelector(`[data-message="${CSS.escape(id)}"]`);
      if (!box) return;
      mount(box.querySelector('[data-field="answer-text"]'), renderMarkdown(live.text, { headingOffset: 3 }));
      const st = box.querySelector('[data-field="answer-state"]');
      if (st) st.textContent = 'Учителят пише…';
    }, STREAM_PAINT_MS);
  }

  /**
   * Open a thread (`threadId`) or a new question (`draft`: { place, quote,
   * found, paragraph, path, annotation }; a draft of the lesson as a whole: {}).
   */
  async function openThread({ threadId = null, draft = null, focusField = false, from = null, scroll = false } = {}) {
    const active = document.activeElement;
    const fromPanel = panel.contains(active);
    await closePanel();
    if (destroyed) return;
    returnFocus = from || (fromPanel || !active || active === document.body || !active.isConnected ? homeButton() : active);
    const item = threadId ? orderedThreads().all.find((x) => x.thread.id === threadId) : null;
    if (threadId && !item) return;
    const annotation = item ? item.annotation : draft?.annotation || null;
    if (annotation && item) {
      if (scroll && stateOf(annotation) !== 'orphan') showPlace(annotation.id);
      else getFrame()?.focus(annotation.id);
      if (!phone) keepPlace = { id: annotation.id, until: performance.now() + 1500 };
    }
    const quote = item ? (annotation?.selector?.quote?.exact || item.thread.quote) : draft?.quote || '';
    const state = { question: true, threadId, draft: item ? null : (draft || {}), typed: '', closed: false };
    asking = state;
    const log = h('div', { class: 'thread__log', 'data-field': 'thread-log', 'aria-live': 'polite' });
    state.log = log;
    const toQuestions = press(button({ class: 'notes-panel__back', 'data-action': 'questions-back-to-list' }, '← Всички въпроси'), () => openQuestions());
    const showButton = annotation && stateOf(annotation) !== 'orphan' && item
      ? press(button({ class: 'button notes-panel__show', 'data-action': 'show-thread-place' }, 'Покажи мястото'), () => showPlace(annotation.id)) : null;
    const deleteButton = press(button({ class: 'button notes-panel__delete', 'data-action': 'delete-thread', hidden: !threadId }, 'Изтрий въпроса'), () => removeThread(state));
    state.deleteButton = deleteButton;
    const found = item ? item.thread.quoteFound !== false : draft?.found !== false;
    setMode('thread');
    panelTitle.textContent = 'Въпрос към учителя';
    mount(panelBody,
      toQuestions,
      quote
        ? h('blockquote', { class: 'notes-panel__quote', 'data-field': 'question-quote' }, quoted(quote, 400))
        : h('p', { class: 'notes-panel__hint', 'data-field': 'question-quote', 'data-whole': 'true', text: `Въпрос за ${lesson.kind === 'reference' ? 'справочника' : 'урока'} като цяло.` }),
      annotation && item ? stateBadge(annotation) : null,
      quote && !found ? h('p', { class: 'notes-panel__hint', 'data-field': 'question-quote-unknown', text: '⚠ Този текст не е намерен в файла на урока (може да е създаден от скрипт на урока). Учителят ще го получи така, както е тук.' }) : null,
      log,
      composer(state),
      h('div', { class: 'notes-panel__actions thread__actions' }, showButton, deleteButton));
    showBudget(state);
    if (threadId) await paintThread(state);
    if (asking !== state) return;
    if (focusField) state.textarea.focus({ preventScroll: true });
    else panelTitle.focus({ preventScroll: true });
    requestAnimationFrame(() => { if (asking === state && !destroyed && annotation) keepThreadInView(annotation.id); });
  }
  function keepThreadInView(id) {
    const frame = getFrame();
    const f = frame?.frame;
    const place = frame?.layout?.get(id);
    if (!f || !place) return;
    const top = f.getBoundingClientRect().top + place.top;
    const { top: seenTop, bottom: coverBottom } = insets();
    if (top < seenTop + 4 || top > window.innerHeight - coverBottom - 24) frame.scrollToAnnotation(id);
  }

  /** "Изпрати": the question goes to the teacher (only from the app's own button / Ctrl+Enter). */
  async function sendQuestion(state) {
    if (state.sending || state.closed) return;
    state.voice?.cancel(); // T-041: what is in the field is what goes
    const question = state.textarea.value.trim().slice(0, MAX_QUESTION_LENGTH);
    if (!question) { state.status.textContent = 'Напиши въпроса си.'; state.textarea.focus({ preventScroll: true }); return; }
    if (state.messages?.some((m) => running.has(m.id))) return;
    state.sending = true;
    state.send.disabled = true;
    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        state.keyNote.hidden = false;
        state.status.textContent = 'Няма API ключ: въведи го в Настройки.';
        announce('Няма API ключ. Въведи го в Настройки.');
        return;
      }
      state.keyNote.hidden = true;
      const settings = await getSettings();
      let thread;
      if (!state.threadId) {
        const d = state.draft || {};
        const made = await startThread({ course, lesson, place: d.place || {}, quote: d.quote || '', paragraph: d.paragraph || '', path: d.path || [], quoteFound: d.found !== false });
        thread = made.thread;
        state.threadId = thread.id;
        state.draft = null;
        if (made.createdAnnotation) await getFrame()?.reloadAnnotations();
      } else {
        thread = (await lessonThreads(lesson)).find((x) => x.thread.id === state.threadId)?.thread;
        if (!thread) throw new Error('thread gone');
      }
      const messages = await threadMessages(lesson, thread.id);
      const followUp = messages.some((m) => m.role === 'user');
      const sent = sentText(thread, lesson, question, followUp);
      const { assistant } = await addExchange(lesson, thread.id, { question, sent });
      state.textarea.value = '';
      state.typed = '';
      state.status.textContent = '';
      runAnswer({ state, thread, assistant, question, followUp, history: threadHistory(messages), settings, apiKey });
      await reload();
      // A question about the lesson asked in the list: its thread opens.
      if (state.list) { if (asking === state) await openThread({ threadId: thread.id, focusField: true }); return; }
      await paintThread(state);
    } catch (err) {
      console.warn('Cannot ask the question:', err?.message || err);
      state.status.textContent = 'Въпросът не можа да се изпрати. Опитай пак.';
    } finally {
      state.sending = false;
      if (!state.messages?.some((m) => running.has(m.id)) && asking === state) state.send.disabled = false;
    }
  }
  /** Stream one answer into its message; kept in the database at the end (also when the panel is closed). */
  async function runAnswer({ thread, assistant, question, followUp, history, settings, apiKey }) {
    const controller = new AbortController();
    const live = { controller, text: '', threadId: thread.id, paintTimer: 0 };
    running.set(assistant.id, live);
    try {
      const r = await askTeacher({
        apiKey, settings, course, lesson, quote: thread.quote || '', paragraph: thread.paragraph || '', path: thread.path || [],
        question, history, followUp, signal: controller.signal,
        onText: (_d, all) => { live.text = all; paintStream(assistant.id); },
      });
      await finishAnswer(assistant.id, {
        content: r.text, status: 'done', interrupted: false, costUSD: r.costUSD, usage: r.usage, model: r.model, stopReason: r.stopReason || null,
      }, assistant.run);
      announce('Учителят отговори.');
      if (r.month?.over) announce(budgetWarning(r.month));
    } catch (err) {
      const kind = err?.kind || 'error';
      const text = err?.text || 'Отговорът не дойде. Опитай пак.';
      await finishAnswer(assistant.id, {
        content: typeof err?.partial === 'string' ? err.partial : live.text, status: 'error', interrupted: Boolean(err?.interrupted || (kind === 'aborted' && live.text)),
        errorKind: kind, errorText: kind === 'aborted' ? 'Отказано: отговорът е спрян.' : text,
      }, assistant.run).catch(() => {});
      announce(kind === 'aborted' ? 'Отговорът е спрян.' : text);
    } finally {
      clearTimeout(live.paintTimer);
      running.delete(assistant.id);
      if (!destroyed) {
        await reload();
        if (asking?.threadId === thread.id) {
          await paintThread(asking);
          showBudget(asking);
        }
      }
    }
  }
  function cancelAnswer(state) {
    for (const live of running.values()) if (live.threadId === state.threadId) live.controller.abort();
  }
  /** "Опитай пак": the last question again, into the same answer. */
  async function retryAnswer(state, answer) {
    if (running.size && [...running.values()].some((l) => l.threadId === state.threadId)) return;
    try {
      const apiKey = await getApiKey();
      if (!apiKey) { state.keyNote.hidden = false; state.status.textContent = 'Няма API ключ: въведи го в Настройки.'; return; }
      const settings = await getSettings();
      const thread = (await lessonThreads(lesson)).find((x) => x.thread.id === state.threadId)?.thread;
      const messages = await threadMessages(lesson, state.threadId);
      const user = messages.find((m) => m.id === answer.replyTo);
      if (!thread || !user) return;
      const history = threadHistory(messages, user.id);
      const followUp = messages.some((m) => m.role === 'user' && m.id < user.id);
      const restarted = await restartAnswer(answer.id);
      runAnswer({ state, thread, assistant: restarted, question: user.content, followUp, history, settings, apiKey });
      await paintThread(state);
    } catch (err) {
      console.warn('Cannot ask again:', err?.message || err);
      state.status.textContent = 'Не можа да се опита пак.';
    }
  }
  async function removeThread(state) {
    if (!state.threadId) return;
    cancelAnswer(state);
    try {
      const entry = await deleteThread(lesson, state.threadId);
      if (entry.annotationDeleted) await getFrame()?.reloadAnnotations();
      await reload();
      if (asking === state) await closePanel({ focus: true });
      offerUndo(entry, 'Въпросът е изтрит.');
    } catch (err) {
      console.warn('Cannot delete the question:', err?.message || err);
      announce('Въпросът не можа да се изтрие.');
    }
  }

  /** The questions of the lesson (D-047): a new one about the lesson as a whole + the list, ▲ / ▼. */
  async function openQuestions({ focusField = false } = {}) {
    const from = document.activeElement;
    await closePanel();
    if (destroyed) return;
    returnFocus = from === document.body ? questionsButton : from;
    const state = { question: true, threadId: null, draft: {}, typed: '', closed: false, list: true };
    asking = state;
    const listBox = h('div', { class: 'thread__list', 'data-field': 'questions-list' });
    state.listBox = listBox;
    setMode('questions');
    panelTitle.textContent = 'Въпроси към учителя';
    mount(panelBody,
      h('h3', { class: 'notes-list__heading', text: `Въпрос за ${lesson.kind === 'reference' ? 'справочника' : 'урока'} като цяло` }),
      composer(state),
      listBox);
    refreshQuestionList();
    showBudget(state);
    if (focusField) state.textarea.focus({ preventScroll: true });
    else panelTitle.focus({ preventScroll: true });
  }
  function refreshQuestionList() {
    const state = asking;
    if (!state?.listBox || panelMode !== 'questions') return;
    const { placed, whole, orphans, all } = orderedThreads();
    const first = (x) => x.messages.find((m) => m.role === 'user')?.content || x.thread.title || '';
    const item = (x) => h('li', { class: 'notes-list__item', 'data-thread': x.thread.id, 'data-state': x.annotation ? stateOf(x.annotation) : x.thread.annotationId ? 'orphan' : 'whole' },
      press(button({ class: 'notes-list__open', 'data-action': 'open-thread' },
        x.thread.annotationId
          ? h('span', { class: 'notes-list__quote', text: quoted(x.annotation?.selector?.quote?.exact || x.thread.quote, 160) })
          : h('span', { class: 'notes-list__quote', text: 'За урока като цяло' }),
        x.annotation ? stateBadge(x.annotation) : x.thread.annotationId ? h('span', { class: 'notes-badge notes-badge--orphan', 'data-state': 'orphan', text: 'неприкачен' }) : null),
      () => openThread({ threadId: x.thread.id, scroll: Boolean(x.annotation) && stateOf(x.annotation) !== 'orphan' })),
      h('p', { class: 'notes-list__body', text: `${short(first(x), 300)}${x.messages.length > 2 ? ` (+${Math.floor(x.messages.length / 2) - 1})` : ''}` }));
    mount(state.listBox,
      h('h3', { class: 'notes-list__heading', text: `Всички въпроси (${all.length})` }),
      all.length ? null : h('p', { class: 'notes-panel__hint', 'data-field': 'questions-empty', text: 'Още няма въпроси. Задръж пръста върху текста на урока и натисни „💬 Въпрос“ — или питай тук за целия урок.' }),
      placed.length || whole.length ? h('ol', { class: 'notes-list', 'data-field': 'threads-list' }, [...placed, ...whole].map(item)) : null,
      orphans.length ? h('section', { class: 'notes-list__orphans', 'data-field': 'threads-orphans' },
        h('h3', { class: 'notes-list__heading', text: `Неприкачени (${orphans.length})` }),
        h('ul', { class: 'notes-list' }, orphans.map(item))) : null);
  }
  /** ▲ / ▼ in the panel of a question: the previous / next thread in the text. */
  function stepThread(dir) {
    const list = orderedThreads().placed.filter((x) => topOf(x) !== null).sort((a, b) => topOf(a) - topOf(b));
    if (!list.length) { announce(threads.length ? 'Въпросите на този урок не са закачени в текста: виж списъка.' : 'В този урок още няма въпроси.'); return; }
    const openId = panelMode === 'thread' && asking?.threadId;
    let i = openId ? list.findIndex((x) => x.thread.id === openId) : -1;
    let target;
    if (i >= 0) target = list[i + dir];
    else {
      const f = getFrame()?.frame;
      const y = f ? (window.innerHeight / 3) - f.getBoundingClientRect().top : 0;
      target = dir > 0 ? list.find((x) => topOf(x) > y + 4) : [...list].reverse().find((x) => topOf(x) < y - 4);
    }
    if (!target) { announce(dir > 0 ? 'Това е последният въпрос.' : 'Това е първият въпрос.'); return; }
    i = list.indexOf(target);
    openThread({ threadId: target.thread.id, scroll: true });
    announce(`Въпрос ${i + 1} от ${list.length}.`);
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
    if (panelMode === 'thread' || panelMode === 'questions') { stepThread(dir); return; }
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
    let found = threads;
    try { list = await lessonNotes(lesson); } catch (err) { console.warn('Cannot read the notes:', err?.name || err); }
    try { found = await lessonThreads(lesson); } catch (err) { console.warn('Cannot read the questions:', err?.name || err); }
    if (destroyed || run !== reloadRun) return;
    notes = list;
    threads = found;
    refreshCounts();
    queuePlace();
    if (panelMode === 'list') {
      const scroll = panelBody.scrollTop;
      await openList();
      panelBody.scrollTop = scroll;
    } else if (panelMode === 'questions') {
      refreshQuestionList();
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
    // T-023: the number of questions on the 💬.
    const nq = threads.length;
    questionsCount.textContent = nq ? String(nq) : '';
    const qLabel = nq ? `Въпрос към учителя за урока; въпроси: ${nq}` : 'Въпрос към учителя за урока';
    questionsButton.setAttribute('aria-label', qLabel);
    element.dataset.questions = String(nq);
    fixRove();
    refreshPhoneList();
  }

  const onResize = () => {
    if (destroyed) return;
    const next = readerLayout();
    if (next !== layout) {
      layout = next;
      phone = layout === 'phone';
      applyLayout();
      // The note's place where it is seen in the new layout (after the lesson reflowed).
      if (panelMode === 'note' && editing?.annotationId) keepPlace = { id: editing.annotationId, until: performance.now() + 1500 };
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
  /** The field the guard is for now: the note's or the question's (T-023). */
  const currentField = () => editing || asking;
  /**
   * T018-D2 (and T-023 for the question): the field `ed.textarea` keeps the
   * keyboard while it has the focus — the lesson's frame is guarded (keys off,
   * a layer over it); a focus stolen by the lesson comes straight back.
   */
  function attachFieldGuard(ed) {
    const field = ed.textarea;
    field.addEventListener('focus', () => { ed.focusedAt = performance.now(); if (currentField() === ed) guardFrame(); });
    field.addEventListener('blur', () => {
      if (ed.reclaiming) return;
      // The user's own move (a press in the app, Tab / Escape / F6, since the field got the focus) — or a steal.
      const own = !guarded || (lastUserMove > (ed.focusedAt ?? 0) && performance.now() - lastUserMove < USER_MOVE_MS);
      const back = () => {
        if (currentField() !== ed || !guarded) return;
        const at = document.activeElement;
        if (at === field || (at !== guarded.frame && at !== document.body && at !== null)) return;
        reclaimFocus(ed);
      };
      if (own) { queueMicrotask(() => { if (document.activeElement !== field) unguardFrame(); }); return; }
      queueMicrotask(back);
      setTimeout(back, 0);
    });
  }
  /** Bring the keyboard back into the note field (the lesson took it). */
  function reclaimFocus(ed) {
    if (currentField() !== ed || !guarded) return;
    const ta = ed.textarea;
    // With the lesson in its own process the browser hands the focus over
    // asynchronously: the field lets go now (its focus() would do nothing while
    // it is still the active element here) and takes it back in the next task.
    ed.reclaiming = true;
    try { if (document.activeElement === ta) ta.blur(); } finally { ed.reclaiming = false; }
    setTimeout(() => { if (currentField() === ed && guarded) ta.focus({ preventScroll: true }); }, 0);
    if (!ed.stolen) announce(ed.question ? 'Урокът се опита да вземе фокуса; полето за въпроса го задържа.' : 'Урокът се опита да вземе фокуса; бележката го задържа.');
    ed.stolen = (ed.stolen || 0) + 1;
  }
  const guardLayer = h('div', { class: 'note-guard', 'data-field': 'note-guard', 'aria-hidden': 'true' });
  guardLayer.addEventListener('pointerdown', () => {
    const ta = currentField()?.textarea;
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
  // T070-D2: a note emptied when the page went last time was deleted at this start: "Върни".
  // T072-D1: every such note of this lesson — one "Върни" brings them all back.
  takeEmptiedNotes(lesson.id).then((entries) => {
    if (!entries.length || destroyed) return;
    offerUndo(entries, entries.length === 1
      ? 'Празната бележка е изтрита (беше изпразнена преди затварянето).'
      : `${entries.length} празни бележки са изтрити (бяха изпразнени преди затварянето).`);
  }).catch(() => {});

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
      // T070-S2: while the note field is guarded no press of the user reaches the
      // lesson (the layer lies over it): a tap from the lesson then is its own.
      if (!annotation || getTool() || guarded) return;
      const item = notes.find((x) => x.annotation.id === annotation.id);
      if (item) { openNote(item.note.id); return; }
      const thread = threads.find((x) => x.thread.annotationId === annotation.id);
      if (thread) { openThread({ threadId: thread.thread.id }); return; }
      if (COLORS.includes(annotation.color)) openMarkCard(annotation);
    },
    onLayout(next) {
      places = next;
      queuePlace();
      // The lesson reflowed for the note column: the note's place back into view (once, just after opening).
      if (keepPlace && performance.now() < keepPlace.until && panelMode) {
        const id = keepPlace.id;
        keepPlace = null;
        getFrame()?.scrollToAnnotation(id);
      }
    },
    onAnchored() { refreshCounts(); queuePlace(); if (panelMode === 'list' || panelMode === 'questions') reload(); },
    /** The tool changed: no "Бележка" while a tool is on. */
    onTool() { showSelectionButtons(); },
    reload,
    /** Escape inside the lesson (lrn:escape). */
    escape() {
      // T070-S2: no key of the user reaches the lesson while the note field is
      // guarded — an Escape from the lesson then is forged: the note stays open.
      if (guarded) return true;
      if (panelMode) { closePanel({ focus: true }); return true; }
      return false;
    },
    destroy() {
      if (destroyed) return;
      const ed = editing;
      if (ed) save(ed); // the last text is written (the save does not need this screen)
      destroyed = true;
      dropVoices();
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
      clearTimeout(splitTimer);
      setCover(0);
      window.visualViewport?.removeEventListener('resize', fitViewport);
      observer?.disconnect();
    },
  };
}
