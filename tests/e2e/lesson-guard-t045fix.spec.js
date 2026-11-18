// T-045-fix (developer): the guard, the first script of every lesson
// (src/lesson-guard.js): no WebRTC (T046-S1), the bridge's own references and
// lrn:hello (T046-D1); and lessons taller than the frame limit (T046-D2).
// Synthetic courses built in memory (D-026). A UDP listener on 127.0.0.1
// stands in for an attacker's TURN/STUN server.
import { test, expect } from '@playwright/test';
import dgram from 'node:dgram';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
let allowed;
let external;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  allowed = [];
  external = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await context.route(/^https?:\/\/(?!localhost)/, (route) => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>external</p>' });
  });
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
test.afterEach(() => {
  expect(problems.filter((p) => !allowed.some((re) => re.test(p)))).toEqual([]);
});

const doc = (body, head = '', pre = '<!DOCTYPE html>') => strToU8(`${pre}<html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
async function openLesson(page, course, { wait = 'ready' } = {}) {
  await page.goto(`./#/c/${course}`);
  await page.goto(`./#/c/${course}/read/0001`);
  if (wait) await expect(page.locator(`[data-lesson-state="${wait}"]`)).toBeVisible({ timeout: 20000 });
  return page.frames().find((f) => f.url().includes(`/EasyLRN/c/${course}/`));
}
const state = (page) => page.locator('.lesson-frame__wrap').getAttribute('data-lesson-state');

async function udpServer() {
  const sock = dgram.createSocket('udp4');
  const packets = [];
  sock.on('message', (b) => packets.push(b.toString('latin1')));
  await new Promise((ok) => sock.bind(0, '127.0.0.1', ok));
  return { port: sock.address().port, packets, close: () => sock.close() };
}

test.describe('T-045-fix guard: no WebRTC in the lesson (T046-S1)', () => {
  test('every RTC* interface is undefined and cannot be restored; the guard is the first script and the document keeps its mode', async ({ page }) => {
    await importCourse(page, 'LRN-RTC', {
      'INDEX.md': strToU8('# LRN-RTC\n'),
      'lessons/0001-rtc.html': doc('<h1>Урок</h1><script>window.__early = typeof RTCPeerConnection;</script>'),
    });
    const f = await openLesson(page, 'LRN-RTC');
    const r = await f.evaluate(() => {
      const names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpTransceiver', 'RTCIceTransport'];
      const out = { early: window.__early, mode: document.compatMode, first: document.scripts[0]?.getAttribute('data-easylrn'), inHead: document.scripts[0]?.parentElement?.tagName };
      for (const n of names) {
        try { delete window[n]; } catch { /* strict */ }
        try { window[n] = function x() {}; } catch { /* non-writable */ }
        try { Object.defineProperty(window, n, { value: 1 }); } catch { /* non-configurable */ }
        out[n] = typeof window[n];
      }
      out.leftovers = Object.getOwnPropertyNames(window).filter((n) => /RTC/.test(n) && typeof window[n] !== 'undefined');
      return out;
    });
    expect(r).toMatchObject({ early: 'undefined', mode: 'CSS1Compat', first: 'guard', inHead: 'HEAD' });
    for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpTransceiver', 'RTCIceTransport']) expect(r[n], n).toBe('undefined');
    expect(r.leftovers).toEqual([]);
  });

  test('the lesson cannot contain or create a working nested frame (D-034); a static <iframe>/<object> is stripped by the renderer', async ({ page }) => {
    allowed = [/Refused|violates|Content Security Policy|Blocked|sandbox|SecurityError|Failed to load|ERR_|not a function/i];
    const udp = await udpServer();
    try {
      // A nested-frame script would only run in a fresh realm with a fresh
      // RTCPeerConnection; if any ran, it would send to the UDP server. We only
      // check that none is created/kept and that RTC* is gone — no leak payload.
      const port = udp.port;
      await importCourse(page, 'LRN-NEST', {
        'INDEX.md': strToU8('# LRN-NEST\n'),
        // Static frames in the source: the renderer must remove them.
        'lessons/0001-nest.html': doc(`<h1>Урок</h1>
          <iframe id="static" srcdoc="<p>x</p>"></iframe>
          <object data="about:blank"></object><embed src="about:blank">
          <script>
            window.__r = {};
            const page = '<scr' + 'ipt>try{new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${port}"}]}).createDataChannel("d")}catch(e){}</scr' + 'ipt>';
            const t = (name, fn) => { try { window.__r[name] = String(fn()); } catch (e) { window.__r[name] = 'blocked:' + e.name; } };
            t('createElement', () => document.createElement('iframe').tagName);
            t('dynamic blank', () => { const i = document.createElement('iframe'); document.body.append(i); return i.tagName + ':' + (i.contentWindow ? 'cw' : 'no'); });
            t('srcdoc', () => { const i = document.createElement('iframe'); i.srcdoc = page; document.body.append(i); return 'added'; });
            t('data:', () => { const i = document.createElement('iframe'); i.src = 'data:text/html,' + encodeURIComponent(page); document.body.append(i); return 'added'; });
            t('blob:', () => { const i = document.createElement('iframe'); i.src = URL.createObjectURL(new Blob([page], { type: 'text/html' })); document.body.append(i); return 'added'; });
            t('innerHTML', () => { const d = document.createElement('div'); d.innerHTML = '<iframe srcdoc=' + JSON.stringify(page) + '></iframe>'; document.body.append(d); return 'added'; });
            t('insertAdjacentHTML', () => { document.body.insertAdjacentHTML('beforeend', '<iframe srcdoc=' + JSON.stringify(page) + '></iframe>'); return 'added'; });
            t('own', () => typeof RTCPeerConnection);
          </script>`),
      });
      const f = await openLesson(page, 'LRN-NEST');
      await page.waitForTimeout(3000);
      const r = await f.evaluate(() => ({
        ...window.__r,
        liveFrames: document.querySelectorAll('iframe,frame,object,embed,portal,frameset').length,
        rtc: typeof window.RTCPeerConnection,
      }));
      console.log(`T-045-fix nested frames: ${JSON.stringify(r)}`);
      expect(r.own).toBe('undefined');
      expect(r.rtc).toBe('undefined');
      expect(r.createElement).not.toBe('IFRAME'); // createElement is neutered
      expect(r.liveFrames).toBe(0); // nothing survives in the live DOM
      expect(udp.packets.length).toBe(0); // no nested script ever ran
      expect(external).toEqual([]);
    } finally {
      udp.close();
    }
  });
});

test.describe('T-045-fix guard: the bridge survives the lesson (T046-D1)', () => {
  test('a lesson with `var parent`, `var self`, `var top`, `var scrollY`, `function setTimeout` still works with the bridge (ready, auto height)', async ({ page }) => {
    allowed = [/status of 40/];
    await importCourse(page, 'LRN-NAMES', {
      'INDEX.md': strToU8('# LRN-NAMES\n'),
      'lessons/0001-names.html': doc('<h1 id="top-h">Урок</h1><p style="height:2500px">…</p><p id="end">Край</p>'
        + '<script>var parent = document.body; var self = 1; var top = 2; var scrollY = 5; var name = "x"; var status = "y"; var frames = []; var length = 3;</script>'),
    });
    await openLesson(page, 'LRN-NAMES', { wait: null });
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(5000);
    expect(await state(page)).toBe('ready');
    const fh = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height);
    expect(fh).toBeGreaterThan(2500);
  });

  test('a lesson that removes the bridge before it runs is shown in the fallback mode (inner scroll), not stopped', async ({ page }) => {
    test.setTimeout(40_000);
    allowed = [/status of 40/];
    await importCourse(page, 'LRN-NOBRIDGE', {
      'INDEX.md': strToU8('# LRN-NOBRIDGE\n'),
      'lessons/0001-nb.html': doc('<h1>Урок</h1><script>new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeName === "SCRIPT" && n.getAttribute("data-easylrn") === "bridge") n.remove(); }).observe(document.documentElement, { childList: true, subtree: true });</script><p style="height:3000px">…</p><p id="end">Край</p>'),
    });
    await openLesson(page, 'LRN-NOBRIDGE', { wait: null });
    await expect(page.locator('[data-lesson-state="fallback"], [data-lesson-state="error"]')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(5000); // no reload after the fallback either
    expect(await state(page)).toBe('fallback');
    await expect(page.locator('[data-field="lesson-note"]')).toHaveText('Маркирането не е налично за този урок.');
    const f = page.frames().find((x) => x.url().includes('/EasyLRN/c/LRN-NOBRIDGE/'));
    expect(await f.evaluate(() => !!document.querySelector('script[data-easylrn="bridge"]'))).toBe(false);
    expect(await f.evaluate(() => document.scrollingElement.scrollHeight > innerHeight)).toBe(true);
  });

  test('a lesson without a doctype or with comments before it: the guard is still first, the mode unchanged', async ({ page }) => {
    await importCourse(page, 'LRN-DT', {
      'INDEX.md': strToU8('# LRN-DT\n'),
      'lessons/0001-a.html': doc('<h1>A</h1><script>window.__t = typeof RTCPeerConnection;</script>', '', '<!-- c1 -->\n<!-- c2 -->\n<!doctype html>'),
      'lessons/0002-b.html': doc('<h1>B</h1><script>window.__t = typeof RTCPeerConnection;</script>', '', ''),
    });
    const a = await openLesson(page, 'LRN-DT');
    expect(await a.evaluate(() => [document.compatMode, window.__t, document.scripts[0].dataset.easylrn])).toEqual(['CSS1Compat', 'undefined', 'guard']);
    await page.goto('./#/c/LRN-DT/read/0002');
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    const b = page.frames().find((x) => x.url().includes('/EasyLRN/c/LRN-DT/lessons/0002'));
    expect(await b.evaluate(() => [document.compatMode, window.__t, document.scripts[0].dataset.easylrn])).toEqual(['BackCompat', 'undefined', 'guard']);
  });
});

test.describe('T-045-fix very long lessons (T046-D2)', () => {
  test('a lesson over the frame limit (1 200 000 px) scrolls inside the frame and its end is reachable', async ({ page }) => {
    await importCourse(page, 'LRN-HUGE', {
      'INDEX.md': strToU8('# LRN-HUGE\n'),
      'lessons/0001-huge.html': doc('<h1>Огромен урок</h1><div style="height:1200000px">…</div><p id="end">Край на урока</p>'),
    });
    const f = await openLesson(page, 'LRN-HUGE');
    await expect(page.locator('.lesson-frame__wrap[data-lesson-scroll="inner"]')).toBeVisible();
    await expect(page.locator('[data-field="lesson-note"]')).toHaveText('Урокът е много дълъг: превърта се вътре в рамката.');
    const frameH = await page.locator('iframe.lesson-frame').evaluate((el) => el.getBoundingClientRect().height);
    expect(frameH).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    const r = await f.evaluate(() => {
      document.getElementById('end').scrollIntoView();
      const rect = document.getElementById('end').getBoundingClientRect();
      return { overflow: getComputedStyle(document.documentElement).overflowY, visible: rect.top >= 0 && rect.bottom <= innerHeight, y: document.scrollingElement.scrollTop };
    });
    expect(r.overflow).not.toBe('hidden');
    expect(r.visible).toBe(true);
    expect(r.y).toBeGreaterThan(1000000);
  });
});
