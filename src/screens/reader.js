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
// Marks (T-015, D-019, UI-DESIGN §5): a selection in the lesson shows the
// bottom bar (src/screens/mark-bar.js); a colour makes a mark; a tap on a
// mark opens its card in the same bar (another colour, delete with "Отмени")
// and frames it in the lesson (`lrn:focus`); the margin has a sign for every
// mark (a button: keyboard and touch); marks that were found only
// approximately or not at all are listed in "Маркировки за проверка".
import { h, mount } from '../dom.js';
import { link } from '../router.js';
import { getCourse, listLessons, getSettings, setLessonProgress, quizzesForLesson, visitPlace, movePlace } from '../db.js';
import { createLessonFrame } from '../lesson-frame.js';
import { createMarkBar } from './mark-bar.js';
import { colorChoices } from '../highlight.js';
import {
  setAnnotationColor, deleteAnnotation, restoreAnnotation, annotationDependents, confirmAnnotationPlace,
} from '../annotations.js';
import { quizLink } from './quiz-link.js';
import { normalizeNumber, resolveLessonPath } from '../lesson-id.js';

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
  const barSlot = h('div', { class: 'reader__bar-slot' });
  const liveStatus = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'data-field': 'marks-status' });
  const content = h('div', { class: 'reader__content', 'data-field': 'reader-content' },
    h('p', { class: 'muted', text: 'Зареждам…' }));
  let frame = null;
  let destroyed = false;
  let bar = null;
  // "Маркировки за проверка": the fuzzy ("провери") and orphan marks of this lesson.
  const checkBox = h('details', { class: 'marks-check', 'data-field': 'marks-check', hidden: true });
  // The margin for the signs is always there (the first mark does not narrow the lesson and lay it out again).
  const doc = h('div', { class: 'reader__doc reader__doc--gutter', 'data-field': 'reader-doc' });
  const gutter = h('div', { class: 'marks-gutter', 'data-field': 'marks-gutter', 'aria-label': 'Маркировки в урока', role: 'group', hidden: true });

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
    // --- Marks (T-015) -------------------------------------------------------------
    let current = null; // { kind: 'selection', selection } | { kind: 'mark', id }
    let lastDeleted = null;
    const byId = (id) => frame?.annotations.find((a) => a.id === id) || null;
    const colors = colorChoices(settings);
    const colorName = (id) => colors.find((c) => c.id === id)?.name || id;
    const closeBar = () => {
      if (current?.kind === 'selection') frame?.clearSelection();
      if (current?.kind === 'mark') frame?.focus(null);
      current = null;
      bar.hide();
    };
    const openMark = (id) => {
      const a = byId(id);
      if (!a) return;
      current = { kind: 'mark', id };
      bar.showMark(a);
      frame.focus(id);
    };
    /** Keep the selection above the bar when the bar first appears (the system menu is near the selection). */
    const keepAbove = (rect) => {
      const el = frame?.frame;
      if (!rect || !el) return;
      requestAnimationFrame(() => {
        const bottom = el.getBoundingClientRect().top + rect.bottom;
        const limit = window.innerHeight - bar.element.getBoundingClientRect().height - 12;
        if (bottom > limit) window.scrollBy({ top: bottom - limit });
      });
    };
    const act = async (fn, fail) => {
      try { await fn(); } catch (err) { console.warn('Cannot change the mark:', err?.name || err); bar.say(fail); }
    };
    bar = createMarkBar({
      colors,
      onColor: (color) => act(async () => {
        if (current?.kind === 'selection') {
          const from = current.selection;
          await frame.annotate(color, from);
          frame.clearSelection();
          current = null;
          bar.hide();
          announce(`Маркирано: ${colorName(color)}.`);
        } else if (current?.kind === 'mark') {
          const id = current.id;
          await setAnnotationColor(lesson, id, color);
          await frame.reloadAnnotations();
          const a = byId(id);
          if (a && current?.kind === 'mark' && current.id === id) bar.showMark(a);
          bar.say(`Цветът е сменен: ${colorName(color)}.`);
        }
      }, 'Маркировката не можа да се запише.'),
      onDelete: () => act(async () => {
        if (current?.kind !== 'mark') return;
        const id = current.id;
        const deps = await annotationDependents(id);
        const parts = [
          deps.notes && `${deps.notes} ${deps.notes === 1 ? 'бележка' : 'бележки'}`,
          deps.threads && `${deps.threads} ${deps.threads === 1 ? 'нишка с въпроси' : 'нишки с въпроси'}`,
          deps.subtopics && `${deps.subtopics} ${deps.subtopics === 1 ? 'допълнителна тема' : 'допълнителни теми'}`,
        ].filter(Boolean);
        if (parts.length) {
          bar.confirm({ text: `Към маркировката има ${parts.join(', ')}. Ще изтриеш и тях. Сигурен ли си?`, yes: 'Изтрий', onYes: () => act(() => removeMark(id), 'Маркировката не можа да се изтрие.') });
        } else {
          await removeMark(id);
        }
      }, 'Маркировката не можа да се изтрие.'),
      onUndo: () => act(async () => {
        const id = lastDeleted;
        lastDeleted = null;
        if (!id) { bar.hide(); return; }
        await restoreAnnotation(lesson, id);
        await frame.reloadAnnotations();
        openMark(id);
        bar.say('Маркировката е върната.');
      }, 'Маркировката не можа да се върне.'),
      onConfirmPlace: () => act(async () => {
        if (current?.kind !== 'mark') return;
        const id = current.id;
        const described = await frame.describe(id);
        if (!described) { bar.say('Мястото не може да се потвърди сега. Отвори урока отново.'); return; }
        await confirmAnnotationPlace(lesson, id, described);
        await frame.reloadAnnotations();
        const a = byId(id);
        if (a && current?.kind === 'mark' && current.id === id) bar.showMark(a);
        bar.say('Мястото е потвърдено.');
      }, 'Мястото не можа да се запише.'),
      onClose: () => closeBar(),
    });
    const removeMark = async (id) => {
      await deleteAnnotation(lesson, id);
      frame.focus(null);
      current = null;
      lastDeleted = id;
      await frame.reloadAnnotations();
      bar.showUndo('Маркировката е изтрита.');
    };
    const announce = (text) => { liveStatus.textContent = text; };
    const showChecks = (list) => {
      const fuzzy = list.filter((a) => a.anchorState === 'fuzzy');
      const orphan = list.filter((a) => a.anchorState === 'orphan');
      checkBox.hidden = !fuzzy.length && !orphan.length;
      if (checkBox.hidden) { mount(checkBox); return; }
      const words = [
        fuzzy.length && `${fuzzy.length} за проверка`,
        orphan.length && `${orphan.length} ${orphan.length === 1 ? 'неприкачена' : 'неприкачени'}`,
      ].filter(Boolean).join(' · ');
      const item = (a, kind) => h('li', { class: 'marks-check__item', 'data-annotation': a.id, 'data-state': kind },
        h('span', { class: 'marks-check__swatch', 'data-color': a.color || 'none', 'aria-hidden': 'true' }),
        h('span', { class: 'marks-check__quote', text: `«${a.selector.quote.exact.length > 200 ? `${a.selector.quote.exact.slice(0, 199)}…` : a.selector.quote.exact}»` }),
        kind === 'fuzzy'
          ? h('button', { type: 'button', class: 'button', 'data-action': 'check-mark', onclick: () => { frame.scrollToAnnotation(a.id); openMark(a.id); } }, 'Провери')
          : h('button', { type: 'button', class: 'button', 'data-action': 'delete-orphan', onclick: () => act(async () => { current = { kind: 'mark', id: a.id }; await removeMark(a.id); }, 'Маркировката не можа да се изтрие.') }, 'Изтрий'));
      const open = checkBox.open;
      mount(checkBox,
        h('summary', { class: 'marks-check__summary' }, h('span', { 'aria-hidden': 'true', text: '⚠ ' }), `Маркировки за проверка: ${words}`),
        fuzzy.length ? h('div', {},
          h('p', { class: 'marks-check__hint', text: 'Текстът на урока се е променил; тези маркировки са намерени приблизително (с пунктир). Провери ги.' }),
          h('ul', { class: 'marks-check__list' }, fuzzy.map((a) => item(a, 'fuzzy')))) : null,
        orphan.length ? h('div', {},
          h('p', { class: 'marks-check__hint', text: 'Текстът на урока се е променил. Тези маркировки не са намерени; пазят се тук (закачане на ново място — скоро).' }),
          h('ul', { class: 'marks-check__list' }, orphan.map((a) => item(a, 'orphan')))) : null);
      checkBox.open = open;
    };
    /** Signs in the margin, next to the line of each mark (pushed down when they would overlap). */
    const SIGN = 40;
    const showGutter = () => {
      const list = (frame?.annotations || []).filter((a) => a.anchorState !== 'orphan' && a.color);
      const places = frame?.layout || new Map();
      const el = frame?.frame;
      if (!el || !list.length) { gutter.hidden = true; mount(gutter); return; }
      const offset = el.getBoundingClientRect().top - doc.getBoundingClientRect().top;
      const rows = list.map((a) => ({ a, top: places.get(a.id)?.top ?? a.anchoredTop })).filter((r) => Number.isFinite(r.top)).sort((x, y) => x.top - y.top);
      let next = -Infinity;
      gutter.hidden = !rows.length;
      mount(gutter, rows.map(({ a, top }) => {
        const y = Math.max(top - 8, next);
        next = y + SIGN;
        const b = h('button', {
          type: 'button', class: 'marks-gutter__sign', 'data-annotation': a.id, 'data-color': a.color, 'data-state': a.anchorState,
          'aria-label': `Маркировка (${colorName(a.color)}${a.anchorState === 'fuzzy' ? ', за проверка' : ''}): ${a.selector.quote.exact.slice(0, 80)}`,
          onclick: () => openMark(a.id),
        }, h('span', { class: 'marks-gutter__dot', 'aria-hidden': 'true' }));
        b.style.top = `${Math.round(offset + y)}px`;
        return b;
      }));
    };
    frame = createLessonFrame({
      course,
      lesson,
      lessons,
      fontScale: settings.fontScale,
      initialScroll: startY,
      hash,
      onSelection: (selection) => {
        if (destroyed) return;
        if (selection) {
          const first = !bar.visible || current?.kind !== 'selection';
          if (current?.kind === 'mark') frame.focus(null);
          current = { kind: 'selection', selection };
          bar.showSelection(selection);
          if (first) keepAbove(selection.rect);
        } else if (current?.kind === 'selection' && !bar.pressedWithin(800)) {
          current = null;
          bar.hide();
        }
      },
      onTap: (annotation) => {
        if (destroyed) return;
        if (annotation) openMark(annotation.id);
        else if (current?.kind === 'mark') closeBar();
      },
      onAnchored: (list) => {
        if (destroyed) return;
        showChecks(list);
        showGutter();
        if (current?.kind === 'mark' && !list.some((a) => a.id === current.id)) closeBar();
      },
      onLayout: () => { if (!destroyed) showGutter(); },
      // Escape pressed inside the lesson (a keyboard selection).
      onEscape: () => { if (!destroyed && bar.visible) closeBar(); },
      onNavigate: (other, otherHash) => {
        const at = otherHash && otherHash.length > 1 ? `?at=${encodeURIComponent(otherHash.slice(1))}` : '';
        location.hash = `${readerLink(courseId, other)}${at}`;
      },
      onScroll: (y) => {
        setLessonProgress(lesson.id, { scrollY: y }).catch((err) => console.warn('Cannot save the position:', err));
        visited.then(() => movePlace(lesson.id, { scrollY: y })).catch((err) => console.warn('Cannot save the history:', err));
      },
    });
    mount(doc, frame.element, gutter);
    mount(content, doc);
    bar.element.hidden = true;
    mount(barSlot, bar.element);
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
      bar?.destroy();
    },
    body: h('section', { class: 'screen screen--reader', 'data-screen': 'reader' },
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
      content,
      quizzesBox,
      barSlot,
      liveStatus,
    ),
  };
}
