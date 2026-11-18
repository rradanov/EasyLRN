// Tiny DOM helpers. Elements are built with createElement/textContent only
// (no innerHTML), so untrusted text can never become markup.

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, any>} [props] attributes; `class`, `text`, `on<event>` are special
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replace all children of `parent` with `nodes`. */
export function mount(parent, ...nodes) {
  parent.replaceChildren(...nodes.flat().filter(Boolean));
}
