// Screen "Настройки" (#/settings). Only the "About" block for now; the rest is T-019.
import { h } from '../dom.js';
import { APP_VERSION } from '../config.js';

function offlineStatus() {
  if (!('serviceWorker' in navigator)) return 'не се поддържа от браузъра';
  return navigator.serviceWorker.controller ? 'готов' : 'подготвя се…';
}

export function settingsScreen() {
  const offline = h('dd', { 'data-field': 'offline', text: offlineStatus() });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(() => {
      offline.textContent = offlineStatus();
    });
  }
  return {
    title: 'Настройки',
    back: { href: '#/', label: 'Курсове' },
    body: h('section', { class: 'screen screen--settings', 'data-screen': 'settings' },
      h('h2', { class: 'screen__heading', text: 'За приложението' }),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Версия' }),
        h('dd', { 'data-field': 'version', text: APP_VERSION }),
        h('dt', { text: 'Офлайн режим' }),
        offline,
      ),
      h('p', { class: 'muted', text: 'AI учител, четене и данни — в следващите версии.' }),
    ),
  };
}
