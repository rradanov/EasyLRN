// T-072 (tester): tests of T-071 (0.14.3), written "as an attacker".
// - S: the new `lrn:keys-port` (the MessagePort of the guard in the lesson): can the
//   lesson take the port, forge one, switch the guard off or learn when the user types
//   a note? (listeners / prototypes replaced before or after the guard, the capture
//   phase on window / document, document.open(), a reload, a navigation, about:blank,
//   javascript: URLs, many documents, many lrn:hello); S2 — no message of the lesson
//   closes or switches the guarded note.
// - D: the kept copies `lrn-note-pending:<place>` (two tabs, many notes, the old single
//   key); an emptied note + a fast reload → soft delete with "Върни", no silent loss.
// Known defects: test.fail(true, 'T072-…'). Synthetic data only, no network (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 150000 });
test.use({ trace: 'off' });

let problems;
let external;
let allow; // expected console errors / warnings of a test
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  allow = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (problems.length) console.log('PROBLEMS', JSON.stringify(problems.slice(0, 8)));
  expect(problems.filter((p) => !allow.some((r) => r.test(p)))).toEqual([]);
  expect(external).toEqual([]);
});
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value) });

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const C = 'LRN-T72';
const L1 = `${C}/lesson:0001`;
const LONG = Array.from({ length: 30 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
const BODY = '<p id="p1">Регламентът за киберустойчивост се прилага за продукти.</p><p id="p2">Производителят оценява рисковете през жизнения цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>';
const files = (script = '') => ({
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n`,
  'lessons/0001-parvi.html': lessonHtml('Първи', `${script}${BODY}${LONG}`),
});

async function start(page) {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push(e.data); });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}
async function importCourse(page, script = '') {
  const f = asFile(`${C}.zip`, makeZip(toBytes(files(script)), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: f.name, bytes: [...f.buffer] });
  expect(r).not.toMatch(/^ERROR/);
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page) {
  const hash = `#/c/${C}/read/0001`;
  await page.evaluate(() => { window.__lrn = []; });
  if (new URL(page.url()).hash === hash) await page.reload();
  else await page.goto(`./${hash}`);
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
const notesOf = (page) => db(page, async (db) => (await db.list('notes', { includeDeleted: true })).map((n) => ({ id: n.id, annotationId: n.annotationId, body: n.body, deleted: !!n.deleted })));
const liveNotes = async (page) => (await notesOf(page)).filter((n) => !n.deleted);
const annotations = (page) => db(page, async (db, id) => (await db.annotationsFor({ type: 'lesson', id }, { includeDeleted: true }))
  .map((a) => ({ id: a.id, exact: a.selector.quote.exact, deleted: !!a.deleted, color: a.color })), L1);
const liveAnn = async (page) => (await annotations(page)).filter((a) => !a.deleted);

async function select(page, needle) {
  const frame = await lessonFrame(page);
  await page.evaluate(() => { window.__lrn = window.__lrn.filter((m) => m.type !== 'lrn:selection'); });
  await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      n.parentElement.scrollIntoView({ block: 'center' });
      return;
    }
    throw new Error(`not found: ${needle}`);
  }, needle);
  await expect.poll(() => page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:selection' && !m.empty).length), { timeout: 3000 }).toBeGreaterThan(0);
}
/** Page coordinates of `needle` in the lesson (scrolled into view). */
async function textBox(page, needle) {
  const frame = await lessonFrame(page);
  const rel = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      const b = r.getClientRects()[0];
      return { left: b.left, top: b.top, height: b.height, width: b.width };
    }
    throw new Error(`not found: ${needle}`);
  }, needle);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return { x: box.x + rel.left + 4, y: box.y + rel.top + rel.height / 2, left: box.x + rel.left, right: box.x + rel.left + rel.width, top: box.y + rel.top, bottom: box.y + rel.top + rel.height };
}
/** Page coordinates of an element of the lesson (scrolled into view). */
async function elBox(page, id) {
  const frame = await lessonFrame(page);
  const r = await frame.evaluate((id) => { const e = document.getElementById(id); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 }; }, id);
  const box = await page.locator('iframe.lesson-frame').boundingBox();
  return { x: box.x + r.x, y: box.y + r.y };
}
const newNote = (page) => page.locator('[data-action="new-note"]');
const quick = (page) => page.locator('[data-action="new-note-quick"]');
const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const noteStatus = (page) => page.locator('[data-field="note-status"]');
const noteMarks = (page) => page.locator('[data-field="notes-marks"] .notes-strip__mark');
const strip = (page) => page.locator('[data-field="notes-strip"]');
const frameEl = (page) => page.locator('iframe.lesson-frame');
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

async function openNewNote(page, needle) {
  await select(page, needle);
  if (await newNote(page).isVisible()) await newNote(page).click();
  else await quick(page).click();
  await expect(noteText(page)).toBeFocused();
}
async function writeNote(page, needle, text) {
  await openNewNote(page, needle);
  await noteText(page).pressSequentially(text, { delay: 2 });
  await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
}
/** Typing as a user does: keys (ASCII, Cyrillic) and an IME composition (Android keyboards compose every word). */
async function typeAll(page, ascii, cyr) {
  await page.keyboard.type(ascii, { delay: 35 });
  await page.keyboard.type(cyr, { delay: 35 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'дум', selectionStart: 3, selectionEnd: 3 });
  await page.waitForTimeout(30);
  await cdp.send('Input.imeSetComposition', { text: 'дума', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(30);
  await cdp.send('Input.insertText', { text: 'дума' });
  await cdp.detach();
}

// A lesson that records everything it gets: keys, input, composition, clipboard,
// drops (to window.__keys and as "LK:" lines in the console, which survive a
// reload of the lesson), every message from the app (window.__msgs), the values of
// every editable thing it has (window.__vals()).
const SPY = `<input id="v1" aria-label="v1"><div id="ce" contenteditable="true">ред</div><p id="plain">обикновен текст тук</p>
<a id="ln" href="#p3" onclick="window.__clicks = (window.__clicks || 0) + 1; return false;">връзка в урока</a>
<dialog id="dg"><input id="dv" aria-label="dv"></dialog><div id="pp" popover><input id="pv" aria-label="pv"></div>
<div id="host"></div><template id="tp"><input id="tv" aria-label="tv"></template>
<script>
  window.__keys = '';
  window.__msgs = [];
  // T-071 (T070-S1): the app no longer tells the lesson (the keys go to the guard over
  // a port the lesson never sees); the lesson can only probe: is designMode refused?
  Object.defineProperty(window, '__off', { get() { const was = document.designMode; document.designMode = 'on'; const on = document.designMode === 'on'; document.designMode = was; return !on; } });
  const log = (e) => {
    const d = e.type === 'drop' ? (e.dataTransfer && e.dataTransfer.getData('text')) : (e.key || e.data || '');
    window.__keys += e.type[0] + d + ' ';
    if (e.type === 'input' || e.type === 'drop' || e.type === 'paste' || e.type === 'compositionend') console.log('LK:' + (d || ''));
  };
  for (const t of ['keydown', 'beforeinput', 'input', 'compositionupdate', 'compositionend', 'paste', 'drop', 'dragenter']) document.addEventListener(t, log, false);
  window.__vals = () => [...document.querySelectorAll('input, textarea')].map((x) => x.value).join('|') + '|' + document.getElementById('ce').textContent
    + '|' + (window.__sr ? [...window.__sr.querySelectorAll('input,[contenteditable]')].map((x) => x.value || x.textContent).join('|') : '');
  addEventListener('message', (e) => {
    try { window.__msgs.push(JSON.stringify(e.data)); } catch (err) { window.__msgs.push('?'); }
  });
</script>`;
const leakedBy = (page) => {
  const out = [];
  page.on('console', (m) => { if (m.text().startsWith('LK:')) out.push(m.text().slice(3)); });
  return out;
};

// A lesson that wants the port: whatever it gets is logged as "LP:" lines (the
// console survives a new document of the lesson) and kept in window.__got.
// `steal` is how it tries; `afterGo` runs once it has the port (or tried).
const thief = (steal) => `${SPY}<script>
  window.__got = { ports: 0, offs: [], keysMsgs: 0 };
  window.__hook = (where) => (e) => {
    try {
      const d = e.data;
      if (d && typeof d === 'object' && /lrn:keys/.test(String(d.type))) { window.__got.keysMsgs++; console.log('LP:msg:' + where + ':' + d.type); }
      const ps = e.ports || [];
      for (const p of ps) {
        window.__got.ports++;
        console.log('LP:port:' + where);
        p.onmessage = (m) => { window.__got.offs.push(m.data && m.data.off); console.log('LP:off:' + JSON.stringify(m.data)); if (m.data && m.data.off === true) window.__stealKeys(); };
      }
    } catch (err) { /* */ }
  };
  window.__stealKeys = () => {
    if (window.__stealing) return;
    window.__stealing = true;
    const i = document.getElementById('v1') || document.body.appendChild(Object.assign(document.createElement('input'), { id: 'v1' }));
    const t = setInterval(() => { try { i.focus(); document.designMode = 'on'; if (document.designMode === 'on' && !window.__designSaid) { window.__designSaid = true; console.log('LP:design'); } document.designMode = 'off'; } catch (err) { /* */ } }, 5);
    setTimeout(() => { clearInterval(t); window.__stealing = false; }, 8000);
  };
  window.__relog = () => {
    const log = (e) => { const d = e.key || e.data || ''; window.__keys = (window.__keys || '') + e.type[0] + d + ' '; if (e.type === 'input' || e.type === 'compositionend' || e.type === 'paste') console.log('LK:' + d); };
    for (const t of ['keydown', 'beforeinput', 'input', 'compositionend', 'paste']) { document.addEventListener(t, log, true); window.addEventListener(t, log, true); }
  };
  (${steal})();
</script>`;
const portLog = (page) => {
  const out = [];
  page.on('console', (m) => { if (m.text().startsWith('LP:')) out.push(m.text().slice(3)); });
  return out;
};
/** A note exists; it is opened from its 📝 (app side, no message of the lesson needed) and typed into. */
async function openExistingAndType(page, text) {
  await expect(noteMarks(page)).toHaveCount(1, { timeout: 8000 });
  await noteMarks(page).first().click();
  await expect(panel(page)).toBeVisible();
  if (!(await noteText(page).evaluate((t) => t === document.activeElement))) await noteText(page).click();
  await expect(noteText(page)).toBeFocused();
  await noteText(page).press('End');
  await page.waitForTimeout(150);
  await typeAll(page, text.ascii, text.cyr);
  await page.waitForTimeout(400);
}

test.describe('T072-S the port of the guard (lrn:keys-port) vs the lesson', () => {
  test('T072-S1 document.open() (not locked like document.write) erases every listener of the window, the guard\'s too; the lesson then says lrn:hello itself and takes the app\'s next port: it must not get the port, not learn { off }, and no character of the note may reach it', async ({ page }) => {
    const STEAL = `() => {
      window.__go = () => {
        const keep = document.body.innerHTML;
        document.open();
        const html = document.createElement('html'); document.appendChild(html);
        const body = document.createElement('body'); html.appendChild(body);
        body.innerHTML = keep;
        window.__relog();
        addEventListener('message', window.__hook('window'), true);
        document.addEventListener('message', window.__hook('document'), true);
        parent.postMessage({ lrn: 1, type: 'lrn:hello', v: 1 }, '*');
        console.log('LP:opened');
      };
    }`;
    const leaked = leakedBy(page);
    const got = portLog(page);
    await start(page);
    await importCourse(page, thief(STEAL));
    let frame = await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Стара бележка');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await frame.evaluate(() => window.__go());
    await page.waitForTimeout(600);
    await openExistingAndType(page, { ascii: 'abcdefghijklmnopqrstuvwxyz', cyr: 'ТАЙНАбележка' });
    const value = await noteText(page).inputValue();
    const seen = await frame.evaluate(() => ({ got: window.__got, keys: window.__keys || '', v: (document.getElementById('v1') || {}).value }));
    info('T072-S1', { got, leaked: leaked.join(''), seen, value });
    console.log('S1', JSON.stringify({ got, leaked: leaked.join(''), seen, value }));
    test.fail(true, 'T072-S1: document.open() is not locked (only write/writeln are): it erases every listener of the window, the guard\'s message listener and its key listeners too; the lesson then posts lrn:hello itself, the app sends a fresh lrn:keys-port and closes the guard\'s port: the LESSON gets the port, hears { off: true } when the user types a note (the guard never hears it again: focus() / designMode work), takes the focus and gets characters that are missing from the note');
    expect(got.filter((g) => g.startsWith('port') || g.startsWith('off'))).toEqual([]);
    expect(leaked.join('')).toBe('');
    expect(value).toBe('Стара бележкаabcdefghijklmnopqrstuvwxyzТАЙНАбележкадума');
  });
});

test.describe('T072-S the port of the guard: more ways', () => {
  test('T072-S2 the lesson replaces what the guard uses — before the guard (a script ahead of the doctype) and after it: addEventListener, onmessage, capture listeners on window / document, MessagePort.prototype, MessageEvent.prototype getters, Event.prototype.stopImmediatePropagation / isTrusted, Reflect.apply / Function.prototype.call — then asks for new ports (lrn:hello) while the note is typed: no port, no { off }, the guard stays on, no character', async ({ page }) => {
    const EARLY = `<script>
      window.__early = [];
      try { addEventListener('message', (e) => { window.__early.push(e.data && e.data.type); if (e.ports && e.ports.length) console.log('LP:port:early'); }, true); } catch (err) { /* */ }
    </script>`;
    const STEAL = `() => {
      const hook = window.__hook;
      const origAdd = EventTarget.prototype.addEventListener;
      // After the guard: every listener the lesson can put anywhere.
      addEventListener('message', hook('window-capture'), true);
      addEventListener('message', hook('window-bubble'));
      document.addEventListener('message', hook('document'), true);
      window.onmessage = hook('onmessage');
      try { EventTarget.prototype.addEventListener = function (t, f, o) { if (t === 'message') { const g = f; f = function (e) { hook('wrapped')(e); return g.apply(this, arguments); }; } return origAdd.call(this, t, f, o); }; } catch (err) { console.log('LP:err:add'); }
      try { Event.prototype.stopImmediatePropagation = function () { console.log('LP:stop-called'); }; } catch (err) { /* */ }
      try { Event.prototype.stopPropagation = function () {}; } catch (err) { /* */ }
      try { Object.defineProperty(Event.prototype, 'isTrusted', { get() { return true; } }); } catch (err) { console.log('LP:err:isTrusted'); }
      for (const name of ['ports', 'data', 'source', 'origin']) {
        try {
          const d = Object.getOwnPropertyDescriptor(MessageEvent.prototype, name);
          Object.defineProperty(MessageEvent.prototype, name, { configurable: true, get() { const v = d.get.call(this); if (name === 'ports' && v && v.length) { for (const p of v) { console.log('LP:port:getter'); hook('getter')({ data: {}, ports: [p] }); } } return v; } });
        } catch (err) { console.log('LP:err:' + name); }
      }
      try {
        const P = MessagePort.prototype;
        const st = P.start, ad = P.addEventListener || origAdd;
        P.start = function () { console.log('LP:port:start'); try { this.onmessage = (m) => console.log('LP:off:' + JSON.stringify(m.data)); } catch (err) { /* */ } return st.call(this); };
        P.addEventListener = function (t, f, o) { console.log('LP:port:add'); origAdd.call(this, t, (m) => console.log('LP:off:' + JSON.stringify(m.data)), o); return ad.call(this, t, f, o); };
        P.close = function () { console.log('LP:port:close'); };
        Object.defineProperty(P, 'onmessage', { configurable: true, set(f) { console.log('LP:port:onmessage'); }, get() { return null; } });
      } catch (err) { console.log('LP:err:port'); }
      try { const ra = Reflect.apply; Reflect.apply = function (f, t, a) { if (t instanceof MessagePort || (a && a[0] instanceof MessagePort)) console.log('LP:port:reflect'); return ra(f, t, a); }; } catch (err) { /* */ }
      try { const ca = Function.prototype.call; Function.prototype.call = function (t, ...a) { if (t instanceof MessagePort) console.log('LP:port:call'); return ca.apply(this, [t, ...a]); }; } catch (err) { /* */ }
      window.__ask = () => parent.postMessage({ lrn: 1, type: 'lrn:hello', v: 1 }, '*');
      setInterval(() => { if (window.__armed) window.__ask(); }, 120);
      setInterval(() => { if (window.__armed && window.__off) window.__stealKeys(); }, 20);
    }`;
    const leaked = leakedBy(page);
    const got = portLog(page);
    await start(page);
    // The script ahead of the doctype: the renderer / the SW put the guard first anyway.
    const f = files(thief(STEAL));
    f['lessons/0001-parvi.html'] = EARLY + f['lessons/0001-parvi.html'];
    const zip = asFile(`${C}.zip`, makeZip(toBytes(f), { root: C }));
    expect(await page.evaluate(async ({ name, bytes }) => { const m = await import('./src/course-import.js'); try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; } }, { name: zip.name, bytes: [...zip.buffer] })).not.toMatch(/^ERROR/);
    const frame = await openLesson(page);
    const order = await frame.evaluate(() => [...document.scripts].map((s) => s.dataset.easylrn || (s.textContent.includes('__early') ? 'early' : 'lesson')).slice(0, 3));
    await frame.evaluate(() => { window.__armed = true; });
    await page.waitForTimeout(400);
    await openNewNote(page, 'оценява рисковете');
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(true);
    await typeAll(page, 'abcdefghijklmnopqrstuvwxyz', 'ТАЙНАбележка');
    await page.waitForTimeout(400);
    const value = await noteText(page).inputValue();
    const early = await frame.evaluate(() => window.__early);
    await frame.evaluate(() => { window.__armed = false; });
    info('T072-S2', { order, got: [...new Set(got)], early: [...new Set(early)], leaked: leaked.join(''), value });
    expect(order[0]).toBe('guard');
    expect(early).not.toContain('lrn:keys-port');
    // (port:onmessage = the bridge's own scheduler channel, not the guard's port)
    expect(got.filter((g) => /^(port:(?!onmessage)|off|msg|design)/.test(g))).toEqual([]);
    expect(leaked.join('')).toBe('');
    expect(value).toBe('abcdefghijklmnopqrstuvwxyzТАЙНАбележкадума');
  });

  // Each way gives the frame a new document (or tries to): the new document gets its own
  // guard and its own port; a document without the guard must never get a port.
  const NAVS = [
    ['location.reload()', `() => location.reload()`],
    ['the same URL with ?x (a new document)', `() => { location.href = location.pathname + '?x=' + Date.now(); }`],
    ['about:blank', `() => { location.href = 'about:blank'; }`],
    ['a javascript: URL that returns a page (a document the SW never served: no guard)', `() => { location.href = 'javascript:"<input id=v1><script>' + ${JSON.stringify('addEventListener("message",(e)=>{if(e.ports&&e.ports.length){console.log("LP:port:js");e.ports[0].onmessage=(m)=>{console.log("LP:off:"+JSON.stringify(m.data));if(m.data.off)setInterval(()=>document.getElementById("v1").focus(),5);};}},true);addEventListener("input",(e)=>console.log("LK:"+e.data),true);parent.postMessage({lrn:1,type:"lrn:hello",v:1},"*");console.log("LP:js-doc");')} + '<\\/script>"'; }`],
    ['history.pushState + popstate (no new document)', `() => { history.pushState({}, '', '#p3'); history.back(); }`],
  ];
  for (const [name, code] of NAVS) {
    test(`T072-S3 a new document of the frame while the note is typed — ${name}: no document of the lesson gets a port or { off }; no character leaves the note`, async ({ page }) => {
      allow.push(/Failed to load resource|lesson|Урокът/i);
      const leaked = leakedBy(page);
      const got = portLog(page);
      const STEAL = `() => {
        addEventListener('message', window.__hook('window'), true);
        console.log('LP:doc:' + (location.search ? 'q' : '') + document.scripts.length);
        setInterval(() => { if (window.__off && !window.__went) { window.__went = true; console.log('LP:go'); setTimeout(${code}, 150); } }, 20);
        setInterval(() => { if (window.__off) window.__stealKeys(); }, 20);
      }`;
      await start(page);
      await importCourse(page, thief(STEAL));
      await openLesson(page);
      await openNewNote(page, 'оценява рисковете');
      for (let i = 0; i < 4; i++) { await page.keyboard.type(`ТАЙНА${i}secret`, { delay: 30 }); await page.waitForTimeout(100); }
      await page.waitForTimeout(600);
      const value = await noteText(page).inputValue().catch(() => null);
      const state = await page.evaluate(() => ({ st: document.querySelector('[data-lesson-state]')?.dataset.lessonState, stopped: document.querySelector('[data-lesson-stopped]') ? 'yes' : 'no' }));
      info('T072-S3', { name, got: [...new Set(got)], leaked: leaked.join(''), value, state });
      console.log('S3', name, JSON.stringify({ got: [...new Set(got)], leaked: leaked.join(''), value, state }));
      expect(got).toContain('go');
      expect(got.filter((g) => /^(port|off|design)/.test(g))).toEqual([]);
      expect(leaked.join('')).toBe('');
      expect(value).toBe(Array.from({ length: 4 }, (_, i) => `ТАЙНА${i}secret`).join(''));
    });
  }

  test('T072-S4 a flood of lrn:hello (a new port for every one) while the note is typed: the guard always holds the newest port — the keys stay off the whole time (designMode refused at every probe), nothing leaks, the lesson is not stopped', async ({ page }) => {
    const leaked = leakedBy(page);
    const STEAL = `() => {
      window.__probes = { on: 0, off: 0 };
      setInterval(() => { if (!window.__armed) return; for (let i = 0; i < 3; i++) parent.postMessage({ lrn: 1, type: 'lrn:hello', v: 1 }, '*'); }, 50);
      setInterval(() => { if (!window.__armed) return; if (window.__off) window.__probes.off++; else window.__probes.on++; try { document.getElementById('v1').focus(); } catch (e) {} }, 7);
    }`;
    await start(page);
    await importCourse(page, thief(STEAL));
    const frame = await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(true);
    await frame.evaluate(() => { window.__armed = true; });
    await page.keyboard.type('ТАЙНАнаводнение1234567890', { delay: 40 });
    await page.waitForTimeout(300);
    const probes = await frame.evaluate(() => { window.__armed = false; return window.__probes; });
    const value = await noteText(page).inputValue();
    info('T072-S4', { probes, leaked: leaked.join(''), value });
    expect(probes.on, 'a probe found the guard off while the note was typed').toBe(0);
    expect(probes.off).toBeGreaterThan(20);
    expect(leaked.join('')).toBe('');
    expect(value).toBe('ТАЙНАнаводнение1234567890');
    await expect(page.locator('[data-lesson-stopped]')).toHaveCount(0);
  });
});

test.describe('T072-S5 no message of the lesson closes or switches the guarded note', () => {
  // Lesson 0002 takes the focus from its first moment (if the app ever goes there while the user types).
  const SECOND = `${SPY}<script>setInterval(() => { try { document.getElementById('v1').focus(); } catch (e) {} }, 5); console.log('LP:second');</script>`;
  const two = (script) => ({
    'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
    'lessons/0001-parvi.html': lessonHtml('Първи', `${script}${BODY}${LONG}`),
    'lessons/0002-vtori.html': lessonHtml('Втори', `${SECOND}<p>Втори урок, само текст.</p>`),
  });
  const SENDERS = {
    'lrn:escape': `() => parent.postMessage({ lrn: 1, type: 'lrn:escape' }, '*')`,
    "lrn:tap (the other note's place, a mark, null)": `() => { for (const id of window.__ids.concat([null])) parent.postMessage({ lrn: 1, type: 'lrn:tap', annotationId: id }, '*'); }`,
    "lrn:link to lesson 0002 (the user's keys are a user activation of the app)": `() => parent.postMessage({ lrn: 1, type: 'lrn:link', href: new URL('0002-vtori.html', location.href).href }, '*')`,
    'lrn:link to the same lesson #p3, lrn:anchor': `() => { parent.postMessage({ lrn: 1, type: 'lrn:link', href: location.href.split('#')[0] + '#p3' }, '*'); parent.postMessage({ lrn: 1, type: 'lrn:anchor', top: 5 }, '*'); }`,
    'lrn:selection of another place, then empty': `() => { parent.postMessage({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'Уязвимостите', prefix: '', suffix: '' }, position: { start: 120, end: 132 }, rect: { top: 10, bottom: 30 } }, '*'); parent.postMessage({ lrn: 1, type: 'lrn:selection', empty: true }, '*'); }`,
    'lrn:hello, lrn:ready, lrn:size, lrn:position, an unknown lrn:close / lrn:note / lrn:undo': `() => { for (const m of [{ type: 'lrn:hello', v: 1 }, { type: 'lrn:ready', v: 1, title: 'x', textLength: 10 }, { type: 'lrn:size', height: 200 }, { type: 'lrn:position', top: 0 }, { type: 'lrn:close' }, { type: 'lrn:note', off: false }, { type: 'lrn:undo' }, { type: 'lrn:keys', off: false }]) parent.postMessage(Object.assign({ lrn: 1 }, m), '*'); }`,
  };
  for (const [name, code] of Object.entries(SENDERS)) {
    test(`T072-S5 ${name} — sent every 40 ms while the guarded note is typed: the same note stays open, the field keeps the focus and every character, nothing reaches any lesson`, async ({ page }) => {
      allow.push(/EasyLRN|lesson|Урок/i);
      const leaked = leakedBy(page);
      const got = portLog(page);
      const STEAL = `() => {
        window.__ids = [];
        addEventListener('message', (e) => { if (e.data && e.data.type === 'lrn:annotations' && Array.isArray(e.data.annotations)) window.__ids = e.data.annotations.map((a) => a.id); });
        setInterval(() => { if (!window.__armed || !window.__off) return; try { (${code})(); } catch (err) { console.log('LP:err:' + err); } document.getElementById('v1').focus(); }, 40);
      }`;
      await start(page);
      const zip = asFile(`${C}.zip`, makeZip(toBytes(two(thief(STEAL))), { root: C }));
      expect(await page.evaluate(async ({ name, bytes }) => { const m = await import('./src/course-import.js'); try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; } }, { name: zip.name, bytes: [...zip.buffer] })).not.toMatch(/^ERROR/);
      await openLesson(page);
      // Another note and a mark (targets of a forged tap).
      await writeNote(page, 'Уязвимостите се докладват', 'Друга');
      await page.locator('[data-action="note-done"]').click();
      await expect(panel(page)).toBeHidden();
      await select(page, 'обикновен текст');
      await page.locator('[data-field="mark-tools"] [data-color="green"]').click();
      await expect.poll(async () => (await liveAnn(page)).length).toBe(2);
      await page.keyboard.press('Escape');
      await (await lessonFrame(page)).evaluate(() => { window.__armed = true; });
      await openNewNote(page, 'оценява рисковете');
      const url = page.url();
      for (let i = 0; i < 5; i++) { await page.keyboard.type(`ТАЙНА${i}x`, { delay: 45 }); }
      await page.waitForTimeout(500);
      const now = await page.evaluate(() => { const ta = document.querySelector('[data-field="note-text"]'); const p = document.querySelector('[data-field="notes-panel"]'); return { open: !!p && !p.hidden && p.getBoundingClientRect().width > 0, quote: document.querySelector('[data-field="note-quote"]')?.textContent ?? null, focused: !!ta && ta === document.activeElement, value: ta ? ta.value : null, active: document.activeElement?.tagName }; });
      const res = { url: page.url() === url, ...now, leaked: leaked.join(''), second: got.includes('second') };
      info('T072-S5', { name, ...res });
      res.saved = (await liveNotes(page)).map((n) => n.body).sort();
      console.log('S5', name, JSON.stringify(res));
      if (name.startsWith('lrn:link to lesson 0002')) test.fail(true, 'T072-S2: lrn:link from the lesson is obeyed while the note field is guarded — the keys the user types into the note are a user activation of the app (navigator.userActivation.isActive), so a lesson that sends lrn:link to another lesson of its course (it can tell the note is typed: designMode is refused, T072-I1) closes the note and the app goes to that lesson; the user\'s next keys land in the page / the next lesson');
      expect(res.url, 'still in lesson 0001').toBe(true);
      expect(res.open).toBe(true);
      expect(res.quote).toContain('оценява рисковете');
      expect(res.focused).toBe(true);
      expect(res.value).toBe('ТАЙНА0xТАЙНА1xТАЙНА2xТАЙНА3xТАЙНА4x');
      expect(res.leaked).toBe('');
      await page.locator('[data-action="note-done"]').click({ timeout: 5000 });
      await expect.poll(async () => (await liveNotes(page)).map((n) => n.body).sort()).toEqual(['Друга', 'ТАЙНА0xТАЙНА1xТАЙНА2xТАЙНА3xТАЙНА4x']);
    });
  }
});

// ===========================================================================
test.describe('T072-D the kept copies "lrn-note-pending:<place>" and the emptied note', () => {
  const twoLessons = () => ({
    'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи |\n| 0002 | Втори |\n`,
    'lessons/0001-parvi.html': lessonHtml('Първи', `${BODY}${LONG}`),
    'lessons/0002-vtori.html': lessonHtml('Втори', `<p id="q1">Вторият урок говори за доклади.</p><p id="q2">Сроковете са кратки.</p>${LONG}`),
  });
  test.beforeEach(async ({ page }) => {
    await start(page);
    const zip = asFile(`${C}.zip`, makeZip(toBytes(twoLessons()), { root: C }));
    expect(await page.evaluate(async ({ name, bytes }) => { const m = await import('./src/course-import.js'); try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; } }, { name: zip.name, bytes: [...zip.buffer] })).not.toMatch(/^ERROR/);
  });
  const openL = async (page, n) => {
    await page.evaluate(() => { window.__lrn = []; });
    const hash = `#/c/${C}/read/${n}`;
    if (new URL(page.url()).hash === hash) await page.reload(); else await page.goto(`./${hash}`);
    await waitReady(page);
    await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  };
  /** The copies the page keeps when it goes (read at once, before the database drops them). */
  const keepNow = (page) => page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    return Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('lrn-note-pending')).map((k) => [k, JSON.parse(localStorage.getItem(k))]));
  });
  const keys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lrn-note-pending')).sort());
  const putAll = (page, entries) => page.evaluate((e) => { for (const [k, v] of e) localStorage.setItem(k, JSON.stringify(v)); }, entries);
  const done = async (page) => { await page.locator('[data-action="note-done"]').click(); await expect(panel(page)).toBeHidden(); };

  test('T072-D1 many notes of two "tabs" die at once — an edited note (n:), a new note on a mark (a:), a new note on a selection (s:) in two lessons, plus the old single key of 0.14.2 for a fourth: every text is written at the next start, once, no duplicate, no key left', async ({ page }) => {
    await openL(page, '0001');
    await writeNote(page, 'оценява рисковете', 'Първа');
    await done(page);
    await writeNote(page, 'Уязвимостите се докладват', 'Четвърта');
    await done(page);
    const notes = await liveNotes(page);
    const first = notes.find((n) => n.body === 'Първа');
    const fourth = notes.find((n) => n.body === 'Четвърта');
    // (n:) the first note edited; the page dies before the database has it.
    await noteMarks(page).first().click();
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' + редакция', { delay: 2 });
    const k1 = Object.entries(await keepNow(page)).find(([k]) => k.startsWith('lrn-note-pending:n:'));
    expect(k1).toBeTruthy();
    await done(page);
    // (a:) a mark, a new note on it.
    await select(page, 'се прилага за продукти');
    await page.locator('[data-field="mark-tools"] [data-color="blue"]').click();
    await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === 'blue').length).toBe(1);
    await page.keyboard.press('Escape');
    const t = await textBox(page, 'се прилага за продукти');
    await page.mouse.click(t.x + 10, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('На синята', { delay: 2 });
    const k2 = Object.entries(await keepNow(page)).find(([k]) => k.startsWith('lrn-note-pending:a:'));
    expect(k2).toBeTruthy();
    await done(page);
    // (s:) a new note on a selection of lesson 0002 ("tab B").
    await openL(page, '0002');
    await openNewNote(page, 'Сроковете са кратки');
    await noteText(page).pressSequentially('Втори урок', { delay: 2 });
    const k3 = Object.entries(await keepNow(page)).find(([k]) => k.startsWith('lrn-note-pending:s:'));
    expect(k3).toBeTruthy();
    await done(page);
    // The database rolled back to before those writes (the tabs died): remove what they made.
    await db(page, async (db, ids) => { for (const n of await db.list('notes', { includeDeleted: true })) if (!ids.includes(n.id)) await db.purge('notes', n.id); }, [first.id, fourth.id]);
    await db(page, (db, id) => db.update('notes', id, { body: 'Първа' }), first.id);
    const before = (await liveNotes(page)).map((n) => n.body).sort();
    expect(before).toEqual(['Първа', 'Четвърта']);
    await putAll(page, [k1, k2, k3, ['lrn-note-pending', { courseId: C, lessonId: L1, draft: { noteId: fourth.id }, body: 'Четвърта + стар ключ', at: Date.now() }]].map(([k, v]) => [k, { ...v, at: v.at || Date.now() }]));
    await page.reload();
    await waitReady(page);
    await expect.poll(() => keys(page), { timeout: 6000 }).toEqual([]);
    const bodies = (await liveNotes(page)).map((n) => n.body).sort();
    info('T072-D1', { before, bodies });
    expect(bodies).toEqual(['Втори урок', 'На синята', 'Първа + редакция', 'Четвърта + стар ключ'].sort());
  });

  test('T072-D2 two tabs: A dies with copies of two notes, B (alive) saves a third note and edits one of A\'s notes after A kept it: B\'s save drops only the copy of its own place, A\'s other copy survives and wins at the next start; B\'s newer text of the shared note is not overwritten by A\'s older copy', async ({ page, context }) => {
    await openL(page, '0001');
    await writeNote(page, 'оценява рисковете', 'X');
    await done(page);
    await writeNote(page, 'Уязвимостите се докладват', 'Y');
    await done(page);
    const [x, y] = ['X', 'Y'];
    const notes = await liveNotes(page);
    const nx = notes.find((n) => n.body === x);
    const ny = notes.find((n) => n.body === y);
    const at = Date.now() - 5000; // A kept 5 s ago
    await putAll(page, [
      [`lrn-note-pending:n:${nx.id}`, { courseId: C, lessonId: L1, draft: { noteId: nx.id }, body: 'X от А', at }],
      [`lrn-note-pending:n:${ny.id}`, { courseId: C, lessonId: L1, draft: { noteId: ny.id }, body: 'Y от А', at }],
    ]);
    // B (this running page: no start since A died): a third note, then Y edited in B (newer than A's copy).
    await writeNote(page, 'се прилага за продукти', 'Z от Б');
    await done(page);
    const yMark = page.locator('[data-field="notes-marks"] .notes-strip__mark');
    // Open Y (the last 📝 in the text: p3).
    const count = await yMark.count();
    let opened = false;
    for (let i = 0; i < count && !opened; i++) {
      if (await panel(page).isVisible()) await done(page);
      await yMark.nth(i).click();
      opened = (await noteText(page).inputValue()) === 'Y';
    }
    expect(opened).toBe(true);
    await noteText(page).press('End');
    await noteText(page).pressSequentially(' от Б', { delay: 2 });
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    await done(page);
    const left = await keys(page);
    const other = await context.newPage();
    await other.goto(`./#/c/${C}/read/0001`);
    await waitReady(other);
    await expect.poll(() => other.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lrn-note-pending')).length), { timeout: 6000 }).toBe(0);
    const bodies = (await liveNotes(other)).map((n) => n.body).sort();
    info('T072-D2', { left, bodies });
    expect(left).toEqual([`lrn-note-pending:n:${nx.id}`]);
    expect(bodies).toEqual(['X от А', 'Y от Б', 'Z от Б'].sort());
    await other.close();
  });

  test('T072-D3 an older copy never wins: the same place kept twice — the 0.14.2 single key (older) and "n:" (newer) of one note; "s:" (older, a new note on a selection) and "n:" (newer) of the note made on that same selection: the newer text is the one left', async ({ page }) => {
    await openL(page, '0001');
    await writeNote(page, 'оценява рисковете', 'Начало');
    await done(page);
    const n = (await liveNotes(page))[0];
    const now = Date.now();
    await putAll(page, [
      ['lrn-note-pending', { courseId: C, lessonId: L1, draft: { noteId: n.id }, body: 'старо (0.14.2)', at: now - 60000 }],
      [`lrn-note-pending:n:${n.id}`, { courseId: C, lessonId: L1, draft: { noteId: n.id }, body: 'ново', at: now - 1000 }],
    ]);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => keys(page), { timeout: 6000 }).toEqual([]);
    const a = (await liveNotes(page)).map((x) => x.body);
    // A new note on a selection kept by tab A ("s:", older), the same place got a note in tab B, kept newer ("n:").
    await openNewNote(page, 'Уязвимостите се докладват');
    await noteText(page).pressSequentially('А', { delay: 2 });
    const sKept = Object.entries(await keepNow(page)).find(([k]) => k.startsWith('lrn-note-pending:s:'));
    expect(sKept).toBeTruthy();
    await expect(noteStatus(page)).toHaveText('Записано.', { timeout: 6000 });
    await done(page);
    const made = (await liveNotes(page)).find((x) => x.body === 'А');
    await putAll(page, [
      [sKept[0], { ...sKept[1], body: 'по-старо от А', at: now - 30000 }],
      [`lrn-note-pending:n:${made.id}`, { courseId: C, lessonId: L1, draft: { noteId: made.id }, body: 'по-ново от Б', at: now - 500 }],
    ]);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => keys(page), { timeout: 6000 }).toEqual([]);
    const b = (await liveNotes(page)).map((x) => x.body).sort();
    info('T072-D3', { a, b });
    console.log('D3', JSON.stringify({ a, b }));
    if (a.includes('старо (0.14.2)') || b.includes('по-старо от А')) test.fail(true, 'T072-D3: flushPendingNote writes the kept copies in the order of the localStorage keys, never by their time (`at`): two copies of ONE place under two keys — the 0.14.2 single key and "n:<id>", or "s:<lesson>:<start>-<end>" of a new note and "n:<id>" of the note made on that same place — the one written last wins, also when it is the older text');
    expect(a).toEqual(['ново']);
    expect(b).toEqual(['ново', 'по-ново от Б'].sort());
  });

  test('T072-D4 two existing notes emptied when the page goes (one in lesson 0001, one in 0002 — two tabs, or one after the other): both are deleted softly at the next start and EACH lesson offers "Върни"; no empty live note; nothing lost without a way back', async ({ page }) => {
    await openL(page, '0001');
    await writeNote(page, 'оценява рисковете', 'Важно едно');
    await done(page);
    await openL(page, '0002');
    await writeNote(page, 'Сроковете са кратки', 'Важно две');
    await done(page);
    const all = await liveNotes(page);
    const one = all.find((n) => n.body === 'Важно едно');
    const two = all.find((n) => n.body === 'Важно две');
    const L2 = `${C}/lesson:0002`;
    await putAll(page, [
      [`lrn-note-pending:n:${one.id}`, { courseId: C, lessonId: L1, draft: { noteId: one.id }, body: '', at: Date.now() - 2000 }],
      [`lrn-note-pending:n:${two.id}`, { courseId: C, lessonId: L2, draft: { noteId: two.id }, body: '  \n ', at: Date.now() - 1000 }],
    ]);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => keys(page), { timeout: 6000 }).toEqual([]);
    const after = await notesOf(page);
    expect(after.filter((n) => !n.deleted && !n.body.trim())).toEqual([]);
    expect(after.filter((n) => n.deleted).map((n) => n.body).sort()).toEqual(['Важно едно', 'Важно две'].sort());
    const undo2 = await page.locator('[data-action="undo-note-delete"]').isVisible({ timeout: 3000 }).catch(() => false);
    if (undo2) { await page.locator('[data-action="undo-note-delete"]').click(); }
    await openL(page, '0001');
    await page.waitForTimeout(800);
    const undo1 = await page.locator('[data-action="undo-note-delete"]').isVisible();
    if (undo1) await page.locator('[data-action="undo-note-delete"]').click();
    await page.waitForTimeout(500);
    const live = (await liveNotes(page)).map((n) => n.body).sort();
    info('T072-D4', { undo1, undo2, live });
    if (!(undo1 && undo2)) test.fail(true, 'T072-D1: the emptied note for "Върни" is ONE localStorage key (lrn-note-emptied): when two existing notes were emptied as the page went (two tabs, two lessons), both are soft-deleted at the next start but only the last one is offered "Върни"; the other is deleted with no way back in the app (it stays deleted in the database)');
    expect(undo1 && undo2).toBe(true);
    expect(live).toEqual(['Важно едно', 'Важно две'].sort());
  });

  test('T072-D5 an emptied note + a fast reload, "Върни" NOT pressed: the note stays deleted (no empty 📝), "Върни" is offered once only (not again after another reload); emptied by spaces only counts as empty; an emptied note whose lesson is opened after a week is no longer offered', async ({ page }) => {
    await openL(page, '0001');
    await writeNote(page, 'оценява рисковете', 'Пазен текст');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('   ');
    await keepNow(page);
    await page.reload();
    await waitReady(page);
    await expect(page.locator('[data-action="undo-note-delete"]')).toBeVisible({ timeout: 5000 });
    await expect(noteMarks(page)).toHaveCount(0);
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(800);
    await expect(page.locator('[data-action="undo-note-delete"]')).toBeHidden();
    const all = await notesOf(page);
    expect(all.filter((n) => !n.deleted)).toEqual([]);
    expect(all.map((n) => n.body)).toEqual(['Пазен текст']);
    // A week-old "emptied" entry is not offered.
    await page.evaluate(() => localStorage.setItem('lrn-note-emptied', JSON.stringify({ lessonId: 'x', entry: { noteId: 'x' }, at: Date.now() - 8 * 864e5 })));
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(500);
    await expect(page.locator('[data-action="undo-note-delete"]')).toBeHidden();
  });
});
