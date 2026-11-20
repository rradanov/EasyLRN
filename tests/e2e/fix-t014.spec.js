// T-014 (tester): T-061 (0.11.1) attacked from outside.
// - "Продължи/Започни" only to lessons: references only, retired lessons only;
// - T060-D1: a place opened at a fragment and never scrolled is exact after a
//   rotation and another text size (the history keeps the fragment);
// - Escape in every confirmation box, also with the focus on the red button
//   (Settings: delete the API key — a FAKE key; quiz: "Нулирай отговорите");
// - forced colours: the three quiz squares differ in their pixels, not only
//   in their computed style.
// Synthetic data only, fake keys, no network (D-026).
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
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const lessonHtml = (title, body = '<p>Измислен текст.</p>') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const LONG = '<p>Начало.</p><div style="height:4000px"></div><h2 id="sredata">Средата</h2><p>Текст под заглавието, който се пренарежда при друг размер на текста. '.concat('Още думи за пренареждане. '.repeat(200), '</p><div style="height:4000px"></div><p>Край.</p>');
const quiz = (lesson, title, n = 2) => JSON.stringify({ lesson, title, questions: Array.from({ length: n }, (_, i) => ({ q: `${title}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: 0 })) });
const C = 'LRN-F14';
const course = (page) => page.locator('[data-screen="course"]');
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });

test.describe('T014-F "Продължи/Започни" only to lessons', () => {
  test('T014-F1 a course whose lessons are all retired (only references are left) has no "Продължи/Започни", even after a reference was opened', async ({ page }) => {
    const v1 = {
      'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n`,
      'lessons/0001-parvi.html': lessonHtml('Първи'),
      'reference/R01-spravka.html': lessonHtml('Справка'),
    };
    await importCourse(page, C, v1);
    await page.goto(`./#/c/${C}/read/0001`);
    await waitReady(page);
    const v2 = { 'INDEX.md': `# ${C}\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n`, 'reference/R01-spravka.html': lessonHtml('Справка') };
    await importCourse(page, C, v2);
    await page.goto(`./#/c/${C}/read/R01`);
    await waitReady(page);
    await page.goto(`./#/c/${C}`);
    await expect(course(page).locator('[data-section="references"] [data-lesson]')).toHaveCount(1, { timeout: 15000 });
    await expect(course(page).locator('[data-action="continue"]')).toHaveCount(0);
  });
});

test.describe('T014-F T060-D1 exact after rotation and text size', () => {
  test('T014-F2 opened at ?at= in portrait, never scrolled; then landscape and 160 % text: the history link brings the heading to the top of the view', async ({ page }) => {
    await importCourse(page, C, {
      'INDEX.md': `# ${C}\n\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n`,
      'reference/R01-spravka.html': lessonHtml('Справка', LONG),
    });
    await page.setViewportSize({ width: 1200, height: 1920 });
    await page.goto(`./#/c/${C}/read/R01?at=sredata`);
    await waitReady(page);
    await page.waitForTimeout(3000);
    // Rotate and make the text bigger.
    await page.setViewportSize({ width: 1920, height: 1200 });
    await db(page, (db) => db.saveSettings({ fontScale: 1.6 }));
    await page.goto(`./#/c/${C}`);
    const link = course(page).locator('[data-list="activity"] > li a').first();
    await expect(link).toHaveAttribute('href', `#/c/${C}/read/R01?at=sredata`, { timeout: 15000 });
    await link.click();
    await waitReady(page);
    const gap = async () => page.evaluate(async () => {
      const frame = document.querySelector('iframe.lesson-frame');
      const bar = document.querySelector('.app-bar').getBoundingClientRect().height;
      return { frameTop: frame.getBoundingClientRect().top, bar };
    });
    const f = await (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
    await expect.poll(async () => {
      const { frameTop, bar } = await gap();
      const h = await f.evaluate(() => document.getElementById('sredata').getBoundingClientRect().top);
      return Math.round(frameTop + h - bar);
    }, { timeout: 8000 }).toBeLessThan(60);
    const { frameTop, bar } = await gap();
    const h = await f.evaluate(() => document.getElementById('sredata').getBoundingClientRect().top);
    expect(frameTop + h - bar).toBeGreaterThan(-20);
    // The font is really bigger in the lesson.
    expect(await f.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeGreaterThan(20);
  });
});

test.describe('T014-F Escape in confirmation boxes', () => {
  test('T014-F3 Settings "Изтрий" of the API key (a FAKE key): Escape with the focus on the red "Изтрий ключа" keeps the key; the box closes; focus back on "Изтрий"', async ({ page }) => {
    await db(page, (db) => db.saveApiKey('sk-ant-api03-T014FAKEFAKEFAKEFAKEFAKEFAKE'));
    await page.goto('./#/settings');
    const del = page.locator('[data-field="key-delete"]');
    await expect(del).toBeEnabled({ timeout: 10000 });
    await del.click();
    const box = page.getByRole('alertdialog');
    await expect(box).toBeVisible();
    await expect(box.locator('[data-field="confirm-no"]')).toBeFocused();
    await box.locator('[data-field="confirm-yes"]').focus();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(del).toBeFocused();
    expect(await db(page, (db) => db.getApiKey())).toBe('sk-ant-api03-T014FAKEFAKEFAKEFAKEFAKEFAKE');
    // Escape held down (auto-repeat) on a newly opened box: still nothing deleted.
    await del.click();
    await box.locator('[data-field="confirm-yes"]').focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    expect(await db(page, (db) => db.getApiKey())).toBe('sk-ant-api03-T014FAKEFAKEFAKEFAKEFAKEFAKE');
  });

  test('T014-F4 quiz results "Нулирай отговорите": Escape with the focus on "Изтрий" keeps the answers; focus back on the button', async ({ page }) => {
    await importCourse(page, C, {
      'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
      'lessons/0001-parvi.html': lessonHtml('Първи'),
      'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен', 2),
    });
    await page.goto(`./#/c/${C}/quiz/0001-1-osnoven`);
    for (let i = 0; i < 2; i++) {
      await page.locator('.quiz__option[data-option="0"]').click();
      await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
      await page.locator('.quiz__nav button.button--primary').click(); // "Напред", then "Виж резултата"

    }
    const reset = page.locator('.quiz__reset');
    await expect(reset).toBeVisible({ timeout: 5000 });
    await reset.click();
    const box = page.getByRole('alertdialog');
    await expect(box).toBeVisible();
    await box.locator('[data-field="confirm-yes"]').focus();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(page.locator('.quiz__reset')).toBeFocused();
    const n = await db(page, async (db, C) => Object.keys((await db.getQuizAnswers(`${C}/quiz:0001-1`)).choices).length, C);
    expect(n).toBe(2);
  });
});

test.describe('T014-F forced colours', () => {
  test('T014-F5 forced-colors (light and dark): the three quiz squares are different images (pixels), not only different styles', async ({ page }) => {
    const mk = (id, answered, total) => ({
      'INDEX.md': `# ${id}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
      'lessons/0001-parvi.html': lessonHtml('Първи'),
      'quizzes/0001-1-osnoven.json': quiz('0001', 'Основен', total),
      answered,
    });
    const courses = { 'LRN-F14N': mk('LRN-F14N', 0, 2), 'LRN-F14S': mk('LRN-F14S', 1, 2), 'LRN-F14P': mk('LRN-F14P', 2, 2) };
    for (const [id, { answered, ...files }] of Object.entries(courses)) {
      await importCourse(page, id, files);
      await db(page, async (db, { id, answered }) => {
        const q = await db.getQuiz(`${id}/quiz:0001-1`);
        const keys = db.questionKeys(q.questions);
        for (let i = 0; i < answered; i++) await db.saveQuizChoice(q.id, { courseId: id, qKey: keys[i], choice: 'Да', cursor: i });
      }, { id, answered });
    }
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
      const shots = {};
      for (const id of Object.keys(courses)) {
        await page.goto(`./#/c/${id}`);
        const icon = course(page).locator('.quiz-mark__icon').first();
        await expect(icon).toBeVisible({ timeout: 15000 });
        shots[id] = (await icon.screenshot()).toString('base64');
      }
      const v = Object.values(shots);
      expect(new Set(v).size, `${scheme}: three different images`).toBe(3);
    }
  });
});
