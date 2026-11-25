// The AI teacher: the prompt of a question (T-021, D-016, D-017, D-047).
//
// A request is put together by the app, never by a lesson:
//   system: [
//     {1} the rules of the teacher — prompts/teacher-system.md (from lrn-teach, D-024)
//     {2} the course — MISSION, NOTES, RESOURCES, GLOSSARY       ← cache_control 1 h
//     {3} the lesson — its text, extracted deterministically     ← cache_control 1 h
//   ]
//   messages: [ …the thread so far…, { user: the quote, its paragraph, the path
//               of headings, the question } ]   (+ automatic caching of a thread)
// Blocks {2} and {3} must be byte for byte the same at every question of a
// lesson, or the cache is missed: the lesson text comes from the ORIGINAL file
// of the lesson (IndexedDB `files`), parsed with DOMParser (inert: no script
// runs, nothing loads) and walked by fixed rules (`extractLessonText`, version
// TEXT_VERSION); the result is kept per file hash (`sha256`) for the session.
// Nothing of a question or an answer is ever sent to the lesson.
// `showPrompt()` gives the whole prompt as text ("Покажи промпта", D-047).
// The UI of the questions is T-023 (src/questions.js, src/screens/notes-strip.js).
import { getFile } from './db.js';
import { streamMessage, DEFAULT_MODEL, DEFAULT_MAX_TOKENS, answerMaxTokens } from './claude.js';
import { recordCall } from './usage.js';

export const RULES_URL = './prompts/teacher-system.md';
/** Bump when extractLessonText() gives another text for the same file. */
export const TEXT_VERSION = 1;
/** A lesson longer than this (characters, ~15 000 tokens) is sent as its headings + the section asked about. */
export const LONG_LESSON_CHARS = 60000;
export const LIMITS = Object.freeze({ quote: 2000, paragraph: 4000, question: 4000, pathItem: 200, pathItems: 12, courseFile: 40000, answer: 20000, history: 40, userTurn: 16000 });
const CACHE_1H = Object.freeze({ type: 'ephemeral', ttl: '1h' });

/**
 * Is `i` inside one character of `s` (a grapheme), i.e. not a place to cut?
 * Fixed rules (no Intl.Segmenter: its data changes with the browser and the
 * prompt must stay the same, D-017): the second half of a surrogate pair, a
 * combining mark, a variation selector, a skin tone, a tag character, or
 * either side of a zero-width joiner (T074-D4).
 */
const JOINS = /^(?:\p{M}|[\u200D\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}])/u;
function inCharacter(s, i) {
  if (i <= 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  if (c >= 0xDC00 && c <= 0xDFFF && (s.charCodeAt(i - 1) & 0xFC00) === 0xD800) return true;
  if (s.charCodeAt(i - 1) === 0x200D) return true;
  return JOINS.test(s.slice(i, i + 2));
}
/** `s` cut to at most `n` UTF-16 units, at a character boundary (an ellipsis when cut). */
export function clipText(s, n) {
  const t = typeof s === 'string' ? s : '';
  if (t.length <= n) return t;
  let end = Math.max(0, n - 1);
  const floor = Math.max(0, end - 64); // a cluster is never that long; stop anyway
  while (end > floor && inCharacter(t, end)) end--;
  return `${t.slice(0, end)}…`;
}
const clip = clipText;

/**
 * T074-S2: the material (course files, the lesson, its title, the quote) can
 * never close or open a block of the prompt. Deterministic and the same for
 * every text: every closing tag "</x" becomes "<\/x", and an opening tag of a
 * name the prompt uses (or might use: SYSTEM, RULES…) becomes "<\x" — in any
 * letter case. The model still reads the text; only the app writes real tags.
 */
export const PROMPT_TAGS = Object.freeze(['LESSON', 'MISSION', 'NOTES', 'RESOURCES', 'GLOSSARY', 'QUOTE', 'PARAGRAPH',
  'QUESTION', 'ANSWER', 'COURSE', 'REFERENCE', 'SYSTEM', 'RULES', 'MATERIAL', 'INSTRUCTIONS', 'THREAD', 'HISTORY', 'USER', 'ASSISTANT', 'HUMAN']);
// T042-S3 (replaces the fixed list of T024-S2): a model reads "<", any run of
// characters that are not letters or digits, then "/" as a closing tag — so
// every such run is neutralised, whatever the characters are (white space,
// format / control characters, variation selectors, punctuation…). The fillers
// that Unicode counts as letters but nobody sees (Hangul fillers) are a gap too.
// No list of invisible characters to keep up to date: a gap is "not a letter or
// a digit" (and not "<" / ">"). The result depends only on the text (the same
// text → the same bytes: the cache of D-017 is kept).
const FILLERS = '\\u115F\\u1160\\u3164\\uFFA0';
const GAP = `(?:[^\\p{L}\\p{N}<>/\\uFF1C\\uFF1E\\uFE64\\uFE65\\uFF0F\\u02C2]|[${FILLERS}])`;
// What is dropped from a name before it is compared (SYS<ZWSP>TEM, S<VS16>YSTEM…):
// marks, controls / format characters, the fillers, the braille blank.
const INVISIBLE = new RegExp(`[\\p{M}\\p{C}${FILLERS}\\u2800]`, 'gu');
// "<" and its look-alikes (fullwidth ＜, small ﹤, modifier ˂); "/" and fullwidth ／.
const TAG_START = new RegExp(`[<\\uFF1C\\uFE64\\u02C2](${GAP}*)([/\\uFF0F]?)`, 'gu');
const TAG_NAME = new RegExp(`^(?:${PROMPT_TAGS.join('|')})(?![A-Za-z0-9_-])`, 'i');
export function neutralizeTags(s) {
  const t = String(s ?? '');
  return t.replace(TAG_START, (all, gap, slash, at) => {
    if (slash) return '<\\/';
    // An opening tag of the prompt: its name read as the model would (no
    // invisible characters, NFKC: fullwidth letters are letters).
    // The gap is read too: symbols that NFKC makes letters (circled Ⓢ…) start the name.
    const name = t.slice(at + 1, at + all.length + 64).normalize('NFKC').replace(INVISIBLE, '').replace(/^[^\p{L}\p{N}]+/u, '');
    return TAG_NAME.test(name) ? `<\\${gap}` : all;
  });
}

/** Line ends, NFC, no control characters: the same text from the same input. */
const clean = (s) => String(s ?? '').normalize('NFC').replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

// --- The rules --------------------------------------------------------------------

let rulesCache = null;
/**
 * The rules of prompts/teacher-system.md without its leading comment:
 * { text, version } (the version from the comment's "Version:" line).
 */
export function parseRules(source) {
  const src = clean(source);
  const m = /^\s*<!--([\s\S]*?)-->\s*/.exec(src);
  const head = m ? m[1] : '';
  const version = (/Version:\s*([0-9][^\s(]*)/.exec(head) || [])[1] || '';
  return { text: (m ? src.slice(m[0].length) : src).trim(), version };
}
/** Load the rules once (the file is in the shell cache of the Service Worker). */
export async function loadRules() {
  if (rulesCache) return rulesCache;
  const response = await fetch(RULES_URL, { cache: 'no-cache', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`teacher rules: HTTP ${response.status}`);
  rulesCache = parseRules(await response.text());
  return rulesCache;
}

// --- The lesson text ----------------------------------------------------------------

const SKIP = new Set(['script', 'style', 'lrn-style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'head', 'title', 'meta', 'link', 'base', 'svg', 'math', 'canvas', 'audio', 'video', 'picture', 'source', 'track',
  'img', 'input', 'select', 'textarea', 'button', 'dialog']);
/** Blocks of one line each: a new line, no empty line between them. */
const LINE = new Set(['li', 'dt', 'dd', 'tr', 'summary', 'figcaption', 'caption']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * The HTML with its inline styles and event handlers renamed (`<style>` →
 * `<lrn-style>`, `style=` / `on…=` → `data-lrn-…=`): a document of DOMParser
 * runs none of them, but Chromium still checks them against the app's CSP and
 * logs a violation for each. Only for parsing; the text is the same.
 */
function inert(html) {
  return html
    .replace(/<(\/?)style(?=[\s/>])/gi, '<$1lrn-style')
    .replace(/<[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g, (tag) => tag.replace(/(\s)(on[a-z0-9_:-]*|style)(?=\s*(?:=|\/?>|\s))/gi, '$1data-lrn-$2'));
}

/**
 * The readable text of a lesson's HTML, by fixed rules (the same input → the
 * same string): headings as "#"…, list items as "- ", table cells split by
 * " | ", paragraphs by an empty line, runs of spaces as one. Scripts, styles,
 * templates, media, form controls and hidden elements give nothing. Parsing
 * with DOMParser runs no script and loads nothing.
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export function extractLessonText(html) {
  const doc = new DOMParser().parseFromString(inert(String(html ?? '')), 'text/html');
  const out = [];
  let line = '';
  let pre = 0;
  const flush = () => {
    const t = line.replace(/[ \t ]+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };
  const gap = () => { flush(); if (out.length && out[out.length - 1] !== '') out.push(''); };
  const hidden = (el) => el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true'
    || /(^|;)\s*display\s*:\s*none/i.test(el.getAttribute('data-lrn-style') || '');
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        line += pre ? child.data : child.data.replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.localName;
      if (SKIP.has(tag) || hidden(child)) continue;
      if (tag === 'br') { if (pre) line += '\n'; else flush(); continue; }
      const heading = /^h([1-6])$/.exec(tag);
      const line1 = LINE.has(tag);
      const block = !line1 && BLOCK.has(tag);
      if (block) gap(); else if (line1) flush();
      if (heading) line += `${'#'.repeat(Number(heading[1]))} `;
      else if (tag === 'li') line += '- ';
      if (tag === 'pre') pre++;
      walk(child);
      if (tag === 'pre') {
        pre--;
        for (const l of line.split('\n')) { const t = l.replace(/\s+$/, ''); if (t) out.push(t); }
        line = '';
      }
      if (tag === 'td' || tag === 'th') line += ' | ';
      if (block) gap(); else if (line1) flush();
    }
  };
  if (doc.body) walk(doc.body);
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  const text = clean(out.join('\n').replace(/ \| (?=\n|$)/g, '').replace(/\n{3,}/g, '\n\n'));
  const title = clean(doc.title || '').replace(/\s+/g, ' ').trim();
  return { title, text };
}

const textCache = new Map(); // `${sha256}:${TEXT_VERSION}` → { title, text }
/**
 * The text of a lesson (by its record: { courseId, path, title, number }), from
 * the original file; kept for this session per file hash.
 */
export async function lessonText(lesson) {
  const file = await getFile(lesson.courseId, lesson.path);
  if (!file?.blob) throw new Error('lesson file missing');
  const key = file.sha256 ? `${file.sha256}:${TEXT_VERSION}` : null;
  if (key && textCache.has(key)) return textCache.get(key);
  const html = await file.blob.text();
  const result = extractLessonText(html);
  if (key) textCache.set(key, result);
  return result;
}

/** The headings of a lesson text (lines starting with "#"). */
const headingsOf = (text) => text.split('\n').filter((l) => /^#{1,6} /.test(l));

/**
 * A long lesson (> LONG_LESSON_CHARS): its headings and the section (between
 * two headings of the same or a higher level) that holds `quote`; the start of
 * the lesson when there is no quote or it is not found.
 */
export function shortenLesson(text, quote = '') {
  if (text.length <= LONG_LESSON_CHARS) return { text, shortened: false };
  const lines = text.split('\n');
  let at = quote ? text.indexOf(quote.replace(/\s+/g, ' ').trim().slice(0, 200)) : -1;
  if (at < 0) at = 0;
  // The line of `at`, then up to the nearest heading before it.
  let pos = 0;
  let lineAt = 0;
  for (let i = 0; i < lines.length; i++) { if (pos + lines[i].length >= at) { lineAt = i; break; } pos += lines[i].length + 1; }
  let start = lineAt;
  while (start > 0 && !/^#{1,6} /.test(lines[start])) start--;
  const level = (/^(#{1,6}) /.exec(lines[start]) || [, '######'])[1].length;
  let end = lineAt + 1;
  while (end < lines.length && !(/^(#{1,6}) /.test(lines[end]) && /^(#{1,6}) /.exec(lines[end])[1].length <= level)) end++;
  let section = lines.slice(start, end).join('\n');
  if (section.length > LONG_LESSON_CHARS) section = clip(section, LONG_LESSON_CHARS);
  const outline = headingsOf(text).join('\n');
  return {
    text: `[Урокът е дълъг: тук са заглавията му и разделът, за който е въпросът.]\n\nЗаглавия:\n${outline}\n\nРазделът:\n${section}`,
    shortened: true,
  };
}

// --- The blocks ---------------------------------------------------------------------

/** Block {2}: the course (deterministic: the same course record → the same text). */
export function courseBlock(course) {
  const meta = course?.meta || {};
  const part = (name, value) => (typeof value === 'string' && value.trim() ? `<${name}>\n${neutralizeTags(clip(clean(value).trim(), LIMITS.courseFile))}\n</${name}>` : '');
  return [
    `Курс: ${neutralizeTags(clean(course?.title || course?.id || '').trim())}`,
    part('MISSION', meta.mission),
    part('NOTES', meta.notes),
    part('RESOURCES', meta.resources),
    part('GLOSSARY', meta.glossary),
  ].filter(Boolean).join('\n\n');
}

/** Block {3}: the lesson. */
export function lessonBlock(lesson, text) {
  const name = lesson?.kind === 'reference' ? 'Справочник' : 'Урок';
  const head = `${name} ${lesson?.number || ''}: ${clean(text.title || lesson?.title || '').trim()}`.replace(/\s+:/, ':');
  return `<LESSON>\n${neutralizeTags(head)}\n\n${neutralizeTags(text.text)}\n</LESSON>`;
}

/** The place of a thread: the quote, its paragraph and the path of headings (or "the lesson as a whole"). */
export function placeText({ quote = '', paragraph = '', path = [], lesson = null }) {
  const q = neutralizeTags(clean(clip(quote, LIMITS.quote)).trim());
  const p = neutralizeTags(clean(clip(paragraph, LIMITS.paragraph)).trim());
  const where = (Array.isArray(path) ? path : []).slice(0, LIMITS.pathItems)
    .map((s) => neutralizeTags(clean(clip(String(s ?? ''), LIMITS.pathItem)).replace(/\s+/g, ' ').trim())).filter(Boolean);
  const lines = [];
  if (q) {
    lines.push(`Избран текст: «${q}»`);
    if (p && p !== q) lines.push(`Абзацът: «${p}»`);
    if (where.length) lines.push(`Място в урока: ${where.join(' › ')}`);
  } else {
    lines.push(`Въпрос за ${lesson?.kind === 'reference' ? 'справочника' : 'урока'} като цяло.`);
  }
  return lines.join('\n');
}

/** The user's message: the quote, its paragraph, the path of headings, the question. */
export function questionText({ quote = '', paragraph = '', path = [], question = '', lesson = null, followUp = false }) {
  const ask = clean(clip(question, LIMITS.question)).trim();
  // T-023: a next question of a thread: only the question (the place is in the first turn).
  if (followUp) return `Въпрос: ${ask}`;
  return `${placeText({ quote, paragraph, path, lesson })}\n\nВъпрос: ${ask}`;
}

/** Pairs dropped at once when a thread outgrows LIMITS.history (T024-D2). */
export const HISTORY_STEP = 10;
/**
 * The thread so far as alternating turns (user first, an answer last), at
 * most LIMITS.history of them (T024-D2):
 * - the first pair (the quote, its paragraph and place) is always kept — a
 *   next question is only "Въпрос: …";
 * - older pairs after it are dropped HISTORY_STEP at a time, so the start of
 *   the thread stays the same byte for byte for HISTORY_STEP questions and its
 *   automatic cache is hit (D-017).
 */
export function historyWindow(history) {
  const turns = [];
  for (const t of (Array.isArray(history) ? history : [])) {
    const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
    const body = clean(clip(t?.text, role === 'assistant' ? LIMITS.answer : LIMITS.userTurn)).trim();
    if (!role || !body) continue;
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += `\n\n${body}`;
    else turns.push({ role, content: body });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop(); // an unanswered question is replaced
  const max = Math.max(2, LIMITS.history - (LIMITS.history % 2));
  if (turns.length <= max) return turns;
  const rest = (turns.length - 2) / 2; // pairs after the first
  const room = (max - 2) / 2;
  const drop = Math.ceil((rest - room) / HISTORY_STEP) * HISTORY_STEP;
  return [...turns.slice(0, 2), ...turns.slice(2 + 2 * Math.min(drop, rest))];
}

/**
 * The whole request of a question (D-047).
 * @param {{ rules: {text: string, version?: string}, course: object, lesson: object,
 *   text: {title: string, text: string}, quote?: string, paragraph?: string, path?: string[],
 *   question: string, history?: {role: 'user'|'assistant', text: string}[],
 *   model?: string, maxTokens?: number }} opts
 * @returns {{ model, maxTokens, system: object[], messages: object[], cacheControl: object|null, meta }}
 */
export function buildRequest({ rules, course, lesson, text, quote = '', paragraph = '', path = [], question, history = [], followUp = false, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS }) {
  if (!rules?.text) throw new Error('teacher rules missing');
  if (typeof question !== 'string' || !question.trim()) throw new Error('empty question');
  const lessonPart = shortenLesson(text.text, quote);
  const system = [
    { type: 'text', text: rules.text },
    { type: 'text', text: courseBlock(course), cache_control: { ...CACHE_1H } },
    { type: 'text', text: lessonBlock(lesson, { title: text.title, text: lessonPart.text }), cache_control: { ...CACHE_1H } },
  ];
  const turns = historyWindow(history);
  // T024-D2: the place of the thread is always in its first turn — also when the
  // first answer failed (the first kept turn is then a next question) or no
  // earlier answer is kept at all. Deterministic: the same prefix every time.
  const place = placeText({ quote, paragraph, path, lesson });
  if (turns.length && !turns[0].content.startsWith(`${place}\n\n`)) turns[0].content = `${place}\n\n${turns[0].content}`;
  const messages = [
    ...turns.map((t) => ({ role: t.role, content: [{ type: 'text', text: t.content }] })),
    { role: 'user', content: [{ type: 'text', text: questionText({ quote, paragraph, path, question, lesson, followUp: followUp && turns.length > 0 }) }] },
  ];
  return {
    model,
    maxTokens,
    system,
    messages,
    // D-017: the thread is cached automatically (5 min, after the 1 h blocks).
    cacheControl: turns.length ? { type: 'ephemeral' } : null,
    meta: { rulesVersion: rules.version || '', textVersion: TEXT_VERSION, shortened: lessonPart.shortened },
  };
}

/** "Покажи промпта" (D-047): the whole prompt as plain text, exactly what is sent. */
export function showPrompt(request) {
  const out = [`Модел: ${request.model} · най-много ${request.maxTokens} токена за отговора`];
  const names = ['Правила на учителя', 'Курсът', 'Урокът'];
  request.system.forEach((b, i) => {
    out.push('', `=== ${names[i] || `Системен блок ${i + 1}`}${b.cache_control ? ` (кеш ${b.cache_control.ttl === '1h' ? '1 час' : '5 мин'})` : ''} ===`, b.text);
  });
  for (const m of request.messages) {
    out.push('', `=== ${m.role === 'user' ? 'Ти' : 'Учителят'} ===`, m.content.map((c) => c.text).join('\n'));
  }
  return out.join('\n');
}

/**
 * Ask the teacher: the request of `opts` (see buildRequest; the rules and the
 * lesson text are loaded here), streamed; the cost is kept (src/usage.js).
 * Resolves { text, usage, costUSD, month, request } or rejects with a ClaudeError.
 * @param {{ apiKey: string, settings: object, course: object, lesson: object,
 *   quote?: string, paragraph?: string, path?: string[], question: string,
 *   history?: object[], signal?: AbortSignal, onText?: Function, fetchOptions?: object }} opts
 */
export async function askTeacher({ apiKey, settings = {}, course, lesson, quote, paragraph, path, question, history, followUp, signal, onText, retryWaits, idleTimeoutMs }) {
  const [rules, text] = await Promise.all([loadRules(), lessonText(lesson)]);
  const request = buildRequest({
    rules, course, lesson, text, quote, paragraph, path, question, history, followUp,
    model: settings.model || DEFAULT_MODEL, maxTokens: answerMaxTokens(settings.maxTokensAnswer),
  });
  const result = await streamMessage({
    apiKey, model: request.model, maxTokens: request.maxTokens, system: request.system, messages: request.messages,
    cacheControl: request.cacheControl, signal, onText,
    ...(retryWaits ? { retryWaits } : {}), ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
  });
  let month = null;
  try {
    month = await recordCall({ model: result.model, kind: 'answer', usage: result.usage, costUSD: result.costUSD });
  } catch (err) {
    console.warn('Cannot keep the cost of the answer:', err?.name || 'error');
  }
  return { text: result.text, usage: result.usage, costUSD: result.costUSD, stopReason: result.stopReason, model: result.model, month, request };
}

/** For "Покажи промпта" before sending: the request without sending it. */
export async function previewTeacher({ settings = {}, course, lesson, quote, paragraph, path, question, history, followUp }) {
  const [rules, text] = await Promise.all([loadRules(), lessonText(lesson)]);
  const request = buildRequest({
    rules, course, lesson, text, quote, paragraph, path, question, history, followUp,
    model: settings.model || DEFAULT_MODEL, maxTokens: answerMaxTokens(settings.maxTokensAnswer),
  });
  return { request, text: showPrompt(request) };
}
