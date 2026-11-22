// T-070 (tester): tests of T-069 (0.14.1) and T-069b (0.14.2), written "as an attacker".
// - S: the new `lrn:keys` of the guard in the lesson and the protection of an open
//   note: a lesson that forges the parent's message (a synthetic MessageEvent), closes
//   the note itself (lrn:escape), tries rare ways to take the focus (dialog / popover
//   focus restore, window.find, a fragment, autofocus, a live Range, a shadow root, a
//   template, a fresh realm, fullscreen, IME composition, drag & drop) or reloads
//   itself; the app's localStorage from the lesson; the transparent layer; the lesson
//   works normally again after the note closes (its input, a link, a selection, a mark).
// - D: the text kept at pagehide / visibilitychange / beforeunload (D3): no second
//   note, an emptied note, a deleted note, two tabs, 20 000 characters, a full /
//   missing localStorage.
// - O: "Ориентация на екрана" with screen.orientation mocked (a lock that succeeds,
//   is refused, never answers, is aborted by the next one; no unlock; no API).
// - L: the 0.14.2 layout: the note column never over the lesson (1920×1200, 1280×800,
//   1200×1920, 800×1280; 160 % text), no sideways scroll; a phone (< 600 px, also
//   rotated with the note open): only the 📝 column, the note over the whole window.
// Known defects: test.fail(true, 'T070-…'). Synthetic data only, no network (D-026).
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
const C = 'LRN-T70';
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

// ===========================================================================
test.describe('T070-S the keys of an open note vs the lesson (lrn:keys, the layer)', () => {
  test('T070-S1 a lesson forges the parent\'s "lrn:keys" { off: false } as a synthetic MessageEvent (source: parent, origin: the app\'s) the moment it hears { off: true }, then calls focus() every 5 ms: the guard must stay on and no character may reach the lesson', async ({ page }) => {
    // T-071: the lesson no longer hears { off: true }; armed by the test once the guard is on,
    // it forges every 5 ms: a synthetic "lrn:keys" { off: false }, a synthetic "lrn:keys-port"
    // with a port of its own (then "off: false" on it), designMode, focus().
    const THIEF = `${SPY}<script>
      window.__design = null;
      setInterval(() => {
        if (!window.__armed) return;
        try {
          const ch = new MessageChannel();
          dispatchEvent(new MessageEvent('message', { source: parent, origin: location.origin, data: { lrn: 1, type: 'lrn:keys-port' }, ports: [ch.port2] }));
          ch.port1.postMessage({ off: false });
        } catch (err) { /* */ }
        dispatchEvent(new MessageEvent('message', { source: parent, origin: location.origin, data: { lrn: 1, type: 'lrn:keys', off: false } }));
        window.postMessage({ lrn: 1, type: 'lrn:keys', off: false }, '*');
        document.designMode = 'on'; if (document.designMode === 'on') window.__design = 'on'; document.designMode = 'off';
        document.getElementById('v1').focus();
      }, 5);
    </script>`;
    const leaked = leakedBy(page);
    await start(page);
    await importCourse(page, THIEF);
    const frame = await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(true);
    await frame.evaluate(() => { window.__armed = true; });
    await page.waitForTimeout(200);
    await typeAll(page, 'abcdefghijklmnopqrstuvwxyz0123456789', 'ТАЙНАбележкаЗаУрока');
    await page.waitForTimeout(400);
    const seen = await frame.evaluate(() => ({ design: window.__design, keys: window.__keys, vals: window.__vals() }));
    const value = await noteText(page).inputValue();
    info('T070-S1', { seen, leaked: leaked.join(''), value });
    await frame.evaluate(() => { window.__armed = false; });
    // T-071: fixed (the keys over a MessagePort taken only from a trusted event of the parent): test.fail removed.
    expect(seen.design).not.toBe('on');
    expect(leaked.join('')).toBe('');
    expect(value).toBe('abcdefghijklmnopqrstuvwxyz0123456789ТАЙНАбележкаЗаУрокадума');
  });

  test('T070-S2 a lesson closes the open note itself (lrn:escape — or lrn:tap on each place it knows — sent 300 ms after it hears { off: true }) and takes the focus: the note must stay open and the user\'s next keys must not reach the lesson', async ({ page }) => {
    const THIEF = `${SPY}<script>
      window.__mode = 'none';
      window.__ids = [];
      window.__fired = false;
      addEventListener('message', (e) => {
        if (!e.isTrusted || !e.data) return;
        if (e.data.type === 'lrn:annotations' && Array.isArray(e.data.annotations)) window.__ids = e.data.annotations.map((a) => a.id);
      });
      // T-071: the lesson no longer hears { off: true }: it probes the guard (designMode refused) every 50 ms.
      setInterval(() => {
        if (window.__mode === 'none' || window.__fired || !window.__off) return;
        window.__fired = true;
        setTimeout(() => {
          if (window.__mode === 'none') return;
          if (window.__mode === 'escape') parent.postMessage({ lrn: 1, type: 'lrn:escape' }, '*');
          else window.__ids.forEach((id, k) => setTimeout(() => parent.postMessage({ lrn: 1, type: 'lrn:tap', annotationId: id }, '*'), k * 60));
          for (let i = 0; i < 200; i++) setTimeout(() => document.getElementById('v1').focus(), i * 10);
        }, 300);
      }, 50);
    </script>`;
    const leaked = leakedBy(page);
    await start(page);
    await importCourse(page, THIEF);
    let frame = await openLesson(page);
    // An earlier note (its place is the target of the forged tap).
    await writeNote(page, 'Уязвимостите се докладват', 'Стара');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    const out = {};
    for (const mode of ['escape', 'tap']) {
      frame = await lessonFrame(page);
      await frame.evaluate((m) => { window.__mode = m; window.__keys = ''; window.__fired = false; }, mode);
      leaked.length = 0;
      await openNewNote(page, 'оценява рисковете');
      await page.keyboard.type('ТАЙНАнов', { delay: 60 });
      await page.waitForTimeout(500);
      const open = await panel(page).isVisible();
      const field = open && await noteText(page).isVisible() ? await noteText(page).inputValue() : null;
      out[mode] = { open, field, leaked: leaked.join(''), vals: (await frame.evaluate(() => window.__vals())).split('|')[0] };
      await frame.evaluate(() => { document.getElementById('v1').value = ''; });
      if (await panel(page).isVisible()) { await page.locator('[data-action="note-done"]').click(); await expect(panel(page)).toBeHidden(); }
      await page.waitForTimeout(300);
    }
    info('T070-S2', out);
    // T-071: fixed (no message of the lesson closes a guarded note): test.fail removed; the note stays open.
    for (const r of Object.values(out)) expect(r.open).toBe(true);
    for (const r of Object.values(out)) { expect(r.leaked).toBe(''); expect(r.vals).toBe(''); }
  });

  // Rare ways to the focus, one after another while the note is typed; each with
  // its own words, so a leak says which one it was. Some need a state made before
  // the note opens (a modal dialog / a popover holding the focus, a shadow root).
  const PREP = `() => {
    const sr = document.getElementById('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<div contenteditable="true">сянка</div><input aria-label="s">';
    window.__sr = sr;
    document.getElementById('dg').showModal(); document.getElementById('dv').focus();
  }`;
  const VECTORS = [
    ['dialog.close() restores the focus', `() => document.getElementById('dg').close()`],
    ['hidePopover() restores the focus', `() => { const p = document.getElementById('pp'); p.hidePopover(); }`],
    ['window.find() of a text in an input', `() => { document.getElementById('v1').value = 'ЗКЛЮЧЗ'; window.find('ЗКЛЮЧЗ'); document.getElementById('v1').value = ''; }`],
    ['location.hash to an input', `() => { location.hash = '#v1'; }`],
    ['a new <input autofocus>', `() => { const i = document.createElement('input'); i.autofocus = true; i.id = 'af'; document.body.prepend(i); }`],
    ['a live Range of the selection moved into contenteditable', `() => { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(document.getElementById('plain')); s.removeAllRanges(); s.addRange(r); s.getRangeAt(0).setStart(document.getElementById('ce').firstChild, 1); s.getRangeAt(0).collapse(true); }`],
    ['a range from plain text into contenteditable', `() => { const s = getSelection(); const r = document.createRange(); r.setStart(document.getElementById('plain').firstChild, 0); r.setEnd(document.getElementById('ce').firstChild, 1); s.removeAllRanges(); s.addRange(r); }`],
    ['Selection.collapse(shadowRoot)', `() => { getSelection().collapse(window.__sr, 0); }`],
    ['focus() of a contenteditable in a shadow root', `() => window.__sr.querySelector('[contenteditable]').focus()`],
    ['an <input> from a <template>', `() => { const i = document.importNode(document.getElementById('tp').content, true).firstElementChild; document.body.prepend(i); i.focus(); }`],
    ['setSelectionRange / setRangeText', `() => { const i = document.getElementById('v1'); i.setSelectionRange(0, 0); i.setRangeText(''); }`],
    ['focus() from a fresh realm (window.open)', `() => { const w = window.open('about:blank'); if (w) w.HTMLElement.prototype.focus.call(document.getElementById('v1')); }`],
    ['requestFullscreen()', `() => { document.documentElement.requestFullscreen?.().catch(() => {}); }`],
    ['execCommand / scrollIntoView / a synthetic FocusEvent', `() => { document.execCommand('selectAll'); document.getElementById('v1').scrollIntoView(); document.getElementById('ce').dispatchEvent(new FocusEvent('focus')); }`],
    ['navigator.clipboard.readText()', `() => { navigator.clipboard?.readText?.().then((t) => console.log('LK:clip:' + t), () => {}); }`],
    ['speech (webkitSpeechRecognition)', `() => { try { const R = window.webkitSpeechRecognition || window.SpeechRecognition; if (R) { const r = new R(); r.onresult = (e) => console.log('LK:speech'); r.start(); } } catch (e) {} }`],
  ];
  test('T070-S3 rare ways to take the focus (dialog / popover focus restore, window.find, a fragment, autofocus, a live Range, shadow roots, a template, a fresh realm, fullscreen, clipboard, speech) while the user types keys and IME compositions: nothing reaches the lesson, the note has it all', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // The browser's own refusals (the sandbox / permissions policy) are logged as errors: expected here.
    allow.push(/Blocked autofocusing|Blocked opening|Permissions policy violation|clipboard|speech/i);
    const leaked = leakedBy(page);
    await start(page);
    await importCourse(page, SPY);
    const frame = await openLesson(page);
    await frame.evaluate(`(${PREP})()`);
    await page.evaluate(() => {}); // the dialog of the lesson holds its focus now
    await openNewNote(page, 'оценява рисковете');
    await expect.poll(() => frame.evaluate(() => window.__off)).toBe(true);
    // A popover holding the focus too (shown while the guard is on: refused) — try it the other way as well.
    const out = [];
    let expected = '';
    for (const [i, [name, code]] of VECTORS.entries()) {
      await frame.evaluate(() => { window.__keys = ''; });
      const before = leaked.length;
      let err = null;
      try { await frame.evaluate(`(${code})()`); } catch (e) { err = String(e).slice(0, 120); }
      await page.waitForTimeout(120);
      const has = await frame.evaluate(() => document.hasFocus());
      await page.keyboard.type(`k${i}Т`, { delay: 25 });
      expected += `k${i}Т`;
      const keys = await frame.evaluate(() => window.__keys);
      out.push({ name, err, has, keys, leaked: leaked.slice(before).join('') });
    }
    await typeAll(page, '', '');
    expected += 'дума';
    await page.waitForTimeout(300);
    const vals = await frame.evaluate(() => window.__vals());
    info('T070-S3', out.filter((r) => r.has || r.keys || r.leaked || r.err));
    expect(out.filter((r) => r.has || r.keys || r.leaked)).toEqual([]);
    expect(leaked.join('')).toBe('');
    expect(vals).not.toMatch(/k\d|Т|дума/);
    await expect(noteText(page)).toHaveValue(expected);
    expect(await page.evaluate(() => window.__lrn.filter((m) => m.type === 'lrn:violation').length)).toBe(0);
  });

  test('T070-S4 a lesson that reloads itself every 400 ms and calls focus() from the first moment of every new document (before the app can say { off: true } again): no character reaches any of its documents', async ({ page }) => {
    const leaked = leakedBy(page);
    const notFound = [];
    page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
    const RELOADER = `${SPY}<script>
      if (location.hash === '#steal') { setInterval(() => document.getElementById('v1').focus(), 3); setTimeout(() => location.reload(), 400); }
      // T-071: no message says { off: true } to the lesson now; it probes the guard instead.
      setInterval(() => { if (location.hash !== '#steal' && window.__off) { location.hash = '#steal'; location.reload(); } }, 50);
    </script>`;
    await start(page);
    await importCourse(page, RELOADER);
    await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    for (let i = 0; i < 6; i++) { await page.keyboard.type(`ТАЙНА${i}secret`, { delay: 30 }); }
    await page.waitForTimeout(500);
    const value = await noteText(page).inputValue().catch(() => null);
    const state = await page.evaluate(() => ({ st: document.querySelector('[data-lesson-state]')?.dataset.lessonState, frames: document.querySelectorAll('iframe').length, tab: document.querySelector('iframe.lesson-frame')?.getAttribute('tabindex'), layer: !!document.querySelector('[data-field="note-guard"]') }));
    info('T070-S4', { leaked: leaked.join(''), value, state, notFound: [...new Set(notFound)] });
    console.log('S4', JSON.stringify({ state, notFound: [...new Set(notFound)] }));
    allow.push(/Failed to load resource: the server responded with a status of 404/);
    expect(leaked.join('')).toBe('');
    expect(value).toBe(Array.from({ length: 6 }, (_, i) => `ТАЙНА${i}secret`).join(''));
  });

  test('T070-S5 the lesson cannot read the app\'s storage (localStorage with "lrn-note-pending", sessionStorage, IndexedDB, cookies, caches, BroadcastChannel, storage events); no message to the lesson carries the text of the note, also at pagehide / visibilitychange', async ({ page }) => {
    const PROBE = `${SPY}<script>
      window.__store = {};
      const t = (name, f) => { try { const v = f(); window.__store[name] = v === undefined ? 'undefined' : String(v).slice(0, 80); } catch (e) { window.__store[name] = 'ERR ' + e.name; } };
      window.__probe = async () => {
        t('localStorage', () => localStorage.getItem('lrn-note-pending'));
        t('sessionStorage', () => sessionStorage.length);
        t('cookie', () => document.cookie);
        t('origin', () => origin);
        t('caches', () => typeof caches);
        try { await new Promise((res, rej) => { const r = indexedDB.open('easylrn'); r.onsuccess = () => res(r.result.objectStoreNames.length); r.onerror = () => rej(r.error); }).then((n) => { window.__store.idb = 'opened ' + n; }); } catch (e) { window.__store.idb = 'ERR ' + (e && e.name); }
        try { const k = await caches.keys(); window.__store.cacheKeys = k.length; } catch (e) { window.__store.cacheKeys = 'ERR ' + (e && e.name); }
        return window.__store;
      };
      window.__bc = [];
      try { for (const n of ['easylrn', 'lrn', 'notes', 'easylrn-notes']) { const b = new BroadcastChannel(n); b.onmessage = (e) => window.__bc.push(JSON.stringify(e.data)); } } catch (e) { window.__bc.push('ERR ' + e.name); }
      addEventListener('storage', (e) => window.__bc.push('storage ' + e.key));
    </script>`;
    await start(page);
    await importCourse(page, PROBE);
    const frame = await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    await noteText(page).pressSequentially('ТАЙНАнаЛокално', { delay: 5 });
    // The page "goes" (visibilitychange → hidden, pagehide): the text is kept in localStorage.
    const kept = await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      // T-071 (T070-D3): one key per note / draft.
      return Object.keys(localStorage).filter((k) => k.startsWith('lrn-note-pending')).map((k) => localStorage.getItem(k)).join('\n');
    });
    expect(kept).toContain('ТАЙНАнаЛокално');
    const store = await frame.evaluate(() => window.__probe());
    const msgs = await frame.evaluate(() => window.__msgs);
    const bc = await frame.evaluate(() => window.__bc);
    info('T070-S5', { store, bc, types: [...new Set(msgs.map((m) => JSON.parse(m).type))] });
    expect(store.localStorage).toMatch(/^ERR/);
    expect(store.sessionStorage).toMatch(/^ERR/);
    expect(store.origin).toBe('null');
    expect(store.idb).toMatch(/^ERR/);
    expect(JSON.stringify(store)).not.toContain('ТАЙНА');
    expect(bc.filter((x) => !/^ERR/.test(x))).toEqual([]);
    expect(msgs.join('\n')).not.toContain('ТАЙНА');
    // The note's message to the lesson is `lrn:keys` only (no text in it).
    expect(msgs.filter((m) => /lrn:keys/.test(m)).every((m) => Object.keys(JSON.parse(m)).sort().join() === 'lrn,off,type')).toBe(true);
    // T-071 (T070-S1, I1): the keys go over a port the guard hides: the lesson sees no "lrn:keys*" at all.
    expect(msgs.filter((m) => /lrn:keys/.test(m))).toEqual([]);
  });

  test('T070-S6 the transparent layer covers the whole lesson while the field has the focus (every point over the frame is the app\'s); a first tap on a link of the lesson only leaves the field, the second works; text dragged from the note onto the lesson never lands there; after the note closes the lesson works as before (its field, its link, a selection, a mark)', async ({ page }) => {
    const leaked = leakedBy(page);
    await start(page);
    await importCourse(page, `${SPY}<div class="quiz" data-quiz="{}"><p>Въпрос от теста.</p><input id="qa" aria-label="отговор"></div>`);
    const frame = await openLesson(page);
    await openNewNote(page, 'оценява рисковете');
    await noteText(page).pressSequentially('ТАЙНАзаВлачене', { delay: 5 });
    // Every point over the frame is the layer of the app.
    const fb = await frameEl(page).boundingBox();
    const vh = page.viewportSize().height;
    const pts = [];
    for (const fx of [0.02, 0.5, 0.98]) for (const fy of [0.02, 0.5, 0.98]) {
      const x = fb.x + fb.width * fx;
      const y = Math.min(vh - 2, Math.max(2, fb.y + Math.min(fb.height, vh) * fy));
      pts.push(await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e?.dataset?.field || e?.tagName; }, [x, y]));
    }
    info('T070-S6 points over the frame', pts);
    expect(pts.filter((p) => p === 'IFRAME')).toEqual([]);
    const layer = await page.locator('[data-field="note-guard"]').boundingBox();
    expect(layer.x).toBeLessThanOrEqual(fb.x + 1);
    expect(layer.x + layer.width).toBeGreaterThanOrEqual(fb.x + fb.width - 1);
    // Drag the note's text onto the lesson.
    await noteText(page).focus();
    await page.keyboard.press('Control+A');
    const ta = await noteText(page).boundingBox();
    const target = await elBox(page, 'v1');
    await page.mouse.move(ta.x + 20, ta.y + 12);
    await page.mouse.down();
    await page.mouse.move(ta.x + 40, ta.y + 14, { steps: 3 });
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const afterDrag = await frame.evaluate(() => ({ keys: window.__keys, vals: window.__vals() }));
    info('T070-S6 drag', afterDrag);
    expect(afterDrag.vals).not.toContain('ТАЙНА');
    expect(leaked.join('')).not.toContain('ТАЙНА');
    // Back in the field; a tap on the lesson's link: the first only leaves the field.
    await noteText(page).focus();
    await expect(frameEl(page)).toHaveAttribute('data-note-guard', 'on');
    const link = await elBox(page, 'ln');
    await page.mouse.click(link.x, link.y);
    await expect(frameEl(page)).not.toHaveAttribute('data-note-guard', 'on');
    expect(await frame.evaluate(() => window.__clicks || 0)).toBe(0);
    await page.mouse.click(link.x, link.y);
    await expect.poll(() => frame.evaluate(() => window.__clicks || 0)).toBe(1);
    // Close the note: the lesson is the lesson again.
    await page.locator('[data-action="note-done"]').click();
    await expect(panel(page)).toBeHidden();
    await page.waitForTimeout(200);
    expect(await frame.evaluate(() => window.__off)).toBe(false);
    const qa = await elBox(page, 'qa');
    await page.mouse.click(qa.x, qa.y);
    await page.keyboard.type('отговор 42', { delay: 15 });
    await expect.poll(() => frame.evaluate(() => document.getElementById('qa').value)).toBe('отговор 42');
    const ce = await elBox(page, 'ce');
    await page.mouse.click(ce.x, ce.y);
    await page.keyboard.press('End');
    await page.keyboard.type('X', { delay: 15 });
    await expect.poll(() => frame.evaluate(() => document.getElementById('ce').textContent)).toContain('X');
    await page.mouse.click(link.x, link.y);
    await expect.poll(() => frame.evaluate(() => window.__clicks || 0)).toBe(2);
    // A selection by the mouse (a real drag over the text) → "Бележка"; a mark.
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.evaluate(() => { window.__lrn = []; });
    await page.mouse.move(t.left + 2, t.y);
    await page.mouse.down();
    await page.mouse.move(t.right - 2, t.y, { steps: 8 });
    await page.mouse.up();
    await expect(newNote(page)).toBeVisible({ timeout: 3000 });
    await page.locator('[data-field="mark-tools"] [data-color="yellow"]').click();
    await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === 'yellow').length, { timeout: 5000 }).toBe(1);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['ТАЙНАзаВлачене']);
  });
});

// ===========================================================================
test.describe('T070-D the text kept when the page goes (T018-D3 fix)', () => {
  test.beforeEach(async ({ page }) => { await start(page); await importCourse(page); });
  const goAway = (page) => page.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    // T-071 (T070-D3): one key per note / draft ("lrn-note-pending:<place>"); the newest copy.
    const all = Object.keys(localStorage).filter((k) => k === 'lrn-note-pending' || k.startsWith('lrn-note-pending:')).map((k) => JSON.parse(localStorage.getItem(k)));
    return all.sort((a, b) => b.at - a.at)[0] || null;
  });
  // Every kept copy (null: none).
  const kill = (page) => page.evaluate(() => { const v = Object.keys(localStorage).filter((k) => k === 'lrn-note-pending' || k.startsWith('lrn-note-pending:')).map((k) => localStorage.getItem(k)); return v.length ? v.join('\n') : null; });

  test('T070-D1 beforeunload + pagehide + visibilitychange together, for a new note on a selection and on a mark, the kept copy left over as if the page died after the save: one note each, the last text', async ({ page }) => {
    await openLesson(page);
    // A new note on a selection: the three events at once, then the kept copy put back (the page died before it was dropped).
    await openNewNote(page, 'оценява рисковете');
    await noteText(page).pressSequentially('Три събития', { delay: 2 });
    const k1 = await goAway(page);
    expect(k1?.body).toBe('Три събития');
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body), { timeout: 5000 }).toEqual(['Три събития']);
    await page.evaluate((k) => localStorage.setItem('lrn-note-pending', JSON.stringify(k)), k1);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => kill(page), { timeout: 5000 }).toBeNull();
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Три събития']);
    expect((await liveAnn(page)).length).toBe(1);
    // A new note on a mark (draft { annotationId }).
    await select(page, 'Уязвимостите се докладват');
    await page.locator('[data-field="mark-tools"] [data-color="green"]').click();
    await expect.poll(async () => (await liveAnn(page)).filter((a) => a.color === 'green').length).toBe(1);
    await page.keyboard.press('Escape');
    const t = await textBox(page, 'Уязвимостите се докладват');
    await page.mouse.click(t.x + 20, t.y);
    await page.locator('[data-action="add-note-to-mark"]').click();
    await noteText(page).pressSequentially('На маркировка', { delay: 2 });
    const k2 = await goAway(page);
    expect(k2?.draft?.annotationId || k2?.draft?.noteId).toBeTruthy();
    await expect.poll(async () => (await liveNotes(page)).length, { timeout: 5000 }).toBe(2);
    await page.evaluate((k) => localStorage.setItem('lrn-note-pending', JSON.stringify(k)), k2);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => kill(page), { timeout: 5000 }).toBeNull();
    expect((await liveNotes(page)).map((n) => n.body).sort()).toEqual(['На маркировка', 'Три събития']);
    await expect(noteMarks(page)).toHaveCount(2, { timeout: 8000 });
  });

  test('T070-D2 an existing note emptied (select all + delete) and the tab reloaded at once: the old text is not silently replaced by an empty note (a closed empty note is deleted with "Върни", D-045)', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Важен текст');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await goAway(page);
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(800);
    const all = await notesOf(page);
    info('T070-D2', all.map((n) => [n.body, n.deleted]));
    const emptyLive = all.filter((n) => !n.deleted && !n.body.trim());
    // T-071: fixed — as a note closed empty: deleted at the start, "Върни" brings the old text back. test.fail removed.
    expect(emptyLive).toEqual([]);
    expect(all.filter((n) => n.deleted).map((n) => n.body)).toEqual(['Важен текст']);
    await expect(page.locator('[data-action="undo-note-delete"]')).toBeVisible();
    await page.locator('[data-action="undo-note-delete"]').click();
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body), { timeout: 5000 }).toEqual(['Важен текст']);
  });

  test('T070-D3 two tabs: tab A dies with its last words kept (not yet in the database), tab B saves ANOTHER note before A is opened again: A\'s words must not be dropped', async ({ page, context }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Бележка А');
    await page.keyboard.press('Escape');
    const noteA = (await liveNotes(page))[0];
    // Tab A "died" right after keeping its text (its database write never ran).
    await page.evaluate(({ id, L1, C }) => localStorage.setItem('lrn-note-pending', JSON.stringify({ courseId: C, lessonId: L1, draft: { noteId: id }, body: 'Бележка А + последни думи', at: Date.now() })), { id: noteA.id, L1, C });
    // Tab B is open since before (no start since A died) and the user writes another note there.
    const b = page; // the same running page plays tab B: no flush at a start
    await writeNote(b, 'Уязвимостите се докладват', 'Бележка Б');
    await b.keyboard.press('Escape');
    const left = await b.evaluate(() => localStorage.getItem('lrn-note-pending'));
    const other = await context.newPage();
    await other.goto(`./#/c/${C}/read/0001`);
    await waitReady(other);
    await other.waitForTimeout(800);
    const bodies = (await liveNotes(other)).map((n) => n.body).sort();
    info('T070-D3', { left, bodies });
    const lost = !bodies.includes('Бележка А + последни думи');
    void lost; // T-071: fixed (one key per note: a save of another note keeps A's copy). test.fail removed.
    expect(bodies).toEqual(['Бележка Б', 'Бележка А + последни думи'].sort());
    await other.close();
  });

  test('T070-D4 a note deleted ("Изтрий") right after typing, then the tab closed: it stays deleted (no kept copy brings it back); 20 000 characters kept and written whole; 25 000 pasted → 20 000 and the hint', async ({ page }) => {
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'За триене');
    await noteText(page).pressSequentially(' още', { delay: 2 });
    await page.locator('[data-action="delete-note"]').click();
    await expect(page.locator('[data-action="undo-note-delete"]')).toBeVisible();
    await goAway(page);
    expect(await kill(page)).toBeNull();
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(600);
    expect(await liveNotes(page)).toEqual([]);
    // 20 000 characters, reloaded at once.
    await openNewNote(page, 'Уязвимостите се докладват');
    const big = 'ж'.repeat(19990);
    await noteText(page).evaluate((ta, v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); }, big);
    await noteText(page).press('End');
    await noteText(page).pressSequentially('0123456789ABC', { delay: 2 });
    await expect(page.locator('[data-field="note-status"]')).toContainText('20');
    const k = await goAway(page);
    expect(k.body.length).toBe(20000);
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body.length), { timeout: 6000 }).toEqual([20000]);
    expect((await liveNotes(page))[0].body.endsWith('0123456789')).toBe(true);
  });

  test('T070-D5 localStorage full (setItem throws QuotaExceededError) or missing (the getter throws): the app starts, the note is still saved by the database, no error', async ({ page, context }) => {
    await openLesson(page);
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
    await openNewNote(page, 'оценява рисковете');
    await noteText(page).pressSequentially('Пълно хранилище', { delay: 2 });
    await goAway(page);
    await expect.poll(async () => (await liveNotes(page)).map((n) => n.body), { timeout: 5000 }).toEqual(['Пълно хранилище']);
    const p2 = await context.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(String(e)));
    p2.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p2.addInitScript(() => { if (window.top === window) Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } }); });
    await p2.goto(`./#/c/${C}/read/0001`);
    await waitReady(p2);
    await expect(p2.locator('[data-field="notes-marks"] .notes-strip__mark')).toHaveCount(1, { timeout: 8000 });
    await p2.locator('[data-field="notes-marks"] .notes-strip__mark').first().click();
    await p2.locator('[data-field="note-text"]').press('End');
    await p2.locator('[data-field="note-text"]').pressSequentially(' и без него', { delay: 2 });
    await p2.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); });
    await expect.poll(async () => (await liveNotes(p2)).map((n) => n.body), { timeout: 5000 }).toEqual(['Пълно хранилище и без него']);
    expect(errs).toEqual([]);
    await p2.close();
  });
});

// ===========================================================================
// The screen orientation: screen.orientation and display-mode mocked.
async function mockOrientation(page, { api = true, installed = true, plan = {}, noUnlock = false } = {}) {
  // plan: { portrait: [...], landscape: [...] }, per lock call of that value: 'ok' | 'refuse' | 'hang' | 'throw' | 'slow' (resolves after 300 ms, a later lock aborts it).
  await page.addInitScript(({ api, installed, plan, noUnlock }) => {
    if (window.top !== window) return;
    window.__orient = [];
    if (api) {
      let n = 0;
      let pending = null;
      const fake = {
        type: 'landscape-primary', angle: 0, onchange: null, addEventListener() {}, removeEventListener() {},
        lock: (o) => {
          window.__orient.push(`lock:${o}`);
          n++;
          const what = (plan[o] && plan[o].shift()) || 'ok';
          if (pending) { pending(new DOMException('aborted by a new lock', 'AbortError')); pending = null; }
          if (what === 'throw') throw new TypeError('bad lock');
          if (what === 'refuse') return Promise.reject(new DOMException('not allowed', 'NotSupportedError'));
          if (what === 'hang') return new Promise(() => {});
          if (what === 'slow') return new Promise((res, rej) => { pending = rej; setTimeout(() => { if (pending === rej) { pending = null; res(); } }, 300); });
          return Promise.resolve();
        },
      };
      if (!noUnlock) fake.unlock = () => { window.__orient.push('unlock'); };
      Object.defineProperty(screen, 'orientation', { configurable: true, get: () => fake });
    } else {
      Object.defineProperty(screen, 'orientation', { configurable: true, get: () => undefined });
    }
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: installed, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q));
  }, { api, installed, plan, noUnlock });
}
const orient = (page) => page.evaluate(() => window.__orient);
async function openSettings(page) {
  await page.goto('./#/settings');
  await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
}
const pick = (page, o) => page.locator(`label[for="settings-orientation-${o}"]`).click();
const oInput = (page, o) => page.locator(`[data-field="orientation-${o}"]`);
const oHint = (page) => page.locator('[data-field="orientation-hint"]');
const HINT_OK = '„Портрет“ и „Пейзаж“ заключват екрана';
const HINT_REFUSED = 'Устройството не позволи заключването';

test.describe('T070-O "Ориентация на екрана"', () => {
  test('T070-O1 installed: a refused lock, then a lock that works — the message follows the LAST attempt (not the one before)', async ({ page }) => {
    await mockOrientation(page, { plan: { landscape: ['refuse', 'refuse', 'refuse'] } });
    await start(page);
    await openSettings(page);
    await pick(page, 'landscape');
    await expect(oHint(page)).toContainText(HINT_REFUSED);
    await pick(page, 'portrait');
    await expect.poll(() => orient(page)).toContain('lock:portrait');
    await page.waitForTimeout(300);
    const hint = await oHint(page).textContent();
    info('T070-O1', { calls: await orient(page), hint });
    console.log('O1', JSON.stringify(await orient(page)), hint);
    if (hint.includes(HINT_REFUSED)) test.fail(true, 'T070-O1: after a refused lock the next choice that locks fine still says "Устройството не позволи заключването сега…": saveSettings() fires easylrn:settings and main.js applies the value first; the settings screen\'s own applyOrientation() then sees the same value as "applied" and returns the result of the attempt before (lastResult) at once');
    expect(hint).toContain(HINT_OK);
    expect(await db(page, async (db) => (await db.getSettings()).orientation)).toBe('portrait');
  });

  test('T070-O2 a lock that never answers, a lock that throws at once, a lock aborted by the next one (Портрет → Пейзаж fast): no error, the last choice is kept and applied, Автоматично still unlocks; no unlock() at all: Автоматично is no error', async ({ page, context }) => {
    await mockOrientation(page, { plan: { portrait: ['hang', 'slow', 'slow'], landscape: ['throw', 'throw', 'slow', 'slow'] } });
    await start(page);
    await openSettings(page);
    await pick(page, 'portrait'); // hangs
    await page.waitForTimeout(200);
    await pick(page, 'landscape'); // throws
    await expect(oHint(page)).toContainText(HINT_REFUSED);
    await pick(page, 'portrait'); // slow, aborted by the next
    await pick(page, 'landscape'); // slow, wins
    await page.waitForTimeout(700);
    await pick(page, 'auto');
    await expect.poll(() => orient(page).then((l) => l.at(-1))).toBe('unlock');
    const calls = await orient(page);
    info('T070-O2', { calls, hint: await oHint(page).textContent() });
    console.log('O2', JSON.stringify(calls));
    expect(calls.filter((c) => c === 'lock:landscape').length).toBeGreaterThanOrEqual(2);
    expect(await db(page, async (db) => (await db.getSettings()).orientation)).toBe('auto');
    await expect(oHint(page)).toContainText(HINT_OK);
    // No unlock(): "Автоматично" is no error.
    const p2 = await context.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(String(e)));
    await mockOrientation(p2, { noUnlock: true });
    await p2.goto('./#/settings');
    await expect(p2.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await p2.locator('label[for="settings-orientation-portrait"]').click();
    await p2.locator('label[for="settings-orientation-auto"]').click();
    await p2.waitForTimeout(300);
    expect(errs).toEqual([]);
    await p2.close();
  });

  test('T070-O3 the choice is applied at start on any screen (a lesson opened directly), and a backup with the setting restores it; the radio shows it; keyboard reaches the group', async ({ page }) => {
    await mockOrientation(page);
    await start(page);
    await importCourse(page);
    await db(page, (db) => db.saveSettings({ orientation: 'landscape' }));
    await page.goto(`./#/c/${C}/read/0001`);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => orient(page)).toEqual(['lock:landscape']);
    await openSettings(page);
    await expect(oInput(page, 'landscape')).toBeChecked();
    await expect(page.locator('[data-field="orientation"]')).toHaveAttribute('role', 'radiogroup');
    for (const o of ['auto', 'portrait', 'landscape']) await expect(oInput(page, o)).toHaveAttribute('aria-describedby', 'settings-orientation-hint');
  });
});

// ===========================================================================
// The layout of 0.14.2.
async function layoutOf(page) {
  const box = async (sel) => { const l = page.locator(sel); return (await l.count()) && await l.first().isVisible() ? l.first().boundingBox() : null; };
  return {
    frame: await box('iframe.lesson-frame'),
    strip: await box('[data-field="notes-strip"]'),
    bar: await box('.notes-strip__bar'),
    panel: await box('[data-field="notes-panel"]'),
    tools: await box('[data-field="mark-tools"]'),
    handle: await box('[data-field="notes-strip-handle"]'),
  };
}
const overlap = (a, b) => a && b && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

test.describe('T070-L the layout of 0.14.2', () => {
  test.beforeEach(async ({ page }) => { await start(page); await importCourse(page); });

  for (const scale of [1, 1.6]) {
    test(`T070-L1 text ${scale * 100} %: 1920×1200, 1280×800, 1200×1920, 800×1280 — the note column, the list and a mark card never over the lesson or the strip; the noted line stays in view next to the note; no sideways scroll`, async ({ page }, ti) => {
      test.skip(ti.project.name.includes('portrait'), 'the sizes are set here');
      await db(page, (db, s) => db.saveSettings({ fontScale: s }), scale);
      const out = [];
      for (const [w, hgt] of [[1920, 1200], [1280, 800], [1200, 1920], [800, 1280]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await openLesson(page);
        if (!(await liveNotes(page)).length) await writeNote(page, 'оценява рисковете', 'Колона');
        else { await select(page, 'оценява рисковете'); await newNote(page).click(); await expect(noteText(page)).toBeFocused(); }
        await page.waitForTimeout(500);
        const l = await layoutOf(page);
        const line = await page.evaluate(() => null);
        void line;
        // The noted line (do not scroll it: it must already be in view after the reflow).
        const frame = await lessonFrame(page);
        const rel = await frame.evaluate(() => { const r = document.getElementById('p2').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
        const inView = l.frame.y + rel.top >= -1 && l.frame.y + rel.bottom <= hgt + 1;
        out.push({ w, hgt, frame: Math.round(l.frame.width), panel: Math.round(l.panel.width), strip: Math.round(l.strip.width), inView });
        expect(await noSideScroll(page), `${w}: no sideways scroll`).toBe(true);
        expect(overlap(l.panel, l.frame), `${w}: the note over the lesson`).toBeFalsy();
        expect(overlap(l.strip, l.frame), `${w}: the strip over the lesson`).toBeFalsy();
        expect(overlap(l.panel, l.strip), `${w}: the note over the strip`).toBeFalsy();
        expect(overlap(l.tools, l.frame), `${w}: the tools over the lesson`).toBeFalsy();
        expect(l.panel.x + l.panel.width, `${w}: the note on the screen`).toBeLessThanOrEqual(w + 1);
        expect(l.frame.width, `${w}: the lesson readable`).toBeGreaterThanOrEqual(280);
        expect(inView, `${w}: the noted line in view`).toBe(true);
        // The list and a mark card: columns too.
        await page.locator('[data-action="notes-list"]').click();
        const list = await layoutOf(page);
        expect(overlap(list.panel, list.frame), `${w}: the list over the lesson`).toBeFalsy();
        await page.keyboard.press('Escape');
        await expect(panel(page)).toBeHidden();
      }
      info(`T070-L1 ${scale}`, out);
    });
  }

  test('T070-L2 a phone 360×800 (100 % and 160 %): no bar, no "☰", the 📝 ≥ 36 px in a column ≤ 48 px; the note over the whole window; rotated to 800×360 with the note open → a column beside the lesson, back to 360 → the whole window again; the text typed survives every turn; no sideways scroll', async ({ page }, ti) => {
    test.skip(ti.project.name.includes('portrait'), 'the sizes are set here');
    for (const scale of [1, 1.6]) {
      await db(page, (db, s) => db.saveSettings({ fontScale: s }), scale);
      await page.setViewportSize({ width: 360, height: 800 });
      await openLesson(page);
      const closed = await layoutOf(page);
      expect(closed.bar).toBeNull();
      expect(closed.handle).toBeNull();
      expect(closed.strip.width).toBeLessThanOrEqual(48);
      expect(closed.frame.width).toBeGreaterThan(360 * 0.6);
      if (!(await liveNotes(page)).length) {
        await select(page, 'оценява рисковете');
        await expect(quick(page)).toBeVisible();
        const q = await quick(page).boundingBox();
        expect(q.x + q.width).toBeLessThanOrEqual(361);
        await quick(page).click();
      } else {
        await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
        await noteMarks(page).first().click();
      }
      await expect(panel(page)).toHaveAttribute('data-layout', 'full');
      const m = await page.locator('[data-field="notes-marks"] .notes-strip__mark').count();
      void m;
      await noteText(page).press('End');
      await noteText(page).pressSequentially(`т${scale}`, { delay: 5 });
      let p = await panel(page).boundingBox();
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.width).toBeGreaterThanOrEqual(359);
      expect(await noSideScroll(page)).toBe(true);
      // Rotation with the note open.
      await page.setViewportSize({ width: 800, height: 360 });
      await page.waitForTimeout(400);
      await expect(panel(page)).toHaveAttribute('data-layout', 'side');
      const wide = await layoutOf(page);
      expect(overlap(wide.panel, wide.frame), '800×360: the note over the lesson').toBeFalsy();
      expect(await noSideScroll(page)).toBe(true);
      await noteText(page).press('End');
      await noteText(page).pressSequentially('+', { delay: 5 });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(400);
      await expect(panel(page)).toHaveAttribute('data-layout', 'full');
      p = await panel(page).boundingBox();
      expect(p.width).toBeGreaterThanOrEqual(359);
      expect(await noSideScroll(page)).toBe(true);
      await page.locator('[data-action="note-done"]').click();
      await expect(panel(page)).toBeHidden();
      await expect(noteMarks(page)).toHaveCount(1, { timeout: 5000 });
      await page.waitForTimeout(300); // the 📝 is redrawn after the reflow (boundingBox of a replaced node is null)
      const icon = await noteMarks(page).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, width: r.width, height: r.height }; });
      expect(icon.width).toBeGreaterThanOrEqual(36);
      expect(icon.height).toBeGreaterThanOrEqual(36);
      expect(icon.x + icon.width).toBeLessThanOrEqual(361);
      expect(await noSideScroll(page)).toBe(true);
    }
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['т1+т1.6+']);
  });

  test('T070-L3 a phone: "☷" only while a note has no 📝 (unattached), and it opens the list; the guard (layer, tabindex −1) works on a phone too; ▲ / ▼ and "← Всички бележки" are in the note', async ({ page }, ti) => {
    test.skip(ti.project.name.includes('portrait'), 'the sizes are set here');
    await page.setViewportSize({ width: 360, height: 800 });
    await openLesson(page);
    await writeNote(page, 'оценява рисковете', 'Първа');
    await expect(frameEl(page)).toHaveAttribute('data-note-guard', 'on');
    await expect(frameEl(page)).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('[data-action="panel-next-note"]')).toBeVisible();
    await expect(page.locator('[data-action="notes-back-to-list"]')).toBeVisible();
    await page.locator('[data-action="note-done"]').click();
    await expect(page.locator('[data-action="notes-list-phone"]')).toBeHidden();
    await db(page, async (db, id) => { const a = (await db.annotationsFor({ type: 'lesson', id }))[0]; await db.updateAnnotation(a.id, { selector: { quote: { exact: 'Няма такъв текст в урока', prefix: '', suffix: '' }, position: { start: 1, end: 5 } } }); }, L1);
    await openLesson(page);
    await expect(page.locator('[data-action="notes-list-phone"]')).toBeVisible({ timeout: 8000 });
    const b = await page.locator('[data-action="notes-list-phone"]').boundingBox();
    expect(b.width).toBeGreaterThanOrEqual(36);
    expect(b.x + b.width).toBeLessThanOrEqual(361);
    await page.locator('[data-action="notes-list-phone"]').click();
    await expect(panel(page)).toHaveAttribute('data-mode', 'list');
    await expect(panel(page)).toHaveAttribute('data-layout', 'full');
    expect(await noSideScroll(page)).toBe(true);
  });
});
