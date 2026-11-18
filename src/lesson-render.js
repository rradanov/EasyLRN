// Assemble a self-contained lesson document (T-045, D-029, LESSON-ISOLATION §4.2).
//
// A lesson runs in an opaque origin (CSP `sandbox allow-scripts` from the
// Service Worker). Its sub-resources do not go through the Service Worker, so
// the app inlines them once, at import time or lazily when a lesson opens:
// - relative <link rel="stylesheet"> of the course → <style>;
// - relative <script src> → inline <script>;
// - relative images (<img src/srcset>, <source>, poster, CSS url()) → data: URLs
//   (at most 2 MB per file; a bigger one is left out with a warning);
// - Google Fonts @import / <link> are removed (D-031: system fonts only);
//   other external stylesheets, scripts and <link> hints are removed too
//   (the lesson CSP would block them anyway, with console errors);
// - <base> and <meta http-equiv="refresh"> are removed.
// It also collects the allowlist of links: every <a>/<area> href, absolute,
// resolved against the virtual address of the file (./c/<course>/<path>).
//
// The result (`rendered`, `renderVersion`, `renderSha`, `renderDeps`, `links`)
// is stored next to the original in the `files` record; the original (`blob`,
// `sha256`) is never changed.
//
// Why not DOMParser (LESSON-ISOLATION §4.2 suggests it): in Chromium a document
// made by DOMParser / createHTMLDocument / <template> reports every inline
// style and inline event handler of the lesson as a violation of the app CSP
// (console errors; nothing runs). So this module uses a small HTML tag scanner
// that only rewrites the tags above and copies everything else byte for byte.
// Security does not depend on it (the CSP sandbox does); a missed sub-resource
// only changes how the lesson looks (risk I-8).
import { getFile, listCourseFiles, setFileRender } from './db.js';
import { courseFileUrl, parseCourseUrl } from './lesson-frame.js';

/** Bump when the output changes; must equal RENDER_VERSION in sw.js. */
export const RENDER_VERSION = 2; // D-034: nested frames removed

const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const MAX_CSS_DEPTH = 4;
const GOOGLE_FONTS = /^https?:\/\/fonts\.(googleapis|gstatic)\.com\//i;
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
// Nested browsing contexts: removed at assembly (D-034, T046-S1). A lesson may
// not contain or run a frame of its own; the guard blocks creating them too.
const FRAME_TAGS = new Set(['iframe', 'frame', 'embed', 'portal', 'frameset', 'object']);

export const isHtmlPath = (path) => /\.html?$/i.test(path);

// --- A minimal HTML tag scanner --------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Parse a start tag at `i` (html[i] === '<'). Returns { name, attrs, end, selfClosing }
 * or null if it is not a start tag. attrs: [{ name, value }] (value decoded, null if none).
 */
function parseStartTag(html, i) {
  const m = /^<([a-zA-Z][^\s/>\u0000]*)/.exec(html.slice(i, i + 64));
  if (!m) return null;
  let p = i + m[0].length;
  const attrs = [];
  const n = html.length;
  while (p < n) {
    while (p < n && /[\s/]/.test(html[p])) p++;
    if (p >= n) break;
    if (html[p] === '>') {
      return { name: m[1].toLowerCase(), attrs, end: p + 1, selfClosing: html[p - 1] === '/' };
    }
    let q = p;
    // An attribute name may start with "=" (HTML spec); never with whitespace, "/" or ">".
    q++;
    while (q < n && !/[\s/>=]/.test(html[q])) q++;
    const name = html.slice(p, q).toLowerCase();
    p = q;
    while (p < n && /\s/.test(html[p])) p++;
    let value = null;
    if (html[p] === '=') {
      p++;
      while (p < n && /\s/.test(html[p])) p++;
      const quote = html[p];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, p + 1);
        const stop = close === -1 ? n : close;
        value = html.slice(p + 1, stop);
        p = close === -1 ? n : close + 1;
      } else {
        q = p;
        while (q < n && !/[\s>]/.test(html[q])) q++;
        value = html.slice(p, q);
        p = q;
      }
      value = decodeEntities(value);
    }
    attrs.push({ name, value });
  }
  return { name: m[1].toLowerCase(), attrs, end: n, selfClosing: false };
}

/** Index of the end tag `</name` (case-insensitive) from `from`, or -1. */
function findEndTag(html, name, from) {
  const re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

const getAttr = (tag, name) => tag.attrs.find((a) => a.name === name)?.value ?? null;
function serializeTag(name, attrs) {
  const parts = attrs.map((a) => (a.value == null ? a.name : `${a.name}="${escapeAttr(a.value)}"`));
  return `<${name}${parts.length ? ` ${parts.join(' ')}` : ''}>`;
}

// --- Course files -------------------------------------------------------------

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Mime type for a data: URL (no parameters). */
const dataMime = (file) => (file.mime || file.blob?.type || 'application/octet-stream').split(';')[0].trim();

/**
 * Renderer state for one lesson file.
 * @param {{ courseId: string, path: string, files: Map<string, object> }} ctx
 */
function makeContext({ courseId, path, files }) {
  const deps = {};
  const notes = [];
  const links = new Set();
  const decoder = new TextDecoder();
  const cache = new Map();

  /** The course file a URL points to (exact path, else the same path with a lower-case extension). */
  const fileOf = (url) => {
    const target = parseCourseUrl(url);
    if (!target || target.courseId !== courseId) return null;
    const lower = target.path.replace(/\.[^./]+$/, (e) => e.toLowerCase());
    const file = files.get(target.path) || files.get(lower);
    return file && !file.deleted && file.blob ? file : null;
  };
  const read = async (file) => {
    if (!cache.has(file.path)) cache.set(file.path, new Uint8Array(await file.blob.arrayBuffer()));
    deps[file.path] = file.sha256 ?? null;
    return cache.get(file.path);
  };
  const resolve = (ref, base) => {
    try { return new URL(ref.trim(), base); } catch { return null; }
  };
  const isCourse = (url) => !!url && !!parseCourseUrl(url.href);

  /** data: URL of a course file, or '' (missing / too big). */
  const dataUrl = async (ref, base) => {
    const url = resolve(ref, base);
    if (!url || url.protocol === 'data:' || url.protocol === 'blob:') return ref;
    const file = isCourse(url) ? fileOf(url.href) : null;
    if (!file) {
      notes.push(`missing or external: ${ref}`);
      return '';
    }
    if ((file.size ?? file.blob.size) > MAX_INLINE_BYTES) {
      notes.push(`over 2 MB, left out: ${file.path}`);
      console.warn(`EasyLRN: ${file.path} is over 2 MB and is not shown in the lesson.`);
      return '';
    }
    return `data:${dataMime(file)};base64,${toBase64(await read(file))}`;
  };

  /** CSS with course url() → data:, Google Fonts / external @import removed, relative @import inlined. */
  const css = async (text, base, depth = 0) => {
    // @import "x"; / @import url(x) …;
    const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)[^;]*;?/gi;
    let out = '';
    let last = 0;
    for (const m of text.matchAll(importRe)) {
      out += text.slice(last, m.index);
      last = m.index + m[0].length;
      const ref = m[2] ?? m[4] ?? '';
      const url = resolve(ref, base);
      const file = url && isCourse(url) ? fileOf(url.href) : null;
      if (file && depth < MAX_CSS_DEPTH) {
        out += await css(decoder.decode(await read(file)), url, depth + 1);
      } else {
        out += `/* EasyLRN: @import removed (${url && GOOGLE_FONTS.test(url.href) ? 'Google Fonts, D-031' : 'not in the course'}) */`;
      }
    }
    out += text.slice(last);
    // url(...) everywhere else (not data:, not fragments).
    const urlRe = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
    let result = '';
    last = 0;
    for (const m of out.matchAll(urlRe)) {
      result += out.slice(last, m.index);
      last = m.index + m[0].length;
      const ref = m[2].trim();
      if (!ref || /^(data:|blob:|#)/i.test(ref)) { result += m[0]; continue; }
      const inlined = await dataUrl(ref, base);
      result += `url("${inlined || 'data:,'}")`;
    }
    return result + out.slice(last);
  };

  return { deps, notes, links, fileOf, read, resolve, isCourse, dataUrl, css, decoder };
}

/** Text safe inside <style>/<script>: no closing tag of that element. */
const rawSafe = (text, name) => text.replace(new RegExp(`</(${name})`, 'gi'), '<\\/$1');

/**
 * Assemble the self-contained HTML of a lesson.
 * @param {string} html the original lesson
 * @param {{ courseId: string, path: string, files: Map<string, object> }} opts files by path
 * @returns {Promise<{ html: string, links: string[], deps: Record<string,string>, notes: string[] }>}
 */
export async function assembleLesson(html, { courseId, path, files }) {
  const ctx = makeContext({ courseId, path, files });
  const base = courseFileUrl(courseId, path);
  const out = [];
  let i = 0;
  let last = 0;
  const n = html.length;
  const emit = (to, replacement) => { out.push(html.slice(last, i), replacement); last = to; i = to; };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?' || html[i + 1] === '/') {
      const close = html.indexOf('>', i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    const tag = parseStartTag(html, i);
    if (!tag) { i++; continue; }
    const { name } = tag;
    let contentEnd = -1;
    let elementEnd = tag.end;
    if (RAW_TEXT.has(name)) {
      contentEnd = findEndTag(html, name, tag.end);
      if (contentEnd === -1) contentEnd = n;
      const close = html.indexOf('>', contentEnd);
      elementEnd = contentEnd >= n ? n : (close === -1 ? n : close + 1);
    }

    if (name === 'a' || name === 'area') {
      const href = getAttr(tag, 'href');
      const url = href != null ? ctx.resolve(href, base) : null;
      if (url) ctx.links.add(url.href);
      i = tag.end;
      continue;
    }
    if (name === 'base' || (name === 'meta' && /refresh/i.test(getAttr(tag, 'http-equiv') || ''))) {
      emit(tag.end, `<!-- EasyLRN: <${name}> removed -->`);
      continue;
    }
    if (FRAME_TAGS.has(name)) {
      // Drop the whole element (iframe carries its srcdoc; object/frameset keep
      // any fallback children, but without a browsing context).
      emit(RAW_TEXT.has(name) ? elementEnd : tag.end, `<!-- EasyLRN: <${name}> removed (D-034) -->`);
      continue;
    }
    if (name === 'link') {
      const rel = (getAttr(tag, 'rel') || '').toLowerCase().split(/\s+/);
      const href = getAttr(tag, 'href');
      if (href == null) { i = tag.end; continue; }
      const url = ctx.resolve(href, base);
      const file = url && ctx.isCourse(url) ? ctx.fileOf(url.href) : null;
      if (rel.includes('stylesheet') && file) {
        const media = getAttr(tag, 'media');
        const text = await ctx.css(ctx.decoder.decode(await ctx.read(file)), url);
        emit(tag.end, `${serializeTag('style', media ? [{ name: 'media', value: media }] : [])}${rawSafe(text, 'style')}</style>`);
      } else if (rel.some((r) => ['stylesheet', 'preconnect', 'dns-prefetch', 'preload', 'prefetch', 'modulepreload', 'prerender', 'icon', 'manifest'].includes(r))) {
        const why = url && GOOGLE_FONTS.test(url.href) ? 'Google Fonts, D-031' : 'not in the course';
        emit(tag.end, `<!-- EasyLRN: <link rel="${escapeAttr(rel.join(' '))}"> removed (${why}) -->`);
      } else {
        i = tag.end;
      }
      continue;
    }
    if (name === 'style') {
      const text = await ctx.css(html.slice(tag.end, contentEnd), base);
      emit(elementEnd, `${html.slice(i, tag.end)}${rawSafe(text, 'style')}</style>`);
      continue;
    }
    if (name === 'script') {
      const src = getAttr(tag, 'src');
      if (src == null) { i = elementEnd; continue; }
      const url = ctx.resolve(src, base);
      const file = url && ctx.isCourse(url) ? ctx.fileOf(url.href) : null;
      if (file) {
        const attrs = tag.attrs.filter((a) => !['src', 'async', 'defer', 'integrity', 'crossorigin'].includes(a.name));
        const text = ctx.decoder.decode(await ctx.read(file));
        emit(elementEnd, `${serializeTag('script', attrs)}${rawSafe(text, 'script')}</script>`);
      } else {
        ctx.notes.push(`script left out: ${src}`);
        emit(elementEnd, `<!-- EasyLRN: <script src> removed (not in the course) -->`);
      }
      continue;
    }
    // Images and media: src / srcset / poster / style url().
    const changes = [];
    for (const attr of tag.attrs) {
      if (attr.value == null) continue;
      if ((attr.name === 'src' && ['img', 'source', 'video', 'audio', 'track', 'input', 'embed'].includes(name))
          || (attr.name === 'poster' && name === 'video')) {
        const v = attr.value.trim();
        if (v && !/^(data:|blob:)/i.test(v)) changes.push({ ...attr, value: await ctx.dataUrl(v, base) || 'data:,' });
        else changes.push(attr);
      } else if (attr.name === 'srcset' && (name === 'img' || name === 'source')) {
        const parts = [];
        for (const candidate of attr.value.split(',')) {
          const [ref, ...desc] = candidate.trim().split(/\s+/);
          if (!ref) continue;
          const inlined = /^(data:|blob:)/i.test(ref) ? ref : await ctx.dataUrl(ref, base);
          if (inlined) parts.push([inlined, ...desc].join(' '));
        }
        changes.push({ ...attr, value: parts.join(', ') });
      } else if (attr.name === 'style' && /url\(/i.test(attr.value)) {
        changes.push({ ...attr, value: await ctx.css(attr.value, base) });
      } else {
        changes.push(attr);
      }
    }
    const changed = changes.some((a, k) => a.value !== tag.attrs[k].value);
    if (changed) emit(tag.end, serializeTag(name, changes).replace(/>$/, tag.selfClosing ? ' />' : '>'));
    else i = RAW_TEXT.has(name) ? elementEnd : tag.end;
  }
  out.push(html.slice(last));
  return { html: out.join(''), links: [...ctx.links], deps: ctx.deps, notes: ctx.notes };
}

// --- Stored renders -------------------------------------------------------------

/** Is the stored render of `file` older than the file, the renderer or one of its inlined files? */
export function isRenderStale(file, filesByPath) {
  if (!file?.rendered || file.renderVersion !== RENDER_VERSION || file.renderSha !== file.sha256) return true;
  for (const [path, sha] of Object.entries(file.renderDeps || {})) {
    const dep = filesByPath.get(path);
    if (!dep || dep.deleted || dep.sha256 !== sha) return true;
  }
  return false;
}

async function renderOne(file, filesByPath) {
  const html = new TextDecoder().decode(new Uint8Array(await file.blob.arrayBuffer()));
  const result = await assembleLesson(html, { courseId: file.courseId, path: file.path, files: filesByPath });
  if (result.notes.length) console.info(`EasyLRN render ${file.path}:`, result.notes.join('; '));
  return setFileRender(file.courseId, file.path, {
    sha256: file.sha256,
    rendered: new Blob([result.html], { type: 'text/html; charset=utf-8' }),
    renderVersion: RENDER_VERSION,
    renderDeps: result.deps,
    links: result.links,
  });
}

/**
 * Render every HTML file of a course whose render is missing or stale (at import).
 * @returns {Promise<number>} how many files were rendered
 */
export async function renderCourse(courseId) {
  const files = await listCourseFiles(courseId);
  const byPath = new Map(files.map((f) => [f.path, f]));
  let count = 0;
  for (const file of files) {
    if (!isHtmlPath(file.path) || !file.blob || !isRenderStale(file, byPath)) continue;
    await renderOne(file, byPath);
    count++;
  }
  return count;
}

/**
 * The file record of a lesson with an up-to-date render (renders it now if needed).
 * @returns {Promise<object|null>} null if the file is missing
 */
export async function ensureRendered(courseId, path) {
  const file = await getFile(courseId, path);
  if (!file?.blob) return null;
  if (file.rendered && file.renderVersion === RENDER_VERSION && file.renderSha === file.sha256
      && !Object.keys(file.renderDeps || {}).length) {
    return file;
  }
  const files = await listCourseFiles(courseId);
  const byPath = new Map(files.map((f) => [f.path, f]));
  if (!isRenderStale(file, byPath)) return file;
  return (await renderOne(file, byPath)) || getFile(courseId, path);
}
