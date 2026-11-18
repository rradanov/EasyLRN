// Screen "Курс" (#/c/<courseId>). For now only the imported lessons and
// references in course order (T-007); status, "Продължи" and the reader
// links come in T-011.
import { h, mount } from '../dom.js';
import { getCourse, listLessons } from '../db.js';

export function courseScreen({ params }) {
  const { courseId } = params;
  const lessonsBox = h('div', { 'data-list': 'lessons' }, h('p', { class: 'muted', text: 'Зареждам…' }));
  const missionBox = h('div', {});

  (async () => {
    const [course, lessons] = await Promise.all([getCourse(courseId), listLessons(courseId)]);
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
          h('li', { 'data-lesson': l.id }, h('span', { class: 'import__num', text: l.number }), ' ', l.title))),
      ] : [];
    };
    mount(lessonsBox, ...group('lesson', 'Уроци'), ...group('reference', 'Справочници'));
    mount(missionBox, h('p', { text: course.title }));
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
        ),
        h('div', {},
          h('h2', { class: 'screen__heading', text: 'Мисия' }),
          missionBox,
        ),
      ),
    ),
  };
}
