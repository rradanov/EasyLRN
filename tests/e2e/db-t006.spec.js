// T-006 (tester): data layer checks that need Playwright — CPU-throttled
// performance (approximation of the Galaxy Tab A9+), persistent browser
// profile, two tabs, migration failures. Known defects are kept as
// `test.fail()` tests: they pass while the defect exists and turn red when it
// is fixed (then drop the `test.fail` line). See logs/T-006_tester_*.md.
import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_PAGE = './tests/db.html?run=none';

/** Seed `total` realistic annotations, `onLesson` of them on lesson L (bulk, one transaction). */
async function seedAnnotations(page, name, total, onLesson) {
  await page.evaluate(async ({ name, total, onLesson }) => {
    const db = await import('../src/db.js');
    await db.deleteDatabase(name);
    const conn = await db.openDb({ name });
    const tx = conn.transaction(['annotations', 'notes'], 'readwrite');
    const at = new Date().toISOString();
    for (let i = 0; i < total; i++) {
      const id = db.newId();
      const exact = `съответствие с изискванията ${i} 🙂`;
      tx.objectStore('annotations').put({
        id, courseId: 'LRN-DEMO', target: { type: 'lesson', id: i < onLesson ? 'L' : `L-${i % 20}` }, targetVersion: 'sha',
        selector: { quote: { exact, prefix: 'п'.repeat(32), suffix: 'с'.repeat(32) }, position: { start: i * 40, end: i * 40 + exact.length }, hint: { blockPath: `main > section:nth-of-type(${i % 9}) > p` } },
        color: ['yellow', 'green', 'blue', 'pink', 'orange', null][i % 6], anchorState: 'ok', createdAt: at, updatedAt: at, deleted: i % 50 === 0,
      });
      if (i % 3 === 0) tx.objectStore('notes').put({ id: db.newId(), annotationId: id, body: 'бележка '.repeat(20), createdAt: at, updatedAt: at, deleted: false });
    }
    await tx.done;
    db.closeDb();
  }, { name, total, onLesson });
}

test.describe('T-006 performance (CPU throttling ×4 ≈ Galaxy Tab A9+)', () => {
  test('annotations of a lesson: 1000 of 3000 in < 100 ms', async ({ page }, info) => {
    // The viewport does not matter here; one project only, so the two projects do not share the CPU.
    test.skip(info.project.name !== 'tablet-landscape', 'measured once, in tablet-landscape');
    test.setTimeout(120_000);
    await page.goto(TEST_PAGE);
    await seedAnnotations(page, 'easylrn-perf', 3000, 1000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      const L = { type: 'lesson', id: 'L' };
      await db.openDb({ name: 'easylrn-perf' });
      let t0 = performance.now();
      const cold = await db.annotationsFor(L);
      const coldMs = performance.now() - t0;
      const warm = [];
      for (let i = 0; i < 10; i++) {
        t0 = performance.now();
        await db.annotationsFor(L);
        warm.push(performance.now() - t0);
      }
      warm.sort((a, b) => a - b);
      t0 = performance.now();
      const children = await db.getDocChildren(L);
      const childrenMs = performance.now() - t0;
      t0 = performance.now();
      await db.getLessonTree('L');
      const treeMs = performance.now() - t0;
      await db.deleteDatabase('easylrn-perf');
      return { found: cold.length, coldMs, medianMs: warm[5], maxMs: warm[9], children: children.length, childrenMs, treeMs };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    info.annotations.push({ type: 'perf', description: JSON.stringify(r) });
    console.log(`[${info.project.name}] throttle×4:`, JSON.stringify(r));
    expect(r.found).toBe(980); // 1000 minus 20 soft-deleted
    expect(r.coldMs).toBeLessThan(100);
    expect(r.maxMs).toBeLessThan(100);
    expect(r.children).toBe(980);
  });
});

test.describe('T-006 persistence', () => {
  test('app data survive a reload and a restart of a persistent browser profile; persist() is called', async ({}, info) => {
    const baseURL = info.project.use.baseURL;
    const dir = mkdtempSync(join(tmpdir(), 'easylrn-profile-'));
    try {
      let ctx = await chromium.launchPersistentContext(dir, { baseURL, serviceWorkers: 'allow' });
      await ctx.addInitScript(() => {
        window.__persistCalls = 0;
        const original = navigator.storage.persist.bind(navigator.storage);
        navigator.storage.persist = () => { window.__persistCalls++; return original(); };
      });
      let page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('./');
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__persistCalls)).toBeGreaterThanOrEqual(1);
      const ids = await page.evaluate(async () => {
        const db = await import('./src/db.js'); // same module instance as the app → database lrn-app
        await db.putCourse({ id: 'LRN-T006', title: 'Тест 🙂' });
        await db.putLesson({ id: 'LRN-T006/l1.html', courseId: 'LRN-T006', title: 'Урок', order: 1 });
        await db.setLessonProgress('LRN-T006/l1.html', { status: 'started', scrollY: 321 });
        const a = await db.createAnnotation({ courseId: 'LRN-T006', target: { type: 'lesson', id: 'LRN-T006/l1.html' }, selector: { quote: { exact: 'кирилица 👩‍💻' }, position: { start: 1, end: 13 } }, color: 'green' });
        const th = await db.createThread({ annotationId: a.id });
        const m = await db.createMessage({ threadId: th.id, role: 'assistant', content: 'О'.repeat(100 * 1024), status: 'done' });
        await db.saveSettings({ fontScale: 1.3 });
        return { a: a.id, m: m.id, persisted: await navigator.storage.persisted() };
      });
      const read = (p) => p.evaluate(async ({ a, m }) => {
        const db = await import('./src/db.js');
        return {
          course: (await db.getCourse('LRN-T006'))?.title,
          scrollY: (await db.getLesson('LRN-T006/l1.html'))?.progress.scrollY,
          quote: (await db.getAnnotation(a))?.selector.quote.exact,
          answer: (await db.get('messages', m))?.content.length,
          fontScale: (await db.getSettings()).fontScale,
        };
      }, ids);
      const expected = { course: 'Тест 🙂', scrollY: 321, quote: 'кирилица 👩‍💻', answer: 100 * 1024, fontScale: 1.3 };

      await page.reload();
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      expect(await read(page)).toEqual(expected);

      await ctx.close(); // browser restart with the same profile
      ctx = await chromium.launchPersistentContext(dir, { baseURL, serviceWorkers: 'allow' });
      page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('./');
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      expect(await read(page)).toEqual(expected);
      info.annotations.push({ type: 'persisted', description: String(ids.persisted) });
      await ctx.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('T-006 two tabs', () => {
  test('concurrent writes from two tabs are all stored', async ({ context }) => {
    const [a, b] = [await context.newPage(), await context.newPage()];
    await a.goto(TEST_PAGE);
    await b.goto(TEST_PAGE);
    await a.evaluate(async () => { const db = await import('../src/db.js'); await db.deleteDatabase('easylrn-tabs'); });
    const write = (p, tag) => p.evaluate(async (tag) => {
      const db = await import('../src/db.js');
      await db.openDb({ name: 'easylrn-tabs' });
      const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => db.createAnnotation({
        courseId: 'C', target: { type: 'lesson', id: 'L' }, selector: { quote: { exact: `${tag}${i}` }, position: { start: i, end: i + 1 } } })));
      await Promise.all(Array.from({ length: 25 }, (_, i) => db.saveSettings({ [`${tag}${i}`]: i })));
      return rs.length;
    }, tag);
    expect(await Promise.all([write(a, 'a'), write(b, 'b')])).toEqual([100, 100]);
    const r = await a.evaluate(async () => {
      const db = await import('../src/db.js');
      const all = await db.annotationsFor({ type: 'lesson', id: 'L' });
      const s = await db.getSettings();
      const keys = Object.keys(s).filter((k) => /^[ab]\d+$/.test(k)).length;
      await db.deleteDatabase('easylrn-tabs');
      return { n: all.length, unique: new Set(all.map((x) => x.id)).size, keys };
    });
    expect(r).toEqual({ n: 200, unique: 200, keys: 50 });
  });

  test('a newer schema in another tab is not blocked; the old tab is told and its data kept', async ({ context }) => {
    const [a, b] = [await context.newPage(), await context.newPage()];
    await a.goto(TEST_PAGE);
    await b.goto(TEST_PAGE);
    await a.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-v2');
      window.__versionChange = false;
      await db.openDb({ name: 'easylrn-v2', onVersionChange: () => { window.__versionChange = true; } });
      await db.createNote({ annotationId: 'A', body: 'от раздел A' });
    });
    const v = await b.evaluate(async () => {
      const db = await import('../src/db.js');
      const conn = await Promise.race([
        db.openDb({ name: 'easylrn-v2', migrations: { ...db.MIGRATIONS, 2(c, tx) { tx.objectStore('notes').createIndex('by_body', 'body'); } } }),
        new Promise((r) => setTimeout(() => r('blocked'), 5000)),
      ]);
      if (conn === 'blocked') return 'blocked';
      return { version: conn.version, notes: (await db.byIndex('notes', 'by_body', 'от раздел A')).length };
    });
    expect(v).toEqual({ version: 2, notes: 1 });
    expect(await a.evaluate(() => window.__versionChange)).toBe(true);
    // The old tab (code for v1) cannot use the v2 database until it reloads (expected; banner „Презареди“).
    const old = await a.evaluate(async () => {
      const db = await import('../src/db.js');
      try { await db.createNote({ annotationId: 'A', body: 'x' }); return 'ok'; } catch (e) { return e.name; }
    });
    expect(old).toBe('VersionError');
    await b.evaluate(async () => { const db = await import('../src/db.js'); await db.deleteDatabase('easylrn-v2'); });
  });
});

test.describe('T-006 migrations: failures', () => {
  test('a migration that throws rolls back to v1 and keeps the data', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-mig');
      await db.openDb({ name: 'easylrn-mig' });
      await db.createNote({ annotationId: 'KEEP', body: 'пази' });
      db.closeDb();
      let error = null;
      try { await db.openDb({ name: 'easylrn-mig', migrations: { ...db.MIGRATIONS, 2() { throw new Error('boom'); } } }); } catch (e) { error = e.name; }
      const conn = await db.openDb({ name: 'easylrn-mig', migrations: db.MIGRATIONS });
      const out = { error, version: conn.version, body: (await db.byIndex('notes', 'by_annotation', 'KEEP'))[0]?.body };
      await db.deleteDatabase('easylrn-mig');
      return out;
    });
    expect(r).toEqual({ error: 'AbortError', version: 1, body: 'пази' });
  });

  test('DEFECT T006-D3: a failed migration leaves no unhandled promise rejection', async ({ page }) => {
    test.fail(true, 'T006-D3: openDb() leaves an unhandled AbortError when a migration fails');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.name || e.message));
    await page.goto(TEST_PAGE);
    await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-mig3');
      await db.openDb({ name: 'easylrn-mig3' });
      db.closeDb();
      try { await db.openDb({ name: 'easylrn-mig3', migrations: { ...db.MIGRATIONS, 2() { throw new Error('boom'); } } }); } catch { /* expected */ }
      await new Promise((r) => setTimeout(r, 200));
      await db.deleteDatabase('easylrn-mig3');
    });
    expect(errors).toEqual([]);
  });

  test('DEFECT T006-D2: a migration that fails after a non-IndexedDB await does not commit the new version', async ({ page }) => {
    test.fail(true, 'T006-D2: the version is bumped to 2 although the migration failed (index missing)');
    await page.goto(TEST_PAGE);
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-mig2');
      await db.openDb({ name: 'easylrn-mig2' });
      db.closeDb();
      let outcome;
      try {
        const conn = await db.openDb({ name: 'easylrn-mig2', migrations: { ...db.MIGRATIONS,
          async 2(c, tx) { await new Promise((res) => setTimeout(res, 10)); tx.objectStore('notes').createIndex('by_body', 'body'); } } });
        outcome = { opened: true, version: conn.version, indexes: [...conn.transaction('notes').objectStore('notes').indexNames] };
      } catch (e) {
        outcome = { opened: false, error: e.name };
      }
      await db.deleteDatabase('easylrn-mig2');
      return outcome;
    });
    // Either openDb rejects, or the migration really ran. Today: opened, v2, index missing.
    expect(r.opened === false || r.indexes.includes('by_body')).toBe(true);
  });
});

test.describe('T-006 re-import vs progress', () => {
  test('DEFECT T006-D1: re-import of a lesson at the same time as a progress update keeps the progress', async ({ page }) => {
    test.fail(true, 'T006-D1: putLesson reads progress and writes in two transactions → lost update');
    await page.goto(TEST_PAGE);
    const progress = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-race');
      await db.openDb({ name: 'easylrn-race' });
      await db.putLesson({ id: 'C/l1.html', courseId: 'C', title: 'v1', order: 1 });
      await Promise.all([
        db.putLesson({ id: 'C/l1.html', courseId: 'C', title: 'v2', order: 1 }),
        db.setLessonProgress('C/l1.html', { status: 'done', scrollY: 500 }),
      ]);
      const p = (await db.getLesson('C/l1.html')).progress;
      await db.deleteDatabase('easylrn-race');
      return p;
    });
    expect(progress).toMatchObject({ status: 'done', scrollY: 500 });
  });
});

test.describe('T-006 bad data', () => {
  test('DEFECT T006-D4: createSubTopic on a cyclic note chain fails instead of hanging', async ({ page }) => {
    test.fail(true, 'T006-D4: resolveRoot() follows note → annotation → note forever (no cycle guard)');
    await page.goto(TEST_PAGE);
    const r = await page.evaluate(async () => {
      const db = await import('../src/db.js');
      await db.deleteDatabase('easylrn-cycle');
      await db.openDb({ name: 'easylrn-cycle' });
      // Corrupt data (e.g. from a broken backup): the note's annotation sits on the note itself.
      const n = await db.createNote({ annotationId: 'tmp', body: 'x' });
      const a = await db.createAnnotation({ courseId: 'C', target: { type: 'note', id: n.id }, selector: { quote: { exact: 'x' }, position: { start: 0, end: 1 } } });
      await db.update('notes', n.id, { annotationId: a.id });
      return Promise.race([
        db.createSubTopic({ annotationId: a.id, kind: 'термин' }).then(() => 'created', () => 'rejected'),
        new Promise((res) => setTimeout(() => res('hang'), 3000)),
      ]);
    });
    expect(r).toBe('rejected');
  });
});
