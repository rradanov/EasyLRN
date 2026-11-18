// T-007-fix (developer): extra checks for T008-D1…D4 and the observations
// Н-1 (empty ZIP) and Н-5 ("Без промени" keeps updatedAt). The tester's
// original cases are in import-t008.spec.js (now marked FIXED).
import { test, expect } from '@playwright/test';
import { deflateSync, strToU8 } from '../../vendor/fflate.js';
import { DRIVE_ZIP_NAME, readFixture, makeZip, splitZips, asFile } from '../fixtures/zips.mjs';
import { rawZip, crc32 } from '../fixtures/rawzip.mjs';

const FILES = readFixture();
const LESSON_PATH = 'lessons/0001-vidove-chay.html';
const LESSON = FILES[LESSON_PATH];

let consoleErrors;
test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});
test.afterEach(() => { expect(consoleErrors).toEqual([]); });

/** importCourse() in the page; returns { ok, s, line } or { ok: false, error } plus stored paths and lessons. */
function imp(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const db = await import('./src/db.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name, { type: f.type || '' }));
    let out;
    const t0 = performance.now();
    try { const s = await m.importCourse(list); out = { ok: true, s, line: m.describeSummary(s) }; }
    catch (e) { out = { ok: false, error: m.errorMessage(e), cause: e.cause?.reason ?? null }; }
    out.ms = performance.now() - t0;
    const course = await db.getCourse('LRN-DEMO');
    out.course = course && { updatedAt: course.updatedAt, index: course.meta?.index ?? null };
    out.paths = course ? (await db.listCourseFiles('LRN-DEMO')).map((f) => f.path).sort() : [];
    out.lessons = (await db.listLessons('LRN-DEMO')).map((l) => ({ number: l.number, artifactId: l.artifactId, indexTitle: l.indexTitle, order: l.order }));
    return out;
  }, (Array.isArray(files) ? files : [files]).map((f) => ({ name: f.name, type: f.mimeType, bytes: [...f.buffer] })));
}
const full = () => asFile(DRIVE_ZIP_NAME, makeZip(FILES));
const IMPORTED = Object.keys(FILES).filter((p) => !p.endsWith('.pdf')).length;

test.describe('T008-D1: names from a repeated download', () => {
  test('stripDownloadSuffix() keeps real names and removes only " (N)" before the extension', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { stripDownloadSuffix, pathForLooseFile } = await import('./src/course-import.js');
      return ['0001-a (1).html', '0001-a(2).html', 'INDEX (1).md', 'R01-x (12).html', 'style (3).css', 'MISSION (1)',
        '0001-a.html', '0002-глава (част 1).html', '0003-a (2026).html']
        .map((n) => [n, stripDownloadSuffix(n), pathForLooseFile(stripDownloadSuffix(n))]);
    });
    expect(r).toEqual([
      ['0001-a (1).html', '0001-a.html', 'lessons/0001-a.html'],
      ['0001-a(2).html', '0001-a.html', 'lessons/0001-a.html'],
      ['INDEX (1).md', 'INDEX.md', 'INDEX.md'],
      ['R01-x (12).html', 'R01-x.html', 'reference/R01-x.html'],
      ['style (3).css', 'style.css', 'assets/style.css'],
      ['MISSION (1)', 'MISSION', 'MISSION'],
      ['0001-a.html', '0001-a.html', 'lessons/0001-a.html'],
      ['0002-глава (част 1).html', '0002-глава (част 1).html', 'lessons/0002-глава (част 1).html'],
      ['0003-a (2026).html', '0003-a (2026).html', 'lessons/0003-a (2026).html'],
    ]);
  });

  test('"INDEX (1).md" and a changed "0001-… (2).html" update the course instead of adding files', async ({ page }) => {
    await imp(page, full());
    const index = new TextDecoder().decode(FILES['INDEX.md']).replace('## План (чернова)', '## План (обновен)');
    const lesson = new TextDecoder().decode(LESSON).replace('</h1>', '</h1>\n<p>Нов абзац.</p>');
    const r = await imp(page, [
      asFile('INDEX (1).md', Buffer.from(index), 'text/markdown'),
      asFile('0001-vidove-chay (2).html', Buffer.from(lesson), 'text/html'),
    ]);
    expect(r.ok).toBe(true);
    expect(r.s.status).toBe('updated');
    expect(r.s.lessons).toMatchObject({ added: [], changed: ['0001 Какви видове чай има?'] });
    expect(r.s.files).toMatchObject({ added: 0, changed: 2 });
    expect(r.paths).toHaveLength(IMPORTED);
    expect(r.course.index).toContain('## План (обновен)');
    expect(r.lessons.map((l) => l.number)).toEqual(['0001', 'R01']);
  });
});

test.describe('T008-D2: CRC-32 and broken data', () => {
  test('a deflated entry with flipped bytes is refused (CRC or inflate error), nothing is stored', async ({ page }) => {
    const data = deflateSync(LESSON);
    const bad = Uint8Array.from(data);
    for (let i = 0; i < 4; i++) bad[Math.floor(bad.length * 0.7) + i] ^= 0x55;
    const r = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: bad, method: 8, raw: LESSON },
      { name: 'LRN-DEMO/MISSION.md', data: FILES['MISSION.md'] },
    ])));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Файлът „LRN-DEMO.zip“ не може да се отвори: ZIP архивът е повреден или непълен.');
    expect(r.paths).toEqual([]);
  });

  test('a correct deflated rawZip (control) imports, so the check is not too strict', async ({ page }) => {
    const r = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: deflateSync(LESSON), method: 8, raw: LESSON },
    ])));
    expect(r.ok).toBe(true);
    expect(r.paths).toEqual([LESSON_PATH]);
  });

  test('the wrong CRC is the reason (not something else)', async ({ page }) => {
    const r = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: deflateSync(LESSON), method: 8, raw: LESSON, crc: crc32(LESSON) ^ 1 },
    ])));
    expect(r).toMatchObject({ ok: false, cause: 'CRC-32 mismatch' });
  });
});

test.describe('T008-D3: limits before and during unpacking', () => {
  test('an entry that inflates past its declared size is stopped at once (lying header)', async ({ page }) => {
    const zeros = new Uint8Array(30 * 1048576);
    const r = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: deflateSync(zeros), method: 8, size: 1000, crc: 0 },
    ])));
    expect(r).toMatchObject({ ok: false, cause: 'entry larger than declared', paths: [] });
    expect(r.error).toContain('повреден или непълен');
    expect(r.ms).toBeLessThan(1000);
  });

  test('the total is checked over several ZIPs together, before the second is unpacked', async ({ page }) => {
    const big = (i) => asFile(`LRN-DEMO-20261118T090000Z-1-00${i}.zip`, Buffer.from(rawZip(
      [...Array(3)].map((_, j) => ({ name: `LRN-DEMO/assets/p${i}-${j}.js`, data: deflateSync(new Uint8Array(1)), method: 8, size: 40 * 1048576, crc: 0 })),
    )));
    // 2 × 3 × 40 MB declared = 240 MB > 200 MB; the entries are tiny and would fail the size check if unpacked.
    const r = await imp(page, [big(1), big(2)]);
    expect(r).toMatchObject({ ok: false, error: 'Курсът е твърде голям (над 200 MB без PDF-ите).' });
  });

  test('too many files is refused from the central directory', async ({ page }) => {
    const r = await imp(page, asFile('LRN-DEMO.zip', rawZip(
      [...Array(2001)].map((_, i) => ({ name: `LRN-DEMO/assets/f${i}.css`, data: strToU8('a') })),
    )));
    expect(r).toMatchObject({ ok: false, error: 'Твърде много файлове (над 2000). Това не прилича на курс.' });
  });
});

test.describe('T008-D4 and "Без промени"', () => {
  test('part 2 without INDEX.md: "Без промени", artifactId/indexTitle kept, course updatedAt kept', async ({ page }) => {
    const first = await imp(page, full());
    const before = first.lessons;
    const r = await imp(page, [splitZips(FILES, 2)[1]]);
    expect(r.s.status).toBe('unchanged');
    expect(r.line).toMatch(/^Без промени\./);
    expect(r.lessons).toEqual(before);
    expect(r.lessons[0]).toMatchObject({ artifactId: 'DemoArtifact0001', indexTitle: 'Какви видове чай има? (тест от 3 въпроса)' });
    expect(r.course.updatedAt).toBe(first.course.updatedAt);
  });

  test('a loose lesson alone (same content) is "Без промени" and keeps its artifactId', async ({ page }) => {
    await imp(page, full());
    const r = await imp(page, [asFile('0001-vidove-chay.html', Buffer.from(LESSON), 'text/html')]);
    expect(r.s.status).toBe('unchanged');
    expect(r.lessons.find((l) => l.number === '0001').artifactId).toBe('DemoArtifact0001');
  });

  test('a loose new lesson without INDEX.md takes its place after the indexed ones', async ({ page }) => {
    await imp(page, full());
    const r = await imp(page, [asFile('0002-zelen.html', Buffer.from('<p class="kicker">LRN-DEMO · Урок 0002</p><h1>Зелен чай</h1>'), 'text/html')]);
    expect(r.s.status).toBe('updated');
    expect(r.line).toContain('нови уроци: 1, променени: 0');
    expect(r.lessons.map((l) => `${l.order} ${l.number} ${l.artifactId}`)).toEqual(['1 0001 DemoArtifact0001', '2 0002 null', '3 R01 DemoArtifactR01']);
  });

  test('UI: an empty ZIP says "ZIP архивът е празен."', async ({ page }) => {
    await page.locator('[data-input="zip"]').setInputFiles(asFile('LRN-DEMO.zip', rawZip([])));
    await expect(page.locator('[data-field="import-error"]')).toHaveText('ZIP архивът е празен.');
  });
});
