// The screen orientation chosen in "Настройки" (T-069): "auto" (the default,
// the device decides), "portrait" or "landscape".
//
// - Applied with the Screen Orientation API: screen.orientation.lock(...) /
//   unlock(), at start and at every change of the setting (main.js).
// - Chrome allows a lock only in an installed app (the home-screen EasyLRN,
//   display-mode standalone / fullscreen) or in fullscreen: in a browser tab
//   `lock` is refused (NotSupportedError / SecurityError). The choice is kept
//   anyway (the settings are the same for the tab and the installed app) and
//   applied whenever the app runs installed.
// - No API at all (an old engine, iOS Safari): the choice is shown inactive
//   with an explanation (settings.js, `orientationSupport`).
export const ORIENTATIONS = Object.freeze(['auto', 'portrait', 'landscape']);

const orientationApi = () => {
  const o = typeof screen !== 'undefined' ? screen.orientation : null;
  return o && typeof o.lock === 'function' ? o : null;
};

/** The app runs installed (home screen) or fullscreen: a lock is allowed there. */
export function runsInstalled() {
  const mm = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
  return mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)')
    || Boolean(typeof document !== 'undefined' && document.fullscreenElement);
}

/**
 * What the device can do now: 'none' (no API: the choice is inactive),
 * 'installed-only' (a browser tab: kept, works in the installed app), 'ok'.
 */
export function orientationSupport() {
  if (!orientationApi()) return 'none';
  return runsInstalled() ? 'ok' : 'installed-only';
}

export const checkOrientation = (value) => (ORIENTATIONS.includes(value) ? value : 'auto');

let applied = null; // the last value applied (a settings event for another field changes nothing)
let wanted = 'auto'; // the value chosen last
let lastResult = { ok: true, reason: null };

/** The result of the last attempt: { ok, reason: null | 'unsupported' | 'refused' }. */
export const lastOrientationResult = () => lastResult;

/**
 * Lock / unlock the screen. Never throws; resolves to { ok, reason }.
 * @param {string} value 'auto' | 'portrait' | 'landscape' (anything else → 'auto')
 * @param {{ force?: boolean }} [opts] apply again even when it is the value applied last
 */
export async function applyOrientation(value, { force = false } = {}) {
  const next = checkOrientation(value);
  wanted = next;
  if (!force && next === applied) return lastResult;
  applied = next;
  const api = orientationApi();
  if (!api) {
    lastResult = { ok: next === 'auto', reason: next === 'auto' ? null : 'unsupported' };
    return lastResult;
  }
  try {
    if (next === 'auto') {
      if (typeof api.unlock === 'function') api.unlock();
    } else {
      await api.lock(next);
    }
    lastResult = { ok: true, reason: null };
  } catch (err) {
    // A browser tab (not installed / not fullscreen): the lock is refused. Not an error of the app.
    console.info('Screen orientation not locked:', err?.name || err);
    lastResult = { ok: false, reason: 'refused' };
    applied = null; // try again next time (e.g. after the app is opened installed)
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('easylrn:orientation', { detail: { value: next, ...lastResult } }));
  return lastResult;
}

// Fullscreen entered (a lock is allowed there): the chosen value again.
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement && wanted !== 'auto') applyOrientation(wanted, { force: true }); });
}
