// T-048 (tester): retest of T-045-fix (T046-S1, D-034). Independent of the
// developer's tests. A lesson may not contain or create a WORKING nested frame
// by any path, and RTC* must stay unreachable. We do NOT build a leak payload:
// a nested document only reports, with postMessage to the lesson, that its
// script ran and whether it sees RTCPeerConnection.
//
// Each probe inserts a frame whose document (srcdoc) runs
//   parent.postMessage({ nested: '<path>', rtc: typeof RTCPeerConnection }, '*')
// The lesson collects these reports in window.__hits. A hit = a working nested
// frame = a way around D-034 (and with rtc === 'function', around T046-S1).
//
// Known defects carry test.fail() and the id from the T-048 log.
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/frame|Refused|Content Security|Blocked|sandbox|ERR_|status of 40/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await context.route(/^https?:\/\/(?!localhost)/, (route) => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});

const doc = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body><h1>Урок</h1>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
async function openLesson(page, course) {
  await page.goto(`./#/c/${course}`);
  await page.goto(`./#/c/${course}/read/0001`);
  await expect(page.locator('[data-lesson-state="ready"], [data-lesson-state="fallback"]')).toBeVisible({ timeout: 20000 });
  return page.frames().find((f) => f.url().includes(`/EasyLRN/c/${course}/`));
}

// The report a nested document sends (the only thing it does).
// It reports to the lesson (parent) and to the app window (top), so a hit is seen even if the app reloads the lesson.
const REPORT = (name) => `<scr` + `ipt>var m={nested:${JSON.stringify(name)},rtc:typeof RTCPeerConnection};parent.postMessage(m,'*');top.postMessage(m,'*')</scr` + `ipt>`;
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Collector: runs first among the lesson's own scripts (after the guard).
const COLLECT = `<script>window.__hits=[];addEventListener('message',e=>{if(e.data&&e.data.nested)window.__hits.push(e.data.nested+':'+e.data.rtc)});</script>`;

async function hits(page, course) {
  const f = await openLesson(page, course);
  await page.waitForTimeout(2500);
  return f.evaluate(() => ({
    hits: window.__hits,
    rtc: typeof window.RTCPeerConnection,
    live: document.querySelectorAll('iframe,frame,object,embed,portal,frameset').length,
    errors: window.__errs || {},
  }));
}

test.describe('T-048 retest T046-S1 / D-034: no working nested frame', () => {
  test('runtime paths: createElement(NS), innerHTML, insertAdjacentHTML, outerHTML, DOMParser+adoptNode/importNode, template clone, document.write, createContextualFragment, setHTMLUnsafe, SVG foreignObject, object/embed', async ({ page }) => {
    const P = (n) => JSON.stringify(REPORT(n)).replace(/<\//g, '<\\/');
    const script = `<script>
      window.__errs = {};
      const T = (n, fn) => { try { fn(); } catch (e) { window.__errs[n] = e.name; } };
      const html = (n, body) => '<iframe srcdoc="' + body.replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '"></iframe>';
      const R = { ce: ${P('createElement')}, ns: ${P('createElementNS')}, ih: ${P('innerHTML')}, iah: ${P('insertAdjacentHTML')}, oh: ${P('outerHTML')},
        dpa: ${P('DOMParser+adoptNode')}, dpi: ${P('DOMParser+importNode')}, dpx: ${P('DOMParser+append')}, tpl: ${P('template.content clone')},
        dw: ${P('document.write')}, rng: ${P('createContextualFragment')}, shu: ${P('setHTMLUnsafe')}, fo: ${P('svg foreignObject')},
        obj: ${P('object data')}, emb: ${P('embed src')}, xml: ${P('XHTML createElementNS')} };
      T('createElement', () => { const i = document.createElement('IFRAME'); i.srcdoc = R.ce; document.body.append(i); });
      T('createElementNS', () => { const i = document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe'); i.srcdoc = R.ns; document.body.append(i); });
      T('innerHTML', () => { const d = document.createElement('div'); d.innerHTML = html('', R.ih); document.body.append(d); });
      T('insertAdjacentHTML', () => document.body.insertAdjacentHTML('beforeend', html('', R.iah)));
      T('outerHTML', () => { const d = document.createElement('div'); document.body.append(d); d.outerHTML = html('', R.oh); });
      T('DOMParser+adoptNode', () => { const x = new DOMParser().parseFromString(html('', R.dpa), 'text/html').querySelector('iframe'); document.body.append(document.adoptNode(x)); });
      T('DOMParser+importNode', () => { const x = new DOMParser().parseFromString(html('', R.dpi), 'text/html').querySelector('iframe'); document.body.append(document.importNode(x, true)); });
      T('DOMParser+append', () => { const x = new DOMParser().parseFromString('<div>' + html('', R.dpx) + '</div>', 'text/html').body.firstChild; document.body.append(x); });
      T('template', () => { const t = document.createElement('template'); t.innerHTML = html('', R.tpl); document.body.append(t.content.cloneNode(true)); });
      T('Range', () => document.body.append(document.createRange().createContextualFragment(html('', R.rng))));
      T('setHTMLUnsafe', () => { const d = document.createElement('div'); d.setHTMLUnsafe(html('', R.shu)); document.body.append(d); });
      T('foreignObject', () => { const d = document.createElement('div'); d.innerHTML = '<svg><foreignObject width="10" height="10">' + html('', R.fo) + '</foreignObject></svg>'; document.body.append(d); });
      T('object', () => { const d = document.createElement('div'); d.innerHTML = '<object type="text/html" data="data:text/html,' + encodeURIComponent(R.obj) + '"></object>'; document.body.append(d); });
      T('embed', () => { const d = document.createElement('div'); d.innerHTML = '<embed type="text/html" src="data:text/html,' + encodeURIComponent(R.emb) + '">'; document.body.append(d); });
    </script>`;
    await importCourse(page, 'LRN-G1', { 'INDEX.md': strToU8('# G1\n'), 'lessons/0001-g.html': doc(script, COLLECT) });
    const r = await hits(page, 'LRN-G1');
    console.log(`T-048 runtime paths: ${JSON.stringify(r)}`);
    expect(r.rtc).toBe('undefined');
    expect(r.hits).toEqual([]);
    expect(r.live).toBe(0);
  });

  test('document.write during parsing and after load (document.open): no working frame', async ({ page }) => {
    const js = (n) => JSON.stringify(`<iframe srcdoc="${attr(REPORT(n))}"></iframe>`).replace(/<\//g, '<\\/');
    await importCourse(page, 'LRN-G2', {
      'INDEX.md': strToU8('# G2\n'),
      'lessons/0001-g.html': doc(`<script>document.write(${js('document.write (parsing)')});</script>`
        + `<script>addEventListener('load',()=>setTimeout(()=>{const h=window.__hits;document.open();document.write('<!doctype html><body>'+${js('document.write after open')}+'</body>');document.close();window.__hits=h;},300));</script>`, COLLECT),
    });
    await page.evaluate(() => { window.__topHits = []; addEventListener('message', (e) => { if (e.data && e.data.nested) window.__topHits.push(e.data.nested); }); });
    await openLesson(page, 'LRN-G2');
    await page.waitForTimeout(3000);
    const topHits = await page.evaluate(() => window.__topHits);
    // After document.open() the app may reload the lesson: read the frame that is there once it is ready.
    let r = null;
    await expect.poll(async () => {
      const f = page.frames().find((x) => x.url().includes('/EasyLRN/c/LRN-G2/'));
      r = f ? await f.evaluate(() => ({ hits: window.__hits, live: document.querySelectorAll('iframe,object,embed').length, opened: !document.querySelector('h1') })).catch(() => null) : null;
      return !!r;
    }, { timeout: 15000 }).toBe(true);
    r.state = await page.locator('.lesson-frame__wrap').getAttribute('data-lesson-state');
    console.log(`T-048 document.write: ${JSON.stringify(r)} top: ${JSON.stringify(topHits)}`);
    expect(r.hits).toEqual([]);
    expect(topHits).toEqual([]);
  });

  test('static HTML at assembly: <iframe>, <IFRAME/srcdoc>, <frameset>, <object data>, <embed>, <portal> in the source are removed', async ({ page }) => {
    const s = (n) => attr(REPORT(n));
    await importCourse(page, 'LRN-G3', {
      'INDEX.md': strToU8('# G3\n'),
      'lessons/0001-g.html': doc(`<iframe srcdoc="${s('static iframe')}"></iframe><IFRAME/SRCDOC="${s('static IFRAME/')}"></IFRAME>`
        + `<iframe\nsrcdoc='${s('static newline')}'></iframe><object type="text/html" data="data:text/html,${encodeURIComponent(REPORT('static object'))}"></object>`
        + `<embed type="text/html" src="data:text/html,${encodeURIComponent(REPORT('static embed'))}"><portal src="about:blank"></portal>`
        + `<svg><foreignObject width="9" height="9"><iframe srcdoc="${s('static foreignObject')}"></iframe></foreignObject></svg>`, COLLECT),
    });
    const r = await hits(page, 'LRN-G3');
    console.log(`T-048 static: ${JSON.stringify(r)}`);
    expect(r.hits).toEqual([]);
    expect(r.live).toBe(0);
  });

  // ---- Defects found in T-048 (see the log) ---------------------------------

  test('[T048-S1a] the lesson overrides Element.prototype.remove before inserting: the guard cannot remove the frame, its script runs with RTCPeerConnection', async ({ page }) => {
    await importCourse(page, 'LRN-G4', {
      'INDEX.md': strToU8('# G4\n'),
      'lessons/0001-g.html': doc(`<script>Element.prototype.remove = function () {};
        const d = document.createElement('div'); d.innerHTML = '<iframe srcdoc="${attr(REPORT('remove() overridden')).replace(/'/g, "\\'")}"></iframe>'; document.body.append(d);</script>`, COLLECT),
    });
    const r = await hits(page, 'LRN-G4');
    console.log(`T-048 S1a: ${JSON.stringify(r)}`);
    expect(r.hits).toEqual([]);
  });

  test('[T048-S1b] the lesson replaces document.documentElement: the guard\'s MutationObserver no longer sees inserted frames', async ({ page }) => {
    await importCourse(page, 'LRN-G5', {
      'INDEX.md': strToU8('# G5\n'),
      'lessons/0001-g.html': doc(`<script>addEventListener('load', () => setTimeout(() => {
        const root = document.documentElement; const fresh = root.cloneNode(true); document.replaceChild(fresh, root);
        const d = document.createElement('div'); d.innerHTML = '<iframe srcdoc="${attr(REPORT('new documentElement')).replace(/'/g, "\\'")}"></iframe>'; document.body.append(d);
      }, 200));</script>`, COLLECT),
    });
    const r = await hits(page, 'LRN-G5');
    console.log(`T-048 S1b: ${JSON.stringify(r)}`);
    expect(r.hits).toEqual([]);
  });

  test('[T048-S1c] the assembler misses a frame inside <svg><title> (an HTML integration point it treats as raw text)', async ({ page }) => {
    // The guard may still catch it at runtime; this checks the assembly step
    // alone (D-034: "the renderer removes them"): the frame must not reach the served HTML.
    await importCourse(page, 'LRN-G6', {
      'INDEX.md': strToU8('# G6\n'),
      'lessons/0001-g.html': doc(`<svg><title><iframe srcdoc="${attr(REPORT('svg title'))}"></iframe></title></svg>`
        + `<!--><iframe srcdoc="${attr(REPORT('abrupt comment'))}"></iframe><!-- -->`),
    });
    const served = await page.evaluate(async () => (await (await fetch('./c/LRN-G6/lessons/0001-g.html')).text()));
    const tags = (served.match(/<iframe/gi) || []).length;
    console.log(`T-048 S1c: <iframe> tags in the served lesson: ${tags}`);
    expect(tags).toBe(0);
  });

  test('[T048-S1d] static frame missed by the assembler + Element.prototype.remove overridden earlier: a working nested frame from the source HTML', async ({ page }) => {
    await importCourse(page, 'LRN-G7', {
      'INDEX.md': strToU8('# G7\n'),
      'lessons/0001-g.html': doc(`<svg><title><iframe srcdoc="${attr(REPORT('static svg title + remove()'))}"></iframe></title></svg>`,
        `${COLLECT}<script>Element.prototype.remove = function () {};</script>`),
    });
    const r = await hits(page, 'LRN-G7');
    console.log(`T-048 S1d: ${JSON.stringify(r)}`);
    expect(r.hits).toEqual([]);
  });
});
