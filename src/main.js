// App entry point: routes, app bar, Service Worker.
import { APP_NAME } from './config.js';
import { h, mount } from './dom.js';
import { addRoute, startRouter } from './router.js';
import { registerServiceWorker } from './sw-client.js';
import { coursesScreen } from './screens/courses.js';
import { courseScreen } from './screens/course.js';
import { readerScreen } from './screens/reader.js';
import { settingsScreen } from './screens/settings.js';
import { notFoundScreen } from './screens/not-found.js';

addRoute('/', coursesScreen);
addRoute('/c/:courseId', courseScreen);
addRoute('/c/:courseId/read/:lessonId', readerScreen);
addRoute('/settings', settingsScreen);

const main = document.getElementById('main');
const barStart = document.getElementById('app-bar-start');
const barTitle = document.getElementById('app-bar-title');
const settingsLink = document.getElementById('nav-settings');

let firstRender = true;

function render(resolved) {
  let screen;
  try {
    screen = resolved ? resolved.handler(resolved.match) : notFoundScreen();
  } catch (err) {
    console.error(err);
    screen = notFoundScreen();
  }

  barTitle.textContent = screen.title;
  mount(barStart, screen.back
    ? h('a', { class: 'back-link', href: screen.back.href, 'aria-label': `Назад към ${screen.back.label}` },
        h('span', { 'aria-hidden': 'true', text: '‹\u00A0' }), screen.back.label)
    : null);
  settingsLink.hidden = resolved?.match.path === '/settings';
  mount(main, screen.body);
  document.title = screen.title === APP_NAME ? APP_NAME : `${screen.title} · ${APP_NAME}`;

  // Move focus to the content on navigation (not on first load) for keyboard/screen-reader users.
  if (!firstRender) main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  firstRender = false;
}

startRouter(render);

const banner = document.getElementById('update-banner');
const updateButton = document.getElementById('update-button');

registerServiceWorker((applyUpdate) => {
  banner.hidden = false;
  updateButton.onclick = () => {
    updateButton.disabled = true;
    applyUpdate();
  };
});
