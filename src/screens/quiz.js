// Screen "Тест" (#/c/<courseId>/quiz/<slug>). A quiz from quizzes/<slug>.json
// (D-032/D-033), shown by the app itself — NOT in the isolated lesson frame.
//
// Every text of a quiz (question, options, explanation, source) is PLAIN TEXT
// and is put on the page with textContent only (h()/dom.js never uses
// innerHTML), so HTML or <script> inside a field can never run, even though a
// quiz is shown outside the lesson isolation (T-048, Н-8).
//
// One question per screen, immediate feedback with the explanation, the right
// answer when the choice was wrong and the source (links, D-035), Back/Next, a
// progress bar, "Отначало" at the top at any time, a result with the wrong
// questions, "Опитай пак грешните" and "Нулирай отговорите" (both resets with a
// confirmation whose focus is on "Отказ"). Only the user's own choice is marked
// (D-036). The answers are in IndexedDB (by course and quiz, each choice as the
// option text under a key from the question's content, T048-D1), so they
// survive leaving, reloading, offline, a version upgrade and reshuffled options.
import { h, mount } from '../dom.js';
import { link } from '../router.js';
import {
  getCourse, listQuizzes, getQuizAnswers, saveQuizChoice, saveQuizCursor,
  resetQuizAnswers, clearQuizChoices, scoreQuiz, questionKeys, choiceIndex,
} from '../db.js';
import { confirmBox } from './confirm.js';

function findQuiz(quizzes, key) {
  const k = String(key);
  // An old link (earlier file name of a renamed quiz, D-039) still finds it.
  const slugOf = (path) => /^quizzes\/([^/]+)\.json$/i.exec(path)?.[1];
  return quizzes.find((q) => q.slug === k) || quizzes.find((q) => q.id === k)
    || quizzes.find((q) => q.id.endsWith(`/${k}`))
    || quizzes.find((q) => (q.previousPaths || []).some((p) => slugOf(p) === k || p === k)) || null;
}

/** Only https: links are ever shown (checked at import too, D-035). */
function safeHttps(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** "Източник:" with the links of the question (D-035), else its `src` text. */
export function sourceLine(question) {
  const links = (Array.isArray(question.links) ? question.links : [])
    .map((l) => ({ label: typeof l?.label === 'string' ? l.label : '', url: safeHttps(l?.url) }))
    .filter((l) => l.url);
  if (links.length) {
    const parts = [];
    links.forEach((l, i) => {
      if (i) parts.push(', ');
      // textContent only; a new tab (or the Drive app) outside the app, no referrer, no opener.
      parts.push(h('a', { class: 'quiz__link', href: l.url, target: '_blank', rel: 'noopener noreferrer', 'data-field': 'quiz-link' }, l.label || new URL(l.url).hostname));
    });
    return h('p', { class: 'quiz__src', 'data-field': 'quiz-src' }, 'Източник: ', ...parts);
  }
  return question.src ? h('p', { class: 'quiz__src', 'data-field': 'quiz-src', text: `Източник: ${question.src}` }) : null;
}

export function quizScreen({ params }) {
  const { courseId, quizId } = params;
  const body = h('div', { class: 'quiz', 'data-field': 'quiz' }, h('p', { class: 'muted', text: 'Зареждам…' }));
  let destroyed = false;

  (async () => {
    const [course, quizzes] = await Promise.all([getCourse(courseId), listQuizzes(courseId)]);
    if (destroyed) return;
    const quiz = course && findQuiz(quizzes, quizId);
    if (!course || !quiz) {
      mount(body, h('p', { class: 'empty', 'data-field': 'quiz-missing',
        text: course ? 'Тестът не е намерен. Импортирай курса отново.' : 'Курсът още не е импортиран.' }));
      return;
    }
    const answers = await getQuizAnswers(quiz.id);
    if (destroyed) return;
    runQuiz(body, courseId, quiz, answers);
  })().catch((err) => {
    console.warn('Cannot open the quiz:', err);
    mount(body, h('p', { class: 'empty', text: 'Тестът не може да се отвори.' }));
  });

  return {
    title: 'Тест',
    back: { href: link('c', courseId), label: courseId },
    destroy() { destroyed = true; },
    body: h('section', { class: 'screen screen--quiz', 'data-screen': 'quiz' }, body),
  };
}

/** The interactive quiz, once the data is loaded. */
function runQuiz(root, courseId, quiz, answers) {
  const questions = quiz.questions;
  // Answers by content (T048-D1/D3): key from the question, its options and
  // the right one; the stored choice is the TEXT of the chosen option.
  const keys = questionKeys(questions);
  const choices = { ...answers.choices }; // local mirror of the stored choices
  const chosenIndex = (qi) => choiceIndex(questions[qi], choices[keys[qi]]);

  // `order` is which questions this run goes through (all, or only the wrong
  // ones for "Опитай пак грешните"); `pos` is the position inside it.
  let order = questions.map((_, i) => i);
  let pos = Math.max(0, order.indexOf(answers.cursor ?? 0));
  if (pos === -1) pos = 0;
  let view = 'quiz';
  let dialog = null; // the open confirmation: 'restart' | 'reset' | null

  const persistChoice = (qi, oi) => {
    const text = questions[qi].options[oi];
    choices[keys[qi]] = text;
    saveQuizChoice(quiz.id, { courseId, qKey: keys[qi], choice: text, cursor: order[pos] })
      .catch((err) => console.warn('Cannot save the answer:', err));
  };

  // "Отначало" (D-035): always at the top of the quiz screen.
  const topBar = () => h('div', { class: 'quiz__top' },
    h('h2', { class: 'quiz__title', text: quiz.title }),
    h('button', { type: 'button', class: 'button quiz__restart', 'data-field': 'quiz-restart', onclick: () => openDialog('restart') }, 'Отначало'),
  );
  const dialogBox = () => {
    if (!dialog) return null;
    const restart = dialog === 'restart';
    return confirmBox({
      text: restart ? 'Да изчистя ли отговорите и да започна отначало?' : 'Да изтрия ли всички отговори на този тест? Това не може да се върне.',
      yes: restart ? 'Изчисти и започни' : 'Изтрий',
      label: restart ? 'Започване отначало' : 'Нулиране на отговорите',
      onYes: doReset,
      onNo: () => { dialog = null; render(); },
    });
  };
  const openDialog = (kind) => {
    dialog = kind;
    render();
    const box = root.querySelector('.quiz__confirm');
    box?.focusCancel?.();
    box?.scrollIntoView?.({ block: 'nearest' });
  };

  const render = () => {
    if (view === 'results') { renderResults(); return; }
    const qi = order[pos];
    const question = questions[qi];
    const chosen = chosenIndex(qi);
    const answered = chosen >= 0;
    const right = answered && chosen === question.answer;

    const answeredCount = order.filter((i) => chosenIndex(i) >= 0).length;
    // The width is set through the CSSOM (element.style), not a `style` attribute:
    // the app CSP is `style-src 'self'` (no inline styles).
    const fill = h('div', { class: 'quiz__bar-fill' });
    fill.style.width = `${Math.round((answeredCount / order.length) * 100)}%`;
    const progress = h('div', { class: 'quiz__progress' },
      h('div', { class: 'quiz__bar' }, fill),
      h('p', { class: 'quiz__count', text: `Въпрос ${pos + 1} от ${order.length} · отговорени ${answeredCount}` }),
    );

    // D-036: only the user's own choice is marked (green ✓ / red ✗); the
    // right option is NOT coloured in the list.
    const options = question.options.map((text, oi) => {
      const classes = ['quiz__option'];
      const mine = answered && oi === chosen;
      if (mine) classes.push(right ? 'quiz__option--correct' : 'quiz__option--wrong');
      else if (answered) classes.push('quiz__option--muted');
      const btn = h('button', {
        type: 'button',
        class: classes.join(' '),
        'data-option': oi,
        'aria-pressed': mine ? 'true' : 'false',
        disabled: answered || undefined,
        onclick: () => { if (chosenIndex(qi) < 0) { persistChoice(qi, oi); render(); } },
      }, h('span', { class: 'quiz__option-mark', 'aria-hidden': 'true', text: mine ? (right ? '✓' : '✗') : '' }), h('span', { class: 'quiz__option-text', text }));
      if (mine) btn.setAttribute('aria-label', `${text} — ${right ? 'твоят отговор, верен' : 'твоят отговор, грешен'}`);
      return btn;
    });

    const feedback = answered ? h('div', { class: `quiz__feedback ${right ? 'quiz__feedback--ok' : 'quiz__feedback--no'}`, role: 'status' },
      h('p', { class: 'quiz__verdict', text: right ? 'Вярно' : 'Грешно' }),
      right ? null : h('p', { class: 'quiz__right', 'data-field': 'quiz-right', text: `Верен отговор: ${question.options[question.answer]}` }),
      question.why ? h('p', { class: 'quiz__why', text: question.why }) : null,
      sourceLine(question),
    ) : null;

    const nav = h('div', { class: 'quiz__nav' },
      h('button', { type: 'button', class: 'button', disabled: pos === 0 || undefined, onclick: () => go(pos - 1) }, 'Назад'),
      pos < order.length - 1
        ? h('button', { type: 'button', class: 'button button--primary', onclick: () => go(pos + 1) }, 'Напред')
        : h('button', { type: 'button', class: 'button button--primary', onclick: () => { view = 'results'; dialog = null; render(); } }, 'Виж резултата'),
    );

    mount(root,
      topBar(),
      dialog === 'restart' ? dialogBox() : null,
      progress,
      h('p', { class: 'quiz__question', 'data-field': 'quiz-question', text: question.q }),
      h('div', { class: 'quiz__options' }, options),
      feedback,
      nav,
    );
  };

  const go = (next) => {
    pos = Math.max(0, Math.min(order.length - 1, next));
    dialog = null;
    saveQuizCursor(quiz.id, order[pos]).catch(() => {});
    render();
    root.scrollIntoView?.({ block: 'start' });
  };

  const renderResults = () => {
    const s = scoreQuiz(quiz, { choices });
    const wrong = s.wrong;
    const result = h('div', { class: 'quiz__result', 'data-field': 'quiz-result' },
      h('p', { class: 'quiz__score', text: `Резултат: ${s.correct} от ${s.total} верни` }),
      s.answered < s.total ? h('p', { class: 'muted', text: `Без отговор: ${s.total - s.answered}` }) : null,
    );

    const wrongList = wrong.length
      ? h('div', { class: 'quiz__wrong' },
          h('h3', { class: 'card__eyebrow', text: `Грешни въпроси (${wrong.length})` }),
          h('ul', { class: 'quiz__wrong-list' }, wrong.map((qi) =>
            h('li', {}, h('button', {
              type: 'button', class: 'quiz__wrong-link',
              onclick: () => { order = questions.map((_, i) => i); pos = qi; view = 'quiz'; dialog = null; saveQuizCursor(quiz.id, qi).catch(() => {}); render(); },
            }, questions[qi].q)))))
      : h('p', { class: 'quiz__all-correct', text: s.total ? 'Всички отговори са верни.' : 'Тестът няма въпроси.' });

    const actions = h('div', { class: 'quiz__actions' },
      wrong.length ? h('button', { type: 'button', class: 'button button--primary', onclick: () => retryWrong(wrong) }, 'Опитай пак грешните') : null,
      h('button', { type: 'button', class: 'button', onclick: () => { order = questions.map((_, i) => i); pos = 0; view = 'quiz'; dialog = null; render(); } }, 'Прегледай отначало'),
      h('button', { type: 'button', class: 'button quiz__reset', onclick: () => openDialog('reset') }, 'Нулирай отговорите'),
    );

    mount(root, topBar(), dialog === 'restart' ? dialogBox() : null, result, wrongList, actions,
      dialog === 'reset' ? dialogBox() : null,
      h('p', { class: 'quiz__done' }, h('a', { class: 'button', href: link('c', courseId) }, '‹ Към курса')));
    if (!dialog) root.scrollIntoView?.({ block: 'start' });
  };

  const retryWrong = async (wrong) => {
    try { await clearQuizChoices(quiz.id, wrong.map((qi) => keys[qi])); } catch (err) { console.warn('Cannot clear the answers:', err); }
    for (const qi of wrong) delete choices[keys[qi]];
    order = wrong.slice();
    pos = 0;
    view = 'quiz';
    dialog = null;
    render();
  };

  const doReset = async () => {
    try { await resetQuizAnswers(quiz.id); } catch (err) { console.warn('Cannot reset the answers:', err); }
    for (const k of Object.keys(choices)) delete choices[k];
    dialog = null;
    order = questions.map((_, i) => i);
    pos = 0;
    view = 'quiz';
    render();
    root.scrollIntoView?.({ block: 'start' });
  };

  render();
}
