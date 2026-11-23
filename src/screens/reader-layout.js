// The layout of the reader by the window (D-046, D-045 addition, T-069).
//
// - 'phone' (narrower than 600 px): no bars; only the 📝 column next to the
//   lesson; a note fills the window.
// - 'portrait' (taller than wide, ≥ 600 px): the tool bar and the notes bar are
//   horizontal, at the top under the title (tools left, notes right), so they
//   take nothing from the short side; a note / the list opens UNDER the lesson,
//   with a movable horizontal divider.
// - 'landscape': the tool bar left of the lesson, the notes strip right of it;
//   a note / the list is a column at the right edge, with a movable vertical divider.
// Every part of the reader asks this one function, so they always agree (also
// in the middle of a rotation: each follows the `resize` of the window).
export const NARROW_PX = 600;

/** 'phone' | 'portrait' | 'landscape' for a window of `width` × `height` CSS px. */
export function readerLayout(width = window.innerWidth || document.documentElement.clientWidth, height = window.innerHeight || document.documentElement.clientHeight) {
  if (width < NARROW_PX) return 'phone';
  return height > width ? 'portrait' : 'landscape';
}
