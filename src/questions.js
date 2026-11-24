// Questions to the teacher: the threads of a lesson (T-023, D-047, D-013,
// D-012, D-039, D-017).
//
// - A thread is a `Thread` record (store `threads`, in BACKUP_STORES since v1;
//   no migration) with its messages (store `messages`, by_thread):
//   - on selected text: on an annotation of the lesson (D-012 selectors on the
//     DocRef of the lesson, D-039 ids) — a new one without a colour, or the
//     mark at exactly that place. It follows the annotation through a changed
//     lesson (ok / "провери" / "неприкачена"); the eraser never deletes it
//     (an annotation with a thread only loses its colour);
//   - about the lesson as a whole: `annotationId: null`, `target` = the DocRef
//     of the lesson (D-013).
//   Every thread keeps `courseId`, `lessonId`, `target`, the quote it was
//   asked about (`quote`, also shown when the place is not found any more),
//   the paragraph and the path of headings that went into the first question.
// - A message of the user keeps the question as typed (`content`) and the exact
//   text that was sent (`sent`): the history of a thread goes to the API byte
//   for byte as before, so the automatic cache of the thread is hit (D-017).
//   An answer (`role: 'assistant'`) keeps its Markdown, status ('streaming' →
//   'done' | 'error'), `interrupted` (a part came), the cost and the model.
// - Deleting a thread is soft ("Върни"); an annotation without a colour and
//   without anything else on it goes with it.
// - NOTHING of a thread ever goes to the lesson: the bridge gets only the
//   annotation (a quote of the lesson itself), never a question or an answer.
import { STORES, list, create, get, update, remove, restore, getAnnotation, updateAnnotation, createMessage, COLORS } from './db.js';
import { lessonRef, lessonAnnotations, annotateSelection, annotationDependents } from './annotations.js';
import { questionText } from './teacher.js';

export const MAX_QUESTION_LENGTH = 4000;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const flat = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/** The annotation `id` of this lesson (never one of another document). */
async function ownAnnotation(lesson, id, opts) {
  const a = typeof id === 'string' ? await getAnnotation(id, opts) : null;
  const ref = lessonRef(lesson);
  if (!a || a.target?.type !== ref.type || a.target?.id !== ref.id) throw new Error('not an annotation of this lesson');
  return a;
}
/** The thread `id` of this lesson. */
async function ownThread(lesson, id, opts) {
  const t = typeof id === 'string' ? await get(STORES.threads, id, opts) : null;
  if (!t || t.lessonId !== lesson.id) throw new Error('not a thread of this lesson');
  return t;
}

/**
 * The threads of a lesson: [{ thread, annotation|null, messages }], oldest
 * first. One read of each store (as the notes, T018-I4).
 */
export async function lessonThreads(lesson) {
  const [annotations, threads, messages] = await Promise.all([lessonAnnotations(lesson), list(STORES.threads), list(STORES.messages)]);
  const own = threads.filter((t) => t.lessonId === lesson.id).sort(byId);
  if (!own.length) return [];
  const anns = new Map(annotations.map((a) => [a.id, a]));
  const ids = new Set(own.map((t) => t.id));
  const byThread = new Map();
  for (const m of messages) {
    if (!ids.has(m.threadId)) continue;
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
    byThread.get(m.threadId).push(m);
  }
  return own.map((thread) => ({
    thread,
    // A thread whose annotation went (another tab) is still listed: "неприкачен".
    annotation: thread.annotationId ? (anns.get(thread.annotationId) || null) : null,
    messages: (byThread.get(thread.id) || []).sort(byId),
  }));
}

/** The messages of a thread, oldest first. */
export async function threadMessages(lesson, threadId) {
  await ownThread(lesson, threadId);
  return (await list(STORES.messages)).filter((m) => m.threadId === threadId).sort(byId);
}

/**
 * Where a quote is in the lesson text (the app's own text of the ORIGINAL file,
 * src/teacher.js lessonText — never what the lesson says): its paragraph and
 * the path of headings above it. `found: false` when the text of the lesson
 * does not have it (made by a script of the lesson, or a forged selection).
 * @param {{ text: string }} lessonTextResult
 * @param {{ exact: string, prefix?: string, suffix?: string }} quote
 */
export function quoteContext(lessonTextResult, quote) {
  const text = String(lessonTextResult?.text || '');
  const exact = flat(quote?.exact);
  if (!exact) return { found: false, paragraph: '', path: [] };
  // The paragraphs (blocks between empty lines) in a flat form; a quote may span lines of one block.
  const blocks = text.split(/\n{2,}/);
  const flatBlocks = blocks.map(flat);
  const whole = flatBlocks.join(' ');
  let at = -1;
  // With its context first (the same words may be in several places).
  const ctx = flat(`${quote.prefix || ''}${exact}${quote.suffix || ''}`);
  if (ctx !== exact) {
    const i = whole.indexOf(ctx);
    if (i >= 0) at = i + flat(quote.prefix || '').length + (quote.prefix && /\s$/.test(quote.prefix) ? 1 : 0);
  }
  if (at < 0) at = whole.indexOf(exact);
  if (at < 0) return { found: false, paragraph: '', path: [] };
  // The block of `at`.
  let pos = 0;
  let index = 0;
  for (; index < flatBlocks.length; index++) {
    const end = pos + flatBlocks[index].length;
    if (at <= end) break;
    pos = end + 1;
  }
  index = Math.min(index, blocks.length - 1);
  const paragraph = flatBlocks[index].replace(/^#{1,6} /, '');
  // The headings above it: the nearest of each higher level.
  const path = [];
  let level = 7;
  for (let i = index; i >= 0; i--) {
    for (const line of blocks[i].split('\n').reverse()) {
      const m = /^(#{1,6}) (.*)$/.exec(line);
      if (m && m[1].length < level && !(i === index && flat(m[2]) === paragraph)) {
        path.unshift(flat(m[2]));
        level = m[1].length;
      }
    }
  }
  return { found: true, paragraph, path };
}

/**
 * A new thread (at the first "Изпрати"). `place` is { selection } for selected
 * text (a new annotation without a colour, unless `annotationId` of a mark is
 * given), { annotationId } for a mark, or {} for the lesson as a whole.
 * Returns { thread, annotation, createdAnnotation }.
 */
export async function startThread({ course, lesson, place = {}, quote = '', paragraph = '', path = [], quoteFound = true }) {
  let annotation = null;
  let createdAnnotation = false;
  if (place.annotationId) {
    annotation = await ownAnnotation(lesson, place.annotationId);
  } else if (place.selection) {
    annotation = await annotateSelection({ course, lesson, selection: place.selection, color: null });
    createdAnnotation = true;
  }
  const thread = await create(STORES.threads, {
    courseId: course.id,
    lessonId: lesson.id,
    target: lessonRef(lesson),
    annotationId: annotation ? annotation.id : null,
    title: null,
    quote: annotation ? annotation.selector.quote.exact : String(quote || ''),
    paragraph: String(paragraph || ''),
    path: Array.isArray(path) ? path.map(String) : [],
    quoteFound: Boolean(quoteFound),
  });
  return { thread, annotation, createdAnnotation };
}

/** The text of the user's message as it is sent (the first one with its quote; teacher.js). */
export function sentText(thread, lesson, question, followUp) {
  return questionText({
    quote: thread.quote || '', paragraph: thread.paragraph || '', path: thread.path || [], question, lesson, followUp,
  });
}

/** A new id of one run of an answer (T024-D1: two tabs on one thread). */
const newRun = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** A question and its answer to come: { user, assistant } (the answer "streaming"). */
export async function addExchange(lesson, threadId, { question, sent }) {
  const thread = await ownThread(lesson, threadId);
  const text = String(question ?? '').slice(0, MAX_QUESTION_LENGTH);
  const user = await createMessage({ threadId: thread.id, role: 'user', content: text, sent: String(sent ?? text), status: 'done' });
  const assistant = await createMessage({ threadId: thread.id, role: 'assistant', content: '', status: 'streaming', replyTo: user.id, startedAt: Date.now(), run: newRun() });
  if (!thread.title) await update(STORES.threads, thread.id, { title: text.replace(/\s+/g, ' ').trim().slice(0, 200) });
  return { user, assistant };
}

/** The answer again ("Опитай пак"): the same message, streaming from the start, a new run. */
export function restartAnswer(assistantId) {
  return update(STORES.messages, assistantId, { content: '', status: 'streaming', interrupted: false, errorKind: null, errorText: null, startedAt: Date.now(), run: newRun() });
}

/**
 * The end of an answer: { content, status: 'done' | 'error', … }. With `run`
 * (the run this page started) it is written only while the message is still
 * that run streaming (T024-D1): another tab's "Опитай пак" started a new run,
 * and its answer is never overwritten by the old request ending here.
 * Resolves the record, or null when it was left as it is.
 */
export async function finishAnswer(assistantId, patch, run) {
  let skipped = false;
  const record = await update(STORES.messages, assistantId, (m) => {
    if (run !== undefined && (m.run !== run || m.status !== 'streaming')) { skipped = true; return null; }
    return patch;
  });
  return skipped ? null : record;
}

/** An answer "streaming" with no request of this page behind it (the page was closed meanwhile). */
export function isStale(message, running = new Set()) {
  return message.role === 'assistant' && message.status === 'streaming' && !running.has(message.id);
}

/**
 * The history of a thread for the API before the user's message `untilId`
 * (exclusive; all of it when null): only pairs with a finished answer, the
 * user's text exactly as it was sent (D-017).
 */
export function threadHistory(messages, untilId = null) {
  const out = [];
  const sorted = [...messages].sort(byId);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (untilId && m.id === untilId) break;
    if (m.role !== 'user') continue;
    const answer = sorted.find((x) => x.role === 'assistant' && x.replyTo === m.id);
    if (!answer || answer.status !== 'done' || !answer.content) continue;
    out.push({ role: 'user', text: m.sent || m.content }, { role: 'assistant', text: answer.content });
  }
  return out;
}

/**
 * Soft delete of a thread; its annotation goes too when it has no colour and
 * nothing else on it. Returns what `restoreThread` needs.
 */
export async function deleteThread(lesson, threadId) {
  const thread = await ownThread(lesson, threadId);
  await remove(STORES.threads, thread.id);
  let annotationDeleted = false;
  if (thread.annotationId) {
    const annotation = await getAnnotation(thread.annotationId);
    if (annotation && !COLORS.includes(annotation.color)) {
      const left = await annotationDependents(annotation.id);
      if (!left.notes && !left.threads && !left.subtopics) {
        await remove(STORES.annotations, annotation.id);
        annotationDeleted = true;
      }
    }
  }
  return { kind: 'thread', threadId: thread.id, annotationId: thread.annotationId, annotationDeleted };
}

/** "Върни": the thread (and its annotation, when it went) is back. */
export async function restoreThread(lesson, { threadId, annotationId, annotationDeleted }) {
  await ownThread(lesson, threadId, { includeDeleted: true });
  let annotationRestored = false;
  if (annotationId) {
    const a = await ownAnnotation(lesson, annotationId, { includeDeleted: true });
    if (annotationDeleted || a.deleted) {
      if (annotationDeleted) await restore(STORES.annotations, annotationId);
      else await updateAnnotation(annotationId, { deleted: false, color: null });
      annotationRestored = true;
    }
  }
  await restore(STORES.threads, threadId);
  return { annotationRestored };
}

/** The thread at exactly the selected place (a second "Въпрос" there opens it), or null. */
export function threadAtSelection(selection, threads) {
  const p = selection?.position;
  if (!p) return null;
  return threads.find((x) => x.annotation && x.annotation.anchorState !== 'orphan'
    && x.annotation.anchoredStart === p.start && x.annotation.anchoredEnd === p.end) || null;
}
