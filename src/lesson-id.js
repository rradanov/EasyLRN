// Permanent ids of lessons, references and quizzes (D-039, T-055).
//
// A lesson is its course + number, not its file name:
//   <course>/lesson:NNNN      lessons/NNNN-<slug>.html   (exactly 4 digits)
//   <course>/reference:RNN    reference/R<digits>-<slug>.html (R + at least 2 digits: r1 → R01)
//   <course>/quiz:NNNN-K      quizzes/NNNN-K-<slug>.json (K an integer ≥ 1, no leading zeros)
//   <course>/quiz:path:<path> a quiz file outside that pattern (kept by its path)
// The path is a plain field of the record (`path`); earlier paths are kept in
// `previousPaths` (links from other lessons, and for reference).
//
// Pure functions only (no IndexedDB, no DOM): used by src/db.js (schema v5
// migration), src/course-import.js, the screens, and later the backup (T-031),
// which runs a v4 backup through the same migrateV4toV5().

/** Normalized reference number: "r1" → "R01", "R001" → "R01", "R123" → "R123"; null if not one. */
export function normalizeRefNumber(value) {
  const m = /^R(\d+)$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  return `R${String(Number.parseInt(m[1], 10)).padStart(2, '0')}`;
}

/**
 * Normalized number of a lesson or reference as written in INDEX.md or a URL:
 * "1" / "01" / "0001" → "0001", "r1" → "R01"; null if it is no such number.
 */
export function normalizeNumber(value) {
  const s = String(value ?? '').trim();
  if (/^\d{1,4}$/.test(s)) return s.padStart(4, '0');
  return normalizeRefNumber(s);
}

const LESSON_FILE = /^lessons\/(\d{4})-[^/]+\.html?$/i;
const REFERENCE_FILE = /^reference\/(R\d+)(?!\d)[^/]*\.html?$/i;
const QUIZ_FILE = /^quizzes\/(\d{4})-(\d+)(?:-[^/]*)?\.json$/i;

/** { kind, number } of a lesson/reference file path, or null. */
export function lessonNumberOf(path) {
  const p = String(path ?? '');
  let m = LESSON_FILE.exec(p);
  if (m) return { kind: 'lesson', number: m[1] };
  m = REFERENCE_FILE.exec(p);
  if (m) return { kind: 'reference', number: normalizeRefNumber(m[1]) };
  return null;
}

/** The permanent id of a lesson or reference. */
export function lessonId(courseId, kind, number) {
  const n = kind === 'reference' ? normalizeRefNumber(number) : String(number);
  return `${courseId}/${kind === 'reference' ? 'reference' : 'lesson'}:${n}`;
}

/** { lesson: "0003", k: 1 } of a quiz file path in the pattern, or null. */
export function quizNumberOf(path) {
  const m = QUIZ_FILE.exec(String(path ?? ''));
  if (!m) return null;
  const k = Number.parseInt(m[2], 10);
  return k >= 1 ? { lesson: m[1], k } : null;
}

/** The permanent id of a quiz from its path (a path outside the pattern keeps it: `quiz:path:`). */
export function quizId(courseId, path) {
  const n = quizNumberOf(path);
  return n ? `${courseId}/quiz:${n.lesson}-${n.k}` : `${courseId}/quiz:path:${path}`;
}

/** True if the id is a schema v5 lesson/reference id. */
export const isLessonId = (id) => /\/(lesson|reference):[^/]+$/.test(String(id ?? ''));

/**
 * The v5 id for a v4 lesson id ("<course>/lessons/0003-x.html"), or null.
 * Only used where no stored lesson record says it (orphan references).
 */
export function lessonIdFromV4(id) {
  const s = String(id ?? '');
  const m = /^(.+?)\/((?:lessons|reference)\/[^/]+)$/.exec(s);
  const n = m && lessonNumberOf(m[2]);
  return n ? lessonId(m[1], n.kind, n.number) : null;
}

/** The v5 id for a v4 quiz id ("<course>/quizzes/0003-1-x.json"), or null. */
export function quizIdFromV4(id) {
  const m = /^(.+?)\/(quizzes\/[^/]+\.json)$/i.exec(String(id ?? ''));
  return m ? quizId(m[1], m[2]) : null;
}

/** "lessons/a.HTML" → "lessons/a.html" (links may differ in the extension case). */
const lowerExt = (p) => p.replace(/\.[A-Za-z0-9]+$/, (e) => e.toLowerCase());

/**
 * The lesson a course-relative link path points to (D-039 §А.3): exact
 * `path` → one of `previousPaths` → the number in the file name
 * ("lessons/0003-old-name.html" → lesson 0003). `lessons` are the lessons of
 * ONE course (retired ones included: they open with a note). `byNumber:
 * false` skips the last step (a raw, not yet decoded path).
 * @returns {object|null}
 */
export function resolveLessonPath(lessons, path, { byNumber = true } = {}) {
  if (typeof path !== 'string' || !path) return null;
  const candidates = [path, lowerExt(path)];
  for (const p of candidates) {
    const hit = lessons.find((l) => l.path === p);
    if (hit) return hit;
  }
  for (const p of candidates) {
    const hit = lessons.find((l) => Array.isArray(l.previousPaths) && l.previousPaths.includes(p));
    if (hit) return hit;
  }
  const n = byNumber ? lessonNumberOf(lowerExt(path)) : null;
  if (!n) return null;
  return lessons.find((l) => l.kind === n.kind && normalizeNumber(l.number) === n.number) || null;
}

// ---------------------------------------------------------------------------
// Schema v4 → v5 (D-039 §3), a pure function
// ---------------------------------------------------------------------------

const STATUS_RANK = { new: 0, started: 1, done: 2 };
const str = (v) => (v == null ? '' : String(v));
const maxStr = (values) => values.filter(Boolean).sort().pop() ?? null;
const minStr = (values) => values.filter(Boolean).sort()[0] ?? null;

/** The newest record: not deleted before deleted, then the newest `updatedAt`. */
function leaderOf(group) {
  return [...group].sort((a, b) => (Number(Boolean(a.deleted)) - Number(Boolean(b.deleted)))
    || str(b.updatedAt).localeCompare(str(a.updatedAt)))[0];
}

/** The v5 id of a stored v4 lesson record, or null (no number). */
function v5LessonIdOf(record) {
  const courseId = record.courseId || /^(.+?)\//.exec(str(record.id))?.[1];
  if (!courseId) return null;
  const kind = record.kind === 'reference' ? 'reference' : 'lesson';
  const fromNumber = kind === 'reference' ? normalizeRefNumber(record.number)
    : (/^\d{4}$/.test(str(record.number)) ? str(record.number) : null);
  const fromPath = lessonNumberOf(record.path);
  const number = fromNumber || (fromPath && fromPath.kind === kind ? fromPath.number : null);
  return number ? lessonId(courseId, kind, number) : null;
}

function mergeLessons(group, newId, at) {
  const leader = leaderOf(group);
  const progresses = group.map((r) => ({ ...r.progress }));
  const status = progresses.map((p) => p.status).filter((s) => s in STATUS_RANK)
    .sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? 'new';
  const lastOpenedAt = maxStr(progresses.map((p) => p.lastOpenedAt));
  const byOpened = group.filter((r) => r.progress?.lastOpenedAt && r.progress.lastOpenedAt === lastOpenedAt)[0];
  const progress = {
    ...leader.progress,
    status,
    lastOpenedAt,
    scrollY: (byOpened ?? leader).progress?.scrollY ?? 0,
  };
  if (status === 'done') {
    progress.completedAt = leader.progress?.completedAt || minStr(progresses.map((p) => p.completedAt));
  }
  const previousPaths = [...new Set([
    ...group.flatMap((r) => (Array.isArray(r.previousPaths) ? r.previousPaths : [])),
    ...group.map((r) => r.path),
  ].filter((p) => p && p !== leader.path))];
  const { renamedTo, ...rest } = leader;
  const record = {
    ...rest,
    id: newId,
    progress,
    createdAt: minStr(group.map((r) => r.createdAt)) ?? leader.createdAt,
    updatedAt: at,
    deleted: Boolean(leader.deleted),
  };
  if (previousPaths.length) record.previousPaths = previousPaths;
  return record;
}

/**
 * Migrate the user's records from schema v4 (ids by path) to v5 (ids by
 * number, D-039 §3). Pure: the input arrays are not changed. Used by the
 * IndexedDB upgrade (src/db.js, MIGRATIONS[5]) and by the backup import of a
 * v4 file (T-031).
 * - lessons: one record per (course, kind, number); duplicates (also the
 *   soft-deleted `renamedTo` records of T-011-fix) are merged: leader = not
 *   deleted, then newest; status = the highest; lastOpenedAt = the newest and
 *   its scrollY; completedAt of the leader or the earliest; createdAt the
 *   earliest; the other paths go to `previousPaths`. A record without a
 *   number stays as it is (counted in `warnings`).
 * - annotations (`target`), subtopics (`parent`, `rootLessonId`): new lesson ids.
 * - quizzes: `<course>/quiz:NNNN-K` (or `quiz:path:<path>`); duplicates → the newest.
 * - quizAnswers: keyed like their quiz; duplicates → the newer `updatedAt`
 *   wins, the choices of the other are added for questions the winner has no
 *   answer to and kept whole in `choicesMerged`.
 * @param {{ lessons?: object[], annotations?: object[], subtopics?: object[],
 *           quizzes?: object[], quizAnswers?: object[] }} data
 * @param {{ now?: string }} [options]
 * @returns {{ lessons: object[], annotations: object[], subtopics: object[], quizzes: object[],
 *   quizAnswers: object[], lessonMap: Map<string,string>, quizMap: Map<string,string>,
 *   changed: { annotations: object[], subtopics: object[] }, warnings: string[] }}
 */
export function migrateV4toV5(data, { now = new Date().toISOString() } = {}) {
  const warnings = [];

  // --- lessons ---------------------------------------------------------------
  const lessonMap = new Map();
  const groups = new Map();
  const lessons = [];
  for (const r of data.lessons || []) {
    const newId = v5LessonIdOf(r);
    if (!newId) { warnings.push(`lesson without a number kept as it is: ${r.id}`); lessons.push(r); continue; }
    lessonMap.set(r.id, newId);
    if (!groups.has(newId)) groups.set(newId, []);
    groups.get(newId).push(r);
  }
  for (const [newId, group] of groups) {
    const single = group.length === 1 && group[0].id === newId && !('renamedTo' in group[0]);
    lessons.push(single ? group[0] : mergeLessons(group, newId, now));
  }
  const mapLesson = (id) => lessonMap.get(id) ?? (isLessonId(id) ? id : lessonIdFromV4(id)) ?? id;

  // --- annotations, subtopics ----------------------------------------------------
  const changed = { annotations: [], subtopics: [] };
  const annotations = (data.annotations || []).map((a) => {
    if (a?.target?.type !== 'lesson') return a;
    const id = mapLesson(a.target.id);
    if (id === a.target.id) return a;
    const next = { ...a, target: { ...a.target, id }, updatedAt: now };
    changed.annotations.push(next);
    return next;
  });
  const subtopics = (data.subtopics || []).map((s) => {
    const parentId = s?.parent?.type === 'lesson' ? mapLesson(s.parent.id) : s?.parent?.id;
    const root = s?.rootLessonId ? mapLesson(s.rootLessonId) : s?.rootLessonId;
    if (parentId === s?.parent?.id && root === s?.rootLessonId) return s;
    const next = { ...s, parent: { ...s.parent, id: parentId }, rootLessonId: root, updatedAt: now };
    changed.subtopics.push(next);
    return next;
  });

  // --- quizzes -------------------------------------------------------------------
  const quizMap = new Map();
  const quizGroups = new Map();
  for (const q of data.quizzes || []) {
    const newId = q.courseId && q.path ? quizId(q.courseId, q.path) : (quizIdFromV4(q.id) ?? q.id);
    quizMap.set(q.id, newId);
    if (!quizGroups.has(newId)) quizGroups.set(newId, []);
    quizGroups.get(newId).push(q);
  }
  const quizzes = [];
  for (const [newId, group] of quizGroups) {
    if (group.length === 1 && group[0].id === newId) { quizzes.push(group[0]); continue; }
    const leader = leaderOf(group);
    const previousPaths = [...new Set([
      ...group.flatMap((q) => (Array.isArray(q.previousPaths) ? q.previousPaths : [])),
      ...group.map((q) => q.path),
    ].filter((p) => p && p !== leader.path))];
    const record = {
      ...leader, id: newId, createdAt: minStr(group.map((q) => q.createdAt)) ?? leader.createdAt, updatedAt: now,
    };
    if (previousPaths.length) record.previousPaths = previousPaths;
    quizzes.push(record);
  }

  // --- quiz answers --------------------------------------------------------------
  const answerGroups = new Map();
  for (const a of data.quizAnswers || []) {
    const newId = quizMap.get(a.id) ?? quizIdFromV4(a.id) ?? a.id;
    if (!answerGroups.has(newId)) answerGroups.set(newId, []);
    answerGroups.get(newId).push(a);
  }
  const quizAnswers = [];
  for (const [newId, group] of answerGroups) {
    if (group.length === 1) {
      quizAnswers.push(group[0].id === newId ? group[0] : { ...group[0], id: newId, updatedAt: group[0].updatedAt ?? now });
      continue;
    }
    // The newer answers win; the older ones fill the questions the newer have no answer to.
    const sorted = [...group].sort((a, b) => (Number(Boolean(a.deleted)) - Number(Boolean(b.deleted)))
      || str(b.updatedAt).localeCompare(str(a.updatedAt)));
    const [winner, ...others] = sorted;
    let choices = { ...winner.choices };
    const merged = {};
    for (const o of others) {
      choices = { ...o.choices, ...choices };
      Object.assign(merged, { ...o.choices, ...merged });
    }
    quizAnswers.push({
      ...winner,
      id: newId,
      choices,
      choicesMerged: merged,
      createdAt: minStr(group.map((a) => a.createdAt)) ?? winner.createdAt,
      updatedAt: winner.updatedAt ?? now,
    });
  }

  return { lessons, annotations, subtopics, quizzes, quizAnswers, lessonMap, quizMap, changed, warnings };
}
