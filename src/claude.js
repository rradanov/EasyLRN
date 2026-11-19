// Claude API from the browser (D-015). T-019: only what "Настройки" needs —
// the model list, the request headers and the key check. The full client
// (streaming, context, prompt caching, usage and cost) is T-021.
//
// The API key (D-037):
// - the caller reads it from the `secrets` store and passes it in; only
//   apiHeaders() puts it into a request, and only to API_ORIGIN;
// - it never goes into a console message, an error text or an exception:
//   every result here is built from the HTTP status and the API's error type
//   only (the API's own message text is never shown or kept);
// - requests go with `credentials: 'omit'`, `redirect: 'error'`, no referrer.

export const API_ORIGIN = 'https://api.anthropic.com';
export const API_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-5-5'; // D-015, D-022
/** The models offered in "Настройки" (the first is the default). */
export const MODELS = Object.freeze([
  Object.freeze({ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — по подразбиране' }),
  Object.freeze({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — по-силен, по-скъп' }),
  Object.freeze({ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — най-бърз и евтин' }),
]);
export const CHECK_TIMEOUT_MS = 20000;

const KEY_PREFIX = 'sk-ant-';
/** The only characters of a key: printable ASCII letters, digits, "-" and "_". */
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;
/** Spaces and line breaks around a pasted key (also NBSP, BOM): dropped. */
const EDGE_SPACE = /^\s+|\s+$/g;
export const KEY_BAD_CHARS = 'Ключът съдържа непозволени знаци — копирай го наново от Claude Console.';

/**
 * Clean a typed or pasted key: { key } or { error } (Bulgarian, never with the key in it).
 * T051-I2: only spaces and line breaks AROUND the key are dropped; a space, a
 * control character or any non-ASCII character inside is an error (fetch()
 * would refuse such a header, which looked like "no connection").
 * @param {string} raw
 */
export function validateKey(raw) {
  const key = String(raw ?? '').replace(EDGE_SPACE, '');
  if (!key) return { error: 'Въведи ключа.' };
  if (!key.startsWith(KEY_PREFIX)) return { error: 'Ключът на Claude API започва със „sk-ant-“. Копирай го наново от Claude Console.' };
  if (!KEY_CHARS.test(key)) return { error: KEY_BAD_CHARS };
  if (key.length < 20 || key.length > 400) {
    return { error: 'Това не прилича на ключ на Claude API (дължината не е на ключ). Копирай го наново от Claude Console.' };
  }
  return { key };
}

/**
 * "•••• 3f9a": only the last 4 characters of a saved key are ever shown; a
 * key too short for that (not one from the field) shows only the dots.
 */
export function maskKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.length < 12) return '••••';
  return `•••• ${key.slice(-4)}`;
}

/** The headers of every Claude API request (T-021 uses them too). */
export function apiHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // CORS from a browser; the key belongs to the user of this browser (D-015).
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** The options of every Claude API fetch besides method/headers/body. */
export const FETCH_OPTIONS = Object.freeze({
  credentials: 'omit',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
  cache: 'no-store',
  mode: 'cors',
});

/** The API's error type from a response body ('' if none). Its message text is not kept. */
async function errorType(response) {
  try {
    const data = await response.json();
    return typeof data?.error?.type === 'string' ? data.error.type.slice(0, 60) : '';
  } catch {
    return '';
  }
}

/**
 * Bulgarian text for a failed call (ARCHITECTURE §6.1).
 * @returns {{ kind: string, text: string }}
 */
export function describeError(status, type = '', model = '') {
  if (status === 401 || type === 'authentication_error') {
    return { kind: 'auth', text: 'Ключът е невалиден (401). Провери го в Claude Console или въведи нов.' };
  }
  if (status === 403 || type === 'permission_error') {
    return { kind: 'permission', text: 'Ключът няма право на тази заявка (403). Провери ключа и workspace-а в Claude Console.' };
  }
  if (status === 404 || type === 'not_found_error') {
    return { kind: 'model', text: `Моделът „${model}“ не е намерен или не е достъпен за този ключ (404). Избери друг модел.` };
  }
  if (status === 429 || type === 'rate_limit_error') {
    return { kind: 'busy', text: 'Claude API е зает или е достигнат лимит на заявките/разхода (429). Опитай пак след малко или провери лимитите в Claude Console.' };
  }
  if (status === 529 || type === 'overloaded_error') {
    return { kind: 'busy', text: 'Claude API е претоварен в момента (529). Опитай пак след малко.' };
  }
  if (status === 400) {
    return { kind: 'request', text: `Заявката е отказана (400${type ? `, ${type}` : ''}). Провери модела и баланса в Claude Console.` };
  }
  if (status >= 500) return { kind: 'server', text: `Грешка в Claude API (${status}). Опитай пак след малко.` };
  return { kind: 'request', text: `Заявката е отказана (${status}${type ? `, ${type}` : ''}).` };
}

/**
 * "Провери": the smallest real call — Messages with max_tokens 1 — so the key,
 * the model and the browser access (CORS) are all checked at once. Never throws.
 * @param {{ apiKey: string, model: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true, model: string } | { ok: false, kind: string, status: number, text: string }>}
 */
export async function checkKey({ apiKey, model, timeoutMs = CHECK_TIMEOUT_MS }) {
  if (!apiKey) return { ok: false, kind: 'no-key', status: 0, text: 'Първо въведи и запази API ключ.' };
  // A stored key that never went through the field (an old build, by hand):
  // the same rules as "Запази", before any request (T051-I2).
  const valid = validateKey(apiKey);
  if (valid.error) return { ok: false, kind: 'bad-key', status: 0, text: valid.error };
  apiKey = valid.key;
  const id = MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_ORIGIN}/v1/messages`, {
      ...FETCH_OPTIONS,
      method: 'POST',
      headers: apiHeaders(apiKey),
      body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return { ok: false, kind: 'timeout', status: 0, text: `Няма отговор от api.anthropic.com за ${Math.round(timeoutMs / 1000)} s. Опитай пак.` };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { ok: false, kind: 'network', status: 0, text: 'Няма интернет връзка. Провери мрежата и опитай пак.' };
    }
    return { ok: false, kind: 'network', status: 0, text: 'Няма връзка с api.anthropic.com. Провери интернета и опитай пак.' };
  }
  clearTimeout(timer);
  if (!response.ok) {
    const type = await errorType(response);
    return { ok: false, status: response.status, ...describeError(response.status, type, id) };
  }
  return { ok: true, model: id };
}
