// T-055 (developer, 0.9.0, D-039): permanent ids of lessons, references and
// quizzes — `<course>/lesson:NNNN`, `<course>/reference:RNN`,
// `<course>/quiz:NNNN-K` (or `quiz:path:<path>` outside the pattern).
// - IndexedDB v4 → v5: a REAL 0.8.1 profile (git archive 2bd1aa5) with
//   progress, quiz answers, a renamed lesson (a `renamedTo` shadow of
//   T-011-fix), a renamed quiz, annotations, a note and a subtopic → nothing
//   lost; a synthetic v4 database with duplicates; the pure migrateV4toV5();
// - re-import by number: renamed lesson / renamed quiz keep progress and answers;
// - retired lessons ("Вече не са в курса"): missing from a full import, listed
//   under "## Оттеглени номера", back again; a partial import retires nothing;
// - one number twice in a ZIP (lessons, R1/R01, quizzes) → nothing is written;
// - links by an old path or by the number in the file name;
// - T011F-D1: a quite different title on a lesson with progress → a warning;
// - T011F-D3: "Маркирай като завършен" in an old tab after a rename is kept;
// - a failed migration is shown on the screen; the v4 data stays.
// Synthetic data only (D-026).
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OLD_COMMIT = '2bd1aa5'; // 0.8.1, schema v4 (T-011-fix: renamedTo shadows)
const NOW_VERSION = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(REPO, 'src/config.js'), 'utf8'))[1];

let problems;
let external;
let allowed;
test.beforeEach(async ({ page, context }) => {
  problems = [];
  external = [];
  allowed = [];
  page.on('console', (m) => { if (m.type() === 'error' && !allowed.some((re) => re.test(m.text()))) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => {
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});

async function start(page) {
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}

const lessonHtml = (title, body = '<p>Измислен текст.</p>') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`);
const quizJson = (lesson, title, n = 2) => strToU8(JSON.stringify({
  lesson, title, questions: Array.from({ length: n }, (_, i) => ({ q: `${title}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: i % 2 })),
}));
const index = (id, rows, extra = '') => strToU8(`# ${id}: индекс\n\n## Уроци\n| # | Заглавие | Файл |\n|---|---|---|\n${rows.filter((r) => !r[0].startsWith('R')).map(([n, t, p]) => `| ${n} | ${t} | ${p ? `[${p}](https://example.org/x)` : ''} |`).join('\n')}\n\n## Справочници\n| # | Заглавие | Файл |\n|---|---|---|\n${rows.filter((r) => r[0].startsWith('R')).map(([n, t, p]) => `| ${n} | ${t} | ${p ? `[${p}](https://example.org/x)` : ''} |`).join('\n')}\n${extra}`);

async function importFiles(page, name, files, root) {
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));
  const buffer = makeZip(bytes, { root });
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    try {
      const s = await m.importCourse([new File([new Uint8Array(bytes)], name)]);
      return { ok: true, text: m.describeSummary(s), summary: s };
    } catch (err) {
      return { ok: false, text: m.errorMessage(err), name: err.name };
    }
  }, { name, bytes: [...buffer] });
}
const importCourse = (page, id, files) => importFiles(page, `${id}.zip`, files, id);

// Run fn(db, arg) in the page with the db module.
async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}
/** Every record of the user's stores (for "nothing was written"). */
const snapshot = (page) => page.evaluate(async () => {
  const idb = await new Promise((ok, fail) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
  const out = { version: idb.version };
  for (const s of ['courses', 'files', 'lessons', 'quizzes', 'quizAnswers', 'annotations', 'subtopics']) {
    out[s] = await new Promise((ok) => { const r = idb.transaction(s).objectStore(s).getAll(); r.onsuccess = () => ok(r.result.map((x) => JSON.stringify({ ...x, blob: undefined, rendered: undefined }))); });
  }
  idb.close();
  return out;
});
const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id) {
  await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
const lf = (page) => page.frameLocator('iframe.lesson-frame');

// ---------------------------------------------------------------------------
// The pure ids and the migration function
// ---------------------------------------------------------------------------
test.describe('T055-U ids and migrateV4toV5()', () => {
  test.beforeEach(async ({ page }) => { await start(page); });

  test('T055-U1 ids from paths: 4-digit lessons, R + ≥ 2 digits, quizzes NNNN-K, path-quizzes', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('./src/lesson-id.js');
      return {
        lessons: ['lessons/0003-x.html', 'lessons/0003-x.HTM', 'lessons/003-x.html', 'lessons/00003-x.html', 'lessons/0003.html', 'reference/R1-a.html', 'reference/r01.html', 'reference/R001-b.html', 'reference/R123-c.html', 'reference/x.html']
          .map((p) => [p, m.lessonNumberOf(p)]),
        ids: [m.lessonId('C', 'lesson', '0003'), m.lessonId('C', 'reference', 'r1')],
        quizzes: ['quizzes/0003-1-a.json', 'quizzes/0003-01-a.json', 'quizzes/0003-12.json', 'quizzes/0003-0-a.json', 'quizzes/m.json', 'quizzes/0003-a.json'].map((p) => m.quizId('C', p)),
        v4: [m.lessonIdFromV4('C/lessons/0003-x.html'), m.lessonIdFromV4('C/reference/R1-a.html'), m.lessonIdFromV4('C/lesson:0003'), m.quizIdFromV4('C/quizzes/0001-2-x.json')],
        norm: ['1', '01', '0001', 'r1', 'R01', '00001', '12345', 'x'].map(m.normalizeNumber),
      };
    });
    expect(r.lessons).toEqual([
      ['lessons/0003-x.html', { kind: 'lesson', number: '0003' }],
      ['lessons/0003-x.HTM', { kind: 'lesson', number: '0003' }],
      ['lessons/003-x.html', null],
      ['lessons/00003-x.html', null],
      ['lessons/0003.html', null],
      ['reference/R1-a.html', { kind: 'reference', number: 'R01' }],
      ['reference/r01.html', { kind: 'reference', number: 'R01' }],
      ['reference/R001-b.html', { kind: 'reference', number: 'R01' }],
      ['reference/R123-c.html', { kind: 'reference', number: 'R123' }],
      ['reference/x.html', null],
    ]);
    expect(r.ids).toEqual(['C/lesson:0003', 'C/reference:R01']);
    expect(r.quizzes).toEqual(['C/quiz:0003-1', 'C/quiz:0003-1', 'C/quiz:0003-12', 'C/quiz:path:quizzes/0003-0-a.json', 'C/quiz:path:quizzes/m.json', 'C/quiz:path:quizzes/0003-a.json']);
    expect(r.v4).toEqual(['C/lesson:0003', 'C/reference:R01', null, 'C/quiz:0001-2']);
    expect(r.norm).toEqual(['0001', '0001', '0001', 'R01', 'R01', null, null, null]);
  });

  test('T055-U2 migrateV4toV5(): duplicates and renamedTo shadows merge by the rules of D-039 §3; input untouched; idempotent', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('./src/lesson-id.js');
      const L = (path, extra) => ({ id: `C/${path}`, courseId: 'C', kind: path.startsWith('ref') ? 'reference' : 'lesson', number: /(\d{4}|R\d+)/.exec(path)[1], path, title: path, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', deleted: false, progress: { status: 'new', lastOpenedAt: null, scrollY: 0 }, ...extra });
      const data = {
        lessons: [
          // 0001: renamed in 0.8.1 → the old record is a soft-deleted shadow with renamedTo
          L('lessons/0001-old.html', { deleted: true, renamedTo: 'C/lessons/0001-new.html', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', progress: { status: 'done', completedAt: '2026-11-02T00:00:00.000Z', lastOpenedAt: '2026-11-02T00:00:00.000Z', scrollY: 5 } }),
          L('lessons/0001-new.html', { updatedAt: '2026-11-11T00:00:00.000Z', progress: { status: 'started', lastOpenedAt: '2026-11-15T00:00:00.000Z', scrollY: 77 } }),
          // 0002: two LIVE records (T011F-I7: both files came back) — the newer leads, status = highest
          L('lessons/0002-a.html', { updatedAt: '2026-11-13T00:00:00.000Z', progress: { status: 'started', lastOpenedAt: '2026-11-13T00:00:00.000Z', scrollY: 13 } }),
          L('lessons/0002-b.html', { updatedAt: '2026-11-14T00:00:00.000Z', progress: { status: 'done', completedAt: '2026-11-09T00:00:00.000Z', lastOpenedAt: '2026-11-09T00:00:00.000Z', scrollY: 9 } }),
          L('reference/R1-r.html', { number: 'R1' }),
          L('lessons/0003-c.html'),
          { id: 'C/odd.html', courseId: 'C', kind: 'lesson', number: 'x', path: 'odd.html', title: 'без номер' },
        ],
        annotations: [
          { id: 'A1', courseId: 'C', target: { type: 'lesson', id: 'C/lessons/0001-new.html' } },
          { id: 'A2', courseId: 'C', target: { type: 'lesson', id: 'C/lessons/0002-a.html' } },
          { id: 'A3', courseId: 'C', target: { type: 'note', id: 'N1' } },
          { id: 'A4', courseId: 'C', target: { type: 'lesson', id: 'C/lessons/0009-gone.html' } },
        ],
        subtopics: [
          { id: 'S1', parent: { type: 'lesson', id: 'C/lessons/0001-new.html' }, rootLessonId: 'C/lessons/0001-new.html' },
          { id: 'S2', parent: { type: 'subtopic', id: 'S1' }, rootLessonId: 'C/lessons/0001-old.html' },
        ],
        quizzes: [
          { id: 'C/quizzes/0001-1-a.json', courseId: 'C', path: 'quizzes/0001-1-a.json', updatedAt: '2026-11-01T00:00:00.000Z' },
          { id: 'C/quizzes/0001-1-a2.json', courseId: 'C', path: 'quizzes/0001-1-a2.json', updatedAt: '2026-11-05T00:00:00.000Z' },
          { id: 'C/quizzes/m.json', courseId: 'C', path: 'quizzes/m.json', updatedAt: '2026-11-01T00:00:00.000Z' },
        ],
        quizAnswers: [
          { id: 'C/quizzes/0001-1-a.json', courseId: 'C', choices: { q1: 'Да', q2: 'Не' }, updatedAt: '2026-11-01T00:00:00.000Z' },
          { id: 'C/quizzes/0001-1-a2.json', courseId: 'C', choices: { q1: 'Не' }, updatedAt: '2026-11-05T00:00:00.000Z' },
          { id: 'C/quizzes/m.json', courseId: 'C', choices: { x: 'Да' }, updatedAt: '2026-11-03T00:00:00.000Z' },
          { id: 'C/quizzes/0007-1-gone.json', courseId: 'C', choices: { y: 'Да' }, updatedAt: '2026-11-03T00:00:00.000Z' },
        ],
      };
      const before = JSON.stringify(data);
      const out = m.migrateV4toV5(data, { now: '2026-11-19T00:00:00.000Z' });
      const again = m.migrateV4toV5({ lessons: out.lessons, annotations: out.annotations, subtopics: out.subtopics, quizzes: out.quizzes, quizAnswers: out.quizAnswers }, { now: '2026-11-20T00:00:00.000Z' });
      const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
      return {
        untouched: JSON.stringify(data) === before,
        lessons: byId(out.lessons),
        ann: out.annotations.map((a) => [a.id, a.target.id]),
        sub: out.subtopics.map((s) => [s.id, s.parent.id, s.rootLessonId]),
        quizzes: out.quizzes.map((q) => [q.id, q.path, q.previousPaths ?? null]),
        answers: byId(out.quizAnswers),
        warnings: out.warnings.length,
        changed: [out.changed.annotations.length, out.changed.subtopics.length],
        idempotent: JSON.stringify([again.lessons, again.annotations, again.subtopics, again.quizzes, again.quizAnswers])
          === JSON.stringify([out.lessons, out.annotations, out.subtopics, out.quizzes, out.quizAnswers]),
        againChanged: [again.changed.annotations.length, again.changed.subtopics.length],
      };
    });
    expect(r.untouched).toBe(true);
    expect(Object.keys(r.lessons).sort()).toEqual(['C/lesson:0001', 'C/lesson:0002', 'C/lesson:0003', 'C/odd.html', 'C/reference:R01']);
    const l1 = r.lessons['C/lesson:0001'];
    expect(l1).toMatchObject({ path: 'lessons/0001-new.html', previousPaths: ['lessons/0001-old.html'], deleted: false, createdAt: '2026-10-01T00:00:00.000Z' });
    expect('renamedTo' in l1).toBe(false);
    // status: the highest (done from the shadow); lastOpenedAt: the newest with its scrollY; completedAt: the earliest (leader has none)
    expect(l1.progress).toMatchObject({ status: 'done', lastOpenedAt: '2026-11-15T00:00:00.000Z', scrollY: 77, completedAt: '2026-11-02T00:00:00.000Z' });
    const l2 = r.lessons['C/lesson:0002'];
    expect(l2).toMatchObject({ path: 'lessons/0002-b.html', previousPaths: ['lessons/0002-a.html'] });
    expect(l2.progress).toMatchObject({ status: 'done', lastOpenedAt: '2026-11-13T00:00:00.000Z', scrollY: 13, completedAt: '2026-11-09T00:00:00.000Z' });
    expect(r.lessons['C/reference:R01']).toMatchObject({ path: 'reference/R1-r.html', number: 'R1' });
    expect(r.lessons['C/odd.html'].title).toBe('без номер');
    expect(r.warnings).toBe(1);
    expect(r.ann).toEqual([['A1', 'C/lesson:0001'], ['A2', 'C/lesson:0002'], ['A3', 'N1'], ['A4', 'C/lesson:0009']]);
    expect(r.sub).toEqual([['S1', 'C/lesson:0001', 'C/lesson:0001'], ['S2', 'S1', 'C/lesson:0001']]);
    expect(r.changed).toEqual([3, 2]);
    expect(r.quizzes).toEqual([
      ['C/quiz:0001-1', 'quizzes/0001-1-a2.json', ['quizzes/0001-1-a.json']],
      ['C/quiz:path:quizzes/m.json', 'quizzes/m.json', null],
    ]);
    // the newer answers win; the older fill the gaps and stay whole in choicesMerged
    expect(r.answers['C/quiz:0001-1']).toMatchObject({ choices: { q1: 'Не', q2: 'Не' }, choicesMerged: { q1: 'Да', q2: 'Не' }, updatedAt: '2026-11-05T00:00:00.000Z' });
    expect(r.answers['C/quiz:path:quizzes/m.json']).toMatchObject({ choices: { x: 'Да' }, updatedAt: '2026-11-03T00:00:00.000Z' });
    expect(r.answers['C/quiz:0007-1']).toMatchObject({ choices: { y: 'Да' } });
    expect(Object.keys(r.answers)).toHaveLength(3);
    expect(r.idempotent).toBe(true);
    expect(r.againChanged).toEqual([0, 0]);
  });

  test('T055-U3 a synthetic v4 database (another name) opened by this build: one record per number, links kept, quiz answers found, no second migration', async ({ page }) => {
    const r = await db(page, async (db) => {
      const NAME = 't055-syn';
      await db.deleteDatabase(NAME);
      const v4 = await db.openDb({ name: NAME, version: 4 });
      const put = (store, rec) => v4.put(store, rec);
      const P = (status, at, y) => ({ status, lastOpenedAt: at, scrollY: y });
      await put('courses', { id: 'S', title: 'S', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deleted: false });
      await put('lessons', { id: 'S/lessons/0001-a.html', courseId: 'S', kind: 'lesson', number: '0001', path: 'lessons/0001-a.html', title: 'А', order: 1, deleted: true, renamedTo: 'S/lessons/0001-b.html', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', progress: P('done', '2026-11-01T10:00:00.000Z', 10) });
      await put('lessons', { id: 'S/lessons/0001-b.html', courseId: 'S', kind: 'lesson', number: '0001', path: 'lessons/0001-b.html', title: 'Б', order: 1, deleted: false, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', progress: { ...P('done', '2026-11-01T10:00:00.000Z', 10), completedAt: '2026-11-01T11:00:00.000Z' } });
      await put('lessons', { id: 'S/reference/R01-r.html', courseId: 'S', kind: 'reference', number: 'R01', path: 'reference/R01-r.html', title: 'Р', order: 2, deleted: false, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', progress: P('started', '2026-11-03T00:00:00.000Z', 3) });
      await put('annotations', { id: '01A', courseId: 'S', target: { type: 'lesson', id: 'S/lessons/0001-b.html' }, selector: { quote: { exact: 'x', prefix: '', suffix: '' }, position: { start: 0, end: 1 } }, color: 'yellow', anchorState: 'ok', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', deleted: false });
      await put('notes', { id: '01N', annotationId: '01A', body: 'бележка', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', deleted: false });
      await put('subtopics', { id: '01S', annotationId: '01A', courseId: 'S', kind: 'термин', parent: { type: 'lesson', id: 'S/lessons/0001-b.html' }, rootLessonId: 'S/lessons/0001-b.html', depth: 1, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', deleted: false });
      await put('quizzes', { id: 'S/quizzes/0001-1-q.json', courseId: 'S', path: 'quizzes/0001-1-q.json', slug: '0001-1-q', lesson: '0001', title: 'Т', questions: [{ q: 'В?', options: ['Да', 'Не'], answer: 0 }], count: 1, order: 1, deleted: false, updatedAt: '2026-11-01T00:00:00.000Z' });
      await put('quizAnswers', { id: 'S/quizzes/0001-1-q.json', courseId: 'S', choices: { k: 'Да' }, cursor: 0, updatedAt: '2026-11-04T00:00:00.000Z', deleted: false });
      await put('secrets', { id: 'apiKey', value: 'sk-ant-test-FAKE-t055', updatedAt: '2026-11-01T00:00:00.000Z' });
      db.closeDb();
      const v5 = await db.openDb({ name: NAME });
      const out = { version: v5.version };
      for (const s of ['lessons', 'annotations', 'subtopics', 'quizzes', 'quizAnswers', 'notes']) out[s] = await v5.getAll(s);
      out.key = (await v5.get('secrets', 'apiKey'))?.value?.length;
      out.tree = (await db.annotationsFor({ type: 'lesson', id: 'S/lesson:0001' })).map((a) => a.id);
      out.byRoot = (await db.subtopicsByRoot('S/lesson:0001')).map((s) => s.id);
      out.answers = await db.getQuizAnswers('S/quiz:0001-1');
      out.backup = db.BACKUP_STORES.includes('secrets');
      // Opening again: no second migration (same records, same updatedAt).
      db.closeDb();
      const again = await db.openDb({ name: NAME });
      out.sameAfterReopen = JSON.stringify(await again.getAll('lessons')) === JSON.stringify(out.lessons);
      db.closeDb();
      await db.deleteDatabase(NAME);
      await db.openDb({ name: 'lrn-app' });
      return out;
    });
    expect(r.version).toBe(5);
    expect(r.lessons.map((l) => [l.id, l.path, l.previousPaths ?? null, l.deleted, l.progress.status, l.progress.scrollY, l.progress.completedAt ?? null, 'renamedTo' in l]))
      .toEqual([
        ['S/lesson:0001', 'lessons/0001-b.html', ['lessons/0001-a.html'], false, 'done', 10, '2026-11-01T11:00:00.000Z', false],
        ['S/reference:R01', 'reference/R01-r.html', null, false, 'started', 3, null, false],
      ]);
    expect(r.annotations.map((a) => a.target)).toEqual([{ type: 'lesson', id: 'S/lesson:0001' }]);
    expect(r.subtopics.map((s) => [s.parent.id, s.rootLessonId])).toEqual([['S/lesson:0001', 'S/lesson:0001']]);
    expect(r.notes.map((n) => [n.annotationId, n.body])).toEqual([['01A', 'бележка']]);
    expect(r.tree).toEqual(['01A']);
    expect(r.byRoot).toEqual(['01S']);
    expect(r.quizzes.map((q) => q.id)).toEqual(['S/quiz:0001-1']);
    expect(r.answers.choices).toEqual({ k: 'Да' });
    expect(r.key).toBe('sk-ant-test-FAKE-t055'.length);
    expect(r.backup).toBe(false);
    expect(r.sameAfterReopen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A real 0.8.1 profile (schema v4) → this build (schema v5)
// ---------------------------------------------------------------------------
async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}
const REAL = 'LRN-T55';
const realV1 = () => ({
  'INDEX.md': index(REAL, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']]),
  'lessons/0001-alpha.html': lessonHtml('Алфа', '<p>Алфа е първата буква.</p><p><a href="0002-beta.html">към бета</a></p>'),
  'lessons/0002-beta.html': lessonHtml('Бета', '<p>Бета е втората буква.</p><p><a id="back" href="0001-alpha.html">към алфа</a></p>'),
  'lessons/0003-gama.html': lessonHtml('Гама'),
  'reference/R01-ref.html': lessonHtml('Справка'),
  'quizzes/0001-1-alpha.json': quizJson('0001', 'Тест алфа', 2),
  'quizzes/0002-1-beta.json': quizJson('0002', 'Тест бета', 2),
});
const realV2 = () => {
  const f = realV1();
  f['INDEX.md'] = index(REAL, [['0001', 'Алфа', 'lessons/0001-alpha-v2.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']]);
  f['lessons/0001-alpha-v2.html'] = f['lessons/0001-alpha.html'];
  delete f['lessons/0001-alpha.html'];
  f['quizzes/0002-1-beta-v2.json'] = f['quizzes/0002-1-beta.json'];
  delete f['quizzes/0002-1-beta.json'];
  return f;
};
const zipBytes = (files) => [...makeZip(Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v])), { root: REAL })];

test.describe('T055-M migration of a real 0.8.1 profile', () => {
  test('T055-M1 0.8.1 (v4: progress, answers, renamed lesson with a renamedTo shadow, renamed quiz, annotations, note, subtopic) → 0.9.0 (v5): nothing is lost, one row per number, the same ZIP is "Без промени"', async ({ page }, info) => {
    test.skip(!existsSync(join(REPO, '.git')), 'needs the git history');
    try { execSync(`git -C "${REPO}" cat-file -e ${OLD_COMMIT}^{commit}`, { stdio: 'ignore' }); } catch { test.skip(true, `needs commit ${OLD_COMMIT} (git fetch --deepen=50)`); }
    test.setTimeout(240_000);
    const port = 4700 + info.workerIndex * 2 + (info.project.name === 'tablet-portrait' ? 1 : 0);
    const base = `/tmp/t055-migrate-${port}`;
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    execSync(`git -C "${REPO}" archive ${OLD_COMMIT} | tar -x -C "${base}"`);
    const url = `http://localhost:${port}/EasyLRN/`;
    const doImport = (files) => page.evaluate(async (bytes) => {
      const m = await import('./src/course-import.js');
      return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], 'LRN-T55-20261119T090000Z-1-001.zip')]));
    }, zipBytes(files));

    // --- 0.8.1 (schema v4) ----------------------------------------------------------
    let stop = await serve(base, port);
    let before;
    try {
      await page.goto(url);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      expect(await page.evaluate(async () => (await import('./src/config.js')).APP_VERSION)).toBe('0.8.1');
      await doImport(realV1());
      before = await page.evaluate(async (C) => {
        const db = await import('./src/db.js');
        await db.setLessonProgress(`${C}/lessons/0001-alpha.html`, { status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T10:00:00.000Z', scrollY: 111 });
        await db.setLessonProgress(`${C}/lessons/0002-beta.html`, { status: 'started', lastOpenedAt: '2026-11-18T11:00:00.000Z', scrollY: 222 });
        await db.setLessonProgress(`${C}/reference/R01-ref.html`, { status: 'started', lastOpenedAt: '2026-11-18T09:00:00.000Z', scrollY: 7 });
        for (const q of await db.listQuizzes(C)) {
          const keys = db.questionKeys(q.questions);
          await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[0], choice: q.questions[0].options[0], cursor: 1 });
          if (q.lesson === '0001') await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[1], choice: q.questions[1].options[0], cursor: 1 });
        }
        const sel = { quote: { exact: 'първата', prefix: 'Алфа е ', suffix: ' буква' }, position: { start: 12, end: 19 } };
        const a1 = await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: `${C}/lessons/0001-alpha.html` }, selector: sel, color: 'yellow' });
        const a2 = await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: `${C}/lessons/0002-beta.html` }, selector: sel, color: 'green' });
        await db.createNote({ annotationId: a1.id, body: 'Моя бележка' });
        const t = await db.createThread({ annotationId: a2.id, title: 'Въпрос' });
        await db.createMessage({ threadId: t.id, role: 'user', content: 'Защо?' });
        const s = await db.createSubTopic({ annotationId: a1.id, kind: 'термин', title: 'Тема', courseId: C });
        return { a1: a1.id, a2: a2.id, s: s.id };
      }, REAL);
      // The lesson file and the quiz file are renamed (0.8.1: rename → renamedTo shadow; quiz → new id, answers not carried).
      await doImport(realV2());
      const v4 = await page.evaluate(async (C) => {
        const db = await import('./src/db.js');
        const idb = await db.openDb();
        return {
          version: idb.version,
          lessons: (await idb.getAll('lessons')).map((l) => [l.id.slice(C.length + 1), !!l.deleted, l.renamedTo ? 'renamedTo' : '']),
          quizzes: (await idb.getAll('quizzes')).map((q) => q.id.slice(C.length + 1)),
          answers: (await idb.getAll('quizAnswers')).map((a) => [a.id.slice(C.length + 1), Object.keys(a.choices).length]),
        };
      }, REAL);
      console.log(`T055-M1 v4 state: ${JSON.stringify(v4)}`);
      expect(v4.version).toBe(4);
      expect(v4.lessons).toContainEqual(['lessons/0001-alpha.html', true, 'renamedTo']);
      expect(v4.quizzes.sort()).toEqual(['quizzes/0001-1-alpha.json', 'quizzes/0002-1-beta-v2.json', 'quizzes/0002-1-beta.json']);
      expect(v4.answers.sort()).toEqual([['quizzes/0001-1-alpha.json', 2], ['quizzes/0002-1-beta.json', 1]]);
    } finally { await stop(); }

    // --- this build (schema v5) -----------------------------------------------------
    stop = await serve(REPO, port);
    try {
      await page.goto(url);
      await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20000 });
      await page.locator('#update-button').click();
      await expect.poll(() => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION).catch(() => null), { timeout: 20000 }).toBe(NOW_VERSION);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await expect(page.locator('#db-error')).toBeHidden();
      const after = await page.evaluate(async ({ C, ids }) => {
        const db = await import('./src/db.js');
        const idb = await db.openDb();
        const lessons = await idb.getAll('lessons');
        return {
          version: idb.version,
          lessons: lessons.map((l) => [l.id.slice(C.length + 1), l.path, l.previousPaths ?? null, !!l.deleted, l.progress.status, l.progress.scrollY, l.progress.completedAt ?? null, l.progress.lastOpenedAt ?? null, 'renamedTo' in l]),
          quizzes: (await idb.getAll('quizzes')).map((q) => [q.id.slice(C.length + 1), q.path, q.previousPaths ?? null]),
          answers: Object.fromEntries((await idb.getAll('quizAnswers')).map((a) => [a.id.slice(C.length + 1), Object.keys(a.choices).length])),
          ann: Object.fromEntries((await idb.getAll('annotations')).map((a) => [a.id, a.target.id.slice(C.length + 1)])),
          sub: (await idb.getAll('subtopics')).map((s) => [s.id === ids.s, s.parent.id.slice(C.length + 1), s.rootLessonId.slice(C.length + 1)]),
          notes: (await db.notesFor(ids.a1)).map((n) => n.body),
          messages: (await db.messagesFor((await db.threadsFor(ids.a2))[0].id)).map((m) => m.content),
          updated: lessons.map((l) => l.updatedAt),
        };
      }, { C: REAL, ids: before });
      console.log(`T055-M1 v5 state: ${JSON.stringify({ ...after, updated: undefined })}`);
      expect(after.version).toBe(5);
      expect(after.lessons.sort()).toEqual([
        ['lesson:0001', 'lessons/0001-alpha-v2.html', ['lessons/0001-alpha.html'], false, 'done', 111, '2026-11-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z', false],
        ['lesson:0002', 'lessons/0002-beta.html', null, false, 'started', 222, null, '2026-11-18T11:00:00.000Z', false],
        ['lesson:0003', 'lessons/0003-gama.html', null, false, 'new', 0, null, null, false],
        ['reference:R01', 'reference/R01-ref.html', null, false, 'started', 7, null, '2026-11-18T09:00:00.000Z', false],
      ]);
      expect(after.quizzes.sort()).toEqual([
        ['quiz:0001-1', 'quizzes/0001-1-alpha.json', null],
        ['quiz:0002-1', 'quizzes/0002-1-beta-v2.json', ['quizzes/0002-1-beta.json']],
      ]);
      // the answer given to the quiz before its rename is back (0.8.1 had lost it)
      expect(after.answers).toEqual({ 'quiz:0001-1': 2, 'quiz:0002-1': 1 });
      expect(after.ann).toEqual({ [before.a1]: 'lesson:0001', [before.a2]: 'lesson:0002' });
      expect(after.sub).toEqual([[true, 'lesson:0001', 'lesson:0001']]);
      expect(after.notes).toEqual(['Моя бележка']);
      expect(after.messages).toEqual(['Защо?']);

      await page.goto(`${url}#/c/${REAL}`);
      await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
      await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 3 урока');
      await expect(course(page).locator('[data-kind="lesson"] .course-item')).toHaveCount(3);
      await expect(course(page).locator('[data-kind="reference"] .course-item')).toHaveCount(1);
      await expect(course(page).locator('[data-section="retired"]')).toHaveCount(0);
      await expect(course(page).locator('[data-item="LRN-T55/lesson:0001"] [data-field="lesson-meta"]')).toContainText('1 маркировка');
      await expect(course(page).locator('[data-item="LRN-T55/lesson:0001"] [data-field="lesson-meta"]')).toContainText('1 тема');
      await expect(course(page).locator('.quiz-list__item[data-quiz="LRN-T55/quiz:0002-1"] [data-field="quiz-status"]')).toHaveText('1 от 2 отговорени');
      await expect(course(page).locator('.quiz-list__item[data-quiz="LRN-T55/quiz:0001-1"] [data-field="quiz-status"]')).toHaveText(/резултат: \d от 2 верни/);
      // The old quiz address (earlier file name) still opens the quiz.
      await page.goto(`${url}#/c/${REAL}/quiz/0002-1-beta`);
      await expect(page.locator('[data-screen="quiz"]')).toContainText('Тест бета');
      // The same ZIP again: "Без промени".
      const again = await doImport(realV2());
      expect(again).toMatch(/^Без промени/);
      // The lesson still opens; its old link (the path before the rename) from lesson 0002 opens lesson 0001.
      await page.goto(`${url}#/c/${REAL}/read/0002`);
      await waitReady(page);
      await lf(page).locator('#back').click();
      await expect(page).toHaveURL(/read\/0001$/);
      await waitReady(page);
      // A reload does not migrate again.
      await page.reload();
      await expect(page.locator('[data-screen="reader"]')).toBeVisible();
      const updated = await page.evaluate(async () => (await (await import('./src/db.js')).openDb()).getAll('lessons').then((ls) => ls.map((l) => [l.id, l.progress.lastOpenedAt])));
      expect(updated.length).toBe(4);
    } finally { await stop(); }
    rmSync(base, { recursive: true, force: true });
  });

  test('T055-M2 a failed v5 migration: the screen says "Базата не може да се обнови; данните са запазени", the v4 database stays as it was', async ({ page }) => {
    allowed.push(/IndexedDB/, /Failed to load resource/);
    // A v4 database, made on a page of the origin that does not start the app.
    await page.goto('./manifest.webmanifest');
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const v4 = await db.openDb({ name: 'lrn-app', version: 4 });
      await v4.put('courses', { id: 'LRN-F', title: 'F', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deleted: false });
      await v4.put('lessons', { id: 'LRN-F/lessons/0001-a.html', courseId: 'LRN-F', kind: 'lesson', number: '0001', path: 'lessons/0001-a.html', title: 'А', order: 1, deleted: false, progress: { status: 'done', lastOpenedAt: null, scrollY: 5 } });
      await v4.put('quizAnswers', { id: 'LRN-F/quizzes/0001-1-a.json', courseId: 'LRN-F', choices: { k: 'Да' }, cursor: 0 });
      db.closeDb();
    });
    // Every write of the upgrade fails (as a full disk or a browser bug would).
    await page.addInitScript(() => {
      const clear = IDBObjectStore.prototype.clear;
      IDBObjectStore.prototype.clear = function (...args) {
        if (this.transaction.mode === 'versionchange') throw new DOMException('simulated failure', 'UnknownError');
        return clear.apply(this, args);
      };
    });
    await page.goto('./');
    await expect(page.locator('#db-error')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#db-error')).toContainText('Базата не може да се обнови; данните са запазени');
    await expect(page.locator('#db-error')).toHaveAttribute('role', 'alert');
    const state = await page.evaluate(() => new Promise((ok) => {
      const r = indexedDB.open('lrn-app');
      r.onsuccess = () => {
        const idb = r.result;
        const tx = idb.transaction(['lessons', 'quizAnswers']);
        const out = { version: idb.version };
        tx.objectStore('lessons').getAll().onsuccess = (e) => { out.lessons = e.target.result.map((l) => [l.id, l.progress.status]); };
        tx.objectStore('quizAnswers').getAll().onsuccess = (e) => { out.answers = e.target.result.map((a) => a.id); };
        tx.oncomplete = () => { idb.close(); ok(out); };
      };
    }));
    expect(state).toEqual({ version: 4, lessons: [['LRN-F/lessons/0001-a.html', 'done']], answers: ['LRN-F/quizzes/0001-1-a.json'] });
  });
});

// ---------------------------------------------------------------------------
// Re-import by number
// ---------------------------------------------------------------------------
const C = 'LRN-ID';
const base = () => ({
  'INDEX.md': index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']]),
  'lessons/0001-alpha.html': lessonHtml('Алфа', '<p><a id="to3" href="0003-gama.html">към гама</a> <a id="toR" href="../reference/R01-ref.html">справка</a></p>'),
  'lessons/0002-beta.html': lessonHtml('Бета', '<p><a id="old" href="0001-alpha.html">стар път към алфа</a> <a id="num" href="0003-nyakakvo-drugo-ime.html">само номерът</a> <a id="nope" href="0009-nyama.html">няма го</a></p>'),
  'lessons/0003-gama.html': lessonHtml('Гама'),
  'reference/R01-ref.html': lessonHtml('Справка'),
  'quizzes/0001-1-alpha.json': quizJson('0001', 'Тест алфа', 3),
});
const rows = (page) => db(page, async (db, C) => (await db.listLessons(C, { includeDeleted: true }))
  .map((l) => [l.id.slice(C.length + 1), l.path, l.previousPaths ?? null, l.progress.status, l.progress.scrollY, !!l.retired, !!l.deleted]), C);
async function seed(page) {
  const r = await importCourse(page, C, base());
  expect(r.ok).toBe(true);
  await db(page, async (db, C) => {
    await db.setLessonProgress(`${C}/lesson:0001`, { status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T10:00:00.000Z', scrollY: 111 });
    await db.setLessonProgress(`${C}/lesson:0002`, { status: 'started', lastOpenedAt: '2026-11-18T11:00:00.000Z', scrollY: 222 });
    const q = await db.getQuiz(`${C}/quiz:0001-1`);
    const keys = db.questionKeys(q.questions);
    for (let i = 0; i < 3; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: q.questions[i].options[0], cursor: i });
  }, C);
}

test.describe('T055-R re-import by number', () => {
  test.beforeEach(async ({ page }) => { await start(page); });

  test('T055-R1 a renamed lesson and a renamed quiz: one row, progress and answers stay, previousPaths; the same ZIP again is "Без промени"; renamed back', async ({ page }) => {
    await seed(page);
    const renamed = base();
    renamed['lessons/0001-alpha-novo.html'] = renamed['lessons/0001-alpha.html'];
    delete renamed['lessons/0001-alpha.html'];
    renamed['quizzes/0001-1-alpha-novo.json'] = renamed['quizzes/0001-1-alpha.json'];
    delete renamed['quizzes/0001-1-alpha.json'];
    renamed['reference/R1-ref-novo.html'] = renamed['reference/R01-ref.html'];
    delete renamed['reference/R01-ref.html'];
    const r = await importCourse(page, C, renamed);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Курсът LRN-ID е обновен/);
    expect(r.summary.lessons.changed.map((l) => l.split(' ')[0]).sort()).toEqual(['0001', 'R01']);
    expect(r.summary.warnings).toEqual([]);
    expect(await rows(page)).toEqual([
      ['lesson:0001', 'lessons/0001-alpha-novo.html', ['lessons/0001-alpha.html'], 'done', 111, false, false],
      ['lesson:0002', 'lessons/0002-beta.html', null, 'started', 222, false, false],
      ['lesson:0003', 'lessons/0003-gama.html', null, 'new', 0, false, false],
      ['reference:R01', 'reference/R1-ref-novo.html', ['reference/R01-ref.html'], 'new', 0, false, false],
    ]);
    const quiz = await db(page, async (db, C) => {
      const qs = await db.listQuizzes(C, { includeDeleted: true });
      const a = await db.getQuizAnswers(`${C}/quiz:0001-1`);
      return { qs: qs.map((q) => [q.id, q.path, q.previousPaths]), score: db.scoreQuiz(qs[0], a) };
    }, C);
    expect(quiz.qs).toEqual([[`${C}/quiz:0001-1`, 'quizzes/0001-1-alpha-novo.json', ['quizzes/0001-1-alpha.json']]]);
    expect(quiz.score).toMatchObject({ answered: 3, total: 3 });
    expect((await importCourse(page, C, renamed)).text).toMatch(/^Без промени/);
    await openCourse(page, C);
    await expect(course(page).locator('[data-kind="lesson"] .course-item')).toHaveCount(3);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 3 урока');
    await expect(course(page).locator('.quiz-list__item [data-field="quiz-status"]')).toHaveText(/резултат: \d от 3 верни/);
    // Renamed back to the first name: still the same lesson, both paths remembered.
    expect((await importCourse(page, C, base())).ok).toBe(true);
    const back = await rows(page);
    expect(back[0]).toEqual(['lesson:0001', 'lessons/0001-alpha.html', ['lessons/0001-alpha-novo.html'], 'done', 111, false, false]);
  });

  test('T055-R2 retired: missing from a full import → "Вече не са в курса" (collapsed, opens with a note, not counted, not "Продължи"); back when the number returns; a partial import retires nothing', async ({ page }) => {
    await seed(page);
    const without = base();
    delete without['lessons/0002-beta.html'];
    without['INDEX.md'] = index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']]);
    const r = await importCourse(page, C, without);
    expect(r.ok).toBe(true);
    expect(r.summary.lessons.retired).toEqual(['0002 Бета']);
    expect(r.text).toContain('Вече не са в курса: 0002 Бета — данните ти за тях са запазени.');
    expect(r.summary.counts).toMatchObject({ lessons: 2, references: 1, retired: 1 });
    expect((await rows(page)).find(([id]) => id === 'lesson:0002')).toEqual(['lesson:0002', 'lessons/0002-beta.html', null, 'started', 222, true, false]);
    await openCourse(page, C);
    await expect(course(page).locator('[data-kind="lesson"] .course-item')).toHaveCount(2);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 2 урока');
    // "Продължи" goes to the last opened lesson that is still in the course (0001), not to 0002.
    await expect(course(page).locator('[data-action="continue"]')).toContainText('урок 0001');
    const box = course(page).locator('details[data-section="retired"]');
    await expect(box).toHaveCount(1);
    await expect(box).not.toHaveAttribute('open', '');
    await expect(box.locator('summary')).toHaveText('Вече не са в курса');
    await box.locator('summary').click();
    await expect(box.locator('.course-item')).toHaveCount(1);
    await expect(box.locator('.course-item')).toContainText('Бета');
    await box.locator('.lesson-link').click();
    await expect(page).toHaveURL(/read\/0002$/);
    await waitReady(page);
    await expect(page.locator('[data-field="retired-note"]')).toBeVisible();
    await expect(page.locator('[data-field="retired-note"]')).toContainText('Този урок вече не е в курса');
    // The same ZIP again: no change.
    expect((await importCourse(page, C, without)).text).toMatch(/^Без промени/);
    // A partial import (no INDEX.md) without 0001 retires nothing more.
    const partial = { 'lessons/0003-gama.html': base()['lessons/0003-gama.html'] };
    const p = await importCourse(page, C, partial);
    expect(p.ok).toBe(true);
    expect(p.summary.lessons.retired).toEqual([]);
    expect((await rows(page)).filter((x) => x[5]).map((x) => x[0])).toEqual(['lesson:0002']);
    // The number comes back: retired → false, the progress is still there.
    const r2 = await importCourse(page, C, base());
    expect(r2.summary.lessons.restored).toEqual(['0002 Бета']);
    expect(r2.text).toContain('Отново в курса: 0002 Бета.');
    // (the reader was opened in between: the position may have been saved again)
    expect((await rows(page)).find(([id]) => id === 'lesson:0002').filter((_, i) => i !== 4)).toEqual(['lesson:0002', 'lessons/0002-beta.html', null, 'started', false, false]);
    await openCourse(page, C);
    await expect(course(page).locator('[data-section="retired"]')).toHaveCount(0);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 3 урока');
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await expect(page.locator('[data-field="retired-note"]')).toBeHidden();
  });

  test('T055-R3 "## Оттеглени номера" in INDEX.md retires a number even if it is still in the INDEX table or the ZIP; a number still planned is not retired', async ({ page }) => {
    await seed(page);
    const files = base();
    delete files['lessons/0003-gama.html'];
    delete files['reference/R01-ref.html'];
    // 0001 is listed as retired AND still in the ZIP; 0003 and R1 are gone and listed; 0002 is in the plan only.
    files['INDEX.md'] = index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html']],
      '\n## План\n- 0002: бета, още се пише\n\n## Оттеглени номера\n- 0001 — слят с 0004 (2026-11-20)\n- 3 — пренаписан\n- R1 — вече не трябва\n');
    delete files['lessons/0002-beta.html'];
    const r = await importCourse(page, C, files);
    expect(r.ok).toBe(true);
    expect(r.summary.lessons.retired.map((l) => l.split(' ')[0]).sort()).toEqual(['0001', '0003', 'R01']);
    expect((await rows(page)).map((x) => [x[0], x[5]])).toEqual([['lesson:0002', false], ['lesson:0001', true], ['lesson:0003', true], ['reference:R01', true]]);
    await openCourse(page, C);
    await expect(course(page).locator('[data-kind="retired"] .course-item')).toHaveCount(3);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 1 урок');
    // Nothing was deleted: progress and answers are all there.
    const kept = await db(page, async (db, C) => [(await db.getLesson(`${C}/lesson:0001`)).progress.status, Object.keys((await db.getQuizAnswers(`${C}/quiz:0001-1`)).choices).length], C);
    expect(kept).toEqual(['done', 3]);
  });

  for (const [name, mutate, want] of [
    ['two lessons with one number', (f) => { f['lessons/0003-drug.html'] = lessonHtml('Друг'); },
      'В курса има два урока с номер 0003: lessons/0003-drug.html, lessons/0003-gama.html. Поправи курса и импортирай отново.'],
    ['R1 and R01', (f) => { f['reference/R1-drug.html'] = lessonHtml('Друг'); },
      'В курса има два справочника с номер R01: reference/R01-ref.html, reference/R1-drug.html. Поправи курса и импортирай отново.'],
    ['two quizzes 0001-1', (f) => { f['quizzes/0001-01-drug.json'] = quizJson('0001', 'Друг'); },
      'В курса има два теста с номер 0001-1: quizzes/0001-01-drug.json, quizzes/0001-1-alpha.json. Поправи курса и импортирай отново.'],
  ]) {
    test(`T055-R4 ${name} in a ZIP → the whole import is refused, nothing is written`, async ({ page }) => {
      await seed(page);
      const snap = await snapshot(page);
      const files = base();
      files['lessons/0004-nov.html'] = lessonHtml('Нов урок');
      files['RESOURCES.md'] = '# Ресурси\n\nНови.';
      mutate(files);
      const r = await importCourse(page, C, files);
      expect(r).toEqual({ ok: false, text: want, name: 'ImportError' });
      expect(await snapshot(page)).toEqual(snap);
    });
  }

  test('T055-R4b a duplicate in a NEW course: nothing is written either (no course record)', async ({ page }) => {
    const r = await importCourse(page, 'LRN-DUP', { 'lessons/0001-a.html': lessonHtml('А'), 'lessons/0001-b.html': lessonHtml('Б') });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('В курса има два урока с номер 0001');
    const s = await snapshot(page);
    expect(s.courses).toEqual([]);
    expect(s.files).toEqual([]);
  });

  test('T055-R5 links: an old path (previousPaths), only the number in a file name, a reference by an old path; a link to a missing number does nothing', async ({ page }) => {
    await seed(page);
    const renamed = base();
    renamed['lessons/0001-alpha-novo.html'] = renamed['lessons/0001-alpha.html'];
    delete renamed['lessons/0001-alpha.html'];
    renamed['reference/R01-ref-novo.html'] = renamed['reference/R01-ref.html'];
    delete renamed['reference/R01-ref.html'];
    expect((await importCourse(page, C, renamed)).ok).toBe(true);
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await lf(page).locator('#old').click();
    await expect(page).toHaveURL(/read\/0001$/);
    await waitReady(page);
    await expect(lf(page).locator('h1')).toHaveText('Алфа');
    await lf(page).locator('#toR').click();
    await expect(page).toHaveURL(/read\/R01$/);
    await waitReady(page);
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await lf(page).locator('#num').click();
    await expect(page).toHaveURL(/read\/0003$/);
    await waitReady(page);
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    allowed.push(/not a lesson of the course/);
    await lf(page).locator('#nope').click();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/read\/0002$/);
    // The reader finds a lesson by a short number and by an old path too.
    await page.goto(`./#/c/${C}/read/1`);
    await waitReady(page);
    await expect(lf(page).locator('h1')).toHaveText('Алфа');
    await page.goto(`./#/c/${C}/read/r1`);
    await waitReady(page);
    await expect(lf(page).locator('h1')).toHaveText('Справка');
  });

  test('T055-R6 T011F-D1: the same number with a quite different title on a lesson with progress → a warning in the summary (not blocking); a small title fix → no warning', async ({ page }) => {
    await seed(page);
    const files = base();
    files['lessons/0001-alpha.html'] = lessonHtml('Нов увод в курса');
    files['lessons/0002-beta.html'] = lessonHtml('Бетa', '<p><a href="0001-alpha.html">алфа</a></p>'); // a typo fixed: not "different"
    files['lessons/0003-gama.html'] = lessonHtml('Съвсем друго'); // no progress: no warning
    const r = await importCourse(page, C, files);
    expect(r.ok).toBe(true);
    expect(r.summary.warnings).toEqual(['Урок 0001 е с ново заглавие „Нов увод в курса“ (беше „Алфа“). Прогресът и маркировките остават към номер 0001 — ако уроците са преномерирани, провери ги.']);
    expect(r.text).toContain('Внимание: Урок 0001 е с ново заглавие „Нов увод в курса“');
    expect((await rows(page))[0]).toEqual(['lesson:0001', 'lessons/0001-alpha.html', null, 'done', 111, false, false]);
    const t = await page.evaluate(async () => {
      const m = await import('./src/course-import.js');
      return [m.titlesDiffer('Алфа', 'алфа'), m.titlesDiffer('Класификация на продуктите', 'Класификация на продукти'), m.titlesDiffer('Алфа', 'Нов увод'), m.titlesDiffer('Оценка на риска', 'Срокове и задължения')];
    });
    expect(t).toEqual([false, false, true, true]);
  });

  test('T055-R6b a warning also for a lesson with only an annotation (no progress)', async ({ page }) => {
    await importCourse(page, C, base());
    await db(page, (db, C) => db.createAnnotation({ courseId: C, target: { type: 'lesson', id: `${C}/lesson:0003` }, selector: { quote: { exact: 'Гама', prefix: '', suffix: '' }, position: { start: 0, end: 4 } }, color: 'blue' }), C);
    const files = base();
    files['lessons/0003-gama.html'] = lessonHtml('Делта и епсилон');
    const r = await importCourse(page, C, files);
    expect(r.summary.warnings).toHaveLength(1);
    expect(r.summary.warnings[0]).toContain('Урок 0003 е с ново заглавие „Делта и епсилон“ (беше „Гама“)');
  });

  test('T055-R7 a quiz named outside NNNN-K: id by path with a note; its answers stay on a re-import', async ({ page }) => {
    const files = base();
    files['quizzes/stari-vaprosi.json'] = quizJson('0002', 'Стар тест', 2);
    const r = await importCourse(page, C, files);
    expect(r.ok).toBe(true);
    expect(r.summary.notes).toEqual(['тест quizzes/stari-vaprosi.json: името не е във вида NNNN-K-….json — отговорите му са вързани към името на файла']);
    expect(r.summary.quizNotes).toEqual([]);
    expect(r.text).toContain('Бележка: тест quizzes/stari-vaprosi.json: името не е във вида NNNN-K-….json');
    expect(r.text).not.toContain('Внимание — тестовете');
    const id = `${C}/quiz:path:quizzes/stari-vaprosi.json`;
    await db(page, async (db, id) => {
      const q = await db.getQuiz(id);
      await db.saveQuizChoice(id, { courseId: q.courseId, qKey: db.questionKeys(q.questions)[0], choice: 'Да', cursor: 0 });
    }, id);
    expect((await importCourse(page, C, files)).text).toMatch(/^Без промени/);
    await openCourse(page, C);
    await expect(course(page).locator(`.quiz-list__item[data-quiz="${id}"] [data-field="quiz-status"]`)).toHaveText('1 от 2 отговорени');
  });

  test('T055-R8 T011F-D3: a lesson open in another tab while its file is renamed by an import: "Маркирай като завършен" there is kept', async ({ page, context }) => {
    await seed(page);
    const reader = await context.newPage();
    reader.on('pageerror', (e) => problems.push(`reader pageerror: ${e}`));
    await reader.goto(`./#/c/${C}/read/0002`);
    await waitReady(reader);
    const renamed = base();
    renamed['lessons/0002-beta-v2.html'] = renamed['lessons/0002-beta.html'];
    delete renamed['lessons/0002-beta.html'];
    expect((await importCourse(page, C, renamed)).ok).toBe(true);
    await reader.locator('[data-action="complete"]').click();
    await expect(reader.locator('[data-action="complete"]')).toHaveAttribute('aria-pressed', 'true');
    await reader.close();
    expect((await rows(page)).find(([id]) => id === 'lesson:0002').filter((_, i) => i !== 4)).toEqual(['lesson:0002', 'lessons/0002-beta-v2.html', ['lessons/0002-beta.html'], 'done', false, false]);
  });

  test('T055-R9 the user stores: BACKUP_STORES never has secrets; the import never touches annotations, notes or subtopics', async ({ page }) => {
    await seed(page);
    const ids = await db(page, async (db, C) => {
      const a = await db.createAnnotation({ courseId: C, target: { type: 'lesson', id: `${C}/lesson:0001` }, selector: { quote: { exact: 'Алфа', prefix: '', suffix: '' }, position: { start: 0, end: 4 } }, color: 'pink' });
      const n = await db.createNote({ annotationId: a.id, body: 'x' });
      const s = await db.createSubTopic({ annotationId: a.id, kind: 'контекст', title: 'Т', courseId: C });
      return { a: a.id, n: n.id, s: s.id, backup: db.BACKUP_STORES, priv: db.PRIVATE_STORES };
    }, C);
    expect(ids.backup).not.toContain('secrets');
    expect(ids.priv).toEqual(['secrets']);
    const before = await snapshot(page);
    const renamed = base();
    renamed['lessons/0001-alpha-x.html'] = renamed['lessons/0001-alpha.html'];
    delete renamed['lessons/0001-alpha.html'];
    await importCourse(page, C, renamed);
    const after = await snapshot(page);
    expect(after.annotations).toEqual(before.annotations);
    expect(after.subtopics).toEqual(before.subtopics);
  });
});
