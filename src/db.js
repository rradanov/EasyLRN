// EasyLRN data layer: IndexedDB schema, migrations and repositories.
// Model: ARCHITECTURE §3 (records, DocRef, annotations, tree), §7 (stores, backup).
//
// Conventions
// - Every record has `id` (ULID: time-sortable, so sorting by id = creation order),
//   `createdAt`, `updatedAt` (ISO 8601) and `deleted` (soft delete, D-014: needed to
//   merge backups by "newer updatedAt wins"). Course files use `key` instead of `id`.
// - Reads skip soft-deleted records unless `{ includeDeleted: true }` is passed.
// - `remove()` soft-deletes, `purge()` deletes for real (e.g. course file blobs).
// - A DocRef is `{ type: 'lesson'|'subtopic'|'note'|'message', id }` (D-013).
import { openDB, deleteDB } from '../vendor/idb.js';

export const DB_NAME = 'lrn-app';

/** Store names (ARCHITECTURE §7). */
export const STORES = Object.freeze({
  courses: 'courses',
  files: 'files',
  lessons: 'lessons',
  annotations: 'annotations',
  notes: 'notes',
  threads: 'threads',
  messages: 'messages',
  subtopics: 'subtopics',
  settings: 'settings',
  usage: 'usage',
});

export const DOC_TYPES = Object.freeze(['lesson', 'subtopic', 'note', 'message']);
export const COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink', 'orange']);
export const ANCHOR_STATES = Object.freeze(['ok', 'fuzzy', 'orphan']);
export const LESSON_KINDS = Object.freeze(['lesson', 'reference']);
export const PROGRESS_STATUSES = Object.freeze(['new', 'started', 'done']);
export const MESSAGE_ROLES = Object.freeze(['user', 'assistant']);
export const MESSAGE_STATUSES = Object.freeze(['pending', 'streaming', 'done', 'error']);
export const SUBTOPIC_KINDS = Object.freeze(['термин', 'контекст', 'задълбочаване']);
export const USAGE_KINDS = Object.freeze(['answer', 'subtopic', 'test']);

const SETTINGS_ID = 'settings';

/** Defaults for the single settings record (ARCHITECTURE §3.5, D-022). */
export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: '',
  model: 'claude-sonnet-5-5',
  maxTokensAnswer: 1500,
  maxTokensSubtopic: 3000,
  monthlyBudgetUSD: 5,
  colors: [
    { id: 'yellow', label: 'Важно' },
    { id: 'green', label: 'Ясно' },
    { id: 'blue', label: 'Дефиниция' },
    { id: 'pink', label: 'Неясно' },
    { id: 'orange', label: 'Пример' },
  ],
  fontScale: 1,
  twoColumnMode: false,
  lastBackupAt: null,
});

// ---------------------------------------------------------------------------
// Schema and migrations
// ---------------------------------------------------------------------------

/**
 * Migrations by target version. Each runs inside the upgrade transaction and
 * gets `(db, tx)`; they run in order from the stored version + 1 up to the
 * requested one. A migration may return a promise, but must only await
 * IndexedDB requests of `tx` (anything else lets the transaction close).
 * Never edit a released migration — add a new version instead.
 */
export const MIGRATIONS = Object.freeze({
  1(db) {
    db.createObjectStore(STORES.courses, { keyPath: 'id' });

    const files = db.createObjectStore(STORES.files, { keyPath: 'key' });
    files.createIndex('by_course', 'courseId');

    const lessons = db.createObjectStore(STORES.lessons, { keyPath: 'id' });
    lessons.createIndex('by_course', 'courseId');

    const annotations = db.createObjectStore(STORES.annotations, { keyPath: 'id' });
    annotations.createIndex('by_target', ['target.type', 'target.id']);
    annotations.createIndex('by_course', 'courseId');

    const notes = db.createObjectStore(STORES.notes, { keyPath: 'id' });
    notes.createIndex('by_annotation', 'annotationId');

    const threads = db.createObjectStore(STORES.threads, { keyPath: 'id' });
    threads.createIndex('by_annotation', 'annotationId');

    const messages = db.createObjectStore(STORES.messages, { keyPath: 'id' });
    messages.createIndex('by_thread', 'threadId');

    const subtopics = db.createObjectStore(STORES.subtopics, { keyPath: 'id' });
    subtopics.createIndex('by_parent', ['parent.type', 'parent.id']);
    subtopics.createIndex('by_root', 'rootLessonId');
    subtopics.createIndex('by_annotation', 'annotationId');
    subtopics.createIndex('by_course', 'courseId');

    db.createObjectStore(STORES.settings, { keyPath: 'id' });

    const usage = db.createObjectStore(STORES.usage, { keyPath: 'id' });
    usage.createIndex('by_at', 'at');
  },
});

/** Current schema version = the highest migration. */
export const SCHEMA_VERSION = Math.max(...Object.keys(MIGRATIONS).map(Number));

let dbPromise = null;
let current = { name: DB_NAME, version: SCHEMA_VERSION, migrations: MIGRATIONS, onVersionChange: null };

/**
 * Open (and upgrade if needed) the database. Calls without options reuse the
 * open connection (or reopen the last configured database). Options are for
 * tests: another database name, version or migration set.
 * @param {{ name?: string, version?: number, migrations?: Record<number, Function>,
 *           onVersionChange?: () => void }} [options]
 */
export function openDb(options) {
  if (dbPromise && !options) return dbPromise;
  if (options) {
    closeDb();
    const migrations = options.migrations || MIGRATIONS;
    current = {
      name: options.name || DB_NAME,
      migrations,
      version: options.version || Math.max(...Object.keys(migrations).map(Number)),
      onVersionChange: options.onVersionChange || null,
    };
  }
  const { name, version, migrations, onVersionChange } = current;
  for (let v = 1; v <= version; v++) {
    if (typeof migrations[v] !== 'function') {
      return Promise.reject(new Error(`No migration to schema version ${v}`));
    }
  }
  const promise = openDB(name, version, {
    upgrade(db, oldVersion, newVersion, tx) {
      // Run in order; a migration may return a promise of IndexedDB requests
      // (e.g. a cursor over old records) and the next one waits for it.
      let chain = Promise.resolve();
      for (let v = oldVersion + 1; v <= newVersion; v++) {
        chain = chain.then(() => migrations[v](db, tx));
      }
      chain.catch((err) => {
        console.error('IndexedDB migration failed:', err);
        try { tx.abort(); } catch { /* already finished */ }
      });
    },
    blocking() {
      // A newer version was opened in another tab: let it upgrade.
      if (dbPromise === promise) closeDb();
      onVersionChange?.();
    },
    terminated() {
      if (dbPromise === promise) dbPromise = null;
    },
  }).catch((err) => {
    if (dbPromise === promise) dbPromise = null;
    throw err;
  });
  dbPromise = promise;
  return promise;
}

/** Close the connection (the next call opens it again). */
export function closeDb() {
  const pending = dbPromise;
  dbPromise = null;
  pending?.then((db) => db.close(), () => {});
}

/** Delete a whole database (tests; never called by the app with DB_NAME). */
export async function deleteDatabase(name) {
  if (name === current.name && dbPromise) {
    const pending = dbPromise;
    dbPromise = null;
    await pending.then((db) => db.close(), () => {});
  }
  await deleteDB(name);
}

// ---------------------------------------------------------------------------
// Storage (D-014): persistent storage and usage estimate
// ---------------------------------------------------------------------------

/**
 * Ask the browser not to evict our data. Chrome decides without a prompt
 * (an installed PWA is usually granted). Never throws.
 * @returns {Promise<boolean|null>} true = persistent, false = may be evicted, null = unsupported
 */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** @returns {Promise<{usage: number, quota: number, persisted: boolean|null}|null>} */
export async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
    return { usage, quota, persisted };
  } catch {
    return null;
  }
}

/** App start: open/upgrade the database and request persistent storage. */
export async function initStorage() {
  const [db, persisted] = await Promise.all([openDb(), requestPersistence()]);
  return { version: db.version, persisted };
}

// ---------------------------------------------------------------------------
// Ids and timestamps
// ---------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (ULID)
let lastTime = -1;
let lastRandom = [];

/** New ULID: 26 chars, lexicographically sortable by creation time (monotonic). */
export function newId() {
  let time = Date.now();
  if (time <= lastTime) {
    time = lastTime;
    // Same millisecond: increment the random part so ids stay ordered.
    let i = lastRandom.length - 1;
    while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
    if (i < 0) { time = ++lastTime; lastRandom = randomDigits(); } else lastRandom[i]++;
  } else {
    lastRandom = randomDigits();
  }
  lastTime = time;
  let head = '';
  for (let t = time, i = 0; i < 10; i++, t = Math.floor(t / 32)) head = B32[t % 32] + head;
  return head + lastRandom.map((d) => B32[d]).join('');
}

function randomDigits() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Leave headroom in the first digit so increments within one ms never overflow.
  return Array.from(bytes, (b, i) => (i === 0 ? b % 16 : b % 32));
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Generic repository functions
// ---------------------------------------------------------------------------

function assertStore(store) {
  if (!Object.values(STORES).includes(store)) throw new TypeError(`Unknown store: ${store}`);
}

const keyOf = (store, record) => (store === STORES.files ? record.key : record.id);
const visible = (opts) => (record) => record && (opts?.includeDeleted || !record.deleted);

/** Add the common fields to a new record (keeps a given id / createdAt). */
function stamp(store, data) {
  const at = now();
  const record = { ...data };
  if (store !== STORES.files && !record.id) record.id = newId();
  record.createdAt ??= at;
  record.updatedAt = at;
  record.deleted = Boolean(record.deleted);
  return record;
}

/**
 * Insert a new record; fails if the key already exists.
 * @returns {Promise<object>} the stored record
 */
export async function create(store, data) {
  assertStore(store);
  const record = stamp(store, data);
  const db = await openDb();
  await db.add(store, record);
  return record;
}

/** Insert or replace a record (common fields are set/updated). */
export async function put(store, data) {
  assertStore(store);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const existing = await tx.store.get(keyOf(store, data) ?? '\u0000');
  const record = stamp(store, { ...data, createdAt: existing?.createdAt ?? data.createdAt });
  await tx.store.put(record);
  await tx.done;
  return record;
}

/** @returns {Promise<object|undefined>} */
export async function get(store, key, opts) {
  assertStore(store);
  const db = await openDb();
  const record = await db.get(store, key);
  return visible(opts)(record) ? record : undefined;
}

/** All records of a store. */
export async function list(store, opts) {
  assertStore(store);
  const db = await openDb();
  return (await db.getAll(store)).filter(visible(opts));
}

/** Records by index; `query` is a key, an array key or an IDBKeyRange. */
export async function byIndex(store, index, query, opts) {
  assertStore(store);
  const db = await openDb();
  return (await db.getAllFromIndex(store, index, query)).filter(visible(opts));
}

/**
 * Change fields of an existing record (read and write in one transaction).
 * `patch` may be an object or a function `(record) => patch`.
 * @returns {Promise<object>} the updated record
 */
export async function update(store, key, patch) {
  assertStore(store);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const record = await tx.store.get(key);
  if (!record) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error(`${store}: record not found: ${key}`);
  }
  const changes = typeof patch === 'function' ? patch(record) : patch;
  const next = { ...record, ...changes, id: record.id, createdAt: record.createdAt, updatedAt: now() };
  if (store === STORES.files) { next.key = record.key; delete next.id; }
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** Soft delete (the record stays, with `deleted: true`). */
export function remove(store, key) {
  return update(store, key, { deleted: true });
}

/** Undo a soft delete. */
export function restore(store, key) {
  return update(store, key, { deleted: false });
}

/** Delete for real. */
export async function purge(store, key) {
  assertStore(store);
  const db = await openDb();
  await db.delete(store, key);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of ${allowed.join(', ')}; got ${value}`);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${field} is required`);
}

/** Validate a DocRef and return a clean copy. */
export function docRef(type, id) {
  oneOf(type, DOC_TYPES, 'DocRef.type');
  requireString(id, 'DocRef.id');
  return { type, id };
}

function checkDocRef(ref, field) {
  if (!ref || typeof ref !== 'object') throw new TypeError(`${field} must be a DocRef`);
  return docRef(ref.type, ref.id);
}

function checkSelector(selector) {
  const quote = selector?.quote;
  const position = selector?.position;
  if (!quote || typeof quote.exact !== 'string' || quote.exact === '') {
    throw new TypeError('selector.quote.exact is required (TextQuoteSelector)');
  }
  if (!position || !Number.isInteger(position.start) || !Number.isInteger(position.end)
      || position.start < 0 || position.end < position.start) {
    throw new TypeError('selector.position needs integer start <= end (TextPositionSelector)');
  }
  const clean = {
    quote: { exact: quote.exact, prefix: quote.prefix ?? '', suffix: quote.suffix ?? '' },
    position: { start: position.start, end: position.end },
  };
  if (selector.hint) clean.hint = { ...selector.hint };
  return clean;
}

// ---------------------------------------------------------------------------
// Courses, course files, lessons (filled by the import, T-007)
// ---------------------------------------------------------------------------

/** Insert or replace a course: { id: 'LRN-DEMO', title, importedAt, files, meta }. */
export function putCourse(course) {
  requireString(course?.id, 'course.id');
  return put(STORES.courses, course);
}

export const getCourse = (id, opts) => get(STORES.courses, id, opts);
export const listCourses = (opts) => list(STORES.courses, opts);

/** Key of a course file: "<courseId>/<path>". */
export const fileKey = (courseId, path) => `${courseId}/${path}`;

/** Insert or replace a course file: { courseId, path, mime, blob, sha256 }. */
export function putFile(file) {
  requireString(file?.courseId, 'file.courseId');
  requireString(file?.path, 'file.path');
  return put(STORES.files, { ...file, key: fileKey(file.courseId, file.path) });
}

export const getFile = (courseId, path, opts) => get(STORES.files, fileKey(courseId, path), opts);
export const listCourseFiles = (courseId, opts) => byIndex(STORES.files, 'by_course', courseId, opts);

const NEW_PROGRESS = Object.freeze({ status: 'new', lastOpenedAt: null, scrollY: 0 });

/**
 * Insert or replace a lesson from the import. The user's progress of an
 * existing lesson is kept (a re-import never resets it).
 */
export async function putLesson(lesson) {
  requireString(lesson?.id, 'lesson.id');
  requireString(lesson?.courseId, 'lesson.courseId');
  oneOf(lesson.kind ?? 'lesson', LESSON_KINDS, 'lesson.kind');
  const existing = await get(STORES.lessons, lesson.id, { includeDeleted: true });
  return put(STORES.lessons, {
    kind: 'lesson',
    ...lesson,
    progress: existing?.progress ?? { ...NEW_PROGRESS, ...lesson.progress },
  });
}

export const getLesson = (id, opts) => get(STORES.lessons, id, opts);

/** Lessons and references of a course, in course order (`order`, then number). */
export async function listLessons(courseId, opts) {
  const lessons = await byIndex(STORES.lessons, 'by_course', courseId, opts);
  return lessons.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)
    || String(a.number ?? '').localeCompare(String(b.number ?? '')));
}

/** Update the reading progress of a lesson: { status?, lastOpenedAt?, scrollY? }. */
export function setLessonProgress(lessonId, progress) {
  if (progress.status !== undefined) oneOf(progress.status, PROGRESS_STATUSES, 'progress.status');
  return update(STORES.lessons, lessonId, (lesson) => ({
    progress: { ...NEW_PROGRESS, ...lesson.progress, ...progress },
  }));
}

// ---------------------------------------------------------------------------
// Annotations, notes, threads, messages, subtopics
// ---------------------------------------------------------------------------

/**
 * New annotation on any document (D-012, D-013).
 * @param {{ courseId: string, target: {type, id}, targetVersion?: string,
 *           selector: { quote: {exact, prefix, suffix}, position: {start, end}, hint? },
 *           color?: string|null, anchorState?: string }} data
 */
export function createAnnotation(data) {
  requireString(data?.courseId, 'annotation.courseId');
  const color = data.color ?? null;
  if (color !== null) oneOf(color, COLORS, 'annotation.color');
  const anchorState = data.anchorState ?? 'ok';
  oneOf(anchorState, ANCHOR_STATES, 'annotation.anchorState');
  return create(STORES.annotations, {
    ...data,
    target: checkDocRef(data.target, 'annotation.target'),
    targetVersion: data.targetVersion ?? null,
    selector: checkSelector(data.selector),
    color,
    anchorState,
  });
}

export const getAnnotation = (id, opts) => get(STORES.annotations, id, opts);

/** Change an annotation (color, anchor state, re-anchored selector…). */
export function updateAnnotation(id, patch) {
  const clean = { ...patch };
  if ('color' in clean && clean.color !== null) oneOf(clean.color, COLORS, 'annotation.color');
  if ('anchorState' in clean) oneOf(clean.anchorState, ANCHOR_STATES, 'annotation.anchorState');
  if ('selector' in clean) clean.selector = checkSelector(clean.selector);
  delete clean.target; // an annotation never moves to another document
  return update(STORES.annotations, id, clean);
}

/** Annotations on a document (index annotations.by_target). */
export function annotationsFor(ref, opts) {
  const { type, id } = checkDocRef(ref, 'target');
  return byIndex(STORES.annotations, 'by_target', [type, id], opts).then(byIdOrder);
}

export const annotationsOfCourse = (courseId, opts) => byIndex(STORES.annotations, 'by_course', courseId, opts);

/** New note on an annotation; `body` is Markdown. */
export function createNote({ annotationId, body = '', ...rest }) {
  requireString(annotationId, 'note.annotationId');
  return create(STORES.notes, { ...rest, annotationId, body });
}

export const notesFor = (annotationId, opts) => byIndex(STORES.notes, 'by_annotation', annotationId, opts).then(byIdOrder);

/** New question thread on an annotation. */
export function createThread({ annotationId, title = null, ...rest }) {
  requireString(annotationId, 'thread.annotationId');
  return create(STORES.threads, { ...rest, annotationId, title });
}

export const threadsFor = (annotationId, opts) => byIndex(STORES.threads, 'by_annotation', annotationId, opts).then(byIdOrder);

/** New message in a thread. */
export function createMessage({ threadId, role, content = '', status, ...rest }) {
  requireString(threadId, 'message.threadId');
  oneOf(role, MESSAGE_ROLES, 'message.role');
  const finalStatus = status ?? (role === 'user' ? 'done' : 'pending');
  oneOf(finalStatus, MESSAGE_STATUSES, 'message.status');
  return create(STORES.messages, { ...rest, threadId, role, content, status: finalStatus });
}

/** Messages of a thread, oldest first (ULIDs sort by creation time). */
export const messagesFor = (threadId, opts) => byIndex(STORES.messages, 'by_thread', threadId, opts).then(byIdOrder);

/**
 * Find the root lesson and depth for a new child of `ref`:
 * lesson → depth 1; subtopic → its depth + 1; note/message → up through the
 * annotation to the document it is attached to.
 */
export async function resolveRoot(ref) {
  const { type, id } = checkDocRef(ref, 'parent');
  let ann;
  switch (type) {
    case 'lesson':
      return { rootLessonId: id, depth: 1 };
    case 'subtopic': {
      const sub = await get(STORES.subtopics, id, { includeDeleted: true });
      if (!sub) throw new Error(`subtopic not found: ${id}`);
      return { rootLessonId: sub.rootLessonId, depth: (sub.depth ?? 1) + 1 };
    }
    case 'note': {
      const note = await get(STORES.notes, id, { includeDeleted: true });
      ann = note && await get(STORES.annotations, note.annotationId, { includeDeleted: true });
      break;
    }
    case 'message': {
      const msg = await get(STORES.messages, id, { includeDeleted: true });
      const thread = msg && await get(STORES.threads, msg.threadId, { includeDeleted: true });
      ann = thread && await get(STORES.annotations, thread.annotationId, { includeDeleted: true });
      break;
    }
  }
  if (!ann) throw new Error(`cannot find the document chain of ${type} ${id}`);
  return resolveRoot(ann.target);
}

/**
 * New subtopic ("Развий ми го"), born from an annotation. `parent`
 * (= annotation.target), `rootLessonId` and `depth` are filled in when missing.
 */
export async function createSubTopic(data) {
  requireString(data?.annotationId, 'subtopic.annotationId');
  oneOf(data.kind, SUBTOPIC_KINDS, 'subtopic.kind');
  const ann = await get(STORES.annotations, data.annotationId, { includeDeleted: true });
  if (!ann && !data.parent) throw new Error(`annotation not found: ${data.annotationId}`);
  const parent = checkDocRef(data.parent ?? ann.target, 'subtopic.parent');
  const root = data.rootLessonId && data.depth ? data : await resolveRoot(parent);
  return create(STORES.subtopics, {
    title: '',
    content: '',
    status: 'pending',
    ...data,
    courseId: data.courseId ?? ann?.courseId,
    parent,
    rootLessonId: root.rootLessonId,
    depth: root.depth,
  });
}

export const getSubTopic = (id, opts) => get(STORES.subtopics, id, opts);

/** Subtopics whose parent is the document `ref` (index subtopics.by_parent). */
export function subtopicsByParent(ref, opts) {
  const { type, id } = checkDocRef(ref, 'parent');
  return byIndex(STORES.subtopics, 'by_parent', [type, id], opts).then(byIdOrder);
}

/** All subtopics in the tree of a lesson (index subtopics.by_root). */
export const subtopicsByRoot = (lessonId, opts) => byIndex(STORES.subtopics, 'by_root', lessonId, opts).then(byIdOrder);

function byIdOrder(records) {
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Tree (ARCHITECTURE §3.4): derived from the links, never stored
// ---------------------------------------------------------------------------

const TREE_STORES = [STORES.annotations, STORES.notes, STORES.threads, STORES.messages, STORES.subtopics];

/**
 * Direct children of a document: its annotations and, for each, the notes,
 * threads (with messages) and subtopics attached to it. One read transaction.
 */
export async function getDocChildren(ref, opts) {
  const db = await openDb();
  const tx = db.transaction(TREE_STORES, 'readonly');
  const result = await childrenIn(tx, checkDocRef(ref, 'document'), opts);
  await tx.done;
  return result;
}

async function childrenIn(tx, { type, id }, opts) {
  const keep = visible(opts);
  const anns = byIdOrder((await tx.objectStore(STORES.annotations).index('by_target').getAll([type, id])).filter(keep));
  return Promise.all(anns.map(async (annotation) => {
    const [notes, threads, subtopics] = await Promise.all([
      tx.objectStore(STORES.notes).index('by_annotation').getAll(annotation.id),
      tx.objectStore(STORES.threads).index('by_annotation').getAll(annotation.id),
      tx.objectStore(STORES.subtopics).index('by_annotation').getAll(annotation.id),
    ]);
    const threadsWithMessages = await Promise.all(byIdOrder(threads.filter(keep)).map(async (thread) => ({
      thread,
      messages: byIdOrder((await tx.objectStore(STORES.messages).index('by_thread').getAll(thread.id)).filter(keep)),
    })));
    return {
      annotation,
      notes: byIdOrder(notes.filter(keep)),
      threads: threadsWithMessages,
      subtopics: byIdOrder(subtopics.filter(keep)),
    };
  }));
}

/**
 * The whole tree of a lesson (F4.4): every document node with its children,
 * recursively — lesson → annotations → notes / threads → messages / subtopics,
 * and the same again for annotations on notes, messages and subtopics.
 * Node: { ref, record?, annotations: [{ annotation, notes: [node], threads:
 *         [{ thread, messages: [node] }], subtopics: [node] }] }
 */
export async function getLessonTree(lessonId, opts) {
  const db = await openDb();
  const tx = db.transaction([STORES.lessons, ...TREE_STORES], 'readonly');
  const seen = new Set();

  const node = async (ref, record) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return { ref, record, annotations: [] }; // guard against bad data cycles
    seen.add(key);
    const anns = await childrenIn(tx, ref, opts);
    return {
      ref,
      record,
      annotations: await Promise.all(anns.map(async (a) => ({
        annotation: a.annotation,
        notes: await Promise.all(a.notes.map((n) => node({ type: 'note', id: n.id }, n))),
        threads: await Promise.all(a.threads.map(async (t) => ({
          thread: t.thread,
          messages: await Promise.all(t.messages.map((m) => node({ type: 'message', id: m.id }, m))),
        }))),
        subtopics: await Promise.all(a.subtopics.map((s) => node({ type: 'subtopic', id: s.id }, s))),
      }))),
    };
  };

  const lesson = await tx.objectStore(STORES.lessons).get(lessonId);
  const tree = await node({ type: 'lesson', id: lessonId }, lesson);
  await tx.done;
  return tree;
}

// ---------------------------------------------------------------------------
// Settings (one record) and usage / cost (D-022)
// ---------------------------------------------------------------------------

/** Settings merged over the defaults. */
export async function getSettings() {
  const stored = await get(STORES.settings, SETTINGS_ID);
  return { ...structuredClone(DEFAULT_SETTINGS), ...stored, id: SETTINGS_ID };
}

/** Save some settings fields. */
export async function saveSettings(patch) {
  const db = await openDb();
  const tx = db.transaction(STORES.settings, 'readwrite');
  const stored = await tx.store.get(SETTINGS_ID);
  const at = now();
  const record = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...stored,
    ...patch,
    id: SETTINGS_ID,
    createdAt: stored?.createdAt ?? at,
    updatedAt: at,
    deleted: false,
  };
  await tx.store.put(record);
  await tx.done;
  return record;
}

/** Log one API call: { model, kind, input, output, cacheRead, cacheWrite, estCostUSD, at? }. */
export function logUsage(entry) {
  oneOf(entry?.kind, USAGE_KINDS, 'usage.kind');
  return create(STORES.usage, {
    at: now(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    estCostUSD: 0,
    ...entry,
  });
}

/** Usage records with `from <= at < to` (ISO strings; either may be omitted). */
export function usageBetween(from, to) {
  let range;
  if (from && to) range = IDBKeyRange.bound(from, to, false, true);
  else if (from) range = IDBKeyRange.lowerBound(from);
  else if (to) range = IDBKeyRange.upperBound(to, true);
  return byIndex(STORES.usage, 'by_at', range);
}

/** Totals for a period: { calls, input, output, cacheRead, cacheWrite, estCostUSD }. */
export async function usageTotals(from, to) {
  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estCostUSD: 0 };
  for (const u of await usageBetween(from, to)) {
    totals.calls++;
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'estCostUSD']) totals[f] += Number(u[f]) || 0;
  }
  return totals;
}

/** Start of the current calendar month (local time) as an ISO string. */
export function monthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
}
