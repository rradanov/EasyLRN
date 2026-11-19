// Light / dark / system theme of the app (T-019). The choice is a setting;
// "system" leaves the colours to prefers-color-scheme (styles/app.css). The
// attribute `data-theme` on <html> forces one of the two.
export const THEMES = Object.freeze(['system', 'light', 'dark']);

/** Apply a theme to the document; an unknown value means "system". */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
