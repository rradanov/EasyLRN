// Voice input (T-041, D-025): a 🎤 button next to a text field of the app (a
// note, a question, a next question). Speech becomes text through the Web
// Speech API (`SpeechRecognition`, `bg-BG`, interim results shown live in grey);
// the final text goes into the field at the cursor, where it can be edited
// before it is saved / sent. No audio is kept by the app.
//
// - Only in the app: the lesson frame has no `allow="microphone"` and the
//   lesson responses carry `Permissions-Policy: microphone=()` (sw.js). The
//   lesson never gets the text: nothing here posts to it; the text goes only
//   into the app's field (as if typed, with an `input` event).
// - The guard of the field (T018-D2 / T070 lrn:keys): a press on 🎤 does not
//   take the focus from the field (pointerdown / mousedown default prevented),
//   so the field keeps its guard while the user speaks; after a keyboard press
//   on 🎤 the field gets the focus back with the first text.
// - Without the API, or offline (Chrome's recognition needs the network), the
//   button is hidden: the dictation of the keyboard (Gboard / Samsung 🎤) stays.
// - A second press stops. "Слуша…" is shown (aria-pressed, a status line for
//   screen readers). Errors are in Bulgarian.
import { h } from './dom.js';

export const VOICE_LANG = 'bg-BG';

/** The SpeechRecognition class of this browser, or null. */
export function recognitionClass() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}
/** Can a 🎤 be offered now (the API is there and the device is online)? */
export function voiceAvailable() {
  return Boolean(recognitionClass()) && navigator.onLine !== false;
}

/** The message of a recognition error (null: say nothing). `hide`: the button goes. */
export function voiceError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return { text: 'Няма разрешение за микрофона. Разреши микрофона за приложението в настройките на Chrome (иконата до адреса → Разрешения) и опитай пак.' };
    case 'network':
      return { text: 'Няма връзка с мрежата: гласовото въвеждане не работи без интернет. Ползвай диктовката на клавиатурата.', hide: true };
    case 'no-speech':
      return { text: 'Нищо не се чу. Натисни 🎤 и говори.' };
    case 'audio-capture':
      return { text: 'Микрофонът не е достъпен (няма микрофон или се ползва от друго приложение).' };
    case 'language-not-supported':
      return { text: 'Гласовото въвеждане на български не се поддържа тук. Ползвай диктовката на клавиатурата.', hide: true };
    case 'aborted':
      return null;
    default:
      return { text: 'Гласовото въвеждане не сработи. Опитай пак.' };
  }
}

const live = new Set(); // the open voice inputs (a page listens to one at a time)

/** Stop every voice input of the page (a panel closes, the screen goes). */
export function stopAllVoice() {
  for (const v of [...live]) v.stop();
}

/**
 * A 🎤 for `field` (a textarea of the app).
 * @param {{ field: HTMLTextAreaElement, label?: string }} opts
 * @returns {{ element: HTMLElement, button: HTMLButtonElement, readonly listening: boolean, stop: () => void, cancel: () => void, destroy: () => void }}
 */
export function createVoiceInput({ field, label = 'Гласово въвеждане' }) {
  const button = h('button', {
    type: 'button', class: 'button voice__button', 'data-action': 'voice', 'aria-pressed': 'false',
    'aria-label': label, title: label,
  }, h('span', { 'aria-hidden': 'true', text: '🎤' }));
  const interim = h('p', { class: 'voice__interim', 'data-field': 'voice-interim', 'aria-hidden': 'true', hidden: true });
  const status = h('p', { class: 'voice__status', 'data-field': 'voice-status', role: 'status', 'aria-live': 'polite' });
  const element = h('div', { class: 'voice', 'data-field': 'voice' }, button, status, interim);

  let rec = null;
  let listening = false;
  let destroyed = false;
  let at = null; // [start, end] where the next final text goes
  let gotText = false;
  let failed = null;
  let cancelled = false; // cancel(): the text was sent / dropped — say nothing after it

  const show = () => {
    const ok = !destroyed && voiceAvailable() && !element.dataset.unsupported;
    element.hidden = !ok;
    if (!ok && listening) stop();
  };
  const paint = () => {
    button.setAttribute('aria-pressed', String(listening));
    button.classList.toggle('voice__button--on', listening);
    const name = listening ? 'Спри гласовото въвеждане' : label;
    button.setAttribute('aria-label', name);
    button.title = name;
    element.dataset.state = listening ? 'listening' : 'idle';
  };

  /** Put `text` into the field at the cursor (a space before it when needed), as typing would. */
  const insert = (text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || !field.isConnected) return;
    const focused = document.activeElement === field;
    let [start, end] = focused || !at ? [field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length] : at;
    start = Math.min(start, field.value.length);
    end = Math.min(Math.max(end, start), field.value.length);
    const before = field.value.slice(0, start);
    const after = field.value.slice(end);
    const piece = `${before && !/\s$/.test(before) ? ' ' : ''}${t}${after && !/^\s/.test(after) ? ' ' : ''}`;
    const room = field.maxLength > 0 ? field.maxLength - (field.value.length - (end - start)) : Infinity;
    if (room <= 0) return;
    const put = piece.slice(0, room);
    if (!focused) field.focus({ preventScroll: true });
    field.setRangeText(put, start, end, 'end');
    at = [field.selectionStart, field.selectionEnd];
    gotText = true;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const onResult = (event) => {
    if (destroyed || !field.isConnected) { stop(); return; }
    let pending = '';
    const results = event.results;
    for (let i = event.resultIndex ?? 0; i < results.length; i++) {
      const r = results[i];
      const text = r?.[0]?.transcript || '';
      if (r?.isFinal) insert(text);
      else pending += text;
    }
    interim.textContent = pending.trim();
    interim.hidden = !interim.textContent;
  };

  function start() {
    const Rec = recognitionClass();
    if (!Rec || listening || destroyed) return;
    stopAllVoice(); // one at a time
    failed = null;
    cancelled = false;
    gotText = false;
    at = [field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length];
    try {
      rec = new Rec();
      rec.lang = VOICE_LANG;
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      rec.onresult = onResult;
      rec.onerror = (e) => {
        const code = e?.error || 'error';
        const msg = voiceError(code);
        // T042-D1: "aborted" (abort(), or the system took the microphone) is an
        // end, not a failure: onend then clears "Слуша…" (or says "Готово…").
        failed = msg ? code : null;
        if (msg) status.textContent = msg.text;
        if (msg?.hide) { element.dataset.unsupported = failed; show(); }
      };
      rec.onend = () => {
        listening = false;
        rec = null;
        interim.textContent = '';
        interim.hidden = true;
        live.delete(api);
        paint();
        if (cancelled) status.textContent = '';
        else if (!failed) status.textContent = gotText ? 'Готово: провери текста преди запис.' : '';
      };
      rec.start();
    } catch (err) {
      console.warn('EasyLRN: voice input did not start:', err?.name || err);
      rec = null;
      status.textContent = 'Гласовото въвеждане не сработи. Опитай пак.';
      return;
    }
    listening = true;
    live.add(api);
    status.textContent = 'Слуша… Говори; натисни 🎤 пак, за да спреш.';
    paint();
  }
  function stop() {
    if (!rec) { listening = false; paint(); return; }
    try { rec.stop(); } catch { /* already stopped */ }
  }
  /** Stop now and drop what was not final yet (the field is sent / emptied). */
  function cancel() {
    if (!rec) return;
    cancelled = true;
    status.textContent = '';
    rec.onresult = null;
    try { rec.abort(); } catch { /* already stopped */ }
  }

  // The field keeps the focus (and its guard) at a press on 🎤.
  const keep = (e) => { if (e.isTrusted && e.cancelable) e.preventDefault(); };
  button.addEventListener('pointerdown', keep);
  button.addEventListener('mousedown', keep);
  button.addEventListener('click', () => { if (listening) stop(); else start(); });
  const onLine = () => show();
  window.addEventListener('online', onLine);
  window.addEventListener('offline', onLine);

  const api = {
    element,
    button,
    get listening() { return listening; },
    stop,
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rec) { rec.onresult = null; try { rec.abort(); } catch { /* gone */ } }
      live.delete(api);
      window.removeEventListener('online', onLine);
      window.removeEventListener('offline', onLine);
    },
  };
  paint();
  show();
  return api;
}
