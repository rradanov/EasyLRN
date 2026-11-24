// T-041 (developer, 0.18.0): voice input (D-025) — a 🎤 next to the field of a
// note, a question and a next question.
// - SpeechRecognition is a FAKE class (no microphone, no network): the test makes
//   it emit interim / final results and errors;
// - `bg-BG`, interim results live in grey, the final text at the cursor, editable;
//   a second press stops; "Слуша…" (aria-pressed, a status line);
// - errors in Bulgarian (no permission, no network → hidden, nothing heard);
//   no API / offline → no 🎤 (the keyboard's dictation stays);
// - the guard of the field holds (the focus stays in the field, the frame stays
//   guarded); the lesson never gets the text; no 🎤 in "Покажи промпта".
// NEVER a real request: api.anthropic.com is answered by page.route(); every other
// request leaving localhost is aborted and recorded. FAKE keys only (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

test.describe.configure({ timeout: 120000 });
test.use({ trace: 'off' });

const KEY = 'sk-ant-api03-FAKE-t041-4141414141-zz';
const API = /^https:\/\/api\.anthropic\.com\//;
const C = 'LRN-T41';

let problems;
let external;
let consoleAll;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  consoleAll = [];
  page.on('console', (m) => { consoleAll.push(m.text()); if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  if (!problems) return;
  expect(problems).toEqual([]);
  expect(external.filter((u) => !API.test(u))).toEqual([]);
  expect(consoleAll.join('\n')).not.toContain('FAKE');
});
const landscapeOnly = (ti, why = 'one orientation is enough') => test.skip(ti.project.name !== 'tablet-landscape', why);

const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
const lessonHtml = (title, body) => `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const FILL = Array.from({ length: 20 }, (_, i) => `<p>Абзац ${i} за превъртане на урока, текстът е само пълнеж.</p>`).join('');
// A lesson that logs every message it gets (the dictated text must never reach it).
const SPY = `<script>addEventListener('message', (e) => { try { console.log('LM:' + JSON.stringify(e.data)); } catch (err) { /* */ } }, true);
addEventListener('keydown', (e) => console.log('LK:' + e.key), true);</script>`;
const BODY = `<h2>Обхват</h2><p id="p1">Регламентът за киберустойчивост се прилага за продукти с цифрови елементи.</p>
<h2>Задължения</h2><p id="p2">Производителят оценява рисковете през целия жизнен цикъл.</p><p id="p3">Уязвимостите се докладват бързо.</p>${FILL}${SPY}`;
const FILES = {
  'INDEX.md': `# ${C}\n\n## Уроци\n| # | Заглавие |\n|---|---|\n| 0001 | Първи урок |\n`,
  'MISSION.md': '# Мисия\n\nИзмислена мисия за тест.\n',
  'lessons/0001-parvi.html': lessonHtml('Първи урок', BODY),
};

/**
 * The fake SpeechRecognition (top window only). window.__voice: { made, last, lang… };
 * __say(text, final) emits a result, __fail(code) an error (then the end), __end() the end.
 */
function fakeSpeech({ api = true } = {}) {
  return (opts) => {
    if (window.top !== window) return;
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    window.__voice = { made: 0, started: 0, stopped: 0, aborted: 0, last: null };
    if (!opts.api) return;
    class FakeRecognition {
      constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.results = []; window.__voice.made++; window.__voice.last = this; }
      start() { if (this.running) throw new Error('InvalidStateError'); this.running = true; window.__voice.started++; }
      stop() { window.__voice.stopped++; this.finish(); }
      abort() { window.__voice.aborted++; this.finish(); }
      finish() { if (!this.running) return; this.running = false; setTimeout(() => this.onend?.({}), 10); }
      emit(text, final) {
        // The browser keeps one list: the finished results, then the one being heard.
        const done = this.results.filter((r) => r.isFinal);
        const r = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: final });
        this.results = [...done, r];
        this.onresult?.({ resultIndex: done.length, results: this.results });
        if (final) this.results = [...done, r];
      }
    }
    window.webkitSpeechRecognition = FakeRecognition;
    window.__say = (text, final = true) => window.__voice.last.emit(text, final);
    window.__fail = (code) => { const r = window.__voice.last; r.onerror?.({ error: code }); r.finish(); };
    window.__end = () => window.__voice.last.finish();
  };
}

async function start(page, { api = true } = {}) {
  await page.addInitScript(fakeSpeech(), { api });
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
  const zip = asFile(`${C}.zip`, makeZip(toBytes(FILES), { root: C }));
  const r = await page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try { return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)])); } catch (err) { return `ERROR ${m.errorMessage(err)}`; }
  }, { name: zip.name, bytes: [...zip.buffer] });
  expect(r).not.toMatch(/^ERROR/);
  await page.evaluate(async (k) => { const db = await import('./src/db.js'); await db.saveApiKey(k); }, KEY);
}
async function lessonFrame(page) { return (await page.locator('iframe.lesson-frame').elementHandle()).contentFrame(); }
async function openLesson(page) {
  await page.goto(`./#/c/${C}/read/0001`);
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
const say = (page, text, final = true) => page.evaluate(([t, f]) => window.__say(t, f), [text, final]);
const voice = (page) => page.evaluate(() => ({ ...window.__voice, last: window.__voice.last && { lang: window.__voice.last.lang, interimResults: window.__voice.last.interimResults, continuous: window.__voice.last.continuous, running: window.__voice.last.running } }));
const liveNotes = async (page) => (await page.evaluate(async () => (await import('./src/db.js')).list('notes'))).filter((n) => !n.deleted);

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
    const r = route.request();
    seen.push(JSON.parse(r.postData()));
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' }, body: answerSse(`Отговор ${seen.length}.`) });
  });
  return seen;
}
const lastUserText = (body) => body.messages.at(-1).content.map((c) => c.text).join('');

// ---------------------------------------------------------------------------
test.describe('T041-N voice in a note (both orientations)', () => {
  test('N1 🎤 next to the note field: bg-BG, interim results in grey (not in the field), the final text into the field and saved as a note; "Слуша…" while it listens (aria-pressed); a second press stops; the field keeps the focus and its guard; the lesson gets no text and no key', async ({ page }) => {
    await start(page);
    const frame = await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(mic(page)).toBeVisible();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(mic(page)).toHaveAccessibleName('Гласово въвеждане на бележката');
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(voiceStatus(page)).toContainText('Слуша…');
    await expect(voiceStatus(page)).toHaveAttribute('role', 'status');
    await expect(mic(page)).toHaveAccessibleName('Спри гласовото въвеждане');
    expect((await voice(page)).last).toMatchObject({ lang: 'bg-BG', interimResults: true, running: true });
    // The press on 🎤 kept the focus in the field (the guard of the lesson frame stays on).
    await expect(noteText(page)).toBeFocused();
    await expect(page.locator('iframe.lesson-frame')).toHaveAttribute('data-note-guard', 'on');
    // Interim: grey, outside the field.
    await say(page, 'тайна диктовка за', false);
    await expect(interim(page)).toBeVisible();
    await expect(interim(page)).toHaveText('тайна диктовка за');
    await expect(noteText(page)).toHaveValue('');
    const grey = await interim(page).evaluate((el) => getComputedStyle(el).fontStyle);
    expect(grey).toBe('italic');
    // Final: into the field; the interim line goes.
    await say(page, 'Тайна диктовка за бележката', true);
    await expect(noteText(page)).toHaveValue('Тайна диктовка за бележката');
    await expect(interim(page)).toBeHidden();
    await say(page, 'второ изречение', true);
    await expect(noteText(page)).toHaveValue('Тайна диктовка за бележката второ изречение');
    // A second press stops.
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await voice(page)).stopped).toBe(1);
    await expect(voiceStatus(page)).toContainText('провери текста');
    // Saved as an ordinary note (editable before; autosave).
    await expect(page.locator('[data-field="note-status"]')).toHaveText('Записано.', { timeout: 5000 });
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Тайна диктовка за бележката второ изречение']);
    // The text can be edited by hand.
    await noteText(page).press('End');
    await noteText(page).pressSequentially('!');
    await expect(page.locator('[data-field="note-status"]')).toHaveText('Записано.', { timeout: 5000 });
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Тайна диктовка за бележката второ изречение!']);
    // The lesson never saw the text (messages) nor a key.
    const seenByLesson = consoleAll.filter((l) => l.startsWith('LM:') || l.startsWith('LK:')).join('\n');
    expect(seenByLesson).not.toContain('Тайна');
    expect(seenByLesson).not.toContain('диктовка');
    expect(seenByLesson).not.toMatch(/LK:/);
    expect(await frame.evaluate(() => document.body.innerText)).not.toContain('Тайна');
  });

  test('N2 the text goes in at the cursor (spaces added where needed), replacing a selected part; "Готово" while it listens stops it (no audio kept, the recognizer is gone)', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await noteText(page).fill('Начало край');
    await noteText(page).evaluate((el) => el.setSelectionRange(6, 6));
    await mic(page).click();
    await say(page, 'среда');
    await expect(noteText(page)).toHaveValue('Начало среда край');
    // The cursor is after the text put in: the next one follows it.
    await say(page, 'още');
    await expect(noteText(page)).toHaveValue('Начало среда още край');
    // A selected part is replaced.
    await noteText(page).evaluate((el) => el.setSelectionRange(0, 6));
    await say(page, 'Старт');
    await expect(noteText(page)).toHaveValue('Старт среда още край');
    await page.locator('[data-action="note-done"]').click();
    await expect(panel(page)).toBeHidden();
    const v = await voice(page);
    expect(v.aborted + v.stopped).toBeGreaterThanOrEqual(1);
    expect(v.last.running).toBe(false);
    expect((await liveNotes(page)).map((n) => n.body)).toEqual(['Старт среда още край']);
  });
});

test.describe('T041-Q voice in a question and a next question (both orientations)', () => {
  test('Q1 🎤 in the question field: the dictated question is sent as typed (edited first); the next question has its 🎤 too; "Покажи промпта" has none; the lesson never gets the text', async ({ page }) => {
    await start(page);
    const seen = await mockApi(page);
    const frame = await openLesson(page);
    await openQuestion(page, 'оценява рисковете');
    await expect(mic(page)).toHaveCount(1);
    await expect(mic(page)).toHaveAccessibleName('Гласово въвеждане на въпроса');
    await mic(page).click();
    await expect(qField(page)).toBeFocused();
    await say(page, 'Какво значи диктуван въпрос', true);
    await expect(qField(page)).toHaveValue('Какво значи диктуван въпрос');
    await mic(page).click();
    await qField(page).press('End');
    await qField(page).pressSequentially('?');
    // "Покажи промпта": no 🎤 there, the prompt has the dictated question.
    await page.locator('[data-action="question-prompt"]').click();
    await expect(page.locator('[data-field="question-prompt"]')).toContainText('Въпрос: Какво значи диктуван въпрос?');
    await expect(page.locator('[data-field="question-prompt"] [data-action="voice"]')).toHaveCount(0);
    await expect(mic(page)).toHaveCount(1);
    await page.locator('[data-action="question-send"]').click();
    await expect(answers(page).first()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(lastUserText(seen[0])).toContain('Въпрос: Какво значи диктуван въпрос?');
    // The next question: its own 🎤; sending while it listens stops it, the late text does not stay.
    await expect(qField(page)).toHaveAttribute('aria-label', 'Следващ въпрос към учителя');
    await expect(mic(page)).toBeVisible();
    await qField(page).click();
    await mic(page).click();
    await say(page, 'Следващ диктуван', true);
    await say(page, 'недовършено', false);
    await expect(qField(page)).toHaveValue('Следващ диктуван');
    await page.locator('[data-action="question-send"]').click();
    await expect(answers(page)).toHaveCount(2);
    await expect(answers(page).nth(1)).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    expect(lastUserText(seen[1])).toBe('Въпрос: Следващ диктуван');
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(qField(page)).toHaveValue('');
    expect((await voice(page)).aborted).toBe(1);
    const seenByLesson = consoleAll.filter((l) => l.startsWith('LM:') || l.startsWith('LK:')).join('\n');
    expect(seenByLesson).not.toContain('диктуван');
    expect(seenByLesson).not.toMatch(/LK:/);
    expect(await frame.evaluate(() => document.body.innerText)).not.toContain('диктуван');
  });

  test('Q2 a question about the whole lesson (💬 in the strip) has the 🎤 too', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await page.locator('[data-action="questions"]').click();
    await expect(qField(page)).toBeVisible();
    await expect(mic(page)).toBeVisible();
    await qField(page).click();
    await mic(page).click();
    await say(page, 'За целия урок');
    await expect(qField(page)).toHaveValue('За целия урок');
  });
});

test.describe('T041-E errors, no API, offline', () => {
  test('E1 errors in Bulgarian: no permission for the microphone, nothing heard, no microphone; no network → the 🎤 goes (the keyboard dictation stays); none is a console error', async ({ page }) => {
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    const cases = [
      ['not-allowed', 'Няма разрешение за микрофона'],
      ['no-speech', 'Нищо не се чу'],
      ['audio-capture', 'Микрофонът не е достъпен'],
      ['service-not-allowed', 'Няма разрешение за микрофона'],
    ];
    for (const [code, text] of cases) {
      await mic(page).click();
      await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate((c) => window.__fail(c), code);
      await expect(voiceStatus(page)).toContainText(text);
      await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(mic(page)).toBeVisible();
    }
    await mic(page).click();
    await page.evaluate(() => window.__fail('network'));
    await expect(voiceStatus(page)).toContainText('Няма връзка с мрежата');
    await expect(mic(page)).toBeHidden();
    await expect(noteText(page)).toBeVisible();
    await expect(noteText(page)).toBeEditable();
  });

  test('E2 no SpeechRecognition in the browser: no 🎤 in the note, the question or the next question; the fields work', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page, { api: false });
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(page.locator('[data-action="voice"]').locator('visible=true')).toHaveCount(0);
    await noteText(page).pressSequentially('Пиша');
    await expect(noteText(page)).toHaveValue('Пиша');
    await page.keyboard.press('Escape');
    await openQuestion(page, 'Уязвимостите се докладват');
    await expect(page.locator('[data-action="voice"]').locator('visible=true')).toHaveCount(0);
  });

  test('E3 offline: the 🎤 goes; online again: it is back', async ({ page, context }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(mic(page)).toBeVisible();
    await mic(page).click();
    await context.setOffline(true);
    await expect(mic(page)).toBeHidden();
    // Hidden while listening: it stops too.
    await expect.poll(async () => (await voice(page)).last.running).toBe(false);
    await context.setOffline(false);
    await expect(mic(page)).toBeVisible();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('E4 the microphone is only the app\'s: the lesson frame has no allow="microphone" and its responses say Permissions-Policy microphone=()', async ({ page }, ti) => {
    landscapeOnly(ti);
    await start(page);
    await openLesson(page);
    const allow = await page.locator('iframe.lesson-frame').getAttribute('allow');
    expect(allow || '').not.toMatch(/microphone/);
    const policy = await page.evaluate(async (c) => (await fetch(`./c/${c}/lessons/0001-parvi.html`)).headers.get('permissions-policy'), C);
    expect(policy).toContain('microphone=()');
  });
});

test.describe('T041-P a phone (360 × 800)', () => {
  test('P1 the note on the whole window: the 🎤 is on the screen next to the field and works; no horizontal scroll', async ({ page }, ti) => {
    landscapeOnly(ti, 'one window size');
    await page.setViewportSize({ width: 360, height: 800 });
    await start(page);
    await openLesson(page);
    await openNote(page, 'оценява рисковете');
    await expect(mic(page)).toBeVisible();
    const b = await mic(page).boundingBox();
    const f = await noteText(page).boundingBox();
    expect(b.x + b.width).toBeLessThanOrEqual(360);
    expect(b.width).toBeGreaterThanOrEqual(40);
    expect(b.x).toBeGreaterThanOrEqual(f.x + f.width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await mic(page).click();
    await say(page, 'От телефона');
    await expect(noteText(page)).toHaveValue('От телефона');
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('P2 the question on the whole window: the 🎤 is on the screen and works', async ({ page }, ti) => {
    landscapeOnly(ti, 'one window size');
    await page.setViewportSize({ width: 360, height: 800 });
    await start(page);
    await openLesson(page);
    await openQuestion(page, 'оценява рисковете');
    await expect(mic(page)).toBeInViewport();
    await mic(page).click();
    await say(page, 'Въпрос от телефона');
    await expect(qField(page)).toHaveValue('Въпрос от телефона');
  });
});
