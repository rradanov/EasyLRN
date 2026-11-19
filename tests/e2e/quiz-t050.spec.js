// T-050 (tester): independent checks of T-049 (D-035, D-036) and of the
// T-048-fix answers by content (T048-D1…D4), with my own inputs. Synthetic
// data only (in-memory courses and LRN-DEMO, D-026). The real course only
// through T050_REAL_DIR; screenshots only into T050_SHOTS (real course) and
// T050_SHOTS_DEMO (LRN-DEMO), both outside the repository.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

// D-040 (T-057): the quizzes are under their lesson, behind the arrow: unfold every lesson.
async function unfoldLessons(page) {
  await expect(page.locator('[data-screen="course"] [data-section="activity"]')).toBeVisible({ timeout: 15000 });
  const closed = page.locator('[data-field="lesson-toggle"][aria-expanded="false"]');
  for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
}

let problems;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
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
const json = (o) => strToU8(JSON.stringify(o));
const INDEX = (id) => strToU8(`# ${id}\n\n## Уроци\n\n| # | Урок | Файл |\n|---|---|---|\n| 0001 | Урок | lessons/0001-l.html |\n`);
const LESSON = strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1></body></html>');
const course = (id, quizzes) => ({ 'INDEX.md': INDEX(id), 'lessons/0001-l.html': LESSON, ...quizzes });
const pick = (page, i) => page.locator(`.quiz__option[data-option="${i}"]`).click();
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const counter = (page) => page.locator('.quiz__count');
/** What the screen marks: [index, class, mark] for each option, the verdict and the "Верен отговор" line. */
const marks = (page) => page.evaluate(() => ({
  options: [...document.querySelectorAll('.quiz__option')].map((b) => [
    b.dataset.option,
    b.classList.contains('quiz__option--correct') ? 'ok' : b.classList.contains('quiz__option--wrong') ? 'no' : b.classList.contains('quiz__option--muted') ? 'muted' : '',
    b.querySelector('.quiz__option-mark')?.textContent || '',
  ]),
  verdict: document.querySelector('.quiz__verdict')?.textContent ?? null,
  right: document.querySelector('[data-field="quiz-right"]')?.textContent ?? null,
}));

// ---------------------------------------------------------------------------
test.describe('T-050 links (D-035)', () => {
  test('odd URLs are never shown as links; labels stay text; hrefs are the parsed https URLs', async ({ page }) => {
    const L = (label, url) => ({ label, url });
    const bad = [
      L('upper JS', 'JAVASCRIPT:alert(1)'), L('tab JS', '\tjava\nscript:alert(1)'), L('vbscript', 'vbscript:msgbox(1)'),
      L('file', 'file:///etc/passwd'), L('blob', 'blob:https://example.org/uuid'), L('ftp', 'ftp://example.org/'),
      L('ws', 'wss://example.org/'), L('proto-relative', '//evil.example/'), L('empty host', 'https://'), L('only scheme', 'https:'),
      L('creds', 'https://a@example.org/'), L('long', `https://example.org/${'a'.repeat(2100)}`), L('number', 42), L('object', { href: 'https://x.org' }),
      L('mailto', 'mailto:a@example.org'), L('tel', 'tel:123'), L('intent', 'intent://scan/#Intent;scheme=zxing;end'), L('chrome', 'chrome://settings'),
      L('data upper', 'DATA:text/html,<b>x</b>'), L('http upper', 'HTTP://example.org/'),
    ];
    const good = [
      L('<img src=x onerror="window.__xss=1">EUR-Lex', 'https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:32024R2847#art_3'),
      L('Upper scheme', 'HTTPS://EXAMPLE.org/Path'),
      L('   ', 'https://drive.google.com/file/d/xyz/view?usp=sharing'),
      L('quotes " \' <>', 'https://example.org/a b?q="x"<y>'),
      L('x'.repeat(250), 'https://example.org/long-label'),
    ];
    const line = await importCourse(page, 'LRN-LX', course('LRN-LX', {
      'quizzes/a.json': json({ lesson: '0001', title: 'Странни линкове', questions: [
        { q: 'Само лоши линкове?', options: ['Да', 'Не'], answer: 0, src: 'Текст на източника', links: bad },
        { q: 'Добри линкове?', options: ['Да', 'Не'], answer: 0, src: 'не се показва', links: good },
        { q: 'links е обект?', options: ['Да', 'Не'], answer: 0, src: 'Само текст', links: { label: 'x', url: 'https://example.org/' } },
      ] }),
    }));
    console.log(`T-050 links import: ${line}`);
    expect(line).toContain('Внимание — тестовете не са внесени изцяло');
    await page.goto('./#/c/LRN-LX/quiz/a');
    // 1: every link is bad → no <a>, the src text instead.
    await pick(page, 0);
    await expect(page.locator('.quiz__src a')).toHaveCount(0);
    await expect(page.locator('.quiz__src')).toHaveText('Източник: Текст на източника');
    // 2: the good ones, max 5, labels as text.
    await btn(page, 'Напред').click();
    await pick(page, 1);
    const a = page.locator('.quiz__src a');
    const got = await a.evaluateAll((els) => els.map((e) => ({ text: e.textContent, href: e.getAttribute('href'), target: e.target, rel: e.rel, kids: e.children.length })));
    console.log(`T-050 links shown: ${JSON.stringify(got.map((g) => [g.text.slice(0, 40), g.href.slice(0, 80)]))}`);
    expect(got.map((g) => g.text)).toEqual(['<img src=x onerror="window.__xss=1">EUR-Lex', 'Upper scheme', 'drive.google.com', 'quotes " \' <>', 'x'.repeat(200)]);
    expect(got.map((g) => g.href)).toEqual([
      'https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:32024R2847#art_3',
      'https://example.org/Path',
      'https://drive.google.com/file/d/xyz/view?usp=sharing',
      'https://example.org/a%20b?q=%22x%22%3Cy%3E',
      'https://example.org/long-label',
    ]);
    for (const g of got) expect(g).toMatchObject({ target: '_blank', rel: 'noopener noreferrer', kids: 0 });
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('main img, main script, main b')).toHaveCount(0);
    // No horizontal scroll with the 200-character label (T048-D4).
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // 3: links that are not a list → src text.
    await btn(page, 'Напред').click();
    await pick(page, 0);
    await expect(page.locator('.quiz__src')).toHaveText('Източник: Само текст');
    // In the database, nothing but https.
    const stored = await page.evaluate(async () => (await (await import('./src/db.js')).listQuizzes('LRN-LX'))[0].questions.flatMap((q) => q.links.map((l) => l.url)));
    expect(stored.every((u) => u.startsWith('https://'))).toBe(true);
  });

  test('a link that was forged into the database (not https) is still not shown', async ({ page }) => {
    await importCourse(page, 'LRN-LF', course('LRN-LF', {
      'quizzes/a.json': json({ lesson: '0001', title: 'Подправен', questions: [{ q: 'Подправен линк?', options: ['Да', 'Не'], answer: 0, src: 'резервен текст', links: [{ label: 'ok', url: 'https://example.org/' }] }] }),
    }));
    // Write bad links straight into IndexedDB (as an old or broken record would be).
    await page.evaluate(async () => {
      const req = indexedDB.open('lrn-app');
      const db = await new Promise((ok) => { req.onsuccess = () => ok(req.result); });
      const tx = db.transaction('quizzes', 'readwrite');
      const store = tx.objectStore('quizzes');
      const all = await new Promise((ok) => { const r = store.getAll(); r.onsuccess = () => ok(r.result); });
      const q = all.find((x) => x.courseId === 'LRN-LF');
      q.questions[0].links = [{ label: 'js', url: 'javascript:window.__xss=1' }, { label: 'data', url: 'data:text/html,x' }, { label: 'http', url: 'http://example.org/' }, { label: '<b>x</b>', url: ' javascript:1' }];
      store.put(q);
      await new Promise((ok) => { tx.oncomplete = ok; });
      db.close();
    });
    await page.goto('./#/c/LRN-LF/quiz/a');
    await pick(page, 0);
    await expect(page.locator('.quiz__src a')).toHaveCount(0);
    await expect(page.locator('.quiz__src')).toHaveText('Източник: резервен текст');
  });

  test('a tap on a link opens a new tab without opener; the app stays on the same question; the link is ≥ 44 px', async ({ page, context }) => {
    await importCourse(page, 'LRN-LT', course('LRN-LT', {
      'quizzes/a.json': json({ lesson: '0001', title: 'Нов раздел', questions: [
        { q: 'Едно?', options: ['А', 'Б'], answer: 0 },
        { q: 'Две?', options: ['А', 'Б'], answer: 0, links: [{ label: 'Регламент, чл. 2', url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj#art_2' }] },
      ] }),
    }));
    await page.goto('./#/c/LRN-LT/quiz/a');
    await btn(page, 'Напред').click();
    await pick(page, 1);
    const before = page.url();
    const link = page.locator('.quiz__src a');
    const box = await link.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    const [popup] = await Promise.all([context.waitForEvent('page'), link.tap()]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe('https://eur-lex.europa.eu/eli/reg/2024/2847/oj#art_2');
    expect(await popup.evaluate(() => [window.opener, document.referrer])).toEqual([null, '']);
    await popup.close();
    expect(page.url()).toBe(before);
    await expect(counter(page)).toHaveText('Въпрос 2 от 2 · отговорени 1');
    await expect(page.locator('.quiz__verdict')).toHaveText('Грешно');
  });
});

// ---------------------------------------------------------------------------
test.describe('T-050 marking (D-036)', () => {
  const QZ = { lesson: '0001', title: 'Маркиране', questions: [
    { q: 'Кое е вярно 1?', options: ['Първо', 'Второ', 'Трето', 'Четвърто'], answer: 2, why: 'Обяснение 1.', links: [{ label: 'Източник 1', url: 'https://example.org/1' }] },
    { q: 'Кое е вярно 2?', options: ['Ала', 'Бала'], answer: 0, why: 'Обяснение 2.' },
    { q: 'Кое е вярно 3?', options: ['Х', 'У', 'Z'], answer: 1 },
  ] };

  test('wrong: only the chosen is red ✗, the right one is NOT coloured, "Верен отговор: …"; right: only ✓, no such line — also back/forward, after reload, from the result, in "Прегледай отначало"', async ({ page }) => {
    await importCourse(page, 'LRN-M', course('LRN-M', { 'quizzes/m.json': json(QZ) }));
    await page.goto('./#/c/LRN-M/quiz/m');
    // Before any answer, nothing is marked.
    expect((await marks(page)).options.every((o) => o[1] === '' && o[2] === '')).toBe(true);
    await pick(page, 3); // wrong (right is 2)
    const wrong1 = { options: [['0', 'muted', ''], ['1', 'muted', ''], ['2', 'muted', ''], ['3', 'no', '✗']], verdict: 'Грешно', right: 'Верен отговор: Трето' };
    expect(await marks(page)).toEqual(wrong1);
    await expect(page.locator('.quiz__feedback')).toContainText('Обяснение 1.');
    await expect(page.locator('.quiz__feedback a')).toHaveText('Източник 1');
    // The right option has the same look as the other unchosen ones.
    const look = await page.evaluate(() => [...document.querySelectorAll('.quiz__option')].map((b) => getComputedStyle(b).backgroundColor + '|' + getComputedStyle(b).borderColor));
    expect(look[2]).toBe(look[0]);
    expect(look[2]).toBe(look[1]);
    await btn(page, 'Напред').click();
    await pick(page, 0); // right
    const right2 = { options: [['0', 'ok', '✓'], ['1', 'muted', '']], verdict: 'Вярно', right: null };
    expect(await marks(page)).toEqual(right2);
    await btn(page, 'Напред').click();
    await pick(page, 2); // wrong (right is 1)
    const wrong3 = { options: [['0', 'muted', ''], ['1', 'muted', ''], ['2', 'no', '✗']], verdict: 'Грешно', right: 'Верен отговор: У' };
    expect(await marks(page)).toEqual(wrong3);
    // Back / forward.
    await btn(page, 'Назад').click();
    expect(await marks(page)).toEqual(right2);
    await btn(page, 'Назад').click();
    expect(await marks(page)).toEqual(wrong1);
    // Reload.
    await page.waitForTimeout(300);
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 3');
    expect(await marks(page)).toEqual(wrong1);
    // Result → a wrong question.
    await btn(page, 'Напред').click();
    await btn(page, 'Напред').click();
    await btn(page, 'Виж резултата').click();
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 3 верни');
    await page.locator('.quiz__wrong-link', { hasText: 'Кое е вярно 3?' }).click();
    expect(await marks(page)).toEqual(wrong3);
    // "Прегледай отначало".
    await btn(page, 'Виж резултата').click();
    await btn(page, 'Прегледай отначало').click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 3 · отговорени 3');
    expect(await marks(page)).toEqual(wrong1);
    // "Опитай пак грешните": the cleared questions are unmarked, a new right answer is ✓.
    await btn(page, 'Напред').click();
    await btn(page, 'Напред').click();
    await btn(page, 'Виж резултата').click();
    await btn(page, 'Опитай пак грешните').click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 2 · отговорени 0');
    expect((await marks(page)).verdict).toBeNull();
    await pick(page, 2);
    expect(await marks(page)).toEqual({ options: [['0', 'muted', ''], ['1', 'muted', ''], ['2', 'ok', '✓'], ['3', 'muted', '']], verdict: 'Вярно', right: null });
    // aria-label of the chosen option.
    await expect(page.locator('.quiz__option--correct')).toHaveAttribute('aria-label', 'Трето — твоят отговор, верен');
  });

  // T050-D2 fixed in T-050-fix by the first way the tester allowed: the import
  // refuses a question with equal options, with a note (the developer's log
  // explains the choice); the other questions of the quiz stay.
  test('[T050-D2] options with the same text: the import drops the question with a note; the rest of the quiz works', async ({ page }) => {
    const line = await importCourse(page, 'LRN-DUP', course('LRN-DUP', { 'quizzes/d.json': json({ lesson: '0001', title: 'Еднакви опции', questions: [
      { q: 'Кой е верният?', options: ['Да', 'Да', 'Не'], answer: 1 },
      { q: 'С интервали?', options: ['Да ', ' Да', 'Не'], answer: 0 },
      { q: 'Различни?', options: ['Да', 'да', 'Не'], answer: 1 },
    ] }) }));
    console.log(`T-050 duplicate options import: ${line}`);
    expect(line).toContain('въпрос 1: две опции с еднакъв текст — въпросът е пропуснат');
    expect(line).toContain('въпрос 2: две опции с еднакъв текст — въпросът е пропуснат');
    expect(line).not.toContain('въпрос 3:');
    await page.goto('./#/c/LRN-DUP/quiz/d');
    await expect(counter(page)).toHaveText('Въпрос 1 от 1 · отговорени 0');
    await pick(page, 1);
    expect(await marks(page)).toEqual({ options: [['0', 'muted', ''], ['1', 'ok', '✓'], ['2', 'muted', '']], verdict: 'Вярно', right: null });
  });
});

// ---------------------------------------------------------------------------
test.describe('T-050 "Отначало" and "Нулирай" (D-035)', () => {
  const Q5 = { lesson: '0001', title: 'Пет въпроса', questions: [1, 2, 3, 4, 5].map((n) => ({ q: `Въпрос номер ${n}?`, options: ['А', 'Б', 'В'], answer: n % 3 })) };

  test('"Отначало" is there on every question, before any answer, at the result and in "Опитай пак грешните"; "Отказ" keeps everything; yes → question 1, 0 answered, also after reload', async ({ page }) => {
    await importCourse(page, 'LRN-R', course('LRN-R', { 'quizzes/r.json': json(Q5) }));
    await page.goto('./#/c/LRN-R/quiz/r');
    await expect(btn(page, 'Отначало')).toBeVisible(); // before any answer
    for (let i = 0; i < 5; i++) {
      await expect(btn(page, 'Отначало')).toBeVisible();
      await expect(btn(page, 'Отначало')).toBeInViewport();
      await pick(page, 0);
      if (i < 4) await btn(page, 'Напред').click();
    }
    await expect(counter(page)).toHaveText('Въпрос 5 от 5 · отговорени 5');
    // From each question i: cancel keeps; on question 3, confirm.
    for (const at of [5, 4, 3]) {
      if (at < 5) await btn(page, 'Назад').click();
      await btn(page, 'Отначало').click();
      await expect(page.locator('.quiz__confirm')).toContainText('Да изчистя ли отговорите и да започна отначало?');
      await expect(page.locator('[data-field="confirm-no"]')).toBeFocused();
      await page.keyboard.press('Enter'); // Enter = Отказ
      await expect(page.locator('.quiz__confirm')).toHaveCount(0);
      await expect(counter(page)).toHaveText(`Въпрос ${at} от 5 · отговорени 5`);
    }
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 3 от 5 · отговорени 5');
    await btn(page, 'Отначало').click();
    await page.locator('[data-field="confirm-yes"]').click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 5 · отговорени 0');
    expect((await marks(page)).verdict).toBeNull();
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 1 от 5 · отговорени 0');
    // At the result (no answers): Отначало still there.
    for (let i = 0; i < 4; i++) { await pick(page, 2); await btn(page, 'Напред').click(); }
    await pick(page, 2);
    await btn(page, 'Виж резултата').click();
    await expect(btn(page, 'Отначало')).toBeVisible();
    // In "Опитай пак грешните", on its 2nd question.
    await btn(page, 'Опитай пак грешните').click();
    await expect(counter(page)).toHaveText(/^Въпрос 1 от \d · отговорени 0$/);
    await btn(page, 'Напред').click();
    await btn(page, 'Отначало').click();
    await page.locator('[data-field="confirm-yes"]').click();
    await expect(counter(page)).toHaveText('Въпрос 1 от 5 · отговорени 0');
    await page.reload();
    await expect(counter(page)).toHaveText('Въпрос 1 от 5 · отговорени 0');
    // The course shows "не е започнат".
    await page.goto('./#/c/LRN-R');
    await expect(page.locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
  });

  test('"Нулирай" in "Тестове": disabled when not started, confirmation with focus on "Отказ", only that quiz, after reload too', async ({ page }) => {
    await importCourse(page, 'LRN-N', course('LRN-N', { 'quizzes/a.json': json({ ...Q5, title: 'Тест А' }), 'quizzes/b.json': json({ ...Q5, title: 'Тест Б' }), 'quizzes/c.json': json({ ...Q5, title: 'Тест В' }) }));
    for (const s of ['a', 'b']) {
      await page.goto(`./#/c/LRN-N/quiz/${s}`);
      await pick(page, 0);
      await btn(page, 'Напред').click();
      await pick(page, 1);
      await page.waitForTimeout(200);
    }
    await page.goto('./#/c/LRN-N');
    await unfoldLessons(page);
    const item = (t) => page.locator('.quiz-list__item', { hasText: t });
    await expect(item('Тест А').locator('[data-field="quiz-status"]')).toHaveText('2 от 5 отговорени');
    await expect(item('Тест В').locator('[data-field="quiz-reset"]')).toBeDisabled();
    await item('Тест А').locator('[data-field="quiz-reset"]').click();
    await expect(item('Тест А').locator('.quiz__confirm')).toBeVisible();
    await expect(item('Тест А').locator('[data-field="confirm-no"]')).toBeFocused();
    await item('Тест А').locator('[data-field="confirm-no"]').click();
    await expect(item('Тест А').locator('[data-field="quiz-status"]')).toHaveText('2 от 5 отговорени');
    await item('Тест А').locator('[data-field="quiz-reset"]').click();
    await item('Тест А').locator('[data-field="confirm-yes"]').click();
    await expect(item('Тест А').locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(item('Тест Б').locator('[data-field="quiz-status"]')).toHaveText('2 от 5 отговорени');
    await page.reload();
    await expect(item('Тест А').locator('[data-field="quiz-status"]')).toHaveText('не е започнат');
    await expect(item('Тест А').locator('[data-field="quiz-reset"]')).toBeDisabled();
    await expect(item('Тест Б').locator('[data-field="quiz-status"]')).toHaveText('2 от 5 отговорени');
    await page.goto('./#/c/LRN-N/quiz/a');
    await expect(counter(page)).toHaveText('Въпрос 1 от 5 · отговорени 0');
  });
});

// ---------------------------------------------------------------------------
test.describe('T-050 answers by content (T048-D1…D4)', () => {
  test('re-import: reshuffled options keep the choice (by text, verdict from the new answer); another right answer / changed option / changed text reset only that question; duplicates keep separate answers', async ({ page }) => {
    const v1 = { lesson: '0001', title: 'Повторен', questions: [
      { q: 'Разбъркан верен?', options: ['А', 'Б', 'В'], answer: 0 },
      { q: 'Разбъркан грешен?', options: ['А', 'Б', 'В'], answer: 0 },
      { q: 'Друг верен?', options: ['А', 'Б', 'В'], answer: 0 },
      { q: 'Променена опция?', options: ['А', 'Б', 'В'], answer: 0 },
      { q: 'Близнак?', options: ['Да', 'Не'], answer: 0 },
      { q: 'Близнак?', options: ['Да', 'Не'], answer: 0 },
      { q: 'Непроменен?', options: ['А', 'Б'], answer: 1 },
    ] };
    await importCourse(page, 'LRN-RI', course('LRN-RI', { 'quizzes/r.json': json(v1) }));
    await page.goto('./#/c/LRN-RI/quiz/r');
    const answers = [0, 2, 0, 0, 0, 1, 1]; // right, wrong (В), right, right, twin1 right, twin2 wrong, right
    for (const [i, a] of answers.entries()) { await pick(page, a); if (i < answers.length - 1) await btn(page, 'Напред').click(); }
    await expect(counter(page)).toHaveText('Въпрос 7 от 7 · отговорени 7');
    // Twins keep separate answers (T048-D3).
    await btn(page, 'Назад').click();
    expect((await marks(page)).verdict).toBe('Грешно');
    await btn(page, 'Назад').click();
    expect((await marks(page)).verdict).toBe('Вярно');
    await page.waitForTimeout(300);
    const v2 = { ...v1, questions: [
      { q: 'Разбъркан верен?', options: ['В', 'А', 'Б'], answer: 1 },
      { q: 'Разбъркан грешен?', options: ['Б', 'В', 'А'], answer: 2 },
      { q: 'Друг верен?', options: ['А', 'Б', 'В'], answer: 1 },
      { q: 'Променена опция?', options: ['А', 'Б', 'Г'], answer: 0 },
      v1.questions[4], v1.questions[5], v1.questions[6],
    ] };
    const line = await importCourse(page, 'LRN-RI', course('LRN-RI', { 'quizzes/r.json': json(v2) }));
    console.log(`T-050 re-import: ${line}`);
    await page.goto('./#/c/LRN-RI');
    await page.goto('./#/c/LRN-RI/quiz/r');
    await expect(counter(page)).toBeVisible();
    // Walk from question 1.
    const seen = [];
    for (let i = 0; i < 7; i++) {
      await page.evaluate(() => 0);
      if (i === 0) { while (!(await counter(page).textContent()).startsWith('Въпрос 1 ')) await btn(page, 'Назад').click(); }
      seen.push(await marks(page));
      if (i < 6) await btn(page, 'Напред').click();
    }
    console.log(`T-050 re-import marks: ${JSON.stringify(seen.map((m) => [m.verdict, m.options.filter((o) => o[2]).map((o) => o[0] + o[2])]))}`);
    expect(seen[0]).toMatchObject({ verdict: 'Вярно', options: [['0', 'muted', ''], ['1', 'ok', '✓'], ['2', 'muted', '']] }); // А follows to index 1
    expect(seen[1]).toMatchObject({ verdict: 'Грешно', right: 'Верен отговор: А', options: [['0', 'muted', ''], ['1', 'no', '✗'], ['2', 'muted', '']] }); // В at index 1
    expect(seen[2].verdict).toBeNull(); // another right answer → reset
    expect(seen[3].verdict).toBeNull(); // changed option → reset
    expect(seen[4].verdict).toBe('Вярно');
    expect(seen[5].verdict).toBe('Грешно');
    expect(seen[6].verdict).toBe('Вярно');
    await expect(counter(page)).toHaveText('Въпрос 7 от 7 · отговорени 5');
  });

  test('T048-D2: an option that is not text drops that question with a note (no shifted answer); T048-D4: long words do not scroll sideways', async ({ page }) => {
    const long = `https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:32024R2847&from=BG&${'qwertyuiop'.repeat(30)}`;
    const line = await importCourse(page, 'LRN-D2', course('LRN-D2', { 'quizzes/d.json': json({ lesson: '0001', title: 'Т'.repeat(280), questions: [
      { q: 'Числова опция?', options: ['грешно', null, 'вярно'], answer: 2 },
      { q: 'Булева опция?', options: [true, 'вярно'], answer: 1 },
      { q: `Дълъг: ${'дълга-дума-без-интервали'.repeat(20)}`, options: [long, 'Б'], answer: 1, why: long, src: long, links: [{ label: long, url: long }] },
    ] }) }));
    console.log(`T-050 D2/D4 import: ${line}`);
    expect(line).toContain('опция, която не е текст');
    await page.goto('./#/c/LRN-D2/quiz/d');
    await expect(counter(page)).toHaveText('Въпрос 1 от 1 · отговорени 0');
    await pick(page, 0);
    await expect(page.locator('[data-field="quiz-right"]')).toHaveText('Верен отговор: Б');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await btn(page, 'Виж резултата').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.goto('./#/c/LRN-D2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Screenshots: LRN-DEMO into T050_SHOTS_DEMO; the real course into T050_SHOTS (outside the repo).
const theme = async (page, dark) => {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
};
test.describe('T-050 screenshots and the real course', () => {
  test('LRN-DEMO: wrong answer with links, right answer, "Отначало" dialog, course with "Нулирай" dialog — light and dark', async ({ page }, info) => {
    const dir = process.env.T050_SHOTS_DEMO;
    test.skip(!dir, 'set T050_SHOTS_DEMO');
    mkdirSync(dir, { recursive: true });
    const o = info.project.name === 'tablet-portrait' ? 'portrait' : 'landscape';
    await importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(readFixture()))]);
    for (const dark of [false, true]) {
      const t = dark ? 'dark' : 'light';
      await theme(page, dark);
      await page.goto('./#/c/LRN-DEMO/quiz/0001-1-vidove');
      await expect(counter(page)).toBeVisible();
      if ((await marks(page)).verdict) { await btn(page, 'Отначало').click(); await page.locator('[data-field="confirm-yes"]').click(); }
      await pick(page, 1);
      await page.screenshot({ path: join(dir, `demo-${o}-${t}-wrong-links.png`) });
      await btn(page, 'Напред').click();
      await pick(page, 0);
      await page.screenshot({ path: join(dir, `demo-${o}-${t}-right.png`) });
      await btn(page, 'Отначало').click();
      await page.screenshot({ path: join(dir, `demo-${o}-${t}-restart-dialog.png`) });
      await page.locator('[data-field="confirm-no"]').click();
      await page.goto('./#/c/LRN-DEMO');
      await unfoldLessons(page);
      await page.locator('.quiz-list__item').first().locator('[data-field="quiz-reset"]').click();
      await page.locator('.quiz-list__item').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir, `demo-${o}-${t}-course-reset.png`), fullPage: true });
      await page.locator('[data-field="confirm-no"]').click();
    }
  });

  test('real course (T050_REAL_DIR): every link is https and shown; wrong → only ✗ + "Верен отговор"; a link opens a new tab; "Отначало"; screenshots', async ({ page, context }, info) => {
    const real = process.env.T050_REAL_DIR;
    test.skip(!real || !existsSync(join(real, 'quizzes')), 'set T050_REAL_DIR');
    test.setTimeout(180_000);
    const shots = process.env.T050_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const o = info.project.name === 'tablet-portrait' ? 'portrait' : 'landscape';
    const files = {};
    const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files[relative(real, p)] = new Uint8Array(readFileSync(p)); } };
    walk(real);
    const line = await importFiles(page, [asFile('LRN-CRA-20261119T090000Z-1-001.zip', makeZip(files, { root: 'LRN-CRA' }))]);
    console.log(`T-050 real import: ${line}`);
    const quizzes = readdirSync(join(real, 'quizzes')).filter((n) => n.endsWith('.json')).sort();
    for (const name of quizzes) {
      const src = JSON.parse(readFileSync(join(real, 'quizzes', name), 'utf8'));
      const allLinks = src.questions.flatMap((q) => q.links || []);
      expect(allLinks.every((l) => /^https:\/\//.test(l.url))).toBe(true);
      const slug = name.replace(/\.json$/, '');
      await page.goto(`./#/c/LRN-CRA/quiz/${slug}`);
      await expect(counter(page)).toBeVisible();
      let shown = 0;
      for (const [i, q] of src.questions.entries()) {
        const wrongIdx = q.answer === 0 ? 1 : 0;
        await pick(page, wrongIdx);
        const m = await marks(page);
        expect(m.options.filter((x) => x[1] === 'no').length).toBe(1);
        expect(m.options.filter((x) => x[1] === 'ok').length).toBe(0);
        expect(m.right).toBe(`Верен отговор: ${q.options[q.answer]}`);
        const hrefs = await page.locator('.quiz__src a').evaluateAll((els) => els.map((e) => e.href));
        expect(hrefs.length).toBe((q.links || []).length);
        shown += hrefs.length;
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        if (i === 0 && shots) {
          for (const dark of [false, true]) { await theme(page, dark); await page.screenshot({ path: join(shots, `real-${o}-${dark ? 'dark' : 'light'}-${slug}-wrong.png`), fullPage: true }); }
          await theme(page, false);
          if (hrefs.length) {
            const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('.quiz__src a').first().click()]);
            await popup.waitForLoadState();
            expect(popup.url()).toBe(hrefs[0]);
            expect(await popup.evaluate(() => window.opener)).toBeNull();
            await popup.close();
          }
        }
        if (i < src.questions.length - 1) await btn(page, 'Напред').click();
      }
      console.log(`T-050 real ${slug}: ${src.questions.length} questions, ${shown} links shown of ${allLinks.length}`);
      expect(shown).toBe(allLinks.length);
      await btn(page, 'Виж резултата').click();
      await expect(page.locator('.quiz__score')).toHaveText(`Резултат: 0 от ${src.questions.length} верни`);
      if (shots) await page.screenshot({ path: join(shots, `real-${o}-light-${slug}-result.png`), fullPage: true });
      await btn(page, 'Отначало').click();
      await page.locator('[data-field="confirm-yes"]').click();
      await expect(counter(page)).toHaveText(`Въпрос 1 от ${src.questions.length} · отговорени 0`);
    }
    // The real lesson still renders through the new parser.
    await page.goto('./#/c/LRN-CRA/read/0001');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    if (shots) await page.screenshot({ path: join(shots, `real-${o}-lesson-0001.png`) });
  });
});
