// Status of a lesson together with its quizzes (D-040, T-057). Pure functions:
// the course screen and the "Курсове" card compute the same thing.
//
// - ● done    = the lesson is marked as finished AND every one of its quizzes
//               is answered to the end;
// - ◐ started = the lesson was opened, or one of its quizzes is started, or it
//               is marked as finished but its quizzes are not all answered
//               (the line then says "Завършен · Тестове 1 от 2");
// - ○ new     = nothing yet.
// A lesson without quizzes is done when it is marked (as before D-040).
import { normalizeNumber } from './lesson-id.js';

const numKey = (n) => normalizeNumber(n) ?? String(n ?? '').toUpperCase();

/**
 * Group the quizzes of a course under their lesson (by `quiz.lesson`, the
 * lesson number). A quiz without a lesson, or whose number is no lesson or
 * reference of the course, is in `others` ("Други тестове").
 * @template Q
 * @param {{ id: string, kind: string, number: string }[]} lessons
 * @param {(Q & { lesson?: string|null })[]} quizzes
 * @returns {{ byLesson: Map<string, Q[]>, others: Q[] }}
 */
export function groupQuizzes(lessons, quizzes) {
  const byNumber = new Map();
  // A lesson wins over a reference of the same key (they never share one: "0001" vs "R01").
  for (const l of lessons) {
    const k = numKey(l.number);
    if (!byNumber.has(k) || l.kind === 'lesson') byNumber.set(k, l);
  }
  const byLesson = new Map();
  const others = [];
  for (const q of quizzes) {
    const lesson = q.lesson != null && q.lesson !== '' ? byNumber.get(numKey(q.lesson)) : undefined;
    if (!lesson) { others.push(q); continue; }
    if (!byLesson.has(lesson.id)) byLesson.set(lesson.id, []);
    byLesson.get(lesson.id).push(q);
  }
  return { byLesson, others };
}

/**
 * The status of a lesson with the scores of its quizzes (from scoreQuiz()).
 * @param {{ progress?: { status?: string } }} lesson
 * @param {{ total: number, answered: number, correct: number, started: boolean, done: boolean }[]} [scores]
 * @returns {{ status: 'new'|'started'|'done', label: string, marked: boolean,
 *   quizzes: number, quizzesDone: number, answered: number, correct: number, quizText: string }}
 */
export function lessonState(lesson, scores = []) {
  const p = lesson?.progress || {};
  const marked = p.status === 'done';
  // As before D-040, the stored status says "opened" (a corrupted one is "нов").
  const opened = p.status === 'started' || marked;
  // A quiz without questions cannot be answered: it does not hold the lesson back.
  const counted = scores.filter((s) => s && s.total > 0);
  const quizzesDone = counted.filter((s) => s.done).length;
  const answered = counted.reduce((n, s) => n + s.answered, 0);
  const correct = counted.reduce((n, s) => n + s.correct, 0);
  const allDone = quizzesDone === counted.length;
  const status = marked && allDone ? 'done' : (opened || answered > 0) ? 'started' : 'new';
  const label = marked ? 'Завършен' : status === 'started' ? 'Започнат' : 'Нов';
  const quizText = counted.length
    ? `Тестове ${quizzesDone} от ${counted.length}${answered ? ` · ${correct}/${answered} верни` : ''}`
    : '';
  return { status, label, marked, quizzes: counted.length, quizzesDone, answered, correct, quizText };
}

/** "Завършени: N от M": the lessons (not references, not retired) that are done by lessonState(). */
export function countDone(lessons, stateOf) {
  const main = lessons.filter((l) => l.kind === 'lesson' && !l.retired);
  return { done: main.filter((l) => stateOf(l).status === 'done').length, total: main.length };
}
