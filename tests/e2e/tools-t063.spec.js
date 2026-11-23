// T-063 (tester): T-062 (0.13.1) attacked from outside.
// - T063-S palm / pen (T016-D2): thumbs of 20…60 px, slow two-finger scrolling
//   (the second finger 200…400 ms later), a first finger already moving when the
//   second lands, a resting palm that drifts while a passive pen (a touch)
//   writes, a large palm + a finger together, a pinch, the pen (pointerType pen)
//   + touches (before, during, the grace after it lifts);
// - T063-S bar: old / broken settings, a double "Скрий", hiding during a stroke,
//   the handle on a 360×640 phone at 160 % text, ids / aria;
// - T063-S security: lrn:undo with fields, without focus, a lesson that takes the
//   focus by itself, a flood of lrn:undo after a legitimate tap in the lesson
//   (T-065, D-044: lrn:undo is gone — each of them undoes nothing);
//   forged lrn:stroked during a palm gesture;
// - T063-S anchoring: a "провери" stays "провери" over several openings until
//   "Да, тук е"; short quotes (< 24) — the new thresholds, false "ok" searched,
//   the number of "провери" after a harmless edit measured (information);
// - T063-S words with inner punctuation (T016-D1): т.е., 1.000.000, URLs, …;
// - T063-S the palette of a lesson that turns dark with a CSS transition (T016-D3);
//   a lesson that changes the class of <body> every frame (load);
// - T063-R the race of tools-t015 R1: "Да, тук е" while the first anchoring is
//   still waiting to be saved (a slow lesson / CPU).
// Known defects: test.fail(true, 'T063-D…'). Information: test annotations (T063-I…).
// Touch through CDP (Input.dispatchTouchEvent: radiusX/Y → PointerEvent width /
// height = 2 × radius), the pen through Input.dispatchMouseEvent pointerType "pen".
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
const C = 'LRN-T63';
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
const color = (page, name) => page.locator(`[data-field="mark-tools"] [data-color="${name}"]`);
const bar = (page) => page.locator('[data-field="mark-tools"]');
const handle = (page) => page.locator('[data-field="mark-tools-handle"]');
const hideButton = (page) => page.locator('[data-field="mark-tools"] [data-action="hide-tools"]');
const layer = (page) => page.locator('[data-field="mark-layer"]');
const stored = (page) => db(page, async (db) => (await db.getSettings()).markTool ?? null);
const scrollY = (page) => page.evaluate(() => window.scrollY);
/** A y in the middle band of the screen (room to move up and down). */
const midY = (page, y) => Math.min(Math.max(y, 450), page.viewportSize().height - 450);

// ===========================================================================
test.describe('T063 palm and pen (T016-D2)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
    await openLesson(page);
    await tool(page, 'marker').tap();
    await expect(layer(page)).toBeVisible();
  });

  test('T063-S1 one finger of 20 / 30 / 40 / 44 px draws (a large thumb is not a palm under 45×45); 46 / 50 / 60 px is a palm by the rule (information T063-I1)', async ({ page }) => {
    const t = await input(page);
    const result = {};
    let n = 0;
    for (const d of [20, 30, 40, 44, 46, 50, 60]) {
      const a = await textBox(page, `абзац ${10 + n} за`);
      const before = await count(page);
      await t.drag(a, { r: d / 2 });
      await page.waitForTimeout(500);
      const after = await count(page);
      result[`${d}px`] = after > before ? 'draws' : 'palm';
      n++;
    }
    info('T063-I1 one finger by diameter', result);
    for (const d of [20, 30, 40, 44]) expect(result[`${d}px`], `${d} px`).toBe('draws');
    for (const d of [46, 50, 60]) expect(result[`${d}px`], `${d} px`).toBe('palm');
  });

  test('T063-S2 slow two-finger scrolling: the second finger 200 / 300 / 400 ms after the first (the first still or jittering < 8 px) → the page scrolls, nothing is drawn, the tool stays on', async ({ page }) => {
    const t = await input(page);
    for (const [gap, jitter] of [[200, 0], [300, 3], [400, 5]]) {
      await page.evaluate(() => window.scrollTo(0, 300));
      const y0 = await scrollY(page);
      const x = (await page.locator('iframe.lesson-frame').boundingBox()).x + 200;
      const y = midY(page, 600);
      await t.touch('touchStart', [[x, y, 1]]);
      await page.waitForTimeout(gap / 2);
      if (jitter) await t.touch('touchMove', [[x + jitter, y + 1, 1]]);
      await page.waitForTimeout(gap / 2);
      await t.touch('touchStart', [[x + jitter, y, 1], [x + 150, y + 10, 2]]);
      for (let i = 1; i <= 12; i++) { await t.touch('touchMove', [[x + jitter, y - i * 25, 1], [x + 150, y + 10 - i * 25, 2]]); await page.waitForTimeout(12); }
      await t.touch('touchEnd', []);
      await expect.poll(() => scrollY(page), { message: `gap ${gap}` }).toBeGreaterThan(y0 + 150);
      await page.waitForTimeout(300);
      expect(await count(page), `gap ${gap}`).toBe(0);
    }
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
  });

  test('T063-S3 (T063-D1) a two-finger scroll whose first finger has already slid 12 px when the second lands 60 ms later scrolls — it does not draw', async ({ page }) => {
    const t = await input(page);
    await page.evaluate(() => window.scrollTo(0, 600));
    const y0 = await scrollY(page);
    const a = await textBox(page, 'абзац 12 за', { scroll: false });
    const x = a.x1 + 10;
    const y = midY(page, a.y);
    await t.touch('touchStart', [[x, y, 1]]);
    for (let i = 1; i <= 3; i++) { await t.touch('touchMove', [[x, y - i * 4, 1]]); await page.waitForTimeout(10); }
    await page.waitForTimeout(25);
    await t.touch('touchStart', [[x, y - 12, 1], [x + 150, y, 2]]);
    for (let i = 1; i <= 12; i++) { await t.touch('touchMove', [[x, y - 12 - i * 25, 1], [x + 150, y - i * 25, 2]]); await page.waitForTimeout(12); }
    await t.touch('touchEnd', []);
    await page.waitForTimeout(600);
    info('T063-D1 result', { marks: await count(page), scrolled: (await scrollY(page)) - y0 });
    expect(await count(page)).toBe(0);
    expect(await scrollY(page)).toBeGreaterThan(y0 + 150);
  });

  test('T063-S4 (T063-D2) a resting palm (small contact, 300 ms) that drifts 2 px per frame while the passive pen (a touch) writes slowly (6 px per frame) — it must draw, not scroll', async ({ page }) => {
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const palm = [a.x1 + 60, a.y + 140, 1, 7];
    const y0 = await scrollY(page);
    await t.touch('touchStart', [palm]);
    await page.waitForTimeout(300);
    const pen = (i) => [a.x1 + 3 + i * 6, a.y, 2];
    const p = (i) => [palm[0] + i * 2, palm[1] + i, 1, 7];
    await t.touch('touchStart', [p(0), pen(0)]);
    for (let i = 1; i <= 40; i++) { await t.touch('touchMove', [p(Math.min(i, 6)), pen(i)]); await page.waitForTimeout(16); }
    await t.touch('touchEnd', [p(6)]);
    await t.touch('touchEnd', []);
    await page.waitForTimeout(600);
    info('T063-D2 result', { marks: await count(page), scrolled: (await scrollY(page)) - y0 });
    expect(await count(page)).toBe(1);
  });

  test('T063-S5 information T063-I2: ambiguous gestures (what each one does now: a mark, a scroll)', async ({ page }) => {
    const t = await input(page);
    const out = {};
    const run = async (name, fn) => {
      await page.evaluate(() => window.scrollTo(0, 700));
      await page.waitForTimeout(100);
      const y0 = await scrollY(page);
      const before = await count(page);
      await fn();
      await page.waitForTimeout(700);
      out[name] = { marks: (await count(page)) - before, scrolled: Math.round((await scrollY(page)) - y0) };
    };
    const at = async (k) => { const a = await textBox(page, `абзац ${k} за`, { scroll: false }); return { ...a, y: midY(page, a.y) }; };
    // A palm (small) and the pen landing together (50 ms), then only the pen moves.
    await run('palm+pen together (50 ms), pen writes', async () => {
      const a = await at(12);
      await t.touch('touchStart', [[a.x1 + 80, a.y + 150, 1, 7]]);
      await page.waitForTimeout(50);
      await t.touch('touchStart', [[a.x1 + 80, a.y + 150, 1, 7], [a.x1 + 3, a.y, 2]]);
      for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 80, a.y + 150, 1, 7], [a.x1 + 3 + i * 25, a.y, 2]]); await page.waitForTimeout(12); }
      await t.touch('touchEnd', []);
    });
    // A pinch where one finger stays and the other moves (zooming with one finger).
    await run('pinch, one finger still (300 ms apart)', async () => {
      const a = await at(13);
      await t.touch('touchStart', [[a.x1 + 20, a.y, 1]]);
      await page.waitForTimeout(300);
      await t.touch('touchStart', [[a.x1 + 20, a.y, 1], [a.x1 + 120, a.y + 40, 2]]);
      for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 20, a.y, 1], [a.x1 + 120 + i * 20, a.y + 40 + i * 20, 2]]); await page.waitForTimeout(12); }
      await t.touch('touchEnd', []);
    });
    // A symmetric pinch, the fingers together.
    await run('pinch, both fingers together', async () => {
      const a = await at(14);
      await t.touch('touchStart', [[a.x1 + 100, a.y, 1]]);
      await t.touch('touchStart', [[a.x1 + 100, a.y, 1], [a.x1 + 200, a.y, 2]]);
      for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 100 - i * 10, a.y, 1], [a.x1 + 200 + i * 10, a.y, 2]]); await page.waitForTimeout(12); }
      await t.touch('touchEnd', []);
    });
    // Slow two-finger scroll whose fingers do not move equally (one 30 px per frame, the other 4).
    await run('two fingers 300 ms apart, unequal speed (30 / 4 px)', async () => {
      const a = await at(15);
      await t.touch('touchStart', [[a.x1 + 20, a.y, 1]]);
      await page.waitForTimeout(300);
      await t.touch('touchStart', [[a.x1 + 20, a.y, 1], [a.x1 + 170, a.y, 2]]);
      for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 20, a.y - i * 4, 1], [a.x1 + 170, a.y - i * 30, 2]]); await page.waitForTimeout(12); }
      await t.touch('touchEnd', []);
    });
    // The second finger lands at 100 ms while the first has not moved; the first then lifts.
    await run('second finger, first lifts at once, second drags', async () => {
      const a = await at(16);
      await t.touch('touchStart', [[a.x1 + 20, a.y, 1]]);
      await page.waitForTimeout(100);
      await t.touch('touchStart', [[a.x1 + 20, a.y, 1], [a.x1 + 3, a.y + 2, 2]]);
      await t.touch('touchEnd', [[a.x1 + 3, a.y + 2, 2]]);
      for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 3 + i * 25, a.y + 2, 2]]); await page.waitForTimeout(12); }
      await t.touch('touchEnd', []);
    });
    info('T063-I2 ambiguous gestures', out);
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    expect(out['pinch, both fingers together'].marks).toBe(0);
  });

  test('T063-S6 a large palm (≥ 70 px) resting + a finger 50 ms later → the finger draws; a large palm landing during a stroke → the stroke goes on; two large contacts → nothing; a palm that grows while it is the stroke → the stroke is dropped', async ({ page }) => {
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const P = [a.x1 + 100, a.y + 160, 1, 40];
    await t.touch('touchStart', [P]);
    await page.waitForTimeout(50);
    await t.touch('touchStart', [P, [a.x1 + 3, a.y, 2]]);
    for (let i = 1; i <= 8; i++) { await t.touch('touchMove', [P, [a.x1 + 3 + ((a.x2 - a.x1 - 6) * i) / 8, a.y, 2]]); await page.waitForTimeout(10); }
    await t.touch('touchEnd', [P]);
    await t.touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Уязвимостите');
    // A big palm lands in the middle of a stroke.
    const b = await textBox(page, 'Производителят');
    await t.touch('touchStart', [[b.x1 + 3, b.y, 1]]);
    for (let i = 1; i <= 4; i++) { await t.touch('touchMove', [[b.x1 + 3 + ((b.x2 - b.x1 - 6) * i) / 8, b.y, 1]]); await page.waitForTimeout(10); }
    const Q = [b.x1 + 80, b.y + 170, 2, 40];
    for (let i = 5; i <= 8; i++) { await t.touch('touchMove', [[b.x1 + 3 + ((b.x2 - b.x1 - 6) * i) / 8, b.y, 1], Q]); await page.waitForTimeout(10); }
    await t.touch('touchEnd', [Q]);
    await t.touch('touchEnd', []);
    await waitMarks(page, 2);
    expect((await live(page)).map((x) => x.exact)).toContain('Производителят');
    // Two large contacts: nothing.
    const c = await textBox(page, 'Задълженията');
    await t.touch('touchStart', [[c.x1, c.y, 1, 40], [c.x1 + 200, c.y, 2, 36]]);
    for (let i = 1; i <= 8; i++) { await t.touch('touchMove', [[c.x1 + i * 20, c.y, 1, 40], [c.x1 + 200 + i * 20, c.y, 2, 36]]); await page.waitForTimeout(10); }
    await t.touch('touchEnd', []);
    // A stroke whose contact grows into a palm (the hand lays down): dropped.
    const d = await textBox(page, 'Краят на урока');
    await t.touch('touchStart', [[d.x1 + 2, d.y, 1, 4]]);
    for (let i = 1; i <= 8; i++) { await t.touch('touchMove', [[d.x1 + 2 + ((d.x2 - d.x1 - 4) * i) / 8, d.y, 1, i < 5 ? 4 : 40]]); await page.waitForTimeout(10); }
    await t.touch('touchEnd', []);
    await page.waitForTimeout(600);
    expect(await count(page)).toBe(2);
    const hl = await (await lessonFrame(page)).evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith('lrn-pv')).filter((k) => CSS.highlights.get(k).size));
    expect(hl).toEqual([]);
  });

  test('T063-S7 the pen (pointerType pen) + touches: a touch stroke is dropped when the pen lands and the pen draws; touches while the pen writes are ignored; 300 ms after it lifts a touch is still the palm, 1.2 s after it draws again', async ({ page }) => {
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'Задълженията', { scroll: false });
    // A touch is drawing over "Задълженията", then the pen lands on "Уязвимостите".
    await t.touch('touchStart', [[b.x1 + 2, b.y, 1]]);
    for (let i = 1; i <= 4; i++) { await t.touch('touchMove', [[b.x1 + 2 + i * 20, b.y, 1]]); await page.waitForTimeout(10); }
    await t.pen('mousePressed', a.x1 + 3, a.y);
    for (let i = 1; i <= 8; i++) {
      await t.pen('mouseMoved', a.x1 + 3 + ((a.x2 - a.x1 - 6) * i) / 8, a.y);
      await t.touch('touchMove', [[b.x1 + 82 + i * 20, b.y, 1]]);
      await page.waitForTimeout(10);
    }
    await t.pen('mouseReleased', a.x2 - 3, a.y);
    await t.touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page)).map((x) => x.exact)).toEqual(['Уязвимостите']);
    // 300 ms after the pen lifted: a touch drag is the palm.
    await page.waitForTimeout(150);
    const c = await textBox(page, 'Производителят', { scroll: false });
    await t.drag(c);
    await page.waitForTimeout(500);
    expect(await count(page)).toBe(1);
    // Later: a finger draws again.
    await page.waitForTimeout(1200);
    await t.drag(c);
    await waitMarks(page, 2);
  });
});

// ===========================================================================
test.describe('T063 the bar (D-042 addendum)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
  });

  test('T063-S8 old and broken settings: {tool: "eraser", color: "purple", lastDraw: "brush", hidden: "yes"} → no tool, yellow, the marker is the last tool, shown by the width; {tool: "marker", hidden: true} → hidden, no tool, no layer', async ({ page }) => {
    await db(page, (db) => db.saveSettings({ markTool: { tool: 'eraser', color: 'purple', lastDraw: 'brush', hidden: 'yes' } }));
    await openLesson(page);
    for (const n of ['marker', 'pencil', 'eraser']) await expect(tool(page, n)).toHaveAttribute('aria-pressed', 'false');
    await expect(color(page, 'yellow')).toHaveAttribute('aria-pressed', 'true');
    await expect(layer(page)).toBeHidden();
    await expect(bar(page)).toBeVisible();
    await color(page, 'green').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    await db(page, (db) => db.saveSettings({ markTool: { tool: 'marker', color: 'pink', lastDraw: 'pencil', hidden: true } }));
    await openLesson(page);
    await expect(bar(page)).toBeHidden();
    await expect(handle(page)).toBeVisible();
    await expect(layer(page)).toBeHidden();
    await expect(page.locator('[data-field="reader-doc"]')).toHaveAttribute('data-tool', 'none');
    // One finger scrolls (no tool), nothing drawn.
    const t = await input(page);
    const y0 = await scrollY(page);
    const fb = await page.locator('iframe.lesson-frame').boundingBox();
    await t.touch('touchStart', [[fb.x + 200, 900, 1]]);
    for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[fb.x + 200, 900 - i * 40, 1]]); await page.waitForTimeout(10); }
    await t.touch('touchEnd', []);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(y0);
    expect(await count(page)).toBe(0);
    await handle(page).tap();
    await expect(bar(page)).toBeVisible();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'false');
    await color(page, 'pink').tap();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
  });

  test('T063-S9 "Скрий" tapped twice quickly, hide + show at once from the API, the handle tapped during the slide: the end state is consistent (one of bar / handle, aria-expanded, stored = shown); the handle is 44 × 56', async ({ page }) => {
    await openLesson(page);
    const hb = await hideButton(page).boundingBox();
    const t = await input(page);
    const cx = hb.x + hb.width / 2;
    const cy = hb.y + hb.height / 2;
    await t.touch('touchStart', [[cx, cy, 1]]); await t.touch('touchEnd', []);
    await page.waitForTimeout(40);
    await t.touch('touchStart', [[cx, cy, 1]]); await t.touch('touchEnd', []);
    await page.waitForTimeout(900);
    // Either end is fair (information T063-I6: the second tap may land on the handle,
    // which appears where "Скрий" was, and show the bar again); it must be consistent.
    const dbl = await page.evaluate(() => ({ bar: !document.querySelector('[data-field="mark-tools"]').hidden, handle: !document.querySelector('[data-field="mark-tools-handle"]').hidden }));
    info('T063-I6 after a double tap on "Скрий"', dbl);
    expect(dbl.bar !== dbl.handle).toBe(true);
    expect((await stored(page)).hidden).toBe(!dbl.bar);
    const hideBox = hb;
    if (dbl.bar) await hideButton(page).tap();
    await expect(handle(page)).toBeVisible();
    const size = await handle(page).boundingBox();
    info('T063-I6 overlap of the handle with "Скрий"', { hide: hideBox, handle: size });
    info('T063 handle size', { width: size.width, height: size.height });
    expect(size.width).toBeGreaterThanOrEqual(44);
    // T-071 (D-046): in portrait the handle is in the row of the bars at the top: ≥ 44 high there.
    const vp = page.viewportSize();
    expect(size.height).toBeGreaterThanOrEqual(vp.height > vp.width && vp.width >= 600 ? 44 : 56);
    // The handle tapped twice quickly: shown (the second tap lands on the bar, not "Скрий").
    const h0 = await handle(page).boundingBox();
    await t.touch('touchStart', [[h0.x + 20, h0.y + 20, 1]]); await t.touch('touchEnd', []);
    await page.waitForTimeout(30);
    await t.touch('touchStart', [[h0.x + 20, h0.y + 20, 1]]); await t.touch('touchEnd', []);
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      bar: !document.querySelector('[data-field="mark-tools"]').hidden,
      handle: !document.querySelector('[data-field="mark-tools-handle"]').hidden,
      expanded: document.querySelector('[data-action="hide-tools"]').getAttribute('aria-expanded'),
      handleExpanded: document.querySelector('[data-field="mark-tools-handle"]').getAttribute('aria-expanded'),
      doc: document.querySelector('[data-field="reader-doc"]').getAttribute('data-bar'),
    }));
    info('T063 after two quick taps on the handle', state);
    expect(state.bar !== state.handle).toBe(true);
    expect(state.doc).toBe(state.bar ? 'shown' : 'hidden');
    expect(state.expanded).toBe(String(state.bar));
    expect((await stored(page)).hidden).toBe(!state.bar);
    // Hide + show from the keyboard path at once (the slide is cancelled).
    if (!state.bar) await handle(page).tap();
    await expect(bar(page)).toBeVisible();
    await hideButton(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(20);
    if (await handle(page).isVisible()) await page.keyboard.press('Enter');
    else await page.evaluate(() => document.querySelector('[data-field="mark-tools-handle"]').click());
    await page.waitForTimeout(500);
    const end = await page.evaluate(() => ({
      bar: !document.querySelector('[data-field="mark-tools"]').hidden,
      handle: !document.querySelector('[data-field="mark-tools-handle"]').hidden,
      doc: document.querySelector('[data-field="reader-doc"]').getAttribute('data-bar'),
    }));
    expect(end.bar !== end.handle).toBe(true);
    expect(end.doc).toBe(end.bar ? 'shown' : 'hidden');
    expect((await stored(page)).hidden).toBe(!end.bar);
  });

  test('T063-S10 hiding the bar with a second finger while the first draws: the stroke is dropped (no mark, no preview left), the tool is off, one finger scrolls after it', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    const a = await textBox(page, 'Производителят');
    const hb = await hideButton(page).boundingBox();
    const H = [hb.x + hb.width / 2, hb.y + hb.height / 2, 2];
    await t.touch('touchStart', [[a.x1 + 2, a.y, 1]]);
    for (let i = 1; i <= 4; i++) { await t.touch('touchMove', [[a.x1 + 2 + i * 30, a.y, 1]]); await page.waitForTimeout(10); }
    await t.touch('touchStart', [[a.x1 + 122, a.y, 1], H]);
    await t.touch('touchEnd', [[a.x1 + 122, a.y, 1]]);
    await page.waitForTimeout(50);
    for (let i = 5; i <= 8; i++) { await t.touch('touchMove', [[a.x1 + 2 + i * 30, a.y, 1]]); await page.waitForTimeout(10); }
    await t.touch('touchEnd', []);
    await page.waitForTimeout(700);
    const st = { bar: await bar(page).isVisible(), marks: (await live(page)).map((m) => m.exact), tool: await page.locator('[data-field="reader-doc"]').getAttribute('data-tool') };
    info('T063 hide during a stroke', st);
    const pv = await (await lessonFrame(page)).evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith('lrn-pv') && CSS.highlights.get(k).size));
    expect(pv).toEqual([]);
    if (!st.bar) {
      // Hidden: the tool is off and the stroke left nothing.
      expect(st.marks).toBe(0);
      expect(st.tool).toBe('none');
      await expect(layer(page)).toBeHidden();
      const y0 = await scrollY(page);
      const fb = await page.locator('iframe.lesson-frame').boundingBox();
      const y = midY(page, 800);
      await t.touch('touchStart', [[fb.x + 300, y, 1]]);
      for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[fb.x + 300, y - i * 30, 1]]); await page.waitForTimeout(10); }
      await t.touch('touchEnd', []);
      await expect.poll(() => scrollY(page)).toBeGreaterThan(y0);
    }
  });

  test('T063-S11 ids and aria: one #mark-tools, both aria-controls point to it, the hidden one of bar / handle is not focusable, the live region says what happened, Escape with the bar hidden does nothing harmful', async ({ page }) => {
    await openLesson(page);
    const ids = await page.evaluate(() => ({
      n: document.querySelectorAll('#mark-tools').length,
      controls: [...document.querySelectorAll('[aria-controls]')].map((e) => e.getAttribute('aria-controls')),
      handleFocusable: (() => { const h = document.querySelector('[data-field="mark-tools-handle"]'); h.focus(); return document.activeElement === h; })(),
    }));
    expect(ids.n).toBe(1);
    expect(ids.controls.filter((c) => c === 'mark-tools').length).toBe(2);
    expect(ids.handleFocusable).toBe(false);
    await tool(page, 'pencil').tap();
    await hideButton(page).tap();
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Инструментите са скрити; инструментът е изключен.');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800); // see T063-S22: a click within 0.7 s of a tap is dropped
    await expect(handle(page)).toBeVisible();
    await expect(bar(page)).toBeHidden();
    const barFocusableLater = await page.evaluate(() => { const b = document.querySelector('[data-field="mark-tools"] button'); b.focus(); return document.activeElement === b; });
    expect(barFocusableLater).toBe(false);
    // A tool from the keyboard shortcut / API brings the bar back (kept from T-062).
    await handle(page).focus();
    await page.keyboard.press('Space');
    await expect(bar(page)).toBeVisible();
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Инструментите са показани.');
  });
});

test.describe('T063 the bar: keyboard right after a tap', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
  });
  test('T063-S22 (T063-D8) a keyboard press (Enter / Space → click) on the handle 0.3 s after a tap on "Скрий" shows the bar', async ({ page }) => {
    await openLesson(page);
    await hideButton(page).tap();
    await expect(handle(page)).toBeVisible();
    await handle(page).focus();
    await page.keyboard.press('Enter');
    await expect(bar(page)).toBeVisible({ timeout: 1500 });
  });
});

test.describe('T063 the handle on a small phone', () => {
  test.use({ viewport: { width: 360, height: 640 } });
  test.beforeEach(async ({ page }, ti) => {
    test.skip(ti.project.name !== 'tablet-portrait', 'one phone layout');
    await start(page);
    await importCourse(page, C, files());
  });

  test('T063-S12 360 × 640 with text at 160 %: hidden by default; the handle is not over the lesson, stays on the screen while scrolling, no horizontal scrolling; shown: the bar fits, drawing works', async ({ page }) => {
    await db(page, (db) => db.saveSettings({ fontScale: 1.6 }));
    await openLesson(page);
    await expect(bar(page)).toBeHidden();
    const check = async () => {
      const hb = await handle(page).boundingBox();
      const fb = await page.locator('iframe.lesson-frame').boundingBox();
      expect(hb.x + hb.width).toBeLessThanOrEqual(fb.x + 0.5);
      expect(hb.y).toBeGreaterThanOrEqual(0);
      expect(hb.y + hb.height).toBeLessThanOrEqual(640);
      return { hb, fb };
    };
    const { fb } = await check();
    info('T063 360×640 frame', { x: fb.x, width: fb.width });
    await page.evaluate(() => window.scrollTo(0, 2500));
    await page.waitForTimeout(100);
    await check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await handle(page).tap();
    await expect(bar(page)).toBeVisible();
    // T-067 (T066-D4): on this small screen "Маркер" is where "☰" was; a tap there
    // within 350 ms is the second tap of a double tap and is ignored by design.
    await page.waitForTimeout(400);
    await tool(page, 'marker').tap();
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    await t.drag(a);
    await waitMarks(page, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});

// ===========================================================================
test.describe('T063 security: lrn:undo and the palm rules', () => {
  const STEAL = `<script>
    setInterval(() => {
      if (!window.__go || Date.now() < window.__go) return;
      window.__go = 0;
      const active = navigator.userActivation ? navigator.userActivation.isActive : null;
      document.body.tabIndex = -1; document.body.focus(); window.focus();
      setTimeout(() => {
        window.__report = { active, hasFocus: document.hasFocus() };
        for (let i = 0; i < 60; i++) parent.postMessage({ lrn: 1, type: 'lrn:undo' }, '*');
      }, 150);
    }, 100);
  </script>`;
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files(BODY + STEAL));
  });
  async function threeMarks(page) {
    const frame = await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    for (const [k, w] of [[1, 'Регламентът'], [2, 'Уязвимостите'], [3, 'Задълженията']]) {
      await t.drag(await textBox(page, w));
      await waitMarks(page, k);
    }
    return { frame, t };
  }

  test('T063-S13 lrn:undo with fields ({id} of the FIRST mark, many) undoes nothing, with the focus in the app or in the lesson (D-044); then "Отмени" and the app\'s own Ctrl+Z undo the last actions', async ({ page }) => {
    const { frame } = await threeMarks(page);
    const first = (await live(page)).find((a) => a.exact === 'Регламентът').id;
    await tool(page, 'marker').focus();
    await frame.evaluate((id) => parent.postMessage({ lrn: 1, type: 'lrn:undo', id, ids: [id], annotationId: id }, '*'), first);
    await page.waitForTimeout(500);
    expect(await count(page)).toBe(3);
    await frame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    await frame.evaluate((id) => parent.postMessage({ lrn: 1, type: 'lrn:undo', id, ids: [id], annotationId: id }, '*'), first);
    await page.keyboard.press('Control+z'); // the focus in the lesson: not an undo either
    await page.waitForTimeout(500);
    expect(await count(page)).toBe(3);
    await tool(page, 'marker').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 2);
    expect((await live(page)).map((a) => a.exact).sort()).toEqual(['Регламентът', 'Уязвимостите'].sort());
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Регламентът');
  });

  test('T063-S14 (T063-D3) a lesson that takes the focus by itself (no key pressed, no tap in it) and posts a flood of lrn:undo must not undo the user\'s marks', async ({ page }) => {
    const { frame } = await threeMarks(page);
    await tool(page, 'marker').tap(); // the tool off: the focus is on the bar (the user's last tap)
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
    await frame.evaluate(() => { window.__go = Date.now() + 6000; });
    await page.waitForTimeout(7000);
    const report = await frame.evaluate(() => window.__report || null);
    const focus = await page.evaluate(() => document.activeElement?.tagName);
    const left = await count(page);
    info('T063-D3 focus taken by the lesson', { report, appActive: focus, marksLeft: left });
    expect(left).toBe(3);
  });

  test('T063-S15 (T063-D4, D-044) after one honest tap in the lesson (focus in the frame) a flood of 60 lrn:undo undoes nothing', async ({ page }) => {
    const { frame } = await threeMarks(page);
    await tool(page, 'marker').tap(); // off
    const a = await textBox(page, 'Производителят');
    await page.mouse.click(a.x1 + 10, a.y); // the user's own click into the lesson
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    await frame.evaluate(() => { window.__go = Date.now() + 100; });
    await page.waitForTimeout(1500);
    info('T063-D4 marks left after the flood', await count(page));
    expect(await count(page)).toBe(3);
  });

  test('T063-S16 a lesson cannot use the palm rules: forged lrn:stroked (seq 0…300) while the user rests a palm and writes; its own pointer listeners get no touch of the layer; only the user\'s stroke is saved', async ({ page }) => {
    const frame = await openLesson(page);
    await frame.evaluate(() => {
      window.__seen = 0;
      for (const type of ['pointerdown', 'pointermove', 'touchstart']) document.addEventListener(type, () => { window.__seen++; }, true);
      window.__forge = setInterval(() => {
        for (let seq = 0; seq <= 300; seq++) parent.postMessage({ lrn: 1, type: 'lrn:stroked', seq, tool: 'marker', quote: { exact: 'Краят', prefix: '', suffix: '' }, position: { start: 1, end: 6 } }, '*');
      }, 50);
    });
    await tool(page, 'marker').tap();
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const P = [a.x1 + 60, a.y + 150, 1, 7];
    await t.touch('touchStart', [P]);
    await page.waitForTimeout(300);
    await t.touch('touchStart', [P, [a.x1 + 3, a.y, 2]]);
    for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [P, [a.x1 + 3 + ((a.x2 - a.x1 - 6) * i) / 10, a.y, 2]]); await page.waitForTimeout(12); }
    await t.touch('touchEnd', [P]);
    await t.touch('touchEnd', []);
    await page.waitForTimeout(1200);
    await frame.evaluate(() => clearInterval(window.__forge));
    // One user stroke → at most one mark, in this lesson. WHICH text it becomes is the
    // lesson's answer (the bridge runs in the lesson: a hostile lesson can map the
    // stroke onto other text of its own — information T063-I5, inside T016-I1).
    const marks = await live(page);
    info('T063-I5 the mark saved for the user stroke while the lesson forged answers', marks.map((m) => m.exact));
    expect(marks.length).toBeLessThanOrEqual(1);
    expect(await count(page, `${C}/lesson:0002`)).toBe(0);
    expect(await frame.evaluate(() => window.__seen)).toBe(0);
  });
});

// ===========================================================================
test.describe('T063 anchoring: "провери" and short quotes (T013F-D1/D2)', () => {
  test('T063-S17 (T013F-D1) a "провери" stays "провери" over three openings of the same version (DB state and lastAnchor); after "Да, тук е" it is "ok" and stays "ok" at that place', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    const v1 = '<p id="a1">Първо: CRA важи тук за всичко.</p><p id="a2">Второ: и CRA важи там за всички продукти.</p><p>Трето: регламентът.</p>';
    await importCourse(page, C, files(v1));
    await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    const frame = await lessonFrame(page);
    const box = await frame.evaluate(() => {
      const n = document.getElementById('a2').firstChild;
      const r = document.createRange(); const i = n.data.indexOf('CRA'); r.setStart(n, i); r.setEnd(n, i + 3);
      const b = r.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top + b.height / 2 };
    });
    const fb = await page.locator('iframe.lesson-frame').boundingBox();
    await t.drag({ x1: fb.x + box.l, x2: fb.x + box.r, y: fb.y + box.t });
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('CRA');
    const v2 = v1.replace(/<p id="a2">.*?<\/p>/, '');
    expect(await importCourse(page, C, files(v2))).not.toMatch(/^ERROR/);
    const states = [];
    for (let k = 0; k < 3; k++) {
      await openLesson(page);
      await expect(page.locator('[data-field="marks-check"]')).toBeVisible();
      await page.goto('./#/');
      await page.waitForTimeout(1500);
      const [a] = await live(page);
      states.push([a.state, a.last]);
    }
    info('T063 states over three openings', states);
    expect(states).toEqual([['fuzzy', 'fuzzy'], ['fuzzy', 'fuzzy'], ['fuzzy', 'fuzzy']]);
    await openLesson(page);
    const check = page.locator('[data-field="marks-check"]');
    await check.locator('summary').click();
    await check.locator('[data-action="confirm-mark"]').click();
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Мястото е потвърдено.');
    await page.waitForTimeout(1500);
    for (let k = 0; k < 2; k++) {
      await openLesson(page);
      await page.waitForTimeout(1500);
      await expect(page.locator('[data-field="marks-check"]')).toBeHidden();
      const [a] = await live(page);
      expect([a.state, a.last]).toEqual(['ok', 'ok']);
    }
  });

  test.describe('T063 src/anchor.js', () => {
    test.beforeEach(async ({ page }, ti) => { landscapeOnly(ti); await page.goto('./'); });
    const run = (page, fn, arg) => page.evaluate(`(async () => {
      const A = await import('./src/anchor.js');
      const M = (html) => A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body);
      const sel = (m, needle, nth = 0) => { let at = -1; for (let k = 0; k <= nth; k++) at = m.text.indexOf(needle, at + 1); if (at < 0) throw new Error('no ' + needle); return A.anchorDescribe(m, at, at + needle.length); };
      const at = (m, r) => (r.state === 'orphan' ? null : m.text.slice(r.start, r.end));
      return (${fn.toString()})(A, M, sel, at, ${JSON.stringify(arg ?? null)});
    })()`);

    test('T063-S18 (T063-D5) a short quote whose sentence was deleted is not "ok" at another sentence that shares only generic legal phrases on BOTH sides ("в съответствие с … от настоящия регламент")', async ({ page }) => {
      const r = await run(page, (A, M, sel, at) => {
        const v1 = '<p>Въведение в регламента.</p><p>Задълженията се изпълняват в съответствие с член 14 от настоящия регламент и указанията.</p><p>Органът се уведомява в съответствие с член 14 от настоящия регламент без забавяне.</p><p>Край.</p>';
        const m1 = M(v1);
        const s = sel(m1, 'член 14', 0);
        const v2 = v1.replace(/<p>Задълженията.*?<\/p>/, '');
        const m2 = M(v2);
        const f = A.anchorFind(m2, s);
        return { state: f.state, text: at(m2, f) };
      });
      info('T063-D5 result', r);
      expect(r.state).not.toBe('ok');
    });

    test('T063-S19 short quotes (< 24) in repeated text: no "ok" at a wrong copy; information T063-I3 — how many "провери" a harmless edit (a paragraph added at the start) gives in a repeated and in a normal lesson', async ({ page }) => {
      const r = await run(page, (A, M) => {
        let seed = 6301;
        const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const S = ['Производителят докладва уязвимостите до 24 часа.', 'Вносителят проверява маркировката CE на продукта.', 'Дистрибуторът пази документите 10 години.'];
        const repeated = Array.from({ length: 24 }, (_, i) => `<p>${S[i % 3]} ${S[(i + 1) % 3]}</p>`).join('');
        const normal = Array.from({ length: 24 }, (_, i) => `<p>Абзац ${i}: ${S[i % 3].replace('.', '')} според раздел ${i + 3}, с пример номер ${i * 7} и бележка ${String.fromCharCode(1040 + i)}.</p>`).join('');
        const prose = ['Регламентът за киберустойчивост се прилага за продукти с цифрови елементи.', 'Всеки производител оценява рисковете през целия жизнен цикъл.', 'Уязвимостите се докладват без неоправдано забавяне на органите.',
          'Вносителите проверяват дали маркировката е поставена правилно.', 'Дистрибуторите пазят документацията поне десет години.', 'Националните органи извършват надзор на пазара.',
          'Санкциите трябва да бъдат ефективни, съразмерни и възпиращи.', 'Отворения софтуер се третира по особен начин, когато е некомерсиален.', 'Сертифицирането по схема на ЕС е доброволно за повечето продукти.',
          'Ранното предупреждение до ENISA се изпраща в рамките на часове.', 'Краткият срок помага на потребителите да се защитят навреме.', 'Обучението на екипа е част от добрата практика.'].map((x) => `<p>${x}</p>`).join('');
        const out = {};
        for (const [name, body] of [['repeated', repeated], ['templated', normal], ['prose', prose]]) {
          const m1 = M(body);
          const m2 = M(`<p>Нов първи абзац, добавен при редакцията.</p>${body}`);
          const shift = m2.text.indexOf(m1.text.slice(0, 30));
          const c = { ok: 0, okWrong: 0, fuzzy: 0, fuzzyRight: 0, orphan: 0 };
          for (let k = 0; k < 300; k++) {
            const L = 1 + Math.floor(rnd() * 23);
            let s0 = Math.floor(rnd() * (m1.text.length - L));
            const q = m1.text.slice(s0, s0 + L);
            if (!q.trim()) continue;
            const s = A.anchorDescribe(m1, s0, s0 + L);
            const f = A.anchorFind(m2, s);
            const right = s0 + shift;
            // The quote is normalised (a leading / trailing space is dropped): the right place is within 2.
            const isRight = Math.abs(f.start - right) <= 2 && m2.text.slice(f.start, f.end).trim() === q.trim();
            if (f.state === 'ok') { c.ok++; if (!isRight) { c.okWrong++; if ((c.ex = c.ex || []).length < 4) c.ex.push([q, m2.text.slice(f.start - 20, f.end + 20)]); } }
            else if (f.state === 'fuzzy') { c.fuzzy++; if (isRight) c.fuzzyRight++; }
            else c.orphan++;
          }
          out[name] = c;
        }
        return out;
      });
      info('T063-I3 short quotes after a harmless edit (300 each)', r);
      expect(r.repeated.okWrong).toBe(0);
      expect(r.templated.okWrong).toBe(0);
      expect(r.prose.okWrong).toBe(0);
    });
  });
});

// ===========================================================================
test.describe('T063 words (T016-D1) and the palette (T016-D3)', () => {
  test('T063-S20 inner punctuation: 1.000.000 and 2024/2847 whole from the middle; information T063-I4 for т.е., a URL, an ellipsis without a space, a comma typo without a space', async ({ page }) => {
    await start(page);
    const W = '<p id="w1">Сумата е 1.000.000 лева, т.е. много.</p><p id="w2">Виж example.com/path/x тук.</p><p id="w3">Чакай…и после пак.</p><p id="w4">Думата,друга без интервал.</p><p id="w5">Делото 2024/2847 е решено.</p>';
    await importCourse(page, C, files(W + BODY));
    await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    const out = {};
    let n = 0;
    for (const [needle, from, to] of [['1.000.000', 3, 5], ['2024/2847', 3, 6], ['т.е.', 0, 3], ['example.com/path/x', 4, 12], ['Чакай…и', 2, 6], ['Думата,друга', 3, 8]]) {
      const seen = new Set((await live(page)).map((x) => x.id));
      const a = await textBox(page, needle, { from, to: from + 1 });
      const b = await textBox(page, needle, { from: to, to: to + 1, scroll: false });
      await t.drag({ x1: a.x1 + 1, x2: b.x1 + 4, y: a.y }, { steps: 6 });
      n++;
      await waitMarks(page, n);
      out[needle] = (await live(page)).find((x) => !seen.has(x.id))?.exact;
    }
    info('T063-I4 words', out);
    expect(out['1.000.000']).toBe('1.000.000');
    expect(out['2024/2847']).toBe('2024/2847');
  });

  test('T063-S21 (T063-D6) a lesson that turns dark with a CSS transition of 1.2 s gets the dark palette once the transition ends; information: a lesson that changes the class of <body> every frame does not slow the app', async ({ page }) => {
    await start(page);
    const head = '<style>body { transition: background-color 1.2s linear, color 1.2s linear; } body.dark { background: #151513; color: #e6e3da; }</style>';
    const btn = '<button id="dark" onclick="document.body.classList.toggle(\'dark\')">Тъмно</button>';
    await importCourse(page, C, files(btn + BODY, head));
    const frame = await openLesson(page);
    const yellow = () => frame.evaluate(() => [...document.querySelectorAll('style[data-easylrn="bridge"]')].map((s) => s.textContent).join('').match(/::highlight\(lrn-yellow\)[^{]*\{ background-color: (#[0-9a-f]+)/)?.[1]);
    const light = await yellow();
    // Load: a class flip on <body> every frame for 2 s; the app's own frames keep coming.
    const gaps = await Promise.all([
      frame.evaluate(() => new Promise((res) => { const t0 = performance.now(); const f = () => { document.body.classList.toggle('x'); if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(true); }; requestAnimationFrame(f); })),
      page.evaluate(() => new Promise((res) => { let last = performance.now(); let worst = 0; const t0 = last; const f = (t) => { worst = Math.max(worst, t - last); last = t; if (t - t0 < 2000) requestAnimationFrame(f); else res(Math.round(worst)); }; requestAnimationFrame(f); })),
    ]);
    info('T063 the worst app frame gap during the class flood (ms)', gaps[1]);
    await frame.locator('#dark').click();
    await page.waitForTimeout(2000);
    const after = await yellow();
    info('T063-D6 palette', { light, after });
    expect(after).toBe('#5c5216');
  });
});

// ===========================================================================
test.describe('T063 the race of tools-t015 R1', () => {
  test('T063-R1 "Да, тук е" pressed while the first anchoring is still waiting to be saved, the lesson slow to answer the reload: the place stays "ok" in the database', async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
    await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    const a = await textBox(page, 'Производителят');
    const b = await textBox(page, 'продукта.', { scroll: false });
    await t.touch('touchStart', [[a.x1 + 2, a.y, 1]]);
    for (let i = 1; i <= 12; i++) { await t.touch('touchMove', [[a.x1 + 2 + ((b.x1 + 30 - a.x1) * i) / 12, a.y + ((b.y - a.y) * i) / 12, 1]]); await page.waitForTimeout(8); }
    await t.touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toMatch(/^Производителят .*продукта$/);
    const v2 = BODY.replace('Производителят оценява рисковете', 'Производителят внимателно оценява рисковете');
    // The reader is closed first: the first anchoring of v2 happens at the opening below.
    await page.goto('./#/');
    await page.waitForTimeout(1500);
    expect(await importCourse(page, C, files(v2))).not.toMatch(/^ERROR/);
    expect((await live(page))[0].state).toBe('ok');
    // Open; as soon as the check box is there (lrn:anchored just came: its save waits 1 s),
    // the lesson is made slow for its next list (a busy tablet), then "Да, тук е".
    await page.evaluate(() => { window.__lrn = []; });
    await page.goto(`./#/c/${C}/read/0001`);
    const check = page.locator('[data-field="marks-check"]');
    await expect(check).toBeVisible({ timeout: 30000 });
    const frame = await lessonFrame(page);
    await frame.evaluate(() => {
      window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'lrn:annotations') { const t0 = Date.now(); while (Date.now() - t0 < 1500) { /* busy */ } }
      }, true);
    });
    // At once (a quick user; the click itself, not Playwright's waiting, is what matters).
    const tClick = await page.evaluate(() => { document.querySelector('[data-field="marks-check"] [data-action="confirm-mark"]').click(); return performance.now(); });
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Мястото е потвърдено.');
    const timeline = [];
    for (let k = 0; k < 14; k++) { timeline.push((await live(page))[0].state); await page.waitForTimeout(250); }
    const anchoredAt = await page.evaluate(() => (window.__t || []).filter((x) => x[0] === 'lrn:anchored').map((x) => Math.round(x[1])));
    info('T063-R1 timeline', { tClick: Math.round(tClick), anchoredAt, states: timeline.join(' ') });
    const [m] = await live(page);
    info('T063-R1 state after the race', m);
    expect([m.state, m.last]).toEqual(['ok', 'ok']);
  });
});
