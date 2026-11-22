// Notes on a lesson (T-017, D-045, D-013, D-039, D-012).
//
// - A note is a `Note` record on an annotation of the lesson (store `notes`,
//   index by_annotation; no migration: the store exists since v1 and is in
//   BACKUP_STORES). The annotation carries the place (D-012 selectors on the
//   DocRef of the lesson, D-039 ids), so a note follows it through a changed
//   lesson: ok / "провери" (fuzzy) / "неприкачена" (orphan) — never lost.
// - A note on selected text that is not marked: an annotation WITHOUT a
//   colour (`color: null`) + the note. A note on a mark: the mark's own
//   annotation. One note per place (D-045): a second "Бележка" on the same or
//   an overlapping place opens the note that is there.
// - Deleting a note is soft (it can be brought back: "Върни"); an annotation
//   without a colour and without anything else on it goes with its last note.
// - The eraser never deletes a note (D-045): on a mark with a note it only
//   takes the colour away (src/screens/mark-tools.js).
// - NOTHING of a note ever goes to the lesson: the bridge gets the annotation
//   (id, colour null, selector = a quote of the lesson itself), never the body.
import { STORES, byIndex, list, create, get, update, remove, restore, getAnnotation, updateAnnotation, COLORS } from './db.js';
import { lessonRef, lessonAnnotations, annotateSelection, annotationDependents } from './annotations.js';

export const MAX_NOTE_LENGTH = 20000;

/** The annotation `id`, if it is on `lesson` (never one of another document). */
async function ownAnnotation(lesson, id, opts) {
  const a = typeof id === 'string' ? await getAnnotation(id, opts) : null;
  const ref = lessonRef(lesson);
  if (!a || a.target?.type !== ref.type || a.target?.id !== ref.id) throw new Error('not an annotation of this lesson');
  return a;
}

const clip = (body) => String(body ?? '').slice(0, MAX_NOTE_LENGTH);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The notes of a lesson: [{ note, annotation }], one per annotation (the
 * oldest live note of it), the annotations in their stored order.
 * T018-I4: one read of the store `notes` (not one request per annotation:
 * 5000 marks made every redraw slow).
 */
export async function lessonNotes(lesson) {
  if (flushRun) await flushRun; // a text kept at the last pagehide is in first (never throws)
  const [annotations, all] = await Promise.all([lessonAnnotations(lesson), list(STORES.notes)]);
  const first = new Map(); // annotation id → its oldest live note
  for (const note of all) {
    const had = first.get(note.annotationId);
    if (!had || byId(note, had) < 0) first.set(note.annotationId, note);
  }
  const out = [];
  for (const annotation of annotations) {
    const note = first.get(annotation.id);
    if (note) out.push({ note, annotation });
  }
  return out;
}

/**
 * The annotation of a note is live again (T018-D6 / D10): one deleted since
 * (the eraser took a mark whose note was deleted, or another tab) comes back
 * as a place with a note only (`color: null`) — the note is never invisible.
 * Returns true when it had to be brought back.
 */
async function reviveAnnotation(lesson, id) {
  const a = await ownAnnotation(lesson, id, { includeDeleted: true });
  if (!a.deleted) return false;
  await updateAnnotation(id, { deleted: false, color: null });
  return true;
}

/**
 * Save the text of a note. `draft` is { noteId } for a note that exists,
 * { annotationId } for a new note on an annotation of the lesson (a mark), or
 * { selection } for a new note on selected text (a new annotation without a
 * colour). Returns { note, annotation, createdAnnotation }.
 */
export async function saveNote({ course, lesson, draft, body }) {
  const text = clip(body);
  if (draft.noteId) {
    // T018-D10: the note may have been deleted meanwhile (another tab, "Изтрий"
    // there): what is typed here is not lost — the note comes back with it.
    const note = await get(STORES.notes, draft.noteId, { includeDeleted: true });
    if (!note) throw new Error('note not found');
    const revivedAnnotation = await reviveAnnotation(lesson, note.annotationId);
    const annotation = await ownAnnotation(lesson, note.annotationId);
    const saved = await update(STORES.notes, note.id, { body: text, deleted: false });
    return { note: saved, annotation, createdAnnotation: revivedAnnotation, revived: !!note.deleted || revivedAnnotation };
  }
  let annotation;
  let createdAnnotation = false;
  if (draft.annotationId) {
    annotation = await ownAnnotation(lesson, draft.annotationId);
    // One note per place: a note already there is the one to write in.
    const existing = (await byIndex(STORES.notes, 'by_annotation', annotation.id)).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (existing) {
      const saved = await update(STORES.notes, existing.id, { body: text });
      return { note: saved, annotation, createdAnnotation: false };
    }
  } else if (draft.selection) {
    annotation = await annotateSelection({ course, lesson, selection: draft.selection, color: null });
    createdAnnotation = true;
  } else {
    throw new TypeError('no place for the note');
  }
  const note = await create(STORES.notes, { courseId: course.id, annotationId: annotation.id, body: text });
  return { note, annotation, createdAnnotation };
}

/**
 * Soft delete of a note; its annotation goes too when it has no colour and
 * nothing else on it. Returns what `restoreNote` needs.
 */
export async function deleteNote(lesson, noteId) {
  const note = await get(STORES.notes, noteId);
  if (!note) throw new Error('note not found');
  const annotation = await ownAnnotation(lesson, note.annotationId);
  await remove(STORES.notes, note.id);
  let annotationDeleted = false;
  if (!COLORS.includes(annotation.color)) {
    const left = await annotationDependents(annotation.id);
    if (!left.notes && !left.threads && !left.subtopics) {
      await remove(STORES.annotations, annotation.id);
      annotationDeleted = true;
    }
  }
  return { noteId: note.id, annotationId: annotation.id, annotationDeleted };
}

/**
 * Undo a delete ("Върни"). T018-D6: the annotation is brought back too when it
 * went since (the eraser on the mark after "Изтрий"): as a place with a note
 * only. Returns { annotationRestored } (the frame must reload its marks).
 */
export async function restoreNote(lesson, { noteId, annotationId, annotationDeleted }) {
  await ownAnnotation(lesson, annotationId, { includeDeleted: true });
  let annotationRestored = false;
  if (annotationDeleted) { await restore(STORES.annotations, annotationId); annotationRestored = true; }
  if (await reviveAnnotation(lesson, annotationId)) annotationRestored = true;
  await restore(STORES.notes, noteId);
  return { annotationRestored };
}

// --- T018-D3: the last words before the page goes ---------------------------------
// When the page is hidden / unloaded the text of an open note is saved, but an
// IndexedDB write begun in `pagehide` may not finish before the page dies (a
// reload, Android killing Chrome in the background). So the text is also put,
// synchronously, into localStorage (same origin as the database; the lesson
// runs in an opaque origin and cannot read it) and written into the database at
// the next start (`flushPendingNote`). Removed once the database has it.
const PENDING_KEY = 'lrn-note-pending';

/** Keep the text of an open note synchronously (pagehide / visibilitychange / beforeunload). */
export function keepPendingNote({ courseId, lessonId, draft, body }) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ courseId, lessonId, draft, body: clip(body), at: Date.now() }));
  } catch { /* storage full / unavailable: the async save is all there is */ }
}

/**
 * The database has this text: the kept copy is not needed — when it is the
 * same text, or it was kept before this save began (`since`, ms). No argument: always.
 */
export function dropPendingNote({ body, since } = {}) {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw === null) return;
    const kept = JSON.parse(raw);
    const all = body === undefined && since === undefined;
    if (all || kept?.body === clip(body) || (Number.isFinite(since) && Number(kept?.at) <= since)) localStorage.removeItem(PENDING_KEY);
  } catch { try { localStorage.removeItem(PENDING_KEY); } catch { /* */ } }
}

/**
 * At start: a text kept at pagehide goes into its note (only a note of a
 * known lesson; nothing here comes from the lesson). Returns the saved note or null.
 * @param {{ getCourse: Function, getLesson: Function }} db
 */
let flushRun = null;
export function flushPendingNote(db) {
  flushRun = writePending(db);
  return flushRun;
}
async function writePending({ getCourse, getLesson }) {
  let kept;
  try { kept = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { kept = null; }
  if (!kept || typeof kept !== 'object') { dropPendingNote(); return null; }
  try {
    const { courseId, lessonId, draft, body } = kept;
    if (typeof body !== 'string' || !draft || typeof draft !== 'object') return null;
    const lesson = typeof lessonId === 'string' ? await getLesson(lessonId, { includeDeleted: true }) : null;
    const course = typeof courseId === 'string' ? await getCourse(courseId, { includeDeleted: true }) : null;
    if (!lesson || !course) return null;
    if (!draft.noteId && !body.trim()) return null; // an empty new note is not kept
    if (draft.noteId) {
      const note = await get(STORES.notes, draft.noteId, { includeDeleted: true });
      if (note && note.body === body) return note; // nothing to write
    }
    let target = draft;
    if (draft.selection && !draft.noteId && !draft.annotationId) {
      // The async save of the page may have made the note already: write in it, never a second one.
      const p = draft.selection.position;
      const same = (await lessonAnnotations(lesson)).find((a) => a.selector?.position?.start === p?.start
        && a.selector?.position?.end === p?.end && a.selector?.quote?.exact === draft.selection.quote?.exact);
      if (same) target = { annotationId: same.id };
    }
    const { note } = await saveNote({ course, lesson, draft: target, body });
    return note;
  } catch (err) {
    console.warn('Cannot write the kept note:', err?.message || err);
    return null;
  } finally {
    dropPendingNote();
  }
}

/**
 * The note at a selection (one note per place, D-045): the note whose place in
 * the text now overlaps the selection most, or null. `places` are the
 * annotations of the frame with `anchoredStart` / `anchoredEnd` (this text).
 * @param {{ position: {start, end} }} selection
 * @param {{ note, annotation }[]} notes
 */
export function noteAtSelection(selection, notes) {
  const p = selection?.position;
  if (!p) return null;
  let best = null;
  let bestOverlap = 0;
  for (const item of notes) {
    const a = item.annotation;
    if (a.anchorState === 'orphan' || !Number.isInteger(a.anchoredStart) || !Number.isInteger(a.anchoredEnd)) continue;
    const overlap = Math.min(p.end, a.anchoredEnd) - Math.max(p.start, a.anchoredStart);
    if (overlap > bestOverlap) { best = item; bestOverlap = overlap; }
  }
  return best;
}

/** A mark (with a colour) at exactly the selected place: the new note goes on it. */
export function markAtSelection(selection, annotations) {
  const p = selection?.position;
  if (!p) return null;
  return annotations.find((a) => COLORS.includes(a.color) && a.anchorState !== 'orphan'
    && a.anchoredStart === p.start && a.anchoredEnd === p.end) || null;
}
