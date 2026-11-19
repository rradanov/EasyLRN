// T-048 (tester): quiz answers across a real upgrade path, on one origin and
// one browser profile:
//   0.5.1 (schema v1, commit 601d5f5, old data: course, progress, annotation, note)
//   → 0.6.0 (this tree; migration v1 → v2, "Има нова версия" → "Презареди",
//            re-import of the same ZIP brings the quizzes, answers given)
//   → 0.6.0 + a version bump (a copy of this tree; the next release)
// The old tree comes from `git archive` into /tmp (skipped without git).
// Synthetic data only (LRN-DEMO, D-026).
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVE_ZIP_NAME, readFixture, makeZip } from '../fixtures/zips.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OLD_COMMIT = '601d5f5'; // T-045-fix, 0.5.1, IndexedDB schema v1

function prepareTrees(base) {
  const old = join(base, 'old');
  const next = join(base, 'next');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(old, { recursive: true });
  execSync(`git -C "${REPO}" archive ${OLD_COMMIT} | tar -x -C "${old}"`);
  cpSync(REPO, next, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git|test-results)([\\/]|$)/.test(p.slice(REPO.length)) });
  for (const [file, re] of [['sw.js', /const VERSION = '0\.6\.0'/], ['src/config.js', /APP_VERSION = '0\.6\.0'/]]) {
    const path = join(next, file);
    const text = readFileSync(path, 'utf8');
    expect(re.test(text), file).toBe(true);
    writeFileSync(path, text.replace('0.6.0', '0.6.99'));
  }
  return { old, now: REPO, next };
}

async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}

test('T-048 answers survive the migration v1→v2 with old data and a version upgrade (0.5.1 → 0.6.0 → next)', async ({ page, context }, info) => {
  test.skip(!existsSync(join(REPO, '.git')), 'needs the git history');
  test.setTimeout(180_000);
  const port = 4300 + info.workerIndex * 2 + (info.project.name === 'tablet-portrait' ? 1 : 0);
  const base = `/tmp/t048-upgrade-${port}`;
  const trees = prepareTrees(base);
  const url = `http://localhost:${port}/EasyLRN/`;
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  const zip = [...makeZip(readFixture())];
  const importZip = () => page.evaluate(async (bytes) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], 'LRN-DEMO-20261118T090000Z-1-001.zip')]));
  }, zip);
  const dbInfo = () => page.evaluate(async () => {
    const db = await import('./src/db.js');
    const ann = await db.annotationsOfCourse('LRN-DEMO');
    const notes = ann.length ? await db.notesFor(ann[0].id) : [];
    const lessons = await db.listLessons('LRN-DEMO');
    const idb = await new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { const v = r.result.version; const s = [...r.result.objectStoreNames]; r.result.close(); ok({ v, s }); }; });
    return { version: idb.v, stores: idb.s, annotations: ann.length, note: notes[0]?.body, progress: lessons.find((l) => l.number === '0001')?.progress?.status ?? null, quizzes: db.listQuizzes ? (await db.listQuizzes('LRN-DEMO')).length : null };
  });
  const upgradeTo = async (version) => {
    await page.goto(url);
    await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20000 });
    await page.locator('#update-button').click();
    await expect.poll(() => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION).catch(() => null), { timeout: 20000 }).toBe(version);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  };

  // --- 0.5.1, schema v1, old data -------------------------------------------
  let stop = await serve(trees.old, port);
  try {
    await page.goto(url);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    console.log(`T-048 upgrade 0.5.1 import: ${await importZip()}`);
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const lesson = (await db.listLessons('LRN-DEMO')).find((l) => l.number === '0001');
      await db.setLessonProgress(lesson.id, { status: 'started', position: { y: 120 } });
      const a = await db.createAnnotation({ courseId: 'LRN-DEMO', target: db.docRef('lesson', lesson.id), selector: { quote: { exact: 'чай', prefix: '', suffix: '' }, position: { start: 0, end: 3 } }, color: 'yellow' });
      await db.createNote({ annotationId: a.id, courseId: 'LRN-DEMO', body: 'стара бележка' });
    });
    const before = await dbInfo();
    console.log(`T-048 upgrade 0.5.1 data: ${JSON.stringify(before)}`);
    expect(before).toMatchObject({ version: 1, annotations: 1, note: 'стара бележка', progress: 'started' });
    expect(before.stores).not.toContain('quizAnswers');
  } finally { await stop(); }

  // --- 0.6.0: migration v1 → v2, re-import, answers ----------------------------
  stop = await serve(trees.now, port);
  try {
    await upgradeTo('0.6.0');
    const migrated = await dbInfo();
    console.log(`T-048 upgrade 0.6.0 after migration: ${JSON.stringify(migrated)}`);
    expect(migrated).toMatchObject({ version: 2, annotations: 1, note: 'стара бележка', progress: 'started' });
    expect(migrated.stores).toEqual(expect.arrayContaining(['quizzes', 'quizAnswers']));
    await page.goto(`${url}#/c/LRN-DEMO`);
    await expect(page.locator('[data-screen="course"]')).toBeVisible();
    console.log(`T-048 upgrade 0.6.0 quizzes before re-import: ${migrated.quizzes}, section: ${await page.locator('[data-list="quizzes"] [data-quiz]').count()}`);
    console.log(`T-048 upgrade 0.6.0 re-import: ${await importZip()}`);
    await page.goto(`${url}#/c/LRN-DEMO/read/0001`);
    await expect(page.locator('[data-field="lesson-quizzes"] a')).toHaveCount(2);
    await page.locator('[data-field="lesson-quizzes"] a').first().click();
    await page.locator('.quiz__option[data-option="0"]').click();
    await page.getByRole('button', { name: 'Напред' }).click();
    await page.locator('.quiz__option[data-option="1"]').click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 2 от 3 · отговорени 2');
    await page.waitForTimeout(300);
    expect(await dbInfo()).toMatchObject({ annotations: 1, note: 'стара бележка', progress: 'started', quizzes: 2 });
  } finally { await stop(); }

  // --- the next version: the answers stay (online, then offline) ---------------
  stop = await serve(trees.next, port);
  try {
    await upgradeTo('0.6.99');
    await page.goto(`${url}#/c/LRN-DEMO`);
    await expect(page.locator('[data-list="quizzes"] [data-field="quiz-status"]').first()).toHaveText('2 от 3 отговорени');
    await page.goto(`${url}#/c/LRN-DEMO/quiz/0001-1-vidove`);
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 2 от 3 · отговорени 2');
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 2 от 3 · отговорени 2');
    await context.setOffline(false);
    expect(await dbInfo()).toMatchObject({ version: 2, annotations: 1, note: 'стара бележка', progress: 'started', quizzes: 2 });
  } finally { await stop(); }
  rmSync(base, { recursive: true, force: true });
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|status of 40/.test(p))).toEqual([]);
});
