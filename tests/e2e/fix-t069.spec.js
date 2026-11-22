// T-069 (developer, 0.14.1): the fixes of T-018 checked from the other side, and
// the new setting "Ориентация на екрана".
// - T018-D2: a lesson that tries every way it has to take the keyboard while a
//   note is typed (focus, window.focus, a label's click, reportValidity, a modal
//   dialog, designMode + the Selection, a synthetic click, a popover): not one
//   key / character reaches it; after the note closes the lesson works again;
// - T018-D3: the text of an open note survives an immediate reload and a closed
//   tab; a text kept at pagehide is written at the next start (once, no second note);
// - T018-D14: the notes strip follows the width until the user chooses;
// - T018-D5 / D6 / D10: the eraser, "Отмени", "Изтрий", "Върни" and another tab together;
// - T018-D13, T018-I4: a long body in the list / the field; lessonNotes reads one store;
// - the orientation: screen.orientation mocked (lock / unlock recorded), installed
//   or a browser tab, the API missing, a refused lock.
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });
test.use({ trace: 'off' });

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
    if (/ТАЙНА|SECRET/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value) });

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const C = 'LRN-T69';
const L1 = `${C}/lesson:0001`;
const LONG = Array.from({ length: 30 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
const BODY = '<p id="p1">Регламентът за киберустойчивост се прилага за продукти.</p><p id="p2">Производителят оценява рисковете през жизнения цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>';
const files = (script = '') => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', `${BODY}${LONG}${script}`),
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
async function importCourse(page, script = '') {
  const f = asFile(`${C}.zip`, makeZip(toBytes(files(script)), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
  expect(r).not.toMatch(/^ERROR/);
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page) {
  const hash = `#/c/${C}/read/0001`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__lrn.some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const notesOf = (page) => db(page, async (db) => (await db.list('notes', { includeDeleted: true })).map((n) => ({ id: n.id, annotationId: n.annotationId, body: n.body, deleted: !!n.deleted })));
const liveNotes = async (page) => (await notesOf(page)).filter((n) => !n.deleted);
const annotations = (page) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, exact: a.selector.quote.exact, deleted: !!a.deleted, color: a.color })), L1);
const liveAnn = async (page) => (await annotations(page)).filter((a) => !a.deleted);

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
async function textBox(page, needle) {
  const frame = await lessonFrame(page);
  const rel = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      const b = r.getClientRects()[0];
      return { left: b.left, top: b.top, height: b.height };
    }
    throw new Error(`not found: ${needle}`);
  }, needle);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return { x: box.x + rel.left + 4, y: box.y + rel.top + rel.height / 2 };
}
const newNote = (page) => page.locator('[data-action="new-note"]');
const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const noteStatus = (page) => page.locator('[data-field="note-status"]');
const noteMarks = (page) => page.locator('[data-field="notes-marks"] .notes-strip__mark');
const strip = (page) => page.locator('[data-field="notes-strip"]');

async function writeNote(page, needle, text) {
  await select(page, needle);
  await newNote(page).click();
  await expect(noteText(page)).toBeFocused();
  await noteText(page).pressSequentially(text, { delay: 2 });
  await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
}
async function mark(page, needle, color = 'green') {
  const before = (await liveAnn(page)).filter((a) => a.color === color).length;
  await select(page, needle);
  await page.locator(`[data-field="mark-tools"] [data-color="${color}"]`).click();
  await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === color).length, { timeout: 5000 }).toBeGreaterThan(before);
  await page.keyboard.press('Escape');
}
async function eraseOver(page, needle) {
  await page.locator('[data-field="mark-tools"] [data-tool="eraser"]').click();
  const box = await textBox(page, needle);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y, { steps: 6 });
  await page.mouse.up();
}
async function noteOnMark(page, needle, text) {
  const t = await textBox(page, needle);
  await page.mouse.click(t.x + 20, t.y);
  await page.locator('[data-action="add-note-to-mark"]').click();
  await noteText(page).pressSequentially(text);
  await page.locator('[data-action="note-done"]').click();
  await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toContain(text);
}

// ===========================================================================
test.describe('T069-K the keys of a note never reach the lesson (T018-D2)', () => {
  // Every way a lesson has to take the keyboard, in turn every 20 ms, from the
  // moment the test says "go" (the user opened the note).
  const THIEF = `<input id="v1" aria-label="v1"><label for="v2" id="lb">поле</label><input id="v2" aria-label="v2">
    <form id="fm" onsubmit="return false"><input id="v3" required aria-label="v3"></form>
    <dialog id="dg"><input id="v4" autofocus aria-label="v4"></dialog><div id="ed">редактируемо място</div>
    <div id="pp" popover><input id="v5" autofocus aria-label="v5"></div><textarea id="v6" aria-label="v6"></textarea>
    <script>
      window.__keys = '';
      const log = (e) => { if (window.__go) window.__keys += e.type[0] + (e.key || e.data || ''); };
      for (const t of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionend', 'paste']) { window.addEventListener(t, log, true); document.addEventListener(t, log, true); }
      let i = 0;
      setInterval(() => {
        if (!window.__go) return;
        const k = i++ % 10;
        try {
          if (k === 0) document.getElementById('v1').focus();
          if (k === 1) window.focus();
          if (k === 2) document.getElementById('lb').click();
          if (k === 3) document.getElementById('fm').reportValidity();
          if (k === 4) { const d = document.getElementById('dg'); if (d.open) d.close(); d.showModal(); }
          if (k === 5) { document.designMode = 'on'; getSelection().collapse(document.getElementById('ed').firstChild, 3); }
          if (k === 6) document.getElementById('lb').dispatchEvent(new MouseEvent('click', { bubbles: true }));
          if (k === 7) { const p = document.getElementById('pp'); try { p.hidePopover(); } catch (e) {} p.showPopover(); }
          if (k === 8) { document.getElementById('v6').select(); }
          if (k === 9) { document.getElementById('v6').setSelectionRange(0, 0); document.getElementById('v6').focus({ preventScroll: true }); }
        } catch (e) { /* the guard said no */ }
        window.__vals = [...document.querySelectorAll('input, textarea')].map((x) => x.value).join('|') + '|' + document.getElementById('ed').textContent;
      }, 20);
    </script>`;

  test('T069-K1 every way to take the focus, while the user types (ASCII, Cyrillic, Enter, Backspace, paste): nothing reaches the lesson, the note has it all; closed: the lesson works again', async ({ page }) => {
    await start(page);
    await importCourse(page, THIEF);
    const frame = await openLesson(page);
    await select(page, 'оценява рисковете');
    await newNote(page).click();
    await expect(noteText(page)).toBeFocused();
    await frame.evaluate(() => { window.__go = true; });
    await page.waitForTimeout(300);
    await page.keyboard.type('Secret 123 ', { delay: 25 });
    await page.keyboard.type('ТАЙНА бележка', { delay: 25 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('ред2x', { delay: 25 });
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    const seen = await frame.evaluate(() => ({ keys: window.__keys, vals: window.__vals }));
    const value = await noteText(page).inputValue();
    info('T069-K1', { seen, value });
    expect(seen.keys).toBe('');
    expect(seen.vals).not.toMatch(/Secret|ТАЙНА|ред2/);
    expect(value).toBe('Secret 123 ТАЙНА бележка\nред2');
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    // The note closes: the keys are the lesson's again (the guard is off).
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await page.waitForTimeout(300);
    await page.keyboard.type('zz', { delay: 40 });
    await page.waitForTimeout(300);
    const after = await frame.evaluate(() => window.__keys);
    info('T069-K1 after close', after);
    expect(after).toContain('z');
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Secret 123 ТАЙНА бележка\nред2']);
    problems = problems.filter((p) => !/ТАЙНА|Secret/.test(p));
  });

  test('T069-K2 a forged "lrn:keys" from the lesson itself (to its own window) does not switch the guard; a tap on the lesson while the note is open leaves the field (the next one reaches the lesson)', async ({ page }) => {
    await start(page);
    await importCourse(page, '<input id="own" aria-label="own"><script>window.__k = ""; document.getElementById("own").addEventListener("input", (e) => { window.__k = e.target.value; });</script>');
    const frame = await openLesson(page);
    await select(page, 'оценява рисковете');
    await newNote(page).click();
    await expect(noteText(page)).toBeFocused();
    await expect(page.locator('iframe.lesson-frame')).toHaveAttribute('data-note-guard', 'on');
    // The lesson posts "off" to itself and tries again: the guard listens to the parent only.
    const res = await frame.evaluate(() => {
      window.postMessage({ lrn: 1, type: 'lrn:keys', off: false }, '*');
      return new Promise((r) => setTimeout(() => { document.getElementById('own').focus(); r(document.activeElement?.id || document.activeElement?.tagName); }, 100));
    });
    info('T069-K2 the lesson\'s focus after its own "off"', res);
    expect(res).not.toBe('own');
    await page.keyboard.type('Ключ', { delay: 20 });
    expect(await frame.evaluate(() => window.__k)).toBe('');
    // The user taps the lesson: the field is left; then the lesson's own field works.
    await frame.evaluate(() => document.getElementById('own').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    const own = await page.locator('iframe.lesson-frame').boundingBox();
    const b2 = await frame.evaluate(() => { const r = document.getElementById('own').getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; });
    await page.mouse.click(own.x + b2.x, own.y + b2.y);
    await expect(page.locator('iframe.lesson-frame')).not.toHaveAttribute('data-note-guard', 'on');
    await page.mouse.click(own.x + b2.x, own.y + b2.y);
    await page.keyboard.type('урок', { delay: 20 });
    await expect.poll(() => frame.evaluate(() => window.__k)).toBe('урок');
    await expect(noteText(page)).toHaveValue('Ключ');
  });
});

// ===========================================================================
test.describe('T069-S the last words are kept (T018-D3)', () => {
  test.beforeEach(async ({ page }) => { await start(page); await importCourse(page); });

  test('T069-S1 typed and reloaded at once (0 ms), a new note too; typed and the tab closed: the next tab has it', async ({ page, context }) => {
    await openLesson(page);
    await select(page, 'оценява рисковете');
    await newNote(page).click();
    await noteText(page).pressSequentially('Нова и веднага', { delay: 2 });
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body), { timeout: 5000 }).toEqual(['Нова и веднага']);
    await expect(noteMarks(page)).toHaveCount(1, { timeout: 8000 });
    await noteMarks(page).first().click();
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' + затворен раздел', { delay: 2 });
    await page.close({ runBeforeUnload: true });
    const other = await context.newPage();
    other.on('pageerror', (e) => problems.push(`other: ${e}`));
    await other.goto(`./#/c/${C}/read/0001`);
    await waitReady(other);
    await expect.poll(async () => (await liveNotes(other)).map((n) => n.body), { timeout: 5000 }).toEqual(['Нова и веднага + затворен раздел']);
    expect((await liveNotes(other)).length).toBe(1);
  });

  test('T069-S2 visibilitychange → hidden keeps the text synchronously; a kept text is written at the next start once (no second note for a new one, an old copy never overwrites a newer save)', async ({ page }) => {
    await openLesson(page);
    await select(page, 'Уязвимостите се докладват');
    await newNote(page).click();
    await noteText(page).pressSequentially('Скрит раздел', { delay: 2 });
    const kept = await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      return JSON.parse(localStorage.getItem('lrn-note-pending') || 'null');
    });
    info('T069-S2 kept', kept);
    expect(kept?.body).toBe('Скрит раздел');
    expect(kept?.lessonId).toBe(L1);
    // The async save finishes: the kept copy is dropped.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lrn-note-pending')), { timeout: 5000 }).toBeNull();
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Скрит раздел']);
    // A page killed between the two: the kept copy of a NEW note (selection draft) whose async save made it already.
    await page.evaluate((k) => localStorage.setItem('lrn-note-pending', JSON.stringify({ ...k, body: 'Скрит раздел и още' })), kept);
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body), { timeout: 5000 }).toEqual(['Скрит раздел и още']);
    expect(await page.evaluate(() => localStorage.getItem('lrn-note-pending'))).toBeNull();
    // A kept copy for a lesson that does not exist / garbage: dropped, nothing made.
    await page.evaluate(() => localStorage.setItem('lrn-note-pending', JSON.stringify({ courseId: 'X', lessonId: 'X/lesson:9', draft: { selection: {} }, body: 'нищо' })));
    await page.reload();
    await waitReady(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lrn-note-pending'))).toBeNull();
    await page.evaluate(() => localStorage.setItem('lrn-note-pending', '{not json'));
    await page.reload();
    await waitReady(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lrn-note-pending'))).toBeNull();
    expect((await notesOf(page)).length).toBe(1);
    problems = problems.filter((p) => !/Cannot write the kept note/.test(p));
  });
});

// ===========================================================================
test.describe('T069-W the strip follows the width until the user chooses (T018-D14)', () => {
  test.beforeEach(async ({ page }) => { await start(page); await importCourse(page); });

  test('T069-W1 1920 → 360 → 1920 without a choice: hidden, shown again; after "Скрий" at 1920 it stays hidden at any width; after "☰" at 360 it stays shown', async ({ page }, ti) => {
    test.skip(ti.project.name.includes('portrait'), 'one width run is enough');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openLesson(page);
    await expect(strip(page)).toBeVisible();
    await page.setViewportSize({ width: 360, height: 640 });
    await expect(strip(page)).toBeHidden();
    const f = await page.locator('iframe.lesson-frame').boundingBox();
    expect(f.width).toBeGreaterThan(180);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(strip(page)).toBeVisible();
    // The user's choice wins from now on.
    await page.locator('[data-action="hide-notes"]').click();
    await expect(strip(page)).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(200);
    await expect(strip(page)).toBeHidden();
    await page.setViewportSize({ width: 360, height: 640 });
    await page.locator('[data-field="notes-strip-handle"]').click();
    await expect(strip(page)).toBeVisible();
    await page.setViewportSize({ width: 400, height: 700 });
    await page.waitForTimeout(200);
    await expect(strip(page)).toBeVisible();
    expect(await db(page, async (db) => (await db.getSettings()).notesStrip)).toEqual({ hidden: false });
  });
});

// ===========================================================================
test.describe('T069-U the eraser, "Отмени", "Изтрий", "Върни" and two tabs (T018-D5, D6, D10)', () => {
  test.beforeEach(async ({ page }) => { await start(page); await importCourse(page); });

  test('T069-U1 D6 then "Отмени" of the eraser: the note comes back as a place, then the mark gets its colour back; D5 then "Върни": the mark is coloured and the note is there', async ({ page }) => {
    await openLesson(page);
    await mark(page, 'Уязвимостите се докладват', 'green');
    await noteOnMark(page, 'Уязвимостите се докладват', 'Първа');
    // D6: "Изтрий" → the eraser → "Върни" → "Отмени" (of the eraser).
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await eraseOver(page, 'Уязвимостите се докладват');
    await expect.poll(async () => (await liveAnn(page)).length).toBe(0);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.color)).toEqual([null]);
    await expect(page.locator('[data-field="notes-count"]')).toHaveText('1');
    await page.keyboard.press('Escape');
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.color)).toEqual(['green']);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Първа']);
    // D5: the eraser (colour only) → "Изтрий" (the place goes) → "Отмени" → "Върни".
    await eraseOver(page, 'Уязвимостите се докладват');
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.color)).toEqual([null]);
    await page.keyboard.press('Escape');
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await expect.poll(async () => (await liveAnn(page)).length).toBe(0);
    await page.locator('[data-field="mark-tools"] [data-action="undo"]').click();
    await expect.poll(async () => (await liveAnn(page)).map((a) => a.color)).toEqual(['green']);
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['Първа']);
    expect((await liveAnn(page)).map((a) => a.color)).toEqual(['green']);
    await expect(page.locator('[data-field="notes-count"]')).toHaveText('1');
  });

  test('T069-U2 D10: deleted in tab A (a note-only place: the place goes too), written on in tab B → the note and its place come back with all the text, B says so', async ({ page, context }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Начало');
    await page.keyboard.press('Escape');
    const other = await context.newPage();
    other.on('pageerror', (e) => problems.push(`other: ${e}`));
    await other.goto(`./#/c/${C}/read/0001`);
    await waitReady(other);
    await other.locator('[data-field="notes-marks"] .notes-strip__mark').first().click();
    await expect(other.locator('[data-field="note-text"]')).toHaveValue('Начало');
    await page.bringToFront();
    await noteMarks(page).first().click();
    await page.locator('[data-action="delete-note"]').click();
    await expect.poll(async () => (await liveAnn(page)).length).toBe(0);
    await other.bringToFront();
    await other.locator('[data-field="note-text"]').press('End');
    await other.locator('[data-field="note-text"]').pressSequentially(' и още');
    await expect(other.locator('[data-field="note-status"]')).toContainText('върната', { timeout: 6000 });
    await other.keyboard.press('Escape');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body)).toEqual(['Начало и още']);
    expect((await liveAnn(page)).map((a) => a.color)).toEqual([null]);
    await expect(other.locator('[data-field="notes-count"]')).toHaveText('1');
    await other.close();
  });
});

// ===========================================================================
test.describe('T069-B long bodies and one read (T018-D13, T018-I4)', () => {
  test.beforeEach(async ({ page }) => { await start(page); await importCourse(page); });

  test('T069-B1 a body of 1 MB with words from a backup: the list shows 2000 characters and "…", the field 20 000 with a hint; the database keeps it all until the note is edited', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Кратко');
    await page.keyboard.press('Escape');
    const big = 'дума '.repeat(200000);
    await db(page, async (db, big) => { const n = (await db.list('notes'))[0]; await db.update('notes', n.id, { body: big }); }, big);
    await openLesson(page);
    await page.locator('[data-action="notes-list"]').click();
    const shown = await page.locator('[data-field="notes-list"] .notes-list__body').innerText();
    expect(shown.length).toBeLessThan(2100);
    expect(shown.trim().endsWith('…')).toBe(true);
    await page.locator('[data-field="notes-list"] [data-action="open-note"]').click();
    expect((await noteText(page).inputValue()).length).toBe(20000);
    await expect(page.locator('[data-field="note-too-long"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect((await liveNotes(page))[0].body.length).toBe(big.length); // not edited: kept whole
  });

  test('T069-B2 lessonNotes: only this lesson\'s annotations, the oldest live note of each, deleted notes and other lessons\' notes left out, in the stored order', async ({ page }) => {
    await openLesson(page);
    const out = await page.evaluate(async ({ C, L1 }) => {
      const db = await import('./src/db.js');
      const notes = await import('./src/notes.js');
      const lesson = await db.getLesson(L1);
      const a1 = await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: L1 }, selector: { quote: { exact: 'a' }, position: { start: 1, end: 2 } }, color: null, style: 'highlight', anchorState: 'ok' });
      const a2 = await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: L1 }, selector: { quote: { exact: 'b' }, position: { start: 3, end: 4 } }, color: 'yellow', style: 'highlight', anchorState: 'ok' });
      const aX = await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: `${C}/lesson:0002` }, selector: { quote: { exact: 'x' }, position: { start: 1, end: 2 } }, color: null, style: 'highlight', anchorState: 'ok' });
      const n1 = await db.createNote({ courseId: C, annotationId: a1.id, body: 'първа' });
      await db.createNote({ courseId: C, annotationId: a1.id, body: 'втора на същото' });
      const gone = await db.createNote({ courseId: C, annotationId: a2.id, body: 'изтрита' });
      await db.remove('notes', gone.id);
      await db.createNote({ courseId: C, annotationId: aX.id, body: 'друг урок' });
      const n2b = await db.createNote({ courseId: C, annotationId: a2.id, body: 'жива на a2' });
      const list = await notes.lessonNotes(lesson);
      return { got: list.map((x) => [x.annotation.id === a1.id ? 'a1' : x.annotation.id === a2.id ? 'a2' : '?', x.note.body]), n1: n1.id, n2b: n2b.id };
    }, { C, L1 });
    expect(out.got).toEqual([['a1', 'първа'], ['a2', 'жива на a2']]);
  });
});

// ===========================================================================
// The screen orientation (T-069). screen.orientation and the display mode are mocked.
async function mockOrientation(page, { api = true, installed = true, refuse = false } = {}) {
  await page.addInitScript(({ api, installed, refuse }) => {
    if (window.top !== window) return;
    window.__orient = [];
    if (api) {
      const fake = {
        type: 'landscape-primary', angle: 0, onchange: null,
        lock: (o) => { window.__orient.push(`lock:${o}`); return refuse ? Promise.reject(new DOMException('not allowed', 'NotSupportedError')) : Promise.resolve(); },
        unlock: () => { window.__orient.push('unlock'); },
        addEventListener() {}, removeEventListener() {},
      };
      Object.defineProperty(screen, 'orientation', { configurable: true, get: () => fake });
    } else {
      Object.defineProperty(screen, 'orientation', { configurable: true, get: () => undefined });
    }
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: installed, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q));
  }, { api, installed, refuse });
}
const orient = (page) => page.evaluate(() => window.__orient);
async function openSettings(page) {
  await page.goto('./#/settings');
  await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
}
const oInput = (page, o) => page.locator(`[data-field="orientation-${o}"]`);
const oHint = (page) => page.locator('[data-field="orientation-hint"]');

test.describe('T069-O "Ориентация на екрана" in Настройки', () => {
  test('T069-O1 installed: Автоматично by default (unlock at start); Портрет → lock("portrait"), kept, applied again at the next start; Пейзаж; Автоматично → unlock', async ({ page }) => {
    await mockOrientation(page);
    await start(page);
    expect(await orient(page)).toEqual(['unlock']);
    await openSettings(page);
    await expect(page.locator('[data-field="orientation"]')).toHaveAttribute('data-support', 'ok');
    await expect(oInput(page, 'auto')).toBeChecked();
    for (const o of ['auto', 'portrait', 'landscape']) await expect(oInput(page, o)).toBeEnabled();
    await page.locator('label[for="settings-orientation-portrait"]').click();
    await expect.poll(() => orient(page)).toContain('lock:portrait');
    expect(await db(page, async (db) => (await db.getSettings()).orientation)).toBe('portrait');
    await page.reload();
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect.poll(() => orient(page)).toEqual(['lock:portrait']);
    await expect(oInput(page, 'portrait')).toBeChecked();
    await page.locator('label[for="settings-orientation-landscape"]').click();
    await expect.poll(() => orient(page)).toContain('lock:landscape');
    await oInput(page, 'auto').check();
    await expect.poll(() => (orient(page)).then((l) => l.at(-1))).toBe('unlock');
    // Another setting saved (the theme) does not lock / unlock again.
    const n = (await orient(page)).length;
    await page.locator('label[for="settings-theme-dark"]').click();
    await page.waitForTimeout(300);
    expect((await orient(page)).length).toBe(n);
    // Keyboard: the radio group.
    await oInput(page, 'auto').focus();
    await page.keyboard.press('ArrowRight');
    await expect(oInput(page, 'portrait')).toBeChecked();
    await expect.poll(() => (orient(page)).then((l) => l.at(-1))).toBe('lock:portrait');
  });

  test('T069-O2 a browser tab (not installed): the choice is active with "Работи, когато EasyLRN е инсталирано на началния екран"; the refused lock is no error and the choice is kept', async ({ page }) => {
    await mockOrientation(page, { installed: false, refuse: true });
    await start(page);
    await openSettings(page);
    await expect(page.locator('[data-field="orientation"]')).toHaveAttribute('data-support', 'installed-only');
    await expect(oHint(page)).toContainText('Работи, когато EasyLRN е инсталирано на началния екран');
    await expect(oInput(page, 'portrait')).toBeEnabled();
    await page.locator('label[for="settings-orientation-portrait"]').click();
    await expect.poll(() => orient(page)).toContain('lock:portrait');
    await page.waitForTimeout(200);
    await expect(oHint(page)).toContainText('Работи, когато EasyLRN е инсталирано');
    expect(await db(page, async (db) => (await db.getSettings()).orientation)).toBe('portrait');
  });

  test('T069-O3 installed but the device refuses the lock: a short message, the choice kept; no API at all: the choice is inactive with the reason', async ({ page, context }) => {
    await mockOrientation(page, { installed: true, refuse: true });
    await start(page);
    await openSettings(page);
    await page.locator('label[for="settings-orientation-landscape"]').click();
    await expect(oHint(page)).toContainText('Устройството не позволи заключването');
    expect(await db(page, async (db) => (await db.getSettings()).orientation)).toBe('landscape');
    const p2 = await context.newPage();
    p2.on('pageerror', (e) => problems.push(`p2: ${e}`));
    await mockOrientation(p2, { api: false });
    await p2.goto('./#/settings');
    await expect(p2.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect(p2.locator('[data-field="orientation"]')).toHaveAttribute('data-support', 'none');
    for (const o of ['auto', 'portrait', 'landscape']) await expect(p2.locator(`[data-field="orientation-${o}"]`)).toBeDisabled();
    await expect(p2.locator('[data-field="orientation-landscape"]')).toBeChecked(); // the stored choice is still shown
    await expect(p2.locator('[data-field="orientation-hint"]')).toContainText('не може да заключва ориентацията');
    await p2.close();
  });

  test('T069-O4 a stored value that is not one of the three (hand-edited / an old backup) means Автоматично; the settings screen shows 0.14.1', async ({ page }) => {
    await mockOrientation(page);
    await start(page);
    await db(page, (db) => db.saveSettings({ orientation: 'upside-down' }));
    await page.reload();
    await openSettings(page);
    await expect(oInput(page, 'auto')).toBeChecked();
    expect(await orient(page)).not.toContain('lock:upside-down');
    await expect(page.locator('[data-field="version"]')).toHaveText('0.14.1');
  });
});
