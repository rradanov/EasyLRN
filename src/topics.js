// "Развий ми го": the additional topics of a lesson (T-025, D-048, D-006,
// D-013, D-039, D-012).
//
// - A topic is a `SubTopic` record (store `subtopics`, in BACKUP_STORES since
//   v1; no migration) born from selected text of a document:
//   - the lesson (an annotation on the DocRef of the lesson, D-039 ids);
//   - another topic (an annotation on { type: 'subtopic', id }): a tree;
//   - an answer of the teacher (an annotation on { type: 'message', id }).
//   `parent` is that document (D-013), `annotationId` the place in it,
//   `rootLessonId` / `depth` come from the chain (db.js resolveRoot). The tree
//   is derived from the links, never stored.
// - Every topic keeps the quote it was made from (also shown when its place is
//   not found any more), its paragraph and path, the trail of titles above it
//   (for the prompt and the breadcrumb), its Markdown (`content`), the status
//   of its answer ('streaming' → 'done' | 'error', `run` as an answer of a
//   question: two tabs never overwrite each other, T024-D1) and its cost.
// - Deleting a topic is soft ("Върни"): its topics below go with it and come
//   back with it; an annotation without a colour and without anything else on
//   it goes too.
// - NOTHING of a topic ever goes to the lesson: the bridge gets only the
//   annotation of the lesson (a quote of the lesson itself).
import {
  STORES, list, get, update, remove, restore, getAnnotation, createAnnotation, createSubTopic, COLORS,
} from './db.js';
import { lessonRef, annotateSelection, annotationDependents } from './annotations.js';

export const TOPIC_KIND = 'задълбочаване';
/** The deepest topic (a topic of a topic of …): the prompt gets longer at every level. */
export const MAX_TOPIC_DEPTH = 8;
export const MAX_TOPIC_TITLE = 120;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const newRun = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** The DocRef of a topic. */
export const topicRef = (topic) => ({ type: 'subtopic', id: topic.id });

/** The title of a topic's Markdown: its first "# " heading (or the first line), plain, short. */
export function topicTitle(markdown, fallback = '') {
  const text = String(markdown || '');
  const m = /^\s{0,3}#{1,2}[ \t]+(.+?)[ \t#]*$/m.exec(text);
  const raw = m ? m[1] : (text.split('\n').find((l) => l.trim()) || '');
  const plain = raw.replace(/[*_`[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const t = plain || String(fallback || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TOPIC_TITLE ? `${t.slice(0, MAX_TOPIC_TITLE - 1)}…` : t;
}

/** The topic `id` of this lesson (never one of another lesson). */
export async function ownTopic(lesson, id, opts) {
  const t = typeof id === 'string' ? await get(STORES.subtopics, id, opts) : null;
  if (!t || t.rootLessonId !== lesson.id) throw new Error('not a topic of this lesson');
  return t;
}

/**
 * The live topics of a lesson (the whole tree), oldest first:
 * [{ topic, annotation|null }]. A topic under a deleted topic is not listed.
 */
export async function lessonTopics(lesson) {
  const [topics, annotations] = await Promise.all([
    list(STORES.subtopics, { includeDeleted: true }),
    list(STORES.annotations),
  ]);
  const own = topics.filter((t) => t.rootLessonId === lesson.id);
  const byKey = new Map(own.map((t) => [t.id, t]));
  const anns = new Map(annotations.map((a) => [a.id, a]));
  const alive = (t) => {
    for (let x = t, n = 0; x && n < 64; n++) {
      if (x.deleted) return false;
      if (x.parent?.type !== 'subtopic') return true;
      x = byKey.get(x.parent.id);
      if (!x) return false;
    }
    return false;
  };
  return own.filter(alive).sort(byId).map((topic) => ({ topic, annotation: anns.get(topic.annotationId) || null }));
}

/**
 * The trail of a topic from the lesson down: [{ type: 'lesson'|'subtopic'|'thread', id, title }].
 * `topics` are the live topics of the lesson (lessonTopics); threads are looked up
 * for a topic born in an answer.
 */
export async function topicTrail(lesson, topic, topics = []) {
  const byKey = new Map(topics.map((x) => [x.topic.id, x.topic]));
  const out = [];
  let parent = topic.parent;
  for (let n = 0; parent && n < 64; n++) {
    if (parent.type === 'lesson') break;
    if (parent.type === 'subtopic') {
      const t = byKey.get(parent.id) || await get(STORES.subtopics, parent.id, { includeDeleted: true });
      if (!t) break;
      out.unshift({ type: 'subtopic', id: t.id, title: t.title || topicTitle(t.content, t.quote) });
      parent = t.parent;
      continue;
    }
    if (parent.type === 'message') {
      const m = await get(STORES.messages, parent.id, { includeDeleted: true });
      const th = m && await get(STORES.threads, m.threadId, { includeDeleted: true });
      if (!th) break;
      out.unshift({ type: 'thread', id: th.id, title: `Въпрос: ${th.title || th.quote || ''}`.slice(0, MAX_TOPIC_TITLE) });
      parent = th.target?.type === 'subtopic' ? th.target : null;
      continue;
    }
    break;
  }
  const name = lesson.kind === 'reference' ? 'Справочник' : 'Урок';
  out.unshift({ type: 'lesson', id: lesson.id, title: `${name} ${lesson.number || ''}`.trim() });
  return out;
}

/**
 * The selection of an app document (a topic, an answer) as an annotation:
 * `selector` from src/highlight.js describe() (D-012 selectors on that document).
 */
export function annotateDocument({ course, target, selector, color = null, style = 'highlight', version = null }) {
  if (!selector?.quote?.exact || !selector.position) throw new TypeError('no selection');
  return createAnnotation({
    courseId: course.id,
    target,
    targetVersion: version,
    selector: {
      quote: { ...selector.quote },
      position: { ...selector.position },
      ...(selector.hint ? { hint: { ...selector.hint } } : {}),
    },
    color,
    style,
    anchorState: 'ok',
  });
}

/**
 * A new topic (at "🌱 Развий ми го"). `place` is { selection } for selected
 * text of the lesson, { annotationId } for a mark of the lesson, or
 * { target, selector } for selected text of a topic / an answer.
 * Returns { topic, annotation, createdAnnotation }.
 */
export async function startTopic({ course, lesson, place, quote = '', paragraph = '', path = [], trail = [], doc = null }) {
  let annotation = null;
  let createdAnnotation = false;
  if (place?.annotationId) {
    annotation = await getAnnotation(place.annotationId);
    if (!annotation) throw new Error('annotation gone');
  } else if (place?.selection) {
    annotation = await annotateSelection({ course, lesson, selection: place.selection, color: null });
    createdAnnotation = true;
  } else if (place?.target && place?.selector) {
    if (!['subtopic', 'message'].includes(place.target.type)) throw new TypeError('bad target');
    annotation = await annotateDocument({ course, target: place.target, selector: place.selector, version: place.version ?? null });
    createdAnnotation = true;
  } else {
    throw new TypeError('no place');
  }
  const parent = annotation.target;
  const topic = await createSubTopic({
    annotationId: annotation.id,
    kind: TOPIC_KIND,
    parent,
    courseId: course.id,
    lessonId: lesson.id,
    quote: annotation.selector.quote.exact || String(quote || ''),
    paragraph: String(paragraph || ''),
    path: Array.isArray(path) ? path.map(String) : [],
    trail: Array.isArray(trail) ? trail.map((t) => String(t)) : [],
    // The document the quote was taken from (a topic, an answer), as it is now: the prompt stays the same.
    doc: doc && ['subtopic', 'message'].includes(doc.type) ? { type: doc.type, id: String(doc.id || ''), title: String(doc.title || ''), text: String(doc.text || '') } : null,
    title: '',
    content: '',
    status: 'streaming',
    startedAt: Date.now(),
    run: newRun(),
  });
  if (topic.rootLessonId !== lesson.id) {
    await remove(STORES.subtopics, topic.id);
    throw new Error('not a place of this lesson');
  }
  return { topic, annotation, createdAnnotation };
}

/** The topic again ("Опитай пак"): streaming from the start, a new run. */
export function restartTopic(lesson, id) {
  return ownTopic(lesson, id).then(() => update(STORES.subtopics, id, {
    content: '', status: 'streaming', interrupted: false, errorKind: null, errorText: null, startedAt: Date.now(), run: newRun(),
  }));
}

/**
 * The end of a topic's answer (as finishAnswer of a question): written only
 * while the topic is still that `run` streaming. Resolves the record or null.
 */
export async function finishTopic(id, patch, run) {
  let skipped = false;
  const record = await update(STORES.subtopics, id, (t) => {
    if (run !== undefined && (t.run !== run || t.status !== 'streaming')) { skipped = true; return null; }
    const out = { ...patch };
    if (typeof out.content === 'string' && out.status === 'done') out.title = topicTitle(out.content, t.quote);
    else if (typeof out.content === 'string' && !t.title) out.title = topicTitle(out.content, t.quote);
    return out;
  });
  return skipped ? null : record;
}

/** A topic "streaming" with no request of this page behind it (the page was closed meanwhile). */
export const isStaleTopic = (topic, running = new Set()) => topic.status === 'streaming' && !running.has(topic.id);

/** The topics right under a document (`ref`), in the order of their places (then by id). */
export function childTopics(topics, ref) {
  return topics.filter((x) => x.topic.parent?.type === ref.type && x.topic.parent?.id === ref.id);
}

/**
 * Soft delete of a topic and the topics below it; an annotation without a
 * colour and nothing else on it goes too. Returns what `restoreTopic` needs.
 */
export async function deleteTopic(lesson, id) {
  const topic = await ownTopic(lesson, id);
  const all = (await list(STORES.subtopics)).filter((t) => t.rootLessonId === lesson.id);
  const ids = [topic.id];
  for (let i = 0; i < ids.length && ids.length < 5000; i++) {
    for (const t of all) if (t.parent?.type === 'subtopic' && t.parent.id === ids[i] && !ids.includes(t.id)) ids.push(t.id);
  }
  for (const x of ids) await remove(STORES.subtopics, x);
  let annotationDeleted = false;
  const annotation = await getAnnotation(topic.annotationId);
  if (annotation && !COLORS.includes(annotation.color)) {
    const left = await annotationDependents(annotation.id);
    if (!left.notes && !left.threads && !left.subtopics) {
      await remove(STORES.annotations, annotation.id);
      annotationDeleted = true;
    }
  }
  return { kind: 'topic', topicId: topic.id, ids, annotationId: topic.annotationId, annotationDeleted };
}

/** "Върни": the topic (with the topics below it, and its annotation when it went) is back. */
export async function restoreTopic(lesson, { topicId, ids = [], annotationId, annotationDeleted }) {
  await ownTopic(lesson, topicId, { includeDeleted: true });
  if (annotationDeleted && annotationId) await restore(STORES.annotations, annotationId);
  for (const x of ids.length ? ids : [topicId]) await restore(STORES.subtopics, x);
}

/** The topic at exactly this place of a lesson's selection (a second "Развий ми го" there opens it), or null. */
export function topicAtSelection(selection, topics) {
  const p = selection?.position;
  if (!p) return null;
  return topics.find((x) => x.annotation && x.topic.parent?.type === 'lesson' && x.annotation.anchorState !== 'orphan'
    && x.annotation.anchoredStart === p.start && x.annotation.anchoredEnd === p.end) || null;
}

/** The lesson's DocRef (for a topic made on the lesson). */
export const isLessonTopic = (topic, lesson) => topic.parent?.type === 'lesson' && topic.parent.id === lessonRef(lesson).id;
