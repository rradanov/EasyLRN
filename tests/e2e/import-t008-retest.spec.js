// T-008-retest (tester, with T-010): independent checks of the T-007-fix
// changes for T008-D1…D4 and the observations Н-1 (empty ZIP) and Н-5
// ("Без промени" keeps updatedAt). Different inputs from the developer's
// import-t007fix.spec.js on purpose. Synthetic course LRN-DEMO only (D-026).
import { test, expect } from '@playwright/test';
import { deflateSync, strToU8 } from '../../vendor/fflate.js';
import { DRIVE_ZIP_NAME, readFixture, makeZip, splitZips, asFile } from '../fixtures/zips.mjs';
import { rawZip, crc32 } from '../fixtures/rawzip.mjs';

const FILES = readFixture();
const LESSON_PATH = 'lessons/0001-vidove-chay.html';
const REF_PATH = 'reference/R01-temperatura-i-vreme.html';
const IMPORTED = Object.keys(FILES).filter((p) => !p.endsWith('.pdf')).length;
const dec = (u8) => new TextDecoder().decode(u8);

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});
test.afterEach(() => { expect(errors).toEqual([]); });

/** Import in the page; returns the result plus a snapshot of the stored course. */
function imp(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const db = await import('./src/db.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name, { type: f.type || '' }));
    let out;
    const t0 = performance.now();
    try { const s = await m.importCourse(list); out = { ok: true, status: s.status, line: m.describeSummary(s) }; }
    catch (e) { out = { ok: false, error: m.errorMessage(e) }; }
    out.ms = Math.round(performance.now() - t0);
    const c = await db.getCourse('LRN-DEMO');
    out.course = c && { updatedAt: c.updatedAt, importedAt: c.importedAt };
    const files2 = c ? await db.listCourseFiles('LRN-DEMO') : [];
    out.paths = files2.map((f) => f.path).sort();
    out.fileStamps = Object.fromEntries(files2.map((f) => [f.path, `${f.sha256}|${f.updatedAt}`]));
    out.lessons = (await db.listLessons('LRN-DEMO')).map((l) => ({ n: l.number, a: l.artifactId, t: l.indexTitle, o: l.order, p: l.progress?.scrollY ?? null }));
    return out;
  }, (Array.isArray(files) ? files : [files]).map((f) => ({ name: f.name, type: f.mimeType, bytes: [...f.buffer] })));
}
const full = () => asFile(DRIVE_ZIP_NAME, makeZip(FILES));

test.describe('T008-D1 retest', () => {
  test('"R01-… (1).html", "style (2).css" and "0001-… (1).HTML" replace their files; no new lesson or file', async ({ page }) => {
    const first = await imp(page, full());
    const ref = dec(FILES[REF_PATH]).replace('</h1>', '</h1><p>R01 нов ред.</p>');
    const r = await imp(page, [
      asFile('R01-temperatura-i-vreme (1).html', Buffer.from(ref), 'text/html'),
      asFile('style (2).css', Buffer.from(FILES['assets/style.css']), 'text/css'),
      asFile('0001-vidove-chay (1).html', Buffer.from(FILES[LESSON_PATH]), 'text/html'),
    ]);
    expect(r.ok).toBe(true);
    expect(r.paths).toEqual(first.paths);
    expect(r.lessons.map((l) => l.n)).toEqual(['0001', 'R01']);
    expect(r.line).toMatch(/променени: 1/);
  });

  test('[T010-D1] "0001-….HTML" (upper-case extension) replaces lesson 0001 instead of adding a second 0001', async ({ page }) => {
    const first = await imp(page, full());
    const r = await imp(page, [asFile('0001-vidove-chay.HTML', Buffer.from(FILES[LESSON_PATH]), 'text/html')]);
    expect(r.paths).toEqual(first.paths);
    expect(r.lessons.map((l) => l.n)).toEqual(['0001', 'R01']);
  });
});

test.describe('T008-D2 retest', () => {
  test('a STORED entry with a wrong CRC and a truncated STORED entry are refused, nothing stored', async ({ page }) => {
    const msg = 'Файлът „LRN-DEMO.zip“ не може да се отвори: ZIP архивът е повреден или непълен.';
    const a = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: FILES[LESSON_PATH], crc: crc32(FILES[LESSON_PATH]) ^ 0x80 },
    ])));
    expect(a).toMatchObject({ ok: false, error: msg, paths: [] });
    // One byte changed in a STORED entry (CRC kept from the original).
    const bad = Uint8Array.from(FILES[LESSON_PATH]); bad[100] ^= 1;
    const b = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: bad, crc: crc32(FILES[LESSON_PATH]) },
    ])));
    expect(b).toMatchObject({ ok: false, error: msg, paths: [] });
    // Deflated entry that ends early (declared size bigger than the real data).
    const c = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: deflateSync(FILES[LESSON_PATH]), method: 8, raw: FILES[LESSON_PATH], size: FILES[LESSON_PATH].length + 50 },
    ])));
    expect(c).toMatchObject({ ok: false, error: msg, paths: [] });
  });
});

test.describe('T008-D3 retest', () => {
  test('declared sizes over the limits are refused in milliseconds, before any unpacking', async ({ page }) => {
    const tiny = deflateSync(new Uint8Array(1));
    const total = await imp(page, asFile('LRN-DEMO.zip', rawZip(
      [...Array(5)].map((_, i) => ({ name: `LRN-DEMO/assets/x${i}.js`, data: tiny, method: 8, size: 45 * 1048576, crc: 0 })),
    )));
    expect(total).toMatchObject({ ok: false, error: 'Курсът е твърде голям (над 200 MB без PDF-ите).', paths: [] });
    expect(total.ms).toBeLessThan(500);
    const one = await imp(page, asFile('LRN-DEMO.zip', rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: tiny, method: 8, size: 60 * 1048576, crc: 0 },
    ])));
    expect(one.ok).toBe(false);
    expect(one.error).toMatch(/твърде голям/);
    expect(one.ms).toBeLessThan(500);
  });
});

test.describe('T008-D4 retest', () => {
  test('a ZIP with only R01 (no INDEX.md) and a ZIP with only assets keep artifactId/indexTitle/order', async ({ page }) => {
    const first = await imp(page, full());
    const onlyRef = await imp(page, asFile('LRN-DEMO.zip', makeZip({ [REF_PATH]: FILES[REF_PATH] })));
    expect(onlyRef.status).toBe('unchanged');
    expect(onlyRef.lessons).toEqual(first.lessons);
    const assets = Object.fromEntries(Object.entries(FILES).filter(([p]) => p.startsWith('assets/')));
    // A ZIP with only assets/ is refused as "not a course" (Н-2 of T-010) and changes nothing.
    const onlyAssets = await imp(page, asFile('LRN-DEMO.zip', makeZip(assets)));
    expect(onlyAssets.ok).toBe(false);
    expect(onlyAssets.error).toMatch(/^Това не прилича на курс LRN/);
    expect(onlyAssets.lessons).toEqual(first.lessons);
    expect(onlyAssets.course).toEqual(first.course);
    expect(onlyAssets.lessons.find((l) => l.n === 'R01').a).toBe('DemoArtifactR01');
  });
});

test.describe('Н-1 and Н-5 retest', () => {
  test('Н-1: a ZIP with only folders (UI) says "ZIP архивът е празен."', async ({ page }) => {
    const dirsOnly = rawZip([{ name: 'LRN-DEMO/' }, { name: 'LRN-DEMO/lessons/' }]);
    await page.locator('[data-input="zip"]').setInputFiles(asFile('LRN-DEMO.zip', dirsOnly));
    await expect(page.locator('[data-field="import-error"]')).toHaveText('ZIP архивът е празен.');
  });

  test('Н-5: three re-imports (same ZIP, split parts, loose files) write nothing and keep the user data', async ({ page }) => {
    const first = await imp(page, full());
    await page.evaluate(async () => (await import('./src/db.js')).setLessonProgress('LRN-DEMO/lessons/0001-vidove-chay.html', { scrollY: 321 }));
    await page.waitForTimeout(20); // a new timestamp would differ
    for (const files of [full(), splitZips(FILES, 3), [asFile('0001-vidove-chay.html', Buffer.from(FILES[LESSON_PATH]), 'text/html')]]) {
      const r = await imp(page, files);
      expect(r.status).toBe('unchanged');
      expect(r.line).toMatch(/^Без промени\./);
      expect(r.course).toEqual(first.course);
      expect(r.fileStamps).toEqual(first.fileStamps);
      expect(r.paths).toHaveLength(IMPORTED);
      expect(r.lessons.find((l) => l.n === '0001').p).toBe(321);
    }
  });
});
