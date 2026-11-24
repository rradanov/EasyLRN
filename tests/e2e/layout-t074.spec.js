// T-074 (tester): tests of T-073 (0.15.1) "as an attacker".
// - S: the port of the guard goes once per frame (T072-S1): the frame navigated to a
//   data: / blob: document that runs its own script and says lrn:hello, a legit reload
//   of the lesson while the note is typed (the new frame's guard gets its port and
//   holds the keys), a new lesson; lrn:link / lrn:anchor (T072-S2) right after the user
//   leaves the note field with a click in the app.
// - H: the floating handles ☰ of hidden bars (the addition to D-046): no strip, no
//   row, ≥ 44 px, never over the text of a lesson with no margin (1280×800, 800×1280,
//   1920×1200, 1200×1920, 360×800); forged lrn:size margins.
// Known defects: test.fail(true, 'T074-…'). Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 150000 });
test.use({ trace: 'off' });

let problems;
let external;
let allow;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  allow = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (!problems) return;
  if (problems.length) console.log('PROBLEMS', JSON.stringify(problems.slice(0, 8)));
  expect(problems.filter((p) => !allow.some((r) => r.test(p)))).toEqual([]);
  expect(external).toEqual([]);
});
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value).slice(0, 3000) });

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const C = 'LRN-T74L';
const LONG = Array.from({ length: 30 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
const BODY = '<p id="p1">Регламентът за киберустойчивост се прилага за продукти.</p><p id="p2">Производителят оценява рисковете през жизнения цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>';
const files = (first, second = '<p>Втори урок, само текст.</p>') => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', `${first}${BODY}${LONG}`),
  'lessons/0002-vtori.html': lessonHtml('Втори', second),
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
async function importCourse(page, f) {
  const zip = asFile(`${C}.zip`, makeZip(toBytes(f), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: zip.name, bytes: [...zip.buffer] });
  expect(r).not.toMatch(/^ERROR/);
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page, n = '0001') {
  const hash = `#/c/${C}/read/${n}`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
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
const newNote = (page) => page.locator('[data-action="new-note"]');
const quick = (page) => page.locator('[data-action="new-note-quick"]');
const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const noteStatus = (page) => page.locator('[data-field="note-status"]');
async function openNewNote(page, needle) {
  await select(page, needle);
  if (await newNote(page).isVisible()) await newNote(page).click();
  else await quick(page).click();
  await expect(noteText(page)).toBeFocused();
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// A lesson that logs what it gets: keys / input as "LK:", ports / { off } as "LP:"
// (console lines survive a new document of the frame); `__off` probes the guard.
const SPY = (extra) => `<input id="v1" aria-label="v1"><script>
  Object.defineProperty(window, '__off', { get() { const was = document.designMode; document.designMode = 'on'; const on = document.designMode === 'on'; document.designMode = was; return !on; } });
  const log = (e) => { const d = e.key || e.data || ''; if (e.type === 'input' || e.type === 'compositionend' || e.type === 'paste') console.log('LK:' + d); };
  for (const t of ['keydown', 'input', 'compositionend', 'paste']) document.addEventListener(t, log, true);
  addEventListener('message', (e) => { try { const d = e.data; if (d && /lrn:keys/.test(String(d.type))) console.log('LP:msg:' + d.type); for (const p of (e.ports || [])) { console.log('LP:port:lesson'); p.onmessage = (m) => console.log('LP:off:' + JSON.stringify(m.data)); } } catch (err) { /* */ } }, true);
  window.__steal = () => { const i = document.getElementById('v1'); const t = window.__stealT = setInterval(() => { try { i.focus(); document.designMode = 'on'; if (document.designMode === 'on') console.log('LP:design'); document.designMode = 'off'; } catch (err) { /* */ } }, 5); setTimeout(() => clearInterval(t), 6000); };
  ${extra || ''}
</script>`;
const collect = (page, prefix) => {
  const out = [];
  page.on('console', (m) => { if (m.text().startsWith(prefix)) out.push(m.text().slice(prefix.length)); });
  return out;
};

// The script of a document the lesson builds for itself (data: / blob:): no guard of
// the app in it. It says lrn:hello, listens for ports, steals the focus, logs keys.
const ROGUE = `<input id=v1><script>
addEventListener('message',(e)=>{for(const p of (e.ports||[])){console.log('LP:port:rogue');p.onmessage=(m)=>console.log('LP:off:'+JSON.stringify(m.data));}},true);
for(const t of ['keydown','input','compositionend','paste'])addEventListener(t,(e)=>{if(e.type==='input'||e.type==='compositionend'||e.type==='paste')console.log('LK:'+(e.data||''));},true);
console.log('LP:rogue-doc');
let n=0;const t=setInterval(()=>{try{parent.postMessage({lrn:1,type:'lrn:hello',v:1},'*');parent.postMessage({lrn:1,type:'lrn:ready',v:1,title:'x',textLength:5},'*');document.getElementById('v1').focus();}catch(e){}if(++n>200)clearInterval(t);},10);
</script>`;
// Inside the lesson's own <script>: "</" written as "<\u002f" (else it would end that script).
const inScript = (html) => JSON.stringify(html).replace(/<\//g, '<\\u002f');

test.describe('T074-S the port of the guard once per frame (T072-S1 fix)', () => {
  const NAVS = [
    ['data: URL with its own script', `() => { location.href = 'data:text/html;charset=utf-8,' + encodeURIComponent(${inScript(ROGUE)}); }`],
    ['blob: URL made by the lesson', `() => { location.href = URL.createObjectURL(new Blob([${inScript(ROGUE)}], { type: 'text/html' })); }`],
  ];
  for (const [name, code] of NAVS) {
    test(`T074-S3 the frame goes to a ${name} while the note is typed (a document without the app's guard, before its load event): it never gets a port or { off }, no character reaches it, the note keeps every character`, async ({ page }) => {
      allow.push(/Failed to load resource|lesson|Урокът|Content Security Policy|Not allowed/i);
      const leaked = collect(page, 'LK:');
      const got = collect(page, 'LP:');
      await start(page);
      await importCourse(page, files(SPY(`setInterval(() => { if (window.__off && !window.__went) { window.__went = true; console.log('LP:go'); setTimeout(${code}, 150); } }, 20);`)));
      await openLesson(page);
      await openNewNote(page, 'оценява рисковете');
      for (let i = 0; i < 4; i++) { await page.keyboard.type(`ТАЙНА${i}secret`, { delay: 30 }); await page.waitForTimeout(100); }
      await page.waitForTimeout(800);
      const value = await noteText(page).inputValue().catch(() => null);
      const state = await page.evaluate(() => ({ st: document.querySelector('[data-lesson-state]')?.dataset.lessonState, stopped: document.querySelector('[data-lesson-stopped]')?.dataset.lessonStopped ?? null, frames: document.querySelectorAll('iframe.lesson-frame').length }));
      info('T074-S3', { name, got: [...new Set(got)], leaked: leaked.join(''), value, state });
      expect(got).toContain('go');
      expect(got.filter((g) => /^(port|off|design)/.test(g))).toEqual([]);
      expect(leaked.join('')).toBe('');
      expect(value).toBe(Array.from({ length: 4 }, (_, i) => `ТАЙНА${i}secret`).join(''));
    });
  }

  test('T074-S4 a legit new load: the lesson reloads itself while the note is typed → a new frame; its guard gets its own port at once and holds the keys (designMode refused) for as long as the field is focused, and lets go when the note is closed; an earlier document never gets the new port; a new lesson (0002) gets its own port too', async ({ page }) => {
    allow.push(/Failed to load resource|lesson|Урокът/i);
    const leaked = collect(page, 'LK:');
    const got = collect(page, 'LP:');
    await start(page);
    await importCourse(page, files(SPY(''), `${SPY('')}<p>Втори урок, само текст.</p>`));
    let frame = await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    await page.keyboard.type('преди', { delay: 30 });
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(true);
    const before = await page.locator('iframe.lesson-frame').elementHandle();
    await frame.evaluate(() => setTimeout(() => location.reload(), 50));
    // A new frame (reloadAfterNavigation) comes; the note field keeps the focus.
    await expect.poll(async () => {
      const now = await page.locator('iframe.lesson-frame').elementHandle().catch(() => null);
      return !!now && !(await now.evaluate((a, b) => a === b, before));
    }, { timeout: 15000 }).toBe(true);
    await waitReady(page);
    frame = await lessonFrame(page);
    // The keys may go back to the field: the user taps it again if the reload took the focus.
    if (!(await noteText(page).evaluate((t) => t === document.activeElement))) await noteText(page).click();
    await expect(noteText(page)).toBeFocused();
    const probes = [];
    for (let i = 0; i < 8; i++) { probes.push(await frame.evaluate(() => window.__off)); await page.keyboard.type(`д${i}`, { delay: 20 }); }
    await frame.evaluate(() => window.__steal());
    await page.keyboard.type('ТАЙНАслед', { delay: 30 });
    await page.waitForTimeout(300);
    const value = await noteText(page).inputValue();
    await frame.evaluate(() => clearInterval(window.__stealT));
    await page.waitForTimeout(50);
    const stolen = got.filter((g) => /^(port|off|design|msg)/.test(g));
    // Closing the note lets the guard go: the lesson is usable again.
    await page.locator('[data-action="note-done"]').click().catch(async () => { await page.keyboard.press('Escape'); });
    await expect(panel(page)).toBeHidden();
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(false);
    // A new lesson: its own port.
    const f2 = await openLesson(page, '0002');
    await f2.evaluate(() => { const p = document.createElement('p'); p.textContent = 'Текст за бележка във втория урок.'; document.querySelector('main').append(p); });
    await page.waitForTimeout(300);
    await openNewNote(page, 'Втори урок, само');
    await expect.poll(() => f2.evaluate(() => window.__off)).toBe(true);
    await page.keyboard.type('втори', { delay: 30 });
    info('T074-S4', { probes, got: [...new Set(got)], leaked: leaked.join(''), value });
    expect(probes.every(Boolean), 'the guard of the new frame holds the keys at every probe').toBe(true);
    expect(stolen).toEqual([]);
    expect(leaked.join('')).toBe('');
    expect(value).toBe(`преди${Array.from({ length: 8 }, (_, i) => `д${i}`).join('')}ТАЙНАслед`);
  });

  test('T074-S1 lrn:link right after the user leaves the note with a click in the app ("Готово" / ✕): the click is a user activation of the APP, not of the lesson — a lesson that sends lrn:link to another lesson every 40 ms takes the app there although the user never touched the lesson', async ({ page }) => {
    allow.push(/EasyLRN|lesson|Урок/i);
    await start(page);
    await importCourse(page, files(SPY(`setInterval(() => { if (window.__armed) parent.postMessage({ lrn: 1, type: 'lrn:link', href: new URL('0002-vtori.html', location.href).href }, '*'); }, 40);
      setInterval(() => { if (window.__armed) parent.postMessage({ lrn: 1, type: 'lrn:anchor', top: 900 }, '*'); }, 40);`)));
    const frame = await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    await page.keyboard.type('Бележка', { delay: 20 });
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    await frame.evaluate(() => { window.__armed = true; });
    await page.waitForTimeout(400);
    const during = page.url();
    expect(during).toContain('/read/0001'); // ignored while the field is guarded (T072-S2 fix)
    await page.locator('[data-action="note-done"]').click();
    await page.waitForTimeout(1200);
    const after = page.url();
    await frame.evaluate(() => { window.__armed = false; }).catch(() => {});
    info('T074-S1', { during, after });
    const moved = !after.includes('/read/0001');
    test.fail(moved, 'T074-S1: lrn:link / lrn:anchor need only navigator.userActivation of the APP; a click on the app\'s own buttons ("Готово", ✕, ▲▼, a tool) right after the note field is left is such an activation, so a lesson that keeps sending lrn:link (it knows when the note is typed: T072-I1) takes the app to another lesson of the course the moment the user closes the note — the gesture should be one in the lesson (e.g. the last pointerdown was on the frame)');
    expect(moved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
const NOMARGIN = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Без поле</title><style>html,body{margin:0;padding:0}p,h1{margin:0 0 8px 0}</style></head><body>
<h1>Без поле</h1>${Array.from({ length: 40 }, (_, i) => `<p>Ред ${i}: текстът започва от самия ръб на урока и стига до другия му ръб без никакво поле, за да се види дали дръжките не закриват думи от урока.</p>`).join('')}</body></html>`;
const CENTER = lessonHtml('Центриран', `<style>main{max-width:38rem;margin:0 auto}</style>${BODY}${LONG}`);
const boxes = (page) => page.evaluate(() => {
  const b = (sel) => {
    const e = document.querySelector(sel);
    if (!e || !e.getClientRects().length) return null;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const reader = document.querySelector('[data-screen="reader"]');
  return {
    layout: reader?.dataset.layout, vw: document.documentElement.clientWidth, vh: window.innerHeight,
    appBar: b('.app-bar'), frame: b('iframe.lesson-frame'), topbar: b('[data-field="reader-topbar"]'), tools: b('[data-field="mark-tools"]'),
    toolsHandle: b('[data-field="mark-tools-handle"]'), notesBar: b('.notes-strip__bar'), notesHandle: b('[data-field="notes-strip-handle"]'), strip: b('[data-field="notes-strip"]'),
    gutter: [reader?.querySelector('[data-gutter-left]')?.dataset.gutterLeft ?? reader?.dataset.gutterLeft ?? null, reader?.querySelector('[data-gutter-right]')?.dataset.gutterRight ?? reader?.dataset.gutterRight ?? null],
  };
});
async function textEdges(page) {
  const f = await lessonFrame(page);
  const t = await f.evaluate(() => {
    let left = Infinity; let right = -Infinity;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const r = document.createRange();
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!/\S/.test(n.data)) continue; r.selectNodeContents(n); for (const b of r.getClientRects()) { if (b.width > 0) { left = Math.min(left, b.left); right = Math.max(right, b.right); } } }
    return { left, right };
  });
  const fb = await page.locator('iframe.lesson-frame').boundingBox();
  return { left: fb.x + t.left, right: fb.x + t.right };
}
async function hideBoth(page) {
  const ht = page.locator('[data-action="hide-tools"]');
  if (await ht.isVisible()) await ht.click();
  const hn = page.locator('[data-action="hide-notes"]');
  if (await hn.isVisible()) await hn.click();
  await page.waitForTimeout(900);
}

test.describe('T074-H the floating handles of hidden bars (the addition to D-046)', () => {
  test.beforeEach(({}, ti) => { test.skip(ti.project.name !== 'tablet-landscape', 'the sizes are set in the test'); });
  for (const [w, hgt] of [[1280, 800], [800, 1280], [1920, 1200], [1200, 1920], [360, 800]]) {
    test(`T074-H1 ${w}×${hgt}: both bars hidden — no strip and no row, the handles are ≥ 44 px and never over the text of a lesson with NO margin (text from edge to edge) nor of a centred lesson; no side scroll; they bring the bars back`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: hgt });
      await start(page);
      await importCourse(page, { ...files(''), 'lessons/0001-parvi.html': NOMARGIN, 'lessons/0002-vtori.html': CENTER });
      await openLesson(page);
      const shown = await boxes(page);
      await hideBoth(page);
      const out = [];
      for (const n of ['0001', '0002']) {
        if (n === '0002') await openLesson(page, '0002');
        await page.waitForTimeout(900);
        const x = await boxes(page);
        const t = await textEdges(page);
        out.push({ n, x, t });
        expect(x.tools, `${n} tools`).toBeNull();
        expect(x.notesBar, `${n} notes bar`).toBeNull();
        const handles = ['toolsHandle', ...(x.notesHandle ? ['notesHandle'] : [])];
        for (const h of handles) {
          expect(x[h], `${n} ${h}`).not.toBeNull();
          expect(x[h].width, `${n} ${h} width`).toBeGreaterThanOrEqual(44);
          expect(x[h].height, `${n} ${h} height`).toBeGreaterThanOrEqual(44);
        }
        expect(t.left, `${n}: the text starts right of the tools handle`).toBeGreaterThanOrEqual(x.toolsHandle.right - 0.5);
        if (x.notesHandle) expect(t.right, `${n}: the text ends left of the notes handle`).toBeLessThanOrEqual(x.notesHandle.left + 0.5);
        expect(await noSideScroll(page), `${n} side scroll`).toBe(true);
        if (x.layout === 'portrait') expect(x.topbar === null || x.topbar.height <= 1, `${n}: no row`).toBe(true);
        if (x.layout === 'landscape') {
          // No strip: the frame reaches under the handle (the handle floats over the lesson's column).
          // (a lesson with no margin is moved by the room made for the handle: then it starts just beside it)
          expect(x.frame.left, `${n}: no strip at the left`).toBeLessThanOrEqual(x.toolsHandle.right + 8);
          if (x.notesHandle) expect(x.frame.right, `${n}: no strip at the right`).toBeGreaterThanOrEqual(x.notesHandle.left - 8);
          if (n === '0002') expect(x.frame.left, `${n}: a centred lesson needs no room`).toBeLessThanOrEqual(x.toolsHandle.right);
        }
        // The room made for the handles is never more than 96 px.
        for (const g of x.gutter) if (g !== null) expect(Number(g)).toBeLessThanOrEqual(96);
      }
      info('T074-H1', { size: `${w}×${hgt}`, layout: out[0].x.layout, shownFrame: shown.frame, out: out.map((o) => ({ n: o.n, frame: [o.x.frame.left, o.x.frame.right], text: [o.t.left, o.t.right], th: o.x.toolsHandle && [o.x.toolsHandle.left, o.x.toolsHandle.right, o.x.toolsHandle.top], nh: o.x.notesHandle && [o.x.notesHandle.left, o.x.notesHandle.right], gutter: o.x.gutter })) });
      // The handles bring the bars back.
      await page.locator('[data-field="mark-tools-handle"]').click();
      await expect(page.locator('[data-field="mark-tools"]')).toBeVisible();
      const nh = page.locator('[data-field="notes-strip-handle"]');
      if (await nh.isVisible()) { await nh.click(); await expect(page.locator('[data-action="hide-notes"]').first()).toBeVisible(); }
    });
  }

  test('T074-H2 forged margins: the lesson sends lrn:size with left / right 0, 4000, 99999, negative, strings, and alternates 0 / 4000 every 30 ms for 2 s — the room made is never over 96 px, no side scroll, nothing breaks; after it stops the reader settles', async ({ page }) => {
    allow.push(/EasyLRN|lesson/i);
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page);
    const FLOOD = `<script>
      window.__flood = () => { let i = 0; const t = setInterval(() => { const h = document.documentElement.scrollHeight; const v = [[0, 0], [4000, 4000], [99999, 99999], [-5, -5], ['x', 'y'], [0, 4000]][i % 6]; parent.postMessage({ lrn: 1, type: 'lrn:size', height: h, left: v[0], right: v[1] }, '*'); if (++i > 66) clearInterval(t); }, 30); };
    </script>`;
    await importCourse(page, { ...files(''), 'lessons/0001-parvi.html': NOMARGIN.replace('</body>', `${FLOOD}</body>`) });
    const frame = await openLesson(page);
    await hideBoth(page);
    const g = [];
    const watch = setInterval(async () => { try { g.push((await boxes(page)).gutter); } catch { /* */ } }, 100);
    await frame.evaluate(() => window.__flood());
    await page.waitForTimeout(2400);
    clearInterval(watch);
    await page.waitForTimeout(1500);
    const x = await boxes(page);
    info('T074-H2', { samples: g.slice(0, 30), end: x.gutter });
    for (const s of g) for (const v of s) if (v !== null) expect(Number(v)).toBeLessThanOrEqual(96);
    expect(await noSideScroll(page)).toBe(true);
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
  });
});
