// Course import (T-007, ARCHITECTURE §2, D-010): a ZIP downloaded from Drive
// (one or several parts, with or without the root folder `LRN-<topic>/`) or
// individual files / a folder picked on the device.
//
// - `sources/*.pdf` (and any other PDF) is never imported.
// - Every file gets a SHA-256; a re-import writes only new or changed files
//   and lessons, and never touches the user's data (progress, annotations,
//   notes, threads, subtopics, settings) — D-010.
// - Files missing from a new import are kept (a partial import, e.g. one new
//   lesson or one part of a split ZIP, must not remove the rest).
// - INDEX.md gives the lesson order and the artifact ↔ file table.
// User-facing messages are in Bulgarian (ImportError.message).
import { unzipSync, strFromU8 } from '../vendor/fflate.js';
import { listCourseFiles, listLessons, getCourse, listCourses, saveCourseImport } from './db.js';

/** Error with a message for the user (Bulgarian). */
export class ImportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ImportError';
  }
}

// Limits against broken or hostile archives (a course is ~100 KB without PDFs).
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

const META_FILES = ['MISSION.md', 'NOTES.md', 'RESOURCES.md', 'INDEX.md', 'GLOSSARY.md'];
const COURSE_DIRS = new Set(['lessons', 'reference', 'assets', 'learning-records', 'sources']);
const IGNORED = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.git)(\/|$)/i;
const COURSE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', py: 'text/x-python; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff',
};

export const mimeOf = (path) => MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

const isPdf = (path) => /\.pdf$/i.test(path);
const isZipName = (name) => /\.zip$/i.test(name);
const isZipData = (u8) => u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) ;

/** Clean a relative path; null if it is unsafe or not a file. */
function cleanPath(raw) {
  const parts = String(raw).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** Where a loose file (no folder path) belongs, by its name. */
export function pathForLooseFile(name) {
  if (/^\d{4}-.+\.html?$/i.test(name)) return `lessons/${name}`;
  if (/^R\d+.*\.html?$/i.test(name)) return `reference/${name}`;
  const meta = META_FILES.find((m) => m.toLowerCase() === name.toLowerCase());
  if (meta) return meta;
  if (/^\d{4}-.+\.md$/i.test(name)) return `learning-records/${name}`;
  if (/\.(css|js|mjs|py)$/i.test(name)) return `assets/${name}`;
  return name;
}

/** Course id from a Drive ZIP name: "LRN-DEMO-20261118T093012Z-1-001.zip" → "LRN-DEMO". */
export function courseIdFromZipName(name) {
  const base = name.replace(/\.zip$/i, '').replace(/\s*\(\d+\)$/, '')
    .replace(/-\d{8}T\d{6}Z(-\d+)*$/, '');
  return /^LRN-/i.test(base) && COURSE_ID.test(base) ? base : null;
}

const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());

/**
 * Read the picked files into entries { path, data, source } (paths still with
 * a possible root folder). ZIPs are unpacked; PDFs are counted and skipped.
 */
async function collect(inputs) {
  const entries = [];
  const zipNames = [];
  let skippedPdf = 0;
  let total = 0;
  const add = (path, data, source) => {
    if (entries.length >= MAX_FILES) throw new ImportError(`Твърде много файлове (над ${MAX_FILES}). Това не прилича на курс.`);
    if (data.length > MAX_FILE_BYTES) throw new ImportError(`Файлът „${path}“ е твърде голям (${Math.round(data.length / 1048576)} MB).`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new ImportError('Курсът е твърде голям (над 200 MB без PDF-ите).');
    entries.push({ path, data, source });
  };

  for (const file of inputs) {
    const data = await readBytes(file);
    if (isZipName(file.name) || isZipData(data)) {
      if (!isZipData(data)) throw new ImportError(`Файлът „${file.name}“ не е ZIP архив.`);
      zipNames.push(file.name);
      let files;
      try {
        files = unzipSync(data, {
          filter: (f) => {
            const path = cleanPath(f.name);
            if (!path || f.name.endsWith('/') || IGNORED.test(path)) return false;
            if (isPdf(path)) { skippedPdf++; return false; }
            if (f.originalSize > MAX_FILE_BYTES) throw new ImportError(`Файлът „${path}“ в архива е твърде голям.`);
            return true;
          },
        });
      } catch (err) {
        if (err instanceof ImportError) throw err;
        throw new ImportError(`Файлът „${file.name}“ не може да се отвори: ZIP архивът е повреден или непълен.`, { cause: err });
      }
      for (const [name, bytes] of Object.entries(files)) add(cleanPath(name), bytes, file.name);
    } else {
      const rel = file.webkitRelativePath && file.webkitRelativePath.includes('/') ? cleanPath(file.webkitRelativePath) : null;
      const path = rel || pathForLooseFile(file.name);
      if (!path || IGNORED.test(path)) continue;
      if (isPdf(path)) { skippedPdf++; continue; }
      add(path, data, file.name);
    }
  }
  return { entries, zipNames, skippedPdf, loose: zipNames.length === 0 };
}

/** Strip a common root folder (Drive puts `LRN-DEMO/` in the ZIP). */
function stripRoot(entries) {
  const firsts = new Set(entries.map((e) => e.path.split('/')[0]));
  if (firsts.size !== 1) return null;
  const [root] = firsts;
  const nested = entries.every((e) => e.path.includes('/'));
  if (!nested || COURSE_DIRS.has(root.toLowerCase())) return null;
  for (const e of entries) e.path = e.path.slice(root.length + 1);
  return root;
}

const text = (u8) => strFromU8(u8);
const findEntry = (entries, path) => entries.find((e) => e.path === path);

/** Find "LRN-XXX" in a text (INDEX heading, lesson kicker). */
const courseIdInText = (s) => /\b(LRN-[A-Za-z0-9][A-Za-z0-9_-]*)/.exec(s || '')?.[1] ?? null;

/**
 * Parse INDEX.md: the "Уроци"/"Справочници" tables (order, number, title,
 * artifact link, file path). Unknown layouts give empty results, never errors.
 */
export function parseIndex(md) {
  const rows = [];
  const artifacts = {};
  let section = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const t = heading[1].toLowerCase();
      section = /урок|уроц|lesson/.test(t) ? 'lesson' : /справоч|reference/.test(t) ? 'reference' : null;
      continue;
    }
    if (!section || !line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!cells[0] || /^:?-+:?$/.test(cells[0]) || cells[0] === '#') continue;
    const number = cells[0];
    const path = cells.map((c) => /\[([^\]]*\.html?)\]/i.exec(c)?.[1]).find(Boolean)
      || cells.map((c) => /\((?!https?:)([^)]*\.html?)\)/i.exec(c)?.[1]).find(Boolean) || null;
    const artifact = cells.map((c) => /claude\.ai\/(?:public\/)?artifacts?\/([A-Za-z0-9_-]+)/.exec(c)?.[1]).find(Boolean) || null;
    const title = (cells[1] || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    rows.push({ kind: section, number, title, path: path && cleanPath(path), artifact });
    if (artifact && path) artifacts[artifact] = cleanPath(path);
  }
  return { rows, artifacts };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };

/** Plain text of an HTML fragment (tags dropped, entities decoded, spaces collapsed). */
function htmlText(fragment) {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Title of a lesson file: the first <h1>, else <title>. Read with a regular
 * expression, not DOMParser: parsing the lesson in the app's document would
 * apply the app's CSP to the lesson's inline styles (console errors).
 */
function htmlTitle(html) {
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return (h1 && htmlText(h1)) || (title && htmlText(title)) || null;
}

/** Course title from MISSION.md: first heading without "Мисия:". */
function missionTitle(md) {
  const h = /^#\s+(.+)$/m.exec(md || '')?.[1];
  return h ? h.replace(/^(мисия|mission)\s*[:—–-]\s*/i, '').trim() : null;
}

async function sha256(u8) {
  const digest = await crypto.subtle.digest('SHA-256', u8);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function lessonKind(path) {
  let m = /^lessons\/(\d{4})-[^/]+\.html?$/i.exec(path);
  if (m) return { kind: 'lesson', number: m[1] };
  m = /^reference\/(R\d+)[^/]*\.html?$/i.exec(path);
  if (m) return { kind: 'reference', number: m[1].toUpperCase() };
  return null;
}

/**
 * Import a course.
 * @param {File[]|FileList} files one or more ZIPs, or individual course files
 * @param {{ onProgress?: (p: { phase: 'read'|'hash'|'save'|'done', done?: number, total?: number }) => void }} [options]
 * @returns {Promise<ImportSummary>}
 *
 * @typedef {{ courseId: string, title: string, status: 'new'|'updated'|'unchanged',
 *   files: { total: number, added: number, changed: number, unchanged: number },
 *   lessons: { added: string[], changed: string[], unchanged: string[] },
 *   counts: { lessons: number, references: number, files: number },
 *   items: { kind: string, number: string, title: string }[],
 *   skippedPdf: number, ms: number }} ImportSummary
 */
export async function importCourse(files, { onProgress } = {}) {
  const t0 = performance.now();
  const inputs = Array.from(files || []);
  if (!inputs.length) throw new ImportError('Не е избран файл.');
  const progress = (p) => { try { onProgress?.(p); } catch { /* UI errors never stop an import */ } };

  progress({ phase: 'read', done: 0, total: inputs.length });
  const { entries, zipNames, skippedPdf, loose } = await collect(inputs);
  if (!entries.length) {
    throw new ImportError(skippedPdf
      ? 'В избраното има само PDF файлове. Те не се импортират — избери ZIP на папката или уроците (.html) и .md файловете.'
      : 'Избраното е празно.');
  }
  const root = stripRoot(entries);

  // Duplicates (e.g. the same file in two ZIP parts): the last one wins.
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const list = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  const indexMd = findEntry(list, 'INDEX.md') && text(findEntry(list, 'INDEX.md').data);
  const lessonFiles = list.filter((e) => lessonKind(e.path));
  const hasMeta = META_FILES.some((m) => findEntry(list, m));
  if (!lessonFiles.length && !hasMeta) {
    throw new ImportError('Това не прилича на курс LRN: няма уроци (lessons/NNNN-….html), справочници (reference/R….html) или MISSION.md / INDEX.md.');
  }

  // Course id: root folder → ZIP name → INDEX heading → lesson kicker → the only course.
  let courseId = (root && COURSE_ID.test(root) ? root : null)
    || zipNames.map(courseIdFromZipName).find(Boolean)
    || courseIdInText(indexMd && /^#\s+.*$/m.exec(indexMd)?.[0])
    || lessonFiles.map((e) => courseIdInText(/class="kicker"[^>]*>([^<]*)/.exec(text(e.data))?.[1])).find(Boolean)
    || null;
  if (!courseId && loose) {
    const courses = await listCourses();
    if (courses.length === 1) courseId = courses[0].id;
  }
  if (!courseId) {
    throw new ImportError('Не мога да разпозная курса. Импортирай ZIP на цялата папка LRN-… (или избери папката), за да се види името ѝ.');
  }
  const zipRoots = new Set(zipNames.map(courseIdFromZipName).filter(Boolean));
  if (zipRoots.size > 1) throw new ImportError(`Избрани са ZIP файлове от различни курсове: ${[...zipRoots].join(', ')}. Импортирай ги поотделно.`);

  // Hash every file.
  const total = list.length;
  for (let i = 0; i < total; i++) {
    list[i].sha256 = await sha256(list[i].data);
    if (i % 8 === 7 || i === total - 1) progress({ phase: 'hash', done: i + 1, total });
  }

  // Compare with what is stored.
  const [oldCourse, oldFiles, oldLessons] = await Promise.all([
    getCourse(courseId, { includeDeleted: true }),
    listCourseFiles(courseId, { includeDeleted: true }),
    listLessons(courseId, { includeDeleted: true }),
  ]);
  const oldFileSha = new Map(oldFiles.map((f) => [f.path, f.deleted ? null : f.sha256]));
  const oldLessonById = new Map(oldLessons.map((l) => [l.id, l]));

  const fileStats = { total, added: 0, changed: 0, unchanged: 0 };
  const filesToWrite = [];
  for (const e of list) {
    const before = oldFileSha.get(e.path);
    if (before === e.sha256) { fileStats.unchanged++; continue; }
    if (before === undefined) fileStats.added++; else fileStats.changed++;
    filesToWrite.push({ courseId, path: e.path, mime: mimeOf(e.path), blob: new Blob([e.data], { type: mimeOf(e.path) }), sha256: e.sha256, size: e.data.length });
  }

  // Lessons and references, in INDEX order (then by number).
  const index = parseIndex(indexMd);
  const rowByPath = new Map(index.rows.filter((r) => r.path).map((r) => [r.path, r]));
  const rowByNumber = new Map(index.rows.map((r) => [`${r.kind}:${r.number.toUpperCase()}`, r]));
  const artifactByPath = Object.fromEntries(Object.entries(index.artifacts).map(([id, p]) => [p, id]));
  const lessons = lessonFiles.map((e) => {
    const { kind, number } = lessonKind(e.path);
    const row = rowByPath.get(e.path) || rowByNumber.get(`${kind}:${number.toUpperCase()}`);
    return {
      id: `${courseId}/${e.path}`,
      courseId,
      kind,
      number,
      path: e.path,
      sha256: e.sha256,
      title: htmlTitle(text(e.data)) || row?.title || e.path.split('/').pop(),
      indexTitle: row?.title ?? null,
      artifactId: artifactByPath[e.path] ?? row?.artifact ?? null,
      indexPos: row ? index.rows.indexOf(row) : Infinity,
    };
  });
  // Lessons already stored but not in this (partial) import keep their place in the order.
  const all = [...lessons, ...oldLessons.filter((l) => !lessons.some((n) => n.id === l.id))
    .map((l) => ({ ...l, indexPos: index.rows.findIndex((r) => r.path === l.path), keep: true }))];
  const kindRank = { lesson: 0, reference: 1 };
  all.sort((a, b) => (kindRank[a.kind] - kindRank[b.kind])
    || ((a.indexPos === -1 ? Infinity : a.indexPos) - (b.indexPos === -1 ? Infinity : b.indexPos))
    || String(a.number).localeCompare(String(b.number), 'bg', { numeric: true }));
  all.forEach((l, i) => { l.order = i + 1; });

  const lessonStats = { added: [], changed: [], unchanged: [] };
  const lessonsToWrite = [];
  for (const l of all) {
    const old = oldLessonById.get(l.id);
    const { indexPos, keep, ...record } = l;
    if (keep) {
      if (old.order !== l.order) lessonsToWrite.push({ ...old, order: l.order });
      continue;
    }
    const label = `${l.number} ${l.title}`;
    if (!old) { lessonStats.added.push(label); lessonsToWrite.push(record); continue; }
    const same = !old.deleted && old.sha256 === l.sha256 && old.title === l.title && old.order === l.order
      && old.kind === l.kind && (old.indexTitle ?? null) === l.indexTitle && (old.artifactId ?? null) === l.artifactId;
    if (same) { lessonStats.unchanged.push(label); continue; }
    if (old.sha256 !== l.sha256 || old.deleted) lessonStats.changed.push(label); else lessonStats.unchanged.push(label);
    lessonsToWrite.push(record);
  }

  // Course record: metadata from the files in this import; missing ones are kept.
  const meta = {};
  const metaText = (name) => findEntry(list, name) && text(findEntry(list, name).data);
  for (const [key, name] of [['mission', 'MISSION.md'], ['notes', 'NOTES.md'], ['resources', 'RESOURCES.md'], ['glossary', 'GLOSSARY.md'], ['index', 'INDEX.md']]) {
    const t = metaText(name);
    if (t != null) meta[key] = t;
  }
  if (indexMd) meta.artifacts = index.artifacts;
  const title = missionTitle(meta.mission ?? oldCourse?.meta?.mission) || oldCourse?.title || courseId;
  const fileCount = new Set([...oldFiles.filter((f) => !f.deleted).map((f) => f.path), ...list.map((e) => e.path)]).size;
  const nothingChanged = oldCourse && !oldCourse.deleted && !filesToWrite.length && !lessonsToWrite.length;
  const status = !oldCourse || oldCourse.deleted ? 'new' : nothingChanged ? 'unchanged' : 'updated';

  progress({ phase: 'save', done: 0, total: filesToWrite.length + lessonsToWrite.length });
  await saveCourseImport({
    course: { id: courseId, title, importedAt: new Date().toISOString(), files: fileCount, meta },
    files: filesToWrite,
    lessons: lessonsToWrite,
  });

  const items = all.map((l) => ({ kind: l.kind, number: l.number, title: l.title }));
  const summary = {
    courseId,
    title,
    status,
    files: fileStats,
    lessons: lessonStats,
    counts: {
      lessons: items.filter((i) => i.kind === 'lesson').length,
      references: items.filter((i) => i.kind === 'reference').length,
      files: fileCount,
    },
    items,
    skippedPdf,
    ms: Math.round(performance.now() - t0),
  };
  progress({ phase: 'done', done: 1, total: 1 });
  return summary;
}

// --- Bulgarian wording for the UI --------------------------------------------

/** "1 урок", "2 урока", "5 урока" (Bulgarian count form). */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** One-line summary for the result box. */
export function describeSummary(s) {
  const content = `${plural(s.counts.lessons, 'урок', 'урока')}, ${plural(s.counts.references, 'справочник', 'справочника')}, ${plural(s.counts.files, 'файл', 'файла')}`;
  if (s.status === 'new') return `Курсът ${s.courseId} е импортиран: ${content}.`;
  if (s.status === 'unchanged') return `Без промени. Курсът ${s.courseId} вече е актуален (${content}).`;
  return `Курсът ${s.courseId} е обновен: нови уроци: ${s.lessons.added.length}, променени: ${s.lessons.changed.length}; `
    + `файлове — нови: ${s.files.added}, променени: ${s.files.changed}, без промяна: ${s.files.unchanged}. Бележките и прогресът са запазени.`;
}

/** Message for any error thrown by importCourse(). */
export function errorMessage(err) {
  if (err instanceof ImportError) return err.message;
  if (err?.name === 'QuotaExceededError') return 'Няма достатъчно място на устройството за курса.';
  return 'Импортът не успя поради неочаквана грешка. Опитай пак; ако се повтори, импортирай ZIP на цялата папка.';
}
