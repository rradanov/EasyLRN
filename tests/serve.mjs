// Minimal static server for tests: serves the repository root under /EasyLRN/,
// the same sub-path as GitHub Pages (https://rradanov.github.io/EasyLRN/).
// Usage: node tests/serve.mjs [port]   (default 4173)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = '/EasyLRN/';
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Never serve tooling or VCS files (GitHub Pages does not serve them either).
const BLOCKED = /^(\.git|\.github|node_modules|test-results|playwright-report)(\/|$)/;

createServer(async (req, res) => {
  const send = (status, body = '', headers = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
    res.end(body);
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/EasyLRN') return send(301, '', { Location: BASE });
    if (!url.pathname.startsWith(BASE)) return send(404, 'Not found');
    let rel = decodeURIComponent(url.pathname.slice(BASE.length));
    rel = normalize(rel).replace(/^([/\\])+/, '');
    if (rel.startsWith('..') || BLOCKED.test(rel.split(sep).join('/'))) return send(404, 'Not found');
    let file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) return send(404, 'Not found');
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) return send(404, 'Not found');
    send(200, req.method === 'HEAD' ? '' : body, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    });
  } catch {
    send(400, 'Bad request');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`EasyLRN test server: http://localhost:${PORT}${BASE}`);
});
