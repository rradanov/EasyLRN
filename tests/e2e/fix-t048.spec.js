// T-048-fix (developer): the fixes of the T-048 defects.
// - T048-S1c: the renderer removes nested frames with the browser's own HTML
//   parser, without console (CSP) noise in the app.
// - T048-S1a/b: further guard paths (closed shadow roots, document.write with
//   declarative shadow DOM, overridden Function.prototype.call/NodeList#length,
//   synchronous access to a fresh frame) and the app stopping a lesson that
//   reports a frame it could not remove.
// - T048-D1…D3, Н-2, Н-4, Н-5: answers by content, invalid options, duplicate
//   questions, notes in the import summary, lesson numbers, focus on "Отказ".
// Synthetic data only (D-026).
import { test, expect } from '@playwright/test';
import { makeZip, asFile } from '../fixtures/zips.mjs';
import { strToU8 } from '../../vendor/fflate.js';

let problems;
test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await page.goto('./');
  await expect(page.locator('[data-screen="courses"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
});
// Frame/CSP errors inside a hostile lesson are expected; nothing else.
const unexpected = () => problems.filter((p) => !/Refused to (frame|load)|frame-src|Blocked a frame|sandbox/i.test(p));
test.afterEach(() => { expect(unexpected()).toEqual([]); });

const doc = (body, head = '') => strToU8(`<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title>${head}</head><body><h1>Урок</h1>${body}</body></html>`);
async function importCourse(page, id, files) {
  const f = asFile(`${id}.zip`, makeZip(files, { root: id }));
  return page.evaluate(async ({ name, bytes }) => {
    const m = await import('./src/course-import.js');
    return m.describeSummary(await m.importCourse([new File([new Uint8Array(bytes)], name)]));
  }, { name: f.name, bytes: [...f.buffer] });
}
const REPORT = (name) => `<scr` + `ipt>var m={nested:${JSON.stringify(name)},rtc:typeof RTCPeerConnection};parent.postMessage(m,'*');top.postMessage(m,'*')</scr` + `ipt>`;
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inJs = (s) => attr(s).replace(/'/g, "\\'");

async function openLesson(page, course) {
  await page.evaluate(() => { window.__top = []; addEventListener('message', (e) => { if (e.data && e.data.nested) window.__top.push(`${e.data.nested}:${e.data.rtc}`); }); });
  await page.goto(`./#/c/${course}`);
  await page.goto(`./#/c/${course}/read/0001`);
  await expect(page.locator('[data-lesson-state="ready"], [data-lesson-state="fallback"], [data-lesson-state="error"]')).toBeVisible({ timeout: 20000 });
}
const served = (page, course) => page.evaluate(async (c) => (await (await fetch(`./c/${c}/lessons/0001-g.html`)).text()), course);

test.describe('T048-S1c: the renderer removes frames with a real HTML parser', () => {
  test('svg <title>, <math>, abrupt comments, noscript, template, declarative shadow roots, uppercase/odd syntax: no frame reaches the lesson; inline styles and handlers give no console errors in the app', async ({ page }) => {
    const r = (n) => attr(REPORT(n));
    const body = `<p style="color:#123" onclick="void 0">стил и обработчик</p>`
      + `<svg><title><iframe srcdoc="${r('svg title')}"></iframe></title><desc><iframe srcdoc="${r('svg desc')}"></iframe></desc></svg>`
      + `<math><mtext><iframe srcdoc="${r('math mtext')}"></iframe></mtext><annotation-xml encoding="text/html"><iframe srcdoc="${r('annotation-xml')}"></iframe></annotation-xml></math>`
      + `<!--><iframe srcdoc="${r('abrupt <!-->')}"></iframe><!---><iframe srcdoc="${r('abrupt <!--->')}"></iframe><!-- -->`
      + `<noscript><p title="</noscript><iframe srcdoc='${r('noscript')}'></iframe>"></p></noscript>`
      + `<template><iframe srcdoc="${r('template')}"></iframe></template>`
      + `<div><template shadowrootmode="closed"><iframe srcdoc="${r('dsd static')}"></iframe></template></div>`
      + `<IfRaMe SrcDoc="${r('mixed case')}"></IfRaMe><object data="data:text/html,x"></object><embed src="data:text/html,x">`
      + `<form><math><mtext></form><form><mglyph><style></math><iframe srcdoc="${r('mxss mglyph')}"></iframe></style></mglyph></form></mtext></math></form>`
      + `<p id="after">след</p>`;
    const summary = await importCourse(page, 'LRN-R1', { 'INDEX.md': strToU8('# R1\n'), 'lessons/0001-g.html': doc(body, '<style>h1{color:#345}</style>') });
    expect(summary).toContain('импортиран');
    const html = await served(page, 'LRN-R1');
    for (const tag of ['iframe', 'object', 'embed', 'frame', 'noscript']) expect(html.toLowerCase(), tag).not.toContain(`<${tag}`);
    await openLesson(page, 'LRN-R1');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__top)).toEqual([]);
    const f = page.frames().find((x) => x.url().includes('/EasyLRN/c/LRN-R1/'));
    expect(await f.evaluate(() => [document.querySelector('#after')?.textContent, getComputedStyle(document.querySelector('p')).color])).toEqual(['след', 'rgb(17, 34, 51)']);
    // The parser frame is gone after the render.
    expect(await page.locator('iframe[data-easylrn="parser"]').count()).toBe(0);
  });

  test('stripFrames() is stable: a second pass over its own output changes nothing', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { stripFrames } = await import('./src/lesson-render.js');
      const make = () => document.implementation.createHTMLDocument('');
      const src = '<!doctype html><html><head><title>x</title></head><body><svg><title><iframe></iframe></title></svg><table><tr><td>a<iframe></iframe></td></tr></table><select><option>1</select><p title="a<b>c">t</p></body></html>';
      const a = stripFrames(src, make);
      const b = stripFrames(a.html, make);
      return { a: a.html, removed: a.removed, same: a.html === b.html, removed2: b.removed };
    });
    expect(r.removed).toBe(2);
    expect(r.same).toBe(true);
    expect(r.removed2).toBe(0);
    expect(r.a.startsWith('<!DOCTYPE html>')).toBe(true);
  });
});

test.describe('T048-S1a/b: more guard paths', () => {
  const cases = {
    'closed shadow root': `<script>const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});s.innerHTML='<iframe srcdoc="${inJs(REPORT('closed shadow'))}"></iframe>';</script>`,
    'open shadow root, then innerHTML later': `<script>const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'open'});setTimeout(()=>{s.innerHTML='<div><iframe srcdoc="${inJs(REPORT('open shadow later'))}"></iframe></div>'},300);</script>`,
    'document.write with a closed declarative shadow root': `<script>document.write('<div><template shadowrootmode="closed"><iframe srcdoc="${inJs(REPORT('dsd write'))}"></iframe></template></div>');</script>`,
    'Function.prototype.call/apply, Node.prototype.removeChild, remove(), NodeList#length overridden': `<script>Function.prototype.call=function(){};Function.prototype.apply=function(){};Element.prototype.remove=function(){};Node.prototype.removeChild=function(){};Object.defineProperty(NodeList.prototype,'length',{get(){return 0}});Object.defineProperty(MutationRecord.prototype,'addedNodes',{get(){return []}});const d=document.createElement('div');d.innerHTML='<iframe srcdoc="${inJs(REPORT('overrides'))}"></iframe>';document.body.append(d);</script>`,
    'a fresh frame read synchronously through frames[0]': `<script>try{const d=document.createElement('div');d.innerHTML='<iframe></iframe>';document.body.append(d);const W=frames[0];top.postMessage({nested:'sync frames[0]',rtc:W&&typeof W.RTCPeerConnection},'*');}catch(e){}</script>`,
    'contenteditable + execCommand insertHTML': `<div id="ed" contenteditable>x</div><script>document.getElementById('ed').focus();document.execCommand('insertHTML',false,'<iframe srcdoc="${inJs(REPORT('execCommand'))}"></iframe>');</script>`,
    'setHTMLUnsafe / parseHTMLUnsafe are gone': `<script>top.postMessage({ nested: typeof Element.prototype.setHTMLUnsafe === 'undefined' && typeof Document.parseHTMLUnsafe === 'undefined' ? '' : 'html-unsafe present', rtc: 0 }, '*');</script>`,
  };
  for (const [name, body] of Object.entries(cases)) {
    test(`no working nested frame: ${name}`, async ({ page }) => {
      await importCourse(page, 'LRN-G', { 'INDEX.md': strToU8('# G\n'), 'lessons/0001-g.html': doc(body) });
      await openLesson(page, 'LRN-G');
      await page.waitForTimeout(2500);
      const hits = (await page.evaluate(() => window.__top)).filter((h) => !/^:/.test(h));
      console.log(`T-048-fix guard "${name}": ${JSON.stringify(hits)}`);
      expect(hits).toEqual([]);
    });
  }

  test('a lesson that reports a frame it could not remove (lrn:violation) is stopped by the app with a message', async ({ page }) => {
    await importCourse(page, 'LRN-V', {
      'INDEX.md': strToU8('# V\n'),
      'lessons/0001-g.html': doc(`<script>addEventListener('load',()=>setTimeout(()=>parent.postMessage({lrn:1,type:'lrn:violation',v:1},'*'),500));</script>`),
    });
    await openLesson(page, 'LRN-V');
    await expect(page.locator('.lesson-frame__wrap')).toHaveAttribute('data-lesson-stopped', 'frame');
    await expect(page.locator('.lesson-frame__status')).toContainText('Урокът е спрян');
    await expect(page.locator('iframe.lesson-frame')).toHaveCount(0);
    problems = problems.filter((p) => !/nested frame/.test(p));
  });
});

// ---- Quizzes -------------------------------------------------------------------
const json = (o) => strToU8(JSON.stringify(o));
const INDEX = (id) => strToU8(`# ${id}\n\n## Уроци\n\n| # | Урок | Файл |\n|---|---|---|\n| 0001 | Урок | lessons/0001-l.html |\n`);
const LESSON = strToU8('<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><title>Урок</title></head><body><h1>Урок</h1></body></html>');
const course = (id, quizzes) => ({ 'INDEX.md': INDEX(id), 'lessons/0001-l.html': LESSON, ...quizzes });
const quizzesOf = (page, id) => page.evaluate(async (c) => (await (await import('./src/db.js')).listQuizzes(c)), id);
const pick = (page, i) => page.locator(`.quiz__option[data-option="${i}"]`).click();

test.describe('T-048-fix quizzes', () => {
  test('[T048-D2] a question with a non-text option is dropped whole, with a note in the import summary', async ({ page }) => {
    const line = await importCourse(page, 'LRN-D2', course('LRN-D2', {
      'quizzes/a.json': json({ lesson: '0001', questions: [{ q: 'Кое е вярно?', options: ['грешно', 42, 'вярно'], answer: 2 }, { q: 'Друго?', options: ['а', 'б'], answer: 1 }] }),
    }));
    const [quiz] = await quizzesOf(page, 'LRN-D2');
    expect(quiz.questions.map((q) => q.q)).toEqual(['Друго?']);
    expect(line).toContain('Внимание — тестовете не са внесени изцяло (1)');
    expect(line).toContain('въпрос 1: опция, която не е текст');
  });

  test('[T048-D3] equal questions have separate answers', async ({ page }) => {
    const q = { q: 'Вярно ли е?', options: ['Да', 'Не'], answer: 0 };
    await importCourse(page, 'LRN-D3', course('LRN-D3', { 'quizzes/a.json': json({ lesson: '0001', questions: [q, q] }) }));
    await page.goto('./#/c/LRN-D3/quiz/a');
    await pick(page, 0);
    await page.getByRole('button', { name: 'Напред' }).click();
    await expect(page.locator('.quiz__count')).toHaveText('Въпрос 2 от 2 · отговорени 1');
    await expect(page.locator('.quiz__verdict')).toHaveCount(0);
  });

  test('[T048-D1] reshuffled options keep the choice (and the verdict follows the new answer index); changed options reset it; nothing else is touched', async ({ page }) => {
    const v1 = { lesson: '0001', questions: [{ q: 'Едно?', options: ['А', 'Б', 'В'], answer: 1 }, { q: 'Две?', options: ['Да', 'Не'], answer: 0 }, { q: 'Три?', options: ['x', 'y'], answer: 0 }] };
    await importCourse(page, 'LRN-D1', course('LRN-D1', { 'quizzes/a.json': json(v1) }));
    await page.goto('./#/c/LRN-D1/quiz/a');
    await pick(page, 0); // "А", wrong
    await page.getByRole('button', { name: 'Напред' }).click();
    await pick(page, 0); // "Да", right
    await page.getByRole('button', { name: 'Напред' }).click();
    await pick(page, 1); // "y", wrong
    // v2: Q1 reshuffled (same options, same right text "Б"); Q2 another option set; Q3 untouched.
    const v2 = { lesson: '0001', questions: [{ q: 'Едно?', options: ['В', 'А', 'Б'], answer: 2 }, { q: 'Две?', options: ['Да', 'Не', 'Не знам'], answer: 0 }, { q: 'Три?', options: ['x', 'y'], answer: 0 }] };
    await importCourse(page, 'LRN-D1', course('LRN-D1', { 'quizzes/a.json': json(v2) }));
    await page.goto('./#/c/LRN-D1');
    await expect(page.locator('[data-field="quiz-status"]')).toHaveText('2 от 3 отговорени');
    await page.goto('./#/c/LRN-D1/quiz/a');
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
    await expect(page.locator('.quiz__question')).toHaveText('Едно?');
    await expect(page.locator('.quiz__option--wrong')).toHaveText('✗ А'); // the same text, now option 1
    await expect(page.locator('.quiz__option--correct')).toHaveText('✓ Б');
    await page.getByRole('button', { name: 'Напред' }).click();
    await expect(page.locator('.quiz__verdict')).toHaveCount(0); // changed options: reset
    await page.getByRole('button', { name: 'Напред' }).click();
    await expect(page.locator('.quiz__option--wrong')).toHaveText('✗ y'); // untouched
  });

  test('v2 → v3 conversion of stored answers (index → option text; the first of equal questions keeps a shared answer)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const quiz = { questions: [{ q: 'А?', options: ['1', '2'], answer: 1 }, { q: 'Б?', options: ['x', 'y', 'z'], answer: 0 }, { q: 'А?', options: ['1', '2'], answer: 0 }, { q: 'В?', options: ['a', 'b'], answer: 0 }] };
      const old = { [db.legacyQuestionKey('А?')]: 1, [db.legacyQuestionKey('Б?')]: 2, [db.legacyQuestionKey('В?')]: 7 };
      const out = db.migrateChoicesV2(quiz, old);
      const keys = db.questionKeys(quiz.questions);
      return { values: keys.map((k) => out[k] ?? null), score: db.scoreQuiz(quiz, { choices: out }) };
    });
    expect(r.values).toEqual(['2', 'z', null, null]);
    expect(r.score).toMatchObject({ answered: 2, correct: 1 });
  });

  test('Н-4: "lesson": 1 / "1" → "0001"; Н-2: cut quizzes are reported in the summary', async ({ page }) => {
    const many = Array.from({ length: 22 }, (_, i) => `о${i}`);
    const line = await importCourse(page, 'LRN-N', course('LRN-N', {
      'quizzes/a.json': json({ lesson: 1, questions: [{ q: 'Много опции?', options: many, answer: 0 }] }),
      'quizzes/b.json': json({ lesson: '1', questions: [{ q: `${'д'.repeat(4100)}?`, options: ['а', 'б'], answer: 0 }] }),
    }));
    const qs = await quizzesOf(page, 'LRN-N');
    expect(qs.map((q) => q.lesson)).toEqual(['0001', '0001']);
    expect(qs[0].questions[0].options).toHaveLength(20);
    expect(line).toContain('над 20 опции');
    expect(line).toContain('съкратени');
    await page.goto('./#/c/LRN-N/read/0001');
    await expect(page.locator('[data-field="lesson-quizzes"] a')).toHaveCount(2);
  });

  test('Н-5: the reset confirmation puts the focus on "Отказ"; Enter there keeps the answers', async ({ page }) => {
    await importCourse(page, 'LRN-F', course('LRN-F', { 'quizzes/a.json': json({ lesson: '0001', questions: [{ q: 'Едно?', options: ['А', 'Б'], answer: 0 }] }) }));
    await page.goto('./#/c/LRN-F/quiz/a');
    await pick(page, 0);
    await page.getByRole('button', { name: 'Виж резултата' }).click();
    await page.getByRole('button', { name: 'Нулирай отговорите' }).click();
    await expect(page.getByRole('button', { name: 'Отказ', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.quiz__score')).toHaveText('Резултат: 1 от 1 верни');
  });
});
