// T-056 (tester, 0.9.0): attack on T-055 (D-039, permanent lesson/quiz ids by
// course + number).
// - S: the IndexedDB v4 → v5 migration: a REAL 0.8.1 profile (git archive
//   2bd1aa5) with LRN-DEMO + a course with every kind of v4 duplicate
//   (renamedTo shadow, two live records for one number, R1 + R01, two quizzes
//   0001-1 / 0001-01 with answers in both), an open 0.8.1 tab during the
//   upgrade; v1/v3 → v5; a big database under CPU ×4; an upgrade interrupted by
//   closing / reloading the page; a database from a newer version; a blocking
//   old connection; going back to 0.8.1 after 0.9.0.
// - I: re-import by number: odd file names, duplicates (refused, nothing
//   written, also through the screen), "## Оттеглени номера" with a file still
//   in the ZIP, odd retired-list layouts, quizzes pointing at missing/retired
//   lessons, rename + change of a quiz back and forth.
// - L: links: retired lesson, another course with the same number (../,
//   %2e%2e, %2F, absolute), old path + fragment, reference by number.
// - X: security: hash routes with paths/ids of another course; XSS in titles
//   (warning, "Вече не са в курса", import result).
// Synthetic data only (D-026).
import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, readFixture, DRIVE_ZIP_NAME } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OLD_COMMIT = '2bd1aa5'; // 0.8.1, schema v4
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

const onlyLandscape = (info, why) => test.skip(info.project.name !== 'tablet-landscape', `${why}: once is enough (landscape)`);

async function start(page) {
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
}

const lessonHtml = (title, body = '<p>Измислен текст.</p>') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`);
const quizJson = (lesson, title, n = 2, prefix = title) => strToU8(JSON.stringify({
  lesson, title, questions: Array.from({ length: n }, (_, i) => ({ q: `${prefix}: въпрос ${i + 1}?`, options: ['Да', 'Не'], answer: i % 2 })),
}));
const index = (id, rows, extra = '') => strToU8(`# ${id}: индекс\n\n## Уроци\n| # | Заглавие | Файл |\n|---|---|---|\n${rows.filter((r) => !/^R/i.test(r[0])).map(([n, t, p]) => `| ${n} | ${t} | ${p ? `[${p}](https://example.org/x)` : ''} |`).join('\n')}\n\n## Справочници\n| # | Заглавие | Файл |\n|---|---|---|\n${rows.filter((r) => /^R/i.test(r[0])).map(([n, t, p]) => `| ${n} | ${t} | ${p ? `[${p}](https://example.org/x)` : ''} |`).join('\n')}\n${extra}`);
const toBytes = (files) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? strToU8(v) : v]));

async function importParts(page, parts) {
  return page.evaluate(async (parts) => {
    const m = await import('./src/course-import.js');
    try {
      const s = await m.importCourse(parts.map((p) => new File([new Uint8Array(p.bytes)], p.name)));
      return { ok: true, text: m.describeSummary(s), summary: s };
    } catch (err) {
      return { ok: false, text: m.errorMessage(err), name: err.name };
    }
  }, parts);
}
const importCourse = (page, id, files) => importParts(page, [{ name: `${id}.zip`, bytes: [...makeZip(toBytes(files), { root: id })] }]);

async function db(page, fn, arg) {
  await page.evaluate(async () => { window.__db = await import('./src/db.js'); });
  return page.evaluate(`(${fn.toString()})(window.__db, ${JSON.stringify(arg ?? null)})`);
}

/** Every record of every store of lrn-app (raw IndexedDB, no version: never upgrades). */
const dump = (page, name = 'lrn-app') => page.evaluate((name) => new Promise((ok, fail) => {
  const r = indexedDB.open(name);
  r.onerror = () => fail(r.error);
  r.onsuccess = () => {
    const idb = r.result;
    const out = { version: idb.version, stores: {} };
    const names = [...idb.objectStoreNames];
    if (!names.length) { idb.close(); ok(out); return; }
    const tx = idb.transaction(names);
    for (const s of names) {
      tx.objectStore(s).getAll().onsuccess = (e) => {
        out.stores[s] = e.target.result.map((x) => ({ ...x, blob: x.blob ? `blob:${x.blob.size}` : undefined, rendered: x.rendered ? 'rendered' : undefined }));
      };
    }
    tx.oncomplete = () => { idb.close(); ok(out); };
  };
}), name);

/** Only the user's lesson records etc. that a snapshot compares ("nothing written"). */
const snapshot = async (page) => {
  const d = await dump(page);
  return JSON.stringify(['courses', 'files', 'lessons', 'quizzes', 'quizAnswers', 'annotations', 'subtopics', 'notes'].map((s) => d.stores[s]));
};

// --- An independent re-implementation of the D-039 ids (not the app's code) --------
const pad2 = (n) => String(n).padStart(2, '0');
function expectedLessonId(r) {
  const course = r.courseId;
  if (r.kind === 'reference') {
    const m = /^R(\d+)$/i.exec(String(r.number)) || /^reference\/R(\d+)/i.exec(r.path || '');
    return `${course}/reference:R${pad2(Number(m[1]))}`;
  }
  const m = /^\d{4}$/.test(String(r.number)) ? [0, r.number] : /^lessons\/(\d{4})-/i.exec(r.path || '');
  return `${course}/lesson:${m[1]}`;
}
function expectedQuizId(courseId, path) {
  const m = /^quizzes\/(\d{4})-(\d+)(?:-[^/]*)?\.json$/i.exec(path);
  return m && Number(m[2]) >= 1 ? `${courseId}/quiz:${m[1]}-${Number(m[2])}` : `${courseId}/quiz:path:${path}`;
}
const RANK = { new: 0, started: 1, done: 2 };

/**
 * Nothing of the user's v4 data is lost in v5: one lesson record per
 * (course, kind, number) with at least the best status and the newest
 * lastOpenedAt of the old records; every old answer is in the answers of the
 * new quiz id (choices or choicesMerged); annotations, subtopics, notes,
 * threads, messages, files, courses, settings, secrets, usage: all there,
 * pointing at existing lessons.
 */
function checkNoLoss(v4, v5) {
  const S4 = v4.stores;
  const S5 = v5.stores;
  const issues = [];
  const lessons5 = new Map(S5.lessons.map((l) => [l.id, l]));
  const map = new Map();
  for (const l of S4.lessons) {
    const id = expectedLessonId(l);
    map.set(l.id, id);
    const n = lessons5.get(id);
    if (!n) { issues.push(`lesson ${l.id} → ${id} missing`); continue; }
    if ((RANK[n.progress?.status] ?? 0) < (RANK[l.progress?.status] ?? 0)) issues.push(`lesson ${id}: status ${n.progress?.status} < ${l.progress?.status} of ${l.id}`);
    if (l.progress?.lastOpenedAt && String(n.progress?.lastOpenedAt ?? '') < l.progress.lastOpenedAt) issues.push(`lesson ${id}: lastOpenedAt lost (${l.id})`);
    if (l.progress?.status === 'done' && !n.progress?.completedAt && l.progress?.completedAt) issues.push(`lesson ${id}: completedAt lost`);
    if (!l.deleted && n.deleted) issues.push(`lesson ${id} became deleted`);
    if (l.path !== n.path && !(n.previousPaths || []).includes(l.path)) issues.push(`lesson ${id}: old path ${l.path} not in previousPaths`);
  }
  const uniq = new Set(map.values());
  if (S5.lessons.length !== uniq.size) issues.push(`lessons: ${S5.lessons.length} records for ${uniq.size} numbers`);
  if (S5.lessons.some((l) => 'renamedTo' in l)) issues.push('a renamedTo record is left');
  // annotations / subtopics: same records, targets mapped and existing
  const target = (id) => map.get(id) ?? id;
  const ann5 = new Map(S5.annotations.map((a) => [a.id, a]));
  for (const a of S4.annotations) {
    const n = ann5.get(a.id);
    if (!n) { issues.push(`annotation ${a.id} missing`); continue; }
    if (a.target?.type === 'lesson') {
      if (n.target.id !== target(a.target.id)) issues.push(`annotation ${a.id}: target ${n.target.id} ≠ ${target(a.target.id)}`);
      if (!lessons5.has(n.target.id)) issues.push(`annotation ${a.id}: target ${n.target.id} is no lesson`);
    }
    if (JSON.stringify({ ...a, target: undefined, updatedAt: undefined }) !== JSON.stringify({ ...n, target: undefined, updatedAt: undefined })) issues.push(`annotation ${a.id} changed`);
  }
  if (S5.annotations.length !== S4.annotations.length) issues.push('annotation count changed');
  const sub5 = new Map(S5.subtopics.map((s) => [s.id, s]));
  for (const s of S4.subtopics) {
    const n = sub5.get(s.id);
    if (!n) { issues.push(`subtopic ${s.id} missing`); continue; }
    if (n.rootLessonId !== target(s.rootLessonId)) issues.push(`subtopic ${s.id}: root ${n.rootLessonId}`);
    if (!lessons5.has(n.rootLessonId)) issues.push(`subtopic ${s.id}: root is no lesson`);
    if (s.parent?.type === 'lesson' && n.parent.id !== target(s.parent.id)) issues.push(`subtopic ${s.id}: parent`);
  }
  if (S5.subtopics.length !== S4.subtopics.length) issues.push('subtopic count changed');
  // stores that must not change at all
  for (const s of ['notes', 'threads', 'messages', 'files', 'courses', 'settings', 'secrets', 'usage']) {
    const a = JSON.stringify((S4[s] || []).map((x) => JSON.stringify(x)).sort());
    const b = JSON.stringify((S5[s] || []).map((x) => JSON.stringify(x)).sort());
    if (a !== b) issues.push(`store ${s} changed`);
  }
  // quizzes and answers
  const quizMap = new Map(S4.quizzes.map((q) => [q.id, expectedQuizId(q.courseId, q.path)]));
  const quizzes5 = new Set(S5.quizzes.map((q) => q.id));
  for (const id of quizMap.values()) if (!quizzes5.has(id)) issues.push(`quiz ${id} missing`);
  if (S5.quizzes.length !== new Set(quizMap.values()).size) issues.push(`quizzes: ${S5.quizzes.length} for ${new Set(quizMap.values()).size} ids`);
  const ans5 = new Map(S5.quizAnswers.map((a) => [a.id, a]));
  for (const a of S4.quizAnswers) {
    const id = quizMap.get(a.id) ?? (/^(.+?)\/(quizzes\/.+)$/.exec(a.id) ? expectedQuizId(/^(.+?)\//.exec(a.id)[1], /^.+?\/(quizzes\/.+)$/.exec(a.id)[1]) : a.id);
    const n = ans5.get(id);
    if (!n) { issues.push(`answers of ${a.id} → ${id} missing`); continue; }
    for (const [k, v] of Object.entries(a.choices || {})) {
      if (n.choices?.[k] !== v && n.choicesMerged?.[k] !== v) issues.push(`answer ${a.id}[${k.slice(0, 8)}] = ${v} lost`);
    }
  }
  return issues;
}

async function serve(root, port) {
  const child = spawn(process.execPath, [join(root, 'tests/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (b) => { if (/test server/.test(String(b))) ok(); });
    child.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  return () => new Promise((ok) => { child.removeAllListeners('exit'); child.on('exit', ok); child.kill(); });
}
function oldBuild(info, tag) {
  test.skip(!existsSync(join(REPO, '.git')), 'needs the git history');
  try { execSync(`git -C "${REPO}" cat-file -e ${OLD_COMMIT}^{commit}`, { stdio: 'ignore' }); } catch { test.skip(true, `needs commit ${OLD_COMMIT} (git fetch --deepen=50)`); }
  const port = 4800 + info.workerIndex * 4 + tag;
  const dir = `/tmp/t056-old-${port}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSync(`git -C "${REPO}" archive ${OLD_COMMIT} | tar -x -C "${dir}"`);
  return { port, dir, url: `http://localhost:${port}/EasyLRN/` };
}
async function updateTo(page, url, version) {
  await page.goto(url);
  await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20000 });
  await page.locator('#update-button').click();
  await expect.poll(() => page.evaluate(async () => (await import('./src/config.js')).APP_VERSION).catch(() => null), { timeout: 20000 }).toBe(version);
}

// ---------------------------------------------------------------------------
// S: migration
// ---------------------------------------------------------------------------
const T = 'LRN-T56';
// In 0.8.1 all of these are DIFFERENT records: 0003-a and 0003-b (two lessons),
// R1 and R01 (two references), 0001-1-a and 0001-01-b (two quizzes).
const t56v1 = () => ({
  'INDEX.md': index(T, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-a.html'], ['R01', 'Справка', 'reference/R01-new.html']]),
  'lessons/0001-alpha.html': lessonHtml('Алфа', '<p>Алфа е първата буква.</p><p><a id="toR" href="../reference/R1-old.html">стара справка</a> <a id="toB" href="0002-beta.html">бета</a></p>'),
  'lessons/0002-beta.html': lessonHtml('Бета', '<p>Бета е втората буква.</p>'),
  'lessons/0003-a.html': lessonHtml('Гама А'),
  'lessons/0003-b.html': lessonHtml('Гама Б'),
  'reference/R1-old.html': lessonHtml('Стара справка'),
  'reference/R01-new.html': lessonHtml('Нова справка'),
  'quizzes/0001-1-a.json': quizJson('0001', 'Тест А', 3),
  'quizzes/0001-01-b.json': quizJson('0001', 'Тест Б', 2),
  'quizzes/0002-1-beta.json': quizJson('0002', 'Тест бета', 2),
});
const t56v2 = () => {
  const f = t56v1();
  f['lessons/0002-beta-v2.html'] = f['lessons/0002-beta.html'];
  delete f['lessons/0002-beta.html'];
  f['INDEX.md'] = index(T, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta-v2.html'], ['0003', 'Гама', 'lessons/0003-a.html'], ['R01', 'Справка', 'reference/R01-new.html']]);
  return f;
};

test.describe('T056-S migration v4 → v5', () => {
  test('T056-S1 a real 0.8.1 profile (LRN-DEMO + every v4 duplicate) with a 0.8.1 tab left open → 0.9.0: no record of the user is lost; the old tab cannot write into v5', async ({ page, context }, info) => {
    onlyLandscape(info, 'two servers, two builds');
    test.setTimeout(300_000);
    const old = oldBuild(info, 0);
    const fixtureZip = [...makeZip(readFixture(), { root: 'LRN-DEMO' })];
    const zipOf = (files) => [...makeZip(toBytes(files), { root: T })];

    // --- 0.8.1 ------------------------------------------------------------------
    let stop = await serve(old.dir, old.port);
    let v4;
    let oldTab;
    try {
      await page.goto(old.url);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      expect(await page.evaluate(async () => (await import('./src/config.js')).APP_VERSION)).toBe('0.8.1');
      const imp = (name, bytes) => page.evaluate(async ({ name, bytes }) => {
        const m = await import('./src/course-import.js');
        return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
      }, { name, bytes });
      console.log(`T056-S1 0.8.1 LRN-DEMO: ${await imp(DRIVE_ZIP_NAME, fixtureZip)}`);
      console.log(`T056-S1 0.8.1 ${T} v1: ${await imp(`${T}.zip`, zipOf(t56v1()))}`);
      await page.evaluate(async (T) => {
        const db = await import('./src/db.js');
        const at = (h) => `2026-11-1${h}T10:00:00.000Z`;
        await db.setLessonProgress('LRN-DEMO/lessons/0001-vidove-chay.html', { status: 'done', completedAt: at(5), lastOpenedAt: at(5), scrollY: 400 });
        await db.setLessonProgress('LRN-DEMO/reference/R01-temperatura-i-vreme.html', { status: 'started', lastOpenedAt: at(6), scrollY: 40 });
        await db.setLessonProgress(`${T}/lessons/0001-alpha.html`, { status: 'done', completedAt: at(1), lastOpenedAt: at(1), scrollY: 11 });
        await db.setLessonProgress(`${T}/lessons/0002-beta.html`, { status: 'started', lastOpenedAt: at(2), scrollY: 22 });
        await db.setLessonProgress(`${T}/lessons/0003-a.html`, { status: 'done', completedAt: at(3), lastOpenedAt: at(3), scrollY: 33 });
        await db.setLessonProgress(`${T}/lessons/0003-b.html`, { status: 'started', lastOpenedAt: at(7), scrollY: 77 });
        await db.setLessonProgress(`${T}/reference/R1-old.html`, { status: 'done', completedAt: at(4), lastOpenedAt: at(4), scrollY: 44 });
        await db.setLessonProgress(`${T}/reference/R01-new.html`, { status: 'started', lastOpenedAt: at(8), scrollY: 88 });
        for (const C of ['LRN-DEMO', T]) {
          for (const q of await db.listQuizzes(C)) {
            const keys = db.questionKeys(q.questions);
            const n = q.path.includes('0001-1-a') ? 3 : q.path.includes('0001-01-b') ? 2 : 1;
            for (let i = 0; i < n; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: q.questions[i].options[1], cursor: i });
          }
        }
        const sel = { quote: { exact: 'Гама', prefix: '', suffix: '' }, position: { start: 0, end: 4 } };
        const a1 = await db.createAnnotation({ courseId: T, target: { type: 'lesson', id: `${T}/lessons/0003-a.html` }, selector: sel, color: 'yellow' });
        const a2 = await db.createAnnotation({ courseId: T, target: { type: 'lesson', id: `${T}/lessons/0003-b.html` }, selector: sel, color: 'green' });
        const a3 = await db.createAnnotation({ courseId: T, target: { type: 'lesson', id: `${T}/reference/R1-old.html` }, selector: sel, color: 'blue' });
        const a4 = await db.createAnnotation({ courseId: 'LRN-DEMO', target: { type: 'lesson', id: 'LRN-DEMO/lessons/0001-vidove-chay.html' }, selector: sel, color: 'pink' });
        await db.createNote({ annotationId: a1.id, body: 'бележка към Гама А' });
        const t = await db.createThread({ annotationId: a3.id, title: 'Въпрос' });
        await db.createMessage({ threadId: t.id, role: 'user', content: 'Защо?' });
        await db.createSubTopic({ annotationId: a2.id, kind: 'термин', title: 'Подтема', courseId: T });
        await db.createSubTopic({ annotationId: a4.id, kind: 'контекст', title: 'Чай', courseId: 'LRN-DEMO' });
      }, T);
      // The lesson file 0002 is renamed: 0.8.1 leaves a soft-deleted renamedTo shadow.
      console.log(`T056-S1 0.8.1 ${T} v2: ${await imp(`${T}.zip`, zipOf(t56v2()))}`);
      v4 = await dump(page);
      expect(v4.version).toBe(4);
      const shadows = v4.stores.lessons.filter((l) => l.renamedTo);
      expect(shadows.map((l) => l.path)).toEqual(['lessons/0002-beta.html']);
      expect(v4.stores.lessons.filter((l) => l.courseId === T && !l.deleted).map((l) => l.path).sort())
        .toEqual(['lessons/0001-alpha.html', 'lessons/0002-beta-v2.html', 'lessons/0003-a.html', 'lessons/0003-b.html', 'reference/R01-new.html', 'reference/R1-old.html']);
      expect(v4.stores.quizzes.filter((q) => q.courseId === T).map((q) => q.path).sort()).toEqual(['quizzes/0001-01-b.json', 'quizzes/0001-1-a.json', 'quizzes/0002-1-beta.json']);
      // A second tab of 0.8.1 on the course screen stays open during the update.
      oldTab = await context.newPage();
      await oldTab.goto(`${old.url}#/c/${T}`);
      await expect(oldTab.locator('[data-screen="course"] [data-section="activity"]')).toBeVisible({ timeout: 15000 });
    } finally { await stop(); }

    // --- 0.9.0 ------------------------------------------------------------------
    stop = await serve(REPO, old.port);
    try {
      await updateTo(page, old.url, NOW_VERSION);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await expect(page.locator('#db-error')).toBeHidden();
      await expect.poll(async () => (await dump(page)).version, { timeout: 15000 }).toBe(5);
      const v5 = await dump(page);
      const issues = checkNoLoss(v4, v5);
      console.log(`T056-S1 issues: ${JSON.stringify(issues)}`);
      expect(issues).toEqual([]);
      const L = Object.fromEntries(v5.stores.lessons.map((l) => [l.id, l]));
      expect(Object.keys(L).sort()).toEqual(['LRN-DEMO/lesson:0001', 'LRN-DEMO/reference:R01', `${T}/lesson:0001`, `${T}/lesson:0002`, `${T}/lesson:0003`, `${T}/reference:R01`]);
      expect(L[`${T}/lesson:0003`].progress).toMatchObject({ status: 'done', lastOpenedAt: '2026-11-17T10:00:00.000Z', scrollY: 77, completedAt: '2026-11-13T10:00:00.000Z' });
      expect(L[`${T}/reference:R01`].progress).toMatchObject({ status: 'done', lastOpenedAt: '2026-11-18T10:00:00.000Z', scrollY: 88, completedAt: '2026-11-14T10:00:00.000Z' });
      expect(L[`${T}/lesson:0002`]).toMatchObject({ path: 'lessons/0002-beta-v2.html', previousPaths: ['lessons/0002-beta.html'], deleted: false });
      expect(L['LRN-DEMO/lesson:0001'].progress).toMatchObject({ status: 'done', scrollY: 400 });
      // The answers of BOTH old quizzes 0001-1-a and 0001-01-b are under quiz:0001-1 (3 + 2 keys).
      const A = Object.fromEntries(v5.stores.quizAnswers.map((a) => [a.id, a]));
      expect(Object.keys(A).sort()).toEqual(['LRN-DEMO/quiz:0001-1', 'LRN-DEMO/quiz:0001-2', `${T}/quiz:0001-1`, `${T}/quiz:0002-1`]);
      expect(Object.keys(A[`${T}/quiz:0001-1`].choices)).toHaveLength(5);
      // Annotations of the two old 0003 records and of R1 are on the merged records.
      const targets = v5.stores.annotations.map((a) => a.target.id).sort();
      expect(targets).toEqual(['LRN-DEMO/lesson:0001', `${T}/lesson:0003`, `${T}/lesson:0003`, `${T}/reference:R01`]);

      // The course screen of the migrated course.
      await page.goto(`${old.url}#/c/${T}`);
      const course = page.locator('[data-screen="course"]');
      await expect(course.locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
      await expect(course.locator('[data-field="course-progress"]')).toHaveText('Завършени: 2 от 3 урока');
      await expect(course.locator('[data-kind="lesson"] .course-item')).toHaveCount(3);
      await expect(course.locator('[data-kind="reference"] .course-item')).toHaveCount(1);
      await expect(course.locator(`[data-item="${T}/lesson:0003"] [data-field="lesson-meta"]`)).toContainText('2 маркировки');
      await expect(course.locator('[data-action="continue"]')).toContainText('справочник R01');

      // The old 0.8.1 tab: it let the upgrade through (blocking → close) and now cannot open v5.
      const oldErrors = [];
      oldTab.on('console', (m) => { if (m.type() === 'error') oldErrors.push(m.text()); });
      await oldTab.evaluate((T) => { location.hash = `#/c/${T}/read/0001`; }, T);
      await oldTab.waitForTimeout(1500);
      const oldScreen = await oldTab.locator('#main').innerText();
      const oldVersion = await oldTab.evaluate(async () => (await import('./src/config.js')).APP_VERSION);
      console.log(`T056-S1 old tab (${oldVersion}) after the upgrade: ${JSON.stringify(oldScreen.slice(0, 200))}; console errors: ${JSON.stringify(oldErrors.slice(0, 3))}`);
      // Whatever the old tab did, the v5 data is unchanged.
      const v5b = await dump(page);
      expect(JSON.stringify(v5b.stores.lessons.map((l) => [l.id, l.progress]))).toBe(JSON.stringify(v5.stores.lessons.map((l) => [l.id, l.progress])));
      expect(v5b.version).toBe(5);
      await oldTab.close();

      // The same v2 ZIP again in 0.9.0: it has duplicates (0003, R01, quiz 0001-1) → refused, nothing written.
      const before = await snapshot(page);
      const again = await importParts(page, [{ name: `${T}.zip`, bytes: zipOf(t56v2()) }]);
      expect(again.ok).toBe(false);
      expect(again.text).toBe('В курса има два урока с номер 0003: lessons/0003-a.html, lessons/0003-b.html. Поправи курса и импортирай отново.');
      expect(await snapshot(page)).toBe(before);
      // The author fixes the course (one file per number; quiz 0001-01-b → 0001-2-b): the progress stays.
      const fixed = t56v2();
      delete fixed['lessons/0003-b.html'];
      delete fixed['reference/R1-old.html'];
      fixed['quizzes/0001-2-b.json'] = fixed['quizzes/0001-01-b.json'];
      delete fixed['quizzes/0001-01-b.json'];
      const r = await importParts(page, [{ name: `${T}.zip`, bytes: zipOf(fixed) }]);
      expect(r.ok).toBe(true);
      console.log(`T056-S1 fixed import: ${r.text}`);
      const after = await dump(page);
      const L2 = Object.fromEntries(after.stores.lessons.map((l) => [l.id, l]));
      expect(L2[`${T}/lesson:0003`].progress.status).toBe('done');
      expect(L2[`${T}/reference:R01`].progress.status).toBe('done');
      expect(after.stores.lessons.filter((l) => l.retired).map((l) => l.id)).toEqual([]);
      // The link to the old reference path (R1-old.html) still opens R01.
      await page.goto(`${old.url}#/c/${T}/read/0001`);
      await expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
      await page.frameLocator('iframe.lesson-frame').locator('#toR').click();
      await expect(page).toHaveURL(/read\/R01$/);
      // A reload (on the course list: nothing is opened) does not migrate again.
      await page.goto(old.url);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await page.waitForTimeout(500);
      const lessonsBefore = (await dump(page)).stores.lessons.map((l) => [l.id, l.updatedAt, l.progress]);
      await page.reload();
      await expect(page.locator('[data-screen="courses"] .card--course')).toHaveCount(2);
      await page.waitForTimeout(500);
      expect((await dump(page)).stores.lessons.map((l) => [l.id, l.updatedAt, l.progress])).toEqual(lessonsBefore);
      // Only the 0.9.0 shell cache is left (no way back to 0.8.1 offline).
      console.log(`T056-S1 caches: ${JSON.stringify(await page.evaluate(() => caches.keys()))}`);
    } finally { await stop(); }
    rmSync(old.dir, { recursive: true, force: true });
  });

  test('T056-S2 v1 and v3 databases → v5 in one upgrade: lessons, annotations, subtopics, v3 answers all kept', async ({ page }) => {
    await start(page);
    const r = await db(page, async (db) => {
      const out = {};
      // v1: lessons, annotations, subtopics only (no quizzes store yet)
      await db.deleteDatabase('t056-v1');
      const v1 = await db.openDb({ name: 't056-v1', version: 1 });
      await v1.put('lessons', { id: 'V/lessons/0002-b.html', courseId: 'V', kind: 'lesson', number: '0002', path: 'lessons/0002-b.html', title: 'Б', order: 1, deleted: false, progress: { status: 'done', lastOpenedAt: '2026-01-01T00:00:00.000Z', scrollY: 9, completedAt: '2026-01-01T00:00:00.000Z' } });
      await v1.put('lessons', { id: 'V/reference/R3-x.html', courseId: 'V', kind: 'reference', number: 'R3', path: 'reference/R3-x.html', title: 'Р', order: 2, deleted: false, progress: { status: 'started', lastOpenedAt: null, scrollY: 2 } });
      await v1.put('annotations', { id: 'a', courseId: 'V', target: { type: 'lesson', id: 'V/reference/R3-x.html' }, color: 'yellow' });
      await v1.put('subtopics', { id: 's', courseId: 'V', parent: { type: 'lesson', id: 'V/lessons/0002-b.html' }, rootLessonId: 'V/lessons/0002-b.html' });
      await v1.put('settings', { id: 'app', theme: 'dark', apiKey: 'sk-ant-FAKE-t056-v1' });
      db.closeDb();
      const v5 = await db.openDb({ name: 't056-v1' });
      out.v1 = { version: v5.version, lessons: (await v5.getAll('lessons')).map((l) => [l.id, l.progress.status, l.progress.scrollY]), ann: (await v5.getAll('annotations')).map((a) => a.target.id), sub: (await v5.getAll('subtopics')).map((s) => [s.parent.id, s.rootLessonId]), key: (await v5.getAll('secrets')).map((s) => s.value), settings: await v5.getAll('settings') };
      db.closeDb();
      await db.deleteDatabase('t056-v1');
      // v3: answers already by text
      await db.deleteDatabase('t056-v3');
      const v3 = await db.openDb({ name: 't056-v3', version: 3 });
      const questions = [{ q: 'Едно?', options: ['А', 'Б'], answer: 0 }, { q: 'Две?', options: ['В', 'Г'], answer: 1 }];
      const keys = db.questionKeys(questions);
      await v3.put('quizzes', { id: 'V/quizzes/0004-02-q.json', courseId: 'V', path: 'quizzes/0004-02-q.json', slug: '0004-02-q', lesson: '0004', title: 'Q', questions, count: 2, order: 1, deleted: false });
      await v3.put('quizAnswers', { id: 'V/quizzes/0004-02-q.json', courseId: 'V', choices: { [keys[0]]: 'Б', [keys[1]]: 'Г' }, choicesV2: {}, cursor: 1, updatedAt: '2026-02-02T00:00:00.000Z' });
      await v3.put('quizAnswers', { id: 'V/quizzes/stray.json', courseId: 'V', choices: { x: 'Да' }, choicesV2: {}, cursor: 0, updatedAt: '2026-02-02T00:00:00.000Z' });
      db.closeDb();
      const w = await db.openDb({ name: 't056-v3' });
      const answers = await w.getAll('quizAnswers');
      out.v3 = { version: w.version, quizzes: (await w.getAll('quizzes')).map((q) => q.id), answers: answers.map((a) => [a.id, Object.values(a.choices).sort(), a.updatedAt]), score: db.scoreQuiz(await w.get('quizzes', 'V/quiz:0004-2'), answers.find((a) => a.id === 'V/quiz:0004-2')) };
      db.closeDb();
      await db.deleteDatabase('t056-v3');
      await db.openDb({ name: 'lrn-app' });
      return out;
    });
    expect(r.v1.version).toBe(5);
    expect(r.v1.lessons.sort()).toEqual([['V/lesson:0002', 'done', 9], ['V/reference:R03', 'started', 2]]);
    expect(r.v1.ann).toEqual(['V/reference:R03']);
    expect(r.v1.sub).toEqual([['V/lesson:0002', 'V/lesson:0002']]);
    expect(r.v1.key).toEqual(['sk-ant-FAKE-t056-v1']);
    expect(r.v1.settings[0].apiKey).toBeUndefined();
    expect(r.v3.version).toBe(5);
    expect(r.v3.quizzes).toEqual(['V/quiz:0004-2']);
    expect(r.v3.answers.sort()).toEqual([['V/quiz:0004-2', ['Б', 'Г'], '2026-02-02T00:00:00.000Z'], ['V/quiz:path:quizzes/stray.json', ['Да'], '2026-02-02T00:00:00.000Z']]);
    expect(r.v3.score).toMatchObject({ answered: 2, correct: 1 });
  });

  /** A big v4 database (made with this build's own v4 schema on a page that does not start the app). */
  async function bigV4(page, { courses, extraShadows = 3 }) {
    await page.goto('./manifest.webmanifest');
    return page.evaluate(async ({ courses, extraShadows }) => {
      const db = await import('./src/db.js');
      const idb = await db.openDb({ name: 'lrn-app', version: 4 });
      const at = (d, h = 0) => new Date(Date.UTC(2026, 9, 1 + (d % 28), h)).toISOString();
      const stores = ['courses', 'lessons', 'quizzes', 'quizAnswers', 'annotations', 'notes', 'subtopics', 'files'];
      const tx = idb.transaction(stores, 'readwrite');
      const put = (s, v) => tx.objectStore(s).put(v);
      let n = 0;
      for (let c = 0; c < courses; c++) {
        const C = `LRN-B${String(c).padStart(3, '0')}`;
        put('courses', { id: C, title: C, createdAt: at(c), updatedAt: at(c), deleted: false, meta: {} });
        for (let i = 1; i <= 18; i++) {
          const ref = i === 18;
          const number = ref ? 'R01' : String(i).padStart(4, '0');
          const path = ref ? 'reference/R01-spr.html' : `lessons/${number}-urok-${i}.html`;
          const status = ['new', 'started', 'done'][(c + i) % 3];
          const id = `${C}/${path}`;
          put('lessons', { id, courseId: C, kind: ref ? 'reference' : 'lesson', number, path, title: `Урок ${i}`, order: i, sha256: 'x', deleted: false, createdAt: at(i), updatedAt: at(i, 1), progress: { status, lastOpenedAt: status === 'new' ? null : at(c + i, 2), scrollY: c * 100 + i, ...(status === 'done' ? { completedAt: at(c + i, 3) } : {}) } });
          put('files', { key: `${C}/${path}`, courseId: C, path, sha256: 'x', size: 1, deleted: false });
          for (let a = 0; a < 3; a++) {
            const aid = `A-${C}-${i}-${a}`;
            put('annotations', { id: aid, courseId: C, target: { type: 'lesson', id }, color: 'yellow', createdAt: at(1), updatedAt: at(1), deleted: false });
            if (a === 0) put('notes', { id: `N-${aid}`, annotationId: aid, body: `бележка ${n++}`, createdAt: at(1), updatedAt: at(1), deleted: false });
            if (a === 1 && i % 3 === 0) put('subtopics', { id: `S-${aid}`, annotationId: aid, courseId: C, parent: { type: 'lesson', id }, rootLessonId: id, depth: 1, createdAt: at(1), updatedAt: at(1), deleted: false });
          }
          if (!ref && i <= extraShadows) {
            // a T-011-fix shadow (an earlier file name of the same lesson) with better progress
            const old = `lessons/${number}-staro-${i}.html`;
            put('lessons', { id: `${C}/${old}`, courseId: C, kind: 'lesson', number, path: old, title: `Урок ${i}`, order: i, deleted: true, renamedTo: id, createdAt: at(0), updatedAt: at(i, 5), progress: { status: 'done', completedAt: at(0, 4), lastOpenedAt: at(0, 4), scrollY: 1 } });
            put('annotations', { id: `A-${C}-${i}-old`, courseId: C, target: { type: 'lesson', id: `${C}/${old}` }, color: 'blue', createdAt: at(0), updatedAt: at(0), deleted: false });
          }
          if (!ref) {
            for (const k of [1, 2]) {
              const qp = `quizzes/${number}-${k}-test.json`;
              const qid = `${C}/${qp}`;
              const questions = Array.from({ length: 6 }, (_, j) => ({ q: `${C} ${number}-${k} въпрос ${j}?`, options: ['Да', 'Не', 'Може би'], answer: j % 3 }));
              put('quizzes', { id: qid, courseId: C, path: qp, slug: `${number}-${k}-test`, lesson: number, title: `Тест ${number}-${k}`, questions, count: 6, order: i * 2 + k, deleted: false, updatedAt: at(1) });
              const keys = db.questionKeys(questions);
              put('quizAnswers', { id: qid, courseId: C, choices: Object.fromEntries(keys.slice(0, 1 + ((c + i + k) % 6)).map((key, j) => [key, questions[j].options[j % 3]])), choicesV2: {}, cursor: 0, updatedAt: at(c + i, 6), deleted: false });
            }
          }
        }
      }
      await tx.done;
      db.closeDb();
      return null;
    }, { courses, extraShadows });
  }

  test('T056-S3 a big database (60 courses × 18 lessons, 2040 quizzes with answers, 3400 annotations, shadows) under CPU ×4 → v5: nothing lost, time measured', async ({ page }, info) => {
    onlyLandscape(info, 'heavy');
    test.setTimeout(240_000);
    await bigV4(page, { courses: 60 });
    const v4 = await dump(page);
    console.log(`T056-S3 v4: ${Object.entries(v4.stores).map(([s, l]) => `${s} ${l.length}`).join(', ')}`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const t0 = Date.now();
    await page.goto('./');
    await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).find((d) => d.name === 'lrn-app')?.version), { timeout: 120000, intervals: [100] }).toBe(5);
    const ms = Date.now() - t0;
    await expect(page.locator('[data-screen="courses"] .card--course').first()).toBeVisible({ timeout: 60000 });
    const ms2 = Date.now() - t0;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log(`T056-S3 upgrade at CPU ×4: v5 after ${ms} ms, course cards after ${ms2} ms`);
    await expect(page.locator('#db-error')).toBeHidden();
    const v5 = await dump(page);
    const issues = checkNoLoss(v4, v5);
    expect(issues.slice(0, 10)).toEqual([]);
    expect(v5.stores.lessons).toHaveLength(60 * 18);
    expect(v5.stores.quizzes).toHaveLength(60 * 17 * 2);
    expect(ms).toBeLessThan(60000);
  });

  for (const how of ['close', 'reload']) {
    test(`T056-S4 the upgrade interrupted by ${how === 'close' ? 'closing the tab' : 'a reload'} while it runs: the database is either the old v4 (unchanged) or a complete v5, never half`, async ({ page, context }, info) => {
      onlyLandscape(info, 'heavy');
      test.setTimeout(300_000);
      await bigV4(page, { courses: 80 });
      const v4 = await dump(page);
      const v4json = JSON.stringify(v4);
      // Every page reports the moment the upgrade of lrn-app begins (upgradeneeded).
      await context.addInitScript(() => {
        const open = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (...args) {
          const r = open.apply(this, args);
          if (args[0] === 'lrn-app') r.addEventListener('upgradeneeded', () => console.log('T056-UPGRADE-START'));
          return r;
        };
      });
      const outcomes = [];
      for (const delay of [0, 20, 80, 250, 600]) {
        const victim = await context.newPage();
        const cdp = await context.newCDPSession(victim);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const started = victim.waitForEvent('console', { predicate: (m) => m.text() === 'T056-UPGRADE-START', timeout: 30000 });
        victim.goto('./').catch(() => {});
        await started;
        if (delay) await victim.waitForTimeout(delay);
        if (how === 'close') await victim.close();
        else {
          // The user reloads: the reloaded page opens the database again and must end up in a complete v5.
          await victim.reload();
          await expect(victim.locator('[data-screen="courses"] .card--course').first()).toBeVisible({ timeout: 60000 });
          await expect(victim.locator('#db-error')).toBeHidden();
          await victim.close();
        }
        await page.goto('./manifest.webmanifest');
        await page.waitForTimeout(300);
        const state = await dump(page);
        if (state.version === 4) {
          expect(JSON.stringify(state), `after ${how} at +${delay} ms the v4 database changed`).toBe(v4json);
          outcomes.push(`+${delay} ms: v4 (unchanged)`);
        } else {
          expect(state.version).toBe(5);
          expect(checkNoLoss(v4, state).slice(0, 5), `after ${how} at +${delay} ms`).toEqual([]);
          outcomes.push(`+${delay} ms: v5 (complete)`);
          break; // nothing left to interrupt
        }
      }
      console.log(`T056-S4 ${how}: ${outcomes.join('; ')}`);
      // Opening the app at last completes the upgrade with nothing lost.
      await page.goto('./');
      await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).find((d) => d.name === 'lrn-app')?.version), { timeout: 120000 }).toBe(5);
      await expect(page.locator('#db-error')).toBeHidden();
      const v5 = await dump(page);
      expect(checkNoLoss(v4, v5).slice(0, 5)).toEqual([]);
      if (how === 'close') expect(outcomes.some((o) => o.includes('v4'))).toBe(true); // at least one close really hit the running upgrade
    });
  }

  test('T056-S5 a database of a NEWER version (6): the screen shows the error, nothing is changed', async ({ page }) => {
    allowed.push(/IndexedDB/, /VersionError/, /Failed to load resource/);
    await page.goto('./manifest.webmanifest');
    await page.evaluate(() => new Promise((ok) => {
      const r = indexedDB.open('lrn-app', 6);
      r.onupgradeneeded = () => { r.result.createObjectStore('lessons', { keyPath: 'id' }).put({ id: 'X/lesson:0001', progress: { status: 'done' } }); };
      r.onsuccess = () => { r.result.close(); ok(); };
    }));
    await page.goto('./');
    await expect(page.locator('#db-error')).toBeVisible({ timeout: 15000 });
    console.log(`T056-S5 screen: ${await page.locator('#db-error').innerText()}`);
    const d = await dump(page);
    expect(d.version).toBe(6);
    expect(d.stores.lessons).toEqual([{ id: 'X/lesson:0001', progress: { status: 'done' } }]);
  });

  test('T056-S6 an old connection that never lets go (no versionchange handler) blocks the upgrade: does the screen say so? Once it closes, the upgrade completes', async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.goto('./manifest.webmanifest');
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const v4 = await db.openDb({ name: 'lrn-app', version: 4 });
      await v4.put('lessons', { id: 'LRN-BL/lessons/0001-a.html', courseId: 'LRN-BL', kind: 'lesson', number: '0001', path: 'lessons/0001-a.html', title: 'А', order: 1, deleted: false, progress: { status: 'done', lastOpenedAt: null, scrollY: 5 } });
      db.closeDb();
    });
    const holder = await context.newPage();
    await holder.goto('./manifest.webmanifest');
    await holder.evaluate(() => new Promise((ok) => { const r = indexedDB.open('lrn-app'); r.onsuccess = () => { window.__hold = r.result; ok(); }; }));
    await page.goto('./');
    await page.waitForTimeout(5000);
    const shown = {
      error: await page.locator('#db-error').isVisible(),
      main: (await page.locator('#main').innerText()).slice(0, 160),
      version: (await page.evaluate(async () => (await indexedDB.databases()).find((d) => d.name === 'lrn-app')?.version)),
    };
    console.log(`T056-S6 blocked for 5 s: ${JSON.stringify(shown)}`);
    expect(shown.version).toBe(4);
    await holder.evaluate(() => window.__hold.close());
    await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).find((d) => d.name === 'lrn-app')?.version), { timeout: 15000 }).toBe(5);
    const d = await dump(page);
    expect(d.stores.lessons.map((l) => [l.id, l.progress.status])).toEqual([['LRN-BL/lesson:0001', 'done']]);
    await holder.close();
    // While blocked, the course list was simply empty, without any hint.
    // Fixed in 0.10.0 (T-057): test.fail removed.
    expect(shown.error || /друг|раздел|Зареждам/.test(shown.main)).toBe(true);
  });

  test('T056-S7 going back: 0.9.0 → 0.8.1 (a reverted deploy) cannot open the v5 database — what does it show; back on 0.9.0 the data is all there', async ({ page }, info) => {
    onlyLandscape(info, 'two servers, two builds');
    test.setTimeout(240_000);
    const old = oldBuild(info, 1);
    let stop = await serve(REPO, old.port);
    let v5;
    try {
      await page.goto(old.url);
      await expect(page.locator('[data-screen="courses"]')).toBeVisible();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await importParts(page, [{ name: DRIVE_ZIP_NAME, bytes: [...makeZip(readFixture(), { root: 'LRN-DEMO' })] }]);
      await db(page, (db) => db.setLessonProgress('LRN-DEMO/lesson:0001', { status: 'done', completedAt: '2026-11-19T10:00:00.000Z', lastOpenedAt: '2026-11-19T10:00:00.000Z', scrollY: 50 }));
      v5 = await dump(page);
    } finally { await stop(); }
    stop = await serve(old.dir, old.port);
    let seen;
    try {
      allowed.push(/IndexedDB|VersionError|version|Failed to load/i);
      await updateTo(page, old.url, '0.8.1');
      await page.waitForTimeout(1500);
      seen = { screen: (await page.locator('#main').innerText()).slice(0, 200), version: (await dump(page)).version };
      await page.goto(`${old.url}#/c/LRN-DEMO`);
      await page.waitForTimeout(1500);
      seen.course = (await page.locator('#main').innerText()).slice(0, 200);
      console.log(`T056-S7 0.8.1 on a v5 database: ${JSON.stringify(seen)}`);
      expect(seen.version).toBe(5);
    } finally { await stop(); }
    stop = await serve(REPO, old.port);
    try {
      await updateTo(page, old.url, NOW_VERSION);
      const back = await dump(page);
      expect(JSON.stringify(back.stores.lessons)).toBe(JSON.stringify(v5.stores.lessons));
      expect(JSON.stringify(back.stores.quizAnswers)).toBe(JSON.stringify(v5.stores.quizAnswers));
      await page.goto(`${old.url}#/c/LRN-DEMO`);
      // D-040 (T-057, 0.10.0): 0001 is marked, but its two quizzes are not answered → ◐ "Завършен", not counted.
      await expect(page.locator('[data-field="course-progress"]')).toHaveText('Завършени: 0 от 1 урок');
      await expect(page.locator('.course-item[data-item="LRN-DEMO/lesson:0001"] [data-field="lesson-meta"]')).toContainText('Завършен · ');
    } finally { await stop(); }
    rmSync(old.dir, { recursive: true, force: true });
    test.info().annotations.push({ type: 'T056-I3', description: JSON.stringify(seen) });
  });
});

// ---------------------------------------------------------------------------
// I: re-import by number
// ---------------------------------------------------------------------------
const C = 'LRN-T56I';
const base = () => ({
  'INDEX.md': index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']]),
  'lessons/0001-alpha.html': lessonHtml('Алфа', '<p>Алфа.</p>'),
  'lessons/0002-beta.html': lessonHtml('Бета', '<p><a id="to3" href="0003-gama.html">гама</a></p>'),
  'lessons/0003-gama.html': lessonHtml('Гама'),
  'reference/R01-ref.html': lessonHtml('Справка'),
  'quizzes/0001-1-alpha.json': quizJson('0001', 'Тест алфа', 3),
  'quizzes/0003-1-gama.json': quizJson('0003', 'Тест гама', 2),
});
const rows = (page, id = C) => db(page, async (db, C) => (await db.listLessons(C, { includeDeleted: true }))
  .map((l) => [l.id.slice(C.length + 1), l.path, l.progress.status, !!l.retired, !!l.deleted]), id);
async function seed(page) {
  const r = await importCourse(page, C, base());
  expect(r.ok).toBe(true);
  await db(page, async (db, C) => {
    await db.setLessonProgress(`${C}/lesson:0001`, { status: 'done', completedAt: '2026-11-18T10:00:00.000Z', lastOpenedAt: '2026-11-18T10:00:00.000Z', scrollY: 111 });
    await db.setLessonProgress(`${C}/lesson:0003`, { status: 'started', lastOpenedAt: '2026-11-19T11:00:00.000Z', scrollY: 333 });
    const q = await db.getQuiz(`${C}/quiz:0001-1`);
    const keys = db.questionKeys(q.questions);
    for (let i = 0; i < 3; i++) await db.saveQuizChoice(q.id, { courseId: C, qKey: keys[i], choice: q.questions[i].options[0], cursor: i });
  }, C);
}
const course = (page) => page.locator('[data-screen="course"]');
async function openCourse(page, id = C) {
  await page.goto(`./#/c/${id}`);
  await expect(course(page).locator('[data-section="activity"]')).toBeVisible({ timeout: 15000 });
}
const waitReady = (page) => expect(page.locator('[data-lesson-state="ready"]')).toBeVisible({ timeout: 20000 });
const lf = (page) => page.frameLocator('iframe.lesson-frame');

test.describe('T056-I re-import by number', () => {
  test.beforeEach(async ({ page }) => { await start(page); });

  test('T056-I1 odd file names: only lessons/NNNN-slug.html and reference/R<n>… are lessons; are the others mentioned?', async ({ page }) => {
    const files = {
      'lessons/0001-ok.html': lessonHtml('Добър'),
      'lessons/00031-pet.html': lessonHtml('Пет цифри'),
      'lessons/003-tri.html': lessonHtml('Три цифри'),
      'lessons/0004.html': lessonHtml('Без slug'),
      'lessons/0005-.html': lessonHtml('Празен slug'),
      'LESSONS/0006-golemi.HTML': lessonHtml('Главни букви'),
      'lessons/٠٠٠٧-arabski.html': lessonHtml('Арабски цифри'),
      'lessons/0008-x.htm': lessonHtml('htm'),
      'reference/R001-tri-nuli.html': lessonHtml('R001'),
      'reference/r2-malko.html': lessonHtml('r2'),
      'reference/R03.html': lessonHtml('R03 без slug'),
    };
    const r = await importCourse(page, 'LRN-ODD', files);
    expect(r.ok).toBe(true);
    const got = (await rows(page, 'LRN-ODD')).map(([id, path]) => [id, path]);
    console.log(`T056-I1 lessons: ${JSON.stringify(got)}; text: ${r.text}`);
    expect(got).toEqual([
      ['lesson:0001', 'lessons/0001-ok.html'],
      ['lesson:0006', 'LESSONS/0006-golemi.html'], // the extension is lower-cased at import (cleanPath)
      ['lesson:0008', 'lessons/0008-x.htm'],
      ['reference:R01', 'reference/R001-tri-nuli.html'],
      ['reference:R02', 'reference/r2-malko.html'],
      ['reference:R03', 'reference/R03.html'],
    ]);
    // The upper-case lesson opens.
    await page.goto('./#/c/LRN-ODD/read/0006');
    await waitReady(page);
    await expect(lf(page).locator('h1')).toHaveText('Главни букви');
    // Five files in lessons/ look like lessons but are not imported as lessons: the summary should name them.
    // Fixed in 0.10.0 (T-057): test.fail removed.
    expect(r.text).toMatch(/00031-pet|0004\.html|003-tri/);
  });

  for (const [name, files, want] of [
    ['0004-a / 0004-b', { 'lessons/0004-a.html': lessonHtml('А'), 'lessons/0004-b.html': lessonHtml('Б') }, 'два урока с номер 0004'],
    ['0004-a.html / 0004-a.htm', { 'lessons/0004-a.html': lessonHtml('А'), 'lessons/0004-a.htm': lessonHtml('Б') }, 'два урока с номер 0004'],
    ['lessons/ and LESSONS/', { 'lessons/0004-a.html': lessonHtml('А'), 'LESSONS/0004-b.html': lessonHtml('Б') }, 'два урока с номер 0004'],
    ['three files', { 'lessons/0004-a.html': lessonHtml('А'), 'lessons/0004-b.html': lessonHtml('Б'), 'lessons/0004-c.html': lessonHtml('В') }, 'три урока с номер 0004'],
    ['an existing number under a new name', { 'lessons/0003-gama-novo.html': lessonHtml('Гама') }, 'два урока с номер 0003'],
    ['r02 / R02', { 'reference/r02-a.html': lessonHtml('А'), 'reference/R02-b.html': lessonHtml('Б') }, 'два справочника с номер R02'],
    ['R002 / R2', { 'reference/R002-a.html': lessonHtml('А'), 'reference/R2-b.html': lessonHtml('Б') }, 'два справочника с номер R02'],
    ['quiz 0004-1.json / 0004-1-x.json', { 'quizzes/0004-1.json': quizJson('0004', 'А'), 'quizzes/0004-1-x.json': quizJson('0004', 'Б') }, 'два теста с номер 0004-1'],
    ['quiz 0004-001 / 0004-1', { 'quizzes/0004-001-a.json': quizJson('0004', 'А'), 'quizzes/0004-1-b.json': quizJson('0004', 'Б') }, 'два теста с номер 0004-1'],
  ]) {
    test(`T056-I2 duplicate ${name} → refused, nothing written`, async ({ page }) => {
      await seed(page);
      const snap = await snapshot(page);
      const r = await importCourse(page, C, { ...base(), 'lessons/0009-nov.html': lessonHtml('Нов'), 'NOTES.md': '# нови бележки', ...files });
      expect(r.ok).toBe(false);
      expect(r.text).toContain(`В курса има ${want}:`);
      expect(r.text).toContain('Поправи курса и импортирай отново.');
      expect(await snapshot(page)).toBe(snap);
    });
  }

  test('T056-I2b a duplicate split over two ZIP parts → refused; through the screen the message is shown and the course is unchanged', async ({ page }) => {
    await seed(page);
    const snap = await snapshot(page);
    const p1 = base();
    const p2 = { 'lessons/0002-beta-drug.html': lessonHtml('Друга бета'), 'lessons/0010-nov.html': lessonHtml('Нов') };
    const parts = [
      { name: `${C}-20261119T090000Z-1-001.zip`, buffer: makeZip(toBytes(p1), { root: C }) },
      { name: `${C}-20261119T090000Z-1-002.zip`, buffer: makeZip(toBytes(p2), { root: C }) },
    ];
    await page.goto('./');
    await page.locator('input[data-input="zip"]').setInputFiles(parts.map((p) => ({ name: p.name, mimeType: 'application/zip', buffer: Buffer.from(p.buffer) })));
    await expect(page.locator('[data-field="import-error"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-field="import-error"]')).toHaveText('В курса има два урока с номер 0002: lessons/0002-beta-drug.html, lessons/0002-beta.html. Поправи курса и импортирай отново.');
    await expect(page.locator('[data-field="import-result"]')).toBeHidden();
    expect(await snapshot(page)).toBe(snap);
  });

  test('T056-I3 "## Оттеглени номера" with the file still in the ZIP and in the table: consistently retired everywhere (summary, list, card, Продължи, reader, links); taken off the list → back', async ({ page }) => {
    await seed(page); // 0003 is the last opened lesson
    const files = base();
    files['INDEX.md'] = index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']],
      '\n## Оттеглени номера\n- 0003 — слят с 0002 (2026-11-20)\n');
    const r = await importCourse(page, C, files);
    expect(r.ok).toBe(true);
    expect(r.summary.lessons.retired).toEqual(['0003 Гама']);
    expect(r.summary.counts).toMatchObject({ lessons: 2, retired: 1 });
    expect(r.summary.items.map((i) => i.number)).toEqual(['0001', '0002', 'R01']);
    expect((await importCourse(page, C, files)).text).toMatch(/^Без промени/);
    // Курсове: the card does not count it
    await page.goto('./');
    await expect(page.locator(`.card--course[data-course="${C}"]`)).toContainText('2 урока');
    await openCourse(page);
    await expect(course(page).locator('[data-kind="lesson"] .course-item')).toHaveCount(2);
    await expect(course(page).locator('[data-field="course-progress"]')).toHaveText('Завършени: 1 от 2 урока');
    await expect(course(page).locator('[data-action="continue"]')).toContainText('урок 0001');
    await expect(course(page).locator('[data-kind="retired"] .course-item')).toHaveCount(1);
    // keyboard: the summary opens with Enter
    await course(page).locator('details[data-section="retired"] summary').focus();
    await page.keyboard.press('Enter');
    await expect(course(page).locator('details[data-section="retired"]')).toHaveAttribute('open', '');
    // A link from 0002 to the retired 0003 opens it with the note.
    await page.goto(`./#/c/${C}/read/0002`);
    await waitReady(page);
    await expect(page.locator('[data-field="retired-note"]')).toBeHidden();
    await lf(page).locator('#to3').click();
    await expect(page).toHaveURL(/read\/0003$/);
    await waitReady(page);
    await expect(page.locator('[data-field="retired-note"]')).toBeVisible();
    // Its progress and its quiz answers are still there.
    expect((await rows(page)).find(([id]) => id === 'lesson:0003')).toEqual(['lesson:0003', 'lessons/0003-gama.html', 'started', true, false]);
    // Taken off the list: back in the course.
    const back = await importCourse(page, C, base());
    expect(back.summary.lessons.restored).toEqual(['0003 Гама']);
    await openCourse(page);
    await expect(course(page).locator('[data-section="retired"]')).toHaveCount(0);
    await expect(course(page).locator('[data-kind="lesson"] .course-item')).toHaveCount(3);
  });

  test('T056-I4 odd "Оттеглени" layouts: a table, two numbers on one line, "Оттеглени уроци", a number with a letter — what is retired (nothing is deleted)', async ({ page }) => {
    await seed(page);
    const md = (extra) => index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['0003', 'Гама', 'lessons/0003-gama.html'], ['R01', 'Справка', 'reference/R01-ref.html']], extra);
    const cases = [
      ['table', '\n## Оттеглени номера\n| # | Защо |\n|---|---|\n| 0002 | слят |\n'],
      ['two on a line', '\n## Оттеглени номера\n- 0002, 0003 — слети с 0001\n'],
      ['"Оттеглени уроци"', '\n## Оттеглени уроци\n- 0002 — слят\n'],
      ['"0002a"', '\n## Оттеглени номера\n- 0002a — грешен номер\n'],
      ['a star list + R1', '\n## Оттеглени номера\n* R1 — махнат\n'],
    ];
    const seen = {};
    for (const [name, extra] of cases) {
      const r = await importCourse(page, C, { ...base(), 'INDEX.md': md(extra) });
      expect(r.ok, name).toBe(true);
      seen[name] = (await rows(page)).filter((x) => x[3]).map((x) => x[0]);
      await importCourse(page, C, base()); // back
    }
    console.log(`T056-I4 retired by layout: ${JSON.stringify(seen)}`);
    expect(seen['"Оттеглени уроци"']).toEqual(['lesson:0002']);
    expect(seen['a star list + R1']).toEqual(['reference:R01']);
    expect(seen['"0002a"']).toEqual([]);
    expect(seen.table).toEqual([]);
    expect((await rows(page)).filter((x) => x[3])).toEqual([]);
    const kept = await db(page, async (db, C) => [(await db.getLesson(`${C}/lesson:0001`)).progress.status, Object.keys((await db.getQuizAnswers(`${C}/quiz:0001-1`)).choices).length], C);
    expect(kept).toEqual(['done', 3]);
  });

  test('T056-I5 a quiz whose "lesson" is a missing number, one of a retired lesson, one whose file number ≠ its lesson: imported, answers kept, shown', async ({ page }) => {
    await seed(page);
    const files = base();
    delete files['lessons/0003-gama.html'];
    files['INDEX.md'] = index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['R01', 'Справка', 'reference/R01-ref.html']]);
    files['quizzes/0009-1-nyama.json'] = quizJson('0009', 'Тест без урок', 2);
    files['quizzes/0002-1-drug.json'] = quizJson('0001', 'Тест с друг урок', 2);
    const r = await importCourse(page, C, files);
    expect(r.ok).toBe(true);
    console.log(`T056-I5 summary: ${r.text}`);
    expect(r.summary.lessons.retired).toEqual(['0003 Гама']);
    const q = await db(page, async (db, C) => (await db.listQuizzes(C)).map((q) => [q.id.slice(C.length + 1), q.lesson]), C);
    expect(q.sort()).toEqual([['quiz:0001-1', '0001'], ['quiz:0002-1', '0001'], ['quiz:0003-1', '0003'], ['quiz:0009-1', '0009']]);
    await openCourse(page);
    await expect(course(page).locator('.quiz-list__item')).toHaveCount(4);
    await expect(course(page).locator(`.quiz-list__item[data-quiz="${C}/quiz:0001-1"] [data-field="quiz-status"]`)).toHaveText(/резултат: \d от 3 верни/);
    await page.goto(`./#/c/${C}/quiz/0009-1-nyama`);
    await expect(page.locator('[data-screen="quiz"]')).toContainText('Тест без урок');
    // D-039 §А.2.5: "тест, чийто lesson сочи несъществуващ номер → тестът се импортира, бележка в резюмето".
    // Fixed in 0.10.0 (T-057): test.fail removed.
    expect(r.text).toMatch(/0009/);
  });

  test('T056-I6 a quiz renamed and changed, back and forth: answers of unchanged questions stay, previousPaths without repeats', async ({ page }) => {
    await seed(page);
    const changed = base();
    delete changed['quizzes/0001-1-alpha.json'];
    const q = JSON.parse(new TextDecoder().decode(quizJson('0001', 'Тест алфа', 3)));
    q.questions[2] = { q: 'Съвсем нов въпрос?', options: ['Х', 'У'], answer: 0 };
    changed['quizzes/0001-1-alpha-novo.json'] = JSON.stringify(q);
    for (const files of [changed, base(), changed, base()]) {
      const r = await importCourse(page, C, files);
      expect(r.ok).toBe(true);
    }
    const st = await db(page, async (db, C) => {
      const quiz = await db.getQuiz(`${C}/quiz:0001-1`);
      return { path: quiz.path, prev: quiz.previousPaths, score: db.scoreQuiz(quiz, await db.getQuizAnswers(quiz.id)), all: (await db.listQuizzes(C, { includeDeleted: true })).length };
    }, C);
    expect(st.path).toBe('quizzes/0001-1-alpha.json');
    expect(st.prev).toEqual(['quizzes/0001-1-alpha-novo.json']);
    expect(st.score).toMatchObject({ answered: 3, total: 3 });
    expect(st.all).toBe(2);
  });

  test('T056-I7 a split ZIP whose INDEX.md is in the SECOND part, imported alone: the lessons of part 1 (still in INDEX) are not retired', async ({ page }) => {
    await seed(page);
    const only2 = { 'INDEX.md': base()['INDEX.md'], 'lessons/0003-gama.html': base()['lessons/0003-gama.html'] };
    const r = await importParts(page, [{ name: `${C}-20261119T090000Z-1-002.zip`, bytes: [...makeZip(toBytes(only2), { root: C })] }]);
    expect(r.ok).toBe(true);
    expect(r.summary.lessons.retired).toEqual([]);
    expect((await rows(page)).filter((x) => x[3])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L: links between lessons
// ---------------------------------------------------------------------------
test.describe('T056-L links', () => {
  test.beforeEach(async ({ page }) => { await start(page); });

  test('T056-L1 links: an old path + #fragment, R by number in another spelling, a retired lesson, and never into another course with the same number (../, %2e%2e, %2F, absolute)', async ({ page }) => {
    // Another course with the same numbers.
    expect((await importCourse(page, 'LRN-OTHER', { 'lessons/0001-x.html': lessonHtml('Чужд урок'), 'lessons/0005-y.html': lessonHtml('Чужд пети') })).ok).toBe(true);
    const files = base();
    files['lessons/0002-beta.html'] = lessonHtml('Бета', [
      '<p><a id="old" href="0001-staro-ime.html#kray">стар път с котва</a></p>',
      '<p><a id="ref" href="../reference/r1-kakvoto-i-da-e.html">справка</a></p>',
      '<p><a id="ret" href="0003-gama.html">оттеглен</a></p>',
      '<p><a id="dots" href="../../LRN-OTHER/lessons/0001-x.html">чужд ../</a></p>',
      '<p><a id="enc" href="%2e%2e/%2e%2e/LRN-OTHER/lessons/0005-y.html">чужд %2e%2e</a></p>',
      '<p><a id="slash" href="..%2F..%2FLRN-OTHER%2Flessons%2F0005-y.html">чужд %2F</a></p>',
      '<p><a id="abs" href="/EasyLRN/c/LRN-OTHER/lessons/0005-y.html">чужд абсолютен</a></p>',
      '<p><a id="five" href="0005-y.html">пети (няма го тук)</a></p>',
    ].join(''));
    files['lessons/0001-alpha.html'] = lessonHtml('Алфа', `<p>Начало.</p>${'<p>пълнеж</p>'.repeat(80)}<h2 id="kray">Край</h2>`);
    files['INDEX.md'] = index(C, [['0001', 'Алфа', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['R01', 'Справка', 'reference/R01-ref.html']]);
    delete files['lessons/0003-gama.html'];
    await importCourse(page, C, base()); // 0003 exists first …
    const r = await importCourse(page, C, files); // … then is retired (missing from a full import)
    expect(r.summary.lessons.retired).toEqual(['0003 Гама']);
    // 0001 had an old name: put it in previousPaths through a rename.
    allowed.push(/not a lesson of the course|another course/);
    const go = async () => { await page.goto(`./#/c/${C}/read/0002`); await waitReady(page); };
    await go();
    await lf(page).locator('#old').click();
    await expect(page).toHaveURL(/read\/0001(\?at=kray)?$/);
    await waitReady(page);
    await go();
    await lf(page).locator('#ref').click();
    await expect(page).toHaveURL(/read\/R01$/);
    await go();
    await lf(page).locator('#ret').click();
    await expect(page).toHaveURL(/read\/0003$/);
    await waitReady(page);
    await expect(page.locator('[data-field="retired-note"]')).toBeVisible();
    for (const id of ['dots', 'enc', 'slash', 'abs', 'five']) {
      await go();
      await lf(page).locator(`#${id}`).click();
      await page.waitForTimeout(400);
      await expect(page, id).toHaveURL(new RegExp(`#/c/${C}/read/0002$`));
      await expect(lf(page).locator('h1'), id).toHaveText('Бета');
    }
  });

  test('T056-L2 hash routes cannot reach another course: a path, an id or ../ of LRN-OTHER in the route of this course → "Урокът не е намерен"', async ({ page }) => {
    expect((await importCourse(page, 'LRN-OTHER', { 'lessons/0005-y.html': lessonHtml('Чужд пети') })).ok).toBe(true);
    expect((await importCourse(page, C, base())).ok).toBe(true);
    for (const key of ['LRN-OTHER%2Flesson%3A0005', '..%2F..%2FLRN-OTHER%2Flessons%2F0005-y.html', '..%2FLRN-OTHER%2Flessons%2F0005-y.html', '0005', 'lessons%2F0005-y.html', 'lesson%3A0005']) {
      await page.goto(`./#/c/${C}/read/${key}`);
      await expect(page.locator('[data-field="reader-missing"]'), key).toHaveText('Урокът не е намерен в курса. Импортирай курса отново.', { timeout: 10000 });
    }
    // Its own lessons by every spelling.
    for (const key of ['3', '0003', `${encodeURIComponent(`${C}/lesson:0003`)}`, 'lessons%2F0003-gama.html', 'lessons%2F0003-drugo-ime.html']) {
      await page.goto(`./#/c/${C}/read/${key}`);
      await waitReady(page);
      await expect(lf(page).locator('h1'), key).toHaveText('Гама');
    }
  });
});

// ---------------------------------------------------------------------------
// X: XSS in titles
// ---------------------------------------------------------------------------
test.describe('T056-X titles are text', () => {
  test.beforeEach(async ({ page }) => { await start(page); });

  test('T056-X1 markup in a lesson title (entities in <h1>) and in INDEX.md: the warning, the import result and "Вече не са в курса" show it as text', async ({ page }) => {
    await page.addInitScript(() => { window.__xss = 0; });
    const evil = '&lt;img src=x onerror="window.__xss=1"&gt;';
    const files = base();
    const r0 = await importCourse(page, C, files);
    expect(r0.ok).toBe(true);
    await db(page, (db, C) => db.setLessonProgress(`${C}/lesson:0001`, { status: 'started', lastOpenedAt: new Date().toISOString() }), C);
    // 0001 gets a markup title (→ the warning); 0003 is retired with a markup title in INDEX.md and its own h1.
    await db(page, async (db, C) => db.update(db.STORES.lessons, `${C}/lesson:0003`, () => ({ title: '<img src=x onerror="window.__xss=2">' })), C);
    const next = base();
    next['lessons/0001-alpha.html'] = lessonHtml(evil);
    delete next['lessons/0003-gama.html'];
    next['INDEX.md'] = index(C, [['0001', '<img src=x onerror="window.__xss=3"> **Алфа**', 'lessons/0001-alpha.html'], ['0002', 'Бета', 'lessons/0002-beta.html'], ['R01', 'Справка', 'reference/R01-ref.html']]);
    const buffer = makeZip(toBytes(next), { root: C });
    await page.goto('./');
    await page.locator('input[data-input="zip"]').setInputFiles({ name: `${C}.zip`, mimeType: 'application/zip', buffer: Buffer.from(buffer) });
    const result = page.locator('[data-field="import-result"]');
    await expect(result).toBeVisible({ timeout: 20000 });
    await expect(result).toContainText('Внимание: Урок 0001 е с ново заглавие „<img src=x onerror="window.__xss=1">“');
    await expect(result).toContainText('Вече не са в курса: 0003 <img src=x onerror="window.__xss=2">');
    await expect(result.locator('img')).toHaveCount(0);
    await openCourse(page);
    await course(page).locator('details[data-section="retired"] summary').click();
    await expect(course(page).locator('[data-kind="retired"] .course-item')).toContainText('<img src=x onerror="window.__xss=2">');
    await expect(course(page).locator('[data-kind="lesson"] .course-item').first()).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(page.locator('#main img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBe(0);
  });
});
