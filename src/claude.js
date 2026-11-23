// Claude API from the browser (D-015). T-019: what "Настройки" needs — the
// model list, the request headers and the key check. T-020 (0.16.0): the
// client — `streamMessage()` (Messages API with SSE streaming, cancel, retry
// of an overloaded API, Bulgarian errors) and the cost of a call from its
// `usage` (`PRICES`, `costOf()`; the monthly total and the warning are in
// src/usage.js). The prompt of the teacher is src/teacher.js (T-021).
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
/**
 * Blank characters around a pasted key: dropped. `\s` covers spaces, tabs,
 * line breaks, NBSP, BOM (U+FEFF), U+2028/2029, U+3000 and the other Unicode
 * spaces; T053-I3 adds the invisible ones that are not `\s`: zero-width space,
 * non-joiner and joiner (U+200B–U+200D), word joiner (U+2060), the Mongolian
 * vowel separator (U+180E) and the soft hyphen (U+00AD). Inside the key they
 * are still refused (KEY_CHARS).
 */
const EDGE_SPACE = /^[\s\u200B-\u200D\u2060\u180E\u00AD]+|[\s\u200B-\u200D\u2060\u180E\u00AD]+$/g;
export const KEY_BAD_CHARS = 'Ключът съдържа непозволени знаци — копирай го наново от Claude Console.';

/** `raw` as a string without blank or invisible characters at its ends. */
export function trimBlank(raw) {
  return String(raw ?? '').replace(EDGE_SPACE, '');
}

/**
 * Clean a typed or pasted key: { key } or { error } (Bulgarian, never with the key in it).
 * T051-I2: only spaces and line breaks AROUND the key are dropped; a space, a
 * control character or any non-ASCII character inside is an error (fetch()
 * would refuse such a header, which looked like "no connection").
 * @param {string} raw
 */
export function validateKey(raw) {
  const key = trimBlank(raw);
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

// ---------------------------------------------------------------------------
// T-020: prices, cost of a call
// ---------------------------------------------------------------------------

/**
 * USD per million tokens, by model (Claude API price list, 23.11.2026). One
 * table, easy to change: input, output, cache writes (5 min / 1 h) and cache
 * reads. Haiku 5.5 costs more for a prompt over 100 000 tokens (`long`).
 * A model not in the table is priced as the default model (an estimate).
 */
export const PRICES = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.1 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 }),
  'claude-haiku-5-5': Object.freeze({
    input: 0.1, output: 0.5, write5m: 0.125, write1h: 0.2, read: 0.01,
    long: Object.freeze({ over: 100000, input: 0.5, output: 2.5, write5m: 0.625, write1h: 1, read: 0.05 }),
  }),
});

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/**
 * The token counts of an API `usage` object, in the app's names:
 * { input, output, cacheRead, cacheWrite, write5m, write1h }. A cache write
 * without the per-TTL split counts as 1 h (the app writes 1 h blocks, D-017).
 */
export function usageCounts(usage = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const cacheWrite = count(u.cache_creation_input_tokens);
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  let write5m = split ? count(split.ephemeral_5m_input_tokens) : 0;
  let write1h = split ? count(split.ephemeral_1h_input_tokens) : cacheWrite;
  if (split && write5m + write1h < cacheWrite) write1h += cacheWrite - write5m - write1h;
  return { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: Math.max(cacheWrite, write5m + write1h), write5m, write1h };
}

/** Cost in USD of one call (`usage` of the API or usageCounts()). */
export function costOf(model, usage) {
  const c = 'write5m' in (usage || {}) ? usage : usageCounts(usage);
  let p = PRICES[model] || PRICES[DEFAULT_MODEL];
  const prompt = c.input + c.cacheRead + c.cacheWrite;
  if (p.long && prompt > p.long.over) p = p.long;
  return (c.input * p.input + c.output * p.output + c.write5m * p.write5m + c.write1h * p.write1h + c.cacheRead * p.read) / 1e6;
}

// ---------------------------------------------------------------------------
// T-020: the streaming client
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 1500;
export const MAX_TOKENS_LIMIT = 32000;
/** No byte from the API for this long → the call is given up (a timeout). */
export const IDLE_TIMEOUT_MS = 60000;
/** An overloaded / rate-limited API is asked again after these waits (ms), before any text came. */
export const RETRY_WAITS_MS = Object.freeze([2000, 6000]);
const RETRY_AFTER_MAX_MS = 30000;

/** An error of a call: `kind` (auth, permission, model, busy, request, server, network, timeout, aborted, stream, no-key, bad-key), Bulgarian `text`. Never the key, never the API's own message text. */
export class ClaudeError extends Error {
  constructor(kind, text, status = 0) {
    super(text);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.text = text;
    this.status = status;
  }
}

const ABORTED_TEXT = 'Отказано. Отговорът е спрян.';
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new ClaudeError('aborted', ABORTED_TEXT)); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(new ClaudeError('aborted', ABORTED_TEXT)); };
  signal?.addEventListener('abort', stop, { once: true });
});

/** Text of a failed fetch (no response). */
function networkError(timedOut, timeoutMs) {
  if (timedOut) return new ClaudeError('timeout', `Няма отговор от api.anthropic.com за ${Math.round(timeoutMs / 1000)} s. Опитай пак.`);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new ClaudeError('network', 'Няма интернет връзка. Провери мрежата и опитай пак.');
  return new ClaudeError('network', 'Няма връзка с api.anthropic.com. Провери интернета и опитай пак.');
}

/** An `error` event inside the stream (the API failed after it began). */
function streamError(type) {
  if (type === 'overloaded_error') return new ClaudeError('busy', 'Claude API е претоварен в момента (529). Опитай пак след малко.', 529);
  if (type === 'rate_limit_error') return describeAsError(429, type);
  if (type === 'api_error') return new ClaudeError('server', 'Грешка в Claude API по време на отговора. Опитай пак.', 500);
  return new ClaudeError('stream', 'Отговорът прекъсна по средата. Опитай пак.');
}
function describeAsError(status, type, model) {
  const d = describeError(status, type, model);
  return new ClaudeError(d.kind, d.text, status);
}

/** Wait asked by the API (retry-after, seconds), within limits; else the planned wait. */
function retryWait(response, planned) {
  const h = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(h) && h > 0 ? Math.min(RETRY_AFTER_MAX_MS, h * 1000) : planned;
}

/**
 * Server-sent events of one response body: calls `onEvent(type, data)` per event
 * (data parsed as JSON; a broken event is skipped). Resolves at the end of the body.
 */
async function readEvents(body, onEvent, { idleMs, signal }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idle = null;
  let timedOut = false;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, idleMs); };
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const flush = (block) => {
    let type = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return true;
    let parsed;
    try { parsed = JSON.parse(data.join('\n')); } catch { return true; }
    return onEvent(type, parsed) !== false;
  };
  try {
    arm();
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { chunk = { done: true, failed: true }; }
      if (signal?.aborted) throw new ClaudeError('aborted', ABORTED_TEXT);
      if (timedOut) throw new ClaudeError('timeout', `Отговорът спря за ${Math.round(idleMs / 1000)} s. Опитай пак.`);
      if (chunk.failed) throw new ClaudeError('stream', 'Връзката прекъсна по време на отговора. Опитай пак.');
      if (chunk.done) break;
      arm();
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (!flush(block)) { reader.cancel().catch(() => {}); return; }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) flush(buffer);
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * One streamed Messages API call (D-015). Resolves with
 * { text, stopReason, model, usage (usageCounts), costUSD, attempts };
 * rejects with a ClaudeError (Bulgarian text) — also when cancelled
 * (`signal`, kind 'aborted'). An overloaded / rate-limited API (429, 529, an
 * `overloaded_error` before any text) is asked again after RETRY_WAITS_MS.
 * The key goes only into the request headers to API_ORIGIN.
 * @param {{ apiKey: string, model?: string, maxTokens?: number, system?: Array|string,
 *   messages: Array, cacheControl?: object|null, signal?: AbortSignal,
 *   onText?: (delta: string, text: string) => void, idleTimeoutMs?: number,
 *   retryWaits?: number[], temperature?: number }} opts
 */
export async function streamMessage({
  apiKey, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, system, messages,
  cacheControl = null, signal, onText, idleTimeoutMs = IDLE_TIMEOUT_MS, retryWaits = RETRY_WAITS_MS,
}) {
  if (!apiKey) throw new ClaudeError('no-key', 'Въведи API ключ в Настройки.');
  const valid = validateKey(apiKey);
  if (valid.error) throw new ClaudeError('bad-key', valid.error);
  const id = typeof model === 'string' && /^[a-z0-9.-]{3,80}$/.test(model) ? model : DEFAULT_MODEL;
  const max = Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.floor(Number(maxTokens) || DEFAULT_MAX_TOKENS)));
  const body = { model: id, max_tokens: max, stream: true, messages };
  if (system !== undefined && system !== null && system !== '') body.system = system;
  if (cacheControl) body.cache_control = cacheControl; // automatic caching of the thread (D-017)
  const json = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new ClaudeError('aborted', ABORTED_TEXT);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, idleTimeoutMs);
    let response;
    try {
      response = await fetch(`${API_ORIGIN}/v1/messages`, {
        ...FETCH_OPTIONS, method: 'POST', headers: apiHeaders(valid.key), body: json, signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new ClaudeError('aborted', ABORTED_TEXT);
      throw networkError(timedOut, idleTimeoutMs);
    }
    clearTimeout(timer);
    try {
      if (!response.ok) {
        const type = await errorType(response);
        const err = describeAsError(response.status, type, id);
        const again = (response.status === 429 || response.status === 529 || type === 'overloaded_error') && attempt < retryWaits.length;
        if (!again) throw err;
        await sleep(retryWait(response, retryWaits[attempt]), signal);
        continue;
      }
      if (!response.body) throw new ClaudeError('stream', 'Отговорът е празен. Опитай пак.');
      let text = '';
      let usage = {};
      let stopReason = null;
      let failure = null;
      let stopped = false;
      await readEvents(response.body, (type, data) => {
        const kind = data?.type || type;
        if (kind === 'message_start') {
          usage = { ...(data.message?.usage || {}) };
        } else if (kind === 'content_block_delta') {
          if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
            text += data.delta.text;
            try { onText?.(data.delta.text, text); } catch { /* the caller's problem */ }
          }
        } else if (kind === 'message_delta') {
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          if (data.usage) usage = { ...usage, ...data.usage };
        } else if (kind === 'message_stop') {
          stopped = true;
          return false;
        } else if (kind === 'error') {
          failure = streamError(typeof data.error?.type === 'string' ? data.error.type : '');
          return false;
        }
        return true;
      }, { idleMs: idleTimeoutMs, signal });
      if (failure) {
        if (failure.kind === 'busy' && !text && attempt < retryWaits.length) {
          await sleep(retryWaits[attempt], signal);
          continue;
        }
        failure.partial = text;
        throw failure;
      }
      if (!stopped) {
        const err = new ClaudeError('stream', 'Отговорът прекъсна, преди да завърши. Опитай пак.');
        err.partial = text;
        throw err;
      }
      const counts = usageCounts(usage);
      return { text, stopReason, model: id, usage: counts, costUSD: costOf(id, counts), attempts: attempt + 1 };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
