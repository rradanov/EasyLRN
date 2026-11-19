// T-053 (tester): tests of T-052 (0.7.1).
// - T051-I1 fix: every member with "HTML" in its name is locked in a lesson
//   (but innerHTML / outerHTML / insertAdjacentHTML / getHTML / Trusted*),
//   ElementInternals#shadowRoot is wrapped, attachInternals is kept.
//   Attacks: custom elements with closed roots, declarative shadow DOM by every
//   parser a lesson still has, other documents of the same realm, attempts to
//   get a locked member back. Legit lesson code still works.
//   D-037: a new way to a nested document is information (T053-I*).
// - "Н\u0430стройки": late check answers (D1), the threshold (D2), key characters
//   (I2), lesson data in the console (I3), the key field.
// Only FAKE keys, synthetic lessons, api.anthropic.com only mocked (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const KEY = 'sk-ant-test-FAKE-t053-4c8e';
const KEY2 = 'sk-ant-test-FAKE-t053-two-7d1a';
const API = /^https:\/\/api\.anthropic\.com\//;
const OK = { status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'p' }], usage: { input_tokens: 8, output_tokens: 1 } } };
const E401 = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'x' } } };

let logs;
let external;
let apiSeen;
test.beforeEach(async ({ page, context }) => {
  logs = [];
  external = [];
  apiSeen = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => { if (!/origin "null"/.test(String(e))) logs.push(`pageerror: ${e}`); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => {
  // The app's own console (not the lesson's) never carries a key.
  expect(logs.filter((l) => /EasyLRN|pageerror|^error/.test(l)).join('\n')).not.toContain('FAKE');
  expect(logs.filter((l) => l.startsWith('pageerror'))).toEqual([]);
  expect(external.filter((u) => !API.test(u))).toEqual([]);
});

// --- helpers: lessons ----------------------------------------------------------
const doc = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body><h1>Урок</h1><p>Текст н\u0430 урок\u0430.</p>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
async function open(page, id, state = /ready|fallback|error/) {
  await page.evaluate(() => {
    window.__hits = [];
    window.__probe = [];
    addEventListener('message', (e) => {
      if (e.data && e.data.nested) window.__hits.push(String(e.data.nested));
      if (e.data && e.data.probe) window.__probe.push(`${e.data.probe}=${e.data.v}`);
    });
  });
  await page.goto(`./#/c/${id}`);
  await page.goto(`./#/c/${id}/read/0001`);
  const wrap = page.locator('.lesson-frame__wrap').first();
  await expect(wrap).toHaveAttribute('data-lesson-state', state, { timeout: 20000 });
  return wrap;
}
const js = (s) => JSON.stringify(s).replace(/<\//g, '<\\/');
const attrOf = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** A nested document that only says "I ran" (to the lesson and to the app). */
const MARK = `<scr` + `ipt>try{parent.postMessage({relay:'ran'},'*')}catch(e){}try{top.postMessage({nested:'ran'},'*')}catch(e){}</scr` + `ipt>`;
const PRELUDE = `function rep(n,v){try{parent.postMessage({probe:n,v:String(v).slice(0,4000)},'*')}catch(e){}}`
  + `addEventListener('message',function(e){if(e.data&&e.data.relay)rep('relay',e.data.relay)});`
  + `var M=${js(attrOf(MARK))};var F='<iframe srcdoc="'+M+'"></iframe>';var DSD='<div><template shadowrootmode="closed">'+F+'</template></div>';`;
const lesson = (code, body = '') => doc(`${body}<script>${PRELUDE}try{${code}}catch(e){rep('err',e)}rep('done',1)</script>`);
const noNested = async (page) => {
  expect(await page.evaluate(() => window.__hits)).toEqual([]);
  expect(await page.evaluate(() => window.__probe.filter((p) => p.startsWith('relay=')))).toEqual([]);
};

// ---------------------------------------------------------------------------
test.describe('T051-I1 fix: what is locked in a lesson', () => {
  test('inventory: only the six kept HTML members are left on every interface (prototype and static), nothing on namespaces', async ({ page }) => {
    const code = `var left=[];var other=[];var seen=[];var o=window;var names=[];`
      + `for(;o&&o!==Object.prototype;o=Object.getPrototypeOf(o))names=names.concat(Object.getOwnPropertyNames(o));`
      + `function scan(label,obj,out){var own;try{own=Object.getOwnPropertyNames(obj)}catch(e){return}for(var p of own){if(p.indexOf('HTML')<0)continue;var d=Object.getOwnPropertyDescriptor(obj,p);if(d.get||d.set||d.value!==undefined)out.push(label+'.'+p)}}`
      + `for(var n of names){var d=Object.getOwnPropertyDescriptor(window,n);if(!d||!('value' in d))continue;var v=d.value;`
      + `if(typeof v==='function'&&/^[A-Z]/.test(n)){if(seen.indexOf(v)>=0||/^Trusted/.test(n))continue;seen.push(v);scan(n,v,left);if(v.prototype&&typeof v.prototype==='object')scan(n+'.prototype',v.prototype,left)}`
      + `else if(v&&typeof v==='object'&&n!=='window'&&n!=='self'&&n!=='frames'&&n!=='globalThis'&&n!=='top'&&n!=='parent')scan(n,v,other)}`
      + `scan('document',document,other);`
      + `rep('left',left.sort().join(' '));rep('other',other.sort().join(' '));`
      + `var ei=Object.getOwnPropertyDescriptor(ElementInternals.prototype,'shadowRoot');rep('ei',ei.configurable+':'+typeof ei.get);`
      + `rep('attachInternals',typeof HTMLElement.prototype.attachInternals);`
      + `var locked=[];seen=[];for(var n of names){var d=Object.getOwnPropertyDescriptor(window,n);if(!d||typeof d.value!=='function'||!/^[A-Z]/.test(n)||seen.indexOf(d.value)>=0)continue;seen.push(d.value);[[n,d.value],[n+'.prototype',d.value.prototype]].forEach(function(x){if(!x[1]||typeof x[1]!=='object'&&typeof x[1]!=='function')return;for(var p of Object.getOwnPropertyNames(x[1])){if(p.indexOf('HTML')<0)continue;var q=Object.getOwnPropertyDescriptor(x[1],p);if(q.value===undefined&&!q.get&&!q.writable&&!q.configurable)locked.push(x[0]+'.'+p)}})}rep('locked',locked.sort().join(' '));`;
    await importCourse(page, 'LRN-K1', { 'INDEX.md': strToU8('# LRN-K1\n'), 'lessons/0001-g.html': lesson(code) });
    await open(page, 'LRN-K1');
    await expect.poll(() => page.evaluate(() => window.__probe.some((p) => p === 'done=1'))).toBe(true);
    const probe = await page.evaluate(() => window.__probe);
    console.log(`T-053 inventory: ${JSON.stringify(probe)}`);
    const get = (k) => probe.find((p) => p.startsWith(`${k}=`)).slice(k.length + 1);
    expect(get('left')).toBe('Element.prototype.getHTML Element.prototype.innerHTML Element.prototype.insertAdjacentHTML Element.prototype.outerHTML ShadowRoot.prototype.getHTML ShadowRoot.prototype.innerHTML');
    expect(get('other')).toBe(''); // no HTML parser on a namespace object (CSS, document, window own…)
    expect(get('ei')).toBe('false:function');
    expect(get('attachInternals')).toBe('function');
    // T053-I1 (information): the name rule also locks members that build no shadow root, e.g.
    // DOMImplementation#createHTMLDocument (an inert document of the same realm). Legit code that
    // uses it breaks; lrn-teach lessons (quiz.js, reflect.js) do not.
    console.log(`T-053 locked in a lesson: ${get('locked')}`);
    expect(get('locked')).toContain('DOMImplementation.prototype.createHTMLDocument');
  });

  test('a locked member cannot be got back: delete, defineProperty, Reflect, assignment, __lookupGetter__, with, Proxy, other documents of the realm', async ({ page }) => {
    const checks = {
      del: `delete Element.prototype.setHTMLUnsafe`,
      reflectDefine: `Reflect.defineProperty(Element.prototype,'setHTMLUnsafe',{value:function(){}})`,
      define: `(function(){try{Object.defineProperty(Document,'parseHTMLUnsafe',{value:1});return 'no-throw'}catch(e){return 'throws'}})()`,
      assign: `(function(){Element.prototype.setHTML=function(){};return typeof Element.prototype.setHTML})()`,
      lookup: `typeof Element.prototype.__lookupGetter__('setHTMLUnsafe')`,
      withScope: `(function(){with(Element.prototype){return typeof setHTMLUnsafe}})()`,
      proxy: `typeof new Proxy(document.body,{}).setHTMLUnsafe`,
      reflectGet: `typeof Reflect.get(Element.prototype,'appendHTMLUnsafe',document.body)`,
      htmlDoc: `typeof document.implementation.createHTMLDocument('x').body.setHTMLUnsafe`,
      newDoc: `typeof new Document().constructor.parseHTMLUnsafe`,
      xmlDoc: `typeof document.implementation.createDocument('http://www.w3.org/1999/xhtml','html',null).documentElement.setHTMLUnsafe`,
      templateDoc: `typeof document.createElement('template').content.ownerDocument.createElement('div').setHTMLUnsafe`,
      domParserDoc: `typeof new DOMParser().parseFromString('<p>x</p>','text/html').body.setHTMLUnsafe`,
      htmlDocument: `typeof HTMLDocument.parseHTMLUnsafe`,
      shadow: `typeof document.createElement('div').attachShadow({mode:'open'}).setHTMLUnsafe`,
      eiDefine: `(function(){try{Object.defineProperty(ElementInternals.prototype,'shadowRoot',{get:function(){return null}});return 'no-throw'}catch(e){return 'throws'}})()`,
      setProto: `(function(){var p=Object.getPrototypeOf(Element.prototype);try{Object.setPrototypeOf(Element.prototype,{setHTMLUnsafe:1})}catch(e){}var r=typeof document.body.setHTMLUnsafe;try{Object.setPrototypeOf(Element.prototype,p)}catch(e){}return r})()`,
    };
    const code = Object.entries(checks).map(([k, c]) => `try{rep(${js(k)},${c})}catch(e){rep(${js(k)},'err:'+e.name)}`).join('');
    await importCourse(page, 'LRN-K2', { 'INDEX.md': strToU8('# LRN-K2\n'), 'lessons/0001-g.html': lesson(code) });
    await open(page, 'LRN-K2');
    await expect.poll(() => page.evaluate(() => window.__probe.some((p) => p === 'done=1'))).toBe(true);
    const probe = Object.fromEntries((await page.evaluate(() => window.__probe)).map((p) => p.split(/=(.*)/s).slice(0, 2)));
    console.log(`T-053 restore attempts: ${JSON.stringify(probe)}`);
    expect(probe).toMatchObject({
      del: 'false', reflectDefine: 'false', define: 'throws', assign: 'undefined', lookup: 'undefined', withScope: 'undefined',
      proxy: 'undefined', reflectGet: 'undefined', htmlDoc: 'err:TypeError' /* T053-I1: createHTMLDocument is locked too */, newDoc: 'undefined', xmlDoc: 'undefined',
      templateDoc: 'undefined', domParserDoc: 'undefined', htmlDocument: 'undefined', shadow: 'undefined', eiDefine: 'throws',
    });
    // setPrototypeOf on Element.prototype: an ordinary object can be put in the chain, but it is not the
    // browser's parser (no original function is reachable). Logged only.
    console.log(`T-053 setPrototypeOf(Element.prototype, {setHTMLUnsafe:1}) → ${probe.setProto}`);
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I1 fix: ways to a nested document after T-052 (none may run)', () => {
  const CE = (name, body) => `customElements.define('${name}',class extends HTMLElement{constructor(){super();var i=this.attachInternals();var s=this.attachShadow({mode:'closed'});${body}}});`;
  const WAYS = {
    'custom element: attachInternals + closed attachShadow + frame by innerHTML in the constructor':
      `${CE('x-a', `s.innerHTML=F;`)}document.body.append(document.createElement('x-a'));`,
    'custom element: frame put in later through internals.shadowRoot':
      `${CE('x-b', `var self=i;setTimeout(function(){var r=self.shadowRoot;rep('same',!!r);r.innerHTML='<p>'+F+'</p>'},300);`)}document.body.append(document.createElement('x-b'));`,
    'custom element: frame through outerHTML on an element inside the closed root':
      `${CE('x-c', `s.innerHTML='<p id=p>x</p>';var p=s.getElementById('p');setTimeout(function(){p.outerHTML=F},200);`)}document.body.append(document.createElement('x-c'));`,
    'custom element: frame through insertAdjacentHTML in the closed root':
      `${CE('x-d', `s.innerHTML='<p id=p>x</p>';s.getElementById('p').insertAdjacentHTML('afterend',F);`)}document.body.append(document.createElement('x-d'));`,
    'form-associated custom element upgraded from innerHTML, closed root, frame':
      `customElements.define('x-e',class extends HTMLElement{static get formAssociated(){return true}constructor(){super();this.attachInternals();this.attachShadow({mode:'closed'}).innerHTML=F}});document.body.innerHTML+='<x-e></x-e>';`,
    'declarative closed root by innerHTML': `var d=document.createElement('div');document.body.append(d);d.innerHTML=DSD;`,
    'declarative closed root by insertAdjacentHTML': `document.body.insertAdjacentHTML('beforeend',DSD);`,
    'declarative closed root by outerHTML': `var p=document.createElement('p');document.body.append(p);p.outerHTML=DSD;`,
    'declarative closed root by innerHTML on a detached host, attached later': `var d=document.createElement('div');d.innerHTML=DSD;setTimeout(function(){document.body.append(d)},200);`,
    'declarative root in a closed root by innerHTML': `var h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'closed'}).innerHTML=DSD;`,
    'Range.createContextualFragment with a declarative root': `document.body.append(document.createRange().createContextualFragment(DSD));`,
    'DOMParser text/html with a declarative root, adoptNode': `var d=new DOMParser().parseFromString(DSD,'text/html');document.body.append(document.adoptNode(d.body.firstChild));`,
    'DOMParser, frame imported into a closed root': `var d=new DOMParser().parseFromString(F,'text/html');var h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'closed'}).append(document.importNode(d.body.firstChild,true));`,
    'createHTMLDocument + innerHTML, adopted into a closed root': `var x=document.implementation.createHTMLDocument('x');x.body.innerHTML=F+DSD;var h=document.createElement('div');document.body.append(h);var s=h.attachShadow({mode:'closed'});while(x.body.firstChild)s.append(document.adoptNode(x.body.firstChild));`,
    'createHTMLDocument + document.write there, imported': `var x=document.implementation.createHTMLDocument('x');try{x.open();x.write(DSD+F);x.close()}catch(e){rep('xw',e.name)}rep('xframes',x.querySelectorAll('iframe').length);while(x.body&&x.body.firstChild)document.body.append(document.importNode(x.body.firstChild,true));`,
    'XMLSerializer round trip of a template with shadowrootmode': `var t=document.createElement('div');t.innerHTML=DSD;var s=new XMLSerializer().serializeToString(t);var h=document.createElement('div');document.body.append(h);h.innerHTML=s;`,
    'XSLTProcessor (if any) → fragment with a frame into a closed root':
      `if(typeof XSLTProcessor!=='function'){rep('xslt','absent')}else{var xsl=new DOMParser().parseFromString('<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:output method="html"/><xsl:template match="/"><div><iframe srcdoc="x"></iframe></div></xsl:template></xsl:stylesheet>','application/xml');`
      + `var p=new XSLTProcessor();p.importStylesheet(xsl);var fr=p.transformToFragment(new DOMParser().parseFromString('<a/>','application/xml'),document);var h=document.createElement('div');document.body.append(h);var s=h.attachShadow({mode:'closed'});var f=fr.querySelector&&fr.querySelector('iframe');if(f)f.setAttribute('srcdoc',M);s.append(fr);rep('xslt','used')}`,
    'document.open() and write (then innerHTML) ': `try{document.open();document.write(DSD);document.close()}catch(e){rep('ow',e.name)}setTimeout(function(){var d=document.createElement('div');(document.body||document.documentElement).append(d);d.innerHTML=F},200);`,
    'template.content + importNode of a frame into a closed root': `var t=document.createElement('template');t.innerHTML=F;var h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'closed'}).append(document.importNode(t.content,true));`,
    'a frame cloned from a detached parse, moved into a closed root of a detached host, host attached later': `var d=document.createElement('div');d.innerHTML=F;var h=document.createElement('div');var s=h.attachShadow({mode:'closed'});s.append(d.firstChild.cloneNode(true));setTimeout(function(){document.body.append(h)},300);`,
    'execCommand insertHTML with a declarative root (contenteditable)': `var e=document.createElement('div');e.contentEditable='true';document.body.append(e);e.focus();document.execCommand('insertHTML',false,DSD);`,
  };
  Object.entries(WAYS).forEach(([name, code], n) => {
    test(`${name}: no nested document runs`, async ({ page }) => {
      const id = `LRN-W${n}`;
      await importCourse(page, id, { 'INDEX.md': strToU8(`# ${id}\n`), 'lessons/0001-g.html': lesson(code) });
      const wrap = await open(page, id);
      await page.waitForTimeout(2500);
      const probe = await page.evaluate(() => window.__probe);
      console.log(`T-053 way "${name}": ${JSON.stringify(probe)}, stopped=${await wrap.getAttribute('data-lesson-stopped')}`);
      await noNested(page);
    });
  });

  test('declarative closed root with a frame in the lesson source (also nested, also in svg / template): no nested document runs', async ({ page }) => {
    const body = `<div><template shadowrootmode="closed"><p>a</p>${'<iframe srcdoc="' + attrOf(MARK) + '"></iframe>'}</template></div>`
      + `<div><template SHADOWROOTMODE="open"><div><template shadowrootmode="closed"><iframe srcdoc="${attrOf(MARK)}"></iframe></template></div></template></div>`
      + `<template><div><template shadowrootmode="closed"><iframe srcdoc="${attrOf(MARK)}"></iframe></template></div></template>`
      + `<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><template shadowrootmode="closed"><iframe srcdoc="${attrOf(MARK)}"></iframe></template></div></foreignObject></svg>`;
    await importCourse(page, 'LRN-WS', { 'INDEX.md': strToU8('# LRN-WS\n'), 'lessons/0001-g.html': lesson('', body) });
    await open(page, 'LRN-WS');
    await page.waitForTimeout(2500);
    await noNested(page);
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I1 fix: legit lesson code still works', () => {
  test('custom elements (open and closed roots, attachInternals, formAssociated), innerHTML, getHTML, insertAdjacentHTML, links, selection', async ({ page }) => {
    const code = `customElements.define('x-ok',class extends HTMLElement{static get formAssociated(){return true}constructor(){super();this._i=this.attachInternals();this._s=this.attachShadow({mode:'closed'});this._s.innerHTML='<b>в сянк\u0430</b>'}});`
      + `var e=document.createElement('x-ok');document.body.append(e);rep('ce',e._i.shadowRoot===e._s);rep('ceText',e._s.textContent);`
      + `var o=document.createElement('div');document.body.append(o);o.attachShadow({mode:'open'}).innerHTML='<i>отворено</i>';rep('open',o.shadowRoot.textContent);`
      + `var d=document.createElement('div');d.innerHTML='<p class=q>Въпрос <a href="#x">линк</a></p>';document.body.append(d);rep('inner',d.querySelector('a').getAttribute('href'));`
      + `rep('getHTML',typeof d.getHTML==='function'&&d.getHTML().indexOf('Въпрос')>=0);`
      + `d.insertAdjacentHTML('beforeend','<span id=s>доб\u0430вено</span>');rep('iah',!!document.getElementById('s'));`
      + `var r=document.createRange();r.selectNodeContents(d.querySelector('p'));getSelection().removeAllRanges();getSelection().addRange(r);rep('sel',getSelection().toString());`
      + `var t=document.createElement('template');t.innerHTML='<li>1</li>';rep('tpl',t.content.childNodes.length);`;
    await importCourse(page, 'LRN-OK', { 'INDEX.md': strToU8('# LRN-OK\n'), 'lessons/0001-g.html': lesson(code) });
    await open(page, 'LRN-OK', 'ready');
    await expect.poll(() => page.evaluate(() => window.__probe.some((p) => p === 'done=1'))).toBe(true);
    const probe = await page.evaluate(() => window.__probe);
    expect(probe).toEqual(expect.arrayContaining(['ce=true', 'ceText=в сянк\u0430', 'open=отворено', 'inner=#x', 'getHTML=true', 'iah=true', 'sel=Въпрос линк', 'tpl=1', 'done=1']));
    expect(probe.filter((p) => p.startsWith('err='))).toEqual([]);
  });
});

// --- helpers: settings -----------------------------------------------------------
const field = (page, name) => page.locator(`[data-screen="settings"] [data-field="${name}"]`);
async function openSettings(page) {
  await page.goto('./#/settings');
  await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
}
async function saveKey(page, key = KEY) {
  await field(page, 'api-key').fill(key);
  await field(page, 'key-save').click();
  await expect(field(page, 'key-status')).toHaveText(`З\u0430п\u0430зен ключ: •••• ${key.slice(-4)}`);
}
async function mockApi(page, answer) {
  await page.route(API, async (route) => {
    apiSeen.push(route.request().headers()['x-api-key'] || '');
    const a = await answer();
    return route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body ?? {}) });
  });
}
const storedKey = (page) => page.evaluate(async () => (await import('./src/db.js')).getApiKey());

// ---------------------------------------------------------------------------
test.describe('T051-D1 fix: late answers of "Провери"', () => {
  test('check old → save new → check new; the OLD answer arrives last: only the new answer is shown', async ({ page }) => {
    const answers = [];
    await mockApi(page, () => new Promise((r) => answers.push(r)));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(1);
    await saveKey(page, KEY2);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(2);
    expect(apiSeen).toEqual([KEY, KEY2]);
    answers[1](E401);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е нев\u0430лиден \(401\)/);
    answers[0](OK); // old key "works" — must not overwrite
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е нев\u0430лиден \(401\)/);
    await expect(field(page, 'key-check')).toBeEnabled();
  });

  test('"Изтрий" → "З\u0430п\u0430зи" (another key) → both late answers: nothing about them is shown', async ({ page }) => {
    const answers = [];
    await mockApi(page, () => new Promise((r) => answers.push(r)));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(1);
    await field(page, 'key-delete').click();
    await page.getByRole('alertdialog', { name: 'Изтрив\u0430не н\u0430 API ключ\u0430' }).locator('[data-field="confirm-yes"]').click();
    await expect(field(page, 'key-message')).toHaveText('Ключът е изтрит.');
    await saveKey(page, KEY2);
    answers[0](OK);
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е з\u0430п\u0430зен/);
    await expect(field(page, 'key-check')).toBeEnabled();
  });

  test('fast repeated taps on "Провери": one request; "З\u0430п\u0430зи" twice during a check: no stale answer', async ({ page }) => {
    const answers = [];
    await mockApi(page, () => new Promise((r) => answers.push(r)));
    await openSettings(page);
    await saveKey(page);
    const btn = field(page, 'key-check');
    await btn.click();
    await btn.click({ force: true }).catch(() => {});
    await btn.dispatchEvent('click');
    await btn.dispatchEvent('click');
    await page.waitForTimeout(300);
    expect(apiSeen.length).toBe(1);
    await saveKey(page, KEY2);
    await saveKey(page, KEY);
    answers[0](E401);
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е з\u0430п\u0430зен/);
  });

  test('leaving the screen during a check and coming back: no stale "Проверяв\u0430м…", "Провери" works, the late answer is not shown', async ({ page }) => {
    const answers = [];
    await mockApi(page, () => new Promise((r) => answers.push(r)));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText('Проверяв\u0430м…');
    await page.goto('./#/');
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await openSettings(page);
    await expect(field(page, 'key-message')).not.toHaveText('Проверяв\u0430м…');
    await expect(field(page, 'key-check')).toBeEnabled();
    answers[0](OK);
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).not.toHaveText(/Ключът р\u0430боти/);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(2);
    answers[1](E401);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е нев\u0430лиден \(401\)/);
    // back/forward during a check
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(3);
    await page.goBack();
    await page.goForward();
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    answers[2](OK);
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).not.toHaveText(/Ключът р\u0430боти/);
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-D2 fix: the threshold', () => {
  const saved = (page) => page.evaluate(async () => (await (await import('./src/db.js')).getSettings()).monthlyBudgetUSD);
  /** Set the raw value (also what a keyboard could not type) and fire "change". */
  const setRaw = (page, v) => page.locator('[data-screen="settings"] [data-field="budget"]').evaluate((el, x) => {
    el.value = x; el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  test('a whole matrix: what is shown is what is saved, refusals keep the old value', async ({ page }) => {
    await openSettings(page);
    const budget = field(page, 'budget');
    const msg = field(page, 'budget-message');
    const RANGE = /Пр\u0430гът е число от 0 до 1000/;
    const cases = [
      ['3', 'З\u0430п\u0430зено.', '3', 3],
      ['0', 'З\u0430п\u0430зено.', '0', 0],
      ['0.004', /Н\u0430й-м\u0430лкият пр\u0430г е 0\.01/, '0', 0],
      ['0.005', /З\u0430п\u0430зено к\u0430то 0\.01/, '0.01', 0.01],
      ['0.01', 'З\u0430п\u0430зено.', '0.01', 0.01],
      ['2.257', 'З\u0430п\u0430зено к\u0430то 2.26 (з\u0430кръглено до цент).', '2.26', 2.26],
      ['-1', RANGE, '2.26', 2.26],
      ['1e9', RANGE, '2.26', 2.26],
      ['1000', 'З\u0430п\u0430зено.', '1000', 1000],
      ['1000.004', /З\u0430п\u0430зено к\u0430то 1000|Пр\u0430гът/, null, null],
      ['abc', RANGE, '1000', 1000], // a number field turns it into ''
      ['', RANGE, '1000', 1000],
      ['2,5', RANGE, '1000', 1000],
      ['1e-7', /Н\u0430й-м\u0430лкият пр\u0430г е 0\.01/, '1000', 1000],
      ['999.995', /З\u0430п\u0430зено к\u0430то|Пр\u0430гът/, null, null],
    ];
    for (const [v, m, shown, value] of cases) {
      await setRaw(page, v);
      await expect(msg, v).toHaveText(m);
      if (shown !== null) {
        await expect(budget, v).toHaveValue(shown);
        expect(await saved(page), v).toBe(value);
      } else {
        expect(String(await saved(page)), `${v}: field = saved`).toBe(await budget.inputValue());
      }
    }
    // Typed with the keyboard: a comma.
    await budget.fill('');
    await budget.pressSequentially('2,5');
    await budget.press('Tab');
    await page.waitForTimeout(200);
    console.log(`T-053 threshold typed "2,5": shown "${await budget.inputValue()}", saved ${await saved(page)}, message "${await msg.textContent()}"`);
    expect(String(await saved(page))).toBe(await budget.inputValue() || String(await saved(page)));
    // Arrows step by a cent.
    await setRaw(page, '2.26');
    await budget.focus();
    await budget.press('ArrowUp');
    await budget.press('Tab');
    await expect(budget).toHaveValue('2.27');
    expect(await saved(page)).toBe(2.27);
    await page.reload();
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect(budget).toHaveValue('2.27');
  });

  test('typed with a decimal comma "2,5" (Bulgarian keyboard): 2.5 is saved or the value is refused — never 25', async ({ page }) => {
    test.fail(true, 'T053-D1: Chromium drops the comma typed into the number field, so "2,5" becomes 25 and is saved with "Запазено." (the warning threshold is silently 10× higher)');
    await openSettings(page);
    const budget = field(page, 'budget');
    await budget.fill('');
    await budget.pressSequentially('2,5');
    await budget.press('Tab');
    await page.waitForTimeout(300);
    const v = await saved(page);
    console.log(`T-053 D1 "2,5" → shown "${await budget.inputValue()}", saved ${v}, "${await field(page, 'budget-message').textContent()}"`);
    expect(v === 2.5 || v === 5).toBe(true); // 2.5, or the old value (5) kept after a refusal
  });

  test('1.005 (binary float): the field and the store agree, the message says the shown value', async ({ page }) => {
    await openSettings(page);
    await setRaw(page, '1.005');
    await expect(field(page, 'budget-message')).toHaveText(/З\u0430п\u0430зено к\u0430то/);
    const shown = await field(page, 'budget').inputValue();
    expect(String(await saved(page))).toBe(shown);
    await expect(field(page, 'budget-message')).toContainText(shown);
    console.log(`T-053 threshold 1.005 → ${shown}`);
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I2 fix: key characters, the mask', () => {
  const BAD = 'Ключът съдърж\u0430 непозволени зн\u0430ци — копир\u0430й го н\u0430ново от Claude Console.';
  test('inside the key: every odd character is refused with the clear message; nothing stored', async ({ page }) => {
    await openSettings(page);
    const inside = ['\u200b', '\ufeff', '\u00a0', '\t', '\n', '\r', '\u0000', '\u0001', '\u007f', '\u2028', '\u3000', '\u180e', '\u202e', 'é', 'я', '\u0430', ' ', '%', '"', '<', '\ud83d\ude00'];
    for (const c of inside) {
      await field(page, 'api-key').fill(`sk-ant-test-FAKE-00${c}00-1111`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message'), `U+${c.codePointAt(0).toString(16)}`).toHaveText(BAD);
    }
    expect(await storedKey(page)).toBeFalsy();
  });

  test('around the key: spaces, NBSP, tab, line breaks, BOM, U+2028, U+3000 are dropped; zero-width space around → refused (information)', async ({ page }) => {
    await openSettings(page);
    for (const [pre, post] of [[' ', ' '], ['\u00a0', '\u00a0'], ['\t', '\r\n'], ['\n\n', '\n'], ['\ufeff', ''], ['\u2028', '\u3000']]) {
      await field(page, 'api-key').fill(`${pre}${KEY}${post}`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message'), JSON.stringify(pre + post)).toHaveText(/^Ключът е з\u0430п\u0430зен/);
      expect(await storedKey(page)).toBe(KEY);
    }
    // U+200B is not \s in JS: a zero-width space at the start of a paste is refused (not trimmed).
    await field(page, 'api-key').fill(`\u200b${KEY2}`);
    await field(page, 'key-save').click();
    // T053-I3 (information): it is refused, but with the "starts with sk-ant-" message (the prefix check comes first).
    await expect(field(page, 'key-message')).toHaveText(/непозволени знаци|започва със/);
    console.log(`T-053 U+200B before the key → "${await field(page, 'key-message').textContent()}"`);
    expect(await storedKey(page)).toBe(KEY);
  });

  test('length: 19 / 20 / 400 / 401 and a 200 000-character paste (no hang, nothing echoed)', async ({ page }) => {
    await openSettings(page);
    const tail = (n) => 'a'.repeat(n);
    const tryKey = async (k) => { await field(page, 'api-key').fill(k); await field(page, 'key-save').click(); await page.waitForTimeout(100); return field(page, 'key-message').textContent(); };
    expect(await tryKey(`sk-ant-${tail(12)}`)).toMatch(/дължин\u0430т\u0430/);
    expect(await tryKey(`sk-ant-${tail(13)}`)).toMatch(/^Ключът е з\u0430п\u0430зен/);
    expect(await tryKey(`sk-ant-${tail(393)}`)).toMatch(/^Ключът е з\u0430п\u0430зен/);
    expect(await tryKey(`sk-ant-${tail(394)}`)).toMatch(/дължин\u0430т\u0430/);
    const t0 = Date.now();
    expect(await tryKey(`sk-ant-test-FAKE-${tail(200000)}`)).toMatch(/дължин\u0430т\u0430/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await field(page, 'key-message').textContent()).not.toContain('aaaa');
  });

  test('the mask of a hand-stored key: short → dots only; HTML in the last 4 characters is text, not markup', async ({ page }) => {
    for (const [stored, mask] of [['sk-ant-1', '••••'], ['x', '••••'], ['sk-ant-test-FAKE-<img src=x onerror="window.__x=1">', '•••• =1">'], ['sk-ant-test-FAKE-0000<b>', '•••• 0<b>']]) {
      await page.evaluate(async (k) => (await import('./src/db.js')).saveApiKey(k), stored);
      await openSettings(page);
      await expect(field(page, 'key-status')).toHaveText(`З\u0430п\u0430зен ключ: ${mask}`);
      expect(await page.locator('[data-screen="settings"] img, [data-screen="settings"] b').count()).toBe(0);
      expect(await page.evaluate(() => window.__x)).toBeUndefined();
      await page.goto('./#/');
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I3 fix: lesson data never reaches the app console', () => {
  test('every lrn:* type with key-like invalid fields, links with the key in path/host/query, a 2 KB link, unknown types', async ({ page }) => {
    const K = 'sk-ant-test-FAKE-lesson-typed-0000';
    const bad = { 'lrn:ready': { title: K.repeat(20) }, 'lrn:size': { height: K }, 'lrn:selection': { text: K, rects: K }, 'lrn:tap': { annotationId: K.repeat(4) },
      'lrn:anchored': { results: K }, 'lrn:layout': { items: K, height: K }, 'lrn:position': { top: K }, 'lrn:anchor': { top: K }, 'lrn:link': { href: { K } }, 'lrn:fonts-ok': { loaded: K },
      'lrn:hello': { v: K }, 'lrn:violation': { v: K }, [`lrn:${K}`]: {}, 'lrn:link ': { href: K } };
    const links = [`https://example.org/${K}`, `https://${K.toLowerCase()}.example/`, `https://example.org/?k=${K}#${K}`, `mailto:${K}@example.org`,
      `javascript:alert('${K}')`, `${K}`, `https://example.org/${'x'.repeat(1900)}${K}`, `data:text/plain,${K}`, `x-${K}:y`];
    const code = `var B=${js(bad)};for(var t in B){var m=B[t];m.lrn=1;m.type=t;if(!('v' in m))m.v=1;parent.postMessage(m,'*')}`
      + `var L=${js(links)};L.forEach(function(h){parent.postMessage({lrn:1,v:1,type:'lrn:link',href:h},'*')});`
      + `parent.postMessage({lrn:1,v:1,type:'lrn:link',href:${js(K)},extra:${js(K)}},'*');parent.postMessage(${js(K)},'*');parent.postMessage({lrn:${js(K)}},'*');`;
    await importCourse(page, 'LRN-LOG', { 'INDEX.md': strToU8('# LRN-LOG\n'), 'lessons/0001-g.html': lesson(code) });
    await open(page, 'LRN-LOG');
    await page.waitForTimeout(1500);
    const app = logs.filter((l) => l.includes('EasyLRN'));
    console.log(`T-053 app console lines about the lesson: ${app.length}\n${app.slice(0, 30).join('\n')}`);
    expect(app.length).toBeGreaterThan(0);
    // Not only "FAKE": no part of the typed text at all.
    expect(logs.filter((l) => !/^(log|info|warning|error): (T-0|\[lesson\])/.test(l)).filter((l) => /lesson-typed|example\.org|alert\(/.test(l))).toEqual([]);
  });

  test('render notes: an external URL with a key in it in the lesson source is not written as it is', async ({ page }) => {
    const K = 'sk-ant-test-FAKE-in-source-0000';
    const body = `<img src="https://example.org/${K}.png"><link rel="stylesheet" href="https://${K.toLowerCase()}.example/x.css"><script src="https://example.org/a.js?k=${K}"></script><img src="../assets/${K}.png">`;
    await importCourse(page, 'LRN-LOG2', { 'INDEX.md': strToU8('# LRN-LOG2\n'), 'lessons/0001-g.html': doc(body) });
    await open(page, 'LRN-LOG2');
    await page.waitForTimeout(800);
    const app = logs.filter((l) => /EasyLRN/.test(l));
    console.log(`T-053 render notes: ${app.join(' | ').slice(0, 1500)}`);
    const kept = app.some((l) => /FAKE-in-source/.test(l));
    logs = logs.filter((l) => !/\.\.\/assets\/sk-ant-test-FAKE-in-source/.test(l)); // a course-relative file name: static course content (T-052 log), kept
    expect(app.filter((l) => /https?:\/\/[^ ]*in-source|in-source[^ ]*\.example/i.test(l))).toEqual([]);
    expect(logs.filter((l) => /EasyLRN/.test(l)).join('\n')).not.toContain('FAKE');
    console.log(`T-053 course-relative path with key-like text kept in the notes: ${kept}`);
  });
});

// ---------------------------------------------------------------------------
test.describe('the key field after T-052', () => {
  test('no password field, no form; masked by default; "Пок\u0430жи" works; the key never in an attribute; paste works', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSettings(page);
    const input = field(page, 'api-key');
    expect(await page.locator('input[type=password], form').count()).toBe(0);
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveAttribute('autocomplete', 'off');
    expect(await input.getAttribute('name')).toBeNull();
    const sec = () => input.evaluate((el) => getComputedStyle(el).webkitTextSecurity);
    expect(await sec()).toBe('disc');
    // paste through the clipboard
    await page.evaluate((k) => navigator.clipboard.writeText(`  ${k}\n`), KEY);
    await input.focus();
    await page.keyboard.press('Control+V');
    await expect(input).toHaveValue(new RegExp(KEY));
    const attrs = () => page.evaluate(() => [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`)).join('\n'));
    expect(await attrs()).not.toContain('FAKE');
    await field(page, 'key-show').click();
    expect(await sec()).toBe('none');
    expect(await attrs()).not.toContain('FAKE');
    // copy out of the field (selected text) works while shown
    await input.selectText();
    await page.keyboard.press('Control+C');
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(KEY);
    await field(page, 'key-show').click();
    expect(await sec()).toBe('disc');
    // Enter in the field submits nothing (no form) and does not save by itself
    await input.press('Enter');
    expect(await page.locator('input[type=password], form').count()).toBe(0);
    await field(page, 'key-save').click();
    await expect(field(page, 'key-status')).toHaveText(`З\u0430п\u0430зен ключ: •••• ${KEY.slice(-4)}`);
    await expect(input).toHaveValue('');
    expect(await sec()).toBe('disc');
    expect(await attrs()).not.toContain('FAKE');
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('FAKE');
    expect(await page.locator('input[type=password], form').count()).toBe(0);
  });
});
