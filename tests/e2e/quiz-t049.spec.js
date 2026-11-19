// T-049 (developer): links to the sources in quizzes, "Отначало" at any time,
// "Нулирай" per quiz in the course, only the user's own choice marked (D-035,
// D-036). Synthetic data (LRN-DEMO and in-memory courses, D-026). The real
// course only through T049_REAL_DIR; screenshots only into T049_SHOTS (both
// outside the repository).
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
  // No real network: external pages are answered locally.
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>external</title><p>external</p>' }));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
});
test.afterEach(() => { expect(problems).toEqual([]); });

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse(files.map((f) => new File([new Uint8Array(f.bytes)], f.name))));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importCourse = (page, id, files) => importFiles(page, [asFile(`${id}.zip`, makeZip(files, { root: id }))]);
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(readFixture()))]);
const json = (o) => strToU8(JSON.stringify(o));
const INDEX = (id) => strToU8(`# ${id}\n\n## Уроци\n\n| # | Урок | Файл |\n|---|---|---|\n| 0001 | Урок | lessons/0001-l.html |\n`);
const LESSON = strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1></body></html>');
const course = (id, quizzes) => ({ 'INDEX.md': INDEX(id), 'lessons/0001-l.html': LESSON, ...quizzes });
const pick = (page, i) => page.locator(`.quiz__option[data-option="${i}"]`).click();
const next = (page) => page.getByRole('button', { name: 'Напред', exact: true }).click();
const counter = (page) => page.locator('.quiz__count');
const restart = (page) => page.getByRole('button', { name: 'Отначало', exact: true });

const Q3 = { lesson: '0001', title: 'Три въпроса', questions: [
  { q: 'Едно?', options: ['А', 'Б', 'В'], answer: 0, why: 'Защото А.', src: 'Урок 0001' },
  { q: 'Две?', options: ['А', 'Б', 'В'], answer: 1, why: 'Защото Б.', src: 'Урок 0001' },
  { q: 'Три?', options: ['А', 'Б', 'В'], answer: 2 },
] };

test.describe('T-049 links (D-035)', () => {
  test('only valid https: links are shown, as text, opening a new tab without opener/referrer; the rest are skipped with a note; no links → the src text', async ({ page, context }) => {
    const links = [
      { label: 'Регламент <b>чл. 2</b>', url: 'https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:32024R2847#art_2' },
      { label: 'JS', url: 'javascript:alert(1)' },
      { label: 'data', url: 'data:text/html,<script>alert(1)</script>' },
      { label: 'http', url: 'http://example.org/' },
      { label: 'relative', url: '/x' },
      { label: 'creds', url: 'https://user:pw@example.org/' },
      { url: 'https://drive.google.com/file/d/abc/view' }, // no label → host name
      { label: 'Три', url: 'https://example.org/3' }, { label: 'Четири', url: 'https://example.org/4' },
      { label: 'Пет', url: 'https://example.org/5' }, { label: 'Шест (над лимита)', url: 'https://example.org/6' },
      'не е обект',
    ];
    const line = await importCourse(page, 'LRN-L', course('LRN-L', {
      'quizzes/a.json': json({ lesson: '0001', title: 'Линкове', questions: [
        { q: 'С линкове?', options: ['Да', 'Не'], answer: 0, src: 'текст, който не се показва при линкове', links },
        { q: 'Без линкове?', options: ['Да', 'Не'], answer: 1, src: 'Урок 0001, раздел 2', links: 'https://not-a-list.example' },
      ] }),
    }));
    expect(line).toContain('Внимание — тестовете не са внесени изцяло');
    expect(line).toContain('позволени са само https:');
    await page.goto('./#/c/LRN-L/quiz/a');
    await pick(page, 0);
    const a = page.locator('.quiz__src a');
    await expect(a).toHaveText(['Регламент <b>чл. 2</b>', 'drive.google.com', 'Три', 'Четири', 'Пет']);
    await expect(page.locator('.quiz__src b')).toHaveCount(0);
    expect(await a.evaluateAll((els) => els.map((e) => [e.protocol, e.target, e.rel]))).toEqual(Array(5).fill(['https:', '_blank', 'noopener noreferrer']));
    await expect(page.locator('.quiz__src')).toHaveText(/^Източник: /);
    // A tap opens the source outside the app.
    const [popup] = await Promise.all([context.waitForEvent('page'), a.first().click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('eur-lex.europa.eu');
    expect(await popup.evaluate(() => [window.opener, document.referrer])).toEqual([null, '']);
    await popup.close();
    expect(page.url()).toContain('#/c/LRN-L/quiz/a'); // the app stays where it was
    await next(page);
    await pick(page, 1);
    await expect(page.locator('.quiz__src')).toHaveText('Източник: Урок 0001, раздел 2');
    await expect(page.locator('.quiz__src a')).toHaveCount(0);
  });

  test('LRN-DEMO: the quiz with links (tap targets ≥ 44 px)', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/quiz/0001-1-vidove');
    await pick(page, 1); // wrong
    await expect(page.locator('.quiz__src a')).toHaveCount(2);
    for (const box of await page.locator('.quiz__src a').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  });
});

test.describe('T-049 marking (D-036)', () => {
  test('a right choice: green ✓ on it only; a wrong one: red ✗ on it only, the right option NOT coloured, "Верен отговор: …" in the feedback; the same when coming back and in the review', async ({ page }) => {
    await importCourse(page, 'LRN-M', course('LRN-M', { 'quizzes/a.json': json(Q3) }));
    await page.goto('./#/c/LRN-M/quiz/a');
    await pick(page, 0);
    await expect(page.locator('.quiz__option--correct')).toHaveText('✓А');
    await expect(page.locator('.quiz__option--wrong')).toHaveCount(0);
    await expect(page.locator('.quiz__right')).toHaveCount(0);
    await next(page);
    await pick(page, 2);
    const check = async () => {
      await expect(page.locator('.quiz__option--wrong')).toHaveText('✗В');
      await expect(page.locator('.quiz__option--correct')).toHaveCount(0);
      await expect(page.locator('.quiz__option[data-option="1"]')).toHaveClass(/quiz__option--muted/);
      await expect(page.locator('.quiz__option[data-option="1"] .quiz__option-mark')).toHaveText('');
      await expect(page.locator('.quiz__right')).toHaveText('Верен отговор: Б');
      await expect(page.locator('.quiz__verdict')).toHaveText('Грешно');
    };
    await check();
    await page.getByRole('button', { name: 'Назад' }).click();
    await next(page);
    await check(); // coming back
    await next(page);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await page.locator('.quiz__wrong-link', { hasText: 'Две?' }).click();
    await check(); // from the result
    await page.reload();
    await expect(page.locator('.quiz__question')).toBeVisible();
    await check(); // after a reload
  });
});

test.describe('T-049 "Отначало" and "Нулирай" (D-035)', () => {
  test('"Отначало" is at the top on every question and on the result; confirmation with the focus on "Отказ"; it resets and starts at question 1, also after a reload', async ({ page }) => {
    await importCourse(page, 'LRN-R', course('LRN-R', { 'quizzes/a.json': json(Q3) }));
    await page.goto('./#/c/LRN-R/quiz/a');
    await expect(restart(page)).toBeVisible(); // before any answer
    await pick(page, 0); await next(page);
    await pick(page, 0);
    await expect(restart(page)).toBeVisible();
    // Above the question.
    const [rb, qb] = await Promise.all([restart(page).boundingBox(), page.locator('.quiz__question').boundingBox()]);
    expect(rb.y).toBeLessThan(qb.y);
    await restart(page).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Да изчистя ли отговорите и да започна отначало?');
    await expect(page.getByRole('button', { name: 'Отказ', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Отказ', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(counter(page)).toHaveText('Въпрос 2 от 3 · отговорени 2');
    // After a reload, from question 2.
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 2 от 3 · отговорени 2');
    await restart(page).click();
    await page.getByRole('button', { name: 'Изчисти и започни' }).click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await expect(page.locator('.quiz__question')).toHaveText('Едно?');
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    // From the result too.
    await pick(page, 0); await next(page); await pick(page, 1); await next(page); await pick(page, 2);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 3 от 3 верни');
    await restart(page).click();
    await page.getByRole('button', { name: 'Изчисти и започни' }).click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await page.goto('./#/c/LRN-R');
    await expect(page.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
  });

  test('"Нулирай" for each quiz in the course: off for a quiz not started; confirmation (focus on "Отказ"); only that quiz is reset', async ({ page }) => {
    await importCourse(page, 'LRN-N', course('LRN-N', { 'quizzes/a.json': json(Q3), 'quizzes/b.json': json({ ...Q3, title: 'Втори' }) }));
    await page.goto('./#/c/LRN-N/quiz/a');
    await pick(page, 0);
    await page.goto('./#/c/LRN-N/quiz/b');
    await pick(page, 1);
    await page.goto('./#/c/LRN-N');
    const item = (id) => page.locator(`[data-quiz="LRN-N/quiz:path:quizzes/${id}.json"]`);
    await expect(item('a').locator('[data-field="quiz-status"]')).toHaveText('1 от 3 отговорени');
    await item('a').getByRole('button', { name: /Нулирай/ }).click();
    await expect(item('a').getByRole('alertdialog')).toContainText('Да изтрия ли отговорите на „Три въпроса“?');
    await expect(item('a').getByRole('button', { name: 'Отказ', exact: true })).toBeFocused();
    await item('a').getByRole('button', { name: 'Отказ', exact: true }).click();
    await expect(item('a').locator('[data-field="quiz-status"]')).toHaveText('1 от 3 отговорени');
    await item('a').getByRole('button', { name: /Нулирай/ }).click();
    await item('a').getByRole('button', { name: 'Изтрий' }).click();
    await expect(item('a').locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(item('a').getByRole('button', { name: /Нулирай/ })).toBeDisabled();
    await expect(item('b').locator('[data-field="quiz-status"]')).toHaveText('1 от 3 отговорени');
    await page.reload();
    await expect(item('a').locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(item('b').locator('[data-field="quiz-status"]')).toHaveText('1 от 3 отговорени');
    for (const h of await page.locator('[data-list="quizzes"] button, [data-list="quizzes"] a').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  });
});

test.describe('T-049 screenshots (T049_SHOTS) and the real course (T049_REAL_DIR)', () => {
  for (const scheme of ['light', 'dark']) {
    test(`LRN-DEMO (${scheme}): question with a wrong answer and links, "Отначало" dialog, course with "Нулирай"; no horizontal scroll`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await importDemo(page);
      const dir = process.env.T049_SHOTS;
      const vp = page.viewportSize();
      const shot = async (name) => { if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: join(dir, `demo-${vp.width}x${vp.height}-${scheme}-${name}.png`), fullPage: true }); } };
      await page.goto('./#/c/LRN-DEMO/quiz/0001-1-vidove');
      await pick(page, 1);
      await shot('wrong-with-links');
      await next(page);
      await pick(page, 0);
      await shot('right');
      await restart(page).click();
      await shot('restart-dialog');
      await page.getByRole('button', { name: 'Отказ', exact: true }).click();
      await page.goto('./#/c/LRN-DEMO');
      await page.locator('[data-list="quizzes"]').scrollIntoViewIfNeeded();
      await page.locator('[data-list="quizzes"] [data-field="quiz-reset"]').first().click();
      await shot('course-reset');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    });
  }

  test('the real course: links of quiz 0001 shown and opening, only https; "Отначало"; marking', async ({ page, context }) => {
    const dir = process.env.T049_REAL_DIR;
    test.skip(!dir || !existsSync(dir), 'needs T049_REAL_DIR');
    test.setTimeout(120_000);
    const shots = process.env.T049_SHOTS;
    const vp = page.viewportSize();
    await importFiles(page, [asFile('LRN-CRA.zip', makeZip(readFixture(dir), { root: 'LRN-CRA' }))]);
    const courseId = await page.evaluate(async () => (await (await import('./src/db.js')).listCourses()).map((c) => c.id).find((id) => /CRA/i.test(id)));
    const quizzes = await page.evaluate(async (id) => (await (await import('./src/db.js')).listQuizzes(id)), courseId);
    let total = 0;
    for (const q of quizzes) for (const question of q.questions) {
      for (const l of question.links) { expect(l.url.startsWith('https://')).toBe(true); total++; }
    }
    console.log(`T-049 real course: ${quizzes.map((q) => `${q.slug}: ${q.questions.length} q, ${q.questions.reduce((n, x) => n + x.links.length, 0)} links`).join('; ')}`);
    expect(total).toBeGreaterThan(0);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const q of quizzes) {
        await page.goto(`./#/c/${courseId}`);
        await page.goto(`./#/c/${courseId}/quiz/${q.slug}`);
        await expect(page.locator('.quiz__question')).toBeVisible();
        await expect(counter(page)).toContainText('Въпрос 1 от');
        if (await page.locator('.quiz__verdict').count() === 0) {
          // A wrong choice if there is one.
          const wrong = q.questions[0].answer === 0 ? 1 : 0;
          await pick(page, wrong);
        }
        await expect(page.locator('.quiz__right')).toHaveCount(1);
        await expect(page.locator('.quiz__option--correct')).toHaveCount(0);
        await expect(page.locator('.quiz__src a')).toHaveCount(q.questions[0].links.length);
        if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `real-${vp.width}x${vp.height}-${scheme}-${q.slug}.png`), fullPage: true }); }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      }
    }
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('.quiz__src a').first().click()]);
    expect(popup.url()).toMatch(/^https:\/\//);
    await popup.close();
    await restart(page).click();
    await page.getByRole('button', { name: 'Изчисти и започни' }).click();
    await expect(counter(page)).toContainText('отговорени 0');
  });
});
