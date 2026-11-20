// T-060 (tester, 0.11.0): attack on T-059 (D-041 — the material and the
// quizzes are counted apart; "Последни дейности" is a history of places) and
// the fixes T058-D1/D3/D4.
// - T060-S*: ○ ◐ ● by the material only (open / "Маркирай като завършен"
//   through the reader), the quiz mark through the real quiz screen (new →
//   started → passed), reset, re-import with a new question (passed →
//   started, the share goes), a quiz without questions, a lesson whose only
//   quiz has no questions, a retired lesson, "Други тестове", the accessible
//   name, forced colours; "Въпроси x от y" and the share (rounding 1/3, 2/3,
//   1/6, 0 right) against the quiz screen;
// - T060-H*: the history: 60 real visits (50 kept, 10 shown, exactly which),
//   a revisit, a tap back to the place (scroll, fragment, question; also after
//   "Опитай пак грешните"), quick switching, two tabs, a reset quiz, a
//   deleted / retired lesson, a deleted course, several courses, XSS in
//   titles and fragments, hostile ?y= / ?at= / ?q= / ids (never leaves the
//   course, never breaks), BACKUP_STORES;
// - T060-M*: migration to v6 from REAL old builds (git archive): 0.10.0 and
//   0.9.0 (v5, the tablet), 0.8.1 (v4) and 0.6.0 (v2) — every old record is
//   unchanged, the history is filled; a corrupted progress; > 50 places; a
//   0.10.0 tab left open; a failed upgrade (message, v5 kept); back to 0.10.0;
// - T060-F*: T058-D3 (focus after "Изтрий", also in "Други тестове"), T058-D4
//   (320/360 px at 160 %);
// - T060-V*: 1920×1200, 1280×800, 1200×1920, 800×1280, 360×800 × light/dark
//   (synthetic; the real LRN-CRA only with T060_REAL_ZIP=<path outside the repo>).
// Synthetic data only, fake keys, no network (D-026).
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const NOW_VERSION = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(REPO, 'src/config.js'), 'utf8'))[1];
const REAL_ZIP = process.env.T060_REAL_ZIP;

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
  // No real network: api.anthropic.com and everything else outside is never reached.
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
  expect(external).toEqual([]);
});
const onlyLandscape = (info, why) => test.skip(info.project.name !== 'tablet-landscape', `${why}: once is enough (landscape)`);

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
const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
async function importBytes(page, name, bytes) {
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try {
      const s = await m.importCourse([new File([new Uint8Array(bytes)], name)]);
      return { text: m.describeSummary(s), notes: s.notes };
    } catch (err) {
      return { error: m.errorMessage(err) };
    }
  }, { name, bytes });
}
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(toBytes(files), { root: id }));
  return importBytes(page, f.name, [...f.buffer]);
}
const lessonHtml = (title, body = '<p>Измислен текст.</p>') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const LONG_BODY = '<p>Начало.</p><div style="height:4000px"></div><h2 id="sredata">Средата</h2><div style="height:3000px"></div><h2 id="a&lt;b">Със знак</h2><div style="height:3000px"></div><p id="kraj">Край.</p>';
/** A quiz of `n` questions; the right answer is "Да" (index 0). */
const quiz = (lesson, title, n = 2, prefix = title) => JSON.stringify({
  ...(lesson === undefined ? {} : { lesson }), title,
  questions: Array.from({ length: n }, (_, i) => ({ q: `${prefix}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: 0, why: 'Защото.' })),
});
const indexMd = (id, rows, extra = '') => `# ${id}: индекс\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${rows.map(([n, t]) => `| ${n} | ${t} |`).join('\n')}\n${extra}`;
const pad4 = (n) => String(n).padStart(4, '0');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const C = 'LRN-T60';
const base = (extra = {}) => ({
  'INDEX.md': indexMd(C, [['0001', 'Първи'], ['0002', 'Втори'], ['0003', 'Трети без тестове'], ['0004', 'Четвърти']],
    '\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n'),
  'lessons/0001-parvi.html': lessonHtml('Първи', LONG_BODY),
  'lessons/0002-vtori.html': lessonHtml('Втори'),
  'lessons/0003-treti.html': lessonHtml('Трети без тестове'),
  'lessons/0004-chetvarti.html': lessonHtml('Четвърти', LONG_BODY),
  'reference/R01-spravka.html': lessonHtml('Справка', LONG_BODY),
  'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен 1', 3),
  'quizzes/0001-2-pregovor.json': quiz('0001', 'Преговор 1', 6),
  'quizzes/0002-1-osnoven.json': quiz('0002', 'Основен 2', 3),
  'quizzes/0004-1-osnoven.json': quiz('0004', 'Основен 4', 8),
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
const qrow = (scope, title) => scope.locator('.quiz-list__item', { has: scope.page().locator(`.quiz-list__title:text-is("${title}")`) });
const history = (page) => course(page).locator('[data-list="activity"] > li');
const hrefs = (page) => history(page).locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const records = (page, id = C) => db(page, async (db, id) => (await db.listHistory(id)).map((r) => [r.id.slice(id.length + 1), r.kind, r.scrollY, r.anchor, r.question]), id);
const lessonScroll = (page) => page.evaluate(() => {
  const frame = document.querySelector('iframe.lesson-frame');
  const bar = document.querySelector('.app-bar').getBoundingClientRect().height;
  return Math.round(window.scrollY - (frame.getBoundingClientRect().top + window.scrollY - bar));
});
/** Answer the current question of the quiz screen ("Да" = right) and go on. */
async function answerHere(page, right, next = true) {
  await page.locator(`.quiz__option[data-option="${right ? 0 : 1}"]`).click();
  await expect(page.locator('.quiz__verdict')).toHaveText(right ? 'Вярно' : 'Грешно');
  if (next) {
    const fwd = page.getByRole('button', { name: 'Напред' });
    if (await fwd.count()) await fwd.click();
  }
}
const quizCount = (page) => page.locator('.quiz__count');

// ---------------------------------------------------------------------------
// T060-S: the material, the quiz mark, the counter and the share
// ---------------------------------------------------------------------------
test.describe('T060-S material and quizzes apart (D-041)', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T060-S1 through the real screens: reader open → ◐, "Маркирай" → ●, answering through the quiz screen never touches ○/◐/●; the mark goes new → started → passed; counters equal the quiz screen at every step', async ({ page }) => {
    await importCourse(page, C, base());
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'new');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: не са започнати Въпроси 0 от 3');
    // The quiz first, the lesson never opened: still ○.
    await page.goto(`./#/c/${C}/quiz/0002-1-osnoven`);
    await answerHere(page, true);
    await expect(quizCount(page)).toHaveText('Въпрос 2 от 3 · отговорени 1');
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'new');
    await expect(item(page, '0002').locator('.course-item__mark')).toHaveText('○');
    await expect(quizMark(page, '0002')).toHaveAttribute('data-state', 'started');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: започнати Въпроси 1 от 3');
    await toggleOf(page, '0002').click();
    await expect(qrow(item(page, '0002'), 'Основен 2').locator('.quiz-list__line')).toHaveText('Въпроси 1 от 3 · започнат');
    // The rest through the screen: 1 wrong → 2 of 3 = 67 %.
    await qrow(item(page, '0002'), 'Основен 2').getByRole('link', { name: /Отвори/ }).click();
    await expect(quizCount(page)).toHaveText('Въпрос 2 от 3 · отговорени 1');
    await answerHere(page, false);
    await answerHere(page, true, false);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 2 от 3 верни');
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'new');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: минати Въпроси 3 от 3 · 67 % верни');
    await expect(qrow(item(page, '0002'), 'Основен 2').locator('.quiz-list__line')).toHaveText('Въпроси 3 от 3 · минат · 2 от 3 верни (67 %)');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 4 урока');
    // The material: open in the reader → ◐, mark → ●; the quizzes stay as they are.
    await item(page, '0002').locator('a.lesson-link').click();
    const done = page.locator('[data-action="complete"]');
    await expect(done).toHaveAttribute('aria-pressed', 'false', { timeout: 20000 });
    await page.goBack();
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'started');
    await expect(meta(page, '0002')).toHaveText('Статус: Започнат');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: минати Въпроси 3 от 3 · 67 % верни');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Продължи: урок 0002 — Втори');
    await page.goto(`./#/c/${C}/read/0002`);
    await expect(done).toHaveAttribute('aria-pressed', 'false', { timeout: 20000 });
    await done.click();
    await expect(done).toHaveAttribute('aria-pressed', 'true');
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await expect(meta(page, '0002')).toHaveText('Статус: Завършен');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 4 урока');
    // Unmarking in the reader: ● → ◐, the quizzes are still "минати".
    await page.goto(`./#/c/${C}/read/0002`);
    await expect(done).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 });
    await done.click();
    await expect(done).toHaveAttribute('aria-pressed', 'false');
    await openCourse(page);
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'started');
    await expect(quizMark(page, '0002')).toHaveAttribute('data-state', 'passed');
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${C}"] [data-field="course-progress"]`)).toHaveText('Завършени: 0 от 4 · последно: урок 0002');
  });

  test('T060-S2 the share: rounding (1/3 → 33, 2/3 → 67, 1/6 → 17, 5/6 → 83, 0 right → 0 %), per quiz and for the lesson (sum of the questions, not the mean of the quizzes); never before every question is answered', async ({ page }) => {
    await importCourse(page, C, base());
    const answerDb = (quizId, picks) => db(page, async (db, { quizId, picks }) => {
      const q = await db.getQuiz(quizId);
      const keys = db.questionKeys(q.questions);
      for (const [i, right] of picks.entries()) {
        if (right == null) continue;
        await db.saveQuizChoice(q.id, { courseId: q.courseId, qKey: keys[i], choice: q.questions[i].options[right ? 0 : 1], cursor: i });
      }
    }, { quizId, picks });
    // 0001-1: 1 of 3 right; 0001-2: 5 of 6 right, one left out first.
    await answerDb(`${C}/quiz:0001-1`, [true, false, false]);
    await answerDb(`${C}/quiz:0001-2`, [true, true, true, true, false, null]);
    // 0002-1: 0 of 3; 0004-1: 7 of 8 but one missing.
    await answerDb(`${C}/quiz:0002-1`, [false, false, false]);
    await answerDb(`${C}/quiz:0004-1`, [true, true, true, true, true, true, true, null]);
    await openCourse(page);
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 8 от 9');
    await expect(item(page, '0001').locator('[data-field="lesson-quiz-correct"]')).toHaveText('');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: минати Въпроси 3 от 3 · 0 % верни');
    await expect(quizLine(page, '0004')).toHaveText('Тестове: започнати Въпроси 7 от 8');
    await toggleOf(page, '0001').click();
    await expect(qrow(item(page, '0001'), 'Основен 1').locator('.quiz-list__line')).toHaveText('Въпроси 3 от 3 · минат · 1 от 3 верни (33 %)');
    await expect(qrow(item(page, '0001'), 'Преговор 1').locator('.quiz-list__line')).toHaveText('Въпроси 5 от 6 · започнат');
    await expect(qrow(item(page, '0001'), 'Преговор 1').locator('[data-field="quiz-correct"]')).toHaveText('');
    // The last one: 5 of 6 → 83 %; the lesson 6 of 9 → 67 % (the mean of 33 and 83 would be 58).
    await answerDb(`${C}/quiz:0001-2`, [null, null, null, null, null, true]);
    await openCourse(page);
    await expect(qrow(item(page, '0001'), 'Преговор 1').locator('.quiz-list__line')).toHaveText('Въпроси 6 от 6 · минат · 5 от 6 верни (83 %)');
    await expect(quizLine(page, '0001')).toHaveText('Тестове: минати Въпроси 9 от 9 · 67 % верни');
    // The quiz screen says the same numbers.
    await page.goto(`./#/c/${C}/quiz/0001-2-pregovor?q=6`);
    await expect(quizCount(page)).toHaveText('Въпрос 6 от 6 · отговорени 6');
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 5 от 6 верни');
    // 1/6 → 17 %: a quiz of 6 with one right.
    await answerDb(`${C}/quiz:0001-2`, [false, false, false, false, false, true]);
    await answerDb(`${C}/quiz:0001-2`, [true, false, false, false, false, false]);
    await openCourse(page);
    await expect(qrow(item(page, '0001'), 'Преговор 1').locator('[data-field="quiz-correct"]')).toHaveText('1 от 6 верни (17 %)');
    // 2 of 9 for the lesson → 22 %.
    await expect(quizLine(page, '0001')).toHaveText('Тестове: минати Въпроси 9 от 9 · 22 % верни');
    // The percent sign never wraps alone (non-breaking space).
    expect(await item(page, '0001').locator('[data-field="lesson-quiz-correct"]').textContent()).toBe('22\u00A0% верни');
  });

  test('T060-S3 "Нулирай": passed → new (one quiz) / passed → started (two quizzes); ● stays; the share goes; re-import with a NEW question: passed → started, the share goes, the old answers stay', async ({ page }) => {
    await importCourse(page, C, base());
    await db(page, (db, C) => db.setLessonProgress(`${C}/lesson:0001`, { status: 'done', completedAt: '2026-11-20T08:00:00.000Z', lastOpenedAt: '2026-11-20T08:00:00.000Z' }), C);
    await db(page, async (db, C) => {
      for (const id of ['0001-1', '0001-2', '0002-1']) {
        const q = await db.getQuiz(`${C}/quiz:${id}`);
        const keys = db.questionKeys(q.questions);
        for (let i = 0; i < q.questions.length; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: 'Да', cursor: i });
      }
    }, C);
    await openCourse(page);
    await expect(quizLine(page, '0001')).toHaveText('Тестове: минати Въпроси 9 от 9 · 100 % верни');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: минати Въпроси 3 от 3 · 100 % верни');
    // 0001: reset one of two → "започнати", ● stays.
    await toggleOf(page, '0001').click();
    await qrow(item(page, '0001'), 'Основен 1').locator('[data-field="quiz-reset"]').click();
    await qrow(item(page, '0001'), 'Основен 1').locator('[data-field="confirm-yes"]').click();
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 6 от 9');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 4 урока');
    // 0002: reset the only quiz → "не са започнати".
    await toggleOf(page, '0002').click();
    await qrow(item(page, '0002'), 'Основен 2').locator('[data-field="quiz-reset"]').click();
    await qrow(item(page, '0002'), 'Основен 2').locator('[data-field="confirm-yes"]').click();
    await expect(quizLine(page, '0002')).toHaveText('Тестове: не са започнати Въпроси 0 от 3');
    await expect(quizMark(page, '0002')).toHaveAttribute('data-state', 'new');
    // The same after a reload (what is stored, not only what is drawn).
    await openCourse(page);
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 6 от 9');
    await expect(quizLine(page, '0002')).toHaveText('Тестове: не са започнати Въпроси 0 от 3');
    // Re-import: 0001-2 gets a 7th question → "започнати", share gone; old 6 answers kept.
    await db(page, async (db, C) => {
      const q = await db.getQuiz(`${C}/quiz:0001-1`);
      const keys = db.questionKeys(q.questions);
      for (let i = 0; i < 3; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: 'Не', cursor: i });
    }, C);
    await openCourse(page);
    await expect(quizLine(page, '0001')).toHaveText('Тестове: минати Въпроси 9 от 9 · 67 % верни');
    const seven = JSON.parse(quiz('0001', 'Преговор 1', 7));
    const r = await importCourse(page, C, base({ 'quizzes/0001-2-pregovor.json': JSON.stringify(seven) }));
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    await openCourse(page);
    await expect(quizMark(page, '0001')).toHaveAttribute('data-state', 'started');
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 9 от 10');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(qrow(item(page, '0001'), 'Преговор 1').locator('.quiz-list__line')).toHaveText('Въпроси 6 от 7 · започнат');
    await page.goto(`./#/c/${C}/quiz/0001-2-pregovor`);
    await expect(quizCount(page)).toContainText('отговорени 6');
  });

  test('T060-S4 quizzes without questions: a lesson whose ONLY quiz has none has no mark; with a real one only the real one counts; a retired lesson keeps its mark; "Други тестове" rows have counter, word and share', async ({ page }) => {
    await importCourse(page, C, base({
      'quizzes/0099-1-sirak.json': quiz('0099', 'Сирак', 2),
      'quizzes/bez-urok.json': quiz(undefined, 'Без урок', 1),
    }));
    // Records with no questions cannot come from an import (refused); put directly.
    await db(page, async (db, C) => {
      const empty = (id, lesson) => db.put(db.STORES.quizzes, { id: `${C}/quiz:${id}`, courseId: C, path: `quizzes/${id}-prazen.json`, slug: `${id}-prazen`, lesson, title: `Празен ${id}`, questions: [], count: 0, order: 99, deleted: false });
      await empty('0003-1', '0003');
      await empty('0002-2', '0002');
      const q = await db.getQuiz(`${C}/quiz:0002-1`);
      const keys = db.questionKeys(q.questions);
      for (let i = 0; i < 3; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: 'Да', cursor: i });
      const o = (await db.listQuizzes(C)).find((x) => x.title === 'Сирак');
      const ok = db.questionKeys(o.questions);
      await db.saveQuizChoice(o.id, { courseId: C, qKey: ok[0], choice: 'Не', cursor: 0 });
      await db.saveQuizChoice(o.id, { courseId: C, qKey: ok[1], choice: 'Да', cursor: 1 });
    }, C);
    await openCourse(page);
    await expect(item(page, '0003')).toHaveAttribute('data-quizzes', 'none');
    await expect(quizLine(page, '0003')).toBeHidden();
    await expect(quizLine(page, '0002')).toHaveText('Тестове: минати Въпроси 3 от 3 · 100 % верни');
    await toggleOf(page, '0002').click();
    await expect(qrow(item(page, '0002'), 'Празен 0002-2').locator('[data-field="quiz-status"]')).toHaveText('без въпроси');
    await expect(qrow(item(page, '0002'), 'Празен 0002-2').locator('[data-field="quiz-reset"]')).toBeDisabled();
    const others = course(page).locator('[data-section="other-quizzes"]');
    await expect(qrow(others, 'Сирак').locator('.quiz-list__line')).toHaveText('Въпроси 2 от 2 · минат · 1 от 2 верни (50 %)');
    await expect(qrow(others, 'Без урок').locator('.quiz-list__line')).toHaveText('Въпроси 0 от 1 · не е започнат');
    // Retire 0002 (re-import with "## Оттеглени номера"): its mark is under it in "Вече не са в курса".
    const f = base({ 'quizzes/0099-1-sirak.json': quiz('0099', 'Сирак', 2), 'quizzes/bez-urok.json': quiz(undefined, 'Без урок', 1) });
    delete f['lessons/0002-vtori.html'];
    f['INDEX.md'] = indexMd(C, [['0001', 'Първи'], ['0003', 'Трети без тестове'], ['0004', 'Четвърти']], '\n## Оттеглени номера\n- 0002\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n');
    const r = await importCourse(page, C, f);
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    await openCourse(page);
    const retired = course(page).locator('[data-section="retired"]');
    await retired.locator('summary').click();
    const ret = retired.locator('.course-item', { has: page.locator('[data-lesson] .import__num:text-is("0002")') });
    await expect(ret.locator('[data-field="lesson-quiz-line"]')).toHaveText('Тестове: минати Въпроси 3 от 3 · 100 % верни');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 3 урока');
  });

  test('T060-S6 the card in "Курсове" and "Продължи" agree after the last opened lesson is retired: the card does not name a lesson that is no longer in the course', async ({ page }) => {
    await importCourse(page, C, base());
    await db(page, async (db, C) => {
      await db.setLessonProgress(`${C}/lesson:0002`, { status: 'started', lastOpenedAt: '2026-11-20T08:00:00.000Z' });
      await db.setLessonProgress(`${C}/lesson:0003`, { status: 'done', lastOpenedAt: '2026-11-20T09:00:00.000Z', completedAt: '2026-11-20T09:00:00.000Z' });
    }, C);
    const f = base();
    f['INDEX.md'] = indexMd(C, [['0001', 'Първи'], ['0002', 'Втори'], ['0004', 'Четвърти']], '\n## Оттеглени номера\n- 0003\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n');
    delete f['lessons/0003-treti.html'];
    await importCourse(page, C, f);
    await openCourse(page);
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Продължи: урок 0002 — Втори');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 3 урока');
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${C}"] [data-field="course-progress"]`)).toHaveText('Завършени: 0 от 3 · последно: урок 0002', { timeout: 5000 });
  });

  test('T060-S5 the mark is read as words (accessible name), is no button, is visible folded; with forced colours (high contrast) the words still tell the state', async ({ page }) => {
    await importCourse(page, C, base());
    await db(page, async (db, C) => {
      const q = await db.getQuiz(`${C}/quiz:0002-1`);
      const keys = db.questionKeys(q.questions);
      for (let i = 0; i < 3; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: 'Да', cursor: i });
      const q1 = await db.getQuiz(`${C}/quiz:0001-1`);
      await db.saveQuizChoice(q1.id, { courseId: C, qKey: db.questionKeys(q1.questions)[0], choice: 'Да', cursor: 0 });
    }, C);
    await openCourse(page);
    for (const [n, words] of [['0001', 'Тестове: започнати'], ['0002', 'Тестове: минати'], ['0004', 'Тестове: не са започнати']]) {
      await expect(quizMark(page, n)).toBeVisible();
      const snap = await quizLine(page, n).ariaSnapshot();
      expect(snap, n).toContain(words);
      expect(await quizMark(page, n).evaluate((m) => [m.closest('[aria-hidden="true"]'), m.tabIndex, m.getAttribute('role')])).toEqual([null, -1, null]);
    }
    await page.emulateMedia({ forcedColors: 'active' });
    await openCourse(page);
    const seen = await page.evaluate(() => [...document.querySelectorAll('[data-field="lesson-quiz-mark"]')].filter((m) => m.offsetParent)
      .map((m) => [m.dataset.state, m.textContent, m.getBoundingClientRect().width > 0]));
    expect(new Set(seen.map(([, t]) => t)).size).toBe(3);
    for (const [, , vis] of seen) expect(vis).toBe(true);
    // Information: whether the square itself still differs with forced colours.
    const shapes = await page.evaluate(() => [...document.querySelectorAll('[data-field="lesson-quiz-mark"]')].filter((m) => m.offsetParent)
      .map((m) => { const s = getComputedStyle(m.querySelector('.quiz-mark__icon')); return `${m.dataset.state}:${s.backgroundImage.slice(0, 30)}|${s.backgroundColor}|${s.forcedColorAdjust}`; }));
    test.info().annotations.push({ type: 'T060-I forced-colors squares', description: shapes.join(' ; ') });
  });
});

// ---------------------------------------------------------------------------
// T060-H: the history
// ---------------------------------------------------------------------------
test.describe('T060-H history of places', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T060-H1 60 real visits through the screens (lessons, reference, quizzes): 50 kept, the 10 newest shown in order, each place once; the oldest are gone; another course untouched', async ({ page }, info) => {
    onlyLandscape(info, '60 page visits');
    test.setTimeout(300_000);
    // 30 lessons + 30 quizzes = 60 places, visited once each through the app.
    const H = 'LRN-T60H';
    const files = { 'INDEX.md': indexMd(H, Array.from({ length: 30 }, (_, i) => [pad4(i + 1), `Урок ${i + 1}`])) };
    for (let i = 1; i <= 30; i++) {
      files[`lessons/${pad4(i)}-u.html`] = lessonHtml(`Урок ${i}`);
      files[`quizzes/${pad4(i)}-1-t.json`] = quiz(pad4(i), `Тест ${i}`, 2);
    }
    await importCourse(page, H, files);
    await importCourse(page, C, base());
    await page.goto(`./#/c/${C}/read/0004`);
    await waitReady(page);
    const order = [];
    for (let i = 1; i <= 30; i++) {
      await page.goto(`./#/c/${H}/read/${pad4(i)}`);
      await waitReady(page);
      order.push(`lesson:${pad4(i)}`);
      await page.goto(`./#/c/${H}/quiz/${pad4(i)}-1-t`);
      await expect(quizCount(page)).toHaveText('Въпрос 1 от 2 · отговорени 0');
      order.push(`quiz:${pad4(i)}-1`);
    }
    const kept = order.slice(-50).reverse();
    await expect.poll(async () => (await records(page, H)).length).toBe(50);
    expect((await records(page, H)).map(([id]) => id)).toEqual(kept);
    // A revisit of an old (still kept) place: to the top, still 50, no duplicate.
    await page.goto(`./#/c/${H}/read/0006`);
    await waitReady(page);
    const after = (await records(page, H)).map(([id]) => id);
    expect(after[0]).toBe('lesson:0006');
    expect(after).toHaveLength(50);
    expect(new Set(after).size).toBe(50);
    // A place gone from the 50 comes back as new and pushes the oldest out.
    await page.goto(`./#/c/${H}/read/0001`);
    await waitReady(page);
    const again = (await records(page, H)).map(([id]) => id);
    expect(again[0]).toBe('lesson:0001');
    expect(again).toHaveLength(50);
    expect(again).not.toContain(after[49]);
    await openCourse(page, H);
    await expect(history(page)).toHaveCount(10);
    expect((await history(page).allTextContents()).map((t) => t.replace(/ — днес \d\d:\d\d$/, ''))).toEqual(
      again.slice(0, 10).map((id) => (id.startsWith('lesson:') ? `Урок ${id.slice(7)} „Урок ${Number(id.slice(7))}“` : `Тест „Тест ${Number(id.slice(5, 9))}“ · въпрос 1 от 2`)));
    // The other course: its one place, untouched.
    expect(await records(page, C)).toEqual([['lesson:0004', 'lesson', 0, null, null]]);
  });

  test('T060-H2 a tap returns exactly: lesson scrolled by the user, a fragment then a scroll (fragment → pixels), a quiz moved with "Напред"/"Назад", a quiz in "Опитай пак грешните"', async ({ page }) => {
    await importCourse(page, C, base());
    await page.goto(`./#/c/${C}/read/0004`);
    await waitReady(page);
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.scrollTo(0, 5200));
    await expect.poll(async () => (await records(page)).find(([id]) => id === 'lesson:0004')?.[2] ?? 0, { timeout: 5000 }).toBeGreaterThan(4500);
    const y4 = (await records(page)).find(([id]) => id === 'lesson:0004')[2];
    // Reference at a fragment; the user then scrolls up → the place becomes pixels.
    await page.goto(`./#/c/${C}/read/R01?at=sredata`);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(3500);
    await page.waitForTimeout(2500);
    // Not scrolled by the user yet: the place is the fragment (or the same spot in pixels).
    const atFrag = (await records(page)).find(([id]) => id === 'reference:R01');
    expect(atFrag[3] === 'sredata' || atFrag[2] > 3500, JSON.stringify(atFrag)).toBe(true); // T060-D1: see T060-H8
    await page.evaluate(() => window.scrollBy(0, -1500));
    await expect.poll(async () => { const r = (await records(page)).find(([id]) => id === 'reference:R01'); return r && r[3] === null ? r[2] : 99999; }, { timeout: 5000 }).toBeLessThan(3500);
    const yR = (await records(page)).find(([id]) => id === 'reference:R01')[2];
    expect(yR).toBeGreaterThan(1500);
    expect(yR).toBeLessThan(3500);
    // Quiz: forward 4, back 1 → the 4th question.
    await page.goto(`./#/c/${C}/quiz/0004-1-osnoven`);
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Напред' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
    await expect(quizCount(page)).toHaveText('Въпрос 4 от 8 · отговорени 0');
    // Quiz 0001-1 in "Опитай пак грешните" on its 3rd question (index 2).
    await db(page, async (db, C) => {
      const q = await db.getQuiz(`${C}/quiz:0001-1`);
      const keys = db.questionKeys(q.questions);
      await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[0], choice: 'Не', cursor: 0 });
      await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[1], choice: 'Да', cursor: 1 });
      await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[2], choice: 'Не', cursor: 2 });
    }, C);
    await page.goto(`./#/c/${C}/quiz/0001-1-osnoven?q=3`);
    await expect(quizCount(page)).toHaveText('Въпрос 3 от 3 · отговорени 3');
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await page.getByRole('button', { name: /Опитай пак грешните/ }).click();
    await page.getByRole('button', { name: 'Напред' }).click();
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Основен 1: въпрос 3?');
    await openCourse(page);
    const recs = await records(page);
    expect(recs.slice(0, 3)).toEqual([
      ['quiz:0001-1', 'quiz', null, null, 2],
      ['quiz:0004-1', 'quiz', null, null, 3],
      ['reference:R01', 'reference', yR, null, null],
    ]);
    expect(await hrefs(page)).toEqual([
      `#/c/${C}/quiz/0001-1-osnoven?q=3`, `#/c/${C}/quiz/0004-1-osnoven?q=4`, `#/c/${C}/read/R01?y=${yR}`, `#/c/${C}/read/0004?y=${y4}`,
    ]);
    await expect(history(page).nth(1)).toHaveText(/^Тест „Основен 4“ · въпрос 4 от 8 — днес \d\d:\d\d$/);
    // Taps.
    await history(page).nth(3).locator('a').click();
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(y4 - 150);
    expect(Math.abs(await lessonScroll(page) - y4)).toBeLessThan(150);
    await openCourse(page);
    await history(page).filter({ hasText: 'Справка' }).locator('a').click();
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(yR - 150);
    expect(Math.abs(await lessonScroll(page) - yR)).toBeLessThan(150);
    await openCourse(page);
    await history(page).filter({ hasText: 'Основен 4' }).locator('a').click();
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Основен 4: въпрос 4?');
    await openCourse(page);
    await history(page).filter({ hasText: 'Основен 1' }).locator('a').click();
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Основен 1: въпрос 3?');
    // The Back button from a place returns to the course with the place on top.
    await page.goBack();
    await openCourse(page);
    await expect(history(page).first()).toContainText('Основен 1');
  });

  test('T060-H3 quick switching lesson → quiz → lesson → reference (no waiting) and two tabs at once: the order is the order of the visits, no duplicates, positions not mixed up', async ({ page, context }) => {
    await importCourse(page, C, base());
    for (const hash of [`read/0001`, `quiz/0002-1-osnoven`, `read/0004`, `quiz/0001-1-osnoven`, `read/0001`, `read/R01`]) {
      await page.evaluate((h) => { location.hash = h; }, `#/c/${C}/${hash}`);
      await page.waitForTimeout(60);
    }
    await waitReady(page);
    await page.waitForTimeout(800);
    let recs = await records(page);
    // Places left before they were loaded may be missing; the rest are in the order of the visits.
    const want = ['reference:R01', 'lesson:0001', 'quiz:0001-1', 'lesson:0004', 'quiz:0002-1'];
    const got = recs.map(([id]) => id);
    test.info().annotations.push({ type: 'T060-H3 quick switching', description: got.join(', ') });
    expect(got[0]).toBe('reference:R01');
    expect(got.filter((id) => want.includes(id))).toEqual(want.filter((id) => got.includes(id)));
    expect(new Set(got).size).toBe(got.length);
    for (const [, kind, y, , q] of recs) {
      if (kind === 'quiz') { expect(y).toBe(null); expect(q).toBe(0); } else { expect(q).toBe(null); expect(Number.isFinite(y)).toBe(true); }
    }
    // A second tab visits other places at the same time.
    const other = await context.newPage();
    await Promise.all([other.goto(`./#/c/${C}/read/0002`), page.goto(`./#/c/${C}/quiz/0004-1-osnoven`)]);
    await expect(other.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await expect(quizCount(page)).toHaveText('Въпрос 1 от 8 · отговорени 0');
    await other.goto(`./#/c/${C}/read/0003`);
    await expect(other.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await records(page))[0][0]).toBe('lesson:0003');
    recs = await records(page);
    expect(recs.map(([id]) => id).slice(0, 1)).toEqual(['lesson:0003']);
    expect(new Set(recs.map(([id]) => id)).size).toBe(recs.length);
    expect(recs.map(([id]) => id).sort()).toEqual(['lesson:0001', 'lesson:0002', 'lesson:0003', 'lesson:0004', 'quiz:0001-1', 'quiz:0002-1', 'quiz:0004-1', 'reference:R01']);
    await other.close();
  });

  test('T060-H4 a reset quiz, a deleted lesson, a retired lesson, a deleted quiz, a deleted course; several courses: the history never breaks and never shows another course', async ({ page }) => {
    await importCourse(page, C, base());
    await importCourse(page, 'LRN-T60B', base());
    const t0 = Date.parse('2026-11-20T07:00:00.000Z');
    await db(page, async (db, { C, t0 }) => {
      const at = (k) => new Date(t0 + k * 60000).toISOString();
      await db.visitPlace({ courseId: C, kind: 'lesson', id: `${C}/lesson:0001`, scrollY: 100, at: at(1) });
      await db.visitPlace({ courseId: C, kind: 'lesson', id: `${C}/lesson:0002`, scrollY: 200, at: at(2) });
      await db.visitPlace({ courseId: C, kind: 'quiz', id: `${C}/quiz:0004-1`, question: 6, at: at(3) });
      await db.visitPlace({ courseId: C, kind: 'lesson', id: `${C}/lesson:0003`, scrollY: 300, at: at(4) });
      await db.visitPlace({ courseId: C, kind: 'quiz', id: `${C}/quiz:0002-1`, question: 1, at: at(5) });
      await db.visitPlace({ courseId: 'LRN-T60B', kind: 'lesson', id: 'LRN-T60B/lesson:0004', scrollY: 9, at: at(6) });
      const q = await db.getQuiz(`${C}/quiz:0004-1`);
      const keys = db.questionKeys(q.questions);
      for (let i = 0; i < 7; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: 'Да', cursor: i });
    }, { C, t0 });
    await openCourse(page);
    await expect(history(page)).toHaveCount(5);
    // Reset 0004-1 through the screen: the place stays (a position, not a result).
    await toggleOf(page, '0004').click();
    await qrow(item(page, '0004'), 'Основен 4').locator('[data-field="quiz-reset"]').click();
    await qrow(item(page, '0004'), 'Основен 4').locator('[data-field="confirm-yes"]').click();
    await expect(quizLine(page, '0004')).toHaveText('Тестове: не са започнати Въпроси 0 от 8');
    await expect(history(page).filter({ hasText: 'Основен 4' })).toHaveText(/^Тест „Основен 4“ · въпрос 7 от 8 — /);
    await history(page).filter({ hasText: 'Основен 4' }).locator('a').click();
    await expect(page.locator('[data-field="quiz-question"]')).toHaveText('Основен 4: въпрос 7?');
    await expect(quizCount(page)).toHaveText('Въпрос 7 от 8 · отговорени 0');
    // 0003 retired (re-import): listed and opens; then a lesson and a quiz soft-deleted: left out.
    const f = base();
    delete f['lessons/0003-treti.html'];
    f['INDEX.md'] = indexMd(C, [['0001', 'Първи'], ['0002', 'Втори'], ['0004', 'Четвърти']], '\n## Оттеглени номера\n- 0003\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n');
    const ri = await importCourse(page, C, f);
    expect(ri.error, JSON.stringify(ri)).toBeUndefined();
    await db(page, async (db, C) => {
      await db.remove(db.STORES.lessons, `${C}/lesson:0001`);
      await db.remove(db.STORES.quizzes, `${C}/quiz:0002-1`);
    }, C);
    await openCourse(page);
    const texts = (await history(page).allTextContents()).map((t) => t.replace(/ — .*$/, ''));
    expect(texts).toEqual(['Тест „Основен 4“ · въпрос 7 от 8', 'Урок 0003 „Трети без тестове“', 'Урок 0002 „Втори“']);
    await history(page).filter({ hasText: 'Трети' }).locator('a').click();
    await expect(page.locator('[data-field="retired-note"]')).toBeVisible({ timeout: 20000 });
    // The other course shows only its own place.
    await openCourse(page, 'LRN-T60B');
    expect(await hrefs(page)).toEqual(['#/c/LRN-T60B/read/0004?y=9']);
    // The course itself soft-deleted: its screen says so, no error; the other course is fine.
    await db(page, (db, C) => db.remove(db.STORES.courses, C), C);
    await page.goto(`./#/c/${C}`);
    await expect(course(page)).toContainText('Курсът още не е импортиран.');
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${C}"]`)).toHaveCount(0);
    await openCourse(page, 'LRN-T60B');
    await expect(history(page)).toHaveCount(1);
    // An old history link of the deleted course: no error, no other course.
    await page.goto(`./#/c/${C}/read/0002?y=200`);
    await expect(page.locator('[data-field="reader-missing"]')).toHaveText('Курсът още не е импортиран.');
    await page.goto(`./#/c/${C}/quiz/0004-1-osnoven?q=7`);
    await expect(page.locator('[data-field="quiz-missing"]')).toHaveText('Курсът още не е импортиран.');
  });

  test('T060-H5 XSS: HTML in lesson, reference and quiz titles and in a fragment is text in the history, in its links and in the reader', async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b>ж</b>';
    const esc = evil.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    await importCourse(page, C, base({
      'lessons/0002-vtori.html': lessonHtml(`Втори ${esc}`),
      'reference/R01-spravka.html': lessonHtml(`Справка ${esc}`, LONG_BODY),
      'quizzes/0002-1-osnoven.json': quiz('0002', `Основен ${evil}`, 3),
    }));
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await page.goto(`./#/c/${C}/read/R01?at=${encodeURIComponent(evil)}`);
    await waitReady(page);
    await page.goto(`./#/c/${C}/quiz/0002-1-osnoven`);
    await expect(quizCount(page)).toBeVisible();
    await openCourse(page);
    const t = await history(page).allTextContents();
    expect(t[0]).toMatch(new RegExp(`^Тест „Основен ${reEsc(evil)}“ · въпрос 1 от 3 — `));
    expect(t[1]).toMatch(new RegExp(`^Справочник R01 „Справка ${reEsc(evil)}“ — `));
    expect(t[2]).toMatch(new RegExp(`^Урок 0002 „Втори ${reEsc(evil)}“ — `));
    await expect(course(page).locator('[data-section="activity"] :is(img,script,b)')).toHaveCount(0);
    const refHref = (await hrefs(page))[1];
    expect(refHref).toBe(`#/c/${C}/read/R01?at=${encodeURIComponent(evil)}`);
    await history(page).nth(1).locator('a').click();
    await waitReady(page);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#main :is(img[src="x"],b)')).toHaveCount(0);
    // A fragment that is an existing id with "<": the reader goes there.
    await page.goto(`./#/c/${C}/read/R01?at=${encodeURIComponent('a<b')}`);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(6500);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('T060-H6 hostile ?y= / ?at= / ?q= and ids: no error, never another course, the stored place stays sane and its link stays in the course', async ({ page }) => {
    test.setTimeout(240_000);
    allowed.push(/Failed to load resource/);
    await importCourse(page, C, base());
    await importCourse(page, 'LRN-T60X', base());
    const X = 'LRN-T60X';
    const ys = ['-5', '-0', '1e5', 'NaN', 'Infinity', '0x10', '12.5', '999999999', '99999999999999999999', '%00', 'javascript:alert(1)', '<b>1</b>', ''];
    for (const y of ys) {
      await page.goto(`./#/c/${C}/read/0001?y=${encodeURIComponent(y)}`);
      await waitReady(page);
      const r = (await records(page)).find(([id]) => id === 'lesson:0001');
      expect(Number.isInteger(r[2]) && r[2] >= 0, `y=${y} → ${JSON.stringify(r)}`).toBe(true);
      expect(new URL(page.url()).hash.startsWith(`#/c/${C}/read/0001`)).toBe(true);
    }
    const ats = ['javascript:alert(1)', '"><img src=x onerror=window.__xss=1>', '../../LRN-T60X/lessons/0001-parvi.html', `#/c/${X}/read/0001`, '%E0%A4%A', 'x'.repeat(5000), 'nyama-takava'];
    for (const at of ats) {
      await page.goto(`./#/c/${C}/read/0001?at=${encodeURIComponent(at)}`);
      await waitReady(page);
      expect(new URL(page.url()).hash.startsWith(`#/c/${C}/read/0001`), at.slice(0, 40)).toBe(true);
    }
    const qs = ['0', '-1', '9', '999999', '1e3', 'NaN', '3.5', 'javascript:1', '<b>2</b>', ''];
    for (const q of qs) {
      await page.goto(`./#/c/${C}/quiz/0002-1-osnoven?q=${encodeURIComponent(q)}`);
      await expect(quizCount(page), `q=${q}`).toHaveText(/^Въпрос [1-3] от 3 · /);
      const r = (await records(page)).find(([id]) => id === 'quiz:0002-1');
      expect(r[4] >= 0 && r[4] <= 2, `q=${q} → ${JSON.stringify(r)}`).toBe(true);
    }
    // Ids of another course / with paths: never opens LRN-T60X content.
    await db(page, (db, X) => db.setLessonProgress(`${X}/lesson:0002`, { status: 'started', lastOpenedAt: '2026-11-20T06:00:00.000Z' }), X);
    const before = await records(page, X);
    const xProgress = () => db(page, async (db, X) => (await db.listLessons(X)).map((l) => [l.id, JSON.stringify(l.progress)]), X);
    const xBefore = await xProgress();
    for (const id of [`${X}%2Flesson%3A0002`, encodeURIComponent(`${X}/lesson:0002`), '..%2F..%2FLRN-T60X%2Fread%2F0002', `${encodeURIComponent('../LRN-T60X')}/0002`]) {
      await page.goto(`./#/c/${C}/read/${id}`);
      await expect(page.locator('[data-field="reader-missing"], [data-lesson-state="ready"], [data-screen="not-found"]').first()).toBeVisible({ timeout: 20000 });
      const what = await page.locator('[data-screen="not-found"]').count() ? 'no such page' : await page.locator('[data-field="reader-missing"]').count() ? 'not found' : 'a lesson of the same course';
      test.info().annotations.push({ type: 'T060-H6 id', description: `${id} → ${what}` });
    }
    for (const id of [encodeURIComponent(`${X}/quiz:0002-1`), `${X}%2Fquiz%3A0002-1`]) {
      await page.goto(`./#/c/${C}/quiz/${id}?q=2`);
      await expect(page.locator('[data-field="quiz-missing"], .quiz__count').first()).toBeVisible();
      test.info().annotations.push({ type: 'T060-H6 quiz id', description: `${id} → ${await page.locator('[data-field="quiz-missing"]').count() ? 'not found' : 'a quiz of the same course'}` });
    }
    // Nothing of the other course was opened or written.
    expect(await records(page, X)).toEqual(before);
    expect(await xProgress()).toEqual(xBefore);
    // Every record of the course is sane and the screen with its links is fine.
    const all = await db(page, async (db, C) => db.listHistory(C), C);
    for (const r of all) {
      expect(r.id.startsWith(`${C}/`)).toBe(true);
      expect(r.courseId).toBe(C);
      if (r.kind !== 'quiz') expect(Number.isInteger(r.scrollY) && r.scrollY >= 0).toBe(true);
    }
    await openCourse(page);
    for (const href of await hrefs(page)) {
      expect(href.startsWith(`#/c/${C}/`), href).toBe(true);
      expect(href).not.toMatch(/javascript:|<|>|"/);
    }
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // Information: how long the longest stored fragment is.
    const maxAnchor = Math.max(0, ...all.map((r) => (r.anchor || '').length));
    test.info().annotations.push({ type: 'T060-I anchor length', description: String(maxAnchor) });
  });

  test('T060-H8 (T060-D1) a place opened at a fragment and NOT scrolled by the user keeps the fragment (T-059 log §1.4), so it is exact at another width or text size', async ({ page }) => {
    test.fail(true, 'T060-D1: the reader\'s own jump to the fragment is recorded as a scroll: the fragment becomes pixels at once');
    await importCourse(page, C, base());
    await page.goto(`./#/c/${C}/read/R01?at=sredata`);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(3500);
    await page.waitForTimeout(3000);
    const r = (await records(page)).find(([id]) => id === 'reference:R01');
    expect(r[3], JSON.stringify(r)).toBe('sredata');
    await openCourse(page);
    expect((await hrefs(page))[0]).toBe(`#/c/${C}/read/R01?at=sredata`);
  });

  test('T060-H7 the store: "history" is in BACKUP_STORES, "secrets" is not; visitPlace refuses a bad kind / empty ids; movePlace of an unknown place does nothing', async ({ page }) => {
    const r = await db(page, async (db) => {
      const out = { backup: [...db.BACKUP_STORES], priv: [...db.PRIVATE_STORES] };
      const err = async (p) => { try { await p; return 'ok'; } catch (e) { return e.name || 'Error'; } };
      out.badKind = await err(db.visitPlace({ courseId: 'X', kind: 'topic', id: 'X/topic:1' }));
      out.noId = await err(db.visitPlace({ courseId: 'X', kind: 'lesson', id: '' }));
      out.noCourse = await err(db.visitPlace({ courseId: '', kind: 'lesson', id: 'X/lesson:0001' }));
      out.move = await db.movePlace('X/lesson:9999', { scrollY: 5 });
      out.neg = (await db.visitPlace({ courseId: 'X', kind: 'lesson', id: 'X/lesson:0001', scrollY: -40 })).scrollY;
      out.nan = (await db.visitPlace({ courseId: 'X', kind: 'quiz', id: 'X/quiz:0001-1', question: Number.NaN })).question;
      out.list = (await db.listHistory('X')).length;
      await db.purge(db.STORES.history, 'X/lesson:0001');
      await db.purge(db.STORES.history, 'X/quiz:0001-1');
      return out;
    });
    expect(r.backup).toContain('history');
    expect(r.backup).not.toContain('secrets');
    expect(r.priv).toEqual(['secrets']);
    expect(r.badKind).not.toBe('ok');
    expect(r.noId).not.toBe('ok');
    expect(r.noCourse).not.toBe('ok');
    expect(r.move).toBe(null);
    expect(r.neg).toBe(null);
    expect(r.nan).toBe(0);
    expect(r.list).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T060-M: migration to v6 from real old builds
// ---------------------------------------------------------------------------
/** Every record of every store of lrn-app (raw IndexedDB, no version: never upgrades). */
const dump = (page) => page.evaluate(() => new Promise((ok, fail) => {
  const r = indexedDB.open('lrn-app');
  r.onerror = () => fail(r.error);
  r.onsuccess = () => {
    const idb = r.result;
    const out = { version: idb.version, stores: {} };
    const names = [...idb.objectStoreNames];
    if (!names.length) { idb.close(); ok(out); return; }
    const tx = idb.transaction(names);
    for (const s of names) tx.objectStore(s).getAll().onsuccess = (e) => { out.stores[s] = e.target.result.map((x) => ({ ...x, blob: x.blob ? `blob:${x.blob.size}` : undefined, rendered: x.rendered ? 'rendered' : undefined })); };
    tx.oncomplete = () => { idb.close(); ok(out); };
  };
}));
async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}
/** A real old build: the worktree T060_OLD (0.10.0) if given, else git archive of the commit. */
function oldBuild(info, commit, tag) {
  const port = 4900 + info.workerIndex * 8 + tag;
  if (commit === '27f07f4' && process.env.T060_OLD && existsSync(join(process.env.T060_OLD, 'tests/serve.mjs'))) {
    return { port, dir: process.env.T060_OLD, url: `http://localhost:${port}/EasyLRN/`, own: false };
  }
  test.skip(!existsSync(join(REPO, '.git')), 'needs the git history');
  try { execSync(`git -C "${REPO}" cat-file -e ${commit}^{commit}`, { stdio: 'ignore' }); } catch { test.skip(true, `needs commit ${commit} (git fetch --deepen=50)`); }
  const dir = `/tmp/t060-old-${commit}-${port}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSync(`git -C "${REPO}" archive ${commit} | tar -x -C "${dir}"`);
  return { port, dir, url: `http://localhost:${port}/EasyLRN/`, own: true };
}
async function updateTo(page, url, version) {
  await page.goto(url);
  await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20000 });
  await page.locator('#update-button').click();
  await expect.poll(() => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION).catch(() => null), { timeout: 20000 }).toBe(version);
}
const appVersion = (page) => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION);
const sortJson = (rs) => (rs || []).map((x) => JSON.stringify(x)).sort();
/** Every store except `history`: exactly the same records. */
function sameExceptHistory(a, b) {
  const out = [];
  for (const s of new Set([...Object.keys(a.stores), ...Object.keys(b.stores)])) {
    if (s === 'history') continue;
    if (JSON.stringify(sortJson(a.stores[s])) !== JSON.stringify(sortJson(b.stores[s]))) out.push(s);
  }
  return out;
}
/** An independent expectation of the seeded history (not the app's code). */
function expectedSeed(stores) {
  const valid = (t) => typeof t === 'string' && !Number.isNaN(Date.parse(t));
  const out = [];
  for (const l of stores.lessons || []) {
    if (l.deleted || !valid(l.progress?.lastOpenedAt)) continue;
    const y = l.progress.scrollY;
    out.push({ id: l.id, courseId: l.courseId, kind: l.kind === 'reference' ? 'reference' : 'lesson', visitedAt: l.progress.lastOpenedAt, scrollY: Number.isFinite(y) && y >= 0 ? Math.round(y) : 0, question: null });
  }
  const quizzes = new Map((stores.quizzes || []).filter((q) => !q.deleted).map((q) => [q.id, q]));
  for (const a of stores.quizAnswers || []) {
    const q = quizzes.get(a.id);
    if (!q || a.deleted || !valid(a.updatedAt)) continue;
    if (!Object.keys(a.choices || {}).length && !a.cursor) continue;
    out.push({ id: q.id, courseId: q.courseId, kind: 'quiz', visitedAt: a.updatedAt, scrollY: null, question: Math.min(a.cursor || 0, q.questions.length - 1) });
  }
  const by = {};
  for (const r of out) (by[r.courseId] ||= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([c, rs]) => [c, rs.sort((x, y) => y.visitedAt.localeCompare(x.visitedAt) || x.id.localeCompare(y.id)).slice(0, 50)]));
}
const seededOf = (v6) => {
  const by = {};
  for (const r of v6.stores.history || []) (by[r.courseId] ||= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([c, rs]) => [c, rs.sort((x, y) => y.visitedAt.localeCompare(x.visitedAt) || x.id.localeCompare(y.id))
    .map((r) => ({ id: r.id, courseId: r.courseId, kind: r.kind, visitedAt: r.visitedAt, scrollY: r.scrollY, question: r.question }))]));
};

const M = 'LRN-T60M';
const mFiles = () => ({
  'INDEX.md': indexMd(M, [['0001', 'Алфа'], ['0002', 'Бета'], ['0003', 'Гама']], '\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n'),
  'lessons/0001-alfa.html': lessonHtml('Алфа', LONG_BODY),
  'lessons/0002-beta.html': lessonHtml('Бета'),
  'lessons/0003-gama.html': lessonHtml('Гама'),
  'reference/R01-spravka.html': lessonHtml('Справка', LONG_BODY),
  'quizzes/0001-1-alfa.json': quiz('0001', 'Тест алфа', 4),
  'quizzes/0001-2-pregovor.json': quiz('0001', 'Преговор алфа', 2),
  'quizzes/0002-1-beta.json': quiz('0002', 'Тест бета', 3),
});

test.describe('T060-M migration to v6', () => {
  test('T060-M1 a REAL 0.10.0 profile made through its own screens (+ a 0.10.0 tab left open) → 0.11.0: every old record unchanged, the history filled from it, the screen and its links go back to the places; back to 0.10.0 afterwards', async ({ page, context }, info) => {
    onlyLandscape(info, 'two servers, two builds');
    test.setTimeout(300_000);
    allowed.push(/Failed to load resource/);
    const old = oldBuild(info, '27f07f4', 0);
    const zip = (files, id) => [...makeZip(toBytes(files), { root: id })];
    let stop = await serve(old.dir, old.port);
    let v5;
    let oldTab;
    try {
      await page.goto(old.url);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      expect(await appVersion(page)).toBe('0.10.0');
      console.log(`T060-M1 0.10.0 import: ${JSON.stringify(await importBytes(page, `${M}.zip`, zip(mFiles(), M)))}`);
      console.log(`T060-M1 0.10.0 import B: ${JSON.stringify(await importBytes(page, 'LRN-T60N.zip', zip(base(), 'LRN-T60N')))}`);
      // 0.10.0 screens: read 0001 down to ~2500 px, mark it; a quiz through its screen; a reset.
      await page.goto(`${old.url}#/c/${M}/read/0001`);
      await waitReady(page);
      await page.waitForTimeout(1600);
      // Mark first (the button is at the top: tapping it after scrolling scrolls back up).
      await page.locator('[data-action="complete"]').click();
      await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(600, 600);
      for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 100);
      await expect.poll(() => page.evaluate(async (id) => (await (await import('./src/db.js')).getLesson?.(id))?.progress?.scrollY
        ?? (await (await import('./src/db.js')).listLessons('LRN-T60M')).find((l) => l.id === id)?.progress?.scrollY, `${M}/lesson:0001`), { timeout: 8000 }).toBeGreaterThan(2000);
      await page.goto(`${old.url}#/c/${M}/read/R01?at=sredata`);
      await waitReady(page);
      await page.waitForTimeout(1200);
      await page.goto(`${old.url}#/c/${M}/quiz/0001-1-alfa`);
      await answerHere(page, true);
      await answerHere(page, false);
      await expect(quizCount(page)).toHaveText('Въпрос 3 от 4 · отговорени 2');
      await page.goto(`${old.url}#/c/${M}/quiz/0002-1-beta`);
      await answerHere(page, true);
      await page.goto(`${old.url}#/c/${M}`);
      await page.locator('[data-field="lesson-toggle"]').nth(1).click();
      const beta = page.locator('.quiz-list__item', { hasText: 'Тест бета' });
      await beta.locator('[data-field="quiz-reset"]').click();
      await beta.locator('[data-field="confirm-yes"]').click();
      await page.goto(`${old.url}#/c/LRN-T60N/read/0002`);
      await waitReady(page);
      await page.evaluate(async () => {
        const db = await import('./src/db.js');
        await db.saveSettings({ theme: 'dark' });
        await db.saveApiKey('sk-ant-api03-FAKE-t060-0000000000000000000000000000');
        const sel = { quote: { exact: 'Алфа', prefix: '', suffix: '' }, position: { start: 0, end: 4 } };
        const a = await db.createAnnotation({ courseId: 'LRN-T60M', target: { type: 'lesson', id: 'LRN-T60M/lesson:0001' }, selector: sel, color: 'yellow' });
        await db.createNote({ annotationId: a.id, body: 'бележка' });
      });
      v5 = await dump(page);
      expect(v5.version).toBe(5);
      expect(v5.stores.history).toBeUndefined();
      oldTab = await context.newPage();
      await oldTab.goto(`${old.url}#/c/${M}`);
      await expect(oldTab.locator('[data-screen="course"] [data-section="activity"]')).toBeVisible({ timeout: 15000 });
    } finally { await stop(); }

    stop = await serve(REPO, old.port);
    let v6;
    try {
      await updateTo(page, old.url, NOW_VERSION);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await expect.poll(async () => (await dump(page)).version, { timeout: 20000 }).toBe(6);
      await expect(page.locator('#db-error')).toBeHidden();
      v6 = await dump(page);
      expect(sameExceptHistory(v5, v6)).toEqual([]);
      const want = expectedSeed(v5.stores);
      expect(seededOf(v6)).toEqual(want);
      expect(want[M].map((r) => r.id.slice(M.length + 1))).toEqual(['quiz:0001-1', 'reference:R01', 'lesson:0001']);
      expect(want['LRN-T60N'].map((r) => r.id.slice('LRN-T60N'.length + 1))).toEqual(['lesson:0002']);
      const L1 = v5.stores.lessons.find((l) => l.id === `${M}/lesson:0001`);
      expect(L1.progress.scrollY).toBeGreaterThan(2000);
      // The screen: material and quizzes apart, the history with its links.
      await page.goto(`${old.url}#/c/${M}`);
      await expect(history(page)).toHaveCount(3, { timeout: 15000 });
      await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
      await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 2 от 6');
      await expect(quizLine(page, '0002')).toHaveText('Тестове: не са започнати Въпроси 0 от 3');
      await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 3 урока');
      expect(await hrefs(page)).toEqual([`#/c/${M}/quiz/0001-1-alfa?q=3`, `#/c/${M}/read/R01?y=${want[M][1].scrollY}`, `#/c/${M}/read/0001?y=${L1.progress.scrollY}`]);
      await history(page).nth(2).locator('a').click();
      await waitReady(page);
      await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(L1.progress.scrollY - 150);
      await page.goto(`${old.url}#/c/${M}`);
      await history(page).filter({ hasText: 'Тест алфа' }).locator('a').click();
      await expect(quizCount(page)).toHaveText('Въпрос 3 от 4 · отговорени 2');
      // The 0.10.0 tab: it lost its connection (or shows a note), it never wrote into v6.
      const oldSaw = await oldTab.locator('body').innerText().catch(() => '');
      test.info().annotations.push({ type: 'T060-M1 old tab', description: oldSaw.slice(0, 160).replace(/\s+/g, ' ') });
      await oldTab.close();
      v6 = await dump(page); // after the taps above (they are visits)
    } finally { await stop(); }

    // Back to 0.10.0 (e.g. an old cached tab): what does it do with a v6 database?
    stop = await serve(old.dir, old.port);
    let seen;
    try {
      allowed.push(/IndexedDB|VersionError|version|Failed to load/i);
      await updateTo(page, old.url, '0.10.0');
      await page.waitForTimeout(1500);
      seen = { screen: (await page.locator('#main').innerText()).slice(0, 200), dbError: await page.locator('#db-error').isVisible() ? await page.locator('#db-error').innerText() : '', version: (await dump(page)).version };
      test.info().annotations.push({ type: 'T060-M1 0.10.0 on v6', description: JSON.stringify(seen) });
      expect(seen.version).toBe(6);
    } finally { await stop(); }
    stop = await serve(REPO, old.port);
    try {
      await updateTo(page, old.url, NOW_VERSION);
      const back = await dump(page);
      expect(sameExceptHistory(v6, back)).toEqual([]);
      expect(JSON.stringify(sortJson(back.stores.history))).toBe(JSON.stringify(sortJson(v6.stores.history)));
    } finally { await stop(); }
    if (old.own) rmSync(old.dir, { recursive: true, force: true });
  });

  for (const [commit, version, schema, tag] of [['29f8acf', '0.9.0', 5, 1], ['2bd1aa5', '0.8.1', 4, 2], ['8785523', '0.6.0', 2, 3]]) {
    test(`T060-M2 a real ${version} profile (schema v${schema}) → 0.11.0 in one upgrade: lessons, answers, settings, key, notes all there; the history from the opened lessons and answered quizzes`, async ({ page }, info) => {
      onlyLandscape(info, 'two servers, two builds');
      test.setTimeout(240_000);
      allowed.push(/Failed to load resource/);
      const old = oldBuild(info, commit, tag);
      let stop = await serve(old.dir, old.port);
      let before;
      try {
        await page.goto(old.url);
        await expect(page.locator('[data-screen="courses"]')).toBeVisible();
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
        expect(await appVersion(page)).toBe(version);
        const r = await importBytes(page, `${M}.zip`, [...makeZip(toBytes(mFiles()), { root: M })]);
        expect(r.error, JSON.stringify(r)).toBeUndefined();
        before = await page.evaluate(async (M) => {
          const db = await import('./src/db.js');
          const lessons = await db.listLessons(M);
          const by = (n) => lessons.find((l) => l.number === n);
          await db.setLessonProgress(by('0001').id, { status: 'done', completedAt: '2026-11-18T10:05:00.000Z', lastOpenedAt: '2026-11-18T10:00:00.000Z', scrollY: 1500 });
          await db.setLessonProgress(by('R01').id, { status: 'started', lastOpenedAt: '2026-11-18T11:00:00.000Z', scrollY: 640 });
          await db.setLessonProgress(by('0002').id, { status: 'started', lastOpenedAt: '2026-11-18T09:00:00.000Z', scrollY: 0 });
          const quizzes = await db.listQuizzes(M);
          const q1 = quizzes.find((q) => q.title === 'Тест алфа');
          const keyOf = db.questionKeys ? (qs) => db.questionKeys(qs) : (qs) => qs.map((q) => db.questionKey(q.q));
          const k = keyOf(q1.questions);
          // v2 stores the option index, later builds the option text.
          const pick = (q, i) => (db.questionKeys ? q.questions[i].options[0] : 0);
          await db.saveQuizChoice(q1.id, { courseId: M, qKey: k[0], choice: pick(q1, 0), cursor: 0 });
          await db.saveQuizChoice(q1.id, { courseId: M, qKey: k[1], choice: pick(q1, 1), cursor: 1 });
          await db.saveSettings({ theme: 'dark' });
          if (db.saveApiKey) await db.saveApiKey('sk-ant-api03-FAKE-t060-old');
          const sel = { quote: { exact: 'Алфа', prefix: '', suffix: '' }, position: { start: 0, end: 4 } };
          const a = await db.createAnnotation({ courseId: M, target: { type: 'lesson', id: by('0001').id }, selector: sel, color: 'yellow' });
          await db.createNote({ annotationId: a.id, body: 'бележка' });
          return { lessons: lessons.length, quizzes: quizzes.length };
        }, M);
        const d = await dump(page);
        expect(d.version).toBe(schema);
      } finally { await stop(); }
      stop = await serve(REPO, old.port);
      try {
        await updateTo(page, old.url, NOW_VERSION);
        await expect.poll(async () => (await dump(page)).version, { timeout: 20000 }).toBe(6);
        await expect(page.locator('#db-error')).toBeHidden();
        const v6 = await dump(page);
        expect(v6.stores.lessons.filter((l) => l.courseId === M)).toHaveLength(before.lessons);
        expect(v6.stores.notes.map((n) => n.body)).toEqual(['бележка']);
        expect(v6.stores.settings.find((s) => s.id === 'settings')?.theme).toBe('dark');
        if (schema >= 4) expect(v6.stores.secrets.find((s) => s.id === 'apiKey')?.value).toBe('sk-ant-api03-FAKE-t060-old');
        expect(seededOf(v6)).toEqual(expectedSeed(v6.stores));
        // The answers were saved "now" (newest), the lessons on 2026-11-18.
        expect(seededOf(v6)[M].map((r) => [r.id.slice(M.length + 1), r.scrollY, r.question])).toEqual([
          ['quiz:0001-1', null, 1], ['reference:R01', 640, null], ['lesson:0001', 1500, null], ['lesson:0002', 0, null],
        ]);
        await page.goto(`${old.url}#/c/${M}`);
        await expect(history(page)).toHaveCount(4, { timeout: 15000 });
        await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
        await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 2 от 6');
        await history(page).filter({ hasText: 'Тест алфа' }).locator('a').click();
        await expect(quizCount(page)).toHaveText('Въпрос 2 от 4 · отговорени 2');
      } finally { await stop(); }
      if (old.own) rmSync(old.dir, { recursive: true, force: true });
    });
  }

  test('T060-M3 a v5 database with a corrupted progress and 70 places in one course: the upgrade does not fail, at most 50 seeded (the newest), nothing else changed', async ({ page }) => {
    await page.goto('./manifest.webmanifest');
    const before = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const v5 = await db.openDb({ name: 'lrn-app', version: 5 });
      const rec = (x) => ({ createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deleted: false, ...x });
      await v5.put('courses', rec({ id: 'BIG', title: 'BIG', meta: {} }));
      for (let i = 1; i <= 70; i++) {
        const n = String(i).padStart(4, '0');
        await v5.put('lessons', rec({ id: `BIG/lesson:${n}`, courseId: 'BIG', kind: 'lesson', number: n, path: `lessons/${n}-a.html`, title: `У${i}`, order: i, progress: { status: 'started', lastOpenedAt: new Date(Date.parse('2026-11-10T00:00:00.000Z') + i * 3600000).toISOString(), scrollY: i } }));
      }
      const bad = [null, {}, { lastOpenedAt: 12345 }, { lastOpenedAt: '2026-11-19T00:00:00.000Z', scrollY: -7 }, { lastOpenedAt: '2026-11-19T01:00:00.000Z', scrollY: 'много' },
        { lastOpenedAt: '2026-11-19T02:00:00.000Z', scrollY: 1e300 }, { lastOpenedAt: '' }, { lastOpenedAt: '2026-13-45' }, { lastOpenedAt: '2026-11-19T03:00:00.000Z', scrollY: Number.NaN }];
      bad.forEach((p, i) => v5.put('lessons', rec({ id: `ODD/lesson:${String(i + 1).padStart(4, '0')}`, courseId: 'ODD', kind: 'lesson', number: String(i + 1).padStart(4, '0'), path: `lessons/x${i}.html`, title: 'x', order: i, progress: p })));
      await v5.put('courses', rec({ id: 'ODD', title: 'ODD', meta: {} }));
      await v5.put('quizzes', rec({ id: 'ODD/quiz:0001-1', courseId: 'ODD', path: 'quizzes/0001-1.json', slug: '0001-1', lesson: '0001', title: 'Q', questions: [{ q: 'a', options: ['Да', 'Не'], answer: 0 }], order: 1 }));
      await v5.put('quizAnswers', rec({ id: 'ODD/quiz:0001-1', courseId: 'ODD', choices: { a: 'Да' }, cursor: 99, updatedAt: '2026-11-19T05:00:00.000Z' }));
      await v5.put('quizAnswers', rec({ id: 'ODD/quiz:0002-1', courseId: 'ODD', choices: null, cursor: 'x', updatedAt: 'нещо' }));
      db.closeDb();
      return true;
    });
    expect(before).toBe(true);
    const v5 = await dump(page);
    await page.goto('./');
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await expect.poll(async () => (await dump(page)).version, { timeout: 15000 }).toBe(6);
    await expect(page.locator('#db-error')).toBeHidden();
    const v6 = await dump(page);
    expect(sameExceptHistory(v5, v6)).toEqual([]);
    const s = seededOf(v6);
    expect(s.BIG).toHaveLength(50);
    expect(s.BIG[0].id).toBe('BIG/lesson:0070');
    expect(s.BIG[49].id).toBe('BIG/lesson:0021');
    expect(s.ODD.map((r) => [r.id, r.scrollY, r.question])).toEqual([
      ['ODD/quiz:0001-1', null, 0],
      ['ODD/lesson:0009', 0, null],
      ['ODD/lesson:0006', 1e300, null], // Information: a finite but absurd scrollY is kept as it is
      ['ODD/lesson:0005', 0, null],
      ['ODD/lesson:0004', 0, null],
    ]);
    await page.goto('./#/c/ODD');
    await expect(course(page).locator('[data-list="activity"] > li')).toHaveCount(5, { timeout: 15000 });
    await page.goto('./#/c/BIG');
    await expect(course(page).locator('[data-list="activity"] > li')).toHaveCount(10, { timeout: 15000 });
  });

  test('T060-M4 a failed upgrade (the index cannot be made): the red message, role=alert, the v5 database stays exactly as it was; the next start without the fault upgrades', async ({ page }) => {
    allowed.push(/IndexedDB/, /Failed to load resource/, /simulated/);
    await page.goto('./manifest.webmanifest');
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const v5 = await db.openDb({ name: 'lrn-app', version: 5 });
      await v5.put('courses', { id: 'F', title: 'F', meta: {}, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deleted: false });
      await v5.put('lessons', { id: 'F/lesson:0001', courseId: 'F', kind: 'lesson', number: '0001', path: 'lessons/0001.html', title: 'F1', order: 1, deleted: false, progress: { status: 'done', lastOpenedAt: '2026-11-19T00:00:00.000Z', scrollY: 12 } });
      await v5.put('secrets', { id: 'apiKey', value: 'sk-ant-FAKE-t060-m4', updatedAt: '2026-11-01T00:00:00.000Z' });
      db.closeDb();
    });
    const before = await dump(page);
    const fault = await page.context().newPage();
    fault.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
    await fault.addInitScript(() => {
      const make = IDBObjectStore.prototype.createIndex;
      IDBObjectStore.prototype.createIndex = function (name, ...rest) {
        if (this.name === 'history') throw new DOMException('simulated failure', 'UnknownError');
        return make.call(this, name, ...rest);
      };
    });
    await fault.goto('./');
    await expect(fault.locator('#db-error')).toBeVisible({ timeout: 15000 });
    await expect(fault.locator('#db-error')).toContainText('Базата не може да се обнови; данните са запазени');
    await expect(fault.locator('#db-error')).toHaveAttribute('role', 'alert');
    await fault.close();
    expect(await dump(page)).toEqual(before);
    await page.goto('./');
    await expect.poll(async () => (await dump(page)).version, { timeout: 15000 }).toBe(6);
    const v6 = await dump(page);
    expect(v6.stores.history.map((r) => [r.id, r.scrollY])).toEqual([['F/lesson:0001', 12]]);
    expect(sameExceptHistory(before, v6)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T060-F: T058-D3 and T058-D4
// ---------------------------------------------------------------------------
test.describe('T060-F fixes T058-D3, T058-D4', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T060-F1 (T058-D3) "Изтрий" in "Други тестове" and on the last quiz of a lesson: the focus is on "Отвори" of the same quiz; Escape keeps all; double "Изтрий" one reset', async ({ page }) => {
    await importCourse(page, C, base({ 'quizzes/bez-urok.json': quiz(undefined, 'Без урок', 2) }));
    await db(page, async (db, C) => {
      for (const q of await db.listQuizzes(C)) {
        const keys = db.questionKeys(q.questions);
        await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[0], choice: 'Да', cursor: 0 });
      }
    }, C);
    await openCourse(page);
    const others = course(page).locator('[data-section="other-quizzes"]');
    const row = qrow(others, 'Без урок');
    await row.locator('[data-field="quiz-reset"]').focus();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('започнат');
    // Information: Escape deletes nothing but does not close the box either (as since T-049).
    test.info().annotations.push({ type: 'T060-I Escape', description: `confirm box open after Escape: ${await row.locator('.quiz__confirm').count()}` });
    if (await row.locator('.quiz__confirm').count()) {
      await row.locator('[data-field="confirm-no"]').focus();
      await page.keyboard.press('Enter');
      await expect(row.locator('[data-field="quiz-reset"]')).toBeFocused();
    }
    await row.locator('[data-field="quiz-reset"]').focus();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row.locator('[data-field="confirm-yes"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(row.getByRole('link', { name: 'Отвори теста „Без урок“' })).toBeFocused();
    // The last quiz of 0001 by a double click on "Изтрий".
    await toggleOf(page, '0001').click();
    const last = qrow(item(page, '0001'), 'Преговор 1');
    await last.locator('[data-field="quiz-reset"]').click();
    await last.locator('[data-field="confirm-yes"]').dblclick();
    await expect(last.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(last.getByRole('link', { name: 'Отвори теста „Преговор 1“' })).toBeFocused();
    await expect(last.locator('.quiz__confirm')).toHaveCount(0);
    await expect(quizLine(page, '0001')).toHaveText('Тестове: започнати Въпроси 1 от 9');
  });

  for (const [w, hgt] of [[320, 640], [360, 800]]) {
    test(`T060-F2 (T058-D4) ${w}×${hgt} at 160 % and 200 %: every lesson unfolded, long titles, history with long titles: no horizontal scroll, nothing sticks out`, async ({ page }) => {
      const long = 'Изключително-дълго-заглавие-без-интервали-за-проверка-на-пренасянето';
      await importCourse(page, C, base({
        'lessons/0002-vtori.html': lessonHtml(`Втори ${long}`),
        'quizzes/0002-1-osnoven.json': quiz('0002', `Основен ${long}`, 3),
        'quizzes/bez-urok.json': quiz(undefined, `Без урок ${long}`, 2),
      }));
      await db(page, async (db, C) => {
        for (const q of await db.listQuizzes(C)) {
          const keys = db.questionKeys(q.questions);
          for (let i = 0; i < q.questions.length; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: 'Да', cursor: i });
        }
        await db.visitPlace({ courseId: C, kind: 'quiz', id: `${C}/quiz:0002-1`, question: 2 });
        await db.visitPlace({ courseId: C, kind: 'lesson', id: `${C}/lesson:0002`, scrollY: 99999 });
      }, C);
      await page.setViewportSize({ width: w, height: hgt });
      for (const scale of ['160%', '200%']) {
        await openCourse(page);
        await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
        const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
        for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
        const r = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const out = [...document.querySelectorAll('[data-screen="course"] *')].filter((e) => {
            if (e.closest('.visually-hidden') || !e.getClientRects().length) return false;
            const b = e.getBoundingClientRect();
            return b.width > 0 && (b.right > vw + 0.5 || b.left < -0.5);
          }).map((e) => `${e.className || e.tagName}:${Math.round(e.getBoundingClientRect().right)}`);
          return { sw: document.documentElement.scrollWidth, vw, out: out.slice(0, 5) };
        });
        expect(r.sw, `${w} ${scale} ${JSON.stringify(r.out)}`).toBeLessThanOrEqual(r.vw);
        expect(r.out, `${w} ${scale}`).toEqual([]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// T060-V: layout, light/dark; the real LRN-CRA
// ---------------------------------------------------------------------------
const SIZES = [[1920, 1200], [1280, 800], [1200, 1920], [800, 1280], [360, 800]];
async function layoutCheck(page, tag) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const side = document.querySelector('.course__side')?.getBoundingClientRect();
    const outSide = side ? [...document.querySelectorAll('[data-list="activity"] *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > side.right + 1 || b.left < side.left - 1); }).length : -1;
    const small = [...document.querySelectorAll('[data-screen="course"] :is(a.activity__link, [data-field="lesson-toggle"], .quiz-list__link, .quiz-list__reset)')]
      .filter((e) => e.getClientRects().length).filter((e) => e.getBoundingClientRect().height < 44).length;
    const lines = [...document.querySelectorAll('[data-field="lesson-quiz-line"]')].filter((e) => e.offsetParent)
      .filter((e) => { const m = e.querySelector('[data-field="lesson-quiz-mark"]').getBoundingClientRect(); return m.width < 1 || m.height < 1; }).length;
    return { sw: document.documentElement.scrollWidth, vw, outSide, small, hiddenMarks: lines };
  }).then((r) => ({ ...r, tag }));
}

test.describe('T060-V layout', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T060-V1 five sizes × light/dark × folded/unfolded: no horizontal scroll, the history stays in its column, targets ≥ 44 px, the mark visible folded', async ({ page }) => {
    test.setTimeout(240_000);
    await importCourse(page, C, base());
    await db(page, async (db, C) => {
      await db.setLessonProgress(`${C}/lesson:0001`, { status: 'done' });
      for (const [id, n] of [['0001-1', 3], ['0002-1', 1]]) {
        const q = await db.getQuiz(`${C}/quiz:${id}`);
        const keys = db.questionKeys(q.questions);
        for (let i = 0; i < n; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: i ? 'Да' : 'Не', cursor: i });
      }
      for (let i = 0; i < 12; i++) await db.visitPlace({ courseId: C, kind: i % 3 ? 'lesson' : 'quiz', id: i % 3 ? `${C}/lesson:000${(i % 4) + 1}` : `${C}/quiz:0004-1`, scrollY: i * 100, question: 7 });
      await db.visitPlace({ courseId: C, kind: 'reference', id: `${C}/reference:R01`, scrollY: 5 });
    }, C);
    for (const theme of ['light', 'dark']) {
      await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
      for (const [w, hgt] of SIZES) {
        await page.setViewportSize({ width: w, height: hgt });
        await openCourse(page);
        let r = await layoutCheck(page, `${theme} ${w}×${hgt} folded`);
        expect(r.sw, r.tag).toBeLessThanOrEqual(r.vw);
        expect(r.outSide, r.tag).toBe(0);
        expect(r.small, r.tag).toBe(0);
        expect(r.hiddenMarks, r.tag).toBe(0);
        const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
        for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
        r = await layoutCheck(page, `${theme} ${w}×${hgt} unfolded`);
        expect(r.sw, r.tag).toBeLessThanOrEqual(r.vw);
        expect(r.outSide, r.tag).toBe(0);
        expect(r.small, r.tag).toBe(0);
        // The next size starts folded again.
        await page.evaluate(() => sessionStorage.clear());
      }
    }
  });

  test('T060-V2 the real LRN-CRA (only with T060_REAL_ZIP): import without notes, the tablet state, the 5 sizes × light/dark, history links go back; re-import "Без промени"', async ({ page }, info) => {
    test.skip(!REAL_ZIP || !existsSync(REAL_ZIP), 'needs T060_REAL_ZIP=<path to LRN-CRA.zip outside the repository>');
    onlyLandscape(info, 'the real course');
    test.setTimeout(300_000);
    const bytes = [...readFileSync(REAL_ZIP)];
    const r = await importBytes(page, 'LRN-CRA.zip', bytes);
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    expect(r.notes || []).toEqual([]);
    const CRA = await db(page, async (db) => (await db.listCourses()).map((c) => c.id).find((id) => /CRA/.test(id)) ?? null) || 'LRN-CRA';
    // The tablet: 0001–0003 marked, 0001-1 all answered (3 wrong), 0002-1 three answered, 0004 opened.
    await db(page, async (db, CRA) => {
      const lessons = await db.listLessons(CRA);
      const id = (n) => lessons.find((l) => l.number === n).id;
      for (const n of ['0001', '0002', '0003']) await db.setLessonProgress(id(n), { status: 'done', lastOpenedAt: '2026-11-19T10:00:00.000Z' });
      await db.setLessonProgress(id('0004'), { status: 'started', lastOpenedAt: '2026-11-20T08:00:00.000Z', scrollY: 2400 });
      const qs = await db.listQuizzes(CRA);
      const answerQ = async (slugStart, n, wrong) => {
        const q = qs.find((x) => x.slug.startsWith(slugStart));
        const keys = db.questionKeys(q.questions);
        for (let i = 0; i < Math.min(n, q.questions.length); i++) {
          const right = q.questions[i].answer;
          await db.saveQuizChoice(q.id, { courseId: CRA, qKey: keys[i], choice: q.questions[i].options[i < wrong ? (right + 1) % q.questions[i].options.length : right], cursor: i });
        }
      };
      await answerQ('0001-1', 99, 3);
      await answerQ('0002-1', 3, 1);
      await db.visitPlace({ courseId: CRA, kind: 'lesson', id: id('0004'), scrollY: 2400 });
    }, CRA);
    await openCourse(page, CRA);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(item(page, '0004')).toHaveAttribute('data-status', 'started');
    await expect(quizMark(page, '0002')).toHaveAttribute('data-state', 'started');
    await expect(quizMark(page, '0005')).toHaveAttribute('data-state', 'new');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText(/^Завършени: 3 от \d+ урока$/);
    const lines = await course(page).locator('[data-field="lesson-quiz-line"]').evaluateAll((ls) => ls.slice(0, 5).map((l) => l.textContent));
    test.info().annotations.push({ type: 'T060-V2 LRN-CRA lines', description: lines.join(' | ') });
    for (const theme of ['light', 'dark']) {
      await db(page, (db, t) => db.saveSettings({ theme: t }), theme);
      for (const [w, hgt] of SIZES) {
        await page.setViewportSize({ width: w, height: hgt });
        await openCourse(page, CRA);
        const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
        for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
        const l = await layoutCheck(page, `CRA ${theme} ${w}×${hgt}`);
        expect(l.sw, l.tag).toBeLessThanOrEqual(l.vw);
        expect(l.outSide, l.tag).toBe(0);
        await page.evaluate(() => sessionStorage.clear());
      }
    }
    await page.setViewportSize({ width: 1920, height: 1200 });
    await openCourse(page, CRA);
    await history(page).first().locator('a').click();
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(2250);
    const again = await importBytes(page, 'LRN-CRA.zip', bytes);
    expect(again.text).toMatch(/Без промени/);
    expect(again.notes || []).toEqual([]);
  });
});
