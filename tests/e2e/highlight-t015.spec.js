// T-015 (developer, 0.13.0): marking with colours (F2.1, F2.3; D-012, D-019,
// UI-DESIGN §5, ARCHITECTURE §4.4, LESSON-ISOLATION §5).
// - a selection in the opaque lesson → the FIXED bottom bar (never a floating
//   menu) with the quote and five colours → a tap on a colour makes the mark,
//   the selection in the lesson is cleared, the mark is painted and survives
//   a reload; all five colours;
// - a tap on a mark → its card in the bar (pressed colour, another colour,
//   delete with "Отмени"; a confirmation when notes/threads/topics hang on
//   it) and a frame around it in the lesson (lrn:focus);
// - the signs in the margin (buttons: touch and keyboard), Escape;
// - "Маркировки за проверка": fuzzy ("Провери" → "Да, тук е" updates the
//   selector) and orphan marks (kept, can be deleted);
// - a selection only in an exercise / data-lrn-noanno: no colours; quiz.js
//   keeps working after marking;
// - the bar keeps the selection above it; light and dark theme (pixels of
//   the mark); a rotation moves the signs with the text;
// - the lesson is untrusted: forged lrn:tap / lrn:selection / lrn:layout /
//   lrn:described change nothing; it receives only its own annotations;
// - src/highlight.js on a document of the app (the notes, answers and topics of
//   T-017+).
// Both orientations (playwright.config.js), touch emulation (hasTouch: taps).
// Synthetic data only, fake keys, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile, readFixture } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/c\/LRN-/.test(m.location()?.url || '')) return; // the hostile lessons break themselves on purpose
    problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
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
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});

const C = 'LRN-T15';
const L1 = `${C}/lesson:0001`;
const lessonHtml = (title, body, head = '') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const filler = Array.from({ length: 14 }, (_, i) => `<p id="f${i}">Допълнителен абзац ${i} с обикновен текст, за да има урокът височина и да се превърта като истински урок.</p>`).join('\n');
const BODY = [
  '<p id="p1">Регламентът за киберустойчивост (<em>Cyber Resilience Act</em>) се прилага за продукти с цифрови елементи.</p>',
  '<h2 id="s1">Задължения</h2>',
  '<p id="p2">Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.</p>',
  '<p id="p3">Уязвимостите се докладват без неоправдано забавяне.</p>',
  '<div data-lrn-noanno><p id="nx">Този текст не се маркира: бележка на автора.</p></div>',
  '<h2 id="s2">Срокове</h2>',
  '<p id="p4">Задълженията за докладване се прилагат по-рано от останалите изисквания.</p>',
  filler,
  '<p id="p5">Краят на урока е тук, след всички абзаци.</p>',
].join('\n');
const files = (body = BODY, course = C) => ({
  'INDEX.md': `# ${course}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', body),
  'lessons/0002-vtori.html': lessonHtml('Втори', '<p id="o1">Друг урок с текст за киберсигурността.</p>'),
});
const toBytes = (fs) => Object.fromEntries(Object.entries(fs).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
async function importCourse(page, id, fs) {
  const f = asFile(`${id}.zip`, makeZip(toBytes(fs), { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) {
  return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
}
async function openLesson(page, number = '0001', course = C) {
  const hash = `#/c/${course}/read/${number}`;
  if (new URL(page.url()).hash === hash) await page.reload(); else await page.goto(`./${hash}`);
  await waitReady(page);
  return lessonFrame(page);
}
/** Select from the start of `from` to the end of `to` in the lesson (as the handles of a finger would). */
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
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(r);
  }, { from, to });
}
const bar = (page) => page.locator('[data-field="markbar"]');
/** The app clears the selection in the lesson through a message: wait for it before selecting again. */
const collapsed = (frame) => expect.poll(() => frame.evaluate(() => document.getSelection().isCollapsed)).toBe(true);
const color = (page, c) => bar(page).locator(`.markbar__color[data-color="${c}"]`);
const annotations = (page, id = L1) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, exact: a.selector.quote.exact, color: a.color, state: a.anchorState, deleted: a.deleted, targetVersion: a.targetVersion, position: a.selector.position })), id);
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));
/** Mark `from…to` with a colour through the bar, by touch. */
async function markWithBar(page, from, to, c = 'yellow', lessonId = L1) {
  const frame = await lessonFrame(page);
  await selectIn(frame, from, to);
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toHaveAttribute('data-mode', 'selection');
  const before = (await annotations(page, lessonId)).length;
  await color(page, c).tap();
  await expect.poll(async () => (await annotations(page, lessonId)).length).toBe(before + 1);
  await expect(bar(page)).toBeHidden();
}
/** The centre of the first line of `text` in the lesson, in page coordinates (for a tap). */
async function pointOf(page, text) {
  const frame = await lessonFrame(page);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  const r = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i + 1);
      range.setEnd(n, i + Math.min(needle.length, 6));
      const rect = range.getClientRects()[0];
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`not found ${needle}`);
  }, text);
  return { x: box.x + r.x, y: box.y + r.y };
}
async function tapText(page, text) {
  await page.locator('iframe.lesson-frame').scrollIntoViewIfNeeded();
  const frame = await lessonFrame(page);
  await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(needle)) { n.parentElement.scrollIntoView({ block: 'center' }); return; }
  }, text);
  // The app window scrolls (the frame has no scroll of its own): bring the line to the middle.
  const p0 = await pointOf(page, text);
  const vh = page.viewportSize().height;
  if (p0.y < 120 || p0.y > vh - 300) await page.evaluate((dy) => window.scrollBy(0, dy), p0.y - vh / 2);
  const p = await pointOf(page, text);
  await page.touchscreen.tap(p.x, p.y);
}

// ===========================================================================
test.describe('T015-B the bottom bar and the colours', () => {
  test('B1 a selection shows the FIXED bottom bar (quote, 5 named colours, Бележка/Въпрос/Развий as "скоро"); a tap on a colour makes the mark, clears the selection, paints it; it survives a reload; the lesson DOM is unchanged', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    const htmlBefore = await frame.evaluate(() => document.body.innerHTML);
    await selectIn(frame, 'Производителят оценява', 'жизнен цикъл');
    await expect(bar(page)).toBeVisible();
    // Fixed at the very bottom of the viewport, the full width.
    const vp = page.viewportSize();
    const box = await bar(page).boundingBox();
    expect(Math.round(box.y + box.height)).toBe(vp.height);
    expect(Math.round(box.width)).toBe(vp.width);
    expect(await bar(page).evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    await expect(bar(page).locator('[data-field="markbar-quote"]')).toHaveText('«Производителят оценява рисковете за киберсигурността през целия жизнен цикъл»');
    await expect(bar(page).locator('.markbar__color')).toHaveCount(5);
    await expect(color(page, 'yellow')).toHaveAttribute('aria-label', 'Жълт (Важно)');
    for (const a of ['note', 'ask', 'expand']) await expect(bar(page).locator(`[data-action="${a}"]`)).toHaveAttribute('aria-disabled', 'true');
    // Buttons big enough for a finger (UI-DESIGN §9: 48 px in the bar).
    for (const b of await bar(page).locator('button:visible').all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await bar(page).locator('[data-action="ask"]').tap({ force: true }); // aria-disabled: it only says "скоро"
    await expect(bar(page).locator('[data-field="markbar-status"]')).toContainText('следваща версия');
    await color(page, 'yellow').tap();
    await expect(bar(page)).toBeHidden();
    const [a] = await annotations(page);
    expect(a).toMatchObject({ exact: 'Производителят оценява рисковете за киберсигурността през целия жизнен цикъл', color: 'yellow', state: 'ok', deleted: false });
    await expect.poll(() => highlights(page)).toMatchObject({ 'lrn-yellow': ['Производителят оценява рисковете за киберсигурността през целия жизнен цикъл'] });
    expect(await frame.evaluate(() => document.getSelection().isCollapsed)).toBe(true);
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Маркирано: Жълт.');
    expect(await frame.evaluate(() => document.body.innerHTML)).toBe(htmlBefore);
    await openLesson(page);
    await expect.poll(() => highlights(page), { timeout: 8000 }).toMatchObject({ 'lrn-yellow': ['Производителят оценява рисковете за киберсигурността през целия жизнен цикъл'] });
  });

  test('B2 all five colours; each survives a reload; one sign per mark in the margin, in its colour', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    const parts = [['Регламентът', 'yellow'], ['Производителят', 'green'], ['Уязвимостите', 'blue'], ['Задълженията', 'pink'], ['Краят на урока', 'orange']];
    for (const [t, c] of parts) await markWithBar(page, t, t, c);
    await openLesson(page);
    await expect.poll(async () => Object.keys(await highlights(page)).sort(), { timeout: 8000 }).toEqual(['lrn-blue', 'lrn-green', 'lrn-orange', 'lrn-pink', 'lrn-yellow']);
    const signs = page.locator('.marks-gutter__sign');
    await expect(signs).toHaveCount(5);
    expect(await signs.evaluateAll((els) => els.map((e) => e.dataset.color))).toEqual(parts.map(([, c]) => c));
    // The signs are in the order of the text, each at its line or below the previous one.
    const tops = await signs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1] + 39);
  });

  test('B3 the bar keeps the selection above it: a selection low on the screen is scrolled up so the bar does not cover it', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    // Bring "Допълнителен абзац 9" to the last 40 px of the viewport.
    const p = await pointOf(page, 'Допълнителен абзац 9 ');
    const vh = page.viewportSize().height;
    await page.evaluate((dy) => window.scrollBy(0, dy), p.y - (vh - 40));
    await selectIn(frame, 'Допълнителен абзац 9 ', 'абзац 9 с обикновен');
    await expect(bar(page)).toBeVisible();
    await expect.poll(async () => {
      const barTop = (await bar(page).boundingBox()).y;
      const q = await pointOf(page, 'абзац 9 с обикновен');
      return q.y + 14 < barTop;
    }, { timeout: 3000 }).toBe(true);
  });

  test('B4 Escape (in the bar or in the lesson) and ✕ close the bar and clear the selection; a swipe down on the bar closes it too', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    await collapsed(frame);
    await selectIn(frame, 'Уязвимостите');
    await expect(bar(page)).toBeVisible();
    await color(page, 'green').focus();
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => frame.evaluate(() => document.getSelection().isCollapsed)).toBe(true);
    // Escape inside the lesson (a selection made with the keyboard there).
    await collapsed(frame);
    await selectIn(frame, 'Уязвимостите');
    await expect(bar(page)).toBeVisible();
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await expect(bar(page)).toBeHidden();
    await collapsed(frame);
    await selectIn(frame, 'Уязвимостите');
    await expect(bar(page)).toBeVisible();
    await bar(page).locator('[data-action="markbar-close"]').tap();
    await expect(bar(page)).toBeHidden();
    await collapsed(frame);
    await selectIn(frame, 'Уязвимостите');
    await expect(bar(page)).toBeVisible();
    // A swipe down on the top of the bar (pointer events of a finger).
    const q = await bar(page).locator('[data-field="markbar-quote"]').boundingBox();
    await bar(page).locator('.markbar__top').dispatchEvent('pointerdown', { pointerType: 'touch', clientX: q.x + 20, clientY: q.y + 5, isPrimary: true });
    await bar(page).locator('.markbar__top').dispatchEvent('pointerup', { pointerType: 'touch', clientX: q.x + 24, clientY: q.y + 95, isPrimary: true });
    await expect(bar(page)).toBeHidden();
    expect(await annotations(page)).toEqual([]);
  });

  test('B5 a selection only inside data-lrn-noanno: the bar shows the quote, the colours are off and it says why; no mark can be made', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    await selectIn(frame, 'Този текст не се маркира');
    await expect(bar(page)).toHaveAttribute('data-mode', 'excluded');
    await expect(bar(page).locator('[data-field="markbar-quote"]')).toHaveText('«Този текст не се маркира»');
    await expect(bar(page).locator('[data-field="markbar-note"]')).toContainText('не се маркира с цвят');
    for (const c of ['yellow', 'green', 'blue', 'pink', 'orange']) await expect(color(page, c)).toBeDisabled();
    await color(page, 'yellow').dispatchEvent('click');
    await page.waitForTimeout(300);
    expect(await annotations(page)).toEqual([]);
  });

  test('B6 LRN-DEMO: marks before and after the quiz, then quiz.js answered through: it still works and the marks stay; a selection in the quiz has no colours', async ({ page }) => {
    const demo = readFixture();
    await importCourse(page, 'LRN-DEMO', Object.fromEntries(Object.entries(demo).filter(([p]) => !p.startsWith('sources/'))));
    const frame = await openLesson(page, '0001', 'LRN-DEMO');
    const texts = await frame.evaluate(() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.parentElement.closest('p') || n.parentElement.closest('.quiz, [data-lrn-noanno], .reflect')) continue;
        const t = n.data.trim();
        if (t.length > 30 && !/\s\s|\n/.test(t)) out.push(t.slice(0, 20).trim());
      }
      return [out[0], out.at(-1)];
    });
    const count = async () => db(page, async (db) => (await db.annotationsFor({ type: 'lesson', id: 'LRN-DEMO/lesson:0001' })).length);
    for (const t of texts) {
      await selectIn(frame, t);
      await expect(bar(page)).toHaveAttribute('data-mode', 'selection');
      const n = await count();
      await color(page, 'pink').tap();
      await expect.poll(count).toBe(n + 1);
    }
    // quiz.js: choose and go on (each step redraws the quiz with innerHTML).
    await expect.poll(() => frame.locator('.quiz .quiz-choice').count(), { timeout: 5000 }).toBeGreaterThan(0);
    const quizText = (await frame.locator('.quiz .quiz-choice').first().textContent()).trim().slice(0, 8);
    await selectIn(frame, quizText);
    await expect(bar(page)).toHaveAttribute('data-mode', 'excluded');
    await bar(page).locator('[data-action="markbar-close"]').tap();
    for (let i = 0; i < 3; i++) {
      const choice = frame.locator('.quiz .quiz-choice:not([disabled])').first();
      if (await choice.count()) await choice.click();
      const next = frame.locator('.quiz .quiz-next');
      if (await next.count()) await next.click();
    }
    await expect(frame.locator('.quiz')).not.toBeEmpty();
    await page.waitForTimeout(800);
    expect(((await highlights(page))['lrn-pink'] || []).length).toBe(2);
  });
});

// ===========================================================================
test.describe('T015-K the card of a mark', () => {
  test('K1 a tap on a mark opens its card (pressed colour) and frames it in the lesson; another colour; a tap elsewhere closes it and removes the frame', async ({ page }) => {
    await importCourse(page, C, files());
    const frame = await openLesson(page);
    await markWithBar(page, 'Уязвимостите се докладват', 'Уязвимостите се докладват', 'blue');
    await tapText(page, 'Уязвимостите се докладват');
    await expect(bar(page)).toHaveAttribute('data-mode', 'mark');
    await expect(bar(page).locator('[data-field="markbar-quote"]')).toHaveText('«Уязвимостите се докладват»');
    await expect(color(page, 'blue')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => frame.evaluate(() => document.querySelectorAll('[data-easylrn="focus"] > div').length)).toBeGreaterThan(0);
    // The frame is outside <body>: not in the text, not seen by the lesson's observer of <body>.
    expect(await frame.evaluate(() => document.querySelector('[data-easylrn="focus"]').parentElement === document.documentElement)).toBe(true);
    await color(page, 'orange').tap();
    await expect.poll(async () => (await annotations(page))[0].color).toBe('orange');
    await expect(color(page, 'orange')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => highlights(page)).toMatchObject({ 'lrn-orange': ['Уязвимостите се докладват'] });
    expect((await highlights(page))['lrn-blue']).toBeUndefined();
    await tapText(page, 'Регламентът за киберустойчивост');
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => frame.evaluate(() => document.querySelectorAll('[data-easylrn="focus"]').length)).toBe(0);
  });

  test('K2 delete: the mark goes (soft delete), "Отмени" brings it back; the sign in the margin opens the card too (keyboard: Enter)', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    await markWithBar(page, 'Задълженията за докладване', 'Задълженията за докладване', 'pink');
    const sign = page.locator('.marks-gutter__sign');
    await expect(sign).toHaveCount(1);
    await sign.focus();
    await page.keyboard.press('Enter');
    await expect(bar(page)).toHaveAttribute('data-mode', 'mark');
    await bar(page).locator('[data-action="delete"]').tap();
    await expect(bar(page)).toHaveAttribute('data-mode', 'undo');
    await expect(bar(page).locator('[data-field="markbar-quote"]')).toHaveText('Маркировката е изтрита.');
    await expect.poll(async () => (await annotations(page))[0].deleted).toBe(true);
    await expect.poll(async () => (await highlights(page))['lrn-pink']).toBeUndefined();
    await expect(sign).toHaveCount(0);
    await bar(page).locator('[data-action="undo"]').tap();
    await expect.poll(async () => (await annotations(page))[0].deleted).toBe(false);
    await expect.poll(() => highlights(page)).toMatchObject({ 'lrn-pink': ['Задълженията за докладване'] });
    await expect(bar(page)).toHaveAttribute('data-mode', 'mark');
    // Delete again and let the undo time out: it stays deleted.
    await bar(page).locator('[data-action="delete"]').tap();
    await expect(bar(page)).toBeHidden({ timeout: 12000 });
    expect((await annotations(page))[0].deleted).toBe(true);
  });

  test('K3 a mark with a note and a thread: delete asks first (the safe answer has the focus; Escape = Отказ); "Изтрий" deletes', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    await markWithBar(page, 'Регламентът за киберустойчивост', 'Регламентът за киберустойчивост', 'green');
    const [a] = await annotations(page);
    await db(page, async (db, id) => { await db.createNote({ annotationId: id, body: 'Бележка T15' }); await db.createThread({ annotationId: id }); }, a.id);
    await tapText(page, 'Регламентът за киберустойчивост');
    await expect(bar(page)).toHaveAttribute('data-mode', 'mark');
    await bar(page).locator('[data-action="delete"]').tap();
    const box = bar(page).locator('[role="alertdialog"]');
    await expect(box).toContainText('1 бележка, 1 нишка с въпроси');
    await expect(box.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    expect((await annotations(page))[0].deleted).toBe(false);
    await bar(page).locator('[data-action="delete"]').tap();
    await bar(page).locator('[data-field="confirm-yes"]').tap();
    await expect.poll(async () => (await annotations(page))[0].deleted).toBe(true);
  });
});

// ===========================================================================
test.describe('T015-C marks to check after a changed lesson', () => {
  test('C1 a re-import: a fuzzy mark ("Провери" → the card says why → "Да, тук е" makes its selector the new place) and an orphan (kept, listed, can be deleted)', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    await markWithBar(page, 'Производителят оценява рисковете', 'жизнен цикъл на продукта', 'yellow');
    await markWithBar(page, 'Уязвимостите се докладват', 'забавяне', 'green');
    await markWithBar(page, 'Регламентът', 'Регламентът', 'blue');
    const changed = BODY
      .replace('Производителят оценява рисковете за киберсигурността', 'Производителят внимателно оценява рисковете за киберсигурността')
      .replace('<p id="p3">Уязвимостите се докладват без неоправдано забавяне.</p>', '');
    const summary = await importCourse(page, C, files(changed));
    expect(summary).toContain('Маркировките');
    await openLesson(page);
    const box = page.locator('[data-field="marks-check"]');
    await expect(box).toBeVisible({ timeout: 8000 });
    await expect(box.locator('summary')).toHaveText('⚠ Маркировки за проверка: 1 за проверка · 1 неприкачена');
    await box.locator('summary').tap();
    await expect(box.locator('[data-state="orphan"] .marks-check__quote')).toHaveText('«Уязвимостите се докладват без неоправдано забавяне»');
    await expect.poll(() => highlights(page)).toMatchObject({ 'lrn-fuzzy': ['Производителят внимателно оценява рисковете за киберсигурността през целия жизнен цикъл на продукта'] });
    const shaNow = await db(page, async (db, id) => (await db.getLesson(id)).sha256, L1);
    await box.locator('[data-state="fuzzy"] [data-action="check-mark"]').tap();
    await expect(bar(page)).toHaveAttribute('data-mode', 'mark');
    await expect(bar(page).locator('[data-field="markbar-note"]')).toContainText('Провери');
    await bar(page).locator('[data-action="confirm-place"]').tap();
    await expect(bar(page).locator('[data-field="markbar-status"]')).toHaveText('Мястото е потвърдено.');
    const list = await annotations(page);
    const fixed = list.find((x) => x.color === 'yellow');
    expect(fixed).toMatchObject({ exact: 'Производителят внимателно оценява рисковете за киберсигурността през целия жизнен цикъл на продукта', state: 'ok', targetVersion: shaNow });
    await expect.poll(async () => (await highlights(page))['lrn-fuzzy']).toBeUndefined();
    await expect(box.locator('summary')).toHaveText('⚠ Маркировки за проверка: 1 неприкачена');
    // The orphan: deleted from the list, with "Отмени" in the bar.
    await box.locator('[data-state="orphan"] [data-action="delete-orphan"]').tap();
    await expect(bar(page)).toHaveAttribute('data-mode', 'undo');
    await expect(box).toBeHidden();
    expect((await annotations(page)).find((x) => x.color === 'green').deleted).toBe(true);
    // The blue one was never touched.
    expect((await annotations(page)).find((x) => x.color === 'blue')).toMatchObject({ exact: 'Регламентът', state: 'ok', deleted: false });
    await openLesson(page);
    await expect.poll(async () => (await annotations(page)).filter((x) => !x.deleted).map((x) => x.state), { timeout: 8000 }).toEqual(['ok', 'ok']);
  });
});

// ===========================================================================
test.describe('T015-V themes, rotation', () => {
  /** The most common colour in a small box of the screenshot around the mark. */
  async function markPixel(page, text) {
    await tapTextNoTap(page, text);
    const p = await pointOf(page, text);
    const shot = await page.screenshot({ clip: { x: p.x - 10, y: p.y - 3, width: 20, height: 6 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const count = new Map();
      for (let i = 0; i < d.length; i += 4) { const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; count.set(k, (count.get(k) || 0) + 1); }
      return [...count].sort((a, b) => b[1] - a[1])[0][0];
    }, shot.toString('base64'));
  }
  async function tapTextNoTap(page, text) {
    const p0 = await pointOf(page, text);
    const vh = page.viewportSize().height;
    if (p0.y < 120 || p0.y > vh - 200) await page.evaluate((dy) => window.scrollBy(0, dy), p0.y - vh / 2);
  }
  for (const scheme of ['light', 'dark']) {
    test(`V1 ${scheme}: the mark has the colour of the ${scheme} palette in the lesson; the bar follows the theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await importCourse(page, C, files());
      await openLesson(page);
      await markWithBar(page, 'Уязвимостите се докладват без', 'Уязвимостите се докладват без', 'yellow');
      const want = scheme === 'dark' ? '92,82,22' : '255,241,168';
      await expect.poll(() => markPixel(page, 'Уязвимостите се докладват без'), { timeout: 5000 }).toBe(want);
      const frame = await lessonFrame(page);
      await selectIn(frame, 'Краят на урока');
      await expect(bar(page)).toBeVisible();
      const bg = await bar(page).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe(scheme === 'dark' ? 'rgb(21, 21, 19)' : 'rgb(255, 255, 248)');
    });
  }

  test('V2 rotation: the signs in the margin follow their lines (landscape ↔ portrait)', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    await markWithBar(page, 'Краят на урока', 'Краят на урока', 'green');
    const sign = page.locator('.marks-gutter__sign');
    const near = async () => {
      const s = await sign.boundingBox().catch(() => null);
      if (!s) return false;
      const p = await pointOf(page, 'Краят на урока');
      return Math.abs(s.y + 8 - (p.y - 10)) < 30;
    };
    await expect.poll(near).toBe(true);
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await expect.poll(near, { timeout: 5000 }).toBe(true);
    await page.setViewportSize(vp);
    await expect.poll(near, { timeout: 5000 }).toBe(true);
  });
});

// ===========================================================================
test.describe('T015-S the lesson is untrusted', () => {
  test('S1 forged messages: lrn:tap with a foreign id, lrn:selection "excludedOnly" with a position, lrn:layout with foreign ids, an unasked lrn:described — nothing opens, nothing is stored; the lesson gets only its own annotations', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page, '0002');
    await markWithBar(page, 'Друг урок', 'Друг урок', 'yellow', `${C}/lesson:0002`);
    const foreign = (await annotations(page, `${C}/lesson:0002`))[0];
    const spy = `<script>window.__got = []; addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__got.push(JSON.parse(JSON.stringify(e.data))); });</script>`;
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': lessonHtml('Първи', BODY + spy) });
    const frame = await openLesson(page);
    await markWithBar(page, 'Уязвимостите', 'Уязвимостите', 'blue');
    const own = (await annotations(page))[0];
    await frame.evaluate((ids) => {
      const p = (m) => parent.postMessage({ lrn: 1, ...m }, '*');
      p({ type: 'lrn:tap', annotationId: ids.foreign });
      p({ type: 'lrn:selection', empty: false, excludedOnly: true, quote: { exact: 'x' }, position: { start: 0, end: 1 } });
      p({ type: 'lrn:layout', items: [{ id: ids.foreign, top: 10, bottom: 20 }, { id: '__proto__', top: 1, bottom: 2 }], height: 100 });
      p({ type: 'lrn:described', annotationId: ids.own, quote: { exact: 'ПОДМЕНЕН', prefix: '', suffix: '' }, position: { start: 0, end: 8 } });
    }, { foreign: foreign.id, own: own.id });
    await page.waitForTimeout(600);
    await expect(bar(page)).toBeHidden();
    await expect(page.locator(`.marks-gutter__sign[data-annotation="${foreign.id}"]`)).toHaveCount(0);
    expect((await annotations(page))[0]).toEqual(own);
    expect((await annotations(page, `${C}/lesson:0002`))[0]).toEqual(foreign);
    // A card is open: the lesson receives the focus id, its own annotations, nothing else.
    await tapText(page, 'Уязвимостите');
    await expect(bar(page)).toHaveAttribute('data-mode', 'mark');
    const got = JSON.stringify(await frame.evaluate(() => window.__got));
    expect(got).not.toContain(foreign.id);
    expect(got).not.toContain('Друг урок');
    expect(got).toContain('"type":"lrn:focus"');
  });

  test('S2 "Да, тук е" with a lesson that lies in lrn:described: only this mark of this lesson takes the place the lesson gave (it is the lesson\'s own text; the user pressed the button), other marks unchanged', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    await markWithBar(page, 'Производителят оценява рисковете', 'Производителят оценява рисковете', 'yellow');
    await markWithBar(page, 'Краят на урока', 'Краят на урока', 'green');
    const before = await annotations(page);
    const liar = `<script>addEventListener('message', (e) => { if (e.data && e.data.type === 'lrn:describe') { e.stopImmediatePropagation(); parent.postMessage({ lrn: 1, type: 'lrn:described', annotationId: e.data.annotationId, quote: { exact: 'измислен цитат', prefix: '', suffix: '' }, position: { start: 1, end: 15 } }, '*'); } }, true);</script>`;
    const changed = BODY.replace('Производителят оценява рисковете', 'Производителят внимателно оценява рисковете');
    await importCourse(page, C, files(changed + liar));
    await openLesson(page);
    await expect(page.locator('[data-field="marks-check"]')).toBeVisible({ timeout: 8000 });
    await page.locator('[data-field="marks-check"] summary').tap();
    await page.locator('[data-action="check-mark"]').tap();
    await bar(page).locator('[data-action="confirm-place"]').tap();
    await expect(bar(page).locator('[data-field="markbar-status"]')).toHaveText('Мястото е потвърдено.');
    const after = await annotations(page);
    expect(after.find((a) => a.color === 'yellow').exact).toBe('измислен цитат');
    expect(after.find((a) => a.color === 'green')).toEqual(before.find((a) => a.color === 'green'));
  });
});

// ===========================================================================
test.describe('T015-H src/highlight.js on a document of the app', () => {
  test('H1 describe a selection, paint 2 colours + fuzzy, hit-test the innermost, focus; two documents share the registry; nothing changes in their DOM', async ({ page }, ti) => {
    test.skip(ti.project.name !== 'tablet-landscape', 'a pure module: once is enough');
    const r = await page.evaluate(async () => {
      const H = await import('./src/highlight.js');
      const make = (html) => { const el = document.createElement('div'); el.className = 'md'; el.innerHTML = html; document.querySelector('#main').append(el); return el; };
      const a = make('<p>Бележка: <strong>регламентът</strong> казва това, а Комисията тълкува друго.</p>');
      const b = make('<p>Отговор на учителя с друг текст.</p>');
      const before = a.innerHTML;
      const ha = H.createDocHighlighter(a);
      const hb = H.createDocHighlighter(b);
      const t = a.querySelector('p').firstChild;
      const sel = getSelection();
      const r1 = document.createRange(); r1.setStart(t, 9); r1.setEnd(a.querySelector('p').lastChild, 24);
      sel.removeAllRanges(); sel.addRange(r1);
      const s1 = ha.describe(sel);
      const none = hb.describe(sel); // the selection is not in b
      const m = (exact) => ({ quote: { exact, prefix: '', suffix: '' } });
      const res = ha.paint([{ id: 'x1', color: 'yellow', selector: s1 }, { id: 'x2', color: 'blue', selector: m('регламентът') }, { id: 'x3', color: 'green', selector: m('Комисията тълкува друго!') }]);
      hb.paint([{ id: 'y1', color: 'yellow', selector: m('Отговор') }]);
      const names = () => Object.fromEntries([...CSS.highlights].filter(([k]) => k.startsWith('lrn-app-')).map(([k, h]) => [k, [...h].map((x) => x.toString())]));
      const painted = names();
      const rect = a.querySelector('strong').getBoundingClientRect();
      const hit = ha.hitTest(rect.left + 4, rect.top + rect.height / 2);
      ha.focus('x2');
      const focused = names()['lrn-app-focus'];
      hb.destroy();
      const afterDestroy = names()['lrn-app-yellow'];
      ha.destroy();
      sel.removeAllRanges();
      a.remove(); b.remove();
      return { s1: s1.quote.exact, none, res, painted, hit, focused, afterDestroy, same: before === a.innerHTML, left: names() };
    });
    expect(r.s1).toBe('регламентът казва това, а Комисията');
    expect(r.none).toBe(null);
    expect(r.res.map((x) => x.state)).toEqual(['ok', 'ok', 'fuzzy']);
    expect(r.painted['lrn-app-yellow'].sort()).toEqual(['Отговор', 'регламентът казва това, а Комисията'].sort());
    expect(r.painted['lrn-app-blue']).toEqual(['регламентът']);
    expect(r.painted['lrn-app-fuzzy']).toEqual(['Комисията тълкува друго.']); // '!' → '.': one substitution
    expect(r.hit).toBe('x2'); // inside both x1 and x2: the shorter one
    expect(r.focused).toEqual(['регламентът']);
    expect(r.afterDestroy).toEqual(['регламентът казва това, а Комисията']);
    expect(r.same).toBe(true);
    expect(r.left).toEqual({});
  });
});
