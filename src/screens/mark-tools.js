// The marking tools of the reader (T-015, D-042, replaces the selection + bottom
// bar of D-019 for colours).
//
// - A vertical tool bar LEFT of the lesson, in the app (never in the lesson):
//   marker (background), pencil (a line under the text), eraser, the five
//   colours (yellow, green, blue, orange, pink) and "Отмени" (the last action:
//   a mark, a line, an erase). Buttons ≥ 48 px; aria-pressed; a toolbar with
//   arrow keys; Escape turns the tool off; Ctrl+Z undoes. The colour and the
//   last drawing tool are a setting (`markTool`), kept between lessons and
//   reloads; a lesson always opens with NO tool on (T-062, D-042 addendum of
//   21.11.2026: no drawing by surprise when one only wants to scroll).
// - The bar can be hidden (T-062): "Скрий" at its top; hidden, a small handle
//   "☰" (≥ 44 px) stays at the left edge and a tap on it (or a swipe out to the
//   right) brings the bar back. The state is kept (`markTool.hidden`); without a
//   stored state a narrow screen (a phone, < 600 px) starts hidden. Hiding turns
//   the tool off: nobody draws with a tool they cannot see.
// - With a tool on, a layer of the APP covers the lesson frame
//   (touch-action: none). Its pointer events are the user's own (trusted, in
//   the app's document): ONE finger / the pen / the mouse draws, TWO fingers
//   scroll the app window (pinch does not zoom and never draws). The points
//   go to the bridge in the lesson (lrn:stroke, frame coordinates), which turns
//   them into text (caret → model offsets, whole words) and paints a live
//   preview; at the end it answers once (lrn:stroked) and the app saves the
//   annotation (D-012 selectors, style highlight / underline, the colour of the
//   app). A lesson cannot start a stroke: the app asks, the bridge answers.
// - A tap with a tool on: marker / pencil → the lesson's own control at that
//   point is pressed (a quiz answer, a link); eraser → the mark under it is
//   erased (or the control is pressed if there is no mark).
// - Pen and palm (T016-D2, the rules at the layer below): a large contact is a
//   palm for the whole gesture; two touches scroll only when they land almost
//   together or then move together (comparably: T063-D1/D2); a touch landing
//   during a sure stroke or next to a resting one does not turn the pen /
//   finger into "a second finger" (the one that moves more draws, a young
//   stroke goes on from its first point); while a pen writes (and for a moment
//   after) touches are ignored.
// - Without a tool the layer is gone: the lesson scrolls and selects as usual
//   (long press: the system selection, for T-017/T-023/T-025). A selection
//   that exists when the marker / pencil is pressed is marked at once (the
//   keyboard / mouse way of marking).
import { h } from '../dom.js';
import { saveSettings, getAnnotation, COLORS } from '../db.js';
import { annotateSelection, deleteAnnotation, restoreAnnotation, setAnnotationColor, annotationDependents } from '../annotations.js';
import { TOOL_COLORS, DEFAULT_COLOR_NAMES, colorChoices } from '../highlight.js';

export const TOOLS = Object.freeze(['marker', 'pencil', 'eraser']);
const TOOL_NAMES = Object.freeze({ marker: 'Маркер', pencil: 'Молив', eraser: 'Гума' });
const TAP_SLOP_PX = 8;
const TAP_MS = 500;
// The palm rules (T016-D2, T063-D1/D2): ALL their thresholds are here.
const PALM_SIDE_PX = 70; // a touch with a side this long is a palm, not a finger
const PALM_AREA_PX = 45 * 45; // … or with this contact area (the side of the hand)
const PAIR_MS = 150; // two touches landing within this are two fingers (scrolling)
const YOUNG_MS = 250; // a stroke younger than this …
const YOUNG_PX = 40; // … and shorter than this is not sure yet: a second touch reopens the question (T063-D1)
const PENDING_PX = 24; // two touches, one moving: the one that moved this far (alone) draws
const TOGETHER_PX = 6; // both moved at least this …
const SCROLL_RATIO = 0.5; // … and the slower moved at least this part of the faster → scrolling
const SCROLL_RATIO_PALM = 0.75; // … the same when the slower is the larger contact (a drifting palm, T063-D2)
const PALM_BIGGER = 2; // "the larger contact": this many times the area of the other
const PEN_GRACE_MS = 700; // touches right after the pen lifted: still the palm
const PATH_MAX = 256; // points of a young stroke kept to replay it when it goes on
const UNDO_MAX = 50;
const NARROW_PX = 600; // below this width (a phone) the bar starts hidden
const SWIPE_OUT_PX = 24; // a swipe to the right on the handle this long shows the bar
const SLIDE_MS = 200;
const CLICK_OF_TAP_MS = 700; // the click Chrome sends after a tap we already handled on pointerup
const SWITCH_GUARD_MS = 350; // a tap this soon after the bar / handle appeared is the rest of a double tap (T066-D4: Android's double tap is up to 300 ms)

const SVG = 'http://www.w3.org/2000/svg';
function icon(paths) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [d, fill] of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', fill ? '0' : '1.8');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('stroke-linecap', 'round');
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  marker: () => icon([['M14.5 3.5l6 6-8.5 8.5h-6v-6z'], ['M6 18l-2.5 2.5h5'], ['M10.5 7.5l6 6']]),
  pencil: () => icon([['M16.5 3.5l4 4L8 20H4v-4z'], ['M14 6l4 4'], ['M3 22h18']]),
  eraser: () => icon([['M8.5 20.5l-5-5 10-10 7 7-8 8z'], ['M8.5 20.5H20'], ['M7 12l5 5']]),
  undo: () => icon([['M9 6L4 11l5 5'], ['M4 11h10a5 5 0 0 1 0 10h-4']]),
  hide: () => icon([['M15 6l-6 6 6 6'], ['M20 6l-6 6 6 6']]),
  menu: () => icon([['M4 7h16'], ['M4 12h16'], ['M4 17h16']]),
};
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrowScreen = () => (window.innerWidth || document.documentElement.clientWidth) < NARROW_PX;

/**
 * The stored choice, checked (an unknown value → the default). The tool is
 * never taken from the store: a lesson opens without one (T-062). `hidden` is
 * true / false when the user chose, null when not yet (→ by the screen width).
 */
export function toolChoice(settings) {
  const s = settings?.markTool && typeof settings.markTool === 'object' ? settings.markTool : {};
  return {
    tool: null,
    color: TOOL_COLORS.includes(s.color) ? s.color : 'yellow',
    lastDraw: s.lastDraw === 'pencil' ? 'pencil' : 'marker',
    hidden: typeof s.hidden === 'boolean' ? s.hidden : null,
  };
}

/**
 * @param {{ getFrame: () => object|null, course: object, lesson: object, settings: object,
 *   announce: (text: string) => void, onChange?: (tool: string|null) => void,
 *   onLayout?: (hidden: boolean) => void, onErased?: () => void }} opts
 */
export function createMarkTools({ getFrame, course, lesson, settings, announce, onChange, onLayout, onErased }) {
  const choice = toolChoice(settings);
  let hidden = choice.hidden ?? narrowScreen();
  const names = new Map(colorChoices(settings).map((c) => [c.id, c]));
  const colorName = (id) => names.get(id)?.name || DEFAULT_COLOR_NAMES[id] || id;
  const colorLabel = (id) => { const c = names.get(id); return c?.label ? `${c.name} (${c.label})` : colorName(id); };
  const undo = [];
  let destroyed = false;

  // --- The bar -----------------------------------------------------------------------
  // A finger / pen presses a button on pointerup (Chrome drops the click of a
  // tap that comes right after a drawing stroke: seen in the manual check);
  // the mouse and the keyboard (Enter, Space) through `click`. One action per press.
  // T063-D8: the "click of the same tap" is dropped per BUTTON (the time of its
  // own last tap), and a click from the keyboard (detail 0) is never dropped.
  // T063-I6: a tap on a button of the bar right after the bar was shown or hidden
  // (the second tap of a double tap on the handle, now on a tool; or on "Скрий"
  // sliding away) is ignored. The handle has no such guard: it is not where
  // "Скрий" was (styles: margin-top), and it must answer at once.
  let switchedAt = -Infinity; // the bar was hidden / shown at this time
  // T066-D4 (350 ms): only a press near the touch that switched the bar is the
  // rest of a double tap; a press elsewhere (another control) acts at once.
  let switchedFrom = null; // { x, y } of that touch, null = not from a touch (time only)
  let lastTouch = null; // { x, y, t } of the last touch / pen press anywhere
  const onAnyPress = (e) => {
    if (e.pointerType !== 'mouse' && e.isPrimary) lastTouch = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  window.addEventListener('pointerdown', onAnyPress, true);
  const SWITCH_NEAR_PX = 64;
  const ghost = (e) => performance.now() - switchedAt < SWITCH_GUARD_MS
    && (switchedFrom === null || Math.hypot(e.clientX - switchedFrom.x, e.clientY - switchedFrom.y) <= SWITCH_NEAR_PX);
  function press(button, action, { guard = true } = {}) {
    let down = null;
    let tappedAt = -Infinity;
    button.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      down = guard && ghost(e) ? null : e.pointerId;
      if (down === null) tappedAt = performance.now(); // its click is the same ghost tap
    });
    button.addEventListener('pointercancel', () => { down = null; });
    button.addEventListener('pointerup', (e) => {
      if (down !== e.pointerId) return;
      down = null;
      const r = button.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom || button.disabled) return;
      tappedAt = performance.now();
      action();
    });
    button.addEventListener('click', (e) => {
      if (e.detail !== 0) { // a pointer click (the keyboard gives detail 0)
        const now = performance.now();
        if (now - tappedAt < CLICK_OF_TAP_MS) return; // the click of the same tap
        if (guard && ghost(e)) return; // a double click landing on the new control
      }
      action();
    });
    return button;
  }
  const toolButton = (tool) => h('button', {
    type: 'button', class: 'mark-tools__button mark-tools__tool', 'data-tool': tool,
    'aria-pressed': 'false', 'aria-label': TOOL_NAMES[tool], title: TOOL_NAMES[tool],
  }, ICONS[tool](), h('span', { class: 'mark-tools__label', 'aria-hidden': 'true', text: TOOL_NAMES[tool] }));
  const tools = Object.fromEntries(TOOLS.map((t) => [t, press(toolButton(t), () => pressTool(t))]));
  const colors = Object.fromEntries(TOOL_COLORS.map((c) => [c, press(h('button', {
    type: 'button', class: 'mark-tools__button mark-tools__color', 'data-color': c,
    'aria-pressed': 'false', 'aria-label': colorLabel(c), title: colorLabel(c),
  }, h('span', { class: 'mark-tools__swatch', 'aria-hidden': 'true' }, h('span', { class: 'mark-tools__check', text: '✓' }))), () => pressColor(c))]));
  const undoButton = press(h('button', {
    type: 'button', class: 'mark-tools__button mark-tools__undo', 'data-action': 'undo',
    'aria-label': 'Отмени', title: 'Отмени', disabled: true,
  }, ICONS.undo(), h('span', { class: 'mark-tools__label', 'aria-hidden': 'true', text: 'Отмени' })), () => runUndo());
  const hideButton = press(h('button', {
    type: 'button', class: 'mark-tools__button mark-tools__hide', 'data-action': 'hide-tools',
    'aria-label': 'Скрий инструментите', title: 'Скрий инструментите', 'aria-expanded': 'true', 'aria-controls': 'mark-tools',
  }, ICONS.hide(), h('span', { class: 'mark-tools__label', 'aria-hidden': 'true', text: 'Скрий' })), () => setHidden(true, { focus: true }));
  const hint = h('p', { class: 'mark-tools__hint', 'data-field': 'tool-hint', 'aria-hidden': 'true', hidden: true });
  const element = h('div', {
    class: 'mark-tools', role: 'toolbar', 'aria-label': 'Инструменти за маркиране', 'aria-orientation': 'vertical',
    'data-field': 'mark-tools', id: 'mark-tools',
  },
  hideButton,
  h('div', { class: 'mark-tools__group', role: 'group', 'aria-label': 'Инструмент' }, ...Object.values(tools)),
  h('div', { class: 'mark-tools__group', role: 'group', 'aria-label': 'Цвят' }, ...Object.values(colors)),
  undoButton,
  hint);

  // The handle of the hidden bar: a tap (pointerup / click / Enter / Space) or a
  // swipe out to the right brings the bar back. pan-y: a vertical move still
  // scrolls the page, a horizontal one comes to us.
  const handle = press(h('button', {
    type: 'button', class: 'mark-tools-handle', 'data-action': 'show-tools', 'data-field': 'mark-tools-handle',
    'aria-label': 'Покажи инструментите за маркиране', title: 'Покажи инструментите', 'aria-expanded': 'false', 'aria-controls': 'mark-tools',
  }, ICONS.menu()), () => setHidden(false, { focus: true }), { guard: false });
  let swipe = null;
  handle.addEventListener('pointerdown', (e) => { if (e.isPrimary) swipe = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
  handle.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    if (dx >= SWIPE_OUT_PX && dx > Math.abs(e.clientY - swipe.y)) { swipe = null; setHidden(false, { focus: true }); }
  });
  for (const type of ['pointerup', 'pointercancel']) handle.addEventListener(type, () => { swipe = null; });

  // Roving focus: one stop in the tab order, arrows move inside (WAI-ARIA toolbar).
  const buttons = () => [...element.querySelectorAll('button')].filter((b) => !b.disabled);
  const rove = (target) => { for (const b of element.querySelectorAll('button')) b.tabIndex = b === target ? 0 : -1; };
  element.addEventListener('keydown', (event) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const b = list[(next + list.length) % list.length];
    rove(b);
    b.focus();
  });
  element.addEventListener('focusin', (event) => { if (event.target instanceof HTMLButtonElement) rove(event.target); });

  let hintTimer = 0;
  const showHint = (text) => {
    hint.textContent = text;
    hint.hidden = !text;
    clearTimeout(hintTimer);
    if (text) hintTimer = setTimeout(() => { hint.hidden = true; }, 3500);
  };

  let slide = null;
  /** Hide / show the bar (kept). Hiding turns the tool off. */
  async function setHidden(next, { focus = false, save: keep = true } = {}) {
    next = !!next;
    if (next === hidden && element.hidden === next) return;
    hidden = next;
    switchedAt = performance.now();
    switchedFrom = lastTouch && switchedAt - lastTouch.t < 1000 ? { x: lastTouch.x, y: lastTouch.y } : null;
    if (keep) saveSettings({ markTool: { ...stored(), hidden } }).catch((err) => console.warn('Cannot save the bar:', err?.name || err));
    slide?.cancel();
    slide = null;
    const moving = !reducedMotion() && typeof element.animate === 'function';
    if (next) {
      const wasOn = choice.tool;
      if (wasOn) setTool(null, { quiet: true });
      showHint('');
      hideButton.setAttribute('aria-expanded', 'false');
      handle.setAttribute('aria-expanded', 'false');
      announce(wasOn ? 'Инструментите са скрити; инструментът е изключен.' : 'Инструментите са скрити.');
      if (moving) {
        slide = element.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(-110%)', opacity: 0 }], { duration: SLIDE_MS, easing: 'ease-in' });
        try { await slide.finished; } catch { return; } // cancelled: the other direction took over
        slide = null;
      }
      if (!hidden || destroyed) return;
      const inside = element.contains(document.activeElement);
      element.hidden = true;
      handle.hidden = false;
      if (focus || inside) handle.focus();
    } else {
      element.hidden = false;
      handle.hidden = true;
      hideButton.setAttribute('aria-expanded', 'true');
      handle.setAttribute('aria-expanded', 'true');
      announce('Инструментите са показани.');
      if (focus) (element.querySelector('button[tabindex="0"]:not(:disabled)') || tools.marker).focus();
      if (moving) {
        slide = element.animate([{ transform: 'translateX(-110%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: SLIDE_MS, easing: 'ease-out' });
        slide.finished.catch(() => {}).finally(() => { slide = null; });
      }
    }
    element.dataset.hidden = String(hidden);
    onLayout?.(hidden);
  }

  const render = () => {
    for (const t of TOOLS) tools[t].setAttribute('aria-pressed', String(choice.tool === t));
    for (const c of TOOL_COLORS) colors[c].setAttribute('aria-pressed', String(choice.color === c));
    element.dataset.tool = choice.tool || 'none';
    element.dataset.color = choice.color;
    const last = undo.at(-1);
    undoButton.disabled = !last;
    const what = last ? { create: last.style === 'underline' ? 'подчертаването' : 'маркирането', erase: 'изтриването' }[last.kind] : '';
    undoButton.setAttribute('aria-label', last ? `Отмени ${what}` : 'Отмени');
    undoButton.title = last ? `Отмени ${what}` : 'Няма какво да се отмени';
    if (!element.querySelector('button[tabindex="0"]:not(:disabled)')) rove(tools[choice.tool || 'marker']);
    layer.hidden = !choice.tool;
    layer.dataset.tool = choice.tool || 'none';
    onChange?.(choice.tool);
  };
  // The tool itself is not stored (a lesson opens without one): the colour, the
  // last drawing tool and whether the bar is hidden.
  const stored = () => ({ color: choice.color, lastDraw: choice.lastDraw, hidden });
  const save = () => saveSettings({ markTool: stored() }).catch((err) => console.warn('Cannot save the tool:', err?.name || err));

  function setTool(tool, { quiet = false } = {}) {
    const next = TOOLS.includes(tool) ? tool : null;
    if (next === choice.tool) return;
    if (next && hidden) setHidden(false); // a tool from the keyboard / the API: the bar comes back
    stopGesture();
    choice.tool = next;
    if (next === 'marker' || next === 'pencil') choice.lastDraw = next;
    render();
    save();
    if (next) {
      const what = next === 'eraser' ? 'Гума: докосни или мини през маркировка' : `${TOOL_NAMES[next]}, ${colorName(choice.color)}: рисувай с един пръст`;
      showHint(`${what}. Превъртай с два пръста.`);
      announce(`${TOOL_NAMES[next]} е включен${next === 'eraser' ? 'а' : ''}. Превъртай с два пръста.`);
    } else {
      showHint('');
      if (!quiet) announce('Инструментът е изключен. Урокът се превърта с един пръст.');
    }
  }
  function pressTool(tool) {
    if (choice.tool === tool) { setTool(null); return; } // a second tap turns it off
    setTool(tool);
    if (tool !== 'eraser') markSelection();
  }
  function pressColor(color) {
    choice.color = color;
    // A colour means "draw with it": the last drawing tool comes back if none (or the eraser) is on.
    if (choice.tool !== 'marker' && choice.tool !== 'pencil') setTool(choice.lastDraw);
    else { render(); save(); }
    announce(`Цвят: ${colorLabel(color)}.`);
    markSelection();
  }

  // --- Saving, undo ------------------------------------------------------------------
  const pushUndo = (entry) => { undo.push(entry); if (undo.length > UNDO_MAX) undo.shift(); render(); };
  async function createMark(found, tool, color) {
    const style = tool === 'pencil' ? 'underline' : 'highlight';
    const created = await annotateSelection({
      course, lesson, color, style,
      selection: { quote: found.quote, position: found.position, hint: found.hint || null },
    });
    pushUndo({ kind: 'create', id: created.id, style });
    await getFrame()?.reloadAnnotations();
    announce(`${style === 'underline' ? 'Подчертано' : 'Маркирано'}: ${colorName(color)}.`);
    return created;
  }
  // T-017 (D-045): the eraser deletes only the marking. A mark with a note (or
  // anything else on it) keeps its annotation without a colour: the note stays
  // at its place; "Отмени" brings the colour back.
  async function eraseMarks(ids) {
    const done = []; // { id, color } — color: the colour taken away, null: the annotation was deleted
    for (const id of ids) {
      try {
        const a = await getAnnotation(id);
        if (!a || !COLORS.includes(a.color)) continue; // a place with a note only: not a mark
        const on = await annotationDependents(id);
        if (on.notes || on.threads || on.subtopics) {
          await setAnnotationColor(lesson, id, null);
          done.push({ id, color: a.color });
        } else {
          await deleteAnnotation(lesson, id);
          done.push({ id, color: null });
        }
      } catch (err) { console.warn('Cannot delete the mark:', err?.message || err); }
    }
    await getFrame()?.reloadAnnotations();
    if (!done.length) return;
    pushUndo({ kind: 'erase', items: done });
    const kept = done.some((d) => d.color) ? ' Бележката остава.' : '';
    announce(done.length === 1 ? `Маркировката е изтрита.${kept} „Отмени“ я връща.` : `Изтрити маркировки: ${done.length}.${kept} „Отмени“ ги връща.`);
    onErased?.();
  }
  let busy = Promise.resolve();
  const queue = (work) => { busy = busy.then(work).catch((err) => { console.warn('Marking failed:', err?.message || err); announce('Маркировката не можа да се запише.'); }); return busy; };
  function runUndo() {
    const last = undo.pop();
    render();
    if (!last) return Promise.resolve();
    return queue(async () => {
      if (last.kind === 'create') {
        // A note added to the mark since then stays (T-017): only the colour goes.
        const on = await annotationDependents(last.id);
        if (on.notes || on.threads || on.subtopics) await setAnnotationColor(lesson, last.id, null);
        else await deleteAnnotation(lesson, last.id);
        announce(last.style === 'underline' ? 'Подчертаването е отменено.' : 'Маркирането е отменено.');
      } else {
        for (const { id, color } of last.items) {
          if (color) await setAnnotationColor(lesson, id, color);
          else await restoreAnnotation(lesson, id);
        }
        announce(last.items.length === 1 ? 'Маркировката е върната.' : `Върнати маркировки: ${last.items.length}.`);
      }
      onErased?.();
      await getFrame()?.reloadAnnotations();
    });
  }
  /** A selection made before (keyboard, mouse, long press): marked with the tool at once. */
  function markSelection() {
    const frame = getFrame();
    const sel = frame?.selection;
    if (!sel || sel.excludedOnly || !sel.position || (choice.tool !== 'marker' && choice.tool !== 'pencil')) return;
    const tool = choice.tool;
    const color = choice.color;
    frame.clearSelection?.();
    queue(() => createMark(sel, tool, color));
  }

  // --- The layer over the lesson: gestures -----------------------------------------
  const layer = h('div', { class: 'mark-layer', 'data-field': 'mark-layer', 'aria-hidden': 'true', hidden: true });
  // The palm (T016-D2). On a Galaxy Tab A9+ the passive pen comes as a TOUCH, so
  // "two touches = scrolling" is not enough. The rules:
  // 1. A contact with a large area (side ≥ PALM_SIDE_PX or area ≥ PALM_AREA_PX)
  //    is a palm for the whole gesture: ignored until it lifts (also when it
  //    grows into one while it rests).
  // 2. Two touches landing almost together (≤ PAIR_MS, the first still < 8 px)
  //    scroll at once.
  // 3. A touch that lands while a stroke is already sure (moved ≥ YOUNG_PX or
  //    older than YOUNG_MS, and ≥ 8 px) is a palm (ignored): the stroke goes on.
  // 4. Otherwise (the first touch rests, or its stroke is still young: T063-D1)
  //    the stroke is cancelled (its live preview goes) and both wait for the
  //    movement ("pending"):
  //    - both moved ≥ TOGETHER_PX and the slower at least SCROLL_RATIO of the
  //      faster (SCROLL_RATIO_PALM when the slower is the larger contact, ≥
  //      PALM_BIGGER × the area: a palm that drifts, T063-D2) → scrolling;
  //    - else the faster one, once it moved PENDING_PX, draws (a young stroke
  //      goes on from its first point: replayed) and the other is the palm;
  //    - the new touch lifts first → the young stroke goes on.
  // 5. A pen (pointerType pen) always wins: touches on the screen become palms,
  //    and touches stay ignored while it writes and PEN_GRACE_MS after.
  const pointers = new Map(); // pointerId → { x, y, x0, y0, t0, type }: the live, non-palm pointers
  const palms = new Set(); // pointerIds ignored until they lift
  let mode = 'idle'; // idle | draw | pending | scroll | blocked
  let drawId = null;
  let down = null; // { x, y, t } of the drawing pointer
  let moved = 0;
  let pending = null; // [olderId, newerId] while it is not yet known who draws
  let pendingYoung = false; // the older one was drawing a young stroke (rule 4, T063-D1)
  let path = []; // the points of the stroke while it is young (app viewport)
  let decideFrame = 0;
  let penUntil = 0;
  let penDown = false;
  let scrollLast = null; // { x, y, t }
  let velocity = { x: 0, y: 0 };
  let fling = 0;

  const frameXY = (event) => {
    const f = getFrame()?.frame;
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: event.clientX - r.left - f.clientLeft, y: event.clientY - r.top - f.clientTop };
  };
  const isPalm = (e) => e.pointerType === 'touch'
    && (Math.max(e.width || 0, e.height || 0) >= PALM_SIDE_PX || (e.width || 0) * (e.height || 0) >= PALM_AREA_PX);
  const centroid = () => {
    let x = 0; let y = 0;
    for (const p of pointers.values()) { x += p.x; y += p.y; }
    return { x: x / pointers.size, y: y / pointers.size };
  };
  const stopFling = () => { cancelAnimationFrame(fling); fling = 0; };
  function stopGesture() {
    if (mode === 'draw') getFrame()?.stroke('cancel');
    mode = 'idle';
    drawId = null;
    pending = null;
    pendingYoung = false;
    cancelAnimationFrame(decideFrame);
    decideFrame = 0;
    pointers.clear();
    palms.clear();
    stopFling();
  }
  const scrollBy = (dx, dy) => {
    const frame = getFrame();
    if (frame?.scrollInside(dx, dy)) return;
    window.scrollBy(dx, dy);
  };
  /** Ignore a pointer until it lifts. */
  const toPalm = (id) => { pointers.delete(id); palms.add(id); };
  /** A stroke by `id` from (x, y) (app viewport). */
  function startDraw(id, x, y) {
    const at = frameXY({ clientX: x, clientY: y });
    const frame = getFrame();
    if (!at || !frame?.bridgeReady) { mode = 'blocked'; drawId = null; return; }
    mode = 'draw';
    drawId = id;
    down = { x, y, t: performance.now() };
    moved = 0;
    path = [{ x, y }];
    frame.stroke('start', { ...at, tool: choice.tool, color: choice.tool === 'eraser' ? null : choice.color });
  }
  /** A cancelled young stroke goes on (rule 4): again from its first point, the points replayed, then (x, y). */
  function resumeDraw(id, points, x, y) {
    const [first, ...rest] = points.length ? points : [{ x, y }];
    const t0 = pointers.get(id)?.t0;
    startDraw(id, first.x, first.y);
    if (mode !== 'draw') return;
    if (Number.isFinite(t0)) down.t = t0;
    for (const p of [...rest, { x, y }]) {
      moved = Math.max(moved, Math.hypot(p.x - first.x, p.y - first.y));
      if (path.length < PATH_MAX) path.push(p);
      const at = frameXY({ clientX: p.x, clientY: p.y });
      if (at) getFrame()?.stroke('move', at);
    }
  }
  const area = (p) => (p.w || 0) * (p.h || 0);
  function toScroll() {
    if (mode === 'draw') getFrame()?.stroke('cancel');
    mode = 'scroll';
    drawId = null;
    pending = null;
    pendingYoung = false;
    scrollLast = { ...centroid(), t: performance.now() };
    velocity = { x: 0, y: 0 };
  }
  /** Rule 4: who of the two moves? */
  function decidePending() {
    const [a, b] = pending.map((id) => pointers.get(id));
    const da = { x: a.x - a.px, y: a.y - a.py };
    const db = { x: b.x - b.px, y: b.y - b.py };
    const la = Math.hypot(da.x, da.y);
    const lb = Math.hypot(db.x, db.y);
    // The two pointers report one after the other: decide when both moved
    // comparably (scrolling; apart → a pinch, scrolled by the centre: nothing
    // drawn either), or when the faster has gone PENDING_PX and the slower has
    // not kept up (it draws, the slower is the palm).
    const [slowId, fastId] = la <= lb ? pending : [...pending].reverse();
    const slow = pointers.get(slowId);
    const fast = pointers.get(fastId);
    const ls = Math.min(la, lb);
    const lf = Math.max(la, lb);
    const ratio = area(slow) && area(slow) >= PALM_BIGGER * area(fast) ? SCROLL_RATIO_PALM : SCROLL_RATIO;
    if (ls >= TOGETHER_PX && ls >= ratio * lf) { toScroll(); return; }
    if (lf < PENDING_PX) return;
    const resume = pendingYoung && fastId === pending[0];
    pending = null;
    pendingYoung = false;
    toPalm(slowId);
    if (resume) { resumeDraw(fastId, path, fast.x, fast.y); return; }
    startDraw(fastId, fast.px, fast.py);
    if (mode === 'draw') {
      moved = Math.hypot(fast.x - fast.px, fast.y - fast.py);
      const at = frameXY({ clientX: fast.x, clientY: fast.y });
      if (at) getFrame()?.stroke('move', at);
    }
  }

  layer.addEventListener('pointerdown', (e) => {
    if (!choice.tool || destroyed) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const now = performance.now();
    if (e.pointerType === 'pen') {
      penDown = true;
      penUntil = Infinity;
      // Rule 5: the pen wins over the touches already on the screen (the palm).
      const touches = [...pointers].filter(([, p]) => p.type === 'touch').map(([id]) => id);
      if (touches.length) {
        if (mode === 'draw' && touches.includes(drawId)) getFrame()?.stroke('cancel');
        for (const id of touches) toPalm(id);
        if (!pointers.size) { mode = 'idle'; drawId = null; pending = null; pendingYoung = false; }
      }
    }
    if (e.pointerType === 'touch' && (penDown || now < penUntil || isPalm(e))) { palms.add(e.pointerId); return; } // the palm
    stopFling();
    try { layer.setPointerCapture(e.pointerId); } catch { /* gone */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, t0: now, type: e.pointerType, w: e.width || 0, h: e.height || 0 });
    if (pointers.size === 1 && mode === 'idle') { startDraw(e.pointerId, e.clientX, e.clientY); return; }
    if (mode === 'draw') {
      const first = pointers.get(drawId);
      const age = first ? now - first.t0 : Infinity;
      if (age <= PAIR_MS && moved < TAP_SLOP_PX) { toScroll(); return; } // rule 2: two fingers together
      const young = age < YOUNG_MS && moved < YOUNG_PX;
      if (moved >= TAP_SLOP_PX && !young) { toPalm(e.pointerId); return; } // rule 3: the stroke goes on
      // Rule 4: a resting touch or a young stroke, and a new touch: wait for the movement.
      getFrame()?.stroke('cancel');
      for (const p of pointers.values()) { p.px = p.x; p.py = p.y; }
      pending = [drawId, e.pointerId];
      pendingYoung = moved >= TAP_SLOP_PX;
      mode = 'pending';
      drawId = null;
      return;
    }
    if (mode === 'pending') { toScroll(); return; } // a third finger: scrolling
    if (mode === 'scroll') { scrollLast = { ...centroid(), t: now }; return; } // joins the scrolling
    // blocked: nothing until all lift
  });
  layer.addEventListener('pointermove', (e) => {
    if (palms.has(e.pointerId)) { e.preventDefault(); return; }
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    // Rule 1: a contact that grows into a palm.
    if (isPalm(e)) {
      const id = e.pointerId;
      toPalm(id);
      if (mode === 'draw' && id === drawId) {
        getFrame()?.stroke('cancel');
        mode = 'idle';
        drawId = null;
        const [other] = pointers.keys();
        if (other !== undefined) { const o = pointers.get(other); startDraw(other, o.x, o.y); }
      } else if (mode === 'pending') {
        pending = null;
        mode = 'idle';
        const [other] = pointers.keys();
        if (other !== undefined) { const o = pointers.get(other); startDraw(other, o.x, o.y); }
      } else if (mode === 'scroll' && pointers.size) {
        scrollLast = { ...centroid(), t: performance.now() };
      }
      return;
    }
    if (mode === 'draw' && e.pointerId === drawId) {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const last = events.length ? events.at(-1) : e;
      const p = pointers.get(e.pointerId);
      p.x = last.clientX; p.y = last.clientY;
      p.w = e.width || 0; p.h = e.height || 0;
      moved = Math.max(moved, Math.hypot(last.clientX - down.x, last.clientY - down.y));
      if (path.length < PATH_MAX && performance.now() - down.t < YOUNG_MS) path.push({ x: last.clientX, y: last.clientY });
      const at = frameXY(last);
      if (at) getFrame()?.stroke('move', at);
      return;
    }
    const p = pointers.get(e.pointerId);
    p.x = e.clientX; p.y = e.clientY;
    p.w = e.width || 0; p.h = e.height || 0;
    // Decided at the next frame: the other pointer of the same touch move reports too.
    if (mode === 'pending') { if (!decideFrame) decideFrame = requestAnimationFrame(() => { decideFrame = 0; if (mode === 'pending') decidePending(); }); return; }
    if (mode === 'scroll') {
      const c = centroid();
      const t = performance.now();
      const dx = scrollLast.x - c.x;
      const dy = scrollLast.y - c.y;
      if (dx || dy) scrollBy(dx, dy);
      const dt = Math.max(1, t - scrollLast.t);
      velocity = { x: 0.8 * (dx / dt) + 0.2 * velocity.x, y: 0.8 * (dy / dt) + 0.2 * velocity.y };
      scrollLast = { ...c, t };
    }
  });
  const lift = (e, cancelled) => {
    if (e.pointerType === 'pen') { penDown = false; penUntil = performance.now() + PEN_GRACE_MS; }
    if (palms.delete(e.pointerId)) return;
    if (!pointers.has(e.pointerId)) return;
    const rec = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (mode === 'draw' && e.pointerId === drawId) {
      mode = pointers.size ? 'blocked' : 'idle';
      drawId = null;
      const frame = getFrame();
      if (!frame) return;
      const at = frameXY(e) || { x: 0, y: 0 };
      const tap = moved < TAP_SLOP_PX && performance.now() - down.t < TAP_MS;
      if (cancelled) { frame.stroke('cancel'); return; }
      const tool = choice.tool;
      const color = choice.color;
      if (tap && tool !== 'eraser') {
        frame.stroke('cancel');
        frame.activate(at.x, at.y);
        return;
      }
      const answer = frame.stroke('end', at);
      queue(async () => {
        const found = await answer;
        if (!found || destroyed) return;
        if (found.tool === 'eraser') {
          if (found.ids.length) await eraseMarks(found.ids);
          else if (tap) frame.activate(at.x, at.y);
          return;
        }
        if (!found.quote) return;
        if (found.covered) { announce('Този текст вече е маркиран така.'); await getFrame()?.reloadAnnotations(); return; }
        await createMark(found, tool, color);
      });
      return;
    }
    if (mode === 'pending') {
      // One of the two lifted before either moved: a quick tap of the newer one
      // (the pen on a quiz answer, the palm resting) presses the lesson's control.
      const newer = pending[1] === e.pointerId;
      const older = pending[0];
      const young = pendingYoung;
      pending = null;
      pendingYoung = false;
      mode = pointers.size ? 'blocked' : 'idle';
      // The new touch went away before anything moved: the young stroke goes on.
      if (young && newer && !cancelled && pointers.has(older)) {
        mode = 'idle';
        const o = pointers.get(older);
        resumeDraw(older, path, o.x, o.y);
        return;
      }
      const at = frameXY(e);
      const still = Math.hypot(e.clientX - rec.px, e.clientY - rec.py) < TAP_SLOP_PX;
      if (!cancelled && newer && still && at && performance.now() - rec.t0 < TAP_MS && choice.tool !== 'eraser') getFrame()?.activate(at.x, at.y);
      return;
    }
    if (mode === 'scroll' && pointers.size === 0) {
      mode = 'idle';
      // A short glide after a quick two-finger flick (like the native scrolling).
      let v = velocity;
      let lastT = performance.now();
      const step = (t) => {
        const dt = Math.min(32, t - lastT);
        lastT = t;
        v = { x: v.x * 0.95 ** (dt / 16), y: v.y * 0.95 ** (dt / 16) };
        if (Math.abs(v.y) < 0.05 && Math.abs(v.x) < 0.05) { fling = 0; return; }
        scrollBy(v.x * dt, v.y * dt);
        fling = requestAnimationFrame(step);
      };
      if (Math.hypot(v.x, v.y) > 0.3) fling = requestAnimationFrame(step);
      return;
    }
    if (mode === 'scroll') { scrollLast = { ...centroid(), t: performance.now() }; return; }
    if (mode === 'blocked' && pointers.size === 0) mode = 'idle';
  };
  layer.addEventListener('pointerup', (e) => lift(e, false));
  layer.addEventListener('pointercancel', (e) => lift(e, true));
  layer.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId) || palms.has(e.pointerId)) lift(e, true); });
  // No context menu / long-press menu on the layer while drawing.
  layer.addEventListener('contextmenu', (e) => e.preventDefault());

  // --- Keyboard ------------------------------------------------------------------------
  const typing = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  // T066-D3: Ctrl+Z / Cmd+Z is the app's only if the app itself saw the user press
  // Control / Meta (a trusted keydown here, with no blur / focus of the window
  // since). A lesson that moves the focus out of its frame at the user's Control
  // (parent.focus(), window.blur()) cannot carry the Z of a Ctrl+Z meant for the lesson.
  const modsSeen = { Control: false, Meta: false };
  const forgetMods = () => { modsSeen.Control = false; modsSeen.Meta = false; };
  const onModDown = (event) => { if (event.isTrusted && event.key in modsSeen) modsSeen[event.key] = true; };
  const onModUp = (event) => { if (event.key in modsSeen) modsSeen[event.key] = false; };
  const ownMods = (event) => (event.ctrlKey && modsSeen.Control) || (event.metaKey && modsSeen.Meta);
  window.addEventListener('keydown', onModDown, true);
  window.addEventListener('keyup', onModUp, true);
  window.addEventListener('blur', forgetMods);
  window.addEventListener('focus', forgetMods);
  const onKey = (event) => {
    if (destroyed || event.defaultPrevented) return;
    if (event.key === 'Escape' && choice.tool) { event.preventDefault(); setTool(null); return; }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' && !typing(event.target) && undo.length && event.isTrusted && ownMods(event)) {
      event.preventDefault();
      runUndo();
    }
  };
  document.addEventListener('keydown', onKey);

  render();
  // The first state, without animation and without saving (no choice made yet).
  element.hidden = hidden;
  handle.hidden = !hidden;
  element.dataset.hidden = String(hidden);
  hideButton.setAttribute('aria-expanded', String(!hidden));
  handle.setAttribute('aria-expanded', String(!hidden));

  return {
    element,
    handle,
    layer,
    get hidden() { return hidden; },
    setHidden: (value) => setHidden(value),
    get tool() { return choice.tool; },
    get color() { return choice.color; },
    /** Escape inside the lesson (lrn:escape). */
    escape() { if (choice.tool) setTool(null); },
    setTool,
    /** Delete marks (from the list "Маркировки за проверка"); "Отмени" brings them back. */
    erase: (ids) => queue(() => eraseMarks(ids)),
    destroy() {
      destroyed = true;
      slide?.cancel();
      stopGesture();
      clearTimeout(hintTimer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onAnyPress, true);
      window.removeEventListener('keydown', onModDown, true);
      window.removeEventListener('keyup', onModUp, true);
      window.removeEventListener('blur', forgetMods);
      window.removeEventListener('focus', forgetMods);
    },
  };
}
