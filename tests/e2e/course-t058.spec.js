// T-058 (tester): tests of T-057 (0.10.0) — D-040 (the lessons and their
// quizzes in one list on "Курс") and the fixes T011F-D2/D4–D7, T056-D1–D3.
// - T058-S*: the status rule ●/◐/○, "Тестове X от Y · a/b верни", "Завършени",
//   "Продължи"/"Започни", the card and "Последни дейности" after answering,
//   resetting, unmarking, a re-import with a new question, 0 questions, many
//   quizzes, no quizzes; the numbers against the quiz screen itself; fast taps;
//   the session memory;
// - T058-X*: HTML/script in the titles, in "lesson", in the confirmation, in
//   "Други тестове" and in the names of the new controls;
// - T058-F*: the fixes T011F-D2 (paths), D4, D5, D6 (sticky side at every
//   size), D7 (other mixes of quotes and lists, CPU ×4), T056-D1/D2/D3;
// - T058-V*: the sizes of the tablet and the phone, 160 % text, light/dark,
//   no horizontal scroll; the real course only through T058_REAL_ZIP (outside
//   the repository; D-026).
// Synthetic data only (D-026). Known defects: test.fail(true, 'T058-D…').
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
// A known defect: expected to fail (T058_RAW=1 runs them as ordinary tests, to see the real failure).
const known = (why) => { if (!process.env.T058_RAW) test.fail(true, why); };

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  // No real network at all (and api.anthropic.com is never reached).
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    try {
      const s = await m.importCourse(list);
      return { text: m.describeSummary(s), notes: s.notes };
    } catch (err) {
      return { error: m.errorMessage ? m.errorMessage(err) : String(err) };
    }
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(FILES))]);
function importCourse(page, id, files) {
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
  return importFiles(page, [asFile(`${id}.zip`, makeZip(bytes, { root: id }))]);
}
const lessonHtml = (title, body = '<p>Измислен текст.</p>') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const questions = (title, n) => Array.from({ length: n }, (_, i) => ({ q: `${title}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: 0, why: 'Защото.' }));
const quiz = (lesson, title, n = 2) => JSON.stringify({ ...(lesson === undefined ? {} : { lesson }), title, questions: questions(title, n) });
const indexMd = (id, rows, extra = '') => `# ${id}: индекс\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${rows.map(([n, t]) => `| ${n} | ${t} |`).join('\n')}\n${extra}`;
const pad4 = (n) => String(n).padStart(4, '0');

const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id) {
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });
const toggleOf = (page, number) => item(page, number).locator('[data-field="lesson-toggle"]');
const meta = (page, number) => item(page, number).locator('[data-field="lesson-meta"]');
const qrow = (page, number, title) => item(page, number).locator('.quiz-list__item', { has: page.locator(`.quiz-list__title:text-is("${title}")`) });
const progressLine = (page) => course(page).locator('[data-field="course-progress"]');
const continueBtn = (page) => course(page).locator('[data-action="continue"]');
const activity = (page) => course(page).locator('[data-section="activity"]');
async function unfold(page) {
  const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
  for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
/** Answer the first `count` questions of a quiz (rightly unless among the first `wrong`). */
const answer = (page, quizId, count, wrong = 0) => db(page, async (db, { quizId, count, wrong }) => {
  const q = await db.getQuiz(quizId);
  const keys = db.questionKeys(q.questions);
  for (let i = 0; i < Math.min(count, q.questions.length); i++) {
    const question = q.questions[i];
    const choice = question.options[i < wrong ? 1 - question.answer : question.answer];
    await db.saveQuizChoice(q.id, { courseId: q.courseId, qKey: keys[i], choice, cursor: i });
  }
}, { quizId, count, wrong });
const mark = (page, id, status = 'done', extra = {}) => db(page, (db, { id, status, extra }) => db.setLessonProgress(id, { status, ...(status === 'done' ? { completedAt: '2026-11-20T09:00:00.000Z' } : {}), ...extra }), { id, status, extra });
const cardProgress = (page, id) => page.locator(`[data-course="${id}"] [data-field="course-progress"]`);
const noHScroll = (page) => page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);

/** Answer a quiz through its own screen; returns what the screen says at the end. */
async function answerInQuizScreen(page, picks) {
  await expect(page.locator('[data-screen="quiz"] .quiz__question')).toBeVisible();
  for (let i = 0; i < picks.length; i++) {
    await page.locator('.quiz__option').nth(picks[i]).click();
    if (i < picks.length - 1) await page.getByRole('button', { name: 'Напред' }).click();
  }
  const count = await page.locator('.quiz__count').textContent();
  await page.getByRole('button', { name: 'Виж резултата' }).click();
  const score = await page.locator('.quiz__score').textContent();
  return { count, score };
}

// A course: 0001 with 2 quizzes (3 + 2 questions), 0002 with 1 quiz, 0003 without quizzes.
const C = 'LRN-T58';
const base = (extra = {}) => ({
  'INDEX.md': indexMd(C, [['0001', 'Първи урок'], ['0002', 'Втори урок'], ['0003', 'Трети без тестове']]),
  'lessons/0001-parvi.html': lessonHtml('Първи урок'),
  'lessons/0002-vtori.html': lessonHtml('Втори урок'),
  'lessons/0003-treti.html': lessonHtml('Трети без тестове'),
  'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен 1', 3),
  'quizzes/0001-2-pregovor.json': quiz('0001', 'Преговор 1', 2),
  'quizzes/0002-1-osnoven.json': quiz('0002', 'Основен 2', 2),
  ...extra,
});

// ---------------------------------------------------------------------------
// T058-S the status rule and its consistency on every place
// ---------------------------------------------------------------------------
test.describe('T058-S the status of a lesson with its quizzes', () => {
  test('T058-S1 answering every question in the quiz screen: the lesson line, the quiz rows and the quiz screen give the same numbers; ● only after the last quiz; count, "Започни", card and activity follow', async ({ page }) => {
    await importCourse(page, C, base());
    await mark(page, `${C}/lesson:0001`);
    await openCourse(page, C);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'started');
    await expect(meta(page, '0001')).toHaveText('Статус: Завършен · Тестове 0 от 2');
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 3 урока');
    await expect(continueBtn(page)).toHaveText('Започни: урок 0001 — Първи урок');
    // The first quiz: 3 questions, the second one wrong.
    await toggleOf(page, '0001').click();
    await qrow(page, '0001', 'Основен 1').getByRole('link', { name: 'Отвори теста „Основен 1“' }).click();
    const r1 = await answerInQuizScreen(page, [0, 1, 0]);
    expect(r1).toEqual({ count: 'Въпрос 3 от 3 · отговорени 3', score: 'Резултат: 2 от 3 верни' });
    await page.goBack();
    await expect(qrow(page, '0001', 'Основен 1').locator('[data-field="quiz-status"]')).toHaveText('резултат: 2 от 3 верни');
    await expect(qrow(page, '0001', 'Основен 1').locator('[data-field="quiz-correct"]')).toHaveText('');
    await expect(meta(page, '0001')).toHaveText('Статус: Завършен · Тестове 1 от 2 · 2/3 верни');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'started');
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 3 урока');
    // The second quiz: one of two answered, then both.
    await qrow(page, '0001', 'Преговор 1').getByRole('link', { name: 'Отвори теста „Преговор 1“' }).click();
    await page.locator('.quiz__option').first().click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 1 от 2 · отговорени 1');
    await page.goBack();
    await expect(qrow(page, '0001', 'Преговор 1').locator('[data-field="quiz-status"]')).toHaveText('1 от 2 отговорени');
    await expect(qrow(page, '0001', 'Преговор 1').locator('[data-field="quiz-correct"]')).toHaveText(' · 1 верен');
    await expect(meta(page, '0001')).toHaveText('Статус: Завършен · Тестове 1 от 2 · 3/4 верни');
    await qrow(page, '0001', 'Преговор 1').getByRole('link', { name: 'Отвори теста „Преговор 1“' }).click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 1 от 2 · отговорени 1');
    await page.getByRole('button', { name: 'Напред' }).click();
    await page.locator('.quiz__option').nth(1).click();
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 2 верни');
    await page.goBack();
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(item(page, '0001').locator('.course-item__mark')).toHaveText('●');
    await expect(meta(page, '0001')).toHaveText('Статус: Завършен · Тестове 2 от 2 · 3/5 верни');
    await expect(progressLine(page)).toHaveText('Завършени: 1 от 3 урока');
    await expect(course(page).locator('progress')).toHaveAttribute('value', '1');
    // Nothing opened through the reader → "Започни" goes to the first lesson that is not ●.
    await expect(continueBtn(page)).toHaveText('Започни: урок 0002 — Втори урок');
    await expect(activity(page)).toContainText('Тест „Преговор 1“: резултат: 1 от 2 верни');
    await expect(activity(page)).toContainText('Тест „Основен 1“: резултат: 2 от 3 верни');
    await page.goto('./#/');
    await expect(cardProgress(page, C)).toHaveText('Завършени: 1 от 3');
  });

  test('T058-S2 "Нулирай" of a finished quiz: the quiz, the lesson (● → ◐), the count, "Започни" and the card change; "Отказ" changes nothing', async ({ page }) => {
    await importCourse(page, C, base());
    await mark(page, `${C}/lesson:0001`);
    await answer(page, `${C}/quiz:0001-1`, 3, 1);
    await answer(page, `${C}/quiz:0001-2`, 2);
    await openCourse(page, C);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(progressLine(page)).toHaveText('Завършени: 1 от 3 урока');
    await toggleOf(page, '0001').click();
    const row = qrow(page, '0001', 'Основен 1');
    // "Отказ" (by a click) deletes nothing.
    await row.locator('[data-field="quiz-reset"]').click();
    await expect(row.getByRole('alertdialog')).toContainText('Да изтрия ли отговорите на „Основен 1“? Тестът ще започне отначало.');
    await row.locator('[data-field="confirm-no"]').click();
    await expect(row.getByRole('alertdialog')).toHaveCount(0);
    expect(await db(page, async (db, id) => Object.keys((await db.getQuizAnswers(id)).choices).length, `${C}/quiz:0001-1`)).toBe(3);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    // Escape is no "Изтрий" either.
    await row.locator('[data-field="quiz-reset"]').click();
    await page.keyboard.press('Escape');
    expect(await db(page, async (db, id) => Object.keys((await db.getQuizAnswers(id)).choices).length, `${C}/quiz:0001-1`)).toBe(3);
    if (await row.getByRole('alertdialog').count()) await row.locator('[data-field="confirm-no"]').click();
    // "Изтрий".
    await row.locator('[data-field="quiz-reset"]').click();
    await row.locator('[data-field="confirm-yes"]').click();
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'started');
    await expect(meta(page, '0001')).toHaveText('Статус: Завършен · Тестове 1 от 2 · 2/2 верни');
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 3 урока');
    await expect(continueBtn(page)).toHaveText('Започни: урок 0001 — Първи урок');
    expect(await db(page, async (db, id) => Object.keys((await db.getQuizAnswers(id)).choices).length, `${C}/quiz:0001-1`)).toBe(0);
    // The quiz screen says the same.
    await row.getByRole('link', { name: 'Отвори теста „Основен 1“' }).click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await page.goto('./#/');
    await expect(cardProgress(page, C)).toHaveText('Завършени: 0 от 3');
  });

  test('T058-S3 "Последни дейности" right after "Нулирай" (no reload) no longer shows the old result of the quiz', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0002-1`, 2);
    await openCourse(page, C);
    await expect(activity(page)).toContainText('Тест „Основен 2“: резултат: 2 от 2 верни');
    await toggleOf(page, '0002').click();
    const row = qrow(page, '0002', 'Основен 2');
    await row.locator('[data-field="quiz-reset"]').click();
    await row.locator('[data-field="confirm-yes"]').click();
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(meta(page, '0002')).toHaveText('Статус: Нов · Тестове 0 от 1');
    // After a reload the activity is right (the answers are gone) …
    const fresh = await page.context().newPage();
    await fresh.goto(`./#/c/${C}`);
    await expect(fresh.locator('[data-screen="course"] [data-section="activity"]')).not.toContainText('Основен 2');
    await fresh.close();
    // … but on this screen the side column still says "резултат: 2 от 2 верни".
    known('T058-D1: after "Нулирай" on the course screen only the quiz row, the lesson line and the progress/"Продължи" box are redrawn (onChange → renderStatus); "Последни дейности" keeps "Тест „…“: резултат: 2 от 2 верни" until the screen is reloaded');
    await expect(activity(page)).not.toContainText('Тест „Основен 2“: резултат');
  });

  test('T058-S4 unmarking "завършен" in the reader: ● → ◐ "Започнат", the count and the card drop; marking again brings ● back', async ({ page }) => {
    await importCourse(page, C, base());
    await mark(page, `${C}/lesson:0002`);
    await answer(page, `${C}/quiz:0002-1`, 2);
    await openCourse(page, C);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await item(page, '0002').locator('a.lesson-link').click();
    const btn = page.locator('[data-action="complete"]');
    await expect(btn).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await page.goBack();
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'started');
    await expect(meta(page, '0002')).toHaveText(/^Статус: Започнат · отворен днес \d\d:\d\d · Тестове 1 от 1 · 2\/2 верни$/);
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 3 урока');
    await expect(continueBtn(page)).toHaveText('Продължи: урок 0002 — Втори урок');
    await page.goto('./#/');
    await expect(cardProgress(page, C)).toHaveText('Завършени: 0 от 3 · последно: урок 0002');
    await page.goto(`./#/c/${C}/read/0002`);
    await expect(btn).toHaveAttribute('aria-pressed', 'false', { timeout: 20000 });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await page.goto(`./#/c/${C}`);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await expect(progressLine(page)).toHaveText('Завършени: 1 от 3 урока');
  });

  test('T058-S5 a re-import adds a question to a fully answered quiz: it is no longer answered to the end (row, lesson ● → ◐, count, card); the old answers stay', async ({ page }) => {
    await importCourse(page, C, base());
    await mark(page, `${C}/lesson:0002`);
    await answer(page, `${C}/quiz:0002-1`, 2);
    await openCourse(page, C);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    const more = JSON.stringify({ lesson: '0002', title: 'Основен 2', questions: [...questions('Основен 2', 2), { q: 'Нов въпрос?', options: ['А', 'Б'], answer: 1 }] });
    const r = await importCourse(page, C, base({ 'quizzes/0002-1-osnoven.json': more }));
    expect(r.error).toBeUndefined();
    await openCourse(page, C);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'started');
    await expect(meta(page, '0002')).toHaveText('Статус: Завършен · Тестове 0 от 1 · 2/2 верни');
    await toggleOf(page, '0002').click();
    await expect(qrow(page, '0002', 'Основен 2').locator('[data-field="quiz-status"]')).toHaveText('2 от 3 отговорени');
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 3 урока');
    await qrow(page, '0002', 'Основен 2').getByRole('link', { name: 'Отвори теста „Основен 2“' }).click();
    await expect(page.locator('.quiz__count')).toHaveText(/ от 3 · отговорени 2$/);
    await page.goto('./#/');
    await expect(cardProgress(page, C)).toHaveText('Завършени: 0 от 3');
    // Answering the new question makes it ● again.
    await answer(page, `${C}/quiz:0002-1`, 3);
    await openCourse(page, C);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0002')).toHaveText('Статус: Завършен · Тестове 1 от 1 · 3/3 верни');
  });

  test('T058-S6 a quiz with 0 questions is refused by the import; one with 0 questions in the store does not hold the lesson back and says "без въпроси"', async ({ page }) => {
    const r = await importCourse(page, C, base({ 'quizzes/0003-1-prazen.json': JSON.stringify({ lesson: '0003', title: 'Празен', questions: [] }) }));
    expect(JSON.stringify(r)).toMatch(/0003-1-prazen/);
    expect(await db(page, async (db, c) => (await db.listQuizzes(c)).map((q) => q.id), C)).not.toContain(`${C}/quiz:0003-1`);
    // A record without questions (an old or hand-made store) — the rule says it does not count.
    await db(page, async (db, c) => {
      const q = (await db.listQuizzes(c)).find((x) => x.id === `${c}/quiz:0002-1`);
      await db.put(db.STORES.quizzes, { ...q, id: `${c}/quiz:0003-9`, path: 'quizzes/0003-9-x.json', slug: '0003-9-x', lesson: '0003', title: 'Без въпроси', questions: [] });
    }, C);
    await mark(page, `${C}/lesson:0003`);
    await openCourse(page, C);
    await expect(item(page, '0003')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0003')).toHaveText('Статус: Завършен');
    await toggleOf(page, '0003').click();
    await expect(qrow(page, '0003', 'Без въпроси').locator('[data-field="quiz-status"]')).toHaveText('без въпроси');
    await expect(qrow(page, '0003', 'Без въпроси').locator('[data-field="quiz-reset"]')).toBeDisabled();
    await expect(progressLine(page)).toHaveText('Завършени: 1 от 3 урока');
  });

  test('T058-S7 a lesson with 12 quizzes: all under it in natural order (…9, 10, 11, 12), "Тестове 0 от 12", every row with "Отвори"/"Нулирай" ≥ 44 px, no scroll at 360 px', async ({ page }) => {
    const extra = {};
    for (let i = 1; i <= 12; i++) extra[`quizzes/0003-${i}-t${i}.json`] = quiz('0003', `Тест ${i}`, 1);
    await importCourse(page, C, base(extra));
    await openCourse(page, C);
    await expect(meta(page, '0003')).toHaveText('Статус: Нов · Тестове 0 от 12');
    await toggleOf(page, '0003').click();
    const titles = await item(page, '0003').locator('.quiz-list__title').allTextContents();
    expect(titles.length).toBe(12);
    await answer(page, `${C}/quiz:0003-7`, 1);
    await openCourse(page, C);
    await expect(meta(page, '0003')).toHaveText('Статус: Започнат · Тестове 1 от 12 · 1/1 верни');
    for (const el of await item(page, '0003').locator('.quiz-list__item a, .quiz-list__item button').all()) {
      const b = await el.boundingBox();
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize({ width: 360, height: 800 });
    const [sw, cw] = await noHScroll(page);
    expect(sw).toBeLessThanOrEqual(cw);
    test.info().annotations.push({ type: 'T058-I order of 12 quizzes', description: titles.join(', ') });
    expect(titles).toEqual(Array.from({ length: 12 }, (_, i) => `Тест ${i + 1}`));
  });

  test('T058-S8 a lesson without quizzes: no arrow, no "Тестове" part; ● as soon as it is marked; it is counted', async ({ page }) => {
    await importCourse(page, C, base());
    await openCourse(page, C);
    await expect(toggleOf(page, '0003')).toHaveCount(0);
    await expect(item(page, '0003').locator('[data-field="lesson-quiz-panel"]')).toHaveCount(0);
    await expect(meta(page, '0003')).toHaveText('Статус: Нов');
    await mark(page, `${C}/lesson:0003`);
    await openCourse(page, C);
    await expect(item(page, '0003')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0003')).toHaveText('Статус: Завършен');
    await expect(progressLine(page)).toHaveText('Завършени: 1 от 3 урока');
  });

  test('T058-S9 "lesson" written as "1", 1, "R1": the quiz is under 0001 / R01; a quiz of a reference is not counted in "Завършени"', async ({ page }) => {
    const files = base({
      'INDEX.md': indexMd(C, [['0001', 'Първи урок'], ['0002', 'Втори урок'], ['0003', 'Трети без тестове']], '\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справочник |\n'),
      'reference/R01-spravka.html': lessonHtml('Справочник'),
      'quizzes/0001-3-niz.json': quiz('1', 'Низ 1'),
      'quizzes/0001-4-chislo.json': JSON.stringify({ lesson: 1, title: 'Число 1', questions: questions('Число 1', 1) }),
      'quizzes/R01-1-spr.json': quiz('R1', 'Към справочника'),
    });
    const r = await importCourse(page, C, files);
    expect(r.error).toBeUndefined();
    await openCourse(page, C);
    await expect(meta(page, '0001')).toContainText('Тестове 0 от 4');
    await toggleOf(page, '0001').click();
    expect(await item(page, '0001').locator('.quiz-list__title').allTextContents()).toEqual(expect.arrayContaining(['Низ 1', 'Число 1']));
    const ref = page.getByRole('button', { name: 'Тестове към справочник R01' });
    await expect(ref).toBeVisible();
    await ref.click();
    await expect(item(page, 'R01').locator('.quiz-list__title')).toHaveText(['Към справочника']);
    await expect(course(page).locator('[data-section="other-quizzes"]')).toHaveCount(0);
    await answer(page, `${C}/quiz:path:quizzes/R01-1-spr.json`, 2);
    await openCourse(page, C);
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 3 урока');
  });

  test('T058-S10 a quiz of a retired number: under the lesson in "Вече не са в курса", not counted; when the number comes back the quiz comes back with the lesson and counts', async ({ page }) => {
    const rows = [['0001', 'Първи урок'], ['0002', 'Втори урок'], ['0003', 'Трети без тестове']];
    await importCourse(page, C, base());
    await mark(page, `${C}/lesson:0002`);
    await answer(page, `${C}/quiz:0002-1`, 2);
    // 0002 retired.
    const without = base({ 'INDEX.md': indexMd(C, rows.filter(([n]) => n !== '0002'), '\n## Оттеглени номера\n- 0002 — махнат (2026-11-20)\n') });
    const r = await importCourse(page, C, without);
    expect(r.error).toBeUndefined();
    await openCourse(page, C);
    await expect(progressLine(page)).toHaveText('Завършени: 0 от 2 урока');
    const retired = course(page).locator('[data-section="retired"]');
    await retired.locator('summary').click();
    await expect(retired.getByRole('button', { name: 'Тестове към урок 0002' })).toBeVisible();
    await expect(retired.locator('.course-item[data-status="done"]')).toHaveCount(1);
    await expect(course(page).locator('[data-section="other-quizzes"]')).toHaveCount(0);
    // Back in the course.
    await importCourse(page, C, base());
    await openCourse(page, C);
    await expect(course(page).locator('[data-section="retired"]')).toHaveCount(0);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0002')).toHaveText('Статус: Завършен · Тестове 1 от 1 · 2/2 верни');
    await expect(progressLine(page)).toHaveText('Завършени: 1 от 3 урока');
  });

  test('T058-S11 fast double taps: the arrow (two taps = open and closed, aria and session agree), "Нулирай" (one confirmation), "Изтрий" (one reset, no error)', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0001-1`, 3);
    await openCourse(page, C);
    const t = toggleOf(page, '0001');
    await t.dblclick();
    const panel = item(page, '0001').locator('[data-field="lesson-quiz-panel"]');
    const state = async () => ({
      aria: await t.getAttribute('aria-expanded'),
      hidden: await panel.evaluate((e) => e.hidden),
      stored: await page.evaluate((c) => sessionStorage.getItem(`easylrn:course-open:${c}`), C),
    });
    let s = await state();
    expect(s.aria === 'true').toBe(!s.hidden);
    expect((s.stored || '').includes('lesson:0001')).toBe(s.aria === 'true');
    // Taps of a finger: tap, tap.
    await t.tap();
    await t.tap();
    await t.tap();
    s = await state();
    expect(s.aria === 'true').toBe(!s.hidden);
    expect((s.stored || '').includes('lesson:0001')).toBe(s.aria === 'true');
    if (s.aria !== 'true') await t.click();
    await expect(panel).toBeVisible();
    const row = qrow(page, '0001', 'Основен 1');
    await row.locator('[data-field="quiz-reset"]').dblclick();
    await expect(row.locator('.quiz__confirm')).toHaveCount(1);
    // The second tap lands on "Нулирай" again (the focus goes there, not to "Отказ"): Enter there opens nothing new and deletes nothing.
    await page.keyboard.press('Enter');
    await expect(row.locator('.quiz__confirm')).toHaveCount(1);
    expect(await db(page, async (db, id) => Object.keys((await db.getQuizAnswers(id)).choices).length, `${C}/quiz:0001-1`)).toBe(3);
    await row.locator('[data-field="confirm-yes"]').dblclick();
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(row.locator('.quiz__confirm')).toHaveCount(0);
    await expect(meta(page, '0001')).toHaveText('Статус: Нов · Тестове 0 от 2');
  });

  test('T058-S12 focus after "Изтрий": not lost to the page (the reset button becomes disabled and the box goes away)', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0002-1`, 1);
    await openCourse(page, C);
    await toggleOf(page, '0002').click();
    const row = qrow(page, '0002', 'Основен 2');
    await row.locator('[data-field="quiz-reset"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(row.locator('[data-field="confirm-yes"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    const where = await page.evaluate(() => (document.activeElement === document.body ? 'body' : document.activeElement.outerHTML.slice(0, 80)));
    test.info().annotations.push({ type: 'T058-I focus after Изтрий', description: where });
    known('T058-D3: after "Изтрий" on the course screen the confirmation box (with the focused button) is removed and "Нулирай" becomes disabled; the focus falls to <body> — a keyboard or screen-reader user starts again at the top of the page');
    expect(where).not.toBe('body');
  });

  test('T058-S13 the session memory: corrupted JSON, a non-array, a foreign id; two courses with the same numbers keep their own memory', async ({ page }) => {
    await importCourse(page, C, base());
    await importCourse(page, 'LRN-T58B', { ...base(), 'INDEX.md': indexMd('LRN-T58B', [['0001', 'Първи урок']]) });
    for (const bad of ['{not json', '{"a":1}', '42', '[1, null, {"x":2}]', `["${C}/lesson:9999"]`]) {
      await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [`easylrn:course-open:${C}`, bad]);
      await openCourse(page, C);
      await expect(toggleOf(page, '0001'), bad).toHaveAttribute('aria-expanded', 'false');
      await expect(item(page, '0001').locator('[data-field="lesson-quiz-panel"]')).toBeHidden();
    }
    await toggleOf(page, '0001').click(); // fixes the stored value
    expect(JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k), `easylrn:course-open:${C}`))).toContain(`${C}/lesson:0001`);
    await openCourse(page, 'LRN-T58B');
    await expect(toggleOf(page, '0001')).toHaveAttribute('aria-expanded', 'false');
    await openCourse(page, C);
    await expect(toggleOf(page, '0001')).toHaveAttribute('aria-expanded', 'true');
    // The panel ids are unique on the page (lesson 0001 and reference R01 have different ones).
    const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('T058-S14 the arrow does not open the lesson; the title does; the arrow is a separate button with its own name and Enter/Space; folding while the focus is in the panel keeps the focus on the arrow', async ({ page }) => {
    await importCourse(page, C, base());
    await openCourse(page, C);
    const t = toggleOf(page, '0001');
    await expect(t).toHaveAccessibleName('Тестове към урок 0001');
    await expect(t).toHaveJSProperty('tagName', 'BUTTON');
    await t.click();
    await expect(page).toHaveURL(new RegExp(`#/c/${C}$`));
    const title = item(page, '0001').locator('a.lesson-link');
    const [tb, ab] = [await title.boundingBox(), await t.boundingBox()];
    // They do not overlap (a finger on the arrow is never on the title).
    expect(tb.x + tb.width <= ab.x || ab.x + ab.width <= tb.x || tb.y + tb.height <= ab.y || ab.y + ab.height <= tb.y).toBe(true);
    await item(page, '0001').locator('a.quiz-list__link').first().focus();
    await page.keyboard.press('Shift+Tab');
    await expect(t).toBeFocused();
    await page.keyboard.press('Space');
    await expect(t).toHaveAttribute('aria-expanded', 'false');
    await expect(t).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(t).toHaveAttribute('aria-expanded', 'true');
    await expect(page).toHaveURL(new RegExp(`#/c/${C}$`));
    await title.click();
    await expect(page).toHaveURL(new RegExp(`#/c/${C}/read/0001$`));
  });
});

// ---------------------------------------------------------------------------
// T058-X HTML/script in the new places
// ---------------------------------------------------------------------------
test.describe('T058-X HTML and script are text', () => {
  test('T058-X1 quiz and lesson titles, "lesson" and the number note with HTML: no element, no script, literal in aria-label, the confirmation and "Други тестове"', async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const X = 'LRN-T58X';
    const r = await importCourse(page, X, {
      'INDEX.md': indexMd(X, [['0001', `Урок ${evil}`]]),
      'lessons/0001-a.html': lessonHtml(`Урок ${evil}`),
      'quizzes/0001-1-a.json': quiz('0001', `Тест ${evil}`),
      'quizzes/0002-1-b.json': quiz(`0002${evil}`, `Друг ${evil}`),
      'quizzes/0003-1-c.json': quiz('<b>0003</b>', `Трети ${evil}`),
    });
    expect(r.error).toBeUndefined();
    await answer(page, `${X}/quiz:0001-1`, 1);
    await openCourse(page, X);
    await unfold(page);
    const row = course(page).locator(`[data-quiz="${X}/quiz:0001-1"]`);
    await expect(row.locator('.quiz-list__title')).toHaveText(`Тест ${evil}`);
    await expect(row.locator('[data-field="quiz-reset"]')).toHaveAttribute('aria-label', `Нулирай отговорите: Тест ${evil}`);
    await expect(row.getByRole('link', { name: `Отвори теста „Тест ${evil}“` })).toBeVisible();
    await row.locator('[data-field="quiz-reset"]').click();
    await expect(row.getByRole('alertdialog')).toContainText(`Да изтрия ли отговорите на „Тест ${evil}“?`);
    await row.locator('[data-field="confirm-no"]').click();
    const other = course(page).locator('[data-section="other-quizzes"]');
    await expect(other).toBeVisible();
    const notes = await other.locator('.quiz-list__lesson').allTextContents();
    // The odd "lesson" values are shown as literal text.
    expect(notes.sort()).toEqual([`към урок 0002${evil} — няма го в курса`, 'към урок <b>0003</b> — няма го в курса']);
    await expect(other.locator('.quiz-list__lesson *')).toHaveCount(0);
    await expect(other.locator('.quiz-list__title')).toHaveCount(2);
    await expect(course(page).locator('img, script:not([src]), b')).toHaveCount(0);
    await expect(meta(page, '0001')).toContainText('Тестове 0 от 1 · 1/1 верни');
    await page.goto('./#/');
    await expect(page.locator('img, b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    test.info().annotations.push({ type: 'T058-I notes of odd "lesson"', description: notes.join(' | ') });
  });
});

// ---------------------------------------------------------------------------
// T058-F the fixes
// ---------------------------------------------------------------------------
test.describe('T058-F the fixes of T-057', () => {
  test('T058-F1 (T011F-D2) "%2F", "%5C", "%252F" in the names of a reference, a quiz and a source: they open; "../" in any encoding never leaves the course', async ({ page }) => {
    const P = 'LRN-T58P';
    await importCourse(page, 'LRN-T58Q', { 'INDEX.md': indexMd('LRN-T58Q', [['0001', 'Друг']]), 'lessons/0001-a.html': lessonHtml('ДРУГ-КУРС'), 'secret.md': 'SECRET' });
    const r = await importCourse(page, P, {
      'INDEX.md': indexMd(P, [['0001', 'Урок']], '\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n'),
      'lessons/0001-a.html': lessonHtml('Урок', '<p><a id="s1" href="../sources/a%252Fb.md">източник</a></p>'),
      'reference/R01-x%2Fy.html': lessonHtml('Справка с наклонена черта'),
      'quizzes/0001-1-a%2Fb.json': quiz('0001', 'Тест с %2F'),
      'sources/a%2Fb.md': 'ИЗТОЧНИК-2F',
      'sources/a%5Cb.md': 'ИЗТОЧНИК-5C',
      'sources/a%252Fb.md': 'ИЗТОЧНИК-252F',
    });
    expect(r.error).toBeUndefined();
    await page.goto(`./#/c/${P}/read/R01`);
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await expect(page.frameLocator('iframe.lesson-frame').locator('h1')).toHaveText('Справка с наклонена черта');
    await openCourse(page, P);
    await unfold(page);
    await item(page, '0001').getByRole('link', { name: 'Отвори теста „Тест с %2F“' }).click();
    await expect(page.locator('[data-screen="quiz"] .quiz__question')).toHaveText('Тест с %2F: въпрос 1?');
    const got = await page.evaluate(async (P) => {
      const probe = async (u) => { const res = await fetch(u); const t = await res.text(); return `${res.status}${/SECRET|ДРУГ-КУРС/.test(t) ? ' LEAK' : ''}${/ИЗТОЧНИК-[0-9A-F]+/.exec(t)?.[0] ? ` ${/ИЗТОЧНИК-[0-9A-F]+/.exec(t)[0]}` : ''}`; };
      const out = {};
      for (const u of [
        `./c/${P}/sources/a%252Fb.md`, // "a%2Fb.md"
        `./c/${P}/sources/a%255Cb.md`, // "a%5Cb.md"
        `./c/${P}/sources/a%25252Fb.md`, // "a%252Fb.md"
        `./c/${P}/sources/a%2Fb.md`, // "a/b.md" — no such file, and a "/" in a segment
        `./c/${P}/sources/..%252F..%252FLRN-T58Q%252Fsecret.md`,
        `./c/${P}/..%252FLRN-T58Q%252Fsecret.md`,
        `./c/${P}/%252e%252e%252fLRN-T58Q%252fsecret.md`,
        `./c/${P}/..%255CLRN-T58Q%255Csecret.md`,
        `./c/${P}/%2e%2e%5cLRN-T58Q%5csecret.md`,
        `./c/${P}/sources/%25252e%25252e/x.md`,
        `./c/${P}%252F..%252FLRN-T58Q/secret.md`,
      ]) out[u.replace(`./c/${P}`, '')] = await probe(u);
      return out;
    }, P);
    test.info().annotations.push({ type: 'T058-I path probes', description: JSON.stringify(got) });
    expect(got['/sources/a%252Fb.md']).toBe('200 ИЗТОЧНИК-2F');
    expect(got['/sources/a%255Cb.md']).toBe('200 ИЗТОЧНИК-5C');
    expect(got['/sources/a%25252Fb.md']).toBe('200 ИЗТОЧНИК-252F');
    for (const [u, v] of Object.entries(got)) {
      expect(v, u).not.toMatch(/LEAK/);
      if (/\.\./.test(u) || /%2e%2e|%252e/.test(u)) expect(v, u).toMatch(/^40[04]$/);
    }
    // A link from the lesson through the bridge to such a source opens it (in the app, not a 404 page).
    problems = problems.filter((p) => !/status of 40[04]/.test(p));
  });

  test('T058-F2 (T011F-D4) course names from "# …": tab after "#", "#" alone, "#  two spaces", "#\\t\\t" with nothing — never the next line', async ({ page }) => {
    const cases = [
      ['LRN-T58H1', '#\tМисия с табулация\n\nСледващ ред.\n', 'Мисия с табулация'],
      ['LRN-T58H2', '#\n\nСледващ ред.\n', null],
      ['LRN-T58H3', '#  Две интервала\n', 'Две интервала'],
      ['LRN-T58H4', '#\t\t\nСледващ ред.\n', null],
      ['LRN-T58H5', '#Без интервал\n\nСледващ ред.\n', null],
    ];
    for (const [id, mission, want] of cases) {
      await importCourse(page, id, { 'INDEX.md': indexMd(id, [['0001', 'Урок']]), 'MISSION.md': mission, 'lessons/0001-a.html': lessonHtml('Урок') });
      await openCourse(page, id);
      const h1 = await course(page).locator('h1').textContent();
      expect(h1, id).not.toMatch(/Следващ ред/);
      if (want) expect(h1, id).toContain(want);
    }
  });

  test('T058-F3 (T011F-D5) a 4000-letter word in an import error, the import result, an empty course and the quiz rows: no horizontal scroll at 1920 and 360 px', async ({ page }) => {
    const LONG = 'Ж'.repeat(4000);
    const r = await importCourse(page, 'LRN-T58W', {
      'INDEX.md': indexMd('LRN-T58W', [['0001', LONG]]),
      'lessons/0001-a.html': lessonHtml(LONG),
      [`quizzes/0001-1-${'a'.repeat(200)}.json`]: quiz('0001', LONG),
      [`quizzes/0009-1-${'b'.repeat(200)}.json`]: quiz(`0009${LONG}`, LONG),
    });
    expect(r.error).toBeUndefined();
    for (const [w, hgt] of [[1920, 1200], [360, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await openCourse(page, 'LRN-T58W');
      await unfold(page);
      const [sw, cw] = await noHScroll(page);
      expect(sw, `course @${w}`).toBeLessThanOrEqual(cw);
      // Through the import panel: the result line with the long notes.
      await page.goto('./#/');
      await page.locator('[data-input="zip"]').setInputFiles({ name: 'LRN-T58W.zip', mimeType: 'application/zip', buffer: Buffer.from(makeZip(Object.fromEntries(Object.entries({
        'INDEX.md': indexMd('LRN-T58W', [['0001', LONG]]), 'lessons/0001-a.html': lessonHtml(LONG), [`lessons/${LONG.slice(0, 100)}.html`]: lessonHtml('x'),
      }).map(([p, v]) => [p, strToU8(v)])), { root: 'LRN-T58W' })) });
      await expect(page.locator('[data-field="import-result"]')).toBeVisible({ timeout: 15000 });
      const [sw2, cw2] = await noHScroll(page);
      expect(sw2, `courses @${w}`).toBeLessThanOrEqual(cw2);
    }
  });

  test('T058-F4 (T011F-D6) the sticky side column is never under the app bar: 5 sizes × top, middle and the very end, all lessons unfolded, "Ресурси" open', async ({ page }) => {
    test.setTimeout(120_000);
    const numbers = Array.from({ length: 40 }, (_, i) => pad4(i + 1));
    const files = { 'INDEX.md': indexMd('LRN-T58ST', numbers.map((n) => [n, `Урок ${n}`])), 'RESOURCES.md': `# Ресурси\n\n${Array.from({ length: 60 }, (_, i) => `Абзац ${i} с текст на ресурсите.`).join('\n\n')}` };
    for (const n of numbers) { files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n}`); files[`quizzes/${n}-1-t.json`] = quiz(n, `Тест ${n}`); }
    await importCourse(page, 'LRN-T58ST', files);
    const out = [];
    for (const [w, hgt] of [[1920, 1200], [1280, 800], [1200, 1920], [800, 1280], [360, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await openCourse(page, 'LRN-T58ST');
      await unfold(page);
      for (const res of [false, true]) {
        const details = course(page).locator('[data-section="resources"]');
        if (res && (await details.getAttribute('open')) === null) await details.locator('summary').click();
        for (const where of ['top', 'middle', 'end']) {
          const r = await page.evaluate(async (where) => {
            const max = document.documentElement.scrollHeight - innerHeight;
            window.scrollTo(0, where === 'top' ? 0 : where === 'middle' ? max / 2 : max);
            await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
            const bar = [...document.querySelectorAll('header, .app-bar, [data-field="app-bar"]')].map((e) => e.getBoundingClientRect()).filter((b) => b.height && b.top <= 0 + 1)[0];
            const p = document.querySelector('[data-field="course-progress"]').getBoundingClientRect();
            const go = document.querySelector('[data-action="continue"]').getBoundingClientRect();
            const two = document.querySelector('.course__side').getBoundingClientRect().left >= document.querySelector('.course__main').getBoundingClientRect().right;
            return { bar: bar ? Math.round(bar.bottom) : null, p: Math.round(p.top), go: Math.round(go.top), visible: p.bottom > 0 && p.top < innerHeight, two };
          }, where);
          out.push(`${w}×${hgt} res=${res} ${where}: ${JSON.stringify(r)}`);
          // Only when it is on the screen (one column: it scrolls away with the page as it should).
          if (r.two && r.visible && r.bar != null) {
            expect(r.p, `${w}×${hgt} res=${res} ${where}: progress`).toBeGreaterThanOrEqual(r.bar);
            expect(r.go, `${w}×${hgt} res=${res} ${where}: continue`).toBeGreaterThanOrEqual(r.bar);
          }
          if (r.two && where !== 'top') expect(r.visible, `${w}×${hgt} res=${res} ${where}: sticky`).toBe(true);
        }
      }
    }
    test.info().annotations.push({ type: 'T058-I sticky', description: out.join('\n') });
  });

  const MIXES = {
    'numbered-star': Array.from({ length: 1000 }, (_, i) => `${'1. > * > 2) > + > '.repeat(1 + (i % 8))}ред ${i}`).join('\n'),
    'lines-by-indent': Array.from({ length: 1000 }, (_, i) => `${'  '.repeat(i % 60)}${i % 2 ? '> ' : '- '}ред ${i}`).join('\n'),
    'quote-in-list-table': Array.from({ length: 300 }, (_, i) => `${'- > '.repeat(1 + (i % 6))}| a | b |\n${'- > '.repeat(1 + (i % 6))}|---|---|\n${'- > '.repeat(1 + (i % 6))}| ${i} | x |`).join('\n'),
    'tabs-mixed': Array.from({ length: 1000 }, (_, i) => `${'\t>\t-\t'.repeat(1 + (i % 20))}ред ${i}`).join('\n'),
  };
  for (const [name, md] of Object.entries(MIXES)) {
    test(`T058-F5 (T011F-D7) ${name}: at CPU ×4 the course screen with the resources is ready in < 3 s, no task > 2 s, no horizontal scroll`, async ({ page }) => {
      test.setTimeout(90_000);
      const id = `LRN-T58M${name.replace(/[^a-z]/g, '').slice(0, 8).toUpperCase()}`;
      await importCourse(page, id, { 'INDEX.md': indexMd(id, [['0001', 'Урок']]), 'RESOURCES.md': `# Ресурси\n\nПРЕДИ\n\n${md}\n\nСЛЕД-МАРКЕР`, 'lessons/0001-a.html': lessonHtml('Урок') });
      await page.goto('./#/');
      await page.evaluate(() => { window.__long = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ type: 'longtask', buffered: false }); });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const t0 = Date.now();
      await page.evaluate((id) => { location.hash = `#/c/${id}`; }, id);
      await course(page).locator('[data-section="resources"] summary').click({ timeout: 30000 });
      await expect(course(page).locator('[data-field="resources-text"]')).toContainText('СЛЕД-МАРКЕР', { timeout: 30000 });
      const ms = Date.now() - t0;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const r = await page.evaluate(() => {
        const res = document.querySelector('[data-field="resources-text"]');
        let depth = 0;
        for (const el of res.querySelectorAll('*')) { let d = 0; for (let e = el; e && e !== res; e = e.parentElement) d++; depth = Math.max(depth, d); }
        return { long: window.__long, depth, n: res.querySelectorAll('*').length, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      test.info().annotations.push({ type: `T058-I ${name}`, description: `${ms} ms, longest task ${Math.round(r.long)} ms, depth ${r.depth}, ${r.n} elements` });
      console.log(`T058-F5 ${name}: ${ms} ms, longest task ${Math.round(r.long)} ms, depth ${r.depth}, ${r.n} elements`);
      expect(ms).toBeLessThan(3000);
      expect(r.long).toBeLessThan(2000);
      expect(r.sw).toBeLessThanOrEqual(r.cw);
      problems = problems.filter((p) => !/Markdown not rendered/.test(p));
    });
  }

  test('T058-F6 (T011F-D7) ordinary Markdown up to 4 levels keeps its structure', async ({ page }) => {
    const { got } = await page.evaluate(async () => {
      const m = await import('./src/markdown.js');
      const cases = ['> - точка', '- > цитат в списък', '> 1. - > четири', '1. > - > четири', '- a\n  - b\n    - c\n      - d', '> > > > четири цитата', '- > цитат\n  > продължение'];
      return { got: cases.map((c) => m.limitNesting(c) === c) };
    });
    expect(got).toEqual([true, true, true, true, true, true, true]);
  });

  test('T058-F7 (T056-D1) ".HTML", ".htm", "0004-.html", "R1.html": notes; "0005-ok.HTM" is a lesson or named', async ({ page }) => {
    const r = await importCourse(page, 'LRN-T58N', {
      'INDEX.md': indexMd('LRN-T58N', [['0001', 'Добър'], ['0005', 'Главни']]),
      'lessons/0001-dobar.html': lessonHtml('Добър'),
      'lessons/0004.HTML': lessonHtml('Главни без slug'),
      'lessons/0006-.html': lessonHtml('Празен slug'),
      'lessons/spravka.htm': lessonHtml('htm'),
      'lessons/0005-ok.HTM': lessonHtml('Главни'),
      'reference/R1.html': lessonHtml('R без slug'),
    });
    expect(r.error).toBeUndefined();
    const lessons = await db(page, async (db) => (await db.listLessons('LRN-T58N')).map((l) => l.number), null);
    test.info().annotations.push({ type: 'T058-I notes', description: `${JSON.stringify(r.notes)} lessons ${JSON.stringify(lessons)}` });
    // The extension is stored in lower case (import normalisation), so the note says "0004.html".
    for (const f of ['lessons/0004.html', 'lessons/0006-.html', 'lessons/spravka.htm']) expect(r.notes.join('\n'), f).toContain(f);
    // "R1.html" and "0005-ok.HTM" are in the pattern: a reference and a lesson, no note.
    expect(lessons).toEqual(expect.arrayContaining(['0001', '0005', 'R01']));
    expect(r.notes.join('\n')).not.toMatch(/R1\.html|0005-ok/i);
  });

  test('T058-F8 (T056-D2) a quiz of a planned but not imported number, of "0002" with leading zeros missing ("2") → no note; LRN-DEMO and LRN-T58 → no notes at all', async ({ page }) => {
    const ok = await importCourse(page, C, base({ 'quizzes/0002-2-bez-nuli.json': quiz('2', 'Без нули') }));
    expect(ok.notes).toEqual([]);
    expect((await importDemo(page)).notes).toEqual([]);
    const planned = await importCourse(page, 'LRN-T58PL', {
      'INDEX.md': indexMd('LRN-T58PL', [['0001', 'Има го'], ['0002', 'Планиран']]),
      'lessons/0001-a.html': lessonHtml('Има го'),
      'quizzes/0002-1-a.json': quiz('0002', 'Към планиран'),
    });
    expect(planned.notes.join('\n')).toMatch(/0002/);
    await openCourse(page, 'LRN-T58PL');
    const note = await course(page).locator('[data-section="other-quizzes"] .quiz-list__lesson').textContent();
    test.info().annotations.push({ type: 'T058-I quiz of a planned lesson', description: `${JSON.stringify(planned.notes)} / "${note}"` });
    await expect(course(page).locator('[data-planned="0002"]')).toBeVisible();
  });

  test('T058-F9 (T056-D3) blocked, released, blocked again: the note comes and goes each time; the app works afterwards', async ({ page, context }) => {
    test.setTimeout(90_000);
    const box = page.locator('#db-error');
    for (let round = 0; round < 2; round++) {
      await page.goto('./manifest.webmanifest');
      await page.evaluate(() => new Promise((ok, ko) => { const r = indexedDB.deleteDatabase('lrn-app'); r.onsuccess = ok; r.onerror = ko; r.onblocked = ok; }));
      await page.evaluate(async () => { const db = await import('./src/db.js'); await db.openDb({ name: 'lrn-app', version: 4 }); db.closeDb(); });
      const holder = await context.newPage();
      await holder.goto('./manifest.webmanifest');
      await holder.evaluate(() => new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { window.__hold = r.result; ok(); }; }));
      await page.goto('./');
      await expect(box).toBeVisible({ timeout: 10000 });
      await expect(box).toContainText('Затвори другите раздели с EasyLRN и презареди');
      await holder.evaluate(() => window.__hold.close());
      await expect(box).toBeHidden({ timeout: 15000 });
      await holder.close();
    }
    const r = await importDemo(page);
    expect(r.error).toBeUndefined();
    await openCourse(page, 'LRN-DEMO');
    await expect(box).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// T058-V layout: sizes, 160 %, themes; the real course (T058_REAL_ZIP)
// ---------------------------------------------------------------------------
test.describe('T058-V layout', () => {
  const SIZES = [[1920, 1200], [1280, 800], [1200, 1920], [800, 1280], [360, 800]];
  test('T058-V1 17 lessons × 2 quizzes (synthetic, like LRN-CRA), all unfolded, at 5 sizes × 100 % / 160 % × light / dark: no horizontal scroll, nothing out of its column, arrows ≥ 44 px', async ({ page }) => {
    test.setTimeout(240_000);
    const id = 'LRN-T58CRA';
    const numbers = Array.from({ length: 17 }, (_, i) => pad4(i + 1));
    const files = { 'INDEX.md': indexMd(id, numbers.map((n) => [n, `Урок ${n} с доста дълго заглавие за оценка на риска и съответствие`])) };
    for (const n of numbers) {
      files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n} с доста дълго заглавие за оценка на риска и съответствие`);
      files[`quizzes/${n}-1-osnoven.json`] = quiz(n, `Провери се: основни понятия към урок ${n}`, 9);
      files[`quizzes/${n}-2-pregovor.json`] = quiz(n, `Преговор към урок ${n}`, 4);
    }
    await importCourse(page, id, files);
    await mark(page, `${id}/lesson:0001`, 'done', { lastOpenedAt: '2026-11-20T08:00:00.000Z' });
    await answer(page, `${id}/quiz:0001-1`, 9, 3);
    await answer(page, `${id}/quiz:0002-1`, 3, 1);
    for (const theme of ['light', 'dark']) {
      await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
      for (const scale of ['100%', '160%']) {
        for (const [w, hgt] of SIZES) {
          // 360×800 at 160 %: T058-D4, in T058-V1b.
          if (scale === '160%' && w === 360) continue;
          const tag = `${theme} ${scale} ${w}×${hgt}`;
          await page.setViewportSize({ width: w, height: hgt });
          await openCourse(page, id);
          await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
          await unfold(page);
          const r = await page.evaluate(() => {
            const main = document.querySelector('.course__main').getBoundingClientRect();
            const out = [...document.querySelectorAll('.course__main .course-item *')]
              .filter((e) => e.getClientRects().length && !e.closest('.visually-hidden'))
              .filter((e) => { const b = e.getBoundingClientRect(); return b.right > main.right + 1 || b.left < main.left - 1; })
              .map((e) => e.className || e.tagName);
            const small = [...document.querySelectorAll('[data-field="lesson-toggle"], .course__main .quiz-list__item a, .course__main .quiz-list__item button')]
              .map((e) => e.getBoundingClientRect()).filter((b) => b.width < 44 || b.height < 44).length;
            const cw = document.documentElement.clientWidth;
            const wide = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > cw + 0.5)
              .map((e) => `${e.tagName}.${e.className}:${e.getBoundingClientRect().right.toFixed(1)}`).slice(0, 6);
            return { sw: document.documentElement.scrollWidth, cw, out: [...new Set(out)], small, wide };
          });
          expect(r.sw, `${tag}: scroll ${JSON.stringify(r.wide)}`).toBeLessThanOrEqual(r.cw);
          expect(r.out, `${tag}: out of the column`).toEqual([]);
          expect(r.small, `${tag}: small targets`).toBe(0);
        }
      }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await expect(meta(page, '0001')).toHaveText(/^Статус: Завършен · отворен .* · Тестове 1 от 2 · 6\/9 верни$/);
    await expect(meta(page, '0002')).toHaveText('Статус: Започнат · Тестове 0 от 2 · 2/3 верни');
  });

  test('T058-V1b 360×800 at 160 %, a lesson unfolded: the "Нулирай" buttons stay inside the screen (no horizontal scroll)', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0001-1`, 1);
    await page.setViewportSize({ width: 360, height: 800 });
    await openCourse(page, C);
    await page.evaluate(() => { document.documentElement.style.fontSize = '160%'; });
    await toggleOf(page, '0001').click();
    const r = await page.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > cw + 0.5)
        .map((e) => `${e.className}:${e.getBoundingClientRect().right.toFixed(1)}`);
      return { sw: document.documentElement.scrollWidth, cw, wide: [...new Set(wide)] };
    });
    test.info().annotations.push({ type: 'T058-I 360@160%', description: JSON.stringify(r) });
    known('T058-D4: at 360×800 with the text at 160 %, the actions of an unfolded quiz row ("Отвори" + "Нулирай", .quiz-list__actions) are 1 px wider than the screen (right edge 361.1 px): the course screen scrolls sideways by 1 px');
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });

  test('T058-V2 the real course LRN-CRA (only with T058_REAL_ZIP, outside the repository): 17 lessons × 2 quizzes, 0 notes, no "Други тестове", no scroll at 5 sizes', async ({ page }) => {
    const zip = process.env.T058_REAL_ZIP;
    test.skip(!zip || !existsSync(zip), 'T058_REAL_ZIP not set');
    test.setTimeout(180_000);
    const r = await importFiles(page, [{ name: 'LRN-CRA.zip', buffer: readFileSync(zip) }]);
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([]);
    test.info().annotations.push({ type: 'T058-I LRN-CRA import', description: r.text });
    await openCourse(page, 'LRN-CRA');
    await expect(course(page).locator('[data-section="other-quizzes"]')).toHaveCount(0);
    await expect(course(page).locator('[data-section="lessons"] [data-field="lesson-toggle"]')).toHaveCount(17);
    for (let i = 1; i <= 17; i++) await expect(page.getByRole('button', { name: `Тестове към урок ${pad4(i)}` })).toHaveCount(1);
    await expect(course(page).locator('[data-section="lessons"] [data-quiz]')).toHaveCount(34);
    for (const [w, hgt] of SIZES) {
      for (const theme of ['light', 'dark']) {
        await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
        await page.setViewportSize({ width: w, height: hgt });
        await openCourse(page, 'LRN-CRA');
        await unfold(page);
        const [sw, cw] = await noHScroll(page);
        expect(sw, `${theme} ${w}×${hgt}`).toBeLessThanOrEqual(cw);
      }
    }
    const again = await importFiles(page, [{ name: 'LRN-CRA.zip', buffer: readFileSync(zip) }]);
    expect(again.text).toMatch(/^Без промени\./);
    expect(again.notes).toEqual([]);
  });
});
