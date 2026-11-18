// Playwright config for the EasyLRN shell tests (T-004).
// The app is served under /EasyLRN/ like on GitHub Pages; the target device is
// a Samsung Galaxy Tab A9+ (1920×1200, D-021), tested in landscape and portrait.
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT || 4173);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/EasyLRN/`,
    browserName: 'chromium',
    hasTouch: true,
    locale: 'bg-BG',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'tablet-landscape', use: { viewport: { width: 1920, height: 1200 } } },
    { name: 'tablet-portrait', use: { viewport: { width: 1200, height: 1920 } } },
  ],
  webServer: {
    command: `node tests/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/EasyLRN/`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
