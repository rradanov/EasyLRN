// T-046 (tester): the T-009/T-010 reader criteria again, on 0.5.0 (opaque
// lesson frame + bridge), with my own steps: LRN-DEMO always, a real course
// only from outside the repository (D-026).
//
// Optional:
//   T046_REAL_DIR=<course folder outside the repo>  the same checks on lesson 0001 of a real course
//   T046_SHOTS=<folder outside the repo>            screenshots of the real course
//   T046_SHOTS_DEMO=<folder>                         screenshots of LRN-DEMO (synthetic, may go to the log)
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REAL = process.env.T046_REAL_DIR;
const SHOTS = { demo: process.env.T046_SHOTS_DEMO, real: process.env.T046_SHOTS };

let problems;
let allowed;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  allowed = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' }));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
});

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const lf = (page) => page.frameLocator('iframe.lesson-frame');
const frameOf = (page, course) => page.frames().find((f) => f.url().includes(`/EasyLRN/c/${course}/`));

/** The two courses, with the selectors of their own quiz.js / reflect.js. */
const COURSES = {
  demo: {
    id: 'LRN-DEMO',
    files: () => readFixture(),
    zipName: () => DRIVE_ZIP_NAME,
    root: 'LRN-DEMO',
    choice: '.quiz-choice',
    feedback: '.quiz-note',
    reflectButton: '.reflect-collect',
    copied: /Копирано/,
  },
  real: {
    id: REAL ? basename(REAL.replace(/[\\/]+$/, '')) : null,
    files: () => readFixture(REAL),
    zipName: () => `${basename(REAL.replace(/[\\/]+$/, ''))}.zip`,
    root: REAL ? basename(REAL.replace(/[\\/]+$/, '')) : null,
    choice: '.opt',
    feedback: '.quiz-fb',
    reflectButton: 'button:has-text("Копирай")',
    copied: /Копирано\. Постави го в чата\./,
  },
};

async function importCourse(page, c) {
  return importFiles(page, [asFile(c.zipName(), makeZip(c.files(), { root: c.root }))]);
}

async function openFirst(page, c) {
  await page.goto(`./#/c/${c.id}`);
  await page.locator('a.lesson-link').first().click();
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(200);
  return frameOf(page, c.id);
}

async function layout(page, c) {
  const f = frameOf(page, c.id);
  const frameH = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height);
  const d = await f.evaluate(() => ({
    h: document.documentElement.getBoundingClientRect().height,
    innerY: document.scrollingElement.scrollHeight - innerHeight,
    innerX: document.scrollingElement.scrollWidth - innerWidth,
  }));
  const appX = await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
  return { diff: Math.abs(frameH - d.h), innerY: d.innerY, innerX: d.innerX, appX };
}

async function shot(page, kind, name) {
  const dir = SHOTS[kind];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const refProgress = (page, c) => page.evaluate(async (id) => (await (await import('./src/db.js')).listLessons(id)).filter((l) => /^R/.test(l.number)).map((l) => l.progress?.scrollY ?? 0), c.id);
const lessonProgress = (page, c) => page.evaluate(async (id) => (await (await import('./src/db.js')).listLessons(id)).find((l) => l.number === '0001')?.progress?.scrollY ?? 0, c.id);

for (const kind of ['demo', 'real']) {
  const c = COURSES[kind];
  const skipReal = (info, oneProject = false) => {
    test.skip(kind === 'real' && (!REAL || !existsSync(REAL)), 'needs T046_REAL_DIR');
    test.skip(oneProject && info.project.name !== 'tablet-landscape', 'one project covers all sizes');
  };

  test.describe(`T-046 reader on 0.5.0 — ${kind === 'demo' ? 'LRN-DEMO' : 'real course (T046_REAL_DIR)'}`, () => {
    test('first opening offline right after the import: lesson, quiz, artifact link to R01, Back', async ({ page, context }, info) => {
      skipReal(info);
      expect(await importCourse(page, c)).toMatch(/импортиран/);
      await context.setOffline(true);
      try {
        await page.reload();
        const f = await openFirst(page, c);
        expect(await f.evaluate(() => self.origin)).toBe('null');
        // D-032: lessons made after 18.11.2026 have no quiz inside (quizzes/*.json); older ones still do.
        if (await lf(page).locator('.quiz').count()) {
          const q = lf(page).locator('.quiz').first();
          await q.locator(c.choice).first().click();
          await expect(q.locator(c.feedback).first()).toBeVisible();
        }
        const lessonUrl = page.url();
        await lf(page).locator('a[href^="https://claude.ai/artifact/"]').first().click();
        await expect(page).toHaveURL(new RegExp(`#/c/${c.id}/read/R\\d+$`));
        await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
        await expect(lf(page).locator('h1').first()).toBeVisible();
        await page.goBack();
        await expect(page).toHaveURL(lessonUrl);
        await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
      } finally {
        await context.setOffline(false);
      }
    });

    test('quiz (if the lesson has one), reflect copies into the clipboard, external link in a new tab without opener, frame attributes', async ({ page, context }, info) => {
      skipReal(info);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await importCourse(page, c);
      const f = await openFirst(page, c);
      const frame = page.locator('iframe.lesson-frame');
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(await f.evaluate(() => self.origin)).toBe('null');
      // every quiz of the lesson answers
      const quizzes = lf(page).locator('.quiz');
      const nq = await quizzes.count();
      // D-032: the real lesson may have no quiz any more (quizzes/*.json); LRN-DEMO still has one.
      if (kind === 'demo') expect(nq).toBeGreaterThan(0);
      if (!nq) test.info().annotations.push({ type: 'note', description: 'no quiz inside the lesson (D-032)' });
      for (let i = 0; i < nq; i++) {
        await quizzes.nth(i).locator(c.choice).first().click();
        await expect(quizzes.nth(i).locator(c.feedback).first()).toBeVisible();
      }
      // reflect → the clipboard really has the answer
      await page.evaluate(() => navigator.clipboard.writeText('before'));
      const rf = lf(page).locator('.reflect').first();
      const fields = rf.locator('textarea:not([readonly]), input[type="text"]');
      await fields.first().fill('T046 отговор на упражнението');
      await rf.locator(c.reflectButton).first().click();
      await expect(rf).toContainText(c.copied);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('T046 отговор на упражнението');
      // external link
      const ext = lf(page).locator('a[href^="https://"]:not([href*="claude.ai"])').first();
      const popup = context.waitForEvent('page');
      await ext.click();
      const tab = await popup;
      await tab.waitForLoadState();
      expect(tab.url()).toBe(await ext.evaluate((a) => a.href));
      expect(await tab.evaluate(() => window.opener)).toBe(null);
      await tab.close();
      await expect(page).toHaveURL(new RegExp(`#/c/${c.id}/read/0001$`));
    });

    test('text size 1 / 1.25 / 1.5 → 18 / 22.5 / 27 px when opened and live; the frame follows', async ({ page }, info) => {
      skipReal(info);
      await importCourse(page, c);
      const size = (f) => f.evaluate(() => getComputedStyle(document.documentElement).fontSize);
      for (const [scale, px] of [[1.25, '22.5px'], [1.5, '27px'], [1, '18px']]) {
        await page.evaluate(async (s) => (await import('./src/db.js')).saveSettings({ fontScale: s }), scale);
        const f = await openFirst(page, c);
        expect(await size(f)).toBe(px);
        await expect.poll(async () => (await layout(page, c)).diff).toBeLessThan(2);
      }
      const f = frameOf(page, c.id);
      for (const [scale, px] of [[1.5, '27px'], [1.25, '22.5px']]) {
        await page.evaluate(async (s) => (await import('./src/db.js')).saveSettings({ fontScale: s }), scale);
        await expect.poll(() => size(f)).toBe(px);
        await expect.poll(async () => (await layout(page, c)).diff).toBeLessThan(2);
      }
    });

    test('rotation and themes: 1920×1200 ↔ 1200×1920 ↔ 1280×800 ↔ 800×1280, light and dark: frame = document ± 2 px, no inner or sideways scroll', async ({ page }, info) => {
      skipReal(info, true);
      test.setTimeout(90_000);
      await importCourse(page, c);
      const f = await openFirst(page, c);
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(await f.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(scheme === 'dark');
        for (const [w, h] of [[1920, 1200], [1200, 1920], [1920, 1200], [1280, 800], [800, 1280], [1280, 800]]) {
          await page.setViewportSize({ width: w, height: h });
          await page.evaluate(() => window.scrollTo(0, 0));
          await expect.poll(async () => (await layout(page, c)).diff, { message: `${scheme} ${w}×${h}` }).toBeLessThan(2);
          const l = await layout(page, c);
          expect(l.innerY, `${scheme} ${w}×${h}`).toBeLessThanOrEqual(1);
          expect(l.innerX, `${scheme} ${w}×${h}`).toBeLessThanOrEqual(1);
          expect(l.appX, `${scheme} ${w}×${h}`).toBeLessThanOrEqual(1);
          await shot(page, kind, `${kind}-${scheme}-${w}x${h}`);
        }
      }
      // The lesson background follows the theme (not white in dark).
      const bg = await f.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).not.toBe('rgb(255, 255, 255)');
    });

    test('reading position: leave and come back, reload, offline reload (< 60 px)', async ({ page, context }, info) => {
      skipReal(info);
      await importCourse(page, c);
      await openFirst(page, c);
      const target = await page.evaluate(() => Math.round(Math.min(document.scrollingElement.scrollHeight * 0.4, document.scrollingElement.scrollHeight - innerHeight - 40)));
      await page.evaluate((y) => window.scrollTo(0, y), target);
      await page.waitForTimeout(700);
      const check = async (why) => {
        await expect.poll(() => page.evaluate(() => scrollY), { message: why }).toBeGreaterThan(target - 60);
        expect(Math.abs(await page.evaluate(() => scrollY) - target), why).toBeLessThan(60);
      };
      await page.locator('a.back-link').click();
      await expect(page.locator('[data-screen="course"]')).toBeVisible();
      await openFirst(page, c);
      await check('back to the course and again');
      await page.reload();
      await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
      await check('reload');
      await context.setOffline(true);
      try {
        await page.reload();
        await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
        await check('offline reload');
      } finally {
        await context.setOffline(false);
      }
    });

    test('[T010-D2] Back from R01 at 0 / 150 / 400 / 800 ms: R01 keeps 0, the lesson keeps its own position', async ({ page }, info) => {
      skipReal(info);
      test.setTimeout(90_000);
      await importCourse(page, c);
      await openFirst(page, c);
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      await page.waitForTimeout(700);
      const lessonY = await lessonProgress(page, c);
      expect(lessonY).toBeGreaterThan(100);
      for (const delay of [0, 150, 400, 800]) {
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await page.waitForTimeout(500);
        // A click from a script (an evaluate() is a user activation): a Playwright click would first scroll the link into view.
        // T-075 (T074-S1): a link needs a gesture IN the lesson — a real tap focuses the frame first; here the frame gets the focus without a scroll.
        await page.locator('iframe.lesson-frame').evaluate((f) => f.focus({ preventScroll: true }));
        await frameOf(page, c.id).evaluate(() => document.querySelector('a[href^="https://claude.ai/artifact/"]').click());
        await expect(page).toHaveURL(new RegExp(`#/c/${c.id}/read/R\\d+$`));
        if (delay) await page.waitForTimeout(delay);
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`#/c/${c.id}/read/0001$`));
        await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
        await page.waitForTimeout(900);
        if (process.env.T046_DEBUG) console.log(`D2 ${kind} delay ${delay}: lessonY ${lessonY}, saved ${await lessonProgress(page, c)}, scrollY ${await page.evaluate(() => scrollY)}, max ${await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight)}, R01 ${await refProgress(page, c)}`);
        expect(await refProgress(page, c), `R01 after Back at ${delay} ms`).toEqual([0]);
        expect(Math.abs((await lessonProgress(page, c)) - lessonY), `lesson after Back at ${delay} ms`).toBeLessThan(60);
      }
      // And R01 opens at its top.
      await lf(page).locator('a[href^="https://claude.ai/artifact/"]').first().click();
      await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => scrollY)).toBeLessThan(5);
    });
  });
}

test.describe('T-046 links and anchors on LRN-DEMO', () => {
  test('relative R01 link and claude.ai artifact link → R01 in the app; #anchor and ?at= → heading under the bar', async ({ page }) => {
    await importCourse(page, COURSES.demo);
    await openFirst(page, COURSES.demo);
    await lf(page).locator('a[href="../reference/R01-temperatura-i-vreme.html"]').click();
    await expect(page).toHaveURL(/read\/R01$/);
    await expect(lf(page).locator('h1')).toHaveText('Температура и време за запарване');
    await page.goBack();
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
    await lf(page).locator('a[href^="https://claude.ai/artifact/"]').click();
    await expect(page).toHaveURL(/read\/R01$/);
    await page.goBack();
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
    const underBar = async (id) => {
      const top = await lf(page).locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top);
      const frameTop = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().top);
      const bar = await page.locator('.app-bar').evaluate((el) => el.getBoundingClientRect().bottom);
      const atEnd = await page.evaluate(() => Math.abs(scrollY - (document.scrollingElement.scrollHeight - innerHeight)) < 2);
      return atEnd || Math.abs(frameTop + top - bar - 8) <= 4;
    };
    await page.evaluate(() => window.scrollTo(0, 0));
    await lf(page).locator('a[href="#voda"]').click();
    await expect.poll(() => underBar('voda')).toBe(true);
    await page.goto('./#/c/LRN-DEMO');
    await page.goto('./#/c/LRN-DEMO/read/0001?at=test');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
    await expect.poll(() => underBar('test')).toBe(true);
  });
});

test.describe('T-046 [T010-D1] upper-case extensions', () => {
  test('.HTML / .Html / .HTM-less variants as loose files and inside a ZIP never add a second lesson 0001 or R01', async ({ page }) => {
    const files = readFixture();
    await importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(files))]);
    const count = () => page.evaluate(async () => (await (await import('./src/db.js')).listLessons('LRN-DEMO')).map((l) => `${l.number}:${l.path}`).sort());
    const before = await count();
    const lesson = files['lessons/0001-vidove-chay.html'];
    const ref = files['reference/R01-temperatura-i-vreme.html'];
    expect(await importFiles(page, [asFile('0001-vidove-chay.HTML', Buffer.from(lesson))])).toMatch(/Без промени/);
    expect(await importFiles(page, [asFile('R01-temperatura-i-vreme.Html', Buffer.from(ref))])).toMatch(/Без промени/);
    const changed = strToU8(new TextDecoder().decode(lesson).replace('</h1>', '</h1><p>Нов ред T046.</p>'));
    expect(await importFiles(page, [asFile('0001-vidove-chay.HtMl', Buffer.from(changed))])).toMatch(/променени: 1/);
    const zipped = { ...files };
    delete zipped['lessons/0001-vidove-chay.html'];
    zipped['lessons/0001-vidove-chay.HTML'] = lesson;
    zipped['assets/STYLE.CSS'] = files['assets/style.css'];
    expect(await importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(zipped))])).toMatch(/променени: 1|Без промени|обновен/);
    expect(await count()).toEqual(before);
    // The lesson opens and shows the original text again.
    await openFirst(page, COURSES.demo);
    await expect(lf(page).locator('h1')).toHaveText('Какви видове чай има?');
    await expect(lf(page).locator('body')).not.toContainText('Нов ред T046.');
  });
});
