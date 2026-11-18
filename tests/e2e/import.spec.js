// T-007: course import (ZIP with/without root folder, split ZIP, loose files,
// folder, re-import, broken input). Uses tests/fixtures/LRN-DEMO (synthetic, D-026).
import { test, expect } from '@playwright/test';
import { strToU8 } from '../../vendor/fflate.js';
import {
  FIXTURE_DIR, DRIVE_ZIP_NAME, readFixture, makeZip, splitZips, withChangedLesson, asFile,
} from '../fixtures/zips.mjs';

const FILES = readFixture();
const LESSON_ID = 'LRN-DEMO/lessons/0001-vidove-chay.html';
const REF_ID = 'LRN-DEMO/reference/R01-temperatura-i-vreme.html';
const IMPORTED_FILES = Object.keys(FILES).filter((p) => !p.endsWith('.pdf')).length; // 11

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

async function importVia(page, input, files) {
  await page.locator(`[data-input="${input}"]`).setInputFiles(files);
}

const dbState = (page) => page.evaluate(async () => {
  const db = await import('./src/db.js');
  const course = await db.getCourse('LRN-DEMO');
  const lessons = await db.listLessons('LRN-DEMO');
  const files = await db.listCourseFiles('LRN-DEMO');
  const lesson = await db.getFile('LRN-DEMO', 'lessons/0001-vidove-chay.html');
  return {
    course: course && { title: course.title, files: course.files, hasMission: !!course.meta?.mission, artifacts: course.meta?.artifacts },
    lessons: lessons.map((l) => ({ id: l.id, kind: l.kind, number: l.number, title: l.title, order: l.order, artifactId: l.artifactId, sha: l.sha256?.length })),
    paths: files.map((f) => f.path).sort(),
    lessonMime: lesson?.mime,
    lessonText: lesson && (await lesson.blob.text()).slice(0, 15),
  };
});

function expectFullCourse(state) {
  expect(state.course).toMatchObject({ title: 'Основи на чая', files: IMPORTED_FILES, hasMission: true });
  expect(state.course.artifacts).toEqual({
    DemoArtifact0001: 'lessons/0001-vidove-chay.html',
    DemoArtifactR01: 'reference/R01-temperatura-i-vreme.html',
  });
  expect(state.lessons).toEqual([
    { id: LESSON_ID, kind: 'lesson', number: '0001', title: 'Какви видове чай има?', order: 1, artifactId: 'DemoArtifact0001', sha: 64 },
    { id: REF_ID, kind: 'reference', number: 'R01', title: 'Температура и време за запарване', order: 2, artifactId: 'DemoArtifactR01', sha: 64 },
  ]);
  expect(state.paths).toHaveLength(IMPORTED_FILES);
  expect(state.paths.some((p) => p.endsWith('.pdf'))).toBe(false);
  expect(state.lessonMime).toBe('text/html; charset=utf-8');
  expect(state.lessonText).toBe('<!DOCTYPE html>');
}

test.describe('T-007 import: ZIP', () => {
  test('Drive ZIP with the root folder: summary, lessons with titles, PDFs skipped, < 3 s', async ({ page }) => {
    await importVia(page, 'zip', asFile(DRIVE_ZIP_NAME, makeZip(FILES)));
    await expect(result(page)).toBeVisible();
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'new');
    await expect(result(page)).toContainText('Курсът LRN-DEMO е импортиран: 1 урок, 1 справочник, 2 теста, 13 файла.');
    await expect(result(page)).toContainText('0001 Какви видове чай има?');
    await expect(result(page)).toContainText('R01 Температура и време за запарване');
    await expect(result(page)).toContainText('Пропуснати PDF файлове: 2');
    expectFullCourse(await dbState(page));
    // The course card appears in the list.
    const card = page.locator('[data-course="LRN-DEMO"]');
    await expect(card).toContainText('Основи на чая');
    await expect(card).toContainText('1 урок · 1 справочник');
    await expect(page.locator('.empty')).toBeHidden();
    // The course screen lists the lessons in order.
    await card.click();
    await expect(page.locator('[data-screen="course"] [data-lesson]')).toHaveText(['0001 Какви видове чай има?', 'R01 Температура и време за запарване']);
  });

  test('ZIP without a root folder (named LRN-DEMO.zip, and with a neutral name)', async ({ page }) => {
    await importVia(page, 'zip', asFile('LRN-DEMO.zip', makeZip(FILES, { root: null })));
    await expect(result(page)).toContainText('Курсът LRN-DEMO е импортиран');
    expectFullCourse(await dbState(page));
    // Neutral file name, no root: the id comes from the INDEX.md heading → same course, no changes.
    await importVia(page, 'zip', asFile('course.zip', makeZip(FILES, { root: null, dirs: false })));
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'unchanged');
  });

  test('Drive ZIP split in two parts, picked together', async ({ page }) => {
    await importVia(page, 'zip', splitZips(FILES, 2));
    await expect(result(page)).toContainText('Курсът LRN-DEMO е импортиран: 1 урок, 1 справочник, 2 теста, 13 файла.');
    expectFullCourse(await dbState(page));
  });

  test('import time of the course is under 3 s (in the page, CPU ×4)', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet-landscape', 'measured once');
    const zip = [...makeZip(FILES)];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const s = await page.evaluate(async ({ zip, name }) => {
      const { importCourse } = await import('./src/course-import.js');
      const file = new File([new Uint8Array(zip)], name, { type: 'application/zip' });
      const t0 = performance.now();
      const summary = await importCourse([file]);
      return { ms: performance.now() - t0, status: summary.status };
    }, { zip, name: DRIVE_ZIP_NAME });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    info.annotations.push({ type: 'perf', description: `import ${Math.round(s.ms)} ms (CPU ×4)` });
    expect(s.status).toBe('new');
    expect(s.ms).toBeLessThan(3000);
  });
});

test.describe('T-007 re-import', () => {
  test('same ZIP again = "без промени"; a changed lesson = "променени: 1"; user data is kept', async ({ page }) => {
    const zip = asFile(DRIVE_ZIP_NAME, makeZip(FILES));
    await importVia(page, 'zip', zip);
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'new');

    // User data on the lesson.
    const ids = await page.evaluate(async (lessonId) => {
      const db = await import('./src/db.js');
      await db.setLessonProgress(lessonId, { status: 'started', scrollY: 640 });
      const a = await db.createAnnotation({ courseId: 'LRN-DEMO', target: { type: 'lesson', id: lessonId }, selector: { quote: { exact: 'чай' }, position: { start: 10, end: 13 } }, color: 'yellow' });
      const n = await db.createNote({ annotationId: a.id, body: 'моя бележка' });
      const before = (await db.getLesson(lessonId)).updatedAt;
      return { a: a.id, n: n.id, before };
    }, LESSON_ID);

    await importVia(page, 'zip', zip);
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'unchanged');
    await expect(result(page)).toContainText('Без промени.');
    const unchanged = await page.evaluate(async (lessonId) => (await (await import('./src/db.js')).getLesson(lessonId)).updatedAt, LESSON_ID);
    expect(unchanged).toBe(ids.before); // nothing rewritten

    await importVia(page, 'zip', asFile('LRN-DEMO-20261119T090000Z-1-001.zip', makeZip(withChangedLesson(FILES))));
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'updated');
    await expect(result(page)).toContainText('нови уроци: 0, променени: 1');
    await expect(result(page)).toContainText('файлове — нови: 0, променени: 1, без промяна: 12');

    const after = await page.evaluate(async ({ lessonId, a, n }) => {
      const db = await import('./src/db.js');
      const lesson = await db.getLesson(lessonId);
      const file = await db.getFile('LRN-DEMO', 'lessons/0001-vidove-chay.html');
      return {
        progress: lesson.progress,
        annotation: (await db.getAnnotation(a))?.selector.quote.exact,
        note: (await db.get('notes', n))?.body,
        newText: (await file.blob.text()).includes('Нов абзац в обновената версия.'),
        lessons: (await db.listLessons('LRN-DEMO')).length,
        courses: (await db.listCourses()).length,
      };
    }, { lessonId: LESSON_ID, ...ids });
    expect(after).toMatchObject({ progress: { status: 'started', scrollY: 640 }, annotation: 'чай', note: 'моя бележка', newText: true, lessons: 2, courses: 1 });
    await expect(page.locator('[data-list="courses"] .card')).toHaveCount(1);
  });

  test('a partial import (one new lesson as a loose file) adds it and keeps the rest', async ({ page }) => {
    await importVia(page, 'zip', asFile(DRIVE_ZIP_NAME, makeZip(FILES)));
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'new');
    const html = new TextDecoder().decode(FILES['lessons/0001-vidove-chay.html'])
      .replace('Урок 0001', 'Урок 0002').replace('<h1>Какви видове чай има?</h1>', '<h1>Зелен чай</h1>');
    await importVia(page, 'files', asFile('0002-zelen-chay.html', Buffer.from(html), 'text/html'));
    await expect(result(page).locator('[data-status]')).toHaveAttribute('data-status', 'updated');
    await expect(result(page)).toContainText('нови уроци: 1, променени: 0');
    const state = await dbState(page);
    expect(state.lessons.map((l) => [l.number, l.title, l.order])).toEqual([
      ['0001', 'Какви видове чай има?', 1], ['0002', 'Зелен чай', 2], ['R01', 'Температура и време за запарване', 3],
    ]);
    expect(state.paths).toHaveLength(IMPORTED_FILES + 1);
  });
});

test.describe('T-007 fallback: files and folder', () => {
  test('individual files (no folders) are recognised by name', async ({ page }) => {
    const pick = ['INDEX.md', 'MISSION.md', 'NOTES.md', 'RESOURCES.md', 'lessons/0001-vidove-chay.html', 'reference/R01-temperatura-i-vreme.html', 'assets/quiz.js', 'assets/style.css', 'sources/chay-naruchnik.pdf'];
    await importVia(page, 'files', pick.map((p) => asFile(p.split('/').pop(), Buffer.from(FILES[p]), 'application/octet-stream')));
    await expect(result(page)).toContainText('Курсът LRN-DEMO е импортиран: 1 урок, 1 справочник, 8 файла.');
    await expect(result(page)).toContainText('Пропуснати PDF файлове: 1');
    const state = await dbState(page);
    expect(state.paths).toEqual(['INDEX.md', 'MISSION.md', 'NOTES.md', 'RESOURCES.md', 'assets/quiz.js', 'assets/style.css', 'lessons/0001-vidove-chay.html', 'reference/R01-temperatura-i-vreme.html']);
    expect(state.lessons.map((l) => l.title)).toEqual(['Какви видове чай има?', 'Температура и време за запарване']);
  });

  test('a picked folder (webkitdirectory) works like the ZIP', async ({ page }) => {
    await importVia(page, 'folder', FIXTURE_DIR);
    await expect(result(page)).toContainText('Курсът LRN-DEMO е импортиран: 1 урок, 1 справочник, 2 теста, 13 файла.');
    expectFullCourse(await dbState(page));
  });
});

test.describe('T-007 errors (Bulgarian, nothing stored)', () => {
  const cases = [
    ['not a ZIP', () => asFile('LRN-DEMO.zip', Buffer.from('това не е архив')), 'не е ZIP архив'],
    ['a truncated ZIP', () => asFile('LRN-DEMO.zip', makeZip(FILES).subarray(0, 4000)), 'ZIP архивът е повреден или непълен'],
    ['a ZIP without course files', () => asFile('photos.zip', makeZip({ 'a.txt': strToU8('x'), 'b/c.png': new Uint8Array([1, 2, 3]) }, { root: 'photos' })), 'не прилича на курс LRN'],
    ['a ZIP with only PDFs', () => asFile('LRN-DEMO.zip', makeZip({ 'sources/a.pdf': FILES['sources/chay-tablica.pdf'] })), 'само PDF файлове'],
  ];
  for (const [name, file, message] of cases) {
    test(name, async ({ page }) => {
      await importVia(page, 'zip', file());
      await expect(errorBox(page)).toBeVisible();
      await expect(errorBox(page)).toContainText(message);
      await expect(result(page)).toBeHidden();
      // Buttons are usable again and nothing was stored.
      await expect(page.locator('[data-action="import-zip"]')).toBeEnabled();
      expect(await page.evaluate(async () => (await (await import('./src/db.js')).listCourses()).length)).toBe(0);
      await expect(page.locator('.empty')).toBeVisible();
    });
  }

  test('a loose lesson without any course id and no course yet', async ({ page }) => {
    const html = '<!DOCTYPE html><html><head><title>Урок</title></head><body><h1>Урок</h1></body></html>';
    await importVia(page, 'files', asFile('0003-x.html', Buffer.from(html), 'text/html'));
    await expect(errorBox(page)).toContainText('Не мога да разпозная курса');
  });
});
