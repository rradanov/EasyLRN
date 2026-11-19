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
import { strFromU8 } from '../vendor/fflate.js';
import { listZip, readEntry } from './zip.js';
import { listCourseFiles, listLessons, listQuizzes, getCourse, listCourses, saveCourseImport } from './db.js';
import { renderCourse } from './lesson-render.js';

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

/**
 * The extension of the file name in lower case: "0001-a.HTML" → "0001-a.html",
 * "INDEX.MD" → "INDEX.md" (T010-D1). Done before the path is used anywhere, so
 * a file with an upper-case extension replaces the same file instead of
 * becoming a second one. Lessons that point to "x.CSS" still find "x.css"
 * (src/lesson-render.js tries the lower-case extension too).
 */
export function lowerExtension(path) {
  return String(path).replace(/(\.[A-Za-z0-9]{1,8})$/, (ext) => ext.toLowerCase());
}

/**
 * A file name without the suffix that browsers add to a repeated download:
 * "0001-a (1).html" → "0001-a.html", "INDEX (2).md" → "INDEX.md" (T008-D1).
 */
export function stripDownloadSuffix(name) {
  return String(name).replace(/\s?\(\d{1,3}\)(?=(\.[^./\\]+)?$)/, '');
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
  const zipNames = [];
  let skippedPdf = 0;
  // Phase 1 (T008-D3): plan every file from the ZIP central directories and
  // the File sizes, and check the limits before anything is unpacked or read.
  const plan = []; // { path, size, source, zip?: { data, entry, broken } } | { path, size, source, file }
  let total = 0;
  const take = (item, tooBig) => {
    if (item.size > MAX_FILE_BYTES) throw new ImportError(tooBig);
    if (plan.length >= MAX_FILES) throw new ImportError(`Твърде много файлове (над ${MAX_FILES}). Това не прилича на курс.`);
    total += item.size;
    if (total > MAX_TOTAL_BYTES) throw new ImportError('Курсът е твърде голям (над 200 MB без PDF-ите).');
    plan.push(item);
  };

  for (const file of inputs) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (isZipName(file.name) || isZipData(head)) {
      if (!isZipData(head)) throw new ImportError(`Файлът „${file.name}“ не е ZIP архив.`);
      zipNames.push(file.name);
      const broken = (err) => new ImportError(`Файлът „${file.name}“ не може да се отвори: ZIP архивът е повреден или непълен.`, { cause: err });
      const data = await readBytes(file);
      let listing;
      try {
        listing = listZip(data);
      } catch (err) {
        throw broken(err);
      }
      for (const entry of listing) {
        const cleaned = cleanPath(entry.name);
        const path = cleaned && lowerExtension(cleaned);
        if (!path || entry.dir || IGNORED.test(path)) continue;
        if (isPdf(path)) { skippedPdf++; continue; }
        take({ path, size: entry.size, source: file.name, zip: { data, entry, broken } }, `Файлът „${path}“ в архива е твърде голям.`);
      }
    } else {
      const rel = file.webkitRelativePath && file.webkitRelativePath.includes('/') ? cleanPath(file.webkitRelativePath) : null;
      const path = rel ? lowerExtension(rel) : pathForLooseFile(lowerExtension(stripDownloadSuffix(file.name)));
      if (!path || IGNORED.test(path)) continue;
      if (isPdf(path)) { skippedPdf++; continue; }
      take({ path, size: file.size, source: file.name, file }, `Файлът „${path}“ е твърде голям (${Math.round(file.size / 1048576)} MB).`);
    }
  }

  // Phase 2: unpack. readEntry() stops an entry that grows past its declared
  // size and checks its CRC-32 (T008-D2).
  const entries = [];
  for (const item of plan) {
    let data;
    if (item.zip) {
      try {
        data = readEntry(item.zip.data, item.zip.entry);
      } catch (err) {
        throw item.zip.broken(err);
      }
    } else {
      data = await readBytes(item.file);
    }
    entries.push({ path: item.path, data, source: item.source });
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
  const planned = [];
  let section = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const t = heading[1].toLowerCase();
      section = /урок|уроц|lesson/.test(t) ? 'lesson' : /справоч|reference/.test(t) ? 'reference'
        : /^(план|plan)(\s|\(|:|$)/.test(t) ? 'plan' : null;
      continue;
    }
    if (section === 'plan') {
      // T-011: "- 0002: title" / "- R02 — title" — lessons planned but not written yet.
      const item = /^\s*[-*]\s+(R?\d{1,4}[a-z]?)\s*[:—–-]\s*(.+?)\s*$/i.exec(line);
      if (item) planned.push({ kind: /^R/i.test(item[1]) ? 'reference' : 'lesson', number: item[1], title: item[2] });
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
  return { rows, artifacts, planned };
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
  return h ? h.replace(/^(мисия|mission)\s*[:—–-]\s*/i, '').trim() || null : null;
}

/**
 * Course title from INDEX.md: its first "# " heading without the course id
 * and the word "индекс"/"index" ("# LRN-CRA: индекс" names no course → null).
 */
function indexTitle(md, courseId) {
  const h = /^#\s+(.+)$/m.exec(md || '')?.[1];
  if (!h) return null;
  const t = h.trim()
    .replace(new RegExp(`^${String(courseId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '')
    .replace(/^\s*[:—–-]?\s*/, '')
    .replace(/^(индекс|index)(?![\p{L}\p{N}])\s*[:—–-]?\s*/iu, '')
    .trim();
  return t || null;
}

/**
 * Name of a course for the screens (T012-I5): the first "# " heading of
 * MISSION.md (without "Мисия:"), else that of INDEX.md (without the id and
 * "индекс"), else the stored title, else the id. Read from the stored files,
 * so courses imported by an older version get it too.
 * @param {{ id: string, title?: string, meta?: { mission?: string, index?: string } }} course
 */
export function courseName(course) {
  const meta = course?.meta || {};
  return missionTitle(meta.mission) || indexTitle(meta.index, course?.id) || course?.title || course?.id || '';
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

// --- Quizzes (T-047, D-032/D-033): quizzes/<slug>.json ------------------------

const QUIZ_LIMITS = Object.freeze({ quizzes: 500, questions: 500, options: 20, q: 4000, option: 1000, why: 4000, src: 500, title: 300, links: 5, label: 200, url: 2048 });
/** Bump when parseQuiz() reads more from the same file: stored quizzes are parsed again. */
export const QUIZ_FORMAT = 3; // 0.6.2: T050-D2 (equal options); 0.6.1: links, lesson number normalised, T048-D2
const quizSlug = (path) => /^quizzes\/([^/]+)\.json$/i.exec(path)?.[1] ?? null;
const clampText = (value, max) => {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return s.length > max ? s.slice(0, max) : s;
};

/** Lesson number of a quiz: 1, "1", "01" → "0001" (T-048 Н-4); other text as it is. */
export function normalizeLessonNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 9999 ? String(value).padStart(4, '0') : null;
  const s = String(value).trim();
  if (!s) return null;
  return /^\d{1,4}$/.test(s) ? s.padStart(4, '0') : s;
}

/**
 * Links of a question (D-035): at most 5 `{ label, url }`, only https: URLs,
 * label plain text (≤ 200), url ≤ 2048. Invalid ones are left out with a note.
 * @returns {{ label: string, url: string }[]}
 */
export function parseQuizLinks(value, where, notes) {
  if (value == null) return [];
  if (!Array.isArray(value)) { notes.push(`${where}: „links“ не е списък — пропуснат`); return []; }
  const links = [];
  for (const [i, item] of value.entries()) {
    if (links.length >= QUIZ_LIMITS.links) { notes.push(`${where}: над ${QUIZ_LIMITS.links} линка — останалите пропуснати`); break; }
    const label = item && typeof item === 'object' && typeof item.label === 'string' ? item.label.trim() : '';
    const raw = item && typeof item === 'object' && typeof item.url === 'string' ? item.url.trim() : '';
    let url = null;
    try { url = raw && raw.length <= QUIZ_LIMITS.url ? new URL(raw) : null; } catch { url = null; }
    if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      notes.push(`${where}: линк ${i + 1} е невалиден (позволени са само https: адреси) — пропуснат`);
      continue;
    }
    links.push({ label: clampText(label || url.hostname, QUIZ_LIMITS.label), url: url.href });
  }
  return links;
}

/**
 * Validate a quizzes/<slug>.json into a clean quiz record, or null if it has no
 * valid question. All text stays PLAIN TEXT (D-032): the UI shows it with
 * textContent, never innerHTML, so HTML or <script> inside a field cannot run.
 * Invalid questions (bad shape, an option that is not text — T048-D2 —,
 * fewer than 2 options, two options with the same text — T050-D2 —, answer
 * index out of range) are dropped whole with a
 * note; limits bound every length and count, and a cut is noted too (the
 * import summary shows the notes, T-048 Н-2).
 */
export function parseQuiz(courseId, path, bytes, notes = []) {
  const slug = quizSlug(path);
  if (!slug) return null;
  let json;
  try { json = JSON.parse(text(bytes)); } catch { notes.push(`тест ${path}: невалиден JSON — пропуснат`); return null; }
  if (!json || typeof json !== 'object' || !Array.isArray(json.questions)) { notes.push(`тест ${path}: няма въпроси — пропуснат`); return null; }
  const questions = [];
  let clamped = 0;
  const clamp = (value, max) => {
    const s = typeof value === 'string' ? value : String(value ?? '');
    if (s.length > max) clamped++;
    return clampText(s, max);
  };
  if (json.questions.length > QUIZ_LIMITS.questions) {
    notes.push(`тест ${path}: ${json.questions.length} въпроса, показани са първите ${QUIZ_LIMITS.questions}`);
  }
  json.questions.forEach((q, i) => {
    if (questions.length >= QUIZ_LIMITS.questions) return;
    const where = `тест ${path}, въпрос ${i + 1}`;
    if (!q || typeof q !== 'object' || typeof q.q !== 'string' || !q.q.trim() || !Array.isArray(q.options)) {
      notes.push(`${where}: грешна форма — пропуснат`); return;
    }
    if (q.options.some((o) => typeof o !== 'string')) { notes.push(`${where}: опция, която не е текст — въпросът е пропуснат`); return; }
    if (q.options.length < 2) { notes.push(`${where}: трябват поне 2 опции — пропуснат`); return; }
    if (q.options.length > QUIZ_LIMITS.options) {
      if (Number.isInteger(q.answer) && q.answer >= QUIZ_LIMITS.options) { notes.push(`${where}: верният отговор е след опция ${QUIZ_LIMITS.options} — пропуснат`); return; }
      notes.push(`${where}: над ${QUIZ_LIMITS.options} опции — останалите пропуснати`);
    }
    const options = q.options.slice(0, QUIZ_LIMITS.options).map((o) => clamp(o, QUIZ_LIMITS.option));
    // T050-D2: a choice is kept by its text (schema v3), and the user cannot
    // tell equal options apart either: such a question is a mistake in the
    // course. Equal = the same text after trimming and collapsing spaces.
    const seen = new Set();
    if (options.some((o) => { const k = o.trim().replace(/\s+/g, ' '); if (seen.has(k)) return true; seen.add(k); return false; })) {
      notes.push(`${where}: две опции с еднакъв текст — въпросът е пропуснат`); return;
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length) { notes.push(`${where}: индексът на отговора е извън диапазона — пропуснат`); return; }
    questions.push({
      q: clamp(q.q, QUIZ_LIMITS.q),
      options,
      answer: q.answer,
      why: clamp(q.why ?? '', QUIZ_LIMITS.why),
      src: clamp(q.src ?? '', QUIZ_LIMITS.src),
      links: parseQuizLinks(q.links, where, notes),
    });
  });
  if (clamped) notes.push(`тест ${path}: ${clamped} твърде дълги текста са съкратени`);
  if (!questions.length) { notes.push(`тест ${path}: няма валидни въпроси — пропуснат`); return null; }
  const lesson = normalizeLessonNumber(json.lesson);
  return {
    id: `${courseId}/${path}`,
    courseId,
    path,
    slug,
    lesson,
    title: clamp(json.title ?? slug, QUIZ_LIMITS.title),
    questions,
    count: questions.length,
    format: QUIZ_FORMAT,
  };
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
      : zipNames.length ? 'ZIP архивът е празен.' : 'Избраното е празно.');
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
  const [oldCourse, oldFiles, oldLessons, oldQuizzes] = await Promise.all([
    getCourse(courseId, { includeDeleted: true }),
    listCourseFiles(courseId, { includeDeleted: true }),
    listLessons(courseId, { includeDeleted: true }),
    listQuizzes(courseId, { includeDeleted: true }),
  ]);
  const oldFileSha = new Map(oldFiles.map((f) => [f.path, f.deleted ? null : f.sha256]));
  const oldLessonById = new Map(oldLessons.map((l) => [l.id, l]));
  const oldQuizById = new Map(oldQuizzes.map((q) => [q.id, q]));

  const fileStats = { total, added: 0, changed: 0, unchanged: 0 };
  const filesToWrite = [];
  for (const e of list) {
    const before = oldFileSha.get(e.path);
    if (before === e.sha256) { fileStats.unchanged++; continue; }
    if (before === undefined) fileStats.added++; else fileStats.changed++;
    filesToWrite.push({ courseId, path: e.path, mime: mimeOf(e.path), blob: new Blob([e.data], { type: mimeOf(e.path) }), sha256: e.sha256, size: e.data.length });
  }

  // Lessons and references, in INDEX order (then by number).
  // T008-D4: a partial import without INDEX.md (one part of a split ZIP, a
  // loose lesson) uses the stored INDEX.md, so artifact links and titles stay.
  const index = parseIndex(indexMd ?? oldCourse?.meta?.index);
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
  // T012-I4: a lesson is its number. A stored lesson whose file is not in this
  // import, replaced by exactly one NEW file with the same kind and number
  // (the file was renamed), is that lesson: the new record takes over its
  // progress and the user's data that points at it (saveCourseImport, one
  // transaction), and the old record is soft-deleted. Ambiguous cases (two
  // stored or two new files with one number) are left as before.
  const importedIds = new Set(lessons.map((l) => l.id));
  const numberKey = (l) => `${l.kind}:${String(l.number).toUpperCase()}`;
  const liveOld = oldLessons.filter((l) => !l.deleted);
  const renames = [];
  for (const l of lessons) {
    if (oldLessonById.get(l.id) && !oldLessonById.get(l.id).deleted) continue;
    const key = numberKey(l);
    const gone = liveOld.filter((o) => numberKey(o) === key && !importedIds.has(o.id));
    const fresh = lessons.filter((n) => numberKey(n) === key && !(oldLessonById.get(n.id) && !oldLessonById.get(n.id).deleted));
    if (gone.length === 1 && fresh.length === 1) renames.push({ from: gone[0].id, to: l.id, fromPath: gone[0].path });
  }
  const renamedFrom = new Set(renames.map((r) => r.from));
  const renamedTo = new Set(renames.map((r) => r.to));
  // Lessons already stored but not in this (partial) import keep their place in the order.
  // A record replaced by a renamed file earlier (soft-deleted, `renamedTo`) is not one of them.
  const all = [...lessons, ...oldLessons.filter((l) => !renamedFrom.has(l.id) && !(l.deleted && l.renamedTo) && !lessons.some((n) => n.id === l.id))
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
    if (renamedTo.has(l.id)) { lessonStats.changed.push(label); lessonsToWrite.push(record); continue; }
    if (!old) { lessonStats.added.push(label); lessonsToWrite.push(record); continue; }
    const same = !old.deleted && old.sha256 === l.sha256 && old.title === l.title && old.order === l.order
      && old.kind === l.kind && (old.indexTitle ?? null) === l.indexTitle && (old.artifactId ?? null) === l.artifactId;
    if (same) { lessonStats.unchanged.push(label); continue; }
    if (old.sha256 !== l.sha256 || old.deleted) lessonStats.changed.push(label); else lessonStats.unchanged.push(label);
    lessonsToWrite.push(record);
  }

  // Quizzes (T-047, D-032/D-033): quizzes/<slug>.json. Answers live in a
  // separate store and are never touched here, so a re-import keeps the answers
  // of unchanged questions (by text). Quizzes stored but absent from this
  // (partial) import are kept, like files and lessons.
  const quizNotes = [];
  const quizzes = [];
  for (const e of list) {
    if (!quizSlug(e.path)) continue;
    if (quizzes.length >= QUIZ_LIMITS.quizzes) { quizNotes.push(`над ${QUIZ_LIMITS.quizzes} теста — останалите пропуснати`); break; }
    const quiz = parseQuiz(courseId, e.path, e.data, quizNotes);
    if (quiz) { quiz.sha256 = e.sha256; quizzes.push(quiz); }
  }
  if (quizNotes.length) console.info(`EasyLRN quizzes ${courseId}:`, quizNotes.join('; '));

  // Quizzes stored but absent from this (partial) import keep their place in the
  // order, exactly like lessons, so a partial re-import is "Без промени".
  const newQuizIds = new Set(quizzes.map((q) => q.id));
  const allQuizzes = [...quizzes, ...oldQuizzes.filter((q) => !newQuizIds.has(q.id)).map((q) => ({ ...q, keep: true }))];
  allQuizzes.sort((a, b) => String(a.lesson ?? '￿').localeCompare(String(b.lesson ?? '￿'), 'bg', { numeric: true })
    || String(a.slug).localeCompare(String(b.slug), 'bg', { numeric: true }));
  allQuizzes.forEach((q, i) => { q.order = i + 1; });

  const quizStats = { added: 0, changed: 0, unchanged: 0 };
  const quizzesToWrite = [];
  for (const q of allQuizzes) {
    const old = oldQuizById.get(q.id);
    const { keep, ...record } = q;
    if (keep) {
      if (!old.deleted && old.order !== q.order) quizzesToWrite.push({ ...old, order: q.order });
      continue;
    }
    if (old && !old.deleted && old.sha256 === q.sha256 && old.order === q.order) {
      quizStats.unchanged++;
      // The same file, read by an older version of parseQuiz (no links…): store it again, silently.
      if (old.format !== QUIZ_FORMAT) quizzesToWrite.push(record);
      continue;
    }
    if (!old || old.deleted) quizStats.added++; else if (old.sha256 !== q.sha256) quizStats.changed++;
    quizzesToWrite.push(record);
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
  const isNew = !oldCourse || oldCourse.deleted;
  const nothingToWrite = !isNew && !filesToWrite.length && !lessonsToWrite.length && !quizzesToWrite.length && !renames.length;
  const contentChanged = fileStats.added || fileStats.changed || lessonStats.added.length || lessonStats.changed.length
    || quizStats.added || quizStats.changed;
  const status = isNew ? 'new' : contentChanged ? 'updated' : 'unchanged';

  // "Без промени" writes nothing, so the course keeps its updatedAt (backup merge, D-014).
  progress({ phase: 'save', done: 0, total: filesToWrite.length + lessonsToWrite.length + quizzesToWrite.length });
  if (!nothingToWrite) {
    await saveCourseImport({
      course: { id: courseId, title, importedAt: new Date().toISOString(), files: fileCount, meta },
      files: filesToWrite,
      lessons: lessonsToWrite,
      quizzes: quizzesToWrite,
      renames,
    });
    if (renames.length) console.info(`EasyLRN ${courseId}: renamed lesson files:`, renames.map((r) => `${r.fromPath} → ${r.to.slice(courseId.length + 1)}`).join('; '));
  }

  // Self-contained versions of the lessons for the isolated reader (T-045,
  // LESSON-ISOLATION §4.2): only new or stale ones (also after an app update
  // with a new renderer, even when the course itself is unchanged). A failure
  // here does not fail the import: the reader renders lazily when it opens.
  try {
    await renderCourse(courseId);
  } catch (err) {
    console.warn('EasyLRN: lessons not prepared at import (done when opened):', err);
  }

  const items = all.map((l) => ({ kind: l.kind, number: l.number, title: l.title }));
  const summary = {
    courseId,
    title,
    status,
    files: fileStats,
    lessons: lessonStats,
    quizzes: quizStats,
    counts: {
      lessons: items.filter((i) => i.kind === 'lesson').length,
      references: items.filter((i) => i.kind === 'reference').length,
      quizzes: allQuizzes.length,
      files: fileCount,
    },
    items,
    skippedPdf,
    quizNotes,
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
  const quizPart = s.counts.quizzes ? `, ${plural(s.counts.quizzes, 'тест', 'теста')}` : '';
  const content = `${plural(s.counts.lessons, 'урок', 'урока')}, ${plural(s.counts.references, 'справочник', 'справочника')}${quizPart}, ${plural(s.counts.files, 'файл', 'файла')}`;
  const notes = s.quizNotes?.length
    ? ` Внимание — тестовете не са внесени изцяло (${s.quizNotes.length}): ${s.quizNotes.slice(0, 3).join('; ')}${s.quizNotes.length > 3 ? '; …' : ''}.`
    : '';
  if (s.status === 'new') return `Курсът ${s.courseId} е импортиран: ${content}.${notes}`;
  if (s.status === 'unchanged') return `Без промени. Курсът ${s.courseId} вече е актуален (${content}).${notes}`;
  const quizChanges = s.quizzes && (s.quizzes.added || s.quizzes.changed)
    ? ` Тестове — нови: ${s.quizzes.added}, променени: ${s.quizzes.changed}.` : '';
  return `Курсът ${s.courseId} е обновен: нови уроци: ${s.lessons.added.length}, променени: ${s.lessons.changed.length}; `
    + `файлове — нови: ${s.files.added}, променени: ${s.files.changed}, без промяна: ${s.files.unchanged}.${quizChanges} Бележките, прогресът и отговорите на тестовете са запазени.${notes}`;
}

/** Message for any error thrown by importCourse(). */
export function errorMessage(err) {
  if (err instanceof ImportError) return err.message;
  if (err?.name === 'QuotaExceededError') return 'Няма достатъчно място на устройството за курса.';
  return 'Импортът не успя поради неочаквана грешка. Опитай пак; ако се повтори, импортирай ZIP на цялата папка.';
}
