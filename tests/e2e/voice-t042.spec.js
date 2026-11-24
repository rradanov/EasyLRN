// T-042 (tester), part B: tests of T-041 (0.18.0) — voice input (D-025) "as an attacker".
// - SpeechRecognition is a FAKE class (no microphone, no network). Every instance is
//   kept (window.__recs) so that a recognizer of a closed panel can still "speak":
//   its late results must go nowhere.
// - where the 🎤 is (a note, a question, a next question, the whole lesson; not in
//   "Покажи промпта", not in the lists); interim results; the final text at the cursor;
//   editing while it listens; maxlength; a second press stops; rapid presses;
//   "Слуша…" (role=status, aria-live, aria-pressed); the errors in Bulgarian; no API /
//   offline → hidden; "Изпрати" / Ctrl+Enter stop it; closing the panel / leaving the
//   lesson while it listens; the guard of the field during dictation (the attacks of
//   T-070 / T-072); the lesson never gets the text (window, ports, DOM, keys); the
//   lesson has no microphone; two tabs.
// NEVER a real request: api.anthropic.com is answered by page.route(); every other
// request leaving localhost is aborted and recorded. FAKE keys only; a made-up course (D-026).
// Known defects: test.fail(<defect seen>, 'T042-…: …') followed by the strict check.
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });
test.use({ trace: 'off' });

const KEY = 'sk-ant-api03-FAKE-t042-v-4242424242-zz';
const API = /^https:\/\/api\.anthropic\.com\//;
const C = 'LRN-V42';

let problems;
let external;
let consoleAll;
let allow;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  consoleAll = [];
  allow = [];
  page.on('console', (m) => { consoleAll.push(m.text()); if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (!problems) return;
  expect(problems.filter((p) => !allow.some((r) => r.test(p)))).toEqual([]);
  expect(external.filter((u) => !API.test(u))).toEqual([]);
  expect(consoleAll.join('\n')).not.toContain('FAKE');
});
const info = (name, value) => test.info().annotations.push({ type: name, description: JSON.stringify(value).slice(0, 4000) });
const landscapeOnly = (ti, why = 'one orientation is enough') => test.skip(ti.project.name !== 'tablet-landscape', why);

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const FILL = Array.from({ length: 20 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
// The lesson logs every message (window and every port it is given), every key / input,
// and offers a focus thief, designMode, forged messages (the attacks of T-070 / T-072 / T-024).
const SPY = `<script>(() => {
  const log = (where, d) => { try { console.log('LM:' + where + ':' + JSON.stringify(d)); } catch (err) { console.log('LM:' + where + ':?'); } };
  addEventListener('message', (e) => { log('w', e.data); for (const p of e.ports || []) { p.addEventListener('message', (x) => log('p', x.data)); p.start && p.start(); } }, true);
  const logk = (e) => console.log('LK:' + (e.key || e.data || e.type));
  for (const t of ['keydown', 'keyup', 'input', 'beforeinput', 'compositionend', 'paste']) document.addEventListener(t, logk, true);
  window.__ids = [];
  addEventListener('message', (e) => { const d = e.data; if (d && d.type === 'lrn:annotations' && Array.isArray(d.items)) window.__ids = d.items.map((x) => x.id); });
  window.__attack = (ms = 4000, o = {}) => {
    const i = document.getElementById('v1');
    const t = setInterval(() => {
      try { i.focus(); document.designMode = 'on'; if (document.designMode === 'on') console.log('LP:design'); document.designMode = 'off'; } catch (err) { /* */ }
      if (o.escape !== false) parent.postMessage({ lrn: 1, v: 1, type: 'lrn:escape' }, '*');
      if (o.tap !== false) for (const id of window.__ids) parent.postMessage({ lrn: 1, v: 1, type: 'lrn:tap', annotationId: id }, '*');
      parent.postMessage({ lrn: 1, v: 1, type: 'lrn:selection', quote: { exact: 'ПОДМЕНЕН', prefix: '', suffix: '' }, position: { start: 3, end: 11 } }, '*');
      for (const type of ['lrn:voice', 'lrn:speech', 'lrn:dictate', 'lrn:mic', 'lrn:result']) parent.postMessage({ lrn: 1, v: 1, type, text: 'ИЗМАМА', transcript: 'ИЗМАМА' }, '*');
    }, 5);
    setTimeout(() => clearInterval(t), ms);
  };
  window.__heardDom = () => document.documentElement.outerHTML;
})();</script>`;
const BODY = `<h2>Обхват</h2><p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи.</p>
<h2>Задължения</h2><p id="p2">Производителят оценява рисковете през целия жизнен цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>${FILL}<input id="v1" aria-label="v1">${SPY}`;
const FILES = {
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи урок |\n| 0002 | Втори урок |\n`,
  'MISSION.md': '# Мисия\n\nИзмислена мисия за тест.\n',
  'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY),
  'lessons/0002-vtori.html': lessonHtml('Втори урок', `<p id="q1">Втори урок, кратък текст за тест.</p>${SPY}`),
};

/**
 * The fake SpeechRecognition (top window only; `cls`: which name the browser has).
 * window.__recs: every instance; __say(text, final, i) emits a result on instance i
 * (default: the last one), __raw(i, resultIndex, [[text, final]…]) any event,
 * __fail(code, i) an error then the end, __end(i) the end.
 */
function fakeSpeech() {
  return (opts) => {
    if (window.top !== window) return;
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    window.__recs = [];
    window.__voice = { made: 0, started: 0, stopped: 0, aborted: 0 };
    if (!opts.api) return;
    class FakeRecognition {
      constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.results = []; this.running = false; window.__voice.made++; window.__recs.push(this); }
      start() { if (opts.throwOnStart) throw new DOMException('already started', 'InvalidStateError'); if (this.running) throw new DOMException('already started', 'InvalidStateError'); this.running = true; window.__voice.started++; }
      stop() { window.__voice.stopped++; this.finish(); }
      // As Chrome: abort() fires the error "aborted", then the end.
      abort() { window.__voice.aborted++; if (this.running) this.onerror?.({ error: 'aborted' }); this.finish(); }
      finish() { if (!this.running) return; this.running = false; setTimeout(() => this.onend?.({}), 10); }
      emit(text, final) {
        const done = this.results.filter((r) => r.isFinal);
        const r = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: final });
        this.results = [...done, r];
        this.onresult?.({ resultIndex: done.length, results: this.results });
      }
      raw(resultIndex, list) {
        this.results = list.map(([t, f]) => Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal: f }));
        this.onresult?.({ resultIndex, results: this.results });
      }
    }
    if (opts.cls === 'std') window.SpeechRecognition = FakeRecognition;
    else window.webkitSpeechRecognition = FakeRecognition;
    const at = (i) => (i === undefined ? window.__recs.at(-1) : window.__recs[i]);
    window.__say = (text, final = true, i) => at(i).emit(text, final);
    window.__raw = (i, ri, list) => at(i).raw(ri, list);
    window.__fail = (code, i) => { const r = at(i); r.onerror?.({ error: code }); r.finish(); };
    window.__end = (i) => at(i).finish();
  };
}

async function inits(page, { api = true, cls = 'webkit', throwOnStart = false } = {}) {
  await page.addInitScript(fakeSpeech(), { api, cls, throwOnStart });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__lrn = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.lrn === 1) window.__lrn.push(e.data); });
    window.__toLesson = [];
    const orig = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...a) { try { window.__toLesson.push(JSON.stringify(a[0])); } catch (e) { /* */ } return orig.apply(this, a); };
  });
}
async function boot(page, opts = {}) {
  await inits(page, opts);
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}
async function start(page, opts = {}) {
  await boot(page, opts);
  const zip = asFile(`${C}.zip`, makeZip(toBytes(FILES), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: zip.name, bytes: [...zip.buffer] });
  expect(r).not.toMatch(/^ERROR/);
  if (opts.key !== false) await page.evaluate(async (k) => { const db = await import('./src/db.js'); await db.saveApiKey(k); }, KEY);
}
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page, n = '0001') {
  await page.evaluate(() => { window.__lrn = []; });
  await page.goto(`./#/c/${C}/read/${n}`);
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => page.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
  return lessonFrame(page);
}
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
const visibleOne = async (page, a, b) => {
  const one = page.locator(`[data-action="${a}"], [data-action="${b}"]`).locator('visible=true');
  await expect(one).toHaveCount(1, { timeout: 3000 });
  return one;
};

const panel = (page) => page.locator('[data-field="notes-panel"]');
const noteText = (page) => page.locator('[data-field="note-text"]');
const qField = (page) => page.locator('[data-field="question-text"]');
const mic = (page) => panel(page).locator('[data-action="voice"]');
const voiceStatus = (page) => panel(page).locator('[data-field="voice-status"]');
const interim = (page) => panel(page).locator('[data-field="voice-interim"]');
const answers = (page) => page.locator('[data-field="thread-log"] [data-role="assistant"]');
const frameEl = (page) => page.locator('iframe.lesson-frame');
const say = (page, text, final = true, i) => page.evaluate(([t, f, n]) => window.__say(t, f, n ?? undefined), [text, final, i ?? null]);
const recs = (page) => page.evaluate(() => window.__recs.map((r) => ({ running: r.running, lang: r.lang, interim: r.interimResults, continuous: r.continuous })));
const liveNotes = async (page) => (await page.evaluate(async () => (await import('./src/db.js')).list('notes'))).filter((n) => !n.deleted);
const noteSaved = (page) => expect(page.locator('[data-field="note-status"]')).toHaveText('Записано.', { timeout: 5000 });

async function openNote(page, needle) {
  await select(page, needle);
  await (await visibleOne(page, 'new-note', 'new-note-quick')).click();
  await expect(panel(page)).toHaveAttribute('data-mode', 'note');
  await expect(noteText(page)).toBeFocused();
}
async function openQuestion(page, needle) {
  await select(page, needle);
  await (await visibleOne(page, 'new-question', 'new-question-quick')).click();
  await expect(panel(page)).toHaveAttribute('data-mode', 'thread');
  await expect(qField(page)).toBeFocused();
}
const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const answerSse = (text) => sse([
  ['message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 100, output_tokens: 20 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }],
  ['message_stop', {}],
]);
async function mockApi(page) {
  const seen = [];
  await page.route(API, async (route) => {
    seen.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' }, body: answerSse(`Отговор ${seen.length}.`) });
  });
  return seen;
}
const lastUserText = (body) => body.messages.at(-1).content.map((c) => c.text).join('');
/** Everything the lesson got: its console (messages, keys, designMode), the app's port messages, its DOM. */
async function lessonHeard(page, frame) {
  const toLesson = await page.evaluate(() => window.__toLesson);
  const dom = frame ? await frame.evaluate(() => window.__heardDom()).catch(() => '') : '';
  return { log: consoleAll.filter((l) => /^L[MKP]:/.test(l)).join('\n'), ports: toLesson.join('\n'), dom };
}

// ---------------------------------------------------------------------------
test.describe('T042-V where the 🎤 is', () => {
  test('V1 a note, a question, a next question and a question about the whole lesson have one 🎤 each (bg-BG, interim, continuous); "Покажи промпта", the list of notes and the list of questions have none; the 🎤 is a real button of 44 px next to its field', async ({ page }) => {
    await start(page);
    await mockApi(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(mic(page)).toHaveCount(1);
    await expect(mic(page)).toHaveAttribute('type', 'button');
    const b = await mic(page).boundingBox();
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    await page.locator('[data-action="notes-back-to-list"]').click();
    await expect(page.locator('[data-action="voice"]').locator('visible=true')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await openQuestion(page, 'Уязвимостите се докладват');
    await expect(mic(page)).toHaveCount(1);
    await qField(page).fill('Първи?');
    await page.locator('[data-action="question-prompt"]').click();
    await expect(page.locator('[data-field="question-prompt"]')).toContainText('Първи?');
    await expect(page.locator('[data-field="question-prompt"] [data-action="voice"]')).toHaveCount(0);
    await page.locator('[data-action="question-send"]').click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(mic(page)).toHaveCount(1);
    await expect(mic(page)).toBeVisible();
    // The list of questions: only the 🎤 of its composer (a question about the whole lesson).
    await page.locator('[data-action="questions-back-to-list"]').click();
    await expect(page.locator('[data-action="voice"]').locator('visible=true')).toHaveCount(1);
    await expect(page.locator('[data-field="question-composer"] [data-action="voice"]').locator('visible=true')).toHaveCount(1);
    await expect(page.locator('[data-field="threads-list"] [data-action="voice"]')).toHaveCount(0);
    await page.locator('[data-action="close-notes-panel"]').click();
    await page.locator('[data-action="questions"]').click();
    await expect(qField(page)).toBeVisible();
    await expect(mic(page)).toHaveCount(1);
    await qField(page).click();
    await mic(page).click();
    expect((await recs(page)).at(-1)).toEqual({ running: true, lang: 'bg-BG', interim: true, continuous: true });
  });

  test('V2 only the unprefixed SpeechRecognition (no webkit…): the 🎤 is there and works', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page, { cls: 'std' });
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    await say(page, 'Стандартен клас');
    await expect(noteText(page)).toHaveValue('Стандартен клас');
  });
});

test.describe('T042-T the text', () => {
  test.beforeEach(({}, ti) => landscapeOnly(ti));

  test('T1 interim results replace each other in the grey line and never reach the field or the saved note (also after the autosave); one event with two finals and an interim puts both finals in order; the interim line goes at the end', async ({ page }) => {
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    for (const t of ['едно', 'едно две', 'едно две три']) {
      await say(page, t, false);
      await expect(interim(page)).toHaveText(t);
    }
    await expect(noteText(page)).toHaveValue('');
    await page.waitForTimeout(1500); // longer than the autosave
    expect(await liveNotes(page)).toEqual([]);
    await say(page, 'Едно две три.', true);
    await expect(noteText(page)).toHaveValue('Едно две три.');
    await expect(interim(page)).toBeHidden();
    // One event: two new finals and an interim after them.
    await page.evaluate(() => window.__raw(undefined, 1, [['Едно две три.', true], ['Четири', true], ['пет', true], ['шест недовърше', false]]));
    await expect(noteText(page)).toHaveValue('Едно две три. Четири пет');
    await expect(interim(page)).toHaveText('шест недовърше');
    await noteSaved(page);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Едно две три. Четири пет']);
    await page.evaluate(() => window.__end());
    await expect(interim(page)).toBeHidden();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(noteText(page)).toHaveValue('Едно две три. Четири пет');
  });

  test('T2 editing while it listens: typed text stays, the cursor moved by the user is where the next final text goes; text typed between two finals is not lost; a final of only spaces changes nothing', async ({ page }) => {
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    await say(page, 'първо');
    await noteText(page).pressSequentially(' ръчно');
    await expect(noteText(page)).toHaveValue('първо ръчно');
    await say(page, 'второ');
    await expect(noteText(page)).toHaveValue('първо ръчно второ');
    await noteText(page).press('Home');
    await say(page, 'Начало');
    await expect(noteText(page)).toHaveValue('Начало първо ръчно второ');
    await say(page, '   ');
    await expect(noteText(page)).toHaveValue('Начало първо ръчно второ');
    await expect(noteText(page)).toBeFocused();
    await mic(page).click();
    await noteSaved(page);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Начало първо ръчно второ']);
  });

  test('T3 maxlength: a note near 20 000 characters and a question near 4 000 take only what fits; nothing over the limit is saved / sent; a cut never leaves half a character (a lone surrogate)', async ({ page }) => {
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await noteText(page).evaluate((el) => { el.value = 'а'.repeat(19995); el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(19995, 19995); });
    await mic(page).click();
    await say(page, 'дълга диктовка');
    await expect.poll(() => noteText(page).evaluate((el) => el.value.length)).toBe(20000);
    expect(await noteText(page).evaluate((el) => el.value.slice(19995))).toBe(' дълг');
    await say(page, 'още');
    expect(await noteText(page).evaluate((el) => el.value.length)).toBe(20000);
    await mic(page).click();
    await noteSaved(page);
    expect((await liveNotes(page))[0].body.length).toBe(20000);
    // Half a character at the limit (an emoji — a recognizer may give one).
    await noteText(page).evaluate((el) => { el.value = 'б'.repeat(19998); el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(19998, 19998); });
    await mic(page).click();
    await say(page, '🙂 усмивка');
    const tail = await noteText(page).evaluate((el) => [...el.value.slice(19996)].map((c) => c.codePointAt(0).toString(16)));
    const lone = tail.some((h) => parseInt(h, 16) >= 0xd800 && parseInt(h, 16) <= 0xdfff);
    info('T042-I2', { tail, lone });
    // Info only (T042-I2): Bulgarian speech gives no emoji; the field / database still take it.
    await mic(page).click();
  });

  test('T4 the second press stops; rapid presses (6 clicks in a row, then 5) never leave two recognizers running, and the state shown (aria-pressed, "Слуша…") is the real one', async ({ page }) => {
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    for (const n of [6, 5]) {
      for (let i = 0; i < n; i++) await mic(page).click({ delay: 0 });
      await page.waitForTimeout(300);
      const r = await recs(page);
      const running = r.filter((x) => x.running).length;
      const pressed = await mic(page).getAttribute('aria-pressed');
      const status = await voiceStatus(page).textContent();
      info(`T042-T4-${n}`, { made: r.length, running, pressed, status });
      expect(running).toBeLessThanOrEqual(1);
      expect(pressed).toBe(String(running === 1));
      if (running) expect(status).toContain('Слуша…');
      else expect(status).not.toContain('Слуша…');
    }
    // And it still works.
    if ((await mic(page).getAttribute('aria-pressed')) === 'false') await mic(page).click();
    await say(page, 'след бързите');
    await expect(noteText(page)).toHaveValue('след бързите');
  });
});

test.describe('T042-E errors and availability', () => {
  test('E1 every error code: the Bulgarian text in the status line (role=status, aria-live=polite), the button back to idle; "aborted" says nothing; an unknown code a general text; "language-not-supported" hides the 🎤 like "network"; after an error a new press listens again ("Слуша…"); no console error', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(voiceStatus(page)).toHaveAttribute('aria-live', 'polite');
    const cases = [['not-allowed', 'Няма разрешение за микрофона'], ['service-not-allowed', 'Няма разрешение за микрофона'], ['no-speech', 'Нищо не се чу'], ['audio-capture', 'Микрофонът не е достъпен'], ['bad-grammar', 'Гласовото въвеждане не сработи'], ['нещо-друго', 'Гласовото въвеждане не сработи']];
    for (const [code, text] of cases) {
      await mic(page).click();
      await expect(voiceStatus(page)).toContainText('Слуша…');
      await page.evaluate((c) => window.__fail(c), code);
      await expect(voiceStatus(page)).toContainText(text);
      await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(mic(page)).toBeVisible();
      expect(await voiceStatus(page).textContent()).not.toContain(code);
    }
    await mic(page).click();
    await page.evaluate(() => window.__fail('language-not-supported'));
    await expect(voiceStatus(page)).toContainText('не се поддържа');
    await expect(mic(page)).toBeHidden();
    await expect(noteText(page)).toBeEditable();
  });

  const D1_TEXT = 'T042-D1: after the error "aborted" (Chrome fires it at abort() — "Изпрати" / Ctrl+Enter while it listens — and when the system takes the microphone) the status line (role=status, aria-live) still says "Слуша… Говори; натисни 🎤 пак, за да спреш." though the 🎤 is idle (aria-pressed=false): voiceError("aborted") is null, so onerror writes nothing, and onend writes nothing either because `failed` is set; the status could be cleared (or "Готово…") on "aborted"';
  test('E4 "aborted" (the system took the microphone): the 🎤 is idle and the status line no longer says "Слуша…"; the text so far stays', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    await say(page, 'преди отказа');
    await page.evaluate(() => window.__fail('aborted'));
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(200);
    const st = await voiceStatus(page).textContent();
    info('T042-D1', { status: st });
    expect(st).not.toMatch(/грешка|error|aborted/i);
    await expect(noteText(page)).toHaveValue('преди отказа');
    test.fail(st.includes('Слуша'), D1_TEXT);
    expect(st).not.toContain('Слуша');
  });

  test('E5 "Изпрати" while it listens (abort): the status line under the next-question field no longer says "Слуша…"', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await mockApi(page);
    await openLesson(page);
    await openQuestion(page, 'оценява рисковете');
    await mic(page).click();
    await say(page, 'Въпрос по диктовка');
    await page.locator('[data-action="question-send"]').click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    const st = await voiceStatus(page).textContent();
    info('T042-D1-send', { status: st });
    test.fail(st.includes('Слуша'), D1_TEXT);
    expect(st).not.toContain('Слуша');
  });

  test('E2 the recognizer throws at start(): "Гласовото въвеждане не сработи…", not listening, no console error', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page, { throwOnStart: true });
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    await expect(voiceStatus(page)).toContainText('Гласовото въвеждане не сработи');
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('E3 after "network" the 🎤 of that field is gone; a new panel offers it again (the network may be back); offline when the panel opens → none; online while it is open → it comes', async ({ page, context }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    await page.evaluate(() => window.__fail('network'));
    await expect(mic(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await openNote(page, 'Уязвимостите се докладват');
    const again = await mic(page).isVisible();
    info('T042-E3', { again });
    await page.keyboard.press('Escape');
    await context.setOffline(true);
    await openQuestion(page, 'Регламентът за киберустойчивост');
    await expect(mic(page)).toBeHidden();
    await context.setOffline(false);
    await expect(mic(page)).toBeVisible();
    await qField(page).click();
    await mic(page).click();
    await say(page, 'пак онлайн');
    await expect(qField(page)).toHaveValue('пак онлайн');
  });
});

test.describe('T042-S sending and leaving while it listens', () => {
  test('S1 Ctrl+Enter while it listens sends what is in the field: the interim text is not sent, a late final of the old recognizer does not come back into the empty field', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    const seen = await mockApi(page);
    await openLesson(page);
    await openQuestion(page, 'оценява рисковете');
    await mic(page).click();
    await say(page, 'Диктуван въпрос');
    await say(page, 'недовършена част', false);
    await qField(page).press('Control+Enter');
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(lastUserText(seen[0])).toMatch(/Въпрос: Диктуван въпрос$/);
    await say(page, 'късно окончателно', true, 0);
    await page.waitForTimeout(300);
    await expect(qField(page)).toHaveValue('');
    expect((await recs(page))[0].running).toBe(false);
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(interim(page)).toBeHidden();
    await expect(qField(page)).toHaveValue('');
  });

  test('S2 "Изпрати" with no API key while it listens: nothing is sent, the dictated text stays in the field', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page, { key: false });
    const seen = await mockApi(page);
    await openLesson(page);
    await openQuestion(page, 'оценява рисковете');
    await mic(page).click();
    await say(page, 'Без ключ');
    await page.locator('[data-action="question-send"]').click();
    await expect(page.locator('[data-field="question-no-key"]')).toBeVisible();
    await expect(qField(page)).toHaveValue('Без ключ');
    expect(seen).toEqual([]);
    expect((await recs(page))[0].running).toBe(false);
  });

  // Each way out of a listening panel: the recognizer stops, and its late results go nowhere.
  const ways = [
    ['✕', async (page) => page.locator('[data-action="close-notes-panel"]').click()],
    ['Escape in the field', async (page) => noteText(page).press('Escape')],
    ['"Готово"', async (page) => page.locator('[data-action="note-done"]').click()],
    ['"← Всички бележки"', async (page) => page.locator('[data-action="notes-back-to-list"]').click()],
    ['a new question on another text', async (page) => openQuestion(page, 'Уязвимостите се докладват')],
    ['another lesson', async (page) => openLesson(page, '0002')],
    ['the course screen', async (page) => { await page.goto(`./#/c/${C}`); await expect(page.locator('iframe.lesson-frame')).toHaveCount(0); }],
    ['back in history', async (page) => { await page.goBack(); await expect(page.locator('iframe.lesson-frame')).toHaveCount(0); }],
  ];
  for (const [name, leave] of ways) {
    test(`S3 leaving a listening note by ${name}: the recognizer stops; its late interim / final results go into no field (also not the next one) and into no note`, async ({ page }, ti) => {
      landscapeOnly(ti);
      await start(page);
      if (name === 'back in history') await page.goto(`./#/c/${C}`);
      const frame = await openLesson(page);
      await openNote(page, 'оценява рисковете');
      await mic(page).click();
      await say(page, 'ЗАПИСАНО');
      await say(page, 'ИЗТИЧАНЕ-МЕЖДИННО', false);
      await leave(page);
      await page.waitForTimeout(300);
      // The old recognizer "speaks" after it was left.
      await say(page, 'ИЗТИЧАНЕ-КЪСНО', false, 0);
      await say(page, 'ИЗТИЧАНЕ-КЪСНО', true, 0);
      await page.waitForTimeout(1300);
      const r = await recs(page);
      expect(r[0].running).toBe(false);
      const values = await page.locator('textarea').evaluateAll((els) => els.map((e) => e.value));
      expect(values.join('|')).not.toContain('ИЗТИЧАНЕ');
      const notes = await liveNotes(page);
      expect(JSON.stringify(notes)).not.toContain('ИЗТИЧАНЕ');
      expect(notes.map((n) => n.body)).toEqual(['ЗАПИСАНО']);
      expect(await page.locator('[data-field="voice-interim"]').locator('visible=true').count()).toBe(0);
      // Listening in the next field is a new recognizer, idle until pressed.
      if (await mic(page).isVisible().catch(() => false)) await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
      const heard = await lessonHeard(page, name === 'another lesson' || name.startsWith('the course') || name.startsWith('back') ? null : frame);
      expect(`${heard.log}${heard.ports}${heard.dom}`).not.toMatch(/ЗАПИСАНО|ИЗТИЧАНЕ/);
    });
  }

  test('S4 a press on 🎤 of a question while the note of another panel listens is impossible (one panel); a second 🎤 started on the page stops the first (one at a time)', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    // A second voice input of the page (the module itself), as a later panel might have.
    const r = await page.evaluate(async () => {
      const V = await import('./src/voice.js');
      const ta = document.createElement('textarea');
      document.body.append(ta);
      const v = V.createVoiceInput({ field: ta });
      document.body.append(v.element);
      v.button.click();
      await new Promise((res) => setTimeout(res, 100));
      const out = window.__recs.map((x) => x.running);
      v.destroy(); v.element.remove(); ta.remove();
      return out;
    });
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(r.at(-1)).toBe(true);
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('T042-G the guard of the field and the lesson during dictation', () => {
  test('G1 the attacks of T-070 / T-072 while dictating: a lesson that steals the focus every 5 ms, tries designMode, forges lrn:escape / lrn:tap / lrn:selection and made-up voice messages — the field keeps the focus and every dictated and typed character, the guard stays on, the panel and the quote stay, no key / text reaches the lesson (window, ports, DOM)', async ({ page }) => {
    allow.push(/lesson|Урок/i);
    await start(page);
    const frame = await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(frameEl(page)).toHaveAttribute('data-note-guard', 'on');
    await mic(page).click();
    await frame.evaluate(() => window.__attack(4000));
    await say(page, 'ТАЙНА-ДИКТОВКА едно', false);
    await say(page, 'ТАЙНА-ДИКТОВКА едно', true);
    for (const ch of ' ТАЙНО-ПИСАНЕ') await page.keyboard.type(ch, { delay: 20 });
    await say(page, 'ТАЙНА-ДИКТОВКА две', true);
    await page.waitForTimeout(500);
    await expect(noteText(page)).toHaveValue('ТАЙНА-ДИКТОВКА едно ТАЙНО-ПИСАНЕ ТАЙНА-ДИКТОВКА две');
    await expect(noteText(page)).toBeFocused();
    await expect(frameEl(page)).toHaveAttribute('data-note-guard', 'on');
    await expect(panel(page)).toHaveAttribute('data-mode', 'note');
    await expect(page.locator('[data-field="note-quote"]')).toContainText('оценява рисковете');
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(3800); // the attack ends
    await mic(page).click();
    await noteSaved(page);
    const heard = await lessonHeard(page, frame);
    expect(heard.log).not.toMatch(/LK:|LP:design/);
    expect(`${heard.log}${heard.ports}${heard.dom}`).not.toMatch(/ТАЙН/);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['ТАЙНА-ДИКТОВКА едно ТАЙНО-ПИСАНЕ ТАЙНА-ДИКТОВКА две']);
  });

  test('G2 the same in a question (with "Покажи промпта" open): the dictated question is what is sent and shown; nothing reaches the lesson', async ({ page }, ti) => {
    landscapeOnly(ti);
    allow.push(/lesson|Урок/i);
    await start(page);
    const seen = await mockApi(page);
    const frame = await openLesson(page);
    await openQuestion(page, 'оценява рисковете');
    await page.locator('[data-action="question-prompt"]').click();
    await qField(page).click();
    await mic(page).click();
    await expect(qField(page)).toBeFocused();
    await frame.evaluate(() => window.__attack(3000));
    await say(page, 'ТАЙНИЯТ въпрос', false);
    await say(page, 'ТАЙНИЯТ въпрос по диктовка', true);
    await page.waitForTimeout(3300);
    await expect(qField(page)).toHaveValue('ТАЙНИЯТ въпрос по диктовка');
    await expect(page.locator('[data-field="question-prompt"]')).toContainText('ТАЙНИЯТ въпрос по диктовка', { timeout: 5000 });
    await expect(page.locator('[data-field="question-quote"]')).toHaveText('«оценява рисковете»');
    await page.locator('[data-action="question-send"]').click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(seen).toHaveLength(1);
    expect(lastUserText(seen[0])).toContain('Въпрос: ТАЙНИЯТ въпрос по диктовка');
    expect(lastUserText(seen[0])).not.toContain('ПОДМЕНЕН');
    const heard = await lessonHeard(page, frame);
    expect(heard.log).not.toMatch(/LK:|LP:design/);
    expect(`${heard.log}${heard.ports}${heard.dom}`).not.toMatch(/ТАЙН/);
  });

  test('G3 the 🎤 pressed with the keyboard (Tab, Enter): the focus is on the button for a moment; a lesson that steals the focus then gets no key of the dictation, and the first text brings the focus and the guard back to the field; a tap on 🎤 (touch) keeps the focus in the field', async ({ page }) => {
    allow.push(/lesson|Урок/i);
    await start(page);
    const frame = await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await noteText(page).press('Tab');
    await expect(mic(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
    await frame.evaluate(() => window.__attack(1500, { escape: false, tap: false }));
    await page.waitForTimeout(300);
    await say(page, 'ТАЙНА от клавиатура');
    await expect(noteText(page)).toBeFocused();
    await expect(noteText(page)).toHaveValue('ТАЙНА от клавиатура');
    await expect(frameEl(page)).toHaveAttribute('data-note-guard', 'on');
    await page.waitForTimeout(1400);
    await page.keyboard.type(' и ТАЙНО писане');
    await expect(noteText(page)).toHaveValue('ТАЙНА от клавиатура и ТАЙНО писане');
    // A touch on 🎤 stops; the field keeps the focus.
    await mic(page).tap();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(noteText(page)).toBeFocused();
    await mic(page).tap();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(noteText(page)).toBeFocused();
    await expect(frameEl(page)).toHaveAttribute('data-note-guard', 'on');
    const heard = await lessonHeard(page, frame);
    expect(`${heard.log}${heard.ports}${heard.dom}`).not.toMatch(/ТАЙН/);
    const keys = heard.log.split('\n').filter((l) => l.startsWith('LK:'));
    info('T042-G3', { keys: keys.slice(0, 10) });
    expect(keys.filter((k) => !/LK:(Tab|Enter|keyup|keydown)$/.test(k))).toEqual([]);
  });

  test('G3b the same keyboard press on 🎤 with a lesson that also forges lrn:escape: the note being dictated must stay open', async ({ page }, ti) => {
    landscapeOnly(ti);
    allow.push(/lesson|Урок/i);
    await start(page);
    const frame = await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await noteText(page).press('Tab');
    await expect(mic(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await frame.evaluate(() => window.__attack(1500, { tap: false }));
    await page.waitForTimeout(1600);
    const closed = await panel(page).isHidden();
    info('T042-S1-voice', { closed, recs: await recs(page) });
    test.fail(closed, 'T042-S1 (also here): with the focus on 🎤 after a keyboard press (the field\'s guard does not hold the focus then) a lesson that takes the focus gets an "unsure" gesture and its forged lrn:escape closes the note being dictated (the recognizer stops; the text so far is saved)');
    expect(closed).toBe(false);
  });

  test('G4 the lesson has no microphone: getUserMedia in the lesson is refused without a prompt, its permission is "denied"; the lesson cannot use the app\'s recognizer (no fake there, window.parent is cross-origin)', async ({ page }, ti) => {
    landscapeOnly(ti);
    allow.push(/^Permissions policy violation: microphone is not allowed in this document\.$/);
    await start(page);
    const frame = await openLesson(page);
    const r = await frame.evaluate(async () => {
      const out = {};
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); out.gum = 'granted'; } catch (e) { out.gum = e.name; }
      try { out.perm = (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { out.perm = e.name; }
      try { out.parentRec = typeof window.parent.webkitSpeechRecognition; } catch (e) { out.parentRec = e.name; }
      try { out.parentSay = typeof window.parent.__say; } catch (e) { out.parentSay = e.name; }
      try { out.allowed = document.featurePolicy ? document.featurePolicy.allowsFeature('microphone') : 'n/a'; } catch (e) { out.allowed = e.name; }
      return out;
    });
    info('T042-G4', r);
    expect(r.gum).not.toBe('granted');
    expect(r.parentRec).not.toBe('function');
    expect(r.parentSay).not.toBe('function');
    expect(r.allowed).not.toBe(true);
  });
});

test.describe('T042-D two tabs', () => {
  test('D1 two tabs dictate into notes of their own at the same time: each text goes only into its own field and note; stopping in one does not stop the other', async ({ page, context }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await mic(page).click();
    const b = await context.newPage();
    b.on('pageerror', (e) => problems.push(`B pageerror: ${e}`));
    await inits(b);
    await b.goto(`./#/c/${C}/read/0001`);
    await expect(b.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await expect.poll(() => b.evaluate(() => (window.__lrn || []).some((m) => m.type === 'lrn:anchored')), { timeout: 15000 }).toBe(true);
    await openNote(b, 'Уязвимостите се докладват');
    await mic(b).click();
    await say(page, 'Текст от раздел А');
    await say(b, 'Текст от раздел Б');
    await expect(noteText(page)).toHaveValue('Текст от раздел А');
    await expect(noteText(b)).toHaveValue('Текст от раздел Б');
    await mic(b).click();
    expect((await recs(page))[0].running).toBe(true);
    await say(page, 'още А');
    await expect(noteText(page)).toHaveValue('Текст от раздел А още А');
    await mic(page).click();
    await noteSaved(page);
    await noteSaved(b);
    const bodies = (await liveNotes(page)).map((n) => n.body).sort();
    expect(bodies).toEqual(['Текст от раздел А още А', 'Текст от раздел Б']);
    await b.close();
  });
});
