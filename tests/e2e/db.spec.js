// T-005: data layer (src/db.js). Runs the in-browser unit tests of
// tests/db.html and checks what needs a real page lifecycle: data survives a
// reload, and the app itself opens `lrn-app` v1 and asks for persistent storage.
import { test, expect } from '@playwright/test';

test.describe('data layer (IndexedDB)', () => {
  test('all unit tests in tests/db.html pass', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('./tests/db.html');
    await expect(page.locator('#summary[data-done="true"]')).toBeVisible({ timeout: 30_000 });
    const results = await page.evaluate(() => window.dbTestResults);
    const failed = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(25);
    await expect(page.locator('#summary')).toHaveText(`Всички ${results.length} теста минават.`);
    expect(errors).toEqual([]);
  });

  test('data survives a page reload', async ({ page }) => {
    await page.goto('./tests/db.html?run=none');
    const ids = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-persist');
      await db.openDb({ name: 'easylrn-persist' });
      await db.putCourse({ id: 'LRN-DEMO', title: 'Демо' });
      await db.putLesson({ id: 'LRN-DEMO/lessons/0001.html', courseId: 'LRN-DEMO', number: '0001', title: 'Урок', order: 1 });
      await db.putFile({ courseId: 'LRN-DEMO', path: 'lessons/0001.html', mime: 'text/html', blob: new Blob(['<p>здравей</p>'], { type: 'text/html' }), sha256: 'x' });
      const a = await db.createAnnotation({
        courseId: 'LRN-DEMO', target: { type: 'lesson', id: 'LRN-DEMO/lessons/0001.html' },
        selector: { quote: { exact: 'здравей', prefix: '', suffix: '' }, position: { start: 0, end: 7 } }, color: 'blue',
      });
      const n = await db.createNote({ annotationId: a.id, body: 'бележка' });
      await db.saveSettings({ fontScale: 1.1 });
      db.closeDb();
      return { a: a.id, n: n.id };
    });

    await page.reload();
    const after = await page.evaluate(async ({ a, n }) => {
      const db = await import('../src/db.js');
      await db.openDb({ name: 'easylrn-persist' });
      const file = await db.getFile('LRN-DEMO', 'lessons/0001.html');
      const out = {
        course: (await db.getCourse('LRN-DEMO'))?.title,
        lessons: (await db.listLessons('LRN-DEMO')).length,
        file: await file.blob.text(),
        annotation: (await db.annotationsFor({ type: 'lesson', id: 'LRN-DEMO/lessons/0001.html' }))[0]?.id === a,
        note: (await db.notesFor(a))[0]?.id === n,
        fontScale: (await db.getSettings()).fontScale,
      };
      await db.deleteDatabase('easylrn-persist');
      return out;
    }, ids);
    expect(after).toEqual({ course: 'Демо', lessons: 1, file: '<p>здравей</p>', annotation: true, note: true, fontScale: 1.1 });
  });

  test('the app opens lrn-app v3 and requests persistent storage at start', async ({ page }) => {
    await page.addInitScript(() => {
      window.__persistCalls = 0;
      const original = navigator.storage.persist.bind(navigator.storage);
      navigator.storage.persist = () => { window.__persistCalls++; return original(); };
    });
    const problems = [];
    page.on('console', (msg) => { if (['error', 'warning'].includes(msg.type())) problems.push(msg.text()); });
    page.on('pageerror', (err) => problems.push(err.message));
    await page.goto('./');
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return dbs.find((d) => d.name === 'lrn-app')?.version ?? null;
    })).toBe(4); // v4 (T-019): the secrets store
    await expect.poll(() => page.evaluate(() => window.__persistCalls)).toBeGreaterThanOrEqual(1);
    const stores = await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('lrn-app');
      req.onsuccess = () => { const names = [...req.result.objectStoreNames].sort(); req.result.close(); resolve(names); };
      req.onerror = () => reject(req.error);
    }));
    expect(stores).toEqual(['annotations', 'courses', 'files', 'lessons', 'messages', 'notes', 'quizAnswers', 'quizzes', 'secrets', 'settings', 'subtopics', 'threads', 'usage']);
    expect(problems).toEqual([]);
  });
});
