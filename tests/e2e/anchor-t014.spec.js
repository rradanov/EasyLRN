// T-014 (tester): anchoring of T-013 (0.12.0, D-012) attacked from outside.
// - T014-U: src/anchor.js itself (the PLAN T-014 edge cases: repeated text,
//   Cyrillic + Latin, one word, tables; plus random selections over five kinds
//   of change, the 0.8 threshold, the "short quote without context" rule,
//   unicode / NFD / soft hyphens / RTL / <br> / <pre>, hostile selectors);
// - T014-P: speed at CPU ×4 (the tablet), in the real lesson frame;
// - T014-S: the lesson is untrusted: prototypes replaced before / after the
//   bridge, forged reports with foreign ids (another lesson, another course,
//   deleted), extra fields, huge messages, a lesson that changes its DOM all
//   the time, two tabs;
// - T014-I: re-import (the summary note, retired lessons, lastAnchor of
//   another version);
// - T014-R: quiz.js / reflect.js of LRN-DEMO change the DOM while marked.
// Known defects are test.fail(true, 'T014-D…') so the suite stays green.
// Synthetic data only, fake keys, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile, readFixture } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  // Errors of the app window only: the hostile lessons below break themselves on purpose.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/\/c\/LRN-/.test(url)) return;
    problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});
const landscapeOnly = (ti) => test.skip(ti.project.name !== 'tablet-landscape', 'pure module / heavy: once is enough');

async function start(page) {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push({ ...e.data, t: performance.now() }); });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}
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
const lessonHtml = (title, body, head = '') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const index = (C, extra = '') => `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n${extra}`;
const C = 'LRN-T14';
const BODY = [
  '<p id="p1">Регламентът за киберустойчивост (<em>Cyber Resilience Act</em>, CRA) се прилага за продукти с цифрови елементи.</p>',
  '<h2 id="s1">Задължения</h2>',
  '<p id="p2">Производителят оценява рисковете за киберсигурността през целия жизнен цикъл на продукта.</p>',
  '<p id="p3">Уязвимостите се докладват без неоправдано забавяне.</p>',
  '<h2 id="s2">Срокове</h2>',
  '<p id="p4">Задълженията за докладване се прилагат по-рано от останалите изисквания.</p>',
  '<p id="p5">Краят на урока е тук.</p>',
].join('\n');
const files = (body = BODY, extra = {}, course = C) => ({
  'INDEX.md': index(course),
  'lessons/0001-parvi.html': lessonHtml('Първи', body),
  'lessons/0002-vtori.html': lessonHtml('Втори', '<p id="o1">Друг урок с текст за киберсигурността и докладването.</p>'),
  ...extra,
});
const L1 = `${C}/lesson:0001`;
const L2 = `${C}/lesson:0002`;
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 30000 });
async function lessonFrame(page) {
  const handle = await page.locator('iframe.lesson-frame').elementHandle();
  return handle.contentFrame();
}
async function openLesson(page, number = '0001', course = C) {
  const hash = `#/c/${course}/read/${number}`;
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  return lessonFrame(page);
}
/**
 * Annotations made directly in the store with the selectors the bridge would
 * make: src/anchor.js on the same lesson body (DOMParser), the needle found in
 * the model. `version` = the targetVersion (default: the current sha).
 */
async function annotateByText(page, lessonId, html, needles, { color = 'yellow', version } = {}) {
  return page.evaluate(async ({ lessonId, html, needles, color, version }) => {
    const db = await import('./src/db.js');
    const A = await import('./src/anchor.js');
    const lesson = await db.getLesson(lessonId);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const model = A.anchorTextModel(doc.body);
    const out = [];
    for (const n of needles) {
      const [needle, nth = 0] = Array.isArray(n) ? n : [n, 0];
      let at = -1;
      for (let k = 0; k <= nth; k++) at = model.text.indexOf(needle, at + 1);
      if (at < 0) throw new Error(`not in the model: ${needle}`);
      const selector = A.anchorDescribe(model, at, at + needle.length);
      const a = await db.createAnnotation({ courseId: lesson.courseId, target: { type: 'lesson', id: lessonId }, targetVersion: version === undefined ? lesson.sha256 : version, selector, color, anchorState: 'ok' });
      out.push(a);
    }
    return out;
  }, { lessonId, html, needles, color, version });
}
const annotations = (page, lessonId = L1) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, state: a.anchorState, exact: a.selector.quote.exact, prefix: a.selector.quote.prefix, suffix: a.selector.quote.suffix, position: a.selector.position, hint: a.selector.hint ?? null, targetVersion: a.targetVersion, last: a.lastAnchor ?? null, deleted: a.deleted, color: a.color, courseId: a.courseId, target: a.target })), lessonId);
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));
const anchoredMsgs = (page) => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:anchored'));

// ===========================================================================
// T014-U: src/anchor.js
// ===========================================================================
test.describe('T014-U src/anchor.js edge cases', () => {
  test.beforeEach(async ({ page }, ti) => { landscapeOnly(ti); await page.goto('./'); });
  /** Runs `fn(A, M)` in the app page: A = src/anchor.js, M(html) = text model of a body. */
  const run = (page, fn, arg) => page.evaluate(`(async () => {
    const A = await import('./src/anchor.js');
    const M = (html) => A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body);
    const sel = (m, needle, nth = 0) => { let at = -1; for (let k = 0; k <= nth; k++) at = m.text.indexOf(needle, at + 1); if (at < 0) throw new Error('no ' + needle); return A.anchorDescribe(m, at, at + needle.length); };
    const at = (m, r) => (r.state === 'orphan' ? null : m.text.slice(r.start, r.end));
    return (${fn.toString()})(A, M, sel, at, ${JSON.stringify(arg ?? null)});
  })()`);

  test('T014-U1 PLAN T-014: repeated text (context picks the place), Cyrillic + Latin, one word, a table cell and across cells — after an inserted paragraph', async ({ page }) => {
    const r = await run(page, (A, M, sel, at) => {
      const v1 = '<p>Срокът е 21 дни.</p><p>Повтарящо се изречение за срока.</p><p>Между тях: CRA (Cyber Resilience Act), ЕС 2024/2847 и NIS2.</p>'
        + '<p>Повтарящо се изречение за срока.</p><p>Последно: думата регламент.</p>'
        + '<table><tr><th>Роля</th><th>Задължение</th></tr><tr><td>Производител</td><td>оценка на риска</td></tr><tr><td>Вносител</td><td>проверка на CE</td></tr></table>';
      const v2 = `<p>Нов първи абзац, вмъкнат по-късно, с изречение за срока.</p>${v1.replace('<p>Последно', '<p>Още един вмъкнат абзац.</p><p>Последно')}`;
      const m1 = M(v1);
      const m2 = M(v2);
      const cases = {
        second: sel(m1, 'Повтарящо се изречение за срока.', 1),
        first: sel(m1, 'Повтарящо се изречение за срока.', 0),
        mixed: sel(m1, 'CRA (Cyber Resilience Act), ЕС 2024/2847'),
        word: sel(m1, 'регламент'),
        cell: sel(m1, 'оценка на риска'),
        cells: sel(m1, 'Производител оценка на риска Вносител'),
      };
      const out = {};
      for (const [k, s] of Object.entries(cases)) {
        const f = A.anchorFind(m2, s);
        // The right occurrence: the context around it in the new text is the old context.
        const ctxOk = f.state !== 'orphan' && m2.text.slice(Math.max(0, f.start - 12), f.start) === s.quote.prefix.slice(-12);
        out[k] = [f.state, at(m2, f), ctxOk];
      }
      out.cellsQuote = cases.cells.quote.exact;
      return out;
    });
    expect(r.second).toEqual(['ok', 'Повтарящо се изречение за срока.', true]);
    expect(r.first).toEqual(['ok', 'Повтарящо се изречение за срока.', true]);
    expect(r.mixed).toEqual(['ok', 'CRA (Cyber Resilience Act), ЕС 2024/2847', true]);
    expect(r.word).toEqual(['ok', 'регламент', true]);
    expect(r.cell).toEqual(['ok', 'оценка на риска', true]);
    expect(r.cells).toEqual(['ok', 'Производител оценка на риска Вносител', true]);
  });

  test('T014-U2 50 random selections × 5 changes of a 40-paragraph lesson: inserted paragraph ≥ 95 % ok at the SAME place, swapped sections all ok at the same place, edited sentence fuzzy/ok, deleted section orphan, nothing lost, the selector never changes', async ({ page }) => {
    const r = await run(page, (A, M) => {
      let seed = 14;
      const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const words = 'регламент продукт производител риск уязвимост доклад срок оценка документация пазар вносител дистрибутор съответствие марка CE изискване сигурност актуализация компонент SBOM'.split(' ');
      const para = (s, i) => { let w = []; for (let k = 0; k < 18; k++) w.push(words[Math.floor(rnd() * words.length)]); return `<p id="s${s}p${i}">Раздел ${s}, абзац ${i}: ${w.join(' ')}.</p>`; };
      const sections = [];
      for (let s = 0; s < 8; s++) { const ps = []; for (let i = 0; i < 5; i++) ps.push(para(s, i)); sections.push(`<section id="sec${s}"><h2>Раздел ${s}</h2>${ps.join('')}</section>`); }
      const v1 = sections.join('');
      const variants = {
        inserted: v1.replace('<section id="sec3">', '<p>Вмъкнат абзац с нов текст, който го нямаше, за да се изместят позициите.</p><section id="sec3">'),
        swapped: [sections[0], sections[5], sections[2], sections[3], sections[4], sections[1], sections[7], sections[6]].join(''),
        edited: v1.replace(/(<p id="s4p2">Раздел 4, абзац 2: )(\S+)/, '$1внимателно $2'),
        deleted: v1.replace(sections[6], ''),
        all: [sections[0], '<p>Нов увод.</p>', sections[2], sections[1], sections[3].replace(/абзац 1:/, 'абзац първи:'), sections[4], sections[5], sections[7]].join(''),
      };
      const m1 = M(v1);
      const T = m1.text;
      const sels = [];
      while (sels.length < 50) {
        let s = Math.floor(rnd() * (T.length - 10));
        let e = Math.min(T.length, s + 3 + Math.floor(rnd() * 140));
        while (s > 0 && T[s - 1] !== ' ') s--;
        while (e < T.length && T[e] !== ' ') e++;
        const d = A.anchorDescribe(m1, s, e);
        if (d) sels.push(d);
      }
      const frozen = JSON.stringify(sels);
      // Where a quote "is": the id of the paragraph / heading where it starts.
      const blockOf = (m, start) => { const rg = A.anchorRange(m, start, start + 1); const el = rg && (rg.startContainer.parentElement.closest('p, h2')); return el ? (el.id || el.textContent.slice(0, 12)) : null; };
      const out = {};
      for (const [k, html] of Object.entries(variants)) {
        const m2 = M(html);
        const tally = { ok: 0, fuzzy: 0, orphan: 0, wrongPlace: 0, lost: 0 };
        for (const s of sels) {
          const f = A.anchorFind(m2, s);
          if (!f || !['ok', 'fuzzy', 'orphan'].includes(f.state)) { tally.lost++; continue; }
          tally[f.state]++;
          if (f.state === 'ok' && blockOf(m2, f.start) !== blockOf(m1, s.position.start)) tally.wrongPlace++;
        }
        out[k] = tally;
      }
      out.unchanged = JSON.stringify(sels) === frozen;
      return out;
    });
    test.info().annotations.push({ type: 'T014-U2', description: JSON.stringify(r) });
    expect(r.unchanged).toBe(true);
    for (const k of ['inserted', 'swapped', 'edited', 'deleted', 'all']) {
      expect(r[k].lost, k).toBe(0);
      expect(r[k].wrongPlace, `${k}: ok at another place`).toBe(0);
    }
    expect(r.inserted.ok).toBeGreaterThanOrEqual(48);
    expect(r.swapped.ok).toBeGreaterThanOrEqual(48);
    expect(r.deleted.orphan).toBeGreaterThan(0);
  });

  test('T014-U3 the rule "a short quote without context → fuzzy": several copies, none with its context → fuzzy', async ({ page }) => {
    const r = await run(page, (A, M, sel) => {
      const v1 = '<p>Първо: CRA важи тук.</p><p>Второ: и CRA важи там.</p><p>Трето: CRA е регламент.</p>';
      const s = sel(M(v1), 'CRA', 1);
      return {
        kept: A.anchorFind(M(`<p>Нов.</p>${v1}`), s).state,
        twoNoContext: A.anchorFind(M('<p>Едно CRA.</p><p>Друго CRA.</p>'), s).state,
      };
    });
    expect(r).toEqual({ kept: 'ok', twoNoContext: 'fuzzy' });
  });

  test('T014-U4 (T014-D1) a short quote whose place was deleted and that is left ONCE elsewhere, with none of its context, is "ok" at the wrong place (expected: fuzzy — "провери")', async ({ page }) => {
    const r = await run(page, (A, M, sel) => {
      const v1 = '<p>Първо: CRA важи тук.</p><p>Второ: и CRA важи там за всички продукти.</p><p>Трето: регламентът.</p>';
      const s = sel(M(v1), 'CRA', 1); // the CRA of "Второ"
      const m2 = M('<p>Първо: CRA важи тук.</p><p>Трето: регламентът.</p>'); // "Второ" deleted
      const f = A.anchorFind(m2, s);
      return { state: f.state, start: f.start };
    });
    // It lands on the CRA of "Първо", a different sentence.
    expect(r.state).not.toBe('ok');
  });

  test('T014-U5 the 0.8 threshold: 10 of 50 characters changed → fuzzy (0.8), 11 → orphan; a short quote (< 12) needs its context', async ({ page }) => {
    const r = await run(page, (A, M, sel) => {
      const q = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX';
      const s = sel(M(`<p>Начало. ${q} Край.</p>`), q);
      const sub = (n) => q.split('').map((c, i) => (i % 5 === 2 && Math.floor(i / 5) < n ? '#' : c)).join('');
      const f10 = A.anchorFind(M(`<p>Начало. ${sub(10)} Край.</p>`), s);
      const f11 = A.anchorFind(M(`<p>Начало. ${sub(10).replace('a', '#')} Край.</p>`), s);
      const short = sel(M('<p>Контекст отпред: гласувай днес, контекст отзад.</p>'), 'гласувай');
      return {
        f10: [f10.state, f10.similarity],
        f11: f11.state,
        shortWithContext: A.anchorFind(M('<p>Контекст отпред: гласуваш днес, контекст отзад.</p>'), short).state,
        shortNoContext: A.anchorFind(M('<p>Нищо общо: гласуваш днес, нищо общо.</p>'), short).state,
      };
    });
    expect(r.f10).toEqual(['fuzzy', 0.8]);
    expect(r.f11).toBe('orphan');
    expect(r.shortWithContext).toBe('fuzzy');
    expect(r.shortNoContext).toBe('orphan');
  });

  test('T014-U6 unicode: NFC → NFD and soft hyphens on re-import → fuzzy (not orphan); NBSP / ZWSP / emoji / RTL Hebrew and Arabic → ok after an insertion; the quote of an emoji is whole', async ({ page }) => {
    const r = await run(page, (A, M, sel, at) => {
      const t = 'Йордан чете за ёжика и за naïve café днес вечерта.';
      const s = sel(M(`<p>${t}</p>`), t);
      const out = {};
      out.nfd = A.anchorFind(M(`<p>${t.normalize('NFD')}</p>`), s).state;
      out.shy = A.anchorFind(M(`<p>${t.replace(/(\p{L}{4})/gu, '$1­')}</p>`), s).state;
      // NBSP in the lesson, a plain space in the new version (and back): the model makes both a space.
      const nb = sel(M('<p>Член&nbsp;14 от&nbsp;Регламента се прилага.</p>'), 'Член 14 от Регламента');
      out.nbsp = A.anchorFind(M('<p>Ново.</p><p>Член 14 от Регламента се прилага.</p>'), nb).state;
      const zw = sel(M('<p>Дълга​дума и още.</p>'), 'Дълга​дума');
      out.zwsp = A.anchorFind(M('<p>Ново.</p><p>Дълга​дума и още.</p>'), zw).state;
      const em = M('<p>Оценка 👍🏽 и 😀 за урока.</p>');
      const e = sel(em, '👍🏽 и 😀');
      const em2 = M('<p>Ново.</p><p>Оценка 👍🏽 и 😀 за урока.</p>');
      out.emoji = [A.anchorFind(em2, e).state, at(em2, A.anchorFind(em2, e))];
      const he = 'שלום עולם זה טקסט בעברית לבדיקה';
      const ar = 'مرحبا بالعالم هذا نص عربي للاختبار';
      const rt = M(`<p dir="rtl">${he}</p><p dir="rtl">${ar}</p>`);
      const rt2 = M(`<p>Ново.</p><p dir="rtl">${he}</p><p>вмъкнат</p><p dir="rtl">${ar}</p>`);
      out.he = A.anchorFind(rt2, sel(rt, 'עולם זה טקסט')).state;
      out.ar = A.anchorFind(rt2, sel(rt, 'هذا نص عربي')).state;
      // A selection across a mixed LTR/RTL run.
      out.mixed = A.anchorFind(M(`<p>Ново.</p><p dir="rtl">${he}</p><p dir="rtl">${ar}</p>`), sel(rt, 'לבדיקה مرحبا')).state;
      // …and a block inserted inside it: too much changed for a 12-character quote (orphan, kept).
      out.mixedSplit = A.anchorFind(rt2, sel(rt, 'לבדיקה مرحبا')).state;
      return out;
    });
    // T-066 / T-067: he / ar went "fuzzy" in 0.13.2–0.13.3 (T066-D7); "ok" again since 0.13.4.
    expect(r).toEqual({ nfd: 'fuzzy', shy: 'fuzzy', nbsp: 'ok', zwsp: 'ok', emoji: ['ok', '👍🏽 и 😀'], he: 'ok', ar: 'ok', mixed: 'ok', mixedSplit: 'orphan' });
  });

  test('T014-U7 (T014-D2) <br> is in the list of blocks but makes no space: "ред<br>втори" is "редвтори" in the quote (expected "ред втори")', async ({ page }) => {
    const r = await run(page, (A, M) => M('<p>първи ред<br>втори ред</p>').text);
    expect(r).toBe('първи ред втори ред');
  });

  test('T014-U8 information: <pre> spaces are collapsed in the quote; an emoji cut by the 32-character context leaves a lone surrogate in prefix; <img>/<wbr> give no space', async ({ page }) => {
    const r = await run(page, (A, M) => {
      const p = M('<pre>a    b\n  c</pre>').text;
      const e = M(`<p>${'😀'.repeat(40)}ТУК</p>`);
      const s = A.anchorDescribe(e, 80, 83);
      return { pre: p, prefixFirst: s.quote.prefix.charCodeAt(0).toString(16), img: M('<p>текст<img alt="x">още</p>').text };
    });
    test.info().annotations.push({ type: 'T014-U8', description: JSON.stringify(r) });
    expect(r.pre).toBe('a b c');
  });

  test('T014-U9 hostile selectors never throw and stay fast: huge exact, getters in place of strings, weird hints (:has, deep nth-child, invalid), positions outside the text', async ({ page }) => {
    const r = await run(page, (A, M) => {
      const ps = []; for (let i = 0; i < 2000; i++) ps.push(`<div><p>Абзац ${i} с малко текст за модела.</p></div>`);
      const m = M(ps.join(''));
      const evil = { get exact() { return 'Абзац 5 с'; }, toString() { throw new Error('x'); } };
      const list = [
        { quote: { exact: 'а'.repeat(1e6) } },
        { quote: { exact: 'Абзац 7 с малко', prefix: { toString() { throw new Error('p'); } }, suffix: 42 } },
        { quote: evil },
        { quote: { exact: 'Абзац 1999 с малко текст' }, position: { start: -5, end: 1e12 } },
        { quote: { exact: 'Абзац X с малко текст за модела' }, hint: { blockPath: 'div:has(p:has(*)) '.repeat(10) } },
        { quote: { exact: 'Абзац X с малко текст за модела' }, hint: { blockPath: '}}}{{{' } },
        { quote: { exact: 'Абзац X с малко текст за модела' }, hint: { blockPath: '*:nth-child(1) '.repeat(13) } },
        { quote: { exact: 'Абзац X с малко текст за модела' }, position: { start: 'x', end: null } },
        { quote: { exact: '' } }, { quote: null }, null,
      ];
      const t = performance.now();
      const states = list.map((s) => { try { return A.anchorFind(m, s).state; } catch (err) { return `THROW ${err.message}`; } });
      return { states, ms: Math.round(performance.now() - t) };
    });
    test.info().annotations.push({ type: 'T014-U9', description: JSON.stringify(r) });
    for (const s of r.states) expect(['ok', 'fuzzy', 'orphan']).toContain(s);
    expect(r.ms).toBeLessThan(5000);
  });
});

// ===========================================================================
// T014-P: speed on the tablet (CPU ×4), in the real lesson frame
// ===========================================================================
test.describe('T014-P speed at CPU ×4', () => {
  test.beforeEach(async ({ page }, ti) => { landscapeOnly(ti); await start(page); });
  const N = 3000;
  const para = (i, w = '') => `<p id="q${i}">Абзац ${i}. Производителят${w} оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${i}, и документира резултата в техническата документация.</p>`;
  const longBody = (w = '', every = 1) => Array.from({ length: N }, (_, i) => para(i, i % every === 0 ? w : '')).join('\n');
  const needles = Array.from({ length: 200 }, (_, k) => `Абзац ${k * 15}. Производителят оценява рисковете за киберсигурността на продукта`);
  async function timeAnchoring(page) {
    await page.evaluate(() => { window.__lrn = []; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 120000, intervals: [500] }).toBeGreaterThan(0);
    const t = await page.evaluate(() => {
      const ready = window.__lrn.find((m) => m.type === 'lrn:ready');
      const anch = window.__lrn.find((m) => m.type === 'lrn:anchored');
      const st = {}; for (const r of anch.results) st[r.state] = (st[r.state] || 0) + 1;
      return { ms: Math.round(anch.t - ready.t), states: st, textLength: anch.textLength };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return t;
  }

  test('T014-P1 200 annotations, the same version of a 0.5 MB lesson: lrn:ready → lrn:anchored < 2 s at CPU ×4, all ok', async ({ page }) => {
    test.setTimeout(240000);
    const html = lessonHtml('Първи', longBody());
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': html });
    await openLesson(page);
    await annotateByText(page, L1, html, needles);
    const t = await timeAnchoring(page);
    test.info().annotations.push({ type: 'T014-P1 same version, CPU ×4', description: JSON.stringify(t) });
    expect(t.states).toEqual({ ok: 200 });
    expect(t.ms).toBeLessThan(2000);
  });

  // Measured 1.6 s alone, 2.3 s with 3 workers: around the 2 s goal, so the
  // hard limit here is 4 s and the number is in the annotation (T014-D3 is
  // about longer quotes, P2b / P3).
  test('T014-P2 200 annotations (≈ 80 characters) after re-import with a word inserted in each annotated paragraph (all fuzzy): ≈ 2 s at CPU ×4 (limit 4 s)', async ({ page }) => {
    test.setTimeout(300000);
    const html = lessonHtml('Първи', longBody());
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': html });
    await openLesson(page);
    await annotateByText(page, L1, html, needles);
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': lessonHtml('Първи', longBody(' внимателно', 15)) });
    await openLesson(page);
    const t = await timeAnchoring(page);
    test.info().annotations.push({ type: 'T014-P2 all fuzzy, CPU ×4', description: JSON.stringify(t) });
    expect(t.states).toEqual({ fuzzy: 200 });
    expect(t.ms).toBeLessThan(4000);
  });

  test('T014-P2b 200 whole paragraphs (≈ 170 characters) after the same kind of edit (all fuzzy): < 2 s at CPU ×4', async ({ page }) => {
    test.setTimeout(300000);
    const html = lessonHtml('Първи', longBody());
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': html });
    await openLesson(page);
    const whole = Array.from({ length: 200 }, (_, k) => `Абзац ${k * 15}. Производителят оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${k * 15}, и документира резултата в техническата документация.`);
    await annotateByText(page, L1, html, whole);
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': lessonHtml('Първи', longBody(' внимателно', 15)) });
    await openLesson(page);
    const t = await timeAnchoring(page);
    test.info().annotations.push({ type: 'T014-P2b whole paragraphs fuzzy, CPU ×4', description: JSON.stringify(t) });
    expect(t.states).toEqual({ fuzzy: 200 });
    expect(t.ms).toBeLessThan(2000);
  });

  test('T014-P3 (T014-D3) 20 long annotations (≈ 2000 characters each, whole passages) after a small edit: < 2 s at CPU ×4', async ({ page }) => {
    test.setTimeout(300000);
    const html = lessonHtml('Първи', longBody());
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': html });
    await openLesson(page);
    const longNeedles = await page.evaluate(async (html) => {
      const A = await import('./src/anchor.js');
      const m = A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body);
      return Array.from({ length: 20 }, (_, k) => { const s = m.text.indexOf(`Абзац ${k * 140}.`); return m.text.slice(s, s + 1990).trim(); });
    }, html);
    await annotateByText(page, L1, html, longNeedles);
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': lessonHtml('Първи', longBody(' внимателно', 140)) });
    await openLesson(page);
    const t = await timeAnchoring(page);
    test.info().annotations.push({ type: 'T014-P3 20 × 2000 characters fuzzy, CPU ×4', description: JSON.stringify(t) });
    expect(Object.values(t.states).reduce((a, b) => a + b, 0)).toBe(20);
    expect(t.ms).toBeLessThan(2000);
  });

  test('T014-P4 a lesson with a ticking clock (its text changes every second) and 50 orphan annotations: how busy the frame is at CPU ×4 (every change re-searches every orphan)', async ({ page }) => {
    test.setTimeout(240000);
    const clock = '<p id="clock">Остават 100 секунди.</p><script>let n = 100; setInterval(() => { document.getElementById("clock").textContent = "Остават " + (--n) + " секунди."; }, 1000);</script>';
    const v1 = lessonHtml('Първи', longBody());
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': v1 });
    await openLesson(page);
    const orphanNeedles = Array.from({ length: 50 }, (_, k) => `Абзац ${k * 60}. Производителят оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${k * 60}, и документира`);
    await annotateByText(page, L1, v1, orphanNeedles);
    // The new version: other text (all orphans) + the clock.
    const other = Array.from({ length: N }, (_, i) => `<p>Съвсем друг текст ${i} без нищо общо с предишния, около същата дължина за сравнение и проверка на скоростта.</p>`).join('\n');
    await importCourse(page, C, { ...files(), 'lessons/0001-parvi.html': lessonHtml('Първи', clock + other) });
    await openLesson(page);
    await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 60000 }).toBeGreaterThan(0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // The share of 10 s the main thread (app + lesson: one process) is blocked by long tasks.
    const busy = await page.evaluate(() => new Promise((res) => {
      let blocked = 0; let last = performance.now();
      const id = setInterval(() => { const n = performance.now(); if (n - last > 70) blocked += n - last - 50; last = n; }, 50);
      setTimeout(() => { clearInterval(id); res(Math.round((blocked / 10000) * 100)); }, 10000);
    }));
    const runs = (await anchoredMsgs(page)).length;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    test.info().annotations.push({ type: 'T014-P4 busy % of 10 s at CPU ×4', description: `${busy} % (lrn:anchored ×${runs})` });
    expect(busy).toBeLessThan(10);
  });
});

// ===========================================================================
// T014-S: the lesson is untrusted
// ===========================================================================
test.describe('T014-S security of the bridge', () => {
  test.beforeEach(async ({ page }) => start(page));

  /** Records what the lesson receives (window.__got) and then runs `attack` (a function body). */
  const spy = (attack = '') => `<script>
    window.__got = [];
    addEventListener('message', (e) => { const m = e.data; if (!m || m.lrn !== 1) return; try { window.__got.push(JSON.parse(JSON.stringify(m))); } catch (err) { window.__got.push({ type: 'unserializable' }); } if (m.type === 'lrn:annotations' && !window.__attacked) { window.__attacked = true; (function (m) { ${attack} })(m); } });
  </script>`;

  async function setup(page, lessonBody, { other = true } = {}) {
    // Course B with the SAME lesson numbers and the same text (an id of its own).
    if (other) {
      await importCourse(page, 'LRN-T14B', files(BODY, {}, 'LRN-T14B'));
      await openLesson(page, '0001', 'LRN-T14B');
    }
    const base = files(BODY);
    await importCourse(page, C, base);
    await openLesson(page);
    const own = await annotateByText(page, L1, base['lessons/0001-parvi.html'], ['Уязвимостите се докладват', 'оценява рисковете'], { color: 'pink' });
    const deleted = (await annotateByText(page, L1, base['lessons/0001-parvi.html'], ['Краят на урока'], { color: 'blue' }))[0];
    await db(page, (db, id) => db.remove(db.STORES.annotations, id), deleted.id);
    const sameLessonOtherLesson = (await annotateByText(page, L2, base['lessons/0002-vtori.html'], ['Друг урок с текст'], { color: 'green' }))[0];
    const otherCourse = other ? (await annotateByText(page, 'LRN-T14B/lesson:0001', BODY, ['Уязвимостите се докладват'], { color: 'orange' }))[0] : null;
    const snapshot = async () => ({
      own: await annotations(page, L1),
      l2: await annotations(page, L2),
      b: other ? await annotations(page, 'LRN-T14B/lesson:0001') : [],
    });
    const before = await snapshot();
    // The hostile version of lesson 0001 (same text, plus the script).
    await importCourse(page, C, files(BODY + lessonBody));
    return { own, deleted, l2: sameLessonOtherLesson, otherCourse, before, snapshot };
  }
  const userFields = (list) => list.map((a) => ({ id: a.id, exact: a.exact, prefix: a.prefix, suffix: a.suffix, position: a.position, hint: a.hint, targetVersion: a.targetVersion, deleted: a.deleted, color: a.color, courseId: a.courseId, target: a.target }));

  test('T014-S1 forged reports with ids of a deleted annotation of this lesson, of another lesson and of the same lesson number in another course, with extra fields (selector, colour, deleted, target, __proto__): nothing but the state of the own, live annotations changes', async ({ page }) => {
    const s = await setup(page, '<script>window.__ids = null;</script>');
    await openLesson(page);
    const frame = await lessonFrame(page);
    await expect.poll(() => page.locator('.lesson-frame__wrap').getAttribute('data-anchored'), { timeout: 8000 }).toBe('2');
    await page.waitForTimeout(1500);
    const honest = await s.snapshot();
    const ids = { own: s.own.map((a) => a.id), deleted: s.deleted.id, l2: s.l2.id, b: s.otherCourse.id };
    await frame.evaluate((ids) => {
      const p = (x) => parent.postMessage(x, '*');
      const extra = { selector: { quote: { exact: 'ПОДМЕНЕН' }, position: { start: 0, end: 8 } }, color: 'orange', deleted: true, target: { type: 'lesson', id: 'LRN-T14/lesson:0002' }, courseId: 'LRN-X', anchorState: 'ok', targetVersion: 'x', updatedAt: '2099-01-01' };
      const evil = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted2": 1}}}');
      p({ lrn: 1, type: 'lrn:anchored', textLength: 1e7, results: [
        { id: ids.deleted, state: 'ok', position: { start: 1, end: 5 } },
        { id: ids.l2, state: 'orphan' },
        { id: ids.b, state: 'fuzzy', position: { start: 1, end: 5 } },
        { id: ids.own[0], state: 'fuzzy', position: { start: 3, end: 9, ...evil }, ...extra, ...evil },
        { id: ids.own[1], state: 'orphan', lastAnchor: { version: 'x' }, ...extra },
      ] });
      p({ lrn: 1, type: 'lrn:tap', annotationId: ids.b });
      p({ lrn: 1, type: 'lrn:tap', annotationId: ids.deleted });
      p({ lrn: 1, type: 'lrn:scroll-to', annotationId: ids.b });
    }, ids);
    await page.waitForTimeout(2500);
    const after = await s.snapshot();
    // The user's fields of every annotation are as before; only the own, live ones got a (lying) state.
    expect(userFields(after.own)).toEqual(userFields(honest.own));
    expect(after.l2).toEqual(honest.l2);
    expect(after.b).toEqual(honest.b);
    const byId = Object.fromEntries(after.own.map((a) => [a.id, a]));
    expect(byId[ids.deleted]).toEqual(honest.own.find((a) => a.id === ids.deleted));
    expect(byId[ids.own[0]].state).toBe('fuzzy');
    expect(byId[ids.own[0]].last).toMatchObject({ state: 'fuzzy', start: 3, end: 9 });
    expect(Object.keys(byId[ids.own[0]].last).sort()).toEqual(['at', 'end', 'start', 'state', 'version']);
    expect(byId[ids.own[1]].state).toBe('orphan');
    expect(await page.evaluate(() => [({}).polluted, ({}).polluted2, Object.prototype.polluted])).toEqual([undefined, undefined, undefined]);
    // The lie lasts until the next honest opening.
    await importCourse(page, C, files(BODY));
    await openLesson(page);
    await expect.poll(async () => (await annotations(page)).filter((a) => !a.deleted).map((a) => a.state), { timeout: 8000 }).toEqual(['ok', 'ok']);
  });

  test('T014-S2 what the lesson receives: only its own live annotations (not the deleted one, not lesson 0002, not the same lesson number of another course), no note, no key', async ({ page }) => {
    const s = await setup(page, spy());
    await db(page, async (db, { own, b }) => {
      await db.createNote({ annotationId: own, body: 'ТАЙНА-БЕЛЕЖКА-T14' });
      await db.createNote({ annotationId: b, body: 'ЧУЖД-КУРС-T14' });
      await db.saveApiKey('sk-ant-api03-T014FAKEFAKEFAKEFAKEFAKE');
    }, { own: s.own[0].id, b: s.otherCourse.id });
    const frame = await openLesson(page);
    await expect.poll(() => frame.evaluate(() => window.__got.some((m) => m.type === 'lrn:annotations')), { timeout: 8000 }).toBe(true);
    const got = await frame.evaluate(() => window.__got);
    const text = JSON.stringify(got);
    for (const bad of ['ТАЙНА', 'ЧУЖД', 'sk-ant', 'T014FAKE', s.deleted.id, s.l2.id, s.otherCourse.id, 'LRN-T14B', 'Друг урок', 'Краят на урока', 'courseId', 'note']) expect(text, bad).not.toContain(bad);
    const items = got.find((m) => m.type === 'lrn:annotations').items;
    expect(items.map((i) => i.id).sort()).toEqual(s.own.map((a) => a.id).sort());
  });

  // Prototype tampering: before the bridge (a script in <head>) and after it (on lrn:annotations).
  const TAMPER_BEFORE = `<script>
    String.prototype.indexOf = function () { return 0; };
    String.prototype.slice = function () { return 'Уязвимостите се докладват'; };
    Array.prototype.fill = function () { return this; };
    Map.prototype.get = function () { return { state: 'ok', start: 0, end: 1, exact: 'x', range: null }; };
    JSON.stringify = () => '{}';
    Object.defineProperty(Object.prototype, 'state', { get() { return 'ok'; }, set() {}, configurable: true });
    Range.prototype.getBoundingClientRect = () => ({ top: -1e12, bottom: NaN });
    Range.prototype.setStart = function () { throw new Error('no'); };
    document.createTreeWalker = function () { let i = 0; return { nextNode() { return i++ < 100000 ? document.createTextNode('Уязвимостите се докладват ' + i) : null; } }; };
    window.Highlight = function () { throw new Error('no'); };
    if (window.CSS && CSS.highlights) { CSS.highlights.set = () => { throw new Error('no'); }; }
    window.MutationObserver = function (cb) { return { observe() { setInterval(() => cb([{ target: document.body }]), 5); } }; };
  </script>`;
  const TAMPER_AFTER = `
    const p = (x) => parent.postMessage(x, '*');
    String.prototype.indexOf = function () { return 0; };
    Range.prototype.getBoundingClientRect = () => { throw new Error('no'); };
    if (window.CSS && CSS.highlights) { CSS.highlights.set = () => { throw new Error('no'); }; CSS.highlights.delete = () => { throw new Error('no'); }; }
    // Make the bridge re-anchor all the time and report lies in between.
    let n = 0;
    const t = setInterval(() => { document.body.append(document.createTextNode(' x' + (n++))); if (n > 40) clearInterval(t); }, 50);
    for (const it of m.items) p({ lrn: 1, type: 'lrn:anchored', results: [{ id: it.id, state: 'ok', position: { start: 0, end: 9999999 } }], textLength: 10000000 });
  `;

  for (const [name, head, body] of [['before the bridge', TAMPER_BEFORE, ''], ['after the bridge', '', TAMPER_AFTER]]) {
    test(`T014-S3 prototypes replaced ${name} (String/Array/Map/JSON/Object.prototype, Range, TreeWalker, Highlight, CSS.highlights, MutationObserver): the user's selectors and other lessons are untouched, the app stays responsive and keeps working`, async ({ page }) => {
      const s = await setup(page, '');
      await importCourse(page, C, { ...files(BODY + spy(body)), 'lessons/0001-parvi.html': lessonHtml('Първи', BODY + spy(body), head) });
      await page.goto(`./#/c/${C}/read/0001`);
      // The lesson may never be "ready" (its bridge may be broken): that is its own problem.
      await expect(page.locator('[data-lesson-state="ready"], [data-lesson-state="fallback"], [data-lesson-state="error"]')).toBeVisible({ timeout: 30000 });
      // The app stays responsive while the lesson misbehaves.
      const lag = await page.evaluate(() => new Promise((res) => { let max = 0; let last = performance.now(); const id = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 20); setTimeout(() => { clearInterval(id); res(Math.round(max)); }, 4000); }));
      test.info().annotations.push({ type: `T014-S3 ${name}: max lag of the app`, description: `${lag} ms` });
      expect(lag).toBeLessThan(1500);
      const after = await s.snapshot();
      expect(userFields(after.own)).toEqual(userFields(s.before.own));
      expect(after.l2).toEqual(s.before.l2);
      expect(after.b).toEqual(s.before.b);
      // The app keeps working: another lesson opens and anchors honestly.
      await openLesson(page, '0001', 'LRN-T14B');
      await expect.poll(async () => (await annotations(page, 'LRN-T14B/lesson:0001'))[0].state, { timeout: 8000 }).toBe('ok');
      await expect(page.locator('.lesson-frame__wrap')).toHaveAttribute('data-anchored', '1');
    });
  }

  test('T014-S4 huge and numerous messages: 30 × 4 MB lrn:anchored and 2000 small forged reports a second — rate-limited, nothing stored beyond the own state, the app stays usable', async ({ page }) => {
    test.setTimeout(120000);
    const s = await setup(page, spy(`
      const p = (x) => parent.postMessage(x, '*');
      const big = 'я'.repeat(2 * 1024 * 1024);
      for (let i = 0; i < 30; i++) p({ lrn: 1, type: 'lrn:anchored', results: [{ id: m.items[0].id, state: 'fuzzy', position: { start: 1, end: 2 }, junk: big }] });
      let k = 0; const t = setInterval(() => { for (let i = 0; i < 200; i++) p({ lrn: 1, type: 'lrn:anchored', results: m.items.map((it) => ({ id: it.id, state: (k + i) % 2 ? 'ok' : 'orphan', position: { start: i + 1, end: i + 5 } })) }); if (++k > 20) { clearInterval(t); window.__done = true; } }, 100);
    `), { other: false });
    const frame = await openLesson(page);
    await expect.poll(() => frame.evaluate(() => window.__done === true), { timeout: 30000 }).toBe(true);
    await page.waitForTimeout(2500);
    const after = await s.snapshot();
    expect(userFields(after.own)).toEqual(userFields(s.before.own));
    expect(after.l2).toEqual(s.before.l2);
    // Writes are coalesced: the record of the own annotation was written only a few times.
    // (The store keeps no history, so: the app is still usable and the lie is only a state.)
    await page.goto(`./#/c/${C}`);
    await expect(page.locator('[data-screen="course"]')).toBeVisible({ timeout: 10000 });
  });

  test('T014-S5 a lesson that changes its DOM every 50 ms forever: the debounce keeps re-anchoring from running (no endless loop), the app stays responsive', async ({ page }) => {
    const s = await setup(page, `<p id="t">0</p><script>let n = 0; setInterval(() => { document.getElementById('t').textContent = String(n++); }, 50);</script>`, { other: false });
    await openLesson(page);
    await expect.poll(() => page.locator('.lesson-frame__wrap').getAttribute('data-anchored'), { timeout: 8000 }).toBe('2');
    await page.evaluate(() => { window.__lrn = []; });
    const lag = await page.evaluate(() => new Promise((res) => { let max = 0; let last = performance.now(); const id = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 20); setTimeout(() => { clearInterval(id); res(Math.round(max)); }, 3000); }));
    const runs = (await anchoredMsgs(page)).length;
    test.info().annotations.push({ type: 'T014-S5', description: `max lag ${lag} ms, lrn:anchored ×${runs} in 3 s` });
    expect(lag).toBeLessThan(500);
    expect(runs).toBeLessThanOrEqual(2);
    expect(userFields(await annotations(page))).toEqual(userFields(s.before.own));
  });

  test('T014-S6 two tabs: the reader of tab A saves the anchoring while tab B changes the colour and deletes another annotation: B\'s changes survive (the write is a patch on the current record)', async ({ page, context }) => {
    // A counter at the top whose length alternates: the places of the marks move at every tick, so the reader keeps saving.
    const base = files(`<p id="t">0</p>${BODY}<script>let n = 0; setInterval(() => { document.getElementById('t').textContent = (n++ % 2) ? 'Брояч' : 'Брояч с по-дълъг текст'; }, 400);</script>`);
    await importCourse(page, C, base);
    await openLesson(page);
    const [a, b] = await annotateByText(page, L1, base['lessons/0001-parvi.html'], ['Уязвимостите се докладват', 'оценява рисковете'], { color: 'pink', version: 'other-version' });
    await openLesson(page);
    const tabB = await context.newPage();
    await tabB.goto('./');
    await expect(tabB.locator('[data-screen="courses"]')).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await db(tabB, async (db, { a, b, i }) => { await db.updateAnnotation(a, { color: ['green', 'blue', 'orange', 'yellow', 'green'][i] }); if (i === 4) await db.remove(db.STORES.annotations, b); }, { a: a.id, b: b.id, i });
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(2000);
    await page.goto(`./#/c/${C}`);
    const list = Object.fromEntries((await annotations(page)).map((x) => [x.id, x]));
    expect(list[a.id].color).toBe('green');
    expect(list[b.id].deleted).toBe(true);
    expect(list[a.id].last).not.toBe(null);
    await tabB.close();
  });

  test('T014-S7 information: a forged lrn:selection becomes the user\'s annotation when the user presses a colour (T-015) — the quote is whatever the lesson said (inherent: the selection is read inside the lesson)', async ({ page }) => {
    await importCourse(page, C, files(BODY + spy(`
      parent.postMessage({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'Текст, който го няма в урока', prefix: '', suffix: '' }, position: { start: 0, end: 5 } }, '*');
    `)));
    await openLesson(page);
    await page.waitForTimeout(800);
    // The checked selection kept by lesson-frame is what annotate() would store.
    const kept = await page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection').at(-1)?.quote?.exact);
    test.info().annotations.push({ type: 'T014-S7', description: `selection kept by the app: ${kept}` });
    expect(kept).toBe('Текст, който го няма в урока');
  });
});

// ===========================================================================
// T014-I: re-import
// ===========================================================================
test.describe('T014-I re-import', () => {
  test.beforeEach(async ({ page }) => start(page));
  const many = (n) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(4, '0'));
  const courseOf = (n, text = (k) => `<p>Урок ${k} с текст за маркиране.</p>`, refs = true) => {
    const nums = many(n);
    const out = {
      'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n${nums.map((k) => `| ${k} | Урок ${k} |`).join('\n')}\n${refs ? '\n## Справочници\n| # | Заглавие |\n|---|---|\n| R01 | Справка |\n' : ''}`,
    };
    for (const k of nums) out[`lessons/${k}-urok.html`] = lessonHtml(`Урок ${k}`, text(k));
    if (refs) out['reference/R01-spravka.html'] = lessonHtml('Справка', text('R01'));
    return out;
  };

  test('T014-I1 the summary note: changed lessons with live marks only (not unchanged, not with deleted marks only), a reference too, "и др." after five', async ({ page }) => {
    const v1 = courseOf(8);
    await importCourse(page, C, v1);
    for (const k of [...many(7), 'R01']) {
      const id = k === 'R01' ? `${C}/reference:R01` : `${C}/lesson:${k}`;
      const html = k === 'R01' ? v1['reference/R01-spravka.html'] : v1[`lessons/${k}-urok.html`];
      const [a] = await annotateByText(page, id, html, [`Урок ${k} с текст`]);
      if (k === '0007') await db(page, (db, id) => db.remove(db.STORES.annotations, id), a.id);
    }
    // 0001 unchanged; 0002…0007 and R01 changed; 0008 changed but has no marks.
    const v2 = courseOf(8, (k) => (k === '0001' ? `<p>Урок ${k} с текст за маркиране.</p>` : `<p>Нов абзац.</p><p>Урок ${k} с текст за маркиране.</p>`));
    const summary = await importCourse(page, C, v2);
    test.info().annotations.push({ type: 'T014-I1 summary', description: summary });
    const note = summary.match(/Маркировките в ([^]*?) ще се проверят/);
    expect(note, summary).not.toBe(null);
    const listed = note[1];
    expect(listed).not.toContain('0001');
    expect(listed).not.toContain('0007');
    expect(listed).not.toContain('0008');
    expect(listed).toContain('и др.');
    expect(listed.startsWith('0002')).toBe(true);
    // A re-import of the same files says nothing about marks.
    expect(await importCourse(page, C, v2)).not.toContain('Маркировките');
  });

  test('T014-I1b the note names a changed reference with marks (R01)', async ({ page }) => {
    const v1 = courseOf(1);
    await importCourse(page, C, v1);
    await annotateByText(page, `${C}/reference:R01`, v1['reference/R01-spravka.html'], ['Урок R01 с текст']);
    const summary = await importCourse(page, C, courseOf(1, (k) => (k === 'R01' ? '<p>Ново.</p><p>Урок R01 с текст за маркиране.</p>' : `<p>Урок ${k} с текст за маркиране.</p>`)));
    expect(summary).toMatch(/Маркировките на R01 ще се проверят/);
  });

  test('T014-I2 a retired lesson (gone from the course) keeps its annotations: nothing deleted, and it still anchors when opened from "Вече не са в курса"', async ({ page }) => {
    const v1 = courseOf(3, undefined, false);
    await importCourse(page, C, v1);
    const [a] = await annotateByText(page, `${C}/lesson:0002`, v1['lessons/0002-urok.html'], ['Урок 0002 с текст']);
    const v2 = courseOf(3, undefined, false);
    delete v2['lessons/0002-urok.html'];
    v2['INDEX.md'] = v2['INDEX.md'].replace('| 0002 | Урок 0002 |\n', '');
    const summary = await importCourse(page, C, v2);
    test.info().annotations.push({ type: 'T014-I2 summary', description: summary });
    const lesson = await db(page, (db, id) => db.getLesson(id).then((l) => ({ retired: l.retired, deleted: l.deleted })), `${C}/lesson:0002`);
    expect(lesson.retired).toBe(true);
    const list = await annotations(page, `${C}/lesson:0002`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.id, deleted: false, exact: 'Урок 0002 с текст' });
    await openLesson(page, '0002');
    await expect.poll(async () => (await annotations(page, `${C}/lesson:0002`))[0].last?.state ?? null, { timeout: 8000 }).toBe('ok');
  });

  test('T014-I3 lastAnchor of another version and a wrong lastAnchor of this version are only a starting point: the app sends the creation position for another version, the bridge checks the text at a remembered place', async ({ page }) => {
    await importCourse(page, C, files());
    await openLesson(page);
    const html = files()['lessons/0001-parvi.html'];
    const [a, b] = await annotateByText(page, L1, html, ['Уязвимостите се докладват', 'Задълженията за докладване'], { version: 'old' });
    const shaNow = await db(page, (db, id) => db.getLesson(id).then((l) => l.sha256), L1);
    await db(page, async (db, { a, b, sha }) => {
      await db.update(db.STORES.annotations, a, { lastAnchor: { version: 'другa', state: 'ok', start: 0, end: 10, at: 'x' } });
      // This version, but a wrong place (as a lying lesson could have left it).
      await db.update(db.STORES.annotations, b, { lastAnchor: { version: sha, state: 'ok', start: 0, end: 26, at: 'x' } });
    }, { a: a.id, b: b.id, sha: shaNow });
    await openLesson(page);
    await expect.poll(async () => (await annotations(page)).map((x) => [x.state, x.last?.start === x.position.start]), { timeout: 8000 })
      .toEqual([['ok', true], ['ok', true]]);
    expect((await highlights(page))['lrn-yellow'].sort()).toEqual(['Задълженията за докладване', 'Уязвимостите се докладват']);
  });
});

// ===========================================================================
// T014-R: the lesson's own scripts change the DOM (LRN-DEMO quiz.js, reflect.js)
// ===========================================================================
test.describe('T014-R quiz.js / reflect.js', () => {
  test.beforeEach(async ({ page }) => start(page));

  test('T014-R1 LRN-DEMO: "Събери отговорите" (reflect.js) adds text before the footer; quiz.js redraws; marks before, between and after stay ok and painted', async ({ page }) => {
    const demo = readFixture();
    const fs = Object.fromEntries(Object.entries(demo).filter(([p]) => !p.startsWith('sources/')));
    await importCourse(page, 'LRN-DEMO', fs);
    const frame = await openLesson(page, '0001', 'LRN-DEMO');
    const html = new TextDecoder().decode(demo['lessons/0001-vidove-chay.html']);
    const texts = await frame.evaluate(() => {
      const nodes = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement;
        if (!el.closest('p') || el.closest('.quiz, [data-lrn-noanno], .reflect, script, style')) continue;
        const t = n.data.trim();
        if (t.length > 30 && !/\s\s|\n/.test(t)) nodes.push(t.slice(0, 25).trim());
      }
      return [nodes[0], nodes[Math.floor(nodes.length / 2)], nodes.at(-1)];
    });
    void html;
    // Made as the bridge would: in the frame's own model (scripts may have added text).
    const made = [];
    for (const t of texts) {
      await page.evaluate(() => { window.__lrn = window.__lrn.filter((m) => m.type !== 'lrn:selection'); });
      await frame.evaluate((needle) => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.data.indexOf(needle) >= 0) { const j = n.data.indexOf(needle); const r = document.createRange(); r.setStart(n, j); r.setEnd(n, j + needle.length); getSelection().removeAllRanges(); getSelection().addRange(r); return; } }
        throw new Error(`not found ${needle}`);
      }, t);
      await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length), { timeout: 5000 }).toBeGreaterThan(0);
      const sel = await page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).at(-1));
      made.push(await page.evaluate(async (sel) => {
        const db = await import('./src/db.js');
        const { annotateSelection } = await import('./src/annotations.js');
        const course = await db.getCourse('LRN-DEMO');
        const lesson = await db.getLesson('LRN-DEMO/lesson:0001');
        return annotateSelection({ course, lesson, selection: { empty: false, quote: sel.quote, position: sel.position, hint: sel.hint ?? null }, color: 'green' });
      }, sel));
    }
    const f2 = await openLesson(page, '0001', 'LRN-DEMO');
    await expect(page.locator('.lesson-frame__wrap')).toHaveAttribute('data-anchored', '3', { timeout: 8000 });
    // reflect.js: type an answer and collect it (text appears in a <pre>).
    const ta = f2.locator('.reflect textarea').first();
    if (await ta.count()) {
      await ta.fill('Моят отговор за проверка на закотвянето, достатъчно дълъг текст.');
      await f2.locator('.reflect-collect').click();
      await expect(f2.locator('.reflect-output')).toBeVisible();
    }
    // quiz.js (if the lesson still has its inline quiz) — click through.
    for (let i = 0; i < 3; i++) {
      const c = f2.locator('.quiz .quiz-choice:not([disabled])').first();
      if (await c.count()) await c.click();
      const next = f2.locator('.quiz .quiz-next');
      if (await next.count()) await next.click();
    }
    await page.waitForTimeout(1200);
    const hl = await highlights(page);
    expect((hl['lrn-green'] || []).length).toBe(3);
    const states = (await annotations(page, 'LRN-DEMO/lesson:0001')).map((a) => a.state);
    expect(states).toEqual(['ok', 'ok', 'ok']);
    expect(made.map((m) => m.selector.quote.exact)).toEqual(texts);
  });
});
