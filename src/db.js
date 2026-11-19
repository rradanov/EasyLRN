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
import { openDB, deleteDB, unwrap } from '../vendor/idb.js';
import { migrateV4toV5 } from './lesson-id.js';

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
  quizzes: 'quizzes',
  quizAnswers: 'quizAnswers',
  // v4 (T-019): secrets of the user, only the Claude API key for now (D-037).
  // Never exported, never sent to a lesson: see BACKUP_STORES below.
  secrets: 'secrets',
});

/**
 * The stores a backup (T-031) may export, as an explicit ALLOW-list: a store
 * added later is not exported until it is named here. `secrets` (the API key)
 * is never in it (D-014: "without the API key"); `files` holds course files
 * that a re-import restores (ARCHITECTURE §7: only with "включи и курсовете").
 */
export const BACKUP_STORES = Object.freeze([
  STORES.courses, STORES.lessons, STORES.annotations, STORES.notes, STORES.threads,
  STORES.messages, STORES.subtopics, STORES.settings, STORES.usage, STORES.quizzes, STORES.quizAnswers,
]);
/** Stores that never leave this browser (not in any export, never posted to a lesson). */
export const PRIVATE_STORES = Object.freeze([STORES.secrets]);

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
// The API key is NOT a setting (T-019): it lives in the `secrets` store
// (getApiKey/saveApiKey/deleteApiKey), so the settings record can be shown,
// exported and sent around without it.
export const DEFAULT_SETTINGS = Object.freeze({
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
  theme: 'system', // 'system' | 'light' | 'dark' (T-019)
  twoColumnMode: false,
  lastBackupAt: null,
});

// ---------------------------------------------------------------------------
// Schema and migrations
// ---------------------------------------------------------------------------

/**
 * Migrations by target version. Each runs inside the upgrade (versionchange)
 * transaction and gets `(db, tx)`; they run in order from the stored version
 * + 1 up to the requested one. Never edit a released migration — add a new
 * version instead.
 *
 * RULE (T006-D2): a migration is SYNCHRONOUS. It may only issue IndexedDB
 * operations on `db`/`tx` (createObjectStore, createIndex, put…) and must
 * return nothing — no `async`, no `await`, no promise. Anything awaited outside
 * IndexedDB lets the upgrade transaction auto-commit with the new version but
 * without the rest of the migration, and that can never be undone. To move
 * data, use `eachRecord(tx, store, fn)`: its callback runs synchronously for
 * every record inside the same transaction. A migration that returns a
 * promise/thenable is rejected (the upgrade is aborted, the version stays).
 * An exception (also one thrown by an `eachRecord` callback) aborts the whole
 * upgrade: the database stays at the old version with its data.
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
  // v2 (T-047, D-032/D-033): the "Тестове" section. `quizzes` holds the
  // imported quiz definitions (quizzes/*.json); `quizAnswers` holds the user's
  // answers, keyed by the quiz id, each choice under a hash of the question
  // text so a re-import keeps the answers of unchanged questions.
  2(db) {
    const quizzes = db.createObjectStore(STORES.quizzes, { keyPath: 'id' });
    quizzes.createIndex('by_course', 'courseId');
    quizzes.createIndex('by_lesson', ['courseId', 'lesson']);

    db.createObjectStore(STORES.quizAnswers, { keyPath: 'id' });
  },
  // v3 (T048-D1/D3): answers by content, not by index. A choice is stored as
  // the TEXT of the chosen option, under a key from the question text, its
  // options (sorted) and the text of the right one (+ the number of an earlier
  // identical question). Old choices (index under a hash of the text) are
  // converted with the stored quiz; the old map stays as `choicesV2`.
  3(db, tx) {
    const raw = unwrap(tx);
    const quizzes = new Map();
    // T-055: the walk is tracked (beginWalk/endWalk, no change in what it
    // does), so a later migration of the same upgrade (v5) reads the answers
    // only after this one has converted them.
    beginWalk(tx);
    const read = raw.objectStore(STORES.quizzes).openCursor();
    read.onsuccess = () => {
      const cursor = read.result;
      if (cursor) { quizzes.set(cursor.value.id, cursor.value); cursor.continue(); return; }
      eachRecord(tx, STORES.quizAnswers, (value, c) => {
        if (value.choicesV2 !== undefined) return;
        c.update({ ...value, choices: migrateChoicesV2(quizzes.get(value.id), value.choices), choicesV2: value.choices ?? {} });
      });
      endWalk(tx);
    };
  },
  // v4 (T-019): the `secrets` store for the API key. A key kept in the
  // settings record by an earlier build (`settings.apiKey`, never set by any
  // released screen) moves there and leaves the settings record.
  4(db, tx) {
    db.createObjectStore(STORES.secrets, { keyPath: 'id' });
    eachRecord(tx, STORES.settings, (value, c) => {
      if (!value || !Object.hasOwn(value, 'apiKey')) return;
      const { apiKey, ...rest } = value;
      if (typeof apiKey === 'string' && apiKey) {
        unwrap(tx).objectStore(STORES.secrets).put({ id: API_KEY_ID, value: apiKey, updatedAt: value.updatedAt ?? now() });
      }
      c.update(rest);
    });
  },
  // v5 (T-055, D-039): lessons, references and quizzes are keyed by course +
  // number (`<course>/lesson:0003`, `<course>/reference:R01`,
  // `<course>/quiz:0003-1`), not by path. migrateV4toV5() (src/lesson-id.js,
  // pure, also for the backup T-031) merges duplicates and the `renamedTo`
  // records of T-011-fix; the stores are rewritten in this transaction, so
  // the upgrade is all or nothing.
  // It reads only after the data walks of earlier migrations in the same
  // upgrade have finished (whenQuiet): requests run in the order they are
  // placed, so reading at once would see e.g. v2 answers not yet converted by v3.
  5(db, tx) {
    whenQuiet(tx, () => readStores(tx, [STORES.lessons, STORES.annotations, STORES.subtopics, STORES.quizzes, STORES.quizAnswers], (data) => {
      const out = migrateV4toV5(data);
      const raw = unwrap(tx);
      for (const store of [STORES.lessons, STORES.quizzes, STORES.quizAnswers]) {
        const os = raw.objectStore(store);
        os.clear();
        for (const record of out[store]) os.put(record);
      }
      for (const a of out.changed.annotations) raw.objectStore(STORES.annotations).put(a);
      for (const s of out.changed.subtopics) raw.objectStore(STORES.subtopics).put(s);
      if (out.warnings.length) console.warn(`IndexedDB v5: ${out.warnings.length} record(s) kept as they are:`, out.warnings);
    }));
  },
});

/**
 * For data migrations: read every record of `stores` (getAll over the raw
 * upgrade transaction) and call `fn({ [store]: records })` synchronously in
 * the last success callback, still inside the transaction. An exception in
 * `fn` aborts the whole upgrade (like eachRecord()).
 */
export function readStores(tx, stores, fn) {
  const raw = unwrap(tx);
  const data = {};
  let left = stores.length;
  beginWalk(tx);
  for (const store of stores) {
    const request = raw.objectStore(store).getAll();
    request.onsuccess = () => {
      data[store] = request.result;
      if (--left) return;
      try {
        fn(data);
        endWalk(tx);
      } catch (err) {
        failUpgrade(raw, err);
      }
    };
  }
}

/** Abort the upgrade with `err` (openDb() rejects with it as `cause`). */
function failUpgrade(raw, err) {
  upgradeErrors.set(raw, err);
  console.warn('IndexedDB migration failed, upgrade aborted:', err);
  try { raw.abort(); } catch { /* already finished */ }
}

// Data walks in progress per upgrade transaction, and what waits for them.
const walks = new WeakMap();
const walkState = (tx) => {
  const raw = unwrap(tx);
  if (!walks.has(raw)) walks.set(raw, { active: 0, waiting: [] });
  return walks.get(raw);
};
/** A migration starts reading/writing records over several callbacks. */
export function beginWalk(tx) { walkState(tx).active++; }
/** …and is done: what waits in whenQuiet() runs when no walk is left. */
export function endWalk(tx) {
  const state = walkState(tx);
  if (--state.active > 0) return;
  state.active = 0;
  const raw = unwrap(tx);
  while (state.waiting.length && state.active === 0) {
    const fn = state.waiting.shift();
    try { fn(); } catch (err) { failUpgrade(raw, err); return; }
  }
}
/**
 * Run `fn` (synchronously, in the upgrade transaction) once every data walk
 * started by earlier migrations of this upgrade (eachRecord, readStores, or
 * one marked with beginWalk/endWalk) has finished; at once if none is running.
 */
export function whenQuiet(tx, fn) {
  const state = walkState(tx);
  if (state.active === 0) fn();
  else state.waiting.push(fn);
}

/** v2 → v3 choices of one quiz: { textHash: index } → { questionKey: option text }. */
export function migrateChoicesV2(quiz, old) {
  const out = {};
  if (!quiz || !Array.isArray(quiz.questions) || !old || typeof old !== 'object') return out;
  const keys = questionKeys(quiz.questions);
  const seen = new Set();
  quiz.questions.forEach((question, i) => {
    const legacy = legacyQuestionKey(question.q);
    if (seen.has(legacy)) return; // v2 shared one answer between equal texts: the first one keeps it
    seen.add(legacy);
    const index = old[legacy];
    if (Number.isInteger(index) && typeof question.options?.[index] === 'string') out[keys[i]] = question.options[index];
  });
  return out;
}

/**
 * For data migrations: call `fn(value, cursor)` synchronously for every record
 * of `store` (cursor over the raw upgrade transaction). `fn` may call
 * `cursor.update(next)` / `cursor.delete()` and write to other stores of `tx`.
 * Must be called from inside a migration.
 */
export function eachRecord(tx, store, fn) {
  const request = unwrap(tx).objectStore(store).openCursor();
  beginWalk(tx);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) { endWalk(tx); return; }
    try {
      fn(cursor.value, cursor);
      cursor.continue();
    } catch (err) {
      // Abort the whole upgrade; openDb() rejects with this error as `cause`.
      upgradeErrors.set(request.transaction, err);
      console.warn('IndexedDB migration failed, upgrade aborted:', err);
      try { request.transaction.abort(); } catch { /* already finished */ }
    }
  };
}

/** Errors thrown inside eachRecord() callbacks, by raw upgrade transaction. */
const upgradeErrors = new WeakMap();

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
/** A DOM event about the database for the page (no-op where there is no window, e.g. tests in Node). */
function dbEvent(type, detail) {
  try {
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent(type, { detail }));
    }
  } catch { /* never fails the database */ }
}

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
  let migrationError = null;
  let upgradeTx = null;
  let wasBlocked = false;
  const promise = openDB(name, version, {
    upgrade(db, oldVersion, newVersion, tx) {
      upgradeTx = unwrap(tx);
      // If a migration fails the transaction is aborted and its `done` promise
      // rejects with AbortError; openDb() reports the failure, so that promise
      // must not end up as an unhandled rejection (T006-D3).
      tx.done.catch(() => {});
      try {
        for (let v = oldVersion + 1; v <= newVersion; v++) {
          const result = migrations[v](db, tx);
          if (result && typeof result.then === 'function') {
            result.then(undefined, () => {}); // its later failure is irrelevant: we abort now
            throw new Error(`Migration ${v} returned a promise; migrations must be synchronous (see MIGRATIONS)`);
          }
        }
      } catch (err) {
        // Abort explicitly (not by letting the exception escape the event
        // handler, which Chrome reports as an uncaught error): the version
        // is not bumped and openDb() rejects with this error as `cause`.
        migrationError = err;
        console.warn('IndexedDB migration failed, upgrade aborted:', err);
        try { tx.abort(); } catch { /* already finished */ }
      }
    },
    blocked() {
      // T056-D3: another tab (an old version that does not let go, a frozen
      // tab) keeps the database open, so the upgrade waits. Tell the page:
      // the screens would otherwise just stay empty.
      wasBlocked = true;
      dbEvent('easylrn:db-blocked', { blocked: true });
    },
    blocking() {
      // A newer version was opened in another tab: let it upgrade.
      if (dbPromise === promise) closeDb();
      onVersionChange?.();
    },
    terminated() {
      if (dbPromise === promise) dbPromise = null;
    },
  }).then((db) => {
    if (wasBlocked) dbEvent('easylrn:db-blocked', { blocked: false });
    return db;
  }, (err) => {
    if (wasBlocked) dbEvent('easylrn:db-blocked', { blocked: false });
    if (dbPromise === promise) dbPromise = null;
    migrationError ??= upgradeTx && upgradeErrors.get(upgradeTx);
    if (migrationError) {
      const e = new Error(`IndexedDB upgrade aborted: ${migrationError.message}`, { cause: migrationError });
      e.name = 'AbortError';
      throw e;
    }
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

/**
 * Store the assembled (self-contained) version of a lesson file next to its
 * original (T-045, LESSON-ISOLATION §4.2): { sha256, rendered, renderVersion,
 * renderDeps, links }. Written only if the file still has that `sha256` (a
 * newer import wins). Derived data: `updatedAt` is kept, so a render never
 * looks like a change of the course. The original `blob`/`sha256` are not touched.
 * @returns {Promise<object|null>} the updated record, or null if the file changed or is gone
 */
export async function setFileRender(courseId, path, { sha256, rendered, renderVersion, renderDeps = {}, links = [] }) {
  const db = await openDb();
  const tx = db.transaction(STORES.files, 'readwrite');
  const record = await tx.store.get(fileKey(courseId, path));
  if (!record || record.deleted || record.sha256 !== sha256) {
    await tx.done;
    return null;
  }
  const next = { ...record, rendered, renderVersion, renderSha: sha256, renderDeps, links };
  await tx.store.put(next);
  await tx.done;
  return next;
}
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
  // Read and write in ONE readwrite transaction (T006-D1): a concurrent
  // setLessonProgress() is serialized before or after it, never lost.
  const db = await openDb();
  const tx = db.transaction(STORES.lessons, 'readwrite');
  const existing = await tx.store.get(lesson.id);
  const record = stamp(STORES.lessons, {
    kind: 'lesson',
    ...lesson,
    createdAt: existing?.createdAt ?? lesson.createdAt,
    progress: existing?.progress ?? { ...NEW_PROGRESS, ...lesson.progress },
  });
  await tx.store.put(record);
  await tx.done;
  return record;
}

export const getLesson = (id, opts) => get(STORES.lessons, id, opts);

/**
 * Write the result of a course import in ONE readwrite transaction over
 * courses, files, lessons and quizzes (T-007): either all of it is stored or nothing.
 * - course: merged over the stored one (`meta` fields missing in this import are kept);
 * - files: inserted or replaced (`createdAt` kept);
 * - lessons: inserted or replaced; the user's `progress` is always kept (read
 *   in this transaction, so a concurrent setLessonProgress() is never lost).
 *   Since D-039 a lesson is keyed by its number: a renamed file is the same
 *   record (new `path`, the old one in `previousPaths`), so nothing has to be
 *   moved and the user's data (annotations, notes, threads, messages,
 *   subtopics) is never touched here.
 * Re-importing undeletes a soft-deleted course, file or lesson.
 */
export async function saveCourseImport({ course, files = [], lessons = [], quizzes = [] }) {
  requireString(course?.id, 'course.id');
  for (const f of files) {
    if (f.courseId !== course.id) throw new TypeError('file.courseId must match course.id');
    requireString(f.path, 'file.path');
  }
  for (const l of lessons) {
    if (l.courseId !== course.id) throw new TypeError('lesson.courseId must match course.id');
    requireString(l.id, 'lesson.id');
    oneOf(l.kind ?? 'lesson', LESSON_KINDS, 'lesson.kind');
  }
  for (const q of quizzes) {
    if (q.courseId !== course.id) throw new TypeError('quiz.courseId must match course.id');
    requireString(q.id, 'quiz.id');
  }
  const db = await openDb();
  const tx = db.transaction([STORES.courses, STORES.files, STORES.lessons, STORES.quizzes], 'readwrite');
  const courses = tx.objectStore(STORES.courses);
  const fileStore = tx.objectStore(STORES.files);
  const lessonStore = tx.objectStore(STORES.lessons);
  const quizStore = tx.objectStore(STORES.quizzes);
  const keys = files.map((f) => fileKey(f.courseId, f.path));
  const [oldCourse, oldFiles, oldLessons, oldQuizzes] = await Promise.all([
    courses.get(course.id),
    Promise.all(keys.map((k) => fileStore.get(k))),
    Promise.all(lessons.map((l) => lessonStore.get(l.id))),
    Promise.all(quizzes.map((q) => quizStore.get(q.id))),
  ]);
  const courseRecord = stamp(STORES.courses, {
    ...oldCourse,
    ...course,
    meta: { ...oldCourse?.meta, ...course.meta },
    createdAt: oldCourse?.createdAt,
    deleted: false,
  });
  const writes = [courses.put(courseRecord)];
  files.forEach((f, i) => {
    writes.push(fileStore.put(stamp(STORES.files, { ...f, key: keys[i], createdAt: oldFiles[i]?.createdAt, deleted: false })));
  });
  lessons.forEach((l, i) => {
    const old = oldLessons[i];
    writes.push(lessonStore.put(stamp(STORES.lessons, {
      kind: 'lesson',
      ...l,
      createdAt: old?.createdAt ?? l.createdAt,
      deleted: false,
      progress: old?.progress ?? { ...NEW_PROGRESS, ...l.progress },
    })));
  });
  // Quiz definitions are replaced; the answers (a separate store, keyed by
  // the quiz id and the question content) are never touched here, so they
  // survive a re-import — also of a renamed quiz file (same id, D-039).
  quizzes.forEach((q, i) => {
    writes.push(quizStore.put(stamp(STORES.quizzes, { ...q, createdAt: oldQuizzes[i]?.createdAt, deleted: false })));
  });
  await Promise.all([...writes, tx.done]);
  return courseRecord;
}


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
// Quizzes and quiz answers (T-047, D-032/D-033)
// ---------------------------------------------------------------------------

function hash32(s, seed) {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The v2 key: a hash of the question text only (kept for the v3 migration). */
export function legacyQuestionKey(q) {
  return hash32(String(q ?? '').trim(), 0x811c9dc5);
}

/**
 * A stable key for a question, from its CONTENT (T048-D1): the text, the
 * options in sorted order and the text of the right option. Reordered options
 * keep the key (the stored choice is the option text, so it follows); changed
 * options or another right answer give a new key (the answer is reset).
 * `dup` is the number of earlier questions with the same content (T048-D3).
 */
export function questionKey(question, dup = 0) {
  const q = typeof question === 'string' ? { q: question, options: [], answer: -1 } : question || {};
  const options = Array.isArray(q.options) ? q.options.map(String) : [];
  const right = options[q.answer] ?? '';
  const s = [String(q.q ?? '').trim(), [...options].sort().join('\u001e'), right].join('\u001f') + (dup ? `\u001f#${dup}` : '');
  return `${hash32(s, 0x811c9dc5)}${hash32(s, 0x01000193)}`;
}

/** Keys of all questions of a quiz, in order (equal questions get their number). */
export function questionKeys(questions) {
  const count = new Map();
  return (questions || []).map((question) => {
    const base = questionKey(question);
    const dup = count.get(base) ?? 0;
    count.set(base, dup + 1);
    return dup ? questionKey(question, dup) : base;
  });
}

/** Index of the stored choice (option text) in the question's options, or -1. */
export function choiceIndex(question, choice) {
  return typeof choice === 'string' ? question.options.indexOf(choice) : -1;
}

/** Quizzes of a course, in order (`order`, then id). */
export async function listQuizzes(courseId, opts) {
  const quizzes = await byIndex(STORES.quizzes, 'by_course', courseId, opts);
  return quizzes.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || String(a.id).localeCompare(String(b.id)));
}

export const getQuiz = (id, opts) => get(STORES.quizzes, id, opts);

/** Quizzes attached to a lesson number ("0001"); a lesson may have several. */
export const quizzesForLesson = (courseId, lesson, opts) =>
  byIndex(STORES.quizzes, 'by_lesson', [courseId, lesson], opts).then((qs) =>
    qs.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || String(a.id).localeCompare(String(b.id))));

/** The user's answers for a quiz: { choices: { [questionKey]: option text }, cursor }. */
export async function getQuizAnswers(quizId) {
  const record = await get(STORES.quizAnswers, quizId);
  return { id: quizId, choices: record?.choices ?? {}, cursor: record?.cursor ?? 0, ...record };
}

/** Save one chosen option for a question (merged into the quiz's answer record). */
export async function saveQuizChoice(quizId, { courseId, qKey, choice, cursor }) {
  requireString(quizId, 'quizId');
  requireString(qKey, 'qKey');
  if (typeof choice !== 'string') throw new TypeError('choice must be the text of the chosen option');
  const db = await openDb();
  const tx = db.transaction(STORES.quizAnswers, 'readwrite');
  const old = await tx.store.get(quizId);
  const record = stamp(STORES.quizAnswers, {
    ...old,
    id: quizId,
    courseId: courseId ?? old?.courseId ?? null,
    createdAt: old?.createdAt,
    deleted: false,
    choices: { ...old?.choices, [qKey]: choice },
    cursor: cursor ?? old?.cursor ?? 0,
  });
  await tx.store.put(record);
  await tx.done;
  return record;
}

/** Remember which question the reader is on (navigation), without changing choices. */
export async function saveQuizCursor(quizId, cursor) {
  const db = await openDb();
  const tx = db.transaction(STORES.quizAnswers, 'readwrite');
  const old = await tx.store.get(quizId);
  await tx.store.put(stamp(STORES.quizAnswers, {
    ...old, id: quizId, createdAt: old?.createdAt, deleted: false, choices: old?.choices ?? {}, cursor,
  }));
  await tx.done;
}

/** Forget the given question answers (used by "Опитай пак грешните"). */
export async function clearQuizChoices(quizId, qKeys) {
  const db = await openDb();
  const tx = db.transaction(STORES.quizAnswers, 'readwrite');
  const old = await tx.store.get(quizId);
  const choices = { ...old?.choices };
  for (const k of qKeys) delete choices[k];
  await tx.store.put(stamp(STORES.quizAnswers, {
    ...old, id: quizId, createdAt: old?.createdAt, deleted: false, choices, cursor: old?.cursor ?? 0,
  }));
  await tx.done;
}

/** Clear every answer of a quiz ("Нулирай отговорите"). */
export async function resetQuizAnswers(quizId) {
  const db = await openDb();
  const tx = db.transaction(STORES.quizAnswers, 'readwrite');
  const old = await tx.store.get(quizId);
  await tx.store.put(stamp(STORES.quizAnswers, {
    ...old, id: quizId, createdAt: old?.createdAt, deleted: false, choices: {}, cursor: 0,
  }));
  await tx.done;
}

/**
 * Score of a quiz from its questions and the stored answers.
 * @returns {{ total: number, answered: number, correct: number, wrong: number[], started: boolean, done: boolean }}
 */
export function scoreQuiz(quiz, answers) {
  const choices = answers?.choices ?? {};
  const wrong = [];
  let answered = 0;
  let correct = 0;
  const keys = questionKeys(quiz.questions);
  quiz.questions.forEach((question, i) => {
    const index = choiceIndex(question, choices[keys[i]]);
    if (index < 0) return;
    answered++;
    if (index === question.answer) correct++; else wrong.push(i);
  });
  const total = quiz.questions.length;
  return { total, answered, correct, wrong, started: answered > 0, done: total > 0 && answered === total };
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

/** Longest document chain walked upwards before we treat the data as broken. */
export const MAX_CHAIN_DEPTH = 64;

/**
 * Find the root lesson and depth for a new child of `ref`:
 * lesson → depth 1; subtopic → its depth + 1; note/message → up through the
 * annotation to the document it is attached to. Guarded against cycles and
 * over-long chains in bad data (T006-D4, e.g. from a corrupt backup).
 */
export async function resolveRoot(ref) {
  let { type, id } = checkDocRef(ref, 'parent');
  const seen = new Set();
  for (;;) {
    const key = `${type}:${id}`;
    if (seen.has(key)) throw new Error(`Cycle in the document chain at ${key}`);
    if (seen.size >= MAX_CHAIN_DEPTH) throw new Error(`Document chain longer than ${MAX_CHAIN_DEPTH} at ${key}`);
    seen.add(key);
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
    ({ type, id } = checkDocRef(ann.target, 'annotation.target'));
  }
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

/** Up to this many keys are read one getAll() each; more are read as one key range. */
const BATCH_SINGLE_MAX = 8;

const getPath = (record, path) => path.split('.').reduce((v, k) => v?.[k], record);
// Map key for an IndexedDB key: strings as they are, arrays as JSON (prefixed, so they never collide).
const serKey = (key) => (typeof key === 'string' ? key : `\u0001${JSON.stringify(key)}`);

/**
 * Batched index read (T-006 Н-1): records of `store` whose `index` key is one of
 * `keys`, as Map<serialized key, record[]>. A few keys → one getAll per key;
 * many keys → one getAll over the key range [min, max] (per first component
 * for compound keys), filtered in memory. Keeps the number of IndexedDB
 * requests per tree level constant instead of one per record.
 */
async function batchByIndex(tx, store, index, keys) {
  const out = new Map();
  const unique = [...new Map(keys.map((k) => [serKey(k), k])).values()];
  if (!unique.length) return out;
  const idx = tx.objectStore(store).index(index);
  const { keyPath } = idx;
  const keyOfRecord = (r) => (Array.isArray(keyPath) ? keyPath.map((p) => getPath(r, p)) : getPath(r, keyPath));
  const wanted = new Set(unique.map(serKey));

  let records;
  if (unique.length <= BATCH_SINGLE_MAX) {
    records = (await Promise.all(unique.map((k) => idx.getAll(k)))).flat();
  } else {
    // Group compound keys by their first component so a range never spans
    // unrelated types (e.g. all 'lesson' targets vs. all 'note' targets).
    const groups = new Map();
    for (const k of unique) {
      const g = Array.isArray(k) ? serKey(k[0]) : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }
    const parts = await Promise.all([...groups.values()].map((group) => {
      if (group.length === 1) return idx.getAll(group[0]);
      group.sort((a, b) => indexedDB.cmp(a, b));
      return idx.getAll(IDBKeyRange.bound(group[0], group[group.length - 1]));
    }));
    records = parts.flat().filter((r) => wanted.has(serKey(keyOfRecord(r))));
  }
  for (const r of records) {
    const k = serKey(keyOfRecord(r));
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * Children of several documents at once, in a constant number of requests:
 * Map<"type:id", [{ annotation, notes, threads: [{ thread, messages }], subtopics }]>.
 */
async function childrenOfMany(tx, refs, opts) {
  const keep = visible(opts);
  const pick = (map, key) => byIdOrder((map.get(serKey(key)) || []).filter(keep));

  const targets = refs.map((r) => [r.type, r.id]);
  const childrenOf = (ids) => Promise.all([
    batchByIndex(tx, STORES.notes, 'by_annotation', ids),
    batchByIndex(tx, STORES.threads, 'by_annotation', ids),
    batchByIndex(tx, STORES.subtopics, 'by_annotation', ids),
  ]);
  let annMap;
  let notes;
  let threads;
  let subtopics;
  if (targets.length <= BATCH_SINGLE_MAX) {
    // Few documents (e.g. the lesson itself): the annotation ids come cheaply
    // from getAllKeys, so the annotation values and their children are read
    // in parallel. Soft-deleted annotations may fetch a few extra children;
    // they are dropped below because only visible annotations are walked.
    const by = tx.objectStore(STORES.annotations).index('by_target');
    const keyLists = await Promise.all(targets.map((t) => by.getAllKeys(t)));
    [annMap, [notes, threads, subtopics]] = await Promise.all([
      batchByIndex(tx, STORES.annotations, 'by_target', targets),
      childrenOf(keyLists.flat()),
    ]);
  } else {
    annMap = await batchByIndex(tx, STORES.annotations, 'by_target', targets);
    const ids = [...annMap.values()].flat().filter(keep).map((a) => a.id);
    [notes, threads, subtopics] = await childrenOf(ids);
  }
  const annsByDoc = refs.map((r) => pick(annMap, [r.type, r.id]));
  const annIds = annsByDoc.flat().map((a) => a.id);
  const threadIds = annIds.flatMap((id) => pick(threads, id).map((t) => t.id));
  const messages = await batchByIndex(tx, STORES.messages, 'by_thread', threadIds);

  const result = new Map();
  refs.forEach((ref, i) => {
    result.set(`${ref.type}:${ref.id}`, annsByDoc[i].map((annotation) => ({
      annotation,
      notes: pick(notes, annotation.id),
      threads: pick(threads, annotation.id).map((thread) => ({ thread, messages: pick(messages, thread.id) })),
      subtopics: pick(subtopics, annotation.id),
    })));
  });
  return result;
}

/**
 * Direct children of a document: its annotations and, for each, the notes,
 * threads (with messages) and subtopics attached to it. One read transaction.
 */
export async function getDocChildren(ref, opts) {
  const doc = checkDocRef(ref, 'document');
  const db = await openDb();
  const tx = db.transaction(TREE_STORES, 'readonly');
  const result = await childrenOfMany(tx, [doc], opts);
  await tx.done;
  return result.get(`${doc.type}:${doc.id}`);
}

/**
 * The whole tree of a lesson (F4.4): every document node with its children,
 * recursively — lesson → annotations → notes / threads → messages / subtopics,
 * and the same again for annotations on notes, messages and subtopics.
 * Node: { ref, record?, annotations: [{ annotation, notes: [node], threads:
 *         [{ thread, messages: [node] }], subtopics: [node] }] }
 * Read level by level (breadth-first) in one transaction, so the number of
 * requests grows with the depth of the tree, not with the number of nodes.
 */
export async function getLessonTree(lessonId, opts) {
  const db = await openDb();
  const tx = db.transaction([STORES.lessons, ...TREE_STORES], 'readonly');
  const seen = new Set();
  const makeNode = (ref, record) => ({ ref, record, annotations: [] });

  const lesson = await tx.objectStore(STORES.lessons).get(lessonId);
  const root = makeNode({ type: 'lesson', id: lessonId }, lesson);
  let level = [root];
  seen.add(`lesson:${lessonId}`);
  let depth = 0;
  while (level.length) {
    if (++depth > MAX_CHAIN_DEPTH) break; // bad data: stop instead of looping
    const children = await childrenOfMany(tx, level.map((n) => n.ref), opts);
    const next = [];
    // A node already in the tree (a cycle in bad data) is shown as a leaf.
    const child = (type, record) => {
      const node = makeNode({ type, id: record.id }, record);
      const key = `${type}:${record.id}`;
      if (!seen.has(key)) { seen.add(key); next.push(node); }
      return node;
    };
    for (const node of level) {
      node.annotations = children.get(`${node.ref.type}:${node.ref.id}`).map((a) => ({
        annotation: a.annotation,
        notes: a.notes.map((n) => child('note', n)),
        threads: a.threads.map((t) => ({ thread: t.thread, messages: t.messages.map((m) => child('message', m)) })),
        subtopics: a.subtopics.map((s) => child('subtopic', s)),
      }));
    }
    level = next;
  }
  await tx.done;
  return root;
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
  // Open screens follow a change at once (e.g. the text size of an open lesson, T-045).
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('easylrn:settings', { detail: record }));
  return record;
}

// ---------------------------------------------------------------------------
// The API key (T-019, D-037): its own store, never in a settings event
// ---------------------------------------------------------------------------
// Rules: the key is never logged (console, errors), never put into a message
// to a lesson, never into the DOM except the key field of "Настройки" while
// the user types it, never into localStorage, and never into a backup.

const API_KEY_ID = 'apiKey';

/** The saved API key, or '' if there is none. */
export async function getApiKey() {
  const record = await (await openDb()).get(STORES.secrets, API_KEY_ID);
  return typeof record?.value === 'string' ? record.value : '';
}

/** Save the API key (already checked by the caller). Fires `easylrn:apikey` (no key in it). */
export async function saveApiKey(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('saveApiKey: empty key');
  await (await openDb()).put(STORES.secrets, { id: API_KEY_ID, value, updatedAt: now() });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('easylrn:apikey', { detail: { saved: true } }));
}

/** Delete the API key for real (no soft delete: nothing of it may stay). */
export async function deleteApiKey() {
  await (await openDb()).delete(STORES.secrets, API_KEY_ID);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('easylrn:apikey', { detail: { saved: false } }));
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
