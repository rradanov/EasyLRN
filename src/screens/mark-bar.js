// The bottom bar of the reader (T-015, D-019, UI-DESIGN §5).
//
// A FIXED bar at the bottom of the screen, never a floating menu: the
// system selection menu of Android Chrome cannot be hidden and would cover
// one. Its modes:
// - "selection": a selection in the lesson — the quote and the five colours
//   (one press = a mark in that colour); Бележка / Попитай учителя / Развий
//   ми го are shown but not active yet (T-017 / T-023 / T-025: "скоро");
// - "excluded": a selection only inside an exercise or a part the lesson
//   excludes (`.quiz`, data-lrn-noanno): no colours there (ARCHITECTURE §4.1);
// - "mark": the card of a mark that was tapped — its quote, its colour
//   (pressed), another colour, "Изтрий" (with a confirmation if notes,
//   threads or subtopics hang on it, and "Отмени" afterwards); a mark found
//   only approximately says so and offers "Да, тук е" (UI-DESIGN §10);
// - "undo": "Маркировката е изтрита. [Отмени]" for a few seconds.
// Everything is built with textContent (the quote comes from the lesson).
// Keyboard: Tab reaches it after the lesson; Escape closes it. A swipe down
// on it closes it too (UI-DESIGN §9). Buttons are ≥ 48 px high.
import { h, mount } from '../dom.js';
import { confirmBox } from './confirm.js';

const QUOTE_MAX = 160;
const UNDO_MS = 8000;

const shortQuote = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return `«${t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1)}…` : t}»`;
};

/**
 * @param {{ colors: {id: string, name: string, label: string}[],
 *   onColor: (color: string) => void, onDelete: () => void, onUndo: () => void,
 *   onConfirmPlace: () => void, onClose: () => void }} handlers
 */
export function createMarkBar({ colors, onColor, onDelete, onUndo, onConfirmPlace, onClose }) {
  let mode = null;
  let undoTimer = null;
  let pointerAt = 0;

  const quote = h('p', { class: 'markbar__quote', 'data-field': 'markbar-quote' });
  const close = h('button', { type: 'button', class: 'markbar__close', 'data-action': 'markbar-close', 'aria-label': 'Затвори лентата', title: 'Затвори' }, '✕');
  const note = h('p', { class: 'markbar__note', 'data-field': 'markbar-note', hidden: true });
  const colorButtons = colors.map((c) => h('button', {
    type: 'button',
    class: 'markbar__color',
    'data-color': c.id,
    'aria-pressed': 'false',
    'aria-label': c.label ? `${c.name} (${c.label})` : c.name,
    title: c.label ? `${c.name} — ${c.label}` : c.name,
    onclick: () => { if (mode === 'selection' || mode === 'mark') onColor(c.id); },
  }, h('span', { class: 'markbar__swatch', 'aria-hidden': 'true' }), h('span', { class: 'markbar__label', text: c.label || c.name })));
  const colorsBox = h('div', { class: 'markbar__colors', role: 'group', 'aria-label': 'Цвят на маркировката' }, colorButtons);
  // Not yet (T-017 / T-023 / T-025): visible, so the user knows where they will be.
  const soon = (action, icon, text, task) => h('button', {
    type: 'button', class: 'button markbar__soon', 'data-action': action, 'aria-disabled': 'true',
    title: `${text} — скоро`, onclick: () => say(`„${text}“ идва в следваща версия.`),
  }, h('span', { 'aria-hidden': 'true', text: icon }), ` ${text}`, h('span', { class: 'markbar__soon-tag', text: 'скоро' }), h('span', { class: 'visually-hidden', text: ` (${task})` }));
  const soonButtons = [soon('note', '📝', 'Бележка', 'T-017'), soon('ask', '💬', 'Попитай учителя', 'T-023'), soon('expand', '✨', 'Развий ми го', 'T-025')];
  const confirmPlace = h('button', { type: 'button', class: 'button markbar__confirm-place', 'data-action': 'confirm-place', hidden: true, onclick: () => onConfirmPlace() }, '✓ Да, тук е');
  const del = h('button', { type: 'button', class: 'button markbar__delete', 'data-action': 'delete', hidden: true, onclick: () => onDelete() },
    h('span', { 'aria-hidden': 'true', text: '🗑' }), ' Изтрий');
  const undo = h('button', { type: 'button', class: 'button markbar__undo', 'data-action': 'undo', hidden: true, onclick: () => { clearTimeout(undoTimer); onUndo(); } }, 'Отмени');
  const actions = h('div', { class: 'markbar__actions' }, confirmPlace, del, undo, ...soonButtons);
  const confirmArea = h('div', { class: 'markbar__confirm', 'data-field': 'markbar-confirm' });
  const status = h('p', { class: 'markbar__status', role: 'status', 'aria-live': 'polite', 'data-field': 'markbar-status' });
  const element = h('div', { class: 'markbar', role: 'region', 'aria-label': 'Маркиране', 'data-field': 'markbar', hidden: true },
    h('div', { class: 'markbar__top' }, quote, close),
    note,
    h('div', { class: 'markbar__row' }, colorsBox, actions),
    confirmArea,
    status);

  function say(text) { status.textContent = text; }

  // The height of the bar keeps the end of the page above it (styles: --markbar-h).
  const setHeight = () => {
    const height = element.hidden ? 0 : Math.ceil(element.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--markbar-h', `${height}px`);
  };
  let observer = null;
  try { observer = new ResizeObserver(setHeight); observer.observe(element); } catch { observer = null; }

  // A press in the bar keeps it (the lesson may report an empty selection when it loses the focus).
  element.addEventListener('pointerdown', () => { pointerAt = performance.now(); }, true);
  // Mouse: a press does not take the focus from the lesson (its selection stays visible).
  element.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  close.addEventListener('click', () => onClose());
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  });
  // A swipe down closes it (UI-DESIGN §9).
  let swipe = null;
  element.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'mouse') swipe = { y: event.clientY, x: event.clientX }; });
  element.addEventListener('pointerup', (event) => {
    if (!swipe) return;
    const dy = event.clientY - swipe.y;
    const dx = Math.abs(event.clientX - swipe.x);
    swipe = null;
    if (dy > 60 && dx < dy) onClose();
  });
  element.addEventListener('pointercancel', () => { swipe = null; });

  const show = (next) => {
    mode = next;
    clearTimeout(undoTimer);
    element.dataset.mode = next;
    element.hidden = false;
    mount(confirmArea);
    setHeight();
  };
  const setColors = (enabled, pressed) => {
    for (const b of colorButtons) {
      b.disabled = !enabled;
      b.setAttribute('aria-pressed', String(b.dataset.color === pressed));
    }
  };

  const api = {
    element,
    get mode() { return mode; },
    get visible() { return !element.hidden; },
    /** Was the bar pressed in the last `ms` milliseconds? */
    pressedWithin: (ms) => performance.now() - pointerAt < ms,
    showSelection(selection) {
      show(selection.excludedOnly ? 'excluded' : 'selection');
      quote.textContent = shortQuote(selection.quote?.exact);
      quote.title = '';
      note.hidden = !selection.excludedOnly;
      note.textContent = selection.excludedOnly ? 'В упражнения и в частите, които урокът изключва, не се маркира с цвят. Въпрос към учителя за този текст — скоро.' : '';
      setColors(!selection.excludedOnly, null);
      confirmPlace.hidden = true;
      del.hidden = true;
      undo.hidden = true;
      for (const b of soonButtons) b.hidden = false;
      colorsBox.hidden = false;
      say('');
    },
    /** The card of a mark: `annotation` with its `anchorState`. */
    showMark(annotation) {
      show('mark');
      quote.textContent = shortQuote(annotation.selector?.quote?.exact);
      const fuzzy = annotation.anchorState === 'fuzzy';
      note.hidden = !fuzzy;
      note.textContent = fuzzy ? 'Текстът на урока тук е променен. Провери дали маркировката е на правилното място.' : '';
      setColors(true, annotation.color);
      confirmPlace.hidden = !fuzzy;
      del.hidden = false;
      undo.hidden = true;
      for (const b of soonButtons) b.hidden = false;
      colorsBox.hidden = false;
      setHeight();
    },
    /** "Маркировката е изтрита. [Отмени]" for a few seconds, then hidden. */
    showUndo(text) {
      show('undo');
      quote.textContent = text;
      note.hidden = true;
      colorsBox.hidden = true;
      confirmPlace.hidden = true;
      del.hidden = true;
      undo.hidden = false;
      for (const b of soonButtons) b.hidden = true;
      setHeight();
      undoTimer = setTimeout(() => { if (mode === 'undo') api.hide(); }, UNDO_MS);
      undo.focus({ preventScroll: true });
    },
    /** A confirmation inside the bar (the safe answer has the focus). */
    confirm({ text, yes, onYes }) {
      const box = confirmBox({
        text, yes, label: 'Изтриване на маркировка',
        onYes: () => { mount(confirmArea); setHeight(); onYes(); },
        onNo: () => { mount(confirmArea); setHeight(); del.focus({ preventScroll: true }); },
      });
      mount(confirmArea, box);
      setHeight();
      box.focusCancel();
    },
    say,
    hide() {
      mode = null;
      clearTimeout(undoTimer);
      element.hidden = true;
      delete element.dataset.mode;
      mount(confirmArea);
      say('');
      setHeight();
    },
    destroy() {
      clearTimeout(undoTimer);
      observer?.disconnect();
      document.documentElement.style.setProperty('--markbar-h', '0px');
    },
  };
  return api;
}
