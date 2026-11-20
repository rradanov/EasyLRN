// T-051 (tester): migration v3 → v4 on one origin and one profile: the real
// 0.6.2 build (commit 69aac1e, schema v3) with a course, quiz answers, lesson
// progress, changed settings and a key put into `settings.apiKey` by hand (as
// the developer log allows for) → this tree (0.7.0, schema v4, `secrets`).
// Synthetic data and a FAKE key only (D-026).
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OLD_COMMIT = '69aac1e'; // T-050-fix, 0.6.2, schema v3
const NOW_VERSION = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(REPO, 'src/config.js'), 'utf8'))[1];
const OLD_KEY = 'sk-ant-test-FAKE-old-build-0062';

async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}
const INDEX = strToU8('# LRN-M4\n\n## Уроци\n\n| # | Урок | Файл |\n|---|---|---|\n| 0001 | Урок | lessons/0001-l.html |\n');
const LESSON = strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p style="height:3000px">Дълъг текст.</p></body></html>');
const QUIZ = { lesson: '0001', title: 'Миграция 4', questions: [
  { q: 'Първи?', options: ['А', 'Б'], answer: 0 },
  { q: 'Втори?', options: ['А', 'Б'], answer: 1 },
] };
const ZIP = [...makeZip({ 'INDEX.md': INDEX, 'lessons/0001-l.html': LESSON, 'quizzes/m.json': strToU8(JSON.stringify(QUIZ)) }, { root: 'LRN-M4' })];

test('T-051 migration v3 → v4 with a real 0.6.2 profile: courses, answers, progress and settings stay; a key in settings moves to secrets', async ({ page }, info) => {
  test.skip(!existsSync(join(REPO, '.git')), 'needs the git history');
  test.setTimeout(180_000);
  const port = 4600 + info.workerIndex * 2 + (info.project.name === 'tablet-portrait' ? 1 : 0);
  const base = `/tmp/t051-migrate-${port}`;
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  execSync(`git -C "${REPO}" archive ${OLD_COMMIT} | tar -x -C "${base}"`);
  const url = `http://localhost:${port}/EasyLRN/`;
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
  await page.context().route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  const pick = (i) => page.locator(`.quiz__option[data-option="${i}"]`).click();

  // --- 0.6.2 (schema v3) -----------------------------------------------------
  let stop = await serve(base, port);
  try {
    await page.goto(url);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    expect(await page.evaluate(async () => (await import('./src/config.js')).APP_VERSION)).toBe('0.6.2');
    await page.evaluate(async (bytes) => {
      const m = await import('./src/course-import.js');
      await m.importCourse([new File([new Uint8Array(bytes)], 'LRN-M4-20261119T090000Z-1-001.zip')]);
    }, ZIP);
    await page.goto(`${url}#/c/LRN-M4/quiz/m`);
    await pick(0);
    await page.getByRole('button', { name: 'Напред', exact: true }).click();
    await pick(0);
    await page.goto(`${url}#/c/LRN-M4/read/0001`);
    await expect(page.locator('.lesson-frame__wrap').first()).toHaveAttribute('data-lesson-state', /ready|fallback/, { timeout: 20000 });
    await page.evaluate(async (key) => {
      const db = await import('./src/db.js');
      await db.saveSettings({ fontScale: 1.25, model: 'claude-opus-5-5', monthlyBudgetUSD: 12.5, apiKey: key });
      await db.logUsage({ model: 'claude-opus-5-5', kind: 'answer', input: 1, output: 1, estCostUSD: 0.75 });
    }, OLD_KEY);
    const v3 = await page.evaluate(() => new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { ok([r.result.version, [...r.result.objectStoreNames].includes('secrets')]); r.result.close(); }; }));
    expect(v3).toEqual([3, false]);
  } finally { await stop(); }

  // --- this tree (schema v4) ---------------------------------------------------
  stop = await serve(REPO, port);
  try {
    await page.goto(url);
    await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20000 });
    await page.locator('#update-button').click();
    await expect.poll(() => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION).catch(() => null), { timeout: 20000 }).toBe(NOW_VERSION);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    const after = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const idb = await new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => ok(r.result); });
      const raw = await new Promise((ok) => { const r = idb.transaction('settings').objectStore('settings').get('settings'); r.onsuccess = () => ok(r.result); });
      const v = idb.version;
      idb.close();
      const s = await db.getSettings();
      const answers = await db.getQuizAnswers('LRN-M4/quiz:path:quizzes/m.json'); // T-055: v5 id of a quiz outside NNNN-K
      return {
        v, rawHasKey: Object.hasOwn(raw, 'apiKey'), key: await db.getApiKey(),
        settings: [s.fontScale, s.model, s.monthlyBudgetUSD, s.theme, 'apiKey' in s],
        choices: Object.values(answers.choices || {}).sort(),
        courses: (await db.listCourses?.())?.map((c) => c.id) ?? null,
      };
    });
    console.log(`T-051 migrate v3→v4: ${JSON.stringify({ ...after, key: after.key ? `${after.key.length} chars` : '' })}`);
    expect(after.v).toBe(6); // T-055 (0.9.0): v4 → v5 runs right after v3 → v4
    expect(after.rawHasKey).toBe(false);
    expect(after.key).toBe(OLD_KEY);
    expect(after.settings).toEqual([1.25, 'claude-opus-5-5', 12.5, 'system', false]);
    expect(after.choices).toEqual(['А', 'А']);
    await expect(page.locator('[data-screen="courses"]')).toContainText('LRN-M4');
    await page.goto(`${url}#/c/LRN-M4`);
    // D-041 (T-059): "резултат: 1 от 2 верни" is now "минат" + "1 от 2 верни (50 %)".
    await expect(page.locator('.quiz-list__item', { hasText: 'Миграция 4' }).locator('[data-field="quiz-status"]')).toHaveText('минат');
    await expect(page.locator('.quiz-list__item', { hasText: 'Миграция 4' }).locator('[data-field="quiz-correct"]')).toHaveText('1 от 2 верни (50 %)');
    await page.goto(`${url}#/settings`);
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect(page.locator('[data-field="key-status"]')).toHaveText('Запазен ключ: •••• 0062');
    await expect(page.locator('[data-field="model"]')).toHaveValue('claude-opus-5-5');
    await expect(page.locator('[data-field="budget"]')).toHaveValue('12.5');
    await expect(page.locator('[data-field="font-scale"]')).toHaveText('125 %');
    await expect(page.locator('[data-field="spend"]')).toHaveText('$0.75 (1 извикване)');
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes('FAKE'))).toBe(false);
    // The lesson still opens after the upgrade (its render is redone if needed).
    await page.goto(`${url}#/c/LRN-M4/read/0001`);
    await expect(page.locator('.lesson-frame__wrap').first()).toHaveAttribute('data-lesson-state', 'ready', { timeout: 20000 });
  } finally { await stop(); }
  rmSync(base, { recursive: true, force: true });
  expect(logs.join('\n')).not.toContain('FAKE');
  expect(logs.filter((l) => /^(error|pageerror)/.test(l) && !/Failed to fetch|status of 40/.test(l))).toEqual([]);
});
