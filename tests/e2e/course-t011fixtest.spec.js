// T-011-fix tests (tester, 0.8.1): the fixes of T-012 and D-038, tested "as an attacker".
// - T011F-S*: D-038 (no mission, no course notes anywhere, nothing of them rendered),
//   the sticky side column with long "Ресурси" (scroll, keyboard, focus rings),
//   no horizontal scroll at the tablet sizes and at 160 %;
// - T011F-D*: T012-D1 (malformed %-escapes everywhere a path is decoded), T012-D2
//   (deep nesting of every kind, render time), T012-D3 (contrast of "Скоро"),
//   T012-D4 (arrows in the threshold field) and new defects (with test.fail);
// - T011F-I*: renamed lesson files (ambiguous cases), h1 = course name, the fold button.
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and small in-memory courses.
import { test, expect } from '@playwright/test';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
const DEMO_PATH = 'lessons/0001-vidove-chay.html';
const DEMO_ID = 'LRN-DEMO/lesson:0001'; // T-055 (D-039): by number

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
const lessonHtml = (title, body = '<p>Измислен текст.</p>') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`);
const indexMd = (id, numbers, title = 'индекс') => `# ${id}: ${title}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${numbers.map((n) => `| ${n} | Урок ${n} |`).join('\n')}\n`;
const quizJson = (lesson, title = `Тест ${lesson}`, links = []) => JSON.stringify({
  lesson, title,
  questions: [{ q: `Въпрос към ${lesson}?`, options: ['Да', 'Не'], answer: 0, why: 'Защото.', links }],
});
const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id = 'LRN-DEMO') {
  if (new URL(page.url()).hash === `#/c/${id}`) await page.reload();
  else await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
const lf = (page) => page.frameLocator('iframe.lesson-frame');
const item = (page, number) => course(page).locator('.course-item', { has: page.locator(`[data-lesson] .import__num:text-is("${number}")`) });
// Run fn(db, arg) in the page with the db module (string evaluation: not subject to the page CSP).
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const pad4 = (n) => String(n).padStart(4, '0');

/** Long resources: taller than any screen, links spread over it, plain text after the last link. */
function longResources(paragraphs = 120) {
  const out = ['# Ресурси'];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 20 === 0) out.push(`## Раздел ${i}`);
    out.push(`Абзац ${i} с измислен текст за ресурсите на курса, достатъчно дълъг, за да се пренесе на няколко реда.`);
    if (i % 30 === 5) out.push(`- [Линк ${i}](https://example.org/r${i})`);
  }
  out.push('- [Последен линк](https://example.org/last)');
  for (let i = 0; i < 40; i++) out.push(`Текст след последния линк ${i}.`);
  out.push('КРАЙ-НА-РЕСУРСИТЕ');
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------
// D-038 and the layout
// ---------------------------------------------------------------------------
test.describe('T011F-S D-038 and the side column', () => {
  test('T011F-S1 "Мисия" and "Бележки на курса" are nowhere (text, attributes, accessibility tree), at 1920, 800 and 360 px; MISSION/NOTES are never rendered', async ({ page }) => {
    test.setTimeout(90000);
    await page.evaluate(() => { window.__xss = []; });
    const hostile = (marker) => [
      `# Мисия: Име на <i>курса</i>`,
      marker,
      '## Мисия',
      '## Бележки на курса',
      '<img src="https://example.org/mission.png" onerror="__xss.push(1)"><script>__xss.push(2)</script>',
      '![картинка](https://example.org/md.png) <link rel="prefetch" href="https://example.org/prefetch">',
      '<svg onload="__xss.push(3)"></svg><iframe src="https://example.org/frame"></iframe>',
      '[js](javascript:__xss.push(4)) [pct](sources/100%.pdf) [%zz](%zz)',
      // If this were rendered at all it would cost seconds (thousands of list levels in a line).
      `${'- '.repeat(3000)}дълбоко`,
      `${'> '.repeat(5000)}дълбоко`,
    ].join('\n\n');
    const big = `${hostile('МИСИЯ-МАРКЕР')}\n\n${'Дълъг текст на мисията. '.repeat(40000)}`; // ~1 MB
    await importCourse(page, 'LRN-NOMIS', {
      'INDEX.md': indexMd('LRN-NOMIS', ['0001']),
      'MISSION.md': big,
      'NOTES.md': `${hostile('БЕЛЕЖКИ-МАРКЕР').replace('# Мисия:', '# Бележки:')}\n\n${'Бележка. '.repeat(40000)}`,
      'RESOURCES.md': '# Ресурси\n\n- [Пример](https://example.org/r)',
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    // MISSION/NOTES are not even parsed by the Markdown renderer: count its calls.
    await page.addInitScript(() => {
      window.__mdCalls = [];
      const orig = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function (s, type) { window.__mdCalls.push(String(s).length); return orig.call(this, s, type); };
    });
    await page.reload();
    for (const [w, hgt] of [[1920, 1200], [800, 1280], [360, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      const t0 = Date.now();
      await page.goto('./#/');
      await page.goto('./#/c/LRN-NOMIS');
      await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А'], { timeout: 15000 });
      await expect(course(page).locator('[data-action="continue"]')).toBeVisible();
      const ms = Date.now() - t0;
      console.log(`T011F-S1 ${w}×${hgt}: course screen with a 1 MB hostile MISSION/NOTES in ${ms} ms`);
      expect(ms, `${w}: the screen is not slowed by MISSION/NOTES`).toBeLessThan(3000);
      await course(page).locator('[data-section="resources"] summary').click();
      const found = await page.evaluate(() => {
        const bad = /Мисия|Бележки на курса|МИСИЯ-МАРКЕР|БЕЛЕЖКИ-МАРКЕР|Дълъг текст на мисията|Бележка\./;
        const hits = [];
        if (bad.test(document.body.innerText)) hits.push('innerText');
        if (bad.test(document.body.textContent)) hits.push('textContent');
        for (const el of document.querySelectorAll('*')) {
          for (const a of el.attributes) if (bad.test(a.value)) hits.push(`${el.tagName}[${a.name}]`);
        }
        return { hits, md: document.querySelectorAll('.md').length, details: [...document.querySelectorAll('details')].map((d) => d.dataset.section) };
      });
      expect(found.hits, `${w}`).toEqual([]);
      expect(found.md).toBe(1);
      expect(found.details).toEqual(['resources']);
      const cdp = await page.context().newCDPSession(page);
      const names = (await cdp.send('Accessibility.getFullAXTree')).nodes
        .flatMap((n) => [n.name?.value, n.description?.value, n.value?.value]).filter((s) => typeof s === 'string');
      expect(names.filter((s) => /Мисия|Бележки на курса|МАРКЕР/.test(s)), `${w}: accessibility tree`).toEqual([]);
      await cdp.detach();
      // The h1 is the name from MISSION.md, as text (the <i> is not markup).
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Име на <i>курса</i>');
    }
    // Every DOMParser call (DOMPurify) parsed the small RESOURCES.md, never the 1 MB files.
    const calls = await page.evaluate(() => window.__mdCalls);
    expect(Math.max(0, ...calls)).toBeLessThan(5000);
    expect(await page.evaluate(() => window.__xss || [])).toEqual([]);
    // The other screens do not show them either.
    for (const hash of ['#/', '#/c/LRN-NOMIS/read/0001']) {
      await page.goto(`./${hash}`);
      if (hash.includes('read')) await waitReady(page);
      else await expect(page.locator('[data-course="LRN-NOMIS"]')).toBeVisible();
      expect(await page.evaluate(() => /Мисия|МИСИЯ-МАРКЕР|Бележки на курса|БЕЛЕЖКИ-МАРКЕР/.test(document.body.innerText))).toBe(false);
    }
  });

  const SIZES = [
    { w: 1920, h: 1200 }, { w: 1280, h: 800 }, { w: 1200, h: 1920 }, { w: 900, h: 700 },
  ];
  for (const lessonsCount of [2, 60]) {
    test(`T011F-S2 long "Ресурси" (taller than the screen), ${lessonsCount} lessons: everything is reachable by scrolling and by keyboard; focus rings are not cut; 100 % and 160 %`, async ({ page }) => {
      test.setTimeout(180000);
      const numbers = Array.from({ length: lessonsCount }, (_, i) => pad4(i + 1));
      const files = { 'INDEX.md': indexMd('LRN-STICKY', numbers), 'RESOURCES.md': longResources() };
      for (const n of numbers) files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n}`);
      for (const n of numbers.slice(0, 10)) files[`quizzes/${n}-t.json`] = quizJson(n);
      await importCourse(page, 'LRN-STICKY', files);
      for (const scale of ['100%', '160%']) {
        for (const size of SIZES) {
          const tag = `${size.w}×${size.h} @${scale}`;
          await page.setViewportSize({ width: size.w, height: size.h });
          await openCourse(page, 'LRN-STICKY');
          await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
          await course(page).locator('[data-section="resources"] summary').click();
          await expect(course(page).locator('[data-field="resources-text"]')).toBeVisible();
          // No horizontal scroll.
          const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          expect(sw[0], `${tag}: no horizontal scroll`).toBeLessThanOrEqual(sw[1]);
          // Scroll the window to the end: the side ("Продължи") stays in view (sticky).
          // (Opening "Ресурси" may have scrolled the side itself: back to its top first.)
          await page.evaluate(() => { document.querySelector('.course__side-body').scrollTop = 0; window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2); });
          await page.waitForTimeout(50);
          const st = await page.evaluate(() => {
            const body = document.querySelector('.course__side-body');
            const go = document.querySelector('[data-action="continue"]').getBoundingClientRect();
            const bar = document.querySelector('.app-bar, header')?.getBoundingClientRect().bottom ?? 0;
            return { pos: getComputedStyle(body).position, goTop: go.top, goBottom: go.bottom, vh: innerHeight, bar, scrollY, scrollH: body.scrollHeight, clientH: body.clientHeight };
          });
          console.log(`T011F-S2 ${tag} (${lessonsCount} lessons): ${JSON.stringify(st)}`);
          expect(st.pos, tag).toBe('sticky');
          if (lessonsCount > 2) {
            // The left column is longer than the screen: in the middle of the page the side stays in view below the app bar
            // (at the very end of the page: T011F-S2b).
            expect(st.goTop, `${tag}: "Продължи" below the app bar`).toBeGreaterThanOrEqual(st.bar - 1);
            expect(st.goBottom, `${tag}: "Продължи" in view after scrolling the page`).toBeLessThanOrEqual(st.vh);
          } else if (st.goTop < st.bar - 1) {
            // T011F-I4 (information): a short left column and a side of max-height (100vh − bar − 32 px)
            // make the page itself scroll by about the height of the course title; at the end of
            // the page the top of the side ("Завършени", half of "Продължи") is under the app bar.
            console.log(`T011F-I4 ${tag}: page scrolls ${st.scrollY} px; "Продължи" top ${Math.round(st.goTop)} under the app bar (${st.bar})`);
          }
          // The end of the resources is reachable by scrolling (the side scrolls on its own).
          await page.locator('.course__side-body').hover();
          for (let i = 0; i < 400; i++) {
            await page.mouse.wheel(0, 600);
            if (await page.evaluate(() => {
              const m = [...document.querySelectorAll('[data-field="resources-text"] p')].pop().getBoundingClientRect();
              return m.bottom <= innerHeight && m.top >= 0;
            })) break;
          }
          const endSeen = await page.evaluate(() => {
            const m = [...document.querySelectorAll('[data-field="resources-text"] p')].pop();
            const r = m.getBoundingClientRect();
            return m.textContent === 'КРАЙ-НА-РЕСУРСИТЕ' && r.bottom <= innerHeight && r.top >= 0;
          });
          expect(endSeen, `${tag}: the end of the resources is reachable with the wheel`).toBe(true);
          // Keyboard: from the top, Tab through the side; every focused element is in view
          // and its focus ring (outline + offset) is inside the side's scroll box.
          await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.course__side-body').scrollTop = 0; });
          await course(page).locator('[data-action="continue"]').focus();
          const seen = [];
          for (let i = 0; i < 40; i++) {
            const f = await page.evaluate(() => {
              const el = document.activeElement;
              const body = document.querySelector('.course__side-body');
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const ring = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
              const inSide = body.contains(el);
              const b = body.getBoundingClientRect();
              const cut = inSide && (r.left - ring < b.left - 0.5 || r.right + ring > b.left + body.clientWidth + 0.5);
              return { text: (el.textContent || '').trim().slice(0, 30), inSide, inView: r.top >= 0 && r.bottom <= innerHeight, cut };
            });
            seen.push(f);
            if (!f.inSide) break;
            await page.keyboard.press('Tab');
          }
          for (const f of seen) {
            expect(f.inView, `${tag}: focused "${f.text}" is in view`).toBe(true);
            expect(f.cut, `${tag}: focus ring of "${f.text}" is not cut`).toBe(false);
          }
          expect(seen.map((f) => f.text), tag).toContain('Последен линк');
          // After the side, Tab goes on to the lessons (main column).
          expect(seen[seen.length - 1].inSide, `${tag}: Tab leaves the side for the lessons`).toBe(false);
          expect(seen[seen.length - 1].text, tag).toMatch(/^0001/);
          // The text after the last link: with the focus on the last link, the keyboard scrolls the side.
          await course(page).locator('a', { hasText: 'Последен линк' }).focus();
          for (let i = 0; i < 30; i++) await page.keyboard.press('PageDown');
          await page.keyboard.press('End');
          // Keyboard scrolling is animated: wait until it settles.
          const endState = () => page.evaluate(() => {
            const r = [...document.querySelectorAll('[data-field="resources-text"] p')].pop().getBoundingClientRect();
            const sb = document.querySelector('.course__side-body');
            return { ok: r.bottom <= innerHeight + 1 && r.top >= 0, info: `end ${Math.round(r.top)}..${Math.round(r.bottom)} of ${innerHeight}; side ${sb.scrollTop}/${sb.scrollHeight - sb.clientHeight}; window ${scrollY}/${document.documentElement.scrollHeight - innerHeight}; focus ${document.activeElement.tagName}` };
          });
          let endByKeys = await endState();
          for (let k = 0; k < 20 && !endByKeys.ok; k++) { await page.waitForTimeout(150); endByKeys = await endState(); }
          expect(endByKeys.ok, `${tag}: the end of the resources is reachable with the keyboard (${endByKeys.info})`).toBe(true);
        }
      }
    });
  }

  test('T011F-S2b at the very end of a long course page, the top of the sticky side ("Завършени", "Продължи") is not under the app bar', async ({ page }) => {
    // Fixed in 0.10.0 (T-057): test.fail removed.
    const numbers = Array.from({ length: 60 }, (_, i) => pad4(i + 1));
    const files = { 'INDEX.md': indexMd('LRN-STICKY2', numbers), 'RESOURCES.md': longResources() };
    for (const n of numbers) files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n}`);
    await importCourse(page, 'LRN-STICKY2', files);
    const out = [];
    for (const [w, hgt] of [[1920, 1200], [1280, 800], [1200, 1920]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await openCourse(page, 'LRN-STICKY2');
      await course(page).locator('[data-section="resources"] summary').click();
      await page.evaluate(() => { document.querySelector('.course__side-body').scrollTop = 0; window.scrollTo(0, document.documentElement.scrollHeight); });
      await page.waitForTimeout(50);
      out.push(await page.evaluate(() => {
        const bar = document.querySelector('.app-bar').getBoundingClientRect().bottom;
        return { bar, progress: document.querySelector('[data-field="course-progress"]').getBoundingClientRect().top, go: document.querySelector('[data-action="continue"]').getBoundingClientRect().top };
      }));
    }
    console.log(`T011F-S2b at the end of the page: ${JSON.stringify(out)}`);
    for (const o of out) {
      expect(o.progress).toBeGreaterThanOrEqual(o.bar);
      expect(o.go).toBeGreaterThanOrEqual(o.bar);
    }
  });

  test('T011F-S3 below 900 px (899, 800×1280, 360×800, 160 %): one column, the side is not sticky and not cut; long resources and lessons are all on the page; no horizontal scroll', async ({ page }) => {
    test.setTimeout(90000);
    const numbers = Array.from({ length: 20 }, (_, i) => pad4(i + 1));
    const files = { 'INDEX.md': indexMd('LRN-NARROW', numbers), 'RESOURCES.md': longResources(60) };
    for (const n of numbers) files[`lessons/${n}-u.html`] = lessonHtml(`Урок ${n} с дълго заглавие, което се пренася`);
    await importCourse(page, 'LRN-NARROW', files);
    for (const scale of ['100%', '160%']) {
      for (const [w, hgt] of [[899, 1000], [800, 1280], [360, 800]]) {
        const tag = `${w}×${hgt} @${scale}`;
        await page.setViewportSize({ width: w, height: hgt });
        await openCourse(page, 'LRN-NARROW');
        await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
        await course(page).locator('[data-section="resources"] summary').click();
        const r = await page.evaluate(() => {
          const body = document.querySelector('.course__side-body');
          const cs = getComputedStyle(body);
          const side = document.querySelector('.course__side').getBoundingClientRect();
          const main = document.querySelector('.course__main').getBoundingClientRect();
          return { pos: cs.position, maxH: cs.maxHeight, clipped: body.scrollHeight > body.clientHeight + 1, sideBottom: side.bottom, mainTop: main.top, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
        });
        expect(r.pos, tag).not.toBe('sticky');
        expect(r.clipped, `${tag}: the side is not a scroll box`).toBe(false);
        expect(r.mainTop, `${tag}: the lessons below the side`).toBeGreaterThanOrEqual(r.sideBottom - 1);
        expect(r.sw, `${tag}: no horizontal scroll`).toBeLessThanOrEqual(r.cw);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T012-D1: malformed %-escapes everywhere a path is decoded
// ---------------------------------------------------------------------------
test.describe('T011F-D1 malformed %-escapes', () => {
  const BROKEN = ['%', '%z', '%zz', '100%.pdf', '%E0%A4%A', '%C0%AF', '%ED%A0%80', '%FF', 'lessons/0001-%zz.html', 'lessons/%E0%A4%A.html'];

  test('T011F-D1a RESOURCES.md and INDEX.md with every kind of broken escape: the screen works, broken links are dead text, good ones stay', async ({ page }) => {
    const links = BROKEN.map((b, i) => `[b${i}](${b})`).join(' ');
    await importCourse(page, 'LRN-PCT2', {
      'INDEX.md': `# LRN-PCT2: индекс\n\n## Уроци\n| # | Заглавие | Файл |\n|---|---|---|\n| 0001 | Урок %zz | [x](lessons/0001-a%zz.html) |\n| 0002 | Урок 100% | lessons/%E0%A4%A.html |\n\n## План\n- 0003: Скоро %zz [y](%zz)\n`,
      'RESOURCES.md': `# Ресурси\n\n${links}\n\n[добър](lessons/0001%2Da.html) [добър2](./lessons/0001-a.html#%zz) [добър3](lessons/0001-a.html?q=%zz)\n\n[ref][r]\n\n[r]: %zz\n\n<a href="%zz">html</a>`,
      'lessons/0001-a.html': lessonHtml('Урок А'),
      'lessons/0002-b.html': lessonHtml('Урок Б'),
    });
    await openCourse(page, 'LRN-PCT2');
    await expect(course(page).locator('[data-section="lessons"] [data-lesson]')).toHaveText(['0001 Урок А', '0002 Урок Б']);
    await expect(course(page).locator('[data-planned]')).toHaveCount(1);
    await course(page).locator('[data-section="resources"] summary').click();
    const res = course(page).locator('[data-field="resources-text"]');
    const got = await res.locator('a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    console.log(`T011F-D1a links: ${JSON.stringify(got)}`);
    expect(got.map(([t]) => t).sort()).toEqual(['добър', 'добър2', 'добър3']);
    for (const [, href] of got) expect(href).toBe('#/c/LRN-PCT2/read/0001');
    for (let i = 0; i < BROKEN.length; i++) await expect(res.locator('.md__dead-link', { hasText: new RegExp(`^b${i}$`) })).toHaveCount(1);
    await expect(course(page).locator('.md__fallback-note')).toHaveCount(0);
    await course(page).locator('a', { hasText: /^добър2$/ }).click();
    await waitReady(page);
    await expect(lf(page).locator('h1')).toHaveText('Урок А');
  });

  test('T011F-D1b files with "%" in their names (lessons, a reference, a quiz, a source) import, are listed and open', async ({ page }) => {
    const names = {
      'lessons/0001-100%-sigurno.html': 'Сто процента',
      'lessons/0002-%zz.html': 'Процент zz',
      'lessons/0003-%E0%A4%A.html': 'Счупен UTF-8',
      'lessons/0004-50%25.html': 'Двойно кодиран',
      'reference/R01-%.html': 'Справочник процент',
    };
    const files = { 'INDEX.md': indexMd('LRN-PFILE', ['0001', '0002', '0003', '0004']), 'sources/100%.pdf': '%PDF-1.4 измислен', 'quizzes/100%-test.json': quizJson('0001', 'Тест 100%') };
    for (const [p, t] of Object.entries(names)) files[p] = lessonHtml(t);
    const s = await importCourse(page, 'LRN-PFILE', files);
    console.log(`T011F-D1b import: ${s.text}`);
    await openCourse(page, 'LRN-PFILE');
    await expect(course(page).locator('[data-lesson]')).toHaveCount(5);
    for (const [p, t] of Object.entries(names)) {
      await course(page).locator('a.lesson-link', { hasText: t }).click();
      await waitReady(page);
      await expect(lf(page).locator('h1'), p).toHaveText(t);
      await openCourse(page, 'LRN-PFILE');
    }
    // D-040 (T-057): the quiz is under its lesson, behind the arrow.
    const closed = course(page).locator('[data-field="lesson-toggle"][aria-expanded="false"]');
    for (let n = await closed.count(); n > 0; n = await closed.count()) await closed.first().click();
    await course(page).locator('a.quiz-list__link', { hasText: 'Тест 100%' }).click();
    await expect(page.locator('[data-screen="quiz"]')).toContainText('Въпрос към 0001?');
  });

  test('T011F-D1c a lesson file whose name contains a literal "%2F" opens (the SW must not read it as a "/")', async ({ page }) => {
    // Fixed in 0.10.0 (T-057): test.fail removed.
    await importCourse(page, 'LRN-P2F', { 'INDEX.md': indexMd('LRN-P2F', ['0001']), 'lessons/0001-a%2Fb.html': lessonHtml('Наклонена черта') });
    await openCourse(page, 'LRN-P2F');
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Наклонена черта']);
    await page.goto('./#/c/LRN-P2F/read/0001');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 8000 });
    await expect(lf(page).locator('h1')).toHaveText('Наклонена черта');
  });

  test('T011F-D1d links from a lesson through the bridge: broken escapes do nothing (no error), links to files with "%" open them', async ({ page }) => {
    const body = [
      '<p><a id="l1" href="0002-100%25.html">към 100%</a></p>',
      '<p><a id="l2" href="0003-%25zz.html#%zz">към zz с котва</a></p>',
      '<p><a id="l3" href="%zz.html">счупен</a></p>',
      '<p><a id="l4" href="%E0%A4%A">счупен UTF-8</a></p>',
      '<p><a id="l5" href="#%zz">счупена котва</a></p>',
      '<p><a id="l6" href="../reference/R01-a.html#%E0%A4%A">справочник</a></p>',
      '<p><a id="l7" href="0002-100%.html">суров процент</a></p>',
    ].join('');
    await importCourse(page, 'LRN-PLINK', {
      'INDEX.md': indexMd('LRN-PLINK', ['0001', '0002', '0003']),
      'lessons/0001-a.html': lessonHtml('Първи', body),
      'lessons/0002-100%.html': lessonHtml('Втори'),
      'lessons/0003-%zz.html': lessonHtml('Трети'),
      'reference/R01-a.html': lessonHtml('Справочник'),
    });
    const open1 = async () => { await page.goto('./#/'); await page.goto('./#/c/LRN-PLINK/read/0001'); await waitReady(page); };
    await open1();
    for (const id of ['l3', 'l4', 'l5', 'l7']) {
      await lf(page).locator(`#${id}`).click();
      await page.waitForTimeout(300);
      await expect(page, id).toHaveURL(/#\/c\/LRN-PLINK\/read\/0001$/);
      await expect(lf(page).locator('h1')).toHaveText('Първи');
    }
    for (const [id, h1, re] of [['l1', 'Втори', /read\/0002$/], ['l2', 'Трети', /read\/0003\?at=/], ['l6', 'Справочник', /read\/R01\?at=/]]) {
      await open1();
      await lf(page).locator(`#${id}`).click();
      await expect(page, id).toHaveURL(re);
      await waitReady(page);
      await expect(lf(page).locator('h1'), id).toHaveText(h1);
    }
  });

  test('T011F-D1e quiz links with "%" and a reader "?at=" with broken escapes: the screens work', async ({ page }) => {
    await importCourse(page, 'LRN-PQUIZ', {
      'INDEX.md': indexMd('LRN-PQUIZ', ['0001']),
      'lessons/0001-a.html': lessonHtml('Първи', '<h2 id="x">Котва</h2>'),
      'quizzes/0001-q.json': quizJson('0001', 'Тест с линкове', [
        { label: 'сто процента', url: 'https://example.org/100%.pdf' },
        { label: 'zz', url: 'https://example.org/%zz' },
        { label: 'utf', url: 'https://example.org/%E0%A4%A' },
      ]),
    });
    await page.goto('./#/c/LRN-PQUIZ/quiz/0001-q');
    await expect(page.locator('[data-screen="quiz"]')).toContainText('Въпрос към 0001?');
    await page.locator('[data-screen="quiz"] button', { hasText: 'Не' }).first().click();
    const hrefs = await page.locator('[data-field="quiz-link"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    console.log(`T011F-D1e quiz links: ${JSON.stringify(hrefs)}`);
    expect(hrefs.length).toBeGreaterThanOrEqual(1);
    for (const h of hrefs) expect(h).toMatch(/^https:\/\/example\.org\//);
    for (const at of ['%zz', '%25zz', '%E0%A4%A', '%', 'x%']) {
      await page.goto('./#/');
      await page.goto(`./#/c/LRN-PQUIZ/read/0001?at=${at}`);
      await waitReady(page);
      await expect(lf(page).locator('h1'), at).toHaveText('Първи');
    }
    // Router segments with broken escapes: the "not found"/course screens, never an exception.
    for (const hash of ['#/c/%zz', '#/c/LRN-PQUIZ/read/%zz', '#/c/LRN-PQUIZ/quiz/%E0%A4%A', '#/c/%']) {
      await page.goto('./#/');
      await page.goto(`./${hash}`);
      await expect(page.locator('main')).not.toBeEmpty();
    }
  });
});

// ---------------------------------------------------------------------------
// T012-D2: deep nesting of every kind, render time
// ---------------------------------------------------------------------------
test.describe('T011F-D2 deep nesting in RESOURCES.md', () => {
  const N = 3000;
  const VARIANTS = {
    'dash-one-line': `${'- '.repeat(N)}x`,
    'ordered-one-line': `${'1. '.repeat(N)}x`,
    'quote-dash': `${'> - '.repeat(N)}x`,
    'dash-quote': `${'- > '.repeat(N)}x`,
    'star-quote-ol': `${'* > 1. '.repeat(1000)}x`,
    'quote-tabs': `${'>\t'.repeat(N)}x`,
    'quote-no-space': `${'>'.repeat(N)}x`,
    'html-div': `${'<div>'.repeat(N)}x${'</div>'.repeat(N)}`,
    'html-blockquote': `${'<blockquote>'.repeat(N)}x${'</blockquote>'.repeat(N)}`,
    'html-ul': `<ul>${'<li><ul>'.repeat(N)}x${'</ul></li>'.repeat(N)}</ul>`,
    'table-in-quotes': ['| a | b |', '|---|---|', '| 1 | 2 |'].map((r) => `${'> '.repeat(45)}${r}`).join('\n'),
    'indent-2000-lines': Array.from({ length: 2000 }, (_, i) => `${' '.repeat(i)}- ред ${i}`).join('\n'),
    'emphasis': `${'*a **b '.repeat(4000)}c`,
    'brackets': `${'['.repeat(5000)}a${']('.repeat(3000)}`,
  };
  for (const [name, md] of Object.entries(VARIANTS)) {
    test(`T011F-D2 ${name}: the screen loads in < 2 s, no long freeze, the text is there; a fallback is plain text only`, async ({ page }) => {
      const id = `LRN-N-${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 30);
      await importCourse(page, id, {
        'INDEX.md': indexMd(id, ['0001']),
        'RESOURCES.md': `# Ресурси\n\nПРЕДИ-МАРКЕР\n\n${md}\n\nСЛЕД-МАРКЕР`,
        'lessons/0001-a.html': lessonHtml('Урок А'),
      });
      await page.goto('./#/');
      await page.evaluate(() => {
        window.__long = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ type: 'longtask', buffered: false });
      });
      const t0 = Date.now();
      await page.evaluate((id) => { location.hash = `#/c/${id}`; }, id);
      await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А'], { timeout: 10000 });
      await course(page).locator('[data-section="resources"] summary').click();
      const res = course(page).locator('[data-field="resources-text"]');
      await expect(res).toContainText('СЛЕД-МАРКЕР');
      const ms = Date.now() - t0;
      const r = await page.evaluate(() => {
        const res = document.querySelector('[data-field="resources-text"]');
        const plain = res.querySelector('.md__plain');
        let depth = 0;
        for (const el of res.querySelectorAll('*')) { let d = 0; for (let e = el; e && e !== res; e = e.parentElement) d++; depth = Math.max(depth, d); }
        return { long: window.__long, fallback: !!res.querySelector('.md__fallback-note'), plainChildren: plain ? plain.children.length : 0, depth, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      console.log(`T011F-D2 ${name}: ${ms} ms, longest task ${Math.round(r.long)} ms, fallback ${r.fallback}, DOM depth ${r.depth}, scrollWidth ${r.sw}/${r.cw}`);
      expect(ms, 'time to the rendered resources').toBeLessThan(2000);
      expect(r.long, 'no freeze over 2 s').toBeLessThan(2000);
      await expect(res).toContainText('ПРЕДИ-МАРКЕР');
      expect(r.plainChildren, 'the fallback is plain text, never HTML').toBe(0);
      await expect(course(page).locator('[data-action="continue"]')).toBeVisible();
      if (r.fallback) problems = problems.filter((p) => !/Markdown not rendered/.test(p));
    });
  }

  test('T011F-D2-mixed 1000 lines of interleaved quotes and lists ("> - > - …", up to 30 levels) at tablet speed (CPU ×4): shown in < 3 s', async ({ page }) => {
    // Fixed in 0.10.0 (T-057): test.fail removed.
    test.setTimeout(60000);
    const md = Array.from({ length: 1000 }, (_, i) => `${'  '.repeat(i % 60)}${i % 2 ? '> ' : '- '}${'> - '.repeat(i % 30)}ред ${i}`).join('\n');
    await importCourse(page, 'LRN-N-MIXED', { 'INDEX.md': indexMd('LRN-N-MIXED', ['0001']), 'RESOURCES.md': `# Ресурси\n\n${md}\n\nСЛЕД-МАРКЕР`, 'lessons/0001-a.html': lessonHtml('Урок А') });
    await page.goto('./#/');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const t0 = Date.now();
    await page.evaluate(() => { location.hash = '#/c/LRN-N-MIXED'; });
    await expect(course(page).locator('[data-lesson]')).toHaveText(['0001 Урок А'], { timeout: 30000 });
    await course(page).locator('[data-section="resources"] summary').click({ timeout: 30000 });
    await expect(course(page).locator('[data-field="resources-text"]')).toContainText('СЛЕД-МАРКЕР', { timeout: 30000 });
    const ms = Date.now() - t0;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log(`T011F-D2-mixed (CPU ×4): ${ms} ms`);
    expect(ms).toBeLessThan(3000);
  });

  test('T011F-D2-I the same documents never make the page scroll sideways at 1920 px (information: absurd one-line nesting is not capped)', async ({ page }) => {
    test.setTimeout(60000);
    const out = {};
    for (const name of ['dash-one-line', 'quote-dash', 'html-div', 'html-ul', 'indent-2000-lines']) {
      const id = `LRN-W-${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 30);
      await importCourse(page, id, { 'INDEX.md': indexMd(id, ['0001']), 'RESOURCES.md': `# Ресурси\n\n${VARIANTS[name]}`, 'lessons/0001-a.html': lessonHtml('Урок А') });
      await openCourse(page, id);
      await course(page).locator('[data-section="resources"] summary').click();
      out[name] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth,
        !!document.querySelector('.md__fallback-note')]);
    }
    console.log(`T011F-D2-I scrollWidth/clientWidth/fallback: ${JSON.stringify(out)}`);
    problems = problems.filter((p) => !/Markdown not rendered/.test(p));
  });
});

// ---------------------------------------------------------------------------
// T012-D3: "Скоро" contrast; T012-D4: arrows
// ---------------------------------------------------------------------------
test.describe('T011F-D3 / T011F-D4', () => {
  function contrast(a, b) {
    const lum = (c) => { const [r, g, bb] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bb; };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  for (const mode of ['light', 'dark', 'system-dark', 'system-light']) {
    test(`T011F-D3 ${mode}: every text of a planned lesson ≥ 4.5:1, no opacity anywhere up the tree; also at 360 px`, async ({ page }) => {
      const files = { ...FILES };
      files['INDEX.md'] = `${FILES['INDEX.md'] instanceof Uint8Array ? new TextDecoder().decode(FILES['INDEX.md']) : FILES['INDEX.md']}\n\n## План\n- 0007: Планиран урок с дълго заглавие\n- R09: Планиран справочник\n`;
      await importDemo(page, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));
      if (mode.startsWith('system')) {
        await page.emulateMedia({ colorScheme: mode === 'system-dark' ? 'dark' : 'light' });
      } else {
        await page.evaluate(async (t) => (await import('./src/db.js')).saveSettings({ theme: t }), mode);
      }
      for (const w of [1920, 360]) {
        await page.setViewportSize({ width: w, height: 1000 });
        await openCourse(page);
        expect(await course(page).locator('[data-planned]').count()).toBeGreaterThanOrEqual(2);
        const res = await page.evaluate(() => {
          const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
          let bgEl = document.querySelector('[data-planned]');
          let bg = null;
          for (let e = bgEl; e && !bg; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) bg = rgb(c); }
          bg = bg || rgb(getComputedStyle(document.body).backgroundColor);
          const out = [];
          for (const el of document.querySelectorAll('[data-planned] *')) {
            if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            if (el.closest('[aria-hidden="true"]')) continue; // decoration (the mark): checked as a non-text element below
            let a = 1;
            for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
            out.push({ text: el.textContent.trim().slice(0, 30), color: rgb(getComputedStyle(el).color), a, bg });
          }
          return out;
        });
        expect(res.length).toBeGreaterThan(0);
        // The dashed mark of a planned lesson: a non-text element, ≥ 3:1 (WCAG 1.4.11).
        const mark = await page.evaluate(() => {
          const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
          const m = document.querySelector('[data-planned] .course-item__mark');
          return m ? { border: rgb(getComputedStyle(m).borderTopColor), style: getComputedStyle(m).borderTopStyle } : null;
        });
        if (mark) {
          expect(mark.style).toBe('dashed');
          expect(contrast(mark.border, res[0].bg), `${mode} ${w}: the mark`).toBeGreaterThanOrEqual(3);
        }
        for (const r of res) {
          expect(r.a, `${mode} ${w}: "${r.text}" opacity`).toBe(1);
          const c = contrast(r.color, r.bg);
          expect(c, `${mode} ${w}: "${r.text}" ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  test('T011F-D4a the second save is held open for 300 ms; the third arrow comes when the first save is fully done and the second is still in flight → 2.53 (field and store)', async ({ page }) => {
    // Stricter than T012-D4: there the third press comes "a few microtasks" after the first
    // transaction; here the second transaction is kept busy (a chain of reads on its store),
    // so the third press is a separate task with the first save finished (its continuation
    // has run) and the second one provably still pending. With settings.js of 0.8.0 → 2.52.
    await page.goto('./#/settings');
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    const budget = page.locator('[data-field="budget"]');
    await budget.fill('2.5');
    await budget.press('Enter');
    await expect(page.locator('[data-field="budget-message"]')).toHaveText('Запазено.');
    const r = await budget.evaluate(async (el) => {
      const pending = new Set();
      const done = new Set();
      const press = () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      const tr = IDBDatabase.prototype.transaction;
      let n = 0;
      IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
        const tx = tr.call(this, stores, mode, ...rest);
        if (mode === 'readwrite' && [].concat(stores).includes('settings')) {
          const id = ++n;
          pending.add(id);
          tx.addEventListener('complete', () => { pending.delete(id); done.add(id); });
          if (id === 2) {
            const store = tx.objectStore('settings');
            const t0 = performance.now();
            const spin = () => { if (performance.now() - t0 < 300) store.get('__hold__').onsuccess = spin; };
            spin();
          }
        }
        return tx;
      };
      press(); // save 1: 2.51
      press(); // save 2: 2.52 (held open)
      await new Promise((res) => setTimeout(res, 120));
      const at = { pending: [...pending], done: [...done], field: el.value };
      press(); // the user presses again between the two saves
      await new Promise((res) => setTimeout(res, 1200));
      IDBDatabase.prototype.transaction = tr;
      const db = await import('./src/db.js');
      return { at, field: el.value, stored: (await db.getSettings()).monthlyBudgetUSD, saves: n };
    });
    console.log(`T011F-D4a ${JSON.stringify(r)}`);
    expect(r.at.done).toContain(1);
    expect(r.at.pending).toContain(2);
    expect(r.saves).toBe(3);
    expect(r.field).toBe('2.53');
    expect(r.stored).toBe(2.53);
  });

  test('T011F-D4b a held arrow with random timing, mixed with refusals, Enter and Tab: field and store always agree, no step lost, the last refusal stays', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto('./#/settings');
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    const budget = page.locator('[data-field="budget"]');
    for (let round = 0; round < 6; round++) {
      await budget.fill('2');
      await budget.press('Enter');
      await expect(page.locator('[data-field="budget-message"]')).toHaveText(/^Запазено/);
      const r = await budget.evaluate(async (el, round) => {
        let seed = round * 7919 + 1;
        const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
        const key = (k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        let ups = 0;
        for (let i = 0; i < 25; i++) {
          key('ArrowUp'); ups++;
          const w = rnd();
          if (w < 0.3) await Promise.resolve();
          else if (w < 0.6) await new Promise((res) => setTimeout(res, 0));
          else if (w < 0.8) await new Promise((res) => setTimeout(res, Math.floor(rnd() * 15)));
        }
        await new Promise((res) => setTimeout(res, 600));
        const db = await import('./src/db.js');
        const a = { field: el.value, stored: (await db.getSettings()).monthlyBudgetUSD, ups };
        // Then: an arrow, and a refusal typed while it is saving; the refusal must stay.
        key('ArrowUp');
        el.value = '1,2,3';
        key('Enter');
        await new Promise((res) => setTimeout(res, 600));
        const b = { field: el.value, stored: (await db.getSettings()).monthlyBudgetUSD, msg: document.querySelector('[data-field="budget-message"]').textContent, invalid: el.getAttribute('aria-invalid') };
        return { a, b };
      }, round);
      expect(r.a.stored, `round ${round}`).toBe(Math.round((2 + r.a.ups / 100) * 100) / 100);
      expect(Number(r.a.field), `round ${round}`).toBe(r.a.stored);
      expect(Number(r.b.field), `round ${round}: field = store after the refusal`).toBe(r.b.stored);
      expect(r.b.stored).toBe(Math.round((r.a.stored + 0.01) * 100) / 100);
      expect(r.b.msg, `round ${round}: the refusal stays`).not.toMatch(/^Запазено/);
      expect(r.b.invalid).toBe('true');
    }
  });
});

// ---------------------------------------------------------------------------
// T012-I4: renamed lesson files — ambiguous cases
// ---------------------------------------------------------------------------
test.describe('T011F-I1 renamed lesson files', () => {
  const C = 'LRN-REN2';
  const base = (extra = {}) => ({
    'INDEX.md': indexMd(C, ['0001', '0002', '0003']),
    'lessons/0001-alpha.html': lessonHtml('Алфа'),
    'lessons/0002-beta.html': lessonHtml('Бета'),
    'lessons/0003-gama.html': lessonHtml('Гама'),
    'reference/R01-spr.html': lessonHtml('Справочник'),
    'quizzes/0001-q.json': quizJson('0001'),
    ...extra,
  });
  async function seed(page) {
    await importCourse(page, C, base());
    await db(page, async (db, C) => {
      // T-055 (D-039): lessons are keyed by course + number, not by path.
      await db.setLessonProgress(`${C}/lesson:0001`, { status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T10:00:00.000Z', scrollY: 111 });
      await db.setLessonProgress(`${C}/lesson:0002`, { status: 'started', lastOpenedAt: '2026-11-18T11:00:00.000Z', scrollY: 222 });
      const q = (await db.listQuizzes(C))[0];
      const keys = db.questionKeys(q.questions);
      await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[0], choice: 'Да', cursor: 0 });
    }, C);
  }
  const rows = (page) => db(page, async (db, C) => (await db.listLessons(C)).map((l) => [l.kind, l.number, l.path, l.title, l.progress.status, l.progress.scrollY ?? 0]), C);
  const all = (page) => db(page, async (db, C) => (await db.listLessons(C, { includeDeleted: true })).map((l) => [l.path, !!l.deleted, l.renamedTo ? l.renamedTo.slice(C.length + 1) : null, l.previousPaths ?? null]), C);
  async function screenRows(page) {
    await openCourse(page, C);
    return course(page).locator('[data-lesson]').allTextContents();
  }
  async function quizAnswered(page) {
    return db(page, async (db, C) => { const q = (await db.listQuizzes(C))[0]; return db.scoreQuiz(q, await db.getQuizAnswers(q.id)); }, C);
  }

  test('T011F-I1a rename + changed content, then the same ZIP again, then renamed back and forth 3 times: one row, progress, quiz answers and activity follow; old records hidden', async ({ page }) => {
    test.setTimeout(90000);
    await seed(page);
    const score0 = await quizAnswered(page);
    const names = ['0001-alpha-v2.html', '0001-alpha-v3.html', '0001-alpha.html', '0001-alpha-v2.html'];
    for (const [i, n] of names.entries()) {
      const files = base();
      delete files['lessons/0001-alpha.html'];
      files[`lessons/${n}`] = lessonHtml(`Алфа (вариант ${i})`, `<p>Променено съдържание ${i}.</p>`);
      const s = await importCourse(page, C, files);
      expect(s.lessons.added, n).toEqual([]);
      expect((await importCourse(page, C, files)).text, `${n} again`).toMatch(/^Без промени/);
      const r = await rows(page);
      expect(r.filter(([, num]) => num === '0001'), n).toEqual([['lesson', '0001', `lessons/${n}`, `Алфа (вариант ${i})`, 'done', 111]]);
      expect(r).toHaveLength(4);
      expect(await screenRows(page)).toEqual([`0001 Алфа (вариант ${i})`, '0002 Бета', '0003 Гама', 'R01 Справочник']);
      await expect(item(page, '0001')).toHaveAttribute('data-status', 'done');
      // "Последни дейности": the same entries as before the rename (opened + completed), with the new title; never the old file.
      const acts = await course(page).locator('[data-section="activity"] a').allTextContents();
      expect(acts.filter((t) => /урок 0001/.test(t)), JSON.stringify(acts)).toEqual([`Завършен урок 0001 „Алфа (вариант ${i})“`, `Отворен урок 0001 „Алфа (вариант ${i})“`]);
      const hrefs = await course(page).locator('[data-section="activity"] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      for (const h of hrefs) expect(h).not.toMatch(/alpha/);
      expect(await quizAnswered(page)).toEqual(score0);
    }
    // T-055 (D-039): no soft-deleted `renamedTo` records any more — one record
    // per number; the earlier file names are in previousPaths.
    const recs = await all(page);
    console.log(`T011F-I1a records: ${JSON.stringify(recs)}`);
    expect(recs.map(([p, del, to]) => [p, del, to]).sort()).toEqual([
      ['lessons/0001-alpha-v2.html', false, null], ['lessons/0002-beta.html', false, null], ['lessons/0003-gama.html', false, null], ['reference/R01-spr.html', false, null]]);
    expect([...recs.find(([p]) => p === 'lessons/0001-alpha-v2.html')[3]].sort()).toEqual(['lessons/0001-alpha-v3.html', 'lessons/0001-alpha.html']);
    await expect(page.locator('[data-course="LRN-REN2"] [data-field="course-progress"]').or(page.locator('body'))).toBeVisible();
    await page.goto('./#/');
    await expect(page.locator(`[data-course="${C}"] [data-field="course-progress"]`)).toHaveText(/^Завършени: 1 от 3/);
  });

  test('T011F-I1b names swapped between two lessons (0001-alpha ↔ 0002-beta slugs): two rows, each keeps the progress of its number', async ({ page }) => {
    await seed(page);
    const files = base();
    delete files['lessons/0001-alpha.html'];
    delete files['lessons/0002-beta.html'];
    files['lessons/0001-beta.html'] = lessonHtml('Алфа');
    files['lessons/0002-alpha.html'] = lessonHtml('Бета');
    await importCourse(page, C, files);
    const r = await rows(page);
    expect(r.filter(([k]) => k === 'lesson')).toEqual([
      ['lesson', '0001', 'lessons/0001-beta.html', 'Алфа', 'done', 111],
      ['lesson', '0002', 'lessons/0002-alpha.html', 'Бета', 'started', 222],
      ['lesson', '0003', 'lessons/0003-gama.html', 'Гама', 'new', 0],
    ]);
    expect(await screenRows(page)).toEqual(['0001 Алфа', '0002 Бета', '0003 Гама', 'R01 Справочник']);
  });

  test('T011F-I1c the author renumbers the course (a new lesson at 0001, the old ones shift by one, same files): the progress must not jump onto another lesson', async ({ page }) => {
    // T-055: by the user's decision (D-039) the data stays with the NUMBER and
    // the import only warns (see T011F-I1c-w below); so this expectation of the
    // tester (progress follows the content) still fails, as designed.
    test.fail(true, 'T011F-D1 (D-039: by decision the progress stays with the number; the summary warns): when lessons are renumbered (same file content), the progress of the old 0001 stays on the NEW, unread 0001; the moved lesson "Алфа" (now 0002) gets the progress of "Бета"');
    await seed(page);
    const files = {
      'INDEX.md': indexMd(C, ['0001', '0002', '0003', '0004']),
      'lessons/0001-uvod.html': lessonHtml('Нов увод'),
      'lessons/0002-alpha.html': lessonHtml('Алфа'),
      'lessons/0003-beta.html': lessonHtml('Бета'),
      'lessons/0004-gama.html': lessonHtml('Гама'),
      'reference/R01-spr.html': lessonHtml('Справочник'),
    };
    await importCourse(page, C, files);
    const r = await rows(page);
    console.log(`T011F-I1c after renumbering: ${JSON.stringify(r)}`);
    const by = Object.fromEntries(r.map(([, , , title, status]) => [title, status]));
    expect(by['Нов увод'], 'the new, unread lesson is not "завършен"').toBe('new');
    expect(by['Алфа'], 'the lesson that was read keeps "завършен"').toBe('done');
    expect(by['Бета']).toBe('started');
  });

  test('T011F-I1c-w (T-055) the renumbering of T011F-I1c: the summary warns for each lesson with progress whose title changed', async ({ page }) => {
    await seed(page);
    const s = await importCourse(page, C, {
      'INDEX.md': indexMd(C, ['0001', '0002', '0003', '0004']),
      'lessons/0001-uvod.html': lessonHtml('Нов увод'),
      'lessons/0002-alpha.html': lessonHtml('Алфа'),
      'lessons/0003-beta.html': lessonHtml('Бета'),
      'lessons/0004-gama.html': lessonHtml('Гама'),
      'reference/R01-spr.html': lessonHtml('Справочник'),
    });
    expect(s.text).toContain('Внимание: Урок 0001 е с ново заглавие „Нов увод“ (беше „Алфа“).');
    expect(s.text).toContain('Урок 0002 е с ново заглавие „Алфа“ (беше „Бета“).');
    expect(s.text).not.toContain('Урок 0003 е с ново заглавие');
  });

  test('T011F-I1d the number disappears from the file name, a lesson becomes a reference, two new files with one number: no progress is lost, nothing is merged by guess', async ({ page }) => {
    await seed(page);
    const files = base();
    delete files['lessons/0001-alpha.html'];
    delete files['lessons/0002-beta.html'];
    delete files['lessons/0003-gama.html'];
    files['lessons/alpha.html'] = lessonHtml('Алфа без номер');
    files['reference/R02-beta.html'] = lessonHtml('Бета като справочник');
    files['lessons/0003-gama-a.html'] = lessonHtml('Гама А');
    files['lessons/0003-gama-b.html'] = lessonHtml('Гама Б');
    // T-055 (D-039): two files with one number → the whole import is refused, nothing changes…
    const before = await rows(page);
    await expect(importCourse(page, C, files)).rejects.toThrow('В курса има два урока с номер 0003: lessons/0003-gama-a.html, lessons/0003-gama-b.html.');
    expect(await rows(page)).toEqual(before);
    // …and without the second file, 0003 is the same lesson under its new name.
    delete files['lessons/0003-gama-b.html'];
    await importCourse(page, C, files);
    const r = await rows(page);
    console.log(`T011F-I1d: ${JSON.stringify(r)}`);
    // The old 0001 and 0002 stay (their files are gone from the ZIP; a partial import never deletes) with their progress.
    expect(r).toEqual(expect.arrayContaining([
      ['lesson', '0001', 'lessons/0001-alpha.html', 'Алфа', 'done', 111],
      ['lesson', '0002', 'lessons/0002-beta.html', 'Бета', 'started', 222],
      ['reference', 'R02', 'reference/R02-beta.html', 'Бета като справочник', 'new', 0],
    ]));
    expect(r.filter(([, n]) => n === '0003')).toEqual([['lesson', '0003', 'lessons/0003-gama-a.html', 'Гама А', 'new', 0]]);
    // One more import of the same: nothing changes.
    expect((await importCourse(page, C, files)).text).toMatch(/^Без промени/);
    expect(await rows(page)).toEqual(r);
  });

  test('T011F-I1e after a rename, a ZIP with BOTH the old and the new file: no data lost, the screen and "Продължи" work', async ({ page }) => {
    await seed(page);
    const renamed = base();
    delete renamed['lessons/0001-alpha.html'];
    renamed['lessons/0001-alpha-v2.html'] = lessonHtml('Алфа 2');
    await importCourse(page, C, renamed);
    await db(page, (db, C) => db.setLessonProgress(`${C}/lesson:0001`, { scrollY: 999, lastOpenedAt: '2026-11-19T08:00:00.000Z' }), C);
    // T-055 (D-039): both files carry the number 0001 → the import is refused, nothing changes.
    await expect(importCourse(page, C, { ...base(), 'lessons/0001-alpha-v2.html': lessonHtml('Алфа 2') }))
      .rejects.toThrow('В курса има два урока с номер 0001: lessons/0001-alpha-v2.html, lessons/0001-alpha.html.');
    const r = await rows(page);
    console.log(`T011F-I1e both files: ${JSON.stringify(r)}`);
    const v2 = r.find(([, , p]) => p === 'lessons/0001-alpha-v2.html');
    expect(v2).toEqual(['lesson', '0001', 'lessons/0001-alpha-v2.html', 'Алфа 2', 'done', 999]);
    await openCourse(page, C);
    const href = await course(page).locator('[data-action="continue"]').getAttribute('href');
    await page.goto(`./${href}`);
    await waitReady(page);
  });

  test('T011F-I1f a lesson open in another tab while its file is renamed by an import: "Маркирай като завършен" there is not lost', async ({ page, context }) => {
    // T011F-D3 fixed by T-055 (D-039): the id does not change with the file name.
    await seed(page);
    const reader = await context.newPage();
    reader.on('pageerror', (e) => problems.push(`reader pageerror: ${e}`));
    await reader.goto(`./#/c/${C}/read/0002`);
    await waitReady(reader);
    const renamed = base();
    delete renamed['lessons/0002-beta.html'];
    renamed['lessons/0002-beta-v2.html'] = lessonHtml('Бета 2');
    await importCourse(page, C, renamed);
    await reader.locator('[data-action="complete"]').click();
    await expect(reader.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await reader.close();
    const r = await rows(page);
    expect(r.find(([, n]) => n === '0002')).toEqual(['lesson', '0002', 'lessons/0002-beta-v2.html', 'Бета 2', 'done', 222]);
  });

  test('T011F-I1g two courses with the same lesson file and number: a rename in one never touches the other', async ({ page }) => {
    await seed(page);
    await importCourse(page, 'LRN-REN3', { 'INDEX.md': indexMd('LRN-REN3', ['0001']), 'lessons/0001-alpha.html': lessonHtml('Алфа 3') });
    await db(page, (db) => db.setLessonProgress('LRN-REN3/lesson:0001', { status: 'started', scrollY: 33 }));
    const files = base();
    delete files['lessons/0001-alpha.html'];
    files['lessons/0001-alpha-x.html'] = lessonHtml('Алфа X');
    await importCourse(page, C, files);
    const other = await db(page, async (db) => (await db.listLessons('LRN-REN3', { includeDeleted: true })).map((l) => [l.path, !!l.deleted, l.progress.status, l.progress.scrollY]));
    expect(other).toEqual([['lessons/0001-alpha.html', false, 'started', 33]]);
  });
});

// ---------------------------------------------------------------------------
// T012-I5: the h1 is the course name; T012-I7: the fold button
// ---------------------------------------------------------------------------
test.describe('T011F-I2 the course name (h1) and the fold button', () => {
  const LONG = `Дълго${'име'.repeat(1700)}`;
  const CASES = [
    { id: 'LRN-H-XSS', mission: '# Мисия: <img src=x onerror="__xss.push(1)"><b>Чай</b> & "кафе"\n\nТекст.', want: '<img src=x onerror="__xss.push(1)"><b>Чай</b> & "кафе"' },
    { id: 'LRN-H-MD', mission: '# Mission — **Чай** [линк](javascript:x)\n', want: '**Чай** [линк](javascript:x)' },
    { id: 'LRN-H-LONG', mission: `# Мисия: ${LONG}\n`, want: LONG },
    { id: 'LRN-H-NOH', mission: 'Само текст, без заглавие.\n\n## Подзаглавие', index: '# LRN-H-NOH: Основи на чая\n', want: 'Основи на чая' },
    { id: 'LRN-H-IDX', mission: null, index: '# LRN-H-IDX — индекс\n', want: 'LRN-H-IDX' },
    { id: 'LRN-H-ONLY', mission: '# Мисия:\n', index: '# LRN-H-ONLY: индекс\n', want: 'LRN-H-ONLY' },
  ];
  test('T011F-I2a HTML, Markdown, a 5000-character name, no heading, "индекс" only: the h1 and the card show the same text, nothing runs, no horizontal scroll', async ({ page }) => {
    test.setTimeout(90000);
    await page.evaluate(() => { window.__xss = []; });
    for (const c of CASES) {
      const files = { 'INDEX.md': `${c.index || `# ${c.id}: индекс\n`}\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Урок |\n`, 'lessons/0001-a.html': lessonHtml('Урок А') };
      if (c.mission) files['MISSION.md'] = c.mission;
      await importCourse(page, c.id, files);
    }
    for (const [w, hgt] of [[1920, 1200], [360, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      for (const c of CASES) {
        await openCourse(page, c.id);
        await expect(page.locator('h1'), c.id).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 }), c.id).toHaveText(c.want);
        expect(await page.title(), c.id).toBe(c.want === c.id ? `${c.id} · EasyLRN` : `${c.want} · EasyLRN`);
        const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        expect(sw[0], `${c.id} @${w}: no horizontal scroll`).toBeLessThanOrEqual(sw[1]);
      }
      await page.goto('./#/');
      for (const c of CASES) await expect(page.locator(`[data-course="${c.id}"] .card__title`), c.id).toHaveText(c.want);
      // (The card of the 5000-character name widens "Курсове": T011F-D5, below.)
    }
    await expect(page.locator('img, b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toEqual([]);
  });

  test('T011F-I2d a very long course name without spaces does not widen "Курсове" (the card wraps it)', async ({ page }) => {
    // Fixed in 0.10.0 (T-057): test.fail removed.
    await importCourse(page, 'LRN-H-LONG2', { 'INDEX.md': indexMd('LRN-H-LONG2', ['0001']), 'MISSION.md': `# Мисия: ${LONG}\n`, 'lessons/0001-a.html': lessonHtml('Урок А') });
    for (const [w, hgt] of [[1920, 1200], [360, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.goto('./#/');
      await expect(page.locator('[data-course="LRN-H-LONG2"] .card__title')).toHaveText(LONG);
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(sw[0], `courses @${w}: no horizontal scroll`).toBeLessThanOrEqual(sw[1]);
    }
  });

  test('T011F-I2b an empty "# " heading in MISSION.md is no name: the h1 is not the next line of the file', async ({ page }) => {
    // Fixed in 0.10.0 (T-057): test.fail removed.
    await importCourse(page, 'LRN-H-EMPTY', {
      'INDEX.md': indexMd('LRN-H-EMPTY', ['0001'], 'индекс'),
      'MISSION.md': '# \n\nПърви абзац на мисията, който не е име на курса.\n',
      'lessons/0001-a.html': lessonHtml('Урок А'),
    });
    await openCourse(page, 'LRN-H-EMPTY');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('LRN-H-EMPTY');
  });

  test('T011F-I2c exactly one h1 while moving fast between "Курсове", "Курс", the reader and "Настройки" (back/forward)', async ({ page }) => {
    await importDemo(page);
    const hashes = ['#/', '#/c/LRN-DEMO', '#/c/LRN-DEMO/read/0001', '#/c/LRN-DEMO', '#/settings', '#/c/LRN-DEMO'];
    for (const hsh of hashes) await page.evaluate((x) => { location.hash = x; }, hsh);
    for (let i = 0; i < 4; i++) { await page.goBack(); await page.goBack(); await page.goForward(); }
    for (const hsh of hashes) {
      await page.goto(`./${hsh}`);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ h1: [...document.querySelectorAll('h1')].map((e) => e.textContent), title: document.title }));
      expect(r.h1, hsh).toHaveLength(1);
      if (hsh === '#/c/LRN-DEMO') { expect(r.h1[0]).toBe('Основи на чая'); expect(r.title).toBe('Основи на чая · EasyLRN'); }
      else expect(r.title, `${hsh}: the course name does not stick in the tab title`).not.toContain('Основи на чая');
    }
  });

  test('T011F-I3 the fold button: role, name exactly "Ресурси" (no "▸"), aria-expanded follows Space, Enter and click', async ({ page }) => {
    await importDemo(page);
    await openCourse(page);
    const cdp = await page.context().newCDPSession(page);
    const disclosure = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes
      .filter((n) => /Ресурси/.test(n.name?.value || '') && !['heading', 'StaticText', 'InlineTextBox'].includes(n.role?.value))
      .map((n) => [n.role?.value, n.name?.value, (n.properties || []).find((p) => p.name === 'expanded')?.value?.value]);
    const names = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.map((n) => n.name?.value || '').filter((s) => s.includes('▸'));
    expect(await names()).toEqual([]);
    expect(await disclosure()).toEqual([['DisclosureTriangle', 'Ресурси', false]]);
    const summary = course(page).locator('[data-section="resources"] summary');
    await summary.focus();
    await page.keyboard.press('Space');
    expect(await disclosure()).toEqual([['DisclosureTriangle', 'Ресурси', true]]);
    await page.keyboard.press('Enter');
    expect(await disclosure()).toEqual([['DisclosureTriangle', 'Ресурси', false]]);
    await summary.click();
    expect(await disclosure()).toEqual([['DisclosureTriangle', 'Ресурси', true]]);
    // The arrow is still drawn (decoration).
    const arrow = await summary.evaluate((el) => getComputedStyle(el, '::before').content);
    expect(arrow).toContain('▸');
    await cdp.detach();
  });
});
