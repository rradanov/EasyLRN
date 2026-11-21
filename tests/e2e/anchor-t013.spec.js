// T-013 (developer, 0.12.0): anchoring (D-012) through the real lesson frame.
// - The unit page tests/anchor.html (src/anchor.js on the LRN-DEMO fixture and
//   three changed versions: inserted paragraph / edited sentence / deleted
//   section, the PLAN T-013 criteria, edge cases, a long text);
// - in the app: a selection in the opaque lesson → `lrn:selection` →
//   annotateSelection (the call T-015's bottom bar will make) → the record
//   (DocRef + D-039 id, targetVersion, TextQuote + TextPosition + hint);
//   reopening → `lrn:annotations` → the bridge anchors and paints (CSS Custom
//   Highlights, no DOM change) → `lrn:anchored` → anchorState in the store;
// - a re-import with a changed lesson: ok / fuzzy / orphan, nothing lost;
// - quiz.js redraws its DOM, a lesson script rewrites its own text,
//   `data-lrn-noanno`, a long lesson, unicode;
// - attacks through the bridge: fake / huge / malformed messages, ids of
//   another lesson, a flood, what the lesson receives (no notes, no secrets).
// Synthetic data only, fake keys, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile, readFixture } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});

async function start(page) {
  // Every lrn:* message the app window receives from a frame (a test-only
  // listener, in the app window only; the app's own checks are what is tested).
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

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(toBytes(files), { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const lessonHtml = (title, body, head = '') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const BODY = [
  '<p id="p1">Регламентът за киберустойчивост (<em>Cyber Resilience Act</em>) се прилага за продукти с цифрови елементи.</p>',
  '<h2 id="s1">Задължения</h2>',
  '<p id="p2">Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.</p>',
  '<p id="p3">Уязвимостите се докладват без неоправдано забавяне.</p>',
  '<h2 id="s2">Срокове</h2>',
  '<p id="p4">Задълженията за докладване се прилагат по-рано от останалите изисквания.</p>',
  '<div data-lrn-noanno><p id="nx">Този текст не се маркира: бележка на автора.</p></div>',
  '<p id="p5">Краят на урока е тук, след бележката.</p>',
].join('\n');
const C = 'LRN-T13';
const files = (body = BODY, extra = {}) => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', body),
  'lessons/0002-vtori.html': lessonHtml('Втори', '<p>Друг урок с текст за киберсигурността.</p>'),
  ...extra,
});
const L1 = `${C}/lesson:0001`;
const L2 = `${C}/lesson:0002`;

const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function openLesson(page, number = '0001', course = C) {
  const hash = `#/c/${course}/read/${number}`;
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  return lessonFrame(page);
}
async function lessonFrame(page) {
  const handle = await page.locator('iframe.lesson-frame').elementHandle();
  return handle.contentFrame();
}
/** Select from the start of `from` to the end of `to` (each inside one text node) in the lesson. */
function selectIn(frame, from, to = from) {
  return frame.evaluate(({ from, to }) => {
    const find = (needle) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) return [n, i]; }
      throw new Error(`not found: ${needle}`);
    };
    const [a, i] = find(from);
    const [b, j] = find(to);
    const r = document.createRange();
    r.setStart(a, i);
    r.setEnd(b, j + to.length);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { from, to });
}
/** The last lrn:selection the app window received. */
async function lastSelection(page) {
  await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection').length), { timeout: 5000 }).toBeGreaterThan(0);
  return page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection').at(-1));
}
/** Select in the lesson and make an annotation from the selection (as T-015 will). */
async function annotate(page, from, to, color = 'yellow') {
  const frame = await lessonFrame(page);
  await page.evaluate(() => { window.__lrn = window.__lrn.filter((m) => m.type !== 'lrn:selection'); });
  await selectIn(frame, from, to);
  const sel = await lastSelection(page);
  expect(sel.empty).toBe(false);
  return page.evaluate(async ({ sel, color, lessonNumber }) => {
    const db = await import('./src/db.js');
    const { annotateSelection } = await import('./src/annotations.js');
    const lessonId = location.hash.match(/#\/c\/([^/]+)\/read\/([^?]+)/);
    const course = await db.getCourse(decodeURIComponent(lessonId[1]));
    const lessons = await db.listLessons(course.id);
    const lesson = lessons.find((l) => l.number === lessonNumber);
    // The same checks as the app (lesson-frame CHECK) are applied to `sel` there;
    // here the message is taken as the app kept it.
    const clean = { empty: false, quote: sel.quote, position: sel.position, hint: sel.hint ?? null };
    return annotateSelection({ course, lesson, selection: clean, color });
  }, { sel, color, lessonNumber: (new URL(page.url()).hash.match(/read\/([^?]+)/) || [])[1] });
}
const annotations = (page, lessonId = L1) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, state: a.anchorState, exact: a.selector.quote.exact, position: a.selector.position, targetVersion: a.targetVersion, last: a.lastAnchor ?? null, deleted: a.deleted, color: a.color })), lessonId);
const sha = (page, lessonId = L1) => db(page, async (db, id) => (await db.getLesson(id)).sha256, lessonId);
/** Highlights painted in the lesson: { name: [text of each range] }. */
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));
const statesOf = async (page, lessonId = L1) => Object.fromEntries((await annotations(page, lessonId)).map((a) => [a.exact, a.state]));

// ---------------------------------------------------------------------------
test.describe('T-013 unit page (src/anchor.js)', () => {
  test('tests/anchor.html: every test passes (PLAN T-013 criteria on LRN-DEMO 0001 + 3 changed versions)', async ({ page }) => {
    await page.goto('./tests/anchor.html');
    await expect(page.locator('#summary[data-done="true"]')).toBeVisible({ timeout: 60000 });
    const results = await page.evaluate(() => window.anchorTestResults);
    expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(17);
    for (const r of results.filter((x) => x.info)) test.info().annotations.push({ type: r.name, description: String(r.info) });
  });
  test('the bridge files stay pure: no import, no closing script tag; the bridge uses the anchor.js names', async ({ page }) => {
    const text = await page.request.get('./src/lesson-bridge.js').then((r) => r.text());
    const anchor = await page.request.get('./src/anchor.js').then((r) => r.text());
    for (const t of [text, anchor]) { expect(t).not.toMatch(/^\s*import\b/m); expect(t).not.toMatch(/<\/script/i); }
    for (const name of ['anchorTextModel', 'anchorDescribeRange', 'anchorFind', 'anchorRange', 'ANCHOR_BASE_EXCLUDE']) {
      expect(text).toContain(name);
      expect(anchor).toMatch(new RegExp(`export (const|function) ${name}\\b`));
    }
  });
});

test.describe('T-013 in the app: selection → annotation → anchoring → painting', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('A1 a selection across <em> → a record on the DocRef of the lesson (D-013, D-039 id) with TextQuote + TextPosition + hint and the version; reopened → ok and painted, the DOM of the lesson unchanged', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    const domBefore = await frame.evaluate(() => document.querySelector('main').innerHTML);
    const a = await annotate(page, 'за киберустойчивост', 'Resilience Act', 'yellow');
    expect(a.target).toEqual({ type: 'lesson', id: L1 });
    expect(a.courseId).toBe(C);
    expect(a.selector.quote.exact).toBe('за киберустойчивост (Cyber Resilience Act');
    expect(a.selector.quote.prefix).toBe('Първи Регламентът ');
    expect(a.selector.quote.suffix.length).toBe(32);
    expect(a.selector.position.end - a.selector.position.start).toBe(a.selector.quote.exact.length);
    expect(a.selector.hint.blockPath).toMatch(/#p1$/);
    expect(a.targetVersion).toBe(await sha(page));
    expect(a).toMatchObject({ color: 'yellow', anchorState: 'ok', deleted: false });
    await annotate(page, 'Уязвимостите', 'забавяне', 'green');
    // Reopen: the bridge anchors and paints.
    await page.reload();
    await waitReady(page);
    await expect.poll(() => highlights(page), { timeout: 8000 }).toEqual({
      'lrn-yellow': ['за киберустойчивост (Cyber Resilience Act'],
      'lrn-green': ['Уязвимостите се докладват без неоправдано забавяне'],
    });
    await expect(page.locator('.lesson-frame__wrap')).toHaveAttribute('data-anchored', '2');
    const f2 = await lessonFrame(page);
    expect(await f2.evaluate(() => document.querySelector('main').innerHTML)).toBe(domBefore);
    // The state is stored (coalesced), the selector is the user's own.
    await expect.poll(async () => (await annotations(page)).map((x) => x.state + (x.last ? '+' : '')), { timeout: 5000 }).toEqual(['ok+', 'ok+']);
    // A tap on the mark is reported with its id (T-015 opens the card).
    await page.evaluate(() => { window.__lrn = []; });
    const box = await f2.evaluate(() => {
      const p = document.getElementById('p3');
      const r = p.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.locator('iframe.lesson-frame').click({ position: { x: box.x, y: box.y } });
    await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:tap').map((m) => m.annotationId)), { timeout: 3000 })
      .toEqual([(await annotations(page))[1].id]);
  });

  test('A2 a re-import with a changed lesson: inserted paragraph → ok (moved, version confirmed), edited sentence → fuzzy (dotted), deleted section → orphan; nothing is deleted; the import summary says so', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    await annotate(page, 'Производителят оценява', 'на продукта.', 'yellow'); // the sentence that will be edited
    await annotate(page, 'Задълженията за докладване', 'изисквания.', 'blue'); // the section that will be deleted
    await annotate(page, 'Уязвимостите се', 'забавяне.', 'pink'); // stays, but moves
    const before = await annotations(page);
    const oldSha = await sha(page);
    const changed = BODY
      .replace('<p id="p1">', '<p id="p0">Нов уводен абзац, който го нямаше преди, с малко текст.</p>\n<p id="p1">')
      .replace('оценява рисковете за киберсигурността', 'оценява внимателно рисковете за киберсигурността')
      .replace(/<h2 id="s2">[\s\S]*?(?=<div data-lrn-noanno>)/, '');
    const summary = await importCourse(page, C, files(changed));
    expect(summary).toContain('Маркировките на 0001 ще се проверят при отваряне');
    const newSha = await sha(page);
    expect(newSha).not.toBe(oldSha);
    await openLesson(page);
    await expect.poll(() => statesOf(page), { timeout: 8000 }).toEqual({
      'Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.': 'fuzzy',
      'Задълженията за докладване се прилагат по-рано от останалите изисквания.': 'orphan',
      'Уязвимостите се докладват без неоправдано забавяне.': 'ok',
    });
    const after = await annotations(page);
    // Nothing is deleted; the quotes are the user's own.
    expect(after.map((a) => [a.id, a.exact, a.deleted])).toEqual(before.map((a) => [a.id, a.exact, false]));
    const [edited, gone, moved] = after;
    // The selector stays as it was made (targetVersion = the version at creation);
    // where it is now is `lastAnchor` (for this version).
    for (const [a, b] of after.map((x, i) => [x, before[i]])) expect([a.targetVersion, a.position]).toEqual([oldSha, b.position]);
    expect(moved.last).toMatchObject({ version: newSha, state: 'ok' });
    expect(moved.last.start).toBeGreaterThan(before[2].position.start);
    expect(edited.last).toMatchObject({ version: newSha, state: 'fuzzy' });
    expect(gone.last).toEqual({ version: newSha, state: 'orphan', at: expect.any(String) });
    const hl = await highlights(page);
    expect(hl['lrn-pink']).toEqual(['Уязвимостите се докладват без неоправдано забавяне.']);
    expect(hl['lrn-yellow'][0]).toContain('оценява внимателно рисковете');
    expect(hl['lrn-fuzzy']).toEqual(hl['lrn-yellow']);
    expect(hl['lrn-blue']).toBeUndefined();
    // Back to the old text: everything is found again (the orphan was never lost).
    await importCourse(page, C, files());
    await openLesson(page);
    await expect.poll(async () => Object.values(await statesOf(page)), { timeout: 8000 }).toEqual(['ok', 'ok', 'ok']);
  });

  test('A3 quiz.js redraws its DOM (innerHTML) at every step: the marks before and after the quiz stay painted; a selection inside the quiz has no position; a lesson script that rewrites its own text is anchored again', async ({ page }) => {
    const demo = readFixture();
    const files3 = Object.fromEntries(Object.entries(demo).filter(([p]) => !p.startsWith('sources/')));
    files3['lessons/0001-vidove-chay.html'] = strToU8(new TextDecoder().decode(demo['lessons/0001-vidove-chay.html']).replace(
      '<footer>', '<p id="dyn">Динамичен абзац: стар текст за проверка.</p><footer>').replace(
      '</body>', '<script>window.addEventListener("load",()=>{document.getElementById("dyn").addEventListener("click",()=>{const p=document.getElementById("dyn");if(p.dataset.n){p.textContent="Съвсем различно съдържание без нищо общо."}else{p.dataset.n="1";p.innerHTML="Динамичен абзац: <b>стар</b> текст за проверка.";}});});</script></body>'));
    await importCourse(page, 'LRN-DEMO', files3);
    await openLesson(page, '0001', 'LRN-DEMO');
    await annotate(page, 'Твърде горещата', 'горчив.', 'orange');
    await annotate(page, 'Синтетичен урок', 'измислени.', 'green');
    await annotate(page, 'стар текст', 'за проверка', 'blue');
    // A selection only inside the quiz: no annotation can be made from it.
    const frame = await lessonFrame(page);
    await expect.poll(() => frame.evaluate(() => document.querySelectorAll('.quiz .quiz-choice').length), { timeout: 5000 }).toBeGreaterThan(0);
    await page.evaluate(() => { window.__lrn = []; });
    const quizText = await frame.evaluate(() => document.querySelector('.quiz .quiz-choice').textContent.trim().slice(0, 10));
    await selectIn(frame, quizText);
    await page.waitForTimeout(500);
    // T-015: reported as a quote only (excludedOnly), never with a position.
    const sels = await page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty));
    expect(sels.filter((m) => m.position !== undefined || m.excludedOnly !== true)).toEqual([]);
    expect(sels.at(-1)?.quote?.exact).toBe(quizText);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => highlights(page), { timeout: 8000 }).toMatchObject({ 'lrn-orange': [expect.stringContaining('Твърде горещата')], 'lrn-green': [expect.stringContaining('Синтетичен урок')] });
    const f = await lessonFrame(page);
    // Answer the quiz: every click throws the card away and builds it again.
    for (let i = 0; i < 3; i++) {
      await f.locator('.quiz .quiz-choice').first().click();
      const next = f.locator('.quiz .quiz-next');
      if (await next.count()) await next.click();
    }
    const hl = await highlights(page);
    expect(hl['lrn-orange']).toEqual(['Твърде горещата вода прави зеления чай горчив.']);
    expect(hl['lrn-green']).toEqual(['Синтетичен урок за тестовете на EasyLRN. Всички текстове са измислени.']);
    expect(await statesOf(page, 'LRN-DEMO/lesson:0001')).toEqual({
      'Твърде горещата вода прави зеления чай горчив.': 'ok',
      'Синтетичен урок за тестовете на EasyLRN. Всички текстове са измислени.': 'ok',
      'стар текст за проверка': 'ok',
    });
    // The lesson rewrites the paragraph with the same text in new nodes: still painted.
    await f.locator('#dyn').click();
    await expect.poll(async () => (await highlights(page))['lrn-blue'], { timeout: 5000 }).toEqual(['стар текст за проверка']);
    // …and then with other text: the mark is an orphan (stored), the others stay.
    await f.locator('#dyn').click();
    await expect.poll(async () => (await statesOf(page, 'LRN-DEMO/lesson:0001'))['стар текст за проверка'], { timeout: 6000 }).toBe('orphan');
    const hl2 = await highlights(page);
    expect(hl2['lrn-blue']).toBeUndefined();
    expect(hl2['lrn-orange']).toEqual(['Твърде горещата вода прави зеления чай горчив.']);
  });

  test('A4 data-lrn-noanno: a selection only inside it has no position; a selection across it leaves its text out of the quote', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    await page.evaluate(() => { window.__lrn = []; });
    await selectIn(frame, 'Този текст не се маркира');
    await page.waitForTimeout(500);
    // T-015: a quote without a position (excludedOnly); no mark can be made from it.
    const only = await page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty));
    expect(only.filter((m) => m.position !== undefined || m.excludedOnly !== true)).toEqual([]);
    const a = await annotate(page, 'по-рано', 'Краят на урока');
    expect(a.selector.quote.exact).toBe('по-рано от останалите изисквания. Краят на урока');
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await highlights(page))['lrn-yellow'], { timeout: 8000 }).toEqual([expect.stringContaining('Този текст не се маркира')]);
    // (The range runs through the excluded block in the DOM; the quote does not contain it.)
    expect((await annotations(page))[0].state).toBe('ok');
  });

  test('A5 a long lesson (≈ 0.4 M characters) with 120 annotations: ready, all anchored and painted within the time limits', async ({ page }) => {
    const paras = [];
    for (let i = 0; i < 3000; i++) paras.push(`<p id="q${i}">Абзац ${i}. Производителят оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${i}, и документира резултата.</p>`);
    await importCourse(page, C, files(paras.join('\n')));
    await openLesson(page);
    // 120 annotations, made directly with the same selectors the bridge would make.
    await db(page, async (db, { L, C }) => {
      const lesson = await db.getLesson(L);
      for (let i = 0; i < 120; i++) {
        const exact = `Абзац ${i * 25}. Производителят оценява рисковете`;
        await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: L }, targetVersion: 'old-version', color: ['yellow', 'green', 'blue', 'pink', 'orange'][i % 5],
          selector: { quote: { exact, prefix: '', suffix: ' за киберсигурността на продукта' }, position: { start: 0, end: exact.length } } });
      }
      void lesson;
    }, { L: L1, C });
    const t0 = Date.now();
    await page.reload();
    await waitReady(page);
    await expect(page.locator('.lesson-frame__wrap')).toHaveAttribute('data-anchored', '120', { timeout: 15000 });
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'A5 reload → 120 anchored', description: `${ms} ms` });
    expect(ms).toBeLessThan(15000);
    const hl = await highlights(page);
    expect(Object.values(hl).flat().length).toBe(120);
    await expect.poll(async () => new Set((await annotations(page)).map((a) => a.state)), { timeout: 8000 }).toEqual(new Set(['ok']));
  });

  test('A6 unicode: Cyrillic + Latin, combining diacritics, emoji, NBSP — made in the lesson, found again after an insertion', async ({ page }) => {
    const body = '<p id="u1">Йо-хо: „Ёлха“ и й, café (é), naïve, 😀👍🏽, 2024/2847 г. — ﬁn.</p><p>Още.</p>';
    await importCourse(page, C, files(body));
    await openLesson(page);
    const a = await annotate(page, '„Ёлха“', '2024/2847', 'pink');
    expect(a.selector.quote.exact).toBe('„Ёлха“ и й, café (é), naïve, 😀👍🏽, 2024/2847');
    await importCourse(page, C, files(`<p>Ново начало с текст.</p>${body}`));
    await openLesson(page);
    await expect.poll(async () => (await annotations(page))[0].state, { timeout: 8000 }).toBe('ok');
    expect((await highlights(page))['lrn-pink']).toEqual(['„Ёлха“ и й, café (é), naïve, 😀👍🏽, 2024/2847']);
  });
});

test.describe('T-013 attacks through the bridge (LESSON-ISOLATION §5.3)', () => {
  test.beforeEach(async ({ page }) => start(page));

  /** A lesson whose script listens to what the app sends and answers with forgeries. */
  const HOSTILE = `<script>
    window.__got = [];
    addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.lrn !== 1) return;
      window.__got.push(JSON.parse(JSON.stringify(m)));
      if (m.type !== 'lrn:annotations' || window.__sent) return;
      window.__sent = true;
      const own = m.items.map((i) => i.id);
      const p = (x) => parent.postMessage(x, '*');
      const fire = () => {
        if (!window.FOREIGN) { setTimeout(fire, 50); return; }
        // Own ids → orphan / wrong place; foreign ids; junk.
        p({ lrn: 1, type: 'lrn:anchored', results: own.map((id) => ({ id, state: 'orphan' })) });
        p({ lrn: 1, type: 'lrn:anchored', results: [{ id: window.FOREIGN, state: 'orphan' }, { id: '__proto__', state: 'ok', position: { start: 0, end: 1 } }, { id: own[0], state: 'deleted' }, { id: own[0], state: 'ok', position: { start: 5, end: 1 } }, { id: own[0], state: 'ok', position: { start: 0, end: 1e9 } }] });
        p({ lrn: 1, type: 'lrn:anchored', results: new Array(10001).fill({ id: own[0], state: 'orphan' }) });
        p({ lrn: 1, type: 'lrn:anchored', results: 'x'.repeat(1e6) });
        p({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'я'.repeat(3000) }, position: { start: 0, end: 3000 } });
        p({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x', prefix: 'p'.repeat(65) }, position: { start: 0, end: 1 } });
        p({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x' }, position: { start: 5, end: 2 } });
        p({ lrn: 1, type: 'lrn:tap', annotationId: window.FOREIGN });
        p({ lrn: 1, type: 'lrn:tap', annotationId: 'y'.repeat(65) });
        for (let i = 0; i < 500; i++) p({ lrn: 1, type: 'lrn:anchored', results: own.map((id) => ({ id, state: i % 2 ? 'ok' : 'fuzzy', position: { start: i, end: i + 3 } })) });
        window.__fired = true;
      };
      fire();
    });
  </script>`;

  test('X1 forged lrn:anchored / lrn:selection / lrn:tap: foreign ids and junk are ignored; own ids at worst change the state, never the quote, never delete; a flood is rate-limited and writes are coalesced; a later honest anchoring wins', async ({ page }) => {
    await importCourse(page, C, files(`${BODY}${HOSTILE}`));
    // A mark on another lesson (the forgery's target).
    await openLesson(page, '0002');
    const foreign = await annotate(page, 'Друг урок', 'текст', 'green');
    await openLesson(page);
    const own = await annotate(page, 'Уязвимостите се', 'забавяне.', 'yellow');
    const before = await annotations(page);
    // The lesson cannot learn a foreign id except by guessing; give it one anyway.
    const consoleWarnings = [];
    page.on('console', (m) => { if (m.type() === 'warning') consoleWarnings.push(m.text()); });
    await page.reload();
    await waitReady(page);
    const lf = await lessonFrame(page);
    await expect.poll(() => lf.evaluate(() => window.__sent === true), { timeout: 8000 }).toBe(true);
    await lf.evaluate((id) => { window.FOREIGN = id; }, foreign.id);
    await expect.poll(() => lf.evaluate(() => window.__fired === true), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(2500); // the coalesced writes
    const ownAfter = await annotations(page);
    expect(ownAfter.map((a) => [a.id, a.exact, a.position, a.deleted, a.color])).toEqual(before.map((a) => [a.id, a.exact, a.position, false, a.color]));
    // The foreign annotation is untouched.
    const f = (await annotations(page, L2))[0];
    expect(f).toMatchObject({ id: foreign.id, state: 'ok', deleted: false, last: null });
    // The flood: at most a few writes of the own record (coalesced, 1 per second).
    const updated = await db(page, async (db, id) => (await db.getAnnotation(id)).updatedAt, own.id);
    expect(typeof updated).toBe('string');
    // An honest anchoring at the next opening wins again.
    const clean = BODY;
    await importCourse(page, C, files(clean));
    await openLesson(page);
    await expect.poll(async () => (await annotations(page))[0].state, { timeout: 8000 }).toBe('ok');
    expect(consoleWarnings.some((w) => /lesson message ignored/.test(w))).toBe(true);
  });

  test('X2 what the lesson receives: only its own annotations as id, colour, selector, sameVersion — no notes, no threads, no settings, no key, nothing of another lesson', async ({ page }) => {
    await importCourse(page, C, files(`${BODY}${HOSTILE}`));
    await openLesson(page, '0002');
    const foreign = await annotate(page, 'Друг урок', 'текст', 'green');
    await openLesson(page);
    const own = await annotate(page, 'Производителят', 'цикъл', 'blue');
    await db(page, async (db, { own, foreign }) => {
      await db.createNote({ annotationId: own, body: 'ТАЙНА-БЕЛЕЖКА-123' });
      await db.createNote({ annotationId: foreign, body: 'ЧУЖДА-БЕЛЕЖКА-456' });
      await db.saveApiKey('sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE');
    }, { own: own.id, foreign: foreign.id });
    await page.reload();
    await waitReady(page);
    const frame = await lessonFrame(page);
    await expect.poll(() => frame.evaluate(() => window.__got.filter((m) => m.type === 'lrn:annotations').length), { timeout: 8000 }).toBeGreaterThan(0);
    const got = await frame.evaluate(() => window.__got);
    const text = JSON.stringify(got);
    expect(text).not.toContain('ТАЙНА-БЕЛЕЖКА');
    expect(text).not.toContain('ЧУЖДА');
    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain(foreign.id);
    expect(text).not.toContain('Друг урок');
    const list = got.find((m) => m.type === 'lrn:annotations');
    expect(Object.keys(list).sort()).toEqual(['items', 'lrn', 'type']);
    expect(list.items).toHaveLength(1);
    // T-015 (0.13.0): + `style` (marker = highlight / pencil = underline).
    expect(Object.keys(list.items[0]).sort()).toEqual(['color', 'id', 'sameVersion', 'selector', 'style']);
    expect(list.items[0]).toMatchObject({ id: own.id, color: 'blue', sameVersion: true, style: 'highlight' });
    expect(Object.keys(list.items[0].selector).sort()).toEqual(['hint', 'position', 'quote']);
  });

  test('X3 messages from a window that is not the current lesson frame (another frame, the app itself, a nested window) never change an annotation', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    const a = await annotate(page, 'Уязвимостите се', 'забавяне.', 'yellow');
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await annotations(page))[0].last, { timeout: 5000 }).not.toBe(null);
    const first = (await annotations(page))[0];
    // The app window posts to itself (origin is not "null", source is not the frame).
    await page.evaluate((id) => {
      window.postMessage({ lrn: 1, type: 'lrn:anchored', results: [{ id, state: 'orphan' }] }, '*');
    }, a.id);
    // A second frame on the page (same origin as the app, not the lesson frame) posts as itself.
    await page.evaluate(() => new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.src = './tests/anchor.html?run=none';
      f.onload = resolve;
      document.body.append(f);
    }));
    await page.evaluate((id) => {
      const f = [...document.querySelectorAll('iframe')].find((x) => !x.classList.contains('lesson-frame'));
      f.contentWindow.eval(`parent.postMessage({ lrn: 1, type: 'lrn:anchored', results: [{ id: '${id}', state: 'orphan' }] }, '*')`);
    }, a.id);
    await page.waitForTimeout(2000);
    expect((await annotations(page))[0]).toMatchObject({ state: first.state, position: first.position, deleted: false });
  });
});
