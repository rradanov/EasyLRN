// T-051 (tester): retest of T-050-fix (0.6.2) — the lesson guard (T050-I1), the
// bridge marker (T050-D1), stale renders (RENDER_VERSION 3 → 4).
// - New ways to a nested browsing context (a fresh realm with its own
//   RTCPeerConnection): prototypes the guard might still use, custom elements,
//   template contents, DOMParser, nested shadow roots, late timers, many roots,
//   and the Sanitizer API (setHTML / Document.parseHTML), which builds
//   declarative shadow roots that the guard never sees (T051-I1).
//   D-037: WebRTC is an accepted residual risk, so a new way is "information".
// - Fake <!--easylrn:bridge--> markers in every place a lesson can put text.
// - A render stored by 0.6.1 (RENDER_VERSION 3) is redone before it is served.
// Synthetic lessons only (D-026); nothing leaves localhost.
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  page.on('pageerror', (e) => { if (!/origin "null"/.test(String(e))) problems.push(`pageerror: ${e}`); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { problems.push(`external: ${route.request().url()}`); return route.abort(); });
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
async function open(page, id) {
  await page.evaluate(() => {
    window.__hits = [];
    window.__probe = [];
    addEventListener('message', (e) => {
      if (e.data && e.data.nested) window.__hits.push(String(e.data.rtc));
      if (e.data && e.data.probe) window.__probe.push(`${e.data.probe}=${e.data.v}`);
    });
  });
  await page.goto(`./#/c/${id}`);
  await page.goto(`./#/c/${id}/read/0001`);
  const wrap = page.locator('.lesson-frame__wrap').first();
  await expect(wrap).toHaveAttribute('data-lesson-state', /ready|fallback|error/, { timeout: 20000 });
  return wrap;
}
const js = (s) => JSON.stringify(s).replace(/<\//g, '<\\/');
const attrOf = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** A nested document that tells the app (top) it runs: the app's backstop sees it. */
const NOISY = `<scr` + `ipt>setInterval(function(){try{top.postMessage({nested:'x',rtc:typeof RTCPeerConnection},'*')}catch(e){}},300)</scr` + `ipt>`;
/** A nested document that talks only to the lesson (its parent): out of the app's sight. */
const SILENT = `<scr` + `ipt>var pc=null,e='';try{pc=new RTCPeerConnection();pc.createDataChannel('x');pc.onicecandidate=function(ev){if(ev.candidate)parent.postMessage({relay:'candidate'},'*')};pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).then(function(){parent.postMessage({relay:'offer'},'*')})}catch(x){e=String(x)}parent.postMessage({relay:typeof RTCPeerConnection+':'+(!!pc)+e},'*')</scr` + `ipt>`;
/** Lesson prelude: rep() to the app, relays of the silent nested document, A/S/N = frame markup strings. */
const PRELUDE = `function rep(n,v){try{parent.postMessage({probe:n,v:String(v).slice(0,2000)},'*')}catch(e){}}`
  + `addEventListener('message',function(e){if(e.data&&e.data.relay)rep('relay',e.data.relay)});`
  + `var N=${js(attrOf(NOISY))};var S=${js(attrOf(SILENT))};`;
const lesson = (code) => doc(`<script>${PRELUDE}try{${code}}catch(e){rep('err',e)}</script>`);

// ---------------------------------------------------------------------------
test.describe('T051-I1: the Sanitizer API builds closed shadow roots the guard never sees', () => {
  const DEFINE = `customElements.define('x-host',class extends HTMLElement{constructor(){super();window.__int=this.attachInternals();}});`;
  const WAYS = {
    'Element.setHTML with a declarative closed root, reached through ElementInternals':
      `${DEFINE}var h=document.createElement('div');document.body.append(h);h.setHTML('<x-host><template shadowrootmode="closed"></template></x-host>',{sanitizer:{}});`,
    'Document.parseHTML with a declarative closed root, adopted into the lesson':
      `${DEFINE}var d=Document.parseHTML('<x-host><template shadowrootmode="closed"></template></x-host>',{sanitizer:{}});document.body.append(document.adoptNode(d.body.firstChild));`,
  };
  // The new HTML insertion APIs of Chromium (…HTMLUnsafe, stream…HTMLUnsafe) parse declarative
  // shadow roots with frames in them directly: no handle on the root needed at all.
  const DSD = `'<div><template shadowrootmode="closed"><iframe srcdoc="'+S+'"></iframe></template></div>'`;
  const DIRECT = {
    'Element.appendHTMLUnsafe': `var h=document.createElement('div');document.body.append(h);h.appendHTMLUnsafe(${DSD});`,
    'Element.replaceWithHTMLUnsafe': `var h=document.createElement('div');document.body.append(h);h.replaceWithHTMLUnsafe(${DSD});`,
    'Element.streamHTMLUnsafe': `var h=document.createElement('div');document.body.append(h);var w=h.streamHTMLUnsafe().getWriter();w.write(${DSD});w.close();`,
    'ShadowRoot.appendHTMLUnsafe on a root the guard knows': `var h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'open'}).appendHTMLUnsafe(${DSD});`,
  };
  Object.entries(DIRECT).forEach(([name, code], n) => {
    test(`${name} with a declarative closed root holding a frame: the nested document runs`, async ({ page }) => {
      // T-052: fixed (every member with "HTML" in its name is locked away in the lesson).
      const id = `LRN-SU${n}`;
      // T-052: the method is locked away inside the lesson now, so "does the browser
      // have it" is asked in the app's own realm (same browser), not in the lesson.
      expect(await page.evaluate(() => typeof Element.prototype.appendHTMLUnsafe)).toBe('function');
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': lesson(code) });
      const wrap = await open(page, id);
      await page.waitForTimeout(3000);
      const probe = await page.evaluate(() => window.__probe);
      const stopped = await wrap.getAttribute('data-lesson-stopped');
      console.log(`T-051 I1 "${name}": ${JSON.stringify(probe)}, stopped=${stopped}`);
      expect(probe).not.toContain('absent=1');
      expect(probe.filter((p) => p.startsWith('relay='))).toEqual([]);
    });
  });
  Object.entries(WAYS).forEach(([name, make], n) => {
    test(`${name}: a silent nested document gets a working RTCPeerConnection`, async ({ page }) => {
      // T-052: fixed (setHTML / Document.parseHTML are locked away; ElementInternals#shadowRoot is watched).
      const id = `LRN-SZ${n}`;
      const code = `${make}var sr=window.__int&&window.__int.shadowRoot;rep('root',!!sr);if(sr)sr.innerHTML='<iframe srcdoc="'+S+'"></iframe>';`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': lesson(code) });
      const wrap = await open(page, id);
      await page.waitForTimeout(3000);
      const probe = await page.evaluate(() => window.__probe);
      const stopped = await wrap.getAttribute('data-lesson-stopped');
      console.log(`T-051 I1 "${name}": ${JSON.stringify(probe)}, stopped=${stopped}`);
      // T-052: the lesson no longer gets the closed root (setHTML / Document.parseHTML
      // are gone, so the code throws: 'err=…'); before the fix it did ('root=true').
      expect(probe.some((p) => p === 'root=true' || p.startsWith('err='))).toBe(true);
      expect(probe.filter((p) => p.startsWith('relay='))).toEqual([]); // no nested document ran
    });
  });

  test('the same frame, but its document talks to the app: the app stops the lesson (the backstop of T-050-fix holds)', async ({ page }) => {
    const code = `${DEFINE}var h=document.createElement('div');document.body.append(h);h.setHTML('<x-host><template shadowrootmode="closed"></template></x-host>',{sanitizer:{}});window.__int.shadowRoot.innerHTML='<iframe srcdoc="'+N+'"></iframe>';`;
    await importCourse(page, 'LRN-SZN', { 'INDEX.md': strToU8('# LRN-SZN\n'), 'lessons/0001-g.html': lesson(code) });
    const wrap = await open(page, 'LRN-SZN');
    // T-052: setHTML is locked away in the lesson now, so the frame is never built
    // (the backstop has nothing to stop); before the fix the app stopped the lesson.
    // Either way no nested document may keep running.
    await page.waitForTimeout(2000);
    const stopped = await wrap.getAttribute('data-lesson-stopped');
    if (stopped !== 'frame') {
      expect(await page.evaluate(() => window.__probe.some((p) => p.startsWith('err=')))).toBe(true);
      expect(await page.evaluate(() => window.__hits)).toEqual([]);
    } else {
      await expect(page.locator('.lesson-frame__wrap iframe')).toHaveCount(0);
    }
  });

  test('which HTML parser entry points a lesson still has (for the report)', async ({ page }) => {
    const code = `var r=[];var protos={Element:Element.prototype,ShadowRoot:ShadowRoot.prototype,Document:Document.prototype,Range:Range.prototype,HTMLTemplateElement:HTMLTemplateElement.prototype};`
      + `for(var k in protos){var o=protos[k];for(var p of Object.getOwnPropertyNames(o)){if(/HTML/.test(p)){var d=Object.getOwnPropertyDescriptor(o,p);r.push(k+'.'+p+':'+(d.value===undefined&&!d.get?'locked':typeof (d.value||d.get)))}}}`
      + `for(var p of Object.getOwnPropertyNames(Document)){if(/HTML/.test(p))r.push('Document.'+p+':'+typeof Document[p])}rep('parsers',r.join(' '));`;
    await importCourse(page, 'LRN-SZL', { 'INDEX.md': strToU8('# LRN-SZL\n'), 'lessons/0001-g.html': lesson(code) });
    await open(page, 'LRN-SZL');
    await expect.poll(() => page.evaluate(() => window.__probe.find((p) => p.startsWith('parsers=')))).toBeTruthy();
    const list = (await page.evaluate(() => window.__probe.find((p) => p.startsWith('parsers=')))).slice(8);
    console.log(`T-051 parser entry points in a lesson: ${list}`);
    expect(list).toMatch(/Element\.setHTMLUnsafe:locked/);
    expect(list).toMatch(/ShadowRoot\.setHTMLUnsafe:locked/);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-051: ways the guard of T-050-fix holds', () => {
  const POISON = `Object.defineProperty(Object.prototype,'childList',{get:function(){return false},configurable:true});`
    + `Object.defineProperty(Object.prototype,'subtree',{get:function(){throw new Error('x')},configurable:true});`
    + `NodeList.prototype[Symbol.iterator]=function(){return [][Symbol.iterator]()};Array.prototype[Symbol.iterator]=function(){return {next:function(){return {done:true}}}};`
    + `Object.defineProperty(Node.prototype,'nodeType',{get:function(){return 3},configurable:true});`
    + `Object.defineProperty(Element.prototype,'localName',{get:function(){return 'div'},configurable:true});`
    + `Object.defineProperty(Element.prototype,'shadowRoot',{get:function(){return null},configurable:true});`
    + `Object.defineProperty(NodeList.prototype,'length',{get:function(){return 0},configurable:true});`
    + `EventTarget.prototype.addEventListener=function(){};Function.prototype.bind=function(){return function(){}};`
    + `Function.prototype.call=function(){};Function.prototype.apply=function(){};Reflect.apply=function(){};`
    + `window.MutationObserver=function(){};MutationObserver.prototype.observe=function(){};window.setTimeout=function(){};`;
  const later = (ms, code) => `(window.__st||setTimeout)(function(){${code}},${ms});`;
  const CLOSED = (inner) => `var h=document.createElement('div');document.body.append(h);var s=h.attachShadow({mode:'closed'});${inner}`;
  const WAYS = {
    'frames[0] read synchronously after innerHTML (about:blank)':
      `var d=document.createElement('div');d.innerHTML='<iframe></iframe>';document.body.append(d);var W=frames[0];rep('sync',W&&typeof W.RTCPeerConnection);`,
    'an iframe onload handler via insertAdjacentHTML':
      `document.body.insertAdjacentHTML('beforeend','<iframe onload="rep(\\'onload\\',frames[0]&&typeof frames[0].RTCPeerConnection)" srcdoc="'+N+'"></iframe>');`,
    'outerHTML replaced by a frame': `var p=document.createElement('p');document.body.append(p);p.outerHTML='<iframe srcdoc="'+N+'"></iframe>';`,
    'createContextualFragment with a declarative closed root': `document.body.append(document.createRange().createContextualFragment('<div><template shadowrootmode="closed"><iframe srcdoc="'+N+'"></iframe></template></div>'));`,
    'DOMParser + importNode into a closed root': CLOSED(`var d=new DOMParser().parseFromString('<iframe srcdoc="'+N+'"></iframe>','text/html');s.append(document.importNode(d.body.firstChild,true));`),
    'a shadow root made in template.content, host moved in later': `var t=document.createElement('template');var h=document.createElement('div');t.content.append(h);var s=h.attachShadow({mode:'closed'});s.innerHTML='<iframe srcdoc="'+N+'"></iframe>';${later(300, 'document.body.append(h)')}`,
    'a custom element that opens a closed root in its constructor': `customElements.define('x-c',class extends HTMLElement{constructor(){super();var s=this.attachShadow({mode:'closed'});var self=this;setTimeout(function(){s.innerHTML='<iframe srcdoc="'+N+'"></iframe>'},200)}});document.body.innerHTML+='<x-c></x-c>';`,
    'closed → closed → open roots, a frame at depth 3 after 1 s': CLOSED(`var a=document.createElement('div');s.append(a);var s2=a.attachShadow({mode:'closed'});var b=document.createElement('div');s2.append(b);var s3=b.attachShadow({mode:'open'});${later(1000, `s3.innerHTML='<p><iframe srcdoc="'+N+'"></iframe></p>'`)}`),
    'contenteditable in a closed root + execCommand insertHTML': CLOSED(`s.innerHTML='<div contenteditable id=e>x</div>';s.getElementById('e').focus();document.execCommand('insertHTML',false,'<iframe srcdoc="'+N+'"></iframe>');`),
    'svg foreignObject frame via innerHTML': `var d=document.createElement('div');d.innerHTML='<svg><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="'+N+'"></iframe></foreignObject></svg>';document.body.append(d);`,
    'every prototype/global the guard could read replaced, then a closed root 300 ms later': `window.__st=setTimeout;${POISON}${later(300, CLOSED(`s.innerHTML='<iframe srcdoc="'+N+'"></iframe>';`))}`,
    'a frame 6 s after load in an open root': `${later(6000, `var h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'open'}).innerHTML='<iframe srcdoc="'+N+'"></iframe>';`)}`,
    '2000 closed roots, then a frame in the last one': `var last;var t0=performance.now();for(var i=0;i<2000;i++){var h=document.createElement('span');document.body.append(h);last=h.attachShadow({mode:'closed'});}rep('made',Math.round(performance.now()-t0));${later(1500, `last.innerHTML='<iframe srcdoc="'+N+'"></iframe>';`)}`,
  };
  Object.entries(WAYS).forEach(([name, code], n) => {
    test(`${name}: no nested document runs`, async ({ page }) => {
      const id = `LRN-GW${n}`;
      const slow = /6 s/.test(name);
      if (slow) test.setTimeout(60_000);
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': lesson(code) });
      const wrap = await open(page, id);
      await page.waitForTimeout(slow ? 8000 : 3000);
      const hits = await page.evaluate(() => window.__hits);
      const probe = await page.evaluate(() => window.__probe);
      const stopped = await wrap.getAttribute('data-lesson-stopped');
      console.log(`T-051 guard "${name}": hits=${hits.length}, probe=${JSON.stringify(probe)}, stopped=${stopped}`);
      expect(hits).toEqual([]);
      expect(probe.filter((p) => /=function$/.test(p) || p.startsWith('relay='))).toEqual([]);
    });
  });

  test('document.write after the lesson replaced everything it could: still does nothing', async ({ page }) => {
    const code = `Function.prototype.apply=function(){};Document.prototype.write=function(){rep('replaced',1)};document.write('<div><template shadowrootmode="closed"><iframe srcdoc="'+N+'"></iframe></template></div>');rep('desc',Object.getOwnPropertyDescriptor(Document.prototype,'write').writable);`;
    await importCourse(page, 'LRN-GDW', { 'INDEX.md': strToU8('# LRN-GDW\n'), 'lessons/0001-g.html': lesson(code) });
    await open(page, 'LRN-GDW');
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__hits)).toEqual([]);
    const probe = await page.evaluate(() => window.__probe);
    expect(probe).toContain('desc=false');
    expect(probe).not.toContain('replaced=1');
  });
});

// ---------------------------------------------------------------------------
test.describe('T050-D1 retest: fake bridge markers in the lesson', () => {
  const M = '<!--easylrn:bridge-->';
  const page_ = (body, head = '') => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body><h1>Урок</h1><p>Текст.</p>${body}</body></html>`;
  const CASES = {
    'in an attribute': page_(`<p title="${M}" data-x='${M}</body>'>a</p>`),
    'in a textarea and a title in the body': page_(`<textarea>${M}</textarea><title>${M}</title>`),
    'in a style and a script (head and body)': page_(`<script>var a='${M}';</script><style>/*${M}*/</style>`, `<style>/*${M}*/</style><script>var b="${M}"</script>`),
    'in a noscript (removed) and an xmp': page_(`<noscript>${M}</noscript><xmp>${M}</xmp>`),
    'in SVG CDATA, with "</body>" in it': page_(`<svg><script><![CDATA[ var s="${M}</body></html>"; ]]></script><text><![CDATA[${M}]]></text></svg>`),
    'many markers and 3000 comments': page_(`${M}${M}`.repeat(5) + '<!-- x -->'.repeat(3000) + M),
    'the marker with spaces (not ours) and a marker after </html>': `${page_('<!-- easylrn:bridge --><!--easylrn:bridge -->')}${M}\n${M}`,
    'a marker before <html> and in <head>': `<!DOCTYPE html>${M}<html lang="bg">${M}<head>${M}<meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p></body></html>`,
    'no <body> at all (only a <head>)': `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title><script>var x='${M}'</script></head></html>`,
    'a template whose content ends with the marker': page_(`<template><p>t</p>${M}</template>`),
  };
  Object.entries(CASES).forEach(([name, html], n) => {
    test(`${name}: one bridge, the last element of <body>, no marker left, the lesson gets ready`, async ({ page }) => {
      const id = `LRN-FM${n}`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': strToU8(html) });
      const wrap = await open(page, id);
      await expect(wrap).toHaveAttribute('data-lesson-state', 'ready');
      const served = await page.evaluate(async (u) => (await fetch(u)).text(), `./c/${id}/lessons/0001-g.html`);
      const parsed = await page.evaluate((t) => {
        const d = new DOMParser().parseFromString(t, 'text/html');
        const w = d.createTreeWalker(d, 128);
        let markers = 0;
        for (let c = w.nextNode(); c; c = w.nextNode()) if (c.data === 'easylrn:bridge') markers++;
        return { last: d.body.lastElementChild?.getAttribute('data-easylrn'), bridges: d.querySelectorAll('script[data-easylrn="bridge"]').length, guards: d.querySelectorAll('script[data-easylrn="guard"]').length, guardFirst: d.head.firstElementChild?.getAttribute('data-easylrn'), markers };
      }, served);
      // A comment of the lesson inside <head> stays (harmless: the bridge still goes to the end of <body>).
      const markers = /in <head>/.test(name) ? 1 : 0;
      expect(parsed).toEqual({ last: 'bridge', bridges: 1, guards: 1, guardFirst: 'guard', markers });
      expect(/<\/script>\s*<\/body><\/html>$/.test(served)).toBe(true);
    });
  });

  test('<plaintext> (swallows the rest of the text): never served with a broken bridge', async ({ page }) => {
    const html = page_(`<plaintext>${M}</body></html>`);
    await importCourse(page, 'LRN-FMP', { 'INDEX.md': strToU8('# LRN-FMP\n'), 'lessons/0001-g.html': strToU8(html) });
    const wrap = await open(page, 'LRN-FMP');
    const state = await wrap.getAttribute('data-lesson-state');
    const served = await page.evaluate(async (u) => { const r = await fetch(u); return `${r.status} ${await r.text()}`; }, './c/LRN-FMP/lessons/0001-g.html');
    console.log(`T-051 D1 plaintext: state=${state}, served=${JSON.stringify(served.slice(0, 120))}…`);
    // Either the safe "cannot be shown" page, or a lesson with a working bridge.
    expect(/Урокът не може да се покаже/.test(served) || state === 'ready').toBe(true);
  });
});

// ---------------------------------------------------------------------------
test.describe('RENDER_VERSION 3 → 4: a render stored by 0.6.1 is never served', () => {
  test('a stored v3 render with a declarative closed root and a "</body" after </html> is redone before the lesson is shown', async ({ page }) => {
    const ID = 'LRN-RV3';
    const original = '<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p></body></html>';
    await importCourse(page, ID, { 'INDEX.md': strToU8(`# ${ID}\n`), 'lessons/0001-g.html': strToU8(original) });
    await open(page, ID);
    // What 0.6.1 could have stored: no marker, a declarative closed root with a frame
    // reachable through ElementInternals, and a comment with "</body" after </html>.
    const v3 = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><x-h><template shadowrootmode="closed"><iframe srcdoc="${attrOf(NOISY)}"></iframe></template></x-h></body></html><!-- </body> -->`;
    await page.evaluate(async (v3) => {
      const db = await import('./src/db.js');
      const handle = await db.openDb();
      const key = 'LRN-RV3/lessons/0001-g.html';
      const rec = await handle.get('files', key);
      await handle.put('files', { ...rec, rendered: new Blob([v3], { type: 'text/html' }), renderVersion: 3 });
    }, v3);
    const status = await page.evaluate(async () => (await fetch('./c/LRN-RV3/lessons/0001-g.html')).status);
    expect(status).toBe(404); // a stale render is never served
    await page.goto('./#/');
    const wrap = await open(page, ID);
    await expect(wrap).toHaveAttribute('data-lesson-state', 'ready');
    const after = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const rec = await (await db.openDb()).get('files', 'LRN-RV3/lessons/0001-g.html');
      const served = await (await fetch('./c/LRN-RV3/lessons/0001-g.html')).text();
      return { version: rec.renderVersion, served };
    });
    expect(after.version).toBe(4);
    expect(after.served).not.toContain('shadowrootmode');
    expect(after.served).not.toContain('<iframe');
    expect(/<\/script>\s*<\/body><\/html>$/.test(after.served)).toBe(true);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__hits)).toEqual([]);
  });
});
