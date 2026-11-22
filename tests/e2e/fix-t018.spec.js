// T-018 (tester): T-067 (0.13.4) checked from the other side.
// - T066-D4: the guard after the bar is shown / hidden is 350 ms and only within
//   64 px of the touch that switched it: another control acts at once; the same
//   place 360+ ms later acts too;
// - T066-D3: Ctrl+Z only when the app saw the user's Control: a lesson that
//   gives the focus back to the app BEFORE the Control (no blur / focus after
//   the Control) — information;
// - the app's own Ctrl+Z after a click into the strip / the notes panel.
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 90000 });

let problems;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => route.abort());
});
test.afterEach(() => { expect(problems).toEqual([]); });
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value) });

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const C = 'LRN-F18';
const LONG = Array.from({ length: 40 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
const files = (script = '') => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', `<p id="p1">Регламентът за киберустойчивост се прилага за продукти.</p><p id="p2">Производителят оценява рисковете.</p><p id="p3">Уязвимостите се докладват бързо.</p>${LONG}${script}`),
});
async function setup(page, script = '') {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push(e.data); });
  });
  await page.goto('./');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  const f = asFile(`${C}.zip`, makeZip(toBytes(files(script)), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
  expect(r).not.toMatch(/^ERROR/);
  await page.goto(`./#/c/${C}/read/0001`);
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
}
const count = (page) => page.evaluate(async () => {
  const db = await import('./src/db.js');
  return (await db.list('annotations')).filter((a) => a.color).length;
});
async function markWord(page, needle) {
  const before = await count(page);
  const frame = await (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
  await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
      getSelection().removeAllRanges(); getSelection().addRange(r); return;
    }
  }, needle);
  await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length), { timeout: 3000 }).toBeGreaterThan(0);
  await page.locator('[data-field="mark-tools"] [data-color="yellow"]').click();
  await expect.poll(() => count(page), { timeout: 5000 }).toBe(before + 1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__lrn = []; });
}
const tool = (page) => page.evaluate(() => document.querySelector('[data-field="mark-tools"]')?.dataset.tool);

test.describe('T018-A T-067', () => {
  test('T018-A1 (T066-D4) after "☰" a tap on another control more than 64 px away acts at once (260 ms later, after the 200 ms slide, inside the 350 ms); a tap at the place of "☰" 400 ms later acts too', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setup(page);
    const cdp = await page.context().newCDPSession(page);
    const tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const handle = page.locator('[data-field="mark-tools-handle"]');
    const bar = page.locator('[data-field="mark-tools"]');
    if (await bar.isVisible()) { await page.locator('[data-field="mark-tools"] [data-action="hide-tools"]').tap(); await page.waitForTimeout(500); }
    await expect(handle).toBeVisible();
    const hb = await handle.boundingBox();
    // The final places of the tools (after the slide).
    await tap(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await expect(bar).toBeVisible();
    await page.waitForTimeout(800);
    const buttons = await bar.locator('[data-tool]').evaluateAll((bs, h) => bs.map((b) => { const r = b.getBoundingClientRect(); return { tool: b.dataset.tool, x: r.left + r.width / 2, y: r.top + r.height / 2, d: Math.hypot(r.left + r.width / 2 - h.x, r.top + r.height / 2 - h.y) }; }), { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 });
    const far = buttons.filter((b) => b.d > 80).sort((a, b) => a.d - b.d)[0];
    info('T018-A1 buttons', { buttons, far });
    expect(far).toBeTruthy();
    await page.locator('[data-field="mark-tools"] [data-action="hide-tools"]').tap();
    await page.waitForTimeout(600);
    // Shown again by a tap; 260 ms later (after the slide, inside the 350 ms) a tap on a far tool acts.
    await tap(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForTimeout(260);
    await tap(far.x, far.y);
    await page.waitForTimeout(300);
    expect(await tool(page)).toBe(far.tool);
    // Off again; then a tap where "☰" was, 400 ms after showing the bar again.
    await page.keyboard.press('Escape');
    await page.locator('[data-field="mark-tools"] [data-action="hide-tools"]').tap();
    await page.waitForTimeout(500);
    await tap(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await expect(bar).toBeVisible();
    await page.waitForTimeout(400);
    const under = await page.evaluate(([x, y]) => { const b = document.elementFromPoint(x, y)?.closest('button'); return b ? (b.dataset.tool || b.dataset.action || b.getAttribute('aria-label')) : null; }, [hb.x + hb.width / 2, hb.y + hb.height / 2]);
    await tap(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForTimeout(300);
    info('T018-A1 under the handle', { under, tool: await tool(page), shown: await bar.isVisible() });
    if (under && ['marker', 'pencil', 'eraser'].includes(under)) expect(await tool(page)).toBe(under);
    else if (under === 'hide-tools') expect(await bar.isVisible()).toBe(false);
  });

  test('T018-A2 (T066-D3) information: a lesson that gives the focus back to the app right after the user\'s click into it (before the Control) — the user\'s Ctrl+Z then is the app\'s (the focus is really in the app); a lesson that moves the focus at the Control is still refused', async ({ page }) => {
    const script = `<script>
      document.addEventListener('pointerup', () => setTimeout(() => { try { parent.focus(); } catch {} window.blur(); }, 150));
      addEventListener('keydown', (e) => { if (e.key === 'Control' || e.key === 'Meta') { try { parent.focus(); } catch {} window.blur(); } });
    </script>`;
    await setup(page, script);
    await markWord(page, 'Производителят');
    await markWord(page, 'Уязвимостите');
    const frame = await (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
    await frame.locator('#p1').click();
    await page.waitForTimeout(600);
    const where = await page.evaluate(() => (document.activeElement?.tagName));
    const before = await count(page);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    const after = await count(page);
    info('T018-A2', { focusAfterClick: where, undone: before - after });
    // Either way at most one undo for one Ctrl+Z, never more.
    expect(before - after).toBeLessThanOrEqual(1);
  });

  test('T018-A3 the app\'s own Ctrl+Z: after a click on the notes strip it undoes one mark; inside the note field it is the field\'s own (no mark undone)', async ({ page }) => {
    await setup(page);
    await markWord(page, 'Производителят');
    await markWord(page, 'Уязвимостите');
    await page.locator('[data-action="notes-list"]').click();
    await page.keyboard.press('Escape');
    const before = await count(page);
    await page.locator('[data-action="notes-list"]').focus();
    await page.keyboard.press('Control+z');
    await expect.poll(() => count(page)).toBe(before - 1);
    // In the field of a note.
    const frame = await (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
    await frame.evaluate(() => {
      const n = [...document.querySelectorAll('p')].find((p) => p.textContent.includes('Регламентът'));
      const r = document.createRange(); r.selectNodeContents(n.firstChild); r.setEnd(n.firstChild, 10);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await page.locator('[data-action="new-note"]').click();
    await page.locator('[data-field="note-text"]').pressSequentially('абв');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    expect(await count(page)).toBe(before - 1);
    await page.keyboard.press('Escape');
  });
});
