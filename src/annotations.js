// Annotations of a lesson on the app side (T-013, D-012, D-013, D-039,
// LESSON-ISOLATION §5).
//
// - An annotation is on a DocRef (D-013); for a lesson or a reference the
//   DocRef is { type: 'lesson', id: <course>/lesson:NNNN | <course>/reference:RNN }
//   (D-039), so a renamed file keeps its annotations. `targetVersion` is the
//   sha256 of the original lesson file when the selector was last confirmed.
// - The bridge in the lesson anchors them (ok / fuzzy / orphan) and reports
//   `lrn:anchored`. That report is untrusted (the lesson may lie): it only
//   changes `anchorState` and the last place (`lastAnchor`) of annotations of
//   THIS lesson; the selector the user made is never replaced by what the
//   lesson says, and nothing is ever deleted. The last place is only a
//   starting point for the next anchoring, which checks the text there again.
//   A lie costs at most a wrong state until the next opening.
// - What goes to the lesson (`bridgeItems`): id, colour, selector, whether
//   the version is the same, its style (marker / pencil, T-015). Never notes,
//   threads, answers, settings or keys.
import { createAnnotation, annotationsFor, update, updateAnnotation, remove, restore, byIndex, getAnnotation, STORES, docRef, COLORS, ANCHOR_STATES, ANNOTATION_STYLES } from './db.js';

export const MAX_ANNOTATIONS_PER_DOC = 5000;
const SAVE_DELAY_MS = 1000;

/** The DocRef of a lesson or a reference (D-013, D-039). */
export const lessonRef = (lesson) => docRef('lesson', lesson.id);

/** The annotations of a lesson (not deleted), oldest first. */
export async function lessonAnnotations(lesson) {
  const list = await annotationsFor(lessonRef(lesson));
  return list.slice(0, MAX_ANNOTATIONS_PER_DOC);
}

/** The list for `lrn:annotations` (LESSON-ISOLATION §5.1): no notes, no secrets. */
export function bridgeItems(annotations, lesson) {
  return annotations.map((a) => {
    // The last place found in THIS version is the best start (the bridge checks
    // that the quote is still there); else the place at creation. Only a place
    // that was "ok" (T013F-D1): a "провери" (fuzzy) place is a guess, trusting it
    // at the next opening would make it "ok" at the wrong place.
    const last = a.lastAnchor;
    const here = Boolean(lesson.sha256) && last?.version === lesson.sha256 && last.state === 'ok'
      && Number.isInteger(last.start) && Number.isInteger(last.end);
    return {
      id: a.id,
      color: COLORS.includes(a.color) ? a.color : null,
      style: a.style === 'underline' ? 'underline' : 'highlight',
      selector: {
        quote: { exact: a.selector.quote.exact, prefix: a.selector.quote.prefix ?? '', suffix: a.selector.quote.suffix ?? '' },
        position: here ? { start: last.start, end: last.end } : { start: a.selector.position.start, end: a.selector.position.end },
        ...(typeof a.selector.hint?.blockPath === 'string' ? { hint: { blockPath: a.selector.hint.blockPath } } : {}),
      },
      sameVersion: here || (Boolean(lesson.sha256) && a.targetVersion === lesson.sha256),
    };
  });
}

const isInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e8;

/**
 * Clean results of `lrn:anchored`: only ids in `known`, a known state, a
 * position within the text of the lesson; each id once.
 * @returns {{ id: string, state: string, position: {start, end}|null, top: number|null, bottom: number|null }[]}
 */
export function checkAnchored(results, known, textLength) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(results)) return out;
  const max = isInt(textLength, 1e7) ? textLength : 1e7;
  for (const r of results.slice(0, MAX_ANNOTATIONS_PER_DOC)) {
    if (!r || typeof r !== 'object' || Object.getPrototypeOf(r) !== Object.prototype) continue;
    if (typeof r.id !== 'string' || r.id.length > 64 || !known.has(r.id) || seen.has(r.id)) continue;
    if (!ANCHOR_STATES.includes(r.state)) continue;
    let position = null;
    if (r.state !== 'orphan') {
      const p = r.position;
      if (!p || !isInt(p.start, max) || !isInt(p.end, max) || p.start >= p.end) continue;
      position = { start: p.start, end: p.end };
    }
    seen.add(r.id);
    out.push({
      id: r.id,
      state: r.state,
      position,
      top: isNum(r.top) ? r.top : null,
      bottom: isNum(r.bottom) ? r.bottom : null,
    });
  }
  return out;
}

/**
 * Saves the anchoring results of one lesson, coalesced (at most one write per
 * annotation per second; only when something changed).
 */
export function anchorSaver(lesson) {
  const pending = new Map();
  let timer = null;
  let chain = Promise.resolve();
  const flush = () => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    chain = chain.then(() => Promise.all(batch.map(({ annotation, result }) => {
      const at = new Date().toISOString();
      // Only the state and the last place are stored. The selector (the quote
      // and position the user made, targetVersion = the version at creation,
      // ARCHITECTURE §3.3) is never changed by what a lesson reports.
      const patch = {
        anchorState: result.state,
        lastAnchor: result.position
          ? { version: lesson.sha256 ?? null, state: result.state, start: result.position.start, end: result.position.end, at }
          : { version: lesson.sha256 ?? null, state: result.state, at },
      };
      return update(STORES.annotations, annotation.id, patch).then((saved) => Object.assign(annotation, saved)).catch((err) => console.warn('Cannot save the anchoring:', err?.name || err));
    })));
    return chain;
  };
  return {
    /** @param {Map<string, object>} known id → annotation @param {ReturnType<typeof checkAnchored>} results */
    add(known, results) {
      for (const result of results) {
        const annotation = known.get(result.id);
        if (!annotation) continue;
        const last = annotation.lastAnchor;
        const same = annotation.anchorState === result.state && last?.state === result.state
          && (last?.version ?? null) === (lesson.sha256 ?? null)
          && (result.position ? last?.start === result.position.start && last?.end === result.position.end : last?.start === undefined);
        if (same) { pending.delete(result.id); continue; }
        pending.set(result.id, { annotation, result });
      }
      if (pending.size && !timer) timer = setTimeout(flush, SAVE_DELAY_MS);
    },
    /** Write what is pending now (when the reader closes). */
    flush() {
      clearTimeout(timer);
      return pending.size ? flush() : chain;
    },
  };
}

/**
 * A new annotation from a checked selection of the lesson (`lrn:selection`,
 * as lesson-frame.js keeps it). For T-015 (the bottom bar) and the tests.
 * A selection that is only in an excluded part (`.quiz`, data-lrn-noanno) has
 * no position in the model and is refused here.
 */
export async function annotateSelection({ course, lesson, selection, color = null, style = 'highlight' }) {
  if (!selection || selection.empty || !selection.quote?.exact || !selection.position) throw new TypeError('no selection');
  if (color !== null && !COLORS.includes(color)) throw new TypeError('bad colour');
  if (!ANNOTATION_STYLES.includes(style)) throw new TypeError('bad style');
  return createAnnotation({
    courseId: course.id,
    target: lessonRef(lesson),
    targetVersion: lesson.sha256 ?? null,
    selector: {
      quote: { ...selection.quote },
      position: { ...selection.position },
      ...(selection.hint ? { hint: { blockPath: selection.hint } } : {}),
    },
    color,
    style,
    anchorState: 'ok',
  });
}

// --- T-015: the user's changes (from the bottom bar / the card) ---------------------

/** A new colour of an annotation of `lesson` (only of that lesson). */
export async function setAnnotationColor(lesson, id, color) {
  if (color !== null && !COLORS.includes(color)) throw new TypeError('bad colour');
  await ownAnnotation(lesson, id);
  return updateAnnotation(id, { color });
}

/** Soft delete (it can be undone: restoreAnnotation). */
export async function deleteAnnotation(lesson, id) {
  await ownAnnotation(lesson, id);
  return remove(STORES.annotations, id);
}

/** Undo a delete. */
export async function restoreAnnotation(lesson, id) {
  await ownAnnotation(lesson, id, { includeDeleted: true });
  return restore(STORES.annotations, id);
}

/** What hangs on an annotation (UI-DESIGN §5.2: "Ще изтриеш 1 нишка и 2 теми"). */
export async function annotationDependents(id) {
  const [notes, threads, subtopics] = await Promise.all([
    byIndex(STORES.notes, 'by_annotation', id),
    byIndex(STORES.threads, 'by_annotation', id),
    byIndex(STORES.subtopics, 'by_annotation', id),
  ]);
  return { notes: notes.length, threads: threads.length, subtopics: subtopics.length };
}

/**
 * The user confirmed a mark that was found only approximately ("провери" →
 * "Да, тук е"): its selector becomes the one at the new place, in this
 * version (`described` is the checked `lrn:described` of the bridge; the
 * user pressed the button, a lesson message alone never changes a selector).
 */
export async function confirmAnnotationPlace(lesson, id, described) {
  if (!described?.quote?.exact || !described.position) throw new TypeError('no place');
  await ownAnnotation(lesson, id);
  const at = new Date().toISOString();
  return updateAnnotation(id, {
    selector: {
      quote: { ...described.quote },
      position: { ...described.position },
      ...(described.hint ? { hint: { blockPath: described.hint } } : {}),
    },
    targetVersion: lesson.sha256 ?? null,
    anchorState: 'ok',
    lastAnchor: { version: lesson.sha256 ?? null, state: 'ok', start: described.position.start, end: described.position.end, at },
  });
}

/** The annotation `id`, if it is on `lesson` (never one of another document). */
async function ownAnnotation(lesson, id, opts) {
  const a = typeof id === 'string' ? await getAnnotation(id, opts) : null;
  const ref = lessonRef(lesson);
  if (!a || a.target?.type !== ref.type || a.target?.id !== ref.id) throw new Error('not an annotation of this lesson');
  return a;
}
