// Hash router: `#/path/:param?query`. Browser history (and the Android
// "Back" button) works natively because every route change is a hash change.

/** @typedef {{ params: Record<string,string>, query: URLSearchParams, path: string }} RouteMatch */

const routes = [];

/**
 * Register a route.
 * @param {string} pattern e.g. '/c/:courseId/read/:lessonId'
 * @param {(match: RouteMatch) => any} handler
 */
export function addRoute(pattern, handler) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ re: new RegExp(`^${source}/?$`), keys, handler });
}

/** Split a location hash into path and query. */
export function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : raw.slice(qIndex + 1));
  return { path: path.startsWith('/') ? path : `/${path}`, query };
}

/** Find the handler for a hash; returns null when nothing matches. */
export function resolve(hash) {
  const { path, query } = parseHash(hash);
  for (const route of routes) {
    const m = route.re.exec(path);
    if (!m) continue;
    const params = {};
    route.keys.forEach((key, i) => {
      try {
        params[key] = decodeURIComponent(m[i + 1]);
      } catch {
        params[key] = m[i + 1];
      }
    });
    return { handler: route.handler, match: { params, query, path } };
  }
  return null;
}

/** Build a hash link from segments; each segment is URI-encoded. */
export function link(...segments) {
  return `#/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

/**
 * Start listening to hash changes.
 * @param {(resolved: ReturnType<typeof resolve>, hash: string) => void} onRoute
 */
export function startRouter(onRoute) {
  const run = () => onRoute(resolve(location.hash), location.hash);
  window.addEventListener('hashchange', run);
  run();
}
