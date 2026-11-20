// "Последни дейности" as a history of places (D-041, T-059). Pure helpers;
// the records live in the IndexedDB store `history` (schema v6, src/db.js).
//
// A record is one PLACE the user has been: a lesson, a reference or a quiz.
// Its id is the id of that place (`<course>/lesson:0003`,
// `<course>/reference:R01`, `<course>/quiz:0003-1`, D-039), so a place is in
// the history once: visiting it again moves it to the top (newest
// `visitedAt`) and there are never two equal rows one after another.
//   { id, courseId, kind: 'lesson'|'reference'|'quiz', visitedAt,
//     scrollY: number|null,   // lesson/reference: the reading position
//     anchor: string|null,    // lesson/reference: opened at a fragment, not scrolled since
//     question: number|null,  // quiz: index of the question shown (0-based)
//     createdAt, updatedAt, deleted }
// A course keeps at most HISTORY_KEEP places (the oldest go); the course
// screen shows the newest HISTORY_SHOWN.

export const HISTORY_KEEP = 50;
export const HISTORY_SHOWN = 10;
export const PLACE_KINDS = Object.freeze(['lesson', 'reference', 'quiz']);

const byNewest = (a, b) => String(b.visitedAt).localeCompare(String(a.visitedAt)) || String(a.id).localeCompare(String(b.id));

/** Newest first, live records only. */
export function sortHistory(records) {
  return records.filter((r) => r && !r.deleted).sort(byNewest);
}

/** The records of a course beyond the newest `keep` (to delete). */
export function overflow(records, keep = HISTORY_KEEP) {
  return sortHistory(records).slice(keep);
}

const validTime = (t) => typeof t === 'string' && !Number.isNaN(Date.parse(t));
const position = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

/**
 * Migration v5 → v6: the history starts from what the user already did —
 * every opened lesson/reference (progress.lastOpenedAt, at progress.scrollY)
 * and every quiz with stored answers (updatedAt, at its cursor). At most
 * HISTORY_KEEP per course, the newest. Nothing else is read or changed.
 * @param {{ lessons: object[], quizzes: object[], quizAnswers: object[] }} data
 * @returns {object[]} history records
 */
export function seedHistory({ lessons = [], quizzes = [], quizAnswers = [] }) {
  const out = [];
  for (const l of lessons) {
    const at = l?.progress?.lastOpenedAt;
    if (!l || l.deleted || !l.id || !l.courseId || !validTime(at)) continue;
    out.push({
      id: l.id, courseId: l.courseId, kind: l.kind === 'reference' ? 'reference' : 'lesson', visitedAt: at,
      scrollY: position(l.progress.scrollY) ?? 0, anchor: null, question: null,
      createdAt: at, updatedAt: at, deleted: false,
    });
  }
  const quizById = new Map(quizzes.filter((q) => q && !q.deleted).map((q) => [q.id, q]));
  for (const a of quizAnswers) {
    const quiz = a && quizById.get(a.id);
    if (!quiz || a.deleted || !quiz.courseId || !validTime(a.updatedAt)) continue;
    const answered = a.choices && typeof a.choices === 'object' && Object.keys(a.choices).length > 0;
    if (!answered && !a.cursor) continue; // a quiz reset to nothing is no place the user was at
    const n = Array.isArray(quiz.questions) ? quiz.questions.length : 0;
    const q = position(a.cursor) ?? 0;
    out.push({
      id: quiz.id, courseId: quiz.courseId, kind: 'quiz', visitedAt: a.updatedAt,
      scrollY: null, anchor: null, question: n ? Math.min(q, n - 1) : 0,
      createdAt: a.updatedAt, updatedAt: a.updatedAt, deleted: false,
    });
  }
  const byCourse = new Map();
  for (const r of out) {
    if (!byCourse.has(r.courseId)) byCourse.set(r.courseId, []);
    byCourse.get(r.courseId).push(r);
  }
  return [...byCourse.values()].flatMap((rs) => sortHistory(rs).slice(0, HISTORY_KEEP));
}
