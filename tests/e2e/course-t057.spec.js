// T-057 (developer, 0.10.0): D-040 — the lessons and their quizzes in one list
// on the "Курс" screen — and the fixes T011F-D2/D4–D7, T056-D1–D3.
// - T057-L*: the folded line (status, number, title, progress line), the arrow
//   (a button with aria-expanded, a name, 44 px, keyboard, remembered in the
//   session), the unfolded quizzes ("Отвори", "Нулирай"), "Други тестове",
//   the quizzes of a retired lesson, the reader link "Тест към урока";
// - T057-S*: ● = marked AND all quizzes answered (D-040; since T-059, D-041: ● = marked,
//   the quizzes have their own mark and counter); "Завършени" and
//   "Продължи"/"Започни" on the course screen and the card;
// - T057-V*: no horizontal scroll at 1920×1200, 1280×800, 1200×1920, 800×1280,
//   360×800; light/dark contrast; two columns from 900 px;
// - T057-F*: the import notes (T056-D1/D2) and the blocked database (T056-D3).
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and small in-memory courses.
import { test, expect } from '@playwright/test';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
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

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    const s = await m.importCourse(list);
    return { text: m.describeSummary(s), notes: s.notes };
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(FILES))]);
function importCourse(page, id, files) {
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
  return importFiles(page, [asFile(`${id}.zip`, makeZip(bytes, { root: id }))]);
}
const lessonHtml = (title) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Измислен текст.</p></body></html>`;
const quiz = (lesson, title, n = 2) => JSON.stringify({
  ...(lesson === undefined ? {} : { lesson }), title,
  questions: Array.from({ length: n }, (_, i) => ({ q: `${title}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: 0, why: 'Защото.' })),
});
const indexMd = (id, rows, extra = '') => `# ${id}: индекс\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${rows.map(([n, t]) => `| ${n} | ${t} |`).join('\n')}\n${extra}`;

const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id) {
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });
const toggleOf = (page, number) => item(page, number).locator('[data-field="lesson-toggle"]');
const meta = (page, number) => item(page, number).locator('[data-field="lesson-meta"]');
// D-041 (T-059): the quizzes of a lesson have their own line ("Тестове: … Въпроси x от y").
const quizLine = (page, number) => item(page, number).locator('[data-field="lesson-quiz-line"]');
// Run fn(db, arg) in the page with the db module.
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
/** Answer the first `count` questions of a quiz (rightly unless `wrong`). */
const answer = (page, quizId, count, wrong = 0) => db(page, async (db, { quizId, count, wrong }) => {
  const q = await db.getQuiz(quizId);
  const keys = db.questionKeys(q.questions);
  for (let i = 0; i < count; i++) {
    const question = q.questions[i];
    const choice = question.options[i < wrong ? 1 - question.answer : question.answer];
    await db.saveQuizChoice(q.id, { courseId: q.courseId, qKey: keys[i], choice, cursor: i });
  }
}, { quizId, count, wrong });
const mark = (page, id, status = 'done') => db(page, (db, { id, status }) => db.setLessonProgress(id, { status, ...(status === 'done' ? { completedAt: '2026-11-20T09:00:00.000Z' } : {}) }), { id, status });

// ---------------------------------------------------------------------------
// The status matrix course (synthetic)
// ---------------------------------------------------------------------------
const M = 'LRN-T57';
const matrix = () => {
  const rows = [['0001', 'Отбелязан, тестовете не са минати'], ['0002', 'Нищо'], ['0003', 'Само тест'], ['0004', 'Отбелязан, всички тестове'],
    ['0005', 'Отбелязан, без тестове'], ['0006', 'Тестове, без отметка'], ['0007', 'Отворен'], ['0008', 'Оттеглен']];
  const f = { 'INDEX.md': indexMd(M, rows.filter(([n]) => n !== '0008'), '\n## Оттеглени номера\n- 0008 — махнат (2026-11-20)\n') };
  for (const [n, t] of rows) f[`lessons/${n}-urok.html`] = lessonHtml(t);
  Object.assign(f, {
    'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен 1'),
    'quizzes/0001-2-pregovor.json': quiz('0001', 'Преговор 1'),
    'quizzes/0002-1-osnoven.json': quiz('0002', 'Основен 2'),
    'quizzes/0003-1-osnoven.json': quiz('0003', 'Основен 3', 3),
    'quizzes/0003-2-pregovor.json': quiz('0003', 'Преговор 3'),
    'quizzes/0004-1-osnoven.json': quiz('0004', 'Основен 4'),
    'quizzes/0004-2-pregovor.json': quiz('0004', 'Преговор 4', 1),
    'quizzes/0006-1-osnoven.json': quiz('0006', 'Основен 6'),
    'quizzes/0008-1-osnoven.json': quiz('0008', 'Основен 8'),
    'quizzes/0099-1-bez-urok.json': quiz('0099', 'Без урок'),
    'quizzes/0005-1-bez-pole.json': quiz(undefined, 'Без поле lesson'),
  });
  return f;
};
async function seedMatrix(page) {
  await importCourse(page, M, matrix());
  await mark(page, `${M}/lesson:0001`);
  await answer(page, `${M}/quiz:0001-1`, 2);
  await answer(page, `${M}/quiz:0003-1`, 2, 1); // 2 of 3, 1 wrong
  await mark(page, `${M}/lesson:0004`);
  await answer(page, `${M}/quiz:0004-1`, 2, 1);
  await answer(page, `${M}/quiz:0004-2`, 1);
  await mark(page, `${M}/lesson:0005`);
  await answer(page, `${M}/quiz:0006-1`, 2);
  await mark(page, `${M}/lesson:0007`, 'started');
}

// D-041 (T-059) changed the rule of D-040 tested here: the status (○ ◐ ●) is the
// MATERIAL only; the quizzes have their own mark and counter. The matrix and the
// steps are the same; the expectations follow D-041 (every line is still checked).
test.describe('T057-S the status of a lesson and, apart, of its quizzes (D-040 → D-041)', () => {
  test('T057-S1 ● when marked, ◐ when opened, ○ otherwise — the quizzes do not count; their own line says how far they are', async ({ page }) => {
    await seedMatrix(page);
    await openCourse(page, M);
    const want = {
      '0001': ['done', 'Статус: Завършен', 'Тестове: започнати Въпроси 2 от 4'],
      '0002': ['new', 'Статус: Нов', 'Тестове: не са започнати Въпроси 0 от 2'],
      '0003': ['new', 'Статус: Нов', 'Тестове: започнати Въпроси 2 от 5'],
      '0004': ['done', 'Статус: Завършен', 'Тестове: минати Въпроси 3 от 3 · 67 % верни'],
      '0005': ['done', 'Статус: Завършен', null],
      '0006': ['new', 'Статус: Нов', 'Тестове: минати Въпроси 2 от 2 · 100 % верни'],
      '0007': ['started', 'Статус: Започнат', null],
    };
    for (const [n, [status, line, quizzes]] of Object.entries(want)) {
      await expect(item(page, n), n).toHaveAttribute('data-status', status);
      await expect(item(page, n).locator('.course-item__mark'), n).toHaveText({ new: '○', started: '◐', done: '●' }[status]);
      await expect(meta(page, n), n).toHaveText(line);
      if (quizzes) await expect(quizLine(page, n), n).toHaveText(quizzes);
      else await expect(quizLine(page, n), n).toBeHidden();
    }
    // The count and "Започни" go by the material: 0001, 0004, 0005 are done; 0002 is the first to do.
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 3 от 7 урока');
    await expect(course(page).locator('progress')).toHaveAttribute('value', '3');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Започни: урок 0002 — Нищо');
    // The card on "Курсове" counts the same way.
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${M}"] [data-field="course-progress"]`)).toHaveText('Завършени: 3 от 7');
  });

  test('T057-S2 "Нулирай" in the unfolded list: confirmation (focus on "Отказ"), then the quiz and the quiz line change at once and after a reload; the material does not', async ({ page }) => {
    await seedMatrix(page);
    await openCourse(page, M);
    await toggleOf(page, '0004').click();
    const row = item(page, '0004').locator('.quiz-list__item', { hasText: 'Преговор 4' });
    await expect(row.locator('[data-field="quiz-count"]')).toHaveText('Въпроси 1 от 1');
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('минат');
    await expect(row.locator('[data-field="quiz-correct"]')).toHaveText('1 от 1 верни (100 %)');
    await row.locator('[data-field="quiz-reset"]').click();
    await expect(row.getByRole('alertdialog')).toContainText('Да изтрия ли отговорите на „Преговор 4“?');
    await expect(row.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Enter'); // Enter on "Отказ" never deletes
    await expect(row.getByRole('alertdialog')).toHaveCount(0);
    await expect(row.locator('[data-field="quiz-reset"]')).toBeFocused();
    await expect(item(page, '0004')).toHaveAttribute('data-status', 'done');
    await row.locator('[data-field="quiz-reset"]').click();
    await row.locator('[data-field="confirm-yes"]').click();
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(row.locator('[data-field="quiz-count"]')).toHaveText('Въпроси 0 от 1');
    await expect(row.locator('[data-field="quiz-correct"]')).toHaveText('');
    await expect(row.locator('[data-field="quiz-reset"]')).toBeDisabled();
    // T058-D3 (T-059): the focus is on "Отвори" of the same quiz, not on <body>.
    await expect(row.getByRole('link', { name: 'Отвори теста „Преговор 4“' })).toBeFocused();
    await expect(item(page, '0004')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0004')).toHaveText('Статус: Завършен');
    await expect(quizLine(page, '0004')).toHaveText('Тестове: започнати Въпроси 2 от 3');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 3 от 7 урока');
    // The other quiz of the lesson is untouched.
    const other = item(page, '0004').locator('.quiz-list__item', { hasText: 'Основен 4' });
    await expect(other.locator('[data-field="quiz-status"]')).toHaveText('минат');
    await expect(other.locator('[data-field="quiz-correct"]')).toHaveText('1 от 2 верни (50 %)');
    await page.reload();
    await expect(item(page, '0004')).toHaveAttribute('data-status', 'done');
    await expect(quizLine(page, '0004')).toHaveText('Тестове: започнати Въпроси 2 от 3');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 3 от 7 урока');
  });

  test('T057-S3 answering the last question in the quiz screen makes the quizzes of a lesson "минати" on the way back, with the share of right answers', async ({ page }) => {
    await seedMatrix(page);
    await openCourse(page, M);
    await toggleOf(page, '0001').click();
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 2 от 4');
    await item(page, '0001').locator('.quiz-list__item', { hasText: 'Преговор 1' }).getByRole('link', { name: 'Отвори теста „Преговор 1“' }).click();
    await expect(page.locator('[data-screen="quiz"]')).toBeVisible();
    await page.locator('.quiz__option').first().click();
    await page.getByRole('button', { name: 'Напред' }).click();
    await page.locator('.quiz__option').first().click();
    await expect.poll(() => db(page, async (db, id) => Object.keys((await db.getQuizAnswers(id)).choices).length, `${M}/quiz:0001-2`)).toBe(2);
    await page.goBack();
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0001')).toHaveText('Статус: Завършен');
    await expect(quizLine(page, '0001')).toHaveText('Тестове: минати Въпроси 4 от 4 · 100 % верни');
    await expect(item(page, '0001').locator('[data-field="lesson-quiz-mark"]')).toHaveAttribute('data-state', 'passed');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 3 от 7 урока');
    // Unfolded state remembered in the session: the panel is still open.
    await expect(toggleOf(page, '0001')).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('T057-L the list: lessons with their quizzes', () => {
  test('T057-L1 no "Тестове" section; under each lesson its quizzes behind an arrow button (name, aria-expanded, aria-controls, 44 px); "Отвори" opens the quiz', async ({ page }) => {
    await importDemo(page);
    await openCourse(page, 'LRN-DEMO');
    expect(await course(page).locator('h2').allTextContents()).toEqual(['Последни дейности', 'Ресурси', 'Уроци', 'Справочници']);
    await expect(course(page).getByText(/^Тестове$/)).toHaveCount(0);
    const toggle = page.getByRole('button', { name: 'Тестове към урок 0001' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panelId = await toggle.getAttribute('aria-controls');
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toBeHidden();
    await expect(panel.locator('[data-quiz]')).toHaveCount(2);
    // Only lessons with quizzes have an arrow (R01 has none).
    await expect(course(page).locator('[data-field="lesson-toggle"]')).toHaveCount(1);
    const box = await toggle.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    const rows = panel.locator('.quiz-list__item');
    await expect(rows.locator('.quiz-list__title')).toHaveText(['Видове чай', 'Температура на запарване']);
    await expect(rows.locator('[data-field="quiz-status"]')).toHaveText(['не е започнат', 'не е започнат']);
    await expect(rows.locator('[data-field="quiz-reset"]')).toHaveText(['Нулирай', 'Нулирай']);
    await expect(rows.locator('[data-field="quiz-reset"]').first()).toBeDisabled();
    for (const el of await panel.locator('a, button').all()) {
      const b = await el.boundingBox();
      expect(b.height, await el.textContent()).toBeGreaterThanOrEqual(44);
    }
    // The title of the lesson still opens the lesson.
    await expect(item(page, '0001').locator('a.lesson-link')).toHaveAttribute('href', '#/c/LRN-DEMO/read/0001');
    await page.getByRole('link', { name: 'Отвори теста „Видове чай“' }).click();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/quiz\/0001-1-vidove$/);
    await page.locator('.quiz__option').first().click();
    await page.goBack();
    // D-041 (T-059): "Въпроси 1 от n", no share of right answers before all are answered.
    await expect(rows.first().locator('[data-field="quiz-count"]')).toHaveText(/^Въпроси 1 от \d+$/);
    await expect(rows.first().locator('[data-field="quiz-status"]')).toHaveText('започнат');
    await expect(rows.first().locator('[data-field="quiz-correct"]')).toHaveText('');
    await expect(meta(page, '0001')).toHaveText('Статус: Нов');
    await expect(quizLine(page, '0001')).toHaveText(/^Тестове: започнати Въпроси 1 от \d+$/);
  });

  test('T057-L2 the keyboard: Tab reaches the title, then the arrow; Enter and Space unfold and fold; the quizzes come next in the Tab order', async ({ page }) => {
    await importDemo(page);
    await openCourse(page, 'LRN-DEMO');
    await item(page, '0001').locator('a.lesson-link').focus();
    await page.keyboard.press('Tab');
    const toggle = toggleOf(page, '0001');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(item(page, '0001').locator('a.quiz-list__link').first()).toBeFocused();
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    expect(ring).not.toBe('none');
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, '0001').locator('[data-field="lesson-quiz-panel"]')).toBeHidden();
    await page.keyboard.press('Tab');
    // Folded: the next stop is the next lesson's link (R01), not a hidden quiz.
    await expect(item(page, 'R01').locator('a.lesson-link')).toBeFocused();
  });

  test('T057-L3 the unfolded lessons are remembered in the session (reload, back), not in a new tab', async ({ page, context }) => {
    await seedMatrix(page);
    await openCourse(page, M);
    await toggleOf(page, '0003').click();
    await toggleOf(page, '0006').click();
    await toggleOf(page, '0006').click(); // folded again
    await page.reload();
    await expect(toggleOf(page, '0003')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, '0003').locator('[data-field="lesson-quiz-panel"]')).toBeVisible();
    await expect(toggleOf(page, '0006')).toHaveAttribute('aria-expanded', 'false');
    await page.goto(`./#/c/${M}/read/0003`);
    await page.goBack();
    await expect(toggleOf(page, '0003')).toHaveAttribute('aria-expanded', 'true');
    const other = await context.newPage();
    await other.goto(`./#/c/${M}`);
    await expect(other.locator('.course-item[data-item="LRN-T57/lesson:0003"] [data-field="lesson-toggle"]')).toHaveAttribute('aria-expanded', 'false');
    await other.close();
  });

  test('T057-L4 "Други тестове" at the bottom: a quiz of a number not in the course and one without "lesson"; the quiz of a retired lesson stays under it in "Вече не са в курса"', async ({ page }) => {
    await seedMatrix(page);
    await openCourse(page, M);
    const other = course(page).locator('[data-section="other-quizzes"]');
    await expect(other.locator('h2')).toHaveText('Други тестове');
    expect((await other.locator('.quiz-list__title').allTextContents()).sort()).toEqual(['Без поле lesson', 'Без урок']);
    await expect(other.locator(`[data-quiz="${M}/quiz:0099-1"] .quiz-list__lesson`)).toHaveText('към урок 0099 — няма го в курса');
    await expect(other.locator(`[data-quiz="${M}/quiz:0005-1"] .quiz-list__lesson`)).toHaveText('без урок');
    await expect(other.locator('[data-quiz]')).toHaveCount(2);
    // At the bottom of the column, after the lessons and "Вече не са в курса".
    const order = await page.evaluate(() => [...document.querySelectorAll('.course__main [data-section]')].map((e) => e.dataset.section));
    expect(order).toEqual(['lessons', 'retired', 'other-quizzes']);
    // Its own quizzes are visible (no arrow needed) and open.
    await other.getByRole('link', { name: 'Отвори теста „Без урок“' }).click();
    await expect(page.locator('[data-screen="quiz"]')).toContainText('Без урок: въпрос 1?');
    await page.goBack();
    // The retired lesson 0008 carries its quiz; it is in no other list.
    const retired = course(page).locator('[data-section="retired"]');
    await retired.locator('summary').click();
    await expect(retired.locator('.course-item')).toHaveCount(1);
    await retired.getByRole('button', { name: 'Тестове към урок 0008' }).click();
    await expect(retired.locator('.quiz-list__title')).toHaveText(['Основен 8']);
    await expect(course(page).locator(`[data-quiz="${M}/quiz:0008-1"]`)).toHaveCount(1);
    // Every quiz is shown once.
    await expect(course(page).locator('[data-quiz]')).toHaveCount(11);
  });

  test('T057-L5 the reader keeps "Тест към урока" and the quiz routes work by slug', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await expect(page.locator('[data-field="lesson-quizzes"] h3')).toHaveText('Тестове към урока');
    await expect(page.locator('[data-field="lesson-quizzes"] a.quiz-list__link')).toHaveText(['Видове чай', 'Температура на запарване']);
    await page.locator('[data-field="lesson-quizzes"] a.quiz-list__link').nth(1).click();
    await expect(page).toHaveURL(/quiz\/0001-2-temperatura$/);
    await expect(page.locator('[data-screen="quiz"]')).toBeVisible();
  });

  test('T057-L6 a quiz title, a lesson title and a course name of 3000 letters without a space wrap; HTML in a quiz title is text', async ({ page }) => {
    const LONG = 'Щ'.repeat(3000);
    await importCourse(page, 'LRN-T57-LONG', {
      'INDEX.md': indexMd('LRN-T57-LONG', [['0001', LONG]]),
      'MISSION.md': `# Мисия: ${LONG}\n`,
      'lessons/0001-a.html': lessonHtml(LONG),
      'quizzes/0001-1-a.json': quiz('0001', `<img src=x onerror="window.__xss=1">${LONG}`),
      'quizzes/0002-1-a.json': quiz('0002', LONG),
    });
    for (const [w, hgt] of [[1920, 1200], [360, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await openCourse(page, 'LRN-T57-LONG');
      const t = toggleOf(page, '0001');
      if (await t.getAttribute('aria-expanded') === 'false') await t.click();
      const r = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(r[0], `course @${w}`).toBeLessThanOrEqual(r[1]);
      // The arrow stays inside the screen (it is never pushed out by the title).
      const tb = await t.boundingBox();
      expect(tb.x + tb.width, `arrow @${w}`).toBeLessThanOrEqual(w);
      expect(tb.width).toBeGreaterThanOrEqual(44);
      await page.goto('./#/');
      const c = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(c[0], `courses @${w}`).toBeLessThanOrEqual(c[1]);
    }
    await expect(page.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layout and themes
// ---------------------------------------------------------------------------
test.describe('T057-V layout', () => {
  const SIZES = [[1920, 1200], [1280, 800], [1200, 1920], [800, 1280], [360, 800]];
  test('T057-V1 every lesson unfolded: no horizontal scroll at 1920×1200, 1280×800, 1200×1920, 800×1280, 360×800; two columns from 900 px, one below; nothing of a quiz row sticks out', async ({ page }) => {
    test.setTimeout(90_000);
    await seedMatrix(page);
    for (const [w, hgt] of SIZES) {
      const tag = `${w}×${hgt}`;
      await page.setViewportSize({ width: w, height: hgt });
      await openCourse(page, M);
      const retired = course(page).locator('[data-section="retired"]');
      if (await retired.getAttribute('open') === null) await retired.locator('summary').click();
      const closed = page.locator('[data-field="lesson-toggle"][aria-expanded="false"]');
      for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
      const r = await page.evaluate(() => {
        const main = document.querySelector('.course__main').getBoundingClientRect();
        const side = document.querySelector('.course__side').getBoundingClientRect();
        const out = [...document.querySelectorAll('.course__main .quiz-list__item *, .course__main .course-item *')]
          .filter((e) => e.getClientRects().length && !e.closest('.visually-hidden'))
          .filter((e) => { const b = e.getBoundingClientRect(); return b.right > main.right + 1 || b.left < main.left - 1; })
          .map((e) => e.className || e.tagName);
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, two: side.left >= main.right, out };
      });
      expect(r.sw, `${tag}: no horizontal scroll`).toBeLessThanOrEqual(r.cw);
      expect(r.two, `${tag}: columns`).toBe(w >= 900);
      expect(r.out, `${tag}: inside the column`).toEqual([]);
    }
  });

  for (const theme of ['light', 'dark']) {
    test(`T057-V2 ${theme}: the lesson line, the quiz rows, the arrow and "Други тестове" are readable (≥ 4.5:1; the arrow ≥ 3:1)`, async ({ page }) => {
      await seedMatrix(page);
      await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
      await openCourse(page, M);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await toggleOf(page, '0001').click();
      const c = await page.evaluate(() => {
        const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const lum = (x) => { const [r, g, b] = x.map((v) => { const k = v / 255; return k <= 0.03928 ? k / 12.92 : ((k + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const bg = (el) => { for (let e = el; e; e = e.parentElement) { const v = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(v)) return rgb(v); } return rgb(getComputedStyle(document.body).backgroundColor); };
        const of = (sel, prop = 'color') => { const el = document.querySelector(sel); return ratio(rgb(getComputedStyle(el)[prop]), bg(el)); };
        return {
          meta: of('.course-item__meta'), title: of('.screen--course .quiz-list__title'), line: of('.screen--course .quiz-list__line'),
          open: of('.screen--course a.quiz-list__link'), reset: of('.screen--course .quiz-list__reset:not(:disabled)'),
          other: of('[data-section="other-quizzes"] .quiz-list__lesson'), arrow: of('.course-item__chevron', 'borderRightColor'),
          opacity: [...document.querySelectorAll('.course-item, .quiz-list__item')].every((e) => getComputedStyle(e).opacity === '1'),
        };
      });
      for (const k of ['meta', 'title', 'line', 'open', 'reset', 'other']) expect(c[k], `${theme} ${k}`).toBeGreaterThanOrEqual(4.5);
      expect(c.arrow, `${theme} arrow`).toBeGreaterThanOrEqual(3);
      expect(c.opacity).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// The fixes of the import and the database (T056-D1…D3)
// ---------------------------------------------------------------------------
test.describe('T057-F import notes and the blocked database', () => {
  test('T057-F1 (T056-D1) .html files in lessons/ and reference/ outside the pattern are named in the summary; real lessons are not', async ({ page }) => {
    const r = await importCourse(page, 'LRN-T57-ODD', {
      'INDEX.md': indexMd('LRN-T57-ODD', [['0001', 'Добър']]),
      'lessons/0001-dobar.html': lessonHtml('Добър'),
      'lessons/0004.html': lessonHtml('Без slug'),
      'lessons/003-tri.html': lessonHtml('Три цифри'),
      'reference/spravka.html': lessonHtml('Без номер'),
      'lessons/notes.txt': 'не е html',
    });
    expect([...r.notes].sort()).toEqual([
      'lessons/0004.html не е във вида NNNN-….html — не е внесен като урок',
      'lessons/003-tri.html не е във вида NNNN-….html — не е внесен като урок',
      'reference/spravka.html не е във вида R<номер>-….html — не е внесен като справочник',
    ]);
    expect(r.text).toContain(' Бележка: ');
    for (const n of r.notes) expect(r.text).toContain(n);
    expect(r.text).toMatch(/^Курсът LRN-T57-ODD е импортиран: 1 урок, 0 справочника/);
  });

  test('T057-F2 (T056-D2) a quiz of a missing lesson, of a retired lesson, without "lesson", or with another number in its name: imported, with a note each', async ({ page }) => {
    const r = await importCourse(page, M, matrix());
    expect(r.notes).toEqual(expect.arrayContaining([
      'тест quizzes/0099-1-bez-urok.json е към урок 0099, който го няма в курса — показан е в „Други тестове“',
      'тест quizzes/0008-1-osnoven.json е към урок 0008, който вече не е в курса',
      'тест quizzes/0005-1-bez-pole.json няма поле „lesson“ — показан е в „Други тестове“',
    ]));
    const files = { ...matrix(), 'quizzes/0002-2-drug.json': quiz('0001', 'Друг номер') };
    const r2 = await importCourse(page, M, files);
    expect(r2.notes).toContain('тест quizzes/0002-2-drug.json: номерът в името (0002) не е „lesson“ (0001) — тестът е показан при урок 0001');
    // LRN-DEMO (all regular): no note at all.
    const demo = await importDemo(page);
    expect(demo.notes).toEqual([]);
    expect(demo.text).toBe('Курсът LRN-DEMO е импортиран: 1 урок, 1 справочник, 2 теста, 13 файла.');
  });

  test('T057-F3 (T056-D3) an upgrade blocked by another tab: the screen says "Затвори другите раздели с EasyLRN и презареди"; the note goes away when the upgrade runs', async ({ page, context }) => {
    test.setTimeout(60_000);
    await page.goto('./manifest.webmanifest');
    await page.evaluate(() => new Promise((ok, ko) => { const r = indexedDB.deleteDatabase('lrn-app'); r.onsuccess = ok; r.onerror = ko; }));
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      await db.openDb({ name: 'lrn-app', version: 4 });
      db.closeDb();
    });
    const holder = await context.newPage();
    await holder.goto('./manifest.webmanifest');
    await holder.evaluate(() => new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { window.__hold = r.result; ok(); }; }));
    await page.goto('./');
    const box = page.locator('#db-error');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box).toHaveText('Друг раздел с EasyLRN държи базата отворена. Затвори другите раздели с EasyLRN и презареди. Не импортирай нищо дотогава.');
    await expect(box).toHaveAttribute('role', 'alert');
    await holder.evaluate(() => window.__hold.close());
    await expect(box).toBeHidden({ timeout: 15000 });
    await expect(page.locator('[data-panel="import"]')).toBeVisible();
    await holder.close();
  });
});
