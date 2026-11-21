// The marking tools of the reader (T-015, D-042, replaces the selection + bottom
// bar of D-019 for colours).
//
// - A vertical tool bar LEFT of the lesson, in the app (never in the lesson):
//   marker (background), pencil (a line under the text), eraser, the five
//   colours (yellow, green, blue, orange, pink) and "Отмени" (the last action:
//   a mark, a line, an erase). Buttons ≥ 48 px; aria-pressed; a toolbar with
//   arrow keys; Escape turns the tool off; Ctrl+Z undoes. The choice (tool and
//   colour) is a setting (`markTool`), kept between lessons and reloads.
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
// - Pen: while a pen writes (and for a moment after), touches are ignored (the
//   palm). A touch with a very large contact is ignored too.
// - Without a tool the layer is gone: the lesson scrolls and selects as usual
//   (long press: the system selection, for T-017/T-023/T-025). A selection
//   that exists when the marker / pencil is pressed is marked at once (the
//   keyboard / mouse way of marking).
import { h } from '../dom.js';
import { saveSettings } from '../db.js';
import { annotateSelection, deleteAnnotation, restoreAnnotation } from '../annotations.js';
import { TOOL_COLORS, DEFAULT_COLOR_NAMES, colorChoices } from '../highlight.js';

export const TOOLS = Object.freeze(['marker', 'pencil', 'eraser']);
const TOOL_NAMES = Object.freeze({ marker: 'Маркер', pencil: 'Молив', eraser: 'Гума' });
const TAP_SLOP_PX = 8;
const TAP_MS = 500;
const PALM_PX = 70; // a touch wider AND taller than this is a palm, not a finger
const PEN_GRACE_MS = 700; // touches right after the pen lifted: still the palm
const UNDO_MAX = 50;

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
};

/** The stored choice, checked (an unknown value → the default). */
export function toolChoice(settings) {
  const s = settings?.markTool && typeof settings.markTool === 'object' ? settings.markTool : {};
  return {
    tool: TOOLS.includes(s.tool) ? s.tool : null,
    color: TOOL_COLORS.includes(s.color) ? s.color : 'yellow',
    lastDraw: s.lastDraw === 'pencil' ? 'pencil' : 'marker',
  };
}

/**
 * @param {{ getFrame: () => object|null, course: object, lesson: object, settings: object,
 *   announce: (text: string) => void, onChange?: () => void }} opts
 */
export function createMarkTools({ getFrame, course, lesson, settings, announce, onChange }) {
  const choice = toolChoice(settings);
  const names = new Map(colorChoices(settings).map((c) => [c.id, c]));
  const colorName = (id) => names.get(id)?.name || DEFAULT_COLOR_NAMES[id] || id;
  const colorLabel = (id) => { const c = names.get(id); return c?.label ? `${c.name} (${c.label})` : colorName(id); };
  const undo = [];
  let destroyed = false;

  // --- The bar -----------------------------------------------------------------------
  // A finger / pen presses a button on pointerup (Chrome drops the click of a
  // tap that comes right after a drawing stroke: seen in the manual check);
  // the mouse and the keyboard (Enter, Space) through `click`. One action per press.
  let pointerPressAt = -Infinity;
  function press(button, action) {
    let down = null;
    button.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && e.isPrimary) down = e.pointerId; });
    button.addEventListener('pointercancel', () => { down = null; });
    button.addEventListener('pointerup', (e) => {
      if (down !== e.pointerId) return;
      down = null;
      const r = button.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom || button.disabled) return;
      pointerPressAt = performance.now();
      action();
    });
    button.addEventListener('click', () => {
      if (performance.now() - pointerPressAt < 700) return; // the click of the same tap
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
  const hint = h('p', { class: 'mark-tools__hint', 'data-field': 'tool-hint', 'aria-hidden': 'true', hidden: true });
  const element = h('div', {
    class: 'mark-tools', role: 'toolbar', 'aria-label': 'Инструменти за маркиране', 'aria-orientation': 'vertical',
    'data-field': 'mark-tools',
  },
  h('div', { class: 'mark-tools__group', role: 'group', 'aria-label': 'Инструмент' }, ...Object.values(tools)),
  h('div', { class: 'mark-tools__group', role: 'group', 'aria-label': 'Цвят' }, ...Object.values(colors)),
  undoButton,
  hint);

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
  const save = () => saveSettings({ markTool: { ...choice } }).catch((err) => console.warn('Cannot save the tool:', err?.name || err));

  function setTool(tool) {
    const next = TOOLS.includes(tool) ? tool : null;
    if (next === choice.tool) return;
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
      announce('Инструментът е изключен. Урокът се превърта с един пръст.');
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
  async function eraseMarks(ids) {
    const done = [];
    for (const id of ids) {
      try { await deleteAnnotation(lesson, id); done.push(id); } catch (err) { console.warn('Cannot delete the mark:', err?.message || err); }
    }
    await getFrame()?.reloadAnnotations();
    if (!done.length) return;
    pushUndo({ kind: 'erase', ids: done });
    announce(done.length === 1 ? 'Маркировката е изтрита. „Отмени“ я връща.' : `Изтрити маркировки: ${done.length}. „Отмени“ ги връща.`);
  }
  let busy = Promise.resolve();
  const queue = (work) => { busy = busy.then(work).catch((err) => { console.warn('Marking failed:', err?.message || err); announce('Маркировката не можа да се запише.'); }); return busy; };
  function runUndo() {
    const last = undo.pop();
    render();
    if (!last) return Promise.resolve();
    return queue(async () => {
      if (last.kind === 'create') {
        await deleteAnnotation(lesson, last.id);
        announce(last.style === 'underline' ? 'Подчертаването е отменено.' : 'Маркирането е отменено.');
      } else {
        for (const id of last.ids) await restoreAnnotation(lesson, id);
        announce(last.ids.length === 1 ? 'Маркировката е върната.' : `Върнати маркировки: ${last.ids.length}.`);
      }
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
  const pointers = new Map(); // pointerId → { x, y }
  let mode = 'idle'; // idle | draw | scroll
  let drawId = null;
  let down = null; // { x, y, t } of the drawing pointer
  let moved = 0;
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
  const isPalm = (e) => e.pointerType === 'touch' && (e.width >= PALM_PX && e.height >= PALM_PX);
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
    pointers.clear();
    stopFling();
  }
  const scrollBy = (dx, dy) => {
    const frame = getFrame();
    if (frame?.scrollInside(dx, dy)) return;
    window.scrollBy(dx, dy);
  };

  layer.addEventListener('pointerdown', (e) => {
    if (!choice.tool || destroyed) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (e.pointerType === 'pen') { penDown = true; penUntil = Infinity; }
    if (e.pointerType === 'touch' && (penDown || performance.now() < penUntil || isPalm(e))) return; // the palm
    stopFling();
    try { layer.setPointerCapture(e.pointerId); } catch { /* gone */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && mode === 'idle') {
      const at = frameXY(e);
      const frame = getFrame();
      if (!at || !frame?.bridgeReady) { mode = 'blocked'; return; }
      mode = 'draw';
      drawId = e.pointerId;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = 0;
      frame.stroke('start', { ...at, tool: choice.tool, color: choice.tool === 'eraser' ? null : choice.color });
      return;
    }
    // A second finger: no drawing (what the first one drew so far is dropped), scrolling.
    if (mode === 'draw') getFrame()?.stroke('cancel');
    mode = 'scroll';
    drawId = null;
    scrollLast = { ...centroid(), t: performance.now() };
    velocity = { x: 0, y: 0 };
  });
  layer.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    if (mode === 'draw' && e.pointerId === drawId) {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const last = events.length ? events.at(-1) : e;
      pointers.set(e.pointerId, { x: last.clientX, y: last.clientY });
      moved = Math.max(moved, Math.hypot(last.clientX - down.x, last.clientY - down.y));
      const at = frameXY(last);
      if (at) getFrame()?.stroke('move', at);
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (mode === 'draw' && e.pointerId === drawId) {
      mode = 'idle';
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
    }
    if (mode === 'blocked' && pointers.size === 0) mode = 'idle';
  };
  layer.addEventListener('pointerup', (e) => lift(e, false));
  layer.addEventListener('pointercancel', (e) => lift(e, true));
  layer.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) lift(e, true); });
  // No context menu / long-press menu on the layer while drawing.
  layer.addEventListener('contextmenu', (e) => e.preventDefault());

  // --- Keyboard ------------------------------------------------------------------------
  const typing = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const onKey = (event) => {
    if (destroyed || event.defaultPrevented) return;
    if (event.key === 'Escape' && choice.tool) { event.preventDefault(); setTool(null); return; }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' && !typing(event.target) && undo.length) {
      event.preventDefault();
      runUndo();
    }
  };
  document.addEventListener('keydown', onKey);

  render();

  return {
    element,
    layer,
    get tool() { return choice.tool; },
    get color() { return choice.color; },
    /** Escape inside the lesson (lrn:escape). */
    escape() { if (choice.tool) setTool(null); },
    setTool,
    /** Delete marks (from the list "Маркировки за проверка"); "Отмени" brings them back. */
    erase: (ids) => queue(() => eraseMarks(ids)),
    destroy() {
      destroyed = true;
      stopGesture();
      clearTimeout(hintTimer);
      document.removeEventListener('keydown', onKey);
    },
  };
}
