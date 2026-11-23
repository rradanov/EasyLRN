// The floating handles of hidden bars (the addition of 23.11.2026 to D-046).
//
// A hidden bar keeps no row and no strip: only its handle "☰" floats over the
// edge of the lesson (landscape: the tool handle at the left edge, the notes
// handle at the right edge; portrait, when no bar is left in the top row: the
// top corners). The handle must not cover text that is read, so it sits in the
// lesson's own margin: the bridge tells the free room left and right of the
// text (`lrn:size` left / right), and only when that room is smaller than the
// handle the reader makes the difference (a padding of the lesson's column,
// `--handle-gutter-left` / `--handle-gutter-right`). Usual lessons (a centred
// column) need none.
//
// The room is found by measuring, so it works for a centred column (it moves
// by half of a padding) and for a column at the edge (it moves by all of it);
// a few steps at most (never back and forth).

export const HANDLE_GAP = 4; // px between a handle and the text
const GUTTER_SLACK = 2;
const GUTTER_MAX = 96;
const MAX_STEPS = 12; // per change of the window / the bars

/**
 * @param {{ doc: HTMLElement, content: HTMLElement, getFrame: () => object|null,
 *   handles: () => { left: HTMLElement|null, right: HTMLElement|null } }} opts
 *   `handles()` gives the handle floating on each side now (null: none).
 */
export function createHandleGutter({ doc, content, getFrame, handles }) {
  const gutter = { left: 0, right: 0 };
  let queued = 0;
  let steps = 0;
  let destroyed = false;

  const set = (side, px) => {
    const v = Math.max(0, Math.min(GUTTER_MAX, Math.round(px)));
    if (v === gutter[side]) return false;
    gutter[side] = v;
    content.style.setProperty(`--handle-gutter-${side}`, `${v}px`);
    doc.dataset[`gutter${side === 'left' ? 'Left' : 'Right'}`] = String(v);
    return true;
  };

  const shown = (el) => !!el && el.isConnected && !el.hidden && el.getClientRects().length > 0;

  function measure() {
    queued = 0;
    if (destroyed) return;
    const lf = getFrame();
    const iframe = lf?.frame;
    const { left: leftHandle, right: rightHandle } = handles();
    const box = iframe && iframe.isConnected ? iframe.getBoundingClientRect() : null;
    // Unknown room (a lesson that did not tell yet, the fallback): none assumed.
    const m = lf?.margins || { left: 0, right: 0 };
    let changed = false;
    for (const side of ['left', 'right']) {
      const handle = side === 'left' ? leftHandle : rightHandle;
      if (!shown(handle) || !box || box.width <= 0) { changed = set(side, 0) || changed; continue; }
      const h = handle.getBoundingClientRect();
      // How far the text comes under the handle (> 0) or stays away from it (< 0).
      const need = side === 'left'
        ? h.right + HANDLE_GAP - (box.left + m.left)
        : (box.right - m.right) - (h.left - HANDLE_GAP);
      const now = gutter[side];
      if (need > 0.5) changed = set(side, now + Math.max(2, need * 2)) || changed;
      // Too much room: give it back. The text moves by at most what is given
      // back (all of it at the edge, half of it in a centred column), so it
      // never comes under the handle again.
      else if (now > 0 && -need > GUTTER_SLACK) changed = set(side, now + need) || changed;
    }
    // A change moves the frame; its next lrn:size (or the resize) brings the next step.
    if (changed && ++steps < MAX_STEPS) setTimeout(queue, 120);
  }

  /** Measure again (the window, the bars, the lesson changed). */
  function queue({ fresh = false } = {}) {
    if (fresh) steps = 0;
    if (queued || destroyed) return;
    queued = requestAnimationFrame(measure);
  }

  const onResize = () => queue({ fresh: true });
  window.addEventListener('resize', onResize);
  let observer = null;
  try { observer = new ResizeObserver(() => queue()); observer.observe(doc); } catch { /* resize only */ }

  return {
    queue,
    get left() { return gutter.left; },
    get right() { return gutter.right; },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(queued);
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    },
  };
}
