// Builds test ZIPs from tests/fixtures/LRN-DEMO/ in Node (T-007), shaped like
// Drive's "Изтегляне": a root folder `LRN-DEMO/` with directory entries, file
// name `LRN-DEMO-<timestamp>-1-001.zip`, optionally split into several parts.
// The fixture is a shortened, anonymized copy of the real course (see
// logs/T-007_developer_*.md); sources/*.pdf are tiny stand-ins.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from '../../vendor/fflate.js';

export const FIXTURE_DIR = fileURLToPath(new URL('./LRN-DEMO/', import.meta.url));
export const DRIVE_ZIP_NAME = 'LRN-DEMO-20261118T090000Z-1-001.zip';

/** All fixture files as { 'lessons/0001-….html': Uint8Array }. */
export function readFixture(dir = FIXTURE_DIR) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = new Uint8Array(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/**
 * Make a ZIP buffer.
 * @param {Record<string, Uint8Array>} files paths relative to the course folder
 * @param {{ root?: string|null, dirs?: boolean }} [opts] root folder (default 'LRN-DEMO', null = none)
 */
export function makeZip(files, { root = 'LRN-DEMO', dirs = true } = {}) {
  const entries = {};
  const prefix = root ? `${root}/` : '';
  if (root && dirs) entries[prefix] = new Uint8Array(0);
  for (const [path, data] of Object.entries(files)) {
    if (dirs) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) entries[`${prefix}${parts.slice(0, i).join('/')}/`] = new Uint8Array(0);
    }
    entries[prefix + path] = data;
  }
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date('2026-11-18T09:00:00Z') }));
}

/** Split the fixture into `n` Drive-like parts (each with the root folder). */
export function splitZips(files, n = 2) {
  const paths = Object.keys(files);
  return Array.from({ length: n }, (_, i) => ({
    name: `LRN-DEMO-20261118T090000Z-1-00${i + 1}.zip`,
    mimeType: 'application/zip',
    buffer: makeZip(Object.fromEntries(paths.filter((_, j) => j % n === i).map((p) => [p, files[p]]))),
  }));
}

/** The fixture with one lesson edited (a sentence added). */
export function withChangedLesson(files) {
  const path = 'lessons/0001-kakvo-e-chayat.html';
  const html = new TextDecoder().decode(files[path]).replace('</h1>', '</h1>\n<p>Нов абзац в обновената версия.</p>');
  return { ...files, [path]: strToU8(html) };
}

/** A file for Playwright's setInputFiles(). */
export const asFile = (name, buffer, mimeType = 'application/zip') => ({ name, mimeType, buffer });
