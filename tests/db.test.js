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
  eq(db.SCHEMA_VERSION, 1, 'SCHEMA_VERSION');
  eq([...conn.objectStoreNames].sort(), Object.values(STORES).sort(), 'stores');
  const expected = {
    files: ['by_course'], lessons: ['by_course'], annotations: ['by_course', 'by_target'],
    notes: ['by_annotation'], threads: ['by_annotation'], messages: ['by_thread'],
    subtopics: ['by_annotation', 'by_course', 'by_parent', 'by_root'], usage: ['by_at'],
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

test('миграция v1 → v2 запазва данните и добавя индекс', async (name) => {
  const v2 = {
    ...db.MIGRATIONS,
    2(conn, tx) {
      tx.objectStore('notes').createIndex('by_updated', 'updatedAt');
      // Data migration example: give old notes a `format` field.
      return tx.objectStore('notes').openCursor().then(function step(cursor) {
        if (!cursor) return;
        cursor.update({ ...cursor.value, format: 'markdown' });
        return cursor.continue().then(step);
      });
    },
  };
  await db.openDb({ name, version: 1 });
  const note = await db.createNote({ annotationId: 'A1', body: 'стара' });
  db.closeDb();
  const conn = await db.openDb({ name, migrations: v2 });
  eq(conn.version, 2, 'version');
  const migrated = await db.get(STORES.notes, note.id);
  eq(migrated.body, 'стара', 'body kept');
  eq(migrated.format, 'markdown', 'data migrated');
  eq((await db.byIndex(STORES.notes, 'by_updated', note.updatedAt)).length, 1, 'new index');
});

test('липсваща миграция → грешка, без да се чупи следващото отваряне', async (name) => {
  await rejects(db.openDb({ name, version: 3, migrations: { 1: db.MIGRATIONS[1] } }), /No migration to schema version 2/);
  const conn = await db.openDb({ name });
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
