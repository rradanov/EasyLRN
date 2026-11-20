// T-059 (developer, 0.11.0): D-041 — the material and the quizzes are counted
// apart; "Последни дейности" is a history of places — and T058-D1/D3/D4.
// - T059-S*: ○ ◐ ● = the material only (opened / marked); the quiz mark of a
//   lesson ("Тестове: не са започнати / започнати / минати", not by colour
//   alone, visible in the folded row); "Въпроси x от y"; the share of right
//   answers only once every question (of the quiz / of the lesson) is
//   answered; "Завършени", "Продължи/Започни" and the card by the material;
//   no "отворен днес …" in the row;
// - T059-H*: the history (store `history`, schema v6): lessons, references
//   and quizzes with their position, newest first, a place once (a revisit
//   moves it up), 10 shown / 50 kept, a tap goes back to the same place
//   (scroll position, fragment, question); after "Нулирай" it is read again
//   (T058-D1); HTML in titles is text; in the backup stores;
// - T059-M*: migration v5 → v6 (nothing lost, the history starts from the
//   opened lessons and answered quizzes); a failed one says so on the screen;
// - T059-F*: T058-D3 (focus after "Изтрий"), T058-D4 (360×800 at 160 %);
// - T059-V*: sizes × 100/160 % × light/dark: no horizontal scroll, contrast.
// Synthetic data only (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
let allowed;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  allowed = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  // No real network (api.anthropic.com is never reached).
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
  expect(external).toEqual([]);
});
async function start(page) {
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function importCourse(page, id, files) {
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
  const f = asFile(`${id}.zip`, makeZip(bytes, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try {
      const s = await m.importCourse([new File([new Uint8Array(bytes)], name)]);
      return { text: m.describeSummary(s), notes: s.notes };
    } catch (err) {
      return { error: m.errorMessage(err) };
    }
  }, { name: f.name, bytes: [...f.buffer] });
}
const lessonHtml = (title, body = '<p>Измислен текст.</p>') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const LONG_BODY = '<p>Начало.</p><div style="height:4000px"></div><h2 id="sredata">Средата</h2><div style="height:4000px"></div><p id="kraj">Край.</p>';
const quiz = (lesson, title, n = 2) => JSON.stringify({
  ...(lesson === undefined ? {} : { lesson }), title,
  questions: Array.from({ length: n }, (_, i) => ({ q: `${title}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: 0, why: 'Защото.' })),
});
const indexMd = (id, rows, extra = '') => `# ${id}: индекс\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${rows.map(([n, t]) => `| ${n} | ${t} |`).join('\n')}\n${extra}`;
const pad4 = (n) => String(n).padStart(4, '0');

const C = 'LRN-T59';
const base = (extra = {}) => ({
  'INDEX.md': indexMd(C, [['0001', 'Първи урок'], ['0002', 'Втори урок'], ['0003', 'Трети без тестове'], ['0004', 'Четвърти']],
    '\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n'),
  'lessons/0001-parvi.html': lessonHtml('Първи урок', LONG_BODY),
  'lessons/0002-vtori.html': lessonHtml('Втори урок'),
  'lessons/0003-treti.html': lessonHtml('Трети без тестове'),
  'lessons/0004-chetvarti.html': lessonHtml('Четвърти'),
  'reference/R01-spravka.html': lessonHtml('Справка', LONG_BODY),
  'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен 1', 3),
  'quizzes/0001-2-pregovor.json': quiz('0001', 'Преговор 1', 2),
  'quizzes/0002-1-osnoven.json': quiz('0002', 'Основен 2', 4),
  'quizzes/0004-1-osnoven.json': quiz('0004', 'Основен 4', 1),
  ...extra,
});

const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id = C) {
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"] [data-field="activity"] > *')).toHaveCount(1, { timeout: 15000 });
}
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });
const toggleOf = (page, number) => item(page, number).locator('[data-field="lesson-toggle"]');
const meta = (page, number) => item(page, number).locator('[data-field="lesson-meta"]');
const quizLine = (page, number) => item(page, number).locator('[data-field="lesson-quiz-line"]');
const quizMark = (page, number) => item(page, number).locator('[data-field="lesson-quiz-mark"]');
const qrow = (page, number, title) => item(page, number).locator('.quiz-list__item', { has: page.locator(`.quiz-list__title:text-is("${title}")`) });
const history = (page) => course(page).locator('[data-list="activity"] > li');
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
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
    await db.saveQuizChoice(q.id, { courseId: q.courseId, qKey: keys[i], choice: question.options[i < wrong ? 1 - question.answer : question.answer], cursor: i });
  }
}, { quizId, count, wrong });
const mark = (page, id, status = 'done') => db(page, (db, { id, status }) => db.setLessonProgress(id, { status, ...(status === 'done' ? { completedAt: '2026-11-20T09:00:00.000Z' } : {}) }), { id, status });
const historyRecords = (page, id = C) => db(page, async (db, id) => (await db.listHistory(id)).map((r) => [r.id.slice(id.length + 1), r.kind, r.scrollY, r.anchor, r.question]), id);
const lessonScroll = (page) => page.evaluate(() => {
  const frame = document.querySelector('iframe.lesson-frame');
  const bar = document.querySelector('.app-bar').getBoundingClientRect().height;
  return Math.round(window.scrollY - (frame.getBoundingClientRect().top + window.scrollY - bar));
});

// ---------------------------------------------------------------------------
// T059-S the material and its quizzes apart (D-041)
// ---------------------------------------------------------------------------
test.describe('T059-S status of the material, mark and counter of the quizzes (D-041)', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T059-S1 every combination: ○/◐/● by the material only; the quiz mark none / не са започнати / започнати / минати with words and data-state; "Въпроси x от y"; the share only when all are answered', async ({ page }) => {
    await importCourse(page, C, base());
    // 0001: marked, quizzes partly answered (3 of 5, 1 wrong) → ●, "започнати".
    await mark(page, `${C}/lesson:0001`);
    await answer(page, `${C}/quiz:0001-1`, 3, 1);
    // 0002: never opened, all 4 answered (1 wrong) → ○, "минати", 75 %.
    await answer(page, `${C}/quiz:0002-1`, 4, 1);
    // 0003: opened, no quizzes → ◐, no quiz line.
    await mark(page, `${C}/lesson:0003`, 'started');
    // 0004: nothing → ○, "не са започнати".
    await openCourse(page);
    const want = {
      '0001': ['done', '●', 'Статус: Завършен', 'started', 'Тестове: започнати', 'Въпроси 3 от 5', ''],
      '0002': ['new', '○', 'Статус: Нов', 'passed', 'Тестове: минати', 'Въпроси 4 от 4', '75 % верни'],
      '0003': ['started', '◐', 'Статус: Започнат', null],
      '0004': ['new', '○', 'Статус: Нов', 'new', 'Тестове: не са започнати', 'Въпроси 0 от 1', ''],
    };
    for (const [n, [status, glyph, line, qs, words, count, share]] of Object.entries(want)) {
      await expect(item(page, n), n).toHaveAttribute('data-status', status);
      await expect(item(page, n).locator('.course-item__mark'), n).toHaveText(glyph);
      await expect(meta(page, n), n).toHaveText(line);
      if (!qs) {
        await expect(quizLine(page, n), n).toBeHidden();
        await expect(item(page, n), n).toHaveAttribute('data-quizzes', 'none');
        continue;
      }
      await expect(quizLine(page, n), n).toBeVisible();
      await expect(quizMark(page, n), n).toHaveAttribute('data-state', qs);
      await expect(quizMark(page, n), n).toHaveText(words);
      await expect(item(page, n).locator('[data-field="lesson-quiz-count"]'), n).toHaveText(count);
      await expect(item(page, n).locator('[data-field="lesson-quiz-correct"]'), n).toHaveText(share);
    }
    // The states look different without colour too: the square is empty / half / full.
    const fills = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-field="lesson-quiz-mark"]')]
      .filter((m) => m.offsetParent).map((m) => [m.dataset.state, getComputedStyle(m.querySelector('.quiz-mark__icon')).backgroundImage + '|' + getComputedStyle(m.querySelector('.quiz-mark__icon')).backgroundColor])));
    expect(new Set(Object.values(fills)).size, JSON.stringify(fills)).toBe(3);
    // Unfolded: each quiz with its own counter, the share only when it is all answered.
    await toggleOf(page, '0001').click();
    await expect(qrow(page, '0001', 'Основен 1').locator('.quiz-list__line')).toHaveText('Въпроси 3 от 3 · минат · 2 от 3 верни (67 %)');
    await expect(qrow(page, '0001', 'Преговор 1').locator('.quiz-list__line')).toHaveText('Въпроси 0 от 2 · не е започнат');
    await answer(page, `${C}/quiz:0001-2`, 1);
    await openCourse(page);
    await expect(qrow(page, '0001', 'Преговор 1').locator('.quiz-list__line')).toHaveText('Въпроси 1 от 2 · започнат');
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 4 от 5');
    await answer(page, `${C}/quiz:0001-2`, 2);
    await openCourse(page);
    await expect(quizLine(page, '0001')).toHaveText('Тестове: минати Въпроси 5 от 5 · 80 % верни');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    // "Завършени", "Започни" and the card go by the material: 0001 only.
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 4 урока');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Започни: урок 0002 — Втори урок');
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${C}"] [data-field="course-progress"]`)).toHaveText('Завършени: 1 от 4');
  });

  test('T059-S2 the material goes on without the quizzes: open → ◐, mark → ● and counted, with no quiz answered; "Продължи" is the lesson; the row has no "отворен …"', async ({ page }) => {
    await importCourse(page, C, base());
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await page.goto(`./#/c/${C}`);
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'started');
    await expect(meta(page, '0002')).toHaveText('Статус: Започнат');
    await expect(item(page, '0002')).not.toContainText('отворен');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Продължи: урок 0002 — Втори урок');
    await item(page, '0002').locator('a.lesson-link').click();
    const done = page.locator('[data-action="complete"]');
    await expect(done).toHaveAttribute('aria-pressed', 'false', { timeout: 20000 });
    await done.click();
    await expect(done).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await expect(item(page, '0002').locator('.course-item__mark')).toHaveText('●');
    await expect(quizMark(page, '0002')).toHaveText('Тестове: не са започнати');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 4 урока');
    await expect(course(page).locator('[data-section="lessons"]')).not.toContainText('отворен');
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${C}"] [data-field="course-progress"]`)).toHaveText('Завършени: 1 от 4 · последно: урок 0002');
  });

  test('T059-S3 the quiz mark is no tab stop and not hidden from a screen reader; folded rows still show it; the share is never shown after 1–2 answers', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0002-1`, 2);
    await openCourse(page);
    await expect(toggleOf(page, '0002')).toHaveAttribute('aria-expanded', 'false');
    await expect(quizMark(page, '0002')).toBeVisible();
    await expect(quizMark(page, '0002')).not.toHaveAttribute('aria-hidden', 'true');
    await expect(quizMark(page, '0002')).toHaveText('Тестове: започнати');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: започнати Въпроси 2 от 4');
    await expect(quizLine(page, '0002')).not.toContainText('%');
    expect(await quizMark(page, '0002').evaluate((e) => e.tabIndex)).toBe(-1);
    await item(page, '0002').locator('a.lesson-link').focus();
    await page.keyboard.press('Tab');
    await expect(toggleOf(page, '0002')).toBeFocused();
    await toggleOf(page, '0002').click();
    await expect(qrow(page, '0002', 'Основен 2').locator('[data-field="quiz-correct"]')).toHaveText('');
    await expect(qrow(page, '0002', 'Основен 2').locator('.quiz-list__line')).not.toContainText('верн');
  });
});

// ---------------------------------------------------------------------------
// T059-H "Последни дейности" = history of places
// ---------------------------------------------------------------------------
test.describe('T059-H the history of places', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T059-H1 lesson, reference and quiz visits: newest first, each place once (a revisit moves it to the top), stored in IndexedDB "history"', async ({ page }) => {
    await importCourse(page, C, base());
    await openCourse(page);
    await expect(course(page).locator('[data-field="activity-empty"]')).toHaveText('Още няма дейности. Отвори урок, за да започнеш.');
    await page.goto(`./#/c/${C}/read/0001`);
    await waitReady(page);
    await page.goto(`./#/c/${C}/read/R01`);
    await waitReady(page);
    await page.goto(`./#/c/${C}/quiz/0002-1-osnoven`);
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 1 от 4 · отговорени 0');
    await openCourse(page);
    await expect(history(page)).toHaveText([
      /^Тест „Основен 2“ · въпрос 1 от 4 — днес \d\d:\d\d$/,
      /^Справочник R01 „Справка“ — днес \d\d:\d\d$/,
      /^Урок 0001 „Първи урок“ — днес \d\d:\d\d$/,
    ]);
    // The same lesson again: it moves to the top, no second row, no two equal rows in a row.
    await page.goto(`./#/c/${C}/read/0001`);
    await waitReady(page);
    await page.goto(`./#/c/${C}/read/0001`);
    await page.reload();
    await waitReady(page);
    await openCourse(page);
    const texts = await history(page).allTextContents();
    expect(texts.map((t) => t.replace(/ — .*$/, ''))).toEqual(['Урок 0001 „Първи урок“', 'Тест „Основен 2“ · въпрос 1 от 4', 'Справочник R01 „Справка“']);
    expect((await historyRecords(page)).map(([id, kind]) => [id, kind])).toEqual([['lesson:0001', 'lesson'], ['quiz:0002-1', 'quiz'], ['reference:R01', 'reference']]);
    // An ordered list (newest first), each row a link.
    await expect(course(page).locator('ol[data-list="activity"]')).toHaveCount(1);
    await expect(history(page).locator('a.activity__link')).toHaveCount(3);
    for (const a of await history(page).locator('a').all()) expect((await a.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });

  test('T059-H2 a tap goes back to the same place: the reading position of a lesson and a reference, a fragment, the question of a quiz', async ({ page }) => {
    await importCourse(page, C, base());
    // A lesson read down to ~3000 px.
    await page.goto(`./#/c/${C}/read/0001`);
    await waitReady(page);
    await page.waitForTimeout(1600); // the reader restores the (empty) position first
    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(async () => (await historyRecords(page)).find(([id]) => id === 'lesson:0001')?.[2] ?? 0, { timeout: 5000 }).toBeGreaterThan(2500);
    const y1 = (await historyRecords(page)).find(([id]) => id === 'lesson:0001')[2];
    // The reference opened at a fragment: the place is the fragment (or, once the
    // reader has recorded the scroll there, the same position in pixels).
    await page.goto(`./#/c/${C}/read/R01?at=sredata`);
    await waitReady(page);
    await page.waitForTimeout(800);
    const ref = (await historyRecords(page)).find(([id]) => id === 'reference:R01');
    expect(ref[3] === 'sredata' || ref[2] > 3500, JSON.stringify(ref)).toBe(true);
    const refHref = ref[3] ? `#/c/${C}/read/R01?at=sredata` : `#/c/${C}/read/R01?y=${ref[2]}`;
    // The quiz on its 3rd question.
    await page.goto(`./#/c/${C}/quiz/0002-1-osnoven`);
    await page.getByRole('button', { name: 'Напред' }).click();
    await page.getByRole('button', { name: 'Напред' }).click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 3 от 4 · отговорени 0');
    await openCourse(page);
    expect(await historyRecords(page)).toEqual([
      ['quiz:0002-1', 'quiz', null, null, 2],
      ['reference:R01', 'reference', ...ref.slice(2)],
      ['lesson:0001', 'lesson', y1, null, null],
    ]);
    const links = await history(page).locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(links).toEqual([`#/c/${C}/quiz/0002-1-osnoven?q=3`, refHref, `#/c/${C}/read/0001?y=${y1}`]);
    // A place opened at a fragment and never scrolled keeps the fragment (unit, in the store).
    expect(await db(page, async (db, C) => {
      await db.visitPlace({ courseId: C, kind: 'lesson', id: `${C}/lesson:0004`, scrollY: 0, anchor: 'x' });
      const r1 = (await db.listHistory(C))[0];
      await db.movePlace(`${C}/lesson:0004`, { scrollY: 321 });
      const r2 = (await db.listHistory(C))[0];
      await db.purge(db.STORES.history, `${C}/lesson:0004`);
      return [r1.anchor, r1.scrollY, r2.anchor, r2.scrollY, r2.visitedAt === r1.visitedAt];
    }, C)).toEqual(['x', 0, null, 321, true]);
    // The lesson: back at its position.
    await history(page).nth(2).locator('a').click();
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(y1 - 150);
    expect(Math.abs(await lessonScroll(page) - y1)).toBeLessThan(150);
    // The visit moved the lesson to the top; the quiz opens on its 3rd question.
    await page.goto(`./#/c/${C}`);
    await openCourse(page);
    await expect(history(page).first()).toContainText('Урок 0001');
    await history(page).filter({ hasText: 'Основен 2' }).locator('a').click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 3 от 4 · отговорени 0');
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Основен 2: въпрос 3?');
    // The reference: at its fragment / position.
    await page.goto(`./#/c/${C}`);
    await openCourse(page);
    await history(page).filter({ hasText: 'Справка' }).locator('a').click();
    expect(new URL(page.url()).hash).toBe(refHref);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(3500);
  });

  test('T059-H3 (T058-D1) right after "Нулирай" the history is read again: no result in it, the same as a freshly opened screen; a quiz taken out of the course is left out', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0002-1`, 4);
    await page.goto(`./#/c/${C}/quiz/0002-1-osnoven`);
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 4 от 4 · отговорени 4');
    await page.goto(`./#/c/${C}/read/0004`);
    await waitReady(page);
    await openCourse(page);
    await expect(history(page)).toHaveText([/^Урок 0004 „Четвърти“/, /^Тест „Основен 2“ · въпрос 4 от 4/]);
    await toggleOf(page, '0002').click();
    await qrow(page, '0002', 'Основен 2').locator('[data-field="quiz-reset"]').click();
    await qrow(page, '0002', 'Основен 2').locator('[data-field="confirm-yes"]').click();
    await expect(qrow(page, '0002', 'Основен 2').locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    const here = await course(page).locator('[data-section="activity"]').innerText();
    expect(here).not.toMatch(/резултат|верни/);
    const fresh = await page.context().newPage();
    await fresh.goto(`./#/c/${C}`);
    await expect(fresh.locator('[data-list="activity"] > li')).toHaveCount(2, { timeout: 15000 });
    expect(await fresh.locator('[data-screen="course"] [data-section="activity"]').innerText()).toBe(here);
    await fresh.close();
    // A quiz that is no longer in the database (soft-deleted): its place is no longer listed.
    await db(page, (db, id) => db.remove(db.STORES.quizzes, id), `${C}/quiz:0002-1`);
    await openCourse(page);
    await expect(history(page)).toHaveText([/^Урок 0004 „Четвърти“/]);
  });

  test('T059-H4 at most 10 shown, 50 kept per course (the oldest go), courses apart; HTML in a title is text', async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><b>удебелено</b>';
    const files = { 'INDEX.md': indexMd('LRN-T59H', Array.from({ length: 12 }, (_, i) => [pad4(i + 1), `Урок ${i + 1}`])) };
    // A lesson title comes from the HTML <title> (as text): the escaped tags are its literal text.
    const esc = evil.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    for (let i = 1; i <= 12; i++) files[`lessons/${pad4(i)}-u.html`] = lessonHtml(i === 12 ? `Урок ${esc}` : `Урок ${i}`);
    files['quizzes/0012-1-x.json'] = quiz('0012', `Тест ${evil}`, 3);
    await importCourse(page, 'LRN-T59H', files);
    await importCourse(page, C, base());
    const r = await db(page, async (db) => {
      const t0 = Date.parse('2026-11-19T08:00:00.000Z');
      // 60 visits of 12 lessons + 55 of made-up places in another course.
      for (let k = 0; k < 60; k++) {
        const n = String((k % 12) + 1).padStart(4, '0');
        await db.visitPlace({ courseId: 'LRN-T59H', kind: 'lesson', id: `LRN-T59H/lesson:${n}`, scrollY: k, at: new Date(t0 + k * 60000).toISOString() });
      }
      await db.visitPlace({ courseId: 'LRN-T59H', kind: 'quiz', id: 'LRN-T59H/quiz:0012-1', question: 1, at: new Date(t0 + 61 * 60000).toISOString() });
      for (let k = 0; k < 55; k++) {
        await db.visitPlace({ courseId: 'LRN-T59', kind: 'lesson', id: `LRN-T59/lesson:${String(1000 + k)}`, scrollY: 0, at: new Date(t0 + k * 60000).toISOString() });
      }
      const h = await db.listHistory('LRN-T59H');
      const o = await db.listHistory('LRN-T59');
      return { h: h.length, top: h[0].id, last: h[h.length - 1].id, o: o.length, oNewest: o[0].id, oOldest: o[o.length - 1].id, backup: db.BACKUP_STORES.includes('history'), priv: db.PRIVATE_STORES };
    });
    // One record per place: 12 lessons + 1 quiz in the first course.
    expect(r.h).toBe(13);
    expect(r.top).toBe('LRN-T59H/quiz:0012-1');
    expect(r.o).toBe(50);
    expect(r.oNewest).toBe('LRN-T59/lesson:1054');
    expect(r.oOldest).toBe('LRN-T59/lesson:1005'); // 1000…1004 were the oldest: gone
    expect(r.backup).toBe(true);
    expect(r.priv).toEqual(['secrets']);
    await openCourse(page, 'LRN-T59H');
    await expect(history(page)).toHaveCount(10);
    await expect(history(page).first()).toHaveText(new RegExp(`^Тест „Тест ${evil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}“ · въпрос 2 от 3 — `));
    await expect(history(page).nth(1)).toContainText(`Урок 0012 „Урок ${evil}“`);
    await expect(course(page).locator('[data-section="activity"] img, [data-section="activity"] b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // The other course shows only its own places (the made-up ids are no lessons of it: left out).
    await openCourse(page, C);
    await expect(course(page).locator('[data-field="activity-empty"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// T059-M migration v5 → v6
// ---------------------------------------------------------------------------
/** Every record of every store (raw IndexedDB, no version: never upgrades). */
const dump = (page) => page.evaluate(() => new Promise((ok, fail) => {
  const r = indexedDB.open('lrn-app');
  r.onerror = () => fail(r.error);
  r.onsuccess = () => {
    const idb = r.result;
    const out = { version: idb.version, stores: {} };
    const names = [...idb.objectStoreNames];
    const tx = idb.transaction(names);
    for (const s of names) tx.objectStore(s).getAll().onsuccess = (e) => { out.stores[s] = e.target.result.map((x) => ({ ...x, blob: x.blob ? `blob:${x.blob.size}` : undefined })); };
    tx.oncomplete = () => { idb.close(); ok(out); };
  };
}));
/** A v5 database like 0.10.0 leaves it, made on a page that does not start the app. */
async function v5Profile(page) {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(async () => {
    const db = await import('./src/db.js');
    const v5 = await db.openDb({ name: 'lrn-app', version: 5 });
    const t = (m) => `2026-11-19T${m}:00.000Z`;
    const rec = (x) => ({ createdAt: t('08:00'), updatedAt: t('08:00'), deleted: false, ...x });
    await v5.put('courses', rec({ id: 'LRN-M5', title: 'М5', meta: {} }));
    await v5.put('courses', rec({ id: 'LRN-M5B', title: 'М5Б', meta: {} }));
    const lesson = (c, n, progress, kind = 'lesson') => rec({ id: `${c}/${kind}:${n}`, courseId: c, kind, number: n, path: `${kind === 'lesson' ? 'lessons' : 'reference'}/${n}-a.html`, title: `Т ${n}`, order: 1, progress });
    await v5.put('lessons', lesson('LRN-M5', '0001', { status: 'done', lastOpenedAt: t('09:00'), completedAt: t('09:10'), scrollY: 1234 }));
    await v5.put('lessons', lesson('LRN-M5', '0002', { status: 'started', lastOpenedAt: t('10:00'), scrollY: 0 }));
    await v5.put('lessons', lesson('LRN-M5', '0003', { status: 'new', lastOpenedAt: null, scrollY: 0 }));
    await v5.put('lessons', lesson('LRN-M5', 'R01', { status: 'started', lastOpenedAt: t('09:30'), scrollY: 77 }, 'reference'));
    await v5.put('lessons', { ...lesson('LRN-M5', '0004', { status: 'started', lastOpenedAt: t('11:00'), scrollY: 5 }), deleted: true });
    await v5.put('lessons', lesson('LRN-M5B', '0001', { status: 'started', lastOpenedAt: 'не е дата', scrollY: 9 }));
    const q = (c, id, n) => rec({ id: `${c}/quiz:${id}`, courseId: c, path: `quizzes/${id}.json`, slug: id, lesson: id.slice(0, 4), title: `Тест ${id}`, order: 1, questions: Array.from({ length: n }, (_, i) => ({ q: `в${i}?`, options: ['Да', 'Не'], answer: 0 })) });
    await v5.put('quizzes', q('LRN-M5', '0001-1', 3));
    await v5.put('quizzes', q('LRN-M5', '0002-1', 2));
    await v5.put('quizAnswers', rec({ id: 'LRN-M5/quiz:0001-1', courseId: 'LRN-M5', choices: { k1: 'Да', k2: 'Не' }, cursor: 1, updatedAt: t('09:45') }));
    await v5.put('quizAnswers', rec({ id: 'LRN-M5/quiz:0002-1', courseId: 'LRN-M5', choices: {}, cursor: 0, updatedAt: t('12:00') })); // reset: no place
    await v5.put('quizAnswers', rec({ id: 'LRN-M5/quiz:9999-1', courseId: 'LRN-M5', choices: { k: 'Да' }, cursor: 0, updatedAt: t('12:30') })); // no such quiz
    await v5.put('annotations', rec({ id: 'A1', courseId: 'LRN-M5', target: { type: 'lesson', id: 'LRN-M5/lesson:0001' }, selector: { quote: { exact: 'x', prefix: '', suffix: '' }, position: { start: 0, end: 1 } }, color: 'pink', anchorState: 'ok' }));
    await v5.put('settings', rec({ id: 'settings', theme: 'dark' }));
    await v5.put('secrets', { id: 'apiKey', value: 'sk-ant-FAKE-t059', updatedAt: t('08:00') });
    db.closeDb();
  });
  return dump(page);
}

test.describe('T059-M migration v5 → v6', () => {
  test('T059-M1 a 0.10.0 database: every old record is unchanged; the history starts from the opened lessons/references and the answered quizzes, newest first, with their positions', async ({ page }) => {
    const before = await v5Profile(page);
    expect(before.version).toBe(5);
    expect(before.stores.history).toBeUndefined();
    await page.goto('./');
    await expect.poll(async () => (await dump(page)).version, { timeout: 15000 }).toBe(6);
    await expect(page.locator('#db-error')).toBeHidden();
    const after = await dump(page);
    for (const [store, records] of Object.entries(before.stores)) expect(after.stores[store], store).toEqual(records);
    expect(after.stores.history.map((r) => [r.id, r.courseId, r.kind, r.visitedAt, r.scrollY, r.anchor, r.question, r.deleted]).sort((a, b) => b[3].localeCompare(a[3]))).toEqual([
      ['LRN-M5/lesson:0002', 'LRN-M5', 'lesson', '2026-11-19T10:00:00.000Z', 0, null, null, false],
      ['LRN-M5/quiz:0001-1', 'LRN-M5', 'quiz', '2026-11-19T09:45:00.000Z', null, null, 1, false],
      ['LRN-M5/reference:R01', 'LRN-M5', 'reference', '2026-11-19T09:30:00.000Z', 77, null, null, false],
      ['LRN-M5/lesson:0001', 'LRN-M5', 'lesson', '2026-11-19T09:00:00.000Z', 1234, null, null, false],
    ]);
    await page.goto('./#/c/LRN-M5');
    await expect(page.locator('[data-list="activity"] > li a')).toHaveText(['Урок 0002 „Т 0002“', 'Тест „Тест 0001-1“ · въпрос 2 от 3', 'Справочник R01 „Т R01“', 'Урок 0001 „Т 0001“'], { timeout: 15000 });
    expect(await page.locator('[data-list="activity"] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([
      '#/c/LRN-M5/read/0002?y=0', '#/c/LRN-M5/quiz/0001-1?q=2', '#/c/LRN-M5/read/R01?y=77', '#/c/LRN-M5/read/0001?y=1234']);
    // Nothing else changed: the material status of 0001 (marked) is ● again.
    await expect(page.locator('.course-item[data-item="LRN-M5/lesson:0001"]')).toHaveAttribute('data-status', 'done');
  });

  test('T059-M2 a failed v6 migration: the screen says so, the v5 database stays as it was', async ({ page }) => {
    allowed.push(/IndexedDB/, /Failed to load resource/);
    const before = await v5Profile(page);
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.mode === 'versionchange' && this.name === 'history') throw new DOMException('simulated failure', 'UnknownError');
        return put.apply(this, args);
      };
    });
    await page.goto('./');
    await expect(page.locator('#db-error')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#db-error')).toContainText('Базата не може да се обнови; данните са запазени');
    await expect(page.locator('#db-error')).toHaveAttribute('role', 'alert');
    const after = await dump(page);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// T059-F T058-D3, T058-D4
// ---------------------------------------------------------------------------
test.describe('T059-F the defects of T-058', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T059-F1 (T058-D3) the keyboard: "Нулирай" → "Отказ" back on "Нулирай"; "Изтрий" → the focus is on "Отвори" of the same quiz, visible; Tab goes on to "Нулирай" of the next quiz', async ({ page }) => {
    await importCourse(page, C, base());
    await answer(page, `${C}/quiz:0001-1`, 1);
    await answer(page, `${C}/quiz:0001-2`, 1);
    await openCourse(page);
    await toggleOf(page, '0001').click();
    const row = qrow(page, '0001', 'Основен 1');
    await row.locator('[data-field="quiz-reset"]').focus();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="quiz-reset"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(row.locator('[data-field="confirm-yes"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    const open = row.getByRole('link', { name: 'Отвори теста „Основен 1“' });
    await expect(open).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Tab'); // "Нулирай" of this quiz is disabled: skipped
    await expect(qrow(page, '0001', 'Преговор 1').getByRole('link', { name: 'Отвори теста „Преговор 1“' })).toBeFocused();
    // A click on "Изтрий" (no keyboard) works the same way.
    await qrow(page, '0001', 'Преговор 1').locator('[data-field="quiz-reset"]').click();
    await qrow(page, '0001', 'Преговор 1').locator('[data-field="confirm-yes"]').click();
    await expect(qrow(page, '0001', 'Преговор 1').getByRole('link', { name: 'Отвори теста „Преговор 1“' })).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  test('T059-F2 (T058-D4) 360×800 at 160 %: the course screen with every lesson unfolded and a long quiz title has no horizontal scroll; nothing leaves the screen', async ({ page }) => {
    await importCourse(page, C, base({ 'quizzes/0002-2-dalag.json': quiz('0002', 'Преговор с доста дълго заглавие за проверка на пренасянето', 2) }));
    await answer(page, `${C}/quiz:0001-1`, 3, 1);
    for (const w of [320, 360, 412]) {
      await page.setViewportSize({ width: w, height: 800 });
      await openCourse(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = '160%'; });
      const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
      for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
      const r = await page.evaluate(() => {
        const cw = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > cw + 0.5)
          .map((e) => `${e.className}:${e.getBoundingClientRect().right.toFixed(1)}`);
        return { sw: document.documentElement.scrollWidth, cw, wide: [...new Set(wide)] };
      });
      expect(r.wide, `${w} px`).toEqual([]);
      expect(r.sw, `${w} px`).toBeLessThanOrEqual(r.cw);
      for (const el of await course(page).locator('.quiz-list__item a, .quiz-list__item button').all()) {
        const b = await el.boundingBox();
        expect(b.height, `${w} px`).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T059-V layout and contrast
// ---------------------------------------------------------------------------
test.describe('T059-V layout', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T059-V1 five sizes × 100/160 % × light/dark: no horizontal scroll; the quiz mark words ≥ 4.5:1, its square ≥ 3:1; the history fits its column', async ({ page }) => {
    test.setTimeout(180_000);
    await importCourse(page, C, base());
    await mark(page, `${C}/lesson:0001`);
    await answer(page, `${C}/quiz:0001-1`, 3, 1);
    await answer(page, `${C}/quiz:0002-1`, 4);
    await db(page, async (db) => {
      await db.visitPlace({ courseId: 'LRN-T59', kind: 'quiz', id: 'LRN-T59/quiz:0002-1', question: 3 });
      await db.visitPlace({ courseId: 'LRN-T59', kind: 'reference', id: 'LRN-T59/reference:R01', scrollY: 10 });
      await db.visitPlace({ courseId: 'LRN-T59', kind: 'lesson', id: 'LRN-T59/lesson:0001', scrollY: 400 });
    });
    for (const theme of ['light', 'dark']) {
      await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
      for (const [w, hgt] of [[1920, 1200], [1280, 800], [1200, 1920], [800, 1280], [360, 800]]) {
        for (const scale of ['100%', '160%']) {
          const tag = `${theme} ${w}×${hgt} ${scale}`;
          await page.setViewportSize({ width: w, height: hgt });
          await openCourse(page);
          await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
          const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
          for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
          const r = await page.evaluate(() => {
            const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
            const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
            const bg = getComputedStyle(document.body).backgroundColor;
            const marks = [...document.querySelectorAll('[data-field="lesson-quiz-mark"]')].filter((m) => m.offsetParent).map((m) => ({
              state: m.dataset.state,
              text: ratio(getComputedStyle(m).color, bg),
              square: ratio(getComputedStyle(m.querySelector('.quiz-mark__icon')).borderTopColor, bg),
              count: ratio(getComputedStyle(m.closest('.course-item__quizline')).color, bg),
            }));
            const side = document.querySelector('.course__side').getBoundingClientRect();
            const outSide = [...document.querySelectorAll('[data-list="activity"] *')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > side.right + 1 || b.left < side.left - 1; }).length;
            return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, marks, outSide };
          });
          expect(r.sw, tag).toBeLessThanOrEqual(r.cw);
          expect(r.outSide, tag).toBe(0);
          expect(r.marks.map((m) => m.state).sort(), tag).toEqual(['new', 'passed', 'started']);
          for (const m of r.marks) {
            expect(m.text, `${tag} ${m.state} words`).toBeGreaterThanOrEqual(4.5);
            expect(m.count, `${tag} ${m.state} counter`).toBeGreaterThanOrEqual(4.5);
            expect(m.square, `${tag} ${m.state} square`).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
  });
});
