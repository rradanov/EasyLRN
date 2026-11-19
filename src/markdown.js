// Markdown of the course files (MISSION.md, RESOURCES.md, NOTES.md) → DOM,
// for the app's own documents (ARCHITECTURE §5: marked → DOMPurify → DOM).
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

/**
 * Drop the first level-1 heading (the title of MISSION.md, shown elsewhere).
 * @param {string} md
 */
export function withoutTitle(md) {
  return String(md ?? '').replace(/^﻿?\s*#\s+[^\n]*(\n|$)/, '');
}

/**
 * Render Markdown into a sanitized DocumentFragment.
 * @param {string} md
 * @param {{ headingOffset?: number, resolveLink?: (href: string) => string|null }} [options]
 *   headingOffset: added to every heading level (min h2), so the document fits under the
 *   section heading; resolveLink: maps a relative href to an app hash link (or null).
 */
export function renderMarkdown(md, { headingOffset = 2, resolveLink = () => null } = {}) {
  const html = makeParser(headingOffset).parse(String(md ?? ''), { async: false });
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
    const local = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') ? null : resolveLink(href);
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
