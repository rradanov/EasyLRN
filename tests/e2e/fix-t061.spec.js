// T-061 (developer, 0.11.1): fixes after T-060.
// - "Продължи/Започни" goes only to lessons, never to a reference (D-041 addendum);
// - T060-D1: the reader's own jump to a fragment (`?at=`) or to the saved
//   position is not recorded as a scroll of the user: the history keeps the
//   fragment until the user really scrolls;
// - Escape in a confirmation box closes it and does nothing else (T060 И-2);
// - forced colours: the squares "не са започнати" and "започнати" differ by
//   shape, not only by colour (T060 И-1).
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

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

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(toBytes(files), { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return { error: m.errorMessage(err) }; }
  }, { name: f.name, bytes: [...f.buffer] });
}
const lessonHtml = (title, body = '<p>Измислен текст.</p>') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const LONG = '<p>Начало.</p><div style="height:4000px"></div><h2 id="sredata">Средата</h2><div style="height:4000px"></div><p>Край.</p>';
const quiz = (lesson, title, n = 2) => JSON.stringify({ lesson, title, questions: Array.from({ length: n }, (_, i) => ({ q: `${title}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: 0 })) });
const C = 'LRN-T61';
const files = (extra = {}) => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', LONG),
  'lessons/0002-vtori.html': lessonHtml('Втори', LONG),
  'reference/R01-spravka.html': lessonHtml('Справка', LONG),
  'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен 1', 3),
  'quizzes/0002-1-osnoven.json': quiz('0002', 'Основен 2', 2),
  ...extra,
});
const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id = C) {
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-field="activity"] > *')).toHaveCount(1, { timeout: 15000 });
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const place = (page, id) => db(page, async (db, a) => {
  const r = (await db.listHistory(a.C)).find((x) => x.id === `${a.C}/${a.id}`);
  return r ? { scrollY: r.scrollY, anchor: r.anchor } : null;
}, { C, id });
const lessonScroll = (page) => page.evaluate(() => {
  const frame = document.querySelector('iframe.lesson-frame');
  const bar = document.querySelector('.app-bar').getBoundingClientRect().height;
  return Math.round(window.scrollY - (frame.getBoundingClientRect().top + window.scrollY - bar));
});
const item = (page, n) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${n}")`) });

test.describe('T-061 "Продължи/Започни" only to lessons (D-041 addendum)', () => {
  test('T061-C1 a reference opened first: "Започни: урок 0001"; then a lesson and the reference again: "Продължи" to that lesson', async ({ page }) => {
    await importCourse(page, C, files());
    await page.goto(`./#/c/${C}/read/R01`);
    await waitReady(page);
    await openCourse(page);
    const go = course(page).locator('[data-action="continue"]');
    await expect(go).toHaveText(/^Започни: урок 0001 — Първи$/);
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await page.goto(`./#/c/${C}/read/R01`);
    await waitReady(page);
    await openCourse(page);
    await expect(go).toHaveText(/^Продължи: урок 0002 — Втори$/);
    await go.click();
    await expect(page).toHaveURL(/read\/0002$/);
  });

  test('T061-C2 a course with references only has no "Продължи/Започни"', async ({ page }) => {
    await importCourse(page, 'LRN-T61R', {
      'INDEX.md': '# LRN-T61R\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n',
      'reference/R01-spravka.html': lessonHtml('Справка'),
    });
    await page.goto('./#/c/LRN-T61R/read/R01');
    await waitReady(page);
    await page.goto('./#/c/LRN-T61R');
    await expect(course(page).locator('[data-item="LRN-T61R/reference:R01"]')).toBeVisible({ timeout: 15000 });
    await expect(course(page).locator('[data-action="continue"]')).toHaveCount(0);
  });
});

test.describe('T-061 T060-D1: the reader\'s own jump is not a scroll of the user', () => {
  test('T061-D1 opened at ?at= and not touched: the history keeps the fragment; after a real scroll it is pixels', async ({ page }) => {
    await importCourse(page, C, files());
    await page.goto(`./#/c/${C}/read/R01?at=sredata`);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(3500);
    await page.waitForTimeout(2500);
    expect(await place(page, 'reference:R01')).toMatchObject({ anchor: 'sredata' });
    await openCourse(page);
    expect(await course(page).locator('[data-list="activity"] > li a').first().getAttribute('href')).toBe(`#/c/${C}/read/R01?at=sredata`);
    // The user scrolls: now it is a position in pixels.
    await page.goto(`./#/c/${C}/read/R01?at=sredata`);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(3500);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollBy(0, -1500));
    await expect.poll(async () => { const r = await place(page, 'reference:R01'); return r ? r.anchor : 'missing'; }, { timeout: 5000 }).toBe(null);
    const y = (await place(page, 'reference:R01')).scrollY;
    expect(y).toBeGreaterThan(1500);
    expect(y).toBeLessThan(3500);
  });

  test('T061-D2 a link to a heading of another lesson (the jump of the reader) keeps the fragment too', async ({ page }) => {
    await importCourse(page, C, files({ 'lessons/0002-vtori.html': lessonHtml('Втори', '<p><a id="go" href="../reference/R01-spravka.html#sredata">Към средата</a></p>') }));
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await page.frameLocator('iframe.lesson-frame').locator('#go').click();
    await expect(page).toHaveURL(/read\/R01\?at=sredata$/);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(3500);
    await page.waitForTimeout(2000);
    expect(await place(page, 'reference:R01')).toMatchObject({ anchor: 'sredata' });
  });

  test('T061-D3 the saved position: opening at it does not rewrite it; the progress keeps the same value', async ({ page }) => {
    await importCourse(page, C, files());
    await page.goto(`./#/c/${C}/read/0001`);
    await waitReady(page);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(async () => (await place(page, 'lesson:0001'))?.scrollY ?? 0, { timeout: 5000 }).toBeGreaterThan(2000);
    const y = (await place(page, 'lesson:0001')).scrollY;
    await openCourse(page);
    // Back through the history: the same place, the record unchanged.
    await page.goto(`./#/c/${C}/read/0001?y=${y}`);
    await waitReady(page);
    await expect.poll(() => lessonScroll(page), { timeout: 5000 }).toBeGreaterThan(y - 50);
    await page.waitForTimeout(1500);
    expect(await place(page, 'lesson:0001')).toEqual({ scrollY: y, anchor: null });
  });
});

test.describe('T-061 Escape in a confirmation box (T060 И-2)', () => {
  test('T061-E1 course screen "Нулирай": Escape closes the box, the answers stay, the focus is back on "Нулирай"', async ({ page }) => {
    await importCourse(page, C, files());
    await db(page, async (db, C) => {
      const q = await db.getQuiz(`${C}/quiz:0001-1`);
      const keys = db.questionKeys(q.questions);
      await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[0], choice: 'Да', cursor: 0 });
    }, C);
    await openCourse(page);
    await item(page, '0001').locator('[data-field="lesson-toggle"]').click();
    const reset = item(page, '0001').locator('[data-field="quiz-reset"]');
    await reset.click();
    const box = item(page, '0001').getByRole('alertdialog');
    await expect(box).toBeVisible();
    await expect(box.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(reset).toBeFocused();
    const answers = await db(page, async (db, C) => Object.keys((await db.getQuizAnswers(`${C}/quiz:0001-1`)).choices).length, C);
    expect(answers).toBe(1);
    // Escape with the focus on "Изтрий" cancels too.
    await reset.click();
    await box.locator('[data-field="confirm-yes"]').focus();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    expect(await db(page, async (db, C) => Object.keys((await db.getQuizAnswers(`${C}/quiz:0001-1`)).choices).length, C)).toBe(1);
  });

  test('T061-E2 quiz screen "Отначало": Escape closes the box, the answer stays, the focus is back on "Отначало"', async ({ page }) => {
    await importCourse(page, C, files());
    await page.goto(`./#/c/${C}/quiz/0001-1-osnoven`);
    await page.locator('.quiz__option[data-option="0"]').click();
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    await page.locator('[data-field="quiz-restart"]').click();
    const box = page.getByRole('alertdialog');
    await expect(box).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(page.locator('[data-field="quiz-restart"]')).toBeFocused();
    await expect(page.locator('.quiz__count')).toContainText('отговорени 1');
  });
});

test.describe('T-061 forced colours: the quiz squares differ by shape (T060 И-1)', () => {
  test('T061-F1 with forced-colors: active, "не са започнати" (dashed, empty), "започнати" (half), "минати" (full) look different', async ({ page }) => {
    await importCourse(page, C, files());
    await db(page, async (db, C) => {
      const q1 = await db.getQuiz(`${C}/quiz:0001-1`);
      const k1 = db.questionKeys(q1.questions);
      await db.saveQuizChoice(q1.id, { courseId: C, qKey: k1[0], choice: 'Да', cursor: 0 });
      const q2 = await db.getQuiz(`${C}/quiz:0002-1`);
      const k2 = db.questionKeys(q2.questions);
      for (const [i, k] of k2.entries()) await db.saveQuizChoice(q2.id, { courseId: C, qKey: k, choice: 'Да', cursor: i });
    }, C);
    await importCourse(page, 'LRN-T61N', {
      'INDEX.md': '# LRN-T61N\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n',
      'lessons/0001-parvi.html': lessonHtml('Първи'),
      'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен', 2),
    });
    await page.emulateMedia({ forcedColors: 'active' });
    const look = async (id, n) => {
      if (id === C) await openCourse(page); else { await page.goto(`./#/c/${id}`); await expect(course(page).locator('.course-item').first()).toBeVisible({ timeout: 15000 }); }
      return course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${n}")`) })
        .locator('.quiz-mark__icon').evaluate((el) => {
          const s = getComputedStyle(el);
          return { state: el.parentElement.dataset.state, border: s.borderTopStyle, image: s.backgroundImage, color: s.backgroundColor, adjust: s.forcedColorAdjust };
        });
    };
    const started = await look(C, '0001');
    const passed = await look(C, '0002');
    const fresh = await look('LRN-T61N', '0001');
    expect([fresh.state, started.state, passed.state]).toEqual(['new', 'started', 'passed']);
    expect(fresh).toMatchObject({ border: 'dashed', image: 'none', adjust: 'none' });
    expect(started.border).toBe('solid');
    expect(started.image).toContain('gradient');
    expect(passed.border).toBe('solid');
    expect(passed.image).toBe('none');
    expect(passed.color).not.toBe(fresh.color);
  });
});
