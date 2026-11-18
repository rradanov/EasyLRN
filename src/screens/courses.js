// Screen "Курсове" (#/). Empty state only; import comes in T-007.
import { h } from '../dom.js';

export function coursesScreen() {
  return {
    title: 'EasyLRN',
    back: null,
    body: h('section', { class: 'screen screen--courses', 'data-screen': 'courses' },
      h('h2', { class: 'screen__heading', text: 'Моите курсове' }),
      h('p', { class: 'empty', text: 'Още нямаш курс. Изтегли папката LRN-… от Drive като ZIP и я импортирай.' }),
      h('div', { class: 'card-grid' },
        h('div', { class: 'card card--placeholder', 'aria-disabled': 'true' },
          h('p', { class: 'card__title', text: '＋ Импортирай курс' }),
          h('p', { class: 'card__meta', text: 'ZIP от Drive или отделни файлове · скоро' }),
        ),
      ),
    ),
  };
}
