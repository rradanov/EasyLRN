// T-005: in-browser unit tests for src/db.js (IndexedDB is a browser API).
// Opened directly (tests/db.html) or by Playwright (tests/e2e/db.spec.js).
// Each test runs against its own temporary database, never the app's `lrn-app`.
import * as db from '../src/db.js';

const { STORES } = db;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- tiny assertion helpers -------------------------------------------------
class AssertionError extends Error {}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new AssertionError(msg); }
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg} expected ${e}, got ${a}`);
}
async function rejects(promiseOrFn, pattern, msg = '') {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    if (pattern && !pattern.test(String(err.message))) throw new AssertionError(`${msg} wrong error: ${err.message}`);
    return;
  }
  throw new AssertionError(`${msg} expected an error`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixtures ---------------------------------------------------------------
const COURSE = 'LRN-TEST';
const LESSON = `${COURSE}/lessons/0001-test.html`;
const selector = (start = 10, exact = 'съответствие') => ({
  quote: { exact, prefix: 'текст преди ', suffix: ' текст след' },
  position: { start, end: start + exact.length },
  hint: { blockPath: 'main > p:nth-of-type(2)' },
});

/** A lesson with: annotation → note (+annotation → subtopic), thread → 2 messages
 *  (+annotation on the answer → subtopic → annotation → subtopic). */
async function seedTree() {
  await db.putCourse({ id: COURSE, title: 'Тестов курс' });
  await db.putLesson({ id: LESSON, courseId: COURSE, number: '0001', title: 'Урок 1', order: 1, path: 'lessons/0001-test.html' });
  const a1 = await db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: selector(), color: 'yellow' });
  const note = await db.createNote({ annotationId: a1.id, body: '**Бележка**' });
  const aNote = await db.createAnnotation({ courseId: COURSE, target: { type: 'note', id: note.id }, selector: selector(0, 'Бележка'), color: null });
  const subNote = await db.createSubTopic({ annotationId: aNote.id, kind: 'термин', title: 'Тема от бележка' });
  const thread = await db.createThread({ annotationId: a1.id, title: 'Въпрос' });
  const q = await db.createMessage({ threadId: thread.id, role: 'user', content: 'Какво значи това?' });
  const ans = await db.createMessage({ threadId: thread.id, role: 'assistant', content: 'Отговор', status: 'done' });
  const aAns = await db.createAnnotation({ courseId: COURSE, target: { type: 'message', id: ans.id }, selector: selector(0, 'Отговор') });
  const sub1 = await db.createSubTopic({ annotationId: aAns.id, kind: 'контекст', title: 'Тема 1' });
  const aSub = await db.createAnnotation({ courseId: COURSE, target: { type: 'subtopic', id: sub1.id }, selector: selector(3, 'дълбоко') });
  const sub2 = await db.createSubTopic({ annotationId: aSub.id, kind: 'задълбочаване', title: 'Тема 2' });
  return { a1, note, aNote, subNote, thread, q, ans, aAns, sub1, aSub, sub2 };
}

// --- schema and migrations --------------------------------------------------
test('схема v1: всички хранилища и индекси', async () => {
  const conn = await db.openDb();
  eq(conn.version, db.SCHEMA_VERSION, 'version');
  eq(db.SCHEMA_VERSION, 2, 'SCHEMA_VERSION');
  eq([...conn.objectStoreNames].sort(), Object.values(STORES).sort(), 'stores');
  const expected = {
    files: ['by_course'], lessons: ['by_course'], annotations: ['by_course', 'by_target'],
    notes: ['by_annotation'], threads: ['by_annotation'], messages: ['by_thread'],
    subtopics: ['by_annotation', 'by_course', 'by_parent', 'by_root'], usage: ['by_at'],
    quizzes: ['by_course', 'by_lesson'], quizAnswers: [],
    courses: [], settings: [],
  };
  const tx = conn.transaction(Object.values(STORES));
  for (const [store, indexes] of Object.entries(expected)) {
    eq([...tx.objectStore(store).indexNames].sort(), indexes, store);
  }
  eq(tx.objectStore('annotations').index('by_target').keyPath, ['target.type', 'target.id'], 'by_target keyPath');
  eq(tx.objectStore('subtopics').index('by_parent').keyPath, ['parent.type', 'parent.id'], 'by_parent keyPath');
  eq(tx.objectStore('files').keyPath, 'key', 'files keyPath');
});

// The runner opens each test's database at the current SCHEMA_VERSION (2), so
// these migration-machinery tests reset to a fresh v1 database first and then
// drive a custom upgrade with their own migration set (V1 holds only the real
// migration 1).
const V1 = { 1: db.MIGRATIONS[1] };
async function freshAtV1(name) {
  db.closeDb();
  await db.deleteDatabase(name);
  await db.openDb({ name, version: 1, migrations: V1 });
}

test('миграция v1 → v2 запазва данните и добавя индекс', async (name) => {
  const v2 = {
    ...V1,
    2(conn, tx) {
      tx.objectStore('notes').createIndex('by_updated', 'updatedAt');
      // Data migration example: give old notes a `format` field (synchronous, see MIGRATIONS).
      db.eachRecord(tx, 'notes', (value, cursor) => cursor.update({ ...value, format: 'markdown' }));
    },
  };
  await freshAtV1(name);
  const note = await db.createNote({ annotationId: 'A1', body: 'стара' });
  db.closeDb();
  const conn = await db.openDb({ name, version: 2, migrations: v2 });
  eq(conn.version, 2, 'version');
  const migrated = await db.get(STORES.notes, note.id);
  eq(migrated.body, 'стара', 'body kept');
  eq(migrated.format, 'markdown', 'data migrated');
  eq((await db.byIndex(STORES.notes, 'by_updated', note.updatedAt)).length, 1, 'new index');
});

test('T-006-fix: асинхронна миграция се отхвърля, версията остава', async (name) => {
  await freshAtV1(name);
  await db.createNote({ annotationId: 'KEEP', body: 'пази' });
  db.closeDb();
  const bad = { ...V1, async 2(conn, tx) { tx.objectStore('notes').createIndex('x', 'body'); } };
  await rejects(db.openDb({ name, version: 2, migrations: bad }), /./);
  const conn = await db.openDb({ name, version: 1, migrations: V1 });
  eq(conn.version, 1, 'version unchanged');
  eq((await db.byIndex(STORES.notes, 'by_annotation', 'KEEP')).length, 1, 'data kept');
});

test('T-006-fix: грешка в eachRecord прекъсва миграцията', async (name) => {
  await freshAtV1(name);
  await db.createNote({ annotationId: 'KEEP', body: 'пази' });
  db.closeDb();
  const bad = { ...V1, 2(conn, tx) {
    tx.objectStore('notes').createIndex('x', 'body');
    db.eachRecord(tx, 'notes', () => { throw new Error('boom'); });
  } };
  await rejects(db.openDb({ name, version: 2, migrations: bad }), /./);
  const conn = await db.openDb({ name, version: 1, migrations: V1 });
  eq(conn.version, 1, 'version unchanged');
  eq([...conn.transaction('notes').objectStore('notes').indexNames], ['by_annotation'], 'no index x');
});

test('липсваща миграция → грешка, без да се чупи следващото отваряне', async (name) => {
  await freshAtV1(name);
  db.closeDb();
  await rejects(db.openDb({ name, version: 3, migrations: V1 }), /No migration to schema version 2/);
  const conn = await db.openDb({ name, version: 1, migrations: V1 });
  eq(conn.version, 1);
});

test('повторно отваряне на същата база връща същата връзка', async () => {
  const a = await db.openDb();
  const b = await db.openDb();
  assert(a === b, 'same connection');
});

// --- generic CRUD on every store ---------------------------------------------
const SAMPLES = {
  courses: () => ({ id: COURSE, title: 'Курс', importedAt: new Date().toISOString(), files: 2, meta: { mission: 'Мисия' } }),
  files: () => ({ key: `${COURSE}/INDEX.md`, courseId: COURSE, path: 'INDEX.md', mime: 'text/markdown', blob: new Blob(['# Индекс'], { type: 'text/markdown' }), sha256: 'abc' }),
  lessons: () => ({ id: LESSON, courseId: COURSE, kind: 'lesson', number: '0001', title: 'Урок', order: 1, path: 'lessons/0001-test.html', sha256: 'x' }),
  annotations: () => ({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: selector(), color: 'green', anchorState: 'ok' }),
  notes: () => ({ annotationId: 'A1', body: 'текст' }),
  threads: () => ({ annotationId: 'A1', title: null }),
  messages: () => ({ threadId: 'T1', role: 'user', content: 'въпрос', status: 'done' }),
  subtopics: () => ({ courseId: COURSE, annotationId: 'A1', parent: { type: 'lesson', id: LESSON }, rootLessonId: LESSON, depth: 1, title: 'Тема', kind: 'термин', content: '# Тема', status: 'done' }),
  settings: () => ({ id: 'settings', model: 'claude-sonnet-5-5' }),
  usage: () => ({ at: new Date().toISOString(), model: 'claude-sonnet-5-5', kind: 'answer', input: 10, output: 20, cacheRead: 0, cacheWrite: 0, estCostUSD: 0.001 }),
  quizzes: () => ({ id: `${COURSE}/quizzes/0001-1.json`, courseId: COURSE, path: 'quizzes/0001-1.json', slug: '0001-1', lesson: '0001', title: 'Тест', count: 1, order: 1, questions: [{ q: 'Въпрос?', options: ['А', 'Б'], answer: 0, why: '', src: '' }], sha256: 'q' }),
  quizAnswers: () => ({ id: `${COURSE}/quizzes/0001-1.json`, courseId: COURSE, choices: { abc: 0 }, cursor: 0 }),
};

for (const store of Object.values(STORES)) {
  test(`CRUD: ${store} (създаване, четене, обновяване, меко и истинско изтриване)`, async () => {
    const created = await db.create(store, SAMPLES[store]());
    const key = store === 'files' ? created.key : created.id;
    assert(key, 'has key');
    assert(created.createdAt && created.updatedAt, 'timestamps');
    eq(created.deleted, false, 'deleted flag');
    if (store !== 'files') assert(created.id, 'id');

    const read = await db.get(store, key);
    eq(read?.createdAt, created.createdAt, 'read back');
    if (store === 'files') eq(await read.blob.text(), '# Индекс', 'blob content');
    eq((await db.list(store)).length, 1, 'list');

    await rejects(db.create(store, { ...SAMPLES[store](), ...(store === 'files' ? {} : { id: created.id }) }), /Key already exists|ConstraintError|constraint/i, 'duplicate add');

    await sleep(2);
    const updated = await db.update(store, key, { extra: 'променено' });
    eq(updated.extra, 'променено', 'patched');
    eq(updated.createdAt, created.createdAt, 'createdAt kept');
    assert(updated.updatedAt > created.updatedAt, 'updatedAt moved');
    eq((await db.get(store, key)).extra, 'променено', 'update stored');

    await db.remove(store, key);
    eq(await db.get(store, key), undefined, 'soft-deleted hidden');
    eq((await db.list(store)).length, 0, 'soft-deleted not listed');
    eq((await db.get(store, key, { includeDeleted: true }))?.deleted, true, 'still there');
    await db.restore(store, key);
    eq((await db.get(store, key))?.deleted, false, 'restored');

    await db.purge(store, key);
    eq(await db.get(store, key, { includeDeleted: true }), undefined, 'purged');
  });
}

test('update/remove на несъществуващ запис → грешка', async () => {
  await rejects(db.update(STORES.notes, 'няма', { body: 'x' }), /not found/);
  await rejects(db.remove(STORES.notes, 'няма'), /not found/);
  await rejects(() => db.get('unknown', 'x'), /Unknown store/);
});

test('put запазва createdAt и сменя updatedAt', async () => {
  const first = await db.putCourse({ id: COURSE, title: 'Стар' });
  await sleep(2);
  const second = await db.putCourse({ id: COURSE, title: 'Нов' });
  eq(second.createdAt, first.createdAt);
  assert(second.updatedAt > first.updatedAt);
  eq((await db.getCourse(COURSE)).title, 'Нов');
  eq((await db.listCourses()).length, 1);
});

// --- domain functions -----------------------------------------------------------
test('файлове на курса: ключ, Blob, по курс (индекс by_course)', async () => {
  await db.putFile({ courseId: COURSE, path: 'lessons/0001-test.html', mime: 'text/html', blob: new Blob(['<p>урок</p>'], { type: 'text/html' }), sha256: 'h1' });
  await db.putFile({ courseId: COURSE, path: 'MISSION.md', mime: 'text/markdown', blob: new Blob(['# Мисия']), sha256: 'h2' });
  await db.putFile({ courseId: 'LRN-OTHER', path: 'MISSION.md', mime: 'text/markdown', blob: new Blob(['x']), sha256: 'h3' });
  const file = await db.getFile(COURSE, 'lessons/0001-test.html');
  eq(file.key, `${COURSE}/lessons/0001-test.html`);
  eq(file.blob.type, 'text/html');
  eq(await file.blob.text(), '<p>урок</p>');
  eq((await db.listCourseFiles(COURSE)).map((f) => f.path).sort(), ['MISSION.md', 'lessons/0001-test.html']);
});

test('уроци: ред по order, повторен импорт пази прогреса', async () => {
  await db.putLesson({ id: `${COURSE}/R01.html`, courseId: COURSE, kind: 'reference', number: 'R01', title: 'Справочник', order: 2 });
  await db.putLesson({ id: LESSON, courseId: COURSE, number: '0001', title: 'Урок 1', order: 1 });
  eq((await db.listLessons(COURSE)).map((l) => l.number), ['0001', 'R01']);
  eq((await db.getLesson(LESSON)).progress, { status: 'new', lastOpenedAt: null, scrollY: 0 });

  const opened = new Date().toISOString();
  await db.setLessonProgress(LESSON, { status: 'started', lastOpenedAt: opened, scrollY: 640 });
  await db.putLesson({ id: LESSON, courseId: COURSE, number: '0001', title: 'Урок 1 (нова версия)', order: 1, sha256: 'new' });
  const lesson = await db.getLesson(LESSON);
  eq(lesson.title, 'Урок 1 (нова версия)');
  eq(lesson.progress, { status: 'started', lastOpenedAt: opened, scrollY: 640 }, 'progress kept');
  await db.setLessonProgress(LESSON, { status: 'done' });
  eq((await db.getLesson(LESSON)).progress.scrollY, 640, 'partial progress update');
  await rejects(() => db.setLessonProgress(LESSON, { status: 'готов' }), /progress.status/);
  await rejects(() => db.putLesson({ id: 'x', courseId: COURSE, kind: 'video' }), /lesson.kind/);
});

test('анотация: TextQuote + TextPosition селектори, валидиране', async () => {
  const a = await db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, targetVersion: 'sha-1', selector: selector(42) });
  eq(a.selector, selector(42));
  eq(a.color, null, 'no color by default');
  eq(a.anchorState, 'ok');
  const base = { courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: selector() };
  await rejects(() => db.createAnnotation({ ...base, color: 'red' }), /annotation.color/);
  await rejects(() => db.createAnnotation({ ...base, target: { type: 'page', id: '1' } }), /DocRef.type/);
  await rejects(() => db.createAnnotation({ ...base, target: { type: 'lesson', id: '' } }), /DocRef.id/);
  await rejects(() => db.createAnnotation({ ...base, selector: { quote: { exact: '' }, position: { start: 0, end: 0 } } }), /quote.exact/);
  await rejects(() => db.createAnnotation({ ...base, selector: { quote: { exact: 'a' }, position: { start: 5, end: 2 } } }), /position/);
  await rejects(() => db.createAnnotation({ ...base, anchorState: 'lost' }), /anchorState/);

  const moved = await db.updateAnnotation(a.id, { color: 'pink', anchorState: 'fuzzy', target: { type: 'note', id: 'x' } });
  eq(moved.color, 'pink');
  eq(moved.anchorState, 'fuzzy');
  eq(moved.target, { type: 'lesson', id: LESSON }, 'target never changes');
  await rejects(() => db.updateAnnotation(a.id, { color: 'black' }), /annotation.color/);
});

test('„деца на документ“: annotations.by_target и subtopics.by_parent', async () => {
  const t = await seedTree();
  const onLesson = await db.annotationsFor({ type: 'lesson', id: LESSON });
  eq(onLesson.map((a) => a.id), [t.a1.id], 'only the lesson annotation');
  eq((await db.annotationsFor({ type: 'message', id: t.ans.id })).map((a) => a.id), [t.aAns.id]);
  eq((await db.subtopicsByParent({ type: 'message', id: t.ans.id })).map((s) => s.id), [t.sub1.id]);
  eq((await db.subtopicsByParent({ type: 'subtopic', id: t.sub1.id })).map((s) => s.id), [t.sub2.id]);

  const children = await db.getDocChildren({ type: 'lesson', id: LESSON });
  eq(children.length, 1);
  eq(children[0].annotation.id, t.a1.id);
  eq(children[0].notes.map((n) => n.id), [t.note.id]);
  eq(children[0].threads.map((x) => x.thread.id), [t.thread.id]);
  eq(children[0].threads[0].messages.map((m) => m.role), ['user', 'assistant'], 'messages in order');
  eq(children[0].subtopics, []);

  await db.remove(STORES.annotations, t.a1.id);
  eq(await db.annotationsFor({ type: 'lesson', id: LESSON }), [], 'soft-deleted hidden');
  eq((await db.annotationsFor({ type: 'lesson', id: LESSON }, { includeDeleted: true })).length, 1);
});

test('„дърво на урок“: subtopics.by_root и getLessonTree', async () => {
  const t = await seedTree();
  // Another lesson's tree must not leak in.
  const other = `${COURSE}/lessons/0002.html`;
  await db.putLesson({ id: other, courseId: COURSE, number: '0002', title: 'Урок 2', order: 2 });
  const aOther = await db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: other }, selector: selector() });
  await db.createSubTopic({ annotationId: aOther.id, kind: 'термин', title: 'Чужда' });

  eq((await db.subtopicsByRoot(LESSON)).map((s) => s.title).sort(), ['Тема 1', 'Тема 2', 'Тема от бележка']);
  eq((await db.subtopicsByRoot(other)).map((s) => s.title), ['Чужда']);

  const tree = await db.getLessonTree(LESSON);
  eq(tree.ref, { type: 'lesson', id: LESSON });
  eq(tree.record.title, 'Урок 1');
  const [ann] = tree.annotations;
  eq(ann.annotation.id, t.a1.id);
  const noteNode = ann.notes[0];
  eq(noteNode.ref, { type: 'note', id: t.note.id });
  eq(noteNode.annotations[0].subtopics[0].record.title, 'Тема от бележка');
  const answer = ann.threads[0].messages[1];
  eq(answer.ref, { type: 'message', id: t.ans.id });
  const sub1 = answer.annotations[0].subtopics[0];
  eq(sub1.record.title, 'Тема 1');
  const sub2 = sub1.annotations[0].subtopics[0];
  eq(sub2.record.title, 'Тема 2');
  eq(sub2.annotations, []);
});

test('допълнителна тема: автоматичен корен и дълбочина', async () => {
  const t = await seedTree();
  eq([t.sub1.rootLessonId, t.sub1.depth], [LESSON, 1], 'from an answer');
  eq([t.sub2.rootLessonId, t.sub2.depth], [LESSON, 2], 'from a subtopic');
  eq([t.subNote.rootLessonId, t.subNote.depth], [LESSON, 1], 'from a note');
  eq(t.sub1.parent, { type: 'message', id: t.ans.id }, 'parent = annotation.target');
  eq(t.sub1.courseId, COURSE, 'courseId from the annotation');
  eq(t.sub1.status, 'pending');
  await rejects(() => db.createSubTopic({ annotationId: t.a1.id, kind: 'обща' }), /subtopic.kind/);
  await rejects(() => db.createSubTopic({ annotationId: 'няма', kind: 'термин' }), /annotation not found/);
});

test('съобщения: роли, статуси, ред по време', async () => {
  const thread = await db.createThread({ annotationId: 'A1' });
  const ids = [];
  for (let i = 0; i < 20; i++) {
    ids.push((await db.createMessage({ threadId: thread.id, role: i % 2 ? 'assistant' : 'user', content: `#${i}` })).id);
  }
  eq((await db.messagesFor(thread.id)).map((m) => m.content), ids.map((_, i) => `#${i}`));
  eq((await db.messagesFor(thread.id))[1].status, 'pending', 'assistant starts pending');
  await rejects(() => db.createMessage({ threadId: thread.id, role: 'system' }), /message.role/);
  await rejects(() => db.createMessage({ threadId: thread.id, role: 'user', status: 'sent' }), /message.status/);
  const m = await db.update(STORES.messages, ids[1], { status: 'done', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  eq(m.usage.cacheWrite, 4);
});

test('newId: уникални, 26 знака, нарастващи', async () => {
  const ids = Array.from({ length: 5000 }, () => db.newId());
  assert(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)), 'format');
  eq(new Set(ids).size, ids.length, 'unique');
  assert(ids.every((id, i) => i === 0 || ids[i - 1] < id), 'monotonic');
});

test('настройки: стойности по подразбиране и запис', async () => {
  const s = await db.getSettings();
  eq(s.model, 'claude-sonnet-5-5');
  eq([s.maxTokensAnswer, s.maxTokensSubtopic, s.monthlyBudgetUSD], [1500, 3000, 5]);
  eq(s.colors.map((c) => c.id), db.COLORS);
  s.colors[0].label = 'промяна в копието';
  eq(db.DEFAULT_SETTINGS.colors[0].label, 'Важно', 'defaults are not mutated');
  const saved = await db.saveSettings({ fontScale: 1.2, apiKey: 'test-key' });
  eq(saved.fontScale, 1.2);
  await db.saveSettings({ twoColumnMode: true });
  const again = await db.getSettings();
  eq([again.fontScale, again.apiKey, again.twoColumnMode, again.model], [1.2, 'test-key', true, 'claude-sonnet-5-5']);
  eq((await db.list(STORES.settings)).length, 1, 'one settings record');
});

test('usage: запис и сума за месеца (D-022)', async () => {
  await db.logUsage({ at: '2026-10-31T23:00:00.000Z', model: 'm', kind: 'answer', input: 100, output: 10, estCostUSD: 0.5 });
  await db.logUsage({ at: '2026-11-01T00:00:00.000Z', model: 'm', kind: 'answer', input: 200, output: 20, cacheRead: 5, estCostUSD: 1.25 });
  await db.logUsage({ at: '2026-11-17T10:00:00.000Z', model: 'm', kind: 'subtopic', input: 300, output: 30, cacheWrite: 7, estCostUSD: 2 });
  const nov = await db.usageTotals('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
  eq(nov, { calls: 2, input: 500, output: 50, cacheRead: 5, cacheWrite: 7, estCostUSD: 3.25 });
  eq((await db.usageTotals()).calls, 3, 'all time');
  eq((await db.usageBetween(undefined, '2026-11-01T00:00:00.000Z')).length, 1, 'before');
  await rejects(() => db.logUsage({ kind: 'chat' }), /usage.kind/);
  assert(db.monthStart(new Date(2026, 10, 18)) === new Date(2026, 10, 1).toISOString(), 'monthStart');
});

test('storage: persist() и estimate() не хвърлят грешки', async () => {
  const persisted = await db.requestPersistence();
  assert(persisted === true || persisted === false || persisted === null, `persist: ${persisted}`);
  const est = await db.storageEstimate();
  assert(est && Number.isFinite(est.usage) && Number.isFinite(est.quota), 'estimate numbers');
});

test('1000 анотации: заявка по документ (за сведение; критерият е в T-006)', async () => {
  const conn = await db.openDb();
  const tx = conn.transaction(STORES.annotations, 'readwrite');
  for (let i = 0; i < 1000; i++) {
    tx.store.put({ id: db.newId(), courseId: COURSE, target: { type: 'lesson', id: i % 2 ? LESSON : 'other' }, selector: selector(i), color: 'yellow', anchorState: 'ok', createdAt: '', updatedAt: '', deleted: false });
  }
  await tx.done;
  const t0 = performance.now();
  const found = await db.annotationsFor({ type: 'lesson', id: LESSON });
  const ms = performance.now() - t0;
  eq(found.length, 500);
  return `${ms.toFixed(1)} ms за 500 от 1000`;
});

// --- T-006 (tester): edge cases ---------------------------------------------
const sel = (exact, start = 0, prefix = '', suffix = '') => ({ quote: { exact, prefix, suffix }, position: { start, end: start + exact.length } });
const annOn = (type, id, exact = 'текст', extra = {}) => db.createAnnotation({ courseId: COURSE, target: { type, id }, selector: sel(exact), ...extra });

test('T-006 празна база: четенията връщат празно, не грешка', async () => {
  eq(await db.listCourses(), [], 'courses');
  eq(await db.listLessons(COURSE), [], 'lessons');
  eq(await db.listCourseFiles(COURSE), [], 'files');
  eq(await db.getCourse('няма'), undefined, 'course');
  eq(await db.annotationsFor({ type: 'lesson', id: LESSON }), [], 'annotations');
  eq(await db.subtopicsByRoot(LESSON), [], 'subtopics by root');
  eq(await db.getDocChildren({ type: 'message', id: 'няма' }), [], 'doc children');
  const tree = await db.getLessonTree('няма');
  eq([tree.record, tree.annotations], [undefined, []], 'tree of a missing lesson');
  const s = await db.getSettings();
  eq([s.model, s.maxTokensAnswer, s.maxTokensSubtopic, s.monthlyBudgetUSD, s.apiKey], ['claude-sonnet-5-5', 1500, 3000, 5, ''], 'default settings');
  eq(await db.usageTotals(db.monthStart()), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estCostUSD: 0 }, 'usage');
});

test('T-006 модел (ARCHITECTURE §3): всички полета се записват и четат', async () => {
  const course = await db.putCourse({ id: COURSE, title: 'Курс', importedAt: '2026-11-18T10:00:00.000Z', files: 3,
    meta: { mission: 'М', notes: 'Н', resources: 'Р', glossary: 'Г', index: 'И' } });
  eq(Object.keys((await db.getCourse(COURSE)).meta).sort(), ['glossary', 'index', 'mission', 'notes', 'resources']);
  const file = await db.putFile({ courseId: COURSE, path: 'lessons/0001-test.html', mime: 'text/html', blob: new Blob(['<h1>Урок</h1>']), sha256: 'f'.repeat(64) });
  eq([file.key, file.mime, file.sha256.length], [`${COURSE}/lessons/0001-test.html`, 'text/html', 64]);
  const lesson = await db.putLesson({ id: LESSON, courseId: COURSE, kind: 'reference', number: 'R01', title: 'Р', order: 2, path: 'lessons/0001-test.html', sha256: 'a', textCache: 'чист текст' });
  eq([lesson.kind, lesson.textCache, lesson.progress], ['reference', 'чист текст', { status: 'new', lastOpenedAt: null, scrollY: 0 }]);
  const a = await db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, targetVersion: 'a',
    selector: { ...sel('съответствие', 10, 'x'.repeat(32), 'y'.repeat(32)), hint: { blockPath: 'main > p' } }, color: 'pink', anchorState: 'fuzzy' });
  const ra = await db.getAnnotation(a.id);
  eq([ra.targetVersion, ra.color, ra.anchorState, ra.selector.hint.blockPath, ra.selector.quote.prefix.length], ['a', 'pink', 'fuzzy', 'main > p', 32]);
  for (const k of ['id', 'createdAt', 'updatedAt', 'deleted']) assert(k in ra, `common field ${k}`);
  const th = await db.createThread({ annotationId: a.id, title: 'Въпрос' });
  const m = await db.createMessage({ threadId: th.id, role: 'assistant', content: 'О', status: 'done', model: 'claude-sonnet-5-5', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  eq([(await db.get(STORES.messages, m.id)).model, (await db.get(STORES.messages, m.id)).usage], ['claude-sonnet-5-5', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }]);
  const aM = await annOn('message', m.id, 'О');
  const st = await db.createSubTopic({ annotationId: aM.id, kind: 'контекст', title: 'Т', content: '# Т', status: 'done', model: 'm', usage: { input: 5 } });
  const rs = await db.getSubTopic(st.id);
  eq([rs.courseId, rs.annotationId, rs.parent, rs.rootLessonId, rs.depth, rs.kind, rs.content, rs.status, rs.model, rs.usage],
    [COURSE, aM.id, { type: 'message', id: m.id }, LESSON, 1, 'контекст', '# Т', 'done', 'm', { input: 5 }]);
  const s = await db.saveSettings({ apiKey: 'k', colors: [{ id: 'yellow', label: 'Важно' }], fontScale: 1.25, twoColumnMode: true, lastBackupAt: '2026-11-18T00:00:00.000Z' });
  eq([s.apiKey, s.fontScale, s.twoColumnMode, s.lastBackupAt, s.colors.length], ['k', 1.25, true, '2026-11-18T00:00:00.000Z', 1]);
  const u = await db.logUsage({ model: 'm', kind: 'subtopic', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, estCostUSD: 0.5 });
  eq(Object.keys(u).filter((k) => ['id', 'at', 'model', 'kind', 'input', 'output', 'cacheRead', 'cacheWrite', 'estCostUSD'].includes(k)).length, 9, 'UsageLog fields');
});

/** lesson → A1 → subtopic S1 (d1) → A2 → thread → answer → A3 → subtopic S2 (d2)
 *  → A4 → note → A5 → subtopic S3 (d3) → A6 → subtopic S4 (d4) → A7 → subtopic S5 (d5). */
async function seedDeep() {
  await db.putLesson({ id: LESSON, courseId: COURSE, title: 'Урок', order: 1 });
  const A1 = await annOn('lesson', LESSON);
  const S1 = await db.createSubTopic({ annotationId: A1.id, kind: 'термин', title: 'S1' });
  const A2 = await annOn('subtopic', S1.id);
  const T = await db.createThread({ annotationId: A2.id });
  const Q = await db.createMessage({ threadId: T.id, role: 'user', content: 'Защо?' });
  const ANS = await db.createMessage({ threadId: T.id, role: 'assistant', content: 'Защото', status: 'done' });
  const A3 = await annOn('message', ANS.id);
  const S2 = await db.createSubTopic({ annotationId: A3.id, kind: 'контекст', title: 'S2' });
  const A4 = await annOn('subtopic', S2.id);
  const N = await db.createNote({ annotationId: A4.id, body: 'бележка' });
  const A5 = await annOn('note', N.id);
  const S3 = await db.createSubTopic({ annotationId: A5.id, kind: 'задълбочаване', title: 'S3' });
  const A6 = await annOn('subtopic', S3.id);
  const S4 = await db.createSubTopic({ annotationId: A6.id, kind: 'термин', title: 'S4' });
  const A7 = await annOn('subtopic', S4.id);
  const S5 = await db.createSubTopic({ annotationId: A7.id, kind: 'термин', title: 'S5' });
  return { A1, S1, A2, T, Q, ANS, A3, S2, A4, N, A5, S3, A6, S4, A7, S5 };
}

/** Follow the chain in a tree; returns the S5 node (or throws with the step that broke). */
function walkDeep(tree) {
  const step = (cond, what) => { if (!cond) throw new AssertionError(`tree broken at ${what}`); };
  const s1 = tree.annotations[0]?.subtopics[0]; step(s1?.record?.title === 'S1', 'S1');
  const ans = s1.annotations[0]?.threads[0]?.messages[1]; step(ans?.record?.content === 'Защото', 'answer');
  const s2 = ans.annotations[0]?.subtopics[0]; step(s2?.record?.title === 'S2', 'S2');
  const note = s2.annotations[0]?.notes[0]; step(note?.record?.body === 'бележка', 'note');
  const s3 = note.annotations[0]?.subtopics[0]; step(s3?.record?.title === 'S3', 'S3');
  const s4 = s3.annotations[0]?.subtopics[0]; step(s4?.record?.title === 'S4', 'S4');
  const s5 = s4.annotations[0]?.subtopics[0]; step(s5?.record?.title === 'S5', 'S5');
  return { s1, ans, s2, note, s3, s4, s5 };
}

test('T-006 рекурсия: тема → нишка → отговор → тема → бележка → тема… (5 нива)', async () => {
  const t = await seedDeep();
  eq([t.S1, t.S2, t.S3, t.S4, t.S5].map((s) => [s.depth, s.rootLessonId]), [[1, LESSON], [2, LESSON], [3, LESSON], [4, LESSON], [5, LESSON]], 'depth/root');
  eq([t.S2.parent, t.S3.parent], [{ type: 'message', id: t.ANS.id }, { type: 'note', id: t.N.id }], 'parents');
  const tree = await db.getLessonTree(LESSON);
  const w = walkDeep(tree);
  eq(w.s5.annotations, [], 'leaf');
  eq(w.ans.ref, { type: 'message', id: t.ANS.id });
  eq(tree.annotations[0].subtopics[0].annotations[0].threads[0].messages[0].record.content, 'Защо?', 'question first');
  eq((await db.subtopicsByRoot(LESSON)).map((s) => s.title), ['S1', 'S2', 'S3', 'S4', 'S5'], 'by_root');
  eq((await db.getDocChildren({ type: 'message', id: t.ANS.id }))[0].subtopics.map((s) => s.title), ['S2'], 'children of the answer');
});

test('T-006 меко изтриване в средата на дървото скрива поддървото; restore го връща', async () => {
  const t = await seedDeep();
  await db.remove(STORES.messages, t.ANS.id);
  let tree = await db.getLessonTree(LESSON);
  const msgs = tree.annotations[0].subtopics[0].annotations[0].threads[0].messages;
  eq(msgs.map((m) => m.record.content), ['Защо?'], 'deleted answer hidden');
  eq((await db.subtopicsByRoot(LESSON)).length, 5, 'subtopics themselves are not deleted');
  walkDeep(await db.getLessonTree(LESSON, { includeDeleted: true }));
  await db.restore(STORES.messages, t.ANS.id);
  walkDeep(await db.getLessonTree(LESSON));
  // Deleting an annotation hides everything hanging on it.
  await db.remove(STORES.annotations, t.A5.id);
  tree = await db.getLessonTree(LESSON);
  eq(walkDeepUntilNote(tree).annotations, [], 'note has no visible annotations');
  eq((await db.annotationsFor({ type: 'note', id: t.N.id })).length, 0);
  eq((await db.annotationsFor({ type: 'note', id: t.N.id }, { includeDeleted: true })).length, 1);
  // A deleted record stays in the store with deleted: true (needed for backup merge, D-014).
  const raw = await db.get(STORES.annotations, t.A5.id, { includeDeleted: true });
  eq(raw.deleted, true);
  assert(raw.updatedAt >= raw.createdAt, 'updatedAt moves');
});
function walkDeepUntilNote(tree) {
  return tree.annotations[0].subtopics[0].annotations[0].threads[0].messages[1].annotations[0].subtopics[0].annotations[0].notes[0];
}

test('T-006 цикъл в данните (недостижим от урока) не зацикля getLessonTree и не влиза в дървото', async () => {
  await db.putLesson({ id: LESSON, courseId: COURSE, title: 'Урок', order: 1 });
  const a1 = await annOn('lesson', LESSON);
  const s1 = await db.createSubTopic({ annotationId: a1.id, kind: 'термин' });
  const a2 = await annOn('subtopic', s1.id);
  // Bad data: a subtopic whose annotation sits on itself.
  await db.create(STORES.subtopics, { id: 'LOOP', courseId: COURSE, annotationId: a2.id, parent: { type: 'subtopic', id: s1.id }, rootLessonId: LESSON, depth: 2, kind: 'термин' });
  await db.create(STORES.annotations, { id: 'LOOPANN', courseId: COURSE, target: { type: 'subtopic', id: 'LOOP' }, selector: sel('x') });
  await db.update(STORES.subtopics, 'LOOP', { annotationId: 'LOOPANN' });
  const tree = await Promise.race([db.getLessonTree(LESSON), sleep(3000).then(() => 'timeout')]);
  assert(tree !== 'timeout', 'tree returns');
  // Every record has exactly one parent, so a cycle is never reachable from the lesson.
  eq(tree.annotations[0].subtopics[0].annotations[0].subtopics, [], 'LOOP is not in the tree');
});

test('T-006 повторен импорт: курс, файлове и уроци се подменят, потребителските данни остават', async () => {
  const t = await seedDeep();
  await db.putCourse({ id: COURSE, title: 'v1', meta: { mission: 'стара' } });
  await db.putFile({ courseId: COURSE, path: 'lessons/0001-test.html', mime: 'text/html', blob: new Blob(['v1']), sha256: 'v1' });
  await db.setLessonProgress(LESSON, { status: 'started', scrollY: 1234, lastOpenedAt: '2026-11-18T09:00:00.000Z' });
  await db.saveSettings({ fontScale: 1.2 });
  const before = await db.getLessonTree(LESSON);
  // Re-import of a changed course.
  await db.putCourse({ id: COURSE, title: 'v2', meta: { mission: 'нова' } });
  await db.putFile({ courseId: COURSE, path: 'lessons/0001-test.html', mime: 'text/html', blob: new Blob(['v2']), sha256: 'v2' });
  await db.putLesson({ id: LESSON, courseId: COURSE, title: 'Урок (нов)', order: 1, sha256: 'v2' });
  const lesson = await db.getLesson(LESSON);
  eq([lesson.title, lesson.sha256], ['Урок (нов)', 'v2'], 'lesson replaced');
  eq(lesson.progress, { status: 'started', lastOpenedAt: '2026-11-18T09:00:00.000Z', scrollY: 1234 }, 'progress kept');
  eq(await (await db.getFile(COURSE, 'lessons/0001-test.html')).blob.text(), 'v2', 'file replaced');
  eq((await db.getCourse(COURSE)).title, 'v2');
  const after = await db.getLessonTree(LESSON);
  eq(JSON.stringify(after.annotations), JSON.stringify(before.annotations), 'annotation tree unchanged');
  eq((await db.getSettings()).fontScale, 1.2, 'settings kept');
  eq((await db.getAnnotation(t.A1.id)).targetVersion, null, 'annotation not rewritten');
});

test('T-006 граници: празни низове и невалидни стойности', async () => {
  await rejects(() => db.putCourse({ id: '' }), /course.id/);
  await rejects(() => db.putLesson({ id: LESSON, courseId: '' }), /lesson.courseId/);
  await rejects(() => db.putFile({ courseId: COURSE, path: '' }), /file.path/);
  await rejects(() => annOn('lesson', ''), /DocRef.id/);
  await rejects(() => db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: sel('') }), /quote.exact/);
  await rejects(() => db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: { quote: { exact: 'a' }, position: { start: 5, end: 2 } } }), /position/);
  await rejects(() => db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: { quote: { exact: 'a' }, position: { start: -1, end: 0 } } }), /position/);
  await rejects(() => db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: { quote: { exact: 'a' }, position: { start: 0.5, end: 1 } } }), /position/);
  await rejects(() => annOn('thread', 'T'), /DocRef.type/);
  await rejects(() => annOn('lesson', LESSON, 'x', { color: 'red' }), /color/);
  await rejects(() => db.createNote({ annotationId: '' }), /annotationId/);
  await rejects(() => db.createThread({ annotationId: '' }), /annotationId/);
  await rejects(() => db.createMessage({ threadId: '', role: 'user' }), /threadId/);
  await rejects(() => db.logUsage({ kind: '' }), /usage.kind/);
  await rejects(() => db.setLessonProgress(LESSON, { status: 'finished' }), /progress.status/);
  await rejects(() => db.create('nope', {}), /Unknown store/);
  // Empty bodies are allowed (a note / message being written).
  eq((await db.createNote({ annotationId: 'A', body: '' })).body, '');
  eq((await db.createMessage({ threadId: 'T', role: 'assistant' })).content, '');
  eq((await annOn('lesson', LESSON, ' ')).selector.quote.exact, ' ', 'whitespace selection kept as is');
});

test('T-006 граници: кирилица, емоджи и комбиниращи знаци в цитата', async () => {
  const exact = 'Зелен чай (ЕС) 2026/0001 👩‍💻🇧🇬 — „запарка“ é ñ';
  const prefix = '…'.repeat(10) + '🙂'.repeat(11); // 32 UTF-16 units
  const suffix = 'ъ'.repeat(31) + '‍';
  const a = await db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: { quote: { exact, prefix, suffix }, position: { start: 100, end: 100 + exact.length } } });
  const r = await db.getAnnotation(a.id);
  eq(r.selector.quote, { exact, prefix, suffix }, 'quote round trip');
  eq(r.selector.position.end - r.selector.position.start, exact.length, 'UTF-16 length');
  assert(r.selector.quote.exact.normalize('NFC') === exact.normalize('NFC'));
  const note = await db.createNote({ annotationId: a.id, body: '# Заглавие 🧠\n\n**удебелено** `код` <script>alert(1)</script>' });
  eq((await db.notesFor(a.id))[0].body, note.body, 'markdown/html kept verbatim (sanitising is the view’s job)');
});

test('T-006 граници: отговор от 100 KB и тема от 1 MB', async () => {
  const chunk = 'Текстът на отговора съдържа кирилица и емоджи 🙂. ';
  const big = chunk.repeat(Math.ceil(100 * 1024 / chunk.length)).slice(0, 100 * 1024);
  const th = await db.createThread({ annotationId: 'A' });
  const m = await db.createMessage({ threadId: th.id, role: 'assistant', content: '', status: 'streaming' });
  // Streaming: many small updates, then done.
  for (let i = 0; i < 20; i++) await db.update(STORES.messages, m.id, (rec) => ({ content: rec.content + big.slice(i * 5120, (i + 1) * 5120) }));
  await db.update(STORES.messages, m.id, { status: 'done' });
  const r = (await db.messagesFor(th.id))[0];
  eq([r.content.length, r.content === big, r.status], [big.length, true, 'done']);
  const huge = big.repeat(10);
  const s = await db.create(STORES.subtopics, { courseId: COURSE, annotationId: 'A', parent: { type: 'lesson', id: LESSON }, rootLessonId: LESSON, depth: 1, kind: 'термин', content: huge });
  eq((await db.getSubTopic(s.id)).content.length, huge.length);
});

test('T-006 едновременни записи: 200 анотации, 50 обновявания, 50 настройки', async () => {
  const anns = await Promise.all(Array.from({ length: 200 }, (_, i) => db.createAnnotation({ courseId: COURSE, target: { type: 'lesson', id: LESSON }, selector: sel(`ц${i}`, i) })));
  eq(new Set(anns.map((a) => a.id)).size, 200, 'unique ids');
  const stored = await db.annotationsFor({ type: 'lesson', id: LESSON });
  eq(stored.map((a) => a.selector.position.start), Array.from({ length: 200 }, (_, i) => i), 'all stored, creation order');
  const n = await db.createNote({ annotationId: anns[0].id, body: '' });
  await Promise.all(Array.from({ length: 50 }, () => db.update(STORES.notes, n.id, (rec) => ({ body: `${rec.body}x` }))));
  eq((await db.get(STORES.notes, n.id)).body.length, 50, 'no lost update (read+write in one transaction)');
  await Promise.all(Array.from({ length: 50 }, (_, i) => db.saveSettings({ [`k${i}`]: i })));
  const s = await db.getSettings();
  eq(Array.from({ length: 50 }, (_, i) => s[`k${i}`]), Array.from({ length: 50 }, (_, i) => i), 'no lost settings field');
  const th = await db.createThread({ annotationId: anns[0].id });
  await Promise.all(Array.from({ length: 30 }, (_, i) => db.createMessage({ threadId: th.id, role: 'user', content: `${i}` })));
  eq((await db.messagesFor(th.id)).map((m) => m.content), Array.from({ length: 30 }, (_, i) => `${i}`), 'messages keep order');
});

test('T-006 миграция v1 → v2 (нов store + преместване на прогреса) и v2 → v3', async (name) => {
  await freshAtV1(name);
  await db.putLesson({ id: LESSON, courseId: COURSE, title: 'Урок', order: 1 });
  await db.setLessonProgress(LESSON, { status: 'done', scrollY: 77 });
  const a = await annOn('lesson', LESSON, 'цитат 🙂');
  db.closeDb();
  const migrations = {
    ...V1,
    2(conn, tx) {
      const progress = conn.createObjectStore('progress', { keyPath: 'lessonId' });
      progress.createIndex('by_status', 'status');
      db.eachRecord(tx, 'lessons', (lesson) => progress.put({ lessonId: lesson.id, ...lesson.progress }));
    },
    3(conn, tx) { tx.objectStore('annotations').createIndex('by_color', 'color'); },
  };
  let conn = await db.openDb({ name, version: 2, migrations });
  eq(conn.version, 2);
  eq((await conn.get('progress', LESSON)).scrollY, 77, 'progress moved');
  eq((await db.getAnnotation(a.id)).selector.quote.exact, 'цитат 🙂', 'annotation kept');
  db.closeDb();
  conn = await db.openDb({ name, migrations }); // 2 → 3
  eq(conn.version, 3);
  eq((await db.byIndex(STORES.annotations, 'by_color', 'yellow')).length, 0);
  eq((await conn.getAllFromIndex('progress', 'by_status', 'done')).length, 1);
});

// --- runner -------------------------------------------------------------------
async function run() {
  const rows = document.getElementById('results');
  const summary = document.getElementById('summary');
  const results = [];
  for (const [i, t] of tests.entries()) {
    const name = `easylrn-test-${i}`;
    await db.deleteDatabase(name);
    await db.openDb({ name });
    const t0 = performance.now();
    let error = null;
    let info = null;
    try {
      info = await t.fn(name);
    } catch (err) {
      error = err;
    }
    const ms = performance.now() - t0;
    await db.deleteDatabase(name);
    results.push({ name: t.name, ok: !error, error: error ? String(error.stack || error) : null, info, ms });
    const tr = document.createElement('tr');
    const cells = [t.name, error ? `✗ ${error.message}` : `✓${info ? ` (${info})` : ''}`, ms.toFixed(0)];
    cells.forEach((text, c) => {
      const td = document.createElement('td');
      if (c === 1) td.className = error ? 'fail' : 'pass';
      if (c === 2) td.className = 'ms';
      td.textContent = text;
      tr.append(td);
    });
    rows.append(tr);
    if (error) console.error(t.name, error);
  }
  const failed = results.filter((r) => !r.ok).length;
  summary.textContent = failed
    ? `НЕУСПЕШНИ: ${failed} от ${results.length}`
    : `Всички ${results.length} теста минават.`;
  summary.className = failed ? 'fail' : 'pass';
  window.dbTestResults = results;
  summary.dataset.done = 'true';
  return results;
}

if (new URLSearchParams(location.search).get('run') !== 'none') run();
