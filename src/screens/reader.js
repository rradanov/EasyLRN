// Screen "Четец" (#/c/<courseId>/read/<lesson>?path=a/b). <lesson> is the
// number ("0001", "R01") or the lesson id. The lesson or reference is shown in
// an isolated iframe (T-045, D-029: opaque origin, postMessage bridge); columns
// come in T-027.
// Progress (T-011): opening a lesson makes it "започнат" and remembers when;
// "Маркирай като завършен" makes it "завършен" (pressed again: back to
// "започнат"). The reading position is kept per lesson (scrollY), so
// "Продължи" on the course screen returns to the same place.
// History (T-059, D-041): every opening is a visit in "Последни дейности"
// with its position; `?y=<px>` opens at a position of the history, `?at=` at
// a fragment.
// Notes (T-017, D-045): a strip right of the lesson (src/screens/notes-strip.js):
// 📝 next to the lines with a note, the list, ▲ / ▼, "Бележка" for selected text.
// Marks (T-015, D-042): the tool bar left of the lesson (src/screens/mark-tools.js:
// marker, pencil, eraser, five colours, "Отмени"; it can be hidden behind a
// handle "☰", T-062); with a tool on, one finger
// draws on the lesson and two fingers scroll. Marks found only approximately
// or not at all after a change of the lesson are listed in "Маркировки за
// проверка" (show it, "Да, тук е", delete).
// Layout (D-046, src/screens/reader-layout.js): in portrait both bars are
// horizontal at the top (a sticky row under the title: tools left, notes
// right) and a note opens under the lesson; in landscape the bars are at the
// sides; a phone has only the 📝. `data-layout` on the screen follows the window.
import { h, mount } from '../dom.js';
import { link } from '../router.js';
import { getCourse, listLessons, getSettings, setLessonProgress, quizzesForLesson, visitPlace, movePlace } from '../db.js';
import { createLessonFrame } from '../lesson-frame.js';
import { createMarkTools } from './mark-tools.js';
import { createNotesStrip } from './notes-strip.js';
import { COLORS } from '../db.js';
import { confirmAnnotationPlace } from '../annotations.js';
import { quizLink } from './quiz-link.js';
import { normalizeNumber, resolveLessonPath } from '../lesson-id.js';
import { readerLayout } from './reader-layout.js';
import { createHandleGutter } from './handle-gutter.js';

/**
 * Find a lesson by id, number (case-insensitive, "R1" = "R01", "3" = "0003")
 * or path (also an earlier path or the number in a file name, D-039).
 */
export function findLesson(lessons, key) {
  const k = String(key);
  const n = normalizeNumber(k);
  return lessons.find((l) => l.id === k)
    || lessons.find((l) => String(l.number).toUpperCase() === k.toUpperCase())
    || (n ? lessons.find((l) => normalizeNumber(l.number) === n) : null)
    || resolveLessonPath(lessons, k)
    || null;
}

const label = (key) => (/^R\d/i.test(key) ? `Справочник ${key}` : `Урок ${key}`);

/** Hash link of the reader for a lesson (by number). */
export const readerLink = (courseId, lesson) => link('c', courseId, 'read', lesson.number || lesson.id);

export function readerScreen({ params, query }) {
  const { courseId, lessonId } = params;
  const path = (query.get('path') || '').split('/').filter(Boolean);
  const hash = query.get('at') ? `#${query.get('at')}` : '';
  // A position from the history (T-059): whole pixels from the lesson top.
  const atY = /^\d{1,9}$/.test(query.get('y') || '') ? Number(query.get('y')) : null;
  const quizzesBox = h('div', { class: 'reader__quizzes', 'data-field': 'lesson-quizzes' });
  const completeButton = h('button', {
    type: 'button', class: 'button reader__complete', 'data-action': 'complete', 'aria-pressed': 'false', hidden: true,
  }, 'Маркирай като завършен');
  const completeStatus = h('span', { class: 'visually-hidden', role: 'status', 'data-field': 'complete-status' });
  // D-039: a lesson taken out of the course (retired) still opens, with a note.
  const retiredNote = h('p', { class: 'reader__retired', role: 'note', 'data-field': 'retired-note', hidden: true },
    'Този урок вече не е в курса. Можеш да го четеш; маркировките и бележките ти към него са запазени.');
  const content = h('div', { class: 'reader__content', 'data-field': 'reader-content' },
    h('p', { class: 'muted', text: 'Зареждам…' }));
  let frame = null;
  let tools = null;
  let notes = null;
  let gutter = null;
  let destroyed = false;
  const liveStatus = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'data-field': 'marks-status' });
  const announce = (text) => { liveStatus.textContent = ''; liveStatus.textContent = text; };
  // "Маркировки за проверка": the fuzzy ("провери") and orphan marks of this lesson.
  const checkBox = h('details', { class: 'marks-check', 'data-field': 'marks-check', hidden: true });
  const toolSlot = h('div', { class: 'reader__tools' });
  const notesSlot = h('div', { class: 'reader__notes-slot' });
  const panelSlot = h('div', { class: 'reader__panel-slot' });
  const doc = h('div', { class: 'reader__doc', 'data-field': 'reader-doc' }, toolSlot, content, notesSlot);
  // D-046: the row of the bars in portrait (sticky under the app bar).
  const topTools = h('div', { class: 'reader__top-tools' });
  const topNotes = h('div', { class: 'reader__top-notes' });
  const topbar = h('div', { class: 'reader__topbar', 'data-field': 'reader-topbar' }, topTools, topNotes);
  const screen = h('section', { class: 'screen screen--reader', 'data-screen': 'reader', 'data-layout': readerLayout() });
  const onResize = () => { screen.dataset.layout = readerLayout(); };
  window.addEventListener('resize', onResize);
  // What of the window the lesson is seen in: below the app bar (and the row of
  // the bars in portrait), above the panel of a note in portrait.
  const viewInsets = () => {
    const bar = document.querySelector('.app-bar')?.getBoundingClientRect().height ?? 0;
    const row = screen.dataset.layout === 'portrait' && topbar.getClientRects().length ? topbar.getBoundingClientRect().height : 0;
    const bottom = parseFloat(document.documentElement.style.getPropertyValue('--notes-cover-bottom')) || 0;
    return { top: Math.round(bar + row), bottom: Math.round(bottom) };
  };

  (async () => {
    const [course, lessons, settings] = await Promise.all([getCourse(courseId), listLessons(courseId), getSettings()]);
    if (destroyed) return;
    const lesson = course && findLesson(lessons, lessonId);
    if (!course || !lesson) {
      mount(content, h('p', { class: 'empty', 'data-field': 'reader-missing',
        text: course ? 'Урокът не е намерен в курса. Импортирай курса отново.' : 'Курсът още не е импортиран.' }));
      return;
    }
    retiredNote.hidden = !lesson.retired;
    // Progress (T-011): opened → "started" (a finished lesson stays finished).
    let status = lesson.progress?.status === 'done' ? 'done' : 'started';
    setLessonProgress(lesson.id, { status, lastOpenedAt: new Date().toISOString() })
      .catch((err) => console.warn('Cannot save the progress:', err));
    const startY = hash ? 0 : atY ?? (lesson.progress?.scrollY || 0);
    // The visit is written before any position change of this reader (movePlace keeps the order).
    const visited = visitPlace({
      courseId, kind: lesson.kind === 'reference' ? 'reference' : 'lesson', id: lesson.id,
      scrollY: startY, anchor: hash ? hash.slice(1) : null,
    }).catch((err) => console.warn('Cannot save the history:', err));
    const showStatus = () => {
      const isDone = status === 'done';
      completeButton.textContent = isDone ? '✓ Завършен' : 'Маркирай като завършен';
      completeButton.setAttribute('aria-pressed', String(isDone));
      completeButton.title = isDone ? 'Натисни, за да върнеш урока като започнат' : '';
      completeButton.dataset.status = status;
    };
    showStatus();
    completeButton.hidden = false;
    completeButton.addEventListener('click', async () => {
      const next = status === 'done' ? 'started' : 'done';
      completeButton.disabled = true;
      try {
        await setLessonProgress(lesson.id, next === 'done'
          ? { status: next, completedAt: new Date().toISOString() }
          : { status: next, completedAt: null });
        status = next;
        showStatus();
        completeStatus.textContent = next === 'done' ? 'Урокът е отбелязан като завършен.' : 'Урокът е отбелязан като започнат.';
      } catch (err) {
        console.warn('Cannot save the progress:', err);
        completeStatus.textContent = 'Прогресът не можа да се запише.';
      } finally {
        completeButton.disabled = false;
      }
    });
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
    let focusTimer = 0;
    const showMark = (id) => {
      if (!frame?.scrollToAnnotation(id)) return;
      frame.focus(id);
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => frame?.focus(null), 5000);
    };
    const quoteOf = (a) => {
      const q = a.selector?.quote?.exact || '';
      return `«${q.length > 200 ? `${q.slice(0, 199)}…` : q}»`;
    };
    const showChecks = (all) => {
      // Only marks (with a colour): a place with a note only is checked in the notes list (T-017).
      const list = all.filter((a) => COLORS.includes(a.color));
      const fuzzy = list.filter((a) => a.anchorState === 'fuzzy');
      const orphan = list.filter((a) => a.anchorState === 'orphan');
      checkBox.hidden = !fuzzy.length && !orphan.length;
      if (checkBox.hidden) { mount(checkBox); return; }
      const words = [
        fuzzy.length && `${fuzzy.length} за проверка`,
        orphan.length && `${orphan.length} ${orphan.length === 1 ? 'неприкачена' : 'неприкачени'}`,
      ].filter(Boolean).join(' · ');
      const erase = (a) => h('button', { type: 'button', class: 'button', 'data-action': 'delete-mark', onclick: () => tools.erase([a.id]) }, 'Изтрий');
      const item = (a, kind) => h('li', { class: 'marks-check__item', 'data-annotation': a.id, 'data-state': kind },
        h('span', { class: 'marks-check__swatch', 'data-color': a.color || 'none', 'data-style': a.style || 'highlight', 'aria-hidden': 'true' }),
        h('span', { class: 'marks-check__quote', text: quoteOf(a) }),
        h('span', { class: 'marks-check__actions' },
          kind === 'fuzzy' ? h('button', { type: 'button', class: 'button', 'data-action': 'show-mark', onclick: () => showMark(a.id) }, 'Провери') : null,
          kind === 'fuzzy' ? h('button', {
            type: 'button', class: 'button', 'data-action': 'confirm-mark',
            onclick: async () => {
              const described = await frame.describe(a.id);
              if (!described) { announce('Мястото не може да се потвърди сега. Отвори урока отново.'); return; }
              try {
                await confirmAnnotationPlace(lesson, a.id, described);
                await frame.reloadAnnotations();
                announce('Мястото е потвърдено.');
              } catch (err) {
                console.warn('Cannot confirm the place:', err?.message || err);
                announce('Мястото не можа да се запише.');
              }
            },
          }, 'Да, тук е') : null,
          erase(a)));
      const open = checkBox.open;
      mount(checkBox,
        h('summary', { class: 'marks-check__summary' }, h('span', { 'aria-hidden': 'true', text: '⚠ ' }), `Маркировки за проверка: ${words}`),
        fuzzy.length ? h('div', {},
          h('p', { class: 'marks-check__hint', text: 'Текстът на урока се е променил; тези маркировки са намерени приблизително (с пунктир). Провери ги.' }),
          h('ul', { class: 'marks-check__list' }, fuzzy.map((a) => item(a, 'fuzzy')))) : null,
        orphan.length ? h('div', {},
          h('p', { class: 'marks-check__hint', text: 'Текстът на урока се е променил. Тази маркировка не е намерена — виж я в списъка. Закачане на ново място — скоро.' }),
          h('ul', { class: 'marks-check__list' }, orphan.map((a) => item(a, 'orphan')))) : null);
      checkBox.open = open;
    };
    frame = createLessonFrame({
      course,
      lesson,
      lessons,
      fontScale: settings.fontScale,
      initialScroll: startY,
      hash,
      viewInsets,
      onAnchored: (list) => { if (!destroyed) { showChecks(list); notes?.onAnchored(); } },
      onEscape: () => { if (tools?.tool) tools.escape(); else notes?.escape(); },
      onSelection: (sel) => notes?.onSelection(sel),
      onTap: (annotation) => notes?.onTap(annotation),
      onLayout: (places) => notes?.onLayout(places),
      onMargins: () => gutter?.queue(),
      onNavigate: (other, otherHash) => {
        const at = otherHash && otherHash.length > 1 ? `?at=${encodeURIComponent(otherHash.slice(1))}` : '';
        location.hash = `${readerLink(courseId, other)}${at}`;
      },
      onScroll: (y) => {
        setLessonProgress(lesson.id, { scrollY: y }).catch((err) => console.warn('Cannot save the position:', err));
        visited.then(() => movePlace(lesson.id, { scrollY: y })).catch((err) => console.warn('Cannot save the history:', err));
      },
    });
    tools = createMarkTools({
      getFrame: () => frame,
      course,
      lesson,
      settings,
      announce,
      onChange: (tool) => { doc.dataset.tool = tool || 'none'; notes?.onTool(); },
      onLayout: (hidden) => { doc.dataset.bar = hidden ? 'hidden' : 'shown'; gutter?.queue({ fresh: true }); },
      onErased: () => notes?.reload(),
      slots: { side: toolSlot, top: topTools },
    });
    doc.dataset.bar = tools.hidden ? 'hidden' : 'shown';
    // T-017 (D-045): the notes strip right of the lesson.
    notes = createNotesStrip({
      getFrame: () => frame,
      getTool: () => tools?.tool || null,
      getToolColor: () => tools?.color || 'yellow',
      course,
      lesson,
      settings,
      announce,
      onLayout: (hidden) => { doc.dataset.notes = hidden ? 'hidden' : 'shown'; gutter?.queue({ fresh: true }); },
      topSlot: topNotes,
      viewInsets,
    });
    doc.dataset.notes = notes.hidden ? 'hidden' : 'shown';
    mount(notesSlot, notes.element);
    mount(panelSlot, notes.panel, notes.toast);
    frame.element.append(tools.layer);
    mount(content, frame.element);
    // D-046 addition: a handle of a hidden bar floats over the lesson's margin
    // (in the top row only while the row has a bar to show).
    const floating = (el) => (el && !(topbar.contains(el) && topbar.getBoundingClientRect().height > 1) ? el : null);
    gutter = createHandleGutter({
      doc,
      content,
      getFrame: () => frame,
      handles: () => ({
        left: floating(screen.querySelector('[data-field="mark-tools-handle"]')),
        right: floating(screen.querySelector('[data-field="notes-strip-handle"]')),
      }),
    });
    gutter.queue({ fresh: true });
  })().catch((err) => {
    console.warn('Cannot open the lesson:', err);
    mount(content, h('p', { class: 'empty', text: 'Урокът не може да се отвори.' }));
  });

  return {
    title: label(lessonId),
    back: { href: link('c', courseId), label: courseId },
    destroy() {
      destroyed = true;
      window.removeEventListener('resize', onResize);
      gutter?.destroy();
      notes?.destroy();
      tools?.destroy();
      frame?.destroy();
    },
    body: (mount(screen,
      h('div', { class: 'reader__bar' },
        h('nav', { class: 'breadcrumb', 'aria-label': 'Път' },
          h('span', { text: label(lessonId) }),
          ...path.map((id) => h('span', { text: ` › ${id}` })),
        ),
        completeButton,
        completeStatus,
      ),
      retiredNote,
      checkBox,
      liveStatus,
      topbar,
      doc,
      panelSlot,
      quizzesBox,
    ), screen),
  };
}
