// T-047 (developer): the "Тестове" section (D-032/D-033). Quizzes from
// quizzes/*.json, shown by the app (not in the lesson frame): import and schema
// validation, the quiz screen (one question per screen, immediate feedback,
// Back/Next, progress, result, retry wrong, reset), the status in the course
// screen, the "Тест към урока" link in the reader, and the answers surviving a
// reload, offline and a re-import (kept by question text).
//
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO (with quizzes/) and small
// courses built in memory. The real course is used only through T047_REAL_DIR
// (outside the repository).
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();

let problems;
test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});
test.afterEach(() => { expect(problems).toEqual([]); });

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(FILES))]);
const importCourse = (page, id, files) => importFiles(page, [asFile(`${id}.zip`, makeZip(files, { root: id }))]);

async function openCourse(page, id) {
  await page.goto(`./#/c/${id}`);
  await expect(page.locator('[data-screen="course"]')).toBeVisible();
}
const quizScreen = (page) => page.locator('[data-screen="quiz"]');
const option = (page, text) => page.locator('.quiz__option', { hasText: text });
const storedChoices = (page, quizId) => page.evaluate(async (id) =>
  Object.keys((await (await import('./src/db.js')).getQuizAnswers(id)).choices).length, quizId);

test.describe('T-047 import and validation', () => {
  test('LRN-DEMO: both quizzes import and show in the "Тестове" section with a status', async ({ page }) => {
    const line = await importDemo(page);
    expect(line).toContain('2 теста');
    await openCourse(page, 'LRN-DEMO');
    // D-040 (T-057): no "Тестове" section; the quizzes are listed under their lesson.
    const list = page.locator('.course-item[data-item="LRN-DEMO/lesson:0001"] [data-list="quizzes"]');
    await expect(page.locator('[data-section="quizzes"]')).toHaveCount(0);
    await expect(list.locator('[data-quiz]')).toHaveCount(2);
    await expect(list.locator('[data-field="quiz-status"]').first()).toHaveText('не е започнат');
    await expect(list).toContainText('Видове чай');
    await expect(list).toContainText('Температура на запарване');
    await expect(page.locator('.course-item[data-item="LRN-DEMO/lesson:0001"] [data-field="lesson-meta"]')).toContainText('Тестове 0 от 2');
  });

  test('validation and limits: bad JSON, no questions, bad answer index, too few options, HTML kept as text, long text', async ({ page }) => {
    const bigQ = 'Ю'.repeat(6000);
    const r = await page.evaluate(async ({ bigQ }) => {
      const m = await import('./src/course-import.js');
      const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
      const parse = (path, bytes) => { const notes = []; return { quiz: m.parseQuiz('LRN-X', path, bytes, notes), notes }; };
      return {
        badJson: parse('quizzes/a.json', new TextEncoder().encode('{not json')).quiz,
        noQuestions: parse('quizzes/b.json', enc({ title: 'x', questions: [] })).quiz,
        allBadIndex: parse('quizzes/c.json', enc({ questions: [{ q: 'Q', options: ['a', 'b'], answer: 5 }] })).quiz,
        fewOptions: parse('quizzes/d.json', enc({ questions: [{ q: 'Q', options: ['a'], answer: 0 }] })).quiz,
        mixed: parse('quizzes/e.json', enc({ lesson: '0002', title: 'T', questions: [
          { q: 'good', options: ['a', 'b'], answer: 1, why: 'w', src: 's' },
          { q: 'bad index', options: ['a', 'b'], answer: 9 },
          { q: '<img src=x onerror="window.__xss=1">', options: ['<b>a</b>', 'b'], answer: 0 },
        ] })).quiz,
        long: parse('quizzes/f.json', enc({ questions: [{ q: bigQ, options: ['a', 'b'], answer: 0 }] })).quiz,
      };
    }, { bigQ });
    expect(r.badJson).toBeNull();
    expect(r.noQuestions).toBeNull();
    expect(r.allBadIndex).toBeNull();
    expect(r.fewOptions).toBeNull();
    // The mixed quiz keeps only the valid questions; HTML stays as plain text.
    expect(r.mixed.count).toBe(2);
    expect(r.mixed.lesson).toBe('0002');
    expect(r.mixed.questions[1].q).toBe('<img src=x onerror="window.__xss=1">');
    expect(r.mixed.questions[1].options[0]).toBe('<b>a</b>');
    expect(r.long.questions[0].q.length).toBe(4000); // clamped
  });

  test('HTML and <script> in quiz text are shown as text, never executed (Н-8)', async ({ page }) => {
    await importCourse(page, 'LRN-XSS', {
      'INDEX.md': strToU8('# LRN-XSS\n'),
      'lessons/0001-a.html': strToU8('<!DOCTYPE html><html><body><h1>Урок</h1></body></html>'),
      'quizzes/0001-x.json': strToU8(JSON.stringify({
        lesson: '0001', title: 'XSS <img src=x onerror="window.__xss=1">',
        questions: [{
          q: 'Избери: <script>window.__xss=1<\/script>',
          options: ['<b>без</b> форматиране', 'друго'],
          answer: 0,
          why: 'Обяснение <i>курсив</i>',
          src: 'Източник <script>1<\/script>',
        }],
      })),
    });
    await page.goto('./#/c/LRN-XSS/quiz/0001-x');
    await expect(quizScreen(page)).toBeVisible();
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Избери: <script>window.__xss=1<\/script>');
    await option(page, 'без').first().click();
    await expect(page.locator('.quiz__why')).toHaveText('Обяснение <i>курсив</i>');
    // Nothing executed, no element injected.
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('[data-screen="quiz"] img, [data-screen="quiz"] script, [data-screen="quiz"] b, [data-screen="quiz"] i').count()).toBe(0);
  });
});

test.describe('T-047 the quiz screen', () => {
  test('one question per screen, immediate feedback with explanation and source, Back/Next, progress, result', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/quiz/0001-1-vidove');
    await expect(quizScreen(page)).toBeVisible();
    await expect(page.locator('.quiz__count')).toContainText('Въпрос 1 от 3');

    // Answer question 1 correctly.
    await option(page, 'окисляване').first().click();
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    await expect(page.locator('.quiz__why')).toContainText('окислени');
    await expect(page.locator('.quiz__src')).toContainText('Източник:');
    await expect(page.locator('.quiz__option--correct')).toHaveCount(1);
    // Once answered the options are locked.
    await expect(option(page, 'Цветът').first()).toBeDisabled();

    await page.locator('button', { hasText: 'Напред' }).click();
    await expect(page.locator('.quiz__count')).toContainText('Въпрос 2 от 3');
    // Answer question 2 wrongly.
    await option(page, 'Не').first().click();
    await expect(page.locator('.quiz__verdict')).toHaveText('Грешно');
    await expect(page.locator('.quiz__option--wrong')).toHaveCount(1);
    await expect(page.locator('.quiz__option--correct')).toHaveCount(0); // D-036: the right option is not coloured
    await expect(page.locator('.quiz__right')).toContainText('Верен отговор: ');

    await page.locator('button', { hasText: 'Напред' }).click();
    await option(page, 'Матча').first().click(); // wrong (correct is Улун)
    await page.locator('button', { hasText: 'Виж резултата' }).click();

    await expect(page.locator('[data-field="quiz-result"]')).toBeVisible();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 3 верни');
    await expect(page.locator('.quiz__wrong-link')).toHaveCount(2);
  });

  test('"Опитай пак грешните" re-asks only the wrong questions; "Нулирай отговорите" clears after a confirmation', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/quiz/0001-2-temperatura');
    // Q1 wrong, Q2 correct.
    await option(page, '40').first().click();
    await page.locator('button', { hasText: 'Напред' }).click();
    await option(page, 'Да').first().click();
    await page.locator('button', { hasText: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 2 верни');

    await page.locator('button', { hasText: 'Опитай пак грешните' }).click();
    await expect(page.locator('.quiz__count')).toContainText('от 1'); // only the one wrong question
    await expect(page.locator('.quiz__option--correct')).toHaveCount(0); // a fresh, unanswered question
    await option(page, '75').first().click(); // now correct
    await page.locator('button', { hasText: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 2 от 2 верни');

    // Reset with confirmation.
    await page.locator('button', { hasText: 'Нулирай отговорите' }).click();
    await page.locator('[data-field="confirm-yes"]').click();
    await expect(page.locator('.quiz__count')).toContainText('отговорени 0');
    await openCourse(page, 'LRN-DEMO');
    await expect(page.locator('[data-quiz] [data-field="quiz-status"]').nth(1)).toHaveText('не е започнат');
  });
});

test.describe('T-047 the answers survive', () => {
  test('a reload and an offline reload keep the answers and the status', async ({ page, context }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/quiz/0001-1-vidove');
    await option(page, 'окисляване').first().click();
    await page.locator('button', { hasText: 'Напред' }).click();
    await option(page, 'Да').first().click(); // Q2 correct
    // The answers are written asynchronously; make sure they are persisted
    // before the reload (a real user never reloads within milliseconds).
    await expect.poll(() => storedChoices(page, 'LRN-DEMO/quiz:0001-1')).toBe(2);

    await page.reload();
    await expect(quizScreen(page)).toBeVisible();
    // Reopened at the same question, already answered.
    await expect(page.locator('.quiz__count')).toContainText('отговорени 2');
    await expect(page.locator('.quiz__feedback')).toBeVisible();

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(quizScreen(page)).toBeVisible();
      await expect(page.locator('.quiz__count')).toContainText('отговорени 2');
      await openCourse(page, 'LRN-DEMO');
      await expect(page.locator('[data-quiz] [data-field="quiz-status"]').first()).toHaveText('2 от 3 отговорени');
    } finally {
      await context.setOffline(false);
    }
  });

  test('a re-import keeps the answers of unchanged questions (by text) and resets a changed one', async ({ page }) => {
    const quiz = (questions) => ({ 'INDEX.md': strToU8('# LRN-RE\n'),
      'lessons/0001-a.html': strToU8('<!DOCTYPE html><html><body><h1>Урок</h1></body></html>'),
      'quizzes/0001-q.json': strToU8(JSON.stringify({ lesson: '0001', title: 'Q', questions })) });
    const q1 = { q: 'Първи въпрос?', options: ['а', 'б'], answer: 0, why: '', src: '' };
    const q2 = { q: 'Втори въпрос?', options: ['а', 'б'], answer: 1, why: '', src: '' };
    await importCourse(page, 'LRN-RE', quiz([q1, q2]));
    await page.goto('./#/c/LRN-RE/quiz/0001-q');
    await option(page, 'а').first().click(); // Q1 answered (correct)
    await page.locator('button', { hasText: 'Напред' }).click();
    await option(page, 'б').first().click(); // Q2 answered (correct)
    await expect(page.locator('.quiz__count')).toContainText('отговорени 2');
    await expect.poll(() => storedChoices(page, 'LRN-RE/quiz:path:quizzes/0001-q.json')).toBe(2);

    // Re-import: Q1 unchanged, Q2 text changed.
    const q2changed = { ...q2, q: 'Втори въпрос, преформулиран?' };
    await importCourse(page, 'LRN-RE', quiz([q1, q2changed]));
    await openCourse(page, 'LRN-RE'); // leave the quiz route so it re-renders
    await page.goto('./#/c/LRN-RE/quiz/0001-q');
    await expect(quizScreen(page)).toBeVisible();
    // Q1 kept its answer, Q2 reset → one answered of two.
    await expect(page.locator('.quiz__count')).toContainText('отговорени 1');
    // The reader reopens at the last question worked on (Q2), now a fresh,
    // changed question with no feedback.
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Втори въпрос, преформулиран?');
    await expect(page.locator('.quiz__feedback')).toHaveCount(0);
    await page.locator('button', { hasText: 'Назад' }).click(); // Q1 kept its answer
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Първи въпрос?');
    await expect(page.locator('.quiz__feedback')).toBeVisible();
  });
});

test.describe('T-047 reader link', () => {
  test('a lesson with quizzes shows "Тестове към урока" linking to each quiz', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/read/0001');
    const box = page.locator('[data-field="lesson-quizzes"]');
    await expect(box.locator('h3')).toHaveText('Тестове към урока');
    await expect(box.locator('a.quiz-list__link')).toHaveCount(2);
    await box.locator('a.quiz-list__link', { hasText: 'Видове чай' }).click();
    await expect(quizScreen(page)).toBeVisible();
    await expect(page.locator('.quiz__title')).toHaveText('Видове чай');
  });
});

test.describe('T-047 real course (T047_REAL_DIR, outside the repository)', () => {
  test('both quizzes for lesson 0001 appear and open', async ({ page }, info) => {
    const dir = process.env.T047_REAL_DIR;
    test.skip(!dir || !existsSync(dir) || info.project.name !== 'tablet-landscape', 'needs T047_REAL_DIR');
    const root = basename(dir.replace(/[\\/]+$/, ''));
    const real = readFixture(dir);
    await importFiles(page, [asFile(`${root}.zip`, makeZip(real, { root }))]);
    await openCourse(page, root);
    const quizzes = page.locator('[data-list="quizzes"] [data-quiz]');
    await expect(quizzes).toHaveCount(2); // 0001-1-obhvat, 0001-2-srokove (D-033)
    // Reader: both are linked under lesson 0001.
    await page.goto(`./#/c/${root}/read/0001`);
    await expect(page.locator('[data-field="lesson-quizzes"] a.quiz-list__link')).toHaveCount(2);
    // Open the first and answer one question.
    await page.locator('[data-field="lesson-quizzes"] a.quiz-list__link').first().click();
    await expect(quizScreen(page)).toBeVisible();
    await page.locator('.quiz__option').first().click();
    await expect(page.locator('.quiz__verdict')).toBeVisible();
    await page.screenshot({ path: info.outputPath('real-quiz.png') });
  });
});
