// T-013-fix test (tester): the anchoring fixes of 0.12.1 attacked from outside.
// - T013F-U: src/anchor.js itself — T014-D1 (a short quote without its context
//   is never "ok" at another place: one copy / many, every length 1…23, unicode),
//   the new 0.7 threshold with the context intact on both sides (never "ok";
//   false matches where the context repeats: list items with the same
//   beginnings, the same sentence in several sections, a quote replaced by one
//   of similar meaning), random selections over a lesson full of repeated
//   sentences, T014-D2 (<br> = space; quotes glued by 0.12.0);
// - T013F-B: through the real lesson frame — the state of a "провери" after
//   the next opening, a lesson that changes its text (around a mark, inside
//   a mark, a deletion that brings a quote back, a clock, an animated counter,
//   a MutationObserver bomb), hostile hints and changes;
// - T013F-P: speed at CPU ×4 (the tablet) — 500 annotations, a 5 MB lesson,
//   all orphans, pathological text ("аааа…", the same paragraph 3000 times,
//   long words without spaces): the app's main thread (rAF, timers, input)
//   keeps answering, and the results are the right ones.
// Known defects are test.fail(true, 'T013F-D…') so the suite stays green.
// Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  // Errors of the app window only: some lessons below break themselves on purpose.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/c\/LRN-/.test(m.location()?.url || '')) return;
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

const C = 'LRN-T13FT';
const L1 = `${C}/lesson:0001`;
const lessonHtml = (body, head = '') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Първи</title>${head}</head><body><main><h1>Първи</h1>${body}</main></body></html>`;
const courseFiles = (body) => ({ 'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`, 'lessons/0001-parvi.html': lessonHtml(body) });

async function start(page) {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push({ type: e.data.type, results: e.data.results, t: performance.now(), d: Date.now() }); });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}
async function importCourse(page, body) {
  const bytes = Object.fromEntries(Object.entries(courseFiles(body)).map(([p, v]) => [p, strToU8(v)]));
  const f = asFile(`${C}.zip`, makeZip(bytes, { root: C }));
  return page.evaluate(async ({ name, data }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(data)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, data: [...f.buffer] });
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 60000 });
async function lessonFrame(page) {
  return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame();
}
async function openLesson(page) {
  const hash = `#/c/${C}/read/0001`;
  if (new URL(page.url()).hash === hash) await page.reload(); else await page.goto(`./${hash}`);
  await waitReady(page);
  return lessonFrame(page);
}
/** Leaves the reader (its pending writes are flushed) and waits until every annotation has a lastAnchor of the current version. */
async function closeReader(page) {
  await page.goto(`./#/c/${C}`);
  await expect(page.locator('[data-screen="course"]')).toBeVisible({ timeout: 10000 });
}
/**
 * Annotations made in the store with the selectors the bridge makes: src/anchor.js
 * on `html`'s body; a needle is a string or [string, nth]; `model` = 'old' builds
 * the selector on the 0.12.0 text model (a <br> gave no space: the html without <br>).
 */
async function annotate(page, html, needles, { color = 'yellow', model = 'new' } = {}) {
  return page.evaluate(async ({ html, needles, color, model, id }) => {
    const db = await import('./src/db.js');
    const A = await import('./src/anchor.js');
    const lesson = await db.getLesson(id);
    const m = A.anchorTextModel(new DOMParser().parseFromString(model === 'old' ? html.replace(/<br\s*\/?>/gi, '') : html, 'text/html').body);
    const out = [];
    for (const n of needles) {
      const [needle, nth = 0] = Array.isArray(n) ? n : [n, 0];
      let at = -1;
      for (let k = 0; k <= nth; k++) at = m.text.indexOf(needle, at + 1);
      if (at < 0) throw new Error(`not in the model: ${needle}`);
      const selector = A.anchorDescribe(m, at, at + needle.length);
      out.push(await db.createAnnotation({ courseId: lesson.courseId, target: { type: 'lesson', id }, targetVersion: lesson.sha256, selector, color }));
    }
    return out;
  }, { html, needles, color, model, id: L1 });
}
/** `n` annotations whose quotes were never in the lesson (orphans wherever they are opened). */
const addOrphans = (page, n) => page.evaluate(async ({ id, n }) => {
  const db = await import('./src/db.js');
  const lesson = await db.getLesson(id);
  for (let k = 0; k < n; k++) {
    await db.createAnnotation({ courseId: lesson.courseId, target: { type: 'lesson', id }, targetVersion: 'other', color: 'blue',
      selector: { quote: { exact: `Текст ${k}, който никога не е бил в този урок и няма да бъде намерен там.`, prefix: 'нещо отпред ', suffix: ' нещо отзад' }, position: { start: k * 100, end: k * 100 + 60 } } });
  }
}, { id: L1, n });
const stored = (page) => page.evaluate(async (id) => {
  const db = await import('./src/db.js');
  return (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true })).map((a) => ({
    id: a.id, state: a.anchorState, exact: a.selector.quote.exact, prefix: a.selector.quote.prefix, suffix: a.selector.quote.suffix,
    position: a.selector.position, last: a.lastAnchor ?? null, deleted: a.deleted, color: a.color,
  }));
}, L1);
const states = async (page) => (await stored(page)).map((a) => a.state);
/** The text under every painted mark, by highlight name. */
const highlights = async (page) => (await lessonFrame(page)).evaluate(() => Object.fromEntries([...CSS.highlights].map(([k, h]) => [k, [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim())])));
const anchoredMsgs = (page) => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:anchored'));
const lastAnchored = async (page) => (await anchoredMsgs(page)).at(-1);

/** Levenshtein similarity (1 − d / max length), as src/anchor.js defines it. */
function similarity(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * Watches the app's main thread from inside the app window: the longest gap
 * between animation frames, between 20 ms timers, and the delay of synthetic
 * input (a mouse move dispatched by CDP every 250 ms over the app's top bar,
 * delay = pointermove handler start − event time). Returns stop() → numbers.
 */
async function watchMainThread(page) {
  await page.evaluate(() => {
    const w = { raf: 0, timer: 0, input: [], stop: false };
    window.__watch = w;
    let lr = performance.now();
    const frame = () => { const n = performance.now(); w.raf = Math.max(w.raf, n - lr); lr = n; if (!w.stop) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    let lt = performance.now();
    w.id = setInterval(() => { const n = performance.now(); w.timer = Math.max(w.timer, n - lt); lt = n; }, 20);
    w.onDown = (e) => { w.input.push(performance.now() - e.timeStamp); };
    window.addEventListener('pointermove', w.onDown, true);
  });
  const cdp = await page.context().newCDPSession(page);
  let clicking = true;
  const clicks = (async () => {
    for (let k = 0; clicking; k++) {
      // A point in the app's own top bar (never on the lesson frame); a move, so nothing is activated.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4 + (k % 2) * 4, y: 6 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  return async () => {
    clicking = false;
    await clicks;
    await cdp.detach().catch(() => {});
    return page.evaluate(() => {
      const w = window.__watch;
      w.stop = true;
      clearInterval(w.id);
      window.removeEventListener('pointermove', w.onDown, true);
      return { raf: Math.round(w.raf), timer: Math.round(w.timer), inputMax: Math.round(Math.max(0, ...w.input)), inputs: w.input.length };
    });
  };
}
async function throttle(page, rate) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}
/** The main thread's busy time (CDP Performance TaskDuration, seconds) of the renderer of the page (the lesson frame is in the same process). */
async function taskSeconds(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'TaskDuration').value;
}

// ===========================================================================
// T013F-U: src/anchor.js
// ===========================================================================
test.describe('T013F-U src/anchor.js', () => {
  test.beforeEach(async ({ page }, ti) => { landscapeOnly(ti); await page.goto('./'); });
  /** Runs `fn(A, M, sel, at, arg)` in the app page: A = src/anchor.js, M(html) = text model of a body. */
  const run = (page, fn, arg) => page.evaluate(`(async () => {
    const A = await import('./src/anchor.js');
    const M = (html) => A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body);
    const sel = (m, needle, nth = 0) => { let at = -1; for (let k = 0; k <= nth; k++) at = m.text.indexOf(needle, at + 1); if (at < 0) throw new Error('no ' + needle); return A.anchorDescribe(m, at, at + needle.length); };
    const at = (m, r) => (r.state === 'orphan' ? null : m.text.slice(r.start, r.end));
    return (${fn.toString()})(A, M, sel, at, ${JSON.stringify(arg ?? null)});
  })()`);

  test('T013F-U1 (T014-D1) a short quote (1…23 characters) whose place was deleted, left once or many times elsewhere with none of its context, is never "ok": Cyrillic, Latin, digits, emoji, NFD, RTL, CJK, at the start and the end of the lesson', async ({ page }) => {
    const r = await run(page, (A, M, sel) => {
      const out = { bad: [], counts: { fuzzy: 0, orphan: 0, ok: 0 }, long: {} };
      const alphabets = {
        cyr: 'ЖЗИКЛМНОПРСТУФХЦЧШЩЮЯабвгде',
        lat: 'QWXZJKVYqwxzjkvyPLMNBRTSHGF',
        dig: '27184609351728461093827364',
        emoji: '😀👍🏽🇧🇬✅🔒📄🧪⚙️🛡️',
        nfd: 'и̇й̆ѐё̈ӣў'.normalize('NFD').repeat(3),
        rtl: 'שלוםעולםمرحبابالعالم',
        cjk: '网络安全法规产品数字元素制造商',
      };
      for (const [name, letters] of Object.entries(alphabets)) {
        for (let L = 1; L <= 23; L++) {
          const q = [...letters].slice(0, L).join('').slice(0, L);
          if (!q.trim()) continue;
          for (const copies of [1, 3]) {
            for (const where of ['middle', 'start', 'end']) {
              const copy = Array.from({ length: copies }, (_, k) => `<p>Друго място ${k}: ${q} и нещо съвсем различно.</p>`).join('');
              const orig = `<p>Тук е оригиналът — ${q} — със своя контекст около него.</p>`;
              const v1 = where === 'start' ? `<p>${q} е в самото начало на урока, преди всичко.</p>${copy}<p>Край.</p>`
                : where === 'end' ? `<p>Начало на урока.</p>${copy}<p>${q}</p>`
                  : `<p>Начало на урока с някакъв текст тук.</p>${copy}${orig}<p>Край.</p>`;
              const m1 = M(v1);
              // The original: at the very start, at the very end, or after "оригиналът — ".
              const T = m1.text;
              const o = where === 'start' ? 0 : where === 'end' ? T.length - q.length : T.indexOf(`оригиналът — ${q}`) + 'оригиналът — '.length;
              if (T.slice(o, o + q.length) !== q) throw new Error(`setup ${name} ${L} ${where}`);
              const s = A.anchorDescribe(m1, o, o + q.length);
              const v2 = where === 'start' ? `<p>Ново начало.</p>${copy}<p>Край.</p>` : where === 'end' ? `<p>Начало на урока.</p>${copy}<p>Друг край.</p>` : `<p>Начало на урока с някакъв текст тук.</p>${copy}<p>Край.</p>`;
              const f = A.anchorFind(M(v2), s);
              out.counts[f.state]++;
              if (f.state === 'ok') out.bad.push(`${name} L${L} ×${copies} ${where}: ${q}`);
            }
          }
        }
      }
      // Information: a quote of 24+ characters is not "short" — the same rule gives ok.
      for (const L of [23, 24, 30]) {
        const q = 'регламентът за киберустойчивост на продуктите'.slice(0, L);
        const v1 = `<p>Начало.</p><p>Друго място: ${q} и нещо съвсем различно.</p><p>Тук е оригиналът — ${q} — със своя контекст около него.</p>`;
        const f = A.anchorFind(M(v1.replace(/<p>Тук е оригиналът.*$/, '')), sel(M(v1), q, 1));
        out.long[L] = f.state;
      }
      return out;
    });
    test.info().annotations.push({ type: 'T013F-U1 states', description: JSON.stringify(r.counts) }, { type: 'T013F-U1 information: 23/24/30 characters', description: JSON.stringify(r.long) });
    expect(r.bad).toEqual([]);
    expect(r.counts.fuzzy).toBeGreaterThan(0);
    expect(r.long[23]).toBe('fuzzy');
  });

  test('T013F-U2 (T013F-D2) a short quote whose sentence was deleted goes "ok" to another place that shares only a common phrase with it ("член 14 от регламента"): ≥ 20 % of its context by chance', async ({ page }) => {
    const r = await run(page, (A, M, sel, at) => {
      const out = {};
      const cases = {
        article: ['<p>Въведение в регламента и неговия обхват за продуктите.</p><p>Виж член 14 от регламента за подробности по темата.</p><p>Съгласно член 14 от регламента, производителят уведомява ENISA.</p><p>Край на урока.</p>', 'член 14', 1, '<p>Съгласно член 14 от регламента, производителят уведомява ENISA.</p>'],
        list: ['<ul><li>Срок: 24 часа за ранно предупреждение до ENISA.</li><li>Срок: 72 часа за уведомление до CSIRT.</li></ul><p>Край.</p>', '72 часа', 0, '<li>Срок: 72 часа за уведомление до CSIRT.</li>'],
      };
      for (const [k, [v1, needle, nth, gone]] of Object.entries(cases)) {
        const m1 = M(v1);
        const s = sel(m1, needle, nth);
        const v2 = k === 'list' ? v1.replace(gone, '<li>Срок: 72 часа за друго, съвсем различно нещо.</li>') : v1.replace(gone, '');
        const m2 = M(v2);
        const f = A.anchorFind(m2, s);
        out[k] = [f.state, at(m2, f)];
      }
      return out;
    });
    expect(r.article[0]).not.toBe('ok');
    expect(r.list[0]).not.toBe('ok');
  });

  test('T013F-U3 the 0.7 threshold (context intact on both sides): never "ok"; a quote replaced by one of similar meaning, list items with the same beginnings and ends, the same sentence in several sections — "провери" or orphan, the wrong places are counted', async ({ page }) => {
    const r = await run(page, (A, M, sel, at) => {
      const out = { ok: [], okCopies: [], states: { fuzzy: 0, orphan: 0, ok: 0 }, wrong: [], placed: 0 };
      // `quote`: the user's text. "ok" is allowed only on an exact copy of it (step 2, not the approximate search);
      // an exact copy at another place is listed as information.
      const push = (name, f, m, right, quote) => {
        out.states[f.state]++;
        if (f.state === 'ok' && at(m, f) !== quote) out.ok.push(name);
        if (f.state === 'ok' && right && !(f.start < right[1] && f.end > right[0])) out.okCopies.push(name);
        if (f.state === 'fuzzy' && f.similarity < 0.8) out.placed++;
        if (f.state === 'fuzzy' && right && !(f.start < right[1] && f.end > right[0])) out.wrong.push(`${name}: ${at(m, f)} (${f.similarity})`);
      };
      // 1. Similar meaning, the context the same.
      const sec = (i, x) => `<section><h2>Раздел ${i}</h2><p>Важно: ${x} Това важи за всички продукти.</p></section>`;
      const q = 'производителят докладва уязвимостите до 24 часа.';
      const v1 = sec(1, 'вносителят проверява маркировката CE.') + sec(2, q) + sec(3, 'дистрибуторът пази документите 10 години.');
      const s1 = sel(M(v1), q);
      for (const x of ['производителят съобщава уязвимостите до 24 часа.', 'производителят уведомява за уязвимости в рамките на 24 часа.', 'производителят докладва пробивите до 72 часа.',
        'вносителят докладва уязвимостите до 24 часа.', 'производителите докладват уязвимостите до един ден.', 'уязвимостите се докладват от производителя до 24 часа.']) {
        const m = M(v1.replace(q, x));
        const a = m.text.indexOf(x);
        push(`similar: ${x}`, A.anchorFind(m, s1), m, [a, a + x.length], q);
      }
      // 2. The same sentence in five sections; the marked one edited by 20…35 %, or deleted.
      const same = 'Производителят трябва да осигури актуализации за сигурност през целия период на поддръжка.';
      const v2 = Array.from({ length: 5 }, (_, i) => `<section><h2>Раздел ${i}</h2><p>Въведение ${i}.</p><p>${same}</p><p>Заключение ${i}.</p></section>`).join('');
      const m2 = M(v2);
      for (let k = 0; k < 5; k++) {
        const s = sel(m2, 'осигури актуализации за сигурност', k);
        for (const edit of ['гарантира актуализации и за сигурност', 'осигури поправки за сигурност', 'предостави обновления по сигурността', null]) {
          let n = -1;
          const html = v2.replace(new RegExp(same.replace(/[.]/g, '\\.'), 'g'), (s0) => (++n === k ? (edit === null ? '' : s0.replace('осигури актуализации за сигурност', edit)) : s0));
          const m = M(html);
          let right = null;
          if (edit !== null) { let a = -1; for (let j = 0; j <= k; j++) a = m.text.indexOf(`Въведение ${j}.`, a + 1); const b = m.text.indexOf(edit, a); right = [b, b + edit.length]; }
          const f = A.anchorFind(m, s);
          push(`section ${k} ${edit ?? 'deleted'}`, f, m, right ?? [-2, -1], 'осигури актуализации за сигурност');
        }
      }
      // 3. List items with the same beginnings and ends.
      const items = ['осигури актуализации за сигурност', 'осигури актуализации за съвместимост', 'осигури документация за сигурност', 'осигури поддръжка за сигурност'];
      const li = (x, i) => `<li>Изискване ${'ABCD'[i]}: производителят трябва да ${x} през целия период на поддръжка на продукта.</li>`;
      const v3 = `<p>Увод.</p><ul>${items.map(li).join('')}</ul><p>Край.</p>`;
      for (let k = 0; k < 4; k++) {
        const s = sel(M(v3), items[k]);
        const del = M(`<p>Увод.</p><ul>${items.map(li).filter((_, i) => i !== k).join('')}</ul><p>Край.</p>`);
        push(`list ${k} deleted`, A.anchorFind(del, s), del, [-2, -1], items[k]);
        const edited = items[k].replace('осигури', 'гарантира').replace(' за ', ' и за ');
        const mod = M(`<p>Увод.</p><ul>${items.map((x, i) => li(i === k ? edited : x, i)).join('')}</ul><p>Край.</p>`);
        const a = mod.text.indexOf(edited);
        push(`list ${k} edited`, A.anchorFind(mod, s), mod, [a, a + edited.length], items[k]);
      }
      // 4. Exactly at the threshold: a 30-character quote, its context whole, 9 / 10 characters changed.
      const q4 = 'abcdefghijklmnopqrstuvwxyz0123';
      const v4 = `<p>Контекст отпред, който е достатъчно дълъг: ${q4} и контекст отзад, също достатъчно дълъг.</p>`;
      const s4 = sel(M(v4), q4);
      for (const k of [8, 9, 10]) {
        const changed = q4.slice(0, 10) + 'Ж'.repeat(k) + q4.slice(10 + k);
        const m = M(v4.replace(q4, changed));
        const a = m.text.indexOf(changed);
        const f = A.anchorFind(m, s4);
        out[`edge${k}`] = f.state;
        push(`edge ${k}`, f, m, [a, a + changed.length], q4);
      }
      return out;
    });
    test.info().annotations.push({ type: 'T013F-U3 states', description: JSON.stringify(r.states) }, { type: 'T013F-U3 fuzzy below 0.8 (the new threshold)', description: String(r.placed) },
      { type: 'T013F-U3 information: "провери" at a wrong place', description: r.wrong.join(' | ') || 'none' },
      { type: 'T013F-U3 information: "ok" on an exact copy at another place (the same sentence in another section, 24+ characters)', description: r.okCopies.join(' | ') || 'none' });
    expect(r.ok).toEqual([]);
    expect(r.placed).toBeGreaterThan(0); // the lower threshold was reached at all
    expect([r.edge8, r.edge9, r.edge10]).toEqual(['fuzzy', 'fuzzy', 'orphan']); // 0.733, 0.7, 0.667
  });

  test('T013F-U4 (T013F-D2) 400 random short and long selections in a lesson made of a few repeated sentences, × 4 changes: "ok" only at the right place (a short quote never "ok" at another copy)', async ({ page }) => {
    const r = await run(page, (A, M) => {
      let seed = 1301;
      const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const pool = ['Производителят оценява рисковете.', 'Срокът е 24 часа.', 'Виж член 14 от регламента.', 'Уязвимостите се докладват на ENISA.', 'Това важи за всички продукти.', 'Вносителят проверява маркировката CE.', 'Срокът е 72 часа.', 'Документацията се пази 10 години.'];
      // Units: a sentence with an id; the lesson is 12 sections × 4 sentences from the pool (many repeats).
      const units = [];
      for (let s = 0; s < 12; s++) for (let i = 0; i < 4; i++) units.push({ id: `${s}.${i}`, s, text: pool[Math.floor(rnd() * pool.length)] });
      const html = (list) => {
        let out = ''; let cur = -1;
        for (const u of list) { if (u.s !== cur) { if (cur >= 0) out += '</p></section>'; out += `<section><h2>Част ${u.s}</h2><p>`; cur = u.s; } else out += ' '; out += u.text; }
        return `${out}</p></section>`;
      };
      const spans = (list) => { // the place of every unit in the model of html(list)
        const m = M(html(list)); const out = new Map(); let from = 0;
        for (const u of list) { const a = m.text.indexOf(u.text, from); out.set(u.id, [a, a + u.text.length]); from = a + u.text.length; }
        return { m, out };
      };
      const changes = {
        deleteSections: units.filter((u) => u.s % 3 !== 1),
        editWords: units.map((u, k) => (k % 5 === 2 ? { ...u, text: u.text.replace(/\s(\S+)\./, ' друго.'), edited: true } : u)),
        insert: units.flatMap((u, k) => (k % 7 === 3 ? [{ id: `n${k}`, s: u.s, text: 'Нов вмъкнат текст тук.' }, u] : [u])),
        shuffle: [...new Set(units.map((u) => u.s))].sort(() => rnd() - 0.5).flatMap((s) => units.filter((u) => u.s === s)),
      };
      const v1 = spans(units);
      const sels = [];
      while (sels.length < 400) {
        const u = units[Math.floor(rnd() * units.length)];
        const [a, b] = v1.out.get(u.id);
        const len = sels.length % 2 ? 1 + Math.floor(rnd() * 22) : 1 + Math.floor(rnd() * (b - a));
        const st = a + Math.floor(rnd() * Math.max(1, b - a - len));
        const d = A.anchorDescribe(v1.m, st, Math.min(b, st + len));
        if (!d) continue;
        sels.push({ u: u.id, off: d.position.start - a, len: d.position.end - d.position.start, d });
      }
      const bad = [];
      const counts = {};
      for (const [name, list] of Object.entries(changes)) {
        const v2 = spans(list);
        const byId = new Map(list.map((u) => [u.id, u]));
        for (const x of sels) {
          const f = A.anchorFind(v2.m, x.d);
          counts[`${name}:${f.state}`] = (counts[`${name}:${f.state}`] || 0) + 1;
          if (f.state !== 'ok') continue;
          const u = byId.get(x.u);
          const span = u ? v2.out.get(x.u) : null; // an edited sentence keeps its start: a quote there is still at its offset
          const right = span && f.start === span[0] + x.off && f.end === f.start + x.len;
          // "ok" elsewhere is accepted only for a long quote (24+): then it is the same text (information, counted).
          if (!right) {
            if (x.len < 24) bad.push(`${name} ${x.u} "${x.d.quote.exact}" → ${v2.m.text.slice(f.start, f.end)} @${f.start}`);
            else counts[`${name}:ok elsewhere (24+)`] = (counts[`${name}:ok elsewhere (24+)`] || 0) + 1;
          }
        }
      }
      return { bad, counts };
    });
    test.info().annotations.push({ type: 'T013F-U4 counts', description: JSON.stringify(r.counts) }, { type: 'T013F-U4 short quotes "ok" at a wrong place', description: `${r.bad.length}: ${r.bad.slice(0, 8).join(' | ')}` });
    expect(r.bad).toEqual([]);
  });

  test('T013F-U5 (T014-D2) <br> is a space: several <br>, <br/>, <br> at the start/end of a block, inside inline elements; the quote of a new selection has the space; positions after a <br> of 0.12.0 → ok at the new place', async ({ page }) => {
    const r = await run(page, (A, M, sel, at) => {
      const out = {};
      out.texts = ['<p>a<br>b<br/>c</p>', '<p><br>начало</p>', '<p>край<br></p><p>после</p>', '<p><b>удебелен<br>ред</b> и <i>курсив<br><br>два</i></p>', '<p>x <br> y</p>', '<p>ред<br>\n  втори</p>']
        .map((h) => M(h).text);
      // Positions made by 0.12.0 (no space for a <br>) of quotes AFTER the <br> in the same block: ok at the new place.
      const html = '<p>Първи ред<br>втори ред<br>трети ред с текст, който е маркиран от потребителя.</p><p>Друг абзац.</p>';
      const old = M(html.replace(/<br>/g, ''));
      const now = M(html);
      const s = sel(old, 'маркиран от потребителя');
      const f = A.anchorFind(now, s, { sameVersion: true });
      out.after = [f.state, at(now, f), s.position.start, f.start];
      return out;
    });
    expect(r.texts).toEqual(['a b c', 'начало', 'край после', 'удебелен ред и курсив два', 'x y', 'ред втори']);
    expect(r.after.slice(0, 2)).toEqual(['ok', 'маркиран от потребителя']);
    expect(r.after[3] - r.after[2]).toBe(2); // two <br> before it in the block
  });

  test('T013F-U6 (T013F-D5) quotes glued by 0.12.0 across a <br> are never lost: long ones "провери", but short ones (a word or two per line: a poem, an address) become orphans', async ({ page }) => {
    test.fail(true, 'T013F-D5: a short quote glued across one or more <br> by 0.12.0 ("Тиха 5София", "тукитам") is an orphan after 0.12.1, not "провери" (similarity < 0.8 or, under 12 characters, too little context — the context is glued too)');
    const r = await run(page, (A, M, sel, at) => {
      const out = {};
      const cases = [
        ['<p>Нещо преди това в урока.</p><p>Първи ред на стиха<br>втори ред на стиха<br>трети ред на стиха<br>четвърти ред</p><p>Край на урока.</p>', ['стихавтори', 'ред на стихавтори ред на стихатрети ред']],
        ['<p>Адрес:<br>ул. Тиха 5<br>София 1000<br>България</p><p>Край на урока.</p>', ['София 1000България', 'Тиха 5София', '5София']],
        ['<p>Нещо преди това в урока.</p><p>аз<br>съм<br>тук<br>и<br>там<br>сега<br>пак</p><p>Край на урока.</p>', ['азсъмтукитамсегапак', 'тукитам', 'съмтук']],
      ];
      for (const [html, needles] of cases) {
        const old = M(html.replace(/<br>/g, ''));
        const now = M(html);
        for (const n of needles) {
          const f = A.anchorFind(now, sel(old, n));
          out[n] = f.state === 'orphan' ? 'orphan' : `${f.state}: ${at(now, f)}`;
        }
      }
      return out;
    });
    test.info().annotations.push({ type: 'T013F-U6', description: JSON.stringify(r) });
    expect(r['стихавтори']).toBe('fuzzy: стиха втори');
    expect(r['ред на стихавтори ред на стихатрети ред']).toBe('fuzzy: ред на стиха втори ред на стиха трети ред');
    expect(r['София 1000България']).toBe('fuzzy: София 1000 България');
    expect(Object.values(r).filter((v) => v === 'orphan')).toEqual([]);
  });

  test('T013F-U7 hostile hints never give "ok" and stay fast: a hint to a decoy block with a near copy, to an excluded block, 200-character :has() chains, ids outside the body', async ({ page }) => {
    const r = await run(page, (A, M, sel, at) => {
      const v1 = '<p id="real">Производителят оценява рисковете за киберсигурността на продукта през целия му жизнен цикъл.</p><p id="other">Друг абзац.</p>';
      const s = sel(M(v1), 'оценява рисковете за киберсигурността на продукта');
      const v2 = '<p id="real">Производителят преценява рисковете за киберсигурността на продукта през целия му жизнен цикъл.</p><p id="decoy">Вносителят оценява рисковете за киберсигурността на продуктите.</p><div class="quiz"><p id="q">оценява рисковете за киберсигурността на продукта</p></div>';
      const m2 = M(v2);
      const out = { results: [], slow: 0 };
      const hints = ['#decoy', 'p:nth-of-type(2)', '#q', 'div.quiz > p', `${'p:has('.repeat(30)}p${')'.repeat(30)}`.slice(0, 200), 'html > head', '#nonexistent', 'p:nth-of-type(999999)', 'main'.repeat(50), '\u0000'];
      for (const blockPath of hints) {
        const t0 = performance.now();
        const f = A.anchorFind(m2, { ...s, hint: { blockPath }, position: { start: 1e6, end: 1e6 + 10 } });
        out.slow = Math.max(out.slow, performance.now() - t0);
        out.results.push([blockPath.slice(0, 20), f.state, at(m2, f)]);
      }
      return out;
    });
    test.info().annotations.push({ type: 'T013F-U7', description: JSON.stringify(r) });
    for (const [, state] of r.results) expect(state).not.toBe('ok');
    expect(r.slow).toBeLessThan(200);
  });
});

// ===========================================================================
// T013F-B: through the lesson frame
// ===========================================================================
test.describe('T013F-B bridge', () => {
  test.describe.configure({ mode: 'default' }); // B6/B6b/B7 are timing: in order, in one worker
  test.beforeEach(async ({ page }) => start(page));

  test('T013F-B1 (T013F-D1) a "провери" of T014-D1 (a short quote left once elsewhere without context) becomes "ok" at the wrong place at the NEXT opening of the same version (the saved lastAnchor is trusted)', async ({ page }) => {
    const v1 = '<p>Първо: CRA важи тук.</p><p>Второ: и CRA важи там за всички продукти.</p><p>Трето: регламентът.</p>';
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), [['CRA', 1]]);
    await importCourse(page, '<p>Първо: CRA важи тук.</p><p>Трето: регламентът.</p>');
    await openLesson(page);
    await expect.poll(() => states(page), { timeout: 10000 }).toEqual(['fuzzy']);
    await expect.poll(async () => (await stored(page))[0].last?.state, { timeout: 10000 }).toBe('fuzzy');
    await closeReader(page);
    for (let k = 0; k < 2; k++) {
      await page.evaluate(() => { window.__lrn = []; });
      await openLesson(page);
      await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
      expect((await lastAnchored(page)).results.map((x) => x.state)).toEqual(['fuzzy']);
      await closeReader(page);
    }
    expect(await states(page)).toEqual(['fuzzy']);
  });

  test('T013F-B2 a lesson whose text changes just before and just after a mark (counters in the same text node and in a neighbour): the mark stays "ok" on its own text at every tick, re-anchored within ≤ 2.5 s', async ({ page }) => {
    const v1 = '<p id="a">Остават 100 секунди до края на срока за докладване по CRA, след което 9 задачи.</p><p>Друг абзац за контекст.</p>';
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), ['секунди до края на срока за докладване', 'Друг абзац']);
    await importCourse(page, `${v1}<script>let n = 100; let k = 9; setInterval(() => { n = n === 100 ? 7 : n === 7 ? 1000 : 100; k = (k * 7) % 1000; document.getElementById('a').textContent = 'Остават ' + n + ' секунди до края на срока за докладване по CRA, след което ' + k + ' задачи.'; }, 700);</script>`);
    await openLesson(page);
    const want = ['секунди до края на срока за докладване', 'Друг абзац'];
    await expect.poll(() => highlights(page), { timeout: 10000 }).toMatchObject({ 'lrn-yellow': want });
    // Every tick moves the mark: sample for 6 s, the painted text is always the quote, the state always ok.
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const h = await highlights(page);
      seen.push(JSON.stringify(h['lrn-yellow'] || []));
      await page.waitForTimeout(250);
    }
    const msgs = await anchoredMsgs(page);
    const okAll = msgs.every((m) => m.results.every((x) => x.state === 'ok'));
    const gaps = msgs.slice(1).map((m, i) => m.t - msgs[i].t);
    test.info().annotations.push({ type: 'T013F-B2', description: `lrn:anchored ×${msgs.length}, max gap ${Math.round(Math.max(0, ...gaps))} ms; painted ${new Set(seen).size} distinct` });
    expect(okAll).toBe(true);
    // A moment between the change and the re-anchoring may paint the old range (empty / cut): at most a few samples, never another text.
    const wrong = seen.filter((s) => s !== JSON.stringify(want));
    expect(wrong.filter((s) => JSON.parse(s).some((t) => t && !want.includes(t)))).toEqual([]);
    expect(msgs.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...gaps)).toBeLessThan(2500);
  });

  test('T013F-B3 (T013F-D3) a lesson that rewrites a marked sentence a little at a time drags the "провери" along to a text that is no longer similar to the quote (< 0.7): each step is compared with the last place, not with the user\'s quote', async ({ page }) => {
    test.fail(true, 'T013F-D3: after a change inside a mark the bridge searches for the text it found last time (last.exact), not for the user\'s quote; a lesson that changes the text step by step drags the mark to anything (similarity to the quote far below the 0.7/0.8 thresholds)');
    const q = 'Производителят оценява рисковете за киберсигурността на продукта';
    const v1 = `<p>Увод в урока за контекст.</p><p id="s">${q} през целия жизнен цикъл.</p><p>Край на урока.</p>`;
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), [q]);
    await importCourse(page, v1.replace('<p>Край', '<p>Нов край'));
    const frame = await openLesson(page);
    await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
    // Two letters at a time (from the start of the sentence), each after the bridge has re-anchored the last change:
    // every step is ≥ 0.96 similar to the step before, the end ~0.4 similar to the quote.
    const trail = [];
    for (let i = 0; i < 40; i += 2) {
      const n = (await anchoredMsgs(page)).length;
      await frame.evaluate((i) => { const p = document.getElementById('s'); const t = p.textContent; p.textContent = `${t.slice(0, i)}жж${t.slice(i + 2)}`; }, i);
      await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 15000 }).toBeGreaterThan(n);
      trail.push((await lastAnchored(page)).results[0].state);
    }
    await page.waitForTimeout(500);
    const painted = ((await highlights(page))['lrn-yellow'] || [])[0] ?? null;
    const sim = painted ? similarity(painted, q) : null;
    test.info().annotations.push({ type: 'T013F-B3', description: `states ${[...new Set(trail)].join(', ')} (${trail.length} steps); painted "${painted}" (similarity to the quote ${sim?.toFixed(3)})` });
    // Either an orphan, or a place at least 0.7 similar to what the user marked.
    if (painted !== null) expect(sim).toBeGreaterThanOrEqual(0.7);
  });

  test('T013F-B4 (T013F-D4) an orphan whose text comes back by a DELETION (the lesson removes the words that were in between) is not searched again: it stays an orphan while its quote is on the screen', async ({ page }) => {
    test.fail(true, 'T013F-D4: after a pure deletion (nothing inserted) the bridge skips the orphans (`to <= from && delta <= 0`), but a deletion can join two pieces into the quote');
    const v1 = '<p>Първият абзац остава същият във всички версии на урока.</p><p>Този абзац ще изчезне и после скриптът ще го върне обратно.</p>';
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), ['Първият абзац остава същият', 'Този абзац ще изчезне и после скриптът ще го върне']);
    await importCourse(page, `<p>Първият абзац остава същият във всички версии на урока.</p><p>Този абзац ще <span id="x">(тук има дълъг вмъкнат текст, който разделя цитата на две части и после се маха) </span>изчезне и после скриптът ще го върне обратно.</p>
      <script>setTimeout(() => document.getElementById('x').remove(), 2500);</script>`);
    await openLesson(page);
    await expect.poll(() => states(page), { timeout: 8000 }).toEqual(['ok', 'orphan']);
    await expect.poll(async () => (await lastAnchored(page))?.results?.map((x) => x.state), { timeout: 10000 }).toEqual(['ok', 'ok']);
  });

  test('T013F-B5 (T014-D2) an annotation of 0.12.0 after a <br> (old position) and across one (glued quote): ok / provери, nothing deleted, the selector never rewritten; a new selection across a <br> has the space', async ({ page }) => {
    const v1 = '<p>Нещо преди това. Това е първи ред<br>втори ред на стихотворението, което продължава още малко.<br>Трети ред, маркиран след два пренасяния.</p><p>Друг абзац.</p>';
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), ['първи редвтори ред на стихотворението', 'Трети ред, маркиран след два пренасяния'], { model: 'old' });
    const frame = await openLesson(page);
    await expect.poll(() => states(page), { timeout: 10000 }).toEqual(['fuzzy', 'ok']);
    const s = await stored(page);
    expect(s.map((a) => [a.exact, a.deleted])).toEqual([['първи редвтори ред на стихотворението', false], ['Трети ред, маркиран след два пренасяния', false]]);
    expect(s[1].last.start - s[1].position.start).toBe(2);
    // A new selection across the <br>.
    await page.evaluate(() => { window.__sel = null; window.addEventListener('message', (e) => { if (e.data?.type === 'lrn:selection' && !e.data.empty) window.__sel = e.data; }); });
    await frame.evaluate(() => {
      const p = document.querySelector('main p');
      const r = document.createRange();
      r.setStart(p.childNodes[0], p.childNodes[0].data.lastIndexOf('ред'));
      r.setEnd(p.childNodes[2], 5);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await expect.poll(() => page.evaluate(() => window.__sel?.quote?.exact), { timeout: 5000 }).toBe('ред втори');
  });

  const B6_PARA = (i) => `<p>Абзац ${i}. Производителят оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${i}, и документира резултата.</p>`;
  const B6_BASE = `<p id="t">Брояч 0</p><p id="mv">Маркираният абзац, който урокът мести.</p>${Array.from({ length: 2000 }, (_, i) => B6_PARA(i)).join('\n')}`;
  const B6_KINDS = {
    clock: 'setInterval(() => { t.textContent = "Брояч " + (++n); }, 1000);',
    raf: 'const f = () => { t.textContent = "Брояч " + (++n); requestAnimationFrame(f); }; requestAnimationFrame(f);',
    bomb: 'new MutationObserver(() => { setTimeout(() => { t.textContent = "Брояч " + (++n); }, 0); }).observe(document.body, { childList: true, subtree: true, characterData: true }); t.textContent = "Брояч start";',
  };
  async function b6Setup(page) {
    await importCourse(page, B6_BASE);
    await annotate(page, lessonHtml(B6_BASE), [...Array.from({ length: 100 }, (_, k) => `Абзац ${k * 20}. Производителят оценява рисковете за киберсигурността`), 'Маркираният абзац, който урокът мести.']);
    await addOrphans(page, 100);
  }
  const setDeleted = (page, deleted) => page.evaluate(async ({ id, deleted }) => { const db = await import('./src/db.js'); for (const a of await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true })) await db.update(db.STORES.annotations, a.id, { deleted }); }, { id: L1, deleted });

  /** Busy % of 10 s at CPU ×4 (CDP TaskDuration of the renderer) without and with the 201 marks, for the given kinds of lesson. */
  async function b6Busy(page, kinds) {
    await b6Setup(page);
    const out = {};
    for (const [kind, code] of Object.entries(kinds)) {
      for (const withMarks of [false, true]) {
        await importCourse(page, `${B6_BASE}<script>const t = document.getElementById('t'); let n = 0; ${code}</script>`);
        await setDeleted(page, !withMarks);
        await page.evaluate(() => { window.__lrn = []; });
        await openLesson(page);
        if (withMarks) await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 60000 }).toBeGreaterThan(0);
        const cdp = await throttle(page, 4);
        await page.waitForTimeout(2000); // the first re-anchoring after the change (it may be later: T013F-B6b)
        await cdp.send('Performance.enable');
        const a0 = await taskSeconds(cdp);
        const n0 = (await anchoredMsgs(page)).length;
        const w0 = Date.now();
        await page.waitForTimeout(10000);
        const busy = (await taskSeconds(cdp)) - a0;
        const wall = (Date.now() - w0) / 1000;
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await cdp.detach();
        out[`${kind}${withMarks ? '+marks' : ''}`] = { busy: Math.round((busy / wall) * 100), runs: (await anchoredMsgs(page)).length - n0 };
      }
    }
    test.info().annotations.push({ type: 'T013F-B6 CPU ×4, 10 s: busy % without / with 201 marks, lrn:anchored count', description: JSON.stringify(out) });
    return out;
  }

  test('T013F-B6 (T014-D4) a clock, a counter animated every frame and a MutationObserver bomb, 100 ok + 1 + 100 unattached marks, CPU ×4: once anchored, re-anchored at most every ~2 s and no runaway of processor time (measured: busy % of 10 s without / with the marks)', async ({ page }, ti) => {
    landscapeOnly(ti);
    test.setTimeout(600000);
    const out = await b6Busy(page, B6_KINDS);
    for (const kind of Object.keys(B6_KINDS)) {
      // A timing measure (other workers share the processor): only a runaway fails here; the numbers are in the log (T013F-D7).
      expect.soft(out[`${kind}+marks`].busy - out[kind].busy, `${kind}: extra processor %`).toBeLessThan(50);
      expect.soft(out[`${kind}+marks`].runs, `${kind}: re-anchorings in 10 s`).toBeLessThanOrEqual(kind === 'clock' ? 11 : 6);
    }
  });

  test('T013F-B6b (T013F-D6) the same lessons at CPU ×4 from the start: after the lesson moves a marked paragraph, the mark is re-anchored at its new place within ≤ 3 s, and a ticking lesson is re-anchored at least every 3 s', async ({ page }, ti) => {
    landscapeOnly(ti);
    test.setTimeout(600000);
    test.fail(true, 'T013F-D6: the next re-anchoring waits 20 × the cost of the last one (scheduleReanchor), not at most 2 s: after opening a 0.26 MB lesson with 100 unattached marks at CPU ×4 the first re-anchoring comes 7–50 s later; meanwhile a mark whose text the lesson replaced or moved is not painted');
    await b6Setup(page);
    const out = {};
    for (const [kind, code] of Object.entries(B6_KINDS)) {
      await importCourse(page, `${B6_BASE}<script>const t = document.getElementById('t'); let n = 0; ${code}</script>`);
      await page.goto(`./#/c/${C}`);
      await expect(page.locator('[data-screen="course"]')).toBeVisible({ timeout: 20000 });
      await page.evaluate(() => { window.__lrn = []; });
      const cdp = await throttle(page, 4);
      await page.evaluate((c) => { location.hash = `#/c/${c}/read/0001`; }, C);
      await waitReady(page);
      const frame = await lessonFrame(page);
      await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 120000 }).toBeGreaterThan(0);
      await page.waitForTimeout(3000);
      const movedAt = await frame.evaluate(() => { const p = document.getElementById('mv'); p.parentNode.appendChild(p); return Date.now(); });
      await page.waitForTimeout(15000);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.detach();
      const msgs = await anchoredMsgs(page);
      const followed = msgs.find((m) => m.d > movedAt && m.results[100]?.state === 'ok' && m.results[100].position.start > m.results[99].position.start);
      const gaps = msgs.slice(1).map((m, i) => m.d - msgs[i].d);
      out[kind] = { follow: followed ? followed.d - movedAt : null, runs: msgs.length, maxGap: gaps.length ? Math.max(...gaps) : null, sinceLast: Date.now() - msgs.at(-1).d };
    }
    test.info().annotations.push({ type: 'T013F-B6b CPU ×4: ms from the move to the report at the new place; lrn:anchored count; the longest gap', description: JSON.stringify(out) });
    for (const kind of Object.keys(B6_KINDS)) {
      expect.soft(out[kind].follow ?? Infinity, `${kind}: followed within 3 s`).toBeLessThan(3000);
      expect.soft(Math.max(out[kind].maxGap ?? 0, out[kind].sinceLast), `${kind}: re-anchored at least every 3 s`).toBeLessThan(3000);
    }
  });

  test('T013F-B7 a lesson that changes its DOM every 10 ms while 500 fuzzy marks are anchored at CPU ×4: the anchoring still finishes (each new run keeps what the last one found), the app keeps answering', async ({ page }, ti) => {
    landscapeOnly(ti);
    test.setTimeout(400000);
    const para = (i, w = '') => `<p>Абзац ${i}. Производителят${w} оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${i}, и документира резултата в техническата документация.</p>`;
    const body = (w) => Array.from({ length: 3000 }, (_, i) => para(i, i % 6 === 0 ? w : '')).join('\n');
    await importCourse(page, body(''));
    await annotate(page, lessonHtml(body('')), Array.from({ length: 500 }, (_, k) => `Абзац ${k * 6}. Производителят оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${k * 6},`));
    await importCourse(page, `<p id="t">0</p>${body(' внимателно')}<script>let n = 0; setInterval(() => { document.getElementById('t').textContent = String(++n); }, 10);</script>`);
    await page.goto(`./#/c/${C}`);
    await page.evaluate(() => { window.__lrn = []; });
    const cdp = await throttle(page, 4);
    const stop = await watchMainThread(page);
    await page.evaluate((c) => { location.hash = `#/c/${c}/read/0001`; }, C);
    await waitReady(page);
    await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 120000, intervals: [500] }).toBeGreaterThan(0);
    const w = await stop();
    const r = await page.evaluate(() => {
      const ready = window.__lrn.find((m) => m.type === 'lrn:ready');
      const a = window.__lrn.find((m) => m.type === 'lrn:anchored');
      const st = {}; for (const x of a.results) st[x.state] = (st[x.state] || 0) + 1;
      return { ms: Math.round(a.t - ready.t), states: st };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    test.info().annotations.push({ type: 'T013F-B7 CPU ×4', description: JSON.stringify({ ...r, ...w }) });
    expect(r.states).toEqual({ fuzzy: 500 });
    // Alone: ≈ 200 ms; the limit allows for the other worker of the suite (timing).
    expect(w.inputMax).toBeLessThan(1000);
  });

  test('T013F-B8 the lesson cannot steer re-anchoring with its own messages: lrn:annotations / lrn:describe posted to itself or with fake hints are ignored; a forged lrn:anchored "ok" is a state only until the next opening', async ({ page }) => {
    const v1 = '<p id="a">Производителят оценява рисковете за киберсигурността.</p><p id="b">Вносителят оценява рисковете за вноса.</p>';
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), ['оценява рисковете за киберсигурността']);
    await importCourse(page, `${v1}<script>
      window.__counter = 0;
      // Self-posted bridge messages (origin "null"): the bridge must ignore them.
      const fake = { lrn: 1, type: 'lrn:annotations', items: [{ id: 'x1', color: 'pink', selector: { quote: { exact: 'Вносителят', prefix: '', suffix: '' }, hint: { blockPath: '#b' } } }] };
      setTimeout(() => { for (let i = 0; i < 50; i++) { postMessage(fake, '*'); postMessage({ lrn: 1, type: 'lrn:describe', annotationId: 'x1' }, '*'); } }, 500);
      addEventListener('message', (e) => { if (e.data?.type === 'lrn:annotations' && e.origin !== 'null') window.__counter++; });
      // A forged report: the real annotation "ok" at the decoy.
      addEventListener('message', (e) => { const m = e.data; if (m?.type === 'lrn:annotations' && m.items?.length && e.origin !== 'null') setTimeout(() => parent.postMessage({ lrn: 1, type: 'lrn:anchored', results: m.items.map((it) => ({ id: it.id, state: 'ok', position: { start: 60, end: 70 } })), textLength: 200 }, '*'), 1500); });
    </script>`);
    await openLesson(page);
    await page.waitForTimeout(3500);
    const h = await highlights(page);
    expect(h['lrn-pink']).toBeUndefined();
    expect(h['lrn-yellow']).toEqual(['оценява рисковете за киберсигурността']);
    // The lie was stored as a state (known: T014-S1); the user's selector is untouched.
    const s = await stored(page);
    expect(s[0].exact).toBe('оценява рисковете за киберсигурността');
    // The honest version again: the bridge checks the text at the remembered place and finds the real one.
    await importCourse(page, v1);
    await page.evaluate(() => { window.__lrn = []; });
    await openLesson(page);
    await expect.poll(async () => (await lastAnchored(page))?.results?.map((x) => x.state), { timeout: 10000 }).toEqual(['ok']);
    await expect.poll(() => highlights(page)).toEqual({ 'lrn-yellow': ['оценява рисковете за киберсигурността'] });
  });
});

// ===========================================================================
// T013F-P: speed at CPU ×4
// ===========================================================================
test.describe('T013F-P speed at CPU ×4', () => {
  test.describe.configure({ mode: 'default' }); // timing: one after another in one worker, never two of these at once
  test.beforeEach(async ({ page }, ti) => { landscapeOnly(ti); await start(page); });

  /** Opens the lesson from the course screen at CPU ×4, watching the app; → { ms (ready → anchored), states, raf, timer, inputMax, model } */
  async function measure(page, { timeout = 180000 } = {}) {
    await page.goto(`./#/c/${C}`);
    await expect(page.locator('[data-screen="course"]')).toBeVisible({ timeout: 20000 });
    await page.evaluate(() => { window.__lrn = []; });
    const cdp = await throttle(page, 4);
    await page.evaluate((c) => { location.hash = `#/c/${c}/read/0001`; }, C);
    await waitReady(page);
    // From lrn:ready on: the lesson's own parsing and layout are not the anchoring.
    const stop = await watchMainThread(page);
    await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout, intervals: [500] }).toBeGreaterThan(0);
    const w = await stop();
    const r = await page.evaluate(() => {
      const ready = window.__lrn.find((m) => m.type === 'lrn:ready');
      const a = window.__lrn.find((m) => m.type === 'lrn:anchored');
      const st = {}; for (const x of a.results) st[x.state] = (st[x.state] || 0) + 1;
      return { ms: Math.round(a.t - ready.t), states: st, results: a.results.map((x) => [x.state, x.position?.start ?? null]) };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    return { ...r, ...w };
  }
  const para = (i, w = '') => `<p>Абзац ${i}. Производителят${w} оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${i}, и документира резултата в техническата документация.</p>`;
  const body = (n, w = '', every = 1) => Array.from({ length: n }, (_, i) => para(i, i % every === 0 ? w : '')).join('\n');
  const note = (name, r) => test.info().annotations.push({ type: name, description: JSON.stringify({ ms: r.ms, states: r.states, raf: r.raf, timer: r.timer, inputMax: r.inputMax, inputs: r.inputs }) });

  test('T013F-P1 500 annotations (300 ok, 100 fuzzy, 100 orphans) on a 0.5 MB lesson: the right states and places, ≈ 2 s, the app answers input', async ({ page }) => {
    test.setTimeout(400000);
    const v1 = body(3000);
    await importCourse(page, v1);
    const needles = [...Array.from({ length: 300 }, (_, k) => `Абзац ${k * 10 + 1}. Производителят оценява рисковете`), ...Array.from({ length: 100 }, (_, k) => `Абзац ${k * 10 + 5}. Производителят оценява рисковете за киберсигурността на продукта`)];
    await annotate(page, lessonHtml(v1), needles);
    await addOrphans(page, 100);
    // v2: a word inside paragraphs …5 (fuzzy).
    const v2 = Array.from({ length: 3000 }, (_, i) => (i % 10 === 5 ? para(i, ' внимателно') : para(i))).join('\n');
    await importCourse(page, v2);
    const r = await measure(page);
    note('T013F-P1 500 marks', r);
    expect(r.states).toEqual({ ok: 300, fuzzy: 100, orphan: 100 });
    // The ok ones are at the right paragraph.
    const right = await page.evaluate(({ html, n }) => import('./src/anchor.js').then((A) => { const m = A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body); return Array.from({ length: n }, (_, k) => m.text.indexOf(`Абзац ${k * 10 + 1}. `)); }), { html: lessonHtml(v2), n: 300 });
    expect(r.results.slice(0, 300).map((x) => x[1])).toEqual(right);
    expect(r.ms).toBeLessThan(5000);
    expect(r.inputMax).toBeLessThan(300);
  });

  test('T013F-P2 a 5 MB lesson, 100 annotations after a small edit (fuzzy): the anchoring finishes, the app answers input — the text model is built in one piece (measured)', async ({ page }) => {
    test.setTimeout(600000);
    const v1 = body(30000);
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), Array.from({ length: 100 }, (_, k) => `Абзац ${k * 300}. Производителят оценява рисковете за киберсигурността на продукта`));
    await importCourse(page, body(30000, ' внимателно', 300));
    const r = await measure(page, { timeout: 300000 });
    note('T013F-P2 5 MB', r);
    expect(r.states).toEqual({ fuzzy: 100 });
    expect(r.ms).toBeLessThan(60000);
    // Information (a 5 MB lesson is ~50 × a real one): alone 12.8 s, stalls up to 0.65–0.8 s; only a freeze of seconds fails.
    expect(r.inputMax).toBeLessThan(4000);
  });

  test('T013F-P3 200 orphans (a lesson rewritten completely): ≈ 2 s, no freeze', async ({ page }) => {
    test.setTimeout(400000);
    const v1 = body(3000);
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), Array.from({ length: 200 }, (_, k) => `Абзац ${k * 15}. Производителят оценява рисковете за киберсигурността на продукта с цифрови елементи, номер ${k * 15}`));
    await importCourse(page, Array.from({ length: 3000 }, (_, i) => `<p>Съвсем друг текст ${i} без нищо общо с предишния, около същата дължина за сравнение и проверка на скоростта на търсенето.</p>`).join('\n'));
    const r = await measure(page);
    note('T013F-P3 200 orphans', r);
    expect(r.states).toEqual({ orphan: 200 });
    expect(r.ms).toBeLessThan(8000);
    expect(r.inputMax).toBeLessThan(1000); // alone: 60–110 ms
  });

  test('T013F-P4 pathological text: 300 000 × "а", the same paragraph 3000 times, words of 20 000 letters without spaces — 60 annotations after an edit: the right places, no long freeze', async ({ page }) => {
    test.setTimeout(400000);
    const same = '<p>Производителят оценява рисковете за киберсигурността на продукта и документира резултата.</p>';
    const word = (ch, n) => ch.repeat(n);
    const v1 = `<p id="a">${word('а', 300000)}</p>${same.repeat(1500)}<p id="m">Маркираният абзац е тук, между еднаквите.</p>${same.repeat(1500)}<p id="w">${'бв'.repeat(10000)} ${'гд'.repeat(10000)}</p>`;
    await importCourse(page, v1);
    await annotate(page, lessonHtml(v1), [
      ...Array.from({ length: 20 }, (_, k) => [word('а', 40 + k * 50), 0]),
      ...Array.from({ length: 20 }, (_, k) => ['Производителят оценява рисковете за киберсигурността на продукта', k * 150]),
      ['Маркираният абзац е тук, между еднаквите.', 0],
      ...Array.from({ length: 19 }, (_, k) => ['бв'.repeat(20 + k * 10), 0]),
    ]);
    // v2: one letter changed in the middle of the "а" run and in the long word; a word inserted in the marked paragraph; one copy of the same paragraph edited.
    const v2 = `<p id="a">${word('а', 150000)}б${word('а', 149999)}</p>${same.repeat(1500)}<p id="m">Маркираният абзац е точно тук, между еднаквите.</p>${same.repeat(749)}${same.replace('оценява', 'преценява')}${same.repeat(750)}<p id="w">${'бв'.repeat(5000)}x${'бв'.repeat(5000)} ${'гд'.repeat(10000)}</p>`;
    await importCourse(page, v2);
    const r = await measure(page);
    note('T013F-P4 pathological', r);
    const st = r.results.map((x) => x[0]);
    // "а"×n and "бв"×n are still there exactly (ok); the 20 sentences too (the same text everywhere: ok, the context picks one).
    expect(st.slice(0, 20).every((s) => s === 'ok')).toBe(true);
    expect(st.slice(20, 40).every((s) => s === 'ok')).toBe(true);
    // …and each of the 20 at its own copy (the k × 150-th paragraph of the 3000, counted with the edited one).
    const starts = await page.evaluate((html) => import('./src/anchor.js').then((A) => { const t = A.anchorTextModel(new DOMParser().parseFromString(html, 'text/html').body).text; return [...t.matchAll(/Производителят (о|пре)ценява рисковете за киберсигурността/g)].map((m) => m.index); }), lessonHtml(v2));
    expect(starts.length).toBe(3000);
    expect(r.results.slice(20, 40).map((x) => x[1])).toEqual(Array.from({ length: 20 }, (_, k) => starts[k * 150]));
    expect(st[40]).toBe('fuzzy');
    expect(st.slice(41).every((s) => s !== 'orphan')).toBe(true);
    expect(r.ms).toBeLessThan(12000); // alone: 2–3 s
    // A 300 000-letter word is laid out in one piece (the lesson's own cost, forced by the first box of a mark): alone 0.4–0.5 s.
    expect(r.inputMax).toBeLessThan(2000);
  });
  test('T013F-P5 information: how many times the text model is built while a lesson opens (a 5 MB lesson at CPU ×4: each build stops the app)', async ({ page }) => {
    test.setTimeout(400000);
    const v1 = body(30000);
    // The lesson counts the tree walks over <body> (anchorTextModel) from its <head>, before the bridge runs.
    const spyHead = '<script>window.__walks = []; const cw = Document.prototype.createTreeWalker; Document.prototype.createTreeWalker = function (root, ...rest) { if (root === document.body) window.__walks.push(performance.now()); return cw.call(this, root, ...rest); };</script>';
    const bytes = Object.fromEntries(Object.entries({ ...courseFiles(v1), 'lessons/0001-parvi.html': lessonHtml(v1, spyHead) }).map(([p, v]) => [p, strToU8(v)]));
    const f = asFile(`${C}.zip`, makeZip(bytes, { root: C }));
    await page.evaluate(async ({ name, data }) => { const m = await import('./src/course-import.js'); await m.importCourse([new File([new Uint8Array(data)], name)]); }, { name: f.name, data: [...f.buffer] });
    await annotate(page, lessonHtml(v1), ['Абзац 5. Производителят']);
    await page.goto(`./#/c/${C}`);
    await page.evaluate(() => { window.__lrn = []; });
    const cdp = await throttle(page, 4);
    const stop = await watchMainThread(page);
    await page.evaluate((c) => { location.hash = `#/c/${c}/read/0001`; }, C);
    await waitReady(page);
    await expect.poll(async () => (await anchoredMsgs(page)).length, { timeout: 120000 }).toBeGreaterThan(0);
    const w = await stop();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const walks = (await (await lessonFrame(page)).evaluate(() => window.__walks.length));
    test.info().annotations.push({ type: 'T013F-P5 5 MB, CPU ×4, from the navigation (the lesson\'s own parsing and layout included)', description: JSON.stringify({ modelBuilds: walks, ...w }) });
    expect(walks).toBeGreaterThanOrEqual(1);
  });
});
