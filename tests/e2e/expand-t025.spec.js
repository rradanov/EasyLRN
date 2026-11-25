// T-025 (developer, 0.19.0): "Развий ми го" — additional topics (D-048, D-006, D-013).
// - the selection (the lesson, a topic, an answer of the teacher) → "🌱 Развий ми го"
//   next to "📝 Бележка" / "💬 Въпрос"; the topic in the panel at the place of the
//   note (landscape: a column right, portrait: at the bottom, a phone: the whole
//   window), the trail "Урок 0001 › Тема › Подтема" and back;
// - the request: the same 3 system blocks as a question (the cache), the place, the
//   trail, the instructions of prompts/expand.md (D-048: no test, resources);
//   streamed Markdown through DOMPurify, https links outside only, the cost;
//   "Отказ", errors, "Опитай пак", no key → "Настройки" (nothing is made);
// - kept: a subtopic on an annotation (🌱 next to the line), the tree parent → child,
//   the list of the topics, delete with "Върни" (the topics below it too);
// - in a topic: marks with the tools, notes, questions and "Развий ми го" again;
// - security: the lesson gets nothing of a topic, cannot start one, cannot read one.
// NEVER a real request: api.anthropic.com is answered by page.route() (SSE); every
// other request leaving localhost is aborted and recorded. FAKE keys only (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });
test.use({ trace: 'off' });

const KEY = 'sk-ant-api03-FAKE-t025-5555555555-zz';
const API = /^https:\/\/api\.anthropic\.com\//;
const C = 'LRN-T25';

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
// A lesson that logs every message it gets (nothing of a topic may reach it) and can forge messages.
const SPY = `<script>addEventListener('message', (e) => { try { console.log('LM:' + JSON.stringify(e.data)); } catch (err) { /* */ } }, true);
window.__forge = () => { const t = setInterval(() => {
  for (const type of ['lrn:expand', 'lrn:topic', 'lrn:subtopic', 'lrn:develop', 'lrn:ask']) parent.postMessage({ lrn: 1, type, quote: 'ИЗМАМА', text: 'ИЗМАМА' }, '*'); }, 50); setTimeout(() => clearInterval(t), 2000); };
</script>`;
const BODY = `<h2>Обхват</h2><p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи.</p>
<h2>Задължения</h2><p id="p2">Производителят оценява рисковете през целия жизнен цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>${FILL}${SPY}`;
const FILES = {
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи урок |\n`,
  'MISSION.md': '# Мисия\n\nИзмислена мисия за тест.\n',
  'RESOURCES.md': '# Ресурси\n\n- [Измислен регламент](https://example.invalid/reg)\n',
  'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY),
};

const TOPIC_MD = `# Оценка на риска

## Защо ти трябва
Оценката на риска е основата на съответствието.

## Обяснение
Производителят систематично преглежда заплахите през целия жизнен цикъл на продукта.

## Регламентът казва / Комисията тълкува
**Регламентът казва:** измислен член 13.

## Пример
Пример с измислен рутер и неговите актуализации.

## Ресурси за самообучение
- [Измислен регламент](https://example.invalid/reg) — текстът.
- [лош](javascript:alert(1)) и [файл](data:text/html,x)
<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>

## Източници
Урокът и RESOURCES.`;
const CHILD_MD = `# Жизнен цикъл

## Защо ти трябва
Жизненият цикъл определя колко дълго има задължения.

## Обяснение
Подтемата обяснява периода на поддръжка.

## Пример
Пет години актуализации.

## Ресурси за самообучение
- Измислен наръчник — без линк.

## Източници
Темата.`;

async function start(page, { key = true, files = FILES } = {}) {
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
  const zip = asFile(`${C}.zip`, makeZip(toBytes(files), { root: C }));
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
/** Select text inside a document of the app in the panel (a topic, an answer). */
async function selectInApp(page, rootSelector, needle) {
  await page.evaluate(({ rootSelector, needle }) => {
    const root = document.querySelector(rootSelector);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
  }, { rootSelector, needle });
  await expect(page.locator('[data-field="doc-selection"]')).toBeVisible();
}

const panel = (page) => page.locator('[data-field="notes-panel"]');
const topicDoc = (page) => page.locator('[data-field="topic-doc"] [data-field="app-doc-text"]');
const topicMarks = (page) => page.locator('[data-field="notes-marks"] .notes-strip__mark--topic');
const TOPIC_TEXT = '[data-field="topic-doc"] [data-field="app-doc-text"]';

/** "🌱 Развий" for the selection: in the strip, or floating (strip hidden / a phone). */
async function expandButton(page) {
  const inStrip = page.locator('[data-action="new-topic"]');
  const floating = page.locator('[data-action="new-topic-quick"]');
  await expect(inStrip.or(floating).locator('visible=true')).toHaveCount(1, { timeout: 3000 });
  return (await inStrip.isVisible()) ? inStrip : floating;
}
async function expand(page, needle) {
  await select(page, needle);
  await (await expandButton(page)).click();
  await expect(panel(page)).toHaveAttribute('data-mode', 'topic');
}
const done = (page) => expect(panel(page)).toHaveAttribute('data-topic-status', 'done', { timeout: 10000 });

/** An SSE body of the Messages API. */
const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const answerSse = (text, { stop = true, usage = { input_tokens: 1200, output_tokens: 600, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 } } = {}) => {
  const parts = [];
  for (let i = 0; i < text.length; i += 9) parts.push(text.slice(i, i + 9));
  return sse([
    ['message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ...parts.map((p) => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } }]),
    ['content_block_stop', { index: 0 }],
    ...(stop ? [['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 600 } }], ['message_stop', {}]] : []),
  ]);
};
const CORS = { 'access-control-allow-origin': '*' };
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
const db = (page, name, ...args) => page.evaluate(async ({ name, args }) => (await import('./src/db.js'))[name](...args), { name, args });
const liveTopics = async (page) => (await db(page, 'list', 'subtopics')).filter((t) => !t.deleted).sort((a, b) => (a.id < b.id ? -1 : 1));
const userText = (req) => req.body.messages.at(-1).content.map((c) => c.text).join('');

// ---------------------------------------------------------------------------
test.describe('T025-A a topic of the lesson (both orientations)', () => {
  test('A1 "🌱 Развий" next to "📝" / "💬" → the topic at the place of the note, streamed as Markdown (DOMPurify, https only, outside), its cost, the links note; the request: the key only in x-api-key, the 3 system blocks of a question, the place, the instructions (D-048); kept with 🌱 at the line, opened again after a reload; the trail and back', async ({ page }, ti) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => ({ sse: answerSse(n === 1 ? TOPIC_MD : 'Отговор.') }));
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await expect(page.locator('[data-action="new-note"], [data-action="new-note-quick"]').locator('visible=true')).toHaveCount(1);
    await expect(page.locator('[data-action="new-question"], [data-action="new-question-quick"]').locator('visible=true')).toHaveCount(1);
    await (await expandButton(page)).click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topic');
    await expect(panel(page)).toHaveAttribute('data-layout', ti.project.name === 'tablet-portrait' ? 'bottom' : 'side');
    await expect(page.locator('[data-field="topic-quote"]')).toHaveText('«оценява рисковете»');
    await done(page);
    await expect(page.locator('#notes-panel-title')).toHaveText('Оценка на риска');
    const body = topicDoc(page);
    await expect(body.locator('h3')).toHaveText(['Защо ти трябва', 'Обяснение', 'Регламентът казва / Комисията тълкува', 'Пример', 'Ресурси за самообучение', 'Източници']);
    await expect(body.locator('img, script, [onerror]')).toHaveCount(0);
    await expect(body.locator('a')).toHaveCount(1);
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.invalid/reg');
    await expect(body.locator('a')).toHaveAttribute('target', '_blank');
    await expect(body.locator('a')).toHaveAttribute('rel', /noopener/);
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
    await expect(page.locator('[data-field="topic-cost"]')).toContainText('Цена на темата: $');
    await expect(page.locator('[data-field="topic-links-note"]')).toContainText('провери ги');
    await expect(page.locator('[data-field="topic-trail"]')).toHaveText(/Урок 0001\s*›\s*Оценка на риска/);
    // The request.
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.raw).not.toContain(KEY);
    expect(req.body.system).toHaveLength(3);
    expect(req.body.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(req.body.system[2].text).toContain('<LESSON>');
    expect(req.body.max_tokens).toBe(3000);
    const u = userText(req);
    expect(u).toMatch(/^Избран текст: «оценява рисковете»\nАбзацът: «Производителят оценява рисковете през целия жизнен цикъл\.»\nМясто в урока: Първи урок › Задължения\n\nПът на темите: Урок 0001\n\nЗадача: „Развий ми го“/);
    expect(u).toContain('## Ресурси за самообучение');
    expect(u).toContain('Никога не измисляй адреси');
    expect(u).not.toContain('<!--');
    // Kept: a subtopic on an annotation without a colour of the lesson; its cost as a "subtopic".
    const [t] = await liveTopics(page);
    expect(t).toMatchObject({ courseId: C, lessonId: `${C}/lesson:0001`, rootLessonId: `${C}/lesson:0001`, depth: 1, parent: { type: 'lesson', id: `${C}/lesson:0001` }, quote: 'оценява рисковете', status: 'done', title: 'Оценка на риска', kind: 'задълбочаване' });
    expect(t.content).toBe(TOPIC_MD);
    const ann = (await db(page, 'list', 'annotations')).find((a) => a.id === t.annotationId);
    expect(ann).toMatchObject({ color: null, target: { type: 'lesson', id: `${C}/lesson:0001` } });
    const usage = await db(page, 'list', 'usage');
    expect(usage.map((x) => x.kind)).toEqual(['subtopic']);
    // 🌱 next to the line; after a reload it opens the topic (no new request).
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(topicMarks(page)).toHaveCount(1);
    await openLesson(page);
    await expect(topicMarks(page)).toHaveCount(1);
    await topicMarks(page).first().click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topic');
    await expect(topicDoc(page)).toContainText('систематично преглежда заплахите');
    expect(seen).toHaveLength(1);
    // A question afterwards: the same system blocks (the cache is shared).
    await page.locator('[data-action="topic-back"]').click();
    await expect(panel(page)).toBeHidden();
    await select(page, 'Уязвимостите се докладват');
    await page.locator('[data-action="new-question"], [data-action="new-question-quick"]').locator('visible=true').click();
    await page.locator('[data-field="question-text"]').pressSequentially('Кога?');
    await page.locator('[data-action="question-send"]').click();
    await expect(page.locator('[data-field="thread-log"] [data-role="assistant"]').first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(JSON.stringify(seen[1].body.system)).toBe(JSON.stringify(seen[0].body.system));
    // "Развий ми го" again on exactly the same place opens the topic (no second request).
    await page.locator('[data-action="close-notes-panel"]').click();
    await select(page, 'оценява рисковете');
    await (await expandButton(page)).click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topic');
    await expect(topicDoc(page)).toContainText('систематично преглежда заплахите');
    expect(seen).toHaveLength(2);
  });

  test('A2 a topic of a topic (a tree): a selection in the topic → the bar 🌱 / 📝 / 💬 → the subtopic with the trail "Урок 0001 › Оценка на риска › Жизнен цикъл"; its request has the text of the parent topic and the trail; the crumb goes back; 🌱 next to the line in the parent and "Теми от тази тема"', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => ({ sse: answerSse(n === 1 ? TOPIC_MD : CHILD_MD) }));
    await openLesson(page);
    await expand(page, 'оценява рисковете');
    await done(page);
    await selectInApp(page, TOPIC_TEXT, 'жизнен цикъл на продукта');
    await expect(page.locator('[data-action="doc-expand"]')).toBeVisible();
    await expect(page.locator('[data-action="doc-note"]')).toBeVisible();
    await expect(page.locator('[data-action="doc-ask"]')).toBeVisible();
    await page.locator('[data-action="doc-expand"]').click();
    await expect.poll(() => seen.length).toBe(2);
    await done(page);
    await expect(page.locator('#notes-panel-title')).toHaveText('Жизнен цикъл');
    await expect(page.locator('[data-field="topic-trail"]')).toHaveText(/Урок 0001\s*›\s*Оценка на риска\s*›\s*Жизнен цикъл/);
    const u = userText(seen[1]);
    expect(u).toContain('Избран текст: «жизнен цикъл на продукта»');
    expect(u).toContain('Абзацът: «Производителят систематично преглежда заплахите през целия жизнен цикъл на продукта.»');
    expect(u).toContain('Място в урока: Обяснение');
    expect(u).toContain('Текстът е избран в допълнителната тема „Оценка на риска“:\n<PARENT>\n# Оценка на риска');
    expect(u).toContain('\n</PARENT>\n\nПът на темите: Урок 0001 › Оценка на риска\n\nЗадача:');
    // The parent's own script / img are neutralised in the prompt as material.
    expect(u).toContain('<\\/script>');
    expect(JSON.stringify(seen[1].body.system)).toBe(JSON.stringify(seen[0].body.system));
    const [parent, child] = await liveTopics(page);
    expect(child).toMatchObject({ parent: { type: 'subtopic', id: parent.id }, depth: 2, rootLessonId: `${C}/lesson:0001` });
    const ann = (await db(page, 'list', 'annotations')).find((a) => a.id === child.annotationId);
    expect(ann.target).toEqual({ type: 'subtopic', id: parent.id });
    // Back by the crumb; the parent has a 🌱 at the line and lists the topic.
    await page.locator('[data-action="topic-crumb"][data-crumb="subtopic"]').click();
    await expect(page.locator('#notes-panel-title')).toHaveText('Оценка на риска');
    await expect(page.locator('[data-field="topic-doc"] [data-icon="topic"]')).toHaveCount(1);
    await expect(page.locator('[data-field="topic-children"] li[data-topic]')).toHaveCount(1);
    await page.locator('[data-field="topic-doc"] [data-icon="topic"]').click();
    await expect(page.locator('#notes-panel-title')).toHaveText('Жизнен цикъл');
    await page.locator('[data-action="topic-back"]').click();
    await expect(page.locator('#notes-panel-title')).toHaveText('Оценка на риска');
    // The list of the topics: a tree.
    await page.locator('[data-action="close-notes-panel"]').click();
    await page.locator('[data-action="topics"], [data-action="topics-phone"]').locator('visible=true').first().click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topics');
    await expect(page.locator('[data-field="topics-tree"] [data-topic]')).toHaveCount(2);
    await expect(page.locator('[data-field="topics-tree"] [data-topic][data-depth="1"]')).toHaveCount(1);
  });
});

test.describe('T025-B in a topic, errors, delete (landscape)', () => {
  test.beforeEach(({}, ti) => { test.skip(ti.project.name !== 'tablet-landscape', 'one orientation'); });

  test('B1 the tools in a topic: the marker over its text marks (an annotation on the topic, painted with the Highlight API), the pencil underlines, the eraser takes them; without a tool the text selects', async ({ page }) => {
    await start(page);
    await mockApi(page, () => ({ sse: answerSse(TOPIC_MD) }));
    await openLesson(page);
    await expand(page, 'оценява рисковете');
    await done(page);
    const [t] = await liveTopics(page);
    const at = (needle) => page.evaluate(({ sel, needle }) => {
      const root = document.querySelector(sel);
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        n.parentElement.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + needle.length);
        const b = r.getClientRects()[0];
        return { x1: b.left + 2, x2: b.right - 2, y: b.top + b.height / 2 };
      }
      return null;
    }, { sel: TOPIC_TEXT, needle });
    const draw = async (needle) => {
      const p = await at(needle);
      await page.mouse.move(p.x1, p.y);
      await page.mouse.down();
      await page.mouse.move((p.x1 + p.x2) / 2, p.y, { steps: 4 });
      await page.mouse.move(p.x2, p.y, { steps: 4 });
      await page.mouse.up();
    };
    const topicAnns = async () => (await db(page, 'list', 'annotations')).filter((a) => !a.deleted && a.target.type === 'subtopic' && a.target.id === t.id);
    await page.locator('[data-field="mark-tools"] [data-tool="marker"]').click();
    await draw('основата на');
    await expect.poll(async () => (await topicAnns()).length).toBe(1);
    const [m] = await topicAnns();
    expect(m).toMatchObject({ style: 'highlight', anchorState: 'ok' });
    expect(m.selector.quote.exact).toMatch(/^основата на/); // whole words
    expect(m.color).toBeTruthy();
    expect(await page.evaluate((c) => CSS.highlights.has(`lrn-app-${c}`), m.color)).toBe(true);
    await page.locator('[data-field="mark-tools"] [data-tool="pencil"]').click();
    await draw('измислен рутер');
    await expect.poll(async () => (await topicAnns()).length).toBe(2);
    const ul = (await topicAnns()).find((a) => a.style === 'underline');
    expect(ul.selector.quote.exact).toContain('измислен рутер');
    expect(await page.evaluate((c) => CSS.highlights.has(`lrn-app-ul-${c}`), ul.color)).toBe(true);
    await page.locator('[data-field="mark-tools"] [data-tool="eraser"]').click();
    await draw('основата на');
    await expect.poll(async () => (await topicAnns()).length).toBe(1);
    // The lesson got none of it.
    expect(consoleAll.filter((l) => l.startsWith('LM:') && /съответствието|рутер/.test(l))).toEqual([]);
  });

  test('B2 notes in a topic: the selection → "📝 Бележка" → a field in "Бележки в темата", saved by itself on an annotation of the topic; 📝 next to the line; after a reload it is there; "Изтрий" → "Върни"', async ({ page }) => {
    await start(page);
    await mockApi(page, () => ({ sse: answerSse(TOPIC_MD) }));
    await openLesson(page);
    await expand(page, 'оценява рисковете');
    await done(page);
    const [t] = await liveTopics(page);
    await selectInApp(page, TOPIC_TEXT, 'измислен рутер');
    await page.locator('[data-action="doc-note"]').click();
    const ta = page.locator('[data-field="topic-note-text"]').first();
    await expect(ta).toBeFocused();
    await ta.pressSequentially('Моя бележка в темата.');
    await expect.poll(async () => (await db(page, 'list', 'notes')).filter((n) => !n.deleted).map((n) => n.body)).toEqual(['Моя бележка в темата.']);
    const [note] = (await db(page, 'list', 'notes')).filter((n) => !n.deleted);
    const ann = (await db(page, 'list', 'annotations')).find((a) => a.id === note.annotationId);
    expect(ann.target).toEqual({ type: 'subtopic', id: t.id });
    expect(note.topicId).toBe(t.id);
    await expect(page.locator('[data-field="topic-doc"] [data-icon="note"]')).toHaveCount(1);
    // Not a note of the lesson: the lesson's list has none.
    await expect(page.locator('[data-field="notes-count"]')).toHaveText('0');
    await openLesson(page);
    await topicMarks(page).first().click();
    await expect(page.locator('[data-field="topic-note-text"]')).toHaveValue('Моя бележка в темата.');
    await page.locator('[data-action="delete-topic-note"]').click();
    await expect(page.locator('[data-field="notes-undo"]')).toContainText('Бележката е изтрита.');
    await expect(page.locator('[data-field="topic-note-text"]')).toHaveCount(0);
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect(page.locator('[data-field="topic-note-text"]')).toHaveValue('Моя бележка в темата.');
  });

  test('B3 a question in a topic: the selection → "💬 Въпрос" → a thread with "← Към темата"; its first text has the topic in <PARENT>; listed in "Въпроси в темата", not among the questions of the lesson', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => ({ sse: answerSse(n === 1 ? TOPIC_MD : 'Отговор за темата.') }));
    await openLesson(page);
    await expand(page, 'оценява рисковете');
    await done(page);
    const [t] = await liveTopics(page);
    await selectInApp(page, TOPIC_TEXT, 'измислен рутер');
    await page.locator('[data-action="doc-ask"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await expect(page.locator('[data-action="thread-back-to-topic"]')).toBeVisible();
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«измислен рутер»');
    await page.locator('[data-field="question-text"]').pressSequentially('Кой рутер?');
    await page.locator('[data-action="question-send"]').click();
    await expect(page.locator('[data-field="thread-log"] [data-role="assistant"]').first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    const u = userText(seen[1]);
    expect(u).toContain('Избран текст: «измислен рутер»');
    expect(u).toContain('Текстът е избран в допълнителната тема „Оценка на риска“:\n<PARENT>\n');
    expect(u).toMatch(/\n\nВъпрос: Кой рутер\?$/);
    const th = (await db(page, 'list', 'threads')).find((x) => !x.deleted);
    expect(th).toMatchObject({ topicId: t.id, target: { type: 'subtopic', id: t.id } });
    await page.locator('[data-action="thread-back-to-topic"]').click();
    await expect(page.locator('[data-field="topic-threads"] [data-thread]')).toHaveCount(1);
    await expect(page.locator('[data-field="topic-doc"] [data-icon="thread"]')).toHaveCount(1);
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(page.locator('[data-field="questions-count"]')).toHaveText('');
  });

  test('B4 "Развий ми го" on an answer of the teacher: the selection in the answer → 🌱 → a topic whose parent is the message; the answer lists it; the trail has the question', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => ({ sse: answerSse(n === 1 ? 'Учителят обяснява прага на съществено въздействие.' : TOPIC_MD) }));
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await page.locator('[data-action="new-question"]').click();
    await page.locator('[data-field="question-text"]').pressSequentially('Какво е праг?');
    await page.locator('[data-action="question-send"]').click();
    const answer = page.locator('[data-field="thread-log"] [data-role="assistant"]').first();
    await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await selectInApp(page, '[data-field="thread-log"] [data-doc-type="message"]', 'прага на съществено въздействие');
    await expect(page.locator('[data-action="doc-note"]')).toBeHidden();
    await page.locator('[data-action="doc-expand"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topic');
    await done(page);
    const u = userText(seen[1]);
    expect(u).toContain('Избран текст: «прага на съществено въздействие»');
    expect(u).toContain('Текстът е избран в отговора на учителя „Какво е праг?“:\n<PARENT>\nУчителят обяснява');
    expect(u).toContain('Път на темите: Урок 0001 › Въпрос: Какво е праг?');
    const [t] = await liveTopics(page);
    const msg = (await db(page, 'list', 'messages')).find((m) => m.role === 'assistant');
    expect(t.parent).toEqual({ type: 'message', id: msg.id });
    await expect(page.locator('[data-field="topic-trail"]')).toContainText('Въпрос: Какво е праг?');
    await page.locator('[data-action="topic-back"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await expect(page.locator('[data-field="answer-topics"] [data-topic]')).toHaveCount(1);
  });

  test('B5 no key: nothing is sent and nothing is made, the panel shows the way to "Настройки"; 401 → the Bulgarian text with "Настройки" and "Опитай пак" (it works); "Отказ" stops a topic coming in (kept as "Отказано")', async ({ page }) => {
    await start(page, { key: false });
    let mode = 'ok';
    const seen = await mockApi(page, () => (mode === '401' ? { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } } : mode === 'hang' ? 'hang' : { sse: answerSse(TOPIC_MD) }));
    await openLesson(page);
    await expand(page, 'оценява рисковете');
    await expect(page.locator('[data-field="topic-no-key"]')).toContainText('Няма API ключ');
    await expect(page.locator('[data-field="topic-no-key"] a[href$="#/settings"]')).toHaveCount(1);
    expect(seen).toHaveLength(0);
    expect(await liveTopics(page)).toEqual([]);
    await page.evaluate(async (k) => { const m = await import('./src/db.js'); await m.saveApiKey(k); }, KEY);
    mode = '401';
    await page.locator('[data-action="close-notes-panel"]').click();
    await expand(page, 'оценява рисковете');
    await expect(panel(page)).toHaveAttribute('data-topic-status', 'error', { timeout: 10000 });
    await expect(page.locator('[data-field="topic-error"]')).toContainText(/ключ/i);
    await expect(page.locator('[data-field="topic-error"] a[href$="#/settings"]')).toHaveCount(1);
    mode = 'ok';
    await page.locator('[data-action="topic-retry"]').click();
    await done(page);
    await expect(page.locator('#notes-panel-title')).toHaveText('Оценка на риска');
    // "Отказ".
    mode = 'hang';
    await page.locator('[data-action="close-notes-panel"]').click();
    await expand(page, 'Уязвимостите се докладват');
    await expect(page.locator('[data-action="topic-cancel"]')).toBeVisible();
    await page.locator('[data-action="topic-cancel"]').click();
    await expect(panel(page)).toHaveAttribute('data-topic-status', 'error', { timeout: 10000 });
    await expect(page.locator('[data-field="topic-error"]')).toContainText('Отказано');
    expect((await liveTopics(page)).map((t) => t.status)).toEqual(['done', 'error']);
  });

  test('B6 "Изтрий темата" takes the topics below it too; "Върни" brings them all back; its 🌱 goes and comes', async ({ page }) => {
    await start(page);
    await mockApi(page, (_r, n) => ({ sse: answerSse(n === 1 ? TOPIC_MD : CHILD_MD) }));
    await openLesson(page);
    await expand(page, 'оценява рисковете');
    await done(page);
    await selectInApp(page, TOPIC_TEXT, 'жизнен цикъл на продукта');
    await page.locator('[data-action="doc-expand"]').click();
    await expect(page.locator('#notes-panel-title')).toHaveText('Жизнен цикъл', { timeout: 10000 });
    await page.locator('[data-action="topic-crumb"][data-crumb="subtopic"]').click();
    await expect(page.locator('#notes-panel-title')).toHaveText('Оценка на риска');
    await page.locator('[data-action="delete-topic"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('[data-field="notes-undo"]')).toContainText('Темата и 1 теми от нея са изтрити.');
    expect(await liveTopics(page)).toHaveLength(0);
    await expect(topicMarks(page)).toHaveCount(0);
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topic');
    expect(await liveTopics(page)).toHaveLength(2);
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(topicMarks(page)).toHaveCount(1);
  });

  test('S1 security: the lesson gets nothing of a topic (messages, its DOM), cannot start one with made-up messages, the key is only in x-api-key', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, () => ({ sse: answerSse(TOPIC_MD) }));
    const frame = await openLesson(page);
    await frame.evaluate(() => window.__forge());
    await page.waitForTimeout(2300);
    expect(seen).toHaveLength(0);
    expect(await liveTopics(page)).toEqual([]);
    await expand(page, 'оценява рисковете');
    await done(page);
    await selectInApp(page, TOPIC_TEXT, 'жизнен цикъл на продукта');
    await page.waitForTimeout(300);
    const lm = consoleAll.filter((l) => l.startsWith('LM:'));
    expect(lm.filter((l) => /Оценка на риска|систематично|ресурси|Развий/i.test(l))).toEqual([]);
    expect(lm.join('\n')).not.toContain('FAKE');
    const inLesson = await frame.evaluate(() => document.documentElement.outerHTML);
    expect(inLesson).not.toContain('систематично');
    expect(seen[0].raw).not.toContain(KEY);
  });
});

test.describe('T025-P a phone (360 × 800)', () => {
  test.beforeEach(({}, ti) => { test.skip(ti.project.name !== 'tablet-landscape', 'one window size'); });
  test('P1 a phone: "🌱 Развий" floats for the selection, the topic is over the whole window, ✕ back to the lesson; "🌱" floats for the list; no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await start(page);
    await mockApi(page, () => ({ sse: answerSse(TOPIC_MD) }));
    await openLesson(page);
    await select(page, 'оценява');
    await expect(page.locator('[data-action="new-topic-quick"]')).toBeVisible();
    await page.locator('[data-action="new-topic-quick"]').click();
    await expect(panel(page)).toHaveAttribute('data-layout', 'full');
    await done(page);
    const box = await panel(page).boundingBox();
    expect(box.width).toBeGreaterThan(340);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.locator('[data-action="close-notes-panel"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(topicMarks(page)).toHaveCount(1);
    await page.locator('[data-action="topics-phone"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'topics');
    await expect(page.locator('[data-field="topics-tree"] [data-topic]')).toHaveCount(1);
  });
});
