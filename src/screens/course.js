// Screen "Курс" (#/c/<courseId>), T-011 (UI-DESIGN §3, F1), T-011-fix (D-038).
//
// The course name is the h1 (T012-I5); the app bar shows the course id as
// plain text on this screen. Two columns on a wide screen (tablet landscape
// 1280/1920 px and portrait 1200 px), one below 900 px:
// - side (right; first when narrow, so "Продължи" is at the top): the
//   progress of the course and "Продължи", "Последни дейности", "Ресурси"
//   (RESOURCES.md, rendered Markdown, collapsed);
// - main (left, wider): "Уроци" and "Справочници" in INDEX order and the
//   lessons planned in INDEX.md that are not imported yet ("скоро").
//   D-040 (T-057): every lesson carries its quizzes (by `lesson`); an arrow
//   button unfolds them with "Отвори" and "Нулирай". There is no separate
//   "Тестове" section; quizzes of no lesson of the course are in "Други
//   тестове" at the bottom.
//   D-041 (T-059): the material and the quizzes are counted apart. The
//   folded line has the status of the MATERIAL (○ нов, ◐ започнат, ●
//   завършен = marked as finished), number, title (opens the lesson) and the
//   material line ("Завършен · 1 маркировка"); a lesson with quizzes has a
//   second line with their own mark ("Тестове: не са започнати / започнати /
//   минати") and the counter "Въпроси 7 от 26", plus "81 % верни" only once
//   all the questions are answered. "Завършени" and "Продължи/Започни" go by
//   the material.
//   "Последни дейности" (D-041) is the history of places (src/history.js):
//   lessons, references and quizzes with their position, newest first.
// D-039 (T-055): lessons no longer in the course (`retired`) are only in a
// collapsed "Вече не са в курса" (if there are any), not in the progress and
// never the target of "Продължи".
// D-038: MISSION.md and NOTES.md are not shown here; they stay in the course
// (imported as before) as context for the AI teacher (D-016).
// Every heading of a section is there once (the T-008 user check saw
// "Уроци" twice).
import { h, mount } from '../dom.js';
import {
  getCourse, listLessons, listQuizzes, getQuizAnswers, scoreQuiz, resetQuizAnswers,
  annotationsOfCourse, threadsFor, byIndex, STORES, listHistory,
} from '../db.js';
import { parseIndex, plural, courseName } from '../course-import.js';
import { renderMarkdown, withoutTitle, safeDecode } from '../markdown.js';
import { confirmBox } from './confirm.js';
import { readerLink } from './reader.js';
import { quizLink } from './quiz-link.js';
import { APP_NAME } from '../config.js';
import { normalizeNumber, resolveLessonPath } from '../lesson-id.js';
import { groupQuizzes, lessonState, countDone, percent, QUIZ_MARK } from '../lesson-status.js';
import { HISTORY_SHOWN } from '../history.js';

/** State word of one quiz (D-041): "не е започнат" / "започнат" / "минат". */
function quizStatus(score) {
  if (!score.total) return 'без въпроси';
  if (!score.started) return 'не е започнат';
  if (!score.done) return 'започнат';
  return 'минат';
}
/** "Въпроси 3 от 8" (answered of all). */
const quizCount = (score) => (score.total ? `Въпроси ${score.answered} от ${score.total}` : '');
/** "6 от 9 верни (67 %)" — only when every question is answered (D-041). */
const quizCorrect = (score) => (score.done ? `${score.correct} от ${score.total} верни (${percent(score.correct, score.total)}\u00A0%)` : '');

export const STATUS = Object.freeze({
  new: { mark: '○', label: 'нов' },
  started: { mark: '◐', label: 'започнат' },
  done: { mark: '●', label: 'завършен' },
});

const pad = (n) => String(n).padStart(2, '0');
/**
 * "днес 10:42" / "вчера 18:03" / "12.11.2026 10:42" (local time).
 * @param {string|number|Date} when
 * @param {Date} [now]
 */
export function whenText(when, now = new Date()) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `днес ${time}`;
  if (diff === 1) return `вчера ${time}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${time}`;
}

const lessonLabel = (l) => (l.kind === 'reference' ? `справочник ${l.number}` : `урок ${l.number}`);

/**
 * The lesson to continue: the last opened one; else the first lesson whose
 * material is not done (D-041: the quizzes do not count here).
 */
export function continueTarget(all, stateOf = (l) => lessonState(l)) {
  // D-039: never to a lesson that is no longer in the course.
  // D-041 (addendum, T-061): only to lessons, never to a reference.
  const lessons = all.filter((l) => !l.retired && l.kind === 'lesson');
  const opened = lessons.filter((l) => l.progress?.lastOpenedAt)
    .sort((a, b) => String(b.progress.lastOpenedAt).localeCompare(String(a.progress.lastOpenedAt)));
  if (opened.length) return { lesson: opened[0], resume: true };
  const first = lessons.find((l) => stateOf(l).status !== 'done') || lessons[0];
  return first ? { lesson: first, resume: false } : null;
}

/** Counters per lesson id from the user's data: { marks, questions, topics }. */
async function lessonCounters(courseId) {
  const counters = new Map();
  const get = (id) => {
    if (!counters.has(id)) counters.set(id, { marks: 0, questions: 0, topics: 0 });
    return counters.get(id);
  };
  const [annotations, subtopics] = await Promise.all([
    annotationsOfCourse(courseId),
    byIndex(STORES.subtopics, 'by_course', courseId),
  ]);
  const onLessons = annotations.filter((a) => a.target?.type === 'lesson');
  const threads = await Promise.all(onLessons.map((a) => threadsFor(a.id)));
  onLessons.forEach((a, i) => {
    const c = get(a.target.id);
    if (a.color) c.marks++;
    c.questions += threads[i].length;
  });
  for (const s of subtopics) if (s.rootLessonId) get(s.rootLessonId).topics++;
  return { counters, subtopics };
}

function countersText(c) {
  if (!c) return '';
  return [
    c.marks ? plural(c.marks, 'маркировка', 'маркировки') : '',
    c.questions ? plural(c.questions, 'въпрос', 'въпроса') : '',
    c.topics ? plural(c.topics, 'тема', 'теми') : '',
  ].filter(Boolean).join(' · ');
}

/** Session memory of the unfolded lessons (D-040: "може да се помни в сесията"). */
const OPEN_KEY = (courseId) => `easylrn:course-open:${courseId}`;
function openSet(courseId) {
  try {
    const v = JSON.parse(sessionStorage.getItem(OPEN_KEY(courseId)) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function rememberOpen(courseId, id, open) {
  const set = openSet(courseId);
  if (open) set.add(id); else set.delete(id);
  try { sessionStorage.setItem(OPEN_KEY(courseId), JSON.stringify([...set])); } catch { /* private mode: not remembered */ }
}

/**
 * One quiz of a lesson (or of "Други тестове"): title, "Въпроси 3 от 8", its
 * state and — once all are answered — the right ones, "Отвори" and "Нулирай"
 * (with a confirmation, T-049). `onChange` runs after a reset so the lesson
 * line, the course progress and the history follow.
 */
function quizRow(courseId, quiz, entry, { onChange, note } = {}) {
  const countEl = h('span', { class: 'quiz-list__count', 'data-field': 'quiz-count' });
  const statusEl = h('span', { class: 'quiz-list__status', 'data-field': 'quiz-status' });
  const correctEl = h('span', { class: 'quiz-list__correct', 'data-field': 'quiz-correct' });
  const sep1 = h('span', { 'aria-hidden': 'true' });
  const sep2 = h('span', { 'aria-hidden': 'true' });
  const li = h('li', { class: 'quiz-list__item', 'data-quiz': quiz.id });
  const open = h('a', { class: 'button quiz-list__link', href: quizLink(courseId, quiz) },
    'Отвори', h('span', { class: 'visually-hidden', text: ` теста „${quiz.title}“` }));
  const reset = h('button', {
    type: 'button', class: 'button quiz-list__reset', 'data-field': 'quiz-reset',
    'aria-label': `Нулирай отговорите: ${quiz.title}`,
  }, 'Нулирай');
  const show = () => {
    const s = entry.score;
    li.dataset.state = !s.total ? 'none' : s.done ? 'passed' : s.started ? 'started' : 'new';
    countEl.textContent = quizCount(s);
    statusEl.textContent = quizStatus(s);
    correctEl.textContent = quizCorrect(s);
    sep1.textContent = countEl.textContent ? ' · ' : '';
    sep2.textContent = correctEl.textContent ? ' · ' : '';
    reset.disabled = !s.started;
  };
  show();
  reset.addEventListener('click', () => {
    if (li.querySelector('.quiz__confirm')) return;
    const box = confirmBox({
      text: `Да изтрия ли отговорите на „${quiz.title}“? Тестът ще започне отначало.`,
      yes: 'Изтрий',
      label: 'Нулиране на отговорите',
      onNo: () => { box.remove(); reset.focus(); },
      onYes: async () => {
        try { await resetQuizAnswers(quiz.id); } catch (err) { console.warn('Cannot reset the answers:', err); }
        // T058-D3: the focused "Изтрий" goes away and "Нулирай" is disabled:
        // the focus moves to "Отвори" of the same quiz, not to <body>.
        const hadFocus = box.contains(document.activeElement) || document.activeElement === document.body;
        box.remove();
        entry.score = scoreQuiz(quiz, { choices: {} });
        show();
        if (hadFocus && li.isConnected) open.focus();
        onChange?.();
      },
    });
    li.append(box);
    box.focusCancel();
  });
  li.append(
    h('div', { class: 'quiz-list__row' },
      h('div', { class: 'quiz-list__info' },
        h('span', { class: 'quiz-list__title', text: quiz.title }),
        note ? h('span', { class: 'quiz-list__lesson', text: note }) : null,
        h('span', { class: 'quiz-list__line' }, countEl, sep1, statusEl, sep2, correctEl)),
      h('div', { class: 'quiz-list__actions' }, open, reset)));
  return li;
}

/**
 * One lesson or reference of the list (D-040, D-041): mark of the material,
 * number and title (opens the lesson), the material line, the line of its
 * quizzes (their own mark and "Въпроси x от y") and — if it has quizzes — an
 * arrow that unfolds them. `entries` are this lesson's quizzes with their
 * live scores.
 * @returns {{ el: HTMLElement, update: () => void }}
 */
function lessonItem(courseId, lesson, counters, entries, { onChange } = {}) {
  const markEl = h('span', { class: 'course-item__mark', 'aria-hidden': 'true' });
  const metaText = h('span', { 'data-field': 'lesson-meta-text' });
  // The quiz mark: a square drawn with CSS (empty / half / full with a tick, no
  // glyph: ☐ ◩ ☑ are missing from many fonts) and its words, which are its name.
  const quizIcon = h('span', { class: 'quiz-mark__icon', 'aria-hidden': 'true' });
  const quizWord = h('span', { class: 'quiz-mark__text' });
  const quizMark = h('span', { class: 'quiz-mark', 'data-field': 'lesson-quiz-mark' }, quizIcon, quizWord);
  const quizCountEl = h('span', { 'data-field': 'lesson-quiz-count' });
  const quizCorrectEl = h('span', { 'data-field': 'lesson-quiz-correct' });
  const quizSep = h('span', { 'aria-hidden': 'true' });
  const quizLine = h('p', { class: 'course-item__quizline', 'data-field': 'lesson-quiz-line', hidden: true },
    quizMark, ' ', h('span', { class: 'course-item__quizcount' }, quizCountEl, quizSep, quizCorrectEl));
  const li = h('li', { class: 'course-item', 'data-item': lesson.id });
  const update = () => {
    const state = lessonState(lesson, entries.map((e) => e.score));
    li.dataset.status = state.status;
    markEl.textContent = STATUS[state.status].mark;
    // D-041: the material only (no "отворен днес …" any more).
    const meta = [state.label];
    const counts = countersText(counters);
    if (counts) meta.push(counts);
    metaText.textContent = meta.join(' · ');
    const q = state.quiz;
    li.dataset.quizzes = q.state;
    quizLine.hidden = q.state === 'none';
    if (q.state !== 'none') {
      const mark = QUIZ_MARK[q.state];
      quizMark.dataset.state = q.state;
      quizWord.textContent = mark.name;
      quizCountEl.textContent = q.countText;
      quizCorrectEl.textContent = q.correctText;
      quizSep.textContent = q.correctText ? ' · ' : '';
    }
  };
  update();
  const titleRow = h('div', { class: 'course-item__row' },
    h('a', { class: 'lesson-link', href: readerLink(courseId, lesson), 'data-lesson': lesson.id },
      h('span', { class: 'import__num', text: lesson.number }), ' ', lesson.title));
  let panel = null;
  if (entries.length) {
    // Stable per lesson (a number is unique in a course): the same id after Back.
    const panelId = `course-quizzes-${lesson.kind === 'reference' ? 'r' : 'l'}-${String(lesson.number).replace(/[^A-Za-z0-9]/g, '')}`;
    const open = openSet(courseId).has(lesson.id);
    const what = lesson.kind === 'reference' ? 'справочник' : 'урок';
    const toggle = h('button', {
      type: 'button', class: 'course-item__toggle', 'data-field': 'lesson-toggle',
      'aria-expanded': String(open), 'aria-controls': panelId,
      'aria-label': `Тестове към ${what} ${lesson.number}`,
    }, h('span', { class: 'course-item__chevron', 'aria-hidden': 'true' }));
    panel = h('div', { class: 'course-item__quizzes', id: panelId, 'data-field': 'lesson-quiz-panel', hidden: open ? null : true },
      h('ul', { class: 'quiz-list', 'data-list': 'quizzes' },
        entries.map((e) => quizRow(courseId, e.quiz, e, { onChange: () => { update(); onChange?.(); } }))));
    toggle.addEventListener('click', () => {
      const now = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(now));
      panel.hidden = !now;
      rememberOpen(courseId, lesson.id, now);
    });
    titleRow.append(toggle);
  }
  li.append(markEl,
    h('div', { class: 'course-item__body' },
      titleRow,
      h('p', { class: 'course-item__meta', 'data-field': 'lesson-meta' },
        h('span', { class: 'visually-hidden', text: 'Статус: ' }), metaText),
      quizLine,
      panel));
  return { el: li, update };
}

/** A planned lesson from INDEX.md that is not imported yet. */
function plannedItem(p) {
  return h('li', { class: 'course-item course-item--planned', 'data-status': 'planned', 'data-planned': p.number },
    h('span', { class: 'course-item__mark', 'aria-hidden': 'true', text: '○' }),
    h('div', { class: 'course-item__body' },
      h('p', { class: 'course-item__title' }, h('span', { class: 'import__num', text: p.number }), ' ', p.title || ''),
      h('p', { class: 'course-item__meta', text: 'Скоро — още не е импортиран' })));
}

/** A section with one h2 (the only heading of that list). */
function section(id, title, ...content) {
  return h('section', { class: 'course__section', 'aria-labelledby': `course-${id}-heading`, 'data-section': id },
    h('h2', { class: 'screen__heading', id: `course-${id}-heading`, text: title }),
    ...content);
}

/** A collapsible section of the side column: the heading is the summary. */
function docSection(id, title, md, { open = false, resolveLink, emptyText } = {}) {
  const body = h('div', { class: 'course__doc md', 'data-field': `${id}-text` });
  // renderMarkdown never throws (T012-D1/D2): a bad file is a note in this block only.
  const fragment = md ? renderMarkdown(md, { headingOffset: 1, resolveLink }) : null;
  if (fragment && fragment.textContent.trim()) body.append(fragment);
  else body.append(h('p', { class: 'muted', text: emptyText || 'Няма текст.' }));
  return h('details', { class: 'course__details', 'data-section': id, open: open || null },
    h('summary', { class: 'course__summary' }, h('h2', { class: 'screen__heading', text: title })),
    body);
}

export function courseScreen({ params }) {
  const { courseId } = params;
  const head = h('div', { class: 'course__head', 'data-field': 'course-head' },
    h('h1', { class: 'course__title', 'data-field': 'course-title', text: courseId }));
  const statusBox = h('div', { class: 'course__status', 'data-field': 'course-status' });
  const lessonsBox = h('div', { class: 'course__lists', 'data-list': 'lessons' }, h('p', { class: 'muted', text: 'Зареждам…' }));
  const sideBox = h('div', { class: 'course__side-inner' });
  let destroyed = false;

  (async () => {
    const [course, lessons, quizzes] = await Promise.all([getCourse(courseId), listLessons(courseId), listQuizzes(courseId)]);
    if (destroyed) return;
    if (!course) {
      mount(lessonsBox, h('p', { class: 'empty', text: 'Курсът още не е импортиран.' }));
      return;
    }
    const [{ counters }, answers] = await Promise.all([
      lessonCounters(courseId).catch(() => ({ counters: new Map(), subtopics: [] })),
      Promise.all(quizzes.map((q) => getQuizAnswers(q.id))),
    ]);
    if (destroyed) return;
    const scores = quizzes.map((q, i) => scoreQuiz(q, answers[i]));
    // D-040: every quiz under its lesson (by `lesson`); live scores, so a reset
    // updates the lesson line and the progress of the course.
    const entryOf = new Map(quizzes.map((q, i) => [q.id, { quiz: q, score: scores[i] }]));
    const { byLesson, others } = groupQuizzes(lessons, quizzes);
    const entriesOf = (l) => (byLesson.get(l.id) || []).map((q) => entryOf.get(q.id));
    const stateOf = (l) => lessonState(l, entriesOf(l).map((e) => e.score));
    // "Последни дейности" (D-041): the history, read again after every change here.
    const activityBox = h('div', { class: 'course__activity', 'data-field': 'activity' });
    let historyRun = 0;
    const refreshHistory = async () => {
      const run = ++historyRun;
      let records = [];
      try { records = await listHistory(courseId); } catch (err) { console.warn('Cannot read the history:', err); }
      if (destroyed || run !== historyRun) return;
      mount(activityBox, historyList(courseId, records, lessons, quizzes));
    };
    refreshHistory();

    // --- Head: title, progress, "Продължи" ---------------------------------------
    // D-039: retired lessons are only in "Вече не са в курса" (not counted).
    const current = lessons.filter((l) => !l.retired);
    const retired = lessons.filter((l) => l.retired);
    const only = (kind) => current.filter((l) => l.kind === kind);
    const name = courseName(course);
    mount(head, h('h1', { class: 'course__title', 'data-field': 'course-title', text: name }));
    if (name !== courseId) document.title = `${name} · ${APP_NAME}`;
    const renderStatus = () => {
      // D-041: a lesson is done when its material is marked as finished.
      const { done, total } = countDone(lessons, stateOf);
      const target = continueTarget(lessons, stateOf);
      mount(statusBox,
        total ? h('div', { class: 'course__progress' },
          h('progress', { class: 'course__bar', max: String(total), value: String(done), 'aria-labelledby': 'course-progress-text' }),
          h('p', { class: 'course__progress-text', id: 'course-progress-text', 'data-field': 'course-progress', text: `Завършени: ${done} от ${plural(total, 'урок', 'урока')}` })) : null,
        target ? h('a', {
          class: 'button button--primary course__continue', 'data-action': 'continue', href: readerLink(courseId, target.lesson),
        }, `${target.resume ? 'Продължи' : 'Започни'}: ${lessonLabel(target.lesson)} — ${target.lesson.title}`) : null);
    };
    renderStatus();

    // --- Lessons with their quizzes, references, planned ------------------------
    const index = parseIndex(course.meta?.index);
    const numKey = (n) => normalizeNumber(n) ?? String(n).toUpperCase();
    const have = new Set(lessons.map((l) => numKey(l.number)));
    const seen = new Set();
    const planned = [...index.rows, ...index.planned]
      .filter((r) => {
        const k = numKey(r.number);
        if (have.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    // T058-D1: after "Нулирай" the history is read again as well.
    const onChange = () => { renderStatus(); refreshHistory(); };
    const item = (l) => lessonItem(courseId, l, counters.get(l.id), entriesOf(l), { onChange }).el;
    const list = (kind) => {
      const items = [
        ...only(kind).map(item),
        ...planned.filter((p) => p.kind === kind).map(plannedItem),
      ];
      return items.length ? h('ul', { class: 'course-list', 'data-kind': kind }, items) : null;
    };
    const lessonList = list('lesson');
    const refList = list('reference');
    // "Вече не са в курса" (D-039): collapsed, only if there are such lessons.
    // The quizzes of a retired lesson stay under it there (D-040).
    const retiredBox = retired.length ? h('details', { class: 'course__details course__retired', 'data-section': 'retired' },
      h('summary', { class: 'course__summary' }, h('h2', { class: 'screen__heading', text: 'Вече не са в курса' })),
      h('p', { class: 'muted', text: 'Тези уроци са махнати от курса. Можеш да ги отвориш; данните ти за тях са запазени и не се броят в прогреса.' }),
      h('ul', { class: 'course-list', 'data-kind': 'retired' }, retired.map(item))) : null;
    // "Други тестове" (D-040): quizzes without a lesson of this course, at the bottom.
    const otherBox = others.length ? section('other-quizzes', 'Други тестове',
      h('ul', { class: 'quiz-list quiz-list--other', 'data-list': 'quizzes' }, others.map((q) => quizRow(courseId, q, entryOf.get(q.id), {
        onChange,
        note: q.lesson ? `към урок ${q.lesson} — няма го в курса` : 'без урок',
      })))) : null;
    mount(lessonsBox,
      lessonList ? section('lessons', 'Уроци', lessonList) : null,
      refList ? section('references', 'Справочници', refList) : null,
      !lessonList && !refList ? h('p', { class: 'empty', text: 'В курса няма уроци.' }) : null,
      retiredBox,
      otherBox);

    // --- Side: recent activity, resources (D-038: no mission, no notes) -------
    // D-039 §А.3: by path, an earlier path, or the number in the file name.
    const byPath = (p) => resolveLessonPath(lessons, p);
    const resolveLink = (href) => {
      const path = href.replace(/^\.\//, '').replace(/[?#].*$/, '');
      // T012-D1: a malformed %-escape ("100%.pdf") is no course link: dead text.
      const decoded = safeDecode(path);
      const l = resolveLessonPath(lessons, path, { byNumber: false }) || (decoded !== null ? byPath(decoded) : undefined);
      return l ? readerLink(courseId, l) : null;
    };
    const meta = course.meta || {};
    mount(sideBox,
      section('activity', 'Последни дейности', activityBox),
      meta.resources ? docSection('resources', 'Ресурси', withoutTitle(meta.resources), { resolveLink }) : null);
  })().catch((err) => {
    console.warn('Cannot load course:', err);
    mount(lessonsBox, h('p', { class: 'empty', text: 'Курсът не може да се зареди.' }));
  });

  return {
    title: courseId,
    // The h1 of this screen is the course name (T012-I5): the app bar title is plain text here.
    ownHeading: true,
    back: { href: '#/', label: 'Курсове' },
    destroy() { destroyed = true; },
    body: h('section', { class: 'screen screen--course', 'data-screen': 'course' },
      head,
      h('div', { class: 'course__layout' },
        // The side comes first in the DOM: on a narrow screen "Продължи" is at the top
        // (and the reading order is the visual order); on a wide one CSS puts it right.
        h('aside', { class: 'course__side', 'aria-label': 'За курса' },
          h('div', { class: 'course__side-body' }, statusBox, sideBox)),
        h('div', { class: 'course__main' }, lessonsBox),
      ),
    ),
  };
}

/** Link to a place of the history, at its position (T-059). */
function placeLink(courseId, record, target) {
  if (record.kind === 'quiz') return `${quizLink(courseId, target)}?q=${(record.question ?? 0) + 1}`;
  if (record.anchor) return `${readerLink(courseId, target)}?at=${encodeURIComponent(record.anchor)}`;
  return `${readerLink(courseId, target)}?y=${record.scrollY ?? 0}`;
}

/**
 * "Последни дейности" (D-041): the newest HISTORY_SHOWN places — lesson,
 * reference or quiz — each a link back to its position. A place that is no
 * longer in the database (a quiz taken out) is left out; a retired lesson
 * still opens (D-039), so it stays.
 */
function historyList(courseId, records, lessons, quizzes) {
  const lessonById = new Map(lessons.map((l) => [l.id, l]));
  const quizById = new Map(quizzes.map((q) => [q.id, q]));
  const items = [];
  for (const r of records) {
    if (items.length >= HISTORY_SHOWN) break;
    if (r.kind === 'quiz') {
      const q = quizById.get(r.id);
      if (!q) continue;
      const n = q.questions?.length || 0;
      const at = Math.min((r.question ?? 0) + 1, Math.max(n, 1));
      items.push({ r, text: `Тест „${q.title}“`, where: n ? `въпрос ${at} от ${n}` : '', href: placeLink(courseId, r, q) });
    } else {
      const l = lessonById.get(r.id);
      if (!l) continue;
      const label = lessonLabel(l);
      items.push({ r, text: `${label.charAt(0).toUpperCase()}${label.slice(1)} „${l.title}“`, where: '', href: placeLink(courseId, r, l) });
    }
  }
  if (!items.length) return h('p', { class: 'muted', 'data-field': 'activity-empty', text: 'Още няма дейности. Отвори урок, за да започнеш.' });
  return h('ol', { class: 'activity', 'data-list': 'activity' }, items.map((item) =>
    h('li', { class: 'activity__item', 'data-place': item.r.id, 'data-kind': item.r.kind },
      h('a', { class: 'activity__link', href: item.href },
        h('span', { class: 'activity__text', text: item.text }),
        item.where ? h('span', { class: 'activity__where', text: ` · ${item.where}` }) : null),
      h('span', { class: 'activity__when', text: ` — ${whenText(item.r.visitedAt)}` }))));
}
