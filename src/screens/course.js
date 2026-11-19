// Screen "Курс" (#/c/<courseId>), T-011 (UI-DESIGN §3, F1).
//
// Two columns on a wide screen (tablet landscape 1280/1920 px and portrait
// 1200 px), one below 900 px:
// - main: the progress of the course and "Продължи"; "Уроци" and
//   "Справочници" in INDEX order with their status (○ нов, ◐ започнат,
//   ● завършен), counters and the lessons planned in INDEX.md that are not
//   imported yet ("скоро"); "Тестове" (D-032) with their status and "Нулирай";
// - side: "Мисия" (the text of MISSION.md, rendered Markdown, collapsible),
//   "Последни дейности", "Ресурси" and "Бележки на курса" (collapsed).
// Every heading of a section is there once (the T-008 user check saw
// "Уроци" twice).
import { h, mount } from '../dom.js';
import {
  getCourse, listLessons, listQuizzes, getQuizAnswers, scoreQuiz, resetQuizAnswers,
  annotationsOfCourse, threadsFor, byIndex, STORES,
} from '../db.js';
import { parseIndex, plural } from '../course-import.js';
import { renderMarkdown, withoutTitle } from '../markdown.js';
import { confirmBox } from './confirm.js';
import { readerLink } from './reader.js';
import { quizLink } from './quiz-link.js';

/** Status line of a quiz: "не е започнат" / "x от n" / "резултат: c от n верни". */
function quizStatus(score) {
  if (!score.total) return 'без въпроси';
  if (!score.started) return 'не е започнат';
  if (!score.done) return `${score.answered} от ${score.total} отговорени`;
  return `резултат: ${score.correct} от ${score.total} верни`;
}

export const STATUS = Object.freeze({
  new: { mark: '○', label: 'нов' },
  started: { mark: '◐', label: 'започнат' },
  done: { mark: '●', label: 'завършен' },
});
const statusOf = (lesson) => (STATUS[lesson.progress?.status] ? lesson.progress.status : 'new');

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

/** The lesson to continue: the last opened one; else the first lesson not done. */
export function continueTarget(lessons) {
  const opened = lessons.filter((l) => l.progress?.lastOpenedAt)
    .sort((a, b) => String(b.progress.lastOpenedAt).localeCompare(String(a.progress.lastOpenedAt)));
  if (opened.length) return { lesson: opened[0], resume: true };
  const first = lessons.find((l) => l.kind === 'lesson' && statusOf(l) !== 'done') || lessons[0];
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

/** One lesson or reference of the list. */
function lessonItem(courseId, lesson, counters, quizCount) {
  const status = statusOf(lesson);
  const { mark, label } = STATUS[status];
  const meta = [label[0].toUpperCase() + label.slice(1)];
  if (lesson.progress?.lastOpenedAt) meta.push(`отворен ${whenText(lesson.progress.lastOpenedAt)}`);
  const counts = countersText(counters);
  if (counts) meta.push(counts);
  if (quizCount) meta.push(plural(quizCount, 'тест', 'теста'));
  return h('li', { class: 'course-item', 'data-status': status, 'data-item': lesson.id },
    h('span', { class: 'course-item__mark', 'aria-hidden': 'true', text: mark }),
    h('div', { class: 'course-item__body' },
      h('a', { class: 'lesson-link', href: readerLink(courseId, lesson), 'data-lesson': lesson.id },
        h('span', { class: 'import__num', text: lesson.number }), ' ', lesson.title),
      h('p', { class: 'course-item__meta', 'data-field': 'lesson-meta' },
        h('span', { class: 'visually-hidden', text: 'Статус: ' }), meta.join(' · '))));
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
  const fragment = md ? renderMarkdown(md, { headingOffset: 1, resolveLink }) : null;
  if (fragment && fragment.textContent.trim()) body.append(fragment);
  else body.append(h('p', { class: 'muted', text: emptyText || 'Няма текст.' }));
  return h('details', { class: 'course__details', 'data-section': id, open: open || null },
    h('summary', { class: 'course__summary' }, h('h2', { class: 'screen__heading', text: title })),
    body);
}

export function courseScreen({ params }) {
  const { courseId } = params;
  const head = h('div', { class: 'course__head', 'data-field': 'course-head' });
  const lessonsBox = h('div', { class: 'course__lists', 'data-list': 'lessons' }, h('p', { class: 'muted', text: 'Зареждам…' }));
  const quizzesBox = h('div', { 'data-list': 'quizzes' });
  const sideBox = h('div', { class: 'course__side-inner' });
  let destroyed = false;

  (async () => {
    const [course, lessons, quizzes] = await Promise.all([getCourse(courseId), listLessons(courseId), listQuizzes(courseId)]);
    if (destroyed) return;
    if (!course) {
      mount(lessonsBox, h('p', { class: 'empty', text: 'Курсът още не е импортиран.' }));
      return;
    }
    const [{ counters, subtopics }, answers] = await Promise.all([
      lessonCounters(courseId).catch(() => ({ counters: new Map(), subtopics: [] })),
      Promise.all(quizzes.map((q) => getQuizAnswers(q.id))),
    ]);
    if (destroyed) return;
    const scores = quizzes.map((q, i) => scoreQuiz(q, answers[i]));
    const quizCount = new Map();
    for (const q of quizzes) if (q.lesson) quizCount.set(q.lesson, (quizCount.get(q.lesson) || 0) + 1);

    // --- Head: title, progress, "Продължи" ---------------------------------------
    const only = (kind) => lessons.filter((l) => l.kind === kind);
    const main = only('lesson');
    const done = main.filter((l) => statusOf(l) === 'done').length;
    const target = continueTarget(lessons);
    mount(head,
      h('p', { class: 'course__title', 'data-field': 'course-title', text: course.title || courseId }),
      main.length ? h('div', { class: 'course__progress' },
        h('progress', { class: 'course__bar', max: String(main.length), value: String(done), 'aria-labelledby': 'course-progress-text' }),
        h('p', { class: 'course__progress-text', id: 'course-progress-text', 'data-field': 'course-progress', text: `Завършени: ${done} от ${plural(main.length, 'урок', 'урока')}` })) : null,
      target ? h('a', {
        class: 'button button--primary course__continue', 'data-action': 'continue', href: readerLink(courseId, target.lesson),
      }, `${target.resume ? 'Продължи' : 'Започни'}: ${lessonLabel(target.lesson)} — ${target.lesson.title}`) : null);

    // --- Lessons, references, planned ------------------------------------------
    const index = parseIndex(course.meta?.index);
    const have = new Set(lessons.map((l) => String(l.number).toUpperCase()));
    const seen = new Set();
    const planned = [...index.rows, ...index.planned]
      .filter((r) => {
        const k = String(r.number).toUpperCase();
        if (have.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const list = (kind) => {
      const items = [
        ...only(kind).map((l) => lessonItem(courseId, l, counters.get(l.id), kind === 'lesson' ? quizCount.get(l.number) : 0)),
        ...planned.filter((p) => p.kind === kind).map(plannedItem),
      ];
      return items.length ? h('ul', { class: 'course-list', 'data-kind': kind }, items) : null;
    };
    const lessonList = list('lesson');
    const refList = list('reference');
    mount(lessonsBox,
      lessonList ? section('lessons', 'Уроци', lessonList) : null,
      refList ? section('references', 'Справочници', refList) : null,
      !lessonList && !refList ? h('p', { class: 'empty', text: 'В курса няма уроци.' }) : null);

    // --- "Тестове" (D-032): status and "Нулирай" (T-049, D-035) ---------------
    if (quizzes.length) {
      const items = quizzes.map((q, i) => {
        const statusEl = h('span', { class: 'quiz-list__status', 'data-field': 'quiz-status', text: quizStatus(scores[i]) });
        const li = h('li', { class: 'quiz-list__item', 'data-quiz': q.id });
        const reset = h('button', {
          type: 'button', class: 'button quiz-list__reset', 'data-field': 'quiz-reset',
          'aria-label': `Нулирай отговорите: ${q.title}`, disabled: scores[i].started ? undefined : true,
        }, 'Нулирай');
        reset.addEventListener('click', () => {
          if (li.querySelector('.quiz__confirm')) return;
          const box = confirmBox({
            text: `Да изтрия ли отговорите на „${q.title}“? Тестът ще започне отначало.`,
            yes: 'Изтрий',
            label: 'Нулиране на отговорите',
            onNo: () => { box.remove(); reset.focus(); },
            onYes: async () => {
              try { await resetQuizAnswers(q.id); } catch (err) { console.warn('Cannot reset the answers:', err); }
              box.remove();
              statusEl.textContent = quizStatus(scoreQuiz(q, { choices: {} }));
              reset.disabled = true;
            },
          });
          li.append(box);
          box.focusCancel();
        });
        li.append(
          h('div', { class: 'quiz-list__row' },
            h('a', { class: 'quiz-list__link', href: quizLink(courseId, q) },
              h('span', { class: 'quiz-list__title', text: q.title }),
              q.lesson ? h('span', { class: 'quiz-list__lesson', text: ` · урок ${q.lesson}` }) : null,
              statusEl),
            reset));
        return li;
      });
      mount(quizzesBox, section('quizzes', 'Тестове', h('ul', { class: 'import__items quiz-list' }, items)));
    }

    // --- Side: mission, recent activity, resources, notes ----------------------
    const byPath = new Map(lessons.map((l) => [l.path, l]));
    const resolveLink = (href) => {
      const path = href.replace(/^\.\//, '').replace(/[?#].*$/, '');
      const l = byPath.get(path) || byPath.get(decodeURIComponent(path));
      return l ? readerLink(courseId, l) : null;
    };
    const meta = course.meta || {};
    mount(sideBox,
      docSection('mission', 'Мисия', withoutTitle(meta.mission), {
        open: true, resolveLink, emptyText: meta.mission ? 'MISSION.md няма текст освен заглавието.' : 'Курсът няма MISSION.md.',
      }),
      section('activity', 'Последни дейности', activityList(courseId, lessons, quizzes, answers, scores, subtopics)),
      meta.resources ? docSection('resources', 'Ресурси', withoutTitle(meta.resources), { resolveLink }) : null,
      meta.notes ? docSection('notes', 'Бележки на курса', withoutTitle(meta.notes), { resolveLink }) : null);
  })().catch((err) => {
    console.warn('Cannot load course:', err);
    mount(lessonsBox, h('p', { class: 'empty', text: 'Курсът не може да се зареди.' }));
  });

  return {
    title: courseId,
    back: { href: '#/', label: 'Курсове' },
    destroy() { destroyed = true; },
    body: h('section', { class: 'screen screen--course', 'data-screen': 'course' },
      head,
      h('div', { class: 'course__layout' },
        h('div', { class: 'course__main' }, lessonsBox, quizzesBox),
        h('aside', { class: 'course__side', 'aria-label': 'За курса' }, sideBox),
      ),
    ),
  };
}

/** "Последни дейности": the newest 6 of lessons opened/finished, quizzes answered, topics. */
function activityList(courseId, lessons, quizzes, answers, scores, subtopics) {
  const items = [];
  for (const l of lessons) {
    if (l.progress?.completedAt && statusOf(l) === 'done') {
      items.push({ at: l.progress.completedAt, text: `Завършен ${lessonLabel(l)} „${l.title}“`, href: readerLink(courseId, l) });
    }
    if (l.progress?.lastOpenedAt) {
      items.push({ at: l.progress.lastOpenedAt, text: `Отворен ${lessonLabel(l)} „${l.title}“`, href: readerLink(courseId, l) });
    }
  }
  quizzes.forEach((q, i) => {
    if (scores[i].started && answers[i].updatedAt) {
      items.push({ at: answers[i].updatedAt, text: `Тест „${q.title}“: ${quizStatus(scores[i])}`, href: quizLink(courseId, q) });
    }
  });
  for (const s of subtopics) {
    if (s.createdAt && s.title) items.push({ at: s.createdAt, text: `Тема „${s.title}“`, href: null });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!items.length) return h('p', { class: 'muted', 'data-field': 'activity-empty', text: 'Още няма дейности. Отвори урок, за да започнеш.' });
  return h('ul', { class: 'activity', 'data-list': 'activity' }, items.slice(0, 6).map((item) =>
    h('li', { class: 'activity__item' },
      item.href ? h('a', { class: 'activity__link', href: item.href, text: item.text }) : h('span', { text: item.text }),
      h('span', { class: 'activity__when', text: ` — ${whenText(item.at)}` }))));
}
