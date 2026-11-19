// T-050 (tester): retest of T048-S1a…d after T-048-fix, new variants against
// the guard and the renderer, and abuse of the hidden page parser.html.
// D-037 accepts the residual WebRTC risk: a working nested frame found here is
// reported in the log as information, not as a defect. What these tests DO
// require is that the existing nets keep working: the renderer serves no
// frame, the guard or the app stops a lesson with a nested frame, nothing runs
// in the app window, nothing is fetched from outside.
//
// A probe frame only reports (postMessage to the lesson and to the app) that
// its script ran and what `typeof RTCPeerConnection` is. No leak payload.
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/frame|Refused|Content Security|Blocked|sandbox|ERR_|status of 40/i.test(m.text())) problems.push(m.text()); });
  // Errors thrown INSIDE the sandboxed lesson (opaque origin "null") are the lesson's own business.
  page.on('pageerror', (e) => { if (!/origin "null"/.test(String(e))) problems.push(`pageerror: ${e}`); });
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
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
const REPORT = (name) => `<scr` + `ipt>var m={nested:${JSON.stringify(name)},rtc:typeof RTCPeerConnection,t:Date.now()};try{parent.postMessage(m,'*')}catch(e){};try{top.postMessage(m,'*')}catch(e){}</scr` + `ipt>`;
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const js = (s) => JSON.stringify(s).replace(/<\//g, '<\\/');
const COLLECT = `<script>window.__hits=[];addEventListener('message',e=>{if(e.data&&e.data.nested)window.__hits.push(e.data.nested+':'+e.data.rtc)});</script>`;

/** Open lesson 0001, collect reports in the app window too; returns what happened. */
async function probe(page, course, wait = 2500) {
  await page.evaluate(() => {
    window.__topHits = [];
    window.__t048pwn = undefined;
    addEventListener('message', (e) => { if (e.data && e.data.nested) window.__topHits.push(`${e.data.nested}:${e.data.rtc}`); });
  });
  await page.goto(`./#/c/${course}`);
  const t0 = Date.now();
  await page.goto(`./#/c/${course}/read/0001`);
  await expect(page.locator('[data-lesson-state], [data-lesson-stopped]').first()).toBeAttached({ timeout: 20000 });
  await page.waitForTimeout(wait);
  const wrap = page.locator('.lesson-frame__wrap').first();
  const stopped = await wrap.getAttribute('data-lesson-stopped').catch(() => null);
  const state = await wrap.getAttribute('data-lesson-state').catch(() => null);
  const f = page.frames().find((x) => x.url().includes(`/EasyLRN/c/${course}/`));
  const inner = f ? await f.evaluate(() => ({
    hits: window.__hits || null,
    rtc: typeof window.RTCPeerConnection,
    live: document.querySelectorAll('iframe,frame,object,embed,portal,frameset').length,
    frames: window.length,
  })).catch(() => null) : null;
  const top = await page.evaluate(() => ({ hits: window.__topHits, pwn: window.__t048pwn, appFrames: document.querySelectorAll('iframe').length }));
  return { stopped, state, inner, top, ms: Date.now() - t0 };
}

test.describe('T-050 new guard variants (information under D-037; the nets must hold)', () => {
  // Each variant first breaks a built-in the guard still uses through the
  // prototype (not saved in T-048-fix), then makes a frame.
  const VARIANTS = {
    'String.prototype.toLowerCase replaced, createElement("iframe")':
      `String.prototype.toLowerCase=function(){return 'x'};const i=document.createElement('iframe');i.srcdoc=R;document.body.append(i);`,
    'Array.prototype.push replaced, innerHTML in a div':
      `Array.prototype.push=function(){return 0};const d=document.createElement('div');d.innerHTML='<iframe srcdoc="'+A+'"></iframe>';document.body.append(d);`,
    'String() replaced (global), createElement("iframe")':
      `window.String=function(){return 'x'};const i=document.createElement('iframe');i.srcdoc=R;document.body.append(i);`,
    'T048-S1a again: Element.prototype.remove + removeChild replaced':
      `Element.prototype.remove=function(){};Node.prototype.removeChild=function(n){return n};const d=document.createElement('div');d.innerHTML='<iframe srcdoc="'+A+'"></iframe>';document.body.append(d);`,
    'T048-S1b again: new documentElement, then innerHTML':
      `addEventListener('load',()=>{document.replaceChild(document.documentElement.cloneNode(true),document.documentElement);const d=document.createElement('div');d.innerHTML='<iframe srcdoc="'+A+'"></iframe>';document.body.append(d);});`,
    'MutationObserver.prototype.observe replaced after the guard (no effect expected)':
      `MutationObserver.prototype.observe=function(){};const d=document.createElement('div');d.innerHTML='<iframe srcdoc="'+A+'"></iframe>';document.body.append(d);`,
  };
  for (const [name, code] of Object.entries(VARIANTS)) {
    test(`variant: ${name}`, async ({ page }) => {
      const id = `LRN-V${Object.keys(VARIANTS).indexOf(name)}`; // shadow-root variants: see [T050-I1] below
      const R = REPORT(name);
      const script = `<script>try{const R=${js(R)};const A=${js(attr(R))};${code}}catch(e){window.__err=String(e)}</script>`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': doc(script, COLLECT) });
      const r = await probe(page, id);
      console.log(`T-050 guard variant "${name}": ${JSON.stringify(r)}`);
      // Never anything in the app window.
      expect(r.top.pwn).toBeUndefined();
      // The net: either no nested document ever ran, or the app stopped the lesson.
      const ran = r.top.hits.length > 0 || (r.inner?.hits?.length ?? 0) > 0;
      if (ran) expect(r.stopped, 'a nested frame ran: the app must stop the lesson').toBe('frame');
      // The lesson itself never has WebRTC.
      if (r.inner) expect(r.inner.rtc).toBe('undefined');
      // Whatever happened, no live frame is left.
      expect(r.inner ? r.inner.frames : 0).toBe(0);
    });
  }
});

test.describe('T-050 renderer (T048-S1c): new static variants are removed by the parser', () => {
  const s = (n) => attr(REPORT(n));
  const CASES = {
    'nested-form mXSS (math/mtext/mglyph/style)': (n) => `<form><math><mtext></form><form><mglyph><style></math><iframe srcdoc="${s(n)}"></iframe>`,
    'svg </p> style breakout': (n) => `<svg></p><style><a id="</style><iframe srcdoc='${s(n)}'></iframe>">`,
    'math table mglyph comment': (n) => `<math><mtext><table><mglyph><style><!--</style><iframe srcdoc="${s(n)}"></iframe>`,
    'noscript title breakout': (n) => `<noscript><p title="</noscript><iframe srcdoc='${s(n)}'></iframe>"></noscript>`,
    'declarative shadow root (open and closed)': (n) => `<div><template shadowrootmode="open"><iframe srcdoc="${s(n + ' open')}"></iframe></template></div><div><template shadowrootmode="closed"><iframe srcdoc="${s(n + ' closed')}"></iframe></template></div>`,
    'bogus comments <? > <!a> </x >': (n) => `<? ><iframe srcdoc="${s(n + ' ?')}"></iframe> ?><!a><iframe srcdoc="${s(n + ' !a')}"></iframe></x ><iframe srcdoc="${s(n + ' /x')}"></iframe>`,
    'comments <!--> <!---> <!--!>': (n) => `<!--><iframe srcdoc="${s(n + ' 1')}"></iframe>--><!---><iframe srcdoc="${s(n + ' 2')}"></iframe>--><!--!><iframe srcdoc="${s(n + ' 3')}"></iframe>-->`,
    'svg/math title, desc, annotation-xml': (n) => `<svg><title><iframe srcdoc="${s(n + ' t')}"></iframe></title><desc><iframe srcdoc="${s(n + ' d')}"></iframe></desc></svg><math><annotation-xml encoding="text/html"><iframe srcdoc="${s(n + ' a')}"></iframe></annotation-xml></math>`,
    'select/textarea/xmp/noembed/noframes, mixed case, frameset': (n) => `<select><template><iframe srcdoc="${s(n + ' sel')}"></iframe></template></select><textarea></textarea><iFrAmE SrCdOc="${s(n + ' case')}"></iFrAmE><xmp></xmp><noembed></noembed><noframes></noframes><frameset><frame src="about:blank"></frameset>`,
    'after </html> and in a trailing comment': (n) => `</body></html><iframe srcdoc="${s(n)}"></iframe><!-- </body -->`,
  };
  for (const [name, html] of Object.entries(CASES)) {
    test(`static: ${name}`, async ({ page }) => {
      const id = `LRN-S${Object.keys(CASES).indexOf(name)}`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': doc(html(name), COLLECT) });
      const served = await page.evaluate(async (id) => (await fetch(`./c/${id}/lessons/0001-g.html`)).text(), id);
      const r = await probe(page, id);
      // Text "<iframe" may stay inside a comment; what counts is an element after a real parse.
      const textTags = (served.match(/<(iframe|frame|object|embed|portal|frameset)\b/gi) || []).length;
      const elements = await page.evaluate((html) => {
        const count = (root) => root.querySelectorAll('iframe,frame,frameset,object,embed,portal').length
          + [...root.querySelectorAll('template')].reduce((n, t) => n + count(t.content), 0);
        const d = document.implementation.createHTMLDocument('');
        d.open(); d.write(html); d.close();
        return count(d);
      }, served);
      console.log(`T-050 static "${name}": frame tags as text ${textTags}, as elements ${elements}, ${JSON.stringify(r)}`);
      expect(elements).toBe(0);
      expect(r.top.hits).toEqual([]);
      expect(r.inner?.hits ?? []).toEqual([]);
      expect(r.top.pwn).toBeUndefined();
    });
  }
});

test.describe('T-050 parser.html (no CSP) cannot be abused', () => {
  test('opened directly: an empty static page, no scripts, no forms, nothing runs', async ({ page }) => {
    const res = await page.goto('./parser.html');
    expect(res.status()).toBe(200);
    const r = await page.evaluate(() => ({
      scripts: document.scripts.length, body: document.body.innerHTML.trim(), forms: document.forms.length,
      links: document.links.length, title: document.title, handlers: [...document.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))),
    }));
    console.log(`T-050 parser.html direct: ${JSON.stringify(r)}`);
    expect(r).toEqual({ scripts: 0, body: '', forms: 0, links: 0, title: 'EasyLRN', handlers: false });
    // The source has no script, no handler, no external reference.
    const src = await (await page.request.get('./parser.html')).text();
    expect(src).not.toMatch(/<script|\son\w+=|https?:|src=|href=/i);
  });

  test('assembling a lesson with scripts, handlers and external resources: nothing runs in the parser page or the app, nothing is fetched', async ({ page }) => {
    const pwn = `top.__t048pwn='parser';parent.__t048pwn='parser';window.__t048pwn='parser'`;
    const lesson = doc(
      `<img src="x" onerror="${pwn}"><img src="https://evil.example/beacon.gif"><svg onload="${pwn}"></svg><details open ontoggle="${pwn}"></details>`
      + `<video><source src="x" onerror="${pwn}"></video><input type="image" src="https://evil.example/i.png"><body onload="${pwn}">`
      + `<script>${pwn}</script><img srcset="https://evil.example/s.png 1x"><audio src="https://evil.example/a.mp3" autoplay></audio>`
      + `<style>@import url(https://evil.example/x.css); body{background:url(https://evil.example/bg.png)}</style>`
      + `<form action="https://evil.example/f"><input autofocus onfocus="${pwn}"></form>`,
      `<link rel="stylesheet" href="https://evil.example/s.css"><link rel="preload" as="image" href="https://evil.example/p.png"><link rel="icon" href="https://evil.example/i.ico">`
      + `<meta http-equiv="refresh" content="0;url=https://evil.example/r"><base href="https://evil.example/">`,
    );
    await page.evaluate(() => {
      // Watch the parser frame while the render runs.
      window.__parserSeen = [];
      new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) {
          if (n.nodeName === 'IFRAME' && n.dataset.easylrn === 'parser') {
            window.__parserSeen.push({ sandbox: n.getAttribute('sandbox'), src: n.getAttribute('src') });
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const line = await importCourse(page, 'LRN-P1', { 'INDEX.md': strToU8('# P1\n'), 'lessons/0001-g.html': lesson });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({ pwn: window.__t048pwn, seen: window.__parserSeen, left: document.querySelectorAll('iframe[data-easylrn="parser"]').length }));
    console.log(`T-050 parser render: ${line} ${JSON.stringify(after)}`);
    expect(after.pwn).toBeUndefined();
    expect(after.left).toBe(0); // the parser frame is gone after the render
    expect(after.seen.length).toBeGreaterThan(0); // and it was used
    // Open the lesson too (served in the sandbox; external resources blocked by its CSP).
    const r = await probe(page, 'LRN-P1');
    console.log(`T-050 parser lesson: ${JSON.stringify(r)}`);
    expect(r.top.pwn).toBeUndefined();
    // afterEach: no external request at all (render in parser.html + the lesson).
  });

  test('a lesson cannot use parser.html: navigating itself there stays sandboxed and the app reloads the lesson', async ({ page }) => {
    const script = `<script>addEventListener('load',()=>setTimeout(()=>{location.href='../../../parser.html'},200));</script>`;
    await importCourse(page, 'LRN-P2', { 'INDEX.md': strToU8('# P2\n'), 'lessons/0001-g.html': doc(script) });
    await page.goto('./#/c/LRN-P2');
    await page.goto('./#/c/LRN-P2/read/0001');
    await page.waitForTimeout(800);
    // If the navigation lands, the document is sandboxed (opaque origin, no access to the app).
    const parserFrames = page.frames().filter((f) => /parser\.html/.test(f.url()));
    const info = [];
    for (const f of parserFrames) info.push(await f.evaluate(() => ({ origin: window.origin, app: (() => { try { return !!parent.document; } catch { return 'blocked'; } })() })).catch((e) => String(e)));
    await page.waitForTimeout(3000);
    const state = await page.locator('.lesson-frame__wrap').first().getAttribute('data-lesson-state');
    const now = page.frames().map((f) => f.url()).filter((u) => /parser|\/c\/LRN-P2\//.test(u));
    console.log(`T-050 lesson → parser.html: while there ${JSON.stringify(info)}, after: state=${state}, frames=${JSON.stringify(now)}`);
    for (const i of info) if (typeof i === 'object') { expect(i.origin).toBe('null'); expect(i.app).toBe('blocked'); }
  });
});

test.describe('T-050 shadow-root frames (information under D-037)', () => {
  // A frame inside a shadow root is not in the document tree: window.length
  // (the guard's own check and the app's 250 ms check) does not count it. The
  // guard still catches it through the shadow-root observer — unless the
  // lesson breaks String.prototype.toLowerCase, which stripFrames/neuter call
  // through the prototype. Then the nested frame lives on, with WebRTC.
  // T050-I1: informative (D-037 accepts the residual risk); marked
  // test.fail() so the test flips once the guard compares localName without
  // prototype calls (localName of an HTML element is already lower case).
  for (const mode of ['open', 'closed']) {
    test(`[T050-I1] toLowerCase replaced, iframe in a ${mode} shadow root: the lesson is stopped or the frame never runs`, async ({ page }) => {
      test.fail(true, 'T050-I1 (D-037, informative): the frame stays alive and is not counted by window.length');
      const id = `LRN-SH${mode === 'open' ? 1 : 2}`;
      const R = `<scr` + `ipt>var n=0;setInterval(function(){var m={nested:'shadow-${mode}#'+(n++),rtc:typeof RTCPeerConnection};try{top.postMessage(m,'*')}catch(e){}},500)</scr` + `ipt>`;
      const script = `<script>String.prototype.toLowerCase=function(){return 'x'};const h=document.createElement('div');document.body.append(h);`
        + `const s=h.attachShadow({mode:'${mode}'});const i=document.createElement('iframe');i.srcdoc=${js(R)};s.append(i);</script>`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': doc(script) });
      const r = await probe(page, id, 5000);
      console.log(`T-050 [T050-I1] ${mode}: ${JSON.stringify({ stopped: r.stopped, state: r.state, frames: r.inner?.frames, hits: r.top.hits.length, first: r.top.hits[0], last: r.top.hits.at(-1) })}`);
      expect(r.top.pwn).toBeUndefined();
      const ran = r.top.hits.length > 0;
      expect(!ran || r.stopped === 'frame').toBe(true);
    });
  }
});

// T050-D1 (low): the SW puts the bridge before the LAST "</body" of the text,
// which can be inside a comment after </html>; the lesson then falls back
// (inner scroll, no highlighting). Not a regression (the same before 0.6.1).
test('[T050-D1] a trailing comment with "</body" after </html>: the bridge still works (the lesson gets ready)', async ({ page }) => {
  test.fail(true, 'T050-D1: the bridge lands inside the trailing comment');
  await importCourse(page, 'LRN-TC', { 'INDEX.md': strToU8('# TC\n'), 'lessons/0001-g.html': strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p></body></html>\n<!-- край на </body> -->\n') });
  const served = await page.evaluate(async () => (await fetch('./c/LRN-TC/lessons/0001-g.html')).text());
  await page.goto('./#/c/LRN-TC');
  await page.goto('./#/c/LRN-TC/read/0001');
  await page.waitForTimeout(15000);
  const state = await page.locator('.lesson-frame__wrap').first().getAttribute('data-lesson-state');
  const box = await page.locator('.lesson-frame__wrap iframe').first().boundingBox();
  const note = await page.locator('.lesson-frame__wrap').first().innerText();
  console.log(`T-050 trailing comment after 15 s: state=${state}, frame ${JSON.stringify(box)}, text: ${note.slice(0, 200)}`);
  await page.screenshot({ path: '/tmp/t050/trailing-comment.png' });
  const tail = served.slice(-300).replace(/\s+/g, ' ');
  console.log(`T-050 trailing comment: state=${state}; bridge inside the comment: ${/<!--[^]*data-easylrn="bridge"[^]*-->\s*$/.test(served)}; tail: ${tail.slice(-160)}`);
  expect(state).toBe('ready');
});
