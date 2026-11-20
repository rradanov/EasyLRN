// Screen "Курсове" (#/): the imported courses and "Импортирай курс" (T-007).
import { h, mount } from '../dom.js';
import { link } from '../router.js';
import { listCourses, listLessons } from '../db.js';
import { countDone } from '../lesson-status.js';
import { importCourse, describeSummary, errorMessage, plural, courseName } from '../course-import.js';

const PHASES = {
  read: 'Чета файловете…',
  hash: 'Проверявам файловете',
  save: 'Записвам курса…',
  done: 'Готово',
};

/** "Завършени: 1 от 5 · последно: урок 0003" */
function progressText(lessons) {
  // D-039: retired lessons ("Вече не са в курса") are not counted.
  // D-041: done = the material is marked as finished (as on "Курс"); the quizzes do not count.
  const { done, total } = countDone(lessons);
  const last = lessons.filter((l) => l.progress?.lastOpenedAt)
    .sort((a, b) => String(b.progress.lastOpenedAt).localeCompare(String(a.progress.lastOpenedAt)))[0];
  const lastText = last ? ` · последно: ${last.kind === 'reference' ? 'справочник' : 'урок'} ${last.number}` : '';
  return `Завършени: ${done} от ${total}${lastText}`;
}

async function courseCard(course) {
  const lessons = (await listLessons(course.id)).filter((l) => !l.retired);
  const nLessons = lessons.filter((l) => l.kind === 'lesson').length;
  const nRefs = lessons.length - nLessons;
  return h('a', { class: 'card card--course', href: link('c', course.id), 'data-course': course.id },
    h('p', { class: 'card__eyebrow', text: course.id }),
    h('p', { class: 'card__title', text: courseName(course) }),
    h('p', { class: 'card__meta', text: `${plural(nLessons, 'урок', 'урока')} · ${plural(nRefs, 'справочник', 'справочника')}` }),
    // T-011: the progress of the course.
    nLessons ? h('p', { class: 'card__meta card__progress', 'data-field': 'course-progress', text: progressText(lessons) }) : null,
  );
}

function importPanel(onImported) {
  const zipInput = h('input', { type: 'file', accept: '.zip,application/zip,application/x-zip-compressed', multiple: true, hidden: true, 'data-input': 'zip' });
  const filesInput = h('input', { type: 'file', multiple: true, hidden: true, 'data-input': 'files' });
  const folderInput = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, 'data-input': 'folder' });

  const bar = h('progress', { class: 'import__bar', max: '1', value: '0' });
  const status = h('p', { class: 'import__status', role: 'status', 'aria-live': 'polite', 'data-field': 'import-status' });
  const result = h('div', { class: 'import__result', 'data-field': 'import-result', hidden: true });
  const error = h('p', { class: 'import__error', role: 'alert', 'data-field': 'import-error', hidden: true });
  const progressBox = h('div', { class: 'import__progress', hidden: true }, bar, status);

  const buttons = [
    h('button', { type: 'button', class: 'button button--primary', 'data-action': 'import-zip', onclick: () => zipInput.click() }, 'Избери ZIP'),
    h('button', { type: 'button', class: 'button', 'data-action': 'import-files', onclick: () => filesInput.click() }, 'Отделни файлове'),
    h('button', { type: 'button', class: 'button', 'data-action': 'import-folder', onclick: () => folderInput.click() }, 'Папка'),
  ];

  async function run(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    buttons.forEach((b) => { b.disabled = true; });
    error.hidden = true;
    result.hidden = true;
    progressBox.hidden = false;
    bar.removeAttribute('value'); // indeterminate while reading
    status.textContent = PHASES.read;
    try {
      const summary = await importCourse(files, {
        onProgress: ({ phase, done, total }) => {
          if (phase === 'hash' && total) {
            bar.max = total;
            bar.value = done;
            status.textContent = `${PHASES.hash}: ${done} от ${total}…`;
          } else {
            if (phase === 'done') { bar.max = 1; bar.value = 1; } else bar.removeAttribute('value');
            status.textContent = PHASES[phase] || '';
          }
        },
      });
      progressBox.hidden = true;
      mount(result,
        h('p', { class: 'import__headline', 'data-status': summary.status, text: describeSummary(summary) }),
        h('ul', { class: 'import__items' },
          summary.items.map((i) => h('li', {}, h('span', { class: 'import__num', text: i.number }), ' ', i.title))),
        summary.skippedPdf
          ? h('p', { class: 'muted', text: `Пропуснати PDF файлове: ${summary.skippedPdf} (не се импортират; отварят се от Drive).` })
          : null,
        h('a', { class: 'button', href: link('c', summary.courseId) }, 'Отвори курса'),
      );
      result.hidden = false;
      onImported?.(summary);
    } catch (err) {
      console.warn('Course import failed:', err);
      progressBox.hidden = true;
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      [zipInput, filesInput, folderInput].forEach((i) => { i.value = ''; });
    }
  }
  for (const input of [zipInput, filesInput, folderInput]) input.addEventListener('change', () => run(input.files));

  return h('div', { class: 'card card--import', 'data-panel': 'import' },
    h('p', { class: 'card__title', text: '＋ Импортирай курс' }),
    h('p', { class: 'card__meta', text: 'ZIP на папката LRN-… от Drive (може и на части) или отделни файлове.' }),
    h('div', { class: 'import__actions' }, buttons),
    zipInput, filesInput, folderInput,
    progressBox, error, result,
  );
}

export function coursesScreen() {
  const empty = h('p', { class: 'empty', hidden: true, text: 'Още нямаш курс. Изтегли папката LRN-… от Drive като ZIP и я импортирай.' });
  const list = h('div', { class: 'card-grid', 'data-list': 'courses' });

  async function refresh() {
    try {
      const courses = (await listCourses()).sort((a, b) => a.id.localeCompare(b.id));
      empty.hidden = courses.length > 0;
      mount(list, await Promise.all(courses.map(courseCard)));
    } catch (err) {
      console.warn('Cannot list courses:', err);
      empty.hidden = false;
    }
  }
  refresh();

  return {
    title: 'EasyLRN',
    back: null,
    body: h('section', { class: 'screen screen--courses', 'data-screen': 'courses' },
      h('h2', { class: 'screen__heading', text: 'Моите курсове' }),
      empty,
      list,
      h('div', { class: 'card-grid card-grid--import' }, importPanel(refresh)),
    ),
  };
}
