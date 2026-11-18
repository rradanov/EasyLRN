// Fallback for unknown routes.
import { h } from '../dom.js';

export function notFoundScreen() {
  return {
    title: 'Няма такава страница',
    back: { href: '#/', label: 'Курсове' },
    body: h('section', { class: 'screen', 'data-screen': 'not-found' },
      h('p', { class: 'empty', text: 'Тази страница не съществува.' }),
      h('p', {}, h('a', { href: '#/', text: 'Към курсовете' })),
    ),
  };
}
