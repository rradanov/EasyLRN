// T-066 (tester): T-064 (0.13.2) and T-065 (0.13.3) attacked, as an attacker:
// - D-044 (no undo from the lesson): lrn:undo and every look-alike message,
//   other envelopes, the lesson's own synthetic keys, its focus() games
//   (taking the focus, giving it back to the app at the user's Ctrl), a field
//   of the lesson (its own undo), and the app's own "Отмени" / Ctrl+Z;
// - the palm (T063-D1/D2 fixes): a fast two-finger flick whose first finger
//   is already past the "young" 40 px, a slow scroll whose first finger drifts,
//   writing with a resting / drifting palm, pinch, three fingers, the thumb
//   (40–60 px), the pen;
// - the bar: double taps on "☰" and "Скрий" at many intervals, the keyboard /
//   the mouse right after a touch (T063-D8);
// - short quotes (T063-D5): deleted sentences in a templated legal text;
// - the palette (T063-D6): long transitions, a delay, a CSS animation, a theme
//   that changes a <style> text or another data-* attribute.
// Synthetic data only, no network, no keys (D-026).
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
const info = (type, value) => (process.env.T066_LOG && console.log('INFO', type, JSON.stringify(value)), test.info()).annotations.push({ type, description: typeof value === 'string' ? value : JSON.stringify(value) });

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
const C = 'LRN-T66';
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
test.describe('T066 D-044: the lesson cannot undo anything; the app\'s own "Отмени" / Ctrl+Z work', () => {
  const EXTRA = '<p><button id="lb" type="button">Бутон на урока</button> <input id="f" aria-label="Поле на урока" value=""></p>';
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files(EXTRA + BODY));
  });
  async function marks(page, words) {
    const frame = await openLesson(page);
    await tool(page, 'marker').tap();
    const t = await input(page);
    let k = 0;
    for (const w of words) { await t.drag(await textBox(page, w)); await waitMarks(page, ++k); }
    await tool(page, 'marker').tap(); // off: one finger / the mouse reach the lesson
    await expect(layer(page)).toBeHidden();
    return { frame, t };
  }
  const W3 = ['Регламентът', 'Уязвимостите', 'Задълженията'];
  /** A real click into the lesson's text (the focus goes into the frame). */
  async function clickIn(page, needle = 'Производителят') {
    const a = await textBox(page, needle);
    await page.mouse.click(a.x1 + 10, a.y);
    await expect.poll(() => active(page)).toBe('IFRAME');
  }

  test('T066-S1 with the focus in the lesson after an honest click: lrn:undo and every look-alike (case, spaces, redo / erase / delete / key / command, fields, other envelopes) undo nothing; the whole undo stack is still there', async ({ page }) => {
    const { frame } = await marks(page, W3);
    await page.waitForTimeout(600);
    await clickIn(page);
    const sent = await frame.evaluate(async () => {
      const types = ['lrn:undo', 'lrn:Undo', 'LRN:UNDO', 'lrn:undo ', ' lrn:undo', 'lrn:undo\u0000', 'lrn:undo​', 'lrn:redo', 'lrn:cancel', 'lrn:erase', 'lrn:delete', 'lrn:remove',
        'lrn:revert', 'lrn:key', 'lrn:keydown', 'lrn:shortcut', 'lrn:command', 'lrn:ctrlz', 'lrn:history', 'undo', 'easylrn:undo', 'lrn:tool', 'lrn:unmark'];
      const extras = [{}, { v: 1 }, { key: 'z', ctrlKey: true, metaKey: true }, { id: 'x', ids: ['x'], annotationId: 'x' }, { command: 'undo', action: 'undo' }, { type2: 'lrn:undo', lrn: 1 }];
      let n = 0;
      const wait = () => new Promise((r) => setTimeout(r, 1100)); // under the app's 60 / s limit, so nothing is dropped for the rate alone
      for (const type of types) {
        for (const extra of extras) { parent.postMessage({ lrn: 1, type, ...extra }, '*'); n++; }
        if (n >= 50) { await wait(); n = 0; }
      }
      for (const m of [{ lrn: '1', type: 'lrn:undo' }, { lrn: true, type: 'lrn:undo' }, { lrn: 2, type: 'lrn:undo' }, JSON.stringify({ lrn: 1, type: 'lrn:undo' }), [{ lrn: 1, type: 'lrn:undo' }],
        { data: { lrn: 1, type: 'lrn:undo' } }, { lrn: 1, type: ['lrn:undo'] }, { lrn: 1, type: { toString: null } }]) {
        try { parent.postMessage(m, '*'); } catch { /* not cloneable */ }
      }
      // A message port and a transfer: still only a message to the app's window.
      try { const ch = new MessageChannel(); parent.postMessage({ lrn: 1, type: 'lrn:undo' }, '*', [ch.port2]); ch.port1.postMessage({ lrn: 1, type: 'lrn:undo' }); } catch { /* */ }
      return types.length * extras.length;
    });
    await page.waitForTimeout(600);
    info('T066-S1 messages posted', sent);
    expect(await count(page)).toBe(3);
    await expect(undoButton(page)).toBeEnabled();
    // The stack is intact: three undos in a row bring it to 0, in order.
    await undoButton(page).click();
    await waitMarks(page, 2);
    await tool(page, 'pencil').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Регламентът');
    await undoButton(page).click();
    await waitMarks(page, 0);
    await expect(undoButton(page)).toBeDisabled();
  });

  test('T066-S2 the lesson\'s own synthetic Ctrl+Z (keydown / keypress / keyup on its document, body, window), execCommand("undo"), and its tries to reach the app\'s document undo nothing', async ({ page }) => {
    const { frame } = await marks(page, W3);
    await clickIn(page);
    const report = await frame.evaluate(() => {
      const out = [];
      for (const target of [document, document.body, window, document.documentElement]) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          for (const mod of [{ ctrlKey: true }, { metaKey: true }]) target.dispatchEvent(new KeyboardEvent(type, { key: 'z', code: 'KeyZ', keyCode: 90, bubbles: true, cancelable: true, composed: true, ...mod }));
        }
      }
      try { document.execCommand('undo'); out.push('execCommand ran'); } catch { out.push('execCommand threw'); }
      for (const [name, fn] of [
        ['parent.document', () => parent.document.body],
        ['parent.dispatchEvent', () => parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))],
        ['top.document', () => top.document],
        ['parent.EasyLRN', () => parent.EasyLRN.undo()],
        ['frameElement', () => window.frameElement.ownerDocument],
      ]) { try { const r = fn(); out.push(`${name}: reached (${r})`); } catch (e) { out.push(`${name}: ${e.name}`); } }
      return out;
    });
    await page.waitForTimeout(500);
    info('T066-S2 the lesson\'s tries', report);
    expect(report.filter((r) => /reached/.test(r) && !/frameElement: reached \(null\)/.test(r))).toEqual([]);
    expect(await count(page)).toBe(3);
  });

  test('T066-S3 a lesson that gives the focus back to the app at the user\'s Ctrl (parent.focus() / window.blur() on keydown "Control"): the user\'s own Ctrl+Z, pressed in the lesson, must not undo a mark', async ({ page }) => {
    const { frame } = await marks(page, W3);
    await clickIn(page);
    await frame.evaluate(() => {
      window.__tries = [];
      const away = (e) => {
        if (e.key !== 'Control' && e.key !== 'Meta') return;
        try { parent.focus(); window.__tries.push('parent.focus'); } catch (err) { window.__tries.push(`parent.focus ${err.name}`); }
        try { window.blur(); window.__tries.push('blur'); } catch { /* */ }
        try { document.activeElement?.blur(); } catch { /* */ }
      };
      document.addEventListener('keydown', away, true);
    });
    const runs = [];
    // At once after the click (the user's activation is fresh), and 6 s later (no activation left).
    for (const wait of [0, 6000]) {
      if (wait) { await clickIn(page, 'Краят'); await page.waitForTimeout(wait); }
      const before = await count(page);
      await page.keyboard.down('Control');
      await page.waitForTimeout(80);
      const where = await active(page);
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await page.waitForTimeout(500);
      runs.push({ wait, focusAfterCtrl: where, undone: before - (await count(page)) });
    }
    info('T066-S3', { tries: await frame.evaluate(() => window.__tries), runs });
    expect(runs.map((r) => r.undone)).toEqual([0, 0]);
  });

  test('T066-S4 Ctrl+Z in a field of the lesson is the field\'s own (the typing is undone, the bridge does not swallow it); no mark is undone', async ({ page }) => {
    const { frame } = await marks(page, W3);
    const f = frame.locator('#f');
    await f.click();
    await f.pressSequentially('абв');
    await expect(f).toHaveValue('абв');
    await f.press('Control+z');
    await expect.poll(() => f.inputValue()).not.toBe('абв');
    await page.waitForTimeout(300);
    expect(await count(page)).toBe(3);
    // The bridge does not cancel Ctrl+Z on the lesson's body either (it is the lesson's own).
    await frame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    const p2 = frame.evaluate(() => new Promise((res) => document.addEventListener('keydown', (e) => setTimeout(() => res(e.defaultPrevented), 0), { once: true })));
    await page.keyboard.press('Control+z');
    expect(await p2).toBe(false);
    expect(await count(page)).toBe(3);
  });

  test('T066-S5 a lesson that steals the focus back every 30 ms: "Отмени" (touch and mouse) still undoes; the app is not stuck; information: where the user\'s Ctrl+Z lands', async ({ page }) => {
    const { frame } = await marks(page, W3);
    await frame.evaluate(() => { document.body.tabIndex = -1; window.__steal = setInterval(() => { document.body.focus(); window.focus(); }, 30); });
    await page.waitForTimeout(300);
    await undoButton(page).tap();
    await waitMarks(page, 2);
    await page.waitForTimeout(800); // (a mouse click on the same button within 0.7 s of its tap is the tap's own click: by design)
    await undoButton(page).click();
    await waitMarks(page, 1);
    await tool(page, 'pencil').focus();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    info('T066-S5 Ctrl+Z right after focusing a tool while the lesson steals the focus', { marksLeft: await count(page), active: await active(page) });
    expect(await count(page)).toBeLessThanOrEqual(1);
    await frame.evaluate(() => clearInterval(window.__steal));
  });

  test('T066-S6 the app\'s own keys: Ctrl+Z and Cmd+Z with the focus in the app undo one per press (marks and an erase); Ctrl+Shift+Z / Ctrl+Alt+Z / plain z undo nothing; Enter on a focused "Отмени" undoes', async ({ page }) => {
    await marks(page, W3);
    await tool(page, 'pencil').focus();
    for (const k of ['Control+Shift+z', 'Control+Alt+z', 'z', 'Shift+z']) await page.keyboard.press(k);
    await page.waitForTimeout(300);
    expect(await count(page)).toBe(3);
    await page.keyboard.press('Meta+z');
    await waitMarks(page, 2);
    // Erase one with the eraser, then undo the erase with Ctrl+Z.
    await tool(page, 'eraser').tap();
    const t = await input(page);
    await t.drag(await textBox(page, 'Регламентът'));
    await waitMarks(page, 1);
    await tool(page, 'eraser').tap();
    await tool(page, 'pencil').focus();
    await page.keyboard.press('Control+z');
    await waitMarks(page, 2);
    expect((await live(page)).map((m) => m.exact).sort()).toEqual(['Регламентът', 'Уязвимостите'].sort());
    await undoButton(page).focus();
    await page.keyboard.press('Enter');
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Регламентът');
    await undoButton(page).focus();
    await page.keyboard.press('Enter');
    await waitMarks(page, 0);
    await expect(undoButton(page)).toBeDisabled();
  });
});

// ===========================================================================
test.describe('T066 the palm and the gestures: the balance of T063-D1/D2 attacked', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
    await openLesson(page);
    await tool(page, 'marker').tap();
    await expect(layer(page)).toBeVisible();
  });
  const pv = async (page) => (await lessonFrame(page)).evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith('lrn-pv') && CSS.highlights.get(k).size));
  const FRAME = 16;
  /** Over the text, in the middle band of the screen. */
  async function spot(page) {
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(80);
    const fb = await page.locator('iframe.lesson-frame').boundingBox();
    return { x: fb.x + 220, y: midY(page, 760) };
  }
  /**
   * A two-finger scroll up: finger 1 lands and moves `before` frames of `step` px
   * (up) alone (or rests `restMs`, drifting `drift` px in all), then finger 2
   * lands 150 px to the right and both move up 25 px per frame for 12 frames.
   */
  async function twoFingerScroll(page, { step = 0, before = 0, restMs = 0, drift = 0, preWait = FRAME }) {
    const t = await input(page);
    const { x, y } = await spot(page);
    const y0 = await scrollY(page);
    let y1 = y;
    await t.touch('touchStart', [[x, y1, 1]]);
    for (let i = 1; i <= before; i++) { y1 -= step; await t.touch('touchMove', [[x, y1, 1]]); if (preWait) await page.waitForTimeout(preWait); }
    if (restMs) {
      const n = Math.max(1, Math.round(restMs / 30));
      for (let i = 1; i <= n; i++) { await page.waitForTimeout(30); if (drift) await t.touch('touchMove', [[x + (drift * i) / n, y1, 1]]); }
    }
    const x1 = x + (restMs ? drift : 0);
    let y2 = y;
    await t.touch('touchStart', [[x1, y1, 1], [x + 150, y2, 2]]);
    for (let i = 1; i <= 12; i++) { y1 -= 25; y2 -= 25; await t.touch('touchMove', [[x1, y1, 1], [x + 150, y2, 2]]); await page.waitForTimeout(FRAME); }
    await t.touch('touchEnd', []);
    await page.waitForTimeout(500);
    return { scrolled: (await scrollY(page)) - y0, marks: await count(page), pv: (await pv(page)).length };
  }

  test('T066-P1 a quick two-finger flick whose first finger slid 36 px (3 frames × 12 px) before the second landed scrolls and draws nothing (the young stroke, T063-D1)', async ({ page }) => {
    // No wait between the first moves: the young stroke must stay young (< 250 ms) on a loaded machine too.
    const r = await twoFingerScroll(page, { step: 12, before: 3, preWait: 0 });
    info('T066-P1', r);
    expect(r.marks).toBe(0);
    expect(r.scrolled).toBeGreaterThan(150);
    expect(r.pv).toBe(0);
  });

  test('T066-P2 a fast two-finger flick (≈ 1200 px/s): the first finger slid 60 px in 3 frames (≈ 50 ms) before the second landed — it must scroll, not draw', async ({ page }) => {
    const r = await twoFingerScroll(page, { step: 20, before: 3, preWait: 0 });
    info('T066-P2', r);
    if (r.marks) test.fail(true, 'T066-D1: the "young stroke" is young only under 40 px: a fast flick whose first finger is past 40 px when the second lands (within 150 ms, PAIR_MS) hits rule 3 (the second touch is a palm): one mark is drawn and the page does not scroll');
    expect(r.marks).toBe(0);
    expect(r.scrolled).toBeGreaterThan(150);
  });

  test('T066-P3 a slow two-finger scroll: the first finger rests 300 ms and drifts 6 px (under the 8 px slop), then both move together → scroll, nothing drawn', async ({ page }) => {
    const r = await twoFingerScroll(page, { restMs: 300, drift: 6 });
    info('T066-P3', r);
    expect(r.marks).toBe(0);
    expect(r.scrolled).toBeGreaterThan(150);
  });

  test('T066-P4 a slow two-finger scroll: the first finger rests 300 ms and rolls 12 px sideways (a finger settling), then both move together — it must scroll, not draw', async ({ page }) => {
    const r = await twoFingerScroll(page, { restMs: 300, drift: 12 });
    info('T066-P4', r);
    if (r.marks) test.fail(true, 'T066-D2: a resting first finger that drifts ≥ 8 px over ≥ 250 ms is a "sure" stroke: a second finger landing then is a palm (rule 3) and the slow two-finger scroll draws a short mark instead of scrolling');
    expect(r.marks).toBe(0);
    expect(r.scrolled).toBeGreaterThan(150);
  });

  /**
   * Writing with a resting palm: the palm (radius `pr`) lands `restMs` before
   * the pen (a touch, radius 3) and drifts `palmStep` px per frame while the
   * pen writes `penStep` px per frame along "Уязвимостите се докладват".
   */
  async function writeWithPalm(page, { pr = 12, restMs = 400, palmStep = 0, penStep = 6, gap = null }) {
    const t = await input(page);
    const a = await textBox(page, 'Уязвимостите');
    const b = await textBox(page, 'докладват', { scroll: false });
    const y0 = await scrollY(page);
    const P = { x: a.x1 + 120, y: a.y + 150 };
    await t.touch('touchStart', [[P.x, P.y, 2, pr]]);
    await page.waitForTimeout(gap ?? restMs);
    const x0 = a.x1 + 2;
    const n = Math.ceil((b.x2 - 3 - x0) / penStep);
    await t.touch('touchStart', [[P.x, P.y, 2, pr], [x0, a.y, 1, 3]]);
    for (let i = 1; i <= n; i++) {
      await t.touch('touchMove', [[P.x + palmStep * i, P.y, 2, pr], [Math.min(b.x2 - 3, x0 + penStep * i), a.y, 1, 3]]);
      await page.waitForTimeout(FRAME);
    }
    await t.touch('touchEnd', [[Math.min(b.x2 - 3, x0 + penStep * n), a.y, 1, 3]]);
    await t.touch('touchEnd', []);
    await page.waitForTimeout(400);
    const list = await live(page);
    return { marks: list.length, exact: list[0]?.exact ?? null, scrolled: (await scrollY(page)) - y0 };
  }

  test('T066-P5 writing slowly with a resting palm (a 24 px contact, 8× the pen) that stays still, drifts 2 px or 4 px per frame (33 % / 67 % of the pen) → the pen draws the whole words, no scroll', async ({ page }) => {
    const out = [];
    for (const palmStep of [0, 2, 4]) {
      const r = await writeWithPalm(page, { palmStep });
      out.push({ palmStep, ...r });
      if (r.marks) { await undoButton(page).click(); await waitMarks(page, 0); await page.waitForTimeout(800); }
    }
    info('T066-P5', out);
    for (const r of out) {
      expect(r.exact).toBe('Уязвимостите се докладват');
      expect(Math.abs(r.scrolled)).toBeLessThan(4);
    }
  });

  test('T066-P6 information: the palm that moves WITH the pen (the hand slides along the line: 85 % of the pen), and a palm reported as small as the pen (no size: 50 %) — writing becomes a two-finger scroll', async ({ page }) => {
    const out = [];
    for (const [pr, palmStep] of [[12, 5.1], [3, 3]]) {
      const r = await writeWithPalm(page, { pr, palmStep });
      out.push({ palmRadius: pr, palmStep, ...r });
      if (r.marks) { await undoButton(page).click(); await waitMarks(page, 0); await page.waitForTimeout(800); }
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    info('T066-I1 the palm moving with the pen', out);
    // The rule as designed (comparable movement = scrolling): nothing drawn; the page scrolls.
    for (const r of out) expect(r.marks).toBe(0);
  });

  test('T066-P7 information: a palm and the pen landing together (80 ms, rule 2) — the writing is lost and the page scrolls with the pen (T063-I2, unchanged)', async ({ page }) => {
    const r = await writeWithPalm(page, { gap: 80 });
    info('T066-I2 palm + pen landing together', r);
    expect(r.marks).toBe(0);
  });

  test('T066-P8 pinch: after a young stroke (15 px) a second finger lands and the two spread apart symmetrically → no mark, no live preview left, no zoom; three fingers → scroll, no mark', async ({ page }) => {
    const t = await input(page);
    const a = await textBox(page, 'Производителят');
    await t.touch('touchStart', [[a.x1 + 2, a.y, 1]]);
    for (let i = 1; i <= 3; i++) { await t.touch('touchMove', [[a.x1 + 2 + i * 5, a.y, 1]]); await page.waitForTimeout(10); }
    const cy = a.y + 120;
    await t.touch('touchStart', [[a.x1 + 17, a.y, 1], [a.x1 + 17, cy + 120, 2]]);
    for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[a.x1 + 17, a.y - i * 10, 1], [a.x1 + 17, cy + 120 + i * 10, 2]]); await page.waitForTimeout(FRAME); }
    await t.touch('touchEnd', []);
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(0);
    expect(await pv(page)).toEqual([]);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    // Three fingers, the first one young.
    const { x, y } = await spot(page);
    const y0 = await scrollY(page);
    await t.touch('touchStart', [[x, y, 1]]);
    await t.touch('touchMove', [[x, y - 10, 1]]);
    await page.waitForTimeout(FRAME);
    await t.touch('touchStart', [[x, y - 10, 1], [x + 120, y, 2]]);
    await page.waitForTimeout(40);
    await t.touch('touchStart', [[x, y - 10, 1], [x + 120, y, 2], [x + 240, y, 3]]);
    for (let i = 1; i <= 10; i++) { await t.touch('touchMove', [[x, y - 10 - i * 25, 1], [x + 120, y - i * 25, 2], [x + 240, y - i * 25, 3]]); await page.waitForTimeout(FRAME); }
    await t.touch('touchEnd', []);
    await page.waitForTimeout(400);
    expect(await count(page)).toBe(0);
    expect((await scrollY(page)) - y0).toBeGreaterThan(100);
  });

  test('T066-P9 the thumb: contacts 40 and 44 px wide draw; information — 46, 50, 60 px and an elongated thumb (36 × 60, 30 × 70) are the palm', async ({ page }) => {
    const t = await input(page);
    const out = {};
    for (const [rx, ry] of [[20, 20], [22, 22], [23, 23], [25, 25], [30, 30], [18, 30], [15, 35]]) {
      const before = await count(page);
      const a = await textBox(page, 'Задълженията');
      await t.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(a.x1 + 2), y: Math.round(a.y), id: 1, radiusX: rx, radiusY: ry, force: 1 }] });
      for (let i = 1; i <= 10; i++) {
        await t.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(a.x1 + 2 + ((a.x2 - a.x1 - 4) * i) / 10), y: Math.round(a.y), id: 1, radiusX: rx, radiusY: ry, force: 1 }] });
        await page.waitForTimeout(8);
      }
      await t.touch('touchEnd', []);
      await page.waitForTimeout(500);
      const drew = (await count(page)) > before;
      out[`${rx * 2}x${ry * 2}`] = drew;
      if (drew) { await page.waitForTimeout(700); await undoButton(page).click(); await waitMarks(page, before); }
    }
    info('T066-I3 the thumb (width x height: drew)', out);
    expect(out['40x40']).toBe(true);
    expect(out['44x44']).toBe(true);
  });

  test('T066-P10 the pen: a palm landing during its stroke changes nothing; the pen landing during a two-finger scroll draws; touches 300 ms after the pen lifted are ignored, 1 s after they draw', async ({ page }) => {
    const t = await input(page);
    // a) the pen writes, a touch (the palm) lands halfway.
    let a = await textBox(page, 'Уязвимостите');
    let b = await textBox(page, 'докладват', { scroll: false });
    await t.pen('mousePressed', a.x1 + 2, a.y);
    for (let i = 1; i <= 12; i++) {
      await t.pen('mouseMoved', a.x1 + 2 + ((b.x2 - 3 - a.x1 - 2) * i) / 12, a.y);
      if (i === 5) await t.touch('touchStart', [[a.x1 + 100, a.y + 140, 5, 10]]);
      await page.waitForTimeout(12);
    }
    await t.pen('mouseReleased', b.x2 - 3, a.y);
    await t.touch('touchEnd', []);
    await waitMarks(page, 1);
    expect((await live(page))[0].exact).toBe('Уязвимостите се докладват');
    // b) the pen lands while two fingers scroll.
    await page.waitForTimeout(800);
    a = await textBox(page, 'Производителят');
    const x = a.x1 + 300;
    const y = midY(page, a.y + 200);
    await t.touch('touchStart', [[x, y, 1], [x + 150, y, 2]]);
    for (let i = 1; i <= 4; i++) { await t.touch('touchMove', [[x, y - i * 10, 1], [x + 150, y - i * 10, 2]]); await page.waitForTimeout(FRAME); }
    a = await textBox(page, 'Производителят', { scroll: false });
    await t.pen('mousePressed', a.x1 + 2, a.y);
    for (let i = 1; i <= 8; i++) { await t.pen('mouseMoved', a.x1 + 2 + i * 14, a.y); await t.touch('touchMove', [[x, y - 40, 1], [x + 150, y - 40, 2]]); await page.waitForTimeout(12); }
    await t.pen('mouseReleased', a.x1 + 2 + 8 * 14, a.y);
    await t.touch('touchEnd', []);
    await waitMarks(page, 2);
    expect((await live(page)).some((m) => /^Производителят/.test(m.exact))).toBe(true);
    // c) a finger 300 ms after the pen lifted: the palm (ignored); 1 s after: it draws.
    a = await textBox(page, 'Задълженията');
    await t.pen('mousePressed', a.x1 + 2, a.y + 400);
    await t.pen('mouseReleased', a.x1 + 2, a.y + 400); // a tap of the pen (outside text; at most a control)
    await page.waitForTimeout(300);
    await t.drag(a);
    await page.waitForTimeout(600);
    const afterSoon = await count(page);
    await page.waitForTimeout(1000);
    await t.drag(await textBox(page, 'Задълженията'));
    await page.waitForTimeout(600);
    info('T066-P10 c', { afterSoon, after1s: await count(page) });
    expect(afterSoon).toBe(2);
    await waitMarks(page, 3);
  });
});

// ===========================================================================
test.describe('T066 the bar: double taps on "☰" / "Скрий", keys and the mouse right after a touch (T063-D8, T063-I6)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await importCourse(page, C, files());
    await openLesson(page);
  });
  const tap = async (t, x, y) => { await t.touch('touchStart', [[x, y, 1]]); await t.touch('touchEnd', []); };
  const pressedTool = (page) => page.evaluate(() => document.querySelector('[data-field="mark-tools"]')?.dataset.tool);

  test('T066-B1 a double tap on "☰" with the second tap 40…300 ms (measured between the two pointerup) after the first (Android\'s double tap is ≤ 300 ms) shows the bar and turns no tool on', async ({ page }) => {
    const t = await input(page);
    const out = [];
    for (const gap of [40, 120, 200, 240, 270]) {
      await hideButton(page).tap();
      await expect(handle(page)).toBeVisible();
      await page.waitForTimeout(800);
      const h0 = await handle(page).boundingBox();
      const cx = h0.x + h0.width / 2;
      const cy = h0.y + h0.height / 2;
      await page.evaluate(() => { window.__ups = []; if (!window.__upsOn) { window.__upsOn = true; window.addEventListener('pointerup', () => window.__ups.push(performance.now()), true); } });
      await tap(t, cx, cy);
      await page.waitForTimeout(Math.max(0, gap - 10));
      await tap(t, cx, cy);
      await page.waitForTimeout(700);
      const under = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el?.closest('button')?.getAttribute('aria-label') || el?.tagName; }, [cx, cy]);
      const ups = await page.evaluate(() => window.__ups);
      out.push({ gap, real: ups.length === 2 ? Math.round(ups[1] - ups[0]) : ups.length, under, shown: await bar(page).isVisible(), tool: await pressedTool(page) });
      if ((await pressedTool(page)) !== 'none') { await tool(page, await pressedTool(page)).click(); }
      await page.waitForTimeout(300);
    }
    info('T066-B1 double tap on the handle', out);
    const bad = out.filter((r) => (typeof r.real !== 'number' || r.real <= 300) && (!r.shown || r.tool !== 'none'));
    expect(bad).toEqual([]);
  });

  test('T066-B2 a double tap on "Скрий" with the second tap 40…600 ms after the first leaves the bar hidden and no tool on', async ({ page }) => {
    const t = await input(page);
    const out = [];
    for (const gap of [40, 120, 200, 260, 320, 450, 600]) {
      const hb = await hideButton(page).boundingBox();
      const cx = hb.x + hb.width / 2;
      const cy = hb.y + hb.height / 2;
      await tap(t, cx, cy);
      await page.waitForTimeout(Math.max(0, gap - 10));
      await tap(t, cx, cy);
      await page.waitForTimeout(700);
      out.push({ gap, hidden: await bar(page).isHidden(), handle: await handle(page).isVisible() });
      if (await bar(page).isHidden()) { await handle(page).tap(); await expect(bar(page)).toBeVisible(); }
      await page.waitForTimeout(500);
    }
    info('T066-B2 double tap on "Скрий"', out);
    expect(out.filter((r) => !r.hidden || !r.handle)).toEqual([]);
    expect((await stored(page)).hidden).toBe(false);
  });

  test('T066-B3 (T063-D8) right after a touch on one button: Space on another focused one, Enter on the handle at 50 ms, a mouse click on a colour at 100 ms — all act', async ({ page }) => {
    await tool(page, 'marker').tap();
    await expect(tool(page, 'marker')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(300);
    // A touch on "Молив", then Space on the focused eraser 60 ms later.
    await tool(page, 'pencil').tap();
    await tool(page, 'eraser').focus();
    await page.waitForTimeout(60);
    await page.keyboard.press('Space');
    await expect(tool(page, 'eraser')).toHaveAttribute('aria-pressed', 'true');
    // A touch on a colour, a mouse click on another colour 100 ms later.
    await color(page, 'green').tap();
    await page.waitForTimeout(100);
    await color(page, 'pink').click();
    await expect(color(page, 'pink')).toHaveAttribute('aria-pressed', 'true');
    // A touch on "Скрий", Enter on the handle 50 ms later.
    await hideButton(page).tap();
    await handle(page).focus().catch(() => {});
    await page.waitForTimeout(260); // the slide (200 ms): the handle exists only then
    await handle(page).focus();
    await page.keyboard.press('Enter');
    await expect(bar(page)).toBeVisible({ timeout: 1500 });
  });
});

// ===========================================================================
test.describe('T066 short quotes (T063-D5) in a templated legal text', () => {
  test.beforeEach(async ({ page }, ti) => { landscapeOnly(ti); await page.goto('./'); });
  const run = (page, fn, arg) => page.evaluate(`(async () => {
    const A = await import('./src/anchor.js');
    const M = (html) => A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body);
    return (${fn.toString()})(A, M, ${JSON.stringify(arg ?? null)});
  })()`);
  test('T066-A1 a short quote (3…23 characters) whose sentence was deleted from a templated legal text is never "ok" at another sentence (300 random quotes)', async ({ page }) => {
    const r = await run(page, (A, M) => {
      let seed = 6601;
      const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const who = ['Производителят', 'Вносителят', 'Дистрибуторът', 'Органът за надзор', 'Нотифицираният орган', 'Упълномощеният представител'];
      const what = ['изпълнява задълженията си', 'уведомява Комисията', 'съхранява документацията', 'докладва уязвимостите', 'оценява съответствието', 'предоставя информацията'];
      const tail = ['и указанията на Комисията.', 'без неоправдано забавяне.', 'в срок от десет години.', 'по искане на органа.'];
      const S = Array.from({ length: 40 }, (_, i) => `${who[i % 6]} ${what[(i * 5) % 6]} в съответствие с член ${10 + (i % 7)} от настоящия регламент ${tail[i % 4]}`);
      const c = { ok: 0, fuzzy: 0, orphan: 0, examples: [] };
      for (let k = 0; k < 300; k++) {
        const i = Math.floor(rnd() * S.length);
        const v1 = S.map((x) => `<p>${x}</p>`).join('');
        const m1 = M(v1);
        const start = m1.text.indexOf(S[i]);
        const L = 3 + Math.floor(rnd() * 21);
        const s0 = start + Math.floor(rnd() * (S[i].length - L));
        if (!m1.text.slice(s0, s0 + L).trim()) continue;
        const sel = A.anchorDescribe(m1, s0, s0 + L);
        const m2 = M(S.filter((_, j) => j !== i).map((x) => `<p>${x}</p>`).join(''));
        const f = A.anchorFind(m2, sel);
        c[f.state]++;
        if (f.state === 'ok' && c.examples.length < 5) c.examples.push([sel.quote.exact, m2.text.slice(Math.max(0, f.start - 30), f.end + 30)]);
      }
      return c;
    });
    info('T066-A1 deleted sentence, templated text', r);
    expect(r.ok).toBe(0);
  });

  test('T066-A2 information: the cost of D5 — a harmless edit (a paragraph added at the start) of the same templated text: short quotes "ok" / "провери", and "ok" at a wrong place (must be 0)', async ({ page }) => {
    const r = await run(page, (A, M) => {
      let seed = 6602;
      const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const who = ['Производителят', 'Вносителят', 'Дистрибуторът', 'Органът за надзор', 'Нотифицираният орган', 'Упълномощеният представител'];
      const what = ['изпълнява задълженията си', 'уведомява Комисията', 'съхранява документацията', 'докладва уязвимостите', 'оценява съответствието', 'предоставя информацията'];
      const tail = ['и указанията на Комисията.', 'без неоправдано забавяне.', 'в срок от десет години.', 'по искане на органа.'];
      const S = Array.from({ length: 40 }, (_, i) => `${who[i % 6]} ${what[(i * 5) % 6]} в съответствие с член ${10 + (i % 7)} от настоящия регламент ${tail[i % 4]}`);
      const body = S.map((x) => `<p>${x}</p>`).join('');
      const m1 = M(body);
      const m2 = M(`<p>Нов първи абзац, добавен при редакцията.</p>${body}`);
      const shift = m2.text.indexOf(m1.text.slice(0, 30));
      const c = { ok: 0, okWrong: 0, fuzzy: 0, orphan: 0 };
      for (let k = 0; k < 300; k++) {
        const L = 3 + Math.floor(rnd() * 21);
        const s0 = Math.floor(rnd() * (m1.text.length - L));
        const q = m1.text.slice(s0, s0 + L);
        if (!q.trim()) continue;
        const f = A.anchorFind(m2, A.anchorDescribe(m1, s0, s0 + L));
        c[f.state]++;
        if (f.state === 'ok' && !(Math.abs(f.start - (s0 + shift)) <= 2 && m2.text.slice(f.start, f.end).trim() === q.trim())) c.okWrong++;
      }
      return c;
    });
    info('T066-I4 harmless edit, templated text', r);
    expect(r.okWrong).toBe(0);
  });
  test('T066-A3 (T066-D7) a short quote, found once, in its own unchanged sentence stays "ok" when a block is inserted right after that paragraph (T014-U6 he / ar; information: a Bulgarian case that was "провери" already in 0.13.1)', async ({ page }) => {
    const r = await run(page, (A, M) => {
      const sel = (m, needle) => { const at = m.text.indexOf(needle); return A.anchorDescribe(m, at, at + needle.length); };
      const out = {};
      const he = 'שלום עולם זה טקסט בעברית לבדיקה';
      const ar = 'مرحبا بالعالم هذا نص عربي للاختبار';
      const rt = M(`<p dir="rtl">${he}</p><p dir="rtl">${ar}</p>`);
      const rt2 = M(`<p>Ново.</p><p dir="rtl">${he}</p><p>вмъкнат</p><p dir="rtl">${ar}</p>`);
      out.he = A.anchorFind(rt2, sel(rt, 'עולם זה טקסט')).state;
      out.ar = A.anchorFind(rt2, sel(rt, 'هذا نص عربي')).state;
      const bg = M('<p>Кратко изречение за котвите.</p><p>Следващият абзац е съвсем друг.</p>');
      const bg2 = M('<p>Ново.</p><p>Кратко изречение за котвите.</p><p>Вмъкнат абзац.</p><p>Следващият абзац е съвсем друг.</p>');
      out.bg = A.anchorFind(bg2, sel(bg, 'изречение за')).state;
      return out;
    });
    info('T066-A3', r);
    expect(r.bg).not.toBe('orphan');
    expect([r.he, r.ar]).toEqual(['ok', 'ok']);
  });
});

// ===========================================================================
test.describe('T066 the palette (T063-D6): long transitions, a delay, an animation, other ways to change the theme', () => {
  const DARK_YELLOW = '#5c5216';
  const BTN = '<button id="dark" type="button">Тъмно</button>';
  async function lesson(page, head, onclick) {
    await start(page);
    await importCourse(page, C, files(BTN.replace('type="button"', `type="button" onclick="${onclick}"`) + BODY, head));
    const frame = await openLesson(page);
    const yellow = () => frame.evaluate(() => [...document.querySelectorAll('style[data-easylrn="bridge"]')].map((s) => s.textContent).join('').match(/::highlight\(lrn-yellow\)[^{]*\{ background-color: (#[0-9a-f]+)/)?.[1]);
    const light = await yellow();
    return { frame, yellow, light };
  }
  const toggle = "document.body.classList.toggle('dark')";

  for (const [id, css, waitMs] of [
    ['T066-C1', 'body { transition: background-color 3s linear; }', 3600],
    ['T066-C2', 'body { transition: background-color 6s linear; }', 6600],
    ['T066-C3', 'body { transition: background-color 1s linear 4s; }', 5600],
    ['T066-C4', 'html, body { transition: background-color 2.5s ease-in, color 2.5s; } ', 3200],
  ]) {
    test(`${id} a lesson that turns dark with "${css.trim()}" gets the dark palette once the transition ends`, async ({ page }) => {
      const { frame, yellow, light } = await lesson(page, `<style>${css} body.dark { background: #151513; color: #e6e3da; }</style>`, toggle);
      expect(light).not.toBe(DARK_YELLOW);
      await frame.locator('#dark').click();
      await expect.poll(yellow, { timeout: waitMs + 1500, intervals: [250] }).toBe(DARK_YELLOW);
      // And back to light the same way.
      await frame.locator('#dark').click();
      await expect.poll(yellow, { timeout: waitMs + 1500, intervals: [250] }).toBe(light);
    });
  }

  test('T066-C5 a lesson that turns dark with a CSS animation of 8 s (no transition: no transitionend) gets the dark palette when it ends', async ({ page }) => {
    const css = '@keyframes toDark { from { background-color: #ffffff; } to { background-color: #151513; } } body.dark { animation: toDark 8s linear forwards; color: #e6e3da; }';
    const { frame, yellow } = await lesson(page, `<style>${css}</style>`, "document.body.classList.add('dark')");
    await frame.locator('#dark').click();
    await page.waitForTimeout(9000);
    const after = await yellow();
    info('T066-C5', { after, bg: await frame.evaluate(() => getComputedStyle(document.body).backgroundColor) });
    expect(after).toBe(DARK_YELLOW);
  });

  test('T066-C6 a lesson that switches its theme without a watched attribute — a new text of its own <style>, sheet.insertRule, data-bs-theme on <html> — gets the dark palette', async ({ page }) => {
    const head = '<style id="theme">body { background: #ffffff; }</style><style>[data-bs-theme="dark"] body { background: #151513; color: #e6e3da; }</style>';
    const out = {};
    const { frame, yellow } = await lesson(page, head, '');
    const ways = {
      styleText: () => { document.getElementById('theme').textContent = 'body { background: #151513; color: #e6e3da; }'; },
      insertRule: () => { const s = document.getElementById('theme').sheet; s.insertRule('body { background: #151513 !important; color: #e6e3da; }', s.cssRules.length); },
      bsTheme: () => { document.documentElement.setAttribute('data-bs-theme', 'dark'); },
    };
    const reset = () => {
      const t = document.getElementById('theme');
      t.textContent = 'body { background: #ffffff; }';
      document.documentElement.removeAttribute('data-bs-theme');
      document.body.setAttribute('class', `r${Date.now()}`); // a watched change: the palette is checked again (light)
    };
    for (const [name, fn] of Object.entries(ways)) {
      await frame.evaluate(`(${reset.toString()})()`);
      await expect.poll(yellow, { timeout: 2000 }).not.toBe(DARK_YELLOW);
      await page.waitForTimeout(4000); // the later checks of the reset (up to 3.5 s) are over
      await frame.evaluate(`(${fn.toString()})()`);
      await page.waitForTimeout(1500);
      out[name] = { dark: (await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)), palette: await yellow() };
    }
    info('T066-C6', out);
    const missed = Object.entries(out).filter(([, v]) => v.palette !== DARK_YELLOW).map(([k]) => k);
    expect(missed).toEqual([]);
  });
});
