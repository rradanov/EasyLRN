// Screen "Четец" (#/c/<courseId>/read/<lesson>?path=a/b). <lesson> is the
// number ("0001", "R01") or the lesson id. The lesson or reference is shown in
// an isolated iframe (T-045, D-029: opaque origin, postMessage bridge); columns
// come in T-027.
import { h, mount } from '../dom.js';
import { link } from '../router.js';
import { getCourse, listLessons, getSettings, setLessonProgress, quizzesForLesson } from '../db.js';
import { createLessonFrame } from '../lesson-frame.js';
import { quizLink } from './quiz-link.js';

/** Find a lesson by number (case-insensitive), id or path. */
export function findLesson(lessons, key) {
  const k = String(key);
  return lessons.find((l) => l.id === k)
    || lessons.find((l) => String(l.number).toUpperCase() === k.toUpperCase())
    || lessons.find((l) => l.path === k)
    || null;
}

const label = (key) => (/^R\d/i.test(key) ? `Справочник ${key}` : `Урок ${key}`);

/** Hash link of the reader for a lesson (by number). */
export const readerLink = (courseId, lesson) => link('c', courseId, 'read', lesson.number || lesson.id);

export function readerScreen({ params, query }) {
  const { courseId, lessonId } = params;
  const path = (query.get('path') || '').split('/').filter(Boolean);
  const hash = query.get('at') ? `#${query.get('at')}` : '';
  const quizzesBox = h('div', { class: 'reader__quizzes', 'data-field': 'lesson-quizzes' });
  const content = h('div', { class: 'reader__content', 'data-field': 'reader-content' },
    h('p', { class: 'muted', text: 'Зареждам…' }));
  let frame = null;
  let destroyed = false;

  (async () => {
    const [course, lessons, settings] = await Promise.all([getCourse(courseId), listLessons(courseId), getSettings()]);
    if (destroyed) return;
    const lesson = course && findLesson(lessons, lessonId);
    if (!course || !lesson) {
      mount(content, h('p', { class: 'empty', 'data-field': 'reader-missing',
        text: course ? 'Урокът не е намерен в курса. Импортирай курса отново.' : 'Курсът още не е импортиран.' }));
      return;
    }
    // "Тест към урока" (D-032): a lesson may have several quizzes (field `lesson`).
    if (lesson.number) {
      quizzesForLesson(courseId, lesson.number).then((quizzes) => {
        if (destroyed || !quizzes.length) return;
        mount(quizzesBox,
          h('h3', { class: 'card__eyebrow', text: quizzes.length > 1 ? 'Тестове към урока' : 'Тест към урока' }),
          h('ul', { class: 'import__items quiz-list' }, quizzes.map((q) =>
            h('li', { 'data-quiz': q.id },
              h('a', { class: 'quiz-list__link', href: quizLink(courseId, q) }, q.title)))));
      }).catch((err) => console.warn('Cannot load the lesson quizzes:', err));
    }
    frame = createLessonFrame({
      course,
      lesson,
      lessons,
      fontScale: settings.fontScale,
      initialScroll: lesson.progress?.scrollY || 0,
      hash,
      onNavigate: (other, otherHash) => {
        const at = otherHash && otherHash.length > 1 ? `?at=${encodeURIComponent(otherHash.slice(1))}` : '';
        location.hash = `${readerLink(courseId, other)}${at}`;
      },
      onScroll: (y) => {
        setLessonProgress(lesson.id, { scrollY: y }).catch((err) => console.warn('Cannot save the position:', err));
      },
    });
    mount(content, frame.element);
  })().catch((err) => {
    console.warn('Cannot open the lesson:', err);
    mount(content, h('p', { class: 'empty', text: 'Урокът не може да се отвори.' }));
  });

  return {
    title: label(lessonId),
    back: { href: link('c', courseId), label: courseId },
    destroy() {
      destroyed = true;
      frame?.destroy();
    },
    body: h('section', { class: 'screen screen--reader', 'data-screen': 'reader' },
      h('nav', { class: 'breadcrumb', 'aria-label': 'Път' },
        h('span', { text: label(lessonId) }),
        ...path.map((id) => h('span', { text: ` › ${id}` })),
      ),
      content,
      quizzesBox,
    ),
  };
}
