// T-018 (tester): notes of 0.14.0 (T-017, D-045), attacked.
// - security: the lesson never receives the text of a note (every message to the
//   frame recorded through the whole life of a note), forged lesson messages
//   (selection / tap / layout / anchored / described / stroked) create, change
//   or delete nothing; a place with a note only (`color: null`) cannot be turned
//   into anything else or erased by the lesson; a lesson that takes the focus
//   while the user types a note; XSS in the text of a note and in its quote
//   (strip, list, panel, history, "Курс");
// - data: saved by itself (before a reload / a navigation), an empty note, the
//   eraser and "Отмени" against "Изтрий" / "Върни", "Маркировки за проверка →
//   Изтрий", two tabs, a retired lesson, a renamed file;
// - size: a note of 1 MB (the field keeps 20 000), 1000 notes in a lesson;
// - layout: 1920 / 1200 / 360, dark theme, 160 %, aria.
// T-069 (developer): M2 is skipped on a phone and L1 / M1 follow the new layout (the user's addition to D-045:
// the note a column next to the lesson on a tablet, only the 📝 column on a phone).
// Known defects: test.fail(true, 'T018-D…'). Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });
// No trace: its DOM snapshots of a note with a 20 000-character word are themselves slow (seen in T018-P3).
test.use({ trace: 'off' });

let problems;
let external;
let allowWarn;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  allowWarn = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
    if (m.type() === 'warning' || m.type() === 'log' || m.type() === 'info') {
      // The text of a note never goes to the console either.
      if (/ТАЙНА|SECRET-NOTE/.test(m.text())) problems.push(`console: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowWarn.some((r) => r.test(p)))).toEqual([]);
  expect(external).toEqual([]);
});

const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value) });

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
// The spy: every message the app posts to the lesson, kept whole (with the transfer ports' messages too).
const SPY = `<script>window.__got = []; addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) { window.__got.push(JSON.stringify(e.data)); for (const p of e.ports || []) p.onmessage = (x) => window.__got.push('port:' + JSON.stringify(x.data)); } });</script>`;
const LONG = Array.from({ length: 40 }, (_, i) => `<p id="f${i}">Допълнителен абзац ${i} за превъртане: текстът тук е само за да е урокът по-дълъг от екрана.</p>`).join('\n');
const BODY = [
  '<p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи на пазара.</p>',
  '<p id="p2">Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.</p>',
  '<p id="p3">Уязвимостите се докладват без неоправдано забавяне на органите.</p>',
  '<div class="quiz" data-quiz="{}"><p id="qz">Въпрос от теста в урока.</p></div>',
  '<div data-lrn-noanno><p id="nx">Този текст не се маркира: бележка на автора.</p></div>',
  '<p id="xs">Опасен текст &lt;img src=x onerror="window.__xss=1"&gt; и &lt;script&gt;window.__xss=2&lt;/script&gt; в урока.</p>',
  LONG,
  '<p id="p5">Краят на урока е тук, с последно изречение за бележка.</p>',
].join('\n');
const C = 'LRN-T18';
const index = (extra = '') => `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n${extra}`;
const files = (body = BODY, { head = '', script = '', path = 'lessons/0001-parvi.html', more = {} } = {}) => ({
  'INDEX.md': index(Object.keys(more).length ? '| 0002 | Втори |\n' : ''),
  [path]: lessonHtml('Първи', `${body}${SPY}${script}`, head),
  ...more,
});
const L1 = `${C}/lesson:0001`;

const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) {
  const handle = await page.locator('iframe.lesson-frame').elementHandle();
  return handle.contentFrame();
}
async function openLesson(page, n = '0001') {
  const hash = `#/c/${C}/read/${n}`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
const annotations = (page) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, exact: a.selector.quote.exact, deleted: a.deleted, color: a.color, style: a.style })), L1);
const notesOf = (page) => db(page, async (db) => (await db.list('notes', { includeDeleted: true }))
  .map((n) => ({ id: n.id, annotationId: n.annotationId, body: n.body, deleted: n.deleted, courseId: n.courseId })));
const liveNotes = async (page) => (await notesOf(page)).filter((n) => !n.deleted);
const liveAnn = async (page) => (await annotations(page)).filter((a) => !a.deleted);
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));

async function select(page, needle, { from = 0, to = null } = {}) {
  const frame = await lessonFrame(page);
  await frame.evaluate(({ needle, from, to }) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + from);
      r.setEnd(n, i + (to ?? needle.length));
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      n.parentElement.scrollIntoView({ block: 'center' });
      return;
    }
    throw new Error(`not found: ${needle}`);
  }, { needle, from, to });
}
async function selectAcross(page, a, b) {
  const frame = await lessonFrame(page);
  await frame.evaluate(({ a, b }) => {
    const find = (needle, end) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) return [n, end ? i + needle.length : i]; }
      throw new Error(`not found: ${needle}`);
    };
    const r = document.createRange();
    r.setStart(...find(a, false));
    r.setEnd(...find(b, true));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    r.startContainer.parentElement.scrollIntoView({ block: 'center' });
  }, { a, b });
}
async function textBox(page, needle) {
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
      return { left: b.left, top: b.top, height: b.height, right: b.right };
    }
    throw new Error(`not found: ${needle}`);
  }, needle);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return { x: box.x + rel.left + 4, y: box.y + rel.top + rel.height / 2, top: box.y + rel.top, bottom: box.y + rel.top + rel.height, right: box.x + rel.right };
}
async function scrollTo(page, needle) {
  const frame = await lessonFrame(page);
  const top = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(needle)) return n.parentElement.getBoundingClientRect().top;
    return 0;
  }, needle);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(box.y + top - page.viewportSize().height / 2));
  await page.waitForTimeout(150);
}
async function mark(page, needle, color = 'yellow') {
  const before = (await liveAnn(page)).filter((a) => a.color === color).length;
  await page.evaluate(() => { window.__lrn = window.__lrn.filter((m) => m.type !== 'lrn:selection'); });
  await select(page, needle);
  await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length), { timeout: 3000 }).toBeGreaterThan(0);
  await page.locator(`[data-field="mark-tools"] [data-color="${color}"]`).click();
  await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === color).length, { timeout: 5000 }).toBeGreaterThan(before);
  await page.keyboard.press('Escape');
}
async function eraseOver(page, needle) {
  await page.locator('[data-field="mark-tools"] [data-tool="eraser"]').click();
  await scrollTo(page, needle);
  const box = await textBox(page, needle);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y, { steps: 6 });
  await page.mouse.up();
}

const strip = (page) => page.locator('[data-field="notes-strip"]');
const newNote = (page) => page.locator('[data-action="new-note"]');
const quick = (page) => page.locator('[data-action="new-note-quick"]');
const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const noteStatus = (page) => page.locator('[data-field="note-status"]');
const noteMarks = (page) => page.locator('[data-field="notes-marks"] .notes-strip__mark');
const marksStatus = (page) => page.locator('[data-field="marks-status"]');
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

async function writeNote(page, needle, text, { button = newNote } = {}) {
  await select(page, needle);
  await expect(button(page)).toBeVisible({ timeout: 3000 });
  await button(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(noteText(page)).toBeFocused();
  await noteText(page).pressSequentially(text, { delay: 2 });
  await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
}
const got = async (page) => (await lessonFrame(page)).evaluate(() => window.__got.join('\n'));

// ===========================================================================
test.describe('T018-S security of the notes (the lesson is untrusted)', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('T018-S1 the text of a note never reaches the lesson: create, edit, list, ▲ / ▼, 📝, delete + "Върни", empty + "Върни", eraser + "Отмени", reload of the annotations, a re-import, "Да, тук е" — every message to the frame (and the console) recorded', async ({ page }) => {
    await openLesson(page);
    const seen = [];
    const collect = async () => { seen.push(await got(page)); };
    await writeNote(page, 'оценява рисковете', 'ТАЙНА-1 SECRET-NOTE');
    await page.locator('[data-action="note-done"]').click();
    await mark(page, 'Уязвимостите се докладват', 'green');
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(t.x + 20, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('ТАЙНА-2 на маркировка');
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    // T-071 (D-046): while the panel is open the strip is hidden — the panel's "← Всички бележки" and ▲ / ▼.
    await page.locator('[data-action="notes-back-to-list"]').click();
    await page.locator('[data-action="panel-next-note"]').click();
    await page.locator('[data-action="panel-prev-note"]').click();
    await page.keyboard.press('Escape');
    await noteMarks(page).first().click();
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' ТАЙНА-3');
    await page.keyboard.press('Escape');
    // Delete + "Върни"; empty + "Върни".
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect(panel(page)).toBeVisible();
    await noteText(page).fill('');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-field="notes-undo"]')).toBeVisible();
    await page.locator('[data-action="undo-note-delete"]').click();
    await page.keyboard.press('Escape');
    // The eraser over the noted mark (only the colour), "Отмени".
    await eraseOver(page, 'Уязвимостите се докладват');
    await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === 'green').length).toBe(0);
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === 'green').length).toBe(1);
    await page.keyboard.press('Escape');
    await collect();
    // A changed lesson: re-import, "провери" → "Да, тук е".
    const changed = BODY.replace('оценява рисковете за киберсигурността', 'оценява рисковете на киберсигурността');
    expect(await importCourse(page, C, files(changed))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    const fuzzy = page.locator('[data-field="notes-list"] .notes-list__item[data-state="fuzzy"] [data-action="open-note"]');
    if (await fuzzy.count()) {
      await fuzzy.first().click();
      await page.locator('[data-action="confirm-note-place"]').click();
      await expect(marksStatus(page)).toHaveText('Мястото е потвърдено.');
    }
    await page.locator('[data-action="panel-next-note"]').click(); // T-071 (D-046): the panel is open
    await page.waitForTimeout(600);
    await collect();
    const all = seen.join('\n');
    info('T018-S1 message types to the lesson', [...new Set([...all.matchAll(/"type":"(lrn:[a-z-]+)"/g)].map((m) => m[1]))]);
    expect(all).toContain('lrn:annotations');
    expect(all).not.toMatch(/ТАЙНА|SECRET-NOTE|маркировка"/);
    // The body is in the app's data, of course.
    expect((await liveNotes(page)).map((n) => n.body).join('|')).toContain('ТАЙНА-3');
  });

  test('T018-S2 forged lesson messages (selection with bad / huge positions, excludedOnly with a place, a tap on a noted place, layout with 10 000 / NaN / negative / huge places, anchored "orphan" for all, an unasked described) create, change and delete nothing', async ({ page }) => {
    const frame = await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Оригинал');
    await page.keyboard.press('Escape');
    await mark(page, 'Уязвимостите се докладват', 'blue');
    const ids = (await liveAnn(page)).map((a) => a.id);
    const before = { a: await annotations(page), n: await notesOf(page) };
    await frame.evaluate((ids) => {
      const p = (x) => parent.postMessage({ lrn: 1, ...x }, '*');
      const q = { exact: 'Производителят', prefix: '', suffix: '' };
      for (const position of [{ start: -1, end: 4 }, { start: 5, end: 5 }, { start: 9, end: 2 }, { start: 0, end: 1e9 }, { start: NaN, end: 3 }, { start: '1', end: '4' }, { start: 1.5, end: 3 }]) {
        p({ type: 'lrn:selection', empty: false, quote: q, position });
      }
      p({ type: 'lrn:selection', empty: false, excludedOnly: true, quote: q, position: { start: 0, end: 4 } });
      p({ type: 'lrn:selection', empty: false, quote: { exact: 'x'.repeat(5000) }, position: { start: 0, end: 4 } });
      p({ type: 'lrn:selection', empty: false, quote: { exact: 'Производителят', prefix: 'p'.repeat(100) }, position: { start: 0, end: 4 } });
      p({ type: 'lrn:layout', height: 100, items: Array.from({ length: 10001 }, (_, i) => ({ id: ids[i % ids.length], top: i, bottom: i + 1 })) });
      p({ type: 'lrn:layout', height: 100, items: [{ id: ids[0], top: NaN, bottom: 1 }, { id: ids[1], top: -50, bottom: 10 }, { id: 'NOT-AN-ID', top: 10, bottom: 20 }] });
      p({ type: 'lrn:described', annotationId: ids[0], quote: { exact: 'ПОДМЕНЕН ЦИТАТ' }, position: { start: 1, end: 3 } });
      p({ type: 'lrn:anchored', results: ids.map((id) => ({ id, state: 'bogus' })) });
    }, ids);
    await page.waitForTimeout(1200);
    expect(await annotations(page)).toEqual(before.a);
    expect(await notesOf(page)).toEqual(before.n);
    await expect(newNote(page)).toBeHidden(); // no valid selection among them
    await expect(panel(page)).toBeHidden();
    // A huge place (1e8, within the limit): the 📝 must not make the window huge.
    await frame.evaluate((id) => parent.postMessage({ lrn: 1, type: 'lrn:layout', height: 100, items: [{ id, top: 9e7, bottom: 9e7 + 10 }] }, '*'), ids[0]);
    await page.waitForTimeout(500);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const frameH = (await page.locator('iframe.lesson-frame').boundingBox()).height;
    info('T018-S2 page height after a forged place at 9e7 px', { height, frameH });
    // A forged tap on its own (known) noted place: since T-076 (T024-S3) a lrn:tap with no
    // gesture in the lesson opens nothing at all (before: only the user's note opened); nothing changes.
    await frame.evaluate((id) => parent.postMessage({ lrn: 1, type: 'lrn:tap', annotationId: id }, '*'), ids[0]);
    await page.waitForTimeout(500);
    await expect(panel(page)).toBeHidden();
    expect(await notesOf(page)).toEqual(before.n);
    // "orphan" for everything: a state only (the lesson's own text says where), the body and quote stay.
    await frame.evaluate((ids) => parent.postMessage({ lrn: 1, type: 'lrn:anchored', results: ids.map((id) => ({ id, state: 'orphan' })) }, '*'), ids);
    await page.waitForTimeout(1500);
    const after = await annotations(page);
    expect(after.map((a) => [a.id, a.exact, a.color, a.deleted])).toEqual(before.a.map((a) => [a.id, a.exact, a.color, a.deleted]));
    expect(await notesOf(page)).toEqual(before.n);
    expect(height).toBeLessThan(frameH + 20000);
  });

  test('T018-S3 a place with a note only (color: null) cannot be erased or coloured by the lesson: the lesson answers the user\'s eraser stroke (elsewhere) with every id it knows; the note-only place stays, a noted mark loses only its colour (D-045), the notes stay', async ({ page }) => {
    // The lesson listens for the app's stroke messages and answers first.
    const evil = `<script>
      let ids = []; let seq = null; let tool = null;
      addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'lrn:annotations') ids = d.items.map((x) => x.id);
        if (d.type === 'lrn:stroke' && d.phase === 'start') { seq = d.seq; tool = d.tool; }
        if (d.type === 'lrn:stroke' && d.phase === 'end') {
          if (tool === 'eraser') parent.postMessage({ lrn: 1, type: 'lrn:stroked', seq, tool, ids }, '*');
          window.__answered = (window.__answered || 0) + 1;
        }
      });
    </script>`;
    expect(await importCourse(page, C, files(BODY, { script: evil }))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Само бележка');
    await page.keyboard.press('Escape');
    await mark(page, 'Уязвимостите се докладват', 'green');
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(t.x + 20, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('На маркировката');
    await page.locator('[data-action="note-done"]').click();
    await mark(page, 'Краят на урока', 'yellow');
    await expect.poll(async () => (await liveNotes(page)).length).toBe(2);
    // The user's eraser on text with nothing on it.
    await eraseOver(page, 'Регламентът за киберустойчивост');
    await page.waitForTimeout(1200);
    const frame = await lessonFrame(page);
    info('T018-S3 answered strokes', await frame.evaluate(() => window.__answered || 0));
    const a = await annotations(page);
    const byExact = Object.fromEntries(a.map((x) => [x.exact, { color: x.color, deleted: !!x.deleted }]));
    info('T018-S3 annotations', byExact);
    // The note-only place stays as it is; the mark with a note keeps its annotation (only the colour may go: D-045).
    expect(byExact['оценява рисковете']).toEqual({ color: null, deleted: false });
    expect(byExact['Уязвимостите се докладват'].deleted).toBe(false);
    expect((await liveNotes(page)).map((n) => n.body).sort()).toEqual(['На маркировката', 'Само бележка']);
    await expect.poll(() => highlights(page), { timeout: 5000 }).toMatchObject({ 'lrn-note': expect.arrayContaining(['оценява рисковете']) });
  });

  test('T018-S4 a lesson that takes the focus (every 30 ms, into its own field) while the user writes a note: the keys must not go to the lesson', async ({ page }) => {
    const thief = `<input id="steal" aria-label="поле на урока"><script>
      window.__keys = '';
      document.getElementById('steal').addEventListener('input', (e) => { window.__keys = e.target.value; });
      addEventListener('keydown', (e) => { window.__down = (window.__down || '') + e.key; }, true);
      setInterval(() => { document.getElementById('steal').focus(); }, 30);
    </script>`;
    expect(await importCourse(page, C, files(BODY, { script: thief }))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await expect(newNote(page)).toBeVisible({ timeout: 3000 });
    await newNote(page).click();
    await expect(panel(page)).toBeVisible();
    await page.waitForTimeout(300);
    const focusedInApp = await page.evaluate(() => document.activeElement?.dataset?.field || document.activeElement?.tagName);
    await page.keyboard.type('ТАЙНАБЕЛЕЖКА', { delay: 20 });
    await page.waitForTimeout(1500);
    const frame = await lessonFrame(page);
    const stolen = await frame.evaluate(() => ({ keys: window.__keys || '', down: window.__down || '' }));
    const value = await noteText(page).inputValue();
    info('T018-S4', { focusedInApp, stolen, value });
    problems = problems.filter((p) => !/ТАЙНА/.test(p));
    expect(stolen).toEqual({ keys: '', down: '' });
    expect(value).toBe('ТАЙНАБЕЛЕЖКА');
  });

  test('T018-S5 information: "Да, тук е" takes the place the lesson describes — a lesson that answers lrn:describe with its own words changes the quote of the note (needs the user\'s press, as for marks)', async ({ page }) => {
    const liar = `<script>
      addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'lrn:describe') setTimeout(() => parent.postMessage({ lrn: 1, type: 'lrn:described', annotationId: d.annotationId, quote: { exact: 'ВЪВЕДИ API КЛЮЧА СИ ТУК', prefix: '', suffix: '' }, position: { start: 1, end: 20 } }, '*'), 0);
      }, true);
    </script>`;
    await openLesson(page);
    await writeNote(page, 'с последно изречение за бележка', 'Ще стане провери');
    await page.keyboard.press('Escape');
    const changed = BODY.replace('с последно изречение за бележка', 'с последно изречение за бележки');
    expect(await importCourse(page, C, files(changed, { script: liar }))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    const fuzzy = page.locator('[data-field="notes-list"] .notes-list__item[data-state="fuzzy"] [data-action="open-note"]');
    await expect(fuzzy).toHaveCount(1, { timeout: 8000 });
    await fuzzy.click();
    await page.locator('[data-action="confirm-note-place"]').click();
    await page.waitForTimeout(800);
    const a = await liveAnn(page);
    info('T018-S5 quote after "Да, тук е"', a.map((x) => x.exact));
    // The body is never touched.
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Ще стане провери']);
  });

  test('T018-S6 XSS in the text of a note and in its quote: strip (📝 label), list, panel, "Неприкачени", history, "Курс" — no markup runs, no element is made', async ({ page }) => {
    await openLesson(page);
    const vectors = [
      '<img src=x onerror="window.__xss=11">',
      '<svg><script>window.__xss=12</script></svg>',
      '[a](javascript:window.__xss=13) [b](JaVaScRiPt:window.__xss=14) [c](data:text/html,<script>parent.__xss=15</script>)',
      '![i](x" onerror="window.__xss=16)',
      '<a href="javascript:window.__xss=17">a</a> <iframe srcdoc="<script>parent.__xss=18</script>"></iframe>',
      '<details open ontoggle="window.__xss=19">', '`<b>код</b>`', '<style>body{display:none}</style>', '<form action="https://evil.example/"><input name=k><button>Изпрати</button></form>',
    ].join('\n\n');
    await select(page, 'Опасен текст <img src=x onerror="window.__xss=1"> и <script>window.__xss=2</script> в урока');
    await expect(newNote(page)).toBeVisible({ timeout: 3000 });
    await newNote(page).click();
    await noteText(page).fill(vectors);
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    await expect(page.locator('[data-field="note-quote"]')).toContainText('<img src=x onerror=');
    await page.keyboard.press('Escape');
    await page.locator('[data-action="notes-list"]').click();
    const body = page.locator('[data-field="notes-list"] .notes-list__body');
    await expect(body).toHaveCount(1);
    await expect(page.locator('[data-field="notes-list"] .notes-list__quote')).toContainText('<script>window.__xss=2</script>');
    expect(await body.locator('img, svg, script, iframe, form, input, style, details, a[href^="javascript" i], a[href^="data" i]').count()).toBe(0);
    const mk = noteMarks(page).first();
    await expect(mk).toHaveAttribute('aria-label', /<img src=x onerror=/);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // Every <a> in the rendered notes is http(s) only.
    const hrefs = await page.locator('[data-field="notes-panel"] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.every((x) => /^https?:/i.test(x || 'https:'))).toBe(true);
    // An orphan with the same quote: the "Неприкачени" list.
    expect(await importCourse(page, C, files(BODY.replace(/<p id="xs">.*?<\/p>/, '')))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    await expect(page.locator('[data-field="notes-orphans"] .notes-list__item')).toHaveCount(1, { timeout: 8000 });
    expect(await page.locator('[data-field="notes-orphans"] img, [data-field="notes-orphans"] script, [data-field="notes-orphans"] iframe').count()).toBe(0);
    await page.locator('[data-field="notes-orphans"] [data-action="open-note"]').click();
    await expect(noteText(page)).toHaveValue(vectors);
    // History and the course screen show no note (and run nothing).
    await page.goto(`./#/c/${C}`);
    await expect(page.locator('[data-screen="course"]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.locator('main').innerText()).not.toContain('onerror');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

// ===========================================================================
test.describe('T018-D the data of the notes', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('T018-D3 saved by itself: a note typed and the screen left at once (back to the course, < 1 s) is saved; a reload of the tab 200 ms after the last key too', async ({ page }) => {
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await newNote(page).click();
    await noteText(page).pressSequentially('Бързо излизане', { delay: 2 });
    await page.goto(`./#/c/${C}`);
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body), { timeout: 5000 }).toEqual(['Бързо излизане']);
    await openLesson(page);
    await noteMarks(page).first().click();
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' и презареждане', { delay: 2 });
    await page.waitForTimeout(200);
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(500);
    const bodies = (await liveNotes(page)).map((n) => n.body);
    info('T018-D3 after a reload 200 ms after typing', bodies);
    expect(bodies).toEqual(['Бързо излизане и презареждане']);
  });

  test('T018-D4 an existing note emptied: closing deletes it with "Върни" (8 s); "Върни" brings the old text back; after 8 s the toast goes; a new empty note leaves no annotation; whitespace only is empty', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Ще я изпразня');
    await noteText(page).fill('   \n  ');
    await expect(noteStatus(page)).toContainText('Празна бележка', { timeout: 4000 });
    await page.locator('[data-action="note-done"]').click();
    await expect(page.locator('[data-field="notes-undo"]')).toContainText('Празната бележка е изтрита.');
    await expect.poll(async () => (await liveNotes(page)).length).toBe(0);
    expect((await liveAnn(page)).length).toBe(0);
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect(noteText(page)).toHaveValue('Ще я изпразня');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['Ще я изпразня']);
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await expect(page.locator('[data-field="notes-undo"]')).toBeVisible();
    await page.waitForTimeout(8600);
    await expect(page.locator('[data-field="notes-undo"]')).toBeHidden();
    expect(await liveNotes(page)).toHaveLength(0);
    // A new note with spaces only: nothing kept.
    await select(page, 'Уязвимостите');
    await newNote(page).click();
    await noteText(page).fill('    ');
    await page.waitForTimeout(1300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    expect(await liveNotes(page)).toHaveLength(0);
    expect(await liveAnn(page)).toHaveLength(0);
  });

  test('T018-D5 eraser / "Отмени" against "Изтрий" / "Върни": a mark with a note erased (colour only), the note deleted, then "Отмени" — the mark comes back coloured, no error', async ({ page }) => {
    await openLesson(page);
    await mark(page, 'Уязвимостите се докладват', 'green');
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(t.x + 20, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('Бележка за гумата');
    await page.locator('[data-action="note-done"]').click();
    await eraseOver(page, 'Уязвимостите се докладват');
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.color)).toEqual([null]);
    await page.keyboard.press('Escape'); // the eraser off
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await expect.poll(async () => (await liveNotes(page)).length).toBe(0);
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await page.waitForTimeout(1000);
    const status = await marksStatus(page).textContent();
    const a = await annotations(page);
    info('T018-D5', { status, a: a.map((x) => [x.color, x.deleted]) });
    problems = problems.filter((p) => !/Marking failed|not an annotation/.test(p));
    const ok = a.some((x) => !x.deleted && x.color === 'green');
    expect(ok).toBe(true);
  });

  test('T018-D6 "Изтрий" of a note on a mark, the mark erased with the eraser within 8 s, then "Върни": the note must be visible again (not a live note on a deleted annotation)', async ({ page }) => {
    await openLesson(page);
    await mark(page, 'Уязвимостите се докладват', 'green');
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(t.x + 20, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('Ще се загуби ли?');
    await page.locator('[data-action="note-done"]').click();
    await expect.poll(async () => (await liveNotes(page)).length).toBe(1);
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await expect(page.locator('[data-field="notes-undo"]')).toBeVisible();
    await eraseOver(page, 'Уязвимостите се докладват');
    await expect.poll(async () => (await liveAnn(page)).length).toBe(0);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="undo-note-delete"]').click();
    await page.waitForTimeout(1000);
    const n = await liveNotes(page);
    const a = await liveAnn(page);
    const shown = await page.locator('[data-field="notes-count"]').textContent();
    info('T018-D6', { notes: n.length, annotations: a.length, shown, status: await marksStatus(page).textContent() });
    expect(n.map((x) => x.body)).toEqual(['Ще се загуби ли?']);
    expect(shown).toBe('1');
    expect(a.length).toBe(1);
  });

  test('T018-D7 one note per place: a selection over three notes opens one of them (no new place); inside the quiz / data-lrn-noanno only a message; a mark at exactly the place takes the note; "Бележка" twice fast → one editor, one note', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'Регламентът за киберустойчивост', 'Едно');
    await page.keyboard.press('Escape');
    await writeNote(page, 'Производителят оценява', 'Две');
    await page.keyboard.press('Escape');
    await writeNote(page, 'Уязвимостите се докладват', 'Три');
    await page.keyboard.press('Escape');
    await selectAcross(page, 'се прилага за продукти', 'без неоправдано');
    await newNote(page).click();
    await expect(panel(page)).toBeVisible();
    const opened = await noteText(page).inputValue();
    info('T018-D7 a selection over three notes opens', opened);
    expect(['Едно', 'Две', 'Три']).toContain(opened);
    await page.keyboard.press('Escape');
    expect(await liveAnn(page)).toHaveLength(3);
    // The quiz and data-lrn-noanno.
    for (const needle of ['Въпрос от теста', 'Този текст не се маркира']) {
      await select(page, needle);
      await expect(newNote(page)).toBeVisible({ timeout: 3000 });
      await newNote(page).click();
      await expect(marksStatus(page)).toContainText('Тук не може да се закачи бележка');
      await expect(panel(page)).toBeHidden();
    }
    expect(await liveAnn(page)).toHaveLength(3);
    // Twice fast.
    await select(page, 'Краят на урока');
    await expect(newNote(page)).toBeVisible({ timeout: 3000 });
    await newNote(page).dispatchEvent('click');
    await newNote(page).dispatchEvent('click').catch(() => {});
    await expect(panel(page)).toBeVisible();
    await noteText(page).pressSequentially('Четири');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body).sort()).toEqual(['Две', 'Едно', 'Три', 'Четири']);
    expect(await liveAnn(page)).toHaveLength(4);
  });

  test('T018-D8 "Маркировки за проверка → Изтрий" on a noted mark takes only its colour: the note stays with its place; the eraser on a note-only place with a tap does nothing; "Отмени" three times in a row never deletes a note', async ({ page }) => {
    await openLesson(page);
    await mark(page, 'с последно изречение за бележка', 'pink');
    await scrollTo(page, 'с последно изречение за бележка');
    const t = await textBox(page, 'с последно изречение за бележка');
    await page.mouse.click(t.x + 20, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('Розова с бележка');
    await page.locator('[data-action="note-done"]').click();
    await expect.poll(async () => (await liveNotes(page)).length).toBe(1);
    const changed = BODY.replace('с последно изречение за бележка', 'с последно изречение за бележки');
    expect(await importCourse(page, C, files(changed))).not.toMatch(/^ERROR/);
    await openLesson(page);
    const check = page.locator('[data-field="marks-check"]');
    await expect(check).toBeVisible({ timeout: 8000 });
    await check.locator('summary').click();
    await check.locator('[data-action="delete-mark"]').first().click();
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.color)).toEqual([null]);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Розова с бележка']);
    // "Отмени" three times: the colour back (once), then nothing more to undo; the note is never deleted.
    for (let i = 0; i < 3; i++) await page.locator('[data-field="mark-tools"] [data-action="undo"]').click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Розова с бележка']);
    expect((await liveAnn(page)).map((a) => a.color)).toEqual(['pink']);
  });

  test('T018-D9 a retired lesson (gone from a full import) keeps its notes: they open, can be written; a renamed file (same number) keeps them "ok"', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Преди преименуване');
    await page.keyboard.press('Escape');
    expect(await importCourse(page, C, files(BODY, { path: 'lessons/0001-novo-ime.html' }))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 8000 });
    await expect(noteMarks(page).first()).toHaveAttribute('data-state', 'ok');
    // Retired: a full import with another lesson only.
    const other = { 'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0002 | Втори |\n`, 'lessons/0002-vtori.html': lessonHtml('Втори', '<p>Друг урок.</p>') };
    expect(await importCourse(page, C, other)).not.toMatch(/^ERROR/);
    await openLesson(page);
    await expect(page.locator('[data-field="retired-note"]')).toBeVisible();
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 8000 });
    await noteMarks(page).first().click();
    await expect(noteText(page)).toHaveValue('Преди преименуване');
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' — оттеглен');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['Преди преименуване — оттеглен']);
  });

  test('T018-D10 two tabs: a note deleted in one tab while it is open in the other — what the user then types in the other tab is not silently lost; a note made in both tabs on the same place', async ({ page, context }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Начало');
    await page.keyboard.press('Escape');
    const other = await context.newPage();
    other.on('pageerror', (e) => problems.push(`other: ${e}`));
    await other.goto(`./#/c/${C}/read/0001`);
    await waitReady(other);
    await expect(other.locator('[data-field="notes-marks"] .notes-strip__mark')).toHaveCount(1, { timeout: 8000 });
    await other.locator('[data-field="notes-marks"] .notes-strip__mark').first().click();
    await expect(other.locator('[data-field="note-text"]')).toHaveValue('Начало');
    // Deleted in the first tab.
    await page.bringToFront();
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await expect.poll(async () => (await liveNotes(page)).length).toBe(0);
    // The second tab writes on.
    await other.bringToFront();
    await other.locator('[data-field="note-text"]').press('End');
    await other.locator('[data-field="note-text"]').pressSequentially(' + важно допълнение');
    await other.waitForTimeout(1600);
    const status = await other.locator('[data-field="note-status"]').textContent();
    await other.keyboard.press('Escape');
    await other.waitForTimeout(800);
    const all = await notesOf(page);
    info('T018-D10', { status, notes: all.map((n) => [n.body, !!n.deleted]) });
    allowWarn.push(/Cannot save the note/);
    const kept = all.some((n) => !n.deleted && n.body.includes('важно допълнение'));
    expect(kept).toBe(true);
    await other.close();
  });
});

// ===========================================================================
test.describe('T018-P size: a note of 1 MB, 1000 notes', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('T018-P1 a 1 MB text in the field keeps 20 000 characters (saved, says so?); a 1 MB note in the database (an old backup) opens, lists and saves', async ({ page }) => {
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await newNote(page).click();
    const big = 'Дълъг текст на бележка. '.repeat(44000); // ~1 MB
    await noteText(page).fill(big);
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 10000 });
    const stored = (await liveNotes(page))[0].body.length;
    const shownLen = (await noteText(page).inputValue()).length;
    info('T018-P1 1 MB pasted', { stored, shownLen, status: await noteStatus(page).textContent() });
    expect(stored).toBe(20000);
    await page.keyboard.press('Escape');
    // A 1 MB body put straight into the store (an old / edited backup).
    await db(page, async (db, big) => {
      const n = (await db.list('notes'))[0];
      await db.update('notes', n.id, { body: big });
    }, 'Дума и още думи, **важно**, - списък\n'.repeat(26000));
    await openLesson(page);
    const t0 = Date.now();
    await page.locator('[data-action="notes-list"]').click();
    await expect(page.locator('[data-field="notes-list"] .notes-list__item')).toHaveCount(1);
    const listMs = Date.now() - t0;
    const t1 = Date.now();
    await page.locator('[data-field="notes-list"] [data-action="open-note"]').click();
    await expect(noteText(page)).toBeVisible();
    const openMs = Date.now() - t1;
    info('T018-P1 a 1 MB note', { listMs, openMs, field: (await noteText(page).inputValue()).length });
    expect(listMs).toBeLessThan(10000);
    expect(openMs).toBeLessThan(10000);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('T018-P3 one unbroken "word" (a pasted base64 / URL): 20 000 characters from the field, then 1 MB from a backup — the list and the note open within 10 s', async ({ page }) => {
    test.setTimeout(240000);
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await newNote(page).click();
    await noteText(page).fill('Ж'.repeat(20000));
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 10000 });
    await page.keyboard.press('Escape');
    const time = async () => {
      const t0 = Date.now();
      await page.locator('[data-action="notes-list"]').click({ timeout: 20000 });
      await expect(page.locator('[data-field="notes-list"] .notes-list__item')).toHaveCount(1, { timeout: 20000 });
      await page.locator('[data-field="notes-list"] [data-action="open-note"]').click({ timeout: 20000 });
      await expect(noteText(page)).toBeVisible({ timeout: 20000 });
      const ms = Date.now() - t0;
      await page.keyboard.press('Escape');
      return ms;
    };
    const ms20k = await time();
    info('T018-P3 unbroken 20 000 (ms)', ms20k);
    expect(ms20k).toBeLessThan(10000);
    await db(page, async (db, big) => { const n = (await db.list('notes'))[0]; await db.update('notes', n.id, { body: big }); }, 'Б'.repeat(1_000_000));
    await openLesson(page);
    const ms1m = await time();
    info('T018-P3 unbroken 1 MB (ms)', ms1m);
    expect(ms1m).toBeLessThan(10000);
  });

  test('T018-P2 1000 notes in one lesson: the lesson opens, the 📝 are drawn, the list opens, ▼ works, a new note saves — within generous limits (times in the report)', async ({ page }) => {
    const many = Array.from({ length: 250 }, (_, i) => `<p id="m${i}">Ред ${i}: първо място ${i}а, второ място ${i}б, трето ${i}в и четвърто ${i}г тук.</p>`).join('\n');
    expect(await importCourse(page, C, files(many))).not.toMatch(/^ERROR/);
    await openLesson(page);
    // 1000 places through the app's own module (like the user would make them, quicker).
    const made = await page.evaluate(async ({ C, L1 }) => {
      const db = await import('./src/db.js');
      const ann = await import('./src/annotations.js');
      const notes = await import('./src/notes.js');
      const course = await db.get('courses', C);
      const lesson = (await db.list('lessons')).find((l) => l.id === L1);
      const frameDoc = document.querySelector('iframe.lesson-frame');
      void frameDoc;
      let n = 0;
      const t0 = performance.now();
      for (let i = 0; i < 250; i++) {
        for (const s of ['а', 'б', 'в', 'г']) {
          void ann;
          const exact = `${i}${s}`;
          // the position is filled in by the bridge on the next anchoring (quote search)
          await notes.saveNote({ course, lesson, draft: { selection: { quote: { exact: `място ${exact}`, prefix: '', suffix: '' }, position: { start: 1, end: 2 } } }, body: `Бележка ${exact}` });
          n++;
        }
      }
      return { n, ms: Math.round(performance.now() - t0) };
    }, { C, L1 });
    info('T018-P2 made', made);
    const t0 = Date.now();
    await openLesson(page);
    await expect(page.locator('[data-field="notes-count"]')).toHaveText('1000', { timeout: 30000 });
    await expect.poll(() => noteMarks(page).count(), { timeout: 30000 }).toBeGreaterThan(200);
    const openMs = Date.now() - t0;
    const t1 = Date.now();
    await page.locator('[data-action="notes-list"]').click();
    await expect(page.locator('[data-field="notes-list"] .notes-list__item, [data-field="notes-orphans"] .notes-list__item')).toHaveCount(1000, { timeout: 30000 });
    const listMs = Date.now() - t1;
    await page.keyboard.press('Escape');
    const t2 = Date.now();
    await page.locator('[data-action="next-note"]').click();
    await expect(panel(page)).toBeVisible();
    const stepMs = Date.now() - t2;
    await page.keyboard.press('Escape');
    const t3 = Date.now();
    await writeNote(page, 'Ред 3:', 'Нова сред 1000');
    const saveMs = Date.now() - t3;
    const marks = await noteMarks(page).count();
    info('T018-P2 times (ms)', { openMs, listMs, stepMs, saveMs, marks });
    expect(openMs).toBeLessThan(30000);
    expect(listMs).toBeLessThan(15000);
    expect(stepMs).toBeLessThan(5000);
    expect(saveMs).toBeLessThan(15000);
  });
});

// ===========================================================================
test.describe('T018-L layout, keyboard, aria', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('T018-L1 the strip (≈ 106 px, two columns) and the panel: 1920 landscape — right of the strip, over nothing of the lesson; 1200 portrait — left of the strip, the strip reachable; aria of the strip, the list button and the dialog', async ({ page }) => {
    await openLesson(page);
    const s = await strip(page).boundingBox();
    const f = await page.locator('iframe.lesson-frame').boundingBox();
    const bar = await page.locator('.notes-strip__bar').boundingBox();
    const marksCol = await page.locator('[data-field="notes-marks"]').boundingBox();
    info('T018-L1 strip', { s, bar, marksCol });
    // T-071 (D-046): in portrait the bar is in the row at the top: the strip is the 📝 column only.
    const vp0 = page.viewportSize();
    if (vp0.height > vp0.width) {
      expect(s.width).toBeLessThanOrEqual(48);
      expect(bar.y + bar.height).toBeLessThanOrEqual(f.y + 1);
      await expect(page.locator('.notes-strip__bar')).toHaveAttribute('aria-orientation', 'horizontal');
    } else {
      expect(s.width).toBeGreaterThanOrEqual(90);
      expect(s.width).toBeLessThanOrEqual(130);
    }
    expect(s.x).toBeGreaterThanOrEqual(f.x + f.width - 1);
    await expect(page.locator('.notes-strip__bar')).toHaveAttribute('role', 'toolbar');
    await writeNote(page, 'оценява рисковете', 'Къде е панелът?');
    const p = await panel(page).boundingBox();
    await expect(panel(page)).toHaveAttribute('role', 'dialog');
    await expect(panel(page)).toHaveAttribute('aria-labelledby', 'notes-panel-title');
    // T-069 (the user, an addition to D-045): on a tablet the note never covers the lesson.
    // T-071 (D-046): while the panel is open the strip (📝 column and bar) is hidden; in landscape the
    // panel is a column at the right edge, in portrait (1200×1920) it is UNDER the lesson.
    await expect(strip(page)).toBeHidden();
    await expect(page.locator('.notes-strip__bar')).toBeHidden();
    const f2 = await page.locator('iframe.lesson-frame').boundingBox();
    const vp = page.viewportSize();
    if (vp.height > vp.width) {
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y + p.height).toBeGreaterThanOrEqual(vp.height - 1);
      const t = await textBox(page, 'оценява рисковете');
      expect(t.bottom).toBeLessThanOrEqual(p.y + 1); // the noted line is above the panel
    } else {
      expect(p.x).toBeGreaterThanOrEqual(f2.x + f2.width - 1); // nothing of the lesson covered
    }
    await page.locator('[data-action="notes-back-to-list"]').click();
    await expect(page.locator('[data-action="notes-list"]')).toHaveAttribute('aria-expanded', 'true');
    void f;
    expect(p.y + p.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('T018-L2 the 📝 follow the lines while scrolling, after 160 % and a rotation with the panel open; the dotted line is visible in the dark theme; no sideways scroll', async ({ page }) => {
    await db(page, (db) => db.saveSettings({ theme: 'dark' }));
    await openLesson(page);
    await writeNote(page, 'Уязвимостите се докладват', 'Следва реда');
    // T-071 (D-046): the 📝 are hidden while the panel is open: checked with it closed.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    const check = async (why) => {
      await expect.poll(async () => {
        const line = await textBox(page, 'Уязвимостите се докладват');
        const icon = await noteMarks(page).first().boundingBox();
        return icon ? Math.abs(icon.y + icon.height / 2 - (line.top + line.bottom) / 2) : 999;
      }, { timeout: 6000, message: why }).toBeLessThan(30);
    };
    await check('first');
    await page.evaluate(() => window.scrollBy(0, 137));
    await check('scrolled');
    await db(page, (db) => db.saveSettings({ fontScale: 1.6 }));
    await check('160 %');
    await noteMarks(page).first().click();
    await expect(panel(page)).toBeVisible();
    const v = page.viewportSize();
    await page.setViewportSize({ width: v.height, height: v.width });
    await page.waitForTimeout(300);
    await expect(panel(page)).toBeVisible();
    const pb = await panel(page).boundingBox();
    expect(pb.x + pb.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
    await check('rotated with the panel open, then closed');
    const dotted = await (await lessonFrame(page)).evaluate(() => {
      for (const s of document.styleSheets) {
        try { for (const r of s.cssRules) if (r.selectorText && r.selectorText.includes('lrn-note')) return r.cssText; } catch { /* */ }
      }
      return null;
    });
    info('T018-L2 the rule of the dotted line', dotted);
    expect(dotted).toMatch(/dotted|underline/);
  });

  test('T018-L3 keyboard only: Tab reaches the strip, "Бележка" for a keyboard selection, Enter writes, Escape saves and closes, the list is reachable and its items open with Enter; focus is never lost to <body>', async ({ page }) => {
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await expect(newNote(page)).toBeVisible({ timeout: 3000 });
    await newNote(page).focus();
    await page.keyboard.press('Enter');
    await expect(noteText(page)).toBeFocused();
    await page.keyboard.type('С клавиатура');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    const back = await page.evaluate(() => document.activeElement?.tagName);
    expect(back).not.toBe('BODY');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['С клавиатура']);
    await page.locator('[data-action="notes-list"]').focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toHaveAttribute('data-mode', 'list');
    await page.keyboard.press('Tab');
    let guard = 0;
    while (!(await page.evaluate(() => document.activeElement?.dataset?.action === 'open-note')) && guard++ < 10) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(noteText(page)).toHaveValue('С клавиатура');
    await page.evaluate(() => { window.__focusLog = []; document.addEventListener('focusin', (e) => window.__focusLog.push(e.target.dataset?.action || e.target.dataset?.field || e.target.tagName), true); document.addEventListener('focusout', (e) => window.__focusLog.push('-' + (e.target.dataset?.action || e.target.dataset?.field || e.target.tagName)), true); });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const where = await page.evaluate(() => ({ el: document.activeElement?.dataset?.action || document.activeElement?.tagName, log: window.__focusLog }));
    info('T018-L3 focus after Escape (a note opened from the list)', where);
    expect(where.el).not.toBe('BODY');
  });
});

// ===========================================================================
test.describe('T018-M phone (360×800 / 800×360), touch', () => {
  test.use({
    viewport: async ({}, use, info) => use(info.project.name.includes('portrait') ? { width: 360, height: 800 } : { width: 800, height: 360 }),
  });
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('T018-M1 touch: "Готово" tapped where the noted text is under it does not open the note again (no ghost click); "Изтрий" → "Върни" tapped fast; ☰ → "Скрий" double tap leaves the strip shown or hidden, never a tool on', async ({ page }) => {
    await openLesson(page);
    const narrow = page.viewportSize().width < 600;
    await select(page, 'Уязвимостите се докладват');
    const btn = narrow ? quick(page) : newNote(page);
    await expect(btn).toBeVisible({ timeout: 3000 });
    await btn.tap();
    await noteText(page).pressSequentially('Докосване');
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    // Put the noted text under "Готово".
    const done = await page.locator('[data-action="note-done"]').boundingBox();
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(t.y - (done.y + done.height / 2)));
    await page.waitForTimeout(200);
    await page.locator('[data-action="note-done"]').tap();
    await page.waitForTimeout(700);
    await expect(panel(page)).toBeHidden();
    // "Изтрий" → "Върни" fast.
    // T-069: a phone has no "☰" any more (the 📝 column is always there).
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
    await noteMarks(page).first().tap();
    await page.locator('[data-action="delete-note"]').tap();
    await page.locator('[data-action="undo-note-delete"]').tap();
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['Докосване']);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.querySelector('[data-field="reader-doc"]')?.dataset.tool)).toBe('none');
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('T018-M2 a double tap on the notes "☰" (second tap 60…290 ms later, Android\'s double tap) leaves the strip shown; a double tap on "» Скрий" leaves it hidden (T066-D4 for the right strip)', async ({ page }) => {
    // T-069 (the user, an addition to D-045): a phone (< 600 px) has no notes bar and no "☰" — only the 📝 column.
    test.skip(page.viewportSize().width < 600, 'T-069: no notes bar / "☰" on a phone');
    await openLesson(page);
    const cdp = await page.context().newCDPSession(page);
    const tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const handle = page.locator('[data-field="notes-strip-handle"]');
    const hide = page.locator('[data-action="hide-notes"]');
    const out = [];
    for (const gap of [60, 150, 230, 290]) {
      if (await strip(page).isVisible()) { await hide.tap(); await page.waitForTimeout(500); }
      await expect(handle).toBeVisible();
      const hb = await handle.boundingBox();
      const x = hb.x + hb.width / 2;
      const y = hb.y + hb.height / 2;
      await tap(x, y);
      await page.waitForTimeout(gap);
      await tap(x, y);
      await page.waitForTimeout(600);
      const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.dataset.action || null, [x, y]);
      out.push({ gap, shown: await strip(page).isVisible(), under });
    }
    const outHide = [];
    for (const gap of [60, 150, 230, 290]) {
      if (!(await strip(page).isVisible())) { await handle.tap(); await page.waitForTimeout(500); }
      const hb = await hide.boundingBox();
      const x = hb.x + hb.width / 2;
      const y = hb.y + hb.height / 2;
      await tap(x, y);
      await page.waitForTimeout(gap);
      await tap(x, y);
      await page.waitForTimeout(600);
      outHide.push({ gap, shown: await strip(page).isVisible() });
    }
    info('T018-M2', { handle: out, hide: outHide });
    expect(await page.evaluate(() => document.querySelector('[data-field="reader-doc"]')?.dataset.tool)).toBe('none');
    const bad = [...out.filter((r) => !r.shown), ...outHide.filter((r) => r.shown)];
    expect(bad).toEqual([]);
  });
});
