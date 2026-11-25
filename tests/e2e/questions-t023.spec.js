// T-023 (developer, 0.17.0): questions to the teacher (D-047) — the UI.
// - the selection → "💬 Въпрос" next to "📝 Бележка" (in the strip, floating when the
//   strip is hidden / on a phone); "💬" in the strip: a question about the lesson
//   and the list of the questions;
// - the panel at the place of the note (landscape: a column right, portrait: at the
//   bottom, a phone: the whole window): the quote, the field, "Изпрати", "Покажи
//   промпта" (no request), the answer streamed as Markdown, the cost, "Отказ",
//   "Опитай пак", errors in Bulgarian, no key → "Настройки";
// - the thread: a next question with the history (the first user text byte for byte,
//   the automatic cache), kept in IndexedDB on an annotation (💬 next to the line),
//   opened again after a reload; delete with "Върни"; the eraser keeps the question;
// - security: nothing of a question / an answer is posted to the lesson; the lesson
//   cannot ask (made-up messages), cannot change the quote after the press, cannot
//   take the keys of the question field.
// NEVER a real request: api.anthropic.com is answered by page.route() (SSE); every
// other request leaving localhost is aborted and recorded. FAKE keys only (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });
test.use({ trace: 'off' });

const KEY = 'sk-ant-api03-FAKE-t023-2222222222-zz';
const API = /^https:\/\/api\.anthropic\.com\//;
const C = 'LRN-T23';

let problems;
let external;
let consoleAll;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  consoleAll = [];
  page.on('console', (m) => { consoleAll.push(m.text()); if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (!problems) return;
  expect(problems).toEqual([]);
  expect(external.filter((u) => !API.test(u))).toEqual([]);
  expect(consoleAll.join('\n')).not.toContain('FAKE');
});

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const FILL = Array.from({ length: 20 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
// A lesson that logs every message it gets (to see that no question / answer reaches it).
const SPY = `<script>addEventListener('message', (e) => { try { console.log('LM:' + JSON.stringify(e.data)); } catch (err) { /* */ } }, true);
window.__forge = () => { const t = setInterval(() => { parent.postMessage({ lrn: 1, type: 'lrn:selection', quote: { exact: 'ПОДМЕНЕН ЦИТАТ', prefix: '', suffix: '' }, position: { start: 1, end: 5 } }, '*');
  for (const type of ['lrn:ask', 'lrn:question', 'lrn:teacher', 'lrn:send']) parent.postMessage({ lrn: 1, type, question: 'ИЗМАМА', text: 'ИЗМАМА' }, '*'); }, 50); setTimeout(() => clearInterval(t), 3000); };
Object.defineProperty(window, '__off', { get() { const was = document.designMode; document.designMode = 'on'; const on = document.designMode === 'on'; document.designMode = was; return !on; } });
</script>`;
const BODY = `<h2>Обхват</h2><p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи.</p>
<h2>Задължения</h2><p id="p2">Производителят оценява рисковете през целия жизнен цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>${FILL}<input id="v1" aria-label="v1">${SPY}`;
const FILES = {
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи урок |\n`,
  'MISSION.md': '# Мисия\n\nИзмислена мисия за тест.\n',
  'GLOSSARY.md': '# Речник\n\n**Продукт** (product): измислено.\n',
  'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY),
};

async function start(page, { key = true } = {}) {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push(e.data); });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  const zip = asFile(`${C}.zip`, makeZip(toBytes(FILES), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: zip.name, bytes: [...zip.buffer] });
  expect(r).not.toMatch(/^ERROR/);
  if (key) await page.evaluate(async (k) => { const db = await import('./src/db.js'); await db.saveApiKey(k); }, KEY);
}
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page) {
  const hash = `#/c/${C}/read/0001`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
async function select(page, needle) {
  const frame = await lessonFrame(page);
  await page.evaluate(() => { window.__lrn = window.__lrn.filter((m) => m.type !== 'lrn:selection'); });
  await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      n.parentElement.scrollIntoView({ block: 'center' });
      return;
    }
    throw new Error(`not found: ${needle}`);
  }, needle);
  await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length), { timeout: 3000 }).toBeGreaterThan(0);
}

const panel = (page) => page.locator('[data-field="notes-panel"]');
const field = (page) => page.locator('[data-field="question-text"]');
const sendButton = (page) => page.locator('[data-action="question-send"]');
const answers = (page) => page.locator('[data-field="thread-log"] [data-role="assistant"]');
const threadMarks = (page) => page.locator('[data-field="notes-marks"] .notes-strip__mark--thread');

/** "💬 Въпрос" for the selection: in the strip, or floating (strip hidden / a phone). */
async function askButton(page) {
  const inStrip = page.locator('[data-action="new-question"]');
  const floating = page.locator('[data-action="new-question-quick"]');
  await expect(inStrip.or(floating).locator('visible=true')).toHaveCount(1, { timeout: 3000 });
  return (await inStrip.isVisible()) ? inStrip : floating;
}
async function askAbout(page, needle) {
  await select(page, needle);
  await (await askButton(page)).click();
  await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
  await expect(field(page)).toBeFocused();
}

/** An SSE body of the Messages API. */
const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const answerSse = (text, { stop = true, usage = { input_tokens: 1200, output_tokens: 60, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 } } = {}) => {
  const parts = [];
  for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7));
  return sse([
    ['message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ...parts.map((p) => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } }]),
    ['content_block_stop', { index: 0 }],
    ...(stop ? [['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } }], ['message_stop', {}]] : []),
  ]);
};
const CORS = { 'access-control-allow-origin': '*' };
/** Answer the API with `answer(request, n)`: { sse } | { status, json } | 'hang'. Returns the requests seen. */
async function mockApi(page, answer) {
  const seen = [];
  await page.route(API, async (route) => {
    const r = route.request();
    seen.push({ headers: await r.allHeaders(), raw: r.postData(), body: r.postData() ? JSON.parse(r.postData()) : null });
    const a = await answer(r, seen.length);
    if (a === 'hang') return new Promise(() => {});
    if (a.sse !== undefined) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: a.sse });
    return route.fulfill({ status: a.status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(a.json ?? {}) });
  });
  return seen;
}
/** A call of src/db.js in the page (no eval: the app's CSP has no 'unsafe-eval'). */
const db = (page, name, ...args) => page.evaluate(async ({ name, args }) => (await import('./src/db.js'))[name](...args), { name, args });
const liveThreads = async (page) => (await db(page, 'list', 'threads')).filter((t) => !t.deleted);
const messagesOf = async (page) => (await db(page, 'list', 'messages')).sort((a, b) => (a.id < b.id ? -1 : 1));
const userText = (req) => req.body.messages.at(-1).content.map((c) => c.text).join('');

// ---------------------------------------------------------------------------
test.describe('T023-A a question on selected text (both orientations)', () => {
  test('A1 "💬 Въпрос" next to "📝 Бележка" → the panel at the place of the note with the quote; "Покажи промпта" shows the whole prompt (no request); "Изпрати" → the answer as Markdown, its cost, 💬 at the line; the request: the key only in x-api-key, 3 system blocks, the quote and the question', async ({ page }, ti) => {
    await start(page);
    const seen = await mockApi(page, () => ({ sse: answerSse('Това е **важно**: производителят *оценява* рисковете.\n\n- първо\n- второ\n\n<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script> [линк](https://example.invalid/x) [лош](javascript:alert(1))') }));
    await openLesson(page);
    await select(page, 'оценява рисковете');
    // Both buttons are offered for the selection.
    const note = page.locator('[data-action="new-note"], [data-action="new-note-quick"]').locator('visible=true');
    await expect(note).toHaveCount(1);
    await (await askButton(page)).click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await expect(panel(page)).toHaveAttribute('data-layout', ti.project.name === 'tablet-portrait' ? 'bottom' : 'side');
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«оценява рисковете»');
    await expect(field(page)).toBeFocused();
    await field(page).pressSequentially('Какво значи това?');
    // "Покажи промпта": hidden at first; the whole prompt, no request.
    await expect(page.locator('[data-field="question-prompt"]')).toBeHidden();
    await page.locator('[data-action="question-prompt"]').click();
    const prompt = page.locator('[data-field="question-prompt"]');
    await expect(prompt).toContainText('=== Урокът (кеш 1 час) ===');
    await expect(prompt).toContainText('Избран текст: «оценява рисковете»');
    await expect(prompt).toContainText('Място в урока: Първи урок › Задължения');
    await expect(prompt).toContainText('Въпрос: Какво значи това?');
    expect(seen).toHaveLength(0);
    const shown = await prompt.textContent();
    await sendButton(page).click();
    await expect(answers(page)).toHaveCount(1);
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    const a = answers(page).first();
    await expect(a.locator('strong')).toHaveText('важно');
    await expect(a.locator('li')).toHaveCount(2);
    await expect(a.locator('img, script, [onerror]')).toHaveCount(0);
    await expect(a.locator('a')).toHaveCount(1);
    await expect(a.locator('a')).toHaveAttribute('target', '_blank');
    await expect(a.locator('a')).toHaveAttribute('rel', /noopener/);
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
    await expect(a.locator('[data-field="answer-cost"]')).toContainText('Цена на отговора: $');
    // The request.
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.raw).not.toContain(KEY);
    expect(req.body.system).toHaveLength(3);
    expect(req.body.system[2].text).toContain('<LESSON>');
    expect(userText(req)).toBe('Избран текст: «оценява рисковете»\nАбзацът: «Производителят оценява рисковете през целия жизнен цикъл.»\nМясто в урока: Първи урок › Задължения\n\nВъпрос: Какво значи това?');
    // "Покажи промпта" showed exactly what went (the same system and user text).
    expect(shown).toContain(req.body.system[2].text);
    expect(shown).toContain(userText(req));
    // Kept: a thread on an annotation without a colour; 💬 next to the line.
    const [t] = await liveThreads(page);
    expect(t).toMatchObject({ courseId: C, lessonId: `${C}/lesson:0001`, target: { type: 'lesson', id: `${C}/lesson:0001` }, quote: 'оценява рисковете' });
    expect(typeof t.annotationId).toBe('string');
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(threadMarks(page)).toHaveCount(1);
  });

  test('A2 the thread: a next question sends the history (the first user text byte for byte, the answer, cache_control on top); after a reload the 💬 opens the thread with both answers; ▲ / ▼ go between threads', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => ({ sse: answerSse(n === 1 ? 'Първи отговор.' : n === 2 ? 'Втори отговор.' : 'Трети отговор.') }));
    await openLesson(page);
    await askAbout(page, 'оценява рисковете');
    await field(page).pressSequentially('Първи въпрос?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(field(page)).toHaveAttribute('placeholder', 'Следващ въпрос…');
    await field(page).pressSequentially('А защо?');
    await page.keyboard.press('Control+Enter');
    await expect(answers(page)).toHaveCount(2);
    await expect(answers(page).nth(1)).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(second.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.body.messages[0].content[0].text).toBe(userText(first));
    expect(second.body.messages[1].content[0].text).toBe('Първи отговор.');
    expect(userText(second)).toBe('Въпрос: А защо?');
    expect(second.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(second.body.system)).toBe(JSON.stringify(first.body.system));
    // A second thread elsewhere.
    await page.locator('[data-action="close-notes-panel"]').click();
    await askAbout(page, 'Уязвимостите се докладват');
    await field(page).pressSequentially('Колко бързо?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    // After a reload.
    await openLesson(page);
    await expect(threadMarks(page)).toHaveCount(2);
    await threadMarks(page).first().click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«оценява рисковете»');
    await expect(page.locator('[data-field="thread-log"] [data-role="user"]')).toHaveText([/Първи въпрос\?/, /А защо\?/]);
    await expect(answers(page)).toHaveText([/Първи отговор\./, /Втори отговор\./]);
    await page.locator('[data-action="panel-next-note"]').click();
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«Уязвимостите се докладват»');
    await page.locator('[data-action="panel-prev-note"]').click();
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«оценява рисковете»');
    // A second "Въпрос" on exactly the same text opens the thread that is there.
    await page.locator('[data-action="close-notes-panel"]').click();
    await askAbout(page, 'оценява рисковете');
    await expect(answers(page)).toHaveCount(2);
    expect((await liveThreads(page)).length).toBe(2);
  });

  test('A3 "💬" in the strip: a question about the lesson as a whole (no quote) → its thread opens; the list of all questions of the lesson; a hidden strip offers "💬 Въпрос" next to its handle', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, () => ({ sse: answerSse('Урокът е за регламента.') }));
    await openLesson(page);
    await page.locator('[data-action="questions"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'questions');
    await expect(page.locator('[data-field="questions-empty"]')).toBeVisible();
    await expect(field(page)).toBeFocused();
    await field(page).pressSequentially('За какво е урокът?');
    await sendButton(page).click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await expect(page.locator('[data-field="question-quote"]')).toHaveAttribute('data-whole', 'true');
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(userText(seen[0])).toBe('Въпрос за урока като цяло.\n\nВъпрос: За какво е урокът?');
    const [t] = await liveThreads(page);
    expect(t.annotationId).toBeNull();
    await expect(page.locator('[data-field="questions-count"]')).toHaveText('1');
    await page.locator('[data-action="questions-back-to-list"]').click();
    await expect(page.locator('[data-field="threads-list"] [data-thread]')).toHaveCount(1);
    await expect(page.locator('[data-field="threads-list"]')).toContainText('За урока като цяло');
    await page.locator('[data-action="close-notes-panel"]').click();
    // The strip hidden: "💬 Въпрос" floats by the handle while text is selected.
    await page.locator('[data-action="hide-notes"]').click();
    await select(page, 'Уязвимостите');
    await expect(page.locator('[data-action="new-question-quick"]')).toBeVisible();
    await expect(page.locator('[data-action="new-question"]')).toBeHidden();
    await page.locator('[data-action="show-notes"]').click();
  });
});

// ---------------------------------------------------------------------------
test.describe('T023-B errors, "Отказ", "Опитай пак", the key (landscape)', () => {
  test.beforeEach(({}, ti) => { test.skip(ti.project.name !== 'tablet-landscape', 'the logic does not depend on the layout'); });

  test('B1 no key: nothing is sent, the panel says "Настройки" (a link) with the reminder that lessons never ask for the key; nothing is kept', async ({ page }) => {
    await start(page, { key: false });
    const seen = await mockApi(page, () => ({ sse: answerSse('x') }));
    await openLesson(page);
    await askAbout(page, 'оценява');
    await field(page).pressSequentially('Въпрос без ключ?');
    await sendButton(page).click();
    const note = page.locator('[data-field="question-no-key"]');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Уроците никога не искат API ключ');
    await expect(note.locator('a')).toHaveAttribute('href', '#/settings');
    expect(seen).toHaveLength(0);
    expect(await liveThreads(page)).toEqual([]);
    await expect(field(page)).toHaveValue('Въпрос без ключ?');
  });

  test('B2 an error of the API in Bulgarian (401: the key, a link to Настройки), never its own text; "Опитай пак" asks again into the same answer; a stream cut after some text keeps the text ("прекъснат") and "Опитай пак" sends the same history', async ({ page }) => {
    await start(page);
    let mode = '401';
    const seen = await mockApi(page, () => {
      if (mode === '401') return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'mock — never shown' } } };
      if (mode === 'cut') return { sse: answerSse('Половин отговор, който', { stop: false }) };
      return { sse: answerSse('Цял отговор.') };
    });
    await openLesson(page);
    await askAbout(page, 'оценява');
    await field(page).pressSequentially('Първи?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'error', { timeout: 10000 });
    const err = page.locator('[data-field="answer-error"]');
    await expect(err).toContainText('Ключът е невалиден (401)');
    await expect(err).not.toContainText('never shown');
    await expect(err.locator('a')).toHaveAttribute('href', '#/settings');
    mode = 'ok';
    await page.locator('[data-action="question-retry"]').click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(answers(page)).toHaveCount(1);
    expect(userText(seen[1])).toBe(userText(seen[0]));
    // A cut stream.
    mode = 'cut';
    await field(page).pressSequentially('Втори?');
    await sendButton(page).click();
    await expect(answers(page).nth(1)).toHaveAttribute('data-status', 'error', { timeout: 10000 });
    await expect(answers(page).nth(1).locator('[data-field="answer-text"]')).toHaveText('Половин отговор, който');
    await expect(answers(page).nth(1).locator('[data-field="answer-error"]')).toContainText('Показано е полученото дотук');
    const msgs = await messagesOf(page);
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', status: 'error', interrupted: true, content: 'Половин отговор, който' });
    mode = 'ok';
    await page.locator('[data-action="question-retry"]').click();
    await expect(answers(page).nth(1)).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(JSON.stringify(seen.at(-1).body.messages)).toBe(JSON.stringify(seen.at(-2).body.messages));
    expect(seen.at(-1).body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // No cost for the failed calls: one record per finished answer.
    const usage = await db(page, 'usageBetween');
    expect(usage).toHaveLength(2);
  });

  test('B3 "Отказ" while the API does not answer: the answer stops ("Отказано"), nothing is charged; the panel can be closed while an answer comes and the answer is kept', async ({ page }) => {
    await start(page);
    let hang = true;
    await mockApi(page, () => (hang ? 'hang' : { sse: answerSse('Отговор, докато панелът е затворен.') }));
    await openLesson(page);
    await askAbout(page, 'оценява');
    await field(page).pressSequentially('Ще чакам?');
    await sendButton(page).click();
    await expect(page.locator('[data-action="question-cancel"]')).toBeVisible();
    await expect(sendButton(page)).toBeDisabled();
    await page.locator('[data-action="question-cancel"]').click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'error', { timeout: 5000 });
    await expect(page.locator('[data-field="answer-error"]')).toContainText('Отказано');
    expect(await db(page, 'usageBetween')).toEqual([]);
    hang = false;
    await page.locator('[data-action="question-retry"]').click();
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect.poll(async () => (await messagesOf(page)).at(-1).status, { timeout: 10000 }).toBe('done');
    await threadMarks(page).first().click();
    await expect(answers(page).first()).toContainText('Отговор, докато панелът е затворен.');
  });

  test('B4 the threshold of the month (D-022): over it, the panel warns before and after an answer; the user can still ask', async ({ page }) => {
    await start(page);
    await page.evaluate(async () => { const db = await import('./src/db.js'); await db.saveSettings({ monthlyBudgetUSD: 0.01 }); await db.logUsage({ model: 'claude-sonnet-5-5', kind: 'answer', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, estCostUSD: 0.5 }); });
    await mockApi(page, () => ({ sse: answerSse('Отговор.') }));
    await openLesson(page);
    await askAbout(page, 'оценява');
    await expect(page.locator('[data-field="question-budget"]')).toContainText('над прага от $0.01');
    await field(page).pressSequentially('Все пак?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(page.locator('[data-field="question-budget"]')).toBeVisible();
  });

  test('B5 delete a thread → "Върни" brings it back (its 💬 too); the eraser over the text of a question on a mark takes only the colour, the question stays', async ({ page }) => {
    await start(page);
    await mockApi(page, () => ({ sse: answerSse('Отговор.') }));
    await openLesson(page);
    await askAbout(page, 'Уязвимостите се докладват');
    await field(page).pressSequentially('Кога?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await page.locator('[data-action="delete-thread"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('[data-field="notes-undo"]')).toContainText('Въпросът е изтрит.');
    expect(await liveThreads(page)).toEqual([]);
    await expect(threadMarks(page)).toHaveCount(0);
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await expect(answers(page)).toHaveCount(1);
    expect((await liveThreads(page)).length).toBe(1);
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(threadMarks(page)).toHaveCount(1);
    // A mark with a question: the eraser keeps the annotation and the question.
    await select(page, 'оценява рисковете');
    await page.locator('[data-field="mark-tools"] [data-color="green"]').click();
    await expect.poll(async () => (await db(page, 'list', 'annotations')).filter((a) => a.color === 'green').length).toBe(1);
    await page.keyboard.press('Escape');
    const green = (await db(page, 'list', 'annotations')).find((a) => a.color === 'green');
    // A tap on the mark → its card → "💬 Въпрос" → a thread on the mark.
    await page.evaluate(() => { /* close any panel */ });
    const frame = await lessonFrame(page);
    const rel = await frame.evaluate(() => { const p = document.getElementById('p2'); const r = document.createRange(); r.selectNodeContents(p.firstChild); const b = r.getClientRects()[0]; return { x: b.left + 120, y: b.top + b.height / 2 }; });
    const box = await page.locator('iframe.lesson-frame').boundingBox();
    // T-077 (T042-S1): a tap in the lesson opens a card only after a clean gesture (5 s after a press in the app).
    await page.waitForTimeout(5600);
    await page.mouse.click(box.x + rel.x, box.y + rel.y);
    await expect(panel(page)).toHaveAttribute('data-mode', 'mark');
    await page.locator('[data-action="ask-about-mark"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await field(page).pressSequentially('За маркировката?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect((await liveThreads(page)).map((t) => t.annotationId)).toContain(green.id);
    await page.locator('[data-action="close-notes-panel"]').click();
    await page.locator('[data-field="mark-tools"] [data-tool="eraser"]').click();
    const b2 = await page.locator('iframe.lesson-frame').boundingBox();
    const r2 = await frame.evaluate(() => { const p = document.getElementById('p2'); const r = document.createRange(); r.selectNodeContents(p.firstChild); const b = r.getClientRects()[0]; return { x: b.left + 4, y: b.top + b.height / 2 }; });
    await page.mouse.move(b2.x + r2.x, b2.y + r2.y);
    await page.mouse.down();
    await page.mouse.move(b2.x + r2.x + 300, b2.y + r2.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => { const a = await db(page, 'get', 'annotations', green.id); return a ? String(a.color) : 'gone'; }).toBe('null');
    expect((await db(page, 'get', 'annotations', green.id)).deleted).toBe(false);
    expect((await liveThreads(page)).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
test.describe('T023-S the lesson cannot reach the questions', () => {
  test('S1 nothing of a question or an answer is posted to the lesson; the lesson cannot start a question (made-up lrn:ask…), cannot change the quote after the press (forged lrn:selection), cannot take the keys of the question field (the guard: designMode refused while it is focused)', async ({ page }) => {
    await start(page);
    const lessonHeard = [];
    page.on('console', (m) => { if (m.text().startsWith('LM:')) lessonHeard.push(m.text()); });
    const seen = await mockApi(page, () => ({ sse: answerSse('ОТГОВОР-ТАЙНА-777') }));
    const frame = await openLesson(page);
    await askAbout(page, 'оценява рисковете');
    // The guard holds the keys while the question field is focused.
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(true);
    await frame.evaluate(() => window.__forge());
    await field(page).pressSequentially('ВЪПРОС-ТАЙНА-555');
    await page.waitForTimeout(600);
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«оценява рисковете»');
    await expect(field(page)).toHaveValue('ВЪПРОС-ТАЙНА-555');
    expect(seen).toHaveLength(0);
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(seen).toHaveLength(1);
    expect(userText(seen[0])).toContain('«оценява рисковете»');
    expect(userText(seen[0])).not.toContain('ПОДМЕНЕН');
    await page.waitForTimeout(3000); // the forging ends
    expect(seen).toHaveLength(1);
    const heard = lessonHeard.join('\n');
    expect(heard).not.toContain('ТАЙНА');
    expect(heard).not.toContain('FAKE');
    // The lesson's own document has none of it either.
    const inLesson = await frame.evaluate(() => document.documentElement.outerHTML);
    expect(inLesson).not.toContain('ТАЙНА');
    // Out of the field: the lesson is live again.
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
test.describe('T023-P a phone (360 × 800)', () => {
  test.beforeEach(({}, ti) => { test.skip(ti.project.name !== 'tablet-landscape', 'one window size'); });
  test('P1 a phone: "💬 Въпрос" floats for the selection, the thread is over the whole window, ✕ back to the lesson; "💬" floats for a question about the lesson', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await start(page);
    await mockApi(page, () => ({ sse: answerSse('Кратък отговор.') }));
    await openLesson(page);
    await select(page, 'оценява');
    await expect(page.locator('[data-action="new-question-quick"]')).toBeVisible();
    await page.locator('[data-action="new-question-quick"]').click();
    await expect(panel(page)).toHaveAttribute('data-layout', 'full');
    const box = await panel(page).boundingBox();
    expect(box.width).toBeGreaterThan(340);
    await field(page).pressSequentially('Телефон?');
    await sendButton(page).click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(threadMarks(page)).toHaveCount(1);
    await expect(page.locator('[data-action="questions-phone"]')).toBeVisible();
    await page.locator('[data-action="questions-phone"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'questions');
    await expect(page.locator('[data-field="threads-list"] [data-thread]')).toHaveCount(1);
  });
});
