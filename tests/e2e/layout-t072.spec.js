// T-072 (tester): tests of T-071b (0.15.0, D-046), written "as an attacker".
// - L: every size (800×1280, 1280×800, 1200×1920, 1920×1200, 360×800) at 100 % / 160 %
//   in the light and the dark theme; the edges of the layouts (599 / 600 / 601 px,
//   the labels at 1000 px); no sideways scroll, nothing over the lesson, the noted
//   place seen, a new selection while a note is open.
// - D: the divider pushed past every edge (touch, mouse, two fingers, a cancelled
//   drag, a right button, keys), at 160 % and in a small window; garbage in
//   settings.notesSplit; rotations back and forth (no drift), a rotation mid-drag.
// - M: the marker and the palm after the layout changed (portrait under / beside,
//   the divider moved): the stroke marks the text under the finger; a stroke on the
//   top row or on the panel never marks the lesson under it.
// - S: a lesson cannot move the divider, the bars or the panel.
// Known defects: test.fail(true, 'T072-…'). Synthetic data only, no network (D-026).
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
const C = 'LRN-T72L';
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

const contrastOf = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const bgOf = (e) => { for (let x = e; x; x = x.parentElement) { const c = rgb(getComputedStyle(x).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c; } return [255, 255, 255]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fg = rgb(getComputedStyle(el).color);
  const a = lum(fg), b = lum(bgOf(el));
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10;
}, sel);
const clearNotes = (page) => db(page, async (db) => { for (const n of await db.list('notes')) await db.remove('notes', n.id); for (const a of await db.list('annotations')) await db.remove('annotations', a.id); });

// ===========================================================================
const ALL = [
  { w: 800, h: 1280, layout: 'portrait' },
  { w: 1280, h: 800, layout: 'landscape' },
  { w: 1200, h: 1920, layout: 'portrait' },
  { w: 1920, h: 1200, layout: 'landscape' },
  { w: 360, h: 800, layout: 'phone' },
];
test.describe('T072-L every size, both themes', () => {
  for (const [scale, theme] of [[1, 'light'], [1.6, 'dark'], [1, 'dark'], [1.6, 'light']]) {
    test(`T072-L1 ${scale * 100} % text, ${theme} theme: every size — no sideways scroll, the lesson never under a bar or the panel, the noted place seen, the divider's grip readable; a new selection while the note is open offers "📝 Бележка" outside the panel; closed again: the 📝 and the bar come back`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await start(page, { scale });
      await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
      const out = {};
      for (const s of ALL) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await openLesson(page, { uiScale: scale });
        expect(await page.evaluate(() => document.documentElement.dataset.theme || 'system')).toBe(theme);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(250);
        const closed = await boxes(page);
        expect(closed.layout, `${s.w}×${s.h}`).toBe(s.layout);
        expect(await noSideScroll(page), `${s.w}×${s.h} closed`).toBe(true);
        if (s.layout !== 'phone') {
          for (const part of ['tools', 'notesBar']) expect(overlaps(closed[part], closed.frame), `${s.w}: ${part} over the lesson`).toBe(false);
        }
        await openNote(page, 'оценява рисковете', `Бележка ${s.w}`);
        await page.waitForTimeout(450);
        const open = await boxes(page);
        const place = await textRect(page, 'оценява рисковете');
        out[`${s.w}x${s.h}`] = { frame: [open.frame.width, open.frame.height], panel: [open.panel.width, open.panel.height], place: [Math.round(place.top), Math.round(place.bottom)] };
        expect(await noSideScroll(page), `${s.w}×${s.h} open`).toBe(true);
        if (s.layout === 'phone') {
          expect(open.panel.left).toBeLessThanOrEqual(1);
          expect(open.panel.width).toBeGreaterThanOrEqual(s.w - 1);
          expect(open.divider, 'no divider on a phone').toBeNull();
        } else {
          const seen = seenLesson(open);
          expect(open.notesBar, `${s.w}: notes bar hidden`).toBeNull();
          expect(open.strip, `${s.w}: 📝 column hidden`).toBeNull();
          expect(place.top, `${s.w}: noted place below the bars`).toBeGreaterThanOrEqual(seen.top - 1);
          expect(place.bottom, `${s.w}: noted place above the panel`).toBeLessThanOrEqual(seen.bottom + 1);
          expect(place.right, `${s.w}: noted place left of the panel`).toBeLessThanOrEqual(seen.right + 1);
          if (s.layout === 'landscape') expect(overlaps(open.frame, open.panel)).toBe(false);
          if (s.layout === 'portrait') expect(open.tools && overlaps(open.tools, open.panel)).toBeFalsy();
          const c = await contrastOf(page, '[data-field="notes-divider"] *:not(:empty), [data-field="notes-divider"]');
          expect(c, `${s.w} ${theme}: the grip is readable`).toBeGreaterThanOrEqual(3);
          // A new selection while the note is open: "📝 Бележка" floats, not over the panel.
          await select(page, 'Уязвимостите се докладват');
          const quick = page.locator('[data-action="new-note-quick"]');
          await expect(quick, `${s.w}: "📝 Бележка" for a new selection`).toBeVisible({ timeout: 3000 });
          const q = await quick.boundingBox();
          const qb = { left: q.x, top: q.y, right: q.x + q.width, bottom: q.y + q.height };
          const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('[data-field]')?.dataset.field || e.tagName) : null; }, [q.x + q.width / 2, q.y + q.height / 2]);
          const covers = await page.evaluate((qb) => [...document.querySelectorAll('[data-field="notes-panel"] button, [data-field="notes-panel"] textarea, [data-field="note-quote"], [data-field="note-status"]')].filter((e) => e.getClientRects().length).filter((e) => { const r = e.getBoundingClientRect(); return r.left < qb.right - 1 && qb.left < r.right - 1 && r.top < qb.bottom - 1 && qb.top < r.bottom - 1; }).map((e) => e.dataset.action || e.dataset.field || e.tagName), qb);
          out[`${s.w}x${s.h}`].quick = { box: [Math.round(q.x), Math.round(q.y), Math.round(q.width), Math.round(q.height)], panel: [open.panel.left, open.panel.top], covers };
          console.log('QUICK', s.w, JSON.stringify(out[`${s.w}x${s.h}`].quick));
          if (covers.length) test.fail(true, 'T072-L1: with a note open in landscape, "📝 Бележка" for a new selection floats over the note column (the panel at the right edge) and covers its controls');
          expect(covers, `${s.w}: "📝 Бележка" over the panel's controls`).toEqual([]);
          expect(q.x + q.width).toBeLessThanOrEqual(s.w + 1);
          expect(q.height).toBeGreaterThanOrEqual(36);
          await (await lessonFrame(page)).evaluate(() => getSelection().removeAllRanges());
        }
        await page.locator('[data-action="note-done"]').click();
        await expect(panel(page)).toBeHidden();
        await page.waitForTimeout(250);
        const back = await boxes(page);
        expect(back.marks, `${s.w}: the 📝 back`).not.toBeNull();
        if (s.layout !== 'phone') expect(back.notesBar, `${s.w}: the bar back`).not.toBeNull();
        expect(await noSideScroll(page)).toBe(true);
        await clearNotes(page);
      }
      info(`T072-L1 ${scale * 100} % ${theme}`, out);
    });
  }

  test('T072-L2 the edges: 599×1000 phone, 600×601 portrait, 601×600 landscape, 999×1400 / 1000×1400 portrait (icons only below 1000 px, the names stay as aria-label), 600×960 portrait at 160 %: no sideways scroll, the top row never over the lesson, the bars fit (wrap, never cut), the note opens', async ({ page }) => {
    await start(page, { scale: 1 });
    const out = [];
    for (const [w, h, layout, ui] of [[599, 1000, 'phone', 1], [600, 601, 'portrait', 1], [601, 600, 'landscape', 1], [999, 1400, 'portrait', 1], [1000, 1400, 'portrait', 1], [600, 960, 'portrait', 1.6]]) {
      await page.setViewportSize({ width: w, height: h });
      await openLesson(page, { uiScale: ui });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      const x = await boxes(page);
      const labels = await page.evaluate(() => [...document.querySelectorAll('[data-field="mark-tools"] .mark-tools__label')].filter((l) => l.getClientRects().length && l.getBoundingClientRect().width > 0).length);
      const names = await page.evaluate(() => [...document.querySelectorAll('[data-field="mark-tools"] [data-tool]')].map((b) => b.getAttribute('aria-label')).filter(Boolean).length);
      // Every button of the bars is inside the window (not cut).
      const cut = await page.evaluate(() => [...document.querySelectorAll('[data-field="mark-tools"] button, .notes-strip__bar button')].filter((b) => b.getClientRects().length).filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map((b) => b.getAttribute('aria-label') || b.textContent));
      out.push({ w, h, layout: x.layout, labels, names, cut, topbar: x.topbar && [x.topbar.top, x.topbar.bottom], frameTop: x.frame.top });
      expect(x.layout, `${w}×${h}`).toBe(layout);
      expect(await noSideScroll(page), `${w}×${h}`).toBe(true);
      expect(cut, `${w}×${h}: buttons cut`).toEqual([]);
      expect(names, `${w}: the tools keep their names`).toBeGreaterThanOrEqual(3);
      if (layout === 'portrait') {
        expect(x.frame.top, `${w}: the lesson below the top row`).toBeGreaterThanOrEqual(x.topbar.bottom - 1);
        if (w < 1000) expect(labels, `${w}: icons only`).toBe(0);
      }
      await openNote(page, 'оценява рисковете', null);
      await page.waitForTimeout(300);
      const o = await boxes(page);
      if (layout !== 'phone') {
        expect(o.panel.height).toBeGreaterThanOrEqual(layout === 'portrait' ? 200 : 100);
        expect(seenLesson(o).height, `${w}×${h}: some lesson is seen`).toBeGreaterThan(0);
      }
      expect(await noSideScroll(page)).toBe(true);
      await page.keyboard.press('Escape');
      await clearNotes(page);
    }
    info('T072-L2', out);
  });
});

// ===========================================================================
const touchOf = (cdp) => async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' && !pts ? [] : pts.map(([x, y, id = 1, r = 4]) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: r, radiusY: r, force: 1 })) });
const limits = (x) => {
  if (x.layout === 'portrait') {
    const below = x.vh - x.topbar.bottom;
    return { size: x.panel.height, min: 200, max: Math.ceil(below * 0.55) + 1, lesson: seenLesson(x).height, lessonMin: below * 0.45 - 2 };
  }
  return { size: x.panel.width, min: 200, max: Math.ceil(x.vw * 0.55) + 1, lesson: x.frame.right, lessonMin: 0.45 * x.vw - 2 };
};
const checkLimits = (x, what) => {
  const l = limits(x);
  expect(l.size, `${what}: the note ≥ 200 px`).toBeGreaterThanOrEqual(l.min);
  expect(l.lesson, `${what}: the lesson keeps 45 %`).toBeGreaterThanOrEqual(l.lessonMin);
  if (x.layout === 'landscape') expect(x.frame.right, `${what}: the lesson beside the panel`).toBeLessThanOrEqual(x.panel.left + 1);
};

test.describe('T072-D the divider pushed past every edge', () => {
  test('T072-D1 a finger flung past the top / bottom of the window and past both sides, a second finger during the drag, a cancelled touch, the right mouse button, a drag that starts on the grip and leaves the window: the limits hold every time (also at 160 % and in a 600×700 window), no sideways scroll, the note keeps its text', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const touch = touchOf(cdp);
    await start(page);
    const out = [];
    for (const [w, h, ui] of [[800, 1280, 1], [1280, 800, 1], [800, 1280, 1.6], [600, 700, 1], [700, 600, 1]]) {
      await page.setViewportSize({ width: w, height: h });
      await openLesson(page, { uiScale: ui });
      await openNote(page, 'оценява рисковете', `Текст ${w}`);
      let x = await boxes(page);
      const portrait = x.layout === 'portrait';
      const g = () => boxes(page).then((b) => ({ x: b.divider.left + b.divider.width / 2, y: b.divider.top + b.divider.height / 2 }));
      // Flung far towards the lesson (in one move, out of the window).
      let p = await g();
      await touch('touchStart', [[p.x, p.y]]);
      await touch('touchMove', [[portrait ? p.x : -50, portrait ? -80 : p.y]]);
      await touch('touchEnd');
      await page.waitForTimeout(250);
      x = await boxes(page);
      checkLimits(x, `${w}×${h} flung to the lesson`);
      const max = limits(x).size;
      // Flung far the other way.
      p = await g();
      await touch('touchStart', [[p.x, p.y]]);
      await touch('touchMove', [[portrait ? p.x : w + 80, portrait ? h + 80 : p.y]]);
      await touch('touchEnd');
      await page.waitForTimeout(250);
      x = await boxes(page);
      checkLimits(x, `${w}×${h} flung away`);
      expect(limits(x).size).toBe(200);
      // A second finger lands on the lesson during the drag and moves: only the first one moves the divider.
      p = await g();
      await touch('touchStart', [[p.x, p.y, 1]]);
      await touch('touchMove', [[p.x - (portrait ? 0 : 60), p.y - (portrait ? 60 : 0), 1]]);
      await touch('touchMove', [[p.x - (portrait ? 0 : 60), p.y - (portrait ? 60 : 0), 1], [40, 300, 2]]);
      await touch('touchMove', [[p.x - (portrait ? 0 : 60), p.y - (portrait ? 60 : 0), 1], [400, 20, 2]]);
      await touch('touchEnd');
      await page.waitForTimeout(250);
      x = await boxes(page);
      checkLimits(x, `${w}×${h} two fingers`);
      const two = limits(x).size;
      expect(Math.abs(two - 260), `${w}×${h}: the first finger moved it by 60`).toBeLessThanOrEqual(4);
      // A cancelled touch: the divider stays where it was taken to (or back), never past a limit.
      p = await g();
      await touch('touchStart', [[p.x, p.y]]);
      await touch('touchMove', [[p.x - (portrait ? 0 : 900), p.y - (portrait ? 900 : 0)]]);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await page.waitForTimeout(250);
      x = await boxes(page);
      checkLimits(x, `${w}×${h} cancelled`);
      // The right mouse button does nothing.
      const before = limits(x).size;
      p = await g();
      await page.mouse.move(p.x, p.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(p.x - (portrait ? 0 : 100), p.y - (portrait ? 100 : 0), { steps: 4 });
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(200);
      x = await boxes(page);
      expect(limits(x).size, `${w}×${h}: right button`).toBe(before);
      // The mouse leaves the window during the drag and is let go outside.
      p = await g();
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(portrait ? p.x : -200, portrait ? -200 : p.y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(250);
      x = await boxes(page);
      checkLimits(x, `${w}×${h} mouse out of the window`);
      expect(limits(x).size).toBe(max);
      expect(await noSideScroll(page), `${w}×${h}`).toBe(true);
      await expect(noteText(page)).toHaveValue(`Текст ${w}`);
      out.push({ w, h, ui, layout: x.layout, max, two });
      await page.locator('[data-action="note-done"]').click();
      await clearNotes(page);
    }
    info('T072-D1', out);
    await cdp.detach();
  });

  test('T072-D2 garbage in settings.notesSplit (negative, 0, 1, 7, NaN-like strings, null, an array, nested objects): the defaults are used, the limits hold, no error; a rotation in the middle of a drag; five rotations back and forth with a note open: no drift, each orientation keeps its own size', async ({ page }) => {
    await start(page);
    const out = [];
    for (const bad of [{ portrait: -1, landscape: 0 }, { portrait: 1, landscape: 7 }, { portrait: 'NaN', landscape: '0.5' }, [0.3, 0.3], { portrait: { v: 0.3 } }, 'x', null, { portrait: 1e-9, landscape: 0.9999999 }]) {
      await db(page, (db, v) => db.saveSettings({ notesSplit: v }), bad);
      for (const [w, h] of [[800, 1280], [1280, 800]]) {
        await page.setViewportSize({ width: w, height: h });
        await openLesson(page);
        if (!(await page.locator('[data-field="notes-marks"] .notes-strip__mark').count())) await openNote(page, 'оценява рисковете', 'Боклук');
        else { await page.locator('[data-field="notes-marks"] .notes-strip__mark').first().click(); await expect(panel(page)).toBeVisible(); }
        await page.waitForTimeout(250);
        const x = await boxes(page);
        checkLimits(x, `${JSON.stringify(bad)} ${w}×${h}`);
        out.push([JSON.stringify(bad), w, limits(x).size]);
        await page.locator('[data-action="note-done"]').click();
      }
    }
    info('T072-D2 garbage', out);
    // A rotation in the middle of a drag (the finger still down).
    await db(page, (db) => db.saveSettings({ notesSplit: null }));
    await page.setViewportSize({ width: 800, height: 1280 });
    await openLesson(page);
    await page.locator('[data-field="notes-marks"] .notes-strip__mark').first().click();
    await expect(panel(page)).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    const touch = touchOf(cdp);
    let x = await boxes(page);
    await touch('touchStart', [[300, x.divider.top + 12]]);
    await touch('touchMove', [[300, x.divider.top - 60]]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    await touch('touchMove', [[100, 300]]);
    await touch('touchEnd');
    await page.waitForTimeout(400);
    x = await boxes(page);
    checkLimits(x, 'rotated mid-drag');
    expect(await noSideScroll(page)).toBe(true);
    await cdp.detach();
    // Set each orientation's own size with the keys, then rotate five times.
    await divider(page).focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    const L = (await boxes(page)).panel.width;
    await page.setViewportSize({ width: 800, height: 1280 });
    await page.waitForTimeout(300);
    await divider(page).focus();
    await page.keyboard.press('End');
    const P = (await boxes(page)).panel.height;
    const seen = [];
    for (let i = 0; i < 5; i++) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(250);
      const a = (await boxes(page)).panel.width;
      await page.setViewportSize({ width: 800, height: 1280 });
      await page.waitForTimeout(250);
      const b = (await boxes(page)).panel.height;
      seen.push([a, b]);
    }
    info('T072-D2 rotations', { L, P, seen });
    for (const [a, b] of seen) { expect(a).toBe(L); expect(b).toBe(P); }
    await expect(noteText(page)).toHaveValue('Боклук');
  });
});

// ===========================================================================
test.describe('T072-M the marker and the palm after the layout changed', () => {
  test('T072-M1 a finger stroke with the marker: portrait with the note under the lesson and the divider moved, the page scrolled (the sticky top row over the lesson), then landscape with the note beside it — the stroke marks exactly the text under the finger; a stroke on the top row or on the panel never marks the lesson under it; a palm (a large contact) during a stroke is ignored', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 1280 });
    await start(page);
    await openLesson(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = touchOf(cdp);
    const marked = async () => (await liveAnn(page)).filter((a) => a.color || a.style).map((a) => a.exact);
    const strokeAt = async (y, x0, x1, palm = null) => {
      await touch('touchStart', [[x0, y]]);
      for (let i = 1; i <= 10; i++) {
        const pts = [[x0 + ((x1 - x0) * i) / 10, y]];
        if (palm && i >= 3) pts.push([palm[0], palm[1], 2, 40]);
        await touch('touchMove', pts);
        await page.waitForTimeout(10);
      }
      await touch('touchEnd');
      await page.waitForTimeout(300);
    };
    const scrollTo = async (needle, block = 'center') => {
      const frame = await lessonFrame(page);
      await frame.evaluate(([needle, block]) => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(needle)) { n.parentElement.scrollIntoView({ block }); return; }
      }, [needle, block]);
      await page.waitForTimeout(250);
      // Into the part of the lesson that is seen (the lesson's own scrollIntoView centres it in the window, under a panel).
      const r = await textRect(page, needle);
      await page.evaluate((dy) => window.scrollBy(0, dy), r.top - 360);
      await page.waitForTimeout(250);
    };
    await openNote(page, 'оценява рисковете', 'Под урока');
    // The divider up by 150 px.
    let x = await boxes(page);
    await touch('touchStart', [[300, x.divider.top + 12]]);
    await touch('touchMove', [[300, x.divider.top - 138]]);
    await touch('touchEnd');
    await page.waitForTimeout(300);
    x = await boxes(page);
    await page.locator('[data-field="mark-tools"] [data-tool="marker"]').click();
    // 1. A line in the seen part.
    await scrollTo('Регламентът за киберустойчивост');
    let r = await textRect(page, 'Регламентът за киберустойчивост');
    await strokeAt((r.top + r.bottom) / 2, r.left + 2, r.right - 2, [100, x.panel.top - 40]);
    await expect.poll(marked, { timeout: 6000 }).toContain('Регламентът за киберустойчивост');
    // 2. A line right under the sticky top row: a stroke ON the row must not mark it.
    x = await boxes(page);
    const rowMid = (x.topbar.top + x.topbar.bottom) / 2;
    const frame = await lessonFrame(page);
    // Bring "Абзац 5" just under the top row's middle (under the row).
    await frame.evaluate(() => {});
    const scrolled = await page.evaluate(() => window.scrollY);
    const a5 = await textRect(page, 'Абзац 5 за превъртане');
    await page.evaluate((dy) => window.scrollBy(0, dy), a5.top - rowMid + 4);
    await page.waitForTimeout(300);
    const under = await textRect(page, 'Абзац 5 за превъртане');
    x = await boxes(page);
    const hidden = under.top < x.topbar.bottom && under.bottom > x.topbar.top;
    const before = (await marked()).length;
    if (hidden) await strokeAt((Math.max(under.top, x.topbar.top) + Math.min(under.bottom, x.topbar.bottom)) / 2, x.tools.right + 8, Math.min(x.notesBar ? x.notesBar.left - 8 : 600, 600));
    // 3. A stroke on the panel (over the lesson below it).
    await strokeAt(x.panel.top + 60, 60, 500);
    const after = await marked();
    info('T072-M1 row / panel', { hidden, scrolled, before, after });
    expect(hidden, 'a line of the lesson lies under the sticky top row').toBe(true);
    expect(after.length, 'a stroke on the top row or on the panel marked the lesson').toBe(before);
    // 4. Landscape, the note beside the lesson, the divider moved by the keys.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await divider(page).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    await scrollTo('Уязвимостите се докладват');
    r = await textRect(page, 'Уязвимостите се докладват');
    x = await boxes(page);
    await strokeAt((r.top + r.bottom) / 2, r.left + 2, Math.min(r.right - 2, x.panel.left - 4), [x.frame.left + 30, 700]);
    await expect.poll(marked, { timeout: 6000 }).toContain('Уязвимостите се докладват');
    // 5. A stroke starting on the panel and going over the lesson: nothing.
    const n = (await marked()).length;
    await strokeAt(300, x.panel.left + 80, x.frame.left + 40);
    expect((await marked()).length).toBe(n);
    info('T072-M1', await marked());
    await cdp.detach();
  });
});

test.describe('T072-M2 a stroke that leaves the lesson onto the top row (portrait)', () => {
  test('T072-M2 portrait (800×1280 and 1200×1920): a marker stroke from a line of the lesson up over the buttons of the top row (tools, colours, "Скрий", the notes bar) presses none of them, the bars stay shown (tools-t016 S5 drags out to the left edge in portrait instead)', async ({ page }) => {
    await start(page);
    for (const [w, h] of [[800, 1280], [1200, 1920]]) {
      await page.setViewportSize({ width: w, height: h });
      await openLesson(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      const cdp = await page.context().newCDPSession(page);
      const touch = touchOf(cdp);
      await page.locator('[data-field="mark-tools"] [data-tool="marker"]').click();
      const pressed = () => page.locator('[data-field="mark-tools"] button, .notes-strip__bar button').evaluateAll((els) => els.map((e) => `${e.dataset.tool || e.dataset.color || e.dataset.action}:${e.getAttribute('aria-pressed')}`));
      const before = await pressed();
      const x = await boxes(page);
      const r = await textRect(page, 'Абзац 0 за превъртане');
      const y = (r.top + r.bottom) / 2;
      const buttons = await page.evaluate(() => [...document.querySelectorAll('[data-field="mark-tools"] button, .notes-strip__bar button')].filter((b) => b.getClientRects().length).map((b) => { const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }));
      await touch('touchStart', [[r.left + 4, y]]);
      for (let i = 1; i <= 6; i++) { await touch('touchMove', [[r.left + 4 + i * 20, y]]); await page.waitForTimeout(10); }
      for (const [bx, by] of buttons) { await touch('touchMove', [[bx, by]]); await page.waitForTimeout(10); }
      await touch('touchEnd');
      await page.waitForTimeout(400);
      const after = await pressed();
      const y2 = await boxes(page);
      info(`T072-M2 ${w}`, { buttons: buttons.length, marks: (await liveAnn(page)).map((a) => a.exact) });
      expect(after).toEqual(before);
      expect(y2.tools, `${w}: the tools still shown`).not.toBeNull();
      expect(y2.notesBar, `${w}: the notes bar still shown`).not.toBeNull();
      expect(y2.topbar.top).toBe(x.topbar.top);
      await page.keyboard.press('Escape');
      await cdp.detach();
      await clearNotes(page);
    }
  });
});

// ===========================================================================
test.describe('T072-S the lesson vs the layout', () => {
  test('T072-S1 a lesson cannot move the divider, the bars or the panel: it posts every message it can (lrn:size huge / 0, lrn:layout, lrn:position, lrn:anchor, lrn:selection), scrolls itself into view, takes the focus and gets the user\'s arrow keys / Home / End (the divider is not focused), dispatches synthetic pointer events — the panel size, the divider, the top row and the stored notesSplit stay as they were', async ({ page }) => {
    const ATTACK = `<script>
      window.__go = () => {
        let i = 0;
        const t = setInterval(() => {
          i++;
          // (no lrn:escape here: with the field left, Escape in the lesson closes the panel by design — T072-I2)
          for (const m of [{ type: 'lrn:size', height: i % 2 ? 99999 : 0 }, { type: 'lrn:layout', items: [], height: 99999 }, { type: 'lrn:position', top: 0 }, { type: 'lrn:anchor', top: 99999 }, { type: 'lrn:selection', empty: true }])
            parent.postMessage(Object.assign({ lrn: 1 }, m), '*');
          try { document.body.lastElementChild.scrollIntoView({ block: 'end' }); } catch (e) {}
          try { document.getElementById('lv').focus(); } catch (e) {}
          for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.dispatchEvent(new PointerEvent(type, { clientX: 10, clientY: 10 * i, bubbles: true }));
          if (i > 60) clearInterval(t);
        }, 30);
      };
    </script><input id="lv" aria-label="lv">`;
    await page.setViewportSize({ width: 800, height: 1280 });
    // The lesson with the attack (the same course id: imported again over the clean one).
    await start(page);
    const f = files();
    f['lessons/0001-parvi.html'] = f['lessons/0001-parvi.html'].replace('<main>', `<main>${ATTACK}`);
    const zip = asFile(`${C}.zip`, makeZip(toBytes(f), { root: C }));
    expect(await page.evaluate(async ({ name, bytes }) => { const m = await import('./src/course-import.js'); try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; } }, { name: zip.name, bytes: [...zip.buffer] })).not.toMatch(/^ERROR/);
    for (const [w, h] of [[800, 1280], [1280, 800]]) {
      await page.setViewportSize({ width: w, height: h });
      const frame = await openLesson(page);
      if (!(await page.locator('[data-field="notes-marks"] .notes-strip__mark').count())) await openNote(page, 'оценява рисковете', 'Пазена');
      else { await page.locator('[data-field="notes-marks"] .notes-strip__mark').first().click(); await expect(panel(page)).toBeVisible(); }
      await divider(page).focus();
      await page.keyboard.press(w > h ? 'ArrowLeft' : 'ArrowUp');
      await page.waitForTimeout(700);
      const stored0 = await db(page, async (db) => (await db.getSettings()).notesSplit);
      const x0 = await boxes(page);
      // The user taps the lesson (leaves the note), the lesson takes the focus, the user presses keys.
      const fb = x0.frame;
      await page.mouse.click(fb.left + 40, Math.min(fb.bottom, x0.layout === 'portrait' ? x0.panel.top : fb.bottom) - 30);
      await page.mouse.click(fb.left + 40, Math.min(fb.bottom, x0.layout === 'portrait' ? x0.panel.top : fb.bottom) - 30);
      await frame.evaluate(() => window.__go());
      for (const k of ['ArrowUp', 'ArrowLeft', 'Home', 'End', 'ArrowDown', 'ArrowRight']) { await page.keyboard.press(k); await page.waitForTimeout(60); }
      await page.waitForTimeout(1800);
      const x1 = await boxes(page);
      const stored1 = await db(page, async (db) => (await db.getSettings()).notesSplit);
      console.log('S1', w, JSON.stringify({ panel0: x0.panel, panel1: x1.panel, d0: x0.divider, d1: x1.divider, stored0, stored1 }));
      info(`T072-S1 ${w}×${h}`, { panel0: x0.panel, panel1: x1.panel, stored0, stored1, focus: await page.evaluate(() => document.activeElement?.tagName) });
      expect(x1.panel).toEqual(x0.panel);
      expect(x1.divider.left).toBe(x0.divider.left);
      expect(x1.divider.width).toBe(x0.divider.width);
      if (x0.layout === 'portrait') { expect(x1.topbar?.height).toBe(x0.topbar?.height); expect(x1.divider.top).toBe(x0.divider.top); }
      else expect(x1.tools.left).toBe(x0.tools.left);
      expect(stored1).toEqual(stored0);
      expect(await noSideScroll(page)).toBe(true);
      await expect(panel(page)).toBeVisible();
      await page.locator('[data-action="note-done"]').click();
    }
  });
});
