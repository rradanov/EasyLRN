// T-062 (developer, 0.13.1): the D-042 addendum of 21.11.2026.
// - a lesson always opens WITHOUT a tool (also after a reload, in another
//   lesson, and with a 0.13.0 setting that still stores an active tool); the
//   colour and the last drawing tool are kept;
// - a colour pressed without a tool turns on the last marker / pencil;
// - the bar can be hidden ("Скрий" at its top): hidden, only a handle "☰"
//   (≥ 44 px) at the left edge stays, not over the lesson; a tap or a swipe out
//   on it brings the bar back; the lesson takes the freed width; the state is
//   kept; hiding turns the tool off; aria-expanded / aria-controls, names,
//   keyboard (focus moves between "Скрий" and the handle); a short slide, none
//   with prefers-reduced-motion;
// - a phone (360×800 portrait, 800×360 landscape): by default (no choice yet)
//   hidden on the narrow one, shown on the wide one; drawing after showing.
// Touch through CDP and locator.tap(). Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
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
const C = 'LRN-T62';
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


const bar = (page) => page.locator('[data-field="mark-tools"]');
const handle = (page) => page.locator('[data-field="mark-tools-handle"]');
const hideButton = (page) => page.locator('[data-field="mark-tools"] [data-action="hide-tools"]');
const frameBox = (page) => page.locator('iframe.lesson-frame').boundingBox();
const stored = (page) => db(page, async (db) => (await db.getSettings()).markTool ?? null);
const status = (page) => page.locator('[data-field="marks-status"]');

async function expectHidden(page) {
  await expect(bar(page)).toBeHidden();
  await expect(handle(page)).toBeVisible();
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-field="reader-doc"]')).toHaveAttribute('data-bar', 'hidden');
}
async function expectShown(page) {
  await expect(bar(page)).toBeVisible();
  await expect(handle(page)).toBeHidden();
  await expect(hideButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-field="reader-doc"]')).toHaveAttribute('data-bar', 'shown');
}
/** The handle: ≥ 44 px, at the left edge, wholly left of the lesson frame, in the viewport. */
async function checkHandle(page) {
  const hb = await handle(page).boundingBox();
  const fb = await frameBox(page);
  expect(hb.width).toBeGreaterThanOrEqual(44);
  expect(hb.height).toBeGreaterThanOrEqual(44);
  // At the left edge of the reader (the screen itself on a phone / in portrait; the
  // centred column on a wide landscape screen, where the bar was).
  const edge = await page.locator('[data-screen="reader"]').evaluate((el) => el.getBoundingClientRect().left);
  expect(hb.x).toBeLessThanOrEqual(edge + 1);
  if (page.viewportSize().width <= 1200) expect(hb.x).toBeLessThanOrEqual(1);
  expect(hb.x + hb.width).toBeLessThanOrEqual(fb.x + 0.5);
  expect(hb.y).toBeGreaterThanOrEqual(0);
  expect(hb.y + hb.height).toBeLessThanOrEqual(page.viewportSize().height);
  await expect(handle(page)).toHaveAttribute('aria-label', 'Покажи инструментите за маркиране');
  await expect(handle(page)).toHaveAttribute('aria-controls', 'mark-tools');
  expect(await handle(page).evaluate((b) => b.textContent.trim() === '' && !!b.querySelector('svg path'))).toBe(true);
  return { hb, fb };
}

/** Counts the Web Animations started on the bar (the slide). */
const spyAnimations = (page) => page.evaluate(() => {
  window.__slides = 0;
  const original = Element.prototype.animate;
  Element.prototype.animate = function animate(...args) {
    if (this.dataset?.field === 'mark-tools') window.__slides += 1;
    return original.apply(this, args);
  };
});

// ---------------------------------------------------------------------------
test.describe('T-062 tablet (1920×1200 / 1200×1920)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
  });

  test('O1 a lesson opens without a tool: after a reload, in another lesson, with a 0.13.0 setting {tool: "marker"}; the colour and the last tool are kept; a colour without a tool turns on the last pencil', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'pencil').tap();
    await color(page, 'green').tap();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-field="mark-layer"]')).toBeVisible();
    await page.reload();
    await waitReady(page);
    for (const n of ['marker', 'pencil', 'eraser']) await expect(tool(page, n)).toHaveAttribute('aria-pressed', 'false');
    await expect(color(page, 'green')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-field="mark-layer"]')).toBeHidden();
    expect(await stored(page)).toEqual({ color: 'green', lastDraw: 'pencil', hidden: false });
    // One finger scrolls (no layer), nothing is drawn.
    const y0 = await page.evaluate(() => scrollY);
    const fb = await frameBox(page);
    await t.drag([fb.x + 200, 900], [fb.x + 200, 400]);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0);
    expect(await count(page)).toBe(0);
    // A colour without a tool → the last drawing tool (the pencil) with it.
    await color(page, 'blue').tap();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    await expect(color(page, 'blue')).toHaveAttribute('aria-pressed', 'true');
    const a = await textBox(page, 'Уязвимостите');
    await t.drag([a.x1 + 3, a.y1], [a.x2 - 3, a.y1]);
    await waitMarks(page, 1);
    expect((await live(page))[0]).toMatchObject({ exact: 'Уязвимостите', style: 'underline', color: 'blue' });
    // Another lesson: no tool again; a colour → the pencil.
    await openLesson(page, '0002');
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'false');
    await expect(color(page, 'blue')).toHaveAttribute('aria-pressed', 'true');
    await color(page, 'pink').tap();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    // The eraser on, then a colour: back to the pencil (kept from T-015).
    await tool(page, 'eraser').tap();
    await color(page, 'yellow').tap();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    // A setting written by 0.13.0 (an active tool stored): still no tool on opening.
    await db(page, (db) => db.saveSettings({ markTool: { tool: 'marker', color: 'orange', lastDraw: 'marker' } }));
    await openLesson(page, '0001');
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await expect(color(page, 'orange')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-field="mark-layer"]')).toBeHidden();
    await expectShown(page);
    await color(page, 'orange').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
  });

  test('H1 "Скрий" (top of the bar) → only the handle "☰" at the left edge (≥ 44 px, not over the lesson), the lesson wider; kept after a reload; a tap on the handle → the bar again (kept); a swipe out on the handle → the bar; a short slide', async ({ page }) => {
    await openLesson(page);
    await expectShown(page);
    const hide = hideButton(page);
    await expect(hide).toHaveAttribute('aria-label', 'Скрий инструментите');
    await expect(hide).toHaveAttribute('aria-controls', 'mark-tools');
    const first = await bar(page).locator('button').first().getAttribute('data-action');
    expect(first).toBe('hide-tools');
    const hb = await hide.boundingBox();
    expect(hb.width).toBeGreaterThanOrEqual(44);
    expect(hb.height).toBeGreaterThanOrEqual(44);
    const before = await frameBox(page);
    const barX = (await bar(page).boundingBox()).x;
    await spyAnimations(page);
    await hide.tap();
    // The slide (a Web Animation of the bar; counted, the machine may be slower than 200 ms).
    expect(await page.evaluate(() => window.__slides)).toBeGreaterThan(0);
    await expectHidden(page);
    await expect(status(page)).toHaveText('Инструментите са скрити.');
    const { fb, hb: hh } = await checkHandle(page);
    expect(hh.x).toBeLessThanOrEqual(barX + 1);
    expect(fb.x).toBeLessThan(before.x - 20);
    expect(fb.width).toBeGreaterThan(before.width + 20);
    expect(await stored(page)).toMatchObject({ hidden: true });
    // The handle stays on the screen while the lesson scrolls (sticky).
    await page.evaluate(() => window.scrollTo(0, 1500));
    await checkHandle(page);
    // Kept.
    await page.reload();
    await waitReady(page);
    await expectHidden(page);
    await checkHandle(page);
    // A tap on the handle → the bar.
    await handle(page).tap();
    await expectShown(page);
    await expect(status(page)).toHaveText('Инструментите са показани.');
    expect(await stored(page)).toMatchObject({ hidden: false });
    const again = await frameBox(page);
    expect(Math.abs(again.x - before.x)).toBeLessThan(1);
    await page.reload();
    await waitReady(page);
    await expectShown(page);
    // A swipe out (to the right) starting on the handle.
    await hideButton(page).tap();
    await expectHidden(page);
    const t = await touchApi(page);
    const h0 = await handle(page).boundingBox();
    const y = h0.y + h0.height / 2;
    await t.drag([h0.x + 10, y], [h0.x + 120, y + 6], { steps: 10 });
    await expectShown(page);
    expect(await count(page)).toBe(0);
    // The page did not move sideways.
    expect(await page.evaluate(() => scrollX)).toBe(0);
  });

  test('H2 hidden while a tool is on → the tool is off (no drawing "blind"), one finger scrolls; shown again: still no tool; a colour turns the last tool on; a tool chosen from the API brings the bar back', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'marker').tap();
    await expect(page.locator('[data-field="mark-layer"]')).toBeVisible();
    await hideButton(page).tap();
    await expectHidden(page);
    await expect(page.locator('[data-field="mark-layer"]')).toBeHidden();
    await expect(status(page)).toHaveText('Инструментите са скрити; инструментът е изключен.');
    await expect(page.locator('[data-field="reader-doc"]')).toHaveAttribute('data-tool', 'none');
    const y0 = await page.evaluate(() => scrollY);
    const a = await textBox(page, 'Производителят', { scroll: false });
    await t.drag([a.x1 + 3, Math.max(a.y1, 500)], [a.x2 - 3, Math.max(a.y1, 500) - 300]);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0);
    expect(await count(page)).toBe(0);
    await handle(page).tap();
    await expectShown(page);
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await color(page, 'green').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    const b = await textBox(page, 'Уязвимостите');
    await t.drag([b.x1 + 3, b.y1], [b.x2 - 3, b.y1]);
    await waitMarks(page, 1);
    expect((await live(page))[0]).toMatchObject({ exact: 'Уязвимостите', style: 'highlight', color: 'green' });
    // Escape turns the tool off; the bar stays.
    await page.keyboard.press('Escape');
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await expectShown(page);
  });

  test('K1 keyboard: "Скрий" is in the toolbar (arrows, Home); Enter hides it and the focus goes to the handle; Enter / Space on the handle show it and the focus goes back into the bar; one Tab stop either way', async ({ page }) => {
    await openLesson(page);
    await page.locator('[data-field="mark-tools"] button[tabindex="0"]').focus();
    await expect(tool(page, 'marker')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(hideButton(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(tool(page, 'marker')).toBeFocused();
    await page.keyboard.press('Enter'); // the marker on
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(hideButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expectHidden(page);
    await expect(handle(page)).toBeFocused();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Enter');
    await expectShown(page);
    await expect(bar(page).locator('button[tabindex="0"]')).toBeFocused();
    // Again, with Space.
    await page.keyboard.press('Home');
    await page.keyboard.press('Space');
    await expectHidden(page);
    await expect(handle(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expectShown(page);
    // Tab order: one stop in the bar (the buttons have tabindex -1 except one).
    const stops = await bar(page).locator('button').evaluateAll((els) => els.filter((b) => b.tabIndex === 0).length);
    expect(stops).toBe(1);
  });

  test('P2 the palm as a touch (T016-D2; the passive pen of a Tab A9+ is a touch too): a resting touch + a moving one → the moving one draws; two touches landing apart but moving together → scroll; a long (side ≥ 70 px) contact never draws; a touch landing during a moving stroke does not stop it', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').tap();
    const cdp = await page.context().newCDPSession(page);
    const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id, rx = 4, ry = 4]) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: rx, radiusY: ry })) });
    // 1. The palm rests (still, 300 ms), then the "pen" (a touch) writes.
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'забавяне', { scroll: false });
    const palm = await textBox(page, 'Задълженията', { scroll: false });
    const P = [palm.x1 + 10, palm.y1 + 30, 1, 6, 14];
    await send('touchStart', [P]);
    await page.waitForTimeout(300);
    await send('touchStart', [P, [a.x1 + 3, a.y1, 2]]);
    for (let i = 1; i <= 10; i++) { await send('touchMove', [P, [a.x1 + 3 + ((b.x2 - 6 - a.x1) * i) / 10, a.y1, 2]]); await page.waitForTimeout(10); }
    await send('touchEnd', [P]);
    await send('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page)).map((x) => x.exact)).toEqual(['Уязвимостите се докладват без неоправдано забавяне']);
    // 2. Two fingers landing 300 ms apart, then moving together → scrolling, nothing drawn.
    const y0 = await page.evaluate(() => scrollY);
    const c = await textBox(page, 'Производителят', { scroll: false });
    const cy = Math.min(Math.max(c.y1, 400), page.viewportSize().height - 300);
    await send('touchStart', [[c.x1 + 20, cy, 1]]);
    await page.waitForTimeout(300);
    await send('touchStart', [[c.x1 + 20, cy, 1], [c.x1 + 160, cy, 2]]);
    for (let i = 1; i <= 10; i++) { await send('touchMove', [[c.x1 + 20, cy - i * 25, 1], [c.x1 + 160, cy - i * 25, 2]]); await page.waitForTimeout(10); }
    await send('touchEnd', []);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0 + 100);
    await page.waitForTimeout(300);
    expect(await count(page)).toBe(1);
    // 3. The side of the hand: a long, thin contact (12 × 80 px) never draws.
    const d = await textBox(page, 'Краят на урока');
    await send('touchStart', [[d.x1, d.y1, 1, 6, 40]]);
    for (let i = 1; i <= 8; i++) await send('touchMove', [[d.x1 + i * 15, d.y1, 1, 6, 40]]);
    await send('touchEnd', []);
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(1);
    // 4. A touch landing while a stroke is moving: the stroke goes on.
    const e = await textBox(page, 'Краят на урока');
    await send('touchStart', [[e.x1 + 2, e.y1, 1]]);
    for (let i = 1; i <= 4; i++) await send('touchMove', [[e.x1 + 2 + ((e.x2 - e.x1 - 4) * i) / 8, e.y1, 1]]);
    await page.waitForTimeout(200);
    const Q = [e.x1 + 40, e.y1 + 120, 2];
    await send('touchStart', [[e.x1 + 2 + (e.x2 - e.x1 - 4) / 2, e.y1, 1], Q]);
    for (let i = 5; i <= 8; i++) await send('touchMove', [[e.x1 + 2 + ((e.x2 - e.x1 - 4) * i) / 8, e.y1, 1], Q]);
    await send('touchEnd', [Q]);
    await send('touchEnd', []);
    await waitMarks(page, 2);
    expect((await live(page)).at(-1).exact).toBe('Краят на урока');
  });

  test('U1 (D-044) Ctrl+Z with the focus in the lesson undoes nothing; a lrn:undo the lesson posts is ignored (focus in the app or in the lesson); Ctrl+Z in the app undoes', async ({ page }) => {
    const frame = await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await touchApi(page);
    const a = await textBox(page, 'Регламентът');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 1);
    const b = await textBox(page, 'Уязвимостите');
    await t.drag([b.x1 + 2, b.y1], [b.x2 - 2, b.y1]);
    await waitMarks(page, 2);
    // The focus in the app (the bar): the lesson posts lrn:undo by itself → nothing.
    await tool(page, 'marker').focus();
    await frame.evaluate(() => parent.postMessage({ lrn: 1, type: 'lrn:undo' }, '*'));
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(2);
    // The focus in the lesson: Ctrl+Z and a posted lrn:undo → nothing (D-044).
    const undos = () => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:undo').length);
    const before = await undos(); // the one the test posted above
    await frame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    await frame.locator('body').press('Control+z');
    await page.waitForTimeout(300);
    expect(await undos()).toBe(before); // the bridge sends no lrn:undo
    await frame.evaluate(() => parent.postMessage({ lrn: 1, type: 'lrn:undo' }, '*'));
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(2);
    // The focus back in the app: its own Ctrl+Z undoes the last mark.
    await tool(page, 'marker').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Регламентът');
    // Ctrl+Z inside a field of the lesson is the field's own (not ours).
    await frame.evaluate(() => { const i = document.createElement('input'); i.id = 'f'; document.body.prepend(i); i.focus(); });
    await frame.locator('#f').press('Control+z');
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(1);
  });

  test('M1 prefers-reduced-motion: hiding and showing without a slide (no animation)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openLesson(page);
    await spyAnimations(page);
    await hideButton(page).tap();
    // At once: no animation, the handle is there right away.
    expect(await handle(page).evaluate((b) => !b.hidden)).toBe(true);
    expect(await bar(page).evaluate((el) => el.hidden && el.getAnimations().length === 0)).toBe(true);
    await expectHidden(page);
    await handle(page).tap();
    expect(await bar(page).evaluate((el) => !el.hidden && el.getAnimations().length === 0)).toBe(true);
    await expectShown(page);
    expect(await page.evaluate(() => window.__slides)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-062 phone (360×800 portrait / 800×360 landscape)', () => {
  test.use({
    viewport: async ({}, use, info) => use(info.project.name.includes('portrait') ? { width: 360, height: 800 } : { width: 800, height: 360 }),
  });
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
  });

  test('F1 first opening: narrow (360) → hidden, wide (800) → shown; nothing stored until the user chooses; the handle ≥ 44 px, not over the lesson; show + draw with one finger; hide → kept', async ({ page }) => {
    const narrow = page.viewportSize().width < 600;
    await openLesson(page);
    expect(await stored(page)).toBe(null);
    if (narrow) {
      await expectHidden(page);
      const { fb } = await checkHandle(page);
      // The lesson takes the width: it starts right after the handle.
      expect(fb.x).toBeLessThanOrEqual(52);
      expect(fb.width).toBeGreaterThanOrEqual(page.viewportSize().width - 52 - 24 - 1);
      await handle(page).tap();
    }
    await expectShown(page);
    const t = await touchApi(page);
    await tool(page, 'marker').tap();
    const a = await textBox(page, 'Уязвимостите');
    await t.drag([a.x1 + 3, a.y1], [a.x2 - 3, a.y1]);
    await waitMarks(page, 1);
    expect((await live(page))[0]).toMatchObject({ exact: 'Уязвимостите', style: 'highlight', color: 'yellow' });
    // The bar on the screen (scrolls inside itself if it does not fit the height).
    const bb = await bar(page).boundingBox();
    expect(bb.y).toBeGreaterThanOrEqual(0);
    expect(bb.y + bb.height).toBeLessThanOrEqual(page.viewportSize().height + 0.5);
    await hideButton(page).scrollIntoViewIfNeeded();
    await hideButton(page).tap();
    await expectHidden(page);
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    await checkHandle(page);
    await page.reload();
    await waitReady(page);
    await expectHidden(page);
    expect(await stored(page)).toMatchObject({ hidden: true });
    // The page has no horizontal overflow on the phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test('F2 a choice made on the phone wins over the width: shown on the narrow screen stays shown after a reload', async ({ page }) => {
    await openLesson(page);
    if (page.viewportSize().width < 600) await handle(page).tap();
    await expectShown(page);
    if (page.viewportSize().width >= 600) { await hideButton(page).tap(); await expectHidden(page); await handle(page).tap(); }
    await expectShown(page);
    await page.reload();
    await waitReady(page);
    await expectShown(page);
    expect(await stored(page)).toMatchObject({ hidden: false });
  });
});
