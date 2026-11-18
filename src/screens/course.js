// Screen "Курс" (#/c/<courseId>). Placeholder until T-011.
import { h } from '../dom.js';

export function courseScreen({ params }) {
  const { courseId } = params;
  return {
    title: courseId,
    back: { href: '#/', label: 'Курсове' },
    body: h('section', { class: 'screen screen--course', 'data-screen': 'course' },
      h('div', { class: 'two-col' },
        h('div', {},
          h('h2', { class: 'screen__heading', text: 'Уроци' }),
          h('p', { class: 'empty', text: 'Курсът още не е импортиран.' }),
        ),
        h('div', {},
          h('h2', { class: 'screen__heading', text: 'Мисия' }),
          h('p', { class: 'muted', text: 'Тук ще се показва мисията от MISSION.md.' }),
        ),
      ),
    ),
  };
}
