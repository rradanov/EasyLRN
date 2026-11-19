// App entry point: routes, app bar, Service Worker.
// The app never starts inside a frame (T-045, LESSON-ISOLATION §3.3): a lesson
// that loads ./index.html into its own iframe gets an inert page, without the
// database, the Service Worker registration or any screen.
import { APP_NAME } from './config.js';
import { h, mount } from './dom.js';
import { addRoute, startRouter } from './router.js';
import { registerServiceWorker } from './sw-client.js';
import { initStorage, getSettings } from './db.js';
import { applyTheme } from './theme.js';
import { coursesScreen } from './screens/courses.js';
import { courseScreen } from './screens/course.js';
import { readerScreen } from './screens/reader.js';
import { quizScreen } from './screens/quiz.js';
import { settingsScreen } from './screens/settings.js';
import { notFoundScreen } from './screens/not-found.js';

function inFrame() {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

if (inFrame()) {
  document.body.replaceChildren(h('p', { class: 'empty', 'data-field': 'framed',
    text: 'EasyLRN не работи вътре в друга страница. Отвори приложението директно.' }));
} else {
  startApp();
}

function startApp() {
  // The reader restores and records its own position (T010-D2): the browser must
  // not scroll the window by itself on Back/Forward.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  addRoute('/', coursesScreen);
  addRoute('/c/:courseId', courseScreen);
  addRoute('/c/:courseId/read/:lessonId', readerScreen);
  addRoute('/c/:courseId/quiz/:quizId', quizScreen);
  addRoute('/settings', settingsScreen);

  const main = document.getElementById('main');
  const barStart = document.getElementById('app-bar-start');
  let barTitle = document.getElementById('app-bar-title');
  const settingsLink = document.getElementById('nav-settings');

  let firstRender = true;
  let currentScreen = null;

  function render(resolved) {
    // Let the old screen save its state (e.g. the reading position) before it goes.
    try {
      currentScreen?.destroy?.();
    } catch (err) {
      console.error(err);
    }
    let screen;
    try {
      screen = resolved ? resolved.handler(resolved.match) : notFoundScreen();
    } catch (err) {
      console.error(err);
      screen = notFoundScreen();
    }

    // A screen with its own h1 (the course screen, T012-I5) gets the app bar
    // title as plain text, so the page has exactly one h1.
    const barTag = screen.ownHeading ? 'p' : 'h1';
    if (barTitle.tagName.toLowerCase() !== barTag) {
      const el = document.createElement(barTag);
      el.className = barTitle.className;
      el.id = barTitle.id;
      barTitle.replaceWith(el);
      barTitle = el;
    }
    barTitle.textContent = screen.title;
    mount(barStart, screen.back
      ? h('a', { class: 'back-link', href: screen.back.href, 'aria-label': `Назад към ${screen.back.label}` },
          h('span', { 'aria-hidden': 'true', text: '‹\u00A0' }), screen.back.label)
      : null);
    settingsLink.hidden = resolved?.match.path === '/settings';
    mount(main, screen.body);
    currentScreen = screen;
    document.title = screen.title === APP_NAME ? APP_NAME : `${screen.title} · ${APP_NAME}`;

    // Move focus to the content on navigation (not on first load) for keyboard/screen-reader users.
    if (!firstRender) main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    firstRender = false;
  }

  startRouter(render);

  // Open/upgrade the database and ask for persistent storage (D-014).
  // A failed upgrade (e.g. the v5 migration, D-039) leaves the old database
  // as it was: the user is told so on the screen, not only in the console.
  // T056-D3: an upgrade that waits for another tab holding the database: say
  // so (the course list would just stay empty) and take it back once it runs.
  const BLOCKED_TEXT = 'Друг раздел с EasyLRN държи базата отворена. Затвори другите раздели с EasyLRN и презареди. Не импортирай нищо дотогава.';
  window.addEventListener('easylrn:db-blocked', (event) => {
    const box = document.getElementById('db-error');
    if (!box) return;
    if (event.detail?.blocked) {
      box.textContent = BLOCKED_TEXT;
      box.dataset.reason = 'blocked';
      box.hidden = false;
    } else if (box.dataset.reason === 'blocked') {
      box.hidden = true;
      box.textContent = '';
      delete box.dataset.reason;
    }
  });
  initStorage().catch((err) => {
    console.error('IndexedDB:', err);
    const box = document.getElementById('db-error');
    if (!box) return;
    delete box.dataset.reason;
    box.textContent = 'Базата не може да се обнови; данните са запазени. Затвори другите раздели с EasyLRN и презареди страницата; ако се повтори, не импортирай нищо и съобщи за проблема.';
    box.hidden = false;
  });

  // Theme (T-019): from the settings at start, then on every change.
  getSettings().then((s) => applyTheme(s.theme)).catch(() => {});
  window.addEventListener('easylrn:settings', (event) => applyTheme(event.detail?.theme));

  const banner = document.getElementById('update-banner');
  const updateButton = document.getElementById('update-button');

  registerServiceWorker((applyUpdate) => {
    banner.hidden = false;
    updateButton.onclick = () => {
      updateButton.disabled = true;
      applyUpdate();
    };
  });
}
