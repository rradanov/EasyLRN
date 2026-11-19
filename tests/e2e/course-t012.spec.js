// T-012 (tester): independent check of T-011 (0.8.0) — the course screen and
// the progress (UI-DESIGN §3, F1), "as an attacker".
// - T012-S*: hostile Markdown in MISSION/RESOURCES/NOTES and hostile INDEX.md
//   (script, on* attributes, javascript:/data:/vbscript: links, svg, iframe,
//   style with url(), form, meta refresh, entity tricks, reference links,
//   autolinks, protocol-relative links, path traversal);
// - T012-D*: defects (with test.fail, so the suite stays green);
// T-011-fix (developer, 0.8.1, D-038): the course screen no longer shows
// MISSION.md and NOTES.md. The tests that read the mission/notes now check
// that nothing of them is shown or runs; the Markdown checks moved to
// RESOURCES.md (still shown). T012-D1..D3 are fixed: their test.fail is gone.
// - T012-I*: information.
// - layout at 1920×1200, 1280×800, 1200×1920, 800×1280, 360×800 with long
//   titles, long words/URLs, wide tables, 200 lessons, text at 160 %;
// - edge courses: no MISSION/INDEX/lessons, only quizzes, only references,
//   0 and 200 lessons, odd "План" lines, re-import, deleted course, two courses;
// - progress: status ○/◐/●, counters, "Продължи"/"Започни", recent activity,
//   "Маркирай като завършен" (double press, keyboard), back/forward, offline,
//   two tabs, light/dark theme, headings and the fold buttons.
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and courses made here.
import { test, expect } from '@playwright/test';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
// T-055 (D-039): lessons are keyed by course + number, not by path.
const DEMO_LESSON = 'LRN-DEMO/lesson:0001';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const lessonHtml = (title, extra = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Измислен текст.</p>${extra}</body></html>`);
const pad4 = (n) => String(n).padStart(4, '0');

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page, files = FILES) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(files))]);
/** Import a course made of { path: string|Uint8Array } under the root folder `id`. */
function importCourse(page, id, files) {
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
  return importFiles(page, [asFile(`${id}.zip`, makeZip(bytes, { root: id }))]);
}
/** INDEX.md with a lessons table of `numbers` (and optional extra text). */
function indexMd(id, numbers = [], extra = '') {
  const rows = numbers.map((n) => `| ${n} | Урок ${n} |`).join('\n');
  return `# ${id}: индекс\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${rows}\n${extra}`;
}
const course = (page) => page.locator('[data-screen="course"]');
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
async function openCourse(page, id = 'LRN-DEMO') {
  // The same hash again is no navigation: reload then, so the screen reads the store anew.
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });
const progressOf = (page, id) => page.evaluate(async (id) => (await (await import('./src/db.js')).getLesson(id)).progress, id);
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });

/** Tags the Markdown renderer may produce (src/markdown.js allow-list) + the span of a dead link. */
const ALLOWED = new Set(['P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A',
  'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'INPUT']);

/** Everything rendered from Markdown in the course screen: tags, attributes, links. */
function mdAudit(page) {
  return page.evaluate(() => {
    const docs = [...document.querySelectorAll('[data-screen="course"] .md')];
    const tags = new Set();
    const attrs = new Set();
    const hrefs = [];
    for (const d of docs) {
      for (const el of d.querySelectorAll('*')) {
        tags.add(el.tagName);
        for (const a of el.attributes) attrs.add(a.name);
        if (el.tagName === 'A') hrefs.push(el.getAttribute('href'));
      }
    }
    return { docs: docs.length, tags: [...tags], attrs: [...attrs], hrefs };
  });
}

// ---------------------------------------------------------------------------
// Security: hostile Markdown and INDEX.md
// ---------------------------------------------------------------------------
const HOSTILE_MD = [
  '# Мисия: <img src=x onerror="__xss.push(\'title\')"> заглавие',
  '',
  '<script>__xss.push("script")</script>',
  '<img src="https://example.org/pixel.png" onerror="__xss.push(\'img\')">',
  '<svg onload="__xss.push(\'svg\')"><circle r="5"/></svg>',
  '<svg><script>__xss.push("svg-script")</script></svg>',
  '<iframe src="https://example.org/" onload="__xss.push(\'iframe\')"></iframe>',
  '<iframe srcdoc="<script>parent.__xss.push(\'srcdoc\')</script>"></iframe>',
  '<style>body{background:url(https://example.org/bg.png)} *{display:none!important}</style>',
  '<form action="https://example.org/steal"><input name="k" value="x" autofocus onfocus="__xss.push(\'focus\')"><button>Изпрати</button></form>',
  '<meta http-equiv="refresh" content="0;url=https://example.org/">',
  '<link rel="stylesheet" href="https://example.org/x.css">',
  '<base href="https://example.org/">',
  '<object data="https://example.org/x.swf"></object><embed src="https://example.org/x.swf">',
  '<details open ontoggle="__xss.push(\'toggle\')"><summary>s</summary></details>',
  '<a href="javascript:__xss.push(\'raw-a\')">суров линк</a>',
  '<math><mtext><table><mglyph><style><img src=x onerror="__xss.push(\'mxss\')">',
  '',
  'Текст с <b onmouseover="__xss.push(\'b\')">вграден</b> HTML и <img src=x onerror=__xss.push("inline")>.',
  '',
  '- [js](javascript:__xss.push("md-js"))',
  '- [JS главни](JaVaScRiPt:__xss.push("md-JS"))',
  '- [js с ентити](javascript&#58;__xss.push("md-ent"))',
  '- [js в скоби](<javascript:__xss.push("md-angle")>)',
  '- [vbscript](vbscript:msgbox(1))',
  '- [data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '- [data svg](data:image/svg+xml,<svg onload=alert(1)>)',
  '- [file](file:///etc/passwd)',
  '- [blob](blob:https://example.org/x)',
  '- [протокол-относителен](//example.org/evil)',
  '- [наклонена](https:/\\example.org/evil)',
  '- [без наклонени](https:example.org/evil)',
  '- [http](http://example.org/plain)',
  '- [обхождане](lessons/../../index.html)',
  '- [обхождане 2](../LRN-OTHER/lessons/0001-a.html)',
  '- [хеш на приложението](#/settings)',
  '- [абсолютен път](/EasyLRN/#/settings)',
  '- [атрибут](https://example.org/a" onmouseover="__xss.push(\'attr\'))',
  '- [заглавие на линк](https://example.org/t "x\\" onmouseover=\\"__xss.push(1)")',
  '- [референтен][ref] и [референтен js][refjs]',
  '- <javascript:__xss.push("autolink-js")> и <https://example.org/auto>',
  '- голият адрес https://example.org/bare става линк',
  '- ![картинка js](javascript:__xss.push("img-js")) ![картинка](https://example.org/img.png)',
  '- [<img src=x onerror=__xss.push("in-link")>](https://example.org/in-link)',
  '- `<script>__xss.push("code")</script>`',
  '',
  '```html',
  '<script>__xss.push("fence")</script>',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| <img src=x onerror=__xss.push("td")> | [js](javascript:__xss.push("td-js")) |',
  '',
  '[ref]: https://example.org/ref',
  '[refjs]: javascript:__xss.push("ref-js")',
].join('\n');

test.describe('T012-S security of the course screen', () => {
  test('T012-S1 hostile Markdown in MISSION, RESOURCES and NOTES: nothing runs, nothing loads, only https:// and course links stay links', async ({ page }) => {
    await page.evaluate(() => { window.__xss = []; });
    await importCourse(page, 'LRN-XSS', {
      'INDEX.md': indexMd('LRN-XSS', ['0001']),
      'MISSION.md': `${HOSTILE_MD}\n\nМАРКЕР-НА-МИСИЯТА`,
      'RESOURCES.md': HOSTILE_MD.replace('# Мисия', '# Ресурси'),
      'NOTES.md': `${HOSTILE_MD.replace('# Мисия', '# Бележки')}\n\nМАРКЕР-НА-БЕЛЕЖКИТЕ`,
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-XSS');
    const url = page.url();
    await course(page).locator('[data-section="resources"] summary').click();
    await expect(course(page).locator('[data-field="resources-text"]')).toBeVisible();
    // D-038: the mission and the notes are not on the screen at all (only the course name, from MISSION's heading).
    await expect(course(page).locator('[data-section="mission"], [data-section="notes"], [data-field="mission-text"], [data-field="notes-text"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('МАРКЕР-НА-МИСИЯТА');
    await expect(page.locator('body')).not.toContainText('МАРКЕР-НА-БЕЛЕЖКИТЕ');
    // Hover and focus everything, then wait for a refresh/redirect that should not come.
    for (const el of (await course(page).locator('.md *').all()).slice(0, 150)) await el.hover({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);

    const audit = await mdAudit(page);
    expect(audit.docs).toBe(1); // RESOURCES only (D-038)
    expect(audit.tags.filter((t) => !ALLOWED.has(t))).toEqual([]);
    // Attributes: only href/title/start/type/checked/disabled from DOMPurify + what the app adds.
    expect(audit.attrs.filter((a) => !['href', 'start', 'type', 'checked', 'disabled', 'target', 'rel', 'referrerpolicy', 'class'].includes(a))).toEqual([]);
    for (const href of audit.hrefs) expect(href, href).toMatch(/^(https:\/\/[^\s"]+|#\/c\/LRN-XSS\/read\/0001)$/);
    // Every https link opens outside, without opener and referrer.
    const ext = await course(page).locator('.md a[href^="https:"]').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.target, a.rel, a.referrerPolicy]));
    expect(ext.length).toBeGreaterThan(0);
    for (const [href, target, rel, ref] of ext) expect([href, target, rel, ref]).toEqual([href, '_blank', 'noopener noreferrer', 'no-referrer']);
    // The https links that stay are exactly the harmless ones (no "https:/\" or "https:" without slashes, no http:).
    const kept = new Set(ext.map(([h]) => h));
    for (const bad of ['https://example.org/evil', 'http://example.org/plain', 'https://example.org/pixel.png', 'https://example.org/img.png']) expect(kept.has(bad), bad).toBe(false);
    for (const ok of ['https://example.org/ref', 'https://example.org/auto', 'https://example.org/bare', 'https://example.org/in-link']) expect(kept.has(ok), ok).toBe(true);
    // No element of the whole page came from the Markdown: no img/svg/iframe/form/style/meta/base/object.
    await expect(page.locator('body img, body svg:not([aria-hidden]) script, body iframe, body form, body style, body meta, body base, body object, body embed, body link')).toHaveCount(0);
    await expect(page.locator('[style], [onerror], [onload], [onclick], [onmouseover], [ontoggle], [onfocus]')).toHaveCount(0);
    // The raw HTML is shown as text (the user sees what is in the file).
    await expect(course(page).locator('[data-field="resources-text"]')).toContainText('<script>__xss.push("script")</script>');
    // The title (from the first heading) is text too.
    await expect(course(page).locator('[data-field="course-title"]')).toContainText('<img src=x onerror=');
    // The page still looks like the app (the <style> did not hide everything).
    await expect(course(page).locator('[data-section="lessons"]')).toBeVisible();
    // Clicking every link that stays: https opens a new page (aborted by the route), the course link opens the reader.
    const popup = page.waitForEvent('popup', { timeout: 5000 });
    await course(page).locator('[data-field="resources-text"] a[href="https://example.org/ref"]').click();
    const p = await popup;
    // The new page is aborted by the test route (no network to example.org): an error page, never the app.
    expect(p.url()).not.toContain('localhost');
    await p.close();
    external = external.filter((u) => u !== 'https://example.org/ref'); // the click above, by the user
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
  });

  test('T012-S2 hostile INDEX.md: titles of rows and of "План" are text; odd plan lines; no planned item is a link', async ({ page }) => {
    await page.evaluate(() => { window.__xss = []; });
    const index = [
      '# LRN-IDX: индекс',
      '## Уроци',
      '| # | Заглавие |',
      '|---|---|',
      '| 0001 | <img src=x onerror="__xss.push(\'row\')"> ред |',
      '| 0004 | Планиран в таблицата <script>__xss.push("row2")</script> |',
      '| 0004 | Дубликат на ред 0004 |',
      '## Справочници',
      '| # | Заглавие |',
      '|---|---|',
      '| R09 | Справочник, който още го няма |',
      '## План',
      '- 0001: вече е импортиран (не трябва да е „скоро“)',
      '- 0002: <img src=x onerror="__xss.push(\'plan\')"> зелен',
      '- 0002: дубликат на 0002',
      '- 0004: и в таблицата, и в плана',
      '- 0006a: с буква',
      '- R02 — справочник от плана',
      '* 0007 – с тире и звезда',
      '- без номер',
      '- 12345: пет цифри',
      '- [0008](javascript:__xss.push("plan-link")): линк в плана',
      '- 0009: [линк](javascript:__xss.push("plan-link2"))',
    ].join('\n');
    await importCourse(page, 'LRN-IDX', {
      'INDEX.md': index,
      'MISSION.md': '# Мисия: Индекс\n\nТекст.',
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-IDX');
    const planned = course(page).locator('[data-planned]');
    const numbers = await planned.evaluateAll((els) => els.map((e) => e.dataset.planned));
    console.log(`T012-S2 planned: ${JSON.stringify(numbers)}; texts: ${JSON.stringify(await planned.allTextContents())}`);
    // Each planned number once; the imported 0001 is not "скоро".
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).not.toContain('0001');
    for (const n of ['0002', '0004', '0006a', '0007', 'R02', 'R09']) expect(numbers, n).toContain(n);
    await expect(planned.locator('a')).toHaveCount(0);
    await expect(course(page).locator('[data-section="references"] [data-planned]')).toHaveCount(2);
    await expect(course(page).locator('img, script, [onerror]')).toHaveCount(0);
    await expect(planned.filter({ hasText: '0002' })).toContainText('<img src=x');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
    // Still exactly one "Уроци".
    expect(await course(page).getByText(/^уроци$/i).count()).toBe(1);
  });

  test('T012-S3 a course link in the Markdown only opens a lesson of THIS course; path tricks are dead text', async ({ page }) => {
    await importCourse(page, 'LRN-OTHER', { 'INDEX.md': indexMd('LRN-OTHER', ['0001']), 'lessons/0001-a.html': lessonHtml('Чужд урок') });
    await importCourse(page, 'LRN-LNK', {
      'INDEX.md': indexMd('LRN-LNK', ['0001']),
      // T-011-fix: in RESOURCES.md (MISSION.md is not shown since D-038); the same links.
      'RESOURCES.md': [
        '# Ресурси: Линкове',
        '[1](lessons/0001-a.html) [2](./lessons/0001-a.html) [3](lessons/0001-a.html#sec) [4](lessons/0001-a.html?x=1)',
        '[5](lessons/0001%2Da.html) [6](LESSONS/0001-a.html) [7](../LRN-OTHER/lessons/0001-a.html) [8](/lessons/0001-a.html)',
        '[9](lessons/./0001-a.html) [10](lessons/x/../0001-a.html) [11](lessons/0001-a.html/) [12](%2E%2E/LRN-OTHER/lessons/0001-a.html)',
      ].join('\n'),
      'lessons/0001-a.html': lessonHtml('Свой урок'),
    });
    await openCourse(page, 'LRN-LNK');
    await course(page).locator('[data-section="resources"] summary').click();
    const links = await course(page).locator('[data-field="resources-text"] a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    console.log(`T012-S3 links: ${JSON.stringify(links)}`);
    for (const [, href] of links) expect(href).toBe('#/c/LRN-LNK/read/0001');
    const texts = links.map(([t]) => t);
    for (const t of ['1', '2', '3', '4']) expect(texts).toContain(t);
    for (const t of ['7', '8', '12']) expect(texts).not.toContain(t);
    await course(page).locator('[data-field="resources-text"] a', { hasText: /^1$/ }).click();
    await expect(page).toHaveURL(/#\/c\/LRN-LNK\/read\/0001$/);
    await waitReady(page);
    await expect(page.frameLocator('iframe.lesson-frame').locator('h1')).toHaveText('Свой урок');
  });

  test('T012-D1 (fixed in 0.8.1): a malformed %-escape in a relative link of MISSION/RESOURCES/NOTES does not break the course screen', async ({ page }) => {
    const md = (title) => `# ${title}\n\nВиж [източника](sources/100%.pdf), [x](%zz) и [урока](lessons/0001-a.html).`;
    await importCourse(page, 'LRN-PCT', {
      'INDEX.md': indexMd('LRN-PCT', ['0001']),
      'MISSION.md': md('Мисия: Процент'),
      'RESOURCES.md': md('Ресурси'),
      'NOTES.md': md('Бележки'),
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await page.goto('./#/c/LRN-PCT');
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А'], { timeout: 5000 });
    // RESOURCES is shown: the broken links are dead text, the good course link stays a link.
    const res = course(page).locator('[data-field="resources-text"]');
    await expect(res).toContainText('източника');
    await expect(res.locator('a')).toHaveCount(1);
    await expect(res.locator('a')).toHaveAttribute('href', '#/c/LRN-PCT/read/0001');
    await expect(res.locator('.md__dead-link')).toHaveText(['източника', 'x']);
    // MISSION/NOTES: not shown (D-038); the screen works.
    await expect(course(page).locator('[data-section="mission"], [data-section="notes"]')).toHaveCount(0);
    await expect(course(page).locator('[data-action="continue"]')).toBeVisible();
  });

  test('T012-D2 (fixed in 0.8.1): a very deep blockquote (3000 ">") in MISSION.md or RESOURCES.md does not break the course screen', async ({ page }) => {
    await importCourse(page, 'LRN-DEEP', {
      'INDEX.md': indexMd('LRN-DEEP', ['0001']),
      'MISSION.md': `# Мисия: Дълбоко\n\n${'> '.repeat(3000)}дълбоко`,
      'RESOURCES.md': `# Ресурси\n\n${'> '.repeat(3000)}дълбоко в ресурсите`,
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await page.goto('./#/c/LRN-DEEP');
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А'], { timeout: 5000 });
    // The resources still show their text (the nesting is capped).
    await course(page).locator('[data-section="resources"] summary').click();
    await expect(course(page).locator('[data-field="resources-text"]')).toContainText('дълбоко в ресурсите');
  });

  test('T012-I6 absurd nesting (800 quotes, 300 list levels) renders and the screen stays usable (it scrolls sideways — information)', async ({ page }) => {
    await importCourse(page, 'LRN-NEST', {
      'INDEX.md': indexMd('LRN-NEST', ['0001']),
      // T-011-fix: in RESOURCES.md (MISSION.md is not shown since D-038).
      'RESOURCES.md': `# Ресурси: Вложено\n\n${'> '.repeat(800)}цитат\n\n${Array.from({ length: 300 }, (_, i) => `${'  '.repeat(i)}- ниво ${i}`).join('\n')}`,
      'NOTES.md': `# Бележки\n\n${'> '.repeat(800)}x`,
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-NEST');
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А']);
    await course(page).locator('[data-section="resources"] summary').click();
    await expect(course(page).locator('[data-field="resources-text"]')).toContainText('цитат');
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    // Every level indents a little; hundreds of levels are wider than any screen. Information only.
    console.log(`T012-I6 scrollWidth ${sw[0]} / clientWidth ${sw[1]}`);
    await expect(course(page).locator('[data-action="continue"]')).toBeVisible();
  });

  test('realistic nesting (8 list levels, 5 quotes, nested table in a list) at 360 px: no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const list = Array.from({ length: 8 }, (_, i) => `${'   '.repeat(i)}- ниво ${i} с малко текст за пренасяне на реда`).join('\n');
    await importCourse(page, 'LRN-NEST8', {
      'INDEX.md': indexMd('LRN-NEST8', ['0001']),
      // T-011-fix: in RESOURCES.md (MISSION.md is not shown since D-038); opened before measuring.
      'RESOURCES.md': `# Ресурси: Вложено\n\n${list}\n\n${'> '.repeat(5)}цитат с текст, който се пренася на няколко реда\n\n1. точка\n   1. подточка\n      - [ ] задача\n      - [x] готова`,
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-NEST8');
    await course(page).locator('[data-section="resources"] summary').click();
    await expect(course(page).locator('[data-field="resources-text"]')).toContainText('готова');
    const box = await layoutBox(page);
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW);
    expect(box.wide).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const SIZES = [
  { name: '1920×1200', width: 1920, height: 1200, columns: 2 },
  { name: '1280×800', width: 1280, height: 800, columns: 2 },
  { name: '1200×1920', width: 1200, height: 1920, columns: 2 },
  { name: '800×1280', width: 800, height: 1280, columns: 1 },
  { name: '360×800', width: 360, height: 800, columns: 1 },
];
const LONG_WORD = 'Свръхдългадумабезинтервали'.repeat(40);
const LONG_URL = `https://example.org/${'a'.repeat(600)}?q=${'b'.repeat(300)}`;

async function layoutBox(page) {
  return page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const cw = document.documentElement.clientWidth;
    return {
      main: r('.course__main'), side: r('.course__side'),
      scrollW: document.documentElement.scrollWidth, clientW: cw,
      bodyScrollW: document.body.scrollWidth,
      // Elements sticking out of the viewport, except those inside a scroll box of their own (pre, table).
      wide: [...document.querySelectorAll('[data-screen="course"] *')]
        .filter((e) => !e.closest('pre, table') && e.getBoundingClientRect().right > cw + 1)
        .map((e) => `${e.tagName}.${e.className}`).slice(0, 5),
    };
  });
}

test.describe('T-012 layout: two columns from 900 px, one below, never a horizontal scroll', () => {
  test('long titles, long words and URLs, wide table and code in the resources; 5 sizes; text at 160 %', async ({ page }) => {
    test.setTimeout(90000);
    const many = Array.from({ length: 12 }, (_, i) => pad4(i + 1));
    const files = {
      'INDEX.md': indexMd('LRN-WIDE', many, `\n## План\n- 0013: ${LONG_WORD}\n`),
      // The long course name comes from MISSION.md (the h1); the wide Markdown is in
      // RESOURCES.md since T-011-fix (MISSION.md is not shown, D-038).
      'MISSION.md': `# Мисия: ${LONG_WORD}\n\nТекст.`,
      'RESOURCES.md': [
        `# Ресурси`,
        `## ${LONG_WORD}`,
        `Дума: ${LONG_WORD}`,
        `Адрес: ${LONG_URL} и [линк](${LONG_URL})`,
        `\`${'код'.repeat(200)}\``,
        '```', 'x'.repeat(2000), '```',
        `| ${Array.from({ length: 30 }, (_, i) => `колона ${i}`).join(' | ')} |`,
        `|${'---|'.repeat(30)}`,
        `| ${Array.from({ length: 30 }, () => 'стойност').join(' | ')} |`,
        `- ${LONG_WORD}`,
        `> ${LONG_WORD}`,
        LONG_URL,
      ].join('\n\n'),
    };
    for (const n of many) files[`lessons/${n}-urok.html`] = lessonHtml(n === '0001' ? LONG_WORD : `Урок ${n} с дълго заглавие, което се пренася на няколко реда при тесен екран`);
    await importCourse(page, 'LRN-WIDE', files);
    // Some progress, so the meta line and "Продължи" have their longest form.
    await page.evaluate(async () => (await import('./src/db.js')).setLessonProgress('LRN-WIDE/lesson:0001', { status: 'started', lastOpenedAt: new Date().toISOString() }));
    for (const scale of ['100%', '160%']) {
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await openCourse(page, 'LRN-WIDE');
        await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
        await course(page).locator('[data-section="resources"] summary').click();
        const box = await layoutBox(page);
        const tag = `${size.name} @${scale}`;
        expect(box.scrollW, `${tag}: no horizontal scroll`).toBeLessThanOrEqual(box.clientW);
        expect(box.wide, `${tag}: nothing sticks out`).toEqual([]);
        if (size.columns === 2 && scale === '100%') {
          expect(box.side.left, `${tag}: side column to the right`).toBeGreaterThanOrEqual(box.main.right);
          expect(Math.abs(box.side.top - box.main.top), `${tag}: side by side`).toBeLessThan(2);
        } else if (size.columns === 1) {
          // T-011-fix: one column puts the side (progress, "Продължи", activity, resources) above the lessons.
          expect(box.main.top, `${tag}: one column`).toBeGreaterThanOrEqual(box.side.bottom - 1);
        }
        if (scale === '160%' && size.width >= 900) console.log(`T012 ${tag}: columns ${box.side.left >= box.main.right ? 2 : 1}`);
      }
    }
  });

  test('the breakpoint is 900 px: 899 → one column, 900 → two', async ({ page }) => {
    await importDemo(page);
    for (const [w, cols] of [[899, 1], [900, 2], [901, 2]]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await openCourse(page);
      const box = await layoutBox(page);
      // The breakpoint is a CSS media query on the viewport width (incl. a scroll bar, none here).
      expect(box.side.left >= box.main.right ? 2 : 1, `${w}px`).toBe(cols);
      expect(box.scrollW).toBeLessThanOrEqual(box.clientW);
    }
  });

  test('200 lessons + 20 planned: rendered fast, one "Уроци", progress 0 of 200, no horizontal scroll at 360 px', async ({ page }) => {
    test.setTimeout(90000);
    const nums = Array.from({ length: 200 }, (_, i) => pad4(i + 1));
    const planned = Array.from({ length: 20 }, (_, i) => `- ${pad4(201 + i)}: план ${i + 1}`).join('\n');
    const files = { 'INDEX.md': indexMd('LRN-BIG', nums, `\n## План\n${planned}\n`), 'MISSION.md': '# Мисия: Голям курс\n\nМного уроци.' };
    for (const n of nums) files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n}`);
    await importCourse(page, 'LRN-BIG', files);
    const t0 = Date.now();
    await openCourse(page, 'LRN-BIG');
    await expect(course(page).locator('[data-lesson]')).toHaveCount(200);
    const ms = Date.now() - t0;
    console.log(`T012 200 lessons: course screen in ${ms} ms`);
    expect(ms).toBeLessThan(5000);
    await expect(course(page).locator('[data-planned]')).toHaveCount(20);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 200 урока');
    await expect(course(page).locator('progress')).toHaveAttribute('max', '200');
    expect(await course(page).getByText(/^уроци$/i).count()).toBe(1);
    // The order is the INDEX order.
    const order = await course(page).locator('[data-lesson] .import__num').allTextContents();
    expect(order).toEqual(nums);
    await page.setViewportSize({ width: 360, height: 800 });
    const box = await layoutBox(page);
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW);
    // The courses list shows it too.
    await page.goto('./#/');
    await expect(page.locator('[data-course="LRN-BIG"] [data-field="course-progress"]')).toHaveText('Завършени: 0 от 200');
  });

  test('a 100 KB RESOURCES.md (and MISSION.md, not shown) renders in reasonable time and does not widen the page', async ({ page }) => {
    const para = 'Измислен абзац за мисията на курса, който се повтаря много пъти, за да стане файлът голям. ';
    const md = `# Мисия: Голяма\n\n${Array.from({ length: 900 }, (_, i) => `${i % 50 === 0 ? `## Раздел ${i}\n\n` : ''}${para}${i % 7 === 0 ? `**${LONG_WORD.slice(0, 200)}**` : ''}`).join('\n\n')}`;
    expect(md.length).toBeGreaterThan(100000);
    // T-011-fix: the big document is RESOURCES.md (MISSION.md is not shown since D-038).
    await importCourse(page, 'LRN-HUGE', { 'INDEX.md': indexMd('LRN-HUGE', ['0001']), 'MISSION.md': md, 'RESOURCES.md': md.replace('# Мисия: Голяма', '# Ресурси'), 'lessons/0001-a.html': lessonHtml('Урок А') });
    const t0 = Date.now();
    await openCourse(page, 'LRN-HUGE');
    await course(page).locator('[data-section="resources"] summary').click();
    await expect(course(page).locator('[data-field="resources-text"] h3').first()).toHaveText('Раздел 0');
    const ms = Date.now() - t0;
    console.log(`T012 100 KB resources: ${ms} ms`);
    expect(ms).toBeLessThan(5000);
    const box = await layoutBox(page);
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW);
    // Folding a huge block works.
    await course(page).locator('[data-section="resources"] summary').click();
    await expect(course(page).locator('[data-field="resources-text"]')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Edge courses
// ---------------------------------------------------------------------------
test.describe('T-012 edge courses', () => {
  test('no MISSION, no lessons (INDEX.md and a quiz only): clear texts, no progress bar, no "Продължи", nothing broken', async ({ page }) => {
    // A ZIP with only quizzes/ is refused by the import ("не прилича на курс"); INDEX.md alone makes it a course.
    await importCourse(page, 'LRN-QONLY', {
      'INDEX.md': '# LRN-QONLY: индекс\n\nСамо тест.\n',
      'quizzes/0001-1-test.json': JSON.stringify({ lesson: '0001', title: 'Самотен тест', questions: [{ q: 'Да?', options: ['Да', 'Не'], answer: 0 }] }),
    });
    await openCourse(page, 'LRN-QONLY');
    // D-040 (T-057): the quiz without a lesson is in "Други тестове", in the same column.
    await expect(course(page).locator('[data-list="lessons"] > .empty')).toHaveText('В курса няма уроци.');
    await expect(course(page).locator('[data-section="other-quizzes"] h2')).toHaveText('Други тестове');
    await expect(course(page).locator('progress, [data-action="continue"], [data-section="lessons"], [data-section="references"]')).toHaveCount(0);
    await expect(course(page).locator('[data-list="quizzes"] [data-quiz]')).toHaveCount(1);
    // D-038: no mission block at all (before: "Курсът няма MISSION.md."); the h1 is the course id.
    await expect(course(page).locator('[data-section="mission"]')).toHaveCount(0);
    await expect(course(page).locator('h1[data-field="course-title"]')).toHaveText('LRN-QONLY');
    await expect(course(page).locator('[data-field="activity-empty"]')).toBeVisible();
    // The quiz still works from here; its activity is listed.
    await course(page).locator('a.quiz-list__link').click();
    await page.locator('.quiz__option').first().click();
    await openCourse(page, 'LRN-QONLY');
    await expect(course(page).locator('[data-list="activity"]')).toContainText('Тест „Самотен тест“');
    await page.goto('./#/');
    // No lessons → no progress line on the card (and no "0 от 0").
    await expect(page.locator('[data-course="LRN-QONLY"]')).toBeVisible();
    await expect(page.locator('[data-course="LRN-QONLY"] [data-field="course-progress"]')).toHaveCount(0);
  });

  test('only references: no "Уроци", no lesson progress bar, "Започни: справочник R01"; opening it is "◐" and "Продължи"', async ({ page }) => {
    await importCourse(page, 'LRN-REF', {
      'INDEX.md': '# LRN-REF: индекс\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Първи |\n| R02 | Втори |\n',
      'MISSION.md': '# Мисия: Справочници\n\nСамо справочници.',
      'reference/R01-a.html': lessonHtml('Първи справочник'),
      'reference/R02-b.html': lessonHtml('Втори справочник'),
    });
    await openCourse(page, 'LRN-REF');
    await expect(course(page).locator('[data-section="lessons"]')).toHaveCount(0);
    await expect(course(page).locator('[data-section="references"] [data-lesson]')).toHaveCount(2);
    await expect(course(page).locator('progress')).toHaveCount(0);
    const go = course(page).locator('[data-action="continue"]');
    await expect(go).toHaveText('Започни: справочник R01 — Първи справочник');
    await course(page).locator('a.lesson-link', { hasText: 'Втори' }).click();
    await waitReady(page);
    await page.goBack();
    await expect(item(page, 'R02')).toHaveAttribute('data-status', 'started');
    await expect(go).toHaveText('Продължи: справочник R02 — Втори справочник');
    // A reference can be marked as finished too, but it is not counted as a lesson.
    await go.click();
    await waitReady(page);
    await page.locator('[data-action="complete"]').click();
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(item(page, 'R02')).toHaveAttribute('data-status', 'done');
    await expect(course(page).locator('progress')).toHaveCount(0);
  });

  test('a planned-only course (INDEX with "План", no lesson files): "скоро" items under "Уроци", no "Започни"', async ({ page }) => {
    await importCourse(page, 'LRN-PLAN', {
      'INDEX.md': '# LRN-PLAN: индекс\n\n## План\n- 0001: първи\n- 0002: втори\n',
      'MISSION.md': '# Мисия: План\n\nПредстои.',
    });
    await openCourse(page, 'LRN-PLAN');
    await expect(course(page).locator('[data-section="lessons"] [data-planned]')).toHaveCount(2);
    await expect(course(page).locator('[data-action="continue"], progress, a.lesson-link')).toHaveCount(0);
    expect(await course(page).getByText(/^уроци$/i).count()).toBe(1);
  });

  test('re-import: an unchanged and a CHANGED lesson keep "завършен"; a renamed lesson file is the same lesson (T012-I4, 0.8.1)', async ({ page }) => {
    await importDemo(page);
    await answerAll(page, 'LRN-DEMO'); // D-040 (T-057): ● = marked AND all quizzes of the lesson answered
    await page.evaluate(async (id) => (await import('./src/db.js')).setLessonProgress(id, { status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T09:00:00.000Z', scrollY: 321 }), DEMO_LESSON);
    const path = 'lessons/0001-vidove-chay.html';
    const changed = strToU8(new TextDecoder().decode(FILES[path]).replace('</h1>', '</h1><p>Нов абзац.</p>'));
    const summary = await importDemo(page, { ...FILES, [path]: changed });
    expect(summary).toMatch(/промен/i);
    expect(await progressOf(page, DEMO_LESSON)).toMatchObject({ status: 'done', completedAt: '2026-11-18T10:00:00.000Z', scrollY: 321 });
    await openCourse(page);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    // T-011-fix: a renamed file (same number) is the same lesson: one "0001", with its progress.
    const renamed = { ...FILES };
    delete renamed[path];
    renamed['lessons/0001-vidove-chay-v2.html'] = changed;
    await importDemo(page, renamed);
    await openCourse(page);
    const zeros = course(page).locator('[data-section="lessons"] [data-lesson] .import__num', { hasText: '0001' });
    console.log(`T012-I4 after renaming the file of 0001: ${await zeros.count()} entries "0001"`);
    expect(await zeros.count()).toBe(1);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    expect(await progressOf(page, 'LRN-DEMO/lesson:0001')).toMatchObject({ status: 'done', completedAt: '2026-11-18T10:00:00.000Z', scrollY: 321 });
    // "Продължи" never points to nothing.
    const href = await course(page).locator('[data-action="continue"]').getAttribute('href');
    await page.goto(`./${href}`);
    await waitReady(page);
  });

  test('a deleted course: the course screen and the card say so, a re-import brings it back with its progress', async ({ page }) => {
    await importDemo(page);
    await answerAll(page, 'LRN-DEMO'); // D-040 (T-057): ● = marked AND all quizzes of the lesson answered
    await page.evaluate(async (id) => (await import('./src/db.js')).setLessonProgress(id, { status: 'done', completedAt: new Date().toISOString() }), DEMO_LESSON);
    await page.evaluate(async () => { const db = await import('./src/db.js'); await db.remove(db.STORES.courses, 'LRN-DEMO'); });
    await page.goto('./#/c/LRN-DEMO');
    await expect(course(page).locator('[data-list="lessons"]')).toHaveText('Курсът още не е импортиран.');
    await expect(course(page).locator('[data-action="continue"], [data-section="mission"]')).toHaveCount(0);
    await page.goto('./#/');
    await expect(page.locator('[data-course="LRN-DEMO"]')).toHaveCount(0);
    await importDemo(page);
    await openCourse(page);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
  });

  test('two courses: the progress of one never shows in the other (same lesson numbers)', async ({ page }) => {
    for (const id of ['LRN-ONE', 'LRN-TWO']) {
      await importCourse(page, id, {
        'INDEX.md': indexMd(id, ['0001', '0002']),
        'MISSION.md': `# Мисия: ${id}\n\nТекст.`,
        'lessons/0001-a.html': lessonHtml(`${id} първи`),
        'lessons/0002-b.html': lessonHtml(`${id} втори`),
      });
    }
    await page.goto('./#/c/LRN-ONE/read/0002');
    await waitReady(page);
    await page.locator('[data-action="complete"]').click();
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await openCourse(page, 'LRN-TWO');
    await expect(course(page).locator('.course-item[data-status="new"] [data-lesson]')).toHaveCount(2);
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Започни: урок 0001 — LRN-TWO първи');
    await expect(course(page).locator('[data-field="activity-empty"]')).toBeVisible();
    await openCourse(page, 'LRN-ONE');
    await expect(item(page, '0002')).toHaveAttribute('data-status', 'done');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Продължи: урок 0002 — LRN-ONE втори');
    await page.goto('./#/');
    await expect(page.locator('[data-course="LRN-ONE"] [data-field="course-progress"]')).toHaveText('Завършени: 1 от 2 · последно: урок 0002');
    await expect(page.locator('[data-course="LRN-TWO"] [data-field="course-progress"]')).toHaveText('Завършени: 0 от 2');
  });

  test('"Започни" skips finished lessons; when all are finished and none opened it still points to a lesson', async ({ page }) => {
    await importCourse(page, 'LRN-SEQ', {
      'INDEX.md': indexMd('LRN-SEQ', ['0001', '0002', '0003']),
      'lessons/0001-a.html': lessonHtml('Първи'), 'lessons/0002-b.html': lessonHtml('Втори'), 'lessons/0003-c.html': lessonHtml('Трети'),
    });
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      await db.setLessonProgress('LRN-SEQ/lesson:0001', { status: 'done' });
    });
    await openCourse(page, 'LRN-SEQ');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Започни: урок 0002 — Втори');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 3 урока');
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      for (const p of ['0002-b', '0003-c']) await db.setLessonProgress(`LRN-SEQ/lesson:${p.slice(0, 4)}`, { status: 'done' });
    });
    await openCourse(page, 'LRN-SEQ');
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 3 от 3 урока');
    await expect(course(page).locator('progress')).toHaveAttribute('value', '3');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText(/^Започни: урок 0001/);
    // A corrupted status is shown as "нов", never breaks the screen.
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      await db.update(db.STORES.lessons, 'LRN-SEQ/lesson:0001', (l) => ({ progress: { ...l.progress, status: 'bogus', lastOpenedAt: 'not a date' } }));
    });
    await openCourse(page, 'LRN-SEQ');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'new');
  });
});

// ---------------------------------------------------------------------------
// Progress, navigation, offline, two tabs
// ---------------------------------------------------------------------------
test.describe('T-012 progress and navigation', () => {
  test('back and forward: the course screen shows the new status at once; forward reopens the reader in the same state', async ({ page }) => {
    await importDemo(page);
    await answerAll(page, 'LRN-DEMO'); // D-040 (T-057): ● = marked AND all quizzes of the lesson answered
    await openCourse(page);
    await course(page).locator('a.lesson-link', { hasText: 'Какви видове чай' }).click();
    await waitReady(page);
    await page.locator('[data-action="complete"]').click();
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO$/);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await page.goForward();
    await expect(page).toHaveURL(/read\/0001$/);
    await waitReady(page);
    await expect(page.locator('[data-action="complete"]')).toHaveText('✓ Завършен');
    await page.goBack();
    await page.goBack();
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await expect(page.locator('[data-course="LRN-DEMO"] [data-field="course-progress"]')).toHaveText('Завършени: 1 от 1 · последно: урок 0001');
  });

  test('"Маркирай като завършен": a double press and five fast presses end in a state where the button and the store agree', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await waitReady(page);
    const btn = page.locator('[data-action="complete"]');
    await btn.dblclick();
    await page.waitForTimeout(500);
    const agree = async () => {
      const pressed = await btn.getAttribute('aria-pressed');
      const st = (await progressOf(page, DEMO_LESSON)).status;
      return `${pressed}/${st}`;
    };
    const a = await agree();
    expect(['true/done', 'false/started']).toContain(a);
    for (let i = 0; i < 5; i++) await btn.click({ delay: 0, noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(800);
    const b = await agree();
    console.log(`T012 double press → ${a}; then 5 presses → ${b}`);
    expect(['true/done', 'false/started']).toContain(b);
    await page.reload();
    await waitReady(page);
    expect((await agree()).split('/')[0]).toBe(b.split('/')[0]);
  });

  test('keyboard only: Tab reaches "Продължи", the lessons and the fold buttons; Space/Enter fold; the reader button works with Space', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const e = document.activeElement;
        return e ? `${e.tagName}|${(e.textContent || '').trim().slice(0, 30)}|${e.dataset.action || ''}` : '';
      });
      seen.push(f);
    }
    const has = (re) => seen.some((s) => re.test(s));
    expect(has(/\|continue$/), seen.join('\n')).toBe(true);
    expect(has(/^A\|0001 Какви видове чай/)).toBe(true);
    expect(has(/^SUMMARY\|Мисия/)).toBe(false); // D-038: no mission block
    expect(has(/^SUMMARY\|Ресурси/)).toBe(true);
    // T-011-fix: the side column (progress, "Продължи", activity, resources) comes first in
    // the DOM — on a narrow screen it is on top — so: "Продължи", then "Ресурси", then the lessons.
    const idx = (re) => seen.findIndex((s) => re.test(s));
    expect(idx(/\|continue$/)).toBeLessThan(idx(/^SUMMARY\|Ресурси/));
    expect(idx(/^SUMMARY\|Ресурси/)).toBeLessThan(idx(/^A\|0001 Какви/));
    // Space and Enter fold/unfold the resources.
    const res = course(page).locator('[data-section="resources"]');
    await res.locator('summary').focus();
    await page.keyboard.press('Space');
    await expect(res).toHaveAttribute('open', '');
    await page.keyboard.press('Enter');
    await expect(res).not.toHaveAttribute('open', /.*/);
    // The reader button with the keyboard; the status message is announced (role=status).
    await course(page).locator('a.lesson-link', { hasText: 'Какви видове чай' }).focus();
    await page.keyboard.press('Enter');
    await waitReady(page);
    const btn = page.locator('[data-action="complete"]');
    await btn.focus();
    await page.keyboard.press('Space');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Урокът е отбелязан като завършен.' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '✓ Завършен', pressed: true })).toBeVisible();
  });

  test('headings: h1 (the course name) then h2 per section (no skipped level); the fold headings are named buttons with their state', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    const levels = await page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter((h) => h.offsetParent !== null || h.closest('details'))
      .map((h) => [Number(h.tagName[1]), h.textContent.trim()]));
    console.log(`T012 headings: ${JSON.stringify(levels)}`);
    expect(levels[0][0]).toBe(1);
    expect(levels.filter(([l]) => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i][0] - levels[i - 1][0], JSON.stringify(levels[i])).toBeLessThanOrEqual(1);
    // T012-I5 (fixed in 0.8.1): the h1 is the course name (from MISSION.md), the app bar shows the id as text.
    console.log(`T012-I5 h1 = "${levels[0][1]}", title = "${await course(page).locator('[data-field="course-title"]').textContent()}"`);
    expect(levels[0][1]).toBe('Основи на чая');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Основи на чая');
    // Headings are exposed to assistive technology (also those inside <summary>).
    for (const name of ['Уроци', 'Последни дейности', 'Ресурси']) {
      await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
    }
    for (const name of ['Мисия', 'Бележки на курса']) await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0); // D-038
    // The <summary> elements carry the expanded state (Chromium maps <details open> natively).
    const states = await page.evaluate(() => [...document.querySelectorAll('[data-screen="course"] details')].map((d) => [d.dataset.section, d.open]));
    expect(states).toEqual([['resources', false]]);
    // What Chromium gives to assistive technology: the <summary> is a disclosure button with "expanded".
    const cdp = await page.context().newCDPSession(page);
    const triangles = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes
      .filter((n) => n.role?.value === 'DisclosureTriangle' && !n.ignored)
      .map((n) => [n.name?.value, (n.properties || []).find((p) => p.name === 'expanded')?.value?.value]);
    const before = await triangles();
    console.log(`T012-I7 disclosure buttons: ${JSON.stringify(before)}`);
    expect(before.map(([, e]) => e)).toEqual([false]);
    // T012-I7 (fixed in 0.8.1): the name is the heading only, without the "▸" of the CSS.
    for (const [name] of before) expect(name).toBe('Ресурси');
    await course(page).locator('[data-section="resources"] summary').click();
    expect((await triangles()).map(([, e]) => e)).toEqual([true]);
  });

  test('recent activity: at most 6, newest first, with "днес"/"вчера"/date; links open the right thing', async ({ page }) => {
    const nums = Array.from({ length: 8 }, (_, i) => pad4(i + 1));
    const files = { 'INDEX.md': indexMd('LRN-ACT', nums), 'MISSION.md': '# Мисия: Дейности\n\nТекст.' };
    for (const n of nums) files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n}`);
    await importCourse(page, 'LRN-ACT', files);
    await page.evaluate(async (nums) => {
      const db = await import('./src/db.js');
      const now = Date.now();
      for (const [i, n] of nums.entries()) {
        await db.setLessonProgress(`LRN-ACT/lesson:${n}`, { status: 'started', lastOpenedAt: new Date(now - (i * 3 + 1) * 3600 * 1000 * 4).toISOString() });
      }
    }, nums);
    await openCourse(page, 'LRN-ACT');
    const rows = course(page).locator('[data-list="activity"] li');
    await expect(rows).toHaveCount(6);
    const texts = await rows.allTextContents();
    console.log(`T012 activity: ${JSON.stringify(texts)}`);
    expect(texts[0]).toContain('урок 0001');
    expect(texts[5]).toContain('урок 0006');
    expect(texts.join('\n')).toMatch(/(днес|вчера) \d\d:\d\d/);
    expect(texts.join('\n')).toMatch(/\d\d\.\d\d\.\d{4} \d\d:\d\d/);
    await rows.nth(2).locator('a').click();
    await expect(page).toHaveURL(/#\/c\/LRN-ACT\/read\/0003$/);
    await waitReady(page);
    await page.goBack();
    // Opening 0003 made it the newest.
    await expect(rows.first()).toContainText('урок 0003');
    await expect(course(page).locator('[data-action="continue"]')).toHaveText('Продължи: урок 0003 — Урок 0003');
  });

  test('offline: the course screen with the rendered resources, status and "Продължи" works without network (markdown.js in the shell)', async ({ page, context }) => {
    await importDemo(page);
    await answerAll(page, 'LRN-DEMO'); // D-040 (T-057): ● = marked AND all quizzes of the lesson answered
    const cached = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    for (const f of ['/EasyLRN/src/markdown.js', '/EasyLRN/vendor/marked.js', '/EasyLRN/vendor/purify.js', '/EasyLRN/src/screens/course.js']) expect(cached, f).toContain(f);
    await context.setOffline(true);
    await page.goto('./#/c/LRN-DEMO');
    await page.reload();
    // T-011-fix: the resources (MISSION.md is not shown since D-038).
    await expect(course(page).locator('[data-field="resources-text"] h3').first()).toHaveText('Основни');
    await course(page).locator('a.lesson-link', { hasText: 'Какви видове чай' }).click();
    await waitReady(page);
    await page.locator('[data-action="complete"]').click();
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await context.setOffline(false);
  });

  test('two tabs: a lesson finished in one tab shows as finished in the other after navigating; the other tab does not undo it', async ({ page, context }) => {
    await importDemo(page);
    await answerAll(page, 'LRN-DEMO'); // D-040 (T-057): ● = marked AND all quizzes of the lesson answered
    await openCourse(page);
    const other = await context.newPage();
    other.on('pageerror', (e) => problems.push(`other pageerror: ${e}`));
    await other.goto('./#/c/LRN-DEMO/read/0001');
    await waitReady(other);
    await other.locator('[data-action="complete"]').click();
    await expect(other.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    // The first tab opens the same lesson now: it must keep "завършен" (it reads the stored state).
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await waitReady(page);
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('./#/c/LRN-DEMO');
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await other.close();
  });

  test('a lesson opened and left at once still becomes "започнат"; the reader of an unknown lesson has no button', async ({ page }) => {
    await importDemo(page);
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await page.goto('./#/c/LRN-DEMO');
    await expect.poll(async () => (await progressOf(page, DEMO_LESSON)).status).toBe('started');
    await page.goto('./#/c/LRN-DEMO/read/9999');
    await expect(page.locator('[data-field="reader-content"]')).toContainText('не е намерен');
    await expect(page.locator('[data-action="complete"]')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------
test.describe('T-012 themes', () => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  /** Colors of the course screen, with the opacity of the planned items blended into the text color. */
  async function colors(page) {
    return page.evaluate(() => {
      const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const bg = rgb(getComputedStyle(document.body).backgroundColor);
      const eff = (sel) => {
        const el = document.querySelector(sel);
        const c = rgb(getComputedStyle(el).color);
        let a = 1;
        for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
        return c.map((v, i) => v * a + bg[i] * (1 - a));
      };
      return {
        bg,
        status: eff('.course-item:not(.course-item--planned) [data-field="lesson-meta"]'),
        progress: eff('[data-field="course-progress"]'),
        activity: eff('.activity__when, [data-field="activity-empty"]'),
        summary: eff('[data-section="resources"] summary h2'),
        external: eff('[data-section="resources"] a.md__external'),
        plannedTitle: eff('[data-planned] .course-item__title'),
        plannedMeta: eff('[data-planned] .course-item__meta'),
      };
    });
  }

  for (const theme of ['light', 'dark']) {
    test(`${theme}: the texts of the course screen have contrast ≥ 4.5 (without the planned items)`, async ({ page }) => {
      await importDemo(page);
      await page.evaluate(async () => (await import('./src/db.js')).setLessonProgress('LRN-DEMO/lesson:0001', { status: 'started', lastOpenedAt: new Date().toISOString() }));
      await page.evaluate(async (t) => (await import('./src/db.js')).saveSettings({ theme: t }), theme);
      await openCourse(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await course(page).locator('[data-section="resources"] summary').click();
      const c = await colors(page);
      for (const k of ['status', 'progress', 'activity', 'summary', 'external']) expect(contrast(c[k], c.bg), `${theme} ${k}`).toBeGreaterThanOrEqual(4.5);
    });

    test(`T012-D3 ${theme} (fixed in 0.8.1): the "Скоро — още не е импортиран" line of a planned lesson has contrast ≥ 4.5`, async ({ page }) => {
      await importDemo(page);
      await page.evaluate(async (t) => (await import('./src/db.js')).saveSettings({ theme: t }), theme);
      await openCourse(page);
      const c = await colors(page);
      console.log(`T012-D3 ${theme}: planned title ${contrast(c.plannedTitle, c.bg).toFixed(2)}, planned meta ${contrast(c.plannedMeta, c.bg).toFixed(2)}`);
      expect(contrast(c.plannedMeta, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.plannedTitle, c.bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
