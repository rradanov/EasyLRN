// Status of a lesson and, separately, of its quizzes (D-041, T-059; D-040 for
// the grouping). Pure functions: the course screen and the "Курсове" card
// compute the same thing.
//
// The material (D-041, as before D-040):
// - ● done    = the lesson is marked as finished ("Маркирай като завършен");
// - ◐ started = the lesson was opened;
// - ○ new     = nothing yet.
// The quizzes do NOT hold the lesson back: the material can be gone through
// without them. They have their own mark next to the lesson:
// - none    = the lesson has no quiz (with questions): no mark;
// - new     = no question answered yet ("Тестове: не са започнати");
// - started = some answered ("Тестове: започнати");
// - passed  = every question of every quiz answered ("Тестове: минати").
// The counter is "Въпроси 7 от 26" (answered of all); the share of right
// answers is given only once all questions are answered (D-041: after 1–2
// answers a percentage means nothing).
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

/** Rounded share of right answers, 0…100. */
export const percent = (correct, total) => (total > 0 ? Math.round((correct / total) * 100) : 0);

/** The words of the quiz mark (visible, and its accessible name; the square next to them is CSS). */
export const QUIZ_MARK = Object.freeze({
  new: { word: 'не са започнати', name: 'Тестове: не са започнати' },
  started: { word: 'започнати', name: 'Тестове: започнати' },
  passed: { word: 'минати', name: 'Тестове: минати' },
});

/**
 * The quizzes of one lesson together (from scoreQuiz() of each).
 * @param {{ total: number, answered: number, correct: number, done: boolean }[]} [scores]
 * @returns {{ state: 'none'|'new'|'started'|'passed', quizzes: number, quizzesDone: number,
 *   total: number, answered: number, correct: number, percent: number|null,
 *   countText: string, correctText: string }}
 */
export function quizzesState(scores = []) {
  // A quiz without questions cannot be answered: it is not counted.
  const counted = scores.filter((s) => s && s.total > 0);
  const total = counted.reduce((n, s) => n + s.total, 0);
  const answered = counted.reduce((n, s) => n + s.answered, 0);
  const correct = counted.reduce((n, s) => n + s.correct, 0);
  const quizzesDone = counted.filter((s) => s.done).length;
  const state = !counted.length ? 'none' : answered === 0 ? 'new' : quizzesDone === counted.length ? 'passed' : 'started';
  const all = state === 'passed';
  return {
    state,
    quizzes: counted.length,
    quizzesDone,
    total,
    answered,
    correct,
    percent: all ? percent(correct, total) : null,
    countText: counted.length ? `Въпроси ${answered} от ${total}` : '',
    correctText: all ? `${percent(correct, total)}\u00A0% верни` : '',
  };
}

/**
 * The status of a lesson's material (D-041: only opening and the "finished"
 * mark count) and, apart from it, the state of its quizzes.
 * @param {{ progress?: { status?: string } }} lesson
 * @param {{ total: number, answered: number, correct: number, started: boolean, done: boolean }[]} [scores]
 * @returns {{ status: 'new'|'started'|'done', label: string, marked: boolean,
 *   quiz: ReturnType<typeof quizzesState> }}
 */
export function lessonState(lesson, scores = []) {
  const p = lesson?.progress || {};
  const marked = p.status === 'done';
  // A corrupted stored status is "нов".
  const status = marked ? 'done' : p.status === 'started' ? 'started' : 'new';
  const label = marked ? 'Завършен' : status === 'started' ? 'Започнат' : 'Нов';
  return { status, label, marked, quiz: quizzesState(scores) };
}

/** "Завършени: N от M": the lessons (not references, not retired) whose material is done. */
export function countDone(lessons, stateOf = (l) => lessonState(l)) {
  const main = lessons.filter((l) => l.kind === 'lesson' && !l.retired);
  return { done: main.filter((l) => stateOf(l).status === 'done').length, total: main.length };
}
