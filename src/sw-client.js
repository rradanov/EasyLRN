// Service Worker registration and the "new version available" flow.
// A new SW installs in the background and waits; the user decides when to
// switch by pressing "Презареди" (then the waiting SW activates and the page reloads).

/**
 * @param {(applyUpdate: () => void) => void} onUpdateReady called when a new version is waiting
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerServiceWorker(onUpdateReady) {
  if (!('serviceWorker' in navigator)) return null;

  let updateRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload only when the user asked for the update. The very first
    // install also fires controllerchange (clients.claim) — no reload then.
    if (updateRequested) location.reload();
  });

  let registration;
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('Service Worker registration failed:', err);
    return null;
  }

  const offer = (worker) => {
    onUpdateReady(() => {
      updateRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
    });
  });

  // The tablet app may stay open for days: look for updates when it returns to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      registration.update().catch(() => {});
    }
  });

  return registration;
}
