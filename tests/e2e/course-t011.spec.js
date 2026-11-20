// T-011 (developer, 0.8.0): the course screen and the progress (UI-DESIGN §3, F1).
// - one heading per section ("Уроци" once — the T-008 user check saw it twice);
// - T-011-fix (0.8.1, D-038): no mission (MISSION.md) and no course notes
//   (NOTES.md) on the screen; the resources (RESOURCES.md, rendered Markdown,
//   collapsed) stay; the h1 is the course name;
// - the layout uses the width of the tablet: two columns at 1920×1200,
//   1280×800 and 1200×1920, one column at 800×1280; never a horizontal scroll;
// - status ○ / ◐ / ●, "скоро" for planned lessons, counters, "Продължи",
//   "Маркирай като завършен" in the reader, "Последни дейности";
// - what worked keeps working: "Тестове", "Тест към урока", opening a lesson.
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and small in-memory courses.
import { test, expect } from '@playwright/test';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
// T-055 (D-039): lessons are keyed by course + number, not by path.
const LESSON_ID = 'LRN-DEMO/lesson:0001';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
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
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page, files = FILES) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(files))]);
const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id = 'LRN-DEMO') {
  await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible();
}
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });
const progress = (page) => page.evaluate(async (id) => (await (await import('./src/db.js')).getLesson(id)).progress, LESSON_ID);
const lessonFrame = (page) => page.frameLocator('iframe.lesson-frame');
// D-040 (T-057): answer every question of every quiz of a course (the right option).
const answerAll = (page, courseId) => page.evaluate(async (courseId) => {
  const db = await import('./src/db.js');
  for (const q of await db.listQuizzes(courseId)) {
    const keys = db.questionKeys(q.questions);
    for (const [i, question] of q.questions.entries()) {
      await db.saveQuizChoice(q.id, { courseId, qKey: keys[i], choice: question.options[question.answer], cursor: i });
    }
  }
}, courseId);
async function openLessonFromCourse(page) {
  await course(page).locator('a.lesson-link', { hasText: 'Какви видове чай' }).click();
  await expect(page).toHaveURL(/read\/0001$/);
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
}

test.describe('T-011 the course screen: structure', () => {
  test('one heading per section; lessons and references in order; planned lessons are "скоро", not links', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    const h2 = await course(page).locator('h2').allTextContents();
    // The side column comes first in the DOM (on a narrow screen it is on top); D-038: no "Мисия", no "Бележки на курса".
    // D-040 (T-057): no separate "Тестове" section; the quizzes are under their lesson.
    expect(h2).toEqual(['Последни дейности', 'Ресурси', 'Уроци', 'Справочници']);
    // "Уроци" exactly once, in any case (was an h2 and an uppercase h3 eyebrow).
    expect(await course(page).getByText(/^уроци$/i).count()).toBe(1);
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Какви видове чай има?', 'R01 Температура и време за запарване']);
    await expect(course(page).locator('[data-section="lessons"] [data-lesson]')).toHaveCount(1);
    await expect(course(page).locator('[data-section="references"] [data-lesson]')).toHaveCount(1);
    // INDEX.md "План": 0002 and 0003 are not imported yet.
    const planned = course(page).locator('[data-section="lessons"] [data-planned]');
    await expect(planned).toHaveCount(2);
    await expect(planned.first()).toContainText('0002');
    await expect(planned.first()).toContainText('зелен чай');
    await expect(planned.first()).toContainText('Скоро');
    await expect(planned.locator('a')).toHaveCount(0);
    await expect(course(page).locator('h1[data-field="course-title"]')).toHaveText('Основи на чая');
  });

  test('D-038: no mission and no course notes on the screen; the resources unfold', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    await expect(course(page).locator('[data-section="mission"], [data-section="notes"], [data-field="mission-text"], [data-field="notes-text"]')).toHaveCount(0);
    // Nothing of MISSION.md (besides the course name) and of NOTES.md is shown.
    await expect(course(page)).not.toContainText('Да различавам основните видове чай');
    await expect(course(page)).not.toContainText('кратки обяснения с примери от кухнята');
    // The files are still in the course (for the AI teacher, D-016).
    const meta = await page.evaluate(async () => (await (await import('./src/db.js')).getCourse('LRN-DEMO')).meta);
    expect(meta.mission).toContain('Да различавам основните видове чай');
    expect(meta.notes).toContain('кратки обяснения с примери от кухнята');
    // Resources: collapsed; they open on a tap and with the keyboard.
    const box = course(page).locator('[data-section="resources"]');
    await expect(box).not.toHaveAttribute('open', /.*/);
    await expect(box.locator('[data-field="resources-text"]')).toBeHidden();
    await box.locator('summary').click();
    await expect(box.locator('[data-field="resources-text"]')).toContainText('Измислена таблица с температури');
    await box.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(box.locator('[data-field="resources-text"]')).toBeHidden();
    await page.keyboard.press('Enter');
    // An https link in RESOURCES.md opens outside the app.
    const ext = course(page).locator('[data-section="resources"] a[href="https://example.org/tea"]');
    await expect(ext).toHaveAttribute('target', '_blank');
    await expect(ext).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('hostile Markdown: raw HTML is text, no image is loaded, only https and course links stay links', async ({ page }) => {
    await page.evaluate(() => { window.__xss = []; });
    const files = {
      'INDEX.md': strToU8('# LRN-MDX: индекс\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Урок |\n'),
      'RESOURCES.md': strToU8([
        '# Ресурси',
        '<img src=x onerror="__xss.push(1)"> <script>__xss.push(2)</script>',
        '',
        '<div style="color:red" onclick="__xss.push(3)">блок</div>',
        '',
        '![картинка](https://example.org/x.png) [js](javascript:__xss.push(4)) [data](data:text/html,x) [файл](sources/a.pdf)',
        '[урокът](lessons/0001-urok.html) [сайт](https://example.org/a "заглавие") [поща](mailto:a@example.org)',
        '',
        '- [x] готово',
        '',
        '| a | b |\n|---|---|\n| 1 | <b>2</b> |',
      ].join('\n')),
      'lessons/0001-urok.html': strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p></body></html>'),
    };
    await importFiles(page, [asFile('LRN-MDX.zip', makeZip(files, { root: 'LRN-MDX' }))]);
    await openCourse(page, 'LRN-MDX');
    await course(page).locator('[data-section="resources"] summary').click();
    const text = course(page).locator('[data-field="resources-text"]');
    await expect(text).toContainText('<img src=x onerror="__xss.push(1)">');
    await expect(text).toContainText('<div style="color:red"');
    await expect(text).toContainText('картинка');
    await expect(course(page).locator('img, script, iframe, [style], [onclick], [onerror]')).toHaveCount(0);
    const hrefs = await text.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(['#/c/LRN-MDX/read/0001', 'https://example.org/a']);
    await expect(text.locator('input[type="checkbox"]')).toBeDisabled();
    await text.locator('a', { hasText: 'урокът' }).click();
    await expect(page).toHaveURL(/#\/c\/LRN-MDX\/read\/0001$/);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
  });

  test('a course without MISSION/RESOURCES/NOTES: no document blocks, the h1 is the course id', async ({ page }) => {
    const files = {
      'INDEX.md': strToU8('# LRN-MIN: индекс\n'),
      'lessons/0001-a.html': strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>А</title></head><body><h1>А</h1></body></html>'),
    };
    await importFiles(page, [asFile('LRN-MIN.zip', makeZip(files, { root: 'LRN-MIN' }))]);
    await openCourse(page, 'LRN-MIN');
    await expect(course(page).locator('h1[data-field="course-title"]')).toHaveText('LRN-MIN');
    await expect(course(page).locator('[data-section="mission"], [data-section="resources"], [data-section="notes"], [data-section="references"], [data-list="quizzes"] h2')).toHaveCount(0);
    await expect(course(page).locator('[data-field="activity-empty"]')).toBeVisible();
  });
});

test.describe('T-011 layout: the width of the tablet is used, no horizontal scroll', () => {
  const sizes = [
    { name: '1920×1200', width: 1920, height: 1200, columns: 2 },
    { name: '1280×800', width: 1280, height: 800, columns: 2 },
    { name: '1200×1920', width: 1200, height: 1920, columns: 2 },
    { name: '800×1280', width: 800, height: 1280, columns: 1 },
  ];
  test('two columns on a wide screen, one on a narrow one; the content fills the width', async ({ page }, info) => {
    await importDemo(page);
    // Each project starts with its own viewport (landscape or portrait); both check all sizes,
    // starting with the project's own one.
    const own = info.project.name === 'tablet-portrait' ? 2 : 0;
    for (const size of [sizes[own], ...sizes.filter((_, i) => i !== own)]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openCourse(page);
      const box = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const main = r('.course__main');
        const side = r('.course__side');
        const screen = r('[data-screen="course"]');
        return {
          main, side, screen,
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          wide: [...document.querySelectorAll('[data-screen="course"] *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((e) => e.className || e.tagName).slice(0, 5),
        };
      });
      expect(box.scrollW, `${size.name}: no horizontal scroll`).toBeLessThanOrEqual(box.clientW);
      expect(box.wide, `${size.name}: nothing sticks out`).toEqual([]);
      // The screen uses (almost) the whole width — at most 1680 px of content (long lines).
      expect(box.screen.width, `${size.name}: width used`).toBeGreaterThanOrEqual(Math.min(size.width, 1680) - 60);
      if (size.columns === 2) {
        expect(box.side.left, `${size.name}: the side column is to the right`).toBeGreaterThanOrEqual(box.main.right);
        expect(Math.abs(box.side.top - box.main.top), `${size.name}: side by side`).toBeLessThan(2);
        expect(box.main.width, `${size.name}: the lessons get the wider column`).toBeGreaterThan(box.side.width);
      } else {
        // One column: progress, "Продължи", activity and resources on top, then the lessons.
        expect(box.main.top, `${size.name}: one column`).toBeGreaterThanOrEqual(box.side.bottom);
        expect(box.side.width).toBeGreaterThan(size.width - 80);
        expect(box.main.width).toBeGreaterThan(size.width - 80);
      }
    }
  });

  test('targets are at least 44 px high; the status mark is not read out, the status is', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    // Links inside running text (the Markdown of the mission/resources) are exempt (WCAG 2.5.8 "inline").
    const heights = await course(page).locator('a:not(.md a), button, summary').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]));
    for (const [t, hgt] of heights) expect(hgt, t).toBeGreaterThanOrEqual(44);
    await expect(course(page).locator('.course-item__mark').first()).toHaveAttribute('aria-hidden', 'true');
    // D-041 (T-059): the line of the material; the quizzes have their own line and mark.
    await expect(item(page, '0001').locator('[data-field="lesson-meta"]')).toHaveText('Статус: Нов');
    await expect(item(page, '0001').locator('[data-field="lesson-quiz-line"]')).toHaveText(/^Тестове: не са започнати Въпроси 0 от \d+$/);
    await expect(page.getByRole('link', { name: '0001 Какви видове чай има?' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'За курса' })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveAttribute('max', '1');
  });

  test('light and dark theme: readable text on the paper in both', async ({ page }) => {
    await importDemo(page);
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (t) => (await import('./src/db.js')).saveSettings({ theme: t }), theme);
      await openCourse(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await course(page).locator('[data-section="resources"] summary').click();
      const c = await page.evaluate(() => {
        const color = (sel, prop = 'color') => getComputedStyle(document.querySelector(sel))[prop];
        return {
          bg: getComputedStyle(document.body).backgroundColor,
          resources: color('[data-field="resources-text"] li'),
          title: color('[data-field="course-title"]'),
          meta: color('.course-item__meta'),
          link: color('a.lesson-link'),
          heading: color('[data-section="resources"] h2'),
        };
      });
      for (const k of ['resources', 'title', 'meta', 'link', 'heading']) expect(contrast(c[k], c.bg), `${theme} ${k}`).toBeGreaterThanOrEqual(4.5);
      if (theme === 'dark') expect(lum(c.bg)).toBeLessThan(0.05);
      else expect(lum(c.bg)).toBeGreaterThan(0.8);
    }
  });
});

test.describe('T-011 progress: started, finished, "Продължи", recent activity', () => {
  test('a new course: all ○, "Започни" opens the first lesson, nothing in the activity', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    await expect(course(page).locator('.course-item[data-status="new"] [data-lesson]')).toHaveCount(2);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 1 урок');
    const go = course(page).locator('[data-action="continue"]');
    await expect(go).toHaveText('Започни: урок 0001 — Какви видове чай има?');
    await expect(course(page).locator('[data-field="activity-empty"]')).toBeVisible();
    await go.click();
    await expect(page).toHaveURL(/read\/0001$/);
  });

  test('opening → ◐ started; "Маркирай като завършен" → ● finished; pressed again → back to started; survives a reload', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    await openLessonFromCourse(page);
    await expect.poll(async () => (await progress(page)).status).toBe('started');
    expect((await progress(page)).lastOpenedAt).toBeTruthy();
    const done = page.locator('[data-action="complete"]');
    await expect(done).toHaveText('Маркирай като завършен');
    await expect(done).toHaveAttribute('aria-pressed', 'false');
    await page.goBack();
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'started');
    await expect(item(page, '0001').locator('.course-item__mark')).toHaveText('◐');
    // D-041 (T-059): no "отворен днес …" in the line; the history says where the user was.
    await expect(item(page, '0001').locator('[data-field="lesson-meta"]')).toHaveText('Статус: Започнат');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Продължи: урок 0001 — Какви видове чай има?');
    await expect(course(page).locator('[data-list="activity"] li').first()).toHaveText(/^Урок 0001 „Какви видове чай има\?“ — днес \d\d:\d\d$/);

    await openLessonFromCourse(page);
    await done.click();
    await expect(done).toHaveAttribute('aria-pressed', 'true');
    await expect(done).toHaveText('✓ Завършен');
    await expect(page.locator('[data-field="complete-status"]')).toHaveText('Урокът е отбелязан като завършен.');
    expect(await progress(page)).toMatchObject({ status: 'done' });
    await page.reload();
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true'); // reopening keeps "done"
    await page.goto('./#/c/LRN-DEMO');
    // D-041 (T-059): the material alone makes it ● (as before D-040); its two quizzes,
    // not answered, have their own mark "не са започнати" and do not hold it back.
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(item(page, '0001').locator('.course-item__mark')).toHaveText('●');
    await expect(item(page, '0001').locator('[data-field="lesson-meta"]')).toHaveText('Статус: Завършен');
    await expect(item(page, '0001').locator('[data-field="lesson-quiz-mark"]')).toHaveText(/Тестове: не са започнати$/);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 1 урок');
    await answerAll(page, 'LRN-DEMO');
    await page.reload();
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(item(page, '0001').locator('.course-item__mark')).toHaveText('●');
    await expect(item(page, '0001').locator('[data-field="lesson-meta"]')).toHaveText('Статус: Завършен');
    await expect(item(page, '0001').locator('[data-field="lesson-quiz-line"]')).toHaveText(/^Тестове: минати Въпроси (\d+) от \1 · 100\s% верни$/);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 1 урок');
    await expect(course(page).locator('progress')).toHaveAttribute('value', '1');
    await expect(course(page).locator('[data-list="activity"] li').first()).toHaveText(/^Урок 0001 „Какви видове чай има\?“ — днес \d\d:\d\d$/);
    // The courses list shows the progress too.
    await page.goto('./#/');
    await expect(page.locator('[data-course="LRN-DEMO"] [data-field="course-progress"]')).toHaveText('Завършени: 1 от 1 · последно: урок 0001');
    // Undo.
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await page.locator('[data-action="complete"]').click();
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'false');
    expect(await progress(page)).toMatchObject({ status: 'started', completedAt: null });
  });

  test('"Продължи" returns to the last opened lesson at the same position', async ({ page }) => {
    const path = 'lessons/0001-vidove-chay.html';
    const long = strToU8(new TextDecoder().decode(FILES[path]).replace('</body>', '<div style="height:4000px"></div><p id="end">Край.</p></body>'));
    await importDemo(page, { ...FILES, [path]: long });
    await openCourse(page);
    await openLessonFromCourse(page);
    await page.waitForTimeout(1600); // the lesson has restored its (empty) position
    await page.evaluate(() => window.scrollTo(0, 2000));
    await expect.poll(async () => (await progress(page)).scrollY, { timeout: 5000 }).toBeGreaterThan(1000);
    const y = (await progress(page)).scrollY;
    // Another lesson opened meanwhile is the newest: "Продължи" follows it…
    await page.goto('./#/c/LRN-DEMO/read/R01');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await page.goto('./#/c/LRN-DEMO');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText(/^Продължи: справочник R01/);
    // …then back to the lesson.
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await page.goto('./#/c/LRN-DEMO');
    await page.reload();
    await course(page).locator('[data-action="continue"]', { hasText: 'урок 0001' }).click();
    await expect(page).toHaveURL(/read\/0001$/);
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 5000 }).toBeGreaterThan(y - 150);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - 2000)).toBeLessThan(200);
  });

  test('counters from the user data: marks, questions, topics', async ({ page }) => {
    await importDemo(page);
    await page.evaluate(async (lessonId) => {
      const db = await import('./src/db.js');
      const sel = (exact) => ({ quote: { exact, prefix: '', suffix: '' }, position: { start: 0, end: exact.length } });
      const target = { type: 'lesson', id: lessonId };
      const a1 = await db.createAnnotation({ courseId: 'LRN-DEMO', target, selector: sel('чай'), color: 'yellow' });
      await db.createAnnotation({ courseId: 'LRN-DEMO', target, selector: sel('вода'), color: 'green' });
      const a3 = await db.createAnnotation({ courseId: 'LRN-DEMO', target, selector: sel('улун'), color: null });
      await db.createThread({ annotationId: a1.id });
      await db.createThread({ annotationId: a3.id });
      await db.createThread({ annotationId: a3.id });
      await db.createSubTopic({ courseId: 'LRN-DEMO', annotationId: a3.id, parent: target, title: 'Улун — <b>полуферментирал</b>', kind: 'термин', content: '' });
    }, LESSON_ID);
    await openCourse(page);
    await expect(item(page, '0001').locator('[data-field="lesson-meta"]')).toHaveText('Статус: Нов · 2 маркировки · 3 въпроса · 1 тема');
    // D-041 (T-059): "Последни дейности" is the history of places (lessons, references,
    // quizzes); a topic is not a place, so nothing is listed before a visit. The
    // title with HTML is nowhere an element (HTML in history titles: course-t059 H4).
    await expect(course(page).locator('[data-field="activity-empty"]')).toBeVisible();
    await expect(course(page).locator('b')).toHaveCount(0);
  });
});

test.describe('T-011 what worked keeps working', () => {
  test('"Тестове" with status and "Нулирай"; "Тест към урока" in the reader; quiz activity', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    // D-040 (T-057): the quizzes are under their lesson, unfolded with the arrow.
    await expect(course(page).locator('[data-section="quizzes"]')).toHaveCount(0);
    const toggle = item(page, '0001').locator('[data-field="lesson-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const quizzes = item(page, '0001').locator('[data-list="quizzes"]');
    await expect(quizzes.locator('[data-quiz]')).toHaveCount(2);
    await quizzes.locator('a.quiz-list__link').first().click();
    await expect(page.locator('[data-screen="quiz"]')).toBeVisible();
    await page.locator('.quiz__option').first().click();
    await page.goto('./#/c/LRN-DEMO');
    // D-041 (T-059): "Въпроси 1 от n" and the state word; the history has the quiz at its question.
    await expect(quizzes.locator('[data-field="quiz-count"]').first()).toHaveText(/^Въпроси 1 от \d+$/);
    await expect(quizzes.locator('[data-field="quiz-status"]').first()).toHaveText('започнат');
    await expect(quizzes.locator('[data-field="quiz-reset"]').first()).toBeEnabled();
    await expect(course(page).locator('[data-list="activity"] li').first()).toHaveText(/^Тест „.+“ · въпрос 1 от \d+ — днес \d\d:\d\d$/);
    await openLessonFromCourse(page);
    await expect(page.locator('[data-field="lesson-quizzes"] a')).toHaveCount(2);
    await expect(page.locator('[data-field="lesson-quizzes"] h3')).toHaveText('Тестове към урока');
    await expect(lessonFrame(page).locator('h1')).toBeVisible();
  });

  test('a re-import keeps the progress and the statuses', async ({ page }) => {
    await importDemo(page);
    await page.evaluate(async (id) => (await import('./src/db.js')).setLessonProgress(id, { status: 'done', completedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }), LESSON_ID);
    await answerAll(page, 'LRN-DEMO'); // D-040 (T-057); kept under D-041: the answers survive the re-import too
    await importDemo(page);
    await openCourse(page);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
  });
});
