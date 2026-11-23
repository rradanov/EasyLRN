// T-071b (0.15.0, D-046): the bars by the orientation, the movable divider.
// - portrait (taller than wide, ≥ 600 px): the tool bar and the notes bar are
//   horizontal at the top (one sticky row under the title); a note opens UNDER
//   the lesson (fixed at the bottom of the window), its place stays seen;
// - landscape: the tool bar left, the notes strip right, a note is a column at
//   the right edge;
// - the divider: a finger / the mouse / the arrow keys, limits (the lesson
//   ≥ 45 %, the note ≥ 200 px), kept per orientation (`notesSplit`);
// - while the panel is open the 📝 column and the notes bar are hidden;
// - a phone (< 600 px): unchanged.
// Sizes: 1280×800, 800×1280, 1920×1200, 1200×1920, 360×800; 160 % text.
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 150000 });
test.use({ trace: 'off' });

let problems;
let external;
test.beforeEach(async ({ page, context }, ti) => {
  // The sizes are set in each test: one project is enough.
  test.skip(ti.project.name !== 'tablet-landscape', 'the sizes are set in the test');
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (!problems) return;
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value) });

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const C = 'LRN-T71';
const L1 = `${C}/lesson:0001`;
const FILL = (from, n) => Array.from({ length: n }, (_, i) => `<p>Абзац ${from + i} за превъртане на урока, текстът е само пълнеж и нищо повече.</p>`).join('');
const BODY = `${FILL(0, 12)}<p id="p1">Регламентът за киберустойчивост се прилага за продукти.</p><p id="p2">Производителят оценява рисковете през жизнения цикъл.</p>${FILL(12, 12)}<p id="p3">Уязвимостите се докладват бързо.</p>${FILL(24, 20)}`;
const files = () => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', BODY),
});

async function start(page, { scale = 1 } = {}) {
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
  const f = asFile(`${C}.zip`, makeZip(toBytes(files()), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
  expect(r).not.toMatch(/^ERROR/);
  if (scale !== 1) await db(page, (db, s) => db.saveSettings({ fontScale: s }), scale);
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page, { uiScale = 1 } = {}) {
  const hash = `#/c/${C}/read/0001`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  // 160 % text of the app too (Android's font size grows the whole page).
  if (uiScale !== 1) await page.evaluate((s) => { document.documentElement.style.fontSize = `${s * 100}%`; }, uiScale);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const liveAnn = (page) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id })).map((a) => ({ id: a.id, exact: a.selector.quote.exact, color: a.color, style: a.style })), L1);

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
/** Window coordinates of `needle` in the lesson (no scrolling). */
async function textRect(page, needle) {
  const frame = await lessonFrame(page);
  const rel = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      const b = r.getClientRects()[0];
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    throw new Error(`not found: ${needle}`);
  }, needle);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return { left: box.x + rel.left, right: box.x + rel.right, top: box.y + rel.top, bottom: box.y + rel.bottom };
}
const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const noteStatus = (page) => page.locator('[data-field="note-status"]');
const divider = (page) => page.locator('[data-field="notes-divider"]');
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

async function openNote(page, needle, text = 'Бележка за подредбата') {
  await select(page, needle);
  const b = page.locator('[data-action="new-note"]');
  if (await b.isVisible()) await b.click(); else await page.locator('[data-action="new-note-quick"]').click();
  await expect(noteText(page)).toBeFocused();
  if (text) {
    await noteText(page).pressSequentially(text, { delay: 2 });
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
  }
}
/** Boxes of the parts (null when not shown). */
const boxes = (page) => page.evaluate(() => {
  const b = (sel) => {
    const e = document.querySelector(sel);
    if (!e || !e.getClientRects().length) return null;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
  };
  return {
    layout: document.querySelector('[data-screen="reader"]')?.dataset.layout,
    vw: document.documentElement.clientWidth,
    vh: window.innerHeight,
    appBar: b('.app-bar'),
    frame: b('iframe.lesson-frame'),
    topbar: b('[data-field="reader-topbar"]'),
    tools: b('[data-field="mark-tools"]'),
    toolsHandle: b('[data-field="mark-tools-handle"]'),
    notesBar: b('.notes-strip__bar'),
    strip: b('[data-field="notes-strip"]'),
    marks: b('[data-field="notes-marks"] .notes-strip__mark'),
    notesHandle: b('[data-field="notes-strip-handle"]'),
    panel: b('[data-field="notes-panel"]'),
    divider: b('[data-field="notes-divider"]'),
    orientTools: document.querySelector('[data-field="mark-tools"]')?.getAttribute('aria-orientation'),
    orientNotes: document.querySelector('.notes-strip__bar')?.getAttribute('aria-orientation'),
  };
});
const overlaps = (a, b) => Boolean(a && b) && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
/** The part of the lesson seen in the window: below the bars at the top, above a panel at the bottom. */
const seenLesson = (x) => {
  const top = Math.max(x.appBar?.bottom ?? 0, x.layout === 'portrait' ? (x.topbar?.bottom ?? 0) : 0, x.frame.top);
  const bottom = Math.min(x.vh, x.panel && x.layout === 'portrait' ? x.panel.top : x.vh, x.frame.bottom);
  const right = Math.min(x.frame.right, x.panel && x.layout === 'landscape' ? x.panel.left : x.vw);
  return { left: x.frame.left, right, top, bottom, width: right - x.frame.left, height: bottom - top };
};

// ===========================================================================
const SIZES = [
  { w: 1280, h: 800, layout: 'landscape' },
  { w: 800, h: 1280, layout: 'portrait' },
  { w: 1920, h: 1200, layout: 'landscape' },
  { w: 1200, h: 1920, layout: 'portrait' },
];
test.describe('T071-L the layout by orientation (D-046)', () => {
  for (const scale of [1, 1.6]) {
    test(`T071-L1 ${scale * 100} % text: portrait → both bars horizontal at the top, the note UNDER the lesson; landscape → the bars at the sides, the note a column at the right; no sideways scroll, nothing over the lesson, the noted place seen; the 📝 column and the notes bar hidden while the panel is open`, async ({ page }) => {
      await start(page, { scale });
      const out = {};
      for (const s of SIZES) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await openLesson(page, { uiScale: scale });
        await page.evaluate(() => window.scrollTo(0, 0)); // the reading position of the last size
        await page.waitForTimeout(300);
        const closed = await boxes(page);
        expect(closed.layout, `${s.w}×${s.h}`).toBe(s.layout);
        expect(await noSideScroll(page), `${s.w}×${s.h} closed: no sideways scroll`).toBe(true);
        if (s.layout === 'portrait') {
          // One row at the top: tools left, notes right; both horizontal; the lesson below it, as wide as the window allows.
          expect(closed.orientTools).toBe('horizontal');
          expect(closed.orientNotes).toBe('horizontal');
          expect(closed.topbar).not.toBeNull();
          for (const part of ['tools', 'notesBar']) {
            expect(closed[part].top, `${s.w}: ${part} in the top row`).toBeGreaterThanOrEqual(closed.topbar.top - 1);
            expect(closed[part].bottom, `${s.w}: ${part} in the top row`).toBeLessThanOrEqual(closed.topbar.bottom + 1);
          }
          expect(closed.tools.right).toBeLessThanOrEqual(closed.notesBar.left + 1);
          expect(closed.notesBar.right).toBeLessThanOrEqual(s.w);
          expect(closed.frame.top).toBeGreaterThanOrEqual(closed.topbar.bottom - 1);
          // Nothing at the sides but the narrow 📝 column (≤ 48 px).
          expect(closed.frame.left).toBeLessThanOrEqual(16);
          expect(closed.strip?.width ?? 0).toBeLessThanOrEqual(48);
          expect(closed.frame.width).toBeGreaterThanOrEqual(s.w - 16 - 48 - 8);
        } else {
          expect(closed.orientTools).toBe('vertical');
          expect(closed.orientNotes).toBe('vertical');
          expect(closed.topbar).toBeNull();
          expect(closed.tools.right).toBeLessThanOrEqual(closed.frame.left + 1);
          expect(closed.strip.left).toBeGreaterThanOrEqual(closed.frame.right - 1);
        }
        // A note.
        await openNote(page, 'оценява рисковете', `Бележка ${s.w}`);
        await page.waitForTimeout(500);
        const open = await boxes(page);
        const seen = seenLesson(open);
        const place = await textRect(page, 'оценява рисковете');
        out[`${s.w}x${s.h}`] = { frame: open.frame, panel: open.panel, seen: { width: seen.width, height: seen.height }, place: { top: Math.round(place.top), bottom: Math.round(place.bottom) } };
        expect(await noSideScroll(page), `${s.w}×${s.h} open: no sideways scroll`).toBe(true);
        // D-046: the 📝 column and the bar of the notes go while the panel is open.
        expect(open.strip, `${s.w}: the 📝 column hidden`).toBeNull();
        expect(open.notesBar, `${s.w}: the notes bar hidden`).toBeNull();
        expect(open.marks).toBeNull();
        expect(open.divider, `${s.w}: the divider`).not.toBeNull();
        if (s.layout === 'portrait') {
          // UNDER the lesson: the full width at the bottom; the lesson keeps ≥ 45 % of the height below the bars.
          expect(open.panel.left).toBeLessThanOrEqual(1);
          expect(open.panel.right).toBeGreaterThanOrEqual(s.w - 1);
          expect(open.panel.bottom).toBeGreaterThanOrEqual(s.h - 1);
          expect(open.panel.height).toBeGreaterThanOrEqual(200);
          expect(seen.height).toBeGreaterThanOrEqual(0.45 * (s.h - open.topbar.bottom) - 2);
          expect(open.frame.width).toBeGreaterThanOrEqual(s.w - 32);
          expect(open.divider.height).toBeGreaterThanOrEqual(24);
          expect(open.divider.width).toBeGreaterThanOrEqual(s.w - 2);
          // The noted place is in the part of the lesson that is seen.
          expect(place.top).toBeGreaterThanOrEqual(seen.top - 1);
          expect(place.bottom).toBeLessThanOrEqual(open.panel.top + 1);
        } else {
          // A column at the right; the lesson beside it, never under it.
          expect(open.panel.right).toBeGreaterThanOrEqual(s.w - 1);
          expect(open.frame.right).toBeLessThanOrEqual(open.panel.left + 1);
          expect(overlaps(open.frame, open.panel)).toBe(false);
          expect(open.panel.width).toBeGreaterThanOrEqual(200);
          expect(open.divider.width).toBeGreaterThanOrEqual(24);
          expect(place.right).toBeLessThanOrEqual(open.panel.left);
          expect(place.top).toBeGreaterThanOrEqual(open.appBar.bottom - 1);
          expect(place.bottom).toBeLessThanOrEqual(s.h + 1);
          // Without the 📝 column the lesson is wider than with it (0.14.2: 1280 → 735 px, 1920 → 935 px).
          expect(open.frame.width).toBeGreaterThanOrEqual(s.w === 1280 ? 800 : 935);
        }
        // Closed: everything back.
        await page.locator('[data-action="note-done"]').click();
        await expect(panel(page)).toBeHidden();
        await page.waitForTimeout(300);
        const back = await boxes(page);
        expect(back.strip, `${s.w}: the 📝 column back`).not.toBeNull();
        expect(back.notesBar, `${s.w}: the notes bar back`).not.toBeNull();
        expect(back.marks, `${s.w}: the 📝 of the note`).not.toBeNull();
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-screen="reader"]')).paddingBottom)).toBe('0px');
        // The next size starts without notes.
        await db(page, async (db) => { for (const n of await db.list('notes')) await db.remove('notes', n.id); for (const a of await db.list('annotations')) await db.remove('annotations', a.id); });
      }
      info(`T071-L1 ${scale * 100} %`, out);
    });
  }

  test('T071-L2 a phone 360×800 (100 % and 160 %): unchanged — no bar, no top row, only the 📝; the note over the whole window, no divider', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await start(page);
    for (const scale of [1, 1.6]) {
      await db(page, (db, s) => db.saveSettings({ fontScale: s }), scale);
      await openLesson(page, { uiScale: scale });
      const closed = await boxes(page);
      expect(closed.layout).toBe('phone');
      expect(closed.topbar).toBeNull();
      expect(closed.notesBar).toBeNull();
      expect(await noSideScroll(page)).toBe(true);
      await openNote(page, 'оценява рисковете', scale === 1 ? 'Телефон' : '');
      const open = await boxes(page);
      expect(open.panel.left).toBeLessThanOrEqual(1);
      expect(open.panel.width).toBeGreaterThanOrEqual(359);
      expect(open.divider).toBeNull();
      expect(await noSideScroll(page)).toBe(true);
      await page.locator('[data-action="note-done"]').click();
      await expect(panel(page)).toBeHidden();
    }
  });
});

// ===========================================================================
test.describe('T071-D the divider', () => {
  test('T071-D1 dragged with a finger (touch) and with the mouse, in portrait (horizontal) and landscape (vertical): the panel follows, the limits hold (lesson ≥ 45 %, note ≥ 200 px), the lesson is never under the panel', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 1280 });
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    let x = await boxes(page);
    const h0 = x.panel.height;
    // The mouse: up by 120 px → 120 px taller.
    const d = x.divider;
    await page.mouse.move(d.left + d.width / 2, d.top + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.left + d.width / 2, d.top + d.height / 2 - 120, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    x = await boxes(page);
    expect(Math.abs(x.panel.height - (h0 + 120))).toBeLessThanOrEqual(3);
    // A finger (touch events through CDP): far up → stops at the lesson's 45 %.
    const cdp = await page.context().newCDPSession(page);
    const touch = async (type, px, py) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py, radiusX: 6, radiusY: 6, id: 1 }] });
    let g = (await boxes(page)).divider;
    await touch('touchStart', g.left + 200, g.top + 12);
    for (let i = 1; i <= 8; i++) await touch('touchMove', g.left + 200, g.top + 12 - i * 100);
    await touch('touchEnd');
    await page.waitForTimeout(200);
    x = await boxes(page);
    const below = x.vh - x.topbar.bottom;
    info('T071-D1 portrait max', { panel: x.panel.height, below });
    expect(x.panel.height).toBeLessThanOrEqual(Math.ceil(below * 0.55) + 1);
    expect(seenLesson(x).height).toBeGreaterThanOrEqual(below * 0.45 - 2);
    // Far down → 200 px.
    g = x.divider;
    await touch('touchStart', g.left + 200, g.top + 12);
    for (let i = 1; i <= 10; i++) await touch('touchMove', g.left + 200, Math.min(1279, g.top + 12 + i * 100));
    await touch('touchEnd');
    await page.waitForTimeout(200);
    x = await boxes(page);
    expect(x.panel.height).toBe(200);
    await page.locator('[data-action="note-done"]').click();
    // Landscape: the vertical divider, the mouse to the left (a wider note), then far: the lesson keeps 45 % of the width.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    await page.locator('[data-field="notes-marks"] .notes-strip__mark').first().click();
    await expect(panel(page)).toBeVisible();
    x = await boxes(page);
    const w0 = x.panel.width;
    const v = x.divider;
    await page.mouse.move(v.left + 12, v.top + 300);
    await page.mouse.down();
    await page.mouse.move(v.left + 12 - 100, v.top + 300, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    x = await boxes(page);
    expect(Math.abs(x.panel.width - (w0 + 100))).toBeLessThanOrEqual(3);
    expect(x.frame.right).toBeLessThanOrEqual(x.panel.left + 1);
    await touch('touchStart', x.divider.left + 12, 400);
    for (let i = 1; i <= 10; i++) await touch('touchMove', Math.max(1, x.divider.left + 12 - i * 100), 400);
    await touch('touchEnd');
    await page.waitForTimeout(400);
    x = await boxes(page);
    info('T071-D1 landscape max', { panel: x.panel.width, frame: x.frame });
    expect(x.frame.right - 0).toBeGreaterThanOrEqual(0.45 * 1280 - 2);
    expect(x.frame.right).toBeLessThanOrEqual(x.panel.left + 1);
    expect(await noSideScroll(page)).toBe(true);
    await cdp.detach();
  });

  test('T071-D2 the keyboard: a separator with aria-orientation / aria-valuenow; ArrowLeft / ArrowRight (landscape), ArrowUp / ArrowDown (portrait), Home / End; the place is kept per orientation (portrait and landscape apart) and used after a rotation and a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(divider(page)).toHaveAttribute('role', 'separator');
    await expect(divider(page)).toHaveAttribute('aria-orientation', 'vertical');
    let x = await boxes(page);
    const w0 = x.panel.width;
    await divider(page).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await boxes(page)).panel.width).toBe(w0 + 48);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await boxes(page)).panel.width).toBe(w0 + 24);
    await page.keyboard.press('Home');
    await expect.poll(async () => (await boxes(page)).panel.width).toBe(200);
    await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round((200 / 1280) * 100)));
    await page.keyboard.press('End');
    x = await boxes(page);
    expect(x.frame.right).toBeGreaterThanOrEqual(0.45 * 1280 - 2);
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    const landscapeWidth = (await boxes(page)).panel.width;
    // Rotate: portrait has its own place (the default first), then its own change.
    await page.setViewportSize({ width: 800, height: 1280 });
    await page.waitForTimeout(400);
    x = await boxes(page);
    expect(x.layout).toBe('portrait');
    await expect(divider(page)).toHaveAttribute('aria-orientation', 'horizontal');
    expect(x.panel.height).toBe(Math.round(0.4 * 1280));
    await divider(page).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await boxes(page)).panel.height).toBe(Math.round(0.4 * 1280) - 48);
    const portraitHeight = (await boxes(page)).panel.height;
    // Back to landscape: its own place again.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    expect((await boxes(page)).panel.width).toBe(landscapeWidth);
    await page.waitForTimeout(600); // the save of the divider (after 400 ms)
    const stored = await db(page, async (db) => (await db.getSettings()).notesSplit);
    info('T071-D2 stored', stored);
    expect(stored.landscape).toBeCloseTo(landscapeWidth / 1280, 2);
    expect(stored.portrait).toBeCloseTo(portraitHeight / 1280, 2);
    // A reload in portrait: the portrait place.
    await page.setViewportSize({ width: 800, height: 1280 });
    await openLesson(page);
    await page.locator('[data-field="notes-marks"] .notes-strip__mark').first().click();
    await expect(panel(page)).toBeVisible();
    await page.waitForTimeout(200);
    expect((await boxes(page)).panel.height).toBe(portraitHeight);
  });
});

// ===========================================================================
test.describe('T071-M marking after the layout changed', () => {
  test('T071-M1 the marker in portrait (bar at the top), after a rotation to landscape (bar at the left) and with a note open under / beside the lesson: the stroke marks the text under the finger (the layer follows the lesson)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 1280 });
    await start(page);
    await openLesson(page);
    const strokeOver = async (needle) => {
      const frame = await lessonFrame(page);
      await frame.evaluate((needle) => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(needle)) { n.parentElement.scrollIntoView({ block: 'center' }); return; }
      }, needle);
      await page.waitForTimeout(250);
      const r = await textRect(page, needle);
      const y = (r.top + r.bottom) / 2;
      await page.mouse.move(r.left + 2, y);
      await page.mouse.down();
      await page.mouse.move(r.right - 2, y, { steps: 10 });
      await page.mouse.up();
    };
    const marker = page.locator('[data-field="mark-tools"] [data-tool="marker"], [data-field="mark-tools"] .mark-tools__tool').first();
    await marker.click();
    await strokeOver('Регламентът за киберустойчивост');
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.exact), { timeout: 6000 }).toContain('Регламентът за киберустойчивост');
    // Rotated: the bar at the left now.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    expect((await boxes(page)).orientTools).toBe('vertical');
    await strokeOver('Уязвимостите се докладват');
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.exact), { timeout: 6000 }).toContain('Уязвимостите се докладват');
    await page.keyboard.press('Escape'); // the tool off
    // A note open beside the lesson; then the marker again.
    await openNote(page, 'оценява рисковете', 'До урока');
    await marker.click();
    await strokeOver('Производителят');
    await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color).map((a) => a.exact), { timeout: 6000 }).toContain('Производителят');
    // And under the lesson (portrait), the note still open.
    await page.setViewportSize({ width: 800, height: 1280 });
    await page.waitForTimeout(400);
    await expect(panel(page)).toBeVisible();
    expect((await boxes(page)).panel.left).toBeLessThanOrEqual(1);
    await strokeOver('Абзац 30 за превъртане');
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.exact).join('|'), { timeout: 6000 }).toContain('Абзац 30 за превъртане');
    info('T071-M1', (await liveAnn(page)).map((a) => [a.exact, a.color]));
  });

  test('T071-M2 "Скрий" in portrait: each bar folds to a small handle (≥ 44 px) and comes back; T-073 (the addition to D-046): with both bars hidden there is no row — the handles float in the top corners over the lesson\'s margin, never over its text; the choice holds after a rotation', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 1280 });
    await start(page);
    await openLesson(page);
    const before = await boxes(page);
    await page.locator('[data-action="hide-tools"]').click();
    await page.waitForTimeout(400);
    // One bar hidden: its handle stays in the row (the row is there for the other bar).
    let x = await boxes(page);
    expect(x.toolsHandle.top).toBeGreaterThanOrEqual(x.topbar.top - 1);
    expect(x.toolsHandle.bottom).toBeLessThanOrEqual(x.topbar.bottom + 1);
    await page.locator('[data-action="hide-notes"]').click();
    await page.waitForTimeout(800);
    x = await boxes(page);
    expect(x.tools).toBeNull();
    expect(x.notesBar).toBeNull();
    // No row: the lesson moved up into its place.
    expect(x.topbar === null || x.topbar.height <= 1).toBe(true);
    expect(x.frame.top).toBeLessThan(before.frame.top - 20);
    const text = await (await lessonFrame(page)).evaluate(() => {
      let left = Infinity; let right = -Infinity;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const r = document.createRange();
      for (let n = w.nextNode(); n; n = w.nextNode()) { if (!/\S/.test(n.data)) continue; r.selectNodeContents(n); const b = r.getBoundingClientRect(); if (b.width > 0) { left = Math.min(left, b.left); right = Math.max(right, b.right); } }
      return { left, right };
    });
    for (const part of ['toolsHandle', 'notesHandle']) {
      expect(x[part], part).not.toBeNull();
      expect(x[part].width).toBeGreaterThanOrEqual(44);
      expect(x[part].height).toBeGreaterThanOrEqual(44);
      expect(x[part].top).toBeGreaterThanOrEqual(x.appBar.bottom - 1);
    }
    expect(x.toolsHandle.left).toBeLessThanOrEqual(8);
    expect(x.notesHandle.right).toBeGreaterThanOrEqual(x.vw - 8);
    // Never over the lesson's text: in its margin (or the room made for it).
    expect(x.frame.left + text.left).toBeGreaterThanOrEqual(x.toolsHandle.right);
    expect(x.frame.left + text.right).toBeLessThanOrEqual(x.notesHandle.left);
    expect(await noSideScroll(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    x = await boxes(page);
    expect(x.tools).toBeNull();
    expect(x.toolsHandle).not.toBeNull();
    expect(x.notesHandle).not.toBeNull();
    await page.setViewportSize({ width: 800, height: 1280 });
    await page.waitForTimeout(400);
    await page.locator('[data-action="show-tools"]').click();
    await page.locator('[data-action="show-notes"]').click();
    await page.waitForTimeout(400);
    x = await boxes(page);
    expect(x.tools).not.toBeNull();
    expect(x.notesBar).not.toBeNull();
    expect(x.orientTools).toBe('horizontal');
  });
});
