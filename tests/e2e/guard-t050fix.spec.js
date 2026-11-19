// T-050-fix (developer): T050-I1 and T050-D1.
// - The guard calls nothing through prototypes the lesson can replace: with
//   String/Array/RegExp/Function prototypes broken, every runtime way to a frame
//   (createElement, innerHTML, a closed shadow root) still ends without one.
// - Frames out of the observer's sight: a frame put into a shadow root from an
//   isolated world (CDP; the lesson itself cannot do this) stands for "a frame
//   the guard missed". An open root is found by the guard's sweep; a closed one
//   the guard never saw is found by the app, because its document talks to the
//   app from a window nested in the lesson. window.length counts neither.
// - The bridge is put where the renderer's marker is, the last child of <body>.
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  page.on('pageerror', (e) => { if (!/origin "null"/.test(String(e))) problems.push(`pageerror: ${e}`); });
  await context.route(/^https?:\/\/(?!localhost)/, (route) => { problems.push(`external: ${route.request().url()}`); return route.abort(); });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => { expect(problems).toEqual([]); });

const doc = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body><h1>Урок</h1><p>Текст на урока.</p>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
const NESTED = `<scr` + `ipt>setInterval(function(){try{top.postMessage({nested:'x',rtc:typeof RTCPeerConnection},'*')}catch(e){}},300)</scr` + `ipt>`;
const js = (s) => JSON.stringify(s).replace(/<\//g, '<\\/');

async function open(page, id) {
  await page.evaluate(() => {
    window.__hits = [];
    addEventListener('message', (e) => { if (e.data && e.data.nested) window.__hits.push(e.data.rtc); });
  });
  await page.goto(`./#/c/${id}`);
  await page.goto(`./#/c/${id}/read/0001`);
  const wrap = page.locator('.lesson-frame__wrap').first();
  await expect(wrap).toHaveAttribute('data-lesson-state', /ready|fallback/, { timeout: 20000 });
  return wrap;
}
const lessonFrame = (page, id) => page.frames().find((x) => x.url().includes(`/EasyLRN/c/${id}/`));

test.describe('T050-I1: no prototype the lesson can replace changes the guard', () => {
  const BREAK = `String.prototype.toLowerCase=function(){return 'x'};String.prototype.toUpperCase=function(){return 'x'};`
    + `Array.prototype.push=function(){return 0};Object.defineProperty(Array.prototype,'0',{set:function(){},configurable:true});`
    + `RegExp.prototype.exec=function(){return null};RegExp.prototype.test=function(){return false};`
    + `Function.prototype.call=function(){};Function.prototype.apply=function(){};`;
  const WAYS = {
    'createElement("IFRAME") into the body': `const i=document.createElement('IFRAME');i.srcdoc=R;document.body.append(i);`,
    'innerHTML in a closed shadow root': `const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});s.innerHTML='<iframe srcdoc="'+A+'"></iframe>';`,
    'createElement in a closed shadow root, later': `setTimeout(function(){const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});const i=document.createElement('iframe');i.srcdoc=R;s.append(i);},500);`,
    'DOMParser frame moved into an open shadow root': `const d=new DOMParser().parseFromString('<iframe srcdoc="'+A+'"></iframe>','text/html');const h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'open'}).append(d.body.firstChild);`,
    'Object.prototype.characterDataOldValue set, then a closed shadow root': `Object.prototype.characterDataOldValue=true;Object.prototype.attributeFilter=1;setTimeout(function(){const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});s.innerHTML='<iframe srcdoc="'+A+'"></iframe>';},300);`,
    'embed/object via createElementNS (XHTML)': `const e=document.createElementNS('http://www.w3.org/1999/xhtml','object');e.data='data:text/html,'+encodeURIComponent(R);document.body.append(e);`,
  };
  Object.entries(WAYS).forEach(([name, code], n) => {
    test(`broken prototypes + ${name}: nothing nested runs`, async ({ page }) => {
      const id = `LRN-PI${n}`;
      const attr = NESTED.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const script = `<script>try{const R=${js(NESTED)};const A=${js(attr)};${BREAK}${code}}catch(e){window.__err=String(e)}</script>`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': doc(script) });
      const wrap = await open(page, id);
      await page.waitForTimeout(2500);
      const hits = await page.evaluate(() => window.__hits);
      const stopped = await wrap.getAttribute('data-lesson-stopped');
      console.log(`T-050-fix I1 "${name}": hits=${hits.length}, stopped=${stopped}`);
      expect(hits).toEqual([]);
    });
  });
});

test.describe('T050-I1: a frame out of the observer\'s sight is still caught', () => {
  for (const mode of ['open', 'closed']) {
    test(`a frame put into a ${mode} shadow root behind the guard's back: the lesson is stopped`, async ({ page }) => {
      const id = `LRN-IW${mode === 'open' ? 1 : 2}`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': doc('') });
      const wrap = await open(page, id);
      await expect(wrap).toHaveAttribute('data-lesson-state', 'ready');
      const f = lessonFrame(page, id);
      expect(f).toBeTruthy();
      // An isolated world of the lesson frame: native attachShadow, unseen by the guard.
      // In-process frame: the page's session; out-of-process: the frame's own.
      const cdp = await page.context().newCDPSession(f).catch(() => page.context().newCDPSession(page));
      const tree = await cdp.send('Page.getFrameTree').catch(() => null);
      const findId = (node) => (node.frame.url.includes(`/c/${id}/`) ? node.frame.id : (node.childFrames || []).map(findId).find(Boolean));
      const frameId = tree ? findId(tree.frameTree) : null;
      expect(frameId).toBeTruthy();
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 't050fix' });
      const t0 = Date.now();
      await cdp.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: `(()=>{const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:${js(mode)}});`
          + `const t=document.createElement('template');t.innerHTML=${js(`<iframe srcdoc="${NESTED.replace(/"/g, '&quot;')}"></iframe>`)};s.append(t.content);return window.length})()`,
      });
      await expect(wrap).toHaveAttribute('data-lesson-stopped', 'frame', { timeout: 5000 });
      console.log(`T-050-fix I1 isolated world, ${mode} root: stopped after ${Date.now() - t0} ms`);
      await expect(page.locator('.lesson-frame__wrap iframe')).toHaveCount(0);
    });
  }
});

test.describe('T050-D1: the bridge goes where the renderer put its marker', () => {
  const CASES = {
    'a comment with "</body" after </html>': '<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p></body></html>\n<!-- край на </body> -->\n',
    'a comment with "</body" after </body>': '<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p></body><!-- </body></html> --></html>',
    '"</body" in a script string and the marker text in a comment of the lesson': '<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p><!--easylrn:bridge--><script>var s="</bo"+"dy><!--easylrn:bridge-->";</script></body></html>',
    'no </body> and no </html>': '<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.',
  };
  Object.entries(CASES).forEach(([name, html], n) => {
    test(`${name}: the lesson gets ready, the bridge is the last element of <body>`, async ({ page }) => {
      const id = `LRN-BM${n}`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': strToU8(html) });
      const wrap = await open(page, id);
      await expect(wrap).toHaveAttribute('data-lesson-state', 'ready');
      const served = await page.evaluate(async (u) => (await fetch(u)).text(), `./c/${id}/lessons/0001-g.html`);
      const parsed = await page.evaluate((t) => {
        const d = new DOMParser().parseFromString(t, 'text/html');
        const last = d.body.lastElementChild;
        const w = d.createTreeWalker(d, 128);
        let markers = 0;
        for (let c = w.nextNode(); c; c = w.nextNode()) if (c.data === 'easylrn:bridge') markers++;
        return { last: last && last.getAttribute('data-easylrn'), bridges: d.querySelectorAll('script[data-easylrn="bridge"]').length, guardFirst: d.head.firstElementChild?.getAttribute('data-easylrn'), markers };
      }, served);
      expect(parsed).toEqual({ last: 'bridge', bridges: 1, guardFirst: 'guard', markers: 0 });
      expect(/<\/script>\s*<\/body><\/html>$/.test(served)).toBe(true);
    });
  });
});
