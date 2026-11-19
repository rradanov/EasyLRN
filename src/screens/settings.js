// Screen "Настройки" (#/settings), T-019 (UI-DESIGN §8 without the backup,
// which is T-031): the Claude API key, the model, the monthly cost threshold,
// the text size, the theme, the storage and the version.
//
// The API key (D-037):
// - it lives in the `secrets` store (db.js), not in the settings record;
// - it is in the DOM only as the value of the key field while the user types
//   it (never as an attribute); after "Запази" the field is emptied and only
//   the last 4 characters are shown; "Покажи" shows what is being typed, the
//   saved key is never put back into the page;
// - it is never logged and never sent to a lesson (the lesson bridge gets
//   only the text size and the colours).
import { h, mount } from '../dom.js';
import { APP_VERSION } from '../config.js';
import {
  getSettings, saveSettings, getApiKey, saveApiKey, deleteApiKey,
  usageTotals, monthStart, storageEstimate, requestPersistence,
} from '../db.js';
import { MODELS, DEFAULT_MODEL, validateKey, maskKey, checkKey } from '../claude.js';
import { THEMES } from '../theme.js';
import { confirmBox } from './confirm.js';

export const FONT_SCALES = Object.freeze([0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6]);
const THEME_LABELS = { system: 'Като системата', light: 'Светла', dark: 'Тъмна' };
const BUDGET_MAX = 1000;

function offlineStatus() {
  if (!('serviceWorker' in navigator)) return 'не се поддържа от браузъра';
  return navigator.serviceWorker.controller ? 'готов' : 'подготвя се…';
}

const numberBg = (n, digits) => n.toLocaleString('bg-BG', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** 2 202 009 → "2,1 MB" */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${numberBg(v, i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/** A labelled row of the settings list. */
function row(label, forId, ...content) {
  return h('div', { class: 'settings__row' },
    h(forId ? 'label' : 'span', { class: 'settings__label', for: forId || null, text: label }),
    h('div', { class: 'settings__value' }, ...content));
}

export function settingsScreen() {
  let destroyed = false;
  let checking = null;
  let hasKey = false;
  let settings = null;

  // --- AI teacher: the key -------------------------------------------------------
  const keyInput = h('input', {
    id: 'settings-api-key', class: 'settings__input settings__input--key', type: 'password',
    'data-field': 'api-key', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    inputmode: 'text', placeholder: 'sk-ant-…', 'aria-describedby': 'settings-key-warning settings-key-message',
  });
  const showButton = h('button', { type: 'button', class: 'button', 'data-field': 'key-show', 'aria-pressed': 'false', 'aria-controls': 'settings-api-key' }, 'Покажи');
  const saveButton = h('button', { type: 'button', class: 'button button--primary', 'data-field': 'key-save' }, 'Запази');
  const checkButton = h('button', { type: 'button', class: 'button', 'data-field': 'key-check', disabled: true }, 'Провери');
  const deleteButton = h('button', { type: 'button', class: 'button settings__danger', 'data-field': 'key-delete', disabled: true }, 'Изтрий');
  const keyStatus = h('p', { class: 'settings__key-status', 'data-field': 'key-status', text: 'Чета…' });
  const keyMessage = h('p', { class: 'settings__message', id: 'settings-key-message', 'data-field': 'key-message', role: 'status', 'aria-live': 'polite', hidden: true });
  const confirmSlot = h('div', { 'data-field': 'key-confirm' });
  const warning = h('div', { class: 'settings__warning', id: 'settings-key-warning', 'data-field': 'key-warning' },
    h('p', { class: 'settings__warning-main', text: 'Уроците никога не искат API ключ. Въвеждай го само тук.' }),
    h('p', { class: 'settings__warning-tip', text: 'Ползвай отделен ключ с месечен лимит от Claude Console.' }));

  const say = (text, kind = 'info') => {
    keyMessage.hidden = !text;
    keyMessage.textContent = text || '';
    keyMessage.dataset.kind = kind;
  };
  const showKeyState = (key) => {
    hasKey = !!key;
    keyStatus.textContent = hasKey ? `Запазен ключ: ${maskKey(key)}` : 'Няма запазен ключ.';
    keyStatus.dataset.saved = hasKey ? 'yes' : 'no';
    checkButton.disabled = !hasKey || !!checking;
    deleteButton.disabled = !hasKey;
  };
  const hideTyped = () => {
    keyInput.type = 'password';
    showButton.textContent = 'Покажи';
    showButton.setAttribute('aria-pressed', 'false');
  };
  showButton.addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    showButton.textContent = show ? 'Скрий' : 'Покажи';
    showButton.setAttribute('aria-pressed', String(show));
  });
  const save = async () => {
    const checked = validateKey(keyInput.value);
    if (checked.error) { say(checked.error, 'error'); keyInput.focus(); return; }
    saveButton.disabled = true;
    try {
      await saveApiKey(checked.key);
      keyInput.value = '';
      hideTyped();
      showKeyState(checked.key);
      say('Ключът е запазен на това устройство. Натисни „Провери“, за да видиш дали работи.', 'ok');
    } catch {
      say('Ключът не можа да се запази (грешка в базата на браузъра).', 'error');
    } finally {
      saveButton.disabled = false;
    }
  };
  saveButton.addEventListener('click', save);
  keyInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
  deleteButton.addEventListener('click', () => {
    const close = () => { mount(confirmSlot); deleteButton.focus(); };
    const box = confirmBox({
      text: 'Да изтрия ли API ключа от това устройство? Учителят няма да работи, докато не въведеш ключ отново.',
      yes: 'Изтрий ключа',
      label: 'Изтриване на API ключа',
      onNo: close,
      onYes: async () => {
        mount(confirmSlot);
        try {
          await deleteApiKey();
          showKeyState('');
          say('Ключът е изтрит.', 'ok');
        } catch {
          say('Ключът не можа да се изтрие (грешка в базата на браузъра).', 'error');
        }
        keyInput.focus();
      },
    });
    mount(confirmSlot, box);
    box.focusCancel();
  });
  checkButton.addEventListener('click', async () => {
    if (checking) return;
    checkButton.disabled = true;
    say('Проверявам…', 'info');
    const run = (async () => {
      const apiKey = await getApiKey();
      return checkKey({ apiKey, model: settings?.model || DEFAULT_MODEL });
    })();
    checking = run;
    let result;
    try { result = await run; } catch { result = { ok: false, text: 'Проверката не можа да се изпълни.' }; }
    checking = null;
    if (destroyed) return;
    checkButton.disabled = !hasKey;
    if (result.ok) say(`Ключът работи (${result.model}).`, 'ok');
    else say(result.text, 'error');
  });

  // --- AI teacher: model, threshold, spend ----------------------------------------
  const modelSelect = h('select', { id: 'settings-model', class: 'settings__input', 'data-field': 'model' },
    ...MODELS.map((m) => h('option', { value: m.id, text: m.label })));
  const budgetInput = h('input', {
    id: 'settings-budget', class: 'settings__input settings__input--number', type: 'number', inputmode: 'decimal',
    min: '0', max: String(BUDGET_MAX), step: '0.5', 'data-field': 'budget',
  });
  const budgetMessage = h('span', { class: 'settings__inline-message', 'data-field': 'budget-message', role: 'status' });
  const spend = h('span', { 'data-field': 'spend', text: '…' });
  const spendWarning = h('p', { class: 'settings__spend-warning', 'data-field': 'spend-warning', hidden: true });

  modelSelect.addEventListener('change', async () => {
    settings = await saveSettings({ model: modelSelect.value });
    say('', 'info');
  });
  budgetInput.addEventListener('change', async () => {
    const v = Number(budgetInput.value);
    if (budgetInput.value === '' || !Number.isFinite(v) || v < 0 || v > BUDGET_MAX) {
      budgetMessage.textContent = `Прагът е число от 0 до ${BUDGET_MAX}.`;
      budgetInput.value = String(settings?.monthlyBudgetUSD ?? 5);
      return;
    }
    settings = await saveSettings({ monthlyBudgetUSD: Math.round(v * 100) / 100 });
    budgetMessage.textContent = 'Запазено.';
    showSpend();
  });
  let totals = null;
  const showSpend = () => {
    if (!totals || !settings) return;
    spend.textContent = `${usd(totals.estCostUSD)} (${totals.calls} ${totals.calls === 1 ? 'извикване' : 'извиквания'})`;
    const limit = Number(settings.monthlyBudgetUSD) || 0;
    const over = limit > 0 && totals.estCostUSD >= limit;
    spendWarning.hidden = !over;
    spendWarning.textContent = over ? `Разходът за месеца е над прага от ${usd(limit)}.` : '';
  };

  // --- Reading: text size, theme ----------------------------------------------
  const scaleValue = h('output', { class: 'settings__scale-value', 'data-field': 'font-scale', 'aria-live': 'polite', text: '100 %' });
  const smaller = h('button', { type: 'button', class: 'button settings__step', 'data-field': 'font-smaller', 'aria-label': 'По-малък текст' }, 'A−');
  const bigger = h('button', { type: 'button', class: 'button settings__step', 'data-field': 'font-bigger', 'aria-label': 'По-голям текст' }, 'A+');
  const sample = h('p', { class: 'settings__sample', 'data-field': 'font-sample', text: 'Така ще изглежда текстът на уроците.' });
  const showScale = (scale) => {
    scaleValue.textContent = `${Math.round(scale * 100)} %`;
    sample.style.fontSize = `${scale}rem`;
    const i = FONT_SCALES.indexOf(scale);
    smaller.disabled = i === 0;
    bigger.disabled = i === FONT_SCALES.length - 1;
  };
  const stepScale = async (dir) => {
    const current = settings?.fontScale ?? 1;
    // The nearest step (a value saved by an older build may be between steps).
    let i = FONT_SCALES.reduce((best, s, k) => (Math.abs(s - current) < Math.abs(FONT_SCALES[best] - current) ? k : best), 0);
    i = Math.min(FONT_SCALES.length - 1, Math.max(0, i + dir));
    settings = await saveSettings({ fontScale: FONT_SCALES[i] });
    showScale(FONT_SCALES[i]);
  };
  smaller.addEventListener('click', () => stepScale(-1));
  bigger.addEventListener('click', () => stepScale(1));

  const themeInputs = THEMES.map((t) => h('input', { type: 'radio', name: 'settings-theme', value: t, id: `settings-theme-${t}`, 'data-field': `theme-${t}` }));
  const themeGroup = h('div', { class: 'settings__choices', role: 'radiogroup', 'aria-label': 'Тема', 'data-field': 'theme' },
    ...THEMES.map((t, i) => h('label', { class: 'settings__choice', for: `settings-theme-${t}` }, themeInputs[i], ' ', THEME_LABELS[t])));
  for (const input of themeInputs) {
    input.addEventListener('change', async () => {
      if (input.checked) settings = await saveSettings({ theme: input.value });
    });
  }

  // --- Data: storage ----------------------------------------------------------------
  const storageUsed = h('span', { 'data-field': 'storage', text: '…' });
  const persistStatus = h('span', { 'data-field': 'persist', text: '…' });
  const persistButton = h('button', { type: 'button', class: 'button', 'data-field': 'persist-ask', hidden: true }, 'Поискай защита');
  const showStorage = async () => {
    const est = await storageEstimate();
    if (destroyed) return;
    storageUsed.textContent = est ? `${formatBytes(est.usage)} от ${formatBytes(est.quota)}` : 'не се поддържа от браузъра';
    const p = est?.persisted;
    persistStatus.textContent = p === true ? 'защитени от изчистване ✓'
      : p === false ? 'не са защитени — браузърът може да ги изчисти при липса на място' : 'не се поддържа от браузъра';
    persistStatus.dataset.persisted = String(p);
    persistButton.hidden = p !== false;
  };
  persistButton.addEventListener('click', async () => {
    persistButton.disabled = true;
    const granted = await requestPersistence();
    persistButton.disabled = false;
    await showStorage();
    if (granted === false) persistStatus.textContent += ' (браузърът отказа; инсталираното приложение обикновено получава защита)';
  });

  // --- About --------------------------------------------------------------------------
  const offline = h('dd', { 'data-field': 'offline', text: offlineStatus() });
  if ('serviceWorker' in navigator) navigator.serviceWorker.ready.then(() => { offline.textContent = offlineStatus(); });

  const body = h('section', { class: 'screen screen--settings', 'data-screen': 'settings' },
    h('h2', { class: 'screen__heading', text: 'AI учител' }),
    h('div', { class: 'settings__group' },
      row('API ключ (Claude Console)', 'settings-api-key',
        keyStatus,
        h('div', { class: 'settings__key-line' }, keyInput, showButton, saveButton),
        warning,
        h('div', { class: 'settings__actions' }, checkButton, deleteButton),
        confirmSlot,
        keyMessage),
      row('Модел', 'settings-model', modelSelect),
      row('Праг за разход', 'settings-budget',
        h('span', { class: 'settings__budget' }, h('span', { 'aria-hidden': 'true', text: '$' }), budgetInput, h('span', { class: 'muted', text: ' на месец' })),
        budgetMessage),
      row('Разход този месец', null, spend, spendWarning),
    ),
    h('h2', { class: 'screen__heading', text: 'Четене' }),
    h('div', { class: 'settings__group' },
      row('Размер на текста', null, h('div', { class: 'settings__scale' }, smaller, scaleValue, bigger), sample),
      row('Тема', null, themeGroup, h('p', { class: 'muted settings__hint', 'data-field': 'theme-hint', text: 'Уроците следват темата на системата (браузърът не им предава избора).' })),
    ),
    h('h2', { class: 'screen__heading', text: 'Данни' }),
    h('div', { class: 'settings__group' },
      row('Място', null, storageUsed),
      row('Защита', null, persistStatus, persistButton),
    ),
    h('h2', { class: 'screen__heading', text: 'За приложението' }),
    h('dl', { class: 'facts' },
      h('dt', { text: 'Версия' }),
      h('dd', { 'data-field': 'version', text: APP_VERSION }),
      h('dt', { text: 'Офлайн режим' }),
      offline,
    ),
  );

  (async () => {
    try {
      const [s, key, t] = await Promise.all([getSettings(), getApiKey(), usageTotals(monthStart())]);
      if (destroyed) return;
      settings = s;
      totals = t;
      showKeyState(key);
      if (!MODELS.some((m) => m.id === s.model)) {
        // A model saved by hand or by an older build: still shown, still chosen.
        modelSelect.append(h('option', { value: s.model, text: s.model }));
      }
      modelSelect.value = s.model;
      budgetInput.value = String(s.monthlyBudgetUSD ?? 5);
      showSpend();
      showScale(FONT_SCALES.includes(s.fontScale) ? s.fontScale : 1);
      if (!FONT_SCALES.includes(s.fontScale)) scaleValue.textContent = `${Math.round((s.fontScale || 1) * 100)} %`;
      for (const input of themeInputs) input.checked = input.value === (THEMES.includes(s.theme) ? s.theme : 'system');
      body.dataset.loaded = 'yes';
    } catch {
      keyStatus.textContent = 'Настройките не можаха да се прочетат.';
    }
  })();
  showStorage().catch(() => { storageUsed.textContent = '—'; });

  return {
    title: 'Настройки',
    back: { href: '#/', label: 'Курсове' },
    body,
    destroy() {
      destroyed = true;
      keyInput.value = ''; // a typed, unsaved key does not stay in memory of the old screen
    },
  };
}
