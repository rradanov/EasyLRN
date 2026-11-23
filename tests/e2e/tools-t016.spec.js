// T-016 (tester): tests of T-015 (0.13.0) — marking with tools (D-042), written
// independently and "as an attacker". The helpers of tools-t015.spec.js are
// copied (not imported: a spec file has no exports) and a few added.
// - functions: whole words (em, soft hyphen, <br>, inner punctuation), "Отмени"
//   many times / Ctrl+Z, overlaps and the eraser, three fingers, a finger landing
//   again, a stroke out of the frame over the bar, pen after the palm, selection +
//   colour, `.quiz`, a stroke while the lesson loads, 360–1920 px, text 160 %,
//   rotation, a lesson that turns dark by itself;
// - attacks: answers to the user's stroke (wrong tool, early, huge, long, extra
//   fields, twice, replays, late), eraser ids (deleted, foreign, made-up), a
//   lesson that replaces caretPositionFromPoint / elementFromPoint /
//   getClientRects / CSS.highlights, synthetic input, a forged selection, a copy
//   of the bar (phishing), floods, what the lesson receives, links during a
//   stroke, 5000 marks.
// Known defects: test.fail(true, 'T016-D…'). Information: T016-I… in the log.
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
// T-016 (tester) — helpers of its own on top of those of T-015 above.
const landscapeOnly = (ti) => test.skip(ti.project.name !== 'tablet-landscape', 'heavy / one layout is enough');
/** Raw CDP touch: points are [x, y, id, radius?]. */
async function rawTouch(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map(([x, y, id, r = 4]) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: r, radiusY: r, force: 1 })),
  });
  const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen',
  });
  return { cdp, touch, pen };
}
/** A drag over `needle` from the character `from` to the character `to` (its left edge + 1 px). */
async function dragChars(page, t, needle, from, to, { needle2 = needle } = {}) {
  const a = await textBox(page, needle, { from, to: from + 1 });
  const b = await textBox(page, needle2, { from: to, to: to + 1, scroll: false });
  await t.drag([a.x1 + 1, a.y1], [b.x1 + 1, b.y1]);
}
const lastExact = async (page, n) => {
  await waitMarks(page, n);
  return (await live(page)).at(-1).exact;
};
const WORDS = [
  '<p id="w1">Срокът е по-рано: 3.5 дни или 1,25 седмици за CRA-регламента.</p>',
  '<p id="w2">Кибер<em>устойчивост</em>та е важна; don\'t panic тук.</p>',
  '<p id="w3">Ред едно<br>ред две продължава нататък.</p>',
  '<p id="w4">Меко раз&shy;деляне на думата и още текст.</p>',
].join('\n');

// ---------------------------------------------------------------------------
test.describe('T-016 functions of the tools (D-042)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files(WORDS + BODY));
  });

  test('T016-F1 whole words: <em> inside a word, a soft hyphen, <br>, Latin + Cyrillic with a hyphen; a stroke backwards; across <br>', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    await dragChars(page, t, 'Кибер', 2, 2, { needle2: 'та е' });
    expect(await lastExact(page, 1)).toBe('Киберустойчивостта');
    await dragChars(page, t, 'раз', 1, 3, { needle2: 'деляне' });
    expect(await lastExact(page, 2)).toBe('раз­деляне');
    await dragChars(page, t, 'CRA-регламента', 8, 1);
    expect(await lastExact(page, 3)).toBe('CRA-регламента');
    await dragChars(page, t, 'едно', 1, 2, { needle2: 'две' });
    expect(await lastExact(page, 4)).toBe('едно ред две');
    // The painted ranges are the saved ones (no extra text).
    await expect.poll(async () => (await highlights(page))['lrn-yellow']?.length).toBe(4);
  });

  test('T016-F2 whole words with inner punctuation: an apostrophe, a decimal point / comma, a hyphen keep the word whole', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    await dragChars(page, t, 'don\'t', 1, 4);
    expect(await lastExact(page, 1)).toBe('don\'t');
    await dragChars(page, t, '1,25', 1, 3, { needle2: 'седмици' });
    expect(await lastExact(page, 2)).toBe('1,25 седмици');
    await dragChars(page, t, 'по-рано', 4, 1, { needle2: '3.5' });
    expect(await lastExact(page, 3)).toBe('по-рано: 3.5');
  });

  test('T016-F3 "Отмени" many times in a row (marker, pencil, eraser, marker) undoes each in reverse order; Ctrl+Z too; then disabled; overlapping marks stay separate and the eraser takes all under the finger, "Отмени" brings all back in one step', async ({ page }) => {
    await openLesson(page);
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const a = await textBox(page, 'Регламентът');
    const b = await textBox(page, 'продукти', { scroll: false });
    await t.drag([a.x1 + 2, a.y1], [b.x2 - 2, b.y1]);
    await waitMarks(page, 1);
    await color(page, 'green').click();
    const c = await textBox(page, 'киберустойчивост', { scroll: false });
    const d = await textBox(page, 'пазара', { scroll: false });
    await t.drag([c.x1 + 2, c.y1], [d.x2 - 2, d.y1]);
    await waitMarks(page, 2);
    await tool(page, 'pencil').click();
    await t.drag([a.x1 + 2, a.y1], [d.x2 - 2, d.y1]);
    await waitMarks(page, 3);
    expect((await live(page)).map((x) => [x.color, x.style])).toEqual([['yellow', 'highlight'], ['green', 'highlight'], ['green', 'underline']]);
    // The eraser tapped on the overlap ("киберустойчивост"): all three marks under the finger.
    await tool(page, 'eraser').click();
    const o = await textBox(page, 'киберустойчивост', { from: 3, to: 4, scroll: false });
    await t.tap([o.x1 + 2, o.y1]);
    await waitMarks(page, 0);
    await tool(page, 'marker').click();
    const e = await textBox(page, 'Уязвимостите');
    await t.drag([e.x1 + 2, e.y1], [e.x2 - 2, e.y1]);
    await waitMarks(page, 1);
    // Undo: the last mark, the erase (all three back at once), the pencil, the green, the yellow.
    await undoButton(page).click();
    await waitMarks(page, 0);
    await expect(undoButton(page)).toHaveAttribute('aria-label', 'Отмени изтриването');
    await undoButton(page).click();
    await waitMarks(page, 3);
    await page.locator('body').press('Control+z');
    await waitMarks(page, 2);
    expect((await live(page)).map((x) => x.color)).toEqual(['yellow', 'green']);
    await page.locator('body').press('Control+z');
    await waitMarks(page, 1);
    await undoButton(page).click();
    await waitMarks(page, 0);
    await expect(undoButton(page)).toBeDisabled();
    await page.locator('body').press('Control+z'); // nothing more
    await page.waitForTimeout(300);
    expect(await count(page)).toBe(0);
    expect((await annotations(page)).every((x) => x.deleted)).toBe(true);
  });

  test('T016-F4 three fingers and a finger that lands again during a two-finger scroll draw nothing; a stroke that leaves the frame over the bar marks up to the last good point and presses no button', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    const { touch } = await rawTouch(page);
    const c = await textBox(page, 'Регламентът');
    await touch('touchStart', [[c.x1, c.y1, 0]]);
    await touch('touchStart', [[c.x1, c.y1, 0], [c.x1 + 100, c.y1, 1]]);
    await touch('touchStart', [[c.x1, c.y1, 0], [c.x1 + 100, c.y1, 1], [c.x1 + 200, c.y1, 2]]);
    for (let i = 1; i < 10; i++) await touch('touchMove', [[c.x1 + i * 20, c.y1, 0], [c.x1 + 100 + i * 20, c.y1, 1], [c.x1 + 200 + i * 20, c.y1, 2]]);
    await touch('touchEnd', [[c.x1 + 200, c.y1, 1]]);
    for (let i = 1; i < 10; i++) await touch('touchMove', [[c.x1 + 200 + i * 20, c.y1, 1]]);
    await touch('touchEnd', []);
    await touch('touchStart', [[c.x1, c.y1, 0]]);
    await touch('touchStart', [[c.x1, c.y1, 0], [c.x1 + 100, c.y1 + 10, 1]]);
    await touch('touchEnd', [[c.x1 + 100, c.y1 + 10, 1]]);
    await touch('touchStart', [[c.x1 + 100, c.y1 + 10, 1], [c.x1 + 300, c.y1, 3]]);
    for (let i = 1; i < 10; i++) await touch('touchMove', [[c.x1 + 100, c.y1 + 10, 1], [c.x1 + 300 + i * 20, c.y1, 3]]);
    await touch('touchEnd', []);
    await page.waitForTimeout(800);
    expect(await count(page)).toBe(0);
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    // From "рисковете" to the left, out of the frame, over the bar (at the height of the text).
    const p = await textBox(page, 'рисковете', { from: 3, to: 4 });
    const bar = await page.locator('[data-field="mark-tools"]').boundingBox();
    const pressed = () => page.locator('[data-field="mark-tools"] button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-pressed')));
    const before = await pressed();
    const t = await touchApi(page);
    // T-071 (D-046): in portrait the bar is a row at the top: out of the frame at the left edge of the window instead.
    const vp = page.viewportSize();
    const outX = vp.height > vp.width && vp.width >= 600 ? 2 : bar.x + bar.width / 2;
    await t.drag([p.x1, p.y1], [outX, p.y1], { steps: 20 });
    expect(await lastExact(page, 1)).toBe('Производителят оценява рисковете');
    expect(await pressed()).toEqual(before);
    expect((await live(page))[0].color).toBe('yellow');
  });

  test('T016-F5 pen after the palm: a palm (a small contact) that lands BEFORE the pen does not stop the pen from writing', async ({ page }) => {
    await openLesson(page);
    await tool(page, 'marker').click();
    const { touch, pen } = await rawTouch(page);
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'забавяне', { scroll: false });
    const p = await textBox(page, 'Задълженията', { scroll: false });
    await touch('touchStart', [[p.x1, p.y1, 5, 15]]);
    await touch('touchMove', [[p.x1 + 5, p.y1 + 2, 5, 15]]);
    await pen('mousePressed', a.x1 + 3, a.y1);
    for (let i = 1; i <= 10; i++) { await pen('mouseMoved', a.x1 + 3 + ((b.x2 - 6 - a.x1) * i) / 10, a.y1); await page.waitForTimeout(10); }
    await pen('mouseReleased', b.x2 - 3, a.y1);
    await touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page)).map((x) => x.exact)).toEqual(['Уязвимостите се докладват без неоправдано забавяне']);
  });

  test('T016-F6 a system selection + a tap on a colour (no tool on) marks the selection with that colour and turns the last drawing tool on; `.quiz` text is not marked and its button works with the pencil on', async ({ page }) => {
    const quiz = '<div class="quiz"><p id="qq">Въпрос в теста, който не се маркира.</p><button id="qb" onclick="this.dataset.pressed=(+this.dataset.pressed||0)+1">Отговор А</button></div>';
    await importCourse(page, C, files(WORDS + quiz + BODY));
    const frame = await openLesson(page);
    await frame.evaluate(() => {
      const n = document.getElementById('p3').firstChild;
      const r = document.createRange();
      r.setStart(n, 0); r.setEnd(n, 'Уязвимостите се докладват'.length);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:selection' && !m.empty))).toBe(true);
    await color(page, 'blue').tap();
    await waitMarks(page, 1);
    expect((await live(page))[0]).toMatchObject({ exact: 'Уязвимостите се докладват', color: 'blue', style: 'highlight' });
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    // The pencil over the quiz text: nothing; a tap on its button: pressed once.
    await tool(page, 'pencil').tap();
    const t = await touchApi(page);
    const q = await textBox(page, 'Въпрос в теста');
    await t.drag([q.x1 + 2, q.y1], [q.x2 - 2, q.y1]);
    await page.waitForTimeout(600);
    expect(await count(page)).toBe(1);
    const btn = await frame.locator('#qb').boundingBox();
    await t.tap([btn.x + btn.width / 2, btn.y + btn.height / 2]);
    await expect.poll(() => frame.locator('#qb').getAttribute('data-pressed')).toBe('1');
    expect(await count(page)).toBe(1);
  });

  test('T016-F7 strokes while the lesson is still loading (a busy lesson, the tool turned on at once): no error, nothing in another lesson, the tool stays on; once ready the tool draws (information T016-I5: the strokes wait and are drawn when the lesson is ready)', async ({ page }) => {
    const busy = '<script>const t0 = Date.now(); while (Date.now() - t0 < 2500) {}</script>';
    await importCourse(page, C, files(`${busy}${BODY}`));
    await db(page, (db) => db.saveSettings({ markTool: { color: 'orange', lastDraw: 'marker' } }));
    await page.goto(`./#/c/${C}/read/0001`);
    await page.locator('iframe.lesson-frame').waitFor();
    // T-062: a lesson opens without a tool; the marker is turned on while the lesson still loads.
    await tool(page, 'marker').click();
    const layer = page.locator('[data-field="mark-layer"]');
    const t = await touchApi(page);
    const box = await page.locator('iframe.lesson-frame').boundingBox();
    for (let i = 0; i < 3; i++) {
      await t.drag([box.x + 40, Math.max(box.y, 0) + 80 + i * 30], [box.x + 400, Math.max(box.y, 0) + 80 + i * 30], { steps: 6 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    await waitReady(page);
    await expect(layer).toBeAttached();
    await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(1000);
    const early = await live(page);
    test.info().annotations.push({ type: 'T016-I5', description: `marks from the strokes made while loading: ${JSON.stringify(early.map((x) => x.exact))}` });
    expect(early.length).toBeLessThanOrEqual(3);
    expect((await live(page, `${C}/lesson:0002`)).length).toBe(0);
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    const a = await textBox(page, 'Краят на урока');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    expect(await lastExact(page, early.length + 1)).toBe('Краят на урока');
    expect((await live(page)).at(-1).color).toBe('orange');
  });

  test('T016-F8 360–1920 px wide, text 160 %: the bar is fully visible (or scrolls), every button ≥ 44 × 44 px, never over the lesson; a stroke at 160 % marks the right words; rotation keeps the marks in place', async ({ page }, ti) => {
    landscapeOnly(ti);
    await openLesson(page);
    for (const [w, hgt] of [[360, 640], [640, 360], [800, 1280], [1280, 800], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(250);
      const bar = page.locator('[data-field="mark-tools"]');
      await expect(bar, `${w}×${hgt}`).toBeVisible();
      const sizes = await bar.locator('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.tool || e.dataset.color || e.dataset.action, Math.round(r.width), Math.round(r.height)]; }));
      for (const [name, bw, bh] of sizes) { expect(bw, `${w}: ${name}`).toBeGreaterThanOrEqual(44); expect(bh, `${w}: ${name}`).toBeGreaterThanOrEqual(44); }
      const barBox = await bar.boundingBox();
      const frameBox = await page.locator('iframe.lesson-frame').boundingBox();
      // T-071 (D-046): portrait (≥ 600 px wide) → the bar is a row at the top, above the lesson (measured at the top of the page).
      if (hgt > w && w >= 600) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const b = await bar.boundingBox();
        const f = await page.locator('iframe.lesson-frame').boundingBox();
        expect(b.y + b.height, `${w}: the bar above the lesson`).toBeLessThanOrEqual(f.y + 1);
      } else expect(barBox.x + barBox.width, `${w}: the bar left of the lesson`).toBeLessThanOrEqual(frameBox.x + 1);
      expect(barBox.x, `${w}: on the screen`).toBeGreaterThanOrEqual(0);
      // T-018 / T-069: the notes strip (≈ 117 px, right of the lesson) follows the width while no choice is stored
      // (T018-D14 fixed in 0.14.1): a window narrowed after the reader opened hides it.
      expect(frameBox.width, `${w}: the lesson keeps room`).toBeGreaterThan(w * 0.5);
      // Every button can be reached (the bar scrolls inside when it is taller than the screen).
      const undo = undoButton(page);
      await undo.scrollIntoViewIfNeeded();
      const ub = await undo.boundingBox();
      expect(ub.y + ub.height, `${w}: "Отмени" reachable`).toBeLessThanOrEqual(hgt + 1);
    }
    await page.setViewportSize({ width: 1920, height: 1200 });
    await db(page, (db) => db.saveSettings({ fontScale: 1.6 }));
    await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    await dragChars(page, t, 'Производителят', 4, 3, { needle2: 'рисковете' });
    expect(await lastExact(page, 1)).toBe('Производителят оценява рисковете');
    await page.setViewportSize({ width: 1200, height: 1920 });
    await page.waitForTimeout(600);
    await expect.poll(async () => (await highlights(page))['lrn-yellow']).toEqual(['Производителят оценява рисковете']);
    await dragChars(page, t, 'Уязвимостите', 2, 3, { needle2: 'докладват' });
    expect(await lastExact(page, 2)).toBe('Уязвимостите се докладват');
  });

  test('T016-F10 Ctrl+Z and Escape with the focus inside the lesson: Escape turns the tool off (lrn:escape); Ctrl+Z there undoes nothing (D-044); "Отмени" and Ctrl+Z in the app undo', async ({ page }) => {
    const frame = await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    const a = await textBox(page, 'Регламентът');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 1);
    await frame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    await frame.locator('body').press('Escape');
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'false');
    // D-044: no undo from the lesson — Ctrl+Z with the focus in it does nothing.
    const b = await textBox(page, 'Уязвимостите');
    await tool(page, 'marker').click();
    await t.drag([b.x1 + 2, b.y1], [b.x2 - 2, b.y1]);
    await waitMarks(page, 2);
    await tool(page, 'marker').click(); // off
    await frame.evaluate(() => { document.body.focus(); });
    await frame.locator('body').press('Control+z');
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(2);
    await expect(page.locator('[data-field="marks-status"]')).not.toHaveText(/Ctrl\+Z още веднъж/);
    // "Отмени" in the bar, then Ctrl+Z with the focus in the app.
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await waitMarks(page, 1);
    await tool(page, 'marker').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 0);
  });

  test('T016-F9 a lesson that turns its own background dark later (its own theme button) gets the dark palette for its marks', async ({ page }) => {
    const toggle = '<button id="dark" onclick="document.body.style.background=\'#151513\';document.body.style.color=\'#e6e3da\'">Тъмно</button>';
    await importCourse(page, C, files(toggle + BODY));
    const frame = await openLesson(page);
    await frame.locator('#dark').click();
    await page.waitForTimeout(500);
    const css = await frame.evaluate(() => [...document.querySelectorAll('style[data-easylrn="bridge"]')].map((s) => s.textContent).join(''));
    expect(css.match(/::highlight\(lrn-yellow\)[^{]*\{ background-color: (#[0-9a-f]+)/)?.[1]).toBe('#5c5216');
  });
});

// ---------------------------------------------------------------------------
test.describe('T-016 attacks on the tools (the gesture is the app\'s, the bridge only turns points into text)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
  });
  /** A mark on lesson 0002 (its id is the foreign one) and two on 0001 (own). */
  async function setup(page) {
    await openLesson(page, '0002');
    const t = await touchApi(page);
    await tool(page, 'marker').click();
    const q = await textBox(page, 'Друг урок');
    await t.drag([q.x1 + 2, q.y1], [q.x2 - 2, q.y1]);
    await expect.poll(async () => (await live(page, `${C}/lesson:0002`)).length).toBe(1);
    const foreign = (await live(page, `${C}/lesson:0002`))[0].id;
    const frame = await openLesson(page, '0001');
    await tool(page, 'marker').click(); // T-062: every lesson opens without a tool
    const a = await textBox(page, 'Регламентът');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 1);
    const b = await textBox(page, 'Уязвимостите');
    await t.drag([b.x1 + 2, b.y1], [b.x2 - 2, b.y1]);
    await waitMarks(page, 2);
    return { t, frame, foreign, own: (await live(page)).map((x) => x.id) };
  }

  /**
   * The lesson answers the app's stroke itself; to make the bridge silent it
   * breaks document.elementFromPoint (the bridge's stroke handler throws, no
   * answer): then only the lesson answers.
   */
  const hijack = (frame) => frame.evaluate(() => {
    window.__mode = null;
    window.__seen = [];
    // The bridge looks at elementFromPoint for every point: when it throws, the bridge's handler fails and it never answers.
    const efp = document.elementFromPoint.bind(document);
    const SILENT = ['huge', 'long', 'late', 'never', 'extra', 'erase'];
    document.elementFromPoint = (x, y) => { if (SILENT.includes(window.__mode)) throw new Error('silenced'); return efp(x, y); };
    addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.lrn !== 1 || m.type !== 'lrn:stroke') return;
      const mode = window.__mode;
      const p = (x) => parent.postMessage({ lrn: 1, type: 'lrn:stroked', ...x }, '*');
      const q = (exact) => ({ exact, prefix: '', suffix: '' });
      if (m.phase === 'start' && mode === 'early') p({ seq: m.seq, tool: 'marker', quote: q('РАНО'), position: { start: 0, end: 4 } });
      if (m.phase !== 'end') return;
      window.__seen.push(m.seq);
      const swallow = () => {}; // (the bridge is silent in these modes: see elementFromPoint above)
      if (mode === 'tool') p({ seq: m.seq, tool: 'eraser', ids: [] });
      if (mode === 'huge') { swallow(); p({ seq: m.seq, tool: 'marker', quote: q('ОГРОМНО'), position: { start: 0, end: 9000000 } }); }
      if (mode === 'long') { swallow(); p({ seq: m.seq, tool: 'marker', quote: q('Д'.repeat(2001)), position: { start: 0, end: 2001 } }); }
      if (mode === 'late') { swallow(); setTimeout(() => p({ seq: m.seq, tool: 'marker', quote: q('КЪСНО'), position: { start: 0, end: 5 } }), 3300); }
      if (mode === 'never') swallow();
      if (mode === 'extra') {
        swallow();
        p({ seq: m.seq, tool: 'marker', quote: q('Краят на урока'), position: { start: 10, end: 24 }, color: 'red', style: 'underline', id: 'x', courseId: 'LRN-OTHER', target: { type: 'lesson', id: 'LRN-OTHER/lesson:0001' }, deleted: false });
        p({ seq: m.seq, tool: 'marker', quote: q('ВТОРИ ОТГОВОР'), position: { start: 30, end: 43 } });
      }
      if (mode === 'erase') { swallow(); p({ seq: m.seq, tool: 'eraser', ids: window.__ids }); }
    });
  });

  test('T016-S1 the lesson answers the user\'s stroke itself (the bridge silenced): wrong tool, at the start of the stroke, beyond its text, 2001 characters, late (3.3 s), never, extra fields + two answers → nothing of it is saved but one quote of its own text; colour / style / lesson are always the app\'s', async ({ page }) => {
    test.setTimeout(120000);
    const { t, frame } = await setup(page);
    await hijack(frame);
    const draw = async (needle) => { const a = await textBox(page, needle); await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]); };
    // Wrong tool and an early answer: dropped, the bridge's real answer is saved.
    for (const [mode, needle, n] of [['tool', 'Производителят', 3], ['early', 'Задълженията', 4]]) {
      await frame.evaluate((m) => { window.__mode = m; }, mode);
      await draw(needle);
      expect(await lastExact(page, n), mode).toBe(needle);
      await page.waitForTimeout(1100); // under the app's 60 messages a second
    }
    // Only the lesson answers: beyond the text, too long, late, never → nothing saved.
    for (const mode of ['huge', 'long', 'late', 'never']) {
      await frame.evaluate((m) => { window.__mode = m; }, mode);
      await draw('Краят на урока');
      await page.waitForTimeout(mode === 'late' || mode === 'never' ? 4000 : 900);
      expect(await count(page), mode).toBe(4);
    }
    expect(await frame.evaluate(() => window.__seen.length)).toBeGreaterThanOrEqual(6);
    // Extra fields + two answers: the first decides (a quote of its own text), once; colour / style / lesson are the app's.
    await color(page, 'green').click();
    await frame.evaluate(() => { window.__mode = 'extra'; });
    await draw('Допълнителен абзац 1 ');
    await waitMarks(page, 5);
    await page.waitForTimeout(600);
    const all = await db(page, async (db) => (await db.list('annotations', { includeDeleted: true })).map((a) => ({ id: a.id, courseId: a.courseId, target: a.target.id, exact: a.selector.quote.exact, color: a.color, style: a.style })));
    const forged = all.filter((a) => a.exact === 'Краят на урока');
    expect(forged).toEqual([expect.objectContaining({ courseId: C, target: L1, color: 'green', style: 'highlight' })]);
    expect(forged[0].id).not.toBe('x');
    expect(all.filter((a) => ['ВТОРИ ОТГОВОР', 'РАНО', 'ОГРОМНО', 'КЪСНО'].includes(a.exact) || a.exact.startsWith('ДД') || (a.target !== L1 && a.target !== `${C}/lesson:0002`))).toEqual([]);
    expect(await count(page)).toBe(5);
    // Nothing hangs: the bridge answers again once the lesson stops.
    await frame.evaluate(() => { window.__mode = null; });
    await page.waitForTimeout(1100);
    await draw('Уязвимостите се');
    await waitMarks(page, 6);
  });

  test('T016-S2 replays: lrn:stroked for a finished stroke again (now, after 1 s, after 3.5 s), for every seq → no copy; the eraser answered by the lesson with a deleted id, another lesson\'s, made-up ones and one own → only the own live mark goes, "Отмени" brings back only it', async ({ page }) => {
    const { t, frame, foreign, own } = await setup(page);
    const a = await textBox(page, 'Производителят');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 3);
    const last = (await live(page)).at(-1);
    await frame.evaluate((last) => {
      const p = (x) => parent.postMessage({ lrn: 1, type: 'lrn:stroked', ...x }, '*');
      const ans = (seq) => ({ seq, tool: 'marker', quote: { exact: last.exact, prefix: '', suffix: '' }, position: last.position });
      for (let s = 0; s < 20; s++) p(ans(s));
      setTimeout(() => { for (let s = 0; s < 20; s++) p(ans(s)); }, 1000);
      setTimeout(() => { for (let s = 0; s < 20; s++) p(ans(s)); }, 3500);
    }, last);
    await page.waitForTimeout(5000);
    expect(await count(page)).toBe(3);
    // The real eraser on the third mark (soft delete).
    await tool(page, 'eraser').click();
    const b = await textBox(page, 'Производителят');
    await t.tap([b.x1 + 10, b.y1]);
    await waitMarks(page, 2);
    const deleted = last.id;
    await hijack(frame);
    await frame.evaluate((ids) => { window.__ids = ids; window.__mode = 'erase'; }, [deleted, foreign, 'made-up', '__proto__', 'constructor', own[0]]);
    await page.waitForTimeout(1100);
    const c = await textBox(page, 'Краят на урока');
    await t.tap([c.x1 + 10, c.y1]); // over plain text: the bridge itself would erase nothing
    await waitMarks(page, 1);
    expect((await live(page)).map((x) => x.id)).toEqual([own[1]]);
    expect((await live(page, `${C}/lesson:0002`)).map((x) => x.id)).toEqual([foreign]);
    await undoButton(page).click();
    await waitMarks(page, 2);
    expect((await live(page)).map((x) => x.id).sort()).toEqual([...own].sort());
    expect((await annotations(page)).find((x) => x.id === deleted).deleted).toBe(true);
  });

  test('T016-S3 a lesson that replaces caretPositionFromPoint / elementFromPoint / Range#getClientRects / CSS.highlights can only choose WHICH of its own text a stroke of the user marks, and erase only its own marks; it cannot start a stroke (synthetic pointer / touch events, lrn:stroke to itself or to the app) — information (T016-I1)', async ({ page }) => {
    const { t, frame, foreign, own } = await setup(page);
    // 1. Synthetic input inside the lesson and messages the app does not know: nothing.
    await frame.evaluate(() => {
      const el = document.getElementById('p2');
      const r = el.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: r.left + 5 + (type === 'pointerup' ? 300 : 0), clientY: r.top + 5, isPrimary: true }));
      for (const type of ['lrn:stroke', 'lrn:activate', 'lrn:scroll-by', 'lrn:tool', 'lrn:undo', 'lrn:erase']) parent.postMessage({ lrn: 1, type, phase: 'end', seq: 1, tool: 'eraser', ids: ['x'], x: 1, y: 1 }, '*');
      window.postMessage({ lrn: 1, type: 'lrn:stroke', phase: 'start', seq: 77, tool: 'marker', color: 'yellow', x: r.left + 5, y: r.top + 5 }, '*');
      window.postMessage({ lrn: 1, type: 'lrn:stroke', phase: 'end', seq: 77, x: r.left + 300, y: r.top + 5 }, '*');
    });
    await page.waitForTimeout(800);
    expect(await count(page)).toBe(2);
    // 2. The caret always at "Краят на урока": the user's stroke elsewhere marks that text (its own text, own annotation).
    await frame.evaluate(() => {
      const target = document.getElementById('p5').firstChild;
      let n = 0;
      document.caretPositionFromPoint = () => ({ offsetNode: target, offset: Math.min(target.data.length, (n++ % 2) * target.data.length) });
      document.elementFromPoint = () => document.getElementById('p5');
    });
    const a = await textBox(page, 'Производителят');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 3);
    const made = (await live(page)).at(-1);
    expect(made).toMatchObject({ exact: 'Краят на урока е тук.', color: 'yellow', style: 'highlight' });
    // 3. The eraser with every rectangle "under the finger": all own marks of the lesson go — the other lesson's mark stays; "Отмени" brings them back.
    const c = await textBox(page, 'Задълженията'); // (before the lesson breaks Range#getClientRects: the test measures with it too)
    await frame.evaluate(() => {
      window.__gcr = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () { return [new DOMRect(-1e6, -1e6, 2e6, 2e6)]; };
      const p4 = document.getElementById('p4').firstChild;
      let k = 0;
      // Walk the caret over the whole text: every character is "under" the eraser.
      const all = [...document.querySelectorAll('p')].map((p) => p.firstChild).filter(Boolean);
      document.caretPositionFromPoint = () => { const node = all[k % all.length] || p4; k++; return { offsetNode: node, offset: 1 }; };
    });
    await tool(page, 'eraser').click();
    await t.drag([c.x1 + 2, c.y1], [c.x2 + 600, c.y1 + 200], { steps: 30 });
    await waitMarks(page, 0);
    expect((await live(page, `${C}/lesson:0002`)).map((x) => x.id)).toEqual([foreign]);
    await undoButton(page).click();
    await waitMarks(page, 3);
    expect((await live(page)).map((x) => x.id)).toEqual(expect.arrayContaining(own));
    // 4. CSS.highlights replaced / broken: the lesson only hurts its own painting, the app goes on.
    await frame.evaluate(() => { Range.prototype.getClientRects = window.__gcr; delete document.caretPositionFromPoint; delete document.elementFromPoint; });
    const d = await textBox(page, 'Уязвимостите', { from: 0, to: 3 });
    await frame.evaluate(() => { Object.defineProperty(CSS, 'highlights', { get() { throw new Error('nope'); } }); window.Highlight = function () { throw new Error('nope'); }; });
    await tool(page, 'marker').click();
    await page.waitForTimeout(1100);
    await t.drag([d.x1 + 2, d.y1], [d.x1 + 300, d.y1]);
    await waitMarks(page, 4);
    problems = problems.filter((p) => !/nope/.test(p));
  });

  test('T016-S4 a forged system selection: the lesson keeps a selection of its own text; every press of the marker or a colour marks it — own text, own annotation (information T016-I2)', async ({ page }) => {
    const frame = await openLesson(page);
    await frame.evaluate(() => {
      const fire = () => parent.postMessage({ lrn: 1, type: 'lrn:selection', quote: { exact: 'Краят на урока', prefix: '', suffix: '' }, position: { start: 50, end: 64 } }, '*');
      fire(); window.__fake = setInterval(fire, 200);
    });
    await page.waitForTimeout(400);
    await tool(page, 'marker').click();
    await waitMarks(page, 1);
    // T-062: the app clears the selection after marking; wait for the lesson to post its forged one again.
    await page.waitForTimeout(400);
    await color(page, 'pink').click();
    await waitMarks(page, 2);
    await frame.evaluate(() => clearInterval(window.__fake));
    const all = await live(page);
    expect(all.map((x) => [x.exact, x.color])).toEqual([['Краят на урока', 'yellow'], ['Краят на урока', 'pink']]);
    expect(all.every((x) => x.id)).toBe(true);
    expect((await live(page, `${C}/lesson:0002`)).length).toBe(0);
  });

  test('T016-S5 UI phishing: a lesson draws a copy of the tool bar; it stays inside its frame, the real bar is left of it, on top, and no lesson pixel covers it (information T016-I3)', async ({ page }) => {
    const fake = '<div id="fake" style="position:fixed;left:-200px;top:0;width:5000px;height:5000px;z-index:2147483647;background:rgba(255,0,0,.1)"><button style="width:56px;height:52px">Маркер</button></div>';
    await importCourse(page, C, files(fake + BODY));
    await openLesson(page);
    const bar = page.locator('[data-field="mark-tools"]');
    const barBox = await bar.boundingBox();
    const frameBox = await page.locator('iframe.lesson-frame').boundingBox();
    // T-071 (D-046): portrait → the bar is a row above the lesson.
    const vp = page.viewportSize();
    if (vp.height > vp.width && vp.width >= 600) expect(barBox.y + barBox.height).toBeLessThanOrEqual(frameBox.y + 1);
    else expect(barBox.x + barBox.width).toBeLessThanOrEqual(frameBox.x + 1);
    const hits = await page.evaluate(() => [...document.querySelectorAll('[data-field="mark-tools"] button')].map((b) => {
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === b || b.contains(el);
    }));
    expect(hits.every(Boolean)).toBe(true);
    await tool(page, 'marker').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
  });

  test('T016-S6 DoS: 20 quick strokes in a row → 20 marks; a flood of 2000 small junk lrn:stroked in 1 s leaves the bar and "Отмени" responsive (huge messages: information T016-I6)', async ({ page }) => {
    test.setTimeout(150000);
    const frame = await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    for (let i = 0; i < 20; i++) {
      const a = await textBox(page, `Допълнителен абзац ${i} `);
      await t.drag([a.x1 + 2, a.y1], [a.x2 - 4, a.y1], { steps: 5 });
    }
    await expect.poll(() => count(page), { timeout: 15000 }).toBe(20);
    const texts = (await live(page)).map((x) => x.exact);
    expect(new Set(texts).size).toBe(20);
    await frame.evaluate(() => {
      let n = 0;
      window.__flood = setInterval(() => {
        for (let k = 0; k < 100; k++) parent.postMessage({ lrn: 1, type: 'lrn:stroked', seq: n++ % 50, tool: 'eraser', ids: ['id-1', 'id-2', 'id-3'] }, '*');
        if (n > 2000) clearInterval(window.__flood);
      }, 50);
    });
    const t0 = Date.now();
    await tool(page, 'pencil').click();
    await expect(tool(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
    await undoButton(page).click();
    await expect.poll(() => count(page), { timeout: 10000 }).toBe(19);
    expect(Date.now() - t0).toBeLessThan(5000);
    await frame.evaluate(() => clearInterval(window.__flood));
    expect(await count(page)).toBe(19);
  });

  test('T016-S7 what the lesson receives while the user draws, erases, taps and scrolls: points, tool, colour, seq — never the key, notes, other lessons\' marks, settings; only its own marks with id, colour, style, selector, sameVersion', async ({ page }) => {
    const { t, frame, foreign, own } = await setup(page);
    await db(page, async (db, { own, foreign }) => {
      await db.createNote({ annotationId: own, body: 'ТАЙНА-БЕЛЕЖКА-T016' });
      await db.createNote({ annotationId: foreign, body: 'ЧУЖДА-БЕЛЕЖКА-T016' });
      await db.saveApiKey('sk-ant-api03-T016FAKEFAKEFAKEFAKEFAKE');
    }, { own: own[0], foreign });
    await frame.evaluate(() => { window.__got = []; addEventListener('message', (e) => { if (e.data?.lrn === 1) window.__got.push(JSON.parse(JSON.stringify(e.data))); }); });
    const a = await textBox(page, 'Производителят');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 3);
    await tool(page, 'eraser').click();
    await t.tap([a.x1 + 5, a.y1]);
    await waitMarks(page, 2);
    await t.two([a.x1 + 200, a.y1], 0, -200);
    await tool(page, 'pencil').click();
    await t.tap([a.x1 + 5, a.y1]);
    await page.waitForTimeout(600);
    const got = await frame.evaluate(() => window.__got);
    const text = JSON.stringify(got);
    for (const bad of ['ТАЙНА', 'ЧУЖДА', 'sk-ant', 'T016FAKE', foreign, 'Друг урок', 'courseId', 'markTool', 'apiKey', 'note']) expect(text, bad).not.toContain(bad);
    const keysOf = (type) => [...new Set(got.filter((m) => m.type === type).map((m) => Object.keys(m).sort().join(',')))];
    expect(keysOf('lrn:stroke').every((k) => /^(color,)?lrn,phase,seq,(tool,)?type(,x,y)?$/.test(k))).toBe(true);
    expect(keysOf('lrn:activate')).toEqual(['lrn,type,x,y']);
    const types = [...new Set(got.map((m) => m.type))].sort();
    expect(types.every((x) => ['lrn:annotations', 'lrn:stroke', 'lrn:activate', 'lrn:scroll-by', 'lrn:focus', 'lrn:settings'].includes(x)), types.join()).toBe(true);
    for (const list of got.filter((m) => m.type === 'lrn:annotations')) {
      for (const it of list.items) expect(Object.keys(it).sort()).toEqual(['color', 'id', 'sameVersion', 'selector', 'style']);
    }
  });

  test('T016-S8 a link in the lesson tapped with a tool on, or a lrn:link sent by the lesson during the user\'s stroke: the app treats it as a link of the lesson (the same as a click in it without a tool); the app stays where it is (information T016-I4)', async ({ page, context }) => {
    const links = '<p id="lk"><a id="ext" href="https://example.com/t016">Външна връзка</a> и още.</p>';
    await importCourse(page, C, files(links + BODY));
    const frame = await openLesson(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    const before = page.url();
    const opened = [];
    context.on('page', (p) => opened.push(p));
    const l = await textBox(page, 'Външна', { from: 2, to: 3 });
    await t.tap([l.x1, l.y1]);
    await page.waitForTimeout(800);
    // The lesson posts a link while the user only draws.
    await frame.evaluate(() => addEventListener('message', (e) => { if (e.data?.type === 'lrn:stroke' && e.data.phase === 'start') parent.postMessage({ lrn: 1, type: 'lrn:link', href: 'https://example.com/t016-during-stroke' }, '*'); }));
    const a = await textBox(page, 'Производителят');
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await waitMarks(page, 1);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(before);
    test.info().annotations.push({ type: 'T016-I4', description: `tabs opened: ${opened.length}; external: ${external.join(' ')}` });
    for (const p of opened) expect(await p.evaluate(() => window.opener).catch(() => null)).toBeNull();
    external.length = 0; // the links themselves were aborted by the test's route (no network)
  });

  /** n marks on lesson 0001 straight in the store (the newest `extra` of them last). */
  const bulk = (page, n, extra = 0) => page.evaluate(async ({ n, extra }) => {
    const db = await import('./src/db.js');
    const mk = (exact, start, color, style) => db.createAnnotation({ courseId: 'LRN-T15', target: db.docRef('lesson', 'LRN-T15/lesson:0001'), selector: { quote: { exact, prefix: '', suffix: '' }, position: { start, end: start + exact.length } }, color, style, anchorState: 'ok' });
    const jobs = [];
    for (let i = 0; i < n; i++) {
      jobs.push(mk('Допълнителен абзац', 0, 'green', i % 2 ? 'underline' : 'highlight'));
      if (jobs.length >= 250) await Promise.all(jobs.splice(0));
    }
    await Promise.all(jobs);
    for (let i = 0; i < extra; i++) await mk('Краят на урока', 9488, 'pink', 'highlight');
  }, { n, extra });
  /** Wait until the bridge stops sending lrn:anchored (anchoring of all marks done). */
  const anchoredQuiet = async (page) => {
    let last = -1;
    await expect.poll(async () => { const n = await page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:anchored').length); const quiet = n === last; last = n; return quiet; }, { timeout: 90000, intervals: [2000] }).toBe(true);
  };

  test('T016-S9 5000 marks in a lesson (the limit): once they are anchored, a marker stroke and an eraser tap are saved within 5 s', async ({ page }, ti) => {
    landscapeOnly(ti);
    test.setTimeout(300000);
    // T016-D5 (a stroke saved only after ~12–16 s) no longer reproduces: T-066 measured
    // 3.6–3.9 s on a quiet machine (the eraser 0.2–0.4 s), so the test must pass now.
    // A timing test (D-043): a failure under the load of the whole set is checked alone.
    await openLesson(page);
    await bulk(page, 4999);
    await openLesson(page);
    await anchoredQuiet(page);
    await tool(page, 'marker').click();
    const t = await touchApi(page);
    const a = await textBox(page, 'Уязвимостите');
    await page.evaluate(() => { window.__st = []; addEventListener('message', (e) => { if (e.data?.type === 'lrn:stroked') window.__st.push(performance.now()); }); });
    // T-066: the time is taken when the app itself says the work is done (its status
    // "Маркирано: …" / "Маркировката е изтрита", written only AFTER the save and the
    // repaint), not by the test's own polling of 5000 records (each poll reads them
    // all and added up to ~0.5 s of the test's own load at the threshold).
    await page.evaluate(() => {
      window.__said = {};
      const el = document.querySelector('[data-field="marks-status"]');
      new MutationObserver(() => {
        const text = el.textContent || '';
        if (/^Маркирано/.test(text) && !window.__said.mark) window.__said.mark = performance.now();
        if (/изтрита/.test(text) && !window.__said.erase) window.__said.erase = performance.now();
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const p0 = await page.evaluate(() => performance.now());
    await t.drag([a.x1 + 2, a.y1], [a.x2 - 2, a.y1]);
    await expect.poll(() => count(page), { timeout: 30000, intervals: [100] }).toBe(5000);
    const markMs = Math.round((await page.evaluate(() => window.__said.mark)) - p0);
    const answerMs = Math.round((await page.evaluate(() => window.__st[0])) - p0);
    await anchoredQuiet(page);
    await tool(page, 'eraser').click();
    const e0 = await page.evaluate(() => performance.now());
    await t.tap([a.x1 + 10, a.y1]);
    await expect.poll(() => count(page), { timeout: 30000, intervals: [100] }).toBe(4999);
    const eraseMs = Math.round((await page.evaluate(() => window.__said.erase)) - e0);
    test.info().annotations.push({ type: 'S9 5000 marks', description: `stroke → bridge answer ${answerMs} ms, saved and repainted ${markMs} ms, eraser tap → deleted ${eraseMs} ms` });
    expect(eraseMs).toBeLessThan(5000);
    expect(markMs).toBeLessThan(5000);
  });

  test('T016-S10 over 5000 marks: a mark made after the 5000th is painted and can be erased', async ({ page }, ti) => {
    landscapeOnly(ti);
    test.setTimeout(300000);
    test.fail(true, 'T016-D4: the app sends the lesson only the oldest 5000 marks (MAX_ANNOTATIONS_PER_DOC) but saves any number: the 5001st is saved, never painted, the eraser cannot find it');
    await openLesson(page);
    await bulk(page, 5000, 1);
    await openLesson(page);
    await anchoredQuiet(page);
    await expect.poll(async () => (await highlights(page))['lrn-pink'], { timeout: 8000 }).toEqual(['Краят на урока']);
  });
});
