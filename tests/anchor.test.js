// T-013: in-browser unit tests for src/anchor.js (a pure module on DOM roots).
// Opened directly (tests/anchor.html) or by Playwright (tests/e2e/anchor-t013.spec.js).
// Fixtures: the synthetic lesson LRN-DEMO 0001 (tests/fixtures, D-026) and
// three changed versions of it (PLAN T-013): an inserted paragraph, an edited
// sentence, a deleted section.
import {
  anchorTextModel, anchorDescribe, anchorDescribeRange, anchorFind, anchorRange, anchorOffset, anchorNormalize, ANCHOR_CONTEXT,
  anchorScan,
} from '../src/anchor.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
class AssertionError extends Error {}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new AssertionError(msg); }
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg} expected ${e}, got ${a}`);
}

// --- fixtures -----------------------------------------------------------------
let ORIGINAL = '';
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const modelOf = (html) => { const doc = parse(html); return anchorTextModel(doc.body); };
const variants = () => ({
  inserted: ORIGINAL.replace('<h2 id="vidove">', '<p>Вмъкнат абзац: преди да започнем, свари вода и приготви чаша. Това е нов текст, който го нямаше.</p>\n<h2 id="vidove">'),
  edited: ORIGINAL.replace('Твърде горещата вода прави зеления чай горчив.', 'Твърде горещата вода прави зеления чай много горчив.'),
  deleted: ORIGINAL.replace(/<h2 id="voda">[\s\S]*?(?=<h2 id="test">)/, ''),
});
/** A seeded PRNG (mulberry32): the same 50 selections every run. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** `n` random selections of 3…120 characters in the model (word bounds, like a finger would). */
function randomSelections(model, n, seed = 13) {
  const r = rng(seed);
  const T = model.text;
  const out = [];
  while (out.length < n) {
    let s = Math.floor(r() * (T.length - 10));
    let e = Math.min(T.length, s + 3 + Math.floor(r() * 118));
    while (s > 0 && T[s - 1] !== ' ') s--;
    while (e < T.length && T[e] !== ' ') e++;
    const sel = anchorDescribe(model, s, e);
    if (sel) out.push(sel);
  }
  return out;
}
/** Range that covers `needle` in the document (text node + offset search over the model). */
function rangeOf(model, needle) {
  const at = model.text.indexOf(needle);
  assert(at >= 0, `not in the model: ${needle}`);
  return anchorRange(model, at, at + needle.length);
}

// --- text model ---------------------------------------------------------------
test('модел: празни места → един интервал; интервал между блокове; без script/style/.quiz/textarea', () => {
  const m = modelOf('<body><h1>Заглавие</h1><p>Първи   ред\n\tс   табове.</p><p>Втори</p><script>var x = "скрито";</script><style>p{}</style><section class="quiz"><p>въпрос</p></section><textarea>поле</textarea><button>бутон</button></body>');
  eq(m.text, 'Заглавие Първи ред с табове. Втори');
});
test('модел: data-lrn-noanno и допълнителни изключения', () => {
  const doc = parse('<body><p>Едно</p><div data-lrn-noanno><p>скрито</p></div><p class="x">две</p><p>три</p></body>');
  eq(anchorTextModel(doc.body).text, 'Едно две три');
  eq(anchorTextModel(doc.body, { exclude: '[data-lrn-noanno], .x' }).text, 'Едно три');
});
test('модел: offset ↔ DOM точка в двете посоки (с колапсирани интервали)', () => {
  const doc = parse('<body><p>Аз  съм   <em>тук</em>  и там.</p></body>');
  const m = anchorTextModel(doc.body);
  eq(m.text, 'Аз съм тук и там.');
  const r = anchorRange(m, 7, 10);
  eq(r.toString(), 'тук');
  eq(anchorOffset(m, r.startContainer, r.startOffset), 7);
  eq(anchorOffset(m, r.endContainer, r.endOffset), 10);
  // A point in a collapsed run maps to the next character kept ("Аз␣[␣]съм" → "с").
  const t = doc.querySelector('p').firstChild;
  eq(anchorOffset(m, t, 3), 3);
  // An element boundary.
  eq(anchorOffset(m, doc.querySelector('em'), 0), 7);
});

// --- creation -----------------------------------------------------------------
test('създаване: exact + 32 знака контекст + позиция + hint.blockPath', () => {
  const m = modelOf(ORIGINAL);
  const r = rangeOf(m, 'Camellia sinensis');
  const s = anchorDescribeRange(m, r);
  eq(s.quote.exact, 'Camellia sinensis');
  eq(s.quote.prefix.length, ANCHOR_CONTEXT);
  eq(s.quote.suffix.length, ANCHOR_CONTEXT);
  assert(s.quote.prefix.endsWith('растение, '), s.quote.prefix);
  eq(m.text.slice(s.position.start, s.position.end), 'Camellia sinensis');
  assert(/p:nth-of-type\(\d+\)$/.test(s.hint.blockPath), s.hint.blockPath);
  eq(parse(ORIGINAL).body.querySelector(s.hint.blockPath).textContent.includes('Camellia'), true, 'hint path');
});
test('създаване: селекция през граници на елементи (<em>, <strong>, li)', () => {
  const doc = parse(ORIGINAL);
  const m = anchorTextModel(doc.body);
  const p = [...doc.querySelectorAll('p')].find((x) => x.textContent.includes('Camellia'));
  const range = doc.createRange();
  range.setStart(p.firstChild, p.firstChild.data.indexOf('растение'));
  const after = p.querySelector('em').nextSibling;
  range.setEnd(after, after.data.indexOf('Разликата') + 'Разликата'.length);
  const s = anchorDescribeRange(m, range);
  eq(s.quote.exact, 'растение, Camellia sinensis. Разликата');
  const lis = doc.querySelectorAll('.leaf-list li');
  const r2 = doc.createRange();
  r2.setStart(lis[0].querySelector('strong').firstChild, 0);
  r2.setEnd(lis[1].lastChild, 5);
  const s2 = anchorDescribeRange(m, r2);
  assert(s2.quote.exact.startsWith('Бял чай — почти') && s2.quote.exact.endsWith(' Зелен чай — ок'), s2.quote.exact);
  // …and back: the found range has the same text.
  const found = anchorFind(m, s);
  eq(anchorNormalize(anchorRange(m, found.start, found.end).toString()), s.quote.exact);
});
test('създаване: интервали в краищата се махат; празна селекция → null', () => {
  const m = modelOf('<body><p>едно две три</p></body>');
  eq(anchorDescribe(m, 4, 9).quote.exact, 'две');
  eq(anchorDescribe(m, 4, 9).position, { start: 5, end: 8 });
  eq(anchorDescribe(m, 4, 5), null);
});

// --- re-anchoring: the PLAN T-013 criteria -------------------------------------
test('критерий: вмъкнат абзац → ≥ 95 % от 50 случайни селекции са ok (на същото място)', () => {
  const before = modelOf(ORIGINAL);
  const after = modelOf(variants().inserted);
  const sels = randomSelections(before, 50);
  let ok = 0;
  const bad = [];
  for (const s of sels) {
    const r = anchorFind(after, s, { sameVersion: false });
    if (r.state === 'ok' && after.text.slice(r.start, r.end) === s.quote.exact) ok++;
    else bad.push(`${r.state}: ${s.quote.exact.slice(0, 30)}`);
  }
  assert(ok >= 48, `ok ${ok}/50: ${bad.join(' | ')}`);
  return `${ok}/50 ok`;
});
test('критерий: редактираното изречение → fuzzy (на новото изречение)', () => {
  const before = modelOf(ORIGINAL);
  const after = modelOf(variants().edited);
  const s = anchorDescribeRange(before, rangeOf(before, 'Твърде горещата вода прави зеления чай горчив.'));
  const r = anchorFind(after, s);
  eq(r.state, 'fuzzy');
  const text = after.text.slice(r.start, r.end);
  assert(text.startsWith('Твърде горещата') && text.includes('много горчив'), text);
  assert(r.similarity >= 0.8, String(r.similarity));
  // The rest of the paragraph is untouched: ok.
  const s2 = anchorDescribeRange(before, rangeOf(before, 'Черният чай понася вряща вода.'));
  eq(anchorFind(after, s2).state, 'ok');
  return `similarity ${r.similarity}`;
});
test('критерий: изтрит раздел → orphan; селекторът остава непроменен', () => {
  const before = modelOf(ORIGINAL);
  const after = modelOf(variants().deleted);
  for (const needle of ['Черният чай понася вряща вода.', 'Водата е половината чай', 'преварената вода дава „плосък“ вкус']) {
    const s = anchorDescribeRange(before, rangeOf(before, needle));
    const copy = JSON.stringify(s);
    eq(anchorFind(after, s).state, 'orphan', needle);
    eq(JSON.stringify(s), copy, 'selector unchanged');
  }
  // Before and after the deleted section: still ok.
  const s = anchorDescribeRange(before, rangeOf(before, 'Пу-ер'));
  eq(anchorFind(after, s).state, 'ok');
});
test('критерий: нито една анотация не се губи (50 случайни × 3 версии: всяка има състояние)', () => {
  const before = modelOf(ORIGINAL);
  const sels = randomSelections(before, 50, 99);
  const counts = {};
  for (const [name, html] of Object.entries(variants())) {
    const after = modelOf(html);
    for (const s of sels) {
      const r = anchorFind(after, s);
      assert(['ok', 'fuzzy', 'orphan'].includes(r.state), `${name}: ${JSON.stringify(r)}`);
      if (r.state !== 'orphan') assert(r.end > r.start && r.end <= after.text.length, `${name}: bad range`);
      counts[`${name}.${r.state}`] = (counts[`${name}.${r.state}`] || 0) + 1;
    }
  }
  return JSON.stringify(counts);
});
test('същата версия: позицията се ползва; ако текстът там е друг → търсене', () => {
  const m = modelOf(ORIGINAL);
  const s = anchorDescribeRange(m, rangeOf(m, 'Улун'));
  eq(anchorFind(m, s, { sameVersion: true }), { state: 'ok', start: s.position.start, end: s.position.end, similarity: 1 });
  const moved = { ...s, position: { start: 0, end: 4 } };
  const r = anchorFind(m, moved, { sameVersion: true });
  eq(r.state, 'ok');
  eq(m.text.slice(r.start, r.end), 'Улун');
});

// --- edge cases (T-014 will add its own) ----------------------------------------
test('повтарящ се текст: контекстът избира правилното място', () => {
  const html = '<body><p>Чаят е вкусен. Първо място.</p><p>Чаят е вкусен. Второ място.</p><p>Чаят е вкусен. Трето място.</p></body>';
  const m = modelOf(html);
  const at = m.text.indexOf('Чаят е вкусен. Второ');
  const s = anchorDescribe(m, at, at + 'Чаят е вкусен'.length);
  const m2 = modelOf(html.replace('<p>Чаят е вкусен. Първо място.</p>', '<p>Нов първи абзац.</p><p>Чаят е вкусен. Първо място.</p>'));
  const r = anchorFind(m2, s);
  eq(r.state, 'ok');
  assert(m2.text.slice(r.end, r.end + 8) === '. Второ ', m2.text.slice(r.start, r.end + 10));
});
test('къса селекция (1 дума), чийто контекст е сменен изцяло и думата е на много места → fuzzy, не тихо ok', () => {
  const m = modelOf('<body><p>Алфа бета гама делта чай епсилон дзета ета тета йота.</p><p>Друго чай място чай още чай.</p></body>');
  const at = m.text.indexOf('чай');
  const s = anchorDescribe(m, at, at + 3);
  const m2 = modelOf('<body><p>Съвсем друг текст чай тук.</p><p>И още чай, и пак чай.</p></body>');
  eq(anchorFind(m2, s).state, 'fuzzy');
});
test('кирилица + латиница, диакритика, emoji, NBSP, кавички', () => {
  const html = '<body><p>Регламентът (EU) 2024/2847 — Cyber Resilience Act — „café naïve“ 😀 се прилага.</p></body>';
  const m = modelOf(html);
  eq(m.text, 'Регламентът (EU) 2024/2847 — Cyber Resilience Act — „café naïve“ 😀 се прилага.');
  const s = anchorDescribeRange(m, rangeOf(m, 'Cyber Resilience Act — „café naïve“ 😀'));
  const m2 = modelOf(html.replace('<p>', '<p>Ново начало. '));
  const r = anchorFind(m2, s);
  eq(r.state, 'ok');
  eq(m2.text.slice(r.start, r.end), 'Cyber Resilience Act — „café naïve“ 😀');
  // A typo fixed inside a long quote (one letter) → fuzzy.
  const s2 = anchorDescribeRange(m, rangeOf(m, 'Регламентът (EU) 2024/2847 — Cyber Resilience Act'));
  const m3 = modelOf(html.replace('Resilience', 'Resiliance'));
  eq(anchorFind(m3, s2).state, 'fuzzy');
});
test('таблица: селекция в клетка и през клетки', () => {
  const m = modelOf(ORIGINAL);
  const s = anchorDescribeRange(m, rangeOf(m, '85–90 °C 3 мин'));
  assert(s.hint.blockPath.includes('td'), s.hint.blockPath);
  const after = modelOf(variants().inserted);
  eq(anchorFind(after, s).state, 'ok');
});
test('дълъг урок: 1 MB текст, модел < 1.5 s, 200 закотвяния (ok) < 1.5 s, 5 приблизителни < 3 s', () => {
  const paragraphs = [];
  for (let i = 0; i < 4000; i++) paragraphs.push(`<p>Абзац ${i}: ${'Изречение за киберсигурност на продуктите с цифрови елементи. '.repeat(4)}Край ${i}.</p>`);
  const html = `<body><main>${paragraphs.join('')}</main></body>`;
  const t0 = performance.now();
  const m = modelOf(html);
  const t1 = performance.now();
  assert(m.text.length > 1e6, String(m.text.length));
  assert(t1 - t0 < 1500, `model ${Math.round(t1 - t0)} ms`);
  const sels = [];
  for (let i = 0; i < 200; i++) {
    const at = m.text.indexOf(`Абзац ${i * 20}:`);
    sels.push(anchorDescribe(m, at, at + 60));
  }
  const m2 = modelOf(html.replace('<main>', '<main><p>Ново въведение.</p>'));
  const t2 = performance.now();
  for (const s of sels) eq(anchorFind(m2, s).state, 'ok');
  const t3 = performance.now();
  assert(t3 - t2 < 1500, `anchor ${Math.round(t3 - t2)} ms`);
  const m3 = modelOf(html.replace(/Абзац (\d+):/g, 'Абзaц $1 —')); // a Latin "a" and a dash: every quote changed a little
  const t4 = performance.now();
  for (const s of sels.slice(0, 5)) eq(anchorFind(m3, s).state, 'fuzzy');
  const t5 = performance.now();
  assert(t5 - t4 < 3000, `fuzzy ${Math.round(t5 - t4)} ms`);
  return `${(m.text.length / 1e6).toFixed(2)} M chars; model ${Math.round(t1 - t0)} ms; 200 ok ${Math.round(t3 - t2)} ms; 5 fuzzy ${Math.round(t5 - t4)} ms`;
});
test('враждебен селектор: огромен/празен/без позиция/лош hint → без изключение', () => {
  const m = modelOf(ORIGINAL);
  eq(anchorFind(m, { quote: { exact: '' } }).state, 'orphan');
  eq(anchorFind(m, { quote: { exact: '   ' } }).state, 'orphan');
  eq(anchorFind(m, null).state, 'orphan');
  const big = anchorFind(m, { quote: { exact: 'я'.repeat(100000) }, position: { start: -5, end: 1e12 }, hint: { blockPath: ')(*&' } });
  eq(big.state, 'orphan');
  const r = anchorFind(m, { quote: { exact: 'Улун', prefix: 5, suffix: {} }, hint: { blockPath: 'p:has(' } });
  eq(r.state, 'ok');
});

// --- T-013-fix (0.12.1) -----------------------------------------------------------
test('T-013-fix D1: къс цитат, останал на ЕДНО място без нищо от контекста си → fuzzy (не тихо ok)', () => {
  const v1 = '<body><p>Първо: CRA важи тук.</p><p>Второ: и CRA важи там за всички продукти.</p><p>Трето: регламентът.</p></body>';
  const m = modelOf(v1);
  const at = m.text.indexOf('CRA', m.text.indexOf('Второ'));
  const s = anchorDescribe(m, at, at + 3);
  eq(anchorFind(modelOf('<body><p>Първо: CRA важи тук.</p><p>Трето: регламентът.</p></body>'), s).state, 'fuzzy');
  // …with its context still there → ok at the right place.
  const kept = modelOf(v1.replace('<p>Трето', '<p>Ново.</p><p>Трето'));
  const r = anchorFind(kept, s);
  eq([r.state, r.start], ['ok', kept.text.indexOf('CRA', kept.text.indexOf('Второ'))]);
});
test('T-013-fix D2: <br> е интервал в модела; цитатът през реда не е слепен; DOM точките след <br> са верни', () => {
  const m = modelOf('<body><p>първи ред<br>втори ред</p><p>a<br><br>b</p></body>');
  eq(m.text, 'първи ред втори ред a b');
  const at = m.text.indexOf('ред втори');
  eq(anchorRange(m, at, at + 9).toString(), 'редвтори'); // the DOM has no space: the Range is right
  eq(anchorRange(m, m.text.indexOf('втори'), m.text.indexOf('втори') + 5).toString(), 'втори');
});
test('T-013-fix D3: побитовото търсене (Myers/Hyyrö) дава същото като пълното динамично програмиране (2000 случайни случая)', () => {
  const ref = (text, from, to, pattern, near, global) => {
    const m = pattern.length;
    let prev = new Array(m + 1).fill(0).map((_, i) => i); let cur = new Array(m + 1);
    let best = m; let bestEnd = from;
    for (let j = from; j < to; j++) {
      cur[0] = global ? j - from + 1 : 0;
      for (let i = 1; i <= m; i++) cur[i] = Math.min(prev[i - 1] + (pattern[i - 1] === text[j] ? 0 : 1), prev[i] + 1, cur[i - 1] + 1);
      if (cur[m] < best || (cur[m] === best && Math.abs(j + 1 - near) < Math.abs(bestEnd - near))) { best = cur[m]; bestEnd = j + 1; }
      [prev, cur] = [cur, prev];
    }
    return global ? { end: to, dist: prev[m] } : { end: bestEnd, dist: best };
  };
  const pat = (p) => {
    const m = p.length; const blocks = (m + 31) >> 5; const peq = new Map();
    for (let i = 0; i < m; i++) { const c = p.charCodeAt(i); let v = peq.get(c); if (!v) { v = new Int32Array(blocks); peq.set(c, v); } v[i >> 5] |= 1 << (i & 31); }
    return { m, blocks, peq, none: new Int32Array(blocks), pv: new Int32Array(blocks), mv: new Int32Array(blocks) };
  };
  const r = rng(99);
  const abc = 'абвг д';
  for (let t = 0; t < 2000; t++) {
    const m = 1 + Math.floor(r() * (t % 3 ? 40 : 120));
    let p = ''; for (let i = 0; i < m; i++) p += abc[Math.floor(r() * abc.length)];
    const n = Math.floor(r() * 180);
    let x = ''; for (let i = 0; i < n; i++) x += abc[Math.floor(r() * abc.length)];
    const from = Math.floor(r() * n / 3); const to = Math.max(from, n - Math.floor(r() * n / 3)); const near = Math.floor(r() * n);
    for (const g of [false, true]) eq(anchorScan(x, from, to, pat(p), g, near), ref(x, from, to, p, near, g), `case ${t} ${g}`);
  }
});
test('T-013-fix праг: ≥ 0.7, когато 16-те знака от двете страни са непокътнати; иначе 0.8; без фалшиво ok', () => {
  const pre = 'Тук започва раздел за обхвата и ';
  const post = ', а останалото е по-нататък в текста.';
  const q = 'CRA се прилага само ако отговорът';
  const m = modelOf(`<body><p>${pre}${q}${post}</p><p>Друг абзац без връзка.</p></body>`);
  const at = m.text.indexOf(q);
  const s = anchorDescribe(m, at, at + q.length);
  // LRN-CRA (T-013 §6): 11 characters inserted in a 33-character quote, the context intact → 0.75 → fuzzy (was orphan).
  const ins = modelOf(`<body><p>${pre}CRA се прилага (редакция) само ако отговорът${post}</p><p>Друг абзац без връзка.</p></body>`);
  const r1 = anchorFind(ins, s);
  eq([r1.state, r1.similarity, ins.text.slice(r1.start, r1.end)], ['fuzzy', 0.75, 'CRA се прилага (редакция) само ако отговорът']);
  // As in LRN-CRA-changed: a paragraph inserted before (the far part of the prefix is gone), the 16 characters around intact → fuzzy.
  const far = modelOf(`<body><p>Тук започва раздел за обхвата.</p><p>Вмъкнат абзац, който го нямаше, и ${pre.slice(-16)}CRA се прилага (редакция) само ако отговорът${post}</p></body>`);
  eq(anchorFind(far, s).state, 'fuzzy');
  // The same edit, but the context right around it changed too → orphan (0.75 < 0.8).
  const both = modelOf(`<body><p>Нов увод тук. CRA се прилага (редакция) само ако отговорът е друг.</p></body>`);
  eq(anchorFind(both, s).state, 'orphan');
  // Only one side intact → orphan.
  const one = modelOf(`<body><p>${pre}CRA се прилага (редакция) само ако отговорът и съвсем друг край на изречението.</p></body>`);
  eq(anchorFind(one, s).state, 'orphan');
  // 35 % of the quote changed, the context intact → orphan (< 0.7).
  const many = modelOf(`<body><p>${pre}CRA ## прилага ##### ### #ко отговорът${post}</p></body>`);
  eq(anchorFind(many, s).state, 'orphan');
  // A short quote (< 12) never gets the lower threshold.
  const sh = 'гласувай';
  const ms = modelOf(`<body><p>${pre}${sh}${post}</p></body>`);
  const ss = anchorDescribe(ms, ms.text.indexOf(sh), ms.text.indexOf(sh) + sh.length);
  eq(anchorFind(modelOf(`<body><p>${pre}гласуваш${post}</p></body>`), ss).state, 'fuzzy'); // 0.875 with context: the 0.8 rule
  eq(anchorFind(modelOf(`<body><p>${pre}гла##вай${post}</p></body>`), ss).state, 'orphan'); // 0.75: no lower threshold under 12 characters
});
test('T-013-fix D3: 20 пасажа × 2000 знака и 200 цели абзаца след малка редакция — бързо (без забавяне на процесора)', () => {
  const para = (i, w = '') => `<p>Абзац ${i}. Производителят${w} оценява рисковете за киберсигурността на продукта, номер ${i}, и документира резултата.</p>`;
  const v1 = Array.from({ length: 3000 }, (_, i) => para(i)).join('');
  const m1 = modelOf(`<body>${v1}</body>`);
  const long = Array.from({ length: 20 }, (_, k) => { const at = m1.text.indexOf(`Абзац ${k * 140}.`); return anchorDescribe(m1, at, at + 1990); });
  const whole = Array.from({ length: 200 }, (_, k) => { const at = m1.text.indexOf(`Абзац ${k * 15}.`); return anchorDescribe(m1, at, m1.text.indexOf('резултата.', at) + 10); });
  const m2 = modelOf(`<body>${Array.from({ length: 3000 }, (_, i) => para(i, i % 15 === 0 ? ' внимателно' : '')).join('')}</body>`);
  const t0 = performance.now();
  for (const s of long) eq(anchorFind(m2, s).state, 'fuzzy');
  const t1 = performance.now();
  for (const s of whole) eq(anchorFind(m2, s).state, 'fuzzy');
  const t2 = performance.now();
  assert(t1 - t0 < 400, `20 × 2000: ${Math.round(t1 - t0)} ms`);
  assert(t2 - t1 < 500, `200 paragraphs: ${Math.round(t2 - t1)} ms`);
  return `20 × 2000 знака ${Math.round(t1 - t0)} ms; 200 абзаца ${Math.round(t2 - t1)} ms`;
});
test('T-013-fix D4: `within` търси само в дадената част (неприкачена след промяна другаде)', () => {
  const m = modelOf('<body><p>Едно изречение тук за проба.</p><p>Друго място с изречение тук за проба и още.</p></body>');
  const s = { quote: { exact: 'изречение тук за проба', prefix: '', suffix: '' } };
  const second = m.text.lastIndexOf('изречение тук');
  const r = anchorFind(m, s, { within: [second - 3, m.text.length] });
  eq([r.state, r.start], ['ok', second]);
  eq(anchorFind(m, s, { within: [0, 5] }).state, 'orphan');
});

test('T-015: търсенето през индекса на 4-грамите (текст > 64 000 знака) намира същите места като indexOf', () => {
  const r = rng(15);
  const words = 'регламент продукт CRA риск уязвимост доклад срок оценка пазар вносител SBOM CE е и на за с'.split(' ');
  const parts = [];
  for (let i = 0; i < 3000; i++) { const w = []; for (let k = 0; k < 8; k++) w.push(words[Math.floor(r() * words.length)]); parts.push(`<p>${w.join(' ')}.</p>`); }
  const m = modelOf(`<body>${parts.join('')}</body>`);
  assert(m.text.length > 65536, String(m.text.length));
  let checked = 0;
  for (let t = 0; t < 300; t++) {
    const len = 4 + Math.floor(r() * 60);
    const at = Math.floor(r() * (m.text.length - len));
    const s = anchorDescribe(m, at, at + len);
    if (!s) continue;
    // Moved: the old position far away, so only the search can find it (no "same version").
    const f = anchorFind(m, { quote: s.quote, position: { start: 0, end: 1 } });
    eq([f.state === 'orphan', m.text.slice(f.start, f.end)], [false, s.quote.exact], `case ${t}`);
    // Its own place when the context is all there (unique with 32 + 32 characters of context).
    if (anchorFind(m, s).start !== s.position.start) throw new AssertionError(`case ${t}: ${anchorFind(m, s).start} ≠ ${s.position.start}`);
    checked++;
  }
  return `${checked} цитата в ${m.text.length} знака`;
});

// --- runner -------------------------------------------------------------------
async function run() {
  ORIGINAL = await (await fetch('./fixtures/LRN-DEMO/lessons/0001-vidove-chay.html')).text();
  const rows = document.getElementById('results');
  const summary = document.getElementById('summary');
  const results = [];
  for (const t of tests) {
    const t0 = performance.now();
    let error = null;
    let info = null;
    try { info = await t.fn(); } catch (err) { error = err; }
    const ms = performance.now() - t0;
    results.push({ name: t.name, ok: !error, error: error ? String(error.stack || error) : null, info, ms });
    const tr = document.createElement('tr');
    [t.name, error ? `✗ ${error.message}` : `✓${info ? ` (${info})` : ''}`, ms.toFixed(0)].forEach((text, c) => {
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
  summary.textContent = failed ? `НЕУСПЕШНИ: ${failed} от ${results.length}` : `Всички ${results.length} теста минават.`;
  summary.className = failed ? 'fail' : 'pass';
  window.anchorTestResults = results;
  summary.dataset.done = 'true';
}
if (new URLSearchParams(location.search).get('run') !== 'none') run();
