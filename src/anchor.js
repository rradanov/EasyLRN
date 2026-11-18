// Text anchors: text model, selectors and re-anchoring (D-012). Placeholder:
// the full module comes with T-013.
//
// Rules for this file (T-045, LESSON-ISOLATION §3.2, PLAN_ADDENDUM-3 T-013):
// - a pure module: no `import`, only standard DOM APIs on a given root;
// - it never contains a closing script tag in its text;
// - the Service Worker inlines it, followed by src/lesson-bridge.js, as ONE
//   inline <script type="module"> at the end of every lesson, and the app may
//   import it directly as well. Top-level names must not clash with the bridge.
export const ANCHOR_VERSION = 0;
