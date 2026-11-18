// Screen "Четец" (#/c/<courseId>/read/<lessonId>?path=a/b). Placeholder until T-009/T-027.
import { h } from '../dom.js';
import { link } from '../router.js';

export function readerScreen({ params, query }) {
  const { courseId, lessonId } = params;
  const path = (query.get('path') || '').split('/').filter(Boolean);
  return {
    title: `Урок ${lessonId}`,
    back: { href: link('c', courseId), label: courseId },
    body: h('section', { class: 'screen screen--reader', 'data-screen': 'reader' },
      h('nav', { class: 'breadcrumb', 'aria-label': 'Път' },
        h('span', { text: `Урок ${lessonId}` }),
        ...path.map((id) => h('span', { text: ` › ${id}` })),
      ),
      h('p', { class: 'empty', text: 'Четецът с колони ще се появи в следващите версии.' }),
    ),
  };
}
