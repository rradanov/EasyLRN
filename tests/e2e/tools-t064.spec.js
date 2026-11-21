// T-064 (developer, 0.13.2): the fixes of T063-D1/D2/D3/D4/D8 and T063-I6 from
// the side the T-063 tests do not cover:
// - T-065 (D-044): no undo from the lesson — a click / Tab / the lesson's own
//   focus() into it, then Ctrl+Z or a flood of lrn:undo, undo nothing; "Отмени"
//   and Ctrl+Z in the app undo;
// - the palm: a young stroke with a second touch that stays still → the stroke
//   goes on from its first point (replayed, the whole word); the second touch
//   lifting at once → the stroke goes on; a slow two-finger scroll with a
//   larger, slower contact that still keeps up (≥ 75 %) → scroll;
// - the bar: a double tap on "Скрий" stays hidden, a double tap on the handle
//   turns no tool on (the second tap is the rest of the first).
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });

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
  expect(problems.filter((p) => !/unasked: lrn:stroked/.test(p))).toEqual([]);
  expect(external).toEqual([]);
});
const landscapeOnly = (ti) => test.skip(ti.project.name !== 'tablet-landscape', 'pure module / one layout is enough');
const info = (type, value) => test.info().annotations.push({ type, description: typeof value === 'string' ? value : JSON.stringify(value) });

async function start(page) {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) { window.__lrn.push(e.data); (window.__t = window.__t || []).push([e.data.type, performance.now()]); } });
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
  '<p id="p4">Задълженията за докладване се прилагат по-рано от останалите изисквания.</p>',
  LONG,
  '<p id="p5">Краят на урока е тук.</p>',
].join('\n');
const C = 'LRN-T64';
const L1 = `${C}/lesson:0001`;
const files = (body = BODY, head = '') => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', body, head),
  'lessons/0002-vtori.html': lessonHtml('Втори', '<p id="q1">Друг урок с текст за киберсигурността.</p>'),
});

const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 30000 });
async function lessonFrame(page) {
  return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
}
async function openLesson(page, number = '0001') {
  const hash = `#/c/${C}/read/${number}`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload(); else await page.goto(`./${hash}`);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
const annotations = (page, lessonId = L1) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, state: a.anchorState, last: a.lastAnchor?.state ?? null, exact: a.selector.quote.exact, deleted: a.deleted })), lessonId);
const live = async (page, lessonId = L1) => (await annotations(page, lessonId)).filter((a) => !a.deleted);
const count = async (page, lessonId = L1) => (await live(page, lessonId)).length;
const waitMarks = (page, n, lessonId = L1) => expect.poll(() => count(page, lessonId), { timeout: 6000 }).toBe(n);

/** The box (app viewport) of `needle` in the lesson; the app window is scrolled to it first. */
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
      return { left: rects[0].left, top: rects[0].top, height: rects[0].height, right: rects.at(-1).right };
    }
    throw new Error(`not found: ${needle}`);
  }, { needle, from, to });
  if (scroll) {
    const box = await page.locator('iframe.lesson-frame').boundingBox();
    const vh = page.viewportSize().height;
    const y = box.y + rel.top;
    if (y < 250 || y > vh - 350) {
      await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(y - vh / 2));
      await page.waitForTimeout(60);
    }
  }
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return { x1: box.x + rel.left, x2: box.x + rel.right, y: box.y + rel.top + rel.height / 2 };
}
/** Raw input: touch points [x, y, id, radius = 4] and the pen. */
async function input(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map(([x, y, id, r = 4]) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: r, radiusY: r, force: 1 })),
  });
  const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen',
  });
  /** One finger along a word, `r` its radius. */
  const drag = async (a, { r = 4, steps = 10 } = {}) => {
    await touch('touchStart', [[a.x1 + 2, a.y, 1, r]]);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', [[a.x1 + 2 + ((a.x2 - a.x1 - 4) * i) / steps, a.y, 1, r]]); await page.waitForTimeout(8); }
    await touch('touchEnd', []);
  };
  return { cdp, touch, pen, drag };
}
const tool = (page, name) => page.locator(`[data-field="mark-tools"] [data-tool="${name}"]`);
const undoButton = (page) => page.locator('[data-field="mark-tools"] [data-action="undo"]');
const color = (page, name) => page.locator(`[data-field="mark-tools"] [data-color="${name}"]`);
const bar = (page) => page.locator('[data-field="mark-tools"]');
const handle = (page) => page.locator('[data-field="mark-tools-handle"]');
const hideButton = (page) => page.locator('[data-field="mark-tools"] [data-action="hide-tools"]');
const layer = (page) => page.locator('[data-field="mark-layer"]');
const stored = (page) => db(page, async (db) => (await db.getSettings()).markTool ?? null);
const scrollY = (page) => page.evaluate(() => window.scrollY);
/** A y in the middle band of the screen (room to move up and down). */
const midY = (page, y) => Math.min(Math.max(y, 450), page.viewportSize().height - 450);
const active = (page) => page.evaluate(() => document.activeElement?.tagName);
const status = (page) => page.locator('[data-field="marks-status"]');

// ===========================================================================
test.describe('T064 / T-065 no undo from the lesson (D-044): the ways in undo nothing; the app\'s own undo works', () => {
  const BTN = '<p><button id="lb" type="button">Бутон на урока</button></p>';
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files(BTN + BODY));
  });
  async function marks(page, words) {
    const frame = await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    let k = 0;
    for (const w of words) { await t.drag(await textBox(page, w)); await waitMarks(page, ++k); }
    await tool(page, 'marker').tap(); // the tool off: one finger / the mouse reach the lesson
    await expect(layer(page)).toBeHidden();
    return { frame, t };
  }
  const undos = (page) => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:undo').length);

  test('T064-U1 a click into the lesson after a quiet moment, Ctrl+Z → nothing undone, no lrn:undo sent; a flood of lrn:undo → nothing; "Отмени" and Ctrl+Z in the app undo one each', async ({ page }) => {
    const { frame } = await marks(page, ['Регламентът', 'Уязвимостите', 'Задълженията']);
    await page.waitForTimeout(1000);
    const a = await textBox(page, 'Производителят');
    await page.mouse.click(a.x1 + 10, a.y);
    await expect.poll(() => active(page)).toBe('IFRAME');
    await page.keyboard.press('Control+z');
    await frame.evaluate(() => { for (let i = 0; i < 20; i++) parent.postMessage({ lrn: 1, type: 'lrn:undo' }, '*'); });
    await page.waitForTimeout(500);
    expect(await count(page)).toBe(3);
    expect(await undos(page)).toBe(20); // only the posted ones: the bridge sent none
    await expect(status(page)).not.toHaveText(/Ctrl\+Z още веднъж/);
    await undoButton(page).click();
    await waitMarks(page, 2);
    expect((await live(page)).map((m) => m.exact).sort()).toEqual(['Регламентът', 'Уязвимостите'].sort());
    await tool(page, 'pencil').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Регламентът');
  });

  test('T064-U2 Tab from the app into the lesson (its button), Ctrl+Z → nothing undone; the focus back in the app, Ctrl+Z → one mark undone', async ({ page }) => {
    await marks(page, ['Регламентът', 'Уязвимостите']);
    await tool(page, 'pencil').focus();
    let inFrame = false;
    for (let i = 0; i < 12 && !inFrame; i++) { await page.keyboard.press('Tab'); inFrame = (await active(page)) === 'IFRAME'; }
    expect(inFrame).toBe(true);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(2);
    expect(await undos(page)).toBe(0);
    await tool(page, 'pencil').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Регламентът');
  });

  test('T064-U3 the lesson\'s own focus() right after the user\'s tap in the app, then Ctrl+Z and a flood of lrn:undo → nothing undone, no "press again", the focus not moved by the app', async ({ page }) => {
    const { frame } = await marks(page, ['Регламентът', 'Уязвимостите']);
    await frame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    await expect.poll(() => active(page)).toBe('IFRAME');
    await page.keyboard.press('Control+z');
    await frame.evaluate(() => { for (let i = 0; i < 60; i++) parent.postMessage({ lrn: 1, type: 'lrn:undo' }, '*'); });
    await page.waitForTimeout(500);
    expect(await count(page)).toBe(2);
    await expect(status(page)).not.toHaveText(/Ctrl\+Z още веднъж/);
    expect(await active(page)).toBe('IFRAME');
  });
});

// ===========================================================================
test.describe('T064 the palm: young strokes (T063-D1) and a drifting palm (T063-D2)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
    await openLesson(page);
    await tool(page, 'marker').tap();
    await expect(layer(page)).toBeVisible();
  });
  const pv = async (page) => (await lessonFrame(page)).evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith('lrn-pv') && CSS.highlights.get(k).size));

  test('T064-P1 a young stroke (15 px) + a palm landing and staying still → the stroke goes on FROM ITS FIRST POINT (the whole words), the page does not scroll', async ({ page }) => {
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'докладват', { scroll: false });
    const y0 = await scrollY(page);
    const P = [a.x1 + 60, a.y + 150, 2, 7];
    await t.touch('touchStart', [[a.x1 + 2, a.y, 1]]);
    for (let i = 1; i <= 3; i++) { await t.touch('touchMove', [[a.x1 + 2 + i * 5, a.y, 1]]); await page.waitForTimeout(10); }
    await t.touch('touchStart', [[a.x1 + 17, a.y, 1], P]);
    const x2 = b.x2 - 3;
    for (let i = 1; i <= 12; i++) { await t.touch('touchMove', [[a.x1 + 17 + ((x2 - a.x1 - 17) * i) / 12, a.y, 1], P]); await page.waitForTimeout(14); }
    await t.touch('touchEnd', [P]);
    await t.touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Уязвимостите се докладват');
    expect(Math.abs((await scrollY(page)) - y0)).toBeLessThan(2);
    await page.waitForTimeout(300);
    expect(await pv(page)).toEqual([]);
  });

  test('T064-P2 a young stroke + a second touch that lifts at once (a brush of the hand) → the stroke goes on, one mark', async ({ page }) => {
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'докладват', { scroll: false });
    await t.touch('touchStart', [[a.x1 + 2, a.y, 1]]);
    for (let i = 1; i <= 3; i++) { await t.touch('touchMove', [[a.x1 + 2 + i * 5, a.y, 1]]); await page.waitForTimeout(10); }
    await t.touch('touchStart', [[a.x1 + 17, a.y, 1], [a.x1 + 200, a.y + 160, 2]]);
    await page.waitForTimeout(30);
    await t.touch('touchEnd', [[a.x1 + 200, a.y + 160, 2]]); // the second lifts (CDP: the points listed are released)
    const x2 = b.x2 - 3;
    for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 17 + ((x2 - a.x1 - 17) * i) / 10, a.y, 1]]); await page.waitForTimeout(12); }
    await t.touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Уязвимостите се докладват');
  });

  test('T064-P3 a slow two-finger scroll whose resting finger is the larger contact and moves a little slower (80 %) still scrolls; nothing is drawn', async ({ page }) => {
    const t = await input(page);
    await page.evaluate(() => window.scrollTo(0, 400));
    const y0 = await scrollY(page);
    const x = (await page.locator('iframe.lesson-frame').boundingBox()).x + 200;
    const y = midY(page, 700);
    await t.touch('touchStart', [[x, y, 1, 8]]);
    await page.waitForTimeout(300);
    await t.touch('touchStart', [[x, y, 1, 8], [x + 150, y, 2, 4]]);
    for (let i = 1; i <= 12; i++) { await t.touch('touchMove', [[x, y - i * 20, 1, 8], [x + 150, y - i * 25, 2, 4]]); await page.waitForTimeout(12); }
    await t.touch('touchEnd', []);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(y0 + 120);
    await page.waitForTimeout(300);
    expect(await count(page)).toBe(0);
  });
});

// ===========================================================================
test.describe('T064 the bar: double taps (T063-I6), the mouse after a tap (T063-D8)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
    await openLesson(page);
  });
  const tap = async (t, x, y) => { await t.touch('touchStart', [[x, y, 1]]); await t.touch('touchEnd', []); };

  test('T064-B1 the handle is not where "Скрий" was; a double tap on "Скрий" (the second at 120 ms, or at 400 ms) leaves the bar hidden', async ({ page }) => {
    const hb = await hideButton(page).boundingBox();
    const t = await input(page);
    const cx = hb.x + hb.width / 2;
    const cy = hb.y + hb.height / 2;
    for (const gap of [120, 400]) {
      await tap(t, cx, cy);
      await page.waitForTimeout(gap);
      await tap(t, cx, cy);
      await page.waitForTimeout(800);
      await expect(bar(page)).toBeHidden();
      await expect(handle(page)).toBeVisible();
      expect((await stored(page)).hidden).toBe(true);
      const h0 = await handle(page).boundingBox();
      const overlap = !(h0.y >= hb.y + hb.height || h0.y + h0.height <= hb.y || h0.x >= hb.x + hb.width || h0.x + h0.width <= hb.x);
      expect(overlap).toBe(false);
      await handle(page).tap();
      await expect(bar(page)).toBeVisible();
      await page.waitForTimeout(400);
    }
  });

  test('T064-B2 a double tap on the handle shows the bar and turns no tool on (the second tap lands on the bar right after it appeared)', async ({ page }) => {
    await hideButton(page).tap();
    await expect(handle(page)).toBeVisible();
    await page.waitForTimeout(800);
    const h0 = await handle(page).boundingBox();
    const t = await input(page);
    await tap(t, h0.x + 22, h0.y + 28);
    await page.waitForTimeout(60);
    await tap(t, h0.x + 22, h0.y + 28);
    await page.waitForTimeout(800);
    await expect(bar(page)).toBeVisible();
    for (const n of ['marker', 'pencil', 'eraser']) await expect(tool(page, n)).toHaveAttribute('aria-pressed', 'false');
    // A colour tapped well after that works (the guard is short).
    await color(page, 'green').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
  });

  test('T064-B3 a mouse click on the handle 0.3 s after a tap on "Скрий" shows the bar; a mouse click on a tool 0.3 s after a tap on another one works', async ({ page }) => {
    await hideButton(page).tap();
    await expect(handle(page)).toBeVisible();
    await page.waitForTimeout(300);
    await handle(page).click();
    await expect(bar(page)).toBeVisible({ timeout: 1500 });
    await page.waitForTimeout(400);
    await color(page, 'blue').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(300);
    await tool(page, 'pencil').click();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
  });
});
