// T-011-fix (developer, 0.8.1): fixes of the T-012 findings and D-038.
// - D-038: the course screen shows no mission (MISSION.md) and no course notes
//   (NOTES.md); the files stay in the course. The side column holds progress,
//   "Продължи", "Последни дейности" and "Ресурси" (balanced two columns from
//   900 px; one column below, the side on top);
// - T012-D1: a malformed %-escape in a link never breaks the screen (course
//   screen, router, lesson URLs);
// - T012-D2: very deep nesting in the Markdown never breaks the screen (capped
//   quotes; any other render error is a note in that block only);
// - T012-D3: the "Скоро" lines are ≥ 4.5:1 in both themes, without opacity;
// - T012-I4: a renamed lesson file (same number) is the same lesson: one row,
//   its progress, annotations and subtopics move to the new record;
// - T012-I5: the h1 is the course name (MISSION.md, else INDEX.md, else the id);
// - T012-I7: the fold button is named by its heading, without "▸";
// - T012-D4: a stale save of the threshold never overwrites a newer refusal.
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and small in-memory courses.
import { test, expect } from '@playwright/test';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
const DEMO_PATH = 'lessons/0001-vidove-chay.html';
// T-055 (D-039): lessons are keyed by course + number, not by path.
const DEMO_ID = 'LRN-DEMO/lesson:0001';

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

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    const s = await m.importCourse(list);
    return { text: m.describeSummary(s), lessons: s.lessons };
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page, files = FILES) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(files))]);
function importCourse(page, id, files) {
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
  return importFiles(page, [asFile(`${id}.zip`, makeZip(bytes, { root: id }))]);
}
const lessonHtml = (title) => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Измислен текст.</p></body></html>`);
const indexMd = (id, numbers, title = 'индекс') => `# ${id}: ${title}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${numbers.map((n) => `| ${n} | Урок ${n} |`).join('\n')}\n`;
const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id = 'LRN-DEMO') {
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });

test.describe('D-038: no mission and no notes; the side column', () => {
  test('mission and notes are not shown (also when hostile); nothing of them runs; the files stay in the course', async ({ page }) => {
    await page.evaluate(() => { window.__xss = []; });
    const hostile = (marker) => [
      '# Мисия: Чисто име',
      `${marker}`,
      '<img src=x onerror="__xss.push(1)"><script>__xss.push(2)</script>',
      '[js](javascript:__xss.push(3)) [pct](sources/100%.pdf)',
      `${'> '.repeat(4000)}дълбоко`,
    ].join('\n\n');
    await importCourse(page, 'LRN-NOMIS', {
      'INDEX.md': indexMd('LRN-NOMIS', ['0001']),
      'MISSION.md': hostile('МИСИЯ-ТЕКСТ'),
      'NOTES.md': hostile('БЕЛЕЖКИ-ТЕКСТ'),
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-NOMIS');
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А']);
    await expect(course(page).locator('details, .md, [data-section="mission"], [data-section="notes"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('МИСИЯ-ТЕКСТ');
    await expect(page.locator('body')).not.toContainText('БЕЛЕЖКИ-ТЕКСТ');
    await expect(page.locator('h1')).toHaveText('Чисто име');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
    const meta = await page.evaluate(async () => (await (await import('./src/db.js')).getCourse('LRN-NOMIS')).meta);
    expect(meta.mission).toContain('МИСИЯ-ТЕКСТ');
    expect(meta.notes).toContain('БЕЛЕЖКИ-ТЕКСТ');
  });

  test('two columns from 900 px: right = progress, "Продължи", activity, resources (in this order); the left is the lessons and quizzes', async ({ page }) => {
    await importDemo(page);
    for (const [w, hgt] of [[1920, 1200], [1200, 1920], [900, 1000]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await openCourse(page);
      const r = await page.evaluate(() => {
        const box = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, width: b.width }; };
        return {
          main: box('.course__main'), side: box('.course__side'),
          progress: box('[data-field="course-progress"]'), go: box('[data-action="continue"]'),
          activity: box('[data-section="activity"]'), resources: box('[data-section="resources"]'),
          lessons: box('[data-section="lessons"]'), quizzes: box('[data-list="quizzes"]'),
          inSide: ['[data-action="continue"]', '[data-field="course-progress"]', '[data-section="activity"]', '[data-section="resources"]']
            .map((s) => !!document.querySelector(s).closest('.course__side')),
          scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        };
      });
      const tag = `${w}×${hgt}`;
      expect(r.inSide, tag).toEqual([true, true, true, true]);
      expect(r.side.left, tag).toBeGreaterThanOrEqual(r.main.right);
      expect(Math.abs(r.side.top - r.main.top), tag).toBeLessThan(2);
      expect(r.main.width, tag).toBeGreaterThan(r.side.width);
      expect(r.progress.top, tag).toBeLessThan(r.go.top);
      expect(r.go.bottom, tag).toBeLessThanOrEqual(r.activity.top);
      expect(r.activity.bottom, tag).toBeLessThanOrEqual(r.resources.top);
      expect(r.lessons.bottom, tag).toBeLessThanOrEqual(r.quizzes.top);
      // "Продължи" is visible without scrolling, next to the first lessons.
      expect(r.go.bottom, tag).toBeLessThan(hgt);
      expect(r.scrollW, tag).toBeLessThanOrEqual(r.clientW);
    }
  });

  test('one column below 900 px: progress and "Продължи" on top, then activity and resources, then the lessons', async ({ page }) => {
    await importDemo(page);
    await page.setViewportSize({ width: 800, height: 1280 });
    await openCourse(page);
    const r = await page.evaluate(() => {
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      return [top('[data-action="continue"]'), top('[data-section="activity"]'), top('[data-section="resources"]'), top('[data-section="lessons"]'), top('[data-list="quizzes"]')];
    });
    for (let i = 1; i < r.length; i++) expect(r[i], JSON.stringify(r)).toBeGreaterThan(r[i - 1]);
    // DOM order = visual order (keyboard): "Продължи" is the first focusable thing of the screen.
    const first = await page.evaluate(() => document.querySelector('[data-screen="course"]').querySelector('a, button, summary')?.dataset.action);
    expect(first).toBe('continue');
  });
});

test.describe('T012-D1 / T012-D2: one bad document never breaks the screen', () => {
  test('malformed %-escapes in RESOURCES.md: dead text; good encoded course links stay links', async ({ page }) => {
    await importCourse(page, 'LRN-PCT2', {
      'INDEX.md': indexMd('LRN-PCT2', ['0001']),
      'RESOURCES.md': '# Ресурси\n\n[а](sources/100%.pdf) [б](%) [в](%E0%A4%A) [г](%zz/lessons/0001-a.html) [д](lessons/0001%2Da.html) [е](lessons/0001-a.html#%zz) [ж](https://example.org/%zz)',
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-PCT2');
    await course(page).locator('[data-section="resources"] summary').click();
    const res = course(page).locator('[data-field="resources-text"]');
    await expect(res.locator('.md__dead-link')).toHaveText(['а', 'б', 'в', 'г']);
    const links = await res.locator('a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    expect(links).toEqual([['д', '#/c/LRN-PCT2/read/0001'], ['е', '#/c/LRN-PCT2/read/0001'], ['ж', 'https://example.org/%zz']]);
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А']);
  });

  test('the router and the lesson URL parser survive malformed escapes', async ({ page }) => {
    await importCourse(page, 'LRN-PCT3', { 'INDEX.md': indexMd('LRN-PCT3', ['0001']), 'lessons/0001-a.html': lessonHtml('Урок А') });
    await page.goto('./#/c/LRN-PCT3/read/%zz');
    await expect(page.locator('[data-field="reader-content"]')).toContainText('не е намерен');
    await page.goto('./#/c/LRN-PCT3%');
    await expect(course(page)).toBeVisible();
    const parsed = await page.evaluate(async () => {
      const m = await import('./src/lesson-frame.js');
      return [m.parseCourseUrl(new URL('c/LRN-PCT3/lessons/100%.html', document.baseURI).href), m.parseCourseUrl('c/LRN-PCT3/%E0%A4%A')];
    });
    expect(parsed).toEqual([null, null]);
  });

  test('deep nesting: 5000 quotes and 3000 list levels are capped and shown quickly; nothing throws', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('./src/markdown.js');
      const deep = m.renderMarkdown(`${'> '.repeat(5000)}дълбоко`);
      let depth = 0;
      for (let e = deep.querySelector('blockquote'); e; e = e.querySelector(':scope > blockquote')) depth++;
      // Lists of thousands of levels, quotes mixed with lists: rendered or a note, never a throw.
      const list = m.renderMarkdown(Array.from({ length: 3000 }, (_, i) => `${'  '.repeat(i)}- ниво ${i}`).join('\n'));
      const mixed = m.renderMarkdown(`${'> - '.repeat(3000)}x`);
      return {
        depth, deepText: deep.textContent.includes('дълбоко'),
        list: list.textContent.includes('ниво 2999'), mixed: mixed.textContent.includes('x'),
        capped: [
          m.limitNesting(`${'>'.repeat(60)} a\n  >>> b`) === `${'> '.repeat(m.MAX_QUOTE_DEPTH)}a\n  >>> b`,
          m.limitNesting(`${' '.repeat(500)}- x\n${'\t'.repeat(10)}y`) === `${' '.repeat(m.MAX_INDENT)}- x\n${'\t'.repeat(10)}y`,
        ].every(Boolean),
        decode: [m.safeDecode('100%.pdf'), m.safeDecode('a%2Db')],
      };
    });
    expect(r.depth).toBe(50);
    expect(r.deepText).toBe(true);
    expect(r.list).toBe(true);
    expect(r.mixed).toBe(true);
    expect(r.capped).toBe(true);
    expect(r.decode).toEqual([null, 'a-b']);
  });

  test('a document that cannot be rendered shows a note and its plain text; the rest of the screen works', async ({ page }) => {
    // Force a render error from the parser: a Markdown that makes marked recurse on nested lists far beyond
    // the stack is not portable, so the course screen is checked with a stubbed parser failure instead.
    await importCourse(page, 'LRN-FAIL', {
      'INDEX.md': indexMd('LRN-FAIL', ['0001']),
      'RESOURCES.md': '# Ресурси\n\n<b>сурово</b> и [линк](https://example.org/x)',
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await page.addInitScript(() => {
      // Make DOMPurify fail once (as if the document were too deep): the block must fall back.
      const orig = DocumentFragment.prototype.querySelectorAll;
      let armed = true;
      DocumentFragment.prototype.querySelectorAll = function (sel) {
        if (armed && sel === 'input') { armed = false; throw new RangeError('Maximum call stack size exceeded (test)'); }
        return orig.call(this, sel);
      };
    });
    // A new document, so the init script runs (a hash change alone keeps the document).
    await page.goto('./#/c/LRN-FAIL');
    await page.reload();
    await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
    await course(page).locator('[data-section="resources"] summary').click();
    const res = course(page).locator('[data-field="resources-text"]');
    await expect(res.locator('.md__fallback-note')).toHaveText('Този текст не може да се покаже форматиран; показан е като обикновен текст.');
    await expect(res.locator('.md__plain')).toHaveText('<b>сурово</b> и [линк](https://example.org/x)');
    await expect(res.locator('a, b')).toHaveCount(0);
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А']);
    await expect(course(page).locator('[data-action="continue"]')).toBeVisible();
  });
});

test.describe('T012-D3, T012-I5, T012-I7', () => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const theme of ['light', 'dark']) {
    test(`${theme}: "Скоро" lines ≥ 4.5:1, no opacity on the planned item, still told apart from imported lessons`, async ({ page }) => {
      await importDemo(page);
      await page.evaluate(async (t) => (await import('./src/db.js')).saveSettings({ theme: t }), theme);
      await openCourse(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const c = await page.evaluate(() => {
        const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const el = document.querySelector('[data-planned]');
        const opacities = [];
        for (let e = el.querySelector('.course-item__meta'); e; e = e.parentElement) opacities.push(Number(getComputedStyle(e).opacity));
        const st = (sel) => getComputedStyle(el.querySelector(sel));
        return {
          bg: rgb(getComputedStyle(document.body).backgroundColor),
          title: rgb(st('.course-item__title').color), meta: rgb(st('.course-item__meta').color),
          italic: st('.course-item__meta').fontStyle, dashed: st('.course-item__mark').borderTopStyle,
          opacities,
          normalMeta: rgb(getComputedStyle(document.querySelector('.course-item:not([data-planned]) .course-item__meta')).color),
        };
      });
      expect(c.opacities.every((o) => o === 1)).toBe(true);
      expect(contrast(c.title, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.meta, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(c.italic).toBe('italic');
      expect(c.dashed).toBe('dashed');
      expect(c.meta).not.toEqual(c.normalMeta);
    });
  }

  test('the h1 is the course name: from MISSION.md, else INDEX.md, else the id; one h1; the card shows the same name', async ({ page }) => {
    await importDemo(page);
    await importCourse(page, 'LRN-IDXNAME', { 'INDEX.md': indexMd('LRN-IDXNAME', ['0001'], 'Име от индекса'), 'lessons/0001-a.html': lessonHtml('А') });
    await importCourse(page, 'LRN-NONAME', { 'INDEX.md': indexMd('LRN-NONAME', ['0001']), 'lessons/0001-a.html': lessonHtml('А') });
    for (const [id, name] of [['LRN-DEMO', 'Основи на чая'], ['LRN-IDXNAME', 'Име от индекса'], ['LRN-NONAME', 'LRN-NONAME']]) {
      await openCourse(page, id);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
      await expect(course(page).locator('h1[data-field="course-title"]')).toHaveText(name);
      // The app bar keeps the id, as text (not a heading) on this screen.
      await expect(page.locator('#app-bar-title')).toHaveText(id);
      expect(await page.locator('#app-bar-title').evaluate((e) => e.tagName)).toBe('P');
      if (name !== id) await expect(page).toHaveTitle(`${name} · EasyLRN`);
    }
    // Other screens get their h1 in the app bar back.
    await page.goto('./#/');
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    expect(await page.locator('#app-bar-title').evaluate((e) => e.tagName)).toBe('H1');
    await expect(page.locator('#app-bar-title')).toHaveText('EasyLRN');
    for (const [id, name] of [['LRN-DEMO', 'Основи на чая'], ['LRN-IDXNAME', 'Име от индекса'], ['LRN-NONAME', 'LRN-NONAME']]) {
      await expect(page.locator(`[data-course="${id}"] .card__title`)).toHaveText(name);
    }
    await page.goto('./#/c/LRN-DEMO/read/0001');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    expect(await page.locator('#app-bar-title').evaluate((e) => e.tagName)).toBe('H1');
  });

  test('courseName(): the rules (unit)', async ({ page }) => {
    const names = await page.evaluate(async () => {
      const { courseName } = await import('./src/course-import.js');
      return [
        courseName({ id: 'LRN-A', meta: { mission: '# Мисия: Име А', index: '# LRN-A: Друго' } }),
        courseName({ id: 'LRN-A', meta: { mission: '# Mission — Name A' } }),
        courseName({ id: 'LRN-A', meta: { mission: 'текст без заглавие', index: '# LRN-A: индекс' } }),
        courseName({ id: 'LRN-A', meta: { index: '# LRN-A — Курс по нещо' } }),
        courseName({ id: 'LRN-A', meta: { index: '# Индекс: Курс Б' } }),
        courseName({ id: 'LRN-A', meta: { index: '# LRN-A: Индексиране на данни' } }),
        courseName({ id: 'LRN-A', title: 'Записано', meta: {} }),
        courseName({ id: 'LRN-A' }),
        courseName({ id: 'LRN-A', meta: { mission: '## Мисия\n# Мисия:   ' } }),
      ];
    });
    expect(names).toEqual(['Име А', 'Name A', 'LRN-A', 'Курс по нещо', 'Курс Б', 'Индексиране на данни', 'Записано', 'LRN-A', 'LRN-A']);
  });

  test('the fold button is named "Ресурси" (the arrow is not read out) and carries its state', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    const cdp = await page.context().newCDPSession(page);
    const triangles = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes
      .filter((n) => n.role?.value === 'DisclosureTriangle' && !n.ignored)
      .map((n) => [n.name?.value, (n.properties || []).find((p) => p.name === 'expanded')?.value?.value]);
    expect(await triangles()).toEqual([['Ресурси', false]]);
    await page.getByRole('heading', { name: 'Ресурси' }).click();
    expect(await triangles()).toEqual([['Ресурси', true]]);
    // The arrow is still drawn.
    const arrow = await page.locator('[data-section="resources"] summary').evaluate((e) => getComputedStyle(e, '::before').content);
    expect(arrow).toContain('▸');
  });
});

test.describe('T012-I4: a renamed lesson file is the same lesson', () => {
  // T-055 (D-039): the lesson is its number, so a rename moves nothing: the
  // same record gets the new path (the old one in previousPaths) and keeps the
  // progress; annotations and subtopics keep pointing at the same id. No
  // soft-deleted `renamedTo` record any more.
  test('one row; progress, annotations (with their threads) and subtopics stay with the lesson (its number); no second record', async ({ page }) => {
    await importDemo(page);
    const ids = await page.evaluate(async (lessonId) => {
      const db = await import('./src/db.js');
      await db.setLessonProgress(lessonId, { status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T09:00:00.000Z', scrollY: 654 });
      const target = { type: 'lesson', id: lessonId };
      const sel = (exact) => ({ quote: { exact, prefix: '', suffix: '' }, position: { start: 0, end: exact.length } });
      const a = await db.createAnnotation({ courseId: 'LRN-DEMO', target, selector: sel('чай'), color: 'yellow' });
      const t = await db.createThread({ annotationId: a.id });
      const s = await db.createSubTopic({ courseId: 'LRN-DEMO', annotationId: a.id, parent: target, title: 'Тема', kind: 'термин', content: '' });
      return { a: a.id, t: t.id, s: s.id };
    }, DEMO_ID);
    const renamed = { ...FILES };
    renamed['lessons/0001-vidove-chay-novo.html'] = renamed[DEMO_PATH];
    delete renamed[DEMO_PATH];
    const summary = await importDemo(page, renamed);
    expect(summary.lessons.added).toEqual([]);
    expect(summary.lessons.changed).toEqual(['0001 Какви видове чай има?']);
    const NEW_ID = DEMO_ID;
    const after = await page.evaluate(async ({ ids, NEW_ID }) => {
      const db = await import('./src/db.js');
      const lessons = await db.listLessons('LRN-DEMO', { includeDeleted: true });
      const rec = await db.getLesson(NEW_ID);
      return {
        numbers: lessons.map((l) => l.number),
        progress: rec.progress,
        old: { path: rec.path, previousPaths: rec.previousPaths, renamedTo: rec.renamedTo ?? null, deleted: lessons.filter((l) => l.deleted).length },
        ann: (await db.getAnnotation(ids.a)).target,
        threads: (await db.threadsFor(ids.a)).map((t) => t.id),
        sub: await db.getSubTopic(ids.s).then((s) => [s.parent, s.rootLessonId]),
        onNew: (await db.annotationsFor({ type: 'lesson', id: NEW_ID })).map((a) => a.id),
      };
    }, { ids, NEW_ID });
    expect(after.numbers).toEqual(['0001', 'R01']);
    expect(after.progress).toMatchObject({ status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T09:00:00.000Z', scrollY: 654 });
    expect(after.old).toEqual({ path: 'lessons/0001-vidove-chay-novo.html', previousPaths: [DEMO_PATH], renamedTo: null, deleted: 0 });
    expect(after.ann).toEqual({ type: 'lesson', id: NEW_ID });
    expect(after.threads).toEqual([ids.t]);
    expect(after.sub).toEqual([{ type: 'lesson', id: NEW_ID }, NEW_ID]);
    expect(after.onNew).toEqual([ids.a]);
    await openCourse(page);
    await expect(course(page).locator('[data-section="lessons"] [data-lesson]')).toHaveText(['0001 Какви видове чай има?']);
    await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
    await expect(item(page, '0001').locator('[data-field="lesson-meta"]')).toContainText('1 маркировка · 1 въпрос · 1 тема');
    // "Продължи" opens the renamed file at the same place.
    await course(page).locator('[data-action="continue"]').click();
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    // The same import again: nothing changes.
    expect((await importDemo(page, renamed)).text).toMatch(/^Без промени/);
    // Renamed back: the same again, the progress follows.
    const back = await importDemo(page);
    expect(back.lessons.changed).toEqual(['0001 Какви видове чай има?']);
    expect(await page.evaluate(async (id) => (await (await import('./src/db.js')).getLesson(id)).progress.status, DEMO_ID)).toBe('done');
    await openCourse(page);
    await expect(course(page).locator('[data-section="lessons"] [data-lesson]')).toHaveCount(1);
  });

  // T-055 (D-039): two files with one number are refused (the whole import,
  // nothing written) instead of being imported as two lessons.
  test('ambiguous or partial imports change nothing: two new files with one number are refused; a part without the lesson keeps it', async ({ page }) => {
    await importCourse(page, 'LRN-REN', {
      'INDEX.md': indexMd('LRN-REN', ['0001', '0002']),
      'lessons/0001-a.html': lessonHtml('Първи'),
      'lessons/0002-b.html': lessonHtml('Втори'),
    });
    await page.evaluate(async () => (await import('./src/db.js')).setLessonProgress('LRN-REN/lesson:0001', { status: 'done' }));
    // A part (no INDEX.md) with 0002 only: 0001 stays as it is.
    await importCourse(page, 'LRN-REN', { 'lessons/0002-b.html': lessonHtml('Втори') });
    // Two new files with the number 0001 and the old one gone: which one is the lesson? The import is refused.
    await expect(importCourse(page, 'LRN-REN', {
      'INDEX.md': indexMd('LRN-REN', ['0001', '0002']),
      'lessons/0001-x.html': lessonHtml('Първи X'),
      'lessons/0001-y.html': lessonHtml('Първи Y'),
      'lessons/0002-b.html': lessonHtml('Втори'),
    })).rejects.toThrow('В курса има два урока с номер 0001: lessons/0001-x.html, lessons/0001-y.html.');
    const st = await page.evaluate(async () => (await (await import('./src/db.js')).listLessons('LRN-REN')).map((l) => [l.path, l.progress.status]));
    expect(st).toEqual([['lessons/0001-a.html', 'done'], ['lessons/0002-b.html', 'new']]);
  });
});

test.describe('T012-D4: the threshold field', () => {
  test('a refusal typed while an arrow step is being saved stays; the field ends with what is stored', async ({ page }) => {
    await page.goto('./#/settings');
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    const budget = page.locator('[data-field="budget"]');
    await budget.fill('3');
    await budget.press('Enter');
    await expect(page.locator('[data-field="budget-message"]')).toHaveText('Запазено.');
    const r = await budget.evaluate(async (el) => {
      const key = (k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      key('ArrowUp'); // saves 3.01 (async)
      el.value = 'abc';
      key('Enter'); // refused at once, while 3.01 is still being saved
      await new Promise((res) => setTimeout(res, 800));
      const db = await import('./src/db.js');
      return { field: el.value, msg: document.querySelector('[data-field="budget-message"]').textContent, stored: (await db.getSettings()).monthlyBudgetUSD, invalid: el.getAttribute('aria-invalid') };
    });
    expect(r.stored).toBe(3.01);
    expect(r.field).toBe('3.01');
    expect(r.msg).toMatch(/^Прагът не е число/);
    expect(r.invalid).toBe('true');
  });
});
