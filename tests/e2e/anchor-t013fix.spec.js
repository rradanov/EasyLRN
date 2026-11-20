// T-013-fix (developer, 0.12.1): the anchoring defects of T-014.
// - T014-D3: long quotes after a small edit are found fast, and the anchoring
//   runs in slices, so the app (same process as the lesson) never freezes;
// - T014-D4: a lesson that changes its text all the time does not keep the
//   processor busy, and an orphan whose text comes back (written by the
//   lesson's script) is still found — the search after a change looks around
//   the changed part only;
// - T014-D2: an annotation made by 0.12.0 across a <br> (glued quote) is not
//   lost after the model change: found approximately;
// - T014-D1 and the thresholds are in the unit page (tests/anchor.html).
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push({ ...e.data, t: performance.now() }); });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});
const landscapeOnly = (ti) => test.skip(ti.project.name !== 'tablet-landscape', 'heavy: once is enough');

const C = 'LRN-T13F';
const L1 = `${C}/lesson:0001`;
const page1 = (body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Първи</title></head><body><main><h1>Първи</h1>${body}</main></body></html>`;
const files = (body) => ({ 'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`, 'lessons/0001-parvi.html': page1(body) });
async function importCourse(page, body) {
  const bytes = Object.fromEntries(Object.entries(files(body)).map(([p, v]) => [p, strToU8(v)]));
  const f = asFile(`${C}.zip`, makeZip(bytes, { root: C }));
  return page.evaluate(async ({ name, data }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(data)], name)]));
  }, { name: f.name, data: [...f.buffer] });
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 30000 });
async function open(page) {
  const hash = `#/c/${C}/read/0001`;
  if (new URL(page.url()).hash === hash) await page.reload(); else await page.goto(`./${hash}`);
  await waitReady(page);
}
/** Annotations with the selectors `model` gives for each needle (a model of `html`'s body). */
async function annotate(page, html, needles, { glueBr = false } = {}) {
  return page.evaluate(async ({ html, needles, glueBr, id }) => {
    const db = await import('./src/db.js');
    const A = await import('./src/anchor.js');
    const lesson = await db.getLesson(id);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const model = A.anchorTextModel(doc.body);
    const out = [];
    for (const needle of needles) {
      const at = model.text.indexOf(needle);
      if (at < 0) throw new Error(`not in the model: ${needle}`);
      const selector = A.anchorDescribe(model, at, at + needle.length);
      if (glueBr) selector.quote.exact = selector.quote.exact.replace('ред втори', 'редвтори'); // as 0.12.0 made it
      out.push(await db.createAnnotation({ courseId: lesson.courseId, target: { type: 'lesson', id }, targetVersion: lesson.sha256, selector, color: 'yellow' }));
    }
    return out;
  }, { html, needles, glueBr, id: L1 });
}
const states = (page) => page.evaluate(async (id) => {
  const db = await import('./src/db.js');
  return (await db.annotationsFor({ type: 'lesson', id })).map((a) => a.anchorState);
}, L1);
const anchoredMsgs = (page) => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:anchored'));

const para = (i, w = '') => `<p>Абзац ${i}. Производителят${w} оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${i}, и документира резултата в техническата документация.</p>`;
const body = (w = '', every = 1) => Array.from({ length: 3000 }, (_, i) => para(i, i % every === 0 ? w : '')).join('\n');

test('F1 (T014-D3) 20 passages of 2000 characters + 200 whole paragraphs, all fuzzy after a small edit, at CPU ×4: lrn:anchored < 3 s and the app never freezes (no task over 200 ms while anchoring, over 400 ms while the app shows 220 marks)', async ({ page }, ti) => {
  landscapeOnly(ti);
  test.setTimeout(300000);
  const v1 = body();
  await importCourse(page, v1);
  const needles = await page.evaluate(async (html) => {
    const A = await import('./src/anchor.js');
    const m = A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body);
    const long = Array.from({ length: 20 }, (_, k) => { const s = m.text.indexOf(`Абзац ${k * 140 + 7}.`); return m.text.slice(s, s + 1990).trim(); });
    const whole = Array.from({ length: 200 }, (_, k) => { const s = m.text.indexOf(`Абзац ${k * 15}.`); return m.text.slice(s, m.text.indexOf('документация.', s) + 13); });
    return [...long, ...whole];
  }, page1(v1));
  await annotate(page, page1(v1), needles);
  await importCourse(page, body(' внимателно'));
  await page.goto(`./#/c/${C}`);
  await page.evaluate(() => { window.__lrn = []; });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // Long tasks of the app's process (the lesson frame is in it too: its tasks are
  // "cross-origin-descendant"), recorded from before the lesson opens. Gaps of a
  // timer are no measure here: the CPU throttling of the test pauses the whole
  // renderer now and then, even when no task runs.
  await page.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask' }); });
  await page.evaluate((c) => { location.hash = `#/c/${c}/read/0001`; }, C);
  await waitReady(page);
  await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 120000, intervals: [250] }).toBeGreaterThan(0);
  await page.waitForTimeout(1500); // the app shows the marks (the list to check, the signs)
  const r = await page.evaluate(() => {
    const ready = window.__lrn.find((m) => m.type === 'lrn:ready');
    const a = window.__lrn.find((m) => m.type === 'lrn:anchored');
    const st = {}; for (const x of a.results) st[x.state] = (st[x.state] || 0) + 1;
    // The longest task while the bridge anchored (lrn:ready → lrn:anchored), and after it (the app shows the marks).
    const during = window.__lt.filter(([t]) => t >= ready.t && t <= a.t).reduce((m, [, d]) => Math.max(m, d), 0);
    const after = window.__lt.filter(([t]) => t > a.t).reduce((m, [, d]) => Math.max(m, d), 0);
    return { ms: Math.round(a.t - ready.t), lag: Math.round(during), lagAfter: Math.round(after), states: st };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  test.info().annotations.push({ type: 'F1 CPU ×4', description: JSON.stringify(r) });
  expect(r.states).toEqual({ fuzzy: 220 });
  // 220 at once, every one changed: 1.2–1.8 s measured alone; the limit allows
  // for the other worker of the suite. The PLAN cases (T014-P2b/P3) are < 2 s.
  expect(r.ms).toBeLessThan(3000);
  expect(r.lag).toBeLessThan(200);
  expect(r.lagAfter).toBeLessThan(400);
});

test('F2 (T014-D4) an orphan comes back when the lesson\'s script writes its text later; a clock elsewhere does not re-search it all the time', async ({ page }) => {
  const v1 = '<p id="a">Първият абзац остава същият във всички версии на урока.</p><p id="b">Този абзац ще изчезне и после скриптът ще го върне обратно.</p>';
  await importCourse(page, v1);
  await annotate(page, page1(v1), ['Първият абзац остава същият', 'Този абзац ще изчезне и после скриптът ще го върне']);
  // The new version: the second paragraph is gone; a clock ticks; after 3 s the script writes it back.
  await importCourse(page, `<p id="clock">0</p><p id="a">Първият абзац остава същият във всички версии на урока.</p><p id="b"></p>
    <script>let n = 0; setInterval(() => { document.getElementById('clock').textContent = String(++n); }, 300);
    setTimeout(() => { document.getElementById('b').textContent = 'Този абзац ще изчезне и после скриптът ще го върне обратно.'; }, 3000);</script>`);
  await open(page);
  await expect.poll(() => states(page), { timeout: 8000 }).toEqual(['ok', 'orphan']);
  await expect.poll(() => states(page), { timeout: 15000 }).toEqual(['ok', 'ok']);
  // No runaway: at most one anchoring per tick of the clock.
  const runs = (await anchoredMsgs(page)).length;
  test.info().annotations.push({ type: 'F2 lrn:anchored', description: String(runs) });
  expect(runs).toBeLessThan(40); // a cheap lesson is anchored at every tick; the cost of each is what D4 was about (T014-P4)
  const frame = await (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
  await expect.poll(() => frame.evaluate(() => [...(CSS.highlights.get('lrn-yellow') || [])].length)).toBe(2);
});

test('F3 (T014-D2) an annotation made by 0.12.0 across a <br> (the quote glued: "редвтори") is found approximately, not lost; a new one has the space', async ({ page }) => {
  const v1 = '<p>Нещо преди това. Това е първи ред<br>втори ред на стихотворението, което продължава още малко.</p>';
  await importCourse(page, v1);
  await annotate(page, page1(v1), ['първи ред втори ред на стихотворението'], { glueBr: true });
  await annotate(page, page1(v1), ['Нещо преди това']);
  await open(page);
  await expect.poll(() => states(page), { timeout: 8000 }).toEqual(['fuzzy', 'ok']);
  const quotes = await page.evaluate(async (id) => (await (await import('./src/db.js')).annotationsFor({ type: 'lesson', id })).map((a) => a.selector.quote.exact), L1);
  expect(quotes[0]).toBe('първи редвтори ред на стихотворението'); // the user's selector is never rewritten by the app
});
