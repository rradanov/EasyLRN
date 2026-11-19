// T-019 (developer): the screen "Настройки" — the Claude API key (save, show,
// delete, check), model, cost threshold, spend of the month, text size, theme,
// storage, version — and where the key may and may not go (D-037).
//
// Never real network: every request that leaves localhost is aborted and
// recorded; api.anthropic.com is answered by page.route() mocks only. Only
// FAKE keys are used.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';

const KEY = 'sk-ant-test-FAKE-0000';
const KEY2 = 'sk-ant-test-FAKE-1234';
const APP_VERSION = /APP_VERSION = '([^']+)'/.exec(readFileSync(new URL('../../src/config.js', import.meta.url), 'utf8'))[1];
const API = /^https:\/\/api\.anthropic\.com\//;

let logs; // every console message and page error, of every frame
let external; // requests that tried to leave localhost (none may reach a real host)
test.beforeEach(async ({ page, context }) => {
  logs = [];
  external = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
  await context.route(/^https?:\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => {
  // The key never shows up in the console or an error, whatever the test did.
  const all = logs.join('\n');
  expect(all).not.toContain('FAKE');
  // Chromium logs every failed API response ("Failed to load resource: … 401"); nothing else may fail.
  expect(logs.filter((l) => /^(error|pageerror)/.test(l) && !/^error: Failed to load resource/.test(l))).toEqual([]);
  expect(external.filter((u) => !API.test(u))).toEqual([]);
});

const screen = (page) => page.locator('[data-screen="settings"]');
const field = (page, name) => page.locator(`[data-screen="settings"] [data-field="${name}"]`);
async function openSettings(page) {
  await page.goto('./#/settings');
  await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
}
async function saveKey(page, key = KEY) {
  await field(page, 'api-key').fill(key);
  await field(page, 'key-save').click();
  await expect(field(page, 'key-status')).toHaveText(`Запазен ключ: •••• ${key.slice(-4)}`);
}
/** Mock the Messages API; `answer(request)` returns { status, json } or 'abort'. */
async function mockApi(page, answer) {
  const seen = [];
  await page.route(API, async (route) => {
    const r = route.request();
    seen.push({ method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() });
    const a = await answer(r);
    if (a === 'abort') return route.abort('internetdisconnected');
    return route.fulfill({
      status: a.status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(a.json ?? {}),
    });
  });
  return seen;
}
const OK = { status: 200, json: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'p' }], stop_reason: 'max_tokens', usage: { input_tokens: 8, output_tokens: 1 } } };
const err = (status, type) => ({ status, json: { type: 'error', error: { type, message: `mock ${type} — must never be shown` } } });

test.describe('T-019 the screen', () => {
  test('entry from the main screen, the sections, the reminder next to the key, the version', async ({ page }) => {
    await page.locator('#nav-settings').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(screen(page).locator('h2')).toHaveText(['AI учител', 'Четене', 'Данни', 'За приложението']);
    await expect(field(page, 'key-warning')).toBeVisible();
    await expect(field(page, 'key-warning')).toContainText('Уроците никога не искат API ключ. Въвеждай го само тук.');
    await expect(field(page, 'key-warning')).toContainText('Ползвай отделен ключ с месечен лимит от Claude Console.');
    await expect(field(page, 'api-key')).toHaveAttribute('data-masked', 'yes'); // T-052: type=text + text-security (no "save password")
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
    await expect(field(page, 'key-check')).toBeDisabled();
    await expect(field(page, 'key-delete')).toBeDisabled();
    await expect(field(page, 'model')).toHaveValue('claude-sonnet-5-5');
    expect(await field(page, 'model').locator('option').evaluateAll((o) => o.map((x) => x.value))).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
    await expect(field(page, 'budget')).toHaveValue('5');
    await expect(field(page, 'spend')).toHaveText('$0.00 (0 извиквания)');
    await expect(field(page, 'font-scale')).toHaveText('100 %');
    await expect(page.locator('#settings-theme-system')).toBeChecked();
    await expect(field(page, 'storage')).toHaveText(/^[\d ,]+ (B|KB|MB|GB) от [\d ,]+ (B|KB|MB|GB|TB)$/);
    await expect(field(page, 'persist')).not.toHaveText('…');
    await expect(field(page, 'version')).toHaveText(APP_VERSION);
    // Nothing on this screen overflows sideways; touch targets are ≥ 44 px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const name of ['api-key', 'key-show', 'key-save', 'key-check', 'key-delete', 'model', 'budget', 'font-smaller', 'font-bigger']) {
      const box = await field(page, name).boundingBox();
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
  });

  test('model, threshold, text size and theme are saved and survive a reload; the spend of the month is shown against the threshold', async ({ page }) => {
    await openSettings(page);
    await field(page, 'model').selectOption('claude-haiku-5-5');
    await field(page, 'budget').fill('-1');
    await field(page, 'budget').press('Tab');
    await expect(field(page, 'budget-message')).toHaveText('Прагът е число от 0 до 1000.');
    await expect(field(page, 'budget')).toHaveValue('5');
    await field(page, 'budget').fill('7.5');
    await field(page, 'budget').press('Tab');
    await expect(field(page, 'budget-message')).toHaveText('Запазено.');
    await field(page, 'font-bigger').click();
    await expect(field(page, 'font-scale')).toHaveText('110 %');
    await field(page, 'font-smaller').click();
    await field(page, 'font-smaller').click();
    await expect(field(page, 'font-scale')).toHaveText('90 %');
    for (let i = 0; i < 5; i++) await field(page, 'font-smaller').click({ force: true });
    await expect(field(page, 'font-scale')).toHaveText('80 %');
    await expect(field(page, 'font-smaller')).toBeDisabled();
    const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches) ? null : await paper();
    await page.locator('#settings-theme-dark').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(paper).toBe('rgb(21, 21, 19)');
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      await db.logUsage({ model: 'claude-sonnet-5-5', kind: 'answer', input: 10, output: 10, estCostUSD: 8 });
      await db.logUsage({ at: '2000-01-01T00:00:00.000Z', model: 'claude-sonnet-5-5', kind: 'answer', estCostUSD: 99 }); // another month
    });
    await page.reload();
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(field(page, 'model')).toHaveValue('claude-haiku-5-5');
    await expect(field(page, 'budget')).toHaveValue('7.5');
    await expect(field(page, 'font-scale')).toHaveText('80 %');
    await expect(page.locator('#settings-theme-dark')).toBeChecked();
    await expect(field(page, 'spend')).toHaveText('$8.00 (1 извикване)');
    await expect(field(page, 'spend-warning')).toHaveText('Разходът за месеца е над прага от $7.50.');
    const s = await page.evaluate(async () => (await import('./src/db.js')).getSettings());
    expect([s.model, s.monthlyBudgetUSD, s.fontScale, s.theme]).toEqual(['claude-haiku-5-5', 7.5, 0.8, 'dark']);
    await page.locator('#settings-theme-light').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(paper).toBe('rgb(255, 255, 248)');
    await page.locator('#settings-theme-system').check();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
    if (light) expect(await paper()).toBe(light);
  });
});

test.describe('T-019 the API key', () => {
  test('save: checked, stored in its own store (not settings, not localStorage), shown only as the last 4 characters; never in the DOM after saving', async ({ page }) => {
    await openSettings(page);
    const input = field(page, 'api-key');
    await input.fill('abc');
    await field(page, 'key-save').click();
    await expect(field(page, 'key-message')).toHaveText(/започва със „sk-ant-“/);
    await input.fill('sk-ant-<script>');
    await field(page, 'key-save').click();
    await expect(field(page, 'key-message')).toHaveText(/непозволени знаци/); // T-052 (T051-I2): was "не прилича на ключ"
    await expect(field(page, 'key-message')).not.toContainText('<script>');
    // "Покажи" / "Скрий" — what is being typed; the value is never an attribute.
    await input.fill(`  ${KEY}\n`);
    await field(page, 'key-show').click();
    await expect(input).toHaveAttribute('data-masked', 'no'); // T-052: was type=text
    await expect(field(page, 'key-show')).toHaveText('Скрий');
    await expect(field(page, 'key-show')).toHaveAttribute('aria-pressed', 'true');
    expect(await input.getAttribute('value')).toBeNull();
    await field(page, 'key-show').click();
    await expect(input).toHaveAttribute('data-masked', 'yes'); // T-052: was type=password
    await expect(field(page, 'key-show')).toHaveText('Покажи');
    await field(page, 'key-show').click(); // left visible: saving hides it again
    await field(page, 'key-save').click();
    await expect(field(page, 'key-status')).toHaveText('Запазен ключ: •••• 0000');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('data-masked', 'yes'); // T-052: was type=password
    await expect(field(page, 'key-check')).toBeEnabled();
    await expect(field(page, 'key-delete')).toBeEnabled();
    const where = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const ls = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      return { key: await db.getApiKey(), settings: JSON.stringify(await db.getSettings()), ls, html: document.documentElement.outerHTML, title: document.title };
    });
    expect(where.key).toBe(KEY); // spaces and the line break from pasting are dropped
    expect(where.settings).not.toContain('FAKE');
    expect(where.ls).not.toContain('FAKE');
    expect(where.html).not.toContain('FAKE');
    // After a reload: still saved, still masked, the field empty.
    await page.reload();
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(field(page, 'key-status')).toHaveText('Запазен ключ: •••• 0000');
    await expect(input).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes('FAKE'))).toBe(false);
    // A new key replaces the old one.
    await saveKey(page, KEY2);
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBe(KEY2);
  });

  test('delete: asks first (focus on "Отказ"), "Отказ" keeps the key, "Изтрий ключа" removes it for real', async ({ page }) => {
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-delete').click();
    const box = page.getByRole('alertdialog', { name: 'Изтриване на API ключа' });
    await expect(box).toBeVisible();
    await expect(box.locator('[data-field="confirm-no"]')).toBeFocused();
    await page.keyboard.press('Enter'); // Enter = "Отказ"
    await expect(box).toHaveCount(0);
    await expect(field(page, 'key-status')).toHaveText('Запазен ключ: •••• 0000');
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBe(KEY);
    await field(page, 'key-delete').click();
    await box.locator('[data-field="confirm-yes"]').click();
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
    await expect(field(page, 'key-message')).toHaveText('Ключът е изтрит.');
    await expect(field(page, 'key-check')).toBeDisabled();
    const left = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const conn = await db.openDb();
      return { key: await db.getApiKey(), records: await conn.count(db.STORES.secrets) };
    });
    expect(left).toEqual({ key: '', records: 0 });
    await page.reload();
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
  });

  test('"Провери": one minimal Messages call with the right headers; 200 / 401 / 403 / 404 / 429 / 529 / 500 / no network give a clear Bulgarian text', async ({ page }) => {
    await openSettings(page);
    await saveKey(page);
    const answers = [OK, err(401, 'authentication_error'), err(403, 'permission_error'), err(404, 'not_found_error'),
      err(429, 'rate_limit_error'), err(529, 'overloaded_error'), err(500, 'api_error'), 'abort'];
    let n = 0;
    const seen = await mockApi(page, () => answers[n++]);
    const expected = [
      'Ключът работи (claude-sonnet-5-5).',
      /^Ключът е невалиден \(401\)/,
      /^Ключът няма право на тази заявка \(403\)/,
      /^Моделът „claude-sonnet-5-5“ не е намерен .* \(404\)/,
      /зает .*\(429\)/,
      /претоварен .*\(529\)/,
      /^Грешка в Claude API \(500\)/,
      /^Няма (интернет )?връзка/,
    ];
    for (const text of expected) {
      await field(page, 'key-check').click();
      await expect(field(page, 'key-message')).toHaveText(text);
      await expect(field(page, 'key-message')).not.toContainText('mock'); // the API's own message text is never shown
      await expect(field(page, 'key-check')).toBeEnabled();
    }
    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(expected.length);
    for (const s of posts) {
      expect(s.url).toBe('https://api.anthropic.com/v1/messages');
      expect(s.headers['x-api-key']).toBe(KEY);
      expect(s.headers['anthropic-version']).toBe('2023-06-01');
      expect(s.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
      expect(s.headers['content-type']).toBe('application/json');
      expect(s.headers.cookie).toBeUndefined();
      expect(s.headers.referer).toBeUndefined();
      expect(JSON.parse(s.body)).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
      expect(s.url).not.toContain('FAKE');
    }
    // The chosen model is the one checked.
    await field(page, 'model').selectOption('claude-opus-5-5');
    n = 0;
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText('Ключът работи (claude-opus-5-5).');
    expect(JSON.parse(seen.at(-1).body).model).toBe('claude-opus-5-5');
    // No key saved: the button is disabled, nothing is sent.
    await page.evaluate(async () => (await import('./src/db.js')).deleteApiKey());
    await page.reload();
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(field(page, 'key-check')).toBeDisabled();
  });

  test('checkKey(): a hanging API ends with a timeout text; no key → no request', async ({ page }) => {
    await page.route(API, () => { /* never answers */ });
    const r = await page.evaluate(async (k) => {
      const c = await import('./src/claude.js');
      return [await c.checkKey({ apiKey: k, model: 'claude-sonnet-5-5', timeoutMs: 300 }), await c.checkKey({ apiKey: '', model: 'x' })];
    }, KEY);
    expect(r[0]).toMatchObject({ ok: false, kind: 'timeout', status: 0 });
    expect(r[0].text).toMatch(/^Няма отговор от api\.anthropic\.com/);
    expect(r[1]).toMatchObject({ ok: false, kind: 'no-key' });
    expect(JSON.stringify(r)).not.toContain('FAKE');
  });

  test('the key never reaches a lesson: not in what the app posts to the frame, not in the served lesson, not readable from it; lessons keep connect-src \'none\'', async ({ page, context }) => {
    // Every message a lesson document receives, recorded inside it before any of its scripts.
    await context.addInitScript(() => {
      if (!location.pathname.includes('/c/')) return;
      window.__got = [];
      addEventListener('message', (e) => { try { window.__got.push(JSON.stringify(e.data)); } catch { window.__got.push(String(e.data)); } }, true);
    });
    await openSettings(page);
    await saveKey(page);
    const files = readFixture();
    await page.evaluate(async (f) => {
      const m = await import('./src/course-import.js');
      await m.importCourse([new File([new Uint8Array(f.bytes)], f.name)]);
    }, (() => { const z = asFile(DRIVE_ZIP_NAME, makeZip(files)); return { name: z.name, bytes: [...z.buffer] }; })());
    await page.goto('./#/c/LRN-DEMO');
    await page.goto('./#/c/LRN-DEMO/read/0001');
    const wrap = page.locator('.lesson-frame__wrap').first();
    await expect(wrap).toHaveAttribute('data-lesson-state', 'ready', { timeout: 20000 });
    // A settings change while the lesson is open (the app posts lrn:settings).
    await page.evaluate(async () => (await import('./src/db.js')).saveSettings({ fontScale: 1.25 }));
    await page.waitForTimeout(500);
    const f = page.frames().find((x) => x.url().includes('/EasyLRN/c/LRN-DEMO/'));
    expect(f).toBeTruthy();
    const inside = await f.evaluate(async () => {
      const attempt = async (fn) => { try { return await fn(); } catch (e) { return `blocked:${e.name}`; } };
      return {
        got: window.__got,
        html: document.documentElement.outerHTML.includes('FAKE'),
        name: String(window.name).includes('FAKE'),
        idb: await attempt(() => new Promise((ok, fail) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => ok('opened'); r.onerror = () => fail(r.error); })),
        parent: await attempt(() => String(parent.document.body.innerHTML).includes('FAKE')),
      };
    });
    expect(inside.got.length).toBeGreaterThan(0); // lrn:init and lrn:settings at least
    expect(inside.got.some((m) => m.includes('lrn:settings'))).toBe(true);
    expect(inside.got.join('\n')).not.toContain('FAKE');
    expect(inside.got.join('\n')).not.toContain('apiKey');
    expect(inside).toMatchObject({ html: false, name: false });
    expect(inside.idb).toMatch(/^blocked:/);
    expect(inside.parent).toMatch(/^blocked:/);
    const served = await page.evaluate(async () => {
      const r = await fetch('./c/LRN-DEMO/lessons/0001-vidove-chay.html');
      return { csp: r.headers.get('content-security-policy'), body: (await r.text()).includes('FAKE') };
    });
    expect(served.body).toBe(false);
    expect(served.csp).toContain("connect-src 'none'");
    expect(served.csp).toContain('sandbox allow-scripts');
    // The app itself may talk to the API (and only the app).
    const appCsp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(appCsp).toMatch(/connect-src 'self' https:\/\/api\.anthropic\.com;/);
  });
});
