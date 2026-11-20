// T-050 (tester): migration v2 → v3 with my own old answers, on one origin and
// one profile: 0.6.0 (commit ec5afee, schema v2, answers = option index under
// a hash of the question text) → this tree (schema v3, answers by content).
// Answers are given in the 0.6.0 UI, plus broken records written straight
// into the v2 database (index out of range, wrong types, a quiz that no
// longer exists, choices = null): the upgrade must not abort and the app must
// keep working. Then a re-import with reshuffled options: the migrated choice
// follows the text. Synthetic data only (D-026).
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MID_COMMIT = 'ec5afee'; // T-047, 0.6.0, schema v2
const NOW_VERSION = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(REPO, 'src/config.js'), 'utf8'))[1];

async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}

const INDEX = strToU8('# LRN-MIG\n\n## Уроци\n\n| # | Урок | Файл |\n|---|---|---|\n| 0001 | Урок | lessons/0001-l.html |\n');
const LESSON = strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1></body></html>');
const QUIZ = { lesson: '0001', title: 'Миграция', questions: [
  { q: 'Първи (верен)?', options: ['А', 'Б', 'В'], answer: 0 },
  { q: 'Втори (грешен)?', options: ['А', 'Б', 'В'], answer: 1 },
  { q: 'Трети (без отговор)?', options: ['А', 'Б'], answer: 0 },
  { q: 'Близнак?', options: ['Да', 'Не'], answer: 0 },
  { q: 'Близнак?', options: ['Да', 'Не'], answer: 1 },
  { q: 'Шести (развален запис)?', options: ['А', 'Б', 'В'], answer: 2 },
] };
const QUIZ2 = { lesson: '0001', title: 'Втори тест', questions: [{ q: 'Само един?', options: ['Х', 'У'], answer: 1 }] };
const zipOf = (quiz) => [...makeZip({ 'INDEX.md': INDEX, 'lessons/0001-l.html': LESSON, 'quizzes/m.json': strToU8(JSON.stringify(quiz)), 'quizzes/n.json': strToU8(JSON.stringify(QUIZ2)) }, { root: 'LRN-MIG' })];

test('T-050 migration v2 → v3 with own old answers and broken records; then a reshuffled re-import', async ({ page }, info) => {
  test.skip(!existsSync(join(REPO, '.git')), 'needs the git history');
  test.setTimeout(180_000);
  const port = 4500 + info.workerIndex * 2 + (info.project.name === 'tablet-portrait' ? 1 : 0);
  const base = `/tmp/t050-migrate-${port}`;
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  execSync(`git -C "${REPO}" archive ${MID_COMMIT} | tar -x -C "${base}"`);
  const url = `http://localhost:${port}/EasyLRN/`;
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  const importZip = (bytes) => page.evaluate(async (bytes) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], 'LRN-MIG-20261119T090000Z-1-001.zip')]));
  }, bytes);
  const pick = (i) => page.locator(`.quiz__option[data-option="${i}"]`).click();
  const next = () => page.getByRole('button', { name: 'Напред', exact: true }).click();
  const counter = () => page.locator('.quiz__count');
  const verdict = () => page.locator('.quiz__verdict').textContent({ timeout: 500 }).catch(() => null);

  // --- 0.6.0 (schema v2) ----------------------------------------------------
  let stop = await serve(base, port);
  try {
    await page.goto(url);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    console.log(`T-050 migrate 0.6.0 import: ${await importZip(zipOf(QUIZ))}`);
    await page.goto(`${url}#/c/LRN-MIG/quiz/m`);
    await pick(0); await next(); // Q1 right
    await pick(2); await next(); // Q2 wrong (В)
    await next(); // Q3 none
    await pick(0); // Q4 twin "Да" (v2: Q5 shares it)
    await next();
    await expect(counter()).toHaveText('Въпрос 5 от 6 · отговорени 4'); // v2: the twin shares the answer (T048-D3)
    await page.getByRole('button', { name: 'Назад', exact: true }).click(); // cursor on Q4 (index 3)
    await page.waitForTimeout(300);
    // Broken records in the v2 database (as a crash or an old bug could leave them).
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const key6 = db.questionKey('Шести (развален запис)?');
      const open = () => new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => ok(r.result); });
      const idb = await open();
      const tx = idb.transaction('quizAnswers', 'readwrite');
      const s = tx.objectStore('quizAnswers');
      const rec = await new Promise((ok) => { const r = s.get('LRN-MIG/quizzes/m.json'); r.onsuccess = () => ok(r.result); });
      rec.choices[key6] = 7; // index out of range
      rec.choices.zzzzzzzz = 'x'; // unknown key, wrong type
      s.put(rec);
      s.put({ id: 'LRN-MIG/quizzes/gone.json', courseId: 'LRN-MIG', choices: { abc: 1 }, cursor: 0 }); // quiz no longer exists
      s.put({ id: 'LRN-MIG/quizzes/n.json', courseId: 'LRN-MIG', choices: null, cursor: 'x' }); // garbage
      await new Promise((ok) => { tx.oncomplete = ok; });
      idb.close();
    });
    const v2 = await page.evaluate(() => new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { ok(r.result.version); r.result.close(); }; }));
    expect(v2).toBe(2);
  } finally { await stop(); }

  // --- this tree (schema v3) --------------------------------------------------
  stop = await serve(REPO, port);
  try {
    await page.goto(url);
    await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20000 });
    await page.locator('#update-button').click();
    await expect.poll(() => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION).catch(() => null), { timeout: 20000 }).toBe(NOW_VERSION);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    const after = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const v = await new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { ok(r.result.version); r.result.close(); }; });
      // T-055 (D-039): schema v5 keys a quiz outside NNNN-K by its path (`quiz:path:`).
      return { v, m: await db.getQuizAnswers('LRN-MIG/quiz:path:quizzes/m.json'), n: await db.getQuizAnswers('LRN-MIG/quiz:path:quizzes/n.json'), gone: await db.getQuizAnswers('LRN-MIG/quiz:path:quizzes/gone.json') };
    });
    console.log(`T-050 migrate after v3: ${JSON.stringify({ v: after.v, m: [after.m.choices, after.m.cursor], n: [after.n.choices, after.n.cursor], gone: after.gone.choices })}`);
    expect(after.v).toBe(6); // 0.7.0 (T-019) added schema v4 (secrets) on top of v3; 0.9.0 (T-055) v5 (ids by number)
    expect(Object.values(after.m.choices).sort()).toEqual(['А', 'В', 'Да']); // Q1 А, Q2 В, first twin Да; the broken ones dropped
    await page.goto(`${url}#/c/LRN-MIG`);
    // D-041 (T-059): "3 от 6 отговорени" is now "Въпроси 3 от 6" + the state word.
    await expect(page.locator('.quiz-list__item', { hasText: 'Миграция' }).locator('[data-field="quiz-count"]')).toHaveText('Въпроси 3 от 6');
    await expect(page.locator('.quiz-list__item', { hasText: 'Миграция' }).locator('[data-field="quiz-status"]')).toHaveText('започнат');
    await expect(page.locator('.quiz-list__item', { hasText: 'Втори тест' }).locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await page.goto(`${url}#/c/LRN-MIG/quiz/m`);
    await expect(counter()).toHaveText('Въпрос 4 от 6 · отговорени 3'); // the cursor survived
    expect(await verdict()).toBe('Вярно'); // first twin
    await next();
    expect(await verdict()).toBeNull(); // second twin: v2 shared the answer, v3 keeps it for the first only
    await next();
    expect(await verdict()).toBeNull(); // broken record → no answer
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 2 от 6 верни');
    // The garbage record of quiz n does not break it.
    await page.goto(`${url}#/c/LRN-MIG/quiz/n`);
    await expect(counter()).toHaveText('Въпрос 1 от 1 · отговорени 0');
    await pick(1);
    expect(await verdict()).toBe('Вярно');
    // Re-import with reshuffled options (same right texts): the migrated choices follow the text.
    const shuffled = { ...QUIZ, questions: [
      { q: 'Първи (верен)?', options: ['В', 'Б', 'А'], answer: 2 },
      { q: 'Втори (грешен)?', options: ['Б', 'В', 'А'], answer: 0 },
      ...QUIZ.questions.slice(2),
    ] };
    console.log(`T-050 migrate re-import: ${await importZip(zipOf(shuffled))}`);
    await page.goto(`${url}#/c/LRN-MIG`);
    await page.goto(`${url}#/c/LRN-MIG/quiz/m`);
    await expect(counter()).toBeVisible();
    while (!(await counter().textContent()).startsWith('Въпрос 1 ')) await page.getByRole('button', { name: 'Назад', exact: true }).click();
    await expect(page.locator('.quiz__option--correct')).toHaveAttribute('data-option', '2');
    await next();
    await expect(page.locator('.quiz__option--wrong')).toHaveAttribute('data-option', '1');
    await expect(page.locator('[data-field="quiz-right"]')).toHaveText('Верен отговор: Б');
  } finally { await stop(); }
  rmSync(base, { recursive: true, force: true });
  expect(problems.filter((p) => !/Failed to fetch|status of 40/.test(p))).toEqual([]);
});
