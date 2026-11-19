// T-048 (tester): independent checks of the "Тестове" section (T-047, D-032,
// D-033). Not the developer's tests. Synthetic data only (D-026): LRN-DEMO and
// courses built in memory; the real course only through T048_REAL_DIR (outside
// the repository), its screenshots only into T048_SHOTS (outside the repository).
//
// Known defects carry test.fail() and the id from the T-048 log.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();

let problems;
test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
});
test.afterEach(() => { expect(problems).toEqual([]); });

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    const t0 = performance.now();
    const s = await m.importCourse(list);
    return { line: m.describeSummary(s), ms: performance.now() - t0 };
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importCourse = (page, id, files) => importFiles(page, [asFile(`${id}.zip`, makeZip(files, { root: id }))]);
const importDemo = (page, files = FILES) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(files))]);
const json = (o) => strToU8(JSON.stringify(o));
const INDEX = (id, lessons = ['0001']) => strToU8(`# ${id}\n\n## Уроци\n\n| # | Урок | Файл |\n|---|---|---|\n${lessons.map((n) => `| ${n} | Урок ${n} | lessons/${n}-l.html |`).join('\n')}\n`);
const LESSON = (n) => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок ${n}</title></head><body><h1>Урок ${n}</h1><p>Текст.</p></body></html>`);
const Q = (q, answer = 0, options = ['А', 'Б', 'В']) => ({ q, options, answer, why: `Защото ${q}`, src: 'Урок 0001' });

async function openCourse(page, id) {
  await page.goto(`./#/c/${id}`);
  await expect(page.locator('[data-screen="course"]')).toBeVisible();
}
async function openQuiz(page, id, slug) {
  await page.goto(`./#/c/${id}/quiz/${encodeURIComponent(slug)}`);
  await expect(page.locator('[data-screen="quiz"] .quiz__question, [data-screen="quiz"] [data-field="quiz-result"]').first()).toBeVisible();
}
const counter = (page) => page.locator('.quiz__count');
const pick = (page, i) => page.locator(`.quiz__option[data-option="${i}"]`).click();
const next = (page) => page.getByRole('button', { name: 'Напред' }).click();
const back = (page) => page.getByRole('button', { name: 'Назад' }).click();
const status = (page, quizId) => page.locator(`[data-list="quizzes"] [data-quiz="${quizId}"] [data-field="quiz-status"]`);

// A 3-question course used by most tests.
const BASIC = (extra = {}) => ({
  'INDEX.md': INDEX('LRN-Q'),
  'lessons/0001-l.html': LESSON('0001'),
  'quizzes/0001-a.json': json({ lesson: '0001', title: 'Тест А', questions: [Q('Едно?', 0), Q('Две?', 1), Q('Три?', 2)] }),
  ...extra,
});

test.describe('T-048 validation of quizzes/*.json', () => {
  test('bad files are skipped, bad questions dropped, missing optional fields defaulted; the app keeps working', async ({ page }) => {
    const r = await importCourse(page, 'LRN-V', {
      'INDEX.md': INDEX('LRN-V'),
      'lessons/0001-l.html': LESSON('0001'),
      'quizzes/empty.json': json({ lesson: '0001', title: 'Празен', questions: [] }),
      'quizzes/noquestions.json': json({ lesson: '0001', title: 'Без поле' }),
      'quizzes/notarray.json': json({ lesson: '0001', title: 'Не масив', questions: { 0: Q('x') } }),
      'quizzes/badjson.json': strToU8('{ "title": "счупен", '),
      'quizzes/array.json': json([Q('x')]),
      'quizzes/null.json': strToU8('null'),
      'quizzes/badidx.json': json({ lesson: '0001', title: 'Индекси', questions: [
        Q('минус?', -1), Q('голям?', 3), Q('низ?', '0'), Q('дробен?', 1.5), { q: 'липсва?', options: ['а', 'б'] }, Q('null?', null), Q('добър?', 2),
      ] }),
      'quizzes/fields.json': json({ lesson: '0001', title: 'Полета', questions: [
        { options: ['а', 'б'], answer: 0 }, // no q
        { q: '   ', options: ['а', 'б'], answer: 0 }, // blank q
        { q: 'без опции?', answer: 0 },
        { q: 'една опция?', options: ['а'], answer: 0 },
        { q: 'без why и src?', options: ['а', 'б'], answer: 1 },
        null, 7, 'низ',
      ] }),
      'quizzes/notitle.json': json({ lesson: '0001', questions: [Q('без заглавие?')] }),
      'quizzes/nolesson.json': json({ title: 'Без урок', questions: [Q('без урок?')] }),
      'quizzes/proto.json': strToU8('{"__proto__":{"polluted":1},"lesson":"0001","title":"Прото","questions":[{"__proto__":{"q":"скрит"},"q":"прото?","options":["а","б"],"answer":0,"constructor":1}]}'),
    });
    console.log(`T-048 validation import: ${JSON.stringify(r)}`);
    expect(await page.evaluate(() => ({}).polluted)).toBeUndefined();
    const quizzes = await page.evaluate(async () => (await (await import('./src/db.js')).listQuizzes('LRN-V'))
      .map((q) => ({ slug: q.slug, title: q.title, lesson: q.lesson, qs: q.questions.map((x) => x.q) })));
    const bySlug = Object.fromEntries(quizzes.map((q) => [q.slug, q]));
    for (const bad of ['empty', 'noquestions', 'notarray', 'badjson', 'array', 'null']) expect(bySlug[bad], bad).toBeUndefined();
    expect(bySlug.badidx.qs).toEqual(['добър?']);
    expect(bySlug.fields.qs).toEqual(['без why и src?']);
    expect(bySlug.notitle.title).toBe('notitle');
    expect(bySlug.nolesson.lesson).toBeNull();
    expect(bySlug.proto.qs).toEqual(['прото?']);

    await openCourse(page, 'LRN-V');
    await expect(page.locator('[data-list="quizzes"] [data-quiz]')).toHaveCount(5);
    // A quiz without a lesson is listed in the course, not under any lesson.
    await page.goto('./#/c/LRN-V/read/0001');
    await expect(page.locator('[data-field="lesson-quizzes"] a.quiz-list__link')).toHaveCount(4);
    await expect(page.locator('[data-field="lesson-quizzes"]')).not.toContainText('Без урок');
    // A question without why/src: feedback without the empty lines.
    await openQuiz(page, 'LRN-V', 'fields');
    await pick(page, 1);
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    await expect(page.locator('.quiz__why')).toHaveCount(0);
    await expect(page.locator('.quiz__src')).toHaveCount(0);
    // An unknown quiz slug → a clear message, no error.
    await page.goto('./#/c/LRN-V/quiz/няма-такъв');
    await expect(page.locator('[data-field="quiz-missing"]')).toHaveText('Тестът не е намерен. Импортирай курса отново.');
  });

  test('[T048-D2] a non-string option is dropped and the answer index then points to another option', async ({ page }) => {
    await importCourse(page, 'LRN-SHIFT', {
      'INDEX.md': INDEX('LRN-SHIFT'),
      'lessons/0001-l.html': LESSON('0001'),
      // The author meant option 2 ("вярно"); 42 is not a string and is filtered out.
      'quizzes/shift.json': json({ lesson: '0001', title: 'Изместване', questions: [{ q: 'Кое е вярно?', options: ['грешно', 42, 'вярно', 'друго'], answer: 2 }, Q('друг?')] }),
    });
    const qs = await page.evaluate(async () => (await (await import('./src/db.js')).listQuizzes('LRN-SHIFT'))[0].questions);
    // Expected: the question is dropped (bad shape) or kept with "вярно" as the answer — never another option.
    const shifted = qs.find((q) => q.q === 'Кое е вярно?');
    if (shifted) expect(shifted.options[shifted.answer]).toBe('вярно');
  });

  test('a huge file (≈36 MB, 40 000 questions) and very long texts: imported within limits, the UI does not overflow', async ({ page }) => {
    test.setTimeout(120_000);
    const word = 'дълга дума '.repeat(600); // long, with spaces (unbroken strings: T048-D4)
    const many = Array.from({ length: 40000 }, (_, i) => Q(`Въпрос ${i} ${'xy '.repeat(133)}`, i % 3));
    const r = await importCourse(page, 'LRN-BIG', {
      'INDEX.md': INDEX('LRN-BIG'),
      'lessons/0001-l.html': LESSON('0001'),
      'quizzes/huge.json': json({ lesson: '0001', title: 'Огромен', questions: many }),
      'quizzes/long.json': json({ lesson: '0001', title: 'Дълго заглавие '.repeat(150), questions: [
        { q: `${word} ${'дълъг въпрос '.repeat(800)}`, options: [word, 'кратка', 'о '.repeat(1500)], answer: 1, why: word + ' обяснение '.repeat(900), src: word },
      ] }),
      'quizzes/manyopts.json': json({ lesson: '0001', title: 'Много опции', questions: [{ q: '50 опции?', options: Array.from({ length: 50 }, (_, i) => `о${i}`), answer: 3 }] }),
    });
    console.log(`T-048 huge import: ${JSON.stringify(r)} (zip ${'≈'}36 MB quiz file)`);
    expect(r.ms).toBeLessThan(60_000);
    const info = await page.evaluate(async () => {
      const qs = await (await import('./src/db.js')).listQuizzes('LRN-BIG');
      return Object.fromEntries(qs.map((q) => [q.slug, { n: q.questions.length, title: q.title.length, q0: q.questions[0].q.length, o: q.questions[0].options.length, why: q.questions[0].why.length }]));
    });
    console.log(`T-048 limits: ${JSON.stringify(info)}`);
    expect(info.huge.n).toBeLessThanOrEqual(500);
    expect(info.long.title).toBeLessThanOrEqual(300);
    expect(info.long.q0).toBeLessThanOrEqual(4000);
    expect(info.manyopts.o).toBeLessThanOrEqual(20);

    for (const slug of ['long', 'huge']) {
      const t0 = Date.now();
      await openQuiz(page, 'LRN-BIG', slug);
      expect(Date.now() - t0).toBeLessThan(5000);
      await pick(page, 1);
      await expect(page.locator('.quiz__verdict')).toBeVisible();
      const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        wide: [...document.querySelectorAll('[data-screen="quiz"] *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length }));
      expect(overflow, slug).toEqual({ doc: 0, wide: 0 });
    }
    await openCourse(page, 'LRN-BIG');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
});

test('[T048-D4] a long unbroken string (a URL in "src", a long word in an option or the title) widens the page: horizontal scroll', async ({ page }) => {
  const url = `https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:32024R2847&from=EN#${'d1e'.repeat(60)}`; // ≈ 250 characters
  await importCourse(page, 'LRN-URL', {
    'INDEX.md': INDEX('LRN-URL'),
    'lessons/0001-l.html': LESSON('0001'),
    'quizzes/url.json': json({ lesson: '0001', title: 'Източници', questions: [{ q: 'Къде пише?', options: [url, 'Другаде'], answer: 0, why: `Виж ${url}`, src: url }] }),
  });
  await openQuiz(page, 'LRN-URL', 'url');
  await pick(page, 0);
  const r = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll('[data-screen="quiz"] *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.className) }));
  console.log(`T-048 D4 overflow: ${JSON.stringify(r)}`);
  expect(r.doc).toBe(0);
});

test('T-048 a quiz file over the 50 MB file limit: a clear message, nothing half-imported, the app keeps working', async ({ page }) => {
  test.setTimeout(120_000);
  const big = json({ lesson: '0001', title: 'Над лимита', questions: Array.from({ length: 70000 }, (_, i) => Q(`Въпрос ${i} ${'x'.repeat(400)}`)) });
  expect(big.length).toBeGreaterThan(50 * 1024 * 1024);
  const err = await importCourse(page, 'LRN-OVER', { 'INDEX.md': INDEX('LRN-OVER'), 'lessons/0001-l.html': LESSON('0001'), 'quizzes/over.json': big })
    .then(() => null, (e) => String(e.message));
  console.log(`T-048 over the limit: ${err}`);
  expect(err).toContain('твърде голям');
  expect(await page.evaluate(async () => (await (await import('./src/db.js')).getCourse('LRN-OVER')) ?? null)).toBeNull();
  await page.goto('./#/');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
});

test.describe('T-048 HTML/script in quiz texts is never run nor rendered (quizzes are outside the isolation)', () => {
  test('every field, the title and the file name show as plain text in the course, the reader, the quiz and the result', async ({ page }) => {
    const x = (n) => `<img src=x onerror="window.__xss=(window.__xss||[]).concat('${n}')"><script>window.__xss=['${n}-script']</script><b>жирно</b><a href="javascript:window.__xss=1">линк</a>`;
    const evil = 'quizzes/<svg onload=window.__xss=1>.json';
    await importCourse(page, 'LRN-XSS', {
      'INDEX.md': INDEX('LRN-XSS'),
      'lessons/0001-l.html': LESSON('0001'),
      'quizzes/xss.json': json({ lesson: '0001', title: x('title'), questions: [
        { q: x('q'), options: [x('o0'), x('o1'), '<iframe srcdoc="<script>parent.__xss=1</script>">'], answer: 1, why: x('why'), src: 'javascript:window.__xss=1' },
        { q: '<style>body{display:none}</style>Стил?', options: ['<style>*{color:red}</style>', '&lt;b&gt;'], answer: 0, why: '<math><mi xlink:href="javascript:1">x</mi></math>', src: 'data:text/html,<script>1</script>' },
      ] }),
      [evil]: json({ lesson: '0001', questions: [Q('файл?')] }),
    });
    const noMarkup = async (where) => {
      const r = await page.evaluate(() => ({
        xss: window.__xss,
        tags: document.querySelectorAll('main img, main b, main svg, main iframe:not(.lesson-frame), main math, main style, main a[href^="javascript"], main a[href^="data"], main script').length,
        bodyVisible: getComputedStyle(document.body).display !== 'none',
      }));
      expect(r, where).toEqual({ xss: undefined, tags: 0, bodyVisible: true });
    };
    await openCourse(page, 'LRN-XSS');
    await expect(page.locator('[data-list="quizzes"]')).toContainText('<b>жирно</b>');
    await expect(page.locator('[data-list="quizzes"]')).toContainText('<svg onload=window.__xss=1>');
    await noMarkup('course');
    await page.goto('./#/c/LRN-XSS/read/0001');
    await expect(page.locator('[data-field="lesson-quizzes"] a.quiz-list__link')).toHaveCount(2);
    await noMarkup('reader');
    await openQuiz(page, 'LRN-XSS', 'xss');
    await expect(page.locator('.quiz__question')).toContainText('<script>');
    await expect(page.locator('.quiz__option').nth(2)).toContainText('<iframe srcdoc=');
    await pick(page, 0);
    await expect(page.locator('.quiz__why')).toContainText('<img src=x onerror=');
    await expect(page.locator('.quiz__src')).toHaveText('Източник: javascript:window.__xss=1');
    await noMarkup('feedback');
    await next(page);
    await expect(page.locator('.quiz__question')).toHaveText('<style>body{display:none}</style>Стил?');
    await expect(page.locator('.quiz__option').nth(1)).toContainText('&lt;b&gt;');
    await pick(page, 1);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__wrong-link').first()).toContainText('<img src=x');
    await noMarkup('result');
    // The file-name quiz opens by its (encoded) slug.
    await page.goto('./#/c/LRN-XSS');
    await page.locator('[data-list="quizzes"] a', { hasText: '<svg' }).click();
    await expect(page.locator('.quiz__question')).toHaveText('файл?');
    await noMarkup('file-name quiz');
    // The page title / app bar.
    expect(await page.evaluate(() => document.querySelectorAll('header img, header b, header svg:not([aria-hidden])').length)).toBe(0);
  });
});

test.describe('T-048 the quiz screen', () => {
  test('one question per screen, Back/Next, progress, immediate feedback, options locked after the answer, result', async ({ page }) => {
    await importCourse(page, 'LRN-Q', BASIC());
    await openCourse(page, 'LRN-Q');
    await expect(status(page, 'LRN-Q/quizzes/0001-a.json')).toHaveText('не е започнат');
    await page.locator('[data-list="quizzes"] a.quiz-list__link').first().click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await expect(page.getByRole('button', { name: 'Назад' })).toBeDisabled();
    await expect(page.locator('.quiz__question')).toHaveCount(1);
    await expect(page.locator('.quiz__verdict')).toHaveCount(0); // no feedback before the answer
    await pick(page, 0);
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    await expect(page.locator('.quiz__why')).toHaveText('Защото Едно?');
    await expect(page.locator('.quiz__src')).toHaveText('Източник: Урок 0001');
    await expect(page.locator('.quiz__option[data-option="1"]')).toBeDisabled();
    expect(await page.locator('.quiz__bar-fill').evaluate((e) => e.style.width)).toBe('33%');
    await next(page);
    await expect(counter(page)).toHaveText('Въпрос 2 от 3 · отговорени 1');
    await pick(page, 0); // wrong (answer 1)
    await expect(page.locator('.quiz__verdict')).toHaveText('Грешно');
    // D-036 (T-049): only the chosen option is marked; the right one is named in the feedback.
    await expect(page.locator('.quiz__option--correct')).toHaveCount(0);
    await expect(page.locator('.quiz__option--wrong')).toContainText('А');
    await expect(page.locator('.quiz__right')).toHaveText('Верен отговор: Б');
    await back(page);
    await expect(page.locator('.quiz__question')).toHaveText('Едно?');
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно'); // kept
    await next(page); await next(page);
    await expect(page.getByRole('button', { name: 'Напред' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Виж резултата' }).click(); // 1 unanswered
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 3 верни');
    await expect(page.locator('[data-field="quiz-result"]')).toContainText('Без отговор: 1');
    await openCourse(page, 'LRN-Q');
    await expect(status(page, 'LRN-Q/quizzes/0001-a.json')).not.toHaveText('не е започнат');
    console.log(`T-048 status after 2 of 3: ${await status(page, 'LRN-Q/quizzes/0001-a.json').textContent()}`);
  });

  test('"Опитай пак грешните" asks only the wrong ones and keeps the right ones; "Нулирай" needs a confirmation, "Отказ" keeps everything', async ({ page }) => {
    await importCourse(page, 'LRN-Q', BASIC());
    await openQuiz(page, 'LRN-Q', '0001-a');
    await pick(page, 1); await next(page); // wrong
    await pick(page, 1); await next(page); // right
    await pick(page, 0); // wrong
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 3 верни');
    await expect(page.locator('.quiz__wrong-link')).toHaveText(['Едно?', 'Три?']);
    await page.getByRole('button', { name: 'Опитай пак грешните' }).click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 2 · отговорени 0');
    await expect(page.locator('.quiz__question')).toHaveText('Едно?');
    await pick(page, 0); await next(page);
    await expect(page.locator('.quiz__question')).toHaveText('Три?');
    await pick(page, 2);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 3 от 3 верни');
    await expect(page.locator('.quiz__all-correct')).toBeVisible();
    // Reset: cancel first.
    await page.getByRole('button', { name: 'Нулирай отговорите' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Отказ' }).click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 3 от 3 верни');
    await page.reload();
    await expect(page.locator('[data-screen="quiz"]')).toBeVisible();
    await openCourse(page, 'LRN-Q');
    await expect(status(page, 'LRN-Q/quizzes/0001-a.json')).toContainText('3 от 3');
    // Reset: confirm.
    await openQuiz(page, 'LRN-Q', '0001-a');
    await page.goto('./#/c/LRN-Q/quiz/0001-a');
    for (let i = 0; i < 2; i++) if (await page.getByRole('button', { name: 'Напред' }).count()) await next(page);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await page.getByRole('button', { name: 'Нулирай отговорите' }).click();
    await page.getByRole('button', { name: 'Изтрий' }).click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await openCourse(page, 'LRN-Q');
    await expect(status(page, 'LRN-Q/quizzes/0001-a.json')).toHaveText('не е започнат');
  });

  test('answers and position survive leaving, reloading, an immediate reload after a tap, and offline', async ({ page, context }) => {
    await importCourse(page, 'LRN-Q', BASIC());
    await openQuiz(page, 'LRN-Q', '0001-a');
    await pick(page, 0); await next(page);
    await pick(page, 0);
    await page.goto('./#/c/LRN-Q'); // leave
    await openQuiz(page, 'LRN-Q', '0001-a');
    await expect(counter(page)).toHaveText('Въпрос 2 от 3 · отговорени 2');
    await expect(page.locator('.quiz__verdict')).toHaveText('Грешно');
    // Tap and reload (the save is asynchronous; a person needs > 300 ms to reload).
    await next(page);
    await pick(page, 2);
    await page.waitForTimeout(300);
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 3 от 3 · отговорени 3');
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    // Offline.
    await context.setOffline(true);
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 3 от 3 · отговорени 3');
    await back(page);
    await expect(page.locator('.quiz__verdict')).toHaveText('Грешно');
    await page.goto('./#/c/LRN-Q');
    await expect(status(page, 'LRN-Q/quizzes/0001-a.json')).toHaveText('резултат: 2 от 3 верни');
    await context.setOffline(false);
  });
});

test('T-048 note: a tap followed by a reload within ~0 ms can lose that one answer (measured, not a criterion)', async ({ page }) => {
  await importCourse(page, 'LRN-Q', BASIC());
  const lost = [];
  for (const delay of [0, 50, 150]) {
    await page.evaluate(async () => (await import('./src/db.js')).resetQuizAnswers('LRN-Q/quizzes/0001-a.json'));
    await openQuiz(page, 'LRN-Q', '0001-a');
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 0');
    await pick(page, 0);
    if (delay) await page.waitForTimeout(delay);
    await page.reload();
    await expect(counter(page)).toBeVisible();
    lost.push(`${delay} ms: ${(await counter(page).textContent()).endsWith('0') ? 'lost' : 'kept'}`);
  }
  console.log(`T-048 tap → reload: ${lost.join(', ')}`);
  expect(lost.slice(1)).toEqual(['50 ms: kept', '150 ms: kept']);
});

test.describe('T-048 re-import and several quizzes per lesson', () => {
  test('re-import: unchanged questions keep the answer, a changed text is reset, a new question is open, a removed one is gone', async ({ page }) => {
    await importCourse(page, 'LRN-Q', BASIC());
    await openQuiz(page, 'LRN-Q', '0001-a');
    await pick(page, 0); await next(page); await pick(page, 1); await next(page); await pick(page, 2);
    const r = await importCourse(page, 'LRN-Q', BASIC({
      'quizzes/0001-a.json': json({ lesson: '0001', title: 'Тест А', questions: [Q('Едно?', 0), Q('Две — ново?', 1), Q('Четири?', 0)] }),
    }));
    console.log(`T-048 re-import: ${r.line}`);
    expect(r.line).toContain('отговорите на тестовете са запазени');
    await openCourse(page, 'LRN-Q');
    await expect(status(page, 'LRN-Q/quizzes/0001-a.json')).toContainText('1 от 3');
    await openQuiz(page, 'LRN-Q', '0001-a');
    await page.goto('./#/c/LRN-Q/quiz/0001-a');
    while (await page.locator('.quiz__question').textContent() !== 'Едно?') await back(page);
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    await next(page);
    await expect(page.locator('.quiz__verdict')).toHaveCount(0);
    await next(page);
    await expect(page.locator('.quiz__question')).toHaveText('Четири?');
    await expect(page.locator('.quiz__verdict')).toHaveCount(0);
    // The same ZIP again: nothing changes, answers stay.
    const same = await importCourse(page, 'LRN-Q', BASIC({
      'quizzes/0001-a.json': json({ lesson: '0001', title: 'Тест А', questions: [Q('Едно?', 0), Q('Две — ново?', 1), Q('Четири?', 0)] }),
    }));
    expect(same.line).toContain('Без промени');
  });

  test('[T048-D1] re-import with the same question text but reordered options / another answer: the choice follows the option text; another answer resets it', async ({ page }) => {
    await importCourse(page, 'LRN-Q', BASIC());
    await openQuiz(page, 'LRN-Q', '0001-a');
    await pick(page, 0); // "А", right
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    // lrn-teach regenerates the quiz: same question, options shuffled ("А" is now option 2).
    await importCourse(page, 'LRN-Q', BASIC({
      'quizzes/0001-a.json': json({ lesson: '0001', title: 'Тест А', questions: [Q('Едно?', 2, ['В', 'Б', 'А']), Q('Две?', 1), Q('Три?', 2)] }),
    }));
    await page.goto('./#/c/LRN-Q/quiz/0001-a');
    await expect(page.locator('.quiz__question')).toHaveText('Едно?');
    // T-048-fix (orchestrator): answers are kept by content — the choice "А" follows
    // the text to its new place and the verdict is computed against the new answer.
    await expect(page.locator('.quiz__verdict')).toHaveText('Вярно');
    await expect(page.locator('.quiz__option--correct')).toContainText('А');
    // Another right answer (same options) = a changed question: reset.
    await importCourse(page, 'LRN-Q', BASIC({
      'quizzes/0001-a.json': json({ lesson: '0001', title: 'Тест А', questions: [Q('Едно?', 1, ['В', 'Б', 'А']), Q('Две?', 1), Q('Три?', 2)] }),
    }));
    await page.goto('./#/c/LRN-Q');
    await page.goto('./#/c/LRN-Q/quiz/0001-a');
    await expect(page.locator('.quiz__question')).toHaveText('Едно?');
    await expect(page.locator('.quiz__verdict')).toHaveCount(0);
  });

  test('[T048-D3] two questions with the same text in one quiz share one answer', async ({ page }) => {
    await importCourse(page, 'LRN-Q', BASIC({
      'quizzes/0001-a.json': json({ lesson: '0001', title: 'Тест А', questions: [Q('Вярно ли е?', 0, ['Да', 'Не']), Q('Вярно ли е?', 1, ['Да', 'Не'])] }),
    }));
    await openQuiz(page, 'LRN-Q', '0001-a');
    await pick(page, 0);
    await next(page);
    await expect(counter(page)).toHaveText('Въпрос 2 от 2 · отговорени 1');
  });

  test('several quizzes for one lesson: "Тестове към урока" lists only that lesson\'s quizzes; each has its own status and answers', async ({ page }) => {
    await importCourse(page, 'LRN-M', {
      'INDEX.md': INDEX('LRN-M', ['0001', '0002']),
      'lessons/0001-l.html': LESSON('0001'),
      'lessons/0002-l.html': LESSON('0002'),
      'quizzes/0001-1-a.json': json({ lesson: '0001', title: 'Първи', questions: [Q('П1?'), Q('П2?')] }),
      'quizzes/0001-2-b.json': json({ lesson: '0001', title: 'Втори', questions: [Q('В1?')] }),
      'quizzes/0002-1-c.json': json({ lesson: '0002', title: 'Трети', questions: [Q('Т1?')] }),
      'quizzes/0001-3-n.json': json({ lesson: 1, title: 'Число', questions: [Q('Ч1?')] }),
    });
    await page.goto('./#/c/LRN-M/read/0001');
    const box = page.locator('[data-field="lesson-quizzes"]');
    await expect(box.locator('h3')).toHaveText('Тестове към урока');
    console.log(`T-048 lesson 0001 quizzes: ${JSON.stringify(await box.locator('a').allTextContents())} (one has "lesson": 1 as a number)`);
    await expect(box.locator('a', { hasText: 'Първи' })).toHaveCount(1);
    await expect(box.locator('a', { hasText: 'Втори' })).toHaveCount(1);
    await expect(box.locator('a', { hasText: 'Трети' })).toHaveCount(0);
    await expect(box.locator('a', { hasText: 'Число' })).toHaveCount(1); // T-048 Н-4 fixed: "lesson": 1 → "0001"
    await box.locator('a', { hasText: 'Втори' }).click();
    await pick(page, 0);
    await page.goto('./#/c/LRN-M/read/0002');
    await expect(page.locator('[data-field="lesson-quizzes"] h3')).toHaveText('Тест към урока');
    await expect(page.locator('[data-field="lesson-quizzes"] a')).toHaveText(['Трети']);
    await openCourse(page, 'LRN-M');
    await expect(status(page, 'LRN-M/quizzes/0001-1-a.json')).toHaveText('не е започнат');
    await expect(status(page, 'LRN-M/quizzes/0002-1-c.json')).toHaveText('не е започнат');
    await expect(status(page, 'LRN-M/quizzes/0001-2-b.json')).toContainText('1 от 1');
    console.log(`T-048 statuses: ${JSON.stringify(await page.locator('[data-list="quizzes"] li').allTextContents())}`);
  });
});

test.describe('T-048 layout: screenshots, light/dark, touch targets ≥ 44 px', () => {
  for (const scheme of ['light', 'dark']) {
    test(`LRN-DEMO (${scheme}): course, reader links, question, feedback, result; every target ≥ 44 px`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await importDemo(page);
      const dir = process.env.T048_SHOTS_DEMO;
      if (dir) mkdirSync(dir, { recursive: true });
      const vp = page.viewportSize();
      const shot = async (name) => { if (dir) await page.screenshot({ path: join(dir, `${vp.width}x${vp.height}-${scheme}-${name}.png`), fullPage: false }); };
      const small = async (where) => {
        const list = await page.evaluate(() => [...document.querySelectorAll('main button, main a, main [role="button"]')]
          .filter((e) => e.offsetParent !== null)
          .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; })
          .filter((r) => r.w < 44 || r.h < 44));
        expect(list, where).toEqual([]);
      };
      await openCourse(page, 'LRN-DEMO');
      await page.locator('[data-list="quizzes"]').scrollIntoViewIfNeeded();
      await shot('course');
      const quizLinks = await page.evaluate(() => [...document.querySelectorAll('[data-list="quizzes"] a')].map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(Math.min(...quizLinks)).toBeGreaterThanOrEqual(44);
      await page.goto('./#/c/LRN-DEMO/read/0001');
      await expect(page.locator('[data-field="lesson-quizzes"] a')).toHaveCount(2);
      await page.locator('[data-field="lesson-quizzes"]').scrollIntoViewIfNeeded();
      await shot('reader');
      const readerLinks = await page.evaluate(() => [...document.querySelectorAll('[data-field="lesson-quizzes"] a')].map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(Math.min(...readerLinks), 'reader quiz links').toBeGreaterThanOrEqual(44);
      await page.locator('[data-field="lesson-quizzes"] a').first().click();
      await expect(counter(page)).toBeVisible();
      await shot('question');
      await small('question');
      await pick(page, 1);
      await shot('feedback');
      await small('feedback');
      while (await page.getByRole('button', { name: 'Напред' }).count()) await next(page);
      await page.getByRole('button', { name: 'Виж резултата' }).click();
      await shot('result');
      await small('result');
      await page.getByRole('button', { name: 'Нулирай отговорите' }).click();
      await shot('confirm');
      await small('confirm');
      // Contrast sanity in dark: the text is not dark on dark.
      const colors = await page.evaluate(() => ({ fg: getComputedStyle(document.querySelector('.quiz__confirm p')).color, bg: getComputedStyle(document.body).backgroundColor }));
      console.log(`T-048 ${info.project.name} ${scheme} colors: ${JSON.stringify(colors)}`);
    });
  }
});

test.describe('T-048 real course (T048_REAL_DIR, outside the repository)', () => {
  test('both quizzes of 0001 (9 + 4 questions): course section, reader, a full run, result; screenshots only outside the repo', async ({ page }) => {
    const dir = process.env.T048_REAL_DIR;
    test.skip(!dir || !existsSync(dir), 'needs T048_REAL_DIR');
    test.setTimeout(90_000);
    const shots = process.env.T048_SHOTS;
    const real = readFixture(dir);
    await importFiles(page, [asFile('LRN-CRA.zip', makeZip(real, { root: 'LRN-CRA' }))]);
    const courseId = await page.evaluate(async () => (await (await import('./src/db.js')).listCourses()).map((c) => c.id).find((id) => /CRA/i.test(id)));
    const quizzes = await page.evaluate(async (id) => (await (await import('./src/db.js')).listQuizzes(id)).map((q) => ({ slug: q.slug, lesson: q.lesson, n: q.questions.length, title: q.title })), courseId);
    console.log(`T-048 real quizzes: ${JSON.stringify(quizzes)}`);
    expect(quizzes.map((q) => [q.slug, q.lesson, q.n])).toEqual([['0001-1-obhvat', '0001', 9], ['0001-2-srokove', '0001', 4]]);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      const vp = page.viewportSize();
      const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${vp.width}x${vp.height}-${scheme}-${name}.png`) }); } };
      await openCourse(page, courseId);
      await page.locator('[data-list="quizzes"]').scrollIntoViewIfNeeded();
      await shot('course');
      await page.goto(`./#/c/${courseId}/read/0001`);
      await expect(page.locator('[data-field="lesson-quizzes"] a')).toHaveCount(2);
      await page.locator('[data-field="lesson-quizzes"]').scrollIntoViewIfNeeded();
      await shot('reader');
      if (scheme === 'dark') break;
      for (const q of quizzes) {
        await page.goto(`./#/c/${courseId}/quiz/${q.slug}`);
        for (let i = 0; i < q.n; i++) {
          await pick(page, i % 2);
          await expect(page.locator('.quiz__verdict')).toBeVisible();
          if (i === 0) await shot(`${q.slug}-feedback`);
          if (i < q.n - 1) await next(page);
        }
        await page.getByRole('button', { name: 'Виж резултата' }).click();
        await shot(`${q.slug}-result`);
        console.log(`T-048 real ${q.slug}: ${await page.locator('.quiz__score').textContent()}`);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await openCourse(page, courseId);
    console.log(`T-048 real statuses: ${JSON.stringify(await page.locator('[data-list="quizzes"] li').allTextContents())}`);
    await expect(page.locator('[data-list="quizzes"] [data-field="quiz-status"]').first()).toContainText('от 9');
  });
});
