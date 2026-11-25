// T-042 (tester), part A: tests of T-076 (0.17.1) "as an attacker".
// - D2 a long thread keeps its quote; the request prefix is stable (the cache is hit):
//   checked on the requests themselves (api.anthropic.com is mocked) and on
//   buildRequest() over 0…80 earlier pairs;
// - S3 lrn:tap / lrn:escape only after a gesture in the lesson;
// - S1 the 5 s rule and „Отвори урок …?“: a normal link in a lesson opens at once,
//   soon after a tap in the app it asks; attacks on the rule;
// - S2 invisible / fullwidth / NFKC variants in the tags of the material (new ones);
// - D1 two tabs on one thread: the run id of an answer.
// NEVER a real request: api.anthropic.com is answered by page.route(); every other
// request leaving localhost is aborted and recorded. FAKE keys only; a made-up course (D-026).
// Known defects: test.fail(<defect seen>, 'T042-…: …') followed by the strict check.
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 150000 });
test.use({ trace: 'off', timezoneId: 'Europe/Sofia' });

const KEY = 'sk-ant-api03-FAKE-t042-4242424242-zz';
const KEY_TAIL = 't042-4242424242';
const API = /^https:\/\/api\.anthropic\.com\//;
const C = 'LRN-T42';
const L1 = `${C}/lesson:0001`;

let problems;
let external;
let consoleAll;
let allow;
let allowExternal;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  consoleAll = [];
  allow = [];
  allowExternal = [];
  page.on('console', (m) => { consoleAll.push(m.text()); if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (!problems) return;
  expect(problems.filter((p) => !allow.some((r) => r.test(p)))).toEqual([]);
  expect(external.filter((u) => !API.test(u) && !allowExternal.some((r) => r.test(u)))).toEqual([]);
  const all = consoleAll.join('\n');
  expect(all).not.toContain('FAKE');
  expect(all).not.toContain(KEY_TAIL);
});
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value).slice(0, 4000) });
const landscapeOnly = (ti, why = 'the logic does not depend on the layout') => test.skip(ti.project.name !== 'tablet-landscape', why);

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body, head = '') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const FILL = Array.from({ length: 20 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
const BODY = `<h2>Обхват</h2><p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи.</p>
<h2>Задължения</h2><p id="p2">Производителят оценява рисковете през целия жизнен цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>
<p id="links"><a id="l2" href="0002-vtori.html">втори урок</a> · <a id="ext" href="https://example.invalid/act">Външен източник</a> · <a id="in" href="#far">надолу</a></p>${FILL}<p id="far">Далечен абзац в края.</p><input id="v1" aria-label="v1">`;
const baseFiles = (over = {}) => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи урок |\n| 0002 | Втори урок |\n`,
  'MISSION.md': '# Мисия\n\nИзмислена мисия за тест.\n',
  'NOTES.md': '# Бележки\n\nКратки отговори.\n',
  'RESOURCES.md': '# Източници\n\n- [Измислен акт](https://example.invalid/act)\n',
  'GLOSSARY.md': '# Речник\n\n**Продукт** (product): измислено.\n',
  'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY),
  'lessons/0002-vtori.html': lessonHtml('Втори урок', '<p>Втори урок, кратък текст за тест.</p>'),
  ...over,
});

async function boot(page) {
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
}
async function importCourse(page, files) {
  const zip = asFile(`${C}.zip`, makeZip(toBytes(files), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: zip.name, bytes: [...zip.buffer] });
  expect(r).not.toMatch(/^ERROR/);
  return r;
}
async function start(page, { key = true, files = baseFiles() } = {}) {
  await boot(page);
  await importCourse(page, files);
  if (key) await page.evaluate(async (k) => { const db = await import('./src/db.js'); await db.saveApiKey(k); }, KEY);
}
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page, n = '0001') {
  const hash = `#/c/${C}/read/${n}`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
/**
 * The lesson opened with no page.evaluate() after it loads (an evaluate is a user activation;
 * a lesson that takes the focus within a second of it would count it as its own tap).
 */
async function openLessonQuiet(page, n = '0001') {
  await page.goto(`./#/c/${C}/read/${n}`);
  if (new URL(page.url()).hash === `#/c/${C}/read/${n}`) await page.reload();
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-anchored]').first()).toHaveAttribute('data-anchored', /\d+/, { timeout: 15000 });
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
const closePanel = (page) => page.locator('[data-action="close-notes-panel"]').click();
const confirmBox = (page) => page.locator('[data-field="link-confirm"]');

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
async function ask(page, needle, question) {
  await askAbout(page, needle);
  await field(page).pressSequentially(question);
  await sendButton(page).click();
}
const lastDone = (page, n = 0) => expect(answers(page).nth(n)).toHaveAttribute('data-status', 'done', { timeout: 15000 });

const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const USAGE = { input_tokens: 1200, output_tokens: 60, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 };
const answerSse = (text) => sse([
  ['message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage: USAGE } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } }],
  ['message_stop', {}],
]);
const CORS = { 'access-control-allow-origin': '*' };
/** answer(request, n) → { sse } | { status, json } | 'hang' | a Promise of one of these (resolved by the test). */
async function mockApi(page, answer) {
  const seen = [];
  await page.route(API, async (route) => {
    const r = route.request();
    seen.push({ headers: await r.allHeaders(), raw: r.postData(), body: r.postData() ? JSON.parse(r.postData()) : null, url: r.url() });
    const a = await answer(r, seen.length);
    if (a === 'hang') return new Promise(() => {});
    try {
      if (a.sse !== undefined) await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: a.sse });
      else await route.fulfill({ status: a.status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(a.json ?? {}) });
    } catch { /* the page aborted the request meanwhile */ }
  });
  return seen;
}
/** A gate: `wait` is a promise the route awaits; `open(value)` resolves it. */
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };
const db = (page, name, ...args) => page.evaluate(async ({ name, args }) => (await import('./src/db.js'))[name](...args), { name, args });
const messagesOf = async (page) => (await db(page, 'list', 'messages')).sort((a, b) => (a.id < b.id ? -1 : 1));
const userText = (req) => req.body.messages.at(-1).content.map((c) => c.text).join('');
const preview = (page, opts = {}) => page.evaluate(async ({ C, L, opts }) => {
  const T = await import('./src/teacher.js');
  const D = await import('./src/db.js');
  const [course, lesson] = await Promise.all([D.getCourse(C), D.get('lessons', L)]);
  const p = await T.previewTeacher({ course, lesson, question: 'Какво?', ...opts });
  return { system: p.request.system.map((b) => b.text), user: p.request.messages.at(-1).content[0].text, text: p.text };
}, { C, L: L1, opts });

// ===========================================================================
// D2 — a long thread: the quote stays, the prefix is stable (the cache is hit)
// ===========================================================================
test.describe('T042-A-D2 a long thread keeps its quote; a stable prefix (T024-D2 fix)', () => {
  test.beforeEach(({}, ti) => landscapeOnly(ti));

  test('D2a buildRequest() for 0…80 earlier pairs: the first turn always has the quote, ≤ 41 messages, user first, alternating; the whole request N is the start of request N+1 except when the window is cut (once per HISTORY_STEP questions); the first two turns never change', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
      const T = await import('./src/teacher.js');
      const base = { rules: { text: 'Правила.' }, course: { id: 'X', title: 'Курс', meta: {} }, lesson: { number: '0001', title: 'Урок' }, text: { title: 'Урок', text: 'Текст на урока.' },
        quote: 'оценява рисковете', paragraph: 'Производителят оценява рисковете.', path: ['Задължения'] };
      const history = [];
      const reqs = [];
      for (let n = 0; n <= 80; n++) {
        const req = T.buildRequest({ ...base, question: `Въпрос ${n}?`, history: history.slice(), followUp: n > 0 });
        reqs.push(req);
        // as the app keeps it: the user turn is what was sent, then the answer
        history.push({ role: 'user', text: req.messages.at(-1).content[0].text }, { role: 'assistant', text: `Отговор ${n}.` });
      }
      const J = (x) => JSON.stringify(x);
      const out = { lost: [], long: [], order: [], breaks: [], firstTwo: new Set(), step: T.HISTORY_STEP, cache: [] };
      reqs.forEach((q, n) => {
        if (!q.messages[0].content[0].text.includes('Избран текст: «оценява рисковете»')) out.lost.push(n);
        if (q.messages.length > 41) out.long.push(n);
        if (!q.messages.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user'))) out.order.push(n);
        if (q.messages.length > 2) out.firstTwo.add(J(q.messages.slice(0, 2)));
        if (n > 0 && !q.cacheControl) out.cache.push(n);
        if (n > 0) {
          const prev = reqs[n - 1].messages;
          const prevAnswered = [...prev, { role: 'assistant', content: [{ type: 'text', text: `Отговор ${n - 1}.` }] }];
          if (J(q.messages.slice(0, prevAnswered.length)) !== J(prevAnswered)) out.breaks.push(n);
        }
      });
      return { ...out, firstTwo: out.firstTwo.size };
    });
    info('T042-D2a', r);
    expect(r.lost).toEqual([]);
    expect(r.long).toEqual([]);
    expect(r.order).toEqual([]);
    expect(r.cache).toEqual([]);
    expect(r.firstTwo).toBe(1);
    // 80 questions, a window of 20 pairs cut by 10: the prefix moves only at the cuts.
    expect(r.breaks.length).toBeGreaterThan(0);
    expect(r.breaks.length).toBeLessThanOrEqual(Math.ceil(80 / r.step));
    for (let i = 1; i < r.breaks.length; i++) expect(r.breaks[i] - r.breaks[i - 1]).toBeGreaterThanOrEqual(r.step);
  });

  test('D2b the requests themselves (mock): a thread of 18 pairs, then 14 questions in the panel — every request keeps the quote in its first turn, ≤ 41 messages, the same system blocks, a cache_control for the thread; request N (with its answer) is the start of request N+1 except at ≤ 2 cuts', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => ({ sse: answerSse(`Отговор ${n}.`) }));
    await openLesson(page);
    await ask(page, 'оценява рисковете', 'Въпрос 0?');
    await lastDone(page);
    await page.evaluate(async ({ L }) => {
      const D = await import('./src/db.js');
      const Q = await import('./src/questions.js');
      const lesson = await D.get('lessons', L);
      const [t] = (await D.list('threads')).filter((x) => !x.deleted);
      for (let i = 1; i <= 17; i++) {
        const sent = Q.sentText(t, lesson, `Стар въпрос ${i}?`, true);
        const { assistant } = await Q.addExchange(lesson, t.id, { question: `Стар въпрос ${i}?`, sent });
        await Q.finishAnswer(assistant.id, { content: `Стар отговор ${i}.`, status: 'done' });
      }
    }, { L: L1 });
    await closePanel(page);
    await threadMarks(page).first().click();
    await expect(answers(page)).toHaveCount(18);
    for (let k = 0; k < 14; k++) {
      await field(page).fill(`Нов въпрос ${k}?`);
      await sendButton(page).click();
      await expect(answers(page)).toHaveCount(19 + k);
      await expect(answers(page).nth(18 + k)).toHaveAttribute('data-status', 'done', { timeout: 15000 });
    }
    const reqs = seen.slice(1);
    expect(reqs).toHaveLength(14);
    const J = (x) => JSON.stringify(x);
    const breaks = [];
    reqs.forEach((x, i) => {
      expect(x.body.messages.length).toBeLessThanOrEqual(41);
      expect(x.body.messages[0].role).toBe('user');
      expect(x.body.messages[0].content[0].text).toContain('Избран текст: «оценява рисковете»');
      expect(x.body.messages.every((m, j) => m.role === (j % 2 ? 'assistant' : 'user'))).toBe(true);
      expect(J(x.body.system)).toBe(J(seen[0].body.system));
      expect(x.body.cache_control).toEqual({ type: 'ephemeral' });
      expect(userText(x)).toBe(`Въпрос: Нов въпрос ${i}?`);
      if (i > 0) {
        const prev = [...reqs[i - 1].body.messages.map(({ role, content }) => ({ role, content: content.map(({ type, text }) => ({ type, text })) })),
          { role: 'assistant', content: [{ type: 'text', text: `Отговор ${i + 1}.` }] }];
        const now = x.body.messages.slice(0, prev.length).map(({ role, content }) => ({ role, content: content.map(({ type, text }) => ({ type, text })) }));
        if (J(now) !== J(prev)) breaks.push(i);
      }
    });
    info('T042-D2b', { lengths: reqs.map((x) => x.body.messages.length), breaks });
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    expect(breaks.length).toBeLessThanOrEqual(2);
  });

  test('D2c the first answer failed (500), the user asks again without "Опитай пак": the next request has the full place (no earlier pair is kept); the one after it has the place in its first turn', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page, (_r, n) => (n === 1 ? { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'x' } } } : { sse: answerSse(`Отговор ${n}.`) }));
    await openLesson(page);
    await ask(page, 'оценява рисковете', 'Първи?');
    await expect(answers(page).first()).toHaveAttribute('data-status', 'error', { timeout: 20000 });
    const n1 = seen.length;
    await field(page).fill('Втори?');
    await sendButton(page).click();
    await expect(answers(page)).toHaveCount(2);
    await lastDone(page, 1);
    await field(page).fill('Трети?');
    await sendButton(page).click();
    await expect(answers(page)).toHaveCount(3);
    await lastDone(page, 2);
    const [second, third] = seen.slice(n1);
    info('T042-D2c', { second: second.body.messages.map((m) => m.content[0].text.slice(0, 80)), third: third.body.messages.map((m) => m.content[0].text.slice(0, 80)) });
    expect(second.body.messages).toHaveLength(1);
    expect(userText(second)).toMatch(/^Избран текст: «оценява рисковете»[\s\S]*\n\nВъпрос: Втори\?$/);
    expect(third.body.messages).toHaveLength(3);
    expect(third.body.messages[0].content[0].text).toMatch(/^Избран текст: «оценява рисковете»/);
    expect(userText(third)).toBe('Въпрос: Трети?');
  });
});

// ===========================================================================
// S1 / S3 — gestures in the lesson
// ===========================================================================
// A lesson that, armed 9 s after it loads (no page.evaluate after openLesson: every
// evaluate is a user activation), takes the focus the moment the app has it and sends
// lrn:link (→ 0002) / lrn:tap (every annotation it knows) / lrn:escape every 40 ms.
const thief = ({ link = false, tap = false, escape = false, steal = true, from = 9000, to = 60000 } = {}) => `<script>(() => {
  const t0 = Date.now(); let ids = [];
  addEventListener('message', (e) => { const d = e.data; if (d && d.type === 'lrn:annotations' && Array.isArray(d.items)) ids = d.items.map((x) => x.id); });
  setInterval(() => {
    const t = Date.now() - t0;
    if (t < ${from} || t > ${to}) return;
    ${steal ? "if (!document.hasFocus()) { document.getElementById('v1').focus({ preventScroll: true }); console.log('LF:steal ' + document.hasFocus()); }" : ''}
    ${link ? "parent.postMessage({ lrn: 1, type: 'lrn:link', href: new URL('0002-vtori.html', location.href).href }, '*');" : ''}
    ${tap ? "for (const id of ids) parent.postMessage({ lrn: 1, type: 'lrn:tap', annotationId: id }, '*');" : ''}
    ${escape ? "parent.postMessage({ lrn: 1, type: 'lrn:escape' }, '*');" : ''}
  }, 40);
})();</script>`;
const thiefFiles = (opts) => baseFiles({ 'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY + thief(opts)) });

test.describe('T042-A-S1 links of a lesson: the 5 s rule and „Отвори урок …?“ (T024-S1 fix)', () => {
  test.beforeEach(() => { allow.push(/EasyLRN|lesson|Урок|gesture/i); });

  test('S1a a normal link in the lesson, no tap in the app for > 5 s: a click opens lesson 0002 at once, no question', async ({ page }) => {
    await start(page);
    const frame = await openLesson(page);
    await page.waitForTimeout(5600);
    await frame.locator('#l2').click();
    await expect(page).toHaveURL(/\/read\/0002$/, { timeout: 5000 });
    await expect(confirmBox(page)).toHaveCount(0);
  });

  test('S1b the same with a touch (tap): opens at once, no question', async ({ page }) => {
    await start(page);
    const frame = await openLesson(page);
    await page.waitForTimeout(5600);
    await frame.locator('#l2').tap();
    await expect(page).toHaveURL(/\/read\/0002$/, { timeout: 5000 });
    await expect(confirmBox(page)).toHaveCount(0);
  });

  test('S1c a link soon after a tap in the app asks „Отвори урок 0002: Втори урок?“ in the app ("Отказ" focused): "Отказ" stays, "Отвори" opens; Enter on the question is "Отказ"', async ({ page }) => {
    await start(page);
    const frame = await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    await closePanel(page);
    await frame.locator('#l2').click();
    await expect(confirmBox(page)).toBeVisible();
    await expect(confirmBox(page)).toContainText('Отвори урок 0002: Втори урок?');
    await expect(confirmBox(page).locator('[data-field="confirm-no"]')).toBeFocused();
    expect(page.url()).toMatch(/\/read\/0001$/);
    // Enter is "Отказ" (the focus is on it).
    await page.keyboard.press('Enter');
    await expect(confirmBox(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(page.url()).toMatch(/\/read\/0001$/);
    // T-077 (T042-S2): after "Отказ" the lesson asks nothing more until a clean gesture —
    // an unsure link soon after is dropped (no question, no navigation).
    await frame.locator('#l2').click();
    await page.waitForTimeout(600);
    await expect(confirmBox(page)).toHaveCount(0);
    expect(page.url()).toMatch(/\/read\/0001$/);
    // A new press in the app, then the link: still dropped (the refusal holds).
    await page.locator('[data-action="notes-list"]').click();
    await closePanel(page);
    await frame.locator('#l2').click();
    await page.waitForTimeout(600);
    await expect(confirmBox(page)).toHaveCount(0);
    expect(page.url()).toMatch(/\/read\/0001$/);
    // A clean tap (5 s after the last press in the app) opens at once.
    await page.waitForTimeout(5600);
    await frame.locator('#l2').click();
    await expect(page).toHaveURL(/\/read\/0002$/, { timeout: 5000 });
    await expect(confirmBox(page)).toHaveCount(0);
    // In a new lesson the question comes again; "Отвори" opens.
    const again = await openLesson(page, '0001');
    await page.locator('[data-action="notes-list"]').click();
    await closePanel(page);
    await again.locator('#l2').click();
    await expect(confirmBox(page)).toBeVisible();
    await confirmBox(page).locator('[data-field="confirm-yes"]').click();
    await expect(page).toHaveURL(/\/read\/0002$/, { timeout: 5000 });
  });

  test('S1d soon after a tap in the app: an outside https link of the lesson asks „Отвори връзката example.invalid в нов раздел?“; "Отвори" opens a new tab without opener; a jump inside the lesson (#far) goes without a question', async ({ page, context }, ti) => {
    landscapeOnly(ti);
    allowExternal.push(/^https:\/\/example\.invalid\//);
    await context.route('https://example.invalid/act', (route) => { external.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>измислена страница</p>' }); });
    await start(page);
    const frame = await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    await closePanel(page);
    const before = await page.evaluate(() => scrollY);
    await frame.locator('#in').click();
    await page.waitForTimeout(600);
    await expect(confirmBox(page)).toHaveCount(0);
    const after = await page.evaluate(() => scrollY);
    info('T042-S1d-jump', { before, after });
    expect(after).toBeGreaterThan(before);
    await page.locator('[data-action="notes-list"]').click();
    await closePanel(page);
    await frame.evaluate(() => document.getElementById('ext').scrollIntoView({ block: 'center' }));
    await frame.locator('#ext').click();
    await expect(confirmBox(page)).toBeVisible();
    await expect(confirmBox(page)).toContainText('Отвори връзката example.invalid в нов раздел?');
    const popup = context.waitForEvent('page');
    await confirmBox(page).locator('[data-field="confirm-yes"]').click();
    const p = await popup;
    await p.waitForLoadState();
    expect(p.url()).toBe('https://example.invalid/act');
    expect(await p.evaluate(() => window.opener)).toBeNull();
    await p.close();
    expect(page.url()).toMatch(/\/read\/0001$/);
  });

  test('S1e attack: a lesson that takes the focus the moment the app has it and sends lrn:link every 40 ms — a click on ☷ never navigates (it may only ask); after "Отказ" the question must not come straight back (the user can get rid of it)', async ({ page }) => {
    await start(page, { files: thiefFiles({ link: true, from: 12000 }) });
    await openLessonQuiet(page);
    // Every locator call is an activation as well: the place of ☷ first, then only page.mouse.
    const box = await page.locator('[data-action="notes-list"]').boundingBox();
    await page.waitForTimeout(13500); // armed; no activation at all yet
    expect(page.url()).toMatch(/\/read\/0001$/);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/read\/0001$/);
    const asked = await confirmBox(page).count();
    let back = 0;
    for (let i = 0; i < 3 && (await confirmBox(page).count()); i++) {
      await confirmBox(page).locator('[data-field="confirm-no"]').click();
      await page.waitForTimeout(1200);
      back += await confirmBox(page).count();
    }
    expect(page.url()).toMatch(/\/read\/0001$/);
    info('T042-S2', { asked, back });
    expect(back).toBe(0);
  });

  test('S1f the question goes with the lesson: a pending „Отвори урок …?“ is removed when the user goes to another screen', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    const frame = await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    await closePanel(page);
    await frame.locator('#l2').click();
    await expect(confirmBox(page)).toBeVisible();
    await page.goto(`./#/c/${C}`);
    await expect(page.locator('iframe.lesson-frame')).toHaveCount(0);
    await expect(confirmBox(page)).toHaveCount(0);
  });

  test('S1g attack on the 5 s rule with a long touch in the app: touchstart, 1.5 s, touchend (no compat mousedown after a long press) — then the lesson takes the focus 5.2 s after the touch began and sends lrn:link: it must not navigate without a question', async ({ page }, ti) => {
    landscapeOnly(ti);
    // The lesson waits for the app to take the focus (its own blur), then 5.2 s, then steals and links.
    const LATE = `<script>(() => { let away = 0; const t0 = Date.now();
      addEventListener('blur', () => { if (Date.now() - t0 > 9000 && !away) away = Date.now(); });
      setInterval(() => {
        if (Date.now() - t0 < 9000) { if (!document.hasFocus()) document.getElementById('v1').focus({ preventScroll: true }); return; }
        if (!away || Date.now() - away < 5200) return;
        if (!document.hasFocus()) document.getElementById('v1').focus({ preventScroll: true });
        parent.postMessage({ lrn: 1, type: 'lrn:link', href: new URL('0002-vtori.html', location.href).href }, '*');
      }, 40); })();</script>`;
    await start(page, { files: baseFiles({ 'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY + LATE) }) });
    await openLesson(page);
    await page.waitForTimeout(9500);
    const client = await page.context().newCDPSession(page);
    const box = await page.locator('[data-field="reader-topbar"]').boundingBox().catch(() => null);
    const pt = box ? { x: box.x + box.width / 2, y: box.y + 4 } : { x: 960, y: 4 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
    await page.waitForTimeout(1500);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(6500);
    const url = page.url();
    const asked = await confirmBox(page).count();
    info('T042-S1g', { url, asked, pt });
    expect(url).toMatch(/\/read\/0001$/);
  });
});

test.describe('T042-A-S3 lrn:tap / lrn:escape only after a gesture in the lesson (T024-S3 fix)', () => {
  test.beforeEach(({}, ti) => { allow.push(/EasyLRN|lesson|Урок|gesture/i); landscapeOnly(ti); });

  test('S3a no gesture: a lesson sending forged lrn:tap (the ids of its annotations) / lrn:escape every 40 ms opens and closes nothing; the user\'s own tap on the 💬 mark of the app opens the thread and it stays open', async ({ page }) => {
    await start(page, { files: thiefFiles({ tap: true, escape: true, steal: false, from: 0, to: 1e9 }) });
    await mockApi(page, () => ({ sse: answerSse('Отговор за четене.') }));
    await openLesson(page);
    await ask(page, 'Уязвимостите се докладват', 'Колко бързо?');
    await lastDone(page);
    await closePanel(page);
    await page.waitForTimeout(1500);
    await expect(panel(page)).toBeHidden();
    await threadMarks(page).first().click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
    await page.waitForTimeout(1500);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
  });

  const S1_TEXT = 'T042-S1: the residual risk of the T024-S3 fix (said in the T-076 log): lrn:tap and lrn:escape take an "unsure" gesture as well — a lesson that takes the focus itself right after any press in the app (it polls document.hasFocus()) closes the thread (or the list) the user has just opened to read with lrn:escape, and opens a panel of its choice with lrn:tap after a press on ☷ / ✕; nothing is read or sent (a nuisance); lrn:tap could ask for a clean gesture (a real tap on a mark in the lesson within 5 s of a press in the app is then only ignored) and lrn:escape could be refused while the blur came within the activation of an app press';
  // NB: a locator.click() evaluates in the page before the press (an activation of its own while the
  // lesson already holds an "unsure" gesture) — the presses on ☷ are made with page.mouse at its place.
  // Every locator call is an activation too (seen: a lesson holding an "unsure" gesture got its lrn:tap
  // through at a mere isVisible()): the place of the target is measured before the lesson is armed,
  // and nothing but page.mouse touches the page until the press.
  async function thread(page, target) {
    await mockApi(page, () => ({ sse: answerSse('Отговор за четене.') }));
    await openLesson(page);
    await ask(page, 'Уязвимостите се докладват', 'Колко бързо?');
    await lastDone(page);
    await closePanel(page);
    // A fresh document of the lesson (its 20 s start again), then no press and no evaluate until it is armed.
    await openLessonQuiet(page);
    const box = await target(page).boundingBox();
    await page.waitForTimeout(21000);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1500);
  }

  test('S3b attack (lrn:escape): the lesson takes the focus right after a press in the app and sends lrn:escape every 40 ms — the thread the user opens with its 💬 mark must stay open', async ({ page }) => {
    await start(page, { files: thiefFiles({ escape: true, from: 20000, to: 90000 }) });
    await thread(page, (p) => threadMarks(p).first());
    const closedByLesson = await panel(page).isHidden();
    info('T042-S1-escape', { closedByLesson, log: consoleAll.filter((l) => /LF:|lrn:escape|lrn:tap/.test(l)).slice(-6) });
    expect(closedByLesson).toBe(false);
  });

  test('S3c attack (lrn:tap): the same lesson sends lrn:tap with the id of the thread\'s annotation — a press on ☷ (the list) must not end in the panel of that thread', async ({ page }) => {
    await start(page, { files: thiefFiles({ tap: true, from: 20000, to: 90000 }) });
    await thread(page, (p) => p.locator('[data-action="notes-list"]'));
    const mode = (await panel(page).isVisible()) ? await panel(page).getAttribute('data-mode') : null;
    const openedByLesson = mode === 'thread';
    info('T042-S1-tap', { mode, log: consoleAll.filter((l) => /LF:|lrn:escape|lrn:tap/.test(l)).slice(-6) });
    expect(openedByLesson).toBe(false);
  });
});

// ===========================================================================
// S2 — tags of the material: new variants
// ===========================================================================
test.describe('T042-A-S2 invisible / fullwidth / NFKC variants in the tags of the material (T024-S2 fix)', () => {
  test.beforeEach(({}, ti) => landscapeOnly(ti));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  test('S2a the listed gaps and their mixes, between "<" and "/" and inside the name; fullwidth / small / mathematical / long-s names (NFKC) — all neutralised in the lesson, a course file, the quote and the path', async ({ page }) => {
    const closers = ['<\uFEFF/LESSON>', '<\u202E/LESSON>', '<\u2066/LESSON>', '<\uFFF9/LESSON>', '<\u061C/LESSON>', '<\u180E/LESSON>', '<\u200B \u2060\u00AD\t/LESSON>', '<\u200F\n/LESSON>',
      '\uFF1C\uFF0FLESSON\uFF1E', '\uFE64/LESSON\uFE65', '<\uFF0FLESSON>', '\uFF1C\u200B/LESSON>'];
    const openers = ['<\u200B\uFF33\uFF39\uFF33\uFF34\uFF25\uFF2D>', '<\u{1D412}\u{1D418}\u{1D412}\u{1D413}\u{1D404}\u{1D40C}>', '<\u017Fystem>', '<SYS\u200BTEM>', '<\u2060instructions>', '<sys\u00ADtem>', '\uFF1CSYSTEM>', '<\u2061RULES>', '<\u24C8\u24CE\u24C8\u24C9\u24BA\u24C2>'];
    const all = [...closers, ...openers];
    const body = `<p>${all.map(esc).join(' | ')}</p>${BODY}`;
    await start(page, { files: baseFiles({ 'lessons/0001-parvi.html': lessonHtml('Първи урок', body), 'MISSION.md': `# Мисия\n\n${all.join(' | ')}\n` }) });
    const a = await preview(page, { quote: all.join(' '), path: [all.slice(0, 4).join(''), all.slice(12).join('')] });
    const [, course, lesson] = a.system;
    const kept = (text) => all.filter((v) => text.includes(v));
    const r = { lesson: kept(lesson), course: kept(course), user: kept(a.user) };
    info('T042-S2a', r);
    expect(r).toEqual({ lesson: [], course: [], user: [] });
    // Exactly the app's own tags.
    expect(lesson.match(/<\/LESSON>/g)).toHaveLength(1);
    expect(course.match(/<\/MISSION>/g)).toHaveLength(1);
  });

  test('S2b invisible characters NOT in the fixed list, between "<" and "/" (variation selector U+FE0F, combining grapheme joiner U+034F, tag space U+E0020, musical format U+1D173, shorthand format U+1BCA0, the C1 control NEL U+0085, Hangul fillers U+3164 / U+115F / U+FFA0, braille blank U+2800) and before a name', async ({ page }) => {
    const INV = { FE0F: '\uFE0F', '034F': '\u034F', E0020: '\u{E0020}', '1D173': '\u{1D173}', '1BCA0': '\u{1BCA0}', '0085': '\u0085', 3164: '\u3164', '115F': '\u115F', FFA0: '\uFFA0', 2800: '\u2800' };
    const variants = Object.entries(INV).flatMap(([k, c]) => [[`${k}/`, `<${c}/LESSON>`], [`${k}name`, `<${c}SYSTEM>`]]);
    const body = `<p>${variants.map(([, v]) => esc(v)).join(' | ')}</p>${BODY}`;
    await start(page, { files: baseFiles({ 'lessons/0001-parvi.html': lessonHtml('Първи урок', body), 'MISSION.md': `# Мисия\n\n${variants.map(([, v]) => v).join(' | ')}\n` }) });
    const [, course, lesson] = (await preview(page)).system;
    const leak = variants.filter(([, v]) => lesson.includes(v) || course.includes(v)).map(([k]) => k);
    info('T042-S3', { leak });
    expect(leak).toEqual([]);
  });

  test('S2c look-alikes that NFKC does not fold (modifier arrowhead ˂ U+02C2, division slash ∕ U+2215, fraction slash ⁄ U+2044, dotless ı in <ınstructions>) are kept as they are (info)', async ({ page }) => {
    const looks = ['\u02C2/LESSON>', '<\u2215LESSON>', '<\u2044LESSON>', '<\u0131nstructions>'];
    await start(page, { files: baseFiles({ 'lessons/0001-parvi.html': lessonHtml('Първи урок', `<p>${looks.map(esc).join(' | ')}</p>${BODY}`) }) });
    const [, , lesson] = (await preview(page)).system;
    info('T042-I1', { kept: looks.filter((v) => lesson.includes(v)) });
    expect(lesson.match(/<\/LESSON>/g)).toHaveLength(1);
  });
});

// ===========================================================================
// D1 — two tabs, the run of an answer
// ===========================================================================
test.describe('T042-A-D1 two tabs on one thread: the run of an answer (T024-D1 fix)', () => {
  test.beforeEach(({}, ti) => landscapeOnly(ti));

  async function twoTabs(page, context, { bAnswer }) {
    await start(page);
    const g = gate();
    await mockApi(page, () => g.wait);
    await openLesson(page);
    await ask(page, 'оценява рисковете', 'Два раздела?');
    await expect(page.locator('[data-action="question-cancel"]')).toBeVisible();
    const [m0] = (await messagesOf(page)).filter((x) => x.role === 'assistant');
    const b = await context.newPage();
    b.on('pageerror', (e) => problems.push(`B pageerror: ${e}`));
    await b.route(API, bAnswer);
    await b.goto(`./#/c/${C}/read/0001`);
    await expect(b.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await b.locator('[data-field="notes-marks"] .notes-strip__mark--thread').first().click();
    await expect(b.locator('[data-field="answer-error"]')).toContainText('прекъсна');
    await b.locator('[data-action="question-retry"]').click();
    return { g, b, m0 };
  }

  test('D1a tab A\'s own request ends with its own answer after B\'s "Опитай пак" got one: the answer B got stays; the run changed with the retry; A shows B\'s answer when the thread is opened again', async ({ page, context }) => {
    const { g, b, m0 } = await twoTabs(page, context, { bAnswer: (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: answerSse('Отговорът от раздел Б.') }) });
    await expect(b.locator('[data-field="thread-log"] [data-role="assistant"]').first()).toHaveAttribute('data-status', 'done', { timeout: 15000 });
    g.open({ sse: answerSse('Късен отговор от раздел А.') });
    await page.waitForTimeout(1500);
    const [m] = (await messagesOf(page)).filter((x) => x.role === 'assistant');
    info('T042-D1a', { run0: m0.run, run: m.run, status: m.status, content: m.content });
    expect(m0.run).toBeTruthy();
    expect(m.run).toBeTruthy();
    expect(m.run).not.toBe(m0.run);
    expect(m.status).toBe('done');
    expect(m.content).toBe('Отговорът от раздел Б.');
    await closePanel(page);
    await threadMarks(page).first().click();
    await expect(answers(page).first()).toContainText('Отговорът от раздел Б.');
    await b.close();
  });

  test('D1b tab A\'s request fails (400) after B\'s answer: B\'s answer stays (no error over it)', async ({ page, context }) => {
    const { g, b } = await twoTabs(page, context, { bAnswer: (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: answerSse('Отговорът от раздел Б.') }) });
    await expect(b.locator('[data-field="thread-log"] [data-role="assistant"]').first()).toHaveAttribute('data-status', 'done', { timeout: 15000 });
    g.open({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'x' } } });
    await page.waitForTimeout(1500);
    const [m] = (await messagesOf(page)).filter((x) => x.role === 'assistant');
    expect(m.status).toBe('done');
    expect(m.content).toBe('Отговорът от раздел Б.');
    expect(m.errorKind || null).toBeNull();
    await b.close();
  });

  test('D1c B\'s retry is still coming when A\'s old request ends: the message stays B\'s streaming run (A writes nothing); then B\'s answer is the one kept', async ({ page, context }) => {
    const gb = gate();
    const { g, b } = await twoTabs(page, context, { bAnswer: async (route) => { const a = await gb.wait; await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: answerSse(a) }); } });
    await expect(b.locator('[data-action="question-cancel"]')).toBeVisible();
    const [mid] = (await messagesOf(page)).filter((x) => x.role === 'assistant');
    g.open({ sse: answerSse('Старият отговор от А.') });
    await page.waitForTimeout(1500);
    const [m1] = (await messagesOf(page)).filter((x) => x.role === 'assistant');
    expect(m1.status).toBe('streaming');
    expect(m1.run).toBe(mid.run);
    expect(m1.content || '').not.toContain('Старият');
    gb.open('Новият отговор от Б.');
    await expect(b.locator('[data-field="thread-log"] [data-role="assistant"]').first()).toHaveAttribute('data-status', 'done', { timeout: 15000 });
    const [m2] = (await messagesOf(page)).filter((x) => x.role === 'assistant');
    expect(m2.status).toBe('done');
    expect(m2.content).toBe('Новият отговор от Б.');
    await b.close();
  });
});
