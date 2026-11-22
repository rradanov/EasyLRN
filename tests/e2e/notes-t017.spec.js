// T-017 (developer, 0.14.0): notes in a strip RIGHT of the lesson (D-045).
// - selected text (the system selection, no tool) → "📝 Бележка" in the strip →
//   a note with the quote, saved by itself; a 📝 next to its line; one note
//   per place (a second "Бележка" on the same / an overlapping place opens it);
// - a tap on a mark → "Добави бележка" → the note is on the mark's annotation;
//   the eraser takes only the colour (the note stays), "Отмени" brings it back;
// - "Изтрий" in the note + "Върни"; the list (text order, "Неприкачени"),
//   ▲ / ▼; the strip hidden behind "☰" on a phone with "📝 Бележка" next to
//   the handle; the panel fills a phone; Escape; dark theme, 160 %, no
//   horizontal scroll;
// - security: the lesson never receives the text of a note; forged
//   lrn:selection / lrn:tap from the lesson create nothing.
// Synthetic data only, no network (D-026).
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
// A lesson script that keeps every message the app sends to it (it looks for the text of a note).
const SPY = `<script>window.__got = []; addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__got.push(JSON.stringify(e.data)); });</script>`;
const LONG = Array.from({ length: 60 }, (_, i) => `<p id="f${i}">Допълнителен абзац ${i} за превъртане: текстът тук е само за да е урокът по-дълъг от екрана.</p>`).join('\n');
const BODY = [
  '<p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи на пазара.</p>',
  '<p id="p2">Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.</p>',
  '<p id="p3">Уязвимостите се докладват без неоправдано забавяне на органите.</p>',
  '<div data-lrn-noanno><p id="nx">Този текст не се маркира: бележка на автора.</p></div>',
  LONG,
  '<p id="p5">Краят на урока е тук, с последно изречение за бележка.</p>',
].join('\n');
const C = 'LRN-T17';
const files = (body = BODY) => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', `${body}${SPY}`),
});
const L1 = `${C}/lesson:0001`;

const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) {
  const handle = await page.locator('iframe.lesson-frame').elementHandle();
  return handle.contentFrame();
}
async function openLesson(page) {
  const hash = `#/c/${C}/read/0001`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 10000 }).toBe(true);
  return lessonFrame(page);
}
const annotations = (page) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, exact: a.selector.quote.exact, deleted: a.deleted, color: a.color, style: a.style })), L1);
const notesOf = (page) => db(page, async (db) => (await db.list('notes', { includeDeleted: true }))
  .map((n) => ({ id: n.id, annotationId: n.annotationId, body: n.body, deleted: n.deleted, courseId: n.courseId })));
const liveNotes = async (page) => (await notesOf(page)).filter((n) => !n.deleted);
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));

/** Select `needle` [from, to) in the lesson as the user would (the system selection). */
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
/** The box of `needle` in app viewport coordinates. */
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
  return { x: box.x + rel.left + 4, y: box.y + rel.top + rel.height / 2, top: box.y + rel.top, bottom: box.y + rel.top + rel.height };
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
  await page.waitForTimeout(100);
}
/** A mark made through the app's own API (as the marker would). */
async function mark(page, needle, color = 'yellow') {
  await select(page, needle);
  await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length), { timeout: 3000 }).toBeGreaterThan(0);
  await page.locator('[data-field="mark-tools"] [data-color="' + color + '"]').click();
  await expect.poll(async () => (await annotations(page)).filter((a) => !a.deleted && a.color === color).length, { timeout: 5000 }).toBeGreaterThan(0);
  await page.keyboard.press('Escape'); // the tool off again
}

const strip = (page) => page.locator('[data-field="notes-strip"]');
const newNote = (page) => page.locator('[data-action="new-note"]');
const quick = (page) => page.locator('[data-action="new-note-quick"]');
const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const noteMarks = (page) => page.locator('[data-field="notes-marks"] .notes-strip__mark');
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

/** Select, press "Бележка", write, wait for the save. */
async function writeNote(page, needle, text, { button = newNote } = {}) {
  await select(page, needle);
  await expect(button(page)).toBeVisible({ timeout: 3000 });
  await button(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(noteText(page)).toBeFocused();
  await noteText(page).pressSequentially(text, { delay: 5 });
  await expect(page.locator('[data-field="note-status"]')).toHaveText('Записано.', { timeout: 5000 });
}

// ---------------------------------------------------------------------------
test.describe('T-017 notes on the tablet', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('N1 selection → "Бележка" in the right strip → a note with the quote, saved by itself; a 📝 next to its line; the dotted line in the lesson; kept after a reload; no horizontal scroll', async ({ page }) => {
    await openLesson(page);
    const s = await strip(page).boundingBox();
    const f = await page.locator('iframe.lesson-frame').boundingBox();
    const tools = await page.locator('[data-field="mark-tools"]').boundingBox();
    expect(s.x).toBeGreaterThanOrEqual(f.x + f.width - 1); // right of the lesson
    expect(tools.x + tools.width).toBeLessThanOrEqual(f.x + 1); // the tools on the left
    await expect(newNote(page)).toBeHidden();
    await writeNote(page, 'оценява рисковете', 'Моя бележка **важно**');
    await expect(page.locator('[data-field="note-quote"]')).toContainText('оценява рисковете');
    const a = (await annotations(page)).filter((x) => !x.deleted);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ exact: 'оценява рисковете', color: null });
    const n = await liveNotes(page);
    expect(n).toEqual([expect.objectContaining({ annotationId: a[0].id, body: 'Моя бележка **важно**', courseId: C })]);
    // The selection is cleared after "Бележка"; the button goes.
    await expect(newNote(page)).toBeHidden({ timeout: 3000 });
    await page.locator('[data-action="note-done"]').click();
    await expect(panel(page)).toBeHidden();
    // The 📝 is on the line of the text.
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
    const line = await textBox(page, 'оценява рисковете');
    const icon = await noteMarks(page).first().boundingBox();
    expect(Math.abs(icon.y + icon.height / 2 - (line.top + line.bottom) / 2)).toBeLessThan(26);
    expect(icon.width).toBeGreaterThanOrEqual(44);
    expect(icon.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => highlights(page), { timeout: 5000 }).toMatchObject({ 'lrn-note': ['оценява рисковете'] });
    expect(await noHorizontalScroll(page)).toBe(true);
    await openLesson(page);
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('[data-field="notes-count"]')).toHaveText('1');
    // A tap on the 📝 opens it; a tap on the noted text in the lesson too.
    await noteMarks(page).first().click();
    await expect(panel(page)).toBeVisible();
    await expect(noteText(page)).toHaveValue('Моя бележка **важно**');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    const t = await textBox(page, 'оценява рисковете');
    await page.mouse.click(t.x + 10, t.y);
    await expect(panel(page)).toBeVisible();
    await expect(noteText(page)).toHaveValue('Моя бележка **важно**');
  });

  test('N2 one note per place: "Бележка" again on the same / an overlapping text opens the note there for more text (no second annotation); a different place → a new note', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Първо.');
    await page.keyboard.press('Escape');
    await select(page, 'рисковете за киберсигурността');
    await newNote(page).click();
    await expect(noteText(page)).toHaveValue('Първо.');
    await expect(noteText(page)).toBeFocused();
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' Второ.');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['Първо. Второ.']);
    expect((await annotations(page)).filter((a) => !a.deleted)).toHaveLength(1);
    await writeNote(page, 'Уязвимостите се докладват', 'Трето.');
    await page.keyboard.press('Escape');
    expect((await liveNotes(page)).map((n) => n.body).sort()).toEqual(['Първо. Второ.', 'Трето.'].sort());
  });

  test('N3 a tap on a mark → "Добави бележка" → the note is on the mark; the eraser takes only the colour (the note stays, its 📝 too), "Отмени" brings the colour back; "Бележка" on exactly a marked text goes on the mark', async ({ page }) => {
    await openLesson(page);
    await mark(page, 'Уязвимостите се докладват', 'green');
    const [m] = (await annotations(page)).filter((a) => !a.deleted);
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(t.x + 20, t.y);
    await expect(panel(page)).toHaveAttribute('data-mode', 'mark');
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('Към маркировката.');
    await page.locator('[data-action="note-done"]').click();
    await expect.poll(async () => (await liveNotes(page)).map((n) => [n.annotationId, n.body])).toEqual([[m.id, 'Към маркировката.']]);
    // The eraser over the mark: the colour goes, the annotation and the note stay.
    await page.locator('[data-field="mark-tools"] [data-tool="eraser"]').click();
    const box = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await annotations(page)).map((a) => [a.color, a.deleted])).toEqual([[null, false]]);
    expect((await liveNotes(page)).length).toBe(1);
    await expect.poll(() => highlights(page), { timeout: 5000 }).toMatchObject({ 'lrn-note': ['Уязвимостите се докладват'] });
    await expect(noteMarks(page)).toHaveCount(1);
    // A tap with the eraser on the noted (uncoloured) text erases nothing.
    const again = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(again.x + 10, again.y);
    await page.waitForTimeout(500);
    expect((await annotations(page)).map((a) => [a.color, a.deleted])).toEqual([[null, false]]);
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await expect.poll(async () => (await annotations(page)).map((a) => [a.color, a.deleted])).toEqual([['green', false]]);
    await page.keyboard.press('Escape');
    // "Бележка" on exactly the marked text: the same annotation, the note opens.
    await select(page, 'оценява');
    await expect(newNote(page)).toBeVisible();
    await mark(page, 'Производителят', 'blue');
    const blue = (await annotations(page)).find((a) => a.color === 'blue');
    await select(page, 'Производителят');
    await newNote(page).click();
    await noteText(page).pressSequentially('На синята.');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await liveNotes(page)).find((n) => n.body === 'На синята.')?.annotationId).toBe(blue.id);
    expect((await annotations(page)).filter((a) => !a.deleted)).toHaveLength(2);
  });

  test('N4 "Изтрий" in the note → "Върни" brings it back (with its place); deleted for good after the time: the uncoloured annotation goes with it; a new note left empty is not saved', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'За изтриване.');
    await page.locator('[data-action="delete-note"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('[data-field="notes-undo"]')).toBeVisible();
    await expect.poll(async () => (await liveNotes(page)).length).toBe(0);
    expect((await annotations(page)).map((a) => a.deleted)).toEqual([true]);
    await expect(noteMarks(page)).toHaveCount(0, { timeout: 5000 });
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['За изтриване.']);
    expect((await annotations(page)).map((a) => a.deleted)).toEqual([false]);
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
    await expect(panel(page)).toBeVisible(); // the note opens again
    await page.locator('[data-action="delete-note"]').click();
    await expect.poll(async () => (await liveNotes(page)).length).toBe(0);
    // A new note closed without text: nothing is saved.
    await select(page, 'Уязвимостите');
    await newNote(page).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect((await annotations(page)).filter((a) => !a.deleted)).toHaveLength(0);
    expect(await liveNotes(page)).toHaveLength(0);
  });

  test('N5 the list: all notes in text order (quote + text, Markdown without HTML), a tap scrolls to the place and opens the note; ▲ / ▼ go from note to note', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'с последно изречение', 'Последна <img src=x onerror="window.__xss=1"> [линк](javascript:alert(1))');
    await page.keyboard.press('Escape');
    await writeNote(page, 'Регламентът за киберустойчивост', 'Първа');
    await page.keyboard.press('Escape');
    await writeNote(page, 'Уязвимостите се докладват', 'Средна');
    await page.keyboard.press('Escape');
    await page.locator('[data-action="notes-list"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'list');
    const items = page.locator('[data-field="notes-list"] .notes-list__item');
    await expect(items).toHaveCount(3);
    await expect(items.locator('.notes-list__body')).toHaveText(['Първа', 'Средна', /Последна/]);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await items.nth(2).locator('img, a[href^="javascript"]').count()).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await items.nth(2).locator('[data-action="open-note"]').click();
    await expect(noteText(page)).toHaveValue(/^Последна/);
    const last = await textBox(page, 'с последно изречение');
    expect(last.top).toBeGreaterThan(0);
    expect(last.bottom).toBeLessThan(page.viewportSize().height);
    // ▲ from the last → the middle one → the first; ▲ again: "първата".
    await page.locator('[data-action="prev-note"]').click();
    await expect(noteText(page)).toHaveValue('Средна');
    await page.locator('[data-action="prev-note"]').click();
    await expect(noteText(page)).toHaveValue('Първа');
    await page.locator('[data-action="prev-note"]').click();
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Това е първата бележка.');
    await page.locator('[data-action="next-note"]').click();
    await expect(noteText(page)).toHaveValue('Средна');
    const mid = await textBox(page, 'Уязвимостите се докладват');
    expect(mid.top).toBeGreaterThan(0);
    expect(mid.bottom).toBeLessThan(page.viewportSize().height);
  });

  test('N6 the 📝 stay at their lines after a change of the text size and of the window (rotation)', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'Уязвимостите се докладват', 'Размер');
    await page.keyboard.press('Escape');
    const check = async () => {
      await expect.poll(async () => {
        const line = await textBox(page, 'Уязвимостите се докладват');
        const icon = await noteMarks(page).first().boundingBox();
        return icon ? Math.abs(icon.y + icon.height / 2 - (line.top + line.bottom) / 2) : 999;
      }, { timeout: 5000 }).toBeLessThan(30);
    };
    await check();
    await db(page, (db) => db.saveSettings({ fontScale: 1.6 }));
    await check();
    const v = page.viewportSize();
    await page.setViewportSize({ width: v.height, height: v.width });
    await check();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('X1 the lesson never receives the text of a note; forged lrn:selection / lrn:tap from the lesson create nothing (they may only show the button / the user\'s own note)', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'ТАЙНА-БЕЛЕЖКА-777');
    await page.keyboard.press('Escape');
    await openLesson(page);
    await noteMarks(page).first().click();
    await noteText(page).pressSequentially(' ОЩЕ-ТАЙНА');
    await page.locator('[data-action="notes-list"]').click();
    await page.waitForTimeout(500);
    const frame = await lessonFrame(page);
    const got = await frame.evaluate(() => window.__got.join('\n'));
    expect(got).toContain('lrn:annotations');
    expect(got).not.toContain('ТАЙНА');
    expect(got).not.toContain('ОЩЕ');
    // Forgeries: a selection and taps (an own id, a foreign one) from the lesson.
    const before = { a: await annotations(page), n: await notesOf(page) };
    await page.keyboard.press('Escape');
    await frame.evaluate(() => {
      const p = (x) => parent.postMessage(x, '*');
      p({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'Производителят', prefix: '', suffix: '' }, position: { start: 50, end: 64 } });
      p({ lrn: 1, type: 'lrn:tap', annotationId: 'NOT-AN-ID' });
    });
    await page.waitForTimeout(800);
    expect(await annotations(page)).toEqual(before.a);
    expect(await notesOf(page)).toEqual(before.n);
    await expect(panel(page)).toBeHidden();
  });

  test('X2 a changed lesson: a note whose text is gone is listed under "Неприкачени" (⚠ on the list button), never lost; an approximate one is "провери" with "Да, тук е"', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'Уязвимостите се докладват без неоправдано забавяне', 'Изчезва');
    await page.keyboard.press('Escape');
    await writeNote(page, 'с последно изречение за бележка', 'Променя се');
    await page.keyboard.press('Escape');
    const changed = BODY
      .replace('<p id="p3">Уязвимостите се докладват без неоправдано забавяне на органите.</p>', '')
      .replace('с последно изречение за бележка', 'с последно изречение за бележки');
    expect(await importCourse(page, C, files(changed))).not.toMatch(/^ERROR/);
    await openLesson(page);
    await expect(page.locator('[data-action="notes-list"] .notes-strip__warn')).toBeVisible({ timeout: 8000 });
    await page.locator('[data-action="notes-list"]').click();
    await expect(page.locator('[data-field="notes-orphans"] .notes-list__body')).toHaveText(['Изчезва']);
    await expect(page.locator('[data-field="notes-list"] .notes-list__item[data-state="fuzzy"] .notes-list__body')).toHaveText(['Променя се']);
    await page.locator('[data-field="notes-list"] [data-action="open-note"]').first().click();
    await page.locator('[data-action="confirm-note-place"]').click();
    await expect(page.locator('[data-field="marks-status"]')).toHaveText('Мястото е потвърдено.');
    expect((await liveNotes(page)).map((n) => n.body).sort()).toEqual(['Изчезва', 'Променя се']);
    // The marks' check list stays for marks: notes are not in it.
    await expect(page.locator('[data-field="marks-check"]')).toBeHidden();
  });

  test('K1 keyboard: the strip is a toolbar (arrows), Escape closes the note and the focus goes back; Escape in the lesson closes it too', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Клавиатура');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await page.locator('[data-action="notes-list"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-action="prev-note"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-action="next-note"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press('Enter'); // ▲ from the top third of the window: the note above it
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('[data-action="prev-note"]')).toBeFocused();
    await noteMarks(page).first().click();
    await expect(panel(page)).toBeVisible();
    const frame = await lessonFrame(page);
    await frame.locator('#p1').click();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });

  test('D1 dark theme and 160 % text: the strip, the panel and the list fit, nothing scrolls sideways', async ({ page }) => {
    await db(page, (db) => db.saveSettings({ theme: 'dark', fontScale: 1.6 }));
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Тъмна тема и голям текст '.repeat(10));
    const colors = await panel(page).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
    expect(colors.bg).not.toBe(colors.fg);
    expect(colors.bg).toBe('rgb(21, 21, 19)');
    await page.locator('[data-action="notes-list"]').click();
    expect(await noHorizontalScroll(page)).toBe(true);
    const p = await panel(page).boundingBox();
    expect(p.x + p.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-017 notes on a phone (360×800 portrait / 800×360 landscape), touch', () => {
  test.use({
    viewport: async ({}, use, info) => use(info.project.name.includes('portrait') ? { width: 360, height: 800 } : { width: 800, height: 360 }),
  });
  test.beforeEach(async ({ page }) => {
    await start(page);
    expect(await importCourse(page, C, files())).not.toMatch(/^ERROR/);
  });

  test('P1 narrow: the strip starts hidden behind "☰" at the right edge; a selection lights "📝 Бележка" next to it; a tap → the note fills the window; the 📝 / list after showing the strip; kept; no horizontal scroll', async ({ page }) => {
    const narrow = page.viewportSize().width < 600;
    await openLesson(page);
    const handle = page.locator('[data-field="notes-strip-handle"]');
    if (narrow) {
      await expect(strip(page)).toBeHidden();
      await expect(handle).toBeVisible();
      const hb = await handle.boundingBox();
      expect(hb.x + hb.width).toBeGreaterThan(page.viewportSize().width - 4);
      expect(hb.width).toBeGreaterThanOrEqual(44);
      await select(page, 'оценява рисковете');
      await expect(quick(page)).toBeVisible({ timeout: 3000 });
      await expect(handle).toHaveAttribute('data-attention', 'true');
      await quick(page).tap();
      await expect(panel(page)).toHaveAttribute('data-layout', 'full');
      const p = await panel(page).boundingBox();
      expect(p.x).toBeLessThanOrEqual(1);
      expect(Math.round(p.width)).toBeGreaterThanOrEqual(page.viewportSize().width - 1);
      await noteText(page).pressSequentially('От телефона');
      await page.locator('[data-action="note-done"]').tap();
      await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['От телефона']);
      expect(await noHorizontalScroll(page)).toBe(true);
      await handle.tap();
      await expect(strip(page)).toBeVisible();
      await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
      expect(await noHorizontalScroll(page)).toBe(true);
      await openLesson(page);
      await expect(strip(page)).toBeVisible(); // the choice is kept
      await page.locator('[data-action="hide-notes"]').tap();
      await expect(handle).toBeVisible();
      await openLesson(page);
      await expect(strip(page)).toBeHidden();
    } else {
      await expect(strip(page)).toBeVisible();
      await writeNote(page, 'оценява рисковете', 'Широк телефон');
      await expect(panel(page)).toHaveAttribute('data-layout', 'side');
      expect(await noHorizontalScroll(page)).toBe(true);
      await page.locator('[data-action="note-done"]').tap();
      await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
      await noteMarks(page).first().tap();
      await expect(noteText(page)).toHaveValue('Широк телефон');
    }
  });

  test('P2 a tap on the noted text (touch) opens the note; 160 % text and the panel fit the phone', async ({ page }) => {
    await db(page, (db) => db.saveSettings({ fontScale: 1.6 }));
    await openLesson(page);
    await select(page, 'Уязвимостите се докладват');
    const button = page.viewportSize().width < 600 ? quick(page) : newNote(page);
    await expect(button).toBeVisible({ timeout: 3000 });
    await button.tap();
    await noteText(page).pressSequentially('Докосване');
    await page.locator('[data-action="note-done"]').tap();
    await expect(panel(page)).toBeHidden();
    await scrollTo(page, 'Уязвимостите се докладват');
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.touchscreen.tap(t.x + 10, t.y);
    await expect(noteText(page)).toHaveValue('Докосване', { timeout: 3000 });
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
