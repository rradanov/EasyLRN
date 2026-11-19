// T-050 (tester): the PUBLISHED site, not the repository. The 0.6.1 deploy
// left parser.html out of _site, so the new Service Worker failed to install
// (cache.addAll) and the tablet stayed on 0.6.0; every other test serves the
// whole repository and could not see it. Here the "Collect app files" and
// "Check precache list" steps of .github/workflows/pages.yml are run as they
// are written into a temporary folder, that _site is served alone, and the
// app must install its Service Worker, precache every SHELL file, open a
// lesson and work offline.
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKFLOW = join(REPO, '.github/workflows/pages.yml');

/** The `run:` block of a named step in the workflow (plain YAML scan, no dependency). */
function stepScript(yaml, name) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) throw new Error(`step "${name}" not found`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.match(/^\s*/)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join('\n');
}

async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}

test('T-050 the published _site (built by the Pages workflow) installs the SW, precaches every SHELL file, opens a lesson and works offline', async ({ page, context }, info) => {
  test.skip(!existsSync(WORKFLOW), 'no Pages workflow');
  test.setTimeout(120_000);
  const port = 4600 + info.workerIndex * 2 + (info.project.name === 'tablet-portrait' ? 1 : 0);
  const work = `/tmp/t050-deploy-${port}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // The repository files the workflow sees after checkout (tracked files only).
  execSync(`git -C "${REPO}" ls-files -z | xargs -0 -I{} cp --parents "{}" "${work}"`, { shell: '/bin/bash' });
  const yaml = readFileSync(WORKFLOW, 'utf8');
  execSync(stepScript(yaml, 'Collect app files'), { cwd: work, shell: '/bin/bash', stdio: 'ignore' });
  execSync(stepScript(yaml, 'Check precache list'), { cwd: work, shell: '/bin/bash' }); // throws if a SHELL file is missing
  // Serve _site alone (the test server serves its parent folder of tests/).
  const site = join(work, '_site');
  mkdirSync(join(site, 'tests'));
  cpSync(join(REPO, 'tests/serve.mjs'), join(site, 'tests/serve.mjs'));
  const url = `http://localhost:${port}/EasyLRN/`;
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  const stop = await serve(site, port);
  try {
    await page.goto(url);
    await expect(page.locator('[data-screen="courses"]')).toBeVisible();
    const sw = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
      if (!reg) return null;
      const keys = await caches.keys();
      const cache = await caches.open(keys.find((k) => k.startsWith('easylrn-shell-')));
      return { active: reg.active?.state, keys, cached: (await cache.keys()).length };
    });
    const shell = (readFileSync(join(REPO, 'sw.js'), 'utf8').match(/const SHELL = \[([^\]]*)\]/)[1].match(/'\.\/[^']*'/g) || []).length;
    console.log(`T-050 published _site: ${JSON.stringify(sw)}, SHELL ${shell}`);
    expect(sw?.active).toBe('activated');
    expect(sw.cached).toBe(shell);
    await page.reload();
    // A lesson renders through parser.html on the published site.
    await page.evaluate(async (bytes) => {
      const m = await import('./src/course-import.js');
      await m.importCourse([new File([new Uint8Array(bytes)], 'LRN-PUB.zip')]);
    }, [...makeZip({ 'INDEX.md': strToU8('# PUB\n'), 'lessons/0001-p.html': strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>П</title></head><body><h1>Публикуван урок</h1></body></html>') }, { root: 'LRN-PUB' })]);
    await page.goto(`${url}#/c/LRN-PUB/read/0001`);
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    // Offline from the published files.
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
    await context.setOffline(false);
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true });
  }
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED/.test(p))).toEqual([]);
});
