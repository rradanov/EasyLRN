// Screen "Курс" (#/c/<courseId>). The imported lessons and references in
// course order (T-007), each a link to the reader (T-009); status and
// "Продължи" come in T-011.
import { h, mount } from '../dom.js';
import { getCourse, listLessons, listQuizzes, getQuizAnswers, scoreQuiz, resetQuizAnswers } from '../db.js';
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

export function courseScreen({ params }) {
  const { courseId } = params;
  const lessonsBox = h('div', { 'data-list': 'lessons' }, h('p', { class: 'muted', text: 'Зареждам…' }));
  const quizzesBox = h('div', { 'data-list': 'quizzes' });
  const missionBox = h('div', {});

  (async () => {
    const [course, lessons, quizzes] = await Promise.all([getCourse(courseId), listLessons(courseId), listQuizzes(courseId)]);
    if (!course) {
      mount(lessonsBox, h('p', { class: 'empty', text: 'Курсът още не е импортиран.' }));
      mount(missionBox, null);
      return;
    }
    const group = (kind, label) => {
      const items = lessons.filter((l) => l.kind === kind);
      return items.length ? [
        h('h3', { class: 'card__eyebrow', text: label }),
        h('ul', { class: 'import__items' }, items.map((l) =>
          h('li', { 'data-lesson': l.id },
            h('a', { class: 'lesson-link', href: readerLink(courseId, l) },
              h('span', { class: 'import__num', text: l.number }), ' ', l.title)))),
      ] : [];
    };
    mount(lessonsBox, ...group('lesson', 'Уроци'), ...group('reference', 'Справочници'));
    mount(missionBox, h('p', { text: course.title }));

    // "Тестове" (D-032): quizzes shown by the app, with their status and
    // "Нулирай" (T-049, D-035) with a confirmation.
    if (quizzes.length) {
      const scores = await Promise.all(quizzes.map(async (q) => scoreQuiz(q, await getQuizAnswers(q.id))));
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
      mount(quizzesBox,
        h('h2', { class: 'screen__heading', text: 'Тестове' }),
        h('ul', { class: 'import__items quiz-list' }, items),
      );
    }
  })().catch((err) => {
    console.warn('Cannot load course:', err);
    mount(lessonsBox, h('p', { class: 'empty', text: 'Курсът не може да се зареди.' }));
  });

  return {
    title: courseId,
    back: { href: '#/', label: 'Курсове' },
    body: h('section', { class: 'screen screen--course', 'data-screen': 'course' },
      h('div', { class: 'two-col' },
        h('div', {},
          h('h2', { class: 'screen__heading', text: 'Уроци' }),
          lessonsBox,
          quizzesBox,
        ),
        h('div', {},
          h('h2', { class: 'screen__heading', text: 'Мисия' }),
          missionBox,
        ),
      ),
    ),
  };
}
