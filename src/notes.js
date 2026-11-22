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
import { STORES, byIndex, create, get, update, remove, restore, getAnnotation, COLORS } from './db.js';
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

/**
 * The notes of a lesson: [{ note, annotation }], one per annotation (the
 * oldest live note of it), the annotations in their stored order.
 */
export async function lessonNotes(lesson) {
  const annotations = await lessonAnnotations(lesson);
  const out = [];
  await Promise.all(annotations.map(async (annotation) => {
    const notes = await byIndex(STORES.notes, 'by_annotation', annotation.id);
    if (!notes.length) return;
    notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push({ note: notes[0], annotation });
  }));
  return out;
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
    const note = await get(STORES.notes, draft.noteId);
    if (!note) throw new Error('note not found');
    const annotation = await ownAnnotation(lesson, note.annotationId);
    const saved = await update(STORES.notes, note.id, { body: text });
    return { note: saved, annotation, createdAnnotation: false };
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

/** Undo a delete ("Върни"). */
export async function restoreNote(lesson, { noteId, annotationId, annotationDeleted }) {
  await ownAnnotation(lesson, annotationId, { includeDeleted: true });
  if (annotationDeleted) await restore(STORES.annotations, annotationId);
  await restore(STORES.notes, noteId);
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
