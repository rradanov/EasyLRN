// T-015 (developer, 0.13.0): marking with tools (D-042) through the real lesson frame.
// - the tool bar left of the lesson (marker, pencil, eraser, 5 colours, "Отмени"):
//   ≥ 44 px, names, aria-pressed, keyboard (toolbar arrows, Enter, Escape, Ctrl+Z);
// - touch (CDP Input.dispatchTouchEvent): one finger draws (live preview, whole
//   words), two fingers scroll the app window, a pinch never draws; the eraser
//   (through a mark / a tap), "Отмени"; another colour; a reload keeps the marks
//   and the colour (since T-062 not the tool); pen (pointerType pen) draws and the palm is ignored;
// - re-anchoring after a change of the lesson ("Маркировки за проверка": провери,
//   "Да, тук е", изтрий); quiz.js in the lesson (a tap with a tool presses its
//   buttons; marks survive its redraw); `data-lrn-noanno`; dark theme (the lesson's
//   own background decides the palette; contrast); without a tool: no layer;
// - attacks: lrn:stroked that nobody asked for, foreign ids, a lesson that
//   posts lrn:stroke to itself, what the lesson receives.
// Synthetic data only, fake keys, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile, readFixture } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 90000 });

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
const LONG = Array.from({ length: 90 }, (_, i) => `<p id="f${i}">Допълнителен абзац ${i} за превъртане: текстът тук е само за да е урокът по-дълъг от екрана на таблета.</p>`).join('\n');
const BODY = [
  '<p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи на пазара.</p>',
  '<p id="p2">Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.</p>',
  '<p id="p3">Уязвимостите се докладват без неоправдано забавяне на органите.</p>',
  '<div data-lrn-noanno><p id="nx">Този текст не се маркира: бележка на автора.</p></div>',
  '<p id="p4">Задълженията за докладване се прилагат по-рано от останалите изисквания.</p>',
  LONG,
  '<p id="p5">Краят на урока е тук.</p>',
].join('\n');
const C = 'LRN-T15';
const files = (body = BODY, extra = {}) => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', body),
  'lessons/0002-vtori.html': lessonHtml('Втори', '<p id="q1">Друг урок с текст за киберсигурността.</p>'),
  ...extra,
});
const L1 = `${C}/lesson:0001`;

const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function openLesson(page, number = '0001', course = C) {
  const hash = `#/c/${course}/read/${number}`;
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  // The bridge has the list (an empty one too) once lrn:anchored came.
  await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 10000 }).toBe(true);
  return lessonFrame(page);
}
async function lessonFrame(page) {
  const handle = await page.locator('iframe.lesson-frame').elementHandle();
  return handle.contentFrame();
}
const annotations = (page, lessonId = L1) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, state: a.anchorState, exact: a.selector.quote.exact, position: a.selector.position, deleted: a.deleted, color: a.color, style: a.style, targetVersion: a.targetVersion })), lessonId);
const live = async (page, lessonId = L1) => (await annotations(page, lessonId)).filter((a) => !a.deleted);
/** Highlights painted in the lesson: { name: [text of each range] }. */
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));

/**
 * The box (app viewport coordinates) of `needle` inside the lesson: of the
 * characters [from, to) of it, or all of it. The app window is scrolled so
 * that the text is in the middle of the screen first.
 */
async function textBox(page, needle, { from = 0, to = null, scroll = true } = {}) {
  const frame = await lessonFrame(page);
  const rel = await frame.evaluate(({ needle, from, to }) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + from);
      r.setEnd(n, i + (to ?? needle.length));
      const rects = [...r.getClientRects()];
      const first = rects[0];
      const last = rects.at(-1);
      return { left: first.left, top: first.top, height: first.height, right: last.right, bottom: last.bottom, lastTop: last.top };
    }
    throw new Error(`not found: ${needle}`);
  }, { needle, from, to });
  if (scroll) {
    const box = await page.locator('iframe.lesson-frame').boundingBox();
    const vh = page.viewportSize().height;
    const y = box.y + rel.top;
    if (y < 120 || y > vh - 200) {
      await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(y - vh / 2));
      await page.waitForTimeout(50);
    }
  }
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return {
    x1: box.x + rel.left, y1: box.y + rel.top + rel.height / 2,
    x2: box.x + rel.right, y2: box.y + rel.lastTop + (rel.bottom - rel.lastTop) / 2,
  };
}

/** Touch through CDP (real touch events → pointer events with pointerType "touch"). */
async function touchApi(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 4, radiusY: 4, force: 1 })),
  });
  return {
    cdp,
    /** One finger from a to b in `steps` moves; `during` runs before the finger lifts. */
    async drag([ax, ay], [bx, by], { steps = 14, during = null } = {}) {
      await send('touchStart', [[ax, ay]]);
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', [[ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps]]);
        await page.waitForTimeout(8);
      }
      if (during) await during();
      await send('touchEnd', []);
    },
    async tap([x, y]) {
      await send('touchStart', [[x, y]]);
      await send('touchEnd', []);
    },
    /** Two fingers moving together by (dx, dy), and apart by `spread` (a pinch). */
    async two([x, y], dx, dy, { steps = 12, spread = 0, gap = 120 } = {}) {
      const at = (i) => {
        const k = i / steps;
        const half = (gap + spread * k) / 2;
        return [[x - half + dx * k, y + dy * k], [x + half + dx * k, y + dy * k]];
      };
      await send('touchStart', [at(0)[0]]);
      await page.waitForTimeout(20);
      await send('touchStart', at(0));
      for (let i = 1; i <= steps; i++) { await send('touchMove', at(i)); await page.waitForTimeout(8); }
      await send('touchEnd', []);
    },
  };
}
const tool = (page, name) => page.locator(`[data-field="mark-tools"] [data-tool="${name}"]`);
const color = (page, name) => page.locator(`[data-field="mark-tools"] [data-color="${name}"]`);
const undoButton = (page) => page.locator('[data-field="mark-tools"] [data-action="undo"]');
const count = async (page, lessonId = L1) => (await live(page, lessonId)).length;
async function waitMarks(page, n, lessonId = L1) {
  await expect.poll(() => count(page, lessonId), { timeout: 5000 }).toBe(n);
}

// ---------------------------------------------------------------------------
test.describe('T-015 tools: the bar, drawing with one finger, scrolling with two', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
  });

  test('B1 the bar is left of the lesson, in the app: 3 tools, 5 colours in the D-042 order, "Отмени"; ≥ 44 px, names, aria-pressed; no tool → no layer', async ({ page }) => {
    await openLesson(page);
    const bar = page.locator('[data-field="mark-tools"]');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('role', 'toolbar');
    const barBox = await bar.boundingBox();
    const frameBox = await page.locator('iframe.lesson-frame').boundingBox();
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(frameBox.x + 1);
    const tools = await bar.locator('[data-tool]').evaluateAll((els) => els.map((e) => [e.dataset.tool, e.getAttribute('aria-label'), e.getAttribute('aria-pressed')]));
    expect(tools).toEqual([['marker', 'Маркер', 'false'], ['pencil', 'Молив', 'false'], ['eraser', 'Гума', 'false']]);
    const colours = await bar.locator('[data-color]').evaluateAll((els) => els.map((e) => [e.dataset.color, e.getAttribute('aria-label'), e.getAttribute('aria-pressed')]));
    expect(colours).toEqual([
      ['yellow', 'Жълт (Важно)', 'true'], ['green', 'Зелен (Ясно)', 'false'], ['blue', 'Син (Дефиниция)', 'false'],
      ['orange', 'Оранжев (Пример)', 'false'], ['pink', 'Розов (Неясно)', 'false'],
    ]);
    await expect(undoButton(page)).toBeDisabled();
    for (const b of await bar.locator('button').all()) {
      const box = await b.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('[data-field="mark-layer"]')).toBeHidden();
    // The bar stays on the screen while the lesson scrolls (sticky).
    await page.evaluate(() => window.scrollTo(0, 1500));
    const after = await bar.boundingBox();
    expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.y + after.height).toBeLessThanOrEqual(page.viewportSize().height);
    // Inside the lesson nothing of the bar (it is the app's).
    const frame = await lessonFrame(page);
    expect(await frame.evaluate(() => document.querySelectorAll('[data-field="mark-tools"], button[data-tool]').length)).toBe(0);
  });

  test('D1 marker: one finger from the middle of a word to the middle of another → the whole words, live preview while dragging, saved (highlight, yellow, D-012 selectors), painted; the app did not scroll; the lesson DOM unchanged', async ({ page }) => {
    const frame = await openLesson(page);
    const dom = await frame.evaluate(() => document.body.innerHTML);
    await tool(page, 'marker').click();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-field="mark-layer"]')).toBeVisible();
    const t = await touchApi(page);
    const a = await textBox(page, 'киберустойчивост', { from: 4, to: 5 }); // inside "киберустойчивост"
    const b = await textBox(page, 'продукти', { from: 3, to: 4 }); // inside "продукти"
    const y0 = await page.evaluate(() => window.scrollY);
    let preview = null;
    await t.drag([a.x1, a.y1], [b.x1, b.y1], { during: async () => { await page.waitForTimeout(80); preview = await highlights(page); } });
    expect(preview['lrn-pv-marker-yellow']).toEqual(['киберустойчивост се прилага за продукти']);
    await waitMarks(page, 1);
    const [m] = await live(page);
    expect(m).toMatchObject({ exact: 'киберустойчивост се прилага за продукти', color: 'yellow', style: 'highlight', state: 'ok' });
    expect(await page.evaluate(() => window.scrollY)).toBe(y0);
    await expect.poll(async () => (await highlights(page))['lrn-yellow']).toEqual(['киберустойчивост се прилага за продукти']);
    expect((await highlights(page))['lrn-pv-marker-yellow']).toBeUndefined();
    expect(await frame.evaluate(() => document.body.innerHTML)).toBe(dom);
    await expect(undoButton(page)).toBeEnabled();
    await expect(undoButton(page)).toHaveAttribute('aria-label', 'Отмени маркирането');
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Маркирано: Жълт.');
  });

  test('D2 pencil + marker on the same text live together; the pencil draws a line (text-decoration in ::highlight), the marker a background; dragging backwards and across lines works', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'pencil').click();
    await color(page, 'green').click();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    // Backwards: from "органите" to "Уязвимостите".
    const a = await textBox(page, 'органите', { from: 2, to: 3 });
    const b = await textBox(page, 'Уязвимостите', { from: 1, to: 2 });
    await t.drag([a.x1, a.y1], [b.x1, b.y1]);
    await waitMarks(page, 1);
    await tool(page, 'marker').click();
    await color(page, 'blue').click();
    const c = await textBox(page, 'докладват', { from: 1, to: 2 });
    const d = await textBox(page, 'забавяне', { from: 6, to: 7 });
    await t.drag([c.x1, c.y1], [d.x1, d.y1]);
    await waitMarks(page, 2);
    // Across two paragraphs.
    const e = await textBox(page, 'оценява', { from: 2, to: 3 });
    const f = await textBox(page, 'Уязвимостите', { from: 2, to: 3 });
    await t.drag([e.x1, e.y1], [f.x1, f.y1]);
    await waitMarks(page, 3);
    const list = await live(page);
    expect(list.map((x) => [x.exact, x.style, x.color])).toEqual([
      ['Уязвимостите се докладват без неоправдано забавяне на органите', 'underline', 'green'],
      ['докладват без неоправдано забавяне', 'highlight', 'blue'],
      ['оценява рисковете за киберсигурността през целия жизнен цикъл на продукта. Уязвимостите', 'highlight', 'blue'],
    ]);
    await expect.poll(async () => { const hl = await highlights(page); return [hl['lrn-u-green'], hl['lrn-blue']?.length]; })
      .toEqual([['Уязвимостите се докладват без неоправдано забавяне на органите'], 2]);
    // The pencil really draws a line: pixels of the pencil colour right under the text.
    const frame = await lessonFrame(page);
    const lineColor = await frame.evaluate(() => [...document.querySelectorAll('style[data-easylrn="bridge"]')].map((s) => s.textContent).join('').match(/::highlight\(lrn-u-green\)[^{]*\{[^}]*underline solid 3px (#[0-9a-f]+)/)?.[1]);
    expect(lineColor).toBe('#2e7d32');
  });

  test('S1 two fingers scroll the app window and draw nothing; a pinch draws nothing; a second finger landing during a moving stroke is a palm (T016-D2: the stroke goes on); the tool stays on', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    const a = await textBox(page, 'Производителят');
    const y0 = await page.evaluate(() => window.scrollY);
    await t.two([a.x1 + 100, a.y1 + 200], 0, -300);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y0 + 200);
    // Pinch (fingers apart) in place.
    await t.two([a.x1 + 100, page.viewportSize().height / 2], 0, 0, { spread: 300 });
    // A stroke, then a second finger joins while it moves (T-062, T016-D2: that is a
    // palm, not a scroll): the stroke goes on and is saved, the page does not scroll.
    const p = await textBox(page, 'Задълженията');
    const q = await textBox(page, 'изисквания');
    const cdp = t.cdp;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x1 + 5, y: p.y1, id: 0 }] });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x1 + 5 + i * 40, y: p.y1, id: 0 }] });
    const ys = await page.evaluate(() => window.scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x1 + 245, y: p.y1, id: 0 }, { x: q.x1, y: q.y1 + 60, id: 1 }] });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x1 + 245, y: p.y1 - i * 20, id: 0 }, { x: q.x1, y: q.y1 + 60 - i * 20, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitMarks(page, 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(ys);
    expect((await live(page))[0].exact).toMatch(/Задълженията/);
    const hl = await highlights(page);
    expect(Object.keys(hl).filter((k) => k.startsWith('lrn-pv'))).toEqual([]);
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    // And one finger still draws after it.
    const r = await textBox(page, 'Краят на урока');
    await t.drag([r.x1 + 2, r.y1], [r.x2 - 2, r.y2]);
    await waitMarks(page, 2);
  });

  test('S2 without a tool one finger scrolls the lesson as usual (no layer, nothing drawn); a second tap on the active tool turns it off', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    await tool(page, 'marker').click();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-field="mark-layer"]')).toBeHidden();
    const t = await touchApi(page);
    const a = await textBox(page, 'Производителят');
    const y0 = await page.evaluate(() => window.scrollY);
    await t.drag([a.x1 + 50, a.y1 + 300], [a.x1 + 50, a.y1 - 100], { steps: 20 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y0 + 100);
    await page.waitForTimeout(300);
    expect(await count(page)).toBe(0);
  });

  test('E1 eraser through a mark and a tap on a mark (both kinds) → deleted (soft); "Отмени" brings them back; "Отмени" of a mark removes it', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const a = await textBox(page, 'Регламентът');
    const b = await textBox(page, 'цифрови');
    await t.drag([a.x1 + 3, a.y1], [b.x2 - 3, b.y1]);
    await waitMarks(page, 1);
    await tool(page, 'pencil').click();
    const c = await textBox(page, 'Производителят');
    const d = await textBox(page, 'рисковете');
    await t.drag([c.x1 + 3, c.y1], [d.x2 - 3, d.y1]);
    await waitMarks(page, 2);
    // Undo of the last mark (the pencil) removes it; draw it again.
    await undoButton(page).click();
    await waitMarks(page, 1);
    await t.drag([c.x1 + 3, c.y1], [d.x2 - 3, d.y1]);
    await waitMarks(page, 2);
    await tool(page, 'eraser').click();
    await expect(tool(page, 'eraser')).toHaveAttribute('aria-pressed', 'true');
    // Through the marker mark: a vertical stroke over "прилага".
    const e = await textBox(page, 'прилага', { from: 3, to: 4 });
    await t.drag([e.x1, e.y1 - 30], [e.x1, e.y1 + 6], { steps: 8 });
    await waitMarks(page, 1);
    // A tap on the pencil line.
    const f = await textBox(page, 'оценява', { from: 2, to: 3 });
    await t.tap([f.x1, f.y1]);
    await waitMarks(page, 0);
    expect((await annotations(page)).every((x) => x.deleted)).toBe(true);
    await expect.poll(async () => Object.keys(await highlights(page)).filter((k) => /^lrn-(u-)?[a-z]+$/.test(k) && k !== 'lrn-fuzzy')).toEqual([]);
    await expect(undoButton(page)).toHaveAttribute('aria-label', 'Отмени изтриването');
    await undoButton(page).click();
    await waitMarks(page, 1);
    await undoButton(page).click();
    await waitMarks(page, 2);
    await expect.poll(async () => { const hl = await highlights(page); return [hl['lrn-yellow'], hl['lrn-u-yellow']]; })
      .toEqual([['Регламентът за киберустойчивост се прилага за продукти с цифрови'], ['Производителят оценява рисковете']]);
    // The eraser over plain text erases nothing.
    const g = await textBox(page, 'Задълженията');
    await t.drag([g.x1, g.y1], [g.x2, g.y1]);
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(2);
  });

  test('C1 colours (touch taps on the bar, also right after a stroke): a colour while the eraser is on → back to the last drawing tool with that colour; the marks get it; the colour is kept after a reload (the tool is not: T-062), and the marks too', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'pencil').tap();
    await tool(page, 'eraser').tap();
    await color(page, 'pink').tap();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    await expect(color(page, 'pink')).toHaveAttribute('aria-pressed', 'true');
    await expect(color(page, 'yellow')).toHaveAttribute('aria-pressed', 'false');
    const a = await textBox(page, 'Задълженията');
    await t.drag([a.x1 + 3, a.y1], [a.x2 - 3, a.y1]);
    await waitMarks(page, 1);
    // Taps right after a stroke (Chrome may drop the click of such a tap: the bar acts on pointerup).
    await color(page, 'orange').tap();
    await expect(color(page, 'orange')).toHaveAttribute('aria-pressed', 'true');
    await tool(page, 'marker').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    const b = await textBox(page, 'изисквания');
    await t.drag([b.x1 + 3, b.y1], [b.x2 - 3, b.y1]);
    await waitMarks(page, 2);
    expect((await live(page)).map((x) => [x.exact, x.style, x.color])).toEqual([['Задълженията', 'underline', 'pink'], ['изисквания', 'highlight', 'orange']]);
    await page.reload();
    await waitReady(page);
    // T-062 (D-042 addendum): a lesson opens without a tool; the colour (and the last tool) are kept.
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await expect(color(page, 'orange')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-field="mark-layer"]')).toBeHidden();
    await expect.poll(async () => { const hl = await highlights(page); return [hl['lrn-u-pink'], hl['lrn-orange']]; }).toEqual([['Задълженията'], ['изисквания']]);
    // "Отмени" is per opening: nothing to undo after a reload.
    await expect(undoButton(page)).toBeDisabled();
    // Another lesson: no tool either, the same colour.
    await openLesson(page, '0002');
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await expect(color(page, 'orange')).toHaveAttribute('aria-pressed', 'true');
  });

  test('N1 data-lrn-noanno and the gap between paragraphs: a stroke only there makes nothing; a stroke over it from text to text skips its text; a stroke inside a mark of the same kind and colour makes no copy', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const n = await textBox(page, 'Този текст не се маркира');
    await t.drag([n.x1 + 2, n.y1], [n.x2 - 2, n.y1]);
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(0);
    const a = await textBox(page, 'органите');
    const b = await textBox(page, 'Задълженията');
    await t.drag([a.x1 + 2, a.y1], [b.x2 - 2, b.y1]);
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('органите. Задълженията');
    // Inside it again: no copy.
    const c = await textBox(page, 'Задълженията', { from: 2, to: 3 });
    await t.drag([c.x1, c.y1], [c.x1 + 30, c.y1]);
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Този текст вече е маркиран така.');
    expect(await count(page)).toBe(1);
  });

  test('K1 keyboard: Tab to the bar, arrows move, Enter turns a tool on, Escape off (in the app and inside the lesson); a selection + the marker key marks it; Ctrl+Z undoes', async ({ page }) => {
    const frame = await openLesson(page);
    await page.locator('[data-field="mark-tools"] button[tabindex="0"]').focus();
    await expect(tool(page, 'marker')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(tool(page, 'pencil')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    // A selection in the lesson (as with Shift+arrows / the mouse), then the pencil from the keyboard.
    await frame.evaluate(() => {
      const n = document.getElementById('p3').firstChild;
      const r = document.createRange();
      r.setStart(n, 0); r.setEnd(n, 'Уязвимостите'.length);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length)).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    await tool(page, 'pencil').focus();
    await page.keyboard.press('Space');
    await waitMarks(page, 1);
    expect((await live(page))[0]).toMatchObject({ exact: 'Уязвимостите', style: 'underline', color: 'yellow' });
    expect(await frame.evaluate(() => getSelection().isCollapsed || getSelection().rangeCount === 0)).toBe(true);
    await page.keyboard.press('Control+z');
    await waitMarks(page, 0);
    // Escape inside the lesson turns the tool off too.
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('iframe.lesson-frame').focus();
    await frame.locator('body').press('Escape');
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'false');
  });

  test('P1 pen: pointerType pen draws; a touch (the palm) while the pen writes is ignored; a very large touch is ignored', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    const cdp = await page.context().newCDPSession(page);
    const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen' });
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'забавяне');
    await pen('mousePressed', a.x1 + 3, a.y1);
    // The palm lands and drags elsewhere while the pen writes.
    const p = await textBox(page, 'Задълженията', { scroll: false });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(p.x1), y: Math.round(p.y1), id: 5, radiusX: 4, radiusY: 4 }] });
    for (let i = 1; i <= 10; i++) {
      await pen('mouseMoved', a.x1 + 3 + ((b.x2 - 3 - a.x1 - 3) * i) / 10, a.y1);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(p.x1 + i * 20), y: Math.round(p.y1), id: 5, radiusX: 4, radiusY: 4 }] });
    }
    await pen('mouseReleased', b.x2 - 3, a.y1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitMarks(page, 1);
    await page.waitForTimeout(300);
    expect((await live(page)).map((x) => x.exact)).toEqual(['Уязвимостите се докладват без неоправдано забавяне']);
    // A huge contact (a palm without a pen) draws nothing either.
    await page.waitForTimeout(800);
    const c = await textBox(page, 'Краят на урока');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(c.x1), y: Math.round(c.y1), id: 0, radiusX: 60, radiusY: 60 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(c.x1 + i * 15), y: Math.round(c.y1), id: 0, radiusX: 60, radiusY: 60 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-015 tools: re-anchoring, quiz.js, theme, attacks', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('R1 a changed lesson re-imported: marks drawn with the tools are anchored again; "Маркировки за проверка" lists the fuzzy (провери, "Да, тук е") and the orphan (изтрий, "Отмени")', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const draw = async (from, to) => { const a = await textBox(page, from); const b = await textBox(page, to); await t.drag([a.x1 + 2, a.y1], [b.x2 - 2, b.y2]); };
    await draw('Производителят', 'продукта');
    await waitMarks(page, 1);
    await tool(page, 'pencil').click();
    await draw('Задълженията', 'изисквания');
    await waitMarks(page, 2);
    await draw('Регламентът', 'пазара');
    await waitMarks(page, 3);
    // v2: the first sentence edited, the second deleted, a paragraph inserted before.
    const v2 = BODY
      .replace('<p id="p1">', '<p>Нов въвеждащ абзац, който го нямаше.</p><p id="p1">')
      .replace('Производителят оценява рисковете', 'Производителят внимателно оценява рисковете')
      .replace(/<p id="p4">[^<]*<\/p>/, '');
    expect(await importCourse(page, C, files(v2))).not.toMatch(/^ERROR/);
    await openLesson(page);
    const box = page.locator('[data-field="marks-check"]');
    await expect(box).toBeVisible();
    await expect(box.locator('summary')).toHaveText('⚠ Маркировки за проверка: 1 за проверка · 1 неприкачена');
    await box.locator('summary').click();
    const fuzzy = box.locator('[data-state="fuzzy"]');
    const orphan = box.locator('[data-state="orphan"]');
    await expect(fuzzy.locator('.marks-check__quote')).toHaveText('«Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта»');
    await expect(orphan.locator('.marks-check__quote')).toHaveText('«Задълженията за докладване се прилагат по-рано от останалите изисквания»');
    await expect.poll(async () => (await highlights(page))['lrn-u-yellow']).toEqual(['Регламентът за киберустойчивост се прилага за продукти с цифрови елементи на пазара']);
    await fuzzy.locator('[data-action="show-mark"]').click();
    await fuzzy.locator('[data-action="confirm-mark"]').click();
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Мястото е потвърдено.');
    const conf = (await live(page)).find((a) => a.exact.startsWith('Производителят'));
    expect(conf).toMatchObject({ state: 'ok', exact: 'Производителят внимателно оценява рисковете за киберсигурността през целия жизнен цикъл на продукта' });
    await expect(box.locator('summary')).toHaveText('⚠ Маркировки за проверка: 1 неприкачена');
    await box.locator('[data-state="orphan"] [data-action="delete-mark"]').click();
    await waitMarks(page, 2);
    await expect(box).toBeHidden();
    await undoButton(page).click();
    await waitMarks(page, 3);
    await expect(box).toBeVisible();
  });

  test('Q1 LRN-DEMO: with the marker on, a tap presses the quiz buttons (quiz.js works to the end); marks survive its redraw; a stroke over the quiz makes nothing', async ({ page }) => {
    const all = readFixture();
    const f = asFile('LRN-DEMO.zip', makeZip(all));
    await page.evaluate(async ({ name, bytes }) => { const m = await import('./src/course-import.js'); await m.importCourse([new File([new Uint8Array(bytes)], name)]); }, { name: f.name, bytes: [...f.buffer] });
    const frame = await openLesson(page, '0001', 'LRN-DEMO');
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const a = await textBox(page, 'Твърде горещата');
    const b = await textBox(page, 'горчив');
    await t.drag([a.x1 + 2, a.y1], [b.x2 - 2, b.y1]);
    const DEMO = 'LRN-DEMO/lesson:0001';
    await waitMarks(page, 1, DEMO);
    /** The centre of an element of the lesson in app coordinates (the app window scrolls to it). */
    const quizBox = async (sel) => {
      await frame.locator(sel).first().waitFor();
      const box = await frame.locator(sel).first().boundingBox();
      if (box.y < 100 || box.y > page.viewportSize().height - 100) await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(box.y - page.viewportSize().height / 2));
      const again = await frame.locator(sel).first().boundingBox();
      return [again.x + again.width / 2, again.y + again.height / 2];
    };
    // A stroke over the quiz: nothing.
    const q = await quizBox('.quiz-text');
    await t.drag([q[0] - 100, q[1]], [q[0] + 100, q[1]]);
    await page.waitForTimeout(400);
    expect(await count(page, DEMO)).toBe(1);
    for (let i = 0; i < 3; i++) {
      await t.tap(await quizBox('.quiz-choice'));
      await expect(frame.locator('.quiz-next')).toBeVisible();
      await t.tap(await quizBox('.quiz-next'));
      if (i < 2) await expect(frame.locator('.quiz-head')).toContainText(`${i + 2} / 3`);
    }
    await expect(frame.locator('.quiz-result')).toHaveText(/Резултат: \d от 3/);
    await expect.poll(async () => (await highlights(page))['lrn-yellow']).toEqual(['Твърде горещата вода прави зеления чай горчив']);
    expect(await count(page, DEMO)).toBe(1);
  });

  test('V1 dark: a lesson with a dark background gets the dark palette (and a light one the light palette, even in a dark system); text on every marker colour ≥ 4.5:1, pencil lines ≥ 3:1; the bar follows the theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const darkHead = '<style>html,body{background:#151513;color:#e6e3da} @media (prefers-color-scheme: light){html,body{background:#fff;color:#111}}</style>';
    await importCourse(page, C, files(BODY, { 'lessons/0002-vtori.html': lessonHtml('Втори', '<p id="q1">Друг урок с текст за киберсигурността.</p>', darkHead) }));
    // The palettes as the bridge chose them.
    const chosen = async () => (await lessonFrame(page)).evaluate(() => {
      const css = [...document.querySelectorAll('style[data-easylrn="bridge"]')].map((s) => s.textContent).join('');
      return { marker: css.match(/::highlight\(lrn-yellow\)[^{]*\{ background-color: (#[0-9a-f]+)/)?.[1], pencil: css.match(/::highlight\(lrn-u-yellow\)[^{]*\{[^}]*3px (#[0-9a-f]+)/)?.[1] };
    });
    await openLesson(page, '0002');
    expect(await chosen()).toEqual({ marker: '#5c5216', pencil: '#ffd84d' });
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    const a = await textBox(page, 'Друг урок');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 1, `${C}/lesson:0002`);
    await expect.poll(async () => (await highlights(page))['lrn-yellow']).toEqual(['Друг урок']);
    // A picture for the log (the frame of the app shows the lesson too).
    const b = await textBox(page, 'Друг урок', { scroll: false });
    await page.screenshot({ path: test.info().outputPath('dark.png'), clip: { x: Math.max(0, Math.round(b.x1) - 40), y: Math.round(b.y1) - 30, width: 400, height: 60 } });
    // The lesson without a dark style: white canvas, light marks even in a dark system.
    await openLesson(page, '0001');
    expect(await chosen()).toEqual({ marker: '#fff1a8', pencil: '#8a6d00' });
    // Contrast of the palettes (WCAG): text on the marker, the pencil line on the paper.
    const ratio = await page.evaluate(async () => {
      const { HIGHLIGHT_PALETTE, PENCIL_PALETTE } = await import('./src/highlight.js');
      const lum = (hex) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const out = [];
      for (const [theme, ink, paper] of [['light', '#1b1b1b', '#ffffff'], ['dark', '#e6e3da', '#151513']]) {
        for (const c of Object.keys(HIGHLIGHT_PALETTE[theme])) {
          out.push([`${theme} text on ${c}`, cr(ink, HIGHLIGHT_PALETTE[theme][c])]);
          out.push([`${theme} line ${c}`, cr(PENCIL_PALETTE[theme][c], paper)]);
        }
      }
      return out;
    });
    for (const [name, r] of ratio) expect(r, name).toBeGreaterThanOrEqual(name.includes('text') ? 4.5 : 3);
    // The bar in the dark app: its background is the dark paper.
    const bg = await page.locator('[data-field="mark-tools"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(31, 30, 27)');
  });

  test('X1 attacks: an unasked lrn:stroked, one with foreign ids, a lesson posting lrn:stroke / lrn:annotations to itself → nothing saved or deleted; the lesson gets only its own marks (id, colour, style, selector)', async ({ page }) => {
    await importCourse(page, C, files());
    // A mark on lesson 0002 (another lesson: its id must never reach 0001).
    await openLesson(page, '0002');
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const q = await textBox(page, 'Друг урок');
    await t.drag([q.x1 + 2, q.y1], [q.x2 - 2, q.y1]);
    await expect.poll(async () => (await live(page, `${C}/lesson:0002`)).length).toBe(1);
    const foreign = (await live(page, `${C}/lesson:0002`))[0].id;
    await openLesson(page, '0001');
    await tool(page, 'marker').click(); // T-062: every lesson opens without a tool
    const a = await textBox(page, 'Регламентът');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 1);
    const own = (await live(page))[0].id;
    const frame = await lessonFrame(page);
    const before = await page.evaluate(() => window.__lrn.length);
    await frame.evaluate(({ foreign, own }) => {
      const p = window.parent;
      p.postMessage({ lrn: 1, type: 'lrn:stroked', seq: 1, tool: 'marker', quote: { exact: 'Производителят', prefix: '', suffix: '' }, position: { start: 100, end: 114 } }, '*');
      for (let s = 0; s < 50; s++) p.postMessage({ lrn: 1, type: 'lrn:stroked', seq: s, tool: 'eraser', ids: [foreign, own] }, '*');
      // The bridge's own handlers, called by the lesson (it can post to itself).
      window.postMessage({ lrn: 1, type: 'lrn:stroke', phase: 'start', seq: 9, tool: 'marker', color: 'yellow', x: 10, y: 10 }, '*');
      window.postMessage({ lrn: 1, type: 'lrn:stroke', phase: 'end', seq: 9, x: 400, y: 300 }, '*');
    }, { foreign, own });
    await page.waitForTimeout(800);
    expect(await page.evaluate((n) => window.__lrn.length - n, before)).toBeGreaterThan(0);
    expect((await live(page)).map((x) => x.id)).toEqual([own]);
    expect((await live(page, `${C}/lesson:0002`)).map((x) => x.id)).toEqual([foreign]);
    // A real eraser stroke now, while the lesson floods lrn:stroked with the foreign id: only its own goes.
    await tool(page, 'eraser').click();
    // (20 a second: under the app's limit of 60 messages a second; above it the
    // lesson only drops its own answers, see LESSON-ISOLATION §5.3.)
    await frame.evaluate((foreign) => { window.__flood = setInterval(() => { for (let s = 0; s < 2; s++) window.parent.postMessage({ lrn: 1, type: 'lrn:stroked', seq: s, tool: 'eraser', ids: [foreign] }, '*'); }, 100); }, foreign);
    const b = await textBox(page, 'Регламентът');
    await t.tap([b.x1 + 10, b.y1]);
    await waitMarks(page, 0);
    await frame.evaluate(() => clearInterval(window.__flood));
    expect((await live(page, `${C}/lesson:0002`)).map((x) => x.id)).toEqual([foreign]);
    // What the lesson receives: only its own items, with these fields only.
    await frame.evaluate(() => { window.__got = []; window.addEventListener('message', (e) => { if (e.data?.type === 'lrn:annotations') window.__got.push(e.data.items); }); });
    await undoButton(page).click();
    await waitMarks(page, 1);
    await expect.poll(() => frame.evaluate(() => window.__got.length)).toBeGreaterThan(0);
    const items = await frame.evaluate(() => window.__got.at(-1));
    expect(items.map((i) => i.id)).toEqual([own]);
    expect(Object.keys(items[0]).sort()).toEqual(['color', 'id', 'sameVersion', 'selector', 'style']);
    expect(items[0]).toMatchObject({ color: 'yellow', style: 'highlight' });
    expect(Object.keys(items[0].selector).sort()).toEqual(['hint', 'position', 'quote']);
  });
});
