// T-004: end-to-end tests for the EasyLRN PWA shell (T-003).
// Covers: loading without console errors, hash routes and history "Back",
// Service Worker + offline reload, manifest/installability, CSP, sub-path.
//
// Note: the app CSP has no 'unsafe-eval', so page.waitForFunction() is not
// used here (it evaluates a string in the page). Use page.evaluate() with
// promises or expect.poll() instead.
import { test, expect } from '@playwright/test';

/** Collect everything that would show up as a problem in DevTools. */
function watchProblems(page) {
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return problems;
}

const screen = (page, name) => page.locator(`[data-screen="${name}"]`);
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

/** Load the app, wait for the SW and reload so the page is controlled by it. */
async function loadControlled(page) {
  await page.goto('./');
  await expect(screen(page, 'courses')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(screen(page, 'courses')).toBeVisible();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test.describe('loading', () => {
  test('opens the courses screen without console errors', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto('./');
    await expect(page).toHaveTitle('EasyLRN');
    await expect(page.locator('#app-bar-title')).toHaveText('EasyLRN');
    await expect(screen(page, 'courses').getByRole('heading', { name: 'Моите курсове' })).toBeVisible();
    await expect(page.locator('#update-banner')).toBeHidden();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await expect(screen(page, 'courses')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('every request stays under the /EasyLRN/ sub-path', async ({ page, baseURL }) => {
    const outside = [];
    const origin = new URL(baseURL).origin;
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith(origin) && !url.startsWith(baseURL)) outside.push(url);
      if (!url.startsWith(origin) && !url.startsWith('data:')) outside.push(url);
    });
    await loadControlled(page);
    for (const hash of ['#/settings', '#/c/LRN-DEMO', '#/c/LRN-DEMO/read/0001?path=st1/st2']) {
      await go(page, hash);
    }
    expect(outside).toEqual([]);
  });

  test('has a strict CSP meta tag that blocks inline scripts', async ({ page }) => {
    await page.goto('./');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    const ran = await page.evaluate(() => {
      window.__inline = false;
      const s = document.createElement('script');
      s.textContent = 'window.__inline = true';
      document.head.append(s);
      return window.__inline;
    });
    expect(ran).toBe(false);
  });

  test('manifest is valid and Chrome reports the app as installable', async ({ page, baseURL }) => {
    await loadControlled(page);
    const cdp = await page.context().newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(manifest.url).toBe(`${baseURL}manifest.webmanifest`);
    const data = JSON.parse(manifest.data);
    expect(data.display).toBe('standalone');
    expect(data.orientation).toBe('any');
    expect(data.start_url).toBe('./');
    expect(data.scope).toBe('./');
    const sizes = data.icons.map((i) => `${i.sizes}/${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192/any', '512x512/any', '192x192/maskable', '512x512/maskable']));
    for (const icon of data.icons) {
      const res = await page.request.get(icon.src);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type']).toContain('image/png');
    }
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]);
  });
});

test.describe('routes', () => {
  test('gear, app-bar back link and browser Back/Forward', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto('./');
    await expect(screen(page, 'courses')).toBeVisible();

    await page.locator('#nav-settings').click();
    await expect(screen(page, 'settings')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page).toHaveTitle('Настройки · EasyLRN');
    await expect(page.locator('#nav-settings')).toBeHidden();
    await expect(page.locator('[data-field="version"]')).toHaveText(/^\d+\.\d+\.\d+$/);

    await page.goBack();
    await expect(screen(page, 'courses')).toBeVisible();
    await expect(page.locator('#nav-settings')).toBeVisible();

    await go(page, '#/c/LRN-DEMO');
    await expect(screen(page, 'course')).toBeVisible();
    await expect(page.locator('#app-bar-title')).toHaveText('LRN-DEMO');

    await go(page, '#/c/LRN-DEMO/read/0001?path=st1/st2');
    await expect(screen(page, 'reader')).toBeVisible();
    await expect(page.locator('.breadcrumb')).toHaveText('Урок 0001 › st1 › st2');

    // "‹ LRN-DEMO" in the app bar goes up one level.
    await page.locator('.back-link').click();
    await expect(screen(page, 'course')).toBeVisible();
    await expect(page).toHaveURL(/#\/c\/LRN-DEMO$/);

    // Browser history: course ← reader ← course ← courses.
    await page.goBack();
    await expect(screen(page, 'reader')).toBeVisible();
    await page.goBack();
    await expect(screen(page, 'course')).toBeVisible();
    await page.goBack();
    await expect(screen(page, 'courses')).toBeVisible();
    await page.goForward();
    await expect(screen(page, 'course')).toBeVisible();

    await page.locator('.back-link').click();
    await expect(screen(page, 'courses')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('deep links, unknown routes and odd parameters', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto('./#/c/LRN-DEMO/read/0001?path=a/b');
    await expect(screen(page, 'reader')).toBeVisible();
    await expect(page.locator('.back-link')).toHaveAttribute('href', '#/c/LRN-DEMO');

    await go(page, '#/no/such/page');
    await expect(screen(page, 'not-found')).toBeVisible();
    await page.getByRole('link', { name: 'Към курсовете' }).click();
    await expect(screen(page, 'courses')).toBeVisible();

    await go(page, `#/c/${encodeURIComponent('Курс 1')}`);
    await expect(page.locator('#app-bar-title')).toHaveText('Курс 1');

    // Malformed percent-encoding must not crash the router.
    await go(page, '#/c/%E0%A4%A');
    await expect(screen(page, 'course')).toBeVisible();

    // Parameters are rendered as text, never as markup.
    await go(page, `#/c/${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
    await expect(page.locator('#app-bar-title')).toHaveText('<img src=x onerror=alert(1)>');
    await expect(page.locator('header img, main img')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('touch targets in the app bar are at least 44 px', async ({ page }) => {
    await page.goto('./#/c/LRN-DEMO');
    await expect(screen(page, 'course')).toBeVisible();
    for (const selector of ['#nav-settings', '.back-link']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.width, selector).toBeGreaterThanOrEqual(44);
      expect(box.height, selector).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

test.describe('offline', () => {
  test('Service Worker registers with the /EasyLRN/ scope and precaches the shell', async ({ page, baseURL }) => {
    await loadControlled(page);
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const cache = await caches.open(keys.find((k) => k.startsWith('easylrn-shell-')));
      const urls = (await cache.keys()).map((r) => new URL(r.url).pathname);
      return { scope: reg.scope, keys, urls };
    });
    expect(info.scope).toBe(baseURL);
    expect(info.keys.filter((k) => k.startsWith('easylrn-shell-'))).toHaveLength(1);
    expect(info.urls).toEqual(expect.arrayContaining([
      '/EasyLRN/', '/EasyLRN/index.html', '/EasyLRN/manifest.webmanifest', '/EasyLRN/styles/app.css',
      '/EasyLRN/src/main.js', '/EasyLRN/src/router.js',
    ]));
  });

  test('offline reload shows the shell and all routes work', async ({ page, context }) => {
    const problems = watchProblems(page);
    await loadControlled(page);
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(screen(page, 'courses').getByRole('heading', { name: 'Моите курсове' })).toBeVisible();
      // Styles come from the cache too.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');

      await page.goto('./#/settings');
      await expect(screen(page, 'settings')).toBeVisible();
      await expect(page.locator('[data-field="offline"]')).toHaveText('готов');

      await page.goto('./index.html#/c/LRN-DEMO');
      await expect(screen(page, 'course')).toBeVisible();

      await page.goto('./?source=pwa#/c/LRN-DEMO/read/0001?path=st1');
      await expect(screen(page, 'reader')).toBeVisible();

      await page.goBack();
      await expect(screen(page, 'course')).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
    expect(problems).toEqual([]);
  });
});
