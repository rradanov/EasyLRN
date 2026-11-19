// Markdown of the course files (RESOURCES.md on the course screen; MISSION.md
// and NOTES.md are not shown there since D-038) → DOM, for the app's own
// documents (ARCHITECTURE §5: marked → DOMPurify → DOM).
//
// Safety: the course is the user's own (D-037), but its text is still treated
// as untrusted:
// - raw HTML in the Markdown is not markup: it is shown as text (escaped);
// - images are not loaded (the app CSP would block them anyway): their alt
//   text is shown instead;
// - DOMPurify keeps only a small allow-list of text elements and attributes
//   (no style — the app CSP has no 'unsafe-inline' — no id, no class);
// - links: https:// opens outside the app (new tab, no opener, no referrer);
//   a link to a lesson or reference of the course opens the reader; anything
//   else (relative files such as sources/*.pdf, mailto:, javascript:…) loses
//   its href and stays as text.
// Robustness (T012-D1/D2): a document never breaks the screen it is shown on.
// Quote nesting is capped before marked (it recurses once per level), and any
// error while rendering gives a short note plus the file as plain text.
import { Marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const ALLOWED_TAGS = ['p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'input'];
const ALLOWED_ATTR = ['href', 'title', 'start', 'type', 'checked', 'disabled'];

function makeParser(headingOffset) {
  return new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      // Raw HTML (block or inline) is text, never markup.
      html({ text }) { return escapeHtml(text); },
      image({ text }) { return text ? `<span>${escapeHtml(text)}</span>` : ''; },
      heading({ tokens, depth }) {
        const level = Math.min(6, Math.max(2, depth + headingOffset));
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
    },
  });
}

/** Deepest blockquote nesting passed to marked (T012-D2: thousands of ">" overflow its stack). */
export const MAX_QUOTE_DEPTH = 50;
/**
 * Widest leading indentation passed to marked, in characters: list nesting by
 * indentation costs marked far more than linear time (1000 levels ≈ 6 s, 3000
 * would freeze the screen); 120 is 60 levels of 2 spaces, 30 of 4.
 */
export const MAX_INDENT = 120;

/**
 * Deepest nesting of a line that MIXES quotes and list markers (T011F-D7):
 * interleaved "> - > - …" escaped the quote cap and the indentation cap, and
 * 1000 such lines (up to 30 pairs, 120 spaces) took ~8 s on the tablet. The
 * depth of such a line is its markers plus its indentation (2 spaces = one
 * level); beyond this the deeper markers and the extra indentation are
 * dropped. Real course files have a few levels. Lines with only ">" keep
 * MAX_QUOTE_DEPTH, lines with only indentation/list markers MAX_INDENT.
 */
export const MAX_MIXED_DEPTH = 4;

// One block marker with the space before it: ">" (space optional after it) or
// a list marker followed by a space or tab.
const MARKER = /^[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]?/;
const indentWidth = (ws) => [...ws].reduce((w, c) => w + (c === '\t' ? 4 : 1), 0);

/** Cap the depth of a line that mixes ">" and list markers; the text stays. */
function capMixed(line) {
  const lead = /^[ \t]*/.exec(line)[0];
  let rest = line.slice(lead.length);
  const markers = [];
  let quotes = 0;
  for (;;) {
    const m = MARKER.exec(rest);
    if (!m) break;
    markers.push(m[0]);
    if (m[0].trim() === '>') quotes++;
    rest = rest.slice(m[0].length);
  }
  if (!quotes || quotes === markers.length) return line; // not mixed
  const levels = Math.floor(indentWidth(lead) / 2) + markers.length;
  if (levels <= MAX_MIXED_DEPTH) return line;
  const kept = markers.slice(0, MAX_MIXED_DEPTH);
  const room = Math.max(0, MAX_MIXED_DEPTH - kept.length);
  const indent = ' '.repeat(Math.min(indentWidth(lead), room * 2));
  return `${indent}${kept.join('').replace(/^[ \t]+/, '')}${rest.replace(/^[ \t]+/, '')}`;
}

/**
 * Cap the nesting of every line before marked: at most MAX_QUOTE_DEPTH ">"
 * markers (the deeper ones are dropped), at most MAX_MIXED_DEPTH levels on a
 * line that mixes ">" and list markers, and at most MAX_INDENT characters of leading
 * spaces/tabs (deeper lines stay at that depth). Text is never dropped.
 */
export function limitNesting(md) {
  const quotes = new RegExp(`^([ \\t]*)(?:>[ \\t]*){${MAX_QUOTE_DEPTH + 1},}`, 'gm');
  const indent = new RegExp(`^[ \\t]{${MAX_INDENT + 1},}`, 'gm');
  // Only lines that start with a marker and hold a ">" are looked at (cheap test first).
  const mixed = /^[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])[^\n]*$/gm;
  return md
    .replace(quotes, (_, lead) => `${lead}${'> '.repeat(MAX_QUOTE_DEPTH)}`)
    .replace(mixed, (line) => (line.includes('>') ? capMixed(line) : line))
    .replace(indent, ' '.repeat(MAX_INDENT));
}

/**
 * Decode a %-encoded path; null when it is malformed (T012-D1: "100%.pdf",
 * "%zz" make decodeURIComponent throw a URIError).
 * @param {string} s
 * @returns {string|null}
 */
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Drop the first level-1 heading (the title of MISSION.md, shown elsewhere).
 * @param {string} md
 */
export function withoutTitle(md) {
  // T011F-D4: the heading is one line ("# " + an empty line does not eat the next one).
  return String(md ?? '').replace(/^﻿?\s*#(?:[ \t][^\n]*)?(\n|$)/, '');
}

/**
 * Render Markdown into a sanitized DocumentFragment.
 * @param {string} md
 * @param {{ headingOffset?: number, resolveLink?: (href: string) => string|null }} [options]
 *   headingOffset: added to every heading level (min h2), so the document fits under the
 *   section heading; resolveLink: maps a relative href to an app hash link (or null).
 */
export function renderMarkdown(md, options = {}) {
  try {
    return renderUnsafe(md, options);
  } catch (err) {
    // T012-D1/D2: one bad document is a note in its own block, never a broken screen.
    console.warn('EasyLRN: Markdown not rendered, shown as plain text:', err);
    const fragment = document.createDocumentFragment();
    const note = document.createElement('p');
    note.className = 'muted md__fallback-note';
    note.textContent = 'Този текст не може да се покаже форматиран; показан е като обикновен текст.';
    const plain = document.createElement('div');
    plain.className = 'md__plain';
    plain.textContent = String(md ?? '');
    fragment.append(note, plain);
    return fragment;
  }
}

function renderUnsafe(md, { headingOffset = 2, resolveLink = () => null } = {}) {
  const html = makeParser(headingOffset).parse(limitNesting(String(md ?? '')), { async: false });
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const input of fragment.querySelectorAll('input')) {
    // GFM task lists only: a disabled checkbox.
    if (input.getAttribute('type') !== 'checkbox') input.remove();
    else input.setAttribute('disabled', '');
  }
  for (const a of fragment.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    a.removeAttribute('title');
    if (/^https:\/\//i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('referrerpolicy', 'no-referrer');
      a.classList.add('md__external');
      continue;
    }
    let local = null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) {
      // A link resolver that throws (e.g. on a malformed %-escape) only kills this link.
      try { local = resolveLink(href); } catch { local = null; }
    }
    if (local) {
      a.setAttribute('href', local);
      continue;
    }
    const span = document.createElement('span');
    span.className = 'md__dead-link';
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
  return fragment;
}
